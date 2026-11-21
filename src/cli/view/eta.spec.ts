import { describe, expect, it } from 'vitest'
import type { Estimate, QuorumEvent } from '../../core/types.ts'
import { longReview, replay, twoProfiles } from '../../testing/events.ts'
import { rangeWords, timeLeft } from './eta.ts'
import { DEFAULT_FACTS, fold, stageEnd, startState } from './model.ts'
import type { ViewFacts, ViewState } from './model.ts'

const API = { id: 'api', model: 'model' }

/** The events of a profile's research: its parts started together at 0, the answered ones ended at the given durations, in that order. */
function research(options: { readonly profile?: string, readonly parts: number, readonly answered: readonly number[], readonly planned?: number, readonly flying?: ReadonlyArray<{ readonly index: number, readonly startedAt: number }> }): Array<[number, QuorumEvent]> {
  const { profile = 'security', parts, answered, planned = 10_000 } = options
  const events: Array<[number, QuorumEvent]> = []
  const call = (index: number): number => (profile === 'security'
    ? 0
    : 100) + index
  answered.forEach((_, at) => {
    const index = at + 1
    events.push([
      0,
      {
        type: 'call:start',
        call: call(index),
        profile,
        role: 'research',
        provider: API,
        part: { index, count: parts },
        reserved: planned,
        timeoutMs: 600_000,
      },
    ])
  })
  answered.forEach((durationMs, at) => {
    const index = at + 1
    events.push([
      durationMs,
      {
        type: 'call',
        call: call(index),
        profile,
        role: 'research',
        provider: API,
        part: { index, count: parts },
        durationMs,
        ok: true,
        usage: { inputTokens: planned / 2, outputTokens: 100 },
        spent: planned / 2 + 100,
        listed: 0,
      },
    ])
    events.push([
      durationMs,
      {
        type: 'part',
        profile,
        part: { index, count: parts },
        outcome: 'reviewed',
        durationMs,
        spent: planned / 2 + 100,
      },
    ])
  })
  for (const { index, startedAt } of options.flying ?? []) {
    events.push([
      startedAt,
      {
        type: 'call:start',
        call: call(index),
        profile,
        role: 'research',
        provider: API,
        part: { index, count: parts },
        reserved: planned,
        timeoutMs: 600_000,
      },
    ])
  }
  return events
}

function started(profiles: string[]): QuorumEvent {
  return {
    type: 'run:start',
    profiles,
    providers: Object.fromEntries(profiles.map(id => [
      id,
      { research: API, lenses: {} },
    ])),
  }
}

/** The state after `profiles` started and `events` happened. */
function stateOf(profiles: Array<{ readonly id: string, readonly parts: number }>, events: Array<[number, QuorumEvent]>, facts: ViewFacts = DEFAULT_FACTS): ViewState {
  let state = fold(startState(facts), started(profiles.map(({ id }) => id)), 0)
  for (const { id, parts } of profiles) {
    state = fold(state, {
      type: 'stage:start',
      profile: id,
      stage: 'research',
      parts,
    }, 0)
  }
  for (const [at, event] of events) state = fold(state, event, at)
  return state
}

/** The state after the `count`th research part of `list` ended, each event folded at its own time. */
function afterParts(list: ReturnType<typeof twoProfiles>, count: number): ViewState {
  let state = startState(DEFAULT_FACTS)
  let ended = 0
  for (const { at, event } of list) {
    state = fold(state, event, at)
    if (event.type === 'part') ended += 1
    if (ended === count) break
  }
  return state
}

const SECONDS = [100_000, 120_000, 140_000, 160_000]

function estimateOf(parts: number[]): Estimate {
  return {
    profiles: {
      security: {
        parts,
        votes: 0,
        vote: {},
        expected: 0,
        worst: 0,
        findings: 50,
        provider: 'api',
      },
    },
    expected: 0,
    worst: 0,
    inFlight: 0,
    maxFindings: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
  }
}

describe('timeLeft', () => {
  it('reads estimating until 3 parts and a tenth of the plan answered', () => {
    expect(timeLeft(startState(DEFAULT_FACTS), 0)).toEqual({ kind: 'none' })
    let state = startState(DEFAULT_FACTS)
    const kinds: string[] = []
    let answered = 0
    for (const { at, event } of longReview()) {
      state = fold(state, event, at)
      if (event.type !== 'part' || event.outcome !== 'reviewed' || event.spent === 0) continue
      answered += 1
      kinds.push(timeLeft(state, at).kind)
      if (answered === 5) break
    }
    expect(kinds).toEqual([
      'estimating',
      'estimating',
      'estimating',
      'estimating',
      'range',
    ])
    const before = replay(longReview(), 120_000)
    expect(timeLeft(before, 120_000)).toEqual({ kind: 'estimating', then: 150 })

    // Twenty parts need 3: a tenth of them would be 2.
    expect(timeLeft(afterParts(twoProfiles(), 2), 0).kind).toBe('estimating')
    expect(timeLeft(afterParts(twoProfiles(), 3), 0).kind).toBe('range')
    const ended = replay(longReview())
    expect(timeLeft(ended, 2_285_000)).toEqual({ kind: 'none' })
  })

  it('gives the range of the 25th and 75th percentile rates over the planned tokens left, over the calls at once', () => {
    const state = stateOf([
      { id: 'security', parts: 12 },
    ], research({ parts: 12, answered: SECONDS }))
    expect(timeLeft(state, 160_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 200_000,
      highMs: 280_000,
    })
    const two = stateOf([
      { id: 'security', parts: 12 },
    ], research({ parts: 12, answered: SECONDS }), { ...DEFAULT_FACTS, concurrency: 2 })
    expect(timeLeft(two, 160_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 400_000,
      highMs: 560_000,
    })
  })

  it('counts a part in flight at what its elapsed time does not yet cover, never below 0', () => {
    const events = research({
      parts: 12,
      answered: SECONDS,
      flying: [
        { index: 5, startedAt: 100_000 },
      ],
    })
    const state = stateOf([
      { id: 'security', parts: 12 },
    ], events)
    // The middle rate is 12 ms a token: 60 s cover 5 000 of the part's 10 000, so 75 000 tokens are left, 4 at once.
    expect(timeLeft(state, 160_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 187_500,
      highMs: 262_500,
    })
    // A part that has run far longer than its rate says covers all its plan and no more: 70 000 tokens are left.
    expect(timeLeft(state, 5_000_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 175_000,
      highMs: 245_000,
    })
  })

  it('weighs the parts not started at the estimate\'s reservations, else at the mean of the planned tokens known', () => {
    const events = research({ parts: 6, answered: SECONDS })
    const without = stateOf([
      { id: 'security', parts: 6 },
    ], events)
    // Two parts left at the 10 000 tokens known, two at once.
    expect(timeLeft(without, 160_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 100_000,
      highMs: 140_000,
    })
    const estimate = estimateOf([
      10_000,
      10_000,
      10_000,
      10_000,
      30_000,
      30_000,
    ])
    const planned = stateOf([
      { id: 'security', parts: 6 },
    ], events, { ...DEFAULT_FACTS, estimate })
    expect(timeLeft(planned, 160_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 300_000,
      highMs: 420_000,
    })
    // An estimate of another plan, whose part count the stage does not have, is not used.
    const other = stateOf([
      { id: 'security', parts: 6 },
    ], events, {
      ...DEFAULT_FACTS,
      estimate: estimateOf([30_000, 30_000]),
    })
    expect(timeLeft(other, 160_000)).toEqual(timeLeft(without, 160_000))
    // Before a profile's stage starts, its parts are the estimate's.
    const waiting = fold(startState({ ...DEFAULT_FACTS, estimate }), started(['security']), 0)
    expect(timeLeft(waiting, 0)).toEqual({ kind: 'estimating' })
  })

  it('estimates the votes left from the votes cast, and says the votes to come before the first is cast', () => {
    const list = longReview()
    const panel = list.find(({ event }) => event.type === 'stage:start' && event.stage === 'panel')!.at
    expect(timeLeft(replay(list, panel), panel)).toEqual({ kind: 'estimating', then: 18 })
    // Four votes are asked at once, in 85 to 100 s; once the first ended, 17 are left over a sample of one.
    const first = list.find(({ event }) => event.type === 'call' && event.role === 'vote')!.at
    const state = replay(list, first)
    expect(state.sample.votes).toEqual([85_000])
    expect(state.profiles.get('security')?.cast).toBe(1)
    expect(timeLeft(state, first)).toEqual({
      kind: 'range',
      stage: 'panel',
      lowMs: 85_000 * 17 / 4,
      highMs: 85_000 * 17 / 4,
    })
    // Early in research the votes to come are maxFindings of each lens.
    expect(timeLeft(replay(list, 400_000), 400_000)).toMatchObject({ then: 150 })
  })

  it('pools the profiles\' parts, which share the review\'s one limit', () => {
    const state = afterParts(twoProfiles(), 6)
    expect([
      ...state.profiles.values(),
    ].map(profile => profile.done)).toEqual([3, 3])
    // 20 parts of 60 000 tokens: 6 answered in 100 to 140 s, so 1.67, 2 and 2.33 ms a token at the quartiles and the
    // middle; 2 in flight, one covered by its 120 s and one by 80 of its 140; 12 not started: 740 000 tokens left of both
    // profiles, over the 4 calls at once and not over 4 for each profile.
    const left = timeLeft(state, 240_000)
    if (left.kind !== 'range') throw new Error('expected a range')
    expect(left.stage).toBe('research')
    expect(left.lowMs).toBeCloseTo(740_000 * (100_000 / 60_000) / 4, 3)
    expect(left.highMs).toBeCloseTo(740_000 * (140_000 / 60_000) / 4, 3)
    expect(left.then).toBe(300)
  })

  it.each<[number, number, string]>([
    [720_000, 960_000, '12-16m'],
    [40_000, 90_000, '40-90s'],
    [90_000, 180_000, '90s-3m'],
    [180_000, 180_000, '3m'],
  ])('words %s and %s as %s', (low, high, words) => {
    expect(rangeWords(low, high, '-')).toBe(words)
  })

  it('holds the real end of a recorded 44-part review within its first range', () => {
    const end = replay(longReview())
    const { firstEstimate } = end
    expect(firstEstimate).toBeDefined()
    const real = stageEnd(end, 'research')! - firstEstimate!.at
    expect(real).toBeGreaterThanOrEqual(firstEstimate!.lowMs)
    expect(real).toBeLessThanOrEqual(firstEstimate!.highMs)
  })
})
