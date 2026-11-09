import type { ConfigIssue } from '../core/errors.ts'
import type { SystemPrompt } from './messages.ts'

const HTTP_URL_WITH_HOST = /^https?:\/\/[^/\\?#\s]/i
/** An HTTP header name: one or more token characters. */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/
const NOT_VISIBLE_ASCII = /[^\x21-\x7E]/
const NOT_PRINTABLE_ASCII = /[^\x20-\x7E]/
/** Headers quorum sets, or the runtime does: no option may replace them. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(['content-type', 'content-length', 'host'])
const SYSTEM_PROMPTS: ReadonlySet<unknown> = new Set(['native', 'inline'])
const FIXED_HEADER = 'is set by the adapter and cannot be replaced'

/**
 * How a provider sends its key: `Authorization: Bearer <key>`, `x-api-key: <key>`, not at all, or in a
 * header of its own, after an optional prefix.
 */
export type Auth = 'bearer' | 'x-api-key' | 'none' | { readonly header: string, readonly prefix?: string }

/** How the reply shape reaches the endpoint: described in the prompt only, as a JSON object, or as a strict schema. */
export type StructuredOutput = 'prompt' | 'json' | 'schema'

/** The options every HTTP adapter takes. Each adapter documents its defaults. */
export interface HttpProviderOptions {
  /** Names the provider in events, `meta` and its error messages. */
  id: string
  /** An http(s) URL with a host, and no credentials, query or fragment. */
  baseUrl: string
  model: string
  /** Sent as `auth` says, and nowhere else. No key, or an empty one, sends no key header. */
  apiKey?: string
  auth?: Auth
  /**
   * Extra request headers. They cannot replace `content-type`, `content-length`, `host`, the key header or
   * a header the adapter always sends. Their values are redacted from error messages, as the key is, so a
   * gateway's own credential can go here.
   */
  headers?: Readonly<Record<string, string>>
  /** Query parameters added to every request URL. They are not redacted from error messages: never put a key here. */
  query?: Readonly<Record<string, string>>
  /**
   * JSON values deep-merged into the request body last: objects merge key by key, anything else replaces.
   * A top-level key cannot replace a field the adapter writes for the conversation, or offer the model a tool.
   */
  extraBody?: Readonly<Record<string, unknown>>
  /** `null` leaves the field out, for models that reject it. */
  temperature?: number | null
  /** The most tokens the reply may hold. */
  maxTokens?: number
  systemPrompt?: SystemPrompt
  structuredOutput?: StructuredOutput
}

/** What an adapter declares of its protocol, which the shared checks hold the options to. */
export interface AdapterRules {
  /** The resolved auth style: the option, or the adapter's default. */
  auth: Auth
  /** Body fields the adapter writes for the conversation: `extraBody` cannot replace them. */
  reservedBodyKeys: readonly string[]
  /** Body fields that would offer the model a tool or a server-side capability: `extraBody` cannot set them. */
  toolBodyKeys: readonly string[]
  /** Headers the adapter always sends, lower-cased: `headers` cannot replace them. */
  fixedHeaders: readonly string[]
  /** The structured-output modes the protocol supports. */
  structuredOutputs: readonly StructuredOutput[]
}

/** A scheme, then a host: URL parsing skips extra slashes, so `https:///v1` would otherwise send the request to a host named `v1`. */
function isHttpUrlWithHost(baseUrl: string): boolean {
  if (!HTTP_URL_WITH_HOST.test(baseUrl)) return false
  try {
    return new URL(baseUrl).host !== ''
  } catch {
    return false
  }
}

/**
 * The problems of a base URL, at `path`. No message repeats the value: a base URL can carry credentials.
 * Credentials in the URL are refused, since runtimes disagree on them (Bun sends them, Node refuses
 * the request) and a key belongs in the adapter's key option, which redaction knows about. A query or a
 * fragment is refused, since the endpoint's path is appended to the base URL.
 */
export function baseUrlIssues(path: string, baseUrl: string): ConfigIssue[] {
  if (!isHttpUrlWithHost(baseUrl)) return [{ path, message: 'must be an http:// or https:// URL with a host' }]
  const url = new URL(baseUrl)
  const issues: ConfigIssue[] = []
  if (url.username !== '' || url.password !== '') issues.push({ path, message: 'must not hold a user name or password: send a key with apiKey' })
  if (/[?#]/.test(baseUrl)) issues.push({ path, message: 'must not hold a query or a fragment' })
  return issues
}

/** The header that carries the key under `auth`, lower-cased, or undefined for `none`. */
function keyHeaderName(auth: Auth): string | undefined {
  if (auth === 'none') return undefined
  if (auth === 'bearer') return 'authorization'
  if (auth === 'x-api-key') return 'x-api-key'
  return auth.header.toLowerCase()
}

/** Whether `value` is plain JSON data: null, a boolean, a string, a finite number, or an array or plain object of those. */
function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Object.entries(value).every(([key, field]) => key !== '__proto__' && isJsonValue(field))
}

function authIssues(id: string, auth: unknown, apiKey: string | undefined, fixedHeaders: readonly string[]): ConfigIssue[] {
  if (auth === 'bearer' || auth === 'x-api-key') return []
  if (auth === 'none') return apiKey ? [{ path: `${id}.apiKey`, message: 'is set, but auth is none, so it would never be sent' }] : []
  if (!isRecord(auth) || typeof auth.header !== 'string' || (auth.prefix !== undefined && typeof auth.prefix !== 'string')) {
    return [{ path: `${id}.auth`, message: 'must be bearer, x-api-key, none or { header, prefix }' }]
  }
  const issues: ConfigIssue[] = []
  if (!HEADER_NAME.test(auth.header)) issues.push({ path: `${id}.auth.header`, message: 'must be an HTTP header name' })
  else if (RESERVED_HEADERS.has(auth.header.toLowerCase())) issues.push({ path: `${id}.auth.header`, message: 'must not be content-type, content-length or host' })
  else if (fixedHeaders.includes(auth.header.toLowerCase())) issues.push({ path: `${id}.auth.header`, message: FIXED_HEADER })
  if (typeof auth.prefix === 'string' && NOT_PRINTABLE_ASCII.test(auth.prefix)) issues.push({ path: `${id}.auth.prefix`, message: 'must only contain printable ASCII characters' })
  return issues
}

function headerIssues(id: string, headers: Readonly<Record<string, string>>, keyHeader: string | undefined, fixedHeaders: readonly string[]): ConfigIssue[] {
  return Object.entries(headers).flatMap(([name, value]): ConfigIssue[] => {
    const path = `${id}.headers.${name}`
    if (!HEADER_NAME.test(name)) return [{ path, message: 'must be an HTTP header name' }]
    const lower = name.toLowerCase()
    if (RESERVED_HEADERS.has(lower)) return [{ path, message: 'must not be content-type, content-length or host' }]
    if (lower === keyHeader) return [{ path, message: 'is the header that carries the key: set apiKey instead' }]
    if (fixedHeaders.includes(lower)) return [{ path, message: FIXED_HEADER }]
    return typeof value === 'string' && !NOT_PRINTABLE_ASCII.test(value) ? [] : [{ path, message: 'must be a string of printable ASCII characters' }]
  })
}

/**
 * A body key as a lenient server reads it: Go's JSON decoder (Ollama) matches a key in any letter case,
 * folding U+017F (long s) to `s` and U+212A (Kelvin sign) to `k`, which upper case then lower case does
 * too; and proto JSON (Gemini) takes a field's snake_case name. So `Tools` and `tool_config` are `tools`
 * and `toolConfig` there.
 */
function bodyKeyForm(key: string): string {
  return key.toUpperCase().toLowerCase().replaceAll('_', '')
}

/** The problems of the top-level `extraBody` keys, one per key in its order: a key the adapter writes, or one that offers a tool. */
function extraBodyIssues(id: string, extraBody: Readonly<Record<string, unknown>>, rules: AdapterRules): ConfigIssue[] {
  const reserved = new Set(rules.reservedBodyKeys.map(bodyKeyForm))
  const tools = new Set(rules.toolBodyKeys.map(bodyKeyForm))
  return Object.keys(extraBody).flatMap((key): ConfigIssue[] => {
    const path = `${id}.extraBody.${key}`
    const form = bodyKeyForm(key)
    if (reserved.has(form)) return [{ path, message: 'is written by the adapter and cannot be replaced' }]
    return tools.has(form) ? [{ path, message: 'offers the model a tool, which quorum never does' }] : []
  })
}

/** The query entries whose value is the key, which travels only in the header `auth` names. No message repeats the value. */
function queryKeyIssues(id: string, query: Readonly<Record<string, string>>, apiKey: string): ConfigIssue[] {
  return Object.entries(query)
    .filter(([, value]) => value === apiKey)
    .map(([name]) => ({ path: `${id}.query.${name}`, message: 'holds the key, which travels only in the header auth names' }))
}

/** The words of a list as a message names them: commas between them, and `or` before the last. */
function wordList(words: readonly string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`
}

/**
 * The problems of the options every HTTP adapter shares, under the rules the adapter declares. No
 * message repeats a value: a key, a header value or a URL can be a secret.
 */
export function httpOptionIssues(options: HttpProviderOptions, rules: AdapterRules): ConfigIssue[] {
  const { id, baseUrl, apiKey, headers, query, extraBody, temperature, maxTokens, systemPrompt, structuredOutput } = options
  const { auth, fixedHeaders, structuredOutputs } = rules
  const issues = [...baseUrlIssues(`${id}.baseUrl`, baseUrl)]
  if (apiKey !== undefined && NOT_VISIBLE_ASCII.test(apiKey)) {
    issues.push({ path: `${id}.apiKey`, message: 'must only contain visible ASCII characters, which an HTTP header can carry' })
  }
  const authProblems = authIssues(id, auth, apiKey, fixedHeaders)
  issues.push(...authProblems)
  if (headers !== undefined && !isRecord(headers)) issues.push({ path: `${id}.headers`, message: 'must map names to strings' })
  else if (headers !== undefined) issues.push(...headerIssues(id, headers, authProblems.length === 0 ? keyHeaderName(auth) : undefined, fixedHeaders))
  if (query !== undefined && (!isRecord(query) || !Object.values(query).every(value => typeof value === 'string'))) {
    issues.push({ path: `${id}.query`, message: 'must map names to strings' })
  } else if (query !== undefined && typeof apiKey === 'string' && apiKey !== '') {
    issues.push(...queryKeyIssues(id, query, apiKey))
  }
  if (extraBody !== undefined) {
    if (!isJsonValue(extraBody) || !isRecord(extraBody)) issues.push({ path: `${id}.extraBody`, message: 'must be an object of JSON values, with no __proto__ key' })
    else issues.push(...extraBodyIssues(id, extraBody, rules))
  }
  if (temperature !== undefined && temperature !== null && !Number.isFinite(temperature)) {
    issues.push({ path: `${id}.temperature`, message: 'must be a finite number, or null to leave it out' })
  }
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    issues.push({ path: `${id}.maxTokens`, message: 'must be a whole number of at least 1' })
  }
  if (systemPrompt !== undefined && !SYSTEM_PROMPTS.has(systemPrompt)) issues.push({ path: `${id}.systemPrompt`, message: 'must be native or inline' })
  if (structuredOutput !== undefined && !structuredOutputs.includes(structuredOutput)) {
    issues.push({ path: `${id}.structuredOutput`, message: `must be ${wordList(structuredOutputs)}` })
  }
  return issues
}

/** The headers a provider sends besides the content type: its own, then its key as `auth` says. Names are lower-cased. */
export function requestHeaders(auth: Auth, apiKey: string | undefined, headers: Readonly<Record<string, string>> = {}): Record<string, string> {
  const result: Record<string, string> = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  const name = keyHeaderName(auth)
  if (name !== undefined && apiKey) {
    result[name] = auth === 'bearer' ? `Bearer ${apiKey}` : typeof auth === 'object' ? `${auth.prefix ?? ''}${apiKey}` : apiKey
  }
  return result
}

/** `body` with `extra` deep-merged into it: objects merge key by key, anything else, arrays included, replaces. */
export function mergeBody(body: Record<string, unknown>, extra: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  if (extra === undefined) return body
  const merged: Record<string, unknown> = { ...body }
  for (const [key, value] of Object.entries(extra)) {
    const current = merged[key]
    merged[key] = isRecord(current) && isRecord(value) ? mergeBody(current, value) : value
  }
  return merged
}

/** `fields`, or undefined when every one of them is undefined, so the body leaves out an object that would be empty. */
export function unlessEmpty(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.values(fields).every(value => value === undefined) ? undefined : fields
}

/** Whether `value` is a non-null object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
