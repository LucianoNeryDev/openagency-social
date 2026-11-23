import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { toNodeListener } from 'h3'
import { z } from 'zod'
import { errorFields, log, registerLogSecrets } from '../log.js'
import { ActionStore } from './actions.js'
import { Profiles } from './browser.js'
import { Executor } from './executor.js'
import { createRunnerApp } from './http.js'
import { downloadMedia } from './media.js'
import { linkedinScripts } from './scripts/linkedin.js'
import { pinterestScripts } from './scripts/pinterest.js'
import { redditScripts } from './scripts/reddit.js'
import { threadsScripts } from './scripts/threads.js'
import { tiktokScripts } from './scripts/tiktok.js'
import { xScripts } from './scripts/x.js'

const singleLine = z.string().min(1).refine(value => !/[\r\n]/.test(value))
const config = z.object({
  // A private address only the engine can reach (loopback by default).
  RUNNER_HOST: z.string().default('127.0.0.1'),
  RUNNER_PORT: z.coerce.number().int().min(1).max(65_535).default(3430),
  RUNNER_TOKEN: singleLine.refine(value => value.length >= 32),
  RUNNER_PRIVATE_KEY: singleLine,
  // Browser profiles and actions.json; a persistent volume.
  RUNNER_DATA_DIR: z.string().min(1).default('/var/lib/openagency-social-runner'),
  RUNNER_NTFY_URL: z.url({ protocol: /^https$/ }).optional(),
  CHROMIUM_PATH: z.string().optional(),
}).parse(process.env)
registerLogSecrets([config.RUNNER_TOKEN, config.RUNNER_PRIVATE_KEY])
const dataDir = config.RUNNER_DATA_DIR

mkdirSync(join(dataDir, 'profiles'), { recursive: true, mode: 0o700 })
const store = new ActionStore(join(dataDir, 'actions.json'))
const profiles = new Profiles(join(dataDir, 'profiles'), config.CHROMIUM_PATH)
const executor = new Executor({
  store,
  runnerPrivateKey: config.RUNNER_PRIVATE_KEY,
  scripts: { tiktok: tiktokScripts(profiles), x: xScripts(profiles), linkedin: linkedinScripts(profiles),
    threads: threadsScripts(profiles), pinterest: pinterestScripts(profiles), reddit: redditScripts(profiles) },
  download: action => downloadMedia(action),
  // An ntfy topic. Never carries credentials or screenshots.
  notify: async (message) => {
    if (!config.RUNNER_NTFY_URL) return
    await fetch(config.RUNNER_NTFY_URL, { method: 'POST', body: message, signal: AbortSignal.timeout(10_000) })
  },
})
const wake = () => void executor.tick().catch(error => log('error', 'runner tick failed', errorFields(error)))
const timer = setInterval(wake, 2_000)

const server = createServer(toNodeListener(createRunnerApp(store, config.RUNNER_TOKEN, wake)))
server.requestTimeout = 30_000
server.listen(config.RUNNER_PORT, config.RUNNER_HOST, () => log('info', 'runner listening', { host: config.RUNNER_HOST, port: config.RUNNER_PORT }))

async function shutdown(signal: string) {
  log('info', 'runner shutting down', { signal })
  clearInterval(timer)
  server.close()
  await profiles.close()
  process.exit(0)
}
process.on('SIGTERM', signal => void shutdown(signal))
process.on('SIGINT', signal => void shutdown(signal))
process.on('unhandledRejection', error => log('error', 'unhandled rejection', errorFields(error)))
