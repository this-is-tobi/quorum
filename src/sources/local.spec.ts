import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBounded } from '../config/load.ts'
import { reviewScope } from '../core/coverage.ts'
import { ConfigError } from '../core/errors.ts'
import { DIFF_PINS, MAX_GIT_OUTPUT_BYTES } from '../git/run.ts'
import type { FilterKey } from '../git/run.ts'
import { fakeGit } from '../testing/git.ts'
import type { GitCall, GitReply } from '../testing/git.ts'
import { localSource, samePath, trustsConfig } from './local.ts'
import type { SourceContext } from './read.ts'

/** `readBounded` as a spy that calls through, so a test can read the limit each untracked file is read with. */
vi.mock('../config/load.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.ts')>()
  return {
    ...actual,
    readBounded: vi.fn(actual.readBounded),
  }
})

const HEAD = 'a'.repeat(40)
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const DIFF = 'diff --git a/a.js b/a.js\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'
const FILTER_TEXT = 'the repository\'s own config names a filter program, which a working-tree diff runs: pass --trust-repo-config if the repository is yours, or review a range'
const OVER_TEXT = 'its diff is over 16 MiB, the most quorum reads: review fewer changes at once'
const FILTERED: GitReply = { stdout: 'local\0filter.evil.clean\n/bin/evil\0' }
const FILTER_VECTOR = [
  'config',
  '--show-scope',
  '-z',
  '--get-regexp',
  '^filter\\..+\\.(clean|smudge|process)$',
]
const UNTRACKED_VECTOR = [
  'ls-files',
  '-z',
  '--others',
  '--exclude-standard',
]

/** The untracked listing git prints for `names`: each name ended by a NUL. */
const listing = (...names: string[]): string => names.map(name => `${name}\0`).join('')

/** What the fake git says of the repository's local changes, any of them replaced. */
interface Replies {
  readonly config?: GitReply
  readonly head?: GitReply
  readonly diff?: GitReply
  readonly untracked?: GitReply
}

function reply(replies: Replies = {}): (call: GitCall) => GitReply | undefined {
  return ({ command }) => {
    if (command[0] === 'config') return replies.config ?? { code: 1 }
    if (command[0] === 'rev-parse' && command[1] === '--verify') return replies.head ?? { stdout: `${HEAD}\n` }
    if (command[0] === 'hash-object') return { stdout: `${EMPTY_TREE}\n` }
    if (command[1] === 'diff') return replies.diff ?? { stdout: DIFF }
    if (command[0] === 'ls-files') return replies.untracked ?? { stdout: '' }
    return undefined
  }
}

/** The vector of a diff of the working tree (`staged` false) or of the index, against the commit `from`. */
function diffVector(from: string, staged: boolean): string[] {
  return [
    `--attr-source=${from}`,
    'diff',
    ...DIFF_PINS,
    '--ignore-submodules=dirty',
    ...staged
      ? ['--cached']
      : [],
    from,
    '--',
  ]
}

/** The `ConfigError` a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<ConfigError> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ConfigError)
  return error as ConfigError
}

/** The untracked files of these tests are written under a directory of their own, which the fake's top level names. */
let top = ''
beforeEach(() => {
  top = mkdtempSync(join(tmpdir(), 'quorum-local-'))
  vi.mocked(readBounded).mockClear()
})
afterEach(() => {
  rmSync(top, { recursive: true, force: true })
})

function setup(replies: Replies = {}): { fake: ReturnType<typeof fakeGit>, context: SourceContext } {
  const fake = fakeGit(reply(replies), { top })
  return {
    fake,
    context: {
      cwd: top,
      env: {},
      platform: 'linux',
      git: { executable: '/usr/bin/git', spawn: fake.spawn },
    },
  }
}

describe('trustsConfig', () => {
  it.each([
    [[], 'none named, so trusted', true],
    [
      [
        { scope: 'global', key: 'filter.lfs.clean' },
        { scope: 'system', key: 'filter.lfs.process' },
      ],
      'the user\'s and the system\'s, which run as with their own git, so trusted',
      true,
    ],
    [
      [
        { scope: 'local', key: 'filter.evil.clean' },
      ],
      'the repository\'s config, so refused',
      false,
    ],
    [
      [
        { scope: 'worktree', key: 'filter.evil.smudge' },
      ],
      'the work tree\'s config, so refused',
      false,
    ],
    [
      [
        { scope: 'command', key: 'filter.evil.process' },
      ],
      'a config the command line or the environment gave, so refused',
      false,
    ],
    [
      [
        { scope: 'a-scope-git-adds-later', key: 'filter.evil.clean' },
      ],
      'a scope quorum does not know, so refused',
      false,
    ],
    [
      [
        { scope: 'global', key: 'filter.lfs.clean' },
        { scope: 'local', key: 'filter.lfs.process' },
      ],
      'a local key with no value beside a global one: a record holds none, and the key alone refuses',
      false,
    ],
  ] satisfies Array<[FilterKey[], string, boolean]>)('trusts the filter keys %j: %s', (keys, _why, trusted) => {
    expect(trustsConfig(keys)).toBe(trusted)
  })
})

describe('samePath', () => {
  it('reads two spellings of one name as one path, and two paths as two', () => {
    const nfc = `caf${String.fromCharCode(0xE9)}`
    const nfd = `cafe${String.fromCharCode(0x301)}`
    expect(nfc).not.toBe(nfd)
    expect(samePath(`/top/${nfd}/a`, `/top/${nfc}/a`)).toBe(true)
    expect(samePath(`/top/${nfc}`, `/top/${nfc}`)).toBe(true)
    expect(samePath(`/top/${nfc}`, '/top/cafe')).toBe(false)
    expect(samePath(`/top/${nfc}`, `/elsewhere/${nfc}`)).toBe(false)
  })
})

describe('the local sources', () => {
  it('refuses --local and --staged when the repository\'s own config names a filter, before any diff', async () => {
    for (const kind of ['local', 'staged'] as const) {
      const { fake, context } = setup({ config: FILTERED })
      const error = await refusal(localSource(kind, false, context))
      expect(error.message).toBe(`--${kind}: ${FILTER_TEXT}`)
      expect(error.issues).toEqual([
        { path: `--${kind}`, message: FILTER_TEXT },
      ])
      expect(fake.calls.map(call => call.command)).toContainEqual(FILTER_VECTOR)
      expect(fake.calls.filter(call => call.command.includes('diff') || call.command[0] === 'ls-files')).toEqual([])
    }
  })

  it('lifts the refusal with --trust-repo-config', async () => {
    for (const kind of ['local', 'staged'] as const) {
      const { fake, context } = setup({ config: FILTERED })
      const read = await localSource(kind, true, context)
      expect(read.diff).toBe(DIFF)
      expect(read.source).toEqual({ kind, head: HEAD, objectFormat: 'sha1' })
      expect(fake.calls.map(call => call.command)).toContainEqual(diffVector(HEAD, kind === 'staged'))
    }
  })

  it('reviews --staged as diff --cached against HEAD, attributes from HEAD', async () => {
    const { fake, context } = setup()
    const read = await localSource('staged', false, context)

    const commands = fake.calls.map(call => call.command)
    expect(commands).toContainEqual(FILTER_VECTOR)
    expect(commands).toContainEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'HEAD^{commit}',
    ])
    expect(commands.at(-1)).toEqual(diffVector(HEAD, true))
    expect(commands.filter(command => command[0] === 'ls-files')).toEqual([])
    expect(new Set(fake.calls.map(call => call.file))).toEqual(new Set(['/usr/bin/git']))
    expect(read).toEqual({
      diff: DIFF,
      source: { kind: 'staged', head: HEAD, objectFormat: 'sha1' },
      leftOut: [],
    })
  })

  it('reviews --local as diff against HEAD and the untracked files written after it', async () => {
    writeFileSync(join(top, 'new.txt'), 'one\ntwo\n')
    mkdirSync(join(top, 'sub'))
    writeFileSync(join(top, 'sub', 'b.txt'), 'b')
    const { fake, context } = setup({
      untracked: {
        stdout: listing('new.txt', 'sub/b.txt'),
      },
    })
    const read = await localSource('local', false, context)

    const commands = fake.calls.map(call => call.command)
    expect(commands.at(-2)).toEqual(diffVector(HEAD, false))
    expect(commands.at(-1)).toEqual(UNTRACKED_VECTOR)
    expect(read).toEqual({
      diff: `${DIFF}diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\ndiff --git a/sub/b.txt b/sub/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/sub/b.txt\n@@ -0,0 +1 @@\n+b\n\\ No newline at end of file\n`,
      source: { kind: 'local', head: HEAD, objectFormat: 'sha1' },
      leftOut: [],
    })
  })

  it('diffs against the empty tree on an unborn branch, and records head as null', async () => {
    for (const kind of ['local', 'staged'] as const) {
      const { fake, context } = setup({
        head: { code: 1 },
      })
      const read = await localSource(kind, false, context)

      const commands = fake.calls.map(call => call.command)
      expect(commands).toContainEqual(['hash-object', '-t', 'tree', '--stdin'])
      expect(commands).toContainEqual(diffVector(EMPTY_TREE, kind === 'staged'))
      expect(read.source).toEqual({ kind, head: null, objectFormat: 'sha1' })
    }
  })

  it('writes an untracked executable as 100755, a link as 120000 and its target, never reading what it names', async () => {
    writeFileSync(join(top, 'run.sh'), '#!/bin/sh\n')
    chmodSync(join(top, 'run.sh'), 0o755)
    writeFileSync(join(top, 'plain.txt'), 'plain\n')
    symlinkSync('/etc/passwd', join(top, 'ln'))
    const { context } = setup({
      diff: { stdout: '' },
      untracked: {
        stdout: listing('ln', 'plain.txt', 'run.sh'),
      },
    })
    const read = await localSource('local', false, context)

    expect(read.diff).toBe([
      'diff --git a/ln b/ln\nnew file mode 120000\n--- /dev/null\n+++ b/ln\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n',
      'diff --git a/plain.txt b/plain.txt\nnew file mode 100644\n--- /dev/null\n+++ b/plain.txt\n@@ -0,0 +1 @@\n+plain\n',
      'diff --git a/run.sh b/run.sh\nnew file mode 100755\n--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1 @@\n+#!/bin/sh\n',
    ].join(''))
    expect(read.diff).not.toContain('root:')
    expect(read.leftOut).toEqual([])
  })

  it('writes an untracked nested repository as a gitlink, which the review lists as a submodule', async () => {
    // The directory does not exist: a gitlink is written from its name alone, and nothing under it is touched.
    const { context } = setup({
      diff: { stdout: '' },
      untracked: {
        stdout: listing('nested/'),
      },
    })
    const read = await localSource('local', false, context)

    expect(read.diff).toBe('diff --git a/nested b/nested\nnew file mode 160000\n')
    expect(read.leftOut).toEqual([])
    expect(reviewScope(read.diff).leftOut).toEqual([
      { file: 'nested', reason: 'submodule' },
    ])
  })

  it('lists an excluded untracked file as excluded, and never reads it', async () => {
    writeFileSync(join(top, 'secret.key'), 'key material\n')
    chmodSync(join(top, 'secret.key'), 0o000)
    writeFileSync(join(top, 'keep.txt'), 'kept\n')
    const { context } = setup({
      diff: { stdout: '' },
      untracked: {
        stdout: listing('secret.key', 'keep.txt'),
      },
    })
    const read = await localSource('local', false, {
      ...context,
      exclude: ['*.key'],
    })

    expect(read.diff).toBe('diff --git a/keep.txt b/keep.txt\nnew file mode 100644\n--- /dev/null\n+++ b/keep.txt\n@@ -0,0 +1 @@\n+kept\n')
    expect(read.leftOut).toEqual([
      { file: 'secret.key', reason: 'excluded' },
    ])
  })

  it.each([
    [
      'name that is not UTF-8',
      () => [
        Buffer.from([0x61, 0xFF, 0x00]),
      ],
      '--local: an untracked file\'s name is not UTF-8, which quorum cannot open: rename it, or name it in .gitignore',
    ],
    [
      'FIFO the listing names',
      () => {
        execFileSync('mkfifo', [
          join(top, 'pipe'),
        ])
        return [
          Buffer.from(listing('pipe')),
        ]
      },
      '--local: the untracked "pipe" is neither a regular file nor a link: remove it, or name it in .gitignore',
    ],
    [
      'file under a link, its parent a link to a directory',
      () => {
        mkdirSync(join(top, 'elsewhere'))
        writeFileSync(join(top, 'elsewhere', 'file.txt'), 'outside\n')
        symlinkSync('elsewhere', join(top, 'linked'))
        return [
          Buffer.from(listing('linked/file.txt')),
        ]
      },
      '--local: the untracked "linked/file.txt" lies under a symbolic link',
    ],
    [
      'name with a .. segment, or an absolute one',
      () => [
        Buffer.from(listing('../outside.txt')),
        Buffer.from(listing('a/../../outside.txt')),
        Buffer.from(listing('/etc/passwd')),
      ],
      '--local: an untracked file\'s name leaves the top level',
    ],
  ] satisfies Array<[string, () => Buffer[], string]>)('refuses an untracked %s', async (_name, prepare, message) => {
    for (const names of prepare()) {
      const { context } = setup({
        diff: { stdout: '' },
        untracked: { stdout: names },
      })
      const error = await refusal(localSource('local', false, context))
      expect(error.message).toBe(message)
      expect(error.issues).toEqual([
        {
          path: '--local',
          message: message.slice('--local: '.length),
        },
      ])
    }
  })

  it('reads each untracked file with its listed size as the limit, so a buffer is the file\'s own size', async () => {
    writeFileSync(join(top, 'ten'), '0123456789')
    writeFileSync(join(top, 'three'), 'abc')
    writeFileSync(join(top, 'empty'), '')
    symlinkSync('ten', join(top, 'ln'))
    const { context } = setup({
      diff: { stdout: '' },
      untracked: {
        stdout: listing('ten', 'three', 'empty', 'ln'),
      },
    })
    await localSource('local', false, context)

    // The link is read by `readlink`, never by `readBounded`.
    expect(vi.mocked(readBounded).mock.calls.map(([path, limit, , options]) => [path, limit, options])).toEqual([
      [
        join(top, 'ten'),
        10,
        { noFollow: true },
      ],
      [
        join(top, 'three'),
        3,
        { noFollow: true },
      ],
      [
        join(top, 'empty'),
        0,
        { noFollow: true },
      ],
    ])
  })

  it('refuses a name that is gone, or a file that outgrew its listed size, as changed while it was read', async () => {
    const changed = (name: string): string => `--local: the untracked ${JSON.stringify(name)} changed while quorum read it: run quorum again`
    mkdirSync(join(top, 'dir'))
    writeFileSync(join(top, 'dir', 'file.txt'), 'abc')
    writeFileSync(join(top, 'grown'), 'abc')
    for (const [names, message] of [
      [
        ['gone.txt'],
        changed('gone.txt'),
      ],
      [
        ['no-dir/inner.txt'],
        changed('no-dir/inner.txt'),
      ],
      [
        ['dir/file.txt/under'],
        changed('dir/file.txt/under'),
      ],
    ] as const) {
      const { context } = setup({
        diff: { stdout: '' },
        untracked: {
          stdout: listing(...names),
        },
      })
      const error = await refusal(localSource('local', false, context))
      expect(error.message).toBe(message)
      expect(error.issues).toEqual([
        {
          path: '--local',
          message: message.slice('--local: '.length),
        },
      ])
    }

    // A file the read finds larger than the size `lstat` gave, or gone, or a link by then.
    for (const problem of [
      { problem: 'is over 16 MiB', counted: 3 },
      { problem: 'does not exist' },
      { problem: 'is a symbolic link' },
    ]) {
      vi.mocked(readBounded).mockResolvedValueOnce(problem)
      const { context } = setup({
        diff: { stdout: '' },
        untracked: {
          stdout: listing('grown'),
        },
      })
      expect((await refusal(localSource('local', false, context))).message).toBe(changed('grown'))
    }
    // A file the read cannot open is not a changed one.
    vi.mocked(readBounded).mockResolvedValueOnce({ problem: 'is not a file' })
    const { context } = setup({
      diff: { stdout: '' },
      untracked: {
        stdout: listing('grown'),
      },
    })
    expect((await refusal(localSource('local', false, context))).message).toBe('--local: the untracked "grown" is neither a regular file nor a link: remove it, or name it in .gitignore')
  })

  // The superuser reads a file of mode 000, and walks a directory of it.
  it.skipIf(process.getuid?.() === 0)('refuses an untracked file it has no permission to read, in its own words', async () => {
    const unreadable = (name: string): string => `--local: the untracked ${JSON.stringify(name)} cannot be read: check its permissions, or name it in .gitignore`
    writeFileSync(join(top, 'locked.txt'), 'abc')
    chmodSync(join(top, 'locked.txt'), 0o000)
    mkdirSync(join(top, 'sealed'))
    writeFileSync(join(top, 'sealed', 'inner.txt'), 'abc')
    chmodSync(join(top, 'sealed'), 0o000)
    try {
      // The file's own mode, caught by the read, and a directory's, caught by the `lstat` that sizes the file.
      for (const name of ['locked.txt', 'sealed/inner.txt']) {
        const { context } = setup({
          diff: { stdout: '' },
          untracked: {
            stdout: listing(name),
          },
        })
        const error = await refusal(localSource('local', false, context))
        expect(error.message).toBe(unreadable(name))
        expect(error.issues).toEqual([
          {
            path: '--local',
            message: unreadable(name).slice('--local: '.length),
          },
        ])
      }
    } finally {
      chmodSync(join(top, 'sealed'), 0o700)
    }
  })

  it('keeps a file of another kind that a read cannot open as neither a regular file nor a link', async () => {
    writeFileSync(join(top, 'swapped'), 'abc')
    // The read fails as an open of a socket does, after the file was swapped for a FIFO since the listing.
    vi.mocked(readBounded).mockImplementationOnce(async () => {
      rmSync(join(top, 'swapped'))
      execFileSync('mkfifo', [
        join(top, 'swapped'),
      ])
      return { problem: 'cannot be read' }
    })
    const { context } = setup({
      diff: { stdout: '' },
      untracked: {
        stdout: listing('swapped'),
      },
    })
    expect((await refusal(localSource('local', false, context))).message).toBe('--local: the untracked "swapped" is neither a regular file nor a link: remove it, or name it in .gitignore')
  })

  it('refuses local changes over 16 MiB, the untracked files\' sizes counted before they are read', async () => {
    const refuses = async (replies: Replies): Promise<void> => {
      const error = await refusal(localSource('local', false, setup(replies).context))
      expect(error.message).toBe(`--local: ${OVER_TEXT}`)
    }
    // Two files that fit apart, which no read could take: unreadable, so a read would say so instead.
    for (const name of ['big-1', 'big-2']) {
      writeFileSync(join(top, name), '')
      truncateSync(join(top, name), 9 * 1024 * 1024)
      chmodSync(join(top, name), 0o000)
    }
    await refuses({
      untracked: {
        stdout: listing('big-1', 'big-2'),
      },
    })

    // Git's own diff counts beside them: one byte over.
    writeFileSync(join(top, 'small'), 'abcdef')
    await refuses({
      diff: {
        stdout: new Uint8Array(MAX_GIT_OUTPUT_BYTES - 5),
      },
      untracked: {
        stdout: listing('small'),
      },
    })

    // The sizes fit, and what is written does not: each line of the file costs a `+` and its line feed.
    writeFileSync(join(top, 'rows'), '\n'.repeat(3000))
    await refuses({
      diff: {
        stdout: new Uint8Array(MAX_GIT_OUTPUT_BYTES - 3010),
      },
      untracked: {
        stdout: listing('rows'),
      },
    })

    // The listing itself over its cap is the same refusal.
    await refuses({
      untracked: {
        stdout: new Uint8Array(MAX_GIT_OUTPUT_BYTES + 1),
      },
    })
  })

  it('reviews no change as an empty diff', async () => {
    const { context } = setup({
      diff: { stdout: '' },
    })
    await expect(localSource('local', false, context)).resolves.toEqual({
      diff: '',
      source: { kind: 'local', head: HEAD, objectFormat: 'sha1' },
      leftOut: [],
    })
  })
})
