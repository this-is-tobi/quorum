import { describe, expect, it } from 'vitest'
import type { QuorumEvent } from '../core/types.ts'
import { fakeClock } from '../testing/clock.ts'
import { HEARTBEAT_MS, progressReporter } from './progress.ts'
import type { ProgressNote } from './progress.ts'

const PROVIDER = { id: 'p', model: 'm' }

/** A research part that ended. */
function research(): QuorumEvent {
  return {
    type: 'part',
    profile: 'security',
    part: { index: 1, count: 2 },
    outcome: 'reviewed',
    durationMs: 1,
    spent: 10,
  }
}
/** A profile's research starting with `parts` parts. */
function planned(parts: number): QuorumEvent {
  return {
    type: 'stage:start',
    profile: 'security',
    stage: 'research',
    parts,
  }
}
function verdict(): QuorumEvent {
  return {
    type: 'verdict',
    profile: 'security',
    findingId: 'f',
    keptVotes: 1,
    totalVotes: 1,
    status: 'kept',
  }
}

function reporter(): { readonly clock: ReturnType<typeof fakeClock>, readonly notes: ProgressNote[], readonly onEvent: (event: QuorumEvent) => void, readonly stop: () => void } {
  const clock = fakeClock()
  const notes: ProgressNote[] = []
  return {
    clock,
    notes,
    ...progressReporter(note => notes.push(note), clock),
  }
}

describe('progressReporter', () => {
  it('says it is reading the change at once, then counts the research parts and the findings decided', () => {
    const { notes, onEvent, stop } = reporter()
    expect(notes.map(({ message }) => message)).toEqual(['reading the change'])
    onEvent(planned(2))
    onEvent(research())
    onEvent(research())
    onEvent({
      type: 'stage:start',
      profile: 'security',
      stage: 'panel',
      votes: 1,
    })
    onEvent(verdict())
    expect(notes.map(({ message }) => message)).toEqual([
      'reading the change',
      'research: 0 of 2 parts done',
      'research: 1 of 2 parts done',
      'research: 2 of 2 parts done',
      'panel: 0 findings decided',
      'panel: 1 finding decided',
    ])
    stop()
  })

  it('notifies at least once a minute while nothing happens, repeating its last message', () => {
    const { clock, notes, onEvent, stop } = reporter()
    onEvent(planned(1))
    onEvent(research())
    expect(clock.armed).toEqual([HEARTBEAT_MS, HEARTBEAT_MS, HEARTBEAT_MS])
    expect(clock.pending()).toBe(1)
    expect(clock.fireNext()).toBe(true)
    expect(clock.now()).toBe(HEARTBEAT_MS)
    expect(notes.at(-1)).toEqual({ progress: 4, message: 'research: 1 of 1 part done' })
    expect(clock.fireNext()).toBe(true)
    expect(notes.at(-1)).toEqual({ progress: 5, message: 'research: 1 of 1 part done' })
    stop()
  })

  it('raises progress by one with each note, and sends none once stopped', () => {
    const { clock, notes, onEvent, stop } = reporter()
    onEvent(research())
    onEvent(verdict())
    expect(notes.map(({ progress }) => progress)).toEqual([1, 2, 3])
    stop()
    expect(clock.pending()).toBe(0)
    onEvent(research())
    onEvent(verdict())
    expect(clock.fireNext()).toBe(false)
    expect(notes).toHaveLength(3)

    // A wire that throws ends no review: the note after it is sent all the same.
    const down = fakeClock()
    let attempts = 0
    const failing = progressReporter(() => {
      attempts += 1
      throw new Error('wire down')
    }, down)
    failing.onEvent(research())
    expect(attempts).toBe(2)
    failing.stop()
  })

  it('sends nothing for a vote, a flag, a gap or a stage\'s end', () => {
    const { notes, onEvent, stop } = reporter()
    const quiet: QuorumEvent[] = [
      {
        type: 'vote',
        profile: 'security',
        findingId: 'f',
        lens: 'l',
        keep: true,
      },
      {
        type: 'flag',
        flag: { code: 'hidden-characters', detail: 'd' },
      },
      {
        type: 'incomplete',
        entry: { profile: 'security', reason: 'research-failed', detail: 'd' },
      },
      {
        type: 'stage:end',
        profile: 'security',
        stage: 'research',
        durationMs: 1,
        count: 1,
      },
      { type: 'stage:start', profile: 'security', stage: 'dedup' },
      {
        type: 'call',
        profile: 'security',
        role: 'vote',
        lens: 'l',
        provider: PROVIDER,
        durationMs: 1,
        ok: true,
        spent: 10,
      },
      {
        type: 'call:retry',
        call: 1,
        attempt: 1,
        retries: 2,
        failure: { kind: 'network' },
        attemptMs: 1000,
        waitMs: 250,
      },
      { type: 'run:stopping', cause: 'review-deadline', inFlight: 1 },
      {
        type: 'run:end',
        kept: 0,
        discarded: 0,
        unreviewed: 0,
        incomplete: 0,
        durationMs: 1,
      },
    ]
    for (const event of quiet) onEvent(event)
    expect(notes).toHaveLength(1)
    stop()
  })

  it('counts research by part events out of the plan\'s parts, never by calls or pieces', () => {
    const { notes, onEvent, stop } = reporter()
    onEvent(planned(44))
    const call = (profile: string): QuorumEvent => ({
      type: 'call',
      profile,
      role: 'research',
      provider: PROVIDER,
      durationMs: 1,
      ok: true,
      spent: 10,
    })
    onEvent(call('security'))
    onEvent(call('security'))
    onEvent({
      type: 'call:start',
      call: 3,
      profile: 'security',
      role: 'research',
      provider: PROVIDER,
      part: {
        index: 1,
        count: 44,
        piece: { index: 1, count: 2 },
      },
      reserved: 10,
      timeoutMs: 1000,
    })
    onEvent(research())
    // Another profile's research adds its parts to the total.
    onEvent({
      type: 'stage:start',
      profile: 'other',
      stage: 'research',
      parts: 2,
    })
    expect(notes.map(({ message }) => message)).toEqual([
      'reading the change',
      'research: 0 of 44 parts done',
      'research: 1 of 44 parts done',
      'research: 1 of 46 parts done',
    ])
    stop()
  })
})
