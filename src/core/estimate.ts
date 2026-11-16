import { reviewScope } from './coverage.ts'
import { diffSections, splitDiff } from './diff.ts'
import { partText } from './parts.ts'
import type { CompletionRequest } from './ports.ts'
import { researchRequest, voteRequest } from './prompts.ts'
import { reservationOf, roomOf } from './stages/context.ts'
import type { LensRun, ProfileRun } from './stages/context.ts'
import { planResearch } from './stages/research.ts'
import type { ResearchPlan } from './stages/research.ts'
import { tokenBound } from './tokens.ts'
import type { Estimate, Finding, ProfileEstimate } from './types.ts'
import { MAX_CATEGORY, MAX_EVIDENCE, MAX_SUMMARY } from './verify.ts'

/**
 * How many times the bound of a research request over-counts the tokens of code. The bound is one token per
 * UTF-8 byte, and code diffs run 2.9 to 3.8 bytes per token across the tokenizers measured, so a third of the
 * bound is what code most likely takes, and a diff of prose or of encoded data takes more. It only scales the
 * expected spend of an estimate: the ledger reserves the whole bound at run time.
 */
export const BOUND_OVER_CODE = 3

/** What the estimate reads of a quorum's settings. */
export interface EstimateSettings {
  /** Whether a file's path is left out of every request. */
  readonly excluded: (path: string) => boolean
  /** The most tokens of diff text one research part holds. */
  readonly partTokens: number
  /** How many findings of a research reply each profile sends to the panel. */
  readonly maxFindings: number
  /** How many provider calls run at once in one review. */
  readonly concurrency: number
  /** The token cap of one review. */
  readonly maxReviewTokens: number
  /** The deadline of one review, in milliseconds. */
  readonly reviewTimeoutMs: number
}

/** The section of the filtered diff a vote reads at most: the largest one. */
interface Section {
  readonly path: string
  readonly text: string
  readonly tokens: number
}

/**
 * What a review of `diff` by `runs` may cost, before any call: nothing is sent, and no provider's `complete` is
 * called, only the `room` and the `worstCase` it states, which are what the ledger reserves with. It reads the
 * diff as `review` does, less the sections `excluded` leaves out and the files held back as secrets, except the
 * ones `sent` names, and plans each profile's research the same way, so the reservation it states for each
 * research part is the one the ledger takes for it. A diff with nothing left to read makes no call and costs
 * nothing.
 *
 * A vote's reservation depends on a finding that does not exist yet, so each lens's is a bound: the request for
 * a finding at the caps the harness cleans a finder's text to, citing the largest section of the filtered
 * diff, whole for a voter that states no room or whose room holds it, else the partial context filled to its
 * room. A review may cast `maxFindings` votes of each lens in each profile.
 *
 * `expected` counts the research parts at `1 / BOUND_OVER_CODE` of their reservation, rounded up, and the votes
 * not at all: how many findings research reports is not known before it runs, so the votes are in `worst`,
 * at their bound, alone. `inFlight` is the sum of the `concurrency` largest bounds among the research parts
 * and the votes, each lens's counted `maxFindings` times, since the review's one limit shares its slots
 * between every profile. `fits` is `expected + inFlight <= maxReviewTokens`. It is an estimate: the ledger
 * still holds the cap at run time, whatever it says.
 */
export function estimateReview(runs: readonly ProfileRun[], settings: EstimateSettings, diff: string, sent: (path: string) => boolean = () => false): Estimate {
  const scope = reviewScope(diff, settings.excluded, sent)
  const filtered = diffSections(scope.diff)
  const largest = scope.diff.trim() === ''
    ? undefined
    : largestSection(splitDiff(scope.diff), scope.diff)
  const estimates = runs.map(run => ({
    id: run.id,
    estimate: largest === undefined
      ? noCall()
      : profileEstimate(run, planResearch(run, scope.diff, filtered, settings.partTokens), scope.diff, largest, settings.maxFindings),
  }))
  const profiles = estimates.map(({ estimate }) => estimate)
  const expected = sum(profiles.map(profile => profile.expected))
  const inFlight = reservedAtOnce(profiles, settings.maxFindings, settings.concurrency)
  return {
    profiles: Object.fromEntries(estimates.map(({ id, estimate }) => [id, estimate])),
    expected,
    worst: sum(profiles.map(profile => profile.worst)),
    inFlight,
    maxReviewTokens: settings.maxReviewTokens,
    reviewTimeoutMs: settings.reviewTimeoutMs,
    fits: expected + inFlight <= settings.maxReviewTokens,
  }
}

function sum(numbers: readonly number[]): number {
  return numbers.reduce((total, number) => total + number, 0)
}

/** The estimate of a profile whose research makes no call: nothing is reserved, and no vote is cast. */
function noCall(): ProfileEstimate {
  return {
    parts: [],
    votes: 0,
    vote: {},
    expected: 0,
    worst: 0,
  }
}

/** The largest section of the filtered diff, as `splitDiff` keys them; the whole diff when it keeps none, as a vote falls back on. */
function largestSection(sections: ReadonlyMap<string, string>, diff: string): Section {
  let largest: Section | undefined
  for (const [path, text] of sections) {
    const tokens = tokenBound(text)
    if (largest === undefined || tokens > largest.tokens) largest = { path, text, tokens }
  }
  return largest ?? {
    path: '',
    text: diff,
    tokens: tokenBound(diff),
  }
}

/** One profile's estimate, from the plan its research follows. */
function profileEstimate(run: ProfileRun, plan: ResearchPlan, diff: string, largest: Section, maxFindings: number): ProfileEstimate {
  const parts = researchReservations(run, plan, diff)
  if (parts.length === 0) return noCall()
  const bounds = run.lenses.map(lens => voteBound(run, lens, largest))
  return {
    parts,
    votes: maxFindings * run.lenses.length,
    vote: Object.fromEntries(run.lenses.map((lens, index) => [lens.id, bounds[index]])),
    expected: sum(parts.map(part => Math.ceil(part / BOUND_OVER_CODE))),
    worst: sum(parts) + maxFindings * sum(bounds),
  }
}

/**
 * What the ledger reserves for each research request the review would send, in order, built as `research` builds
 * them: one request holding the whole filtered diff when the plan has no packing, else one per part whose text is
 * not blank, a plan of one part sending its text with no parts block, and a plan of several naming each part's
 * position among them and the change's files. A part that holds only white space is asked of no model.
 */
function researchReservations(run: ProfileRun, plan: ResearchPlan, diff: string): number[] {
  const { instructions } = run.research
  const reserve = (request: CompletionRequest): number => reservationOf(run.research, request)
  const { packing } = plan
  if (packing === undefined) {
    return [
      reserve(researchRequest(instructions, diff, run.guidelines)),
    ]
  }
  const { parts } = packing
  const { files, unlisted } = plan.listed ?? { files: [], unlisted: 0 }
  return parts.flatMap((part, index) => {
    const text = partText(plan.sections, packing, part)
    if (text.trim() === '') return []
    return [
      reserve(parts.length === 1
        ? researchRequest(instructions, text, run.guidelines)
        : researchRequest(instructions, text, run.guidelines, {
            index: index + 1,
            count: parts.length,
            files,
            unlisted,
          })),
    ]
  })
}

/** A finding as the harness leaves it at its longest: every text the finder or the diff writes at its cap, in the one character that costs a token a character. */
function longestFinding(file: string): Finding {
  return {
    id: '',
    profile: '',
    file,
    line: Number.MAX_SAFE_INTEGER,
    category: 'x'.repeat(MAX_CATEGORY),
    summary: 'x'.repeat(MAX_SUMMARY),
    evidence: 'x'.repeat(MAX_EVIDENCE),
    quoteMatched: true,
  }
}

/**
 * The most the ledger reserves for one vote of `lens`: the request for the longest finding citing the largest
 * section. The section is sent whole, unless the lens's voter states a room the section exceeds, as the panel
 * decides it: the room of the request with an empty diff block, and the room of the partial request, whose
 * block takes the section's header and the hunks nearest the cited line that fit. Then the vote is the partial
 * request filled to that room, the most such a context holds. A room of the partial request that states
 * nothing, or less than 0, sends the whole section, which the provider refuses as too large.
 */
function voteBound(run: ProfileRun, lens: LensRun, largest: Section): number {
  const finding = longestFinding(largest.path)
  const request = (context: string, partial = false): CompletionRequest => voteRequest(lens.instructions, finding, context, run.guidelines, partial)
  const room = roomOf(lens, request(''))
  if (room !== undefined && largest.tokens > room) {
    const partialRoom = roomOf(lens, request('', true))
    if (partialRoom !== undefined && partialRoom >= 0) return reservationOf(lens, request('x'.repeat(Math.min(partialRoom, largest.tokens)), true))
  }
  return reservationOf(lens, request(largest.text))
}

/**
 * What the calls that run at once reserve: the sum of the `concurrency` largest bounds among every research part
 * and every vote of every profile, a lens's vote counted `maxFindings` times, once per finding it may judge. The
 * review's concurrency limit is one for all its profiles, so the bounds are taken from all of them together; with
 * fewer calls than slots, every call counts.
 */
function reservedAtOnce(profiles: readonly ProfileEstimate[], maxFindings: number, concurrency: number): number {
  const calls = profiles.flatMap(({ parts, vote }) => [
    ...parts.map(bound => ({ bound, count: 1 })),
    ...Object.values(vote).map(bound => ({ bound, count: maxFindings })),
  ]).sort((a, b) => b.bound - a.bound)
  let slots = concurrency
  let reserved = 0
  for (const { bound, count } of calls) {
    const taken = Math.min(count, slots)
    reserved += bound * taken
    slots -= taken
    if (slots === 0) break
  }
  return reserved
}
