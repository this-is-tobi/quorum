import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, ProviderError } from '../core/errors.ts'
import type { CompletionRequest, StreamSignal } from '../core/ports.ts'
import { sent, stubFetch, textReply } from '../testing/http.ts'
import { chunkedBody, openAiStream, sse } from '../testing/streams.ts'
import { assembleOpenAi, openaiCompatible } from './openai-compatible.ts'
import { sseItems } from './stream.ts'
import type { StreamItem } from './stream.ts'
import type { OpenAICompatibleOptions } from './openai-compatible.ts'
import { GATEWAY_MODEL, GATEWAY_ORIGIN, gatewayStream } from '../testing/fixtures/gateway-stream.ts'
import { chatCompletion, countedOut, empty, groqBrowserSearch, mistralChunks, openRouterGenerationError, reasoningOnly, refusal, searchCitations, stringError, truncated } from '../testing/fixtures/openai-compatible.ts'
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

const ok = {
  choices: [
    {
      finish_reason: 'stop',
      message: { content: '{}' },
    },
  ],
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
  replies: {
    ok: chatCompletion,
    model: 'gpt-6-astra-2026-09-30',
    usage: { inputTokens: 19, outputTokens: 10 },
    reasoned: false,
    refusal,
    truncated,
    empty,
    reasoningOnly,
    countedOut,
  },
  read: {
    system: body => conversation(body).find(message => message.role === 'system')?.content,
    firstUser: body => conversation(body).find(message => message.role === 'user')?.content,
    temperature: body => body.temperature,
    maxTokens: body => body.max_tokens,
  },
  thinking: {
    read: body => body.reasoning_effort,
    extraBody: { reasoning_effort: 'high' },
    lowersTo: 'low',
  },
  jsonMode: {
    read: body => body.response_format,
    extraBody: {
      response_format: { type: 'text' },
    },
  },
  streams: true,
  streamFields: {
    stream: true,
    stream_options: { include_usage: true },
  },
  streamed: reply => openAiStream(reply),
  reservedBodyKeys: [
    'model',
    'messages',
    'stream',
    'stream_options',
  ],
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
    'data_sources',
  ],
  replyLimitPaths: [
    ['max_tokens'],
    ['max_completion_tokens'],
  ],
  structuredOutputs: ['prompt', 'json', 'schema'],
  mergeProbe: {
    extraBody: {
      response_format: { added: true },
    },
    merged: {
      response_format: { type: 'json_object', added: true },
    },
  },
})

describe('openaiCompatible', () => {
  const provider = openaiCompatible({
    id: 'local',
    baseUrl: 'http://localhost:11434/v1//',
    model: 'qwen',
    contextTokens: 131072,
  })

  it.each([
    ['low', 'low'],
    ['off', 'none'],
  ] as const)('sends thinking %s as its protocol\'s control', async (thinking, effort) => {
    const fetchMock = stubFetch(ok)
    const provider = openaiCompatible({
      id: 'x',
      baseUrl: 'http://h/v1',
      model: 'm',
      contextTokens: 131072,
      thinking,
    })
    await provider.complete(request)
    expect(sent(fetchMock).body.reasoning_effort).toBe(effort)
    expect(provider.thinking).toBe(thinking)
  })

  it('posts the system message first, then the data, to /chat/completions with json_object and temperature 0', async () => {
    const fetchMock = stubFetch(ok)
    await provider.complete(request)
    const { url, body } = sent(fetchMock)
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(body).toEqual({
      model: 'qwen',
      messages: [
        { role: 'system', content: 'instructions' },
        { role: 'user', content: 'data' },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 16_000,
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it.each([
    ['prompt', undefined],
    [
      'json',
      { type: 'json_object' },
    ],
    [
      'schema',
      {
        type: 'json_schema',
        json_schema: {
          name: 'panel_vote',
          schema: { type: 'object' },
          strict: true,
        },
      },
    ],
  ] as const)('maps structuredOutput %s to the response format the endpoint expects', async (structuredOutput, responseFormat) => {
    const fetchMock = stubFetch(ok)
    await openaiCompatible({
      id: 'x',
      baseUrl: 'http://h/v1',
      model: 'm',
      contextTokens: 131072,
      structuredOutput,
    }).complete(request)
    expect(sent(fetchMock).body.response_format).toEqual(responseFormat)
  })

  it('sends the token limit as max_completion_tokens when maxTokensField says so', async () => {
    const fetchMock = stubFetch(ok)
    await openaiCompatible({
      id: 'x',
      baseUrl: 'http://h/v1',
      model: 'm',
      contextTokens: 131072,
      maxTokens: 900,
      maxTokensField: 'max_completion_tokens',
    }).complete(request)
    expect(sent(fetchMock).body).toMatchObject({ max_completion_tokens: 900 })
    expect(sent(fetchMock).body).not.toHaveProperty('max_tokens')
  })

  it('sends the limit under the field maxTokensField names, and only there', async () => {
    const base = {
      id: 'x',
      baseUrl: 'http://h/v1',
      model: 'm',
      contextTokens: 131072,
      maxTokensField: 'max_completion_tokens' as const,
    }
    const fetchMock = stubFetch(ok)
    await openaiCompatible(base).complete(request)
    expect(sent(fetchMock).body).toMatchObject({ max_completion_tokens: 16_000 })
    expect(sent(fetchMock).body).not.toHaveProperty('max_tokens')
    await openaiCompatible({ ...base, maxTokens: 4096 }).complete(request)
    expect(sent(fetchMock, 1).body).toMatchObject({ max_completion_tokens: 4096 })
    expect(sent(fetchMock, 1).body).not.toHaveProperty('max_tokens')
  })

  it('refuses a token-limit field or a structured-output mode it does not know', () => {
    const options = {
      id: 'x',
      baseUrl: 'http://h/v1',
      model: 'm',
      contextTokens: 131072,
      maxTokensField: 'max_output_tokens',
      structuredOutput: 'grammar',
    } as unknown as OpenAICompatibleOptions
    expect(() => openaiCompatible(options)).toThrow(new ConfigError([
      { path: 'x.structuredOutput', message: 'must be prompt, json or schema' },
      { path: 'x.maxTokensField', message: 'must be max_tokens or max_completion_tokens' },
    ]))
  })

  it('sends chat_template_kwargs, which sets template variables, such as turning thinking off, and runs nothing on the server', async () => {
    const fetchMock = stubFetch(ok)
    await openaiCompatible({
      id: 'x',
      baseUrl: 'http://h/v1',
      model: 'm',
      contextTokens: 131072,
      extraBody: {
        chat_template_kwargs: { enable_thinking: false },
      },
    }).complete(request)
    expect(sent(fetchMock).body).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    })
  })

  it('returns the text, the model the endpoint reports and the usage', async () => {
    stubFetch({
      model: 'qwen:latest',
      choices: [
        {
          message: { content: 'hi' },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })
    await expect(provider.complete(request)).resolves.toEqual({
      text: 'hi',
      model: 'qwen:latest',
      usage: { inputTokens: 10, outputTokens: 2 },
      reasoning: false,
      whole: true,
    })
  })

  it('falls back to the configured model, and reports no usage, when the endpoint sends none or only part', async () => {
    stubFetch(ok)
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{}',
      model: 'qwen',
      usage: undefined,
      reasoning: false,
      whole: true,
    })
    stubFetch({
      ...ok,
      model: '',
      usage: { prompt_tokens: 10 },
    })
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{}',
      model: 'qwen',
      usage: undefined,
      reasoning: false,
      whole: true,
    })
  })

  it.each([
    [
      'refusal',
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: null, refusal: 'I will not help with that' },
          },
        ],
      },
      /refused/,
    ],
    [
      'refusal',
      {
        choices: [
          {
            message: { content: null, refusal: true },
          },
        ],
      },
      /refused/,
    ],
    [
      'refusal',
      {
        choices: [
          {
            finish_reason: 'content_filter',
            message: { content: '' },
          },
        ],
      },
      /content filter/,
    ],
    [
      'truncated',
      {
        choices: [
          {
            finish_reason: 'length',
            message: { content: '{"kee' },
          },
        ],
      },
      /^local: reply was cut off at its limit of 16000 tokens$/,
    ],
    [
      'invalid-response',
      { choices: [] },
      /no choices/,
    ],
    [
      'no-answer',
      {
        choices: [
          {
            message: { content: null },
          },
        ],
      },
      /^local: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt$/,
    ],
    [
      'invalid-response',
      {
        error: { message: 'model not found' },
      },
      /^local: server error: "model not found"$/,
    ],
    ['invalid-response', stringError, /^local: server error: "'response_format.type' must be 'json_schema' or 'text'"$/],
    [
      'invalid-response',
      { error: {} },
      /^local: server error$/,
    ],
    [
      'truncated',
      {
        choices: [
          {
            finish_reason: 'model_length',
            message: { content: '{"kee' },
          },
        ],
      },
      /^local: reply was cut off at its limit of 16000 tokens$/,
    ],
    [
      'invalid-response',
      {
        choices: [
          {
            finish_reason: 'insufficient_system_resource',
            message: { content: '' },
          },
        ],
      },
      /^local: reply ended early: "insufficient_system_resource"$/,
    ],
    [
      'invalid-response',
      {
        choices: [
          {
            finish_reason: 'error',
            message: { content: '' },
          },
        ],
      },
      /^local: reply ended early: "error"$/,
    ],
    [
      'no-answer',
      {
        choices: [
          {
            message: {
              content: [
                { type: 'thinking', thinking: [] },
              ],
            },
          },
        ],
      },
      /^local: reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt$/,
    ],
    ['invalid-response', null, /not a JSON object/],
    ['invalid-response', [], /not a JSON object/],
    [
      'invalid-response',
      { choices: 'abc' },
      /no choices/,
    ],
    [
      'invalid-response',
      {
        choices: [null],
      },
      /no choices/,
    ],
    [
      'invalid-response',
      {
        choices: ['x'],
      },
      /no choices/,
    ],
    [
      'no-answer',
      {
        choices: [
          { message: 'str' },
        ],
      },
      /has no answer and no reasoning/,
    ],
    [
      'refusal',
      {
        choices: [
          {
            message: { content: null, refusal: {} },
          },
        ],
      },
      /model refused$/,
    ],
  ])('maps a %s reply to a ProviderError', async (kind, body, message) => {
    stubFetch(body)
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'ProviderError',
      kind,
      providerId: 'local',
      message: expect.stringMatching(message),
    })
  })

  const counted = { prompt_tokens: 7, completion_tokens: 9 }

  it.each([
    [
      'a model\'s refusal',
      'refusal',
      {
        finish_reason: 'stop',
        message: { content: null, refusal: 'no' },
      },
    ],
    [
      'the content filter',
      'refusal',
      {
        finish_reason: 'content_filter',
        message: { content: '' },
      },
    ],
    [
      'a reply with no message content',
      'no-answer',
      {
        finish_reason: 'stop',
        message: { content: null },
      },
    ],
  ])('carries the counts of a reply it refuses on its error: %s', async (_name, kind, choice) => {
    stubFetch({
      choices: [choice],
      usage: counted,
    })
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'ProviderError',
      kind,
      usage: { inputTokens: 7, outputTokens: 9 },
    })
  })

  it('carries no usage for a refused reply whose counts are missing or not numbers', async () => {
    const choices = [
      {
        message: { content: null, refusal: 'no' },
      },
    ]
    for (const usage of [
      undefined,
      { prompt_tokens: 7, completion_tokens: '9' },
    ]) {
      stubFetch({ choices, usage })
      const failed = await provider.complete(request).catch((error: unknown) => error)
      expect(failed, JSON.stringify(usage)).toMatchObject({ kind: 'refusal' })
      expect((failed as { usage?: unknown }).usage, JSON.stringify(usage)).toBeUndefined()
    }
  })

  it('reports a server error sent with status 200 by its own code, so a 5xx stays retryable (OpenRouter)', async () => {
    stubFetch(openRouterGenerationError)
    await expect(provider.complete(request)).rejects.toMatchObject({
      kind: 'http',
      status: 502,
      retryable: true,
      message: 'local: server error 502: "Provider returned error"',
    })
  })

  it('reads a reply whose error is null as a success, and a server error whose code is not an error status as not retryable', async () => {
    stubFetch({ ...chatCompletion, error: null })
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '{}' })
    const notAnErrorStatus = [
      'rate_limit_exceeded',
      200,
      399,
      600,
      502.5,
      '502',
    ].map(code => [code, 'invalid-response', false] as const)
    for (const [code, kind, retryable] of [
      ...notAnErrorStatus,
      [429, 'http', true] as const,
    ]) {
      stubFetch({
        error: { code, message: 'slow down' },
      })
      await expect(provider.complete(request), String(code)).rejects.toMatchObject({ kind, retryable })
    }
  })

  it('joins the text parts of a content array and skips its thinking parts (Mistral)', async () => {
    stubFetch(mistralChunks)
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{"keep":true,"reasoning":"r"}',
      model: 'magistral-medium-2610',
      usage: { inputTokens: 40, outputTokens: 12 },
      reasoning: true,
      whole: true,
    })
    stubFetch({
      choices: [
        {
          message: {
            content: [
              { type: 'reasoning', text: 'a plan' },
              { type: 'text', text: '{}' },
            ],
          },
        },
      ],
    })
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '{}' })
  })

  it.each([
    [
      'message.reasoning (vLLM)',
      { content: null, reasoning: '{"findings":[]}' },
      undefined,
    ],
    [
      'message.reasoning_content (llama.cpp, DeepSeek)',
      { content: '', reasoning_content: '{"findings":[]}' },
      undefined,
    ],
    [
      'a thinking part (Mistral)',
      {
        content: [
          {
            type: 'thinking',
            thinking: [
              { type: 'text', text: '{"findings":[]}' },
            ],
          },
        ],
      },
      undefined,
    ],
    [
      'a reasoning token count above 0',
      { content: '' },
      {
        prompt_tokens: 7,
        completion_tokens: 9,
        completion_tokens_details: { reasoning_tokens: 9 },
      },
    ],
  ])('reads a finished reply whose answer sits in %s as no-answer thinking, never as the answer, quoting none of it', async (_name, message, usage) => {
    stubFetch({
      choices: [
        {
          finish_reason: 'stop',
          message,
        },
      ],
      usage: usage ?? { prompt_tokens: 7, completion_tokens: 9 },
    })
    const failed = await provider.complete(request).catch((error: unknown) => error)
    expect(failed).toMatchObject({
      name: 'ProviderError',
      kind: 'no-answer',
      noAnswer: 'thinking',
      usage: { inputTokens: 7, outputTokens: 9 },
      message: 'local: reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt',
    })
    expect(JSON.stringify(failed)).not.toContain('findings')
    expect((failed as Error).message).not.toContain('findings')
  })

  it('reads a cut-off at the server\'s window when input and output reach contextTokens below the limit sent', async () => {
    const small = openaiCompatible({
      id: 'local',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen',
      contextTokens: 8192,
      maxTokens: 4000,
    })
    stubFetch({
      choices: [
        {
          finish_reason: 'length',
          message: { content: '{"kee' },
        },
      ],
      usage: { prompt_tokens: 6000, completion_tokens: 2192 },
    })
    await expect(small.complete(request)).rejects.toMatchObject({
      kind: 'truncated',
      noAnswer: 'window',
      usage: { inputTokens: 6000, outputTokens: 2192 },
      message: 'local: a reply ended at the server\'s window, which is smaller than contextTokens: lower contextTokens',
    })
    // The same cut-off with room left in the window is a server that caps replies, whatever it says of its flag.
    stubFetch({
      choices: [
        {
          finish_reason: 'length',
          message: { content: '{"kee' },
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 2192 },
    })
    await expect(small.complete(request)).rejects.toMatchObject({
      kind: 'truncated',
      noAnswer: 'reply',
      message: 'local: a reply was cut off at 2192 tokens, below the 4000 quorum asked for: the server caps replies near 2192: set maxTokens: 2192',
    })
  })

  it('caps the refusal and the server error at 200 characters before quoting them', async () => {
    stubFetch({
      choices: [
        {
          message: {
            content: null,
            refusal: 'r'.repeat(1000),
          },
        },
      ],
    })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: model refused: ${JSON.stringify('r'.repeat(200))}` })
    stubFetch({
      error: {
        message: 'e'.repeat(1000),
      },
    })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: server error: ${JSON.stringify('e'.repeat(200))}` })
  })

  it('writes the refusal and the server error as JSON strings, so a line break cannot start a workflow command in a log', async () => {
    const escape = String.fromCharCode(27)
    stubFetch({
      choices: [
        {
          message: { content: null, refusal: `no\n::error::forged${escape}[2K` },
        },
      ],
    })
    const refusal = await provider.complete(request).catch((caught: Error) => caught) as Error
    stubFetch({
      error: { message: `bad\n::error::forged${escape}[2K` },
    })
    const server = await provider.complete(request).catch((caught: Error) => caught) as Error
    for (const { message } of [refusal, server]) {
      expect([...message].some(char => char.charCodeAt(0) < 32)).toBe(false)
      expect(message).toContain('::error::forged')
    }
  })

  const ranTool = 'the server ran a tool for this reply, which quorum never allows'
  const withMessage = (fields: Body): Body => ({
    choices: [
      {
        finish_reason: 'stop',
        message: { content: '{}', ...fields },
      },
    ],
  })

  it('fails a reply that shows a tool the server ran, Groq\'s executed_tools or a url_citation annotation, as not retryable', async () => {
    const shapes = [
      searchCitations,
      withMessage({
        executed_tools: [{}],
      }),
      withMessage({
        annotations: [
          null,
          { type: 'file_citation' },
          { type: 'url_citation' },
        ],
      }),
    ]
    for (const body of shapes) {
      stubFetch(body)
      await expect(provider.complete(request)).rejects.toMatchObject({
        name: 'ProviderError',
        kind: 'invalid-response',
        retryable: false,
        message: `local: ${ranTool}`,
      })
    }
  })

  it('fails Groq\'s reply of gpt-oss after a browser search it ran by itself, though no preset refused the model id', async () => {
    stubFetch(groqBrowserSearch)
    const groq = openaiCompatible({
      id: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
      contextTokens: 131072,
      apiKey: 'gsk-k',
    })
    await expect(groq.complete(request)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'invalid-response',
      retryable: false,
      message: `groq: ${ranTool}`,
    })
  })

  it('reads as a success an empty executed_tools, one that is not an array, annotations that are not an array, and annotations without a url_citation', async () => {
    for (const fields of [
      { executed_tools: [] },
      { executed_tools: null },
      { executed_tools: {} },
      { annotations: [] },
      { annotations: {} },
      { annotations: null },
      {
        annotations: [
          null,
          'url_citation',
          { type: 'file_citation' },
        ],
      },
    ]) {
      stubFetch(withMessage(fields))
      await expect(provider.complete(request), JSON.stringify(fields)).resolves.toMatchObject({ text: '{}' })
    }
  })

  it('reads a server error before a tool the server ran, and that tool before a refusal or a finish reason', async () => {
    stubFetch({
      error: { message: 'model not found' },
      ...withMessage({
        executed_tools: [{}],
      }),
    })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: 'local: server error: "model not found"' })
    stubFetch(withMessage({
      content: null,
      refusal: 'no',
      executed_tools: [{}],
    }))
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: ${ranTool}` })
    stubFetch({
      choices: [
        {
          finish_reason: 'length',
          message: {
            content: '{"kee',
            annotations: [
              { type: 'url_citation' },
            ],
          },
        },
      ],
    })
    await expect(provider.complete(request)).rejects.toMatchObject({ message: `local: ${ranTool}` })
  })

  it('redacts the key from a refusal or a server error that echoes it', async () => {
    const keyed = openaiCompatible({
      id: 'local',
      baseUrl: 'http://h/v1',
      model: 'm',
      contextTokens: 131072,
      apiKey: 'sk-secret',
    })
    stubFetch({
      choices: [
        {
          message: { content: null, refusal: 'your key sk-secret is not allowed' },
        },
      ],
    })
    await expect(keyed.complete(request)).rejects.toMatchObject({ message: 'local: model refused: "your key [redacted] is not allowed"' })
    stubFetch({
      error: { message: 'bad key sk-secret' },
    })
    await expect(keyed.complete(request)).rejects.toMatchObject({ message: 'local: server error: "bad key [redacted]"' })
  })
})

describe('openaiCompatible on a 400 that names its structured-output field', () => {
  const failure = async (body: string, status: number, options: Partial<OpenAICompatibleOptions> = {}): Promise<unknown> => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, status)))
    return openaiCompatible({
      id: 'p',
      baseUrl: 'https://h.example/v1',
      model: 'm',
      contextTokens: 8192,
      maxTokens: 1000,
      ...options,
    }).complete(request).catch((caught: unknown) => caught)
  }

  it('marks a 400 that names response_format as refused for its structured output, quoting nothing', async () => {
    const error = await failure('{"error":{"message":"response_format is unsupported by this model"}}', 400)
    expect(error).toMatchObject({ kind: 'http', status: 400, refused: 'structuredOutput' })
    // The field's name is matched, never copied: the mark is a code word.
    expect(Object.entries(error as object).filter(([key, value]) => key !== 'message' && key !== 'name' && typeof value === 'string').flatMap(([, value]) => value as string)).toEqual(['p', 'http', 'structuredOutput'])
    expect(await failure('{"error":{"message":"response_format is unsupported"}}', 422)).toMatchObject({ refused: 'structuredOutput' })
    // Another field, another status, and a request that sent no response_format name no refusal.
    expect(await failure('{"error":{"message":"reasoning_effort is unsupported"}}', 400)).toMatchObject({ refused: undefined })
    expect(await failure('{"error":{"message":"response_format is unsupported"}}', 500)).toMatchObject({ refused: undefined })
    expect(await failure('{"error":{"message":"response_format is unsupported"}}', 400, { structuredOutput: 'prompt' })).toMatchObject({ refused: undefined })
    expect(await failure('{"error":{"message":"response_format is unsupported"}}', 400, { structuredOutput: 'schema' })).toMatchObject({ refused: 'structuredOutput' })
  })

  it('states the lowered level of its preset, and sends the request\'s level as the control it maps to', async () => {
    const adapts = (options: Partial<OpenAICompatibleOptions>): unknown => Object.getOwnPropertyDescriptor(openaiCompatible({
      id: 'p',
      baseUrl: 'https://h.example/v1',
      model: 'm',
      contextTokens: 8192,
      ...options,
    }), 'adapts')?.value
    expect(adapts({})).toEqual({ thinking: 'low', prompt: true, stream: true })
    expect(adapts({ lowersThinkingTo: 'off' })).toEqual({ thinking: 'off', prompt: true, stream: true })
    const fetchMock = stubFetch(chatCompletion)
    await openaiCompatible({
      id: 'p',
      baseUrl: 'https://h.example/v1',
      model: 'm',
      contextTokens: 8192,
      maxTokens: 1000,
      lowersThinkingTo: 'off',
    }).complete({ ...request, thinking: 'off' })
    expect(sent(fetchMock).body.reasoning_effort).toBe('none')
  })
})

describe('openaiCompatible streams', () => {
  const base = {
    id: 'local',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen',
    contextTokens: 131072,
  }
  const local = openaiCompatible(base)
  /** The events as a server streams them, `[DONE]` last unless `done` says otherwise. */
  const streamOf = (events: readonly unknown[], done = true): Response => new Response(sse([
    ...events.map(data => ({ data })),
    ...done
      ? [
          { data: '[DONE]' },
        ]
      : [],
  ]), {
    headers: { 'content-type': 'text/event-stream' },
  })
  const chunk = (delta: unknown, finish: unknown = null): Record<string, unknown> => ({
    model: 'qwen-1',
    choices: [
      { index: 0, delta, finish_reason: finish },
    ],
  })
  /** Answers each call of `fetch` with the next response. */
  const serve = (...responses: Response[]): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn()
    for (const response of responses) fetchMock.mockImplementationOnce(async () => response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('sends stream and stream_options by default, stream_options left out for a bare stream, and neither for stream: false', async () => {
    const fetchMock = stubFetch(ok)
    await local.complete(request)
    await local.complete({ ...request, stream: 'bare' })
    await local.complete({ ...request, stream: false })
    expect(sent(fetchMock, 0).body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(sent(fetchMock, 1).body).toMatchObject({ stream: true })
    expect(sent(fetchMock, 1).body).not.toHaveProperty('stream_options')
    expect(sent(fetchMock, 2).body).not.toHaveProperty('stream')
    expect(sent(fetchMock, 2).body).not.toHaveProperty('stream_options')
    // The option that asks for whole replies sends neither, and a pinned stream ignores the request's change.
    await openaiCompatible({ ...base, stream: false }).complete(request)
    expect(sent(fetchMock, 3).body).not.toHaveProperty('stream')
    await openaiCompatible({ ...base, stream: true }).complete({ ...request, stream: false })
    expect(sent(fetchMock, 4).body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('assembles a stream into the reply its reader reads, the same as the whole reply', async () => {
    const reply = {
      model: 'qwen-3-2610',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"findings":[]}', reasoning_content: 'The diff calls exec.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 41, completion_tokens: 23, total_tokens: 64 },
    }
    serve(streamOf([
      {
        ...chunk({ role: 'assistant' }),
        model: 'qwen-3-2610',
      },
      chunk({ reasoning_content: 'The diff ' }),
      chunk({ reasoning_content: 'calls exec.' }),
      chunk({ content: '{"findings"' }),
      chunk({ content: ':[]}' }),
      chunk({}, 'stop'),
      { model: 'qwen-3-2610', choices: [], usage: reply.usage },
    ]))
    const streamed = await local.complete(request)
    stubFetch(reply)
    const whole = await local.complete(request)
    expect(streamed).toEqual({
      text: '{"findings":[]}',
      model: 'qwen-3-2610',
      usage: { inputTokens: 41, outputTokens: 23 },
      reasoning: true,
    })
    expect(whole).toEqual({ ...streamed, whole: true })
    // The recorded replies stream through the helper the same way.
    for (const recorded of [chatCompletion, mistralChunks, reply]) {
      serve(openAiStream(recorded))
      const viaStream = await local.complete(request)
      stubFetch(recorded)
      expect(viaStream).toEqual({
        ...await local.complete(request),
        whole: undefined,
      })
    }
  })

  it.each<[string, () => Response, object]>([
    [
      'whose content comes as text parts',
      () => streamOf([
        chunk({
          content: [
            { type: 'text', text: '{"a"' },
          ],
        }),
        chunk({
          content: [
            { type: 'text', text: ':1}' },
          ],
        }),
        chunk({}, 'stop'),
      ]),
      { text: '{"a":1}' },
    ],
    [
      'with a refusal',
      () => streamOf([
        chunk({ refusal: 'I will ' }),
        chunk({ refusal: 'not' }),
        chunk({}, 'stop'),
      ]),
      { kind: 'refusal', message: 'local: model refused: "I will not"' },
    ],
    [
      'with a url_citation annotation',
      () => streamOf([
        chunk({ content: '{}' }),
        chunk({
          annotations: [
            {
              type: 'url_citation',
              url_citation: { url: 'https://advisories.example/1' },
            },
          ],
        }),
        chunk({}, 'stop'),
      ]),
      { kind: 'invalid-response', retryable: false, message: 'local: the server ran a tool for this reply, which quorum never allows' },
    ],
    [
      'ending at a finish reason with no [DONE]',
      () => streamOf([
        chunk({ content: '{}' }),
        chunk({}, 'stop'),
      ], false),
      { text: '{}' },
    ],
    [
      'ending with neither a finish reason nor [DONE]',
      () => streamOf([
        chunk({ content: '{"kee' }),
      ], false),
      { kind: 'network', retryable: true, message: 'local: the reply stream ended before its last event' },
    ],
    [
      'with a chunk holding an error of code 503',
      () => streamOf([
        chunk({ content: '{"kee' }),
        {
          error: { code: 503, message: 'overloaded' },
        },
      ]),
      {
        kind: 'http',
        status: 503,
        retryable: true,
        message: 'local: server error 503: "overloaded"',
      },
    ],
    [
      'with an error of no status',
      () => streamOf([
        {
          error: { message: 'model not found' },
        },
      ]),
      { kind: 'invalid-response', retryable: false, message: 'local: server error: "model not found"' },
    ],
    [
      'ended by finish_reason: "error"',
      () => streamOf([
        chunk({ content: '' }, 'error'),
      ]),
      { kind: 'invalid-response', message: 'local: reply ended early: "error"' },
    ],
    [
      'whose answer passes 1 000 000 characters',
      () => streamOf([
        chunk({
          content: 'a'.repeat(600_000),
        }),
        chunk({
          content: 'a'.repeat(600_000),
        }),
        chunk({}, 'stop'),
      ]),
      { kind: 'invalid-response', retryable: false, message: 'local: the reply stream\'s answer is over 1000000 characters' },
    ],
  ])('reads a streamed reply %s', async (_name, response, expected) => {
    serve(response())
    const result = await local.complete(request).catch((error: unknown) => error)
    expect(result).toMatchObject(expected)
  })

  it('reads a [DONE] with no finish reason as a stream that ended too soon, and a finish reason with no content as an empty reply', async () => {
    serve(streamOf([
      chunk({ content: '{"kee' }),
    ]))
    await expect(local.complete(request)).rejects.toMatchObject({ kind: 'network', message: 'local: the reply stream ended before its last event' })
    serve(streamOf([
      chunk({ role: 'assistant' }),
      chunk({}, 'stop'),
    ]))
    await expect(local.complete(request)).rejects.toMatchObject({ kind: 'no-answer', noAnswer: 'empty' })
  })

  it('reads a gateway\'s stream: a charset in its content type, reasoning deltas only, cut off at its limit while reasoning', async () => {
    serve(gatewayStream())
    const gateway = openaiCompatible({
      id: 'gateway',
      baseUrl: `${GATEWAY_ORIGIN}/v1`,
      model: GATEWAY_MODEL,
      contextTokens: 248_000,
      maxTokens: 4000,
    })
    const signals: StreamSignal[] = []
    const failed = await gateway.complete({
      ...request,
      onProgress: signal => signals.push(signal),
    }).catch((error: unknown) => error)
    expect(failed).toMatchObject({
      kind: 'truncated',
      noAnswer: 'thinking',
      retryable: false,
      usage: { inputTokens: 67, outputTokens: 4000 },
    })
    // The reasoning is counted as it streams and never kept or quoted.
    expect(JSON.stringify(failed)).not.toContain('rrrr')
    const data = signals.filter(signal => signal.kind === 'data')
    expect(signals[0]).toEqual({ kind: 'headers' })
    expect(data.at(-1)).toEqual({
      kind: 'data',
      outputTokens: 4000,
      answer: false,
      reasoning: true,
    })
    // A quarter of the 14 285 characters is less than the 4000 tokens the usage chunk then reports.
    expect(data.at(-2)).toEqual({
      kind: 'data',
      outputTokens: 3572,
      answer: false,
      reasoning: true,
    })
  })

  it('reports headers, data with the output so far and whether an answer or reasoning has shown, and keep-alives', async () => {
    const signals: StreamSignal[] = []
    const onProgress = (signal: StreamSignal): number => signals.push(signal)
    const body = `: keep-alive\n\n${sse([
      chunk({ role: 'assistant' }),
      chunk({
        reasoning: 'x'.repeat(10),
      }),
      chunk({ content: 'hello' }),
      chunk({}, 'stop'),
      {
        model: 'qwen-1',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 40 },
      },
    ].map(data => ({ data })))}data: [DONE]\n\n`
    serve(new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }))
    await local.complete({ ...request, onProgress })
    expect(signals).toEqual([
      { kind: 'headers' },
      { kind: 'keep-alive' },
      {
        kind: 'data',
        outputTokens: 0,
        answer: false,
        reasoning: false,
      },
      {
        kind: 'data',
        outputTokens: 3,
        answer: false,
        reasoning: true,
      },
      {
        kind: 'data',
        outputTokens: 4,
        answer: true,
        reasoning: true,
      },
      {
        kind: 'data',
        outputTokens: 4,
        answer: true,
        reasoning: true,
      },
      {
        kind: 'data',
        outputTokens: 40,
        answer: true,
        reasoning: true,
      },
    ])
    // A stream of reasoning alone has shown no answer.
    signals.length = 0
    serve(streamOf([
      chunk({ reasoning: 'thinking about it' }),
      chunk({}, 'length'),
    ]))
    await local.complete({ ...request, onProgress }).catch(() => undefined)
    expect(signals.filter(signal => signal.kind === 'data').at(-1)).toEqual({
      kind: 'data',
      outputTokens: 5,
      answer: false,
      reasoning: true,
    })
  })

  it('answers a whole reply to a streamed request with whole: true, and a pinned stream: true too', async () => {
    stubFetch(ok)
    await expect(local.complete(request)).resolves.toMatchObject({ text: '{}', whole: true })
    await expect(openaiCompatible({ ...base, stream: true }).complete(request)).resolves.toMatchObject({ text: '{}', whole: true })
    await expect(local.complete({ ...request, stream: 'bare' })).resolves.toMatchObject({ whole: true })
    // A request that asked for a whole reply, or a provider set to whole replies, is answered as it asked: no event.
    await expect(local.complete({ ...request, stream: false })).resolves.not.toHaveProperty('whole')
    await expect(openaiCompatible({ ...base, stream: false }).complete(request)).resolves.not.toHaveProperty('whole')
  })

  it('refuses stream_options and a stream that is no boolean in its options', () => {
    expect(() => openaiCompatible({
      ...base,
      extraBody: {
        stream_options: { include_usage: false },
      },
      stream: 'yes' as unknown as boolean,
    })).toThrow(new ConfigError([
      { path: 'local.extraBody.stream_options', message: 'is written by the adapter and cannot be replaced' },
      { path: 'local.stream', message: 'must be true or false' },
    ]))
  })
})

describe('openaiCompatible on a 400 that names a stream field', () => {
  const failure = async (body: string, status: number, options: Partial<OpenAICompatibleOptions> = {}, asked: CompletionRequest = request): Promise<unknown> => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, status)))
    return openaiCompatible({
      id: 'p',
      baseUrl: 'https://h.example/v1',
      model: 'm',
      contextTokens: 8192,
      maxTokens: 1000,
      ...options,
    }).complete(asked).catch((caught: unknown) => caught)
  }
  const naming = (word: string): string => `{"error":{"message":"${word} is not supported"}}`

  it('marks a 400 naming stream_options refused streamOptions, and one naming stream refused stream, never quoting the body', async () => {
    const error = await failure(naming('stream_options'), 400)
    expect(error).toMatchObject({ kind: 'http', status: 400, refused: 'streamOptions' })
    // The word is matched, never copied: every string the error holds but its message is a code word.
    expect(Object.entries(error as object).filter(([key, value]) => key !== 'message' && key !== 'name' && typeof value === 'string').flatMap(([, value]) => value as string)).toEqual(['p', 'http', 'streamOptions'])
    expect(await failure(naming('stream'), 422)).toMatchObject({ refused: 'stream' })
    expect(await failure(naming('"stream"'), 400)).toMatchObject({ refused: 'stream' })
    // A body naming the options only is no refusal of streaming, and one naming both is the options' first.
    expect(await failure(naming('stream_options'), 400)).not.toMatchObject({ refused: 'stream' })
    expect(await failure('{"error":{"message":"stream_options needs stream"}}', 400)).toMatchObject({ refused: 'streamOptions' })
    // Another status, a word that is only part of another, and a field no request sent name no refusal.
    expect(await failure(naming('stream'), 500)).toMatchObject({ refused: undefined })
    expect(await failure('{"error":{"message":"streaming is not supported"}}', 400)).toMatchObject({ refused: undefined })
    expect(await failure(naming('stream_option'), 400)).toMatchObject({ refused: undefined })
    // A request with no stream options names no refusal of them, and one asking for a whole reply none at all.
    expect(await failure(naming('stream_options'), 400, {}, { ...request, stream: 'bare' })).toMatchObject({ refused: undefined })
    expect(await failure(naming('stream'), 400, {}, { ...request, stream: 'bare' })).toMatchObject({ refused: 'stream' })
    expect(await failure(naming('stream'), 400, {}, { ...request, stream: false })).toMatchObject({ refused: undefined })
    expect(await failure(naming('stream'), 400, { stream: false })).toMatchObject({ refused: undefined })
    // A pinned stream is marked as well, which is how its fix reads set stream: false.
    expect(await failure(naming('stream_options'), 400, { stream: true })).toMatchObject({ refused: 'streamOptions' })
    // The streaming words come first: a body that names a structured-output field and the stream is the stream's.
    expect(await failure('{"error":{"message":"response_format and stream are unsupported"}}', 400)).toMatchObject({ refused: 'stream' })
    expect(await failure('{"error":{"message":"response_format is unsupported"}}', 400)).toMatchObject({ refused: 'structuredOutput' })
  })
})

describe('openaiCompatible streams with a field of the wrong type', () => {
  const lost = (error: unknown): ProviderError => new ProviderError({
    providerId: 'local',
    kind: 'network',
    message: String(error),
  })
  const itemsOf = (...chunks: unknown[]): { items: AsyncGenerator<StreamItem>, cancelled: () => boolean } => {
    const { body, cancelled } = chunkedBody(`${sse(chunks.map(data => ({ data })))}data: [DONE]\n\n`, 1)
    return {
      items: sseItems(body, { providerId: 'local', sentinel: '[DONE]', lost }),
      cancelled,
    }
  }
  const delta = (body: unknown): object => ({
    choices: [
      { index: 0, delta: body },
    ],
  })
  const stop = {
    choices: [
      { index: 0, delta: {}, finish_reason: 'stop' },
    ],
  }

  it.each<[string, unknown, string]>([
    ['a chunk that is a number', 5, 'chunk is not an object'],
    ['a chunk that is null', null, 'chunk is not an object'],
    [
      'a chunk whose model is no text',
      { model: 7 },
      'model is not text',
    ],
    [
      'a chunk whose usage is no object',
      { usage: 'x' },
      'usage is not an object',
    ],
    [
      'a chunk whose error is a number',
      { error: 5 },
      'error is not an object',
    ],
    [
      'a chunk whose choices is no list',
      {
        choices: { 0: {} },
      },
      'choices is not a list',
    ],
    [
      'a choice that is no object',
      {
        choices: ['x'],
      },
      'choice is not an object',
    ],
    [
      'a choice whose delta is no object',
      {
        choices: [
          { delta: 'x' },
        ],
      },
      'delta is not an object',
    ],
    [
      'a delta whose content is a number',
      delta({ content: 7 }),
      'content is not text',
    ],
    [
      'a delta whose content part is no object',
      delta({
        content: ['x'],
      }),
      'content part is not an object',
    ],
    [
      'a delta whose content part type is no text',
      delta({
        content: [
          { type: 7 },
        ],
      }),
      'content part type is not text',
    ],
    [
      'a text part whose text is no text',
      delta({
        content: [
          { type: 'text', text: 7 },
        ],
      }),
      'text is not text',
    ],
    [
      'a delta whose refusal is no text',
      delta({ refusal: 7 }),
      'refusal is not text',
    ],
    [
      'a delta whose reasoning is no text',
      delta({
        reasoning: ['x'],
      }),
      'reasoning is not text',
    ],
    [
      'a delta whose reasoning_content is no text',
      delta({ reasoning_content: 7 }),
      'reasoning_content is not text',
    ],
    [
      'a delta whose annotations is no list',
      delta({
        annotations: { type: 'url_citation' },
      }),
      'annotations is not a list',
    ],
    [
      'a delta whose annotation is no object',
      delta({
        annotations: ['url_citation'],
      }),
      'annotation is not an object',
    ],
    [
      'an annotation whose type is no text',
      delta({
        annotations: [
          { type: 7 },
        ],
      }),
      'annotation type is not text',
    ],
    [
      'a delta whose executed_tools is no list',
      delta({
        executed_tools: { name: 'search' },
      }),
      'executed_tools is not a list',
    ],
  ])('fails %s as invalid-response, never retried, and cancels the body', async (_name, chunk, field) => {
    const { items, cancelled } = itemsOf(chunk, stop)
    await expect(assembleOpenAi(items, 'local')).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'invalid-response',
      retryable: false,
      message: `local: the reply stream's ${field}`,
    })
    expect(cancelled()).toBe(true)
  })

  it('is complete only once choice index 0 finishes: another choice finishing, or index 0 never kept, is a stream that ended early', async () => {
    const ended = { kind: 'network', retryable: true, message: 'local: the reply stream ended before its last event' }
    const other = await assembleOpenAi(itemsOf(
      delta({ content: '{"partial":' }),
      {
        choices: [
          {
            index: 1,
            delta: { content: 'x' },
            finish_reason: 'stop',
          },
        ],
      },
    ).items, 'local').catch((caught: unknown) => caught)
    expect(other).toMatchObject(ended)
    // Eight other choices fill the cap before index 0 shows: it is never kept, though it finishes.
    const crowded = await assembleOpenAi(itemsOf(
      {
        choices: Array.from({ length: 8 }, (_, at) => ({
          index: at + 1,
          delta: { content: 'x' },
          finish_reason: 'stop',
        })),
      },
      {
        choices: [
          {
            index: 0,
            delta: { content: '{}' },
            finish_reason: 'stop',
          },
        ],
      },
    ).items, 'local').catch((caught: unknown) => caught)
    expect(crowded).toMatchObject(ended)
    // Choice 0 finishing completes the stream, and its is the one choice the reply holds, whatever came before it.
    const reply = await assembleOpenAi(itemsOf(
      {
        choices: [
          {
            index: 1,
            delta: { content: 'other' },
            finish_reason: 'stop',
          },
          {
            index: 0,
            delta: { content: '{}' },
          },
        ],
      },
      stop,
    ).items, 'local')
    expect(reply).toMatchObject({
      choices: [
        {
          index: 0,
          message: { content: '{}' },
          finish_reason: 'stop',
        },
      ],
    })
    expect(reply.choices).toHaveLength(1)
  })

  it('ends its read at an error chunk, pulling none of the chunks after it, and cancels the body', async () => {
    const { items, cancelled } = itemsOf(
      delta({ content: '{}' }),
      {
        error: { message: 'Overloaded', code: 529 },
      },
      delta({ content: 'later' }),
      stop,
    )
    let pulled = 0
    const counted = async function* (): AsyncGenerator<StreamItem> {
      for await (const item of items) {
        pulled += 1
        yield item
      }
    }
    const reply = await assembleOpenAi(counted(), 'local')
    // The content chunk and the error chunk: nothing after it is read, and what came before it is no answer.
    expect(pulled).toBe(2)
    expect(reply).toMatchObject({
      error: { code: 529 },
    })
    expect(cancelled()).toBe(true)
  })

  it('tolerates an unknown content part type, an unknown field, and a field that is null or absent', async () => {
    const reply = await assembleOpenAi(itemsOf(
      {
        model: null,
        usage: null,
        error: null,
        choices: null,
        system_fingerprint: 'fp',
      },
      delta({
        content: null,
        refusal: null,
        reasoning: null,
        annotations: null,
        executed_tools: null,
        tool_calls: [1],
      }),
      delta({
        content: [
          { type: 'image_url', image_url: {} },
          { type: 'text', text: '{}' },
          { type: 'text' },
        ],
      }),
      stop,
    ).items, 'local')
    expect(reply).toMatchObject({
      choices: [
        {
          message: { content: '{}' },
          finish_reason: 'stop',
        },
      ],
    })
  })
})
