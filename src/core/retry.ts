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

/** The failures a call retries, whatever a failure says of itself, but a reply of only reasoning, which `retryWait` retries once under its own rule. */
const RETRIED_KINDS: ReadonlySet<unknown> = new Set(['network', 'timeout', 'http'])
/** The statuses of a gateway that gave up waiting for the server, which count as a timeout. */
const GATEWAY_TIMEOUTS: ReadonlySet<unknown> = new Set([504, 524])

/** What the policy reads of a failure: each as the call path found it, so any of them may be anything. */
export interface FailureFacts {
  readonly kind: unknown
  readonly status: unknown
  readonly retryable: unknown
  readonly retryAfterMs: unknown
  /** What the failure says its reply lacked: `thinking` for a reply that held only reasoning. */
  readonly noAnswer: unknown
}

/** Where a call stands: the retries it has made, the retries its provider states, whether it timed out already, whether a reply of only reasoning ended an attempt of it already, whether the review may lower its provider's thinking, and the time its review has left. */
export interface CallState {
  /** Retries made so far: 0 once the first attempt has failed. */
  readonly retried: number
  readonly retries: number
  readonly timedOut: boolean
  /** Whether an attempt of the call already ended with a reply of only reasoning: a call sends one such reply once more, as it retries one timeout. */
  readonly reasoningOnly: boolean
  /** Whether the review may lower the provider's thinking (`thinkingLowersTo`): the adaptation answers a reply of only reasoning then, and the call does not send it again as it is. */
  readonly lowersThinking: boolean
  /** The milliseconds until the review's deadline: a server's hint longer than this ends the call, since the review would be over before the wait. */
  readonly timeLeftMs: number
}

/** True for the deadline of the core's own, or a gateway's 504 or 524: a slow request is likely slow again, and may be billed each time. */
export function isTimeout(failure: FailureFacts): boolean {
  return failure.kind === 'timeout' || (failure.kind === 'http' && GATEWAY_TIMEOUTS.has(failure.status))
}

/** True for a reply that held only reasoning: a `no-answer` failure whose `noAnswer` is `thinking`. */
export function isReasoningOnly(failure: FailureFacts): boolean {
  return failure.kind === 'no-answer' && failure.noAnswer === 'thinking'
}

/**
 * How long to wait before the next attempt of a call, in milliseconds, or undefined when the call
 * ends with this failure. It ends, in this order, when the retries are spent, the failure is not a
 * `network`, `timeout` or `http` one, it does not say `retryable` is `true`, it is a second
 * timeout of the call, or the server asks for more than `MAX_HINT_MS` or for more than the time the
 * review has left. The one exception to the kinds is a reply of only reasoning (`isReasoningOnly`), whatever its
 * `retryable`: it ends the call when the review may lower the provider's thinking (`lowersThinking`), which
 * is the adaptation's to answer, or when an attempt of the call held only reasoning already, and else goes on
 * to the steps every retry takes. Otherwise the wait is the server's hint, when it is a finite number above 0, plus
 * up to a second; else a random time from 0 to the lesser of 8 s and 0.5 s times 2 to the number of
 * retries made. The call path asks this first, with infinite time left once the review's stop is aborted, so a
 * retry that only the stop prevents is the stop's doing, and it checks the stop after.
 */
export function retryWait(failure: FailureFacts, call: CallState, random: () => number): number | undefined {
  // Not `>=`: a retry count that is not a number compares false both ways, and must end the call.
  if (!(call.retried < call.retries)) return undefined
  if (isReasoningOnly(failure)) {
    if (call.lowersThinking || call.reasoningOnly) return undefined
  } else if (!RETRIED_KINDS.has(failure.kind) || failure.retryable !== true) {
    return undefined
  }
  if (call.timedOut && isTimeout(failure)) return undefined
  const hint = failure.retryAfterMs
  if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0) {
    return hint > MAX_HINT_MS || hint > call.timeLeftMs
      ? undefined
      : hint + random() * HINT_JITTER_MS
  }
  return random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** call.retried)
}
