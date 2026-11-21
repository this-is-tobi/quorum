import { elapsedWords } from './duration.ts'
import type { Usage } from './types.ts'

/** Base class for every error quorum raises on purpose. */
export class QuorumError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A model reply that could not be turned into the expected shape. */
export class OutputError extends QuorumError {
  readonly stage: string
  readonly reason: string
  readonly snippet: string

  constructor(stage: string, reason: string, reply: string) {
    const snippet = reply.slice(0, 200)
    super(`${stage} reply unusable: ${reason} (reply starts: ${JSON.stringify(snippet)})`)
    this.stage = stage
    this.reason = reason
    this.snippet = snippet
  }
}

/** One configuration problem; `path` locates it, e.g. 'policy.medium' or 'RESEARCH_MODEL'. */
export interface ConfigIssue {
  path: string
  message: string
}

/** A path segment a message may print: a record key is the user's text, and a pasted secret could be one. */
const SAFE_SEGMENT = /^[\w$-]{1,64}$/

/** True for an index, or a name of 1 to 64 ASCII letters, digits, `_`, `$` and `-`: the only segments an issue path prints as written. */
export function isSafeSegment(segment: PropertyKey): boolean {
  return typeof segment === 'number' || (typeof segment === 'string' && SAFE_SEGMENT.test(segment))
}

/** A path as an issue names it: its segments joined with `.`, each one that is not a safe segment printed as `*`. */
export function issuePath(segments: readonly PropertyKey[]): string {
  return segments.map(segment => isSafeSegment(segment)
    ? String(segment)
    : '*').join('.')
}

/** The issues a `ConfigError` message lists: a config of thousands of values can carry as many issues. */
const LISTED_ISSUES = 50

/**
 * Invalid configuration or usage, carrying every issue at once in `issues`. The message lists the first
 * 50 of them, one per line, and counts the rest. The CLI maps it to exit code 2.
 */
export class ConfigError extends QuorumError {
  readonly issues: readonly ConfigIssue[]

  constructor(issues: readonly ConfigIssue[]) {
    const lines = issues.slice(0, LISTED_ISSUES).map(issue => (issue.path
      ? `${issue.path}: ${issue.message}`
      : issue.message))
    const rest = issues.length - LISTED_ISSUES
    if (rest > 0) {
      lines.push(`and ${rest} more issue${rest === 1
        ? ''
        : 's'}`)
    }
    super(lines.join('\n'))
    this.issues = issues
  }
}

/** Every kind of a provider call's failure: the kinds a `ProviderError` has, and the only ones a gap's detail names. */
export const PROVIDER_ERROR_KINDS = [
  'http',
  'network',
  'process',
  'timeout',
  'aborted',
  'refusal',
  'truncated',
  'no-answer',
  'invalid-response',
  'unsupported',
  'too-large',
] as const

/** What went wrong with a provider call. `retryable` is derived from it, unless the adapter sets it. */
export type ProviderErrorKind = typeof PROVIDER_ERROR_KINDS[number]

/**
 * What a reply lacked: `reply`, its visible answer was cut off at the limit sent, `thinking`, its reasoning used
 * the limit, or it held only reasoning, `window`, the server's window ended it, `empty`, it held nothing. A
 * `truncated` failure is `reply`, `thinking` or `window`; a `no-answer` one is `thinking` or `empty`.
 */
export type NoAnswer = 'reply' | 'thinking' | 'window' | 'empty'

/** Every value of `NoAnswer`, for a reader that checks an own data property against them. */
export const NO_ANSWERS: readonly NoAnswer[] = ['reply', 'thinking', 'window', 'empty']

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429])

function isRetryable(kind: ProviderErrorKind, status: number | undefined): boolean {
  if (kind === 'network' || kind === 'timeout') return true
  return kind === 'http' && status !== undefined && (RETRYABLE_STATUSES.has(status) || status >= 500)
}

/**
 * A provider call that failed. The message starts with the provider id. Adapters never put request
 * headers, keys or the runtime's own error text in it; they quote server text through `snippet`.
 * `usage` holds the counts of a reply the provider read and then refused, which the review counts as
 * the failed call's usage.
 */
export class ProviderError extends QuorumError {
  readonly providerId: string
  readonly kind: ProviderErrorKind
  readonly status: number | undefined
  /**
   * A caller may retry the call: true for network errors, timeouts, 408, 409, 429 and 5xx, unless
   * the adapter set it. The core retries only `network`, `timeout` and `http` failures, whatever it says.
   */
  readonly retryable: boolean
  /**
   * The reply says the account's credit, quota or spend limit is used up: the adapter matched the vendor's own
   * code, never a message. Such an error is never `retryable`, whatever the adapter set, and finds its provider
   * down at its first failure.
   */
  readonly exhausted: boolean
  /** The wait the server asked for at least, in milliseconds, when the adapter read one. */
  readonly retryAfterMs: number | undefined
  /** What the reply the call failed on reported, when the provider read one: the review counts it as the failed call's usage. */
  readonly usage: Usage | undefined
  /** What a `truncated` or `no-answer` reply lacked, when the adapter read it. */
  readonly noAnswer: NoAnswer | undefined
  /**
   * `structuredOutput` when the server refused the request's structured-output field: an HTTP 400 or 422 whose
   * body names it as a whole word, which the adapter matched and never quoted. The core moves a provider in
   * automatic JSON mode to prompt mode on it.
   */
  readonly refused: 'structuredOutput' | undefined

  constructor(details: { providerId: string, kind: ProviderErrorKind, message: string, status?: number, retryable?: boolean, exhausted?: true, retryAfterMs?: number, usage?: Usage, noAnswer?: NoAnswer, refused?: 'structuredOutput', cause?: unknown }) {
    super(`${details.providerId}: ${details.message}`, details.cause === undefined
      ? undefined
      : { cause: details.cause })
    this.providerId = details.providerId
    this.kind = details.kind
    this.status = details.status
    this.exhausted = details.exhausted === true
    this.retryable = !this.exhausted && (details.retryable ?? isRetryable(details.kind, details.status))
    this.retryAfterMs = details.retryAfterMs
    this.usage = details.usage
    this.noAnswer = details.noAnswer
    this.refused = details.refused
  }
}

/** The facts of a reply that lacked its answer, all code facts: counts and a code word, never a word the reply held. */
export interface ReplyLack {
  readonly noAnswer: NoAnswer
  /** The reply limit the request was sent with, in tokens, when known. */
  readonly limit?: number
  /** The output tokens the reply reported, reasoning included. */
  readonly outputTokens?: number
  /** The input tokens the reply reported. */
  readonly inputTokens?: number
  /** The window `contextTokens` states, in tokens, when known. */
  readonly window?: number
}

const THINKING_FIX = 'the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt'
const EMPTY_FIX = 'the server may mishandle its structured output: set structuredOutput: prompt'

/** A token count a message may print and a setting may be set to: a whole number of at least 1. */
function isWhole(count: number | undefined): count is number {
  return count !== undefined && Number.isSafeInteger(count) && count >= 1
}

/**
 * The words of a reply that lacked its answer, so an adapter's message and the CLI's `reply-lacked` line share
 * one copy: what the reply held, then the setting to change. Built from facts the code read, never from the
 * reply: a reply's or a reasoning's text is never quoted. A cut-off below the limit sent names both numbers, and
 * a window that ended a reply names its numbers only when the input and output stay below the window, the case
 * a protocol's own flag reports, since a count that reaches the window advises no lower value.
 */
export function lackWords(kind: 'truncated' | 'no-answer', lack: ReplyLack): string {
  const { noAnswer, limit, outputTokens, inputTokens, window } = lack
  if (kind === 'no-answer') {
    return noAnswer === 'thinking'
      ? `reply has no answer, only reasoning: ${THINKING_FIX}`
      : `reply has no answer and no reasoning: ${EMPTY_FIX}`
  }
  if (noAnswer === 'window') {
    return isWhole(window) && isWhole(outputTokens) && inputTokens !== undefined && Number.isSafeInteger(inputTokens) && inputTokens >= 0 && inputTokens + outputTokens < window
      ? `a reply ended at the server's window after ${inputTokens} input and ${outputTokens} output tokens, below contextTokens ${window}: set contextTokens to at most ${inputTokens + outputTokens}`
      : 'a reply ended at the server\'s window, which is smaller than contextTokens: lower contextTokens'
  }
  if (isWhole(limit) && isWhole(outputTokens) && outputTokens < limit) {
    return `a reply was cut off at ${outputTokens} tokens, below the ${limit} quorum asked for: the server caps replies near ${outputTokens}: set maxTokens: ${outputTokens}`
  }
  const at = isWhole(limit)
    ? ` of ${limit} tokens`
    : ''
  return noAnswer === 'thinking'
    ? `reply was cut off at its limit${at} while reasoning, before any answer`
    : `reply was cut off at its limit${at}`
}

/** What to do about a provider whose account's credit, quota or spend limit is used up: one imperative phrase. */
export const QUOTA_FIX = 'add credit or raise the limit at the provider, or wait until it resets'

/** What to do about a provider whose calls ended with `kind`, and for an `http` failure its `status`: one imperative phrase, never a word a server wrote. */
export function failureFix(kind: ProviderErrorKind, status: number | undefined): string {
  switch (kind) {
    case 'network':
      return 'check that the server at its origin is running'
    case 'timeout':
      return 'raise timeoutMs'
    case 'invalid-response':
      return 'check protocol and baseUrl'
    case 'process':
      return 'check command'
    case 'http':
      if (status === 401 || status === 403) return 'check apiKey'
      if (status === 404) return 'check baseUrl and model'
      return status === 429 || (status !== undefined && status >= 500 && status <= 599)
        ? 'lower concurrency or wait'
        : 'check the provider\'s settings'
    default:
      return 'check the provider\'s settings'
  }
}

/**
 * The shortest attempt that reads as cut on the way, in milliseconds: it matches the shortest idle limit of the
 * common proxies, nginx's and an ALB's. A refused or unreachable server fails within seconds.
 */
export const CUT_AFTER_MS = 60_000

/** The statuses a gateway answers with when it cut a call on the way: bad gateway, gateway timeout and Cloudflare's timeout. */
const CUT_STATUSES: ReadonlySet<number> = new Set([502, 504, 524])

/**
 * How long a failed attempt ran when it reads as cut on the way, else undefined: its kind is `network`, or `http` with
 * a gateway's status (502, 504 or 524), and it ran at least `CUT_AFTER_MS`. Facts only, never a message.
 */
export function cutOf(failure: { readonly kind: ProviderErrorKind, readonly status?: number }, attemptMs: number | undefined): number | undefined {
  if (attemptMs === undefined || attemptMs < CUT_AFTER_MS) return undefined
  const gateway = failure.kind === 'http' && failure.status !== undefined && CUT_STATUSES.has(failure.status)
  return failure.kind === 'network' || gateway
    ? attemptMs
    : undefined
}

/** What to do about calls cut on the way: one imperative phrase. */
export const CUT_ADVICE = 'make replies shorter, with a lower maxTokens or partTokens'

/** What a provider found down by calls cut on the way says: how long each ran, the likely cause, and `CUT_ADVICE`. */
export function CUT_FIX(ms: number): string {
  return `each call was cut after about ${elapsedWords(ms)}, likely by a proxy or load balancer on the way: ${CUT_ADVICE}`
}

/** What the words of a provider that is down are made of: facts the code read, never a message a server or a provider wrote. */
export interface DownFacts {
  readonly providerId: string
  readonly kind: ProviderErrorKind
  /** An `http` failure's HTTP status, when it states one. */
  readonly status?: number
  /** How many calls failed: three in a row for a provider found down, fewer for one found spent at the review's end. */
  readonly count: number
  /** True for the calls in a row that found the provider down, false for the calls of a provider spent at the end. */
  readonly streak: boolean
  /** What the last failure lacked, for a `no-answer` kind: `thinking` or `empty`; any other value reads as `empty`. */
  readonly noAnswer?: NoAnswer
  /** The failure says the account's credit, quota or spend limit is used up: the provider is down at its first such failure. */
  readonly exhausted?: true
  /** Every call of the streak was cut on the way (`cutOf`): the shortest of their last attempts, in milliseconds. */
  readonly cutAfterMs?: number
}

/**
 * The words of a provider that is down, so the CLI's progress line and a `ProviderDownError`'s message share
 * one copy: `<id>: <n> calls in a row failed (<kind>[ <status>]): no more calls go to it in this review:
 * <fix>` for the calls in a row, else `<id>: its one call failed (...): <fix>` or `its <n> calls failed`. A
 * provider down by replies with no answer says what they lacked instead: `<id>: <n> calls in a row had no
 * answer, only reasoning: ...` or `had no answer and no reasoning: ...`. A provider whose quota is used up says
 * so, whatever the count, and names `QUOTA_FIX`: `<id>: the account's credit, quota or spend limit is used up
 * (<kind>[ <status>]): no more calls go to it in this review: <fix>`. A provider whose calls were each cut on the
 * way (`cutAfterMs`) names `CUT_FIX` in place of the fix of its kind, after the quota's.
 */
export function downWords(facts: DownFacts): string {
  if (facts.exhausted === true) {
    const used = facts.status === undefined
      ? facts.kind
      : `${facts.kind} ${facts.status}`
    return `${facts.providerId}: the account's credit, quota or spend limit is used up (${used}): no more calls go to it in this review: ${QUOTA_FIX}`
  }
  if (facts.kind === 'no-answer') {
    const lack = facts.noAnswer === 'thinking'
      ? `had no answer, only reasoning: ${THINKING_FIX}`
      : `had no answer and no reasoning: ${EMPTY_FIX}`
    return facts.streak
      ? `${facts.providerId}: ${facts.count} calls in a row ${lack}`
      : `${facts.providerId}: its ${facts.count === 1
        ? 'one call'
        : `${facts.count} calls`} ${lack}`
  }
  const failure = facts.status === undefined
    ? facts.kind
    : `${facts.kind} ${facts.status}`
  const fix = facts.cutAfterMs === undefined
    ? failureFix(facts.kind, facts.status)
    : CUT_FIX(facts.cutAfterMs)
  if (facts.streak) return `${facts.providerId}: ${facts.count} calls in a row failed (${failure}): no more calls go to it in this review: ${fix}`
  return `${facts.providerId}: its ${facts.count === 1
    ? 'one call'
    : `${facts.count} calls`} failed (${failure}): ${fix}`
}

/**
 * A provider's calls stopped: three of its calls in a row failed for a reason of its own, so it is called no
 * more in the review, or, when no research call of any profile answered, every call of its few failed for a
 * reason of its own. The `cause` is the last failure. It is recognised by `instanceof` alone, as `LimitError`
 * is, so a provider cannot raise one, and it is no `ProviderError`: its `kind` and `status` are the facts of
 * the failures it counts, which the message words through `downWords`.
 */
export class ProviderDownError extends QuorumError {
  readonly providerId: string
  readonly kind: ProviderErrorKind
  readonly status: number | undefined
  readonly count: number
  readonly streak: boolean
  /** The failure that found the provider down said its quota is used up. */
  readonly exhausted: boolean
  /** Every counted call was cut on the way: the shortest of their last attempts, in milliseconds. */
  readonly cutAfterMs: number | undefined
  /** What the last failure lacked, for a `no-answer` kind. */
  readonly noAnswer: NoAnswer | undefined

  constructor(facts: DownFacts & { readonly cause?: unknown }) {
    super(downWords(facts), facts.cause === undefined
      ? undefined
      : { cause: facts.cause })
    this.providerId = facts.providerId
    this.kind = facts.kind
    this.status = facts.status
    this.count = facts.count
    this.streak = facts.streak
    this.exhausted = facts.exhausted === true
    this.cutAfterMs = facts.cutAfterMs
    this.noAnswer = facts.noAnswer
  }
}
