import { describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { isRunnerPublicKey, openSecret, runnerKeyPair, runnerPublicKeyFor, sealSecret, type SealedSecret } from '../src/crypto/sealed.js'

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

  it('seals under the openagency-social-vault label only', () => {
    const sealed = sealSecret(runner.publicKey, 'account-1', secret)
    // An independent derivation: the label opens it, any other does not.
    expect(openWithLabel(runner.privateKey, 'openagency-social-vault v1', 'account-1', sealed)).toBe(secret)
    expect(() => openWithLabel(runner.privateKey, 'another-vault v1', 'account-1', sealed)).toThrow()
  })

  it('opens nothing sealed under another label', () => {
    const other = sealWithLabel(runner.publicKey, 'another-vault v1', 'account-1', secret)
    expect(openWithLabel(runner.privateKey, 'another-vault v1', 'account-1', other)).toBe(secret)
    expect(() => openSecret(runner.privateKey, 'account-1', other)).toThrow('unable to authenticate data')
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

function sealWithLabel(runnerPublicKey: string, label: string, accountId: string, plaintext: string): SealedSecret {
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublicKey = Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const recipient = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: runnerPublicKey }, format: 'jwk' })
  const salt = Buffer.concat([ephemeralPublicKey, Buffer.from(runnerPublicKey, 'base64url')])
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), salt, `${label}:${accountId}`, 32))
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(`account:${accountId}`))
  return { ephemeralPublicKey, nonce, ciphertext: Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]) }
}
