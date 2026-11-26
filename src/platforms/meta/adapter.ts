import { z } from 'zod'
import type { ChannelKind } from '../../db/schema.js'
import { invalid } from '../../errors.js'
import { mediaFileBytes } from '../../media.js'
import type {
  AccountActivityInput, AccountActivityResult, AccountMetricsInput, AccountMetricsResult, ChannelLimits, ConnectedAccount, ConversationMessagesInput, ConversationsInput,
  ConversationsResult, FindMessageInput, FindReplyInput, FindReplyOutcome, MediaInfo, MessageRules, MetricsInput, MetricsResult, PlatformAdapter, PlatformMessage,
  PublishInput, PublishOutcome, ReconcileInput, ReconcileOutcome, ReplyInput, ReplyOutcome, ReplyRules, ReplyTargetInput, ReplyTargetOutcome, ResolvedProviderApp,
  ResponsesInput, ResponsesResult, SendMessageInput, SendMessageOutcome,
} from '../types.js'
import { classify, guardRateLimit } from './classify.js'
import { GraphClient, spendAfterFirst, type GraphOptions } from './graph.js'
import { facebookActivity, instagramActivity } from './activity.js'
import { InstagramPublisher, validateInstagram, type ContainerPoll } from './instagram.js'
import { findDirectMessage, readConversationMessages, readConversations, sendDirectMessage } from './messages.js'
import { facebookPageMetrics, facebookPostMetrics, instagramAccountMetrics, instagramMediaMetrics } from './metrics.js'
import { facebookFindReply, facebookReply, facebookThreadTop, instagramFindReply, instagramReply } from './replies.js'
import { facebookResponses, instagramResponses } from './responses.js'

export { classify } from './classify.js'

export const defaultMetaScopes = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement',
  'read_insights', 'business_management', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights']

/** Replying needs these, per channel kind. Facebook's limit is not documented by Meta; 8,000 is the comment box's. */
const metaReplyRules: Partial<Record<ChannelKind, ReplyRules>> = {
  // Facebook threads nest deeper than one level: a thread's top may be older than the stored responses.
  facebook_page: { permission: 'pages_manage_engagement', maxLength: 8_000, deepThreads: true },
  instagram_account: { permission: 'instagram_manage_comments', maxLength: 2_200 },
}

/**
 * Direct messages. Messenger's text limit is not documented; the
 * engine allows 2,000 characters. Instagram's is 1,000 UTF-8 bytes.
 */
const metaMessageRules: Partial<Record<ChannelKind, MessageRules>> = {
  facebook_page: { platform: 'messenger', permission: 'pages_messaging', maxLength: 2_000, unit: 'characters' },
  instagram_account: { platform: 'instagram', permission: 'instagram_manage_messages', maxLength: 1_000, unit: 'bytes' },
}

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().optional() })
const pagesSchema = z.object({
  data: z.array(z.object({
    id: z.string().regex(/^\d+$/),
    name: z.string().max(1000),
    access_token: z.string().min(1).optional(),
    tasks: z.array(z.string()).optional(),
    instagram_business_account: z.object({ id: z.string().regex(/^\d+$/), username: z.string().max(100).optional() }).optional(),
  })).max(100),
  paging: z.object({ cursors: z.object({ after: z.string().optional() }).optional(), next: z.string().optional() }).optional(),
})
const pageSchema = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string().max(1000),
  access_token: z.string().min(1).optional(),
  instagram_business_account: z.object({ id: z.string().regex(/^\d+$/), username: z.string().max(100).optional() }).optional(),
})
const debugTokenSchema = z.object({ data: z.object({
  scopes: z.array(z.string().max(100)).max(200).optional(),
  granular_scopes: z.array(z.object({ scope: z.string(), target_ids: z.array(z.string().regex(/^\d+$/)).max(1000).optional() })).max(100).optional(),
}) })
const createdSchema = z.object({ id: z.string().regex(/^[\d_]+$/) })
const feedSchema = z.object({
  data: z.array(z.object({ id: z.string(), message: z.string().optional(), created_time: z.string().optional(), permalink_url: z.string().optional() })).max(100),
})
const facebookSettingsSchema = z.strictObject({
  // Creates a hidden Page post. Used for end-to-end tests on real Pages.
  unpublished: z.boolean().optional(),
  // Shared link with Facebook's preview card. Not combinable with photos.
  link: z.url({ protocol: /^https$/ }).max(2_000).optional(),
})

export class MetaAdapter implements PlatformAdapter {
  readonly platform = 'meta' as const
  private readonly graph: GraphClient
  private readonly instagram: InstagramPublisher

  constructor(private readonly options: GraphOptions & { redirectUri: string, containerPoll?: ContainerPoll }) {
    this.graph = new GraphClient(options)
    const poll = options.containerPoll
    this.instagram = new InstagramPublisher(this.graph, poll ? { image: poll, video: poll } : {})
  }

  authorizeUrl(app: ResolvedProviderApp, state: string) {
    const url = new URL(`https://www.facebook.com/${this.options.version}/dialog/oauth`)
    url.searchParams.set('client_id', app.externalAppId)
    url.searchParams.set('redirect_uri', this.options.redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('response_type', 'code')
    if (app.settings.configId) url.searchParams.set('config_id', app.settings.configId)
    else url.searchParams.set('scope', (app.settings.scopes ?? defaultMetaScopes).join(','))
    return url.href
  }

  async finishConnect(app: ResolvedProviderApp, code: string): Promise<ConnectedAccount[]> {
    const short = tokenSchema.parse(await this.graph.request('GET', '/oauth/access_token', { appSecret: app.secret, query: {
      client_id: app.externalAppId, client_secret: app.secret, redirect_uri: this.options.redirectUri, code,
    } }))
    const long = tokenSchema.parse(await this.graph.request('GET', '/oauth/access_token', { appSecret: app.secret, query: {
      grant_type: 'fb_exchange_token', client_id: app.externalAppId, client_secret: app.secret, fb_exchange_token: short.access_token,
    } }))
    const accounts: ConnectedAccount[] = []
    let after: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = pagesSchema.parse(await this.graph.request('GET', '/me/accounts', { token: long.access_token, appSecret: app.secret, query: {
        fields: 'id,name,access_token,tasks,instagram_business_account{id,username}', limit: '100', ...(after ? { after } : {}),
      } }))
      for (const value of result.data) {
        // Page tokens derived from a long-lived user token do not expire.
        if (value.access_token && value.tasks?.includes('CREATE_CONTENT')) pushPage(accounts, value, value.access_token)
      }
      after = result.paging?.next ? result.paging.cursors?.after : undefined
      if (!after) break
    }
    // Login for Business may leave /me/accounts empty, for example once a Page
    // belongs to a business portfolio. The grant still names the Pages the
    // user chose for publishing; read those directly.
    const listed = new Set(accounts.filter(account => account.kind === 'facebook_page').map(account => account.externalId))
    const debug = debugTokenSchema.parse(await this.graph.request('GET', '/debug_token', {
      token: `${app.externalAppId}|${app.secret}`, query: { input_token: long.access_token },
    }))
    const granted = debug.data.granular_scopes?.find(scope => scope.scope === 'pages_manage_posts')?.target_ids ?? []
    for (const id of granted.filter(value => !listed.has(value)).slice(0, 100)) {
      const value = pageSchema.parse(await this.graph.request('GET', `/${id}`, { token: long.access_token, appSecret: app.secret, query: {
        fields: 'id,name,access_token,instagram_business_account{id,username}',
      } }))
      if (value.access_token) pushPage(accounts, value, value.access_token)
    }
    // Page tokens carry the user's grant: its scopes, narrowed per account where Meta names the targets.
    const scoped = debug.data.scopes ? accounts.map(account => ({ ...account, grantedScopes: accountScopes(debug.data, account) })) : accounts
    await this.subscribeMessaging(app, scoped)
    return scoped
  }

  /**
   * Meta sends a Page's message webhooks only once the Page subscribes the
   * app. Best effort: a refusal leaves the connect intact, and the 30-minute
   * sync still reads the conversations.
   */
  private async subscribeMessaging(app: ResolvedProviderApp, accounts: ConnectedAccount[]) {
    const pages = accounts.filter(account => account.kind === 'facebook_page')
    for (const page of pages) {
      const linked = accounts.filter(account => account.kind === 'instagram_account' && account.token === page.token)
      const messaging = [page, ...linked].some(account => account.grantedScopes?.some(scope => messagingScopes.has(scope)))
      if (!messaging) continue
      await this.graph.request('POST', `/${page.externalId}/subscribed_apps`, { token: page.token, appSecret: app.secret,
        form: { subscribed_fields: 'messages,message_echoes,messaging_postbacks' } }).catch(() => undefined)
    }
  }

  limits(kind: ChannelKind): ChannelLimits {
    if (kind === 'facebook_page') return { maxLength: 63_206, maxMedia: 10 }
    return { maxLength: 2_200, maxMedia: 10 }
  }

  validateSettings(kind: ChannelKind, settings: Record<string, unknown>, media: MediaInfo[]) {
    if (kind === 'instagram_account') return validateInstagram(settings, media)
    if (kind !== 'facebook_page') throw invalid('unsupported_channel', 'Publishing to this channel kind is not supported yet')
    const parsed = facebookSettingsSchema.safeParse(settings)
    if (!parsed.success) throw invalid('invalid_settings', 'Invalid Facebook Page settings')
    if (media.some(file => !file.mimeType.startsWith('image/'))) throw invalid('unsupported_media', 'Facebook posts take JPEG or PNG images')
    if (parsed.data.link && media.length > 0) throw invalid('invalid_settings', 'A Facebook post has either a link or images, not both')
  }

  async publish(app: ResolvedProviderApp | null, input: PublishInput): Promise<PublishOutcome> {
    if (!app) return { kind: 'failed', retryable: false, code: 'missing_provider_app', detail: 'Meta channels need their provider app' }
    if (input.channel.kind === 'instagram_account') return this.instagram.publish({ token: input.token, appSecret: app.secret }, input)
    if (input.channel.kind !== 'facebook_page') return { kind: 'failed', retryable: false, code: 'unsupported_channel', detail: input.channel.kind }
    const settings = facebookSettingsSchema.parse(input.settings)
    const page = input.channel.externalId
    const call = { token: input.token, appSecret: app.secret }

    // Photos are uploaded unpublished first; they are not visible on their
    // own, so a failure here is not a publish and can be retried.
    const photoIds: string[] = []
    for (const file of input.media) {
      try {
        const created = createdSchema.parse(await this.graph.request('POST', `/${page}/photos`, { ...call, form: {
          published: 'false', source: new Blob([new Uint8Array(await mediaFileBytes(file))], { type: file.mimeType }),
        } }))
        photoIds.push(created.id)
      } catch (error) {
        return classify(error, false)
      }
    }

    const form: Record<string, string> = { message: input.content }
    photoIds.forEach((id, index) => { form[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id }) })
    if (settings.link && !photoIds.length) form.link = settings.link
    if (settings.unpublished) form.published = 'false'
    let created: z.infer<typeof createdSchema>
    await input.beforeVisible?.()
    try {
      created = createdSchema.parse(await this.graph.request('POST', `/${page}/feed`, { ...call, form }))
    } catch (error) {
      return classify(error, true)
    }
    return { kind: 'published', externalId: created.id, url: `https://www.facebook.com/${created.id}` }
  }

  async reconcile(app: ResolvedProviderApp | null, input: ReconcileInput): Promise<ReconcileOutcome> {
    if (!app) throw new Error('Meta channels need their provider app')
    if (input.channel.kind === 'instagram_account') return this.instagram.reconcile({ token: input.token, appSecret: app.secret }, input)
    const result = feedSchema.parse(await this.graph.request('GET', `/${input.channel.externalId}/published_posts`, {
      token: input.token, appSecret: app.secret,
      query: { fields: 'id,message,created_time,permalink_url', since: String(Math.floor(input.since.getTime() / 1000)), limit: '100' },
    }))
    const matches = result.data.filter(post => post.message === input.content && !input.excludeExternalIds.includes(post.id))
    if (matches.length === 1) return { kind: 'published', externalId: matches[0]!.id, url: matches[0]!.permalink_url }
    if (matches.length === 0) return { kind: 'not_found' }
    return { kind: 'ambiguous', detail: `${matches.length} posts match the content` }
  }

  async metrics(app: ResolvedProviderApp | null, input: MetricsInput): Promise<MetricsResult> {
    if (!app) throw new Error('Meta channels need their provider app')
    const call = { token: input.token, appSecret: app.secret, ...spendAfterFirst(input.spendCall) }
    if (input.channel.kind === 'instagram_account') return guardRateLimit(() => instagramMediaMetrics(this.graph, call, input.externalId))
    return guardRateLimit(() => facebookPostMetrics(this.graph, call, input.externalId))
  }

  async accountMetrics(app: ResolvedProviderApp | null, input: AccountMetricsInput): Promise<AccountMetricsResult> {
    if (!app) throw new Error('Meta channels need their provider app')
    const call = { token: input.token, appSecret: app.secret, ...spendAfterFirst(input.spendCall) }
    const now = input.now ?? new Date()
    if (input.channel.kind === 'instagram_account') return guardRateLimit(() => instagramAccountMetrics(this.graph, call, input.channel.externalId, now))
    return guardRateLimit(() => facebookPageMetrics(this.graph, call, input.channel.externalId, now))
  }

  async accountActivity(app: ResolvedProviderApp | null, input: AccountActivityInput): Promise<AccountActivityResult> {
    if (!app) throw new Error('Meta channels need their provider app')
    const call = { token: input.token, appSecret: app.secret, ...spendAfterFirst(input.spendCall) }
    if (input.channel.kind === 'instagram_account') return guardRateLimit(() => instagramActivity(this.graph, call, input.channel.externalId, { login: false }))
    return guardRateLimit(() => facebookActivity(this.graph, call, input.channel.externalId))
  }

  async responses(app: ResolvedProviderApp | null, input: ResponsesInput): Promise<ResponsesResult> {
    if (!app) throw new Error('Meta channels need their provider app')
    const call = { token: input.token, appSecret: app.secret }
    if (input.channel.kind === 'instagram_account') return guardRateLimit(() => instagramResponses(this.graph, call, input, 'instagram_manage_comments'))
    return guardRateLimit(() => facebookResponses(this.graph, call, input))
  }

  replyRules(kind: ChannelKind) {
    return metaReplyRules[kind] ?? null
  }

  async reply(app: ResolvedProviderApp | null, input: ReplyInput): Promise<ReplyOutcome> {
    if (!app) return { kind: 'failed', retryable: false, code: 'not_supported', detail: 'Meta channels need their provider app' }
    const call = { token: input.token, appSecret: app.secret }
    if (input.channel.kind === 'instagram_account') return instagramReply(this.graph, call, input, 'instagram_manage_comments')
    if (input.channel.kind !== 'facebook_page') return { kind: 'failed', retryable: false, code: 'not_supported', detail: input.channel.kind }
    return facebookReply(this.graph, call, input)
  }

  async findReply(app: ResolvedProviderApp | null, input: FindReplyInput): Promise<FindReplyOutcome> {
    if (!app) throw new Error('Meta channels need their provider app')
    const call = { token: input.token, appSecret: app.secret }
    if (input.channel.kind === 'instagram_account') return guardRateLimit(() => instagramFindReply(this.graph, call, input))
    return guardRateLimit(() => facebookFindReply(this.graph, call, input))
  }

  async replyTarget(app: ResolvedProviderApp | null, input: ReplyTargetInput): Promise<ReplyTargetOutcome> {
    if (!app || input.channel.kind !== 'facebook_page') return { kind: 'failed', retryable: false, code: 'not_supported', detail: input.channel.kind }
    return facebookThreadTop(this.graph, { token: input.token, appSecret: app.secret }, input)
  }

  messageRules(kind: ChannelKind) {
    return metaMessageRules[kind] ?? null
  }

  async conversations(app: ResolvedProviderApp | null, input: ConversationsInput): Promise<ConversationsResult> {
    const rules = this.messageRules(input.channel.kind)
    if (!app || !rules) throw new Error('Messages are not read on this channel')
    return guardRateLimit(() => readConversations(this.graph, { token: input.token, appSecret: app.secret },
      { path: `/${messagingNode(input.channel)}/conversations`, platform: rules.platform, channel: input.channel, permission: rules.permission }))
  }

  async conversationMessages(app: ResolvedProviderApp | null, input: ConversationMessagesInput): Promise<PlatformMessage[]> {
    if (!app) throw new Error('Meta channels need their provider app')
    return guardRateLimit(() => readConversationMessages(this.graph, { token: input.token, appSecret: app.secret }, input))
  }

  async sendMessage(app: ResolvedProviderApp | null, input: SendMessageInput): Promise<SendMessageOutcome> {
    const rules = this.messageRules(input.channel.kind)
    if (!app || !rules) return { kind: 'failed', retryable: false, code: 'not_supported', detail: input.channel.kind }
    return sendDirectMessage(this.graph, { token: input.token, appSecret: app.secret },
      { path: `/${messagingNode(input.channel)}/messages`, recipientExternalId: input.recipientExternalId, text: input.text, permission: rules.permission })
  }

  async findMessage(app: ResolvedProviderApp | null, input: FindMessageInput): Promise<FindReplyOutcome> {
    if (!app) throw new Error('Meta channels need their provider app')
    return guardRateLimit(() => findDirectMessage(this.graph, { token: input.token, appSecret: app.secret }, input))
  }
}

/**
 * The Graph node that holds a channel's conversations: the Page itself, or
 * for a Page-linked Instagram account the Page its token belongs to (`me`
 * with a Page token is the Page; the channel stores only the Instagram ID).
 */
function messagingNode(channel: { kind: ChannelKind, externalId: string }) {
  return channel.kind === 'facebook_page' ? channel.externalId : 'me'
}

/**
 * The scopes of a user grant that hold for one Page or Instagram account. A
 * Page permission whose granular entry names Pages holds only for those.
 * Instagram permissions are not narrowed: which IDs Meta lists for them is
 * not documented.
 */
const messagingScopes = new Set(['pages_messaging', 'instagram_manage_messages'])

export function accountScopes(grant: z.infer<typeof debugTokenSchema>['data'], account: Pick<ConnectedAccount, 'kind' | 'externalId'>) {
  return (grant.scopes ?? []).filter(scope => {
    const targets = grant.granular_scopes?.find(entry => entry.scope === scope)?.target_ids
    return account.kind !== 'facebook_page' || !scope.startsWith('pages_') || !targets?.length || targets.includes(account.externalId)
  })
}

/** Adds a Page and, when one is linked, its Instagram professional account, which is published to with the Page token. */
function pushPage(accounts: ConnectedAccount[], page: z.infer<typeof pageSchema>, token: string) {
  accounts.push({ kind: 'facebook_page', externalId: page.id, name: page.name, token, tokenExpiresAt: null })
  const instagram = page.instagram_business_account
  if (instagram) {
    accounts.push({ kind: 'instagram_account', externalId: instagram.id, name: instagram.username ? `@${instagram.username}` : `${page.name} (Instagram)`,
      token, tokenExpiresAt: null })
  }
}
