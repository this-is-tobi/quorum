import { diffSectionFor } from '../diff.ts'
import { parseVoteReply } from '../output.ts'
import { confidenceFor, undecidedLevel, verdictStatus } from '../policy.ts'
import { voteRequest } from '../prompts.ts'
import type { Confidence, Finding, IncompleteEntry, LensVote, Verdict, VerdictStatus } from '../types.ts'
import { callProvider } from './context.ts'
import type { LensRun, ProfileRun, RunContext } from './context.ts'

/** Where the panel put each finding, the arrays keeping the findings' order, and the gaps its failed votes left. */
export interface PanelOutcome {
  kept: Verdict[]
  discarded: Verdict[]
  /** Findings a failed vote left undecided: neither kept nor cleared. */
  unreviewed: Verdict[]
  /** One `vote-failed` entry per kept finding whose failed votes could have raised it to a higher level. */
  incomplete: IncompleteEntry[]
}

/** One finding judged by every lens: its verdict, where it lands, and the gap its failed votes leave, if any. */
interface Judged {
  verdict: Verdict
  status: VerdictStatus
  gap?: IncompleteEntry
}

/**
 * The panel stage of one profile: every finding goes to every lens, each vote to the lens's own
 * provider, and the quorum verdict is computed in code. Each voter receives the diff section of the
 * file its finding cites.
 *
 * A voter never sees the other votes or their reasoning - independence is the point, not an
 * oversight. Letting verifiers see each other's reasoning measurably converges results toward
 * consensus rather than correctness. The keep/discard decision and the confidence ceiling are
 * ordinary arithmetic here, the profile's thresholds over the kept votes, not something any voter's
 * self-reported confidence gets to override: with the security profile, unanimous 3/3 is a ceiling
 * of 'high', a 2/3 split is capped at 'medium' no matter how certain any one voter sounded.
 *
 * A failed vote counts as a reject and is recorded with its error, never as a crash. Each vote
 * emits a `vote` event. Once a finding's votes are in, its verdict emits a `verdict` event, and a
 * kept verdict whose failed votes leave a higher level undecided records a `vote-failed` gap,
 * reported by an `incomplete` event (ADR-0012).
 */
export async function panel(ctx: RunContext, run: ProfileRun, findings: readonly Finding[], sections: ReadonlyMap<string, string>, diff: string): Promise<PanelOutcome> {
  const judged = await Promise.all(findings.map(finding => judge(ctx, run, finding, diffSectionFor(sections, finding.file, diff))))
  const outcome: PanelOutcome = { kept: [], discarded: [], unreviewed: [], incomplete: [] }
  for (const { verdict, status, gap } of judged) {
    outcome[status].push(verdict)
    if (gap) outcome.incomplete.push(gap)
  }
  return outcome
}

async function judge(ctx: RunContext, run: ProfileRun, finding: Finding, diffContext: string): Promise<Judged> {
  const votes = await Promise.all(run.lenses.map(lens => castVote(ctx, run, finding, lens, diffContext)))
  const keptVotes = votes.filter(lensVote => lensVote.vote?.keep).length
  const verdict: Verdict = { ...finding, keptVotes, totalVotes: votes.length, confidence: confidenceFor(keptVotes, run.thresholds), votes }
  const status = verdictStatus(verdict, run.thresholds)
  const { confidence } = verdict
  ctx.emit({ type: 'verdict', profile: run.id, findingId: finding.id, keptVotes, totalVotes: votes.length, ...(confidence === undefined ? {} : { confidence }), status })
  const undecided = status === 'kept' ? undecidedLevel(verdict, run.thresholds) : undefined
  if (undecided === undefined) return { verdict, status }
  const gap = voteFailed(run.id, verdict, undecided)
  ctx.emit({ type: 'incomplete', entry: gap })
  return { verdict, status, gap }
}

/**
 * One lens's vote on one finding, from the lens's own provider. A failed call or an unusable reply
 * is a vote of null with its error: the message of an `Error`, the text of anything else thrown.
 * The `vote` event is emitted after the vote's own `try`, so a sink that throws on it is never
 * recorded as a failed vote.
 */
async function castVote(ctx: RunContext, run: ProfileRun, finding: Finding, lens: LensRun, diffContext: string): Promise<LensVote> {
  let lensVote: LensVote
  try {
    const text = await callProvider(ctx, { profile: run.id, role: 'vote', lens: lens.id }, lens, voteRequest(lens.instructions, finding, diffContext, run.guidelines))
    lensVote = { angle: lens.id, vote: parseVoteReply(text), error: null }
  } catch (error) {
    lensVote = { angle: lens.id, vote: null, error: error instanceof Error ? error.message : String(error) }
  }
  const { error } = lensVote
  ctx.emit({ type: 'vote', profile: run.id, findingId: finding.id, lens: lens.id, keep: lensVote.vote?.keep ?? null, ...(error === null ? {} : { error }) })
  return lensVote
}

/**
 * The gap a kept verdict leaves when its failed votes could have raised it to `undecided`. The file
 * name is JSON-quoted: a decoded diff path can hold control characters, and this line reaches stderr.
 */
function voteFailed(profile: string, verdict: Verdict, undecided: Confidence): IncompleteEntry {
  const failed = verdict.votes.filter(lensVote => lensVote.vote === null).length
  return {
    profile,
    reason: 'vote-failed',
    file: verdict.file,
    detail: `${JSON.stringify(verdict.file)}:${verdict.line} is kept at ${verdict.confidence}, but ${failed} failed vote(s) could have made it ${undecided}`,
  }
}
