import { describe, expect, it } from 'vitest'
import type { ConfigIssue } from '../core/errors.ts'
import { baseUrlIssues, httpOptionIssues, mergeBody } from './options.ts'
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
})

describe('mergeBody', () => {
  it('merges objects key by key, replaces arrays and anything else, and changes neither input', () => {
    const body = { model: 'm', options: { temperature: 0, stop: ['a'] }, n: 1 }
    const extra = { options: { num_ctx: 32768, stop: ['b'] }, n: { two: 2 } }
    expect(mergeBody(body, extra)).toEqual({ model: 'm', options: { temperature: 0, stop: ['b'], num_ctx: 32768 }, n: { two: 2 } })
    expect(body).toEqual({ model: 'm', options: { temperature: 0, stop: ['a'] }, n: 1 })
    expect(mergeBody(body, undefined)).toBe(body)
  })
})
