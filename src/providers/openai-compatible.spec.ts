import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { jsonReply } from '../testing/http.ts'
import { openaiCompatible } from './openai-compatible.ts'
import type { OpenAICompatibleOptions } from './openai-compatible.ts'
import { chatCompletion, refusal, truncated } from '../testing/fixtures/openai-compatible.ts'
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
      { path: 'x.maxTokensField', message: 'must be max_tokens or max_completion_tokens' },
      { path: 'x.structuredOutput', message: 'must be prompt, json or schema' },
    ]))
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
    ['invalid-response', { error: { message: 'model not found' } }, /model not found/],
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

  it('caps the refusal and the server error at 200 characters before quoting them', async () => {
    stubFetch({ choices: [{ message: { content: null, refusal: 'r'.repeat(1000) } }] })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: model refused: ${JSON.stringify('r'.repeat(200))}` })
    stubFetch({ error: { message: 'e'.repeat(1000) } })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: reply has no choices: server error ${JSON.stringify('e'.repeat(200))}` })
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
    await expect(keyed.complete(request)).rejects.toMatchObject({ message: 'local: reply has no choices: server error "bad key [redacted]"' })
  })
})
