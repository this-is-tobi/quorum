import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { message } from '../testing/fixtures/anthropic.ts'
import { generateContentResponse } from '../testing/fixtures/gemini.ts'
import { chatResponse } from '../testing/fixtures/ollama.ts'
import { chatCompletion } from '../testing/fixtures/openai-compatible.ts'
import { sent, stubFetch } from '../testing/http.ts'
import { buildProvider } from './build.ts'
import type { ProviderSpec } from './build.ts'
import type { StructuredOutput } from './options.ts'
import { presets } from './presets.ts'
import type { PresetName, Protocol } from './presets.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [{ role: 'user', content: 'data' }],
  output: { name: 'panel_vote', schema: { type: 'object' } },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type Body = Record<string, unknown>

/** A recorded success of each protocol, so every adapter reads its reply. */
const REPLIES: Record<Protocol, unknown> = { 'openai-compatible': chatCompletion, anthropic: message, gemini: generateContentResponse, ollama: chatResponse }

/** Build a provider from `spec`, send one request through it, and return what reached fetch. */
async function send(spec: ProviderSpec): Promise<ReturnType<typeof sent>> {
  const protocol = (spec.protocol ?? presets[spec.preset as PresetName].protocol) as Protocol
  const fetchMock = stubFetch(REPLIES[protocol])
  await buildProvider(spec).complete(request)
  return sent(fetchMock)
}

/** The issues of the ConfigError that building `spec` throws, or none. */
function issuesOf(spec: Record<string, unknown>): readonly ConfigIssue[] {
  try {
    buildProvider(spec as unknown as ProviderSpec)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues
  }
  return []
}

const conversation = [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'data' }]
const RESPONSE_FORMATS: Record<StructuredOutput, unknown> = {
  prompt: undefined,
  json: { type: 'json_object' },
  schema: { type: 'json_schema', json_schema: { name: 'panel_vote', schema: { type: 'object' }, strict: true } },
}
/** An OpenAI-compatible body with a 900-token limit; toEqual reads an undefined field as absent. */
function chat(model: string, temperature: number | undefined, field: string, mode: StructuredOutput): Body {
  return { model, messages: conversation, response_format: RESPONSE_FORMATS[mode], temperature, [field]: 900 }
}
function ollamaChat(model: string): Body {
  return { model, messages: conversation, stream: false, truncate: false, shift: false, options: { temperature: 0, num_predict: 900 }, format: 'json' }
}
const bearer = { authorization: 'Bearer sk-k' }
const AZURE = 'https://res.openai.azure.com/openai/v1'
const toolModel = { path: 'p.model', message: 'runs tools on the server by itself, which quorum never allows' }
const notVisibleAscii = { path: 'p.model', message: 'must be a model id of visible ASCII characters, with no space' }
const GROQ = 'https://api.groq.com/openai/v1'

describe('buildProvider', () => {
  it.each<[PresetName, string, string, Record<string, string>, Body]>([
    ['ollama', 'qwen3.6:27b', 'http://localhost:11434/api/chat', bearer, ollamaChat('qwen3.6:27b')],
    ['ollama-cloud', 'deepseek-v3.1:671b', 'https://ollama.com/api/chat', bearer, ollamaChat('deepseek-v3.1:671b')],
    ['lmstudio', 'qwen3.6-27b', 'http://localhost:1234/v1/chat/completions', bearer, chat('qwen3.6-27b', 0, 'max_tokens', 'schema')],
    ['llamacpp', 'gemma-4', 'http://127.0.0.1:9931/v1/chat/completions', bearer, chat('gemma-4', 0, 'max_tokens', 'json')],
    ['vllm', 'llama-4-maverick', 'http://localhost:8000/v1/chat/completions', bearer, chat('llama-4-maverick', 0, 'max_tokens', 'json')],
    ['openai', 'gpt-5', 'https://api.openai.com/v1/chat/completions', bearer, chat('gpt-5', undefined, 'max_completion_tokens', 'json')],
    ['azure-openai', 'review-deployment', `${AZURE}/chat/completions`, { 'api-key': 'sk-k' }, chat('review-deployment', undefined, 'max_completion_tokens', 'json')],
    ['openrouter', 'anthropic/claude-opus-5-5', 'https://openrouter.ai/api/v1/chat/completions', bearer, chat('anthropic/claude-opus-5-5', 0, 'max_tokens', 'prompt')],
    ['groq', 'llama-3.3-70b-versatile', 'https://api.groq.com/openai/v1/chat/completions', bearer, chat('llama-3.3-70b-versatile', 0, 'max_completion_tokens', 'json')],
    ['mistral', 'mistral-large-2611', 'https://api.mistral.ai/v1/chat/completions', bearer, chat('mistral-large-2611', 0, 'max_tokens', 'json')],
    ['deepseek', 'deepseek-chat', 'https://api.deepseek.com/chat/completions', bearer, chat('deepseek-chat', 0, 'max_tokens', 'json')],
    ['together', 'moonshotai/Kimi-K2-Instruct', 'https://api.together.ai/v1/chat/completions', bearer, chat('moonshotai/Kimi-K2-Instruct', 0, 'max_tokens', 'json')],
    ['fireworks', 'accounts/fireworks/models/kimi-k2', 'https://api.fireworks.ai/inference/v1/chat/completions', bearer, chat('accounts/fireworks/models/kimi-k2', 0, 'max_tokens', 'json')],
    ['xai', 'grok-4.20', 'https://api.x.ai/v1/chat/completions', bearer, chat('grok-4.20', 0, 'max_completion_tokens', 'json')],
    [
      'anthropic',
      'claude-opus-5-5',
      'https://api.anthropic.com/v1/messages',
      { ...bearer, 'anthropic-version': '2026-10-21' },
      { model: 'claude-opus-5-5', max_tokens: 900, system: 'instructions', messages: [{ role: 'user', content: 'data' }], output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } },
    ],
    [
      'gemini',
      'gemini-3.8-flash',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      { 'x-goog-api-key': 'sk-k' },
      { contents: [{ role: 'user', parts: [{ text: 'data' }] }], systemInstruction: { parts: [{ text: 'instructions' }] }, generationConfig: { maxOutputTokens: 900, responseMimeType: 'application/json' } },
    ],
  ])('builds the %s preset: its URL, the key in its header and nowhere else, and its defaults in the body', async (preset, model, url, headers, body) => {
    const built = await send({ id: 'p', preset, model, apiKey: 'sk-k', maxTokens: 900, ...(preset === 'azure-openai' ? { baseUrl: AZURE } : {}) })
    expect(built).toEqual({ url, headers: { 'content-type': 'application/json', ...headers }, body })
    expect(`${built.url}${JSON.stringify(built.body)}`).not.toContain('sk-k')
  })

  it.each<[Protocol, string, Body]>([
    ['openai-compatible', 'https://h.example/chat/completions', chat('m', 0, 'max_tokens', 'json')],
    ['anthropic', 'https://h.example/v1/messages', { model: 'm', max_tokens: 900, system: 'instructions', messages: [{ role: 'user', content: 'data' }] }],
    ['gemini', 'https://h.example/v1beta/models/m:generateContent', { contents: [{ role: 'user', parts: [{ text: 'data' }] }], systemInstruction: { parts: [{ text: 'instructions' }] }, generationConfig: { maxOutputTokens: 900, responseMimeType: 'application/json' } }],
    ['ollama', 'https://h.example/api/chat', ollamaChat('m')],
  ])('builds the %s protocol without a preset, with its adapter\'s defaults', async (protocol, url, body) => {
    const built = await send({ id: 'p', protocol, baseUrl: 'https://h.example', model: 'm', maxTokens: 900 })
    expect({ url: built.url, body: built.body }).toEqual({ url, body })
  })

  it('lets a spec field override the preset\'s: the base URL, the key header, the token-limit field and the structured output', async () => {
    expect((await send({ id: 'p', preset: 'ollama', model: 'qwen', baseUrl: 'http://gpu.lan:11434' })).url).toBe('http://gpu.lan:11434/api/chat')
    const openai = await send({ id: 'p', preset: 'openai', model: 'gpt-5', apiKey: 'sk-k', auth: 'x-api-key', maxTokens: 900, maxTokensField: 'max_tokens' })
    expect(openai.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'sk-k' })
    expect(openai.body).toEqual(chat('gpt-5', undefined, 'max_tokens', 'json'))
    expect((await send({ id: 'p', preset: 'openrouter', model: 'openai/gpt-4.1', structuredOutput: 'json' })).body.response_format).toEqual({ type: 'json_object' })
    expect((await send({ id: 'p', preset: 'groq', protocol: 'openai-compatible', model: 'llama-3.3-70b-versatile' })).url).toBe('https://api.groq.com/openai/v1/chat/completions')
  })

  it('sends temperature 0 when set on openai, whose preset leaves it out, and none for null on mistral, whose preset sends 0', async () => {
    expect((await send({ id: 'p', preset: 'openai', model: 'gpt-5', temperature: 0 })).body).toMatchObject({ temperature: 0 })
    expect((await send({ id: 'p', preset: 'mistral', model: 'mistral-large-2611', temperature: null })).body).not.toHaveProperty('temperature')
  })

  it('keeps the preset\'s value for a spec field set to undefined, as a spread of an unset config value gives', async () => {
    const unset = { baseUrl: undefined, auth: undefined, structuredOutput: undefined, temperature: undefined, maxTokensField: undefined }
    const openai = await send({ id: 'p', preset: 'openai', model: 'gpt-5', apiKey: 'k', maxTokens: 900, ...unset })
    expect(openai.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(openai.body).toEqual(chat('gpt-5', undefined, 'max_completion_tokens', 'json'))
    expect(openai.body).not.toHaveProperty('temperature')
    expect((await send({ id: 'p', preset: 'azure-openai', baseUrl: AZURE, model: 'd', apiKey: 'k', auth: undefined })).headers).toEqual({ 'content-type': 'application/json', 'api-key': 'k' })
    expect((await send({ id: 'p', preset: 'openrouter', model: 'openai/gpt-4.1', structuredOutput: undefined })).body).not.toHaveProperty('response_format')
    expect(issuesOf({ id: 'p', preset: 'anthropic', model: 'claude-opus-5-5', maxTokensField: undefined })).toEqual([])
  })

  const names = 'ollama, ollama-cloud, lmstudio, llamacpp, vllm, openai, azure-openai, openrouter, groq, mistral, deepseek, together, fireworks, xai, anthropic or gemini'

  it.each<[string, Record<string, unknown>, ConfigIssue[]]>([
    ['an unknown preset', { preset: 'gpt', model: 'm' }, [{ path: 'p.preset', message: `must be one of ${names}` }]],
    ['a preset name in another letter case', { preset: 'OpenAI', model: 'm' }, [{ path: 'p.preset', message: `must be one of ${names}` }]],
    ['a key of every object as the preset', { preset: 'toString', model: 'm' }, [{ path: 'p.preset', message: `must be one of ${names}` }]],
    ['no preset and no protocol', { baseUrl: 'https://h.example', model: 'm' }, [{ path: 'p.protocol', message: 'is required without a preset' }]],
    ['an unknown protocol', { protocol: 'openai', baseUrl: 'https://h.example', model: 'm' }, [{ path: 'p.protocol', message: 'must be openai-compatible, anthropic, gemini or ollama' }]],
    ['a key of every object as the protocol', { protocol: 'constructor', baseUrl: 'https://h.example', model: 'm' }, [{ path: 'p.protocol', message: 'must be openai-compatible, anthropic, gemini or ollama' }]],
    ['a protocol other than the preset\'s', { preset: 'openai', protocol: 'anthropic', model: 'm' }, [{ path: 'p.protocol', message: 'must be openai-compatible, the protocol of the openai preset' }]],
    ['no preset and no base URL', { protocol: 'ollama', model: 'm' }, [{ path: 'p.baseUrl', message: 'is required without a preset' }]],
    ['no base URL for azure-openai', { preset: 'azure-openai', model: 'd' }, [{ path: 'p.baseUrl', message: 'is required: the azure-openai preset has none' }]],
    ['a token-limit field on anthropic', { preset: 'anthropic', model: 'claude-opus-5-5', maxTokensField: 'max_tokens' }, [{ path: 'p.maxTokensField', message: 'is only for the openai-compatible protocol' }]],
    ['a token-limit field on gemini without a preset', { protocol: 'gemini', baseUrl: 'https://h.example', model: 'm', maxTokensField: 'max_completion_tokens' }, [{ path: 'p.maxTokensField', message: 'is only for the openai-compatible protocol' }]],
    ['a model that runs tools', { preset: 'openai', model: 'gpt-5-search-api' }, [toolModel]],
  ])('refuses %s with its exact message', (_name, spec, issues) => {
    expect(issuesOf({ id: 'p', ...spec })).toEqual(issues)
  })

  it('throws the spec\'s problems alone while the protocol or the base URL is unknown, and builds nothing', () => {
    const bad = { temperature: Number.NaN, model: 'm' }
    expect(issuesOf({ id: 'p', ...bad, maxTokensField: 'max_tokens' })).toEqual([
      { path: 'p.protocol', message: 'is required without a preset' },
      { path: 'p.baseUrl', message: 'is required without a preset' },
    ])
    expect(issuesOf({ id: 'p', ...bad, preset: 'azure-openai', protocol: 'gemini' })).toEqual([
      { path: 'p.protocol', message: 'must be openai-compatible, the protocol of the azure-openai preset' },
      { path: 'p.baseUrl', message: 'is required: the azure-openai preset has none' },
    ])
    expect(issuesOf({ id: 'p', ...bad, preset: 'openrouter', protocol: 'ollama', model: 'perplexity/sonar' })).toEqual([
      { path: 'p.protocol', message: 'must be openai-compatible, the protocol of the openrouter preset' },
      toolModel,
    ])
    expect(issuesOf({ id: 'p', ...bad, preset: 'gpt', protocol: 'ollama' })).toEqual([{ path: 'p.preset', message: `must be one of ${names}` }])
    expect(issuesOf({ id: 'p', ...bad, preset: 'openai', model: ' m', maxTokensField: 'max_tokens' })).toEqual([notVisibleAscii])
  })

  it('throws the spec\'s problems, then the adapter\'s, in one ConfigError, once the protocol and the base URL are known', () => {
    expect(issuesOf({ id: 'p', preset: 'gemini', model: 'deep-research-max-preview-04-2026', maxTokensField: 'max_tokens', temperature: Number.NaN, query: { key: 'x' } })).toEqual([
      { path: 'p.maxTokensField', message: 'is only for the openai-compatible protocol' },
      toolModel,
      { path: 'p.temperature', message: 'must be a finite number, or null to leave it out' },
      { path: 'p.query.key', message: 'would carry a key in the URL: set apiKey instead' },
    ])
    expect(issuesOf({ id: 'p', preset: 'gpt', protocol: 'ollama', baseUrl: 'https://h.example', model: 'm', maxTokens: 0 })).toEqual([
      { path: 'p.preset', message: `must be one of ${names}` },
      { path: 'p.maxTokens', message: 'must be a whole number of at least 1' },
    ])
    expect(issuesOf({ id: 'p', preset: 'openai', model: 'gpt-5', maxTokensField: 'max_output_tokens' })).toEqual([{ path: 'p.maxTokensField', message: 'must be max_tokens or max_completion_tokens' }])
  })

  it.each<[PresetName, string]>([
    ['openai', 'gpt-5-search-api'],
    ['openai', 'computer-use-preview'],
    ['openrouter', 'openai/gpt-5:online'],
    ['openrouter', '@preset/review-tools'],
    ['openrouter', 'openrouter/fusion'],
    ['openrouter', 'openrouter/auto'],
    ['openrouter', 'perplexity/sonar-pro'],
    ['openrouter', 'openai/gpt-5-search-api'],
    ['groq', 'openai/gpt-oss-120b'],
    ['groq', 'groq/compound-mini'],
    ['groq', 'compound-beta'],
    ['xai', 'grok-4.20-multi-agent'],
    ['gemini', 'deep-research-preview-04-2026'],
    ['gemini', 'antigravity-preview-09-2026'],
    ['gemini', 'gemini-2.5-computer-use-preview-10-2025'],
  ])('refuses the %s preset with %s, a model that runs tools on the server by itself', (preset, model) => {
    expect(issuesOf({ id: 'p', preset, model, apiKey: 'k' })).toEqual([toolModel])
  })

  it('refuses a tool model id in another letter case, and a Gemini id with its models/ prefix', () => {
    expect(issuesOf({ id: 'p', preset: 'groq', model: 'OpenAI/GPT-OSS-120B' })).toEqual([toolModel])
    expect(issuesOf({ id: 'p', preset: 'gemini', model: 'models/deep-research-max-preview-04-2026' })).toEqual([toolModel])
  })

  it.each<[string, string, unknown]>([
    ['a leading space', 'groq', ' openai/gpt-oss-120b'],
    ['a leading tab', 'groq', `${String.fromCharCode(9)}openai/gpt-oss-120b`],
    ['a trailing space', 'groq', 'openai/gpt-oss-120b '],
    ['a space inside', 'groq', 'openai/gpt-oss- 120b'],
    ['a line break inside, which `.` would not cross', 'openai', `gpt-5${String.fromCharCode(10)}-search-api`],
    ['the long s inside, which a server may fold to s', 'openai', `gpt-5-${String.fromCharCode(0x17F)}earch-api`],
    ['a no-break space', 'groq', `openai/gpt-oss${String.fromCharCode(0xA0)}120b`],
    ['a delete character', 'groq', `openai/gpt-oss${String.fromCharCode(0x7F)}120b`],
    ['an empty string', 'groq', ''],
    ['no model', 'groq', undefined],
    ['a number', 'groq', 120],
    ['an array holding a tool id', 'groq', ['openai/gpt-oss-120b']],
    ['a Symbol', 'groq', Symbol('openai/gpt-oss-120b')],
  ])('refuses a model that is not a string of visible ASCII characters, such as %s, with that message alone', (_name, preset, model) => {
    expect(issuesOf({ id: 'p', preset, model })).toEqual([notVisibleAscii])
  })

  it('refuses a model that is not visible ASCII the same way without a preset', () => {
    expect(issuesOf({ id: 'p', protocol: 'openai-compatible', baseUrl: GROQ, model: ' openai/gpt-oss-120b' })).toEqual([notVisibleAscii])
    expect(issuesOf({ id: 'p', protocol: 'ollama', baseUrl: 'http://localhost:11434', model: Symbol('m') })).toEqual([notVisibleAscii])
  })

  it.each<[string, string]>([
    ['openai', 'gpt-5'],
    ['openrouter', 'openai/gpt-4.1'],
    ['groq', 'llama-3.3-70b-versatile'],
    ['groq', 'my-compound-beta'],
    ['gemini', 'gemini-3.8-flash'],
  ])('allows the %s preset with %s, which no pattern matches whole', (preset, model) => {
    expect(issuesOf({ id: 'p', preset, model })).toEqual([])
  })

  it.each<[string, Record<string, unknown>]>([
    ['a protocol and Groq\'s base URL, without a preset', { protocol: 'openai-compatible', baseUrl: GROQ }],
    ['the vllm preset pointed at Groq\'s base URL', { preset: 'vllm', baseUrl: GROQ }],
    ['the same origin in another letter case, with another path', { protocol: 'openai-compatible', baseUrl: 'HTTPS://API.GROQ.COM/v9' }],
    ['the same origin with its default port written out', { protocol: 'openai-compatible', baseUrl: 'https://api.groq.com:443/openai/v1' }],
  ])('refuses the Groq tool model gpt-oss through %s', (_name, spec) => {
    expect(issuesOf({ id: 'p', ...spec, model: 'openai/gpt-oss-120b' })).toEqual([toolModel])
  })

  it('refuses a model through the origin of a preset other than the named one, and once when several lists match', () => {
    expect(issuesOf({ id: 'p', preset: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5:online' })).toEqual([toolModel])
    expect(issuesOf({ id: 'p', preset: 'openrouter', baseUrl: GROQ, model: 'openai/gpt-oss-120b:online' })).toEqual([toolModel])
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['another port of Groq\'s host, which is another origin', { protocol: 'openai-compatible', baseUrl: 'https://api.groq.com:8443/openai/v1' }, 'openai/gpt-oss-120b'],
    ['plain http to Groq\'s host, which is another origin', { protocol: 'openai-compatible', baseUrl: 'http://api.groq.com/openai/v1' }, 'openai/gpt-oss-120b'],
    ['a model the origin\'s preset allows', { protocol: 'openai-compatible', baseUrl: GROQ }, 'llama-3.3-70b-versatile'],
    ['a local server, whose origin no preset with tool models has', { protocol: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' }, 'gpt-5-search-api'],
    ['a gateway at another origin', { preset: 'groq', baseUrl: 'https://gateway.example/groq' }, 'llama-3.3-70b-versatile'],
  ])('allows %s', (_name, spec, model) => {
    expect(issuesOf({ id: 'p', ...spec, model })).toEqual([])
  })

  it('still holds a model to the named preset\'s list when the base URL is moved to another origin', () => {
    expect(issuesOf({ id: 'p', preset: 'groq', baseUrl: 'https://gateway.example/groq', model: 'openai/gpt-oss-120b' })).toEqual([toolModel])
  })

  it('gives a base URL that is no URL no origin, so only the named preset\'s list applies, and leaves the URL to the adapter', () => {
    const adapterIssue = { path: 'p.baseUrl', message: 'must be an http:// or https:// URL with a host' }
    expect(issuesOf({ id: 'p', protocol: 'openai-compatible', baseUrl: 'api.groq.com', model: 'openai/gpt-oss-120b' })).toEqual([adapterIssue])
    expect(issuesOf({ id: 'p', protocol: 'openai-compatible', baseUrl: 42, model: 'openai/gpt-oss-120b' })).toEqual([adapterIssue])
    expect(issuesOf({ id: 'p', preset: 'groq', baseUrl: 'api.groq.com', model: 'openai/gpt-oss-120b' })).toEqual([toolModel, adapterIssue])
  })

  it('builds from the original presets after a caller tried to change them', async () => {
    expect(() => {
      (presets.openai as { baseUrl?: string }).baseUrl = 'http://evil.example'
    }).toThrow(TypeError)
    expect(() => (presets.openai.toolModels as string[]).splice(0)).toThrow(TypeError)
    expect((await send({ id: 'p', preset: 'openai', model: 'gpt-5' })).url).toBe('https://api.openai.com/v1/chat/completions')
    expect(issuesOf({ id: 'p', preset: 'openai', model: 'gpt-5-search-api' })).toEqual([toolModel])
  })

  it('lets an error that is not a ConfigError through, as the adapter raised it', () => {
    const headers = new Proxy({}, {
      ownKeys: () => {
        throw new RangeError('unreadable headers')
      },
    })
    expect(() => buildProvider({ id: 'p', preset: 'openai', model: 'gpt-5', headers })).toThrow(RangeError)
  })

  it('repeats no value in a message, the key least of all', () => {
    const key = 'sk-zz-secret'
    const specs = [
      { preset: key, model: 'm' },
      { protocol: key, baseUrl: 'https://h.example', model: 'm' },
      { preset: 'openai', protocol: key, model: 'm' },
      { preset: 'groq', model: 'openai/gpt-oss-120b', baseUrl: `https://${key}@h.example`, query: { k: key } },
    ]
    for (const spec of specs) {
      let thrown: unknown
      try {
        buildProvider({ id: 'p', apiKey: key, ...spec } as ProviderSpec)
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify(Object.keys(spec))).toBeInstanceOf(ConfigError)
      expect((thrown as ConfigError).message).not.toMatch(/zz|gpt-oss/)
    }
  })
})
