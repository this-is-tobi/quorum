import { factsOf, replyBudget } from '../budgets.ts'
import { diffSectionFor, hunksOf, sectionFor } from '../diff.ts'
import { ProviderDownError } from '../errors.ts'
import { isLimit } from '../limits.ts'
import { parseVoteReply } from '../output.ts'
import { nearestHunks } from '../parts.ts'
import { confidenceFor, undecidedLevel, verdictStatus } from '../policy.ts'
import type { CompletionRequest } from '../ports.ts'
import { voteRequest } from '../prompts.ts'
import { tokenBound } from '../tokens.ts'
import type { Confidence, Finding, IncompleteEntry, LensVote, Verdict, VerdictStatus, Vote, VoteFailure } from '../types.ts'
import { isTooLarge, providerFailure, refusalMessage } from '../facts.ts'
import { callProvider, roomOf } from './context.ts'
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

/** What the votes on one finding read of the diff: the text of the cited file's section, the whole diff when the file has none, and the sections that text is one of. */
interface VoteContext {
  readonly text: string
  readonly sections: ReadonlyMap<string, string>
}

/** One lens's vote, and, when its provider refused the request as too large, the refusal's message. */
interface Cast {
  lensVote: LensVote
  refusal?: string
}

/**
 * The panel stage of one profile: every finding goes to every lens, each vote to the lens's own
 * provider, and the quorum verdict is computed in code. A vote's context is the diff section of the
 * file its finding cites, the whole diff when the file has no section of its own. It is partial only
 * for a voter that states a room (`Provider.room`) the section does not fit: that voter receives the
 * section's header and the hunks nearest the cited line that fit its room, the cited hunk first (see
 * `nearestHunks`), and its diff block says so. A voter that states no room, or whose room holds the
 * section, receives the section as before, and so does one whose room does not hold the cited hunk
 * alone, which its provider then refuses as too large. The context is chosen when the vote's request
 * is built, inside the vote's slot.
 *
 * A voter never sees the other votes or their reasoning - independence is the point, not an
 * oversight. Letting verifiers see each other's reasoning measurably converges results toward
 * consensus rather than correctness. The keep/discard decision and the confidence ceiling are
 * ordinary arithmetic here, the profile's thresholds over the kept votes, not something any voter's
 * self-reported confidence gets to override: with the security profile, unanimous 3/3 is a ceiling
 * of 'high', a 2/3 split is capped at 'medium' no matter how certain any one voter sounded.
 *
 * A failed vote counts as a reject and is recorded with its error and its failure, never as a crash,
 * but a vote cut by the review's abort is not a failed vote: it rejects the panel with the abort's
 * reason at once, without waiting for the votes still in flight. A vote request its provider refused
 * as too large is a failed vote that also records a `request-too-large` gap. Each vote emits a `vote`
 * event.
 * Once a finding's votes are in, its verdict emits a `verdict` event, then its gaps are reported by
 * `incomplete` events: one `request-too-large` gap when any vote request was refused, and a
 * `vote-failed` gap when a kept verdict's failed votes leave a higher level undecided (ADR-0012).
 */
export async function panel(ctx: RunContext, run: ProfileRun, findings: readonly Finding[], sections: ReadonlyMap<string, string>, diff: string): Promise<PanelOutcome> {
  const judged = await Promise.all(findings.map(finding => judge(ctx, run, finding, {
    text: diffSectionFor(sections, finding.file, diff),
    sections,
  })))
  const outcome: PanelOutcome = {
    kept: [],
    discarded: [],
    unreviewed: [],
    incomplete: [],
  }
  for (const { verdict, status, gaps } of judged) {
    outcome[status].push(verdict)
    outcome.incomplete.push(...gaps)
  }
  return outcome
}

async function judge(ctx: RunContext, run: ProfileRun, finding: Finding, context: VoteContext): Promise<Judged> {
  const casts = await Promise.all(run.lenses.map(lens => castVote(ctx, run, finding, lens, context)))
  const votes = casts.map(({ lensVote }) => lensVote)
  const refusals = casts.flatMap(({ refusal }) => refusal === undefined
    ? []
    : [refusal])
  const keptVotes = votes.filter(lensVote => lensVote.vote?.keep).length
  const verdict: Verdict = {
    ...finding,
    keptVotes,
    totalVotes: votes.length,
    confidence: confidenceFor(keptVotes, run.thresholds),
    votes,
  }
  const status = verdictStatus(verdict, run.thresholds)
  const { confidence } = verdict
  ctx.emit({
    type: 'verdict',
    profile: run.id,
    findingId: finding.id,
    keptVotes,
    totalVotes: votes.length,
    ...(confidence === undefined
      ? {}
      : { confidence }),
    status,
  })
  const gaps: IncompleteEntry[] = []
  if (refusals.length > 0) gaps.push(requestTooLarge(run.id, finding, refusals, votes.length))
  const undecided = status === 'kept'
    ? undecidedLevel(verdict, run.thresholds)
    : undefined
  if (undecided !== undefined) gaps.push(voteFailed(run.id, verdict, undecided))
  for (const entry of gaps) ctx.emit({ type: 'incomplete', entry })
  return { verdict, status, gaps }
}

/**
 * One lens's vote on one finding, from the lens's own provider. A failed call or an unusable reply
 * is a vote of null with its error: the message of an `Error`, the text of anything else thrown.
 * It also records its failure: `voteFailureOf` the error for a failed call (a call the token cap or the
 * review's deadline stopped is a failed vote of kind `token-cap` or `review-deadline`, and one its provider's
 * being down kept from being sent is of kind `provider-down`), `unusable-reply`
 * for a reply that came back and could not be read as a vote; a cast vote's failure is null. A request its provider refused as too large is
 * that failed vote too, and carries the refusal's message besides, for the finding's `request-too-large`
 * gap. Once the review is aborted, the vote rethrows the abort's reason instead, whatever the call
 * raised, so an aborted review never resolves with a finding the abort left unreviewed. The `vote` event
 * is emitted after the vote's own `try`, so a sink that throws on it is never recorded as a failed vote.
 */
async function castVote(ctx: RunContext, run: ProfileRun, finding: Finding, lens: LensRun, context: VoteContext): Promise<Cast> {
  let lensVote: LensVote
  let refusal: string | undefined
  /** The error of a reply that was no vote: a stored reply that failed its check and was asked again leaves one that no later failure is. */
  let unreadable: { readonly error: unknown } | undefined
  try {
    // The vote is read inside the call, once it has answered, so a reply that is no vote is the voter's `unusable-reply`.
    const read: { vote?: Vote } = {}
    await callProvider(ctx, {
      profile: run.id,
      role: 'vote',
      lens: lens.id,
      finding: finding.id,
    }, lens, () => requestFor(ctx, run, finding, lens, context), {
      check: (text) => {
        try {
          read.vote = parseVoteReply(text)
        } catch (error) {
          unreadable = { error }
          throw error
        }
        return { saturated: false }
      },
    })
    lensVote = {
      angle: lens.id,
      vote: read.vote!,
      error: null,
      failure: null,
    }
  } catch (error) {
    // Once the review is aborted, a failed call is not the voter's failure: the review rejects with the abort's reason.
    ctx.signal.throwIfAborted()
    lensVote = {
      angle: lens.id,
      vote: null,
      error: error instanceof Error
        ? error.message
        : String(error),
      failure: unreadable !== undefined && unreadable.error === error
        ? { kind: 'unusable-reply' }
        : voteFailureOf(error),
    }
    if (isTooLarge(error)) refusal = refusalMessage(error)
  }
  const { error, failure } = lensVote
  ctx.emit({
    type: 'vote',
    profile: run.id,
    findingId: finding.id,
    lens: lens.id,
    keep: lensVote.vote?.keep ?? null,
    ...(error === null
      ? {}
      : { error }),
    ...(failure === null
      ? {}
      : { failure }),
  })
  return refusal === undefined
    ? { lensVote }
    : { lensVote, refusal }
}

/**
 * The request of one vote. The finding's cited file's section is its context, as `voteRequest` takes it,
 * unless the lens's voter states a room the section does not fit: its room for the request with an empty
 * diff block, which text added to the block lowers by exactly its `tokenBound`, is below the section's.
 * The context is then the section's header and the hunks nearest the cited line that fit the room of the
 * request that describes them (see `nearestHunks`), when the cited hunk fits alone. A voter that states no
 * room has no request built to ask. `undefined` from `nearestHunks`, a cited line no hunk holds or a cited
 * hunk that does not fit alone, sends the whole context, which the provider refuses as too large if it is. The
 * request, and each request the choice of context asks the room of, carries the lens's reply budget, held to what a cut on the way
 * lets through once its provider learned one (`ctx.clocks.ceiling`).
 */
function requestFor(ctx: RunContext, run: ProfileRun, finding: Finding, lens: LensRun, context: VoteContext): CompletionRequest {
  const stated = ctx.budgets[run.id].lenses[lens.id]
  const ceiling = ctx.clocks.ceiling(lens)
  // A voter whose calls are cut on the way, at a length it learned, has a derived budget held to what the cut lets through.
  const replyTokens = ceiling === undefined
    ? stated.replyTokens
    : replyBudget({
      ...factsOf(lens),
      ceiling,
    }, stated.window, ctx.maxFindings).vote
  const ask = { replyTokens }
  const nearest = lens.room === undefined
    ? undefined
    : nearestContext(run, finding, lens, context.sections, ask)
  return nearest === undefined
    ? voteRequest(lens.instructions, finding, context.text, run.guidelines, false, ask)
    : voteRequest(lens.instructions, finding, nearest, run.guidelines, true, ask)
}

/** The partial context of a voter that states a room, or undefined when the whole section fits, or nothing of it does. */
function nearestContext(run: ProfileRun, finding: Finding, lens: LensRun, sections: ReadonlyMap<string, string>, ask: { readonly replyTokens?: number }): string | undefined {
  const section = sectionFor(sections, finding.file)
  if (section === undefined) return undefined
  const room = roomOf(lens, voteRequest(lens.instructions, finding, '', run.guidelines, false, ask))
  if (room === undefined || tokenBound(section.text) <= room) return undefined
  const partialRoom = roomOf(lens, voteRequest(lens.instructions, finding, '', run.guidelines, true, ask))
  return partialRoom === undefined
    ? undefined
    : nearestHunks(section.text, hunksOf(sections, section.path, section.text), finding.line, partialRoom)
}

/** What a call that failed says of itself as a vote's failure: the limit that stopped it, `provider-down` for a vote its provider's being down kept from being sent, else its `kind` and `status` as `providerFailure` reads them, never its `exhausted`, else `unknown`. */
function voteFailureOf(error: unknown): VoteFailure {
  if (isLimit(error)) return { kind: error.limit }
  if (error instanceof ProviderDownError) return { kind: 'provider-down' }
  const failure = providerFailure(error)
  if (failure === undefined) return { kind: 'unknown' }
  // The result schema's vote failure is strict: a used-up quota is the provider-down event's fact, not the vote's.
  return failure.status === undefined
    ? { kind: failure.kind }
    : { kind: failure.kind, status: failure.status }
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
