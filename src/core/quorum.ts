import packageJson from '../../package.json' with { type: 'json' }
import { systemClock } from './clock.ts'
import type { Clock } from './clock.ts'
import { createLimiter, DEFAULT_CONCURRENCY } from './concurrency.ts'
import { leftOutGaps, reviewScope } from './coverage.ts'
import type { ReviewScope } from './coverage.ts'
import { splitDiff } from './diff.ts'
import { ConfigError } from './errors.ts'
import type { ConfigIssue } from './errors.ts'
import { excludeIssues, excludeMatcher } from './exclude.ts'
import { diffFlags } from './flags.ts'
import { createLedger, DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS, LimitError, limitGaps, maxReviewTokensProblem } from './limits.ts'
import { isRecord } from './output.ts'
import { MAX_STATED_TIMEOUT_MS, retriesProblem, timeoutProblem } from './ports.ts'
import type { EventSink, ProfilePorts, Provider, QuorumPorts } from './ports.ts'
import { profileIssues, profileWarnings, thresholdsFor } from './profile.ts'
import { renderTemplate } from './prompts.ts'
import { addUsage, elapsed, ownData, stage, targetOf } from './stages/context.ts'
import type { ProfileRun, RunContext } from './stages/context.ts'
import { dedup } from './stages/dedup.ts'
import { panel } from './stages/panel.ts'
import type { PanelOutcome } from './stages/panel.ts'
import { DEFAULT_MAX_FINDINGS, research } from './stages/research.ts'
import type { Profile, ProfileMeta, ProfileProviders, Quorum, QuorumEvent, QuorumMeta, QuorumOptions, QuorumResult, Usage } from './types.ts'

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
  /** The time and the randomness every review reads: the system's, unless a spec injects its own through `createQuorumWith`. */
  readonly clock: Clock
  /** Whether a file's path is left out of every request, built once from `exclude`. */
  readonly excluded: (path: string) => boolean
  readonly sink: EventSink | undefined
}

/** What one review takes besides its input: the signal that stops it. */
type ReviewOptions = NonNullable<Parameters<Quorum['review']>[1]>

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
 * 86400000, an `exclude` that is not a list of at most 100 patterns that can be taken, a
 * missing or malformed research provider or voter, a provider's stated `timeoutMs` that is not a
 * whole number of milliseconds from 1000 to 518400000, `retries` that is not a whole number from
 * 0 to 5 or `worstCase` or `room` that is not a function, ports for a profile or a lens the run does not have
 * (a likely typo), and an event sink that is not a function. Ports are checked only for the profiles
 * that have no issue of their own, and not at all when `profiles` is not an array. Every record keyed
 * by a caller's id is read as an own property, since `constructor` is a valid id. `maxReviewTokens`,
 * the most tokens one review spends, input and output, is 2000000 when unset, and `reviewTimeoutMs`,
 * how long one review runs, is 1800000 (30 minutes) when unset: see `review`.
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
    clock,
    excluded: excludeMatcher(options.exclude ?? []),
    sink: ports.events,
  }
  const warnings: readonly string[] = Object.freeze(options.profiles.flatMap(profile => profileWarnings(profile)))
  return Object.freeze({
    review: (input: { readonly diff: string }, options?: ReviewOptions) => review(compiled, input, options),
    warnings,
  })
}

/**
 * One review of a diff by every profile of the quorum, concurrently, each through research, dedup
 * and panel under the review's one concurrency limit; a blank diff runs no stage. The diff is
 * filtered once: the sections the quorum's `exclude` patterns match leave every request, so
 * research, the check of each finding and the votes read the diff less those sections, split into
 * one section per file once for every profile, and a finding that cites an excluded file is dropped
 * as outside the diff. A filtered diff that is blank, with every file excluded and nothing before
 * the first header, runs no stage, as a blank diff does. The advisory flags are read before any
 * stage runs, from the whole diff, the excluded files included. The review lists the files it
 * leaves out in `meta.leftOut`: the excluded ones, which are no gap, and the files whose change the
 * diff does not carry, binary files and submodules' commits, for each reason of which it records a
 * gap for every profile; their sections still reach the stages. Everything it knows before a call
 * is sent in this order: `run:start`, then a `left-out` event naming those files when it leaves one
 * out, then the gaps' `incomplete` events, then the `flag` events of the advisory flags, kept in
 * `meta.flags`, none of which changes a verdict, then the stages. Each event is handed to the sink
 * as a copy, so a sink that changes one changes nothing else. The review reports itself through
 * events, from `run:start` to `run:end`, and its result merges the profiles' verdicts and gaps in
 * profile order. `meta.profiles[<id>].invalidFindings` and `meta.usage` are counted from the
 * events before the sink receives them.
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
 * `review-deadline` gap of its profile, its research request or its votes, each a failed vote of the
 * deadline. The review then resolves with its findings so far, exiting `4` for a gating profile whatever
 * the flags; the deadline is no abort, so an interrupt still rejects with its reason, before the deadline
 * or after it, and a review that reaches its deadline is never a failed run. The deadline's timer is armed
 * once the input checks pass and cleared however the review ends: it resolves, it rejects, its sink throws
 * or it is aborted.
 *
 * A review spends at most `maxReviewTokens` tokens. Each review has its own ledger of that cap: every
 * attempt of every call reserves its worst case in it before it is sent and settles at what it spent,
 * so concurrent calls cannot overshoot it. A call the cap stops is no failed review: its profile's
 * research or vote is a `token-cap` gap, which exits 4 for a gating profile, and the other profiles
 * and votes run as far as the cap lets them.
 *
 * @throws ConfigError listing every issue of the input and the options: an input that is not an object, a `diff` that is not a string, options that are not an object, a `signal` that is not an AbortSignal
 * @throws the signal's reason once the review is aborted, before it starts or while it runs
 * @throws the error of a sink that throws, or of a gating profile that fails: a ProviderError from its research call, an OutputError for its reply
 */
async function review(compiled: Compiled, input: { readonly diff: string }, options: ReviewOptions = {}): Promise<QuorumResult> {
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
async function reviewUntil(compiled: Compiled, input: { readonly diff: string }, options: ReviewOptions, deadline: RunContext['deadline'], expired: AbortSignal): Promise<QuorumResult> {
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
  const flags = whole === undefined
    ? []
    : diffFlags(whole)
  const scope: ReviewScope = whole === undefined
    ? { diff: input.diff, leftOut: [], files: [] }
    : reviewScope(input.diff, compiled.excluded)
  // What the stages read: none when the filtered diff is blank, else the sections the flags read when nothing was left out.
  const sections = scope.diff.trim() === ''
    ? undefined
    : scope.diff === input.diff
      ? whole
      : splitDiff(scope.diff)
  const gaps = new Map(runs.map(run => [
    run.id,
    leftOutGaps(run.id, scope.leftOut),
  ] as const))
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
  if (scope.leftOut.length > 0) emit({ type: 'left-out', files: scope.leftOut })
  for (const run of runs) {
    for (const entry of gaps.get(run.id) ?? []) emit({ type: 'incomplete', entry })
  }
  for (const flag of flags) emit({ type: 'flag', flag })
  const outcomes = await reviewAll(ctx, runs, scope.diff, sections).catch((error: unknown) => {
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
    version: packageJson.version,
    startedAt,
    durationMs,
    profiles: Object.fromEntries(runs.map(run => [
      run.id,
      profileMeta(run, tally.invalidFindings.get(run.id) ?? 0),
    ])),
    ...(tally.usage === undefined
      ? {}
      : { usage: tally.usage }),
    incomplete,
    leftOut: scope.leftOut,
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

/** Run every profile through its stages at once on the diff's sections; a blank diff, which has none, runs no stage. */
async function reviewAll(ctx: RunContext, runs: readonly ProfileRun[], diff: string, sections: ReadonlyMap<string, string> | undefined): Promise<PanelOutcome[]> {
  if (sections === undefined) return []
  return Promise.all(runs.map(run => reviewProfile(ctx, run, diff, sections)))
}

/**
 * One profile's review: its panel's outcome, with the research gaps before the panel's own, and last the
 * gap of each limit that stopped its work, reported by an `incomplete` event once the panel's stage has ended.
 */
async function reviewProfile(ctx: RunContext, run: ProfileRun, diff: string, sections: ReadonlyMap<string, string>): Promise<PanelOutcome> {
  const researched = await stage(ctx, run.id, 'research', () => research(ctx, run, diff, sections), outcome => outcome.findings.length)
  const candidates = await stage(ctx, run.id, 'dedup', () => dedup(researched.findings), found => found.length)
  const judged = await stage(ctx, run.id, 'panel', () => panel(ctx, run, candidates, sections, diff), outcome => outcome.kept.length + outcome.discarded.length + outcome.unreviewed.length)
  const limits = limitGaps(run.id, researched.stopped, [
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
  }
}

/**
 * Every problem with one review's input and options, so an untyped caller gets issues, never a
 * TypeError. An input that is not an object is named as the input, not as its diff: the likely
 * mistake is the diff text passed on its own, as `runQuorum` takes it. The signal must be a real
 * AbortSignal: `AbortSignal.any` accepts nothing else.
 */
function reviewIssues(input: unknown, options: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!isRecord(input)) issues.push({ path: 'input', message: 'must be an object holding the diff string' })
  else if (typeof input.diff !== 'string') issues.push({ path: 'diff', message: 'must be a string' })
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

function profileMeta(run: ProfileRun, invalidFindings: number): ProfileMeta {
  return {
    providers: providersOf(run),
    policy: { ...run.thresholds },
    gating: run.gating,
    invalidFindings,
  }
}

/**
 * Compile a checked profile and its checked ports into the frozen run every review reads: the vote
 * template rendered once per lens, the thresholds resolved, `gating` true unless the profile says
 * otherwise, and each provider captured beside the `{ id, model }` ref events and meta report and
 * the deadline of its attempts.
 */
function compile(profile: Profile, ports: ProfilePorts): ProfileRun {
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
    gating: profile.gating ?? true,
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
 * tokens from 1 to 9007199254740991, and `reviewTimeoutMs` a whole number of milliseconds from 1000 to
 * 86400000. A number is quoted in the first two; anything else is described by the rule alone.
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
