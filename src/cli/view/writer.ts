/**
 * What every way of showing a review shares: the writer the CLI hands the review's events and every line it
 * writes on stderr after its flags, at a level, so one object owns what the terminal or the log shows.
 */

import type { EventSink } from '../../core/ports.ts'
import type { QuorumResult } from '../../core/types.ts'
import type { ReportFormat } from '../../report/registry.ts'
import type { ViewFacts } from './model.ts'

/** What a CLI line is: a warning of the config or the store, the banner, a path review's estimate, a notice, or an error. */
export type LineLevel = 'warning' | 'banner' | 'estimate' | 'notice' | 'error'

/**
 * What the CLI knows once the report is written, which no event says: where the report went, the formats of the
 * `--output` files (never their paths), and the result, whose `meta` gives the totals. The text report is above the
 * summary only when stdout and stderr are both terminals: with stderr in a log, nothing is above its lines.
 */
export interface SummaryFacts {
  readonly stdout: { readonly format: ReportFormat, readonly terminal: boolean }
  readonly stderr: { readonly terminal: boolean }
  readonly outputs: readonly ReportFormat[]
  readonly result: Pick<QuorumResult, 'unreviewed' | 'meta'>
}

/**
 * The stream a writer draws on: `process.stderr`, and the fake terminal of the specs. `write` calls `done` once the
 * text has been handed on; the size is read afresh at each frame, and a stream with no size is 80 by 24.
 */
export interface ViewStream {
  readonly write: (text: string, done?: () => void) => unknown
  readonly isTTY?: boolean
  readonly columns?: number
  readonly rows?: number
  readonly on?: (event: 'resize', listener: () => void) => unknown
  readonly off?: (event: 'resize', listener: () => void) => unknown
}

export interface ViewWriter {
  /** The sink the review's events go to. */
  readonly sink: EventSink
  /** Writes one line of the CLI's own, inert, at a level. */
  readonly line: (level: LineLevel, text: string) => void
  /** Sets the facts of the review about to run. */
  readonly begin: (facts: ViewFacts) => void
  /** Writes the summary once, after the report and the `--output` files, and nothing for a review whose stages never started. */
  readonly summary: (facts: SummaryFacts) => void
  /** Stops the writer's timers; the promise resolves once what it wrote has drained. */
  readonly close: () => Promise<void>
  /** Cancels every timer the writer armed and leaves the terminal as it found it; idempotent and synchronous. */
  readonly restore: () => void
}
