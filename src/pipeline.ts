import { createLimiter, DEFAULT_CONCURRENCY } from './core/concurrency.ts'
import type { Limiter } from './core/concurrency.ts'
import { diffSectionFor, splitDiff } from './core/diff.ts'
import { ConfigError } from './core/errors.ts'
import { parseVoteReply } from './core/output.ts'
import type { Provider } from './core/ports.ts'
import { confidenceFor, undecidedLevel, verdictStatus } from './core/policy.ts'
import { profileIssues, thresholdsFor } from './core/profile.ts'
import { renderTemplate, researchRequest, voteRequest } from './core/prompts.ts'
import { checkReply, DEFAULT_MAX_FINDINGS } from './core/stages/research.ts'
import type { ResearchOutcome } from './core/stages/research.ts'
import type { Finding, IncompleteEntry, Lens, LensVote, Profile, QuorumResult, Verdict } from './core/types.ts'
import { providersFromEnv } from './legacy.ts'
import { securityProfile } from './profiles/security.ts'

/** The two model backends of a review: the researcher that proposes findings and the voter behind the panel. */
export interface Providers {
  research: Provider
  voter: Provider
}

/** What a review runs besides its providers: the profile (the security one by default) and a progress callback. */
export interface ReviewOptions {
  profile?: Profile
  onProgress?: (message: string) => void
}

/**
 * Ask the research provider to propose candidate findings in a diff, with the profile's research
 * instructions, then check each against the diff. The profile must be one `profileIssues` accepts
 * (`review` checks it first). The reply is validated: one without a `findings` array fails the run
 * (fail closed), a reply whose object holds a key other than `findings` fails the run too, a
 * finding that does not match the reply schema is recorded as incomplete, a finding citing a file
 * or line the diff does not contain is dropped with a reason, only the first `maxFindings` are
 * read, and a reply with no usable finding is recorded as incomplete. What survives carries
 * evidence read from the diff, never the finder's quote.
 *
 * @example
 * const { findings, invalid, incomplete } = await research(securityProfile, provider, diffText, createLimiter(4))
 */
export async function research(
  profile: Profile,
  provider: Provider,
  diff: string,
  limit: Limiter,
  sections: ReadonlyMap<string, string> = splitDiff(diff),
  maxFindings: number = DEFAULT_MAX_FINDINGS,
): Promise<ResearchOutcome> {
  const { text } = await limit(() => provider.complete(researchRequest(profile.prompts.research, diff, profile.guidelines)))
  return checkReply(text, sections, profile.id, maxFindings)
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
 * Cast one voter's ballot on one finding, from one lens of the profile. The voter never sees the other
 * votes or their reasoning - independence is the point, not an oversight. Letting verifiers see
 * each other's reasoning measurably converges results toward consensus rather than correctness.
 */
async function vote(profile: Profile, provider: Provider, finding: Finding, lens: Lens, diffContext: string, limit: Limiter): Promise<LensVote> {
  const instructions = renderTemplate(profile.prompts.vote, {
    'lens.id': lens.id,
    'lens.question': lens.question,
    'panel.size': String(profile.lenses.length),
  })
  try {
    const { text } = await limit(() => provider.complete(voteRequest(instructions, finding, diffContext, profile.guidelines)))
    const result = parseVoteReply(text)
    return { angle: lens.id, vote: result, error: null }
  } catch (error) {
    return { angle: lens.id, vote: null, error: (error as Error).message }
  }
}

/**
 * Run the independent panel on one finding, one vote per lens of the profile, and compute the quorum
 * verdict. The keep/discard decision and the confidence ceiling are ordinary arithmetic here, the
 * profile's thresholds over the kept votes, not something any voter's self-reported confidence gets
 * to override: with the security profile, unanimous 3/3 is a ceiling of 'high', a 2/3 split is
 * capped at 'medium' no matter how certain any one voter sounded. The profile must be one
 * `profileIssues` accepts (`review` checks it first).
 *
 * @example
 * const verdict = await panel(securityProfile, provider, finding, diffSectionForTheFile, createLimiter(4))
 * if (verdict.confidence) console.log(`kept: ${verdict.confidence}`)
 */
export async function panel(profile: Profile, provider: Provider, finding: Finding, diffContext: string, limit: Limiter): Promise<Verdict> {
  const votes = await Promise.all(profile.lenses.map(lens => vote(profile, provider, finding, lens, diffContext, limit)))
  const keptVotes = votes.filter(v => v.vote?.keep).length
  return { ...finding, keptVotes, totalVotes: votes.length, confidence: confidenceFor(keptVotes, thresholdsFor(profile)), votes }
}

/**
 * Full pipeline for one profile, the security one by default: find candidates in a diff with the
 * research provider, then panel-verify each independently with the voter provider before reporting.
 * The profile is checked first, before the empty-diff short-circuit and before any model call. Each
 * voter receives the diff section of the file its finding cites. A finding whose failed votes left
 * it undecided is `unreviewed`, a kept finding whose failed votes could have raised it is recorded
 * in `meta.incomplete`, and research gaps are there too: the gaps the harness detects never read as
 * a clean review (ADR-0012).
 *
 * @throws ConfigError when the profile breaks a rule profileIssues checks, before any model call
 *
 * @example
 * const { kept, discarded, unreviewed, meta } = await review(diffText, { research: provider, voter: provider }, { onProgress: console.error })
 * console.log(`${kept.length} kept, ${discarded.length} discarded, ${unreviewed.length} unreviewed`)
 */
export async function review(diff: string, providers: Providers, options: ReviewOptions = {}): Promise<QuorumResult> {
  const profile = options.profile ?? securityProfile
  const issues = profileIssues(profile)
  if (issues.length > 0) throw new ConfigError(issues)
  const log = options.onProgress ?? (() => {})
  const result: QuorumResult = { kept: [], discarded: [], unreviewed: [], meta: { incomplete: [] } }
  if (diff.trim() === '') {
    log('empty diff: nothing to review')
    return result
  }
  const limit = createLimiter(DEFAULT_CONCURRENCY)
  const thresholds = thresholdsFor(profile)

  const sections = splitDiff(diff)
  const { findings, invalid, incomplete } = await research(profile, providers.research, diff, limit, sections)
  if (invalid.length > 0) log(`${invalid.length} invalid finding(s) dropped`)
  for (const entry of incomplete) log(`incomplete: ${entry.reason} (${entry.detail})`)
  result.meta.incomplete = incomplete
  const candidates = dedup(findings)
  log(`${candidates.length} candidate(s) after dedup`)

  const verdicts = await Promise.all(candidates.map(finding => panel(profile, providers.voter, finding, diffSectionFor(sections, finding.file, diff), limit)))
  for (const verdict of verdicts) result[verdictStatus(verdict, thresholds)].push(verdict)
  for (const verdict of result.kept) {
    const undecided = undecidedLevel(verdict, thresholds)
    if (undecided === undefined) continue
    const failed = verdict.votes.filter(lensVote => lensVote.vote === null).length
    // The file name is JSON-quoted: a decoded diff path can hold control characters, and this line reaches stderr.
    const entry: IncompleteEntry = { profile: profile.id, reason: 'vote-failed', file: verdict.file, detail: `${JSON.stringify(verdict.file)}:${verdict.line} is kept at ${verdict.confidence}, but ${failed} failed vote(s) could have made it ${undecided}` }
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
  return review(diff, providersFromEnv(process.env), { onProgress })
}
