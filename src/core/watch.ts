import type { Clock } from './clock.ts'
import { ownData, rateLimitFacts } from './facts.ts'
import type { RateLimit } from './ports.ts'
import type { Usage } from './types.ts'

/** The least time between two `call:progress` events of one call: one second. */
export const PROGRESS_MS = 1000

/** What one answered attempt showed of its stream: the facts the stall window is learned from. */
export interface AttemptSeen {
  /** How long the attempt ran, from its send to its answer. */
  readonly attemptMs: number
  /** From the attempt's send to its first data event, the headers excluded; absent when it had none, as a whole reply has none. */
  readonly firstTokenMs?: number
  /** The longest time between two signs of progress, the attempt's send and its answer included. */
  readonly longestSilenceMs: number
  /** The output tokens it streamed, or its reply reported when it did not stream. */
  readonly outputTokens: number
  /** Whether its stream showed answer text. */
  readonly answer: boolean
  /** Whether its stream showed reasoning. */
  readonly reasoning: boolean
}

/**
 * What an attempt of a streamed call has seen of its stream, as the review's clock reads it: the stall timer and the
 * attempt's timings read it. `progressAt` is the last headers or data event, which keep-alives are no part of, and the
 * attempt's send before either.
 */
export interface Watch {
  readonly sentAt: number
  progressAt: number
  firstDataAt: number | undefined
  longestSilenceMs: number
  outputTokens: number
  answer: boolean
  reasoning: boolean
}

export function newWatch(sentAt: number): Watch {
  return {
    sentAt,
    progressAt: sentAt,
    firstDataAt: undefined,
    longestSilenceMs: 0,
    outputTokens: 0,
    answer: false,
    reasoning: false,
  }
}

/** What an attempt that answered at `endedAt` showed: its silence counts to its end, and a reply that did not stream is one silence as long as it ran. */
export function seenOf(watch: Watch | undefined, sentAt: number, endedAt: number, reply: Usage | undefined): AttemptSeen {
  const attemptMs = Math.round(endedAt - sentAt)
  if (watch === undefined) {
    return {
      attemptMs,
      longestSilenceMs: attemptMs,
      outputTokens: reply?.outputTokens ?? 0,
      answer: false,
      reasoning: false,
    }
  }
  return {
    attemptMs,
    ...watch.firstDataAt === undefined
      ? {}
      : {
          firstTokenMs: Math.round(watch.firstDataAt - watch.sentAt),
        },
    longestSilenceMs: Math.round(Math.max(watch.longestSilenceMs, endedAt - watch.progressAt)),
    outputTokens: watch.firstDataAt === undefined
      ? reply?.outputTokens ?? 0
      : watch.outputTokens,
    answer: watch.answer,
    reasoning: watch.reasoning,
  }
}

/**
 * A sign of life of a stream as the core reads it, from a value an adapter handed over: own data, numbers and booleans
 * alone; anything else is no signal. A count is any finite number of at least 0, read as a whole number, floored and
 * clamped to a safe integer, so a server that counts in fractions is still a stream that makes progress.
 */
export type Signal
  = | { readonly kind: 'headers', readonly rateLimit?: RateLimit }
    | { readonly kind: 'keep-alive' }
    | { readonly kind: 'data', readonly outputTokens: number, readonly answer: boolean, readonly reasoning: boolean }

export function signalOf(value: unknown): Signal | undefined {
  const kind = ownData(value, 'kind')
  if (kind === 'headers') {
    const rateLimit = rateLimitFacts(ownData(value, 'rateLimit'))
    return rateLimit === undefined
      ? { kind }
      : { kind, rateLimit }
  }
  if (kind === 'keep-alive') return { kind }
  if (kind !== 'data') return undefined
  const outputTokens = ownData(value, 'outputTokens')
  const answer = ownData(value, 'answer')
  const reasoning = ownData(value, 'reasoning')
  return typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0 && typeof answer === 'boolean' && typeof reasoning === 'boolean'
    ? {
        kind,
        outputTokens: Math.min(Math.floor(outputTokens), Number.MAX_SAFE_INTEGER),
        answer,
        reasoning,
      }
    : undefined
}

/**
 * Notes a sign of life of an attempt's stream in its watch, at `now` on the review's clock. A headers or data signal is
 * progress; a data signal also sets `firstDataAt` once and raises `outputTokens`, `answer` and `reasoning`; a keep-alive
 * changes nothing. It returns true for the attempt's first data event.
 */
export function noteSignal(watch: Watch, signal: Signal, now: number): boolean {
  if (signal.kind === 'keep-alive') return false
  watch.longestSilenceMs = Math.max(watch.longestSilenceMs, now - watch.progressAt)
  watch.progressAt = now
  if (signal.kind === 'headers') return false
  const first = watch.firstDataAt === undefined
  watch.firstDataAt ??= now
  watch.outputTokens = Math.max(watch.outputTokens, signal.outputTokens)
  watch.answer ||= signal.answer
  watch.reasoning ||= signal.reasoning
  return first
}

/** One `call:progress` a call has to send, without its number: the attempt's output so far, and what showed it was alive. */
export interface ProgressReport {
  readonly outputTokens: number
  readonly signal: 'tokens' | 'keep-alive'
}

/** The progress reports of one call, across its attempts. */
export interface ProgressReports {
  /** Starts a streamed attempt: its count of output tokens begins from 0. */
  readonly attempt: () => void
  /** Tells that a streamed attempt counted a data event or a keep-alive, with the output tokens it has streamed so far. */
  readonly progressed: (kind: 'data' | 'keep-alive', outputTokens: number) => void
}

/**
 * The progress reports of one call: at most one in `PROGRESS_MS`, `tokens` when the attempt's output grew since the last
 * report, else `keep-alive` when a keep-alive came since. The spacing is the call's, kept across its attempts, and each
 * attempt counts from 0.
 */
export function progressReports(clock: Clock, send: (report: ProgressReport) => void): ProgressReports {
  /** When the call last sent a report, on the review's clock. */
  let sentAt: number | undefined
  /** The output tokens the call's last report of the attempt in hand carried. */
  let reported = 0
  /** Whether a keep-alive came since the call's last report. */
  let keptAlive = false
  return {
    attempt: () => {
      reported = 0
      keptAlive = false
    },
    progressed: (kind, outputTokens) => {
      if (kind === 'keep-alive') keptAlive = true
      const now = clock.now()
      if (sentAt !== undefined && now - sentAt < PROGRESS_MS) return
      const grew = outputTokens > reported
      if (!grew && !keptAlive) return
      sentAt = now
      reported = outputTokens
      keptAlive = false
      send({
        outputTokens,
        signal: grew
          ? 'tokens'
          : 'keep-alive',
      })
    },
  }
}
