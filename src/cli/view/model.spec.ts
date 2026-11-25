import { describe, expect, it } from 'vitest'
import type { IncompleteReason, QuorumEvent } from '../../core/types.ts'
import { longReview, providerDown, replay, slowResearch, streamedReview, twoProfiles } from '../../testing/events.ts'
import { BUCKET_MS, BUCKETS, DEFAULT_FACTS, fold, stageEnd, stageStart, stageTime, startState } from './model.ts'
import type { ViewState } from './model.ts'

const API = { id: 'api', model: 'model' }

/** `events` folded one after the other, each at the time given with it. */
function folded(...events: Array<[number, QuorumEvent]>): ViewState {
  return events.reduce((state, [at, event]) => fold(state, event, at), startState(DEFAULT_FACTS))
}

function started(profiles: string[]): QuorumEvent {
  return {
    type: 'run:start',
    profiles,
    providers: Object.fromEntries(profiles.map(id => [
      id,
      {
        research: API,
        lenses: { impact: API, reachability: API },
      },
    ])),
  }
}

describe('fold', () => {
  it('keeps which providers learned a cut, whose research left a reply-cut-off gap, and every lens\'s provider', () => {
    const cut: QuorumEvent = {
      type: 'cut',
      provider: 'api',
      afterMs: 900_000,
      lowered: false,
    }
    const cutOff = (profile: string): QuorumEvent => ({
      type: 'incomplete',
      entry: { profile, reason: 'reply-cut-off', detail: 'a detail' },
    })
    const local = { id: 'local', model: 'model' }
    const run: QuorumEvent = {
      type: 'run:start',
      profiles: ['security', 'style'],
      providers: {
        security: {
          research: API,
          lenses: { impact: API, reachability: local },
        },
        style: {
          research: local,
          lenses: { impact: API },
        },
      },
    }
    const first = startState(DEFAULT_FACTS)
    expect(first.cutSeen).toEqual(new Set())
    expect(first.cutOffBy).toEqual(new Set())
    expect(first.lensProviders).toEqual(new Set())
    const seen = folded([0, run], [1, cut], [2, cut], [
      3,
      cutOff('style'),
    ], [
      4,
      cutOff('style'),
    ])
    expect(seen.cutSeen).toEqual(new Set(['api']))
    expect(seen.cutOffBy).toEqual(new Set(['local']))
    expect(seen.lensProviders).toEqual(new Set(['api', 'local']))
    const both = fold(seen, cutOff('security'), 5)
    expect(both.cutOffBy).toEqual(new Set(['local', 'api']))
    // a gap of another reason is not a cut-off one
    expect(fold(seen, {
      type: 'incomplete',
      entry: { profile: 'security', reason: 'binary', detail: 'a detail' },
    }, 5).cutOffBy).toEqual(new Set(['local']))
    const again = fold(seen, started(['security']), 6)
    expect(again.cutSeen).toEqual(new Set())
    expect(again.cutOffBy).toEqual(new Set())
    expect(again.lensProviders).toEqual(new Set(['api']))
  })

  it('follows each lane\'s limit, its last change, and its pause and pacing', () => {
    const lane = (limit: number, cause: Extract<QuorumEvent, { type: 'concurrency' }>['cause'], more: Partial<Extract<QuorumEvent, { type: 'concurrency' }>> = {}, provider = API): QuorumEvent => ({
      type: 'concurrency',
      provider,
      limit,
      cause,
      ...more,
    })
    const throttle = { kind: 'http', status: 429 } as const
    const second = { id: 'other', model: 'model' }
    const first = folded([
      0,
      started(['security']),
    ])
    // the research provider of each profile comes from `run:start`
    expect(first.researchProvider).toEqual(new Map([
      ['security', 'api'],
    ]))
    expect(first.lanes.size).toBe(0)

    // a lane is known from its first call, at the start, with no change yet
    const called = fold(first, {
      type: 'call:start',
      call: 1,
      profile: 'security',
      role: 'research',
      provider: API,
      part: { index: 1, count: 2 },
      reserved: 1000,
      timeoutMs: 600_000,
    }, 1)
    expect(called.lanes).toEqual(new Map([
      [
        'api',
        { limit: 4 },
      ],
    ]))

    // growth, then a cut with its throttle, then regrowth, which each move the limit and the last change
    const grown = fold(called, lane(5, 'grown'), 10)
    expect(grown.lanes.get('api')).toEqual({ limit: 5, last: 'grown' })
    const cut = fold(grown, lane(2, 'cut', { from: 5, failure: throttle }), 20)
    expect(cut.lanes.get('api')).toEqual({ limit: 2, last: 'cut', failure: throttle })
    const regrown = fold(cut, lane(3, 'regrown'), 30)
    expect(regrown.lanes.get('api')).toEqual({ limit: 3, last: 'regrown' })

    // a pause and a pacing wait end at a time, and change neither the limit's last change nor its other lanes
    const paused = fold(cut, lane(2, 'paused', { waitMs: 14_000, failure: throttle }), 21_000)
    expect(paused.lanes.get('api')).toEqual({
      limit: 2,
      last: 'cut',
      failure: throttle,
      pausedUntil: 35_000,
    })
    const paced = fold(paused, lane(2, 'paced', { waitMs: 9000 }), 22_000)
    expect(paced.lanes.get('api')).toEqual({
      limit: 2,
      last: 'cut',
      failure: throttle,
      pausedUntil: 35_000,
      pacedUntil: 31_000,
    })
    // a growth while a pause holds keeps the throttle the pause names, and one after it ends drops it
    expect(fold(paced, lane(3, 'regrown'), 23_000).lanes.get('api')).toMatchObject({ last: 'regrown', failure: throttle })
    expect(fold(paced, lane(3, 'regrown'), 36_000).lanes.get('api')).toEqual({
      limit: 3,
      last: 'regrown',
      pausedUntil: 35_000,
      pacedUntil: 31_000,
    })
    // a pause of a lane that never changed has no last change
    expect(fold(called, lane(4, 'paused', { waitMs: 1000, failure: throttle }), 5).lanes.get('api')).toEqual({ limit: 4, failure: throttle, pausedUntil: 1005 })

    // the slots a provider states, and a second lane that has its own entry
    const slots = fold(grown, lane(3, 'slots', {}, second), 40)
    expect(slots.lanes.get('other')).toEqual({ limit: 3, last: 'slots' })
    expect(slots.lanes.get('api')).toEqual({ limit: 5, last: 'grown' })
    // a call of a lane that is known leaves it as it is
    expect(fold(slots, {
      type: 'call:start',
      call: 2,
      profile: 'security',
      role: 'research',
      provider: second,
      part: { index: 2, count: 2 },
      reserved: 1000,
      timeoutMs: 600_000,
    }, 41).lanes.get('other')).toEqual({ limit: 3, last: 'slots' })

    // a review starts its lanes afresh, and `concurrency` set has none and takes no event
    expect(fold(slots, started(['security']), 50).lanes.size).toBe(0)
    const set = fold(startState({ ...DEFAULT_FACTS, concurrency: 8 }), lane(5, 'grown'), 1)
    expect(set.lanes.size).toBe(0)
  })

  it('counts a call sent once more after a bad reply in again, once, beside retried', () => {
    const start = (call: number, role: 'research' | 'vote'): QuorumEvent => ({
      type: 'call:start',
      call,
      profile: 'security',
      role,
      provider: API,
      ...role === 'research'
        ? {
            part: { index: call, count: 4 },
          }
        : { lens: 'impact', finding: 'abc' },
      reserved: 6000,
      timeoutMs: 600_000,
    })
    const retry = (call: number, failure: Extract<QuorumEvent, { type: 'call:retry' }>['failure']): QuorumEvent => ({
      type: 'call:retry',
      call,
      attempt: 1,
      retries: 2,
      failure,
      attemptMs: 1000,
      waitMs: 1000,
    })
    const state = folded([
      0,
      started(['security']),
    ], [
      0,
      start(1, 'research'),
    ], [
      1000,
      retry(1, { kind: 'unusable-reply' }),
    ], [
      2000,
      retry(1, { kind: 'network' }),
    ])
    expect(state.again).toEqual({ research: 1, votes: 0 })
    expect(state.retried).toEqual({ research: 1, votes: 0 })
    expect(state.calls.get(1)).toMatchObject({
      retried: true,
      again: true,
      failure: { kind: 'network' },
    })

    // A call retried before its bad reply counts in both, as one retried call; a reply of only reasoning and a vote cut off count too, and a plain retry does not.
    const later = fold(fold(fold(state, start(2, 'research'), 3000), retry(2, { kind: 'http', status: 503 }), 3500), retry(2, { kind: 'no-answer' }), 4000)
    expect(later.again).toEqual({ research: 2, votes: 0 })
    expect(later.retried).toEqual({ research: 2, votes: 0 })
    const votes = fold(fold(later, start(3, 'vote'), 5000), retry(3, { kind: 'truncated' }), 5500)
    expect(votes.again).toEqual({ research: 2, votes: 1 })
    expect(votes.retried).toEqual({ research: 2, votes: 1 })
    const plain = fold(fold(votes, start(4, 'vote'), 6000), retry(4, { kind: 'timeout' }), 6500)
    expect(plain.again).toEqual({ research: 2, votes: 1 })
    expect(plain.retried).toEqual({ research: 2, votes: 2 })
    expect(startState(DEFAULT_FACTS).again).toEqual({ research: 0, votes: 0 })
  })

  it('counts the failed votes', () => {
    const vote = (lens: string, keep: boolean | null): [number, QuorumEvent] => [
      1000,
      {
        type: 'vote',
        profile: 'security',
        findingId: 'abc',
        lens,
        keep,
        ...keep === null
          ? {
              error: 'x',
              failure: { kind: 'timeout' as const },
            }
          : {},
      },
    ]
    expect(startState(DEFAULT_FACTS).failedVotes).toBe(0)
    const state = folded([
      0,
      started(['security']),
    ], vote('impact', true), vote('reachability', null), vote('defenses', false))
    expect(state.failedVotes).toBe(1)
    // The count comes from the vote events, not from the calls: these votes made none.
    expect(state.made.votes).toBe(0)
    expect(state.profiles.get('security')).toMatchObject({ cast: 3 })
    expect(folded([
      0,
      started(['security']),
    ], vote('impact', null), vote('reachability', null)).failedVotes).toBe(2)
  })

  it('records the research part\'s provider with each answered part\'s sample', () => {
    const state = replay(twoProfiles())
    expect(state.sample.parts.length).toBeGreaterThan(0)
    expect(new Set(state.sample.parts.map(({ provider }) => provider))).toEqual(new Set(['api']))
  })

  it('folds a long review into its parts done, its calls in flight and waiting, its spend and its retries', () => {
    const list = longReview()
    const tenth = replay(list, 600_000)
    expect(tenth.profiles.get('security')).toMatchObject({ stage: 'research', parts: 44, done: 11 })
    expect(tenth.calls.size).toBeLessThanOrEqual(4)
    const waiting = [
      ...tenth.calls.values(),
    ].filter(call => call.waitingUntil !== undefined)
    expect(waiting).toEqual([
      expect.objectContaining({
        role: 'research',
        part: { index: 7, count: 44 },
        waitingUntil: 601_600,
        retried: true,
        failure: { kind: 'http', status: 503 },
        startedAt: 170_000,
      }),
    ])
    expect(tenth.retried).toEqual({ research: 1, votes: 0 })

    const end = replay(list)
    expect(end.profiles.get('security')).toMatchObject({
      stage: 'done',
      parts: 44,
      done: 44,
      votes: 18,
      cast: 18,
      kept: 4,
    })
    expect(end.calls.size).toBe(0)
    expect(end.ended).toBe(true)
    const spent = list.flatMap(({ event }) => event.type === 'call'
      ? [event.spent]
      : []).reduce((sum, tokens) => sum + tokens, 0)
    expect(end.spent).toBe(spent)
    expect(end.made).toEqual({ research: 46, votes: 18 })
    expect(end.recovered).toEqual({ parts: 1, pieces: 2 })
    expect(end.profiles.get('security')?.listed).toBe(10)
    expect(end.usage.get('api')).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    })
  })

  it('numbers the findings of the votes in the order first seen, across profiles', () => {
    const vote = (call: number, profile: string, lens: string, finding: string): [number, QuorumEvent] => [
      1000 + call,
      {
        type: 'call:start',
        call,
        profile,
        role: 'vote',
        lens,
        provider: API,
        finding,
        reserved: 6000,
        timeoutMs: 600_000,
      },
    ]
    const state = folded(
      [
        0,
        started(['security', 'style']),
      ],
      vote(1, 'style', 'impact', 'bbb'),
      vote(2, 'security', 'impact', 'aaa'),
      vote(3, 'style', 'reachability', 'bbb'),
      vote(4, 'security', 'reachability', 'ccc'),
    )
    expect([...state.findings]).toEqual([
      ['bbb', 1],
      ['aaa', 2],
      ['ccc', 3],
    ])
  })

  it('keeps no record of a call once it ended, and never more than one duration per answered part and vote', () => {
    const list = longReview()
    const peak = list.reduce((most, { at }) => Math.max(most, replay(list, at).calls.size), 0)
    expect(peak).toBe(4)
    const end = replay(list)
    expect(end.calls.size).toBe(0)
    const answered = list.filter(({ event }) => event.type === 'part' && event.outcome === 'reviewed' && event.spent > 0)
    expect(answered).toHaveLength(43)
    expect(end.sample.parts).toHaveLength(43)
    expect(end.sample.votes).toHaveLength(18)
    expect(end.sample.parts[0]).toEqual({
      provider: 'api',
      planned: 60_000,
      durationMs: expect.any(Number),
    })
  })

  it('buckets the output tokens of the calls that ended into twenty cells of 30 s', () => {
    const ended = (at: number, outputTokens: number): [number, QuorumEvent] => [
      at,
      {
        type: 'call',
        profile: 'security',
        role: 'research',
        provider: API,
        durationMs: 1,
        ok: true,
        usage: { inputTokens: 1, outputTokens },
        spent: outputTokens + 1,
      },
    ]
    const first = folded([
      0,
      started(['security']),
    ], ended(10_000, 100), ended(40_000, 200))
    expect(first.buckets.start).toBe(0)
    expect(first.buckets.tokens).toHaveLength(BUCKETS)
    expect(first.buckets.tokens.slice(0, 3)).toEqual([100, 200, 0])
    const later = fold(first, ended(700_000, 300)[1], 700_000)
    const shift = Math.floor(700_000 / BUCKET_MS) - BUCKETS + 1
    expect(later.buckets.start).toBe(shift * BUCKET_MS)
    expect(later.buckets.tokens).toHaveLength(BUCKETS)
    expect(later.buckets.tokens).toEqual([
      ...Array.from({ length: BUCKETS - 1 }).fill(0),
      300,
    ])
    const far = fold(later, ended(5_000_000, 7)[1], 5_000_000)
    expect(far.buckets.tokens.reduce((sum, tokens) => sum + tokens, 0)).toBe(7)
  })

  /** The start of a call, streamed unless `stream` is false. */
  const callStart = (call: number, stream = true): QuorumEvent => ({
    type: 'call:start',
    call,
    profile: 'security',
    role: 'research',
    provider: API,
    part: { index: call, count: 4 },
    reserved: 6000,
    timeoutMs: 600_000,
    ...stream
      ? { stream: true as const }
      : {},
  })
  const progress = (call: number, outputTokens: number, signal: 'tokens' | 'keep-alive' = 'tokens'): QuorumEvent => ({
    type: 'call:progress',
    call,
    outputTokens,
    signal,
  })
  const retry = (call: number): QuorumEvent => ({
    type: 'call:retry',
    call,
    attempt: 1,
    retries: 2,
    failure: { kind: 'timeout' },
    attemptMs: 1000,
    waitMs: 1000,
  })
  const answeredCall = (call: number, outputTokens: number, timings: { firstTokenMs?: number, longestSilenceMs?: number, ceilingMs?: number } = {}, provider = API): QuorumEvent => ({
    type: 'call',
    call,
    profile: 'security',
    role: 'research',
    provider,
    durationMs: 1,
    ok: true,
    usage: { inputTokens: 1, outputTokens },
    spent: outputTokens + 1,
    ...timings,
  })

  it('keeps each streamed call\'s output so far, a keep-alive, and its turns', () => {
    const state = folded([
      0,
      started(['security']),
    ], [
      0,
      callStart(1),
    ], [
      0,
      callStart(2, false),
    ], [
      1000,
      progress(1, 100),
    ], [
      2000,
      progress(1, 250),
    ], [
      3000,
      progress(1, 250, 'keep-alive'),
    ])
    expect(state.calls.get(1)).toMatchObject({
      stream: true,
      outputTokens: 250,
      keepAlive: true,
      turns: 2,
      counted: 250,
    })
    expect(state.calls.get(2)).toMatchObject({
      stream: false,
      outputTokens: 0,
      keepAlive: false,
      turns: 0,
      counted: 0,
    })
    // tokens after a keep-alive turn it again, and a progress of a call that is not in flight changes nothing
    const grown = fold(state, progress(1, 400), 4000)
    expect(grown.calls.get(1)).toMatchObject({
      outputTokens: 400,
      keepAlive: false,
      turns: 3,
      counted: 400,
    })
    expect(fold(grown, progress(9, 10), 5000)).toBe(grown)
    // a streamed review ends with no call in flight, and its calls were streamed on the way
    const list = streamedReview()
    const flying = [
      ...replay(list, 600_000).calls.values(),
    ]
    expect(flying.length).toBeGreaterThan(0)
    expect(flying.every(call => call.stream)).toBe(true)
    expect(flying.some(call => call.turns > 0 && call.outputTokens > 0)).toBe(true)
    expect(replay(list).calls.size).toBe(0)
  })

  it('restarts a call\'s output at a retry', () => {
    const state = folded([
      0,
      started(['security']),
    ], [
      0,
      callStart(1),
    ], [
      1000,
      progress(1, 300),
    ], [
      2000,
      progress(1, 300, 'keep-alive'),
    ], [
      3000,
      retry(1),
    ])
    expect(state.calls.get(1)).toMatchObject({
      outputTokens: 0,
      keepAlive: false,
      turns: 1,
      counted: 300,
      retried: true,
    })
    // the new attempt counts again from 0, and what it adds is counted on top of the failed attempt's
    const again = fold(state, progress(1, 50), 5000)
    expect(again.calls.get(1)).toMatchObject({ outputTokens: 50, turns: 2, counted: 350 })
  })

  it('adds streamed growth to the buckets as it comes and the rest of the usage at the end, never twice', () => {
    const cells = (...events: Array<[number, QuorumEvent]>): number[] => folded([
      0,
      started(['security']),
    ], ...events).buckets.tokens.slice(0, 3)
    // growth lands in the cell of its progress, and the end adds the rest of what the reply reported
    expect(cells([
      0,
      callStart(1),
    ], [
      10_000,
      progress(1, 100),
    ], [
      40_000,
      progress(1, 250),
    ], [
      70_000,
      answeredCall(1, 300),
    ])).toEqual([100, 150, 50])
    // a call that streamed all it reported adds nothing at its end, and a keep-alive adds nothing
    expect(cells([
      0,
      callStart(1),
    ], [
      10_000,
      progress(1, 300),
    ], [
      20_000,
      progress(1, 300, 'keep-alive'),
    ], [
      70_000,
      answeredCall(1, 300),
    ])).toEqual([300, 0, 0])
    // a failed attempt's growth stays, and the answered attempt adds its own growth and the rest of its usage
    expect(cells([
      0,
      callStart(1),
    ], [
      10_000,
      progress(1, 250),
    ], [
      20_000,
      retry(1),
    ], [
      40_000,
      progress(1, 40),
    ], [
      70_000,
      answeredCall(1, 300),
    ])).toEqual([250, 40, 260])
    // a streamed estimate above the reported count takes nothing out
    expect(cells([
      0,
      callStart(1),
    ], [
      10_000,
      progress(1, 500),
    ], [
      70_000,
      answeredCall(1, 300),
    ])).toEqual([500, 0, 0])
    // a call that did not stream adds its whole usage at its end, as before
    expect(cells([
      0,
      callStart(1, false),
    ], [
      70_000,
      answeredCall(1, 300),
    ])).toEqual([0, 0, 300])
    // the spend and the usage are the replies' own, whatever the buckets hold
    const state = folded([
      0,
      started(['security']),
    ], [
      0,
      callStart(1),
    ], [
      10_000,
      progress(1, 500),
    ], [
      70_000,
      answeredCall(1, 300),
    ])
    expect(state.spent).toBe(301)
    expect(state.usage.get('api')).toMatchObject({ outputTokens: 300 })
  })

  it('keeps the longest first token and silence of each provider', () => {
    const other = { id: 'other', model: 'model' }
    const state = folded(
      [
        0,
        started(['security']),
      ],
      [
        1000,
        answeredCall(1, 10, { firstTokenMs: 2000, longestSilenceMs: 9000 }),
      ],
      [
        2000,
        answeredCall(2, 10, { firstTokenMs: 5000, longestSilenceMs: 4000 }),
      ],
      [
        3000,
        answeredCall(3, 10),
      ],
      [
        4000,
        answeredCall(4, 10, { firstTokenMs: 700, longestSilenceMs: 800 }, other),
      ],
    )
    expect([...state.timings]).toEqual([
      [
        'api',
        { firstTokenMs: 5000, longestSilenceMs: 9000 },
      ],
      [
        'other',
        { firstTokenMs: 700, longestSilenceMs: 800 },
      ],
    ])
    expect(replay(streamedReview()).timings.get('api')).toEqual({ firstTokenMs: 6000, longestSilenceMs: 6000 })
    expect(replay(longReview()).timings.size).toBe(0)
  })

  it('keeps the largest ceiling a provider\'s answered calls grew to', () => {
    const other = { id: 'other', model: 'model' }
    const state = folded(
      [
        0,
        started(['security']),
      ],
      [
        1000,
        answeredCall(1, 10, { firstTokenMs: 2000, longestSilenceMs: 9000, ceilingMs: 2_522_880 }),
      ],
      [
        2000,
        answeredCall(2, 10, { firstTokenMs: 5000, longestSilenceMs: 4000 }),
      ],
      [
        3000,
        answeredCall(3, 10, { firstTokenMs: 3000, longestSilenceMs: 1000, ceilingMs: 7_786_667 }),
      ],
      [
        4000,
        answeredCall(4, 10, { firstTokenMs: 3000, longestSilenceMs: 1000, ceilingMs: 1_000_000 }),
      ],
      [
        5000,
        answeredCall(5, 10, { firstTokenMs: 700, longestSilenceMs: 800 }, other),
      ],
    )
    expect([...state.timings]).toEqual([
      [
        'api',
        { firstTokenMs: 5000, longestSilenceMs: 9000, ceilingMs: 7_786_667 },
      ],
      [
        'other',
        { firstTokenMs: 700, longestSilenceMs: 800 },
      ],
    ])
    expect(state.timings.get('other')).not.toHaveProperty('ceilingMs')
  })

  it('keeps the interval of each profile in a stage, and reads the union of the ones that ended as the stage\'s time', () => {
    const stage = (at: number, profile: string, type: 'stage:start' | 'stage:end', name: 'research' | 'dedup' | 'panel'): [number, QuorumEvent] => [
      at,
      type === 'stage:start'
        ? { type, profile, stage: name }
        : {
            type,
            profile,
            stage: name,
            durationMs: 0,
            count: 0,
          },
    ]
    // Two profiles' research ends at 100 s and 1000 s, each then dedups for 50 ms and runs a panel of 60 s.
    const state = folded(
      [
        0,
        started(['security', 'style']),
      ],
      stage(0, 'security', 'stage:start', 'research'),
      stage(0, 'style', 'stage:start', 'research'),
      stage(100_000, 'security', 'stage:end', 'research'),
      stage(100_000, 'security', 'stage:start', 'dedup'),
      stage(100_050, 'security', 'stage:end', 'dedup'),
      stage(100_050, 'security', 'stage:start', 'panel'),
      stage(160_050, 'security', 'stage:end', 'panel'),
      stage(1_000_000, 'style', 'stage:end', 'research'),
      stage(1_000_000, 'style', 'stage:start', 'dedup'),
      stage(1_000_050, 'style', 'stage:end', 'dedup'),
      stage(1_000_050, 'style', 'stage:start', 'panel'),
      stage(1_060_050, 'style', 'stage:end', 'panel'),
    )
    expect(stageTime(state, 'research')).toBe(1_000_000)
    expect(stageTime(state, 'dedup')).toBe(100)
    expect(stageTime(state, 'panel')).toBe(120_000)
    expect(stageStart(state, 'panel')).toBe(100_050)
    expect(stageEnd(state, 'research')).toBe(1_000_000)
    // Overlapping and nested intervals count once, and a stage still running counts for nothing.
    const overlapping = folded(
      stage(0, 'a', 'stage:start', 'research'),
      stage(10, 'b', 'stage:start', 'research'),
      stage(40, 'c', 'stage:start', 'research'),
      stage(30, 'a', 'stage:end', 'research'),
      stage(50, 'b', 'stage:end', 'research'),
      stage(45, 'c', 'stage:end', 'research'),
      stage(60, 'd', 'stage:start', 'research'),
    )
    expect(stageTime(overlapping, 'research')).toBe(50)
    expect(stageTime(overlapping, 'panel')).toBeUndefined()
    expect(stageStart(overlapping, 'panel')).toBeUndefined()
    expect(stageEnd(overlapping, 'panel')).toBeUndefined()
  })

  it('counts the gaps by reason, and keeps each research-failed and provider-down cause once, in the order seen', () => {
    const state = replay(providerDown())
    expect([...state.gaps]).toEqual([
      [
        'research-failed',
        { parts: 3, votes: 0, other: 0 },
      ],
      [
        'provider-down',
        { parts: 3, votes: 0, other: 0 },
      ],
    ])
    expect([...state.causes]).toEqual([
      [
        'research-failed',
        [
          { kind: 'http', status: 503 },
        ],
      ],
      [
        'provider-down',
        [
          { kind: 'http', status: 503 },
        ],
      ],
    ])
    const more = fold(state, {
      type: 'provider-down',
      provider: 'other',
      kind: 'http',
      status: 429,
      calls: 1,
      exhausted: true,
    }, 1)
    expect(more.causes.get('provider-down')).toEqual([
      { kind: 'http', status: 503 },
      { kind: 'http', status: 429, exhausted: true },
    ])
    const again = fold(more, {
      type: 'provider-down',
      provider: 'third',
      kind: 'http',
      status: 503,
      calls: 3,
    }, 2)
    expect(again.causes.get('provider-down')).toHaveLength(2)
  })

  it('sums what the gap entries count over the profiles: research parts, votes, or neither', () => {
    const gap = (profile: string, reason: IncompleteReason, detail: string): [number, QuorumEvent] => [
      0,
      {
        type: 'incomplete',
        entry: { profile, reason, detail },
      },
    ]
    const quoted = JSON.stringify('src/"7 of 9 vote requests were not sent: ".js')
    const state = folded(
      gap('security', 'research-failed', '5 of 51 research parts failed: the research call failed (network)'),
      gap('style', 'research-failed', '2 of 40 research parts failed: the research call failed (network)'),
      gap('security', 'provider-down', '41 of 51 research parts were not sent, since their provider was down'),
      gap('security', 'request-too-large', '3 of 51 research requests were not sent: refused as too large'),
      gap('security', 'request-too-large', `${quoted}:12: 2 of 3 vote requests were not sent: refused as too large`),
      gap('security', 'vote-failed', `${quoted}:12 is kept at medium, but 2 failed vote(s) could have made it undecided`),
      gap('security', 'token-cap', 'the review\'s token cap of 2000000 tokens stopped 5 of its 6 research parts and 3 vote(s)'),
      gap('security', 'research-unusable', 'a detail'),
      gap('style', 'research-unusable', 'a detail'),
    )
    expect([...state.gaps]).toEqual([
      [
        'research-failed',
        { parts: 7, votes: 0, other: 0 },
      ],
      [
        'provider-down',
        { parts: 41, votes: 0, other: 0 },
      ],
      [
        'request-too-large',
        { parts: 3, votes: 2, other: 0 },
      ],
      [
        'vote-failed',
        { parts: 0, votes: 2, other: 0 },
      ],
      [
        'token-cap',
        { parts: 5, votes: 3, other: 0 },
      ],
      [
        'research-unusable',
        { parts: 0, votes: 0, other: 2 },
      ],
    ])
    // A file name that mimics the core's words counts for nothing: only what follows its JSON string is read.
    const file = 'x", but 8 failed vote(s) could have made it undecided'
    const hostile = folded(gap('security', 'vote-failed', `${JSON.stringify(file)}:1 is kept at low, but 9 failed vote(s) could have made it high`))
    expect([...hostile.gaps]).toEqual([
      [
        'vote-failed',
        { parts: 0, votes: 9, other: 0 },
      ],
    ])
  })

  it('reads the parts and votes a limit\'s gap says it stopped, as limitGaps writes them, and counts any other words as one gap', () => {
    const gap = (profile: string, reason: IncompleteReason, detail: string): [number, QuorumEvent] => [
      0,
      {
        type: 'incomplete',
        entry: { profile, reason, detail },
      },
    ]
    const counted = (reason: 'token-cap' | 'review-deadline' | 'interrupted', detail: string): unknown => [
      ...folded(gap('security', reason, detail)).gaps.values(),
    ]
    const cap = 'the review\'s token cap of 2000000 tokens stopped '
    const deadline = 'the review\'s deadline of 1800000 ms stopped '
    const interrupt = 'the interrupt stopped '
    expect(counted('token-cap', `${cap}its research`)).toEqual([
      { parts: 1, votes: 0, other: 0 },
    ])
    expect(counted('token-cap', `${cap}its research and 7 vote(s)`)).toEqual([
      { parts: 1, votes: 7, other: 0 },
    ])
    expect(counted('token-cap', `${cap}4 of its 6 research parts`)).toEqual([
      { parts: 4, votes: 0, other: 0 },
    ])
    expect(counted('token-cap', `${cap}7 vote(s)`)).toEqual([
      { parts: 0, votes: 7, other: 0 },
    ])
    expect(counted('review-deadline', `${deadline}5 of its 6 research parts and 2 vote(s)`)).toEqual([
      { parts: 5, votes: 2, other: 0 },
    ])
    expect(counted('review-deadline', `${deadline}its research`)).toEqual([
      { parts: 1, votes: 0, other: 0 },
    ])
    expect(counted('interrupted', `${interrupt}5 of its 6 research parts and 3 vote(s)`)).toEqual([
      { parts: 5, votes: 3, other: 0 },
    ])
    expect(counted('interrupted', `${interrupt}3 vote(s)`)).toEqual([
      { parts: 0, votes: 3, other: 0 },
    ])
    // Words that do not match are one gap, never a wrong number.
    expect(counted('interrupted', `${interrupt}5 of its 6 research parts and some`)).toEqual([
      { parts: 0, votes: 0, other: 1 },
    ])
    expect(counted('interrupted', 'the interrupt stopped 99999999999999999999 vote(s)')).toEqual([
      { parts: 0, votes: 0, other: 1 },
    ])
    expect(counted('token-cap', 'a detail')).toEqual([
      { parts: 0, votes: 0, other: 1 },
    ])
    expect(counted('interrupted', `an interrupt stopped 3 vote(s)`)).toEqual([
      { parts: 0, votes: 0, other: 1 },
    ])
    // A file name that mimics a limit's words, in a vote gap's detail, is read as that gap's own words only.
    const file = `${JSON.stringify('the interrupt stopped 9 vote(s)')}:1 is kept at low, but 2 failed vote(s) could have made it high`
    expect([
      ...folded(gap('security', 'vote-failed', file)).gaps,
    ]).toEqual([
      [
        'vote-failed',
        { parts: 0, votes: 2, other: 0 },
      ],
    ])
  })

  it('keeps the cut of a cause, and a cut and a failure that is none are two causes', () => {
    const cut = { kind: 'network', cutAfterMs: 600_000 } as const
    const part = (index: number, failure: { kind: 'network', cutAfterMs?: number }): QuorumEvent => ({
      type: 'part',
      profile: 'security',
      part: { index, count: 3 },
      outcome: 'research-failed',
      durationMs: 1,
      spent: 0,
      failure,
    })
    const state = [
      part(1, cut),
      part(2, { kind: 'network', cutAfterMs: 601_000 }),
      part(3, { kind: 'network' }),
      {
        type: 'provider-down',
        provider: 'api',
        kind: 'network',
        calls: 3,
        cutAfterMs: 600_000,
      } satisfies QuorumEvent,
    ].reduce((folded, event) => fold(folded, event, 1), startState(DEFAULT_FACTS))
    expect(state.causes.get('research-failed')).toEqual([
      cut,
      { kind: 'network' },
    ])
    expect(state.causes.get('provider-down')).toEqual([cut])
  })

  it('keeps the stall of a cause, and a stall and a plain timeout are two causes', () => {
    const stalled = { kind: 'timeout', stalledMs: 300_000 } as const
    const part = (index: number, failure: { kind: 'timeout', stalledMs?: number }): QuorumEvent => ({
      type: 'part',
      profile: 'security',
      part: { index, count: 3 },
      outcome: 'research-failed',
      durationMs: 1,
      spent: 0,
      failure,
    })
    const state = [
      part(1, stalled),
      part(2, { kind: 'timeout', stalledMs: 450_000 }),
      part(3, { kind: 'timeout' }),
      {
        type: 'provider-down',
        provider: 'api',
        kind: 'timeout',
        calls: 3,
        stalledMs: 300_000,
      } satisfies QuorumEvent,
    ].reduce((folded, event) => fold(folded, event, 1), startState(DEFAULT_FACTS))
    expect(state.causes.get('research-failed')).toEqual([
      stalled,
      { kind: 'timeout' },
    ])
    expect(state.causes.get('provider-down')).toEqual([stalled])
  })

  it('prefixes when several profiles run, and starts a fresh state at each run:start of one writer', () => {
    const two = replay(twoProfiles(), 0)
    expect(two.prefixed).toBe(true)
    expect([
      ...two.profiles.keys(),
    ]).toEqual(['security', 'style'])
    const alone = replay(longReview(), 0)
    expect(alone.prefixed).toBe(false)
    expect(alone.lenses.get('security')).toBe(3)

    const used = replay(twoProfiles())
    expect(used.spent).toBeGreaterThan(0)
    const next = fold(used, started(['security']), 9000)
    expect(next).toMatchObject({
      prefixed: false,
      startedAt: 9000,
      ended: false,
      spent: 0,
      facts: DEFAULT_FACTS,
    })
    expect([
      ...next.profiles.keys(),
    ]).toEqual(['security'])
    expect(next.calls.size).toBe(0)
    expect(next.sample.parts).toEqual([])
    expect(next.buckets.start).toBe(9000)
  })

  it('records the first time left at the part that passes the threshold', () => {
    let state = startState(DEFAULT_FACTS)
    let answered = 0
    const seen: Array<boolean> = []
    for (const { at, event } of longReview()) {
      state = fold(state, event, at)
      if (event.type !== 'part' || event.outcome !== 'reviewed' || event.spent === 0) continue
      answered += 1
      seen.push(state.firstEstimate !== undefined)
      if (answered === 5) break
    }
    expect(seen).toEqual([false, false, false, false, true])
    expect(state.firstEstimate).toMatchObject({ at: 310_000, lowMs: 1_455_000, highMs: 1_545_937.5 })
    const end = replay(longReview())
    expect(end.firstEstimate).toEqual(state.firstEstimate)
  })

  it('records which part made the first estimate', () => {
    // The part that is the fifth to answer is not part 5: four calls run at once, so the key is read from the event itself.
    let state = startState(DEFAULT_FACTS)
    let by: string | undefined
    for (const { at, event } of longReview()) {
      const before = state.firstEstimate
      state = fold(state, event, at)
      if (before !== undefined || state.firstEstimate === undefined) continue
      expect(event.type).toBe('part')
      by = event.type === 'part'
        ? `${event.profile}|${event.part.index}`
        : undefined
      expect(state.firstEstimate.by).toBe(by)
    }
    expect(by).toMatch(/^security\|\d+$/)
    expect(state.partsEnded.has(by!)).toBe(true)
    // It stays what it was as the review goes on.
    expect(state.firstEstimate?.by).toBe(by)
    // Two profiles pool their parts: the third answered part, the second of `naming`, makes it.
    const pooled = replay(slowResearch(300_000), Infinity, { ...DEFAULT_FACTS, concurrency: 1 })
    expect(pooled.firstEstimate).toMatchObject({ at: 900_000, by: 'naming|2' })
  })

  it('returns the state as it was for an event of a type it does not know', () => {
    const state = replay(longReview(), 600_000)
    const unknown = {
      type: 'call:progress',
      call: 1,
      outputTokens: 10,
      signal: 'tokens',
    } as unknown as QuorumEvent
    expect(fold(state, unknown, 600_001)).toBe(state)
    const left: QuorumEvent = { type: 'left-out', files: [] }
    expect(fold(state, left, 600_001)).toBe(state)
  })
})
