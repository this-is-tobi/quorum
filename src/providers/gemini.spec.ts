import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ProviderError, ProviderErrorKind } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { jsonReply, sent, stubFetch, textReply } from '../testing/http.ts'
import { gemini } from './gemini.ts'
import type { GeminiOptions } from './gemini.ts'
import { candidate, countedOut, empty, generateContentResponse, invalidKey, promptBlocked, reasoningOnly, thoughtsOnlyCutOff, truncated, withThoughts } from '../testing/fixtures/gemini.ts'
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
interface Content { role?: string, parts: Array<{ text: string }> }
const contents = (body: Body): Content[] => body.contents as Content[]
const generationConfig = (body: Body): Body | undefined => body.generationConfig as Body | undefined

describeProviderContract({
  protocol: 'gemini',
  make: options => gemini(options),
  fixedHeaders: {},
  defaultKeyHeader: key => ['x-goog-api-key', key],
  replies: {
    ok: generateContentResponse,
    model: 'gemini-3.8-flash',
    usage: { inputTokens: 1840, outputTokens: 340 },
    reasoned: true,
    refusal: promptBlocked,
    truncated,
    empty,
    reasoningOnly,
    countedOut,
  },
  read: {
    system: body => (body.systemInstruction as Content | undefined)?.parts[0]?.text,
    firstUser: body => contents(body).find(content => content.role === 'user')?.parts[0]?.text,
    temperature: body => generationConfig(body)?.temperature,
    maxTokens: body => generationConfig(body)?.maxOutputTokens,
  },
  thinking: {
    read: body => generationConfig(body)?.thinkingConfig,
    extraBody: {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
    lowersTo: 'low',
  },
  jsonMode: {
    read: body => generationConfig(body)?.responseMimeType,
    extraBody: {
      generationConfig: { responseMimeType: 'text/plain' },
    },
  },
  streams: false,
  streamFields: {},
  streamed: reply => jsonReply(reply),
  reservedBodyKeys: ['contents', 'systemInstruction'],
  toolBodyKeys: ['tools', 'toolConfig', 'cachedContent'],
  replyLimitPaths: [
    ['generationConfig', 'maxOutputTokens'],
  ],
  structuredOutputs: ['prompt', 'json', 'schema'],
  mergeProbe: {
    extraBody: {
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'low' },
      },
    },
    merged: {
      generationConfig: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'low' },
      },
    },
  },
})

describe('gemini', () => {
  const options = {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-3.8-flash',
    contextTokens: 131072,
    apiKey: 'AIza-k',
  }
  const provider = gemini(options)
  const conversation = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'data' },
        ],
      },
    ],
    systemInstruction: {
      parts: [
        { text: 'instructions' },
      ],
    },
  }

  it.each([
    ['low', 'LOW'],
    ['off', 'MINIMAL'],
  ] as const)('sends thinking %s as its protocol\'s control', async (thinking, level) => {
    const fetchMock = stubFetch(generateContentResponse)
    const provider = gemini({ ...options, thinking })
    await provider.complete(request)
    expect(generationConfig(sent(fetchMock).body)?.thinkingConfig).toEqual({ thinkingLevel: level })
    expect(provider.thinking).toBe(thinking)
  })

  it('posts the conversation, the system instruction and JSON mode to the model\'s generateContent, with the key in x-goog-api-key', async () => {
    const fetchMock = stubFetch(generateContentResponse)
    await provider.complete(request)
    const { url, headers, body } = sent(fetchMock)
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
    expect(headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': 'AIza-k' })
    expect(body).toEqual({
      ...conversation,
      generationConfig: { maxOutputTokens: 16_000, responseMimeType: 'application/json' },
    })
  })

  it.each([
    [
      'schema',
      {},
      {
        maxOutputTokens: 16_000,
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
      },
    ],
    [
      'prompt',
      { temperature: 0.3, maxTokens: 900 },
      { temperature: 0.3, maxOutputTokens: 900 },
    ],
  ] as const)('maps structuredOutput %s, with the options %j, to its generationConfig', async (structuredOutput, set, config) => {
    const fetchMock = stubFetch(generateContentResponse)
    await gemini({
      ...options,
      ...set,
      structuredOutput,
    }).complete(request)
    expect(sent(fetchMock).body).toEqual({ ...conversation, generationConfig: config })
  })

  it('sends maxOutputTokens 16000 alone when nothing else sets the generation config', async () => {
    const fetchMock = stubFetch(generateContentResponse)
    await gemini({ ...options, structuredOutput: 'prompt' }).complete(request)
    expect(sent(fetchMock).body).toEqual({
      ...conversation,
      generationConfig: { maxOutputTokens: 16_000 },
    })
  })

  it('sends an assistant message with the role model', async () => {
    const fetchMock = stubFetch(generateContentResponse)
    await provider.complete({
      ...request,
      messages: [
        { role: 'user', content: 'data' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'more' },
      ],
    })
    expect(contents(sent(fetchMock).body)).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'data' },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'reply' },
        ],
      },
      {
        role: 'user',
        parts: [
          { text: 'more' },
        ],
      },
    ])
  })

  it('takes the model id with or without a leading models/', async () => {
    const fetchMock = stubFetch(generateContentResponse)
    const prefixed = gemini({ ...options, model: 'models/gemini-3.8-flash' })
    await prefixed.complete(request)
    expect(sent(fetchMock).url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
    expect(prefixed.model).toBe('models/gemini-3.8-flash')
  })

  it.each([
    ['tunedModels/sentence-translator-u3b7m'],
    ['models/'],
    [''],
    ['models/models/gemini-3.8-flash'],
    ['gemini/../x'],
    ['-gemini'],
    ['gemini 3.8'],
    ['gemini-3.8-flash:streamGenerateContent'],
    ['gemini?alt=sse'],
    [7],
  ])('refuses the model %j, which is not a Gemini model id, without repeating it', (model) => {
    expect(() => gemini({ ...options, model } as unknown as GeminiOptions)).toThrow(new ConfigError([
      { path: 'gemini.model', message: 'must be a Gemini model id, such as gemini-3.8-flash' },
    ]))
  })

  it('refuses a key query parameter in any letter case, which would put a key in the URL', () => {
    expect(() => gemini({
      ...options,
      query: { KEY: 'x' },
    })).toThrow(new ConfigError([
      { path: 'gemini.query.KEY', message: 'would carry a key in the URL: set apiKey instead' },
    ]))
  })

  it('refuses a generationConfig that is no object, which would replace the one the adapter writes, with the path and no value', () => {
    for (const [key, value] of [
      ['generationConfig', null],
      ['GenerationConfig', 0],
      ['generation_config', 'zz-value'],
      [
        'GENERATION_CONFIG',
        ['zz-value'],
      ],
    ] as const) {
      expect(() => gemini({
        ...options,
        extraBody: { [key]: value },
      }), key).toThrow(new ConfigError([
        { path: `gemini.extraBody.${key}`, message: 'must be an object' },
      ]))
    }
  })

  it('refuses the reply limit under the snake_case names proto JSON takes', () => {
    expect(() => gemini({
      ...options,
      extraBody: {
        generationConfig: { max_output_tokens: 1, temperature: 0 },
      },
    })).toThrow(new ConfigError([
      { path: 'gemini.extraBody.generationConfig.max_output_tokens', message: 'sets the reply limit: use maxTokens' },
    ]))
    expect(() => gemini({
      ...options,
      extraBody: {
        generation_config: { max_output_tokens: 1, temperature: 0 },
      },
    })).toThrow(new ConfigError([
      { path: 'gemini.extraBody.generation_config.max_output_tokens', message: 'sets the reply limit: use maxTokens' },
      { path: 'gemini.extraBody.generation_config', message: 'must be written generationConfig' },
    ]))
  })

  it('refuses a spelling of generationConfig other than the one the adapter merges, which would send two keys', () => {
    for (const key of [
      'generation_config',
      'GenerationConfig',
      'GENERATION_CONFIG',
      'generationconfig',
    ]) {
      expect(() => gemini({
        ...options,
        extraBody: { [key]: {} },
      }), key).toThrow(new ConfigError([
        { path: `gemini.extraBody.${key}`, message: 'must be written generationConfig' },
      ]))
    }
    expect(() => gemini({
      ...options,
      extraBody: {
        generationConfig: { topK: 3 },
      },
    })).not.toThrow()
  })

  it('writes the canonical spelling and never the key it was given: a name that is not safe prints as *', () => {
    // A dotless i upper-cases to I, so this key reads as generationConfig to a server that folds case.
    const key = `generat${String.fromCharCode(0x131)}onConfig`
    expect(() => gemini({
      ...options,
      extraBody: { [key]: {} },
    })).toThrow(new ConfigError([
      { path: 'gemini.extraBody.*', message: 'must be written generationConfig' },
    ]))
  })

  it('prints a key query name that is not a safe name as *', () => {
    const kelvinKey = `${String.fromCharCode(0x212A)}ey`
    expect(() => gemini({
      ...options,
      query: { [kelvinKey]: 'x' },
    })).toThrow(new ConfigError([
      { path: 'gemini.query.*', message: 'would carry a key in the URL: set apiKey instead' },
    ]))
  })

  it('returns the parts that are not thoughts, joined, with the model version and the usage', async () => {
    stubFetch(withThoughts)
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{"keep":false,"reasoning":"r"}',
      model: 'gemini-3.8-flash',
      usage: { inputTokens: 1840, outputTokens: 340 },
      reasoning: true,
    })
  })

  it('counts the thought tokens as output, when the reply names them', async () => {
    stubFetch({
      candidates: [candidate],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 30 },
    })
    await expect(provider.complete(request)).resolves.toMatchObject({
      usage: { inputTokens: 10, outputTokens: 34 },
    })
    stubFetch({
      candidates: [candidate],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
    })
    await expect(provider.complete(request)).resolves.toMatchObject({
      usage: { inputTokens: 10, outputTokens: 4 },
    })
  })

  it('falls back to the configured model, and reports no usage, when the reply names neither', async () => {
    stubFetch({
      candidates: [candidate],
      modelVersion: '',
      usageMetadata: { candidatesTokenCount: 4 },
    })
    await expect(provider.complete(request)).resolves.toEqual({
      text: '{}',
      model: 'gemini-3.8-flash',
      usage: undefined,
      reasoning: false,
    })
  })

  it('carries the counts of a thinking model cut off while it thinks, reading the candidates count it leaves out as 0', async () => {
    stubFetch(thoughtsOnlyCutOff)
    await expect(provider.complete(request)).rejects.toMatchObject({
      kind: 'truncated',
      noAnswer: 'thinking',
      usage: { inputTokens: 1124, outputTokens: 47 },
      message: 'gemini: a reply was cut off at 47 tokens, below the 16000 quorum asked for: the server caps replies near 47: set maxTokens: 47',
    })
  })

  it('reads a candidates count a reply leaves out as 0, and needs the prompt count', async () => {
    stubFetch(promptBlocked)
    await expect(provider.complete(request)).rejects.toMatchObject({
      kind: 'refusal',
      usage: { inputTokens: 1840, outputTokens: 0 },
    })
    stubFetch({
      candidates: [candidate],
      usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 5 },
    })
    await expect(provider.complete(request)).resolves.toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    for (const usageMetadata of [
      { candidatesTokenCount: 3 },
      { promptTokenCount: 10, candidatesTokenCount: null },
    ]) {
      stubFetch({
        candidates: [candidate],
        usageMetadata,
      })
      const reply = await provider.complete(request)
      expect(reply.usage, JSON.stringify(usageMetadata)).toBeUndefined()
    }
  })

  const { finishReason: _finishReason, ...unfinished } = candidate
  const ending = (finishReason: unknown): Body => ({
    ...generateContentResponse,
    candidates: [
      { ...candidate, finishReason },
    ],
  })
  const safety = [
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
  ]

  it.each<[ProviderErrorKind, unknown, string]>([
    ['refusal', promptBlocked, 'gemini: prompt was blocked: "PROHIBITED_CONTENT"'],
    [
      'refusal',
      {
        promptFeedback: { blockReason: 'Not A Reason' },
      },
      'gemini: prompt was blocked',
    ],
    [
      'refusal',
      {
        promptFeedback: {
          blockReason: 'A'.repeat(64),
        },
      },
      `gemini: prompt was blocked: "${'A'.repeat(64)}"`,
    ],
    [
      'refusal',
      {
        promptFeedback: {
          blockReason: 'A'.repeat(65),
        },
      },
      'gemini: prompt was blocked',
    ],
    [
      'refusal',
      {
        promptFeedback: { blockReason: 1 },
        candidates: [candidate],
      },
      'gemini: prompt was blocked',
    ],
    [
      'invalid-response',
      { promptFeedback: {} },
      'gemini: reply has no candidates',
    ],
    [
      'invalid-response',
      { candidates: [] },
      'gemini: reply has no candidates',
    ],
    [
      'invalid-response',
      {
        candidates: [null],
      },
      'gemini: reply has no candidates',
    ],
    [
      'invalid-response',
      { candidates: 'x' },
      'gemini: reply has no candidates',
    ],
    ['truncated', truncated, 'gemini: a reply was cut off at 340 tokens, below the 16000 quorum asked for: the server caps replies near 340: set maxTokens: 340'],
    [
      'truncated',
      ending('CONTINUATION'),
      'gemini: a reply was cut off at 340 tokens, below the 16000 quorum asked for: the server caps replies near 340: set maxTokens: 340',
    ],
    ...safety.map((reason): [ProviderErrorKind, unknown, string] => [
      'refusal',
      ending(reason),
      'gemini: reply was stopped by the safety filter',
    ]),
    [
      'invalid-response',
      {
        candidates: [unfinished],
      },
      'gemini: reply has not finished',
    ],
    [
      'invalid-response',
      ending(null),
      'gemini: reply has not finished',
    ],
    [
      'invalid-response',
      ending('MALFORMED_FUNCTION_CALL'),
      'gemini: reply ended early: "MALFORMED_FUNCTION_CALL"',
    ],
    [
      'invalid-response',
      ending('OTHER'),
      'gemini: reply ended early: "OTHER"',
    ],
    [
      'invalid-response',
      ending(1),
      'gemini: reply ended early',
    ],
    [
      'no-answer',
      {
        candidates: [
          {
            ...candidate,
            content: {
              parts: [
                { text: '{}', thought: true },
              ],
            },
          },
        ],
      },
      'gemini: reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt',
    ],
    [
      'no-answer',
      {
        candidates: [
          {
            ...candidate,
            content: {
              parts: [
                { thoughtSignature: 'CiQB' },
                {
                  functionCall: { name: 'f' },
                },
              ],
            },
          },
        ],
      },
      'gemini: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
    [
      'no-answer',
      {
        candidates: [
          { ...candidate, content: undefined },
        ],
      },
      'gemini: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
    ['invalid-response', [], 'gemini: reply is not a JSON object'],
  ])('maps a %s reply to a ProviderError with its exact message', async (kind, body, expected) => {
    stubFetch(body)
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'ProviderError',
      kind,
      retryable: false,
      providerId: 'gemini',
      message: expected,
    })
  })

  it('reads a STOP with only thought parts as no-answer thinking, and the thought tokens alone as reasoning, quoting none of it', async () => {
    stubFetch(reasoningOnly)
    const failed = await provider.complete(request).catch((error: unknown) => error)
    expect(failed).toMatchObject({
      name: 'ProviderError',
      kind: 'no-answer',
      noAnswer: 'thinking',
      usage: { inputTokens: 1840, outputTokens: 340 },
    })
    expect(JSON.stringify(failed)).not.toContain('bound parameter')
    expect((failed as Error).message).not.toContain('bound parameter')
    stubFetch({
      ...empty,
      usageMetadata: { promptTokenCount: 1840, thoughtsTokenCount: 90 },
    })
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'no-answer', noAnswer: 'thinking' })
  })

  describe('on a 429', () => {
    const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo'
    const QUOTA_FAILURE = 'type.googleapis.com/google.rpc.QuotaFailure'
    const exhausted = (details: unknown): unknown => ({
      error: {
        code: 429,
        message: 'Resource exhausted',
        status: 'RESOURCE_EXHAUSTED',
        details,
      },
    })
    const retryInfo = (retryDelay: string): unknown => ({ '@type': RETRY_INFO, retryDelay })
    const quotaFailure = (quotaId: string): unknown => ({
      '@type': QUOTA_FAILURE,
      violations: [
        { quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId },
      ],
    })
    const failure = async (details: unknown): Promise<unknown> => {
      stubFetch(exhausted(details), 429)
      return await provider.complete(request).catch((caught: unknown) => caught)
    }

    it.each([
      ['42s', 42_000],
      ['1.5s', 1500],
      ['0s', undefined],
      ['42', undefined],
      ['-1s', undefined],
      ['1m', undefined],
      ['1.0000000001s', undefined],
    ])('reads the RetryInfo retryDelay %j', async (retryDelay, expected) => {
      const error = await failure([
        retryInfo(retryDelay),
      ]) as ProviderError
      expect(error).toMatchObject({ kind: 'http', status: 429, retryable: true })
      expect(error.retryAfterMs).toBe(expected)
    })

    it('never retries a 429 of a per-day quota, whatever its RetryInfo says, and retries a per-minute one', async () => {
      expect(await failure([
        quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
        retryInfo('34s'),
      ])).toMatchObject({ retryable: false, retryAfterMs: 34_000 })
      expect(await failure([
        quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
        retryInfo('34s'),
      ])).toMatchObject({ retryable: true, retryAfterMs: 34_000 })
    })

    it('reads no hint from details that are no list, or entries of another type', async () => {
      for (const details of [
        {},
        [
          { '@type': 'type.googleapis.com/google.rpc.Help' },
        ],
      ]) {
        const error = await failure(details) as ProviderError
        expect(error, JSON.stringify(details)).toMatchObject({ retryable: true })
        expect(error.retryAfterMs, JSON.stringify(details)).toBeUndefined()
      }
    })
  })

  it('redacts the key from a block reason it quotes', async () => {
    stubFetch({
      promptFeedback: { blockReason: 'KEY_IN_REASON' },
    })
    await expect(gemini({ ...options, apiKey: 'KEY_IN_REASON' }).complete(request)).rejects.toMatchObject({ message: 'gemini: prompt was blocked: "[redacted]"' })
  })

  it('quotes the error body of a non-2xx reply, and reports a 402 as not retryable for a depleted prepay balance', async () => {
    stubFetch(invalidKey, 400)
    await expect(provider.complete(request)).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      retryable: false,
      message: `gemini: HTTP 400: ${JSON.stringify(JSON.stringify(invalidKey))}`,
    })
    stubFetch({
      error: { code: 402, message: 'prepay balance depleted', status: 'RESOURCE_EXHAUSTED' },
    }, 402)
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'http', status: 402, retryable: false })
  })

  it.each([
    [
      'a per-day QuotaFailure',
      429,
      {
        error: {
          code: 429,
          message: 'Resource exhausted',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                { quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' },
              ],
            },
          ],
        },
      },
    ],
    [
      'the code quota_exceeded',
      429,
      {
        error: { code: 'quota_exceeded', message: 'You have exceeded your daily quota' },
      },
    ],
    [
      'the code payment_required',
      402,
      {
        error: { code: 'payment_required', message: 'credits' },
      },
    ],
  ])('marks %s as a used-up quota, never retried', async (_name, status, body) => {
    stubFetch(body, status)
    await expect(provider.complete(request)).rejects.toMatchObject({ status, retryable: false, exhausted: true })
  })

  it('leaves a per-minute quota, and a 402 whose code is its status, to the status', async () => {
    stubFetch({
      error: {
        code: 429,
        message: 'Resource exhausted',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              { quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' },
            ],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' },
        ],
      },
    }, 429)
    await expect(provider.complete(request)).rejects.toMatchObject({ retryable: true, retryAfterMs: 7000, exhausted: false })
    stubFetch({
      error: { code: 402, message: 'x', status: 'FAILED_PRECONDITION' },
    }, 402)
    await expect(provider.complete(request)).rejects.toMatchObject({ retryable: false, exhausted: false })
  })
})

describe('gemini on a 400 that names its structured-output field', () => {
  const failure = async (body: string, status: number, options: Partial<GeminiOptions> = {}): Promise<unknown> => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, status)))
    return gemini({
      id: 'p',
      baseUrl: 'https://h.example',
      model: 'gemini-3.8-flash',
      contextTokens: 8192,
      maxTokens: 1000,
      ...options,
    }).complete(request).catch((caught: unknown) => caught)
  }

  it('marks a 400 that names responseMimeType or responseJsonSchema as refused for its structured output, quoting nothing', async () => {
    for (const field of [
      'responseMimeType',
      'responseJsonSchema',
      'response_mime_type',
      'response_json_schema',
    ]) {
      const error = await failure(`{"error":{"message":"Invalid JSON payload received. Unknown name \\"${field}\\" at 'generation_config'"}}`, 400)
      expect(error, field).toMatchObject({ kind: 'http', status: 400, refused: 'structuredOutput' })
      expect(Object.entries(error as object).filter(([key, value]) => key !== 'message' && key !== 'name' && typeof value === 'string').flatMap(([, value]) => value as string), field).toEqual(['p', 'http', 'structuredOutput'])
    }
    expect(await failure('{"error":{"message":"thinkingLevel is not supported"}}', 400)).toMatchObject({ refused: undefined })
    expect(await failure('{"error":{"message":"responseMimeType is bad"}}', 403)).toMatchObject({ refused: undefined })
    expect(await failure('{"error":{"message":"responseMimeType is bad"}}', 400, { structuredOutput: 'prompt' })).toMatchObject({ refused: undefined })
    expect(await failure('{"error":{"message":"responseMimeTypes"}}', 400)).toMatchObject({ refused: undefined })
  })
})
