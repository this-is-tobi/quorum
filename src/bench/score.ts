/**
 * Scoring a review against a suite case: whether its findings catch the case's bug, and how many kept
 * findings catch nothing. Pure code over a result and a case, so a record can be scored again later.
 */

import type { Finding, QuorumResult, Verdict } from '../core/types.ts'
import type { Location, SuiteCase } from './suite.ts'

/** What one review earned against one case. */
export interface ReviewOutcome {
  /** A kept finding, at any confidence, catches one of the bug's locations; always false for a control. */
  readonly keptCatch: boolean
  /** A finding the finder proposed catches one: a kept one, or one the panel discarded or left unreviewed. */
  readonly proposedCatch: boolean
  /** The kept findings that catch no location: for a control, every kept finding. */
  readonly unmatchedKept: number
  /** The review has a gap or an unreviewed finding, in any profile. */
  readonly incomplete: boolean
}

/**
 * Whether a finding catches a location: the same file, compared exactly as the diff keys it, and a
 * line from `window` lines before the location's start to `window` lines after its end. The window is
 * taken as given, 0 included.
 */
export function catches(finding: Pick<Finding, 'file' | 'line'>, location: Location, window: number): boolean {
  return finding.file === location.file && finding.line >= location.start - window && finding.line <= location.end + window
}

/**
 * Score a review against a case. A bug is caught by a kept finding (`keptCatch`) or by any finding the
 * finder proposed, kept, discarded or unreviewed (`proposedCatch`), within `window` lines of one of its
 * locations. A control has nothing to catch, so every kept finding is unmatched. Every profile of the
 * review counts, for the catches and for the gaps alike.
 */
export function scoreReview(result: QuorumResult, suiteCase: SuiteCase, window: number): ReviewOutcome {
  const incomplete = result.unreviewed.length > 0 || result.meta.incomplete.length > 0
  if (suiteCase.kind === 'control') {
    return {
      keptCatch: false,
      proposedCatch: false,
      unmatchedKept: result.kept.length,
      incomplete,
    }
  }
  const hits = (verdict: Verdict): boolean => suiteCase.locations.some(location => catches(verdict, location, window))
  const keptCatch = result.kept.some(hits)
  const proposedCatch = keptCatch || result.discarded.some(hits) || result.unreviewed.some(hits)
  return {
    keptCatch,
    proposedCatch,
    unmatchedKept: result.kept.filter(verdict => !hits(verdict)).length,
    incomplete,
  }
}
