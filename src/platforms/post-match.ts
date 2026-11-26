import type { ReconcileInput, ReconcileOutcome } from './types.js'

/**
 * How a caption is compared with what the platform shows: Unicode NFKC,
 * without emoji variation selectors and zero-width characters (Meta drops or
 * adds them), whitespace runs as one space, trimmed.
 */
export function normalizeCaption(value: string) {
  return value.normalize('NFKC').replace(/[\uFE0E\uFE0F\u200B-\u200D\u2060\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim()
}

/** The start of a caption that must agree when the whole does not (Meta may trim it, or change hashtags and emojis further on). */
export const captionPrefixLength = 60
/** A caption shorter than this must match whole: its start says too little. */
const minPrefixLength = 20
/** A post found by the start of its caption must have appeared this soon after the attempt. */
export const reconcileWindowMs = 30 * 60_000

/** A post read back from the platform while an uncertain publish is reconciled. */
export interface PostCandidate {
  id: string
  text: string | null
  /** Milliseconds; null when the platform gave no readable time. */
  createdAt: number | null
  url?: string
}

/**
 * The one post made since the attempt whose caption matches, among IDs no
 * other job holds: the normalised caption whole, or, when none matches whole,
 * its first 60 characters within half an hour of the attempt.
 */
export function pickPost(candidates: PostCandidate[], input: Pick<ReconcileInput, 'content' | 'since' | 'excludeExternalIds'>): ReconcileOutcome {
  const expected = normalizeCaption(input.content)
  const open = candidates.filter(candidate => !input.excludeExternalIds.includes(candidate.id)
    && (candidate.createdAt === null || candidate.createdAt >= input.since.getTime()))
  const whole = open.filter(candidate => normalizeCaption(candidate.text ?? '') === expected)
  if (whole.length) return settle(whole, 'match the caption')
  if (expected.length < minPrefixLength) return { kind: 'not_found' }
  const prefix = expected.slice(0, captionPrefixLength)
  const latest = input.since.getTime() + reconcileWindowMs
  const started = open.filter(candidate => candidate.createdAt !== null && candidate.createdAt <= latest
    && normalizeCaption(candidate.text ?? '').slice(0, captionPrefixLength) === prefix)
  return started.length ? settle(started, 'start like the caption') : { kind: 'not_found' }
}

function settle(matches: PostCandidate[], what: string): ReconcileOutcome {
  if (matches.length > 1) return { kind: 'ambiguous', detail: `${matches.length} posts ${what}` }
  return { kind: 'published', externalId: matches[0]!.id, ...(matches[0]!.url ? { url: matches[0]!.url } : {}) }
}
