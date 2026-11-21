/**
 * A terminal for the specs of the live view: it interprets what quorum writes, the sequences of the Global Constraints
 * and nothing else, and keeps the screen and the rows that scrolled off it. It throws on anything it does not know, an
 * OSC and any control character among it, so a spec that writes through it also proves the output holds no other.
 *
 * It follows a VT100 where that matters to the view: a character takes `widthOf` columns and wraps at the last one,
 * the wrap deferred until the next character, so a line of exactly the width takes one row; `CSI 0 A` moves up one row,
 * as `CSI A` does; a row past the last scrolls the top row into the history. A resize either re-flows the rows (a
 * logical line, its rows joined by soft wraps, wrapped again at the new width, the cursor kept on its place in it), as
 * nearly every terminal in use does, or cuts each row, as xterm does.
 */

import { widthOf } from '../cli/view/width.ts'
import type { ViewStream } from '../cli/view/writer.ts'

export interface FakeTerminal {
  readonly stream: ViewStream
  /** The rows of the screen, each with its trailing spaces trimmed. */
  readonly screen: () => string[]
  /** The rows that scrolled off the top, oldest first. */
  readonly history: () => string[]
  /** Everything written, as written. */
  readonly written: () => string
  readonly cursorVisible: () => boolean
  /** Changes the size, re-wraps or cuts the rows, then calls the `'resize'` listeners. */
  readonly resize: (columns: number, rows: number) => void
}

const ESC = 0x1B

/** A row: one entry per column, a wide character's second column holding `''`, and whether its text goes on in the row below. */
interface Row {
  cols: string[]
  wrapped: boolean
}

function blankRow(columns: number): Row {
  return {
    cols: Array.from<string>({ length: columns }).fill(' '),
    wrapped: false,
  }
}

/** The text of a row, its trailing spaces trimmed. */
const rowText = (row: Row): string => row.cols.join('').replace(/ +$/, '')

const label = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`

/** A logical line being re-wrapped, and where the cursor stands in it. */
interface Logical {
  chars: string[]
  /** The cursor's offset in columns from the line's start, when the cursor is on it. */
  cursor?: number
}

/** A terminal of `size`; with `reflow`, a resize re-wraps its rows, else it cuts them. */
export function fakeTerminal(size: { readonly columns: number, readonly rows: number }, options: { readonly reflow?: boolean } = {}): FakeTerminal {
  let columns = size.columns
  let height = size.rows
  let rows: Row[] = Array.from({ length: height }, () => blankRow(columns))
  const history: string[] = []
  const log: string[] = []
  const listeners = new Set<() => void>()
  let row = 0
  /** The cursor's column; `columns` is the deferred wrap, the cursor past the last column. */
  let col = 0
  let visible = true

  const scrollIfNeeded = (): void => {
    if (row < height) return
    history.push(rowText(rows[0]))
    rows.shift()
    rows.push(blankRow(columns))
    row = height - 1
  }
  const lineFeed = (): void => {
    row += 1
    col = 0
    scrollIfNeeded()
  }

  const put = (character: string): void => {
    const width = widthOf(character)
    if (col + width > columns) {
      rows[row].wrapped = true
      lineFeed()
    }
    const cells = rows[row].cols
    cells[col] = character
    if (width === 2) cells[col + 1] = ''
    col += width
  }

  const eraseToEnd = (): void => {
    const at = Math.min(col, columns - 1)
    const cells = rows[row].cols
    const from = cells[at] === '' && at > 0
      ? at - 1
      : at
    cells.fill(' ', from)
    rows[row].wrapped = false
    for (let below = row + 1; below < height; below++) rows[below] = blankRow(columns)
  }

  const csi = (text: string, start: number): number => {
    let at = start
    const prefix = text[at] === '?'
      ? '?'
      : ''
    if (prefix !== '') at += 1
    const paramsAt = at
    while (at < text.length && /[\d;]/.test(text[at])) at += 1
    const params = text.slice(paramsAt, at)
    const final = text[at]
    if (final === undefined) throw new Error('the terminal got a sequence cut short')
    const sequence = `ESC [ ${prefix}${params}${final}`
    const known = (): never => {
      throw new Error(`the terminal does not know the sequence ${sequence}`)
    }
    if (prefix === '?') {
      if ((params === '25' || params === '2026') && (final === 'h' || final === 'l')) {
        if (params === '25') visible = final === 'h'
        return at + 1
      }
      return known()
    }
    if (final === 'm' && /^[\d;]*$/.test(params)) return at + 1
    if (final === 'A' && /^\d*$/.test(params)) {
      row = Math.max(0, row - Math.max(1, Number(params || '1')))
      col = Math.min(col, columns - 1)
      return at + 1
    }
    if (final === 'J' && (params === '' || params === '0')) {
      eraseToEnd()
      return at + 1
    }
    return known()
  }

  const interpret = (text: string): void => {
    let at = 0
    while (at < text.length) {
      const code = text.codePointAt(at)!
      const character = String.fromCodePoint(code)
      if (code === ESC) {
        if (text[at + 1] !== '[') throw new Error(`the terminal does not know an escape sequence that starts ESC ${text[at + 1] ?? 'at the end'}`)
        at = csi(text, at + 2)
        continue
      }
      at += character.length
      if (code === 0x0A) lineFeed()
      else if (code === 0x0D) col = 0
      else if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) throw new Error(`the terminal does not know the control character ${label(code)}`)
      else put(character)
    }
  }

  /** Keeps the screen `height` rows: blank rows below the cursor go first, then the top rows into the history. */
  const fit = (): void => {
    while (rows.length > height) {
      if (rows.length - 1 > row && rowText(rows[rows.length - 1]) === '') {
        rows.pop()
      } else {
        history.push(rowText(rows[0]))
        rows.shift()
        row = Math.max(0, row - 1)
      }
    }
    while (rows.length < height) rows.push(blankRow(columns))
  }

  const cut = (): void => {
    const pending = col >= columns
    rows = rows.map((old) => {
      const cols = Array.from({ length: columns }, (_, index) => old.cols[index] ?? ' ')
      // A wide character cut in half goes.
      if (old.cols[columns] === '') cols[columns - 1] = ' '
      return { cols, wrapped: old.wrapped }
    })
    col = pending
      ? columns
      : Math.min(col, columns - 1)
  }

  const columnsOf = (chars: readonly string[]): number => chars.reduce((total, character) => total + widthOf(character), 0)

  /** The rows as logical lines: a row and those its soft wraps continue, the last row's trailing blanks trimmed, with the cursor's offset in its line. */
  const logicalLines = (): Logical[] => {
    const lines: Logical[] = []
    let line: Logical = { chars: [] }
    rows.forEach((old, index) => {
      if (index === row) line.cursor = columnsOf(line.chars) + col
      line.chars.push(...old.cols.filter(cell => cell !== ''))
      if (old.wrapped) return
      while (line.chars.at(-1) === ' ') line.chars.pop()
      lines.push(line)
      line = { chars: [] }
    })
    return lines
  }

  const reflow = (): void => {
    const wrapped: Row[] = []
    let cursorRow = 0
    let cursorCol = 0
    for (const { chars, cursor } of logicalLines()) {
      // A cursor past the end of its line's text keeps its place on blanks.
      const cells = [...chars]
      if (cursor !== undefined) {
        for (let width = columnsOf(cells); width < cursor; width++) cells.push(' ')
      }
      let at = blankRow(columns)
      wrapped.push(at)
      let used = 0
      let walked = 0
      let found = cursor === undefined
      const mark = (): void => {
        if (found || walked < cursor!) return
        found = true
        cursorRow = wrapped.length - 1
        cursorCol = used
      }
      for (const character of cells) {
        const width = widthOf(character)
        if (used + width > columns) {
          at.wrapped = true
          at = blankRow(columns)
          wrapped.push(at)
          used = 0
        }
        mark()
        at.cols[used] = character
        if (width === 2) at.cols[used + 1] = ''
        used += width
        walked += width
      }
      mark()
    }
    rows = wrapped
    row = cursorRow
    col = cursorCol
  }

  return {
    stream: {
      isTTY: true,
      get columns() {
        return columns
      },
      get rows() {
        return height
      },
      write: (text, done) => {
        log.push(text)
        interpret(text)
        done?.()
        return true
      },
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
    },
    screen: () => rows.map(rowText),
    history: () => [...history],
    written: () => log.join(''),
    cursorVisible: () => visible,
    resize: (newColumns, newRows) => {
      const widthChanged = newColumns !== columns
      columns = newColumns
      height = newRows
      if (widthChanged) {
        if (options.reflow === true) reflow()
        else cut()
      }
      fit()
      for (const listener of [...listeners]) listener()
    },
  }
}
