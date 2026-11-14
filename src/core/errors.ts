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

/** What went wrong with a provider call. `retryable` is derived from it. */
export type ProviderErrorKind
  = | 'http'
    | 'network'
    | 'process'
    | 'timeout'
    | 'aborted'
    | 'refusal'
    | 'truncated'
    | 'invalid-response'
    | 'unsupported'
    | 'too-large'

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
  /** True for network errors, timeouts, 408, 409, 429 and 5xx; a caller may retry the call. */
  readonly retryable: boolean
  /** What the reply the call failed on reported, when the provider read one: the review counts it as the failed call's usage. */
  readonly usage: Usage | undefined

  constructor(details: { providerId: string, kind: ProviderErrorKind, message: string, status?: number, usage?: Usage, cause?: unknown }) {
    super(`${details.providerId}: ${details.message}`, details.cause === undefined
      ? undefined
      : { cause: details.cause })
    this.providerId = details.providerId
    this.kind = details.kind
    this.status = details.status
    this.retryable = isRetryable(details.kind, details.status)
    this.usage = details.usage
  }
}
