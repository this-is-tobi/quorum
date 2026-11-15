import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createLedger, fitOf, isLimit, LimitError, limitGaps, maxReviewTokensProblem, settlementOf } from './limits.ts'
import type { Fit, SettledFailure } from './limits.ts'
import type { Usage, Verdict, VoteFailure } from './types.ts'

/** One turn of the event loop's macrotask queue: every microtask queued so far has run. */
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const NO_ROOM = 'the review\'s token cap of 100 tokens leaves no room for this call'

describe('the token cap\'s plain rules', () => {
  it.each<[{ settled: number, reserved: number, tokens: number }, Fit]>([
    [
      { settled: 0, reserved: 0, tokens: 100 },
      'fits',
    ],
    [
      { settled: 0, reserved: 0, tokens: 101 },
      'refused',
    ],
    [
      { settled: 50, reserved: 0, tokens: 51 },
      'refused',
    ],
    [
      { settled: 20, reserved: 60, tokens: 30 },
      'waits',
    ],
    [
      { settled: 20, reserved: 60, tokens: 20 },
      'fits',
    ],
  ])('fits %j', ({ settled, reserved, tokens }, fit) => {
    expect(fitOf({ cap: 100, settled, reserved }, tokens)).toBe(fit)
  })

  it.each<[string, Usage | undefined, SettledFailure | undefined, number]>([
    [
      'a reply\'s usage',
      { inputTokens: 7, outputTokens: 3 },
      undefined,
      10,
    ],
    [
      'a usage beside an http 400',
      { inputTokens: 50, outputTokens: 40 },
      { kind: 'http', status: 400 },
      90,
    ],
    [
      'no usage and no failure',
      undefined,
      undefined,
      60,
    ],
    [
      'an http 400',
      undefined,
      { kind: 'http', status: 400 },
      0,
    ],
    [
      'an http 499',
      undefined,
      { kind: 'http', status: 499 },
      0,
    ],
    [
      'an http 408',
      undefined,
      { kind: 'http', status: 408 },
      60,
    ],
    [
      'an http 503',
      undefined,
      { kind: 'http', status: 503 },
      60,
    ],
    [
      'an http status that is a string',
      undefined,
      { kind: 'http', status: '400' },
      60,
    ],
    [
      'a status of no kind',
      undefined,
      { kind: undefined, status: 400 },
      60,
    ],
    [
      'a refusal as too large',
      undefined,
      { kind: 'too-large', status: undefined },
      0,
    ],
    [
      'a network failure',
      undefined,
      { kind: 'network', status: undefined },
      60,
    ],
  ])('settles %s', (_name, usage, failure, settled) => {
    expect(settlementOf(60, usage, failure)).toBe(settled)
  })

  it('words the cap\'s problem', () => {
    const problem = 'must be a whole number of tokens from 1 to 9007199254740991'
    expect(maxReviewTokensProblem(1)).toBeUndefined()
    expect(maxReviewTokensProblem(Number.MAX_SAFE_INTEGER)).toBeUndefined()
    for (const value of [
      0,
      1.5,
      Number.MAX_SAFE_INTEGER + 2,
      '5',
      undefined,
    ]) {
      expect(maxReviewTokensProblem(value)).toBe(problem)
    }
  })
})

describe('the ledger', () => {
  const { signal } = new AbortController()

  it('reserves what fits at once, and refuses what never can with the cap\'s own failure', async () => {
    const ledger = createLedger(100)
    await ledger.reserve(60, signal)
    let state: unknown = 'waiting'
    const waiter = ledger.reserve(41, signal).then(() => {
      state = 'admitted'
    }, (error: unknown) => {
      state = error
    })
    await turn()
    expect(state).toBe('waiting')
    ledger.settle(60, 70)
    await waiter
    expect(state).toBeInstanceOf(LimitError)
    expect(isLimit(state)).toBe(true)
    expect(state).toMatchObject({ limit: 'token-cap', message: NO_ROOM })
    await expect(ledger.reserve(31, signal)).rejects.toMatchObject({ limit: 'token-cap', message: NO_ROOM })
    await expect(ledger.reserve(30, signal)).resolves.toBeUndefined()
  })

  it('admits waiters in the order they began to wait, a newcomer behind them', async () => {
    const ledger = createLedger(100)
    const order: number[] = []
    await ledger.reserve(90, signal)
    const big = ledger.reserve(80, signal).then(() => order.push(80))
    const small = ledger.reserve(5, signal).then(() => order.push(5))
    await turn()
    expect(order).toEqual([])
    ledger.settle(90, 1)
    await Promise.all([big, small])
    expect(order).toEqual([80, 5])
  })

  it('ends a wait on its stop with the stop\'s reason, removes its listener, and admits the next waiter', async () => {
    const ledger = createLedger(100)
    await ledger.reserve(90, signal)
    const reason = new Error('stop')
    const first = new AbortController()
    const second = new AbortController()
    const stopped = ledger.reserve(80, first.signal).catch((error: unknown) => error)
    let admitted = false
    const next = ledger.reserve(5, second.signal).then(() => {
      admitted = true
    })
    await turn()
    expect(admitted).toBe(false)
    expect(getEventListeners(first.signal, 'abort')).toHaveLength(1)
    expect(getEventListeners(second.signal, 'abort')).toHaveLength(1)
    first.abort(reason)
    expect(await stopped).toBe(reason)
    await next
    expect(admitted).toBe(true)
    expect(getEventListeners(first.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(second.signal, 'abort')).toHaveLength(0)
    const early = new Error('already stopped')
    await expect(ledger.reserve(1, AbortSignal.abort(early))).rejects.toBe(early)
  })
})

describe('the gaps of a limit', () => {
  /** A verdict whose votes failed with each of `kinds`, a `null` entry being a cast vote. */
  const voted = (...kinds: Array<VoteFailure['kind'] | null>): Verdict => ({
    votes: kinds.map((kind, index) => kind === null
      ? {
          angle: `lens${index}`,
          vote: { keep: true, reasoning: 'r' },
          error: null,
          failure: null,
        }
      : {
          angle: `lens${index}`,
          vote: null,
          error: 'failed',
          failure: { kind },
        }),
  }) as unknown as Verdict

  it('records one gap per limit for the profile, counting its research and its votes', () => {
    const verdicts = [
      voted('token-cap', null, 'token-cap'),
      voted('network', 'token-cap'),
    ]
    expect(limitGaps('security', 'token-cap', [], { cap: 100 })).toEqual([
      { profile: 'security', reason: 'token-cap', detail: 'the review\'s token cap of 100 tokens stopped its research' },
    ])
    expect(limitGaps('security', undefined, verdicts, { cap: 100 })).toEqual([
      { profile: 'security', reason: 'token-cap', detail: 'the review\'s token cap of 100 tokens stopped 3 vote(s)' },
    ])
    expect(limitGaps('security', 'token-cap', verdicts, { cap: 100 })).toEqual([
      { profile: 'security', reason: 'token-cap', detail: 'the review\'s token cap of 100 tokens stopped its research and 3 vote(s)' },
    ])
    expect(limitGaps('security', undefined, [
      voted('network', null),
    ], { cap: 100 })).toEqual([])
    expect(limitGaps('security', undefined, [], { cap: 100 })).toEqual([])
  })
})
