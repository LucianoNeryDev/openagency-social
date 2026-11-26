import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { clock, recordEvent, type EngineContext } from '../context.js'
import type { Executor } from '../db/client.js'
import { answeringSettings, caseEffects, replyModelChoices, type AnsweringContextEntry, type AnsweringSettings, type StoredAnsweringSettings } from '../db/schema.js'
import { conflict, notFound } from '../errors.js'
import { advisoryLock } from '../exactly-once.js'
import { defaultLearningSimilarity } from './learned-match.js'

const text = (max: number) => z.string().max(max).transform(value => value.replace(/\r\n/g, '\n').trim())
/** A handle as people write it: `@` and case dropped. */
const author = z.string().max(200).transform(value => value.trim().replace(/^@/, '').toLowerCase()).pipe(z.string().min(1))

/** The engine never sends an automatic answer sooner than this after its draft, whatever the settings say. */
export const minAutoDelaySeconds = 60
/** The risk threshold when the dashboard sends none, and for settings stored before it existed. */
export const defaultRiskThreshold = 30
/** Learning from approved answers, when the dashboard says nothing (and for settings stored before it existed). */
export const defaultLearning = true

/** One case of answering; at least one condition (authors or keywords) is set. */
export const answeringCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  effect: z.enum(caseEffects),
  label: text(120).default(''),
  authors: z.array(author).max(50).default([]),
  keywords: z.array(text(100).pipe(z.string().min(1))).max(50).default([]),
  channelIds: z.array(z.uuid()).max(100).default([]),
}).refine(value => value.authors.length + value.keywords.length > 0, 'a case needs an author or a keyword')

/**
 * The tenant's effective answering settings: the dashboard resolves the
 * global ones with the tenant's overrides, as for email, plus the social
 * switches. Unknown fields are refused.
 */
export const answeringSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  drafts: z.boolean(),
  kinds: z.strictObject({ messages: z.boolean(), comments: z.boolean() }),
  decisionModel: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('d1.1'),
  decisionPrompt: text(4_000),
  decisionThreshold: z.number().min(0.5).max(1),
  noneThreshold: z.number().min(0.5).max(1).default(0.8),
  riskThreshold: z.number().int().min(0).max(100).default(defaultRiskThreshold),
  replyModel: z.enum(replyModelChoices).default('haiku'),
  voice: text(2_000),
  replyContext: text(8_000).default(''),
  delaySeconds: z.number().int().min(minAutoDelaySeconds).max(86_400),
  cases: z.array(answeringCaseSchema).max(100).refine(cases => new Set(cases.map(item => item.id)).size === cases.length, 'case IDs must be unique'),
  learning: z.boolean().default(defaultLearning),
  learningSimilarity: z.number().min(0.7).max(1).default(defaultLearningSimilarity),
}) satisfies z.ZodType<AnsweringSettings, unknown>

export const answeringContextSchema = z.array(z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  topic: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  body: text(8_000).pipe(z.string().min(1)),
})).max(500).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length,
  'context IDs must be unique') satisfies z.ZodType<AnsweringContextEntry[], unknown>

export const answeringPutSchema = z.strictObject({
  version: z.number().int().positive(),
  settings: answeringSettingsSchema,
  context: answeringContextSchema.default([]),
})
export type AnsweringPut = z.output<typeof answeringPutSchema>

export interface StoredAnswering {
  organizationId: string
  version: number
  settings: AnsweringSettings
  context: AnsweringContextEntry[]
  messagesEnabledAt: Date | null
  commentsEnabledAt: Date | null
  updatedAt: Date
}

/** Serializes settings changes with the automation guards of one tenant. */
export const lockAnswering = (executor: Executor, organizationId: string) => advisoryLock(executor, `answering:${organizationId}`)

/** JSON with object keys sorted: jsonb does not keep the order they were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Stored settings with the defaults of fields added since they were pushed. */
export function storedSettings(settings: StoredAnsweringSettings): AnsweringSettings {
  return { ...settings, riskThreshold: settings.riskThreshold ?? defaultRiskThreshold, learning: settings.learning ?? defaultLearning,
    learningSimilarity: settings.learningSimilarity ?? defaultLearningSimilarity }
}

export async function readAnswering(executor: Executor, organizationId: string): Promise<StoredAnswering | null> {
  const [row] = await executor.select().from(answeringSettings).where(eq(answeringSettings.organizationId, organizationId)).limit(1)
  return row ? { ...row, settings: storedSettings(row.settings) } : null
}

function answeringView(row: StoredAnswering) {
  return { version: row.version, settings: row.settings, context: row.context,
    enabledAt: { messages: row.messagesEnabledAt?.toISOString() ?? null, comments: row.commentsEnabledAt?.toISOString() ?? null },
    updatedAt: row.updatedAt.toISOString() }
}

export async function getAnswering(context: EngineContext, organizationId: string) {
  const row = await readAnswering(context.db, organizationId)
  if (!row) throw notFound('Answering settings')
  return answeringView(row)
}

/**
 * Stores what the dashboard pushed. Versions only move forward: an older
 * version is `stale_version`, the same version with other values
 * `version_conflict`, and the same push again changes nothing. When DMs or
 * comments turn on (`drafts` and the kind), that time is recorded per kind:
 * items of the kind first seen before it are never processed, so switching
 * on does not draft the backlog, nor what arrived while the kind was off.
 */
export async function putAnswering(context: EngineContext, organizationId: string, input: AnsweringPut) {
  return context.db.transaction(async transaction => {
    const now = clock(context)
    await lockAnswering(transaction, organizationId)
    const current = await readAnswering(transaction, organizationId)
    if (current) {
      if (input.version < current.version) throw conflict('stale_version', 'A newer version of the answering settings is stored', { version: current.version })
      if (input.version === current.version) {
        const same = canonical(current.settings) === canonical(input.settings) && canonical(current.context) === canonical(input.context)
        if (!same) throw conflict('version_conflict', 'This version was already stored with other values', { version: current.version })
        return answeringView(current)
      }
    }
    // Each kind keeps the time it was switched on (with `drafts`) while it stays on; off clears it, on again starts from now.
    const since = (kind: 'messages' | 'comments', previous: Date | null) => !(input.settings.drafts && input.settings.kinds[kind]) ? null
      : current && current.settings.drafts && current.settings.kinds[kind] && previous ? previous : now
    const values = { version: input.version, settings: input.settings, context: input.context, messagesEnabledAt: since('messages', current?.messagesEnabledAt ?? null),
      commentsEnabledAt: since('comments', current?.commentsEnabledAt ?? null), updatedAt: now }
    const [stored] = await transaction.insert(answeringSettings).values({ organizationId, ...values, createdAt: now })
      .onConflictDoUpdate({ target: answeringSettings.organizationId, set: values }).returning()
    await recordEvent(transaction, { organizationId, kind: 'answering.updated', detail: { version: input.version, enabled: input.settings.enabled,
      drafts: input.settings.drafts, kinds: input.settings.kinds, contextEntries: input.context.length } })
    return answeringView({ ...stored!, settings: storedSettings(stored!.settings) })
  })
}
