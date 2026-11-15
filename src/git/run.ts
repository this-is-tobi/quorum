import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { Clock } from '../core/clock.ts'
import { systemClock } from '../core/clock.ts'
import { ConfigError, QuorumError } from '../core/errors.ts'
import type { ObjectFormat } from '../core/types.ts'

/**
 * The one place quorum runs git: a closed set of typed operations (`GitOperation`), each built into one
 * argument vector by `gitArgs` and spawned by `runGit` with no shell, and `openRepository`, which checks a
 * working directory and hands back the operations the sources call. Quorum reviews repositories it was
 * handed, so nothing a repository holds may run a program or reshape the bytes git prints.
 *
 * @see ../../docs/95-reference/40-architecture.md for where it sits in the layers.
 */

/** The oldest git quorum runs: `--attr-source` came with 2.41, and every other option it pins is older. */
export const GIT_FLOOR = Object.freeze({ major: 2, minor: 41 })
/** The deadline of one git call, on the injected clock. */
export const GIT_TIMEOUT_MS = 120_000
/** The most a diff or a listing may print, which `core/diff.ts`'s `MAX_DIFF_BYTES` is: the layer imports no `diff.ts`, so a spec holds the two equal. */
export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
/** The most of a child's stderr that is kept; the rest is read and dropped. */
export const MAX_GIT_STDERR_BYTES = 65_536
/** The most `--version`, `rev-parse`, `merge-base`, `hash-object` and `config` print. */
export const MAX_GIT_SMALL_OUTPUT_BYTES = 65_536
/** The characters of git's stderr a `GitError` quotes. */
export const STDERR_EXCERPT = 500

/** What a run's `code` is when quorum stopped the child, which then has no exit code of its own. */
const STOPPED = -1

/** Before every command: no pager, no lock and no replace ref, literal pathspecs, and the config keys that would run a program or reshape a path. */
export const GLOBAL_PINS: readonly string[] = Object.freeze([
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
])

/** After `diff`: the options that give one form of diff whatever the repository's `diff.*` and `color.*` config says. */
export const DIFF_PINS: readonly string[] = Object.freeze([
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
])

/** The variables of the parent's environment a child gets, when the parent holds them as its own strings. Every other variable is dropped. */
export const ENVIRONMENT_ALLOWLIST: readonly string[] = Object.freeze([
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
])

/** The variables quorum sets, over whatever the parent holds. An empty allowlist of protocols refuses every transport, a lazy fetch's included. */
const SET_BY_QUORUM: Readonly<Record<string, string>> = Object.freeze({
  LC_ALL: 'C',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
})

const ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ID_OF: Readonly<Record<ObjectFormat, RegExp>> = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ }
/** The id of the empty tree in each object format, which `hash-object -t tree --stdin` of nothing prints: git's answer is checked against it. */
const EMPTY_TREE: Readonly<Record<ObjectFormat, string>> = Object.freeze({
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
})
const VERSION = /^git version (\d+)\.(\d+)/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,39}$/

/** A git call that failed: it could not start, passed its deadline, was stopped by a signal, exited with a failure, or printed what quorum cannot read. */
export class GitError extends QuorumError {
  /** The git subcommand the call ran: `diff`, `rev-parse`, `ls-tree`, and `version` for `--version`. */
  readonly operation: string
  /** The exit code, or null when there was none: the child did not start or did not finish. */
  readonly exitCode: number | null

  constructor(message: string, operation: string, exitCode: number | null = null) {
    super(message)
    this.operation = operation
    this.exitCode = exitCode
  }
}

/** `spawn`, as the runner calls it, so a spec injects its own. */
export type SpawnGit = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** What every git call of a review runs with. */
export interface GitContext {
  /** The absolute path of the git executable. */
  readonly git: string
  /** The directory the child starts in: the user's working directory. */
  readonly cwd: string
  /** The parent's environment; `gitEnvironment` picks what a child gets of it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The flag a `ConfigError` of this run names as its issue path: `--range`, `--local`, `--staged` or `--path`. */
  readonly flag: string
  readonly signal?: AbortSignal
  readonly spawn?: SpawnGit
  /** The clock the deadline runs on; the system's when unset. */
  readonly clock?: Clock
  /** The deadline of each call; `GIT_TIMEOUT_MS` when unset. */
  readonly timeoutMs?: number
}

/**
 * What a child gets of the parent's environment: each name of `ENVIRONMENT_ALLOWLIST` the parent holds as its
 * own string, then quorum's own seven variables, which win. Nothing else passes: not `GIT_DIFF_OPTS` or
 * `GIT_EXTERNAL_DIFF`, not `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_COUNT`, not a pager, not a key.
 */
export function gitEnvironment(env: GitContext['env']): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = Object.hasOwn(env, name)
      ? env[name]
      : undefined
    if (typeof value === 'string') result[name] = value
  }
  return {
    ...result,
    ...SET_BY_QUORUM,
  }
}

/** The calls quorum makes: the ones that name the repository, then the reads of one. `top` is the top level `openRepository` found. */
export type GitOperation
  = | { readonly op: 'version' }
    | { readonly op: 'toplevel' }
    | { readonly op: 'prefix' }
    | { readonly op: 'git-dir' }
    | { readonly op: 'top-git-dir', readonly top: string }
    | { readonly op: 'object-format', readonly top: string }
    | { readonly op: 'resolve', readonly top: string, readonly revision: string }
    | { readonly op: 'merge-base', readonly top: string, readonly first: string, readonly second: string }
    | { readonly op: 'empty-tree', readonly top: string }
    | { readonly op: 'diff-commits', readonly top: string, readonly from: string, readonly to: string, readonly attributes: string }
    | { readonly op: 'diff-index', readonly top: string, readonly from: string, readonly attributes: string }
    | { readonly op: 'diff-worktree', readonly top: string, readonly from: string, readonly attributes: string }
    | { readonly op: 'filter-config', readonly top: string }
    | { readonly op: 'untracked', readonly top: string }
    | { readonly op: 'list-tree', readonly top: string, readonly commit: string }
    | { readonly op: 'read-objects', readonly top: string }

/** The git subcommand each operation runs, as a `GitError` names it. */
const SUBCOMMAND: Readonly<Record<GitOperation['op'], string>> = {
  version: 'version',
  toplevel: 'rev-parse',
  prefix: 'rev-parse',
  'git-dir': 'rev-parse',
  'top-git-dir': 'rev-parse',
  'object-format': 'rev-parse',
  resolve: 'rev-parse',
  'merge-base': 'merge-base',
  'empty-tree': 'hash-object',
  'diff-commits': 'diff',
  'diff-index': 'diff',
  'diff-worktree': 'diff',
  'filter-config': 'config',
  untracked: 'ls-files',
  'list-tree': 'ls-tree',
  'read-objects': 'cat-file',
}

/** An id as it goes into a vector: 40 or 64 lowercase hexadecimal characters, else a `RangeError` that does not repeat it. */
export function checkedId(value: string): string {
  if (!ID.test(value)) throw new RangeError('a git id must be 40 or 64 lowercase hexadecimal characters')
  return value
}

/** Whether `value` is a revision quorum passes git: not empty, not an option, with no NUL (which no argument can hold). */
function isRevision(value: string): boolean {
  return value !== '' && !value.startsWith('-') && !value.includes('\0')
}

/** The vector of a command run inside the top level: `-C <top>` after the pins, which git reads as one argument whatever it holds. */
function inTop(top: string, ...words: string[]): string[] {
  return [
    ...GLOBAL_PINS,
    '-C',
    top,
    ...words,
  ]
}

/**
 * The argument vector of `operation`: `GLOBAL_PINS`, then the operation's own words. Every id is checked
 * first, as 40 or 64 lowercase hexadecimal characters, and a revision, the one string a user gives git, as
 * not empty and not an option (it follows `--end-of-options` besides): a `RangeError` otherwise, before any
 * vector is built. Every diff ends with `--`, so no name is read as a revision.
 */
export function gitArgs(operation: GitOperation): string[] {
  switch (operation.op) {
    case 'version':
      return [...GLOBAL_PINS, '--version']
    case 'toplevel':
      return [...GLOBAL_PINS, 'rev-parse', '--show-toplevel']
    case 'prefix':
      return [...GLOBAL_PINS, 'rev-parse', '--show-prefix']
    case 'git-dir':
      return [...GLOBAL_PINS, 'rev-parse', '--absolute-git-dir']
    case 'top-git-dir':
      return inTop(operation.top, 'rev-parse', '--absolute-git-dir')
    case 'object-format':
      return inTop(operation.top, 'rev-parse', '--show-object-format')
    case 'resolve':
      if (!isRevision(operation.revision)) throw new RangeError('a revision must name something, may not start with - and may not hold a NUL')
      return inTop(operation.top, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${operation.revision}^{commit}`)
    case 'merge-base':
      return inTop(operation.top, 'merge-base', checkedId(operation.first), checkedId(operation.second))
    case 'empty-tree':
      return inTop(operation.top, 'hash-object', '-t', 'tree', '--stdin')
    case 'diff-commits':
      return inTop(operation.top, `--attr-source=${checkedId(operation.attributes)}`, 'diff', ...DIFF_PINS, '--ignore-submodules=none', checkedId(operation.from), checkedId(operation.to), '--')
    case 'diff-index':
      return inTop(operation.top, `--attr-source=${checkedId(operation.attributes)}`, 'diff', ...DIFF_PINS, '--ignore-submodules=dirty', '--cached', checkedId(operation.from), '--')
    case 'diff-worktree':
      return inTop(operation.top, `--attr-source=${checkedId(operation.attributes)}`, 'diff', ...DIFF_PINS, '--ignore-submodules=dirty', checkedId(operation.from), '--')
    case 'filter-config':
      return inTop(operation.top, 'config', '--show-scope', '-z', '--get-regexp', '^filter\\..+\\.(clean|smudge|process)$')
    case 'untracked':
      return inTop(operation.top, 'ls-files', '-z', '--others', '--exclude-standard')
    case 'list-tree':
      return inTop(operation.top, 'ls-tree', '-r', '-z', '--long', '--full-tree', checkedId(operation.commit))
    case 'read-objects':
      return inTop(operation.top, 'cat-file', '--batch', '--buffer')
  }
}

/** What a git call came to, whatever its exit code. */
export interface GitRun {
  /** The exit code; -1 when quorum stopped the child, at its stdout cap or at the consumer's word, which `over` says. */
  readonly code: number
  /** What the child printed, up to the cap: empty when the consumer was handed each chunk. */
  readonly stdout: Uint8Array
  /** The first 64 KiB of stderr, decoded. */
  readonly stderr: string
  /** Whether the child was stopped for printing more than was read, so `stdout` is a cut and no answer. */
  readonly over: boolean
}

/** `error`'s system code as a message writes it, or `unknown`: the message of the error holds the path, and a path is not printed. */
function startFailure(name: string, error: unknown): GitError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
  const named = typeof code === 'string' && ERROR_CODE.test(code)
    ? code
    : 'unknown'
  return new GitError(`git could not start (${named})`, name)
}

/** `chunks` as one array of `size` bytes, their total. */
export function joined(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}

/**
 * Runs one operation: spawns `context.git` with `gitArgs`'s vector and `gitEnvironment`'s environment, with
 * no shell, from `context.cwd`, its stdin ignored unless the operation takes input (`empty-tree` and
 * `read-objects`, which get `options.input` and an end). It resolves for any exit code, with stdout up to
 * `options.maxStdout` (`MAX_GIT_SMALL_OUTPUT_BYTES` unless a caller says) and the first 64 KiB of stderr; a
 * child that prints more is killed and the run says `over`. With `options.onStdout` each chunk is handed over
 * and not kept, and `false` stops the child, `over` again. It rejects with a `GitError` when git cannot start,
 * passes its deadline (`GIT_TIMEOUT_MS` on the context's clock) or is ended by a signal quorum did not send,
 * and with the signal's reason when `context.signal` aborts. Quorum's own stops, at a cap, a deadline or an
 * abort, are SIGKILL, after which the child's pipes are destroyed so that a helper holding them cannot keep
 * the call open. The timer and the listener are gone on every path.
 *
 * What is pinned, and what the prototype on git 2.50.1 saw without it:
 * - `core.fsmonitor`, `core.hooksPath` and the pager (`--no-pager`, `core.pager`, `GIT_PAGER`): a repository's
 *   own config ran its marker programs as fsmonitor, as hooks and, under a pseudo-terminal, as the pager.
 * - `--no-ext-diff`, `--no-textconv` and `core.attributesFile`, with `--attr-source=<commit>` on each diff:
 *   `diff.external`, a text converter and a driver's `command` ran, and `.gitattributes` and `info/attributes`
 *   named them. Every operation ran nothing but the working-tree diff, whose filters the trust check refuses.
 * - `--no-replace-objects` and `GIT_NO_REPLACE_OBJECTS`: a replace ref swapped a blob for another.
 * - `diff.autoRefreshIndex=false`, `--no-optional-locks` and `GIT_OPTIONAL_LOCKS`: a working-tree diff
 *   rewrote `.git/index`, a stat refresh, and quorum never writes to a repository.
 * - The `DIFF_PINS`, `core.quotePath` and `diff.suppressBlankEmpty`: a hostile `diff.algorithm`,
 *   `diff.context`, `diff.renames`, `core.abbrev`, `diff.orderFile` and the like changed the bytes of a diff.
 * - `--` after every diff: a tracked file named after a commit id made `git diff <id> <id>` fatal.
 * - `GIT_NO_LAZY_FETCH` and an empty `GIT_ALLOW_PROTOCOL`: a partial clone fetched a missing blob; each alone
 *   stops it, and the allowlist holds on every release.
 * - `safe.bareRepository=explicit`: a bare repository committed in the tree was refused from inside it.
 * - The environment allowlist: `GIT_DIFF_OPTS` and `GIT_EXTERNAL_DIFF` of the parent reshaped and ran.
 */
export function runGit(
  context: GitContext,
  operation: GitOperation,
  options: {
    readonly input?: Uint8Array | string
    readonly maxStdout?: number
    readonly onStdout?: (chunk: Uint8Array) => boolean
  } = {},
): Promise<GitRun> {
  return new Promise<GitRun>((resolve, reject) => {
    const args = gitArgs(operation)
    const name = SUBCOMMAND[operation.op]
    const { signal } = context
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const takesInput = operation.op === 'empty-tree' || operation.op === 'read-objects'
    let child: ChildProcess
    try {
      child = (context.spawn ?? spawn)(context.git, args, {
        cwd: context.cwd,
        env: gitEnvironment(context.env),
        stdio: [
          takesInput ? 'pipe' : 'ignore',
          'pipe',
          'pipe',
        ],
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      reject(startFailure(name, error))
      return
    }
    const timeoutMs = context.timeoutMs ?? GIT_TIMEOUT_MS
    const limit = options.maxStdout ?? MAX_GIT_SMALL_OUTPUT_BYTES
    const stdout: Uint8Array[] = []
    const stderr: Uint8Array[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let cause: 'over' | 'deadline' | 'abort' | 'consumer' | undefined
    let thrown: unknown
    let started = false
    let done = false

    const stop = (why: NonNullable<typeof cause>): void => {
      if (cause !== undefined || done) return
      cause = why
      child.kill('SIGKILL')
      // A helper that outlives git and holds the pipes must not keep `close` from firing.
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const onAbort = (): void => stop('abort')
    const cancel = (context.clock ?? systemClock).timer(timeoutMs, () => stop('deadline'))
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      cancel()
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Uint8Array) => {
      if (cause !== undefined) return
      if (options.onStdout !== undefined) {
        try {
          if (!options.onStdout(chunk)) stop('over')
        } catch (error) {
          thrown = error
          stop('consumer')
        }
        return
      }
      const room = limit - stdoutBytes
      if (chunk.length > room) {
        stdout.push(chunk.subarray(0, room))
        stdoutBytes = limit
        stop('over')
        return
      }
      stdout.push(chunk)
      stdoutBytes += chunk.length
    })
    child.stderr?.on('data', (chunk: Uint8Array) => {
      const room = MAX_GIT_STDERR_BYTES - stderrBytes
      if (room <= 0) return
      const kept = chunk.subarray(0, room)
      stderr.push(kept)
      stderrBytes += kept.length
    })
    child.once('spawn', () => {
      started = true
    })
    child.on('error', (error) => {
      if (!started) finish(() => reject(startFailure(name, error)))
    })
    child.once('close', (code, endedBy) => finish(() => {
      switch (cause) {
        case 'abort':
          reject(signal?.reason)
          return
        case 'deadline':
          reject(new GitError(`git ${name} did not finish within ${timeoutMs} ms`, name))
          return
        case 'consumer':
          reject(thrown)
          return
        case 'over':
          resolve({
            code: STOPPED,
            stdout: joined(stdout, stdoutBytes),
            stderr: new TextDecoder().decode(joined(stderr, stderrBytes)),
            over: true,
          })
          return
        default:
          if (code === null) {
            reject(new GitError(`git ${name} was stopped by ${endedBy ?? 'a signal'}`, name))
            return
          }
          resolve({
            code,
            stdout: joined(stdout, stdoutBytes),
            stderr: new TextDecoder().decode(joined(stderr, stderrBytes)),
            over: false,
          })
      }
    }))
    if (takesInput) {
      // git may exit before it has read its input: its exit code says what happened.
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input)
    }
  })
}

/** `stderr` as a failure quotes it: decoded already, trimmed and cut to `STDERR_EXCERPT` characters, written as a JSON string so a name in it is inert; nothing when it holds no text. */
function excerptOf(stderr: string): string {
  const text = stderr.trim().slice(0, STDERR_EXCERPT)
  return text === ''
    ? ''
    : `: ${JSON.stringify(text)}`
}

/** The `GitError` of an operation that exited with a failure: `git <name> failed (exit <code>)`, then what stderr said. */
export function gitFailure(operation: GitOperation['op'], run: GitRun): GitError {
  const name = SUBCOMMAND[operation]
  return new GitError(`git ${name} failed (exit ${run.code})${excerptOf(run.stderr)}`, name, run.code)
}

/** The `GitError` of an operation that printed more than quorum reads of it. */
function overflow(operation: GitOperation['op']): GitError {
  const name = SUBCOMMAND[operation]
  return new GitError(`git ${name} printed more than quorum reads`, name)
}

/** The `GitError` of an operation that exited cleanly and printed what quorum cannot read. */
function unreadable(operation: GitOperation['op']): GitError {
  const name = SUBCOMMAND[operation]
  return new GitError(`git ${name} printed something quorum cannot read`, name, 0)
}

/** One config entry of a filter: where git read it from, and its key. */
export interface FilterKey {
  readonly scope: string
  readonly key: string
}

/** A repository a source reads, opened by `openRepository`. A diff or a listing over its cap is `undefined`. */
export interface Repository {
  readonly context: GitContext
  /** The top level of the work tree, as git prints it. */
  readonly top: string
  /** The path of the working directory under the top level, as git prints it: empty at the top, else ending with `/`. */
  readonly prefix: string
  readonly objectFormat: ObjectFormat
  /** The full id of the commit `revision` names, or undefined for any failure: git's stderr there quotes the revision as typed, so it is never read. */
  readonly resolveCommit: (revision: string) => Promise<string | undefined>
  /** The merge base of two commits, undefined when they share no history. */
  readonly mergeBase: (first: string, second: string) => Promise<string | undefined>
  /** The id of the empty tree of the repository's object format, as git prints it and as the format's constant says: any other reply is a `GitError`. */
  readonly emptyTree: () => Promise<string>
  /** The diff from commit `from` to commit `to`, its attributes read from the commit `attributes`. */
  readonly diffCommits: (from: string, to: string, attributes: string) => Promise<Uint8Array | undefined>
  /** The diff of the index against commit `from`. */
  readonly diffIndex: (from: string, attributes: string) => Promise<Uint8Array | undefined>
  /** The diff of the working tree against commit `from`; it runs the filters the repository's config names. */
  readonly diffWorktree: (from: string, attributes: string) => Promise<Uint8Array | undefined>
  /** Every `filter.<name>.clean`, `.smudge` and `.process` key of the repository's config, with its scope. */
  readonly filterConfig: () => Promise<FilterKey[]>
  /** The names of the untracked files that are not ignored, as git prints them, each as its bytes. */
  readonly untracked: () => Promise<Uint8Array[] | undefined>
}

/** What git printed, as a line: its last line feed dropped, and no other character. */
function lineOf(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes)
  return text.endsWith('\n')
    ? text.slice(0, -1)
    : text
}

/** The `filter.*` keys of `config --show-scope -z` output: each record is `<scope>\0<key>[\n<value>]\0`. */
function parseFilterKeys(bytes: Uint8Array): FilterKey[] | undefined {
  const tokens = new TextDecoder().decode(bytes).split('\0')
  if (tokens.pop() !== '' || tokens.length % 2 !== 0) return undefined
  const keys: FilterKey[] = []
  for (let at = 0; at < tokens.length; at += 2) {
    const key = tokens[at + 1].split('\n', 1)[0]
    if (tokens[at] === '' || key === '') return undefined
    keys.push({ scope: tokens[at], key })
  }
  return keys
}

/** The names of `-z` output, as bytes. */
function splitNames(bytes: Uint8Array): Uint8Array[] {
  const names: Uint8Array[] = []
  let from = 0
  for (let at = bytes.indexOf(0); at !== -1; at = bytes.indexOf(0, from)) {
    names.push(bytes.subarray(from, at))
    from = at + 1
  }
  if (from < bytes.length) names.push(bytes.subarray(from))
  return names
}

function repositoryOf(context: GitContext, top: string, prefix: string, objectFormat: ObjectFormat): Repository {
  const read = (operation: GitOperation, maxStdout?: number): Promise<GitRun> => runGit(context, operation, { maxStdout })
  const idPrinted = (bytes: Uint8Array): string | undefined => {
    const id = lineOf(bytes)
    return ID_OF[objectFormat].test(id)
      ? id
      : undefined
  }
  /** The id an operation printed: any failure, a cut and anything but a full id of the repository's format are a `GitError`. */
  const idFrom = (operation: GitOperation, run: GitRun): string => {
    if (run.over) throw overflow(operation.op)
    if (run.code !== 0) throw gitFailure(operation.op, run)
    const id = idPrinted(run.stdout)
    if (id === undefined) throw unreadable(operation.op)
    return id
  }
  const readDiff = async (operation: GitOperation): Promise<Uint8Array | undefined> => {
    const run = await read(operation, MAX_GIT_OUTPUT_BYTES)
    if (run.over) return undefined
    if (run.code !== 0) throw gitFailure(operation.op, run)
    return run.stdout
  }
  return {
    context,
    top,
    prefix,
    objectFormat,
    resolveCommit: async (revision) => {
      if (!isRevision(revision)) return undefined
      const run = await read({ op: 'resolve', top, revision })
      return run.code === 0 && !run.over
        ? idPrinted(run.stdout)
        : undefined
    },
    mergeBase: async (first, second) => {
      const operation: GitOperation = { op: 'merge-base', top, first, second }
      const run = await read(operation)
      return run.code === 1
        ? undefined
        : idFrom(operation, run)
    },
    emptyTree: async () => {
      const operation: GitOperation = { op: 'empty-tree', top }
      const id = idFrom(operation, await read(operation))
      if (id !== EMPTY_TREE[objectFormat]) throw unreadable('empty-tree')
      return id
    },
    diffCommits: (from, to, attributes) => readDiff({
      op: 'diff-commits',
      top,
      from,
      to,
      attributes,
    }),
    diffIndex: (from, attributes) => readDiff({
      op: 'diff-index',
      top,
      from,
      attributes,
    }),
    diffWorktree: (from, attributes) => readDiff({
      op: 'diff-worktree',
      top,
      from,
      attributes,
    }),
    filterConfig: async () => {
      const run = await read({ op: 'filter-config', top })
      if (run.over) throw overflow('filter-config')
      if (run.code === 1) return []
      if (run.code !== 0) throw gitFailure('filter-config', run)
      const keys = parseFilterKeys(run.stdout)
      if (keys === undefined) throw unreadable('filter-config')
      return keys
    },
    untracked: async () => {
      const run = await read({ op: 'untracked', top }, MAX_GIT_OUTPUT_BYTES)
      if (run.over) return undefined
      if (run.code !== 0) throw gitFailure('untracked', run)
      return splitNames(run.stdout)
    },
  }
}

const NO_WORK_TREE = 'runs inside a git work tree, and the working directory is in none: pipe a diff in instead'
const NOT_OURS = 'git refuses this repository, as another user owns it: add it to safe.directory if you trust it, or pipe a diff in'
const OTHER_WORK_TREE = 'the repository\'s work tree belongs to another repository or to none (core.worktree, GIT_WORK_TREE): run quorum in a clone you made'

/** The path an operation printed, which loses only its last line feed. */
async function readPath(context: GitContext, operation: GitOperation): Promise<string> {
  const run = await runGit(context, operation)
  if (run.over) throw overflow(operation.op)
  if (run.code !== 0) throw gitFailure(operation.op, run)
  return lineOf(run.stdout)
}

/**
 * Opens the repository the working directory is in, or refuses it with a `ConfigError` at `context.flag`.
 * The calls, in order: `--version`, which must read as 2.41 or later; then `toplevel`, `prefix` and `git-dir`
 * in `context.cwd`, which never enters a bare repository nested in the tree (`safe.bareRepository=explicit`
 * refuses it, and so does `toplevel` outside a work tree) and which names `safe.directory` when another user
 * owns the repository (`detected dubious ownership`, the only phrase of git's stderr that is read); then
 * `top-git-dir` and `object-format` with `-C <top>`. A `core.worktree` can name another repository's work
 * tree, which `-C <top>` would then enter and read instead, so the git directory is read from the working
 * directory and again from the top level, and the two must be the same: the later calls never land in
 * another repository. Each path git prints loses only its last line feed.
 */
export async function openRepository(context: GitContext): Promise<Repository> {
  const refusal = (message: string): ConfigError => new ConfigError([
    { path: context.flag, message },
  ])
  const version = await runGit(context, { op: 'version' })
  const named = VERSION.exec(lineOf(version.stdout))
  if (version.code !== 0 || version.over || named === null) throw refusal('could not read the version of git: pipe a diff in instead')
  const major = Number(named[1])
  const minor = Number(named[2])
  if (major < GIT_FLOOR.major || (major === GIT_FLOOR.major && minor < GIT_FLOOR.minor)) {
    throw refusal(`needs git ${GIT_FLOOR.major}.${GIT_FLOOR.minor} or later, and this git is ${major}.${minor}: upgrade it, or pipe a diff in`)
  }
  const toplevel = await runGit(context, { op: 'toplevel' })
  if (toplevel.code !== 0 || toplevel.over) {
    throw refusal(toplevel.stderr.includes('detected dubious ownership')
      ? NOT_OURS
      : NO_WORK_TREE)
  }
  const top = lineOf(toplevel.stdout)
  if (top === '') throw refusal(NO_WORK_TREE)
  const prefix = await readPath(context, { op: 'prefix' })
  const gitDir = await readPath(context, { op: 'git-dir' })
  const topGitDir = await runGit(context, { op: 'top-git-dir', top })
  if (gitDir === '' || topGitDir.code !== 0 || topGitDir.over || lineOf(topGitDir.stdout) !== gitDir) throw refusal(OTHER_WORK_TREE)
  const objectFormat = await readPath(context, { op: 'object-format', top })
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new GitError('git rev-parse printed an object format quorum does not read', 'rev-parse', 0)
  return repositoryOf(context, top, prefix, objectFormat)
}
