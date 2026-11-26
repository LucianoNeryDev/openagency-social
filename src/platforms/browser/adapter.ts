import type { ChannelKind } from '../../db/schema.js'
import { invalid } from '../../errors.js'
import type { ChannelLimits, MediaInfo, PlatformAdapter, PublishInput, PublishOutcome, ReconcileInput, ReconcileOutcome } from '../types.js'
import type { BrowserRules } from './rules.js'
import { RunnerError, type RunnerAction, type RunnerClient } from './runner-client.js'

/**
 * A platform driven through the browser runner. The runner marks
 * the click that posts; before it every failure is definite, after it a
 * missing confirmation is uncertain. A human takeover keeps the attempt alive
 * through heartbeats for up to `maxWaitMs`.
 */
export class BrowserAdapter implements PlatformAdapter {
  readonly platform: BrowserRules['platform']

  constructor(private readonly runner: RunnerClient, private readonly rules: BrowserRules, private readonly options: { pollMs?: number, maxWaitMs?: number } = {}) {
    this.platform = rules.platform
  }

  authorizeUrl(): string {
    throw invalid('unsupported_channel', `${this.rules.label} accounts are added through the vault, not OAuth`)
  }

  async finishConnect(): Promise<never> {
    throw invalid('unsupported_channel', `${this.rules.label} accounts are added through the vault, not OAuth`)
  }

  limits(): ChannelLimits {
    return this.rules.limits
  }

  validateSettings(kind: ChannelKind, settings: Record<string, unknown>, media: MediaInfo[]) {
    if (!this.rules.kinds.includes(kind)) throw invalid('unsupported_channel', `Wrong channel kind for ${this.rules.label}`)
    const parsed = this.rules.settings.safeParse(settings)
    if (!parsed.success) {
      const fields = parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean)
      throw invalid('invalid_settings', fields.length ? `Invalid ${this.rules.label} settings: ${[...new Set(fields)].join(', ')}` : `${this.rules.label} takes no channel settings`)
    }
    this.rules.media(media)
  }

  async publish(_app: unknown, input: PublishInput): Promise<PublishOutcome> {
    const account = input.browserAccount
    if (!account) return { kind: 'failed', retryable: false, code: 'missing_account', detail: 'No browser account on this channel' }
    const media = input.media.map(file => ({ url: file.publicUrl, mimeType: file.mimeType }))
    if (media.some(file => !file.url)) return { kind: 'failed', retryable: false, code: 'public_media_unavailable', detail: 'PUBLIC_MEDIA_URL is not configured' }
    const settings = this.rules.settings.safeParse(input.settings)
    if (!settings.success) return { kind: 'failed', retryable: false, code: 'invalid_settings', detail: `Invalid ${this.rules.label} settings` }

    let action: RunnerAction
    // Once submitted, the runner may click post at any time.
    await input.beforeVisible?.()
    try {
      action = await this.runner.submit({
        actionId: input.attemptId, kind: 'publish_post', content: input.content, media,
        target: { kind: input.channel.kind, externalId: input.channel.externalId }, settings: settings.data,
        account: { id: account.id, platform: this.platform, handle: account.handle, sealed: {
          ephemeralPublicKey: account.sealed.ephemeralPublicKey.toString('base64'),
          nonce: account.sealed.nonce.toString('base64'), ciphertext: account.sealed.ciphertext.toString('base64') } },
      })
    } catch (error) {
      // A lost submission may be queued on the runner, so it is never resent blindly.
      if (error instanceof RunnerError && error.kind === 'unreachable') return { kind: 'failed', retryable: true, code: 'runner_unreachable', detail: error.message }
      if (error instanceof RunnerError && error.kind === 'rejected') return { kind: 'failed', retryable: false, code: 'runner_rejected', detail: error.message }
      return { kind: 'uncertain', code: 'runner_lost', detail: error instanceof Error ? error.message : 'Runner submission lost' }
    }

    const deadline = Date.now() + (this.options.maxWaitMs ?? 2 * 60 * 60_000)
    while (!['succeeded', 'failed', 'uncertain', 'cancelled'].includes(action.state)) {
      if (Date.now() > deadline) return { kind: 'uncertain', code: 'runner_timeout', detail: `Runner action ${action.id} still ${action.state}` }
      await input.heartbeat?.()
      await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 5_000))
      try {
        action = await this.runner.get(action.id)
      } catch {
        // Keep waiting; the runner holds the outcome.
      }
    }
    return outcome(action)
  }

  async reconcile(_app: unknown, input: ReconcileInput): Promise<ReconcileOutcome> {
    const action = await this.runner.find(input.attemptId)
    if (!action) return { kind: 'not_found' }
    const settled = outcome(action)
    if (settled.kind === 'published') return { kind: 'published', externalId: settled.externalId, ...(settled.url ? { url: settled.url } : {}) }
    if (settled.kind === 'failed') return { kind: 'not_found' }
    return { kind: 'ambiguous', detail: `Runner action ${action.id} is ${action.state}${action.error ? ` (${action.error.code})` : ''}` }
  }
}

function outcome(action: RunnerAction): PublishOutcome {
  if (action.state === 'succeeded') {
    // Without a scraped ID the runner's action ID is the receipt; reconcile can read it again.
    return { kind: 'published', externalId: action.receipt?.externalId ?? `runner:${action.id}`, ...(action.receipt?.url ? { url: action.receipt.url } : {}) }
  }
  const detail = `${action.error?.code ?? action.state}: ${action.error?.detail ?? ''}`.slice(0, 500)
  if (action.state === 'failed' || action.state === 'cancelled') {
    // Both stop before anything reaches the platform, and pass: a restart, or the media not reaching the runner (a network blip on the runner host).
    return { kind: 'failed', retryable: ['runner_restarted', 'media_download_failed'].includes(action.error?.code ?? ''), code: action.error?.code ?? action.state, detail }
  }
  return { kind: 'uncertain', code: action.error?.code ?? 'runner_uncertain', detail }
}
