/**
 * The pieces of a line that the text report, the Markdown summary and the progress lines of the CLI write one
 * way: how many of a thing, a file left out, where a flag points, the words of a gap, the words of a verdict, a
 * source, a finding's level and votes, its place among the findings and its evidence's rows. None makes its text
 * inert: a file name is a diff's and a flag's detail a diff's too, so the line that holds them passes through
 * `inertLine` whole.
 */

import { ownData } from '../core/facts.ts'
import type { Outcome, OutcomeStatus } from '../core/outcome.ts'
import { failsItsProfile } from '../core/outcome.ts'
import type { CoverageEntry, CoverageStatus, Flag, IncompleteReason, LeftOutFile, PublicVerdict, PublicView, ReviewSource, Verdict, VoteFailure } from '../core/types.ts'
import { voteFailed } from './view.ts'

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

/** Where a flag points: the file as a JSON string, with the line when it has one, else the line alone. */
export function flagWhere({ file, line }: Flag): string {
  if (file !== undefined && line !== undefined) return ` at ${JSON.stringify(file)}:${line}`
  if (file !== undefined) return ` at ${JSON.stringify(file)}`
  if (line !== undefined) return ` at line ${line}`
  return ''
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
