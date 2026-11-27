import { describe, expect, it } from 'vitest'
import { fitsLength, textLength, xWeightedLength } from '../src/text-length.js'
import { browserRules } from '../src/platforms/browser/rules.js'

// Portal's shared/text-length.test.ts runs the same cases against its copy.
describe('text length', () => {
  it('counts code points as characters', () => {
    expect(textLength('Ciao Brescia', 'characters')).toBe(12)
    expect(textLength('😀😀', 'characters')).toBe(2)
    expect(textLength('caffè', 'characters')).toBe(5)
  })

  it('counts UTF-8 bytes', () => {
    expect(textLength('caffè', 'bytes')).toBe(6)
    expect(textLength('😀', 'bytes')).toBe(4)
    expect(fitsLength('è'.repeat(2_500), 5_000, 'bytes')).toBe(true)
    expect(fitsLength('è'.repeat(2_501), 5_000, 'bytes')).toBe(false)
  })

  it('counts every link on X as 23', () => {
    expect(xWeightedLength('Visit https://example.com/a?b=1.')).toBe(6 + 23 + 1)
    expect(xWeightedLength('https://example.com/' + 'a'.repeat(200))).toBe(23)
    expect(xWeightedLength('see example.com and www.foo.it/x')).toBe(4 + 23 + 5 + 23)
    expect(xWeightedLength('(https://x.com/a)')).toBe(1 + 23 + 1)
    // An e-mail address and a decimal are not links.
    expect(xWeightedLength('mail me@example.com')).toBe(19)
    expect(xWeightedLength('1.5 kg')).toBe(6)
  })

  it('weighs emoji and CJK as two on X', () => {
    expect(xWeightedLength('😀😀')).toBe(4)
    expect(xWeightedLength('👨‍👩‍👧‍👦')).toBe(2)
    expect(xWeightedLength('🇮🇹')).toBe(2)
    expect(xWeightedLength('❤️')).toBe(2)
    expect(xWeightedLength('日本語')).toBe(6)
    expect(xWeightedLength('café')).toBe(4)
    // NFC: e + combining acute is one character.
    expect(xWeightedLength('é')).toBe(1)
    expect(xWeightedLength('“quoted” — dash')).toBe(15)
  })

  it('fits X at 280 weighted', () => {
    expect(fitsLength('a'.repeat(280), 280, 'x_weighted')).toBe(true)
    expect(fitsLength('a'.repeat(281), 280, 'x_weighted')).toBe(false)
    expect(fitsLength('日'.repeat(140), 280, 'x_weighted')).toBe(true)
    expect(fitsLength('日'.repeat(141), 280, 'x_weighted')).toBe(false)
    expect(fitsLength(`${'a'.repeat(256)} https://example.com/${'p'.repeat(300)}`, 280, 'x_weighted')).toBe(true)
  })

  it('gives X its weighted unit and titles their limits', () => {
    expect(browserRules.x.limits).toMatchObject({ maxLength: 280, lengthUnit: 'x_weighted' })
    expect(browserRules.pinterest.limits.titleMaxLength).toBe(100)
    expect(browserRules.reddit.limits.titleMaxLength).toBe(300)
  })
})
