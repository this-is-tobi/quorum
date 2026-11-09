import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../core/errors.ts'
import { brokenReply, jsonReply, streamedReply, textReply } from '../testing/http.ts'
import { endpointUrl, originOf, postJson, redactionsOf, snippet } from './http.ts'

const options = { providerId: 'p', url: 'http://h/x', body: {} }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('snippet', () => {
  it('redacts every occurrence of the secret before cutting, so a key cut in half cannot survive', () => {
    expect(snippet('bad token: Bearer sk-secret', 100, ['sk-secret'])).toBe('"bad token: Bearer [redacted]"')
    expect(snippet('sk-secret and sk-secret', 100, ['sk-secret'])).toBe('"[redacted] and [redacted]"')
    expect(snippet(`${'a'.repeat(496)}sk-secret`, 500, ['sk-secret'])).not.toContain('sk-')
  })

  it('redacts the secret as a JSON string would carry it, with or without escaped slashes', () => {
    const secret = 'sk-a/b"c'
    for (const echoed of [secret, 'sk-a/b\\"c', 'sk-a\\/b"c', 'sk-a\\/b\\"c']) {
      expect(snippet(`invalid key ${echoed}!`, 100, [secret]), echoed).toBe('"invalid key [redacted]!"')
    }
  })

  it('redacts the secret when a server writes some of its characters as unicode escapes', () => {
    const backslash = String.fromCharCode(92)
    const echoed = `sk-a${backslash}u0026b${backslash}u002Bc`
    expect(snippet(`bad key ${echoed}`, 100, ['sk-a&b+c'])).toBe('"bad key [redacted]"')
  })

  it('redacts a value that holds an escape as written, before the escapes are decoded, and every value in the list', () => {
    const backslash = String.fromCharCode(92)
    const key = `sk-x${backslash}u0041y`
    expect(snippet(`bad key ${key} on /tok3n/v1`, 100, [key, '/tok3n/v1'])).toBe('"bad key [redacted] on [redacted]"')
  })

  it('cuts to the given length and writes one JSON string, so a line break stays on one line', () => {
    const text = `bad\n::error::forged${String.fromCharCode(27)}[2K`
    expect(snippet(text, 100)).toBe(JSON.stringify(text))
    expect(snippet('x'.repeat(1000), 10)).toBe(`"${'x'.repeat(10)}"`)
  })
})

describe('originOf', () => {
  it('keeps the scheme, host and port and drops credentials, path, query and fragment', () => {
    expect(originOf('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(originOf('https://user:pw-secret@h.example/token-secret/v1?key=q-secret#frag')).toBe('https://h.example')
  })

  it('names the endpoint when the URL does not parse or has no http origin', () => {
    expect(originOf('not a url')).toBe('the endpoint')
    expect(originOf('localhost:11434/v1')).toBe('the endpoint')
    expect(originOf('data:text/plain,secret')).toBe('the endpoint')
  })
})

describe('redactionsOf', () => {
  it('lists the key and the base URL path, as written and decoded, without trailing slashes', () => {
    expect(redactionsOf('https://h/tok%20en/v1//', 'sk-1')).toEqual(['sk-1', '/tok%20en/v1', '/tok en/v1'])
  })

  it('lists every value of the caller\'s headers too, once, and no empty one', () => {
    expect(redactionsOf('https://h/v1', 'sk-1', { 'X-Gateway-Token': 'gw-tok-1', 'X-Team': '', 'X-Copy': 'sk-1' })).toEqual(['sk-1', '/v1', 'gw-tok-1'])
  })

  it('lists nothing for a URL without a path and no key', () => {
    expect(redactionsOf('http://localhost:11434', undefined)).toEqual([])
    expect(redactionsOf('http://localhost:11434/', '')).toEqual([])
  })
})

describe('endpointUrl', () => {
  it('drops trailing slashes, appends the path and adds the query only when it has parameters', () => {
    expect(endpointUrl('http://h/v1//', '/chat/completions')).toBe('http://h/v1/chat/completions')
    expect(endpointUrl('http://h/v1', '/chat/completions', {})).toBe('http://h/v1/chat/completions')
    expect(endpointUrl('http://h', '/api/chat', { 'api-version': '1' })).toBe('http://h/api/chat?api-version=1')
  })
})

describe('postJson', () => {
  it('sends the body as JSON with the given headers and signal, without following redirects, and returns the parsed reply', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonReply({ answer: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    await expect(postJson({ ...options, headers: { authorization: 'Bearer k' }, body: { a: 1 }, signal })).resolves.toEqual({ answer: 1 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://h/x')
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: '{"a":1}', redirect: 'manual', signal })
  })

  it('reports a redirect as an http error that is not retried, so a key never reaches another endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('moved', 307)))
    const error = await postJson(options).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: 'http', status: 307, retryable: false, message: 'p: HTTP 307 (redirects are not followed): "moved"' })
  })

  it('refuses a reply body over 16 MiB, and reads no more of it', async () => {
    const { response, pulled } = streamedReply('x'.repeat(1024 * 1024), 64)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response))
    await expect(postJson(options)).rejects.toMatchObject({ kind: 'invalid-response', retryable: false, message: 'p: reply body is over 16 MiB' })
    expect(pulled()).toBeLessThan(20)
  })

  it('decodes a character whose bytes arrive in two chunks', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: `caf${String.fromCharCode(0xE9)} ${String.fromCodePoint(0x1F600)}` }))
    const cut = bytes.length - 4
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut))
        controller.enqueue(bytes.slice(cut))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(body, { status: 200 })))
    await expect(postJson(options)).resolves.toEqual({ text: `caf${String.fromCharCode(0xE9)} ${String.fromCodePoint(0x1F600)}` })
  })

  it('reads no more than 64 KiB of an error body', async () => {
    const { response, pulled } = streamedReply('e'.repeat(16 * 1024), 1000, 500)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response))
    await expect(postJson(options)).rejects.toMatchObject({ kind: 'http', status: 500, message: `p: HTTP 500: ${JSON.stringify('e'.repeat(500))}` })
    expect(pulled()).toBeLessThan(10)
  })

  it('lets a body that cannot be serialized fail as a programming error, before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const error = await postJson({ ...options, body: { n: 1n } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(ProviderError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('truncates the error body to 500 characters, writes it as one JSON string and marks 5xx as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('x'.repeat(10_000), 503)))
    const error = await postJson(options).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ kind: 'http', status: 503, retryable: true, message: `p: HTTP 503: ${JSON.stringify('x'.repeat(500))}` })
    expect((error as Error).cause).toBeUndefined()
  })

  it('does not mark client errors as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('bad request', 400)))
    await expect(postJson(options)).rejects.toMatchObject({ kind: 'http', status: 400, retryable: false })
  })

  it('quotes, rather than strips, the control characters of an error body', async () => {
    const body = `bad\n::error::forged${String.fromCharCode(27)}[2K`
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, 400)))
    await expect(postJson(options)).rejects.toMatchObject({ message: `p: HTTP 400: ${JSON.stringify(body)}` })
  })

  it('redacts the key from an error body that echoes it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('bad token: Bearer sk-secret', 401)))
    await expect(postJson({ ...options, redact: ['sk-secret'] })).rejects.toMatchObject({ message: 'p: HTTP 401: "bad token: Bearer [redacted]"' })
  })

  it('still reports the status when the error body cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => brokenReply(new Error('stream error'), 502)))
    await expect(postJson(options)).rejects.toMatchObject({ kind: 'http', status: 502, message: 'p: HTTP 502: ""' })
  })

  it('never copies the runtime error text, which can hold the URL with its credentials', async () => {
    const url = 'https://user:pw-secret@api.example.com/v1/x?key=q-secret'
    const cause = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`, { cause })))
    const error = await postJson({ ...options, url }).catch((caught: Error) => caught) as Error
    expect(error).toMatchObject({ kind: 'network', retryable: true, message: 'p: request to https://api.example.com failed (ECONNREFUSED)' })
    expect(error.cause).toBeUndefined()
  })

  it('never copies the runtime error text, which can hold an invalid header value with the key', async () => {
    const header = `Bearer sk-secret${String.fromCharCode(10)}X`
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`Headers.append: "${header}" is an invalid header value.`)))
    const error = await postJson({ ...options, headers: { authorization: header } }).catch((caught: Error) => caught) as Error
    expect(error.message).toBe('p: request to http://h failed')
  })

  it('names the code of the error itself, as Bun reports it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('Unable to connect'), { code: 'ECONNREFUSED' })))
    await expect(postJson(options)).rejects.toMatchObject({ kind: 'network', message: 'p: request to http://h failed (ECONNREFUSED)' })
  })

  it.each([
    ['not an identifier'],
    ['1ECONNREFUSED'],
    ['A'.repeat(41)],
  ])('ignores the error code %j, which is not a plain identifier', async (code) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code })))
    await expect(postJson(options)).rejects.toMatchObject({ kind: 'network', message: 'p: request to http://h failed' })
  })

  it('still reports a network failure when reading the error code throws', async () => {
    const hostile = new TypeError('fetch failed')
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('boom')
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(hostile))
    await expect(postJson(options)).rejects.toMatchObject({ name: 'ProviderError', kind: 'network', message: 'p: request to http://h failed' })
  })

  it.each([['not a url'], ['localhost:11434/v1']])('names the endpoint when the URL %j has no http origin', async (url) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(postJson({ ...options, url })).rejects.toMatchObject({ kind: 'network', message: 'p: request to the endpoint failed' })
  })

  it('reports a request aborted before the call as aborted, not as a network failure', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')))
    await expect(postJson({ ...options, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', retryable: false, message: 'p: request aborted' })
  })

  it('reports a request aborted while in flight as aborted', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }))
    await expect(postJson({ ...options, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', retryable: false })
  })

  it('reports a connection lost while the reply is read as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => brokenReply(new TypeError('terminated'))))
    const error = await postJson(options).catch((caught: Error) => caught) as Error
    expect(error).toMatchObject({ kind: 'network', retryable: true, message: 'p: reading the reply from http://h failed' })
    expect(error.cause).toBeUndefined()
  })

  it('reports a request aborted while its reply is read as aborted', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => brokenReply(new DOMException('aborted', 'AbortError'), 200, () => controller.abort())))
    await expect(postJson({ ...options, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', message: 'p: request aborted' })
  })

  it('rejects a success response whose body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('<html>not json</html>', 200)))
    const error = await postJson(options).catch((caught: Error) => caught) as Error
    expect(error).toMatchObject({ kind: 'invalid-response', retryable: false, message: 'p: response body is not JSON' })
    expect(error.cause).toBeUndefined()
  })
})
