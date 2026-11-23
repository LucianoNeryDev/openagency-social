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
// Label of the fixture before the rename to OpenAgency Social; cleanup still removes containers that carry it.
const legacyLabel = 'banditore-test=postgres'

const roles = ['social_engine_migrator', 'social_engine_runtime']
const databaseName = 'leonessa_social_engine'

/**
 * A PostgreSQL 17 database with migrator and runtime roles. By default it is a disposable
 * container. When BANDITORE_TEST_POSTGRES_URL names a PostgreSQL server (a superuser URL, as a CI
 * service container provides), that server is used instead and the database and roles are dropped
 * again afterwards; migrations fix their names, so run the suites one at a time against it.
 */
export async function postgresFixture() {
  const external = process.env.BANDITORE_TEST_POSTGRES_URL ? new URL(process.env.BANDITORE_TEST_POSTGRES_URL) : undefined
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
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
    for (const role of roles) await adminPool.query(`DROP ROLE IF EXISTS ${role}`)
  }
  // Containers left behind by runs from before the label was renamed would otherwise stay on a runner for good.
  async function removeLegacyContainers() {
    try {
      const orphans = (await command('docker', ['ps', '-aq', '--filter', `label=${legacyLabel}`])).stdout.split('\n').filter(Boolean)
      if (orphans.length > 0) await command('docker', ['rm', '-fv', ...orphans])
    } catch { /* best effort: a failed sweep must not fail the suite */ }
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
    await removeLegacyContainers()
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
    await admin.query(`CREATE DATABASE ${databaseName} OWNER social_engine_migrator`)
    await admin.query(`REVOKE ALL ON DATABASE ${databaseName} FROM PUBLIC`)
    await admin.query(`GRANT CONNECT ON DATABASE ${databaseName} TO social_engine_migrator, social_engine_runtime`)
    const migrator = pool('social_engine_migrator', databaseName)
    await migrate(drizzle(migrator), { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })
    const runtime = pool('social_engine_runtime', databaseName)
    return { cleanup, migrator, runtime, db: drizzle(runtime, { schema }), pool }
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
}
