/**
 * What a scanner's report gives the panel, and what it does not: each issue of a report the readers of `src/context/` handed over is
 * counted under exactly one outcome (`IssueOutcome`), and the ones on the change become candidates, findings a scanner proposed that
 * the panel judges like any other. A scanner never decides a verdict, and a report can only add candidates, never remove a finding.
 *
 * Every text of a report is attacker-reachable, so no candidate holds one as written: an issue whose message, rule id, rule text
 * or scanner name holds what reads as a credential, or a text the cleaner cannot settle, is held and sent to no model, and every text
 * a candidate keeps is cleaned (`cleanProse`) and capped (`plainText`). A candidate is checked against the diff as a finding is
 * (`verifyFindings`) and never moved to the code its snippet quotes, since the scanner's line is the scanner's own. No record, gap or
 * detail written here holds a report's file name or text, only code words, numbers and a cleaned scanner name.
 *
 * Everything is pure: the same reports, diff and cap give the same records, candidates and gaps.
 */

import { z } from 'zod'
import { SHA256 } from './documents.ts'
import { hunksOf, nearChange } from './diff.ts'
import { issuePath } from './errors.ts'
import type { ConfigIssue } from './errors.ts'
import { isRecord } from './output.ts'
import { MAX_REPORT_BYTES, MAX_REPORTS, MAX_RESULTS, MAX_RUNS, READ_COMMIT, READ_MESSAGE, READ_RULE_ID, READ_RULE_TEXT, READ_SCANNER, READ_SNIPPET, SONARQUBE_SEARCH_CAP } from './reports.ts'
import { cleanProse } from './sanitize.ts'
import { credentialIn } from './secrets.ts'
import { findingId, rankFingerprint } from './stages/research.ts'
import type { Ranks } from './stages/research.ts'
import type { ContextReport, Finding, IncompleteEntry, IssueLevel, LeftOutFile, ReaderProblem, ReportProblem, ReviewSource, ScannerFound, ScannerIssue, ScannerReport } from './types.ts'
import { MAX_RULE_ID, MAX_SCANNER, plainText, UNCATEGORIZED, verifyFindings } from './verify.ts'

export { MAX_RULE_ID, MAX_SCANNER }

/** The most candidates a profile's panel judges, when the review sets none: the rest are counted `capped`. */
export const DEFAULT_MAX_SCANNER_ISSUES = 50

/** The most characters of a scanner rule's text a candidate's voters read, which the report writes, as the harness caps it. */
export const MAX_SCANNER_RULE = 2048

/** The levels a report gives an issue, most severe first: a profile's candidates past its cap are the least severe, `unknown` last. */
export const LEVEL_ORDER = [
  'error',
  'warning',
  'note',
  'none',
  'unknown',
] as const satisfies readonly IssueLevel[]

/** What a scanner whose name is nothing once cleaned is called. */
const UNNAMED_SCANNER = 'unnamed'

/** The scanner that writes line 1 for every result it cannot place, so its line 1 is no line: compared with the cleaned name, in lower case. */
const TRIVY = 'trivy'

/** A revision a report states that names a commit: 7 to 64 hexadecimal digits, a prefix of the commit in any case. */
const COMMIT_PREFIX = /^[0-9a-f]{7,64}$/i

/** The digits of a commit a message shows. */
const SHORT_COMMIT = 7

/** What each of an issue's outcomes counts, the keys of a report's `issues` record. */
type Counts = NonNullable<ContextReport['issues']>

/** A finding a scanner proposed, less its id and fingerprint, which the review names it by after the finder's findings, and the text of its rule, which only its own voters read. */
export interface Candidate {
  readonly finding: Omit<Finding, 'id' | 'fingerprint'>
  /** The scanner's description of the rule, cleaned and capped at `MAX_SCANNER_RULE`; absent when the report gives none. */
  readonly ruleText?: string
}

/** What a profile's reports gave: the candidates its panel judges, in the reports' order, and the gaps its reports leave. */
export interface ProfileScan {
  readonly candidates: readonly Candidate[]
  readonly gaps: readonly IncompleteEntry[]
}

/** What `scanReports` places the reports' issues against, and with. */
export interface ScanInput {
  readonly reports: readonly ScannerReport[]
  /** The filtered diff's sections: an issue's path must be one of its keys, exactly. */
  readonly sections: ReadonlyMap<string, string>
  /** The files the review left out, whatever their reason. */
  readonly leftOut: readonly LeftOutFile[]
  /** The full id of the reviewed commit; absent for a review that names none (a diff file, an estimate), whose reports are not checked against it. */
  readonly commit?: string
  /** The most candidates each profile's panel judges. A value that is no positive integer keeps none. */
  readonly maxScannerIssues: number
}

/** What a scan makes of its reports: a record for each in order, and the candidates and gaps of each profile a report names. */
export interface ScanResult {
  readonly records: ContextReport[]
  readonly profiles: ReadonlyMap<string, ProfileScan>
}

/**
 * The commit the review is of, which a report that states one is checked against: a range's `head`, a path review's `commit` and
 * HEAD for local and staged changes. None for a diff file or standard input, and for local changes before a first commit, whose
 * reports are not checked.
 */
export function reviewedCommit(source: ReviewSource): string | undefined {
  switch (source.kind) {
    case 'range':
      return source.head
    case 'paths':
      return source.commit
    case 'local':
    case 'staged':
      return source.head ?? undefined
    case 'diff':
      return undefined
  }
}

/** `read` once for each distinct `text` it is handed: a rule's text that 25 000 issues share is read once. */
function once<T>(read: (text: string) => T): (text: string) => T {
  const known = new Map<string, T>()
  return (text) => {
    if (known.has(text)) return known.get(text) as T
    const value = read(text)
    known.set(text, value)
    return value
  }
}

/**
 * Whether no model may be sent `text`: it holds what reads as a credential as the report gave it or once cleaned (a removed comment
 * can join the two halves of a key), or the cleaner cannot settle it, so what a model would read is unknown.
 */
function isHeld(text: string): boolean {
  const cleaned = cleanProse(text)
  return !cleaned.settled || credentialIn(text) !== undefined || (cleaned.text !== text && credentialIn(cleaned.text) !== undefined)
}

/** Whether the scanner's name, cleaned, is Trivy's in any letter case. */
function isTrivy(scanner: string): boolean {
  return plainText(cleanProse(scanner).text, MAX_SCANNER).toLowerCase() === TRIVY
}

/**
 * The new-file line a file-level issue is placed on: the first added row's line, else the line of the first removed code, which a hunk
 * holds at the next line it shows after the removal, else at the last it shows, else at its start (a deleted file's 0, a hunk that only
 * deletes). Undefined when no hunk of the file adds or removes a line (a rename, a mode change).
 */
function firstChangedLine(sections: ReadonlyMap<string, string>, path: string): number | undefined {
  const text = sections.get(path)
  if (text === undefined) return undefined
  const hunks = hunksOf(sections, path, text)
  for (const hunk of hunks) {
    const added = hunk.rowOfLine.findIndex(at => hunk.rows[at].startsWith('+'))
    if (added !== -1) return hunk.start + added
  }
  for (const hunk of hunks) {
    const removed = hunk.rows.findIndex(row => row.startsWith('-'))
    if (removed === -1) continue
    const next = hunk.rowOfLine.findIndex(at => at > removed)
    return hunk.start + (next === -1
      ? Math.max(hunk.rowOfLine.length - 1, 0)
      : next)
  }
  return undefined
}

/** What a scan works out of a report's texts, each once for each distinct text. */
interface Texts {
  readonly held: (text: string) => boolean
  readonly trivy: (scanner: string) => boolean
}

/**
 * The reads of the texts of each reports array, which a scan is handed again by a review that estimates before it reviews, or estimates
 * more than once: the cleaning and the credential checks over up to 16 reports of 16 MiB are done once for the array, not once for each scan.
 * A text's answer depends on the text alone, so the answers are the same for any scan; they are held for as long as the array is.
 */
const TEXTS = new WeakMap<readonly ScannerReport[], Texts>()

/** The reads of `reports`' texts, made on the first scan of the array and kept for every later one. */
function textsOf(reports: readonly ScannerReport[]): Texts {
  const known = TEXTS.get(reports)
  if (known !== undefined) return known
  const texts: Texts = {
    held: once(isHeld),
    trivy: once(isTrivy),
  }
  TEXTS.set(reports, texts)
  return texts
}

/** What the issues of a scan are placed against, with what is worked out once for each text and each file. */
interface Placing {
  readonly sections: ReadonlyMap<string, string>
  readonly left: ReadonlySet<string>
  readonly held: (text: string) => boolean
  readonly trivy: (scanner: string) => boolean
  readonly firstChange: (path: string) => number | undefined
}

/** An issue that is a candidate before the cap: where it stands, and whether it is on its file's first changed line for want of a line. */
interface Used {
  readonly issue: ScannerIssue
  readonly path: string
  readonly line: number
  readonly fileLevel: boolean
}

/** Where an issue ends: an outcome of its own, or a candidate. */
type Placed = { readonly outcome: 'held' | 'unmapped' | 'notInChange' | 'leftOut' | 'unchanged' } | ({ readonly outcome: 'used' } & Used)

/** Whether any text of the issue is one no model may be sent. */
function holdsText(issue: ScannerIssue, held: Placing['held']): boolean {
  return held(issue.message) || held(issue.ruleId) || held(issue.scanner) || (issue.ruleText !== undefined && held(issue.ruleText))
}

/**
 * The outcome of one issue, the first that holds, in this order: `held`; `unmapped`; `leftOut` (the file is one the review left out,
 * which is before `notInChange`, so a skipped lockfile is counted as the file listed and not as outside the change); `notInChange`
 * (no path, or a path that is no key of the diff's sections, exactly and never by suffix); then, for a file of the diff, `used` at its
 * line when the line is near the change (`nearChange`), `used` on the file's first changed line, as file-level, when the issue has no
 * usable line (none, 0, or Trivy's 1), else `unchanged`, which is also a file-level issue on a file with no changed line.
 */
function place(issue: ScannerIssue, at: Placing): Placed {
  if (holdsText(issue, at.held)) return { outcome: 'held' }
  if (issue.unmapped === true) return { outcome: 'unmapped' }
  const { path, line } = issue
  if (path === undefined || path === '') return { outcome: 'notInChange' }
  if (at.left.has(path)) return { outcome: 'leftOut' }
  if (!at.sections.has(path)) return { outcome: 'notInChange' }
  if (line === undefined || line === 0 || (line === 1 && at.trivy(issue.scanner))) {
    const first = at.firstChange(path)
    return first === undefined
      ? { outcome: 'unchanged' }
      : {
          outcome: 'used',
          issue,
          path,
          line: first,
          fileLevel: true,
        }
  }
  return nearChange(at.sections, path, line)
    ? {
        outcome: 'used',
        issue,
        path,
        line,
        fileLevel: false,
      }
    : { outcome: 'unchanged' }
}

/** What a report states of the commit it was made at, as the review reads it. */
interface CommitRead {
  /** The commit the record holds: the one that refused the report when it is a commit id, else the first stated; never a text that is no commit id. */
  readonly commit?: string
  /** The report states another commit than the reviewed one, or a revision that is no commit id, and is refused whole. */
  readonly refused: boolean
}

/**
 * The commit a report states, checked against `reviewed` when there is one: it matches when every revision a run states is 7 to 64
 * hexadecimal digits, in any case, and the reviewed commit starts with it in lower case. A report any of whose runs states another
 * one, or a value that is no such prefix, is refused whole. Without a reviewed commit none is checked and the first commit id a
 * report states is recorded. A text that is no commit id is the report's own and is never recorded.
 */
function readCommit(stated: readonly string[] | undefined, reviewed: string | undefined): CommitRead {
  const wanted = (stated ?? []).map(revision => COMMIT_PREFIX.test(revision)
    ? revision.toLowerCase()
    : undefined)
  const lowered = reviewed?.toLowerCase()
  const wrong = lowered === undefined
    ? -1
    : wanted.findIndex(revision => revision === undefined || !lowered.startsWith(revision))
  if (wrong !== -1) {
    const offender = wanted[wrong]
    return offender === undefined
      ? { refused: true }
      : { commit: offender, refused: true }
  }
  const first = wanted.find(revision => revision !== undefined)
  return first === undefined
    ? { refused: false }
    : { commit: first, refused: false }
}

/** The problems that leave nothing of a report used: it is not read, is no report of its format, holds no result list, or is of another commit. */
const UNREADABLE_PROBLEMS: ReadonlySet<ReportProblem> = new Set<ReportProblem>([
  'missing',
  'cannot-read',
  'not-a-file',
  'too-large',
  'not-the-format',
  'no-results',
  'another-commit',
])

/** The count of each outcome of a report that has none yet. */
function emptyCounts(): Counts {
  return {
    listed: 0,
    used: 0,
    fileLevel: 0,
    held: 0,
    unmapped: 0,
    notInChange: 0,
    leftOut: 0,
    unchanged: 0,
    capped: 0,
    skipped: 0,
    unreadable: 0,
  }
}

/** One report as the scan works on it, until its record is written. */
interface Reading {
  readonly report: ScannerReport
  readonly commit: CommitRead
  readonly refused: boolean
  readonly counts: Counts
  readonly used: Used[]
}

/** A report read: refused whole, it places nothing and holds what its reader counted; else each of its issues is placed in order. */
function readReport(report: ScannerReport, reviewed: string | undefined, at: Placing): Reading {
  const commit = readCommit(report.commits, reviewed)
  const refused = commit.refused || report.problems.some(problem => UNREADABLE_PROBLEMS.has(problem))
  const counts = emptyCounts()
  const used: Used[] = []
  const notRead = report.notRead ?? 0
  counts.skipped = report.skipped
  counts.unreadable = report.unreadable
  counts.listed = report.skipped + report.unreadable + notRead
  if (notRead > 0) counts.notRead = notRead
  if (!refused) {
    counts.listed += report.issues.length
    for (const issue of report.issues) {
      const placed = place(issue, at)
      counts[placed.outcome] += 1
      if (placed.outcome === 'used') {
        used.push(placed)
        if (placed.fileLevel) counts.fileLevel += 1
      }
    }
  }
  return {
    report,
    commit,
    refused,
    counts,
    used,
  }
}

/** `level`'s place in `LEVEL_ORDER`, and past the last for a level that is none of them. */
function levelRank(level: IssueLevel): number {
  const at = LEVEL_ORDER.indexOf(level)
  return at === -1
    ? LEVEL_ORDER.length
    : at
}

/** A candidate before the cap: the place of the report it came from, from 0, and the issue placed on the change. */
interface Entry {
  readonly report: number
  readonly used: Used
}

/**
 * The entries a profile's panel keeps: at most `max`, the most severe first and the reports' order among those of one level (the
 * entries are in it), returned as the set of their places in `entries` so the ones kept go on in the reports' order. A `max` that is no
 * positive integer keeps none.
 */
function keptBy(entries: readonly Entry[], max: number): ReadonlySet<number> {
  const room = Number.isInteger(max) && max > 0
    ? max
    : 0
  const ranked = entries.map((entry, at) => ({
    at,
    rank: levelRank(entry.used.issue.level),
  }))
  ranked.sort((first, second) => first.rank - second.rank || first.at - second.at)
  return new Set(ranked.slice(0, room).map(({ at }) => at))
}

/**
 * The candidate an issue that is used becomes: its path and line the diff's, its summary and category (the rule id) cleaned and capped
 * as a finding's are, its snippet the quote `verifyFindings` compares with the evidence there, and a `foundBy` that says what found
 * it. The check never moves it, and cannot drop it: its line is one a hunk shows (`nearChange`).
 */
function candidateOf(entry: Entry, profile: string, sections: ReadonlyMap<string, string>): Candidate {
  const { issue, path, line, fileLevel } = entry.used
  const ruleId = cleanProse(issue.ruleId).text
  const [verified] = verifyFindings([
    {
      file: path,
      line,
      category: ruleId,
      quote: issue.snippet ?? '',
      summary: cleanProse(issue.message).text,
    },
  ], sections, { anchor: false }).findings
  const foundBy: ScannerFound = {
    kind: 'scanner',
    report: entry.report,
    scanner: plainText(cleanProse(issue.scanner).text, MAX_SCANNER) || UNNAMED_SCANNER,
    ruleId: plainText(ruleId, MAX_RULE_ID) || UNCATEGORIZED,
    level: issue.level,
    ...fileLevel
      ? { fileLevel: true }
      : {},
    ...issue.suppressed === true
      ? { suppressed: true }
      : {},
  }
  const ruleText = issue.ruleText === undefined
    ? ''
    : plainText(cleanProse(issue.ruleText).text, MAX_SCANNER_RULE)
  return {
    finding: { profile, ...verified, foundBy },
    ...ruleText === ''
      ? {}
      : { ruleText },
  }
}

/** The words of the record's problems, in the order of `problems`, joined by `; `. */
function wordsOf(problems: readonly ReportProblem[], say: (problem: ReportProblem) => string | undefined): string {
  return problems.flatMap(problem => say(problem) ?? []).join('; ')
}

/** A commit as a message shows it: its first 7 digits, in lower case. */
function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT).toLowerCase()
}

/** What `another-commit` says: the commit the report states, or that it states no commit id, and, when the review's commit is known, that. */
function commitWords(stated: string | undefined, reviewed: string | undefined): string {
  const states = stated === undefined
    ? 'it states a revision that is no commit id'
    : `it states the commit ${shortCommit(stated)}`
  return reviewed === undefined
    ? states
    : `${states}, and the review is of ${shortCommit(reviewed)}`
}

/** The fixed words of the problems that leave a report unreadable, but the two that depend on the record. */
const UNREADABLE_WORDS: Readonly<Partial<Record<ReportProblem, string>>> = {
  missing: 'the file does not exist',
  'cannot-read': 'the file cannot be read',
  'not-a-file': 'it is a symbolic link or no regular file, which quorum does not read',
  'too-large': `it is over ${MAX_REPORT_BYTES / (1024 * 1024)} MiB`,
  'no-results': 'no run holds a result list, so its scanner failed',
}

/** What `not-the-format` says, by the report's format. */
const NOT_THE_FORMAT: Readonly<Record<ContextReport['format'], string>> = {
  sarif: 'it is no SARIF 2.1.0 log',
  sonarqube: 'it is no saved api/issues/search response',
}

/** The words of a problem that leaves a report unreadable. */
function unreadableWords(record: ContextReport, problem: ReportProblem, reviewed: string | undefined): string | undefined {
  if (problem === 'not-the-format') return NOT_THE_FORMAT[record.format]
  if (problem === 'another-commit') return commitWords(record.commit, reviewed)
  return UNREADABLE_WORDS[problem]
}

/** What a reader says of a report that the record does not hold: `total`, the issues a truncated search found, and `runs`, a log's runs when it holds more than are read. */
type ReaderFacts = Pick<ScannerReport, 'total' | 'runs'>

/**
 * What `too-many` says, each count as `<r> of its <t>`: the results (`issues` for a SonarQube response) the reader did not read, from
 * the record's counts, and the log's runs past `MAX_RUNS`, from `runs`, joined by ` and ` and ending `were not read` (`3000 of its
 * 28000 results and 5 of its 25 runs were not read`). A reader that gave neither says the limits.
 */
function tooManyWords(record: ContextReport, runs: number | undefined): string {
  const unit = record.format === 'sarif'
    ? 'results'
    : 'issues'
  const counts = record.issues
  const missing = [
    ...counts !== undefined && (counts.notRead ?? 0) > 0
      ? [`${counts.notRead} of its ${counts.listed} ${unit}`]
      : [],
    ...runs !== undefined && runs > MAX_RUNS
      ? [`${runs - MAX_RUNS} of its ${runs} runs`]
      : [],
  ]
  return missing.length === 0
    ? `it holds more than ${MAX_RUNS} runs, or more than ${MAX_RESULTS} results in a run, and the rest was not read`
    : `${missing.join(' and ')} were not read`
}

/** The words of a problem that leaves a report read in part. */
function partialWords(record: ContextReport, problem: ReportProblem, { total, runs }: ReaderFacts): string | undefined {
  const counts = record.issues
  switch (problem) {
    case 'truncated':
      if (total === undefined) return 'it holds fewer issues than its search found'
      return `it holds ${counts?.listed ?? 0} of the ${total} issues its search found${total > SONARQUBE_SEARCH_CAP
        ? `, past the ${SONARQUBE_SEARCH_CAP} a SonarQube search returns at most: narrow the query`
        : ''}`
    case 'too-many':
      return tooManyWords(record, runs)
    case 'scanner-failed':
      return 'a run says its scanner failed, or holds no result list'
    case 'unreadable-entries':
      return counts === undefined
        ? undefined
        : `${counts.unreadable} of its ${counts.listed} entries could not be read`
    case 'unmapped-paths':
      return counts === undefined
        ? undefined
        : `${counts.unmapped} issue(s) name a path quorum could not place in the repository`
    case 'held-text':
      return counts === undefined
        ? undefined
        : `${counts.held} issue(s) hold what reads as a credential, so no model was sent them`
    default:
      return undefined
  }
}

/**
 * The gap a report leaves for the profile it feeds, at its place `place` from 1 among the review's reports, none when it was read:
 * `report-unreadable` for one nothing of which was used, with `report <n> (<format>) could not be read: <words>`, and
 * `report-partial` for one read in part, with `report <n> (<format>) was read in part: <words>`, the words of each of its problems
 * joined by `; `. `read` is what the report's reader says that its record does not (`total`, what a truncated search found, and
 * `runs`), `reviewed` the commit of the review, which a refusal for another commit names. Every word is quorum's, and every number
 * a count: no detail holds a report's file name or text.
 */
export function reportGaps(record: ContextReport, place: number, profile: string, read: ReaderFacts = {}, reviewed?: string): IncompleteEntry[] {
  if (record.status === 'read') return []
  const head = `report ${place} (${record.format})`
  if (record.status === 'unreadable') {
    const words = wordsOf(record.problems, problem => unreadableWords(record, problem, reviewed))
    return [
      { profile, reason: 'report-unreadable', detail: `${head} could not be read: ${words}` },
    ]
  }
  const words = wordsOf(record.problems, problem => partialWords(record, problem, read))
  return [
    { profile, reason: 'report-partial', detail: `${head} was read in part: ${words}` },
  ]
}

/** The record of a report, once its issues are counted: code words and numbers, the cleaned scanner name unless it holds a credential, and no path or text of the report. */
function recordOf(reading: Reading, held: Placing['held']): ContextReport {
  const { report, commit, refused, counts } = reading
  const problems: ReportProblem[] = [
    ...new Set(report.problems),
  ]
  if (commit.refused) problems.push('another-commit')
  if (report.unreadable > 0) problems.push('unreadable-entries')
  if (counts.unmapped > 0) problems.push('unmapped-paths')
  if (counts.held > 0) problems.push('held-text')
  const scanner = report.scanner === undefined || held(report.scanner)
    ? ''
    : plainText(cleanProse(report.scanner).text, MAX_SCANNER)
  return {
    format: report.format,
    profile: report.profile,
    ...scanner === ''
      ? {}
      : { scanner },
    ...commit.commit === undefined
      ? {}
      : { commit: commit.commit },
    ...report.sha256 === undefined
      ? {}
      : { sha256: report.sha256 },
    status: refused
      ? 'unreadable'
      : problems.length > 0
        ? 'partial'
        : 'read',
    problems,
    issues: counts,
  }
}

/** The gap a profile's cap leaves: how many of the candidates on the change were not reviewed. */
function cappedGap(profile: string, capped: number, candidates: number, max: number): IncompleteEntry {
  return { profile, reason: 'issues-capped', detail: `${capped} of ${candidates} scanner issues on the change were not reviewed (the cap is ${max})` }
}

/** A profile's candidates after its cap, and how many were on the change before it. */
interface Capped {
  readonly candidates: Candidate[]
  readonly total: number
}

/**
 * Cap one profile's entries, in the order of its reports: the candidates kept, and the entries past the cap counted `capped` (and no
 * longer `used`, nor `fileLevel`) in the report that held each.
 */
function capProfile(entries: readonly Entry[], profile: string, input: ScanInput, readings: readonly Reading[]): Capped {
  const kept = keptBy(entries, input.maxScannerIssues)
  const candidates: Candidate[] = []
  for (const [place, entry] of entries.entries()) {
    if (kept.has(place)) {
      candidates.push(candidateOf(entry, profile, input.sections))
      continue
    }
    const { counts } = readings[entry.report]
    counts.used -= 1
    counts.capped += 1
    if (entry.used.fileLevel) counts.fileLevel -= 1
  }
  return { candidates, total: entries.length }
}

/**
 * What a review's scanner reports give it: one record for each report, in order, and for each profile a report names (in the order
 * the reports first name them) its candidates and its gaps. Each issue is counted under one outcome (see `place`); a report that
 * states another commit than `input.commit`, or a revision that is no commit id, is refused whole, and an unreadable report places no
 * issue. The candidates of a profile are capped at `maxScannerIssues`, the most severe kept (`LEVEL_ORDER`, then the reports' order),
 * the ones past it counted `capped` in the report that held them; the ones kept go on in the reports' order. A profile's gaps are
 * its reports' (`reportGaps`), then `issues-capped`. A profile no report names has no entry.
 */
export function scanReports(input: ScanInput): ScanResult {
  const { reports, sections, leftOut, commit } = input
  const at: Placing = {
    sections,
    left: new Set(leftOut.flatMap(({ file }) => file === ''
      ? []
      : [file])),
    ...textsOf(reports),
    firstChange: once((path) => {
      const first = firstChangedLine(sections, path)
      return first !== undefined && nearChange(sections, path, first)
        ? first
        : undefined
    }),
  }
  const readings = reports.map(report => readReport(report, commit, at))
  const places = new Map<string, number[]>()
  for (const [index, { report }] of readings.entries()) {
    places.set(report.profile, [
      ...places.get(report.profile) ?? [],
      index,
    ])
  }
  const capped = new Map<string, Capped>()
  for (const [profile, indexes] of places) {
    const entries = indexes.flatMap(report => readings[report].used.map((used): Entry => ({ report, used })))
    capped.set(profile, capProfile(entries, profile, input, readings))
  }
  const records = readings.map(reading => recordOf(reading, at.held))
  const profiles = new Map<string, ProfileScan>()
  for (const [profile, indexes] of places) {
    const { candidates, total } = capped.get(profile) as Capped
    const gaps = indexes.flatMap(index => reportGaps(records[index], index + 1, profile, reports[index], commit))
    if (candidates.length < total) gaps.push(cappedGap(profile, total - candidates.length, total, input.maxScannerIssues))
    profiles.set(profile, { candidates, gaps })
  }
  return { records, profiles }
}

/**
 * What a profile's panel receives of its candidates: each named as the finder's findings are, with its `id` and its `fingerprint`,
 * ranked in `ranks`, the map the finder's findings were ranked in, so a candidate and a finding that share a fingerprint's hash keep a
 * rank each. A file-level candidate stands on its file's first changed line for want of a line of its own, so its fingerprint holds
 * no row, and a push that moves that line keeps its name. `ruleTexts` holds each candidate's rule text, when its report gives one, by the
 * candidate's id: the first candidate of an id that two share is the only one that counts, so a later candidate's text is never shown
 * with the first one's claim, and an id whose first candidate has no text has none. Pure but for `ranks`, which it extends.
 */
export function candidateFindings(profile: string, candidates: readonly Candidate[], ranks: Ranks): { readonly findings: Finding[], readonly ruleTexts: Map<string, string> } {
  const ruleTexts = new Map<string, string>()
  const seen = new Set<string>()
  const findings = candidates.map(({ finding, ruleText }): Finding => {
    const id = findingId(profile, finding.file, finding.line, finding.category)
    const fileLevel = finding.foundBy.kind === 'scanner' && finding.foundBy.fileLevel === true
    if (!seen.has(id)) {
      seen.add(id)
      if (ruleText !== undefined) ruleTexts.set(id, ruleText)
    }
    return {
      id,
      fingerprint: rankFingerprint(ranks, profile, finding, fileLevel
        ? ''
        : undefined),
      ...finding,
    }
  })
  return { findings, ruleTexts }
}

/** The text a report is refused with when its shape is not the one the readers hand over. */
const NOT_A_REPORT = 'must be a scanner report as readContext reads it'

/** The problems the readers write, as a list zod reads. */
export const READER_PROBLEMS = [
  'missing',
  'cannot-read',
  'not-a-file',
  'too-large',
  'not-the-format',
  'no-results',
  'truncated',
  'too-many',
  'scanner-failed',
] as const satisfies readonly ReaderProblem[]

/** Every problem a report's record can hold, as a list zod reads: the readers' and the four the core finds. */
export const REPORT_PROBLEMS = [
  ...READER_PROBLEMS,
  'another-commit',
  'unreadable-entries',
  'unmapped-paths',
  'held-text',
] as const satisfies readonly ReportProblem[]

const count = z.int().min(0)

/** One issue, as a reader hands it over: each text within the bound the reader cuts it to, and no field a reader does not write. */
const issueSchema = z.strictObject({
  path: z.string().optional(),
  unmapped: z.literal(true).optional(),
  line: count.optional(),
  scanner: z.string().max(READ_SCANNER),
  ruleId: z.string().max(READ_RULE_ID),
  ruleText: z.string().max(READ_RULE_TEXT).optional(),
  message: z.string().max(READ_MESSAGE),
  level: z.enum(LEVEL_ORDER),
  suppressed: z.literal(true).optional(),
  snippet: z.string().max(READ_SNIPPET).optional(),
})

/** One report, as a reader hands it over: a log of 20 runs of 25 000 results holds at most that many issues. */
const reportSchema = z.strictObject({
  format: z.enum(['sarif', 'sonarqube']),
  profile: z.string(),
  sha256: z.string().regex(SHA256).optional(),
  scanner: z.string().max(READ_SCANNER).optional(),
  commits: z.array(z.string().max(READ_COMMIT)).optional(),
  problems: z.array(z.enum(READER_PROBLEMS)).max(READER_PROBLEMS.length),
  total: count.optional(),
  skipped: count,
  unreadable: count,
  notRead: count.optional(),
  runs: count.optional(),
  issues: z.array(issueSchema).max(MAX_RUNS * MAX_RESULTS),
})

/** The problems of one report: its shape, by the path of the first field that does not match and never a value, and its profile. */
function oneReportIssues(report: unknown, path: string, profiles: ReadonlySet<string>): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const read = reportSchema.safeParse(report)
  if (!read.success) {
    const where = issuePath(read.error.issues[0]?.path ?? [])
    issues.push({
      path,
      message: where === ''
        ? NOT_A_REPORT
        : `${NOT_A_REPORT}: ${where} does not match`,
    })
  }
  if (isRecord(report) && typeof report.profile === 'string' && !profiles.has(report.profile)) {
    issues.push({ path: `${path}.profile`, message: 'names no profile of the quorum' })
  }
  return issues
}

/**
 * Every problem with the reports a review's context holds, which an untyped caller can hand over as anything: a list of at most 16
 * (`MAX_REPORTS`), at `root`, then each report's own problems at `<root>.<n>`: a shape other than the readers' (the path of the first
 * field that does not match, which is never a value, and each text within the bound its reader cuts it to), and, at `<root>.<n>.profile`,
 * a profile that is none of `profiles`.
 */
export function scannerReportIssues(reports: unknown, root: string, profiles: ReadonlySet<string>): ConfigIssue[] {
  if (!Array.isArray(reports) || reports.length > MAX_REPORTS) {
    return [
      { path: root, message: `must be an array of at most ${MAX_REPORTS} scanner reports` },
    ]
  }
  return Array.from<unknown>(reports).flatMap((report, index) => oneReportIssues(report, `${root}.${index}`, profiles))
}
