import type { QuorumEvent, Usage } from './types.ts'

/** A JSON Schema document, as produced by z.toJSONSchema. */
export type JsonSchema = Record<string, unknown>

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** One model call: instructions in `system`, attacker-influenced data only in `messages` (ADR-0007). */
export interface CompletionRequest {
  system: string
  messages: readonly ChatMessage[]
  /** The reply shape the caller validates against; adapters may also use it for native enforcement. */
  output: { name: string, schema: JsonSchema }
  /** The attempt's own signal: aborted with the review's, or at the attempt's deadline. */
  signal?: AbortSignal
}

/**
 * What a provider returns: the reply text, the model that produced it and, when reported, its usage.
 * `model` is server text: nothing shows or stores it today, and whatever does must render it through
 * the sanitizer.
 */
export interface CompletionResponse {
  text: string
  model: string
  usage?: Usage
}

/** The deadline of an attempt when its provider states none: ten minutes. */
export const DEFAULT_TIMEOUT_MS = 600_000
/** The shortest deadline: one second. */
export const MIN_TIMEOUT_MS = 1000
/** The longest deadline an option, a config or a variable sets: 24 hours. */
export const MAX_TIMEOUT_MS = 86_400_000
/** The most retries a call is given. */
export const MAX_RETRIES = 5
/**
 * The retries a shipped adapter states when its options set none: two. A provider that states none
 * gets no retry, since the core must not retry what may retry by itself.
 */
export const DEFAULT_RETRIES = 2
/**
 * The longest deadline a provider states: six times `MAX_TIMEOUT_MS`, since a provider that runs
 * the retries itself states the deadline of its whole call, `timeoutMs` times `MAX_RETRIES + 1`.
 */
export const MAX_STATED_TIMEOUT_MS = MAX_TIMEOUT_MS * (MAX_RETRIES + 1)

/**
 * What is wrong with a deadline, worded with what to write, or undefined for a safe integer from
 * `MIN_TIMEOUT_MS` to `max`. The value is never quoted: it may be anything.
 */
export function timeoutProblem(value: unknown, max: number = MAX_TIMEOUT_MS): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= max
    ? undefined
    : `must be a whole number of milliseconds from ${MIN_TIMEOUT_MS} to ${max}`
}

/**
 * What is wrong with a count of retries, worded with what to write, or undefined for a whole number
 * from 0 to `MAX_RETRIES`. The value is never quoted: it may be anything.
 */
export function retriesProblem(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_RETRIES
    ? undefined
    : `must be a whole number from 0 to ${MAX_RETRIES}`
}

/**
 * A model behind a port: it receives text and returns text (invariant I1). No environment value, key
 * or credential appears in a request; keys live in adapters only. The core never trusts the reply
 * and extracts and validates it itself.
 */
export interface Provider {
  readonly id: string
  readonly model: string
  /**
   * The deadline of one attempt, in whole milliseconds from 1000 to 518400000; `DEFAULT_TIMEOUT_MS`
   * when unset. At it the core aborts the attempt's signal and fails the attempt as a timeout,
   * whatever the provider does. It is read once, when the quorum is created, as an own data
   * property: a getter is never run and an inherited property states nothing, so a class sets it as
   * a field.
   */
  readonly timeoutMs?: number
  /**
   * How often the core retries a call that failed in passing, after its first attempt: a whole
   * number from 0 to 5; none when unset, since a provider that retries by itself must not be
   * retried again. The core retries only a `network`, `timeout` or `http` failure that says it may
   * be retried, and never a call's second timeout. It is read once, when the quorum is created, as
   * an own data property, as `timeoutMs` is.
   */
  readonly retries?: number
  /**
   * Answer one request. It should honour `request.signal`, settling soon after the signal aborts:
   * the core settles the call at its deadline or at the review's abort without waiting for the
   * provider, and a provider that ignores the signal works on, outside the review, until it ends.
   */
  complete: (request: CompletionRequest) => Promise<CompletionResponse>
}

/** Receives every event of a review, synchronously and in order, each as a copy. */
export type EventSink = (event: QuorumEvent) => void

/** The providers of one profile: its research provider, and one voter per lens keyed by lens id. */
export interface ProfilePorts {
  readonly research: Provider
  readonly voters: Readonly<Record<string, Provider>>
}

/** What a quorum is wired to: the providers of every profile, keyed by profile id, and an optional event sink. */
export interface QuorumPorts {
  readonly profiles: Readonly<Record<string, ProfilePorts>>
  /** The sink that receives every event of a review, synchronously and in order, each as a copy. */
  readonly events?: EventSink
}
