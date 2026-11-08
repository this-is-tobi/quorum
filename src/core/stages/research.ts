import { createHash } from 'node:crypto'
import { parseResearchReply } from '../output.ts'
import { researchRequest } from '../prompts.ts'
import type { Finding, IncompleteEntry } from '../types.ts'
import { verifyFindings } from '../verify.ts'
import { callProvider } from './context.ts'
import type { ProfileRun, RunContext } from './context.ts'

/** How many reported findings a research reply may send to the panel; the rest is reported as incomplete. */
export const DEFAULT_MAX_FINDINGS = 50

export interface ResearchOutcome {
  findings: Finding[]
  /**
   * One reason per finding, among the ones read, that the check against the diff dropped (it cites
   * code outside the diff, or names no file). An unreadable finding is reported in `incomplete` only.
   */
  invalid: string[]
  /** What the run could not review: findings the harness could not read, findings beyond the cap, or a reply whose findings were all unusable. */
  incomplete: IncompleteEntry[]
}

/**
 * The id of a finding, stable across runs: the first 12 hex characters of SHA-256 over the JSON
 * array `[profile, file, line, category]`. The fields go in as a JSON array, not joined with
 * colons, because a file name and a category can hold colons: joined, two different findings
 * could produce one string and share an id, while an array keeps every field apart.
 */
export function findingId(profile: string, file: string, line: number, category: string): string {
  return createHash('sha256').update(JSON.stringify([profile, file, line, category])).digest('hex').slice(0, 12)
}

/**
 * Turn a research reply into what the panel receives. The reply is parsed strictly (a malformed
 * envelope, or one with a key other than `findings`, throws, so it never reads as "no findings"),
 * only the first `maxFindings` findings it lists are read and checked against the diff (the work
 * spent on a reply built to flood the run stays bounded, whatever the entries hold), and nothing
 * the harness read is dropped silently: a finding that does not match the reply schema (what
 * planted text that closes a string early leaves behind), findings beyond the cap, and a reply
 * whose findings were all unusable, are recorded as incomplete, which fails the run (ADR-0012).
 * A finding that cites code outside the diff is only dropped with its reason: it was read, and
 * it is wrong. `invalid` holds only the reasons of the findings the check against the diff
 * dropped, so an unreadable finding is reported once, in `incomplete`. Every finding it keeps is
 * named by `findingId` and tagged with `profile`, and every incomplete entry it records is tagged
 * with `profile` too.
 *
 * @throws OutputError when the reply is not one JSON object holding a `findings` array and nothing else
 * @throws RangeError when `maxFindings` is not a positive integer
 */
export function checkReply(text: string, sections: ReadonlyMap<string, string>, profile: string, maxFindings = DEFAULT_MAX_FINDINGS): ResearchOutcome {
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    throw new RangeError(`maxFindings must be a positive integer, got ${maxFindings}`)
  }
  const parsed = parseResearchReply(text, maxFindings)
  const checked = verifyFindings(parsed.findings, sections)
  const findings = checked.findings.map((finding): Finding => ({ id: findingId(profile, finding.file, finding.line, finding.category), profile, ...finding }))
  const incomplete = parsed.invalid.map((detail): IncompleteEntry => ({ profile, reason: 'finding-unreadable', detail }))
  if (parsed.listed > maxFindings) {
    incomplete.push({
      profile,
      reason: 'findings-capped',
      detail: `${parsed.listed - maxFindings} of ${parsed.listed} reported findings were not reviewed (the cap is ${maxFindings})`,
    })
  }
  if (parsed.listed > 0 && findings.length === 0) {
    const reported = `${parsed.listed} finding(s) reported`
    const detail = parsed.listed > maxFindings ? `${reported}, the first ${maxFindings} read, none usable` : `${reported}, none usable`
    incomplete.push({ profile, reason: 'research-unusable', detail })
  }
  return { findings, invalid: checked.invalid, incomplete }
}

/**
 * The research stage of one profile: one call to its research provider, with the profile's
 * research instructions, the diff and the guidelines, whose reply `checkReply` turns into what the
 * panel receives. Each finding dropped for citing code outside the diff is reported by a
 * `finding:invalid` event, and each gap by an `incomplete` event. A failed research call, or a
 * reply that is not a valid envelope, fails the profile and aborts the review where it fails
 * (`callProvider` aborts it for the call), so no other profile starts a call after it.
 *
 * @throws ProviderError, or whatever a custom provider throws, when the research call fails
 * @throws OutputError when the reply is not one JSON object holding a `findings` array and nothing else
 */
export async function research(ctx: RunContext, run: ProfileRun, diff: string, sections: ReadonlyMap<string, string>): Promise<ResearchOutcome> {
  const text = await callProvider(ctx, { profile: run.id, role: 'research' }, run.research, () => researchRequest(run.research.instructions, diff, run.guidelines))
  let outcome: ResearchOutcome
  try {
    outcome = checkReply(text, sections, run.id, ctx.maxFindings)
  } catch (error) {
    ctx.fail(error)
    throw error
  }
  for (const reason of outcome.invalid) ctx.emit({ type: 'finding:invalid', profile: run.id, reason })
  for (const entry of outcome.incomplete) ctx.emit({ type: 'incomplete', entry })
  return outcome
}
