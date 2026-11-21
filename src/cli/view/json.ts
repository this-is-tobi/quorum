/**
 * The writers of the two modes that draw nothing: JSON mode, for a tool, which writes each event of the review and each
 * line of the CLI's own as one JSON line, and the quiet mode, which writes the warnings and the errors alone.
 */

import { inertJsonLine, inertLine } from '../../core/sanitize.ts'
import type { LineLevel, ViewWriter } from './writer.ts'

/** What a writer that holds no timer and draws nothing does to end: nothing. */
const NOTHING = {
  begin: (): void => {},
  summary: (): void => {},
  close: (): Promise<void> => Promise.resolve(),
  restore: (): void => {},
}

/**
 * JSON mode: each event as `inertJsonLine(event)`, as the library hands it, and each line of the CLI's as
 * `{"type":"cli:line","level":...,"text":<the inert line>}`, so stderr parses line by line. It writes no summary: a
 * tool has the events, and the result on stdout.
 */
export function jsonWriter(write: (line: string) => void): ViewWriter {
  return {
    ...NOTHING,
    sink: (event) => {
      write(inertJsonLine(event))
    },
    line: (level, text) => {
      write(inertJsonLine({
        type: 'cli:line',
        level,
        text: inertLine(text),
      }))
    },
  }
}

/** The levels the quiet mode writes. */
const QUIET_LEVELS: ReadonlySet<LineLevel> = new Set(['warning', 'error'])

/** The mode `none`: the `warning` and `error` lines alone, as plain text, and no event, banner, estimate, notice or summary. */
export function quietWriter(write: (line: string) => void): ViewWriter {
  return {
    ...NOTHING,
    sink: () => {},
    line: (level, text) => {
      if (QUIET_LEVELS.has(level)) write(inertLine(text))
    },
  }
}
