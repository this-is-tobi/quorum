import { describe, expect, it } from 'vitest'
import type { ConfigIssue } from '../core/errors.ts'
import { baseUrlIssues, httpOptionIssues, mergeBody, requestHeaders } from './options.ts'
import type { Auth, HttpProviderOptions } from './options.ts'

describe('baseUrlIssues', () => {
  it('accepts an http or https URL with a host', () => {
    expect(baseUrlIssues('p.baseUrl', 'http://localhost:11434/v1')).toEqual([])
    expect(baseUrlIssues('p.baseUrl', 'https://api.example.com')).toEqual([])
  })

  it.each([['localhost:11434/v1'], ['https:///v1'], ['ftp://h/v1'], ['not a url']])('refuses %j, without repeating it', (baseUrl) => {
    expect(baseUrlIssues('p.baseUrl', baseUrl)).toEqual([{ path: 'p.baseUrl', message: 'must be an http:// or https:// URL with a host' }])
  })

  it('refuses a query or a fragment, which the endpoint path would follow', () => {
    for (const baseUrl of ['https://h/v1?api-version=1', 'https://h/v1?', 'https://h/v1#x']) {
      expect(baseUrlIssues('p.baseUrl', baseUrl), baseUrl).toEqual([{ path: 'p.baseUrl', message: 'must not hold a query or a fragment' }])
    }
    expect(baseUrlIssues('p.baseUrl', 'https://u:p@h/v1?k=q')).toHaveLength(2)
  })

  it('refuses a user name or a password in the URL, without repeating them', () => {
    for (const baseUrl of ['https://user:pw-secret@h/v1', 'https://user@h/v1', 'https://:pw-secret@h/v1']) {
      expect(baseUrlIssues('p.baseUrl', baseUrl), baseUrl).toEqual([{ path: 'p.baseUrl', message: 'must not hold a user name or password: send a key with apiKey' }])
    }
  })
})

describe('httpOptionIssues', () => {
  const base = { id: 'p', baseUrl: 'https://h/v1', model: 'm' }
  /** The issues of `options` over the base ones, under `options.auth` when it names one, as given, and bearer otherwise. */
  const issuesOf = (options: Record<string, unknown>): ConfigIssue[] =>
    httpOptionIssues({ ...base, ...options } as HttpProviderOptions, ('auth' in options ? options.auth : 'bearer') as Auth, ['model', 'messages', 'stream'])

  it.each([['null', null], ['a string', 'abc'], ['an array', ['a']]])('refuses headers or a query that is %s, as it maps no names to strings', (_name, value) => {
    expect(issuesOf({ headers: value })).toEqual([{ path: 'p.headers', message: 'must map names to strings' }])
    expect(issuesOf({ query: value })).toEqual([{ path: 'p.query', message: 'must map names to strings' }])
  })

  const visibleAscii = { path: 'p.apiKey', message: 'must only contain visible ASCII characters, which an HTTP header can carry' }
  const withHost = { path: 'p.baseUrl', message: 'must be an http:// or https:// URL with a host' }
  const authShape = { path: 'p.auth', message: 'must be bearer, x-api-key, none or { header, prefix }' }

  it.each<[string, Record<string, unknown>, ConfigIssue[]]>([
    ['a key holding a space', { apiKey: `sk-a${String.fromCharCode(32)}b` }, [visibleAscii]],
    ['a key holding a NUL', { apiKey: `sk-a${String.fromCharCode(0)}b` }, [visibleAscii]],
    ['a key holding a DEL', { apiKey: `sk-a${String.fromCharCode(127)}b` }, [visibleAscii]],
    ['a key holding a zero-width space', { apiKey: `sk-a${String.fromCharCode(0x200B)}b` }, [visibleAscii]],
    ['an empty base URL', { baseUrl: '' }, [withHost]],
    ['a base URL that is only a path', { baseUrl: '/v1' }, [withHost]],
    ['a base URL with no host', { baseUrl: 'http://' }, [withHost]],
    ['a base URL with credentials and no host', { baseUrl: 'https://user:secret@/v1' }, [withHost]],
    ['an ftp base URL with credentials', { baseUrl: 'ftp://user:secret@h/v1' }, [withHost]],
    ['an IPv6 base URL, accepted', { baseUrl: 'http://[::1]:11434/v1' }, []],
    ['an auth word it does not know', { auth: 'Bearer' }, [authShape]],
    ['a null auth', { auth: null }, [authShape]],
    ['an auth with no header', { auth: {} }, [authShape]],
    ['an auth header that is not a string', { auth: { header: 1 } }, [authShape]],
    ['an auth prefix that is not a string', { auth: { header: 'x', prefix: 1 } }, [authShape]],
    ['an auth header that is not a token', { auth: { header: 'x y' } }, [{ path: 'p.auth.header', message: 'must be an HTTP header name' }]],
    ['a query value that is not a string', { query: { a: 1 } }, [{ path: 'p.query', message: 'must map names to strings' }]],
    ['a systemPrompt it does not know', { systemPrompt: 'system' }, [{ path: 'p.systemPrompt', message: 'must be native or inline' }]],
    ['a __proto__ key nested in extraBody', { extraBody: JSON.parse('{"a":{"__proto__":{}}}') }, [{ path: 'p.extraBody', message: 'must be an object of JSON values, with no __proto__ key' }]],
  ])('reports %s with its exact issues, repeating no secret', (_name, options, issues) => {
    const found = issuesOf(options)
    expect(found).toEqual(issues)
    expect(JSON.stringify(found)).not.toMatch(/sk|secret/)
  })
})

describe('requestHeaders', () => {
  it('sends basic auth as a custom key header with a Basic prefix, the key the base64 of user:password', () => {
    const auth = { header: 'authorization', prefix: 'Basic ' }
    const apiKey = btoa('user:password')
    expect(httpOptionIssues({ id: 'p', baseUrl: 'https://h/v1', model: 'm', apiKey, auth }, auth, ['model'])).toEqual([])
    expect(requestHeaders(auth, apiKey)).toEqual({ authorization: 'Basic dXNlcjpwYXNzd29yZA==' })
  })
})

describe('mergeBody', () => {
  it('merges objects key by key, replaces arrays and anything else, and changes neither input', () => {
    const body = { model: 'm', options: { temperature: 0, stop: ['a'] }, n: 1 }
    const extra = { options: { num_ctx: 32768, stop: ['b'] }, n: { two: 2 } }
    expect(mergeBody(body, extra)).toEqual({ model: 'm', options: { temperature: 0, stop: ['b'], num_ctx: 32768 }, n: { two: 2 } })
    expect(body).toEqual({ model: 'm', options: { temperature: 0, stop: ['a'] }, n: 1 })
    expect(extra).toEqual({ options: { num_ctx: 32768, stop: ['b'] }, n: { two: 2 } })
    expect(mergeBody(body, undefined)).toBe(body)
  })
})
