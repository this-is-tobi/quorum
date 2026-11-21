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
  'invalid-response',
  'unsupported',
  'too-large',
] as const

/** What went wrong with a provider call. `retryable` is derived from it, unless the adapter sets it. */
export type ProviderErrorKind = typeof PROVIDER_ERROR_KINDS[number]

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
  /** The wait the server asked for at least, in milliseconds, when the adapter read one. */
  readonly retryAfterMs: number | undefined
  /** What the reply the call failed on reported, when the provider read one: the review counts it as the failed call's usage. */
  readonly usage: Usage | undefined

  constructor(details: { providerId: string, kind: ProviderErrorKind, message: string, status?: number, retryable?: boolean, retryAfterMs?: number, usage?: Usage, cause?: unknown }) {
    super(`${details.providerId}: ${details.message}`, details.cause === undefined
      ? undefined
      : { cause: details.cause })
    this.providerId = details.providerId
    this.kind = details.kind
    this.status = details.status
    this.retryable = details.retryable ?? isRetryable(details.kind, details.status)
    this.retryAfterMs = details.retryAfterMs
    this.usage = details.usage
  }
}

/** What to do about a provider whose calls ended with `kind`, and for an `http` failure its `status`: one imperative phrase, never a word a server wrote. */
function downFix(kind: ProviderErrorKind, status: number | undefined): string {
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
}

/**
 * The words of a provider that is down, so the CLI's progress line and a `ProviderDownError`'s message share
 * one copy: `<id>: <n> calls in a row failed (<kind>[ <status>]): no more calls go to it in this review:
 * <fix>` for the calls in a row, else `<id>: its one call failed (...): <fix>` or `its <n> calls failed`.
 */
export function downWords(facts: DownFacts): string {
  const failure = facts.status === undefined
    ? facts.kind
    : `${facts.kind} ${facts.status}`
  const fix = downFix(facts.kind, facts.status)
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

  constructor(facts: DownFacts & { readonly cause?: unknown }) {
    super(downWords(facts), facts.cause === undefined
      ? undefined
      : { cause: facts.cause })
    this.providerId = facts.providerId
    this.kind = facts.kind
    this.status = facts.status
    this.count = facts.count
    this.streak = facts.streak
  }
}
