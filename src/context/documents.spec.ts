import { describe, expect, it } from 'vitest'
import { resolveProfiles } from '../config/profiles.ts'
import type { ResolvedProfile } from '../config/profiles.ts'
import type { ConfigInput } from '../config/schema.ts'
import { documentSha256 } from '../core/documents.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { Profile } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import { GitError, MAX_GIT_OUTPUT_BYTES, openRepository } from '../git/run.ts'
import type { Repository } from '../git/run.ts'
import { fakeGit, treeReply } from '../testing/git.ts'
import type { GitCall, TreeFile } from '../testing/git.ts'
import { readRepositoryDocuments } from './documents.ts'

/** A commit whose first 7 characters are the short id the messages hold. */
const COMMIT = `1f3a9c2${'0'.repeat(33)}`
const SHORT = '1f3a9c2'
const NAMING = {
  prompts: { research: 'Find naming issues.', vote: 'Judge from {{lens.id}}: {{lens.question}}' },
  lenses: [
    { id: 'grounded', question: 'Is it backed by a stated convention?' },
  ],
}
/** A built-in profile of the test's own, with a do-not-report text of its own: `security` has none. */
const CONVENTIONS: Profile = {
  id: 'conventions',
  prompts: NAMING.prompts,
  lenses: NAMING.lenses,
  doNotReport: 'Style and formatting.',
}
const NO_REMOVED = { characters: 0, comments: 0, entities: 0 }
/** The id `treeReply` gives the file at `position` of the tree, from 1. */
const idOf = (position: number): string => position.toString(16).padStart(40, '0')

/** The profiles a config resolves to, with the issues expected to be none. */
function resolved(profiles: ConfigInput['profiles']): ResolvedProfile[] {
  const result = resolveProfiles({
    profiles,
    roles: { research: 'main', voter: 'main' },
    providers: ['main'],
    builtIn: new Map([
      [securityProfile.id, securityProfile],
      [CONVENTIONS.id, CONVENTIONS],
    ]),
  })
  expect(result.issues).toEqual([])
  return [...result.profiles]
}

/** Every `{ repository }` entry of the profiles, with its profile, in the order `readContext` collects them. */
function entriesOf(profiles: readonly ResolvedProfile[]): Array<{ profile: ResolvedProfile, entry: ResolvedProfile['repository'][number] }> {
  return profiles.flatMap(profile => profile.repository.map(entry => ({ profile, entry })))
}

/** A repository opened on a fake git whose commits hold `files`, and the calls made after it opened. */
async function open(files: readonly TreeFile[], reply: (call: GitCall) => ReturnType<ReturnType<typeof treeReply>> = () => undefined): Promise<{ repository: Repository, calls: GitCall[] }> {
  const tree = treeReply(files)
  const fake = fakeGit(call => reply(call) ?? tree(call))
  const repository = await openRepository({
    git: '/usr/bin/git',
    cwd: '/repo',
    env: { PATH: '/bin' },
    flag: '--path',
    spawn: fake.spawn,
  })
  fake.calls.splice(0)
  return { repository, calls: fake.calls }
}

/** The issues of the ConfigError a read is refused with. */
async function issuesOf(read: Promise<unknown>): Promise<readonly ConfigIssue[]> {
  const error: unknown = await read.then(() => undefined, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(ConfigError)
  return (error as ConfigError).issues
}

const REVIEW = 'REVIEW.md'
function naming(fields: Record<string, unknown>): ConfigInput['profiles'] {
  return {
    naming: {
      ...NAMING,
      ...fields,
    },
  }
}
function only(fields: Record<string, unknown>, files: readonly TreeFile[]) {
  return async (): Promise<readonly ConfigIssue[]> => {
    const profiles = resolved(naming(fields))
    const { repository } = await open(files)
    return issuesOf(readRepositoryDocuments(entriesOf(profiles), repository, COMMIT))
  }
}

describe('readRepositoryDocuments', () => {
  it('reads every repository document of every profile with one listing and one read of the blobs', async () => {
    const guideline = 'Name things for what they do.'
    const profiles = resolved({
      naming: {
        ...NAMING,
        guidelines: [
          { repository: REVIEW },
        ],
        doNotReport: [
          { repository: 'SKIP.md' },
        ],
      },
      security: {
        guidelines: [
          { repository: REVIEW },
        ],
      },
    })
    const { repository, calls } = await open([
      { path: REVIEW, content: `${guideline}<!-- note -->` },
      { path: 'SKIP.md', content: 'Generated files.' },
      { path: 'src/unrelated.ts', content: 'export {}\n' },
    ])

    const documents = await readRepositoryDocuments(entriesOf(profiles), repository, COMMIT)

    // Three entries, two files: each is read once, and the documents come in the order of the entries, each cleaned and hashed as read.
    const origin = (path: string, text: string): object => ({
      kind: 'repository',
      path,
      commit: COMMIT,
      sha256: documentSha256(text),
    })
    expect(documents).toEqual([
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: origin(REVIEW, `${guideline}<!-- note -->`),
        text: guideline,
        removed: { characters: 0, comments: 1, entities: 0 },
      },
      {
        profile: 'naming',
        kind: 'do-not-report',
        origin: origin('SKIP.md', 'Generated files.'),
        text: 'Generated files.',
        removed: NO_REMOVED,
      },
      {
        profile: 'security',
        kind: 'guidelines',
        origin: origin(REVIEW, `${guideline}<!-- note -->`),
        text: guideline,
        removed: { characters: 0, comments: 1, entities: 0 },
      },
    ])
    expect(documents.every(document => Object.isFrozen(document) && Object.isFrozen(document.origin))).toBe(true)
    expect(calls.map(call => call.command[0])).toEqual(['ls-tree', 'cat-file'])
    expect(calls[0].command.at(-1)).toBe(COMMIT)
    expect(calls[1].stdin).toBe(`${idOf(1)}\n${idOf(2)}\n`)
  })

  it('reads nothing and runs no git for no entry', async () => {
    const { repository, calls } = await open([])
    expect(await readRepositoryDocuments([], repository, COMMIT)).toEqual([])
    expect(calls).toEqual([])
  })

  it.each<[string, readonly TreeFile[], string]>([
    [
      'is absent',
      [
        { path: 'README.md', content: 'x' },
      ],
      `"REVIEW.md" is not a file of the commit ${SHORT} the review reads it from`,
    ],
    [
      'is a directory',
      [
        { path: 'REVIEW.md/a.md', content: 'x' },
      ],
      `"REVIEW.md" is not a file of the commit ${SHORT} the review reads it from`,
    ],
    [
      'is a link',
      [
        { path: REVIEW, content: 'docs/review.md', mode: '120000' },
      ],
      `"REVIEW.md" is a symbolic link at ${SHORT}, which quorum does not follow`,
    ],
    [
      'is a gitlink',
      [
        { path: REVIEW, mode: '160000' },
      ],
      `"REVIEW.md" is a submodule's commit at ${SHORT}, which quorum does not read`,
    ],
    [
      'holds a NUL in its first 8000 bytes',
      [
        {
          path: REVIEW,
          content: Uint8Array.from([0x61, 0x62, 0x00, 0x63]),
        },
      ],
      `"REVIEW.md" is not UTF-8 text at ${SHORT}`,
    ],
    [
      'does not decode',
      [
        {
          path: REVIEW,
          content: Uint8Array.from([0x61, 0xFF, 0xFE, 0x62]),
        },
      ],
      `"REVIEW.md" is not UTF-8 text at ${SHORT}`,
    ],
    [
      'holds 65 537 bytes',
      [
        {
          path: REVIEW,
          content: 'x'.repeat(65_537),
        },
      ],
      `"REVIEW.md" holds 65537 bytes at ${SHORT}, over the 64 KiB quorum reads of a document`,
    ],
    [
      'is over its cap once cleaned',
      [
        {
          path: REVIEW,
          content: 'x'.repeat(17_020),
        },
      ],
      `"REVIEW.md" at ${SHORT} holds 17020 bytes once cleaned, over the 16 KiB a guidelines document may hold`,
    ],
    [
      'is unsettled',
      [
        { path: REVIEW, content: '<'.repeat(16) + '!---->'.repeat(16) },
      ],
      `"REVIEW.md" at ${SHORT} nests HTML comments or character references too deep to clean in 16 passes: remove them`,
    ],
  ])('refuses a repository document that %s, at its entry', async (_name, files, message) => {
    const issues = await only({
      guidelines: [
        { repository: REVIEW },
      ],
    }, files)()
    expect(issues).toEqual([
      { path: 'profiles.naming.guidelines.0.repository', message },
    ])
    // A document is never repeated in what refuses it.
    expect(JSON.stringify(issues)).not.toContain('xxxx')
  })

  it('refuses a do-not-report document over its own cap, in the words of its kind', async () => {
    expect(await only({
      doNotReport: [
        { repository: REVIEW },
      ],
    }, [
      {
        path: REVIEW,
        content: 'x'.repeat(8193),
      },
    ])()).toEqual([
      { path: 'profiles.naming.doNotReport.0.repository', message: `"REVIEW.md" at ${SHORT} holds 8193 bytes once cleaned, over the 8 KiB a do-not-report document may hold` },
    ])
  })

  it('refuses a document that takes its kind over the cap of all of them, with the profile\'s own text and its { file } documents counted first', async () => {
    const files: TreeFile[] = [
      {
        path: 'SKIP.md',
        content: 'x'.repeat(4200),
      },
      {
        path: 'MORE.md',
        content: 'y'.repeat(100),
      },
    ]
    // The profile's own text is 21 bytes and a { text } document 4000: 4200 more make 8221, over 8192, at the first entry that does.
    const profiles = resolved({
      conventions: {
        doNotReport: [
          {
            text: 'z'.repeat(4000),
          },
          { repository: 'SKIP.md' },
          { repository: 'MORE.md' },
        ],
      },
    })
    const { repository } = await open(files)
    expect(await issuesOf(readRepositoryDocuments(entriesOf(profiles), repository, COMMIT))).toEqual([
      { path: 'profiles.conventions.doNotReport.1.repository', message: `"SKIP.md" at ${SHORT} takes the profile's do-not-report text to 8221 bytes once cleaned, over the 8 KiB it may hold in all` },
    ])

    // The same documents beside a profile that drops its own text, and with no { text } document, fit.
    const fits = resolved({
      conventions: {
        builtInDoNotReport: false,
        doNotReport: [
          { repository: 'SKIP.md' },
          { repository: 'MORE.md' },
        ],
      },
    })
    expect((await readRepositoryDocuments(entriesOf(fits), repository, COMMIT)).map(document => document.text?.length)).toEqual([4200, 100])
  })

  it('counts a profile\'s repository documents apart from another profile\'s', async () => {
    const profiles = resolved({
      naming: {
        ...NAMING,
        guidelines: [
          { repository: 'ONE.md' },
        ],
      },
      conventions: {
        guidelines: [
          { repository: 'TWO.md' },
        ],
      },
    })
    const { repository } = await open([
      {
        path: 'ONE.md',
        content: 'a'.repeat(10_000),
      },
      {
        path: 'TWO.md',
        content: 'b'.repeat(10_000),
      },
    ])
    expect(await readRepositoryDocuments(entriesOf(profiles), repository, COMMIT)).toHaveLength(2)
  })

  it('records a missing optional document with no text, and refuses a link even when optional', async () => {
    const profiles = resolved(naming({
      guidelines: [
        { repository: 'ABSENT.md', optional: true },
        { repository: REVIEW },
      ],
    }))
    const { repository, calls } = await open([
      { path: REVIEW, content: 'Be kind.' },
    ])
    expect(await readRepositoryDocuments(entriesOf(profiles), repository, COMMIT)).toEqual([
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: { kind: 'repository', path: 'ABSENT.md', commit: COMMIT },
      },
      expect.objectContaining({
        origin: expect.objectContaining({ path: REVIEW }),
        text: 'Be kind.',
      }),
    ])
    expect(calls[1].stdin).toBe(`${idOf(1)}\n`)

    // A link, a gitlink and a file over 64 KiB are refused all the same: optional says the file may be absent, never that it may be unreadable.
    for (const [file, message] of [
      [
        { path: REVIEW, content: 'docs/x.md', mode: '120000' },
        `"REVIEW.md" is a symbolic link at ${SHORT}, which quorum does not follow`,
      ],
      [
        { path: REVIEW, mode: '160000' },
        `"REVIEW.md" is a submodule's commit at ${SHORT}, which quorum does not read`,
      ],
      [
        {
          path: REVIEW,
          content: 'x'.repeat(65_537),
        },
        `"REVIEW.md" holds 65537 bytes at ${SHORT}, over the 64 KiB quorum reads of a document`,
      ],
    ] as const) {
      const optional = resolved(naming({
        guidelines: [
          { repository: REVIEW, optional: true },
        ],
      }))
      const linked = await open([file])
      expect(await issuesOf(readRepositoryDocuments(entriesOf(optional), linked.repository, COMMIT))).toEqual([
        { path: 'profiles.naming.guidelines.0.repository', message },
      ])
    }
  })

  it('reads a blank document, recorded with no bytes, and takes the cleaned text of one that is hidden text only', async () => {
    const profiles = resolved(naming({
      guidelines: [
        { repository: 'EMPTY.md' },
        { repository: 'HIDDEN.md' },
      ],
    }))
    const { repository } = await open([
      { path: 'EMPTY.md', content: '' },
      { path: 'HIDDEN.md', content: '<!-- nothing to read -->' },
    ])
    expect(await readRepositoryDocuments(entriesOf(profiles), repository, COMMIT)).toEqual([
      expect.objectContaining({ text: '', removed: NO_REMOVED }),
      expect.objectContaining({
        text: '',
        removed: { characters: 0, comments: 1, entities: 0 },
      }),
    ])
  })

  it('refuses a blob over 64 KiB before it reads one, and reads no blob when none is left to read', async () => {
    const profiles = resolved(naming({
      guidelines: [
        { repository: REVIEW },
      ],
    }))
    const { repository, calls } = await open([
      {
        path: REVIEW,
        content: 'x'.repeat(65_537),
      },
    ])
    await issuesOf(readRepositoryDocuments(entriesOf(profiles), repository, COMMIT))
    expect(calls.map(call => call.command[0])).toEqual(['ls-tree'])
  })

  it('reports every entry\'s problem at once, in the order of the entries, each at its own path', async () => {
    const profiles = resolved({
      naming: {
        ...NAMING,
        guidelines: [
          { repository: 'ABSENT.md' },
          { repository: 'LINK.md' },
          { repository: 'GOOD.md' },
          { repository: 'BINARY.md' },
        ],
        doNotReport: [
          { repository: 'BIG.md' },
        ],
      },
      security: {
        guidelines: [
          { repository: 'SUB' },
        ],
      },
    })
    const { repository, calls } = await open([
      { path: 'LINK.md', content: 'GOOD.md', mode: '120000' },
      { path: 'GOOD.md', content: 'Fine.' },
      {
        path: 'BINARY.md',
        content: Uint8Array.from([0, 1, 2]),
      },
      {
        path: 'BIG.md',
        content: 'x'.repeat(9000),
      },
      { path: 'SUB', mode: '160000' },
    ])
    expect(await issuesOf(readRepositoryDocuments(entriesOf(profiles), repository, COMMIT))).toEqual([
      { path: 'profiles.naming.guidelines.0.repository', message: `"ABSENT.md" is not a file of the commit ${SHORT} the review reads it from` },
      { path: 'profiles.naming.guidelines.1.repository', message: `"LINK.md" is a symbolic link at ${SHORT}, which quorum does not follow` },
      { path: 'profiles.naming.guidelines.3.repository', message: `"BINARY.md" is not UTF-8 text at ${SHORT}` },
      { path: 'profiles.naming.doNotReport.0.repository', message: `"BIG.md" at ${SHORT} holds 9000 bytes once cleaned, over the 8 KiB a do-not-report document may hold` },
      { path: 'profiles.security.guidelines.0.repository', message: `"SUB" is a submodule's commit at ${SHORT}, which quorum does not read` },
    ])
    // The files that can be read are read together, in one call.
    expect(calls.map(call => call.command[0])).toEqual(['ls-tree', 'cat-file'])
  })

  it('quotes a long path cut at 100 characters, and never a document\'s text', async () => {
    const path = `${'d/'.repeat(60)}REVIEW.md`
    const issues = await only({
      guidelines: [
        { repository: path },
      ],
    }, [])()
    expect(issues).toEqual([
      { path: 'profiles.naming.guidelines.0.repository', message: `${JSON.stringify(`${path.slice(0, 100)}…`)} is not a file of the commit ${SHORT} the review reads it from` },
    ])
  })

  it('matches a path as its exact bytes: a name led by a byte-order mark or that is no UTF-8 is another file', async () => {
    const profiles = resolved(naming({
      guidelines: [
        { repository: REVIEW },
      ],
    }))
    const record = (path: Uint8Array): Buffer => Buffer.concat([
      Buffer.from(`100644 blob ${idOf(1)} ${'1'.padStart(7)}\t`),
      path,
      Buffer.from([0]),
    ])
    const { repository } = await open([], ({ command }) => command[0] === 'ls-tree'
      ? {
          stdout: Buffer.concat([
            record(Buffer.from(`${String.fromCharCode(0xFEFF)}REVIEW.md`)),
            record(Buffer.concat([
              Buffer.from('REVIEW'),
              Buffer.from([0xFF]),
              Buffer.from('.md'),
            ])),
          ]),
        }
      : undefined)
    expect(await issuesOf(readRepositoryDocuments(entriesOf(profiles), repository, COMMIT))).toEqual([
      { path: 'profiles.naming.guidelines.0.repository', message: `"REVIEW.md" is not a file of the commit ${SHORT} the review reads it from` },
    ])
  })

  it('refuses a listing that goes on past what quorum reads with no end to a name, as a failure of git', async () => {
    const profiles = resolved(naming({
      guidelines: [
        { repository: REVIEW },
      ],
    }))
    const { repository } = await open([], ({ command }) => command[0] === 'ls-tree'
      ? { stdout: `100644 blob ${idOf(1)} ${'1'.padStart(7)}\t${'x'.repeat(MAX_GIT_OUTPUT_BYTES + 200)}` }
      : undefined)
    const error: unknown = await readRepositoryDocuments(entriesOf(profiles), repository, COMMIT).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe('git ls-tree printed more file names than quorum reads')
  })
})

describe('readRepositoryDocuments with rules files', () => {
  const LICENSE = { id: 'license', text: 'Each file starts with the license header.' }
  const IO_ERRORS = { id: 'io-errors', text: 'Every I/O call handles its error.' }
  /** A built-in profile of the test's own, with two rules of its own: `security` has none. */
  const RULED: Profile = {
    id: 'ruled',
    prompts: NAMING.prompts,
    lenses: NAMING.lenses,
    rules: [LICENSE, IO_ERRORS],
  }
  function resolvedRules(profiles: ConfigInput['profiles']): ResolvedProfile[] {
    const result = resolveProfiles({
      profiles,
      roles: { research: 'main', voter: 'main' },
      providers: ['main'],
      builtIn: new Map([
        [RULED.id, RULED],
      ]),
    })
    expect(result.issues).toEqual([])
    return [...result.profiles]
  }
  const YAML = '- id: no-any\n  text: No any outside tests.\n  paths: ["src/**"]\n- id: naming\n  text: Names say what a value is.\n'
  const JSON_RULES = '[{"id": "errors", "text": "Handle the error."}]'
  const place = `"RULES.yaml" at ${SHORT}`
  /** The issues a rules file of `content` at RULES.yaml is refused with, as the profile `fields` names it. */
  async function refusedWith(content: string, fields: Record<string, unknown> = {
    rules: [
      { repository: 'RULES.yaml' },
    ],
  }, profile = 'ruled'): Promise<readonly ConfigIssue[]> {
    const profiles = resolvedRules({ [profile]: fields } as ConfigInput['profiles'])
    const { repository } = await open([
      { path: 'RULES.yaml', content },
    ])
    return issuesOf(readRepositoryDocuments(entriesOf(profiles), repository, COMMIT))
  }

  it('reads a repository rules file by its extension, and refuses an id the config already holds', async () => {
    const profiles = resolvedRules({
      ruled: {
        rules: [
          { repository: 'RULES.yaml' },
          { repository: 'rules/more.json' },
          { repository: 'rules/optional.yml', optional: true },
          { repository: 'rules/absent.yaml', optional: true },
        ],
      },
    })
    const { repository, calls } = await open([
      { path: 'RULES.yaml', content: `${YAML}# note\n` },
      { path: 'rules/more.json', content: JSON_RULES },
      { path: 'rules/optional.yml', content: `- id: optional\n  text: Kept.${String.fromCharCode(0x200B)}\n` },
      { path: 'src/unrelated.ts', content: 'export {}\n' },
    ])
    const documents = await readRepositoryDocuments(entriesOf(profiles), repository, COMMIT)
    const origin = (path: string, text: string): object => ({
      kind: 'repository',
      path,
      commit: COMMIT,
      sha256: documentSha256(text),
    })
    // Each file is parsed by its extension, its texts cleaned and its hash taken of the text as read; a missing optional file is a document with no rules.
    expect(documents).toStrictEqual([
      {
        profile: 'ruled',
        kind: 'rules',
        origin: origin('RULES.yaml', `${YAML}# note\n`),
        rules: [
          {
            id: 'no-any',
            text: 'No any outside tests.',
            paths: ['src/**'],
          },
          { id: 'naming', text: 'Names say what a value is.' },
        ],
        removed: NO_REMOVED,
      },
      {
        profile: 'ruled',
        kind: 'rules',
        origin: origin('rules/more.json', JSON_RULES),
        rules: [
          { id: 'errors', text: 'Handle the error.' },
        ],
        removed: NO_REMOVED,
      },
      {
        profile: 'ruled',
        kind: 'rules',
        origin: origin('rules/optional.yml', `- id: optional\n  text: Kept.${String.fromCharCode(0x200B)}\n`),
        rules: [
          { id: 'optional', text: 'Kept.' },
        ],
        removed: { characters: 1, comments: 0, entities: 0 },
      },
      {
        profile: 'ruled',
        kind: 'rules',
        origin: { kind: 'repository', path: 'rules/absent.yaml', commit: COMMIT },
      },
    ])
    expect(documents.every(document => Object.isFrozen(document) && Object.isFrozen(document.origin))).toBe(true)
    expect(documents.flatMap(document => document.rules ?? []).every(rule => Object.isFrozen(rule))).toBe(true)
    // One listing and one read of the three blobs, as for any document.
    expect(calls.map(call => call.command[0])).toEqual(['ls-tree', 'cat-file'])

    // Any other extension is refused, a file that is absent and optional too, and no blob is read for it.
    const txt = resolvedRules({
      ruled: {
        rules: [
          { repository: 'rules.txt' },
          { repository: 'rules.YAML', optional: true },
          { repository: 'rules' },
        ],
      },
    })
    const none = await open([
      { path: 'rules.txt', content: YAML },
    ])
    expect(await issuesOf(readRepositoryDocuments(entriesOf(txt), none.repository, COMMIT))).toEqual([
      { path: 'profiles.ruled.rules.0.repository', message: `"rules.txt" at ${SHORT} must end in .yaml, .yml or .json` },
      { path: 'profiles.ruled.rules.1.repository', message: `"rules.YAML" at ${SHORT} must end in .yaml, .yml or .json` },
      { path: 'profiles.ruled.rules.2.repository', message: `"rules" at ${SHORT} must end in .yaml, .yml or .json` },
    ])
    expect(none.calls.map(call => call.command[0])).toEqual(['ls-tree'])

    // An id the profile's own rules (the built-in's), its config documents or an earlier repository file holds is refused, at the later file.
    expect(await refusedWith('- id: license\n  text: Again.\n')).toEqual([
      { path: 'profiles.ruled.rules.0.repository', message: `${place} repeats the rule id "license"` },
    ])
    expect(await refusedWith('- id: shared\n  text: In the file.\n', {
      rules: [
        { id: 'shared', text: 'In the config.' },
        { repository: 'RULES.yaml' },
      ],
    })).toEqual([
      { path: 'profiles.ruled.rules.1.repository', message: `${place} repeats the rule id "shared"` },
    ])
    const twice = resolvedRules({
      ruled: {
        rules: [
          { repository: 'RULES.yaml' },
          { repository: 'rules/more.json' },
        ],
      },
    })
    const both = await open([
      { path: 'RULES.yaml', content: '- id: errors\n  text: First.\n- id: other\n  text: Second.\n' },
      { path: 'rules/more.json', content: JSON_RULES },
    ])
    expect(await issuesOf(readRepositoryDocuments(entriesOf(twice), both.repository, COMMIT))).toEqual([
      { path: 'profiles.ruled.rules.1.repository', message: `"rules/more.json" at ${SHORT} repeats the rule id "errors"` },
    ])
    // The built-in's rules are the profile's own only until the entry drops them.
    const dropped = resolvedRules({
      ruled: {
        builtInRules: false,
        rules: [
          { repository: 'RULES.yaml' },
        ],
      },
    })
    const reused = await open([
      { path: 'RULES.yaml', content: '- id: license\n  text: Again.\n' },
    ])
    expect(await readRepositoryDocuments(entriesOf(dropped), reused.repository, COMMIT)).toHaveLength(1)
  })

  it('reads a repository rules file that holds no rule as a document of no rules, optional or not, never an issue', async () => {
    const profiles = resolvedRules({
      ruled: {
        rules: [
          { repository: 'rules/empty.json', optional: true },
          { repository: 'rules/notes.yaml' },
          { repository: 'rules/blank.yml' },
          { repository: 'rules/required.json' },
        ],
      },
    })
    const { repository } = await open([
      { path: 'rules/empty.json', content: '[]' },
      { path: 'rules/notes.yaml', content: '# nothing yet\n' },
      { path: 'rules/blank.yml', content: '' },
      { path: 'rules/required.json', content: '[]' },
    ])
    const documents = await readRepositoryDocuments(entriesOf(profiles), repository, COMMIT)
    expect(documents).toStrictEqual([
      ['rules/empty.json', '[]'],
      ['rules/notes.yaml', '# nothing yet\n'],
      ['rules/blank.yml', ''],
      ['rules/required.json', '[]'],
    ].map(([path, text]) => ({
      profile: 'ruled',
      kind: 'rules',
      origin: {
        kind: 'repository',
        path,
        commit: COMMIT,
        sha256: documentSha256(text),
      },
      rules: [],
      removed: NO_REMOVED,
    })))
    // The profile's own rules and the ids of the files after them are as they were: an empty file takes none, and repeats none.
    const mixed = resolvedRules({
      ruled: {
        rules: [
          { repository: 'rules/empty.json' },
          { repository: 'RULES.yaml' },
        ],
      },
    })
    const both = await open([
      { path: 'rules/empty.json', content: '[]' },
      { path: 'RULES.yaml', content: YAML },
    ])
    expect(await readRepositoryDocuments(entriesOf(mixed), both.repository, COMMIT)).toHaveLength(2)
  })

  it('refuses a rules file that is no list, holds a rule that is not valid or is not YAML or JSON, at its entry, in the file\'s own words', async () => {
    const at = (message: string): ConfigIssue[] => [
      { path: 'profiles.ruled.rules.0.repository', message: `${place} ${message}` },
    ]
    expect(await refusedWith('id: a\ntext: x\n')).toEqual(at('must be a list of rules'))
    expect(await refusedWith('- {id: a, text: x}\n- {id: b, text: x}\n- {id: c, text: x}\n- {id: Bad Id, text: x}\n')).toEqual(at('3.id must match ^[a-z][a-z0-9._-]{0,63}$'))
    expect(await refusedWith('- id: a\n  text: x\n  colour: blue\n')).toEqual(at('0.colour is not a known field'))
    expect(await refusedWith('- id: a\n  text: x\n  text: y\n')).toEqual(at('is not valid YAML at line 3, column 3 (DUPLICATE_KEY)'))
    expect(await refusedWith('- &a {id: a, text: x}\n- *a\n')).toEqual(at('uses an alias, which quorum does not read'))
    expect(await refusedWith('- id: a\n  text: !!binary aGVsbG8=\n')).toEqual(at('uses a tag quorum does not read at line 2, column 9 (TAG_RESOLVE_FAILED)'))
    expect(await refusedWith('- {id: a, text: "<!-- hidden -->"}\n')).toEqual(at('0.text must hold 1 to 1024 characters once cleaned'))
    expect(await refusedWith('- {id: a, text: x, paths: []}\n')).toEqual(at('0.paths must hold 1 to 20 patterns'))
    expect(await refusedWith(`- id: a\n  text: ${'<'.repeat(16) + '!---->'.repeat(16)}\n`)).toEqual(at('0.text nests HTML comments or character references too deep to clean in 16 passes: remove them'))
    expect(await refusedWith('- id: a\n  text: x\n- id: b\n  text: y\n- id: a\n  text: z\n')).toEqual(at('2.id repeats the rule id "a"'))
    // A document's text is never repeated in what refuses it.
    expect(JSON.stringify(await refusedWith('- id: a\n  text: [planted]\n'))).not.toContain('planted')
  })

  it('refuses a rules file over the 32 KiB alone, which the totals do not tell, and one that makes more than 100 rules, at its entry', async () => {
    const rules = (count: number, bytes: number): string => JSON.stringify(Array.from({ length: count }, (_, index) => ({
      id: `r${index}`,
      text: 'x'.repeat(bytes),
    })))
    // 33 rules of 1000 bytes: no rule is over its 1024 characters and the file is under 64 KiB, but the cleaned texts come to 33000 bytes, over the cap, in one document.
    const alone = await open([
      {
        path: 'RULES.json',
        content: rules(33, 1000),
      },
    ])
    const profiles = resolvedRules({
      naming: {
        ...NAMING,
        rules: [
          { repository: 'RULES.json' },
        ],
      },
    })
    expect(await issuesOf(readRepositoryDocuments(entriesOf(profiles), alone.repository, COMMIT))).toEqual([
      { path: 'profiles.naming.rules.0.repository', message: `"RULES.json" at ${SHORT} takes the profile's rules to 33000 bytes once cleaned, over the 32 KiB they may hold in all` },
    ])
    // The profile's own rules and config documents count first: the built-in's two rules take 74 bytes, an inline rule 1000, so 32 more of 1000 are the rule that takes them over.
    const held = resolvedRules({
      ruled: {
        rules: [
          {
            id: 'inline',
            text: 'y'.repeat(1000),
          },
          { repository: 'RULES.json' },
        ],
      },
    })
    const near = await open([
      {
        path: 'RULES.json',
        content: rules(32, 1000),
      },
    ])
    expect(await issuesOf(readRepositoryDocuments(entriesOf(held), near.repository, COMMIT))).toEqual([
      { path: 'profiles.ruled.rules.1.repository', message: `"RULES.json" at ${SHORT} takes the profile's rules to 33074 bytes once cleaned, over the 32 KiB they may hold in all` },
    ])
    const count = await open([
      {
        path: 'RULES.json',
        content: rules(101, 1),
      },
    ])
    expect(await issuesOf(readRepositoryDocuments(entriesOf(profiles), count.repository, COMMIT))).toEqual([
      { path: 'profiles.naming.rules.0.repository', message: `"RULES.json" at ${SHORT} must hold at most 100 rules` },
    ])
    // Two files that fit alone and take the profile's rules over the caps together: the second is refused, in the words of the total.
    const two = resolvedRules({
      naming: {
        ...NAMING,
        rules: [
          { repository: 'ONE.json' },
          { repository: 'TWO.json' },
        ],
      },
    })
    const together = await open([
      {
        path: 'ONE.json',
        content: JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
          id: `a${index}`,
          text: 'x'.repeat(1000),
        }))),
      },
      {
        path: 'TWO.json',
        content: JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
          id: `b${index}`,
          text: 'x'.repeat(1000),
        }))),
      },
    ])
    expect(await issuesOf(readRepositoryDocuments(entriesOf(two), together.repository, COMMIT))).toEqual([
      { path: 'profiles.naming.rules.1.repository', message: `"TWO.json" at ${SHORT} takes the profile's rules to 33000 bytes once cleaned, over the 32 KiB they may hold in all` },
    ])
  })
})
