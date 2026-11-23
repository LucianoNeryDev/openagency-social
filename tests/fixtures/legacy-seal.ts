import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import type { SealedSecret } from '../../src/crypto/sealed.js'

/**
 * `sealSecret` as it was before the rename to OpenAgency, with the
 * `leonessa-vault v1` HKDF label, kept here byte for byte so the tests seal
 * real legacy blobs instead of going through the code under test.
 */
export function sealLegacySecret(runnerPublicKey: string, accountId: string, plaintext: string): SealedSecret {
  const recipient = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: runnerPublicKey }, format: 'jwk' })
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublicKey = Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient })
  const salt = Buffer.concat([ephemeralPublicKey, Buffer.from(runnerPublicKey, 'base64url')])
  const key = Buffer.from(hkdfSync('sha256', shared, salt, `leonessa-vault v1:${accountId}`, 32))
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(`account:${accountId}`))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { ephemeralPublicKey, nonce, ciphertext }
}
