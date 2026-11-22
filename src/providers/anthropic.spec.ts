import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, ProviderError } from '../core/errors.ts'
import type { CompletionRequest, StreamSignal } from '../core/ports.ts'
import { sent, stubFetch, textReply } from '../testing/http.ts'
import { anthropic, ANTHROPIC_ERROR_STATUSES, assembleAnthropic } from './anthropic.ts'
import type { AnthropicOptions } from './anthropic.ts'
import { sseItems } from './stream.ts'
import type { StreamItem } from './stream.ts'
import { contextWindowFull, countedOut, empty, message, notFound, reasoningOnly, refusal, toolUse, truncated } from '../testing/fixtures/anthropic.ts'
import { describeProviderContract } from '../testing/provider-contract.ts'
import { anthropicStream, chunkedBody, sse } from '../testing/streams.ts'

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
  streams: true,
  streamFields: { stream: true },
  streamed: reply => anthropicStream(reply),
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
      stream: true,
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
      stream: true,
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
      whole: true,
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
      whole: true,
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

describe('anthropic streams', () => {
  const base: AnthropicOptions = {
    id: 'claude',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    contextTokens: 131072,
  }
  const claude = anthropic(base)
  type Event = Record<string, unknown>
  /** The events as the API streams them: each names itself, as the API writes it. */
  const streamText = (events: readonly Event[]): string => sse(events.map(data => ({
    event: String(data.type),
    data,
  })))
  const streamOf = (events: readonly Event[]): Response => new Response(streamText(events), {
    headers: { 'content-type': 'text/event-stream' },
  })
  const start = (usage: Event = { input_tokens: 41, output_tokens: 1 }): Event => ({
    type: 'message_start',
    message: {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      usage,
    },
  })
  const open = (index: number, block: Event): Event => ({ type: 'content_block_start', index, content_block: block })
  const delta = (index: number, body: Event): Event => ({ type: 'content_block_delta', index, delta: body })
  const text = (index: number, piece: string): Event => delta(index, { type: 'text_delta', text: piece })
  const close = (index: number): Event => ({ type: 'content_block_stop', index })
  const ending = (reason: string | null = 'end_turn', output = 23): Event[] => [
    {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: output },
    },
    { type: 'message_stop' },
  ]
  /** A whole reply's text block, streamed in two deltas. */
  const answerBlock = (index = 0): Event[] => [
    open(index, { type: 'text', text: '' }),
    text(index, '{"findings"'),
    text(index, ':[]}'),
    close(index),
  ]
  /** Answers each call of `fetch` with the next response. */
  const serve = (...responses: Response[]): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn()
    for (const response of responses) fetchMock.mockImplementationOnce(async () => response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const failed = async (events: readonly Event[]): Promise<unknown> => {
    serve(streamOf(events))
    return await claude.complete(request).catch((error: unknown) => error)
  }
  /** What a call came to, with no text of the server's but what the error words: for comparing a stream with a whole reply. */
  const outcome = async (reply: Response, provider = claude): Promise<unknown> => {
    serve(reply)
    return await provider.complete(request).then(
      ({ whole: _whole, ...reached }) => reached,
      (error: ProviderError) => ({
        kind: error.kind,
        message: error.message,
        noAnswer: error.noAnswer,
        usage: error.usage,
      }),
    )
  }
  const lost = (error: unknown): ProviderError => new ProviderError({
    providerId: 'claude',
    kind: 'network',
    message: String(error),
  })
  /** The items a reader reads from `events`, one byte of the body at a time. */
  const itemsOf = (events: readonly Event[]): { items: AsyncGenerator<StreamItem>, cancelled: () => boolean } => {
    const { body, cancelled } = chunkedBody(streamText(events), 1)
    return {
      items: sseItems(body, { providerId: 'claude', lost }),
      cancelled,
    }
  }

  /** A whole reply as `fetch` gets it. */
  const jsonOf = (body: unknown): Response => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })

  it('sends stream: true by default, and nothing for a whole request or an option that asks for whole replies', async () => {
    const fetchMock = stubFetch(message)
    await claude.complete(request)
    await claude.complete({ ...request, stream: false })
    await anthropic({ ...base, stream: false }).complete(request)
    await anthropic({ ...base, stream: true }).complete({ ...request, stream: false })
    expect(sent(fetchMock, 0).body).toMatchObject({ stream: true })
    expect(sent(fetchMock, 1).body).not.toHaveProperty('stream')
    expect(sent(fetchMock, 2).body).not.toHaveProperty('stream')
    // A pinned stream ignores the request's change.
    expect(sent(fetchMock, 3).body).toMatchObject({ stream: true })
  })

  it('assembles a stream into the reply its reader reads, the same as the whole reply', async () => {
    serve(streamOf([
      start(),
      open(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'The diff calls exec.' }),
      delta(0, { type: 'signature_delta', signature: 'EqQB' }),
      close(0),
      ...answerBlock(1),
      ...ending('end_turn', 23),
    ]))
    const streamed = await claude.complete(request)
    expect(streamed).toEqual({
      text: '{"findings":[]}',
      model: 'claude-opus-5-5',
      usage: { inputTokens: 41, outputTokens: 23 },
      reasoning: true,
    })
    stubFetch({
      ...message,
      content: [
        { type: 'thinking', thinking: 'The diff calls exec.', signature: 'EqQB' },
        { type: 'text', text: '{"findings":[]}' },
      ],
      usage: { input_tokens: 41, output_tokens: 23 },
    })
    expect(await claude.complete(request)).toEqual({ ...streamed, whole: true })
    // Every recorded reply, as a whole reply and streamed through the helper, comes to the same.
    for (const recorded of [
      message,
      truncated,
      contextWindowFull,
      refusal,
      empty,
      reasoningOnly,
      toolUse,
      countedOut,
    ]) {
      const viaStream = await outcome(anthropicStream(recorded))
      expect(viaStream, JSON.stringify(recorded.stop_reason)).toEqual(await outcome(jsonOf(recorded)))
    }
  })

  it('reports its progress signals', async () => {
    const signals: StreamSignal[] = []
    serve(streamOf([
      start(),
      open(0, { type: 'thinking', thinking: '' }),
      delta(0, {
        type: 'thinking_delta',
        thinking: 'x'.repeat(10),
      }),
      close(0),
      open(1, { type: 'text', text: '' }),
      text(1, 'hello'),
      close(1),
      ...ending('end_turn', 40),
    ]))
    await claude.complete({
      ...request,
      onProgress: signal => signals.push(signal),
    })
    const data = (outputTokens: number, answer: boolean, reasoning: boolean): StreamSignal => ({
      kind: 'data',
      outputTokens,
      answer,
      reasoning,
    })
    expect(signals).toEqual([
      { kind: 'headers' },
      // message_start's own count of 1, then a quarter of the characters streamed, then the server's count.
      data(1, false, false),
      data(1, false, false),
      data(3, false, true),
      data(3, false, true),
      data(3, false, true),
      data(4, true, true),
      data(4, true, true),
      data(40, true, true),
      data(40, true, true),
    ])
  })

  it('reports a ping as a keep-alive and as no progress', async () => {
    const signals: StreamSignal[] = []
    serve(streamOf([
      { type: 'ping' },
      start(),
      { type: 'ping' },
      ...answerBlock(),
      { type: 'ping' },
      ...ending(),
    ]))
    await claude.complete({
      ...request,
      onProgress: signal => signals.push(signal),
    })
    // One data signal for each event but the pings: message_start, the block's four, then the two that end the message.
    expect(signals.map(signal => signal.kind)).toEqual([
      'headers',
      'keep-alive',
      'data',
      'keep-alive',
      'data',
      'data',
      'data',
      'data',
      'keep-alive',
      'data',
      'data',
    ])
    // A stream of pings alone has shown no progress and is no reply.
    signals.length = 0
    serve(streamOf([
      { type: 'ping' },
      { type: 'ping' },
    ]))
    await expect(claude.complete({
      ...request,
      onProgress: signal => signals.push(signal),
    })).rejects.toMatchObject({ kind: 'network' })
    expect(signals.map(signal => signal.kind)).toEqual(['headers', 'keep-alive', 'keep-alive'])
  })

  it('marks a refusal naming its stream word refused stream, never quoting the body', async () => {
    const failure = async (body: string, status: number, options: Partial<AnthropicOptions> = {}, asked: CompletionRequest = request): Promise<unknown> => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, status)))
      return await anthropic({
        ...base,
        ...options,
      }).complete(asked).catch((caught: unknown) => caught)
    }
    const naming = (word: string): string => `{"type":"error","error":{"type":"invalid_request_error","message":"${word}: Extra inputs are not permitted"}}`
    const error = await failure(naming('stream'), 400)
    expect(error).toMatchObject({ kind: 'http', status: 400, refused: 'stream' })
    // The word is matched, never copied: every string the error holds but its message is a code word.
    expect(Object.entries(error as object).filter(([key, value]) => key !== 'message' && key !== 'name' && typeof value === 'string').flatMap(([, value]) => value as string)).toEqual(['claude', 'http', 'stream'])
    expect(await failure(naming('stream'), 422)).toMatchObject({ refused: 'stream' })
    // Another status, a word that is only part of another, and a request that sent no stream name no refusal.
    expect(await failure(naming('stream'), 500)).toMatchObject({ refused: undefined })
    expect(await failure(naming('streaming'), 400)).toMatchObject({ refused: undefined })
    expect(await failure(naming('stream'), 400, {}, { ...request, stream: false })).toMatchObject({ refused: undefined })
    expect(await failure(naming('stream'), 400, { stream: false })).toMatchObject({ refused: undefined })
    // A pinned stream is marked as well, which is how its fix reads set stream: false.
    expect(await failure(naming('stream'), 400, { stream: true })).toMatchObject({ refused: 'stream' })
  })

  it.each([
    ['invalid_request_error', 400],
    ['authentication_error', 401],
    ['billing_error', 402],
    ['permission_error', 403],
    ['not_found_error', 404],
    ['request_too_large', 413],
    ['rate_limit_error', 429],
    ['api_error', 500],
    ['overloaded_error', 529],
  ])('reads an error event of type %s as http %i', async (type, status) => {
    expect(ANTHROPIC_ERROR_STATUSES[type]).toBe(status)
    const error = await failed([
      start(),
      open(0, { type: 'text', text: '' }),
      text(0, '{"kee'),
      {
        type: 'error',
        error: { type, message: 'Overloaded' },
      },
    ])
    expect(error).toMatchObject({
      name: 'ProviderError',
      kind: 'http',
      status,
      retryable: status === 429 || status >= 500,
      exhausted: false,
      message: `claude: server error ${status}: "Overloaded"`,
    })
  })

  it('reads an error event of a type the table does not hold as invalid-response', async () => {
    expect(Object.keys(ANTHROPIC_ERROR_STATUSES)).toHaveLength(9)
    for (const type of [
      'timeout_error',
      'toString',
      '__proto__',
      undefined,
    ]) {
      expect(await failed([
        start(),
        {
          type: 'error',
          error: { type, message: 'key sk-ant-k refused' },
        },
      ]), String(type)).toMatchObject({
        kind: 'invalid-response',
        retryable: false,
        status: undefined,
        message: 'claude: server error: "key sk-ant-k refused"',
      })
    }
    // The key is redacted from the text it quotes, and an error with no text quotes none.
    serve(streamOf([
      {
        type: 'error',
        error: { type: 'api_error', message: 'bad key sk-ant-k' },
      },
    ]))
    await expect(anthropic({ ...base, apiKey: 'sk-ant-k' }).complete(request)).rejects.toMatchObject({ status: 500, message: 'claude: server error 500: "bad key [redacted]"' })
    expect(await failed([
      {
        type: 'error',
        error: { type: 'api_error' },
      },
    ])).toMatchObject({ status: 500, message: 'claude: server error 500' })
    expect(await failed([
      { type: 'error' },
    ])).toMatchObject({ kind: 'invalid-response', message: 'claude: server error' })
  })

  it('marks a spend limit its error event names by the vendor\'s own code as exhausted, never retried', async () => {
    expect(await failed([
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'limit',
          details: { error_code: 'enforced_spend_limit_reached' },
        },
      },
    ])).toMatchObject({
      kind: 'http',
      status: 429,
      exhausted: true,
      retryable: false,
    })
  })

  it('keeps thinking and redacted_thinking blocks with no text, and reads reasoning from them', async () => {
    const events = [
      start(),
      open(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'secret reasoning' }),
      delta(0, { type: 'signature_delta', signature: 'EqQB' }),
      close(0),
      open(1, { type: 'redacted_thinking', data: 'EmwKAhgB' }),
      close(1),
      open(2, {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'lookup',
        input: {},
      }),
      delta(2, { type: 'input_json_delta', partial_json: '{"q":"x"}' }),
      close(2),
      ...answerBlock(3),
      ...ending(),
    ]
    // Only the fact of each block is kept: its type, and a text block's text.
    expect(await assembleAnthropic(itemsOf(events).items, 'claude')).toEqual({
      model: 'claude-opus-5-5',
      content: [
        { type: 'thinking' },
        { type: 'redacted_thinking' },
        { type: 'tool_use' },
        { type: 'text', text: '{"findings":[]}' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 41, output_tokens: 23 },
    })
    serve(streamOf(events))
    await expect(claude.complete(request)).resolves.toMatchObject({ text: '{"findings":[]}', reasoning: true })
    // Reasoning and no answer is a reply with no answer and reasoning, and none of it is quoted.
    const reasoningAlone = await failed([
      start(),
      open(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'secret reasoning' }),
      close(0),
      open(1, { type: 'redacted_thinking', data: 'EmwKAhgB' }),
      ...ending(),
    ])
    expect(reasoningAlone).toMatchObject({
      kind: 'no-answer',
      noAnswer: 'thinking',
      usage: { inputTokens: 41, outputTokens: 23 },
    })
    expect(JSON.stringify(reasoningAlone)).not.toContain('secret')
    // The same reasoning cut off at the limit is a truncated reply, thinking.
    expect(await failed([
      start(),
      open(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'secret reasoning' }),
      ...ending('max_tokens', 16_000),
    ])).toMatchObject({ kind: 'truncated', noAnswer: 'thinking' })
  })

  it('takes the input from message_start and the output from the last message_delta', async () => {
    serve(streamOf([
      start({
        input_tokens: 41,
        cache_read_input_tokens: 9,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      }),
      ...answerBlock(),
      {
        type: 'message_delta',
        delta: { stop_reason: null },
        usage: { output_tokens: 10, input_tokens: null },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 23 },
      },
      { type: 'message_stop' },
    ]))
    // The cache's tokens are input, a count the delta leaves null undoes none, and the last output count is the reply's.
    await expect(claude.complete(request)).resolves.toMatchObject({
      usage: { inputTokens: 50, outputTokens: 23 },
    })
    // A stream whose message_delta reports no usage keeps message_start's, and one with no usage at all reports none.
    serve(streamOf([
      start({ input_tokens: 41, output_tokens: 5 }),
      ...answerBlock(),
      ...ending().map(event => event.type === 'message_delta'
        ? {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
          }
        : event),
    ]))
    await expect(claude.complete(request)).resolves.toMatchObject({
      usage: { inputTokens: 41, outputTokens: 5 },
    })
    serve(streamOf([
      start({}),
      ...answerBlock(),
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
      },
      { type: 'message_stop' },
    ]))
    expect((await claude.complete(request)).usage).toBeUndefined()
  })

  it('fails a stream with no message_stop as network', async () => {
    const lastEvent = 'claude: the reply stream ended before its last event'
    // The body ends after the stop reason, or at any earlier event, or after a message_stop that follows no stop reason.
    for (const events of [
      [
        start(),
        ...answerBlock(),
        ending()[0]!,
      ],
      [
        start(),
        ...answerBlock(),
      ],
      [
        start(),
      ],
      [
        start(),
        ...answerBlock(),
        { type: 'message_stop' },
      ],
    ] as Event[][]) {
      expect(await failed(events), events.length.toString()).toMatchObject({ kind: 'network', retryable: true, message: lastEvent })
    }
    expect(await failed([])).toMatchObject({ kind: 'network', message: lastEvent })
  })

  const blocksOpen = (count: number): Event[] => Array.from({ length: count }, (_, index) => open(index, { type: 'text', text: '' }))

  it.each<[string, Event[], string]>([
    [
      'a block past the 64 the stream may hold',
      [
        start(),
        ...blocksOpen(65),
        ...ending(),
      ],
      'claude: the reply stream holds more than 64 content blocks',
    ],
    [
      'a text delta aimed at a thinking block',
      [
        start(),
        open(0, { type: 'thinking', thinking: '' }),
        text(0, '{"a"'),
        ...ending(),
      ],
      'claude: the reply stream holds a delta for a content block of another type',
    ],
    [
      'a thinking delta aimed at a text block',
      [
        start(),
        open(0, { type: 'text', text: '' }),
        delta(0, { type: 'thinking_delta', thinking: 'x' }),
        ...ending(),
      ],
      'claude: the reply stream holds a delta for a content block of another type',
    ],
    [
      'a block opened twice',
      [
        start(),
        open(0, { type: 'text', text: '' }),
        open(0, { type: 'text', text: '' }),
        ...ending(),
      ],
      'claude: the reply stream opens a content block twice',
    ],
    [
      'a delta with no valid index',
      [
        start(),
        open(0, { type: 'text', text: '' }),
        {
          type: 'content_block_delta',
          index: 'zero',
          delta: { type: 'text_delta', text: '{}' },
        },
        ...ending(),
      ],
      'claude: the reply stream holds a content block with no valid index',
    ],
  ])('fails %s as invalid-response, never retried, and cancels the body', async (_name, events, expected) => {
    const { items, cancelled } = itemsOf(events)
    await expect(assembleAnthropic(items, 'claude')).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'invalid-response',
      retryable: false,
      message: expected,
    })
    expect(cancelled()).toBe(true)
    // Through the provider it is the same failure, and no text of the server is quoted.
    expect(await failed(events)).toMatchObject({ kind: 'invalid-response', retryable: false, message: expected })
  })

  it('reads a stream of exactly 64 content blocks', async () => {
    serve(streamOf([
      start(),
      ...blocksOpen(63),
      ...answerBlock(63),
      ...ending(),
    ]))
    await expect(claude.complete(request)).resolves.toMatchObject({ text: '{"findings":[]}' })
  })

  it('ends its read at an error event, pulling none of the events after it, and cancels the body', async () => {
    const events: Event[] = [
      start(),
      ...answerBlock(),
      {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      },
      ...ending(),
    ]
    let pulled = 0
    const counted = async function* (): AsyncGenerator<StreamItem> {
      for await (const item of itemsOf(events).items) {
        pulled += 1
        yield item
      }
    }
    await expect(assembleAnthropic(counted(), 'claude')).rejects.toMatchObject({ status: 529 })
    // start, the block's four events and the error: nothing after it.
    expect(pulled).toBe(6)
    // A body read through the reader is cancelled where the error ends the read.
    const { items, cancelled } = itemsOf(events)
    await expect(assembleAnthropic(items, 'claude')).rejects.toMatchObject({ status: 529 })
    expect(cancelled()).toBe(true)
    // So is a body whose read stops at message_stop, or at a stream that ends without its stop reason.
    const done = itemsOf([
      start(),
      ...answerBlock(),
      ...ending(),
      { type: 'ping' },
    ])
    await assembleAnthropic(done.items, 'claude')
    expect(done.cancelled()).toBe(true)
  })
})

describe('anthropic streams with a field of the wrong type', () => {
  const lost = (error: unknown): ProviderError => new ProviderError({
    providerId: 'claude',
    kind: 'network',
    message: String(error),
  })
  const itemsOf = (text: string): { items: AsyncGenerator<StreamItem>, cancelled: () => boolean } => {
    const { body, cancelled } = chunkedBody(text, 1)
    return {
      items: sseItems(body, { providerId: 'claude', lost }),
      cancelled,
    }
  }
  type Event = Record<string, unknown>
  const named = (events: readonly Event[]): string => sse(events.map(data => ({
    event: String(data.type),
    data,
  })))
  const start: Event = {
    type: 'message_start',
    message: {
      model: 'claude-opus-5-5',
      usage: { input_tokens: 4, output_tokens: 1 },
    },
  }
  const open: Event = {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }
  const delta = (body: unknown): Event => ({ type: 'content_block_delta', index: 0, delta: body })

  it.each<[string, string, string]>([
    [
      'an event that is null',
      sse([
        { event: 'message_start', data: 'null' },
      ]),
      'event is not an object',
    ],
    [
      'an event that is a number',
      sse([
        { event: 'message_start', data: 5 },
      ]),
      'event is not an object',
    ],
    [
      'an event whose type is no text',
      sse([
        {
          data: { type: 5 },
        },
      ]),
      'event type is not text',
    ],
    [
      'a message_start whose message is no object',
      named([
        { type: 'message_start', message: 'x' },
      ]),
      'message is not an object',
    ],
    [
      'a message_start whose model is no text',
      named([
        {
          type: 'message_start',
          message: { model: 7 },
        },
      ]),
      'model is not text',
    ],
    [
      'a message_start whose usage is no object',
      named([
        {
          type: 'message_start',
          message: { usage: 5 },
        },
      ]),
      'usage is not an object',
    ],
    [
      'a content_block_start whose block is no object',
      named([
        start,
        { type: 'content_block_start', index: 0, content_block: 'text' },
      ]),
      'content block is not an object',
    ],
    [
      'a content_block_start whose block type is no text',
      named([
        start,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 7 },
        },
      ]),
      'content block type is not text',
    ],
    [
      'a text block whose text is no text',
      named([
        start,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 7 },
        },
      ]),
      'text is not text',
    ],
    [
      'a content_block_delta whose delta is no object',
      named([
        start,
        open,
        delta('x'),
      ]),
      'delta is not an object',
    ],
    [
      'a content_block_delta whose delta type is no text',
      named([
        start,
        open,
        delta({ type: 7 }),
      ]),
      'delta type is not text',
    ],
    [
      'a text_delta whose text is no text',
      named([
        start,
        open,
        delta({ type: 'text_delta', text: 7 }),
      ]),
      'text is not text',
    ],
    [
      'a thinking_delta whose thinking is no text',
      named([
        start,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
        delta({
          type: 'thinking_delta',
          thinking: ['x'],
        }),
      ]),
      'thinking is not text',
    ],
    [
      'a message_delta whose delta is no object',
      named([
        start,
        open,
        { type: 'message_delta', delta: 'x' },
      ]),
      'delta is not an object',
    ],
    [
      'a message_delta whose usage is no object',
      named([
        start,
        open,
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: 'x',
        },
      ]),
      'usage is not an object',
    ],
  ])('fails %s as invalid-response, never retried, and cancels the body', async (_name, text, field) => {
    const { items, cancelled } = itemsOf(text)
    await expect(assembleAnthropic(items, 'claude')).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'invalid-response',
      retryable: false,
      message: `claude: the reply stream's ${field}`,
    })
    expect(cancelled()).toBe(true)
  })

  it('tolerates an unknown event, block or delta type and a field that is absent', async () => {
    const events: Event[] = [
      { type: 'message_start', message: {} },
      {
        type: 'future_event',
        anything: [1],
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'x' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta', citation: {} },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '{}' },
      },
      { type: 'content_block_delta', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: null,
      },
      { type: 'message_stop' },
    ]
    expect(await assembleAnthropic(itemsOf(named(events)).items, 'claude')).toEqual({
      content: [
        { type: 'server_tool_use' },
        { type: 'text', text: '{}' },
      ],
      stop_reason: 'end_turn',
      usage: {},
    })
  })
})
