/**
 * The retry policy: which failures a call retries and how long it waits before the next attempt.
 * It is plain data in and a number out, so it holds no clock and no thrown value: the call path
 * reads a failure's facts and the call's state, and gives it the randomness.
 */

/** The longest wait a server may ask for, in milliseconds: a longer hint ends the call. */
export const MAX_HINT_MS = 60_000

/** The backoff before retry n is random from 0 to the lesser of `BACKOFF_CAP_MS` and `BACKOFF_BASE_MS` times 2 to the n. */
const BACKOFF_BASE_MS = 500
const BACKOFF_CAP_MS = 8000
/** What a server's hint is stretched by, at most, so calls that were told the same wait do not retry together. */
const HINT_JITTER_MS = 1000

/** The only failures a call retries, whatever a failure says of itself. */
const RETRIED_KINDS: ReadonlySet<unknown> = new Set(['network', 'timeout', 'http'])
/** The statuses of a gateway that gave up waiting for the server, which count as a timeout. */
const GATEWAY_TIMEOUTS: ReadonlySet<unknown> = new Set([504, 524])

/** What the policy reads of a failure: each as the call path found it, so any of them may be anything. */
export interface FailureFacts {
  readonly kind: unknown
  readonly status: unknown
  readonly retryable: unknown
  readonly retryAfterMs: unknown
}

/** Where a call stands: the retries it has made, the retries its provider states, and whether it timed out already. */
export interface CallState {
  /** Retries made so far: 0 once the first attempt has failed. */
  readonly retried: number
  readonly retries: number
  readonly timedOut: boolean
}

/** True for the deadline of the core's own, or a gateway's 504 or 524: a slow request is likely slow again, and may be billed each time. */
export function isTimeout(failure: FailureFacts): boolean {
  return failure.kind === 'timeout' || (failure.kind === 'http' && GATEWAY_TIMEOUTS.has(failure.status))
}

/**
 * How long to wait before the next attempt of a call, in milliseconds, or undefined when the call
 * ends with this failure. It ends, in this order, when the retries are spent, the failure is not a
 * `network`, `timeout` or `http` one, it does not say `retryable` is `true`, it is a second
 * timeout of the call, or the server asks for more than `MAX_HINT_MS`. Otherwise the wait is the
 * server's hint, when it is a finite number above 0, plus up to a second; else a random time from 0
 * to the lesser of 8 s and 0.5 s times 2 to the number of retries made. The review's abort is the
 * call path's to check, before this.
 */
export function retryWait(failure: FailureFacts, call: CallState, random: () => number): number | undefined {
  // Not `>=`: a retry count that is not a number compares false both ways, and must end the call.
  if (!(call.retried < call.retries)) return undefined
  if (!RETRIED_KINDS.has(failure.kind) || failure.retryable !== true) return undefined
  if (call.timedOut && isTimeout(failure)) return undefined
  const hint = failure.retryAfterMs
  if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0) {
    return hint > MAX_HINT_MS
      ? undefined
      : hint + random() * HINT_JITTER_MS
  }
  return random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** call.retried)
}
