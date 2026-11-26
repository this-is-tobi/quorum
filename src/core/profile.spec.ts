import { describe, expect, it } from 'vitest'
import { securityProfile } from '../profiles/security.ts'
import { defaultPolicy } from './policy.ts'
import { profileIssues, profileWarnings, thresholdsFor } from './profile.ts'
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
      { path: 'p.prompts.research', message: 'the placeholder "diff" is not allowed: the diff is appended automatically as fenced data' },
      { path: 'p.prompts.research', message: 'the placeholder "lens.id" is not allowed: the research template takes no variables' },
    ])
  })

  it('refuses {{diff}} in the research template alike each time the profile is checked', () => {
    const profile: Profile = {
      ...valid,
      prompts: { ...valid.prompts, research: '{{diff}}' },
    }
    const issues = [
      { path: 'p.prompts.research', message: 'the placeholder "diff" is not allowed: the diff is appended automatically as fenced data' },
    ]
    expect(profileIssues(profile)).toEqual(issues)
    expect(profileIssues(profile)).toEqual(issues)
  })

  it.each([
    ['closes a placeholder with one brace', '{{lens.id}'],
    ['never closes a {{', '{{ never closed'],
    ['opens with three braces', '{{{lens.id}}}'],
  ])('refuses a template that %s, once, with the fix', (_, template) => {
    for (const field of ['vote', 'research'] as const) {
      expect(profileIssues({
        ...valid,
        id: 'naming',
        prompts: { ...valid.prompts, [field]: template },
      })).toEqual([
        { path: `naming.prompts.${field}`, message: 'holds a {{ that opens no placeholder: write \\{{ for a literal {{' },
      ])
    }
  })

  it('reports the first open part once, then each distinct refused name, in order', () => {
    const vote = '{{x}} {{a {{b}} {{ c {{x}} {{lens.id}}'
    expect(profileIssues({
      ...valid,
      id: 'naming',
      prompts: { ...valid.prompts, vote },
    })).toEqual([
      { path: 'naming.prompts.vote', message: 'holds a {{ that opens no placeholder: write \\{{ for a literal {{' },
      { path: 'naming.prompts.vote', message: 'the placeholder "x" is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
      { path: 'naming.prompts.vote', message: 'the placeholder "b" is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
    ])
  })

  it('accepts \\{{ as a literal {{, and a lone }} as text', () => {
    expect(profileIssues({
      ...valid,
      prompts: { ...valid.prompts, vote: 'Judge {{lens.id}}. Literal \\{{braces}} and }}.' },
    })).toEqual([])
  })

  it('quotes a refused name, cut at 64 code points', () => {
    const voteReason = 'the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}'
    const refusedVote = (name: string): string[] => profileIssues({
      ...valid,
      prompts: { ...valid.prompts, vote: `{{${name}}}` },
    }).map(issue => issue.message)
    expect(refusedVote('lens.name')).toEqual([`the placeholder "lens.name" is not allowed: ${voteReason}`])
    expect(refusedVote('x'.repeat(70))).toEqual([`the placeholder "${'x'.repeat(64)}…" is not allowed: ${voteReason}`])
    expect(refusedVote('x'.repeat(64))).toEqual([`the placeholder "${'x'.repeat(64)}" is not allowed: ${voteReason}`])
    const face = String.fromCodePoint(0x1F600)
    expect(refusedVote(face.repeat(70))).toEqual([`the placeholder "${face.repeat(64)}…" is not allowed: ${voteReason}`])
    expect(refusedVote(' a"b\nc ')).toEqual([`the placeholder ${JSON.stringify('a"b\nc')} is not allowed: ${voteReason}`])
    expect(profileIssues({
      ...valid,
      prompts: { ...valid.prompts, research: 'Review {{diff}}.' },
    }).map(issue => issue.message)).toEqual(['the placeholder "diff" is not allowed: the diff is appended automatically as fenced data'])
  })

  it('refuses a vote variable outside the allowlist, a typo included, once per name', () => {
    const vote = '{{lens.id}} {{lens-id}} {{lens.name}} {{lens-id}} {{diff}}'
    expect(profileIssues({
      ...valid,
      prompts: { ...valid.prompts, vote },
    })).toEqual([
      { path: 'p.prompts.vote', message: 'the placeholder "lens-id" is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
      { path: 'p.prompts.vote', message: 'the placeholder "lens.name" is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
      { path: 'p.prompts.vote', message: 'the placeholder "diff" is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}' },
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
      { path: 'profile.prompts.research', message: 'the placeholder "diff" is not allowed: the diff is appended automatically as fenced data' },
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

  it.each([
    [
      { failOn: 'critical' },
      { path: 'loose.failOn', message: 'must be one of high, medium, low or none' },
    ],
    [
      { failOn: 1 },
      { path: 'loose.failOn', message: 'must be one of high, medium, low or none' },
    ],
    [
      { gating: true, failOn: 'high' },
      { path: 'loose.gating', message: 'is deprecated and cannot be set with failOn: remove it' },
    ],
  ])('refuses %j', (fields, issue) => {
    expect(profileIssues({
      ...valid,
      id: 'loose',
      ...fields,
    } as unknown as Profile)).toEqual([issue])
  })

  it('refuses a requireRule that is not a boolean', () => {
    for (const requireRule of ['yes', 'true', 1, 0, null, [], {}]) {
      expect(profileIssues({
        ...valid,
        id: 'loose',
        requireRule,
      } as unknown as Profile), JSON.stringify(requireRule)).toEqual([
        { path: 'loose.requireRule', message: 'must be true or false' },
      ])
    }
    for (const requireRule of [true, false, undefined]) {
      expect(profileIssues({ ...valid, requireRule }), String(requireRule)).toEqual([])
    }
  })

  it.each([
    [0, 'must be a positive integer, got 0'],
    [1.5, 'must be a positive integer, got 1.5'],
    [2 ** 53, 'must be a positive integer, got 9007199254740992'],
    ['20', 'must be a positive integer'],
  ])('refuses a maxFindings of %j at the profile\'s path', (maxFindings, message) => {
    expect(profileIssues({ ...valid, id: 'naming', maxFindings } as unknown as Profile)).toEqual([
      { path: 'naming.maxFindings', message },
    ])
  })

  it('accepts a profile\'s own maxFindings of 1 and of 9007199254740991', () => {
    for (const maxFindings of [1, 9_007_199_254_740_991]) {
      expect(profileIssues({ ...valid, maxFindings }), String(maxFindings)).toEqual([])
    }
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

  it('warns that gating is deprecated, and that failOn low with policy.low off acts as medium', () => {
    expect(profileWarnings({ ...securityProfile, gating: false })).toEqual([
      'security.gating is deprecated: set failOn instead, high for true and none for false',
    ])
    expect(profileWarnings({ ...securityProfile, failOn: 'low' })).toEqual([
      'security.failOn is low, but policy.low is off, so it acts as medium',
    ])
    expect(profileWarnings({
      ...securityProfile,
      failOn: 'low',
      policy: { high: 'unanimous', medium: 'majority', low: 'any' },
    })).toEqual([])
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

describe('the documents of a profile', () => {
  const naming: Profile = { ...valid, id: 'naming' }
  const config = (kind: 'guidelines' | 'do-not-report', text: string, extra: Record<string, unknown> = {}): NonNullable<Profile['documents']>[number] => ({
    profile: 'naming',
    kind,
    origin: { kind: 'config' },
    text,
    ...extra,
  })
  const nested = (levels: number): string => '<'.repeat(levels) + '!---->'.repeat(levels)

  it.each<[string, Partial<Profile>, string, string]>([
    [
      'guidelines of 16 385 bytes',
      {
        guidelines: 'g'.repeat(16_385),
      },
      'naming.guidelines',
      'holds 16385 bytes once cleaned, over the 16 KiB a guidelines document may hold',
    ],
    [
      'doNotReport of 8 193 bytes',
      {
        doNotReport: 'd'.repeat(8193),
      },
      'naming.doNotReport',
      'holds 8193 bytes once cleaned, over the 8 KiB a do-not-report document may hold',
    ],
    [
      'guidelines of 10 000 bytes and a document of 7 000',
      {
        guidelines: 'g'.repeat(10_000),
        documents: [
          config('guidelines', 'f'.repeat(7000)),
        ],
      },
      'naming.documents.0',
      'takes the profile\'s guidelines to 17000 bytes once cleaned, over the 16 KiB they may hold in all',
    ],
    [
      'doNotReport of 5 000 bytes and a document of 4 000',
      {
        doNotReport: 'd'.repeat(5000),
        documents: [
          config('do-not-report', 'f'.repeat(4000)),
        ],
      },
      'naming.documents.0',
      'takes the profile\'s do-not-report text to 9000 bytes once cleaned, over the 8 KiB it may hold in all',
    ],
    [
      'document of origin repository',
      {
        documents: [
          {
            profile: 'naming',
            kind: 'guidelines',
            origin: {
              kind: 'repository',
              path: 'REVIEW.md',
              commit: 'c'.repeat(40),
            },
            text: 'x',
          },
        ],
      },
      'naming.documents.0.origin',
      'must be a config document: a { repository } document comes from the review\'s context',
    ],
    [
      'document of another profile',
      {
        documents: [
          config('guidelines', 'x', { profile: 'other' }),
        ],
      },
      'naming.documents.0.profile',
      'must name the profile that holds it',
    ],
    [
      '17 documents of one kind',
      {
        documents: Array.from({ length: 17 }, () => config('guidelines', 'x')),
      },
      'naming.documents',
      'must hold at most 16 documents of one kind',
    ],
    [
      'guidelines nested 16 levels deep',
      {
        guidelines: nested(16),
      },
      'naming.guidelines',
      'nests HTML comments or character references too deep to clean in 16 passes: remove them',
    ],
    [
      'document nested 16 levels deep',
      {
        documents: [
          config('do-not-report', nested(16)),
        ],
      },
      'naming.documents.0',
      'nests HTML comments or character references too deep to clean in 16 passes: remove them',
    ],
  ])('refuses a profile whose %s', (_name, fields, path, message) => {
    expect(profileIssues({
      ...naming,
      ...fields,
    })).toEqual([
      { path, message },
    ])
  })

  it('accepts 16 documents of each kind, each within its cap', () => {
    const documents = [
      ...Array.from({ length: 16 }, () => config('guidelines', 'x'.repeat(1024))),
      ...Array.from({ length: 16 }, () => config('do-not-report', 'y'.repeat(512))),
    ]
    expect(profileIssues({ ...naming, documents })).toEqual([])
  })

  it('counts a rules file toward the 16 documents of its kind and an inline rule toward the 100 rules, one document each', () => {
    const rule = (id: string): { id: string, text: string } => ({ id, text: 'x' })
    const inline = (index: number): NonNullable<Profile['documents']>[number] => ({
      profile: 'naming',
      kind: 'rules',
      origin: { kind: 'config' },
      rules: [
        rule(`i${index}`),
      ],
    })
    const file = (index: number): NonNullable<Profile['documents']>[number] => ({
      profile: 'naming',
      kind: 'rules',
      origin: {
        kind: 'config',
        sha256: 'a'.repeat(64),
      },
      rules: [
        rule(`f${index}`),
      ],
    })
    const files = (count: number) => Array.from({ length: count }, (_, index) => file(index))
    const inlines = (count: number) => Array.from({ length: count }, (_, index) => inline(index))
    // A hundred inline rules are a hundred documents, and a rules file is one more: the 100 rules bound them, never the 16.
    expect(profileIssues({
      ...naming,
      documents: inlines(100),
    })).toEqual([])
    expect(profileIssues({
      ...naming,
      documents: [
        ...files(16),
        ...inlines(84),
      ],
    })).toEqual([])
    expect(profileIssues({
      ...naming,
      documents: files(17),
    })).toEqual([
      { path: 'naming.documents', message: 'must hold at most 16 documents of one kind' },
    ])
    expect(profileIssues({
      ...naming,
      documents: inlines(101),
    })).toEqual([
      { path: 'naming.documents.100', message: 'must hold at most 100 rules' },
    ])
    // A rules document with no hash that holds more than one rule is a file as far as the 16 go.
    const several = (index: number): NonNullable<Profile['documents']>[number] => ({
      profile: 'naming',
      kind: 'rules',
      origin: { kind: 'config' },
      rules: [
        rule(`s${index}`),
        rule(`t${index}`),
      ],
    })
    expect(profileIssues({
      ...naming,
      documents: Array.from({ length: 17 }, (_, index) => several(index)),
    })).toEqual([
      { path: 'naming.documents', message: 'must hold at most 16 documents of one kind' },
    ])
  })

  it('accepts a profile at its caps once cleaned, comments not counted', () => {
    const comments = `<!-- ${'c'.repeat(1991)} -->`
    expect(comments).toHaveLength(2000)
    const text = 'g'.repeat(16_384)
    expect(profileIssues({ ...naming, guidelines: `${text}${comments}` })).toEqual([])
    expect(profileIssues({
      ...naming,
      documents: [
        config('guidelines', `${comments}${text}${comments}`),
      ],
    })).toEqual([])
    expect(profileIssues({ ...naming, doNotReport: `${'d'.repeat(8192)}${comments}` })).toEqual([])
  })

  it('counts bytes in UTF-8, not characters', () => {
    expect(profileIssues({
      ...naming,
      guidelines: 'é'.repeat(8193),
    })).toEqual([
      { path: 'naming.guidelines', message: 'holds 16386 bytes once cleaned, over the 16 KiB a guidelines document may hold' },
    ])
  })

  it('reports an own text over its cap beside the documents that take the total over, never a text', () => {
    const issues = profileIssues({
      ...naming,
      guidelines: 'SECRET'.repeat(3000),
      documents: [
        config('guidelines', 'x'),
      ],
    })
    expect(issues.map(issue => issue.path)).toEqual(['naming.guidelines', 'naming.documents.0'])
    expect(JSON.stringify(issues)).not.toContain('SECRET')
  })

  it('reports a doNotReport, documents and a document that are none of the right type as issues, never a TypeError', () => {
    expect(profileIssues({ ...naming, doNotReport: 7 } as unknown as Profile)).toEqual([
      { path: 'naming.doNotReport', message: 'must be a string' },
    ])
    expect(profileIssues({ ...naming, documents: 'REVIEW.md' } as unknown as Profile)).toEqual([
      { path: 'naming.documents', message: 'must be an array of documents' },
    ])
    expect(profileIssues({
      ...naming,
      documents: [
        null,
        {
          profile: 'naming',
          kind: 'guidelines',
          origin: { kind: 'config' },
          text: 3,
        },
      ],
    } as unknown as Profile)).toEqual([
      { path: 'naming.documents.0', message: 'must be an object' },
      { path: 'naming.documents.1.text', message: 'must be a string' },
    ])
  })
})

describe('the rules of a profile', () => {
  const naming: Profile = { ...valid, id: 'naming' }
  const noAny = {
    id: 'no-any',
    text: 'No any outside tests.',
    paths: ['src/**'],
  }
  const license = { id: 'license', text: 'Each file starts with the license header.' }
  const rulesFile = (rules: unknown): unknown => ({
    profile: 'naming',
    kind: 'rules',
    origin: { kind: 'config' },
    rules,
  })

  it('accepts a profile whose own rules and rules documents are within their checks', () => {
    expect(profileIssues({
      ...naming,
      rules: [noAny, license],
    })).toEqual([])
    expect(profileIssues({
      ...naming,
      rules: [noAny],
      documents: [
        rulesFile([license]),
      ],
    } as unknown as Profile)).toEqual([])
    expect(profileIssues({ ...naming, rules: [] })).toEqual([])
  })

  it('refuses a rule id a profile repeats, at the rule that repeats it', () => {
    expect(profileIssues({
      ...naming,
      rules: [
        noAny,
        { ...license, id: 'no-any' },
      ],
    })).toEqual([
      { path: 'naming.rules.1.id', message: 'repeats the rule id "no-any"' },
    ])
    expect(profileIssues({
      ...naming,
      rules: [noAny],
      documents: [
        rulesFile([
          license,
          { ...license, id: 'no-any' },
        ]),
      ],
    } as unknown as Profile)).toEqual([
      { path: 'naming.documents.0.rules.1.id', message: 'repeats the rule id "no-any"' },
    ])
  })

  it('refuses the rules that are none of the right shape, as issues, never a TypeError', () => {
    expect(profileIssues({ ...naming, rules: 'no-any' } as unknown as Profile)).toEqual([
      { path: 'naming.rules', message: 'must be an array of rules' },
    ])
    expect(profileIssues({
      ...naming,
      rules: [
        { id: 'No-any', text: 'x' },
        null,
      ],
    } as unknown as Profile)).toEqual([
      { path: 'naming.rules.0.id', message: 'must match ^[a-z][a-z0-9._-]{0,63}$' },
      { path: 'naming.rules.1', message: 'must be an object with an id and a text' },
    ])
    expect(profileIssues({
      ...naming,
      documents: [
        rulesFile(undefined),
      ],
    } as unknown as Profile)).toEqual([
      { path: 'naming.documents.0.rules', message: 'must be an array of rules: a config document is never missing' },
    ])
  })

  it('refuses a profile whose own rules and rules documents list more than 100 in all, at the document that takes it over', () => {
    const many = (count: number, prefix: string): unknown[] => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, text: 'Keep it short.' }))
    expect(profileIssues({
      ...naming,
      rules: many(60, 'own'),
      documents: [
        rulesFile(many(40, 'file')),
      ],
    } as unknown as Profile)).toEqual([])
    expect(profileIssues({
      ...naming,
      rules: many(60, 'own'),
      documents: [
        rulesFile(many(41, 'file')),
      ],
    } as unknown as Profile)).toEqual([
      { path: 'naming.documents.0', message: 'must hold at most 100 rules' },
    ])
    expect(profileIssues({
      ...naming,
      rules: many(101, 'own'),
    } as unknown as Profile)).toEqual([
      { path: 'naming.rules', message: 'must hold at most 100 rules' },
    ])
  })

  it('tells a rules document over 32 KiB by itself once, at the rule that takes it over', () => {
    const wide = Array.from({ length: 33 }, (_, index) => ({
      id: `file-${index}`,
      text: 'a'.repeat(1024),
    }))
    expect(profileIssues({
      ...naming,
      documents: [
        rulesFile(wide),
      ],
    } as unknown as Profile)).toEqual([
      { path: 'naming.documents.0.rules.32', message: 'takes the profile\'s rules to 33792 bytes once cleaned, over the 32 KiB they may hold in all' },
    ])
  })

  it('refuses rules whose texts take the profile over 32 KiB in all, at the first rule or document that does', () => {
    const full = Array.from({ length: 32 }, (_, index) => ({
      id: `rule-${index}`,
      text: 'a'.repeat(1024),
    }))
    expect(profileIssues({
      ...naming,
      rules: [...full, license],
    })).toEqual([
      { path: 'naming.rules.32', message: 'takes the profile\'s rules to 32809 bytes once cleaned, over the 32 KiB they may hold in all' },
    ])
    expect(profileIssues({
      ...naming,
      rules: full,
      documents: [
        rulesFile([license]),
      ],
    } as unknown as Profile)).toEqual([
      { path: 'naming.documents.0', message: 'takes the profile\'s rules to 32809 bytes once cleaned, over the 32 KiB they may hold in all' },
    ])
  })
})
