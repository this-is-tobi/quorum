import { createHash } from 'node:crypto'
import type { Adaptations, Fields, Probe, ProbeOutcome } from '../adapt.ts'
import type { ProfileBudgets } from '../budgets.ts'
import type { Clock } from '../clock.ts'
import type { Limiter } from '../concurrency.ts'
import type { Health } from '../down.ts'
import { NO_ANSWERS, PROVIDER_ERROR_KINDS, ProviderDownError, ProviderError } from '../errors.ts'
import type { NoAnswer, ProviderErrorKind } from '../errors.ts'
import { isLimit, settlementOf } from '../limits.ts'
import type { Ledger } from '../limits.ts'
import { isRecord } from '../output.ts'
import { adaptsProblem, DEFAULT_TIMEOUT_MS, MAX_STATED_TIMEOUT_MS, retriesProblem, thinkingProblem, timeoutProblem, tokensProblem } from '../ports.ts'
import type { Adapts, CompletionRequest, CompletionResponse, EventSink, Provider, ReplyStore, StoredCall } from '../ports.ts'
import { requestDigest } from '../prompts.ts'
import { isTimeout, retryWait } from '../retry.ts'
import type { FailureFacts } from '../retry.ts'
import { DEFAULT_REPLY_TOKENS, replyLimit, requestTokens, TEMPLATE_TOKENS } from '../tokens.ts'
import type { FailOn, Position, ProviderRef, QuorumEvent, StageName, Thresholds, Usage } from '../types.ts'

/**
 * A provider as a compiled profile holds it: the object it calls, the ref captured at creation that
 * events and meta report, the deadline of each of its attempts, the retries of a call, the worst case and the
 * room it states, and the window, the `maxTokens`, the thinking level and what it lets the core adapt that it states.
 */
export interface Target {
  readonly provider: Provider
  readonly ref: Readonly<ProviderRef>
  /** The deadline of one attempt, in milliseconds: what the provider stated when the quorum was created, else the default. */
  readonly timeoutMs: number
  /** The retries of a call after its first attempt: what the provider stated when the quorum was created, else none. */
  readonly retries: number
  /** The worst case of one attempt the provider stated when the quorum was created, when it is a function; `reservationOf` reads its result. */
  readonly worstCase: ((request: CompletionRequest) => unknown) | undefined
  /** The room the provider stated when the quorum was created, when it is a function; `roomOf` reads its result. */
  readonly room: ((request: CompletionRequest) => unknown) | undefined
  /** The context window the provider stated when the quorum was created, in tokens, when it passes its check. */
  readonly window: number | undefined
  /** The ceiling of a reply the provider stated when the quorum was created, in tokens, when it passes its check. */
  readonly maxTokens: number | undefined
  /** The thinking level the provider stated when the quorum was created, `default` when it states none or one that fails its check. */
  readonly thinking: NonNullable<Provider['thinking']>
  /** What the provider lets the core change by itself, stated when the quorum was created, as own data, when it passes its check: a copy; none otherwise. */
  readonly adapts: Adapts | undefined
  /** Whether the provider states, as own data, that it streams its replies. */
  readonly streams: boolean
}

/** One lens of a compiled profile: its vote instructions, rendered once, and its own provider. */
export interface LensRun extends Target {
  readonly id: string
  readonly instructions: string
}

/**
 * A profile compiled once by createQuorum, and frozen: the stages read it instead of the caller's
 * profile and ports, so a change the caller makes to those after creation is never seen.
 */
export interface ProfileRun {
  readonly id: string
  /** The research instructions and the research provider. */
  readonly research: Target & { readonly instructions: string }
  /** The lenses, in the profile's order. */
  readonly lenses: readonly LensRun[]
  /** The profile's policy resolved for its lens count. */
  readonly thresholds: Readonly<Thresholds>
  /** The confidence at or above which its kept findings exit 1, `none` for an advisory profile; `high` when the profile does not say. */
  readonly failOn: FailOn
  /** Whether the profile gates: `failOn` is not `none`. A failed research part is its profile's gap, gating or not; a gating profile's gap exits 4. */
  readonly gating: boolean
  readonly guidelines?: string
}

/** What every stage of one review shares. */
export interface RunContext {
  /** The review's one concurrency limit, shared by every profile. */
  readonly limit: Limiter
  /**
   * The review's one token ledger, shared by every profile: each attempt of a call reserves its worst case in
   * it before the attempt is sent and settles after, inside the call's slot, so the attempts in flight can
   * never pass the cap between them.
   */
  readonly ledger: Ledger
  /** Delivers one event of the review to the sink, as a copy; it delivers nothing once the review is aborted. */
  readonly emit: EventSink
  /**
   * Aborted when the caller's signal is, when the event sink throws or when the profiles' run rejects: every
   * stage and every call checks it, and every attempt carries a signal of its own, which `stop` and the
   * attempt's own deadline abort.
   */
  readonly signal: AbortSignal
  /**
   * The review's signal joined to its deadline's and its interrupt's: aborted by whichever comes first, with that one's
   * reason, which is the limit's `LimitError` when it is the deadline or the interrupt. The slot's entry, the ledger's
   * wait, every backoff and every new call read it, so the deadline and the interrupt end them all at once and no
   * queued call starts. It is no abort of the review: `emit`, `stage` and the stages' catches keep reading `signal`, so
   * an abort still rejects with its reason and the events still flow after a limit, and what a limit stopped is a gap.
   */
  readonly stop: AbortSignal
  /**
   * The review's signal joined to its deadline's and to the end of the interrupt's grace: what the attempts in flight and
   * the store's reads and writes read, so a call that ends within the grace is read and saved. It is aborted with `stop`
   * by an abort and by the deadline, and by an interrupt only once its grace has run out.
   */
  readonly halt: AbortSignal
  /** When the review's deadline falls, `at` on the review's clock, and its length `ms`: the retry policy reads the time left from it. */
  readonly deadline: { readonly at: number, readonly ms: number }
  /** Which providers are down in this review: one count per provider object, across every profile and role that shares it. */
  readonly health: Health
  /** The `reply-lacked` lines this review has said, one per provider and line (`provider|line`): each is said once. */
  readonly lacked: Set<string>
  /** The `stored-refused` lines this review has said, one per provider and role (`provider|role`): each is said once. */
  readonly storedRefused: Set<string>
  /** Where the review keeps the calls it paid for and finds them again, when the caller gave one. */
  readonly store?: ReplyStore
  /** What this review moved by itself, and the probes that find out whether a move helps: one per review, so nothing carries to the next. */
  readonly adapt: Adaptations
  /** How many findings of a research reply each profile sends to the panel. */
  readonly maxFindings: number
  /** The reply budgets of each profile, by profile id: what its research and vote requests carry and ask for. */
  readonly budgets: Readonly<Record<string, ProfileBudgets>>
  /** The review's concurrency: how many parts of its research one profile has in flight at once. */
  readonly concurrency: number
  /** The time and the randomness the call path reads: the system's, unless a spec injects its own. */
  readonly clock: Clock
  /** The last call number the review has given: a call that starts is numbered `++last`, from 1, whatever its profile. */
  readonly calls: { last: number }
  /** The attempts the review has sent and not settled: what `run:stopping` counts when the deadline falls. */
  readonly flying: { count: number }
}

/** What a refusal as too large says when it holds no message of its own. */
const REFUSAL_FALLBACK = 'refused as too large'

/** The value of an own data property of an object, else undefined: a getter is never run, an inherited property or a throwing proxy never matches. */
export function ownData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

/**
 * True for a refusal as too large: an object whose own data property `kind` is `'too-large'`, which is what a
 * provider raises when a request may not fit its model's context, before sending it. It is matched by that
 * property, not by class, so a `ProviderError` from a second copy of quorum, such as a code config's own
 * import, is recognised too; a provider is trusted code, and a server cannot forge an error object. It
 * never runs a getter and never throws.
 */
export function isTooLarge(error: unknown): boolean {
  return ownData(error, 'kind') === 'too-large'
}

/**
 * What a failed call says of itself, as facts: the own data `kind` when it is one of `PROVIDER_ERROR_KINDS`,
 * and for an `http` failure its own data `status` when that is an integer from 100 to 599. A message, which can
 * quote a server, is never read. It is matched by those properties, not by class, as `isTooLarge` is, and it
 * never runs a getter and never throws: any other value, a kind of no provider's included, is undefined. An
 * `http` failure whose own data `exhausted` is `true` says so, as `exhausted: true`; any other kind never does. An `http`
 * failure of status 400 or 422 whose own data `refused` is `stream` or `streamOptions` says `refused: 'stream'`: a refused
 * stream, to which a provider that may not step down has one fix.
 */
export function providerFailure(error: unknown): { readonly kind: ProviderErrorKind, readonly status?: number, readonly exhausted?: true, readonly refused?: 'stream' } | undefined {
  const kind = PROVIDER_ERROR_KINDS.find(known => known === ownData(error, 'kind'))
  if (kind === undefined) return undefined
  if (kind !== 'http') return { kind }
  const status = ownData(error, 'status')
  const refused = ownData(error, 'refused')
  return {
    kind,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(ownData(error, 'exhausted') === true
      ? { exhausted: true as const }
      : {}),
    ...((status === 400 || status === 422) && (refused === 'stream' || refused === 'streamOptions')
      ? { refused: 'stream' as const }
      : {}),
  }
}

/**
 * What a failed call says of what its reply lacked, as facts: the own data `kind` when it is `truncated` or
 * `no-answer`, with its own data `noAnswer` when that is one of the four values and the pair is one an adapter
 * raises (a `truncated` reply, thinking or window, a `no-answer` thinking or empty). A message is never read, and
 * it never runs a getter and never throws.
 */
export function lackOf(error: unknown): { readonly kind: 'truncated' | 'no-answer', readonly noAnswer: NoAnswer } | undefined {
  const kind = ownData(error, 'kind')
  const noAnswer = NO_ANSWERS.find(known => known === ownData(error, 'noAnswer'))
  if (noAnswer === undefined) return undefined
  if (kind === 'truncated') {
    return noAnswer === 'empty'
      ? undefined
      : { kind, noAnswer }
  }
  if (kind === 'no-answer') {
    return noAnswer === 'thinking' || noAnswer === 'empty'
      ? { kind, noAnswer }
      : undefined
  }
  return undefined
}

/**
 * What a request was sent with, that a reply's counts are read against: the reply limit it was sent with, which
 * is undefined for a provider that states no `maxTokens` and a request that carries no budget, and its provider's
 * stated window, in tokens.
 */
interface SentWith {
  readonly limit?: number
  readonly window?: number
}

/**
 * The `reply-lacked` event of a call's final failure, with the key it is said once under, or undefined when
 * the failure says none: a cut-off at its limit, which the recovery's and the adaptation's lines say, and any
 * failure that is no reply lacking its answer. A reply cut below the limit sent shows a server that caps replies
 * lower than quorum asked: the event holds both numbers. Every field is a count the code read or a code word.
 */
function lackedEvent(provider: string, error: unknown, sent: SentWith): { readonly key: string, readonly event: Extract<QuorumEvent, { type: 'reply-lacked' }> } | undefined {
  const lack = lackOf(error)
  if (lack === undefined) return undefined
  const usage = failureUsage(error)
  const cap = lack.kind === 'truncated' && lack.noAnswer !== 'window'
  if (cap && (sent.limit === undefined || usage === undefined || usage.outputTokens >= sent.limit)) return undefined
  return {
    key: `${provider}|${cap
      ? 'cap'
      : lack.noAnswer}`,
    event: {
      type: 'reply-lacked',
      provider,
      kind: lack.kind,
      noAnswer: lack.noAnswer,
      ...(sent.limit === undefined
        ? {}
        : { limit: sent.limit }),
      ...(usage === undefined
        ? {}
        : { outputTokens: usage.outputTokens, inputTokens: usage.inputTokens }),
      ...(sent.window === undefined
        ? {}
        : { window: sent.window }),
    },
  }
}

/** What a refusal as too large says: its own data string `message`, else a fixed text, never anything else from the object. */
export function refusalMessage(refusal: unknown): string {
  const message = ownData(refusal, 'message')
  return typeof message === 'string'
    ? message
    : REFUSAL_FALLBACK
}

/**
 * The usage of one more attempt added to a running total: both sums are of the attempts that
 * reported valid counts, and `costUsd` is summed over those that reported one. With no more usage
 * the total stays as it is.
 */
export function addUsage(total: Usage | undefined, more: Usage | undefined): Usage | undefined {
  if (more === undefined) return total
  const sum: Usage = { inputTokens: (total?.inputTokens ?? 0) + more.inputTokens, outputTokens: (total?.outputTokens ?? 0) + more.outputTokens }
  const costUsd = more.costUsd === undefined
    ? total?.costUsd
    : (total?.costUsd ?? 0) + more.costUsd
  if (costUsd !== undefined) sum.costUsd = costUsd
  return sum
}

/**
 * The usage a failed call's thrown value carries, when its counts can be trusted: its own data property
 * `usage`, and that object's own data `inputTokens`, `outputTokens` and `costUsd`, checked as a reply's
 * usage is. It is matched by those properties, not by class, as `isTooLarge` is, so a `ProviderError`
 * from a second copy of quorum or a library provider's own error object counts too. It never runs a
 * getter and never throws: an inherited property, a getter or a throwing proxy reads as no usage.
 */
export function failureUsage(error: unknown): Usage | undefined {
  return ownUsage(ownData(error, 'usage'))
}

/** The usage an object holds as own data, when its counts can be trusted: never a getter run, an inherited field read or a throw. */
function ownUsage(usage: unknown): Usage | undefined {
  return checkedUsage({
    inputTokens: ownData(usage, 'inputTokens'),
    outputTokens: ownData(usage, 'outputTokens'),
    costUsd: ownData(usage, 'costUsd'),
  })
}

/**
 * Who requests a provider call, as its `call:start` and `call` events name it: `lens` and `finding` only for a vote,
 * `part` only for a research call.
 */
export interface Requester {
  readonly profile: string
  readonly role: 'research' | 'vote'
  readonly lens?: string
  readonly part?: Position
  readonly finding?: string
}

/**
 * A provider as a run holds it: the ref captured now, which events and meta report, and its
 * deadline and retries, each read as own data and taken only when it passes its check, else the
 * default: 600000 ms and no retry. The quorum's checks ran first, so a plain object's values are the
 * ones they passed; a proxy that answers the check and this read differently still gets an in-range
 * deadline and no retry, never an unbounded one. The worst case it states is its own data value when
 * that is a function, else none, and so is the room it states: a getter is never run, and an inherited method
 * states nothing. Its window and its `maxTokens` are taken as own data when each is a whole number of tokens of at
 * least 1, else it states none, its thinking when it is `default`, `low` or `off`, else `default`, and its `adapts` as
 * a copy of the own data it holds when it passes its check, else none. It streams when its own data `streams` is `true`.
 */
export function targetOf(provider: Provider): Target {
  const timeoutMs = ownData(provider, 'timeoutMs')
  const retries = ownData(provider, 'retries')
  const worstCase = ownData(provider, 'worstCase')
  const room = ownData(provider, 'room')
  const window = ownData(provider, 'window')
  const maxTokens = ownData(provider, 'maxTokens')
  const thinking = ownData(provider, 'thinking')
  const adapts = ownData(provider, 'adapts')
  const streams = ownData(provider, 'streams')
  return {
    provider,
    ref: Object.freeze({ id: provider.id, model: provider.model }),
    timeoutMs: timeoutProblem(timeoutMs, MAX_STATED_TIMEOUT_MS) === undefined
      ? timeoutMs as number
      : DEFAULT_TIMEOUT_MS,
    retries: retriesProblem(retries) === undefined
      ? retries as number
      : 0,
    worstCase: typeof worstCase === 'function'
      ? worstCase as Target['worstCase']
      : undefined,
    room: typeof room === 'function'
      ? room as Target['room']
      : undefined,
    window: tokensProblem(window) === undefined
      ? window as number
      : undefined,
    maxTokens: tokensProblem(maxTokens) === undefined
      ? maxTokens as number
      : undefined,
    thinking: thinkingProblem(thinking) === undefined
      ? thinking as Target['thinking']
      : 'default',
    adapts: adapts !== undefined && adaptsProblem(adapts) === undefined
      ? adaptsOf(adapts)
      : undefined,
    streams: streams === true,
  }
}

/** The `adapts` a provider states, copied once from its own data: a getter never ran, and the copy holds the stated fields alone. */
function adaptsOf(stated: unknown): Adapts | undefined {
  const thinking = ownData(stated, 'thinking')
  const prompt = ownData(stated, 'prompt')
  const stream = ownData(stated, 'stream')
  if (thinking === undefined && prompt === undefined && stream === undefined) return undefined
  return {
    ...thinking === undefined
      ? {}
      : { thinking: thinking as 'low' | 'off' },
    ...prompt === undefined
      ? {}
      : { prompt: true },
    ...stream === undefined
      ? {}
      : { stream: true },
  }
}

/**
 * The safe integer a provider's stated function returns for `request`, called once, synchronously, with the
 * request and the provider as `this`: undefined for anything else. A result that is not a safe integer (a
 * promise included, whose rejection is marked handled) and a throw state nothing. It never throws.
 */
function statedInteger(stating: (request: CompletionRequest) => unknown, provider: Provider, request: CompletionRequest): number | undefined {
  try {
    const stated: unknown = Reflect.apply(stating, provider, [request])
    if (typeof stated === 'number' && Number.isSafeInteger(stated)) return stated
    // It is called synchronously: a promise states nothing, and a rejected one must not crash the process.
    if ((typeof stated === 'object' && stated !== null) || typeof stated === 'function') {
      Promise.resolve(stated).then(undefined, () => {})
    }
  } catch {
    // A function that throws states nothing.
  }
  return undefined
}

/**
 * The tokens one attempt of `request` is reserved: the worst case the provider states, called once with the
 * request and the provider as `this`, when it returns a safe integer of at least 1. A provider that states
 * none, a result that is anything else (a promise included, whose rejection is marked handled) and a throw
 * all reserve the core's own count of the request plus
 * `TEMPLATE_TOKENS` for what a server adds and `DEFAULT_REPLY_TOKENS` for the reply, so a worst case that
 * misbehaves never reserves nothing. It never throws.
 */
export function reservationOf(target: Target, request: CompletionRequest): number {
  const stated = target.worstCase === undefined
    ? undefined
    : statedInteger(target.worstCase, target.provider, request)
  return stated !== undefined && stated >= 1
    ? stated
    : requestTokens(request) + TEMPLATE_TOKENS + DEFAULT_REPLY_TOKENS
}

/**
 * The room the provider states for `request`: how many more tokens of text it could hold and still fit the
 * provider's window, called once with the request and the provider as `this`, when it returns a safe integer,
 * 0 and a negative one included. A provider that states none, a result that is anything else (a promise
 * included, whose rejection is marked handled) and a throw all state nothing, which is `undefined`, and the
 * caller then reviews as it does for a provider that states no room. It never throws.
 */
export function roomOf(target: Target, request: CompletionRequest): number | undefined {
  return target.room === undefined
    ? undefined
    : statedInteger(target.room, target.provider, request)
}

/** Whole milliseconds since `started`, a `performance.now()` reading. */
export function elapsed(started: number): number {
  return Math.round(performance.now() - started)
}

/**
 * Call a provider inside the review's concurrency limit and return its reply, as `Answered`. The review's
 * stop is checked inside the slot, before the request is built, so a call still queued when the review
 * is aborted or reaches its deadline never starts. `buildRequest` runs inside the slot once that check
 * passes: a request holds the diff or a section of it, and building it only there keeps the requests a
 * review holds at once to its concurrency, whatever the number of findings and lenses (ADR-0009).
 * The call runs its attempts inside its slot, retried as `retryWait` decides, the waits between
 * them holding the slot: the review's abort ends a wait at once, and no failure is retried once the
 * review is aborted. Each attempt has the provider's deadline, and the provider is handed the
 * attempt's own signal, so it can stop a call in flight: the review's abort settles the attempt at
 * once, without waiting for the provider.
 *
 * The review's deadline ends the call's attempt and its waits for room and between attempts at once, as an
 * abort does, but with its own failure, a `LimitError` that is no attempt's `timeout`; a call still queued for
 * its slot ends there when its turn comes, before it builds its request; and no failure is retried once the
 * deadline has passed. A failure the retry policy would have retried, which the stop alone prevents, ends the
 * call with the stop's reason, the deadline's `LimitError` or the interrupt's, never with the failure, so a
 * deadline is not recorded as a failure it cut short; a failure the policy would not have retried keeps its own
 * error. The retry policy is told the time the review has left, so a server's hint longer than it ends the
 * call with its last failure.
 *
 * Each attempt, the first and every retry, reserves the call's worst case (`reservationOf`, taken once
 * the request is built) in the review's ledger before it is sent, and settles it once it ends, inside the
 * slot: at the usage its reply or its failure reports, at nothing when the server refused it before any
 * work, else at the whole reservation. An attempt that does not fit beside what was settled is never
 * sent, and the call fails with the cap's `LimitError`; one that fits but not beside the attempts in
 * flight waits for them, holding its slot, and the review's abort or deadline ends that wait too. A call a limit
 * stops before its first attempt sends no `call` event, since no provider was called; one it stops
 * after an attempt sends its failed event first, as any failed call does.
 *
 * The review's interrupt ends every wait and starts no call, as the deadline does, but spares the attempts in flight:
 * they read `ctx.halt`, which only the end of the interrupt's grace aborts, so a reply that comes within the grace is
 * read, checked and saved. A failure of an attempt that the retry policy would retry ends the call with the
 * interrupt's `LimitError`, as it does for the deadline. The store's reads and writes read `ctx.halt` too.
 *
 * A provider found down (`ctx.health`) is called no more: its call fails inside the slot, after the stop
 * check and before its request is built, with the provider's `ProviderDownError`, sending no `call` event
 * and no attempt and calling no `onFailure`; the error is no failure of the provider and counts nowhere.
 * Every other call tells the health what became of it: a reply is `answered`, whatever it holds, and a
 * call that ends in a failure is `failed` once, after its retries, which sends one `provider-down` event
 * when that failure is the third in a row. A call's final failure that is a reply lacking its answer (a
 * `truncated` or `no-answer` kind with a `noAnswer` of its own data) sends one `reply-lacked` event the first time
 * the review meets its line for that provider, built from the failure's facts and never its message.
 *
 * A call that fails once its request is built, for any reason, ends through one place: it sends its
 * failed `call` event when an attempt was made, tells the health, then hands that failure and the
 * attempts made, 0 when none, to `onFailure`, once, inside its slot, and rethrows. The research stage
 * reads the attempts there; a failed vote has no `onFailure`: the panel records it. The duration is
 * measured inside the slot, from the first attempt, once the request is built, to the call's end, the waits
 * included: the provider's latency, not the time the call waited for a slot or for room, or took to build
 * its request. A reply whose text is not a string
 * is a `ProviderError`. Each call emits one `call` event, which names the provider by the ref captured at
 * creation, never by the live object, and counts its attempts when it made more than one: failed, before
 * the error is rethrown, with the usage summed over its attempts when their counts are valid, or ok, with
 * that usage; both carry `spent`, the sum of what its attempts settled at. The ok event is emitted outside
 * the `try` that catches the provider's failure, so a sink that throws on it is never reported as a failed
 * call.
 *
 * The events of a call come in this order: `call:start` once, when the first attempt's reservation is granted and
 * before the attempt is sent, numbering the call `++ctx.calls.last`; `call:retry` before each wait, once the wait is
 * known and the stop has not fired, saying how long the failed attempt ran (`attemptMs`, from the moment its request is
 * handed to the provider, after the slot, the ledger and any backoff, to its failure); then the one `call` event,
 * which repeats the call's number. A call that ends with a failure tells the health, its `onFailure` and its
 * `provider-down` event how long the attempt that threw it ran, so a cut on the way (`cutOf`) is named. A call the store
 * answered, the down rule refused or a limit stopped before its first attempt sends no `call:start`; a refusal as too
 * large is sent after the reservation, so it does. Each attempt is counted in `ctx.flying` from its reservation until it settles.
 *
 * A call waits, inside its slot and before it checks the stop and the down rule, until no probe of its provider is
 * pending (`ctx.adapt.ready`), so it is built and sent at the settings the review has settled on, and each request
 * carries them (`ctx.adapt.sent`). A call's final failure that a setting answers (see `createAdaptations`) is
 * sent once more, inside the same call, the same slot and the same deadline: the first such failure of a
 * provider becomes its setting's probe, sent with the new setting, and a call that was in flight at the old
 * setting waits for the probe, then is sent at the settled one when the setting moved. A re-send reserves its
 * worst case and is retried by the same policy as any attempt, and counts in the call's one `call` event, its
 * attempts and its usage; it checks the down rule first, and a provider found down ends the call with its
 * `ProviderDownError`, which counts nowhere. A call meets each setting's probe at most once. The call is told to
 * the health once, after its last send, and a probe's 400 or 422 counts toward nothing: a refused probe ends the
 * call with its first failure. A research reply goes through `ctx.adapt.reasoned`.
 *
 * The stage's `check`, when it passes one, reads the reply once the call is over as a call that answered: after
 * its usage is settled and the down rule has seen the reply, and before the call's `call` event, which is sent as `ok`
 * and carries what the check listed (`listed`) and whether the reply reasoned. It says whether the reply is an answer or
 * is saturated (a research reply that listed as many findings as it was asked for at most, which the stage splits and
 * does not read), and how many findings it listed, and the call returns `saturated` for such a reply, with no text. A
 * throw from it, an `OutputError` the stage tells as a gap, ends the call with that error after the one `ok` event,
 * which then holds no `listed`: no second event is sent, the health is told nothing more, and `onFailure` hears it.
 * Every call that built its request tells `onEnd`, once, inside its slot, what it spent and when it started.
 *
 * With a store (`ctx.store`), each send of a call, the first and every re-send, is looked up under its own key once its
 * request is built and before anything is reserved: the SHA-256 of the call's role, the request's digest (`requestDigest`:
 * what a builder made it of, never its bytes), its reply budget and the `thinking` and `structuredOutput` it is sent with,
 * so a rerun replays a call's sends and a reply saved at one setting is never taken for another's. A stored reply is
 * read as a fresh one, by the stage's `check`, and is the answer, or is refused, with one `stored-refused` event per
 * provider and role, and the call is made again; a stored marker is the cut-off it records (a `truncated` failure that
 * enters the adaptation and the recovery as a fresh one does) or a saturated reply, for a research call alone. A call a
 * store answered sends one `call` event with `reused` true, no usage and `spent` 0, reserves nothing and tells the
 * health nothing: a stored reply is no answer of the provider, and a down provider's calls are refused before their
 * request is built, so before any lookup. What is saved is each fresh reply that passed its `check`, each fresh
 * saturated reply and each send of a research call that was cut off, as a marker, under the key of the send that made it;
 * never a failed call. A store that throws, rejects, answers what is no `StoredCall` or never answers (once the review
 * is stopped) is a miss, and a save that fails is a save that did not happen.
 */
export async function callProvider(ctx: RunContext, requester: Requester, target: Target, buildRequest: () => CompletionRequest, options: CallOptions = {}): Promise<Answered> {
  return ctx.limit(async () => {
    await ctx.adapt.ready(target, ctx.stop)
    ctx.stop.throwIfAborted()
    const down = ctx.health.refused(target.provider)
    if (down !== undefined) throw down
    const built = buildRequest()
    /** The request with the settings the review has settled on, which a request that needs none is left as it was built. */
    const withSettings = (fields: Fields): CompletionRequest => Object.keys(fields).length === 0
      ? built
      : {
          ...built,
          ...fields,
        }
    let sentWith = ctx.adapt.sent(target)
    let request = withSettings(sentWith)
    /** The store's key of the send in hand, which is the one a reply or a cut-off is saved under. */
    let key: string | undefined
    /** Whether the store answered a send of this call. */
    let reused = false
    /** The cut-offs a stored marker gave: no answer of the provider, which the health is told nothing of. */
    const marked = new Set<unknown>()
    /** How long the attempt that threw each failure ran, by the failure: a call that ends with one tells the health and its stage. */
    const ran = new WeakMap<object, number>()
    const ranFor = (error: unknown): number | undefined => typeof error === 'object' && error !== null
      ? ran.get(error)
      : undefined
    const started = ctx.clock.now()
    const took = (): number => Math.round(ctx.clock.now() - started)
    /** The call's number, once its first attempt's reservation is granted and `call:start` is sent. */
    let number: number | undefined
    let attempts = 0
    let usage: Usage | undefined
    let spent = 0
    let timedOut = false
    let replied: Usage | undefined
    /** Ends the call with `error`: its failed event when an attempt was made, then `onFailure`; the error to throw. */
    const end = (error: unknown): unknown => {
      if (attempts > 0 || reused) {
        ctx.emit({
          type: 'call',
          ...numbered(number),
          ...requester,
          provider: target.ref,
          durationMs: took(),
          ok: false,
          ...counted(attempts, usage, spent),
        })
      }
      // A refusal by the down rule is no failure of the provider: it counts nowhere and says nothing of a reply.
      if (!(error instanceof ProviderDownError)) {
        const found = marked.has(error)
          ? undefined
          : ctx.health.failed(target.provider, target.ref.id, error, ranFor(error))
        if (found !== undefined) {
          ctx.emit({
            type: 'provider-down',
            provider: target.ref.id,
            kind: found.kind,
            ...(found.status === undefined
              ? {}
              : { status: found.status }),
            calls: found.count,
            ...(found.exhausted
              ? { exhausted: true as const }
              : {}),
            ...(found.cutAfterMs === undefined
              ? {}
              : { cutAfterMs: found.cutAfterMs }),
            ...(found.noAnswer === undefined
              ? {}
              : { noAnswer: found.noAnswer }),
            ...(found.refused === undefined
              ? {}
              : { refused: found.refused }),
          })
        }
        const lacked = lackedEvent(target.ref.id, error, {
          limit: replyLimit(request, target.maxTokens),
          window: target.window,
        })
        if (lacked !== undefined && !ctx.lacked.has(lacked.key)) {
          ctx.lacked.add(lacked.key)
          ctx.emit(lacked.event)
        }
      }
      // Still inside the slot: a review aborted here never starts the queued call the slot goes to next.
      options.onEnd?.({ spent, startedAt: started })
      options.onFailure?.(error, attempts, ranFor(error))
      return error
    }
    /**
     * One request sent with its retries: its reply, or its failure after the retries. Each attempt reserves the
     * request's worst case in the ledger, before it is sent, and settles after.
     */
    const send = async (asked: CompletionRequest): Promise<CompletionResponse> => {
      const reservation = reservationOf(target, asked)
      let retried = 0
      for (;;) {
        await ctx.ledger.reserve(reservation, ctx.stop)
        attempts += 1
        if (number === undefined) {
          number = ++ctx.calls.last
          ctx.emit({
            type: 'call:start',
            call: number,
            ...requester,
            provider: target.ref,
            reserved: reservation,
            timeoutMs: target.timeoutMs,
          })
        }
        ctx.flying.count += 1
        /** When the request is handed to the provider: after the slot, the ledger and any backoff. */
        const sentAt = ctx.clock.now()
        /** Settles the attempt's reservation at `tokens`, which the call's `spent` adds. */
        const settle = (tokens: number): void => {
          ctx.flying.count -= 1
          ctx.ledger.settle(reservation, tokens)
          spent += tokens
        }
        try {
          const reply = await attempt(ctx, target, asked)
          if (typeof reply?.text !== 'string') throw new ProviderError({ providerId: target.ref.id, kind: 'invalid-response', message: 'returned no reply text' })
          // The reply's usage is read once, so its settlement and its event cannot disagree.
          replied = checkedUsage(reply.usage)
          settle(settlementOf(reservation, replied))
          ctx.health.answered(target.provider)
          return reply
        } catch (error) {
          const attemptMs = Math.round(ctx.clock.now() - sentAt)
          if (typeof error === 'object' && error !== null) ran.set(error, attemptMs)
          const reported = failureUsage(error)
          usage = addUsage(usage, reported)
          const facts = failureFacts(error)
          settle(settlementOf(reservation, reported, facts))
          // A stopped review is asked as if it had time to spare, so a retry only the stop prevents is the stop's doing.
          const wait = retryWait(facts, {
            retried,
            retries: target.retries,
            timedOut,
            timeLeftMs: ctx.stop.aborted
              ? Number.POSITIVE_INFINITY
              : ctx.deadline.at - ctx.clock.now(),
          }, ctx.clock.random)
          if (wait === undefined) throw error
          if (ctx.stop.aborted) throw ctx.stop.reason
          timedOut ||= isTimeout(facts)
          retried += 1
          ctx.emit({
            type: 'call:retry',
            call: number,
            attempt: retried,
            retries: target.retries,
            // A call retries only a `network`, `timeout` or `http` failure, kinds `providerFailure` always reads.
            failure: providerFailure(error)!,
            attemptMs,
            waitMs: Math.round(wait),
          })
          await pause(ctx, wait)
        }
      }
    }
    /**
     * The result of a send: what the store answered with, else its reply, or its failure. A send's request is looked up
     * under its own key before it is sent, and a send cut off is saved, as a marker, under the same key.
     */
    const sendNow = async (asked: CompletionRequest): Promise<{ readonly reply: CompletionResponse } | { readonly failure: unknown } | Read> => {
      request = asked
      key = storeKey(ctx, requester, built, asked)
      if (key !== undefined) {
        const found = await reuse(ctx, requester, target, key, options)
        if (found !== undefined) {
          reused = true
          if ('failure' in found) marked.add(found.failure)
          return found
        }
      }
      try {
        return { reply: await send(asked) }
      } catch (failure) {
        // Without a key nothing is awaited, so a review with no store takes no turn it never took.
        if (key !== undefined) await keepCutOff(ctx, requester, target, key, failure)
        return { failure }
      }
    }

    let result = await sendNow(request)
    while ('failure' in result && !ctx.stop.aborted) {
      const { failure } = result
      const plan = ctx.adapt.probe(target, failure)
      let again: Fields | undefined
      if (plan === undefined) {
        try {
          again = await ctx.adapt.after(target, sentWith, failure, ctx.stop)
        } catch (stopped) {
          result = { failure: stopped }
          break
        }
        if (again === undefined) break
      } else {
        again = {
          ...sentWith,
          ...plan.with,
        }
      }
      // A provider found down since is called no more, by the call's own re-send either.
      const refused = ctx.health.refused(target.provider)
      if (refused !== undefined) {
        if (plan !== undefined) ctx.adapt.settle(target, plan.setting, 'unsent')
        result = { failure: refused }
        break
      }
      sentWith = again
      if (plan === undefined) {
        result = await sendNow(withSettings(sentWith))
        continue
      }
      let outcome: ProbeOutcome = 'unsent'
      let first = false
      try {
        result = await sendNow(withSettings(sentWith))
        if ('failure' in result) {
          ({ outcome, first } = probeEnd(ctx, result.failure, plan))
        } else {
          outcome = 'answered'
        }
      } finally {
        const adaptation = ctx.adapt.settle(target, plan.setting, outcome)
        if (adaptation !== undefined) ctx.emit({ type: 'adapted', adaptation })
      }
      // A refused lowering, a prompt mode that did not answer and a lowering the server showed no sign of taking end the call with the failure that began the probe,
      // but a stream step the server refused as a stream goes on, with that failure, to the step of whole replies, which is probed once too.
      if ('failure' in result && first && !(plan.setting === 'stream' && isStreamRefusal(result.failure))) result = { failure }
    }
    if ('failure' in result) throw end(result.failure)
    let read: Read | undefined
    let unread: { readonly error: unknown } | undefined
    let reasoning: boolean | undefined
    if ('answered' in result) {
      read = result
    } else {
      // A streamed call the server answered whole moves its provider to whole replies, shown once.
      if (ownData(result.reply, 'whole') === true) {
        const moved = ctx.adapt.answeredWhole(target)
        if (moved !== undefined) ctx.emit({ type: 'adapted', adaptation: moved })
      }
      if (requester.role === 'research') ctx.adapt.reasoned(target, result.reply)
      const shown = ownData(result.reply, 'reasoning')
      if (typeof shown === 'boolean') reasoning = shown
      try {
        read = readAs(result.reply.text, options.check)
      } catch (error) {
        unread = { error }
      }
    }
    ctx.emit({
      type: 'call',
      ...numbered(number),
      ...requester,
      provider: target.ref,
      durationMs: took(),
      ok: true,
      ...counted(attempts, addUsage(usage, replied), spent),
      ...read?.listed === undefined
        ? {}
        : { listed: read.listed },
      ...reasoning === undefined
        ? {}
        : { reasoning },
    })
    options.onEnd?.({ spent, startedAt: started })
    if (read === undefined) {
      // The reply was no answer the stage could read: the failure goes to the stage as any other of the call.
      options.onFailure?.(unread!.error, attempts)
      throw unread!.error
    }
    if ('answered' in result) return result.answered
    if (key !== undefined) await keepAnswer(ctx, requester, target, key, read.answered, result.reply, replied)
    return read.answered
  })
}

/** The `call` field of an event of a call that was numbered, and none for one that sent no `call:start`. */
function numbered(number: number | undefined): { call?: number } {
  return number === undefined
    ? {}
    : { call: number }
}

/** What a reply is read as: its text, or a saturated reply, which the stage does not read. */
export type Answered = { readonly text: string } | { readonly saturated: true }

/** What a stage's `check` says of a reply it read: whether the reply is saturated, and how many findings it listed, when the stage counts them. */
export interface Checked {
  readonly saturated: boolean
  readonly listed?: number
}

/** What a stage hands a call besides its request. */
export interface CallOptions {
  /** Reads a reply that came back: whether it is saturated, and what it listed; a throw ends the call with that error. */
  readonly check?: (text: string) => Checked
  /**
   * Hears a call's failure, with the attempts it made and how long the attempt that threw it ran, when one did, once,
   * inside the call's slot, before the call rethrows.
   */
  readonly onFailure?: (error: unknown, attempts: number, attemptMs?: number) => void
  /**
   * Hears a call's end, once, inside its slot, for every call that built its request, whatever became of it (answered,
   * reused, failed, or refused by its check), before it returns or rethrows: the tokens it spent and the clock's reading
   * once its request was built.
   */
  readonly onEnd?: (end: { readonly spent: number, readonly startedAt: number }) => void
}

/** What a reply is read as, and what the stage's check listed of it. */
interface Read {
  readonly answered: Answered
  readonly listed?: number
}

/** What `text` is read as: an answer, or a saturated reply, as the stage's `check` says, with what it listed; an answer when it passes none. A throw is the check's. */
function readAs(text: string, check: CallOptions['check']): Read {
  const checked = check?.(text)
  return {
    answered: checked?.saturated === true
      ? { saturated: true }
      : { text },
    ...checked?.listed === undefined
      ? {}
      : { listed: checked.listed },
  }
}

/** What the store gave a send: the answer it is, read as a fresh reply, or the cut-off it records. */
type Reused = Read | { readonly failure: ProviderError }

/** The words of the failure a stored cut-off marker stands for: code words alone. */
const MARKER_WORDS = 'the stored reply was cut off'
/** What a marker may say a reply lacked. */
const MARKED_LACKS: ReadonlySet<unknown> = new Set([
  'reply',
  'thinking',
  'window',
  'saturated',
])

/**
 * The key a send is kept under, or undefined when there is no store or the request is no builder's: the SHA-256 of the
 * call's role, the request's digest, and what it is sent with, the reply budget, the thinking level and the mode, each
 * null when the request carries none. The digest comes from `built`, the request a builder made: a send with a setting is
 * a copy of it.
 */
function storeKey(ctx: RunContext, requester: Requester, built: CompletionRequest, asked: CompletionRequest): string | undefined {
  const digest = ctx.store === undefined
    ? undefined
    : requestDigest(built)
  return digest === undefined
    ? undefined
    : createHash('sha256').update(JSON.stringify([
        requester.role,
        digest,
        asked.replyTokens ?? null,
        asked.thinking ?? null,
        asked.structuredOutput ?? null,
      ])).digest('hex')
}

/** `work`, or undefined once `stop` has fired: a store that never answers holds no review past its abort, its deadline or its grace. */
function unlessStopped<T>(work: Promise<T>, stop: AbortSignal): Promise<T | undefined> {
  if (stop.aborted) return Promise.resolve(undefined)
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => resolve(undefined)
    stop.addEventListener('abort', onAbort, { once: true })
    work.then((value) => {
      stop.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      stop.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

/**
 * The call the store holds under `key`, read as own data, or undefined for a miss: nothing there, a `get` that throws or
 * rejects, a stop that came first, and anything that is no `StoredCall` (a reply of no text or model, a marker of a word
 * no marker holds, a usage that fails its check, both a reply and a marker, or neither).
 */
async function stored(ctx: RunContext, target: Target, key: string): Promise<StoredCall | undefined> {
  if (ctx.store === undefined) return undefined
  try {
    return storedCallOf(await unlessStopped(Promise.resolve(ctx.store.get({ key, provider: target.ref.id })), ctx.halt))
  } catch {
    return undefined
  }
}

/** `value` as a `StoredCall`, every field read as own data and checked, or undefined. */
function storedCallOf(value: unknown): StoredCall | undefined {
  const reply = ownData(value, 'reply')
  const lacked = ownData(value, 'lacked')
  if ((reply === undefined) === (lacked === undefined)) return undefined
  const held = reply ?? lacked
  const stated = ownData(held, 'usage')
  const usage = stated === undefined
    ? undefined
    : ownUsage(stated)
  if (stated !== undefined && usage === undefined) return undefined
  const counted = usage === undefined
    ? {}
    : { usage }
  if (lacked !== undefined) {
    const noAnswer = ownData(lacked, 'noAnswer')
    return MARKED_LACKS.has(noAnswer)
      ? {
          lacked: { noAnswer: noAnswer as 'reply' | 'thinking' | 'window' | 'saturated', ...counted },
        }
      : undefined
  }
  const text = ownData(reply, 'text')
  const model = ownData(reply, 'model')
  return typeof text === 'string' && typeof model === 'string'
    ? {
        reply: { text, model, ...counted },
      }
    : undefined
}

/**
 * What the store holds for one send, or undefined for a miss, which sends it: a stored reply that the stage's `check` reads
 * as it reads a fresh one is the answer, and one that fails it, whatever the failure, is refused (one `stored-refused` event
 * per provider and role) and the call is made; a marker is the failure it records, or a saturated reply, for a research
 * call alone, and a miss for any other.
 */
async function reuse(ctx: RunContext, requester: Requester, target: Target, key: string, options: CallOptions): Promise<Reused | undefined> {
  const call = await stored(ctx, target, key)
  if (call === undefined) return undefined
  if ('lacked' in call) {
    if (requester.role !== 'research') return undefined
    const { noAnswer, usage } = call.lacked
    return noAnswer === 'saturated'
      ? {
          answered: { saturated: true },
        }
      : {
          failure: new ProviderError({
            providerId: target.ref.id,
            kind: 'truncated',
            noAnswer,
            message: MARKER_WORDS,
            ...usage === undefined
              ? {}
              : { usage },
          }),
        }
  }
  try {
    return readAs(call.reply.text, options.check)
  } catch {
    const said = `${target.ref.id}|${requester.role}`
    if (!ctx.storedRefused.has(said)) {
      ctx.storedRefused.add(said)
      ctx.emit({ type: 'stored-refused', provider: target.ref.id, role: requester.role })
    }
    return undefined
  }
}

/** Saves `call` under `key`: a write that throws, rejects or is stopped never happened, and never fails the review. */
async function keep(ctx: RunContext, target: Target, key: string, call: StoredCall): Promise<void> {
  if (ctx.store === undefined) return
  try {
    await unlessStopped(Promise.resolve(ctx.store.put({ key, provider: target.ref.id }, call)), ctx.halt)
  } catch {
    // A write that failed leaves the review as it was: its verdict owes nothing to the store.
  }
}

/** Saves a research send that was cut off as a marker, under the key of the send: what it lacked and the usage it reported, never a text. */
async function keepCutOff(ctx: RunContext, requester: Requester, target: Target, key: string, failure: unknown): Promise<void> {
  const lack = lackOf(failure)
  if (requester.role !== 'research' || lack?.kind !== 'truncated') return
  const usage = failureUsage(failure)
  await keep(ctx, target, key, {
    lacked: {
      noAnswer: lack.noAnswer as 'reply' | 'thinking' | 'window',
      ...usage === undefined
        ? {}
        : { usage },
    },
  })
}

/** Saves a fresh reply that passed its check, under the key of the send that made it, or a saturated one as a marker: never a reply that failed its check. */
async function keepAnswer(ctx: RunContext, requester: Requester, target: Target, key: string, answered: Answered, reply: CompletionResponse, usage: Usage | undefined): Promise<void> {
  const counted = usage === undefined
    ? {}
    : { usage }
  if ('saturated' in answered) {
    if (requester.role === 'research') {
      await keep(ctx, target, key, {
        lacked: { noAnswer: 'saturated', ...counted },
      })
    }
    return
  }
  if (typeof reply.model === 'string') {
    await keep(ctx, target, key, {
      reply: { text: answered.text, model: reply.model, ...counted },
    })
  }
}

/**
 * How a probe's re-send ended, from the failure it ended with: a limit, the review's stop, a refusal as too large
 * or the down rule ended it before the server could answer (`unsent`, and the re-send's failure stands); a 400 or
 * 422 refused the value (`refused`), and the call ends with the failure that began the probe (`first`). Any other
 * failure is the server's or the network's. Prompt mode moves only on an answer, so its failed probe is `failed`
 * and ends with `first`. A thinking probe moves the level only on evidence (ruling R5): after a reply of only
 * reasoning, whose own level answered nothing, any failure is `failed`; after a cut-off, `failed` only when the
 * server showed it took the request, else `unsent` and `first`: tried, nothing moved and nothing recorded, so the
 * part splits.
 */
function probeEnd(ctx: RunContext, failure: unknown, plan: Probe): { readonly outcome: ProbeOutcome, readonly first: boolean } {
  if (ctx.stop.aborted || isLimit(failure) || isTooLarge(failure) || failure instanceof ProviderDownError) return { outcome: 'unsent', first: false }
  if (isRefusal(failure)) return { outcome: 'refused', first: true }
  if (plan.setting === 'structuredOutput' || plan.setting === 'stream') return { outcome: 'failed', first: true }
  if (plan.cause === 'cut-off-thinking' && !tookTheRequest(failure)) return { outcome: 'unsent', first: true }
  return { outcome: 'failed', first: false }
}

/** Whether `error` is a refusal that names streaming itself (`refused` is `stream`): the server takes no stream at all. */
function isStreamRefusal(error: unknown): boolean {
  return isRefusal(error) && ownData(error, 'refused') === 'stream'
}

/** Whether `error` is a failure of kind `http` with status 400 or 422, as own data: the server read the request and refused its value. */
export function isRefusal(error: unknown): boolean {
  const read = providerFailure(error)
  return read?.kind === 'http' && (read.status === 400 || read.status === 422)
}

/** The kinds of failure that show the server took the request and read it: its reply was cut off, empty, only reasoning, unreadable or refused by the model. */
const TOOK_THE_REQUEST: ReadonlySet<ProviderErrorKind> = new Set([
  'truncated',
  'no-answer',
  'invalid-response',
  'refusal',
])

/** Whether `failure` shows the server took the request: a reply of one of those kinds, or a timeout, a gateway's 504 and 524 included. */
function tookTheRequest(failure: unknown): boolean {
  const read = providerFailure(failure)
  return (read !== undefined && TOOK_THE_REQUEST.has(read.kind)) || isTimeout(failureFacts(failure))
}

/** The fields of a `call` event that hold what the call's attempts add up to: their number when above one, their summed usage when valid, the tokens the cap counted, and `reused` for a call that made no attempt. */
function counted(attempts: number, usage: Usage | undefined, spent: number): { attempts?: number, usage?: Usage, spent: number, reused?: true } {
  return {
    ...(attempts > 1
      ? { attempts }
      : {}),
    // A call with no attempt was answered by the store.
    ...(attempts === 0
      ? { reused: true as const }
      : {}),
    ...(usage === undefined
      ? {}
      : { usage }),
    spent,
  }
}

/**
 * What the retry policy reads of a thrown value: its `kind`, `status`, `retryable` and `retryAfterMs` as own data, so a
 * getter decides nothing and never runs. An `http` failure whose own data `exhausted` is `true` is never retryable,
 * whatever it says of `retryable`, as a `ProviderError`'s own `exhausted` makes it.
 */
function failureFacts(error: unknown): FailureFacts {
  const exhausted = ownData(error, 'kind') === 'http' && ownData(error, 'exhausted') === true
  return {
    kind: ownData(error, 'kind'),
    status: ownData(error, 'status'),
    retryable: exhausted
      ? false
      : ownData(error, 'retryable'),
    retryAfterMs: ownData(error, 'retryAfterMs'),
  }
}

/**
 * Wait `ms` milliseconds between two attempts of a call, which holds its slot meanwhile. The review's
 * abort or deadline ends the wait at once: it rejects with the stop's reason, and the timer is cancelled.
 * Each of the timer and the stop listener removes the other when it goes first.
 */
function pause(ctx: RunContext, ms: number): Promise<void> {
  if (ctx.stop.aborted) return Promise.reject(ctx.stop.reason)
  return new Promise<void>((resolve, reject) => {
    let cancel = (): void => {}
    function onAbort(): void {
      cancel()
      reject(ctx.stop.reason)
    }
    cancel = ctx.clock.timer(ms, () => {
      ctx.stop.removeEventListener('abort', onAbort)
      resolve()
    })
    ctx.stop.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One attempt of a call, settled once, by the first of: the provider's reply or failure; its own
 * deadline, as a `timeout` error of the core's own with the attempt's signal aborted with it as the
 * reason; the review's halt (its abort, its deadline or the end of the interrupt's grace), with the halt's reason.
 * The attempt's timer and the join to the review's halt go when it settles, on every path. A provider that throws before
 * it returns a promise, or returns a plain object, is handled; whatever it does once the attempt
 * settled is caught and ignored, and it is never an unhandled rejection. The join is one listener,
 * not `AbortSignal.any`, so nothing builds up on a signal that outlives thousands of attempts.
 */
function attempt(ctx: RunContext, target: Target, request: CompletionRequest): Promise<CompletionResponse> {
  if (ctx.halt.aborted) return Promise.reject(ctx.halt.reason)
  const controller = new AbortController()
  return new Promise<CompletionResponse>((resolve, reject) => {
    let settled = false
    let cancel = (): void => {}
    /** True the first time, when it clears the timer and the listener; false once the attempt has settled. */
    function done(): boolean {
      if (settled) return false
      settled = true
      cancel()
      ctx.halt.removeEventListener('abort', onAbort)
      return true
    }
    function onAbort(): void {
      if (!done()) return
      controller.abort(ctx.halt.reason)
      reject(ctx.halt.reason)
    }
    cancel = ctx.clock.timer(target.timeoutMs, () => {
      if (!done()) return
      const error = new ProviderError({ providerId: target.ref.id, kind: 'timeout', message: `no reply within ${target.timeoutMs} ms` })
      controller.abort(error)
      reject(error)
    })
    ctx.halt.addEventListener('abort', onAbort, { once: true })
    let call: Promise<CompletionResponse>
    try {
      call = Promise.resolve(target.provider.complete({ ...request, signal: controller.signal }))
    } catch (error) {
      if (done()) reject(error)
      return
    }
    call.then((response) => {
      if (done()) resolve(response)
    }, (error: unknown) => {
      if (done()) reject(error)
    })
  })
}

/**
 * Run one stage of a profile, sync or async, between its `stage:start` and `stage:end` events. The
 * review's signal is checked before the stage starts, not after its step: an abort during the step
 * is covered by the emit gate, the check in each call slot and the review's final check. The
 * duration is the stage's wall-clock time, queue waits included; `count` reads the number of items
 * the stage produced from its result. `start` holds the counts the stage's `stage:start` event carries: the research's
 * `parts` or the panel's `votes`.
 */
export async function stage<T>(ctx: RunContext, profile: string, name: StageName, step: () => T, count: (result: Awaited<T>) => number, start: { readonly parts?: number, readonly votes?: number } = {}): Promise<Awaited<T>> {
  ctx.signal.throwIfAborted()
  ctx.emit({
    type: 'stage:start',
    profile,
    stage: name,
    ...start,
  })
  const started = performance.now()
  const result = await step()
  ctx.emit({
    type: 'stage:end',
    profile,
    stage: name,
    durationMs: elapsed(started),
    count: count(result),
  })
  return result
}

/**
 * The usage a provider reported, when its counts can be trusted: `inputTokens` and `outputTokens`
 * finite numbers of at least 0, plus `costUsd` when it is one too. Anything else is undefined: a
 * reply's usage is as untrusted as its text.
 */
export function checkedUsage(usage: unknown): Usage | undefined {
  if (!isRecord(usage) || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
  const checked: Usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  if (isCount(usage.costUsd)) checked.costUsd = usage.costUsd
  return checked
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
