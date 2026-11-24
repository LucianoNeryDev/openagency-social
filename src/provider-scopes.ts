import { eq, sql } from 'drizzle-orm'
import type { Executor } from './db/client.js'
import { providerApps, type Platform } from './db/schema.js'
import { notFound } from './errors.js'
import { defaultInstagramScopes } from './platforms/instagram/adapter.js'
import { defaultMetaScopes } from './platforms/meta/adapter.js'
import { defaultWhatsAppScopes } from './platforms/whatsapp/adapter.js'
import { defaultYoutubeScopes, youtubeReplyScope } from './platforms/youtube/adapter.js'

const googleScopePrefix = 'https://www.googleapis.com/auth/'

/** What each OAuth platform asks for when a provider app pins no scopes. */
export const defaultScopes: Partial<Record<Platform, readonly string[]>> = {
  meta: defaultMetaScopes, instagram: defaultInstagramScopes, youtube: defaultYoutubeScopes, whatsapp: defaultWhatsAppScopes,
}

/**
 * Scopes the engine asks for only because of comment replies.
 * Until a provider's consent screen or app review grants them, pin the
 * provider app's scopes without them, so connecting keeps working.
 * `instagram_manage_comments` and `instagram_business_manage_comments` were
 * already asked for, to read comments.
 */
export const replyOnlyScopes: Partial<Record<Platform, readonly string[]>> = {
  meta: ['pages_manage_engagement'], youtube: [youtubeReplyScope],
}

/** Google scopes may be given by their last part (`youtube.upload`); others as the platform names them. */
export function expandScope(platform: Platform, scope: string) {
  const value = scope.trim()
  return platform === 'youtube' && !value.includes('/') ? `${googleScopePrefix}${value}` : value
}

/** The scopes to pin: the defaults without the reply-only ones, or the list given. */
export function scopesToPin(platform: Platform, choice: { withoutReplies: true } | { scopes: string[] }) {
  const defaults = defaultScopes[platform]
  if (!defaults) throw new Error(`${platform} provider apps have no OAuth scopes`)
  const scopes = 'scopes' in choice ? choice.scopes.filter(scope => scope.trim()).map(scope => expandScope(platform, scope))
    : defaults.filter(scope => !replyOnlyScopes[platform]?.includes(scope))
  if (!scopes.length) throw new Error('At least one scope is needed')
  return [...new Set(scopes)]
}

/**
 * Pins a provider app's scopes (`scopes`), or unpins them (`null`) so it asks
 * for the engine's defaults again. Other settings are kept. Returns what the
 * app asks for from now on, and whether that is pinned.
 */
export async function pinProviderScopes(executor: Executor, id: string, scopes: string[] | null) {
  const [app] = await executor.select().from(providerApps).where(eq(providerApps.id, id)).limit(1)
  if (!app) throw notFound('Provider app')
  const settings = { ...app.settings }
  if (scopes) settings.scopes = scopes
  else delete settings.scopes
  await executor.update(providerApps).set({ settings, updatedAt: sql`now()` }).where(eq(providerApps.id, id))
  return { platform: app.platform, pinned: Boolean(scopes), scopes: scopes ?? [...defaultScopes[app.platform] ?? []] }
}

/** What a provider app asks for now. */
export async function providerScopes(executor: Executor, id: string) {
  const [app] = await executor.select().from(providerApps).where(eq(providerApps.id, id)).limit(1)
  if (!app) throw notFound('Provider app')
  return { platform: app.platform, pinned: Boolean(app.settings.scopes), scopes: app.settings.scopes ?? [...defaultScopes[app.platform] ?? []] }
}
