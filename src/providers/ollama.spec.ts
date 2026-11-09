import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderErrorKind } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { jsonReply } from '../testing/http.ts'
import { ollama } from './ollama.ts'
import { chatResponse, contextExceeded, debugRender, truncated } from '../testing/fixtures/ollama.ts'
import { describeProviderContract } from '../testing/provider-contract.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [{ role: 'user', content: 'data' }],
  output: { name: 'panel_vote', schema: { type: 'object' } },
}

function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async () => jsonReply(body, status))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sent(fetchMock: ReturnType<typeof vi.fn>): { url: string, headers: Record<string, string>, body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[0]
  return { url, headers: init.headers, body: JSON.parse(init.body) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type Body = Record<string, unknown>
const conversation = (body: Body): Array<{ role: string, content: string }> => body.messages as Array<{ role: string, content: string }>
const runtime = (body: Body): Body => (body.options ?? {}) as Body

describeProviderContract({
  protocol: 'ollama',
  make: options => ollama(options),
  fixedHeaders: {},
  defaultKeyHeader: key => ['authorization', `Bearer ${key}`],
  replies: { ok: chatResponse, model: 'qwen3.6:27b', usage: { inputTokens: 1840, outputTokens: 412 }, truncated },
  read: {
    system: body => conversation(body).find(message => message.role === 'system')?.content,
    firstUser: body => conversation(body).find(message => message.role === 'user')?.content,
    temperature: body => runtime(body).temperature,
    maxTokens: body => runtime(body).num_predict,
  },
  reservedBodyKeys: ['model', 'messages', 'stream', 'truncate', 'shift'],
  toolBodyKeys: ['tools', '_debug_render_only'],
  structuredOutputs: ['prompt', 'json', 'schema'],
  mergeProbe: { extraBody: { options: { num_ctx: 32768 } }, merged: { options: { temperature: 0, num_ctx: 32768 } } },
})

describe('ollama', () => {
  const options = { id: 'local', baseUrl: 'http://localhost:11434', model: 'qwen3.6:27b' }
  const provider = ollama(options)
  const messages = [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'data' }]

  it('posts the system message first, then the data, to /api/chat, with no stream, no truncation, temperature 0 and JSON format', async () => {
    const fetchMock = stubFetch(chatResponse)
    await provider.complete(request)
    const { url, headers, body } = sent(fetchMock)
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(headers).toEqual({ 'content-type': 'application/json' })
    expect(body).toEqual({ model: 'qwen3.6:27b', messages, stream: false, truncate: false, shift: false, options: { temperature: 0 }, format: 'json' })
  })

  it.each([
    ['prompt', undefined],
    ['json', 'json'],
    ['schema', { type: 'object' }],
  ] as const)('maps structuredOutput %s to the format it sends', async (structuredOutput, format) => {
    const fetchMock = stubFetch(chatResponse)
    await ollama({ ...options, structuredOutput }).complete(request)
    expect(sent(fetchMock).body.format).toEqual(format)
  })

  it('sends the token limit as num_predict, and leaves the temperature out for null', async () => {
    const fetchMock = stubFetch(chatResponse)
    await ollama({ ...options, temperature: null, maxTokens: 900 }).complete(request)
    expect(sent(fetchMock).body).toEqual({ model: 'qwen3.6:27b', messages, stream: false, truncate: false, shift: false, options: { num_predict: 900 }, format: 'json' })
  })

  it('sends no options when it would be empty', async () => {
    const fetchMock = stubFetch(chatResponse)
    await ollama({ ...options, temperature: null }).complete(request)
    expect(sent(fetchMock).body).toEqual({ model: 'qwen3.6:27b', messages, stream: false, truncate: false, shift: false, format: 'json' })
  })

  it('returns the content as it came, a think block included, and ignores the thinking, with the model and the usage', async () => {
    stubFetch(chatResponse)
    await expect(provider.complete(request)).resolves.toEqual({ text: '{}', model: 'qwen3.6:27b', usage: { inputTokens: 1840, outputTokens: 412 } })
    stubFetch({ ...chatResponse, message: { role: 'assistant', content: '<think>a plan</think>{}' } })
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '<think>a plan</think>{}' })
  })

  it('falls back to the configured model, and reports no usage, when the reply names neither', async () => {
    stubFetch({ ...chatResponse, model: '', eval_count: undefined })
    await expect(provider.complete(request)).resolves.toEqual({ text: '{}', model: 'qwen3.6:27b', usage: undefined })
  })

  const { done_reason: _doneReason, ...noDoneReason } = chatResponse

  it.each<[ProviderErrorKind, unknown, string]>([
    ['truncated', truncated, 'local: reply was cut off by the token limit'],
    ['invalid-response', { error: 'model "qwen9" not found, try pulling it first' }, 'local: server error: "model \\"qwen9\\" not found, try pulling it first"'],
    ['invalid-response', { ...chatResponse, done: false }, 'local: reply has not finished'],
    ['invalid-response', { ...chatResponse, done: 'true' }, 'local: reply has not finished'],
    ['invalid-response', noDoneReason, 'local: reply has not finished'],
    ['invalid-response', { ...chatResponse, done_reason: 'load' }, 'local: reply has not finished'],
    ['invalid-response', { ...chatResponse, done_reason: '' }, 'local: reply has not finished'],
    ['invalid-response', debugRender, 'local: reply has not finished'],
    ['invalid-response', { ...chatResponse, message: { role: 'assistant', content: null } }, 'local: reply has no text'],
    ['invalid-response', { ...chatResponse, message: 'text' }, 'local: reply has no text'],
    ['invalid-response', { ...chatResponse, message: undefined }, 'local: reply has no text'],
    ['invalid-response', [], 'local: reply is not a JSON object'],
    ['invalid-response', null, 'local: reply is not a JSON object'],
  ])('maps a %s reply to a ProviderError with its exact message', async (kind, body, expected) => {
    stubFetch(body)
    await expect(provider.complete(request)).rejects.toMatchObject({ name: 'ProviderError', kind, retryable: false, providerId: 'local', message: expected })
  })

  it('redacts the key from a server error and cuts it at 200 characters', async () => {
    stubFetch({ error: 'bad key ok-secret' })
    await expect(ollama({ ...options, baseUrl: 'https://ollama.com', apiKey: 'ok-secret' }).complete(request)).rejects.toMatchObject({ message: 'local: server error: "bad key [redacted]"' })
    stubFetch({ error: 'e'.repeat(1000) })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: server error: ${JSON.stringify('e'.repeat(200))}` })
  })

  it('quotes the 400 of a prompt past the context, which truncate: false turns a silent cut into', async () => {
    stubFetch(contextExceeded, 400)
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'http', status: 400, retryable: false, message: `local: HTTP 400: ${JSON.stringify(JSON.stringify(contextExceeded))}` })
  })
})
