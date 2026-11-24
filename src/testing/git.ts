/** Test helpers for the specs of the git runner and its sources: a fake `spawn` that answers each git call from a function, and records it. */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ObjectFormat } from '../core/types.ts'
import { GLOBAL_PINS } from '../git/run.ts'
import type { SpawnGit } from '../git/run.ts'

/** One spawn of git, as the fake saw it. */
export interface GitCall {
  /** The executable the spawn named. */
  readonly file: string
  /** Every argument, the pins first. */
  readonly args: readonly string[]
  /** The arguments after `GLOBAL_PINS` and any `-C <top>`: the operation's own. */
  readonly command: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** What the caller wrote to stdin, decoded; empty when it ignored stdin. */
  readonly stdin: string
}

/** What a fake git does with a call. `hang` leaves the child running, with whatever it printed, until it is killed. `stdout` is one read, or, as an array, one read per element, each on a turn of its own. */
export interface GitReply {
  readonly stdout?: string | Uint8Array | readonly (string | Uint8Array)[]
  readonly stderr?: string
  readonly code?: number
  readonly hang?: boolean
}

/** What `fakeGit` says of the repository it stands for, where the reply says nothing. */
export interface GitBase {
  readonly top?: string
  readonly prefix?: string
  readonly gitDir?: string
  readonly objectFormat?: ObjectFormat
  /** The whole line `git --version` prints, without its line feed. */
  readonly version?: string
}

const NOT_ANSWERED: GitReply = { code: 128, stderr: 'fatal: the fake git has no answer for this call\n' }

function bytesOf(text: string | Uint8Array | undefined): Uint8Array {
  if (text === undefined) return new Uint8Array(0)
  return typeof text === 'string'
    ? Buffer.from(text)
    : text
}

/** The reads a reply's stdout comes in: one for a string or bytes, one for each element of an array, none for an empty one. */
function readsOf(stdout: GitReply['stdout']): Uint8Array[] {
  const parts = stdout === undefined || typeof stdout === 'string' || stdout instanceof Uint8Array
    ? [stdout]
    : stdout
  return parts.map(bytesOf).filter(bytes => bytes.length > 0)
}

/** What the arguments after the pins say, with a leading `-C <top>` taken off. */
function commandOf(args: readonly string[]): readonly string[] {
  if (!GLOBAL_PINS.every((pin, index) => args[index] === pin)) return args
  const rest = args.slice(GLOBAL_PINS.length)
  return rest[0] === '-C'
    ? rest.slice(2)
    : rest
}

/** The repository's own answers: the version, the top level, the prefix, the git directory (asked in the working directory or in the top level) and the object format. */
function baseReply(command: readonly string[], base: GitBase): GitReply | undefined {
  const line = (text: string): GitReply => ({ stdout: `${text}\n` })
  if (command.length === 1 && command[0] === '--version') return line(base.version ?? 'git version 2.50.1')
  if (command[0] !== 'rev-parse' || command.length !== 2) return undefined
  switch (command[1]) {
    case '--show-toplevel':
      return line(base.top ?? '/repo')
    case '--show-prefix':
      return line(base.prefix ?? '')
    case '--absolute-git-dir':
      return line(base.gitDir ?? '/repo/.git')
    case '--show-object-format':
      return line(base.objectFormat ?? 'sha1')
    default:
      return undefined
  }
}

/**
 * A `spawn` for the git runner that starts nothing: each call is answered by `reply`, else by `base` (the
 * version `git version 2.50.1`, the top level `/repo`, an empty prefix, the git directory `/repo/.git` whichever
 * directory is asked, `sha1`), else it exits 128. A call is recorded once it is answered, which for a child with
 * a piped stdin is after the caller has ended it. A reply's stdout that is an array arrives in as many reads, the
 * first at once and each next one on a turn of its own, so a consumer sees the chunk boundaries it names. A reply
 * with `hang` leaves the child open until `kill`, which closes it at once with no exit code and the signal, and
 * leaves its pipes as they are, as a helper that held them would: the caller destroys them or they stay open.
 */
export function fakeGit(reply: (call: GitCall) => GitReply | undefined, base: GitBase = {}): { readonly spawn: SpawnGit, readonly calls: GitCall[] } {
  const calls: GitCall[] = []
  const spawn: SpawnGit = (file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const piped = Array.isArray(options.stdio) && options.stdio[0] === 'pipe'
    const emitter = new EventEmitter()
    const stdout = new Readable({
      read() {},
    })
    const stderr = new Readable({
      read() {},
    })
    let closed = false
    const closeWith = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) return
      closed = true
      setImmediate(() => {
        emitter.emit('exit', code, signal)
        emitter.emit('close', code, signal)
      })
    }
    const received: Buffer[] = []
    const answer = (stdin: string): void => {
      const call: GitCall = {
        file,
        args: [...args],
        command: commandOf(args),
        cwd: String(options.cwd),
        env: { ...options.env } as Record<string, string>,
        stdin,
      }
      calls.push(call)
      const answered = reply(call) ?? baseReply(call.command, base) ?? NOT_ANSWERED
      const reads = readsOf(answered.stdout)
      const err = bytesOf(answered.stderr)
      const end = (): void => {
        if (err.length > 0 && !closed) stderr.push(err)
        if (answered.hang === true || closed) return
        stdout.push(null)
        stderr.push(null)
        const finished = (stream: Readable): Promise<void> => new Promise((resolve) => {
          stream.once('end', resolve)
          stream.once('close', resolve)
        })
        void Promise.all([
          finished(stdout),
          finished(stderr),
        ]).then(() => closeWith(answered.code ?? 0, null))
      }
      const deliver = (at: number): void => {
        if (closed) return
        if (at < reads.length) stdout.push(reads[at])
        if (at + 1 < reads.length) setImmediate(() => deliver(at + 1))
        else end()
      }
      deliver(0)
    }
    const stdin = piped
      ? new Writable({
          write(chunk: Buffer, _encoding, done) {
            received.push(chunk)
            done()
          },
          final(done) {
            done()
            setImmediate(() => answer(Buffer.concat(received).toString('utf8')))
          },
        })
      : null
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid: 4242,
      killed: false,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
        if (closed) return false
        child.killed = true
        child.signalCode = typeof signal === 'string'
          ? signal
          : 'SIGTERM'
        closeWith(null, child.signalCode)
        return true
      },
    })
    process.nextTick(() => emitter.emit('spawn'))
    if (!piped) setImmediate(() => answer(''))
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

/** One file of the tree a fake commit holds: its path, its content (a string, or bytes for a binary file), and the mode it is listed with, `100644` by default. */
export interface TreeFile {
  readonly path: string
  readonly content?: string | Uint8Array
  readonly mode?: '100644' | '100755' | '120000' | '160000'
}

/**
 * The replies of a fake git whose every commit holds `files`: `ls-tree` lists them as `git ls-tree -r -z --long` prints them
 * (a gitlink with no size) and `cat-file --batch` gives the blob of each id asked, as `git cat-file --batch` prints it. Any other
 * call is left to the caller's own reply, so a spec adds the replies it needs around it. A file's id is its position, in
 * hexadecimal, padded to 40 digits.
 */
export function treeReply(files: readonly TreeFile[]): (call: GitCall) => GitReply | undefined {
  const encoder = new TextEncoder()
  const entries = files.map((file, index) => ({
    path: file.path,
    mode: file.mode ?? '100644',
    id: (index + 1).toString(16).padStart(40, '0'),
    body: typeof file.content === 'string'
      ? encoder.encode(file.content)
      : file.content ?? new Uint8Array(0),
  }))
  return ({ command, stdin }) => {
    if (command[0] === 'ls-tree') {
      return {
        stdout: entries.map(({ path, mode, id, body }) => mode === '160000'
          ? `${mode} commit ${id} ${'-'.padStart(7)}\t${path}\0`
          : `${mode} blob ${id} ${String(body.length).padStart(7)}\t${path}\0`).join(''),
      }
    }
    if (command[0] !== 'cat-file') return undefined
    const blobs = stdin.split('\n').filter(id => id !== '').flatMap((id) => {
      const entry = entries.find(candidate => candidate.id === id)
      return entry === undefined
        ? []
        : [
            encoder.encode(`${id} blob ${entry.body.length}\n`),
            entry.body,
            encoder.encode('\n'),
          ]
    })
    return { stdout: blobs }
  }
}
