import { chat } from './client.ts'
import { createLimiter, DEFAULT_CONCURRENCY } from './core/concurrency.ts'
import type { Limiter } from './core/concurrency.ts'
import { diffSectionFor, splitDiff } from './core/diff.ts'
import { parseVoteReply } from './core/output.ts'
import { confidenceFor, defaultPolicy, resolvePolicy, verdictStatus } from './core/policy.ts'
import { defaultPrompts, renderTemplate, researchRequest, voteRequest } from './core/prompts.ts'
import { checkReply, DEFAULT_MAX_FINDINGS } from './core/stages/research.ts'
import type { ResearchOutcome } from './core/stages/research.ts'
import type { Finding, Lens, LensVote, QuorumResult, Verdict } from './core/types.ts'

/**
 * The three fixed, orthogonal angles every panel vote is judged from. Three is not an arbitrary
 * round number: self-consistency research shows most of the achievable gain from repeated sampling
 * arrives by roughly five to ten samples on a capable model, and running votes in parallel has a
 * real latency cost - three independent, non-debating, differently-angled votes is close to the
 * cost-effective floor, not a placeholder for "more agents later".
 */
export const LENSES: readonly Lens[] = [
  {
    angle: 'reachability',
    question: 'Is this sink actually reachable from untrusted input in normal flow - not just syntactically present?',
  },
  {
    angle: 'impact',
    question: 'If reached, is the impact real - not just bad-looking code?',
  },
  {
    angle: 'defenses',
    question: 'Do existing checks elsewhere already neutralize this?',
  },
]

/** The default policy resolved for the three lenses: 3/3 → high, 2/3 → medium, low disabled. */
const THRESHOLDS = resolvePolicy(defaultPolicy, LENSES.length).thresholds

/**
 * Ask the research role to propose candidate findings in a diff, then check each against the diff.
 * The reply is validated: one without a `findings` array fails the run (fail closed), findings that
 * are malformed, or cite a file or line the diff does not contain, are dropped with a reason, only
 * the first `maxFindings` are read, and a reply with no usable finding is recorded as incomplete.
 * What survives carries evidence read from the diff, never the finder's quote.
 *
 * @example
 * const { findings, invalid, incomplete } = await research(diffText, createLimiter(4))
 */
export async function research(
  diff: string,
  limit: Limiter,
  sections: ReadonlyMap<string, string> = splitDiff(diff),
  maxFindings: number = DEFAULT_MAX_FINDINGS,
): Promise<ResearchOutcome> {
  const reply = await limit(() => chat('RESEARCH', researchRequest(defaultPrompts.research, diff)))
  return checkReply(reply, sections, maxFindings)
}

/**
 * Drop candidates that independent lenses (once there is more than one) or repeated runs
 * rediscovered at the same location - plain code, not a model, same as the quorum tally below.
 *
 * @example
 * dedup([a, b, a]) // -> [a, b], keyed by file:line:category
 */
export function dedup(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.line}:${finding.category}`
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
async function vote(finding: Finding, lens: Lens, diffContext: string, limit: Limiter): Promise<LensVote> {
  const instructions = renderTemplate(defaultPrompts.vote, {
    'lens.id': lens.angle,
    'lens.question': lens.question,
    'panel.size': String(LENSES.length),
  })
  try {
    const result = parseVoteReply(await limit(() => chat('VOTER', voteRequest(instructions, finding, diffContext))))
    return { angle: lens.angle, vote: result, error: null }
  } catch (error) {
    return { angle: lens.angle, vote: null, error: (error as Error).message }
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
 * const verdict = await panel(finding, diffSectionForTheFile, createLimiter(4))
 * if (verdict.confidence) console.log(`kept: ${verdict.confidence}`)
 */
export async function panel(finding: Finding, diffContext: string, limit: Limiter): Promise<Verdict> {
  const votes = await Promise.all(LENSES.map(lens => vote(finding, lens, diffContext, limit)))
  const keptVotes = votes.filter(v => v.vote?.keep).length
  return { ...finding, keptVotes, totalVotes: votes.length, confidence: confidenceFor(keptVotes, THRESHOLDS), votes }
}

/**
 * Full pipeline: find candidates in a diff, then panel-verify each independently before reporting.
 * Each voter receives the diff section of the file its finding cites. A finding whose failed votes
 * left it undecided is `unreviewed`, and research gaps are in `meta.incomplete`: an incomplete
 * review never reads as a clean one (ADR-0012).
 *
 * @example
 * const { kept, discarded, unreviewed, meta } = await runQuorum(diffText)
 * console.log(`${kept.length} kept, ${discarded.length} discarded, ${unreviewed.length} unreviewed`)
 */
export async function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult> {
  const log = onProgress ?? (() => {})
  const result: QuorumResult = { kept: [], discarded: [], unreviewed: [], meta: { incomplete: [] } }
  if (diff.trim() === '') {
    log('empty diff: nothing to review')
    return result
  }
  const limit = createLimiter(DEFAULT_CONCURRENCY)

  const sections = splitDiff(diff)
  const { findings, invalid, incomplete } = await research(diff, limit, sections)
  if (invalid.length > 0) log(`${invalid.length} invalid finding(s) dropped`)
  for (const entry of incomplete) log(`incomplete: ${entry.reason} (${entry.detail})`)
  result.meta.incomplete = incomplete
  const candidates = dedup(findings)
  log(`${candidates.length} candidate(s) after dedup`)

  const verdicts = await Promise.all(candidates.map(finding => panel(finding, diffSectionFor(sections, finding.file, diff), limit)))
  for (const verdict of verdicts) result[verdictStatus(verdict, THRESHOLDS)].push(verdict)
  log(`${result.kept.length} kept, ${result.discarded.length} discarded, ${result.unreviewed.length} unreviewed by panel`)

  return result
}
