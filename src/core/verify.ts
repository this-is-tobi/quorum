import { locate } from './diff.ts'
import type { FindingLocation } from './diff.ts'
import { stripHidden } from './sanitize.ts'
import type { Finding, FindingDetails } from './types.ts'

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
 * unmatched, which only affects the informational `quoteMatched` flag.
 */
const MAX_SEARCH = 16_000
/** Only the first `max * SCAN_FACTOR` characters of finder-written text are read, so cleaning stays cheap on hostile input. */
const SCAN_FACTOR = 4

/**
 * Check what the finder reported against the diff itself. A finding must cite a file of the diff
 * and a line inside one of its hunks, otherwise it is dropped with a reason. What reaches the
 * voters is then taken from the diff, never from the finder: the path is the diff's own, the
 * evidence is the diff's lines around the cited one, and the finder's quote is only compared with
 * them. The summary and category are the only finder-written text left, cleaned and capped. The
 * row of the evidence that shows the cited line is kept only when the cap left that row as
 * `locate` read it, so a row cut short is never marked.
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
    const evidence = cap(located.evidence, MAX_EVIDENCE)
    const evidenceRow = citedRow(located, evidence)
    findings.push({
      file,
      line: detail.line,
      category: plainText(detail.category, MAX_CATEGORY) || UNCATEGORIZED,
      summary: plainText(detail.summary, MAX_SUMMARY),
      evidence,
      ...(evidenceRow === undefined
        ? {}
        : { evidenceRow }),
      quoteMatched: quoteAppearsIn(located.evidence, detail.quote),
    })
  }
  return { findings, invalid }
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

/** `text` with each run of white space one space and both ends trimmed. */
export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

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
