/**
 * The marks the live view draws: a Unicode set and an ASCII one, and the check that chooses between them. Every
 * glyph of either set is one column wide on a terminal (the ASCII ellipsis is three of them), none is an emoji or has
 * an emoji presentation, so a terminal never draws one wider than `width.ts` counts it.
 */

/** The marks of the view: the log lines' glyphs, the bars' cells, the sparkline's levels, the rule and the separators. */
export interface Glyphs {
  readonly answered: string
  readonly retry: string
  readonly adapted: string
  readonly failed: string
  /** A bar's finished cell. */
  readonly done: string
  /** A bar's cell still to do. */
  readonly todo: string
  /** The sparkline's levels, from the lowest, which is also the glyph of a bucket that holds nothing. */
  readonly spark: readonly string[]
  readonly rule: string
  readonly ellipsis: string
  /** The dash of a range. */
  readonly range: string
  /** The separator inside a line. */
  readonly dot: string
}

export const UNICODE_GLYPHS: Glyphs = {
  answered: '✓',
  retry: '↻',
  adapted: '△',
  failed: '✗',
  done: '█',
  todo: '░',
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  rule: '─',
  ellipsis: '…',
  range: '–',
  dot: '·',
}

export const ASCII_GLYPHS: Glyphs = {
  answered: '+',
  retry: '~',
  adapted: '^',
  failed: 'x',
  done: '#',
  todo: '-',
  spark: ['_', '.', '-', '=', '+', '*', '#'],
  rule: '-',
  ellipsis: '...',
  range: '-',
  dot: '-',
}

/** A locale name of a language whose terminals draw the ambiguous-width glyphs two columns wide. */
const WIDE_LANGUAGE = /^(?:ja|ko|zh)/i

const UTF8 = /utf-?8/i

/**
 * The glyph set for a terminal, from the environment and the platform it is given. Off Windows the first of
 * `LC_ALL`, `LC_CTYPE` and `LANG` that is set and not empty decides, as the C library does: Unicode when it names
 * UTF-8, unless its language is Japanese, Korean or Chinese. On Windows it is Unicode in Windows Terminal and in
 * VS Code's. Anything else is ASCII.
 */
export function glyphsFor(env: Readonly<Record<string, string | undefined>>, platform: string): Glyphs {
  if (platform === 'win32') {
    return (env.WT_SESSION !== undefined && env.WT_SESSION !== '') || env.TERM_PROGRAM === 'vscode'
      ? UNICODE_GLYPHS
      : ASCII_GLYPHS
  }
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(value => value !== undefined && value !== '')
  return locale !== undefined && UTF8.test(locale) && !WIDE_LANGUAGE.test(locale)
    ? UNICODE_GLYPHS
    : ASCII_GLYPHS
}
