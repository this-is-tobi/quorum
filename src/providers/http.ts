import { ProviderError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'

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

const REDACTED = '[redacted]'
const UNKNOWN_ENDPOINT = 'the endpoint'
const PLAIN_IDENTIFIER = /^[A-Z]\w{0,39}$/i
/** A wait as a header writes it: decimal digits with an optional fraction. Never a sign, an exponent, a hexadecimal or a list. */
const DECIMAL = /^\d+(?:\.\d+)?$/
/** The one date form read: an IMF-fixdate. Both engines read the others as local time, or `1` as a year. */
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/
/** The codes of OpenAI that say a credit or a spend limit is used up: a retry cannot succeed, and would be billed. */
const SPEND_CODES: ReadonlySet<string> = new Set(['credit_balance_exhausted', 'organization_usage_limit_exceeded', 'insufficient_quota'])
const SPEND_LIMIT_SUFFIX = '_spend_limit_exceeded'
const ANTHROPIC_SPEND_CODE = 'enforced_spend_limit_reached'
const OPENROUTER_IN_FLIGHT = 'openrouter_in_flight_budget'
/** A JSON unicode escape (a backslash, then u00 and two hex digits) for printable ASCII, U+0020 to U+007E. */
const ESCAPED_PRINTABLE_ASCII = /\\u00(2[0-9a-fA-F]|[3-6][0-9a-fA-F]|7[0-9a-eA-E])/g

/**
 * What an adapter reads of a failed reply's body that `postJson` cannot: a wait the server asks for, in
 * milliseconds, and a reason never to retry. A hook can add a hint and turn a retry off, never on.
 */
export interface ErrorHints {
  readonly retryAfterMs?: number
  readonly retryable?: false
}

export interface PostJsonOptions {
  providerId: string
  url: string
  headers?: Readonly<Record<string, string>>
  body: unknown
  signal?: AbortSignal
  /** Values redacted from any server text that echoes them: the key, the base URL's path and the header values. */
  redact?: readonly string[]
  /** What the adapter reads of a failed reply's body, handed the body parsed as JSON, or `undefined` when it is none. */
  errorHints?: (body: unknown) => ErrorHints
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
 * What the body of a failed reply says of a retry that the vendors' own codes settle: `false` for a used-up
 * credit, spend limit or quota (OpenAI's `error.code`, or its `error.type` for `insufficient_quota`, and
 * Anthropic's `error.details.error_code`), `true` for OpenRouter's 402 of its in-flight budget when the
 * reply is `hinted` with a wait, else `undefined`, and the status decides. A code is only compared, never
 * copied. This checks objects with a local test, since `options.ts` imports this module.
 */
export function vendorRetryable(body: unknown, status: number, hinted: boolean): boolean | undefined {
  const error = member(body, 'error')
  if (isSpendCode(member(error, 'code')) || member(error, 'type') === 'insufficient_quota' || member(member(error, 'details'), 'error_code') === ANTHROPIC_SPEND_CODE) return false
  if (status === 402 && hinted && member(member(error, 'metadata'), 'limit_source') === OPENROUTER_IN_FLIGHT) return true
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

/** A failed reply's error: its message quotes the body, and its hint and verdict are numbers and booleans, never text. */
function httpFailure(options: PostJsonOptions, response: Response, text: string): ProviderError {
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
  return new ProviderError({
    providerId,
    kind: 'http',
    message: `HTTP ${status}${redirect}: ${snippet(text, MAX_ERROR_BODY, redact)}`,
    status,
    retryAfterMs,
    retryable,
  })
}

/**
 * POST a JSON body and return the parsed JSON reply. A redirect is not followed: it is an `http` error,
 * so a key sent in any header never reaches another endpoint. The runtimes' own timers are off, so
 * the core's deadline is the only one: a long reply of a thinking model is not cut at 300 seconds.
 * A reply body over 16 MiB is refused unread. Every failure is a `ProviderError` without a `cause`:
 * the runtime's own error text can hold the URL with its credentials or a header value, so it is
 * never copied, and no header value appears in a message.
 *
 * A failed reply's error quotes the body in its message, as it always did, and carries what the reply
 * says of a retry as a number and a boolean, never as text: `retryAfterMs` from `retry-after-ms` or
 * `retry-after`, else from `errorHints`, and `retryable` when the reply settles it, which a "never" wins:
 * `x-should-retry: false`, a used-up credit, spend limit or quota, or a hook's, else `x-should-retry: true`
 * or OpenRouter's in-flight 402 with a hint, else the status decides.
 */
export async function postJson<T>(options: PostJsonOptions): Promise<T> {
  const { providerId, url, headers, body, signal } = options
  const fail = (kind: ProviderErrorKind, message: string, status?: number): ProviderError =>
    new ProviderError({ providerId, kind, message, status })
  const lost = (what: string, error: unknown): ProviderError => signal?.aborted
    ? fail('aborted', 'request aborted')
    : fail('network', `${what} ${originOf(url)} failed${codeSuffix(error)}`)

  // Outside the try: a body that cannot be serialized is a programming error, not a network failure to retry.
  const payload = JSON.stringify(body)

  let response: Response
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
    response = await fetch(url, init as RequestInit)
  } catch (error) {
    throw lost('request to', error)
  }

  if (!response.ok) throw httpFailure(options, response, await readErrorText(response))

  let reply: { text: string, complete: boolean }
  try {
    reply = await readCapped(response, MAX_REPLY_BYTES)
  } catch (error) {
    throw lost('reading the reply from', error)
  }
  if (!reply.complete) throw fail('invalid-response', 'reply body is over 16 MiB')
  try {
    return JSON.parse(reply.text) as T
  } catch {
    throw fail('invalid-response', 'response body is not JSON')
  }
}
