import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { Provider } from '../core/ports.ts'
import { anthropic } from './anthropic.ts'
import { gemini } from './gemini.ts'
import { ollama } from './ollama.ts'
import { openaiCompatible } from './openai-compatible.ts'
import type { OpenAICompatibleOptions } from './openai-compatible.ts'
import { wordList } from './options.ts'
import type { HttpProviderOptions } from './options.ts'
import { presets } from './presets.ts'
import type { Preset, PresetName, Protocol } from './presets.ts'

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

/** The spec's value, or the preset's when the spec leaves it unset: a field set to `undefined` is unset, `null` is set. */
function filled<T>(value: T | undefined, preset: T | undefined): T | undefined {
  return value === undefined ? preset : value
}

/**
 * Whether `pattern` matches the whole of `model` in any letter case: `*` stands for any text, possibly
 * empty, a line break included, and every other character for itself. Unicode case folding also matches
 * U+017F, the long s, to `s`, as a server that folds a model id may.
 */
function matchesModel(pattern: string, model: string): boolean {
  const literals = pattern.split('*').map(part => part.replace(/[$()+.?[\\\]^{|}]/g, '\\$&'))
  return new RegExp(`^${literals.join('.*')}$`, 'isu').test(model)
}

/** The preset a name names, or undefined: a name is looked up among the table's own keys only, never its prototype's. */
function presetOf(name: string): Preset | undefined {
  return Object.hasOwn(presets, name) ? presets[name as PresetName] : undefined
}

/**
 * Build a provider from a spec: the preset fills in `baseUrl`, `auth`, `structuredOutput`, `temperature`
 * and, for `openai-compatible`, `maxTokensField`, and any of them set on the spec wins. A preset refuses
 * the model ids it knows run tools on the server by themselves. No message repeats a value of the spec.
 *
 * @throws ConfigError with every problem of the spec and of the adapter's options, before any request
 */
export function buildProvider(spec: ProviderSpec): Provider {
  const { preset: name, protocol: named, maxTokensField, ...options } = spec
  const { id, model } = spec
  const preset = name === undefined ? undefined : presetOf(name)
  const issues: ConfigIssue[] = []
  if (name !== undefined && preset === undefined) issues.push({ path: `${id}.preset`, message: `must be one of ${wordList(Object.keys(presets))}` })

  let protocol = named === undefined ? preset?.protocol : undefined
  if (named === undefined && name === undefined) issues.push({ path: `${id}.protocol`, message: 'is required without a preset' })
  else if (named !== undefined && !Object.hasOwn(ADAPTERS, named)) issues.push({ path: `${id}.protocol`, message: `must be ${wordList(Object.keys(ADAPTERS))}` })
  else if (named !== undefined && preset !== undefined && named !== preset.protocol) issues.push({ path: `${id}.protocol`, message: `must be ${preset.protocol}, the protocol of the ${name} preset` })
  else if (named !== undefined) protocol = named as Protocol

  const baseUrl = filled(spec.baseUrl, preset?.baseUrl)
  if (baseUrl === undefined && name === undefined) issues.push({ path: `${id}.baseUrl`, message: 'is required without a preset' })
  else if (baseUrl === undefined && preset !== undefined) issues.push({ path: `${id}.baseUrl`, message: `is required: the ${name} preset has none` })

  if (maxTokensField !== undefined && protocol !== undefined && protocol !== 'openai-compatible') {
    issues.push({ path: `${id}.maxTokensField`, message: 'is only for the openai-compatible protocol' })
  }
  if (preset !== undefined && preset.toolModels.some(pattern => matchesModel(pattern, model))) {
    issues.push({ path: `${id}.model`, message: TOOL_MODEL })
  }
  if (protocol === undefined || baseUrl === undefined) throw new ConfigError(issues)

  const shared: HttpProviderOptions = {
    ...options,
    baseUrl,
    auth: filled(spec.auth, preset?.auth),
    structuredOutput: filled(spec.structuredOutput, preset?.structuredOutput),
    temperature: filled(spec.temperature, preset?.temperature),
  }
  let adapterIssues: readonly ConfigIssue[] = []
  try {
    const provider = ADAPTERS[protocol](protocol === 'openai-compatible' ? { ...shared, maxTokensField: filled(maxTokensField, preset?.maxTokensField) } : shared)
    if (issues.length === 0) return provider
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    adapterIssues = error.issues
  }
  throw new ConfigError([...issues, ...adapterIssues])
}
