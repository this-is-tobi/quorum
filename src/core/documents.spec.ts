import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DocumentRule } from './documents.ts'
import { capProblem, DOCUMENT_CAPS, documentCommit, documentIssues, documentSha256, joined, profileTexts, totalProblem, UNSETTLED, withRepository } from './documents.ts'
import type { Profile, ReviewDocument, ReviewSource } from './types.ts'

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
      kind: 'rules',
    })).toEqual([
      ['context.documents.0.kind', 'must be guidelines or do-not-report'],
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
