import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { clock, recordEvent, type EngineContext } from '../context.js'
import type { Executor } from '../db/client.js'
import {
  answeringSettings, channels, conversations, directMessages, inboundDrafts, jobs, outgoingMessages, postResponses,
  type AnsweringContextEntry, type AnsweringSettings, type DraftKind, type Platform,
} from '../db/schema.js'
import { queueControlEvent } from '../control-events.js'
import { errorFields, log } from '../log.js'
import { messageDigest, replyDigest } from '../digests.js'
import { decide, type Decision, type DecisionItem } from './decision.js'
import { lockAnswering, storedSettings } from './settings.js'
import { DraftError, draftFits, draftFlags, draftLimits, tooLongFlag, type DraftInput, type DraftOutput, type HistoryMessage, type ThreadItem } from './drafting.js'
import { findLearnedAnswer, recordLearnedUse, type LearnedCandidate } from './learning.js'
import type { LearnedMatch } from './learned-match.js'

// The answering step: decide, then draft, for inbound DMs and comments the
// readers stored. It runs in its own worker pass, after the readers committed,
// and never inside them: the readers hold no drafting code, and this step
// holds no sending code. All it writes is a decision and a draft (ADR 0004).

const hourMs = 60 * 60_000
const dayMs = 24 * hourMs
/** How often the worker looks for new inbound items, and how many it handles per pass. */
export const answeringIntervalMs = 15_000
const itemsPerPass = 10
/** Only comments under posts published this recently are answered. */
export const commentPostAgeMs = 7 * dayMs
/** A DM older than this cannot be answered any more (the answering window). */
const messageWindowMs = dayMs
/** At most this many ancestors of a comment are read. */
const maxThreadDepth = 10

type Tenant = Omit<typeof answeringSettings.$inferSelect, 'settings'> & { settings: AnsweringSettings }

interface MessageCandidate {
  kind: 'message'
  tenant: Tenant
  channel: typeof channels.$inferSelect
  conversation: typeof conversations.$inferSelect
  message: typeof directMessages.$inferSelect
}
interface CommentCandidate {
  kind: 'comment'
  tenant: Tenant
  channel: typeof channels.$inferSelect
  response: typeof postResponses.$inferSelect
  job: typeof jobs.$inferSelect
}
type Candidate = MessageCandidate | CommentCandidate

function platformsWith(context: EngineContext, capability: 'sendMessage' | 'reply') {
  return [...context.adapters].filter(([, adapter]) => adapter[capability]).map(([platform]) => platform) as Platform[]
}

/**
 * New direct messages to answer: per conversation, the person's newest
 * message, first seen after DMs were switched on and sent within the
 * answering window, that has no decision yet and that a person at the brand
 * has not answered since. The engine's own automatic sends do not count as
 * that answer: a follow-up to one gets its own decision. Several new
 * messages in one conversation make one item: the newest (coalescing).
 */
export async function messageCandidates(context: EngineContext, tenant: Tenant, now: Date, limit: number): Promise<MessageCandidate[]> {
  const platforms = platformsWith(context, 'sendMessage')
  const since = tenant.messagesEnabledAt
  if (!platforms.length || !since) return []
  const newest = context.db.selectDistinctOn([directMessages.conversationId], { id: directMessages.id, conversationId: directMessages.conversationId,
    externalId: directMessages.externalId, sentAt: directMessages.sentAt, firstSeenAt: directMessages.firstSeenAt })
    .from(directMessages)
    .where(and(eq(directMessages.organizationId, tenant.organizationId), eq(directMessages.direction, 'in'),
      gte(directMessages.firstSeenAt, since), gt(directMessages.sentAt, new Date(now.getTime() - messageWindowMs))))
    .orderBy(directMessages.conversationId, desc(directMessages.sentAt), desc(directMessages.id)).as('newest')
  const rows = await context.db.select({ id: newest.id }).from(newest)
    .where(and(
      sql`not exists (select 1 from ${inboundDrafts} where ${inboundDrafts.conversationId} = ${newest.conversationId}
        and ${inboundDrafts.inboundExternalId} = ${newest.externalId} and ${inboundDrafts.kind} = 'message')`,
      sql`not exists (select 1 from ${directMessages} answered where answered.conversation_id = ${newest.conversationId}
        and answered.direction = 'out' and answered.sent_at > ${newest.sentAt}
        and not exists (select 1 from ${outgoingMessages} engine where engine.channel_id = answered.channel_id
          and engine.platform_message_id = answered.external_id and engine.draft_id is not null))`))
    .orderBy(asc(newest.firstSeenAt)).limit(limit)
  if (!rows.length) return []
  const found = await context.db.select({ message: directMessages, conversation: conversations, channel: channels }).from(directMessages)
    .innerJoin(conversations, eq(conversations.id, directMessages.conversationId)).innerJoin(channels, eq(channels.id, directMessages.channelId))
    .where(and(inArray(directMessages.id, rows.map(row => row.id)), eq(channels.status, 'active'), inArray(channels.platform, platforms)))
    .orderBy(asc(directMessages.firstSeenAt))
  return found.map(row => ({ kind: 'message', tenant, ...row }))
}

/**
 * New comments to answer: written by someone other than the channel,
 * first seen after comments were switched on, under a post published at most
 * seven days ago, without a decision yet.
 */
export async function commentCandidates(context: EngineContext, tenant: Tenant, now: Date, limit: number): Promise<CommentCandidate[]> {
  const platforms = platformsWith(context, 'reply')
  const since = tenant.commentsEnabledAt
  if (!platforms.length || !since) return []
  const rows = await context.db.select({ response: postResponses, job: jobs, channel: channels }).from(postResponses)
    .innerJoin(jobs, eq(jobs.id, postResponses.jobId)).innerJoin(channels, eq(channels.id, postResponses.channelId))
    .where(and(eq(postResponses.organizationId, tenant.organizationId), eq(postResponses.fromChannel, false),
      gte(postResponses.firstSeenAt, since), gte(jobs.publishAt, new Date(now.getTime() - commentPostAgeMs)),
      eq(jobs.state, 'published'), eq(channels.status, 'active'), inArray(channels.platform, platforms),
      sql`not exists (select 1 from ${inboundDrafts} where ${inboundDrafts.responseId} = ${postResponses.id} and ${inboundDrafts.kind} = 'comment')`))
    .orderBy(asc(postResponses.firstSeenAt), asc(postResponses.id)).limit(limit)
  return rows.map(row => ({ kind: 'comment', tenant, ...row }))
}

/** The conversation's newest messages up to and including the one answered, oldest first. */
export async function conversationHistory(executor: Executor, conversationId: string, upTo?: Date): Promise<HistoryMessage[]> {
  const rows = await executor.select({ direction: directMessages.direction, text: directMessages.text, attachments: directMessages.attachments,
    sentAt: directMessages.sentAt }).from(directMessages)
    .where(and(eq(directMessages.conversationId, conversationId), upTo ? sql`${directMessages.sentAt} <= ${upTo}` : undefined))
    .orderBy(desc(directMessages.sentAt), desc(directMessages.id)).limit(draftLimits.historyMessages)
  return rows.reverse().map(row => ({ direction: row.direction, text: row.text, attachments: row.attachments.map(item => item.type), sentAt: row.sentAt }))
}

/**
 * The comments above one, from the stored responses (oldest first), and the
 * channel's own replies in that chain written before it.
 */
export async function commentThread(executor: Executor, response: typeof postResponses.$inferSelect): Promise<ThreadItem[]> {
  const chain: Array<typeof postResponses.$inferSelect> = []
  let parent = response.parentExternalId
  for (let depth = 0; parent && depth < maxThreadDepth; depth++) {
    const [row] = await executor.select().from(postResponses)
      .where(and(eq(postResponses.channelId, response.channelId), eq(postResponses.externalId, parent))).limit(1)
    if (!row) break
    chain.push(row)
    parent = row.parentExternalId
  }
  const ids = [...chain.map(row => row.externalId)]
  const brand = ids.length ? await executor.select().from(postResponses)
    .where(and(eq(postResponses.channelId, response.channelId), inArray(postResponses.parentExternalId, ids), eq(postResponses.fromChannel, true),
      lt(postResponses.publishedAt, response.publishedAt), ne(postResponses.id, response.id)))
    .orderBy(desc(postResponses.publishedAt)).limit(draftLimits.threadItems) : []
  return [...chain, ...brand].filter((row, index, all) => all.findIndex(other => other.id === row.id) === index)
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime()).slice(-draftLimits.threadItems)
    .map(row => ({ fromChannel: row.fromChannel === true, author: row.authorHandle ?? row.authorName, text: row.text, publishedAt: row.publishedAt }))
}

/** The longest text the channel takes for this kind, or null when the adapter says nothing. */
export function channelMaxLength(context: EngineContext, channel: Pick<typeof channels.$inferSelect, 'platform' | 'kind'>, kind: DraftKind): DraftInput['maxLength'] {
  const adapter = context.adapters.get(channel.platform)
  if (kind === 'message') {
    const rules = adapter?.messageRules?.(channel.kind)
    return rules ? { value: rules.maxLength, unit: rules.unit } : null
  }
  const rules = adapter?.replyRules?.(channel.kind)
  return rules ? { value: rules.maxLength, unit: 'characters' } : null
}

/** The drafting input for an item; the same context serves a revision. */
export async function draftInputFor(context: EngineContext, item: { kind: 'message', channel: typeof channels.$inferSelect, conversationId: string, upTo?: Date }
  | { kind: 'comment', channel: typeof channels.$inferSelect, response: typeof postResponses.$inferSelect, job: typeof jobs.$inferSelect },
settings: Pick<AnsweringSettings, 'voice' | 'replyContext'> | null, entries: AnsweringContextEntry[], requireDraft: boolean): Promise<DraftInput> {
  const base = { kind: item.kind, channel: { name: item.channel.name, platform: item.channel.platform }, voice: settings?.voice ?? '',
    replyContext: settings?.replyContext ?? '', context: entries, maxLength: channelMaxLength(context, item.channel, item.kind), requireDraft }
  if (item.kind === 'message') return { ...base, history: await conversationHistory(context.db, item.conversationId, item.upTo) }
  return { ...base, post: item.job.payload.content, thread: await commentThread(context.db, item.response),
    comment: { author: item.response.authorHandle ?? item.response.authorName, text: item.response.text, publishedAt: item.response.publishedAt } }
}

interface Drafted {
  decision: Decision
  draft: { text: string, model: string, output: DraftOutput } | null
  /** The drafting model's flags, kept even when it wrote no text, plus `too_long` when the channel cannot take the text. */
  flags: string[]
  draftErrorCode: string | null
}

/**
 * What a draft says against an automatic send: no text (`no_draft`), the
 * drafting model's own judgement that no answer is needed or any of its
 * flags (`flagged`), or a text the channel cannot take (`draft_too_long`).
 * Null when the draft may go out unseen.
 */
export function draftObjection(output: Pick<DraftOutput, 'reply' | 'needsReply' | 'flags'>, maxLength: DraftInput['maxLength']) {
  if (!output.reply) return 'no_draft' as const
  if (!output.needsReply || output.flags.some(flag => (draftFlags as readonly string[]).includes(flag))) return 'flagged' as const
  if (!draftFits(maxLength, output.reply)) return 'draft_too_long' as const
  return null
}

/** What the engine reports as the drafting model of a draft that reuses a learned answer word for word. */
export const learnedDraftModel = 'learned_answer'

/**
 * The draft of an item that is the same as a learned one: the reply a person
 * approved, word for word. Null when it may not be reused as it is (it names
 * the person it first answered): the drafting model then adapts it.
 */
export function learnedDraft(match: LearnedMatch<LearnedCandidate>): DraftOutput | null {
  if (!match.exact || match.candidate.addressesPerson) return null
  return { needsReply: true, reply: match.candidate.replyText, language: match.candidate.language ?? '', flags: [],
    summary: 'The same message was answered before: this is the reply a person approved then.' }
}

/**
 * Decides an item, then drafts it unless the decision is `none`. With the
 * tenant's learning on, the item is first matched against its channel's
 * learned answers: the decision takes the best match (`learned_answer`), and
 * the draft reuses its reply for the same text or adapts it for a similar
 * one. Without a drafting model there is no draft, except a reused one. A
 * cleared (`auto`) item goes to a person when the draft objects (`no_draft`,
 * `flagged`, `draft_too_long`).
 */
async function decideAndDraft(context: EngineContext, candidate: Candidate): Promise<Drafted> {
  const { settings, context: entries } = candidate.tenant
  const item: DecisionItem = candidate.kind === 'message'
    ? { kind: 'message', channel: { id: candidate.channel.id, name: candidate.channel.name, platform: candidate.channel.platform },
      author: { name: candidate.conversation.participantName, handle: candidate.conversation.participantUsername }, text: candidate.message.text,
      attachments: candidate.message.attachments.map(value => value.type) }
    : { kind: 'comment', channel: { id: candidate.channel.id, name: candidate.channel.name, platform: candidate.channel.platform },
      author: { name: candidate.response.authorName, handle: candidate.response.authorHandle }, text: candidate.response.text, attachments: [],
      post: candidate.job.payload.content }
  const learned = settings.learning
    ? await findLearnedAnswer(context.db, { channelId: candidate.channel.id, kind: candidate.kind }, item.text, settings.learningSimilarity) : null
  let decision = await decide({ settings, context: entries, item, flagged: item.attachments.length > 0, model: context.decisionModel,
    learned: learned && { id: learned.candidate.id, similarity: learned.similarity } })
  if (decision.outcome === 'none') return { decision, draft: null, flags: [], draftErrorCode: null }
  const match = learned && decision.learnedAnswerId === learned.candidate.id ? learned : null
  const reused = match && learnedDraft(match)
  if (reused) {
    // Still held to what any draft is: it fits the channel, else a person sees it.
    const maxLength = channelMaxLength(context, candidate.channel, candidate.kind)
    const objection = draftObjection(reused, maxLength)
    if (decision.outcome === 'auto' && objection) decision = { ...decision, outcome: 'review', reason: objection }
    const flags = draftFits(maxLength, reused.reply!) ? [] : [tooLongFlag]
    return { decision, draft: { text: reused.reply!, model: learnedDraftModel, output: reused }, flags, draftErrorCode: null }
  }
  if (!context.draftModel) {
    return { decision: decision.outcome === 'auto' ? { ...decision, outcome: 'review', reason: 'no_draft' } : decision, draft: null, flags: [], draftErrorCode: null }
  }
  const input = await draftInputFor(context, candidate.kind === 'message'
    ? { kind: 'message', channel: candidate.channel, conversationId: candidate.conversation.id, upTo: candidate.message.sentAt }
    : { kind: 'comment', channel: candidate.channel, response: candidate.response, job: candidate.job }, settings, entries, decision.outcome === 'auto')
  if (match) input.learned = { inbound: match.candidate.inboundText, reply: match.candidate.replyText }
  try {
    const result = await context.draftModel.draft(input, settings.replyModel)
    const text = result.output.reply
    const objection = draftObjection(result.output, input.maxLength)
    if (decision.outcome === 'auto' && objection) decision = { ...decision, outcome: 'review', reason: objection }
    // A text the channel cannot take says so, for the person who edits it.
    const flags = text && !draftFits(input.maxLength, text) ? [...result.output.flags, tooLongFlag] : result.output.flags
    return { decision, draft: text ? { text, model: result.model, output: result.output } : null, flags, draftErrorCode: null }
  } catch (error) {
    log('warn', 'drafting failed', { kind: candidate.kind, channelId: candidate.channel.id, ...errorFields(error) })
    if (decision.outcome === 'auto') decision = { ...decision, outcome: 'review', reason: 'no_draft' }
    return { decision, draft: null, flags: [], draftErrorCode: error instanceof DraftError ? error.code : 'error' }
  }
}

/**
 * Stores one decision and draft, once (a second worker's insert does
 * nothing). A new DM draft supersedes the conversation's older ones that no
 * automatic send has taken: they come back in the outbox with `superseded`.
 * The control plane is told after the commit.
 */
async function storeDraft(context: EngineContext, candidate: Candidate, drafted: Drafted) {
  return context.db.transaction(async transaction => {
    // Under the settings lock the automatic-send guards take, so a supersede and an automatic submission of the older draft serialize.
    await lockAnswering(transaction, candidate.tenant.organizationId)
    const now = clock(context)
    const { decision, draft } = drafted
    const digest = !draft ? null : candidate.kind === 'message'
      ? messageDigest({ conversationId: candidate.conversation.id, text: draft.text })
      : replyDigest({ jobId: candidate.job.id, parentExternalId: candidate.response.externalId, text: draft.text })
    const target = candidate.kind === 'message'
      ? { conversationId: candidate.conversation.id, inboundExternalId: candidate.message.externalId }
      : { responseId: candidate.response.id, inboundExternalId: candidate.response.externalId }
    const [created] = await transaction.insert(inboundDrafts).values({
      organizationId: candidate.tenant.organizationId, channelId: candidate.channel.id, kind: candidate.kind, ...target,
      outcome: decision.outcome, reason: decision.reason, decisionModel: decision.model, probabilities: decision.probabilities,
      confidence: decision.confidence, caseId: decision.caseId, learnedAnswerId: decision.learnedAnswerId, learnedSimilarity: decision.learnedSimilarity,
      decisionThreshold: decision.decisionThreshold, noneThreshold: decision.noneThreshold,
      riskLevel: decision.risk?.level ?? null, riskScore: decision.risk?.score ?? null, riskProbabilities: decision.risk?.probabilities ?? null,
      riskConfidence: decision.risk?.confidence ?? null, riskThreshold: decision.riskThreshold, cost: decision.cost, errorCode: decision.errorCode, draftText: draft?.text ?? null, draftDigest: digest, draftModel: draft?.model ?? null,
      draftLanguage: draft?.output.language.slice(0, 16) ?? null, draftFlags: drafted.flags, draftErrorCode: drafted.draftErrorCode,
      settingsVersion: candidate.tenant.version, outboxPending: true, outboxAt: now, createdAt: now,
    }).onConflictDoNothing().returning({ id: inboundDrafts.id })
    if (!created) return null
    if (decision.learnedAnswerId) await recordLearnedUse(transaction, decision.learnedAnswerId, now)
    if (candidate.kind === 'message') {
      const taken = sql`exists (select 1 from ${outgoingMessages} where ${outgoingMessages.draftId} = ${inboundDrafts.id})`
      await transaction.update(inboundDrafts).set({ supersededBy: created.id, supersededAt: now, outboxPending: true, outboxAt: now })
        .where(and(eq(inboundDrafts.conversationId, candidate.conversation.id), eq(inboundDrafts.kind, 'message'), ne(inboundDrafts.id, created.id),
          isNull(inboundDrafts.supersededBy), sql`not ${taken}`))
    }
    await recordEvent(transaction, { organizationId: candidate.tenant.organizationId, kind: 'draft.created', channelId: candidate.channel.id,
      detail: { draftId: created.id, kind: candidate.kind, outcome: decision.outcome, reason: decision.reason, model: decision.model,
        probabilities: decision.probabilities, confidence: decision.confidence, risk: decision.risk, riskThreshold: decision.riskThreshold,
        caseId: decision.caseId, learnedAnswerId: decision.learnedAnswerId, learnedSimilarity: decision.learnedSimilarity, cost: decision.cost,
        errorCode: decision.errorCode, drafted: Boolean(draft), draftModel: draft?.model ?? null, draftErrorCode: drafted.draftErrorCode,
        flags: drafted.flags, settingsVersion: candidate.tenant.version } })
    await queueControlEvent(transaction, 'drafts.available', candidate.tenant.organizationId, now)
    return created.id
  })
}

/** Tenants with DMs or comments switched on. */
async function activeTenants(context: EngineContext): Promise<Tenant[]> {
  const rows = await context.db.select().from(answeringSettings)
    .where(or(isNotNull(answeringSettings.messagesEnabledAt), isNotNull(answeringSettings.commentsEnabledAt)))
  return rows.filter(row => row.settings.drafts).map(row => ({ ...row, settings: storedSettings(row.settings) }))
}

/** One pass: decide and draft up to `limit` new inbound items, oldest first, across tenants. */
export async function runAnswering(context: EngineContext, limit = itemsPerPass) {
  const now = clock(context)
  let drafted = 0
  let failed = 0
  for (const tenant of await activeTenants(context)) {
    if (drafted + failed >= limit) break
    const left = limit - drafted - failed
    const candidates: Candidate[] = [
      ...tenant.settings.kinds.messages ? await messageCandidates(context, tenant, now, left) : [],
      ...tenant.settings.kinds.comments ? await commentCandidates(context, tenant, now, left) : [],
    ].slice(0, left)
    for (const candidate of candidates) {
      try {
        const result = await decideAndDraft(context, candidate)
        if (await storeDraft(context, candidate, result)) drafted++
      } catch (error) {
        failed++
        log('error', 'answering item failed', { kind: candidate.kind, channelId: candidate.channel.id, ...errorFields(error) })
      }
    }
  }
  return { drafted, failed }
}
