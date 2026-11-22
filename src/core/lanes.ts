/**
 * Lanes: one concurrency limit per provider within the review's ceiling, which follows what the provider says of itself.
 * With `concurrency` set none of it applies: one limit shared by every provider, as 0.7.0 ran, and no event, no pause and no pacing.
 *
 * The order of a call's waits: its lane's slot, then its lane's pause and pacing waits, which end at the review's stop as a backoff
 * does, then a slot of the review's ceiling, and only then the call, its request built inside both slots (ADR-0009). The queues are
 * FIFO and not abortable: a queued call ends at its slot, and a call waiting for a pause or for pacing holds no slot of the ceiling.
 *
 * The rule is AIMD, as far as quorum's scale allows, with a start of 4 (0.7.0's own: a few calls of a minute or more each are far
 * below the ramp a hosted tier limits, and a lower start would only slow the first minutes of every review) and a ceiling of 16 calls
 * in all (four times 0.7.0's: room for a hosted tier at quorum's rate, and a bound on what a review holds at once):
 * - a window is the stretch between two changes of a lane's limit, its epoch; growth by one needs as many answered attempts of the
 *   epoch, with no throttle signal, as the limit, and the lane's last headers to hold one more call (past its capacity a server
 *   queues with no error, so clean answers alone would ramp a server into queueing, timeouts and the provider-down rule); a lane cut
 *   below its start regrows to it with no header;
 * - a throttle signal (a 429 that is no used-up quota, a 503, 504, 524 or 529, a timeout, a stall) halves the limit, at least 1, once
 *   per window: a throttle from an attempt sent before the last change cuts nothing;
 * - a throttle's Retry-After pauses the lane's new calls until it passes, the calls in flight going on, and the headers pace it: a call
 *   waits for the reset while no request is left or the tokens left do not hold the lane's calls and this one's. Each of these waits is
 *   at most `MAX_HINT_MS` (the longest hint 3b waits for): a server can slow its own lane, never stop it. Pacing only delays.
 *
 * The counting rule: a server that counts a request's tokens as it arrives has them in its remaining tokens already, so the lane counts
 * each call at its reservation, and only the calls sent since the reply whose headers it reads. A server that counts a reply as it ends
 * shows it as a stream starts: fewer tokens used than half the reply budget its own request carried. The headers of a reply's end or
 * of a failure never decide it. From then on the lane counts every
 * call in flight at its expected use. Requests are counted at arrival in both. A call that passed its pacing and has not sent its
 * first attempt yet counts as the lane's last call did, so a burst entering at once cannot slip past the headers.
 */

import { wait } from './clock.ts'
import type { Clock } from './clock.ts'
import { createLimiter } from './concurrency.ts'
import type { EventSink, RateLimit } from './ports.ts'
import { MAX_HINT_MS } from './retry.ts'
import type { CallFailure, ProviderRef } from './types.ts'

/** Where a lane starts: 0.7.0's concurrency. */
export const LANE_START = 4
/** The calls in flight in all, over every lane. */
export const REVIEW_CEILING = 16

/** What an attempt tells its lane: its stream's headers as they come, and how it ended. */
export interface LaneAttempt {
  /** The rate-limit headers of the attempt's stream, when they arrive. */
  readonly headers: (rateLimit: RateLimit | undefined) => void
  /** The attempt's end: whether it was answered, the failure it ended with and its hint, and the headers of a whole reply or a failure. */
  readonly ended: (end: { readonly answered: boolean, readonly failure?: CallFailure, readonly retryAfterMs?: number, readonly rateLimit?: RateLimit }) => void
}

/** What a call tells its lane before each attempt: the tokens it reserves, is expected to use, and may reply with. */
export interface LaneCall {
  readonly sent: (count: { readonly reservation: number, readonly expected: number, readonly replyTokens?: number }) => LaneAttempt
}

/** What a lane reads of a provider: the object it is keyed by, the ref its events name, and the slots the provider states. */
export interface LaneTarget {
  readonly provider: object
  readonly ref: Readonly<ProviderRef>
  readonly slots: number | undefined
}

/** What a provider's lane did in a review, which `meta.concurrency` holds: two provider objects of one id are merged. */
export interface ConcurrencyRecord {
  readonly limit: 'auto' | number
  readonly start: number
  readonly lowest: number
  readonly highest: number
  readonly cuts: number
  /** Whether the provider's replies carried rate-limit headers. */
  readonly headers: boolean
}

export interface Lanes {
  /** Runs `task` once its provider's lane and the review's ceiling have room, and the lane's waits have passed; ends at `stop` while it waits for one. */
  readonly run: <T>(target: LaneTarget, stop: AbortSignal, task: (call: LaneCall) => Promise<T>) => Promise<T>
  /** What each provider's lane did, by provider id. */
  readonly record: () => Readonly<Record<string, ConcurrencyRecord>>
}

/** What the lanes are made of: the review's `concurrency` when it is set, its clock and its event sink. */
export interface LanesOptions {
  readonly concurrency?: number
  readonly clock: Clock
  readonly emit: EventSink
}

/** The statuses, besides a 429 that is no used-up quota, with which a server says it is overloaded or slow to answer. */
const THROTTLE_STATUSES: ReadonlySet<unknown> = new Set([503, 504, 524, 529])

/** Whether `failure` is a throttle signal: a 429 that is no used-up quota, a 503, 504, 524 or 529, or a timeout, a stall included. */
export function throttleOf(failure: CallFailure | undefined): boolean {
  if (failure === undefined) return false
  if (failure.kind === 'timeout') return true
  if (failure.kind !== 'http') return false
  return failure.status === 429
    ? failure.exhausted !== true
    : THROTTLE_STATUSES.has(failure.status)
}

/** Where a provider's lane starts: 4, or the slots it states when fewer, at most the review's ceiling. */
export function laneStart(target: Pick<LaneTarget, 'slots'>): number {
  return target.slots === undefined
    ? LANE_START
    : Math.min(target.slots, REVIEW_CEILING)
}

/** The tokens a call is counted as: at its reservation, or at what it is expected to use. */
interface Count {
  readonly reservation: number
  readonly expected: number
}

/** An attempt in flight: the epoch it was sent in, what it counts as and the reply budget its request carried. */
interface Flight {
  readonly epoch: number
  readonly count: Count
  /** The reply budget the attempt's request carried, none when it carried none. */
  readonly replyTokens: number | undefined
}

/** The last rate-limit headers a lane read, when, and the calls it sent since, counted at their reservation. */
interface Heard {
  readonly at: number
  readonly rateLimit: RateLimit
  calls: number
  reservation: number
}

interface Lane {
  readonly ref: Readonly<ProviderRef>
  readonly start: number
  /** The most the lane grows to: the review's ceiling, or the slots the provider states. */
  readonly ceiling: number
  limit: number
  lowest: number
  highest: number
  cuts: number
  headers: boolean
  /** Whether a request went to the provider: a lane that sent none is not recorded. */
  used: boolean
  /** Opens at each change of the limit; an attempt carries the one it was sent in. */
  epoch: number
  /** The attempts of the epoch answered with no throttle signal. */
  clean: number
  /** The calls holding a slot of the lane, and those waiting for one. */
  active: number
  readonly queue: Array<() => void>
  pausedUntil: number
  pacedUntil: number
  last: Heard | undefined
  /** Whether the server counts a reply as it ends: learned from the first reply that shows it, and held. */
  endCounting: boolean
  lastCount: Count | undefined
  readonly flying: Set<Flight>
  /** The calls that passed the lane's waits and have not sent their first attempt, each counted as the lane's last call was. */
  readonly claims: Set<Count>
}

const FIELDS = [
  'requests',
  'tokens',
  'tokensLimit',
  'requestsResetMs',
  'tokensResetMs',
] as const

/** Whether `rateLimit` states anything at all. */
function carries(rateLimit: RateLimit | undefined): rateLimit is RateLimit {
  return rateLimit !== undefined && FIELDS.some(field => rateLimit[field] !== undefined)
}

/** A wait asked of a header: at most `MAX_HINT_MS`, and never a number that is no wait. */
function bounded(ms: number): number {
  return Number.isNaN(ms)
    ? 0
    : Math.min(Math.max(ms, 0), MAX_HINT_MS)
}

function total(counts: Iterable<Count>, field: keyof Count): number {
  let sum = 0
  for (const count of counts) sum += count[field]
  return sum
}

/** `id`'s entries, one for each provider object, merged by id: the widest range, every cut, and whether any carried headers. */
function recordOf(entries: ReadonlyArray<readonly [string, ConcurrencyRecord]>): Record<string, ConcurrencyRecord> {
  const merged = new Map<string, ConcurrencyRecord>()
  for (const [id, record] of entries) {
    const known = merged.get(id)
    merged.set(id, known === undefined
      ? record
      : {
          limit: known.limit,
          start: Math.max(known.start, record.start),
          lowest: Math.min(known.lowest, record.lowest),
          highest: Math.max(known.highest, record.highest),
          cuts: known.cuts + record.cuts,
          headers: known.headers || record.headers,
        })
  }
  return Object.fromEntries(merged)
}

/**
 * The lanes of a review. With `concurrency` set there is one limit for every provider and a record that says so; else each provider
 * object has a lane, which grows, is cut, pauses and paces as the module's comment says, and says so with a `concurrency` event.
 */
export function createLanes(options: LanesOptions): Lanes {
  return options.concurrency === undefined
    ? adaptive(options)
    : pinned(options.concurrency)
}

/** Today's one limit, shared by every provider: the lanes only note which providers sent rate-limit headers. */
function pinned(concurrency: number): Lanes {
  const limit = createLimiter(concurrency)
  const seen = new Map<object, { readonly ref: Readonly<ProviderRef>, headers: boolean }>()
  return {
    run: (target, _stop, task) => limit(() => task({
      sent: () => {
        // A provider is recorded once a request went to it: one the store answered whole sent nothing, and has no headers to lack.
        let entry = seen.get(target.provider)
        if (entry === undefined) {
          entry = { ref: target.ref, headers: false }
          seen.set(target.provider, entry)
        }
        const noted = entry
        const note = (rateLimit: RateLimit | undefined): void => {
          if (carries(rateLimit)) noted.headers = true
        }
        return {
          headers: note,
          ended: end => note(end.rateLimit),
        }
      },
    })),
    record: () => recordOf([
      ...seen.values(),
    ].map(({ ref, headers }) => [
      ref.id,
      {
        limit: concurrency,
        start: concurrency,
        lowest: concurrency,
        highest: concurrency,
        cuts: 0,
        headers,
      },
    ])),
  }
}

function adaptive({ clock, emit }: LanesOptions): Lanes {
  const ceiling = createLimiter(REVIEW_CEILING)
  const lanes = new Map<object, Lane>()

  const say = (lane: Lane, cause: 'grown' | 'cut' | 'paused' | 'paced' | 'regrown' | 'slots', more: { readonly from?: number, readonly waitMs?: number, readonly failure?: CallFailure } = {}): void => {
    emit({
      type: 'concurrency',
      provider: lane.ref,
      limit: lane.limit,
      cause,
      ...more.from === undefined
        ? {}
        : { from: more.from },
      ...more.waitMs === undefined
        ? {}
        : { waitMs: more.waitMs },
      ...more.failure === undefined
        ? {}
        : {
            failure: { ...more.failure },
          },
    })
  }

  function laneOf(target: LaneTarget): Lane {
    const known = lanes.get(target.provider)
    if (known !== undefined) return known
    const start = laneStart(target)
    const lane: Lane = {
      ref: target.ref,
      start,
      ceiling: target.slots === undefined
        ? REVIEW_CEILING
        : start,
      limit: start,
      lowest: start,
      highest: start,
      cuts: 0,
      headers: false,
      used: false,
      epoch: 0,
      clean: 0,
      active: 0,
      queue: [],
      pausedUntil: Number.NEGATIVE_INFINITY,
      pacedUntil: Number.NEGATIVE_INFINITY,
      last: undefined,
      endCounting: false,
      lastCount: undefined,
      flying: new Set(),
      claims: new Set(),
    }
    lanes.set(target.provider, lane)
    if (target.slots !== undefined) say(lane, 'slots')
    return lane
  }

  /** Hands the lane's free slots to the calls queued for them, in the order they came. */
  function drain(lane: Lane): void {
    while (lane.active < lane.limit && lane.queue.length > 0) {
      lane.active += 1
      lane.queue.shift()!()
    }
  }

  function enter(lane: Lane): Promise<void> {
    if (lane.active < lane.limit && lane.queue.length === 0) {
      lane.active += 1
      return Promise.resolve()
    }
    return new Promise<void>(resolve => lane.queue.push(resolve))
  }

  function leave(lane: Lane): void {
    lane.active -= 1
    drain(lane)
  }

  /** Changes the lane's limit, which opens a new window. */
  function move(lane: Lane, limit: number): void {
    lane.limit = limit
    lane.lowest = Math.min(lane.lowest, limit)
    lane.highest = Math.max(lane.highest, limit)
    lane.epoch += 1
    lane.clean = 0
    drain(lane)
  }

  /** What the lane counts against the headers: the calls sent since them, and their tokens, as the server counts them. */
  function counted(lane: Lane): { readonly calls: number, readonly tokens: number, readonly one: number } {
    const since = lane.last
    const calls = (since?.calls ?? 0) + lane.claims.size
    const tokens = lane.endCounting
      ? total([...lane.flying].map(({ count }) => count), 'expected') + total(lane.claims, 'expected')
      : (since?.reservation ?? 0) + total(lane.claims, 'reservation')
    const last = lane.lastCount
    const one = last === undefined
      ? 0
      : lane.endCounting
        ? last.expected
        : last.reservation
    return { calls, tokens, one }
  }

  /** Whether the last headers leave no room for one more call: no request left, or fewer tokens left than the counted calls and one more. */
  function shortOf(lane: Lane): { readonly requests: boolean, readonly tokens: boolean } {
    const heard = lane.last
    if (heard === undefined) return { requests: false, tokens: false }
    const { calls, tokens, one } = counted(lane)
    const { requests: left, tokens: held } = heard.rateLimit
    return {
      requests: left !== undefined && left - calls < 1,
      tokens: held !== undefined && held < tokens + one,
    }
  }

  /** When the headers' reset falls, on the clock: the requests' reset when no request is left, the tokens' reset, else the requests', when tokens run short. */
  function pacingUntil(lane: Lane): number {
    const heard = lane.last
    if (heard === undefined) return Number.NEGATIVE_INFINITY
    const short = shortOf(lane)
    const { requestsResetMs, tokensResetMs } = heard.rateLimit
    let longest = Number.NEGATIVE_INFINITY
    for (const reset of [
      short.requests
        ? requestsResetMs
        : undefined,
      short.tokens
        ? tokensResetMs ?? requestsResetMs
        : undefined,
    ]) {
      if (reset !== undefined) longest = Math.max(longest, heard.at + bounded(reset))
    }
    return longest
  }

  /**
   * Waits out the lane's pause and its pacing, which end at `stop`, then counts the call as a pending one of the lane: in the same
   * turn, so a burst of calls entering together each see the ones before them.
   */
  async function turn(lane: Lane, stop: AbortSignal): Promise<Count> {
    for (;;) {
      stop.throwIfAborted()
      const now = clock.now()
      const paused = Math.max(0, lane.pausedUntil - now)
      const until = pacingUntil(lane)
      const paced = Math.max(0, until - now)
      const ms = Math.max(paused, paced)
      if (ms <= 0) {
        const claim: Count = lane.lastCount ?? { reservation: 0, expected: 0 }
        const pending = { ...claim }
        lane.claims.add(pending)
        return pending
      }
      if (paced > paused && until > lane.pacedUntil) {
        lane.pacedUntil = until
        say(lane, 'paced', {
          waitMs: Math.round(paced),
        })
      }
      await wait(clock, Math.ceil(ms), stop)
    }
  }

  /**
   * Reads the rate-limit headers of an attempt's reply: the lane's last headers, from which it counts again. Only the headers of a
   * stream's start, `decides`, show how the server counts: the request is accepted and its body not begun, while a refusal may never
   * have been counted and a whole reply's headers are written when it ends, on a window that may have given its count back. The
   * switch needs fewer tokens used than half the reply budget the request carried, which absorbs a count rounded to the thousand.
   */
  function hear(lane: Lane, flight: Flight, rateLimit: RateLimit | undefined, decides: boolean): boolean {
    if (!carries(rateLimit)) return false
    lane.headers = true
    if (rateLimit.requests === undefined && rateLimit.tokens === undefined) return true
    if (decides && flight.replyTokens !== undefined && rateLimit.tokens !== undefined && rateLimit.tokensLimit !== undefined && rateLimit.tokensLimit - rateLimit.tokens < flight.replyTokens / 2) lane.endCounting = true
    lane.last = {
      at: clock.now(),
      rateLimit,
      calls: 0,
      reservation: 0,
    }
    return true
  }

  function grow(lane: Lane): void {
    if (lane.limit >= lane.ceiling) return
    const regrowing = lane.limit < lane.start
    if (!regrowing) {
      const short = shortOf(lane)
      if (lane.last === undefined || short.requests || short.tokens) return
    }
    move(lane, lane.limit + 1)
    say(lane, regrowing
      ? 'regrown'
      : 'grown')
  }

  function cut(lane: Lane, failure: CallFailure | undefined): void {
    const next = Math.max(1, Math.floor(lane.limit / 2))
    if (next >= lane.limit) return
    const from = lane.limit
    lane.cuts += 1
    move(lane, next)
    say(lane, 'cut', {
      from,
      ...failure === undefined
        ? {}
        : { failure },
    })
  }

  function pause(lane: Lane, retryAfterMs: number, failure: CallFailure | undefined): void {
    const ms = bounded(retryAfterMs)
    const until = clock.now() + ms
    if (ms <= 0 || until <= lane.pausedUntil) return
    lane.pausedUntil = until
    say(lane, 'paused', {
      waitMs: Math.round(ms),
      ...failure === undefined
        ? {}
        : { failure },
    })
  }

  function attemptOf(lane: Lane, flight: Flight): LaneAttempt {
    let ended = false
    let headered = false
    return {
      headers: (rateLimit) => {
        if (ended) return
        headered = hear(lane, flight, rateLimit, true) || headered
      },
      ended: (end) => {
        if (ended) return
        ended = true
        lane.flying.delete(flight)
        if (!headered) hear(lane, flight, end.rateLimit, false)
        const current = flight.epoch === lane.epoch
        if (end.answered) {
          if (!current) return
          lane.clean += 1
          if (lane.clean >= lane.limit) grow(lane)
        } else if (throttleOf(end.failure)) {
          if (current) {
            lane.clean = 0
            cut(lane, end.failure)
          }
          if (end.retryAfterMs !== undefined) pause(lane, end.retryAfterMs, end.failure)
        }
      },
    }
  }

  return {
    run: async (target, stop, task) => {
      const lane = laneOf(target)
      await enter(lane)
      let pending: Count | undefined
      try {
        pending = await turn(lane, stop)
        const claim = pending
        return await ceiling(() => task({
          sent: (count) => {
            const flight: Flight = { epoch: lane.epoch, count, replyTokens: count.replyTokens }
            lane.used = true
            lane.claims.delete(claim)
            lane.flying.add(flight)
            lane.lastCount = count
            if (lane.last !== undefined) {
              lane.last.calls += 1
              lane.last.reservation += count.reservation
            }
            return attemptOf(lane, flight)
          },
        }))
      } finally {
        if (pending !== undefined) lane.claims.delete(pending)
        leave(lane)
      }
    },
    record: () => recordOf([
      ...lanes.values(),
    ].filter(lane => lane.used).map(lane => [
      lane.ref.id,
      {
        limit: 'auto',
        start: lane.start,
        lowest: lane.lowest,
        highest: lane.highest,
        cuts: lane.cuts,
        headers: lane.headers,
      },
    ])),
  }
}
