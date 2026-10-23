import { parseResearchReply } from '../output.ts'
import type { Finding, IncompleteEntry } from '../types.ts'
import { verifyFindings } from '../verify.ts'

/** How many reported findings a research reply may send to the panel; the rest is reported as incomplete. */
export const DEFAULT_MAX_FINDINGS = 50

export interface ResearchOutcome {
  findings: Finding[]
  /** One reason per finding the reply listed but the panel will not see. */
  invalid: string[]
  /** What the run could not review: findings the harness could not read, findings beyond the cap, or a reply whose findings were all unusable. */
  incomplete: IncompleteEntry[]
}

/**
 * Turn a research reply into what the panel receives. The reply is parsed strictly (a malformed
 * envelope throws, so it never reads as "no findings"), only the first `maxFindings` findings it
 * lists are checked against the diff (the work spent on a reply built to flood the run stays
 * bounded), and nothing is dropped silently: a finding that does not match the reply schema (what
 * planted text that closes a string early leaves behind), findings beyond the cap, and a reply
 * whose findings were all unusable, are recorded as incomplete, which fails the run (ADR-0012).
 * A finding that cites code outside the diff is only dropped with its reason: it was read, and it
 * is wrong.
 *
 * @throws OutputError when the reply is not one JSON object with a `findings` array
 * @throws RangeError when `maxFindings` is not a positive integer
 */
export function checkReply(text: string, sections: ReadonlyMap<string, string>, maxFindings = DEFAULT_MAX_FINDINGS): ResearchOutcome {
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    throw new RangeError(`maxFindings must be a positive integer, got ${maxFindings}`)
  }
  const parsed = parseResearchReply(text)
  const checked = verifyFindings(parsed.findings.slice(0, maxFindings), sections)
  const incomplete = parsed.invalid.map((detail): IncompleteEntry => ({ reason: 'finding-unreadable', detail }))
  if (parsed.findings.length > maxFindings) {
    incomplete.push({
      reason: 'findings-capped',
      detail: `${parsed.findings.length - maxFindings} of ${parsed.findings.length} reported findings were not reviewed (the cap is ${maxFindings})`,
    })
  }
  const reported = parsed.findings.length + parsed.invalid.length
  if (reported > 0 && checked.findings.length === 0) {
    incomplete.push({ reason: 'research-unusable', detail: `${reported} finding(s) reported, none usable` })
  }
  return { findings: checked.findings, invalid: [...parsed.invalid, ...checked.invalid], incomplete }
}
