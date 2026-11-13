/**
 * How far the lenses' errors go together: the security model's "Independence". A finding whose truth
 * the suite knows is put to every lens of its panel, and a lens errs when it discards a true finding or
 * keeps a false one. Lenses whose errors correlate add less than a vote each, so the correlation says
 * how many independent votes a panel is worth.
 */

import type { JudgedFinding } from './score.ts'
import { effectiveVotes, phi } from './stats.ts'
import type { ErrorTable } from './stats.ts'

/** The lenses' error correlation over a set of findings of known truth. */
export interface Independence {
  /** The findings of known truth counted. */
  readonly findings: number
  /** The pairs of lenses whose errors both vary, which the mean is over. */
  readonly pairs: number
  /** The mean phi over those pairs; null when no pair varies. */
  readonly meanPhi: number | null
  /** The number of votes every finding was put to; null when they differ or there is no finding. */
  readonly lenses: number | null
  /** What `lenses` votes are worth at that mean phi; null when either is unknown, or the mean has none. */
  readonly effectiveVotes: number | null
}

type Counts = { -readonly [Cell in keyof ErrorTable]: number }

/**
 * Measure the lenses' error correlation over `findings`, which are pooled: the unit is the finding, so
 * the reviews of a configuration count together. One table per pair of lenses, keyed by the profile
 * and the two lens ids, counts the findings both lenses voted on, a failed vote left out; phi is taken
 * per table and averaged over the pairs where it is defined (a lens whose errors never vary leaves its
 * pairs out). No interval is given, as the spec gives none.
 */
export function independence(findings: readonly JudgedFinding[]): Independence {
  const tables = new Map<string, Counts>()
  for (const { profile, errors } of findings) {
    const ids = [
      ...errors.keys(),
    ].toSorted()
    for (const [position, first] of ids.entries()) {
      for (const second of ids.slice(position + 1)) {
        const key = JSON.stringify([profile, first, second])
        const table = tables.get(key) ?? {
          both: 0,
          onlyFirst: 0,
          onlySecond: 0,
          neither: 0,
        }
        const erredFirst = errors.get(first)
        const erredSecond = errors.get(second)
        if (erredFirst && erredSecond) table.both++
        else if (erredFirst) table.onlyFirst++
        else if (erredSecond) table.onlySecond++
        else table.neither++
        tables.set(key, table)
      }
    }
  }
  const phis = [
    ...tables.values(),
  ].flatMap((table) => {
    const value = phi(table)
    return value === undefined
      ? []
      : [value]
  })
  const meanPhi = phis.length === 0
    ? null
    : phis.reduce((sum, value) => sum + value, 0) / phis.length
  const lenses = findings.length > 0 && findings.every(finding => finding.lenses === findings[0].lenses)
    ? findings[0].lenses
    : null
  return {
    findings: findings.length,
    pairs: phis.length,
    meanPhi,
    lenses,
    effectiveVotes: lenses === null || meanPhi === null
      ? null
      : effectiveVotes(lenses, meanPhi) ?? null,
  }
}
