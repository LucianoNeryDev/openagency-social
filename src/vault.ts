import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { clock, recordEvent, type EngineContext } from './context.js'
import { openSealedSecret, runnerPublicKeyFor, sealSecret } from './crypto/sealed.js'
import type { Database, Executor } from './db/client.js'
import { browserAccounts, browserPlatforms, channels } from './db/schema.js'
import { EngineError, notFound } from './errors.js'
import { browserChannelKind } from './platforms/browser/rules.js'
import { changeChannelStatus } from './webhooks.js'

/** What a browser account's sealed secret holds. Only the runner ever reads it. */
export const accountSecretSchema = z.strictObject({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
  // Base32 TOTP seed, so the runner can answer two-factor prompts itself.
  totp: z.string().regex(/^[A-Z2-7]{16,128}=*$/).optional(),
})
export type AccountSecret = z.infer<typeof accountSecretSchema>

export const accountInputSchema = z.object({
  organizationId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  platform: z.enum(browserPlatforms),
  handle: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
})

/**
 * Seals and stores a login. Replacing it keeps the account ID, so channels
 * pointing at the account keep working, and asks for a fresh browser login.
 */
export async function putBrowserAccount(executor: Executor, runnerPublicKey: string, input: z.infer<typeof accountInputSchema>, secret: AccountSecret) {
  const [existing] = await executor.select({ id: browserAccounts.id }).from(browserAccounts).where(and(eq(browserAccounts.organizationId, input.organizationId),
    eq(browserAccounts.platform, input.platform), eq(browserAccounts.handle, input.handle))).limit(1)
  const id = existing?.id ?? randomUUID()
  const sealed = sealSecret(runnerPublicKey, id, JSON.stringify(accountSecretSchema.parse(secret)))
  const values = { ephemeralPublicKey: sealed.ephemeralPublicKey, nonce: sealed.nonce, ciphertext: sealed.ciphertext, status: 'needs_login' as const, updatedAt: new Date() }
  await executor.insert(browserAccounts).values({ id, ...input, ...values })
    .onConflictDoUpdate({ target: [browserAccounts.organizationId, browserAccounts.platform, browserAccounts.handle], set: values })
  await recordEvent(executor, { organizationId: input.organizationId, kind: existing ? 'browser_account.replaced' : 'browser_account.created',
    detail: { browserAccountId: id, platform: input.platform, handle: input.handle } })
  return { id, created: !existing }
}

export async function listBrowserAccounts(executor: Executor, organizationId: string) {
  return executor.select({ id: browserAccounts.id, platform: browserAccounts.platform, handle: browserAccounts.handle,
    status: browserAccounts.status, updatedAt: browserAccounts.updatedAt }).from(browserAccounts)
    .where(eq(browserAccounts.organizationId, organizationId)).orderBy(browserAccounts.platform, browserAccounts.handle)
}

export function runnerAccount(account: typeof browserAccounts.$inferSelect) {
  return { id: account.id, platform: account.platform, handle: account.handle, sealed: {
    ephemeralPublicKey: account.ephemeralPublicKey.toString('base64'), nonce: account.nonce.toString('base64'), ciphertext: account.ciphertext.toString('base64') } }
}

async function ownedAccount(executor: Executor, organizationId: string, accountId: string) {
  const [account] = await executor.select().from(browserAccounts)
    .where(and(eq(browserAccounts.organizationId, organizationId), eq(browserAccounts.id, accountId))).limit(1)
  if (!account) throw notFound('Browser account')
  return account
}

function runnerFor(context: EngineContext) {
  if (!context.runner) throw new EngineError(503, 'runner_unavailable', 'The browser runner is not configured')
  return context.runner
}

/** Asks the runner to sign the account in; a person finishes any checkpoint on noVNC. */
export async function startBrowserLogin(context: EngineContext, organizationId: string, accountId: string) {
  const account = await ownedAccount(context.db, organizationId, accountId)
  const action = await runnerFor(context).submit({ actionId: `login-${account.id}-${clock(context).getTime()}`, kind: 'login', account: runnerAccount(account), content: '', media: [] })
  await recordEvent(context.db, { organizationId, kind: 'browser_account.login_requested', detail: { browserAccountId: account.id, runnerActionId: action.id } })
  return { runnerActionId: action.id, state: action.state }
}

/** Reads a login action; success activates the account and the channel it backs. */
export async function checkBrowserLogin(context: EngineContext, organizationId: string, accountId: string, runnerActionId: string) {
  const account = await ownedAccount(context.db, organizationId, accountId)
  const action = await runnerFor(context).get(runnerActionId)
  if (action.accountId !== account.id || action.kind !== 'login') throw notFound('Login')
  if (action.state === 'succeeded' && account.status !== 'active') {
    await context.db.transaction(async (transaction) => {
      await transaction.update(browserAccounts).set({ status: 'active', updatedAt: clock(context) }).where(eq(browserAccounts.id, account.id))
      const linked = await transaction.select({ id: channels.id }).from(channels).where(eq(channels.browserAccountId, account.id))
      for (const channel of linked) await changeChannelStatus(transaction, channel.id, 'active', 'logged_in', clock(context))
      await recordEvent(transaction, { organizationId, kind: 'browser_account.logged_in', detail: { browserAccountId: account.id, runnerActionId } })
    })
  }
  return { runnerActionId: action.id, state: action.state, takeover: action.takeover, error: action.error }
}

export const linkOptionsSchema = z.object({
  // A LinkedIn Page the account administers: its numeric company ID.
  page: z.string().regex(/^\d{1,20}$/).optional(),
  name: z.string().trim().min(1).max(200).optional(),
})

/**
 * Creates the channel a browser account publishes through. A LinkedIn
 * account publishes to its member profile, or to `page` when given.
 */
export async function linkBrowserChannel(executor: Executor, organizationId: string, accountId: string, options: z.infer<typeof linkOptionsSchema> = {}) {
  const account = await ownedAccount(executor, organizationId, accountId)
  const { page, name } = linkOptionsSchema.parse(options)
  const [channel] = await executor.insert(channels).values({
    organizationId, browserAccountId: account.id, platform: account.platform, kind: browserChannelKind(account.platform, page),
    externalId: page ?? account.handle, name: name ?? (page ? `LinkedIn Page ${page}` : `@${account.handle}`), status: account.status === 'active' ? 'active' : 'needs_reauth',
  }).onConflictDoNothing().returning({ id: channels.id })
  if (channel) await recordEvent(executor, { organizationId, kind: 'channel.connected', channelId: channel.id, detail: { browserAccountId: account.id } })
  const [existing] = await executor.select({ id: channels.id }).from(channels).where(eq(channels.browserAccountId, account.id)).limit(1)
  return { channelId: existing!.id, created: Boolean(channel) }
}

export interface ResealResult {
  /** Rows read. */
  checked: number
  /** Already sealed under the current label. */
  current: number
  /** Sealed under the legacy label: re-sealed, or in a dry run, would be. */
  resealed: number
  /** Opened under neither label (another runner key, or damaged): left as they are. */
  unopenable: string[]
}

/**
 * Re-seals every browser login still under the legacy HKDF label with the
 * current one, `batchSize` rows per transaction. Each batch is locked while
 * it is read and written, so a concurrent `vault put` is never overwritten.
 * The plaintext, status and `updated_at` stay the same; each re-sealed row
 * records `browser_account.resealed`. Idempotent: a second run finds every
 * row current. Needs the runner's private key, which the engine never holds.
 */
export async function resealBrowserAccounts(db: Database, runnerPrivateKey: string, options: { dryRun?: boolean, batchSize?: number, onBatch?: (progress: ResealResult) => void } = {}): Promise<ResealResult> {
  const runnerPublicKey = runnerPublicKeyFor(runnerPrivateKey)
  const batchSize = options.batchSize ?? 50
  const result: ResealResult = { checked: 0, current: 0, resealed: 0, unopenable: [] }
  let after = ''
  for (;;) {
    const count = await db.transaction(async (transaction) => {
      const query = transaction.select({ id: browserAccounts.id, organizationId: browserAccounts.organizationId, ephemeralPublicKey: browserAccounts.ephemeralPublicKey,
        nonce: browserAccounts.nonce, ciphertext: browserAccounts.ciphertext }).from(browserAccounts)
        .where(after ? gt(browserAccounts.id, after) : undefined).orderBy(asc(browserAccounts.id)).limit(batchSize)
      const rows = options.dryRun ? await query : await query.for('update')
      for (const row of rows) {
        result.checked++
        let opened: ReturnType<typeof openSealedSecret>
        try {
          opened = openSealedSecret(runnerPrivateKey, row.id, row)
        } catch {
          result.unopenable.push(row.id)
          continue
        }
        if (opened.label === 'current') {
          result.current++
          continue
        }
        result.resealed++
        if (options.dryRun) continue
        const sealed = sealSecret(runnerPublicKey, row.id, opened.plaintext)
        await transaction.update(browserAccounts).set({ ephemeralPublicKey: sealed.ephemeralPublicKey, nonce: sealed.nonce, ciphertext: sealed.ciphertext })
          .where(eq(browserAccounts.id, row.id))
        await recordEvent(transaction, { organizationId: row.organizationId, kind: 'browser_account.resealed', detail: { browserAccountId: row.id } })
      }
      if (rows.length > 0) after = rows.at(-1)!.id
      return rows.length
    })
    if (count > 0) options.onBatch?.({ ...result, unopenable: [...result.unopenable] })
    if (count < batchSize) return result
  }
}
