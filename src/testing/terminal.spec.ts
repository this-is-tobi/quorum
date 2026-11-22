import { describe, expect, it, vi } from 'vitest'
import { CSI, CURSOR_HIDE, CURSOR_SHOW, cursorUp, ERASE_TO_END, ESC, SYNC_BEGIN, SYNC_END } from '../cli/view/terminal.ts'
import { fakeTerminal } from './terminal.ts'

describe('fakeTerminal', () => {
  it('moves a carriage return to the first column of its row, even from the deferred wrap', () => {
    const terminal = fakeTerminal({ columns: 10, rows: 3 })
    const { write } = terminal.stream
    write(`${'a'.repeat(10)}\rb`)
    expect(terminal.screen()).toEqual([`b${'a'.repeat(9)}`, '', ''])
    // Typed text echoed at the cursor, then a return, a move up and an erase: nothing of the row above is left.
    write(`\ndef\n^C\r${cursorUp(1)}${ERASE_TO_END}`)
    expect(terminal.screen()).toEqual([`b${'a'.repeat(9)}`, '', ''])
  })

  it('interprets text, line feeds, carriage returns, cursor up and erase to the end of the screen', () => {
    const terminal = fakeTerminal({ columns: 10, rows: 5 })
    const { write } = terminal.stream
    write('abc\ndef')
    expect(terminal.screen()).toEqual(['abc', 'def', '', '', ''])
    write('\rXY')
    expect(terminal.screen()[1]).toBe('XYf')
    // Up one row and erase from the cursor to the end of the screen: the row's tail goes, and every row below.
    write(`\n\nlast${cursorUp(2)}${ERASE_TO_END}`)
    expect(terminal.screen()).toEqual(['abc', 'XYf', '', '', ''])
    // `CSI 0 A` is one row, as a VT100 reads it, and a move above the first row stops at the top.
    write(`\nzz${CSI}0A${ERASE_TO_END}`)
    expect(terminal.screen()).toEqual(['abc', 'XY', '', '', ''])
    write(`\n${cursorUp(40)}${ERASE_TO_END}`)
    expect(terminal.screen()).toEqual(['', '', '', '', ''])

    // A character takes its columns and wraps at the last one, after it: a full row followed by a line feed is one row.
    write(`${'a'.repeat(10)}\nb${'c'.repeat(11)}\n`)
    expect(terminal.screen()).toEqual([
      'a'.repeat(10),
      `b${'c'.repeat(9)}`,
      'cc',
      '',
      '',
    ])
    // A wide character that does not fit in the last column goes to the next row whole.
    write(`${'d'.repeat(9)}中`)
    expect(terminal.screen()[3]).toBe('d'.repeat(9))
    expect(terminal.screen()[4]).toBe('中')

    // The visibility of the cursor, synchronized output and colour are read, and change nothing on the screen.
    const before = terminal.screen()
    expect(terminal.cursorVisible()).toBe(true)
    write(`${SYNC_BEGIN}${CURSOR_HIDE}`)
    expect(terminal.cursorVisible()).toBe(false)
    write(`${CSI}31m${CSI}0m${CSI}1;32m${SYNC_END}${CURSOR_SHOW}`)
    expect(terminal.cursorVisible()).toBe(true)
    expect(terminal.screen()).toEqual(before)
    expect(terminal.written()).toContain(`${SYNC_BEGIN}${CURSOR_HIDE}`)
  })

  it('scrolls rows off the top into the history', () => {
    const terminal = fakeTerminal({ columns: 8, rows: 3 })
    terminal.stream.write('a\nb\nc\nd\n')
    expect(terminal.history()).toEqual(['a', 'b'])
    expect(terminal.screen()).toEqual(['c', 'd', ''])
    // A wrap past the last row scrolls too.
    terminal.stream.write('e'.repeat(17))
    expect(terminal.history()).toEqual(['a', 'b', 'c', 'd'])
    expect(terminal.screen()).toEqual([
      'e'.repeat(8),
      'e'.repeat(8),
      'e',
    ])
  })

  it.each([
    [
      're-wraps the rows when it re-flows',
      true,
      ['abcde', 'fghij', 'klm', 'xyz'],
      ['klm', 'xyz'],
      ['abcde', 'fghij'],
    ],
    [
      'cuts the rows when it does not',
      false,
      ['abcde', 'klm', 'xyz', ''],
      ['klm', 'xyz'],
      ['abcde'],
    ],
  ])('%s on a resize', (_name, reflow, narrow, short, history) => {
    const terminal = fakeTerminal({ columns: 10, rows: 4 }, { reflow })
    const resized = vi.fn()
    terminal.stream.on?.('resize', resized)
    terminal.stream.write('abcdefghijklm\nxyz')
    terminal.resize(5, 4)
    expect(resized).toHaveBeenCalledOnce()
    expect(terminal.screen()).toEqual(narrow)
    // The cursor kept its place after `xyz`.
    terminal.stream.write('!')
    expect(terminal.screen()[narrow.indexOf('xyz')]).toBe('xyz!')

    // A height that shrinks pushes the rows above the cursor into the history.
    terminal.resize(5, 2)
    expect(terminal.screen()).toEqual([short[0], 'xyz!'])
    expect(terminal.history()).toEqual(history)
    expect(terminal.stream.rows).toBe(2)
    expect(terminal.stream.columns).toBe(5)

    terminal.stream.off?.('resize', resized)
    terminal.resize(6, 2)
    expect(resized).toHaveBeenCalledTimes(2)
  })

  it('throws on a sequence it does not know, an OSC among them', () => {
    const terminal = fakeTerminal({ columns: 10, rows: 3 })
    const code = (value: number): string => String.fromCharCode(value)
    const unknown = [
      `${ESC}]0;title${code(0x07)}`,
      `${ESC}]8;;https://example.test${ESC}\\`,
      `${CSI}2J`,
      `${CSI}K`,
      `${CSI}H`,
      `${CSI}?1049h`,
      `${CSI}1;2A`,
      `${ESC}c`,
      `${ESC}7`,
      ESC,
      `${CSI}1`,
      code(0x07),
      code(0x08),
      code(0x09),
      code(0x00),
      code(0x7F),
      code(0x9B),
      code(0x9D),
    ]
    for (const text of unknown) expect(() => terminal.stream.write(text), JSON.stringify(text)).toThrow(/terminal/)
    // Nothing of what it refused reached the screen.
    expect(terminal.screen()).toEqual(['', '', ''])
  })
})
