import type { Outcome } from '../core/outcome.ts'
import type { QuorumResult } from '../core/types.ts'

/**
 * What a reporter is told besides the result: whether it may color what it writes, and what the review
 * came to, the one `outcome` the exit code is made from, so a report never says what the exit code does not.
 */
export interface ReportContext {
  readonly color: boolean
  readonly outcome: Outcome
}

/**
 * One way to write a result for a person or a program. It renders the whole report as one text, ending in a
 * line feed, and is pure: it reads what it is given and nothing else.
 */
export interface Reporter {
  readonly render: (result: QuorumResult, context: ReportContext) => string
}
