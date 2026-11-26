import { and, desc, eq, gt, lt, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { clock, recordEvent, type EngineContext } from '../context.js'
import type { Executor } from '../db/client.js'
import {
  conversations, directMessages, draftKinds, inboundDrafts, jobs, learnedAnswers, outgoingMessages, postResponses, replies, type DraftKind,
} from '../db/schema.js'
import { EngineError, notFound } from '../errors.js'
import { normalizeReplyText } from '../platforms/reply-match.js'
import { bestMatch, inboundFingerprint, maxCandidates, normalizeInbound, redactInbound, type LearnedMatch } from './learned-match.js'
import { readAnswering } from './settings.js'

// Learned answers (ADR 0004): what a person approved and the platform
// confirmed is kept per channel and kind, and a later item with the same or
// a similar text is answered from it (`learned_answer`), still behind the
// risk gate and the automatic-send guards. Automatic sends teach nothing.

type LearnedRow = typeof learnedAnswers.$inferSelect

/** At most this much of the inbound text is kept, redacted. */
const maxInboundCharacters = 5_000

/** Words of 3 letters or more in a name or handle, folded as the reply is: the ones a greeting would use. */
function nameWords(values: Array<string | null>) {
  return values.flatMap(value => value ? fold(value).split(' ') : []).filter(word => word.length >= 3)
}
const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Whether the reply names the person (a word of their name or handle, as a whole word). */
export function addressesPerson(reply: string, names: Array<string | null>) {
  const words = new Set(fold(reply).split(' '))
  return nameWords(names).some(word => words.has(word))
}

interface Lesson {
  organizationId: string
  channelId: string
  kind: DraftKind
  inboundText: string
  inboundAt: Date
  names: Array<string | null>
  replyText: string
  draft: { id: string, text: string | null, language: string | null } | null
  approvedByUserId: string
  approvedAt: Date
}

/**
 * Stores what a person approved, once per (channel, kind, fingerprint): a
 * newer approval replaces the reply, an older one arriving later changes
 * nothing. Nothing is stored when the tenant's learning is off, or the
 * inbound text has nothing to match on.
 */
async function learn(executor: Executor, lesson: Lesson, now: Date) {
  const answering = await readAnswering(executor, lesson.organizationId)
  if (!answering?.settings.learning) return null
  const normalizedText = normalizeInbound(lesson.inboundText)
  if (!normalizedText) return null
  const inboundText = Array.from(redactInbound(lesson.inboundText).replace(/\s+/gu, ' ').trim()).slice(0, maxInboundCharacters).join('')
  const edited = !lesson.draft?.text || normalizeReplyText(lesson.draft.text) !== normalizeReplyText(lesson.replyText)
  const values = {
    inboundText, normalizedText, inboundAt: lesson.inboundAt, replyText: lesson.replyText, language: lesson.draft?.language || null,
    sourceDraftId: lesson.draft?.id ?? null, edited, addressesPerson: addressesPerson(lesson.replyText, lesson.names),
    approvedByUserId: lesson.approvedByUserId, approvedAt: lesson.approvedAt, updatedAt: now,
  }
  const [stored] = await executor.insert(learnedAnswers).values({ organizationId: lesson.organizationId, channelId: lesson.channelId, kind: lesson.kind,
    fingerprint: inboundFingerprint(normalizedText), ...values, createdAt: now })
    .onConflictDoUpdate({ target: [learnedAnswers.channelId, learnedAnswers.kind, learnedAnswers.fingerprint], set: values,
      setWhere: sql`excluded.approved_at >= ${learnedAnswers.approvedAt}` })
    .returning({ id: learnedAnswers.id })
  if (!stored) return null
  await recordEvent(executor, { organizationId: lesson.organizationId, kind: 'learned_answer.stored', channelId: lesson.channelId,
    detail: { learnedAnswerId: stored.id, kind: lesson.kind, edited, draftId: lesson.draft?.id ?? null } })
  return stored.id
}

/**
 * A direct message a person approved, now sent: learned as the answer to
 * the person's newest message before the approval, unless that message has
 * attachments or the brand had already answered it (this is then a follow-up).
 */
export async function learnFromMessage(executor: Executor, outgoingId: string, now: Date) {
  const [message] = await executor.select().from(outgoingMessages).where(eq(outgoingMessages.id, outgoingId)).limit(1)
  if (!message || message.state !== 'sent' || message.approvedVia !== 'person') return null
  const [inbound] = await executor.select().from(directMessages)
    .where(and(eq(directMessages.conversationId, message.conversationId), eq(directMessages.direction, 'in'), sql`${directMessages.sentAt} <= ${message.approvedAt}`))
    .orderBy(desc(directMessages.sentAt), desc(directMessages.id)).limit(1)
  if (!inbound || inbound.attachments.length) return null
  const [answered] = await executor.select({ id: directMessages.id }).from(directMessages)
    .where(and(eq(directMessages.conversationId, message.conversationId), eq(directMessages.direction, 'out'), gt(directMessages.sentAt, inbound.sentAt),
      lt(directMessages.sentAt, message.approvedAt))).limit(1)
  const [earlier] = await executor.select({ id: outgoingMessages.id }).from(outgoingMessages)
    .where(and(eq(outgoingMessages.conversationId, message.conversationId), ne(outgoingMessages.id, message.id), eq(outgoingMessages.state, 'sent'),
      gt(outgoingMessages.sendAt, inbound.sentAt), lt(outgoingMessages.sendAt, message.sendAt))).limit(1)
  if (answered || earlier) return null
  const [conversation] = await executor.select().from(conversations).where(eq(conversations.id, message.conversationId)).limit(1)
  const [draft] = await executor.select({ id: inboundDrafts.id, text: inboundDrafts.draftText, language: inboundDrafts.draftLanguage }).from(inboundDrafts)
    .where(and(eq(inboundDrafts.conversationId, message.conversationId), eq(inboundDrafts.inboundExternalId, inbound.externalId), eq(inboundDrafts.kind, 'message')))
    .limit(1)
  return learn(executor, { organizationId: message.organizationId, channelId: message.channelId, kind: 'message', inboundText: inbound.text,
    inboundAt: inbound.sentAt, names: [conversation?.participantName ?? null, conversation?.participantUsername ?? null], replyText: message.text,
    draft: draft ?? null, approvedByUserId: message.approvedByUserId, approvedAt: message.approvedAt }, now)
}

/**
 * A comment reply a person approved, now posted: learned as the answer to
 * the comment, unless the brand had already answered that comment.
 */
export async function learnFromReply(executor: Executor, replyId: string, now: Date) {
  const [reply] = await executor.select().from(replies).where(eq(replies.id, replyId)).limit(1)
  if (!reply || reply.state !== 'sent' || reply.approvedVia !== 'person') return null
  const [row] = await executor.select({ response: postResponses, publishAt: jobs.publishAt }).from(postResponses).innerJoin(jobs, eq(jobs.id, postResponses.jobId))
    .where(and(eq(postResponses.channelId, reply.channelId), eq(postResponses.externalId, reply.parentExternalId))).limit(1)
  if (!row || row.response.fromChannel !== false) return null
  const { response } = row
  const [answered] = await executor.select({ id: postResponses.id }).from(postResponses)
    .where(and(eq(postResponses.channelId, reply.channelId), eq(postResponses.parentExternalId, response.externalId), eq(postResponses.fromChannel, true),
      lt(postResponses.publishedAt, reply.approvedAt))).limit(1)
  const [earlier] = await executor.select({ id: replies.id }).from(replies)
    .where(and(eq(replies.channelId, reply.channelId), eq(replies.parentExternalId, reply.parentExternalId), ne(replies.id, reply.id), eq(replies.state, 'sent'),
      lt(replies.sendAt, reply.sendAt))).limit(1)
  if (answered || earlier) return null
  const [draft] = await executor.select({ id: inboundDrafts.id, text: inboundDrafts.draftText, language: inboundDrafts.draftLanguage }).from(inboundDrafts)
    .where(and(eq(inboundDrafts.responseId, response.id), eq(inboundDrafts.kind, 'comment'))).limit(1)
  return learn(executor, { organizationId: reply.organizationId, channelId: reply.channelId, kind: 'comment', inboundText: response.text,
    inboundAt: row.publishAt, names: [response.authorName, response.authorHandle], replyText: reply.text, draft: draft ?? null,
    approvedByUserId: reply.approvedByUserId, approvedAt: reply.approvedAt }, now)
}

export type LearnedCandidate = Pick<LearnedRow, 'id' | 'fingerprint' | 'inboundText' | 'replyText' | 'language' | 'addressesPerson'> & { normalized: string }

/**
 * The best learned answer of the scope for an item's text: the same
 * fingerprint (one indexed lookup), else the most similar of the scope's
 * newest approvals at or above `threshold` (learned-match.ts).
 */
export async function findLearnedAnswer(executor: Executor, scope: { channelId: string, kind: DraftKind }, text: string, threshold: number)
  : Promise<LearnedMatch<LearnedCandidate> | null> {
  const normalized = normalizeInbound(text)
  if (!normalized) return null
  const columns = { id: learnedAnswers.id, fingerprint: learnedAnswers.fingerprint, normalized: learnedAnswers.normalizedText,
    inboundText: learnedAnswers.inboundText, replyText: learnedAnswers.replyText, language: learnedAnswers.language, addressesPerson: learnedAnswers.addressesPerson }
  const inScope = and(eq(learnedAnswers.channelId, scope.channelId), eq(learnedAnswers.kind, scope.kind))
  const [exact] = await executor.select(columns).from(learnedAnswers).where(and(inScope, eq(learnedAnswers.fingerprint, inboundFingerprint(normalized)))).limit(1)
  if (exact) return { candidate: exact, similarity: 1, exact: true }
  const recent = await executor.select(columns).from(learnedAnswers).where(inScope)
    .orderBy(desc(learnedAnswers.approvedAt), desc(learnedAnswers.id)).limit(maxCandidates)
  return bestMatch(normalized, recent, threshold)
}

/** A decision used the learned answer: counted, without moving `updatedAt`. */
export async function recordLearnedUse(executor: Executor, id: string, at: Date) {
  await executor.update(learnedAnswers).set({ uses: sql`${learnedAnswers.uses} + 1`, lastUsedAt: at }).where(eq(learnedAnswers.id, id))
}

export interface LearnedAnswerView {
  id: string
  organizationId: string
  channelId: string
  kind: DraftKind
  /** What the person asked, redacted (no addresses, links or phone numbers). */
  inboundText: string
  replyText: string
  language: string | null
  edited: boolean
  addressesPerson: boolean
  sourceDraftId: string | null
  approvedByUserId: string
  approvedAt: string
  uses: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
  /** When the inbound text goes (retention): 180 days after the item it came from. */
  expiresAt: string
}

export function learnedAnswerView(row: LearnedRow, retentionMs: number): LearnedAnswerView {
  return {
    id: row.id, organizationId: row.organizationId, channelId: row.channelId, kind: row.kind, inboundText: row.inboundText, replyText: row.replyText,
    language: row.language, edited: row.edited, addressesPerson: row.addressesPerson, sourceDraftId: row.sourceDraftId, approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt.toISOString(), uses: row.uses, lastUsedAt: row.lastUsedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), expiresAt: new Date(row.inboundAt.getTime() + retentionMs).toISOString(),
  }
}

/** The inbound text is kept as long as the DM or comment it came from: 180 days (retention.ts). */
export const learnedAnswersRetentionMs = 180 * 86_400_000

const cursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() })
const encodeCursor = (row: LearnedRow) => Buffer.from(JSON.stringify({ t: row.approvedAt.toISOString(), id: row.id })).toString('base64url')
function decodeCursor(cursor: string) {
  try {
    const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return { approvedAt: new Date(value.t), id: value.id }
  } catch {
    throw new EngineError(400, 'invalid_cursor', 'The cursor is not valid')
  }
}

export const learnedListQuery = z.object({
  channelId: z.uuid().optional(),
  kind: z.enum(draftKinds).optional(),
  after: z.string().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/** A tenant's learned answers, newest approval first, a page at a time (`next` continues it). */
export async function listLearnedAnswers(context: EngineContext, organizationId: string, options: z.output<typeof learnedListQuery>) {
  const after = options.after ? decodeCursor(options.after) : null
  const rows = await context.db.select().from(learnedAnswers)
    .where(and(eq(learnedAnswers.organizationId, organizationId), options.channelId ? eq(learnedAnswers.channelId, options.channelId) : undefined,
      options.kind ? eq(learnedAnswers.kind, options.kind) : undefined,
      after ? sql`(${learnedAnswers.approvedAt}, ${learnedAnswers.id}) < (${after.approvedAt}, ${after.id})` : undefined))
    .orderBy(desc(learnedAnswers.approvedAt), desc(learnedAnswers.id)).limit(options.limit)
  const end = rows.at(-1)
  return { learnedAnswers: rows.map(row => learnedAnswerView(row, learnedAnswersRetentionMs)), next: end && rows.length === options.limit ? encodeCursor(end) : null }
}

export const learnedUpdateSchema = z.strictObject({
  replyText: z.string().max(10_000).transform(value => value.replace(/\r\n/g, '\n').trim()).pipe(z.string().min(1)),
})

/**
 * A person rewrote the reply in the dashboard: it is reused from now on, word
 * for word for the same text (it no longer counts as naming the person it
 * first answered). Drafts made from the old text are not sent automatically.
 */
export async function updateLearnedAnswer(context: EngineContext, organizationId: string, id: string, input: z.output<typeof learnedUpdateSchema>) {
  const now = clock(context)
  return context.db.transaction(async transaction => {
    const [row] = await transaction.update(learnedAnswers).set({ replyText: input.replyText, addressesPerson: false, updatedAt: now })
      .where(and(eq(learnedAnswers.id, id), eq(learnedAnswers.organizationId, organizationId))).returning()
    if (!row) throw notFound('Learned answer')
    await recordEvent(transaction, { organizationId, kind: 'learned_answer.updated', channelId: row.channelId, detail: { learnedAnswerId: id } })
    return { learnedAnswer: learnedAnswerView(row, learnedAnswersRetentionMs) }
  })
}

/** Forgets one learned answer. */
export async function deleteLearnedAnswer(context: EngineContext, organizationId: string, id: string) {
  return context.db.transaction(async transaction => {
    const [row] = await transaction.delete(learnedAnswers).where(and(eq(learnedAnswers.id, id), eq(learnedAnswers.organizationId, organizationId)))
      .returning({ id: learnedAnswers.id, channelId: learnedAnswers.channelId })
    if (!row) throw notFound('Learned answer')
    await recordEvent(transaction, { organizationId, kind: 'learned_answer.deleted', channelId: row.channelId, detail: { learnedAnswerIds: [id] } })
    return { deleted: 1 }
  })
}

export const learnedScopeQuery = z.object({ channelId: z.uuid(), kind: z.enum(draftKinds).optional() })

/** Forgets every learned answer of a channel, or of one kind on it. */
export async function deleteLearnedAnswers(context: EngineContext, organizationId: string, scope: z.output<typeof learnedScopeQuery>) {
  return context.db.transaction(async transaction => {
    const rows = await transaction.delete(learnedAnswers).where(and(eq(learnedAnswers.organizationId, organizationId), eq(learnedAnswers.channelId, scope.channelId),
      scope.kind ? eq(learnedAnswers.kind, scope.kind) : undefined)).returning({ id: learnedAnswers.id })
    if (rows.length) {
      await recordEvent(transaction, { organizationId, kind: 'learned_answer.deleted', channelId: scope.channelId,
        detail: { count: rows.length, ...(scope.kind ? { kind: scope.kind } : {}) } })
    }
    return { deleted: rows.length }
  })
}

/** Whether a learned answer still stands as it was when a draft was made from it: not forgotten, not approved again nor edited since. */
export async function learnedAnswerUnchanged(executor: Executor, id: string, since: Date) {
  const [row] = await executor.select({ updatedAt: learnedAnswers.updatedAt }).from(learnedAnswers).where(eq(learnedAnswers.id, id)).limit(1)
  return Boolean(row && row.updatedAt.getTime() <= since.getTime())
}
