/**
 * Every read and write of a bench run directory, which holds `run.json` (written whole when the run begins,
 * and again when a re-score records the suite's new scoring hash), `results.jsonl` (one line per review,
 * appended one at a time), and the reports (`report.md` and `report.json`, rewritten whole). Both data
 * files are read as untrusted, since another run or a person may have written them: strict schemas (see
 * `records.ts`), bounded sizes, and no file that is not a regular file. No write follows a symbolic link:
 * `results.jsonl` is opened with `O_NOFOLLOW`, and every other file is written to a new file that is
 * renamed over the name, which replaces a link there. `run.json` and `results.jsonl` are made readable by
 * their owner only; the reports are made as any new file.
 *
 * Every message is fixed text, the name of a file and, for an I/O failure, the error's code; never the
 * runtime's own message. A directory or a file this run cannot trust as its own is a `ConfigError`; an
 * I/O failure is an `Error`.
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { decode, readBounded } from '../config/load.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { inertJson } from '../core/sanitize.ts'
import { MAX_RECORD_BYTES, MAX_RUN_FILE_BYTES, parseRecord, parseRunFile } from './records.ts'
import type { ReviewRecord, RunFile } from './records.ts'

export const RUN_FILE = 'run.json'
export const RESULTS_FILE = 'results.jsonl'
export const REPORT_MARKDOWN = 'report.md'
export const REPORT_JSON = 'report.json'

/** How the directory is named in an issue: by the flag that names it. */
const OUT = '--out'
/** How `runDifferences` words a configuration that was given no path. */
const DEFAULT_CONFIGURATION = '(default configuration)'
/** The bytes read from `results.jsonl` at a time. */
const CHUNK_BYTES = 64 * 1024
/** The byte that ends a line; no multi-byte UTF-8 sequence holds it. */
const LINE_FEED = 0x0A
/** An error code worth printing: `EACCES`, never text. */
const ERROR_CODE = /^E[A-Z]+$/
/** Whether the platform can refuse a symbolic link at the open itself. */
const HAS_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number'
const NO_FOLLOW = HAS_NOFOLLOW
  ? constants.O_NOFOLLOW
  : 0
/** Without blocking, so a FIFO is refused instead of waited for. */
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW
/** Without blocking too, so a FIFO swapped in after the read is refused instead of waited for. */
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK | NO_FOLLOW
const NEW_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
/** The mode `run.json` and `results.jsonl` are made with: read and written by their owner only. */
const OWNER_ONLY = 0o600
/** The name `writeAtomic` gives the temporary file of `run.json`, which a run killed while it wrote can leave. */
const LEFTOVER_RUN_FILE = /^\.run\.json\.[0-9a-f]{8}\.tmp$/
/** What `openRecords` says of a `results.jsonl` whose length is not the one the read found. */
const CHANGED = 'changed after this run read it, so another run may be using this --out: run one at a time'

/** What `--out` holds: nothing, an empty directory, or a run. */
export type RunState
  = | { readonly kind: 'none' }
    | { readonly kind: 'empty' }
    | { readonly kind: 'run', readonly run: RunFile }

/** What a read of `results.jsonl` found: the complete lines it visited, where they end, how long the file was, and whether bytes follow the last line break. */
export interface RecordsRead {
  readonly lines: number
  /** The length of the file up to and including the last line break. */
  readonly validBytes: number
  /** The length of the file the read found, its torn tail included: 0 for no file. */
  readonly bytes: number
  /** A last line with no line break: a run killed while it appended. It is not visited. */
  readonly torn: boolean
}

/** What the append needs of a read: where its last whole line ends, and the file's length as the read found it. */
export type ReadSizes = Pick<RecordsRead, 'validBytes' | 'bytes'>

/** Appends lines to `results.jsonl`, one at a time. */
export interface RecordWriter {
  readonly append: (line: string) => Promise<void>
  readonly close: () => Promise<void>
}

function refusal(path: string, message: string): ConfigError {
  return new ConfigError([
    { path, message },
  ])
}

/** The code of a failed system call, when it is one worth printing. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && ERROR_CODE.test(code)
    ? code
    : undefined
}

/** ` (EACCES)`, or nothing for an error without a code worth printing. */
function codeSuffix(error: unknown): string {
  const code = errorCode(error)
  return code === undefined
    ? ''
    : ` (${code})`
}

function ioFailure(file: string, what: string, error: unknown): Error {
  return new Error(`${file}: ${what}${codeSuffix(error)}`)
}

/**
 * Whether `directory` holds an entry, of any kind, whose name is not that of the temporary `run.json` a
 * killed run leaves: it reads entries until it finds one, and no more.
 */
async function holdsEntry(directory: string): Promise<boolean> {
  try {
    const entries = await opendir(directory)
    try {
      for (let entry = await entries.read(); entry !== null; entry = await entries.read()) {
        if (!LEFTOVER_RUN_FILE.test(entry.name)) return true
      }
      return false
    } finally {
      await entries.close().catch(() => undefined)
    }
  } catch (error) {
    throw ioFailure(OUT, 'cannot be read', error)
  }
}

/** `empty` for a directory with no `run.json` and no entry, the temporary `run.json` of a killed run aside; refused when it holds any other. */
async function emptyDirectory(directory: string): Promise<RunState> {
  if (await holdsEntry(directory)) throw refusal(OUT, `holds files but no ${RUN_FILE}, so it is not a run directory: name a new directory, or an empty one`)
  return { kind: 'empty' }
}

/**
 * What `directory`, the run directory a command was given, holds. A directory that does not exist is
 * `none`, an empty one `empty`, and one holding a `run.json` this quorum can read is that run. Refused,
 * as a `ConfigError`: a symbolic link, anything but a directory, a directory that holds files but no
 * `run.json` (the temporary `run.json` of a killed run aside, which counts as no file and is left where it
 * is), and a `run.json` that is a link, is not a file, is over 1 MiB, or is not a run file of this
 * format. The path is read as written, but for a trailing separator or `.`, which would follow a link;
 * its parents may be links: they are the user's own path.
 *
 * @throws ConfigError as above; Error when the directory or `run.json` cannot be read
 */
export async function inspectRunDir(directory: string): Promise<RunState> {
  // Resolved first: `lstat` follows a link when the path ends in a separator or a `.`.
  const location = resolve(directory)
  let stats: Stats
  try {
    stats = await lstat(location)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'none' }
    throw ioFailure(OUT, 'cannot be read', error)
  }
  if (stats.isSymbolicLink()) throw refusal(OUT, 'is a symbolic link')
  if (!stats.isDirectory()) throw refusal(OUT, 'is not a directory')
  const bytes = await readBounded(join(location, RUN_FILE), MAX_RUN_FILE_BYTES, '1 MiB', { noFollow: true })
  if ('problem' in bytes) {
    if (bytes.problem === 'does not exist') return emptyDirectory(location)
    throw bytes.problem === 'cannot be read'
      ? new Error(`${RUN_FILE}: cannot be read`)
      : refusal(RUN_FILE, bytes.problem)
  }
  const text = decode(bytes.value)
  const run = 'problem' in text
    ? undefined
    : parseRunFile(text.value)
  if (run === undefined) throw refusal(RUN_FILE, 'is not a run file this quorum writes')
  return { kind: 'run', run }
}

/**
 * What stops a run from resuming `recorded` as the run `current` describes, each an issue to print: the
 * quorum version first of all (a release can change a preset's defaults without changing a fingerprint,
 * which holds the preset by name), then another suite by its name, else a suite whose review hash changed
 * (its case ids, its trials or its patches), then each current configuration the run does not hold, at
 * `--config`, then each recorded one that is not given again. A changed scoring hash alone is no
 * difference: the run's records are scored again under the suite as it is now. A current and a recorded
 * configuration that share a path (`null`, the usual resolution, included) but not a fingerprint are one
 * configuration whose settings changed, and give one issue in place of the two. The same configurations in
 * another order are the same run. A configuration is named by its path as written, or
 * `(default configuration)`: the recorded paths are text from `run.json`, to make inert where they are
 * printed.
 */
export function runDifferences(recorded: RunFile, current: Pick<RunFile, 'quorum' | 'suite' | 'configurations'>): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (recorded.quorum !== current.quorum) {
    issues.push({ path: RUN_FILE, message: `was written by quorum ${recorded.quorum}, and this is quorum ${current.quorum}: a run belongs to one build, so name a new ${OUT}` })
  }
  if (recorded.suite.name !== current.suite.name) {
    issues.push({ path: RUN_FILE, message: `is a run of the suite ${recorded.suite.name}, not ${current.suite.name}: name a new ${OUT}` })
  } else if (recorded.suite.reviewHash !== current.suite.reviewHash) {
    issues.push({ path: RUN_FILE, message: `the suite's case ids, trials or patches changed since the run began: name a new ${OUT}` })
  }
  const recordedPrints = new Set(recorded.configurations.map(({ fingerprint }) => fingerprint))
  const currentPrints = new Set(current.configurations.map(({ fingerprint }) => fingerprint))
  const changed = new Set<string>()
  for (const { path, fingerprint } of current.configurations) {
    if (recordedPrints.has(fingerprint)) continue
    const name = path ?? DEFAULT_CONFIGURATION
    const before = recorded.configurations.find(entry => entry.path === path && !currentPrints.has(entry.fingerprint) && !changed.has(entry.fingerprint))
    if (before === undefined) {
      issues.push({ path: '--config', message: `${name} is not one of the run's configurations` })
    } else {
      changed.add(before.fingerprint)
      issues.push({ path: '--config', message: `the settings of ${name} changed since the run began: name a new ${OUT}` })
    }
  }
  for (const { path, fingerprint } of recorded.configurations) {
    if (!currentPrints.has(fingerprint) && !changed.has(fingerprint)) issues.push({ path: RUN_FILE, message: `its configuration ${path ?? DEFAULT_CONFIGURATION} is not given` })
  }
  return issues
}

/**
 * Write `run.json` into `directory` whole, through a new file and a rename, which replaces the file that
 * was there. `run.json` is readable by its owner only, so a looser mode its owner gave it is not kept.
 *
 * @throws Error `run.json: cannot be written (<code>)`
 */
export async function writeRunFile(directory: string, run: RunFile): Promise<void> {
  await writeAtomic(directory, RUN_FILE, `${inertJson(run)}\n`, OWNER_ONLY)
}

/**
 * Make `directory` and its parents, then write `run.json` into it (see `writeRunFile`).
 *
 * @throws Error `<directory>: cannot be created (<code>)`, or `run.json: cannot be written (<code>)`
 */
export async function createRun(directory: string, run: RunFile): Promise<void> {
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    throw ioFailure(directory, 'cannot be created', error)
  }
  await writeRunFile(directory, run)
}

/** `results.jsonl` opened to be read, or undefined when there is none; refused when it is a link or not a file. */
async function openResults(path: string): Promise<FileHandle | undefined> {
  let stats: Stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw ioFailure(RESULTS_FILE, 'cannot be read', error)
  }
  if (stats.isSymbolicLink()) throw refusal(RESULTS_FILE, 'is a symbolic link')
  if (!stats.isFile()) throw refusal(RESULTS_FILE, 'is not a file')
  try {
    return await open(path, READ_FLAGS)
  } catch (error) {
    throw errorCode(error) === 'ELOOP'
      ? refusal(RESULTS_FILE, 'is a symbolic link')
      : ioFailure(RESULTS_FILE, 'cannot be read', error)
  }
}

/** The line `bytes` holds, read as a record and handed to `visit`; a line that is none, or that `visit` refuses, is an issue. */
function visitLine(bytes: Uint8Array, line: number, visit: (record: ReviewRecord, line: number) => string | undefined): void {
  const text = decode(bytes)
  const record = 'problem' in text
    ? undefined
    : parseRecord(text.value)
  if (record === undefined) throw refusal(RESULTS_FILE, `line ${line} is not a record of this run`)
  const problem = visit(record, line)
  if (problem !== undefined) throw refusal(RESULTS_FILE, `line ${line} ${problem}`)
}

function tooLarge(line: number): ConfigError {
  return refusal(RESULTS_FILE, `line ${line} is over 16 MiB`)
}

/** Read into `chunk` from `position`; the number of bytes read, 0 at the end of the file. */
async function readInto(handle: FileHandle, chunk: Buffer, position: number): Promise<number> {
  try {
    return (await handle.read(chunk, 0, chunk.length, position)).bytesRead
  } catch (error) {
    throw ioFailure(RESULTS_FILE, 'cannot be read', error)
  }
}

/**
 * Read `results.jsonl` line by line and hand each record, with its line number from 1, to `visit`, which
 * returns the problem with a record it refuses, or undefined. A file with no `results.jsonl` holds
 * nothing. Bytes after the last line break are a line a run killed while it appended cut short: it is
 * reported as `torn`, never visited, and the next append must drop it (see `openRecords`). Any other line
 * that is no record, a line over 16 MiB (complete or not), a record `visit` refuses, a link and a file
 * that is none are refused. The file is read in chunks of 64 KiB and split on the line feed byte, and a
 * line over the limit is refused as soon as it is seen to pass it, so no line is read whole before it is
 * known to fit.
 *
 * @throws ConfigError as above; Error `results.jsonl: cannot be read (<code>)` when a read fails
 */
export async function readRecords(directory: string, visit: (record: ReviewRecord, line: number) => string | undefined): Promise<RecordsRead> {
  const handle = await openResults(join(directory, RESULTS_FILE))
  if (handle === undefined) {
    return {
      lines: 0,
      validBytes: 0,
      bytes: 0,
      torn: false,
    }
  }
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
    /** The copies of the bytes of the line in progress that earlier chunks held. */
    let pending: Buffer[] = []
    let pendingBytes = 0
    let lines = 0
    let validBytes = 0
    let position = 0
    for (;;) {
      const bytesRead = await readInto(handle, chunk, position)
      if (bytesRead === 0) break
      const view = chunk.subarray(0, bytesRead)
      let start = 0
      for (let end = view.indexOf(LINE_FEED); end !== -1; end = view.indexOf(LINE_FEED, start)) {
        lines += 1
        const piece = view.subarray(start, end)
        const length = pendingBytes + piece.length
        if (length > MAX_RECORD_BYTES) throw tooLarge(lines)
        visitLine(pending.length === 0
          ? piece
          : Buffer.concat([...pending, piece], length), lines, visit)
        pending = []
        pendingBytes = 0
        validBytes = position + end + 1
        start = end + 1
      }
      pendingBytes += view.length - start
      if (pendingBytes > MAX_RECORD_BYTES) throw tooLarge(lines + 1)
      if (start < view.length) pending.push(Buffer.from(view.subarray(start)))
      position += bytesRead
    }
    return {
      lines,
      validBytes,
      bytes: position,
      torn: pendingBytes > 0,
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function writeFailure(file: string, error: unknown): Error {
  return ioFailure(file, 'cannot be written', error)
}

/**
 * `results.jsonl` opened to be appended to, never through a symbolic link, never waiting for a FIFO, and
 * cut to `read.validBytes` when it ends in the torn tail the read found. A read that found no bytes opens
 * with `O_CREAT`: a new run's file, or an empty one deleted since, is made. A read that found bytes opens
 * without it, so a file deleted since is refused instead of made again, empty. Refused, with the handle
 * closed: what is not a regular file, a file that is gone or whose length is not `read.bytes`.
 */
async function openAppend(path: string, read: ReadSizes): Promise<FileHandle> {
  if (!HAS_NOFOLLOW && await lstat(path).then(stats => stats.isSymbolicLink(), () => false)) throw new Error(`${RESULTS_FILE}: cannot be written (ELOOP)`)
  const flags = read.bytes > 0
    ? APPEND_FLAGS
    : APPEND_FLAGS | constants.O_CREAT
  let handle: FileHandle
  try {
    handle = await open(path, flags, OWNER_ONLY)
  } catch (error) {
    // Under O_NONBLOCK a FIFO with no reader fails with ENXIO and a directory with EISDIR: no regular file.
    // Whatever else opens, a device or a FIFO with a reader, is refused by the stat below; any other
    // failure, such as a socket on macOS, is a write failure. Without O_CREAT, ENOENT is a file that was
    // there when the read found bytes in it, and is not now.
    const code = errorCode(error)
    if (code === 'ENOENT' && read.bytes > 0) throw refusal(RESULTS_FILE, CHANGED)
    throw code === 'ENXIO' || code === 'EISDIR'
      ? refusal(RESULTS_FILE, 'is not a file')
      : writeFailure(RESULTS_FILE, error)
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw refusal(RESULTS_FILE, 'is not a file')
    if (stats.size !== read.bytes) throw refusal(RESULTS_FILE, CHANGED)
    if (stats.size > read.validBytes) await handle.truncate(read.validBytes)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error instanceof ConfigError
      ? error
      : writeFailure(RESULTS_FILE, error)
  }
}

/**
 * Open `results.jsonl` to append to, and cut it to `read.validBytes` (what `readRecords` found valid),
 * which drops a line a killed run left unfinished. `read` is the answer of the `readRecords` this run
 * began with, or `{ validBytes: 0, bytes: 0 }` for a run that is new: the file must still be `read.bytes`
 * long, or another run may have cut it or appended to it since, and cutting it back would drop that run's
 * records. A read that found no bytes makes the file when it is not there, which loses nothing; one that
 * found bytes never makes it, so a file deleted since is refused with nothing written. `O_APPEND` puts
 * each write at the end, `O_NOFOLLOW` refuses a symbolic link, and `O_NONBLOCK` refuses a FIFO instead of
 * waiting for it. A file made here is readable by its owner only, and one that exists keeps its mode.
 * `append` writes one whole line, each call after the one before, so lines never interleave; once a write
 * has failed, none after it is written, so a line is never joined to the fragment of a failed one. `close`
 * waits for the lines asked for and closes.
 *
 * @throws ConfigError `results.jsonl: is not a file`, or `results.jsonl: changed after this run read it,
 * so another run may be using this --out: run one at a time` (a file cut, appended to or deleted since the
 * read); Error `results.jsonl: cannot be written (<code>)` for any other failure to open, cut, write or
 * close
 */
export async function openRecords(directory: string, read: ReadSizes): Promise<RecordWriter> {
  const handle = await openAppend(join(directory, RESULTS_FILE), read)
  let failed: Error | undefined
  let tail: Promise<void> = Promise.resolve()
  return {
    append: (line) => {
      const written = tail.then(async () => {
        if (failed !== undefined) throw failed
        try {
          await handle.appendFile(line)
        } catch (error) {
          failed = writeFailure(RESULTS_FILE, error)
          throw failed
        }
      })
      tail = written.catch(() => undefined)
      return written
    },
    close: async () => {
      await tail
      try {
        await handle.close()
      } catch (error) {
        throw writeFailure(RESULTS_FILE, error)
      }
    },
  }
}

/**
 * Write `text` as `name` in `directory` whole or not at all: to a new file `.<name>.<8 hex digits>.tmp`
 * made with `O_EXCL` (which never follows a link), written, synced and closed, then renamed over `name`.
 * The rename replaces a symbolic link at `name`, and never writes through it. The temporary file is made
 * with `mode`, which the rename keeps: Node's own default unless a caller asks for another. A failure
 * removes the temporary file it made.
 *
 * @throws Error `<name>: cannot be written (<code>)`
 */
export async function writeAtomic(directory: string, name: string, text: string, mode = 0o666): Promise<void> {
  const temporary = join(directory, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
  let made = false
  try {
    const handle = await open(temporary, NEW_FILE_FLAGS, mode)
    made = true
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, join(directory, name))
  } catch (error) {
    if (made) await unlink(temporary).catch(() => undefined)
    throw writeFailure(name, error)
  }
}
