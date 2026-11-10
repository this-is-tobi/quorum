import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { Provider } from '../core/ports.ts'
import { anthropic } from './anthropic.ts'
import { gemini } from './gemini.ts'
import { httpOrigin } from './http.ts'
import { ollama } from './ollama.ts'
import { openaiCompatible } from './openai-compatible.ts'
import type { OpenAICompatibleOptions } from './openai-compatible.ts'
import { wordList } from './options.ts'
import { presetOf, presets } from './presets.ts'
import type { Preset, Protocol } from './presets.ts'

/** A provider described as data: a preset, or a protocol, and the options of that protocol's adapter. */
export interface ProviderSpec extends Omit<OpenAICompatibleOptions, 'baseUrl'> {
  preset?: string
  protocol?: string
  /** Required when the preset has no default, or without a preset. */
  baseUrl?: string
}

/** Each protocol's adapter. Only `openaiCompatible` is handed `maxTokensField`. */
const ADAPTERS: Readonly<Record<Protocol, (options: OpenAICompatibleOptions) => Provider>> = {
  'openai-compatible': openaiCompatible,
  anthropic,
  gemini,
  ollama,
}
const TOOL_MODEL = 'runs tools on the server by itself, which quorum never allows'
const MODEL_ID = /^[\x21-\x7E]+$/

/** The spec's value, or the preset's when the spec leaves it unset: a field set to `undefined` is unset, `null` is set. */
function filled<T>(value: T | undefined, preset: T | undefined): T | undefined {
  return value === undefined ? preset : value
}

/**
 * Whether `pattern` matches the whole of `model`, a visible ASCII id, in any ASCII letter case: `*` stands
 * for any text, possibly empty, and every other character for itself. No pattern holds a regular-expression
 * character today, and the escape keeps a future one literal.
 */
function matchesModel(pattern: string, model: string): boolean {
  const literals = pattern.split('*').map(part => part.replace(/[$()+.?[\\\]^{|}]/g, '\\$&'))
  return new RegExp(`^${literals.join('.*')}$`, 'i').test(model)
}

/** The tool-model patterns of the presets whose default base URL has an origin, by that origin, computed once. */
const TOOL_MODELS_AT_ORIGIN = new Map<string, string[]>()
for (const { baseUrl, toolModels } of Object.values(presets)) {
  const origin = httpOrigin(baseUrl)
  if (origin !== undefined) TOOL_MODELS_AT_ORIGIN.set(origin, [...TOOL_MODELS_AT_ORIGIN.get(origin) ?? [], ...toolModels])
}

/** The patterns that hold a model: the named preset's, and those of every preset whose base URL has the origin of `baseUrl`. */
function toolModelPatterns(preset: Preset | undefined, baseUrl: unknown): readonly string[] {
  const origin = httpOrigin(baseUrl)
  return [...preset?.toolModels ?? [], ...origin === undefined ? [] : TOOL_MODELS_AT_ORIGIN.get(origin) ?? []]
}

/** `entries` as an object with no prototype: a field they lack reads `undefined`, whatever `Object.prototype` holds. */
function withoutPrototype<T>(entries: Iterable<readonly [string, unknown]>): T {
  return Object.setPrototypeOf(Object.fromEntries(entries), null) as T
}

/** The fields of a spec as the builder reads them: whatever a caller or a config put in each. */
type Fields = Readonly<Partial<Record<keyof ProviderSpec, unknown>>>

/** The fields that make the builder's own decisions: the adapter is handed the others, and `maxTokensField` only when it takes it. */
const BUILDER_FIELDS: ReadonlySet<string> = new Set(['preset', 'protocol', 'maxTokensField'])

/**
 * Build a provider from a spec: the preset fills in `baseUrl`, `auth`, `structuredOutput`, `temperature`
 * and, for `openai-compatible`, `maxTokensField`, and any of them set on the spec wins. The model must be
 * a visible ASCII id, and is refused when a pattern of its preset, or of any preset whose base URL has the
 * spec's origin, says the model runs tools on the server by itself. No message repeats a value of the spec.
 * Only the spec's own fields are read, once each, so a polluted `Object.prototype` fills none of them and
 * a getter cannot show the checks one value and the adapter another.
 *
 * @throws ConfigError with every problem of the spec and of the adapter's options, before any request; the
 * spec's problems alone while the protocol, the base URL or the model is unusable
 */
export function buildProvider(spec: ProviderSpec): Provider {
  const entries = Object.entries(spec)
  const own = withoutPrototype<Fields>(entries)
  const { id, model, preset: name, protocol: named, maxTokensField } = own
  const preset = name === undefined ? undefined : presetOf(name)
  const issues: ConfigIssue[] = []
  if (name !== undefined && preset === undefined) issues.push({ path: `${id}.preset`, message: `must be one of ${wordList(Object.keys(presets))}` })

  let protocol = named === undefined ? preset?.protocol : undefined
  if (named === undefined && name === undefined) issues.push({ path: `${id}.protocol`, message: 'is required without a preset' })
  else if (named !== undefined && !(typeof named === 'string' && Object.hasOwn(ADAPTERS, named))) issues.push({ path: `${id}.protocol`, message: `must be ${wordList(Object.keys(ADAPTERS))}` })
  else if (named !== undefined && preset !== undefined && named !== preset.protocol) issues.push({ path: `${id}.protocol`, message: `must be ${preset.protocol}, the protocol of the ${name} preset` })
  else if (named !== undefined) protocol = named as Protocol

  const baseUrl = filled(own.baseUrl, preset?.baseUrl)
  if (baseUrl === undefined && name === undefined) issues.push({ path: `${id}.baseUrl`, message: 'is required without a preset' })
  else if (baseUrl === undefined && preset !== undefined) issues.push({ path: `${id}.baseUrl`, message: `is required: the ${name} preset has none` })
  else if (baseUrl !== undefined && typeof baseUrl !== 'string') issues.push({ path: `${id}.baseUrl`, message: 'must be a string' })

  if (maxTokensField !== undefined && protocol !== undefined && protocol !== 'openai-compatible') {
    issues.push({ path: `${id}.maxTokensField`, message: 'is only for the openai-compatible protocol' })
  }
  const usableModel = typeof model === 'string' && MODEL_ID.test(model)
  if (model === undefined) issues.push({ path: `${id}.model`, message: 'is required' })
  else if (!usableModel) issues.push({ path: `${id}.model`, message: 'must be a model id of visible ASCII characters, with no space' })
  else if (toolModelPatterns(preset, baseUrl).some(pattern => matchesModel(pattern, model))) issues.push({ path: `${id}.model`, message: TOOL_MODEL })
  if (protocol === undefined || typeof baseUrl !== 'string' || !usableModel) throw new ConfigError(issues)

  const fields: Array<[string, unknown]> = [
    ...entries.filter(([key]) => !BUILDER_FIELDS.has(key)),
    ['baseUrl', baseUrl],
    ['auth', filled(own.auth, preset?.auth)],
    ['structuredOutput', filled(own.structuredOutput, preset?.structuredOutput)],
    ['temperature', filled(own.temperature, preset?.temperature)],
  ]
  if (protocol === 'openai-compatible') fields.push(['maxTokensField', filled(maxTokensField, preset?.maxTokensField)])
  const options = withoutPrototype<OpenAICompatibleOptions>(fields)
  let adapterIssues: readonly ConfigIssue[] = []
  try {
    const provider = ADAPTERS[protocol](options)
    if (issues.length === 0) return provider
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    adapterIssues = error.issues
  }
  throw new ConfigError([...issues, ...adapterIssues])
}
