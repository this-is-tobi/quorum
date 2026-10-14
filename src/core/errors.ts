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
