import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backupRole, createDatabase, migrationsFolder, migratorRole, postgresFixture, runtimeRole } from './fixtures/postgres.js'

const required = process.env.REQUIRE_DATABASE_TESTS === 'true'
const scratch = 'openagency_social_settings'

describe.skipIf(!required)('migrations on PostgreSQL 17', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>

  beforeAll(async () => {
    fixture = await postgresFixture()
  }, 180_000)

  afterAll(async () => {
    await fixture?.admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined)
    await fixture?.cleanup()
  }, 60_000)

  const privileges = async (role: string, kind: 'table' | 'sequence') => {
    const { rows } = await fixture.migrator.query<{ name: string, select: boolean, insert: boolean, delete: boolean, usage: boolean }>(kind === 'table'
      ? `SELECT c.relname AS name, has_table_privilege($1, c.oid, 'SELECT') AS select, has_table_privilege($1, c.oid, 'INSERT') AS insert,
           has_table_privilege($1, c.oid, 'DELETE') AS delete, false AS usage
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`
      : `SELECT c.relname AS name, has_sequence_privilege($1, c.oid, 'SELECT') AS select, false AS insert, false AS delete,
           has_sequence_privilege($1, c.oid, 'USAGE') AS usage
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1`, [role])
    return rows
  }

  it('grant every table to the runtime role and read-only to the backup role, from the settings alone', async () => {
    const runtimeTables = await privileges(runtimeRole, 'table')
    expect(runtimeTables.length).toBeGreaterThan(20)
    for (const table of runtimeTables) {
      expect(table, table.name).toMatchObject({ select: true, insert: true, delete: table.name !== 'events' })
    }
    for (const table of await privileges(backupRole, 'table')) expect(table, table.name).toMatchObject({ select: true, insert: false, delete: false })
    for (const sequence of await privileges(runtimeRole, 'sequence')) expect(sequence, sequence.name).toMatchObject({ usage: true })
    for (const sequence of await privileges(backupRole, 'sequence')) expect(sequence, sequence.name).toMatchObject({ select: true, usage: false })
  })

  it('refuse to run until every setting names an existing role and the migrator runs them', async () => {
    await createDatabase(fixture.admin, scratch, {})
    // The database's own error, not drizzle's wrapper (whose message quotes the whole migration).
    const attempt = async () => {
      // Database settings reach new sessions only, so each attempt connects again.
      const migrator = fixture.pool(migratorRole, scratch)
      try {
        await migrate(drizzle(migrator), { migrationsFolder })
        return 'migrated'
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
        return cause instanceof Error ? cause.message : String(cause)
      } finally {
        await migrator.end()
      }
    }
    const set = (name: string, role: string) =>
      fixture.admin.query(`ALTER DATABASE ${scratch} SET openagency.${name}_role = ${pg.escapeLiteral(role)}`)

    expect(await attempt()).toBe('database setting openagency.migrator_role is not set')
    await set('migrator', runtimeRole)
    expect(await attempt()).toBe(`migrations run as ${runtimeRole} (openagency.migrator_role), not as ${migratorRole}`)
    await set('migrator', migratorRole)
    expect(await attempt()).toBe('database setting openagency.runtime_role is not set')
    await set('runtime', 'no_such_role')
    expect(await attempt()).toBe('runtime role no_such_role (openagency.runtime_role) does not exist')
    await set('runtime', migratorRole)
    expect(await attempt()).toBe('runtime role must differ from the migrator')
    await set('runtime', runtimeRole)
    await set('backup', 'no_such_backup')
    expect(await attempt()).toBe('backup role no_such_backup (openagency.backup_role) does not exist')
    // A backup role is optional.
    await fixture.admin.query(`ALTER DATABASE ${scratch} RESET openagency.backup_role`)
    expect(await attempt()).toBe('migrated')
    // Applied migrations never run again: drizzle compares timestamps, not file contents, so an
    // existing database is unaffected by later edits to them or by its settings.
    await set('runtime', 'no_such_role')
    expect(await attempt()).toBe('migrated')
  })
})
