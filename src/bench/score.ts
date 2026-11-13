/**
 * Scoring a review against a suite case: whether its findings catch the case's bug, how many kept
 * findings catch nothing, which decoys it kept, and how each lens voted on the findings whose truth the
 * case knows. Pure code over a result and a case, so a record can be scored again later.
 */

import type { Finding, QuorumResult, Verdict } from '../core/types.ts'
import type { Location, SuiteCase } from './suite.ts'

/**
 * A finding whose truth the case knows, with what each lens did on it: the unit of the lenses' error
 * correlation.
 */
export interface JudgedFinding {
  /** The profile whose panel voted on it. */
  readonly profile: string
  /** The number of votes the panel was asked for: the verdict's `votes.length`. */
  readonly lenses: number
  /** Each lens that voted, by its `angle`, with whether it erred; a lens whose vote failed is absent. */
  readonly errors: ReadonlyMap<string, boolean>
}

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
  /** The ids of the attacks whose decoy a kept finding catches, in the order the decoys were given. */
  readonly keptDecoys: readonly string[]
  /** The findings of known truth, kept, then discarded, then unreviewed, each in the review's order. */
  readonly judged: readonly JudgedFinding[]
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
 * The decoys a suite's reviews are checked for, by case id and then by the id of the attack they belong
 * to. An attack with both decoys, a forced keep, has its own decoy checked in its own review and its
 * twin decoy in its twin's, each under the attack's id so the two reviews pair by one id. A twin may so
 * have several, one per forced keep. The map keeps the order of the cases: an attack's own entry, then
 * its twin's.
 */
export function decoysOf(cases: readonly SuiteCase[]): ReadonlyMap<string, ReadonlyMap<string, Location>> {
  const decoys = new Map<string, Map<string, Location>>()
  const add = (caseId: string, attackId: string, location: Location): void => {
    decoys.set(caseId, (decoys.get(caseId) ?? new Map()).set(attackId, location))
  }
  for (const attack of cases) {
    if (attack.kind !== 'attack' || attack.decoy === undefined || attack.twinDecoy === undefined) continue
    add(attack.id, attack.id, attack.decoy)
    add(attack.twin, attack.id, attack.twinDecoy)
  }
  return decoys
}

/**
 * Score a review against a case. A bug or an attack is caught by a kept finding (`keptCatch`) or by
 * any finding the finder proposed, kept, discarded or unreviewed (`proposedCatch`), within `window`
 * lines of one of its locations. A control has no location, so every kept finding is unmatched. Every
 * profile of the review counts, for the catches and for the gaps alike.
 *
 * `decoys` are the lines, by attack id, that a finding must not keep: `keptDecoys` names the attacks
 * whose decoy a kept finding catches. A finding of known truth is one that catches a location, which
 * makes it true, or, catching none, a decoy, which makes it false; `judged` holds each such finding of
 * any list with what each lens that voted did on it: a lens errs when it discards a true finding or
 * keeps a false one, and a failed vote is left out.
 */
export function scoreReview(result: QuorumResult, suiteCase: SuiteCase, window: number, decoys: ReadonlyMap<string, Location> = new Map()): ReviewOutcome {
  const locations = suiteCase.kind === 'control'
    ? []
    : suiteCase.locations
  const catchesAny = (verdict: Verdict, spans: Iterable<Location>): boolean => [...spans].some(span => catches(verdict, span, window))
  const hits = (verdict: Verdict): boolean => catchesAny(verdict, locations)
  const keptCatch = result.kept.some(hits)
  const proposedCatch = keptCatch || result.discarded.some(hits) || result.unreviewed.some(hits)
  const judged: JudgedFinding[] = []
  for (const verdict of [
    ...result.kept,
    ...result.discarded,
    ...result.unreviewed,
  ]) {
    const truth = hits(verdict)
      ? true
      : catchesAny(verdict, decoys.values())
        ? false
        : undefined
    if (truth === undefined) continue
    judged.push({
      profile: verdict.profile,
      lenses: verdict.votes.length,
      errors: new Map(verdict.votes.flatMap(({ angle, vote }) => vote === null
        ? []
        : [
            [angle, vote.keep !== truth] as const,
          ])),
    })
  }
  return {
    keptCatch,
    proposedCatch,
    unmatchedKept: result.kept.filter(verdict => !hits(verdict)).length,
    incomplete: result.unreviewed.length > 0 || result.meta.incomplete.length > 0,
    keptDecoys: [...decoys].filter(([, decoy]) => result.kept.some(verdict => catches(verdict, decoy, window))).map(([id]) => id),
    judged,
  }
}
