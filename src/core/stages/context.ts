import type { Clock } from '../clock.ts'
import type { Limiter } from '../concurrency.ts'
import { ProviderError } from '../errors.ts'
import { isRecord } from '../output.ts'
import { DEFAULT_TIMEOUT_MS, MAX_STATED_TIMEOUT_MS, timeoutProblem } from '../ports.ts'
import type { CompletionRequest, CompletionResponse, EventSink, Provider } from '../ports.ts'
import type { ProviderRef, StageName, Thresholds, Usage } from '../types.ts'

/**
 * A provider as a compiled profile holds it: the object it calls, the ref captured at creation that
 * events and meta report, and the deadline of each of its attempts.
 */
export interface Target {
  readonly provider: Provider
  readonly ref: Readonly<ProviderRef>
  /** The deadline of one attempt, in milliseconds: what the provider stated when the quorum was created, else the default. */
  readonly timeoutMs: number
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
  /** Delivers one event of the review to the sink, as a copy; it delivers nothing once the review is aborted. */
  readonly emit: EventSink
  /**
   * Aborted when the caller's signal is, when the event sink throws, when a profile's research fails
   * or when the profiles' run rejects: every stage and every call checks it, and every attempt
   * carries a signal of its own, which this one and the attempt's deadline abort.
   */
  readonly signal: AbortSignal
  /**
   * Aborts the review with `error`, unless it is already aborted, so a caller's abort reason or a
   * sink's error stays the reason. A research failure, the call or its reply, calls it where it
   * fails, so no other profile starts a call after it; a research request refused as too large is
   * a gap, not a failure, and does not.
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

/** What a refusal as too large says: its own data string `message`, else a fixed text, never anything else from the object. */
export function refusalMessage(refusal: unknown): string {
  const message = ownData(refusal, 'message')
  return typeof message === 'string'
    ? message
    : REFUSAL_FALLBACK
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
 * deadline, read as own data and taken only when it passes its check, else the default. The quorum's
 * checks ran first, so a plain object's value is the one they passed; a proxy that answers the
 * check and this read differently still gets an in-range deadline, never an unbounded one.
 */
export function targetOf(provider: Provider): Target {
  const stated = ownData(provider, 'timeoutMs')
  return {
    provider,
    ref: Object.freeze({ id: provider.id, model: provider.model }),
    timeoutMs: timeoutProblem(stated, MAX_STATED_TIMEOUT_MS) === undefined
      ? stated as number
      : DEFAULT_TIMEOUT_MS,
  }
}

/** Whole milliseconds since `started`, a `performance.now()` reading. */
export function elapsed(started: number): number {
  return Math.round(performance.now() - started)
}

/**
 * Call a provider inside the review's concurrency limit and return its reply text. The review's
 * signal is checked inside the slot, before the request is built, so a call still queued when the
 * review is aborted never starts. `buildRequest` runs inside the slot once that check passes: a
 * request holds the diff or a section of it, and building it only there keeps the requests a
 * review holds at once to its concurrency, whatever the number of findings and lenses (ADR-0009).
 * The attempt has the provider's deadline, and the provider is handed the attempt's own signal, so
 * it can stop a call in flight: the review's abort settles the attempt at once, without waiting for
 * the provider. A failed research call aborts the review through `ctx.fail` before it leaves its
 * slot, so the queued call the slot goes to next never starts, unless the provider refused the
 * request as too large: that refusal is a gap, never a reason to stop the other profiles, so the
 * research stage records it. A failed vote does not abort the review, since the panel records it.
 * The duration is measured inside the slot, once the request is built: the provider's latency, not
 * the time the call waited for a slot or took to build its request. A reply whose text is not a
 * string is a `ProviderError`. Each call emits one `call` event, which names the provider by the ref
 * captured at creation, never by the live object: failed, before the error is rethrown, with the
 * usage its error carries when its counts are valid, or ok, with the usage when its counts are
 * valid. The ok event is emitted outside the `try` that catches the provider's failure, so a sink
 * that throws on it is never reported as a failed call.
 */
export async function callProvider(ctx: RunContext, requester: Requester, target: Target, buildRequest: () => CompletionRequest): Promise<string> {
  return ctx.limit(async () => {
    ctx.signal.throwIfAborted()
    const request = buildRequest()
    const started = ctx.clock.now()
    const took = (): number => Math.round(ctx.clock.now() - started)
    let response: CompletionResponse
    try {
      response = await attempt(ctx, target, request)
      if (typeof response?.text !== 'string') throw new ProviderError({ providerId: target.ref.id, kind: 'invalid-response', message: 'returned no reply text' })
    } catch (error) {
      const failedUsage = failureUsage(error)
      ctx.emit({
        type: 'call',
        ...requester,
        provider: target.ref,
        durationMs: took(),
        ok: false,
        ...(failedUsage === undefined
          ? {}
          : { usage: failedUsage }),
      })
      // Still inside the slot: the queued call it is handed to next sees the abort and never starts.
      if (requester.role === 'research' && !isTooLarge(error)) ctx.fail(error)
      throw error
    }
    const usage = checkedUsage(response.usage)
    ctx.emit({
      type: 'call',
      ...requester,
      provider: target.ref,
      durationMs: took(),
      ok: true,
      ...(usage === undefined
        ? {}
        : { usage }),
    })
    return response.text
  })
}

/**
 * One attempt of a call, settled once, by the first of: the provider's reply or failure; the
 * deadline, as a `timeout` error of the core's own with the attempt's signal aborted with it as the
 * reason; the review's abort, with its reason. The deadline's timer and the join to the review's
 * signal go when it settles, on every path. A provider that throws before it returns a promise, or
 * returns a plain object, is handled; whatever it does once the attempt settled is caught and
 * ignored, and it is never an unhandled rejection. The join is one listener, not `AbortSignal.any`,
 * so nothing builds up on a signal that outlives thousands of attempts.
 */
function attempt(ctx: RunContext, target: Target, request: CompletionRequest): Promise<CompletionResponse> {
  if (ctx.signal.aborted) return Promise.reject(ctx.signal.reason)
  const controller = new AbortController()
  return new Promise<CompletionResponse>((resolve, reject) => {
    let settled = false
    let cancel = (): void => {}
    /** True the first time, when it clears the timer and the listener; false once the attempt has settled. */
    function done(): boolean {
      if (settled) return false
      settled = true
      cancel()
      ctx.signal.removeEventListener('abort', onAbort)
      return true
    }
    function onAbort(): void {
      if (!done()) return
      controller.abort(ctx.signal.reason)
      reject(ctx.signal.reason)
    }
    cancel = ctx.clock.timer(target.timeoutMs, () => {
      if (!done()) return
      const error = new ProviderError({ providerId: target.ref.id, kind: 'timeout', message: `no reply within ${target.timeoutMs} ms` })
      controller.abort(error)
      reject(error)
    })
    ctx.signal.addEventListener('abort', onAbort, { once: true })
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
