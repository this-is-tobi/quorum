import { describe, expect, it } from 'vitest'
import { profileIssues } from './profile.ts'
import type { Profile } from './types.ts'

const valid: Profile = {
  id: 'p',
  prompts: { research: 'Find bugs.', vote: 'Lens {{lens.id}}: {{ lens.question }} ({{panel.size}} voters)' },
  lenses: [{ id: 'a', question: 'A?' }, { id: 'b-2', question: 'B?' }],
}

describe('profileIssues', () => {
  it('accepts a profile whose ids, lenses, policy and templates are valid', () => {
    expect(profileIssues(valid)).toEqual([])
  })

  it.each(['Security', 'Security Review', '', '1st', 'sec.urity'])('refuses the profile id %j and roots the other paths at profile', (id) => {
    expect(profileIssues({ ...valid, id, lenses: [] })).toEqual([
      { path: 'profile.id', message: `must match ^[a-z][a-z0-9_-]*$, got ${JSON.stringify(id)}` },
      { path: 'profile.lenses', message: 'at least one lens is required' },
    ])
  })

  it.each(['Security', 'aB', 'a.b', 'a}}{{x'])('refuses the lens id %j', (id) => {
    expect(profileIssues({ ...valid, lenses: [{ id, question: 'Q?' }] })).toEqual([
      { path: 'p.lenses.0.id', message: `must match ^[a-z][a-z0-9_-]*$, got ${JSON.stringify(id)}` },
    ])
  })

  it('refuses an invalid or repeated lens id and an empty question', () => {
    const lenses = [{ id: 'a', question: 'A?' }, { id: 'Bad Id', question: 'B?' }, { id: 'a', question: '  ' }]
    expect(profileIssues({ ...valid, lenses })).toEqual([
      { path: 'p.lenses.1.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Bad Id"' },
      { path: 'p.lenses.2.id', message: 'repeats the lens id "a"' },
      { path: 'p.lenses.2.question', message: 'must not be empty' },
    ])
  })

  it('refuses a policy that does not resolve for the lens count', () => {
    const issues = profileIssues({ ...valid, policy: { high: { minVotes: 3 }, medium: 'off', low: 'off' } })
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('p.policy.high')
  })

  it('refuses any variable in the research template, with its own reason for {{diff}}', () => {
    const research = 'Review {{diff}} with {{ lens.id }}, then {{diff}} again.'
    expect(profileIssues({ ...valid, prompts: { ...valid.prompts, research } })).toEqual([
      { path: 'p.prompts.research', message: '{{diff}} is not allowed: the diff is appended automatically as fenced data' },
      { path: 'p.prompts.research', message: '{{lens.id}} is not allowed: the research template takes no variables' },
    ])
  })

  it('refuses a vote variable outside the allowlist, a typo included, once per name', () => {
    const vote = '{{lens.id}} {{lens-id}} {{lens.name}} {{lens-id}} {{diff}}'
    expect(profileIssues({ ...valid, prompts: { ...valid.prompts, vote } })).toEqual([
      { path: 'p.prompts.vote', message: '{{lens-id}} is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
      { path: 'p.prompts.vote', message: '{{lens.name}} is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
      { path: 'p.prompts.vote', message: '{{diff}} is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
    ])
  })

  it('reports every issue at once, in order', () => {
    const profile: Profile = { id: 'Security', prompts: { research: '{{diff}}', vote: '' }, lenses: [{ id: 'Bad Id', question: 'A?' }, { id: 'Bad Id', question: 'B?' }] }
    expect(profileIssues(profile)).toEqual([
      { path: 'profile.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Security"' },
      { path: 'profile.lenses.0.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Bad Id"' },
      { path: 'profile.lenses.1.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Bad Id"' },
      { path: 'profile.prompts.research', message: '{{diff}} is not allowed: the diff is appended automatically as fenced data' },
      { path: 'profile.prompts.vote', message: 'must not be empty' },
    ])
  })

  it('refuses an empty template', () => {
    expect(profileIssues({ ...valid, prompts: { research: ' ', vote: '' } })).toEqual([
      { path: 'p.prompts.research', message: 'must not be empty' },
      { path: 'p.prompts.vote', message: 'must not be empty' },
    ])
  })
})
