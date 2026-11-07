import { createLimiter, DEFAULT_CONCURRENCY } from './core/concurrency.ts'
import type { Limiter } from './core/concurrency.ts'
import { diffSectionFor, splitDiff } from './core/diff.ts'
import { parseVoteReply } from './core/output.ts'
import type { Provider } from './core/ports.ts'
import { confidenceFor, defaultPolicy, resolvePolicy, undecidedLevel, verdictStatus } from './core/policy.ts'
import { renderTemplate, researchRequest, voteRequest } from './core/prompts.ts'
import { checkReply, DEFAULT_MAX_FINDINGS } from './core/stages/research.ts'
import type { ResearchOutcome } from './core/stages/research.ts'
import type { Finding, IncompleteEntry, Lens, LensVote, QuorumResult, Verdict } from './core/types.ts'
import { providersFromEnv } from './legacy.ts'
import { securityProfile } from './profiles/security.ts'

/** The default policy resolved for the three lenses: 3/3 → high, 2/3 → medium, low disabled. */
const THRESHOLDS = resolvePolicy(defaultPolicy, securityProfile.lenses.length).thresholds

/** The two model backends of a review: the researcher that proposes findings and the voter behind the panel. */
export interface Providers {
  research: Provider
  voter: Provider
}

/**
 * Ask the research provider to propose candidate findings in a diff, then check each against the diff.
 * The reply is validated: one without a `findings` array fails the run (fail closed), a reply
 * whose object holds a key other than `findings` fails the run too, a finding that does not match
 * the reply schema is recorded as incomplete, a finding citing a file or line the diff does not
 * contain is dropped with a reason, only the first `maxFindings` are read, and a reply with no
 * usable finding is recorded as incomplete. What survives carries evidence read from the diff,
 * never the finder's quote.
 *
 * @example
 * const { findings, invalid, incomplete } = await research(provider, diffText, createLimiter(4))
 */
export async function research(
  provider: Provider,
  diff: string,
  limit: Limiter,
  sections: ReadonlyMap<string, string> = splitDiff(diff),
  maxFindings: number = DEFAULT_MAX_FINDINGS,
): Promise<ResearchOutcome> {
  const { text } = await limit(() => provider.complete(researchRequest(securityProfile.prompts.research, diff)))
  return checkReply(text, sections, securityProfile.id, maxFindings)
}

/**
 * Drop candidates that independent lenses (once there is more than one) or repeated runs
 * rediscovered at the same location - plain code, not a model, same as the quorum tally below.
 *
 * @example
 * dedup([a, b, a]) // -> [a, b], keyed by file, line and category
 */
export function dedup(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    // A JSON array, not colons: a file name and a category can hold colons, which would make two findings collide.
    const key = JSON.stringify([finding.file, finding.line, finding.category])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Cast one voter's ballot on one finding, from one fixed lens. The voter never sees the other two
 * votes or their reasoning - independence is the point, not an oversight. Letting verifiers see
 * each other's reasoning measurably converges results toward consensus rather than correctness.
 */
async function vote(provider: Provider, finding: Finding, lens: Lens, diffContext: string, limit: Limiter): Promise<LensVote> {
  const instructions = renderTemplate(securityProfile.prompts.vote, {
    'lens.id': lens.id,
    'lens.question': lens.question,
    'panel.size': String(securityProfile.lenses.length),
  })
  try {
    const { text } = await limit(() => provider.complete(voteRequest(instructions, finding, diffContext)))
    const result = parseVoteReply(text)
    return { angle: lens.id, vote: result, error: null }
  } catch (error) {
    return { angle: lens.id, vote: null, error: (error as Error).message }
  }
}

/**
 * Run the independent 3-voter panel on one finding and compute the quorum verdict. The keep/discard
 * decision and the confidence ceiling are ordinary arithmetic here, the policy's thresholds over
 * the kept votes, not something any voter's self-reported confidence gets to override: unanimous
 * 3/3 is a ceiling of 'high', a 2/3 split is capped at 'medium' no matter how certain any one voter
 * sounded.
 *
 * @example
 * const verdict = await panel(provider, finding, diffSectionForTheFile, createLimiter(4))
 * if (verdict.confidence) console.log(`kept: ${verdict.confidence}`)
 */
export async function panel(provider: Provider, finding: Finding, diffContext: string, limit: Limiter): Promise<Verdict> {
  const votes = await Promise.all(securityProfile.lenses.map(lens => vote(provider, finding, lens, diffContext, limit)))
  const keptVotes = votes.filter(v => v.vote?.keep).length
  return { ...finding, keptVotes, totalVotes: votes.length, confidence: confidenceFor(keptVotes, THRESHOLDS), votes }
}

/**
 * Full pipeline: find candidates in a diff with the research provider, then panel-verify each
 * independently with the voter provider before reporting. Each voter receives the diff section of
 * the file its finding cites. A finding whose failed votes left it undecided is `unreviewed`, a kept
 * finding whose failed votes could have raised it is recorded in `meta.incomplete`, and research
 * gaps are there too: the gaps the harness detects never read as a clean review (ADR-0012).
 *
 * @example
 * const { kept, discarded, unreviewed, meta } = await review(diffText, { research: provider, voter: provider })
 * console.log(`${kept.length} kept, ${discarded.length} discarded, ${unreviewed.length} unreviewed`)
 */
export async function review(diff: string, providers: Providers, onProgress?: (message: string) => void): Promise<QuorumResult> {
  const log = onProgress ?? (() => {})
  const result: QuorumResult = { kept: [], discarded: [], unreviewed: [], meta: { incomplete: [] } }
  if (diff.trim() === '') {
    log('empty diff: nothing to review')
    return result
  }
  const limit = createLimiter(DEFAULT_CONCURRENCY)

  const sections = splitDiff(diff)
  const { findings, invalid, incomplete } = await research(providers.research, diff, limit, sections)
  if (invalid.length > 0) log(`${invalid.length} invalid finding(s) dropped`)
  for (const entry of incomplete) log(`incomplete: ${entry.reason} (${entry.detail})`)
  result.meta.incomplete = incomplete
  const candidates = dedup(findings)
  log(`${candidates.length} candidate(s) after dedup`)

  const verdicts = await Promise.all(candidates.map(finding => panel(providers.voter, finding, diffSectionFor(sections, finding.file, diff), limit)))
  for (const verdict of verdicts) result[verdictStatus(verdict, THRESHOLDS)].push(verdict)
  for (const verdict of result.kept) {
    const undecided = undecidedLevel(verdict, THRESHOLDS)
    if (undecided === undefined) continue
    const failed = verdict.votes.filter(lensVote => lensVote.vote === null).length
    // The file name is JSON-quoted: a decoded diff path can hold control characters, and this line reaches stderr.
    const entry: IncompleteEntry = { profile: securityProfile.id, reason: 'vote-failed', file: verdict.file, detail: `${JSON.stringify(verdict.file)}:${verdict.line} is kept at ${verdict.confidence}, but ${failed} failed vote(s) could have made it ${undecided}` }
    result.meta.incomplete.push(entry)
    log(`incomplete: ${entry.reason} (${entry.detail})`)
  }
  log(`${result.kept.length} kept, ${result.discarded.length} discarded, ${result.unreviewed.length} unreviewed by panel`)

  return result
}

/**
 * `review` with providers built from the RESEARCH_* / VOTER_* environment variables of `process.env`.
 * A research model that is not set is a `ConfigError`, even for an empty diff.
 *
 * @deprecated Use review with explicit providers
 *
 * @example
 * const { kept } = await runQuorum(diffText)
 */
export async function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult> {
  return review(diff, providersFromEnv(process.env), onProgress)
}
