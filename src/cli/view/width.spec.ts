import { describe, expect, it } from 'vitest'
import { ASCII_GLYPHS, UNICODE_GLYPHS } from './glyphs.ts'
import { cut, widthOf } from './width.ts'

describe('widthOf', () => {
  it('counts printable ASCII and quorum\'s glyphs one column, and any other code point two', () => {
    expect(widthOf('abc')).toBe(3)
    expect(widthOf(`${UNICODE_GLYPHS.answered} ${UNICODE_GLYPHS.done}`)).toBe(3)
    expect(widthOf('é')).toBe(2)
    expect(widthOf(String.fromCharCode(0x4E2D))).toBe(2)
    expect(widthOf(String.fromCodePoint(0x1F600))).toBe(2)
    expect(widthOf('')).toBe(0)
    expect(widthOf(ASCII_GLYPHS.ellipsis)).toBe(3)
    expect(widthOf(UNICODE_GLYPHS.ellipsis)).toBe(1)
  })
})

describe('cut', () => {
  it('cuts a line to its columns with the ellipsis, never past them, and never halves a surrogate pair', () => {
    expect(cut('abcdefghij', 6, '...')).toBe('abc...')
    expect(cut('abcdefghij', 6, UNICODE_GLYPHS.ellipsis)).toBe(`abcde${UNICODE_GLYPHS.ellipsis}`)
    const astral = String.fromCodePoint(0x1F600)
    const text = `ab${astral}${astral}${astral}`
    for (let columns = 0; columns < widthOf(text); columns++) {
      const cutText = cut(text, columns, '...')
      expect(widthOf(cutText)).toBeLessThanOrEqual(columns)
      expect(cutText.isWellFormed()).toBe(true)
    }
    // five columns less the ellipsis' three leave two: one ASCII character and no wide one, or one wide one
    expect(cut(`a${astral}${astral}${astral}`, 5, '...')).toBe('a...')
    expect(cut(`${astral}${astral}${astral}`, 5, '...')).toBe(`${astral}...`)
  })

  it('leaves a line that fits as it is', () => {
    expect(cut('abc', 3, '...')).toBe('abc')
    expect(cut('abc', 10, '...')).toBe('abc')
    expect(cut('', 0, '...')).toBe('')
  })
})
