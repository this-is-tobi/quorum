import { describe, expect, it, vi } from 'vitest'
import type { QuorumEvent } from '../../core/types.ts'
import { fakeClock } from '../../testing/clock.ts'
import type { FakeClock } from '../../testing/clock.ts'
import { longReview, twoProfiles } from '../../testing/events.ts'
import type { Timed } from '../../testing/events.ts'
import { reportResult } from '../../testing/report.ts'
import { fakeTerminal } from '../../testing/terminal.ts'
import type { FakeTerminal } from '../../testing/terminal.ts'
import { CARRIAGE_RETURN, CSI, CURSOR_HIDE, CURSOR_SHOW, ERASE_TO_END, ESC, ETA_MS, FIRST_FRAME_MS, FRAME_MS, liveWriter, SYNC_BEGIN, SYNC_END, TICK_MS } from './terminal.ts'
import { ASCII_GLYPHS, UNICODE_GLYPHS } from './glyphs.ts'
import type { Glyphs } from './glyphs.ts'
import { DEFAULT_FACTS } from './model.ts'
import { widthOf } from './width.ts'
import type { ViewStream, ViewWriter } from './writer.ts'
import type { ReportView } from '../../report/view.ts'

// The time left is counted through a spy, to see how often it is recomputed.
const calls = vi.hoisted(() => ({ timeLeft: 0 }))
vi.mock('./eta.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./eta.ts')>()
  return {
    ...original,
    timeLeft: (...args: Parameters<typeof original.timeLeft>) => {
      calls.timeLeft += 1
      return original.timeLeft(...args)
    },
  }
})

const API = { id: 'api', model: 'm' }

function started(...profiles: string[]): QuorumEvent {
  return {
    type: 'run:start',
    profiles,
    providers: Object.fromEntries(profiles.map(id => [
      id,
      { research: API, lenses: {} },
    ])),
  }
}
function researching(parts = 44): QuorumEvent {
  return {
    type: 'stage:start',
    profile: 'security',
    stage: 'research',
    parts,
  }
}
function sending(call: number, index: number): QuorumEvent {
  return {
    type: 'call:start',
    call,
    profile: 'security',
    role: 'research',
    provider: API,
    part: { index, count: 44 },
    reserved: 60_000,
    timeoutMs: 600_000,
  }
}
function answered(index: number): QuorumEvent {
  return {
    type: 'part',
    profile: 'security',
    part: { index, count: 44 },
    outcome: 'reviewed',
    durationMs: 1000,
    spent: 1000,
    listed: 1,
  }
}
const ended: QuorumEvent = {
  type: 'run:end',
  kept: 0,
  discarded: 0,
  unreviewed: 0,
  incomplete: 0,
  durationMs: 1,
}
/** An event the view has no line or state for. */
const silent = { type: 'something:else' } as unknown as QuorumEvent

/** Moves the clock `ms` on, firing each timer on the way in its order. */
function advance(clock: FakeClock, ms: number): void {
  const marker = { reached: false }
  clock.timer(ms, () => {
    marker.reached = true
  })
  while (!marker.reached && clock.fireNext());
}

/** Feeds the events due by `until`, each at its time, then moves the clock to `until`. */
function play(writer: ViewWriter, clock: FakeClock, list: readonly Timed[], until: number): void {
  for (const { at, event } of list) {
    if (at > until) break
    advance(clock, at - clock.now())
    writer.sink(event)
  }
  advance(clock, until - clock.now())
}

/** The stream of a terminal, with every write it gets kept. */
function tap(terminal: FakeTerminal, listens = true): { stream: ViewStream, writes: string[] } {
  const writes: string[] = []
  const { stream } = terminal
  return {
    writes,
    stream: {
      isTTY: true,
      get columns() {
        return stream.columns
      },
      get rows() {
        return stream.rows
      },
      write: (text, done) => {
        writes.push(text)
        return stream.write(text, done)
      },
      on: listens
        ? stream.on
        : () => undefined,
      off: stream.off,
    },
  }
}

interface Rig {
  readonly terminal: FakeTerminal
  readonly clock: FakeClock
  readonly writer: ViewWriter
  readonly writes: string[]
}

function rig(options: { columns?: number, rows?: number, reflow?: boolean, color?: boolean, glyphs?: Glyphs, view?: ReportView, listens?: boolean } = {}): Rig {
  const terminal = fakeTerminal({ columns: options.columns ?? 80, rows: options.rows ?? 24 }, { reflow: options.reflow ?? true })
  const clock = fakeClock()
  const { stream, writes } = tap(terminal, options.listens)
  const writer = liveWriter(stream, {
    clock,
    glyphs: options.glyphs ?? UNICODE_GLYPHS,
    color: options.color ?? false,
    view: options.view ?? 'full',
  })
  return { terminal, clock, writer, writes }
}

/** `text` as a pattern that matches it alone. */
const escaped = (text: string): string => text.replace(/[[\]?.*+^$(){}|\\]/g, '\\$&')

const filled = (rows: readonly string[]): string[] => rows.filter(row => row !== '')

/** The sequences quorum may write: a cursor move, the erase, the cursor's visibility, synchronized output, and its colours. */
const OWN_SEQUENCE = /^\[(?:\d+A|J|\?25[lh]|\?2026[lh]|(?:31|32|33|36|0)m)/

describe('liveWriter', () => {
  it('writes the log lines straight with their glyphs, and no block, before 500 ms and for a review that ends sooner', async () => {
    const { writer, clock, terminal, writes } = rig({ glyphs: ASCII_GLYPHS })
    writer.begin(DEFAULT_FACTS)
    writer.sink(started('security'))
    writer.sink(researching())
    writer.sink(sending(1, 1))
    expect(clock.pending()).toBe(1)
    expect(clock.armed).toEqual([FIRST_FRAME_MS])
    advance(clock, 50)
    writer.line('banner', 'Research (m @ http://localhost:11434)...')
    advance(clock, 50)
    writer.sink(answered(1))
    advance(clock, 300)
    writer.sink(ended)
    // The review ended before its first frame: the timer is gone, and nothing but lines was written.
    expect(clock.pending()).toBe(0)
    await writer.close()
    expect(filled(terminal.screen())).toEqual([
      'Research (m @ http://localhost:11434)...',
      '+ part 1 of 44: answered in 1.0s, 1.00k tokens, 1 finding(s) listed',
      '0 kept, 0 discarded, 0 unreviewed by panel',
    ])
    expect(terminal.written()).not.toContain(ESC)
    expect(writes).toHaveLength(3)
    expect(terminal.cursorVisible()).toBe(true)
    expect(terminal.history()).toEqual([])

    // The glyph is coloured when colour is on, and the text after it is not.
    const coloured = rig({ color: true })
    coloured.writer.sink(started('security'))
    coloured.writer.sink(answered(1))
    expect(coloured.terminal.written()).toBe(`${CSI}32m${UNICODE_GLYPHS.answered}${CSI}0m part 1 of 44: answered in 1.0s, 1.00k tokens, 1 finding(s) listed\n`)
  })

  it('draws the first frame at 500 ms in one write, wrapped in synchronized output, the cursor hidden', () => {
    const { writer, clock, terminal, writes } = rig()
    writer.sink(started('security'))
    writer.sink(researching())
    writer.sink(sending(1, 1))
    advance(clock, FIRST_FRAME_MS - 1)
    expect(writes).toEqual([])
    expect(terminal.cursorVisible()).toBe(true)
    advance(clock, 1)
    expect(writes).toHaveLength(1)
    const [frame] = writes
    expect(frame.startsWith(`${SYNC_BEGIN}${CURSOR_HIDE}`)).toBe(true)
    expect(frame.endsWith(SYNC_END)).toBe(true)
    // The first frame moves nowhere: there is no block to erase.
    expect(frame).not.toContain(`${CSI}0A`)
    expect(frame).not.toContain(ERASE_TO_END)
    expect(terminal.cursorVisible()).toBe(false)
    const block = filled(terminal.screen())
    expect(block.length).toBeGreaterThanOrEqual(4)
    expect(block[0]).toMatch(/^─+ 1s ──$/)
    expect(block[1]).toMatch(/^security {2}research █*░* {2}0\/44 parts/)
    expect(block.some(row => row.startsWith('calls '))).toBe(true)
    // It rests on the row below the block.
    terminal.stream.write('X')
    expect(terminal.screen()[block.length]).toBe('X')
  })

  it('redraws at most every 100 ms and only when the frame changed, and each second for its timers', () => {
    const { writer, clock, writes } = rig()
    writer.sink(started('security'))
    writer.sink(researching())
    advance(clock, FIRST_FRAME_MS)
    expect(writes).toHaveLength(1)
    // Ten events in 50 ms make one write, at the end of the 100 ms.
    for (let call = 1; call <= 10; call++) {
      advance(clock, 5)
      writer.sink(sending(call, call))
    }
    expect(writes).toHaveLength(1)
    advance(clock, FRAME_MS - 50 - 1)
    expect(writes).toHaveLength(1)
    advance(clock, 1)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toContain('p10 ')
    expect(clock.pending()).toBe(1)

    // An event that changes nothing on the screen writes nothing.
    advance(clock, 100)
    writer.sink(silent)
    advance(clock, 200)
    expect(writes).toHaveLength(2)

    // No event for the rest of the second: the tick redraws once, for the elapsed time and the calls' timers.
    advance(clock, FIRST_FRAME_MS + TICK_MS - clock.now() - 1)
    expect(writes).toHaveLength(2)
    advance(clock, 1)
    expect(writes).toHaveLength(3)
    advance(clock, TICK_MS)
    expect(writes).toHaveLength(4)
    expect(clock.pending()).toBe(1)
  })

  it('writes each log line above the block, erasing and redrawing the block in the same write', async () => {
    const { writer, clock, terminal, writes } = rig({ rows: 10 })
    writer.sink(started('security'))
    writer.sink(researching())
    writer.sink(sending(1, 1))
    advance(clock, FIRST_FRAME_MS)
    const lines: string[] = []
    for (let part = 1; part <= 12; part++) {
      advance(clock, 200)
      const before = writes.length
      writer.sink(answered(part))
      advance(clock, FRAME_MS)
      const line = `part ${part} of 44: answered in 1.0s, 1.00k tokens, 1 finding(s) listed`
      lines.push(`${UNICODE_GLYPHS.answered} ${line}`)
      const holding = writes.slice(before).filter(write => write.includes(line))
      expect(holding).toHaveLength(1)
      const [write] = holding
      // In one write: the return to the line's start, the move up over the old block and its erase, then the line, then the new block.
      expect(write).toMatch(new RegExp(`^${escaped(SYNC_BEGIN)}${escaped(CARRIAGE_RETURN)}${escaped(CSI)}\\d+A${escaped(ERASE_TO_END)}`))
      expect(write.indexOf(ERASE_TO_END)).toBeLessThan(write.indexOf(line))
      expect(write.indexOf(line)).toBeLessThan(write.indexOf('security  research'))
      expect(write.endsWith(SYNC_END)).toBe(true)
    }
    // Twelve lines and a block do not fit in ten rows: the history holds log lines alone, each once.
    expect(terminal.history().length).toBeGreaterThan(0)
    expect(terminal.history().every(row => row.startsWith(UNICODE_GLYPHS.answered))).toBe(true)
    await writer.close()
    expect(filled([
      ...terminal.history(),
      ...terminal.screen(),
    ])).toEqual(lines)
  })

  it.each<[string, (rig: Rig) => Promise<void> | void]>([
    [
      'the next frame',
      ({ clock }) => advance(clock, FRAME_MS),
    ],
    [
      'close',
      ({ writer }) => writer.close(),
    ],
    [
      'restore',
      ({ writer }) => writer.restore(),
    ],
  ])('starts each erase at the line\'s start, so an echoed ^C leaves nothing of the old block: %s', async (_name, finish) => {
    const line = `${UNICODE_GLYPHS.answered} part 1 of 44: answered in 1.0s, 1.00k tokens, 1 finding(s) listed`
    const live = rig()
    live.writer.sink(started('security'))
    live.writer.sink(researching())
    live.writer.sink(sending(1, 1))
    advance(live.clock, FIRST_FRAME_MS)
    expect(live.terminal.screen()[0]).toMatch(/^─+/)
    // The terminal echoes the typed Ctrl-C where the cursor rests, below the block: the cursor stands at the third column.
    live.terminal.stream.write('^C')
    live.writer.sink(answered(1))
    await finish(live)
    // The row the old block started on holds the log line alone, with no cell of the old block's first row before it.
    expect(live.terminal.screen()[0]).toBe(line)
    expect(live.terminal.history()).toEqual([])
    // Nothing of the old block is left below it either, once the writer is closed.
    await live.writer.close()
    expect(filled(live.terminal.screen())).toEqual([line])
  })

  it('erases the block before the report on a shared terminal, and writes the summary after it', async () => {
    const { writer, clock, terminal } = rig()
    const list = longReview()
    writer.begin(DEFAULT_FACTS)
    writer.line('banner', 'Research (api)...')
    play(writer, clock, list, 200_000)
    // A block is on screen, below the log lines.
    expect(terminal.screen().some(row => row.startsWith('calls '))).toBe(true)
    writer.sink({
      type: 'run:end',
      kept: 4,
      discarded: 2,
      unreviewed: 0,
      incomplete: 1,
      durationMs: 200_000,
    })
    await writer.close()
    // Stdout is the same terminal, and the report is written once `close` has resolved.
    terminal.stream.write('REPORT one\nREPORT two\n')
    writer.summary({
      stdout: { format: 'text', terminal: true },
      stderr: { terminal: true },
      outputs: [],
      state: { kind: 'none', kept: 0 },
      result: reportResult({
        unreviewed: [],
        meta: { durationMs: 200_000 },
      }),
    })
    const rows = filled(terminal.screen())
    const report = rows.indexOf('REPORT one')
    expect(rows[0]).toBe('Research (api)...')
    expect(rows.slice(1, report).every(row => row.startsWith(UNICODE_GLYPHS.answered) || /^\d+ kept/.test(row))).toBe(true)
    expect(rows.slice(report, report + 2)).toEqual(['REPORT one', 'REPORT two'])
    expect(rows.length).toBeGreaterThan(report + 3)
    expect(rows.slice(report + 2).every(row => /^(?:time|tokens|calls|gaps|result): /.test(row))).toBe(true)
    expect(rows.at(-1)).toMatch(/^result: /)
    // No row of the block is anywhere on the screen or in the history.
    expect(rows.some(row => /^─+|^calls |^tokens |^security {2}research/.test(row))).toBe(false)
    expect(terminal.history()).toEqual([])
    expect(terminal.cursorVisible()).toBe(true)
  })

  const LOG = Array.from({ length: 8 }, (_, index) => `log line ${index + 1}`)

  /** A review drawn on 120 columns, with eight log lines above its block, and a twin that was drawn on 60 from the start. */
  function shrunk(reflow: boolean): { before: string[], terminal: FakeTerminal, clock: FakeClock, twin: Rig } {
    // No part line: the log has the three short lines alone, so no row of it is longer than the new width.
    const events = longReview().filter(({ event }) => event.type !== 'part')
    const make = (columns: number): Rig => {
      const made = rig({ columns, rows: 30, reflow })
      made.writer.begin(DEFAULT_FACTS)
      for (const text of LOG) made.writer.line('banner', text)
      play(made.writer, made.clock, events, 400_000)
      return made
    }
    const main = make(120)
    const twin = make(60)
    // The twin draws again at this very moment, which is when the main terminal's frame will be drawn.
    twin.terminal.resize(60, 30)
    const before = filled(main.terminal.screen())
    return {
      before,
      terminal: main.terminal,
      clock: main.clock,
      twin,
    }
  }

  it.each([
    ['re-flows', true],
    ['does not re-flow', false],
  ])('erases the old block after a shrink on a terminal that %s', (_name, reflow) => {
    const { before, terminal, clock, twin } = shrunk(reflow)
    const logRows = LOG.length
    const oldBlock = before.slice(logRows)
    expect(before.slice(0, logRows)).toEqual(LOG)
    expect(oldBlock.some(row => widthOf(row) > 60)).toBe(true)
    terminal.resize(60, 30)
    const now = filled(terminal.screen())
    // The block is whole at the new width: no row of the old one is left, on the screen or in the history.
    expect(terminal.history()).toEqual([])
    expect(now.every(row => widthOf(row) <= 59)).toBe(true)
    expect(now.filter(row => /^─+ \d+m\d\ds ──$/.test(row))).toHaveLength(1)
    const fresh = filled(twin.terminal.screen())
    const newBlock = fresh.slice(logRows)
    if (reflow) {
      // Each old line wrapped into the rows the rule counted: the screen is what a terminal drawn at 60 columns shows.
      expect(now).toEqual(fresh)
    } else {
      // Each old line was cut, so the rule moved up over the rows its wrap would have added: log lines above, once.
      const extra = oldBlock.reduce((rows, row) => rows + Math.ceil(widthOf(row) / 60), 0) - oldBlock.length
      expect(extra).toBeGreaterThan(0)
      expect(now).toEqual([
        ...fresh.slice(0, logRows - extra),
        ...newBlock,
      ])
      // The next frames erase no more of the log.
      advance(clock, 3 * TICK_MS)
      expect(filled(terminal.screen()).slice(0, logRows - extra)).toEqual(fresh.slice(0, logRows - extra))
      expect(filled(terminal.screen())).toHaveLength(logRows - extra + newBlock.length)
    }
  })

  it('follows a resize event at once, and reads a resize it missed at the next tick', () => {
    const run = (listens: boolean): Rig => {
      const made = rig({ listens })
      made.writer.sink(started('security'))
      made.writer.sink(researching())
      made.writer.sink(sending(1, 1))
      advance(made.clock, FIRST_FRAME_MS)
      expect(made.writes).toHaveLength(1)
      return made
    }
    const seen = run(true)
    seen.terminal.resize(50, 24)
    // At once: no timer has fired.
    expect(seen.writes).toHaveLength(2)
    expect(filled(seen.terminal.screen()).every(row => widthOf(row) <= 49)).toBe(true)

    const missed = run(false)
    missed.terminal.resize(50, 24)
    expect(missed.writes).toHaveLength(1)
    advance(missed.clock, TICK_MS)
    expect(missed.writes).toHaveLength(2)
    expect(filled(missed.terminal.screen()).every(row => widthOf(row) <= 49)).toBe(true)
    // The size a frame reads is the stream's at that moment, whatever the event said.
    expect(filled(missed.terminal.screen())).toEqual(filled(seen.terminal.screen()).map(row => row.replace(/ 1s /, ' 2s ')))
  })

  it('restores the terminal once, whatever calls it: close, restore or an exit hook', async () => {
    const calling: Array<[string, (writer: ViewWriter) => Promise<void> | void, string]> = [
      [
        'close',
        writer => writer.close(),
        CURSOR_SHOW,
      ],
      [
        'restore',
        writer => writer.restore(),
        `${CURSOR_SHOW}${SYNC_END}`,
      ],
      [
        'an exit hook',
        (writer) => {
          const hook = writer.restore
          hook()
        },
        `${CURSOR_SHOW}${SYNC_END}`,
      ],
    ]
    for (const [name, call, tail] of calling) {
      const { writer, clock, terminal, writes } = rig()
      writer.sink(started('security'))
      writer.sink(researching())
      writer.sink(sending(1, 1))
      advance(clock, 2 * TICK_MS)
      expect(terminal.cursorVisible(), name).toBe(false)
      expect(terminal.screen().some(row => row.startsWith('calls ')), name).toBe(true)
      const before = writes.length
      await call(writer)
      expect(writes, name).toHaveLength(before + 1)
      expect(writes.at(-1)?.endsWith(tail), name).toBe(true)
      expect(terminal.cursorVisible(), name).toBe(true)
      expect(filled(terminal.screen()), name).toEqual([])
      // Every timer is cancelled, since an aborted review sends no run:end.
      expect(clock.pending(), name).toBe(0)
      // And nothing is written again, whoever calls.
      await writer.close()
      writer.restore()
      writer.restore()
      expect(writes, name).toHaveLength(before + 1)
      writer.sink(answered(1))
      expect(clock.pending(), name).toBe(0)
    }

    // Before the first frame there is nothing to restore but the timer.
    const early = rig()
    early.writer.sink(started('security'))
    expect(early.clock.pending()).toBe(1)
    early.writer.restore()
    expect(early.clock.pending()).toBe(0)
    expect(early.writes).toEqual([])
  })

  it('writes no control sequence but quorum\'s own, whatever the names hold', async () => {
    const bel = String.fromCharCode(0x07)
    const hostile = (name: string): string => `${name}${ESC}[31m${ESC}]0;title${bel}${String.fromCharCode(0x9B)}[2J${String.fromCharCode(0x202E)}end`
    const rename = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value === 'security' || value === 'style' || value === 'api'
          ? hostile(value)
          : value
      }
      if (Array.isArray(value)) return value.map(rename)
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
          rename(key) as string,
          rename(entry),
        ]))
      }
      return value
    }
    const list = twoProfiles().map(({ at, event }) => ({
      at,
      event: rename(event) as QuorumEvent,
    }))
    const { writer, clock, terminal } = rig({ color: true })
    writer.begin(DEFAULT_FACTS)
    play(writer, clock, list, 400_000)
    expect(terminal.screen().join('\n')).toContain('<U+001B>')
    await writer.close()
    // The fake terminal throws on any other sequence or control, and the escapes are counted too.
    const pieces = terminal.written().split(ESC)
    expect(pieces.length).toBeGreaterThan(10)
    for (const piece of pieces.slice(1)) expect(piece.slice(0, 12)).toMatch(OWN_SEQUENCE)
    for (const code of [0x07, 0x9B, 0x202E]) expect(terminal.written()).not.toContain(String.fromCharCode(code))
  })

  it('writes log lines straight on a terminal under 4 rows, and draws no block', async () => {
    const { writer, clock, terminal, writes } = rig({ rows: 3 })
    writer.sink(started('security'))
    writer.sink(researching())
    writer.sink(sending(1, 1))
    advance(clock, FIRST_FRAME_MS)
    for (let part = 1; part <= 5; part++) {
      advance(clock, 200)
      writer.sink(answered(part))
    }
    advance(clock, 300)
    // The first frame is live, and has no room for a block: the lines are written as they are.
    expect(writes).toHaveLength(5)
    expect(terminal.written()).not.toContain(ESC)
    expect(terminal.cursorVisible()).toBe(true)
    const lines = [1, 2, 3, 4, 5].map(part => `${UNICODE_GLYPHS.answered} part ${part} of 44: answered in 1.0s, 1.00k tokens, 1 finding(s) listed`)
    expect(filled([
      ...terminal.history(),
      ...terminal.screen(),
    ])).toEqual(lines)

    // The terminal grows back: the block is drawn whole, below the lines, and no line is lost.
    terminal.resize(80, 12)
    expect(writes).toHaveLength(6)
    const frame = writes[5]
    expect(frame.startsWith(`${SYNC_BEGIN}${CURSOR_HIDE}`)).toBe(true)
    // No block was drawn before, so none is erased, and no move up is written at all.
    expect(terminal.written()).not.toMatch(/\[\d*A/)
    const shown = filled([
      ...terminal.history(),
      ...terminal.screen(),
    ])
    expect(shown.slice(0, 5)).toEqual(lines)
    expect(shown[5]).toMatch(/^─+ \d+s ──$/)
    expect(shown.length).toBeGreaterThanOrEqual(5 + 4)
    expect(shown.some(row => row.startsWith('security  research'))).toBe(true)

    // A line that comes after is written above the block, and the block erased and drawn again.
    advance(clock, FRAME_MS)
    writer.sink(answered(6))
    advance(clock, FRAME_MS)
    expect(filled([
      ...terminal.history(),
      ...terminal.screen(),
    ]).filter(row => row.startsWith(UNICODE_GLYPHS.answered))).toHaveLength(6)
    await writer.close()
    expect(filled([
      ...terminal.history(),
      ...terminal.screen(),
    ])).toHaveLength(6)

    // The same at 3 columns or fewer, where the frame has one empty line.
    const narrow = rig({ columns: 3, glyphs: ASCII_GLYPHS })
    narrow.writer.sink(started('security'))
    advance(narrow.clock, 2 * FIRST_FRAME_MS)
    narrow.writer.sink({
      type: 'run:end',
      kept: 1,
      discarded: 0,
      unreviewed: 0,
      incomplete: 0,
      durationMs: 1,
    })
    expect(narrow.terminal.cursorVisible()).toBe(true)
    expect(narrow.terminal.written()).not.toContain(CURSOR_HIDE)
  })

  it.each<[string, (broken: { write: boolean, size: boolean }, rig: Rig) => void, number]>([
    [
      'drawing a frame',
      (broken, { writer, clock }) => {
        broken.write = true
        writer.line('banner', 'a line still due')
        advance(clock, FRAME_MS)
      },
      1,
    ],
    [
      'a tick',
      (broken, { clock }) => {
        broken.size = true
        advance(clock, TICK_MS)
      },
      0,
    ],
    [
      'folding an event',
      (_broken, { writer }) => {
        writer.line('banner', 'a line still due')
        writer.sink({ type: 'part', profile: 'security', part: null } as unknown as QuorumEvent)
      },
      1,
    ],
  ])('turns the block off and goes on when %s fails, writing the lines straight with the cursor shown', async (_name, fail, due) => {
    const broken = { write: false, size: false }
    const terminal = fakeTerminal({ columns: 80, rows: 24 })
    const clock = fakeClock()
    const { stream } = terminal
    const writer = liveWriter({
      isTTY: true,
      get columns() {
        if (broken.size) throw new Error('no size')
        return stream.columns
      },
      get rows() {
        return stream.rows
      },
      write: (text, done) => {
        if (broken.write && text.includes(SYNC_BEGIN)) throw new Error('no frame')
        return stream.write(text, done)
      },
      on: stream.on,
      off: stream.off,
    }, {
      clock,
      glyphs: UNICODE_GLYPHS,
      color: false,
      view: 'full',
    })
    writer.begin(DEFAULT_FACTS)
    writer.sink(started('security'))
    writer.sink(researching())
    writer.sink(sending(1, 1))
    advance(clock, FIRST_FRAME_MS)
    expect(terminal.cursorVisible()).toBe(false)
    expect(terminal.screen().some(row => row.startsWith('calls '))).toBe(true)

    // The failure ends nothing: the block is erased, a line still due is written once, the cursor shows, no timer is left.
    fail(broken, { writer, clock, terminal, writes: [] })
    broken.write = false
    broken.size = false
    expect(terminal.cursorVisible()).toBe(true)
    expect(clock.pending()).toBe(0)
    expect(terminal.screen().some(row => /^─+ |^calls |^tokens /.test(row))).toBe(false)
    expect(filled(terminal.screen()).filter(row => row === 'a line still due')).toHaveLength(due)

    // The review goes on: its lines, and the CLI's, are written straight, and nothing is drawn or armed again.
    const written = terminal.written().length
    writer.sink(answered(1))
    writer.line('warning', 'a later line')
    advance(clock, 3 * TICK_MS)
    writer.sink(ended)
    const rows = filled(terminal.screen())
    expect(rows.slice(-3)).toEqual([
      `${UNICODE_GLYPHS.answered} part 1 of 44: answered in 1.0s, 1.00k tokens, 1 finding(s) listed`,
      'a later line',
      '0 kept, 0 discarded, 0 unreviewed by panel',
    ])
    expect(terminal.written().slice(written)).not.toContain(ESC)
    expect(clock.pending()).toBe(0)
    expect(terminal.cursorVisible()).toBe(true)
    await writer.close()
    writer.restore()
    expect(terminal.written().slice(written)).not.toContain(ESC)
    expect(terminal.history()).toEqual([])
  })

  it('does not throw when the terminal cannot be written to as the block is turned off, closed or restored', async () => {
    const refusing = (): ViewStream => ({
      isTTY: true,
      columns: 80,
      rows: 24,
      write: () => {
        throw new Error('EPIPE')
      },
    })
    const writer = liveWriter(refusing(), {
      clock: fakeClock(),
      glyphs: UNICODE_GLYPHS,
      color: false,
      view: 'full',
    })
    writer.begin(DEFAULT_FACTS)
    expect(() => {
      writer.sink(started('security'))
      writer.sink(answered(1))
      writer.line('warning', 'a line')
      writer.summary({
        stdout: { format: 'json', terminal: false },
        stderr: { terminal: false },
        outputs: [],
        state: { kind: 'none', kept: 0 },
        result: reportResult({}),
      })
    }).not.toThrow()
    await expect(writer.close()).resolves.toBeUndefined()
    expect(() => writer.restore()).not.toThrow()
  })

  it.each<[number, string[]]>([
    [
      3,
      ['r…'],
    ],
    [
      2,
      ['…'],
    ],
    [1, []],
  ])('draws what the Unicode set leaves of its one line on %s columns, and nothing where the line is cut to nothing', (columns, rows) => {
    const { writer, clock, terminal } = rig({ columns })
    writer.sink(started('security'))
    writer.sink(researching())
    advance(clock, FIRST_FRAME_MS)
    expect(filled(terminal.screen())).toEqual(rows)
    expect(terminal.cursorVisible()).toBe(rows.length === 0)
    // The ASCII set's ellipsis is three columns: it has no room for one at 3 columns or fewer.
    const plain = rig({ columns, glyphs: ASCII_GLYPHS })
    plain.writer.sink(started('security'))
    advance(plain.clock, FIRST_FRAME_MS)
    expect(filled(plain.terminal.screen())).toEqual([])
    expect(plain.terminal.cursorVisible()).toBe(true)
  })

  it('colours nothing when told not to, and keeps the block', () => {
    const play1 = (color: boolean): string => {
      const { writer, clock, terminal } = rig({ color })
      writer.begin(DEFAULT_FACTS)
      play(writer, clock, longReview(), 330_000)
      expect(terminal.screen().some(row => row.startsWith('calls '))).toBe(true)
      expect(terminal.screen().some(row => /^security {2}research █+/.test(row))).toBe(true)
      return terminal.written()
    }
    expect(play1(false)).not.toMatch(/\[\d+m/)
    const coloured = play1(true)
    expect(coloured).toContain(`${CSI}36m█`)
    expect(coloured).toContain(`${CSI}32m${UNICODE_GLYPHS.answered}${CSI}0m`)
    // The ASCII set is as plain: no glyph is anything but its own character.
    const { writer, clock, terminal } = rig({ glyphs: ASCII_GLYPHS })
    writer.begin(DEFAULT_FACTS)
    play(writer, clock, longReview(), 330_000)
    expect(terminal.screen().some(row => /^security {2}research #+-* {2}\d+\/44 parts - \d+ finding\(s\) listed/.test(row))).toBe(true)
    // eslint-disable-next-line no-control-regex
    expect(terminal.written()).toMatch(/^[\n\r\x1B\x20-\x7E]*$/)
  })

  it('recomputes the time left at most every 5 s', () => {
    const { writer, clock, terminal, writes } = rig()
    writer.begin(DEFAULT_FACTS)
    // Five parts have answered at 310 s: from then on there is a range to show.
    play(writer, clock, longReview(), 320_000)
    expect(terminal.screen().some(row => /^time {6}about /.test(row))).toBe(true)
    // With no event, the tick redraws every second, and the time left is read again no more than every ETA_MS.
    const before = { left: calls.timeLeft, writes: writes.length }
    advance(clock, 20 * TICK_MS)
    expect(writes.length - before.writes).toBe(20)
    expect(calls.timeLeft - before.left).toBeGreaterThanOrEqual(3)
    expect(calls.timeLeft - before.left).toBeLessThanOrEqual(Math.ceil(20 * TICK_MS / ETA_MS) + 1)
  })
})
