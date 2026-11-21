/**
 * How many columns a text takes on a terminal, counted with no table: a printable ASCII character and each
 * character of quorum's own glyphs is one column, any other code point two. That over-counts the accents and
 * under-counts nothing, which is the safe side for a line that must never wrap, and it needs no table of widths, so
 * a name in any script is cut before the terminal's edge and never past it.
 */

import { ASCII_GLYPHS, UNICODE_GLYPHS } from './glyphs.ts'

/** The characters of both glyph sets, each one column on a terminal. */
const OWN = new Set([UNICODE_GLYPHS, ASCII_GLYPHS].flatMap(glyphs => Object.values(glyphs).flatMap(glyph => [
  ...typeof glyph === 'string'
    ? glyph
    : glyph.join(''),
])))

function columnsOf(character: string): number {
  const code = character.codePointAt(0)!
  return (code >= 0x20 && code <= 0x7E) || OWN.has(character)
    ? 1
    : 2
}

/** The columns `text` takes, by code point. */
export function widthOf(text: string): number {
  let columns = 0
  for (const character of text) columns += columnsOf(character)
  return columns
}

/**
 * `text` when it fits in `columns`, else its longest prefix of whole code points that fits with `ellipsis` after it,
 * never a surrogate pair halved. A count of columns that cannot hold the ellipsis gives nothing.
 */
export function cut(text: string, columns: number, ellipsis: string): string {
  if (widthOf(text) <= columns) return text
  const room = columns - widthOf(ellipsis)
  if (room < 0) return ''
  let kept = ''
  let used = 0
  for (const character of text) {
    const next = used + columnsOf(character)
    if (next > room) break
    kept += character
    used = next
  }
  return `${kept}${ellipsis}`
}
