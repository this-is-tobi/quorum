import { createAdaptations } from './adapt.ts'
import { VERSION } from './version.ts'
import { DEFAULT_MAX_FINDINGS, profileBudgets, roomIssues } from './budgets.ts'
import type { ProfileBudgets } from './budgets.ts'
import { systemClock } from './clock.ts'
import type { Clock } from './clock.ts'
import { createClocks } from './clocks.ts'
import { leftOutGaps, reviewScope } from './coverage.ts'
import type { ReviewScope } from './coverage.ts'
import { diffSections, splitDiff } from './diff.ts'
import { createHealth } from './down.ts'
import { contextTotalIssues, documentCommit, documentIssues, joined, profileTexts, withRepository } from './documents.ts'
import type { ProfileTexts } from './documents.ts'
import { ConfigError, issuePath } from './errors.ts'
import type { ConfigIssue, ProviderDownError } from './errors.ts'
import { estimateReview } from './estimate.ts'
import { excludeIssues, excludeMatcher } from './exclude.ts'
import { ruleTextBytes } from './rules.ts'
import { diffFlags, documentFlags, secretFlags } from './flags.ts'
import { leftOutIssues, mergeLeftOut, sendIssues, sourceIssues, sourceOf } from './inputs.ts'
import { createLanes, REVIEW_CEILING } from './lanes.ts'
import { createLedger, DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS, INTERRUPT_GRACE_MS, isLimitName, LimitError, limitGaps, maxReviewTokensProblem } from './limits.ts'
import { isRecord } from './output.ts'
import { coverageOf, DEFAULT_PART_TOKENS, partTokensProblem, tooLargeGap, withCapped } from './parts.ts'
import type { Packing, PartResult, UnreadPlace } from './parts.ts'
import { MAX_SERVED, settingsSchema } from './result-schema.ts'
import { adaptsProblem, MAX_STATED_TIMEOUT_MS, retriesProblem, slotsProblem, streamsProblem, thinkingProblem, timeoutProblem, tokensProblem } from './ports.ts'
import type { EventSink, ProfilePorts, Provider, QuorumPorts, ReplyStore } from './ports.ts'
import { failOnOf, positiveIntegerProblem, profileIssues, profileWarnings, thresholdsFor } from './profile.ts'
import { doNotReportInstructions, renderTemplate } from './prompts.ts'
import { ownData } from './facts.ts'
import { addUsage, asksNothing, elapsed, stage, targetOf, withSent } from './stages/context.ts'
import type { ProfileRun, RunContext } from './stages/context.ts'
import { dedup } from './stages/dedup.ts'
import { panel } from './stages/panel.ts'
import type { PanelOutcome } from './stages/panel.ts'
import { planResearch, research } from './stages/research.ts'
import type { ResearchPlan } from './stages/research.ts'
import type { ContextRecord, CoverageEntry, Estimate, Profile, ProfileMeta, ProfileProviders, ProviderCalls, Quorum, QuorumEvent, QuorumMeta, QuorumOptions, QuorumResult, ResearchRecord, ReviewContext, ReviewDocument, ReviewInput, ReviewSource, RoleCalls, Usage } from './types.ts'

const PROVIDER_SHAPE = 'must be a provider: an object with a string id, a string model and a complete function'

/** What a profile's research counts when no stage ran: a blank diff has no part, no finding and no vote. */
const NO_RESEARCH: ResearchRecord = Object.freeze({
  parts: 0,
  listed: 0,
  panel: 0,
  capped: 0,
  saturated: 0,
})

/** The options that must be positive integers when they are set. */
const LIMITS = ['concurrency', 'maxFindings', 'findingsCap'] as const

/** What createQuorum compiled: the frozen runs and settings every review of the quorum reads. */
interface Compiled {
  readonly runs: readonly ProfileRun[]
  /** The review's `concurrency`, or none: each provider then has a lane. */
  readonly concurrency: number | undefined
  /** The findings each research request asks for at most, for a profile that sets none of its own (`ProfileRun.maxFindings`): the review's `Estimate.maxFindings`, and `findingsCap`'s default. */
  readonly maxFindings: number
  /** The most findings of the research each profile sends to its panel in a review that gives no cap of its own: the quorum's `findingsCap`, else `maxFindings`. */
  readonly findingsCap: number
  /** The most tokens one review spends: each review gets a ledger of this cap. */
  readonly maxReviewTokens: number
  /** How long one review runs, in milliseconds: each review arms a deadline of this length on `clock`. */
  readonly reviewTimeoutMs: number
  /** The most tokens of diff text one research part holds. */
  readonly partTokens: number
  /** The reply budgets of each profile at its providers' stated windows, by profile id, computed once. */
  readonly budgets: Readonly<Record<string, ProfileBudgets>>
  /** The bytes the cleaned rule texts of each profile take as it was compiled, by profile id, computed once: where the rules of a review's repository documents are counted from. */
  readonly heldRules: ReadonlyMap<string, number>
  /** The time and the randomness every review reads: the system's, unless a spec injects its own through `createQuorumWith`. */
  readonly clock: Clock
  /** Whether a file's path is left out of every request, built once from `exclude`. */
  readonly excluded: (path: string) => boolean
  readonly sink: EventSink | undefined
}

/** What one review takes besides its input: the signal that aborts it, the one that interrupts it, the store it keeps its calls in, and the token cap and the deadline it keeps to in place of the quorum's. */
type ReviewOptions = NonNullable<Parameters<Quorum['review']>[1]>

/** What an estimate takes of a review's input: the diff, and the files it sends though they are held back. */
type EstimateInput = Parameters<Quorum['estimate']>[0]

/** The cap and the deadline an estimate is made under, in place of the quorum's. */
type EstimateLimits = NonNullable<Parameters<Quorum['estimate']>[1]>

/** What a review counts from its own events, so its meta and its events cannot disagree. */
interface Tally {
  usage?: Usage
  readonly invalidFindings: Map<string, number>
  /** The citations that failed their check, from the `finding:invalid` events whose cause is `rule`, apart from the findings outside the diff. */
  readonly invalidRules: Map<string, number>
  /** The research calls and the votes a store answered, counted from the `call` events that say `reused`. */
  readonly reused: { research: number, votes: number }
  /** What each provider's calls came to, by provider id in the order its first call ended: the models its replies named and its roles' counts, counted from the `call` events (`countCall`). */
  readonly calls: Map<string, ProviderCalls>
  /** The `durationMs` of each profile's `stage:end` events, by profile id, in the order they ended. */
  readonly stages: Map<string, ProfileMeta['stages']>
}

/**
 * Counts a `call` event into its provider's record, which the provider's first event makes, with the `model` its `ProviderRef`
 * holds, no served model and no role: an answered call adds one to the model its reply named, one that names a ninth model or a
 * later one adds one to `servedOthers`, and a call that named none (a failed one, one the store answered) adds none; and every
 * call is counted in the record of its role (`countRole`).
 */
function countCall(calls: Map<string, ProviderCalls>, event: Extract<QuorumEvent, { type: 'call' }>): void {
  const { provider, model } = event
  const record = calls.get(provider.id) ?? { model: provider.model, served: [] }
  calls.set(provider.id, record)
  if (model !== undefined) countServed(record, model)
  const role = event.role === 'research'
    ? 'research'
    : 'vote'
  record[role] = countRole(record[role] ?? {
    calls: 0,
    failed: {},
    stopped: 0,
    retried: 0,
    reused: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    callMs: { total: 0, longest: 0 },
  }, event)
}

/** Adds one answered call to the served model `model` of `record`, or to `servedOthers` once `record` lists `MAX_SERVED` of them. */
function countServed(record: ProviderCalls, model: string): void {
  const named = record.served.find(served => served.model === model)
  if (named !== undefined) {
    named.calls += 1
  } else if (record.served.length < MAX_SERVED) {
    record.served.push({ model, calls: 1 })
  } else {
    record.servedOthers = (record.servedOthers ?? 0) + 1
  }
}

/**
 * Adds a `call` event to a role's record: the call, its failure by `kind` when it names one (a failed call's and an unreadable
 * reply's), a failed call that names none as stopped (a limit or the stop ended it), the sends beyond its first, a call the store
 * answered as reused, its usage and its time. The record it is given, changed.
 */
function countRole(role: RoleCalls, event: Extract<QuorumEvent, { type: 'call' }>): RoleCalls {
  role.calls += 1
  if (event.failure !== undefined) {
    role.failed[event.failure.kind] = (role.failed[event.failure.kind] ?? 0) + 1
  } else if (!event.ok) {
    role.stopped += 1
  }
  role.retried += (event.attempts ?? 1) - 1
  if (event.reused === true) role.reused += 1
  role.usage = addUsage(role.usage, event.usage) ?? role.usage
  role.callMs.total += event.durationMs
  role.callMs.longest = Math.max(role.callMs.longest, event.durationMs)
  return role
}

/** The providers' records as `meta.calls` holds them: copies, their keys in the order the schema reads them, so the tally and the result share nothing. */
function callsRecord(calls: ReadonlyMap<string, ProviderCalls>): QuorumMeta['calls'] {
  return Object.fromEntries([...calls].map(([id, { model, served, servedOthers, research, vote }]) => [
    id,
    structuredClone({
      model,
      served,
      ...servedOthers === undefined
        ? {}
        : { servedOthers },
      ...research === undefined
        ? {}
        : { research },
      ...vote === undefined
        ? {}
        : { vote },
    }),
  ]))
}

/**
 * Build a quorum: check every input up front, compile each profile once, and return the `review`
 * that runs them all on a diff.
 *
 * Every problem is reported at once, in one ConfigError, never as a TypeError, so an untyped caller
 * gets the checks a config file gets: options and ports that are not objects, no profile, each
 * profile's own issues, a repeated profile id, a `concurrency`, `maxFindings` or `findingsCap` that is not a
 * positive integer, a `maxReviewTokens` that is not a whole number of tokens from 1 to
 * 9007199254740991, a `reviewTimeoutMs` that is not a whole number of milliseconds from 1000 to
 * 86400000, a `partTokens` that is not a whole number of tokens from 1024 to 9007199254740991, an
 * `exclude` that is not a list of at most 100 patterns that can be taken, a missing or malformed
 * research provider or voter, a provider's stated `timeoutMs` that is not a
 * whole number of milliseconds from 1000 to 518400000, a `stallTimeoutMs` that is not one from 1000 to 86400000,
 * a `streams` that is not `true`, a `slots` that is not a whole number of at least 1, `retries` that is not a whole number from
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
 * sink stops it too.
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
  const settings = {
    maxFindings: options.maxFindings ?? DEFAULT_MAX_FINDINGS,
    maxReviewTokens: options.maxReviewTokens ?? DEFAULT_MAX_REVIEW_TOKENS,
    partTokens: options.partTokens ?? DEFAULT_PART_TOKENS,
  }
  // The checks found every profile valid and named once, with an own entry in ports.profiles and an own voter per lens.
  const runs = Object.freeze(options.profiles.map(profile => compile(profile, ports.profiles[profile.id], settings.maxFindings)))
  const budgets: Readonly<Record<string, ProfileBudgets>> = Object.freeze(Object.fromEntries(runs.map(run => [
    run.id,
    profileBudgets(run, target => target.window, settings),
  ])))
  const room = runs.flatMap(run => roomIssues(run.id, budgets[run.id], run, run.maxFindings))
  if (room.length > 0) throw new ConfigError(room)
  const compiled: Compiled = {
    runs,
    concurrency: options.concurrency,
    ...settings,
    findingsCap: options.findingsCap ?? settings.maxFindings,
    budgets,
    heldRules: new Map(runs.map(run => [run.id, ruleTextBytes(run.texts.rules) ?? 0])),
    reviewTimeoutMs: options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    clock,
    excluded: excludeMatcher(options.exclude ?? []),
    sink: ports.events,
  }
  const warnings: readonly string[] = Object.freeze(options.profiles.flatMap(profile => profileWarnings(profile)))
  return Object.freeze({
    review: (input: ReviewInput, options?: ReviewOptions) => review(compiled, input, options),
    estimate: (input: EstimateInput, limits?: EstimateLimits) => estimate(compiled, input, limits),
    warnings,
    budgets,
  })
}

/**
 * What one review of `input.diff` may cost, before any call: no provider is called and nothing is read or
 * written. Per profile, it states what the review's ledger reserves for each research part, in order, exactly
 * as `review` plans and builds them (the diff less the sections `exclude` leaves out, parted on each research
 * provider's stated room), and a bound for the votes: `findingsCap` votes of each lens, each at the request for
 * a finding at its longest citing the largest section of the filtered diff. `expected` counts the research
 * parts alone, each at a third of its reservation, rounded up (`BOUND_OVER_CODE`), and `worst` the parts in full
 * and every vote at its bound, so the votes are in the worst case only. `inFlight` is what the calls that run
 * at once reserve, the `concurrency` largest bounds among all the profiles' calls, and `fits` is whether
 * `expected` and `inFlight` are within `maxReviewTokens`. A diff with nothing left to read, blank or whose every
 * file is excluded or held back as a secret, makes no call and costs nothing; a file `input.send` names is not
 * held back, so it is counted, as `review` sends it. It is an estimate, not a limit: a review reserves each call
 * against the cap, which still holds whatever `fits` says.
 *
 * `limits` are the cap, the deadline and the findings cap of the review the estimate is for, in place of the quorum's, and the
 * estimate's `maxReviewTokens`, `reviewTimeoutMs`, `fits` and `held` read the first two; `findingsCap` counts each lens's votes,
 * so it moves `findingsCap`, each profile's `votes` and `worst`, `inFlight` and what `fits` and `held` read of it, and no request,
 * part or `expected` figure, as `maxFindings` sizes them. `held` counts the research parts the cap holds.
 *
 * `input.context` is the review's repository documents, each sent with the profile it names after the profile's own and its
 * config documents, so the estimate counts them in each part's reservation and each vote's bound as `review` sends them. An
 * estimate names no source, so it checks no document's commit.
 *
 * @throws ConfigError listing every issue of the input that `review` refuses: an input that is not an object, a `diff` that is not a string, a `source`, a `settings` that is no record `reviewSettings` builds, a `leftOut`, a `send` or a `context` it cannot take, repository documents that leave a research provider less than 1024 tokens of diff or take a profile's texts over their caps; and of the `limits`: a `maxReviewTokens` or a `reviewTimeoutMs` out of range, a `findingsCap` that is no positive integer
 */
function estimate(compiled: Compiled, input: EstimateInput, limits: EstimateLimits = {}): Estimate {
  const issues = [
    ...reviewIssues(input, {}, new Set(compiled.runs.map(run => run.id)), false, compiled.heldRules),
    ...isRecord(limits)
      ? [
          ...reviewLimitIssues(limits),
          ...findingsCapIssues(limits),
        ]
      : [
          { path: 'limits', message: 'must be an object' },
        ],
  ]
  if (issues.length > 0) throw new ConfigError(issues)
  const sent = new Set(input.send)
  const { runs } = reviewRuns(compiled, input.context)
  return estimateReview(runs, {
    ...compiled,
    maxReviewTokens: limits.maxReviewTokens ?? compiled.maxReviewTokens,
    reviewTimeoutMs: limits.reviewTimeoutMs ?? compiled.reviewTimeoutMs,
    findingsCap: limits.findingsCap ?? compiled.findingsCap,
  }, input.diff, path => sent.has(path))
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
 * flag, as many as `meta.leftOut` lists, ahead of the diff's flags and whatever the diff is. A section of the
 * whole diff that edits, renames, copies, adds or deletes the path of a repository document of `context` raises
 * one `guideline-edited` flag for each profile and path, after the diff's flags, naming the profile and the
 * commit the review read the document from instead; a path review raises none.
 * Everything it knows before a call is sent in this order: `run:start`, then a `left-out` event naming those files when it leaves one
 * out, then a `context` event holding `meta.context` when a profile has a document, then the gaps' `incomplete` events (each profile's `binary`, `submodule` and `secret` gaps, then its
 * `too-large` gap), then the `flag` events of the advisory flags, the `secret-file` flags first and the
 * `guideline-edited` flags last, kept in `meta.flags`, none of which changes a verdict, then the stages. Each event is handed to the sink
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
 * that throws aborts the review with its error, and any other failure that is no gap aborts it when the
 * profiles' run rejects; either way the review rejects with the first reason. A research part that fails,
 * its call or its reply, is its profile's `research-failed` gap, a gating profile's included, and aborts
 * nothing. An abort after `run:end` has no effect: the review is over.
 *
 * A provider is called no more once three of its calls in a row failed for a reason of its own (see
 * `createHealth`), across the profiles and roles that share it: the calls in flight run to their end and
 * their replies are read, and the parts and votes it was never sent are `provider-down` gaps, exit 4. The
 * review rejects with a `ProviderDownError`, exit 3, only when no part of any profile was reviewed: with the
 * error of the first research provider, in profile order, that was found down, else of the first whose every
 * call failed for a reason of its own, though fewer than three did.
 *
 * A provider that states it can (`Provider.adapts`, which the shipped adapters state unless an option sets the
 * setting or `extraBody` sets its control) has settings quorum moves by itself, once per review, so every
 * review starts from the provider's own: `thinking` is lowered when a reply ran out of room while reasoning or held
 * only reasoning, and `structuredOutput` moves from `json` to `prompt` when a reply in JSON mode was empty or the
 * server refused the mode. A third, `stream`, steps down for a provider that streams (`adapts.stream`): to a stream with
 * no stream options when the server refused them, to whole replies when it refused streaming (each step probed once, as the
 * others are), and to whole replies at once, with no probe, when it answered a streamed call whole. The first call whose failure a setting answers is its probe (see `createAdaptations`):
 * it is sent once more with the new setting while the provider's other calls in flight keep the old one and its
 * new calls wait, and each call in flight that fails the same way is then sent once more at the settled setting,
 * so no vote fails and no research part splits for a setting the review has already moved. Each move is one
 * `adapted` event and one entry of `meta.adaptations`; a lowering the server refuses is recorded as
 * `lowering-refused` and thinking stays as the server sets it. A lowering that fails after a cut-off in a way that
 * shows nothing of the server's level (a network failure, a 429, a 401, a 500, 502 or 503) moves nothing and
 * records nothing, and the part splits. A research reply that shows no reasoning makes
 * that provider's later research requests ask for more findings.
 *
 * With `options.store`, a `ReplyStore`, the review keeps what it paid for and finds it again on a rerun: each research
 * call whose reply passed its envelope check and each vote that parsed is saved as it completes, and a research reply that
 * was cut off or listed as many findings as it was asked for at most as a marker that sends its part straight to
 * recovery; a failed call is never saved. Each send is looked up under a key of the request as it is sent (see
 * `callProvider`), a stored reply is checked as a fresh one and is the answer only if it passes, and it spends nothing: no
 * reservation, no usage, a `call` event that says `reused`. `meta.reused` counts the research calls and the votes reused,
 * and is present whenever a store was given. A store that throws, rejects or answers what is no stored call is a miss.
 *
 * A review ends at its deadline, `reviewTimeoutMs` after it starts, with an answer: at it every call in
 * flight and every wait is stopped at once, no call still queued starts, and what was not done is a
 * `review-deadline` gap of its profile, its research request (the parts of it not yet answered) or its
 * votes, each a failed vote of the deadline. The review then resolves with its findings so far, exiting
 * `4` for a gating profile whatever the flags; the deadline is no abort, so an abort still rejects
 * with its reason, before the deadline or after it, and a review that reaches its deadline is never a
 * failed run. The deadline's timer is armed once the input checks pass and cleared however the review
 * ends: it resolves, it rejects, its sink throws or it is aborted.
 *
 * `options.interrupt` is the first Ctrl-C or SIGTERM of a person, a gentler stop than the abort, which it leaves as it
 * is: once it aborts, or at once when it was aborted already, no new call starts and every wait ends (a call queued
 * behind a call in flight, waiting for room under the cap or backing off after a failure ends at once, sending none
 * of it), one `run:stopping` event with the cause `interrupt` says how many calls are in flight and the grace
 * (`INTERRUPT_GRACE_MS`, 5000 ms on the review's clock) they have to end, and a call that ends within it is read and
 * saved as in any review. At the end of the grace the calls still in flight are cancelled. The review then rejects as
 * any review does, on an abort, on a sink's error, or with `ProviderDownError` when nothing was read and a provider was
 * found down, and otherwise resolves with what it read: the research parts and the votes the interrupt stopped are an
 * `interrupted` gap of their profile, its files unreviewed and its findings unreviewed with `interrupted` votes, which
 * `allowIncomplete` never lifts and `outcome` reads as exit 130. The timer and the listener go however the review ends,
 * and an abort during the grace still rejects with its reason.
 *
 * A change larger than one research request is researched in parts, not refused. Each profile's research
 * is planned once the scope is known, on its own research provider's stated room: a provider that
 * states none, or a diff within `partTokens` and within the room, is sent the whole diff in one request,
 * as it always was; else the filtered diff's sections, in order, are packed into parts of at most
 * `partTokens` whose request fits the room, a section too large for a part split between its hunks and
 * a hunk never cut. Each part is a research call, in order, up to 15 when recovery splits it, that names its position and the change's
 * files; the replies are read in turn, each one's first findings before any one's second, up to the finding cap (`findingsCap`) in all, each
 * checked against the whole diff. A hunk, or a section with no hunk, that fits in no research part of the window is no part's:
 * the profile records one `too-large` gap for them before any call is sent, which no flag lifts for a
 * gating profile. `meta.profiles.<id>.coverage` lists every file of the input diff once, in its order,
 * with how much of it the profile's research reviewed: reviewed, partly (with the ranges left), not
 * (with the reason), or excluded by `exclude`; each profile has its own, since each has its own
 * research model. A file is reviewed when no research part of it failed or was left unsent and no finding a reply listed on it,
 * among the findings each reply was asked for after its last one read, was left unread by the finding cap: a file such a finding names, at a line the diff
 * shows, is partly reviewed, with ranges of the reason `findings-capped` (see `withCapped`).
 *
 * A review spends at most `maxReviewTokens` tokens. Each review has its own ledger of that cap: every
 * attempt of every call reserves its worst case in it before it is sent and settles at what it spent,
 * so concurrent calls cannot overshoot it. A call the cap stops is no failed review: its profile's
 * research or vote is a `token-cap` gap, which exits 4 for a gating profile, and the other profiles
 * and votes run as far as the cap lets them. A research in parts spends up to the cap, each part reserved
 * before it is sent: the parts the cap cannot fund are not sent, and one gap counts them.
 *
 * `options.maxReviewTokens` and `options.reviewTimeoutMs` are the cap and the deadline of this review alone, in place of
 * the quorum's, and are checked as the quorum's are: a caller that knows the size of its input gives its review the
 * cap and the deadline that fit it, and the reviews that give none keep the quorum's. The gaps, the events and `meta`
 * read the limits the review kept to. `options.findingsCap` is the most findings of the research each profile sends to its
 * panel in this review, the quorum's `findingsCap` unless set, which is `maxFindings` unless set: every research request is still sized
 * by `maxFindings`, so a larger `findingsCap` changes no request and splits no reply, and the findings past it are one `findings-capped` gap.
 *
 * `input.settings` is what the review ran under, which the core cannot know: a caller builds it (`reviewSettings` does, from a config), and
 * the review checks it against the schema of a result (`settingsSchema`), refuses one that does not match, before any call, with
 * the path of the first field and no value, and records a copy, made before the first await, in `meta.settings`: `null` when none is given.
 *
 * Each profile reads documents as policy: its own `guidelines` and `doNotReport`, its `documents`, then the repository documents
 * of `input.context` that name it, each cleaned (`cleanProse`), capped and joined with the others of its kind in that order by a
 * blank line. The joined guidelines are a block of every request of the profile, the joined do-not-report text a paragraph of the
 * research system message alone, right after the instructions. `meta.context` records each document, never its text, and one
 * `context` event says the same. A profile the context gives no document keeps the run it was compiled to.
 *
 * A profile may also list review rules (`Profile.rules`, its `documents` of kind `rules` and the repository's), and each
 * research request of such a profile carries the rules whose `paths` match a file of the review's filtered diff, the same block
 * in every part, after the diff and before the guidelines, and asks for a sixth field of each finding, `rule`. A rule without
 * `paths` applies to every file. A profile that lists none sends its requests as it always did.
 *
 * Once a finding is anchored, the rule it cites is checked by code (`checkCitations`): a rule the review sent whose `paths` match the
 * finding's file stays, as the configuration's id, and its voters read that rule's block, after the diff and before the guidelines; any
 * other citation is dropped, the finding with it when `Profile.requireRule` holds, and so is a finding that cites none then. Each is
 * a `finding:invalid` event of cause `rule` and counted in `meta.profiles.<id>.invalidRules`, apart from `invalidFindings`, which
 * counts the findings outside the diff; a reply whose finding cites a wrong rule is read, and sent once more never. A profile that
 * requires a rule and sends none asks its research nothing: it makes no call, reads every part `reviewed` and says `parts: 0`.
 * `meta.profiles.<id>.rules` records how many rules the profile lists and how many the review sent, and the `context` event holds the
 * same for each profile that lists one.
 *
 * @throws ConfigError listing every issue of the input and the options: an input that is not an object, a `diff` that is not a string, a `source`, a `settings` that is no record `reviewSettings` builds, a `leftOut`, a `send` or a `context` it cannot take (a repository document of a profile the quorum lacks, of another origin, at a commit the source does not read documents from, of a `diff` source, over its cap once cleaned or too deep to clean), repository documents that leave a research provider less than 1024 tokens of diff, options that are not an object, a `signal` that is not an AbortSignal, a `store` that is no object with a `get` and a `put` function, a `maxReviewTokens` or a `reviewTimeoutMs` out of range, a `findingsCap` that is no positive integer
 * @throws the signal's reason once the review is aborted, before it starts or while it runs
 * @throws the error of a sink that throws
 * @throws ProviderDownError when no research call of any profile answered and a research provider was found down, or each of whose calls failed for a reason of its own
 */
async function review(compiled: Compiled, input: ReviewInput, options: ReviewOptions = {}): Promise<QuorumResult> {
  const issues = reviewIssues(input, options, new Set(compiled.runs.map(run => run.id)), true, compiled.heldRules)
  if (issues.length > 0) throw new ConfigError(issues)
  const reviewed = reviewRuns(compiled, input.context)
  options.signal?.throwIfAborted()
  const { clock } = compiled
  const reviewTimeoutMs = options.reviewTimeoutMs ?? compiled.reviewTimeoutMs
  const deadline = { at: clock.now() + reviewTimeoutMs, ms: reviewTimeoutMs }
  const expired = new AbortController()
  const cancel = clock.timer(reviewTimeoutMs, () => {
    expired.abort(new LimitError('review-deadline', `the review reached its deadline of ${reviewTimeoutMs} ms`))
  })
  const interrupt = armInterrupt(options.interrupt, clock)
  try {
    return await reviewUntil(compiled, reviewed, input, options, deadline, expired.signal, interrupt)
  } finally {
    cancel()
    interrupt.release()
  }
}

/** What the interrupt of a review comes to: the signal that stops new calls and waits, the one that ends the calls in flight once the grace has run out, and the way to let both go. */
interface Interrupt {
  readonly stop: AbortSignal
  readonly halt: AbortSignal
  readonly release: () => void
}

/**
 * Arm the interrupt of a review on `source`, the caller's `interrupt`: at its abort, or at once when it is aborted
 * already, `stop` aborts with a `LimitError` of the limit `interrupted`, and a timer of `INTERRUPT_GRACE_MS` on the
 * review's clock aborts `halt` with the same one. `release` removes the listener and cancels the timer, whichever
 * way the review ends, and is safe to call more than once.
 */
function armInterrupt(source: AbortSignal | undefined, clock: Clock): Interrupt {
  const stop = new AbortController()
  const halt = new AbortController()
  let cancel = (): void => {}
  const fire = (): void => {
    const reason = new LimitError('interrupted', 'the review was interrupted')
    stop.abort(reason)
    cancel = clock.timer(INTERRUPT_GRACE_MS, () => halt.abort(reason))
  }
  if (source?.aborted === true) {
    fire()
  } else {
    source?.addEventListener('abort', fire, { once: true })
  }
  return {
    stop: stop.signal,
    halt: halt.signal,
    release: () => {
      source?.removeEventListener('abort', fire)
      cancel()
    },
  }
}

/**
 * What `review` does once its deadline and its interrupt are armed: everything from its signals to its result, with
 * `expired`, the deadline's own signal, and the interrupt's joined to the review's into the `stop` and the `halt` the
 * call path reads.
 */
async function reviewUntil(compiled: Compiled, reviewed: Reviewed, input: ReviewInput, options: ReviewOptions, deadline: RunContext['deadline'], expired: AbortSignal, interrupt: Interrupt): Promise<QuorumResult> {
  const internal = new AbortController()
  const signal = options.signal === undefined
    ? internal.signal
    : AbortSignal.any([options.signal, internal.signal])
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const { sink } = compiled
  const { record } = reviewed
  const whole = input.diff.trim() === ''
    ? undefined
    : splitDiff(input.diff)
  // Copied before the first await, so the caller's later changes to its input reach neither the result nor the events.
  const sent = new Set(input.send)
  const source = sourceOf(input.source)
  // A copy of the record `reviewIssues` checked: the caller's later changes reach neither the result nor the events.
  const settings = input.settings === undefined
    ? null
    : structuredClone(settingsSchema.parse(input.settings))
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
    ...documentFlags(input.diff, input.context?.documents ?? [], source),
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
  // Each profile that lists rules sends those whose paths match a file of the filtered diff, once for the whole review.
  const runs = reviewed.runs.map(run => withSent(run, filtered))
  const plans = sections === undefined
    ? []
    : runs.map(run => planResearch(run, scope.diff, filtered, { partTokens: compiled.partTokens, maxFindings: run.maxFindings, replyTokens: compiled.budgets[run.id].research.replyTokens }))
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
    invalidRules: new Map(),
    reused: { research: 0, votes: 0 },
    calls: new Map(),
    stages: new Map(),
  }
  const emit = (event: QuorumEvent): void => {
    if (signal.aborted) return
    if (event.type === 'stage:end') {
      tally.stages.set(event.profile, {
        ...tally.stages.get(event.profile),
        [event.stage]: event.durationMs,
      })
    }
    if (event.type === 'call') countCall(tally.calls, event)
    if (event.type === 'call' && event.usage !== undefined) tally.usage = addUsage(tally.usage, event.usage)
    if (event.type === 'call' && event.reused === true) {
      tally.reused[event.role === 'research'
        ? 'research'
        : 'votes'] += 1
    }
    if (event.type === 'finding:invalid') {
      const counts = event.cause === 'rule'
        ? tally.invalidRules
        : tally.invalidFindings
      counts.set(event.profile, (counts.get(event.profile) ?? 0) + 1)
    }
    try {
      sink?.(structuredClone(event))
    } catch (error) {
      // The caller's bug surfaces instead of being swallowed, and ends the review: no profile starts another call.
      internal.abort(error)
      throw error
    }
  }
  const ctx: RunContext = {
    lanes: createLanes({
      ...compiled.concurrency === undefined
        ? {}
        : { concurrency: compiled.concurrency },
      clock: compiled.clock,
      emit,
    }),
    ledger: createLedger(options.maxReviewTokens ?? compiled.maxReviewTokens),
    emit,
    signal,
    stop: AbortSignal.any([signal, expired, interrupt.stop]),
    halt: AbortSignal.any([signal, expired, interrupt.halt]),
    deadline,
    health: createHealth(),
    lacked: new Set(),
    storedRefused: new Set(),
    ...options.store === undefined
      ? {}
      : { store: options.store },
    adapt: createAdaptations(),
    findingsCap: options.findingsCap ?? compiled.findingsCap,
    budgets: compiled.budgets,
    concurrency: compiled.concurrency ?? REVIEW_CEILING,
    clocks: createClocks(),
    clock: compiled.clock,
    calls: { last: 0 },
    flying: { count: 0 },
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
  const rules = ruleCounts(runs)
  if (record.documents.length > 0 || rules !== undefined) {
    emit({
      type: 'context',
      context: record,
      ...rules === undefined
        ? {}
        : { rules },
    })
  }
  for (const run of runs) {
    for (const entry of gaps.get(run.id) ?? []) emit({ type: 'incomplete', entry })
  }
  for (const flag of flags) emit({ type: 'flag', flag })
  let stopped = false
  const stopping = (cause: 'interrupt' | 'review-deadline'): void => {
    if (stopped) return
    stopped = true
    try {
      emit({
        type: 'run:stopping',
        cause,
        inFlight: ctx.flying.count,
        ...cause === 'interrupt'
          ? { graceMs: INTERRUPT_GRACE_MS }
          : {},
      })
    } catch {
      // A sink that throws has aborted the review, which rejects with its error: a listener must not throw it a second time.
    }
  }
  const onExpired = (): void => stopping('review-deadline')
  const onInterrupt = (): void => stopping('interrupt')
  // Only while the stages run: neither limit's signal ends the attempts at once (the deadline's own fires first, the interrupt's grace follows), so the attempts they stop are still counted in flight.
  expired.addEventListener('abort', onExpired, { once: true })
  interrupt.stop.addEventListener('abort', onInterrupt, { once: true })
  // An interrupt that came before the stages ran stops nothing in flight, and is said all the same.
  if (interrupt.stop.aborted) onInterrupt()
  const outcomes = await reviewAll(ctx, runs, plans, scope.diff, sections).catch((error: unknown) => {
    // A failure that is no gap (a sink's error, a bug) aborts the review here. The first reason stays the reason.
    const reason: unknown = signal.aborted ? signal.reason : error
    internal.abort(reason)
    throw reason
  }).finally(() => {
    expired.removeEventListener('abort', onExpired)
    interrupt.stop.removeEventListener('abort', onInterrupt)
  })
  signal.throwIfAborted()
  const down = nothingAnswered(ctx, runs, outcomes)
  if (down !== undefined) throw down
  const kept = outcomes.flatMap(outcome => outcome.kept)
  const discarded = outcomes.flatMap(outcome => outcome.discarded)
  const unreviewed = outcomes.flatMap(outcome => outcome.unreviewed)
  const incomplete = runs.flatMap((run, index) => [
    ...gaps.get(run.id) ?? [],
    ...outcomes[index]?.incomplete ?? [],
  ])
  const durationMs = elapsed(started)
  const lanes = ctx.lanes.record()
  const meta: QuorumMeta = {
    version: VERSION,
    startedAt,
    durationMs,
    source,
    settings,
    profiles: Object.fromEntries(runs.map((run, index) => [
      run.id,
      profileMeta(run, tally.invalidFindings.get(run.id) ?? 0, tally.invalidRules.get(run.id) ?? 0, outcomes[index]?.research ?? NO_RESEARCH, tally.stages.get(run.id) ?? {}, withCapped(coverageOf(scope, filtered, outcomes[index]?.packing ?? plans[index]?.packing, outcomes[index]?.parts ?? []), outcomes[index]?.unread ?? []), outcomes[index]?.recovery),
    ])),
    ...(tally.usage === undefined
      ? {}
      : { usage: tally.usage }),
    calls: callsRecord(tally.calls),
    incomplete,
    leftOut,
    flags,
    context: record,
    adaptations: [
      ...ctx.adapt.record(),
    ],
    ...options.store === undefined
      ? {}
      : {
          reused: { ...tally.reused },
        },
    ...Object.keys(lanes).length === 0
      ? {}
      : {
          concurrency: { ...lanes },
        },
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

/**
 * The error a review that read nothing rejects with, or `undefined` when it resolves: when no part of any
 * profile was `reviewed`, the `ProviderDownError` of the first research provider, in profile order, that was
 * found down, else of the first whose every call failed for a reason of its own and that made fewer than
 * three (`health.spent`). A review that read nothing for any other reason, refusals or limits, or that ran no
 * research, resolves with its gaps.
 */
function nothingAnswered(ctx: RunContext, runs: readonly ProfileRun[], outcomes: readonly ProfileOutcome[]): ProviderDownError | undefined {
  if (outcomes.length === 0 || outcomes.some(outcome => outcome.parts.some(isReviewed))) return undefined
  const { health } = ctx
  const down = runs.map(run => health.refused(run.research.provider)).find(error => error !== undefined)
  return down ?? runs.map(run => health.spent(run.research.provider, run.research.ref.id)).find(error => error !== undefined)
}

/** Whether a part was answered: it was `reviewed`, or one of the pieces recovery split it into was. */
function isReviewed(part: PartResult): boolean {
  return typeof part === 'string'
    ? part === 'reviewed'
    : part.pieces.some(({ outcome }) => outcome === 'reviewed')
}

/** The limit that stopped a part, for `limitGaps`: its own outcome, or the first limit among its pieces' (the part's later pieces were stopped by it), else what it was read as. */
function limitOf(part: PartResult): string {
  if (typeof part === 'string') return part
  return part.pieces.find(({ outcome }) => isLimitName(outcome))?.outcome ?? 'reviewed'
}

/** What a profile's review comes to: its panel's outcome, and what became of each part of its research, the places the cap left unread, its research counts, and the packing and recovery counts the coverage and the meta read. */
interface ProfileOutcome extends PanelOutcome {
  readonly parts: readonly PartResult[]
  readonly unread: readonly UnreadPlace[]
  readonly research: ResearchRecord
  readonly packing?: Packing
  readonly recovery?: ProfileMeta['recovery']
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
  // A profile that asks its research nothing has no part to read: its research makes no call.
  const parts = asksNothing(run)
    ? 0
    : plan.packing?.parts.length ?? 1
  const researched = await stage(ctx, run.id, 'research', () => research(ctx, run, plan, diff, sections), outcome => outcome.findings.length, { parts })
  const candidates = await stage(ctx, run.id, 'dedup', () => dedup(researched.findings), found => found.length)
  const judged = await stage(ctx, run.id, 'panel', () => panel(ctx, run, candidates, sections, diff), outcome => outcome.kept.length + outcome.discarded.length + outcome.unreviewed.length, { votes: candidates.length * run.lenses.length })
  const limits = limitGaps(run.id, researched.parts.map(limitOf), [
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
    unread: researched.unread,
    research: {
      parts,
      listed: researched.counts.listed,
      panel: candidates.length,
      capped: researched.counts.capped,
      saturated: researched.counts.saturated,
    },
    ...researched.packing === undefined
      ? {}
      : { packing: researched.packing },
    ...researched.recovery === undefined
      ? {}
      : { recovery: researched.recovery },
  }
}

/**
 * Every problem with one review's input and options, so an untyped caller gets issues, never a
 * TypeError. An input that is not an object is named as the input, not as its diff: the likely
 * mistake is the diff text passed on its own, as `runQuorum` takes it. The `source`, the `leftOut`, the
 * `send` and the `context`, when set, are checked after the diff, so a caller sees every issue of the input at once. The
 * context's documents must name one of `profiles` and, when `commit` is set, the commit the source reads documents from, as
 * `documentCommit` says: a source that is itself refused names none to check against. The `held` bytes are what the rules of
 * each profile take as it was compiled, which the rules of a context's documents are counted after. The signal
 * and the interrupt must be real AbortSignals: `AbortSignal.any` accepts nothing else.
 */
function reviewIssues(input: unknown, options: unknown, profiles: ReadonlySet<string>, commit: boolean, held: ReadonlyMap<string, number>): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!isRecord(input)) {
    issues.push({ path: 'input', message: 'must be an object holding the diff string' })
  } else {
    if (typeof input.diff !== 'string') issues.push({ path: 'diff', message: 'must be a string' })
    const source = sourceIssues(input.source)
    issues.push(...source, ...settingsIssues(input.settings), ...leftOutIssues(input.leftOut), ...sendIssues(input.send))
    issues.push(...contextIssues(input.context, profiles, {
      held,
      ...commit && source.length === 0
        ? { commit: documentCommit(sourceOf(input.source as ReviewSource | undefined)) ?? null }
        : {},
    }))
  }
  if (!isRecord(options)) {
    issues.push({ path: 'options', message: 'must be an object' })
  } else {
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) issues.push({ path: 'signal', message: 'must be an AbortSignal' })
    if (options.interrupt !== undefined && !(options.interrupt instanceof AbortSignal)) issues.push({ path: 'interrupt', message: 'must be an AbortSignal' })
    if (options.store !== undefined && !isReplyStore(options.store)) issues.push({ path: 'store', message: 'must be a reply store: an object with get and put functions' })
    issues.push(...reviewLimitIssues(options), ...findingsCapIssues(options))
  }
  return issues
}

/**
 * The problem of a review's `settings`, when it is not the record `reviewSettings` builds: one issue at `settings`, naming the path
 * of the first field that does not match as `issuePath` prints it, and never a value, so a key or a header a record holds is not
 * repeated. The schema places an issue of a provider's field at the field, so no key a person wrote is a segment of the path.
 */
function settingsIssues(settings: unknown): ConfigIssue[] {
  if (settings === undefined) return []
  const read = settingsSchema.safeParse(settings)
  if (read.success) return []
  return [
    { path: 'settings', message: `must be a review's settings record, as reviewSettings builds it: ${issuePath([
      'settings',
      ...read.error.issues[0]?.path ?? [],
    ])} does not match` },
  ]
}

/** The problems of a review's `context`: it is an object, and its documents are repository documents of the quorum's profiles, at the commit `rule` names. */
function contextIssues(context: unknown, profiles: ReadonlySet<string>, rule: { readonly commit?: string | null, readonly held?: ReadonlyMap<string, number> }): ConfigIssue[] {
  if (context === undefined) return []
  if (!isRecord(context)) {
    return [
      { path: 'context', message: 'must be an object holding documents' },
    ]
  }
  return context.documents === undefined
    ? []
    : documentIssues(context.documents, 'context.documents', { origin: 'repository', profiles, ...rule })
}

/**
 * What a review runs: each profile's run, as compiled or with the review's repository documents, and the record of every
 * document they send. A run that lists rules sends every one of them here, which the room check counts whole: the review
 * narrows them to its change's files once it knows the filtered diff (`withSent`).
 */
interface Reviewed {
  readonly runs: readonly ProfileRun[]
  readonly record: ContextRecord
}

/**
 * The runs of one review: each profile's compiled run, kept as it is when the context gives it no document, else a run of
 * its own with the profile's repository documents added to its texts, so its guidelines, its research instructions and every
 * request, plan and estimate built from them hold the documents. The review's context is checked (`reviewIssues`) before this.
 * Two things refuse it, as one `ConfigError`, before any call: a repository document that takes the profile's guidelines, do-not-report
 * text or rules over what they may hold in all (at the document that does) or gives a rule id the profile's rules already hold, and a
 * changed run whose research or votes leave their provider less than 1024 tokens of diff, as `createQuorum` refuses a profile for its own
 * documents: the research is counted with every rule the run lists, the repository's included, and not the rules a change sends. The
 * record is every run's, in run order, as new objects the review's result and event may hold.
 */
function reviewRuns(compiled: Compiled, context: ReviewContext | undefined): Reviewed {
  const given = new Map<string, Array<{ readonly index: number, readonly document: ReviewDocument }>>()
  for (const [index, document] of (context?.documents ?? []).entries()) {
    given.set(document.profile, [
      ...given.get(document.profile) ?? [],
      { index, document },
    ])
  }
  const changed = new Set<string>()
  const issues: ConfigIssue[] = []
  const runs = compiled.runs.map((run) => {
    const documents = given.get(run.id)
    if (documents === undefined) return run
    changed.add(run.id)
    issues.push(...contextTotalIssues(run.texts, documents))
    return runWith(run, withRepository(run.texts, documents.map(({ document }) => document)))
  })
  for (const run of runs) {
    if (changed.has(run.id)) issues.push(...roomIssues(run.id, profileBudgets(run, target => target.window, compiled), run, run.maxFindings))
  }
  if (issues.length > 0) throw new ConfigError(issues)
  return {
    runs,
    record: {
      documents: runs.flatMap(run => run.texts.records.map(record => structuredClone(record))),
    },
  }
}

/** Whether `value` is an object with a `get` and a `put` function, which is all a review asks of a store before it calls it. */
function isReplyStore(value: unknown): value is ReplyStore {
  return isRecord(value) && typeof value.get === 'function' && typeof value.put === 'function'
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

/** How many review rules a run lists and how many its review sends: `sent` is none for a run that lists none, whose requests carry no rule. */
function ruleCountOf(run: ProfileRun): { listed: number, sent: number } {
  return { listed: run.rules.length, sent: run.sent?.length ?? 0 }
}

/**
 * The rules each profile that lists one or requires one lists and sends, as the `context` event holds them, by profile id, with
 * `asksNothing` for a profile whose research asks nothing (it requires a rule and sends none, `{ listed: 0, sent: 0 }` when it lists
 * none); undefined when no profile lists or requires a rule.
 */
function ruleCounts(runs: readonly ProfileRun[]): Record<string, { listed: number, sent: number, asksNothing?: true }> | undefined {
  const listing = runs.filter(run => run.rules.length > 0 || run.requireRule)
  return listing.length === 0
    ? undefined
    : Object.fromEntries(listing.map(run => [
        run.id,
        {
          ...ruleCountOf(run),
          ...asksNothing(run)
            ? { asksNothing: true as const }
            : {},
        },
      ]))
}

function profileMeta(run: ProfileRun, invalidFindings: number, invalidRules: number, research: ResearchRecord, stages: ProfileMeta['stages'], coverage: CoverageEntry[], recovery: ProfileMeta['recovery']): ProfileMeta {
  return {
    providers: providersOf(run),
    policy: { ...run.thresholds },
    failOn: run.failOn,
    gating: run.gating,
    invalidFindings,
    rules: ruleCountOf(run),
    invalidRules,
    research: { ...research },
    stages: { ...stages },
    ...asksNothing(run)
      ? { asksNothing: true as const }
      : {},
    coverage,
    ...recovery === undefined
      ? {}
      : {
          recovery: { ...recovery },
        },
  }
}

/**
 * Compile a checked profile and its checked ports into the frozen run every review reads: the research
 * template rendered, the vote template rendered once per lens, the thresholds resolved, `failOn` (`high` unless the profile says
 * otherwise, `none` for its deprecated `gating: false`) and `gating` (true unless `failOn` is `none`), and
 * each provider captured beside the `{ id, model }` ref events and meta report and the deadline of its
 * attempts. Its `maxFindings` is the profile's own, else the quorum's `maxFindings`, which is given.
 */
function compile(profile: Profile, ports: ProfilePorts, maxFindings: number): ProfileRun {
  const failOn = failOnOf(profile)
  const panelSize = String(profile.lenses.length)
  const lenses = profile.lenses.map(lens => Object.freeze({
    id: lens.id,
    instructions: renderTemplate(profile.prompts.vote, { 'lens.id': lens.id, 'lens.question': lens.question, 'panel.size': panelSize }),
    ...targetOf(ports.voters[lens.id]),
  }))
  const { instructions, ...texts } = fromTexts(profileTexts(profile, renderTemplate(profile.prompts.research, {})))
  return Object.freeze({
    id: profile.id,
    research: Object.freeze({
      instructions,
      ...targetOf(ports.research),
    }),
    lenses: Object.freeze(lenses),
    thresholds: Object.freeze(thresholdsFor(profile)),
    failOn,
    gating: failOn !== 'none',
    requireRule: profile.requireRule === true,
    maxFindings: profile.maxFindings ?? maxFindings,
    ownMaxFindings: profile.maxFindings !== undefined,
    ...texts,
  })
}

/**
 * What follows from a profile's texts: the texts themselves, its joined guidelines and do-not-report text, the research
 * instructions with the do-not-report paragraph after them, and its rules, every one of which the run sends until a review
 * narrows them to its change's files (`withSent`): none for a profile that lists none, whose requests keep five fields.
 */
function fromTexts(texts: ProfileTexts): Pick<ProfileRun, 'texts' | 'guidelines' | 'doNotReport' | 'rules' | 'sent'> & { readonly instructions: string } {
  const doNotReport = joined(texts.doNotReport)
  return {
    texts,
    guidelines: joined(texts.guidelines),
    doNotReport,
    instructions: doNotReportInstructions(texts.prompt, doNotReport),
    rules: texts.rules,
    sent: texts.rules.length === 0
      ? undefined
      : texts.rules,
  }
}

/** `run` with `texts` in place of the ones it was compiled with: the guidelines, the do-not-report text, the rules and the research instructions follow from them. */
function runWith(run: ProfileRun, texts: ProfileTexts): ProfileRun {
  const { instructions, ...derived } = fromTexts(texts)
  return Object.freeze({
    ...run,
    research: Object.freeze({ ...run.research, instructions }),
    ...derived,
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
 * `concurrency`, `maxFindings` and `findingsCap` are whole numbers from 1 to 9007199254740991 when set, `maxReviewTokens` a whole number of
 * tokens from 1 to 9007199254740991, `reviewTimeoutMs` a whole number of milliseconds from 1000 to
 * 86400000, and `partTokens` a whole number of tokens from 1024 to 9007199254740991. A number is
 * quoted in the first three; anything else is described by the rule alone.
 */
function limitIssues(options: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = LIMITS.flatMap((path) => {
    const message = positiveIntegerProblem(options[path])
    return message === undefined
      ? []
      : [
          { path, message },
        ]
  })
  issues.push(...reviewLimitIssues(options))
  const partTokens = options.partTokens === undefined
    ? undefined
    : partTokensProblem(options.partTokens)
  if (partTokens !== undefined) issues.push({ path: 'partTokens', message: partTokens })
  return issues
}

/** The problems of a `maxReviewTokens` and a `reviewTimeoutMs`, whichever of the quorum's options, a review's or an estimate's holds them: the same words, at the same paths. */
function reviewLimitIssues(options: Record<string, unknown>): ConfigIssue[] {
  const tokens = options.maxReviewTokens === undefined
    ? undefined
    : maxReviewTokensProblem(options.maxReviewTokens)
  const timeout = options.reviewTimeoutMs === undefined
    ? undefined
    : timeoutProblem(options.reviewTimeoutMs)
  return [
    ...tokens === undefined
      ? []
      : [
          { path: 'maxReviewTokens', message: tokens },
        ],
    ...timeout === undefined
      ? []
      : [
          { path: 'reviewTimeoutMs', message: timeout },
        ],
  ]
}

/** The problem of a `findingsCap` in a review's options or an estimate's limits (the quorum's options are checked by `limitIssues`): a positive integer when set. */
function findingsCapIssues(options: Record<string, unknown>): ConfigIssue[] {
  const value = options.findingsCap
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
    ? []
    : [
        { path: 'findingsCap', message: 'must be a positive integer' },
      ]
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
 * The issues of one provider: it is missing, it is not one, the `timeoutMs`, the `stallTimeoutMs` or the `retries` it
 * states, as own data, is out of range, the `streams` it states is not `true`, the `window` or the `maxTokens` it states is not a whole number of
 * tokens of at least 1, its `thinking` is not `default`, `low` or `off`, its `adapts` is not an object whose
 * `thinking` is `low` or `off` and whose `prompt` and `stream` are `true`, or the `worstCase` or the `room` it
 * states, as own data, is not a function, or its `slots` is not a whole number of at least 1.
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
  const stallTimeoutMs = ownData(value, 'stallTimeoutMs')
  const stall = stallTimeoutMs === undefined
    ? undefined
    : timeoutProblem(stallTimeoutMs)
  if (stall !== undefined) issues.push({ path: `${path}.stallTimeoutMs`, message: stall })
  const retries = ownData(value, 'retries')
  const retry = retries === undefined
    ? undefined
    : retriesProblem(retries)
  if (retry !== undefined) issues.push({ path: `${path}.retries`, message: retry })
  for (const field of ['window', 'maxTokens'] as const) {
    const stated = ownData(value, field)
    const problem = stated === undefined
      ? undefined
      : tokensProblem(stated)
    if (problem !== undefined) issues.push({ path: `${path}.${field}`, message: problem })
  }
  const thinking = ownData(value, 'thinking')
  const thinkingIssue = thinking === undefined
    ? undefined
    : thinkingProblem(thinking)
  if (thinkingIssue !== undefined) issues.push({ path: `${path}.thinking`, message: thinkingIssue })
  const adapts = ownData(value, 'adapts')
  const adaptsIssue = adapts === undefined
    ? undefined
    : adaptsProblem(adapts)
  if (adaptsIssue !== undefined) issues.push({ path: `${path}.adapts`, message: adaptsIssue })
  const streams = ownData(value, 'streams')
  const streamsIssue = streams === undefined
    ? undefined
    : streamsProblem(streams)
  if (streamsIssue !== undefined) issues.push({ path: `${path}.streams`, message: streamsIssue })
  const slots = ownData(value, 'slots')
  const slotsIssue = slots === undefined
    ? undefined
    : slotsProblem(slots)
  if (slotsIssue !== undefined) issues.push({ path: `${path}.slots`, message: slotsIssue })
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
