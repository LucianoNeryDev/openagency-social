import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openSealedSecret, runnerKeyPair, sealSecret } from '../src/crypto/sealed.js'
import type { Database } from '../src/db/client.js'
import { browserAccounts, events } from '../src/db/schema.js'
import { resealBrowserAccounts } from '../src/vault.js'
import { sealLegacySecret } from './fixtures/legacy-seal.js'
import { postgresFixture } from './fixtures/postgres.js'

const required = process.env.REQUIRE_DATABASE_TESTS === 'true'
const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

describe.skipIf(!required)('vault reseal on PostgreSQL 17', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>
  let db: Database
  const runner = runnerKeyPair()
  const org = 'org-reseal'
  const secretFor = (handle: string) => JSON.stringify({ username: handle, password: `password of ${handle} ✓` })
  const legacyHandles = ['l1', 'l2', 'l3', 'l4', 'l5']
  const currentHandles = ['c1', 'c2']

  beforeAll(async () => {
    fixture = await postgresFixture()
    db = fixture.db
    const updatedAt = new Date('2030-01-01T10:00:00Z')
    const row = (handle: string, seal: typeof sealSecret, publicKey = runner.publicKey) => {
      const id = crypto.randomUUID()
      return { id, organizationId: org, platform: 'tiktok' as const, handle, status: 'active' as const, updatedAt, ...seal(publicKey, id, secretFor(handle)) }
    }
    await db.insert(browserAccounts).values([
      ...legacyHandles.map(handle => row(handle, sealLegacySecret)),
      ...currentHandles.map(handle => row(handle, sealSecret)),
      // Sealed to another runner: neither label opens it with this runner's key.
      row('elsewhere', sealSecret, runnerKeyPair().publicKey),
    ])
  }, 120_000)
  afterAll(async () => { await fixture?.cleanup() }, 30_000)

  const snapshot = () => db.select().from(browserAccounts).orderBy(asc(browserAccounts.id))
  const resealEvents = () => db.select().from(events).where(eq(events.kind, 'browser_account.resealed'))
  const labels = (rows: Awaited<ReturnType<typeof snapshot>>) => Object.fromEntries(rows.map((row) => {
    try {
      const opened = openSealedSecret(runner.privateKey, row.id, row)
      expect(opened.plaintext).toBe(secretFor(row.handle))
      return [row.handle, opened.label]
    } catch {
      return [row.handle, 'unopenable']
    }
  }))

  it('reports in a dry run and changes nothing', async () => {
    const before = await snapshot()
    const batches: number[] = []
    const result = await resealBrowserAccounts(db, runner.privateKey, { dryRun: true, batchSize: 3, onBatch: progress => batches.push(progress.checked) })
    expect(result).toEqual({ checked: 8, current: 2, resealed: 5, unopenable: [before.find(row => row.handle === 'elsewhere')!.id] })
    expect(batches).toEqual([3, 6, 8])
    expect(await snapshot()).toEqual(before)
    expect(await resealEvents()).toEqual([])
  })

  it('re-seals legacy rows through the CLI in small batches, keeping plaintext, status and updated_at', async () => {
    const before = await snapshot()
    const { host, port, user, password, database } = fixture.runtime.options
    const databaseUrl = `postgres://${user}:${password}@${host}:${port}/${database}`
    const failure = await run(process.execPath, ['--import', 'tsx', 'src/cli/vault.ts', 'reseal', '--batch-size', '2'],
      { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl, RUNNER_PRIVATE_KEY: runner.privateKey } }).then(() => undefined, (error: unknown) => error)
    // The row sealed to another runner makes the command exit 1, after re-sealing the rest.
    expect(failure).toMatchObject({ code: 1 })
    const { stdout } = failure as { stdout: string }
    expect(stdout).toContain('checked 8, already current 2, resealed 5, unopenable 1')
    expect(stdout).toContain(`unopenable browser account ${before.find(row => row.handle === 'elsewhere')!.id}`)
    expect(stdout).not.toContain('password of')

    const after = await snapshot()
    expect(labels(after)).toEqual({ l1: 'current', l2: 'current', l3: 'current', l4: 'current', l5: 'current', c1: 'current', c2: 'current', elsewhere: 'unopenable' })
    for (const row of after) {
      const old = before.find(value => value.id === row.id)!
      expect({ status: row.status, updatedAt: row.updatedAt }).toEqual({ status: old.status, updatedAt: old.updatedAt })
      // Only legacy rows get new ciphertext.
      expect(row.ciphertext.equals(old.ciphertext)).toBe(!legacyHandles.includes(row.handle))
    }
    const recorded = await resealEvents()
    expect(recorded.map(event => (event.detail as { browserAccountId: string }).browserAccountId).sort())
      .toEqual(after.filter(row => legacyHandles.includes(row.handle)).map(row => row.id).sort())
    expect(recorded.every(event => event.organizationId === org)).toBe(true)
  }, 60_000)

  it('changes nothing on a second run', async () => {
    const before = await snapshot()
    const result = await resealBrowserAccounts(db, runner.privateKey, { batchSize: 2 })
    expect(result).toMatchObject({ checked: 8, current: 7, resealed: 0 })
    expect(result.unopenable).toHaveLength(1)
    expect(await snapshot()).toEqual(before)
    expect(await resealEvents()).toHaveLength(legacyHandles.length)
  })

  it('refuses to run without a usable runner private key and never echoes it', async () => {
    const failure = await run(process.execPath, ['--import', 'tsx', 'src/cli/vault.ts', 'reseal', '--dry-run'],
      { cwd: root, env: { ...process.env, DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', RUNNER_PRIVATE_KEY: 'c2VjcmV0LW5vdC1hLWtleQ' } })
      .then(() => undefined, (error: unknown) => error) as { code: number, stderr: string } | undefined
    expect(failure?.code).not.toBe(0)
    expect(failure?.stderr).toContain('RUNNER_PRIVATE_KEY is missing or not an X25519 private key')
    expect(failure?.stderr).not.toContain('c2VjcmV0LW5vdC1hLWtleQ')
  }, 60_000)
})
