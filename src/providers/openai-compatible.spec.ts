import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { jsonReply } from '../testing/http.ts'
import { openaiCompatible } from './openai-compatible.ts'
import type { OpenAICompatibleOptions } from './openai-compatible.ts'
import { chatCompletion, mistralChunks, openRouterGenerationError, refusal, stringError, truncated } from '../testing/fixtures/openai-compatible.ts'
import { describeProviderContract } from '../testing/provider-contract.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [{ role: 'user', content: 'data' }],
  output: { name: 'panel_vote', schema: { type: 'object' } },
}

const ok = { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }

function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async () => jsonReply(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sent(fetchMock: ReturnType<typeof vi.fn>, call = 0): { url: string, headers: Record<string, string>, body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[call]
  return { url, headers: init.headers, body: JSON.parse(init.body) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type Body = Record<string, unknown>
const conversation = (body: Body): Array<{ role: string, content: string }> => body.messages as Array<{ role: string, content: string }>

describeProviderContract({
  protocol: 'openai-compatible',
  make: options => openaiCompatible(options),
  fixedHeaders: {},
  defaultKeyHeader: key => ['authorization', `Bearer ${key}`],
  replies: { ok: chatCompletion, model: 'gpt-6-astra-2026-09-30', usage: { inputTokens: 19, outputTokens: 10 }, refusal, truncated },
  read: {
    system: body => conversation(body).find(message => message.role === 'system')?.content,
    firstUser: body => conversation(body).find(message => message.role === 'user')?.content,
    temperature: body => body.temperature,
    maxTokens: body => body.max_tokens,
  },
  reservedBodyKeys: ['model', 'messages', 'stream'],
  toolBodyKeys: [
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'functions',
    'function_call',
    'web_search_options',
    'plugins',
    'deferred_tools',
    'stop_server_tools_when',
    'x_search_filter',
    'preset',
    'models',
    'search_parameters',
    'compound_custom',
    'search_settings',
    'include_domains',
    'exclude_domains',
    'disable_tool_validation',
    'documents',
  ],
  structuredOutputs: ['prompt', 'json', 'schema'],
  mergeProbe: { extraBody: { response_format: { added: true } }, merged: { response_format: { type: 'json_object', added: true } } },
})

describe('openaiCompatible', () => {
  const provider = openaiCompatible({ id: 'local', baseUrl: 'http://localhost:11434/v1//', model: 'qwen' })

  it('posts the system message first, then the data, to /chat/completions with json_object and temperature 0', async () => {
    const fetchMock = stubFetch(ok)
    await provider.complete(request)
    const { url, body } = sent(fetchMock)
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(body).toEqual({
      model: 'qwen',
      messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'data' }],
      response_format: { type: 'json_object' },
      temperature: 0,
    })
  })

  it.each([
    ['prompt', undefined],
    ['json', { type: 'json_object' }],
    ['schema', { type: 'json_schema', json_schema: { name: 'panel_vote', schema: { type: 'object' }, strict: true } }],
  ] as const)('maps structuredOutput %s to the response format the endpoint expects', async (structuredOutput, responseFormat) => {
    const fetchMock = stubFetch(ok)
    await openaiCompatible({ id: 'x', baseUrl: 'http://h/v1', model: 'm', structuredOutput }).complete(request)
    expect(sent(fetchMock).body.response_format).toEqual(responseFormat)
  })

  it('sends the token limit as max_completion_tokens when maxTokensField says so', async () => {
    const fetchMock = stubFetch(ok)
    await openaiCompatible({ id: 'x', baseUrl: 'http://h/v1', model: 'm', maxTokens: 900, maxTokensField: 'max_completion_tokens' }).complete(request)
    expect(sent(fetchMock).body).toMatchObject({ max_completion_tokens: 900 })
    expect(sent(fetchMock).body).not.toHaveProperty('max_tokens')
  })

  it('refuses a token-limit field or a structured-output mode it does not know', () => {
    const options = { id: 'x', baseUrl: 'http://h/v1', model: 'm', maxTokensField: 'max_output_tokens', structuredOutput: 'grammar' } as unknown as OpenAICompatibleOptions
    expect(() => openaiCompatible(options)).toThrow(new ConfigError([
      { path: 'x.structuredOutput', message: 'must be prompt, json or schema' },
      { path: 'x.maxTokensField', message: 'must be max_tokens or max_completion_tokens' },
    ]))
  })

  it('sends chat_template_kwargs, which sets template variables, such as turning thinking off, and runs nothing on the server', async () => {
    const fetchMock = stubFetch(ok)
    await openaiCompatible({ id: 'x', baseUrl: 'http://h/v1', model: 'm', extraBody: { chat_template_kwargs: { enable_thinking: false } } }).complete(request)
    expect(sent(fetchMock).body).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
  })

  it('returns the text, the model the endpoint reports and the usage', async () => {
    stubFetch({ model: 'qwen:latest', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
    await expect(provider.complete(request)).resolves.toEqual({ text: 'hi', model: 'qwen:latest', usage: { inputTokens: 10, outputTokens: 2 } })
  })

  it('falls back to the configured model, and reports no usage, when the endpoint sends none or only part', async () => {
    stubFetch(ok)
    await expect(provider.complete(request)).resolves.toEqual({ text: '{}', model: 'qwen', usage: undefined })
    stubFetch({ ...ok, model: '', usage: { prompt_tokens: 10 } })
    await expect(provider.complete(request)).resolves.toEqual({ text: '{}', model: 'qwen', usage: undefined })
  })

  it.each([
    ['refusal', { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I will not help with that' } }] }, /refused/],
    ['refusal', { choices: [{ message: { content: null, refusal: true } }] }, /refused/],
    ['refusal', { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }, /content filter/],
    ['truncated', { choices: [{ finish_reason: 'length', message: { content: '{"kee' } }] }, /cut off/],
    ['invalid-response', { choices: [] }, /no choices/],
    ['invalid-response', { choices: [{ message: { content: null } }] }, /no message content/],
    ['invalid-response', { error: { message: 'model not found' } }, /^local: server error: "model not found"$/],
    ['invalid-response', stringError, /^local: server error: "'response_format.type' must be 'json_schema' or 'text'"$/],
    ['invalid-response', { error: {} }, /^local: server error$/],
    ['truncated', { choices: [{ finish_reason: 'model_length', message: { content: '{"kee' } }] }, /cut off/],
    ['invalid-response', { choices: [{ finish_reason: 'insufficient_system_resource', message: { content: '' } }] }, /^local: reply ended early: "insufficient_system_resource"$/],
    ['invalid-response', { choices: [{ finish_reason: 'error', message: { content: '' } }] }, /^local: reply ended early: "error"$/],
    ['invalid-response', { choices: [{ message: { content: [{ type: 'thinking', thinking: [] }] } }] }, /no message content/],
    ['invalid-response', null, /not a JSON object/],
    ['invalid-response', [], /not a JSON object/],
    ['invalid-response', { choices: 'abc' }, /no choices/],
    ['invalid-response', { choices: [null] }, /no choices/],
    ['invalid-response', { choices: ['x'] }, /no choices/],
    ['invalid-response', { choices: [{ message: 'str' }] }, /no message content/],
    ['refusal', { choices: [{ message: { content: null, refusal: {} } }] }, /model refused$/],
  ])('maps a %s reply to a ProviderError', async (kind, body, message) => {
    stubFetch(body)
    await expect(provider.complete(request)).rejects.toMatchObject({ name: 'ProviderError', kind, providerId: 'local', message: expect.stringMatching(message) })
  })

  it('reports a server error sent with status 200 by its own code, so a 5xx stays retryable (OpenRouter)', async () => {
    stubFetch(openRouterGenerationError)
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'http', status: 502, retryable: true, message: 'local: server error 502: "Provider returned error"' })
  })

  it('reads a reply whose error is null as a success, and a server error whose code is not an error status as not retryable', async () => {
    stubFetch({ ...chatCompletion, error: null })
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '{}' })
    const notAnErrorStatus = ['rate_limit_exceeded', 200, 399, 600, 502.5, '502'].map(code => [code, 'invalid-response', false] as const)
    for (const [code, kind, retryable] of [...notAnErrorStatus, [429, 'http', true] as const]) {
      stubFetch({ error: { code, message: 'slow down' } })
      await expect(provider.complete(request), String(code)).rejects.toMatchObject({ kind, retryable })
    }
  })

  it('joins the text parts of a content array and skips its thinking parts (Mistral)', async () => {
    stubFetch(mistralChunks)
    await expect(provider.complete(request)).resolves.toEqual({ text: '{"keep":true,"reasoning":"r"}', model: 'magistral-medium-2610', usage: { inputTokens: 40, outputTokens: 12 } })
    stubFetch({ choices: [{ message: { content: [{ type: 'reasoning', text: 'a plan' }, { type: 'text', text: '{}' }] } }] })
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '{}' })
  })

  it('caps the refusal and the server error at 200 characters before quoting them', async () => {
    stubFetch({ choices: [{ message: { content: null, refusal: 'r'.repeat(1000) } }] })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: model refused: ${JSON.stringify('r'.repeat(200))}` })
    stubFetch({ error: { message: 'e'.repeat(1000) } })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: server error: ${JSON.stringify('e'.repeat(200))}` })
  })

  it('writes the refusal and the server error as JSON strings, so a line break cannot start a workflow command in a log', async () => {
    const escape = String.fromCharCode(27)
    stubFetch({ choices: [{ message: { content: null, refusal: `no\n::error::forged${escape}[2K` } }] })
    const refusal = await provider.complete(request).catch((caught: Error) => caught) as Error
    stubFetch({ error: { message: `bad\n::error::forged${escape}[2K` } })
    const server = await provider.complete(request).catch((caught: Error) => caught) as Error
    for (const { message } of [refusal, server]) {
      expect([...message].some(char => char.charCodeAt(0) < 32)).toBe(false)
      expect(message).toContain('::error::forged')
    }
  })

  it('redacts the key from a refusal or a server error that echoes it', async () => {
    const keyed = openaiCompatible({ id: 'local', baseUrl: 'http://h/v1', model: 'm', apiKey: 'sk-secret' })
    stubFetch({ choices: [{ message: { content: null, refusal: 'your key sk-secret is not allowed' } }] })
    await expect(keyed.complete(request)).rejects.toMatchObject({ message: 'local: model refused: "your key [redacted] is not allowed"' })
    stubFetch({ error: { message: 'bad key sk-secret' } })
    await expect(keyed.complete(request)).rejects.toMatchObject({ message: 'local: server error: "bad key [redacted]"' })
  })
})
