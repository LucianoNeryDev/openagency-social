import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { migrationsFolder } from './fixtures/postgres.js'

const migrations = readdirSync(migrationsFolder).filter(name => name.endsWith('.sql')).sort()
  .map(name => ({ name, sql: readFileSync(`${migrationsFolder}/${name}`, 'utf8') }))

describe('migrations', () => {
  it('name no database or role: the operator names the roles in database settings', () => {
    expect(migrations.length).toBeGreaterThan(0)
    for (const { name, sql } of migrations) {
      for (const literal of ['leonessa_', 'dashboard_', 'email_engine_', 'social_engine_', '_production', '_staging', 'current_database()']) {
        expect(sql.includes(literal), `${name} contains ${literal}`).toBe(false)
      }
    }
  })

  it('grant only to the roles in the openagency.*_role settings, after checking the migrator', () => {
    for (const { name, sql } of migrations.filter(migration => /\bGRANT\b/.test(migration.sql))) {
      expect(sql, name).toContain(`current_setting('openagency.runtime_role', true)`)
      expect(sql, name).toContain(`current_setting('openagency.backup_role', true)`)
      expect(sql, name).toContain(`IF current_user::text <> migrator_role THEN`)
      // Every role reaches dynamic SQL quoted as an identifier.
      for (const statement of sql.match(/EXECUTE format\('[^']*'/g) ?? []) expect(statement, name).not.toMatch(/TO (?!%I)/)
    }
  })
})
