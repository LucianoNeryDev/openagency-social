import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { isRunnerPublicKey, runnerKeyPair, runnerPublicKeyFor } from '../crypto/sealed.js'
import { createDatabase } from '../db/client.js'
import { accountInputSchema, accountSecretSchema, linkBrowserChannel, linkOptionsSchema, listBrowserAccounts, putBrowserAccount, resealBrowserAccounts } from '../vault.js'

// Operator command for browser-runner logins. Secrets are read from stdin and
// sealed to RUNNER_PUBLIC_KEY; nothing here prints or returns them.
//   vault keygen --out <file>           new runner key pair, written mode 600
//   vault put --org … --platform tiktok|x|linkedin|threads|pinterest|reddit --handle …   < secret.json
//   vault list --org …
//   vault link --org … --account <id> [--page <LinkedIn company ID>] [--name …]
//                                       create the channel the account publishes through
//   vault reseal [--dry-run] [--batch-size 50]
//                                       move logins sealed under the pre-rename HKDF label to the current one;
//                                       needs RUNNER_PRIVATE_KEY for this command only, and prints counts and IDs
const [command, ...rest] = process.argv.slice(2)
const { values } = parseArgs({ args: rest, options: {
  out: { type: 'string' }, org: { type: 'string' }, account: { type: 'string' }, platform: { type: 'string' }, handle: { type: 'string' },
  page: { type: 'string' }, name: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'batch-size': { type: 'string' },
} })

if (command === 'keygen') {
  const out = z.string().min(1).parse(values.out)
  const pair = runnerKeyPair()
  writeFileSync(out, `${JSON.stringify(pair, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  console.log(`runner key pair written to ${out}; public key ${pair.publicKey}`)
} else if (command === 'put' || command === 'list' || command === 'link') {
  const { db, pool } = createDatabase(z.string().min(1).parse(process.env.DATABASE_URL))
  try {
    if (command === 'link') {
      const result = await linkBrowserChannel(db, accountInputSchema.shape.organizationId.parse(values.org), z.uuid().parse(values.account),
        linkOptionsSchema.parse({ page: values.page, name: values.name }))
      console.log(`${result.created ? 'created' : 'existing'} channel ${result.channelId}`)
    } else if (command === 'list') {
      for (const row of await listBrowserAccounts(db, accountInputSchema.shape.organizationId.parse(values.org))) {
        console.log(`${row.id}  ${row.platform}  ${row.handle}  ${row.status}  ${row.updatedAt.toISOString()}`)
      }
    } else {
      const publicKey = z.string().refine(isRunnerPublicKey, 'RUNNER_PUBLIC_KEY is not an X25519 public key').parse(process.env.RUNNER_PUBLIC_KEY)
      const input = accountInputSchema.parse({ organizationId: values.org, platform: values.platform, handle: values.handle })
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      const parsed = accountSecretSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (!parsed.success) throw new Error(`Invalid secret: ${parsed.error.issues.map(issue => issue.path.join('.') || 'secret').join(', ')}`)
      const result = await putBrowserAccount(db, publicKey, input, parsed.data)
      console.log(`${result.created ? 'created' : 'replaced'} browser account ${result.id}; it needs a browser login before use`)
    }
  } finally {
    await pool.end()
  }
} else if (command === 'reseal') {
  const privateKey = process.env.RUNNER_PRIVATE_KEY ?? ''
  try {
    runnerPublicKeyFor(privateKey)
  } catch {
    // Never echo the value.
    throw new Error('RUNNER_PRIVATE_KEY is missing or not an X25519 private key')
  }
  const dryRun = values['dry-run'] ?? false
  const batchSize = z.coerce.number().int().min(1).max(1000).parse(values['batch-size'] ?? 50)
  const { db, pool } = createDatabase(z.string().min(1).parse(process.env.DATABASE_URL))
  try {
    const verb = dryRun ? 'would reseal' : 'resealed'
    const result = await resealBrowserAccounts(db, privateKey, { dryRun, batchSize,
      onBatch: progress => console.log(`… checked ${progress.checked}, ${verb} ${progress.resealed}`) })
    console.log(`${dryRun ? 'dry run: ' : ''}checked ${result.checked}, already current ${result.current}, ${verb} ${result.resealed}, unopenable ${result.unopenable.length}`)
    for (const id of result.unopenable) console.log(`unopenable browser account ${id} (sealed to another runner key, or damaged); left unchanged`)
    if (result.unopenable.length > 0) process.exitCode = 1
  } finally {
    await pool.end()
  }
} else {
  console.error('usage: vault keygen --out <file> | vault put --org … --platform … --handle … < secret.json | vault list --org … | vault link --org … --account … [--page …] [--name …] | vault reseal [--dry-run] [--batch-size …]')
  process.exitCode = 2
}
