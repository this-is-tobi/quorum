/**
 * The Markdown summary: what a review came to, written for a pull request or a job summary, from the public view
 * (`publicView`), which a stranger may read. Its blocks come in this order, a blank line between two:
 *
 * 1. the marker, `<!-- quorum:summary:v1 -->`, on the first line, and the heading `### quorum review`;
 * 2. the verdict, which says what the exit code says;
 * 3. a table of each profile's fail-on level, counts and coverage, the coverage cell of a profile that asked nothing (it requires
 *    a rule and was sent none) ending with the rules it was sent and that its research asks nothing;
 * 4. `#### Findings`: the kept and unreviewed findings, each with its claim and its evidence, its head naming the review rule it
 *    cites in a code span, and, for a finding a scanner's report gave, the scanner in a code span, `file-level` when the issue
 *    had no line of its own and `marked suppressed` when its report marks it so;
 * 5. `#### Dismissed scanner issues`: the issues a scanner's report gave that the panel dismissed, each with its file, line, rule
 *    id and scanner in code spans and how the lenses voted, the first 20;
 * 6. `#### Gaps`: one line per profile and reason, in fixed words;
 * 7. `#### Files left out`;
 * 8. `#### Flags`;
 * 9. `#### Scanner and coverage reports`: one item for each report the review read, in the words of the log's line, the scanner's
 *    name in a code span;
 * 10. `#### Documents read`: one item for each guidelines, do-not-report or rules document the review read, in the words of
 *    the log's line, its path, commit and hash in code spans;
 * 11. the note that some evidence is left out, when it is, then `---` and the trailer: the version and the source.
 *
 * A section with nothing to list is left out.
 *
 * Every text a model or the diff wrote, a claim, a category, a file name, a row of code and a flag's detail, is in
 * a code span or a fenced block (`codeSpan`, `fencedBlock`), whose fence code computes, and in no table cell, since
 * a `|` splits a cell even inside a span. Every line passes `inertLine`, so Markdown echoed into a log starts no
 * workflow command. What a viewer would act on is never written:
 *
 * - raw HTML but the marker, which is on the first line and nowhere else: no `<details>`, no comment from a result;
 * - an image;
 * - a link, so a reference-style link and a raw URL too;
 * - a mention, an issue or pull request reference or a commit id outside a span, and an emoji or a math span;
 * - a `suggestion`, `mermaid`, `math`, `geojson`, `topojson` or `stl` fence: a block's info is `text`;
 * - a table cell that holds the text of a model or of a diff.
 */

import { profileFailOn } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'
import { codeSpan, fencedBlock, inertLine } from '../core/sanitize.ts'
import type { ContextDocument, ContextReport, Flag, IncompleteReason, LeftOutFile, PublicVerdict, PublicView } from '../core/types.ts'
import type { ScannerVerdict } from './lines.ts'
import { coverageWords, dismissedScanner, documentWords, evidenceRows, GAP_WORDS, isFileLevel, isSuppressed, levelWord, plural, rankedFindings, reportWords, rowText, ruleCountWords, ruleWords, sourcePhrase, verdictWhy, votesWords } from './lines.ts'
import type { Reporter } from './reporter.ts'
import { discardedOf, publicView } from './view.ts'

/** The most UTF-16 code units a summary holds, so GitHub's limit on a comment and the job summary's both hold, and no string is ever cut to fit it. */
export const SUMMARY_BUDGET = 60_000

/** How many of the files left out, of the flags, of the scanner reports, of the dismissed scanner issues and of the documents read, the summary lists; the JSON result lists every one. */
export const LISTED = 20

const MARKER = '<!-- quorum:summary:v1 -->'

const TABLE_HEAD = '| Profile | Fail-on | Kept | Unreviewed | Discarded | Outside the diff | Coverage |'
const TABLE_RULE = '| --- | --- | ---: | ---: | ---: | ---: | --- |'

const MORE = 'listed in the review\'s JSON result'

/** A line of the summary: `inertLine` of it, so no line holds a hidden character, starts a workflow command or holds `##[`. */
const written = inertLine

/** The levels in the order a count line names them. */
type Level = ReturnType<typeof levelWord>
const COUNTED: readonly Level[] = ['HIGH', 'MEDIUM', 'LOW', 'UNREVIEWED']

/** An item of a list: its lines, and the evidence of a finding that goes first when the budget is short. */
interface Item {
  readonly text: string
  /** The blank line and the fenced block that follow `text`, or empty when the finding cites none. */
  readonly evidence: string
  readonly level?: Level
  evidenceShown: boolean
}

/**
 * A block of the summary that the budget can cut: the lines that stay (`head`), the items in order, and how many
 * of them are shown. What is cut is counted by a last line, so the length of the block is `listingLength` of
 * numbers the drops keep, and no text is rebuilt to measure it.
 */
interface Listing {
  readonly head: string
  /** What stands between the head and the first item. */
  readonly headSep: string
  readonly itemSep: string
  /** What stands between the last item shown and the count line. */
  readonly countSep: string
  readonly items: readonly Item[]
  /** How many more the list holds than `items` was built with: counted, never built. */
  readonly outside: number
  shown: number
  shownLength: number
  /** How many of the items cut are at each level, for the findings' count line. */
  readonly cutLevels: Map<Level, number>
  readonly countLine: (listing: Listing) => string
}

function itemLength(item: Item): number {
  return item.text.length + (item.evidenceShown
    ? item.evidence.length
    : 0)
}

const cutOf = (listing: Listing): number => listing.items.length + listing.outside - listing.shown

function listing(head: string, parts: Partial<Pick<Listing, 'headSep' | 'itemSep' | 'countSep' | 'countLine' | 'outside'>>, items: readonly Item[]): Listing {
  return {
    head,
    headSep: '\n\n',
    itemSep: '\n',
    countSep: '\n',
    countLine: current => written(`- and ${cutOf(current)} more, ${MORE}`),
    outside: 0,
    ...parts,
    items,
    shown: items.length,
    shownLength: items.reduce((sum, item) => sum + itemLength(item), 0),
    cutLevels: new Map(),
  }
}

/** Whether a listing has anything to say: an item, or a count of more. */
const present = (current: Listing): boolean => current.items.length + current.outside > 0

/** The length of a listing as `renderListing` writes it, from the numbers the drops keep. */
function listingLength(current: Listing): number {
  let length = current.head.length
  if (current.shown > 0) length += current.headSep.length + current.shownLength + (current.shown - 1) * current.itemSep.length
  if (cutOf(current) > 0) {
    length += (current.shown > 0
      ? current.countSep
      : '\n\n').length + current.countLine(current).length
  }
  return length
}

function renderListing(current: Listing): string {
  const shown = current.items.slice(0, current.shown).map(item => item.text + (item.evidenceShown
    ? item.evidence
    : ''))
  const count = cutOf(current) > 0
    ? [
        current.countLine(current),
      ]
    : []
  if (shown.length === 0) return [current.head, ...count].join('\n\n')
  return `${current.head}${current.headSep}${shown.join(current.itemSep)}${count.length > 0
    ? `${current.countSep}${count[0]}`
    : ''}`
}

/** One item cut from the end of a listing, counted by its level. */
function dropLast(current: Listing): Item {
  current.shown -= 1
  const item = current.items[current.shown]
  current.shownLength -= itemLength(item)
  if (item.level !== undefined) current.cutLevels.set(item.level, (current.cutLevels.get(item.level) ?? 0) + 1)
  return item
}

function textItem(text: string): Item {
  return {
    text: written(text),
    evidence: '',
    evidenceShown: false,
  }
}

/** The table of each profile: its level, its counts and its coverage, which says the findings a changed-lines profile dropped for standing away from the change. A profile's id is the core's `[a-z][a-z0-9_-]*`, so it is no text of a model or a diff. */
function profileTable(view: PublicView): Listing {
  const counts = (verdicts: readonly PublicVerdict[]): Map<string, number> => {
    const byProfile = new Map<string, number>()
    for (const { profile } of verdicts) byProfile.set(profile, (byProfile.get(profile) ?? 0) + 1)
    return byProfile
  }
  const kept = counts(view.kept)
  const unreviewed = counts(view.unreviewed)
  return listing(`${TABLE_HEAD}\n${TABLE_RULE}`, {
    headSep: '\n',
    countSep: '\n\n',
  }, Object.entries(view.meta.profiles).map(([id, profile]) => textItem(`| ${id} | ${profileFailOn(view, id)} | ${kept.get(id) ?? 0} | ${unreviewed.get(id) ?? 0} | ${discardedOf(view, id)} | ${profile.invalidFindings} | ${coverageWords(profile.coverage)}${awayWords(profile)}${askedNothing(profile)} |`)))
}

/** What a changed-lines profile that dropped findings for standing away from the change adds to its coverage cell, `; 2 finding(s) away from the changed lines`: nothing for a profile with none, and the column of the findings outside the diff keeps its own count. No `|` and no text of a model or a diff. */
function awayWords({ awayFromChange }: PublicView['meta']['profiles'][string]): string {
  return awayFromChange !== undefined && awayFromChange > 0
    ? `; ${awayFromChange} finding(s) away from the changed lines`
    : ''
}

/** What a profile that asked nothing adds to its coverage cell, `; rules 0 of 0 sent, so its research asks nothing`, since its files read as reviewed: nothing for any other profile. No `|` and no text of a model or a diff. */
function askedNothing({ rules, asksNothing }: PublicView['meta']['profiles'][string]): string {
  return asksNothing === true
    ? `; rules ${ruleCountWords(rules, true)}`
    : ''
}

/** A finding's evidence as a fenced block inside its list item, each line indented two spaces, after a blank line; empty when it cites no row. */
function evidenceBlock(verdict: PublicVerdict): string {
  const { rows, width } = evidenceRows(verdict)
  if (rows.length === 0) return ''
  const block = fencedBlock(rows.map(row => rowText(row, width)), 'text').split('\n')
  return `\n\n${block.map(line => written(`  ${line}`)).join('\n')}`
}

/** The review rule a finding cites as the end of its head, ` · rule `<id>``, the id in a code span, or nothing for a finding that cites none. The finding's line comment shares it. */
export function ruleSpan(verdict: PublicVerdict): string {
  const rule = ruleWords(verdict, codeSpan)
  return rule === ''
    ? ''
    : ` · ${rule}`
}

/** The scanner that gave a finding as the end of its head, ` · `<scanner>``, the name in a code span, or nothing for a finding a model reported. The finding's line comment shares it. */
export function scannerSpan({ foundBy }: PublicVerdict): string {
  return foundBy.kind === 'scanner'
    ? ` · ${codeSpan(foundBy.scanner)}`
    : ''
}

/** ` · marked suppressed` for a finding whose scanner's report marks its issue as suppressed, which quorum does not honour, or nothing. It follows the scanner in a finding's head and in its line comment. */
export function suppressedClause(verdict: PublicVerdict): string {
  return isSuppressed(verdict)
    ? ' · marked suppressed'
    : ''
}

/** The findings, the ones that fail their profile first, then high, medium, unreviewed and low, each group by file and then by line. */
function findingsListing(view: PublicView): Listing {
  const items = rankedFindings(view).map((verdict): Item => {
    const level = levelWord(verdict)
    const fileLevel = isFileLevel(verdict)
      ? ' · file-level'
      : ''
    const head = `- **${level}** ${verdict.profile} · ${codeSpan(verdict.file)} line ${verdict.line} · ${codeSpan(verdict.category)}${ruleSpan(verdict)}${scannerSpan(verdict)}${fileLevel}${suppressedClause(verdict)} · ${votesWords(verdict)}`
    const evidence = evidenceBlock(verdict)
    return {
      text: `${written(head)}\n\n${written(`  ${codeSpan(verdict.summary)}`)}`,
      evidence,
      level,
      evidenceShown: evidence !== '',
    }
  })
  return listing('#### Findings', {
    itemSep: '\n\n',
    countSep: '\n\n',
    countLine: (current) => {
      const levels = COUNTED
        .filter(level => (current.cutLevels.get(level) ?? 0) > 0)
        .map(level => `${current.cutLevels.get(level)} ${level.toLowerCase()}`)
      return written(`- and ${plural(cutOf(current), 'more finding')} (${levels.join(', ')}), ${MORE}`)
    },
  }, items)
}

/** One line per profile and reason, in the words quorum wrote, with how many times the profile records the reason when more than once. */
function gapsListing(view: PublicView): Listing {
  const gaps = new Map<string, { profile: string, reason: IncompleteReason, count: number }>()
  for (const { profile, reason } of view.meta.incomplete) {
    const key = JSON.stringify([profile, reason])
    const gap = gaps.get(key) ?? { profile, reason, count: 0 }
    gap.count += 1
    gaps.set(key, gap)
  }
  return listing('#### Gaps', {}, [
    ...gaps.values(),
  ].map(({ profile, reason, count }) => textItem(`- ${profile}, ${reason}${count > 1
    ? ` (${count})`
    : ''}: ${GAP_WORDS[reason]}`)))
}

/** A file left out: its name in a span, or `(no path)` for the empty name, then its reason in parentheses, with the rule of a held file. */
function leftOutEntry(entry: LeftOutFile): string {
  const file = entry.file === ''
    ? '(no path)'
    : codeSpan(entry.file)
  const reason = 'rule' in entry
    ? `${entry.reason}: ${entry.rule}`
    : entry.reason
  return `- ${file} (${reason})`
}

/** Where a flag points: its file in a span, with the line when it has one, else the line alone, then its profile in parentheses when the flag is about one. */
function flagPlace({ file, line, profile }: Flag): string {
  const place = flagFile(file, line)
  return profile === undefined
    ? place
    : `${place} (${profile})`
}

/** The place a flag names in the file it is about: its file in a span, with the line when it has one, else the line alone. */
function flagFile(file: string | undefined, line: number | undefined): string {
  if (file !== undefined && line !== undefined) return ` at ${codeSpan(file)} line ${line}`
  if (file !== undefined) return ` at ${codeSpan(file)}`
  if (line !== undefined) return ` at line ${line}`
  return ''
}

/** A document read as an item: the words of its log line, with its path, its commit and its hash in code spans. */
function documentItem(record: ContextDocument): string {
  return `- ${documentWords(record, {
    path: codeSpan,
    commit: codeSpan,
    hash: codeSpan,
  })}`
}

/** The first `LISTED` of a list as items, `entry` given each value and its place from 0, and how many it holds beyond them. */
function listed<T>(heading: string, all: readonly T[], entry: (value: T, index: number) => string): Listing {
  return listing(heading, {
    outside: Math.max(0, all.length - LISTED),
  }, all.slice(0, LISTED).map((value, index) => textItem(entry(value, index))))
}

/** A scanner issue the panel dismissed as an item: its file, rule id and scanner, each in a code span, its line, then how the lenses voted. */
function dismissedEntry(verdict: ScannerVerdict): string {
  const { file, line, foundBy } = verdict
  return `- ${codeSpan(file)} line ${line} · ${codeSpan(foundBy.ruleId)} · ${codeSpan(foundBy.scanner)} · ${votesWords(verdict)}`
}

/** A report read as an item, the words of its line without the log's first word, `context: report`, and its scanner's name in a code span, at its place from 1. */
const reportEntry = (record: ContextReport, index: number): string => `- ${reportWords(record, index + 1, codeSpan)}`

const evidenceNote = (count: number): string => written(`The evidence of ${plural(count, 'finding')} is left out, to stay within GitHub's limit: the review's JSON result holds it.`)

/**
 * The summary of a public view, as the module's comment orders it, without a line feed at its end. It is at most
 * `budget` UTF-16 code units, `SUMMARY_BUDGET` unless a caller says, but for what always stays: the marker, the
 * heading, the verdict, the table's head, the headings, the count lines, the note and the trailer. They hold words
 * quorum wrote, numbers, a version and commit ids, so they fit any budget a person would give.
 *
 * What is over the budget is dropped whole, in this order, until the text fits: the dismissed scanner issues, from the
 * last one listed up, before any evidence; the evidence of the findings, from the last one listed up; the documents read,
 * the reports read, the flags, the files left out and the findings, each from its last entry up; the gap lines; the
 * profiles' rows. The reports go after the documents and before the flags: they say what the review read, and a report
 * that was not read whole is already a gap. The findings are listed with those that fail their profile first, so the
 * budget drops them last. Each list that lost entries ends with a line that counts them (and, for the findings, names
 * their levels), and a note says how many findings lost their evidence. No string is ever cut, so a code span or a
 * fenced block is whole or gone, and the work is linear in what the view holds.
 */
export function summaryMarkdown(view: PublicView, outcome: Outcome, budget = SUMMARY_BUDGET): string {
  const head = `${written(MARKER)}\n${written('### quorum review')}`
  const verdict = written(`**exit ${outcome.exitCode}, ${outcome.status}:** ${verdictWhy(outcome)}`)
  const trailer = `${written('---')}\n\n${written(`quorum ${view.meta.version} · ${sourcePhrase(view.meta.source, codeSpan)}`)}`
  const table = profileTable(view)
  const findings = findingsListing(view)
  const gaps = gapsListing(view)
  const dismissed = listed('#### Dismissed scanner issues', dismissedScanner(view), dismissedEntry)
  const leftOut = listed('#### Files left out', view.meta.leftOut, leftOutEntry)
  const flags = listed('#### Flags', view.meta.flags, flag => `- ${flag.code}${flagPlace(flag)}: ${codeSpan(flag.detail)}`)
  const reports = listed('#### Scanner and coverage reports', view.meta.context.reports, reportEntry)
  const documents = listed('#### Documents read', view.meta.context.documents, documentItem)
  const sections = [
    table,
    ...[
      findings,
      dismissed,
      gaps,
      leftOut,
      flags,
      reports,
      documents,
    ].filter(present),
  ]
  let evidenceCut = 0

  const length = (): number => {
    let total = head.length + verdict.length + trailer.length + 4
    for (const section of sections) total += 2 + listingLength(section)
    if (evidenceCut > 0) total += 2 + evidenceNote(evidenceCut).length
    return total
  }

  const cutFrom = (section: Listing): void => {
    while (section.shown > 0 && length() > budget) {
      const item = dropLast(section)
      if (section === findings && !item.evidenceShown && item.evidence !== '') evidenceCut -= 1
    }
  }

  cutFrom(dismissed)
  for (let index = findings.items.length - 1; index >= 0 && length() > budget; index -= 1) {
    const item = findings.items[index]
    if (!item.evidenceShown) continue
    findings.shownLength -= item.evidence.length
    item.evidenceShown = false
    evidenceCut += 1
  }
  for (const section of [
    documents,
    reports,
    flags,
    leftOut,
    findings,
    gaps,
    table,
  ]) cutFrom(section)

  return [
    head,
    verdict,
    ...sections.map(renderListing),
    ...evidenceCut > 0
      ? [
          evidenceNote(evidenceCut),
        ]
      : [],
    trailer,
  ].join('\n\n')
}

/**
 * The summary of a review for a pull request or a job summary, from the public view of what it is given, then a
 * line feed. See `summaryMarkdown`.
 */
export const markdown: Reporter = {
  publicOnly: true,
  render: (input, { outcome }) => `${summaryMarkdown(publicView(input), outcome)}\n`,
}
