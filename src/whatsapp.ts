import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { channelTarget, listChannels, storeConnectedAccount } from './channels.js'
import { adapterFor, clock, recordEvent, resolveProviderApp, type EngineContext } from './context.js'
import { queueControlEvent } from './control-events.js'
import type { Executor } from './db/client.js'
import { channels, conversations, directMessages, outgoingMessages, providerApps, type DeliveryStatus } from './db/schema.js'
import { EngineError, notFound } from './errors.js'
import { channelDriver } from './jobs/driver.js'
import { log } from './log.js'
import type { WhatsAppAdapter } from './platforms/whatsapp/adapter.js'
import {
  parseWhatsAppNotification, verifyWhatsAppSignature, type WhatsAppChange, type WhatsAppCustomer, type WhatsAppInbound, type WhatsAppStatus,
} from './platforms/whatsapp/webhook.js'
import { messagesRetentionMs } from './retention.js'
import { emitWebhookEvents } from './webhooks.js'

// WhatsApp, inbound side (ADR 0006). The control plane's public Meta webhook
// receiver forwards a WhatsApp notification as it came, with Meta's
// signature; the engine checks that signature with the secret of the app
// each named number was connected through, then stores the messages and
// applies the statuses. Like the conversation sync, this module stores
// untrusted content and holds no sending code.

type Channel = typeof channels.$inferSelect

export interface WhatsAppNotificationResult {
  /** Inbound messages stored for the first time. */
  stored: number
  /** Status reports that changed an outgoing message. */
  statuses: number
  /** Changes for numbers no active channel holds, or whose signature did not match the channel's app. */
  ignored: number
}

/**
 * One forwarded notification. Unknown numbers, a signature that does not
 * match a channel's app, and items that do not parse are ignored (counted):
 * Meta must not retry them. Only a failure to store throws, so the control
 * plane answers Meta with an error and Meta delivers the notification again;
 * storing is idempotent on the message ID.
 */
export async function receiveWhatsAppNotification(context: EngineContext, body: Buffer, signature: string | undefined): Promise<WhatsAppNotificationResult> {
  let payload: unknown
  try { payload = JSON.parse(body.toString('utf8')) } catch { return { stored: 0, statuses: 0, ignored: 1 } }
  const changes = parseWhatsAppNotification(payload)
  const result: WhatsAppNotificationResult = { stored: 0, statuses: 0, ignored: 0 }
  if (!changes.length) return result
  const numbers = [...new Set(changes.map(change => change.phoneNumberId))]
  const rows = await context.db.select({ channel: channels, secretRef: providerApps.secretRef }).from(channels)
    .innerJoin(providerApps, eq(providerApps.id, channels.providerAppId))
    .where(and(eq(channels.platform, 'whatsapp'), eq(channels.kind, 'whatsapp_number'), eq(channels.status, 'active'), inArray(channels.externalId, numbers)))
  // A signature is checked once per secret, and a channel counts only when its own app signed the body.
  const verified = new Map<string, boolean>()
  const signedBy = (secretRef: string) => {
    if (!verified.has(secretRef)) verified.set(secretRef, verifyWhatsAppSignature(context.providerSecrets.get(secretRef) ?? '', body, signature))
    return verified.get(secretRef)!
  }
  for (const change of changes) {
    const targets = rows.filter(row => row.channel.externalId === change.phoneNumberId
      && (row.channel.parentExternalId === null || row.channel.parentExternalId === change.businessAccountId))
    const trusted = targets.filter(row => signedBy(row.secretRef)).map(row => row.channel)
    if (!trusted.length) {
      result.ignored++
      if (targets.length) log('warn', 'whatsapp notification signature does not match the channel app', { channelIds: targets.map(row => row.channel.id) })
      continue
    }
    for (const channel of trusted) {
      result.stored += await storeChange(context, channel, change)
      result.statuses += await applyStatuses(context, channel, change.statuses)
    }
  }
  return result
}

/** The stored conversation with this person: by business-scoped user ID, else by phone number (the key before Meta gave one). */
async function findConversation(executor: Executor, channelId: string, customer: WhatsAppCustomer) {
  const keys = [customer.userId, customer.phone].filter((value): value is string => Boolean(value))
  const rows = await executor.select().from(conversations).where(and(eq(conversations.channelId, channelId), inArray(conversations.externalId, keys)))
  return rows.find(row => row.externalId === customer.userId) ?? rows[0] ?? null
}

/**
 * Stores a change's inbound messages, per person in one transaction:
 * the conversation (keyed by the person's business-scoped user ID, or phone
 * number), then each message once (keyed by its `wamid`). The person's newest
 * message moves the 24-hour window. Webhooks hear of each message the first
 * time it is stored, oldest first.
 */
async function storeChange(context: EngineContext, channel: Channel, change: WhatsAppChange) {
  const now = clock(context)
  const horizon = now.getTime() - messagesRetentionMs
  const byPerson = new Map<string, WhatsAppInbound[]>()
  for (const message of change.messages) {
    // A message past retention was deleted, or soon will be: it is not stored again.
    if (message.sentAt.getTime() < horizon) continue
    const key = message.customer.userId ?? message.customer.phone!
    byPerson.set(key, [...byPerson.get(key) ?? [], message])
  }
  let stored = 0
  for (const messages of byPerson.values()) {
    stored += await context.db.transaction(async transaction => {
      const customer = mergedCustomer(messages)
      const newest = new Date(Math.max(...messages.map(message => message.sentAt.getTime())))
      const existing = await findConversation(transaction, channel.id, customer)
      const participant = {
        // The phone number is what a send addresses first; the user ID when Meta gives no number.
        ...(customer.phone || customer.userId ? { participantExternalId: customer.phone ?? customer.userId } : {}),
        ...(customer.name ? { participantName: customer.name } : {}),
        ...(customer.username ? { participantUsername: customer.username } : {}),
      }
      const [conversation] = existing
        ? await transaction.update(conversations).set({ ...participant, updatedTime: sql`greatest(${conversations.updatedTime}, ${newest}::timestamptz)`, updatedAt: now })
          .where(eq(conversations.id, existing.id)).returning()
        : await transaction.insert(conversations).values({ organizationId: channel.organizationId, channelId: channel.id, platform: 'whatsapp',
          externalId: customer.userId ?? customer.phone!, participantExternalId: customer.phone ?? customer.userId, participantName: customer.name,
          participantUsername: customer.username, updatedTime: newest, lastInboundAt: null, lastMessageAt: newest, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({ target: [conversations.channelId, conversations.externalId], set: { updatedAt: now } }).returning()
      const inserted = await transaction.insert(directMessages).values(messages.map(message => ({ organizationId: channel.organizationId, channelId: channel.id,
        conversationId: conversation!.id, externalId: message.externalId, direction: 'in' as const, text: message.text, attachments: message.attachments,
        sentAt: message.sentAt, firstSeenAt: now })))
        .onConflictDoNothing({ target: [directMessages.channelId, directMessages.externalId] }).returning()
      if (!inserted.length) return 0
      const latest = new Date(Math.max(...inserted.map(message => message.sentAt.getTime())))
      const [updated] = await transaction.update(conversations).set({
        lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${latest}::timestamptz)`,
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${latest}::timestamptz)`, updatedAt: now,
      }).where(eq(conversations.id, conversation!.id)).returning()
      const received = [...inserted].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      await emitWebhookEvents(transaction, { organizationId: channel.organizationId, type: 'message.received', channelId: channel.id, occurredAt: now,
        items: received.map(message => ({ channelId: channel.id, conversationId: updated!.id, messageId: message.id, platform: 'whatsapp',
          participant: { name: updated!.participantName, username: updated!.participantUsername }, text: message.text, attachments: message.attachments,
          sentAt: message.sentAt.toISOString() })) })
      return inserted.length
    })
  }
  return stored
}

/** The person as the newest of their messages names them; an older message fills what it leaves out. */
function mergedCustomer(messages: WhatsAppInbound[]): WhatsAppCustomer {
  const ordered = [...messages].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime()).map(message => message.customer)
  const first = <K extends keyof WhatsAppCustomer>(key: K) => ordered.find(customer => customer[key])?.[key] ?? null
  return { userId: first('userId'), phone: first('phone'), name: first('name'), username: first('username') }
}

const deliveryRank: Record<DeliveryStatus, number> = { sent: 1, delivered: 2, read: 3, failed: 4 }

/**
 * Status reports of the channel's own messages. Each names the message by
 * the engine's outgoing ID (echoed from the send) or its `wamid`. Statuses
 * only move forward (sent, delivered, read; failed after any). A report for
 * a message whose send is still open or uncertain records the `wamid`, and
 * the reconciliation settles an uncertain one at its next look, at once.
 */
async function applyStatuses(context: EngineContext, channel: Channel, statuses: WhatsAppStatus[]) {
  let changed = 0
  for (const status of [...statuses].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    changed += await context.db.transaction(async transaction => {
      const now = clock(context)
      const [message] = await transaction.select().from(outgoingMessages).where(and(eq(outgoingMessages.channelId, channel.id),
        status.outgoingId ? eq(outgoingMessages.id, status.outgoingId) : eq(outgoingMessages.platformMessageId, status.externalId))).for('update').limit(1)
      if (!message || (message.platformMessageId && message.platformMessageId !== status.externalId)) return 0
      const forward = !message.deliveryStatus || deliveryRank[status.status] > deliveryRank[message.deliveryStatus]
      const unsettled = message.state === 'sending' || message.state === 'uncertain' || message.reconciling
      if (!forward && (!unsettled || message.reportedMessageId)) return 0
      await transaction.update(outgoingMessages).set({
        ...(forward ? { deliveryStatus: status.status, deliveryErrorCode: status.errorCode, deliveryUpdatedAt: status.at } : {}),
        ...(unsettled && !message.platformMessageId ? { reportedMessageId: status.externalId } : {}),
        // An uncertain send is looked for again now: the report is its match.
        ...(message.reconciling ? { notBefore: now } : {}),
        updatedAt: now,
      }).where(eq(outgoingMessages.id, message.id))
      if (forward && status.status === 'failed') {
        await recordEvent(transaction, { organizationId: message.organizationId, kind: 'message.delivery_failed', channelId: channel.id,
          detail: { code: status.errorCode } })
      }
      await queueControlEvent(transaction, 'messages.changed', message.organizationId, now)
      return 1
    })
  }
  return changed
}

export const whatsappConnectSchema = z.strictObject({
  providerAppId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  businessAccountId: z.string().regex(/^\d{1,30}$/),
  phoneNumberId: z.string().regex(/^\d{1,30}$/),
  token: z.string().min(20).max(4_000).refine(value => !/\s/.test(value), 'must not contain whitespace'),
})

/**
 * The manual connect: an operator's token for one number of a business
 * account. The token is checked against Meta (the number must be in the
 * account) and the app subscribed before anything is stored; it is then
 * sealed like any channel credential and never returned.
 */
export async function connectWhatsAppNumber(context: EngineContext, organizationId: string, input: z.infer<typeof whatsappConnectSchema>) {
  const app = await resolveProviderApp(context, context.db, input.providerAppId)
  if (app.ownerKind === 'tenant' && app.ownerOrganizationId !== organizationId) throw notFound('Provider app')
  if (app.platform !== 'whatsapp') throw new EngineError(400, 'unsupported_channel', 'The provider app is not a WhatsApp app')
  const adapter = adapterFor(context, 'whatsapp') as Partial<WhatsAppAdapter>
  if (!adapter.connectNumber) throw new EngineError(503, 'platform_unavailable', 'WhatsApp is not configured')
  const account = await adapter.connectNumber(app, input)
  const channelId = await context.db.transaction(transaction => storeConnectedAccount(context, transaction, organizationId, app.id, 'whatsapp', account,
    'channel.whatsapp_connected'))
  return { channels: await listChannels(context, organizationId, [channelId]) }
}

/** Larger attachments are not passed on. */
export const maxAttachmentBytes = 100 * 1024 * 1024

/**
 * The bytes of a received attachment that kept a media ID (WhatsApp), read
 * from the platform on request: the engine never stores them.
 */
export async function readAttachment(context: EngineContext, organizationId: string, conversationId: string, messageId: string, index: number) {
  const [row] = await context.db.select({ message: directMessages, channel: channels }).from(directMessages)
    .innerJoin(channels, eq(channels.id, directMessages.channelId))
    .where(and(eq(directMessages.organizationId, organizationId), eq(directMessages.conversationId, conversationId), eq(directMessages.id, messageId))).limit(1)
  const attachment = row?.message.attachments[index]
  if (!row || !attachment?.mediaId) throw notFound('Attachment')
  const adapter = adapterFor(context, row.channel.platform)
  if (!adapter.downloadMedia) throw notFound('Attachment')
  const driver = await channelDriver(context, context.db, row.channel)
  const result = await adapter.downloadMedia(driver.app, { channel: channelTarget(row.channel), token: driver.token, mediaId: attachment.mediaId,
    maxBytes: maxAttachmentBytes })
  if (result.kind === 'unavailable') {
    if (result.reason === 'too_large') throw new EngineError(413, 'too_large', 'The attachment is larger than 100 MB')
    if (result.reason === 'refused') throw new EngineError(409, 'missing_permission', 'The platform refused the download; connect the channel again')
    throw new EngineError(410, 'media_gone', 'The platform no longer has this attachment')
  }
  return { ...result, name: attachment.name ?? null }
}
