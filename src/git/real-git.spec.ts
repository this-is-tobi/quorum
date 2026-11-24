import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findExecutable } from '../config/command.ts'
import { resolveProfiles } from '../config/profiles.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { readContext } from '../context/read.ts'
import { decodeDiff, diffSections } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { addedDiff } from '../sources/added.ts'
import { readSource } from '../sources/read.ts'
import { gitEnvironment, GitError, GLOBAL_PINS, openRepository } from './run.ts'
import type { GitContext, SpawnGit } from './run.ts'
import { listTree, readBlobs } from './tree.ts'
import type { TreeEntry } from './tree.ts'

/** The tests of this block run the real git, so each one starts by expecting it: a machine without it fails them, never skips them. */
const GIT = findExecutable('git', process.env, process.platform)
const ACCENTED = `caf${String.fromCharCode(0xE9)}.txt`
const NO_WORK_TREE = '--range: runs inside a git work tree, and the working directory is in none: pipe a diff in instead'
const OTHER_WORK_TREE = '--range: the repository\'s work tree belongs to another repository or to none (core.worktree, GIT_WORK_TREE): run quorum in a clone you made'

/** A temporary directory of its own, with a `HOME` and the environment git runs in there: no user config, no system config, fixed authors and dates. */
interface Workspace {
  readonly root: string
  /** The environment a context holds: what a review of this directory would pass. */
  readonly env: Record<string, string>
  /** Runs the real git in `cwd`, as the builder of a repository, and returns its trimmed stdout. */
  readonly git: (cwd: string, ...args: string[]) => string
  /** Where the hostile programs of this directory write their names. */
  readonly log: string
}

const made: string[] = []

function workspace(): Workspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-git-')))
  made.push(root)
  mkdirSync(join(root, 'home'))
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: join(root, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const building = {
    ...env,
    GIT_AUTHOR_NAME: 'Quorum Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Quorum Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  }
  return {
    root,
    env,
    git: (cwd, ...args) => execFileSync(GIT as string, args, {
      cwd,
      env: building,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    log: join(root, 'markers.log'),
  }
}

function contextOf(ws: Workspace, cwd: string, extra: Partial<GitContext> = {}): GitContext {
  return {
    git: GIT as string,
    cwd,
    env: ws.env,
    flag: '--range',
    ...extra,
  }
}

/** The tracked files of a repository: `name` to its content, written and committed as one commit. */
function commit(ws: Workspace, repo: string, files: Record<string, string>, message: string): string {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true })
    writeFileSync(join(repo, name), content)
  }
  ws.git(repo, 'add', '-A')
  ws.git(repo, 'commit', '-q', '-m', message)
  return ws.git(repo, 'rev-parse', 'HEAD')
}

function init(ws: Workspace, name: string, ...flags: string[]): string {
  const repo = join(ws.root, name)
  mkdirSync(repo)
  ws.git(repo, 'init', '-q', '-b', 'main', ...flags)
  return repo
}

// Each line starts with a digit, so git names no function in a hunk's header.
const LINES = Array.from({ length: 10 }, (_, index) => `${index + 1} row\n`)
function edited(index: number): string {
  return LINES.map((line, at) => at === index
    ? `${index + 1} ROW\n`
    : line).join('')
}

/** A repository of two commits: `base`, and `head`, which edits a file in a directory, adds a copy of another and a file with a non-ASCII name. */
function twoCommits(ws: Workspace, name = 'repo'): { repo: string, base: string, head: string } {
  const repo = init(ws, name)
  const base = commit(ws, repo, {
    'a.dat': 'one\ntwo\n',
    'b.dat': 'x\ny\n',
    'sub/f.txt': LINES.join(''),
  }, 'base')
  const head = commit(ws, repo, {
    'a.dat': 'one\nTWO\n',
    'b.dat': 'x\nY\n',
    'sub/f.txt': edited(4),
    'copy.dat': 'one\ntwo\n',
    [ACCENTED]: 'accent\n',
  }, 'head')
  return { repo, base, head }
}

/** A `/bin/sh` program that only appends its name to the log of the workspace. */
function program(ws: Workspace, directory: string, name: string): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, `#!/bin/sh\necho ${name} >> '${ws.log}'\nexit 0\n`)
  chmodSync(path, 0o755)
  return path
}

function ran(ws: Workspace): string[] {
  return existsSync(ws.log)
    ? readFileSync(ws.log, 'utf8').trim().split('\n').sort()
    : []
}

/**
 * The config of the hostile repository of the plan: a program named wherever a config can name one (the
 * fsmonitor, a hooks directory, the pagers, an external diff, a text converter and a driver command, the three
 * programs of a filter), and every setting that reshapes a diff. Its attributes send the files to the driver
 * and the filter. Written after the commits: building the repository ran none of it.
 */
function makeHostile(ws: Workspace, repo: string): void {
  const bin = join(ws.root, 'bin')
  const hooks = join(ws.root, 'hooks')
  mkdirSync(hooks)
  for (const hook of [
    'post-checkout',
    'post-commit',
    'reference-transaction',
    'pre-commit',
  ]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho hook-${hook} >> '${ws.log}'\nexit 0\n`)
    chmodSync(join(hooks, hook), 0o755)
  }
  const order = join(ws.root, 'order')
  writeFileSync(order, 'b.dat\na.dat\n')
  const attributesFile = join(ws.root, 'attributes')
  writeFileSync(attributesFile, '* diff=evil filter=evil\nsub/f.txt -diff\n')
  const path = (name: string): string => program(ws, bin, name)
  appendFileSync(join(repo, '.git', 'config'), `
[core]
\tfsmonitor = "${path('fsmonitor')}"
\tpager = "${path('pager')}"
\thooksPath = "${hooks}"
\tquotePath = false
\tbigFileThreshold = 1
\tabbrev = 5
\tattributesFile = "${attributesFile}"
[pager]
\tdiff = "${path('pager-diff')}"
[diff]
\texternal = "${path('external')}"
\talgorithm = histogram
\tcontext = 9
\tnoprefix = true
\tmnemonicPrefix = true
\trenames = copies
\trelative = true
\tinterHunkContext = 7
\tsuppressBlankEmpty = true
\torderFile = "${order}"
[diff "evil"]
\ttextconv = "${path('textconv')}"
\tcommand = "${path('command')}"
[filter "evil"]
\tclean = "${path('clean')}"
\tsmudge = "${path('smudge')}"
\tprocess = "${path('process')}"
[color]
\tui = always
`)
  // The attributes of `info/attributes` outrank the attributes file's, so it names the data files only and leaves `sub/f.txt` to the attributes file.
  writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.dat diff=evil filter=evil\n')
  writeFileSync(join(repo, '.gitattributes'), '* diff=evil filter=evil\n')
}

const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString('utf8')

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ConfigError)
  return (error as ConfigError).message
}

// One test at a time: `describe.sequential` is gone from Vitest 5.1, where `concurrent: false` is the switch.
describe('the real git', { concurrent: false, timeout: 30_000 }, () => {
  beforeEach(() => {
    expect(GIT, 'git 2.41 or later must be on PATH').toBeDefined()
  })

  afterEach(() => {
    for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('finds git 2.41 or later on PATH, which every test of this block needs', async () => {
    expect(findExecutable('git', process.env, process.platform)).toBeDefined()
    const ws = workspace()
    const repo = init(ws, 'new')
    const repository = await openRepository(contextOf(ws, repo))
    expect(repository).toMatchObject({ top: repo, prefix: '', objectFormat: 'sha1' })
    await expect(repository.emptyTree()).resolves.toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    await expect(repository.resolveCommit('HEAD')).resolves.toBeUndefined()
    await expect(repository.untracked()).resolves.toEqual([])

    const wide = init(ws, 'wide', '--object-format=sha256')
    const sha256 = await openRepository(contextOf(ws, wide))
    expect(sha256.objectFormat).toBe('sha256')
    await expect(sha256.emptyTree()).resolves.toBe('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321')
  })

  it('runs nothing from a hostile config, attributes, hooks and pager, and gives the bytes of a clean config', async () => {
    const ws = workspace()
    const { repo, base, head } = twoCommits(ws)
    makeHostile(ws, repo)

    // The controls: unpinned, the hostile repository runs its programs.
    // (The programs print nothing, which git may call a failure; the log says they ran.)
    for (const args of [
      ['status'],
      ['--no-pager', 'diff', base, head],
    ]) spawnSync(GIT as string, args, { cwd: repo, env: ws.env })
    expect(ran(ws)).toEqual(expect.arrayContaining(['fsmonitor', 'process']))
    const clone = join(ws.root, 'clone')
    ws.git(ws.root, 'clone', '-q', '--no-local', repo, clone)
    rmSync(ws.log)

    const repository = await openRepository(contextOf(ws, repo))
    await expect(repository.resolveCommit('main')).resolves.toBe(head)
    await expect(repository.resolveCommit('HEAD~1')).resolves.toBe(base)
    await expect(repository.mergeBase(base, head)).resolves.toBe(base)
    await expect(repository.emptyTree()).resolves.toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    const diff = await repository.diffCommits(base, head, base)
    await repository.diffIndex(head, head)
    await expect(repository.filterConfig()).resolves.toEqual([
      { scope: 'local', key: 'filter.evil.clean' },
      { scope: 'local', key: 'filter.evil.smudge' },
      { scope: 'local', key: 'filter.evil.process' },
    ])
    expect((await repository.untracked())?.map(name => text(name))).toEqual(['.gitattributes'])
    expect(ran(ws)).toEqual([])

    const clean = await (await openRepository(contextOf(ws, clone))).diffCommits(base, head, base)
    expect(diff).toBeDefined()
    expect(Buffer.from(diff as Uint8Array).equals(Buffer.from(clean as Uint8Array))).toBe(true)
    const patch = text(diff)
    expect(patch.indexOf('diff --git a/a.dat b/a.dat')).toBeGreaterThanOrEqual(0)
    expect(patch.indexOf('diff --git a/a.dat b/a.dat')).toBeLessThan(patch.indexOf('diff --git a/b.dat b/b.dat'))
    expect(patch).toContain('diff --git a/copy.dat b/copy.dat\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..')
    expect(patch).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40} 100644$/m)
    expect(patch).toContain('@@ -2,7 +2,7 @@')
    expect(patch).toContain('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"')
    expect(patch).not.toContain(String.fromCharCode(0x1B))
  })

  it('reads a range of a hostile repository as a clean clone\'s bytes, with nothing run', async () => {
    const ws = workspace()
    const repo = init(ws, 'repo')
    const root = commit(ws, repo, {
      'a.dat': 'one\ntwo\n',
      'b.dat': 'x\ny\n',
      'sub/f.txt': LINES.join(''),
    }, 'base')
    ws.git(repo, 'checkout', '-q', '-b', 'feature')
    const head = commit(ws, repo, {
      'a.dat': 'one\nTWO\n',
      'b.dat': 'x\nY\n',
      'sub/f.txt': edited(4),
      'copy.dat': 'one\ntwo\n',
      [ACCENTED]: 'accent\n',
    }, 'feature')
    ws.git(repo, 'checkout', '-q', 'main')
    const base = commit(ws, repo, { 'later.txt': 'main moved on\n' }, 'main moved on')
    const clone = join(ws.root, 'clone')
    ws.git(ws.root, 'clone', '-q', '--no-local', repo, clone)
    ws.git(clone, 'branch', 'feature', 'origin/feature')
    makeHostile(ws, repo)

    const read = (cwd: string): ReturnType<typeof readSource> => readSource({ kind: 'range', range: 'main...feature' }, {
      cwd,
      env: ws.env,
      platform: process.platform,
    })
    const hostile = await read(repo)
    const clean = await read(clone)

    expect(hostile).toEqual(clean)
    expect(hostile.source).toEqual({
      kind: 'range',
      base,
      mergeBase: root,
      head,
      objectFormat: 'sha1',
    })
    expect(hostile.leftOut).toEqual([])
    expect(hostile.diff).toContain('diff --git a/a.dat b/a.dat\n')
    expect(hostile.diff).toContain('diff --git a/copy.dat b/copy.dat\nnew file mode 100644\n')
    expect(hostile.diff).toContain('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n')
    expect(hostile.diff).toContain('@@ -2,7 +2,7 @@')
    expect(hostile.diff).not.toContain('later.txt')
    expect(hostile.diff).not.toContain(String.fromCharCode(0x1B))
    expect(ran(ws)).toEqual([])
  })

  it('refuses a bare repository nested in the tree, entered from its directory', async () => {
    const ws = workspace()
    const { repo } = twoCommits(ws)
    const nested = join(repo, 'vendor', 'evil.git')
    mkdirSync(join(repo, 'vendor'))
    ws.git(repo, 'init', '-q', '--bare', nested)
    appendFileSync(join(nested, 'config'), `[core]\n\tfsmonitor = "${program(ws, join(ws.root, 'bin'), 'bare-fsmonitor')}"\n`)
    expect(await refusal(openRepository(contextOf(ws, nested)))).toBe(NO_WORK_TREE)
    expect(ran(ws)).toEqual([])
  })

  it('refuses a repository whose core.worktree names another repository or a plain directory, and opens a linked worktree and a submodule', async () => {
    const ws = workspace()
    const { repo } = twoCommits(ws, 'main-repo')
    const other = twoCommits(ws, 'other').repo

    const linked = join(ws.root, 'linked')
    ws.git(repo, 'worktree', 'add', '-q', linked)
    await expect(openRepository(contextOf(ws, linked))).resolves.toMatchObject({ top: linked })

    const module = init(ws, 'module')
    commit(ws, module, { 'm.txt': 'module\n' }, 'module')
    ws.git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', module, 'deps/module')
    await expect(openRepository(contextOf(ws, join(repo, 'deps', 'module')))).resolves.toMatchObject({
      top: join(repo, 'deps', 'module'),
    })

    const another = twoCommits(ws, 'points-at-another').repo
    ws.git(another, 'config', 'core.worktree', other)
    expect(await refusal(openRepository(contextOf(ws, another)))).toBe(OTHER_WORK_TREE)

    const plain = join(ws.root, 'plain')
    mkdirSync(plain)
    const none = twoCommits(ws, 'points-at-none').repo
    ws.git(none, 'config', 'core.worktree', plain)
    expect(await refusal(openRepository(contextOf(ws, none)))).toBe(OTHER_WORK_TREE)
  })

  it('reads the real blob past a replace ref', async () => {
    const ws = workspace()
    const repo = init(ws, 'replaced')
    const base = commit(ws, repo, { 'a.txt': 'one\n' }, 'base')
    const head = commit(ws, repo, { 'a.txt': 'real\n' }, 'head')
    const fake = execFileSync(GIT as string, ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      env: { ...ws.env },
      input: 'fake\n',
      encoding: 'utf8',
    }).trim()
    ws.git(repo, 'replace', ws.git(repo, 'rev-parse', 'HEAD:a.txt'), fake)
    expect(ws.git(repo, 'diff', base, head)).toContain('+fake')

    const diff = text(await (await openRepository(contextOf(ws, repo))).diffCommits(base, head, base))
    expect(diff).toContain('+real\n')
    expect(diff).not.toContain('fake')
  })

  it('never reads a revision as an option', async () => {
    const ws = workspace()
    const { repo } = twoCommits(ws)
    const calls: string[][] = []
    const counting: SpawnGit = (file, args, options) => {
      calls.push([...args])
      return spawn(file, args, options)
    }
    const repository = await openRepository(contextOf(ws, repo, { spawn: counting }))
    calls.length = 0
    const written = join(ws.root, 'written.txt')

    await expect(repository.resolveCommit(`--output=${written}`)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(existsSync(written)).toBe(false)

    const vector = spawnSync(GIT as string, [
      ...GLOBAL_PINS,
      '-C',
      repository.top,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `--output=${written}^{commit}`,
    ], {
      cwd: repo,
      env: gitEnvironment(ws.env),
    })
    expect(vector.status).not.toBe(0)
    expect(existsSync(written)).toBe(false)
  })

  it('drops an inherited GIT_DIFF_OPTS and GIT_EXTERNAL_DIFF', async () => {
    const ws = workspace()
    const { repo, base, head } = twoCommits(ws)
    const external = program(ws, join(ws.root, 'bin'), 'external')
    const inherited = { ...ws.env, GIT_DIFF_OPTS: '--unified=0', GIT_EXTERNAL_DIFF: external }

    const repository = await openRepository(contextOf(ws, repo, { env: inherited }))
    const diff = text(await repository.diffCommits(base, head, base))
    expect(diff).toContain('@@ -2,7 +2,7 @@\n 2 row\n 3 row\n 4 row\n-5 row\n+5 ROW\n 6 row\n 7 row\n 8 row\n')
    expect(ran(ws)).toEqual([])

    // The control: the same variables, handed to a plain git, run the program.
    execFileSync(GIT as string, ['--no-pager', 'diff', base, head], {
      cwd: repo,
      env: { ...inherited },
      stdio: 'ignore',
    })
    expect(new Set(ran(ws))).toEqual(new Set(['external']))
  })

  it('writes nothing to the repository: a working-tree diff leaves the index as it was', async () => {
    const ws = workspace()
    const repo = init(ws, 'quiet')
    const head = commit(ws, repo, { 'touched.txt': 'same\n', 'edited.txt': 'before\n' }, 'head')
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(repo, 'touched.txt'), later, later)
    writeFileSync(join(repo, 'edited.txt'), 'after\n')
    const index = join(repo, '.git', 'index')
    const bytes = readFileSync(index)
    const mtime = statSync(index).mtimeMs

    const diff = text(await (await openRepository(contextOf(ws, repo))).diffWorktree(head, head))
    expect(diff).toContain('+after\n')
    expect(diff).not.toContain('touched.txt')
    expect(readFileSync(index).equals(bytes)).toBe(true)
    expect(statSync(index).mtimeMs).toBe(mtime)

    // The control: a plain git diff refreshes the stat data of the touched file and rewrites the index.
    ws.git(repo, 'diff', head)
    expect(readFileSync(index).equals(bytes)).toBe(false)
  })

  it('closes every diff with --, so a tracked file named as a commit id is no revision', async () => {
    const ws = workspace()
    const repo = init(ws, 'named')
    const base = commit(ws, repo, { 'x.txt': 'one\n' }, 'base')
    const head = commit(ws, repo, { 'x.txt': 'two\n', [base]: 'named like a commit\n' }, 'head')
    const repository = await openRepository(contextOf(ws, repo))
    const section = `diff --git a/${base} b/${base}`

    expect(text(await repository.diffCommits(base, head, base))).toContain(section)
    expect(text(await repository.diffIndex(base, base))).toContain(section)
    expect(text(await repository.diffWorktree(base, base))).toContain(section)
    // The control: without `--` git cannot tell the file from the revision.
    expect(() => ws.git(repo, 'diff', base, head)).toThrow(/ambiguous argument/)
  })

  it('lists and reads a commit\'s blobs past a replace ref, at their real sizes', async () => {
    const ws = workspace()
    const repo = init(ws, 'replaced')
    mkdirSync(join(repo, 'bin'))
    writeFileSync(join(repo, 'bin', 'run'), '#!/bin/sh\n')
    chmodSync(join(repo, 'bin', 'run'), 0o755)
    const head = commit(ws, repo, { 'a.txt': 'real\n', 'dup.txt': 'real\n' }, 'head')
    const real = ws.git(repo, 'rev-parse', 'HEAD:a.txt')
    const fake = execFileSync(GIT as string, ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      env: { ...ws.env },
      input: 'fake and longer\n',
      encoding: 'utf8',
    }).trim()
    ws.git(repo, 'replace', real, fake)
    // The control: a plain git reads the replacement.
    expect(ws.git(repo, 'cat-file', '-p', real)).toBe('fake and longer')

    const repository = await openRepository(contextOf(ws, repo))
    const entries = await listTree(repository, head, () => true) as TreeEntry[]

    expect(entries.map(entry => ({
      ...entry,
      path: text(entry.path),
    }))).toEqual([
      {
        mode: '100644',
        type: 'blob',
        id: real,
        size: 5,
        path: 'a.txt',
      },
      {
        mode: '100755',
        type: 'blob',
        id: ws.git(repo, 'rev-parse', 'HEAD:bin/run'),
        size: 10,
        path: 'bin/run',
      },
      {
        mode: '100644',
        type: 'blob',
        id: real,
        size: 5,
        path: 'dup.txt',
      },
    ])
    expect((await readBlobs(repository, entries, 100)).map(text)).toEqual(['real\n', '#!/bin/sh\n', 'real\n'])
  })

  it('fetches nothing for a partial clone: its listing and its reads fail closed', async () => {
    const ws = workspace()
    const origin = init(ws, 'origin')
    const head = commit(ws, origin, { 'a.txt': 'one\n', 'sub/b.txt': 'two\n' }, 'head')
    ws.git(origin, 'config', 'uploadpack.allowFilter', 'true')
    const clone = join(ws.root, 'clone')
    ws.git(ws.root, 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${origin}`, clone)
    const before = ws.git(clone, 'count-objects', '-v')
    const ids = await listTree(await openRepository(contextOf(ws, origin)), head, () => true) as TreeEntry[]
    expect(ids.map(entry => entry.size)).toEqual([4, 4])

    const repository = await openRepository(contextOf(ws, clone))
    const listed = await listTree(repository, head, () => true).then(() => undefined, (error: unknown) => error)
    expect(listed).toBeInstanceOf(GitError)
    expect((listed as GitError).message).toBe('git ls-tree could not size an object the commit names: the repository lacks it, as a partial clone does')
    const read = await readBlobs(repository, ids, 100).then(() => undefined, (error: unknown) => error)
    expect(read).toBeInstanceOf(GitError)
    expect((read as GitError).message).toBe('git cat-file did not return each listed blob at its listed size')
    expect(ws.git(clone, 'count-objects', '-v')).toBe(before)

    // The control: a plain git fetches the blob it lacks.
    ws.git(clone, 'cat-file', '-p', ids[0].id)
    expect(ws.git(clone, 'count-objects', '-v')).not.toBe(before)
  })

  it('writes each section as git writes a new file, but its index line, over every byte class of a name', async () => {
    const ws = workspace()
    const repo = init(ws, 'names')
    const encoder = new TextEncoder()
    const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.split(' ').map(pair => Number.parseInt(pair, 16)))
    const contents = [
      encoder.encode('one\ntwo\n'),
      encoder.encode('x'),
      new Uint8Array(),
      encoder.encode('a\r\nb\r\n'),
      bytesOf('ef bb bf 61 0a'),
      bytesOf('c3 0a'),
      bytesOf('61 00 62 0a'),
    ]
    // Every byte but NUL and `/`, as `n<byte>x`, and runs of valid and invalid UTF-8.
    const names = [
      ...Array.from({ length: 255 }, (_, index) => index + 1).filter(byte => byte !== 0x2F).map(byte => Uint8Array.of(0x6E, byte, 0x78)),
      ...[
        'c3 a9',
        'e2 82 ac',
        'f0 9f 98 80',
        '61 01 c3 a9',
        '01 ff',
        'c3 28',
        'e2 82',
        'c0 af',
        'ed a0 80',
        'ef bb bf 62',
        '61 20 62',
        '61 20 c3 a9',
        '61 22 5c 62',
        '74 09 6e 0a 72 0d',
        '65 6e 64 20',
        '80 41 80',
      ].map(bytesOf),
    ]
    const entries = [
      ...names.map((name, index) => ({ mode: '100644', name, content: contents[index % contents.length] })),
      {
        mode: '100644',
        name: encoder.encode('zz-lines'),
        content: encoder.encode(`${Array.from({ length: 900 }, (_, index) => `line ${index} of a file cut into hunks`).join('\n')}\n`),
      },
      {
        mode: '100644',
        name: encoder.encode('zz-long'),
        content: encoder.encode(`${'b'.repeat(5000)}\nshort`),
      },
      {
        mode: '100755',
        name: encoder.encode('zz-exec'),
        content: encoder.encode('#!/bin/sh\n'),
      },
      {
        mode: '120000',
        name: encoder.encode('zz-link'),
        content: encoder.encode('target/dir'),
      },
      {
        mode: '100644',
        name: bytesOf('62 20 c3 a9 2e 62 69 6e'),
        content: bytesOf('61 00 62 0a'),
      },
    ]
    const ids = new Map<Uint8Array, string>()
    for (const { content } of entries) {
      if (ids.has(content)) continue
      ids.set(content, execFileSync(GIT as string, ['hash-object', '-w', '--stdin'], {
        cwd: repo,
        env: { ...ws.env },
        input: content,
        encoding: 'utf8',
      }).trim())
    }
    const records = entries.flatMap(({ mode, name, content }) => [
      Buffer.from(`${mode} blob ${ids.get(content)}\t`),
      name,
      Buffer.alloc(1),
    ])
    const tree = execFileSync(GIT as string, ['mktree', '-z'], {
      cwd: repo,
      env: { ...ws.env },
      input: Buffer.concat(records),
      encoding: 'utf8',
    }).trim()
    const commitId = ws.git(repo, 'commit-tree', tree, '-m', 'names')

    const repository = await openRepository(contextOf(ws, repo))
    const listed = await listTree(repository, commitId, () => true) as TreeEntry[]
    const blobs = await readBlobs(repository, listed, 16 * 1024 * 1024)
    const written = diffSections(addedDiff(listed.map((entry, index) => ({ path: entry.path, mode: entry.mode, content: blobs[index] }))))
    const pinned = await repository.diffCommits(await repository.emptyTree(), commitId, commitId)
    const git = diffSections(await decodeDiff([pinned as Uint8Array]) as string)

    expect(listed).toHaveLength(entries.length)
    expect(written).toHaveLength(entries.length)
    expect(git).toHaveLength(entries.length)
    const cut: string[] = []
    for (const [index, section] of written.entries()) {
      const theirs = git[index].text.split('\n')
      // The writer leaves the `index` line out: the third line of git's new-file form, whatever the file.
      expect(theirs[2], `section ${index}`).toMatch(/^index 0+\.\.[0-9a-f]+$/)
      theirs.splice(2, 1)
      expect(section.path, `section ${index}`).toBe(git[index].path)
      const withoutHunkHeaders = (lines: string[]): string[] => lines.filter(line => !line.startsWith('@@'))
      const ours = section.text.split('\n')
      if (ours.length - withoutHunkHeaders(ours).length > 1) {
        cut.push(section.path as string)
        expect(withoutHunkHeaders(ours), section.path).toEqual(withoutHunkHeaders(theirs))
      } else {
        expect(section.text, `section ${index}`).toBe(theirs.join('\n'))
      }
    }
    // Only the two files longer than a hunk differ, and by their hunk headers.
    expect(cut).toEqual(['zz-lines', 'zz-long'])
  })

  it('reads the filter keys\' scope through an include, and refuses the local source of a repository whose own config names one', async () => {
    const ws = workspace()
    const bin = join(ws.root, 'bin')
    // The user's global config includes a file naming a filter: its keys are the user's own.
    const globalFilters = join(ws.root, 'global-filters.config')
    writeFileSync(globalFilters, `[filter "lfs"]\n\tclean = "${program(ws, bin, 'global-clean')}"\n`)
    const globalConfig = join(ws.root, 'global.config')
    writeFileSync(globalConfig, `[include]\n\tpath = ${globalFilters}\n`)
    const env = { ...ws.env, GIT_CONFIG_GLOBAL: globalConfig }
    const source = (cwd: string, trustRepoConfig?: boolean): ReturnType<typeof readSource> => readSource({ kind: 'local', trustRepoConfig }, {
      cwd,
      env,
      platform: process.platform,
    })

    // The repository's own config includes one too, and its attributes send a tracked file to it.
    const repo = init(ws, 'repo')
    commit(ws, repo, { 'a.dat': 'one\n' }, 'base')
    const localFilters = join(ws.root, 'local-filters.config')
    writeFileSync(localFilters, `[filter "evil"]\n\tclean = "${program(ws, bin, 'clean')}"\n\tsmudge = "${program(ws, bin, 'smudge')}"\n`)
    appendFileSync(join(repo, '.git', 'config'), `[include]\n\tpath = ${localFilters}\n`)
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.dat filter=evil\n')
    writeFileSync(join(repo, 'a.dat'), 'two\n')

    // The control: a plain git diff runs the filter.
    spawnSync(GIT as string, ['--no-pager', 'diff'], { cwd: repo, env })
    expect(new Set(ran(ws))).toEqual(new Set(['clean']))
    rmSync(ws.log)

    const repository = await openRepository(contextOf(ws, repo, { env, flag: '--local' }))
    await expect(repository.filterConfig()).resolves.toEqual([
      { scope: 'global', key: 'filter.lfs.clean' },
      { scope: 'local', key: 'filter.evil.clean' },
      { scope: 'local', key: 'filter.evil.smudge' },
    ])
    expect(await refusal(source(repo))).toBe('--local: the repository\'s own config names a filter program, which a working-tree diff runs: pass --trust-repo-config if the repository is yours, or review a range')
    expect(await refusal(readSource({ kind: 'staged' }, { cwd: repo, env, platform: process.platform }))).toBe('--staged: the repository\'s own config names a filter program, which a working-tree diff runs: pass --trust-repo-config if the repository is yours, or review a range')
    expect(ran(ws)).toEqual([])

    // What the flag says: the repository is the user's, and its filter runs.
    await expect(source(repo, true)).resolves.toMatchObject({
      source: { kind: 'local' },
    })
    expect(new Set(ran(ws))).toEqual(new Set(['clean']))

    // A filter of the user's own global config alone runs as with their git, with no flag.
    const plain = init(ws, 'plain')
    commit(ws, plain, { 'b.txt': 'b\n' }, 'base')
    await expect(source(plain)).resolves.toMatchObject({
      diff: '',
      source: { kind: 'local' },
    })
  })

  it('lists untracked links as single entries, never following them, and writes each as git add -A would', async () => {
    const ws = workspace()
    const repo = init(ws, 'links')
    const head = commit(ws, repo, { 'tracked.txt': 'tracked\n' }, 'base')
    writeFileSync(join(repo, 'real.txt'), 'x\n')
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 'inner.txt'), 'inner\n')
    symlinkSync('real.txt', join(repo, 'to-file'))
    symlinkSync('/etc', join(repo, 'to-etc'))
    symlinkSync('sub', join(repo, 'to-dir'))
    symlinkSync('missing-target', join(repo, 'dangling'))

    const repository = await openRepository(contextOf(ws, repo, { flag: '--local' }))
    expect((await repository.untracked())?.map(name => text(name))).toEqual([
      'dangling',
      'real.txt',
      'sub/inner.txt',
      'to-dir',
      'to-etc',
      'to-file',
    ])

    const read = await readSource({ kind: 'local' }, { cwd: repo, env: ws.env, platform: process.platform })
    expect(read.source).toEqual({ kind: 'local', head, objectFormat: 'sha1' })
    expect(read.leftOut).toEqual([])
    // Each link is a row of its target, and nothing of what it names is read: no line of /etc.
    expect(read.diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))).toEqual([
      '+missing-target',
      '+x',
      '+inner',
      '+sub',
      '+/etc',
      '+real.txt',
    ])
    expect(read.diff).toContain('diff --git a/to-etc b/to-etc\nnew file mode 120000\n--- /dev/null\n+++ b/to-etc\n@@ -0,0 +1 @@\n+/etc\n\\ No newline at end of file\n')

    // The control: git add -A commits the same sections, each with an index line more.
    ws.git(repo, 'add', '-A')
    const theirs = ws.git(repo, 'diff', '--cached', '--no-renames').split('\n').filter(line => !line.startsWith('index '))
    expect(read.diff).toBe(`${theirs.join('\n')}\n`)
  })
})

/** A resolved config of one profile of its own, whose guidelines and rules are the repository files `guidelines` and `rules` name. */
function configOf(guidelines: Array<{ repository: string, optional?: boolean }>, rules: Array<{ repository: string, optional?: boolean }> = []): ResolvedConfig {
  const result = resolveProfiles({
    profiles: {
      naming: {
        prompts: { research: 'Find naming issues.', vote: 'Judge from {{lens.id}}: {{lens.question}}' },
        lenses: [
          { id: 'grounded', question: 'Is it backed by a stated convention?' },
        ],
        guidelines,
        rules,
      },
    },
    roles: { research: 'main', voter: 'main' },
    providers: ['main'],
  })
  expect(result.issues).toEqual([])
  return { providers: {}, profiles: result.profiles, warnings: [] }
}

async function issuesOf(promise: Promise<unknown>): Promise<readonly ConfigIssue[]> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ConfigError)
  return (error as ConfigError).issues
}

describe('repository documents', { concurrent: false, timeout: 30_000 }, () => {
  beforeEach(() => {
    expect(GIT, 'git 2.41 or later must be on PATH').toBeDefined()
  })

  afterEach(() => {
    for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('reads a range\'s repository guideline from its base, never the head\'s edit of it', async () => {
    const ws = workspace()
    const repo = init(ws, 'repo')
    const base = commit(ws, repo, { 'REVIEW.md': 'base rule', 'a.js': 'safe()\n' }, 'base')
    ws.git(repo, 'checkout', '-q', '-b', 'feature')
    const head = commit(ws, repo, { 'REVIEW.md': 'head rule', 'a.js': 'exec(cmd)\n' }, 'head')
    // A third copy, in the working tree, which no source reads.
    writeFileSync(join(repo, 'REVIEW.md'), 'working tree rule')
    // The control: the head holds the edit, and a plain git reads it there.
    expect(ws.git(repo, 'show', `${head}:REVIEW.md`)).toBe('head rule')

    const context = { cwd: repo, env: ws.env, platform: process.platform }
    const read = await readSource({ kind: 'range', range: 'main...feature' }, context)
    const documents = (await readContext(configOf([
      { repository: 'REVIEW.md' },
    ]), { ...context, source: read.source })).documents ?? []

    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({
      profile: 'naming',
      kind: 'guidelines',
      origin: { kind: 'repository', path: 'REVIEW.md', commit: base },
      text: 'base rule',
    })
    // The change's own edit of the file is in the diff the review reads, and in no document.
    expect(read.diff).toContain('+head rule')
    expect(JSON.stringify(documents)).not.toContain('head rule')
    expect(JSON.stringify(documents)).not.toContain('working tree rule')
  })

  it('reads a range\'s repository rules file from its base', async () => {
    const ws = workspace()
    const repo = init(ws, 'repo')
    const base = commit(ws, repo, { '.quorum/rules.yaml': '- id: base-rule\n  text: The base rule.\n', 'a.js': 'safe()\n' }, 'base')
    ws.git(repo, 'checkout', '-q', '-b', 'feature')
    commit(ws, repo, { '.quorum/rules.yaml': '- id: head-rule\n  text: The head rule.\n', 'a.js': 'exec(cmd)\n' }, 'head')
    // A third copy, in the working tree, which no source reads.
    writeFileSync(join(repo, '.quorum', 'rules.yaml'), '- id: tree-rule\n  text: The working tree rule.\n')

    const context = { cwd: repo, env: ws.env, platform: process.platform }
    const read = await readSource({ kind: 'range', range: 'main...feature' }, context)
    const documents = (await readContext(configOf([], [
      { repository: '.quorum/rules.yaml' },
    ]), { ...context, source: read.source })).documents ?? []

    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({
      profile: 'naming',
      kind: 'rules',
      origin: { kind: 'repository', path: '.quorum/rules.yaml', commit: base },
      rules: [
        { id: 'base-rule', text: 'The base rule.' },
      ],
    })
    // The change's own edit of the file is in the diff the review reads, and in no document.
    expect(read.diff).toContain('+- id: head-rule')
    expect(JSON.stringify(documents)).not.toContain('head-rule')
    expect(JSON.stringify(documents)).not.toContain('tree-rule')
  })

  it.each<[string, (ws: Workspace, repo: string) => string, (short: string) => string]>([
    [
      'absent',
      (ws, repo) => commit(ws, repo, { 'README.md': 'x' }, 'readme'),
      short => `"REVIEW.md" is not a file of the commit ${short} the review reads it from`,
    ],
    [
      'a link',
      (ws, repo) => {
        symlinkSync('README.md', join(repo, 'REVIEW.md'))
        return commit(ws, repo, { 'README.md': 'x' }, 'link')
      },
      short => `"REVIEW.md" is a symbolic link at ${short}, which quorum does not follow`,
    ],
    [
      'a gitlink',
      (ws, repo) => {
        const first = commit(ws, repo, { 'README.md': 'x' }, 'first')
        ws.git(repo, 'update-index', '--add', '--cacheinfo', `160000,${first},REVIEW.md`)
        ws.git(repo, 'commit', '-q', '-m', 'submodule')
        return ws.git(repo, 'rev-parse', 'HEAD')
      },
      short => `"REVIEW.md" is a submodule's commit at ${short}, which quorum does not read`,
    ],
    [
      'a binary blob',
      (ws, repo) => commit(ws, repo, { 'REVIEW.md': `a${String.fromCharCode(0)}b` }, 'binary'),
      short => `"REVIEW.md" is not UTF-8 text at ${short}`,
    ],
    [
      'over its cap',
      (ws, repo) => commit(ws, repo, {
        'REVIEW.md': 'x'.repeat(17_020),
      }, 'big'),
      short => `"REVIEW.md" at ${short} holds 17020 bytes once cleaned, over the 16 KiB a guidelines document may hold`,
    ],
  ])('refuses a repository document that is %s at the commit', async (name, build, message) => {
    const ws = workspace()
    const repo = init(ws, 'repo')
    const head = build(ws, repo)
    const source = { kind: 'staged', head, objectFormat: 'sha1' } as const
    const context = {
      cwd: repo,
      env: ws.env,
      platform: process.platform,
      source,
    }
    expect(await issuesOf(readContext(configOf([
      { repository: 'REVIEW.md' },
    ]), context))).toEqual([
      {
        path: 'profiles.naming.guidelines.0.repository',
        message: message(head.slice(0, 7)),
      },
    ])
    // Optional says a file may be absent, never that it may be a link, a submodule, binary or over its cap.
    if (name !== 'absent') {
      expect(await issuesOf(readContext(configOf([
        { repository: 'REVIEW.md', optional: true },
      ]), context))).toEqual([
        {
          path: 'profiles.naming.guidelines.0.repository',
          message: message(head.slice(0, 7)),
        },
      ])
    }
  })

  it('reads a path review\'s documents at the commit --at names', async () => {
    const ws = workspace()
    const repo = init(ws, 'repo')
    const first = commit(ws, repo, { 'REVIEW.md': 'old rule', 'src/a.js': 'a()\n' }, 'first')
    const second = commit(ws, repo, { 'REVIEW.md': 'new rule', 'src/a.js': 'b()\n' }, 'second')
    const context = { cwd: repo, env: ws.env, platform: process.platform }
    const config = configOf([
      { repository: 'REVIEW.md' },
    ])

    const old = await readSource({
      kind: 'paths',
      paths: ['src'],
      at: first,
    }, context)
    expect(old.source).toMatchObject({ kind: 'paths', commit: first })
    expect((await readContext(config, { ...context, source: old.source })).documents).toEqual([
      expect.objectContaining({
        origin: {
          kind: 'repository',
          path: 'REVIEW.md',
          commit: first,
          sha256: expect.any(String),
        },
        text: 'old rule',
      }),
    ])
    // With no --at, the commit is HEAD.
    const current = await readSource({
      kind: 'paths',
      paths: ['src'],
    }, context)
    expect((await readContext(config, { ...context, source: current.source })).documents).toEqual([
      expect.objectContaining({
        origin: {
          kind: 'repository',
          path: 'REVIEW.md',
          commit: second,
          sha256: expect.any(String),
        },
        text: 'new rule',
      }),
    ])
  })

  it('reads local and staged changes\' documents at HEAD, a path below the top level, and a file the index and the working tree have since changed', async () => {
    const ws = workspace()
    const repo = init(ws, 'repo')
    const head = commit(ws, repo, { 'docs/review/RULES.md': 'committed rule', 'src/a.js': 'a()\n' }, 'head')
    // The index holds one edit of the document and the working tree another: neither is read, only HEAD's copy.
    writeFileSync(join(repo, 'docs', 'review', 'RULES.md'), 'staged rule')
    ws.git(repo, 'add', 'docs/review/RULES.md')
    writeFileSync(join(repo, 'docs', 'review', 'RULES.md'), 'working tree rule')
    // The control: git reads each copy where it is, and HEAD's is a third.
    expect(ws.git(repo, 'show', ':docs/review/RULES.md')).toBe('staged rule')
    expect(ws.git(repo, 'show', `${head}:docs/review/RULES.md`)).toBe('committed rule')
    // The repository is entered below its top level: the path is still the top level's.
    const context = {
      cwd: join(repo, 'src'),
      env: ws.env,
      platform: process.platform,
    }
    for (const kind of ['local', 'staged'] as const) {
      const read = await readSource({ kind }, context)
      expect(read.source).toEqual({ kind, head, objectFormat: 'sha1' })
      // The source itself sees the edit it reviews, the index's copy for staged changes and the working tree's for local ones.
      expect(read.diff).toContain(kind === 'staged'
        ? '+staged rule'
        : '+working tree rule')
      expect((await readContext(configOf([
        { repository: 'docs/review/RULES.md' },
      ]), { ...context, source: read.source })).documents).toEqual([
        expect.objectContaining({
          origin: expect.objectContaining({ commit: head }),
          text: 'committed rule',
        }),
      ])
    }
  })
})
