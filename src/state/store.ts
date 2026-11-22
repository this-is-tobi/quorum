/**
 * The file store behind `--state <dir>`: every answered call of a review, kept as one file, so a rerun of a review that
 * failed late pays for none of what it already bought. It implements `ReplyStore` (core/ports.ts) and is the one
 * place that reads or writes the state directory; the core never imports it.
 *
 * What a directory must be, refused before any call as a `ConfigError` at `--state` (exit 2) that names the flag and
 * never the path. Whoever writes the directory writes a part's review: a stored reply is read as the provider's own
 * answer, and a stored marker sends a part to recovery. The refusals are the guard, and each has its reason:
 * - a symbolic link, which would write wherever it points, and a file that is no directory;
 * - one another user owns, and one whose group or others may write: they could plant a reply (neither check applies
 *   on Windows, where the docs say to keep the directory in the user's profile);
 * - one whose real path, or any parent's, holds a `.git` entry (a directory, or the file a worktree has): it is
 *   inside a git work tree, and a pull request writes its checkout, so it could plant a stored reply there;
 * - one that holds files but no marker, or a marker quorum did not write: a directory of something else, which
 *   is named, never emptied or written into (the temporary marker of a first open that was killed counts as no
 *   file, and is left where it is). A missing directory is made with mode 0700 and the marker
 *   `quorum-state.json`, and an empty one is given the marker.
 *
 * The key has two layers. The core hashes the logical request, never its bytes, with the reply budget and the
 * thinking level and mode it was sent with (see `callProvider`); this store hashes that with quorum's version and the
 * provider's identity (`identities`, by provider id: the bench's form of the provider less its `timeoutMs` and `retries`, which can hold a
 * secret and so only ever enters a hash), so a changed diff, prompt, budget, provider or version is another entry, a miss.
 * An entry is `<sha256 of [version, identity, key]>.json`, a strict JSON object read with `readBounded` and `noFollow`
 * under 8 MiB (above what a reply of 1 000 000 characters takes as escaped JSON), and written whole through `writeAtomic`
 * at mode 0600. A provider the identities do not name has no entry: nothing is read or written for it. Anything
 * that is no entry, or holds another key, is a miss with one warning line, once per store and reason, and a write
 * that fails is one warning line and no failure: a review's verdict owes nothing to the store.
 *
 * `parents: true` makes the missing parents of the directory too, each with mode 0700, for the default directory in the
 * user's cache (`default.ts`), whose parents may not exist yet. The work-tree check runs on the nearest parent that
 * exists before any is made, so nothing is made inside a work tree. `discard()` removes the directory and what it holds
 * once the review it serves needs no rerun, and a failure to is one warning line and no failure.
 *
 * The directory is never pruned: it grows by one file for each distinct request, so it is removed once the review it
 * serves is done, and never restored from a cache another job can write.
 */

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { decode, errorCode, readBounded, writeAtomic } from '../config/load.ts'
import { ConfigError } from '../core/errors.ts'
import type { ReplyStore, StoredCall } from '../core/ports.ts'
import { usageSchema } from '../core/result-schema.ts'

/** How the directory is named in an issue: by the flag that names it, never by its path. */
const FLAG = '--state'
/** The file that says the directory is one quorum made. */
const MARKER_FILE = 'quorum-state.json'
/** The name `writeAtomic` gives the temporary marker, which a first open killed while it wrote can leave. */
const LEFTOVER_MARKER_FILE = /^\.quorum-state\.json\.[0-9a-f]{8}\.tmp$/
/** What the marker holds. */
const MARKER_TEXT = '{"quorum":"state","version":1}'
/** The most a marker may hold: it is a line. */
const MAX_MARKER_BYTES = 1024
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
/** The most an entry may hold, above what a reply of `MAX_TEXT` characters takes as escaped JSON. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
/** The most characters of a stored reply's text. */
const MAX_TEXT = 1_000_000
/** The most characters of the model a stored reply reports. */
const MAX_MODEL = 256
/** The most characters of a key. */
const MAX_KEY = 1024
const IN_WORK_TREE = 'lies inside a git work tree, which a change could write to: name a directory outside every repository'

const entrySchema = z.union([
  z.strictObject({
    version: z.literal(1),
    key: z.string().max(MAX_KEY),
    reply: z.strictObject({
      text: z.string().max(MAX_TEXT),
      model: z.string().max(MAX_MODEL),
      usage: usageSchema.optional(),
    }),
  }),
  z.strictObject({
    version: z.literal(1),
    key: z.string().max(MAX_KEY),
    lacked: z.strictObject({
      noAnswer: z.enum([
        'reply',
        'thinking',
        'window',
        'saturated',
      ]),
      usage: usageSchema.optional(),
    }),
  }),
])

/** What a state directory is opened with. */
export interface FileStoreOptions {
  /** The identity of each provider, by the provider's id: what makes two providers' calls different entries. A provider it does not name has no entry. */
  readonly identities: ReadonlyMap<string, string>
  /** The version of quorum, which makes another release's entries misses. */
  readonly version: string
  /** The user id that must own the directory, when the platform has one; none is checked when unset. */
  readonly owner?: number
  /** The platform, `process.platform`: on `win32` the owner and mode checks are skipped. */
  readonly platform: string
  /** Makes the directory's missing parents too, each with mode 0700, after the work-tree check of the nearest one that exists; a missing parent refuses the directory when unset. */
  readonly parents?: true
  /** Receives each warning, one line, once per store and reason; none when unset. */
  readonly warn?: (line: string) => void
}

function refusal(message: string): ConfigError {
  return new ConfigError([
    { path: FLAG, message },
  ])
}

/** The code of a failed system call: the error's own, or the one a `WriteFailure` names at the end of its message. */
function codeOf(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message
  return errorCode(error) ?? (typeof message === 'string'
    ? /\((E[A-Z]+)\)$/.exec(message)?.[1]
    : undefined)
}

/** `message`, with ` (<code>)` for a failure that has a code worth printing. */
function withCode(message: string, error: unknown): string {
  const code = codeOf(error)
  return code === undefined
    ? message
    : `${message} (${code})`
}

/** The `lstat` of `path`, or undefined when nothing is there; any other failure refuses the directory, as it cannot be read. */
async function look(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw refusal(withCode('cannot be read', error))
  }
}

/** Whether `start`, or a directory above it, holds a `.git` entry, whatever it is: a directory, or the file a worktree has. */
async function insideWorkTree(start: string): Promise<boolean> {
  for (let at = start; ; at = dirname(at)) {
    if (await look(join(at, '.git')) !== undefined) return true
    if (dirname(at) === at) return false
  }
}

/** The directory's real path, or the refusal that it cannot be read. */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw refusal(withCode('cannot be read', error))
  }
}

/** The nearest of `start` and its ancestors that exists, which is the root at the latest. */
async function nearestExisting(start: string): Promise<string> {
  let at = start
  while (await look(at) === undefined && dirname(at) !== at) at = dirname(at)
  return at
}

/** Makes the directory with its marker's place, mode 0700, when it is not there; its parent must be there, or be made with `parents`, and be outside every work tree. */
async function make(location: string, parents: boolean): Promise<void> {
  const nearest = parents
    ? await nearestExisting(dirname(location))
    : dirname(location)
  const parent = await realpath(nearest).catch((error: unknown) => {
    throw refusal(withCode('cannot be created', error))
  })
  // The first check: nothing is made inside a work tree. The second, in `prepare`, refuses a directory that already exists there.
  if (await insideWorkTree(parent)) throw refusal(IN_WORK_TREE)
  await mkdir(location, { mode: DIRECTORY_MODE, recursive: parents }).catch((error: unknown) => {
    throw refusal(withCode('cannot be created', error))
  })
}

/**
 * Checks the directory, making it when it is missing, and gives it its marker when it is empty.
 *
 * @throws ConfigError at `--state`: `is a symbolic link`, `is not a directory`, `is owned by another user`, `can be written
 * by its group or by others: chmod 700 it`, the work tree, the foreign directory, the foreign marker, or `cannot be created`
 * or `cannot be read` with the error's code
 */
async function prepare(location: string, options: FileStoreOptions): Promise<void> {
  let found = await look(location)
  if (found === undefined) {
    await make(location, options.parents === true)
    found = await look(location)
    if (found === undefined) throw refusal('cannot be created')
  }
  if (found.isSymbolicLink()) throw refusal('is a symbolic link')
  if (!found.isDirectory()) throw refusal('is not a directory')
  if (options.platform !== 'win32') {
    if (options.owner !== undefined && found.uid !== options.owner) throw refusal('is owned by another user')
    if ((found.mode & 0o022) !== 0) throw refusal('can be written by its group or by others: chmod 700 it')
  }
  // The second check: an existing directory in a work tree, which `make` never saw, is refused even with quorum's own marker.
  if (await insideWorkTree(await realPathOf(location))) throw refusal(IN_WORK_TREE)
  const names = await readdir(location).catch((error: unknown) => {
    throw refusal(withCode('cannot be read', error))
  })
  if (names.includes(MARKER_FILE)) {
    const read = await readBounded(join(location, MARKER_FILE), MAX_MARKER_BYTES, '1 KiB', { noFollow: true })
    const text = 'problem' in read
      ? read
      : decode(read.value)
    if ('problem' in text || text.value.trim() !== MARKER_TEXT) throw refusal(`holds a ${MARKER_FILE} quorum did not write`)
    return
  }
  // The temporary marker a first open killed before its rename leaves counts as no file, as for a run directory.
  if (names.some(name => !LEFTOVER_MARKER_FILE.test(name))) throw refusal(`holds files but no ${MARKER_FILE}, so it is not a state directory quorum made: name an empty or new directory`)
  await writeAtomic(location, MARKER_FILE, MARKER_TEXT, { mode: FILE_MODE, label: FLAG }).catch((error: unknown) => {
    throw refusal(withCode('cannot be created', error))
  })
}

/** A `ReplyStore` that also says how many calls it kept: the distinct entries it wrote, or read back as a stored call, since it was opened. */
export interface FileStore extends ReplyStore {
  readonly kept: () => number
  /** Removes the directory and what it holds; a failure is one warning line, once, and no throw. */
  readonly discard: () => Promise<void>
}

/**
 * Opens the state directory `directory` as a `FileStore`, making and checking it as the module's comment says: a
 * relative path is resolved against the working directory of the process. `kept()` counts the entries this run wrote
 * or read back as a stored call, each once, by its file: a count, never a name or the directory. A read-back entry is
 * counted when it is read, before the core checks it, so a stored reply the review then refuses is counted too, which
 * only a tampered directory shows.
 *
 * @throws ConfigError at `--state` for a directory that is refused, and never a message that holds its path
 */
export async function openFileStore(directory: string, options: FileStoreOptions): Promise<FileStore> {
  const location = resolve(directory)
  await prepare(location, options)
  const said = new Set<string>()
  const kept = new Set<string>()
  const warn = (reason: string, line: string): void => {
    if (said.has(reason)) return
    said.add(reason)
    options.warn?.(line)
  }
  const unread = (reason: string): void => warn(`read ${reason}`, `--state: a stored reply could not be read (${reason}): the call is made again`)
  const unsaved = (code: string): void => warn(`write ${code}`, `--state: a reply could not be saved (${code}): the review goes on without saving it`)
  /** The name of the file of an entry, or undefined for a provider no identity names. */
  const nameOf = (provider: string, key: string): string | undefined => {
    const identity = options.identities.get(provider)
    return identity === undefined
      ? undefined
      : `${createHash('sha256').update(JSON.stringify([options.version, identity, key])).digest('hex')}.json`
  }
  return {
    get: async ({ key, provider }) => {
      const name = nameOf(provider, key)
      if (name === undefined) return undefined
      try {
        const read = await readBounded(join(location, name), MAX_ENTRY_BYTES, '8 MiB', { noFollow: true })
        if ('problem' in read) {
          // An entry that is not there is the ordinary miss: no line.
          if (read.problem !== 'does not exist') unread(read.problem)
          return undefined
        }
        const entry = parseEntry(read.value)
        if (entry === undefined) {
          unread('is not a stored reply')
          return undefined
        }
        if (entry.key !== key) {
          unread('holds another key')
          return undefined
        }
        const call = callOf(entry)
        kept.add(name)
        return call
      } catch {
        unread('cannot be read')
        return undefined
      }
    },
    put: async ({ key, provider }, call) => {
      const name = nameOf(provider, key)
      if (name === undefined) return
      try {
        const entry = { version: 1, key, ...call }
        // A reply this store would refuse to read is not written: it is too large for an entry.
        if (!entrySchema.safeParse(entry).success) {
          unsaved('EFBIG')
          return
        }
        await writeAtomic(location, name, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE, label: FLAG })
        kept.add(name)
      } catch (error) {
        unsaved(codeOf(error) ?? 'unknown')
      }
    },
    kept: () => kept.size,
    discard: async () => {
      try {
        await rm(location, { recursive: true, force: true })
      } catch (error) {
        const code = codeOf(error) ?? 'unknown'
        warn(`discard ${code}`, `--state: the default state directory could not be removed (${code})`)
      }
    },
  }
}

/** The entry `bytes` hold, when they are JSON that passes the schema. */
function parseEntry(bytes: Uint8Array): z.infer<typeof entrySchema> | undefined {
  const text = decode(bytes)
  if ('problem' in text) return undefined
  try {
    const parsed = entrySchema.safeParse(JSON.parse(text.value))
    return parsed.success
      ? parsed.data
      : undefined
  } catch {
    return undefined
  }
}

/** The call an entry holds. */
function callOf(entry: z.infer<typeof entrySchema>): StoredCall {
  if ('lacked' in entry) {
    const { noAnswer, usage } = entry.lacked
    return {
      lacked: {
        noAnswer,
        ...usage === undefined
          ? {}
          : { usage },
      },
    }
  }
  const { text, model, usage } = entry.reply
  return {
    reply: {
      text,
      model,
      ...usage === undefined
        ? {}
        : { usage },
    },
  }
}
