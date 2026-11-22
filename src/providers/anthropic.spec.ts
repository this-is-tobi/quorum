import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { jsonReply, sent, stubFetch } from '../testing/http.ts'
import { anthropic } from './anthropic.ts'
import { contextWindowFull, countedOut, empty, message, notFound, reasoningOnly, refusal, toolUse, truncated } from '../testing/fixtures/anthropic.ts'
import { describeProviderContract } from '../testing/provider-contract.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [
    { role: 'user', content: 'data' },
  ],
  output: {
    name: 'panel_vote',
    schema: { type: 'object' },
  },
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
  replies: {
    ok: message,
    model: 'claude-opus-5-5',
    usage: { inputTokens: 2095, outputTokens: 503 },
    reasoned: true,
    refusal,
    truncated,
    empty,
    reasoningOnly,
    countedOut,
  },
  read: {
    system: body => body.system,
    firstUser: body => conversation(body).find(entry => entry.role === 'user')?.content,
    temperature: body => body.temperature,
    maxTokens: body => body.max_tokens,
  },
  thinking: {
    read: body => (body.output_config as Body | undefined)?.effort,
    extraBody: {
      output_config: { effort: 'high' },
    },
    lowersTo: 'low',
  },
  streams: false,
  streamFields: {},
  streamed: reply => jsonReply(reply),
  reservedBodyKeys: [
    'model',
    'messages',
    'system',
    'stream',
  ],
  toolBodyKeys: [
    'tools',
    'tool_choice',
    'mcp_servers',
    'container',
    'thread',
    'fallbacks',
    'fallback_credit_token',
    'context_management',
    'compaction',
  ],
  replyLimitPaths: [
    ['max_tokens'],
  ],
  structuredOutputs: ['prompt', 'schema'],
  mergeProbe: {
    options: { structuredOutput: 'schema' },
    extraBody: {
      output_config: { effort: 'low' },
    },
    merged: {
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'object' },
        },
        effort: 'low',
      },
    },
  },
})

describe('anthropic', () => {
  const options = {
    id: 'claude',
    baseUrl: 'https://api.anthropic.com/',
    model: 'claude-opus-5-5',
    contextTokens: 131072,
    apiKey: 'sk-ant-k',
  }
  const provider = anthropic(options)

  it.each([
    [
      'prompt',
      { effort: 'low' },
    ],
    [
      'schema',
      {
        format: {
          type: 'json_schema',
          schema: { type: 'object' },
        },
        effort: 'low',
      },
    ],
  ] as const)('sends thinking low as its protocol\'s control in %s mode, beside the format', async (structuredOutput, outputConfig) => {
    const fetchMock = stubFetch(message)
    const low = anthropic({ ...options, structuredOutput, thinking: 'low' })
    await low.complete(request)
    expect(sent(fetchMock).body.output_config).toEqual(outputConfig)
    expect(low.thinking).toBe('low')
  })

  it('refuses thinking off on anthropic, naming low and extraBody', () => {
    const refused = (): unknown => anthropic({ ...options, thinking: 'off' })
    expect(refused).toThrow(ConfigError)
    expect(refused).toThrow(expect.objectContaining({
      issues: [
        { path: 'claude.thinking', message: 'the anthropic protocol has no one setting that turns thinking off on every model: set thinking: low, or set thinking in extraBody for your model' },
      ],
    }))
  })

  it('posts the system text, the conversation and a 16000-token limit to /v1/messages, with the version header and no temperature', async () => {
    const fetchMock = stubFetch(message)
    await provider.complete(request)
    const { url, headers, body } = sent(fetchMock)
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-ant-k', 'anthropic-version': '2026-10-21' })
    expect(body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'instructions',
      messages: [
        { role: 'user', content: 'data' },
      ],
    })
  })

  it('asks for the reply schema through output_config in schema mode', async () => {
    const fetchMock = stubFetch(message)
    await anthropic({ ...options, structuredOutput: 'schema' }).complete(request)
    expect(sent(fetchMock).body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'instructions',
      messages: [
        { role: 'user', content: 'data' },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'object' },
        },
      },
    })
  })

  it('refuses json mode, which the Messages API does not have', () => {
    expect(() => anthropic({ ...options, structuredOutput: 'json' })).toThrow(new ConfigError([
      { path: 'claude.structuredOutput', message: 'must be prompt or schema' },
    ]))
  })

  it('sends an anthropic-beta header, and refuses one that would replace the version', async () => {
    const fetchMock = stubFetch(message)
    await anthropic({
      ...options,
      headers: { 'anthropic-beta': 'context-1m-2025-08-07' },
    }).complete(request)
    expect(sent(fetchMock).headers).toMatchObject({ 'anthropic-beta': 'context-1m-2025-08-07', 'anthropic-version': '2026-10-21' })
    expect(() => anthropic({
      ...options,
      headers: { 'Anthropic-Version': '2023-06-01' },
    })).toThrow(new ConfigError([
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
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{"keep":true}',
      model: 'claude-opus-5-5',
      usage: { inputTokens: 2095, outputTokens: 503 },
      reasoning: true,
    })
  })

  it('succeeds on a stop sequence, and falls back to the configured model and no usage when the reply names neither', async () => {
    stubFetch({
      ...message,
      stop_reason: 'stop_sequence',
      model: '',
      usage: { input_tokens: 10 },
    })
    await expect(anthropic({ ...options, model: 'claude-haiku-5-5' }).complete(request)).resolves.toEqual({
      text: '{}',
      model: 'claude-haiku-5-5',
      usage: undefined,
      reasoning: true,
    })
  })

  it('counts as input the prompt tokens the cache wrote and read, when they are numbers', async () => {
    stubFetch({
      ...message,
      usage: {
        input_tokens: 50,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 2000,
        output_tokens: 503,
      },
    })
    await expect(provider.complete(request)).resolves.toMatchObject({
      usage: { inputTokens: 3050, outputTokens: 503 },
    })
    stubFetch({
      ...message,
      usage: {
        input_tokens: 50,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 2000,
        output_tokens: 503,
      },
    })
    await expect(provider.complete(request)).resolves.toMatchObject({
      usage: { inputTokens: 2050, outputTokens: 503 },
    })
  })

  const { stop_reason: _stopReason, ...noStopReason } = message

  it.each([
    ['refusal', refusal, 'claude: model refused'],
    ['truncated', truncated, 'claude: a reply was cut off at 503 tokens, below the 16000 quorum asked for: the server caps replies near 503: set maxTokens: 503'],
    ['truncated', contextWindowFull, 'claude: a reply ended at the server\'s window after 2095 input and 503 output tokens, below contextTokens 131072: set contextTokens to at most 2598'],
    ['invalid-response', toolUse, 'claude: reply ended early: "tool_use"'],
    [
      'invalid-response',
      { ...message, stop_reason: 'pause_turn' },
      'claude: reply ended early: "pause_turn"',
    ],
    [
      'invalid-response',
      {
        ...message,
        stop_reason: 'x'.repeat(60),
      },
      `claude: reply ended early: "${'x'.repeat(40)}"`,
    ],
    ['invalid-response', noStopReason, 'claude: reply ended early'],
    [
      'invalid-response',
      { ...message, stop_reason: null },
      'claude: reply ended early',
    ],
    [
      'invalid-response',
      {
        ...message,
        stop_reason: ['end_turn'],
      },
      'claude: reply ended early',
    ],
    [
      'no-answer',
      {
        ...message,
        content: [
          { type: 'thinking', thinking: '{}', signature: 's' },
        ],
      },
      'claude: reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt',
    ],
    [
      'no-answer',
      {
        ...message,
        content: '{}',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      'claude: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
    [
      'no-answer',
      {
        ...message,
        content: [
          null,
          '{}',
          { type: 'text', text: ' ' },
          { text: '{}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      'claude: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
    ['invalid-response', [], 'claude: reply is not a JSON object'],
    ['invalid-response', null, 'claude: reply is not a JSON object'],
  ])('maps a %s reply to a ProviderError with its exact message', async (kind, body, expected) => {
    stubFetch(body)
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'ProviderError',
      kind,
      retryable: false,
      providerId: 'claude',
      message: expected,
    })
  })

  it.each([
    'refusal',
    'model_context_window_exceeded',
  ])('carries the counts of a reply stopped for %s, cache tokens included, on its error', async (stopReason) => {
    stubFetch({
      ...message,
      stop_reason: stopReason,
      usage: {
        input_tokens: 50,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 2000,
        output_tokens: 503,
      },
    })
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'ProviderError',
      usage: { inputTokens: 3050, outputTokens: 503 },
    })
  })

  it.each([
    [
      'a redacted_thinking block',
      [
        { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' },
      ],
      undefined,
    ],
    [
      'a thinking token count above 0',
      [],
      {
        input_tokens: 10,
        output_tokens: 90,
        output_tokens_details: { thinking_tokens: 90 },
      },
    ],
  ])('reads a finished reply with no answer and %s as no-answer thinking, quoting none of it', async (_name, content, usage) => {
    stubFetch({ ...message, content, usage: usage ?? message.usage })
    const failed = await provider.complete(request).catch((error: unknown) => error)
    expect(failed).toMatchObject({
      name: 'ProviderError',
      kind: 'no-answer',
      noAnswer: 'thinking',
      usage: { outputTokens: usage?.output_tokens ?? 503 },
    })
    expect(JSON.stringify(failed)).not.toContain('findings')
    expect((failed as Error).message).not.toContain('findings')
  })

  it('reads model_context_window_exceeded as the window ending the reply, naming its numbers when they stay below contextTokens', async () => {
    stubFetch({
      ...message,
      stop_reason: 'model_context_window_exceeded',
      content: [],
      usage: { input_tokens: 30_100, output_tokens: 2668 },
    })
    await expect(provider.complete(request)).rejects.toMatchObject({
      kind: 'truncated',
      noAnswer: 'window',
      retryable: false,
      usage: { inputTokens: 30_100, outputTokens: 2668 },
      message: 'claude: a reply ended at the server\'s window after 30100 input and 2668 output tokens, below contextTokens 131072: set contextTokens to at most 32768',
    })
  })

  it('reads a max_tokens stop below the limit sent as a reply cut off, never as the window, though input and output reach contextTokens', async () => {
    stubFetch({
      ...message,
      stop_reason: 'max_tokens',
      content: [
        { type: 'text', text: '{"kee' },
      ],
      usage: { input_tokens: 130_000, output_tokens: 1500 },
    })
    await expect(provider.complete(request)).rejects.toMatchObject({
      kind: 'truncated',
      noAnswer: 'reply',
      usage: { inputTokens: 130_000, outputTokens: 1500 },
      message: 'claude: a reply was cut off at 1500 tokens, below the 16000 quorum asked for: the server caps replies near 1500: set maxTokens: 1500',
    })
  })

  it('redacts the key from a stop reason it quotes', async () => {
    stubFetch({ ...message, stop_reason: 'sk-ant-k' })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: 'claude: reply ended early: "[redacted]"' })
  })

  it('quotes the error body of a non-2xx reply with its status', async () => {
    stubFetch(notFound, 404)
    await expect(provider.complete(request)).rejects.toMatchObject({
      kind: 'http',
      status: 404,
      retryable: false,
      message: `claude: HTTP 404: ${JSON.stringify(JSON.stringify(notFound))}`,
    })
  })
})
