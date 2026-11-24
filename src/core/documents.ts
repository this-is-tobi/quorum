/**
 * The documents a profile reads as policy: its own guidelines and do-not-report text and review rules, the documents of its
 * configuration and the repository documents of a review. The core cleans each (`cleanProse` removes the hidden
 * characters, the HTML comments and the numeric character references, and leaves the other Markdown a renderer hides), caps
 * it, joins the ones of each kind in order and records each in `meta.context`, whoever read it, so nothing reaches a request
 * uncleaned or over a cap. A document's text never appears in a record or a message: a record holds its hash, its path, its
 * commit and its counts.
 *
 * @see ../../docs/20-using/60-prompts.md
 */

import { createHash } from 'node:crypto'
import type { ConfigIssue } from './errors.ts'
import { isRecord } from './output.ts'
import { cleanedRules, entriesBytes, ruleIssues, RULES_CAP, rulesCountProblem, rulesTotalProblem, ruleTextBytes, ruleTextSizes } from './rules.ts'
import { cleanProse, UNSETTLED } from './sanitize.ts'
import type { Removed } from './sanitize.ts'
import { utf8Length } from './tokens.ts'
import type { ContextDocument, DocumentKind, Profile, ReviewDocument, ReviewRule, ReviewSource } from './types.ts'

export { UNSETTLED }

/** The kinds of document that are prose: a text cleaned and capped, in place of the rules a document of the other kind holds. */
export type ProseKind = Exclude<DocumentKind, 'rules'>

/** The most bytes of a document's text a reader decodes: a prompt file's limit. A larger file is refused before it is decoded. */
export const DOCUMENT_READ_LIMIT = 65_536

/** The most UTF-8 bytes of cleaned text a document of each prose kind may hold, one document and the profile's documents of that kind in all. The rules have their own cap (`RULES_CAP`) in all, and one for each rule's text. */
export const DOCUMENT_CAPS: Readonly<Record<ProseKind, number>> = Object.freeze({ guidelines: 16_384, 'do-not-report': 8192 })

/** The most documents of one kind a profile holds, each rule written in a configuration (one rules document of one rule and no hash) not counted: the 100 rules bound those. */
export const MAX_DOCUMENTS = 16

/** The most documents a review's context holds, whatever their profiles and kinds. */
export const MAX_CONTEXT_DOCUMENTS = 256

/** The most characters of a repository path a record holds. */
export const MAX_DOCUMENT_PATH = 4096

/** A full commit id: 40 lowercase hexadecimal digits for sha1, 64 for sha256. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The hash of a document: 64 lowercase hexadecimal digits. */
export const SHA256 = /^[0-9a-f]{64}$/

/** The kinds of document, in the order a profile's records and texts are written. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = Object.freeze(['guidelines', 'do-not-report', 'rules'] as const)

const NO_COMMIT = 'needs a commit to read it from, which the review\'s source does not name'

/** What each prose kind is called where a profile's documents of it are counted in all: the subject and the pronoun that follows it. */
const TOTAL_WORDS: Readonly<Record<ProseKind, { readonly subject: string, readonly pronoun: string }>> = {
  guidelines: { subject: 'guidelines', pronoun: 'they' },
  'do-not-report': { subject: 'do-not-report text', pronoun: 'it' },
}

/** The SHA-256 of a document's text as read, in UTF-8, before it is cleaned: the hash `sha256sum` gives a file with no byte-order mark. */
export function documentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** What is wrong with one document of a prose kind that holds `bytes` once cleaned, for its kind's cap, or undefined when it is within it. */
export function capProblem(kind: ProseKind, bytes: number): string | undefined {
  const cap = DOCUMENT_CAPS[kind]
  return bytes <= cap
    ? undefined
    : `holds ${bytes} bytes once cleaned, over the ${cap / 1024} KiB a ${kind} document may hold`
}

/** What is wrong with a profile's documents of a prose `kind` that come to `bytes` once cleaned, for the cap of all of them, or undefined when they are within it. */
export function totalProblem(kind: ProseKind, bytes: number): string | undefined {
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

const REPOSITORY_PATH = 'must be a path of the repository: relative to its top level, /-separated, with no empty, . or .. segment, and at most 4096 characters'

/**
 * What is wrong with a path that names a file of the repository, or undefined when it is one: relative to the repository's top
 * level (so never absolute), `/`-separated with no empty, `.` or `..` segment, and at most 4096 characters. The path is never
 * repeated, and git is never handed it: a reader matches it against a listing.
 */
export function repositoryPathProblem(path: string): string | undefined {
  return path.length <= MAX_DOCUMENT_PATH && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
    ? undefined
    : REPOSITORY_PATH
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
 * template rendered, the cleaned texts of each prose kind in the order they are joined (the blank ones left out), the
 * profile's rules in the order they are listed (each text cleaned), and one record for each document, blank ones and
 * missing ones included, each profile's guidelines, then its do-not-report text, then its rules.
 */
export interface ProfileTexts {
  readonly prompt: string
  readonly guidelines: readonly string[]
  readonly doNotReport: readonly string[]
  readonly rules: readonly ReviewRule[]
  readonly records: readonly ContextDocument[]
}

/** Where a text or a list of rules comes from, flattened: what `partOf` reads of a profile's own and of a document alike. */
interface Source {
  readonly profile: string
  readonly kind: DocumentKind
  readonly origin: ContextDocument['origin']
  readonly path?: string
  readonly commit?: string
  readonly sha256?: string
  readonly text?: string
  readonly rules?: readonly ReviewRule[]
  readonly removed?: Removed
}

/** One text or one list of rules cleaned and recorded: its text when it holds any, its rules (none for a text), and its record. */
interface Part {
  readonly text: string | undefined
  readonly rules: readonly ReviewRule[]
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

/**
 * The text of a document cleaned, or its rules with each text cleaned, with what its reader removed and its own pass removed,
 * and its record: the keys in the order the record is written. A rules document's record holds its count of rules, and its
 * bytes are those of its entries as the rules block sends them.
 */
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
  const hash = source.sha256 === undefined
    ? {}
    : { sha256: source.sha256 }
  if (source.kind === 'rules') {
    if (source.rules === undefined) {
      return {
        text: undefined,
        rules: [],
        record: {
          ...where,
          status: 'missing',
          bytes: 0,
          rules: 0,
          removed: { ...NOTHING },
        },
      }
    }
    const cleaned = cleanedRules(source.rules)
    return {
      text: undefined,
      rules: cleaned.rules,
      record: {
        ...where,
        ...hash,
        status: 'read',
        bytes: entriesBytes(cleaned.rules),
        rules: cleaned.rules.length,
        removed: added(source.removed, cleaned.removed),
      },
    }
  }
  if (source.text === undefined) {
    return {
      text: undefined,
      rules: [],
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
    rules: [],
    record: {
      ...where,
      ...hash,
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
    ...document.rules === undefined
      ? {}
      : { rules: document.rules },
    ...document.removed === undefined
      ? {}
      : { removed: document.removed },
  }
}

/** The cleaned non-blank texts of the parts of `kind`, in order. */
function textsOfKind(parts: readonly Part[], kind: ProseKind): readonly string[] {
  return Object.freeze(parts.flatMap(part => part.record.kind === kind && part.text !== undefined
    ? [part.text]
    : []))
}

/** The cleaned rules of the parts, in order: those of the parts of kind `rules`. */
function rulesOf(parts: readonly Part[]): readonly ReviewRule[] {
  return Object.freeze(parts.flatMap(part => part.rules))
}

/** The records of the parts of each kind, the kinds in order and the parts of a kind in theirs. */
function recordsOf(parts: readonly Part[]): readonly ContextDocument[] {
  return Object.freeze(DOCUMENT_KINDS.flatMap(kind => parts.filter(part => part.record.kind === kind).map(part => part.record)))
}

/**
 * The texts a profile compiles to: its own text of each kind, then its documents of that kind, each cleaned (what its own
 * pass removes is added to what its reader said it removed) and recorded, the blank ones recorded with no bytes and left
 * out of the texts. Its own rules, when it lists some, are one document of kind `rules`, recorded as the profile's, and the
 * rules of its documents follow them. `prompt` is the research template as rendered. The profile must be one `profileIssues`
 * accepts.
 */
export function profileTexts(profile: Profile, prompt: string): ProfileTexts {
  const own: Array<readonly [ProseKind, string | undefined]> = [
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
    ...profile.rules === undefined || profile.rules.length === 0
      ? []
      : [
          partOf({
            profile: profile.id,
            kind: 'rules',
            origin: 'profile',
            rules: profile.rules,
          }),
        ],
    ...(profile.documents ?? []).map(document => partOf(sourceOf(document))),
  ]
  return Object.freeze({
    prompt,
    guidelines: textsOfKind(parts, 'guidelines'),
    doNotReport: textsOfKind(parts, 'do-not-report'),
    rules: rulesOf(parts),
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
    rules: Object.freeze([
      ...texts.rules,
      ...rulesOf(parts),
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
  /**
   * The bytes of cleaned rule text each profile holds before these documents, by profile id: its own rules, and for a review's
   * repository documents its config documents' too. A rules document's rules are counted after them, and the documents before it
   * in the list, so the bytes an issue names are the profile's. A profile it holds no entry for holds none.
   */
  readonly held?: ReadonlyMap<string, number>
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

/** A repository document as its messages name it: its path, quoted, and the first 7 characters of its commit. */
function placeAt(path: string, commit: string): string {
  return `${quotedPath(path)} at ${commit.slice(0, 7)}`
}

/** `placeAt` of an untyped repository document, whose origin must be one `originIssues` accepts. */
function placeOf(document: Record<string, unknown>): string {
  const origin = document.origin as { readonly path: string, readonly commit: string }
  return placeAt(origin.path, origin.commit)
}

/**
 * The problems of the rules a document of kind `rules` holds, at `<path>.rules`: those `ruleIssues` finds, a repository
 * document's messages starting with its path and the first 7 characters of its commit. A rules document that is missing
 * holds none. `held` is what the profile's rules before the document take: the bytes its issues name are the profile's.
 */
function rulesDocumentIssues(document: Record<string, unknown>, path: string, rule: DocumentRule, held: number): ConfigIssue[] {
  if (document.rules === undefined) return []
  const issues = ruleIssues(document.rules, `${path}.rules`, held)
  if (rule.origin !== 'repository') return issues
  const place = placeOf(document)
  return issues.map(issue => ({ path: issue.path, message: `${place} ${issue.message}` }))
}

/**
 * The problems of one document, by shape first: it is an object, names a profile of the rule, has a kind, an origin of the
 * rule's kind, a text that is a string of at most `DOCUMENT_READ_LIMIT` bytes, or, for a document of kind `rules`, rules in
 * place of a text (only a repository document may hold neither, and is then missing: a config document is never missing) and
 * counts of what was removed; then, of a document of the right shape, its cleaned text over its kind's cap, or unsettled, or
 * its rules' own problems (`ruleIssues`, with `held`, the bytes of the profile's rules before the document). A repository
 * document's messages start with its path and the first 7 characters of its commit.
 */
function oneDocumentIssues(document: unknown, path: string, rule: DocumentRule, held: number): ConfigIssue[] {
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
  if (kind === undefined) issues.push({ path: `${path}.kind`, message: 'must be guidelines, do-not-report or rules' })
  issues.push(...originIssues(document.origin, path, rule))
  if (rule.origin === 'repository' && rule.commit === null) issues.push({ path, message: NO_COMMIT })
  const { text } = document
  if (kind === 'rules') {
    if (text !== undefined) issues.push({ path: `${path}.text`, message: 'must be absent: a rules document holds rules' })
    if (document.rules === undefined && rule.origin === 'config') issues.push({ path: `${path}.rules`, message: 'must be an array of rules: a config document is never missing' })
  } else {
    if (kind !== undefined && document.rules !== undefined) issues.push({ path: `${path}.rules`, message: 'must be absent: only a rules document holds rules' })
    if (text !== undefined && typeof text !== 'string') {
      issues.push({ path: `${path}.text`, message: 'must be a string' })
    } else if (text === undefined && rule.origin === 'config') {
      issues.push({ path: `${path}.text`, message: 'must be a string: a config document is never missing' })
    } else if (typeof text === 'string' && utf8Length(text) > DOCUMENT_READ_LIMIT) {
      issues.push({ path: `${path}.text`, message: `holds ${utf8Length(text)} bytes, over the ${DOCUMENT_READ_LIMIT / 1024} KiB quorum reads of a document` })
    }
  }
  if (document.removed !== undefined && !isCounts(document.removed)) issues.push({ path: `${path}.removed`, message: 'must hold counts of characters, comments and entities' })
  if (issues.length > 0 || kind === undefined) return issues
  if (kind === 'rules') return rulesDocumentIssues(document, path, rule, held)
  if (typeof text !== 'string') return issues
  const problem = textProblem(kind, text)
  if (problem === undefined) return []
  return [
    {
      path,
      message: rule.origin === 'repository'
        ? `${placeOf(document)} ${problem}`
        : problem,
    },
  ]
}

/** What is wrong with a text once cleaned, for its kind's cap: that it is unsettled, or over the cap. */
function textProblem(kind: ProseKind, text: string): string | undefined {
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
 * Whether `document` is an inline rule: a rules document that holds one rule and no hash, which is what a rule written in a
 * configuration is. The 100 rules a profile holds bound these, so they are no part of the 16 documents of their kind: a rules
 * file, which holds a hash or more than one rule, is.
 */
function isInlineRule(document: Record<string, unknown>): boolean {
  return document.kind === 'rules' && isRecord(document.origin) && document.origin.sha256 === undefined && Array.isArray(document.rules) && document.rules.length === 1
}

/**
 * Every problem with `documents`, which an untyped caller can hand over as anything: a list of at most 256 documents for a
 * review's context, of documents for a profile's own, then each document's own problems at `<root>.<n>` (see `DocumentRule`
 * for the commit, and the bytes of rules each profile holds before the list). A profile's own list holds at most 16 documents of
 * one kind, the rules written in a configuration (a rules document of one rule and no hash, one for each rule) not counted: the
 * 100 rules of a profile bound them.
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
  // What each profile's rules take before the document in hand: what the rule says it holds already, and the rules documents of the list before it.
  const held = new Map(rule.held)
  const issues = list.flatMap((document, index) => {
    const rules = isRecord(document) && document.kind === 'rules' && typeof document.profile === 'string'
      ? { profile: document.profile, bytes: ruleTextBytes(document.rules) ?? 0 }
      : undefined
    const before = rules === undefined
      ? 0
      : held.get(rules.profile) ?? 0
    if (rules !== undefined) held.set(rules.profile, before + rules.bytes)
    return oneDocumentIssues(document, `${root}.${index}`, rule, before)
  })
  if (rule.origin === 'config' && DOCUMENT_KINDS.some(kind => list.filter(document => isRecord(document) && document.kind === kind && !isInlineRule(document)).length > MAX_DOCUMENTS)) {
    issues.push({ path: root, message: `must hold at most ${MAX_DOCUMENTS} documents of one kind` })
  }
  return issues
}

/** The prose kinds, in the order a profile's records and texts are written. */
const PROSE_KINDS: readonly ProseKind[] = DOCUMENT_KINDS.filter((kind): kind is ProseKind => kind !== 'rules')

/** What one document of a prose kind adds to its kind's total: its kind, its bytes cleaned, and where a problem with it is reported. */
interface Sized {
  readonly kind: ProseKind
  readonly bytes: number
  readonly path: string
}

/**
 * The first document of each prose kind whose bytes take that kind's running total, from `start`, over what a profile's
 * documents of the kind may hold in all. Only the first is reported: it is the one to shorten or drop.
 */
function totalIssues(entries: readonly Sized[], start: Readonly<Record<ProseKind, number>>): ConfigIssue[] {
  return PROSE_KINDS.flatMap((kind) => {
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

/**
 * The bytes a document of a prose kind counts toward the total of its kind once cleaned, or undefined when it cannot be
 * measured: it is no document, of no prose kind (a rules document is counted by `rulesCapIssues`), holds no text, a text too
 * long to read, or one the cleaner cannot settle.
 */
function measured(document: unknown): Sized | undefined {
  if (!isRecord(document)) return undefined
  const kind = PROSE_KINDS.find(candidate => candidate === document.kind)
  if (kind === undefined) return undefined
  if (typeof document.text !== 'string' || utf8Length(document.text) > DOCUMENT_READ_LIMIT) return undefined
  const bytes = cleanedBytes(document.text)
  return bytes === undefined
    ? undefined
    : { kind, bytes, path: '' }
}

/** How a document's messages name it: a repository document's path and the first 7 characters of its commit, then a space; nothing for any other. */
function placeWords(document: ReviewDocument): string {
  return document.origin.kind === 'repository'
    ? `${placeAt(document.origin.path, document.origin.commit)} `
    : ''
}

/** A rules document and where a problem with it is reported: its path, and how its messages name it (`placeWords`). */
interface Listed {
  readonly path: string
  readonly rules: unknown
  readonly place: string
}

/**
 * The rule ids that `held`, the ids the profile lists already, and each of `documents` before it, give a rules document again:
 * one issue for each rule whose id is one of them, at the rule's `id`. A repeat within one document is `ruleIssues`'s, and is not
 * reported twice.
 */
function repeatedIssues(held: ReadonlySet<string>, documents: readonly Listed[]): ConfigIssue[] {
  const seen = new Set(held)
  const issues: ConfigIssue[] = []
  for (const { path, rules, place } of documents) {
    if (!Array.isArray(rules)) continue
    const within = new Set<string>()
    Array.from<unknown>(rules).forEach((rule, index) => {
      if (!isRecord(rule) || typeof rule.id !== 'string') return
      if (!within.has(rule.id) && seen.has(rule.id)) issues.push({ path: `${path}.rules.${index}.id`, message: `${place}repeats the rule id ${JSON.stringify(rule.id)}` })
      within.add(rule.id)
    })
    for (const id of within) seen.add(id)
  }
  return issues
}

/** The ids of the rules of `rules`, an untyped list: those of the records that hold a string `id`. */
function idsOf(rules: unknown): string[] {
  return Array.isArray(rules)
    ? Array.from<unknown>(rules).flatMap(rule => isRecord(rule) && typeof rule.id === 'string'
        ? [rule.id]
        : [])
    : []
}

/** What a profile's rules come to: how many, and the bytes of their cleaned texts. */
interface Held {
  readonly count: number
  readonly bytes: number
}

/** What the untyped list `rules` comes to: its length, and the bytes of its texts once cleaned (0 for a list that cannot be measured, whose own issues say why). */
function heldBy(rules: unknown): Held {
  return {
    count: Array.isArray(rules)
      ? rules.length
      : 0,
    bytes: ruleTextBytes(rules) ?? 0,
  }
}

/** The profile's total once the rules of `sizes` are counted from `before` up to the first that takes it over the 32 KiB: what the message of that total names. */
function totalAtCap(before: number, sizes: readonly number[]): number {
  let total = before
  for (const size of sizes) {
    total += size
    if (total > RULES_CAP) break
  }
  return total
}

/**
 * The caps of all of a profile's rules, whatever their origin: how many they are (100) and the bytes of their cleaned texts
 * (32 KiB), counted from `start`, what the profile's own rules and the documents before hold, through each of `documents` in
 * order. Each cap is reported once, at the first rules document that takes the total over, and the bytes the message names are
 * the profile's total at the rule that takes it over, the documents' rules counted up to that rule. A total that `start` is over
 * already is reported where it was, and so is one that a document is over alone, which `ruleIssues` reports at the rule that
 * takes it over, so no problem is told twice.
 */
function rulesCapIssues(start: Held, documents: readonly Listed[]): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  let { count, bytes } = start
  let countOver = rulesCountProblem(count) !== undefined
  let bytesOver = rulesTotalProblem(bytes) !== undefined
  for (const { path, rules } of documents) {
    const sizes = ruleTextSizes(rules) ?? []
    const own = {
      count: Array.isArray(rules)
        ? rules.length
        : 0,
      bytes: sizes.reduce((total, size) => total + size, 0),
    }
    const before = bytes
    count += own.count
    bytes += own.bytes
    const tooMany = countOver
      ? undefined
      : rulesCountProblem(count)
    if (tooMany !== undefined) {
      countOver = true
      if (rulesCountProblem(own.count) === undefined) issues.push({ path, message: tooMany })
    }
    const tooBig = bytesOver
      ? undefined
      : rulesTotalProblem(totalAtCap(before, sizes))
    if (tooBig !== undefined) {
      bytesOver = true
      if (rulesTotalProblem(own.bytes) === undefined) issues.push({ path, message: tooBig })
    }
  }
  return issues
}

/**
 * Every problem with the documents a profile holds, all at its own paths under `root`: its `guidelines` and `doNotReport`
 * (a string, over its cap once cleaned, unsettled), its own `rules` (`ruleIssues`), its `documents` (`documentIssues` of origin
 * `config`, naming the profile), the documents of a prose kind that take the profile's texts of that kind, its own text counted
 * first, over the cap of all of them, at the first document that does, the rules documents that take the profile's rules, its
 * own counted first, over the 100 rules or the 32 KiB they may hold in all (`rulesCapIssues`), and a rule id that a rules
 * document gives again after the profile's own rules and the rules documents before it, at the rule's id.
 */
export function profileDocumentIssues(profile: Profile, root: string): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const start: Record<ProseKind, number> = { guidelines: 0, 'do-not-report': 0 }
  const own: Array<readonly [ProseKind, 'guidelines' | 'doNotReport']> = [
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
  const rules: unknown = profile.rules
  if (rules !== undefined) issues.push(...ruleIssues(rules, `${root}.rules`))
  const documents: unknown = profile.documents
  if (documents === undefined) return issues
  issues.push(...documentIssues(documents, `${root}.documents`, {
    origin: 'config',
    profiles: new Set([profile.id]),
    held: new Map([
      [profile.id, heldBy(rules).bytes],
    ]),
  }))
  if (Array.isArray(documents)) {
    const list = Array.from<unknown>(documents)
    const entries = list.flatMap((document, index) => {
      const size = measured(document)
      return size === undefined
        ? []
        : [
            { ...size, path: `${root}.documents.${index}` },
          ]
    })
    const listed = list.flatMap((document, index) => isRecord(document) && document.kind === 'rules'
      ? [
          { path: `${root}.documents.${index}`, rules: document.rules, place: '' },
        ]
      : [])
    issues.push(
      ...totalIssues(entries, start),
      ...rulesCapIssues(heldBy(rules), listed),
      ...repeatedIssues(new Set(idsOf(rules)), listed),
    )
  }
  return issues
}

/**
 * The issues of the repository documents of one profile that take the profile's texts, as `texts` holds them, over what they
 * may hold in all: at the first document of each prose kind that does, at `context.documents.<n>`, `n` being the document's
 * index in the review's context; for the rules, at the first rules document that takes the profile's rules, as `texts` holds
 * them (its own, then its config documents'), over the 100 rules or the 32 KiB they may hold in all; and, for a rules
 * document, each rule whose id the profile's rules or an earlier document's already give, at
 * `context.documents.<n>.rules.<k>.id`, in the document's own words. `documents` are the profile's, each with its index.
 * Each is cleaned again here, so the sum is the one the requests carry.
 */
export function contextTotalIssues(texts: ProfileTexts, documents: ReadonlyArray<{ readonly index: number, readonly document: ReviewDocument }>): ConfigIssue[] {
  const start: Record<ProseKind, number> = { guidelines: 0, 'do-not-report': 0 }
  for (const record of texts.records) {
    if (record.kind !== 'rules') start[record.kind] += record.bytes
  }
  const listed = documents.flatMap(({ index, document }) => document.kind === 'rules'
    ? [
        {
          path: `context.documents.${index}`,
          rules: document.rules,
          place: placeWords(document),
        },
      ]
    : [])
  const entries = documents.flatMap(({ index, document }) => {
    const size = measured(document)
    return size === undefined
      ? []
      : [
          { ...size, path: `context.documents.${index}` },
        ]
  })
  return [
    ...totalIssues(entries, start),
    ...rulesCapIssues(heldBy(texts.rules), listed),
    ...repeatedIssues(new Set(texts.rules.map(rule => rule.id)), listed),
  ]
}
