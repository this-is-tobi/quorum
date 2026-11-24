import { decode } from '../config/load.ts'
import type { RepositoryEntry, ResolvedProfile } from '../config/profiles.ts'
import { bytesOf, capProblem, contextTotalIssues, DOCUMENT_READ_LIMIT, documentSha256, profileTexts, quotedPath, UNSETTLED } from '../core/documents.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { cleanProse } from '../core/sanitize.ts'
import type { ReviewDocument } from '../core/types.ts'
import { GitError } from '../git/run.ts'
import type { Repository } from '../git/run.ts'
import { listTree, readBlobs } from '../git/tree.ts'
import type { TreeEntry } from '../git/tree.ts'

/** The bytes git itself looks through for a NUL before it calls a file binary. */
const NUL_PROBE_BYTES = 8000

/** A listed path as text: a path that is no UTF-8 is none a config can name, and a byte-order mark is a character of a name, never dropped. */
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const LENIENT = new TextDecoder('utf-8', { ignoreBOM: true })

/** One `{ repository }` entry, with the profile that holds it. */
interface Named {
  readonly profile: ResolvedProfile
  readonly entry: RepositoryEntry
}

/**
 * Where an entry stands as it is read: refused with its problem, absent while optional, listed as a file to read, read to a
 * text, or made a document (the last two once the blobs are read). A refused entry says why, every refusal at once.
 */
type Slot
  = | { readonly problem: string }
    | { readonly absent: true }
    | { readonly listed: TreeEntry }
    | { readonly text: string }
    | { readonly document: ReviewDocument }

function pathOf(bytes: Uint8Array): string | undefined {
  try {
    return STRICT.decode(bytes)
  } catch {
    return undefined
  }
}

/** The slot of an entry once the tree is listed: its listing if it is a file quorum reads (the size is the listing's, so a blob over the limit is refused before it is read), absent when optional, else its problem. */
function listedSlot({ entry }: Named, listed: TreeEntry | undefined, short: string): Slot {
  const name = quotedPath(entry.path)
  if (listed === undefined) {
    return entry.optional
      ? { absent: true }
      : { problem: `${name} is not a file of the commit ${short} the review reads it from` }
  }
  if (listed.mode === '120000') return { problem: `${name} is a symbolic link at ${short}, which quorum does not follow` }
  if (listed.mode === '160000' || listed.size === undefined) return { problem: `${name} is a submodule's commit at ${short}, which quorum does not read` }
  return listed.size > DOCUMENT_READ_LIMIT
    ? { problem: `${name} holds ${listed.size} bytes at ${short}, over the ${DOCUMENT_READ_LIMIT / 1024} KiB quorum reads of a document` }
    : { listed }
}

/** The slot of an entry whose blob is read: its text, or no text when a NUL is in the blob's first 8000 bytes (git's own test) or it does not decode as UTF-8. */
function textSlot({ entry }: Named, bytes: Uint8Array, short: string): Slot {
  const text = bytes.subarray(0, NUL_PROBE_BYTES).includes(0)
    ? undefined
    : decode(bytes)
  return text !== undefined && 'value' in text
    ? { text: text.value }
    : { problem: `${quotedPath(entry.path)} is not UTF-8 text at ${short}` }
}

/** The slot of an entry whose text is read: the document, cleaned as the core cleans one, or the problem that keeps it from being sent: a text the cleaner cannot settle, or one over its kind's cap. */
function documentSlot({ profile, entry }: Named, text: string, commit: string): Slot {
  const cleaned = cleanProse(text)
  const problem = cleaned.settled
    ? capProblem(entry.kind, bytesOf(cleaned.text))
    : UNSETTLED
  const short = commit.slice(0, 7)
  return problem === undefined
    ? {
        document: Object.freeze({
          profile: profile.profile.id,
          kind: entry.kind,
          origin: Object.freeze({
            kind: 'repository' as const,
            path: entry.path,
            commit,
            sha256: documentSha256(text),
          }),
          text: cleaned.text,
          removed: Object.freeze(cleaned.removed),
        }),
      }
    : { problem: `${quotedPath(entry.path)} at ${short} ${problem}` }
}

/**
 * The documents a review reads from the repository, for the `{ repository }` entries of its profiles, in the order of `entries`.
 * `commit` is the commit the review's source reads documents from, and nothing is read from the working tree or the change
 * under review: one listing of that commit's tree (`listTree`) keeps the named paths, matched as bytes and never handed to git,
 * and one read of the blobs (`readBlobs`) gives the text of every file quorum reads. Each text is decoded, cleaned as the core
 * cleans a document (what the cleaner removed is kept, and the SHA-256 is of the text as read) and checked against its kind's
 * cap, and then, per profile, against the cap of all of them, counting the profile's own texts and its `{ file }` documents first.
 * An optional entry whose path holds no file is a document with no text, recorded as missing.
 *
 * An entry is refused, each at its `at` and all at once, for a path that is no file of the commit (a directory too, unless the
 * entry is optional), a symbolic link or a submodule's commit (even when optional), a file over 64 KiB (refused before it is read),
 * a text that does not decode as UTF-8 or holds a NUL in its first 8000 bytes, one the cleaner cannot settle, and one over a cap.
 * No message holds a document's text.
 *
 * @throws ConfigError with an issue for each entry that is refused
 * @throws GitError when git cannot list the tree or read the blobs
 */
export async function readRepositoryDocuments(entries: readonly Named[], repository: Repository, commit: string): Promise<ReviewDocument[]> {
  if (entries.length === 0) return []
  const short = commit.slice(0, 7)
  const wanted = new Set(entries.map(({ entry }) => entry.path))
  const listing = await listTree(repository, commit, (path) => {
    const name = pathOf(path)
    return name !== undefined && wanted.has(name)
  })
  if (listing === undefined) throw new GitError('git ls-tree printed more file names than quorum reads', 'ls-tree')
  const listed = new Map(listing.map(found => [
    LENIENT.decode(found.path),
    found,
  ]))
  const slots: Slot[] = entries.map(named => listedSlot(named, listed.get(named.entry.path), short))

  const toRead = [
    ...new Set(slots.flatMap(slot => 'listed' in slot
      ? [slot.listed]
      : [])),
  ]
  const blobs = toRead.length === 0
    ? []
    : await readBlobs(repository, toRead, toRead.length * DOCUMENT_READ_LIMIT)
  const bytes = new Map(toRead.map((found, at) => [found, blobs[at]]))
  for (const [index, slot] of slots.entries()) {
    if ('listed' in slot) slots[index] = textSlot(entries[index], bytes.get(slot.listed) as Uint8Array, short)
  }
  for (const [index, slot] of slots.entries()) {
    if ('text' in slot) slots[index] = documentSlot(entries[index], slot.text, commit)
  }

  // The caps of all of a profile's documents of a kind, its own texts and its `{ file }` documents counted first: the first document over them is refused.
  for (const profile of new Set(entries.map(named => named.profile))) {
    const own = entries.flatMap((named, index) => {
      const slot = slots[index]
      return named.profile === profile && 'document' in slot
        ? [
            { index, document: slot.document },
          ]
        : []
    })
    // `contextTotalIssues` names each document by its index, at `context.documents.<index>`.
    for (const { path, message } of contextTotalIssues(profileTexts(profile.profile, ''), own)) {
      const index = Number(path.slice('context.documents.'.length))
      slots[index] = { problem: `${quotedPath(entries[index].entry.path)} at ${short} ${message}` }
    }
  }

  const issues: ConfigIssue[] = entries.flatMap(({ entry }, index) => {
    const slot = slots[index]
    return 'problem' in slot
      ? [
          { path: entry.at, message: slot.problem },
        ]
      : []
  })
  if (issues.length > 0) throw new ConfigError(issues)
  return entries.map(({ profile, entry }, index) => {
    const slot = slots[index]
    return 'document' in slot
      ? slot.document
      : Object.freeze({
          profile: profile.profile.id,
          kind: entry.kind,
          origin: Object.freeze({ kind: 'repository' as const, path: entry.path, commit }),
        })
  })
}
