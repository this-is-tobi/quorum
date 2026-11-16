import { ConfigError } from '../core/errors.ts'
import { outcome } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import type { QuorumResult } from '../core/types.ts'
import { brief } from './brief.ts'
import { json } from './json.ts'
import type { Reporter } from './reporter.ts'

/** The reporters by name, in the order the messages list them. A new one is a module and a line here. */
export const REPORTERS = { json, brief } as const satisfies Readonly<Record<string, Reporter>>

/** The name of a reporter: what `--format` takes and `renderReport` renders. */
export type ReportFormat = keyof typeof REPORTERS

/** The names of the reporters, in the order the messages list them. */
export const REPORT_FORMATS: readonly ReportFormat[] = Object.keys(REPORTERS) as ReportFormat[]

/** Whether `name` is the name of a reporter: an own key of `REPORTERS`, so `toString` and `__proto__` are none. */
export function isReportFormat(name: unknown): name is ReportFormat {
  return typeof name === 'string' && Object.hasOwn(REPORTERS, name)
}

/** The formats as a message lists them: `, ` between them and ` or ` before the last, as `json or brief`. */
export function formatWords(): string {
  const last = REPORT_FORMATS.at(-1)
  return REPORT_FORMATS.length < 2
    ? REPORT_FORMATS.join('')
    : `${REPORT_FORMATS.slice(0, -1).join(', ')} or ${last}`
}

/** What `renderReport` takes besides the result. */
export interface ReportOptions {
  /** The reporter to render with. */
  readonly format: ReportFormat
  /** Whether the report may color what it writes; `false` when unset. `json` and `brief` never color. */
  readonly color?: boolean
  /** What the review came to, which the report says; `outcome(result)` when unset. */
  readonly outcome?: Outcome
}

/**
 * Render a review's result as the report `options.format` names, a text that ends in a line feed, as the CLI
 * writes it on stdout. It reads the result, as `review` returns it, and `options`, and nothing else, so it is
 * pure. The report says what the exit code says: it states the `outcome` it is given, else the one `outcome`
 * computes from the result, which has no `allowIncomplete`, so a caller whose run lifted gaps passes its own.
 * `color` is `false` unless asked.
 *
 * @throws ConfigError at `format` when it names no reporter
 *
 * @example
 * const report = renderReport(result, { format: 'brief', outcome: outcome(result, { allowIncomplete: true }) })
 */
export function renderReport(result: QuorumResult, options: ReportOptions): string {
  const { format } = options
  if (!isReportFormat(format)) {
    throw new ConfigError([
      { path: 'format', message: `must be ${formatWords()}` },
    ])
  }
  return REPORTERS[format].render(result, {
    color: options.color ?? false,
    outcome: options.outcome ?? outcome(result),
  })
}
