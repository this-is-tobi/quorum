import { describe, expect, it } from 'vitest'
import { confidenceFor, defaultPolicy, resolvePolicy } from './policy.ts'
import type { Rule } from './policy.ts'

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
    [{ minVotes: 2 }, 3, 2],
    [{ minRatio: 0.66 }, 3, 2],
    [{ minRatio: 0.5 }, 4, 2],
    [{ minRatio: 1 }, 5, 5],
  ] as Array<[Rule, number, number]>)('resolves %j with %i lens(es) to %i vote(s)', (rule, lenses, votes) => {
    expect(resolvePolicy({ high: rule, medium: 'off', low: 'off' }, lenses).thresholds.high).toBe(votes)
  })

  it('reproduces today\'s arithmetic by default with three lenses', () => {
    expect(resolvePolicy(defaultPolicy, 3)).toEqual({ thresholds: { high: 3, medium: 2, low: null }, issues: [], warnings: [] })
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
    const resolved = resolvePolicy({ high: { minVotes: 4 }, medium: { minRatio: 0 }, low: 'off' }, 3)
    expect(resolved.issues.map(issue => issue.path)).toEqual(['policy.high', 'policy.medium'])
  })

  it('rejects a lower level that needs more votes than a higher one', () => {
    const resolved = resolvePolicy({ high: { minVotes: 2 }, medium: 'unanimous', low: 'off' }, 3)
    expect(resolved.issues).toEqual([expect.objectContaining({ path: 'policy.medium' })])
  })

  it('requires at least one enabled level', () => {
    expect(resolvePolicy({ high: 'off', medium: false, low: 'off' }, 3).issues).toEqual([expect.objectContaining({ path: 'policy' })])
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
