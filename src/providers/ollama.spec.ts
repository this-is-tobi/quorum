import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'
import type { CompletionRequest, StreamSignal } from '../core/ports.ts'
import { jsonReply, sent, stubFetch, stubResponses, textReply } from '../testing/http.ts'
import { assembleOllama, ollama } from './ollama.ts'
import type { OllamaOptions } from './ollama.ts'
import { ndjsonItems } from './stream.ts'
import type { StreamItem } from './stream.ts'
import { chatResponse, contextExceeded, countedOut, debugRender, empty, reasoningOnly, truncated } from '../testing/fixtures/ollama.ts'
import { describeProviderContract } from '../testing/provider-contract.ts'
import { chunkedBody, lostStream, ollamaStream, outcomeOf } from '../testing/streams.ts'

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
const runtime = (body: Body): Body => (body.options ?? {}) as Body

describeProviderContract({
  protocol: 'ollama',
  make: options => ollama(options),
  fixedHeaders: {},
  defaultKeyHeader: key => ['authorization', `Bearer ${key}`],
  replies: {
    ok: chatResponse,
    model: 'qwen3.6:27b',
    usage: { inputTokens: 1840, outputTokens: 412 },
    reasoned: true,
    truncated,
    empty,
    reasoningOnly,
    countedOut,
  },
  read: {
    system: body => conversation(body).find(message => message.role === 'system')?.content,
    firstUser: body => conversation(body).find(message => message.role === 'user')?.content,
    temperature: body => runtime(body).temperature,
    maxTokens: body => runtime(body).num_predict,
  },
  thinking: {
    read: body => body.think,
    extraBody: { think: true },
    lowersTo: 'off',
  },
  jsonMode: {
    read: body => body.format,
    extraBody: { format: 'json' },
  },
  streams: true,
  streamFields: { stream: true },
  streamed: reply => ollamaStream(reply),
  reservedBodyKeys: [
    'model',
    'messages',
    'stream',
    'truncate',
    'shift',
  ],
  toolBodyKeys: ['tools', '_debug_render_only'],
  replyLimitPaths: [
    ['options', 'num_predict'],
  ],
  structuredOutputs: ['prompt', 'json', 'schema'],
  mergeProbe: {
    extraBody: {
      options: { seed: 7 },
    },
    merged: {
      options: { temperature: 0, seed: 7 },
    },
  },
})

describe('ollama', () => {
  const options = {
    id: 'local',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3.6:27b',
    contextTokens: 131072,
  }
  const provider = ollama(options)
  const messages = [
    { role: 'system', content: 'instructions' },
    { role: 'user', content: 'data' },
  ]

  it.each([
    ['low', 'low'],
    ['off', false],
  ] as const)('sends thinking %s as its protocol\'s control', async (thinking, think) => {
    const fetchMock = stubFetch(chatResponse)
    const provider = ollama({ ...options, thinking })
    await provider.complete(request)
    expect(sent(fetchMock).body.think).toBe(think)
    expect(provider.thinking).toBe(thinking)
  })

  it('posts the system message first, then the data, to /api/chat, with a stream, no truncation, temperature 0 and JSON format', async () => {
    const fetchMock = stubFetch(chatResponse)
    await provider.complete(request)
    const { url, headers, body } = sent(fetchMock)
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(headers).toEqual({ 'content-type': 'application/json' })
    expect(body).toEqual({
      model: 'qwen3.6:27b',
      messages,
      stream: true,
      truncate: false,
      shift: false,
      options: { temperature: 0, num_predict: 16_000, num_ctx: 131072 },
      format: 'json',
    })
  })

  it.each([
    ['prompt', undefined],
    ['json', 'json'],
    [
      'schema',
      { type: 'object' },
    ],
  ] as const)('maps structuredOutput %s to the format it sends', async (structuredOutput, format) => {
    const fetchMock = stubFetch(chatResponse)
    await ollama({ ...options, structuredOutput }).complete(request)
    expect(sent(fetchMock).body.format).toEqual(format)
  })

  it('sends the token limit as num_predict, and leaves the temperature out for null', async () => {
    const fetchMock = stubFetch(chatResponse)
    await ollama({ ...options, temperature: null, maxTokens: 900 }).complete(request)
    expect(sent(fetchMock).body).toEqual({
      model: 'qwen3.6:27b',
      messages,
      stream: true,
      truncate: false,
      shift: false,
      options: { num_predict: 900, num_ctx: 131072 },
      format: 'json',
    })
  })

  it('sends contextTokens as options.num_ctx, so the server loads the context the guard counts with', async () => {
    const fetchMock = stubFetch(chatResponse)
    await ollama({ ...options, maxTokens: 900, contextTokens: 131072 }).complete(request)
    expect(sent(fetchMock).body.options).toEqual({ temperature: 0, num_predict: 900, num_ctx: 131072 })
  })

  it('refuses an extraBody that sets options.num_ctx, in any letter case: contextTokens sets it', () => {
    for (const key of ['num_ctx', 'NUM_CTX', 'numCtx']) {
      let issues: unknown
      try {
        ollama({
          ...options,
          extraBody: {
            options: { [key]: 8192 },
          },
        })
      } catch (error) {
        issues = (error as ConfigError).issues
      }
      expect(issues, key).toEqual([
        { path: `local.extraBody.options.${key}`, message: 'is set from contextTokens: set contextTokens instead' },
      ])
    }
    expect(() => ollama({
      ...options,
      extraBody: {
        Options: { Num_Ctx: 8192 },
      },
    })).toThrow('local.extraBody.Options.Num_Ctx: is set from contextTokens: set contextTokens instead')
  })

  it('refuses an options that is no object, which would drop num_ctx, with the path and no value', () => {
    for (const [key, value] of [
      ['options', null],
      ['Options', 'zz-value'],
      [
        'OPTIONS',
        ['zz-value'],
      ],
      ['options', 0],
    ] as const) {
      let issues: unknown
      try {
        ollama({
          ...options,
          extraBody: { [key]: value },
        })
      } catch (error) {
        issues = (error as ConfigError).issues
      }
      expect(issues, key).toEqual([
        { path: `local.extraBody.${key}`, message: 'must be an object' },
      ])
    }
  })

  it('refuses a spelling of options other than the one the adapter merges, which would send two keys', () => {
    for (const key of ['Options', 'OPTIONS', 'oPtIoNs']) {
      expect(() => ollama({
        ...options,
        extraBody: { [key]: {} },
      }), key).toThrow(new ConfigError([
        { path: `local.extraBody.${key}`, message: 'must be written options' },
      ]))
    }
    expect(() => ollama({
      ...options,
      extraBody: {
        options: { top_k: 3 },
      },
    })).not.toThrow()
  })

  it('writes the canonical spelling and never the key it was given: a name that is not safe prints as *', () => {
    // A long s upper-cases to S, so Go's decoder reads this key as options.
    const key = `option${String.fromCharCode(0x17F)}`
    expect(() => ollama({
      ...options,
      extraBody: { [key]: {} },
    })).toThrow(new ConfigError([
      { path: 'local.extraBody.*', message: 'must be written options' },
    ]))
  })

  it('sends num_predict 16000 and num_ctx in options when the temperature is null and no limit is set', async () => {
    const fetchMock = stubFetch(chatResponse)
    await ollama({ ...options, temperature: null }).complete(request)
    expect(sent(fetchMock).body).toEqual({
      model: 'qwen3.6:27b',
      messages,
      stream: true,
      truncate: false,
      shift: false,
      options: { num_predict: 16_000, num_ctx: 131072 },
      format: 'json',
    })
  })

  it('returns the content as it came, a think block included, and ignores the thinking, with the model and the usage', async () => {
    stubFetch(chatResponse)
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{}',
      model: 'qwen3.6:27b',
      usage: { inputTokens: 1840, outputTokens: 412 },
      reasoning: true,
      whole: true,
    })
    stubFetch({
      ...chatResponse,
      message: { role: 'assistant', content: '<think>a plan</think>{}' },
    })
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '<think>a plan</think>{}', reasoning: false })
  })

  it('falls back to the configured model, and reports no usage, when the reply names neither', async () => {
    stubFetch({ ...chatResponse, model: '', eval_count: undefined })
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{}',
      model: 'qwen3.6:27b',
      usage: undefined,
      reasoning: true,
      whole: true,
    })
  })

  const { done_reason: _doneReason, ...noDoneReason } = chatResponse

  it.each<[ProviderErrorKind, unknown, string]>([
    ['truncated', truncated, 'local: a reply was cut off at 412 tokens, below the 16000 quorum asked for: the server caps replies near 412: set maxTokens: 412'],
    [
      'invalid-response',
      { error: 'model "qwen9" not found, try pulling it first' },
      'local: server error: "model \\"qwen9\\" not found, try pulling it first"',
    ],
    [
      'invalid-response',
      { ...chatResponse, done: false },
      'local: reply has not finished',
    ],
    [
      'invalid-response',
      { ...chatResponse, done: 'true' },
      'local: reply has not finished',
    ],
    ['invalid-response', noDoneReason, 'local: reply has not finished'],
    [
      'invalid-response',
      { ...chatResponse, done_reason: 'load' },
      'local: reply has not finished',
    ],
    [
      'invalid-response',
      { ...chatResponse, done_reason: '' },
      'local: reply has not finished',
    ],
    ['invalid-response', debugRender, 'local: reply has not finished'],
    [
      'no-answer',
      {
        ...chatResponse,
        message: { role: 'assistant', content: null },
      },
      'local: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
    [
      'no-answer',
      { ...chatResponse, message: 'text' },
      'local: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
    [
      'no-answer',
      { ...chatResponse, message: undefined },
      'local: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
    ['invalid-response', [], 'local: reply is not a JSON object'],
    ['invalid-response', null, 'local: reply is not a JSON object'],
  ])('maps a %s reply to a ProviderError with its exact message', async (kind, body, expected) => {
    stubFetch(body)
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'ProviderError',
      kind,
      retryable: false,
      providerId: 'local',
      message: expected,
    })
  })

  it('reads message.thinking alone as no-answer thinking, never as the answer, quoting none of it', async () => {
    stubFetch({
      ...chatResponse,
      message: { role: 'assistant', content: '', thinking: '{"findings":[]}' },
    })
    const failed = await provider.complete(request).catch((error: unknown) => error)
    expect(failed).toMatchObject({
      name: 'ProviderError',
      kind: 'no-answer',
      noAnswer: 'thinking',
      usage: { inputTokens: 1840, outputTokens: 412 },
      message: 'local: reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt',
    })
    expect(JSON.stringify(failed)).not.toContain('findings')
    expect((failed as Error).message).not.toContain('findings')
  })

  it('reads a length under num_predict, with input and output at num_ctx, as the window ending the reply', async () => {
    const small = ollama({ ...options, contextTokens: 8192, maxTokens: 4000 })
    stubFetch({ ...truncated, prompt_eval_count: 6000, eval_count: 2192 })
    await expect(small.complete(request)).rejects.toMatchObject({
      kind: 'truncated',
      noAnswer: 'window',
      usage: { inputTokens: 6000, outputTokens: 2192 },
      message: 'local: a reply ended at the server\'s window, which is smaller than contextTokens: lower contextTokens',
    })
  })

  it('redacts the key from a server error and cuts it at 200 characters', async () => {
    stubFetch({ error: 'bad key ok-secret' })
    await expect(ollama({ ...options, baseUrl: 'https://ollama.com', apiKey: 'ok-secret' }).complete(request)).rejects.toMatchObject({ message: 'local: server error: "bad key [redacted]"' })
    stubFetch({
      error: 'e'.repeat(1000),
    })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: server error: ${JSON.stringify('e'.repeat(200))}` })
  })

  it('quotes the 400 of a prompt past the context, which truncate: false turns a silent cut into', async () => {
    stubFetch(contextExceeded, 400)
    await expect(provider.complete(request)).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      retryable: false,
      message: `local: HTTP 400: ${JSON.stringify(JSON.stringify(contextExceeded))}`,
    })
  })
})

describe('ollama on a 400 that names its structured-output field', () => {
  const failure = async (body: string, status: number, options: Partial<OllamaOptions> = {}): Promise<unknown> => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, status)))
    return ollama({
      id: 'p',
      baseUrl: 'http://h.example',
      model: 'm',
      contextTokens: 8192,
      maxTokens: 1000,
      ...options,
    }).complete(request).catch((caught: unknown) => caught)
  }

  it('marks a 400 that names format as refused for its structured output, quoting nothing', async () => {
    const error = await failure('{"error":"invalid format: expected a JSON schema"}', 400)
    expect(error).toMatchObject({ kind: 'http', status: 400, refused: 'structuredOutput' })
    expect(Object.entries(error as object).filter(([key, value]) => key !== 'message' && key !== 'name' && typeof value === 'string').flatMap(([, value]) => value as string)).toEqual(['p', 'http', 'structuredOutput'])
    // A whole word: `format` inside another word names nothing, and neither does another status or a request with no format.
    expect(await failure('{"error":"the model does not support reformatting"}', 400)).toMatchObject({ refused: undefined })
    expect(await failure('{"error":"invalid format"}', 404)).toMatchObject({ refused: undefined })
    expect(await failure('{"error":"invalid format"}', 400, { structuredOutput: 'prompt' })).toMatchObject({ refused: undefined })
  })
})

describe('ollama streams', () => {
  const base: OllamaOptions = {
    id: 'local',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3.6:27b',
    contextTokens: 131072,
  }
  const local = ollama(base)
  type Line = Record<string, unknown>
  const lineText = (lines: readonly Line[]): string => lines.map(line => `${JSON.stringify(line)}\n`).join('')
  const streamOf = (lines: readonly Line[], type = 'application/x-ndjson'): Response => new Response(lineText(lines), {
    headers: { 'content-type': type },
  })
  const piece = (fields: Line): Line => ({
    model: 'qwen3.6:27b',
    created_at: '2026-11-09T12:00:00.000000Z',
    message: { role: 'assistant', content: '', ...fields },
    done: false,
  })
  const done = (fields: Line = {}): Line => ({
    ...piece({}),
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 41,
    eval_count: 23,
    ...fields,
  })
  const failed = async (response: Response, provider = local): Promise<unknown> => {
    stubResponses(response)
    return await provider.complete(request).catch((error: unknown) => error)
  }
  const lost = lostStream('local')
  const itemsOf = (lines: readonly Line[]): { items: AsyncGenerator<StreamItem>, cancelled: () => boolean } => {
    const { body, cancelled } = chunkedBody(lineText(lines), 1)
    return {
      items: ndjsonItems(body, { providerId: 'local', lost }),
      cancelled,
    }
  }

  it('sends stream: true by default, and stream: false for a whole request or an option that asks for whole replies', async () => {
    const fetchMock = stubFetch(chatResponse)
    await local.complete(request)
    await local.complete({ ...request, stream: false })
    await ollama({ ...base, stream: false }).complete(request)
    await ollama({ ...base, stream: true }).complete({ ...request, stream: false })
    expect([0, 1, 2, 3].map(call => sent(fetchMock, call).body.stream)).toEqual([true, false, false, true])
  })

  it('reads application/x-ndjson as a stream and a JSON reply as whole', async () => {
    stubResponses(ollamaStream(chatResponse))
    const streamed = await local.complete(request)
    expect(streamed).toEqual({
      text: '{}',
      model: 'qwen3.6:27b',
      usage: { inputTokens: 1840, outputTokens: 412 },
      reasoning: true,
    })
    // The media type decides, whatever follows it, and a JSON reply to a streamed request is read whole, and marked.
    stubResponses(streamOf([
      piece({ content: '{}' }),
      done(),
    ], 'Application/X-NDJSON; charset=utf-8'))
    expect(await local.complete(request)).not.toHaveProperty('whole')
    stubResponses(jsonReply(chatResponse))
    expect(await local.complete(request)).toEqual({ ...streamed, whole: true })
    // A reply served as plain JSON text, with no content type, is whole too.
    stubResponses(new Response(JSON.stringify(chatResponse)))
    expect(await local.complete(request)).toHaveProperty('whole', true)
  })

  it('assembles a stream into the reply its reader reads, the same as the whole reply', async () => {
    stubResponses(streamOf([
      piece({ thinking: 'The diff ' }),
      piece({ thinking: 'calls exec.' }),
      piece({ content: '{"findings"' }),
      piece({ content: ':[]}' }),
      done(),
    ]))
    const streamed = await local.complete(request)
    expect(streamed).toEqual({
      text: '{"findings":[]}',
      model: 'qwen3.6:27b',
      usage: { inputTokens: 41, outputTokens: 23 },
      reasoning: true,
    })
    // The thinking is never kept: the assembled reply holds the one word that says it showed.
    const assembled = await assembleOllama(itemsOf([
      piece({ thinking: 'secret thinking' }),
      piece({ content: '{}' }),
      done(),
    ]).items, 'local')
    expect(assembled).toEqual({
      model: 'qwen3.6:27b',
      message: { role: 'assistant', content: '{}', thinking: 'streamed' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 41,
      eval_count: 23,
    })
    // Every recorded reply that finished, as a whole reply and streamed through the helper, comes to the same. One that did not is a stream that ended too soon.
    for (const recorded of [
      chatResponse,
      truncated,
      empty,
      reasoningOnly,
      countedOut,
      contextExceeded,
    ]) {
      expect(await outcomeOf(local, request, ollamaStream(recorded)), JSON.stringify(recorded).slice(0, 60)).toEqual(await outcomeOf(local, request, jsonReply(recorded)))
    }
  })

  it('reports its progress signals', async () => {
    const signals: StreamSignal[] = []
    stubResponses(streamOf([
      piece({
        thinking: 'x'.repeat(10),
      }),
      piece({ content: 'hello' }),
      done({ eval_count: 40 }),
    ]))
    await local.complete({
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
      data(3, false, true),
      data(4, true, true),
      // The done line's own count, 40, is more than a quarter of the 15 characters.
      data(40, true, true),
    ])
  })

  it('reports a blank line as a keep-alive', async () => {
    const signals: StreamSignal[] = []
    stubResponses(new Response(`\n${JSON.stringify(piece({ content: '{}' }))}\n  \n\n${JSON.stringify(done())}\n`, {
      headers: { 'content-type': 'application/x-ndjson' },
    }))
    await expect(local.complete({
      ...request,
      onProgress: signal => signals.push(signal),
    })).resolves.toMatchObject({ text: '{}' })
    expect(signals.map(signal => signal.kind)).toEqual([
      'headers',
      'keep-alive',
      'data',
      'keep-alive',
      'keep-alive',
      'data',
    ])
    // The last line may end with no line feed.
    stubResponses(new Response(`${JSON.stringify(piece({ content: '{}' }))}\n${JSON.stringify(done())}`, {
      headers: { 'content-type': 'application/x-ndjson' },
    }))
    await expect(local.complete(request)).resolves.toMatchObject({ text: '{}' })
  })

  it('marks a refusal naming its stream word refused stream, never quoting the body', async () => {
    const failure = async (body: string, status: number, options: Partial<OllamaOptions> = {}, asked: CompletionRequest = request): Promise<unknown> => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, status)))
      return await ollama({
        ...base,
        ...options,
      }).complete(asked).catch((caught: unknown) => caught)
    }
    const naming = (word: string): string => `{"error":"json: cannot unmarshal into ${word}"}`
    const error = await failure(naming('stream'), 400)
    expect(error).toMatchObject({ kind: 'http', status: 400, refused: 'stream' })
    expect(Object.entries(error as object).filter(([key, value]) => key !== 'message' && key !== 'name' && typeof value === 'string').flatMap(([, value]) => value as string)).toEqual(['local', 'http', 'stream'])
    expect(await failure(naming('stream'), 422)).toMatchObject({ refused: 'stream' })
    // Another status, a word that is only part of another, and a request that streamed nothing name no refusal.
    expect(await failure(naming('stream'), 500)).toMatchObject({ refused: undefined })
    expect(await failure(naming('streaming'), 400)).toMatchObject({ refused: undefined })
    expect(await failure(naming('stream'), 400, {}, { ...request, stream: false })).toMatchObject({ refused: undefined })
    expect(await failure(naming('stream'), 400, { stream: false })).toMatchObject({ refused: undefined })
    // A pinned stream is marked as well, which is how its fix reads set stream: false.
    expect(await failure(naming('stream'), 400, { stream: true })).toMatchObject({ refused: 'stream' })
  })

  it('reads a line holding an error as the body\'s error', async () => {
    expect(await failed(streamOf([
      piece({ content: '{"kee' }),
      { error: 'model "qwen9" not found, try pulling it first' },
    ]))).toMatchObject({
      kind: 'invalid-response',
      retryable: false,
      message: 'local: server error: "model \\"qwen9\\" not found, try pulling it first"',
    })
    // The text is redacted and cut as a whole reply's error is.
    expect(await failed(streamOf([
      { error: 'bad key ok-secret' },
    ]), ollama({ ...base, baseUrl: 'https://ollama.com', apiKey: 'ok-secret' }))).toMatchObject({ message: 'local: server error: "bad key [redacted]"' })
    expect(await failed(streamOf([
      {
        error: 'e'.repeat(1000),
      },
    ]))).toMatchObject({ message: `local: server error: ${JSON.stringify('e'.repeat(200))}` })
    // An error that is no text is a malformed line, never read as no error.
    expect(await failed(streamOf([
      { error: 7 },
    ]))).toMatchObject({ kind: 'invalid-response', retryable: false, message: 'local: the reply stream\'s error is not text' })
  })

  it('fails a stream with no done line as network', async () => {
    const lastEvent = 'local: the reply stream ended before its last event'
    for (const lines of [
      [
        piece({ content: '{"kee' }),
      ],
      [
        piece({ content: '{}' }),
        {
          ...done(),
          done: false,
        },
      ],
      [
        piece({ content: '{}' }),
        {
          ...done(),
          done: 'true',
        },
      ],
      [],
    ]) {
      expect(await failed(streamOf(lines)), lines.length.toString()).toMatchObject({ kind: 'network', retryable: true, message: lastEvent })
    }
  })

  it('fails a line whose content is no text as invalid-response, never retried, and cancels the body', async () => {
    const lines: Line[] = [
      piece({ content: '{"a"' }),
      {
        ...piece({}),
        message: {
          role: 'assistant',
          content: ['x'],
        },
      },
      piece({ content: ':1}' }),
      done(),
    ]
    const { items, cancelled } = itemsOf(lines)
    await expect(assembleOllama(items, 'local')).rejects.toMatchObject({ kind: 'invalid-response', retryable: false, message: 'local: the reply stream\'s content is not text' })
    expect(cancelled()).toBe(true)
    expect(await failed(streamOf(lines))).toMatchObject({ kind: 'invalid-response', retryable: false })
    // A null content, as a done line may hold, is no text and no failure.
    stubResponses(streamOf([
      piece({ content: '{}' }),
      {
        ...done(),
        message: { role: 'assistant', content: null },
      },
    ]))
    await expect(local.complete(request)).resolves.toMatchObject({ text: '{}' })
  })

  it('ends its read at an error line and at the done line, pulling none of the lines after, and cancels the body', async () => {
    const lines: Line[] = [
      piece({ content: '{"kee' }),
      { error: 'the model has crashed' },
      piece({ content: '{}' }),
      done(),
    ]
    let pulled = 0
    const counted = async function* (): AsyncGenerator<StreamItem> {
      for await (const item of itemsOf(lines).items) {
        pulled += 1
        yield item
      }
    }
    await expect(assembleOllama(counted(), 'local')).resolves.toMatchObject({ error: 'the model has crashed' })
    expect(pulled).toBe(2)
    const errored = itemsOf(lines)
    await assembleOllama(errored.items, 'local')
    expect(errored.cancelled()).toBe(true)
    // The done line ends the read as well: a body that never ends after it is not waited for.
    const ended = itemsOf([
      piece({ content: '{}' }),
      done(),
      piece({ content: 'late' }),
    ])
    await expect(assembleOllama(ended.items, 'local')).resolves.toMatchObject({
      done: true,
      message: { content: '{}' },
    })
    expect(ended.cancelled()).toBe(true)
  })
})

describe('ollama streams with a field of the wrong type', () => {
  const lost = lostStream('local')
  const itemsOf = (...lines: unknown[]): { items: AsyncGenerator<StreamItem>, cancelled: () => boolean } => {
    const { body, cancelled } = chunkedBody(lines.map(line => `${JSON.stringify(line)}\n`).join(''), 1)
    return {
      items: ndjsonItems(body, { providerId: 'local', lost }),
      cancelled,
    }
  }
  const finished = {
    message: { content: '' },
    done: true,
    done_reason: 'stop',
  }

  it.each<[string, unknown, string]>([
    ['a line that is a number', 5, 'line is not an object'],
    ['a line that is null', null, 'line is not an object'],
    [
      'a line that is a list',
      [
        {
          message: { content: '{}' },
        },
      ],
      'line is not an object',
    ],
    [
      'a line whose model is no text',
      { model: 7 },
      'model is not text',
    ],
    [
      'a line whose message is a string',
      { message: '{}' },
      'message is not an object',
    ],
    [
      'a line whose message is a list',
      {
        message: [
          { content: '{}' },
        ],
      },
      'message is not an object',
    ],
    [
      'a line whose content is no text',
      {
        message: {
          content: ['x'],
        },
      },
      'content is not text',
    ],
    [
      'a line whose thinking is no text',
      {
        message: { thinking: 7 },
      },
      'thinking is not text',
    ],
    [
      'a line whose error is no text',
      {
        error: { message: 'x' },
      },
      'error is not text',
    ],
  ])('fails %s as invalid-response, never retried, and cancels the body', async (_name, line, field) => {
    const { items, cancelled } = itemsOf(line, finished)
    await expect(assembleOllama(items, 'local')).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'invalid-response',
      retryable: false,
      message: `local: the reply stream's ${field}`,
    })
    expect(cancelled()).toBe(true)
  })

  it('tolerates an unknown field and a field that is null or absent', async () => {
    const reply = await assembleOllama(itemsOf(
      {
        model: null,
        message: null,
        error: null,
        future: [1],
      },
      {
        message: {
          content: null,
          thinking: null,
          images: [1],
        },
      },
      {
        message: { content: '{}' },
      },
      finished,
    ).items, 'local')
    expect(reply).toMatchObject({
      message: { content: '{}' },
      done: true,
    })
  })
})
