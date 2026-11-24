import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { DeliveryStatus, MessageAttachment } from '../../db/schema.js'

// WhatsApp Cloud API webhooks (the `messages` field of a
// `whatsapp_business_account` object). WhatsApp has no conversation API: the
// notification is the only copy of an inbound message the engine gets, so
// its content is read here, after the signature of the channel's own Meta
// app was checked. Everything in it is untrusted third-party content.

const maxTextLength = 5_000
const maxNameLength = 200
const maxItems = 1_000

/** Phone number (wa_id) of a WhatsApp user: digits only. */
export const waIdPattern = /^\d{5,20}$/
/** Business-scoped user ID: a country code, `ENT` for a parent ID, a period, then up to 128 letters and digits. */
export const bsuidPattern = /^[A-Z]{2}(?:ENT)?\.[A-Za-z0-9]{1,128}$/
/** A phone number ID or business account ID: Graph IDs are digits. */
const graphIdPattern = /^\d{1,30}$/
/** A WhatsApp message ID (`wamid.…`). */
const wamidPattern = /^[A-Za-z0-9._=:+/-]{1,400}$/

/**
 * Checks `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the raw
 * body with the Meta app secret, in constant time.
 */
export function verifyWhatsAppSignature(secret: string, body: Uint8Array, header: string | undefined) {
  if (!header || !secret) return false
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim())
  if (!match) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  const given = Buffer.from(match[1]!, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const text = z.string().max(100_000)
const optionalText = text.optional()
const mediaSchema = z.object({ id: z.string().max(100).optional(), mime_type: z.string().max(200).optional(), caption: optionalText, filename: optionalText }).loose()

const messageSchema = z.object({
  id: z.string(),
  from: z.string().max(40).optional(),
  from_user_id: z.string().max(200).optional(),
  timestamp: z.union([z.string().max(20), z.number()]),
  type: z.string().max(50),
  text: z.object({ body: text }).loose().optional(),
  image: mediaSchema.optional(),
  video: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  document: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  location: z.object({ name: optionalText, address: optionalText, latitude: z.number().optional(), longitude: z.number().optional() }).loose().optional(),
  contacts: z.array(z.object({ name: z.object({ formatted_name: optionalText }).loose().optional() }).loose()).max(100).optional(),
  interactive: z.object({
    type: z.string().max(50).optional(),
    button_reply: z.object({ title: optionalText }).loose().optional(),
    list_reply: z.object({ title: optionalText, description: optionalText }).loose().optional(),
  }).loose().optional(),
  button: z.object({ text: optionalText }).loose().optional(),
  reaction: z.object({ emoji: optionalText }).loose().optional(),
}).loose()

const contactSchema = z.object({
  wa_id: z.string().max(40).optional(),
  user_id: z.string().max(200).optional(),
  profile: z.object({ name: optionalText, username: optionalText }).loose().optional(),
}).loose()

const statusSchema = z.object({
  id: z.string(),
  status: z.string().max(20),
  timestamp: z.union([z.string().max(20), z.number()]),
  recipient_id: z.string().max(40).optional(),
  recipient_user_id: z.string().max(200).optional(),
  biz_opaque_callback_data: z.string().max(1_000).optional(),
  errors: z.array(z.object({ code: z.number().optional() }).loose()).max(20).optional(),
}).loose()

const valueSchema = z.object({
  messaging_product: z.string().optional(),
  metadata: z.object({ phone_number_id: z.union([z.string(), z.number()]), display_phone_number: z.string().max(40).optional() }).loose(),
  contacts: z.array(contactSchema).max(maxItems).optional(),
  messages: z.array(z.unknown()).max(maxItems).optional(),
  statuses: z.array(z.unknown()).max(maxItems).optional(),
}).loose()

const envelopeSchema = z.object({
  object: z.string(),
  entry: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    changes: z.array(z.object({ field: z.string(), value: z.unknown() }).loose()).max(maxItems).default([]),
  }).loose()).max(maxItems),
})

/** The person who wrote: their business-scoped user ID and phone number (either may be missing), and what their profile shows. */
export interface WhatsAppCustomer {
  userId: string | null
  phone: string | null
  name: string | null
  username: string | null
}

export interface WhatsAppInbound {
  externalId: string
  customer: WhatsAppCustomer
  sentAt: Date
  text: string
  attachments: MessageAttachment[]
}

export interface WhatsAppStatus {
  /** The `wamid` of the business's message. */
  externalId: string
  status: DeliveryStatus
  at: Date
  /** The engine's outgoing message it reports on, from `biz_opaque_callback_data`, when that is one of ours. */
  outgoingId: string | null
  /** For `failed`: the engine's code for the first error (`outside_window`, `recipient_unavailable`, …). */
  errorCode: string | null
}

export interface WhatsAppChange {
  /** The WhatsApp Business Account (`entry.id`). */
  businessAccountId: string
  phoneNumberId: string
  messages: WhatsAppInbound[]
  statuses: WhatsAppStatus[]
}

const clip = (value: string | undefined | null, length: number) => {
  if (value === undefined || value === null) return null
  const clipped = Array.from(value).slice(0, length).join('').trim()
  return clipped || null
}

const idString = (value: string | number) => typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : '') : value

function date(value: string | number) {
  const seconds = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000) : null
}

const mediaIdOf = (value: string | undefined) => value && /^\d{1,40}$/.test(value) ? value : undefined

function mediaAttachment(type: string, value: z.infer<typeof mediaSchema>): MessageAttachment {
  const mediaId = mediaIdOf(value.id)
  const mimeType = value.mime_type && /^[\w.+-]+\/[\w.+-]+(?:;.{0,100})?$/.test(value.mime_type) ? value.mime_type.split(';')[0]!.trim() : undefined
  const name = clip(value.filename, maxNameLength)
  return { type, ...(name ? { name } : {}), ...(mediaId ? { mediaId } : {}), ...(mimeType ? { mimeType } : {}) }
}

/**
 * One inbound message as it is stored: its text (a caption, a button's
 * title), and anything else as an attachment: a media reference (Meta's media
 * ID, never a URL), or a readable placeholder for the kinds the engine does
 * not answer (location, contacts, reaction, interactive reply, sticker,
 * order, system notice, unsupported). Any attachment flags the message, so
 * the decision step leaves it to a person.
 */
export function inboundContent(message: z.infer<typeof messageSchema>): { text: string, attachments: MessageAttachment[] } {
  const label = (type: string, name: string | null): MessageAttachment => name ? { type, name } : { type }
  switch (message.type) {
    case 'text': return { text: clip(message.text?.body, maxTextLength) ?? '', attachments: [] }
    case 'image':
    case 'video':
    case 'audio': {
      const media = (message.type === 'image' ? message.image : message.type === 'video' ? message.video : message.audio) ?? {}
      return { text: clip(media.caption, maxTextLength) ?? '', attachments: [mediaAttachment(message.type, media)] }
    }
    case 'document': return { text: clip(message.document?.caption, maxTextLength) ?? '', attachments: [mediaAttachment('file', message.document ?? {})] }
    case 'sticker': return { text: '', attachments: [mediaAttachment('sticker', message.sticker ?? {})] }
    case 'location': {
      const place = [message.location?.name, message.location?.address].filter(Boolean).join(', ')
      const coordinates = message.location?.latitude !== undefined && message.location.longitude !== undefined
        ? `${message.location.latitude}, ${message.location.longitude}` : ''
      return { text: '', attachments: [label('location', clip(place || coordinates, maxNameLength))] }
    }
    case 'contacts': {
      const names = (message.contacts ?? []).map(contact => contact.name?.formatted_name).filter(Boolean).join(', ')
      return { text: '', attachments: [label('contacts', clip(names, maxNameLength))] }
    }
    case 'reaction': return { text: '', attachments: [label('reaction', clip(message.reaction?.emoji, 20))] }
    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply
      return { text: clip(reply?.title, maxTextLength) ?? '', attachments: [label('interactive', clip(message.interactive?.type, 50))] }
    }
    case 'button': return { text: clip(message.button?.text, maxTextLength) ?? '', attachments: [{ type: 'button' }] }
    case 'order': return { text: '', attachments: [{ type: 'order' }] }
    case 'system': return { text: '', attachments: [{ type: 'system' }] }
    default: return { text: '', attachments: [{ type: 'unsupported' }] }
  }
}

const deliveryStatuses: Record<string, DeliveryStatus> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The engine's code for a Cloud API error code, as a send or a failed status reports it. */
export function whatsappErrorCode(code: number | undefined) {
  switch (code) {
    case 131047: return 'outside_window'
    case 131026:
    case 131021: return 'recipient_unavailable'
    case 131049:
    case 131050:
    case 130472: return 'message_not_allowed'
    case 130429:
    case 131056:
    case 131048: return 'rate_limited'
    // The business phone number is not registered with the Cloud API.
    case 133010: return 'account_not_registered'
    // The business account is locked, restricted or banned for a policy violation.
    case 131031:
    case 368: return 'account_locked'
    // No valid payment method, or a payment problem on the business account.
    case 131042: return 'payment_required'
    default: return 'rejected'
  }
}

function customerOf(contacts: Array<z.infer<typeof contactSchema>>, message: z.infer<typeof messageSchema>): WhatsAppCustomer | null {
  const phone = message.from && waIdPattern.test(message.from) ? message.from : null
  const userId = message.from_user_id && bsuidPattern.test(message.from_user_id) ? message.from_user_id : null
  if (!phone && !userId) return null
  const contact = contacts.find(value => (userId && value.user_id === userId) || (phone && value.wa_id === phone))
  return { userId, phone, name: clip(contact?.profile?.name, maxNameLength), username: clip(contact?.profile?.username, maxNameLength) }
}

/**
 * Reads a verified notification: per phone number, the inbound messages and
 * the statuses of the business's own messages. Anything that is not a
 * WhatsApp `messages` change, or does not parse, is left out; one malformed
 * item never drops the rest.
 */
export function parseWhatsAppNotification(payload: unknown): WhatsAppChange[] {
  const envelope = envelopeSchema.safeParse(payload)
  if (!envelope.success || envelope.data.object !== 'whatsapp_business_account') return []
  const changes: WhatsAppChange[] = []
  for (const entry of envelope.data.entry) {
    const businessAccountId = idString(entry.id)
    if (!graphIdPattern.test(businessAccountId)) continue
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue
      const value = valueSchema.safeParse(change.value)
      if (!value.success) continue
      const phoneNumberId = idString(value.data.metadata.phone_number_id)
      if (!graphIdPattern.test(phoneNumberId)) continue
      const contacts = value.data.contacts ?? []
      const messages = (value.data.messages ?? []).flatMap((raw): WhatsAppInbound[] => {
        const message = messageSchema.safeParse(raw)
        if (!message.success || !wamidPattern.test(message.data.id)) return []
        const sentAt = date(message.data.timestamp)
        const customer = customerOf(contacts, message.data)
        if (!sentAt || !customer) return []
        return [{ externalId: message.data.id, customer, sentAt, ...inboundContent(message.data) }]
      })
      const statuses = (value.data.statuses ?? []).flatMap((raw): WhatsAppStatus[] => {
        const status = statusSchema.safeParse(raw)
        if (!status.success || !wamidPattern.test(status.data.id)) return []
        const delivery = deliveryStatuses[status.data.status]
        const at = date(status.data.timestamp)
        if (!delivery || !at) return []
        const tag = status.data.biz_opaque_callback_data
        return [{ externalId: status.data.id, status: delivery, at, outgoingId: tag && uuidPattern.test(tag) ? tag : null,
          errorCode: delivery === 'failed' ? whatsappErrorCode(status.data.errors?.[0]?.code) : null }]
      })
      if (messages.length || statuses.length) changes.push({ businessAccountId, phoneNumberId, messages, statuses })
    }
  }
  return changes
}
