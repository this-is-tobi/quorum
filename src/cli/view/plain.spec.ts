import { describe, expect, it } from 'vitest'
import type { Clock } from '../../core/clock.ts'
import type { QuorumEvent } from '../../core/types.ts'
import { fakeClock } from '../../testing/clock.ts'
import { longReview, replay, slowResearch } from '../../testing/events.ts'
import { contextDocument, reportResult } from '../../testing/report.ts'
import { DEFAULT_FACTS } from './model.ts'
import { HEARTBEAT_MS, plainWriter } from './plain.ts'
import type { LineLevel } from './writer.ts'

const ESC = String.fromCharCode(0x1B)

function started(profiles: string[]): QuorumEvent {
  return {
    type: 'run:start',
    profiles,
    providers: Object.fromEntries(profiles.map(id => [
      id,
      {
        research: { id: 'default', model: 'm' },
        lenses: {},
      },
    ])),
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

describe('plainWriter', () => {
  const dedup: QuorumEvent = {
    type: 'stage:end',
    profile: 'team',
    stage: 'dedup',
    durationMs: 1,
    count: 2,
  }

  it('writes the lines of a review, learning from run:start whether to prefix', () => {
    const lines: string[] = []
    const sink = plainWriter({
      write: line => lines.push(line),
    }).sink
    sink(started(['security', 'team']))
    sink(dedup)
    sink({
      type: 'vote',
      profile: 'team',
      findingId: 'f',
      lens: 'impact',
      keep: null,
      error: 'endpoint down',
    })
    expect(lines).toEqual(['[team] 2 candidate(s) after dedup'])

    const single: string[] = []
    const alone = plainWriter({
      write: line => single.push(line),
    }).sink
    alone(started(['team']))
    alone(dedup)
    expect(single).toEqual(['2 candidate(s) after dedup'])

    const detail = 'DETAIL-CANARY'
    const hidden: string[] = []
    const sealed = plainWriter({
      write: line => hidden.push(line),
      view: 'public',
    }).sink
    sealed(started(['security']))
    sealed({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'binary', detail },
    })
    expect(hidden).toEqual(['incomplete: binary'])
  })

  it('writes a heartbeat after 60 s with no other line while the review runs, and none at 59 s', () => {
    const clock = fakeClock()
    const lines: string[] = []
    const view = plainWriter({
      write: line => lines.push(line),
      clock,
      heartbeat: true,
    })
    expect(clock.pending()).toBe(0)
    view.sink(started(['security']))
    view.sink({
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 44,
    })
    // The review's first quiet minute is armed at 60 s, and nothing has been written before it fires.
    expect(clock.armed).toEqual([HEARTBEAT_MS])
    expect(clock.pending()).toBe(1)
    expect(lines).toEqual([])

    // A line of the CLI's restarts the minute: still one timer, which fires 60 s after the line.
    view.line('notice', 'a line')
    expect(clock.armed).toEqual([60_000, 60_000])
    expect(clock.pending()).toBe(1)
    expect(lines).toEqual(['a line'])

    expect(clock.fireNext()).toBe(true)
    expect(lines).toEqual(['a line', '[1m00s] research 0 of 44 part(s), 0 call(s) in flight, 0 retried; 0 of 2.00M tokens; estimating the time left'])
    // The heartbeat arms the next one, 60 s later again.
    expect(clock.pending()).toBe(1)
    expect(clock.fireNext()).toBe(true)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatch(/^\[2m00s\] research 0 of 44/)

    const quiet: string[] = []
    const sealed = plainWriter({
      write: line => quiet.push(line),
      clock: fakeClock(),
      heartbeat: true,
      view: 'public',
    })
    sealed.sink(started(['security']))
    expect(quiet).toEqual([])
  })

  it('writes the deadline warning in the plain mode\'s log once', () => {
    let now = 0
    const clock: Clock = {
      now: () => now,
      random: () => 0.5,
      timer: () => () => {},
    }
    const lines: string[] = []
    const view = plainWriter({
      write: line => lines.push(line),
      clock,
    })
    view.begin({
      ...DEFAULT_FACTS,
      concurrency: 1,
      deadlineMs: 1_800_000,
      deadline: 'config',
      keeps: true,
    })
    for (const { at, event } of slowResearch(300_000)) {
      now = at
      view.sink(event)
    }
    const warnings = lines.filter(line => line.startsWith('warning: '))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toBe('warning: the deadline of 30m00s (reviewTimeoutMs) comes before research ends, which this review\'s first estimate puts at 150m from its start: the review stops at the deadline, and what is left is a review-deadline gap; raise reviewTimeoutMs, up to 24h00m00s')
    // It follows the line of the part that made the estimate, the third to answer, and no other line is a note.
    expect(lines[lines.indexOf(warnings[0]) - 1]).toMatch(/^\[naming\] part 2 of 15: answered in 5m00s, /)
    expect(lines.filter(line => line.startsWith('notice: '))).toEqual([])
  })

  it('writes no heartbeat after run:end, and none when heartbeat is off or the writer is restored', () => {
    const clock = fakeClock()
    const lines: string[] = []
    const view = plainWriter({
      write: line => lines.push(line),
      clock,
      heartbeat: true,
    })
    view.sink(started(['security']))
    expect(clock.pending()).toBe(1)
    view.sink(ended)
    expect(clock.pending()).toBe(0)
    expect(lines).toEqual(['0 kept, 0 discarded, 0 unreviewed by panel'])

    const off = fakeClock()
    const plain = plainWriter({
      write: () => {},
      clock: off,
    })
    plain.sink(started(['security']))
    plain.line('notice', 'x')
    expect(off.armed).toEqual([])

    // A review that was aborted sends no run:end: restore() stops the timer, and no later line arms it again.
    const aborted = fakeClock()
    const written: string[] = []
    const stopped = plainWriter({
      write: line => written.push(line),
      clock: aborted,
      heartbeat: true,
    })
    stopped.sink(started(['security']))
    expect(aborted.pending()).toBe(1)
    stopped.restore()
    stopped.restore()
    expect(aborted.pending()).toBe(0)
    expect(aborted.fireNext()).toBe(false)
    stopped.line('error', 'Error: x')
    stopped.sink({
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 1,
    })
    expect(aborted.pending()).toBe(0)
    expect(written).toEqual(['Error: x'])

    const closing = fakeClock()
    const closed = plainWriter({
      write: () => {},
      clock: closing,
      heartbeat: true,
    })
    closed.sink(started(['security']))
    expect(closing.pending()).toBe(1)
    return closed.close().then(() => {
      expect(closing.pending()).toBe(0)
    })
  })

  it('writes the CLI\'s lines at every level, as they come and inert', () => {
    const lines: string[] = []
    const view = plainWriter({
      write: line => lines.push(line),
    })
    const levels: LineLevel[] = [
      'warning',
      'banner',
      'estimate',
      'notice',
      'error',
    ]
    view.line('warning', `warning: a${ESC}[2Jb`)
    view.sink(started(['team']))
    view.line('banner', 'Research (default)...')
    view.sink({
      type: 'stage:end',
      profile: 'team',
      stage: 'dedup',
      durationMs: 1,
      count: 2,
    })
    for (const level of levels.slice(2)) view.line(level, '::error::x\nsecond')
    expect(lines).toEqual([
      'warning: a<U+001B>[2Jb',
      'Research (default)...',
      '2 candidate(s) after dedup',
      '<U+003A>:error::x<U+000A>second',
      '<U+003A>:error::x<U+000A>second',
      '<U+003A>:error::x<U+000A>second',
    ])
  })

  it('writes the summary once, after everything else', () => {
    const list = longReview()
    let now = 0
    const clock: Clock = {
      ...fakeClock(),
      now: () => now,
    }
    const lines: string[] = []
    const view = plainWriter({
      write: line => lines.push(line),
      clock,
    })
    for (const { at, event } of list) {
      now = at
      view.sink(event)
    }
    const before = lines.length
    const facts = {
      stdout: { format: 'text' as const, terminal: true },
      stderr: { terminal: true },
      outputs: ['json' as const],
      state: { kind: 'none' as const, kept: 0 },
      result: reportResult({
        meta: { durationMs: 2_285_000 },
      }),
    }
    view.summary(facts)
    view.summary(facts)
    expect(lines).toHaveLength(before + 6)
    expect(lines.slice(before)).toEqual([
      'time: research 30m12s, dedup 0.0s, panel 7m40s; the first estimate, 5m10s in, put research at 30-31m',
      'tokens: 74 percent of the cap of 2.00M, the default',
      'calls: 46 research (2 retried, 1 recovered into 2 pieces), 18 vote(s)',
      'gaps: 1 part(s) research-failed (timeout): raise timeoutMs',
      'result: the text report above; --output json written',
      'resume: to keep the answered calls for a rerun, pass --state <dir>; this review kept none',
    ])

    // A review that ran no stage writes none, and a new review writes its own.
    const empty: string[] = []
    const idle = plainWriter({
      write: line => empty.push(line),
    })
    idle.summary(facts)
    expect(empty).toEqual([])
    idle.sink(started(['team']))
    idle.begin(DEFAULT_FACTS)
    idle.summary(facts)
    expect(empty).toEqual([])
  })

  it('writes no glyph, no colour and no control sequence', () => {
    const list = longReview()
    let now = 0
    const clock: Clock = {
      ...fakeClock(),
      now: () => now,
    }
    const lines: string[] = []
    const view = plainWriter({
      write: line => lines.push(line),
      clock,
    })
    for (const { at, event } of list) {
      now = at
      view.sink(event)
    }
    // One line as each of the 44 parts ends, a line for part 9's recovery and for the two retries (parts 7 and 12), the dedup count and the totals.
    expect(lines.filter(line => /^part \d+ of 44: (?:answered|failed|split)/.test(line))).toHaveLength(44)
    expect(lines.filter(line => /retry 1 of 2 in/.test(line))).toEqual([
      'part 7 of 44: http 503 after 7m08s, retry 1 of 2 in 4s',
      'part 12 of 44: timeout after 10m00s, retry 1 of 2 in 2s',
    ])
    expect(lines.slice(-2)).toEqual(['6 candidate(s) after dedup', '4 kept, 2 discarded, 0 unreviewed by panel'])
    for (const line of lines) {
      expect(line).not.toContain(ESC)
      expect([...line].every(char => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) <= 0x7E)).toBe(true)
    }
    expect(replay(list).ended).toBe(true)
  })

  it('writes a review\'s documents as one line each before its stages, with no glyph and no prefix', () => {
    const lines: string[] = []
    const sink = plainWriter({
      write: line => lines.push(line),
    }).sink
    sink(started(['security', 'naming']))
    sink({
      type: 'context',
      context: {
        documents: [
          contextDocument({
            origin: 'repository',
            path: 'docs/threat-model.md',
            commit: '1f3a9c2'.padEnd(40, 'a'),
            sha256: 'a'.repeat(64),
          }),
          contextDocument({
            profile: 'naming',
            origin: 'config',
            sha256: '3f2a9c1d0b7e'.padEnd(64, '0'),
            bytes: 4100,
            removed: { characters: 3, comments: 1, entities: 0 },
          }),
          contextDocument({
            profile: 'naming',
            kind: 'do-not-report',
            origin: 'repository',
            path: 'REVIEW-skip.md',
            commit: '1f3a9c2'.padEnd(40, 'a'),
            status: 'missing',
            bytes: 0,
          }),
        ],
      },
    })
    sink({
      type: 'stage:end',
      profile: 'naming',
      stage: 'dedup',
      durationMs: 1,
      count: 2,
    })
    expect(lines).toEqual([
      'context: security guidelines "docs/threat-model.md" at 1f3a9c2, 1830 bytes',
      'context: naming guidelines from a file, sha256 3f2a9c1d0b7e, 4100 bytes; the cleaner removed 3 hidden character(s) and 1 comment(s)',
      'context: naming do-not-report text "REVIEW-skip.md" at 1f3a9c2: missing, and optional',
      '[naming] 2 candidate(s) after dedup',
    ])
    for (const line of lines) {
      expect(line).not.toContain(ESC)
      expect([...line].every(char => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) <= 0x7E)).toBe(true)
    }
  })
})
