/**
 * The text report: what a review came to, written for a person on a terminal. Its lines come in this order:
 *
 * 1. a header, what was reviewed;
 * 2. the findings, kept and unreviewed together, grouped by file and then by line, each with its claim, its
 *    evidence rows and how its lenses voted, and, under its head, the line its finder cited when the harness
 *    moved it to its quote; the discarded ones are only counted;
 * 3. each profile's level, counts and coverage;
 * 4. the files left out;
 * 5. the gaps;
 * 6. the flags;
 * 7. the time and the tokens;
 * 8. the verdict, which says what the exit code says.
 *
 * The report of a public view (`publicView`) is the same but for two lines: a gap is written in the fixed words of
 * its reason, as it has no detail, and the time has no token count, as the view has no usage.
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
import type { Outcome } from '../core/outcome.ts'
import { inertLine, showHidden } from '../core/sanitize.ts'
import type { IncompleteEntry, LeftOutFile, PublicGap, PublicMeta, PublicVerdict, QuorumMeta, Verdict } from '../core/types.ts'
import { byLocation, coverageWords, evidenceRows, flagWhere, GAP_WORDS, leftOutEntry, levelWord, plural, rowParts, sourcePhrase, verdictWhy, votesWords } from './lines.ts'
import type { Reporter, ReportInput } from './reporter.ts'
import { discardedOf, isPublicView } from './view.ts'

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
  interrupted: '33',
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

/** The header: the version, the source, the profiles that ran, and how many files the diff holds, by the first profile's coverage. */
function headerLine(meta: QuorumMeta | PublicMeta): string {
  const profiles = Object.values(meta.profiles)
  return inertLine(`quorum ${meta.version} · ${sourcePhrase(meta.source, shortId)} · ${Object.keys(meta.profiles).join(', ')} · ${plural(profiles[0]?.coverage.length ?? 0, 'file')}`)
}

/** The level word of a finding: its confidence when kept, `UNREVIEWED` when its failed votes left it undecided, `KEPT` for a kept finding with no confidence. */
function levelPiece(verdict: Verdict | PublicVerdict, kept: boolean): Piece {
  if (!kept) return { text: 'UNREVIEWED', style: 'unreviewed' }
  const word = levelWord(verdict)
  switch (word) {
    case 'HIGH':
      return { text: word, style: 'high' }
    case 'MEDIUM':
      return { text: word, style: 'medium' }
    case 'LOW':
      return { text: word, style: 'low' }
    default:
      return { text: 'KEPT' }
  }
}

/** The lines of a finding's evidence: the cited row marked with `>`, and the added and context rows numbered from the cited line, a removed row with no number. */
function evidenceLines(verdict: Verdict | PublicVerdict, color: boolean): string[] {
  const { rows, width } = evidenceRows(verdict)
  return rows.map((row) => {
    const [indent, mark, number, marker, code] = rowParts(row, width)
    return line([
      { text: indent },
      row.cited
        ? { text: mark, style: 'bold' }
        : { text: mark },
      { text: number },
      marker === '+' || marker === '-'
        ? {
            text: marker,
            style: marker === '+'
              ? 'added'
              : 'removed',
          }
        : { text: marker },
      { text: code },
    ], color)
  })
}

/** Where the finder cited a finding the harness moved to its quote, which is its line: the line right under its head, none for a finding that stayed where it was cited. */
function citedLines(verdict: Verdict | PublicVerdict): string[] {
  return verdict.citedLine === undefined
    ? []
    : [
        inertLine(`  cited at line ${verdict.citedLine}; its quote is at ${verdict.line}`),
      ]
}

/** A finding's block: its head, where it was cited when it moved, its claim, its evidence rows, its votes and a blank line. */
function findingLines(verdict: Verdict | PublicVerdict, kept: boolean, color: boolean): string[] {
  return [
    line([
      levelPiece(verdict, kept),
      { text: `  ${verdict.profile}  ` },
      { text: `${pathText(verdict.file)}:${verdict.line}`, style: 'bold' },
      { text: `  ${verdict.category}` },
    ], color),
    ...citedLines(verdict),
    ...wrap('  ', verdict.summary).map(inertLine),
    ...evidenceLines(verdict, color),
    inertLine(`  ${votesWords(verdict)}`),
    '',
  ]
}

/** The kept findings and then the unreviewed ones, stable-sorted by file and then by line, so a kept one stays before an unreviewed one at the same place. */
function orderedFindings(input: ReportInput): Array<{ verdict: Verdict | PublicVerdict, kept: boolean }> {
  return [
    ...(input.kept as ReadonlyArray<Verdict | PublicVerdict>).map(verdict => ({ verdict, kept: true })),
    ...(input.unreviewed as ReadonlyArray<Verdict | PublicVerdict>).map(verdict => ({ verdict, kept: false })),
  ].sort((a, b) => byLocation(a.verdict, b.verdict))
}

/** Each profile in run order: its fail-on level and its counts, with the findings it dropped for citing code outside the diff, then its coverage. A public view's discarded count is the one it records. */
function profileLines(result: ReportInput): string[] {
  return Object.entries(result.meta.profiles).flatMap(([id, profile]) => {
    const count = (verdicts: ReadonlyArray<Verdict | PublicVerdict>): number => verdicts.filter(verdict => verdict.profile === id).length
    const outside = profile.invalidFindings > 0
      ? `, ${profile.invalidFindings} outside the diff`
      : ''
    return [
      inertLine(`${id} (fail-on ${profileFailOn(result, id)}): ${count(result.kept as ReadonlyArray<Verdict | PublicVerdict>)} kept, ${count(result.unreviewed as ReadonlyArray<Verdict | PublicVerdict>)} unreviewed, ${discardedOf(result, id)} discarded${outside}`),
      inertLine(`  ${coverageWords(profile.coverage)}`),
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

/** How long the review took and what it used: the tokens in and out, and the cost when the usage holds one, or that none was reported. A public view has no usage, so its line is the time alone. */
function timeLine(input: ReportInput): string {
  const { meta } = input
  if (isPublicView(input)) return inertLine(`took ${durationText(meta.durationMs)}`)
  const { usage } = input.meta
  const cost = usage?.costUsd === undefined
    ? ''
    : `, $${usage.costUsd.toFixed(4)}`
  const used = usage === undefined
    ? 'no token count reported'
    : `${usage.inputTokens} tokens in and ${usage.outputTokens} out${cost}`
  return inertLine(`took ${durationText(meta.durationMs)}, ${used}`)
}

/** A gap's lines: `gap: <profile> <reason>` and its detail wrapped after a comma, or the head alone, with no comma, when the detail is empty or only white space. */
function gapLines(gap: IncompleteEntry): string[] {
  return gap.detail.trim() === ''
    ? [`gap: ${gap.profile} ${gap.reason}`]
    : wrap(`gap: ${gap.profile} ${gap.reason},`, gap.detail)
}

/** A public view's gap lines: `gap: <profile> <reason>`, then ` at <file>` when it has one, and the fixed words of its reason wrapped after a comma. */
function publicGapLines(gap: PublicGap): string[] {
  const at = gap.file === undefined
    ? ''
    : ` at ${JSON.stringify(gap.file)}`
  return wrap(`gap: ${gap.profile} ${gap.reason}${at},`, GAP_WORDS[gap.reason])
}

/** The last line: the exit code, the status and why, from the one outcome the exit code is made of. */
function verdictLine(outcome: Outcome, color: boolean): string {
  return line([
    { text: `exit ${outcome.exitCode}, ` },
    { text: outcome.status, style: outcome.status },
    { text: `: ${verdictWhy(outcome)}` },
  ], color)
}

/**
 * The review as a person reads it on a terminal: the header, the findings with their evidence, the profiles'
 * counts and coverage, what was left out, the gaps, the flags, the time and the tokens, and last the verdict. See
 * the module's comment for the order. With `color`, only the words quorum wrote are colored: the level, the
 * location, the marker of the cited row, a row's `+` or `-`, and the status word of the verdict. It reads a public
 * view as the result it came from, but for the two lines the module's comment names.
 */
export const text: Reporter = {
  render: (result, { color, outcome }) => {
    const { meta } = result
    const gaps = isPublicView(result)
      ? result.meta.incomplete.flatMap(publicGapLines)
      : result.meta.incomplete.flatMap(gapLines)
    const lines = [
      headerLine(meta),
      '',
      ...orderedFindings(result).flatMap(({ verdict, kept }) => findingLines(verdict, kept, color)),
      ...profileLines(result),
      ...leftOutLines(meta.leftOut),
      ...gaps.map(inertLine),
      ...meta.flags.flatMap(flag => wrap(`flag: ${flag.code}${flagWhere(flag)},`, flag.detail)).map(inertLine),
      timeLine(result),
      verdictLine(outcome, color),
    ]
    return `${lines.join('\n')}\n`
  },
}
