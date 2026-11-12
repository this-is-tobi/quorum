import { describe, expect, it } from 'vitest'
import { confidenceFor, defaultPolicy, resolvePolicy, undecidedLevel, verdictStatus } from './policy.ts'
import type { PolicyRules, Rule } from './policy.ts'
import type { Verdict } from './types.ts'

/** A panel's ballots: true or false for a cast vote, null for one that failed. */
function ballots(...outcomes: Array<boolean | null>): Pick<Verdict, 'keptVotes' | 'votes'> {
  return {
    keptVotes: outcomes.filter(keep => keep === true).length,
    votes: outcomes.map(keep => (keep === null
      ? { angle: 'impact' as const, vote: null, error: 'endpoint down' }
      : {
          angle: 'impact' as const,
          vote: { keep, reasoning: 'r' },
          error: null,
        })),
  }
}

describe('resolvePolicy', () => {
  it.each([
    ['unanimous', 1, 1],
    ['unanimous', 2, 2],
    ['unanimous', 3, 3],
    ['unanimous', 5, 5],
    ['majority', 1, 1],
    ['majority', 2, 2],
    ['majority', 3, 2],
    ['majority', 5, 3],
    ['any', 3, 1],
    [
      { minVotes: 2 },
      3,
      2,
    ],
    [
      { minRatio: 0.66 },
      3,
      2,
    ],
    [
      { minRatio: 0.5 },
      4,
      2,
    ],
    [
      { minRatio: 1 },
      5,
      5,
    ],
    [
      { minRatio: 1e-10 },
      3,
      1,
    ],
    [
      { minRatio: 0.07 },
      100,
      7,
    ],
  ] as Array<[Rule, number, number]>)('resolves %j with %i lens(es) to %i vote(s)', (rule, lenses, votes) => {
    expect(resolvePolicy({ high: rule, medium: 'off', low: 'off' }, lenses).thresholds.high).toBe(votes)
  })

  it('reproduces today\'s arithmetic by default with three lenses', () => {
    expect(resolvePolicy(defaultPolicy, 3)).toEqual({
      thresholds: { high: 3, medium: 2, low: null },
      issues: [],
      warnings: [],
    })
  })

  it('accepts false as a synonym of off', () => {
    expect(resolvePolicy({ high: 'unanimous', medium: false, low: false }, 3).thresholds).toEqual({ high: 3, medium: null, low: null })
  })

  it('warns, without failing, when a level can never apply', () => {
    const resolved = resolvePolicy(defaultPolicy, 2)
    expect(resolved.issues).toEqual([])
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0]).toMatch(/policy\.medium/)
  })

  it('rejects out-of-range rules', () => {
    const resolved = resolvePolicy({
      high: { minVotes: 4 },
      medium: { minRatio: 0 },
      low: 'off',
    }, 3)
    expect(resolved.issues.map(issue => issue.path)).toEqual(['policy.high', 'policy.medium'])
    expect(resolvePolicy({
      high: { minVotes: 1.5 },
      medium: { minRatio: 1.01 },
      low: { minVotes: 0 },
    }, 3).issues.map(issue => issue.path)).toEqual(['policy.high', 'policy.medium', 'policy.low'])
  })

  it('rejects a lower level that needs more votes than a higher one', () => {
    const resolved = resolvePolicy({
      high: { minVotes: 2 },
      medium: 'unanimous',
      low: 'off',
    }, 3)
    expect(resolved.issues).toEqual([
      expect.objectContaining({ path: 'policy.medium' }),
    ])
  })

  it('requires at least one enabled level', () => {
    expect(resolvePolicy({ high: 'off', medium: false, low: 'off' }, 3).issues).toEqual([
      expect.objectContaining({ path: 'policy' }),
    ])
  })

  it('reports a rule outside the type as an issue instead of throwing', () => {
    const rules = {
      high: 'unanimus',
      medium: null,
      low: { minRatio: '0.5' },
    } as unknown as PolicyRules
    expect(resolvePolicy(rules, 3).issues.map(issue => issue.path)).toEqual(['policy.high', 'policy.medium', 'policy.low'])
  })

  it('rejects a rule that holds both minVotes and minRatio', () => {
    expect(resolvePolicy({
      high: { minVotes: 2, minRatio: 1 } as unknown as Rule,
      medium: 'off',
      low: 'off',
    }, 3).issues).toEqual([
      expect.objectContaining({ path: 'policy.high' }),
    ])
  })

  it('requires at least one lens', () => {
    expect(resolvePolicy(defaultPolicy, 0)).toEqual({
      thresholds: { high: null, medium: null, low: null },
      issues: [
        { path: 'lenses', message: 'at least one lens is required' },
      ],
      warnings: [],
    })
  })

  it('checks the order across every enabled level', () => {
    expect(resolvePolicy({
      high: 'any',
      medium: 'off',
      low: { minVotes: 2 },
    }, 3).issues).toEqual([
      expect.objectContaining({ path: 'policy.low' }),
    ])
    expect(resolvePolicy({
      high: 'unanimous',
      medium: { minVotes: 2 },
      low: 'unanimous',
    }, 3).issues).toEqual([
      expect.objectContaining({ path: 'policy.low' }),
    ])
  })
})

describe('confidenceFor', () => {
  const thresholds = { high: 3, medium: 2, low: 1 }

  it('picks the highest level the vote count reaches', () => {
    expect(confidenceFor(3, thresholds)).toBe('high')
    expect(confidenceFor(2, thresholds)).toBe('medium')
    expect(confidenceFor(1, thresholds)).toBe('low')
  })

  it('returns undefined when no enabled level is reached', () => {
    expect(confidenceFor(0, thresholds)).toBeUndefined()
    expect(confidenceFor(1, { high: 3, medium: 2, low: null })).toBeUndefined()
  })
})

describe('verdictStatus', () => {
  const thresholds = { high: 3, medium: 2, low: null }

  it('keeps a finding that reaches a level even though another vote failed', () => {
    expect(verdictStatus(ballots(true, true, null), thresholds)).toBe('kept')
  })

  it('reports a finding unreviewed when its failed votes could have lifted it to a level', () => {
    expect(verdictStatus(ballots(true, null, null), thresholds)).toBe('unreviewed')
    expect(verdictStatus(ballots(true, false, null), thresholds)).toBe('unreviewed')
    expect(verdictStatus(ballots(null, null, null), thresholds)).toBe('unreviewed')
  })

  it('discards a finding whose failed votes could not have changed the outcome', () => {
    expect(verdictStatus(ballots(false, false, null), thresholds)).toBe('discarded')
    expect(verdictStatus(ballots(false, false, false), thresholds)).toBe('discarded')
  })

  it('measures the failed votes against the lowest enabled level', () => {
    expect(verdictStatus(ballots(false, false, null), { high: 3, medium: 2, low: 1 })).toBe('unreviewed')
  })
})

describe('undecidedLevel', () => {
  const thresholds = { high: 3, medium: 2, low: null }

  it('names the level a failed vote could still have reached above the earned one', () => {
    expect(undecidedLevel({
      ...ballots(true, true, null),
      confidence: 'medium',
    }, thresholds)).toBe('high')
    expect(undecidedLevel({
      ...ballots(true, null, null),
      confidence: 'low',
    }, { high: 3, medium: 2, low: 1 })).toBe('high')
  })

  it('returns undefined when every vote was cast or the failed votes could not change the level', () => {
    expect(undecidedLevel({
      ...ballots(true, true, true),
      confidence: 'high',
    }, thresholds)).toBeUndefined()
    expect(undecidedLevel({
      ...ballots(true, true, false),
      confidence: 'medium',
    }, thresholds)).toBeUndefined()
    expect(undecidedLevel({
      ...ballots(true, true, null),
      confidence: 'medium',
    }, { high: null, medium: 2, low: null })).toBeUndefined()
  })
})
