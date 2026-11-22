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
  /**
   * The tokens the core budgets for this reply, thinking included: a whole number of at least 1, which an
   * adapter counts in its size guard and sends as the server's limit, at most its `maxTokens` when it has one.
   * Absent, the request states none, and an adapter reserves its `maxTokens`, else 16000.
   */
  replyTokens?: number
  /**
   * A lowered thinking level the core asks for after a reply ran out of room while reasoning: `low` or `off`. An
   * adapter honours it only when its `adapts` states a `thinking`, so a level the options set is never undone.
   */
  thinking?: 'low' | 'off'
  /**
   * `prompt` when the core moved the provider to prompt mode after an empty reply or a refused field: the reply
   * shape is then described in the prompt alone. An adapter honours it only when its `adapts` states `prompt`.
   */
  structuredOutput?: 'prompt'
  /**
   * `false` when the core moved the provider to whole replies, after a server refused streaming or answered a streamed
   * call whole, and `'bare'` when it moved it to a stream with no stream options, after a server refused them. An
   * adapter honours either only when its `adapts` states a `stream`, so a setting the options hold is never undone.
   */
  stream?: false | 'bare'
  /** Hears each sign of life of a streamed reply, as the adapter reads it: the headers, each data event and each keep-alive. */
  onProgress?: (signal: StreamSignal) => void
  /** The attempt's own signal: aborted with the review's, or at the attempt's deadline. */
  signal?: AbortSignal
}

/**
 * What an adapter reports of a streamed reply as it reads it, which the core reads as proof of life: the reply's headers
 * came, a data event came with the output tokens so far, a whole number (the larger of the server's own count, floored,
 * and a quarter of the characters streamed) and whether an answer or reasoning has shown text yet, or a keep-alive came. Numbers and booleans only.
 */
export type StreamSignal
  = | { readonly kind: 'headers', readonly rateLimit?: RateLimit }
    | { readonly kind: 'data', readonly outputTokens: number, readonly answer: boolean, readonly reasoning: boolean }
    | { readonly kind: 'keep-alive' }

/**
 * What a reply's rate-limit headers state, each as a number, and only the ones the reply sent and the adapter could read:
 * the requests and the tokens left in the window, the tokens' limit, and how long until the requests' and the tokens'
 * counts reset, in milliseconds. Numbers only: no header value is ever kept as text.
 */
export interface RateLimit {
  readonly requests?: number
  readonly tokens?: number
  readonly tokensLimit?: number
  readonly requestsResetMs?: number
  readonly tokensResetMs?: number
}

/**
 * What a provider returns: the reply text, the model that produced it and, when reported, its usage.
 * `model` is server text: nothing shows or stores it today, and whatever does must render it through
 * the sanitizer. `reasoning` is `true` when the reply showed reasoning, `false` when the adapter could tell it
 * showed none, and absent when it cannot tell, as for a provider with no way to read it.
 */
export interface CompletionResponse {
  text: string
  model: string
  usage?: Usage
  reasoning?: boolean
  /** `true` when the request streamed and the server answered it whole: the core then asks that provider for whole replies for the rest of the review. */
  whole?: true
  /** What the reply's rate-limit headers stated, when it sent any the adapter read. */
  rateLimit?: RateLimit
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
 * What is wrong with a stated count of tokens, `window` or `maxTokens`, worded with what to write, or undefined
 * for a whole number of at least 1. The value is never quoted: it may be anything.
 */
export function tokensProblem(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? undefined
    : 'must be a whole number of tokens of at least 1'
}

/** What is wrong with a stated `thinking`, worded with what to write, or undefined for `default`, `low` or `off`. The value is never quoted. */
export function thinkingProblem(value: unknown): string | undefined {
  return value === 'default' || value === 'low' || value === 'off'
    ? undefined
    : 'must be default, low or off'
}

/** What a provider lets the core change by itself for the rest of a review: the level a lowering sends, prompt mode, and the stream's two steps down. */
export interface Adapts {
  readonly thinking?: 'low' | 'off'
  readonly prompt?: true
  readonly stream?: true
}

/**
 * What is wrong with a stated `adapts`, worded with what to write, or undefined for an object whose `thinking`
 * is `low` or `off` and whose `prompt` and `stream` are `true`, each optional. The fields are read as own data, so a getter
 * never runs. The value is never quoted.
 */
export function adaptsProblem(value: unknown): string | undefined {
  const problem = 'must be an object whose thinking is low or off and whose prompt and stream are true, each optional'
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return problem
  const field = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined
  }
  const thinking = field('thinking')
  const prompt = field('prompt')
  const stream = field('stream')
  return (thinking === undefined || thinking === 'low' || thinking === 'off') && (prompt === undefined || prompt === true) && (stream === undefined || stream === true)
    ? undefined
    : problem
}

/** What is wrong with a stated `streams`, worded with what to write, or undefined for `true`: a provider that does not stream states nothing. The value is never quoted. */
export function streamsProblem(value: unknown): string | undefined {
  return value === true
    ? undefined
    : 'must be true'
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
   * The deadline of one attempt, in whole milliseconds from 1000 to 518400000; unset, the core derives each attempt's
   * ceiling from its reply budget, from `DEFAULT_TIMEOUT_MS` up to a day (`attemptCeiling`). At it the core aborts the
   * attempt's signal and fails the attempt as a timeout, whatever the provider does. It is read when the quorum is
   * created, as an own data property: a getter is never run and an inherited property states nothing, so a class
   * sets it as a field.
   */
  readonly timeoutMs?: number
  /**
   * How long a streamed attempt may show no progress before the core fails it as a timeout, in whole milliseconds
   * from 1000 to 86400000. Unset, the core learns the window from the provider's own streams in the review
   * (`Clocks.window`). It applies only to a provider that states `streams`, and is read as `timeoutMs` is.
   */
  readonly stallTimeoutMs?: number
  /**
   * How often the core retries a call that failed in passing, after its first attempt: a whole
   * number from 0 to 5; none when unset, since a provider that retries by itself must not be
   * retried again. The core retries only a `network`, `timeout` or `http` failure that says it may
   * be retried, and never a call's second timeout. It is read when the quorum is created, as
   * an own data property, as `timeoutMs` is.
   */
  readonly retries?: number
  /**
   * The most tokens, input and output, that one attempt of `request` may spend as the provider is billed
   * for it, which is what the core reserves for each attempt of the request. It is called once per call,
   * once the request is built; a result that is not a whole number of at least 1, or a throw, states
   * nothing, and the core then reserves its own count of the request plus 512 tokens for what a server
   * adds and 16000 for the reply, as it does when this is unset. It is read when the quorum is created,
   * as an own data property, as `timeoutMs` is: a getter is never run and an inherited method states
   * nothing, so a class sets it as an arrow-function field.
   */
  readonly worstCase?: (request: CompletionRequest) => number
  /**
   * How many more tokens of text `request` could hold and still fit the provider's window, counted as its
   * size guard counts: negative when it does not fit, 0 when it fits exactly, so a request at a room of 0
   * is sent and one at -1 is refused, and text added to the request lowers the room by its count. It is
   * called once per question, synchronously; a result that is no safe integer, a promise or a throw states
   * nothing, and the core then reviews as it does when this is unset. It is read when the quorum is
   * created, as an own data property, as `worstCase` is: a getter is never run and an inherited method
   * states nothing, so a class sets it as an arrow-function field.
   */
  readonly room?: (request: CompletionRequest) => number
  /**
   * The model's context window in tokens, prompt and reply together: a whole number of at least 1, which the
   * core sizes the reply budgets from. A provider that states none is reserved and asked as it always was. It
   * is read when the quorum is created, as an own data property, as `timeoutMs` is.
   */
  readonly window?: number
  /**
   * The most tokens a reply may hold, a whole number of at least 1: the ceiling of every reply the provider
   * gives, which the core never asks more than. It is read when the quorum is created, as an own data
   * property, as `timeoutMs` is.
   */
  readonly maxTokens?: number
  /**
   * How much the provider thinks: `default` (the server's own, and what a provider that states nothing is
   * taken to do), `low` or `off`. The core leaves room for the thinking a level allows when it sizes a reply.
   * It is read when the quorum is created, as an own data property, as `timeoutMs` is.
   */
  readonly thinking?: 'default' | 'low' | 'off'
  /**
   * What the core may change for the rest of a review, once, when a reply calls for it: `thinking`, the level it
   * lowers to (`low` or `off`) when a reply runs out of room while reasoning or holds only reasoning, and `prompt`,
   * set when it may move the provider from JSON mode to prompt mode on an empty reply or a refused field, and `stream`,
   * set when it may move the provider from a stream to a stream with no stream options, then to whole replies, after a
   * server refused either, or to whole replies when a server answered a streamed call whole. State
   * each only when it is automatic: a provider whose thinking or structured output is set, or whose body sets the
   * control itself, states none, and the core never moves it. A provider that states `adapts` honours the
   * request's `thinking` and `structuredOutput`. It is read when the quorum is created, as an own data
   * property, as `timeoutMs` is.
   */
  readonly adapts?: Adapts
  /**
   * `true` when the provider streams its replies: it reads each reply as it arrives and reports it through the request's
   * `onProgress`. State it only when the provider streams as it is set up: one whose `stream` option is `false` states
   * none. It is read when the quorum is created, as an own data property, as `timeoutMs` is.
   */
  readonly streams?: true
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

/**
 * One call kept by a `ReplyStore`: the reply of a call that passed its check, or, for a research call whose reply was cut
 * off or listed as many findings as it was asked for at most, a marker that holds what it lacked and the usage it was
 * charged and never any text. A marker only ever sends a part to recovery: it can make nothing read as clean.
 */
export type StoredCall
  = | { readonly reply: { readonly text: string, readonly model: string, readonly usage?: Usage } }
    | { readonly lacked: { readonly noAnswer: 'reply' | 'thinking' | 'window' | 'saturated', readonly usage?: Usage } }

/**
 * Where a review keeps the calls it paid for and finds them again on a rerun. A request's `key` is the core's: a hash of
 * what the request was sent as (see `callProvider`), never of its bytes, which differ by a nonce each time; `provider` is
 * the id of the provider it went to, so a store may tell two providers' calls apart as it sees fit. What a store gives back
 * is as untrusted as a reply: the core reads it as own data, checks a stored reply as a fresh one, and takes a
 * `get` or a `put` that throws or rejects, or that never settles in a review that is stopped, for a miss or a write
 * that failed. A review that is given a store spends nothing on a call the store holds.
 */
export interface ReplyStore {
  readonly get: (entry: { readonly key: string, readonly provider: string }) => Promise<StoredCall | undefined>
  readonly put: (entry: { readonly key: string, readonly provider: string }, call: StoredCall) => Promise<void>
}
