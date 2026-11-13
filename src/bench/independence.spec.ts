import { describe, expect, it } from 'vitest'
import { independence } from './independence.ts'
import type { JudgedFinding } from './score.ts'

/** A finding of known truth whose lenses (reachability, impact, defenses, in that order) erred as `errors` says; null leaves a lens out. */
function judged(errors: readonly (boolean | null)[], profile = 'security', lenses = 3): JudgedFinding {
  const ids = ['reachability', 'impact', 'defenses']
  return {
    profile,
    lenses,
    errors: new Map(errors.flatMap((erred, index) => erred === null
      ? []
      : [
          [ids[index], erred] as const,
        ])),
  }
}

describe('independence', () => {
  it('averages phi over the pairs of lenses whose errors both vary, over the findings both voted on', () => {
    const result = independence([
      ...Array.from({ length: 4 }, () => judged([true, true, false])),
      ...Array.from({ length: 4 }, () => judged([false, false, false])),
      judged([true, false, false]),
      judged([null, true, false]),
    ])
    expect(result).toMatchObject({ findings: 10, pairs: 1, lenses: 3 })
    expect(result.meanPhi).toBeCloseTo(0.8, 10)
    expect(result.effectiveVotes).toBeCloseTo(3 / 2.6, 10)
  })

  it('gives no mean when no pair varies, and no effective number when the panels differ in size, keeping two profiles\' pairs apart', () => {
    expect(independence([
      judged([false, false, false]),
      judged([true, false, false]),
    ])).toEqual({
      findings: 2,
      pairs: 0,
      meanPhi: null,
      lenses: 3,
      effectiveVotes: null,
    })
    expect(independence([
      judged([true, true, false]),
      judged([false, false, false]),
      judged([true, true], 'team', 2),
      judged([false, false], 'team', 2),
    ])).toEqual({
      findings: 4,
      pairs: 2,
      meanPhi: 1,
      lenses: null,
      effectiveVotes: null,
    })
  })

  it('holds nothing for no finding of known truth', () => {
    expect(independence([])).toEqual({
      findings: 0,
      pairs: 0,
      meanPhi: null,
      lenses: null,
      effectiveVotes: null,
    })
  })
})
