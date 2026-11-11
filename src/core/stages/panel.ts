import { diffSectionFor } from '../diff.ts'
import { parseVoteReply } from '../output.ts'
import { confidenceFor, undecidedLevel, verdictStatus } from '../policy.ts'
import { voteRequest } from '../prompts.ts'
import type { Confidence, Finding, IncompleteEntry, LensVote, Verdict, VerdictStatus } from '../types.ts'
import { callProvider, isTooLarge, refusalMessage } from './context.ts'
import type { LensRun, ProfileRun, RunContext } from './context.ts'

/** Where the panel put each finding, the arrays keeping the findings' order, and the gaps its failed votes left. */
export interface PanelOutcome {
  kept: Verdict[]
  discarded: Verdict[]
  /** Findings a failed vote left undecided: neither kept nor cleared. */
  unreviewed: Verdict[]
  /** What the failed votes left: a `request-too-large` entry per finding with a vote request refused, and a `vote-failed` entry per kept finding whose failed votes could have raised it to a higher level. */
  incomplete: IncompleteEntry[]
}

/** One finding judged by every lens: its verdict, where it lands, and the gaps its failed votes leave, in the order they were recorded. */
interface Judged {
  verdict: Verdict
  status: VerdictStatus
  gaps: IncompleteEntry[]
}

/** One lens's vote, and, when its provider refused the request as too large, the refusal's message. */
interface Cast {
  lensVote: LensVote
  refusal?: string
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
 * A failed vote counts as a reject and is recorded with its error, never as a crash, but a vote cut
 * by the review's abort is not a failed vote: it rejects the panel with the abort's reason at once,
 * without waiting for the votes still in flight. A vote request its provider refused as too large
 * is a failed vote that also records a `request-too-large` gap. Each vote emits a `vote` event.
 * Once a finding's votes are in, its verdict emits a `verdict` event, then its gaps are reported by
 * `incomplete` events: one `request-too-large` gap when any vote request was refused, and a
 * `vote-failed` gap when a kept verdict's failed votes leave a higher level undecided (ADR-0012).
 */
export async function panel(ctx: RunContext, run: ProfileRun, findings: readonly Finding[], sections: ReadonlyMap<string, string>, diff: string): Promise<PanelOutcome> {
  const judged = await Promise.all(findings.map(finding => judge(ctx, run, finding, diffSectionFor(sections, finding.file, diff))))
  const outcome: PanelOutcome = { kept: [], discarded: [], unreviewed: [], incomplete: [] }
  for (const { verdict, status, gaps } of judged) {
    outcome[status].push(verdict)
    outcome.incomplete.push(...gaps)
  }
  return outcome
}

async function judge(ctx: RunContext, run: ProfileRun, finding: Finding, diffContext: string): Promise<Judged> {
  const casts = await Promise.all(run.lenses.map(lens => castVote(ctx, run, finding, lens, diffContext)))
  const votes = casts.map(({ lensVote }) => lensVote)
  const refusals = casts.flatMap(({ refusal }) => refusal === undefined ? [] : [refusal])
  const keptVotes = votes.filter(lensVote => lensVote.vote?.keep).length
  const verdict: Verdict = { ...finding, keptVotes, totalVotes: votes.length, confidence: confidenceFor(keptVotes, run.thresholds), votes }
  const status = verdictStatus(verdict, run.thresholds)
  const { confidence } = verdict
  ctx.emit({ type: 'verdict', profile: run.id, findingId: finding.id, keptVotes, totalVotes: votes.length, ...(confidence === undefined ? {} : { confidence }), status })
  const gaps: IncompleteEntry[] = []
  if (refusals.length > 0) gaps.push(requestTooLarge(run.id, finding, refusals, votes.length))
  const undecided = status === 'kept' ? undecidedLevel(verdict, run.thresholds) : undefined
  if (undecided !== undefined) gaps.push(voteFailed(run.id, verdict, undecided))
  for (const entry of gaps) ctx.emit({ type: 'incomplete', entry })
  return { verdict, status, gaps }
}

/**
 * One lens's vote on one finding, from the lens's own provider. A failed call or an unusable reply
 * is a vote of null with its error: the message of an `Error`, the text of anything else thrown.
 * A request its provider refused as too large is that failed vote too, and carries the refusal's
 * message besides, for the finding's `request-too-large` gap. Once the review is aborted, the vote
 * rethrows the abort's reason instead, whatever the call raised, so an aborted review never
 * resolves with a finding the abort left unreviewed. The `vote` event is emitted after the vote's
 * own `try`, so a sink that throws on it is never recorded as a failed vote.
 */
async function castVote(ctx: RunContext, run: ProfileRun, finding: Finding, lens: LensRun, diffContext: string): Promise<Cast> {
  let lensVote: LensVote
  let refusal: string | undefined
  try {
    const text = await callProvider(ctx, { profile: run.id, role: 'vote', lens: lens.id }, lens, () => voteRequest(lens.instructions, finding, diffContext, run.guidelines))
    lensVote = { angle: lens.id, vote: parseVoteReply(text), error: null }
  } catch (error) {
    // Once the review is aborted, a failed call is not the voter's failure: the review rejects with the abort's reason.
    ctx.signal.throwIfAborted()
    lensVote = { angle: lens.id, vote: null, error: error instanceof Error ? error.message : String(error) }
    if (isTooLarge(error)) refusal = refusalMessage(error)
  }
  const { error } = lensVote
  ctx.emit({ type: 'vote', profile: run.id, findingId: finding.id, lens: lens.id, keep: lensVote.vote?.keep ?? null, ...(error === null ? {} : { error }) })
  return refusal === undefined ? { lensVote } : { lensVote, refusal }
}

/**
 * The gap a finding leaves when its provider refused some of its vote requests as too large. The file
 * name is JSON-quoted, as in `voteFailed`; the detail names the first refusal in lens order.
 */
function requestTooLarge(profile: string, finding: Finding, refusals: readonly string[], lenses: number): IncompleteEntry {
  return {
    profile,
    reason: 'request-too-large',
    file: finding.file,
    detail: `${JSON.stringify(finding.file)}:${finding.line}: ${refusals.length} of ${lenses} vote requests were not sent: ${refusals[0]}`,
  }
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
