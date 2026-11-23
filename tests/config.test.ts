import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  DATABASE_URL: 'postgresql://runtime:pw@127.0.0.1:5432/openagency_social',
  SERVICE_TOKEN: 's'.repeat(40),
  TOKEN_KEYS: JSON.stringify({ k1: randomBytes(32).toString('base64') }),
  TOKEN_KEY_ACTIVE: 'k1',
  META_REDIRECT_URI: 'https://api.example.com/api/social/connect/meta/callback',
  PROVIDER_APP_SECRETS: JSON.stringify({ 'meta-bottega': 'app-secret-value' }),
}

describe('configuration', () => {
  it('loads a valid environment with loopback defaults', () => {
    const config = loadConfig(base)
    expect(config.host).toBe('127.0.0.1')
    expect(config.providerSecrets.get('meta-bottega')).toBe('app-secret-value')
    expect(config.meta.graphVersion).toBe('v26.0')
  })

  it('refuses to bind outside loopback', () => {
    expect(() => loadConfig({ ...base, HOST: '0.0.0.0' })).toThrow('HOST')
  })

  it('names invalid variables without echoing secret values', () => {
    try {
      loadConfig({ ...base, SERVICE_TOKEN: 'short-secret-value' })
      expect.unreachable()
    } catch (error) {
      expect(String(error)).toContain('SERVICE_TOKEN')
      expect(String(error)).not.toContain('short-secret-value')
    }
  })

  it('rejects keys that are not 32 bytes and a missing active key', () => {
    expect(() => loadConfig({ ...base, TOKEN_KEYS: JSON.stringify({ k1: 'c2hvcnQ=' }) })).toThrow('TOKEN_KEYS')
    expect(() => loadConfig({ ...base, TOKEN_KEY_ACTIVE: 'k2' })).toThrow('TOKEN_KEY_ACTIVE')
  })

  it('requires an HTTPS redirect URI', () => {
    expect(() => loadConfig({ ...base, META_REDIRECT_URI: 'http://example.com/callback' })).toThrow('META_REDIRECT_URI')
  })
})
