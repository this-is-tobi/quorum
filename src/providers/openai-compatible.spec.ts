import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { openaiCompatible } from './openai-compatible.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [{ role: 'user', content: 'data' }],
  output: { name: 'panel_vote', schema: { type: 'object' } },
}

const ok = { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }

function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
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

  it('sends no authorization header without a key or with an empty one, and a bearer token with one', async () => {
    const fetchMock = stubFetch(ok)
    await provider.complete(request)
    await openaiCompatible({ id: 'x', baseUrl: 'http://h/v1', model: 'm', apiKey: '' }).complete(request)
    await openaiCompatible({ id: 'x', baseUrl: 'http://h/v1', model: 'm', apiKey: 'sk-test' }).complete(request)
    expect(sent(fetchMock, 0).headers).not.toHaveProperty('authorization')
    expect(sent(fetchMock, 1).headers).not.toHaveProperty('authorization')
    expect(sent(fetchMock, 2).headers).toMatchObject({ authorization: 'Bearer sk-test' })
  })

  it('sends the key in the authorization header only: not in the URL, another header or the body', async () => {
    const fetchMock = stubFetch(ok)
    await openaiCompatible({ id: 'x', baseUrl: 'http://h/v1', model: 'm', apiKey: 'sk-test' }).complete(request)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://h/v1/chat/completions')
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-test' })
    expect(init.body).not.toContain('sk-test')
  })

  it('refuses a key with a character outside visible ASCII, which an HTTP header cannot carry, without repeating it', () => {
    const keys = [`sk-test${String.fromCharCode(10)}`, 'sk test', `sk-t${String.fromCharCode(0)}est`, `sk-t${String.fromCharCode(127)}est`, `sk-t${String.fromCharCode(0x200B)}est`]
    for (const key of keys) {
      const build = (): unknown => openaiCompatible({ id: 'research', baseUrl: 'http://h/v1', model: 'm', apiKey: key })
      expect(build, JSON.stringify(key)).toThrow(ConfigError)
      expect(build, JSON.stringify(key)).toThrow(/research\.apiKey/)
      expect(build, JSON.stringify(key)).not.toThrow(/sk-/)
    }
  })

  it('refuses a base URL that is not an http:// or https:// URL with a host, without repeating it', () => {
    for (const baseUrl of ['localhost:11434/v1', 'ftp://h/v1', '/v1', '', 'https:///v1', 'http://', 'https://user:secret@/v1', 'ftp://user:secret@h/v1']) {
      const build = (): unknown => openaiCompatible({ id: 'research', baseUrl, model: 'm' })
      expect(build, baseUrl).toThrow(ConfigError)
      expect(build, baseUrl).toThrow(/research\.baseUrl/)
      expect(build, baseUrl).not.toThrow(/secret/)
    }
    expect(() => openaiCompatible({ id: 'research', baseUrl: 'http://[::1]:11434/v1', model: 'm' })).not.toThrow()
  })

  it('omits temperature when configured as null and sends any other number as given', async () => {
    const fetchMock = stubFetch(ok)
    await openaiCompatible({ id: 'x', baseUrl: 'http://h/v1', model: 'm', temperature: null }).complete(request)
    await openaiCompatible({ id: 'x', baseUrl: 'http://h/v1', model: 'm', temperature: 0.7 }).complete(request)
    expect(sent(fetchMock, 0).body).not.toHaveProperty('temperature')
    expect(sent(fetchMock, 1).body).toMatchObject({ temperature: 0.7 })
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

  it('redacts the key from an HTTP error body that echoes it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid key sk-secret' }))
    const keyed = openaiCompatible({ id: 'local', baseUrl: 'http://h/v1', model: 'm', apiKey: 'sk-secret' })
    await expect(keyed.complete(request)).rejects.toMatchObject({ kind: 'http', message: 'local: HTTP 401: "invalid key [redacted]"' })
  })

  it('passes the abort signal to fetch', async () => {
    const fetchMock = stubFetch(ok)
    const signal = new AbortController().signal
    await provider.complete({ ...request, signal })
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal)
  })
})
