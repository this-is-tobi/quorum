/**
 * The documents a profile reads as policy: its own guidelines and do-not-report text, the documents of its
 * configuration and the repository documents of a review. The core cleans each (`cleanProse`), caps it, joins the
 * ones of each kind in order and records each in `meta.context`, whoever read it, so what a model reads is what a person
 * sees and nothing reaches a request uncleaned or over a cap. A document's text never appears in a record or a message: a
 * record holds its hash, its path, its commit and its counts.
 *
 * @see ../../docs/20-using/60-prompts.md
 */

import { createHash } from 'node:crypto'
import type { ConfigIssue } from './errors.ts'
import { isRecord } from './output.ts'
import { cleanProse } from './sanitize.ts'
import type { Removed } from './sanitize.ts'
import { utf8Length } from './tokens.ts'
import type { ContextDocument, DocumentKind, Profile, ReviewDocument, ReviewSource } from './types.ts'

/** The most bytes of a document's text a reader decodes: a prompt file's limit. A larger file is refused before it is decoded. */
export const DOCUMENT_READ_LIMIT = 65_536

/** The most UTF-8 bytes of cleaned text a document of each kind may hold, one document and the profile's documents of that kind in all. */
export const DOCUMENT_CAPS: Readonly<Record<DocumentKind, number>> = Object.freeze({ guidelines: 16_384, 'do-not-report': 8192 })

/** The most documents of one kind a profile holds. */
export const MAX_DOCUMENTS = 16

/** The most documents a review's context holds, whatever their profiles and kinds. */
export const MAX_CONTEXT_DOCUMENTS = 256

/** The most characters of a repository path a record holds. */
export const MAX_DOCUMENT_PATH = 4096

/** A full commit id: 40 lowercase hexadecimal digits for sha1, 64 for sha256. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The hash of a document: 64 lowercase hexadecimal digits. */
export const SHA256 = /^[0-9a-f]{64}$/

/** What a document the cleaner cannot settle is refused with: its reader says the fix. */
export const UNSETTLED = 'nests HTML comments or character references too deep to clean in 16 passes: remove them'

/** The kinds of document, in the order a profile's records and texts are written. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = Object.freeze(['guidelines', 'do-not-report'] as const)

const NO_COMMIT = 'needs a commit to read it from, which the review\'s source does not name'

/** What each kind is called where a profile's documents of it are counted in all: the subject and the pronoun that follows it. */
const TOTAL_WORDS: Readonly<Record<DocumentKind, { readonly subject: string, readonly pronoun: string }>> = {
  guidelines: { subject: 'guidelines', pronoun: 'they' },
  'do-not-report': { subject: 'do-not-report text', pronoun: 'it' },
}

/** The SHA-256 of a document's text as read, in UTF-8, before it is cleaned: the hash `sha256sum` gives a file with no byte-order mark. */
export function documentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** What is wrong with one document of `bytes` once cleaned, for its kind's cap, or undefined when it is within it. */
export function capProblem(kind: DocumentKind, bytes: number): string | undefined {
  const cap = DOCUMENT_CAPS[kind]
  return bytes <= cap
    ? undefined
    : `holds ${bytes} bytes once cleaned, over the ${cap / 1024} KiB a ${kind} document may hold`
}

/** What is wrong with a profile's documents of `kind` that come to `bytes` once cleaned, for the cap of all of them, or undefined when they are within it. */
export function totalProblem(kind: DocumentKind, bytes: number): string | undefined {
  const cap = DOCUMENT_CAPS[kind]
  const { subject, pronoun } = TOTAL_WORDS[kind]
  return bytes <= cap
    ? undefined
    : `takes the profile's ${subject} to ${bytes} bytes once cleaned, over the ${cap / 1024} KiB ${pronoun} may hold in all`
}

/**
 * The commit a review's source reads documents from: a range's `base`, a path review's `commit`, local changes' `head`
 * (`null` before a first commit, when there is none yet), and none for a `diff`, whose files nothing names.
 */
export function documentCommit(source: ReviewSource): string | null | undefined {
  switch (source.kind) {
    case 'range':
      return source.base
    case 'paths':
      return source.commit
    case 'local':
    case 'staged':
      return source.head
    case 'diff':
      return undefined
  }
}

/** A path as a message holds it: JSON-quoted, cut at 100 code points with a `…` inside the quotes when it is cut. */
export function quotedPath(path: string): string {
  const points = Array.from(path)
  return JSON.stringify(points.length > 100
    ? `${points.slice(0, 100).join('')}…`
    : path)
}

/** The non-blank texts joined by a blank line, or undefined when none is. */
export function joined(texts: readonly string[]): string | undefined {
  const present = texts.filter(text => text.trim() !== '')
  return present.length === 0
    ? undefined
    : present.join('\n\n')
}

/**
 * What a profile's requests are made of, as compiled and as a review's repository documents add to it: the research
 * template rendered, the cleaned texts of each kind in the order they are joined (the blank ones left out), and one record
 * for each document, blank ones and missing ones included, each profile's guidelines then its do-not-report text.
 */
export interface ProfileTexts {
  readonly prompt: string
  readonly guidelines: readonly string[]
  readonly doNotReport: readonly string[]
  readonly records: readonly ContextDocument[]
}

/** Where a text comes from, flattened: what `partOf` reads of a profile's own text and of a document alike. */
interface Source {
  readonly profile: string
  readonly kind: DocumentKind
  readonly origin: ContextDocument['origin']
  readonly path?: string
  readonly commit?: string
  readonly sha256?: string
  readonly text?: string
  readonly removed?: Removed
}

/** One text cleaned and recorded: its text when it holds any, and its record. */
interface Part {
  readonly text: string | undefined
  readonly record: ContextDocument
}

const NOTHING: Removed = Object.freeze({ characters: 0, comments: 0, entities: 0 })

function added(first: Removed | undefined, second: Removed): Removed {
  return {
    characters: (first?.characters ?? 0) + second.characters,
    comments: (first?.comments ?? 0) + second.comments,
    entities: (first?.entities ?? 0) + second.entities,
  }
}

/** The text of a document cleaned, with what its reader removed and its own pass removed, and its record: the keys in the order the record is written. */
function partOf(source: Source): Part {
  const where = {
    profile: source.profile,
    kind: source.kind,
    origin: source.origin,
    ...source.path === undefined
      ? {}
      : { path: source.path },
    ...source.commit === undefined
      ? {}
      : { commit: source.commit },
  }
  if (source.text === undefined) {
    return {
      text: undefined,
      record: {
        ...where,
        status: 'missing',
        bytes: 0,
        removed: { ...NOTHING },
      },
    }
  }
  const cleaned = cleanProse(source.text)
  const blank = cleaned.text.trim() === ''
  return {
    text: blank
      ? undefined
      : cleaned.text,
    record: {
      ...where,
      ...source.sha256 === undefined
        ? {}
        : { sha256: source.sha256 },
      status: 'read',
      bytes: blank
        ? 0
        : utf8Length(cleaned.text),
      removed: added(source.removed, cleaned.removed),
    },
  }
}

/** A document as `partOf` reads it. */
function sourceOf(document: ReviewDocument): Source {
  const { origin } = document
  return {
    profile: document.profile,
    kind: document.kind,
    origin: origin.kind,
    ...origin.kind === 'repository'
      ? { path: origin.path, commit: origin.commit }
      : {},
    ...origin.sha256 === undefined
      ? {}
      : { sha256: origin.sha256 },
    ...document.text === undefined
      ? {}
      : { text: document.text },
    ...document.removed === undefined
      ? {}
      : { removed: document.removed },
  }
}

/** The cleaned non-blank texts of the parts of `kind`, in order. */
function textsOfKind(parts: readonly Part[], kind: DocumentKind): readonly string[] {
  return Object.freeze(parts.flatMap(part => part.record.kind === kind && part.text !== undefined
    ? [part.text]
    : []))
}

/** The records of the parts of each kind, the kinds in order and the parts of a kind in theirs. */
function recordsOf(parts: readonly Part[]): readonly ContextDocument[] {
  return Object.freeze(DOCUMENT_KINDS.flatMap(kind => parts.filter(part => part.record.kind === kind).map(part => part.record)))
}

/**
 * The texts a profile compiles to: its own text of each kind, then its documents of that kind, each cleaned (what its own
 * pass removes is added to what its reader said it removed) and recorded, the blank ones recorded with no bytes and left
 * out of the texts. `prompt` is the research template as rendered. The profile must be one `profileIssues` accepts.
 */
export function profileTexts(profile: Profile, prompt: string): ProfileTexts {
  const own: Array<readonly [DocumentKind, string | undefined]> = [
    ['guidelines', profile.guidelines],
    ['do-not-report', profile.doNotReport],
  ]
  const parts = [
    ...own.flatMap(([kind, text]) => text === undefined
      ? []
      : [
          partOf({
            profile: profile.id,
            kind,
            origin: 'profile',
            text,
          }),
        ]),
    ...(profile.documents ?? []).map(document => partOf(sourceOf(document))),
  ]
  return Object.freeze({
    prompt,
    guidelines: textsOfKind(parts, 'guidelines'),
    doNotReport: textsOfKind(parts, 'do-not-report'),
    records: recordsOf(parts),
  })
}

/**
 * `texts` with a review's repository documents of the profile added after its own and its configuration's, each kind's in
 * the order given, cleaned and recorded as every document is. `texts` is not changed: it is what the profile compiled to.
 */
export function withRepository(texts: ProfileTexts, documents: readonly ReviewDocument[]): ProfileTexts {
  const parts = documents.map(document => partOf(sourceOf(document)))
  return Object.freeze({
    prompt: texts.prompt,
    guidelines: Object.freeze([
      ...texts.guidelines,
      ...textsOfKind(parts, 'guidelines'),
    ]),
    doNotReport: Object.freeze([
      ...texts.doNotReport,
      ...textsOfKind(parts, 'do-not-report'),
    ]),
    records: Object.freeze(DOCUMENT_KINDS.flatMap(kind => [
      ...texts.records.filter(record => record.kind === kind),
      ...parts.filter(part => part.record.kind === kind).map(part => part.record),
    ])),
  })
}

/** What the documents of a rule are checked against: the origin they must have, the profiles they may name and the commit they must be read at. */
export interface DocumentRule {
  readonly origin: 'config' | 'repository'
  /** The ids of the profiles a document may name: the quorum's for a review's, the one profile's for its own. */
  readonly profiles: ReadonlySet<string>
  /**
   * The commit a repository document must name: a string the commit it names must equal, `null` when the source names none (a
   * `diff`, or local changes before a first commit), which refuses every document. Absent when no source is known, as for an
   * estimate: the commit is then only read as a full commit id.
   */
  readonly commit?: string | null
}

function isCounts(value: unknown): boolean {
  return isRecord(value) && ['characters', 'comments', 'entities'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
}

/** The problems of a document's origin: its kind against the rule's, its hash, and for a repository document its path and commit. */
function originIssues(origin: unknown, path: string, rule: DocumentRule): ConfigIssue[] {
  if (!isRecord(origin) || origin.kind !== rule.origin) {
    return [
      {
        path: `${path}.origin`,
        message: rule.origin === 'repository'
          ? 'must be a repository document: a { file } document belongs in the profile\'s documents'
          : 'must be a config document: a { repository } document comes from the review\'s context',
      },
    ]
  }
  const issues: ConfigIssue[] = []
  if (origin.sha256 !== undefined && !(typeof origin.sha256 === 'string' && SHA256.test(origin.sha256))) issues.push({ path: `${path}.origin.sha256`, message: 'must be 64 lowercase hexadecimal digits' })
  if (rule.origin !== 'repository') return issues
  if (typeof origin.path !== 'string' || origin.path === '' || origin.path.length > MAX_DOCUMENT_PATH) issues.push({ path: `${path}.origin.path`, message: `must be a path of at most ${MAX_DOCUMENT_PATH} characters` })
  if (typeof rule.commit === 'string') {
    if (origin.commit !== rule.commit) issues.push({ path: `${path}.origin.commit`, message: 'must be the commit the review\'s source reads documents from' })
  } else if (rule.commit === undefined && !(typeof origin.commit === 'string' && COMMIT_ID.test(origin.commit))) {
    issues.push({ path: `${path}.origin.commit`, message: 'must be a full commit id: 40 or 64 lowercase hexadecimal digits' })
  }
  return issues
}

/**
 * The problems of one document, by shape first: it is an object, names a profile of the rule, has a kind, an origin of the
 * rule's kind, a text that is a string of at most `DOCUMENT_READ_LIMIT` bytes (only a repository document may hold none, and is
 * then missing: a config document is never missing) and counts of what was removed; then, of a document
 * of the right shape, its cleaned text over its kind's cap, or unsettled. A repository document's messages start with its path
 * and the first 7 characters of its commit.
 */
function oneDocumentIssues(document: unknown, path: string, rule: DocumentRule): ConfigIssue[] {
  if (!isRecord(document)) {
    return [
      { path, message: 'must be an object' },
    ]
  }
  const issues: ConfigIssue[] = []
  if (typeof document.profile !== 'string' || !rule.profiles.has(document.profile)) {
    issues.push({
      path: `${path}.profile`,
      message: rule.origin === 'repository'
        ? 'names no profile of the quorum'
        : 'must name the profile that holds it',
    })
  }
  const kind = DOCUMENT_KINDS.find(candidate => candidate === document.kind)
  if (kind === undefined) issues.push({ path: `${path}.kind`, message: 'must be guidelines or do-not-report' })
  issues.push(...originIssues(document.origin, path, rule))
  if (rule.origin === 'repository' && rule.commit === null) issues.push({ path, message: NO_COMMIT })
  const { text } = document
  if (text !== undefined && typeof text !== 'string') {
    issues.push({ path: `${path}.text`, message: 'must be a string' })
  } else if (text === undefined && rule.origin === 'config') {
    issues.push({ path: `${path}.text`, message: 'must be a string: a config document is never missing' })
  } else if (typeof text === 'string' && utf8Length(text) > DOCUMENT_READ_LIMIT) {
    issues.push({ path: `${path}.text`, message: `holds ${utf8Length(text)} bytes, over the ${DOCUMENT_READ_LIMIT / 1024} KiB quorum reads of a document` })
  }
  if (document.removed !== undefined && !isCounts(document.removed)) issues.push({ path: `${path}.removed`, message: 'must hold counts of characters, comments and entities' })
  if (issues.length > 0 || kind === undefined || typeof text !== 'string') return issues
  const problem = textProblem(kind, text)
  if (problem === undefined) return []
  const origin = document.origin as { readonly path: string, readonly commit: string }
  return [
    {
      path,
      message: rule.origin === 'repository'
        ? `${quotedPath(origin.path)} at ${origin.commit.slice(0, 7)} ${problem}`
        : problem,
    },
  ]
}

/** What is wrong with a text once cleaned, for its kind's cap: that it is unsettled, or over the cap. */
function textProblem(kind: DocumentKind, text: string): string | undefined {
  const cleaned = cleanProse(text)
  if (!cleaned.settled) return UNSETTLED
  return capProblem(kind, bytesOf(cleaned.text))
}

/** The bytes a cleaned text is sent as: none for a blank one. */
export function bytesOf(text: string): number {
  return text.trim() === ''
    ? 0
    : utf8Length(text)
}

/**
 * Every problem with `documents`, which an untyped caller can hand over as anything: a list of at most 256 documents for a
 * review's context, of documents for a profile's own, then each document's own problems at `<root>.<n>` (see `DocumentRule`
 * for the commit). A profile's own list holds at most 16 documents of one kind.
 */
export function documentIssues(documents: unknown, root: string, rule: DocumentRule): ConfigIssue[] {
  const limit = rule.origin === 'repository'
    ? MAX_CONTEXT_DOCUMENTS
    : undefined
  if (!Array.isArray(documents) || (limit !== undefined && documents.length > limit)) {
    return [
      {
        path: root,
        message: limit === undefined
          ? 'must be an array of documents'
          : `must be an array of at most ${limit} documents`,
      },
    ]
  }
  // `Array.from` reads a hole as `undefined`, so it is reported like any other document that is no object.
  const list = Array.from<unknown>(documents)
  const issues = list.flatMap((document, index) => oneDocumentIssues(document, `${root}.${index}`, rule))
  if (rule.origin === 'config' && DOCUMENT_KINDS.some(kind => list.filter(document => isRecord(document) && document.kind === kind).length > MAX_DOCUMENTS)) {
    issues.push({ path: root, message: `must hold at most ${MAX_DOCUMENTS} documents of one kind` })
  }
  return issues
}

/** What one document adds to its kind's total: its kind, its bytes cleaned, and where a problem with it is reported. */
interface Sized {
  readonly kind: DocumentKind
  readonly bytes: number
  readonly path: string
}

/**
 * The first document of each kind whose bytes take that kind's running total, from `start`, over what a profile's documents
 * of the kind may hold in all. Only the first is reported: it is the one to shorten or drop.
 */
function totalIssues(entries: readonly Sized[], start: Readonly<Record<DocumentKind, number>>): ConfigIssue[] {
  return DOCUMENT_KINDS.flatMap((kind) => {
    let total = start[kind]
    for (const entry of entries) {
      if (entry.kind !== kind) continue
      total += entry.bytes
      const problem = totalProblem(kind, total)
      if (problem !== undefined) {
        return [
          { path: entry.path, message: problem },
        ]
      }
    }
    return []
  })
}

/** The bytes a text is sent as once cleaned, or undefined when the cleaner cannot settle it. */
function cleanedBytes(text: string): number | undefined {
  const cleaned = cleanProse(text)
  return cleaned.settled
    ? bytesOf(cleaned.text)
    : undefined
}

/** The bytes a document is sent as once cleaned, or undefined when it cannot be measured: it is no document, holds no text, a text too long to read, or one the cleaner cannot settle. */
function measured(document: unknown): Sized | undefined {
  if (!isRecord(document) || typeof document.text !== 'string' || utf8Length(document.text) > DOCUMENT_READ_LIMIT) return undefined
  const kind = DOCUMENT_KINDS.find(candidate => candidate === document.kind)
  const bytes = cleanedBytes(document.text)
  return kind === undefined || bytes === undefined
    ? undefined
    : { kind, bytes, path: '' }
}

/**
 * Every problem with the documents a profile holds, all at its own paths under `root`: its `guidelines` and `doNotReport`
 * (a string, over its cap once cleaned, unsettled), its `documents` (`documentIssues` of origin `config`, naming the
 * profile) and the documents of a kind that take the profile's texts of that kind, its own text counted first, over the cap
 * of all of them, at the first document that does.
 */
export function profileDocumentIssues(profile: Profile, root: string): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const start: Record<DocumentKind, number> = { guidelines: 0, 'do-not-report': 0 }
  const own: Array<readonly [DocumentKind, 'guidelines' | 'doNotReport']> = [
    ['guidelines', 'guidelines'],
    ['do-not-report', 'doNotReport'],
  ]
  for (const [kind, field] of own) {
    const text: unknown = profile[field]
    if (text === undefined) continue
    if (typeof text !== 'string') {
      issues.push({ path: `${root}.${field}`, message: 'must be a string' })
      continue
    }
    const problem = textProblem(kind, text)
    if (problem !== undefined) issues.push({ path: `${root}.${field}`, message: problem })
    start[kind] = cleanedBytes(text) ?? 0
  }
  const documents: unknown = profile.documents
  if (documents === undefined) return issues
  issues.push(...documentIssues(documents, `${root}.documents`, {
    origin: 'config',
    profiles: new Set([profile.id]),
  }))
  if (Array.isArray(documents)) {
    const entries = Array.from<unknown>(documents).flatMap((document, index) => {
      const size = measured(document)
      return size === undefined
        ? []
        : [
            { ...size, path: `${root}.documents.${index}` },
          ]
    })
    issues.push(...totalIssues(entries, start))
  }
  return issues
}

/**
 * The issues of the repository documents of one profile that take the profile's texts, as `texts` holds them, over what they
 * may hold in all: at the first document of each kind that does, at `context.documents.<n>`, `n` being the document's index
 * in the review's context. `documents` are the profile's, each with its index. Each is cleaned again here, so the sum is the
 * one the requests carry.
 */
export function contextTotalIssues(texts: ProfileTexts, documents: ReadonlyArray<{ readonly index: number, readonly document: ReviewDocument }>): ConfigIssue[] {
  const start: Record<DocumentKind, number> = { guidelines: 0, 'do-not-report': 0 }
  for (const record of texts.records) start[record.kind] += record.bytes
  const entries = documents.flatMap(({ index, document }) => {
    const size = measured(document)
    return size === undefined
      ? []
      : [
          { ...size, path: `context.documents.${index}` },
        ]
  })
  return totalIssues(entries, start)
}
