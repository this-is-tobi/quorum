import { describe, expect, it } from 'vitest'
import { HIDDEN_CLASS } from '../../core/sanitize.ts'
import type { QuorumEvent } from '../../core/types.ts'
import { interrupted, longReview, replay, twoProfiles } from '../../testing/events.ts'
import type { Timed } from '../../testing/events.ts'
import { timeLeft } from './eta.ts'
import { frameLines, tokenWords } from './frame.ts'
import type { FrameOptions } from './frame.ts'
import { ASCII_GLYPHS, UNICODE_GLYPHS } from './glyphs.ts'
import { DEFAULT_FACTS, fold, startState } from './model.ts'
import type { ViewState } from './model.ts'
import { widthOf } from './width.ts'

const ESC = String.fromCharCode(0x1B)
const API = { id: 'api', model: 'model' }

/** The block of `events` as of `at`, in a terminal of the given size unless `overrides` say otherwise. */
function frameOf(events: readonly Timed[], at: number, overrides: Partial<FrameOptions> = {}): string[] {
  const state = replay(events, at)
  return frameLines(state, at, {
    columns: 80,
    rows: 24,
    glyphs: UNICODE_GLYPHS,
    color: false,
    view: 'full',
    timeLeft: timeLeft(state, at),
    ...overrides,
  })
}

/** The state after `events`, each folded at its own time. */
function stateOf(events: ReadonlyArray<readonly [number, QuorumEvent]>): ViewState {
  return events.reduce((state, [at, event]) => fold(state, event, at), startState(DEFAULT_FACTS))
}

/** The events of profiles that start their research together: `parts` parts each. */
function started(profiles: readonly string[], parts: number): Array<[number, QuorumEvent]> {
  return [
    [
      0,
      {
        type: 'run:start',
        profiles: [...profiles],
        providers: Object.fromEntries(profiles.map(id => [
          id,
          {
            research: API,
            lenses: { reachability: API },
          },
        ])),
      },
    ],
    ...profiles.map((profile): [number, QuorumEvent] => [
      0,
      {
        type: 'stage:start',
        profile,
        stage: 'research',
        parts,
      },
    ]),
  ]
}

/** A part of `profile` that ended answered at `at`. */
function answered(profile: string, index: number, count: number, at: number): [number, QuorumEvent] {
  return [
    at,
    {
      type: 'part',
      profile,
      part: { index, count },
      outcome: 'reviewed',
      durationMs: at,
      spent: 1000,
      listed: 1,
    },
  ]
}

/** The colour sequences of the block, taken out. */
const uncoloured = (line: string): string => line.replaceAll(new RegExp(`${ESC}\\[\\d+m`, 'g'), '')

describe('frameLines', () => {
  it('draws the block of a long review at 80 columns: the rule, the profile, the calls, the tokens and the time', () => {
    const events = longReview()
    // 11 parts have ended by then, which the events say on their own, and four calls are in flight
    expect(events.filter(({ at, event }) => at <= 600_000 && event.type === 'part')).toHaveLength(11)
    expect(frameOf(events, 600_000)).toEqual([
      '───────────────────────────────────────────────────────────────────── 10m00s ──',
      'security  research █████░░░░░░░░░░░░░░░  11/44 parts · 2 finding(s) listed',
      'calls     api 4 at once   ↻ p7 http 503, 2s   p12 2m50s   p14 2m05s   p15 40s',
      '          +29 to go',
      'tokens    405k of 2.00M   ▁▁▁▁█▄▁▁▁▃▆▄▄▃▆▁▁▄▁▁  65 tok/s',
      'time      about 15–22m left for research, then up to 150 votes',
      'Ctrl-C stops the review and keeps what it read',
    ])
    // none before run:start, and none after run:end
    expect(frameLines(startState(DEFAULT_FACTS), 0, {
      columns: 80,
      rows: 24,
      glyphs: UNICODE_GLYPHS,
      color: false,
      view: 'full',
      timeLeft: { kind: 'none' },
    })).toEqual([])
    expect(frameOf(events, 2_285_000)).toEqual([])
  })

  it('never draws a line wider than the terminal less one column, from 20 to 200 columns and 3 to 50 rows', () => {
    const states: Array<readonly [ViewState, number]> = []
    for (const events of [
      longReview(),
      twoProfiles(),
    ]) {
      const end = events.at(-1)!.at
      for (const share of [0, 0.15, 0.4, 0.7, 0.9]) {
        const at = Math.floor(end * share)
        states.push([
          replay(events, at),
          at,
        ])
      }
    }
    // three profiles, one of them named in a wide script, with a call in a wait and a vote in flight
    const wide = String.fromCharCode(0x4E2D, 0x6587, 0x540D, 0x524D, 0x7F6E)
    states.push([
      stateOf([
        ...started([
          wide,
          'style',
          'x'.repeat(40),
        ], 12),
        answered(wide, 1, 12, 20_000),
        [
          21_000,
          {
            type: 'call:start',
            call: 1,
            profile: 'style',
            role: 'research',
            provider: API,
            part: {
              index: 1,
              count: 12,
              piece: { index: 2, count: 3 },
            },
            reserved: 5000,
            timeoutMs: 600_000,
          },
        ],
        [
          22_000,
          {
            type: 'call:retry',
            call: 1,
            attempt: 1,
            retries: 2,
            failure: { kind: 'timeout' },
            attemptMs: 600_000,
            waitMs: 90_000,
          },
        ],
      ]),
      30_000,
    ])
    const sizes: Array<readonly [number, number]> = []
    for (let columns = 20; columns <= 200; columns++) {
      for (const rows of [3, 4, 5, 6, 8, 24, 50]) sizes.push([columns, rows])
    }
    for (let rows = 3; rows <= 50; rows++) {
      for (const columns of [20, 39, 40, 79, 80, 200]) sizes.push([columns, rows])
    }
    const broken: string[] = []
    for (const [state, at] of states) {
      for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
        for (const [columns, rows] of sizes) {
          const lines = frameLines(state, at, {
            columns,
            rows,
            glyphs,
            color: false,
            view: 'full',
            timeLeft: timeLeft(state, at),
          })
          const most = rows < 4
            ? 0
            : columns < 40
              ? 1
              : Math.min(8, rows - 2)
          const fewest = rows < 4
            ? 0
            : columns < 40
              ? 1
              : 2
          const first = lines.find(line => widthOf(line) >= columns)
          if (lines.length > most || lines.length < fewest || first !== undefined) broken.push(`${columns}x${rows} at ${at}: ${lines.length} lines, ${first ?? ''}`)
        }
      }
    }
    expect(broken.slice(0, 5)).toEqual([])
  })

  it('drops the sparkline below 80 columns, narrows the bars to 10 cells, and draws one line below 40', () => {
    const events = longReview()
    const cells = (line: string): number => [...line].filter(char => char === UNICODE_GLYPHS.done || char === UNICODE_GLYPHS.todo).length
    const spark = new RegExp(`[${UNICODE_GLYPHS.spark.join('')}]`)
    const wide = frameOf(events, 600_000, { columns: 80 })
    const narrow = frameOf(events, 600_000, { columns: 79 })
    expect(cells(wide[1])).toBe(20)
    expect(wide.find(line => line.startsWith('tokens'))).toMatch(spark)
    expect(cells(narrow[1])).toBe(10)
    expect(narrow.find(line => line.startsWith('tokens'))).not.toMatch(spark)
    expect(narrow.find(line => line.startsWith('tokens'))).toBe('tokens    405k of 2.00M   65 tok/s')
    expect(frameOf(events, 600_000, { columns: 40 })).toHaveLength(7)
    expect(frameOf(events, 600_000, { columns: 39 })).toEqual(['research 11/44 · 4 calls · 10m00s'])
    expect(frameOf(events, 1_900_000, { columns: 39 })).toEqual(['panel 1/18 · 4 calls · 31m40s'])
    // a line that does not fit is cut with the ellipsis, one column short of the terminal's
    expect(frameOf(events, 600_000, { columns: 20 })).toEqual([`research 11/44 · 4${UNICODE_GLYPHS.ellipsis}`])
  })

  it('keeps to the rows less two, dropping the second calls line and the profile lines past the first, and draws nothing under 4 rows', () => {
    const one = longReview()
    const heads = (lines: string[]): string[] => lines.map(line => line.split(' ')[0])
    expect(heads(frameOf(one, 600_000, { rows: 50 }))).toHaveLength(7)
    expect(heads(frameOf(one, 600_000, { rows: 9 }))).toHaveLength(7)
    expect(heads(frameOf(one, 600_000, { rows: 8 }))).toHaveLength(6)
    // the second calls line goes first: its items are held by `+n more`
    const short = frameOf(one, 600_000, { rows: 7 })
    expect(heads(short)).toEqual([
      expect.stringContaining('─'),
      'security',
      'calls',
      'tokens',
      'time',
    ])
    expect(short[2]).toMatch(/^calls {5}api 4 at once {3}.* \+\d+ more {3}\+29 to go$/)
    expect(heads(frameOf(one, 600_000, { rows: 6 }))).toEqual([
      expect.stringContaining('─'),
      'security',
      'calls',
      'time',
    ])
    expect(heads(frameOf(one, 600_000, { rows: 5 }))).toEqual([
      expect.stringContaining('─'),
      'security',
      'calls',
    ])
    expect(heads(frameOf(one, 600_000, { rows: 4 }))).toEqual([
      expect.stringContaining('─'),
      'security',
    ])
    expect(frameOf(one, 600_000, { rows: 3 })).toEqual([])
    expect(frameOf(one, 600_000, { rows: 0 })).toEqual([])
    // the profile lines past the first go after the second calls line and before the tokens line
    const two = twoProfiles()
    expect(heads(frameOf(two, 300_000, { rows: 8 }))).toEqual([
      expect.stringContaining('─'),
      'security',
      'style',
      'calls',
      'tokens',
      'time',
    ])
    expect(heads(frameOf(two, 300_000, { rows: 7 }))).toEqual([
      expect.stringContaining('─'),
      'security',
      'calls',
      'tokens',
      'time',
    ])
    expect(heads(frameOf(two, 300_000, { rows: 6 }))).toEqual([
      expect.stringContaining('─'),
      'security',
      'calls',
      'time',
    ])
  })

  it('draws two profiles, and three or more as the first and one line for the rest', () => {
    const lines = frameOf(twoProfiles(), 300_000)
    expect(lines.slice(1, 3)).toEqual([
      'security  research ████████░░░░░░░░░░░░  4/10 parts · 1 finding(s) listed',
      'style     research ████████░░░░░░░░░░░░  4/10 parts · 1 finding(s) listed',
    ])
    const three = frameLines(stateOf([
      ...started(['security', 'style', 'docs'], 10),
      answered('security', 1, 10, 1000),
      answered('style', 1, 10, 1000),
      answered('style', 2, 10, 2000),
      answered('docs', 1, 10, 3000),
      [
        4000,
        {
          type: 'stage:start',
          profile: 'docs',
          stage: 'panel',
          votes: 6,
        },
      ],
      [
        5000,
        {
          type: 'vote',
          profile: 'docs',
          findingId: 'f',
          lens: 'reachability',
          keep: true,
        },
      ],
    ]), 6000, {
      columns: 80,
      rows: 24,
      glyphs: UNICODE_GLYPHS,
      color: false,
      view: 'full',
      timeLeft: { kind: 'none' },
    })
    expect(three.slice(1, 3)).toEqual([
      'security  research ██░░░░░░░░░░░░░░░░░░  1/10 parts · 1 finding(s) listed',
      'and 2 more profile(s): 3/20 parts, 1/6 votes',
    ])
  })

  it('shows a call waiting to retry counting down, and the parts still to go', () => {
    const events = longReview()
    const retry = events.find(({ event }) => event.type === 'call:retry' && event.failure.status === 503)!
    expect(retry.event).toMatchObject({ waitMs: 3600 })
    const calls = (at: number): string[] => frameOf(events, at).filter(line => line.startsWith('calls') || line.startsWith('          '))
    const sentBy = (at: number): number => new Set(events
      .filter(({ at: when, event }) => when <= at && event.type === 'call:start' && event.role === 'research')
      .map(({ event }) => event.type === 'call:start' && event.part!.index)).size
    const at = retry.at + 1000
    const waiting = calls(at)
    expect(waiting[0]).toContain(`${UNICODE_GLYPHS.retry} p7 http 503, 3s`)
    expect(waiting.join(' ')).toContain(`+${44 - sentBy(at)} to go`)
    // the seconds left count down, and the item is a running call again once its wait is over
    expect(calls(retry.at + 2600)[0]).toContain('p7 http 503, 1s')
    const over = calls(retry.at + 3700)
    expect(over[0]).not.toContain(UNICODE_GLYPHS.retry)
    expect(over[0]).toMatch(/p7 \d+m\d{2}s/)
    expect(over.join(' ')).toContain(`+${44 - sentBy(retry.at + 3700)} to go`)
  })

  it('shows no tok/s while the last minute holds no tokens, and keeps the sparkline', () => {
    const events = longReview()
    const tokens = (at: number): string => frameOf(events, at).find(line => line.startsWith('tokens'))!
    // No call ended in the minute before 9m10s, so the rate would be 0 and is left out; one ended at 9m20s, and the rate is told.
    expect(tokens(550_000)).toBe('tokens    373k of 2.00M   ▁▁▁▁▁▁█▄▁▁▁▃▆▄▄▃▆▁▁▁')
    expect(tokens(560_000)).toBe('tokens    405k of 2.00M   ▁▁▁▁▁▁█▄▁▁▁▃▆▄▄▃▆▁▁▄  65 tok/s')
    expect(tokens(650_000)).toBe('tokens    435k of 2.00M   ▁▁▁█▄▁▁▁▃▆▄▄▃▆▁▁▄▁▄▁  70 tok/s')
    // Before the first call ended there is no rate either, and below 80 columns the line is the tokens and the rate, with no sparkline.
    expect(tokens(100_000)).toBe('tokens    0 of 2.00M   ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁')
    expect(frameOf(events, 600_000, { columns: 79 }).find(line => line.startsWith('tokens'))).toBe('tokens    405k of 2.00M   65 tok/s')
  })

  it('leaves out the tokens line and every token count under the public view', () => {
    const events = longReview()
    const full = frameOf(events, 650_000).join('\n')
    expect(full).toContain('tokens')
    expect(full).toContain('tok/s')
    expect(full).toContain('finding(s) listed')
    for (const at of [600_000, 1_900_000]) {
      const lines = frameOf(events, at, { view: 'public' })
      const text = lines.join('\n')
      expect(lines.length).toBeGreaterThanOrEqual(4)
      expect(text).not.toContain('tokens')
      expect(text).not.toContain('tok/s')
      expect(text).not.toContain('finding(s) listed')
      expect(text).not.toMatch(/\d[kMB]\b/)
      expect(text).not.toContain('405')
    }
  })

  it('colours only quorum\'s glyphs and the bars\' done cells, and nothing without colour', () => {
    const events = longReview()
    const plain = frameOf(events, 600_000)
    const coloured = frameOf(events, 600_000, { color: true })
    expect(plain.join('')).not.toContain(ESC)
    expect(coloured[1]).toContain(`${ESC}[36m${UNICODE_GLYPHS.done.repeat(5)}${ESC}[0m${UNICODE_GLYPHS.todo.repeat(15)}`)
    expect(coloured[2]).toContain(`${ESC}[33m${UNICODE_GLYPHS.retry}${ESC}[0m p7 http 503`)
    expect(coloured.map(uncoloured)).toEqual(plain)
    // the rule, the labels and the words carry no colour of their own
    expect(coloured[0]).toBe(plain[0])
    expect(coloured[5]).toBe(plain[5])
    // a cut line keeps its colour whole around what is left
    const cutLines = frameOf(events, 600_000, { color: true, columns: 50 })
    expect(cutLines[1]).toBe(`security  research ${ESC}[36m${UNICODE_GLYPHS.done.repeat(2)}${ESC}[0m${UNICODE_GLYPHS.todo.repeat(8)}  11/44 parts · 2 f${UNICODE_GLYPHS.ellipsis}`)
  })

  it('draws hostile names inert, with no control and no escape but quorum\'s colour', () => {
    const hostile = [
      `evil${ESC}[31mred${ESC}[0m`,
      `osc${ESC}]0;title${String.fromCharCode(7)}`,
      `c1${String.fromCharCode(0x9B)}31m`,
      `bidi${String.fromCharCode(0x202E)}txt`,
      '::notice::x',
      `##${String.fromCharCode(0x5B)}error]`,
    ]
    const provider = { id: `api${ESC}[2J`, model: 'model' }
    const hidden = new RegExp(`[${HIDDEN_CLASS}]`, 'u')
    for (const profiles of [
      hostile.slice(0, 2),
      hostile,
    ]) {
      const state = stateOf([
        ...started(profiles, 4),
        answered(profiles[0], 1, 4, 1000),
        [
          2000,
          {
            type: 'call:start',
            call: 1,
            profile: profiles[0],
            role: 'research',
            provider,
            part: { index: 2, count: 4 },
            reserved: 1000,
            timeoutMs: 1000,
          },
        ],
        [
          3000,
          {
            type: 'call:retry',
            call: 1,
            attempt: 1,
            retries: 2,
            failure: { kind: 'network' },
            attemptMs: 1000,
            waitMs: 5000,
          },
        ],
      ])
      for (const columns of [20, 40, 80]) {
        for (const color of [false, true]) {
          const lines = frameLines(state, 4000, {
            columns,
            rows: 24,
            glyphs: UNICODE_GLYPHS,
            color,
            view: 'full',
            timeLeft: { kind: 'estimating' },
          })
          expect(lines.length).toBeGreaterThan(0)
          for (const line of lines) {
            expect(widthOf(uncoloured(line))).toBeLessThan(columns)
            if (!color) expect(line).not.toMatch(hidden)
            for (const piece of line.split(ESC).slice(1)) expect(piece).toMatch(/^\[(?:3\dm|0m)/)
            expect(line.startsWith('::')).toBe(false)
            expect(line).not.toContain('##[')
          }
        }
      }
    }
    // shown as the code point, and cut after it is shown, so no label is cut into a half escape
    const shown = frameLines(stateOf(started([`a${ESC}`, `a${ESC}b`], 4)), 1000, {
      columns: 80,
      rows: 24,
      glyphs: UNICODE_GLYPHS,
      color: false,
      view: 'full',
      timeLeft: { kind: 'none' },
    })
    expect(shown[1]).toMatch(/^a<U\+001B> research /)
    expect(shown[2]).toMatch(new RegExp(`^a<U\\+001B${UNICODE_GLYPHS.ellipsis} research `))
  })

  it('draws a profile\'s panel bar and its votes in the calls once its panel starts', () => {
    const events = longReview()
    // the panel starts as research ends: the bar is the research's until then, and the panel's after
    const end = events.find(({ event }) => event.type === 'stage:end' && event.stage === 'research')!.at
    expect(frameOf(events, end - 1)[1]).toMatch(/^security {2}research .* 43\/44 parts/)
    expect(frameOf(events, end)[1]).toBe('security  panel    ░░░░░░░░░░░░░░░░░░░░  0/18 votes · 0 kept')
    const lines = frameOf(events, 1_900_000)
    expect(lines[1]).toBe('security  panel    █░░░░░░░░░░░░░░░░░░░  1/18 votes · 0 kept')
    expect(lines[2]).toMatch(/^calls {5}api 4 at once {3}f1 1m28s {3}f1 1m28s {3}f2 1m28s {3}f2 3s {3}\+13 to go$/)
    expect(lines.at(-2)).toBe('time      about 7m left for votes')
  })

  it('draws ASCII glyphs from the ASCII set, each one column', () => {
    const lines = frameOf(longReview(), 600_000, { glyphs: ASCII_GLYPHS })
    expect(lines).toEqual([
      '--------------------------------------------------------------------- 10m00s --',
      'security  research #####---------------  11/44 parts - 2 finding(s) listed',
      'calls     api 4 at once   ~ p7 http 503, 2s   p12 2m50s   p14 2m05s   p15 40s',
      '          +29 to go',
      'tokens    405k of 2.00M   ____#=___-+==-*__=__  65 tok/s',
      'time      about 15-22m left for research, then up to 150 votes',
      'Ctrl-C stops the review and keeps what it read',
    ])
    for (const line of lines) {
      expect(line).toMatch(/^[\x20-\x7E]+$/)
      expect(widthOf(line)).toBeLessThan(80)
    }
    // the ellipsis is the three columns it is
    expect(frameOf(longReview(), 600_000, { glyphs: ASCII_GLYPHS, columns: 50 })[1]).toBe('security  research ##--------  11/44 parts - 2...')
  })

  it('ends the block with the hint, then with the stopping hint counting the grace down, the first line to go when rows are short', () => {
    const hint = 'Ctrl-C stops the review and keeps what it read'
    const events = interrupted()
    const stopping = events.find(({ event }) => event.type === 'run:stopping')!
    expect(stopping.event).toMatchObject({ cause: 'interrupt', graceMs: 5000 })
    const flying = replay(events, stopping.at).calls.size
    expect(flying).toBeGreaterThan(0)
    // before the interrupt the block ends with the hint, under the full and the public view
    expect(frameOf(events, stopping.at - 1).at(-1)).toBe(hint)
    expect(frameOf(events, stopping.at - 1, { view: 'public' }).at(-1)).toBe(hint)
    // after it the hint is the stopping hint, with the calls in flight and the seconds of the grace left, rounded up
    expect(frameOf(events, stopping.at).at(-1)).toBe(`stopping: ${flying} call(s) end within 5 s; Ctrl-C again quits without the result`)
    expect(frameOf(events, stopping.at + 1000)).toHaveLength(frameOf(events, stopping.at).length)
    expect(frameOf(events, stopping.at + 1000).at(-1)).toBe(`stopping: ${flying} call(s) end within 4 s; Ctrl-C again quits without the result`)
    expect(frameOf(events, stopping.at + 4500).at(-1)).toBe(`stopping: ${flying} call(s) end within 1 s; Ctrl-C again quits without the result`)
    // the deadline's stopping keeps the plain hint, and a line cut to the terminal ends in the ellipsis
    const deadline = [
      ...events.slice(0, events.indexOf(stopping)),
      {
        at: stopping.at,
        event: { type: 'run:stopping', cause: 'review-deadline', inFlight: flying } as QuorumEvent,
      },
    ]
    expect(frameOf(deadline, stopping.at).at(-1)).toBe(hint)
    expect(frameOf(events, stopping.at, { columns: 60 }).at(-1)).toBe(`stopping: ${flying} call(s) end within 5 s; Ctrl-C again quits wit${UNICODE_GLYPHS.ellipsis}`)
    // the hint is the first line to go: the rows less two hold the lines of this block, and one row fewer holds all but the hint; the
    // calls line's second row is the 7th line of the block before the interrupt, when a fourth call in flight has no room on the first
    for (const at of [stopping.at - 1, stopping.at]) {
      const full = frameOf(events, at, { rows: 50 })
      expect(full).toHaveLength(at === stopping.at
        ? 6
        : 7)
      expect(frameOf(events, at, { rows: full.length + 2 })).toEqual(full)
      expect(frameOf(events, at, { rows: full.length + 1 })).toEqual(full.slice(0, -1))
      // one row of calls holds what it can and counts the rest, where two held them all
      const five = frameOf(events, at, { rows: 5 })
      expect(five).toHaveLength(3)
      expect(five.slice(0, 2)).toEqual(full.slice(0, 2))
      expect(five[2]).toMatch(/^calls {5}api 4 at once {3}/)
      expect(frameOf(events, at, { rows: 4 })).toEqual(full.slice(0, 2))
    }
    // below 40 columns the block is one line, which holds no hint
    expect(frameOf(events, stopping.at, { columns: 39 })).toHaveLength(1)
  })

  /** A started review of one profile with call 1 streaming from 0, which folded `events` after. */
  const streaming = (...events: Array<[number, QuorumEvent]>): ViewState => stateOf([
    ...started(['security'], 4),
    [
      0,
      {
        type: 'call:start',
        call: 1,
        profile: 'security',
        role: 'research',
        provider: API,
        part: { index: 1, count: 4 },
        reserved: 6000,
        timeoutMs: 600_000,
        stream: true,
      },
    ],
    ...events,
  ])
  const progress = (at: number, outputTokens: number, signal: 'tokens' | 'keep-alive' = 'tokens'): [number, QuorumEvent] => [
    at,
    {
      type: 'call:progress',
      call: 1,
      outputTokens,
      signal,
    },
  ]
  const frameFor = (state: ViewState, at: number, overrides: Partial<FrameOptions> = {}): string[] => frameLines(state, at, {
    columns: 80,
    rows: 24,
    glyphs: UNICODE_GLYPHS,
    color: false,
    view: 'full',
    timeLeft: { kind: 'none' },
    ...overrides,
  })

  it.each<[string, { stream?: boolean, tokens?: number, keepAlive?: boolean, turns?: number, now: number }, Partial<FrameOptions>, string]>([
    [
      'streamed with tokens',
      { tokens: 6100, turns: 12, now: 41_000 },
      {},
      '⠹ p20 41s ~6.10k',
    ],
    [
      'with keep-alives only',
      { keepAlive: true, now: 130_000 },
      {},
      '⠋ p20 2m10s keep-alives only',
    ],
    [
      'streamed before any progress',
      { now: 3000 },
      {},
      '⠋ p20 3s',
    ],
    [
      'not streamed',
      { stream: false, now: 4000 },
      {},
      'p20 4s',
    ],
    [
      'in ASCII',
      { tokens: 6100, turns: 12, now: 41_000 },
      { glyphs: ASCII_GLYPHS },
      '| p20 41s ~6.10k',
    ],
    [
      'under the public view',
      { tokens: 6100, turns: 12, now: 41_000 },
      { view: 'public' },
      '⠹ p20 41s',
    ],
  ])('draws a call in flight %s', (_name, { stream = true, tokens, keepAlive, turns = 0, now }, overrides, item) => {
    const events: Array<[number, QuorumEvent]> = [
      ...started(['security'], 30),
      [
        0,
        {
          type: 'call:start',
          call: 1,
          profile: 'security',
          role: 'research',
          provider: API,
          part: { index: 20, count: 30 },
          reserved: 6000,
          timeoutMs: 600_000,
          ...stream
            ? { stream: true as const }
            : {},
        },
      ],
    ]
    for (let turn = 1; turn <= turns; turn++) {
      events.push([
        turn * 1000,
        {
          type: 'call:progress',
          call: 1,
          outputTokens: Math.round((tokens ?? 0) * turn / turns),
          signal: 'tokens',
        },
      ])
    }
    if (keepAlive === true) {
      events.push([
        1000,
        {
          type: 'call:progress',
          call: 1,
          outputTokens: 0,
          signal: 'keep-alive',
        },
      ])
    }
    const calls = frameFor(stateOf(events), now, overrides).find(line => line.startsWith('calls'))!
    expect(calls).toBe(`calls     api 4 at once   ${item}   +29 to go`)
  })

  it('turns a call\'s spinner only when its output grows', () => {
    const spinner = (state: ViewState): string => frameFor(state, 20_000).find(line => line.startsWith('calls'))!.match(/at once {3}(\S) p1 /)![1]
    const first = streaming()
    const grown = fold(first, progress(1000, 100)[1], 1000)
    const quiet = fold(grown, progress(2000, 100, 'keep-alive')[1], 2000)
    const again = fold(quiet, progress(3000, 200)[1], 3000)
    expect([first, grown, quiet, again].map(spinner)).toEqual(UNICODE_GLYPHS.spinner.slice(0, 2).concat(UNICODE_GLYPHS.spinner[1], UNICODE_GLYPHS.spinner[2]))
    // the time that passes turns nothing
    expect(frameFor(again, 21_000)[2]).toContain(`${UNICODE_GLYPHS.spinner[2]} p1 21s`)
    // the spinner has one turn for each of its glyphs
    const full = Array.from({ length: UNICODE_GLYPHS.spinner.length }, (_, turn) => progress(1000 * (turn + 1), 100 * (turn + 1)))
    expect(spinner(streaming(...full))).toBe(UNICODE_GLYPHS.spinner[0])
  })

  it('reads the rate over a sliding minute, with no step at a bucket\'s rollover and no high reading in the first seconds', () => {
    // 6000 tokens at 40 s, in the cell of 30 to 60 s
    const burst = streaming(progress(40_000, 6000))
    const rate = (state: ViewState, at: number, columns = 80): string | undefined => frameFor(state, at, { columns }).find(line => line.startsWith('tokens'))?.match(/(\d+) tok\/s$/)?.[1]
    // before the review is a minute old the window covers the time since it began: 6000 over 45 s is 133
    expect(rate(burst, 45_000)).toBe('133')
    // across the rollover at 60 s there is no step: the window holds the burst whole, over the minute it covers
    expect(rate(burst, 59_999)).toBe('100')
    expect(rate(burst, 60_000)).toBe('100')
    expect(rate(burst, 60_001)).toBe('100')
    // the oldest cell counts for the share of it still inside the window, and goes as the window passes it
    expect(rate(burst, 90_000)).toBe('100')
    expect(rate(burst, 100_000)).toBe('67')
    expect(rate(burst, 119_000)).toBe('3')
    expect(rate(burst, 120_000)).toBeUndefined()
    // the first seconds are read over at least 10 s: 500 tokens at 2 s is 50, not 250
    const early = streaming(progress(2000, 500))
    expect(rate(early, 2000)).toBe('50')
    expect(rate(early, 10_000)).toBe('50')
    expect(rate(early, 20_000)).toBe('25')
    // nothing is covered at the start, and no rate is told
    expect(frameFor(stateOf(started(['security'], 4)), 0).find(line => line.startsWith('tokens'))).toBe(`tokens    0 of 2.00M   ${UNICODE_GLYPHS.spark[0].repeat(20)}`)
  })

  describe('the calls line\'s head', () => {
    const OTHER = { id: 'other', model: 'model' }
    const callStart = (call: number, provider = API): [number, QuorumEvent] => [
      1000,
      {
        type: 'call:start',
        call,
        profile: 'security',
        role: 'research',
        provider,
        part: { index: call, count: 4 },
        reserved: 6000,
        timeoutMs: 600_000,
      },
    ]
    const lane = (at: number, cause: Extract<QuorumEvent, { type: 'concurrency' }>['cause'], limit: number, more: Partial<Extract<QuorumEvent, { type: 'concurrency' }>> = {}, provider = API): [number, QuorumEvent] => [
      at,
      {
        type: 'concurrency',
        provider,
        limit,
        cause,
        ...more,
      },
    ]
    const throttle = { kind: 'http', status: 429 } as const
    const stateWith = (...events: Array<[number, QuorumEvent]>): ViewState => events.reduce((state, [at, event]) => fold(state, event, at), startState(DEFAULT_FACTS))
    const callsOf = (state: ViewState, now: number, overrides: Partial<FrameOptions> = {}): string => frameLines(state, now, {
      columns: 80,
      rows: 24,
      glyphs: UNICODE_GLYPHS,
      color: false,
      view: 'full',
      timeLeft: { kind: 'none' },
      ...overrides,
    }).find(line => line.startsWith('calls'))!
    /** What the calls line says before its first item. */
    const headOf = (state: ViewState, now: number, overrides: Partial<FrameOptions> = {}): string => callsOf(state, now, overrides).slice(10).split('   ')[0]
    const begun = [
      ...started(['security'], 4),
      callStart(1),
    ]

    it.each<[string, Array<[number, QuorumEvent]>, number, string]>([
      [
        'one lane at its start',
        [],
        20_000,
        'api 4 at once',
      ],
      [
        'one lane growing',
        [
          lane(10_000, 'grown', 5),
        ],
        20_000,
        'api 5 at once, growing',
      ],
      [
        'one lane growing back after a cut',
        [
          lane(5000, 'cut', 2, { from: 4, failure: throttle }),
          lane(10_000, 'regrown', 3),
        ],
        20_000,
        'api 3 at once, growing',
      ],
      [
        'one cut after http 429',
        [
          lane(10_000, 'cut', 2, { from: 4, failure: throttle }),
        ],
        20_000,
        'api 2 at once after http 429',
      ],
      [
        'one cut after a stall',
        [
          lane(10_000, 'cut', 2, {
            from: 4,
            failure: { kind: 'timeout', stalledMs: 300_000 },
          }),
        ],
        20_000,
        'api 2 at once after timeout',
      ],
      [
        'paused 14s',
        [
          lane(10_000, 'cut', 2, { from: 4, failure: throttle }),
          lane(20_000, 'paused', 2, { waitMs: 14_000, failure: throttle }),
        ],
        20_000,
        'api paused 14s (http 429)',
      ],
      [
        'paced 9s',
        [
          lane(20_000, 'paced', 4, { waitMs: 9000 }),
        ],
        20_000,
        'api paced 9s',
      ],
      [
        'holding the slots its server states',
        [
          lane(0, 'slots', 3),
        ],
        20_000,
        'api 3 at once (slots)',
      ],
      [
        'two lanes',
        [
          lane(10_000, 'grown', 6),
          lane(11_000, 'cut', 2, { from: 4, failure: throttle }, OTHER),
        ],
        20_000,
        'api 6 at once, growing; other 2 at once after http 429',
      ],
      [
        'a pause that has ended, back to what the lane did last',
        [
          lane(10_000, 'cut', 2, { from: 4, failure: throttle }),
          lane(10_000, 'paused', 2, { waitMs: 14_000, failure: throttle }),
        ],
        24_001,
        'api 2 at once after http 429',
      ],
      [
        'a pacing wait that has ended',
        [
          lane(10_000, 'paced', 4, { waitMs: 9000 }),
        ],
        19_001,
        'api 4 at once',
      ],
      [
        'a pause shown over a pacing wait',
        [
          lane(20_000, 'paced', 4, { waitMs: 9000 }),
          lane(20_000, 'paused', 4, { waitMs: 2500, failure: throttle }),
        ],
        20_000,
        'api paused 3s (http 429)',
      ],
    ])('heads the calls line %s', (_name, events, now, head) => {
      expect(headOf(stateWith(...begun, ...events), now)).toBe(head)
      // the public view has the same head: it holds ids, numbers and code words
      expect(headOf(stateWith(...begun, ...events), now, { view: 'public' })).toBe(head)
    })

    it('heads the calls line with the setting\'s calls at once, whatever the providers, when concurrency is set', () => {
      const set = [
        ...begun,
        lane(10_000, 'grown', 5),
      ].reduce((state, [at, event]) => fold(state, event, at), startState({ ...DEFAULT_FACTS, concurrency: 8 }))
      expect(headOf(set, 20_000)).toBe('8 at once (concurrency)')
    })

    it('names no lane before a call has started, and keeps the items in their column', () => {
      const first = callsOf(stateWith(...started(['security'], 4)), 1000)
      expect(first).toBe('calls     +4 to go')
      const [, , calls] = frameLines(stateWith(...begun), 2000, {
        columns: 80,
        rows: 24,
        glyphs: UNICODE_GLYPHS,
        color: false,
        view: 'full',
        timeLeft: { kind: 'none' },
      })
      expect(calls).toBe('calls     api 4 at once   p1 1s   +3 to go')
    })

    it('wraps the items under the head of two lanes, and cuts the head in a narrow terminal', () => {
      const state = stateWith(...begun, callStart(2, OTHER), lane(10_000, 'grown', 6), lane(11_000, 'cut', 2, { from: 4, failure: throttle }, OTHER))
      const wide = frameLines(state, 20_000, {
        columns: 80,
        rows: 24,
        glyphs: UNICODE_GLYPHS,
        color: false,
        view: 'full',
        timeLeft: { kind: 'none' },
      })
      expect(wide.slice(2, 4)).toEqual([
        'calls     api 6 at once, growing; other 2 at once after http 429   p1 19s',
        '          p2 19s   +2 to go',
      ])
      for (const columns of [40, 50, 60, 80]) {
        for (const line of frameLines(state, 20_000, {
          columns,
          rows: 24,
          glyphs: UNICODE_GLYPHS,
          color: false,
          view: 'full',
          timeLeft: { kind: 'none' },
        })) {
          expect(widthOf(line)).toBeLessThanOrEqual(columns - 1)
        }
      }
      const narrow = frameLines(state, 20_000, {
        columns: 40,
        rows: 24,
        glyphs: UNICODE_GLYPHS,
        color: false,
        view: 'full',
        timeLeft: { kind: 'none' },
      })
      expect(narrow.find(line => line.startsWith('calls'))).toBe(`calls     api 6 at once, growing; othe${UNICODE_GLYPHS.ellipsis}`)
      // under 40 columns the block is its one line, which names no lane
      expect(frameLines(state, 20_000, {
        columns: 39,
        rows: 24,
        glyphs: UNICODE_GLYPHS,
        color: false,
        view: 'full',
        timeLeft: { kind: 'none' },
      })).toEqual(['research 0/4 · 2 calls · 20s'])
    })

    it('makes a provider\'s id inert in the head', () => {
      const hostile = { id: `a${ESC}b`, model: 'model' }
      const state = stateWith(...started(['security'], 4), callStart(1, hostile), lane(10_000, 'grown', 5, {}, hostile))
      expect(headOf(state, 20_000)).toBe('a<U+001B>b 5 at once, growing')
      expect(callsOf(state, 20_000)).not.toContain(ESC)
    })
  })

  it.each<[number, string]>([
    [999, '999'],
    [1234, '1.23k'],
    [12_345, '12.3k'],
    [812_000, '812k'],
    [9_864_619, '9.86M'],
  ])('writes %s tokens as %s', (tokens, words) => {
    expect(tokenWords(tokens)).toBe(words)
  })
})
