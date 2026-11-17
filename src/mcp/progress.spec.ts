import { describe, expect, it } from 'vitest'
import type { QuorumEvent } from '../core/types.ts'
import { fakeClock } from '../testing/clock.ts'
import { HEARTBEAT_MS, progressReporter } from './progress.ts'
import type { ProgressNote } from './progress.ts'

const PROVIDER = { id: 'p', model: 'm' }

function research(): QuorumEvent {
  return {
    type: 'call',
    profile: 'security',
    role: 'research',
    provider: PROVIDER,
    durationMs: 1,
    ok: true,
    spent: 10,
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
    onEvent({ type: 'stage:start', profile: 'security', stage: 'research' })
    onEvent(research())
    onEvent(research())
    onEvent({ type: 'stage:start', profile: 'security', stage: 'panel' })
    onEvent(verdict())
    expect(notes.map(({ message }) => message)).toEqual([
      'reading the change',
      'research: 0 parts done',
      'research: 1 part done',
      'research: 2 parts done',
      'panel: 0 findings decided',
      'panel: 1 finding decided',
    ])
    stop()
  })

  it('notifies at least once a minute while nothing happens, repeating its last message', () => {
    const { clock, notes, onEvent, stop } = reporter()
    onEvent(research())
    expect(clock.armed).toEqual([HEARTBEAT_MS, HEARTBEAT_MS])
    expect(clock.pending()).toBe(1)
    expect(clock.fireNext()).toBe(true)
    expect(clock.now()).toBe(HEARTBEAT_MS)
    expect(notes.at(-1)).toEqual({ progress: 3, message: 'research: 1 part done' })
    expect(clock.fireNext()).toBe(true)
    expect(notes.at(-1)).toEqual({ progress: 4, message: 'research: 1 part done' })
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
})
