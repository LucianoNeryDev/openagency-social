import type {
  ChannelKind, ChannelMetricName, ChannelMetricValues, MessageAttachment, MessagingPlatform, MetricName, MetricValues, Platform, ProviderAppSettings,
} from '../db/schema.js'

/** A provider app with its secret resolved from the environment. */
export interface ResolvedProviderApp {
  id: string
  platform: Platform
  externalAppId: string
  secret: string
  settings: ProviderAppSettings
}

export interface ConnectedAccount {
  kind: ChannelKind
  externalId: string
  name: string
  token: string
  /** For platforms whose access tokens are short-lived (Google). */
  refreshToken?: string
  tokenExpiresAt: Date | null
  /** Permissions the platform says the grant holds for this account; absent when it does not say. */
  grantedScopes?: string[]
  /** The platform account it belongs to: a WhatsApp number's business account (WABA). */
  parentExternalId?: string
}

/** A channel's OAuth grant as stored, decrypted. */
export interface ChannelCredential {
  accessToken: string
  refreshToken?: string
  expiresAt: Date | null
  /** Set by a renewal whose response names the granted permissions (Google's `scope`); never stored with the token. */
  grantedScopes?: string[]
}

/**
 * The platform asked to slow down. The collectors pause every read on the
 * channel for an hour, or until `until`; it is never counted as a failure.
 * `app` means the limit belongs to the provider app or project (Meta's app
 * limit, YouTube's daily quota), so every channel on that app is paused.
 */
export class RateLimited extends Error {
  constructor(message: string, readonly scope: 'channel' | 'app' = 'channel', readonly until?: Date) {
    super(message)
    this.name = 'RateLimited'
  }
}

/** Thrown by `refreshCredential` when the grant is gone and the owner must connect again. */
export class ReauthRequired extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReauthRequired'
  }
}

export interface ChannelTarget {
  id: string
  kind: ChannelKind
  externalId: string
  /** The account's username without the @, when its name gives it (Instagram channels are named @username). */
  handle?: string
}

export interface MediaFile {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  /** The bytes in order. Chunks after the last are not read until asked for. */
  chunks: () => AsyncIterable<Buffer>
  /** Signed, short-lived URL the platform can fetch the file from, when public media is configured. */
  publicUrl?: string
}

export interface MediaInfo {
  id: string
  mimeType: string
  sizeBytes: number
  width: number | null
  height: number | null
}

export interface BrowserAccountTarget {
  id: string
  handle: string
  /** Sealed to the runner; the engine cannot open it. */
  sealed: { ephemeralPublicKey: Buffer, nonce: Buffer, ciphertext: Buffer }
}

export interface PublishInput {
  /** The attempt being executed; the browser runner deduplicates on it. */
  attemptId: string
  channel: ChannelTarget
  /** OAuth channels only. */
  token: string
  /** Browser channels only. */
  browserAccount?: BrowserAccountTarget
  /** Long-running drivers call this while they wait, so the sweeper leaves the attempt alone. */
  heartbeat?: () => Promise<void>
  /**
   * Called right before the request that can make the post visible, outside
   * any error handling of that request. It throws AttemptClosedError when the
   * attempt was closed meanwhile (the engine is stopping and queued the job
   * again): the adapter must then send nothing and let the error through.
   */
  beforeVisible?: () => Promise<void>
  content: string
  media: MediaFile[]
  settings: Record<string, unknown>
}

/** The attempt was closed before its visible request: nothing was sent, and the job is already queued again. */
export class AttemptClosedError extends Error {
  constructor() {
    super('The attempt was closed before its visible request')
    this.name = 'AttemptClosedError'
  }
}

export type PublishOutcome =
  | { kind: 'published', externalId: string, url?: string }
  /** The platform did not create the post. `retryable` means trying again is safe. */
  | { kind: 'failed', retryable: boolean, code: string, detail: string, reauth?: boolean }
  /** The request may have reached the platform and no result was confirmed. */
  | { kind: 'uncertain', code: string, detail: string }

export interface ReconcileInput {
  /** The last attempt, which the browser runner knows by this ID. */
  attemptId: string
  channel: ChannelTarget
  token: string
  content: string
  settings: Record<string, unknown>
  since: Date
  /** Receipts already held by other jobs on this channel. */
  excludeExternalIds: string[]
}

export type ReconcileOutcome =
  | { kind: 'published', externalId: string, url?: string }
  | { kind: 'not_found' }
  | { kind: 'ambiguous', detail: string }

export interface MetricsInput {
  channel: ChannelTarget
  token: string
  /** The published post's ID from the job receipt. */
  externalId: string
  /** See `AccountMetricsInput.spendCall`. */
  spendCall?: () => void
}

export interface MetricsResult {
  values: MetricValues
  /** Metrics the grant may not read (a missing permission), or that the platform does not report for this post. */
  unavailable: MetricName[]
}

export interface AccountMetricsInput {
  channel: ChannelTarget
  token: string
  /** Day metrics cover the last full day before this instant. */
  now?: Date
  /**
   * Called before each platform request after the first, which the caller
   * already paid for, so every request spends from the collectors' call
   * budget. A metrics read does not stop half-way: this only counts.
   */
  spendCall?: () => void
}

export interface AccountMetricsResult {
  values: ChannelMetricValues
  /** Metrics the grant may not read, that the platform hides, or that it no longer reports. */
  unavailable: ChannelMetricName[]
}

export interface AccountActivityInput {
  channel: ChannelTarget
  token: string
  /** As for account metrics: called before each platform request after the first. */
  spendCall?: () => void
}

/** The public face of an account. Absent fields are ones the platform does not give. */
export interface ChannelProfile {
  name: string | null
  username: string | null
  description: string | null
  website: string | null
  category: string | null
  pictureUrl: string | null
}

export type PlatformPostType = 'video' | 'reel' | 'short' | 'image' | 'carousel' | 'text' | 'link' | 'other'

/** A post or video on the account, made through the engine or anywhere else. */
export interface PlatformPost {
  externalId: string
  type: PlatformPostType
  /** Caption, message or title, clipped. */
  text: string | null
  url: string | null
  publishedAt: Date | null
  /** YouTube's privacy status (an upload starts private until published). */
  privacy?: 'public' | 'unlisted' | 'private'
}

export interface AccountActivityResult {
  profile: ChannelProfile
  /** The newest posts, newest first; at most a page. */
  posts: PlatformPost[]
}

export interface ResponsesInput {
  channel: ChannelTarget
  token: string
  /** The published post's ID from the job receipt. */
  externalId: string
  /**
   * Asked before each extra page of results; false stops paging. The first
   * request is already paid for by the caller.
   */
  morePages?: () => boolean
}

/** A comment or reply. Only what the dashboard shows; no avatars, profile links or user IDs. */
export interface PlatformResponse {
  externalId: string
  parentExternalId: string | null
  authorName: string | null
  authorHandle: string | null
  text: string
  likeCount: number | null
  replyCount: number | null
  publishedAt: Date
  url: string | null
  /** Written by the channel's own account. Worked out while reading; no author ID is kept. */
  fromChannel?: boolean
}

export type ResponsesResult =
  /** Newest first, at most a few hundred. Absent comments are not deletions. */
  | { kind: 'ok', responses: PlatformResponse[] }
  /** A missing permission, disabled comments or a deleted post. `reason` is shown to people. */
  | { kind: 'unavailable', reason: string }

export interface ChannelLimits {
  maxLength: number
  maxMedia: number
}

/** What a reply on a channel kind needs: the permission the grant must hold, and the longest text. */
export interface ReplyRules {
  /** As the platform names it when granting (Google's full scope URL). */
  permission: string
  maxLength: number
  /**
   * Replies nest more than one level (Facebook), so a thread's top-level
   * comment may be older than the stored responses: the adapter then reads it
   * with `replyTarget`. Elsewhere a reply's parent is the top-level comment.
   */
  deepThreads?: boolean
}

export interface ReplyInput {
  channel: ChannelTarget
  token: string
  /** The published post's ID from the job receipt. */
  postExternalId: string
  /** The comment the reply is posted under: its thread's top-level comment. */
  targetExternalId: string
  text: string
}

/**
 * The platform did not create the reply. `retryable`: nothing was sent and
 * trying again may work. `permission`: the grant lacks it. `reauth`: the
 * grant is gone.
 */
export type ReplyFailure = { kind: 'failed', retryable: boolean, code: string, detail: string, permission?: string, reauth?: boolean }

export type ReplyOutcome =
  | { kind: 'sent', externalId: string, url?: string }
  | ReplyFailure
  /** The request may have reached the platform and no result was confirmed. */
  | { kind: 'uncertain', code: string, detail: string }

export interface ReplyTargetInput {
  channel: ChannelTarget
  token: string
  /** The oldest ancestor of the answered comment that the stored responses know. */
  commentExternalId: string
}

/** The thread's top-level comment, read on the platform; a failed read sends nothing. */
export type ReplyTargetOutcome = { kind: 'top', externalId: string } | ReplyFailure

export interface FindReplyInput {
  channel: ChannelTarget
  token: string
  postExternalId: string
  targetExternalId: string
  text: string
  /** Only replies created at or after this instant. */
  since: Date
  /** Reply IDs other replies of the channel already hold. */
  excludeExternalIds: string[]
  /**
   * Called before each page after the first, which the caller already paid
   * for, so every request spends from the call budget. A look reads all its
   * pages once started: a partial read could miss a second match.
   */
  spendCall?: () => void
}

export type FindReplyOutcome =
  | { kind: 'found', externalId: string, url?: string }
  | { kind: 'not_found' }
  | { kind: 'ambiguous', detail: string }

/** What sending a direct message on a channel kind needs. */
export interface MessageRules {
  platform: MessagingPlatform
  /** As the platform names it when granting. */
  permission: string
  maxLength: number
  /** How `maxLength` counts: Instagram's limit is 1,000 UTF-8 bytes. */
  unit: 'characters' | 'bytes'
  /**
   * How inbound messages arrive: `read` from the platform's conversation API
   * (the default), or `webhook` only, from the notifications the control
   * plane forwards (WhatsApp has no conversation API). A `webhook` kind is
   * never synced, and the engine records its own sends in the conversation.
   */
  inbound?: 'read' | 'webhook'
}

export interface ConversationsInput {
  channel: ChannelTarget
  token: string
}

/** The other side of a conversation. Only what answering and the inbox need. */
export interface MessageParticipant {
  /** PSID on Messenger, IGSID on Instagram. */
  externalId: string
  name: string | null
  username: string | null
}

export interface PlatformConversation {
  externalId: string
  updatedAt: Date
  /** Null when the platform listed nobody but the channel. */
  participant: MessageParticipant | null
}

export type ConversationsResult =
  /** The newest conversations, newest first; one page. */
  | { kind: 'ok', conversations: PlatformConversation[] }
  /** A missing permission or messaging turned off. `reason` is shown to people. */
  | { kind: 'unavailable', reason: string }

export interface ConversationMessagesInput {
  channel: ChannelTarget
  token: string
  conversationExternalId: string
}

/** One message read from a conversation. Attachment URLs are never kept. */
export interface PlatformMessage {
  externalId: string
  /** Written by the channel's own account (the brand), from the engine or anywhere else. */
  fromChannel: boolean
  text: string
  attachments: MessageAttachment[]
  sentAt: Date
}

export interface SendMessageInput {
  channel: ChannelTarget
  token: string
  /** The participant's PSID or IGSID; on WhatsApp their phone number (wa_id) or business-scoped user ID. */
  recipientExternalId: string
  text: string
  /** The engine's outgoing message, for platforms that echo a tag in their status reports (WhatsApp's `biz_opaque_callback_data`). */
  outgoingId?: string
  /** The person's newest stored message, which a platform with read receipts marks as read once the answer is accepted. */
  readExternalId?: string
}

export type SendMessageOutcome =
  | { kind: 'sent', externalId: string }
  | ReplyFailure
  /** The request may have reached the platform and no result was confirmed. */
  | { kind: 'uncertain', code: string, detail: string }

export interface FindMessageInput {
  channel: ChannelTarget
  token: string
  conversationExternalId: string
  text: string
  /** Only messages created at or after this instant. */
  since: Date
  /** Message IDs other outgoing messages of the channel already hold. */
  excludeExternalIds: string[]
}

export interface MediaDownloadInput {
  channel: ChannelTarget
  token: string
  /** The platform's media ID from a stored attachment. */
  mediaId: string
  /** Larger files are refused before they are read. */
  maxBytes: number
}

export type MediaDownloadResult =
  | { kind: 'ok', mimeType: string, sizeBytes: number | null, body: ReadableStream<Uint8Array> }
  /** Gone at the platform (expired or deleted), too large, or refused. */
  | { kind: 'unavailable', reason: 'gone' | 'too_large' | 'refused' }

export interface PlatformAdapter {
  readonly platform: Platform
  authorizeUrl(app: ResolvedProviderApp, state: string): string
  finishConnect(app: ResolvedProviderApp, code: string): Promise<ConnectedAccount[]>
  limits(kind: ChannelKind): ChannelLimits
  /** Throws an EngineError when the settings or media do not suit the channel kind. */
  validateSettings(kind: ChannelKind, settings: Record<string, unknown>, media: MediaInfo[], content?: string): void
  /** `app` is null for browser channels, which have no provider app. */
  publish(app: ResolvedProviderApp | null, input: PublishInput): Promise<PublishOutcome>
  reconcile(app: ResolvedProviderApp | null, input: ReconcileInput): Promise<ReconcileOutcome>
  /** Reads a published post's public numbers. Absent for platforms without a metrics API. */
  metrics?(app: ResolvedProviderApp | null, input: MetricsInput): Promise<MetricsResult>
  /** Reads the account's numbers. Absent for platforms without an account API. */
  accountMetrics?(app: ResolvedProviderApp | null, input: AccountMetricsInput): Promise<AccountMetricsResult>
  /** The account's profile and newest posts, read while a webhook watches them. */
  accountActivity?(app: ResolvedProviderApp | null, input: AccountActivityInput): Promise<AccountActivityResult>
  /** Reads the newest comments and replies on a published post. Absent where they are not read. */
  responses?(app: ResolvedProviderApp | null, input: ResponsesInput): Promise<ResponsesResult>
  /** What replying needs on this channel kind; null when the kind cannot reply. Absent where nothing can. */
  replyRules?(kind: ChannelKind): ReplyRules | null
  /** Posts one reply under a comment: a single platform request. */
  reply?(app: ResolvedProviderApp | null, input: ReplyInput): Promise<ReplyOutcome>
  /** Looks under the comment for a reply the channel's own account wrote with this text, for an uncertain send. */
  findReply?(app: ResolvedProviderApp | null, input: FindReplyInput): Promise<FindReplyOutcome>
  /** Reads up a deep thread to its top-level comment (where `ReplyRules.deepThreads`). Reads only. */
  replyTarget?(app: ResolvedProviderApp | null, input: ReplyTargetInput): Promise<ReplyTargetOutcome>
  /** What sending direct messages needs on this channel kind; null when the kind has none. Absent where nothing can. */
  messageRules?(kind: ChannelKind): MessageRules | null
  /** The newest page of conversations. Reads only; throws `RateLimited` on a platform rate limit. */
  conversations?(app: ResolvedProviderApp | null, input: ConversationsInput): Promise<ConversationsResult>
  /** The newest messages of one conversation (20 at most), newest first. Reads only. */
  conversationMessages?(app: ResolvedProviderApp | null, input: ConversationMessagesInput): Promise<PlatformMessage[]>
  /** Sends one text message to the participant: a single platform request. */
  sendMessage?(app: ResolvedProviderApp | null, input: SendMessageInput): Promise<SendMessageOutcome>
  /** Looks in the conversation for a message the channel's own account sent with this text, for an uncertain send. */
  findMessage?(app: ResolvedProviderApp | null, input: FindMessageInput): Promise<FindReplyOutcome>
  /** Reads a received attachment's bytes by its media ID, where attachments keep one (WhatsApp). Reads only. */
  downloadMedia?(app: ResolvedProviderApp | null, input: MediaDownloadInput): Promise<MediaDownloadResult>
  /**
   * Renews an expiring grant. Throws `ReauthRequired` when the platform
   * refuses it; any other error is transient.
   */
  refreshCredential?(app: ResolvedProviderApp, credential: ChannelCredential): Promise<ChannelCredential>
  /**
   * One cheap read that proves the channel's token still works (the daily
   * token check). Throws `ReauthRequired` when the platform says the token
   * is invalid or revoked; any other error is transient.
   */
  checkCredential?(app: ResolvedProviderApp | null, input: { channel: ChannelTarget, token: string, spendCall?: () => void }): Promise<void>
  /** Refresh when the access token expires within this long. */
  readonly refreshBeforeMs?: number
  /**
   * Keep idle channels alive: refresh ahead of expiry even when nothing is
   * published, for grants that lapse unless renewed (Instagram's 60 days).
   */
  readonly keepAlive?: boolean
}
