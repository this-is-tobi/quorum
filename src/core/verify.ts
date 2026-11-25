import { hunksOf, locate, sectionFor } from './diff.ts'
import type { FindingLocation, Hunk } from './diff.ts'
import { excludeMatcher } from './exclude.ts'
import { stripHidden } from './sanitize.ts'
import type { Finding, FindingDetails, ReviewRule } from './types.ts'

/** A finding as the harness verified it, before the research stage names it and tags its profile. */
export type VerifiedFinding = Omit<Finding, 'id' | 'fingerprint' | 'profile'>

/** The most characters of a finding's summary, which the finder writes, as the harness caps it. */
export const MAX_SUMMARY = 500
/** The most characters of a finding's category, which the finder writes, as the harness caps it. */
export const MAX_CATEGORY = 80
/** What a finding whose category is empty once cleaned is named: the finder gave none, and the panel judges it all the same. */
export const UNCATEGORIZED = 'uncategorized'
const MAX_FILE = 260
/** The file name echoed in an `invalid` reason only has to identify the finding, so it is shorter than a stored one. */
const MAX_REPORTED_FILE = 80
/** The most characters of the evidence a finding carries, read from the diff and capped. */
export const MAX_EVIDENCE = 2000
/** A quote longer than this once whitespace is collapsed is no usable citation of a few diff lines: it never matches. */
const MAX_QUOTE = 2000
/**
 * The quote is searched for in this many leading characters of the evidence at most, which keeps
 * the search cheap on a hostile line. A hit further along a very long line is reported as
 * unmatched, which only affects the informational `quoteMatched` flag. The anchor's search is
 * bounded by it twice: each row's code is read to this many characters, and the rows around the
 * cited line are taken while their code sums to at most this many.
 */
const MAX_SEARCH = 16_000
/**
 * The fewest characters, white space not counted, a quote holds for the harness to move a finding
 * to it. A shorter one (a brace, `end`, `return`) stands in too many places of a file to say which
 * line the finder meant, so the finding stays where it was cited.
 */
export const MIN_ANCHOR_QUOTE = 10
/**
 * The most occurrences of a quote the search examines in its window. A quote that stands more often is not distinctive
 * (a periodic quote in a long run of one character stands thousands of times), so it is ambiguous and the finding stays
 * where it was cited. The cap keeps the search from costing a quote's length for each of a hostile window's occurrences.
 */
export const MAX_ANCHOR_OCCURRENCES = 64
/** Only the first `max * SCAN_FACTOR` characters of finder-written text are read, so cleaning stays cheap on hostile input. */
const SCAN_FACTOR = 4

/** `text` with each run of white space one space and both ends trimmed. */
export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Check what the finder reported against the diff itself. A finding must cite a file of the diff
 * and a line inside one of its hunks, otherwise it is dropped with a reason. What reaches the
 * voters is then taken from the diff, never from the finder: the path is the diff's own, the
 * evidence is the diff's lines around the cited one, and the finder's quote is only compared with
 * them. The summary and category are the only finder-written text left, cleaned and capped. The
 * row of the evidence that shows the cited line is kept only when the cap left that row as
 * `locate` read it, so a row cut short is never marked.
 *
 * A finding whose quote is not in that evidence but is elsewhere in the cited file's section moves
 * to the nearest occurrence of the quote (`anchorOf`), before the panel votes: its `line`, evidence
 * and `evidenceRow` are then read from the diff there, `citedLine` keeps the line the finder cited,
 * and `quoteMatched` is true. Every other finding stays where it was cited, and the quote still
 * reaches no voter.
 *
 * The rule a finding cites, when the finder wrote one that is not blank, is carried as it is, trimmed: it is the finder's text
 * and not yet a rule, until `checkCitations` has read it against the rules the review sent.
 */
export function verifyFindings(details: readonly FindingDetails[], sections: ReadonlyMap<string, string>): { findings: VerifiedFinding[], invalid: string[] } {
  const findings: VerifiedFinding[] = []
  const invalid: string[] = []
  for (const detail of details) {
    const located = locate(sections, detail.file, detail.line)
    if (!located) {
      invalid.push(`${plainText(detail.file, MAX_REPORTED_FILE)}:${detail.line} is not in the diff`)
      continue
    }
    const file = located.path === ''
      ? plainText(detail.file, MAX_FILE)
      : located.path
    if (file === '') {
      invalid.push(`line ${detail.line} names no file`)
      continue
    }
    const matched = quoteAppearsIn(located.evidence, detail.quote)
    const anchor = matched
      ? undefined
      : anchorOf(sections, detail.file, detail.line, detail.quote)
    const read = anchor?.located ?? located
    const evidence = cap(read.evidence, MAX_EVIDENCE)
    const evidenceRow = citedRow(read, evidence)
    const cited = detail.rule?.trim() ?? ''
    findings.push({
      file,
      line: anchor?.line ?? detail.line,
      ...(anchor === undefined
        ? {}
        : { citedLine: detail.line }),
      category: plainText(detail.category, MAX_CATEGORY) || UNCATEGORIZED,
      ...(cited === ''
        ? {}
        : { rule: cited }),
      summary: plainText(detail.summary, MAX_SUMMARY),
      evidence,
      ...(evidenceRow === undefined
        ? {}
        : { evidenceRow }),
      quoteMatched: matched || anchor !== undefined,
    })
  }
  return { findings, invalid }
}

/**
 * The diff's own path of the file `file`, as a finder wrote it, names at `line`: the path of the section `locate` finds there, so
 * the file resolves as a finding's does and the line is one a hunk shows. Undefined when the diff does not show the line (the file
 * is not in it, or no hunk holds the line) or the path is empty, a part of the diff that no header names. It checks nothing else
 * of a finding, so a caller can place one it never read as a finding.
 */
export function placeOf(sections: ReadonlyMap<string, string>, file: string, line: number): string | undefined {
  const path = locate(sections, file, line)?.path
  return path === undefined || path === ''
    ? undefined
    : path
}

/**
 * Check the rule each of `findings` cites, once `verifyFindings` has anchored it, so on the finding's final file and line: a citation
 * holds when it names a rule of `rules`, the rules the review sent, whose `paths` match the finding's file (a rule with none applies to
 * every file), and the finding then carries that rule's own id, never the finder's text. Any other citation fails, with the reason
 * `"<file>":<line> cites no rule this review sent`: its finding goes on with no `rule`, or, with `requireRule`, is dropped. With
 * `requireRule`, a finding that cites none is dropped too, with the reason `"<file>":<line> cites no rule, which the profile requires`;
 * without it, it is kept as it is. The file is JSON-quoted and cut at 80 characters, and no reason holds what the finder cited.
 */
export function checkCitations(findings: readonly VerifiedFinding[], rules: readonly ReviewRule[], requireRule: boolean): { findings: VerifiedFinding[], invalid: string[] } {
  const kept: VerifiedFinding[] = []
  const invalid: string[] = []
  const matchers = new Map<ReviewRule, (path: string) => boolean>()
  const applies = (rule: ReviewRule, file: string): boolean => {
    if (rule.paths === undefined) return true
    const matcher = matchers.get(rule) ?? excludeMatcher(rule.paths)
    matchers.set(rule, matcher)
    return matcher(file)
  }
  for (const finding of findings) {
    const where = `${JSON.stringify(cap(finding.file, MAX_REPORTED_FILE))}:${finding.line}`
    if (finding.rule === undefined) {
      if (!requireRule) {
        kept.push(finding)
        continue
      }
      invalid.push(`${where} cites no rule, which the profile requires`)
      continue
    }
    const cited = finding.rule
    const rule = rules.find(each => each.id === cited && applies(each, finding.file))
    if (rule !== undefined) {
      kept.push({ ...finding, rule: rule.id })
      continue
    }
    invalid.push(`${where} cites no rule this review sent`)
    if (requireRule) continue
    const { rule: _refused, ...rest } = finding
    kept.push(rest)
  }
  return { findings: kept, invalid }
}

/**
 * The index of the row that shows the cited line in the capped evidence: `located.row`, unless no
 * row shows the line or the cap cut that row, so the capped evidence's row at that index is not the
 * row `locate` read.
 */
function citedRow(located: FindingLocation, capped: string): number | undefined {
  if (located.row === undefined) return undefined
  return capped.split('\n')[located.row] === located.evidence.split('\n')[located.row]
    ? located.row
    : undefined
}

/** What `anchorOf` reads of a file's section: its rows that hold code, in the diff's order. */
interface AnchorRows {
  /** The new-file line each row stands at: its own, or, for a removed row, the next line its hunk shows, else the last, else the hunk's start. */
  readonly lines: readonly number[]
  /** Each row's code: the first `MAX_SEARCH` characters after its marker, white space collapsed. Never empty, so a row with no code is left out. */
  readonly codes: readonly string[]
  /** The index of the hunk each row is in. */
  readonly hunks: readonly number[]
  /** The highest line among the rows up to each one, which only rises, so the first row at or after a line is a binary search away. */
  readonly reach: readonly number[]
}

/** The rows of each section's hunks, read once, in a cache keyed by the list `hunksOf` caches, so it is dropped with the sections map. */
const anchorRows = new WeakMap<readonly Hunk[], AnchorRows>()

/** The new-file line each row of `hunk` stands at: a shown row at its own line, a removed row at the next line the hunk shows, else the last it shows, else its start. */
function linesOfRows(hunk: Hunk): number[] {
  const shown: Array<number | undefined> = Array.from({ length: hunk.rows.length })
  for (const [offset, at] of hunk.rowOfLine.entries()) shown[at] = hunk.start + offset
  let next = hunk.start + Math.max(hunk.rowOfLine.length - 1, 0)
  return shown.toReversed().map((line) => {
    next = line ?? next
    return next
  }).toReversed()
}

/** The rows of a file's hunks that hold code, with the line each stands at, read once per list of hunks. */
function rowsOf(hunks: readonly Hunk[]): AnchorRows {
  const known = anchorRows.get(hunks)
  if (known) return known
  const rows: { lines: number[], codes: string[], hunks: number[], reach: number[] } = {
    lines: [],
    codes: [],
    hunks: [],
    reach: [],
  }
  for (const [hunkAt, hunk] of hunks.entries()) {
    const lines = linesOfRows(hunk)
    for (const [at, row] of hunk.rows.entries()) {
      const code = collapse(row.slice(1, MAX_SEARCH + 1))
      if (code === '') continue
      rows.lines.push(lines[at])
      rows.codes.push(code)
      rows.hunks.push(hunkAt)
      rows.reach.push(Math.max(lines[at], rows.reach.at(-1) ?? lines[at]))
    }
  }
  anchorRows.set(hunks, rows)
  return rows
}

/**
 * The rows around the first one at or after `cited`, as a first and a last index: from that row, a round adds the row
 * above and the row below, only when both fit while the code taken sums to at most `MAX_SEARCH`, so the nearest rows come
 * first and a tie is always seen on both sides: a round that only one row of fits is not taken. At an edge of the
 * section a round has one row, taken when it fits. Each row holds code, so a window holds at most `MAX_SEARCH` rows.
 */
function windowAround(rows: AnchorRows, cited: number): { first: number, last: number } {
  let low = 0
  let high = rows.reach.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows.reach[middle] >= cited) high = middle
    else low = middle + 1
  }
  let first = Math.min(low, rows.reach.length - 1)
  let last = first
  let size = rows.codes[first].length
  for (;;) {
    const above = first > 0
    const below = last + 1 < rows.codes.length
    if (!above && !below) return { first, last }
    const taken = (above
      ? rows.codes[first - 1].length
      : 0) + (below
      ? rows.codes[last + 1].length
      : 0)
    if (size + taken > MAX_SEARCH) return { first, last }
    size += taken
    if (above) first -= 1
    if (below) last += 1
  }
}

/**
 * The line of the occurrence of `wanted`, a collapsed quote, nearest `cited` in the window around it,
 * or undefined when there is none, when two stand at the same distance, or when it stands more than
 * `MAX_ANCHOR_OCCURRENCES` times, which the search stops counting at. The window's rows are joined by
 * a space within a hunk and a line feed between two, so no quote spans two hunks, and an occurrence
 * stands at the line of the row it starts in.
 */
function nearestOccurrence(rows: AnchorRows, cited: number, wanted: string): number | undefined {
  if (rows.codes.length === 0) return undefined
  const { first, last } = windowAround(rows, cited)
  let text = ''
  const starts: number[] = []
  for (let at = first; at <= last; at++) {
    if (at > first) {
      text += rows.hunks[at] === rows.hunks[at - 1]
        ? ' '
        : '\n'
    }
    starts.push(text.length)
    text += rows.codes[at]
  }
  let best: number | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  let tied = false
  let rowAt = 0
  let seen = 0
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    seen += 1
    if (seen > MAX_ANCHOR_OCCURRENCES) return undefined
    while (rowAt + 1 < starts.length && starts[rowAt + 1] <= at) rowAt++
    const line = rows.lines[first + rowAt]
    const distance = Math.abs(line - cited)
    if (distance < bestDistance) {
      best = line
      bestDistance = distance
      tied = false
    } else if (distance === bestDistance && line !== best) {
      tied = true
    }
  }
  return tied ? undefined : best
}

/**
 * Where the finding's quote stands in the cited file's section, when it is not at the cited line: the
 * line of the occurrence nearest `cited`, and what `locate` reads there. Undefined, so the finding stays
 * where it was cited, when the quote holds fewer than `MIN_ANCHOR_QUOTE` characters that are not white
 * space (or more than `MAX_QUOTE`), when it is in the section nowhere, when two occurrences stand at the
 * nearest distance, when it stands more than `MAX_ANCHOR_OCCURRENCES` times in the window, or when the evidence
 * at the line holds no more than a part of it. The search reads
 * the window around the cited line that `windowAround` takes, so it stays cheap on a hostile file, and
 * only ever within the one section the finding cites.
 */
function anchorOf(sections: ReadonlyMap<string, string>, file: string, cited: number, quote: string): { readonly line: number, readonly located: FindingLocation } | undefined {
  const wanted = collapse(quote)
  if (wanted.length > MAX_QUOTE || wanted.replaceAll(' ', '').length < MIN_ANCHOR_QUOTE) return undefined
  const section = sectionFor(sections, file)
  if (!section) return undefined
  const line = nearestOccurrence(rowsOf(hunksOf(sections, section.path, section.text)), cited, wanted)
  if (line === undefined) return undefined
  const located = locate(sections, file, line)
  return located !== undefined && quoteAppearsIn(located.evidence, quote)
    ? { line, located }
    : undefined
}

/**
 * Whether the quote appears in the evidence's code: the leading +, - or space marker is removed
 * from every evidence row and whitespace is collapsed on both sides. The quote itself is not
 * stripped of markers, so a quote that keeps its own does not match. Both sides are bounded
 * (`MAX_QUOTE`, `MAX_SEARCH`) because both come from attacker-influenced text and a substring
 * search is quadratic in the worst case.
 */
function quoteAppearsIn(evidence: string, quote: string): boolean {
  const wanted = collapse(quote)
  if (wanted === '' || wanted.length > MAX_QUOTE) return false
  const code = collapse(evidence.split('\n').map(row => row.slice(1)).join('\n'))
  return code.slice(0, MAX_SEARCH).includes(wanted)
}

/** One line of plain text: the head of the value, whitespace collapsed, hidden characters removed, capped. */
function plainText(value: string, max: number): string {
  return cap(collapse(stripHidden(collapse(value.slice(0, max * SCAN_FACTOR)))), max)
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xD800 && unit <= 0xDBFF

/** Cut `value` to `max` characters ending in an ellipsis, without leaving half of a surrogate pair. */
function cap(value: string, max: number): string {
  if (value.length <= max) return value
  const keep = isHighSurrogate(value.charCodeAt(max - 2))
    ? max - 2
    : max - 1
  return `${value.slice(0, keep)}…`
}

/** A finding as the harness leaves it at its longest, citing `file`: every text the finder or the diff writes at its cap, in the one character that costs a token a character. The estimate and the room accounting size a vote by it. */
export function longestFinding(file: string): Finding {
  return {
    id: '',
    fingerprint: '',
    profile: '',
    file,
    line: Number.MAX_SAFE_INTEGER,
    category: 'x'.repeat(MAX_CATEGORY),
    summary: 'x'.repeat(MAX_SUMMARY),
    evidence: 'x'.repeat(MAX_EVIDENCE),
    quoteMatched: true,
  }
}
