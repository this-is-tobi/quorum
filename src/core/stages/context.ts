import type { Limiter } from '../concurrency.ts'
import { ProviderError } from '../errors.ts'
import { isRecord } from '../output.ts'
import type { CompletionRequest, CompletionResponse, EventSink, Provider } from '../ports.ts'
import type { ProviderRef, StageName, Thresholds, Usage } from '../types.ts'

/** A provider as a compiled profile holds it: the object it calls, and the ref captured at creation that events and meta report. */
export interface Target {
  readonly provider: Provider
  readonly ref: Readonly<ProviderRef>
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
   * or when the profiles' run rejects: every stage and every call checks it, and every request
   * carries it.
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
}

/** What a refusal as too large says when it holds no message of its own. */
const REFUSAL_FALLBACK = 'refused as too large'

/** The value of an own data property of an object, else undefined: a getter is never run, an inherited property or a throwing proxy never matches. */
function ownData(value: unknown, key: string): unknown {
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

/** Who requests a provider call, as its `call` event names it: `lens` only for a vote. */
export interface Requester {
  readonly profile: string
  readonly role: 'research' | 'vote'
  readonly lens?: string
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
 * The request carries the signal, so the provider can stop a call in flight. A failed research
 * call aborts the review through `ctx.fail` before it leaves its slot, so the queued call the slot
 * goes to next never starts, unless the provider refused the request as too large: that refusal is
 * a gap, never a reason to stop the other profiles, so the research stage records it. A failed vote
 * does not abort the review, since the panel records it. The duration is measured inside the slot,
 * once the request is built: the provider's latency, not the time the call waited for a slot or
 * took to build its request. A reply whose text is not a string is a `ProviderError`. Each call
 * emits one `call` event, which names the provider by the ref captured at creation, never by the
 * live object: failed, before the error is rethrown, or ok, with the usage when its counts are
 * valid. The ok event is emitted outside the `try` that catches the provider's failure, so a sink
 * that throws on it is never reported as a failed call.
 */
export async function callProvider(ctx: RunContext, requester: Requester, target: Target, buildRequest: () => CompletionRequest): Promise<string> {
  return ctx.limit(async () => {
    ctx.signal.throwIfAborted()
    const request = buildRequest()
    const started = performance.now()
    let response: CompletionResponse
    try {
      response = await target.provider.complete({ ...request, signal: ctx.signal })
      if (typeof response?.text !== 'string') throw new ProviderError({ providerId: target.ref.id, kind: 'invalid-response', message: 'returned no reply text' })
    } catch (error) {
      ctx.emit({
        type: 'call',
        ...requester,
        provider: target.ref,
        durationMs: elapsed(started),
        ok: false,
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
      durationMs: elapsed(started),
      ok: true,
      ...(usage === undefined
        ? {}
        : { usage }),
    })
    return response.text
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
