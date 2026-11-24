import { decode, parseRules, rulePlace, RULES_EXTENSION, rulesFormat } from '../config/parse.ts'
import type { RepositoryEntry, ResolvedProfile } from '../config/profiles.ts'
import { bytesOf, capProblem, contextTotalIssues, DOCUMENT_READ_LIMIT, documentSha256, profileTexts, quotedPath, UNSETTLED } from '../core/documents.ts'
import type { ProseKind } from '../core/documents.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { cleanedRules, ruleIssues, ruleTextBytes } from '../core/rules.ts'
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

/** An entry that names a prose document, guidelines or do-not-report text, and not a rules file. */
type ProseNamed = Named & { readonly entry: { readonly kind: ProseKind } }

function isProse(named: Named): named is ProseNamed {
  return named.entry.kind !== 'rules'
}

/**
 * Where an entry stands as it is read: refused with its problems (one, or every rule a rules file holds that is not valid),
 * absent while optional, listed as a file to read, read to a text, or made a document (the last two once the blobs are read). A
 * refused entry says why, every refusal at once.
 */
type Slot
  = | { readonly problems: readonly string[] }
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

/** The slot of an entry that is refused for one problem. */
function refused(problem: string): Slot {
  return {
    problems: [problem],
  }
}

/**
 * The slot of an entry once the tree is listed: its listing if it is a file quorum reads (the size is the listing's, so a blob over
 * the limit is refused before it is read), absent when optional, else its problem. A rules file whose extension names no format
 * is refused first, present or not, since no read could make it rules.
 */
function listedSlot({ entry }: Named, listed: TreeEntry | undefined, short: string): Slot {
  const name = quotedPath(entry.path)
  if (entry.kind === 'rules' && rulesFormat(entry.path) === undefined) return refused(`${name} at ${short} ${RULES_EXTENSION}`)
  if (listed === undefined) {
    return entry.optional
      ? { absent: true }
      : refused(`${name} is not a file of the commit ${short} the review reads it from`)
  }
  if (listed.mode === '120000') return refused(`${name} is a symbolic link at ${short}, which quorum does not follow`)
  if (listed.mode === '160000' || listed.size === undefined) return refused(`${name} is a submodule's commit at ${short}, which quorum does not read`)
  return listed.size > DOCUMENT_READ_LIMIT
    ? refused(`${name} holds ${listed.size} bytes at ${short}, over the ${DOCUMENT_READ_LIMIT / 1024} KiB quorum reads of a document`)
    : { listed }
}

/** The slot of an entry whose blob is read: its text, or no text when a NUL is in the blob's first 8000 bytes (git's own test) or it does not decode as UTF-8. */
function textSlot({ entry }: Named, bytes: Uint8Array, short: string): Slot {
  const text = bytes.subarray(0, NUL_PROBE_BYTES).includes(0)
    ? undefined
    : decode(bytes)
  return text !== undefined && 'value' in text
    ? { text: text.value }
    : refused(`${quotedPath(entry.path)} is not UTF-8 text at ${short}`)
}

/**
 * The slot of an entry whose text is a rules file's: the document, its rules parsed by the extension of the path, checked one by
 * one (`ruleIssues`: the id's pattern, the text's length once cleaned, the patterns, and the 100 rules and 32 KiB of cleaned texts
 * a file may hold alone, counted from `held`, the bytes of rule text the profile holds before the file) and cleaned, or every
 * problem that keeps it from being sent, in the file's own words, after its path and the commit's first 7 characters. What the
 * file takes the profile's rules to, with the ids the profile already holds, is the caps across origins, which
 * `readRepositoryDocuments` checks once every document is read.
 */
function rulesSlot({ profile, entry }: Named, text: string, commit: string, held: number): Slot {
  const place = `${quotedPath(entry.path)} at ${commit.slice(0, 7)} `
  // `listedSlot` refused every path whose extension names no format.
  const parsed = parseRules(text, rulesFormat(entry.path) as 'yaml' | 'json')
  if ('problem' in parsed) return refused(`${place}${parsed.problem}`)
  const found = ruleIssues(parsed.value, 'rules', held)
  if (found.length > 0) {
    return {
      problems: found.map((issue) => {
        const { place: rule, field } = rulePlace(issue)
        return rule === undefined || field.length === 0
          ? `${place}${issue.message}`
          : `${place}${rule}.${field.join('.')} ${issue.message}`
      }),
    }
  }
  const cleaned = cleanedRules(parsed.value)
  return {
    document: Object.freeze({
      profile: profile.profile.id,
      kind: 'rules' as const,
      origin: Object.freeze({
        kind: 'repository' as const,
        path: entry.path,
        commit,
        sha256: documentSha256(text),
      }),
      rules: cleaned.rules,
      removed: Object.freeze(cleaned.removed),
    }),
  }
}

/** The slot of an entry whose text is read: the document, cleaned as the core cleans one, or the problem that keeps it from being sent: a text the cleaner cannot settle, or one over its kind's cap. */
function documentSlot({ profile, entry }: ProseNamed, text: string, commit: string): Slot {
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
    : refused(`${quotedPath(entry.path)} at ${short} ${problem}`)
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
  // The bytes of rule text each profile holds before the rules file in hand: its own rules and its config documents', and the files read before it.
  const held = new Map<ResolvedProfile, number>()
  for (const [index, slot] of slots.entries()) {
    if (!('text' in slot)) continue
    const named = entries[index]
    if (isProse(named)) {
      slots[index] = documentSlot(named, slot.text, commit)
      continue
    }
    const before = held.get(named.profile) ?? ruleTextBytes(profileTexts(named.profile.profile, '').rules) ?? 0
    slots[index] = rulesSlot(named, slot.text, commit, before)
    const read = slots[index]
    held.set(named.profile, before + ('document' in read
      ? ruleTextBytes(read.document.rules) ?? 0
      : 0))
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
    // `contextTotalIssues` names each document by its index, at `context.documents.<index>`, and a rule below it.
    const found = new Map<number, string[]>()
    for (const { path, message } of contextTotalIssues(profileTexts(profile.profile, ''), own)) {
      const index = Number(/^context\.documents\.(\d+)/.exec(path)?.[1])
      // A repeated rule id is worded with its place already.
      const place = `${quotedPath(entries[index].entry.path)} at ${short} `
      found.set(index, [
        ...found.get(index) ?? [],
        message.startsWith(place)
          ? message
          : `${place}${message}`,
      ])
    }
    for (const [index, problems] of found) slots[index] = { problems }
  }

  const issues: ConfigIssue[] = entries.flatMap(({ entry }, index) => {
    const slot = slots[index]
    return 'problems' in slot
      ? slot.problems.map(message => ({ path: entry.at, message }))
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
