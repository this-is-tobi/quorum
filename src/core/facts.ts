import { NO_ANSWERS, PROVIDER_ERROR_KINDS } from './errors.ts'
import type { NoAnswer, ProviderErrorKind } from './errors.ts'
import { isRecord } from './output.ts'
import type { RateLimit } from './ports.ts'
import type { FailureFacts } from './retry.ts'
import type { Usage } from './types.ts'

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
 * stream, to which a provider that may not step down has one fix. A `timeout` whose own data `stalledMs` is a positive safe
 * integer says so, as `stalledMs`: a stream that showed no progress for that long.
 */
export function providerFailure(error: unknown): { readonly kind: ProviderErrorKind, readonly status?: number, readonly exhausted?: true, readonly refused?: 'stream', readonly stalledMs?: number } | undefined {
  const kind = PROVIDER_ERROR_KINDS.find(known => known === ownData(error, 'kind'))
  if (kind === undefined) return undefined
  if (kind === 'timeout') {
    const stalledMs = ownData(error, 'stalledMs')
    return typeof stalledMs === 'number' && Number.isSafeInteger(stalledMs) && stalledMs >= 1
      ? { kind, stalledMs }
      : { kind }
  }
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
  return ownUsage(ownData(error, 'usage'))
}

/** The usage an object holds as own data, when its counts can be trusted: never a getter run, an inherited field read or a throw. */
export function ownUsage(usage: unknown): Usage | undefined {
  return checkedUsage({
    inputTokens: ownData(usage, 'inputTokens'),
    outputTokens: ownData(usage, 'outputTokens'),
    costUsd: ownData(usage, 'costUsd'),
  })
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

/** Whether `error` is a failure of kind `http` with status 400 or 422, as own data: the server read the request and refused its value. */
export function isRefusal(error: unknown): boolean {
  const read = providerFailure(error)
  return read?.kind === 'http' && (read.status === 400 || read.status === 422)
}

/**
 * What the retry policy reads of a thrown value: its `kind`, `status`, `retryable` and `retryAfterMs` as own data, so a
 * getter decides nothing and never runs. An `http` failure whose own data `exhausted` is `true` is never retryable,
 * whatever it says of `retryable`, as a `ProviderError`'s own `exhausted` makes it.
 */
export function failureFacts(error: unknown): FailureFacts {
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

const RATE_LIMIT_FIELDS = [
  'requests',
  'tokens',
  'tokensLimit',
  'requestsResetMs',
  'tokensResetMs',
] as const

/**
 * The rate-limit headers a reply, a failure or a stream's headers signal states, as numbers alone: each field is read as own data and
 * kept when it is a finite number of at least 0, so a getter never runs, an inherited field is never read and nothing else is copied.
 * Undefined when none is left.
 */
export function rateLimitFacts(value: unknown): RateLimit | undefined {
  const facts: { -readonly [Field in keyof RateLimit]: number } = {}
  for (const field of RATE_LIMIT_FIELDS) {
    const stated = ownData(value, field)
    if (typeof stated === 'number' && Number.isFinite(stated) && stated >= 0) facts[field] = stated
  }
  return Object.keys(facts).length === 0
    ? undefined
    : facts
}
