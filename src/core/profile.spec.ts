import { describe, expect, it } from 'vitest'
import { securityProfile } from '../profiles/security.ts'
import { defaultPolicy } from './policy.ts'
import { profileIssues, profileWarnings, thresholdsFor } from './profile.ts'
import { PLACEHOLDER } from './prompts.ts'
import type { Profile } from './types.ts'

const valid: Profile = {
  id: 'p',
  prompts: { research: 'Find bugs.', vote: 'Lens {{lens.id}}: {{ lens.question }} ({{panel.size}} voters)' },
  lenses: [
    { id: 'a', question: 'A?' },
    { id: 'b-2', question: 'B?' },
  ],
}

describe('profileIssues', () => {
  it('accepts a profile whose ids, lenses, policy and templates are valid', () => {
    expect(profileIssues(valid)).toEqual([])
  })

  it.each([
    'Security',
    'Security Review',
    '',
    '1st',
    'sec.urity',
  ])('refuses the profile id %j and roots the other paths at profile', (id) => {
    expect(profileIssues({ ...valid, id, lenses: [] })).toEqual([
      { path: 'profile.id', message: `must match ^[a-z][a-z0-9_-]*$, got ${JSON.stringify(id)}` },
      { path: 'profile.lenses', message: 'at least one lens is required' },
    ])
  })

  it.each(['Security', 'aB', 'a.b', 'a}}{{x'])('refuses the lens id %j', (id) => {
    expect(profileIssues({
      ...valid,
      lenses: [
        { id, question: 'Q?' },
      ],
    })).toEqual([
      { path: 'p.lenses.0.id', message: `must match ^[a-z][a-z0-9_-]*$, got ${JSON.stringify(id)}` },
    ])
  })

  it.each([undefined, null, 7])('refuses the profile id %j when it is not a string', (id) => {
    expect(profileIssues({ ...valid, id } as unknown as Profile)).toEqual([
      { path: 'profile.id', message: `must match ^[a-z][a-z0-9_-]*$, got ${JSON.stringify(id)}` },
    ])
  })

  it.each([undefined, null])('refuses the lens id %j when it is not a string', (id) => {
    const lenses = [
      { id, question: 'Q?' },
    ] as unknown as Profile['lenses']
    expect(profileIssues({ ...valid, lenses })).toEqual([
      { path: 'p.lenses.0.id', message: `must match ^[a-z][a-z0-9_-]*$, got ${JSON.stringify(id)}` },
    ])
  })

  it('refuses every lens without an id as invalid, not as a repeat', () => {
    const lenses = [
      { question: 'A?' },
      { question: 'B?' },
    ] as unknown as Profile['lenses']
    expect(profileIssues({ ...valid, lenses })).toEqual([
      { path: 'p.lenses.0.id', message: 'must match ^[a-z][a-z0-9_-]*$, got undefined' },
      { path: 'p.lenses.1.id', message: 'must match ^[a-z][a-z0-9_-]*$, got undefined' },
    ])
  })

  it('refuses an invalid or repeated lens id and an empty question', () => {
    const lenses = [
      { id: 'a', question: 'A?' },
      { id: 'Bad Id', question: 'B?' },
      { id: 'a', question: '  ' },
    ]
    expect(profileIssues({ ...valid, lenses })).toEqual([
      { path: 'p.lenses.1.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Bad Id"' },
      { path: 'p.lenses.2.id', message: 'repeats the lens id "a"' },
      { path: 'p.lenses.2.question', message: 'must not be empty' },
    ])
  })

  it('refuses a policy that does not resolve for the lens count', () => {
    const issues = profileIssues({
      ...valid,
      policy: {
        high: { minVotes: 3 },
        medium: 'off',
        low: 'off',
      },
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('p.policy.high')
  })

  it('refuses any variable in the research template, with its own reason for {{diff}}', () => {
    const research = 'Review {{diff}} with {{ lens.id }}, then {{diff}} again.'
    expect(profileIssues({
      ...valid,
      prompts: { ...valid.prompts, research },
    })).toEqual([
      { path: 'p.prompts.research', message: '{{diff}} is not allowed: the diff is appended automatically as fenced data' },
      { path: 'p.prompts.research', message: '{{lens.id}} is not allowed: the research template takes no variables' },
    ])
  })

  it('still refuses {{diff}} in the research template after a stray test() moved the shared regex', () => {
    try {
      PLACEHOLDER.test('xx {{diff}}')
      expect(PLACEHOLDER.lastIndex).toBeGreaterThan(0)
      expect(profileIssues({
        ...valid,
        prompts: { ...valid.prompts, research: '{{diff}}' },
      })).toEqual([
        { path: 'p.prompts.research', message: '{{diff}} is not allowed: the diff is appended automatically as fenced data' },
      ])
    } finally {
      PLACEHOLDER.lastIndex = 0
    }
  })

  it('refuses a vote variable outside the allowlist, a typo included, once per name', () => {
    const vote = '{{lens.id}} {{lens-id}} {{lens.name}} {{lens-id}} {{diff}}'
    expect(profileIssues({
      ...valid,
      prompts: { ...valid.prompts, vote },
    })).toEqual([
      { path: 'p.prompts.vote', message: '{{lens-id}} is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
      { path: 'p.prompts.vote', message: '{{lens.name}} is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
      { path: 'p.prompts.vote', message: '{{diff}} is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
    ])
  })

  it('reports every issue at once, in order', () => {
    const profile: Profile = {
      id: 'Security',
      prompts: { research: '{{diff}}', vote: '' },
      lenses: [
        { id: 'Bad Id', question: 'A?' },
        { id: 'Bad Id', question: 'B?' },
      ],
    }
    expect(profileIssues(profile)).toEqual([
      { path: 'profile.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Security"' },
      { path: 'profile.lenses.0.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Bad Id"' },
      { path: 'profile.lenses.1.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Bad Id"' },
      { path: 'profile.prompts.research', message: '{{diff}} is not allowed: the diff is appended automatically as fenced data' },
      { path: 'profile.prompts.vote', message: 'must not be empty' },
    ])
  })

  it('refuses an empty template', () => {
    expect(profileIssues({
      ...valid,
      prompts: { research: ' ', vote: '' },
    })).toEqual([
      { path: 'p.prompts.research', message: 'must not be empty' },
      { path: 'p.prompts.vote', message: 'must not be empty' },
    ])
  })

  it('reports a malformed profile from an untyped caller as issues, never a TypeError', () => {
    const loose = {
      id: 'loose',
      prompts: { research: 1 },
      lenses: [
        { id: 'one' },
        'two',
      ],
      policy: 'strict',
      gating: 'yes',
      guidelines: 42,
    } as unknown as Profile
    expect(profileIssues(loose)).toEqual([
      { path: 'loose.lenses.0.question', message: 'must be a string' },
      { path: 'loose.lenses.1', message: 'must be an object with an id and a question' },
      { path: 'loose.policy', message: 'must be an object with high, medium and low rules' },
      { path: 'loose.prompts.research', message: 'must be a string' },
      { path: 'loose.prompts.vote', message: 'must be a string' },
      { path: 'loose.gating', message: 'must be true or false' },
      { path: 'loose.guidelines', message: 'must be a string' },
    ])
  })

  it('reports missing prompts and lenses as issues', () => {
    expect(profileIssues({ id: 'bare' } as unknown as Profile)).toEqual([
      { path: 'bare.lenses', message: 'must be an array of lenses' },
      { path: 'bare.prompts', message: 'must be an object holding the research and vote templates' },
    ])
    expect(profileIssues({ ...valid, prompts: null } as unknown as Profile)).toEqual([
      { path: 'p.prompts', message: 'must be an object holding the research and vote templates' },
    ])
  })

  it('names a profile that is not an object, or whose id is invalid, by the root it is given', () => {
    expect(profileIssues(null as unknown as Profile, 'profiles.2')).toEqual([
      { path: 'profiles.2', message: 'must be an object' },
    ])
    expect(profileIssues(undefined as unknown as Profile, 'profiles.0')).toEqual([
      { path: 'profiles.0', message: 'must be an object' },
    ])
    expect(profileIssues({ ...valid, id: 'Bad' }, 'profiles.1')).toEqual([
      { path: 'profiles.1.id', message: 'must match ^[a-z][a-z0-9_-]*$, got "Bad"' },
    ])
  })

  it('reports a hole in an untyped lens array as an issue, never a TypeError', () => {
    const lenses = [...valid.lenses] as Profile['lenses'][number][]
    lenses.length = 3
    expect(profileIssues({ ...valid, lenses })).toEqual([
      { path: 'p.lenses.2', message: 'must be an object with an id and a question' },
    ])
  })
})

describe('thresholdsFor', () => {
  it('resolves the profile policy, or the default one, for its lens count', () => {
    expect(thresholdsFor(valid)).toEqual({ high: 2, medium: 2, low: null })
    expect(thresholdsFor({
      ...valid,
      policy: { high: 'unanimous', medium: 'any', low: 'off' },
    })).toEqual({ high: 2, medium: 1, low: null })
  })
})

describe('profileWarnings', () => {
  it('warns about a policy level that never applies with the profile\'s lens count', () => {
    expect(profileWarnings({
      ...valid,
      policy: { high: 'unanimous', medium: 'majority', low: 'off' },
    })).toEqual([
      'p.policy.medium needs the same 2 vote(s) as policy.high with 2 lens(es), so it never applies',
    ])
  })

  it('warns about a vote template that gives every lens the same instructions', () => {
    expect(profileWarnings({
      ...valid,
      policy: { high: 'unanimous', medium: 'any', low: 'off' },
      prompts: { ...valid.prompts, vote: 'Judge this finding ({{panel.size}} voters).' },
    })).toEqual([
      'p.prompts.vote uses neither {{lens.id}} nor {{lens.question}}, so every lens gets the same instructions',
    ])
  })

  it('has nothing to say about the security profile, or about one lens without lens variables', () => {
    expect(profileWarnings(securityProfile)).toEqual([])
    expect(profileWarnings({
      ...valid,
      policy: { high: 'unanimous', medium: 'off', low: 'off' },
      prompts: { ...valid.prompts, vote: 'Judge it.' },
      lenses: [valid.lenses[0]],
    })).toEqual([])
    expect(profileWarnings({
      ...valid,
      policy: { high: 'unanimous', medium: 'any', low: 'off' },
      prompts: { ...valid.prompts, vote: 'Judge: {{lens.question}}' },
    })).toEqual([])
  })
})

describe('profile', () => {
  it('cannot be reassigned through its type, nor can the default policy be changed in place', () => {
    const rename = (profile: Profile): void => {
      // @ts-expect-error a profile is read-only
      profile.id = 'other'
    }
    const loosen = (): void => {
      // @ts-expect-error a policy is read-only
      defaultPolicy.high = 'any'
    }
    expect([rename, loosen]).toHaveLength(2)
    expect(Object.isFrozen(defaultPolicy)).toBe(true)
  })
})
