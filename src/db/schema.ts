import { sql } from 'drizzle-orm'
import { bigserial, boolean, check, customType, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer, driverData: Buffer }>({ dataType: () => 'bytea' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

// `instagram` is Instagram's own login (accounts without a Facebook Page); `meta` covers Pages and the Instagram accounts linked to them.
// `tiktok`, `x`, `linkedin`, `threads`, `pinterest` and `reddit` are driven through the browser runner.
// `whatsapp` is the WhatsApp Business Platform (Cloud API), connected through a Meta app of its own record.
export const platforms = ['meta', 'tiktok', 'youtube', 'instagram', 'x', 'linkedin', 'threads', 'pinterest', 'reddit', 'whatsapp'] as const
export type Platform = typeof platforms[number]
export const channelKinds = ['facebook_page', 'instagram_account', 'tiktok_account', 'youtube_channel', 'x_account',
  'linkedin_profile', 'linkedin_page', 'threads_account', 'pinterest_account', 'reddit_account', 'whatsapp_number'] as const
export type ChannelKind = typeof channelKinds[number]
export const channelStatuses = ['active', 'needs_reauth', 'disabled'] as const
export type ChannelStatus = typeof channelStatuses[number]
export const jobStates = ['queued', 'running', 'published', 'failed', 'uncertain', 'cancelled'] as const
export type JobState = typeof jobStates[number]
export const attemptOutcomes = ['succeeded', 'failed_retryable', 'failed_final', 'uncertain'] as const
export type AttemptOutcome = typeof attemptOutcomes[number]

function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} in (${values.map(value => `'${value}'`).join(', ')})`)
}

export interface ProviderAppSettings {
  /** Facebook Login for Business configuration. */
  configId?: string
  scopes?: string[]
}

export const providerApps = pgTable('provider_apps', {
  id: text('id').primaryKey(),
  platform: text('platform').$type<Platform>().notNull(),
  externalAppId: text('external_app_id').notNull(),
  ownerKind: text('owner_kind').$type<'agency' | 'tenant'>().notNull(),
  ownerOrganizationId: text('owner_organization_id'),
  // Name of the secret in the service environment, never the secret itself.
  secretRef: text('secret_ref').notNull(),
  mode: text('mode').$type<'development' | 'live'>().notNull().default('development'),
  settings: jsonb('settings').$type<ProviderAppSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('provider_apps_platform', oneOf('platform', platforms)),
  check('provider_apps_owner_kind', oneOf('owner_kind', ['agency', 'tenant'])),
  check('provider_apps_mode', oneOf('mode', ['development', 'live'])),
  check('provider_apps_tenant_owner', sql`(owner_kind = 'tenant') = (owner_organization_id is not null)`),
  unique('provider_apps_platform_external').on(table.platform, table.externalAppId),
])

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  // API channels come from a provider app's OAuth; browser channels from a vault login.
  providerAppId: text('provider_app_id').references(() => providerApps.id),
  browserAccountId: uuid('browser_account_id').references(() => browserAccounts.id),
  platform: text('platform').$type<Platform>().notNull(),
  kind: text('kind').$type<ChannelKind>().notNull(),
  externalId: text('external_id').notNull(),
  name: text('name').notNull(),
  // The platform account the channel belongs to, where it has one: a WhatsApp number's business account (WABA).
  parentExternalId: text('parent_external_id'),
  status: text('status').$type<ChannelStatus>().notNull().default('active'),
  // Permissions the grant holds, as the platform reported them at connect or
  // renewal; null when unknown (imported, or connected before they were read).
  grantedScopes: text('granted_scopes').array(),
  // Permissions a platform refused on a send; cleared when the channel connects again.
  refusedScopes: text('refused_scopes').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('channels_platform', oneOf('platform', platforms)),
  check('channels_kind', oneOf('kind', channelKinds)),
  check('channels_status', oneOf('status', channelStatuses)),
  check('channels_driver', sql`(provider_app_id is null) <> (browser_account_id is null)`),
  unique('channels_app_external_organization').on(table.providerAppId, table.externalId, table.organizationId),
  unique('channels_browser_account').on(table.browserAccountId),
  index('channels_organization').on(table.organizationId),
])

export const channelCredentials = pgTable('channel_credentials', {
  channelId: uuid('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  keyId: text('key_id').notNull(),
  nonce: bytea('nonce').notNull(),
  // AES-256-GCM ciphertext with the 16-byte tag appended. The plaintext is the
  // access token, or a v1 JSON envelope that also holds a refresh token.
  ciphertext: bytea('ciphertext').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
})

export const oauthStates = pgTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  organizationId: text('organization_id').notNull(),
  providerAppId: text('provider_app_id').notNull().references(() => providerApps.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const publishingControls = pgTable('publishing_controls', {
  organizationId: text('organization_id').primaryKey(),
  paused: boolean('paused').notNull().default(false),
  pausedChannelIds: text('paused_channel_ids').array().notNull().default(sql`'{}'::text[]`),
  // Safety limit for automations: posts per channel per calendar day (Europe/Rome).
  maxPostsPerChannelPerDay: integer('max_posts_per_channel_per_day').notNull().default(10),
  updatedAt: updatedAt(),
}, () => [
  check('publishing_controls_daily_limit', sql`max_posts_per_channel_per_day between 1 and 100`),
])

export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  // Pixel size read from the file header; null for images stored before it was recorded.
  width: integer('width'),
  height: integer('height'),
  // Files stored before media_chunks keep their bytes here; newer ones leave it null.
  data: bytea('data'),
  createdAt: createdAt(),
}, table => [
  check('media_mime_type', oneOf('mime_type', ['image/jpeg', 'image/png', 'video/mp4'])),
  index('media_organization').on(table.organizationId),
])

export const mediaChunks = pgTable('media_chunks', {
  mediaId: uuid('media_id').notNull().references(() => media.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  data: bytea('data').notNull(),
}, table => [primaryKey({ columns: [table.mediaId, table.position] })])

export interface JobPayload {
  content: string
  mediaIds: string[]
  settings: Record<string, unknown>
  approvedByUserId: string
  approvedAt: string
}

export interface JobReceipt {
  externalId: string
  url?: string
  settledBy: 'worker' | 'reconcile'
}

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  postId: text('post_id').notNull(),
  revision: integer('revision').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id),
  action: text('action').$type<'publish'>().notNull().default('publish'),
  payload: jsonb('payload').$type<JobPayload>().notNull(),
  payloadHash: text('payload_hash').notNull(),
  publishAt: timestamp('publish_at', { withTimezone: true }).notNull(),
  state: text('state').$type<JobState>().notNull().default('queued'),
  // Earliest next execution after a retryable failure.
  notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  receipt: jsonb('receipt').$type<JobReceipt>(),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('jobs_state', oneOf('state', jobStates)),
  check('jobs_action', oneOf('action', ['publish'])),
  check('jobs_revision', sql`revision > 0`),
  check('jobs_payload_size', sql`pg_column_size(payload) <= 262144`),
  unique('jobs_post_revision_channel').on(table.organizationId, table.postId, table.revision, table.channelId),
  index('jobs_due').on(table.notBefore).where(sql`state = 'queued'`),
  index('jobs_post').on(table.organizationId, table.postId),
  // A tenant's jobs newest first: the whole-tenant responses status list.
  index('jobs_organization_publish').on(table.organizationId, table.publishAt, table.id),
])

export const metricNames = ['views', 'reach', 'likes', 'comments', 'shares', 'saves'] as const
export type MetricName = typeof metricNames[number]
export type MetricValues = Partial<Record<MetricName, number>>

/**
 * Latest public numbers of a published job's post, collected on a schedule.
 * `unavailable` lists the metrics the channel's grant may not read.
 */
export const postMetrics = pgTable('post_metrics', {
  jobId: uuid('job_id').primaryKey().references(() => jobs.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id),
  values: jsonb('values').$type<MetricValues>().notNull().default({}),
  unavailable: text('unavailable').array().$type<MetricName[]>().notNull().default(sql`'{}'::text[]`),
  collectedAt: timestamp('collected_at', { withTimezone: true }),
  nextCollectAt: timestamp('next_collect_at', { withTimezone: true }).notNull(),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: updatedAt(),
}, table => [
  check('post_metrics_failure_count', sql`failure_count >= 0`),
  index('post_metrics_due').on(table.nextCollectAt),
  index('post_metrics_organization').on(table.organizationId),
])

/** One row per successful post metrics read: the history behind `post_metrics`. Kept 120 days. */
export const postMetricSamples = pgTable('post_metric_samples', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
  values: jsonb('values').$type<MetricValues>().notNull().default({}),
}, table => [
  index('post_metric_samples_job').on(table.jobId, table.collectedAt),
  index('post_metric_samples_collected').on(table.collectedAt),
  // The cascade from channels.
  index('post_metric_samples_channel').on(table.channelId),
])

/** Account-level numbers. `views`, `reach` and `profileViews` cover the last full day. */
export const channelMetricNames = ['followers', 'following', 'posts', 'views', 'reach', 'profileViews', 'totalViews'] as const
export type ChannelMetricName = typeof channelMetricNames[number]
export type ChannelMetricValues = Partial<Record<ChannelMetricName, number>>

/**
 * Latest account numbers of an OAuth channel. `pausedUntil` is set when the
 * platform rate-limits the channel, and holds back every read on it.
 */
export const channelMetrics = pgTable('channel_metrics', {
  channelId: uuid('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  values: jsonb('values').$type<ChannelMetricValues>().notNull().default({}),
  unavailable: text('unavailable').array().$type<ChannelMetricName[]>().notNull().default(sql`'{}'::text[]`),
  collectedAt: timestamp('collected_at', { withTimezone: true }),
  nextCollectAt: timestamp('next_collect_at', { withTimezone: true }).notNull(),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  updatedAt: updatedAt(),
}, table => [
  check('channel_metrics_failure_count', sql`failure_count >= 0`),
  index('channel_metrics_due').on(table.nextCollectAt),
  index('channel_metrics_organization').on(table.organizationId),
])

/** History of `channel_metrics`, one row per successful read. Kept 400 days. */
export const channelMetricSamples = pgTable('channel_metric_samples', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
  values: jsonb('values').$type<ChannelMetricValues>().notNull().default({}),
}, table => [
  index('channel_metric_samples_channel').on(table.channelId, table.collectedAt),
  index('channel_metric_samples_collected').on(table.collectedAt),
])

/**
 * Comments and replies on published posts. The text and author name are
 * third-party personal data: nothing else about the author is stored, and
 * rows go 180 days after the post's publishAt or when the channel is disabled.
 */
export const postResponses = pgTable('post_responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  parentExternalId: text('parent_external_id'),
  authorName: text('author_name'),
  authorHandle: text('author_handle'),
  text: text('text').notNull(),
  likeCount: integer('like_count'),
  replyCount: integer('reply_count'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  url: text('url'),
  // Written by the channel's own account (the brand's replies). Says nothing about other commenters. Null for a
  // response stored before the engine told the brand's own comments apart, until it is read again.
  fromChannel: boolean('from_channel'),
}, table => [
  check('post_responses_text_length', sql`char_length(text) <= 5000`),
  // Also the channel index: the channel cascade and the disabled-channel sweep use its leading column.
  unique('post_responses_channel_external').on(table.channelId, table.externalId),
  index('post_responses_feed').on(table.organizationId, table.firstSeenAt, table.id),
  index('post_responses_job').on(table.jobId, table.firstSeenAt),
])

export const responseCheckStates = ['ok', 'unavailable', 'failing', 'not_supported', 'pending'] as const
export type ResponseCheckState = typeof responseCheckStates[number]

/** When a published job's responses are read next, and how the last read went. */
export const responseChecks = pgTable('response_checks', {
  jobId: uuid('job_id').primaryKey().references(() => jobs.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  state: text('state').$type<ResponseCheckState>().notNull().default('pending'),
  // Human-readable, for the dashboard: which permission is missing, or why reads fail.
  reason: text('reason'),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull(),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  // While in the future, the responses are read about every 30 seconds.
  watchUntil: timestamp('watch_until', { withTimezone: true }),
  updatedAt: updatedAt(),
}, table => [
  check('response_checks_state', oneOf('state', responseCheckStates)),
  check('response_checks_failure_count', sql`failure_count >= 0`),
  index('response_checks_due').on(table.nextCheckAt),
  index('response_checks_watch').on(table.watchUntil).where(sql`watch_until is not null`),
  // The channel cascade, a channel's disable and the disabled-channel sweep.
  index('response_checks_channel').on(table.channelId),
])

/** Who approved a reply or message: a person, or the dashboard's automatic approval of an engine draft. */
export const approvedVia = ['person', 'automation'] as const
export type ApprovedVia = typeof approvedVia[number]

export const replyStates = ['queued', 'sending', 'sent', 'failed', 'uncertain', 'cancelled'] as const
export type ReplyState = typeof replyStates[number]

/**
 * One approved reply revision from the dashboard, sent at most once (spec
 * 006). The request key binds the organization, the dashboard reply and
 * revision, and the digest of the job, the answered comment and the text.
 * Deleted with the post's responses.
 */
export const replies = pgTable('replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  requestKey: text('request_key').notNull(),
  // The dashboard's reply and revision.
  replyId: text('reply_id').notNull(),
  revision: integer('revision').notNull(),
  digest: text('digest').notNull(),
  // The comment the person answered, and the one the reply is posted under (its thread's top-level comment).
  parentExternalId: text('parent_external_id').notNull(),
  targetExternalId: text('target_external_id').notNull(),
  text: text('text').notNull(),
  approvedByUserId: text('approved_by_user_id').notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
  // As for outgoing messages: `automation` with the engine draft it sends.
  approvedVia: text('approved_via').$type<ApprovedVia>().notNull().default('person'),
  draftId: uuid('draft_id'),
  sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
  state: text('state').$type<ReplyState>().notNull().default('queued'),
  // Next claim while queued, next look at the platform while uncertain.
  notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  // Start of the last attempt, committed before the platform call.
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  // Still being looked for on the platform: uncertain, or said not sent by a person before the last look.
  reconciling: boolean('reconciling').notNull().default(false),
  // Looks claimed, and looks that ended without finding the reply.
  reconcileCount: integer('reconcile_count').notNull().default(0),
  reconcileMisses: integer('reconcile_misses').notNull().default(0),
  // What a person said about the uncertain reply; kept when a confirmed reply overrides it.
  resolution: text('resolution').$type<'sent' | 'not_sent'>(),
  // False while the thread's top-level comment is still to be read on the platform: a Facebook thread deeper than the stored responses.
  targetResolved: boolean('target_resolved').notNull().default(true),
  errorCode: text('error_code'),
  // The permission a `missing_permission` failure names.
  permission: text('permission'),
  platformReplyId: text('platform_reply_id'),
  url: text('url'),
  settledBy: text('settled_by').$type<'worker' | 'reconcile' | 'operator'>(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('replies_state', oneOf('state', replyStates)),
  check('replies_revision', sql`revision > 0`),
  check('replies_hashes', sql`request_key ~ '^[0-9a-f]{64}$' and digest ~ '^[0-9a-f]{64}$'`),
  check('replies_text_length', sql`char_length(text) between 1 and 10000`),
  check('replies_counts', sql`attempt_count >= 0 and reconcile_count >= 0 and reconcile_misses >= 0`),
  check('replies_settled_by', sql`settled_by is null or settled_by in ('worker', 'reconcile', 'operator')`),
  check('replies_resolution', sql`resolution is null or resolution in ('sent', 'not_sent')`),
  check('replies_approved_via', sql`approved_via in ('person', 'automation') and (approved_via = 'automation') = (draft_id is not null)`),
  uniqueIndex('replies_draft').on(table.draftId).where(sql`draft_id is not null`),
  unique('replies_request_key').on(table.requestKey),
  unique('replies_revision_unique').on(table.organizationId, table.replyId, table.revision),
  index('replies_due').on(table.notBefore).where(sql`state = 'queued' or reconciling`),
  index('replies_open').on(table.leaseUntil).where(sql`state = 'sending'`),
  // Limits count a channel's recent replies; collected responses link back by platform ID, which one reply holds at most.
  index('replies_channel_send').on(table.channelId, table.sendAt),
  uniqueIndex('replies_channel_platform').on(table.channelId, table.platformReplyId).where(sql`platform_reply_id is not null`),
  // Reconciliation looks for other replies under the same comment.
  index('replies_channel_target').on(table.channelId, table.targetExternalId),
  // The cascade from jobs, and retention.
  index('replies_job').on(table.jobId),
])

/** Request keys cancelled before the engine stored them: a submission still on its way is refused. Kept 30 days. */
export const replyCancellations = pgTable('reply_cancellations', {
  requestKey: text('request_key').primaryKey(),
  organizationId: text('organization_id').notNull(),
  createdAt: createdAt(),
}, () => [
  check('reply_cancellations_key', sql`request_key ~ '^[0-9a-f]{64}$'`),
])

export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  outcome: text('outcome').$type<AttemptOutcome>(),
  // Long-running drivers (the browser runner) beat while they wait, so the sweeper leaves them alone.
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  errorCode: text('error_code'),
  detail: text('detail'),
}, table => [
  check('attempts_outcome', sql`outcome is null or ${oneOf('outcome', attemptOutcomes)}`),
  index('attempts_job').on(table.jobId),
  index('attempts_open').on(table.startedAt).where(sql`finished_at is null`),
])

export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  organizationId: text('organization_id').notNull(),
  jobId: uuid('job_id'),
  channelId: uuid('channel_id'),
  kind: text('kind').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, table => [
  index('events_organization').on(table.organizationId, table.createdAt),
])

export const browserPlatforms = ['tiktok', 'x', 'linkedin', 'threads', 'pinterest', 'reddit'] as const
export type BrowserPlatform = typeof browserPlatforms[number]
export const browserAccountStatuses = ['active', 'needs_login', 'disabled'] as const
export type BrowserAccountStatus = typeof browserAccountStatuses[number]

/**
 * Logins for accounts driven through the browser runner. The secret is sealed
 * to the runner's public key (src/crypto/sealed.ts); the engine cannot open it.
 */
export const browserAccounts = pgTable('browser_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  platform: text('platform').$type<BrowserPlatform>().notNull(),
  handle: text('handle').notNull(),
  status: text('status').$type<BrowserAccountStatus>().notNull().default('needs_login'),
  ephemeralPublicKey: bytea('ephemeral_public_key').notNull(),
  nonce: bytea('nonce').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('browser_accounts_platform', oneOf('platform', browserPlatforms)),
  check('browser_accounts_status', oneOf('status', browserAccountStatuses)),
  check('browser_accounts_ciphertext_size', sql`octet_length(ciphertext) <= 8192`),
  unique('browser_accounts_organization_platform_handle').on(table.organizationId, table.platform, table.handle),
])

/**
 * When a channel's conversations are read next: every 30 minutes,
 * sooner when a Meta notification or the dashboard asks, at most once a
 * minute. A rate limit holds the channel back until `backoff_until`, 15
 * minutes doubling to 4 hours (`rate_limit_count` in a row).
 */
export const conversationChecks = pgTable('conversation_checks', {
  channelId: uuid('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull(),
  // Start of the last sync; the next one waits a minute after it.
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  backoffUntil: timestamp('backoff_until', { withTimezone: true }),
  rateLimitCount: integer('rate_limit_count').notNull().default(0),
  // When the channel began to be watched: messages sent before it are stored without a webhook.
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('conversation_checks_counts', sql`failure_count >= 0 and rate_limit_count >= 0`),
  index('conversation_checks_due').on(table.nextCheckAt),
  index('conversation_checks_organization').on(table.organizationId),
])

export const messagingPlatforms = ['messenger', 'instagram', 'whatsapp'] as const
export type MessagingPlatform = typeof messagingPlatforms[number]

/**
 * A Messenger, Instagram or WhatsApp conversation between a channel and one person.
 * The participant's platform ID is kept because answering needs it; their
 * name and username only to show. Third-party personal data: deleted 180
 * days after the last message, or with the channel.
 */
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  platform: text('platform').$type<MessagingPlatform>().notNull(),
  externalId: text('external_id').notNull(),
  // PSID on Messenger, IGSID on Instagram; on WhatsApp the phone number (wa_id) when Meta gives it, else the
  // business-scoped user ID. Null when the platform listed no other participant.
  participantExternalId: text('participant_external_id'),
  participantName: text('participant_name'),
  participantUsername: text('participant_username'),
  // The platform's `updated_time`: messages are read again only when it moves.
  updatedTime: timestamp('updated_time', { withTimezone: true }).notNull(),
  // The person's newest stored message: the 24-hour answering window runs from it.
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  // The newest stored message either way, or `updated_time` before any is stored.
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('conversations_platform', oneOf('platform', messagingPlatforms)),
  // Also the channel index: the cascade and the disabled-channel sweep use its leading column.
  unique('conversations_channel_external').on(table.channelId, table.externalId),
  // The tenant's inbox, newest first; retention reads the same column.
  index('conversations_inbox').on(table.organizationId, table.lastMessageAt, table.id),
  index('conversations_last_message').on(table.lastMessageAt),
])

export interface MessageAttachment {
  /**
   * `image`, `video`, `audio`, `file`, `sticker`, `share`, `story` or `other`; on WhatsApp also
   * `location`, `contacts`, `reaction`, `interactive`, `button`, `order` and `unsupported`.
   */
  type: string
  name?: string
  /** WhatsApp only: Meta's media ID, read on request (it expires there after about 30 days). Never a URL. */
  mediaId?: string
  mimeType?: string
}

/** One message of a conversation, either way. Attachments keep their type and name only, never their URLs. */
export const directMessages = pgTable('direct_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  direction: text('direction').$type<'in' | 'out'>().notNull(),
  text: text('text').notNull(),
  attachments: jsonb('attachments').$type<MessageAttachment[]>().notNull().default([]),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
}, table => [
  check('direct_messages_direction', oneOf('direction', ['in', 'out'])),
  check('direct_messages_text_length', sql`char_length(text) <= 5000`),
  check('direct_messages_attachments_size', sql`pg_column_size(attachments) <= 8192`),
  // Also the channel index; outgoing messages link back by platform ID.
  unique('direct_messages_channel_external').on(table.channelId, table.externalId),
  index('direct_messages_conversation').on(table.conversationId, table.sentAt, table.id),
  index('direct_messages_sent').on(table.sentAt),
  // The answering step looks for a tenant's newly stored inbound messages.
  index('direct_messages_inbound').on(table.organizationId, table.firstSeenAt).where(sql`direction = 'in'`),
])

export const outgoingMessageStates = ['queued', 'sending', 'sent', 'failed', 'uncertain', 'cancelled'] as const
export type OutgoingMessageState = typeof outgoingMessageStates[number]
export const deliveryStatuses = ['sent', 'delivered', 'read', 'failed'] as const
export type DeliveryStatus = typeof deliveryStatuses[number]

/**
 * One submitted message revision from the dashboard, sent at most once
 * (the exactly-once contract of comment replies). The request key binds the
 * organization, the dashboard message and revision, and the digest of the
 * conversation and the text.
 */
export const outgoingMessages = pgTable('outgoing_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  requestKey: text('request_key').notNull(),
  // The dashboard's message and revision.
  messageId: text('message_id').notNull(),
  revision: integer('revision').notNull(),
  digest: text('digest').notNull(),
  text: text('text').notNull(),
  approvedByUserId: text('approved_by_user_id').notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
  // `automation`: the dashboard approved an engine draft automatically; the engine checked its own record of it (`draft_id`).
  approvedVia: text('approved_via').$type<ApprovedVia>().notNull().default('person'),
  draftId: uuid('draft_id'),
  sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
  state: text('state').$type<OutgoingMessageState>().notNull().default('queued'),
  // Next claim while queued, next look at the platform while uncertain.
  notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  // Start of the last attempt, committed before the platform call.
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  // Still being looked for: uncertain, or said not sent by a person before the last look.
  reconciling: boolean('reconciling').notNull().default(false),
  reconcileCount: integer('reconcile_count').notNull().default(0),
  reconcileMisses: integer('reconcile_misses').notNull().default(0),
  resolution: text('resolution').$type<'sent' | 'not_sent'>(),
  errorCode: text('error_code'),
  // The permission a `missing_permission` failure names.
  permission: text('permission'),
  platformMessageId: text('platform_message_id'),
  settledBy: text('settled_by').$type<'worker' | 'reconcile' | 'operator'>(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  // Where the platform reports it got to after the send (WhatsApp statuses): sent, delivered, read, or failed with a code.
  deliveryStatus: text('delivery_status').$type<DeliveryStatus>(),
  deliveryErrorCode: text('delivery_error_code'),
  deliveryUpdatedAt: timestamp('delivery_updated_at', { withTimezone: true }),
  // The platform's ID for this message as a status report named it, which settles an uncertain send without reading the conversation.
  reportedMessageId: text('reported_message_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('outgoing_messages_state', oneOf('state', outgoingMessageStates)),
  check('outgoing_messages_delivery_status', sql`delivery_status is null or delivery_status in ('sent', 'delivered', 'read', 'failed')`),
  check('outgoing_messages_revision', sql`revision > 0`),
  check('outgoing_messages_hashes', sql`request_key ~ '^[0-9a-f]{64}$' and digest ~ '^[0-9a-f]{64}$'`),
  check('outgoing_messages_text_length', sql`char_length(text) between 1 and 5000`),
  check('outgoing_messages_counts', sql`attempt_count >= 0 and reconcile_count >= 0 and reconcile_misses >= 0`),
  check('outgoing_messages_settled_by', sql`settled_by is null or settled_by in ('worker', 'reconcile', 'operator')`),
  check('outgoing_messages_resolution', sql`resolution is null or resolution in ('sent', 'not_sent')`),
  check('outgoing_messages_approved_via', sql`approved_via in ('person', 'automation') and (approved_via = 'automation') = (draft_id is not null)`),
  // One automatic send per engine draft.
  uniqueIndex('outgoing_messages_draft').on(table.draftId).where(sql`draft_id is not null`),
  unique('outgoing_messages_request_key').on(table.requestKey),
  unique('outgoing_messages_revision_unique').on(table.organizationId, table.messageId, table.revision),
  index('outgoing_messages_due').on(table.notBefore).where(sql`state = 'queued' or reconciling`),
  index('outgoing_messages_open').on(table.leaseUntil).where(sql`state = 'sending'`),
  // Limits count a channel's recent messages; stored messages link back by platform ID, which one outgoing message holds at most.
  index('outgoing_messages_channel_send').on(table.channelId, table.sendAt),
  uniqueIndex('outgoing_messages_channel_platform').on(table.channelId, table.platformMessageId).where(sql`platform_message_id is not null`),
  // Rivals in the same conversation, the cascade from conversations, and the dashboard's list.
  index('outgoing_messages_conversation').on(table.conversationId, table.createdAt),
  index('outgoing_messages_organization').on(table.organizationId, table.createdAt),
])

/** Request keys cancelled before the engine stored them: a submission still on its way is refused. Kept 30 days. */
export const outgoingMessageCancellations = pgTable('outgoing_message_cancellations', {
  requestKey: text('request_key').primaryKey(),
  organizationId: text('organization_id').notNull(),
  createdAt: createdAt(),
}, () => [
  check('outgoing_message_cancellations_key', sql`request_key ~ '^[0-9a-f]{64}$'`),
])

// Webhooks: what a tenant's applications are told, and where.
export const webhookEventTypes = ['post.published', 'post.failed', 'post.metrics.changed', 'channel.metrics.changed', 'comment.created',
  'channel.post.created', 'channel.profile.changed', 'channel.status.changed', 'reply.sent', 'reply.failed',
  'message.received', 'message.sent', 'message.failed'] as const
export type WebhookEventType = typeof webhookEventTypes[number]
export const webhookStatuses = ['active', 'disabled'] as const
export type WebhookStatus = typeof webhookStatuses[number]
export const webhookDeliveryStates = ['pending', 'delivered', 'failed'] as const
export type WebhookDeliveryState = typeof webhookDeliveryStates[number]

/**
 * A tenant's HTTPS endpoint and the events it receives. The signing secret is
 * sealed with the token keyring (associated data `webhook:<id>`); after a
 * rotation the previous one also signs until `previous_secret_expires_at`.
 */
export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  url: text('url').notNull(),
  description: text('description'),
  eventTypes: text('event_types').array().$type<WebhookEventType[]>().notNull(),
  // Null: every channel of the tenant.
  channelIds: uuid('channel_ids').array(),
  status: text('status').$type<WebhookStatus>().notNull().default('active'),
  disabledReason: text('disabled_reason'),
  secretKeyId: text('secret_key_id').notNull(),
  secretNonce: bytea('secret_nonce').notNull(),
  secretCiphertext: bytea('secret_ciphertext').notNull(),
  previousSecretKeyId: text('previous_secret_key_id'),
  previousSecretNonce: bytea('previous_secret_nonce'),
  previousSecretCiphertext: bytea('previous_secret_ciphertext'),
  previousSecretExpiresAt: timestamp('previous_secret_expires_at', { withTimezone: true }),
  // First failed attempt since the last success; cleared by a success.
  failingSince: timestamp('failing_since', { withTimezone: true }),
  lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  check('webhooks_status', oneOf('status', webhookStatuses)),
  check('webhooks_event_types', sql`cardinality(event_types) > 0 and event_types <@ array[${sql.raw(webhookEventTypes.map(type => `'${type}'`).join(', '))}]::text[]`),
  check('webhooks_url', sql`url like 'https://%' and char_length(url) <= 2000`),
  check('webhooks_description_length', sql`char_length(description) <= 200`),
  index('webhooks_organization').on(table.organizationId),
])

/**
 * The outbox: one row per event per webhook, written in the transaction that
 * made the change. Delivered at least once; the row ID is the `webhook-id`
 * header, so a receiver can drop repeats. Kept 30 days.
 */
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  webhookId: uuid('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  eventType: text('event_type').notNull(),
  // `{type, timestamp, data}`: the body sent, the same on every attempt.
  payload: jsonb('payload').$type<{ type: string, timestamp: string, data: Record<string, unknown> }>().notNull(),
  state: text('state').$type<WebhookDeliveryState>().notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastStatus: integer('last_status'),
  lastError: text('last_error'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: createdAt(),
}, table => [
  check('webhook_deliveries_state', oneOf('state', webhookDeliveryStates)),
  check('webhook_deliveries_payload_size', sql`pg_column_size(payload) <= 65536`),
  index('webhook_deliveries_due').on(table.nextAttemptAt).where(sql`state = 'pending'`),
  index('webhook_deliveries_webhook').on(table.webhookId, table.createdAt),
  index('webhook_deliveries_created').on(table.createdAt),
])

/**
 * What a webhook-watched account looked like at its last activity read: the
 * profile, and the IDs of the newest posts already seen, so the next read
 * can tell new posts and profile edits. Null `seen_post_ids`: never read.
 */
export const channelActivity = pgTable('channel_activity', {
  channelId: uuid('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  profile: jsonb('profile').$type<Record<string, string | null>>(),
  seenPostIds: text('seen_post_ids').array(),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: updatedAt(),
}, table => [
  check('channel_activity_failure_count', sql`failure_count >= 0`),
  check('channel_activity_seen_size', sql`coalesce(cardinality(seen_post_ids), 0) <= 200`),
  index('channel_activity_organization').on(table.organizationId),
])

export const caseEffects = ['always', 'never'] as const
export type CaseEffect = typeof caseEffects[number]
export const replyModelChoices = ['haiku', 'sonnet', 'opus'] as const
export type ReplyModelChoice = typeof replyModelChoices[number]

/**
 * One case of answering: `never` keeps what it matches for a person,
 * `always` answers it without asking the decision model. Every condition it
 * sets holds; each list is any of its values, an empty list no condition.
 */
export interface AnsweringCase {
  id: string
  effect: CaseEffect
  label: string
  /** Usernames or names of the person writing, `@` and case ignored. */
  authors: string[]
  /** Words or phrases in the text, case and accents ignored. */
  keywords: string[]
  /** The channels it applies to; empty: every channel. */
  channelIds: string[]
}

/** A tenant's answering settings, as the dashboard resolved them (global with the tenant's overrides). */
export interface AnsweringSettings {
  /** Automatic sending: off, an `auto` decision becomes `review`. */
  enabled: boolean
  /** Decide and draft at all; items first seen after it was switched on are processed. */
  drafts: boolean
  kinds: { messages: boolean, comments: boolean }
  decisionModel: string
  decisionPrompt: string
  decisionThreshold: number
  noneThreshold: number
  replyModel: ReplyModelChoice
  voice: string
  replyContext: string
  delaySeconds: number
  cases: AnsweringCase[]
}

export interface AnsweringContextEntry {
  id: string
  topic: string
  body: string
}

/** What the dashboard pushed last. No row: the feature is off for the tenant. */
export const answeringSettings = pgTable('answering_settings', {
  organizationId: text('organization_id').primaryKey(),
  version: integer('version').notNull(),
  settings: jsonb('settings').$type<AnsweringSettings>().notNull(),
  context: jsonb('context').$type<AnsweringContextEntry[]>().notNull().default([]),
  // When DMs and comments were last switched on (`drafts` and the kind): items of that kind first seen before it are never processed.
  messagesEnabledAt: timestamp('messages_enabled_at', { withTimezone: true }),
  commentsEnabledAt: timestamp('comments_enabled_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, () => [
  check('answering_settings_version', sql`version > 0`),
  check('answering_settings_size', sql`pg_column_size(settings) + pg_column_size(context) <= 1048576`),
])

export const draftKinds = ['message', 'comment'] as const
export type DraftKind = typeof draftKinds[number]
/** `auto` (full), `review` (draft), `none` (no answer needed), `skipped` (not decided: treated as review). */
export const decisionOutcomes = ['auto', 'review', 'none', 'skipped'] as const
export type DecisionOutcome = typeof decisionOutcomes[number]

/**
 * The engine's decision about one inbound DM or comment, and its draft. The
 * draft is model output about third-party content: it goes with the inbound
 * rows (180 days, or when the channel is disabled).
 */
export const inboundDrafts = pgTable('inbound_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<DraftKind>().notNull(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
  responseId: uuid('response_id').references(() => postResponses.id, { onDelete: 'cascade' }),
  // The direct message's or comment's platform ID.
  inboundExternalId: text('inbound_external_id').notNull(),
  outcome: text('outcome').$type<DecisionOutcome>().notNull(),
  reason: text('reason').notNull(),
  decisionModel: text('decision_model'),
  probabilities: jsonb('probabilities').$type<{ full: number, draft: number, none: number }>(),
  confidence: doublePrecision('confidence'),
  caseId: text('case_id'),
  decisionThreshold: doublePrecision('decision_threshold').notNull(),
  noneThreshold: doublePrecision('none_threshold').notNull(),
  // What the decision call cost (USD), as reported.
  cost: doublePrecision('cost'),
  errorCode: text('error_code'),
  draftText: text('draft_text'),
  // The digest the dashboard's submission of the unedited draft carries (`social-message-v1` or `social-reply-v1`).
  draftDigest: text('draft_digest'),
  draftModel: text('draft_model'),
  draftLanguage: text('draft_language'),
  draftFlags: text('draft_flags').array().notNull().default(sql`'{}'::text[]`),
  draftErrorCode: text('draft_error_code'),
  settingsVersion: integer('settings_version').notNull(),
  supersededBy: uuid('superseded_by'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  // In the dashboard's outbox until acknowledged; a draft superseded later comes back once more.
  outboxPending: boolean('outbox_pending').notNull().default(true),
  outboxAt: timestamp('outbox_at', { withTimezone: true }).notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: createdAt(),
}, table => [
  check('inbound_drafts_kind', oneOf('kind', draftKinds)),
  check('inbound_drafts_outcome', oneOf('outcome', decisionOutcomes)),
  check('inbound_drafts_target', sql`(kind = 'message') = (conversation_id is not null) and (kind = 'comment') = (response_id is not null)`),
  check('inbound_drafts_text_length', sql`char_length(draft_text) between 1 and 10000`),
  check('inbound_drafts_digest', sql`(draft_text is null) = (draft_digest is null) and (draft_digest is null or draft_digest ~ '^[0-9a-f]{64}$')`),
  // One decision per inbound DM and per comment.
  uniqueIndex('inbound_drafts_message').on(table.conversationId, table.inboundExternalId).where(sql`kind = 'message'`),
  uniqueIndex('inbound_drafts_comment').on(table.responseId).where(sql`kind = 'comment'`),
  index('inbound_drafts_outbox').on(table.outboxAt, table.id).where(sql`outbox_pending`),
  index('inbound_drafts_superseded_by').on(table.supersededBy).where(sql`superseded_by is not null`),
  // The channel cascade, a disable, and retention.
  index('inbound_drafts_channel').on(table.channelId),
  index('inbound_drafts_created').on(table.createdAt),
])

export const controlEventTypes = ['drafts.available', 'messages.changed', 'replies.changed'] as const
export type ControlEventType = typeof controlEventTypes[number]

/**
 * Nudges for the control plane: one pending row per (type, organization),
 * so events coalesce and survive a restart. `generation` moves when a new
 * change joins a row being sent, so its success does not swallow the change.
 */
export const controlEvents = pgTable('control_events', {
  type: text('type').$type<ControlEventType>().notNull(),
  organizationId: text('organization_id').notNull(),
  eventId: uuid('event_id').notNull(),
  generation: integer('generation').notNull().default(1),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  // Set while a sender has it on its way; a change that joins then waits for that send to settle.
  claimedUntil: timestamp('claimed_until', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  primaryKey({ columns: [table.type, table.organizationId] }),
  check('control_events_type', oneOf('type', controlEventTypes)),
  check('control_events_counts', sql`attempt_count >= 0 and generation > 0`),
  index('control_events_due').on(table.nextAttemptAt),
])
