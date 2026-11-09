import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { jsonReply } from '../testing/http.ts'
import { anthropic } from './anthropic.ts'
import { contextWindowFull, message, notFound, refusal, toolUse, truncated } from '../testing/fixtures/anthropic.ts'
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

describeProviderContract({
  protocol: 'anthropic',
  make: options => anthropic(options),
  fixedHeaders: { 'anthropic-version': '2026-10-21' },
  defaultKeyHeader: key => ['authorization', `Bearer ${key}`],
  replies: { ok: message, model: 'claude-opus-5-5', usage: { inputTokens: 2095, outputTokens: 503 }, refusal, truncated },
  read: {
    system: body => body.system,
    firstUser: body => conversation(body).find(entry => entry.role === 'user')?.content,
    temperature: body => body.temperature,
    maxTokens: body => body.max_tokens,
  },
  reservedBodyKeys: ['model', 'messages', 'system', 'stream'],
  toolBodyKeys: ['tools', 'tool_choice', 'mcp_servers', 'container', 'thread', 'fallbacks', 'fallback_credit_token', 'context_management', 'compaction'],
  structuredOutputs: ['prompt', 'schema'],
  mergeProbe: {
    options: { structuredOutput: 'schema' },
    extraBody: { output_config: { effort: 'low' } },
    merged: { output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'low' } },
  },
})

describe('anthropic', () => {
  const options = { id: 'claude', baseUrl: 'https://api.anthropic.com/', model: 'claude-opus-5-5', apiKey: 'sk-ant-k' }
  const provider = anthropic(options)

  it('posts the system text, the conversation and a 16000-token limit to /v1/messages, with the version header and no temperature', async () => {
    const fetchMock = stubFetch(message)
    await provider.complete(request)
    const { url, headers, body } = sent(fetchMock)
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-ant-k', 'anthropic-version': '2026-10-21' })
    expect(body).toEqual({ model: 'claude-opus-5-5', max_tokens: 16000, system: 'instructions', messages: [{ role: 'user', content: 'data' }] })
  })

  it('asks for the reply schema through output_config in schema mode', async () => {
    const fetchMock = stubFetch(message)
    await anthropic({ ...options, structuredOutput: 'schema' }).complete(request)
    expect(sent(fetchMock).body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'instructions',
      messages: [{ role: 'user', content: 'data' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    })
  })

  it('refuses json mode, which the Messages API does not have', () => {
    expect(() => anthropic({ ...options, structuredOutput: 'json' })).toThrow(new ConfigError([{ path: 'claude.structuredOutput', message: 'must be prompt or schema' }]))
  })

  it('sends an anthropic-beta header, and refuses one that would replace the version', async () => {
    const fetchMock = stubFetch(message)
    await anthropic({ ...options, headers: { 'anthropic-beta': 'context-1m-2025-08-07' } }).complete(request)
    expect(sent(fetchMock).headers).toMatchObject({ 'anthropic-beta': 'context-1m-2025-08-07', 'anthropic-version': '2026-10-21' })
    expect(() => anthropic({ ...options, headers: { 'Anthropic-Version': '2023-06-01' } })).toThrow(new ConfigError([
      { path: 'claude.headers.Anthropic-Version', message: 'is set by the adapter and cannot be replaced' },
    ]))
  })

  it('returns the text blocks joined, skipping thinking and redacted thinking blocks, with the model and the usage', async () => {
    stubFetch({
      ...message,
      content: [
        { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' },
        { type: 'text', text: '{"keep":' },
        { type: 'thinking', thinking: 'true', signature: 's' },
        { type: 'text', text: 'true}' },
      ],
    })
    await expect(provider.complete(request)).resolves.toEqual({ text: '{"keep":true}', model: 'claude-opus-5-5', usage: { inputTokens: 2095, outputTokens: 503 } })
  })

  it('succeeds on a stop sequence, and falls back to the configured model and no usage when the reply names neither', async () => {
    stubFetch({ ...message, stop_reason: 'stop_sequence', model: '', usage: { input_tokens: 10 } })
    await expect(anthropic({ ...options, model: 'claude-haiku-5-5' }).complete(request)).resolves.toEqual({ text: '{}', model: 'claude-haiku-5-5', usage: undefined })
  })

  it('counts as input the prompt tokens the cache wrote and read, when they are numbers', async () => {
    stubFetch({ ...message, usage: { input_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 503 } })
    await expect(provider.complete(request)).resolves.toMatchObject({ usage: { inputTokens: 3050, outputTokens: 503 } })
    stubFetch({ ...message, usage: { input_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: 2000, output_tokens: 503 } })
    await expect(provider.complete(request)).resolves.toMatchObject({ usage: { inputTokens: 2050, outputTokens: 503 } })
  })

  const { stop_reason: _stopReason, ...noStopReason } = message

  it.each([
    ['refusal', refusal, 'claude: model refused'],
    ['truncated', truncated, 'claude: reply was cut off by the token limit'],
    ['truncated', contextWindowFull, 'claude: reply was cut off: the context window is full'],
    ['invalid-response', toolUse, 'claude: reply ended early: "tool_use"'],
    ['invalid-response', { ...message, stop_reason: 'pause_turn' }, 'claude: reply ended early: "pause_turn"'],
    ['invalid-response', { ...message, stop_reason: 'x'.repeat(60) }, `claude: reply ended early: "${'x'.repeat(40)}"`],
    ['invalid-response', noStopReason, 'claude: reply ended early'],
    ['invalid-response', { ...message, stop_reason: null }, 'claude: reply ended early'],
    ['invalid-response', { ...message, stop_reason: ['end_turn'] }, 'claude: reply ended early'],
    ['invalid-response', { ...message, content: [{ type: 'thinking', thinking: '{}', signature: 's' }] }, 'claude: reply has no text'],
    ['invalid-response', { ...message, content: '{}' }, 'claude: reply has no text'],
    ['invalid-response', { ...message, content: [null, '{}', { type: 'text', text: 1 }, { text: '{}' }] }, 'claude: reply has no text'],
    ['invalid-response', [], 'claude: reply is not a JSON object'],
    ['invalid-response', null, 'claude: reply is not a JSON object'],
  ])('maps a %s reply to a ProviderError with its exact message', async (kind, body, expected) => {
    stubFetch(body)
    await expect(provider.complete(request)).rejects.toMatchObject({ name: 'ProviderError', kind, retryable: false, providerId: 'claude', message: expected })
  })

  it('redacts the key from a stop reason it quotes', async () => {
    stubFetch({ ...message, stop_reason: 'sk-ant-k' })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: 'claude: reply ended early: "[redacted]"' })
  })

  it('quotes the error body of a non-2xx reply with its status', async () => {
    stubFetch(notFound, 404)
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'http', status: 404, retryable: false, message: `claude: HTTP 404: ${JSON.stringify(JSON.stringify(notFound))}` })
  })
})
