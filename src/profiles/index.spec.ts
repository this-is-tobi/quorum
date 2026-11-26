import { describe, expect, it } from 'vitest'
import { profileIssues, profileWarnings } from '../core/profile.ts'
import { bestPracticesProfile } from './best-practices.ts'
import { codeReviewProfile } from './code-review.ts'
import { BUILT_IN, BUILT_IN_IDS, BUILT_IN_PROFILES, UNMEASURED } from './index.ts'
import { performanceProfile } from './performance.ts'
import { securityProfile } from './security.ts'
import { REFUTATION_VOTE } from './vote.ts'

describe('the built-in profiles', () => {
  it('lists security, code-review, best-practices and performance by their own ids, security alone measured', () => {
    expect(BUILT_IN_IDS).toEqual([
      'security',
      'code-review',
      'best-practices',
      'performance',
    ])
    expect(UNMEASURED).toEqual(new Set(['code-review', 'best-practices', 'performance']))
    expect(BUILT_IN.get('code-review')).toBe(codeReviewProfile)
    expect([
      ...BUILT_IN.keys(),
    ]).toEqual(BUILT_IN_IDS)
    expect(BUILT_IN_PROFILES.map(({ profile, measured }) => [profile, measured])).toEqual([
      [securityProfile, true],
      [codeReviewProfile, false],
      [bestPracticesProfile, false],
      [performanceProfile, false],
    ])
    expect(Object.isFrozen(BUILT_IN_PROFILES)).toBe(true)
    expect(BUILT_IN_PROFILES.every(entry => Object.isFrozen(entry))).toBe(true)
  })

  it.each([...BUILT_IN_IDS])('holds %s as a valid profile that warns of nothing, frozen down to its rules', (id) => {
    const profile = BUILT_IN.get(id)
    expect(profile).toBeDefined()
    expect(profileIssues(profile!)).toEqual([])
    expect(profileWarnings(profile!)).toEqual([])
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile!.prompts)).toBe(true)
    expect(Object.isFrozen(profile!.lenses)).toBe(true)
    expect(profile!.lenses.every(lens => Object.isFrozen(lens))).toBe(true)
    expect(Object.isFrozen(profile!.policy)).toBe(true)
    if (profile!.rules !== undefined) {
      expect(Object.isFrozen(profile!.rules)).toBe(true)
      expect(profile!.rules.every(rule => Object.isFrozen(rule))).toBe(true)
    }
  })

  it('shares one vote template across the four profiles', () => {
    expect([
      ...BUILT_IN.values(),
    ].map(profile => profile.prompts.vote)).toEqual(Array.from({ length: 4 }).fill(REFUTATION_VOTE))
    expect(REFUTATION_VOTE).toBe(securityProfile.prompts.vote)
  })
})
