import { ConfigError, issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { endpointUrl, redactionsOf } from './http.ts'
import type { SystemPrompt } from './messages.ts'
import { DEFAULT_REPLY_TOKENS, TEMPLATE_TOKENS } from './size.ts'

const HTTP_URL_WITH_HOST = /^https?:\/\/[^/\\?#\s]/i
/** An HTTP header name: one or more token characters. */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/
const NOT_VISIBLE_ASCII = /[^\x21-\x7E]/
const NOT_PRINTABLE_ASCII = /[^\x20-\x7E]/
/** Headers quorum sets, or the runtime does: no option may replace them. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(['content-type', 'content-length', 'host'])
const SYSTEM_PROMPTS: ReadonlySet<unknown> = new Set(['native', 'inline'])
const FIXED_HEADER = 'is set by the adapter and cannot be replaced'
/** The issue of a provider with no `contextTokens`: resolution rewrites it where the user would set one. */
export const CONTEXT_REQUIRED = 'is required: the model\'s context window in tokens, which quorum checks every request against'

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
  /**
   * The model's context window in tokens, prompt and reply together. Required: every request is checked
   * against it and refused, before it is sent, when it may not fit.
   */
  contextTokens: number
  /** Sent as `auth` says, and nowhere else. No key, or an empty one, sends no key header. */
  apiKey?: string
  auth?: Auth
  /**
   * Extra request headers. They cannot replace `content-type`, `content-length`, `host`, the key header or
   * a header the adapter always sends. Their values are redacted from error messages, as the key is, so a
   * gateway's own credential can go here.
   */
  headers?: Readonly<Record<string, string>>
  /** Query parameters added to every request URL. They are not redacted from error messages: never put a key here, and a value equal to the key is refused. */
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
  /**
   * Body fields that set the reply limit, each as the keys leading to it: `extraBody` cannot set them, since
   * the size guard reserves `maxTokens` for the reply and would reserve less than is sent.
   */
  replyLimitPaths: readonly (readonly string[])[]
  /** Headers the adapter always sends: `headers` cannot replace them. */
  fixedHeaders: readonly string[]
  /** The structured-output modes the protocol supports. */
  structuredOutputs: readonly StructuredOutput[]
}

/** What an adapter sends with every request, once its options are checked. */
export interface PreparedHttp {
  url: string
  headers: Record<string, string>
  redact: string[]
  /** A copy of `extraBody`, taken once checked: a caller who changes the options later sends nothing unchecked. */
  extraBody: Record<string, unknown> | undefined
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
  return isPlainRecord(value) && Object.entries(value).every(([key, field]) => key !== '__proto__' && isJsonValue(field))
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

/** The problems of the header names and values, one per name in its order; a name that repeats an earlier one in another letter case has that problem alone: the checks before it refuse a name in every letter case. */
function headerIssues(id: string, headers: Readonly<Record<string, string>>, keyHeader: string | undefined, fixedHeaders: readonly string[]): ConfigIssue[] {
  const seen = new Set<string>()
  return Object.entries(headers).flatMap(([name, value]): ConfigIssue[] => {
    const path = `${id}.${issuePath(['headers', name])}`
    if (!HEADER_NAME.test(name)) return [{ path, message: 'must be an HTTP header name' }]
    const lower = name.toLowerCase()
    if (RESERVED_HEADERS.has(lower)) return [{ path, message: 'must not be content-type, content-length or host' }]
    if (lower === keyHeader) return [{ path, message: 'is the header that carries the key: set apiKey instead' }]
    if (fixedHeaders.includes(lower)) return [{ path, message: FIXED_HEADER }]
    if (seen.has(lower)) return [{ path, message: 'repeats a header name in another letter case' }]
    seen.add(lower)
    return typeof value === 'string' && !NOT_PRINTABLE_ASCII.test(value) ? [] : [{ path, message: 'must be a string of printable ASCII characters' }]
  })
}

/**
 * A body key as a lenient server reads it: Go's JSON decoder (Ollama) matches a key in any letter case,
 * folding U+017F (long s) to `s` and U+212A (Kelvin sign) to `k`, which upper case then lower case does
 * too; and proto JSON (Gemini) takes a field's snake_case name. So `Tools` and `tool_config` are `tools`
 * and `toolConfig` there.
 */
export function bodyKeyForm(key: string): string {
  return key.toUpperCase().toLowerCase().replaceAll('_', '')
}

/**
 * The problems of the `extraBody` fields at `limits`, the paths below `trail` that set the reply limit, one per
 * field in its order. A path goes through objects only: a field on it that is no object holds no limit.
 */
function replyLimitIssues(id: string, body: Readonly<Record<string, unknown>>, limits: readonly (readonly string[])[], trail: readonly string[] = []): ConfigIssue[] {
  return Object.entries(body).flatMap(([key, value]): ConfigIssue[] => {
    const below = limits.filter(([head]) => bodyKeyForm(head) === bodyKeyForm(key)).map(path => path.slice(1))
    if (below.some(path => path.length === 0)) return [{ path: `${id}.${issuePath(['extraBody', ...trail, key])}`, message: 'sets the reply limit: use maxTokens' }]
    return isRecord(value) && below.length > 0 ? replyLimitIssues(id, value, below, [...trail, key]) : []
  })
}

/**
 * The problems of `extraBody`: one per top-level key in its order, a key the adapter writes or one that offers
 * a tool, then one per field that sets the reply limit.
 */
function extraBodyIssues(id: string, extraBody: Readonly<Record<string, unknown>>, rules: AdapterRules): ConfigIssue[] {
  const reserved = new Set(rules.reservedBodyKeys.map(bodyKeyForm))
  const tools = new Set(rules.toolBodyKeys.map(bodyKeyForm))
  const keyIssues = Object.keys(extraBody).flatMap((key): ConfigIssue[] => {
    const path = `${id}.${issuePath(['extraBody', key])}`
    const form = bodyKeyForm(key)
    if (reserved.has(form)) return [{ path, message: 'is written by the adapter and cannot be replaced' }]
    return tools.has(form) ? [{ path, message: 'offers the model a tool, which quorum never does' }] : []
  })
  return [...keyIssues, ...replyLimitIssues(id, extraBody, rules.replyLimitPaths)]
}

/** The query entries whose value is the key, which travels only in the header `auth` names. No message repeats the value. */
function queryKeyIssues(id: string, query: Readonly<Record<string, string>>, apiKey: string): ConfigIssue[] {
  return Object.entries(query)
    .filter(([, value]) => value === apiKey)
    .map(([name]) => ({ path: `${id}.${issuePath(['query', name])}`, message: 'holds the key, which travels only in the header auth names' }))
}

/** The words of a list as a message names them: commas between them, and the conjunction before the last. */
export function wordList(words: readonly string[], conjunction: 'or' | 'and' = 'or'): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} ${conjunction} ${words.at(-1)}`
}

/** Whether `value` is a whole number of tokens, at least 1 and safe to count with. */
function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1
}

/**
 * The problems of `contextTokens`: not set, not a whole number of at least 1, or no more than the reply budget
 * and the chat template, which leaves no room for a request; one of them, never two. The room is checked
 * against a valid `maxTokens` only, since an invalid one has its own issue.
 */
function contextTokensIssues(id: string, contextTokens: number | undefined, maxTokens: number | undefined): ConfigIssue[] {
  const path = `${id}.contextTokens`
  if (contextTokens === undefined) return [{ path, message: CONTEXT_REQUIRED }]
  if (!isTokenCount(contextTokens)) return [{ path, message: 'must be a whole number of at least 1' }]
  if (maxTokens !== undefined && !isTokenCount(maxTokens)) return []
  const reply = maxTokens ?? DEFAULT_REPLY_TOKENS
  if (contextTokens > reply + TEMPLATE_TOKENS) return []
  return [{ path, message: `must be more than ${reply + TEMPLATE_TOKENS}, the ${reply} tokens of the reply budget and ${TEMPLATE_TOKENS} for the chat template` }]
}

/**
 * The problems of the options every HTTP adapter shares, under the rules the adapter declares. No
 * message repeats a value: a key, a header value or a URL can be a secret.
 */
export function httpOptionIssues(options: HttpProviderOptions, rules: AdapterRules): ConfigIssue[] {
  const { id, baseUrl, apiKey, headers, query, extraBody, temperature, maxTokens, contextTokens, systemPrompt, structuredOutput } = options
  const { auth, structuredOutputs } = rules
  const fixedHeaders = rules.fixedHeaders.map(name => name.toLowerCase())
  const issues = [...baseUrlIssues(`${id}.baseUrl`, baseUrl)]
  if (apiKey !== undefined && NOT_VISIBLE_ASCII.test(apiKey)) {
    issues.push({ path: `${id}.apiKey`, message: 'must only contain visible ASCII characters, which an HTTP header can carry' })
  }
  const authProblems = authIssues(id, auth, apiKey, fixedHeaders)
  issues.push(...authProblems)
  if (headers !== undefined && !isPlainRecord(headers)) issues.push({ path: `${id}.headers`, message: 'must map names to strings' })
  else if (headers !== undefined) issues.push(...headerIssues(id, headers, authProblems.length === 0 ? keyHeaderName(auth) : undefined, fixedHeaders))
  if (query !== undefined && (!isPlainRecord(query) || !Object.values(query).every(value => typeof value === 'string'))) {
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
  if (maxTokens !== undefined && !isTokenCount(maxTokens)) {
    issues.push({ path: `${id}.maxTokens`, message: 'must be a whole number of at least 1' })
  }
  issues.push(...contextTokensIssues(id, contextTokens, maxTokens))
  if (systemPrompt !== undefined && !SYSTEM_PROMPTS.has(systemPrompt)) issues.push({ path: `${id}.systemPrompt`, message: 'must be native or inline' })
  if (structuredOutput !== undefined && !structuredOutputs.includes(structuredOutput)) {
    issues.push({ path: `${id}.structuredOutput`, message: `must be ${wordList(structuredOutputs)}` })
  }
  return issues
}

/**
 * Check an adapter's options, then build what it sends with every request: the URL of `path` with the
 * query, the headers, the values to redact and a copy of `extraBody`. Nothing is built from options
 * that fail a check.
 *
 * @throws ConfigError with the problems of `httpOptionIssues`, then `adapterIssues`, before any request
 */
export function prepareHttp(options: HttpProviderOptions, rules: AdapterRules, path: string, adapterIssues: readonly ConfigIssue[] = []): PreparedHttp {
  const issues = [...httpOptionIssues(options, rules), ...adapterIssues]
  if (issues.length > 0) throw new ConfigError(issues)
  const { baseUrl, apiKey, headers, query, extraBody } = options
  return {
    url: endpointUrl(baseUrl, path, query),
    headers: requestHeaders(rules.auth, apiKey, headers),
    redact: redactionsOf(baseUrl, apiKey, headers),
    extraBody: extraBody === undefined ? undefined : structuredClone(extraBody),
  }
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

/** Whether `value` is an object that is not an array and whose prototype is `Object.prototype` or none: its entries are its own fields. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
