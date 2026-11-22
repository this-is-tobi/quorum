import { describe, expect, it } from 'vitest'
import { reviewScope } from '../core/coverage.ts'
import { ConfigError } from '../core/errors.ts'
import { secretFlags } from '../core/flags.ts'
import { MAX_GIT_OUTPUT_BYTES } from '../git/run.ts'
import { fakeCredential } from '../testing/credentials.ts'
import { fakeGit } from '../testing/git.ts'
import type { GitBase, GitCall, GitReply } from '../testing/git.ts'
import { pathsSource } from './paths.ts'
import type { SourceContext } from './read.ts'

const COMMIT = 'c'.repeat(40)
const OID = 'a'.repeat(64)
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12345\n`
const NO_COMMIT = 'needs a commit, and HEAD names none: commit first, or name one with --at'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** One entry of the fake commit's tree, before it has an id: a file, or a gitlink when `gitlink` is set. */
interface Spec {
  readonly path: string | Uint8Array
  readonly content?: string | Uint8Array
  readonly gitlink?: boolean
  /** The size `ls-tree` prints, when it is not the content's. */
  readonly listedSize?: number
}

interface Tracked extends Spec {
  readonly id: string
  readonly name: Uint8Array
  readonly bytes: Uint8Array
}

/** The entries with an id of `length` hexadecimal digits each, numbered from 1 in the order given. */
function tracked(specs: readonly Spec[], length = 40): Tracked[] {
  return specs.map((spec, index) => ({
    ...spec,
    id: (index + 1).toString(16).padStart(length, '0'),
    name: typeof spec.path === 'string'
      ? encode(spec.path)
      : spec.path,
    bytes: typeof spec.content === 'string'
      ? encode(spec.content)
      : spec.content ?? new Uint8Array(0),
  }))
}

/** The tree of most tests, in git's order. */
const TREE: readonly Spec[] = [
  { path: 'a.ts', content: 'export const a = 1\n' },
  { path: 'empty.txt' },
  {
    path: 'img.png',
    content: Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x00, 0x01),
  },
  { path: 'lfs.bin', content: POINTER },
  { path: 'node_modules/m.js', content: 'module.exports = 1\n' },
  { path: 'package-lock.json', content: '{}\n' },
  { path: 'sm', gitlink: true },
  { path: 'src/.env', content: 'KEY=secret\n' },
  { path: 'src/b.ts', content: 'export const b = 2\n' },
  { path: 'src/c.min.js', content: 'minified()\n' },
]

/**
 * A tree of files a path review reads for a credential, in git's order: two `.env` templates, one holding
 * a key and one clean; a bundle with one line of 200 bytes, which the lines' rule calls minified, and the
 * same line holding a key; a binary file that holds a key; a vendored file; a `.env`; plain code; and code
 * that holds a key.
 */
const HOLDING: readonly Spec[] = [
  { path: '.env.example', content: `TOKEN=${fakeCredential('github-token')}\n` },
  { path: '.env.sample', content: 'TOKEN=\n' },
  {
    path: 'dist/app.js',
    content: 'x'.repeat(200),
  },
  {
    path: 'dist/bundle.js',
    content: `${fakeCredential('stripe-key')};`.padEnd(200, 'x'),
  },
  {
    path: 'logo.png',
    content: Uint8Array.of(0, ...encode(fakeCredential('google-key'))),
  },
  { path: 'node_modules/m.js', content: 'module.exports = 1\n' },
  { path: 'src/.env', content: 'KEY=secret\n' },
  { path: 'src/b.ts', content: 'export const b = 2\n' },
  { path: 'src/config.ts', content: `export const id = '${fakeCredential('aws-key')}'\n` },
]

/** What `ls-tree -r -z --long` prints for the entries: a record each, the size right-aligned in 7 columns. */
function listing(entries: readonly Tracked[]): Uint8Array {
  return Buffer.concat(entries.map((entry) => {
    const head = entry.gitlink === true
      ? `160000 commit ${entry.id} ${'-'.padStart(7)}\t`
      : `100644 blob ${entry.id} ${String(entry.listedSize ?? entry.bytes.length).padStart(7)}\t`
    return Buffer.concat([
      Buffer.from(head),
      entry.name,
      Buffer.alloc(1),
    ])
  }))
}

/** What `cat-file --batch` prints for the ids on its stdin: each object's header, its bytes and a line feed. */
function objects(entries: readonly Tracked[], stdin: string): Uint8Array {
  return Buffer.concat(stdin.split('\n').filter(id => id !== '').map((id) => {
    const entry = entries.find(candidate => candidate.id === id)
    return entry === undefined
      ? Buffer.from(`${id} missing\n`)
      : Buffer.concat([
          Buffer.from(`${id} blob ${entry.bytes.length}\n`),
          entry.bytes,
          Buffer.from('\n'),
        ])
  }))
}

/** What the fake git says of the commit: what `rev-parse --verify` answers for a revision, by revision, any other being `COMMIT`. */
type Commits = Readonly<Record<string, GitReply>>

function reply(entries: readonly Tracked[], commits: Commits = {}): (call: GitCall) => GitReply | undefined {
  return ({ command, stdin }) => {
    if (command[0] === 'rev-parse' && command[1] === '--verify') return commits[command[4]] ?? { stdout: `${COMMIT}\n` }
    if (command[0] === 'ls-tree') {
      return {
        stdout: listing(entries),
      }
    }
    if (command[0] === 'cat-file') {
      return {
        stdout: objects(entries, stdin),
      }
    }
    return undefined
  }
}

interface Options {
  readonly base?: GitBase
  readonly commits?: Commits
  readonly exclude?: readonly string[]
  readonly send?: readonly string[]
  readonly idLength?: number
}

function setup(specs: readonly Spec[] = TREE, options: Options = {}): { fake: ReturnType<typeof fakeGit>, context: SourceContext, id: (path: string) => string } {
  const entries = tracked(specs, options.idLength)
  const fake = fakeGit(reply(entries, options.commits), options.base)
  return {
    fake,
    id: (path) => {
      const found = entries.find(entry => entry.path === path)
      if (found === undefined) throw new Error(`no entry ${path}`)
      return found.id
    },
    context: {
      cwd: '/repo',
      env: {},
      platform: 'linux',
      exclude: options.exclude,
      send: options.send,
      git: { executable: '/usr/bin/git', spawn: fake.spawn },
    },
  }
}

/** The `ConfigError` a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<ConfigError> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ConfigError)
  return error as ConfigError
}

/** What a review asked of the commit: the lookups of its revision, its listing and its reads, each as its command. */
function asked(calls: readonly GitCall[]): string[][] {
  return calls
    .map(call => [...call.command])
    .filter(command => command[0] === 'ls-tree' || command[0] === 'cat-file' || (command[0] === 'rev-parse' && command[1] === '--verify'))
}

/** The ids the review's `cat-file` calls were given. */
const readIds = (calls: readonly GitCall[]): string[] => calls.filter(call => call.command[0] === 'cat-file').flatMap(call => call.stdin.split('\n').filter(id => id !== ''))

describe('the path source', () => {
  it('lists the tree once, reads the kept blobs by id through one cat-file, and writes them in git\'s order', async () => {
    const { fake, context, id } = setup()
    const read = await pathsSource(['.'], undefined, true, context)

    expect(asked(fake.calls).filter(command => command[0] !== 'rev-parse')).toEqual([
      [
        'ls-tree',
        '-r',
        '-z',
        '--long',
        '--full-tree',
        COMMIT,
      ],
      ['cat-file', '--batch', '--buffer'],
    ])
    // What a name or a gitlink skips is never read. A binary file and an LFS pointer are known by their bytes, so they are.
    expect(readIds(fake.calls)).toEqual([
      'a.ts',
      'empty.txt',
      'img.png',
      'lfs.bin',
      'src/b.ts',
    ].map(id))
    expect(read.diff).toBe([
      'diff --git a/a.ts b/a.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/a.ts',
      '@@ -0,0 +1 @@',
      '+export const a = 1',
      'diff --git a/empty.txt b/empty.txt',
      'new file mode 100644',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+export const b = 2',
      '',
    ].join('\n'))
  })

  it('names the repository\'s top level in its read, and nowhere in the source it records', async () => {
    const { context } = setup(TREE, {
      base: { top: '/work/the-repository' },
    })
    const read = await pathsSource(['.'], undefined, true, context)

    expect(read.repository).toBe('/work/the-repository')
    expect(JSON.stringify(read.source)).not.toContain('the-repository')
    expect(JSON.stringify(read.leftOut)).not.toContain('the-repository')
    expect(read.diff).not.toContain('the-repository')
  })

  it('lists each skipped file with its rule and each excluded one, in git\'s order, without reading them', async () => {
    const { fake, context, id } = setup(TREE, {
      exclude: ['a.ts'],
    })
    const read = await pathsSource(['.'], undefined, true, context)

    expect(read.leftOut).toEqual([
      { file: 'a.ts', reason: 'excluded' },
      { file: 'img.png', reason: 'skipped', rule: 'binary' },
      { file: 'lfs.bin', reason: 'skipped', rule: 'lfs' },
      { file: 'node_modules/m.js', reason: 'skipped', rule: 'vendored' },
      { file: 'package-lock.json', reason: 'skipped', rule: 'lockfile' },
      { file: 'sm', reason: 'skipped', rule: 'submodule' },
      { file: 'src/.env', reason: 'skipped', rule: 'secret' },
      { file: 'src/c.min.js', reason: 'skipped', rule: 'minified' },
    ])
    const requested = readIds(fake.calls)
    for (const path of [
      'a.ts',
      'node_modules/m.js',
      'package-lock.json',
      'sm',
      'src/.env',
      'src/c.min.js',
    ]) expect(requested).not.toContain(id(path))
    expect(requested).toEqual([
      'empty.txt',
      'img.png',
      'lfs.bin',
      'src/b.ts',
    ].map(id))
  })

  it('lists an excluded secret as excluded and an excluded gitlink as a skip: exclude comes before the name rules, the gitlink before exclude', async () => {
    const { fake, context, id } = setup(TREE, {
      exclude: ['src/.env', 'sm'],
    })
    const read = await pathsSource(['.'], undefined, true, context)

    expect(read.leftOut.filter(entry => entry.file === 'src/.env' || entry.file === 'sm')).toEqual([
      { file: 'sm', reason: 'skipped', rule: 'submodule' },
      { file: 'src/.env', reason: 'excluded' },
    ])
    // The review this feeds flags no secret, and neither file was read.
    expect(secretFlags(read.leftOut)).toEqual([])
    expect(readIds(fake.calls)).not.toContain(id('src/.env'))
    expect(readIds(fake.calls)).not.toContain(id('sm'))
  })

  it('skips a minified file by its lines when the skips are on, and writes it when they are off', async () => {
    const { context } = setup([
      { path: 'a.js', content: 'x\n' },
      {
        path: 'b.css',
        content: 'x'.repeat(111),
      },
      {
        path: 'c.ts',
        content: 'x'.repeat(111),
      },
    ])
    const on = await pathsSource(['.'], undefined, true, context)
    expect(on.leftOut).toEqual([
      { file: 'b.css', reason: 'skipped', rule: 'minified' },
    ])
    expect([
      ...on.diff.matchAll(/^diff --git a\/(\S+) /gm),
    ].map(match => match[1])).toEqual(['a.js', 'c.ts'])

    const off = await pathsSource(['.'], undefined, false, context)
    expect(off.leftOut).toEqual([])
    expect([
      ...off.diff.matchAll(/^diff --git a\/(\S+) /gm),
    ].map(match => match[1])).toEqual(['a.js', 'b.css', 'c.ts'])
  })

  /** The paths a path review wrote, in order. */
  const written = (diff: string): string[] => [
    ...diff.matchAll(/^diff --git a\/(\S+) /gm),
  ].map(match => match[1])

  it('lists the test files of a path review as skipped with the rule test, and reviews them with --no-default-skips', async () => {
    const { context } = setup([
      { path: '__tests__/a.js', content: 'test()\n' },
      { path: 'src/a.test.ts', content: 'export const t = 1\n' },
      { path: 'src/b.ts', content: 'export const b = 2\n' },
      { path: 'src/testing/fake.ts', content: 'export const fake = 3\n' },
      { path: 'test/helper.go', content: 'package test\n' },
    ])
    const on = await pathsSource(['.'], undefined, true, context)
    expect(on.leftOut).toEqual([
      { file: '__tests__/a.js', reason: 'skipped', rule: 'test' },
      { file: 'src/a.test.ts', reason: 'skipped', rule: 'test' },
      { file: 'test/helper.go', reason: 'skipped', rule: 'test' },
    ])
    expect(written(on.diff)).toEqual(['src/b.ts', 'src/testing/fake.ts'])

    const off = await pathsSource(['.'], undefined, false, context)
    expect(off.leftOut).toEqual([])
    expect(written(off.diff)).toEqual([
      '__tests__/a.js',
      'src/a.test.ts',
      'src/b.ts',
      'src/testing/fake.ts',
      'test/helper.go',
    ])
  })

  it('always skips a gitlink, an LFS pointer and a secret, even with the default skips off', async () => {
    const { fake, context, id } = setup()
    const read = await pathsSource(['.'], undefined, false, context)

    expect(read.leftOut).toEqual([
      { file: 'lfs.bin', reason: 'skipped', rule: 'lfs' },
      { file: 'sm', reason: 'skipped', rule: 'submodule' },
      { file: 'src/.env', reason: 'skipped', rule: 'secret' },
    ])
    expect(read.diff).not.toContain('lfs.bin')
    expect(read.diff).not.toContain('diff --git a/sm ')
    expect(read.diff).not.toContain('src/.env')
    expect(readIds(fake.calls)).not.toContain(id('sm'))
    // A secret is skipped by its name, so it is never read.
    expect(readIds(fake.calls)).not.toContain(id('src/.env'))
  })

  it('writes a binary file as git\'s binary line with the default skips off, and still skips the secret', async () => {
    const { context } = setup()
    const read = await pathsSource(['.'], undefined, false, context)

    expect(read.diff).toContain('diff --git a/img.png b/img.png\nnew file mode 100644\nBinary files /dev/null and b/img.png differ\n')
    expect(read.diff).not.toContain('src/.env')
    for (const file of ['node_modules/m.js', 'package-lock.json', 'src/c.min.js']) expect(read.diff).toContain(`diff --git a/${file} b/${file}\n`)
    expect(read.leftOut).toEqual([
      { file: 'lfs.bin', reason: 'skipped', rule: 'lfs' },
      { file: 'sm', reason: 'skipped', rule: 'submodule' },
      { file: 'src/.env', reason: 'skipped', rule: 'secret' },
    ])
  })

  it.each([
    [
      'src',
      '',
      'src',
      ['src/b.ts', 'src/c.min.js'],
    ],
    [
      'src/',
      '',
      'src',
      ['src/b.ts', 'src/c.min.js'],
    ],
    [
      './src',
      '',
      'src',
      ['src/b.ts', 'src/c.min.js'],
    ],
    [
      'b.ts',
      'src/',
      'src/b.ts',
      ['src/b.ts'],
    ],
    [
      '../a.ts',
      'src/',
      'a.ts',
      ['a.ts'],
    ],
    [
      '.',
      'src/',
      'src',
      ['src/b.ts', 'src/c.min.js'],
    ],
  ])('selects %j from the prefix %j as %j', async (value, prefix, selection, files) => {
    const { context } = setup(TREE, {
      base: { prefix },
    })
    const read = await pathsSource([value], undefined, false, context)

    expect(read.source).toMatchObject({
      kind: 'paths',
      paths: [selection],
    })
    expect([
      ...read.diff.matchAll(/^diff --git a\/(\S+) /gm),
    ].map(match => match[1])).toEqual(files)
  })

  it.each([
    [
      '',
      'before git',
      '',
      'must name a path',
      true,
    ],
    [
      '/etc',
      'before git',
      '',
      'must be relative to the working directory',
      true,
    ],
    [
      '../..',
      'leaving the top level',
      'src/',
      'path 1 leaves the repository\'s top level',
      false,
    ],
    [
      'nope',
      'naming no tracked file',
      '',
      'path 1 names no file tracked at the commit',
      false,
    ],
  ])('refuses --path %j %s', async (value, _why, prefix, message, beforeGit) => {
    const { fake, context } = setup(TREE, {
      base: { prefix },
    })
    const error = await refusal(pathsSource([value], undefined, true, context))

    expect(error.message).toBe(`--path: ${message}`)
    expect(error.issues).toEqual([
      { path: '--path', message },
    ])
    expect(value === '' || !error.message.includes(value)).toBe(true)
    if (beforeGit) expect(fake.calls).toEqual([])
    expect(fake.calls.some(call => call.command[0] === 'cat-file')).toBe(false)
  })

  it('refuses no path at all as it refuses an empty one, before any git', async () => {
    const { fake, context } = setup()
    const error = await refusal(pathsSource([], undefined, true, context))
    expect(error.message).toBe('--path: must name a path')
    expect(fake.calls).toEqual([])
  })

  it('names the path it refuses by its place among the ones given, from 1', async () => {
    const { context } = setup()
    expect((await refusal(pathsSource(['a.ts', 'src', 'nope'], undefined, true, context))).message).toBe('--path: path 3 names no file tracked at the commit')
    expect((await refusal(pathsSource(['a.ts', '../x'], undefined, true, context))).message).toBe('--path: path 2 leaves the repository\'s top level')
  })

  it('refuses a selection whose every file is left out, with its counts', async () => {
    const { fake, context } = setup(TREE, {
      exclude: ['src/b.ts'],
    })
    const message = (skipped: number, excluded: number): string => `--path: every selected file is left out (${skipped} skipped, ${excluded} excluded): pass --no-default-skips to review the skipped ones, narrow exclude, or pass --send to send one held as a secret`

    expect((await refusal(pathsSource(['node_modules'], undefined, true, context))).message).toBe(message(1, 0))
    expect((await refusal(pathsSource(['src'], undefined, true, context))).message).toBe(message(2, 1))
    // A name decided each of those, so no blob was read.
    expect(fake.calls.some(call => call.command[0] === 'cat-file')).toBe(false)

    // A binary file is known by its bytes, which are read first.
    expect((await refusal(pathsSource(['img.png'], undefined, true, context))).message).toBe(message(1, 0))
    expect(fake.calls.filter(call => call.command[0] === 'cat-file')).toHaveLength(1)
  })

  it('advises --no-default-skips only when the skips are on to pass it, and --send either way, for a selection whose every file is left out', async () => {
    const { context } = setup(TREE, {
      exclude: ['src/b.ts'],
    })
    // A gitlink and a Git LFS pointer are skipped whatever the flag says, and `exclude` takes the third.
    const paths = ['sm', 'lfs.bin', 'src/b.ts']
    const on = await refusal(pathsSource(paths, undefined, true, context))
    expect(on.message).toBe('--path: every selected file is left out (2 skipped, 1 excluded): pass --no-default-skips to review the skipped ones, narrow exclude, or pass --send to send one held as a secret')

    const off = await refusal(pathsSource(paths, undefined, false, context))
    expect(off.message).toBe('--path: every selected file is left out (2 skipped, 1 excluded): narrow exclude, pass --send to send one held as a secret, or name a path that holds files other than gitlinks, Git LFS pointers and secrets')
    expect(off.issues).toEqual([
      {
        path: '--path',
        message: 'every selected file is left out (2 skipped, 1 excluded): narrow exclude, pass --send to send one held as a secret, or name a path that holds files other than gitlinks, Git LFS pointers and secrets',
      },
    ])
  })

  it('refuses a selection over 16 MiB before any blob is read', async () => {
    const half = MAX_GIT_OUTPUT_BYTES / 2
    const { fake, context } = setup([
      { path: 'a.txt', content: '', listedSize: half },
      { path: 'b.txt', content: '', listedSize: half + 1 },
    ])
    const error = await refusal(pathsSource(['.'], undefined, true, context))

    expect(error.message).toBe(`--path: the selected files hold ${MAX_GIT_OUTPUT_BYTES + 1} bytes, over the 16 MiB (16777216 bytes) a review reads: name a narrower path`)
    expect(error.issues.map(issue => issue.path)).toEqual(['--path'])
    expect(fake.calls.some(call => call.command[0] === 'cat-file')).toBe(false)

    // Only what is read counts: a file a name skips is not sized.
    const skipped = setup([
      { path: 'big.min.js', content: '', listedSize: MAX_GIT_OUTPUT_BYTES * 2 },
      { path: 'b.ts', content: 'ok\n' },
    ])
    const read = await pathsSource(['.'], undefined, true, skipped.context)
    expect(read.leftOut).toEqual([
      { file: 'big.min.js', reason: 'skipped', rule: 'minified' },
    ])
    expect(read.diff).toContain('diff --git a/b.ts b/b.ts\n')
  })

  it('refuses a diff over 16 MiB, as it refuses the files that hold so many bytes', async () => {
    // The files fit the cap, and the plus signs and hunk headers the writer adds do not.
    const lines = `${'x'.repeat(99)}\n`.repeat(Math.floor((MAX_GIT_OUTPUT_BYTES - 1024) / 100))
    const { context } = setup([
      { path: 'a.txt', content: lines },
    ])
    const error = await refusal(pathsSource(['.'], undefined, true, context))
    expect(error.message).toBe('--path: its diff is over 16 MiB, the most quorum reads: name a narrower path')
  })

  it('resolves --at, and refuses HEAD when nothing is committed', async () => {
    const other = 'd'.repeat(40)
    const { fake, context } = setup(TREE, {
      commits: {
        'main^{commit}': { stdout: `${other}\n` },
        'HEAD^{commit}': { code: 1 },
      },
    })
    const read = await pathsSource(['a.ts'], 'main', true, context)
    expect(read.source).toMatchObject({ kind: 'paths', commit: other })
    expect(asked(fake.calls).slice(0, 2)).toEqual([
      [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        'main^{commit}',
      ],
      [
        'ls-tree',
        '-r',
        '-z',
        '--long',
        '--full-tree',
        other,
      ],
    ])

    const unborn = await refusal(pathsSource(['a.ts'], undefined, true, context))
    expect(unborn.message).toBe(`--path: ${NO_COMMIT}`)
    expect(unborn.issues).toEqual([
      { path: '--path', message: NO_COMMIT },
    ])
    expect(asked(fake.calls).at(-1)).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'HEAD^{commit}',
    ])

    // A revision that names nothing is the commit's refusal, which never repeats it.
    const missing = setup(TREE, {
      commits: {
        'gone^{commit}': { code: 1 },
      },
    })
    const gone = await refusal(pathsSource(['a.ts'], 'gone', true, missing.context))
    expect(gone.message).toBe('--at: names no commit of this repository')
    expect(gone.issues).toEqual([
      { path: '--at', message: 'names no commit of this repository' },
    ])

    // A revision that starts with - is no revision: the repository is not even opened, so git is never run, let alone asked to resolve it.
    const option = setup()
    const refused = await refusal(pathsSource(['a.ts'], '--output=x', true, option.context))
    expect(refused.message).toBe('--at: a revision may not start with -')
    expect(refused.issues).toEqual([
      { path: '--at', message: 'a revision may not start with -' },
    ])
    expect(option.fake.calls).toEqual([])
  })

  it('records the commit, the normalized paths, the skips and the object format in meta.source', async () => {
    const sha256 = 'e'.repeat(64)
    const { context } = setup(TREE, {
      base: { objectFormat: 'sha256' },
      idLength: 64,
      commits: {
        'HEAD^{commit}': { stdout: `${sha256}\n` },
      },
    })
    const read = await pathsSource(['src', './src/', 'a.ts', 'src/../a.ts'], undefined, false, context)

    expect(read.source).toEqual({
      kind: 'paths',
      commit: sha256,
      paths: ['src', 'a.ts'],
      skips: false,
      objectFormat: 'sha256',
    })
  })

  it('matches a selection against each name as the diff reads it back', async () => {
    const accent = String.fromCharCode(0xE9)
    const backslash = String.fromCharCode(0x5C)
    const { context } = setup([
      {
        path: Buffer.concat([
          encode('caf'),
          Uint8Array.of(0xC3, 0xA9),
          encode('/x.txt'),
        ]),
        content: 'one\n',
      },
      // The same characters as a backslash and digits: git writes a backslash as two, so no octal byte is in it.
      {
        path: encode(`caf${backslash}303${backslash}251/y.txt`),
        content: 'two\n',
      },
      {
        path: encode('tab\tname.txt'),
        content: 'three\n',
      },
      {
        path: Buffer.concat([
          encode('vendor/caf'),
          Uint8Array.of(0xC3, 0xA9),
          encode('.go'),
        ]),
        content: 'four\n',
      },
    ])
    const read = await pathsSource([`caf${accent}`, 'tab\tname.txt', 'vendor'], undefined, true, context)

    expect(read.diff).toContain('diff --git "a/caf\\303\\251/x.txt" "b/caf\\303\\251/x.txt"\n')
    expect(read.diff).toContain('diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"\n')
    expect(read.diff).not.toContain('y.txt')
    expect(read.source).toMatchObject({
      paths: [`caf${accent}`, 'tab\tname.txt', 'vendor'],
    })
    // A left-out file is named as the diff would name it, decoded.
    expect(read.leftOut).toEqual([
      { file: `vendor/caf${accent}.go`, reason: 'skipped', rule: 'vendored' },
    ])
  })

  it('skips a file whose text holds a credential as secret, after a binary file and before a minified one', async () => {
    const { context } = setup(HOLDING)
    const read = await pathsSource(['.'], undefined, true, context)

    // A bundle that holds no key is the minified one, so the key is what made the other a secret.
    expect(read.leftOut).toEqual([
      { file: '.env.example', reason: 'skipped', rule: 'secret' },
      { file: 'dist/app.js', reason: 'skipped', rule: 'minified' },
      { file: 'dist/bundle.js', reason: 'skipped', rule: 'secret' },
      { file: 'logo.png', reason: 'skipped', rule: 'binary' },
      { file: 'node_modules/m.js', reason: 'skipped', rule: 'vendored' },
      { file: 'src/.env', reason: 'skipped', rule: 'secret' },
      { file: 'src/config.ts', reason: 'skipped', rule: 'secret' },
    ])
    expect(written(read.diff)).toEqual(['.env.sample', 'src/b.ts'])
    expect(read.diff).not.toContain(fakeCredential('stripe-key'))
    expect(reviewScope(read.diff).leftOut).toEqual([])
  })

  it('writes a clean template, and skips one holding a credential', async () => {
    const { context } = setup(HOLDING)
    const read = await pathsSource(['.'], undefined, true, context)

    expect(read.diff).toContain('diff --git a/.env.sample b/.env.sample\nnew file mode 100644\n--- /dev/null\n+++ b/.env.sample\n@@ -0,0 +1 @@\n+TOKEN=\n')
    expect(read.diff).not.toContain('.env.example')
    expect(read.leftOut).toContainEqual({ file: '.env.example', reason: 'skipped', rule: 'secret' })
    expect(read.leftOut.map(entry => entry.file)).not.toContain('.env.sample')
    // A template skipped for its content is no secret by name, so its flag says it holds a credential.
    expect(secretFlags(read.leftOut).find(flag => flag.file === '.env.example')?.detail).toBe('holds what reads as a credential, so a path review sent none of it: remove it from the repository, and rotate it if it is real')
  })

  it('reads a file the operator sends, by its name and by its content', async () => {
    const send = ['src/.env', 'src/config.ts']
    const { fake, context, id } = setup(HOLDING, { send })
    const read = await pathsSource(['.'], undefined, true, context)

    expect(written(read.diff)).toEqual([
      '.env.sample',
      'src/.env',
      'src/b.ts',
      'src/config.ts',
    ])
    expect(read.diff).toContain(fakeCredential('aws-key'))
    expect(readIds(fake.calls)).toEqual(expect.arrayContaining(send.map(id)))
    // The rest is held as before, and nothing sent is listed or flagged.
    expect(read.leftOut).toEqual([
      { file: '.env.example', reason: 'skipped', rule: 'secret' },
      { file: 'dist/app.js', reason: 'skipped', rule: 'minified' },
      { file: 'dist/bundle.js', reason: 'skipped', rule: 'secret' },
      { file: 'logo.png', reason: 'skipped', rule: 'binary' },
      { file: 'node_modules/m.js', reason: 'skipped', rule: 'vendored' },
    ])
    expect(secretFlags(read.leftOut).map(flag => flag.file)).toEqual(['.env.example', 'dist/bundle.js'])
    // The core holds them unless the review sends them too, as the CLI does with the same list.
    expect(reviewScope(read.diff).leftOut.map(entry => entry.file)).toEqual(send)
    expect(reviewScope(read.diff, undefined, path => send.includes(path)).leftOut).toEqual([])
  })

  it('skips a secret by its name and its content with the default skips off too', async () => {
    const { context } = setup(HOLDING)
    const read = await pathsSource(['.'], undefined, false, context)

    // A secret stays skipped: only the vendored, lockfile, minified, test and binary rules are off. A binary file that holds a key is one, since no model reads it either way.
    expect(read.leftOut).toEqual([
      { file: '.env.example', reason: 'skipped', rule: 'secret' },
      { file: 'dist/bundle.js', reason: 'skipped', rule: 'secret' },
      { file: 'logo.png', reason: 'skipped', rule: 'secret' },
      { file: 'src/.env', reason: 'skipped', rule: 'secret' },
      { file: 'src/config.ts', reason: 'skipped', rule: 'secret' },
    ])
    expect(written(read.diff)).toEqual([
      '.env.sample',
      'dist/app.js',
      'node_modules/m.js',
      'src/b.ts',
    ])
    expect(read.diff).not.toContain(fakeCredential('aws-key'))
    // The core finds nothing left to hold, so the review this feeds has no gap.
    expect(reviewScope(read.diff).leftOut).toEqual([])
  })

  it('reads no attribute as a skip: a .gitattributes marking files vendored, generated or -diff changes nothing', async () => {
    const { fake, context, id } = setup([
      { path: '.gitattributes', content: 'a.ts linguist-vendored\nsrc/b.ts linguist-generated\nsrc/b.ts -diff\n' },
      { path: 'a.ts', content: 'export const a = 1\n' },
      { path: 'src/b.ts', content: 'export const b = 2\n' },
    ])
    const read = await pathsSource(['.'], undefined, true, context)

    expect(read.leftOut).toEqual([])
    expect(read.diff).toContain('+++ b/a.ts\n@@ -0,0 +1 @@\n+export const a = 1\n')
    expect(read.diff).toContain('+++ b/src/b.ts\n@@ -0,0 +1 @@\n+export const b = 2\n')
    expect(read.diff).not.toContain('Binary files')
    // The file is data like any other: written, never read for what it says.
    expect(read.diff).toContain('+++ b/.gitattributes\n@@ -0,0 +1,3 @@\n+a.ts linguist-vendored\n')
    expect(readIds(fake.calls)).toEqual(['.gitattributes', 'a.ts', 'src/b.ts'].map(id))
    expect(fake.calls.map(call => call.command[0])).not.toContain('check-attr')
    expect(fake.calls.every(call => !call.args.some(arg => arg.startsWith('--attr-source')))).toBe(true)
  })
})
