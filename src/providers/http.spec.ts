import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../core/errors.ts'
import type { CompletionResponse, StreamSignal } from '../core/ports.ts'
import { REDACTED } from '../core/result-schema.ts'
import { brokenReply, jsonReply, streamedReply, textReply } from '../testing/http.ts'
import { endpointUrl, httpOrigin, originOf, postStream, rateLimitOf, redactionsOf, replyOf, retryAfterHint, snippet } from './http.ts'
import type { ErrorHints } from './http.ts'
import type { StreamItem } from './stream.ts'

const options = {
  providerId: 'p',
  url: 'http://h/x',
  body: {},
  format: 'sse' as const,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('snippet', () => {
  it('redacts every occurrence of the secret before cutting, so a key cut in half cannot survive', () => {
    expect(snippet('bad token: Bearer sk-secret', 100, ['sk-secret'])).toBe('"bad token: Bearer [redacted]"')
    expect(snippet('sk-secret and sk-secret', 100, ['sk-secret'])).toBe('"[redacted] and [redacted]"')
    expect(snippet(`${'a'.repeat(496)}sk-secret`, 500, ['sk-secret'])).not.toContain('sk-')
  })

  it('redacts with the word a result writes in place of a value it cannot show, which the adapters hold as a copy of the core\'s', () => {
    expect(snippet('key sk-secret', 100, ['sk-secret'])).toBe(`"key ${REDACTED}"`)
  })

  it('redacts the secret as a JSON string would carry it, with or without escaped slashes', () => {
    const secret = 'sk-a/b"c'
    for (const echoed of [
      secret,
      'sk-a/b\\"c',
      'sk-a\\/b"c',
      'sk-a\\/b\\"c',
    ]) {
      expect(snippet(`invalid key ${echoed}!`, 100, [secret]), echoed).toBe('"invalid key [redacted]!"')
    }
  })

  it('redacts the secret when a server writes some of its characters as unicode escapes', () => {
    const backslash = String.fromCharCode(92)
    const echoed = `sk-a${backslash}u0026b${backslash}u002Bc`
    expect(snippet(`bad key ${echoed}`, 100, ['sk-a&b+c'])).toBe('"bad key [redacted]"')
  })

  it('redacts a value that holds an escape once both are decoded, and every value in the list', () => {
    const backslash = String.fromCharCode(92)
    const key = `sk-x${backslash}u0041y`
    expect(snippet(`bad key ${key} on /tok3n/v1`, 100, [key, '/tok3n/v1'])).toBe('"bad key [redacted] on [redacted]"')
  })

  it('redacts a value inside another as one, so the shorter never leaves the rest of the longer', () => {
    expect(snippet('bad key sk-secret', 100, ['sk', 'sk-secret'])).toBe('"bad key [redacted]"')
    expect(snippet('bad key sk-secret', 100, ['sk-secret', 'sec'])).toBe('"bad key [redacted]"')
  })

  it('redacts values that overlap in the text as one run, and every occurrence of a value, overlapping ones included', () => {
    expect(snippet('abc123xyz', 100, redactionsOf('https://h', 'abc123', { 'X-Gateway-Token': '123xyz' }))).toBe('"[redacted]"')
    expect(snippet('xaaay', 100, ['aa'])).toBe('"x[redacted]y"')
  })

  it('redacts values that overlap in the text as one run when the server escapes either of them', () => {
    const backslash = String.fromCharCode(92)
    const overlapping = redactionsOf('https://h', 'abc123', { 'X-Gateway-Token': '123+xyz' })
    expect(snippet(`abc123${backslash}u002Bxyz`, 100, overlapping)).toBe('"[redacted]"')
    expect(snippet(`ab${backslash}u002B123xyz`, 100, ['ab+123', '123xyz'])).toBe('"[redacted]"')
  })

  it('redacts a value that holds the marker text whole, even when the server escapes part of it', () => {
    const backslash = String.fromCharCode(92)
    expect(snippet(`x[redacted]${backslash}u0079`, 100, ['x[redacted]y'])).toBe('"[redacted]"')
  })

  it('cuts to the given length and writes one JSON string, so a line break stays on one line', () => {
    const text = `bad\n::error::forged${String.fromCharCode(27)}[2K`
    expect(snippet(text, 100)).toBe(JSON.stringify(text))
    expect(snippet('x'.repeat(1000), 10)).toBe(`"${'x'.repeat(10)}"`)
  })

  it('redacts each form of the text in one pass, so a marker it inserts is never matched again, even by single letters', () => {
    // 5461 repeats of 12 characters, the most that fit in the 64 KiB that snippet redacts
    const text = 'a dead end. '.repeat(5461)
    const expected = text.replace(/[ade]/g, '[redacted]')
    expect(snippet(text, expected.length, ['e', 'd', 'a'])).toBe(JSON.stringify(expected))
  })

  it('redacts only the first 64 KiB of a longer text, which is more than any quote shows', () => {
    expect(snippet(`${'x'.repeat(64 * 1024)}sk-secret`, 70_000, ['sk-secret'])).toBe(JSON.stringify('x'.repeat(64 * 1024)))
  })

  it('redacts an escaped echo next to a plain one as two runs, since ranges that only touch stay apart', () => {
    const backslash = String.fromCharCode(92)
    expect(snippet(`e${backslash}u0065`, 100, ['e'])).toBe('"[redacted][redacted]"')
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

describe('httpOrigin', () => {
  it('keeps the scheme, the host in lower case and a port that is not the default', () => {
    expect(httpOrigin('HTTPS://API.Groq.com:443/openai/v1?x=1#y')).toBe('https://api.groq.com')
    expect(httpOrigin('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(httpOrigin('http://[::1]:8080/v1')).toBe('http://[::1]:8080')
  })

  it('drops one trailing dot of the host, which names the same host', () => {
    expect(httpOrigin('https://api.groq.com./openai/v1')).toBe('https://api.groq.com')
  })

  it.each([
    ['userinfo, which is no part of an origin', 'https://user:pw-secret@h.example/v1', 'https://h.example'],
    ['the default port of http written out', 'http://h.example:80/v1', 'http://h.example'],
    ['the port of http that is the default of https', 'http://h.example:443/v1', 'http://h.example:443'],
    ['the port of https that is the default of http', 'https://h.example:80/v1', 'https://h.example:80'],
    ['a trailing dot with a port that is not the default', 'https://api.groq.com.:8443/v1', 'https://api.groq.com:8443'],
    ['a trailing dot with the default port', 'https://api.groq.com.:443/v1', 'https://api.groq.com'],
    ['a host that is only a dot, which keeps it', 'http://./v1', 'http://.'],
  ])('reads %s as one origin', (_name, url, origin) => {
    expect(httpOrigin(url)).toBe(origin)
  })

  it.each<[string, unknown]>([
    ['a text without a scheme', 'api.groq.com/v1'],
    ['another scheme', 'ws://h.example/v1'],
    ['an ftp URL', 'ftp://h.example/v1'],
    ['a blob URL, whose own origin is that of the URL inside it', 'blob:https://h.example/0b1d6d6e-0000-4000-8000-000000000000'],
    ['a file URL', 'file:///etc/hosts'],
    ['a number', 42],
    [
      'a String object',
      // eslint-disable-next-line no-new-wrappers, unicorn/new-for-builtins -- the input is a String object
      new String('https://h.example'),
    ],
    ['undefined', undefined],
  ])('gives %s no origin', (_name, url) => {
    expect(httpOrigin(url)).toBeUndefined()
  })
})

describe('redactionsOf', () => {
  it('lists the key and the base URL path, as written and decoded, without trailing slashes', () => {
    expect(redactionsOf('https://h/tok%20en/v1//', 'sk-1')).toEqual(['sk-1', '/tok%20en/v1', '/tok en/v1'])
  })

  it('lists a path with a stray % as written, since it cannot be decoded', () => {
    expect(redactionsOf('https://h/a%zz/v1', undefined)).toEqual(['/a%zz/v1'])
  })

  it('lists every value of the caller\'s headers too, once, and no empty one', () => {
    expect(redactionsOf('https://h/v1', 'sk-1', { 'X-Gateway-Token': 'gw-tok-1', 'X-Team': '', 'X-Copy': 'sk-1' })).toEqual(['sk-1', '/v1', 'gw-tok-1'])
  })

  it('lists each header value trimmed too, since fetch sends it trimmed and a server echoes that', () => {
    const redact = redactionsOf('https://h', undefined, { 'X-Gateway-Token': ' gw-tok-1  ' })
    expect(redact).toEqual([' gw-tok-1  ', 'gw-tok-1'])
    expect(snippet('token gw-tok-1 refused', 100, redact)).toBe('"token [redacted] refused"')
  })

  it('lists no header value that is blank once trimmed, so a header of spaces redacts nothing', () => {
    const redact = redactionsOf('https://h', undefined, { 'X-Blank': '   ' })
    expect(redact).toEqual([])
    expect(snippet('a   b', 100, redact)).toBe('"a   b"')
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

describe('retryAfterHint', () => {
  const now = Date.parse('Sat, 14 Nov 2026 12:00:00 GMT')

  it.each<[string, Array<[string, string]>, number]>([
    [
      'retry-after-ms: 1500',
      [
        ['retry-after-ms', '1500'],
      ],
      1500,
    ],
    [
      'retry-after-ms: 250.5',
      [
        ['retry-after-ms', '250.5'],
      ],
      250.5,
    ],
    [
      'retry-after: 2',
      [
        ['retry-after', '2'],
      ],
      2000,
    ],
    [
      'retry-after: 1.5',
      [
        ['retry-after', '1.5'],
      ],
      1500,
    ],
    [
      'retry-after-ms: 300 beside retry-after: 9',
      [
        ['retry-after-ms', '300'],
        ['retry-after', '9'],
      ],
      300,
    ],
    [
      'retry-after-ms: soon beside retry-after: 3',
      [
        ['retry-after-ms', 'soon'],
        ['retry-after', '3'],
      ],
      3000,
    ],
    [
      'retry-after as an HTTP date',
      [
        ['retry-after', 'Sat, 14 Nov 2026 12:00:30 GMT'],
      ],
      30_000,
    ],
    [
      'retry-after: 90, which the policy then refuses',
      [
        ['retry-after', '90'],
      ],
      90_000,
    ],
  ])('reads %s', (_name, headers, expected) => {
    expect(retryAfterHint(new Headers(headers), now)).toBe(expected)
  })

  it.each<[string, Array<[string, string]>]>([
    [
      'retry-after: 0',
      [
        ['retry-after', '0'],
      ],
    ],
    [
      'retry-after-ms: 0',
      [
        ['retry-after-ms', '0'],
      ],
    ],
    [
      'a negative number',
      [
        ['retry-after', '-1'],
      ],
    ],
    [
      'an exponent',
      [
        ['retry-after', '1e3'],
      ],
    ],
    [
      'a hexadecimal number',
      [
        ['retry-after', '0x10'],
      ],
    ],
    [
      'two headers joined',
      [
        ['retry-after', '1'],
        ['retry-after', '2'],
      ],
    ],
    [
      'an asctime date',
      [
        ['retry-after', 'Sat Nov 14 12:00:30 2026'],
      ],
    ],
    [
      'an RFC 850 date',
      [
        ['retry-after', 'Saturday, 14-Nov-26 12:00:30 GMT'],
      ],
    ],
    [
      'a past date',
      [
        ['retry-after', 'Sat, 14 Nov 2026 11:59:00 GMT'],
      ],
    ],
    [
      '400 nines',
      [
        [
          'retry-after',
          '9'.repeat(400),
        ],
      ],
    ],
    [
      'a blank value',
      [
        ['retry-after', ''],
      ],
    ],
    ['no header', []],
  ])('reads no hint from %s', (_name, headers) => {
    expect(retryAfterHint(new Headers(headers), now)).toBeUndefined()
  })
})

describe('rateLimitOf', () => {
  const now = Date.parse('2026-11-22T10:00:00Z')

  it.each<[string, Record<string, string>, object]>([
    [
      'a gateway\'s headers, its generic x-ratelimit headers read as nothing',
      {
        'x-ratelimit-limit-requests': '300',
        'x-ratelimit-limit-tokens': '1000000',
        'x-ratelimit-remaining-requests': '299',
        'x-ratelimit-remaining-tokens': '999919',
        'x-ratelimit-reset-requests': '1m0s',
        'x-ratelimit-limit': '300',
        'x-ratelimit-remaining': '299',
        'x-ratelimit-reset': String(Math.floor(now / 1000) + 60),
      },
      {
        requests: 299,
        tokens: 999_919,
        tokensLimit: 1_000_000,
        requestsResetMs: 60_000,
      },
    ],
    [
      'OpenAI\'s, with resets of 6m0s and 20ms',
      {
        'x-ratelimit-limit-requests': '5000',
        'x-ratelimit-limit-tokens': '150000',
        'x-ratelimit-remaining-requests': '4999',
        'x-ratelimit-remaining-tokens': '149984',
        'x-ratelimit-reset-requests': '6m0s',
        'x-ratelimit-reset-tokens': '20ms',
      },
      {
        requests: 4999,
        tokens: 149_984,
        tokensLimit: 150_000,
        requestsResetMs: 360_000,
        tokensResetMs: 20,
      },
    ],
    [
      'Anthropic\'s, with RFC 3339 resets on a fixed now',
      {
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
        'anthropic-ratelimit-requests-reset': '2026-11-22T10:00:30Z',
        'anthropic-ratelimit-tokens-limit': '40000',
        'anthropic-ratelimit-tokens-remaining': '39000',
        'anthropic-ratelimit-tokens-reset': '2026-11-22T10:01:00.500Z',
      },
      {
        requests: 49,
        tokens: 39_000,
        tokensLimit: 40_000,
        requestsResetMs: 30_000,
        tokensResetMs: 60_500,
      },
    ],
    [
      'a reset of 1.5s',
      { 'x-ratelimit-reset-requests': '1.5s' },
      { requestsResetMs: 1500 },
    ],
    [
      'a reset of several units',
      { 'x-ratelimit-reset-tokens': '1h2m3.5s' },
      { tokensResetMs: 3_723_500 },
    ],
    [
      'a reset of 0s, which is no wait',
      { 'x-ratelimit-reset-requests': '0s' },
      { requestsResetMs: 0 },
    ],
    [
      'a date with an offset',
      { 'anthropic-ratelimit-requests-reset': '2026-11-22T11:00:30+01:00' },
      { requestsResetMs: 30_000 },
    ],
    [
      'OpenAI\'s names before Anthropic\'s, field by field',
      {
        'x-ratelimit-remaining-requests': '5',
        'anthropic-ratelimit-requests-remaining': '9',
        'anthropic-ratelimit-tokens-remaining': '8',
      },
      { requests: 5, tokens: 8 },
    ],
    [
      'a good header beside a malformed one',
      { 'x-ratelimit-remaining-requests': '-1', 'x-ratelimit-remaining-tokens': '12' },
      { tokens: 12 },
    ],
  ])('reads %s', (_name, headers, expected) => {
    expect(rateLimitOf(new Headers(headers), now)).toEqual(expected)
  })

  it.each<[string, Record<string, string>]>([
    [
      'a negative count',
      { 'x-ratelimit-remaining-requests': '-1' },
    ],
    [
      'a count in an exponent',
      { 'x-ratelimit-remaining-tokens': '1e6' },
    ],
    [
      'a count of 16 digits',
      { 'x-ratelimit-limit-tokens': '1234567890123456' },
    ],
    [
      'a fraction as a count',
      { 'anthropic-ratelimit-tokens-remaining': '1.5' },
    ],
    [
      'a count that is no number',
      { 'x-ratelimit-remaining-requests': 'sk-secret' },
    ],
    [
      'a reset of 1x',
      { 'x-ratelimit-reset-requests': '1x' },
    ],
    [
      'a reset with no unit',
      { 'x-ratelimit-reset-tokens': '60' },
    ],
    [
      'a reset of a sign',
      { 'x-ratelimit-reset-tokens': '-1s' },
    ],
    [
      'a reset of two parts out of order or joined',
      { 'x-ratelimit-reset-tokens': '1s 2s' },
    ],
    [
      'an empty reset',
      { 'x-ratelimit-reset-requests': '' },
    ],
    [
      'a date not of RFC 3339\'s shape',
      { 'anthropic-ratelimit-requests-reset': 'Sun, 22 Nov 2026 10:00:30 GMT' },
    ],
    [
      'a date without its zone',
      { 'anthropic-ratelimit-tokens-reset': '2026-11-22T10:00:30' },
    ],
    [
      'a date that is no date',
      { 'anthropic-ratelimit-tokens-reset': '2026-13-45T10:00:30Z' },
    ],
    [
      'a date already past, which a skewed clock would read as no wait',
      { 'anthropic-ratelimit-requests-reset': '2026-11-22T09:59:00Z' },
    ],
    [
      'only the generic headers',
      { 'x-ratelimit-limit': '300', 'x-ratelimit-remaining': '299', 'x-ratelimit-reset': '1795341660' },
    ],
    ['no header', {}],
  ])('ignores %s', (_name, headers) => {
    expect(rateLimitOf(new Headers(headers), now)).toBeUndefined()
  })
})

describe('postStream on a request and a whole reply', () => {
  it('sends the body as JSON with the given headers and signal, without following redirects, and returns the parsed reply', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonReply({ answer: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    await expect(postStream({
      ...options,
      headers: { authorization: 'Bearer k' },
      body: { a: 1 },
      signal,
    })).resolves.toEqual({
      whole: { answer: 1 },
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://h/x')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: '{"a":1}',
      redirect: 'manual',
      signal,
    })
  })

  it('reports a redirect as an http error that is not retried, so a key never reaches another endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('moved', 307)))
    const error = await postStream(options).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      kind: 'http',
      status: 307,
      retryable: false,
      message: 'p: HTTP 307 (redirects are not followed): "moved"',
    })
  })

  it('refuses a reply body over 16 MiB, and reads no more of it', async () => {
    const { response, pulled } = streamedReply('x'.repeat(1024 * 1024), 64)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response))
    await expect(postStream(options)).rejects.toMatchObject({ kind: 'invalid-response', retryable: false, message: 'p: reply body is over 16 MiB' })
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
    await expect(postStream(options)).resolves.toEqual({
      whole: { text: `caf${String.fromCharCode(0xE9)} ${String.fromCodePoint(0x1F600)}` },
    })
  })

  it('reads no more than 64 KiB of an error body', async () => {
    const { response, pulled } = streamedReply('e'.repeat(16 * 1024), 1000, 500)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response))
    await expect(postStream(options)).rejects.toMatchObject({ kind: 'http', status: 500, message: `p: HTTP 500: ${JSON.stringify('e'.repeat(500))}` })
    expect(pulled()).toBeLessThan(10)
  })

  it('lets a body that cannot be serialized fail as a programming error, before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const error = await postStream({
      ...options,
      body: { n: 1n },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(ProviderError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('truncates the error body to 500 characters, writes it as one JSON string and marks 5xx as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('x'.repeat(10_000), 503)))
    const error = await postStream(options).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({
      kind: 'http',
      status: 503,
      retryable: true,
      message: `p: HTTP 503: ${JSON.stringify('x'.repeat(500))}`,
    })
    expect((error as Error).cause).toBeUndefined()
  })

  it('does not mark client errors as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('bad request', 400)))
    await expect(postStream(options)).rejects.toMatchObject({ kind: 'http', status: 400, retryable: false })
  })

  it('quotes, rather than strips, the control characters of an error body', async () => {
    const body = `bad\n::error::forged${String.fromCharCode(27)}[2K`
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, 400)))
    await expect(postStream(options)).rejects.toMatchObject({ message: `p: HTTP 400: ${JSON.stringify(body)}` })
  })

  it('redacts the key from an error body that echoes it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('bad token: Bearer sk-secret', 401)))
    await expect(postStream({
      ...options,
      redact: ['sk-secret'],
    })).rejects.toMatchObject({ message: 'p: HTTP 401: "bad token: Bearer [redacted]"' })
  })

  it('still reports the status when the error body cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => brokenReply(new Error('stream error'), 502)))
    await expect(postStream(options)).rejects.toMatchObject({ kind: 'http', status: 502, message: 'p: HTTP 502: ""' })
  })

  it('never copies the runtime error text, which can hold the URL with its credentials', async () => {
    const url = 'https://user:pw-secret@api.example.com/v1/x?key=q-secret'
    const cause = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`, { cause })))
    const error = await postStream({ ...options, url }).catch((caught: Error) => caught) as Error
    expect(error).toMatchObject({ kind: 'network', retryable: true, message: 'p: request to https://api.example.com failed (ECONNREFUSED)' })
    expect(error.cause).toBeUndefined()
  })

  it('never copies the runtime error text, which can hold an invalid header value with the key', async () => {
    const header = `Bearer sk-secret${String.fromCharCode(10)}X`
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`Headers.append: "${header}" is an invalid header value.`)))
    const error = await postStream({
      ...options,
      headers: { authorization: header },
    }).catch((caught: Error) => caught) as Error
    expect(error.message).toBe('p: request to http://h failed')
  })

  it('names the code of the error itself, as Bun reports it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('Unable to connect'), { code: 'ECONNREFUSED' })))
    await expect(postStream(options)).rejects.toMatchObject({ kind: 'network', message: 'p: request to http://h failed (ECONNREFUSED)' })
  })

  it.each([
    ['not an identifier'],
    ['1ECONNREFUSED'],
    [
      'A'.repeat(41),
    ],
  ])('ignores the error code %j, which is not a plain identifier', async (code) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code })))
    await expect(postStream(options)).rejects.toMatchObject({ kind: 'network', message: 'p: request to http://h failed' })
  })

  it('still reports a network failure when reading the error code throws', async () => {
    const hostile = new TypeError('fetch failed')
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('boom')
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(hostile))
    await expect(postStream(options)).rejects.toMatchObject({ name: 'ProviderError', kind: 'network', message: 'p: request to http://h failed' })
  })

  it.each([
    ['not a url'],
    ['localhost:11434/v1'],
  ])('names the endpoint when the URL %j has no http origin', async (url) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(postStream({ ...options, url })).rejects.toMatchObject({ kind: 'network', message: 'p: request to the endpoint failed' })
  })

  it('reports a request aborted before the call as aborted, not as a network failure', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')))
    await expect(postStream({ ...options, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', retryable: false, message: 'p: request aborted' })
  })

  it('reports a request aborted while in flight as aborted', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }))
    await expect(postStream({ ...options, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', retryable: false })
  })

  it('reports a connection lost while the reply is read as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => brokenReply(new TypeError('terminated'))))
    const error = await postStream(options).catch((caught: Error) => caught) as Error
    expect(error).toMatchObject({ kind: 'network', retryable: true, message: 'p: reading the reply from http://h failed' })
    expect(error.cause).toBeUndefined()
  })

  it('reports a request aborted while its reply is read as aborted', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => brokenReply(new DOMException('aborted', 'AbortError'), 200, () => controller.abort())))
    await expect(postStream({ ...options, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', message: 'p: request aborted' })
  })

  it('rejects a success response whose body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('<html>not json</html>', 200)))
    const error = await postStream(options).catch((caught: Error) => caught) as Error
    expect(error).toMatchObject({ kind: 'invalid-response', retryable: false, message: 'p: response body is not JSON' })
    expect(error.cause).toBeUndefined()
  })
})

describe('postStream on a failed reply', () => {
  async function failure(body: string, status: number, headers: Record<string, string> = {}, extra: Partial<Parameters<typeof postStream>[0]> = {}): Promise<ProviderError> {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, status, headers)))
    return await postStream({
      ...options,
      ...extra,
    }).catch((caught: unknown) => caught) as ProviderError
  }

  it('puts the server\'s hint on its error as a number, and quotes the body as before, never a header', async () => {
    expect(await failure('slow down', 429, { 'retry-after': '2' })).toMatchObject({
      kind: 'http',
      status: 429,
      retryable: true,
      retryAfterMs: 2000,
      message: 'p: HTTP 429: "slow down"',
    })
  })

  it.each([
    [
      'of credit_balance_exhausted',
      429,
      {},
      {
        error: { code: 'credit_balance_exhausted' },
      },
    ],
    [
      'of organization_usage_limit_exceeded',
      429,
      {},
      {
        error: { code: 'organization_usage_limit_exceeded' },
      },
    ],
    [
      'of a project_spend_limit_exceeded',
      429,
      {},
      {
        error: { code: 'project_spend_limit_exceeded' },
      },
    ],
    [
      'of an insufficient_quota code and type',
      429,
      {},
      {
        error: { code: 'insufficient_quota', type: 'insufficient_quota' },
      },
    ],
    [
      'of an insufficient_quota type with no code',
      429,
      {},
      {
        error: { type: 'insufficient_quota', code: null },
      },
    ],
    [
      'of Anthropic\'s enforced_spend_limit_reached',
      429,
      {},
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'limit',
          details: { error_code: 'enforced_spend_limit_reached' },
        },
      },
    ],
    [
      'that says x-should-retry: false',
      503,
      { 'x-should-retry': 'false' },
      {
        error: { code: 'server_error' },
      },
    ],
    [
      'that says x-should-retry: true beside a spend code',
      429,
      { 'x-should-retry': 'true' },
      {
        error: { code: 'credit_balance_exhausted' },
      },
    ],
  ])('never retries a reply %s, whatever its status', async (_name, status, headers, body) => {
    const error = await failure(JSON.stringify(body), status, headers)
    expect(error).toMatchObject({ kind: 'http', status, retryable: false })
  })

  it.each([
    [
      'of billing_hard_limit_reached',
      429,
      {},
      {
        error: { code: 'billing_hard_limit_reached' },
      },
    ],
    [
      'of insufficient_quota as its code',
      429,
      {},
      {
        error: { code: 'insufficient_quota' },
      },
    ],
    [
      'of insufficient_quota as its type with no code',
      429,
      {},
      {
        error: { type: 'insufficient_quota', code: null },
      },
    ],
    [
      'of insufficient_quota inside a 500',
      500,
      {},
      {
        error: { code: 'insufficient_quota', message: 'quota' },
      },
    ],
    [
      'of credit_balance_exhausted',
      429,
      {},
      {
        error: { code: 'credit_balance_exhausted' },
      },
    ],
    [
      'of organization_usage_limit_exceeded',
      429,
      {},
      {
        error: { code: 'organization_usage_limit_exceeded' },
      },
    ],
    [
      'of project_spend_limit_exceeded',
      429,
      {},
      {
        error: { code: 'project_spend_limit_exceeded' },
      },
    ],
    [
      'of Anthropic\'s enforced_spend_limit_reached',
      429,
      {},
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'limit',
          details: { error_code: 'enforced_spend_limit_reached' },
        },
      },
    ],
    [
      'of Anthropic\'s own usage limit',
      400,
      {},
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
        },
      },
    ],
    [
      'of Anthropic\'s workspace usage limit',
      400,
      {},
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
        },
      },
    ],
    [
      'of OpenRouter\'s openrouter_credits',
      402,
      {},
      {
        error: {
          code: 402,
          message: 'credits',
          metadata: { limit_source: 'openrouter_credits' },
        },
      },
    ],
    [
      'of OpenRouter\'s openrouter_key_limit beside a Retry-After',
      402,
      { 'retry-after': '1' },
      {
        error: {
          code: 402,
          message: 'limit',
          metadata: { limit_source: 'openrouter_key_limit' },
        },
      },
    ],
  ])('marks a reply %s as a used-up quota, never retried', async (_name, status, headers, body) => {
    const error = await failure(JSON.stringify(body), status, headers)
    expect(error).toMatchObject({
      kind: 'http',
      status,
      retryable: false,
      exhausted: true,
    })
  })

  it.each([
    [
      'Anthropic\'s ramp_limit_exceeded',
      429,
      {},
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'ramp',
          details: { error_code: 'ramp_limit_exceeded' },
        },
      },
      true,
    ],
    [
      'OpenAI\'s slow_down',
      429,
      {},
      {
        error: { code: 'slow_down' },
      },
      true,
    ],
    [
      'OpenRouter\'s in-flight budget with a Retry-After',
      402,
      { 'retry-after': '1' },
      {
        error: {
          code: 402,
          message: 'in flight',
          metadata: { limit_source: 'openrouter_in_flight_budget' },
        },
      },
      true,
    ],
    [
      'a 400 of invalid_request_error whose message holds the usage-limit words past its start',
      400,
      {},
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Note: You have reached your specified API usage limits' },
      },
      false,
    ],
    [
      'a 400 of another type that starts with them',
      400,
      {},
      {
        type: 'error',
        error: { type: 'api_error', message: 'You have reached your specified API usage limits' },
      },
      false,
    ],
  ])('leaves %s a failure of its status', async (_name, status, headers, body, retryable) => {
    const error = await failure(JSON.stringify(body), status, headers)
    expect(error).toMatchObject({
      kind: 'http',
      status,
      retryable,
      exhausted: false,
    })
  })

  it('takes exhausted from an errorHints hook, and a hook that says nothing never clears the vendor\'s', async () => {
    expect(await failure('busy', 503, {}, {
      errorHints: () => ({ exhausted: true }),
    })).toMatchObject({ status: 503, retryable: false, exhausted: true })
    expect(await failure(JSON.stringify({
      error: { code: 'billing_hard_limit_reached' },
    }), 429, {}, {
      errorHints: () => ({}),
    })).toMatchObject({ exhausted: true })
  })

  it('retries a reply that says x-should-retry: true, whatever its status', async () => {
    expect(await failure('bad request', 400, { 'x-should-retry': 'true' })).toMatchObject({ kind: 'http', status: 400, retryable: true })
  })

  it('retries an OpenRouter 402 of its in-flight budget only when it carries a Retry-After', async () => {
    const inFlight = JSON.stringify({
      error: {
        code: 402,
        message: 'in flight',
        metadata: { limit_source: 'openrouter_in_flight_budget' },
      },
    })
    expect(await failure(inFlight, 402, { 'retry-after': '1' })).toMatchObject({ retryable: true, retryAfterMs: 1000 })
    expect(await failure(inFlight, 402)).toMatchObject({ retryable: false })
    const keyLimit = JSON.stringify({
      error: {
        code: 402,
        message: 'limit',
        metadata: { limit_source: 'openrouter_key_limit' },
      },
    })
    expect(await failure(keyLimit, 402, { 'retry-after': '1' })).toMatchObject({ retryable: false, exhausted: true })
  })

  it('leaves the status to decide for a body that is no JSON or names no code it knows', async () => {
    const cases: Array<[string, number, boolean]> = [
      ['busy', 503, true],
      [
        JSON.stringify({
          error: { code: 'server_error' },
        }),
        503,
        true,
      ],
      [
        JSON.stringify({ error: 'slow' }),
        429,
        true,
      ],
      ['{}', 400, false],
    ]
    for (const [body, status, retryable] of cases) {
      const error = await failure(body, status)
      expect(error, body).toMatchObject({ status, retryable })
      expect(error.retryAfterMs, body).toBeUndefined()
    }
  })

  it('hands its errorHints the parsed body, takes their hint after the headers\', and lets them turn a retry off', async () => {
    const hook = vi.fn((_body: unknown): ErrorHints => ({ retryAfterMs: 4000 }))
    expect(await failure('{ "e": 1 }', 429, {}, { errorHints: hook })).toMatchObject({ retryable: true, retryAfterMs: 4000 })
    expect(hook).toHaveBeenCalledWith({ e: 1 })
    expect(await failure('{}', 429, { 'retry-after': '1' }, { errorHints: hook })).toMatchObject({ retryAfterMs: 1000 })
    expect(await failure('{}', 503, {}, {
      errorHints: () => ({ retryable: false }),
    })).toMatchObject({ status: 503, retryable: false })
    hook.mockClear()
    await failure('not json', 429, {}, { errorHints: hook })
    expect(hook).toHaveBeenCalledWith(undefined)
  })
})

describe('postStream on a body that names a format field', () => {
  async function failure(body: string, status: number, formatFields: readonly string[] | undefined): Promise<ProviderError> {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, status)))
    return await postStream({
      ...options,
      ...formatFields === undefined
        ? {}
        : { formatFields },
    }).catch((caught: unknown) => caught) as ProviderError
  }

  it('matches the format fields as whole words in a 400 or 422 body only', async () => {
    const fields = ['response_format', 'format']
    const named = '{"error":{"message":"Unsupported parameter: \'response_format\' is not supported with this model."}}'
    for (const status of [400, 422]) expect(await failure(named, status, fields), String(status)).toMatchObject({ kind: 'http', status, refused: 'structuredOutput' })
    // Any other status names no refusal, whatever the body holds.
    for (const status of [401, 404, 429, 500, 503]) expect(await failure(named, status, fields), String(status)).toMatchObject({ status, refused: undefined })
    // A field is a whole word: it never matches inside another word, a letter or digit or underscore beside it.
    for (const body of [
      'invalid response_formats',
      'unknown reformat',
      'my_response_format_x',
      'formatting failed',
      'response_format2',
      'Response_Format is invalid',
      'a body that names no field',
    ]) expect(await failure(body, 400, ['response_format']), body).toMatchObject({ refused: undefined })
    for (const body of [
      'response_format: invalid',
      '"response_format"',
      'the field (response_format) is refused',
      'response_format',
    ]) expect(await failure(body, 422, ['response_format']), body).toMatchObject({ refused: 'structuredOutput' })
    expect(await failure('Invalid format', 400, ['format'])).toMatchObject({ refused: 'structuredOutput' })
    // Without fields to look for it never matches, and the message quotes the body as it always did, never the field's verdict.
    const plain = await failure(named, 400, undefined)
    expect(plain.refused).toBeUndefined()
    const refused = await failure('response_format is bad', 400, fields)
    expect(refused.message).toBe('p: HTTP 400: "response_format is bad"')
  })
})

describe('the runtimes\' timers', () => {
  const KEY = Symbol.for('undici.globalDispatcher.1')
  const scope = globalThis as unknown as Record<symbol, unknown>
  interface Delegate { dispatch: (options: object, handler: unknown) => unknown }
  let saved: unknown

  beforeEach(() => {
    saved = scope[KEY]
  })

  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(scope, KEY)
    else scope[KEY] = saved
  })

  /** The init `postStream` hands `fetch`, read as `fetch` reads it: through the object itself. */
  async function initOf(): Promise<{ timeout: unknown, dispatcher: Delegate | undefined }> {
    const fetchMock = vi.fn().mockImplementation(async () => jsonReply({}))
    vi.stubGlobal('fetch', fetchMock)
    await postStream(options)
    return fetchMock.mock.calls[0][1]
  }

  it('turns Bun\'s timer off, and hands Node\'s global dispatcher each request with both its timers off, read when fetch reads its init', async () => {
    const first = {
      dispatch: vi.fn((_options: object, _handler: unknown): unknown => true),
    }
    scope[KEY] = first
    const init = await initOf()
    expect(init.timeout).toBe(false)

    const second = {
      dispatch: vi.fn((_options: object, _handler: unknown): unknown => 'second'),
    }
    scope[KEY] = second
    const handler = {}
    expect(init.dispatcher?.dispatch({ path: '/x', headersTimeout: 300_000 }, handler)).toBe('second')
    expect(second.dispatch).toHaveBeenCalledWith({ path: '/x', headersTimeout: 0, bodyTimeout: 0 }, handler)
    expect(second.dispatch.mock.contexts[0]).toBe(second)
    expect(first.dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['no global dispatcher', undefined],
    ['a global dispatcher that is not an object', 'agent'],
    [
      'a global dispatcher whose dispatch is not a function',
      { dispatch: 'x' },
    ],
  ])('hands fetch no dispatcher when the runtime has %s', async (_name, global) => {
    scope[KEY] = global
    const init = await initOf()
    expect(init.dispatcher).toBeUndefined()
  })
})

describe('postStream', () => {
  const streamOptions = options
  /** A response of `text` as bytes, which carries no content type of its own, with `contentType` when it is given. */
  const served = (text: string, contentType?: string): Response => new Response(new TextEncoder().encode(text), {
    headers: contentType === undefined
      ? {}
      : { 'content-type': contentType },
  })
  /** What every event of the stream holds, in order. */
  async function drain(items: AsyncIterable<unknown>): Promise<unknown[]> {
    const read: unknown[] = []
    for await (const item of items) read.push(item)
    return read
  }

  it('fails a streamed read aborted mid-body as aborted, and one whose body drops as network', async () => {
    const controller = new AbortController()
    const eventStream = { 'content-type': 'text/event-stream' }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new ReadableStream({
      pull(stream) {
        controller.abort()
        stream.error(new DOMException('aborted', 'AbortError'))
      },
    }), { headers: eventStream })))
    const aborted = await postStream({ ...streamOptions, signal: controller.signal })
    await expect(drain((aborted as { items: AsyncIterable<unknown> }).items)).rejects.toMatchObject({ kind: 'aborted', retryable: false, message: 'p: request aborted' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new ReadableStream({
      pull(stream) {
        stream.error(new TypeError('terminated'))
      },
    }), { headers: eventStream })))
    const dropped = await postStream(streamOptions)
    await expect(drain((dropped as { items: AsyncIterable<unknown> }).items)).rejects.toMatchObject({ kind: 'network', retryable: true, message: 'p: reading the reply from http://h failed' })
  })

  it.each([
    ['text/event-stream', 'a stream'],
    ['text/event-stream; charset=utf-8', 'a stream'],
    ['Text/Event-Stream', 'a stream'],
    ['application/json', 'whole'],
    [undefined, 'whole'],
  ])('reads a reply whose content type is %s as %s', async (contentType, read) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => served(read === 'whole'
      ? '{"a":1}'
      : 'data: {"a":1}\n\n', contentType)))
    const result = await postStream(streamOptions)
    if (read === 'whole') {
      expect(result).toEqual({
        whole: { a: 1 },
      })
    } else {
      expect(Object.keys(result)).toEqual(['items'])
      expect(await drain((result as { items: AsyncIterable<unknown> }).items)).toEqual([
        {
          kind: 'event',
          event: 'message',
          value: { a: 1 },
        },
      ])
    }
  })

  it('reads an NDJSON body for the ndjson format alone, and a stream of the other format as a whole reply', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => served('{"a":1}\n{"a":2}\n', 'application/x-ndjson')))
    const ndjson = await postStream({ ...options, format: 'ndjson' })
    expect(await drain((ndjson as { items: AsyncIterable<unknown> }).items)).toEqual([
      {
        kind: 'event',
        event: 'line',
        value: { a: 1 },
      },
      {
        kind: 'event',
        event: 'line',
        value: { a: 2 },
      },
    ])
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => served('{"a":1}', 'application/x-ndjson')))
    expect(await postStream(streamOptions)).toEqual({
      whole: { a: 1 },
    })
  })

  it('reports its headers once, and each keep-alive as it is read, to the one who hears them', async () => {
    const signals: StreamSignal[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => served(': ping\n\ndata: [DONE]\n\n: ping\n\n', 'text/event-stream')))
    const result = await postStream({
      ...streamOptions,
      sentinel: '[DONE]',
      onProgress: signal => signals.push(signal),
    })
    expect(signals).toEqual([
      { kind: 'headers' },
    ])
    expect(await drain((result as { items: AsyncIterable<unknown> }).items)).toEqual([
      { kind: 'keep-alive' },
      { kind: 'done' },
      { kind: 'keep-alive' },
    ])
    expect(signals).toEqual([
      { kind: 'headers' },
      { kind: 'keep-alive' },
      { kind: 'keep-alive' },
    ])
    // A whole reply reports no headers signal, since its headers may come after its body, and a failed status none.
    signals.length = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonReply({ a: 1 })))
    await postStream({
      ...streamOptions,
      onProgress: signal => signals.push(signal),
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('nope', 500)))
    await expect(postStream({
      ...streamOptions,
      onProgress: signal => signals.push(signal),
    })).rejects.toMatchObject({ kind: 'http', status: 500 })
    expect(signals).toEqual([])
  })

  it('carries the rate-limit facts in the headers signal, on the reply, and on a failure', async () => {
    const facts = { requests: 7, tokens: 900, requestsResetMs: 1500 }
    const said = { 'x-ratelimit-remaining-requests': '7', 'x-ratelimit-remaining-tokens': '900', 'x-ratelimit-reset-requests': '1.5s' }
    const signals: StreamSignal[] = []
    const onProgress = (signal: StreamSignal): number => signals.push(signal)
    // A stream: the signal has them as the headers arrive, and so has the result.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('data: {"a":1}\n\n', {
      headers: { 'content-type': 'text/event-stream', ...said },
    })))
    const streamed = await postStream({ ...streamOptions, onProgress })
    expect(signals).toEqual([
      { kind: 'headers', rateLimit: facts },
    ])
    expect(streamed).toMatchObject({ rateLimit: facts })
    await drain((streamed as { items: AsyncIterable<unknown> }).items)
    // A whole reply: its facts are on the result alone, with the body beside them, and it sends no signal.
    signals.length = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('{"a":1}', {
      headers: { 'content-type': 'application/json', ...said },
    })))
    expect(await postStream({ ...streamOptions, onProgress })).toEqual({
      whole: { a: 1 },
      rateLimit: facts,
    })
    expect(signals).toEqual([])
    // A failure.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('slow', 429, said)))
    const failed = await postStream(streamOptions).catch((caught: unknown) => caught)
    expect(failed).toBeInstanceOf(ProviderError)
    expect((failed as ProviderError).rateLimit).toEqual(facts)
    expect((failed as ProviderError).message).toBe('p: HTTP 429: "slow"')
    // None read, none carried: no field on the signal, the result or the error.
    signals.length = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonReply({ a: 1 })))
    const bare = await postStream({ ...streamOptions, onProgress })
    expect(Object.keys(bare)).toEqual(['whole'])
    expect(signals).toEqual([])
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => served('data: {"a":1}\n\n', 'text/event-stream')))
    const bareStream = await postStream({ ...streamOptions, onProgress })
    expect(Object.keys(bareStream)).toEqual(['items'])
    expect(signals).toEqual([
      { kind: 'headers' },
    ])
    expect(Object.keys(signals[0]!)).toEqual(['kind'])
    await drain((bareStream as { items: AsyncIterable<unknown> }).items)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('slow', 429)))
    expect(((await postStream(streamOptions).catch((caught: unknown) => caught)) as ProviderError).rateLimit).toBeUndefined()
  })

  it('fails a whole reply that is no JSON or that is over 16 MiB, and a failed status as any other reply does', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('<html>', 200)))
    await expect(postStream(streamOptions)).rejects.toMatchObject({ kind: 'invalid-response', message: 'p: response body is not JSON' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => streamedReply('x'.repeat(1024 * 1024), 17).response))
    await expect(postStream(streamOptions)).rejects.toMatchObject({ kind: 'invalid-response', message: 'p: reply body is over 16 MiB' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('{"error":"slow"}', 429, { 'retry-after': '2' })))
    await expect(postStream(streamOptions)).rejects.toMatchObject({
      kind: 'http',
      status: 429,
      retryable: true,
      retryAfterMs: 2000,
    })
  })

  it('marks a 400 or 422 by the first stream word its body names as a whole word, before the format fields', async () => {
    const words = [
      { word: 'stream_options', refused: 'streamOptions' },
      { word: 'stream', refused: 'stream' },
    ] as const
    const refusal = async (text: string, status = 400, formatFields?: readonly string[]): Promise<unknown> => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(text, status)))
      return postStream({ ...streamOptions, streamWords: words, formatFields }).catch((error: unknown) => error)
    }
    expect(await refusal('stream_options is unsupported')).toMatchObject({ refused: 'streamOptions' })
    expect(await refusal('stream is unsupported', 422)).toMatchObject({ refused: 'stream' })
    expect(await refusal('stream_options and stream')).toMatchObject({ refused: 'streamOptions' })
    expect(await refusal('response_format and stream', 400, ['response_format'])).toMatchObject({ refused: 'stream' })
    expect(await refusal('response_format only', 400, ['response_format'])).toMatchObject({ refused: 'structuredOutput' })
    expect(await refusal('streaming is unsupported')).toMatchObject({ refused: undefined })
    expect(await refusal('stream is unsupported', 500)).toMatchObject({ refused: undefined })
  })
})

describe('replyOf', () => {
  const read = (reply: unknown): CompletionResponse => ({
    text: JSON.stringify(reply),
    model: 'm',
  })
  async function* none(): AsyncGenerator<StreamItem> {}

  it('reads a whole reply or an assembled stream through one tail, marking a streamed request answered whole', async () => {
    const assemble = vi.fn(async () => ({ assembled: true }))
    const sent = {
      whole: {},
      rateLimit: { requests: 7 },
    }
    expect(await replyOf(sent, true, assemble, read)).toEqual({
      ...read({}),
      whole: true,
      rateLimit: { requests: 7 },
    })
    expect(await replyOf(sent, false, assemble, read)).toEqual({
      ...read({}),
      rateLimit: { requests: 7 },
    })
    expect(assemble).not.toHaveBeenCalled()
    const items = none()
    expect(await replyOf({ items }, true, assemble, read)).toEqual(read({ assembled: true }))
    expect(assemble).toHaveBeenCalledExactlyOnceWith(items)
  })

  it('throws a failure read from a whole reply with the reply\'s rate-limit facts, every other field kept', async () => {
    const assemble = async (): Promise<unknown> => ({})
    const sent = {
      whole: {},
      rateLimit: { requests: 7 },
    }
    const failure = new ProviderError({
      providerId: 'p',
      kind: 'truncated',
      message: 'reply was cut off at its limit',
      noAnswer: 'reply',
      usage: { inputTokens: 5, outputTokens: 9 },
    })
    const caught = await replyOf(sent, true, assemble, () => {
      throw failure
    }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(ProviderError)
    expect(caught).not.toBe(failure)
    expect(caught).toMatchObject({
      kind: 'truncated',
      message: 'p: reply was cut off at its limit',
      noAnswer: 'reply',
      usage: { inputTokens: 5, outputTokens: 9 },
      retryable: false,
      rateLimit: { requests: 7 },
    })
    // An error with a rate limit of its own, and any other value, is thrown as it is.
    const own = new ProviderError({
      providerId: 'p',
      kind: 'truncated',
      message: 'cut',
      rateLimit: { requests: 1 },
    })
    const plain = new Error('boom')
    await expect(replyOf(sent, true, assemble, () => {
      throw own
    })).rejects.toBe(own)
    await expect(replyOf(sent, true, assemble, () => {
      throw plain
    })).rejects.toBe(plain)
  })

  it('adds no rateLimit field when the reply stated none', async () => {
    const assemble = async (): Promise<unknown> => ({})
    expect(await replyOf({ whole: {} }, true, assemble, read)).not.toHaveProperty('rateLimit')
    expect(await replyOf({
      items: none(),
    }, false, assemble, read)).not.toHaveProperty('rateLimit')
  })
})
