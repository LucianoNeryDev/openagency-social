import { z } from 'zod'
import type { ChannelKind } from '../../db/schema.js'
import { invalid } from '../../errors.js'
import { GraphClient, GraphError, spendAfterFirst, type GraphOptions } from '../meta/graph.js'
import { instagramActivity } from '../meta/activity.js'
import { InstagramPublisher, validateInstagram, type ContainerPoll } from '../meta/instagram.js'
import { guardRateLimit, watchUsage } from '../meta/classify.js'
import { instagramAccountMetrics, instagramMediaMetrics } from '../meta/metrics.js'
import { findDirectMessage, readConversationMessages, readConversations, sendDirectMessage } from '../meta/messages.js'
import { instagramFindReply, instagramReply } from '../meta/replies.js'
import { instagramResponses } from '../meta/responses.js'
import {
  ReauthRequired, type AccountActivityInput, type AccountActivityResult, type AccountMetricsInput, type AccountMetricsResult, type ChannelCredential, type ChannelLimits, type ConnectedAccount,
  type ConversationMessagesInput, type ConversationsInput, type ConversationsResult, type FindMessageInput, type FindReplyInput, type FindReplyOutcome,
  type MediaInfo, type MessageRules, type PlatformAdapter, type PlatformMessage, type MetricsInput, type MetricsResult, type PublishInput,
  type PublishOutcome, type ReconcileInput, type ReconcileOutcome, type ReplyInput, type ReplyOutcome, type ResolvedProviderApp, type ResponsesInput,
  type ResponsesResult, type SendMessageInput, type SendMessageOutcome, type ChannelTarget,
} from '../types.js'

export const defaultInstagramScopes = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights',
  'instagram_business_manage_comments']

/** Granted permissions: a comma-separated string in the reference, an array in some answers. */
const permissionsSchema = z.union([z.string().max(2_000).transform(value => value.split(',').map(scope => scope.trim()).filter(Boolean)),
  z.array(z.string().max(100)).max(100)]).optional()
const shortTokenFields = z.object({ access_token: z.string().min(1), user_id: z.union([z.string(), z.number()]).optional(), permissions: permissionsSchema })
/** The reference wraps the code exchange's answer in `data`; the token endpoint has also answered without it. */
const shortTokenSchema = z.union([shortTokenFields, z.object({ data: z.array(shortTokenFields).min(1).max(1) }).transform(value => value.data[0]!)])
const longTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() })
const meSchema = z.object({ user_id: z.union([z.string(), z.number()]).transform(String), username: z.string().max(100).optional() })

/** Direct messages with Instagram's own login: at most 1,000 UTF-8 bytes of text. */
const instagramMessageRules: MessageRules = { platform: 'instagram', permission: 'instagram_business_manage_messages', maxLength: 1_000, unit: 'bytes' }

/** Long-lived tokens last 60 days; renew them with plenty of margin. */
const refreshBeforeMs = 10 * 86_400_000

/**
 * Instagram professional accounts connected with Instagram's own login,
 * without a Facebook Page. Publishing is the same container flow as for
 * Page-linked accounts, on graph.instagram.com and with a 60-day token that
 * is renewed before it lapses.
 */
export class InstagramLoginAdapter implements PlatformAdapter {
  readonly platform = 'instagram' as const
  readonly refreshBeforeMs = refreshBeforeMs
  readonly keepAlive = true
  private readonly graph: GraphClient
  private readonly publisher: InstagramPublisher
  private readonly fetcher: typeof fetch

  constructor(private readonly options: GraphOptions & { redirectUri?: string, containerPoll?: ContainerPoll }) {
    this.graph = new GraphClient({ ...options, host: 'graph.instagram.com' })
    this.fetcher = options.fetch ?? fetch
    const poll = options.containerPoll
    this.publisher = new InstagramPublisher(this.graph, poll ? { image: poll, video: poll } : {})
  }

  authorizeUrl(app: ResolvedProviderApp, state: string) {
    if (!this.options.redirectUri) throw invalid('unsupported_channel', 'Instagram login is not configured on this engine')
    const url = new URL('https://www.instagram.com/oauth/authorize')
    url.searchParams.set('client_id', app.externalAppId)
    url.searchParams.set('redirect_uri', this.options.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', (app.settings.scopes ?? defaultInstagramScopes).join(','))
    url.searchParams.set('state', state)
    return url.href
  }

  async finishConnect(app: ResolvedProviderApp, code: string): Promise<ConnectedAccount[]> {
    if (!this.options.redirectUri) throw invalid('unsupported_channel', 'Instagram login is not configured on this engine')
    // The code exchange lives on api.instagram.com, outside the Graph host.
    const response = await this.fetcher('https://api.instagram.com/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ client_id: app.externalAppId, client_secret: app.secret, grant_type: 'authorization_code',
        redirect_uri: this.options.redirectUri, code }),
    })
    if (!response.ok) throw invalid('invalid_state', 'Instagram refused the authorization code')
    const short = shortTokenSchema.parse(await response.json())
    const long = longTokenSchema.parse(await this.graph.request('GET', '/access_token', { unversioned: true,
      query: { grant_type: 'ig_exchange_token', client_secret: app.secret, access_token: short.access_token },
    }))
    const me = meSchema.parse(await this.graph.request('GET', '/me', { token: long.access_token, query: { fields: 'user_id,username' } }))
    return [{ kind: 'instagram_account', externalId: me.user_id, name: me.username ? `@${me.username}` : 'Instagram',
      token: long.access_token, tokenExpiresAt: new Date(Date.now() + long.expires_in * 1000), ...(short.permissions ? { grantedScopes: short.permissions } : {}) }]
  }

  async refreshCredential(_app: ResolvedProviderApp, credential: ChannelCredential): Promise<ChannelCredential> {
    try {
      const renewed = longTokenSchema.parse(await this.graph.request('GET', '/refresh_access_token', { unversioned: true,
        query: { grant_type: 'ig_refresh_token', access_token: credential.accessToken },
      }))
      return { accessToken: renewed.access_token, expiresAt: new Date(Date.now() + renewed.expires_in * 1000) }
    } catch (error) {
      // 190: the token expired or was revoked; only a new login brings it back.
      if (error instanceof GraphError && error.failure.kind === 'http' && error.failure.code === 190) throw new ReauthRequired('Instagram token expired or revoked')
      throw error
    }
  }

  limits(): ChannelLimits {
    return { maxLength: 2_200, maxMedia: 10 }
  }

  validateSettings(kind: ChannelKind, settings: Record<string, unknown>, media: MediaInfo[]) {
    if (kind !== 'instagram_account') throw invalid('unsupported_channel', 'Not an Instagram channel')
    validateInstagram(settings, media)
  }

  async publish(_app: ResolvedProviderApp | null, input: PublishInput): Promise<PublishOutcome> {
    return this.publisher.publish({ token: input.token }, input)
  }

  async checkCredential(_app: ResolvedProviderApp | null, input: { channel: ChannelTarget, token: string, spendCall?: () => void }) {
    await guardRateLimit(() => this.graph.request('GET', '/me', { token: input.token, query: { fields: 'id' }, ...spendAfterFirst(input.spendCall) }))
  }

  async reconcile(_app: ResolvedProviderApp | null, input: ReconcileInput): Promise<ReconcileOutcome> {
    return this.publisher.reconcile({ token: input.token }, input)
  }

  async metrics(_app: ResolvedProviderApp | null, input: MetricsInput): Promise<MetricsResult> {
    return guardRateLimit(() => instagramMediaMetrics(this.graph, { token: input.token, ...spendAfterFirst(input.spendCall), ...watchUsage(input.slowDown) }, input.externalId))
  }

  async accountMetrics(_app: ResolvedProviderApp | null, input: AccountMetricsInput): Promise<AccountMetricsResult> {
    return guardRateLimit(() => instagramAccountMetrics(this.graph, { token: input.token, ...spendAfterFirst(input.spendCall), ...watchUsage(input.slowDown) }, input.channel.externalId,
      input.now ?? new Date()))
  }

  async accountActivity(_app: ResolvedProviderApp | null, input: AccountActivityInput): Promise<AccountActivityResult> {
    return guardRateLimit(() => instagramActivity(this.graph, { token: input.token, ...spendAfterFirst(input.spendCall), ...watchUsage(input.slowDown) }, input.channel.externalId, { login: true }))
  }

  async responses(_app: ResolvedProviderApp | null, input: ResponsesInput): Promise<ResponsesResult> {
    return guardRateLimit(() => instagramResponses(this.graph, { token: input.token, ...watchUsage(input.slowDown) }, input, 'instagram_business_manage_comments'))
  }

  replyRules(kind: ChannelKind) {
    // Instagram does not document a comment's maximum length; 2,200 is the caption's.
    return kind === 'instagram_account' ? { permission: 'instagram_business_manage_comments', maxLength: 2_200 } : null
  }

  async reply(_app: ResolvedProviderApp | null, input: ReplyInput): Promise<ReplyOutcome> {
    return instagramReply(this.graph, { token: input.token }, input, 'instagram_business_manage_comments')
  }

  async findReply(_app: ResolvedProviderApp | null, input: FindReplyInput): Promise<FindReplyOutcome> {
    return guardRateLimit(() => instagramFindReply(this.graph, { token: input.token }, input))
  }

  messageRules(kind: ChannelKind) {
    return kind === 'instagram_account' ? instagramMessageRules : null
  }

  async conversations(_app: ResolvedProviderApp | null, input: ConversationsInput): Promise<ConversationsResult> {
    return guardRateLimit(() => readConversations(this.graph, { token: input.token },
      { path: '/me/conversations', platform: 'instagram', channel: input.channel, permission: instagramMessageRules.permission }))
  }

  async conversationMessages(_app: ResolvedProviderApp | null, input: ConversationMessagesInput): Promise<PlatformMessage[]> {
    return guardRateLimit(() => readConversationMessages(this.graph, { token: input.token }, input))
  }

  async sendMessage(_app: ResolvedProviderApp | null, input: SendMessageInput): Promise<SendMessageOutcome> {
    return sendDirectMessage(this.graph, { token: input.token },
      { path: '/me/messages', recipientExternalId: input.recipientExternalId, text: input.text, permission: instagramMessageRules.permission })
  }

  async findMessage(_app: ResolvedProviderApp | null, input: FindMessageInput): Promise<FindReplyOutcome> {
    return guardRateLimit(() => findDirectMessage(this.graph, { token: input.token }, input))
  }
}
