import packageJson from '../../package.json' with { type: 'json' }
import { createLimiter, DEFAULT_CONCURRENCY } from './concurrency.ts'
import { splitDiff } from './diff.ts'
import { ConfigError } from './errors.ts'
import type { ConfigIssue } from './errors.ts'
import { isRecord } from './output.ts'
import type { EventSink, ProfilePorts, Provider, QuorumPorts } from './ports.ts'
import { profileIssues, profileWarnings, thresholdsFor } from './profile.ts'
import { renderTemplate } from './prompts.ts'
import { elapsed, stage } from './stages/context.ts'
import type { ProfileRun, RunContext, Target } from './stages/context.ts'
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
 * positive integer, a missing or malformed research provider or voter, ports for a profile or a
 * lens the run does not have (a likely typo), and an event sink that is not a function. Ports are
 * checked only for the profiles that have no issue of their own, and not at all when `profiles` is
 * not an array. Every record keyed by a caller's id is read as an own property, since `constructor`
 * is a valid id.
 *
 * Each profile is compiled into a frozen `ProfileRun`, its instructions rendered, its thresholds
 * resolved and its providers captured, so later changes to the caller's profiles or ports are not
 * seen. `warnings` lists what the profiles set that cannot take full effect. Each review can be
 * stopped through its own signal; a throwing event sink or a failing profile stops it too.
 *
 * @throws ConfigError listing every issue of the options and the ports
 *
 * @example
 * const voters = { reachability: model, impact: model, defenses: model }
 * const quorum = createQuorum({ profiles: [securityProfile] }, { profiles: { security: { research: model, voters } } })
 * const { kept, meta } = await quorum.review({ diff: diffText }, { signal: controller.signal })
 */
export function createQuorum(options: QuorumOptions, ports: QuorumPorts): Quorum {
  const issues = inputIssues(options, ports)
  if (issues.length > 0) throw new ConfigError(issues)
  // The checks found every profile valid and named once, with an own entry in ports.profiles and an own voter per lens.
  const compiled: Compiled = {
    runs: Object.freeze(options.profiles.map(profile => compile(profile, ports.profiles[profile.id]))),
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    maxFindings: options.maxFindings ?? DEFAULT_MAX_FINDINGS,
    sink: ports.events,
  }
  const warnings: readonly string[] = Object.freeze(options.profiles.flatMap(profile => profileWarnings(profile)))
  return Object.freeze({ review: (input: { readonly diff: string }, options?: ReviewOptions) => review(compiled, input, options), warnings })
}

/**
 * One review of a diff by every profile of the quorum, concurrently, each through research, dedup
 * and panel under the review's one concurrency limit; a blank diff runs no stage. The review
 * reports itself through events, from `run:start` to `run:end`, and its result merges the profiles'
 * verdicts and gaps in profile order. `meta.profiles[<id>].invalidFindings` and `meta.usage` are
 * counted from the events before the sink receives them.
 *
 * Abort never fails open. The review's signal joins the caller's `signal` to an internal one; every
 * stage and every call checks it, every request carries it, and it is checked once more after the
 * profiles have run, a blank diff included, so an aborted review rejects with the signal's reason,
 * whatever error a call it cut raised, and never resolves. No event is delivered once the review is
 * aborted. A sink that throws aborts the review with its error, and a research failure (the call or
 * its reply) aborts it with that failure where it fails, so no other profile starts a call after
 * it; any other failure aborts the review when the profiles' run rejects. Either way the review
 * rejects with the first reason. An abort after `run:end` has no effect: the review is over.
 *
 * @throws ConfigError listing every issue of the input and the options: an input that is not an object, a `diff` that is not a string, options that are not an object, a `signal` that is not an AbortSignal
 * @throws the signal's reason once the review is aborted, before it starts or while it runs
 * @throws the error of a sink that throws, or of a profile that fails: a ProviderError from its research call, an OutputError for its reply
 */
async function review(compiled: Compiled, input: { readonly diff: string }, options: ReviewOptions = {}): Promise<QuorumResult> {
  const issues = reviewIssues(input, options)
  if (issues.length > 0) throw new ConfigError(issues)
  options.signal?.throwIfAborted()
  const internal = new AbortController()
  const signal = options.signal === undefined ? internal.signal : AbortSignal.any([options.signal, internal.signal])
  const fail = (error: unknown): void => {
    if (!signal.aborted) internal.abort(error)
  }
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const { runs, sink } = compiled
  const tally: Tally = { invalidFindings: new Map() }
  const emit = (event: QuorumEvent): void => {
    if (signal.aborted) return
    if (event.type === 'call' && event.usage !== undefined) tally.usage = addUsage(tally.usage, event.usage)
    if (event.type === 'finding:invalid') tally.invalidFindings.set(event.profile, (tally.invalidFindings.get(event.profile) ?? 0) + 1)
    try {
      sink?.(event)
    } catch (error) {
      // The caller's bug surfaces instead of being swallowed, and ends the review: no profile starts another call.
      internal.abort(error)
      throw error
    }
  }
  const ctx: RunContext = { limit: createLimiter(compiled.concurrency), emit, signal, fail, maxFindings: compiled.maxFindings }
  emit({ type: 'run:start', profiles: runs.map(run => run.id), providers: Object.fromEntries(runs.map(run => [run.id, providersOf(run)])) })
  const outcomes = await reviewAll(ctx, runs, input.diff).catch((error: unknown) => {
    // A research failure aborted the review where it failed; any other failure aborts it here. The first reason stays the reason.
    const reason: unknown = signal.aborted ? signal.reason : error
    internal.abort(reason)
    throw reason
  })
  signal.throwIfAborted()
  const kept = outcomes.flatMap(outcome => outcome.kept)
  const discarded = outcomes.flatMap(outcome => outcome.discarded)
  const unreviewed = outcomes.flatMap(outcome => outcome.unreviewed)
  const incomplete = outcomes.flatMap(outcome => outcome.incomplete)
  const durationMs = elapsed(started)
  const meta: QuorumMeta = {
    version: packageJson.version,
    startedAt,
    durationMs,
    profiles: Object.fromEntries(runs.map(run => [run.id, profileMeta(run, tally.invalidFindings.get(run.id) ?? 0)])),
    ...(tally.usage === undefined ? {} : { usage: tally.usage }),
    incomplete,
  }
  emit({ type: 'run:end', kept: kept.length, discarded: discarded.length, unreviewed: unreviewed.length, incomplete: incomplete.length, durationMs })
  return { kept, discarded, unreviewed, meta }
}

/** Run every profile through its stages at once; a blank diff runs no stage. The diff is split once, for every profile. */
async function reviewAll(ctx: RunContext, runs: readonly ProfileRun[], diff: string): Promise<PanelOutcome[]> {
  if (diff.trim() === '') return []
  const sections = splitDiff(diff)
  return Promise.all(runs.map(run => reviewProfile(ctx, run, diff, sections)))
}

/** One profile's review: its panel's outcome, with the research gaps before the panel's own. */
async function reviewProfile(ctx: RunContext, run: ProfileRun, diff: string, sections: ReadonlyMap<string, string>): Promise<PanelOutcome> {
  const researched = await stage(ctx, run.id, 'research', () => research(ctx, run, diff, sections), outcome => outcome.findings.length)
  const candidates = await stage(ctx, run.id, 'dedup', () => dedup(researched.findings), found => found.length)
  const judged = await stage(ctx, run.id, 'panel', () => panel(ctx, run, candidates, sections, diff), outcome => outcome.kept.length + outcome.discarded.length + outcome.unreviewed.length)
  return { ...judged, incomplete: [...researched.incomplete, ...judged.incomplete] }
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

/** The usage of one more call added to a running total; `costUsd` is summed over the calls that reported one. */
function addUsage(total: Usage | undefined, call: Usage): Usage {
  const sum: Usage = { inputTokens: (total?.inputTokens ?? 0) + call.inputTokens, outputTokens: (total?.outputTokens ?? 0) + call.outputTokens }
  const costUsd = call.costUsd === undefined ? total?.costUsd : (total?.costUsd ?? 0) + call.costUsd
  if (costUsd !== undefined) sum.costUsd = costUsd
  return sum
}

/** Who reviews for a profile, as new objects the caller may keep or change: never the frozen refs of the run. */
function providersOf(run: ProfileRun): ProfileProviders {
  return { research: { ...run.research.ref }, lenses: Object.fromEntries(run.lenses.map(lens => [lens.id, { ...lens.ref }])) }
}

function profileMeta(run: ProfileRun, invalidFindings: number): ProfileMeta {
  return { providers: providersOf(run), policy: { ...run.thresholds }, gating: run.gating, invalidFindings }
}

/**
 * Compile a checked profile and its checked ports into the frozen run every review reads: the vote
 * template rendered once per lens, the thresholds resolved, `gating` true unless the profile says
 * otherwise, and each provider captured beside the `{ id, model }` ref events and meta report.
 */
function compile(profile: Profile, ports: ProfilePorts): ProfileRun {
  const panelSize = String(profile.lenses.length)
  const lenses = profile.lenses.map(lens => Object.freeze({
    id: lens.id,
    instructions: renderTemplate(profile.prompts.vote, { 'lens.id': lens.id, 'lens.question': lens.question, 'panel.size': panelSize }),
    ...target(ports.voters[lens.id]),
  }))
  return Object.freeze({
    id: profile.id,
    research: Object.freeze({ instructions: profile.prompts.research, ...target(ports.research) }),
    lenses: Object.freeze(lenses),
    thresholds: Object.freeze(thresholdsFor(profile)),
    gating: profile.gating ?? true,
    guidelines: profile.guidelines,
  })
}

function target(provider: Provider): Target {
  return { provider, ref: Object.freeze({ id: provider.id, model: provider.model }) }
}

/**
 * Every problem with the options and the ports, in this order: options and ports that are not
 * objects, `profiles`, each profile's own issues and repeated ids, the limits, then the ports.
 */
function inputIssues(options: unknown, ports: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!isRecord(options)) issues.push({ path: 'options', message: 'must be an object' })
  if (!isRecord(ports)) issues.push({ path: 'ports', message: 'must be an object' })
  if (!isRecord(options)) return issues
  if (!Array.isArray(options.profiles)) return [...issues, { path: 'profiles', message: 'must be an array of profiles' }, ...limitIssues(options)]
  // `Array.from` reads a hole as `undefined`, so it is reported like any other profile that is not an object.
  const profiles = profileListIssues(Array.from<unknown>(options.profiles))
  issues.push(...profiles.issues, ...limitIssues(options))
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
    const id = isRecord(profile) && typeof profile.id === 'string' ? profile.id : undefined
    if (id === undefined) return
    const repeated = named.has(id)
    if (repeated) issues.push({ path: `profiles.${index}.id`, message: `repeats the profile id ${JSON.stringify(id)}` })
    named.add(id)
    if (problems.length === 0 && !repeated) checked.push(profile as Profile)
  })
  return { issues, checked, named }
}

/** `concurrency` and `maxFindings` are positive integers when set. A number is quoted; anything else is described by the rule alone. */
function limitIssues(options: Record<string, unknown>): ConfigIssue[] {
  return LIMITS.flatMap((path) => {
    const value = options[path]
    if (value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1)) return []
    const got = typeof value === 'number' ? `, got ${value}` : ''
    return [{ path, message: `must be a positive integer${got}` }]
  })
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
  if (entry === undefined) return [{ path, message: 'is missing' }]
  if (!isRecord(entry)) return [{ path, message: 'must be an object with a research provider and voters' }]
  const issues = providerIssues(`${path}.research`, entry.research)
  const { voters } = entry
  if (voters === undefined) return [...issues, { path: `${path}.voters`, message: 'is missing' }]
  if (!isRecord(voters)) return [...issues, { path: `${path}.voters`, message: 'must be an object keyed by lens id' }]
  const lensIds = new Set(profile.lenses.map(lens => lens.id))
  for (const lens of profile.lenses) issues.push(...providerIssues(`${path}.voters.${lens.id}`, own(voters, lens.id)))
  for (const id of Object.keys(voters)) {
    if (!lensIds.has(id)) issues.push({ path: `${path}.voters.${id}`, message: 'names no lens of the profile' })
  }
  return issues
}

function providerIssues(path: string, value: unknown): ConfigIssue[] {
  if (value === undefined) return [{ path, message: 'is missing' }]
  return isProvider(value) ? [] : [{ path, message: PROVIDER_SHAPE }]
}

/** A provider is a non-null object with a string id, a string model and a complete function. */
function isProvider(value: unknown): value is Provider {
  return isRecord(value) && typeof value.id === 'string' && typeof value.model === 'string' && typeof value.complete === 'function'
}

/** What `record` holds under `key` as its own property: an id such as `constructor` never finds an inherited member. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
