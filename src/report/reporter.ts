import type { Outcome } from '../core/outcome.ts'
import type { PublicView, QuorumResult } from '../core/types.ts'

/**
 * What a reporter is told besides the result: whether it may color what it writes, and what the review
 * came to, the one `outcome` the exit code is made from, so a report never says what the exit code does not.
 */
export interface ReportContext {
  readonly color: boolean
  readonly outcome: Outcome
}

/** What a reporter renders: a result, or its public view (see `publicView`), which every reporter reads as the result it came from. */
export type ReportInput = QuorumResult | PublicView

/**
 * One way to write a result for a person or a program. It renders the whole report as one text, ending in a
 * line feed, and is pure: it reads what it is given and nothing else. A reporter marked `publicOnly` writes
 * what a stranger may read, so it renders `publicView(input)` itself, whatever it is given.
 */
export interface Reporter {
  readonly render: (input: ReportInput, context: ReportContext) => string
  readonly publicOnly?: true
}
