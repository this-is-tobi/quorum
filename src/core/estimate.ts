import { presentOf, researchProbe, voteProbe } from './budgets.ts'
import type { ProfileBudgets } from './budgets.ts'
import { reviewScope } from './coverage.ts'
import { diffSections, splitDiff } from './diff.ts'
import type { DiffSection } from './diff.ts'
import { DOCUMENT_KINDS } from './documents.ts'
import { laneStart, REVIEW_CEILING } from './lanes.ts'
import { cutSection, partText } from './parts.ts'
import type { Cut, Slice } from './parts.ts'
import type { CompletionRequest, Provider } from './ports.ts'
import { researchRequest, voteRequest } from './prompts.ts'
import type { Ask, PartOf } from './prompts.ts'
import { MAX_DEPTH } from './recovery.ts'
import { reservationOf, roomOf, withSent } from './stages/context.ts'
import type { LensRun, ProfileRun, Target } from './stages/context.ts'
import { dispatchOrder, planResearch } from './stages/research.ts'
import type { ResearchPlan } from './stages/research.ts'
import { DEFAULT_REPLY_TOKENS, expectedOf, tokenBound } from './tokens.ts'
import type { DocumentKind, Estimate, ProfileEstimate } from './types.ts'
import { longestFinding } from './verify.ts'

/** What the estimate reads of a quorum's settings. */
export interface EstimateSettings {
  /** Whether a file's path is left out of every request. */
  readonly excluded: (path: string) => boolean
  /** The most tokens of diff text one research part holds. */
  readonly partTokens: number
  /** How many findings of a research reply each profile sends to the panel. */
  readonly maxFindings: number
  /** How many findings of the research each profile sends to its panel: the votes are counted at it, and no request is sized by it. */
  readonly findingsCap: number
  /** The reply budgets of each profile, by profile id: what its requests carry and ask for, as the review sends them. */
  readonly budgets: Readonly<Record<string, ProfileBudgets>>
  /** How many provider calls run at once in one review, shared by every provider; unset, each provider has a lane of its own under the review's ceiling. */
  readonly concurrency: number | undefined
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
 * What a review of `diff` by the runs `given` may cost, before any call: nothing is sent, and no provider's `complete` is
 * called, only the `room` and the `worstCase` it states, which are what the ledger reserves with. It reads the
 * diff as `review` does, less the sections `excluded` leaves out and the files held back as secrets, except the
 * ones `sent` names, and plans each profile's research the same way, so the reservation it states for each
 * research part is the one the ledger takes for it. A diff with nothing left to read makes no call and costs
 * nothing.
 *
 * Each request is built as the review builds it, with the reply budget and the findings its provider's budgets
 * give it, so a reservation is the one the review takes. `given` are the review's own runs: a profile that a review's
 * repository documents name is a run with them in its guidelines, its research instructions and its rules, so each part and
 * each vote bound here counts them. A run that lists rules sends the ones whose paths match a file of the filtered diff
 * (`withSent`), so each part counts that block and a vote counts none.
 *
 * A vote's reservation depends on a finding that does not exist yet, so each lens's is a bound: the request for
 * a finding at the caps the harness cleans a finder's text to, citing the largest section of the filtered
 * diff, whole for a voter that states no room or whose room holds it, else the partial context filled to its
 * room. A review may cast `findingsCap` votes of each lens in each profile.
 *
 * `expected` counts each research part at a third of its input, rounded up, plus its reply at the lesser of its
 * budget and `EXPECTED_REPLY_TOKENS` (`expectedOf`), and the votes not at all: how many findings research reports
 * is not known before it runs, so the votes are in `worst`, at their bound, alone. `worst` is an upper bound of
 * what the ledger can reserve with one attempt per call, before any retry reserves again: each part's reservation and recovery's bound (`recoveryBound`), the votes at their
 * bound, the calls an adaptation sends once more (`adaptationBound`), and each call once more of a provider that states a retry, which sends a bad reply once more (`onceMoreBound`). `inFlight` is the sum of the
 * `concurrency` largest bounds among the research parts and the votes, each lens's counted `findingsCap` times,
 * since the review's one limit shares its slots between every profile; with `concurrency` unset, each provider counts the
 * largest bounds among its own calls up to where its lane starts (`laneStart`), and the `REVIEW_CEILING` largest of those
 * count in all, as the lanes run at their start. `fits` is `expected + inFlight <=
 * maxReviewTokens`, and leaves recovery and the adaptations out, which only an adversarial or a failing review
 * reaches, and which would refuse every large path review. `held` is how many research parts the cap holds: the
 * parts of every profile, in profile order and then in the order they are sent (largest first, `dispatchOrder`),
 * counted while their expected spends and `inFlight` stay within `maxReviewTokens`. The cap and the deadline are `settings`', so a caller may make one
 * estimate under its quorum's and another under limits of its own: `worst`, `expected` and `inFlight` do not depend
 * on them. It is an estimate: the ledger still holds the cap at run time, whatever it says.
 */
export function estimateReview(given: readonly ProfileRun[], settings: EstimateSettings, diff: string, sent: (path: string) => boolean = () => false): Estimate {
  const scope = reviewScope(diff, settings.excluded, sent)
  const filtered = diffSections(scope.diff)
  // Each run sends the rules whose paths match a file of the filtered diff, as the review does.
  const runs = given.map(run => withSent(run, filtered))
  const largest = scope.diff.trim() === ''
    ? undefined
    : largestSection(splitDiff(scope.diff), scope.diff)
  const planned = runs.map(run => ({
    id: run.id,
    run,
    ...largest === undefined
      ? noCall(settings.budgets[run.id])
      : profileEstimate(run, planResearch(run, scope.diff, filtered, { partTokens: settings.partTokens, maxFindings: settings.maxFindings, replyTokens: settings.budgets[run.id].research.replyTokens }), scope.diff, largest, settings),
  }))
  const profiles = planned.map(({ estimate }) => estimate)
  const expected = sum(profiles.map(profile => profile.expected))
  const inFlight = reservedAtOnce(planned, settings.findingsCap, settings.concurrency)
  return {
    profiles: Object.fromEntries(planned.map(({ id, estimate }) => [id, estimate])),
    expected,
    worst: sum(profiles.map(profile => profile.worst)) + adaptationBound(planned, settings) + onceMoreBound(planned, settings),
    inFlight,
    maxFindings: settings.maxFindings,
    findingsCap: settings.findingsCap,
    maxReviewTokens: settings.maxReviewTokens,
    reviewTimeoutMs: settings.reviewTimeoutMs,
    fits: expected + inFlight <= settings.maxReviewTokens,
    held: heldParts(planned.flatMap(({ partsExpected }) => partsExpected), inFlight, settings.maxReviewTokens),
  }
}

/**
 * How many research parts a cap holds: `expected` is each part's expected spend, in profile order and the order the
 * parts are sent, and parts are counted while their spends, with what the calls in flight reserve (`inFlight`), stay
 * within `cap`. A cap below `inFlight` holds none, and one that `fits` holds them all.
 */
function heldParts(expected: readonly number[], inFlight: number, cap: number): number {
  let spent = inFlight
  let held = 0
  for (const part of expected) {
    spent += part
    if (spent > cap) break
    held += 1
  }
  return held
}

function sum(numbers: readonly number[]): number {
  return numbers.reduce((total, number) => total + number, 0)
}

/** What one profile's estimate comes with: the tokens a piece's request holds beyond each research part's (`extras`, parallel to `parts`). */
interface Planned {
  readonly estimate: ProfileEstimate
  readonly extras: readonly number[]
  /** What each research part is expected to spend (`expectedOf`), in the order the parts are sent, largest first (`dispatchOrder`). */
  readonly partsExpected: readonly number[]
  /** What the profile's research parts may reserve, each with recovery's bound: the part of `estimate.worst` that is not the votes'. */
  readonly researchWorst: number
}

/** The estimate of a profile whose research makes no call: nothing is reserved, and no vote is cast. */
function noCall(budgets: ProfileBudgets): Planned {
  return {
    estimate: {
      parts: [],
      votes: 0,
      vote: {},
      expected: 0,
      worst: 0,
      findings: budgets.research.findings,
      provider: budgets.research.provider,
      documents: { research: 0, vote: 0 },
    },
    extras: [],
    partsExpected: [],
    researchWorst: 0,
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

/** The pieces of a part at its three depths: 2 + 4 + 8. */
const PIECES = 2 ** (MAX_DEPTH + 1) - 2

/**
 * The most a research part's recovery spends beyond its own reservation, for a part of `d` diff tokens, `header`
 * tokens in its largest file header and `reservation` tokens in all, whose pieces' requests hold `extra` tokens
 * more than the part's: each of the `MAX_DEPTH` depths holds the diff once, and each of the `PIECES` pieces
 * repeats at most one header and holds the request's fixed text, its template reserve and its reply budget
 * (`reservation - d`) with what its own position adds. A part makes at most `PIECES + 1` calls whatever the
 * content, since a node of the tree makes one request.
 */
function recoveryBound(reservation: number, d: number, header: number, extra: number): number {
  return MAX_DEPTH * d + PIECES * (header + Math.max(0, reservation - d) + extra)
}

/** The tokens of the largest header, the lines before a section's first hunk, among the sections `slices` hold: the text recovery repeats in each piece it cuts. A section with no hunk is never cut, and repeats none. */
function largestHeader(sections: readonly DiffSection[], cuts: ReadonlyMap<number, Cut>, slices: readonly Slice[]): number {
  let largest = 0
  for (const { section } of slices) {
    const { text } = sections[section]
    const { starts } = cuts.get(section) ?? cutSection(text)
    if (starts.length === 0 || starts[0] === 0) continue
    largest = Math.max(largest, tokenBound(text.slice(0, starts[0] - 1)) + 1)
  }
  return largest
}

/**
 * The tokens a piece's request holds beyond its part's, as `researchRequest` builds them: the position of the
 * deepest piece (`piece 8 of 8`, the longest), and, for a research of one request, whose own request has no parts
 * block, the whole block its pieces gain. Both requests are built over no diff, since the difference is in the
 * fixed text alone.
 */
function pieceExtra(run: ProfileRun, ask: Ask, part: PartOf | undefined): number {
  const { instructions } = run.research
  const reserve = (position: PartOf | undefined): number => reservationOf(run.research, researchRequest(instructions, '', run.guidelines, position, ask, run.sent))
  const piece = { index: 2 ** MAX_DEPTH, count: 2 ** MAX_DEPTH }
  return Math.max(0, reserve({
    files: [],
    unlisted: 0,
    ...part,
    piece,
  }) - reserve(part))
}

/**
 * What the profile's documents add to the reservation of one research request and of one vote: each is the reservation of the
 * request over no diff with the run's documents less that of the same request without them (the probes of the startup refusal:
 * the research instructions without the do-not-report paragraph, no guidelines block, no rules in the rules block), and a vote's
 * is the largest among the lenses, whose providers may reserve differently. A profile with no document adds nothing.
 */
function documentsAdd(run: ProfileRun, budgets: ProfileBudgets): ProfileEstimate['documents'] {
  const present = presentOf(run, DOCUMENT_KINDS)
  if (present.length === 0) return { research: 0, vote: 0 }
  const { findings, replyTokens } = budgets.research
  const research = (without: readonly DocumentKind[]): number => reservationOf(run.research, researchProbe(run, replyTokens, findings, undefined, without))
  const vote = (lens: LensRun, without: readonly DocumentKind[]): number => reservationOf(lens, voteProbe(run, lens, budgets.lenses[lens.id].replyTokens, without))
  return {
    research: Math.max(0, research([]) - research(present)),
    vote: Math.max(0, ...run.lenses.map(lens => vote(lens, []) - vote(lens, present))),
  }
}

/** One profile's estimate, from the plan its research follows. */
function profileEstimate(run: ProfileRun, plan: ResearchPlan, diff: string, largest: Section, settings: EstimateSettings): Planned {
  const { findingsCap } = settings
  const budgets = settings.budgets[run.id]
  const reply = budgets.research.replyTokens ?? DEFAULT_REPLY_TOKENS
  const research = researchCalls(run, plan, diff, { findings: budgets.research.findings, replyTokens: budgets.research.replyTokens })
  if (research.length === 0) return noCall(budgets)
  const bounds = run.lenses.map(lens => voteBound(run, lens, largest, budgets.lenses[lens.id].replyTokens))
  const parts = research.map(call => call.reservation)
  const partsExpected = inSendOrder(research, plan).map(call => expectedOf(call.reservation, reply))
  const researchWorst = sum(research.map(call => call.reservation + recoveryBound(call.reservation, call.diff, call.header, call.extra)))
  return {
    estimate: {
      parts,
      votes: findingsCap * run.lenses.length,
      vote: Object.fromEntries(run.lenses.map((lens, index) => [lens.id, bounds[index]])),
      expected: sum(partsExpected),
      worst: researchWorst + findingsCap * sum(bounds),
      findings: budgets.research.findings,
      provider: budgets.research.provider,
      documents: documentsAdd(run, budgets),
    },
    extras: research.map(call => call.extra),
    partsExpected,
    researchWorst,
  }
}

/** A research request the review would send: the part it holds, what the ledger reserves for it, the diff tokens it holds, its largest file header, and what a piece of it would hold beyond it. */
interface ResearchCall {
  /** The index of the part in the plan's packing, 0 for a request of the whole diff. */
  readonly part: number
  readonly reservation: number
  readonly diff: number
  readonly header: number
  readonly extra: number
}

/** The research requests in the order the review sends them: its parts largest first (`dispatchOrder`), a part the plan makes no request of left out. */
function inSendOrder(calls: readonly ResearchCall[], plan: ResearchPlan): ResearchCall[] {
  const rank = new Map((plan.packing === undefined
    ? [0]
    : dispatchOrder(plan.packing)).map((part, position) => [part, position]))
  return calls.toSorted((a, b) => (rank.get(a.part) ?? 0) - (rank.get(b.part) ?? 0))
}

/**
 * Each research request the review would send, in the plan's order, as a `ResearchCall` (what the ledger reserves for it, the
 * diff tokens it holds, its largest file header, and what a piece of it would hold beyond it), built as `research` builds
 * them: one request holding the whole filtered diff when the plan has no packing, else one per part whose text is
 * not blank, a plan of one part sending its text with no parts block, and a plan of several naming each part's
 * position among them and the change's files. A part that holds only white space is asked of no model.
 */
function researchCalls(run: ProfileRun, plan: ResearchPlan, diff: string, ask: Ask): ResearchCall[] {
  const { instructions } = run.research
  const reserve = (request: CompletionRequest): number => reservationOf(run.research, request)
  const { packing } = plan
  if (packing === undefined) {
    return [
      {
        part: 0,
        reservation: reserve(researchRequest(instructions, diff, run.guidelines, undefined, ask, run.sent)),
        diff: tokenBound(diff),
        header: largestHeader(plan.sections, new Map(), plan.sections.map((_, section) => ({ section }))),
        extra: pieceExtra(run, ask, undefined),
      },
    ]
  }
  const { parts } = packing
  const { files, unlisted } = plan.listed ?? { files: [], unlisted: 0 }
  return parts.flatMap((part, index) => {
    const text = partText(plan.sections, packing, part)
    if (text.trim() === '') return []
    const position = parts.length === 1
      ? undefined
      : {
          index: index + 1,
          count: parts.length,
          files,
          unlisted,
        }
    return [
      {
        part: index,
        reservation: reserve(researchRequest(instructions, text, run.guidelines, position, ask, run.sent)),
        diff: part.tokens,
        header: largestHeader(plan.sections, packing.cuts, part.slices),
        extra: pieceExtra(run, ask, position),
      },
    ]
  })
}

/**
 * The most the ledger reserves for one vote of `lens`: the request for the longest finding citing the largest
 * section. The section is sent whole, unless the lens's voter states a room the section exceeds, as the panel
 * decides it: the room of the request with an empty diff block, and the room of the partial request, whose
 * block takes the section's header and the hunks nearest the cited line that fit. Then the vote is the partial
 * request filled to that room, the most such a context holds. A room of the partial request that states
 * nothing, or less than 0, sends the whole section, which the provider refuses as too large.
 */
function voteBound(run: ProfileRun, lens: LensRun, largest: Section, replyTokens: number | undefined): number {
  const finding = longestFinding(largest.path)
  const request = (context: string, partial = false): CompletionRequest => voteRequest(lens.instructions, finding, context, run.guidelines, partial, { replyTokens })
  const room = roomOf(lens, request(''))
  if (room !== undefined && largest.tokens > room) {
    const partialRoom = roomOf(lens, request('', true))
    if (partialRoom !== undefined && partialRoom >= 0) return reservationOf(lens, request('x'.repeat(Math.min(partialRoom, largest.tokens)), true))
  }
  return reservationOf(lens, request(largest.text))
}

/** A call the review may make, as the review's limit sees it: what it reserves and how many of it a review may make. */
interface Call {
  readonly bound: number
  readonly count: number
}

/** The `slots` largest of `calls`, each counted as many times as it may be made: with fewer calls than slots, every call is taken. */
function largestCalls(calls: readonly Call[], slots: number): Call[] {
  let free = slots
  const taken: Call[] = []
  for (const { bound, count } of [...calls].sort((a, b) => b.bound - a.bound)) {
    if (free === 0) break
    const times = Math.min(count, free)
    taken.push({ bound, count: times })
    free -= times
  }
  return taken
}

/** The sum of the bounds of `calls`, each counted as many times as it may be made. */
function reserved(calls: readonly Call[]): number {
  return sum(calls.map(({ bound, count }) => bound * count))
}

/** The sum of the `slots` largest bounds among `calls`, each counted as many times as it may be made: with fewer calls than slots, every call counts. */
function largestAtOnce(calls: readonly Call[], slots: number): number {
  return reserved(largestCalls(calls, slots))
}

/**
 * What the calls that run at once reserve: with `concurrency` set, the sum of the `concurrency` largest bounds among every research
 * part and every vote of every profile, a lens's vote counted `findingsCap` times, once per finding it may judge, since the review's
 * limit is one for all its profiles. With it unset, each provider's own calls are taken up to where its lane starts, the largest
 * bounds first, and the `REVIEW_CEILING` largest of those among every provider count: the lanes at their start, under the ceiling.
 * With fewer calls than slots, every call counts.
 */
function reservedAtOnce(planned: ReadonlyArray<{ readonly run: ProfileRun, readonly estimate: ProfileEstimate }>, findingsCap: number, concurrency: number | undefined): number {
  const calls = planned.flatMap(({ run, estimate }) => [
    ...estimate.parts.map(bound => ({
      target: run.research,
      call: { bound, count: 1 },
    })),
    ...run.lenses.flatMap(lens => Object.hasOwn(estimate.vote, lens.id)
      ? [
          {
            target: lens,
            call: { bound: estimate.vote[lens.id], count: findingsCap },
          },
        ]
      : []),
  ])
  if (concurrency !== undefined) return largestAtOnce(calls.map(({ call }) => call), concurrency)
  const lanes = new Map<Provider, { readonly start: number, readonly calls: Call[] }>()
  for (const { target, call } of calls) {
    const lane = lanes.get(target.provider) ?? {
      start: laneStart(target),
      calls: [],
    }
    lane.calls.push(call)
    lanes.set(target.provider, lane)
  }
  return largestAtOnce([
    ...lanes.values(),
  ].flatMap(lane => largestCalls(lane.calls, lane.start)), REVIEW_CEILING)
}

/** How many settings a provider states it can move by itself: its thinking, its structured output, and its stream, which steps down twice and counts as two. */
function settingsOf({ adapts }: Target): number {
  return Number(adapts?.thinking !== undefined) + Number(adapts?.prompt === true) + (adapts?.stream === true
    ? 2
    : 0)
}

/**
 * What the calls an adaptation sends once more may reserve at most. A provider that states it can move a setting
 * sends, per setting and review, one probe, and the calls already in flight beside it at most once more each once
 * the setting has moved (at most `concurrency` calls in all, or, with lanes, the review's ceiling of 16 calls of the provider), so the bound is, per provider and per setting its
 * `adapts` states, the `concurrency` (else `REVIEW_CEILING`) largest bounds among its own calls: its research parts, each with what a piece's
 * position adds, since a piece may be the call sent again, and its votes. A provider that states no `adapts`
 * (an explicit setting, a structured output that is no `json`, a provider object) sends no probe and adds nothing. A
 * provider is counted once across the profiles and roles that share it, as the review's one limit shares its slots.
 */
function adaptationBound(planned: ReadonlyArray<{ readonly run: ProfileRun, readonly estimate: ProfileEstimate, readonly extras: readonly number[] }>, settings: EstimateSettings): number {
  const providers = new Map<Provider, { readonly settings: number, readonly calls: Call[] }>()
  const add = (target: Target, calls: readonly Call[]): void => {
    const moved = settingsOf(target)
    if (moved === 0) return
    const entry = providers.get(target.provider) ?? { settings: moved, calls: [] }
    entry.calls.push(...calls)
    providers.set(target.provider, entry)
  }
  for (const { run, estimate, extras } of planned) {
    add(run.research, estimate.parts.map((part, index) => ({ bound: part + extras[index], count: 1 })))
    for (const lens of run.lenses) {
      add(lens, estimate.parts.length === 0
        ? []
        : [
            { bound: estimate.vote[lens.id], count: settings.findingsCap },
          ])
    }
  }
  return sum([
    ...providers.values(),
  ].map(entry => entry.settings * largestAtOnce(entry.calls, settings.concurrency ?? REVIEW_CEILING)))
}

/** Whether a call of `target` that gets a bad reply sends it once more as it is: its provider states a retry, which the once-more send is one of. */
function sendsOnceMore(target: Target): boolean {
  return target.retries >= 1
}

/**
 * What the calls a bad reply sends once more may reserve at most: every call of a provider that states a retry
 * (`sendsOnceMore`) once more, whatever its thinking, since any of its calls may be the one. Per profile, its research
 * parts each with recovery's bound when its research provider does, and `findingsCap` votes of each lens whose provider
 * does, at their bound.
 */
function onceMoreBound(planned: ReadonlyArray<{ readonly run: ProfileRun, readonly estimate: ProfileEstimate, readonly researchWorst: number }>, settings: EstimateSettings): number {
  return sum(planned.map(({ run, estimate, researchWorst }) => (sendsOnceMore(run.research)
    ? researchWorst
    : 0) + sum(run.lenses.map(lens => sendsOnceMore(lens) && Object.hasOwn(estimate.vote, lens.id)
    ? settings.findingsCap * estimate.vote[lens.id]
    : 0))))
}
