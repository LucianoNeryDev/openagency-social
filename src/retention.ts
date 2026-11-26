import { and, eq, inArray, lt, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { clock, recordEvent, type EngineContext } from './context.js'
import type { Executor } from './db/client.js'
import { deleteExpiredDeliveries } from './webhooks.js'
import { learnedAnswersRetentionMs } from './answering/learning.js'
import {
  channelMetricSamples, channels, conversations, directMessages, inboundDrafts, jobs, learnedAnswers, outgoingMessageCancellations, outgoingMessages, postMetricSamples, postResponses, replies,
  replyCancellations, responseChecks,
} from './db/schema.js'

const dayMs = 86_400_000
export const postMetricSamplesRetentionMs = 120 * dayMs
export const channelMetricSamplesRetentionMs = 400 * dayMs
/** Comments are third-party personal data: kept 180 days after the post's publishAt. The brand's replies go with them. */
export const responsesRetentionMs = 180 * dayMs
/** Request keys cancelled before they arrived: far longer than any submission is on its way. */
export const replyCancellationsRetentionMs = 30 * dayMs
/** Direct messages are third-party personal data too: kept 180 days after they were sent. */
export const messagesRetentionMs = 180 * dayMs
/** Engine decisions and drafts about inbound DMs and comments: as long as those. */
export const draftsRetentionMs = 180 * dayMs
/** A reply that retention settled stays this long, so the dashboard can read what became of it. */
export const settledReplyGraceMs = dayMs
/** How often the worker deletes what has expired. */
export const retentionIntervalMs = 60 * 60_000

/**
 * Deletes expired history and responses, and every response of a disabled
 * channel. Replies still open when their post expires are settled first and
 * kept a day, so the dashboard learns what became of them: a queued one
 * fails as `expired`, an uncertain one (or one a person said did not go out)
 * is no longer looked for. A reply being sent is left until it settles.
 * Safe to run at any time; each step is independent.
 */
export async function applyRetention(context: EngineContext) {
  const now = clock(context).getTime()
  const postSamples = await context.db.delete(postMetricSamples)
    .where(lt(postMetricSamples.collectedAt, new Date(now - postMetricSamplesRetentionMs))).returning({ id: postMetricSamples.id })
  const channelSamples = await context.db.delete(channelMetricSamples)
    .where(lt(channelMetricSamples.collectedAt, new Date(now - channelMetricSamplesRetentionMs))).returning({ id: channelMetricSamples.id })
  const expiredJobs = context.db.select({ id: jobs.id }).from(jobs).where(lt(jobs.publishAt, new Date(now - responsesRetentionMs)))
  const disabledChannels = context.db.select({ id: channels.id }).from(channels).where(eq(channels.status, 'disabled'))
  // One delete per condition: each is a semi-join on an index (job, or channel), where an `or` of the two scans the table.
  const expired = await context.db.delete(postResponses).where(inArray(postResponses.jobId, expiredJobs)).returning({ id: postResponses.id })
  const disabled = await context.db.delete(postResponses).where(inArray(postResponses.channelId, disabledChannels)).returning({ id: postResponses.id })
  await context.db.delete(responseChecks).where(inArray(responseChecks.jobId, expiredJobs))
  await context.db.delete(responseChecks).where(inArray(responseChecks.channelId, disabledChannels))
  const at = clock(context)
  for (const expiring of [inArray(replies.jobId, expiredJobs), inArray(replies.channelId, disabledChannels)]) {
    const failed = await context.db.update(replies).set({ state: 'failed', errorCode: 'expired', settledAt: at, updatedAt: at })
      .where(and(expiring, eq(replies.state, 'queued'))).returning()
    // A person's "not sent" stays as they said it; an uncertain reply says why the looks stopped.
    const stopped = await context.db.update(replies).set({ reconciling: false, errorCode: sql`case when ${replies.state} = 'uncertain' then 'expired' else ${replies.errorCode} end`,
      updatedAt: at }).where(and(expiring, eq(replies.reconciling, true), inArray(replies.state, ['uncertain', 'failed']))).returning()
    for (const reply of [...failed, ...stopped]) {
      await recordEvent(context.db, { organizationId: reply.organizationId, kind: 'reply.expired', jobId: reply.jobId, channelId: reply.channelId,
        detail: { replyId: reply.replyId, state: reply.state } })
    }
  }
  const settled = (expiring: SQL) => and(expiring, notInArray(replies.state, ['queued', 'sending']), eq(replies.reconciling, false),
    lt(replies.updatedAt, new Date(now - settledReplyGraceMs)))
  const expiredReplies = await context.db.delete(replies).where(settled(inArray(replies.jobId, expiredJobs))).returning({ id: replies.id })
  const disabledReplies = await context.db.delete(replies).where(settled(inArray(replies.channelId, disabledChannels))).returning({ id: replies.id })
  await context.db.delete(replyCancellations).where(lt(replyCancellations.createdAt, new Date(now - replyCancellationsRetentionMs)))
  const conversationsExpired = await expireConversations(context.db, now)
  const webhookDeliveries = await deleteExpiredDeliveries(context.db, at)
  // Decisions and drafts answer inbound rows: they go after as long, and with a disabled channel (the cascades cover the rest).
  const drafts = await context.db.delete(inboundDrafts).where(or(lt(inboundDrafts.createdAt, new Date(now - draftsRetentionMs)),
    inArray(inboundDrafts.channelId, disabledChannels))).returning({ id: inboundDrafts.id })
  // Learned answers keep a redacted inbound text: as long as the item it came from (inboundAt), and not past a disabled channel.
  const learned = await context.db.delete(learnedAnswers).where(lt(learnedAnswers.inboundAt, new Date(now - learnedAnswersRetentionMs))).returning({ id: learnedAnswers.id })
  const learnedDisabled = await context.db.delete(learnedAnswers).where(inArray(learnedAnswers.channelId, disabledChannels)).returning({ id: learnedAnswers.id })
  return { postMetricSamples: postSamples.length, channelMetricSamples: channelSamples.length, responses: expired.length + disabled.length,
    replies: expiredReplies.length + disabledReplies.length, ...conversationsExpired, webhookDeliveries, drafts: drafts.length,
    learnedAnswers: learned.length + learnedDisabled.length }
}

/** Outgoing messages that are settled and no longer looked for. Queued, sending and uncertain ones settle within a day of their send time. */
const settledOutgoing = and(notInArray(outgoingMessages.state, ['queued', 'sending', 'uncertain']), eq(outgoingMessages.reconciling, false))

/**
 * Direct messages: messages older than 180 days, settled outgoing
 * messages submitted before then, and conversations whose last message is
 * older, once nothing unsettled points at them; everything of a disabled
 * channel once its outgoing messages are settled. Tombstones go after 30 days.
 */
async function expireConversations(executor: Executor, now: number) {
  const disabledChannels = executor.select({ id: channels.id }).from(channels).where(eq(channels.status, 'disabled'))
  const horizon = new Date(now - messagesRetentionMs)
  const messages = await executor.delete(directMessages).where(lt(directMessages.sentAt, horizon)).returning({ id: directMessages.id })
  const outgoing = await executor.delete(outgoingMessages).where(and(settledOutgoing,
    or(lt(outgoingMessages.createdAt, horizon), inArray(outgoingMessages.channelId, disabledChannels)))).returning({ id: outgoingMessages.id })
  // What is left of a conversation's outgoing messages keeps it.
  const unsettled = executor.select({ id: outgoingMessages.conversationId }).from(outgoingMessages)
  const gone = await executor.delete(conversations).where(and(or(lt(conversations.lastMessageAt, horizon), inArray(conversations.channelId, disabledChannels)),
    notInArray(conversations.id, unsettled))).returning({ id: conversations.id })
  await executor.delete(outgoingMessageCancellations).where(lt(outgoingMessageCancellations.createdAt, new Date(now - replyCancellationsRetentionMs)))
  return { conversations: gone.length, directMessages: messages.length, outgoingMessages: outgoing.length }
}

/** Conversations of one channel, with their messages and outgoing messages (by cascade), removed when it is disabled. */
export async function forgetChannelConversations(executor: Executor, channelId: string) {
  await executor.delete(outgoingMessages).where(eq(outgoingMessages.channelId, channelId))
  await executor.delete(conversations).where(eq(conversations.channelId, channelId))
}

/** Responses, check state, replies, engine drafts and learned answers of one channel, removed when it is disabled. */
export async function forgetChannelResponses(executor: Executor, channelId: string) {
  await executor.delete(inboundDrafts).where(eq(inboundDrafts.channelId, channelId))
  await executor.delete(learnedAnswers).where(eq(learnedAnswers.channelId, channelId))
  await executor.delete(postResponses).where(eq(postResponses.channelId, channelId))
  await executor.delete(responseChecks).where(eq(responseChecks.channelId, channelId))
  await executor.delete(replies).where(eq(replies.channelId, channelId))
}
