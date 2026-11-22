import { describe, expect, it } from 'vitest'
import type { IncompleteReason, QuorumEvent } from '../../core/types.ts'
import { longReview, providerDown, replay, twoProfiles } from '../../testing/events.ts'
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
    expect(state.firstEstimate).toEqual({ at: 310_000, lowMs: 1_455_000, highMs: 1_545_937.5 })
    const end = replay(longReview())
    expect(end.firstEstimate).toEqual(state.firstEstimate)
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
