import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveProfiles } from '../config/profiles.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import type { ConfigInput } from '../config/schema.ts'
import { documentSha256 } from '../core/documents.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { ReviewSource } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import { fakeGit, treeReply } from '../testing/git.ts'
import { readContext } from './read.ts'
import type { ContextOptions } from './read.ts'
import type { ReportRequest } from './reports.ts'

const BASE = 'b'.repeat(40)
const MERGE_BASE = 'c'.repeat(40)
const HEAD = 'd'.repeat(40)
const AT = 'e'.repeat(40)
const NAMING = {
  prompts: { research: 'Find naming issues.', vote: 'Judge from {{lens.id}}: {{lens.question}}' },
  lenses: [
    { id: 'grounded', question: 'Is it backed by a stated convention?' },
  ],
}
const SHA1 = 'sha1'
const NO_SOURCE_COMMIT = 'needs a commit to read it from, which a diff file or standard input does not name: review with --range, --local, --staged or --path, or name the file with { file }'
const NO_COMMIT_YET = 'needs a commit to read it from, and the repository has none yet: make a first commit, or name the file with { file }'

/** A resolved config of two profiles, `naming` (a program's) and `security` (the built-in one), each with a repository guideline, and `naming` also with an optional do-not-report document. */
function configOf(profiles: ConfigInput['profiles']): ResolvedConfig {
  const result = resolveProfiles({
    profiles,
    roles: { research: 'main', voter: 'main' },
    providers: ['main'],
    builtIn: new Map([
      [securityProfile.id, securityProfile],
    ]),
  })
  expect(result.issues).toEqual([])
  return { providers: {}, profiles: result.profiles, warnings: [] }
}

const TWO = configOf({
  naming: {
    ...NAMING,
    guidelines: [
      { repository: 'REVIEW.md' },
    ],
    doNotReport: [
      { repository: '.github/SKIP.md', optional: true },
    ],
  },
  security: {
    guidelines: [
      { repository: 'REVIEW.md' },
    ],
  },
})

/** A fake git whose commits hold a `REVIEW.md` and a `.github/SKIP.md`, and the options a read runs with. */
function git(): { options: Omit<ContextOptions, 'source'>, calls: ReturnType<typeof fakeGit>['calls'] } {
  const fake = fakeGit(treeReply([
    { path: 'REVIEW.md', content: 'Name things for what they do.' },
    { path: '.github/SKIP.md', content: 'Generated files.' },
  ]))
  return {
    options: {
      cwd: '/repo',
      env: { PATH: '/bin' },
      platform: 'linux',
      git: { executable: '/usr/bin/git', spawn: fake.spawn },
    },
    calls: fake.calls,
  }
}

/** The issues of the ConfigError a read is refused with. */
async function issuesOf(read: Promise<unknown>): Promise<readonly ConfigIssue[]> {
  const error: unknown = await read.then(() => undefined, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(ConfigError)
  return (error as ConfigError).issues
}

describe('readContext', () => {
  it.each<[string, ReviewSource, string]>([
    [
      'a diff source',
      { kind: 'diff' },
      NO_SOURCE_COMMIT,
    ],
    [
      'a local source with no commit yet',
      { kind: 'local', head: null, objectFormat: SHA1 },
      NO_COMMIT_YET,
    ],
    [
      'a staged source with no commit yet',
      { kind: 'staged', head: null, objectFormat: SHA1 },
      NO_COMMIT_YET,
    ],
  ])('refuses a repository document on %s, before any git runs for it', async (_name, source, message) => {
    const { options, calls } = git()
    expect(await issuesOf(readContext(TWO, { ...options, source }))).toEqual([
      { path: 'profiles.naming.guidelines.0.repository', message: `"REVIEW.md" ${message}` },
      { path: 'profiles.naming.doNotReport.0.repository', message: `".github/SKIP.md" ${message}` },
      { path: 'profiles.security.guidelines.0.repository', message: `"REVIEW.md" ${message}` },
    ])
    expect(calls).toEqual([])
  })

  it.each<[string, string, ReviewSource, string]>([
    [
      'range',
      'its base',
      {
        kind: 'range',
        base: BASE,
        mergeBase: MERGE_BASE,
        head: HEAD,
        objectFormat: SHA1,
      },
      BASE,
    ],
    [
      'paths',
      'its commit',
      {
        kind: 'paths',
        commit: AT,
        paths: ['src'],
        skips: true,
        objectFormat: SHA1,
      },
      AT,
    ],
    [
      'local',
      'its head',
      { kind: 'local', head: HEAD, objectFormat: SHA1 },
      HEAD,
    ],
    [
      'staged',
      'its head',
      { kind: 'staged', head: HEAD, objectFormat: SHA1 },
      HEAD,
    ],
  ])('reads the documents of a %s source at %s', async (_kind, _place, source, commit) => {
    const { options, calls } = git()

    const context = await readContext(TWO, { ...options, source })

    // Every profile's entries come from one listing and one read of the blobs, at the one commit the source names.
    expect(calls.filter(call => call.command[0] === 'ls-tree').map(call => call.command.at(-1))).toEqual([commit])
    expect(calls.filter(call => call.command[0] === 'cat-file')).toHaveLength(1)
    expect(context.documents?.map(document => [
      document.profile,
      document.kind,
      document.origin,
      document.text,
    ])).toEqual([
      [
        'naming',
        'guidelines',
        {
          kind: 'repository',
          path: 'REVIEW.md',
          commit,
          sha256: documentSha256('Name things for what they do.'),
        },
        'Name things for what they do.',
      ],
      [
        'naming',
        'do-not-report',
        {
          kind: 'repository',
          path: '.github/SKIP.md',
          commit,
          sha256: documentSha256('Generated files.'),
        },
        'Generated files.',
      ],
      [
        'security',
        'guidelines',
        {
          kind: 'repository',
          path: 'REVIEW.md',
          commit,
          sha256: documentSha256('Name things for what they do.'),
        },
        'Name things for what they do.',
      ],
    ])
  })

  it.each<[string, ReviewSource, string]>([
    [
      'range',
      {
        kind: 'range',
        base: BASE,
        mergeBase: MERGE_BASE,
        head: HEAD,
        objectFormat: SHA1,
      },
      '--range',
    ],
    [
      'paths',
      {
        kind: 'paths',
        commit: AT,
        paths: ['src'],
        skips: true,
        objectFormat: SHA1,
      },
      '--path',
    ],
    [
      'local',
      { kind: 'local', head: HEAD, objectFormat: SHA1 },
      '--local',
    ],
    [
      'staged',
      { kind: 'staged', head: HEAD, objectFormat: SHA1 },
      '--staged',
    ],
  ])('opens the repository of a %s source as its flag opens it', async (_kind, source, flag) => {
    const { options, calls } = git()
    expect(await issuesOf(readContext(TWO, { ...options, source, platform: 'win32' }))).toEqual([
      { path: flag, message: 'the git sources run on Linux and macOS: on Windows, pipe a diff in' },
    ])
    expect(calls).toEqual([])
  })

  it('runs no git for a config with no repository entry, whatever the source', async () => {
    const config = configOf({
      naming: {
        ...NAMING,
        guidelines: [
          { text: 'Name things for what they do.' },
        ],
      },
      security: {},
    })
    const { options, calls } = git()
    for (const source of [
      { kind: 'diff' },
      { kind: 'local', head: null, objectFormat: SHA1 },
      {
        kind: 'range',
        base: BASE,
        mergeBase: MERGE_BASE,
        head: HEAD,
        objectFormat: SHA1,
      },
    ] as const) {
      expect(await readContext(config, { ...options, source })).toEqual({})
    }
    expect(calls).toEqual([])
  })

  it('reads a profile of a hand-built config with no repository field as one with no entries, never a TypeError', async () => {
    const { options, calls } = git()
    const { profile } = TWO.profiles[0]
    const bare = {
      providers: {},
      profiles: [
        { profile, research: 'main', voters: {} },
      ],
      warnings: [],
    } as unknown as ResolvedConfig
    expect(await readContext(bare, {
      ...options,
      source: {
        kind: 'range',
        base: BASE,
        mergeBase: MERGE_BASE,
        head: HEAD,
        objectFormat: SHA1,
      },
    })).toEqual({})
    expect(calls).toEqual([])
  })

  it('reads a missing optional document as one with no text, and refuses a file the commit lacks otherwise', async () => {
    const { options } = git()
    const source: ReviewSource = {
      kind: 'range',
      base: BASE,
      mergeBase: MERGE_BASE,
      head: HEAD,
      objectFormat: SHA1,
    }
    const absent = configOf({
      naming: {
        ...NAMING,
        guidelines: [
          { repository: 'NOT-THERE.md', optional: true },
        ],
      },
    })
    expect((await readContext(absent, { ...options, source })).documents).toEqual([
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: { kind: 'repository', path: 'NOT-THERE.md', commit: BASE },
      },
    ])
    const required = configOf({
      naming: {
        ...NAMING,
        guidelines: [
          { repository: 'NOT-THERE.md' },
        ],
      },
    })
    expect(await issuesOf(readContext(required, { ...options, source }))).toEqual([
      { path: 'profiles.naming.guidelines.0.repository', message: `"NOT-THERE.md" is not a file of the commit ${BASE.slice(0, 7)} the review reads it from` },
    ])
  })
})

describe('readContext reports', () => {
  const RANGE: ReviewSource = {
    kind: 'range',
    base: BASE,
    mergeBase: MERGE_BASE,
    head: HEAD,
    objectFormat: SHA1,
  }
  const SECURITY = configOf({ security: {} })
  const written = (uri: string): unknown => ({
    ruleId: 'R',
    message: { text: 'm' },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          region: { startLine: 4 },
        },
      },
    ],
  })

  /** A directory of its own for the report files, which every test names by their absolute paths. */
  let dir = ''
  let scan: ReportRequest
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'quorum-context-'))
    writeFileSync(join(dir, 'scan.sarif'), JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: { name: 'Scanner' },
          },
          results: [
            written('file:///repo/src/a.js'),
            written('src/b.js'),
          ],
        },
      ],
    }))
    scan = {
      format: 'sarif',
      path: join(dir, 'scan.sarif'),
      profile: 'security',
    }
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The calls of a fake git that asked for the repository's top level or its version: one each for each time the repository was opened. */
  const openings = (calls: ReturnType<typeof git>['calls']): string[] => calls
    .map(call => call.command.join(' '))
    .filter(command => command === '--version' || command === 'rev-parse --show-toplevel')

  it('reads the reports with the repository\'s top level as the scan root, opening the repository once', async () => {
    const { options, calls } = git()

    const context = await readContext(TWO, {
      ...options,
      source: RANGE,
      reports: [scan],
    })

    // The documents and the reports share the one opening, and the listing and the blobs are read once.
    expect(openings(calls)).toEqual(['--version', 'rev-parse --show-toplevel'])
    expect(calls.filter(call => call.command[0] === 'ls-tree')).toHaveLength(1)
    expect(context.documents).toHaveLength(3)
    expect(context.reports).toHaveLength(1)
    expect(context.reports?.[0]).toMatchObject({
      format: 'sarif',
      profile: 'security',
      scanner: 'Scanner',
      problems: [],
    })
    // An absolute path under the top level loses it, and a relative one is the repository's own.
    expect(context.reports?.[0].issues.map(issue => issue.path)).toEqual(['src/a.js', 'src/b.js'])
  })

  it('opens the repository for a config that reads no document, to find the top level the reports name, and returns the reports alone', async () => {
    const { options, calls } = git()

    const context = await readContext(SECURITY, {
      ...options,
      source: RANGE,
      reports: [scan],
    })

    expect(openings(calls)).toEqual(['--version', 'rev-parse --show-toplevel'])
    expect(calls.some(call => call.command[0] === 'ls-tree')).toBe(false)
    expect(Object.keys(context)).toEqual(['reports'])
  })

  it('puts a scan root below the top level in front of every path, and leaves an absolute path outside it unmapped', async () => {
    const { options, calls } = git()

    const context = await readContext(SECURITY, {
      ...options,
      source: RANGE,
      reports: [scan],
      scanRoot: '/repo/packages/app/',
    })

    expect(openings(calls)).toEqual(['--version', 'rev-parse --show-toplevel'])
    expect(context.reports?.[0].issues.map(({ path, unmapped }) => [path, unmapped])).toEqual([
      [undefined, true],
      ['packages/app/src/b.js', undefined],
    ])
  })

  it('reads a diff source\'s reports with no scan root, so absolute paths are unmapped', async () => {
    const { options, calls } = git()
    const source: ReviewSource = { kind: 'diff' }

    const bare = await readContext(SECURITY, {
      ...options,
      source,
      reports: [scan],
    })
    expect(bare.reports?.[0].issues.map(({ path, unmapped }) => [path, unmapped])).toEqual([
      [undefined, true],
      ['src/b.js', undefined],
    ])
    const rooted = await readContext(SECURITY, {
      ...options,
      source,
      reports: [scan],
      scanRoot: '/repo',
    })
    expect(rooted.reports?.[0].issues.map(issue => issue.path)).toEqual(['src/a.js', 'src/b.js'])
    // A diff has no repository to open.
    expect(calls).toEqual([])
  })

  it('reads a report file that is missing as a report with its problem, and never throws for it', async () => {
    const { options } = git()
    const missing: ReportRequest = {
      format: 'sonarqube',
      path: join(dir, 'missing.json'),
      profile: 'security',
    }

    expect((await readContext(SECURITY, {
      ...options,
      source: RANGE,
      reports: [missing],
    })).reports).toEqual([
      {
        format: 'sonarqube',
        profile: 'security',
        problems: ['missing'],
        skipped: 0,
        unreadable: 0,
        issues: [],
      },
    ])
  })

  it('refuses a profile a report names that does not run, and a report with no profile while several run, before any git', async () => {
    const { options, calls } = git()
    const reports: ReportRequest[] = [
      { format: 'sarif', path: scan.path, profile: 'securty' },
      { format: 'sonarqube', path: scan.path },
    ]

    expect(await issuesOf(readContext(TWO, { ...options, source: RANGE, reports }))).toEqual([
      { path: '--sarif', message: 'names the profile "securty", which does not run' },
      { path: '--sonarqube', message: 'must name a profile when several run' },
    ])
    expect(calls).toEqual([])
  })

  it.each([
    ['a relative one', 'packages/app'],
    ['one with a .. segment', '/repo/../etc'],
    ['an empty one', ''],
  ])('refuses a scan root that is no absolute directory (%s), before any git', async (_words, scanRoot) => {
    const { options, calls } = git()

    expect(await issuesOf(readContext(SECURITY, {
      ...options,
      source: RANGE,
      reports: [scan],
      scanRoot,
    }))).toEqual([
      { path: 'scanRoot', message: 'must be an absolute directory' },
    ])
    expect(calls).toEqual([])
  })

  it('refuses more than 16 reports before reading any, and takes 16', async () => {
    const { options, calls } = git()
    const many = (count: number): ReportRequest[] => Array.from<ReportRequest>({ length: count }).fill(scan)

    expect(await issuesOf(readContext(SECURITY, {
      ...options,
      source: RANGE,
      reports: many(17),
    }))).toEqual([
      { path: 'reports', message: 'takes at most 16 reports in all' },
    ])
    expect(calls).toEqual([])
    expect((await readContext(SECURITY, {
      ...options,
      source: RANGE,
      reports: many(16),
    })).reports).toHaveLength(16)
  })

  it('refuses a repository document on a diff source before it reads a report', async () => {
    const { options, calls } = git()

    expect(await issuesOf(readContext(TWO, {
      ...options,
      source: { kind: 'diff' },
      reports: [scan],
    }))).toEqual([
      { path: 'profiles.naming.guidelines.0.repository', message: `"REVIEW.md" ${NO_SOURCE_COMMIT}` },
      { path: 'profiles.naming.doNotReport.0.repository', message: `".github/SKIP.md" ${NO_SOURCE_COMMIT}` },
      { path: 'profiles.security.guidelines.0.repository', message: `"REVIEW.md" ${NO_SOURCE_COMMIT}` },
    ])
    expect(calls).toEqual([])
  })
})
