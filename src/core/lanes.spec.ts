import { describe, expect, it } from 'vitest'
import { fakeClock } from '../testing/clock.ts'
import type { FakeClock } from '../testing/clock.ts'
import { createLanes, LANE_START, REVIEW_CEILING, throttleOf } from './lanes.ts'
import type { LaneAttempt, LaneCall, Lanes, LaneTarget } from './lanes.ts'
import type { RateLimit } from './ports.ts'
import type { CallFailure, QuorumEvent } from './types.ts'

type End = Parameters<LaneAttempt['ended']>[0]
type Count = Parameters<LaneCall['sent']>[0]

/** What an attempt is counted as: a reply budget of 16000 and a reservation that holds it. */
const COUNT = { reservation: 20_000, expected: 5_000, replyTokens: 16_000 }
/** Headers of a server that counts a request as it arrives and has room for many calls: 100000 of a window of 1000000 are used. */
const HOLDING: RateLimit = { requests: 1000, tokens: 900_000, tokensLimit: 1_000_000 }
const TOO_MANY: CallFailure = { kind: 'http', status: 429 }

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function target(id: string, slots?: number): LaneTarget {
  return {
    provider: { id },
    ref: { id, model: `${id}-model` },
    slots,
  }
}

interface Harness {
  readonly clock: FakeClock
  readonly events: QuorumEvent[]
  readonly lanes: Lanes
}

function harness(concurrency?: number): Harness {
  const clock = fakeClock()
  const events: QuorumEvent[] = []
  const lanes = createLanes({
    ...concurrency === undefined
      ? {}
      : { concurrency },
    clock,
    emit: event => events.push(event),
  })
  return { clock, events, lanes }
}

const alpha = target('alpha')
const beta = target('beta')
const never = new AbortController().signal

/** A call that sends one attempt and ends it at once: the headers of a whole reply, and of a failure, come with its end. */
function answered(lanes: Lanes, on: LaneTarget, end: End = { answered: true }, count: Count = COUNT): Promise<void> {
  return lanes.run(on, never, (call) => {
    call.sent(count).ended(end)
    return Promise.resolve()
  })
}

interface Flight {
  readonly done: Promise<void>
  /** Whether the call's task has begun: it holds both slots. */
  running: boolean
  /** Ends the attempt, at its answer unless told otherwise. */
  readonly finish: (end?: End) => void
}

/** A call that sends one attempt, which a stream's headers have reached when `headers` is given, and holds it in flight until `finish`. */
function hold(lanes: Lanes, on: LaneTarget, options: { readonly count?: Count, readonly stop?: AbortSignal, readonly headers?: RateLimit } = {}): Flight {
  let release: (end: End) => void = () => {}
  const gate = new Promise<End>((resolve) => {
    release = resolve
  })
  const flight: { running: boolean, done: Promise<void>, finish: Flight['finish'] } = {
    running: false,
    done: Promise.resolve(),
    finish: (end: End = { answered: true }) => release(end),
  }
  flight.done = lanes.run(on, options.stop ?? never, async (call) => {
    flight.running = true
    const attempt = call.sent(options.count ?? COUNT)
    if (options.headers !== undefined) attempt.headers(options.headers)
    attempt.ended(await gate)
  })
  return flight
}

/** A call whose stream's headers reach the lane as the request is accepted, before its body, and whose reply then ends answered. */
async function streamed(lanes: Lanes, on: LaneTarget, headers: RateLimit, count: Count = COUNT): Promise<void> {
  const flight = hold(lanes, on, { count, headers })
  await tick()
  flight.finish()
  await flight.done
}

const running = (flights: readonly Flight[]): number => flights.filter(flight => flight.running).length

/** Ends every flight that runs, round after round, until all have ended; returns the most that ran together in a round. */
async function drain(flights: readonly Flight[], end: End = { answered: true }): Promise<number> {
  let peak = 0
  const ended = new Set<Flight>()
  while (ended.size < flights.length) {
    await tick()
    const now = flights.filter(flight => flight.running && !ended.has(flight))
    if (now.length === 0) throw new Error('drain: no call runs and some still wait')
    peak = Math.max(peak, now.length)
    for (const flight of now) {
      flight.finish(end)
      ended.add(flight)
    }
  }
  await Promise.all(flights.map(flight => flight.done))
  return peak
}

const lane = (events: readonly QuorumEvent[]): Array<Extract<QuorumEvent, { type: 'concurrency' }>> => events.filter(event => event.type === 'concurrency')
const changes = (events: readonly QuorumEvent[]): Array<[number, string]> => lane(events).map(event => [event.limit, event.cause])

describe('createLanes', () => {
  it('starts a lane at 4 and never grows it without rate-limit headers', async () => {
    const { lanes, events } = harness()
    expect(LANE_START).toBe(4)
    expect(REVIEW_CEILING).toBe(16)
    const flights = Array.from({ length: 6 }, () => hold(lanes, alpha))
    await tick()
    expect(running(flights)).toBe(4)
    await drain(flights)
    for (let index = 0; index < 60; index++) await answered(lanes, alpha)
    const more = Array.from({ length: 8 }, () => hold(lanes, alpha))
    await tick()
    expect(running(more)).toBe(4)
    await drain(more)
    expect(events).toEqual([])
    expect(lanes.record()).toEqual({
      alpha: {
        limit: 'auto',
        start: 4,
        lowest: 4,
        highest: 4,
        cuts: 0,
        headers: false,
      },
    })
  })

  it('grows a lane by one after a window of clean answers while the headers hold one more call, up to 16', async () => {
    const { lanes, events } = harness()
    const clean = (): Promise<void> => answered(lanes, alpha, { answered: true, rateLimit: HOLDING })
    // The window is the lane's limit: 4 answers, then 5, then 6.
    for (let index = 0; index < 3; index++) await clean()
    expect(events).toEqual([])
    await clean()
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 5,
        cause: 'grown',
      },
    ])
    for (let index = 0; index < 4; index++) await clean()
    expect(lane(events)).toHaveLength(1)
    await clean()
    expect(changes(events)).toEqual([
      [5, 'grown'],
      [6, 'grown'],
    ])
    for (let index = 0; index < 200; index++) await clean()
    expect(changes(events).map(([limit]) => limit)).toEqual([
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
    ])
    expect(lanes.record()).toEqual({
      alpha: {
        limit: 'auto',
        start: 4,
        lowest: 4,
        highest: 16,
        cuts: 0,
        headers: true,
      },
    })
  })

  it('does not grow a lane while the headers hold no room for one more call', async () => {
    const { lanes, events } = harness()
    const noRequest: RateLimit = { requests: 0, tokens: 900_000, tokensLimit: 1_000_000 }
    const fewTokens: RateLimit = { requests: 1000, tokens: 10_000, tokensLimit: 1_000_000 }
    // With no reset sent, neither header paces the lane either: the calls go on, and the lane stays.
    for (const rateLimit of [noRequest, fewTokens]) {
      for (let index = 0; index < 30; index++) await answered(lanes, alpha, { answered: true, rateLimit })
    }
    expect(events).toEqual([])
    expect(lanes.record().alpha).toMatchObject({ highest: 4, headers: true })
  })

  it('halves a lane on a throttle signal, at least 1, once per window', async () => {
    const { lanes, events } = harness()
    const old = Array.from({ length: 4 }, () => hold(lanes, alpha))
    await tick()
    expect(running(old)).toBe(4)
    old[0].finish({ answered: false, failure: TOO_MANY })
    await tick()
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 2,
        cause: 'cut',
        from: 4,
        failure: TOO_MANY,
      },
    ])
    // A 429 from an attempt sent before the cut cuts nothing more.
    old[1].finish({ answered: false, failure: TOO_MANY })
    await tick()
    expect(lane(events)).toHaveLength(1)
    // Two calls are still in flight at a limit of 2: a new call waits for one of them.
    const next = hold(lanes, alpha)
    await tick()
    expect(next.running).toBe(false)
    old[2].finish()
    await tick()
    expect(next.running).toBe(true)
    // An attempt sent after the cut cuts again.
    next.finish({
      answered: false,
      failure: { kind: 'http', status: 503 },
    })
    await tick()
    expect(changes(events)).toEqual([
      [2, 'cut'],
      [1, 'cut'],
    ])
    old[3].finish()
    // A lane of 1 is cut to nothing less, and says nothing.
    const alone = hold(lanes, alpha)
    await tick()
    alone.finish({
      answered: false,
      failure: { kind: 'timeout' },
    })
    await tick()
    expect(lane(events)).toHaveLength(2)
    expect(lanes.record()).toEqual({
      alpha: {
        limit: 'auto',
        start: 4,
        lowest: 1,
        highest: 4,
        cuts: 2,
        headers: false,
      },
    })
  })

  it.each<[string, CallFailure]>([
    [
      'an http 429',
      { kind: 'http', status: 429 },
    ],
    [
      'an http 503',
      { kind: 'http', status: 503 },
    ],
    [
      'an http 504',
      { kind: 'http', status: 504 },
    ],
    [
      'an http 524',
      { kind: 'http', status: 524 },
    ],
    [
      'an http 529',
      { kind: 'http', status: 529 },
    ],
    [
      'a timeout',
      { kind: 'timeout' },
    ],
    [
      'a stall',
      { kind: 'timeout', stalledMs: 300_000 },
    ],
  ])('reads %s as a throttle signal', (_name, failure) => {
    expect(throttleOf(failure)).toBe(true)
  })

  it.each<[string, CallFailure | undefined]>([
    [
      'an exhausted 429',
      { kind: 'http', status: 429, exhausted: true },
    ],
    [
      'an http 500',
      { kind: 'http', status: 500 },
    ],
    [
      'an http 400',
      { kind: 'http', status: 400 },
    ],
    [
      'an http failure with no status',
      { kind: 'http' },
    ],
    [
      'a network cut',
      { kind: 'network' },
    ],
    [
      'a truncated reply',
      { kind: 'truncated' },
    ],
    ['no failure', undefined],
  ])('does not read %s as one', (_name, failure) => {
    expect(throttleOf(failure)).toBe(false)
  })

  it('hands the slots a cut leaves to the waiting calls in the order they came, and a late call waits behind them', async () => {
    const { lanes } = harness()
    const flying = Array.from({ length: 4 }, () => hold(lanes, alpha))
    const waiting = Array.from({ length: 3 }, () => hold(lanes, alpha))
    await tick()
    expect(running(waiting)).toBe(0)
    // The cut halves the limit to 2 while 3 calls are still in flight: no slot is free.
    flying[0].finish({ answered: false, failure: TOO_MANY })
    await tick()
    const late = hold(lanes, alpha)
    flying[1].finish()
    await tick()
    expect(running([...waiting, late])).toBe(0)
    // One slot is free once a third call ends, and the first to wait takes it.
    flying[2].finish()
    await tick()
    expect(waiting.map(flight => flight.running)).toEqual([true, false, false])
    flying[3].finish()
    await tick()
    expect(waiting.map(flight => flight.running)).toEqual([true, true, false])
    expect(late.running).toBe(false)
    waiting[0].finish()
    await tick()
    expect(waiting[2].running).toBe(true)
    expect(late.running).toBe(false)
    waiting[1].finish()
    await tick()
    expect(late.running).toBe(true)
    waiting[2].finish()
    late.finish()
    await Promise.all([
      ...flying,
      ...waiting,
      late,
    ].map(flight => flight.done))
  })

  it('regrows a lane cut below its start with no headers, back to its start', async () => {
    const { lanes, events } = harness()
    await answered(lanes, alpha, { answered: false, failure: TOO_MANY })
    expect(changes(events)).toEqual([
      [2, 'cut'],
    ])
    // The window is the limit: 2 clean answers, then 3.
    await answered(lanes, alpha)
    expect(lane(events)).toHaveLength(1)
    await answered(lanes, alpha)
    expect(changes(events)).toEqual([
      [2, 'cut'],
      [3, 'regrown'],
    ])
    for (let index = 0; index < 3; index++) await answered(lanes, alpha)
    expect(changes(events)).toEqual([
      [2, 'cut'],
      [3, 'regrown'],
      [4, 'regrown'],
    ])
    for (let index = 0; index < 30; index++) await answered(lanes, alpha)
    expect(lane(events)).toHaveLength(3)
    expect(lanes.record().alpha).toMatchObject({
      limit: 'auto',
      lowest: 2,
      highest: 4,
      cuts: 1,
      headers: false,
    })
  })

  it('pauses a lane\'s new calls for a Retry-After, at most 60 s, its calls in flight going on and its waiting calls holding no ceiling slot', async () => {
    const { lanes, events, clock } = harness()
    const crowd = [
      ...['b', 'c', 'd'].flatMap(id => Array.from({ length: 4 }, () => hold(lanes, target(id)))),
      ...Array.from({ length: 2 }, () => hold(lanes, target('e'))),
    ]
    const going = hold(lanes, alpha)
    const throttled = hold(lanes, alpha)
    await tick()
    // 14 calls of other lanes and 2 of this one: the ceiling is full.
    expect(running([...crowd, going, throttled])).toBe(REVIEW_CEILING)
    throttled.finish({ answered: false, failure: TOO_MANY, retryAfterMs: 14_000 })
    await tick()
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 2,
        cause: 'cut',
        from: 4,
        failure: TOO_MANY,
      },
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 2,
        cause: 'paused',
        waitMs: 14_000,
        failure: TOO_MANY,
      },
    ])
    // A new call of the lane waits for the pause, and holds no slot of the ceiling meanwhile: the call that follows takes the free one.
    const waiting = hold(lanes, alpha)
    const sibling = hold(lanes, target('e'))
    await tick()
    expect(waiting.running).toBe(false)
    expect(sibling.running).toBe(true)
    // The pause passes, and the call waits for the ceiling, which the call in flight holds a slot of, and which is going on.
    clock.fireNext()
    expect(clock.now()).toBe(14_000)
    await tick()
    expect(waiting.running).toBe(false)
    going.finish()
    await tick()
    expect(waiting.running).toBe(true)
    await drain([...crowd, sibling, waiting])
    await going.done
  })

  it.each([
    ['300 s', 300_000],
    ['an enormous number of ms', 1e300],
  ])('pauses at most 60 s for a Retry-After of %s', async (_name, retryAfterMs) => {
    const { lanes, events, clock } = harness()
    await answered(lanes, alpha, {
      answered: false,
      failure: { kind: 'http', status: 503 },
      retryAfterMs,
    })
    expect(lane(events).at(-1)).toMatchObject({ cause: 'paused', waitMs: 60_000 })
    const waiting = hold(lanes, alpha)
    await tick()
    expect(waiting.running).toBe(false)
    clock.fireNext()
    expect(clock.now()).toBe(60_000)
    await tick()
    expect(waiting.running).toBe(true)
    await drain([waiting])
  })

  it('pauses for the Retry-After of a throttle from an attempt sent before the cut, which cuts nothing', async () => {
    const { lanes, events } = harness()
    const old = Array.from({ length: 2 }, () => hold(lanes, alpha))
    await tick()
    old[0].finish({ answered: false, failure: TOO_MANY })
    await tick()
    old[1].finish({ answered: false, failure: TOO_MANY, retryAfterMs: 3000 })
    await tick()
    expect(lane(events).map(event => event.cause)).toEqual(['cut', 'paused'])
  })

  it('paces a call until the requests\' reset while no request is left, at most 60 s, then starts it', async () => {
    const { lanes, events, clock } = harness()
    await answered(lanes, alpha, {
      answered: true,
      rateLimit: { ...HOLDING, requests: 0, requestsResetMs: 8000 },
    })
    const next = hold(lanes, alpha)
    await tick()
    expect(next.running).toBe(false)
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 4,
        cause: 'paced',
        waitMs: 8000,
      },
    ])
    clock.fireNext()
    expect(clock.now()).toBe(8000)
    await tick()
    expect(next.running).toBe(true)
    await drain([next])
    // The reset has passed: the next call goes at once.
    const after = hold(lanes, alpha)
    await tick()
    expect(after.running).toBe(true)
    await drain([after])
  })

  it.each([
    ['90 s', 90_000],
    ['a number of ms that is no safe integer', 1e300],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER],
  ])('paces at most 60 s for a reset of %s', async (_name, requestsResetMs) => {
    const { lanes, events, clock } = harness()
    await answered(lanes, alpha, {
      answered: true,
      rateLimit: { ...HOLDING, requests: 0, requestsResetMs },
    })
    const next = hold(lanes, alpha)
    await tick()
    expect(next.running).toBe(false)
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 4,
        cause: 'paced',
        waitMs: 60_000,
      },
    ])
    clock.fireNext()
    expect(clock.now()).toBe(60_000)
    await tick()
    expect(next.running).toBe(true)
    await drain([next])
  })

  it('says one pacing wait once for two calls that wait on one reset, at fractional times', async () => {
    const { lanes, events, clock } = harness()
    // Times that make `now + (due - now)` differ from `due` by a rounding.
    clock.timer(0.1, () => {})
    clock.fireNext()
    await answered(lanes, alpha, {
      answered: true,
      rateLimit: { requests: 0, requestsResetMs: 1000 },
    })
    const first = hold(lanes, alpha)
    await tick()
    clock.timer(7.9043, () => {})
    clock.fireNext()
    const second = hold(lanes, alpha)
    await tick()
    expect(first.running || second.running).toBe(false)
    expect(lane(events).filter(event => event.cause === 'paced')).toHaveLength(1)
    clock.fireNext()
    clock.fireNext()
    await tick()
    await drain([first, second])
  })

  it('starts a call at once when the reset says now, and when none is sent', async () => {
    const { lanes, events } = harness()
    await answered(lanes, alpha, {
      answered: true,
      rateLimit: { ...HOLDING, requests: 0, requestsResetMs: 0 },
    })
    const now = hold(lanes, alpha)
    await tick()
    expect(now.running).toBe(true)
    await drain([now])
    await answered(lanes, beta, {
      answered: true,
      rateLimit: { ...HOLDING, requests: 0 },
    })
    const none = hold(lanes, beta)
    await tick()
    expect(none.running).toBe(true)
    await drain([none])
    expect(events).toEqual([])
  })

  it('counts the calls sent since the headers against the requests left, as they enter the lane', async () => {
    const { lanes, events, clock } = harness()
    await answered(lanes, alpha, {
      answered: true,
      rateLimit: { ...HOLDING, requests: 2, requestsResetMs: 5000 },
    })
    const burst = Array.from({ length: 3 }, () => hold(lanes, alpha))
    await tick()
    expect(running(burst)).toBe(2)
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 4,
        cause: 'paced',
        waitMs: 5000,
      },
    ])
    clock.fireNext()
    await tick()
    expect(running(burst)).toBe(3)
    await drain(burst)
  })

  it('paces a call after a throttle whose headers say no request is left', async () => {
    const { lanes, events } = harness()
    await answered(lanes, alpha, {
      answered: false,
      failure: TOO_MANY,
      rateLimit: { requests: 0, requestsResetMs: 7000 },
    })
    const next = hold(lanes, alpha)
    await tick()
    expect(next.running).toBe(false)
    expect(lane(events).map(event => event.cause)).toEqual(['cut', 'paced'])
  })

  it('waits for the requests\' reset when tokens run short and no token reset is sent', async () => {
    const { lanes, events, clock } = harness()
    await answered(lanes, alpha, {
      answered: true,
      rateLimit: {
        requests: 1000,
        tokens: 5000,
        tokensLimit: 1_000_000,
        requestsResetMs: 5000,
      },
    })
    const next = hold(lanes, alpha)
    await tick()
    expect(next.running).toBe(false)
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 4,
        cause: 'paced',
        waitMs: 5000,
      },
    ])
    clock.fireNext()
    expect(clock.now()).toBe(5000)
    await tick()
    expect(next.running).toBe(true)
    await drain([next])
  })

  it.each([
    ['a token reset is sent', 2000, 2000],
    ['the token reset says now', 0, 0],
  ])('waits for the tokens\' reset, not the requests\', when %s', async (_name, tokensResetMs, waited) => {
    const { lanes, events, clock } = harness()
    await answered(lanes, alpha, {
      answered: true,
      rateLimit: {
        requests: 1000,
        tokens: 5000,
        tokensLimit: 1_000_000,
        requestsResetMs: 5000,
        tokensResetMs,
      },
    })
    const next = hold(lanes, alpha)
    await tick()
    if (waited === 0) {
      expect(next.running).toBe(true)
      expect(events).toEqual([])
    } else {
      expect(next.running).toBe(false)
      expect(lane(events)).toEqual([
        {
          type: 'concurrency',
          provider: alpha.ref,
          limit: 4,
          cause: 'paced',
          waitMs: waited,
        },
      ])
      clock.fireNext()
      expect(clock.now()).toBe(waited)
      await tick()
      expect(next.running).toBe(true)
    }
    await drain([next])
  })

  it('counts the calls in flight at their expected use on a server that counts replies as they end, and grows past what reservations allow', async () => {
    const { lanes, events } = harness()
    // A server that counts the tokens of a reply once it ends states its whole window left while calls are in flight.
    const ending: RateLimit = {
      requests: 1000,
      tokens: 1_000_000,
      tokensLimit: 1_000_000,
      tokensResetMs: 60_000,
    }
    const count = { reservation: 200_000, expected: 20_834, replyTokens: 150_000 }
    // The first stream starts with 1000000 left at a request budget of 150000: it counted nothing of it yet, so the lane counts expected use.
    await streamed(lanes, alpha, ending, count)
    let peak = 0
    for (let round = 0; round < 12; round++) {
      const flights = Array.from({ length: REVIEW_CEILING }, () => hold(lanes, alpha, { count, headers: ending }))
      peak = await drain(flights, { answered: true, rateLimit: ending })
    }
    // At reservations of 200000 the window holds 5 calls; at their expected use it holds all 16.
    expect(Math.floor(1_000_000 / count.reservation)).toBe(5)
    expect(peak).toBe(REVIEW_CEILING)
    expect(lane(events).every(event => event.cause === 'grown')).toBe(true)
    expect(lanes.record().alpha).toMatchObject({ highest: 16, cuts: 0, headers: true })
  })

  it('counts calls at their reservation until the headers tell the two kinds of server apart', async () => {
    const { lanes, events, clock } = harness()
    const count = { reservation: 300_000, expected: 54_096, replyTokens: 150_000 }
    // No headers yet: nothing paces the lane.
    const first = Array.from({ length: 4 }, () => hold(lanes, alpha, { count }))
    await tick()
    expect(running(first)).toBe(4)
    // They end with a failure that is no throttle, so no window of clean answers is begun.
    await drain(first, {
      answered: false,
      failure: { kind: 'http', status: 500 },
    })
    // A server that counts a request as it arrives: 200000 of its window are used, over the reply budget of 150000.
    const arriving: RateLimit = {
      requests: 1000,
      tokens: 800_000,
      tokensLimit: 1_000_000,
      tokensResetMs: 1000,
    }
    await streamed(lanes, alpha, arriving, count)
    const burst = Array.from({ length: 4 }, () => hold(lanes, alpha, { count }))
    await tick()
    // Two calls at their reservation of 300000 hold 600000 of the 800000 left, and a third would not fit.
    expect(running(burst)).toBe(2)
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 4,
        cause: 'paced',
        waitMs: 1000,
      },
    ])
    clock.fireNext()
    clock.fireNext()
    await tick()
    expect(running(burst)).toBe(4)
    await drain(burst)
    // A server that counts a reply as it ends states its whole window left as a stream starts: the same four calls run at once, at their expected use.
    await streamed(lanes, beta, {
      requests: 1000,
      tokens: 1_000_000,
      tokensLimit: 1_000_000,
      tokensResetMs: 1000,
    }, count)
    const ending = Array.from({ length: 4 }, () => hold(lanes, beta, { count }))
    await tick()
    expect(running(ending)).toBe(4)
    expect(lane(events)).toHaveLength(1)
    await drain(ending)
  })

  it('keeps counting at arrival when the reply is of a request that carried no reply budget, whatever the tokens it shows used', async () => {
    const { lanes, events, clock } = harness()
    // A reply that shows 10000 of 1000000 tokens used: under the budget of a request that carried one, 150000, a server that counts a reply as it ends.
    const fewUsed: RateLimit = {
      requests: 1000,
      tokens: 990_000,
      tokensLimit: 1_000_000,
      tokensResetMs: 1000,
    }
    const bare = { reservation: 300_000, expected: 54_096 }
    const budgeted = { ...bare, replyTokens: 150_000 }
    await streamed(lanes, alpha, fewUsed, bare)
    const burst = Array.from({ length: 4 }, () => hold(lanes, alpha, { count: bare }))
    await tick()
    // At reservations of 300000 three calls fit the 990000 left, and the fourth waits for the reset: the lane never switched.
    expect(running(burst)).toBe(3)
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: alpha.ref,
        limit: 4,
        cause: 'paced',
        waitMs: 1000,
      },
    ])
    clock.fireNext()
    await tick()
    await drain(burst)
    // The same headers of a request that carried a budget switch its lane to expected use: all four run.
    await streamed(lanes, beta, fewUsed, budgeted)
    const counted = Array.from({ length: 4 }, () => hold(lanes, beta, { count: budgeted }))
    await tick()
    expect(running(counted)).toBe(4)
    await drain(counted)
  })

  it('grows a lane on the headers of a stream, read when they arrive, and on a reply\'s at its end', async () => {
    const { lanes, events } = harness()
    const clean = async (): Promise<void> => {
      const flight = hold(lanes, alpha, { headers: HOLDING })
      await tick()
      flight.finish({ answered: true, rateLimit: HOLDING })
      await flight.done
    }
    for (let index = 0; index < 4; index++) await clean()
    expect(changes(events)).toEqual([
      [5, 'grown'],
    ])
  })

  it('holds a lane at a provider\'s stated slots, and says so once', async () => {
    const { lanes, events } = harness()
    const local = target('local', 2)
    const flights = Array.from({ length: 5 }, () => hold(lanes, local))
    await tick()
    expect(running(flights)).toBe(2)
    expect(lane(events)).toEqual([
      {
        type: 'concurrency',
        provider: local.ref,
        limit: 2,
        cause: 'slots',
      },
    ])
    await drain(flights)
    for (let index = 0; index < 60; index++) await answered(lanes, local, { answered: true, rateLimit: HOLDING })
    expect(lane(events)).toHaveLength(1)
    expect(lanes.record()).toEqual({
      local: {
        limit: 'auto',
        start: 2,
        lowest: 2,
        highest: 2,
        cuts: 0,
        headers: true,
      },
    })
    // A throttle still halves it, and it regrows to the slots.
    await answered(lanes, local, { answered: false, failure: TOO_MANY })
    await answered(lanes, local, { answered: true })
    expect(changes(events)).toEqual([
      [2, 'slots'],
      [1, 'cut'],
      [2, 'regrown'],
    ])
    // More slots than the review's ceiling: the lane holds the ceiling.
    const big = target('big', 40)
    const crowd = Array.from({ length: 20 }, () => hold(lanes, big))
    await tick()
    expect(running(crowd)).toBe(REVIEW_CEILING)
    expect(lane(events).at(-1)).toEqual({
      type: 'concurrency',
      provider: big.ref,
      limit: 16,
      cause: 'slots',
    })
    await drain(crowd)
  })

  it('keeps today\'s one shared limit, no event and no pacing, with concurrency set', async () => {
    const { lanes, events, clock } = harness(2)
    const flights = [alpha, alpha, alpha, beta, beta, beta].map(on => hold(lanes, on))
    await tick()
    expect(running(flights)).toBe(2)
    // A throttle with a Retry-After and headers that say no request is left changes nothing.
    flights[0].finish({
      answered: false,
      failure: TOO_MANY,
      retryAfterMs: 9000,
      rateLimit: {
        requests: 0,
        tokens: 0,
        tokensLimit: 100,
        requestsResetMs: 9000,
      },
    })
    await tick()
    expect(running(flights)).toBe(3)
    await drain(flights.slice(1))
    expect(events).toEqual([])
    expect(clock.armed).toEqual([])
    expect(lanes.record()).toEqual({
      alpha: {
        limit: 2,
        start: 2,
        lowest: 2,
        highest: 2,
        cuts: 0,
        headers: true,
      },
      beta: {
        limit: 2,
        start: 2,
        lowest: 2,
        highest: 2,
        cuts: 0,
        headers: false,
      },
    })
  })

  it('ends a pause or a pacing wait at the stop, and records the range, the cuts and the headers in its record', async () => {
    const { lanes, clock } = harness()
    await answered(lanes, alpha, {
      answered: false,
      failure: TOO_MANY,
      retryAfterMs: 30_000,
      rateLimit: HOLDING,
    })
    const paused = new AbortController()
    const waiting = hold(lanes, alpha, { stop: paused.signal })
    const ended = waiting.done.then(() => undefined, (error: unknown) => error)
    await tick()
    expect(clock.pending()).toBe(1)
    const reason = new Error('stopped')
    paused.abort(reason)
    expect(await ended).toBe(reason)
    expect(clock.pending()).toBe(0)
    expect(waiting.running).toBe(false)
    await answered(lanes, beta, {
      answered: true,
      rateLimit: { ...HOLDING, requests: 0, requestsResetMs: 20_000 },
    })
    const pacing = new AbortController()
    const paced = hold(lanes, beta, { stop: pacing.signal })
    const pacedEnded = paced.done.then(() => undefined, (error: unknown) => error)
    await tick()
    expect(clock.pending()).toBe(1)
    pacing.abort(reason)
    expect(await pacedEnded).toBe(reason)
    expect(clock.pending()).toBe(0)
    // A call that comes to a lane with its stop aborted ends at once, and holds no slot.
    await expect(hold(lanes, alpha, { stop: paused.signal }).done).rejects.toBe(reason)
    expect(lanes.record()).toEqual({
      alpha: {
        limit: 'auto',
        start: 4,
        lowest: 2,
        highest: 4,
        cuts: 1,
        headers: true,
      },
      beta: {
        limit: 'auto',
        start: 4,
        lowest: 4,
        highest: 4,
        cuts: 0,
        headers: true,
      },
    })
  })

  it('frees its slots when a call throws, and counts an attempt that ends twice once', async () => {
    const { lanes, events } = harness()
    await expect(lanes.run(alpha, never, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await lanes.run(alpha, never, (call) => {
      const attempt = call.sent(COUNT)
      attempt.ended({ answered: false, failure: TOO_MANY })
      attempt.ended({ answered: false, failure: TOO_MANY })
      return Promise.resolve()
    })
    expect(lane(events)).toHaveLength(1)
    const flights = Array.from({ length: 4 }, () => hold(lanes, alpha))
    await tick()
    expect(running(flights)).toBe(2)
    await drain(flights)
  })

  it('keeps one lane per provider, merged by id in its record, and a lane to each', async () => {
    const { lanes, events } = harness()
    const twin = target('alpha')
    await answered(lanes, alpha, { answered: false, failure: TOO_MANY })
    await answered(lanes, twin, { answered: true, rateLimit: HOLDING })
    // The two objects have a lane each: the second was not cut.
    const first = Array.from({ length: 3 }, () => hold(lanes, alpha))
    const second = Array.from({ length: 4 }, () => hold(lanes, twin))
    await tick()
    expect(running(first)).toBe(2)
    expect(running(second)).toBe(4)
    expect(lanes.record()).toEqual({
      alpha: {
        limit: 'auto',
        start: 4,
        lowest: 2,
        highest: 4,
        cuts: 1,
        headers: true,
      },
    })
    expect(lane(events)).toHaveLength(1)
    await drain([
      ...first,
      ...second,
    ])
  })

  describe('the counting mode', () => {
    /** Headers that show nothing of the window used: what a server that counts replies as they end shows, and what a refusal can show. */
    const unused: RateLimit = {
      requests: 1000,
      tokens: 1_000_000,
      tokensLimit: 1_000_000,
      tokensResetMs: 1000,
    }
    /** At a reservation of 600000 the window holds one call; at their expected use it holds them all. */
    const heavy = { reservation: 600_000, expected: 54_096, replyTokens: 150_000 }

    it('does not switch a lane to end counting on a throttle whose headers show the window unused', async () => {
      const { lanes, events } = harness()
      await answered(lanes, alpha, { answered: false, failure: TOO_MANY, rateLimit: unused }, heavy)
      expect(lanes.record().alpha).toMatchObject({ cuts: 1, lowest: 2 })
      const burst = Array.from({ length: 2 }, () => hold(lanes, alpha, { count: heavy }))
      await tick()
      expect(running(burst)).toBe(1)
      expect(changes(events).at(-1)).toEqual([2, 'paced'])
      await tick()
      await drain(burst.slice(0, 1))
    })

    it('does not switch a lane to end counting on the headers of a whole reply at its end', async () => {
      const { lanes, events } = harness()
      await answered(lanes, alpha, { answered: true, rateLimit: unused }, heavy)
      const burst = Array.from({ length: 4 }, () => hold(lanes, alpha, { count: heavy }))
      await tick()
      expect(running(burst)).toBe(1)
      expect(changes(events)).toEqual([
        [4, 'paced'],
      ])
      await drain(burst.slice(0, 1))
    })

    it('switches only when a stream starts with fewer tokens used than half the budget its request carried', async () => {
      const { lanes, events } = harness()
      const count = { reservation: 300_000, expected: 54_096, replyTokens: 150_000 }
      // 100000 used is under the budget of 150000 but over its half: a count rounded up to the thousand, not a server that counts at the end.
      await streamed(lanes, alpha, { ...unused, tokens: 900_000 }, count)
      const burst = Array.from({ length: 4 }, () => hold(lanes, alpha, { count }))
      await tick()
      expect(running(burst)).toBe(3)
      expect(changes(events)).toEqual([
        [4, 'paced'],
      ])
      await drain(burst.slice(0, 3))
    })
  })
})
