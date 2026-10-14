import { chat } from './client.ts'
import { createLimiter, DEFAULT_CONCURRENCY } from './core/concurrency.ts'
import type { Limiter } from './core/concurrency.ts'
import { diffSectionFor, splitDiff } from './core/diff.ts'
import { parseResearchReply, parseVoteReply } from './core/output.ts'
import { defaultPrompts, renderTemplate, researchRequest, voteRequest } from './core/prompts.ts'
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

/**
 * Ask the research role to propose candidate findings in a diff. The reply is validated: one
 * without a `findings` array fails the run (fail closed), and invalid findings are dropped with a reason.
 *
 * @example
 * const { findings, invalid } = await research(diffText, createLimiter(4))
 */
export async function research(diff: string, limit: Limiter): Promise<{ findings: Finding[], invalid: string[] }> {
  return parseResearchReply(await limit(() => chat('RESEARCH', researchRequest(defaultPrompts.research, diff))))
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
 * decision and the confidence ceiling are ordinary arithmetic here, not something any voter's
 * self-reported confidence gets to override: unanimous 3/3 is a ceiling of 'high', a 2/3 split is
 * capped at 'medium' no matter how certain any one voter sounded.
 *
 * @example
 * const verdict = await panel(finding, diffSectionForTheFile, createLimiter(4))
 * if (verdict.confidence) console.log(`kept: ${verdict.confidence}`)
 */
export async function panel(finding: Finding, diffContext: string, limit: Limiter): Promise<Verdict> {
  const votes = await Promise.all(LENSES.map(lens => vote(finding, lens, diffContext, limit)))
  const keptVotes = votes.filter(v => v.vote?.keep).length
  const confidence = keptVotes === 3 ? 'high' : keptVotes === 2 ? 'medium' : undefined
  return { ...finding, keptVotes, confidence, votes }
}

/**
 * Full pipeline: find candidates in a diff, then panel-verify each independently before reporting.
 * Each voter receives the diff section of the file its finding cites.
 *
 * @example
 * const { kept, discarded } = await runQuorum(diffText)
 * console.log(`${kept.length} kept, ${discarded.length} discarded by panel`)
 */
export async function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult> {
  const log = onProgress ?? (() => {})
  const limit = createLimiter(DEFAULT_CONCURRENCY)

  const { findings, invalid } = await research(diff, limit)
  if (invalid.length > 0) log(`${invalid.length} invalid finding(s) dropped`)
  const candidates = dedup(findings)
  log(`${candidates.length} candidate(s) after dedup`)

  const sections = splitDiff(diff)
  const verdicts = await Promise.all(candidates.map(finding => panel(finding, diffSectionFor(sections, finding.file, diff), limit)))
  const kept = verdicts.filter(v => v.confidence)
  const discarded = verdicts.filter(v => !v.confidence)
  log(`${kept.length} kept, ${discarded.length} discarded by panel`)

  return { kept, discarded }
}
