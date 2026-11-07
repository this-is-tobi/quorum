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

/** Invalid configuration or usage, carrying every issue at once. The CLI maps it to exit code 2. */
export class ConfigError extends QuorumError {
  readonly issues: readonly ConfigIssue[]

  constructor(issues: readonly ConfigIssue[]) {
    super(issues.map(issue => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('\n'))
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

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429])

function isRetryable(kind: ProviderErrorKind, status: number | undefined): boolean {
  if (kind === 'network' || kind === 'timeout') return true
  return kind === 'http' && status !== undefined && (RETRYABLE_STATUSES.has(status) || status >= 500)
}

/**
 * A provider call that failed. The message starts with the provider id. Adapters never put request
 * headers, keys or the runtime's own error text in it; they quote server text through `snippet`.
 */
export class ProviderError extends QuorumError {
  readonly providerId: string
  readonly kind: ProviderErrorKind
  readonly status: number | undefined
  /** True for network errors, timeouts, 408, 409, 429 and 5xx; a caller may retry the call. */
  readonly retryable: boolean

  constructor(details: { providerId: string, kind: ProviderErrorKind, message: string, status?: number, cause?: unknown }) {
    super(`${details.providerId}: ${details.message}`, details.cause === undefined ? undefined : { cause: details.cause })
    this.providerId = details.providerId
    this.kind = details.kind
    this.status = details.status
    this.retryable = isRetryable(details.kind, details.status)
  }
}
