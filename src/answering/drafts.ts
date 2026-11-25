import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { clock, type EngineContext } from '../context.js'
import type { Executor } from '../db/client.js'
import { inboundDrafts, outgoingMessages, postResponses, replies, type DraftKind } from '../db/schema.js'
import { riskClears, type RiskAssessment } from './decision.js'
import { conflict } from '../errors.js'
import { lockAnswering, minAutoDelaySeconds, readAnswering } from './settings.js'

// The dashboard's view of engine drafts: the outbox it pulls, and the
// guards an automatic send of a draft must pass. The guards trust the
// engine's own records, never the dashboard's word alone.

type DraftRow = typeof inboundDrafts.$inferSelect

export interface DraftView {
  id: string
  organizationId: string
  kind: DraftKind
  channelId: string
  /** The conversation (DMs) or the stored comment (comments); the other is null. */
  conversationId: string | null
  responseId: string | null
  /** The post (job) of a comment; null for a DM. */
  jobId: string | null
  /** The platform ID of the DM or comment answered (for a comment, the `parentExternalId` of its reply). */
  inboundExternalId: string
  decision: {
    outcome: DraftRow['outcome']
    reason: string
    model: string | null
    probabilities: DraftRow['probabilities']
    confidence: number | null
    /** Null when the risk was not asked, the call failed, or the item was decided before risk existed. */
    risk: RiskAssessment | null
    /** Null for items decided before risk existed. */
    riskThreshold: number | null
    caseId: string | null
    decisionThreshold: number
    noneThreshold: number
    cost: number | null
    errorCode: string | null
    settingsVersion: number
  }
  draft: { text: string, digest: string, model: string | null, language: string | null, flags: string[] } | null
  /** Why drafting failed, when it did; the item still goes to a person. */
  draftErrorCode: string | null
  superseded: boolean
  supersededBy: string | null
  /** Older drafts of the same conversation this one superseded. */
  supersedes: string[]
  createdAt: string
}

function riskOf(row: DraftRow): RiskAssessment | null {
  if (row.riskLevel === null || row.riskScore === null || row.riskProbabilities === null || row.riskConfidence === null) return null
  return { level: row.riskLevel, score: row.riskScore, probabilities: row.riskProbabilities, confidence: row.riskConfidence }
}

export function draftView(row: DraftRow, extra: { jobId: string | null, supersedes: string[] }): DraftView {
  return {
    id: row.id, organizationId: row.organizationId, kind: row.kind, channelId: row.channelId, conversationId: row.conversationId,
    responseId: row.responseId, jobId: extra.jobId, inboundExternalId: row.inboundExternalId,
    decision: { outcome: row.outcome, reason: row.reason, model: row.decisionModel, probabilities: row.probabilities, confidence: row.confidence,
      risk: riskOf(row), riskThreshold: row.riskThreshold, caseId: row.caseId, decisionThreshold: row.decisionThreshold, noneThreshold: row.noneThreshold, cost: row.cost, errorCode: row.errorCode,
      settingsVersion: row.settingsVersion },
    draft: row.draftText && row.draftDigest
      ? { text: row.draftText, digest: row.draftDigest, model: row.draftModel, language: row.draftLanguage, flags: row.draftFlags } : null,
    draftErrorCode: row.draftErrorCode, superseded: row.supersededBy !== null, supersededBy: row.supersededBy, supersedes: extra.supersedes,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Drafts the dashboard has not acknowledged, oldest first, across tenants.
 * A draft superseded after it was acknowledged comes back once more.
 */
export async function listDraftOutbox(context: EngineContext, limit: number) {
  const rows = await context.db.select({ draft: inboundDrafts, jobId: postResponses.jobId }).from(inboundDrafts)
    .leftJoin(postResponses, eq(postResponses.id, inboundDrafts.responseId))
    .where(eq(inboundDrafts.outboxPending, true)).orderBy(asc(inboundDrafts.outboxAt), asc(inboundDrafts.id)).limit(limit)
  const ids = rows.map(row => row.draft.id)
  const older = ids.length ? await context.db.select({ id: inboundDrafts.id, by: inboundDrafts.supersededBy }).from(inboundDrafts)
    .where(inArray(inboundDrafts.supersededBy, ids)) : []
  return { items: rows.map(row => draftView(row.draft, { jobId: row.jobId, supersedes: older.filter(value => value.by === row.draft.id).map(value => value.id) })) }
}

/** The dashboard has stored these drafts; unknown IDs are ignored. */
export async function ackDraftOutbox(context: EngineContext, ids: string[]) {
  const now = clock(context)
  const acked = await context.db.update(inboundDrafts).set({ outboxPending: false, deliveredAt: sql`coalesce(${inboundDrafts.deliveredAt}, ${now})` })
    .where(inArray(inboundDrafts.id, ids)).returning({ id: inboundDrafts.id })
  return { acknowledged: acked.length }
}

/** Guards of an automatic send, in the order they are checked. */
export const automationGuards = ['guard_draft', 'guard_decision', 'guard_settings', 'guard_revision', 'guard_digest', 'guard_superseded', 'guard_delay',
  'guard_used'] as const

/** `approvedVia` and `draftId` of a reply or message submission. `person` (or absent) needs no draft and keeps the old behaviour. */
export const approvalFields = {
  approvedVia: z.enum(['person', 'automation']).optional(),
  draftId: z.uuid().optional(),
}
export const approvalRefinement = (value: { approvedVia?: 'person' | 'automation' | undefined, draftId?: string | undefined }) =>
  (value.approvedVia === 'automation') === (value.draftId !== undefined)
export const approvalRefinementMessage = { message: 'draftId is required with approvedVia "automation", and only with it', path: ['draftId'] }

export type AutomationTarget =
  | { kind: 'message', conversationId: string }
  | { kind: 'comment', jobId: string, parentExternalId: string }

/**
 * Refuses an automatic send (`409 guard_<name>`) unless the engine's own
 * records allow it: the draft is the tenant's, of this kind and target; its
 * decision is `auto` with a stored risk score strictly below the risk
 * threshold stored with it and below the tenant's current one; the tenant's current settings have automatic sending
 * and the kind on; the submission is revision 1 with the draft's digest
 * (unedited); the draft is not superseded; `sendAt` is at least the delay
 * (never under 60 s) after the draft; and no automatic send used it yet.
 * Runs in the submission's transaction, under the settings lock.
 */
export async function checkAutomation(executor: Executor, organizationId: string, input: { draftId: string, revision: number, digest: string, sendAt: Date }
  & AutomationTarget) {
  await lockAnswering(executor, organizationId)
  const [draft] = await executor.select().from(inboundDrafts)
    .where(and(eq(inboundDrafts.id, input.draftId), eq(inboundDrafts.organizationId, organizationId))).for('update').limit(1)
  const refuse = (code: typeof automationGuards[number], message: string) => conflict(code, message)
  if (!draft || draft.kind !== input.kind) throw refuse('guard_draft', 'No such engine draft for this kind of answer')
  if (input.kind === 'message' && draft.conversationId !== input.conversationId) throw refuse('guard_draft', 'The draft answers another conversation')
  if (input.kind === 'comment') {
    const [response] = draft.responseId ? await executor.select({ jobId: postResponses.jobId, externalId: postResponses.externalId }).from(postResponses)
      .where(eq(postResponses.id, draft.responseId)).limit(1) : []
    if (!response || response.jobId !== input.jobId || response.externalId !== input.parentExternalId) throw refuse('guard_draft', 'The draft answers another comment')
  }
  if (draft.outcome !== 'auto') throw refuse('guard_decision', 'The engine did not clear this item for an automatic answer')
  const answering = await readAnswering(executor, organizationId)
  const settings = answering?.settings
  // The stored risk, against the threshold stored with it (or today's, when lower): a decision without both never goes out unseen.
  const threshold = draft.riskThreshold === null ? null : Math.min(draft.riskThreshold, settings?.riskThreshold ?? draft.riskThreshold)
  if (!riskClears(draft.riskScore, threshold)) throw refuse('guard_decision', 'The item\'s stored risk does not allow an automatic answer')
  if (!settings?.enabled || !settings.drafts || !settings.kinds[input.kind === 'message' ? 'messages' : 'comments']) {
    throw refuse('guard_settings', 'Automatic answering is off for this tenant or this kind')
  }
  if (input.revision !== 1) throw refuse('guard_revision', 'Only the unedited first revision of an engine draft is sent automatically')
  if (!draft.draftDigest || draft.draftDigest !== input.digest) throw refuse('guard_digest', 'The text is not the engine\'s draft')
  if (draft.supersededBy) throw refuse('guard_superseded', 'A newer draft superseded this one')
  const delayMs = Math.max(minAutoDelaySeconds, settings.delaySeconds) * 1000
  if (input.sendAt.getTime() < draft.createdAt.getTime() + delayMs) throw refuse('guard_delay', `sendAt must be at least ${delayMs / 1000} s after the draft`)
  const table = input.kind === 'message' ? outgoingMessages : replies
  const [used] = await executor.select({ id: table.id }).from(table).where(eq(table.draftId, input.draftId)).limit(1)
  if (used) throw refuse('guard_used', 'This draft was already submitted for an automatic send')
}
