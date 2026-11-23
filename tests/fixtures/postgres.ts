import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from '../../src/db/schema.js'

const command = promisify(execFile)
// Same pinned PostgreSQL 17 image as the control plane's database tests.
const image = 'postgres:17@sha256:aa90e97ee862e558111d34cfb8b2c4bec768c2b039fb791341686928560263b3'
const label = 'social-test=postgres'

export const migratorRole = 'social_migrator'
export const runtimeRole = 'social_runtime'
export const backupRole = 'social_backup'
const roles = [migratorRole, runtimeRole, backupRole]
const databaseName = 'openagency_social'
export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

/**
 * A PostgreSQL 17 database with migrator, runtime and backup roles, named to the migrations through
 * the openagency.*_role database settings as an operator would (docs/deploy.md). By default it is a
 * disposable container. When SOCIAL_TEST_POSTGRES_URL names a PostgreSQL server (a superuser URL, as
 * a CI service container provides), that server is used instead and the database and roles are
 * dropped again afterwards; their names are fixed, so run the suites one at a time against it.
 */
export async function postgresFixture() {
  const externalUrl = process.env.SOCIAL_TEST_POSTGRES_URL
  const external = externalUrl ? new URL(externalUrl) : undefined
  const password = randomBytes(24).toString('hex')
  const pools: pg.Pool[] = []
  let id: string | undefined
  let port = Number(external?.port || 5432)
  const host = external?.hostname ?? '127.0.0.1'
  const pool = (user: string, database: string, secret = password) => {
    const created = new pg.Pool({ host, port, user, password: secret, database, connectionTimeoutMillis: 10_000, max: 10 })
    // A server that drops its connections at teardown must not surface as an unhandled error.
    created.on('error', () => undefined)
    pools.push(created)
    return created
  }
  let adminPool: pg.Pool | undefined
  async function dropExternal() {
    if (!adminPool) return
    // Every database the migrator owns: this one and any a suite made beside it.
    const owned = await adminPool.query<{ name: string }>(
      'SELECT d.datname AS name FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = $1', [migratorRole])
    for (const { name } of owned.rows) await adminPool.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`)
    for (const role of roles) await adminPool.query(`DROP ROLE IF EXISTS ${role}`)
  }
  async function cleanup() {
    await Promise.all(pools.filter(value => value !== adminPool).map(value => value.end().catch(() => undefined)))
    if (external) {
      await dropExternal().catch(() => undefined)
      await adminPool?.end().catch(() => undefined)
      return
    }
    await adminPool?.end().catch(() => undefined)
    if (!id) return
    const inspection = JSON.parse((await command('docker', ['inspect', id])).stdout)[0]
    if (inspection.Config.Labels['social-test'] !== 'postgres') throw new Error('Fixture ownership mismatch')
    await command('docker', ['rm', '-fv', id])
  }
  try {
    if (!external) {
      id = (await command('docker', ['run', '-d', '--label', label, '-e', 'POSTGRES_USER=bootstrap', '-e', `POSTGRES_PASSWORD=${password}`,
        '-e', 'POSTGRES_DB=postgres', '-p', '127.0.0.1::5432', image])).stdout.trim()
      port = Number((await command('docker', ['port', id, '5432'])).stdout.trim().split('\n')[0]!.split(':').at(-1))
    }
    const admin = external
      ? pool(decodeURIComponent(external.username), external.pathname.slice(1) || 'postgres', decodeURIComponent(external.password))
      : pool('bootstrap', 'postgres')
    adminPool = admin
    let ready = false
    // Up to 90 s: a loaded machine can take longer than half a minute to start the container.
    for (let retry = 0; retry < 450 && !ready; retry++) {
      try { await admin.query('select 1'); ready = true } catch { await new Promise(resolve => setTimeout(resolve, 200)) }
    }
    if (!ready) throw new Error('Fixture not ready')
    if (external) await dropExternal()
    for (const role of roles) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
    }
    await createDatabase(admin, databaseName, { migrator: migratorRole, runtime: runtimeRole, backup: backupRole })
    const migrator = pool(migratorRole, databaseName)
    await migrate(drizzle(migrator), { migrationsFolder })
    const runtime = pool(runtimeRole, databaseName)
    return { cleanup, admin, migrator, runtime, db: drizzle(runtime, { schema }), pool }
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
}

/**
 * Creates a database owned by the migrator, open only to the migrator and runtime roles, with the
 * openagency.*_role settings the migrations read. A setting left out is not set.
 */
export async function createDatabase(admin: pg.Pool, name: string, settings: { migrator?: string, runtime?: string, backup?: string }) {
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(name)} OWNER ${pg.escapeIdentifier(migratorRole)}`)
  await admin.query(`REVOKE ALL ON DATABASE ${pg.escapeIdentifier(name)} FROM PUBLIC`)
  await admin.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(name)} TO ${pg.escapeIdentifier(migratorRole)}, ${pg.escapeIdentifier(runtimeRole)}`)
  for (const [key, role] of Object.entries(settings)) {
    if (role !== undefined) await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(name)} SET openagency.${key}_role = ${pg.escapeLiteral(role)}`)
  }
}
