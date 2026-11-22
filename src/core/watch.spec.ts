import { describe, expect, it } from 'vitest'
import { fakeClock } from '../testing/clock.ts'
import type { FakeClock } from '../testing/clock.ts'
import { newWatch, noteSignal, PROGRESS_MS, progressReports } from './watch.ts'
import type { ProgressReport, Signal } from './watch.ts'

/** Moves the fake clock to `time`, firing each timer due before it on the way; a timer due at `time` itself is left pending. */
function advanceTo(clock: FakeClock, time: number): void {
  const marker = { reached: false }
  const cancel = clock.timer(time - clock.now(), () => {
    marker.reached = true
  })
  while (!marker.reached) {
    if (!clock.fireNext()) break
  }
  cancel()
}

/** The reports of one call on a fake clock, each stamped with the time it was sent at. */
function reporting(clock: FakeClock, send?: (report: ProgressReport) => void): { reports: ReturnType<typeof progressReports>, sent: Array<[number, number, ProgressReport['signal']]> } {
  const sent: Array<[number, number, ProgressReport['signal']]> = []
  const reports = progressReports(clock, (report) => {
    sent.push([
      clock.now(),
      report.outputTokens,
      report.signal,
    ])
    send?.(report)
  })
  return { reports, sent }
}

describe('progressReports', () => {
  it('sends the first report at once, and at most one in PROGRESS_MS after it', () => {
    const clock = fakeClock()
    const { reports, sent } = reporting(clock)
    reports.attempt()
    reports.progressed('data', 10)
    advanceTo(clock, PROGRESS_MS - 1)
    reports.progressed('data', 20)
    expect(sent).toEqual([
      [0, 10, 'tokens'],
    ])
    advanceTo(clock, PROGRESS_MS)
    expect(sent).toEqual([
      [0, 10, 'tokens'],
      [PROGRESS_MS, 20, 'tokens'],
    ])
    advanceTo(clock, 2 * PROGRESS_MS)
    reports.progressed('data', 30)
    expect(sent).toHaveLength(3)
    expect(clock.pending()).toBe(0)
  })

  it('reports tokens when the output grew since the last report, and keep-alive when only keep-alives came', () => {
    const clock = fakeClock()
    const { reports, sent } = reporting(clock)
    reports.attempt()
    reports.progressed('data', 10)
    advanceTo(clock, PROGRESS_MS)
    // Data that grew nothing and no keep-alive: nothing to report, and nothing held.
    reports.progressed('data', 10)
    expect(sent).toHaveLength(1)
    expect(clock.pending()).toBe(0)
    reports.progressed('keep-alive', 10)
    expect(sent.at(-1)).toEqual([PROGRESS_MS, 10, 'keep-alive'])
    advanceTo(clock, 2 * PROGRESS_MS)
    reports.progressed('keep-alive', 10)
    expect(sent.at(-1)).toEqual([2 * PROGRESS_MS, 10, 'keep-alive'])
    advanceTo(clock, 3 * PROGRESS_MS)
    reports.progressed('data', 25)
    expect(sent.at(-1)).toEqual([3 * PROGRESS_MS, 25, 'tokens'])
    advanceTo(clock, 4 * PROGRESS_MS)
    reports.progressed('data', 25)
    expect(sent).toHaveLength(4)
    expect(clock.pending()).toBe(0)
  })

  it('starts each attempt\'s count from 0, and keeps the spacing across attempts', () => {
    const clock = fakeClock()
    const { reports, sent } = reporting(clock)
    reports.attempt()
    reports.progressed('data', 500)
    advanceTo(clock, 2 * PROGRESS_MS)
    reports.attempt()
    reports.progressed('data', 50)
    expect(sent).toEqual([
      [0, 500, 'tokens'],
      [2 * PROGRESS_MS, 50, 'tokens'],
    ])
    advanceTo(clock, 2 * PROGRESS_MS + 100)
    reports.attempt()
    reports.progressed('data', 5)
    expect(sent).toHaveLength(2)
    advanceTo(clock, 3 * PROGRESS_MS)
    expect(sent.at(-1)).toEqual([3 * PROGRESS_MS, 5, 'tokens'])
    expect(clock.pending()).toBe(0)
  })

  it('holds a report due within the spacing on one timer for what is left of it, and sends it with the latest output', () => {
    const clock = fakeClock()
    const { reports, sent } = reporting(clock)
    reports.attempt()
    reports.progressed('data', 100)
    advanceTo(clock, 500)
    reports.progressed('data', 5800)
    advanceTo(clock, 900)
    reports.progressed('data', 6000)
    reports.progressed('data', 6000)
    expect(sent).toEqual([
      [0, 100, 'tokens'],
    ])
    expect(clock.pending()).toBe(1)
    advanceTo(clock, 5000)
    expect(sent).toEqual([
      [0, 100, 'tokens'],
      [PROGRESS_MS, 6000, 'tokens'],
    ])
    expect(clock.pending()).toBe(0)
  })

  it('holds a keep-alive the same way, and sends it as a keep-alive when the output did not grow', () => {
    const clock = fakeClock()
    const { reports, sent } = reporting(clock)
    reports.attempt()
    reports.progressed('data', 100)
    advanceTo(clock, 300)
    reports.progressed('keep-alive', 100)
    expect(sent).toHaveLength(1)
    advanceTo(clock, 5000)
    expect(sent).toEqual([
      [0, 100, 'tokens'],
      [PROGRESS_MS, 100, 'keep-alive'],
    ])
    expect(clock.pending()).toBe(0)
  })

  it('drops a held report when the attempt ends', () => {
    const clock = fakeClock()
    const { reports, sent } = reporting(clock)
    reports.attempt()
    reports.progressed('data', 100)
    advanceTo(clock, 300)
    reports.progressed('data', 900)
    expect(clock.pending()).toBe(1)
    reports.ended()
    expect(clock.pending()).toBe(0)
    advanceTo(clock, 5000)
    expect(sent).toEqual([
      [0, 100, 'tokens'],
    ])
    // Ending an attempt that holds nothing, and ending it twice, change nothing.
    reports.ended()
    reports.ended()
    expect(clock.pending()).toBe(0)
  })

  it('drops a held report when the next attempt starts', () => {
    const clock = fakeClock()
    const { reports, sent } = reporting(clock)
    reports.attempt()
    reports.progressed('data', 100)
    advanceTo(clock, 300)
    reports.progressed('keep-alive', 900)
    expect(clock.pending()).toBe(1)
    reports.attempt()
    expect(clock.pending()).toBe(0)
    advanceTo(clock, 5000)
    expect(sent).toEqual([
      [0, 100, 'tokens'],
    ])
  })

  it('never lets a sink that throws as the held report is sent escape the timer', () => {
    const clock = fakeClock()
    const { reports, sent } = reporting(clock, () => {
      if (clock.now() > 0) throw new Error('the sink threw')
    })
    reports.attempt()
    reports.progressed('data', 100)
    advanceTo(clock, 300)
    reports.progressed('data', 200)
    expect(() => advanceTo(clock, 5000)).not.toThrow()
    expect(sent).toEqual([
      [0, 100, 'tokens'],
      [PROGRESS_MS, 200, 'tokens'],
    ])
    expect(clock.pending()).toBe(0)
  })
})

describe('noteSignal', () => {
  const data = (outputTokens: number, shown: { answer?: boolean, reasoning?: boolean } = {}): Signal => ({
    kind: 'data',
    outputTokens,
    answer: shown.answer ?? false,
    reasoning: shown.reasoning ?? false,
  })

  it('takes a headers signal as progress, and returns false', () => {
    const watch = newWatch(100)
    expect(noteSignal(watch, { kind: 'headers' }, 350)).toBe(false)
    expect(watch).toMatchObject({
      sentAt: 100,
      progressAt: 350,
      longestSilenceMs: 250,
      firstDataAt: undefined,
      outputTokens: 0,
    })
  })

  it('changes nothing for a keep-alive', () => {
    const watch = newWatch(100)
    expect(noteSignal(watch, { kind: 'keep-alive' }, 900)).toBe(false)
    expect(watch).toEqual(newWatch(100))
  })

  it('takes a data signal as progress, sets firstDataAt once, and returns true for the first data event alone', () => {
    const watch = newWatch(0)
    expect(noteSignal(watch, { kind: 'headers' }, 10)).toBe(false)
    expect(noteSignal(watch, data(5), 40)).toBe(true)
    expect(watch).toMatchObject({
      firstDataAt: 40,
      progressAt: 40,
      longestSilenceMs: 30,
      outputTokens: 5,
    })
    expect(noteSignal(watch, data(9), 500)).toBe(false)
    expect(watch).toMatchObject({
      firstDataAt: 40,
      progressAt: 500,
      longestSilenceMs: 460,
      outputTokens: 9,
    })
  })

  it('raises outputTokens and never lowers it, and keeps answer and reasoning once shown', () => {
    const watch = newWatch(0)
    noteSignal(watch, data(50, { reasoning: true }), 10)
    expect(watch).toMatchObject({ outputTokens: 50, answer: false, reasoning: true })
    noteSignal(watch, data(20, { answer: true }), 20)
    expect(watch).toMatchObject({ outputTokens: 50, answer: true, reasoning: true })
    noteSignal(watch, data(80), 30)
    expect(watch).toMatchObject({ outputTokens: 80, answer: true, reasoning: true })
  })

  it('counts the first data event as the first though a keep-alive came before it', () => {
    const watch = newWatch(0)
    noteSignal(watch, { kind: 'keep-alive' }, 5)
    expect(noteSignal(watch, data(1), 8)).toBe(true)
    expect(watch.firstDataAt).toBe(8)
    expect(watch.longestSilenceMs).toBe(8)
  })
})
