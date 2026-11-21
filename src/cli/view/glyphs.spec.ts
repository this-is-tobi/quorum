import { describe, expect, it } from 'vitest'
import { ASCII_GLYPHS, glyphsFor, UNICODE_GLYPHS } from './glyphs.ts'
import type { Glyphs } from './glyphs.ts'
import { widthOf } from './width.ts'

/** Every mark of a set, the sparkline's levels each on its own. */
function marks(glyphs: Glyphs): string[] {
  const { spark, ...single } = glyphs
  return [
    ...Object.values(single),
    ...spark,
  ]
}

describe('glyphsFor', () => {
  it.each<[string, string, Record<string, string>, string]>([
    [
      'Unicode',
      'LC_ALL=en_US.UTF-8',
      { LC_ALL: 'en_US.UTF-8' },
      'linux',
    ],
    [
      'Unicode',
      'LANG=en_GB.utf8',
      { LANG: 'en_GB.utf8' },
      'darwin',
    ],
    [
      'ASCII',
      'LC_ALL=C beside LANG=en_US.UTF-8',
      { LC_ALL: 'C', LANG: 'en_US.UTF-8' },
      'linux',
    ],
    [
      'Unicode',
      'an empty LC_ALL beside LC_CTYPE=fr_FR.UTF-8',
      { LC_ALL: '', LC_CTYPE: 'fr_FR.UTF-8' },
      'linux',
    ],
    [
      'ASCII',
      'LANG=ja_JP.UTF-8',
      { LANG: 'ja_JP.UTF-8' },
      'linux',
    ],
    [
      'ASCII',
      'LANG=zh_CN.UTF-8',
      { LANG: 'zh_CN.UTF-8' },
      'linux',
    ],
    [
      'ASCII',
      'LANG=ko_KR.UTF-8',
      { LANG: 'ko_KR.UTF-8' },
      'linux',
    ],
    ['ASCII', 'no locale', {}, 'linux'],
    [
      'Unicode',
      'win32 with WT_SESSION',
      { WT_SESSION: 'a-session' },
      'win32',
    ],
    [
      'ASCII',
      'win32 with nothing',
      {},
      'win32',
    ],
  ])('chooses %s glyphs for %s', (name, _label, env, platform) => {
    expect(glyphsFor(env, platform)).toBe(name === 'Unicode'
      ? UNICODE_GLYPHS
      : ASCII_GLYPHS)
  })
})

describe('the glyph sets', () => {
  it('uses no emoji and no character of emoji presentation', () => {
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      for (const mark of marks(glyphs)) expect(mark).not.toMatch(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u)
    }
  })

  it('pairs each Unicode glyph with an ASCII one of one column', () => {
    const { spark: unicodeSpark, ...unicode } = UNICODE_GLYPHS
    const { spark: asciiSpark, ...ascii } = ASCII_GLYPHS
    expect(Object.keys(ascii)).toEqual(Object.keys(unicode))
    for (const name of Object.keys(unicode) as Array<keyof typeof unicode>) {
      expect(widthOf(unicode[name]), name).toBe(1)
      // the ASCII ellipsis is the one mark of three columns, which `cut` counts as such
      expect(widthOf(ascii[name]), name).toBe(name === 'ellipsis'
        ? 3
        : 1)
      expect(ascii[name]).toMatch(/^[\x20-\x7E]+$/)
    }
    for (const level of [
      ...unicodeSpark,
      ...asciiSpark,
    ]) expect(widthOf(level)).toBe(1)
    expect(new Set(unicodeSpark).size).toBe(unicodeSpark.length)
    expect(new Set(asciiSpark).size).toBe(asciiSpark.length)
  })
})
