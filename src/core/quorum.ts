import { VERSION } from './version.ts'
import { systemClock } from './clock.ts'
import type { Clock } from './clock.ts'
import { createLimiter, DEFAULT_CONCURRENCY } from './concurrency.ts'
import { leftOutGaps, reviewScope } from './coverage.ts'
import type { ReviewScope } from './coverage.ts'
import { diffSections, splitDiff } from './diff.ts'
import { ConfigError } from './errors.ts'
import type { ConfigIssue } from './errors.ts'
import { estimateReview } from './estimate.ts'
import { excludeIssues, excludeMatcher } from './exclude.ts'
import { diffFlags, secretFlags } from './flags.ts'
import { leftOutIssues, mergeLeftOut, sendIssues, sourceIssues, sourceOf } from './inputs.ts'
import { createLedger, DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS, LimitError, limitGaps, maxReviewTokensProblem } from './limits.ts'
import { isRecord } from './output.ts'
import { coverageOf, DEFAULT_PART_TOKENS, partTokensProblem, tooLargeGap } from './parts.ts'
import type { PartOutcome } from './parts.ts'
import { MAX_STATED_TIMEOUT_MS, retriesProblem, timeoutProblem } from './ports.ts'
import type { EventSink, ProfilePorts, Provider, QuorumPorts } from './ports.ts'
import { failOnOf, profileIssues, profileWarnings, thresholdsFor } from './profile.ts'
import { renderTemplate } from './prompts.ts'
import { addUsage, elapsed, ownData, stage, targetOf } from './stages/context.ts'
import type { ProfileRun, RunContext } from './stages/context.ts'
import { dedup } from './stages/dedup.ts'
import { panel } from './stages/panel.ts'
import type { PanelOutcome } from './stages/panel.ts'
import { DEFAULT_MAX_FINDINGS, planResearch, research } from './stages/research.ts'
import type { ResearchPlan } from './stages/research.ts'
import type { CoverageEntry, Estimate, Profile, ProfileMeta, ProfileProviders, Quorum, QuorumEvent, QuorumMeta, QuorumOptions, QuorumResult, ReviewInput, Usage } from './types.ts'

const PROVIDER_SHAPE = 'must be a provider: an object with a string id, a string model and a complete function'

/** The options that must be positive integers when they are set. */
const LIMITS = ['concurrency', 'maxFindings'] as const

/** What createQuorum compiled: the frozen runs and settings every review of the quorum reads. */
interface Compiled {
  readonly runs: readonly ProfileRun[]
  readonly concurrency: number
  readonly maxFindings: number
  /** The most tokens one review spends: each review gets a ledger of this cap. */
  readonly maxReviewTokens: number
  /** How long one review runs, in milliseconds: each review arms a deadline of this length on `clock`. */
  readonly reviewTimeoutMs: number
  /** The most tokens of diff text one research part holds. */
  readonly partTokens: number
  /** The time and the randomness every review reads: the system's, unless a spec injects its own through `createQuorumWith`. */
  readonly clock: Clock
  /** Whether a file's path is left out of every request, built once from `exclude`. */
  readonly excluded: (path: string) => boolean
  readonly sink: EventSink | undefined
}

/** What one review takes besides its input: the signal that stops it. */
type ReviewOptions = NonNullable<Parameters<Quorum['review']>[1]>

/** What an estimate takes of a review's input: the diff, and the files it sends though they are held back. */
type EstimateInput = Parameters<Quorum['estimate']>[0]

/** What a review counts from its own events, so its meta and its events cannot disagree. */
interface Tally {
  usage?: Usage
  readonly invalidFindings: Map<string, number>
}

/**
 * Build a quorum: check every input up front, compile each profile once, and return the `review`
 * that runs them all on a diff.
 *
 * Every problem is reported at once, in one ConfigError, never as a TypeError, so an untyped caller
 * gets the checks a config file gets: options and ports that are not objects, no profile, each
 * profile's own issues, a repeated profile id, a `concurrency` or `maxFindings` that is not a
 * positive integer, a `maxReviewTokens` that is not a whole number of tokens from 1 to
 * 9007199254740991, a `reviewTimeoutMs` that is not a whole number of milliseconds from 1000 to
 * 86400000, a `partTokens` that is not a whole number of tokens from 1024 to 9007199254740991, an
 * `exclude` that is not a list of at most 100 patterns that can be taken, a missing or malformed
 * research provider or voter, a provider's stated `timeoutMs` that is not a
 * whole number of milliseconds from 1000 to 518400000, `retries` that is not a whole number from
 * 0 to 5 or `worstCase` or `room` that is not a function, ports for a profile or a lens the run does not have
 * (a likely typo), and an event sink that is not a function. Ports are checked only for the profiles
 * that have no issue of their own, and not at all when `profiles` is not an array. Every record keyed
 * by a caller's id is read as an own property, since `constructor` is a valid id. `maxReviewTokens`,
 * the most tokens one review spends, input and output, is 2000000 when unset, `reviewTimeoutMs`,
 * how long one review runs, is 1800000 (30 minutes) when unset, and `partTokens`, the most tokens of
 * diff text one research part holds, is 32768 when unset: see `review`.
 *
 * Each profile is compiled into a frozen `ProfileRun`, its instructions rendered, its thresholds
 * resolved and its providers captured, and `exclude` is compiled into a matcher, so later changes to
 * the caller's profiles, ports or `exclude` are not seen. `warnings` lists what the profiles set
 * that cannot take full effect. Each review can be stopped through its own signal; a throwing event
 * sink or a failing profile stops it too.
 *
 * @throws ConfigError listing every issue of the options and the ports
 *
 * @example
 * const voters = { reachability: model, impact: model, defenses: model }
 * const quorum = createQuorum({ profiles: [securityProfile] }, { profiles: { security: { research: model, voters } } })
 * const { kept, meta } = await quorum.review({ diff: diffText }, { signal: controller.signal })
 */
export function createQuorum(options: QuorumOptions, ports: QuorumPorts): Quorum {
  return createQuorumWith(options, ports, systemClock)
}

/**
 * `createQuorum` on a clock of the caller's: the time, the randomness and the one timer the call path and the
 * review's deadline read. It is the specs' seam, so a review's deadline and a call's waits run on a fake clock
 * and cost no real time; the package does not export it, and `createQuorum` passes the system's clock.
 *
 * @throws ConfigError listing every issue of the options and the ports, as `createQuorum` does
 */
export function createQuorumWith(options: QuorumOptions, ports: QuorumPorts, clock: Clock): Quorum {
  const issues = inputIssues(options, ports)
  if (issues.length > 0) throw new ConfigError(issues)
  // The checks found every profile valid and named once, with an own entry in ports.profiles and an own voter per lens.
  const compiled: Compiled = {
    runs: Object.freeze(options.profiles.map(profile => compile(profile, ports.profiles[profile.id]))),
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    maxFindings: options.maxFindings ?? DEFAULT_MAX_FINDINGS,
    maxReviewTokens: options.maxReviewTokens ?? DEFAULT_MAX_REVIEW_TOKENS,
    reviewTimeoutMs: options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    partTokens: options.partTokens ?? DEFAULT_PART_TOKENS,
    clock,
    excluded: excludeMatcher(options.exclude ?? []),
    sink: ports.events,
  }
  const warnings: readonly string[] = Object.freeze(options.profiles.flatMap(profile => profileWarnings(profile)))
  return Object.freeze({
    review: (input: ReviewInput, options?: ReviewOptions) => review(compiled, input, options),
    estimate: (input: EstimateInput) => estimate(compiled, input),
    warnings,
  })
}

/**
 * What one review of `input.diff` may cost, before any call: no provider is called and nothing is read or
 * written. Per profile, it states what the review's ledger reserves for each research part, in order, exactly
 * as `review` plans and builds them (the diff less the sections `exclude` leaves out, parted on each research
 * provider's stated room), and a bound for the votes: `maxFindings` votes of each lens, each at the request for
 * a finding at its longest citing the largest section of the filtered diff. `expected` counts the research
 * parts alone, each at a third of its reservation, rounded up (`BOUND_OVER_CODE`), and `worst` the parts in full
 * and every vote at its bound, so the votes are in the worst case only. `inFlight` is what the calls that run
 * at once reserve, the `concurrency` largest bounds among all the profiles' calls, and `fits` is whether
 * `expected` and `inFlight` are within `maxReviewTokens`. A diff with nothing left to read, blank or whose every
 * file is excluded or held back as a secret, makes no call and costs nothing; a file `input.send` names is not
 * held back, so it is counted, as `review` sends it. It is an estimate, not a limit: a review reserves each call
 * against the cap, which still holds whatever `fits` says.
 *
 * @throws ConfigError listing every issue of the input that `review` refuses: an input that is not an object, a `diff` that is not a string, a `source`, a `leftOut` or a `send` it cannot take
 */
function estimate(compiled: Compiled, input: EstimateInput): Estimate {
  const issues = reviewIssues(input, {})
  if (issues.length > 0) throw new ConfigError(issues)
  const sent = new Set(input.send)
  return estimateReview(compiled.runs, compiled, input.diff, path => sent.has(path))
}

/**
 * One review of a diff by every profile of the quorum, concurrently, each through research, dedup
 * and panel under the review's one concurrency limit; a blank diff runs no stage. The diff is
 * filtered once: the sections the quorum's `exclude` patterns match, and the files held back as secrets
 * (below), leave every request, so research, the check of each finding and the votes read the diff less
 * those sections, split into one section per file once for every profile, and a finding that cites an
 * excluded or a held file is dropped as outside the diff. A filtered diff that is blank, with every file
 * excluded or held and nothing before the first header, runs no stage, as a blank diff does, and still
 * records the gaps its held files make. The advisory flags are read before any stage runs, from the
 * whole diff, the excluded and the held files included. The review lists the files it leaves out in
 * `meta.leftOut`: the excluded ones, which are no gap, the files whose change the diff does not carry,
 * binary files and submodules' commits, and the files held back, for each reason of which it records a
 * gap for every profile; the sections of a file whose change the diff does not carry still reach the
 * stages. The input's own `leftOut`, the files its
 * source left out before it made the diff, comes first in the list, in the `left-out` event and in the gaps'
 * counts, each file, reason and rule once, and a skipped one is no gap; the input's `source` is checked,
 * copied and recorded in `meta.source`, `{ kind: 'diff' }` when it names none. Its `skipped` files of the
 * rule `secret`, and the `secret` and `deleted-secret` files `meta.leftOut` lists, each raise one `secret-file`
 * flag, as many as `meta.leftOut` lists, ahead of the diff's flags and whatever the diff is.
 * Everything it knows before a call is sent in this order: `run:start`, then a `left-out` event naming those files when it leaves one
 * out, then the gaps' `incomplete` events (each profile's `binary`, `submodule` and `secret` gaps, then its
 * `too-large` gap), then the `flag` events of the advisory flags, the `secret-file` flags first,
 * kept in `meta.flags`, none of which changes a verdict, then the stages. Each event is handed to the sink
 * as a copy, so a sink that changes one changes nothing else. The review reports itself through
 * events, from `run:start` to `run:end`, and its result merges the profiles' verdicts and gaps in
 * profile order. `meta.profiles[<id>].invalidFindings` and `meta.usage` are counted from the
 * events before the sink receives them.
 *
 * No model is sent a line of a file held back as a secret. A file is held when its name is a secret's
 * (`.env`, `id_ed25519`, a `.pem` file) or a line of it, removed and context lines included, holds a credential
 * quorum recognizes (a private key's armor and body, the keys of AWS, GitHub, Slack, Google, Stripe, Anthropic
 * and OpenAI), by any path its section names; every section of it leaves the diff, and a credential in one
 * holds all. It is listed in `meta.leftOut` as `secret` with its `rule` (`name`, or the kind of credential),
 * raises a `secret-file` flag, and is a `secret` gap of every profile that no flag lifts; a change that deletes
 * a file named as a secret whole lists it as `deleted-secret` with its flag and no gap, while a deletion of a
 * file held for a credential in it, whose removed code would go unread, is a `secret` gap. The text no header names is one file
 * of the empty name, held as any other. `input.send` names the files to send though held, each the path exactly
 * as `meta.leftOut` lists it, never the empty name: such a file is sent, neither listed nor flagged, and one
 * `exclude` matches is excluded first. `send` is copied before the review's first await.
 *
 * Abort never fails open. The review's signal joins the caller's `signal` to an internal one; every
 * stage and every call checks it, every attempt carries a signal of its own, which the review's
 * abort and the attempt's deadline abort, and it is checked once more after the profiles have run,
 * a blank diff included, so an aborted review rejects with the signal's reason, whatever error a
 * call it cut raised, and never resolves. No event is delivered once the review is aborted. A sink
 * that throws aborts the review with its error, and a gating profile's research failure (the call or
 * its reply) aborts it with that failure where it fails, so no other profile starts a call after
 * it; any other failure aborts the review when the profiles' run rejects. Either way the review
 * rejects with the first reason. An advisory profile's research failure is its `research-failed`
 * gap and aborts nothing. An abort after `run:end` has no effect: the review is over.
 *
 * A review ends at its deadline, `reviewTimeoutMs` after it starts, with an answer: at it every call in
 * flight and every wait is stopped at once, no call still queued starts, and what was not done is a
 * `review-deadline` gap of its profile, its research request (the parts of it not yet answered) or its
 * votes, each a failed vote of the deadline. The review then resolves with its findings so far, exiting
 * `4` for a gating profile whatever the flags; the deadline is no abort, so an interrupt still rejects
 * with its reason, before the deadline or after it, and a review that reaches its deadline is never a
 * failed run. The deadline's timer is armed once the input checks pass and cleared however the review
 * ends: it resolves, it rejects, its sink throws or it is aborted.
 *
 * A change larger than one research request is researched in parts, not refused. Each profile's research
 * is planned once the scope is known, on its own research provider's stated room: a provider that
 * states none, or a diff within `partTokens` and within the room, is sent the whole diff in one request,
 * as it always was; else the filtered diff's sections, in order, are packed into parts of at most
 * `partTokens` whose request fits the room, a section too large for a part split between its hunks and
 * a hunk never cut. Each part is one research call, in order, that names its position and the change's
 * files; the replies are read in order, up to `maxFindings` findings in all, each checked against the
 * whole diff. A hunk, or a section with no hunk, that fits in no research part of the window is no part's:
 * the profile records one `too-large` gap for them before any call is sent, which no flag lifts for a
 * gating profile. `meta.profiles.<id>.coverage` lists every file of the input diff once, in its order,
 * with how much of it the profile's research reviewed: reviewed, partly (with the ranges left), not
 * (with the reason), or excluded by `exclude`; each profile has its own, since each has its own
 * research model.
 *
 * A review spends at most `maxReviewTokens` tokens. Each review has its own ledger of that cap: every
 * attempt of every call reserves its worst case in it before it is sent and settles at what it spent,
 * so concurrent calls cannot overshoot it. A call the cap stops is no failed review: its profile's
 * research or vote is a `token-cap` gap, which exits 4 for a gating profile, and the other profiles
 * and votes run as far as the cap lets them. A research in parts spends up to the cap, each part reserved
 * before it is sent: the parts the cap cannot fund are not sent, and one gap counts them.
 *
 * @throws ConfigError listing every issue of the input and the options: an input that is not an object, a `diff` that is not a string, a `source`, a `leftOut` or a `send` it cannot take, options that are not an object, a `signal` that is not an AbortSignal
 * @throws the signal's reason once the review is aborted, before it starts or while it runs
 * @throws the error of a sink that throws, or of a gating profile that fails: a ProviderError from its research call, an OutputError for its reply
 */
async function review(compiled: Compiled, input: ReviewInput, options: ReviewOptions = {}): Promise<QuorumResult> {
  const issues = reviewIssues(input, options)
  if (issues.length > 0) throw new ConfigError(issues)
  options.signal?.throwIfAborted()
  const { clock, reviewTimeoutMs } = compiled
  const deadline = { at: clock.now() + reviewTimeoutMs, ms: reviewTimeoutMs }
  const expired = new AbortController()
  const cancel = clock.timer(reviewTimeoutMs, () => {
    expired.abort(new LimitError('review-deadline', `the review reached its deadline of ${reviewTimeoutMs} ms`))
  })
  try {
    return await reviewUntil(compiled, input, options, deadline, expired.signal)
  } finally {
    cancel()
  }
}

/**
 * What `review` does once its deadline is armed: everything from its signals to its result, with `expired`, the
 * deadline's own signal, joined to the review's into the one `stop` the call path reads.
 */
async function reviewUntil(compiled: Compiled, input: ReviewInput, options: ReviewOptions, deadline: RunContext['deadline'], expired: AbortSignal): Promise<QuorumResult> {
  const internal = new AbortController()
  const signal = options.signal === undefined
    ? internal.signal
    : AbortSignal.any([options.signal, internal.signal])
  const fail = (error: unknown): void => {
    if (!signal.aborted) internal.abort(error)
  }
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const { runs, sink } = compiled
  const whole = input.diff.trim() === ''
    ? undefined
    : splitDiff(input.diff)
  // Copied before the first await, so the caller's later changes to its input reach neither the result nor the events.
  const sent = new Set(input.send)
  const source = sourceOf(input.source)
  const scope: ReviewScope = whole === undefined
    ? { diff: input.diff, leftOut: [], files: [] }
    : reviewScope(input.diff, compiled.excluded, path => sent.has(path))
  const leftOut = mergeLeftOut(input.leftOut ?? [], scope.leftOut)
  // The source's secrets are read from the merged list, so a file it lists twice is flagged once, as `meta.leftOut` lists it once.
  const flags = [
    ...secretFlags(leftOut),
    ...whole === undefined
      ? []
      : diffFlags(whole),
  ]
  // What the stages read: none when the filtered diff is blank, else the sections the flags read when nothing was left out.
  const sections = scope.diff.trim() === ''
    ? undefined
    : scope.diff === input.diff
      ? whole
      : splitDiff(scope.diff)
  // The same sections as the research packs them, and how each profile's research goes: none when no stage runs.
  const filtered = sections === undefined
    ? []
    : diffSections(scope.diff)
  const plans = sections === undefined
    ? []
    : runs.map(run => planResearch(run, scope.diff, filtered, compiled.partTokens))
  const gaps = new Map(runs.map((run, index) => {
    const tooLarge = tooLargeGap(run.id, filtered, plans[index]?.packing, scope.leftOut)
    return [
      run.id,
      [
        ...leftOutGaps(run.id, leftOut),
        ...tooLarge === undefined
          ? []
          : [tooLarge],
      ],
    ] as const
  }))
  const tally: Tally = {
    invalidFindings: new Map(),
  }
  const emit = (event: QuorumEvent): void => {
    if (signal.aborted) return
    if (event.type === 'call' && event.usage !== undefined) tally.usage = addUsage(tally.usage, event.usage)
    if (event.type === 'finding:invalid') tally.invalidFindings.set(event.profile, (tally.invalidFindings.get(event.profile) ?? 0) + 1)
    try {
      sink?.(structuredClone(event))
    } catch (error) {
      // The caller's bug surfaces instead of being swallowed, and ends the review: no profile starts another call.
      internal.abort(error)
      throw error
    }
  }
  const ctx: RunContext = {
    limit: createLimiter(compiled.concurrency),
    ledger: createLedger(compiled.maxReviewTokens),
    emit,
    signal,
    stop: AbortSignal.any([signal, expired]),
    deadline,
    fail,
    maxFindings: compiled.maxFindings,
    concurrency: compiled.concurrency,
    clock: compiled.clock,
  }
  emit({
    type: 'run:start',
    profiles: runs.map(run => run.id),
    providers: Object.fromEntries(runs.map(run => [
      run.id,
      providersOf(run),
    ])),
  })
  if (leftOut.length > 0) emit({ type: 'left-out', files: leftOut })
  for (const run of runs) {
    for (const entry of gaps.get(run.id) ?? []) emit({ type: 'incomplete', entry })
  }
  for (const flag of flags) emit({ type: 'flag', flag })
  const outcomes = await reviewAll(ctx, runs, plans, scope.diff, sections).catch((error: unknown) => {
    // A gating profile's research failure aborted the review where it failed; any other failure aborts it here. The first reason stays the reason.
    const reason: unknown = signal.aborted ? signal.reason : error
    internal.abort(reason)
    throw reason
  })
  signal.throwIfAborted()
  const kept = outcomes.flatMap(outcome => outcome.kept)
  const discarded = outcomes.flatMap(outcome => outcome.discarded)
  const unreviewed = outcomes.flatMap(outcome => outcome.unreviewed)
  const incomplete = runs.flatMap((run, index) => [
    ...gaps.get(run.id) ?? [],
    ...outcomes[index]?.incomplete ?? [],
  ])
  const durationMs = elapsed(started)
  const meta: QuorumMeta = {
    version: VERSION,
    startedAt,
    durationMs,
    source,
    profiles: Object.fromEntries(runs.map((run, index) => [
      run.id,
      profileMeta(run, tally.invalidFindings.get(run.id) ?? 0, coverageOf(scope, filtered, plans[index]?.packing, outcomes[index]?.parts ?? [])),
    ])),
    ...(tally.usage === undefined
      ? {}
      : { usage: tally.usage }),
    incomplete,
    leftOut,
    flags,
  }
  emit({
    type: 'run:end',
    kept: kept.length,
    discarded: discarded.length,
    unreviewed: unreviewed.length,
    incomplete: incomplete.length,
    durationMs,
  })
  return { kept, discarded, unreviewed, meta }
}

/** What a profile's review comes to: its panel's outcome, and what became of each part of its research, for its coverage. */
interface ProfileOutcome extends PanelOutcome {
  readonly parts: readonly PartOutcome[]
}

/** Run every profile through its stages at once on the diff's sections, each on its own plan; a blank diff, which has none, runs no stage. */
async function reviewAll(ctx: RunContext, runs: readonly ProfileRun[], plans: readonly ResearchPlan[], diff: string, sections: ReadonlyMap<string, string> | undefined): Promise<ProfileOutcome[]> {
  if (sections === undefined) return []
  return Promise.all(runs.map((run, index) => reviewProfile(ctx, run, plans[index], diff, sections)))
}

/**
 * One profile's review: its panel's outcome, with the research gaps before the panel's own, and last the
 * gap of each limit that stopped its work, reported by an `incomplete` event once the panel's stage has ended.
 */
async function reviewProfile(ctx: RunContext, run: ProfileRun, plan: ResearchPlan, diff: string, sections: ReadonlyMap<string, string>): Promise<ProfileOutcome> {
  const researched = await stage(ctx, run.id, 'research', () => research(ctx, run, plan, diff, sections), outcome => outcome.findings.length)
  const candidates = await stage(ctx, run.id, 'dedup', () => dedup(researched.findings), found => found.length)
  const judged = await stage(ctx, run.id, 'panel', () => panel(ctx, run, candidates, sections, diff), outcome => outcome.kept.length + outcome.discarded.length + outcome.unreviewed.length)
  const limits = limitGaps(run.id, researched.parts, [
    ...judged.kept,
    ...judged.discarded,
    ...judged.unreviewed,
  ], { cap: ctx.ledger.cap, deadlineMs: ctx.deadline.ms })
  for (const entry of limits) ctx.emit({ type: 'incomplete', entry })
  return {
    ...judged,
    incomplete: [
      ...researched.incomplete,
      ...judged.incomplete,
      ...limits,
    ],
    parts: researched.parts,
  }
}

/**
 * Every problem with one review's input and options, so an untyped caller gets issues, never a
 * TypeError. An input that is not an object is named as the input, not as its diff: the likely
 * mistake is the diff text passed on its own, as `runQuorum` takes it. The `source`, the `leftOut` and the
 * `send`, when set, are checked after the diff, so a caller sees every issue of the input at once. The signal
 * must be a real AbortSignal: `AbortSignal.any` accepts nothing else.
 */
function reviewIssues(input: unknown, options: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!isRecord(input)) {
    issues.push({ path: 'input', message: 'must be an object holding the diff string' })
  } else {
    if (typeof input.diff !== 'string') issues.push({ path: 'diff', message: 'must be a string' })
    issues.push(...sourceIssues(input.source), ...leftOutIssues(input.leftOut), ...sendIssues(input.send))
  }
  if (!isRecord(options)) issues.push({ path: 'options', message: 'must be an object' })
  else if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) issues.push({ path: 'signal', message: 'must be an AbortSignal' })
  return issues
}

/** Who reviews for a profile, as new objects the caller may keep or change: never the frozen refs of the run. */
function providersOf(run: ProfileRun): ProfileProviders {
  return {
    research: { ...run.research.ref },
    lenses: Object.fromEntries(run.lenses.map(lens => [
      lens.id,
      { ...lens.ref },
    ])),
  }
}

function profileMeta(run: ProfileRun, invalidFindings: number, coverage: CoverageEntry[]): ProfileMeta {
  return {
    providers: providersOf(run),
    policy: { ...run.thresholds },
    failOn: run.failOn,
    gating: run.gating,
    invalidFindings,
    coverage,
  }
}

/**
 * Compile a checked profile and its checked ports into the frozen run every review reads: the vote
 * template rendered once per lens, the thresholds resolved, `failOn` (`high` unless the profile says
 * otherwise, `none` for its deprecated `gating: false`) and `gating` (true unless `failOn` is `none`), and
 * each provider captured beside the `{ id, model }` ref events and meta report and the deadline of its
 * attempts.
 */
function compile(profile: Profile, ports: ProfilePorts): ProfileRun {
  const failOn = failOnOf(profile)
  const panelSize = String(profile.lenses.length)
  const lenses = profile.lenses.map(lens => Object.freeze({
    id: lens.id,
    instructions: renderTemplate(profile.prompts.vote, { 'lens.id': lens.id, 'lens.question': lens.question, 'panel.size': panelSize }),
    ...targetOf(ports.voters[lens.id]),
  }))
  return Object.freeze({
    id: profile.id,
    research: Object.freeze({
      instructions: profile.prompts.research,
      ...targetOf(ports.research),
    }),
    lenses: Object.freeze(lenses),
    thresholds: Object.freeze(thresholdsFor(profile)),
    failOn,
    gating: failOn !== 'none',
    guidelines: profile.guidelines,
  })
}

/**
 * Every problem with the options and the ports, in this order: options and ports that are not
 * objects, `profiles`, each profile's own issues and repeated ids, the limits, `exclude`, then the
 * ports.
 */
function inputIssues(options: unknown, ports: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!isRecord(options)) issues.push({ path: 'options', message: 'must be an object' })
  if (!isRecord(ports)) issues.push({ path: 'ports', message: 'must be an object' })
  if (!isRecord(options)) return issues
  if (!Array.isArray(options.profiles)) {
    return [
      ...issues,
      { path: 'profiles', message: 'must be an array of profiles' },
      ...limitIssues(options),
      ...excludeIssues(options.exclude),
    ]
  }
  // `Array.from` reads a hole as `undefined`, so it is reported like any other profile that is not an object.
  const profiles = profileListIssues(Array.from<unknown>(options.profiles))
  issues.push(...profiles.issues, ...limitIssues(options), ...excludeIssues(options.exclude))
  if (isRecord(ports)) issues.push(...portIssues(ports, profiles.checked, profiles.named))
  return issues
}

/**
 * The issues of every profile, under its id or, while its id is invalid, its index; a profile whose
 * id repeats an earlier one's is refused. `checked` lists the profiles whose ports are checked:
 * those with no issue of their own and a first use of their id. `named` holds every id the run's
 * profiles give as a string, valid or not, so their ports are never reported as unknown.
 */
function profileListIssues(profiles: readonly unknown[]): { issues: ConfigIssue[], checked: Profile[], named: Set<string> } {
  const issues: ConfigIssue[] = []
  const checked: Profile[] = []
  const named = new Set<string>()
  if (profiles.length === 0) issues.push({ path: 'profiles', message: 'must hold at least one profile' })
  profiles.forEach((profile, index) => {
    const problems = profileIssues(profile as Profile, `profiles.${index}`)
    issues.push(...problems)
    const id = isRecord(profile) && typeof profile.id === 'string'
      ? profile.id
      : undefined
    if (id === undefined) return
    const repeated = named.has(id)
    if (repeated) issues.push({ path: `profiles.${index}.id`, message: `repeats the profile id ${JSON.stringify(id)}` })
    named.add(id)
    if (problems.length === 0 && !repeated) checked.push(profile as Profile)
  })
  return { issues, checked, named }
}

/**
 * `concurrency` and `maxFindings` are positive integers when set, `maxReviewTokens` a whole number of
 * tokens from 1 to 9007199254740991, `reviewTimeoutMs` a whole number of milliseconds from 1000 to
 * 86400000, and `partTokens` a whole number of tokens from 1024 to 9007199254740991. A number is
 * quoted in the first two; anything else is described by the rule alone.
 */
function limitIssues(options: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = LIMITS.flatMap((path) => {
    const value = options[path]
    if (value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1)) return []
    const got = typeof value === 'number'
      ? `, got ${value}`
      : ''
    return [
      { path, message: `must be a positive integer${got}` },
    ]
  })
  const problem = options.maxReviewTokens === undefined
    ? undefined
    : maxReviewTokensProblem(options.maxReviewTokens)
  if (problem !== undefined) issues.push({ path: 'maxReviewTokens', message: problem })
  const timeout = options.reviewTimeoutMs === undefined
    ? undefined
    : timeoutProblem(options.reviewTimeoutMs)
  if (timeout !== undefined) issues.push({ path: 'reviewTimeoutMs', message: timeout })
  const partTokens = options.partTokens === undefined
    ? undefined
    : partTokensProblem(options.partTokens)
  if (partTokens !== undefined) issues.push({ path: 'partTokens', message: partTokens })
  return issues
}

/** The ports of each checked profile in order, then the ports no profile of the run names, then the sink. */
function portIssues(ports: Record<string, unknown>, profiles: readonly Profile[], named: ReadonlySet<string>): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const entries = ports.profiles
  if (isRecord(entries)) {
    for (const profile of profiles) issues.push(...profilePortIssues(entries, profile))
    for (const id of Object.keys(entries)) {
      if (!named.has(id)) issues.push({ path: `ports.profiles.${id}`, message: 'names no profile of the run' })
    }
  } else {
    issues.push({ path: 'ports.profiles', message: 'must be an object keyed by profile id' })
  }
  if (ports.events !== undefined && typeof ports.events !== 'function') issues.push({ path: 'ports.events', message: 'must be a function' })
  return issues
}

/** One profile's ports: the entry, its research provider, its voters and a voter per lens, then the voters no lens names. */
function profilePortIssues(entries: Record<string, unknown>, profile: Profile): ConfigIssue[] {
  const path = `ports.profiles.${profile.id}`
  const entry = own(entries, profile.id)
  if (entry === undefined) {
    return [
      { path, message: 'is missing' },
    ]
  }
  if (!isRecord(entry)) {
    return [
      { path, message: 'must be an object with a research provider and voters' },
    ]
  }
  const issues = providerIssues(`${path}.research`, entry.research)
  const { voters } = entry
  if (voters === undefined) {
    return [
      ...issues,
      { path: `${path}.voters`, message: 'is missing' },
    ]
  }
  if (!isRecord(voters)) {
    return [
      ...issues,
      { path: `${path}.voters`, message: 'must be an object keyed by lens id' },
    ]
  }
  const lensIds = new Set(profile.lenses.map(lens => lens.id))
  for (const lens of profile.lenses) issues.push(...providerIssues(`${path}.voters.${lens.id}`, own(voters, lens.id)))
  for (const id of Object.keys(voters)) {
    if (!lensIds.has(id)) issues.push({ path: `${path}.voters.${id}`, message: 'names no lens of the profile' })
  }
  return issues
}

/**
 * The issues of one provider: it is missing, it is not one, the `timeoutMs` or the `retries` it
 * states, as own data, is out of range, or the `worstCase` or the `room` it states, as own data, is not a function.
 */
function providerIssues(path: string, value: unknown): ConfigIssue[] {
  if (value === undefined) {
    return [
      { path, message: 'is missing' },
    ]
  }
  if (!isProvider(value)) {
    return [
      { path, message: PROVIDER_SHAPE },
    ]
  }
  const issues: ConfigIssue[] = []
  const timeoutMs = ownData(value, 'timeoutMs')
  const timeout = timeoutMs === undefined
    ? undefined
    : timeoutProblem(timeoutMs, MAX_STATED_TIMEOUT_MS)
  if (timeout !== undefined) issues.push({ path: `${path}.timeoutMs`, message: timeout })
  const retries = ownData(value, 'retries')
  const retry = retries === undefined
    ? undefined
    : retriesProblem(retries)
  if (retry !== undefined) issues.push({ path: `${path}.retries`, message: retry })
  const worstCase = ownData(value, 'worstCase')
  if (worstCase !== undefined && typeof worstCase !== 'function') issues.push({ path: `${path}.worstCase`, message: 'must be a function' })
  const room = ownData(value, 'room')
  if (room !== undefined && typeof room !== 'function') issues.push({ path: `${path}.room`, message: 'must be a function' })
  return issues
}

/** A provider is a non-null object with a string id, a string model and a complete function. */
function isProvider(value: unknown): value is Provider {
  return isRecord(value) && typeof value.id === 'string' && typeof value.model === 'string' && typeof value.complete === 'function'
}

/** What `record` holds under `key` as its own property: an id such as `constructor` never finds an inherited member. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key)
    ? record[key]
    : undefined
}
