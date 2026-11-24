/**
 * The pieces of a line that the text report, the Markdown summary and the progress lines of the CLI write one
 * way: how many of a thing, a file left out, where a flag points, the words of a gap, the words of a verdict, a
 * source, a finding's level, votes and rule, its place among the findings and its evidence's rows, a document a review read
 * and each profile's summary of them, how many rules a profile sent, and the numbers a person reads: a token count
 * scaled and a duration in one form (past a minute in minutes). None makes its text inert: a file name is a diff's and a
 * flag's detail a diff's too, so the line that holds them passes through `inertLine` whole.
 */

import { DOCUMENT_KINDS, quotedPath } from '../core/documents.ts'
import { elapsedWords } from '../core/duration.ts'
import { ownData } from '../core/facts.ts'
import type { Outcome, OutcomeStatus } from '../core/outcome.ts'
import { failsItsProfile } from '../core/outcome.ts'
import type { ContextDocument, ContextRecord, CoverageEntry, CoverageStatus, DocumentKind, Flag, IncompleteReason, LeftOutFile, ProfileMeta, PublicVerdict, PublicView, ReviewSource, Verdict, VoteFailure } from '../core/types.ts'
import { voteFailed } from './view.ts'

/** A token count told in three significant digits at most, floored: `999`, `1.23k`, `12.3k`, `812k`, `9.86M`. */
export function tokenWords(tokens: number): string {
  const count = Math.max(0, Math.floor(tokens))
  if (count < 1000) return String(count)
  const units = ['k', 'M', 'B', 'T']
  let scale = 1000
  let unit = 0
  while (unit < units.length - 1 && count >= scale * 1000) {
    scale *= 1000
    unit += 1
  }
  const whole = Math.floor(count / scale)
  const decimals = whole < 10
    ? 2
    : whole < 100
      ? 1
      : 0
  const steps = 10 ** decimals
  return `${(Math.floor(count / (scale / steps)) / steps).toFixed(decimals)}${units[unit]}`
}

/**
 * A duration for a person, in one form wherever a person reads it: one decimal of a second under ten seconds, then
 * `elapsedWords`, whole seconds throughout: `0.9s`, `4.3s`, `42s`, `7m48s`, `1h02m09s`, `24h00m00s`. A duration a program
 * parses stays in milliseconds in its own format.
 */
export function durationText(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100))
  return tenths < 100
    ? `${(tenths / 10).toFixed(1)}s`
    : elapsedWords(ms)
}

/** `1 gap`, `2 gaps`: the count, then the noun in the form the count takes. */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1
    ? word
    : many}`
}

/**
 * A file the review left out as a line names it: the file as a JSON string, as a flag's is, or `<no path>` for
 * the empty name, which stands for a part of the diff no header names, then its reason in parentheses, a skipped
 * or a held file with its rule: `".env" (secret: name)`.
 */
export function leftOutEntry(entry: LeftOutFile): string {
  const file = entry.file === ''
    ? '<no path>'
    : JSON.stringify(entry.file)
  const reason = 'rule' in entry
    ? `${entry.reason}: ${entry.rule}`
    : entry.reason
  return `${file} (${reason})`
}

/** Where a flag points: the file as a JSON string, with the line when it has one, else the line alone, then ` for <profile>` when the flag is about one. */
export function flagWhere({ file, line, profile }: Flag): string {
  const place = flagFile(file, line)
  return profile === undefined
    ? place
    : `${place} for ${profile}`
}

/** The place a flag names in the file it is about: the file as a JSON string, with the line when it has one, else the line alone. */
function flagFile(file: string | undefined, line: number | undefined): string {
  if (file !== undefined && line !== undefined) return ` at ${JSON.stringify(file)}:${line}`
  if (file !== undefined) return ` at ${JSON.stringify(file)}`
  if (line !== undefined) return ` at line ${line}`
  return ''
}

/** `names` as `a`, `a and b` or `a, b and c`. */
export function listed(names: readonly string[]): string {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** What a line calls each kind of document. */
const KIND_WORDS: Readonly<Record<DocumentKind, string>> = {
  guidelines: 'guidelines',
  'do-not-report': 'do-not-report text',
  rules: 'rules',
}

/** How many characters of a commit's id, and of a document's hash, a line shows. */
const SHORT_COMMIT = 7
const SHORT_HASH = 12

/** How a line writes what it names of a document that has a place: its path, its commit and its hash. */
export interface DocumentShow {
  readonly path: (path: string) => string
  readonly commit: (id: string) => string
  readonly hash: (digits: string) => string
}

/** The log's and the text report's way: a path as JSON, cut at 100 code points, the rest as it is. */
const PLAIN: DocumentShow = {
  path: quotedPath,
  commit: id => id,
  hash: digits => digits,
}

/** Where a document came from: the profile's own text, a file and its hash, text the config holds, or a path of the repository at a commit. */
function documentOrigin(record: ContextDocument, show: DocumentShow): string {
  switch (record.origin) {
    case 'profile':
      return 'of the profile'
    case 'config':
      return record.sha256 === undefined
        ? 'written in the config'
        : `from a file, sha256 ${show.hash(record.sha256.slice(0, SHORT_HASH))}`
    default:
      return `${show.path(record.path ?? '')} at ${show.commit((record.commit ?? '').slice(0, SHORT_COMMIT))}`
  }
}

/** What the cleaner removed from a document, as `; the cleaner removed 3 hidden character(s) and 1 comment(s)`, and nothing when it removed none. */
function removedWords({ characters, comments, entities }: ContextDocument['removed']): string {
  const removed = [
    ...characters > 0
      ? [`${characters} hidden character(s)`]
      : [],
    ...comments > 0
      ? [`${comments} comment(s)`]
      : [],
    ...entities > 0
      ? [`${entities} character reference(s)`]
      : [],
  ]
  return removed.length === 0
    ? ''
    : `; the cleaner removed ${listed(removed)}`
}

/** What a document read holds, as a person compares it: its bytes as sent, an integer, since the caps are in bytes, or, for a rules document, its count of rules. */
function documentSize(record: ContextDocument): string {
  return record.kind === 'rules'
    ? `${record.rules ?? 0} rule(s)`
    : `${record.bytes} bytes`
}

/** A document's words in two parts: the `head`, which ends at the first comma or colon and holds the path, the commit or the hash whole, and the `tail`, the rest. `head`, a space and `tail` are the sentence. */
export interface DocumentParts {
  readonly head: string
  readonly tail: string
}

/**
 * A document a review read, in words quorum wrote: its profile and kind, where it came from and a comma (a colon for a
 * missing one), which are the head; then its bytes as sent (a rules document's count of rules), or that an optional one was
 * missing, then what the cleaner removed from it, which are the tail. `show` writes the path, the commit and the hash a
 * place names, so the log and the Markdown summary write one sentence. It never holds the document's text, and bytes are
 * integers, since a person compares them with the caps.
 */
function documentParts(record: ContextDocument, show: DocumentShow): DocumentParts {
  const missing = record.status === 'missing'
  return {
    head: `${record.profile} ${KIND_WORDS[record.kind]} ${documentOrigin(record, show)}${missing
      ? ':'
      : ','}`,
    tail: `${missing
      ? 'missing, and optional'
      : documentSize(record)}${removedWords(record.removed)}`,
  }
}

/** A document as the sentence `documentParts` splits: `<profile> <kind> <where from>, <bytes> bytes`, or `<k> rule(s)` for a rules document. */
export function documentWords(record: ContextDocument, show: DocumentShow): string {
  const { head, tail } = documentParts(record, show)
  return `${head} ${tail}`
}

/** The line a document has in the log: `context: <profile> <kind> <where from>, <bytes> bytes` (`, <k> rule(s)` for a rules document), as `documentWords` says it. */
export function documentLine(record: ContextDocument): string {
  return `context: ${documentWords(record, PLAIN)}`
}

/** The line of `documentLine` in two parts, for a report that wraps its tail and keeps its head whole: the path stays on one line. */
export function documentLineParts(record: ContextDocument): DocumentParts {
  const { head, tail } = documentParts(record, PLAIN)
  return { head: `context: ${head}`, tail }
}

/** How many rules a profile lists and how many its review sent, as `ProfileMeta.rules` and the `context` event hold them. */
export type RuleCounts = ProfileMeta['rules']

/**
 * `3 of 5 sent`: the rules a review sent of those a profile lists, then `, so its research asks nothing` when `asksNothing`:
 * the profile requires a rule and was sent none, so its finder was never called and its files read as reviewed. `0 of 0 sent` is
 * a profile that requires a rule and lists none.
 */
export function ruleCountWords({ listed, sent }: RuleCounts, asksNothing = false): string {
  return `${sent} of ${listed} sent${asksNothing
    ? ', so its research asks nothing'
    : ''}`
}

/** What a result records of a profile's rules, as `contextSummary` and the text report read it. */
export type ProfileRules = Pick<ProfileMeta, 'rules' | 'asksNothing'>

/** A profile's rules from `profiles` (a result's `meta.profiles`, read as own data): none for a profile with no entry. */
function rulesOf(profiles: Readonly<Record<string, ProfileRules>>, profile: string): ProfileRules | undefined {
  return ownData(profiles, profile) as ProfileRules | undefined
}

/** Whether a profile's rules are worth words: it lists a rule, or its research asked nothing (it requires a rule and lists none, or sent none). */
function hasRulesToTell(rules: ProfileRules | undefined): rules is ProfileRules {
  return rules !== undefined && (rules.rules.listed > 0 || rules.asksNothing === true)
}

/** The rules part of a profile's summary line, `rules 3 of 5 sent` and `, so its research asks nothing` for a profile that asked nothing: none for a profile that lists no rule and requires none. */
function rulesPart(rules: ProfileRules | undefined): string[] {
  return hasRulesToTell(rules)
    ? [`${KIND_WORDS.rules} ${ruleCountWords(rules.rules, rules.asksNothing === true)}`]
    : []
}

/** The parts of one profile's summary line: the bytes of each kind of text it read, the rules it sent, its optional documents missing and the documents the cleaner removed text from. A profile that lists no rule and requires none has no rules part. */
function summaryParts(documents: readonly ContextDocument[], rules: ProfileRules | undefined): string[] {
  const kinds = DOCUMENT_KINDS.filter(kind => kind !== 'rules').flatMap((kind) => {
    const read = documents.filter(document => document.kind === kind && document.status === 'read')
    return read.length === 0
      ? []
      : [`${KIND_WORDS[kind]} ${read.reduce((bytes, document) => bytes + document.bytes, 0)} bytes`]
  })
  const missing = documents.filter(document => document.status === 'missing').length
  const cleaned = documents.filter(({ removed }) => removed.characters + removed.comments + removed.entities > 0).length
  return [
    ...kinds,
    ...rulesPart(rules),
    ...missing > 0
      ? [`${missing} optional document(s) missing`]
      : [],
    ...cleaned > 0
      ? [`hidden text removed from ${cleaned}`]
      : [],
  ]
}

/**
 * One summary line for each profile that has something to summarize, in the order the review's records first name them, then
 * those with no record in the order of `profiles`: `context: <profile>: guidelines 1830 bytes, rules 3 of 5 sent, 1 optional document(s)
 * missing, hidden text removed from 1`. The rules part, `rules <sent> of <listed> sent`, is read from the profile's entry in
 * `profiles` (a result's `meta.profiles`) and written for a profile that lists a rule, and with `, so its research asks nothing` for
 * a profile that asked nothing, which has a line of its own, `context: <profile>: rules 0 of 0 sent, so its research asks nothing`,
 * when it has no document. A profile whose only record is a rules file that holds none has no line.
 */
export function contextSummary(record: ContextRecord, profiles: Readonly<Record<string, ProfileRules>> = {}): string[] {
  const byProfile = new Map<string, ContextDocument[]>()
  for (const document of record.documents) {
    byProfile.set(document.profile, [
      ...byProfile.get(document.profile) ?? [],
      document,
    ])
  }
  for (const profile of Object.keys(profiles)) {
    if (!byProfile.has(profile) && rulesOf(profiles, profile)?.asksNothing === true) byProfile.set(profile, [])
  }
  return [...byProfile].flatMap(([profile, documents]) => {
    const parts = summaryParts(documents, rulesOf(profiles, profile))
    return parts.length === 0
      ? []
      : [`context: ${profile}: ${parts.join(', ')}`]
  })
}

/**
 * What each reason of a gap says, in words quorum wrote: the public view has no detail, since a detail quotes a
 * file, a finder or a server, so a report of it writes these. Each line that holds them passes `inertLine`.
 */
export const GAP_WORDS: Readonly<Record<IncompleteReason, string>> = {
  'research-unusable': 'the research reply listed findings, but none could be read',
  'research-failed': 'a research call failed, so part of the change went unreviewed',
  'provider-down': 'a provider was down, so part of the work was never sent',
  'findings-capped': 'research reported more findings than the panel reviews, or listed every finding it was asked for, so it may have left some out',
  'finding-unreadable': 'the harness could not read a finding',
  'vote-failed': 'a failed vote could have raised a kept finding\'s level',
  'request-too-large': 'a request was refused as too large for its model',
  'too-large': 'a hunk fits in no research request of its model',
  'token-cap': 'the review\'s token cap stopped part of the work',
  'review-deadline': 'the review\'s deadline stopped part of the work',
  interrupted: 'the review was stopped before its end, so part of the work was never read',
  'reply-cut-off': 'a reply was cut off at its limit even for one hunk, so that hunk went unreviewed',
  binary: 'the diff carries no content for a binary file',
  submodule: 'the diff carries only a submodule\'s commit',
  secret: 'a file held back as a secret was sent to no model',
}

/**
 * What was reviewed, as a report names it: `diff`; `range <base>...<head>`; `<kind> on <head>` for a local or staged
 * review, or `<kind>, no commit yet` before a first commit; `paths at <commit>`; else `source unknown`. `id` writes
 * a commit's id: the text report's is its first seven characters, the summary's a code span of the whole.
 */
export function sourcePhrase(source: ReviewSource, id: (commit: string) => string): string {
  switch (source.kind) {
    case 'diff':
      return 'diff'
    case 'range':
      return `range ${id(source.base)}...${id(source.head)}`
    case 'local':
    case 'staged':
      return source.head === null
        ? `${source.kind}, no commit yet`
        : `${source.kind} on ${id(source.head)}`
    case 'paths':
      return `paths at ${id(source.commit)}`
    default:
      return 'source unknown'
  }
}

/** The commit a review's changes sit on: a range's head, a local or staged review's head (`null` before a first commit), a path review's commit, and `null` for a diff or a source no release knows. */
export function commitOf(source: ReviewSource): string | null {
  switch (source.kind) {
    case 'range':
    case 'local':
    case 'staged':
      return source.head
    case 'paths':
      return source.commit
    default:
      return null
  }
}

/** How many of the files a profile's coverage lists are reviewed, in part, not, or excluded, as `2 of 3 files reviewed, 1 not`, or `the diff holds no file`. */
export function coverageWords(coverage: readonly CoverageEntry[]): string {
  if (coverage.length === 0) return 'the diff holds no file'
  const count = (status: CoverageStatus): number => coverage.filter(entry => entry.status === status).length
  const others = ([
    ['partial', 'in part'],
    ['unreviewed', 'not'],
    ['excluded', 'excluded'],
  ] as const)
    .filter(([status]) => count(status) > 0)
    .map(([status, word]) => `${count(status)} ${word}`)
  return [`${count('reviewed')} of ${plural(coverage.length, 'file')} reviewed`, ...others].join(', ')
}

const WHY: Readonly<Record<OutcomeStatus, string>> = {
  findings: 'a gating profile kept a finding at or above its fail-on level',
  incomplete: 'a gating profile has a gap or an unreviewed finding',
  pass: 'no gating profile kept a finding to fail on, and none has a gap',
  interrupted: 'the review was stopped before its end; what it read is above',
}

/** Why a review came to what it did, from the one outcome the exit code is made of: the words after `exit 1, findings: `. */
export function verdictWhy(outcome: Outcome): string {
  return outcome.status === 'pass' && outcome.lifted
    ? 'incomplete, but --allow-incomplete lifted every gap'
    : WHY[outcome.status]
}

/** An HTTP status a failure can state: an integer from 100 to 599, as the result schema takes it. */
function isHttpStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
}

/** A `truncated` vote's words: `cut off while reasoning` for reasoning that used the limit, `cut off at the server's window` for the window, else `cut off`, true of a reply cut at a learned length too. */
function cutOffWords(noAnswer: unknown): string {
  switch (noAnswer) {
    case 'thinking':
      return 'cut off while reasoning'
    case 'window':
      return 'cut off at the server\'s window'
    default:
      return 'cut off'
  }
}

/** A `no-answer` vote's words: `only reasoning` for a reply of nothing else, `an empty reply` for one that held nothing, else `no answer`. */
function noAnswerWords(noAnswer: unknown): string {
  switch (noAnswer) {
    case 'thinking':
      return 'only reasoning'
    case 'empty':
      return 'an empty reply'
    default:
      return 'no answer'
  }
}

/**
 * What a failed vote failed with, in words quorum wrote, read from the failure's own data alone and never a word
 * a server or a model said: `an http 503 error`, `a timeout`, `cut off while reasoning`, `an unreadable reply`.
 * `an unknown error` stands for a vote that records no failure and for a kind no release knows.
 */
export function voteFailureWords(failure: VoteFailure | null): string {
  switch (ownData(failure, 'kind')) {
    case 'http': {
      const status = ownData(failure, 'status')
      return isHttpStatus(status)
        ? `an http ${status} error`
        : 'an http error'
    }
    case 'network':
      return 'a network error'
    case 'process':
      return 'a process error'
    case 'timeout':
      return 'a timeout'
    case 'aborted':
      return 'aborted'
    case 'refusal':
      return 'a refusal by the model'
    case 'invalid-response':
      return 'an invalid response'
    case 'unsupported':
      return 'unsupported by its provider'
    case 'too-large':
      return 'too large for its model'
    case 'truncated':
      return cutOffWords(ownData(failure, 'noAnswer'))
    case 'no-answer':
      return noAnswerWords(ownData(failure, 'noAnswer'))
    case 'token-cap':
      return 'stopped by the token cap'
    case 'review-deadline':
      return 'stopped by the deadline'
    case 'interrupted':
      return 'stopped by the interrupt'
    case 'provider-down':
      return 'its provider down'
    case 'unusable-reply':
      return 'an unreadable reply'
    default:
      return 'an unknown error'
  }
}

/** How a finding's lenses voted: how many kept it, how many votes failed and what each failed with, once each, in lens order, as `kept by 1 of 3 lenses, 1 vote failed: cut off while reasoning`. */
export function votesWords(verdict: Verdict | PublicVerdict): string {
  const failed = verdict.votes.filter(voteFailed)
  const failures = failed.length === 0
    ? ''
    : `, ${plural(failed.length, 'vote')} failed: ${[
      ...new Set(failed.map(({ failure }) => voteFailureWords(failure))),
    ].join(', ')}`
  return `kept by ${verdict.keptVotes} of ${plural(verdict.totalVotes, 'lens', 'lenses')}${failures}`
}

/** The level word of a finding: its confidence when it has one, else `UNREVIEWED`, which a finding its failed votes left undecided has. */
export function levelWord(verdict: Verdict | PublicVerdict): 'HIGH' | 'MEDIUM' | 'LOW' | 'UNREVIEWED' {
  switch (verdict.confidence) {
    case 'high':
      return 'HIGH'
    case 'medium':
      return 'MEDIUM'
    case 'low':
      return 'LOW'
    default:
      return 'UNREVIEWED'
  }
}

/**
 * The words that name the rule a finding cites: `rule <id>`, or nothing for a finding that cites none. The id is the
 * configuration's, checked by code, never the finder's text. `id` writes it, as `sourcePhrase`'s does a commit's: a
 * report that puts it in a code span passes `codeSpan`.
 */
export function ruleWords({ rule }: Pick<Verdict, 'rule'>, id: (name: string) => string = name => name): string {
  return rule === undefined || rule === ''
    ? ''
    : `rule ${id(rule)}`
}

/** `a` before `b` by the order of their UTF-16 code units, which no locale changes. */
function byCodeUnits(a: string, b: string): number {
  return a < b
    ? -1
    : a > b
      ? 1
      : 0
}

/** The rank a finding that does not fail its profile is listed by: high, medium, unreviewed, low. */
const RANK: Readonly<Record<ReturnType<typeof levelWord>, number>> = {
  HIGH: 1,
  MEDIUM: 2,
  UNREVIEWED: 3,
  LOW: 4,
}

/** The kept and unreviewed findings of a public view in the order every report lists them: the ones that fail their profile first, then high, medium, unreviewed and low, each group by file and then by line. */
export function rankedFindings(view: PublicView): PublicVerdict[] {
  const ranked = [
    ...view.kept.map(verdict => ({
      verdict,
      rank: failsItsProfile(view, verdict)
        ? 0
        : RANK[levelWord(verdict)],
    })),
    ...view.unreviewed.map(verdict => ({ verdict, rank: RANK[levelWord(verdict)] })),
  ]
  return ranked
    .sort((a, b) => a.rank - b.rank || byLocation(a.verdict, b.verdict))
    .map(({ verdict }) => verdict)
}

/** Whether a file was left out as a secret: held back by name or by a credential in it (`secret`, `deleted-secret`), or skipped by a path review under the rule `secret`. */
export function isSecret(entry: LeftOutFile): boolean {
  return entry.reason === 'secret' || entry.reason === 'deleted-secret' || (entry.reason === 'skipped' && entry.rule === 'secret')
}

/** `a` before `b` by file, in code-unit order, then by line. */
export function byLocation(a: { readonly file: string, readonly line: number }, b: { readonly file: string, readonly line: number }): number {
  return byCodeUnits(a.file, b.file) || a.line - b.line
}

/**
 * Whether `file` is a clean relative path: non-empty, with no leading `/`, and no empty, `.` or `..` segment
 * (`a//b.js`, a trailing `/`). A SARIF location must be valid whatever the finding, and one invalid URI makes
 * GitHub refuse the whole upload; the diff's author controls the path, so a path that is not clean is counted,
 * not placed, as a comment's path is for the payload.
 */
export function isCleanRelativePath(file: string): boolean {
  return !file.startsWith('/') && file.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * The kept and unreviewed findings of a public view that sit on a file of the diff, by file then line, and how
 * many do not. A finding is placed when its `file` is a clean relative path and its profile's coverage lists it:
 * the diff's own files. A finding of a diff with no per-file headers carries the finder's name, which no
 * coverage lists.
 */
export function placedFindings(view: PublicView): { placed: PublicVerdict[], unplaced: number } {
  const files = new Map(Object.entries(view.meta.profiles).map(([id, profile]) => [
    id,
    new Set(profile.coverage.map(entry => entry.file)),
  ]))
  const findings = [
    ...view.kept,
    ...view.unreviewed,
  ]
  const placed = findings
    .filter(({ file, profile }) => isCleanRelativePath(file) && files.get(profile)?.has(file) === true)
    .sort(byLocation)
  return { placed, unplaced: findings.length - placed.length }
}

/** One row of a finding's evidence: whether it is the cited row, its line number in the new file (empty for a removed row, and for every row when none is cited), its marker and its code. */
export interface EvidenceRow {
  readonly cited: boolean
  readonly number: string
  readonly marker: string
  readonly code: string
}

/** Whether a row is a line of the new file: an added row, a context row or an empty row. A removed row is not. */
const isNewFileLine = (row: string): boolean => row === '' || row.startsWith('+') || row.startsWith(' ')

/**
 * The index of the row that shows the cited line: `evidenceRow` when it is an integer that names a row of the
 * new file. Undefined otherwise, so no row is marked and none numbered.
 */
function citedRow(rows: readonly string[], evidenceRow: unknown): number | undefined {
  if (typeof evidenceRow !== 'number' || !Number.isInteger(evidenceRow) || evidenceRow < 0 || evidenceRow >= rows.length) return undefined
  return isNewFileLine(rows[evidenceRow])
    ? evidenceRow
    : undefined
}

/** The new-file line of each row, counted from the cited one, which is `citedLine`: a row that is no line of the new file has none. */
function numberRows(rows: readonly string[], cited: number, citedLine: number): Array<number | undefined> {
  const numbers: Array<number | undefined> = rows.map(() => undefined)
  let next = citedLine
  for (let index = cited; index < rows.length; index += 1) {
    if (!isNewFileLine(rows[index])) continue
    numbers[index] = next
    next += 1
  }
  let before = citedLine
  for (let index = cited - 1; index >= 0; index -= 1) {
    if (!isNewFileLine(rows[index])) continue
    before -= 1
    numbers[index] = before
  }
  return numbers
}

/** A row's marker, its first character, which is a space for an empty row, and the rest of it with each tab as four spaces. */
function splitRow(row: string): { marker: string, code: string } {
  const first = row.codePointAt(0)
  if (first === undefined) return { marker: ' ', code: '' }
  const marker = String.fromCodePoint(first)
  return {
    marker,
    code: row.slice(marker.length).replaceAll('\t', '    '),
  }
}

/**
 * The rows of a finding's evidence, the cited row marked and the added and context rows numbered from the cited
 * line, a removed row with no number, and the width of the widest number, which `rowText` pads every number to.
 */
export function evidenceRows(verdict: Verdict | PublicVerdict): { rows: EvidenceRow[], width: number } {
  const rows = verdict.evidence === ''
    ? []
    : verdict.evidence.split('\n')
  const cited = citedRow(rows, verdict.evidenceRow)
  const numbers = cited === undefined
    ? []
    : numberRows(rows, cited, verdict.line)
  return {
    rows: rows.map((row, index) => ({
      cited: index === cited,
      number: String(numbers[index] ?? ''),
      ...splitRow(row),
    })),
    width: Math.max(0, ...numbers.map(number => String(number ?? '').length)),
  }
}

/** The five parts of a row's line, in order: the indent, the mark of the cited row, the number, the marker and the code. A report that colors a part writes them one by one. */
export function rowParts(row: EvidenceRow, width: number): [string, string, string, string, string] {
  return [
    '   ',
    row.cited
      ? '>'
      : ' ',
    `  ${row.number.padStart(width)} `,
    row.marker,
    ` ${row.code}`,
  ]
}

/** A row of evidence as a line, uncolored: `   >  42 + db.query(sql)`. */
export function rowText(row: EvidenceRow, width: number): string {
  return rowParts(row, width).join('')
}
