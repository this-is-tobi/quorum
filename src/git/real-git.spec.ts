import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findExecutable } from '../config/command.ts'
import { ConfigError } from '../core/errors.ts'
import { gitEnvironment, GitError, GLOBAL_PINS, openRepository } from './run.ts'
import type { GitContext, Repository, SpawnGit } from './run.ts'
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

async function refusal(promise: Promise<Repository>): Promise<string> {
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
})
