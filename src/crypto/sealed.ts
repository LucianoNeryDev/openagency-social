import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto'

/**
 * Secrets sealed to the browser runner: anyone with its public key can seal,
 * only the runner's private key opens. Ephemeral X25519, HKDF-SHA256 and
 * AES-256-GCM; the account ID is bound into the key and the associated data,
 * so a blob copied onto another account fails to open.
 *
 * The HKDF info label is not stored with the blob. Sealing always uses
 * `openagency-social-vault v1:<account>`; opening tries that key first and
 * then the label used before the rename (`leonessa-vault v1:<account>`), and
 * the GCM tag decides which one fits. `vault reseal` moves stored blobs to the
 * current label.
 */
export interface SealedSecret {
  ephemeralPublicKey: Buffer
  nonce: Buffer
  ciphertext: Buffer
}

const tagLength = 16
const currentLabel = 'openagency-social-vault v1'
// Before the rename to OpenAgency. Opened only, never sealed; dropped once every environment has run `vault reseal`.
const legacyLabel = 'leonessa-vault v1'

/** Which HKDF label's key opened a blob: `legacy` blobs are due for `vault reseal`. */
export type SealLabel = 'current' | 'legacy'

/** A new runner key pair: the public key as base64url raw X25519, the private key as base64 PKCS#8. */
export function runnerKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { publicKey: rawPublicKey(publicKey), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }
}

export function sealSecret(runnerPublicKey: string, accountId: string, plaintext: string): SealedSecret {
  const recipient = publicKeyObject(runnerPublicKey)
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublicKey = Buffer.from(rawPublicKey(ephemeral.publicKey), 'base64url')
  const key = deriveKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), ephemeralPublicKey, runnerPublicKey, currentLabel, accountId)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagLength })
  cipher.setAAD(Buffer.from(`account:${accountId}`))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { ephemeralPublicKey, nonce, ciphertext }
}

export function openSecret(runnerPrivateKey: string, accountId: string, sealed: SealedSecret): string {
  return openSealedSecret(runnerPrivateKey, accountId, sealed).plaintext
}

/**
 * Opens a blob with the current label's key, else the legacy label's, and
 * says which one fit. When neither authenticates it throws the current
 * label's error, as opening did before the legacy label existed.
 */
export function openSealedSecret(runnerPrivateKey: string, accountId: string, sealed: SealedSecret): { plaintext: string, label: SealLabel } {
  if (sealed.ephemeralPublicKey.length !== 32 || sealed.nonce.length !== 12 || sealed.ciphertext.length <= tagLength) throw new Error('Malformed sealed secret')
  const privateKey = createPrivateKey({ key: Buffer.from(runnerPrivateKey, 'base64'), format: 'der', type: 'pkcs8' })
  const ephemeral = publicKeyObject(sealed.ephemeralPublicKey.toString('base64url'))
  const shared = diffieHellman({ privateKey, publicKey: ephemeral })
  const runnerPublicKey = rawPublicKey(createPublicKey(privateKey))
  const open = (label: string) => decrypt(deriveKey(shared, sealed.ephemeralPublicKey, runnerPublicKey, label, accountId), accountId, sealed)
  try {
    return { plaintext: open(currentLabel), label: 'current' }
  } catch (currentError) {
    try {
      return { plaintext: open(legacyLabel), label: 'legacy' }
    } catch {
      throw currentError
    }
  }
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

function deriveKey(shared: Buffer, ephemeralPublicKey: Buffer, runnerPublicKey: string, label: string, accountId: string) {
  const salt = Buffer.concat([ephemeralPublicKey, Buffer.from(runnerPublicKey, 'base64url')])
  return Buffer.from(hkdfSync('sha256', shared, salt, `${label}:${accountId}`, 32))
}

// The associated data carries no label, so it is the same under either key.
function decrypt(key: Buffer, accountId: string, sealed: SealedSecret) {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: tagLength })
  decipher.setAAD(Buffer.from(`account:${accountId}`))
  decipher.setAuthTag(sealed.ciphertext.subarray(-tagLength))
  return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -tagLength)), decipher.final()]).toString('utf8')
}

function publicKeyObject(raw: string) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' })
}

function rawPublicKey(key: ReturnType<typeof createPublicKey>) {
  const { x } = key.export({ format: 'jwk' })
  if (!x) throw new Error('Not an X25519 public key')
  return x
}
