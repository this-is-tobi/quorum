import { describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { defaultPolicy } from '../core/policy.ts'
import { securityProfile } from '../profiles/security.ts'
import { parseFailOn, resolveProfiles } from './profiles.ts'
import type { FailOnOverride } from './profiles.ts'
import type { ConfigInput } from './schema.ts'

const NEEDS_BASE = 'is required: the profile extends no built-in profile'
const roles = { research: 'main', voter: 'main' }
const providers = ['main', 'claude']
const TEAM = {
  prompts: { research: 'Find style issues in this diff.', vote: 'Judge from {{lens.id}}: {{lens.question}}' },
  lenses: [
    { id: 'grounded', question: 'Is it backed by a stated convention?' },
  ],
}
const FORM = 'must be a level, high, medium, low or none, or <profile>=<level>'
const all = (profile: string) => ({ reachability: profile, impact: profile, defenses: profile })
/** The issues of the ConfigError `parseFailOn` throws for `values`; none when it reads them. */
function issuesOf(values: string[]): readonly ConfigIssue[] {
  try {
    parseFailOn(values, '--fail-on')
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues
  }
  return []
}
function resolve(profiles: ConfigInput['profiles'], ids?: string[], failOn?: FailOnOverride): ReturnType<typeof resolveProfiles> {
  return resolveProfiles({
    profiles,
    selection: ids === undefined
      ? undefined
      : { ids, path: 'QUORUM_PROFILES' },
    roles,
    providers,
    failOn,
  })
}

describe('resolveProfiles', () => {
  it('runs the security profile alone, bound to the roles, when no profile is configured', () => {
    expect(resolve(undefined)).toEqual({
      profiles: [
        {
          profile: { ...securityProfile, failOn: 'high' },
          research: 'main',
          voters: all('main'),
        },
      ],
      issues: [],
      warnings: [],
    })
  })

  it('runs a built-in profile for an entry under its id, with the entry\'s fields over it', () => {
    const [security] = resolve({
      security: {
        failOn: 'none',
        policy: { medium: 'unanimous' },
      },
    }).profiles
    expect(security.profile).toEqual({
      ...securityProfile,
      failOn: 'none',
      policy: { high: 'unanimous', medium: 'unanimous', low: 'off' },
    })
  })

  it('starts a profile from the built-in one it extends: prompts and policy merge field by field, lenses replace', () => {
    const vote = 'Vote {{lens.id}}: {{lens.question}}'
    expect(resolve({
      'security-strict': {
        extends: 'security',
        prompts: { vote },
        lenses: [
          { id: 'reach', question: 'Reachable?', provider: 'claude' },
        ],
        policy: { medium: 'unanimous' },
      },
    })).toEqual({
      profiles: [
        {
          profile: {
            id: 'security-strict',
            prompts: { research: securityProfile.prompts.research, vote },
            lenses: [
              { id: 'reach', question: 'Reachable?' },
            ],
            policy: { high: 'unanimous', medium: 'unanimous', low: 'off' },
            failOn: 'high',
          },
          research: 'main',
          voters: { reach: 'claude' },
        },
      ],
      issues: [],
      warnings: [],
    })
  })

  it('builds a profile of its own from its prompts and lenses, with the default policy', () => {
    expect(resolve({ team: TEAM }).profiles).toEqual([
      {
        profile: {
          id: 'team',
          ...TEAM,
          policy: defaultPolicy,
          failOn: 'high',
        },
        research: 'main',
        voters: { grounded: 'main' },
      },
    ])
  })

  it.each([
    [
      { failOn: 'medium' },
      'medium',
    ],
    [
      { gating: true },
      'high',
    ],
    [
      { gating: false },
      'none',
    ],
    [{}, 'high'],
    [
      { extends: 'security' },
      'high',
    ],
  ] as const)('resolves %j to fail-on %s', (entry, failOn) => {
    const { profile } = resolve({ security: entry }).profiles[0]
    expect(profile.failOn).toBe(failOn)
    expect(Object.hasOwn(profile, 'gating')).toBe(false)
  })

  it('refuses an entry that sets both gating and failOn', () => {
    expect(resolve({
      team: { ...TEAM, gating: true, failOn: 'high' },
    }).issues).toEqual([
      { path: 'profiles.team.gating', message: 'is deprecated and cannot be set with failOn: remove it' },
    ])
  })

  it('warns once for each entry that sets gating', () => {
    expect(resolve({
      first: { ...TEAM, gating: false },
      second: { ...TEAM, gating: true },
      third: { ...TEAM, failOn: 'none' },
    }).warnings).toEqual([
      'profiles.first.gating is deprecated: set failOn instead, high for true and none for false',
      'profiles.second.gating is deprecated: set failOn instead, high for true and none for false',
    ])
  })

  it('requires prompts and lenses of a profile that extends no built-in profile', () => {
    expect(resolve({
      team: { failOn: 'none' },
    }).issues).toEqual([
      { path: 'profiles.team.prompts.research', message: NEEDS_BASE },
      { path: 'profiles.team.prompts.vote', message: NEEDS_BASE },
      { path: 'profiles.team.lenses', message: NEEDS_BASE },
    ])
  })

  it('binds a profile\'s own roles over the top-level ones, and a lens\'s provider over both', () => {
    const lenses = [
      { id: 'a', question: 'A?' },
      { id: 'b', question: 'B?', provider: 'main' },
    ]
    expect(resolve({
      team: {
        ...TEAM,
        lenses,
        roles: { research: 'claude', voter: 'claude' },
      },
    }).profiles[0]).toMatchObject({
      research: 'claude',
      voters: { a: 'claude', b: 'main' },
    })
    expect(resolve({
      team: {
        ...TEAM,
        lenses,
        roles: { research: 'claude' },
      },
    }).profiles[0]).toMatchObject({
      research: 'claude',
      voters: { a: 'main', b: 'main' },
    })
  })

  it('refuses a provider reference that names nothing defined, with a suggestion', () => {
    expect(resolve({
      team: {
        ...TEAM,
        roles: { voter: 'claud' },
        lenses: [
          { id: 'a', question: 'A?', provider: 'mian' },
        ],
      },
    }).issues).toEqual([
      { path: 'profiles.team.roles.voter', message: 'unknown provider "claud" (did you mean "claude"?)' },
      { path: 'profiles.team.lenses.0.provider', message: 'unknown provider "mian" (did you mean "main"?)' },
    ])
  })

  it('checks every profile it is given, and runs only the selected ones, in their order', () => {
    expect(resolve({
      team: TEAM,
      broken: { failOn: 'none' },
    }, ['security', 'team']).issues).toHaveLength(3)
    expect(resolve({
      team: TEAM,
      other: { ...TEAM },
    }, ['other', 'security']).profiles.map(({ profile }) => profile.id)).toEqual(['other', 'security'])
  })

  it('refuses a selected profile that is neither configured nor built in, listing the ones there are', () => {
    expect(resolve({ team: TEAM }, ['tema']).issues).toEqual([
      { path: 'QUORUM_PROFILES', message: 'unknown profile "tema" (did you mean "team"?)' },
    ])
    expect(resolve({ team: TEAM }, ['style']).issues).toEqual([
      { path: 'QUORUM_PROFILES', message: 'unknown profile "style": the profiles are team and security' },
    ])
  })

  it('refuses an empty profiles record, which would review nothing, unless a selection names one', () => {
    expect(resolve({})).toEqual({
      profiles: [],
      issues: [
        { path: 'profiles', message: 'must hold at least one profile, or be left out' },
      ],
      warnings: [],
    })
    expect(resolve({}, ['security']).profiles.map(({ profile }) => profile.id)).toEqual(['security'])
  })

  it('refuses a selection that names no profile, which would review nothing', () => {
    expect(resolve({ team: TEAM }, [])).toEqual({
      profiles: [],
      issues: [
        { path: 'QUORUM_PROFILES', message: 'must name at least one profile' },
      ],
      warnings: [],
    })
    expect(resolve(undefined, []).profiles).toEqual([])
  })

  it('reports a profile\'s own problems under profiles.<id>', () => {
    expect(resolve({
      team: {
        ...TEAM,
        prompts: { ...TEAM.prompts, research: 'Look at {{diff}}' },
      },
    }).issues).toEqual([
      { path: 'profiles.team.prompts.research', message: 'the placeholder "diff" is not allowed: the diff is appended automatically as fenced data' },
    ])
    expect(resolve({
      team: {
        ...TEAM,
        policy: { high: 'off', medium: 'off' },
      },
    }).issues).toEqual([
      { path: 'profiles.team.policy', message: 'at least one confidence level must be enabled' },
    ])
    expect(resolve({
      team: {
        ...TEAM,
        lenses: [TEAM.lenses[0], TEAM.lenses[0]],
      },
    }).issues).toEqual([
      { path: 'profiles.team.lenses.1.id', message: 'repeats the lens id "grounded"' },
    ])
  })

  it('reads a policy level set to undefined as unset', () => {
    expect(resolve({
      security: {
        policy: { medium: undefined },
      },
    }).profiles[0].profile.policy).toEqual(securityProfile.policy)
  })

  it('hands over frozen profiles that later changes to the config cannot reach', () => {
    const entry = {
      ...TEAM,
      lenses: [
        { ...TEAM.lenses[0] },
      ],
    }
    const [team] = resolve({ team: entry }).profiles
    entry.lenses[0].question = 'changed'
    expect(team.profile.lenses[0].question).toBe('Is it backed by a stated convention?')
    expect(Object.isFrozen(team.profile) && Object.isFrozen(team.profile.lenses) && Object.isFrozen(team.profile.prompts)).toBe(true)
  })

  it('reads the fields of an entry that it holds itself, never one its prototype supplies', () => {
    const inherited = Object.create({
      extends: 'security',
      gating: false,
      failOn: 'none',
      prompts: TEAM.prompts,
      lenses: TEAM.lenses,
      roles: { research: 'claude' },
    }) as NonNullable<ConfigInput['profiles']>[string]
    expect(resolve({ team: inherited }).issues.map(({ path }) => path)).toEqual(['profiles.team.prompts.research', 'profiles.team.prompts.vote', 'profiles.team.lenses'])
    const resolved = resolve({
      security: Object.create({ gating: false, failOn: 'none' }) as NonNullable<ConfigInput['profiles']>[string],
    })
    expect(resolved.profiles[0].profile.failOn).toBe('high')
    expect(resolved.warnings).toEqual([])
  })

  it('prints a profile id that is not a safe name as *, in every path', () => {
    const long = 'a'.repeat(65)
    expect(resolve({
      [long]: { failOn: 'none' },
    }).issues.map(({ path }) => path)).toEqual(['profiles.*.prompts.research', 'profiles.*.prompts.vote', 'profiles.*.lenses'])
    expect(resolve({
      [long]: {
        ...TEAM,
        policy: { high: 'off', medium: 'off' },
      },
    }).issues).toEqual([
      { path: 'profiles.*.policy', message: 'at least one confidence level must be enabled' },
    ])
  })
})

describe('parseFailOn', () => {
  it.each([
    [
      ['medium'],
      {
        all: 'medium',
        profiles: new Map(),
        path: '--fail-on',
      },
    ],
    [
      ['security=none'],
      {
        profiles: new Map([
          ['security', 'none'],
        ]),
        path: '--fail-on',
      },
    ],
    [
      ['low', 'team=high'],
      {
        all: 'low',
        profiles: new Map([
          ['team', 'high'],
        ]),
        path: '--fail-on',
      },
    ],
  ])('reads %j', (values, override) => {
    expect(parseFailOn(values, '--fail-on')).toStrictEqual(override)
  })

  it.each([
    [
      ['critical'],
      FORM,
    ],
    [
      ['security='],
      FORM,
    ],
    [
      ['=high'],
      FORM,
    ],
    [
      ['Security=high'],
      FORM,
    ],
    [
      ['team=high=low'],
      FORM,
    ],
    [
      ['high', 'low'],
      'takes one level for every profile',
    ],
    [
      ['team=high', 'team=low'],
      'names a profile more than once',
    ],
  ])('refuses %j with %s', (values, message) => {
    expect(issuesOf(values)).toEqual([
      { path: '--fail-on', message },
    ])
  })

  it('refuses every kind of problem once, and never prints a value', () => {
    expect(issuesOf([
      'SECRET',
      'SECRET=high',
      'high',
      'low',
      'team=high',
      'team=low',
      'team=none',
    ])).toEqual([
      { path: '--fail-on', message: FORM },
      { path: '--fail-on', message: 'takes one level for every profile' },
      { path: '--fail-on', message: 'names a profile more than once' },
    ])
  })
})

describe('resolveProfiles with a fail-on override', () => {
  it('sets every profile\'s level, a named profile\'s over it, both over the config', () => {
    const result = resolve({
      team: { ...TEAM, failOn: 'none' },
    }, ['security', 'team'], parseFailOn(['low', 'team=medium'], '--fail-on'))
    expect(result.issues).toEqual([])
    expect(result.profiles.map(({ profile }) => [profile.id, profile.failOn])).toEqual([
      ['security', 'low'],
      ['team', 'medium'],
    ])
    expect(result.profiles.every(resolved => Object.isFrozen(resolved) && Object.isFrozen(resolved.profile))).toBe(true)
  })

  it('refuses a level for a profile that does not run, by name when it is safe to print', () => {
    expect(resolve({ team: TEAM }, ['security'], parseFailOn(['team=high'], '--fail-on')).issues).toEqual([
      { path: '--fail-on', message: 'names the profile "team", which does not run' },
    ])
    const long = 'a'.repeat(65)
    expect(resolve({ [long]: TEAM }, [long], parseFailOn([`${long}x=high`], '--fail-on')).issues).toEqual([
      { path: '--fail-on', message: 'names a profile that does not run' },
    ])
  })
})
