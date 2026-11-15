/**
 * The limits of a review: the token cap's plain rules and its ledger, and the failure a limit ends a
 * call with. A limit stops part of a review without failing it: the call path reserves each attempt's
 * worst case here before it sends the attempt, and the gap a limit leaves is written from the votes and
 * the research it stopped.
 */

import { QuorumError } from './errors.ts'
import type { IncompleteEntry, Usage, Verdict } from './types.ts'

/** The most tokens, input and output, one review spends when `maxReviewTokens` is not set. */
export const DEFAULT_MAX_REVIEW_TOKENS = 2_000_000

/** What `maxReviewTokens` is when it is out of range: a whole number of tokens up to the largest the ledger adds exactly. */
const CAP_PROBLEM = `must be a whole number of tokens from 1 to ${Number.MAX_SAFE_INTEGER}`

/** The problem with a `maxReviewTokens`, in words that say what to write, or undefined for a safe integer of at least 1. */
export function maxReviewTokensProblem(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? undefined
    : CAP_PROBLEM
}

/** The limits a review keeps to. */
export type LimitName = 'token-cap'

/**
 * What a call ends with when a limit stops it. It is recognised by `instanceof` only, and a provider
 * cannot raise one: an instance from a second copy of quorum is an unknown failure, which fails closed.
 * It has no `kind`, so the retry policy never retries it and it is no provider's failure.
 */
export class LimitError extends QuorumError {
  readonly limit: LimitName

  constructor(limit: LimitName, message: string) {
    super(message)
    this.limit = limit
  }
}

/** True for the failure a limit ends a call with. */
export function isLimit(error: unknown): error is LimitError {
  return error instanceof LimitError
}

/** What the ledger holds: the cap, the tokens settled so far and the tokens reserved by the attempts in flight. */
export interface Totals {
  readonly cap: number
  readonly settled: number
  readonly reserved: number
}

/** Whether an attempt goes at once, waits for the attempts in flight to settle, or can never fit. */
export type Fit = 'fits' | 'waits' | 'refused'

/**
 * Where an attempt of `tokens` stands: refused when it does not fit beside what was settled, which only grows;
 * waiting when it fits beside that but not beside the attempts in flight, which settle at what they spent or
 * at their whole reservation; else fitting.
 */
export function fitOf(totals: Totals, tokens: number): Fit {
  if (totals.settled + tokens > totals.cap) return 'refused'
  return totals.settled + totals.reserved + tokens > totals.cap
    ? 'waits'
    : 'fits'
}

/** What a failed attempt says of itself, as the call path read it: each as found, so either may be anything. */
export interface SettledFailure {
  readonly kind: unknown
  readonly status: unknown
}

/** True for an integer status of 400 to 499 but 408: a server that refused the request before any work. */
function refusedBeforeWork(status: unknown): boolean {
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499 && status !== 408
}

/**
 * The tokens an attempt counts once it ends. A valid usage comes first, even above the reservation. Without
 * one, a failure that is a refusal as too large, or an `http` failure of a client status but 408, counts for
 * nothing: no work was done. Anything else counts the whole reservation, so a failure that says nothing
 * never costs less than it may have.
 */
export function settlementOf(reserved: number, usage: Usage | undefined, failure?: SettledFailure): number {
  if (usage !== undefined) return usage.inputTokens + usage.outputTokens
  if (failure !== undefined && (failure.kind === 'too-large' || (failure.kind === 'http' && refusedBeforeWork(failure.status)))) return 0
  return reserved
}

/**
 * One review's token ledger. `reserve` takes an attempt's worst case before it is sent: it resolves once the
 * attempt fits beside what was settled and what the attempts in flight reserved, and rejects with the cap's
 * `LimitError` when it can never fit, or with `stop`'s reason when `stop` aborts first. `settle` returns a
 * reservation and adds what the attempt spent.
 */
export interface Ledger {
  readonly cap: number
  readonly reserve: (tokens: number, stop: AbortSignal) => Promise<void>
  readonly settle: (reserved: number, spent: number) => void
}

/** An attempt that waits for room: its size, and how to let it go or turn it away. */
interface Waiter {
  readonly tokens: number
  readonly admit: () => void
  readonly refuse: () => void
}

/**
 * A ledger for a cap of `cap` tokens. An attempt that waits queues, and each settlement admits the waiters in
 * the order they began to wait, up to the first that still waits; one that can never fit leaves the queue. A
 * newcomer that would fit while an earlier attempt waits waits behind it, so a stream of small votes never holds
 * a large research request back. Nothing deadlocks: every reservation in flight settles, at worst at its
 * attempt's deadline, and with none in flight the head of the queue either fits or is refused.
 */
export function createLedger(cap: number): Ledger {
  let settled = 0
  let reserved = 0
  const waiters: Waiter[] = []
  const refusal = (): LimitError => new LimitError('token-cap', `the review's token cap of ${cap} tokens leaves no room for this call`)

  function wake(): void {
    while (waiters.length > 0) {
      const head = waiters[0]
      const fit = fitOf({ cap, settled, reserved }, head.tokens)
      if (fit === 'waits') return
      waiters.shift()
      if (fit === 'fits') {
        reserved += head.tokens
        head.admit()
      } else {
        head.refuse()
      }
    }
  }

  function reserve(tokens: number, stop: AbortSignal): Promise<void> {
    if (stop.aborted) return Promise.reject(stop.reason)
    const fit = fitOf({ cap, settled, reserved }, tokens)
    if (fit === 'refused') return Promise.reject(refusal())
    if (fit === 'fits' && waiters.length === 0) {
      reserved += tokens
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        tokens,
        admit: () => {
          stop.removeEventListener('abort', onAbort)
          resolve()
        },
        refuse: () => {
          stop.removeEventListener('abort', onAbort)
          reject(refusal())
        },
      }
      function onAbort(): void {
        const index = waiters.indexOf(waiter)
        if (index !== -1) waiters.splice(index, 1)
        reject(stop.reason)
        wake()
      }
      waiters.push(waiter)
      stop.addEventListener('abort', onAbort, { once: true })
    })
  }

  function settle(was: number, spent: number): void {
    reserved -= was
    settled += spent
    wake()
  }

  return { cap, reserve, settle }
}

/**
 * The gap the token cap leaves in a profile, as a list of one entry or none: `research` names the limit that stopped
 * its research request, and every vote of `verdicts` whose failure is the cap's counts. The detail names the cap
 * with its setting, then what it stopped: `its research`, `<n> vote(s)`, or `its research and <n> vote(s)`.
 */
export function limitGaps(profile: string, research: LimitName | undefined, verdicts: readonly Verdict[], limits: { readonly cap: number }): IncompleteEntry[] {
  const votes = verdicts.flatMap(verdict => verdict.votes).filter(lensVote => lensVote.failure?.kind === 'token-cap').length
  const stopped = [
    ...research === 'token-cap'
      ? ['its research']
      : [],
    ...votes > 0
      ? [`${votes} vote(s)`]
      : [],
  ]
  if (stopped.length === 0) return []
  return [
    { profile, reason: 'token-cap', detail: `the review's token cap of ${limits.cap} tokens stopped ${stopped.join(' and ')}` },
  ]
}
