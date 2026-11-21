/**
 * The live writer: it draws the block of `frame.ts` under the log lines of a review on a terminal, and leaves the
 * terminal as it found it on every way out.
 *
 * Before the first frame, 500 ms after `run:start`, and for a review that ends sooner, each log line is written
 * straight, its glyph and colour included, with no block and no cursor movement. From then on each frame is one write,
 * so a terminal never shows half of one: `CSI ? 2026 h` opens synchronized output; the first frame then hides the
 * cursor, a later one moves up over the last block (`CSI <n> A`, only when that block drew `n > 0` rows) and erases to
 * the end of the screen (`CSI J`); the log lines due follow, each with its line feed, then the block's lines, each with
 * its own, then `CSI ? 2026 l`. The cursor rests at the start of the row below the block. A frame is drawn at most every
 * 100 ms and only when its text, or the terminal's size, changed or a log line is due; a tick each second redraws it for
 * its timers. The time left is recomputed at most every 5 s. The size, the view's only input from the terminal, is read
 * afresh at every frame and tick, and the stream's `'resize'` event redraws at once, so a missed event costs a second
 * at most, and no `SIGWINCH` handler is needed, whose size Bun reads stale.
 *
 * A shrinking terminal: the next erase moves up as many rows as the old lines take at the new width, each line's width
 * over the new columns rounded up. A terminal that re-flows its rows (nearly all in use) wrapped each old line into
 * exactly that many, so the old block is erased whole; the rule leaves its tail above only when the re-flowed block
 * passed the top of the screen. One that does not re-flow (xterm, rxvt, st, GNU screen) cut each line, so the rows the
 * wrap would have added are erased above the block, once: a few log lines of the screen, never of the history. The
 * next frame is whole either way.
 *
 * `close` is the end of a review: one write of the erase, the log lines still due and the cursor's return, whose `done`
 * resolves it, so the report on stdout, written after, starts on the row the block left and nothing of the block is
 * between. `restore` is the same without the wait, plus the end of synchronized output, and runs on every way out: the
 * end, an `Error:` line, the second signal, an uncaught failure and `process.on('exit')`. Each cancels every timer the
 * writer armed, since an aborted review sends no `run:end`; each runs once, and a second call writes nothing.
 *
 * A failure of the view never ends a review: a throw while folding an event, drawing a frame, ticking or writing the
 * summary turns the block off for the rest of the review. The writer erases what it drew as best it can, shows the
 * cursor, cancels its timers, and writes the remaining lines straight, as it does before the first frame.
 */

import type { Clock } from '../../core/clock.ts'
import { inertLine } from '../../core/sanitize.ts'
import type { ReportView } from '../../report/view.ts'
import { timeLeft } from './eta.ts'
import type { TimeLeft } from './eta.ts'
import { frameLines } from './frame.ts'
import type { Glyphs } from './glyphs.ts'
import { logLines } from './lines.ts'
import type { GlyphName, Line } from './lines.ts'
import { DEFAULT_FACTS, fold, startState } from './model.ts'
import { summaryLines } from './summary.ts'
import { widthOf } from './width.ts'
import type { ViewStream, ViewWriter } from './writer.ts'

/** When the first frame is drawn after `run:start`, how often a redraw is allowed, the tick of the timers, and how often the time left is recomputed. */
export const FIRST_FRAME_MS = 500
export const FRAME_MS = 100
export const TICK_MS = 1000
export const ETA_MS = 5000

/** The sequences quorum writes to a terminal, and no others: `ESC` is a character code, so no escape is written in a source. */
export const ESC = String.fromCharCode(0x1B)
export const CSI = `${ESC}[`
export const SYNC_BEGIN = `${CSI}?2026h`
export const SYNC_END = `${CSI}?2026l`
export const CURSOR_HIDE = `${CSI}?25l`
export const CURSOR_SHOW = `${CSI}?25h`
export const ERASE_TO_END = `${CSI}J`
export const cursorUp = (rows: number): string => `${CSI}${rows}A`

/** The colour of each glyph a log line starts with, from the 16-colour palette. */
const GLYPH_COLOURS: Readonly<Record<GlyphName, number>> = {
  answered: 32,
  retry: 33,
  adapted: 33,
  failed: 31,
}

/** The terminal's size when its stream gives none. */
const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24

const COLOUR_CODES = new RegExp(`${ESC}\\[\\d+m`, 'g')

/** The rows lines of these widths take on a terminal of `columns`, a line wrapping at its last column: each its width over them, rounded up, at least one. */
function rowsTaken(widths: readonly number[], columns: number): number {
  return widths.reduce((rows, width) => rows + Math.max(1, Math.ceil(width / columns)), 0)
}

/**
 * The live writer on `stream`: the glyphs and the colour flag are the CLI's choice, and every timer runs on `clock`.
 * `begin` sets the facts of the review, `sink` folds its events, `line` takes the CLI's lines.
 */
export function liveWriter(stream: ViewStream, options: { readonly clock: Clock, readonly glyphs: Glyphs, readonly color: boolean, readonly view: ReportView }): ViewWriter {
  const { clock, glyphs, color, view } = options
  let state = startState(DEFAULT_FACTS)
  /** Whether the first frame's time has come, and whether `close` or `restore` ran. */
  let live = false
  let finished = false
  /** Whether the block was turned off by a failure of the view: the lines go on, straight. */
  let broken = false
  let hidden = false
  let summarized = false
  /** The widths of the block's lines on the screen, and what the last frame was drawn from. */
  let drawn: readonly number[] = []
  let lastText: string | undefined
  let lastColumns = 0
  let lastRows = 0
  let lastWriteAt: number | undefined
  /** The log lines due, formatted, for the next frame. */
  let due: string[] = []
  let left: { readonly at: number, readonly value: TimeLeft } | undefined
  let listening = false
  let cancelFirst: (() => void) | undefined
  let cancelRedraw: (() => void) | undefined
  let cancelTick: (() => void) | undefined

  const size = (): { readonly columns: number, readonly rows: number } => ({
    columns: stream.columns !== undefined && stream.columns > 0
      ? stream.columns
      : DEFAULT_COLUMNS,
    rows: stream.rows !== undefined && stream.rows > 0
      ? stream.rows
      : DEFAULT_ROWS,
  })

  const disarmRedraw = (): void => {
    cancelRedraw?.()
    cancelRedraw = undefined
  }
  const disarmAll = (): void => {
    cancelFirst?.()
    cancelFirst = undefined
    cancelTick?.()
    cancelTick = undefined
    disarmRedraw()
    if (listening) stream.off?.('resize', onResize)
    listening = false
  }

  const format = ({ glyph, text }: Line): string => {
    if (glyph === undefined) return text
    const mark = glyphs[glyph]
    return `${color
      ? `${CSI}${GLYPH_COLOURS[glyph]}m${mark}${CSI}0m`
      : mark} ${text}`
  }
  const straight = (lines: readonly string[]): void => {
    if (lines.length > 0) stream.write(lines.map(text => `${text}\n`).join(''))
  }

  /** What leaves the terminal as it was: the erase of the block, the log lines due, the cursor shown, and for `restore` the end of synchronized output. */
  const farewell = (restoring: boolean): string => {
    // A stream whose size cannot be read is erased at the width of the last frame.
    let columns = lastColumns > 0
      ? lastColumns
      : DEFAULT_COLUMNS
    try {
      columns = size().columns
    } catch {
      // The width of the last frame stands.
    }
    const up = rowsTaken(drawn, columns)
    let out = up > 0
      ? `${cursorUp(up)}${ERASE_TO_END}`
      : ''
    out += due.map(line => `${line}\n`).join('')
    if (hidden) out += CURSOR_SHOW
    if (restoring && (hidden || drawn.length > 0)) out += SYNC_END
    due = []
    drawn = []
    hidden = false
    return out
  }

  /**
   * Turns the block off for the rest of the review after a failure of the view: the timers are cancelled, and what was
   * drawn is erased as best the terminal allows, with the cursor shown. It never throws, and what it cannot write is lost.
   */
  const degrade = (): void => {
    if (broken) return
    broken = true
    live = false
    try {
      disarmAll()
    } catch {
      // A stream that cannot drop its listener keeps it, and the writer ignores what it hears.
    }
    try {
      const out = farewell(true)
      if (out !== '') stream.write(out)
    } catch {
      // The terminal cannot be written to: there is nothing more to restore.
    }
  }

  /** Runs `action`, and turns the block off when it throws: the review goes on. */
  const guarded = (action: () => void): void => {
    try {
      action()
    } catch {
      degrade()
    }
  }

  /** Draws the frame, with the log lines due, in one write; nothing when there is nothing to say. */
  const draw = (): void => {
    disarmRedraw()
    if (!live || finished) return
    const now = clock.now()
    const { columns, rows } = size()
    if (left === undefined || now - left.at >= ETA_MS) {
      left = {
        at: now,
        value: timeLeft(state, now),
      }
    }
    const frame = frameLines(state, now, {
      columns,
      rows,
      glyphs,
      color,
      view,
      timeLeft: left.value,
    })
    // A frame of one empty line is a block cut to nothing, which the ASCII set's three-column ellipsis is at 3 columns or fewer
    // and the Unicode set's is at 1: there is nothing to draw. The Unicode set still draws `…` at 2 columns and `r…` at 3.
    const block = frame.length === 1 && frame[0] === ''
      ? []
      : frame
    if (due.length === 0 && drawn.length === 0 && block.length === 0) return
    const text = block.join('\n')
    if (due.length === 0 && text === lastText && columns === lastColumns && rows === lastRows) return
    const up = rowsTaken(drawn, columns)
    const lines = [
      ...due,
      ...block,
    ].map(line => `${line}\n`).join('')
    if (block.length === 0 && up === 0) {
      // Nothing is drawn and nothing is erased: the log lines are written as they are.
      stream.write(lines)
    } else {
      let out = SYNC_BEGIN
      if (block.length > 0 && !hidden) {
        out += CURSOR_HIDE
        hidden = true
      }
      if (up > 0) out += `${cursorUp(up)}${ERASE_TO_END}`
      stream.write(`${out}${lines}${SYNC_END}`)
    }
    due = []
    drawn = block.map(line => widthOf(line.replace(COLOUR_CODES, '')))
    lastText = text
    lastColumns = columns
    lastRows = rows
    lastWriteAt = now
  }

  /** Draws now when the last frame is a tenth of a second old, else at that time: any number of events in between make one frame. */
  const schedule = (): void => {
    if (!live || finished || cancelRedraw !== undefined) return
    const wait = lastWriteAt === undefined
      ? 0
      : FRAME_MS - (clock.now() - lastWriteAt)
    if (wait <= 0) {
      draw()
      return
    }
    cancelRedraw = clock.timer(wait, () => {
      cancelRedraw = undefined
      guarded(draw)
    })
  }

  function onResize(): void {
    guarded(draw)
  }

  const armTick = (): void => {
    cancelTick = clock.timer(TICK_MS, () => {
      cancelTick = undefined
      if (finished || state.ended) return
      guarded(() => {
        schedule()
        armTick()
      })
    })
  }

  const goLive = (): void => {
    cancelFirst = undefined
    if (finished || broken || state.ended) return
    guarded(() => {
      live = true
      stream.on?.('resize', onResize)
      listening = stream.on !== undefined
      armTick()
      draw()
    })
  }

  const finish = (restoring: boolean): string => {
    if (finished) return ''
    finished = true
    disarmAll()
    return farewell(restoring)
  }

  /** Writes `lines` straight, once the block is off; a stream that throws loses them, and the review goes on. */
  const straightGuarded = (lines: readonly string[]): void => {
    try {
      straight(lines)
    } catch {
      // The terminal cannot be written to: the lines are lost, never the review.
    }
  }

  return {
    sink: (event) => {
      let lines: string[] = []
      try {
        state = fold(state, event, clock.now())
        lines = logLines(event, state, view).map(format)
      } catch {
        degrade()
      }
      if (broken) {
        straightGuarded(lines)
        return
      }
      guarded(() => {
        if (event.type === 'run:start' && !live && !finished) {
          cancelFirst?.()
          cancelFirst = clock.timer(FIRST_FRAME_MS, goLive)
        }
        if (live && !finished) due.push(...lines)
        else straight(lines)
        if (event.type === 'run:end') {
          cancelFirst?.()
          cancelFirst = undefined
          cancelTick?.()
          cancelTick = undefined
          draw()
        } else {
          schedule()
        }
      })
    },
    line: (_level, text) => {
      const line = inertLine(text)
      if (live && !finished && !broken) {
        due.push(line)
        guarded(schedule)
      } else {
        straightGuarded([line])
      }
    },
    begin: (facts) => {
      state = startState(facts)
      summarized = false
      left = undefined
    },
    summary: (facts) => {
      if (summarized) return
      summarized = true
      try {
        straight(summaryLines(state, facts, view, glyphs.range))
      } catch {
        // The summary is the view's, and a failure of it never changes the review's outcome.
      }
    },
    close: () => {
      const out = finish(false)
      if (out === '') return Promise.resolve()
      return new Promise((resolve) => {
        try {
          stream.write(out, () => {
            resolve()
          })
        } catch {
          resolve()
        }
      })
    },
    restore: () => {
      const out = finish(true)
      try {
        if (out !== '') stream.write(out)
      } catch {
        // The terminal cannot be written to: there is nothing more to restore.
      }
    },
  }
}
