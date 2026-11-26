import { createServer } from 'node:http'
import { toNodeListener } from 'h3'
import { loadConfig } from './config.js'
import type { EngineContext } from './context.js'
import type { Platform } from './db/schema.js'
import type { PlatformAdapter } from './platforms/types.js'
import { createDatabase } from './db/client.js'
import { createEngineApp } from './http/app.js'
import { Worker } from './jobs/worker.js'
import { checkPublicMediaUrl, publicMediaKey } from './media.js'
import { errorFields, log, registerLogSecrets } from './log.js'
import { RunnerClient } from './platforms/browser/runner-client.js'
import { BrowserAdapter } from './platforms/browser/adapter.js'
import { browserRules } from './platforms/browser/rules.js'
import { InstagramLoginAdapter } from './platforms/instagram/adapter.js'
import { MetaAdapter } from './platforms/meta/adapter.js'
import { WhatsAppAdapter } from './platforms/whatsapp/adapter.js'
import { YoutubeAdapter } from './platforms/youtube/adapter.js'
import { LiquidDecisionModel } from './answering/decision.js'
import { AnthropicDraftModel } from './answering/drafting.js'
import { ControlEventSender, controlEventKey, enableControlEvents } from './control-events.js'

const config = loadConfig()
// Before anything can queue one: without a control plane URL no event rows are written.
enableControlEvents(Boolean(config.controlPlaneEventsUrl))
registerLogSecrets([config.serviceToken, ...config.providerSecrets.values(), ...(config.runner ? [config.runner.token] : []),
  ...(config.anthropicApiKey ? [config.anthropicApiKey] : []), ...(config.liquidApiKey ? [config.liquidApiKey] : [])])
const { db, pool } = createDatabase(config.databaseUrl)
const runner = config.runner ? new RunnerClient(config.runner) : undefined
const context: EngineContext = {
  db,
  ...(runner ? { runner } : {}),
  keyring: config.keyring,
  providerSecrets: config.providerSecrets,
  adapters: new Map<Platform, PlatformAdapter>([
    ['meta', new MetaAdapter({ version: config.meta.graphVersion, redirectUri: config.meta.redirectUri })],
    ['instagram', new InstagramLoginAdapter({ version: config.meta.graphVersion, ...(config.instagram.redirectUri ? { redirectUri: config.instagram.redirectUri } : {}) })],
    // WhatsApp numbers connect through the same Login for Business callback as Pages.
    ['whatsapp', new WhatsAppAdapter({ version: config.meta.graphVersion, redirectUri: config.meta.redirectUri })],
    ['youtube', new YoutubeAdapter(config.google.redirectUri ? { redirectUri: config.google.redirectUri } : {})],
    ...(runner ? Object.values(browserRules).map(rules => [rules.platform, new BrowserAdapter(runner, rules)] as const) : []),
  ]),
  ...(config.liquidApiKey ? { decisionModel: new LiquidDecisionModel({ apiKey: config.liquidApiKey }) } : {}),
  ...(config.anthropicApiKey ? { draftModel: new AnthropicDraftModel({ apiKey: config.anthropicApiKey }) } : {}),
  ...(config.publicMediaUrl ? { publicMedia: { baseUrl: config.publicMediaUrl, key: publicMediaKey(config.serviceToken), lifetimeMs: 60 * 60_000 } } : {}),
}

void checkPublicMediaUrl(config.publicMediaUrl)
const worker = new Worker(context, config.worker)
const server = createServer(toNodeListener(createEngineApp(context, config.serviceToken, { worker: () => worker.health() })))
// Long enough for the largest video; only the dashboard API reaches this port.
server.requestTimeout = 15 * 60_000
server.headersTimeout = 10_000
server.listen(config.port, config.host, () => log('info', 'engine listening', { host: config.host, port: config.port }))

if (config.worker.enabled) worker.start()
// Events to the control plane, after the commits that queued them (ADR 0005).
const controlEvents = config.controlPlaneEventsUrl
  ? new ControlEventSender(context, { url: config.controlPlaneEventsUrl, key: controlEventKey(config.serviceToken) }) : undefined
controlEvents?.start()
log('info', 'answering', { decisionModel: Boolean(context.decisionModel), draftModel: Boolean(context.draftModel), controlEvents: Boolean(controlEvents) })

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log('info', 'shutting down', { signal, graceMs: config.worker.shutdownGraceMs })
  server.close()
  await worker.stop(config.worker.shutdownGraceMs)
  await controlEvents?.stop()
  await pool.end()
  process.exit(0)
}
process.on('SIGTERM', signal => void shutdown(signal))
process.on('SIGINT', signal => void shutdown(signal))
process.on('unhandledRejection', error => log('error', 'unhandled rejection', errorFields(error)))
