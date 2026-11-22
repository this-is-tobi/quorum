import { describe, expect, it } from 'vitest'
import type { Estimate, ProviderRef, QuorumEvent } from '../../core/types.ts'
import { longReview, replay, twoProfiles } from '../../testing/events.ts'
import { rangeWords, timeLeft } from './eta.ts'
import { DEFAULT_FACTS, fold, stageEnd, startState } from './model.ts'
import type { ViewFacts, ViewState } from './model.ts'
import type { TimeLeft } from './eta.ts'

const API = { id: 'api', model: 'model' }
const OTHER = { id: 'other', model: 'model' }

/** The events of a profile's research: its parts started together at 0, the answered ones ended at the given durations, in that order. */
function research(options: { readonly profile?: string, readonly provider?: ProviderRef, readonly parts: number, readonly answered: readonly number[], readonly planned?: number, readonly flying?: ReadonlyArray<{ readonly index: number, readonly startedAt: number }> }): Array<[number, QuorumEvent]> {
  const { profile = 'security', provider = API, parts, answered, planned = 10_000 } = options
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
        provider,
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
        provider,
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
        provider,
        part: { index, count: parts },
        reserved: planned,
        timeoutMs: 600_000,
      },
    ])
  }
  return events
}

function started(profiles: string[], providers: Readonly<Record<string, ProviderRef>> = {}): QuorumEvent {
  return {
    type: 'run:start',
    profiles,
    providers: Object.fromEntries(profiles.map(id => [
      id,
      { research: providers[id] ?? API, lenses: {} },
    ])),
  }
}

/** The state after `profiles` started and `events` happened. */
function stateOf(profiles: Array<{ readonly id: string, readonly parts: number, readonly provider?: ProviderRef }>, events: Array<[number, QuorumEvent]>, facts: ViewFacts = DEFAULT_FACTS): ViewState {
  let state = fold(startState(facts), started(profiles.map(({ id }) => id), Object.fromEntries(profiles.flatMap(({ id, provider }) => provider === undefined
    ? []
    : [
        [id, provider],
      ]))), 0)
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
    findingsCap: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
    held: parts.length,
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

  /** A provider's lane at `limit`, as the events say it: its limit is set by a growth. */
  const laneAt = (provider: ProviderRef, limit: number): [number, QuorumEvent] => [
    0,
    {
      type: 'concurrency',
      provider,
      limit,
      cause: 'grown',
    },
  ]

  it('gives 3g\'s range for one provider, its lane\'s limit as the calls at once', () => {
    const answered = research({ parts: 12, answered: SECONDS })
    const at = (limit: number): TimeLeft => timeLeft(stateOf([
      { id: 'security', parts: 12 },
    ], [
      ...answered,
      laneAt(API, limit),
    ]), 160_000)
    // 8 parts are left at 10 000 tokens, between 10 and 14 ms a token
    expect(at(4)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 200_000,
      highMs: 280_000,
    })
    expect(at(2)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 400_000,
      highMs: 560_000,
    })
    expect(at(6)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 80_000 * 10 / 6,
      highMs: 80_000 * 14 / 6,
    })
    // never over the parts left
    expect(at(12)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 100_000,
      highMs: 140_000,
    })
    // a lane no event has moved is at its start, 4
    expect(timeLeft(stateOf([
      { id: 'security', parts: 12 },
    ], answered), 160_000)).toEqual(at(4))
    // a cut and a regrowth are read at the limit they leave
    const moved = stateOf([
      { id: 'security', parts: 12 },
    ], [
      ...answered,
      laneAt(API, 8),
      [
        0,
        {
          type: 'concurrency',
          provider: API,
          limit: 4,
          cause: 'cut',
          from: 8,
          failure: { kind: 'http', status: 429 },
        },
      ],
    ])
    expect(timeLeft(moved, 160_000)).toEqual(at(4))
  })

  it('takes the largest of each research provider\'s own estimate when two run side by side', () => {
    const slow = [300_000, 360_000, 420_000, 480_000]
    const profiles = [
      { id: 'security', parts: 12, provider: API },
      { id: 'style', parts: 12, provider: OTHER },
    ]
    const events = [
      ...research({ parts: 12, answered: SECONDS }),
      ...research({
        profile: 'style',
        provider: OTHER,
        parts: 12,
        answered: slow,
      }),
    ]
    // each has 8 parts of 10 000 tokens left, over its own 4: its own rates, 10 to 14 and 30 to 42 ms a token
    expect(timeLeft(stateOf(profiles, events), 480_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 600_000,
      highMs: 840_000,
    })
    // the one with the longer lane is not the slower one
    expect(timeLeft(stateOf(profiles, [
      ...events,
      laneAt(OTHER, 8),
    ]), 480_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 300_000,
      highMs: 420_000,
    })
    // lanes that pass 16 together are scaled down together to 16: 12 and 12 over 18 parts left each are 8 and 8
    const many = [
      { id: 'security', parts: 22, provider: API },
      { id: 'style', parts: 22, provider: OTHER },
    ]
    const wide = [
      ...research({ parts: 22, answered: SECONDS }),
      ...research({
        profile: 'style',
        provider: OTHER,
        parts: 22,
        answered: slow,
      }),
      laneAt(API, 12),
      laneAt(OTHER, 12),
    ]
    expect(timeLeft(stateOf(many, wide), 480_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 180_000 * 30 / 8,
      highMs: 180_000 * 42 / 8,
    })
    // two profiles on one provider are one estimate, over that provider's one lane
    const same = [
      { id: 'security', parts: 12, provider: API },
      { id: 'style', parts: 12, provider: API },
    ]
    const together = [
      ...research({ parts: 12, answered: SECONDS }),
      ...research({ profile: 'style', parts: 12, answered: SECONDS }),
    ]
    expect(timeLeft(stateOf(same, together), 160_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 160_000 * 10 / 4,
      highMs: 160_000 * 14 / 4,
    })
  })

  it('reads estimating until every provider with parts left has its threshold', () => {
    const profiles = [
      { id: 'security', parts: 12, provider: API },
      { id: 'style', parts: 12, provider: OTHER },
    ]
    const own = research({ parts: 12, answered: SECONDS })
    // the other provider has answered nothing, whatever the first has
    expect(timeLeft(stateOf(profiles, own), 160_000)).toEqual({ kind: 'estimating' })
    const two = research({
      profile: 'style',
      provider: OTHER,
      parts: 12,
      answered: [200_000, 240_000],
    })
    expect(timeLeft(stateOf(profiles, [
      ...own,
      ...two,
    ]), 240_000)).toEqual({ kind: 'estimating' })
    const three = research({
      profile: 'style',
      provider: OTHER,
      parts: 12,
      answered: [200_000, 240_000, 280_000],
    })
    expect(timeLeft(stateOf(profiles, [
      ...own,
      ...three,
    ]), 280_000).kind).toBe('range')
    // a provider with no part left does not wait for a threshold
    const done = research({
      profile: 'style',
      provider: OTHER,
      parts: 3,
      answered: [200_000, 240_000, 280_000],
    })
    expect(timeLeft(stateOf([
      { id: 'security', parts: 12, provider: API },
      { id: 'style', parts: 3, provider: OTHER },
    ], [
      ...own,
      ...done,
    ]), 280_000).kind).toBe('range')
  })

  it('pools every profile, as 3g does, with concurrency set', () => {
    const profiles = [
      { id: 'security', parts: 12, provider: API },
      { id: 'style', parts: 12, provider: OTHER },
    ]
    const events = [
      ...research({ parts: 12, answered: SECONDS }),
      ...research({
        profile: 'style',
        provider: OTHER,
        parts: 12,
        answered: [300_000, 360_000, 420_000, 480_000],
      }),
      // a lane event is not sent with concurrency set, and one that came is not read
      laneAt(API, 2),
    ]
    // 16 parts of 10 000 tokens left over the 4 calls at once, at the pooled quartiles of 12 and 36 ms a token
    expect(timeLeft(stateOf(profiles, events, { ...DEFAULT_FACTS, concurrency: 4 }), 480_000)).toEqual({
      kind: 'range',
      stage: 'research',
      lowMs: 160_000 * 12 / 4,
      highMs: 160_000 * 36 / 4,
    })
    // one threshold for all of them: 3 answered parts pool, wherever they answered
    expect(timeLeft(stateOf(profiles, research({
      parts: 12,
      answered: SECONDS.slice(0, 3),
    }), { ...DEFAULT_FACTS, concurrency: 4 }), 160_000).kind).toBe('range')
  })

  it('sums the lanes\' limits as the votes\' calls at once, at most 16', () => {
    const list = longReview()
    const first = list.find(({ event }) => event.type === 'call' && event.role === 'vote')!.at
    const lane = (provider: ProviderRef, limit: number): QuorumEvent => ({
      type: 'concurrency',
      provider,
      limit,
      cause: 'grown',
    })
    // the lenses run on both providers, so both lanes count
    const both = list.map(({ at, event }) => event.type === 'run:start'
      ? {
          at,
          event: {
            ...event,
            providers: Object.fromEntries(event.profiles.map(id => [
              id,
              {
                research: API,
                lenses: { impact: API, reachability: OTHER },
              },
            ])),
          },
        }
      : { at, event })
    const base = replay(list, first)
    // 17 votes left over the one lane's 4, the recorded review's
    expect(timeLeft(base, first)).toMatchObject({ lowMs: 85_000 * 17 / 4 })
    // a second lens provider with no lane yet counts 4
    expect(timeLeft(replay(both, first), first)).toMatchObject({ lowMs: 85_000 * 17 / 8 })
    const two = fold(fold(replay(both, first), lane(API, 6), first), lane(OTHER, 2), first)
    expect(timeLeft(two, first)).toMatchObject({ lowMs: 85_000 * 17 / 8 })
    const wide = fold(fold(replay(both, first), lane(API, 12), first), lane(OTHER, 8), first)
    expect(timeLeft(wide, first)).toMatchObject({ lowMs: 85_000 * 17 / 16 })
    // with concurrency set it is the setting
    expect(timeLeft(replay(both, first, { ...DEFAULT_FACTS, concurrency: 2 }), first)).toMatchObject({ lowMs: 85_000 * 17 / 2 })
  })

  it('runs the panel\'s votes at the lanes of its lenses\' providers alone, a research-only lane left out', () => {
    const big = { id: 'big', model: 'model' }
    const lane = (provider: ProviderRef, limit: number): [number, QuorumEvent] => [
      0,
      {
        type: 'concurrency',
        provider,
        limit,
        cause: 'grown',
      },
    ]
    const panel = (...lanes: Array<[number, QuorumEvent]>): ViewState => {
      let state = fold(startState(DEFAULT_FACTS), {
        type: 'run:start',
        profiles: ['security'],
        providers: {
          security: {
            research: big,
            lenses: { impact: API, reachability: API },
          },
        },
      }, 0)
      const events: Array<[number, QuorumEvent]> = [
        ...lanes,
        [
          0,
          {
            type: 'stage:start',
            profile: 'security',
            stage: 'panel',
            votes: 9,
          },
        ],
        [
          10_000,
          {
            type: 'call',
            call: 1,
            profile: 'security',
            role: 'vote',
            lens: 'impact',
            provider: API,
            finding: 'finding-1',
            durationMs: 10_000,
            ok: true,
            usage: { inputTokens: 5000, outputTokens: 300 },
            spent: 5300,
          },
        ],
        [
          10_000,
          {
            type: 'vote',
            profile: 'security',
            findingId: 'finding-1',
            lens: 'impact',
            keep: true,
          },
        ],
      ]
      for (const [at, event] of events) state = fold(state, event, at)
      return state
    }
    // 8 votes left of 10 000 ms each, at the lenses' provider's 4 and not at the 16 of both lanes
    expect(timeLeft(panel(lane(big, 12), lane(API, 4)), 10_000)).toEqual({
      kind: 'range',
      stage: 'panel',
      lowMs: 20_000,
      highMs: 20_000,
    })
    // a lens provider with no lane yet counts 4
    expect(timeLeft(panel(lane(big, 12)), 10_000)).toEqual(timeLeft(panel(lane(big, 12), lane(API, 4)), 10_000))
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
