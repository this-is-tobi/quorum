import { createHash } from 'node:crypto'
import { DEFAULT_MAX_FINDINGS } from '../budgets.ts'
import type { DiffSection } from '../diff.ts'
import { OutputError, ProviderDownError } from '../errors.ts'
import { isLimit } from '../limits.ts'
import type { LimitName } from '../limits.ts'
import { parseResearchReply } from '../output.ts'
import { listedFiles, packParts, partText } from '../parts.ts'
import type { Packing, PartOutcome } from '../parts.ts'
import type { CompletionRequest } from '../ports.ts'
import { researchRequest } from '../prompts.ts'
import type { Ask } from '../prompts.ts'
import { tokenBound } from '../tokens.ts'
import type { Finding, FindingDetails, IncompleteEntry } from '../types.ts'
import { collapse, verifyFindings } from '../verify.ts'
import type { VerifiedFinding } from '../verify.ts'
import { callProvider, isTooLarge, providerFailure, refusalMessage, roomOf } from './context.ts'
import type { ProfileRun, RunContext } from './context.ts'
import { dedupKey } from './dedup.ts'

export { DEFAULT_MAX_FINDINGS }

export interface ResearchOutcome {
  findings: Finding[]
  /**
   * One reason per finding, among the ones read, that the check against the diff dropped (it cites
   * code outside the diff, or names no file). An unreadable finding is reported in `incomplete` only.
   */
  invalid: string[]
  /** What the run could not review: findings the harness could not read, findings beyond the cap, a reply whose findings were all unusable, research requests refused as too large, research that failed, or research a provider that was down never got. */
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

/** What a fingerprint looks like: 16 hexadecimal characters, a colon and a rank from 1. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{16}:[1-9]\d*$/

/**
 * The hash a finding's fingerprint starts with, which names it across pushes: the first 16 hex characters
 * of SHA-256 over the JSON array `[profile, file, category, code]`. The category is folded, in Unicode's
 * composed form (NFC), so a model's `café` is one whatever way it composes the `é`, in lower case
 * with each run of characters that are neither letters nor digits written `-` and none left at either end,
 * so a model's `SQL Injection!` and its `sql-injection` are one. `row` is the cited row of the evidence
 * with its leading +, - or space marker, or empty when no row shows the line, and `code` is that row
 * without its marker and with each run of white space one space and both ends trimmed, the rule a quote is
 * matched by, so re-indenting a block keeps its findings' names. The line number is left out on purpose: a
 * push that adds lines above the code moves it and must not rename its finding, while the cited row's code
 * moves with it. The category stays in, so two findings on one line keep their own comment and alert.
 */
export function findingFingerprint(profile: string, file: string, category: string, row: string): string {
  const folded = category.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
  return createHash('sha256').update(JSON.stringify([
    profile,
    file,
    folded,
    collapse(row.slice(1)),
  ])).digest('hex').slice(0, 16)
}

/**
 * The fingerprint of `finding`: its hash and its rank, from 1, among the distinct findings of the profile
 * that share the hash, in the order `ranks` has seen them. A repeat of a finding's file, line and category,
 * which `dedup` drops, takes that finding's rank, so the findings dedup keeps are ranked 1, 2, ....
 */
function rankedFingerprint(ranks: Map<string, Map<string, number>>, profile: string, finding: VerifiedFinding): string {
  const row = finding.evidenceRow === undefined
    ? ''
    : finding.evidence.split('\n')[finding.evidenceRow]
  const hash = findingFingerprint(profile, finding.file, finding.category, row)
  const known = ranks.get(hash) ?? new Map<string, number>()
  ranks.set(hash, known)
  const key = dedupKey(finding)
  const rank = known.get(key) ?? known.size + 1
  known.set(key, rank)
  return `${hash}:${rank}`
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
 * Every room is asked of a request that asks for `settings.maxFindings` findings, the widest its line can be, and
 * carries `settings.replyTokens`, so a request packed for fits whatever fewer findings it then asks.
 * Otherwise it is the packing of the sections into parts of at most `partTokens` that fit that room (see
 * `packParts`), with the change's files its requests name: at most 100, and at most a quarter of the
 * lesser of `partTokens` and the one request's room, so the list stays small beside the diff of a part. When that
 * packing sets a unit aside and the list names a file, the sections are packed again at the room of a parts
 * block that lists no name (`and <n> more` alone), asked at the same widest position, because the list
 * may be what left the unit out: the second packing and its block are kept when it sets fewer units aside,
 * else the first, and the rule above (5) applies to the packing kept.
 */
export function planResearch(run: ProfileRun, diff: string, sections: readonly DiffSection[], settings: { readonly partTokens: number, readonly maxFindings: number, readonly replyTokens?: number }): ResearchPlan {
  const whole: ResearchPlan = { sections }
  if (run.research.room === undefined) return whole
  const { instructions } = run.research
  const { partTokens } = settings
  const ask: Ask = { findings: settings.maxFindings, replyTokens: settings.replyTokens }
  const one = roomOf(run.research, researchRequest(instructions, '', run.guidelines, undefined, ask))
  if (one === undefined || one < 0) return whole
  const tokens = tokenBound(diff)
  if (tokens <= Math.min(partTokens, one)) return whole
  const widest = lineCount(diff)
  const roomWith = (names: ListedFiles): number | undefined => roomOf(run.research, researchRequest(instructions, '', run.guidelines, { index: widest, count: widest, ...names }, ask))
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
 * finding it keeps is named by `findingId` and `findingFingerprint` and tagged with `profile`, and every
 * incomplete entry it records is tagged with `profile` too.
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
  const ranks = new Map<string, Map<string, number>>()
  const findings = checked.findings.map((finding): Finding => ({
    id: findingId(profile, finding.file, finding.line, finding.category),
    fingerprint: rankedFingerprint(ranks, profile, finding),
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
 * sent: the profile reviews nothing, records one `request-too-large` gap, and the other profiles run. Any
 * other failed research, the call after its retries or a reply that is not a valid envelope, is the
 * profile's own `research-failed` gap, in words the code writes, gating or not: nothing aborts the review
 * for it, and the other profiles run. A request a provider found down was never sent is a `provider-down`
 * gap (see `createHealth`). A research request a limit stopped (the token cap refused it
 * or left no room for it, or the review's deadline ended it) is no failure of either kind: the outcome holds
 * no finding and names the limit in `parts`, which the review turns into the profile's one gap for that
 * limit, a gating profile's included. A packing of none, where no part holds any of the diff, makes no call, and
 * neither does a part whose text is blank (white space only, as the text before a diff's first header can be,
 * when every other unit was set aside): there is nothing to ask a model, so its outcome is `reviewed`.
 *
 * A packing of several parts runs `ctx.concurrency` workers of this profile, each taking the next part, in
 * order, while one is left, and a call of each through the review's one limit, so the review's concurrency
 * holds across profiles. Each part fails as a one-request research does, and a reply's envelope is checked
 * as it arrives: a failed call or an unreadable envelope is that part's `research-failed`, while the profile's
 * other parts go on, and the replies that were read are kept. Once a part ends with a limit, the profile's parts
 * not yet taken are stopped by the same limit without a call: each would be built and counted only to be
 * refused, and the gap counts them, failing closed. Once every part has answered, the replies are read in
 * the parts' order, up to `maxFindings` findings in all, each checked against the whole diff, and a finding
 * two parts report is dropped by the dedup stage. The gaps come in this order, each counting parts: the
 * requests refused as too large, then the parts that failed, then the parts a provider that was down never
 * got, then the reading's. The events follow: the `finding:invalid` ones, then the `incomplete` ones.
 *
 * A review that is aborted rejects with its reason, never with a gap.
 *
 * @throws whatever the parser throws for a reply that is no `OutputError`: a bug, not a reply
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
    | { readonly outcome: 'request-too-large' | 'research-failed' | 'provider-down', readonly words: string }
    | { readonly outcome: LimitName }

type SpokenResult = Extract<PartResult, { readonly words: string }>

const isSpoken = (result: PartResult): result is SpokenResult => 'words' in result

const isStopped = (result: PartResult): result is Extract<PartResult, { readonly outcome: LimitName }> => result.outcome === 'token-cap' || result.outcome === 'review-deadline'

/**
 * One research request, sent and its reply's envelope checked, and what became of it: the one place where a
 * failure is told from a gap, for a research of one request and for each part of a research in parts alike,
 * a gating profile's included. In this order:
 * - a limit that stopped the call is the limit's name;
 * - a refusal as too large is `request-too-large` with the refusal's message;
 * - a call the provider-down rule refused (a `ProviderDownError`) is `provider-down`;
 * - any other failure of the call is `research-failed` with the words `researchFailed` writes;
 * - a reply that is no findings envelope (an `OutputError`) is `research-failed` with the reason; any other
 *   error the parser throws rethrows, a bug and not a reply;
 * - else `reviewed`, with the reply's text.
 * Each failure is told only after the review's abort check, so a review that is aborted rejects with its
 * reason, never with a gap.
 */
async function askResearch(ctx: RunContext, run: ProfileRun, request: (ask: Ask) => CompletionRequest): Promise<PartResult> {
  let attempts = 1
  let text: string
  try {
    text = await callProvider(ctx, { profile: run.id, role: 'research' }, run.research, () => request(askOf(ctx, run)), (_error, made) => {
      attempts = made
    })
  } catch (error) {
    ctx.signal.throwIfAborted()
    if (isLimit(error)) return { outcome: error.limit }
    if (isTooLarge(error)) {
      return {
        outcome: 'request-too-large',
        words: refusalMessage(error),
      }
    }
    if (error instanceof ProviderDownError) {
      return {
        outcome: 'provider-down',
        words: 'the research request was not sent, since its provider was down',
      }
    }
    return {
      outcome: 'research-failed',
      words: researchFailed(error, attempts),
    }
  }
  try {
    parseResearchReply(text, 1)
  } catch (error) {
    if (!(error instanceof OutputError)) throw error
    ctx.signal.throwIfAborted()
    return { outcome: 'research-failed', words: `the research reply could not be read: ${error.reason}` }
  }
  return { outcome: 'reviewed', text }
}

/** What a research request of `run` asks: the findings its budget holds and the reply budget it carries, from the review's budgets. */
function askOf(ctx: RunContext, run: ProfileRun): Ask {
  const { findings, replyTokens } = ctx.budgets[run.id].research
  return { findings, replyTokens }
}

/** One research request holding `diff`, its outcome's `parts` the one part's, and its failure told as a gap in today's words. */
async function researchInOne(ctx: RunContext, run: ProfileRun, diff: string, sections: ReadonlyMap<string, string>): Promise<ResearchOutcome> {
  const result = await askResearch(ctx, run, ask => researchRequest(run.research.instructions, diff, run.guidelines, undefined, ask))
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
  return askResearch(ctx, run, ask => researchRequest(run.research.instructions, text, run.guidelines, {
    index: index + 1,
    count: packing.parts.length,
    files,
    unlisted,
  }, ask))
}

/** The gaps of the parts that were not read, one per reason and profile counting its parts: the refused requests, then the failed parts, each naming the first one's words, then the parts a provider that was down never got. */
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
  const down = spoken.filter(result => result.outcome === 'provider-down')
  if (down.length > 0) {
    gaps.push({ profile, reason: 'provider-down', detail: `${down.length} of ${results.length} research parts were not sent, since their provider was down` })
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
 * more than one. The provider's message, which can quote a server, is never read: a gap carries nothing a
 * server or a model wrote.
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
