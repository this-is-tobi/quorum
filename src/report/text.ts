/**
 * The text report: what a review came to, written for a person on a terminal. Its lines come in this order:
 *
 * 1. a header, what was reviewed;
 * 2. the findings, kept and unreviewed together, grouped by file and then by line, each with its claim, its
 *    evidence rows and how its lenses voted; the discarded ones are only counted;
 * 3. each profile's level, counts and coverage;
 * 4. the files left out;
 * 5. the gaps;
 * 6. the flags;
 * 7. the time and the tokens;
 * 8. the verdict, which says what the exit code says.
 *
 * The verdict is last because the end of the output is what stays on a terminal's screen, and it is the line
 * a person acts on.
 *
 * Every line is `inertLine` of its text (invariant I3): a claim, a category, a row of code, a file name and a
 * detail are text an attacker may have written. Color decorates only the words quorum wrote, never the text
 * around them: see `line`. No line is longer than 80 code points but for what is never cut: a path, a
 * category, a row of code and a word longer than a line, since a cut could hide code.
 */

import { profileFailOn } from '../core/outcome.ts'
import type { Outcome, OutcomeStatus } from '../core/outcome.ts'
import { inertLine, showHidden } from '../core/sanitize.ts'
import type { CoverageEntry, CoverageStatus, IncompleteEntry, LeftOutFile, QuorumMeta, QuorumResult, ReviewSource, Verdict } from '../core/types.ts'
import { flagWhere, leftOutEntry, plural } from './lines.ts'
import type { Reporter } from './reporter.ts'

/** The width a line of prose wraps at, counted in code points. */
const COLUMNS = 80

/** How many of the files left out the report names; the JSON result lists every one. */
const LISTED_FILES = 5

/** The longest id of a commit the header shows. */
const SHORT_ID = 7

const ESC = String.fromCharCode(0x1B)

/** The SGR parameters of each style a piece takes. The levels and the statuses are the words of the same name. */
const SGR = {
  high: '1;31',
  medium: '33',
  low: '36',
  unreviewed: '35',
  bold: '1',
  added: '32',
  removed: '31',
  findings: '31',
  incomplete: '33',
  pass: '32',
} as const

type Style = keyof typeof SGR

/** A part of a line: its text, and the style it is written in when the line is colored. Only a piece quorum wrote is styled. */
interface Piece {
  readonly text: string
  readonly style?: Style
}

/**
 * One line, from its pieces, as the text report writes it: `inertLine` of the pieces joined. With `color`, each
 * piece passes `showHidden` and each styled one is wrapped in its SGR sequence and the reset, so no sequence is
 * a character of anything an attacker wrote. But `inertLine` also breaks a `::` that starts the line and a `##[`
 * wherever it stands, and the pieces can meet at one: when the colored line's text is not the inert line, the
 * line is written without color.
 */
function line(pieces: readonly Piece[], color: boolean): string {
  const inert = inertLine(pieces.map(piece => piece.text).join(''))
  if (!color) return inert
  const shown = pieces.map(piece => showHidden(piece.text))
  if (shown.join('') !== inert) return inert
  return pieces.map(({ style }, index) => style === undefined
    ? shown[index]
    : `${ESC}[${SGR[style]}m${shown[index]}${ESC}[0m`).join('')
}

/** The width of a text in code points. */
const widthOf = (text: string): number => [...text].length

/**
 * `head`, then the words of `prose`, split at spaces, one space apart, or at once after a head that is only
 * spaces. A word that would take the line past 80 code points starts a new line, indented by two spaces. A word
 * is never cut, so one longer than a line stands alone on its own. A head with no word after it is a line of its
 * own, and a head of spaces with none is no line. The lines are raw: the caller makes each inert.
 */
function wrap(head: string, prose: string): string[] {
  const lines: string[] = []
  let current = head
  let empty = head.trim() === ''
  for (const word of prose.split(' ').filter(piece => piece !== '')) {
    if (empty) {
      current += word
    } else if (widthOf(current) + 1 + widthOf(word) > COLUMNS) {
      lines.push(current)
      current = `  ${word}`
    } else {
      current += ` ${word}`
    }
    empty = false
  }
  if (!empty) lines.push(current)
  return lines
}

/** The path as a column of a line: bare when it holds ASCII letters, digits and `._/@+~=,-` only, so a terminal can link it, else a JSON string, so no space, quote or colon in a name can pass for a column. */
function pathText(path: string): string {
  return /^[\w./@+~=,-]+$/.test(path)
    ? path
    : JSON.stringify(path)
}

/** The first characters of a commit's id, as the header names it. */
const shortId = (id: string): string => id.slice(0, SHORT_ID)

/** What was reviewed, as the header names it. */
function sourceText(source: ReviewSource): string {
  switch (source.kind) {
    case 'diff':
      return 'diff'
    case 'range':
      return `range ${shortId(source.base)}...${shortId(source.head)}`
    case 'local':
    case 'staged':
      return source.head === null
        ? `${source.kind}, no commit yet`
        : `${source.kind} on ${shortId(source.head)}`
    case 'paths':
      return `paths at ${shortId(source.commit)}`
    default:
      return 'source unknown'
  }
}

/** The header: the version, the source, the profiles that ran, and how many files the diff holds, by the first profile's coverage. */
function headerLine(meta: QuorumMeta): string {
  const profiles = Object.values(meta.profiles)
  return inertLine(`quorum ${meta.version} · ${sourceText(meta.source)} · ${Object.keys(meta.profiles).join(', ')} · ${plural(profiles[0]?.coverage.length ?? 0, 'file')}`)
}

/** The level word of a finding: its confidence when kept, `UNREVIEWED` when its failed votes left it undecided. */
function levelPiece(verdict: Verdict, kept: boolean): Piece {
  if (!kept) return { text: 'UNREVIEWED', style: 'unreviewed' }
  switch (verdict.confidence) {
    case 'high':
      return { text: 'HIGH', style: 'high' }
    case 'medium':
      return { text: 'MEDIUM', style: 'medium' }
    case 'low':
      return { text: 'LOW', style: 'low' }
    default:
      return { text: 'KEPT' }
  }
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

/** The lines of a finding's evidence: the cited row marked with `>`, and the added and context rows numbered from the cited line, a removed row with no number. */
function evidenceLines(verdict: Verdict, color: boolean): string[] {
  const rows = verdict.evidence === ''
    ? []
    : verdict.evidence.split('\n')
  const cited = citedRow(rows, verdict.evidenceRow)
  const numbers = cited === undefined
    ? []
    : numberRows(rows, cited, verdict.line)
  const width = Math.max(0, ...numbers.map(number => String(number ?? '').length))
  return rows.map((row, index) => {
    const { marker, code } = splitRow(row)
    return line([
      { text: '   ' },
      index === cited
        ? { text: '>', style: 'bold' }
        : { text: ' ' },
      { text: `  ${String(numbers[index] ?? '').padStart(width)} ` },
      marker === '+' || marker === '-'
        ? {
            text: marker,
            style: marker === '+'
              ? 'added'
              : 'removed',
          }
        : { text: marker },
      { text: ` ${code}` },
    ], color)
  })
}

/** How a finding's lenses voted: how many kept it, and how many votes failed. */
function votesLine(verdict: Verdict): string {
  const failed = verdict.votes.filter(({ vote }) => vote === null).length
  const failures = failed === 0
    ? ''
    : `, ${plural(failed, 'vote')} failed`
  return inertLine(`  kept by ${verdict.keptVotes} of ${plural(verdict.totalVotes, 'lens', 'lenses')}${failures}`)
}

/** A finding's block: its head, its claim, its evidence rows, its votes and a blank line. */
function findingLines(verdict: Verdict, kept: boolean, color: boolean): string[] {
  return [
    line([
      levelPiece(verdict, kept),
      { text: `  ${verdict.profile}  ` },
      { text: `${pathText(verdict.file)}:${verdict.line}`, style: 'bold' },
      { text: `  ${verdict.category}` },
    ], color),
    ...wrap('  ', verdict.summary).map(inertLine),
    ...evidenceLines(verdict, color),
    votesLine(verdict),
    '',
  ]
}

/** `a` before `b` by the order of their UTF-16 code units, which no locale changes. */
function byCodeUnits(a: string, b: string): number {
  return a < b
    ? -1
    : a > b
      ? 1
      : 0
}

/** The kept findings and then the unreviewed ones, stable-sorted by file and then by line, so a kept one stays before an unreviewed one at the same place. */
function orderedFindings(result: QuorumResult): Array<{ verdict: Verdict, kept: boolean }> {
  return [
    ...result.kept.map(verdict => ({ verdict, kept: true })),
    ...result.unreviewed.map(verdict => ({ verdict, kept: false })),
  ].sort((a, b) => byCodeUnits(a.verdict.file, b.verdict.file) || a.verdict.line - b.verdict.line)
}

/** How many of the files a profile's coverage lists are reviewed, in part, not, or excluded, as `  2 of 3 files reviewed, 1 not`. */
function coverageLine(coverage: readonly CoverageEntry[]): string {
  if (coverage.length === 0) return '  the diff holds no file'
  const count = (status: CoverageStatus): number => coverage.filter(entry => entry.status === status).length
  const others = ([
    ['partial', 'in part'],
    ['unreviewed', 'not'],
    ['excluded', 'excluded'],
  ] as const)
    .filter(([status]) => count(status) > 0)
    .map(([status, word]) => `${count(status)} ${word}`)
  return `  ${[`${count('reviewed')} of ${plural(coverage.length, 'file')} reviewed`, ...others].join(', ')}`
}

/** Each profile in run order: its fail-on level and its counts, with the findings it dropped for citing code outside the diff, then its coverage. */
function profileLines(result: QuorumResult): string[] {
  return Object.entries(result.meta.profiles).flatMap(([id, profile]) => {
    const count = (verdicts: readonly Verdict[]): number => verdicts.filter(verdict => verdict.profile === id).length
    const outside = profile.invalidFindings > 0
      ? `, ${profile.invalidFindings} outside the diff`
      : ''
    return [
      inertLine(`${id} (fail-on ${profileFailOn(result, id)}): ${count(result.kept)} kept, ${count(result.unreviewed)} unreviewed, ${count(result.discarded)} discarded${outside}`),
      inertLine(coverageLine(profile.coverage)),
    ]
  })
}

/** The files left out, when there are some: their count, the first five and how many more. */
function leftOutLines(leftOut: readonly LeftOutFile[]): string[] {
  if (leftOut.length === 0) return []
  const more = leftOut.length > LISTED_FILES
    ? [`  and ${leftOut.length - LISTED_FILES} more`]
    : []
  return [
    `left out: ${plural(leftOut.length, 'file')}`,
    ...leftOut.slice(0, LISTED_FILES).map(entry => `  ${leftOutEntry(entry)}`),
    ...more,
  ].map(inertLine)
}

/** A duration for a person: milliseconds under a second, one decimal of a second under ten, else whole seconds. */
function durationText(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const tenths = Math.round(ms / 100)
  return tenths < 100
    ? `${(tenths / 10).toFixed(1)} s`
    : `${Math.round(ms / 1000)} s`
}

/** How long the review took and what it used: the tokens in and out, and the cost when the usage holds one, or that none was reported. */
function timeLine(meta: QuorumMeta): string {
  const { usage } = meta
  const cost = usage?.costUsd === undefined
    ? ''
    : `, $${usage.costUsd.toFixed(4)}`
  const used = usage === undefined
    ? 'no token count reported'
    : `${usage.inputTokens} tokens in and ${usage.outputTokens} out${cost}`
  return inertLine(`took ${durationText(meta.durationMs)}, ${used}`)
}

const WHY: Readonly<Record<OutcomeStatus, string>> = {
  findings: 'a gating profile kept a finding at or above its fail-on level',
  incomplete: 'a gating profile has a gap or an unreviewed finding',
  pass: 'no gating profile kept a finding to fail on, and none has a gap',
}

/** A gap's lines: `gap: <profile> <reason>` and its detail wrapped after a comma, or the head alone, with no comma, when the detail is empty or only white space. */
function gapLines(gap: IncompleteEntry): string[] {
  return gap.detail.trim() === ''
    ? [`gap: ${gap.profile} ${gap.reason}`]
    : wrap(`gap: ${gap.profile} ${gap.reason},`, gap.detail)
}

/** The last line: the exit code, the status and why, from the one outcome the exit code is made of. */
function verdictLine(outcome: Outcome, color: boolean): string {
  const why = outcome.status === 'pass' && outcome.lifted
    ? 'incomplete, but --allow-incomplete lifted every gap'
    : WHY[outcome.status]
  return line([
    { text: `exit ${outcome.exitCode}, ` },
    { text: outcome.status, style: outcome.status },
    { text: `: ${why}` },
  ], color)
}

/**
 * The review as a person reads it on a terminal: the header, the findings with their evidence, the profiles'
 * counts and coverage, what was left out, the gaps, the flags, the time and the tokens, and last the verdict. See
 * the module's comment for the order. With `color`, only the words quorum wrote are colored: the level, the
 * location, the marker of the cited row, a row's `+` or `-`, and the status word of the verdict.
 */
export const text: Reporter = {
  render: (result, { color, outcome }) => {
    const { meta } = result
    const lines = [
      headerLine(meta),
      '',
      ...orderedFindings(result).flatMap(({ verdict, kept }) => findingLines(verdict, kept, color)),
      ...profileLines(result),
      ...leftOutLines(meta.leftOut),
      ...meta.incomplete.flatMap(gapLines).map(inertLine),
      ...meta.flags.flatMap(flag => wrap(`flag: ${flag.code}${flagWhere(flag)},`, flag.detail)).map(inertLine),
      timeLine(meta),
      verdictLine(outcome, color),
    ]
    return `${lines.join('\n')}\n`
  },
}
