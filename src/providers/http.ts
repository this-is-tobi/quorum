/**
 * The one path every HTTP adapter sends a request through, and what is read of its reply: the stream, the failure, and the
 * rate-limit headers, which are the provider's own replies alone (ADR-0013), read as numbers and never copied.
 */
import { ProviderError } from '../core/errors.ts'
import type { CompletionResponse, RateLimit, StreamSignal } from '../core/ports.ts'
import { ndjsonItems, sseItems } from './stream.ts'
import type { StreamItem } from './stream.ts'

const MAX_ERROR_BODY = 500
/**
 * Enough of an error body for its 500-character snippet: the rest is never read, and `snippet` redacts no
 * more of any text than this. The body is cut at this byte before it is redacted, so the cap must stay
 * far above the quote, or a key cut in half at the cap could survive into the message.
 */
const MAX_ERROR_BYTES = 64 * 1024
/** A reply body over this many bytes is refused: the core refuses reply text over 1,000,000 characters anyway. */
const MAX_REPLY_BYTES = 16 * 1024 * 1024

/** The symbol under which Node keeps the dispatcher its `fetch` uses. */
const NODE_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1')

/** What stands for a redacted value. A provider imports no core module beyond ports, errors, types and tokens, so this is a copy of `REDACTED` in `core/result-schema.ts`, which `http.spec.ts` holds equal. */
const REDACTED = '[redacted]'
const UNKNOWN_ENDPOINT = 'the endpoint'
const PLAIN_IDENTIFIER = /^[A-Z]\w{0,39}$/i
/** A wait as a header writes it: decimal digits with an optional fraction. Never a sign, an exponent, a hexadecimal or a list. */
const DECIMAL = /^\d+(?:\.\d+)?$/
/** The one date form read: an IMF-fixdate. Both engines read the others as local time, or `1` as a year. */
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/
/** The codes of OpenAI that say a credit or a spend limit is used up: a retry cannot succeed, and would be billed. */
const SPEND_CODES: ReadonlySet<string> = new Set([
  'billing_hard_limit_reached',
  'credit_balance_exhausted',
  'organization_usage_limit_exceeded',
  'insufficient_quota',
])
const SPEND_LIMIT_SUFFIX = '_spend_limit_exceeded'
/** A count as a header writes it: decimal digits, at most 15, so it is exact. Never a sign, a fraction, an exponent or a list. */
const COUNT = /^\d{1,15}$/
/** A Go duration as OpenAI writes a reset: one or more parts of digits with an optional fraction and a unit, such as `6m0s`, `20ms` or `1.5s`. */
const GO_DURATION = /^(?:\d{1,15}(?:\.\d{1,15})?(?:ms|[smh]))+$/
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ms|[smh])/g
const GO_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
}
/** The one date form of Anthropic's resets: an RFC 3339 date and time with its zone. Matched by shape before `Date.parse` reads it. */
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const ANTHROPIC_SPEND_CODE = 'enforced_spend_limit_reached'
/** The starts of the message of Anthropic's 400 for a usage limit its user set: a code word of the account, never copied. */
const ANTHROPIC_USAGE_LIMITS: readonly string[] = [
  'You have reached your specified API usage limits',
  'You have reached your specified workspace API usage limits',
]
/** The `limit_source` values of OpenRouter's 402 that say its credit or a key's limit is used up. */
const OPENROUTER_EXHAUSTED: ReadonlySet<unknown> = new Set(['openrouter_credits', 'openrouter_key_limit'])
const OPENROUTER_IN_FLIGHT = 'openrouter_in_flight_budget'
/** A character a word is made of: a letter, a digit or an underscore. */
const WORD_CHARACTER = /^\w$/
/** A JSON unicode escape (a backslash, then u00 and two hex digits) for printable ASCII, U+0020 to U+007E. */
const ESCAPED_PRINTABLE_ASCII = /\\u00(2[0-9a-fA-F]|[3-6][0-9a-fA-F]|7[0-9a-eA-E])/g

/**
 * What an adapter reads of a failed reply's body that the status cannot: a wait the server asks for, in
 * milliseconds, a reason never to retry, and that the account's credit, quota or spend limit is used up. A hook
 * can add a hint, turn a retry off and say a quota is used up, never undo any of them: the vendor's own
 * verdict (`vendorExhausted`) is kept whatever a hook says.
 */
export interface ErrorHints {
  readonly retryAfterMs?: number
  readonly retryable?: false
  readonly exhausted?: true
}

export interface RequestOptions {
  providerId: string
  url: string
  headers?: Readonly<Record<string, string>>
  body: unknown
  signal?: AbortSignal
  /** Values redacted from any server text that echoes them: the key, the base URL's path and the header values. */
  redact?: readonly string[]
  /** What the adapter reads of a failed reply's body, handed the body parsed as JSON, or `undefined` when it is none. */
  errorHints?: (body: unknown) => ErrorHints
  /**
   * The names of the structured-output fields the request sent. A 400 or 422 whose body names one of them as a
   * whole word is marked `refused: 'structuredOutput'`, which lets the core move the provider to prompt mode. The
   * body is only matched, never copied: the mark is a code word.
   */
  formatFields?: readonly string[]
  /**
   * The names of the streaming fields the request sent, each with what a 400 or 422 that names it refused. The first
   * word the body names as a whole word marks the failure, before `formatFields` are read, so a body that names
   * `stream_options` is `streamOptions` and not `stream`. The body is only matched, never copied.
   */
  streamWords?: ReadonlyArray<{ readonly word: string, readonly refused: 'streamOptions' | 'stream' }>
}

/** What `postStream` reads beside the request: the body's format, its last event's sentinel, and who hears its signs of life. */
export interface PostStreamOptions extends RequestOptions {
  /** How a streamed body is read: as server-sent events, or as NDJSON. */
  readonly format: 'sse' | 'ndjson'
  /** The data a server-sent event holds when it is the protocol's last, such as OpenAI's `[DONE]`. */
  readonly sentinel?: string
  /** Hears the reply's headers once, and each keep-alive, as they are read. */
  readonly onProgress?: (signal: StreamSignal) => void
}

/** Every form in which a server may echo the secret. */
function echoedForms(secret: string): string[] {
  const asJson = JSON.stringify(secret).slice(1, -1)
  return [secret, asJson].flatMap(form => [
    form,
    form.replaceAll('/', '\\/'),
  ])
}

/** Go and .NET write `&`, `<`, `>` and `+` as escapes in JSON, so a key echoed by them would not match as is. */
function decodeEscapedAscii(text: string): string {
  return text.replace(ESCAPED_PRINTABLE_ASCII, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * The ranges of `text` that the forms cover, in order: every occurrence of every form, overlapping ones
 * included, with the ranges that overlap merged. Ranges that only touch stay apart.
 */
function coveredRanges(text: string, forms: readonly string[]): Array<[start: number, end: number]> {
  const found: Array<[start: number, end: number]> = []
  for (const form of forms) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) found.push([at, at + form.length])
  }
  found.sort((a, b) => a[0] - b[0])
  const merged: Array<[start: number, end: number]> = []
  for (const [start, end] of found) {
    const last = merged.at(-1)
    if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** `text` with each range the forms cover replaced by one marker, in one pass, so no marker is ever matched. */
function redactForms(text: string, forms: readonly string[]): string {
  let redacted = ''
  let copied = 0
  for (const [start, end] of coveredRanges(text, forms)) {
    redacted += `${text.slice(copied, start)}${REDACTED}`
    copied = end
  }
  return redacted + text.slice(copied)
}

/**
 * Server or model text made safe to put in an error message. The text is first cut to 64 KiB, as much as
 * an error body holds and far more than a quote shows, so a 16 MiB reply costs no more to quote than an
 * error body. Escaped ASCII in what is left is decoded, and each value in `redact` is matched as written
 * and with its own escapes decoded, so neither a value that holds an escape nor an escaped echo of one
 * survives. One pass covers every occurrence of every form, overlapping ones included, and replaces each
 * covered range with one marker, so values that overlap in the text are redacted whole, escaped or not,
 * and a marker is never matched again. This catches a server that echoes a value: a server that holds
 * the key can disguise it in any way, which no redaction can catch. Then the text is cut to `max`
 * characters, after the redaction so a value cut in half cannot survive, and written as one JSON string
 * so a line break cannot start a workflow command in a log.
 */
export function snippet(text: string, max: number, redact: readonly string[] = []): string {
  const head = text.slice(0, MAX_ERROR_BYTES)
  const written = redact.filter(value => value !== '').flatMap(echoedForms)
  if (written.length === 0) return JSON.stringify(head.slice(0, max))
  const forms = [
    ...new Set([
      ...written,
      ...written.map(decodeEscapedAscii),
    ]),
  ]
  return JSON.stringify(redactForms(decodeEscapedAscii(head), forms).slice(0, max))
}

/** The URL of an endpoint: the base URL without its trailing slashes, the endpoint's path, then the query. */
export function endpointUrl(baseUrl: string, path: string, query: Readonly<Record<string, string>> = {}): string {
  const search = new URLSearchParams(query).toString()
  return `${baseUrl.replace(/\/+$/, '')}${path}${search === ''
    ? ''
    : `?${search}`}`
}

/**
 * What a provider redacts from server text, each value once and no empty one: its key; its base URL's
 * path, which a server echoes in a 404 (`Cannot POST /<path>/chat/completions`) and which some gateways
 * use to carry a token; and the value of each of its headers, where a gateway's own credential goes,
 * as written and trimmed, since `fetch` sends it trimmed and a server echoes what it received. A value
 * that is blank once trimmed is left out: it holds no secret, and would redact every run of spaces.
 * The base URL must already have passed `baseUrlIssues`: `new URL` throws on one that does not parse,
 * and Node's `TypeError` carries the URL in `.input`.
 */
export function redactionsOf(baseUrl: string, apiKey: string | undefined, headers: Readonly<Record<string, string>> = {}): string[] {
  const path = new URL(baseUrl).pathname.replace(/\/+$/, '')
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // A path with a stray `%` is redacted as written.
  }
  const values = Object.values(headers).flatMap(value => [
    value,
    value.trim(),
  ])
  return [
    ...new Set([apiKey ?? '', path, decoded, ...values]),
  ].filter(value => value.trim() !== '')
}

/** The scheme, host and port of a URL: no credentials, path, query or fragment. */
export function originOf(url: string): string {
  try {
    const { origin } = new URL(url)
    return origin === 'null'
      ? UNKNOWN_ENDPOINT
      : origin
  } catch {
    return UNKNOWN_ENDPOINT
  }
}

/**
 * The origin of an http(s) URL as endpoints are compared: its scheme, its host in lower case without one
 * trailing dot (`api.groq.com.` names `api.groq.com`), and a port that is not the scheme's default.
 * Anything that is not a string URL with the `http:` or `https:` scheme has none.
 */
export function httpOrigin(url: unknown): string | undefined {
  if (typeof url !== 'string' || !URL.canParse(url)) return undefined
  const { protocol, hostname, port } = new URL(url)
  if (protocol !== 'http:' && protocol !== 'https:') return undefined
  const host = hostname.length > 1 && hostname.endsWith('.')
    ? hostname.slice(0, -1)
    : hostname
  return `${protocol}//${host}${port === ''
    ? ''
    : `:${port}`}`
}

/** The error's `code`, or its cause's, as ` (ECONNREFUSED)`, when it is a plain identifier. Never throws. */
function codeSuffix(error: unknown): string {
  try {
    const candidates = [error, (error as { cause?: unknown } | null | undefined)?.cause]
    for (const candidate of candidates) {
      const code = (candidate as { code?: unknown } | null | undefined)?.code
      if (typeof code === 'string' && PLAIN_IDENTIFIER.test(code)) return ` (${code})`
    }
  } catch {
    // A getter that throws means no code.
  }
  return ''
}

/**
 * Node's global dispatcher handed each request with both of undici's timers off, the 300-second
 * limits on the headers and on the body, or undefined when the runtime has none: Bun's `fetch`
 * never reads a dispatcher, and its own timer goes off with `timeout: false`. The global is read at
 * each request, never kept, so a proxy agent an operator set still carries it. The delegate calls
 * the global's `dispatch` as its method, with the request's options and both timeouts at 0 (none),
 * and the same handler.
 */
export function timersOff(): { dispatch: (options: object, handler: unknown) => unknown } | undefined {
  // eslint-disable-next-line no-restricted-globals -- Node's fetch keeps its dispatcher on the global object, under this symbol alone.
  const shared: unknown = (globalThis as Record<symbol, unknown>)[NODE_GLOBAL_DISPATCHER]
  if (typeof shared !== 'object' || shared === null) return undefined
  const { dispatch } = shared as { dispatch?: unknown }
  if (typeof dispatch !== 'function') return undefined
  return {
    dispatch: (options, handler) => Reflect.apply(dispatch, shared, [
      { ...options, headersTimeout: 0, bodyTimeout: 0 },
      handler,
    ]),
  }
}

/** At most `max` bytes of the body, decoded as UTF-8, and whether that was all of it. The rest is never read. */
async function readCapped(response: Response, max: number): Promise<{ text: string, complete: boolean }> {
  const reader = response.body?.getReader()
  if (reader === undefined) return { text: '', complete: true }
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { text: text + decoder.decode(), complete: true }
    bytes += value.byteLength
    if (bytes > max) {
      await reader.cancel().catch(() => {})
      return { text: text + decoder.decode(value.subarray(0, value.byteLength - (bytes - max))), complete: false }
    }
    text += decoder.decode(value, { stream: true })
  }
}

/** The start of an error body, or nothing when it cannot be read. */
async function readErrorText(response: Response): Promise<string> {
  try {
    return (await readCapped(response, MAX_ERROR_BYTES)).text
  } catch {
    return ''
  }
}

/** The number if it is positive and finite, else nothing: a hint of 0, a negative one or one that is no number is none. */
function positiveOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

/** `value` times `unit`, when it is written as decimal digits with an optional fraction. */
function scaled(value: string | null, unit: number): number | undefined {
  return value !== null && DECIMAL.test(value)
    ? positiveOrUndefined(Number(value) * unit)
    : undefined
}

/** The wait, in milliseconds, until an HTTP date written as an IMF-fixdate, given the wall clock `now`. */
function untilDate(value: string | null, now: number): number | undefined {
  return value !== null && IMF_FIXDATE.test(value)
    ? positiveOrUndefined(Date.parse(value) - now)
    : undefined
}

/**
 * The wait a failed reply asks for, in milliseconds: `retry-after-ms`, then `retry-after` in seconds, then
 * `retry-after` as an HTTP date less `now`, the wall clock in milliseconds. The first that is a positive
 * finite number is the hint. A value is read as decimal digits with an optional fraction, or as an
 * IMF-fixdate matched by its shape before `Date.parse` reads it, since the runtimes read a bare `1` or
 * `120` as a year and the other date forms as local time. Anything else is no hint, and the header is
 * never copied anywhere.
 */
export function retryAfterHint(headers: Headers, now: number): number | undefined {
  const after = headers.get('retry-after')
  return scaled(headers.get('retry-after-ms'), 1) ?? scaled(after, 1000) ?? untilDate(after, now)
}

/** A count a header writes as decimal digits, at most 15 of them, else nothing. */
function countOf(value: string | null): number | undefined {
  return value !== null && COUNT.test(value)
    ? Number(value)
    : undefined
}

/** A Go duration, such as `6m0s` or `1.5s`, in milliseconds, else nothing. A parsed zero is a reset with no wait left. */
function goDurationMs(value: string | null): number | undefined {
  if (value === null || !GO_DURATION.test(value)) return undefined
  let total = 0
  for (const [, amount, unit] of value.matchAll(GO_DURATION_PART)) total += Number(amount) * GO_UNIT_MS[unit!]!
  return Math.round(total)
}

/**
 * The wait, in milliseconds, until an RFC 3339 date, given the wall clock `now`. A date that is not in the future is
 * nothing, not a wait of none: a skewed clock must not read as a reset that already came.
 */
function untilRfc3339(value: string | null, now: number): number | undefined {
  return value !== null && RFC_3339.test(value)
    ? positiveOrUndefined(Math.round(Date.parse(value) - now))
    : undefined
}

/**
 * What a reply's rate-limit headers state, as numbers, or nothing when it states none that are well formed. Two vendors'
 * names are read, OpenAI's first for each field: its `x-ratelimit-remaining-requests`, `-remaining-tokens` and
 * `-limit-tokens`, with `-reset-requests` and `-reset-tokens` as Go durations (`1s`, `6m0s`, `20ms`, `1.5s`), and
 * Anthropic's `anthropic-ratelimit-requests-remaining`, `-tokens-remaining` and `-tokens-limit`, with `-requests-reset`
 * and `-tokens-reset` as RFC 3339 dates matched by their shape before `Date.parse` reads them, less `now`, the wall
 * clock in milliseconds. A count is decimal digits, at most 15. The generic `x-ratelimit-limit`, `-remaining` and
 * `-reset` are not read: they name no window. A header that is malformed is read as nothing, and no value is copied,
 * quoted or logged, so a reply can put nothing in an error or a line through these names.
 */
export function rateLimitOf(headers: Headers, now: number): RateLimit | undefined {
  const read = {
    requests: countOf(headers.get('x-ratelimit-remaining-requests')) ?? countOf(headers.get('anthropic-ratelimit-requests-remaining')),
    tokens: countOf(headers.get('x-ratelimit-remaining-tokens')) ?? countOf(headers.get('anthropic-ratelimit-tokens-remaining')),
    tokensLimit: countOf(headers.get('x-ratelimit-limit-tokens')) ?? countOf(headers.get('anthropic-ratelimit-tokens-limit')),
    requestsResetMs: goDurationMs(headers.get('x-ratelimit-reset-requests')) ?? untilRfc3339(headers.get('anthropic-ratelimit-requests-reset'), now),
    tokensResetMs: goDurationMs(headers.get('x-ratelimit-reset-tokens')) ?? untilRfc3339(headers.get('anthropic-ratelimit-tokens-reset'), now),
  }
  const stated = Object.entries(read).filter(([, value]) => value !== undefined)
  return stated.length === 0
    ? undefined
    : Object.fromEntries(stated) as RateLimit
}

/** The own property `key` of `value` when it is an object, else nothing: the body is untrusted, and so is its prototype. */
function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function isSpendCode(code: unknown): boolean {
  return typeof code === 'string' && (SPEND_CODES.has(code) || code.endsWith(SPEND_LIMIT_SUFFIX))
}

/**
 * Whether the body of a failed reply says the account's credit, quota or spend limit is used up, which no retry
 * lifts and every retry would bill: the code decides, never the status, since a gateway forwards its upstream's
 * body under a status of its own. Each vendor's codes, read for every adapter as a gateway forwards them:
 * - OpenAI's `error.code` `insufficient_quota`, `billing_hard_limit_reached`, `credit_balance_exhausted`,
 *   `organization_usage_limit_exceeded` or any `*_spend_limit_exceeded`, and its `error.type`
 *   `insufficient_quota`, at any status;
 * - Anthropic's `error.details.error_code` `enforced_spend_limit_reached`, at any status, and the usage limit
 *   its user set, a 400 whose `error.type` is `invalid_request_error` and whose `error.message` starts with
 *   `You have reached your specified API usage limits` or `You have reached your specified workspace API usage
 *   limits`;
 * - OpenRouter's 402 whose `error.metadata.limit_source` is `openrouter_credits` or `openrouter_key_limit`.
 * Not exhausted, and still retried: Anthropic's `ramp_limit_exceeded`, OpenAI's `slow_down` and OpenRouter's
 * `openrouter_in_flight_budget` with a wait. Gemini's codes are its adapter's `errorHints`, since its body
 * has its own form. A code is only compared, with `===` and `startsWith`, never copied. This checks objects
 * with a local test, since `options.ts` imports this module.
 */
export function vendorExhausted(body: unknown, status: number): boolean {
  const error = member(body, 'error')
  if (isSpendCode(member(error, 'code')) || member(error, 'type') === 'insufficient_quota' || member(member(error, 'details'), 'error_code') === ANTHROPIC_SPEND_CODE) return true
  const message = member(error, 'message')
  if (status === 400 && member(error, 'type') === 'invalid_request_error' && typeof message === 'string' && ANTHROPIC_USAGE_LIMITS.some(start => message.startsWith(start))) return true
  return status === 402 && OPENROUTER_EXHAUSTED.has(member(member(error, 'metadata'), 'limit_source'))
}

/**
 * What the body of a failed reply says of a retry that the vendors' own codes settle: `false` for a used-up
 * credit, spend limit or quota (`vendorExhausted`), `true` for OpenRouter's 402 of its in-flight budget when the
 * reply is `hinted` with a wait, else `undefined`, and the status decides.
 */
export function vendorRetryable(body: unknown, status: number, hinted: boolean): boolean | undefined {
  if (vendorExhausted(body, status)) return false
  if (status === 402 && hinted && member(member(member(body, 'error'), 'metadata'), 'limit_source') === OPENROUTER_IN_FLIGHT) return true
  return undefined
}

/** The body as JSON, or nothing when it is none. */
function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Whether `text` holds `word` as a whole word: no letter, digit or underscore beside it. */
function namesWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = text[at - 1]
    const after = text[at + word.length]
    if (!WORD_CHARACTER.test(before ?? '') && !WORD_CHARACTER.test(after ?? '')) return true
  }
  return false
}

/**
 * What a 400 or 422 whose body names a field the request sent refused: the first of the request's stream words, then its
 * structured-output fields, matched as whole words. The body is matched and never copied: the mark is a code word.
 */
function refusalOf(options: RequestOptions, status: number, text: string): 'structuredOutput' | 'streamOptions' | 'stream' | undefined {
  if (status !== 400 && status !== 422) return undefined
  const streamed = options.streamWords?.find(({ word }) => namesWord(text, word))
  if (streamed !== undefined) return streamed.refused
  return options.formatFields?.some(field => namesWord(text, field)) === true
    ? 'structuredOutput'
    : undefined
}

/** A failed reply's error: its message quotes the body, and its hint and verdict are numbers and booleans, never text. */
function httpFailure(options: RequestOptions, response: Response, text: string): ProviderError {
  const { providerId, redact } = options
  const { status } = response
  const body = jsonOrUndefined(text)
  const extra = options.errorHints?.(body) ?? {}
  const retryAfterMs = retryAfterHint(response.headers, Date.now()) ?? positiveOrUndefined(extra.retryAfterMs)
  const said = response.headers.get('x-should-retry')
  const verdicts = [
    said === 'false'
      ? false
      : said === 'true'
        ? true
        : undefined,
    vendorRetryable(body, status, retryAfterMs !== undefined),
    extra.retryable,
  ]
  const retryable = verdicts.includes(false)
    ? false
    : verdicts.includes(true)
      ? true
      : undefined
  const redirect = status >= 300 && status < 400
    ? ' (redirects are not followed)'
    : ''
  const refused = refusalOf(options, status, text)
  const exhausted = vendorExhausted(body, status) || extra.exhausted === true
  const rateLimit = rateLimitOf(response.headers, Date.now())
  return new ProviderError({
    providerId,
    kind: 'http',
    message: `HTTP ${status}${redirect}: ${snippet(text, MAX_ERROR_BODY, redact)}`,
    status,
    retryAfterMs,
    retryable,
    ...exhausted
      ? { exhausted: true as const }
      : {},
    ...refused === undefined
      ? {}
      : { refused },
    ...rateLimit === undefined
      ? {}
      : { rateLimit },
  })
}

/** The failure of a read or a request that fell through: `aborted` when the attempt's signal is aborted, else `network`, naming the origin and never the runtime's own text. */
function lostOf(options: RequestOptions): (what: string, error: unknown) => ProviderError {
  const { providerId, url, signal } = options
  return (what, error) => signal?.aborted
    ? new ProviderError({ providerId, kind: 'aborted', message: 'request aborted' })
    : new ProviderError({ providerId, kind: 'network', message: `${what} ${originOf(url)} failed${codeSuffix(error)}` })
}

/**
 * Send the request, with no redirect followed and the runtimes' own timers off, and return the response. The reply may
 * be a failure: the caller reads its status. Only the request itself failing throws, as `aborted` or `network`.
 */
async function post(options: RequestOptions): Promise<Response> {
  const { url, headers, body, signal } = options
  // Outside the try: a body that cannot be serialized is a programming error, not a network failure to retry.
  const payload = JSON.stringify(body)
  try {
    // `timeout: false` turns Bun's idle timer off. Node reads `dispatcher` when its fetch reads the
    // init, which is the first moment its global dispatcher is certain to exist, so it is a getter.
    // undici types the option as its whole `Dispatcher` class, which the delegate is not.
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: payload,
      redirect: 'manual',
      signal,
      timeout: false,
      get dispatcher() {
        return timersOff()
      },
    }
    return await fetch(url, init as RequestInit)
  } catch (error) {
    throw lostOf(options)('request to', error)
  }
}

/** The body of a response as JSON, read under the 16 MiB cap: an `invalid-response` when it is over it or is none. */
async function readWhole<T>(options: RequestOptions, response: Response): Promise<T> {
  const fail = (message: string): ProviderError => new ProviderError({ providerId: options.providerId, kind: 'invalid-response', message })
  let reply: { text: string, complete: boolean }
  try {
    reply = await readCapped(response, MAX_REPLY_BYTES)
  } catch (error) {
    throw lostOf(options)('reading the reply from', error)
  }
  if (!reply.complete) throw fail('reply body is over 16 MiB')
  try {
    return JSON.parse(reply.text) as T
  } catch {
    throw fail('response body is not JSON')
  }
}

/** The media type of a content type header, as a reader compares it: the text before any `;`, trimmed and in lower case. */
function mediaTypeOf(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase()
}

/** The content type that says a body is the stream `format` names. */
const STREAM_TYPES = { sse: 'text/event-stream', ndjson: 'application/x-ndjson' } as const

/** What `postStream` hands back, beside the rate-limit facts the reply's headers stated, when it sent any. */
export type StreamReply = ({ readonly whole: unknown } | { readonly items: AsyncGenerator<StreamItem> }) & { readonly rateLimit?: RateLimit }

/**
 * POST a JSON body the server may answer as a stream, and hand back what it answered: the events of a stream, read
 * under the caps of `stream.ts`, or, for a server that answered a whole reply, its JSON. The reply's content type decides
 * which it is, by its media type alone, so `text/event-stream; charset=utf-8` is a stream: `text/event-stream` for `sse`
 * and `application/x-ndjson` for `ndjson`; anything else, or none, is a whole reply.
 *
 * A redirect is not followed: it is an `http` error, so a key sent in any header never reaches another endpoint. The
 * runtimes' own timers are off, so the core's deadline is the only one: a long reply of a thinking model is not cut at 300
 * seconds. A reply body over 16 MiB is refused unread. Every failure is a `ProviderError` without a `cause`: the
 * runtime's own error text can hold the URL with its credentials or a header value, so it is never copied, and no header
 * value appears in a message.
 *
 * A failed reply's error quotes the body in its message, and carries what the reply says of a retry as a number and a
 * boolean, never as text: `retryAfterMs` from `retry-after-ms` or `retry-after`, else from `errorHints`, and `retryable`
 * when the reply settles it, which a "never" wins: `x-should-retry: false`, a used-up credit, spend limit or quota, or a
 * hook's, else `x-should-retry: true` or OpenRouter's in-flight 402 with a hint, else the status decides. A used-up
 * credit, spend limit or quota also marks the error `exhausted`, by the vendor's codes or a hook's `exhausted`, so the
 * review stops calling its provider at once.
 *
 * The rate-limit facts of the headers (`rateLimitOf`) are on the result and on a failure's error, and on the `headers`
 * signal of a stream. `onProgress` hears one `headers` signal when the reply is a stream, none for a whole reply, whose
 * headers a gateway may write after its body, and each keep-alive of a stream as it is read. A
 * read that rejects is `aborted` when the attempt's signal is aborted, else `network`; a stream a consumer leaves
 * early, by a throw or a return, cancels its body.
 */
export async function postStream(options: PostStreamOptions): Promise<StreamReply> {
  const { format, sentinel, onProgress } = options
  const response = await post(options)
  if (!response.ok) throw httpFailure(options, response, await readErrorText(response))
  const rateLimit = rateLimitOf(response.headers, Date.now())
  const stated = rateLimit === undefined
    ? {}
    : { rateLimit }
  if (mediaTypeOf(response.headers.get('content-type')) !== STREAM_TYPES[format]) return { whole: await readWhole<unknown>(options, response), ...stated }
  onProgress?.({ kind: 'headers', ...stated })
  const body = response.body ?? new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
  const read = format === 'sse'
    ? sseItems
    : ndjsonItems
  const lost = lostOf(options)
  const events = read(body, {
    providerId: options.providerId,
    ...sentinel === undefined
      ? {}
      : { sentinel },
    lost: error => lost('reading the reply from', error),
  })
  async function* reported(): AsyncGenerator<StreamItem> {
    for await (const item of events) {
      if (item.kind === 'keep-alive') onProgress?.({ kind: 'keep-alive' })
      yield item
    }
  }
  return {
    items: reported(),
    ...stated,
  }
}

/**
 * A failure read from a whole reply, with the rate-limit facts that reply's headers stated: a copy of a `ProviderError` that
 * has none of its own, keeping every field, since the reader that threw it never saw the headers. Any other value, and an
 * error with its own facts, is as it was.
 */
function withHeaders(error: unknown, rateLimit: RateLimit | undefined): unknown {
  if (rateLimit === undefined || !(error instanceof ProviderError) || error.rateLimit !== undefined) return error
  const prefix = `${error.providerId}: `
  return new ProviderError({
    providerId: error.providerId,
    kind: error.kind,
    message: error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message,
    status: error.status,
    retryable: error.retryable,
    exhausted: error.exhausted
      ? true
      : undefined,
    retryAfterMs: error.retryAfterMs,
    usage: error.usage,
    noAnswer: error.noAnswer,
    refused: error.refused,
    stalledMs: error.stalledMs,
    cutAfterMs: error.cutAfterMs,
    rateLimit,
    cause: error.cause,
  })
}

/**
 * The tail every adapter's `complete` ends with: the whole reply `postStream` answered, or `assemble`'s reading of its
 * stream, read by `read`, marked `whole` when a streamed request was answered whole, and carrying the rate-limit facts the
 * reply's headers stated when it stated any: the field is left out otherwise. A failure `assemble` or `read` throws carries
 * them too, when it has none of its own (`withHeaders`).
 */
export async function replyOf(
  sent: StreamReply,
  streamed: boolean,
  assemble: (items: AsyncGenerator<StreamItem>) => Promise<unknown>,
  read: (reply: unknown) => CompletionResponse,
): Promise<CompletionResponse> {
  const answered = 'whole' in sent
  let reply: CompletionResponse
  try {
    reply = read(answered
      ? sent.whole
      : await assemble(sent.items))
  } catch (error) {
    throw withHeaders(error, sent.rateLimit)
  }
  const marked: CompletionResponse = streamed && answered
    ? { ...reply, whole: true }
    : reply
  return sent.rateLimit === undefined
    ? marked
    : { ...marked, rateLimit: sent.rateLimit }
}
