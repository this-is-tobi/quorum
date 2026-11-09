import { ProviderError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'

const MAX_ERROR_BODY = 500
/**
 * Enough of an error body for its 500-character snippet: the rest is never read. The body is cut at this
 * byte before it is redacted, so the cap must stay far above the quote, or a key cut in half at the cap
 * could survive into the message.
 */
const MAX_ERROR_BYTES = 64 * 1024
/** A reply body over this many bytes is refused: the core refuses reply text over 1,000,000 characters anyway. */
const MAX_REPLY_BYTES = 16 * 1024 * 1024

const REDACTED = '[redacted]'
const UNKNOWN_ENDPOINT = 'the endpoint'
const PLAIN_IDENTIFIER = /^[A-Z]\w{0,39}$/i
/** A JSON unicode escape (a backslash, then u00 and two hex digits) for printable ASCII, U+0020 to U+007E. */
const ESCAPED_PRINTABLE_ASCII = /\\u00(2[0-9a-fA-F]|[3-6][0-9a-fA-F]|7[0-9a-eA-E])/g

export interface PostJsonOptions {
  providerId: string
  url: string
  headers?: Readonly<Record<string, string>>
  body: unknown
  signal?: AbortSignal
  /** Values redacted from any server text that echoes them: the key, the base URL's path and the header values. */
  redact?: readonly string[]
}

/** Every form in which a server may echo the secret, longest first. */
function echoedForms(secret: string): string[] {
  const asJson = JSON.stringify(secret).slice(1, -1)
  const forms = [secret, asJson].flatMap(form => [form, form.replaceAll('/', '\\/')])
  return [...new Set(forms)].sort((a, b) => b.length - a.length)
}

/** Go and .NET write `&`, `<`, `>` and `+` as escapes in JSON, so a key echoed by them would not match as is. */
function decodeEscapedAscii(text: string): string {
  return text.replace(ESCAPED_PRINTABLE_ASCII, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

function redactForms(text: string, forms: readonly string[]): string {
  return forms.reduce((current, form) => current.split(form).join(REDACTED), text)
}

/**
 * Server or model text made safe to put in an error message. Each value in `redact` is replaced, in the
 * text as it came and again once escaped ASCII is decoded, so neither a value that holds an escape nor
 * an escaped echo of one survives. Then the text is cut to `max` characters, after the redaction so a
 * value cut in half cannot survive, and written as one JSON string so a line break cannot start a
 * workflow command in a log.
 */
export function snippet(text: string, max: number, redact: readonly string[] = []): string {
  const forms = [...new Set(redact.filter(value => value !== '').flatMap(echoedForms))].sort((a, b) => b.length - a.length)
  const redacted = forms.length === 0 ? text : redactForms(decodeEscapedAscii(redactForms(text, forms)), forms)
  return JSON.stringify(redacted.slice(0, max))
}

/** The URL of an endpoint: the base URL without its trailing slashes, the endpoint's path, then the query. */
export function endpointUrl(baseUrl: string, path: string, query: Readonly<Record<string, string>> = {}): string {
  const search = new URLSearchParams(query).toString()
  return `${baseUrl.replace(/\/+$/, '')}${path}${search === '' ? '' : `?${search}`}`
}

/**
 * What a provider redacts from server text, each value once and no empty one: its key; its base URL's
 * path, which a server echoes in a 404 (`Cannot POST /<path>/chat/completions`) and which some gateways
 * use to carry a token; and the value of each of its headers, where a gateway's own credential goes.
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
  return [...new Set([apiKey ?? '', path, decoded, ...Object.values(headers)])].filter(value => value !== '')
}

/** The scheme, host and port of a URL: no credentials, path, query or fragment. */
export function originOf(url: string): string {
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? UNKNOWN_ENDPOINT : origin
  } catch {
    return UNKNOWN_ENDPOINT
  }
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

/**
 * POST a JSON body and return the parsed JSON reply. A redirect is not followed: it is an `http` error,
 * so a key sent in any header never reaches another endpoint. A reply body over 16 MiB is refused
 * unread. Every failure is a `ProviderError` without a `cause`: the runtime's own error text can hold
 * the URL with its credentials or a header value, so it is never copied, and no header value appears in
 * a message.
 */
export async function postJson<T>(options: PostJsonOptions): Promise<T> {
  const { providerId, url, headers, body, signal, redact } = options
  const fail = (kind: ProviderErrorKind, message: string, status?: number): ProviderError =>
    new ProviderError({ providerId, kind, message, status })
  const lost = (what: string, error: unknown): ProviderError => signal?.aborted
    ? fail('aborted', 'request aborted')
    : fail('network', `${what} ${originOf(url)} failed${codeSuffix(error)}`)

  // Outside the try: a body that cannot be serialized is a programming error, not a network failure to retry.
  const payload = JSON.stringify(body)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: payload,
      redirect: 'manual',
      signal,
    })
  } catch (error) {
    throw lost('request to', error)
  }

  if (!response.ok) {
    const { status } = response
    const redirect = status >= 300 && status < 400 ? ' (redirects are not followed)' : ''
    throw fail('http', `HTTP ${status}${redirect}: ${snippet(await readErrorText(response), MAX_ERROR_BODY, redact)}`, status)
  }

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
