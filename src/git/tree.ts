import { ConfigError } from '../core/errors.ts'
import type { ObjectFormat } from '../core/types.ts'
import { checkedId, GitError, gitFailure, joined, MAX_GIT_OUTPUT_BYTES, runGit } from './run.ts'
import type { Repository } from './run.ts'

/**
 * The tree reader: what a commit holds, and what its files say, by id. `listTree` lists the commit's entries
 * with `ls-tree -r -z --long`, so every size of an entry it keeps is known before any read and a kept object
 * the repository lacks is refused; `readBlobs` reads blobs through one `cat-file --batch`. Neither reads
 * the working tree, a `<rev>:<path>` or a pathspec: the only strings git is handed are ids this module has
 * checked.
 *
 * @see ../../docs/95-reference/40-architecture.md for where it sits in the layers.
 */

/** The modes a tracked entry has: a file, an executable, a link and a gitlink (a submodule's commit). */
export type TreeMode = '100644' | '100755' | '120000' | '160000'

/** One entry of a commit's tree. */
export interface TreeEntry {
  readonly mode: TreeMode
  readonly type: 'blob' | 'commit'
  /** The full id of the object: 40 lowercase hexadecimal characters in a sha1 repository, 64 in a sha256 one. */
  readonly id: string
  /** The size of the blob in bytes; undefined exactly for a gitlink, which names a commit of another repository. */
  readonly size: number | undefined
  /** The path as git printed it: bytes, not text, since a name can hold any byte but NUL. */
  readonly path: Uint8Array
}

const UNREADABLE = 'git ls-tree printed an entry quorum cannot read'
const UNSIZED = 'git ls-tree could not size an object the commit names: the repository lacks it, as a partial clone does'
const NOT_RETURNED = 'git cat-file did not return each listed blob at its listed size'

/** What of an entry comes before its tab. `BAD` is the size git prints for a blob it could not find. */
const HEADER = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]+) +(\d+|-|BAD)$/
/** The length of an id in each object format. */
const ID_LENGTH: Readonly<Record<ObjectFormat, number>> = { sha1: 40, sha256: 64 }
/** More than any header: a mode, a type, a 64-hex id, the size's padding and a size of up to 20 digits. */
const HEADER_BYTES = 128
const TAB = 0x09
const LINE_FEED = 0x0A

const unreadable = (): GitError => new GitError(UNREADABLE, 'ls-tree')

/** A record read: its entry, with its path a view of the record, and whether git could not size the blob (a size of `BAD`, which `entry` then leaves undefined). */
interface Listed {
  readonly entry: TreeEntry
  readonly unsized: boolean
}

/** The entry a record holds: every field is checked, whether or not the caller keeps the entry, and the id must be the length of `objectFormat`'s. */
function readRecord(record: Uint8Array, objectFormat: ObjectFormat): Listed {
  const tab = record.indexOf(TAB)
  if (tab === -1 || tab > HEADER_BYTES) throw unreadable()
  const fields = HEADER.exec(new TextDecoder().decode(record.subarray(0, tab)))
  if (fields === null) throw unreadable()
  const [, mode, type, id, size] = fields
  const gitlink = type === 'commit'
  const unsized = size === 'BAD' && !gitlink
  if (id.length !== ID_LENGTH[objectFormat] || gitlink !== (mode === '160000')) throw unreadable()
  if (!unsized && gitlink !== (size === '-')) throw unreadable()
  const bytes = gitlink || unsized
    ? undefined
    : Number(size)
  if (bytes !== undefined && !Number.isSafeInteger(bytes)) throw unreadable()
  return {
    entry: {
      mode: mode as TreeMode,
      type: gitlink
        ? 'commit'
        : 'blob',
      id,
      size: bytes,
      path: record.subarray(tab + 1),
    },
    unsized,
  }
}

/**
 * Reads `ls-tree -z` output chunk by chunk, every record checked in full. `feed` takes a chunk and says whether to go on, which it does
 * not once the kept paths pass `maxPathBytes`, or once a record has gone on that far past its header with no
 * NUL, which no kept path could end within; `end` hands over the kept entries when the output ended on a
 * whole record. Only a record cut by a chunk's end is held, and only what it needs: a kept path is copied
 * out of the chunk, so a long listing keeps nothing but the entries `keep` took.
 */
function listingReader(objectFormat: ObjectFormat, keep: (path: Uint8Array) => boolean, maxPathBytes: number): { feed: (chunk: Uint8Array) => boolean, end: () => TreeEntry[] } {
  const entries: TreeEntry[] = []
  const started: Uint8Array[] = []
  let startedBytes = 0
  let keptBytes = 0

  const take = (record: Uint8Array): boolean => {
    const { entry, unsized } = readRecord(record, objectFormat)
    if (!keep(entry.path)) return true
    if (unsized) throw new GitError(UNSIZED, 'ls-tree')
    keptBytes += entry.path.length
    if (keptBytes > maxPathBytes) return false
    entries.push({
      ...entry,
      path: new Uint8Array(entry.path),
    })
    return true
  }

  return {
    feed: (chunk) => {
      let from = 0
      for (let nul = chunk.indexOf(0); nul !== -1; nul = chunk.indexOf(0, from)) {
        const end = chunk.subarray(from, nul)
        const record = started.length === 0
          ? end
          : joined([...started, end], startedBytes + end.length)
        started.length = 0
        startedBytes = 0
        if (!take(record)) return false
        from = nul + 1
      }
      if (from < chunk.length) {
        started.push(new Uint8Array(chunk.subarray(from)))
        startedBytes += chunk.length - from
      }
      return startedBytes <= HEADER_BYTES + maxPathBytes
    },
    end: () => {
      if (started.length > 0) throw unreadable()
      return entries
    },
  }
}

/**
 * The entries of `commit`, an id, in git's order, one `ls-tree -r -z --long --full-tree`. The listing is
 * parsed as it streams and only the entries `keep` takes are held, each path as bytes, so a large tree costs
 * what its kept paths cost. Every record git prints is checked, kept or not, and a `GitError` follows for one
 * quorum cannot read (a mode, a type or a record it does not know, an id that is not the length of the
 * repository's object format, a gitlink with a size, a blob with none), and for a git that fails. A blob git
 * could not size, as a partial clone's missing one, is a `GitError` only when `keep` takes it: an entry the
 * caller does not read costs it nothing. `undefined` once the kept paths hold more than `maxPathBytes`, which
 * the child is then stopped for: no entry is a partial answer.
 */
export async function listTree(repository: Repository, commit: string, keep: (path: Uint8Array) => boolean, maxPathBytes: number = MAX_GIT_OUTPUT_BYTES): Promise<TreeEntry[] | undefined> {
  const reader = listingReader(repository.objectFormat, keep, maxPathBytes)
  const run = await runGit(repository.context, {
    op: 'list-tree',
    top: repository.top,
    commit,
  }, { onStdout: reader.feed })
  if (run.over) return undefined
  if (run.code !== 0) throw gitFailure('list-tree', run)
  return reader.end()
}

/**
 * The bytes of each of `entries`' blobs, in the entries' order, through one `cat-file --batch --buffer` whose
 * stdin is their ids. Each answer must be the header `<id> blob <size>`, the body of exactly that size and a
 * line feed: a missing object, another type, size or id, a short answer and a byte past the last are each a
 * `GitError`. The sizes are summed first, and a `ConfigError` at the run's flag comes before any spawn when
 * they pass `limit`. A gitlink, which names no blob, and an id that is not 40 or 64 lowercase hexadecimal
 * characters are a `RangeError`, also before any spawn. The blobs are views of one array.
 */
export async function readBlobs(repository: Repository, entries: readonly TreeEntry[], limit: number): Promise<Uint8Array[]> {
  const listed = entries.map((entry) => {
    if (entry.size === undefined) throw new RangeError('a gitlink names no blob to read')
    return {
      id: checkedId(entry.id),
      size: entry.size,
      header: `${entry.id} blob ${entry.size}\n`,
    }
  })
  const total = listed.reduce((sum, blob) => sum + blob.size, 0)
  if (total > limit) {
    throw new ConfigError([
      { path: repository.context.flag, message: `the files to read hold ${total} bytes, over the ${limit} a review reads` },
    ])
  }
  // Exactly what a faithful git prints, so one byte past it stops the child and fails closed below.
  const expected = listed.reduce((sum, blob) => sum + blob.header.length + blob.size + 1, 0)
  const run = await runGit(repository.context, { op: 'read-objects', top: repository.top }, {
    input: listed.map(blob => `${blob.id}\n`).join(''),
    maxStdout: expected,
  })
  if (run.over) throw new GitError(NOT_RETURNED, 'cat-file')
  if (run.code !== 0) throw gitFailure('read-objects', run)
  const decoder = new TextDecoder()
  const blobs: Uint8Array[] = []
  let at = 0
  for (const { header, size } of listed) {
    const bodyAt = at + header.length
    const end = bodyAt + size
    if (decoder.decode(run.stdout.subarray(at, bodyAt)) !== header || run.stdout[end] !== LINE_FEED) throw new GitError(NOT_RETURNED, 'cat-file')
    blobs.push(run.stdout.subarray(bodyAt, end))
    at = end + 1
  }
  return blobs
}
