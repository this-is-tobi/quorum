import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { jsonReply } from '../testing/http.ts'
import { gemini } from './gemini.ts'
import type { GeminiOptions } from './gemini.ts'
import { candidate, generateContentResponse, invalidKey, promptBlocked, truncated, withThoughts } from '../testing/fixtures/gemini.ts'
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
interface Content { role?: string, parts: Array<{ text: string }> }
const contents = (body: Body): Content[] => body.contents as Content[]
const generationConfig = (body: Body): Body | undefined => body.generationConfig as Body | undefined

describeProviderContract({
  protocol: 'gemini',
  make: options => gemini(options),
  fixedHeaders: {},
  defaultKeyHeader: key => ['x-goog-api-key', key],
  replies: { ok: generateContentResponse, model: 'gemini-3.8-flash', usage: { inputTokens: 1840, outputTokens: 340 }, refusal: promptBlocked, truncated },
  read: {
    system: body => (body.systemInstruction as Content | undefined)?.parts[0]?.text,
    firstUser: body => contents(body).find(content => content.role === 'user')?.parts[0]?.text,
    temperature: body => generationConfig(body)?.temperature,
    maxTokens: body => generationConfig(body)?.maxOutputTokens,
  },
  reservedBodyKeys: ['contents', 'systemInstruction'],
  toolBodyKeys: ['tools', 'toolConfig', 'cachedContent'],
  structuredOutputs: ['prompt', 'json', 'schema'],
  mergeProbe: {
    extraBody: { generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } },
    merged: { generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } } },
  },
})

describe('gemini', () => {
  const options = { id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.8-flash', apiKey: 'AIza-k' }
  const provider = gemini(options)
  const conversation = { contents: [{ role: 'user', parts: [{ text: 'data' }] }], systemInstruction: { parts: [{ text: 'instructions' }] } }

  it('posts the conversation, the system instruction and JSON mode to the model\'s generateContent, with the key in x-goog-api-key', async () => {
    const fetchMock = stubFetch(generateContentResponse)
    await provider.complete(request)
    const { url, headers, body } = sent(fetchMock)
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
    expect(headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': 'AIza-k' })
    expect(body).toEqual({ ...conversation, generationConfig: { responseMimeType: 'application/json' } })
  })

  it.each([
    ['schema', {}, { responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } }],
    ['prompt', { temperature: 0.3, maxTokens: 900 }, { temperature: 0.3, maxOutputTokens: 900 }],
  ] as const)('maps structuredOutput %s, with the options %j, to its generationConfig', async (structuredOutput, set, config) => {
    const fetchMock = stubFetch(generateContentResponse)
    await gemini({ ...options, ...set, structuredOutput }).complete(request)
    expect(sent(fetchMock).body).toEqual({ ...conversation, generationConfig: config })
  })

  it('sends no generationConfig when it would be empty', async () => {
    const fetchMock = stubFetch(generateContentResponse)
    await gemini({ ...options, structuredOutput: 'prompt' }).complete(request)
    expect(sent(fetchMock).body).toEqual(conversation)
  })

  it('sends an assistant message with the role model', async () => {
    const fetchMock = stubFetch(generateContentResponse)
    await provider.complete({ ...request, messages: [{ role: 'user', content: 'data' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'more' }] })
    expect(contents(sent(fetchMock).body)).toEqual([
      { role: 'user', parts: [{ text: 'data' }] },
      { role: 'model', parts: [{ text: 'reply' }] },
      { role: 'user', parts: [{ text: 'more' }] },
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
    expect(() => gemini({ ...options, model } as unknown as GeminiOptions)).toThrow(new ConfigError([{ path: 'gemini.model', message: 'must be a Gemini model id, such as gemini-3.8-flash' }]))
  })

  it('returns the parts that are not thoughts, joined, with the model version and the usage', async () => {
    stubFetch(withThoughts)
    await expect(provider.complete(request)).resolves.toEqual({ text: '{"keep":false,"reasoning":"r"}', model: 'gemini-3.8-flash', usage: { inputTokens: 1840, outputTokens: 340 } })
  })

  it('counts the thought tokens as output, when the reply names them', async () => {
    stubFetch({ candidates: [candidate], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 30 } })
    await expect(provider.complete(request)).resolves.toMatchObject({ usage: { inputTokens: 10, outputTokens: 34 } })
    stubFetch({ candidates: [candidate], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } })
    await expect(provider.complete(request)).resolves.toMatchObject({ usage: { inputTokens: 10, outputTokens: 4 } })
  })

  it('falls back to the configured model, and reports no usage, when the reply names neither', async () => {
    stubFetch({ candidates: [candidate], modelVersion: '', usageMetadata: { promptTokenCount: 10 } })
    await expect(provider.complete(request)).resolves.toEqual({ text: '{}', model: 'gemini-3.8-flash', usage: undefined })
  })

  const { finishReason: _finishReason, ...unfinished } = candidate
  const ending = (finishReason: unknown): Body => ({ ...generateContentResponse, candidates: [{ ...candidate, finishReason }] })
  const safety = ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']

  it.each<[ProviderErrorKind, unknown, string]>([
    ['refusal', promptBlocked, 'gemini: prompt was blocked: "PROHIBITED_CONTENT"'],
    ['refusal', { promptFeedback: { blockReason: 'Not A Reason' } }, 'gemini: prompt was blocked'],
    ['refusal', { promptFeedback: { blockReason: 'A'.repeat(65) } }, 'gemini: prompt was blocked'],
    ['refusal', { promptFeedback: { blockReason: 1 }, candidates: [candidate] }, 'gemini: prompt was blocked'],
    ['invalid-response', { promptFeedback: {} }, 'gemini: reply has no candidates'],
    ['invalid-response', { candidates: [] }, 'gemini: reply has no candidates'],
    ['invalid-response', { candidates: [null] }, 'gemini: reply has no candidates'],
    ['invalid-response', { candidates: 'x' }, 'gemini: reply has no candidates'],
    ['truncated', truncated, 'gemini: reply was cut off by the token limit'],
    ['truncated', ending('CONTINUATION'), 'gemini: reply was cut off by the token limit'],
    ...safety.map((reason): [ProviderErrorKind, unknown, string] => ['refusal', ending(reason), 'gemini: reply was stopped by the safety filter']),
    ['invalid-response', { candidates: [unfinished] }, 'gemini: reply has not finished'],
    ['invalid-response', ending(null), 'gemini: reply has not finished'],
    ['invalid-response', ending('MALFORMED_FUNCTION_CALL'), 'gemini: reply ended early: "MALFORMED_FUNCTION_CALL"'],
    ['invalid-response', ending('OTHER'), 'gemini: reply ended early: "OTHER"'],
    ['invalid-response', ending(1), 'gemini: reply ended early'],
    ['invalid-response', { candidates: [{ ...candidate, content: { parts: [{ text: '{}', thought: true }] } }] }, 'gemini: reply has no text'],
    ['invalid-response', { candidates: [{ ...candidate, content: { parts: [{ thoughtSignature: 'CiQB' }, { functionCall: { name: 'f' } }] } }] }, 'gemini: reply has no text'],
    ['invalid-response', { candidates: [{ ...candidate, content: undefined }] }, 'gemini: reply has no text'],
    ['invalid-response', [], 'gemini: reply is not a JSON object'],
  ])('maps a %s reply to a ProviderError with its exact message', async (kind, body, expected) => {
    stubFetch(body)
    await expect(provider.complete(request)).rejects.toMatchObject({ name: 'ProviderError', kind, retryable: false, providerId: 'gemini', message: expected })
  })

  it('redacts the key from a block reason it quotes', async () => {
    stubFetch({ promptFeedback: { blockReason: 'KEY_IN_REASON' } })
    await expect(gemini({ ...options, apiKey: 'KEY_IN_REASON' }).complete(request)).rejects.toMatchObject({ message: 'gemini: prompt was blocked: "[redacted]"' })
  })

  it('quotes the error body of a non-2xx reply, and does not retry a 402 for a depleted prepay balance', async () => {
    stubFetch(invalidKey, 400)
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'http', status: 400, retryable: false, message: `gemini: HTTP 400: ${JSON.stringify(JSON.stringify(invalidKey))}` })
    stubFetch({ error: { code: 402, message: 'prepay balance depleted', status: 'RESOURCE_EXHAUSTED' } }, 402)
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'http', status: 402, retryable: false })
  })
})
