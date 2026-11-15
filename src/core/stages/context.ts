import type { Clock } from '../clock.ts'
import type { Limiter } from '../concurrency.ts'
import { PROVIDER_ERROR_KINDS, ProviderError } from '../errors.ts'
import type { ProviderErrorKind } from '../errors.ts'
import { settlementOf } from '../limits.ts'
import type { Ledger } from '../limits.ts'
import { isRecord } from '../output.ts'
import { DEFAULT_TIMEOUT_MS, MAX_STATED_TIMEOUT_MS, retriesProblem, timeoutProblem } from '../ports.ts'
import type { CompletionRequest, CompletionResponse, EventSink, Provider } from '../ports.ts'
import { isTimeout, retryWait } from '../retry.ts'
import type { FailureFacts } from '../retry.ts'
import { DEFAULT_REPLY_TOKENS, requestTokens, TEMPLATE_TOKENS } from '../tokens.ts'
import type { ProviderRef, StageName, Thresholds, Usage } from '../types.ts'

/**
 * A provider as a compiled profile holds it: the object it calls, the ref captured at creation that
 * events and meta report, the deadline of each of its attempts, the retries of a call, and the worst case
 * and the room it states.
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
  /** Whether its kept high findings set exit code 1; true when the profile does not say. */
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
   * Aborted when the caller's signal is, when the event sink throws, when a gating profile's research fails
   * or when the profiles' run rejects: every stage and every call checks it, and every attempt
   * carries a signal of its own, which `stop` and the attempt's own deadline abort.
   */
  readonly signal: AbortSignal
  /**
   * The review's signal joined to its deadline's: aborted by whichever comes first, with that one's reason, which
   * is the deadline's `LimitError` when it is the deadline. The slot's entry, the ledger's wait, every attempt and
   * every backoff read it, so the deadline ends them all at once and no queued call starts. It is no abort of the
   * review: `emit`, `stage` and the stages' catches keep reading `signal`, so an interrupt still rejects with its
   * reason and the events still flow after the deadline, and what the deadline stopped is a gap.
   */
  readonly stop: AbortSignal
  /** When the review's deadline falls, `at` on the review's clock, and its length `ms`: the retry policy reads the time left from it. */
  readonly deadline: { readonly at: number, readonly ms: number }
  /**
   * Aborts the review with `error`, unless it is already aborted, so a caller's abort reason or a
   * sink's error stays the reason. A gating profile's research failure, the call or its reply, calls
   * it where it fails, so no other profile starts a call after it; an advisory profile's research
   * failure is a gap, like a research request refused as too large, and does not.
   */
  readonly fail: (error: unknown) => void
  /** How many findings of a research reply each profile sends to the panel. */
  readonly maxFindings: number
  /** The time and the randomness the call path reads: the system's, unless a spec injects its own. */
  readonly clock: Clock
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
 * never runs a getter and never throws: any other value, a kind of no provider's included, is undefined.
 */
export function providerFailure(error: unknown): { readonly kind: ProviderErrorKind, readonly status?: number } | undefined {
  const kind = PROVIDER_ERROR_KINDS.find(known => known === ownData(error, 'kind'))
  if (kind === undefined) return undefined
  const status = ownData(error, 'status')
  return kind === 'http' && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? { kind, status }
    : { kind }
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
  const usage = ownData(error, 'usage')
  return checkedUsage({
    inputTokens: ownData(usage, 'inputTokens'),
    outputTokens: ownData(usage, 'outputTokens'),
    costUsd: ownData(usage, 'costUsd'),
  })
}

/** Who requests a provider call, as its `call` event names it: `lens` only for a vote. */
export interface Requester {
  readonly profile: string
  readonly role: 'research' | 'vote'
  readonly lens?: string
}

/**
 * A provider as a run holds it: the ref captured now, which events and meta report, and its
 * deadline and retries, each read as own data and taken only when it passes its check, else the
 * default: 600000 ms and no retry. The quorum's checks ran first, so a plain object's values are the
 * ones they passed; a proxy that answers the check and this read differently still gets an in-range
 * deadline and no retry, never an unbounded one. The worst case it states is its own data value when
 * that is a function, else none, and so is the room it states: a getter is never run, and an inherited method
 * states nothing.
 */
export function targetOf(provider: Provider): Target {
  const timeoutMs = ownData(provider, 'timeoutMs')
  const retries = ownData(provider, 'retries')
  const worstCase = ownData(provider, 'worstCase')
  const room = ownData(provider, 'room')
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
 * Call a provider inside the review's concurrency limit and return its reply text. The review's
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
 * A call that fails once its request is built, for any reason, ends through one place: it sends its
 * failed `call` event when an attempt was made, then hands that failure and the attempts made, 0 when
 * none, to `onFailure`, once, inside its slot, and rethrows. The research stage aborts the review there
 * for a gating profile, so the queued call the slot goes to next never starts; a failed vote has no
 * `onFailure`: the panel records it. The duration is measured inside the slot, from the first attempt,
 * once the request is built, to the call's end, the waits included: the provider's latency, not the time
 * the call waited for a slot or for room, or took to build its request. A reply whose text is not a string
 * is a `ProviderError`. Each call emits one `call` event, which names the provider by the ref captured at
 * creation, never by the live object, and counts its attempts when it made more than one: failed, before
 * the error is rethrown, with the usage summed over its attempts when their counts are valid, or ok, with
 * that usage; both carry `spent`, the sum of what its attempts settled at. The ok event is emitted outside
 * the `try` that catches the provider's failure, so a sink that throws on it is never reported as a failed
 * call.
 */
export async function callProvider(ctx: RunContext, requester: Requester, target: Target, buildRequest: () => CompletionRequest, onFailure?: (error: unknown, attempts: number) => void): Promise<string> {
  return ctx.limit(async () => {
    ctx.stop.throwIfAborted()
    const request = buildRequest()
    const reservation = reservationOf(target, request)
    const started = ctx.clock.now()
    const took = (): number => Math.round(ctx.clock.now() - started)
    let attempts = 0
    let usage: Usage | undefined
    let spent = 0
    let timedOut = false
    let response: CompletionResponse | undefined
    let replied: Usage | undefined
    /** Settles the attempt's reservation at `tokens`, which the call's `spent` adds. */
    const settle = (tokens: number): void => {
      ctx.ledger.settle(reservation, tokens)
      spent += tokens
    }
    /** Ends the call with `error`: its failed event when an attempt was made, then `onFailure`; the error to throw. */
    const end = (error: unknown): unknown => {
      if (attempts > 0) {
        ctx.emit({
          type: 'call',
          ...requester,
          provider: target.ref,
          durationMs: took(),
          ok: false,
          ...counted(attempts, usage, spent),
        })
      }
      // Still inside the slot: a review aborted here never starts the queued call the slot goes to next.
      onFailure?.(error, attempts)
      return error
    }
    while (response === undefined) {
      try {
        await ctx.ledger.reserve(reservation, ctx.stop)
      } catch (error) {
        throw end(error)
      }
      attempts += 1
      try {
        const reply = await attempt(ctx, target, request)
        if (typeof reply?.text !== 'string') throw new ProviderError({ providerId: target.ref.id, kind: 'invalid-response', message: 'returned no reply text' })
        // The reply's usage is read once, so its settlement and its event cannot disagree.
        replied = checkedUsage(reply.usage)
        settle(settlementOf(reservation, replied))
        response = reply
      } catch (error) {
        const reported = failureUsage(error)
        usage = addUsage(usage, reported)
        const facts = failureFacts(error)
        settle(settlementOf(reservation, reported, facts))
        // A stopped review is asked as if it had time to spare, so a retry only the stop prevents is the stop's doing.
        const wait = retryWait(facts, {
          retried: attempts - 1,
          retries: target.retries,
          timedOut,
          timeLeftMs: ctx.stop.aborted
            ? Number.POSITIVE_INFINITY
            : ctx.deadline.at - ctx.clock.now(),
        }, ctx.clock.random)
        if (wait === undefined) throw end(error)
        if (ctx.stop.aborted) throw end(ctx.stop.reason)
        timedOut ||= isTimeout(facts)
        try {
          await pause(ctx, wait)
        } catch (stopped) {
          throw end(stopped)
        }
      }
    }
    ctx.emit({
      type: 'call',
      ...requester,
      provider: target.ref,
      durationMs: took(),
      ok: true,
      ...counted(attempts, addUsage(usage, replied), spent),
    })
    return response.text
  })
}

/** The fields of a `call` event that hold what the call's attempts add up to: their number when above one, their summed usage when valid, and the tokens the cap counted. */
function counted(attempts: number, usage: Usage | undefined, spent: number): { attempts?: number, usage?: Usage, spent: number } {
  return {
    ...(attempts > 1
      ? { attempts }
      : {}),
    ...(usage === undefined
      ? {}
      : { usage }),
    spent,
  }
}

/** What the retry policy reads of a thrown value: its `kind`, `status`, `retryable` and `retryAfterMs` as own data, so a getter decides nothing and never runs. */
function failureFacts(error: unknown): FailureFacts {
  return {
    kind: ownData(error, 'kind'),
    status: ownData(error, 'status'),
    retryable: ownData(error, 'retryable'),
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
 * reason; the review's stop, its abort or its deadline, with the stop's reason. The attempt's timer
 * and the join to the review's stop go when it settles, on every path. A provider that throws before
 * it returns a promise, or returns a plain object, is handled; whatever it does once the attempt
 * settled is caught and ignored, and it is never an unhandled rejection. The join is one listener,
 * not `AbortSignal.any`, so nothing builds up on a signal that outlives thousands of attempts.
 */
function attempt(ctx: RunContext, target: Target, request: CompletionRequest): Promise<CompletionResponse> {
  if (ctx.stop.aborted) return Promise.reject(ctx.stop.reason)
  const controller = new AbortController()
  return new Promise<CompletionResponse>((resolve, reject) => {
    let settled = false
    let cancel = (): void => {}
    /** True the first time, when it clears the timer and the listener; false once the attempt has settled. */
    function done(): boolean {
      if (settled) return false
      settled = true
      cancel()
      ctx.stop.removeEventListener('abort', onAbort)
      return true
    }
    function onAbort(): void {
      if (!done()) return
      controller.abort(ctx.stop.reason)
      reject(ctx.stop.reason)
    }
    cancel = ctx.clock.timer(target.timeoutMs, () => {
      if (!done()) return
      const error = new ProviderError({ providerId: target.ref.id, kind: 'timeout', message: `no reply within ${target.timeoutMs} ms` })
      controller.abort(error)
      reject(error)
    })
    ctx.stop.addEventListener('abort', onAbort, { once: true })
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
 * the stage produced from its result.
 */
export async function stage<T>(ctx: RunContext, profile: string, name: StageName, step: () => T, count: (result: Awaited<T>) => number): Promise<Awaited<T>> {
  ctx.signal.throwIfAborted()
  ctx.emit({ type: 'stage:start', profile, stage: name })
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
