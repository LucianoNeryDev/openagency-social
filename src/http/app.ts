import { createHash, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { sql } from 'drizzle-orm'
import {
  createApp, createRouter, defineEventHandler, getQuery, getRequestHeader, getRouterParam, readRawBody,
  setResponseHeaders, setResponseStatus, type EventHandlerRequest, type H3Event,
} from 'h3'
import { z, ZodError } from 'zod'
import { disableChannel, finishConnect, listChannels, readPublishing, setPublishing, startConnect } from '../channels.js'
import type { EngineContext } from '../context.js'
import { EngineError } from '../errors.js'
import { cancelJobs, listJobs, reconcileJob, resolveJob, resolveJobSchema, restoreJobs, submitJobs } from '../jobs/service.js'
import { answeringHealth, publishingHealth } from '../jobs/health.js'
import type { WorkerHealth } from '../jobs/worker.js'
import { errorFields, log } from '../log.js'
import { maxMediaBytes, readMedia, storeMedia } from '../media.js'
import { maxHistoryDays, readChannelMetrics } from '../channel-metrics.js'
import { readMetricHistory, readMetrics } from '../metrics.js'
import { readResponses, watchResponses } from '../responses.js'
import { cancelReply, listReplies, replySubmissionSchema, resolveReply, submitReply } from '../replies.js'
import { getConversation, listConversationMessages, listConversations, notifyMeta, requestConversationSync } from '../conversations.js'
import { cancelMessage, listOutgoingMessages, messageSubmissionSchema, resolveMessage, submitMessage } from '../messages.js'
import { connectWhatsAppNumber, readAttachment, receiveWhatsAppNotification, whatsappConnectSchema } from '../whatsapp.js'
import { outgoingMessageStates } from '../db/schema.js'
import { answeringPutSchema, getAnswering, putAnswering } from '../answering/settings.js'
import { ackDraftOutbox, listDraftOutbox } from '../answering/drafts.js'
import { reviseDraft, reviseSchema } from '../answering/revise.js'
import { deleteLearnedAnswer, deleteLearnedAnswers, learnedListQuery, learnedScopeQuery, learnedUpdateSchema, listLearnedAnswers,
  updateLearnedAnswer } from '../answering/learning.js'
import { checkBrowserLogin, listBrowserAccounts, startBrowserLogin } from '../vault.js'
import { createWebhook, deleteWebhook, listDeliveries, listWebhooks, redeliver, rotateWebhookSecret, testWebhook, updateWebhook, webhookCreateSchema,
  webhookUpdateSchema } from '../webhooks.js'

const maxJsonBytes = 1_000_000
/** Meta batches up to 1,000 updates in one notification; the dashboard takes at most 1 MiB. */
const maxNotificationBytes = 1_100_000
const organizationId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)
const settings = z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 10_000, 'settings too large')

export const submitSchema = z.strictObject({
  organizationId,
  postId: identifier,
  revision: z.number().int().positive(),
  approvedByUserId: identifier,
  approvedAt: z.iso.datetime({ offset: true }),
  publishAt: z.iso.datetime({ offset: true }),
  content: z.string().min(1).max(100_000),
  mediaIds: z.array(z.uuid()).max(10).default([]),
  channels: z.array(z.strictObject({ channelId: z.uuid(), settings: settings.default({}) })).min(1).max(20),
})

/** A comma-separated list of UUIDs in a query string. */
const uuidList = (max: number) => z.string().max(max * 37).transform(value => value.split(',')).pipe(z.array(z.uuid()).min(1).max(max))
const requestKey = z.string().regex(/^[0-9a-f]{64}$/)
const requestKeyList = (max: number) => z.string().max(max * 65).transform(value => value.split(',')).pipe(z.array(requestKey).min(1).max(max))

type Handler = (event: H3Event<EventHandlerRequest>) => Promise<unknown>

export function createEngineApp(context: EngineContext, serviceToken: string, options: { worker?: () => WorkerHealth } = {}) {
  const expected = digest(serviceToken)
  const router = createRouter()

  router.get('/healthz', defineEventHandler(() => ({ ok: true })))
  // 200 while the database answers (the orchestrator's check). `publishing`
  // and `answering` are for monitoring (docs/api.md). No tenant data.
  router.get('/readyz', route(async () => {
    await context.db.execute(sql`select 1`)
    return { ok: true, ...await publishingHealth(context, options.worker?.()), ...await answeringHealth(context) }
  }))

  router.post('/v1/connect/start', authed(async event => {
    const body = z.strictObject({ organizationId, providerAppId: identifier }).parse(await readJson(event))
    return startConnect(context, body.organizationId, body.providerAppId)
  }))
  router.post('/v1/connect/finish', authed(async event => {
    const body = z.strictObject({ organizationId, state: z.string().min(1).max(500), code: z.string().min(1).max(4_000) }).parse(await readJson(event))
    return finishConnect(context, body.organizationId, body.state, body.code)
  }))
  router.get('/v1/tenants/:org/channels', authed(async event => ({ channels: await listChannels(context, organizationId.parse(getRouterParam(event, 'org'))) })))
  router.post('/v1/tenants/:org/channels/:channel/disable', authed(async event => disableChannel(context,
    organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'channel')))))
  router.get('/v1/tenants/:org/publishing', authed(async event => readPublishing(context.db, organizationId.parse(getRouterParam(event, 'org')))))
  router.put('/v1/tenants/:org/publishing', authed(async event => {
    const body = z.strictObject({ paused: z.boolean(), pausedChannelIds: z.array(z.uuid()).max(1_000),
      maxPostsPerChannelPerDay: z.number().int().min(1).max(100).optional() }).parse(await readJson(event))
    return setPublishing(context, organizationId.parse(getRouterParam(event, 'org')), body.paused, body.pausedChannelIds, body.maxPostsPerChannelPerDay)
  }))
  router.post('/v1/tenants/:org/media', authed(async event => {
    const org = organizationId.parse(getRouterParam(event, 'org'))
    const name = z.string().min(1).max(255).regex(/^[^/\\\r\n]+$/).parse(getQuery(event).name)
    if (Number(getRequestHeader(event, 'content-length') ?? 0) > maxMediaBytes) throw new EngineError(413, 'too_large', 'Request body too large')
    setResponseStatus(event, 201)
    return storeMedia(context, org, name, String(getRequestHeader(event, 'content-type') ?? '').split(';')[0]!.trim(), event.node.req)
  }))
  // Bytes for the dashboard's signed public media route.
  router.get('/v1/tenants/:org/media/:media', authed(async event => {
    const file = await readMedia(context.db, organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'media')))
    setResponseHeaders(event, { 'content-type': file.mimeType, 'content-length': file.sizeBytes, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    // A failure part way through closes the connection, so the reader sees a short file.
    await pipeline(Readable.from(file.chunks()), event.node.res).catch(() => undefined)
  }))

  // Browser accounts: operator login flow. Secrets never pass through here.
  router.get('/v1/tenants/:org/browser-accounts', authed(async event => ({
    accounts: await listBrowserAccounts(context.db, organizationId.parse(getRouterParam(event, 'org'))),
  })))
  router.post('/v1/tenants/:org/browser-accounts/:account/login', authed(async event => startBrowserLogin(context,
    organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'account')))))
  router.get('/v1/tenants/:org/browser-accounts/:account/login/:action', authed(async event => checkBrowserLogin(context,
    organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'account')), z.uuid().parse(getRouterParam(event, 'action')))))

  router.post('/v1/jobs', authed(async event => {
    const result = await submitJobs(context, submitSchema.parse(await readJson(event)))
    setResponseStatus(event, result.created ? 201 : 200)
    return result
  }))
  router.post('/v1/jobs/cancel', authed(async event => {
    const body = z.strictObject({ organizationId, postId: identifier, revision: z.number().int().positive() }).parse(await readJson(event))
    return cancelJobs(context, body.organizationId, body.postId, body.revision)
  }))
  // Brings back jobs a pause cancelled, once publishing is no longer paused for their channel.
  router.post('/v1/jobs/restore', authed(async event => {
    const body = z.strictObject({ organizationId, postId: identifier, revision: z.number().int().positive() }).parse(await readJson(event))
    return restoreJobs(context, body.organizationId, body.postId, body.revision)
  }))
  router.get('/v1/jobs', authed(async event => {
    const query = z.object({ organizationId, postId: identifier }).parse(getQuery(event))
    return listJobs(context, query.organizationId, query.postId)
  }))
  // Latest numbers of published jobs, for the dashboard's post list.
  router.get('/v1/tenants/:org/metrics', authed(async event => {
    const query = z.object({ jobIds: z.string().max(4_000) }).parse(getQuery(event))
    const jobIds = z.array(z.uuid()).min(1).max(100).parse(query.jobIds.split(','))
    return { metrics: await readMetrics(context, organizationId.parse(getRouterParam(event, 'org')), jobIds) }
  }))
  // Sample history of published jobs, oldest first.
  router.get('/v1/tenants/:org/metrics/history', authed(async event => {
    const query = z.object({ jobIds: uuidList(20) }).parse(getQuery(event))
    return { history: await readMetricHistory(context, organizationId.parse(getRouterParam(event, 'org')), [...new Set(query.jobIds)]) }
  }))
  // Account numbers of the tenant's channels, with their history.
  router.get('/v1/tenants/:org/channel-metrics', authed(async event => {
    const query = z.object({ channelIds: uuidList(100).optional(), days: z.coerce.number().int().min(1).max(maxHistoryDays).default(30) }).parse(getQuery(event))
    return { channels: await readChannelMetrics(context, organizationId.parse(getRouterParam(event, 'org')), query.channelIds, query.days) }
  }))
  // Comments and replies on published posts, and how reading them goes.
  router.get('/v1/tenants/:org/responses', authed(async event => {
    const query = z.object({ jobIds: uuidList(50).optional(), after: z.string().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(getQuery(event))
    return readResponses(context, organizationId.parse(getRouterParam(event, 'org')),
      { jobIds: query.jobIds ? [...new Set(query.jobIds)] : undefined, after: query.after, limit: query.limit })
  }))
  router.post('/v1/tenants/:org/responses/watch', authed(async event => {
    const org = organizationId.parse(getRouterParam(event, 'org'))
    const body = z.strictObject({ jobIds: z.array(z.uuid()).min(1).max(20) }).parse(await readJson(event))
    return watchResponses(context, org, [...new Set(body.jobIds)])
  }))
  // Approved comment replies, keyed by request key so a cancel reaches a submission whose answer was lost.
  router.post('/v1/tenants/:org/replies', authed(async event => {
    const org = organizationId.parse(getRouterParam(event, 'org'))
    const result = await submitReply(context, org, replySubmissionSchema.parse(await readJson(event)))
    setResponseStatus(event, result.created ? 201 : 200)
    return { reply: result.reply }
  }))
  router.get('/v1/tenants/:org/replies', authed(async event => {
    const query = z.object({ requestKeys: requestKeyList(50) }).parse(getQuery(event))
    return { replies: await listReplies(context, organizationId.parse(getRouterParam(event, 'org')), [...new Set(query.requestKeys)]) }
  }))
  router.post('/v1/tenants/:org/replies/:key/cancel', authed(async event => {
    const org = organizationId.parse(getRouterParam(event, 'org'))
    return cancelReply(context, org, requestKey.parse(getRouterParam(event, 'key')))
  }))
  router.post('/v1/tenants/:org/replies/:key/resolve', authed(async event => {
    const org = organizationId.parse(getRouterParam(event, 'org'))
    const key = requestKey.parse(getRouterParam(event, 'key'))
    const body = z.strictObject({ outcome: z.enum(['sent', 'not_sent']) }).parse(await readJson(event))
    return resolveReply(context, org, key, body.outcome)
  }))
  // Direct messages: conversations read from Messenger and Instagram, and messages sent once, keyed by request key.
  const cursor = z.string().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/)
  router.get('/v1/tenants/:org/conversations', authed(async event => {
    const query = z.object({ channelId: z.uuid().optional(), after: cursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(getQuery(event))
    return listConversations(context, organizationId.parse(getRouterParam(event, 'org')), query)
  }))
  router.post('/v1/tenants/:org/conversations/sync', authed(async event => {
    const body = z.strictObject({ channelId: z.uuid().optional() }).parse(await readJson(event))
    return requestConversationSync(context, organizationId.parse(getRouterParam(event, 'org')), body.channelId)
  }))
  router.get('/v1/tenants/:org/conversations/:conversation', authed(async event => getConversation(context,
    organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'conversation')))))
  router.get('/v1/tenants/:org/conversations/:conversation/messages', authed(async event => {
    const query = z.object({ before: cursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(getQuery(event))
    return listConversationMessages(context, organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'conversation')), query)
  }))
  // From the dashboard's verified Meta webhook receiver: IDs only, across tenants. The channels are read again; nothing here is trusted.
  router.post('/v1/meta/notifications', authed(async event => {
    const body = z.strictObject({ objects: z.array(z.strictObject({ object: z.enum(['page', 'instagram']), id: z.string().regex(/^\d{1,30}$/) })).min(1).max(100) })
      .parse(await readJson(event))
    return notifyMeta(context, body.objects)
  }))
  // From the dashboard's Meta webhook receiver: a WhatsApp notification as Meta sent it, with Meta's signature, which the engine
  // checks with the app of each number it names before storing anything (ADR 0006). Not tenant-scoped.
  router.post('/v1/whatsapp/notifications', authed(async event => {
    if (!String(getRequestHeader(event, 'content-type') ?? '').startsWith('application/json')) throw new EngineError(415, 'unsupported_media_type', 'Expected application/json')
    const body = await readBody(event, maxNotificationBytes)
    return receiveWhatsAppNotification(context, body, getRequestHeader(event, 'x-hub-signature-256'))
  }))
  // The operator's manual WhatsApp connect: a token for one number of a business account.
  router.post('/v1/tenants/:org/whatsapp/numbers', authed(async event => {
    const result = await connectWhatsAppNumber(context, organizationId.parse(getRouterParam(event, 'org')), whatsappConnectSchema.parse(await readJson(event)))
    setResponseStatus(event, 201)
    return result
  }))
  // A received attachment's bytes, read from the platform on request (WhatsApp keeps media IDs, never URLs).
  router.get('/v1/tenants/:org/conversations/:conversation/messages/:message/attachments/:index', authed(async event => {
    const file = await readAttachment(context, organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'conversation')),
      z.uuid().parse(getRouterParam(event, 'message')), z.coerce.number().int().min(0).max(19).parse(getRouterParam(event, 'index')))
    setResponseHeaders(event, { 'content-type': file.mimeType, ...(file.sizeBytes !== null ? { 'content-length': file.sizeBytes } : {}), 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...(file.name ? { 'x-attachment-name': encodeURIComponent(file.name) } : {}) })
    // A failure part way through closes the connection, so the reader sees a short file.
    await pipeline(Readable.fromWeb(file.body as NodeReadableStream<Uint8Array>), event.node.res).catch(() => undefined)
  }))
  router.post('/v1/tenants/:org/messages', authed(async event => {
    const org = organizationId.parse(getRouterParam(event, 'org'))
    const result = await submitMessage(context, org, messageSubmissionSchema.parse(await readJson(event)))
    setResponseStatus(event, result.created ? 201 : 200)
    return { message: result.message }
  }))
  router.get('/v1/tenants/:org/messages', authed(async event => {
    // `requestKeys` comma-separated or repeated, like the replies list.
    const keys = z.union([z.string(), z.array(z.string()).max(100)]).optional()
      .transform(value => value === undefined ? undefined : [...new Set([value].flat().join(',').split(','))]).pipe(z.array(requestKey).min(1).max(100).optional())
    const query = z.object({ conversationId: z.uuid().optional(), state: z.enum(outgoingMessageStates).optional(), requestKeys: keys,
      limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(getQuery(event))
    return { messages: await listOutgoingMessages(context, organizationId.parse(getRouterParam(event, 'org')), query) }
  }))
  router.post('/v1/tenants/:org/messages/:key/cancel', authed(async event => cancelMessage(context,
    organizationId.parse(getRouterParam(event, 'org')), requestKey.parse(getRouterParam(event, 'key')))))
  router.post('/v1/tenants/:org/messages/:key/resolve', authed(async event => {
    const org = organizationId.parse(getRouterParam(event, 'org'))
    const key = requestKey.parse(getRouterParam(event, 'key'))
    const body = z.strictObject({ outcome: z.enum(['sent', 'not_sent']) }).parse(await readJson(event))
    return resolveMessage(context, org, key, body.outcome)
  }))
  // AI answers (ADR 0004): the tenant's answering settings, the draft outbox the dashboard pulls, and revisions a person asks for.
  router.get('/v1/tenants/:org/answering', authed(async event => getAnswering(context, organizationId.parse(getRouterParam(event, 'org')))))
  router.put('/v1/tenants/:org/answering', authed(async event => putAnswering(context, organizationId.parse(getRouterParam(event, 'org')),
    answeringPutSchema.parse(await readJson(event)))))
  router.get('/v1/drafts/outbox', authed(async event => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(getQuery(event))
    return listDraftOutbox(context, query.limit)
  }))
  router.post('/v1/drafts/outbox/ack', authed(async event => {
    const body = z.strictObject({ ids: z.array(z.uuid()).min(1).max(200) }).parse(await readJson(event))
    return ackDraftOutbox(context, [...new Set(body.ids)])
  }))
  router.post('/v1/tenants/:org/drafts/revise', authed(async event => reviseDraft(context, organizationId.parse(getRouterParam(event, 'org')),
    reviseSchema.parse(await readJson(event)))))
  // Webhooks: the tenant's endpoints, told of published posts, moving numbers and new comments.
  // Learned answers: what a person approved, reused for the same or similar items (ADR 0004).
  router.get('/v1/tenants/:org/learned-answers', authed(async event => listLearnedAnswers(context, organizationId.parse(getRouterParam(event, 'org')),
    learnedListQuery.parse(getQuery(event)))))
  router.delete('/v1/tenants/:org/learned-answers', authed(async event => deleteLearnedAnswers(context, organizationId.parse(getRouterParam(event, 'org')),
    learnedScopeQuery.parse(getQuery(event)))))
  router.patch('/v1/tenants/:org/learned-answers/:id', authed(async event => updateLearnedAnswer(context, organizationId.parse(getRouterParam(event, 'org')),
    z.uuid().parse(getRouterParam(event, 'id')), learnedUpdateSchema.parse(await readJson(event)))))
  router.delete('/v1/tenants/:org/learned-answers/:id', authed(async event => deleteLearnedAnswer(context, organizationId.parse(getRouterParam(event, 'org')),
    z.uuid().parse(getRouterParam(event, 'id')))))
  router.get('/v1/tenants/:org/webhooks', authed(async event => ({ webhooks: await listWebhooks(context, organizationId.parse(getRouterParam(event, 'org'))) })))
  router.post('/v1/tenants/:org/webhooks', authed(async event => {
    const org = organizationId.parse(getRouterParam(event, 'org'))
    const result = await createWebhook(context, org, webhookCreateSchema.parse(await readJson(event)))
    setResponseStatus(event, 201)
    return result
  }))
  router.patch('/v1/tenants/:org/webhooks/:webhook', authed(async event => ({ webhook: await updateWebhook(context,
    organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'webhook')), webhookUpdateSchema.parse(await readJson(event))) })))
  router.delete('/v1/tenants/:org/webhooks/:webhook', authed(async event => deleteWebhook(context,
    organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'webhook')))))
  router.post('/v1/tenants/:org/webhooks/:webhook/rotate-secret', authed(async event => rotateWebhookSecret(context,
    organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'webhook')))))
  router.post('/v1/tenants/:org/webhooks/:webhook/test', authed(async event => {
    const result = await testWebhook(context, organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'webhook')))
    setResponseStatus(event, 202)
    return result
  }))
  router.get('/v1/tenants/:org/webhooks/:webhook/deliveries', authed(async event => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), state: z.enum(['pending', 'delivered', 'failed']).optional() }).parse(getQuery(event))
    return { deliveries: await listDeliveries(context, organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'webhook')), query) }
  }))
  router.post('/v1/tenants/:org/webhooks/:webhook/deliveries/:delivery/redeliver', authed(async event => redeliver(context,
    organizationId.parse(getRouterParam(event, 'org')), z.uuid().parse(getRouterParam(event, 'webhook')), z.uuid().parse(getRouterParam(event, 'delivery')))))
  router.post('/v1/jobs/:id/resolve', authed(async event => resolveJob(context, z.uuid().parse(getRouterParam(event, 'id')),
    resolveJobSchema.parse(await readJson(event)))))
  router.post('/v1/jobs/:id/reconcile', authed(async event => {
    const body = z.strictObject({ organizationId }).parse(await readJson(event))
    return reconcileJob(context, body.organizationId, z.uuid().parse(getRouterParam(event, 'id')))
  }))

  const app = createApp()
  app.use(router)
  app.use(defineEventHandler(event => respond(event, 404, { error: 'not_found', message: 'Route not found' })))
  return app

  function authed(handler: Handler) {
    return route(async event => {
      const header = getRequestHeader(event, 'authorization') ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!timingSafeEqual(digest(token), expected)) throw new EngineError(401, 'unauthorized', 'Invalid service token')
      return handler(event)
    })
  }
}

function route(handler: Handler) {
  return defineEventHandler(async event => {
    try {
      return await handler(event)
    } catch (error) {
      if (error instanceof EngineError) return respond(event, error.status, { error: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) })
      if (error instanceof ZodError) return respond(event, 400, { error: 'invalid_request', message: 'Invalid request', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) })
      log('error', 'request failed', { method: event.method, path: event.path.split('?')[0], ...errorFields(error) })
      return respond(event, 500, { error: 'internal', message: 'Internal error' })
    }
  })
}

function respond(event: H3Event<EventHandlerRequest>, status: number, body: Record<string, unknown>) {
  setResponseStatus(event, status)
  return body
}

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

async function readBody(event: H3Event<EventHandlerRequest>, limit: number) {
  const length = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isInteger(length) || length < 0) throw new EngineError(411, 'length_required', 'Content-Length is required')
  if (length > limit) throw new EngineError(413, 'too_large', 'Request body too large')
  const raw = await readRawBody(event, false)
  const data = raw ? Buffer.from(raw) : Buffer.alloc(0)
  if (data.length > limit) throw new EngineError(413, 'too_large', 'Request body too large')
  return data
}

async function readJson(event: H3Event<EventHandlerRequest>): Promise<unknown> {
  if (!String(getRequestHeader(event, 'content-type') ?? '').startsWith('application/json')) throw new EngineError(415, 'unsupported_media_type', 'Expected application/json')
  const data = await readBody(event, maxJsonBytes)
  try { return JSON.parse(data.toString('utf8')) as unknown } catch { throw new EngineError(400, 'invalid_json', 'Invalid JSON') }
}
