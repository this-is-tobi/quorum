import { describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { baseUrlIssues, httpOptionIssues, mergeBody, prepareHttp, requestHeaders } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions } from './options.ts'

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
  const rules: AdapterRules = { auth: 'bearer', reservedBodyKeys: ['model', 'messages', 'stream'], toolBodyKeys: ['tools', 'toolConfig'], fixedHeaders: ['x-version'], structuredOutputs: ['prompt', 'json', 'schema'] }
  /** The issues of `options` over the base ones, under `rules` and `options.auth` when it names one, as given. */
  const issuesOf = (options: Record<string, unknown>, overrides: Partial<AdapterRules> = {}): ConfigIssue[] =>
    httpOptionIssues({ ...base, ...options } as HttpProviderOptions, { ...rules, ...('auth' in options ? { auth: options.auth as Auth } : {}), ...overrides })

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

  it('refuses a query value that is the key, whatever its name', () => {
    expect(issuesOf({ apiKey: 'sk-1', query: { api_key: 'sk-1', v: '1' } })).toEqual([
      { path: 'p.query.api_key', message: 'holds the key, which travels only in the header auth names' },
    ])
  })

  it('finds no key in an empty query value when the key is empty, since no key is sent', () => {
    expect(issuesOf({ apiKey: '', query: { a: '' } })).toEqual([])
  })

  it('refuses each extraBody key that offers the model a tool, and each the adapter writes, one issue per key in its order', () => {
    expect(issuesOf({ extraBody: { toolConfig: {}, top_k: 20, model: 'x', tools: [], chat_template_kwargs: {} } })).toEqual([
      { path: 'p.extraBody.toolConfig', message: 'offers the model a tool, which quorum never does' },
      { path: 'p.extraBody.model', message: 'is written by the adapter and cannot be replaced' },
      { path: 'p.extraBody.tools', message: 'offers the model a tool, which quorum never does' },
    ])
  })

  it('matches an extraBody key in any letter case and with or without underscores, as Go and proto JSON servers read it', () => {
    const longS = `${String.fromCharCode(0x17F)}tream`
    expect(issuesOf({ extraBody: { Tools: [], tool_config: {}, TOOL_CONFIG: {}, Messages: [], STREAM: true, [longS]: true } })).toEqual([
      { path: 'p.extraBody.Tools', message: 'offers the model a tool, which quorum never does' },
      { path: 'p.extraBody.tool_config', message: 'offers the model a tool, which quorum never does' },
      { path: 'p.extraBody.TOOL_CONFIG', message: 'offers the model a tool, which quorum never does' },
      { path: 'p.extraBody.Messages', message: 'is written by the adapter and cannot be replaced' },
      { path: 'p.extraBody.STREAM', message: 'is written by the adapter and cannot be replaced' },
      { path: 'p.extraBody.*', message: 'is written by the adapter and cannot be replaced' },
    ])
  })

  it('folds a key as Go does, so the long s and the Kelvin sign are s and k', () => {
    const tool = `tool${String.fromCharCode(0x17F)}`
    const fallback = `fallbac${String.fromCharCode(0x212A)}_credit_token`
    expect(issuesOf({ extraBody: { [tool]: [], [fallback]: 'x' } }, { toolBodyKeys: ['tools', 'fallback_credit_token'] })).toEqual([
      { path: 'p.extraBody.*', message: 'offers the model a tool, which quorum never does' },
      { path: 'p.extraBody.*', message: 'offers the model a tool, which quorum never does' },
    ])
  })

  it('prints a header name, a body key or a query name that is not a safe name as *, since it could be a pasted secret', () => {
    const token = `sk-${'a'.repeat(70)}`
    expect(issuesOf({ headers: { [token]: `v${String.fromCharCode(1)}`, [`x${String.fromCharCode(10)}y`]: 'v' } })).toEqual([
      { path: 'p.headers.*', message: 'must be a string of printable ASCII characters' },
      { path: 'p.headers.*', message: 'must be an HTTP header name' },
    ])
    expect(issuesOf({ extraBody: { [`tool${String.fromCharCode(0x17F)}`]: [] } })).toEqual([{ path: 'p.extraBody.*', message: 'offers the model a tool, which quorum never does' }])
    expect(issuesOf({ apiKey: 'sk-k', query: { [token]: 'sk-k' } })).toEqual([{ path: 'p.query.*', message: 'holds the key, which travels only in the header auth names' }])
  })

  it('refuses a header the adapter always sends, in any letter case, and a custom auth header that would replace it', () => {
    expect(issuesOf({ headers: { 'x-version': '1', 'X-VERSION': '2', 'X-Other': '3' } })).toEqual([
      { path: 'p.headers.x-version', message: 'is set by the adapter and cannot be replaced' },
      { path: 'p.headers.X-VERSION', message: 'is set by the adapter and cannot be replaced' },
    ])
    expect(issuesOf({ auth: { header: 'X-Version' } })).toEqual([{ path: 'p.auth.header', message: 'is set by the adapter and cannot be replaced' }])
  })

  it('refuses a header the adapter declares in another letter case, as a header or a custom auth header', () => {
    const declared = { fixedHeaders: ['X-Version'] }
    expect(issuesOf({ headers: { 'x-version': '1' } }, declared)).toEqual([{ path: 'p.headers.x-version', message: 'is set by the adapter and cannot be replaced' }])
    expect(issuesOf({ auth: { header: 'x-version' } }, declared)).toEqual([{ path: 'p.auth.header', message: 'is set by the adapter and cannot be replaced' }])
  })

  it('accepts each structured-output mode the protocol supports, and names them when it refuses another', () => {
    for (const structuredOutput of ['prompt', 'json', 'schema']) expect(issuesOf({ structuredOutput }), structuredOutput).toEqual([])
    expect(issuesOf({ structuredOutput: 'yaml' })).toEqual([{ path: 'p.structuredOutput', message: 'must be prompt, json or schema' }])
    expect(issuesOf({ structuredOutput: 1 })).toEqual([{ path: 'p.structuredOutput', message: 'must be prompt, json or schema' }])
    expect(issuesOf({ structuredOutput: 'json' }, { structuredOutputs: ['prompt', 'schema'] })).toEqual([{ path: 'p.structuredOutput', message: 'must be prompt or schema' }])
    expect(issuesOf({ structuredOutput: 'json' }, { structuredOutputs: ['prompt'] })).toEqual([{ path: 'p.structuredOutput', message: 'must be prompt' }])
  })
})

describe('prepareHttp', () => {
  const rules: AdapterRules = { auth: 'bearer', reservedBodyKeys: ['model'], toolBodyKeys: ['tools'], fixedHeaders: [], structuredOutputs: ['prompt', 'json'] }

  it('returns the URL, the headers and the redactions the helpers build, and a copy of extraBody', () => {
    const extraBody = { top_k: 20, nested: { a: 1 } }
    const options = { id: 'p', baseUrl: 'https://h.example/gw/v1/', model: 'm', apiKey: 'sk-k', headers: { 'X-Team': ' security ' }, query: { 'api-version': '1' }, extraBody }
    const prepared = prepareHttp(options, rules, '/chat/completions')
    expect(prepared).toEqual({
      url: 'https://h.example/gw/v1/chat/completions?api-version=1',
      headers: { 'x-team': ' security ', authorization: 'Bearer sk-k' },
      redact: ['sk-k', '/gw/v1', ' security ', 'security'],
      extraBody: { top_k: 20, nested: { a: 1 } },
    })
    extraBody.top_k = 99
    extraBody.nested.a = 2
    expect(prepared.extraBody).toEqual({ top_k: 20, nested: { a: 1 } })
    expect(prepareHttp({ id: 'p', baseUrl: 'https://h.example', model: 'm' }, rules, '/x')).toEqual({ url: 'https://h.example/x', headers: {}, redact: [], extraBody: undefined })
  })

  it('throws every shared issue, then the adapter\'s, in one ConfigError, before building anything', () => {
    const adapterIssues = [{ path: 'p.model', message: 'must be a model id' }]
    const options = { id: 'p', baseUrl: 'h.example', model: 'm', maxTokens: 0, extraBody: { tools: [] } }
    expect(() => prepareHttp(options, rules, '/x', adapterIssues)).toThrow(new ConfigError([
      { path: 'p.baseUrl', message: 'must be an http:// or https:// URL with a host' },
      { path: 'p.extraBody.tools', message: 'offers the model a tool, which quorum never does' },
      { path: 'p.maxTokens', message: 'must be a whole number of at least 1' },
      { path: 'p.model', message: 'must be a model id' },
    ]))
    expect(() => prepareHttp({ id: 'p', baseUrl: 'https://h.example', model: 'm' }, rules, '/x', adapterIssues)).toThrow(new ConfigError(adapterIssues))
    expect(() => prepareHttp({ ...options, baseUrl: 'https://h.example' }, rules, '/x')).toThrow(ConfigError)
  })
})

describe('requestHeaders', () => {
  it('sends basic auth as a custom key header with a Basic prefix, the key the base64 of user:password', () => {
    const auth = { header: 'authorization', prefix: 'Basic ' }
    const apiKey = btoa('user:password')
    expect(httpOptionIssues({ id: 'p', baseUrl: 'https://h/v1', model: 'm', apiKey, auth }, { auth, reservedBodyKeys: ['model'], toolBodyKeys: [], fixedHeaders: [], structuredOutputs: ['prompt'] })).toEqual([])
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
