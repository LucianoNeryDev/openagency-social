import { describe, expect, it } from 'vitest'
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto'
import { isRunnerPublicKey, openSealedSecret, openSecret, runnerKeyPair, runnerPublicKeyFor, sealSecret, type SealedSecret } from '../src/crypto/sealed.js'
import { sealLegacySecret } from './fixtures/legacy-seal.js'

const secret = JSON.stringify({ username: 'bottega.digitale', password: 'correct horse battery staple', totp: 'JBSWY3DPEHPK3PXP' })

describe('sealed secrets', () => {
  const runner = runnerKeyPair()

  it('opens with the runner key and never repeats ciphertext', () => {
    const first = sealSecret(runner.publicKey, 'account-1', secret)
    const second = sealSecret(runner.publicKey, 'account-1', secret)
    expect(openSecret(runner.privateKey, 'account-1', first)).toBe(secret)
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false)
    expect(first.ciphertext.includes(Buffer.from('correct horse'))).toBe(false)
  })

  it('refuses another account, another runner and tampered blobs', () => {
    const sealed = sealSecret(runner.publicKey, 'account-1', secret)
    expect(() => openSecret(runner.privateKey, 'account-2', sealed)).toThrow()
    expect(() => openSecret(runnerKeyPair().privateKey, 'account-1', sealed)).toThrow()
    const flipped = Buffer.from(sealed.ciphertext)
    flipped[0]! ^= 1
    expect(() => openSecret(runner.privateKey, 'account-1', { ...sealed, ciphertext: flipped })).toThrow()
    expect(() => openSecret(runner.privateKey, 'account-1', { ...sealed, nonce: Buffer.alloc(8) })).toThrow('Malformed')
  })

  it('opens blobs sealed under the pre-rename label and says so', () => {
    const legacy = sealLegacySecret(runner.publicKey, 'account-1', secret)
    expect(openSecret(runner.privateKey, 'account-1', legacy)).toBe(secret)
    expect(openSealedSecret(runner.privateKey, 'account-1', legacy)).toEqual({ plaintext: secret, label: 'legacy' })
    expect(() => openSecret(runner.privateKey, 'account-2', legacy)).toThrow()
  })

  it('seals under the current label only', () => {
    const sealed = sealSecret(runner.publicKey, 'account-1', secret)
    expect(openSealedSecret(runner.privateKey, 'account-1', sealed)).toEqual({ plaintext: secret, label: 'current' })
    // An independent derivation: the current label opens it, the pre-rename one does not.
    expect(openWithLabel(runner.privateKey, 'openagency-social-vault v1', 'account-1', sealed)).toBe(secret)
    expect(() => openWithLabel(runner.privateKey, 'leonessa-vault v1', 'account-1', sealed)).toThrow()
  })

  it('fails as before when neither label authenticates', () => {
    for (const sealed of [sealSecret(runner.publicKey, 'account-1', secret), sealLegacySecret(runner.publicKey, 'account-1', secret)]) {
      const flipped = Buffer.from(sealed.ciphertext)
      flipped[flipped.length - 1]! ^= 1
      expect(() => openSealedSecret(runner.privateKey, 'account-1', { ...sealed, ciphertext: flipped })).toThrow('unable to authenticate data')
      expect(() => openSecret(runnerKeyPair().privateKey, 'account-1', sealed)).toThrow('unable to authenticate data')
    }
  })

  it('derives the public key from the private key', () => {
    expect(runnerPublicKeyFor(runner.privateKey)).toBe(runner.publicKey)
    expect(() => runnerPublicKeyFor('not-a-key')).toThrow()
  })

  it('recognises runner public keys', () => {
    expect(isRunnerPublicKey(runner.publicKey)).toBe(true)
    expect(isRunnerPublicKey('not-a-key')).toBe(false)
    expect(isRunnerPublicKey(Buffer.alloc(31).toString('base64url'))).toBe(false)
  })
})

function openWithLabel(runnerPrivateKey: string, label: string, accountId: string, sealed: SealedSecret) {
  const privateKey = createPrivateKey({ key: Buffer.from(runnerPrivateKey, 'base64'), format: 'der', type: 'pkcs8' })
  const ephemeral = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: sealed.ephemeralPublicKey.toString('base64url') }, format: 'jwk' })
  const salt = Buffer.concat([sealed.ephemeralPublicKey, Buffer.from(runnerPublicKeyFor(runnerPrivateKey), 'base64url')])
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey: ephemeral }), salt, `${label}:${accountId}`, 32))
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: 16 })
  decipher.setAAD(Buffer.from(`account:${accountId}`))
  decipher.setAuthTag(sealed.ciphertext.subarray(-16))
  return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8')
}
