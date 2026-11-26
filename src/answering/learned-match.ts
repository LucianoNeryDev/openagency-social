import { createHash } from 'node:crypto'

// Matching inbound text against learned answers: local and deterministic, no
// embeddings. Text is redacted (addresses, links and phone numbers become
// placeholders), normalised (NFKC, accents dropped, lower case, punctuation
// and runs of spaces collapsed), then compared exactly (fingerprint) or by
// the Jaccard similarity of its character trigrams.

/** At most this much normalised text is fingerprinted and compared. */
export const maxMatchCharacters = 2_000
/** A similar (not exact) match needs at least this many words on both sides: short texts are matched exactly or not at all. */
export const minSimilarWords = 3
/** The similarity a match needs when the settings say nothing. */
export const defaultLearningSimilarity = 0.85
/** At most this many learned answers of a scope, newest approval first, are compared with a new item. */
export const maxCandidates = 500

/**
 * Text with what identifies a person replaced: email addresses, links and
 * phone-like runs of digits (seven or more, with separators) become
 * `[email]`, `[link]` and `[number]`. Other numbers stay: they change answers.
 */
export function redactInbound(value: string) {
  return value
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]')
    .replace(/\+?\d[\d ().-]{5,}\d/g, match => match.replace(/\D/g, '').length >= 7 ? '[number]' : match)
}

/** The comparable form: redacted, NFKC, accents dropped, lower case, every run of non-letters and non-digits one space; capped. */
export function normalizeInbound(value: string) {
  const folded = redactInbound(value).normalize('NFKC').normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase()
  const normalized = folded.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return Array.from(normalized).slice(0, maxMatchCharacters).join('').trim()
}

/** A short fingerprint of normalised text, for exact matches: 32 hex characters of SHA-256. */
export function inboundFingerprint(normalized: string) {
  return createHash('sha256').update(`learned-inbound-v1\n${normalized}`).digest('hex').slice(0, 32)
}

/** The words of normalised text that hold a digit, sorted and deduplicated: a similar match needs the same ones. */
export function numberWords(normalized: string) {
  return [...new Set(normalized.split(' ').filter(word => /\p{N}/u.test(word)))].sort()
}

/** The character trigrams of normalised text, with a space before and after it. */
export function trigrams(normalized: string) {
  const characters = Array.from(` ${normalized} `)
  const result = new Set<string>()
  for (let index = 0; index + 3 <= characters.length; index++) result.add(characters.slice(index, index + 3).join(''))
  return result
}

/** |A ∩ B| / |A ∪ B|; 1 for two empty sets. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (!a.size && !b.size) return 1
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const item of small) if (large.has(item)) shared++
  return shared / (a.size + b.size - shared)
}

export interface MatchCandidate { id: string, fingerprint: string, normalized: string }
export interface LearnedMatch<Candidate extends MatchCandidate = MatchCandidate> {
  candidate: Candidate
  /** 1 for an exact match (the same fingerprint). */
  similarity: number
  exact: boolean
}

/**
 * The best learned answer for a normalised text: the one with the same
 * fingerprint, else the most similar one at or above `threshold`, with the
 * same number words and enough words on both sides. Ties go to the earlier
 * candidate (the caller passes them newest first). Null when none qualifies.
 */
export function bestMatch<Candidate extends MatchCandidate>(normalized: string, candidates: readonly Candidate[], threshold: number): LearnedMatch<Candidate> | null {
  if (!normalized) return null
  const fingerprint = inboundFingerprint(normalized)
  const exact = candidates.find(candidate => candidate.fingerprint === fingerprint)
  if (exact) return { candidate: exact, similarity: 1, exact: true }
  if (normalized.split(' ').length < minSimilarWords) return null
  const grams = trigrams(normalized)
  const numbers = numberWords(normalized).join(' ')
  let best: LearnedMatch<Candidate> | null = null
  for (const candidate of candidates) {
    if (candidate.normalized.split(' ').length < minSimilarWords || numberWords(candidate.normalized).join(' ') !== numbers) continue
    const similarity = jaccard(grams, trigrams(candidate.normalized))
    if (similarity >= threshold && (!best || similarity > best.similarity)) best = { candidate, similarity, exact: false }
  }
  return best
}
