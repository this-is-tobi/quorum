/**
 * What the view knows of a review: a fold of its events into a state, pure and bounded. `fold` takes the state, an
 * event and the time it arrived (the view's own clock, never the review's) and returns a new state, sharing what
 * did not change; no event is kept, so the state never grows with the review's length but by what the time left
 * needs, one duration per answered part and vote and one entry per research part. It holds counts, ids and code
 * words only. An event of a type it does not know leaves the state as it was, so a later release's events fold in
 * with no change of shape. Times are the view's clock's: `startedAt`, a call's `startedAt` and `waitingUntil`,
 * `stopping.at` and `firstEstimate.at` are readings of it, and only their differences mean anything.
 */

import { LANE_START } from '../../core/lanes.ts'
import { DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS } from '../../core/limits.ts'
import { DEFAULT_MAX_FINDINGS } from '../../core/prompts.ts'
import type { CallFailure, Estimate, IncompleteReason, Position, QuorumEvent, StageName, Usage } from '../../core/types.ts'
import { plannedOf, researchTotal, sampleNeeded, timeLeft } from './eta.ts'

/** How wide one cell of the token buckets is, and how many cells they keep. */
export const BUCKET_MS = 30_000
export const BUCKETS = 20

/** Where the review's token cap came from: its default, the config, or, for a path review, its estimate's worst case or the default floor that holds it. */
export type CapOrigin = 'default' | 'config' | 'estimate' | 'floor'

/** What the CLI knows of the review before it starts, which no event says. */
export interface ViewFacts {
  /** The calls the review holds at once: the number `concurrency` sets for every provider together, else `auto`, each provider's own lane. */
  readonly concurrency: number | 'auto'
  readonly cap: { readonly tokens: number, readonly origin: CapOrigin }
  readonly deadlineMs: number
  /** The findings a research reply sends the panel at most, which sizes the votes to come. */
  readonly maxFindings: number
  /** A path review's estimate, which weighs the parts not yet started. */
  readonly estimate?: Estimate
}

export const DEFAULT_FACTS: ViewFacts = {
  concurrency: 'auto',
  cap: { tokens: DEFAULT_MAX_REVIEW_TOKENS, origin: 'default' },
  deadlineMs: DEFAULT_REVIEW_TIMEOUT_MS,
  maxFindings: DEFAULT_MAX_FINDINGS,
}

/** One profile's time in a stage: when it started, and when it ended once it has. */
export interface Interval {
  readonly first: number
  readonly last?: number
}

/**
 * What the gap entries of one reason say they count, summed over the profiles: the research parts or the votes each
 * entry counts in its detail, and `other` for the entries that count neither, each of which stands for itself.
 */
export interface GapCount {
  readonly parts: number
  readonly votes: number
  readonly other: number
}

/** The cause of a gap: what a failed call said of itself, its quota and its cut on the way included. */
export type Cause = CallFailure & { readonly exhausted?: true }

/** What a provider's lane did: its limit now, what changed it last, and the pause and pacing a throttle or the headers' reset hold new calls to, each until a time of the view's clock. */
export interface LaneState {
  readonly limit: number
  /** The last change of the limit: not set while it has not moved from the start. */
  readonly last?: 'grown' | 'cut' | 'regrown' | 'slots'
  /** The throttle behind the last cut or the pause. */
  readonly failure?: CallFailure
  readonly pausedUntil?: number
  readonly pacedUntil?: number
}

/** A provider call in flight. */
export interface CallState {
  readonly role: 'research' | 'vote'
  readonly profile: string
  readonly provider: string
  readonly part?: Position
  readonly finding?: string
  readonly startedAt: number
  readonly reserved: number
  readonly timeoutMs: number
  /** Whether an attempt of it failed and was retried. */
  readonly retried: boolean
  /** When its wait before the next attempt ends, while it waits. */
  readonly waitingUntil?: number
  /** What its last failed attempt said of itself. */
  readonly failure?: CallFailure
  /** Whether its first attempt streams, which gives it a spinner and progress. */
  readonly stream: boolean
  /** The output its current attempt has shown, from its last progress; an attempt's own count, so a retry starts it again at 0. */
  readonly outputTokens: number
  /** Whether its last progress was a keep-alive, and none has come since. */
  readonly keepAlive: boolean
  /** How many of its progress reports said its output grew, which is what turns its spinner. */
  readonly turns: number
  /** The output of its attempts that is in the buckets so far, the failed attempts' streamed growth included. */
  readonly counted: number
  /** What `counted` was when its current attempt began, which the attempt's growth is measured from. */
  readonly base: number
}

/** Where one profile's review stands. */
export interface ProfileState {
  readonly stage: StageName | 'waiting' | 'done'
  /** The research's part count, once its stage started. */
  readonly parts?: number
  /** The research parts ended, read or not. */
  readonly done: number
  /** The findings the research replies listed. */
  readonly listed: number
  /** The panel's vote count, once its stage started. */
  readonly votes?: number
  readonly cast: number
  readonly kept: number
}

export interface ViewState {
  readonly facts: ViewFacts
  readonly startedAt?: number
  readonly ended: boolean
  /** Whether several profiles run, so every profile's line starts with its id. */
  readonly prefixed: boolean
  readonly profiles: ReadonlyMap<string, ProfileState>
  /** The lenses of each profile's panel, from `run:start`. */
  readonly lenses: ReadonlyMap<string, number>
  /** The research provider of each profile, by profile id, from `run:start`. */
  readonly researchProvider: ReadonlyMap<string, string>
  /** Each provider's lane, by provider id, once it has a call or a change: none with `concurrency` set. */
  readonly lanes: ReadonlyMap<string, LaneState>
  readonly calls: ReadonlyMap<number, CallState>
  /** Each finding a vote asked about, numbered from 1 in the order first seen. */
  readonly findings: ReadonlyMap<string, number>
  readonly spent: number
  /** The output tokens of the calls, streamed as they come and the rest of their usage as they end, in the last `BUCKETS` cells of `BUCKET_MS` from `start`. */
  readonly buckets: { readonly start: number, readonly tokens: readonly number[] }
  /** One entry per research part answered fresh and per vote answered fresh. */
  readonly sample: { readonly parts: ReadonlyArray<{ readonly provider: string, readonly planned: number, readonly durationMs: number }>, readonly votes: readonly number[] }
  /** Each research part's first reservation, by `<profile>|<part>`. */
  readonly planned: ReadonlyMap<string, number>
  /** The research parts ended, by `<profile>|<part>`. */
  readonly partsEnded: ReadonlySet<string>
  readonly made: { readonly research: number, readonly votes: number }
  readonly retried: { readonly research: number, readonly votes: number }
  readonly recovered: { readonly parts: number, readonly pieces: number }
  /** The providers whose cut on the way was learned, which changes the fix of their replies cut off: shorter replies, not a larger limit. */
  readonly cutSeen: ReadonlySet<string>
  /** The research providers of the profiles that have a `reply-cut-off` gap. */
  readonly cutOffBy: ReadonlySet<string>
  /** Every lens's provider, from `run:start`: the lanes the panel's calls run on. */
  readonly lensProviders: ReadonlySet<string>
  /** Each profile's interval in each stage, by stage then profile id. */
  readonly stages: ReadonlyMap<StageName, ReadonlyMap<string, Interval>>
  readonly gaps: ReadonlyMap<IncompleteReason, GapCount>
  readonly causes: ReadonlyMap<'research-failed' | 'provider-down', readonly Cause[]>
  readonly usage: ReadonlyMap<string, Usage>
  /** The longest first token and the longest silence of each provider's answered streamed calls, and the largest ceiling any of them grew to, by provider id. */
  readonly timings: ReadonlyMap<string, { readonly firstTokenMs: number, readonly longestSilenceMs: number, readonly ceilingMs?: number }>
  /** The review began to stop: why, when, how many calls were in flight, and for an interrupt the grace they were given. */
  readonly stopping?: { readonly cause: 'interrupt' | 'review-deadline', readonly at: number, readonly inFlight: number, readonly graceMs?: number }
  /** The time left as it first read, at the answered part that passed the threshold. */
  readonly firstEstimate?: { readonly at: number, readonly lowMs: number, readonly highMs: number }
}

const NO_BUCKETS: readonly number[] = Array.from<number>({ length: BUCKETS }).fill(0)

const NEW_PROFILE: ProfileState = {
  stage: 'waiting',
  done: 0,
  listed: 0,
  cast: 0,
  kept: 0,
}

/** The state before any event: no review has started. */
export function startState(facts: ViewFacts): ViewState {
  return {
    facts,
    ended: false,
    prefixed: false,
    profiles: new Map(),
    lenses: new Map(),
    researchProvider: new Map(),
    lanes: new Map(),
    calls: new Map(),
    findings: new Map(),
    spent: 0,
    buckets: { start: 0, tokens: NO_BUCKETS },
    sample: { parts: [], votes: [] },
    planned: new Map(),
    partsEnded: new Set(),
    made: { research: 0, votes: 0 },
    retried: { research: 0, votes: 0 },
    recovered: { parts: 0, pieces: 0 },
    cutSeen: new Set(),
    cutOffBy: new Set(),
    lensProviders: new Set(),
    stages: new Map(),
    gaps: new Map(),
    causes: new Map(),
    usage: new Map(),
    timings: new Map(),
  }
}

/** `map` with `key` set to `value`. */
function set<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  return new Map(map).set(key, value)
}

/** `stages` with the interval of `profile` in `stage` set to what `change` makes of the one it had, if any. */
function withInterval(stages: ViewState['stages'], stage: StageName, profile: string, change: (known: Interval | undefined) => Interval): ViewState['stages'] {
  const runs = stages.get(stage) ?? new Map<string, Interval>()
  return set(stages, stage, set(runs, profile, change(runs.get(profile))))
}

/** The intervals of `stage` that ended, and their earliest start and latest end. */
function endedRuns(state: ViewState, stage: StageName): Array<{ readonly first: number, readonly last: number }> {
  return [
    ...state.stages.get(stage)?.values() ?? [],
  ].flatMap(({ first, last }) => last === undefined
    ? []
    : [
        { first, last },
      ])
}

/** When the first profile started `stage`, or undefined while none has. */
export function stageStart(state: ViewState, stage: StageName): number | undefined {
  const starts = [
    ...state.stages.get(stage)?.values() ?? [],
  ].map(({ first }) => first)
  return starts.length === 0
    ? undefined
    : Math.min(...starts)
}

/** When the last profile to end `stage` did, or undefined while none has. */
export function stageEnd(state: ViewState, stage: StageName): number | undefined {
  const ends = endedRuns(state, stage).map(({ last }) => last)
  return ends.length === 0
    ? undefined
    : Math.max(...ends)
}

/**
 * How long some profile was in `stage`: the length of the union of its profiles' intervals that ended, so two profiles
 * running side by side count their time once and a gap between them counts for nothing. Undefined while none has ended.
 */
export function stageTime(state: ViewState, stage: StageName): number | undefined {
  const runs = endedRuns(state, stage).sort((a, b) => a.first - b.first)
  if (runs.length === 0) return undefined
  let total = 0
  let { first, last } = runs[0]
  for (const run of runs.slice(1)) {
    if (run.first > last) {
      total += last - first
      first = run.first
      last = run.last
    } else {
      last = Math.max(last, run.last)
    }
  }
  return total + last - first
}

const PART_COUNT = /^(\d+) of \d+ research (?:parts|requests) /
/** A vote gap's detail starts with its finding's file as a JSON string, which holds no unescaped quote, so what follows it is the core's own words. */
const VOTE_COUNT = /^"(?:[^"\\]|\\.)*":\d+(?:: (\d+) of \d+ vote requests were not sent: | is kept at \S+, but (\d+) failed vote\(s\) could have made it \S+$)/

/** What a limit's gap detail says it stopped, as `limitGaps` writes it: the limit's own words, then `stopped`, then the rest. */
const LIMIT_STOPPED = /^(?:the review's token cap of \d+ tokens|the review's deadline of \d+ ms|the interrupt) stopped (.+)$/
/** The research a limit stopped, `its research` (one part) or `<p> of its <m> research parts`, and the votes after it. */
const LIMIT_RESEARCH = /^(?:(its research)|(\d+) of its \d+ research parts)(?: and (\d+) vote\(s\))?$/
const LIMIT_VOTES = /^(\d+) vote\(s\)$/

/** The research parts and votes a limit's gap detail says it stopped, and nothing for any other detail. */
function limitCount(detail: string): { readonly parts?: number, readonly votes?: number } {
  const rest = LIMIT_STOPPED.exec(detail)?.[1]
  if (rest === undefined) return {}
  const research = LIMIT_RESEARCH.exec(rest)
  if (research !== null) {
    const parts = research[1] === undefined
      ? Number(research[2])
      : 1
    if (!Number.isSafeInteger(parts)) return {}
    if (research[3] === undefined) return { parts }
    const votes = Number(research[3])
    return Number.isSafeInteger(votes)
      ? { parts, votes }
      : {}
  }
  const votes = Number(LIMIT_VOTES.exec(rest)?.[1])
  return Number.isSafeInteger(votes)
    ? { votes }
    : {}
}

/** The research parts or votes a gap's detail says it counts, as the core writes it, and nothing for any other detail. */
function countOf(detail: string): { readonly parts?: number, readonly votes?: number } {
  const limited = limitCount(detail)
  if (limited.parts !== undefined || limited.votes !== undefined) return limited
  const parts = Number(PART_COUNT.exec(detail)?.[1])
  if (Number.isSafeInteger(parts)) return { parts }
  const match = VOTE_COUNT.exec(detail)
  const votes = Number(match?.[1] ?? match?.[2])
  return Number.isSafeInteger(votes)
    ? { votes }
    : {}
}

/** `state` with `patch` made to one profile's state. */
function withProfile(state: ViewState, id: string, patch: (profile: ProfileState) => ProfileState): ViewState {
  return {
    ...state,
    profiles: set(state.profiles, id, patch(state.profiles.get(id) ?? NEW_PROFILE)),
  }
}

/** Two causes are the same when they have the same kind, status, quota and refused stream, and both were cut on the way or neither was, and both stalled or neither did. */
function sameCause(a: Cause, b: Cause): boolean {
  return a.kind === b.kind && a.status === b.status && a.exhausted === b.exhausted && a.refused === b.refused && (a.cutAfterMs === undefined) === (b.cutAfterMs === undefined) && (a.stalledMs === undefined) === (b.stalledMs === undefined)
}

/** `state` with `cause` among the causes of `reason`, once. */
function withCause(state: ViewState, reason: 'research-failed' | 'provider-down', cause: Cause): ViewState {
  const known = state.causes.get(reason) ?? []
  if (known.some(other => sameCause(other, cause))) return state
  return {
    ...state,
    causes: set(state.causes, reason, [...known, cause]),
  }
}

/** `failure` as a cause: its kind, its status, its quota, its cut, its stall and its refused stream, each when it has one. */
function causeOf(failure: CallFailure): Cause {
  return {
    kind: failure.kind,
    ...failure.status === undefined
      ? {}
      : { status: failure.status },
    ...failure.exhausted === true
      ? { exhausted: true as const }
      : {},
    ...failure.cutAfterMs === undefined
      ? {}
      : { cutAfterMs: failure.cutAfterMs },
    ...failure.stalledMs === undefined
      ? {}
      : { stalledMs: failure.stalledMs },
    ...failure.refused === undefined
      ? {}
      : { refused: failure.refused },
  }
}

/** `buckets` with `tokens` added to the cell of `now`, the cells moved on when `now` passes the last. */
function bucketed(buckets: ViewState['buckets'], now: number, tokens: number): ViewState['buckets'] {
  if (tokens <= 0) return buckets
  let index = Math.max(0, Math.floor((now - buckets.start) / BUCKET_MS))
  let { start } = buckets
  let cells = [...buckets.tokens]
  if (index >= BUCKETS) {
    const shift = index - BUCKETS + 1
    cells = shift >= BUCKETS
      ? cells.map(() => 0)
      : [
          ...cells.slice(shift),
          ...Array.from<number>({ length: shift }).fill(0),
        ]
    start += shift * BUCKET_MS
    index = BUCKETS - 1
  }
  cells[index] += tokens
  return { start, tokens: cells }
}

function started(state: ViewState, event: Extract<QuorumEvent, { type: 'run:start' }>, now: number): ViewState {
  const fresh = startState(state.facts)
  return {
    ...fresh,
    startedAt: now,
    prefixed: event.profiles.length > 1,
    profiles: new Map(event.profiles.map(id => [id, NEW_PROFILE])),
    lenses: new Map(event.profiles.map(id => [id, Object.keys(event.providers[id]?.lenses ?? {}).length])),
    researchProvider: new Map(event.profiles.flatMap((id) => {
      const research = event.providers[id]?.research
      return research === undefined
        ? []
        : [
            [id, research.id] as const,
          ]
    })),
    lensProviders: new Set(event.profiles.flatMap(id => Object.values(event.providers[id]?.lenses ?? {}).map(lens => lens.id))),
    buckets: { start: now, tokens: NO_BUCKETS },
  }
}

function callStarted(state: ViewState, event: Extract<QuorumEvent, { type: 'call:start' }>, now: number): ViewState {
  const { part, finding } = event
  const key = part === undefined
    ? undefined
    : `${event.profile}|${part.index}`
  return {
    ...state,
    calls: set(state.calls, event.call, {
      role: event.role,
      profile: event.profile,
      provider: event.provider.id,
      ...part === undefined
        ? {}
        : { part },
      ...finding === undefined
        ? {}
        : { finding },
      startedAt: now,
      reserved: event.reserved,
      timeoutMs: event.timeoutMs,
      retried: false,
      stream: event.stream === true,
      outputTokens: 0,
      keepAlive: false,
      turns: 0,
      counted: 0,
      base: 0,
    }),
    lanes: state.facts.concurrency !== 'auto' || state.lanes.has(event.provider.id)
      ? state.lanes
      : set(state.lanes, event.provider.id, { limit: LANE_START }),
    findings: finding === undefined || state.findings.has(finding)
      ? state.findings
      : set(state.findings, finding, state.findings.size + 1),
    planned: event.role === 'research' && key !== undefined && !state.planned.has(key)
      ? set(state.planned, key, event.reserved)
      : state.planned,
  }
}

function callRetried(state: ViewState, event: Extract<QuorumEvent, { type: 'call:retry' }>, now: number): ViewState {
  const call = state.calls.get(event.call)
  if (call === undefined) return state
  const counts = call.retried
    ? state.retried
    : call.role === 'research'
      ? { ...state.retried, research: state.retried.research + 1 }
      : { ...state.retried, votes: state.retried.votes + 1 }
  return {
    ...state,
    retried: counts,
    calls: set(state.calls, event.call, {
      ...call,
      retried: true,
      waitingUntil: now + event.waitMs,
      failure: event.failure,
      // the next attempt streams its own count from 0; what the failed one streamed stays in the buckets
      outputTokens: 0,
      keepAlive: false,
      base: call.counted,
    }),
  }
}

function callProgressed(state: ViewState, event: Extract<QuorumEvent, { type: 'call:progress' }>, now: number): ViewState {
  const call = state.calls.get(event.call)
  if (call === undefined) return state
  if (event.signal === 'keep-alive') {
    return {
      ...state,
      calls: set(state.calls, event.call, { ...call, outputTokens: event.outputTokens, keepAlive: true }),
    }
  }
  // the attempt's own count less what it already put in the buckets: the growth, never below 0
  const grown = Math.max(0, event.outputTokens - (call.counted - call.base))
  return {
    ...state,
    calls: set(state.calls, event.call, {
      ...call,
      outputTokens: event.outputTokens,
      keepAlive: false,
      turns: call.turns + 1,
      counted: call.counted + grown,
    }),
    buckets: bucketed(state.buckets, now, grown),
  }
}

/** `timings` with the larger of each of its numbers and the answered call's of `id`, or `timings` when the call has none. */
function withTimings(timings: ViewState['timings'], id: string, event: Extract<QuorumEvent, { type: 'call' }>): ViewState['timings'] {
  const { firstTokenMs, longestSilenceMs, ceilingMs } = event
  if (!event.ok || firstTokenMs === undefined || longestSilenceMs === undefined) return timings
  const known = timings.get(id)
  const grown = Math.max(known?.ceilingMs ?? 0, ceilingMs ?? 0)
  return set(timings, id, {
    firstTokenMs: Math.max(known?.firstTokenMs ?? 0, firstTokenMs),
    longestSilenceMs: Math.max(known?.longestSilenceMs ?? 0, longestSilenceMs),
    ...grown === 0
      ? {}
      : { ceilingMs: grown },
  })
}

function callEnded(state: ViewState, event: Extract<QuorumEvent, { type: 'call' }>, now: number): ViewState {
  let calls = state.calls
  const flying = event.call === undefined
    ? undefined
    : calls.get(event.call)
  if (event.call !== undefined && calls.has(event.call)) {
    const rest = new Map(calls)
    rest.delete(event.call)
    calls = rest
  }
  if (event.reused === true) return { ...state, calls }
  const made = event.role === 'research'
    ? { ...state.made, research: state.made.research + 1 }
    : { ...state.made, votes: state.made.votes + 1 }
  const { usage } = event
  const known = state.usage.get(event.provider.id)
  return {
    ...state,
    calls,
    made,
    spent: state.spent + event.spent,
    usage: usage === undefined
      ? state.usage
      : set(state.usage, event.provider.id, {
          inputTokens: (known?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens: (known?.outputTokens ?? 0) + usage.outputTokens,
          ...known?.costUsd === undefined && usage.costUsd === undefined
            ? {}
            : { costUsd: (known?.costUsd ?? 0) + (usage.costUsd ?? 0) },
        }),
    // the answered attempt's streamed growth is in the buckets already: add only the rest of its reported output (`bucketed` takes nothing out)
    buckets: bucketed(state.buckets, now, (usage?.outputTokens ?? 0) - (flying === undefined
      ? 0
      : flying.counted - flying.base)),
    timings: withTimings(state.timings, event.provider.id, event),
    sample: event.role === 'vote' && event.ok
      ? {
          ...state.sample,
          votes: [...state.sample.votes, event.durationMs],
        }
      : state.sample,
  }
}

/**
 * The failure a lane keeps after `cause`: a cut's own, a pause's own or the one it had, and for the changes that
 * start no wait, the one it had while a pause still holds, else none.
 */
function laneFailure(known: LaneState, cause: Extract<QuorumEvent, { type: 'concurrency' }>['cause'], failure: CallFailure | undefined, now: number): CallFailure | undefined {
  if (cause === 'cut') return failure
  if (cause === 'paused') return failure ?? known.failure
  return known.pausedUntil !== undefined && known.pausedUntil > now
    ? known.failure
    : undefined
}

/** `state` with the lane of the event's provider changed: its limit, its last change, its throttle, and the pause or pacing a wait starts. */
function laneChanged(state: ViewState, event: Extract<QuorumEvent, { type: 'concurrency' }>, now: number): ViewState {
  const known = state.lanes.get(event.provider.id) ?? { limit: LANE_START }
  const { cause, waitMs = 0 } = event
  const failure = laneFailure(known, cause, event.failure, now)
  const lane: LaneState = {
    limit: event.limit,
    ...cause === 'paused' || cause === 'paced'
      ? known.last === undefined
        ? {}
        : { last: known.last }
      : { last: cause },
    ...failure === undefined
      ? {}
      : { failure },
    ...cause === 'paused'
      ? { pausedUntil: now + waitMs }
      : known.pausedUntil === undefined
        ? {}
        : { pausedUntil: known.pausedUntil },
    ...cause === 'paced'
      ? { pacedUntil: now + waitMs }
      : known.pacedUntil === undefined
        ? {}
        : { pacedUntil: known.pacedUntil },
  }
  return {
    ...state,
    lanes: set(state.lanes, event.provider.id, lane),
  }
}

function partEnded(state: ViewState, event: Extract<QuorumEvent, { type: 'part' }>, now: number): ViewState {
  const key = `${event.profile}|${event.part.index}`
  const planned = event.outcome === 'reviewed' && event.spent > 0
    ? plannedOf(state, event.profile, event.part.index)
    : undefined
  let next: ViewState = {
    ...withProfile(state, event.profile, profile => ({ ...profile, done: profile.done + 1, listed: profile.listed + (event.listed ?? 0) })),
    partsEnded: new Set(state.partsEnded).add(key),
    sample: planned === undefined || planned <= 0
      ? state.sample
      : {
          ...state.sample,
          parts: [
            ...state.sample.parts,
            { provider: state.researchProvider.get(event.profile) ?? event.profile, planned, durationMs: event.durationMs },
          ],
        },
  }
  if (event.outcome === 'research-failed' && event.failure !== undefined) next = withCause(next, 'research-failed', causeOf(event.failure))
  if (next.firstEstimate === undefined && next.sample.parts.length > state.sample.parts.length && next.sample.parts.length >= sampleNeeded(researchTotal(next))) {
    const left = timeLeft(next, now)
    if (left.kind === 'range') {
      next = {
        ...next,
        firstEstimate: { at: now, lowMs: left.lowMs, highMs: left.highMs },
      }
    }
  }
  return next
}

/** The state after `event`, which arrived at `now`: a new state sharing what did not change, or `state` itself for an event it holds nothing of. */
export function fold(state: ViewState, event: QuorumEvent, now: number): ViewState {
  switch (event.type) {
    case 'run:start':
      return started(state, event, now)
    case 'stage:start': {
      return {
        ...withProfile(state, event.profile, profile => ({
          ...profile,
          stage: event.stage,
          ...event.parts === undefined
            ? {}
            : { parts: event.parts },
          ...event.votes === undefined
            ? {}
            : { votes: event.votes },
        })),
        stages: withInterval(state.stages, event.stage, event.profile, known => known ?? { first: now }),
      }
    }
    case 'stage:end':
      return {
        ...withProfile(state, event.profile, profile => event.stage === 'panel'
          ? { ...profile, stage: 'done' }
          : profile),
        stages: withInterval(state.stages, event.stage, event.profile, known => ({ first: known?.first ?? now, last: now })),
      }
    case 'call:start':
      return callStarted(state, event, now)
    case 'concurrency':
      return state.facts.concurrency === 'auto'
        ? laneChanged(state, event, now)
        : state
    case 'call:retry':
      return callRetried(state, event, now)
    case 'call:progress':
      return callProgressed(state, event, now)
    case 'call':
      return callEnded(state, event, now)
    case 'part':
      return partEnded(state, event, now)
    case 'recovered':
      return {
        ...state,
        recovered: { parts: state.recovered.parts + 1, pieces: state.recovered.pieces + event.pieces },
      }
    case 'cut':
      return state.cutSeen.has(event.provider)
        ? state
        : {
            ...state,
            cutSeen: new Set(state.cutSeen).add(event.provider),
          }
    case 'provider-down':
      return withCause(state, 'provider-down', causeOf({
        kind: event.kind,
        ...event.status === undefined
          ? {}
          : { status: event.status },
        ...event.exhausted === true
          ? { exhausted: true as const }
          : {},
        ...event.cutAfterMs === undefined
          ? {}
          : { cutAfterMs: event.cutAfterMs },
        ...event.stalledMs === undefined
          ? {}
          : { stalledMs: event.stalledMs },
        ...event.refused === undefined
          ? {}
          : { refused: event.refused },
      }))
    case 'incomplete': {
      const known = state.gaps.get(event.entry.reason) ?? { parts: 0, votes: 0, other: 0 }
      const { parts, votes } = countOf(event.entry.detail)
      const researcher = state.researchProvider.get(event.entry.profile)
      return {
        ...state,
        ...event.entry.reason === 'reply-cut-off' && researcher !== undefined && !state.cutOffBy.has(researcher)
          ? {
              cutOffBy: new Set(state.cutOffBy).add(researcher),
            }
          : {},
        gaps: set(state.gaps, event.entry.reason, {
          parts: known.parts + (parts ?? 0),
          votes: known.votes + (votes ?? 0),
          other: known.other + (parts === undefined && votes === undefined
            ? 1
            : 0),
        }),
      }
    }
    case 'vote':
      return withProfile(state, event.profile, profile => ({ ...profile, cast: profile.cast + 1 }))
    case 'verdict':
      return event.status === 'kept'
        ? withProfile(state, event.profile, profile => ({ ...profile, kept: profile.kept + 1 }))
        : state
    case 'run:stopping':
      return {
        ...state,
        stopping: {
          cause: event.cause,
          at: now,
          inFlight: event.inFlight,
          ...event.graceMs === undefined
            ? {}
            : { graceMs: event.graceMs },
        },
      }
    case 'run:end':
      return { ...state, ended: true }
    default:
      return state
  }
}
