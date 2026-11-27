/**
 * How each platform counts a post's text. Self-contained on purpose: OpenAgency
 * Portal keeps an identical copy (shared/lib/text-length.ts) for its editor's
 * counters, so a change here is made there too, with its tests.
 *
 * - `characters`: Unicode code points (an emoji of one code point is one).
 * - `bytes`: UTF-8 bytes (YouTube's description).
 * - `x_weighted`: X's weighted length (twitter-text v3): the text is NFC
 *   normalised; every URL counts 23 (t.co), every emoji (a whole sequence,
 *   flags and ZWJ families included) counts 2, code points in Latin, Greek,
 *   Cyrillic and most punctuation ranges count 1, everything else (CJK,
 *   symbols) counts 2.
 */
export const lengthUnits = ['characters', 'bytes', 'x_weighted'] as const
export type LengthUnit = typeof lengthUnits[number]

export const xUrlLength = 23

/** twitter-text v3: these ranges weigh 1, the rest 2. */
const xLightRanges: ReadonlyArray<readonly [number, number]> = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]]

// A bare domain counts as a link only with a TLD people actually use in posts.
const tlds = 'com|net|org|it|eu|io|co|dev|app|me|tv|info|biz|xyz|shop|store|online|site|ly|be|gl|to|uk|de|fr|es|pt|nl|ch|at|us|ca|br|ai|news|blog|link'
const urlPattern = new RegExp(
  `(?:https?:\\/\\/[^\\s<>"]+)|(?:(?<![\\w@.\\-\\/])(?:www\\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${tlds})(?![\\w-])(?:[/?#][^\\s<>"]*)?)`,
  'giu',
)

function emojiPattern(): RegExp {
  try {
    // RGI_Emoji (the `v` flag) matches a whole sequence as one emoji.
    return new RegExp('\\p{RGI_Emoji}', 'gv')
  } catch {
    return /\p{Extended_Pictographic}(?:️|⃣)?(?:‍\p{Extended_Pictographic}️?)*|\p{Regional_Indicator}{2}/gu
  }
}
const emoji = emojiPattern()

/** A URL's end, without trailing punctuation that closes the sentence. */
function trimUrl(url: string) {
  let end = url.length
  while (end > 0) {
    const last = url[end - 1]!
    if ('.,;:!?\'"'.includes(last)) end--
    else if (last === ')' && !url.slice(0, end).includes('(')) end--
    else break
  }
  return url.slice(0, end)
}

/** X's weighted length of a text. */
export function xWeightedLength(text: string): number {
  const value = text.normalize('NFC')
  const spans: Array<{ start: number, end: number, weight: number }> = []
  for (const match of value.matchAll(urlPattern)) {
    const url = trimUrl(match[0])
    if (url.length) spans.push({ start: match.index, end: match.index + url.length, weight: xUrlLength })
  }
  for (const match of value.matchAll(emoji)) {
    const start = match.index
    if (spans.some(span => start < span.end && start + match[0].length > span.start)) continue
    spans.push({ start, end: start + match[0].length, weight: 2 })
  }
  spans.sort((a, b) => a.start - b.start)
  let total = 0
  let next = 0
  for (let index = 0; index < value.length;) {
    const span = spans[next]
    if (span && span.start === index) {
      total += span.weight
      index = span.end
      next++
      continue
    }
    const point = value.codePointAt(index)!
    total += xLightRanges.some(([from, to]) => point >= from && point <= to) ? 1 : 2
    index += point > 0xffff ? 2 : 1
  }
  return total
}

export function textLength(text: string, unit: LengthUnit): number {
  if (unit === 'bytes') return new TextEncoder().encode(text).length
  if (unit === 'x_weighted') return xWeightedLength(text)
  return Array.from(text).length
}

export function fitsLength(text: string, maxLength: number, unit: LengthUnit) {
  return textLength(text, unit) <= maxLength
}
