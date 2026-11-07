import { ProviderError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'

const MAX_ERROR_BODY = 500
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
  /** The key sent in `headers`, redacted from any server text that echoes it. */
  secret?: string
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

/**
 * Server or model text made safe to put in an error message: the secret redacted first (after any
 * escaped echo of it is decoded), so a key cut in half by the limit cannot survive, then cut to `max`
 * characters, then written as one JSON string so a line break cannot start a workflow command in a log.
 */
export function snippet(text: string, max: number, secret?: string): string {
  const redacted = secret
    ? echoedForms(secret).reduce((current, form) => current.split(form).join(REDACTED), decodeEscapedAscii(text))
    : text
  return JSON.stringify(redacted.slice(0, max))
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

async function readText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * POST a JSON body and return the parsed JSON reply. Every failure is a `ProviderError` without a
 * `cause`: the runtime's own error text can hold the URL with its credentials or a header value, so it
 * is never copied, and no header value appears in a message.
 */
export async function postJson<T>(options: PostJsonOptions): Promise<T> {
  const { providerId, url, headers, body, signal, secret } = options
  const fail = (kind: ProviderErrorKind, message: string, status?: number): ProviderError =>
    new ProviderError({ providerId, kind, message, status })
  const lost = (what: string, error: unknown): ProviderError => signal?.aborted
    ? fail('aborted', 'request aborted')
    : fail('network', `${what} ${originOf(url)} failed${codeSuffix(error)}`)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    throw lost('request to', error)
  }

  if (!response.ok) {
    throw fail('http', `HTTP ${response.status}: ${snippet(await readText(response), MAX_ERROR_BODY, secret)}`, response.status)
  }

  try {
    return await response.json() as T
  } catch (error) {
    throw error instanceof SyntaxError ? fail('invalid-response', 'response body is not JSON') : lost('reading the reply from', error)
  }
}
