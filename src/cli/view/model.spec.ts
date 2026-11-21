import { describe, expect, it } from 'vitest'
import type { QuorumEvent } from '../../core/types.ts'
import { longReview, providerDown, replay, twoProfiles } from '../../testing/events.ts'
import { BUCKET_MS, BUCKETS, DEFAULT_FACTS, fold, startState } from './model.ts'
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

  it('counts the gaps by reason, and keeps each research-failed and provider-down cause once, in the order seen', () => {
    const state = replay(providerDown())
    expect([...state.gaps]).toEqual([
      ['research-failed', 3],
      ['provider-down', 3],
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
