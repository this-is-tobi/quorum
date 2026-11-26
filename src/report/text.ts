/**
 * The text report: what a review came to, written for a person on a terminal. Its lines come in this order:
 *
 * 1. a header, what was reviewed;
 * 2. the findings, kept and unreviewed together, grouped by file and then by line, each with its claim, its
 *    evidence rows and how its lenses voted, its head ending with the review rule it cites, and, under its head, the
 *    line its finder cited when the harness moved it to its quote; the discarded ones are only counted;
 * 3. each profile's level, counts, rules sent and citations refused, coverage and, in a full result, research counts;
 * 4. the documents the review read, one line each, as the log writes them, its tail wrapped as a flag's detail is;
 * 5. the files left out;
 * 6. the gaps;
 * 7. the flags;
 * 8. the time and the tokens, then what each role took (when a stage's time was recorded), then, in a full result, the
 *    models that answered when one is worth saying;
 * 9. the verdict, which says what the exit code says.
 *
 * The report of a public view (`publicView`) is the same but for five kinds of line: a gap is written in the fixed words of
 * its reason, as it has no detail, the time has no token count, as the view has no usage, the by-role line has the roles' times
 * alone, as the view has no calls, a profile has no research line, as the view withholds the counts, and no line names the
 * models that answered, as the view withholds them.
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
import type { ContextDocument, IncompleteEntry, LeftOutFile, PublicGap, PublicMeta, PublicVerdict, QuorumMeta, Verdict } from '../core/types.ts'
import { byLocation, coverageWords, documentLineParts, durationText, evidenceRows, flagWhere, GAP_WORDS, leftOutEntry, levelWord, modelLines, plural, researchWords, roleLine, rowParts, ruleCountWords, ruleWords, sourcePhrase, tokenWords, verdictWhy, votesWords } from './lines.ts'
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

/** The rule a finding cites, as the end of its head: two spaces and `rule <id>`, or no piece for a finding that cites none. The id is the configuration's, so no style marks it. */
function rulePieces(verdict: Verdict | PublicVerdict): Piece[] {
  const rule = ruleWords(verdict)
  return rule === ''
    ? []
    : [
        { text: `  ${rule}` },
      ]
}

/** A finding's block: its head, which ends with the rule it cites, where it was cited when it moved, its claim, its evidence rows, its votes and a blank line. */
function findingLines(verdict: Verdict | PublicVerdict, kept: boolean, color: boolean): string[] {
  return [
    line([
      levelPiece(verdict, kept),
      { text: `  ${verdict.profile}  ` },
      { text: `${pathText(verdict.file)}:${verdict.line}`, style: 'bold' },
      { text: `  ${verdict.category}` },
      ...rulePieces(verdict),
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

/**
 * What a profile that lists a rule says of its rules, after its counts: `; rules: 3 of 5 sent`, then `, 1 citation(s) refused` when
 * some were. A profile that asked nothing (it requires a rule and was sent none) says so, `; rules: 0 of 0 sent, so its research
 * asks nothing`, whether it lists rules or none, since its counts of findings and of files reviewed read as a review that found nothing.
 * Nothing for a profile that lists no rule and requires none.
 */
function rulesClause({ rules, invalidRules, asksNothing }: QuorumMeta['profiles'][string] | PublicMeta['profiles'][string]): string {
  if (rules.listed === 0 && asksNothing !== true) return ''
  const refused = invalidRules > 0
    ? `, ${invalidRules} citation(s) refused`
    : ''
  return `; rules: ${ruleCountWords(rules, asksNothing === true)}${refused}`
}

/** Each profile in run order: its fail-on level and its counts, with the findings it dropped for citing code outside the diff, those a changed-lines profile dropped for standing away from the change, and the rules it sent and the citations refused, wrapped at 80 columns after its head, then its coverage and, in a full result, its research counts, wrapped at 80 columns too. A public view's discarded count is the one it records, and it has no research counts. */
function profileLines(result: ReportInput): string[] {
  const full = isPublicView(result)
    ? undefined
    : result
  return Object.entries(result.meta.profiles).flatMap(([id, profile]) => {
    const count = (verdicts: ReadonlyArray<Verdict | PublicVerdict>): number => verdicts.filter(verdict => verdict.profile === id).length
    const outside = profile.invalidFindings > 0
      ? `, ${profile.invalidFindings} outside the diff`
      : ''
    const away = profile.awayFromChange !== undefined && profile.awayFromChange > 0
      ? `, ${profile.awayFromChange} away from the changed lines`
      : ''
    return [
      ...wrap(`${id} (fail-on ${profileFailOn(result, id)}):`, `${count(result.kept as ReadonlyArray<Verdict | PublicVerdict>)} kept, ${count(result.unreviewed as ReadonlyArray<Verdict | PublicVerdict>)} unreviewed, ${discardedOf(result, id)} discarded${outside}${away}${rulesClause(profile)}`).map(inertLine),
      inertLine(`  ${coverageWords(profile.coverage)}`),
      ...full === undefined
        ? []
        : wrap('  ', researchWords(full.meta.profiles[id].research)).map(inertLine),
    ]
  })
}

/** A document's line, as the log writes it: its head, which holds its path, hash or commit whole, then its tail wrapped at spaces as a flag's detail is. */
function documentLines(record: ContextDocument): string[] {
  const { head, tail } = documentLineParts(record)
  return wrap(head, tail).map(inertLine)
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
    : `${tokenWords(usage.inputTokens)} tokens in and ${tokenWords(usage.outputTokens)} out${cost}`
  return inertLine(`took ${durationText(meta.durationMs)}, ${used}`)
}

/** What each role took, wrapped at 80 columns as a profile's research counts are: none for a review with no stage time. A public view's line holds the times alone. */
function roleLines(input: ReportInput): string[] {
  const words = roleLine(input.meta)
  return words === undefined
    ? []
    : wrap('', words).map(inertLine)
}

/** The models that answered, wrapped at 80 columns as a profile's research counts are: a full result's, and none for a public view, which names none. */
function modelsLines(input: ReportInput): string[] {
  return isPublicView(input)
    ? []
    : modelLines(input.meta.calls).flatMap(words => wrap('', words)).map(inertLine)
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
 * counts and coverage, the documents read, what was left out, the gaps, the flags, the time, the tokens and what each role took, and last the verdict. See
 * the module's comment for the order. With `color`, only the words quorum wrote are colored: the level, the
 * location, the marker of the cited row, a row's `+` or `-`, and the status word of the verdict. It reads a public
 * view as the result it came from, but for the lines the module's comment names.
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
      ...meta.context.documents.flatMap(documentLines),
      ...leftOutLines(meta.leftOut),
      ...gaps.map(inertLine),
      ...meta.flags.flatMap(flag => wrap(`flag: ${flag.code}${flagWhere(flag)},`, flag.detail)).map(inertLine),
      timeLine(result),
      ...roleLines(result),
      ...modelsLines(result),
      verdictLine(outcome, color),
    ]
    return `${lines.join('\n')}\n`
  },
}
