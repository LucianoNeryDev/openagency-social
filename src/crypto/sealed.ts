import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto'

/**
 * Secrets sealed to the browser runner: anyone with its public key can seal,
 * only the runner's private key opens. Ephemeral X25519, HKDF-SHA256 and
 * AES-256-GCM; the account ID is bound into the key and the associated data,
 * so a blob copied onto another account fails to open. The HKDF info label
 * is `openagency-social-vault v1:<account>`.
 */
export interface SealedSecret {
  ephemeralPublicKey: Buffer
  nonce: Buffer
  ciphertext: Buffer
}

const tagLength = 16
const label = 'openagency-social-vault v1'

/** A new runner key pair: the public key as base64url raw X25519, the private key as base64 PKCS#8. */
export function runnerKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { publicKey: rawPublicKey(publicKey), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }
}

export function sealSecret(runnerPublicKey: string, accountId: string, plaintext: string): SealedSecret {
  const recipient = publicKeyObject(runnerPublicKey)
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublicKey = Buffer.from(rawPublicKey(ephemeral.publicKey), 'base64url')
  const key = deriveKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), ephemeralPublicKey, runnerPublicKey, accountId)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagLength })
  cipher.setAAD(Buffer.from(`account:${accountId}`))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { ephemeralPublicKey, nonce, ciphertext }
}

export function openSecret(runnerPrivateKey: string, accountId: string, sealed: SealedSecret): string {
  if (sealed.ephemeralPublicKey.length !== 32 || sealed.nonce.length !== 12 || sealed.ciphertext.length <= tagLength) throw new Error('Malformed sealed secret')
  const privateKey = createPrivateKey({ key: Buffer.from(runnerPrivateKey, 'base64'), format: 'der', type: 'pkcs8' })
  const ephemeral = publicKeyObject(sealed.ephemeralPublicKey.toString('base64url'))
  const shared = diffieHellman({ privateKey, publicKey: ephemeral })
  const key = deriveKey(shared, sealed.ephemeralPublicKey, rawPublicKey(createPublicKey(privateKey)), accountId)
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: tagLength })
  decipher.setAAD(Buffer.from(`account:${accountId}`))
  decipher.setAuthTag(sealed.ciphertext.subarray(-tagLength))
  return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -tagLength)), decipher.final()]).toString('utf8')
}

/** The base64url public key that goes with a base64 PKCS#8 runner private key. */
export function runnerPublicKeyFor(runnerPrivateKey: string) {
  return rawPublicKey(createPublicKey(createPrivateKey({ key: Buffer.from(runnerPrivateKey, 'base64'), format: 'der', type: 'pkcs8' })))
}

export function isRunnerPublicKey(value: string) {
  try {
    return Buffer.from(value, 'base64url').length === 32 && publicKeyObject(value).asymmetricKeyType === 'x25519'
  } catch {
    return false
  }
}

function deriveKey(shared: Buffer, ephemeralPublicKey: Buffer, runnerPublicKey: string, accountId: string) {
  const salt = Buffer.concat([ephemeralPublicKey, Buffer.from(runnerPublicKey, 'base64url')])
  return Buffer.from(hkdfSync('sha256', shared, salt, `${label}:${accountId}`, 32))
}

function publicKeyObject(raw: string) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' })
}

function rawPublicKey(key: ReturnType<typeof createPublicKey>) {
  const { x } = key.export({ format: 'jwk' })
  if (!x) throw new Error('Not an X25519 public key')
  return x
}
