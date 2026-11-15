import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { MAX_DIFF_BYTES } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import { fakeClock, settle } from '../testing/clock.ts'
import { fakeGit } from '../testing/git.ts'
import type { GitBase, GitCall, GitReply } from '../testing/git.ts'
import {
  DIFF_PINS,
  ENVIRONMENT_ALLOWLIST,
  GIT_FLOOR,
  GIT_TIMEOUT_MS,
  gitArgs,
  gitEnvironment,
  GitError,
  GLOBAL_PINS,
  MAX_GIT_OUTPUT_BYTES,
  MAX_GIT_SMALL_OUTPUT_BYTES,
  MAX_GIT_STDERR_BYTES,
  openRepository,
  runGit,
  STDERR_EXCERPT,
} from './run.ts'
import type { GitContext, GitOperation, Repository, SpawnGit } from './run.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const TOP = '/repo'

const PINS = [
  '--no-pager',
  '--no-optional-locks',
  '--no-replace-objects',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.pager=cat',
  '-c',
  'core.quotePath=true',
  '-c',
  'core.bigFileThreshold=512m',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'diff.autoRefreshIndex=false',
]

const DIFF = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=3',
  '--inter-hunk-context=0',
  '--diff-algorithm=myers',
  '--indent-heuristic',
  '--full-index',
  '--no-renames',
  '--no-relative',
  '--submodule=short',
  '-O/dev/null',
]

const ALLOWED = [
  'PATH',
  'HOME',
  'XDG_CONFIG_HOME',
  'TMPDIR',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
]

const SET_BY_QUORUM = {
  LC_ALL: 'C',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
}

const ROWS: Array<[string, GitOperation, string[]]> = [
  [
    'version',
    { op: 'version' },
    ['--version'],
  ],
  [
    'toplevel',
    { op: 'toplevel' },
    ['rev-parse', '--show-toplevel'],
  ],
  [
    'prefix',
    { op: 'prefix' },
    ['rev-parse', '--show-prefix'],
  ],
  [
    'git-dir',
    { op: 'git-dir' },
    ['rev-parse', '--absolute-git-dir'],
  ],
  [
    'top-git-dir',
    { op: 'top-git-dir', top: TOP },
    [
      '-C',
      TOP,
      'rev-parse',
      '--absolute-git-dir',
    ],
  ],
  [
    'object-format',
    { op: 'object-format', top: TOP },
    [
      '-C',
      TOP,
      'rev-parse',
      '--show-object-format',
    ],
  ],
  [
    'resolve',
    { op: 'resolve', top: TOP, revision: 'main' },
    [
      '-C',
      TOP,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'main^{commit}',
    ],
  ],
  [
    'merge-base',
    {
      op: 'merge-base',
      top: TOP,
      first: A,
      second: B,
    },
    ['-C', TOP, 'merge-base', A, B],
  ],
  [
    'empty-tree',
    { op: 'empty-tree', top: TOP },
    [
      '-C',
      TOP,
      'hash-object',
      '-t',
      'tree',
      '--stdin',
    ],
  ],
  [
    'diff-commits',
    {
      op: 'diff-commits',
      top: TOP,
      from: A,
      to: B,
      attributes: A,
    },
    [
      '-C',
      TOP,
      `--attr-source=${A}`,
      'diff',
      ...DIFF,
      '--ignore-submodules=none',
      A,
      B,
      '--',
    ],
  ],
  [
    'diff-index',
    {
      op: 'diff-index',
      top: TOP,
      from: A,
      attributes: B,
    },
    [
      '-C',
      TOP,
      `--attr-source=${B}`,
      'diff',
      ...DIFF,
      '--ignore-submodules=dirty',
      '--cached',
      A,
      '--',
    ],
  ],
  [
    'diff-worktree',
    {
      op: 'diff-worktree',
      top: TOP,
      from: A,
      attributes: B,
    },
    [
      '-C',
      TOP,
      `--attr-source=${B}`,
      'diff',
      ...DIFF,
      '--ignore-submodules=dirty',
      A,
      '--',
    ],
  ],
  [
    'filter-config',
    { op: 'filter-config', top: TOP },
    [
      '-C',
      TOP,
      'config',
      '--show-scope',
      '-z',
      '--get-regexp',
      '^filter\\..+\\.(clean|smudge|process)$',
    ],
  ],
  [
    'untracked',
    { op: 'untracked', top: TOP },
    [
      '-C',
      TOP,
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
    ],
  ],
  [
    'list-tree',
    { op: 'list-tree', top: TOP, commit: A },
    [
      '-C',
      TOP,
      'ls-tree',
      '-r',
      '-z',
      '--long',
      '--full-tree',
      A,
    ],
  ],
  [
    'read-objects',
    { op: 'read-objects', top: TOP },
    [
      '-C',
      TOP,
      'cat-file',
      '--batch',
      '--buffer',
    ],
  ],
]

/** A context whose git is the fake `spawn`, in a working directory of its own. */
function contextOf(spawn: SpawnGit, extra: Partial<GitContext> = {}): GitContext {
  return {
    git: '/usr/bin/git',
    cwd: '/work/sub',
    env: { PATH: '/bin' },
    flag: '--range',
    spawn,
    ...extra,
  }
}

/** The fake `spawn`, with each child it started kept for the spec to look at. */
function watched(fake: ReturnType<typeof fakeGit>): { spawn: SpawnGit, children: ChildProcess[] } {
  const children: ChildProcess[] = []
  const spawn: SpawnGit = (file, args, options) => {
    const child = fake.spawn(file, args, options)
    children.push(child)
    return child
  }
  return { spawn, children }
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** What `promise` rejects with: the spec fails when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => {
    throw new Error('the promise resolved')
  }, (error: unknown) => error)
}

async function configError(promise: Promise<unknown>): Promise<ConfigError> {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(ConfigError)
  return error as ConfigError
}

/** `--range`'s message for `text`, as a `ConfigError` holds it. */
const issueOf = (message: string): { path: string, message: string } => ({ path: '--range', message })

async function open(reply: (call: GitCall) => GitReply | undefined = () => undefined, base?: GitBase): Promise<{ repository: Repository, fake: ReturnType<typeof fakeGit> }> {
  let opened = false
  const fake = fakeGit(call => opened
    ? reply(call)
    : undefined, base)
  const repository = await openRepository(contextOf(fake.spawn))
  opened = true
  fake.calls.splice(0)
  return { repository, fake }
}

/** A reply only for the calls whose own words are `command`, made inside the top level. */
function forCommand(command: string, answer: GitReply) {
  return (call: GitCall): GitReply | undefined =>
    call.args.includes('-C') && call.command.join(' ') === command
      ? answer
      : undefined
}

it('holds MAX_GIT_OUTPUT_BYTES equal to the core\'s MAX_DIFF_BYTES', () => {
  expect(MAX_GIT_OUTPUT_BYTES).toBe(MAX_DIFF_BYTES)
  expect(MAX_GIT_OUTPUT_BYTES).toBe(16 * 1024 * 1024)
  expect(GIT_FLOOR).toEqual({ major: 2, minor: 41 })
  expect([
    GIT_TIMEOUT_MS,
    MAX_GIT_STDERR_BYTES,
    MAX_GIT_SMALL_OUTPUT_BYTES,
    STDERR_EXCERPT,
  ]).toEqual([120_000, 65_536, 65_536, 500])
})

describe('gitArgs', () => {
  it('starts every operation with the pins, in their order', () => {
    expect(GLOBAL_PINS).toEqual(PINS)
    expect(DIFF_PINS).toEqual(DIFF)
    expect(ENVIRONMENT_ALLOWLIST).toEqual(ALLOWED)
    expect([GLOBAL_PINS, DIFF_PINS, ENVIRONMENT_ALLOWLIST].map(list => Object.isFrozen(list))).toEqual([true, true, true])
    expect(gitArgs({ op: 'version' })).toEqual([...GLOBAL_PINS, '--version'])
    for (const [, operation] of ROWS) expect(gitArgs(operation).slice(0, PINS.length)).toEqual(PINS)
  })

  it.each(ROWS)('builds %s exactly', (_name, operation, tail) => {
    expect(gitArgs(operation)).toEqual([
      ...PINS,
      ...tail,
    ])
  })

  it('refuses an id that is not a full id and a revision that is empty or starts with -, before any vector is built', () => {
    for (const id of [
      'abc',
      'A'.repeat(40),
      'a'.repeat(41),
      'g'.repeat(40),
      '',
      `${A}\n`,
    ]) {
      expect(() => gitArgs({
        op: 'merge-base',
        top: TOP,
        first: id,
        second: B,
      })).toThrow(RangeError)
      expect(() => gitArgs({
        op: 'merge-base',
        top: TOP,
        first: A,
        second: id,
      })).toThrow(RangeError)
      expect(() => gitArgs({
        op: 'diff-commits',
        top: TOP,
        from: id,
        to: B,
        attributes: A,
      })).toThrow(RangeError)
      expect(() => gitArgs({
        op: 'diff-commits',
        top: TOP,
        from: A,
        to: id,
        attributes: A,
      })).toThrow(RangeError)
      expect(() => gitArgs({
        op: 'diff-commits',
        top: TOP,
        from: A,
        to: B,
        attributes: id,
      })).toThrow(RangeError)
      expect(() => gitArgs({
        op: 'diff-index',
        top: TOP,
        from: id,
        attributes: A,
      })).toThrow(RangeError)
      expect(() => gitArgs({
        op: 'diff-worktree',
        top: TOP,
        from: A,
        attributes: id,
      })).toThrow(RangeError)
      expect(() => gitArgs({ op: 'list-tree', top: TOP, commit: id })).toThrow(RangeError)
    }
    for (const revision of ['', '-x', '--output=x', 'a\0b']) {
      expect(() => gitArgs({ op: 'resolve', top: TOP, revision })).toThrow(RangeError)
    }
    const long = 'c'.repeat(64)
    expect(gitArgs({ op: 'list-tree', top: TOP, commit: long }).at(-1)).toBe(long)
    expect(gitArgs({ op: 'resolve', top: TOP, revision: 'a-b' }).at(-1)).toBe('a-b^{commit}')
  })
})

describe('gitEnvironment', () => {
  it('passes each allowlisted variable and sets its own over the parent\'s', () => {
    const env = {
      ...Object.fromEntries(ALLOWED.map(name => [name, `v-${name}`])),
      LC_ALL: 'fr_FR',
      GIT_PAGER: 'less',
    }
    expect(gitEnvironment(env)).toEqual({
      ...Object.fromEntries(ALLOWED.map(name => [name, `v-${name}`])),
      ...SET_BY_QUORUM,
    })
    expect(gitEnvironment({})).toEqual(SET_BY_QUORUM)
  })

  it('drops every other variable, those that reshape the bytes or run a program included', () => {
    const dropped = [
      'GIT_DIFF_OPTS',
      'GIT_EXTERNAL_DIFF',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_ATTR_SOURCE',
      'GIT_LITERAL_PATHSPECS',
      'GIT_GLOB_PATHSPECS',
      'GIT_ICASE_PATHSPECS',
      'GIT_TRACE',
      'GIT_ASKPASS',
      'GIT_SSH_COMMAND',
      'PAGER',
      'LESS',
      'QUORUM_RESEARCH_API_KEY',
    ]
    const result = gitEnvironment(Object.fromEntries(dropped.map(name => [name, 'x'])))
    for (const name of dropped) expect(result).not.toHaveProperty(name)
    expect(result).toEqual(SET_BY_QUORUM)
  })

  it('reads each variable as an own string, never an inherited one', () => {
    expect(gitEnvironment(Object.create({ PATH: '/x' }) as Record<string, string>)).toEqual(SET_BY_QUORUM)
    expect(gitEnvironment({ PATH: undefined, HOME: '/h' })).toEqual({ ...SET_BY_QUORUM, HOME: '/h' })
  })
})

describe('runGit', () => {
  it('spawns the executable with no shell in the context\'s directory, with the vector and the environment, its stdin ignored unless the operation takes input', async () => {
    const fake = fakeGit(() => ({ stdout: 'out' }))
    const seen: Array<{ file: string, args: readonly string[], options: Parameters<SpawnGit>[2] }> = []
    const spawn: SpawnGit = (file, args, options) => {
      seen.push({ file, args, options })
      return fake.spawn(file, args, options)
    }
    const env = { PATH: '/bin', GIT_DIFF_OPTS: '--unified=0' }
    const context = contextOf(spawn, { env })
    const run = await runGit(context, { op: 'version' }, { input: 'ignored' })
    expect(run).toEqual({
      code: 0,
      stdout: new TextEncoder().encode('out'),
      stderr: '',
      over: false,
    })
    expect(seen[0].file).toBe('/usr/bin/git')
    expect(seen[0].args).toEqual(gitArgs({ op: 'version' }))
    expect(seen[0].options).toMatchObject({
      shell: false,
      windowsHide: true,
      cwd: '/work/sub',
      env: gitEnvironment(env),
    })
    expect((seen[0].options.stdio as unknown[])[0]).toBe('ignore')
    expect(fake.calls[0].stdin).toBe('')

    await runGit(context, { op: 'read-objects', top: TOP }, { input: `${A}\n${B}\n` })
    expect((seen[1].options.stdio as unknown[])[0]).toBe('pipe')
    expect(fake.calls[1].stdin).toBe(`${A}\n${B}\n`)
    await runGit(context, { op: 'empty-tree', top: TOP })
    expect((seen[2].options.stdio as unknown[])[0]).toBe('pipe')
    expect(fake.calls[2]).toMatchObject({
      stdin: '',
      cwd: '/work/sub',
      env: gitEnvironment(env),
    })
  })

  it('stops a child at its stdout cap, keeping no more than the cap, and says so', async () => {
    const fake = fakeGit(() => ({
      stdout: 'x'.repeat(100),
    }))
    const { spawn, children } = watched(fake)
    const run = await runGit(contextOf(spawn), { op: 'version' }, { maxStdout: 10 })
    expect(run.over).toBe(true)
    expect(text(run.stdout)).toBe('x'.repeat(10))
    expect(run.code).not.toBe(0)
    expect(children[0].killed).toBe(true)
    expect(children[0].signalCode).toBe('SIGKILL')

    const exact = await runGit(contextOf(fakeGit(() => ({
      stdout: 'y'.repeat(10),
    })).spawn), { op: 'version' }, { maxStdout: 10 })
    expect(exact).toMatchObject({ over: false, code: 0 })
    expect(text(exact.stdout)).toBe('y'.repeat(10))
    const small = await runGit(contextOf(fakeGit(() => ({
      stdout: new Uint8Array(MAX_GIT_SMALL_OUTPUT_BYTES + 1),
    })).spawn), { op: 'version' })
    expect(small.over).toBe(true)
    expect(small.stdout).toHaveLength(MAX_GIT_SMALL_OUTPUT_BYTES)

    // A caller that reads the stream itself is handed each chunk, and keeps none of it in the run.
    const chunks: string[] = []
    const stopped = watched(fake)
    const handed = await runGit(contextOf(stopped.spawn), { op: 'version' }, {
      onStdout: (chunk) => {
        chunks.push(text(chunk).slice(0, 3))
        return false
      },
    })
    expect(chunks).toEqual(['xxx'])
    expect(handed).toMatchObject({
      over: true,
      stdout: new Uint8Array(0),
    })
    expect(stopped.children[0].killed).toBe(true)
    const kept = await runGit(contextOf(fake.spawn), { op: 'version' }, {
      onStdout: () => true,
    })
    expect(kept).toMatchObject({
      over: false,
      code: 0,
      stdout: new Uint8Array(0),
    })
  })

  it('keeps the first 64 KiB of stderr', async () => {
    const stderr = `${'a'.repeat(MAX_GIT_STDERR_BYTES)}${'b'.repeat(100)}`
    const run = await runGit(contextOf(fakeGit(() => ({ stderr, code: 1 })).spawn), { op: 'version' })
    expect(run.code).toBe(1)
    expect(run.over).toBe(false)
    expect(run.stderr).toBe('a'.repeat(MAX_GIT_STDERR_BYTES))
  })

  it('kills a child at its deadline and rejects with a GitError naming the operation and the time', async () => {
    const clock = fakeClock()
    const { spawn, children } = watched(fakeGit(() => ({ hang: true })))
    const operation: GitOperation = {
      op: 'diff-commits',
      top: TOP,
      from: A,
      to: B,
      attributes: A,
    }
    const error = await rejection(settle(clock, runGit(contextOf(spawn, { clock }), operation)))
    expect(error).toBeInstanceOf(GitError)
    expect(error).toMatchObject({ message: 'git diff did not finish within 120000 ms', operation: 'diff', exitCode: null })
    expect(clock.armed).toEqual([GIT_TIMEOUT_MS])
    expect(children[0].killed).toBe(true)
    expect(children[0].signalCode).toBe('SIGKILL')
    expect([children[0].stdout?.destroyed, children[0].stderr?.destroyed]).toEqual([true, true])
    expect(clock.pending()).toBe(0)

    const shorter = fakeClock()
    const second = await rejection(settle(shorter, runGit(contextOf(watched(fakeGit(() => ({ hang: true }))).spawn, { clock: shorter, timeoutMs: 2500 }), { op: 'version' })))
    expect(second).toMatchObject({ message: 'git version did not finish within 2500 ms' })
    expect(shorter.armed).toEqual([2500])
  })

  it('kills a child when the signal aborts, and rejects with the signal\'s reason', async () => {
    const clock = fakeClock()
    const { spawn, children } = watched(fakeGit(() => ({ hang: true })))
    const controller = new AbortController()
    const reason = new Error('the caller stopped')
    const pending = rejection(runGit(contextOf(spawn, { clock, signal: controller.signal }), { op: 'version' }))
    await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort(reason)
    expect(await pending).toBe(reason)
    expect(children[0].killed).toBe(true)
    expect(children[0].signalCode).toBe('SIGKILL')
    expect(clock.pending()).toBe(0)

    const before = fakeGit(() => ({ stdout: 'late' }))
    const early = new Error('stopped before the call')
    expect(await rejection(runGit(contextOf(before.spawn, {
      signal: AbortSignal.abort(early),
    }), { op: 'version' }))).toBe(early)
    expect(before.calls).toHaveLength(0)
  })

  it('rejects with a GitError when git cannot start, naming the error\'s code and never the path', async () => {
    const failing: SpawnGit = () => {
      const child = new EventEmitter()
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn /opt/secret/git ENOENT'), { code: 'ENOENT', path: '/opt/secret/git' })))
      return Object.assign(child, {
        stdin: null,
        stdout: null,
        stderr: null,
        kill: () => false,
      }) as unknown as ChildProcess
    }
    const error = await rejection(runGit(contextOf(failing), { op: 'version' }))
    expect(error).toBeInstanceOf(GitError)
    expect(error).toMatchObject({ message: 'git could not start (ENOENT)', operation: 'version', exitCode: null })
    expect((error as Error).message).not.toContain('/')

    const throwing: SpawnGit = () => {
      throw Object.assign(new Error('EACCES: /opt/secret/git'), { code: 'EACCES' })
    }
    const thrown = await rejection(runGit(contextOf(throwing), { op: 'prefix' }))
    expect(thrown).toMatchObject({ message: 'git could not start (EACCES)', operation: 'rev-parse' })
  })
})

describe('openRepository', () => {
  it('checks the version, then reads the top level, the prefix and the git directory in the working directory, then the git directory and the object format inside the top level', async () => {
    const fake = fakeGit(() => undefined, {
      top: '/top',
      prefix: 'sub/',
      objectFormat: 'sha256',
      gitDir: '/top/.git',
    })
    const context = contextOf(fake.spawn)
    const repository = await openRepository(context)
    expect(fake.calls.map(call => call.args)).toEqual([
      [...PINS, '--version'],
      [...PINS, 'rev-parse', '--show-toplevel'],
      [...PINS, 'rev-parse', '--show-prefix'],
      [...PINS, 'rev-parse', '--absolute-git-dir'],
      [
        ...PINS,
        '-C',
        '/top',
        'rev-parse',
        '--absolute-git-dir',
      ],
      [
        ...PINS,
        '-C',
        '/top',
        'rev-parse',
        '--show-object-format',
      ],
    ])
    expect(fake.calls.map(call => call.cwd)).toEqual(Array.from({ length: 6 }).fill('/work/sub'))
    expect(repository).toMatchObject({ top: '/top', prefix: 'sub/', objectFormat: 'sha256' })
    expect(repository.context).toBe(context)
  })

  it.each([
    [
      'another repository',
      { stdout: '/other/.git\n' },
    ],
    [
      'none',
      { code: 128, stderr: 'fatal: not a git repository: /work/sub/missing\n' },
    ],
  ])('refuses a repository whose work tree belongs to %s', async (_name, answer) => {
    const fake = fakeGit(forCommand('rev-parse --absolute-git-dir', answer))
    const error = await configError(openRepository(contextOf(fake.spawn)))
    const message = 'the repository\'s work tree belongs to another repository or to none (core.worktree, GIT_WORK_TREE): run quorum in a clone you made'
    expect(error.message).toBe(`--range: ${message}`)
    expect(error.issues).toEqual([
      issueOf(message),
    ])
    expect(fake.calls).toHaveLength(5)
    expect(fake.calls.some(call => call.command.includes('--show-object-format'))).toBe(false)
  })

  it('names safe.directory when git refuses a repository another user owns, showing none of its stderr', async () => {
    const fake = fakeGit(call => call.command.join(' ') === 'rev-parse --show-toplevel'
      ? { code: 128, stderr: 'fatal: detected dubious ownership in repository at \'/srv/x\'\n' }
      : undefined)
    const error = await configError(openRepository(contextOf(fake.spawn)))
    expect(error.message).toBe('--range: git refuses this repository, as another user owns it: add it to safe.directory if you trust it, or pipe a diff in')
    expect(error.message).not.toContain('/srv/x')
    expect(fake.calls).toHaveLength(2)
  })

  it.each([
    ['git version 2.40.1', '2.40'],
    ['git version 2.39.5 (Apple Git-154)', '2.39'],
    ['git version 1.9.0', '1.9'],
  ])('refuses %s, which is below 2.41, naming its version', async (version, named) => {
    const fake = fakeGit(() => undefined, { version })
    const error = await configError(openRepository(contextOf(fake.spawn)))
    const message = `needs git 2.41 or later, and this git is ${named}: upgrade it, or pipe a diff in`
    expect(error.message).toBe(`--range: ${message}`)
    expect(error.issues).toEqual([
      issueOf(message),
    ])
    expect(fake.calls).toHaveLength(1)
  })

  it.each([
    'git version 2.41.0',
    'git version 2.50.1 (Apple Git-155)',
    'git version 3.0.0',
  ])('takes %s', async (version) => {
    const fake = fakeGit(() => undefined, { version })
    await expect(openRepository(contextOf(fake.spawn))).resolves.toMatchObject({ top: TOP, objectFormat: 'sha1' })
  })

  it('refuses a version it cannot read', async () => {
    const error = await configError(openRepository(contextOf(fakeGit(() => undefined, { version: 'git version x' }).spawn)))
    expect(error.message).toBe('--range: could not read the version of git: pipe a diff in instead')
  })

  it('refuses a working directory in no work tree', async () => {
    const fake = fakeGit(call => call.command.join(' ') === 'rev-parse --show-toplevel'
      ? { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }
      : undefined)
    const error = await configError(openRepository(contextOf(fake.spawn)))
    expect(error.message).toBe('--range: runs inside a git work tree, and the working directory is in none: pipe a diff in instead')
    expect(error.message).not.toContain('.git')
    expect(fake.calls).toHaveLength(2)
  })

  it('reads a top level and a prefix that hold a line break, dropping only the last line feed', async () => {
    const answers: Record<string, GitReply> = {
      'rev-parse --show-toplevel': { stdout: '/repo\nb\n' },
      'rev-parse --show-prefix': { stdout: 'dir/\n' },
    }
    const fake = fakeGit(call => call.args.includes('-C')
      ? undefined
      : answers[call.command.join(' ')])
    const repository = await openRepository(contextOf(fake.spawn))
    expect(repository.top).toBe('/repo\nb')
    expect(repository.prefix).toBe('dir/')
    expect(fake.calls[4].args.slice(PINS.length, PINS.length + 2)).toEqual(['-C', '/repo\nb'])
  })

  it('refuses an object format other than sha1 and sha256', async () => {
    const fake = fakeGit(() => undefined, { objectFormat: 'sha3' as 'sha1' })
    const error = await rejection(openRepository(contextOf(fake.spawn)))
    expect(error).toBeInstanceOf(GitError)
    expect(error).toMatchObject({ message: 'git rev-parse printed an object format quorum does not read', operation: 'rev-parse' })
  })
})

describe('a repository\'s operations', () => {
  it('resolves a revision to the full id git prints, and to undefined for any failure, never reading stderr', async () => {
    const { repository, fake } = await open(forCommand('rev-parse --verify --quiet --end-of-options main^{commit}', { stdout: `${A}\n` }))
    await expect(repository.resolveCommit('main')).resolves.toBe(A)
    expect(fake.calls[0].args).toEqual([
      ...PINS,
      '-C',
      TOP,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'main^{commit}',
    ])

    const failing = await open(() => ({ code: 1, stderr: 'error: gone^{commit}: expected commit type\n' }))
    await expect(failing.repository.resolveCommit('gone')).resolves.toBeUndefined()
    const wrong = await open(() => ({ stdout: `${'c'.repeat(64)}\n` }))
    await expect(wrong.repository.resolveCommit('main')).resolves.toBeUndefined()
    const empty = await open(() => ({ stdout: '' }))
    await expect(empty.repository.resolveCommit('main')).resolves.toBeUndefined()
    const long = await open(() => ({ stdout: `${'c'.repeat(64)}\n` }), { objectFormat: 'sha256' })
    await expect(long.repository.resolveCommit('main')).resolves.toBe('c'.repeat(64))

    for (const revision of ['-x', '--output=x', '']) {
      await expect(failing.repository.resolveCommit(revision)).resolves.toBeUndefined()
    }
    expect(failing.fake.calls).toHaveLength(1)
  })

  it('finds the merge base, undefined when git exits 1, and a GitError for any other failure', async () => {
    const found = await open(() => ({ stdout: `${B}\n` }))
    await expect(found.repository.mergeBase(A, B)).resolves.toBe(B)
    expect(found.fake.calls[0].args).toEqual([...PINS, '-C', TOP, 'merge-base', A, B])

    const none = await open(() => ({ code: 1 }))
    await expect(none.repository.mergeBase(A, B)).resolves.toBeUndefined()

    const failed = await open(() => ({ code: 128, stderr: 'fatal: boom\n' }))
    const error = await rejection(failed.repository.mergeBase(A, B))
    expect(error).toBeInstanceOf(GitError)
    expect(error).toMatchObject({ message: 'git merge-base failed (exit 128): "fatal: boom"', operation: 'merge-base', exitCode: 128 })

    const odd = await open(() => ({ stdout: 'not an id\n' }))
    await expect(rejection(odd.repository.mergeBase(A, B))).resolves.toBeInstanceOf(GitError)
  })

  it('reads the empty tree id of the repository\'s format, from hash-object given an empty stdin', async () => {
    const sha1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    const first = await open(() => ({ stdout: `${sha1}\n` }))
    await expect(first.repository.emptyTree()).resolves.toBe(sha1)
    expect(first.fake.calls[0]).toMatchObject({
      args: [
        ...PINS,
        '-C',
        TOP,
        'hash-object',
        '-t',
        'tree',
        '--stdin',
      ],
      stdin: '',
    })

    const sha256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
    const second = await open(() => ({ stdout: `${sha256}\n` }), { objectFormat: 'sha256' })
    await expect(second.repository.emptyTree()).resolves.toBe(sha256)

    // Any other reply is refused, a full id of the right length included, and so is one of the other format.
    for (const [printed, objectFormat] of [
      [
        'c'.repeat(40),
        'sha1',
      ],
      [
        'c'.repeat(64),
        'sha256',
      ],
      [sha1, 'sha256'],
      [sha256, 'sha1'],
    ] as const) {
      const wrong = await open(() => ({ stdout: `${printed}\n` }), { objectFormat })
      const error = await rejection(wrong.repository.emptyTree())
      expect(error).toBeInstanceOf(GitError)
      expect(error).toMatchObject({ message: 'git hash-object printed something quorum cannot read', operation: 'hash-object', exitCode: 0 })
    }
    const failed = await open(() => ({ code: 128, stderr: 'fatal: no\n' }))
    await expect(rejection(failed.repository.emptyTree())).resolves.toMatchObject({ message: 'git hash-object failed (exit 128): "fatal: no"' })
  })

  it('returns a diff\'s bytes, undefined over 16 MiB, and a GitError with git\'s stderr cut to 500 characters for a failure', async () => {
    const patch = 'diff --git a/x b/x\n'
    const read = await open(() => ({ stdout: patch }))
    for (const diff of [
      () => read.repository.diffCommits(A, B, A),
      () => read.repository.diffIndex(A, B),
      () => read.repository.diffWorktree(A, B),
    ]) {
      const bytes = await diff()
      expect(bytes).toBeDefined()
      expect(text(bytes as Uint8Array)).toBe(patch)
    }
    expect(read.fake.calls.map(call => call.command[1])).toEqual(['diff', 'diff', 'diff'])
    expect(read.fake.calls.map(call => call.command.filter(word => /^--(?:ignore-submodules=\w+|cached)$/.test(word)))).toEqual([
      ['--ignore-submodules=none'],
      ['--ignore-submodules=dirty', '--cached'],
      ['--ignore-submodules=dirty'],
    ])

    const huge = new Uint8Array(MAX_GIT_OUTPUT_BYTES + 1)
    const over = await open(() => ({ stdout: huge }))
    await expect(over.repository.diffCommits(A, B, A)).resolves.toBeUndefined()
    await expect(over.repository.diffIndex(A, A)).resolves.toBeUndefined()
    await expect(over.repository.diffWorktree(A, A)).resolves.toBeUndefined()

    const failed = await open(() => ({
      code: 128,
      stderr: 'x'.repeat(600),
    }))
    const error = await rejection(failed.repository.diffCommits(A, B, A))
    expect(error).toBeInstanceOf(GitError)
    expect(error).toMatchObject({ message: `git diff failed (exit 128): "${'x'.repeat(500)}"`, operation: 'diff', exitCode: 128 })
    const quiet = await open(() => ({ code: 1 }))
    await expect(rejection(quiet.repository.diffIndex(A, A))).resolves.toMatchObject({ message: 'git diff failed (exit 1)' })
  })

  it('reads the filter keys and their scopes from config -z, none when git exits 1', async () => {
    const stdout = 'local\0filter.lfs.clean\ngit-lfs clean -- %f\0global\0filter.x.smudge\0worktree\0filter.w.process\nw\0'
    const found = await open(() => ({ stdout }))
    await expect(found.repository.filterConfig()).resolves.toEqual([
      { scope: 'local', key: 'filter.lfs.clean' },
      { scope: 'global', key: 'filter.x.smudge' },
      { scope: 'worktree', key: 'filter.w.process' },
    ])
    expect(found.fake.calls[0].command.slice(0, 4)).toEqual([
      'config',
      '--show-scope',
      '-z',
      '--get-regexp',
    ])

    const none = await open(() => ({ code: 1 }))
    await expect(none.repository.filterConfig()).resolves.toEqual([])
    const failed = await open(() => ({ code: 128, stderr: 'fatal: bad config\n' }))
    await expect(rejection(failed.repository.filterConfig())).resolves.toMatchObject({ message: 'git config failed (exit 128): "fatal: bad config"' })
    const cut = await open(() => ({ stdout: 'local\0filter.a.clean' }))
    await expect(rejection(cut.repository.filterConfig())).resolves.toBeInstanceOf(GitError)
    const long = await open(() => ({
      stdout: new Uint8Array(MAX_GIT_SMALL_OUTPUT_BYTES + 1),
    }))
    await expect(rejection(long.repository.filterConfig())).resolves.toBeInstanceOf(GitError)
  })

  it('lists the untracked names as bytes split at NUL, and undefined over 16 MiB', async () => {
    const names = new Uint8Array([
      ...Buffer.from('a.txt'),
      0,
      ...Buffer.from('dir/b c'),
      0,
      0xFF,
      0x0A,
      0,
    ])
    const found = await open(() => ({ stdout: names }))
    const listed = await found.repository.untracked()
    expect(listed?.map(name => [...name])).toEqual([
      [
        ...Buffer.from('a.txt'),
      ],
      [
        ...Buffer.from('dir/b c'),
      ],
      [0xFF, 0x0A],
    ])
    expect(found.fake.calls[0].args).toEqual([
      ...PINS,
      '-C',
      TOP,
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
    ])

    const none = await open(() => ({ stdout: '' }))
    await expect(none.repository.untracked()).resolves.toEqual([])
    const over = await open(() => ({
      stdout: new Uint8Array(MAX_GIT_OUTPUT_BYTES + 1),
    }))
    await expect(over.repository.untracked()).resolves.toBeUndefined()
    const failed = await open(() => ({ code: 128, stderr: 'fatal: no\n' }))
    await expect(rejection(failed.repository.untracked())).resolves.toMatchObject({ message: 'git ls-files failed (exit 128): "fatal: no"' })
  })
})
