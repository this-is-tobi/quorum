import { createHash } from 'node:crypto'
import type { DiffSection } from '../diff.ts'
import { OutputError } from '../errors.ts'
import { isLimit } from '../limits.ts'
import type { LimitName } from '../limits.ts'
import { parseResearchReply } from '../output.ts'
import { listedFiles, packParts, partText } from '../parts.ts'
import type { Packing, PartOutcome } from '../parts.ts'
import type { CompletionRequest } from '../ports.ts'
import { researchRequest } from '../prompts.ts'
import { tokenBound } from '../tokens.ts'
import type { Finding, FindingDetails, IncompleteEntry } from '../types.ts'
import { verifyFindings } from '../verify.ts'
import { callProvider, isTooLarge, providerFailure, refusalMessage, roomOf } from './context.ts'
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
  /** What the run could not review: findings the harness could not read, findings beyond the cap, a reply whose findings were all unusable, research requests refused as too large, or an advisory profile's research that failed. */
  incomplete: IncompleteEntry[]
  /**
   * What became of each research part, in the parts' order: `reviewed` when its reply was a valid findings
   * envelope, the limit's name when the token cap or the deadline stopped it (its gap is written once the
   * profile's panel has run, with the votes the limit stopped), else why it was not read. One entry for a
   * research of one request, none when no part holds any of the diff.
   */
  parts: PartOutcome[]
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
 * How one profile's research goes: the sections of the filtered diff, and how they are packed. No packing
 * is one request holding the whole diff, as it always was. A packing is the parts the research is sent in,
 * and `listed` is the change's files every part's request names.
 */
export interface ResearchPlan {
  readonly sections: readonly DiffSection[]
  readonly packing?: Packing
  /** The files the parts' requests name; set with `packing`. */
  readonly listed?: ListedFiles
}

/** The files a part's request names, as the diff writes them, and how many are left out. */
interface ListedFiles {
  readonly files: readonly string[]
  readonly unlisted: number
}

/** The lines of `text`, the last one included. */
function lineCount(text: string): number {
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++
  return lines
}

/**
 * Plan a profile's research of the filtered `diff`, whose sections are `sections`, before any stage runs.
 * The research is one request holding the whole diff, which is what 0.5.0 sent, when:
 * 1. the research provider states no room: no request is built to ask, so no nonce is drawn;
 * 2. the room of the one-request research with an empty diff is no safe integer or is negative: its guard
 *    then refuses the request as it always did;
 * 3. the diff's `tokenBound` is within the lesser of `partTokens` and that room;
 * 4. the room of a part's request with an empty diff, its parts block at its widest (a position and a
 *    count of as many digits as the diff has lines, which no packing has more parts than), is no safe
 *    integer or is negative;
 * 5. the packing sets a hunk aside while the one request still holds the whole diff: that hunk fits the
 *    one request but not a part's, which carries the parts block, and 0.5.0 read it, so nothing it read is
 *    left unread now.
 * Otherwise it is the packing of the sections into parts of at most `partTokens` that fit that room (see
 * `packParts`), with the change's files its requests name: at most 100, and at most a quarter of the
 * lesser of `partTokens` and the one request's room, so the list stays small beside the diff of a part. When that
 * packing sets a unit aside and the list names a file, the sections are packed again at the room of a parts
 * block that lists no name (`and <n> more` alone), asked at the same widest position, because the list
 * may be what left the unit out: the second packing and its block are kept when it sets fewer units aside,
 * else the first, and the rule above (5) applies to the packing kept.
 */
export function planResearch(run: ProfileRun, diff: string, sections: readonly DiffSection[], partTokens: number): ResearchPlan {
  const whole: ResearchPlan = { sections }
  if (run.research.room === undefined) return whole
  const { instructions } = run.research
  const one = roomOf(run.research, researchRequest(instructions, '', run.guidelines))
  if (one === undefined || one < 0) return whole
  const tokens = tokenBound(diff)
  if (tokens <= Math.min(partTokens, one)) return whole
  const widest = lineCount(diff)
  const roomWith = (names: ListedFiles): number | undefined => roomOf(run.research, researchRequest(instructions, '', run.guidelines, { index: widest, count: widest, ...names }))
  let listed: ListedFiles = listedFiles(sections, Math.floor(Math.min(partTokens, one) / 4))
  const room = roomWith(listed)
  if (room === undefined || room < 0) return whole
  let packing = packParts(sections, { partTokens, room })
  if (packing.tooLarge.length > 0 && listed.files.length > 0) {
    // The names a request lists take room a hunk may need: pack again with none listed, and keep that when it leaves fewer units out.
    const bare = { files: [], unlisted: listed.files.length + listed.unlisted }
    const bareRoom = roomWith(bare)
    const again = bareRoom !== undefined && bareRoom >= 0
      ? packParts(sections, { partTokens, room: bareRoom })
      : undefined
    if (again !== undefined && again.tooLarge.length < packing.tooLarge.length) {
      packing = again
      listed = bare
    }
  }
  if (packing.tooLarge.length > 0 && tokens <= one) return whole
  return { sections, packing, listed }
}

/**
 * Turn one research reply into what the panel receives: `checkReplies` of that reply alone, unlabelled, so
 * its gaps and its errors are the ones `checkReplies` states.
 *
 * @throws OutputError when the reply is not one JSON object holding a `findings` array and nothing else
 * @throws RangeError when `maxFindings` is not a positive integer
 */
export function checkReply(text: string, sections: ReadonlyMap<string, string>, profile: string, maxFindings = DEFAULT_MAX_FINDINGS): Omit<ResearchOutcome, 'parts'> {
  return checkReplies([
    { text },
  ], sections, profile, maxFindings)
}

/**
 * Turn the research replies of a profile, in the parts' order, into what the panel receives. Each reply is
 * parsed strictly (a malformed envelope, or one with a key other than `findings`, throws, so it never reads
 * as "no findings"), only the first `maxFindings` findings the replies list in all are read and checked
 * against the diff, the earlier replies' first (the work spent on a reply built to flood the run stays
 * bounded, whatever the entries hold), and nothing the harness read is dropped silently: a finding that
 * does not match the reply schema (what planted text that closes a string early leaves behind), findings
 * beyond the cap, counted over all the replies in one gap, and replies whose findings were all unusable,
 * are recorded as incomplete, which fails the run (ADR-0012). A finding that cites code outside the diff,
 * the whole diff of every part, is only dropped with its reason: it was read, and it is wrong. `invalid`
 * holds only the reasons of the findings the check against the diff dropped, so an unreadable finding is
 * reported once, in `incomplete`, with its reply's `label` before the reason when it has one. Every
 * finding it keeps is named by `findingId` and tagged with `profile`, and every incomplete entry it
 * records is tagged with `profile` too.
 *
 * @throws OutputError when a reply is not one JSON object holding a `findings` array and nothing else
 * @throws RangeError when `maxFindings` is not a positive integer
 */
export function checkReplies(replies: ReadonlyArray<{ readonly text: string, readonly label?: string }>, sections: ReadonlyMap<string, string>, profile: string, maxFindings = DEFAULT_MAX_FINDINGS): Omit<ResearchOutcome, 'parts'> {
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    throw new RangeError(`maxFindings must be a positive integer, got ${maxFindings}`)
  }
  const details: FindingDetails[] = []
  const unreadable: string[] = []
  let listed = 0
  for (const { text, label } of replies) {
    // A reply past the cap is parsed for its envelope and its count alone: its entries are not read.
    const left = maxFindings - details.length - unreadable.length
    const parsed = parseResearchReply(text, Math.max(left, 1))
    listed += parsed.listed
    if (left < 1) continue
    details.push(...parsed.findings)
    unreadable.push(...parsed.invalid.map(reason => label === undefined
      ? reason
      : `${label}: ${reason}`))
  }
  const checked = verifyFindings(details, sections)
  const findings = checked.findings.map((finding): Finding => ({
    id: findingId(profile, finding.file, finding.line, finding.category),
    profile,
    ...finding,
  }))
  const incomplete = unreadable.map((detail): IncompleteEntry => ({ profile, reason: 'finding-unreadable', detail }))
  if (listed > maxFindings) {
    incomplete.push({
      profile,
      reason: 'findings-capped',
      detail: `${listed - maxFindings} of ${listed} reported findings were not reviewed (the cap is ${maxFindings})`,
    })
  }
  if (listed > 0 && findings.length === 0) {
    const reported = `${listed} finding(s) reported`
    const detail = listed > maxFindings
      ? `${reported}, the first ${maxFindings} read, none usable`
      : `${reported}, none usable`
    incomplete.push({ profile, reason: 'research-unusable', detail })
  }
  return { findings, invalid: checked.invalid, incomplete }
}

/**
 * The research stage of one profile, as `plan` lays it out: a change within one request is researched by one
 * call to its research provider, with the profile's research instructions, the diff and the guidelines, and a
 * large change is researched in parts, one call each, whose replies `checkReplies` turns into what the panel
 * receives. Each finding dropped for citing code outside the diff is reported by a `finding:invalid` event,
 * and each gap by an `incomplete` event.
 *
 * A change in one request (no packing, or a packing of one part, whose text is that part's) goes through
 * one call. A research request its provider refused as too large (a `too-large` `ProviderError`) was not
 * sent: the profile reviews nothing, records one `request-too-large` gap, and the other profiles run. For
 * any other failed research, the call after its retries or a reply that is not a valid envelope, a gating
 * profile fails and aborts the review where it fails (`onFailure` aborts it for the call), so no other
 * profile starts a call after it; an advisory profile's failure is its own `research-failed` gap, in words
 * the code writes, and the other profiles run. A research request a limit stopped (the token cap refused it
 * or left no room for it, or the review's deadline ended it) is no failure of either kind: the outcome holds
 * no finding and names the limit in `parts`, which the review turns into the profile's one gap for that
 * limit, a gating profile's included. A packing of none, where no part holds any of the diff, makes no call, and
 * neither does a part whose text is blank (white space only, as the text before a diff's first header can be,
 * when every other unit was set aside): there is nothing to ask a model, so its outcome is `reviewed`.
 *
 * A packing of several parts runs `ctx.concurrency` workers of this profile, each taking the next part, in
 * order, while one is left, and a call of each through the review's one limit, so the review's concurrency
 * holds across profiles. Each part fails as a one-request research does, and a reply's envelope is checked
 * as it arrives: a gating profile's failed call or unreadable envelope aborts the review where it fails, so
 * no queued part starts and the review rejects with the first reason, and an advisory profile's is that
 * part's `research-failed`, while its other parts go on. Once a part ends with a limit, the profile's parts
 * not yet taken are stopped by the same limit without a call: each would be built and counted only to be
 * refused, and the gap counts them, failing closed. Once every part has answered, the replies are read in
 * the parts' order, up to `maxFindings` findings in all, each checked against the whole diff, and a finding
 * two parts report is dropped by the dedup stage. The gaps come in this order, each counting parts: the
 * requests refused as too large, then the parts that failed, then the reading's. The events follow: the
 * `finding:invalid` ones, then the `incomplete` ones.
 *
 * A review that is aborted rejects with its reason, never with a gap.
 *
 * @throws ProviderError, or whatever a custom provider throws, when a gating profile's research call fails for any other reason than a refusal as too large
 * @throws OutputError when a gating profile's reply is not one JSON object holding a `findings` array and nothing else
 */
export async function research(ctx: RunContext, run: ProfileRun, plan: ResearchPlan, diff: string, sections: ReadonlyMap<string, string>): Promise<ResearchOutcome> {
  const { packing } = plan
  if (packing === undefined) return researchInOne(ctx, run, diff, sections)
  if (packing.parts.length === 0) return nothingRead([])
  if (packing.parts.length === 1) {
    const text = partText(plan.sections, packing, packing.parts[0])
    return isBlank(text)
      ? nothingRead(['reviewed'])
      : researchInOne(ctx, run, text, sections)
  }
  return researchInParts(ctx, run, plan, packing, sections)
}

/** Whether `text` holds nothing but white space: a part of it asks the model nothing, as the text before a diff's first header can be. */
function isBlank(text: string): boolean {
  return text.trim() === ''
}

/** The outcome of a research that read no reply and found no gap: no finding, `parts` as given. */
function nothingRead(parts: PartOutcome[]): ResearchOutcome {
  return {
    findings: [],
    invalid: [],
    incomplete: [],
    parts,
  }
}

/** What became of one research request: its reply to read, the words of a failure to tell, or the limit that stopped it. */
type PartResult
  = | { readonly outcome: 'reviewed', readonly text: string }
    | { readonly outcome: 'request-too-large' | 'research-failed', readonly words: string }
    | { readonly outcome: LimitName }

type SpokenResult = Extract<PartResult, { readonly words: string }>

const isSpoken = (result: PartResult): result is SpokenResult => 'words' in result

const isStopped = (result: PartResult): result is Extract<PartResult, { readonly outcome: LimitName }> => result.outcome === 'token-cap' || result.outcome === 'review-deadline'

/**
 * One research request, sent and its reply's envelope checked, and what became of it: the one place where a
 * failure is told from a gap, for a research of one request and for each part of a research in parts alike.
 * `onFailure` aborts the review for a gating profile's failure (the call's, not a refusal as too large nor a
 * limit's) inside the call's slot, so no queued request starts after it. In this order:
 * - a limit that stopped the call is the limit's name;
 * - a refusal as too large is `request-too-large` with the refusal's message;
 * - any other failure of the call rethrows for a gating profile, and is `research-failed` with the words
 *   `researchFailed` writes for an advisory one;
 * - a reply that is no findings envelope aborts the review and rethrows for a gating profile, and for any
 *   error that is no `OutputError`; for an advisory profile it is `research-failed` with the reason;
 * - else `reviewed`, with the reply's text.
 * A limit, a refusal and an advisory failure are each told only after the review's abort check, so a review
 * that is aborted rejects with its reason, never with a gap.
 */
async function askResearch(ctx: RunContext, run: ProfileRun, request: () => CompletionRequest): Promise<PartResult> {
  let attempts = 1
  let text: string
  try {
    text = await callProvider(ctx, { profile: run.id, role: 'research' }, run.research, request, (error, made) => {
      attempts = made
      if (run.gating && !isTooLarge(error) && !isLimit(error)) ctx.fail(error)
    })
  } catch (error) {
    if (isLimit(error)) {
      ctx.signal.throwIfAborted()
      return { outcome: error.limit }
    }
    if (isTooLarge(error)) {
      ctx.signal.throwIfAborted()
      return {
        outcome: 'request-too-large',
        words: refusalMessage(error),
      }
    }
    // A gating profile's failure aborted the review where it failed (`onFailure`).
    if (run.gating) throw error
    ctx.signal.throwIfAborted()
    return {
      outcome: 'research-failed',
      words: researchFailed(error, attempts),
    }
  }
  try {
    parseResearchReply(text, 1)
  } catch (error) {
    if (run.gating || !(error instanceof OutputError)) {
      ctx.fail(error)
      throw error
    }
    ctx.signal.throwIfAborted()
    return { outcome: 'research-failed', words: `the research reply could not be read: ${error.reason}` }
  }
  return { outcome: 'reviewed', text }
}

/** One research request holding `diff`, its outcome's `parts` the one part's, and its failure told as a gap in today's words. */
async function researchInOne(ctx: RunContext, run: ProfileRun, diff: string, sections: ReadonlyMap<string, string>): Promise<ResearchOutcome> {
  const result = await askResearch(ctx, run, () => researchRequest(run.research.instructions, diff, run.guidelines))
  if (isSpoken(result)) {
    return gap(ctx, {
      profile: run.id,
      reason: result.outcome,
      detail: result.outcome === 'request-too-large'
        ? `the research request was not sent: ${result.words}`
        : result.words,
    }, result.outcome)
  }
  if (result.outcome !== 'reviewed') return nothingRead([result.outcome])
  return reported(ctx, run, {
    ...checkReply(result.text, sections, run.id, ctx.maxFindings),
    parts: ['reviewed'],
  })
}

/** A research in parts: its workers, then its replies read in order, as `research` says. */
async function researchInParts(ctx: RunContext, run: ProfileRun, plan: ResearchPlan, packing: Packing, sections: ReadonlyMap<string, string>): Promise<ResearchOutcome> {
  const count = packing.parts.length
  const results: PartResult[] = []
  let next = 0
  let stoppedBy: LimitName | undefined
  const work = async (): Promise<void> => {
    while (next < count) {
      const index = next++
      const result = stoppedBy === undefined
        ? await askPart(ctx, run, plan, packing, index)
        : { outcome: stoppedBy }
      results[index] = result
      if (isStopped(result)) stoppedBy ??= result.outcome
    }
  }
  await Promise.all(Array.from({
    length: Math.min(ctx.concurrency, count),
  }, work))
  const replies = results.flatMap((result, index) => result.outcome === 'reviewed'
    ? [
        { text: result.text, label: `part ${index + 1}` },
      ]
    : [])
  const read = checkReplies(replies, sections, run.id, ctx.maxFindings)
  return reported(ctx, run, {
    ...read,
    incomplete: [
      ...partGaps(run.id, results),
      ...read.incomplete,
    ],
    parts: results.map(result => result.outcome),
  })
}

/** What a part that holds nothing but white space is read as, since no model is asked about it: a reply with no finding. */
const NO_FINDINGS: PartResult = { outcome: 'reviewed', text: '{"findings":[]}' }

/** One part of a research in parts, asked as a request of its own, unless its text is blank. */
function askPart(ctx: RunContext, run: ProfileRun, plan: ResearchPlan, packing: Packing, index: number): Promise<PartResult> {
  const text = partText(plan.sections, packing, packing.parts[index])
  if (isBlank(text)) return Promise.resolve(NO_FINDINGS)
  const { files, unlisted } = plan.listed ?? { files: [], unlisted: 0 }
  return askResearch(ctx, run, () => researchRequest(run.research.instructions, text, run.guidelines, {
    index: index + 1,
    count: packing.parts.length,
    files,
    unlisted,
  }))
}

/** The gaps of the parts that were not read, one per reason and profile counting its parts: the refused requests, then the failed parts, each naming the first one's words. */
function partGaps(profile: string, results: readonly PartResult[]): IncompleteEntry[] {
  const spoken = results.filter(result => isSpoken(result))
  const gaps: IncompleteEntry[] = []
  const refused = spoken.filter(result => result.outcome === 'request-too-large')
  if (refused.length > 0) {
    gaps.push({ profile, reason: 'request-too-large', detail: `${refused.length} of ${results.length} research requests were not sent: ${refused[0].words}` })
  }
  const failed = spoken.filter(result => result.outcome === 'research-failed')
  if (failed.length > 0) {
    gaps.push({ profile, reason: 'research-failed', detail: `${failed.length} of ${results.length} research parts failed: ${failed[0].words}` })
  }
  return gaps
}

/** Sends the events of a finished research, the `finding:invalid` ones then the `incomplete` ones, and returns its outcome. */
function reported(ctx: RunContext, run: ProfileRun, outcome: ResearchOutcome): ResearchOutcome {
  for (const reason of outcome.invalid) ctx.emit({ type: 'finding:invalid', profile: run.id, reason })
  for (const entry of outcome.incomplete) ctx.emit({ type: 'incomplete', entry })
  return outcome
}

/** A profile that reviews nothing: the one gap it records, reported by an `incomplete` event. */
function gap(ctx: RunContext, entry: IncompleteEntry, outcome: PartOutcome): ResearchOutcome {
  ctx.emit({ type: 'incomplete', entry })
  return {
    findings: [],
    invalid: [],
    incomplete: [entry],
    parts: [outcome],
  }
}

/**
 * What a failed research call says in a gap, in words the code writes: `the research call failed`,
 * then ` (<kind>)` when `providerFailure` reads a kind of `ProviderError` in the failure, with ` <status>`
 * after an `http` kind when it reads an HTTP status too, then ` after <n> attempts` when the call made
 * more than one. The provider's message, which can quote a server, is never read: a gating review
 * rejects with it, and a gap carries nothing a server or a model wrote.
 */
function researchFailed(error: unknown, attempts: number): string {
  const failure = providerFailure(error)
  const words = ['the research call failed']
  if (failure !== undefined) {
    words.push(failure.status === undefined
      ? `(${failure.kind})`
      : `(${failure.kind} ${failure.status})`)
  }
  if (attempts > 1) words.push(`after ${attempts} attempts`)
  return words.join(' ')
}
