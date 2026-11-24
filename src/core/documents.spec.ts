import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DocumentRule } from './documents.ts'
import { capProblem, contextTotalIssues, DOCUMENT_CAPS, documentCommit, documentIssues, documentSha256, joined, profileDocumentIssues, profileTexts, totalProblem, UNSETTLED, withRepository } from './documents.ts'
import { entriesBytes, ruleEntry } from './rules.ts'
import type { Profile, ReviewDocument, ReviewRule, ReviewSource } from './types.ts'

const char = (code: number): string => String.fromCharCode(code)
const COMMIT = 'c'.repeat(40)
const NOTHING = { characters: 0, comments: 0, entities: 0 }

const profile: Profile = {
  id: 'naming',
  prompts: { research: 'Review this diff for names that mislead.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
  lenses: [
    { id: 'clarity', question: 'Does the name mislead?' },
  ],
}

function config(kind: ReviewDocument['kind'], text: string | undefined, extra: Partial<ReviewDocument> = {}): ReviewDocument {
  return {
    profile: 'naming',
    kind,
    origin: { kind: 'config' },
    ...text === undefined
      ? {}
      : { text },
    ...extra,
  }
}

function repository(kind: ReviewDocument['kind'], text: string | undefined, extra: Partial<ReviewDocument> = {}): ReviewDocument {
  return {
    profile: 'naming',
    kind,
    origin: { kind: 'repository', path: 'REVIEW.md', commit: COMMIT },
    ...text === undefined
      ? {}
      : { text },
    ...extra,
  }
}

describe('the caps of a document', () => {
  it('holds the values the design states', () => {
    expect(DOCUMENT_CAPS).toEqual({ guidelines: 16_384, 'do-not-report': 8192 })
  })

  it.each([
    ['guidelines', 16_384, undefined],
    ['guidelines', 16_385, 'holds 16385 bytes once cleaned, over the 16 KiB a guidelines document may hold'],
    ['do-not-report', 8192, undefined],
    ['do-not-report', 8193, 'holds 8193 bytes once cleaned, over the 8 KiB a do-not-report document may hold'],
  ] as const)('words a %s document of %i bytes as %j', (kind, bytes, words) => {
    expect(capProblem(kind, bytes)).toBe(words)
  })

  it.each([
    ['guidelines', 16_384, undefined],
    ['guidelines', 16_385, 'takes the profile\'s guidelines to 16385 bytes once cleaned, over the 16 KiB they may hold in all'],
    ['do-not-report', 8192, undefined],
    ['do-not-report', 8193, 'takes the profile\'s do-not-report text to 8193 bytes once cleaned, over the 8 KiB it may hold in all'],
  ] as const)('words the profile\'s %s texts of %i bytes in all as %j', (kind, bytes, words) => {
    expect(totalProblem(kind, bytes)).toBe(words)
  })
})

describe('documentSha256', () => {
  it('hashes a document\'s text as sha256sum does a file without a byte-order mark', () => {
    expect(documentSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('hashes the UTF-8 bytes of the text, as 64 lowercase hexadecimal digits', () => {
    expect(documentSha256('é')).toBe(createHash('sha256').update(Buffer.from([0xC3, 0xA9])).digest('hex'))
    expect(documentSha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('documentCommit', () => {
  const sha1 = 'sha1' as const
  const head = 'b'.repeat(40)
  it.each<[string, ReviewSource, string | null | undefined]>([
    [
      'range',
      {
        kind: 'range',
        base: COMMIT,
        mergeBase: COMMIT,
        head,
        objectFormat: sha1,
      },
      COMMIT,
    ],
    [
      'paths',
      {
        kind: 'paths',
        commit: COMMIT,
        paths: ['src'],
        skips: true,
        objectFormat: sha1,
      },
      COMMIT,
    ],
    [
      'local',
      { kind: 'local', head, objectFormat: sha1 },
      head,
    ],
    [
      'staged',
      { kind: 'staged', head: null, objectFormat: sha1 },
      null,
    ],
    [
      'diff',
      { kind: 'diff' },
      undefined,
    ],
  ])('reads the documents\' commit of a %s source', (_name, source, commit) => {
    expect(documentCommit(source)).toBe(commit)
  })
})

describe('joined', () => {
  it('joins the non-blank texts by a blank line, and holds nothing for none', () => {
    expect(joined(['A.', ' \n', 'B.'])).toBe('A.\n\nB.')
    expect(joined([])).toBeUndefined()
    expect(joined(['', '  '])).toBeUndefined()
  })
})

describe('the texts of a profile', () => {
  it('joins the profile\'s own text, its file documents, then the repository\'s, in order, skipping the blank, each cleaned and recorded', () => {
    const texts = profileTexts({
      ...profile,
      guidelines: 'A.',
      documents: [
        config('guidelines', `B${char(0x200B)}`),
        config('guidelines', '  '),
      ],
    }, 'Review.')
    expect(texts.prompt).toBe('Review.')
    expect(texts.guidelines).toEqual(['A.', 'B'])
    expect(texts.doNotReport).toEqual([])
    const withRepo = withRepository(texts, [
      repository('guidelines', 'C.'),
    ])
    expect(joined(withRepo.guidelines)).toBe('A.\n\nB\n\nC.')
    expect(withRepo.records).toEqual([
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: 'profile',
        status: 'read',
        bytes: 2,
        removed: NOTHING,
      },
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: 'config',
        status: 'read',
        bytes: 1,
        removed: { characters: 1, comments: 0, entities: 0 },
      },
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: 'config',
        status: 'read',
        bytes: 0,
        removed: NOTHING,
      },
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: 'repository',
        path: 'REVIEW.md',
        commit: COMMIT,
        status: 'read',
        bytes: 2,
        removed: NOTHING,
      },
    ])
    // The texts the profile was compiled with are not changed by a review's documents.
    expect(texts.guidelines).toEqual(['A.', 'B'])
    expect(texts.records).toHaveLength(3)
  })

  it('records a missing optional repository document as missing, with no bytes and no hash', () => {
    const sha256 = 'a'.repeat(64)
    const missing = repository('guidelines', undefined, {
      origin: {
        kind: 'repository',
        path: 'REVIEW.md',
        commit: COMMIT,
        sha256,
      },
    })
    const [record] = withRepository(profileTexts(profile, 'Review.'), [missing]).records
    expect(record).toEqual({
      profile: 'naming',
      kind: 'guidelines',
      origin: 'repository',
      path: 'REVIEW.md',
      commit: COMMIT,
      status: 'missing',
      bytes: 0,
      removed: NOTHING,
    })
    expect(record).not.toHaveProperty('sha256')
  })

  it('keeps a document\'s hash in its record, and each kind\'s records together, guidelines first', () => {
    const sha256 = 'f'.repeat(64)
    const texts = profileTexts({
      ...profile,
      doNotReport: 'Style.',
      guidelines: 'Own.',
      documents: [
        config('do-not-report', 'Naming.', {
          origin: { kind: 'config', sha256 },
        }),
      ],
    }, 'Review.')
    const withRepo = withRepository(texts, [
      repository('do-not-report', 'Repo.'),
      repository('guidelines', 'Guide.'),
    ])
    expect(withRepo.records.map(record => [record.kind, record.origin])).toEqual([
      ['guidelines', 'profile'],
      ['guidelines', 'repository'],
      ['do-not-report', 'profile'],
      ['do-not-report', 'config'],
      ['do-not-report', 'repository'],
    ])
    expect(withRepo.records[3].sha256).toBe(sha256)
    expect(withRepo.guidelines).toEqual(['Own.', 'Guide.'])
    expect(withRepo.doNotReport).toEqual(['Style.', 'Naming.', 'Repo.'])
  })

  it('records none for a profile with no document, and a blank own text as a document of no bytes', () => {
    expect(profileTexts(profile, 'Review.').records).toEqual([])
    expect(profileTexts({ ...profile, guidelines: '  ' }, 'Review.')).toMatchObject({
      guidelines: [],
      records: [
        {
          origin: 'profile',
          kind: 'guidelines',
          status: 'read',
          bytes: 0,
        },
      ],
    })
  })

  it('adds what its own pass removes to what the reader said it removed', () => {
    const document = config('guidelines', 'x<!-- y -->', {
      removed: { characters: 2, comments: 0, entities: 0 },
    })
    const [record] = profileTexts({
      ...profile,
      documents: [document],
    }, 'Review.').records
    expect(record.removed).toEqual({ characters: 2, comments: 1, entities: 0 })
  })

  it('counts the bytes of the cleaned text in UTF-8', () => {
    const [record] = profileTexts({ ...profile, guidelines: 'é<!-- x -->' }, 'Review.').records
    expect(record.bytes).toBe(2)
  })
})

describe('documentIssues', () => {
  const rule: DocumentRule = {
    origin: 'repository',
    profiles: new Set(['naming']),
    commit: COMMIT,
  }
  const issuesOf = (document: unknown, given: DocumentRule = rule): Array<readonly [string, string]> => documentIssues([document], 'context.documents', given).map(issue => [issue.path, issue.message] as const)
  const nested = (levels: number): string => '<'.repeat(levels) + '!---->'.repeat(levels)

  it('accepts a repository document of the quorum at the source\'s commit, and a missing one', () => {
    expect(issuesOf(repository('guidelines', 'Use db.query.'))).toEqual([])
    expect(issuesOf(repository('do-not-report', undefined))).toEqual([])
    expect(issuesOf(repository('guidelines', 'x'.repeat(16_384), {
      origin: {
        kind: 'repository',
        path: 'REVIEW.md',
        commit: COMMIT,
        sha256: 'a'.repeat(64),
      },
    }))).toEqual([])
  })

  it.each<[string, ReviewDocument, string, string]>([
    [
      'profile is no profile of the quorum',
      repository('guidelines', 'x', { profile: 'other' }),
      'context.documents.0.profile',
      'names no profile of the quorum',
    ],
    [
      'origin is config',
      config('guidelines', 'x'),
      'context.documents.0.origin',
      'must be a repository document: a { file } document belongs in the profile\'s documents',
    ],
    [
      'commit is not the source\'s',
      repository('guidelines', 'x', {
        origin: {
          kind: 'repository',
          path: 'REVIEW.md',
          commit: 'd'.repeat(40),
        },
      }),
      'context.documents.0.origin.commit',
      'must be the commit the review\'s source reads documents from',
    ],
    [
      'text is 65 537 bytes',
      repository('guidelines', 'x'.repeat(65_537)),
      'context.documents.0.text',
      'holds 65537 bytes, over the 64 KiB quorum reads of a document',
    ],
    [
      'text is over its cap once cleaned',
      repository('guidelines', 'x'.repeat(16_385)),
      'context.documents.0',
      '"REVIEW.md" at ccccccc holds 16385 bytes once cleaned, over the 16 KiB a guidelines document may hold',
    ],
    [
      'text is unsettled',
      repository('guidelines', nested(17)),
      'context.documents.0',
      `"REVIEW.md" at ccccccc ${UNSETTLED}`,
    ],
    [
      'sha256 is not 64 lowercase hex',
      repository('guidelines', 'x', {
        origin: {
          kind: 'repository',
          path: 'REVIEW.md',
          commit: COMMIT,
          sha256: 'A'.repeat(64),
        },
      }),
      'context.documents.0.origin.sha256',
      'must be 64 lowercase hexadecimal digits',
    ],
  ])('refuses a context document whose %s', (_name, document, path, message) => {
    expect(issuesOf(document)).toEqual([
      [path, message],
    ])
  })

  it('refuses a list of 257 documents, and a list that is none', () => {
    const documents = Array.from({ length: 257 }, () => repository('guidelines', 'x'))
    expect(documentIssues(documents, 'context.documents', rule)).toEqual([
      { path: 'context.documents', message: 'must be an array of at most 256 documents' },
    ])
    expect(documentIssues(Array.from({ length: 256 }, () => repository('guidelines', 'x')), 'context.documents', rule)).toEqual([])
    expect(documentIssues('REVIEW.md', 'context.documents', rule)).toEqual([
      { path: 'context.documents', message: 'must be an array of at most 256 documents' },
    ])
  })

  it('refuses every document of a source that names no commit, at the document', () => {
    const none: DocumentRule = {
      origin: 'repository',
      profiles: new Set(['naming']),
      commit: null,
    }
    const words = 'needs a commit to read it from, which the review\'s source does not name'
    expect(issuesOf(repository('guidelines', 'x'), none)).toEqual([
      ['context.documents.0', words],
    ])
    expect(documentIssues([
      repository('guidelines', 'x'),
      repository('do-not-report', 'y'),
    ], 'context.documents', none).map(issue => issue.path)).toEqual(['context.documents.0', 'context.documents.1'])
  })

  it('checks no commit when the rule names none to check', () => {
    expect(issuesOf(repository('guidelines', 'x'), {
      origin: 'repository',
      profiles: new Set(['naming']),
    })).toEqual([])
  })

  it('refuses a document that is no object, a kind it does not know, a text that is no string and counts that are none, each at its field', () => {
    expect(issuesOf('REVIEW.md')).toEqual([
      ['context.documents.0', 'must be an object'],
    ])
    expect(issuesOf({
      ...repository('guidelines', 'x'),
      kind: 'notes',
    })).toEqual([
      ['context.documents.0.kind', 'must be guidelines, do-not-report or rules'],
    ])
    expect(issuesOf({
      ...repository('guidelines', 'x'),
      text: 7,
    })).toEqual([
      ['context.documents.0.text', 'must be a string'],
    ])
    expect(issuesOf({
      ...repository('guidelines', 'x'),
      removed: { characters: -1, comments: 0, entities: 0 },
    })).toEqual([
      ['context.documents.0.removed', 'must hold counts of characters, comments and entities'],
    ])
    expect(issuesOf({
      ...repository('guidelines', 'x'),
      origin: { kind: 'repository', path: '', commit: COMMIT },
    })).toEqual([
      ['context.documents.0.origin.path', 'must be a path of at most 4096 characters'],
    ])
  })

  it('refuses a profile\'s own document of another profile or origin, in the profile\'s words', () => {
    const own: DocumentRule = {
      origin: 'config',
      profiles: new Set(['naming']),
    }
    expect(documentIssues([
      config('guidelines', 'x', { profile: 'other' }),
    ], 'naming.documents', own)).toEqual([
      { path: 'naming.documents.0.profile', message: 'must name the profile that holds it' },
    ])
    expect(documentIssues([
      repository('guidelines', 'x'),
    ], 'naming.documents', own)).toEqual([
      { path: 'naming.documents.0.origin', message: 'must be a config document: a { repository } document comes from the review\'s context' },
    ])
  })

  it('refuses a profile\'s own document that holds no text, which only a repository document may lack', () => {
    const own: DocumentRule = {
      origin: 'config',
      profiles: new Set(['naming']),
    }
    expect(documentIssues([
      config('guidelines', undefined),
    ], 'naming.documents', own)).toEqual([
      { path: 'naming.documents.0.text', message: 'must be a string: a config document is never missing' },
    ])
    expect(documentIssues([
      config('guidelines', ''),
      config('do-not-report', 'Generated files.'),
    ], 'naming.documents', own)).toEqual([])
    expect(issuesOf(repository('guidelines', undefined))).toEqual([])
  })

  it('quotes a long path cut at 100 characters, and never a document\'s text', () => {
    const path = `${'d/'.repeat(80)}REVIEW.md`
    const [[, message]] = issuesOf(repository('guidelines', 'SECRET'.repeat(3000), {
      origin: { kind: 'repository', path, commit: COMMIT },
    }))
    expect(message.startsWith(`${JSON.stringify(`${path.slice(0, 100)}…`)} at ccccccc holds 18000 bytes`)).toBe(true)
    expect(message).not.toContain('SECRET')
  })
})

describe('the rules of a profile', () => {
  const noAny: ReviewRule = {
    id: 'no-any',
    text: 'No any outside tests.',
    paths: ['src/**'],
  }
  const license: ReviewRule = { id: 'license', text: 'Each file starts with the license header.' }
  const naming: ReviewRule = { id: 'naming', text: 'Names say what a value is.' }

  function rulesDocument(rules: readonly ReviewRule[] | undefined, extra: Partial<ReviewDocument> = {}): ReviewDocument {
    return {
      profile: 'naming',
      kind: 'rules',
      origin: { kind: 'config' },
      ...rules === undefined
        ? {}
        : { rules },
      ...extra,
    }
  }

  function repositoryRules(rules: readonly ReviewRule[] | undefined, path = 'RULES.yaml'): ReviewDocument {
    return rulesDocument(rules, {
      origin: { kind: 'repository', path, commit: COMMIT },
    })
  }

  it('joins a profile\'s own rules, its file rules and its repository rules in order, and refuses a repeated id across them', () => {
    const hidden = { ...license, text: `Each file${char(0x200B)} starts with the license header.<!-- skip -->` }
    const texts = profileTexts({
      ...profile,
      guidelines: 'Own.',
      rules: [noAny],
      documents: [
        rulesDocument([hidden]),
      ],
    }, 'Review.')
    // Each text is cleaned, and the rules keep the order: the profile's own, then its documents'.
    expect(texts.rules).toEqual([noAny, license])
    const withRepo = withRepository(texts, [
      repositoryRules([naming]),
    ])
    expect(withRepo.rules).toEqual([noAny, license, naming])
    expect(withRepo.guidelines).toEqual(['Own.'])
    // The profile's texts are not changed by a review's documents.
    expect(texts.rules).toEqual([noAny, license])
    expect(withRepo.records).toEqual([
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: 'profile',
        status: 'read',
        bytes: 4,
        removed: NOTHING,
      },
      {
        profile: 'naming',
        kind: 'rules',
        origin: 'profile',
        status: 'read',
        bytes: entriesBytes([noAny]),
        rules: 1,
        removed: NOTHING,
      },
      {
        profile: 'naming',
        kind: 'rules',
        origin: 'config',
        status: 'read',
        bytes: entriesBytes([license]),
        rules: 1,
        removed: { characters: 1, comments: 1, entities: 0 },
      },
      {
        profile: 'naming',
        kind: 'rules',
        origin: 'repository',
        path: 'RULES.yaml',
        commit: COMMIT,
        status: 'read',
        bytes: entriesBytes([naming]),
        rules: 1,
        removed: NOTHING,
      },
    ])
    expect(withRepo.records[1].bytes).toBe(Buffer.byteLength(ruleEntry(noAny)))
    // A repeat across the three is an issue at the document that repeats it: the file's, then the repository's.
    const issues = (own: readonly ReviewRule[], file: readonly ReviewRule[]): Array<readonly [string, string]> => profileDocumentIssues({
      ...profile,
      rules: own,
      documents: [
        rulesDocument(file),
      ],
    }, 'naming').map(issue => [issue.path, issue.message] as const)
    expect(issues([noAny], [
      license,
      { ...naming, id: 'no-any' },
    ])).toEqual([
      ['naming.documents.0.rules.1.id', 'repeats the rule id "no-any"'],
    ])
    expect(issues([noAny], [license])).toEqual([])
    expect(contextTotalIssues(texts, [
      {
        index: 0,
        document: repositoryRules([naming]),
      },
      {
        index: 3,
        document: repositoryRules([
          license,
          { ...naming, id: 'extra' },
        ], 'MORE.yaml'),
      },
      {
        index: 4,
        document: repositoryRules([
          { ...license, id: 'naming' },
        ], 'LAST.yaml'),
      },
    ])).toEqual([
      { path: 'context.documents.3.rules.0.id', message: '"MORE.yaml" at ccccccc repeats the rule id "license"' },
      { path: 'context.documents.4.rules.0.id', message: '"LAST.yaml" at ccccccc repeats the rule id "naming"' },
    ])
  })

  it('refuses a rules list of the profile\'s own, at `rules`, whose ids repeat or whose texts are over the cap', () => {
    const own = (rules: unknown): Array<readonly [string, string]> => profileDocumentIssues({ ...profile, rules } as Profile, 'naming').map(issue => [issue.path, issue.message] as const)
    expect(own([
      noAny,
      { ...license, id: 'no-any' },
    ])).toEqual([
      ['naming.rules.1.id', 'repeats the rule id "no-any"'],
    ])
    expect(own('no-any')).toEqual([
      ['naming.rules', 'must be an array of rules'],
    ])
    expect(own([])).toEqual([])
    // 32 KiB of text in the own rules leaves the file's rules no room at all.
    const full = Array.from({ length: 32 }, (_, index) => ({
      id: `rule-${index}`,
      text: 'a'.repeat(1024),
    }))
    expect(own(full)).toEqual([])
    expect(profileDocumentIssues({
      ...profile,
      rules: full,
      documents: [
        rulesDocument([license]),
      ],
    }, 'naming').map(issue => [issue.path, issue.message])).toEqual([
      ['naming.documents.0', 'takes the profile\'s rules to 32809 bytes once cleaned, over the 32 KiB they may hold in all'],
    ])
  })

  it('refuses the rules of a document at the document, and in a repository document\'s words', () => {
    const own: DocumentRule = {
      origin: 'config',
      profiles: new Set(['naming']),
    }
    const rule: DocumentRule = {
      origin: 'repository',
      profiles: new Set(['naming']),
      commit: COMMIT,
    }
    const at = (documents: unknown[], given: DocumentRule): Array<readonly [string, string]> => documentIssues(documents, 'docs', given).map(issue => [issue.path, issue.message] as const)
    // A file of rules that is missing is a repository document's alone, and a rules document holds rules in place of text.
    expect(at([
      repositoryRules(undefined),
    ], rule)).toEqual([])
    expect(at([
      rulesDocument(undefined),
    ], own)).toEqual([
      ['docs.0.rules', 'must be an array of rules: a config document is never missing'],
    ])
    expect(at([
      rulesDocument([license], { text: 'x' }),
    ], own)).toEqual([
      ['docs.0.text', 'must be absent: a rules document holds rules'],
    ])
    expect(at([
      config('guidelines', 'x', {
        rules: [license],
      }),
    ], own)).toEqual([
      ['docs.0.rules', 'must be absent: only a rules document holds rules'],
    ])
    expect(at([
      rulesDocument([
        { ...license, id: 'License' },
      ]),
    ], own)).toEqual([
      ['docs.0.rules.0.id', 'must match ^[a-z][a-z0-9._-]{0,63}$'],
    ])
    expect(at([
      repositoryRules([
        { ...license, id: 'License' },
      ]),
    ], rule)).toEqual([
      ['docs.0.rules.0.id', '"RULES.yaml" at ccccccc must match ^[a-z][a-z0-9._-]{0,63}$'],
    ])
    expect(at([
      repositoryRules([
        license,
        { ...naming, id: 'license' },
      ]),
    ], rule)).toEqual([
      ['docs.0.rules.1.id', '"RULES.yaml" at ccccccc repeats the rule id "license"'],
    ])
  })

  it('records a missing optional repository rules file with no bytes and no rule, and an empty list as a document read', () => {
    const missing = withRepository(profileTexts(profile, 'Review.'), [
      repositoryRules(undefined),
    ])
    expect(missing.records).toEqual([
      {
        profile: 'naming',
        kind: 'rules',
        origin: 'repository',
        path: 'RULES.yaml',
        commit: COMMIT,
        status: 'missing',
        bytes: 0,
        rules: 0,
        removed: NOTHING,
      },
    ])
    expect(missing.rules).toEqual([])
    const empty = profileTexts({
      ...profile,
      documents: [
        rulesDocument([]),
      ],
    }, 'Review.')
    expect(empty.records).toMatchObject([
      {
        kind: 'rules',
        status: 'read',
        bytes: 0,
        rules: 0,
      },
    ])
    // A profile that lists no rule of its own records none.
    expect(profileTexts({ ...profile, rules: [] }, 'Review.').records).toEqual([])
  })

  it('keeps a rule\'s id, text and paths only, and leaves the caller\'s rule alone', () => {
    const given = {
      id: 'no-any',
      text: `No any${char(0x200B)}.`,
      paths: ['src/**'],
      extra: 'ignored',
    } as ReviewRule
    const texts = profileTexts({
      ...profile,
      rules: [given],
    }, 'Review.')
    expect(texts.rules).toEqual([
      {
        id: 'no-any',
        text: 'No any.',
        paths: ['src/**'],
      },
    ])
    expect(texts.rules[0]).not.toHaveProperty('extra')
    expect(given.text).toBe(`No any${char(0x200B)}.`)
  })

  /** `count` rules named `<prefix>-<n>`, each text `bytes` bytes of ASCII. */
  const many = (count: number, prefix: string, bytes = 10): ReviewRule[] => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    text: 'x'.repeat(bytes),
  }))
  const COUNT = 'must hold at most 100 rules'
  const inAll = (bytes: number): string => `takes the profile's rules to ${bytes} bytes once cleaned, over the 32 KiB they may hold in all`
  /** The issues of a profile with its own rules and a rules document for each list of `files`, as `path: message`. */
  const issuesOf = (own: readonly ReviewRule[] | undefined, ...files: ReviewRule[][]): Array<readonly [string, string]> => profileDocumentIssues({
    ...profile,
    ...own === undefined
      ? {}
      : { rules: own },
    documents: files.map(file => rulesDocument(file)),
  }, 'naming').map(issue => [issue.path, issue.message] as const)

  it('counts the rules of every origin toward the 100 a profile may list, at the first document that takes it over', () => {
    expect(issuesOf(many(60, 'own'), many(40, 'file'))).toEqual([])
    expect(issuesOf(many(60, 'own'), many(41, 'file'))).toEqual([
      ['naming.documents.0', COUNT],
    ])
    expect(issuesOf(many(100, 'own'), many(1, 'file'))).toEqual([
      ['naming.documents.0', COUNT],
    ])
    expect(issuesOf(undefined, many(60, 'a'), many(40, 'b'))).toEqual([])
    // Only the first document that takes the total over is told: the ones after it are over too, and say nothing more.
    expect(issuesOf(many(60, 'own'), many(30, 'a'), many(20, 'b'), many(20, 'c'))).toEqual([
      ['naming.documents.1', COUNT],
    ])
    // A list over 100 by itself is its own issue, at the list, and takes nothing further from the documents that follow.
    expect(issuesOf(many(101, 'own'), many(1, 'file'))).toEqual([
      ['naming.rules', COUNT],
    ])
    expect(issuesOf(undefined, many(101, 'file'), many(1, 'more'))).toEqual([
      ['naming.documents.0.rules', COUNT],
    ])
  })

  it('counts the rules of all three origins toward the 100, at the repository document that takes the profile over', () => {
    const texts = profileTexts({
      ...profile,
      rules: many(60, 'own'),
      documents: [
        rulesDocument(many(30, 'file')),
      ],
    }, 'Review.')
    const at = (...documents: Array<readonly [number, ReviewRule[]]>): Array<readonly [string, string]> => contextTotalIssues(texts, documents.map(([index, rules]) => ({
      index,
      document: repositoryRules(rules, `R${index}.yaml`),
    }))).map(issue => [issue.path, issue.message] as const)
    expect(at([
      2,
      many(10, 'repo'),
    ])).toEqual([])
    expect(at([
      2,
      many(11, 'repo'),
    ], [
      5,
      many(1, 'more'),
    ])).toEqual([
      ['context.documents.2', COUNT],
    ])
    expect(at([
      2,
      many(5, 'repo'),
    ], [
      4,
      many(6, 'more'),
    ])).toEqual([
      ['context.documents.4', COUNT],
    ])
  })

  it('counts the cleaned texts of every origin toward the 32 KiB a profile may hold, the reviewer\'s 40.5 KB case included', () => {
    const own = many(20, 'own', 1000)
    const file = many(10, 'file', 1000)
    expect(issuesOf(own, file)).toEqual([])
    const texts = profileTexts({
      ...profile,
      rules: own,
      documents: [
        rulesDocument(file),
      ],
    }, 'Review.')
    const at = (...lists: ReviewRule[][]): Array<readonly [string, string]> => contextTotalIssues(texts, lists.map((rules, index) => ({
      index: index + 1,
      document: repositoryRules(rules, `R${index}.yaml`),
    }))).map(issue => [issue.path, issue.message] as const)
    // 30 000 bytes held: two more rules of 1000 are 32 000, a third is 33 000, and a document after it is no further issue.
    expect(at(many(2, 'repo', 1000))).toEqual([])
    expect(at(many(3, 'repo', 1000), many(1, 'more', 1000))).toEqual([
      [
        'context.documents.1',
        inAll(33_000),
      ],
    ])
    // 30 000 bytes held: a document of five takes the total over at its third rule, and the message names the total there, 33 000, not the 35 000 the document ends at.
    expect(at(many(5, 'repo', 1000))).toEqual([
      [
        'context.documents.1',
        inAll(33_000),
      ],
    ])
    // 100 own rules and 5 of a document, 300 bytes each, are over the 100 already and hold 31 500 bytes; a repository document of 9000 takes them over at its second rule, 33 500, which a total that was dropped past 100 rules let through (its 40 500 in all).
    const crowded = profileTexts({
      ...profile,
      rules: many(100, 'own', 300),
      documents: [
        rulesDocument(many(5, 'file', 300)),
      ],
    }, 'Review.')
    expect(profileDocumentIssues({
      ...profile,
      rules: many(100, 'own', 300),
      documents: [
        rulesDocument(many(5, 'file', 300)),
      ],
    }, 'naming').map(issue => [issue.path, issue.message])).toEqual([
      ['naming.documents.0', COUNT],
    ])
    expect(contextTotalIssues(crowded, [
      {
        index: 0,
        document: repositoryRules(many(9, 'repo', 1000)),
      },
    ]).map(issue => [issue.path, issue.message])).toEqual([
      [
        'context.documents.0',
        inAll(33_500),
      ],
    ])
  })

  it('tells a rules document that is over 32 KiB by itself once, at the rule that takes it over', () => {
    const wide = many(33, 'file', 1024)
    expect(issuesOf(undefined, wide)).toEqual([
      [
        'naming.documents.0.rules.32',
        inAll(33_792),
      ],
    ])
    // Whatever the profile's own rules hold: the document is over by itself, and is told as such, not again as the document that takes the total over.
    // The bytes the message names are the profile's: its own rule's 10, then the document's up to that rule.
    expect(issuesOf(many(1, 'own'), wide)).toEqual([
      [
        'naming.documents.0.rules.32',
        inAll(33_802),
      ],
    ])
    // The documents before it count too: 5000 bytes of one, then 33 792 of the one that is over by itself.
    expect(issuesOf(many(1, 'own'), many(5, 'a', 1000), wide)).toEqual([
      [
        'naming.documents.1.rules.32',
        inAll(38_802),
      ],
    ])
    // A document that is within the cap by itself and takes the total over is told at the document.
    expect(issuesOf(many(32, 'own', 1024), many(1, 'file', 1024))).toEqual([
      [
        'naming.documents.0',
        inAll(33_792),
      ],
    ])
  })

  it('names the profile\'s total, not the document\'s, for a repository rules document over 32 KiB by itself', () => {
    const rule: DocumentRule = {
      origin: 'repository',
      profiles: new Set(['naming']),
      commit: COMMIT,
      held: new Map([
        ['naming', 62],
      ]),
    }
    const at = (documents: unknown[], given: DocumentRule): Array<readonly [string, string]> => documentIssues(documents, 'context.documents', given).map(issue => [issue.path, issue.message] as const)
    const wide = many(33, 'repo', 1024)
    // The 62 bytes the profile holds, then the document's up to the rule that takes it over: 62 and 33 792.
    expect(at([
      repositoryRules(wide),
    ], rule)).toEqual([
      [
        'context.documents.0.rules.32',
        `"RULES.yaml" at ccccccc ${inAll(33_854)}`,
      ],
    ])
    // The documents before it count as well, each profile's own: 10 000 bytes of one, then the 33 792.
    expect(at([
      repositoryRules(many(10, 'a', 1000), 'A.yaml'),
      repositoryRules(wide, 'B.yaml'),
    ], rule)).toEqual([
      [
        'context.documents.1.rules.32',
        `"B.yaml" at ccccccc ${inAll(43_854)}`,
      ],
    ])
    // A profile that holds nothing is counted from nothing, and the list as given by a rule that says none is the same.
    expect(at([
      repositoryRules(wide),
    ], {
      ...rule,
      held: new Map(),
    })).toEqual([
      [
        'context.documents.0.rules.32',
        `"RULES.yaml" at ccccccc ${inAll(33_792)}`,
      ],
    ])
    const { held: _held, ...bare } = rule
    expect(at([
      repositoryRules(wide),
    ], bare)).toEqual([
      [
        'context.documents.0.rules.32',
        `"RULES.yaml" at ccccccc ${inAll(33_792)}`,
      ],
    ])
  })
})
