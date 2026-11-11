import type { Auth, StructuredOutput } from './options.ts'

/** The wire protocols of the HTTP adapters. */
export type Protocol = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama'

export type PresetName = 'ollama' | 'ollama-cloud' | 'lmstudio' | 'llamacpp' | 'vllm' | 'openai' | 'azure-openai' | 'openrouter' | 'groq' | 'mistral' | 'deepseek' | 'together' | 'fireworks' | 'xai' | 'anthropic' | 'gemini'

/** The defaults a preset fills in; any field set on the provider overrides them. */
export interface Preset {
  readonly protocol: Protocol
  /** Absent when the provider must set one (`azure-openai`). */
  readonly baseUrl?: string
  readonly auth: Auth
  /** The variable the vendor documents for its key, read by the configuration layer (phase 4). */
  readonly apiKeyEnv?: string
  readonly structuredOutput: StructuredOutput
  /** `null` leaves the field out. */
  readonly temperature: number | null
  /** `openai-compatible` only. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Model ids that run tools on the server by themselves, as patterns where `*` stands for any text, matched in any letter case. */
  readonly toolModels: readonly string[]
}

/** `value` frozen, with every object and array it holds, so no caller can change a default another provider reads. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const field of Object.values(value)) deepFreeze(field)
    Object.freeze(value)
  }
  return value
}

/**
 * The defaults of each vendor's documented endpoint. `temperature` is 0 unless the vendor rejects one
 * (OpenAI's and Azure's reasoning models, Anthropic) or its current models ignore it (Gemini).
 * `structuredOutput` is `json` where the server documents a JSON mode, `schema` where it documents only
 * a schema (LM Studio, Anthropic), and `prompt` where support varies by the model a request is routed to
 * (OpenRouter, which ignores a format the endpoint cannot honour). `maxTokensField` is the field the
 * vendor documents: OpenAI, Azure, Groq and xAI deprecate `max_tokens`.
 */
export const presets: Readonly<Record<PresetName, Preset>> = deepFreeze<Record<PresetName, Preset>>({
  ollama: { protocol: 'ollama', baseUrl: 'http://localhost:11434', auth: 'bearer', structuredOutput: 'json', temperature: 0, toolModels: [] },
  'ollama-cloud': { protocol: 'ollama', baseUrl: 'https://ollama.com', auth: 'bearer', apiKeyEnv: 'OLLAMA_API_KEY', structuredOutput: 'json', temperature: 0, toolModels: [] },
  lmstudio: { protocol: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', auth: 'bearer', structuredOutput: 'schema', temperature: 0, maxTokensField: 'max_tokens', toolModels: [] },
  llamacpp: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9931/v1', auth: 'bearer', structuredOutput: 'json', temperature: 0, maxTokensField: 'max_tokens', toolModels: [] },
  vllm: { protocol: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', auth: 'bearer', structuredOutput: 'json', temperature: 0, maxTokensField: 'max_tokens', toolModels: [] },
  // The search models search the web before every answer; the computer-use models drive a browser.
  openai: { protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', auth: 'bearer', apiKeyEnv: 'OPENAI_API_KEY', structuredOutput: 'json', temperature: null, maxTokensField: 'max_completion_tokens', toolModels: ['*search*', '*computer-use*'] },
  // The base URL names the user's own resource, and the model ids are the user's own deployment names.
  'azure-openai': { protocol: 'openai-compatible', auth: { header: 'api-key' }, apiKeyEnv: 'AZURE_OPENAI_API_KEY', structuredOutput: 'json', temperature: null, maxTokensField: 'max_completion_tokens', toolModels: [] },
  // `:online` searches the web, a `@preset/` slug can hold tools, fusion searches and fetches, auto routes
  // to a pool that may hold search models, and Perplexity's models and any search model search by themselves.
  openrouter: {
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    structuredOutput: 'prompt',
    temperature: 0,
    maxTokensField: 'max_tokens',
    toolModels: ['*:online*', '*@preset/*', 'openrouter/fusion*', 'openrouter/auto*', 'perplexity/*', '*search*'],
  },
  // gpt-oss runs its built-in web search and code execution by itself, which no parameter turns off, and
  // the compound models run tools by themselves.
  groq: { protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', apiKeyEnv: 'GROQ_API_KEY', structuredOutput: 'json', temperature: 0, maxTokensField: 'max_completion_tokens', toolModels: ['openai/gpt-oss-*', 'groq/compound*', 'compound-beta*'] },
  mistral: { protocol: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', auth: 'bearer', apiKeyEnv: 'MISTRAL_API_KEY', structuredOutput: 'json', temperature: 0, maxTokensField: 'max_tokens', toolModels: [] },
  deepseek: { protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com', auth: 'bearer', apiKeyEnv: 'DEEPSEEK_API_KEY', structuredOutput: 'json', temperature: 0, maxTokensField: 'max_tokens', toolModels: [] },
  together: { protocol: 'openai-compatible', baseUrl: 'https://api.together.ai/v1', auth: 'bearer', apiKeyEnv: 'TOGETHER_API_KEY', structuredOutput: 'json', temperature: 0, maxTokensField: 'max_tokens', toolModels: [] },
  fireworks: { protocol: 'openai-compatible', baseUrl: 'https://api.fireworks.ai/inference/v1', auth: 'bearer', apiKeyEnv: 'FIREWORKS_API_KEY', structuredOutput: 'json', temperature: 0, maxTokensField: 'max_tokens', toolModels: [] },
  // The multi-agent model works only on the Responses API, where xAI runs its server-side tools.
  xai: { protocol: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', auth: 'bearer', apiKeyEnv: 'XAI_API_KEY', structuredOutput: 'json', temperature: 0, maxTokensField: 'max_completion_tokens', toolModels: ['*multi-agent*'] },
  anthropic: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'bearer', apiKeyEnv: 'ANTHROPIC_API_KEY', structuredOutput: 'schema', temperature: null, toolModels: [] },
  // Deep Research and Antigravity are agents that search, fetch URLs and run code; the computer-use models drive a browser.
  gemini: {
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    auth: { header: 'x-goog-api-key' },
    apiKeyEnv: 'GEMINI_API_KEY',
    structuredOutput: 'json',
    temperature: null,
    toolModels: ['*deep-research*', '*antigravity*', '*computer-use*'],
  },
})

/** `entries` as an object with no prototype: a field they lack reads `undefined`, whatever `Object.prototype` holds. */
export function withoutPrototype<T>(entries: Iterable<readonly [string, unknown]>): T {
  return Object.setPrototypeOf(Object.fromEntries(entries), null) as T
}

/** The preset a name names, or undefined: a name is looked up among the table's own keys only, never its prototype's, and the row is a copy that has no prototype either. */
export function presetOf(name: unknown): Preset | undefined {
  return typeof name === 'string' && Object.hasOwn(presets, name) ? withoutPrototype<Preset>(Object.entries(presets[name as PresetName])) : undefined
}
