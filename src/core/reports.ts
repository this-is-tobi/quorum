/**
 * The bounds a scanner report is read within, which the readers of `src/context/` apply to a report's text and the core
 * applies again to the reports it is handed, so that no number stands in two places.
 */

/** The most bytes of one report quorum reads: a larger file is refused before it is parsed. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024

/** The most reports a review reads, every format together: 16 files of `MAX_REPORT_BYTES` bound the memory the reports take. */
export const MAX_REPORTS = 16

/** The most runs of a SARIF log that are read, as GitHub's code scanning does. */
export const MAX_RUNS = 20

/** The most results of a SARIF run, and the most issues of a SonarQube response, that are read, as GitHub's code scanning does. */
export const MAX_RESULTS = 25_000

/** The most issues a SonarQube search returns, however many it found. */
export const SONARQUBE_SEARCH_CAP = 10_000

/** The most UTF-16 units of an issue's message that are handed to the core, four times the summary's cap. */
export const READ_MESSAGE = 2000

/** The most UTF-16 units of a rule's text that are handed to the core, four times the block's cap. */
export const READ_RULE_TEXT = 8192

/** The most UTF-16 units of a rule's id that are handed to the core, four times its cap. */
export const READ_RULE_ID = 1024

/** The most UTF-16 units of a scanner's name that are handed to the core, four times its cap. */
export const READ_SCANNER = 256

/** The most UTF-16 units of an issue's snippet that are handed to the core, the longest quote a finding may carry. */
export const READ_SNIPPET = 2000

/** The most UTF-16 units of a revision a report states that are handed to the core: a commit is at most 64 hexadecimal digits. */
export const READ_COMMIT = 64

const isHighSurrogate = (unit: number): boolean => unit >= 0xD800 && unit <= 0xDBFF

/**
 * `text` cut to at most `max` UTF-16 units, which is the text itself, the same string, when it is within them. The cut never
 * leaves the high half of a surrogate pair at the end.
 */
export function cutRead(text: string, max: number): string {
  if (text.length <= max) return text
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1))
    ? max - 1
    : max
  return text.slice(0, end)
}
