import { z } from 'zod'
import type { MessageAttachment, MessagingPlatform } from '../../db/schema.js'
import { pickOwnReply } from '../reply-match.js'
import type {
  ChannelTarget, ConversationsResult, FindMessageInput, FindReplyOutcome, MessageParticipant, PlatformMessage, SendMessageOutcome,
} from '../types.js'
import { GraphError, type GraphCall, type GraphClient } from './graph.js'
import { classifyReply } from './replies.js'

/** The newest page of conversations read in one sync, and the messages read from each. */
export const conversationsPageSize = 25
export const conversationMessagesLimit = 20

const maxNameLength = 200
const maxTextLength = 5_000
const maxAttachments = 20

const paging = z.object({ cursors: z.object({ after: z.string().max(1_000).optional() }).optional(), next: z.string().optional() }).optional()
// Messenger participants carry a name (and an email, never read); Instagram ones a username.
const participantSchema = z.object({ id: z.string().min(1).max(200), name: z.string().optional(), username: z.string().optional() })
const conversationsSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(400),
    updated_time: z.string().max(40),
    participants: z.object({ data: z.array(participantSchema).max(50) }).optional(),
  })).max(100),
  paging,
})
const attachmentSchema = z.object({
  mime_type: z.string().max(200).optional(),
  name: z.string().optional(),
  // Present or not is all that is read: their URLs are never kept.
  image_data: z.unknown().optional(),
  video_data: z.unknown().optional(),
  file_url: z.unknown().optional(),
})
const messagesSchema = z.object({
  messages: z.object({
    data: z.array(z.object({
      id: z.string().min(1).max(400),
      created_time: z.string().max(40),
      // Only compared with the channel's own account; never stored.
      from: z.object({ id: z.string().max(200).optional(), username: z.string().max(200).optional() }).optional(),
      message: z.string().optional(),
      attachments: z.object({ data: z.array(attachmentSchema).max(100) }).optional(),
    })).max(100),
    paging,
  }).optional(),
})
const sentSchema = z.object({ recipient_id: z.string().max(200).optional(), message_id: z.string().min(1).max(400) })

/** A conversation ID that can go in a Graph path; others are left out of the sync. */
const pathSafeId = /^[A-Za-z0-9_.-]{1,400}$/

const clip = (value: string | undefined, length: number) => value === undefined ? null : Array.from(value).slice(0, length).join('') || null

function date(value: string) {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed)
}

/** Whether a message or participant is the channel's own account: its ID, or the Instagram username the channel is named by. */
function ownAccount(value: { id?: string | undefined, username?: string | undefined } | undefined, channel: ChannelTarget) {
  if (!value) return false
  if (value.id !== undefined && value.id === channel.externalId) return true
  return Boolean(channel.handle && value.username && value.username.toLowerCase() === channel.handle.toLowerCase())
}

/** A received attachment as stored: its kind and file name, never its URL. */
export function attachmentOf(value: z.infer<typeof attachmentSchema>): MessageAttachment {
  const mime = value.mime_type ?? ''
  const type = mime.startsWith('image/') || value.image_data !== undefined ? 'image'
    : mime.startsWith('video/') || value.video_data !== undefined ? 'video'
      : mime.startsWith('audio/') ? 'audio'
        : mime || value.file_url !== undefined ? 'file' : 'other'
  const name = clip(value.name, maxNameLength)
  return name ? { type, name } : { type }
}

/**
 * Why Meta refused a read: a permission it names or implies (10, 200-299),
 * messaging the app cannot use (3), or an account whose messages cannot be
 * listed at all (100, for example Instagram's "allow access to messages" turned
 * off). The read's parameters are fixed, so 100 is not a request to fix by retrying.
 */
function readRefusal(error: unknown, permission: string) {
  if (!(error instanceof GraphError) || error.failure.kind !== 'http') return null
  const code = error.failure.code ?? 0
  if (code === 10 || code === 3 || (code >= 200 && code <= 299)) return `Reading messages needs the ${permission} permission; connect the channel again to grant it.`
  if (code === 100) {
    return `Meta does not list this account's conversations (${error.failure.message}). Check that the account allows access to messages and has the ${permission} permission, then connect the channel again.`
  }
  return null
}

/**
 * The newest conversations of a Page (`GET /{page-id}/conversations`) or an
 * Instagram account (`GET /me/conversations` with the Page token, or on
 * graph.instagram.com with Instagram's login). One page, newest first.
 */
export async function readConversations(graph: GraphClient, call: GraphCall, input: { path: string, platform: MessagingPlatform, channel: ChannelTarget,
  permission: string }): Promise<ConversationsResult> {
  let result: z.infer<typeof conversationsSchema>
  try {
    result = conversationsSchema.parse(await graph.request('GET', input.path, { ...call, query: {
      platform: input.platform, fields: 'id,updated_time,participants', limit: String(conversationsPageSize),
    } }))
  } catch (error) {
    const reason = readRefusal(error, input.permission)
    if (reason) return { kind: 'unavailable', reason }
    throw error
  }
  return { kind: 'ok', conversations: result.data.flatMap(conversation => {
    const updatedAt = date(conversation.updated_time)
    if (!updatedAt || !pathSafeId.test(conversation.id)) return []
    const other = conversation.participants?.data.find(value => !ownAccount(value, input.channel))
    const participant: MessageParticipant | null = other
      ? { externalId: other.id, name: clip(other.name, maxNameLength), username: clip(other.username, maxNameLength) } : null
    return [{ externalId: conversation.id, updatedAt, participant }]
  }) }
}

/** The newest 20 messages of a conversation, newest first. Instagram answers for those only; older ones read as deleted. */
export async function readConversationMessages(graph: GraphClient, call: GraphCall, input: { conversationExternalId: string, channel: ChannelTarget }):
Promise<PlatformMessage[]> {
  if (!pathSafeId.test(input.conversationExternalId)) throw new Error('Unexpected conversation ID')
  const result = messagesSchema.parse(await graph.request('GET', `/${input.conversationExternalId}`, { ...call, query: {
    fields: `messages.limit(${conversationMessagesLimit}){id,created_time,from,to,message,attachments}`,
  } }))
  return (result.messages?.data ?? []).flatMap(message => {
    const sentAt = date(message.created_time)
    if (!sentAt) return []
    return [{ externalId: message.id, fromChannel: ownAccount(message.from, input.channel), text: clip(message.message, maxTextLength) ?? '',
      attachments: (message.attachments?.data ?? []).slice(0, maxAttachments).map(attachmentOf), sentAt }]
  })
}

/**
 * Classifies a failed send. Only a request that may have reached Meta
 * without a readable answer is uncertain. Outside the 24-hour window Meta
 * answers code 10 with subcode 2018278 (Messenger) or 2534022 (Instagram).
 */
export function classifyMessage(error: unknown, permission: string): SendMessageOutcome {
  if (error instanceof GraphError && error.failure.kind === 'http') {
    const { code, subcode, status, message } = error.failure
    const detail = `HTTP ${status} code ${code ?? 0}${subcode ? `/${subcode}` : ''}: ${message}`
    if (code === 10 && (subcode === 2018278 || subcode === 2534022)) return { kind: 'failed', retryable: false, code: 'outside_window', detail }
    // 551: "This person isn't available right now"; 100/2018001: no matching user.
    if (code === 551 || (code === 100 && subcode === 2018001)) return { kind: 'failed', retryable: false, code: 'recipient_unavailable', detail }
  }
  const outcome = classifyReply(error, permission)
  if (outcome.kind !== 'failed') return outcome.kind === 'sent' ? { kind: 'sent', externalId: outcome.externalId } : outcome
  // Reply codes name a comment; here the refusal concerns the person or the conversation.
  if (outcome.code === 'reply_not_allowed') return { ...outcome, code: 'message_not_allowed' }
  if (outcome.code === 'comment_gone') return { ...outcome, code: 'recipient_unavailable' }
  return outcome
}

/** One text message: `POST /{page-id}/messages` or `/me/messages`, answering within the person's window (`RESPONSE`). */
export async function sendDirectMessage(graph: GraphClient, call: GraphCall, input: { path: string, recipientExternalId: string, text: string, permission: string }):
Promise<SendMessageOutcome> {
  let sent: z.infer<typeof sentSchema>
  try {
    sent = sentSchema.parse(await graph.request('POST', input.path, { ...call, form: {
      recipient: JSON.stringify({ id: input.recipientExternalId }), messaging_type: 'RESPONSE', message: JSON.stringify({ text: input.text }),
    } }))
  } catch (error) {
    return classifyMessage(error, input.permission)
  }
  return { kind: 'sent', externalId: sent.message_id }
}

/** The channel's own message with this text in the conversation's newest 20, for an uncertain send. */
export async function findDirectMessage(graph: GraphClient, call: GraphCall, input: FindMessageInput): Promise<FindReplyOutcome> {
  const messages = await readConversationMessages(graph, call, input)
  return pickOwnReply(messages.map(message => ({ id: message.externalId, text: message.text, createdAt: message.sentAt.getTime(), own: message.fromChannel })), input)
}
