import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { sent, stubFetch } from '../testing/http.ts'
import { ollama } from './ollama.ts'
import { chatResponse, contextExceeded, debugRender, truncated } from '../testing/fixtures/ollama.ts'
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
    truncated,
  },
  read: {
    system: body => conversation(body).find(message => message.role === 'system')?.content,
    firstUser: body => conversation(body).find(message => message.role === 'user')?.content,
    temperature: body => runtime(body).temperature,
    maxTokens: body => runtime(body).num_predict,
  },
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

  it('posts the system message first, then the data, to /api/chat, with no stream, no truncation, temperature 0 and JSON format', async () => {
    const fetchMock = stubFetch(chatResponse)
    await provider.complete(request)
    const { url, headers, body } = sent(fetchMock)
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(headers).toEqual({ 'content-type': 'application/json' })
    expect(body).toEqual({
      model: 'qwen3.6:27b',
      messages,
      stream: false,
      truncate: false,
      shift: false,
      options: { temperature: 0, num_ctx: 131072 },
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
      stream: false,
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

  it('sends only num_ctx in options when the temperature is null and no limit is set', async () => {
    const fetchMock = stubFetch(chatResponse)
    await ollama({ ...options, temperature: null }).complete(request)
    expect(sent(fetchMock).body).toEqual({
      model: 'qwen3.6:27b',
      messages,
      stream: false,
      truncate: false,
      shift: false,
      options: { num_ctx: 131072 },
      format: 'json',
    })
  })

  it('returns the content as it came, a think block included, and ignores the thinking, with the model and the usage', async () => {
    stubFetch(chatResponse)
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{}',
      model: 'qwen3.6:27b',
      usage: { inputTokens: 1840, outputTokens: 412 },
    })
    stubFetch({
      ...chatResponse,
      message: { role: 'assistant', content: '<think>a plan</think>{}' },
    })
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '<think>a plan</think>{}' })
  })

  it('falls back to the configured model, and reports no usage, when the reply names neither', async () => {
    stubFetch({ ...chatResponse, model: '', eval_count: undefined })
    await expect(provider.complete(request)).resolves.toEqual({ text: '{}', model: 'qwen3.6:27b', usage: undefined })
  })

  const { done_reason: _doneReason, ...noDoneReason } = chatResponse

  it.each<[ProviderErrorKind, unknown, string]>([
    ['truncated', truncated, 'local: reply was cut off by the token limit or the context'],
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
      'invalid-response',
      {
        ...chatResponse,
        message: { role: 'assistant', content: null },
      },
      'local: reply has no text',
    ],
    [
      'invalid-response',
      { ...chatResponse, message: 'text' },
      'local: reply has no text',
    ],
    [
      'invalid-response',
      { ...chatResponse, message: undefined },
      'local: reply has no text',
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
