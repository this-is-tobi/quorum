import { createHash } from 'node:crypto'
import { DEFAULT_MAX_FINDINGS, factsOf, replyBudget } from '../budgets.ts'
import type { DiffSection } from '../diff.ts'
import { cutOf, OutputError, ProviderDownError } from '../errors.ts'
import { isLimit, isLimitName } from '../limits.ts'
import type { LimitName } from '../limits.ts'
import { parseResearchReply } from '../output.ts'
import { cutSection, listedFiles, packParts, partText } from '../parts.ts'
import type { Cut, Packing, PartOutcome, PartResult, Slice } from '../parts.ts'
import type { CompletionRequest } from '../ports.ts'
import { researchRequest } from '../prompts.ts'
import type { Ask } from '../prompts.ts'
import { halves, unitsOf } from '../recovery.ts'
import type { Piece } from '../recovery.ts'
import { replyLimit, tokenBound } from '../tokens.ts'
import type { CallFailure, Finding, FindingDetails, IncompleteEntry, Position, ProfileMeta, QuorumEvent } from '../types.ts'
import { collapse, verifyFindings } from '../verify.ts'
import type { VerifiedFinding } from '../verify.ts'
import { isTooLarge, lackOf, ownData, providerFailure, refusalMessage } from '../facts.ts'
import { callProvider, roomOf } from './context.ts'
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
   * envelope, the limit's name when the token cap, the deadline or the interrupt stopped it (its gap is written once the
   * profile's panel has run, with the votes the limit stopped), else why it was not read; for a part recovery split,
   * what became of each of its pieces. One entry for a research of one request, none when no part holds any of the
   * diff.
   */
  parts: PartResult[]
  /**
   * The packing the coverage reads, when recovery changed it: the plan's with the cuts recovery made between the hunks
   * of sections the packing held whole, or, for a research of one request that recovery split, one part holding every
   * section. Absent when recovery split nothing: the plan's packing, or none, is read.
   */
  packing?: Packing
  /** What recovery did, when it split a part: what `meta.profiles.<id>.recovery` holds. */
  recovery?: ProfileMeta['recovery']
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

/** A research reply to read: its text, the label its unreadable findings are reported under, and the findings its request asked for at most. */
interface Reply {
  readonly text: string
  readonly label?: string
  readonly asked?: number
}

/** What reading research replies comes to: what the panel receives, and the gaps of the reading. */
type Reading = Omit<ResearchOutcome, 'parts' | 'packing' | 'recovery'>

/**
 * Turn one research reply into what the panel receives: `checkReplies` of that reply alone, unlabelled, so
 * its gaps and its errors are the ones `checkReplies` states.
 *
 * @throws OutputError when the reply is not one JSON object holding a `findings` array and nothing else
 * @throws RangeError when `maxFindings` is not a positive integer
 */
export function checkReply(text: string, sections: ReadonlyMap<string, string>, profile: string, maxFindings = DEFAULT_MAX_FINDINGS): Reading {
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
 * A reply that lists at least the `asked` findings its request asked for at most is saturated: it may have stopped
 * at the ask, so the profile records one `findings-capped` gap that counts such replies and names the largest ask
 * (`<k> research reply(ies) listed the <n> findings they were asked for at most, so they may have left some out`).
 * Where the replies list more than `maxFindings` too, the same gap goes on with the cap's count after a colon, so a
 * profile never has two of one reason. A saturated reply below `maxFindings` is split and never gets here, unless
 * its piece is at the floor.
 *
 * @throws OutputError when a reply is not one JSON object holding a `findings` array and nothing else
 * @throws RangeError when `maxFindings` is not a positive integer
 */
export function checkReplies(replies: ReadonlyArray<Reply>, sections: ReadonlyMap<string, string>, profile: string, maxFindings = DEFAULT_MAX_FINDINGS): Reading {
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    throw new RangeError(`maxFindings must be a positive integer, got ${maxFindings}`)
  }
  const details: FindingDetails[] = []
  const unreadable: string[] = []
  let listed = 0
  const saturated: number[] = []
  for (const { text, label, asked } of replies) {
    // A reply past the cap is parsed for its envelope and its count alone: its entries are not read.
    const left = maxFindings - details.length - unreadable.length
    const parsed = parseResearchReply(text, Math.max(left, 1))
    listed += parsed.listed
    if (asked !== undefined && parsed.listed >= asked) saturated.push(asked)
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
  const asks = saturated.length === 0
    ? undefined
    : `${saturated.length} research reply(ies) listed the ${Math.max(...saturated)} findings they were asked for at most, so they may have left some out`
  const cap = listed > maxFindings
    ? `${listed - maxFindings} of ${listed} reported findings were not reviewed (the cap is ${maxFindings})`
    : undefined
  const capped = [asks, cap].filter(words => words !== undefined).join(': ')
  if (capped !== '') incomplete.push({ profile, reason: 'findings-capped', detail: capped })
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
 * A change in one request (no packing, or a packing of one part, whatever its text) goes through one call, or none for
 * a part of white space alone, which is `reviewed` all the same. A research request its provider refused as too large (a `too-large` `ProviderError`) was not
 * sent: the profile reviews nothing, records one `request-too-large` gap, and the other profiles run. Any
 * other failed research, the call after its retries or a reply that is not a valid envelope, is the
 * profile's own `research-failed` gap, in words the code writes, gating or not: nothing aborts the review
 * for it, and the other profiles run. A request a provider found down was never sent is a `provider-down`
 * gap (see `createHealth`). A research request a limit stopped (the token cap refused it
 * or left no room for it, or the review's deadline or interrupt ended it) is no failure of either kind: the outcome holds
 * no finding and names the limit in `parts`, which the review turns into the profile's one gap for that
 * limit, a gating profile's included. A packing of none, where no part holds any of the diff, makes no call, and
 * neither does a part whose text is blank (white space only, as the text before a diff's first header can be,
 * when every other unit was set aside): there is nothing to ask a model, so its outcome is `reviewed`.
 *
 * A packing of several parts runs `ctx.concurrency` workers of this profile, each taking the next part, largest
 * first (`dispatchOrder`: ties in the plan's order), while one is left, and a call of each through the review's
 * one limit, so the review's concurrency holds across profiles. Each part fails as a one-request research does, and a reply's envelope is checked
 * as it arrives: a failed call or an unreadable envelope is that part's `research-failed`, while the profile's
 * other parts go on, and the replies that were read are kept. Once a part ends with a limit, the profile's parts
 * not yet taken, and the pieces of the part not yet asked, are stopped by the same limit without a call: each
 * would be built and counted only to be refused, and the gap counts them, failing closed. Once every part has
 * answered, the replies are read in the parts' order, up to `maxFindings` findings in all, each checked against
 * the whole diff, and a finding two parts report is dropped by the dedup stage. Only the sending is reordered:
 * a part keeps its position, and the replies are read in the plan's order. The gaps come in this order, each
 * counting parts: the requests refused as too large, then the parts that failed, then the parts a provider
 * that was down never got, then the hunks cut off even alone, then the reading's. The events follow: the
 * `finding:invalid` ones, then the `incomplete` ones.
 *
 * A part whose reply was cut off at its limit, or saturated, is recovered in its worker, by code, in this
 * order. The thinking step is the call path's (`callProvider`): by the time this stage sees a cut-off, the
 * adaptation has had its one try, was refused or does not apply. Then the part is split in two (see `halves`):
 * the first half is asked as a part is, and recovered by the same rules if its reply is cut off or saturated, to the
 * floor (three splits deep, or one hunk); then the second, so the pieces run depth first in the diff's order, one
 * at a time, and a recovered part never takes more of the concurrency than its own slot. A piece's request is its
 * part's, with the piece's text and a position line that names the piece (a research of one request, split, gains a
 * parts block of the position line alone). No text of a cut reply reaches a piece, and no finding of one is read,
 * its closed ones included: the pieces' replies stand in its place, read in the diff's order. A piece cut off
 * at the floor is lost, its hunks a `reply-cut-off` gap and range in the coverage; a saturated reply at the
 * floor, or at `maxFindings`, is read and counted for the profile's one `findings-capped` gap. A part makes at
 * most 1 + 2 + 4 + 8 = 15 calls. Each part recovered is one `recovered` event, once its pieces have answered.
 *
 * A review that is aborted rejects with its reason, never with a gap.
 *
 * @throws whatever the parser throws for a reply that is no `OutputError`: a bug, not a reply
 */
export async function research(ctx: RunContext, run: ProfileRun, plan: ResearchPlan, diff: string, sections: ReadonlyMap<string, string>): Promise<ResearchOutcome> {
  const { packing } = plan
  if (packing === undefined) return researchInOne(ctx, run, plan, diff, sections)
  if (packing.parts.length === 0) return nothingRead([])
  if (packing.parts.length === 1) return researchInOne(ctx, run, plan, partText(plan.sections, packing, packing.parts[0]), sections)
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

/**
 * What became of one research request: its reply to read, with the findings the reply listed, the words of a failure
 * to tell, with what the failed call said of itself when it was a failed call, the limit that stopped it, or the reply
 * that recovery splits the request for.
 */
type Asked
  = | { readonly outcome: 'reviewed', readonly text: string, readonly asked: number, readonly listed: number }
    | { readonly outcome: 'request-too-large' | 'research-failed' | 'provider-down', readonly words: string, readonly failure?: CallFailure }
    | { readonly outcome: LimitName }
    | { readonly outcome: 'cut-off', readonly lacked: 'reply' | 'thinking' | 'window', readonly limit?: number, readonly cutAfterMs?: number }
    | { readonly outcome: 'saturated', readonly asked: number }

/** What became of one piece of a part, once recovery is done with it: the piece, and its request's end as `Asked` tells it, but for a cut-off at the floor. */
type Leaf = { readonly piece: Piece } & (
  | { readonly outcome: 'reviewed', readonly text: string, readonly asked?: number, readonly listed?: number }
  | { readonly outcome: 'request-too-large' | 'research-failed' | 'provider-down', readonly words: string, readonly failure?: CallFailure }
  | { readonly outcome: LimitName | 'reply-cut-off' }
)

type SpokenLeaf = Extract<Leaf, { readonly words: string }>

const isSpoken = (leaf: Leaf): leaf is SpokenLeaf => 'words' in leaf

/** What a part that holds nothing but white space is read as, since no model is asked about it: a reply with no finding. */
const NO_FINDINGS_TEXT = '{"findings":[]}'

/** What the calls of one part came to, as each tells its end: the tokens they spent, the clock's reading when the first one's request was built, how many calls built one and how many of them the store answered. */
interface Spend {
  spent: number
  calls: number
  reused: number
  startedAt?: number
}

/**
 * One research request, sent and its reply's envelope checked, and what became of it: the one place where a
 * failure is told from a gap, for a research of one request, each part of a research in parts and each piece of
 * a recovered one alike, a gating profile's included. In this order:
 * - a limit that stopped the call is the limit's name;
 * - a refusal as too large is `request-too-large` with the refusal's message (the stage splits a piece so refused, never a part);
 * - a call the provider-down rule refused (a `ProviderDownError`) is `provider-down`;
 * - a reply cut off at its limit (a `truncated` failure, which the call path's adaptation has already had its try at)
 *   is a cut-off, with what it lacked and the limit it was sent with, or for a reply cut on the way at a length its provider
 *   learned (`cutAfterMs`), that length in its place: the stage splits the request, or loses it at the floor;
 * - any other failure of the call is `research-failed` with the words `researchFailed` writes;
 * - a reply that is no findings envelope (an `OutputError` of the check) is `research-failed` with the reason; any other
 *   error the parser throws rethrows, a bug and not a reply;
 * - a reply that lists at least the findings it was asked for at most, when `splittable` and below `maxFindings`, is saturated
 *   and is not returned: the stage splits the request;
 * - else `reviewed`, with the reply's text, the findings it was asked for at most and the findings it listed.
 * A call that built its request adds what it spent to `spend`, and its start when `spend` has none. A `research-failed`
 * call that failed carries what the failure said of itself, as `providerFailure` reads it, and `cutAfterMs` when its last
 * attempt was cut on the way (`cutOf`).
 * Each failure is told only after the review's abort check, so a review that is aborted rejects with its
 * reason, never with a gap.
 */
async function askResearch(ctx: RunContext, run: ProfileRun, where: Position, spend: Spend, request: (ask: Ask) => CompletionRequest, splittable: boolean): Promise<Asked> {
  const state: { attempts: number, ran?: number, findings: number, listed: number, limit?: number, parsed?: unknown } = { attempts: 1, findings: 0, listed: 0 }
  try {
    const answered = await callProvider(ctx, { profile: run.id, role: 'research', part: where }, run.research, () => {
      const ask = askOf(ctx, run)
      const built = request(ask)
      state.findings = ask.findings
      state.limit = replyLimit(built, run.research.maxTokens)
      return built
    }, {
      check: (text) => {
        let listed: number
        try {
          listed = parseResearchReply(text, 1).listed
        } catch (error) {
          state.parsed = error
          throw error
        }
        state.listed = listed
        return { saturated: splittable && state.findings < ctx.maxFindings && listed >= state.findings, listed }
      },
      onFailure: (_error, made, ran) => {
        state.attempts = made
        state.ran = ran
      },
      onEnd: ({ spent, startedAt, reused }) => {
        spend.spent += spent
        spend.calls += 1
        if (reused) spend.reused += 1
        spend.startedAt ??= startedAt
      },
    })
    return 'saturated' in answered
      ? { outcome: 'saturated', asked: state.findings }
      : {
          outcome: 'reviewed',
          text: answered.text,
          asked: state.findings,
          listed: state.listed,
        }
  } catch (error) {
    ctx.signal.throwIfAborted()
    if (state.parsed !== undefined && error === state.parsed) {
      if (!(error instanceof OutputError)) throw error
      return { outcome: 'research-failed', words: `the research reply could not be read: ${error.reason}` }
    }
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
    if (ownData(error, 'kind') === 'truncated') {
      const lack = lackOf(error)?.noAnswer
      const cutAfterMs = ownData(error, 'cutAfterMs')
      return {
        outcome: 'cut-off',
        lacked: lack === 'thinking' || lack === 'window'
          ? lack
          : 'reply',
        ...typeof cutAfterMs === 'number' && Number.isSafeInteger(cutAfterMs) && cutAfterMs >= 1
          ? { cutAfterMs }
          : state.limit === undefined
            ? {}
            : { limit: state.limit },
      }
    }
    const failure = providerFailure(error)
    const cut = failure === undefined
      ? undefined
      : cutOf(failure, state.ran)
    return {
      outcome: 'research-failed',
      words: researchFailed(error, state.attempts),
      ...failure === undefined
        ? {}
        : {
            failure: cut === undefined
              ? failure
              : { ...failure, cutAfterMs: cut },
          },
    }
  }
}

/**
 * What a research request of `run` asks: the findings its budget holds, which are more once a reply of its provider
 * showed that the model does not reason (`ctx.adapt.findings`), and the reply budget it carries, from the review's budgets, held to
 * what a cut on the way lets through once its provider learned one (`ctx.clocks.ceiling`).
 */
function askOf(ctx: RunContext, run: ProfileRun): Ask & { readonly findings: number } {
  const stated = ctx.budgets[run.id].research
  const ceiling = ctx.clocks.ceiling(run.research)
  if (ceiling === undefined) {
    return {
      findings: ctx.adapt.findings(run.research, stated),
      replyTokens: stated.replyTokens,
    }
  }
  // A provider whose calls are cut on the way, at a length it learned, has a derived budget held to what the cut lets through.
  const lowered = replyBudget({
    ...factsOf(run.research),
    ceiling,
  }, stated.window, ctx.maxFindings)
  return {
    findings: ctx.adapt.findings(run.research, lowered),
    replyTokens: lowered.research,
  }
}

/** What a research's workers share as recovery goes: the diff's sections, the cuts between hunks (the packer's, then recovery's), and the limit that stopped the profile's work, once one has. */
interface Scope {
  readonly sections: readonly DiffSection[]
  readonly cuts: Map<number, Cut>
  readonly stop: { by?: LimitName }
}

/** Why a part was recovered, as the first reply that was split lacked it, for its `recovered` event. */
interface Recovered {
  readonly noAnswer: Extract<QuorumEvent, { type: 'recovered' }>['noAnswer']
  readonly limit?: number
  /** The length a reply was cut on the way at, in place of a limit. */
  readonly cutAfterMs?: number
  readonly findings?: number
  readonly thinkingLowered: boolean
  /** The replies of the part that were saturated and split. */
  saturated: number
}

/** What became of one part: its pieces' ends, in the diff's order (one for a part that was not split), the result the coverage reads, and why it was recovered, when it was. */
interface PartRun {
  readonly leaves: readonly Leaf[]
  readonly result: PartResult
  readonly recovered?: Recovered
}

/** The position of a piece in its request: its index among the `2^depth` pieces of its depth. */
const positionOf = (piece: Piece): { readonly index: number, readonly count: number } => ({ index: piece.index, count: 2 ** piece.depth })

/** The position a research call of `piece` of part `part` of `parts` names: the part's, and the piece's when recovery split the part. */
function callPosition(part: number, parts: number, piece: Piece): Position {
  return {
    index: part,
    count: parts,
    ...piece.depth === 0
      ? {}
      : {
          piece: positionOf(piece),
        },
  }
}

/**
 * One part, asked and, if its reply is cut off or saturated, recovered in the part's own worker: the piece is split
 * in two (`halves`) and each half asked as a piece in turn, depth first in the diff's order, to the floor; a limit that
 * stopped the profile's work ends every piece not yet asked without a call. A piece (never the part, which the planner sized)
 * that its provider refuses as too large is split the same way when it can be, and is a `request-too-large` leaf at the floor.
 * Each node of the tree makes at most one request, so a part still makes at most 15. `rootText` is the part's text when the
 * caller has it. A part that was split is one `recovered` event, sent once its pieces have answered. Every part ends
 * with one `part` event, sent after its `recovered` event: its outcome, its duration from its first call's start on the
 * review's clock (0 when it made none), the tokens its calls spent, the findings its read replies listed, the first
 * failure of a call that failed, and, for a part that was split, how many pieces were read and how many were not.
 */
async function researchPart(ctx: RunContext, run: ProfileRun, scope: Scope, root: Piece, rootText: string | undefined, position: { readonly part: number, readonly parts: number }, requestOf: (piece: Piece, text: string, ask: Ask) => CompletionRequest): Promise<PartRun> {
  const leaves: Leaf[] = []
  const spend: Spend = { spent: 0, calls: 0, reused: 0 }
  let recovered: Recovered | undefined
  const visit = async (piece: Piece): Promise<void> => {
    if (scope.stop.by !== undefined) {
      leaves.push({ piece, outcome: scope.stop.by })
      return
    }
    const text = piece === root && rootText !== undefined
      ? rootText
      : partText(scope.sections, scope, piece)
    if (isBlank(text)) {
      leaves.push({ piece, outcome: 'reviewed', text: NO_FINDINGS_TEXT })
      return
    }
    const split = halves(scope.sections, scope.cuts, piece)
    const asked = await askResearch(ctx, run, callPosition(position.part, position.parts, piece), spend, ask => requestOf(piece, text, ask), split !== undefined)
    // A reply that comes within the interrupt's grace, cut off or saturated, is not split on paper: no piece would be asked, so the
    // piece is stopped by the limit, with no `recovered` event and no recovery in the meta. A rerun's cut-off marker is a reply no
    // call made, which the stop does not touch: it was read before the stop and goes to recovery as it always did.
    const stopped = ctx.stop.aborted && isLimit(ctx.stop.reason)
      ? ctx.stop.reason.limit
      : undefined
    const splits = split !== undefined && (asked.outcome === 'cut-off' || asked.outcome === 'saturated' || (asked.outcome === 'request-too-large' && piece.depth > 0))
    if (stopped !== undefined && splits) {
      leaves.push({ piece, outcome: stopped })
      scope.stop.by ??= stopped
      return
    }
    // The planner sized a part's room, not a piece's, which adds a position and, for a one-request research, a parts block: a piece
    // its provider refuses as too large is split as a cut-off is, an inner node of the tree and no leaf, with its part's own `recovered`.
    if (asked.outcome === 'request-too-large' && piece.depth > 0 && split !== undefined) {
      if (split.cut !== undefined) scope.cuts.set(...split.cut)
      for (const half of split.pieces) await visit(half)
      return
    }
    if (asked.outcome === 'cut-off' || asked.outcome === 'saturated') {
      // The floor: a reply cut off even for the least a piece can hold is lost, whatever it listed, and no text of it is read.
      if (split === undefined) {
        leaves.push({ piece, outcome: 'reply-cut-off' })
        return
      }
      if (split.cut !== undefined) scope.cuts.set(...split.cut)
      recovered ??= {
        noAnswer: asked.outcome === 'saturated'
          ? 'saturated'
          : asked.lacked,
        ...asked.outcome === 'cut-off' && asked.limit !== undefined
          ? { limit: asked.limit }
          : {},
        ...asked.outcome === 'cut-off' && asked.cutAfterMs !== undefined
          ? { cutAfterMs: asked.cutAfterMs }
          : {},
        ...asked.outcome === 'saturated'
          ? { findings: asked.asked }
          : {},
        thinkingLowered: ctx.adapt.sent(run.research).thinking !== undefined,
        saturated: 0,
      }
      if (asked.outcome === 'saturated') recovered.saturated++
      for (const half of split.pieces) await visit(half)
      return
    }
    if (isLimitName(asked.outcome)) scope.stop.by ??= asked.outcome
    leaves.push({ piece, ...asked })
  }
  await visit(root)
  const result: PartResult = recovered === undefined
    ? leaves[0].outcome
    : {
        pieces: leaves.map(({ piece, outcome }) => ({ slices: piece.slices, outcome })),
      }
  if (recovered !== undefined) {
    const floor = floorOf(scope, leaves)
    ctx.emit({
      type: 'recovered',
      profile: run.id,
      part: position.part,
      parts: position.parts,
      noAnswer: recovered.noAnswer,
      ...recovered.limit === undefined
        ? {}
        : { limit: recovered.limit },
      ...recovered.cutAfterMs === undefined
        ? {}
        : { cutAfterMs: recovered.cutAfterMs },
      ...recovered.findings === undefined
        ? {}
        : { findings: recovered.findings },
      thinkingLowered: recovered.thinkingLowered,
      pieces: leaves.length,
      read: leaves.filter(leaf => leaf.outcome === 'reviewed').length,
      unreadHunks: floor.hunks,
      unreadFiles: floor.files.size,
    })
  }
  ctx.emit(partEvent(ctx, run.id, position, leaves, spend, recovered !== undefined))
  return recovered === undefined
    ? { leaves, result }
    : { leaves, result, recovered }
}

/**
 * The `part` event of a part whose leaves are known: its outcome (`reviewed` when every piece was read, else the first
 * unread piece's in the diff's order), the time from its first call's start (0 when it made none), what its calls spent,
 * the findings its read replies listed (none when no reply was read), `reused` when it made a call and the store answered
 * every one, the first failure a call that failed told, and, for a part that was split, its pieces: how many, how many were read, and how many were not, by outcome.
 */
function partEvent(ctx: RunContext, profile: string, position: { readonly part: number, readonly parts: number }, leaves: readonly Leaf[], spend: Spend, split: boolean): Extract<QuorumEvent, { type: 'part' }> {
  const counts: Partial<Record<Exclude<PartOutcome, 'reviewed'>, number>> = {}
  let first: PartOutcome | undefined
  let unread = 0
  for (const { outcome } of leaves) {
    if (outcome === 'reviewed') continue
    first ??= outcome
    unread += 1
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  const listed = leaves.flatMap(leaf => leaf.outcome === 'reviewed' && leaf.listed !== undefined
    ? [leaf.listed]
    : [])
  const failure = leaves.flatMap(leaf => leaf.outcome === 'research-failed' && leaf.failure !== undefined
    ? [leaf.failure]
    : [])[0]
  return {
    type: 'part',
    profile,
    part: { index: position.part, count: position.parts },
    outcome: first ?? 'reviewed',
    durationMs: spend.startedAt === undefined
      ? 0
      : Math.round(ctx.clock.now() - spend.startedAt),
    spent: spend.spent,
    ...spend.calls > 0 && spend.reused === spend.calls
      ? { reused: true as const }
      : {},
    ...listed.length === 0
      ? {}
      : {
          listed: listed.reduce((sum, count) => sum + count, 0),
        },
    ...failure === undefined
      ? {}
      : { failure },
    ...split
      ? {
          pieces: { count: leaves.length, read: leaves.length - unread, unread: counts },
        }
      : {},
  }
}

/** The hunks the floor left unread in `leaves`, a section with no hunk or held whole counting as it holds hunks (at least one), and the files they belong to. */
function floorOf(scope: Scope, leaves: readonly Leaf[]): { readonly hunks: number, readonly files: ReadonlySet<string> } {
  const units = leaves.filter(leaf => leaf.outcome === 'reply-cut-off').flatMap(({ piece }) => unitsOf(scope.cuts, piece))
  return {
    hunks: units.reduce((sum, { section, hunk }) => sum + (hunk === undefined
      ? Math.max(1, cutSection(scope.sections[section].text).hunks.length)
      : 1), 0),
    files: new Set(units.map(({ section }) => scope.sections[section].path ?? '')),
  }
}

/**
 * One research request holding `text`, the whole of the change or the one part its packing has, and its end told as
 * a gap in today's words when it is not read; a request recovery splits is a research in pieces, concluded as parts are.
 * Its outcome's `parts` hold the one part's.
 */
async function researchInOne(ctx: RunContext, run: ProfileRun, plan: ResearchPlan, text: string, sections: ReadonlyMap<string, string>): Promise<ResearchOutcome> {
  const { packing } = plan
  const root: Piece = { slices: packing?.parts[0].slices ?? plan.sections.map((_, section): Slice => ({ section })), depth: 0, index: 1 }
  const scope: Scope = {
    sections: plan.sections,
    cuts: new Map(packing?.cuts),
    stop: {},
  }
  const part = await researchPart(ctx, run, scope, root, text, { part: 1, parts: 1 }, (piece, diff, ask) => researchRequest(run.research.instructions, diff, run.guidelines, piece.depth === 0
    ? undefined
    : {
        piece: positionOf(piece),
        files: [],
        unlisted: 0,
      }, ask))
  if (part.recovered !== undefined) {
    return concluded(ctx, run, scope, {
      parts: packing?.parts ?? [
        {
          slices: root.slices,
          tokens: tokenBound(text),
        },
      ],
      tooLarge: packing?.tooLarge ?? [],
      cuts: scope.cuts,
    }, sections, [part], false)
  }
  const [leaf] = part.leaves
  if (isSpoken(leaf)) {
    return gap(ctx, {
      profile: run.id,
      reason: leaf.outcome,
      detail: leaf.outcome === 'request-too-large'
        ? `the research request was not sent: ${leaf.words}`
        : leaf.words,
    }, leaf.outcome)
  }
  if (leaf.outcome === 'reply-cut-off') return gap(ctx, cutOffGap(run.id, scope, [leaf])!, leaf.outcome)
  if (leaf.outcome !== 'reviewed') return nothingRead([leaf.outcome])
  return reported(ctx, run, {
    ...checkReplies([
      { text: leaf.text, asked: leaf.asked },
    ], sections, run.id, ctx.maxFindings),
    parts: ['reviewed'],
  })
}

/**
 * The indexes of a packing's parts in the order they are sent: the most planned tokens first, ties in the plan's
 * order. A review of uneven parts waits at its end on the last part sent, so the large parts go first and the
 * last to answer are small. Only the sending moves: a part keeps its position, and the replies are read in the plan's order.
 */
export function dispatchOrder(packing: Packing): number[] {
  return packing.parts
    .map((_, index) => index)
    .toSorted((a, b) => packing.parts[b].tokens - packing.parts[a].tokens || a - b)
}

/** A research in parts: its workers, then its replies read in order, as `research` says. */
async function researchInParts(ctx: RunContext, run: ProfileRun, plan: ResearchPlan, packing: Packing, sections: ReadonlyMap<string, string>): Promise<ResearchOutcome> {
  const count = packing.parts.length
  const scope: Scope = {
    sections: plan.sections,
    cuts: new Map(packing.cuts),
    stop: {},
  }
  const { files, unlisted } = plan.listed ?? { files: [], unlisted: 0 }
  const runs: PartRun[] = []
  const order = dispatchOrder(packing)
  let next = 0
  const work = async (): Promise<void> => {
    while (next < count) {
      const index = order[next++]
      runs[index] = await researchPart(ctx, run, scope, { slices: packing.parts[index].slices, depth: 0, index: 1 }, undefined, { part: index + 1, parts: count }, (piece, text, ask) => researchRequest(run.research.instructions, text, run.guidelines, {
        index: index + 1,
        count,
        ...piece.depth === 0
          ? {}
          : {
              piece: positionOf(piece),
            },
        files,
        unlisted,
      }, ask))
    }
  }
  await Promise.all(Array.from({
    length: Math.min(ctx.concurrency, count),
  }, work))
  return concluded(ctx, run, scope, packing, sections, runs, true)
}

/**
 * The end of a research of parts, or of one request that recovery split: the replies of every piece that was read, in
 * the diff's order, up to `maxFindings` findings in all, the gaps of the pieces that were not, and the packing and
 * counts the coverage and the meta read once a part was recovered.
 */
function concluded(ctx: RunContext, run: ProfileRun, scope: Scope, packing: Packing, sections: ReadonlyMap<string, string>, runs: readonly PartRun[], inParts: boolean): ResearchOutcome {
  const split = runs.filter(({ recovered }) => recovered !== undefined)
  const replies = runs.flatMap(({ leaves, recovered }, index) => leaves.flatMap(leaf => leaf.outcome === 'reviewed'
    ? [
        {
          text: leaf.text,
          asked: leaf.asked,
          label: labelOf(inParts
            ? index
            : undefined, recovered !== undefined, leaf.piece),
        },
      ]
    : []))
  const read = checkReplies(replies, sections, run.id, ctx.maxFindings)
  const cutOff = cutOffGap(run.id, scope, runs.flatMap(({ leaves }) => leaves))
  return reported(ctx, run, {
    ...read,
    incomplete: [
      ...partGaps(run.id, runs),
      ...cutOff === undefined
        ? []
        : [cutOff],
      ...read.incomplete,
    ],
    parts: runs.map(({ result }) => result),
    ...split.length === 0
      ? {}
      : {
          packing: { ...packing, cuts: scope.cuts },
          recovery: {
            parts: split.length,
            pieces: split.reduce((sum, { leaves }) => sum + leaves.length, 0),
            saturated: split.reduce((sum, { recovered }) => sum + (recovered?.saturated ?? 0), 0),
            unreadHunks: floorOf(scope, split.flatMap(({ leaves }) => leaves)).hunks,
          },
        },
  })
}

/** What a reply is called where it is reported unreadable: its part, then its piece when recovery split the part; a one-request research has no part. */
function labelOf(part: number | undefined, split: boolean, piece: Piece): string | undefined {
  const named = part === undefined
    ? undefined
    : `part ${part + 1}`
  if (!split) return named
  const where = `piece ${piece.index} of ${2 ** piece.depth}`
  return named === undefined
    ? where
    : `${named}, ${where}`
}

/** The gaps of the parts that were not read, one per reason and profile counting its parts (a part with several pieces that failed counts once): the refused requests, then the failed parts, each naming the first one's words, then the parts a provider that was down never got. */
function partGaps(profile: string, runs: readonly PartRun[]): IncompleteEntry[] {
  const gaps: IncompleteEntry[] = []
  /** The words of the first piece of each part that ended as `reason`. */
  const wordsOf = (reason: SpokenLeaf['outcome']): string[] => runs.flatMap(({ leaves }) => leaves.filter(isSpoken).filter(leaf => leaf.outcome === reason).slice(0, 1).map(leaf => leaf.words))
  const refused = wordsOf('request-too-large')
  if (refused.length > 0) {
    gaps.push({ profile, reason: 'request-too-large', detail: `${refused.length} of ${runs.length} research requests were not sent: ${refused[0]}` })
  }
  const failed = wordsOf('research-failed')
  if (failed.length > 0) {
    gaps.push({ profile, reason: 'research-failed', detail: `${failed.length} of ${runs.length} research parts failed: ${failed[0]}` })
  }
  const down = wordsOf('provider-down')
  if (down.length > 0) {
    gaps.push({ profile, reason: 'provider-down', detail: `${down.length} of ${runs.length} research parts were not sent, since their provider was down` })
  }
  return gaps
}

/** The one gap of the hunks the floor left unread, counting hunks and files; none when `leaves` has no piece cut off at the floor. */
function cutOffGap(profile: string, scope: Scope, leaves: readonly Leaf[]): IncompleteEntry | undefined {
  const { hunks, files } = floorOf(scope, leaves)
  return hunks === 0
    ? undefined
    : {
        profile,
        reason: 'reply-cut-off',
        detail: `${hunks} hunk(s) of ${files.size} file(s) were cut off at their reply's limit even alone, listed as reply-cut-off in meta.profiles.${profile}.coverage: raise maxTokens, set thinking: low, or lower partTokens`,
      }
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
