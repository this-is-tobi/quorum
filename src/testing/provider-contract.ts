import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'
import type { CompletionRequest, Provider } from '../core/ports.ts'
import type { Usage } from '../core/types.ts'
import type { HttpProviderOptions, StructuredOutput } from '../providers/options.ts'
import { jsonReply, textReply } from './http.ts'

type Body = Record<string, unknown>

/** What one request handed to fetch. */
interface Sent {
  url: string
  headers: Record<string, string>
  body: Body
  init: RequestInit
}

/** What the contract suite needs to know of one HTTP adapter. */
export interface ContractSubject {
  /** The protocol, in the suite's title. */
  protocol: string
  /** Builds the adapter under test. */
  make: (options: HttpProviderOptions) => Provider
  /** The headers the adapter always sends besides the content type, such as a version header. */
  fixedHeaders: Readonly<Record<string, string>>
  /** The key header the adapter sends by default, and its value for `key`. */
  defaultKeyHeader: (key: string) => readonly [name: string, value: string]
  /**
   * Recorded replies, as the protocol sends them: a success whose text is `{}`, with the model and usage it
   * names, a truncation, which reports the success's counts, and, when the protocol has one, a refusal.
   */
  replies: { ok: unknown, model: string, usage: Usage, refusal?: unknown, truncated: unknown }
  /** Where a sent body holds the system text, the first user message, the temperature and the token limit. */
  read: {
    system: (body: Body) => unknown
    firstUser: (body: Body) => unknown
    temperature: (body: Body) => unknown
    maxTokens: (body: Body) => unknown
  }
  /** The body fields the adapter writes for the conversation, which `extraBody` cannot replace. */
  reservedBodyKeys: readonly string[]
  /** The body fields that would offer the model a tool or a server-side capability, which `extraBody` cannot set. */
  toolBodyKeys: readonly string[]
  /** The body fields that set the reply limit, each as the keys leading to it, which `extraBody` cannot set. */
  replyLimitPaths: readonly (readonly string[])[]
  /** The structured-output modes the protocol supports. */
  structuredOutputs: readonly StructuredOutput[]
  /**
   * An `extraBody` that adds to an object the adapter writes, the options under which it writes that
   * object, and the merged object the body then holds.
   */
  mergeProbe: { options?: Partial<HttpProviderOptions>, extraBody: Body, merged: Body }
}

const MODES: readonly StructuredOutput[] = ['prompt', 'json', 'schema']

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
const base = {
  id: 'p',
  baseUrl: 'https://h.example/v1',
  model: 'm',
  contextTokens: 131072,
}

/** The shared contract every HTTP adapter meets: where the key goes and nowhere else, its options, and its errors. */
export function describeProviderContract(subject: ContractSubject): void {
  /** The message that refuses a mode, naming the subject's modes. */
  const modesMessage = subject.structuredOutputs.length === MODES.length
    ? 'must be prompt, json or schema'
    : `must be ${subject.structuredOutputs.join(' or ')}`

  describe(`the ${subject.protocol} provider contract`, () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /** Send one request through `provider` and return what reached fetch. */
    async function sendThrough(provider: Provider): Promise<Sent> {
      const fetchMock = vi.fn().mockImplementation(async () => jsonReply(subject.replies.ok))
      vi.stubGlobal('fetch', fetchMock)
      await provider.complete(request)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      return {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string) as Body,
        init,
      }
    }

    /** Send one request with `options` and return what reached fetch. */
    async function send(options: Partial<HttpProviderOptions> = {}): Promise<Sent> {
      return sendThrough(subject.make({
        ...base,
        ...options,
      }))
    }

    function issuesOf(options: Partial<HttpProviderOptions>): unknown {
      try {
        subject.make({
          ...base,
          ...options,
        } as HttpProviderOptions)
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError)
        return (error as ConfigError).issues
      }
      return []
    }

    it('sends the key in the header its auth style names, and nowhere else', async () => {
      const cases: Array<[HttpProviderOptions['auth'], readonly [string, string]]> = [
        [
          undefined,
          subject.defaultKeyHeader('sk-k'),
        ],
        [
          'bearer',
          ['authorization', 'Bearer sk-k'],
        ],
        [
          'x-api-key',
          ['x-api-key', 'sk-k'],
        ],
        [
          { header: 'Api-Key' },
          ['api-key', 'sk-k'],
        ],
        [
          { header: 'X-Token', prefix: 'Token ' },
          ['x-token', 'Token sk-k'],
        ],
      ]
      for (const [auth, [name, value]] of cases) {
        const { url, headers, body } = await send({ apiKey: 'sk-k', auth })
        expect(headers, JSON.stringify(auth)).toEqual({ 'content-type': 'application/json', ...subject.fixedHeaders, [name]: value })
        expect(`${url}${JSON.stringify(body)}`).not.toContain('sk-k')
      }
    })

    it('sends no key header without a key, with an empty one, or under auth none', async () => {
      for (const options of [
        {},
        { apiKey: '' },
        { auth: 'none' as const },
      ]) {
        expect((await send(options)).headers, JSON.stringify(options)).toEqual({ 'content-type': 'application/json', ...subject.fixedHeaders })
      }
    })

    it('sends its own headers, lower-cased, and adds its query to the URL', async () => {
      const { url, headers } = await send({
        headers: { 'X-Team': 'security' },
        query: { 'api-version': '2024-10-21', 'a b': 'c&d' },
      })
      expect(headers).toMatchObject({ 'x-team': 'security' })
      expect(new URL(url).search).toBe('?api-version=2024-10-21&a+b=c%26d')
    })

    it('puts the system text in its own place natively, and at the head of the first user message inline', async () => {
      const native = await send()
      expect(subject.read.system(native.body)).toBe('instructions')
      expect(subject.read.firstUser(native.body)).toBe('data')
      const inline = await send({ systemPrompt: 'inline' })
      expect(subject.read.system(inline.body)).toBeUndefined()
      expect(subject.read.firstUser(inline.body)).toBe('instructions\n\ndata')
    })

    it('sends a set temperature and token limit, and no temperature for null', async () => {
      const set = await send({ temperature: 0.3, maxTokens: 900 })
      expect([
        subject.read.temperature(set.body),
        subject.read.maxTokens(set.body),
      ]).toEqual([0.3, 900])
      expect(subject.read.temperature((await send({ temperature: null })).body)).toBeUndefined()
    })

    it('refuses a request that may not fit contextTokens, before sending it', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(subject.make({ ...base, contextTokens: 644, maxTokens: 100 }).complete(request)).rejects.toMatchObject({
        kind: 'too-large',
        retryable: false,
        message: 'p: may need 645 tokens, more than contextTokens (644): 33 for its text at one token per byte, 512 for the chat template and 100 for the reply',
      })
      expect(fetchMock).not.toHaveBeenCalled()
      await send({ contextTokens: 645, maxTokens: 100 })
    })

    it('counts the text it sends, the system text placed inline included', async () => {
      vi.stubGlobal('fetch', vi.fn())
      await expect(subject.make({
        ...base,
        contextTokens: 646,
        maxTokens: 100,
        systemPrompt: 'inline',
      }).complete(request)).rejects.toMatchObject({
        kind: 'too-large',
        message: 'p: may need 647 tokens, more than contextTokens (646): 35 for its text at one token per byte, 512 for the chat template and 100 for the reply',
      })
      await send({ contextTokens: 647, maxTokens: 100, systemPrompt: 'inline' })
    })

    it('keeps 16000 tokens for the reply when maxTokens is unset', async () => {
      vi.stubGlobal('fetch', vi.fn())
      await expect(subject.make({ ...base, contextTokens: 16544 }).complete(request)).rejects.toMatchObject({
        kind: 'too-large',
        message: 'p: may need 16545 tokens, more than contextTokens (16544): 33 for its text at one token per byte, 512 for the chat template and 16000 for the reply',
      })
      await send({ contextTokens: 16545 })
    })

    it('deep-merges extraBody into the body last: objects merge key by key, anything else replaces', async () => {
      const { body } = await send({
        ...subject.mergeProbe.options,
        extraBody: {
          ...subject.mergeProbe.extraBody,
          top_k: 20,
          list: [2],
        },
      })
      expect(body).toMatchObject({
        ...subject.mergeProbe.merged,
        top_k: 20,
        list: [2],
      })
    })

    it('sends the extraBody, headers and query it was built with, whatever the caller changes in them later', async () => {
      const nested = { a: 1 }
      const extraBody: Body = { top_k: 20, nested }
      const headers: Record<string, string> = { 'X-Team': 'security' }
      const query: Record<string, string> = { 'api-version': '1' }
      const provider = subject.make({ ...base, extraBody, headers, query })
      Object.assign(extraBody, Object.fromEntries([
        ...subject.reservedBodyKeys,
        ...subject.toolBodyKeys,
      ].map(key => [key, 'x'])), { top_k: 99 })
      nested.a = 2
      headers['X-Team'] = 'changed'
      headers.Authorization = 'Bearer forged'
      query['api-version'] = '2'
      const built = await send({
        extraBody: {
          top_k: 20,
          nested: { a: 1 },
        },
        headers: { 'X-Team': 'security' },
        query: { 'api-version': '1' },
      })
      const { url, headers: sentHeaders, body } = await sendThrough(provider)
      expect({ url, headers: sentHeaders, body }).toEqual({ url: built.url, headers: built.headers, body: built.body })
    })

    it('refuses every bad option at once, before any request, and repeats no value', () => {
      const fixed = Object.keys(subject.fixedHeaders).map(name => name.toUpperCase())
      const issues = issuesOf({
        apiKey: 'sk-zz',
        auth: 'none',
        headers: {
          'Content-Type': 'text/plain',
          'bad name': 'v',
          'X-Token': 'zz-value\n',
          ...Object.fromEntries(fixed.map(name => [name, 'zz-fixed'])),
        },
        extraBody: Object.fromEntries([
          ...subject.reservedBodyKeys,
          ...subject.toolBodyKeys,
        ].map(key => [key, 'x'])),
        temperature: Number.NaN,
        maxTokens: 0,
        structuredOutput: 'yaml' as StructuredOutput,
      })
      expect(issues).toEqual([
        { path: 'p.apiKey', message: 'is set, but auth is none, so it would never be sent' },
        { path: 'p.headers.Content-Type', message: 'must not be content-type, content-length or host' },
        { path: 'p.headers.*', message: 'must be an HTTP header name' },
        { path: 'p.headers.X-Token', message: 'must be a string of printable ASCII characters' },
        ...fixed.map(name => ({ path: `p.headers.${name}`, message: 'is set by the adapter and cannot be replaced' })),
        ...subject.reservedBodyKeys.map(key => ({ path: `p.extraBody.${key}`, message: 'is written by the adapter and cannot be replaced' })),
        ...subject.toolBodyKeys.map(key => ({ path: `p.extraBody.${key}`, message: 'offers the model a tool, which quorum never does' })),
        { path: 'p.temperature', message: 'must be a finite number, or null to leave it out' },
        { path: 'p.maxTokens', message: 'must be a whole number of at least 1' },
        { path: 'p.structuredOutput', message: modesMessage },
      ])
      expect(JSON.stringify(issues)).not.toContain('zz')
    })

    it('accepts each structured-output mode the protocol supports, and refuses the others', () => {
      for (const mode of MODES) {
        expect(issuesOf({ structuredOutput: mode }), mode).toEqual(subject.structuredOutputs.includes(mode)
          ? []
          : [
              { path: 'p.structuredOutput', message: modesMessage },
            ])
      }
    })

    it('refuses an extraBody that sets the reply limit, in any letter case, since the guard reserves maxTokens, and repeats no value', () => {
      for (const path of subject.replyLimitPaths) {
        for (const keys of [
          path,
          path.map(key => key.toUpperCase()),
        ]) {
          const issues = issuesOf({
            extraBody: keys.reduceRight<unknown>((value, key) => ({ [key]: value }), 64000) as Body,
          }) as Array<{ path: string, message: string }>
          // An adapter that merges an object under the first key also refuses it spelled in another letter case: that is not this test's subject.
          expect(issues.filter(issue => !issue.message.startsWith('must be written ')), keys.join('.')).toEqual([
            { path: `p.extraBody.${keys.join('.')}`, message: 'sets the reply limit: use maxTokens' },
          ])
          expect(JSON.stringify(issues)).not.toContain('64000')
        }
      }
    })

    it('refuses an extraBody holding a value with no JSON form', () => {
      for (const extraBody of [
        { a: undefined },
        {
          a: new Date(0),
        },
        {
          a: { b: Number.NaN },
        },
        JSON.parse('{"__proto__":{"x":1}}') as Body,
      ]) {
        expect(issuesOf({ extraBody }), JSON.stringify(Object.keys(extraBody))).toEqual([
          { path: 'p.extraBody', message: 'must be an object of JSON values, with no __proto__ key' },
        ])
      }
    })

    it('is refused without contextTokens, before any request', () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      expect(issuesOf({ contextTokens: undefined })).toEqual([
        { path: 'p.contextTokens', message: 'is required: the model\'s context window in tokens, which quorum checks every request against' },
      ])
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses a base URL it cannot use and a key a header cannot carry, without repeating either', () => {
      const issues = issuesOf({ baseUrl: 'https://user:zz-pw@h.example/v1?k=zz-q', apiKey: 'sk-zz\n' })
      expect(issues).toEqual([
        { path: 'p.baseUrl', message: 'must not hold a user name or password: send a key with apiKey' },
        { path: 'p.baseUrl', message: 'must not hold a query or a fragment' },
        { path: 'p.apiKey', message: 'must only contain visible ASCII characters, which an HTTP header can carry' },
      ])
      expect(JSON.stringify(issues)).not.toContain('zz')
      expect(issuesOf({ baseUrl: 'localhost:11434/v1' })).toEqual([
        { path: 'p.baseUrl', message: 'must be an http:// or https:// URL with a host' },
      ])
    })

    it('refuses a header that would carry the key, a custom auth header quorum sets, and a bad prefix', () => {
      expect(issuesOf({
        headers: { [subject.defaultKeyHeader('k')[0]]: 'x' },
      })).toEqual([
        { path: `p.headers.${subject.defaultKeyHeader('k')[0]}`, message: 'is the header that carries the key: set apiKey instead' },
      ])
      const shouted = subject.defaultKeyHeader('k')[0].toUpperCase()
      expect(issuesOf({
        headers: { [shouted]: 'x' },
      })).toEqual([
        { path: `p.headers.${shouted}`, message: 'is the header that carries the key: set apiKey instead' },
      ])
      expect(issuesOf({
        auth: { header: 'Host' },
      })).toEqual([
        { path: 'p.auth.header', message: 'must not be content-type, content-length or host' },
      ])
      for (const name of Object.keys(subject.fixedHeaders).map(fixed => fixed.toUpperCase())) {
        expect(issuesOf({
          auth: { header: name },
        }), name).toEqual([
          { path: 'p.auth.header', message: 'is set by the adapter and cannot be replaced' },
        ])
      }
      expect(issuesOf({
        auth: { header: 'X-Key', prefix: 'Bearer\t' },
      })).toEqual([
        { path: 'p.auth.prefix', message: 'must only contain printable ASCII characters' },
      ])
    })

    it('redacts its key, its base URL path and its header values from an error, and does not follow redirects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('key sk-k on /gw-secret/v1 refused, x-gateway-token: gw-tok-123', 401)))
      await expect(subject.make({
        ...base,
        baseUrl: 'https://h.example/gw-secret/v1',
        apiKey: 'sk-k',
        headers: { 'X-Gateway-Token': 'gw-tok-123' },
      }).complete(request))
        .rejects
        .toMatchObject({
          kind: 'http',
          status: 401,
          retryable: false,
          message: 'p: HTTP 401: "key [redacted] on [redacted] refused, x-gateway-token: [redacted]"',
        })
      expect((await send()).init.redirect).toBe('manual')
    })

    it('returns the text, the model and the usage of a recorded reply', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonReply(subject.replies.ok)))
      await expect(subject.make(base).complete(request)).resolves.toEqual({ text: '{}', model: subject.replies.model, usage: subject.replies.usage })
    })

    it('maps a recorded refusal, when the protocol has one, to a refusal and a recorded truncation to truncated, neither retryable', async () => {
      const cases: Array<[unknown, ProviderErrorKind, object]> = [
        [
          subject.replies.truncated,
          'truncated',
          { usage: subject.replies.usage },
        ],
      ]
      if (subject.replies.refusal !== undefined) cases.unshift([subject.replies.refusal, 'refusal', {}])
      for (const [reply, kind, extra] of cases) {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonReply(reply)))
        await expect(subject.make(base).complete(request), kind).rejects.toMatchObject({
          name: 'ProviderError',
          kind,
          retryable: false,
          providerId: 'p',
          ...extra,
        })
      }
    })

    it('reports a 5xx or 429 as retryable, another status as not, and a body that is not a JSON object as invalid-response', async () => {
      for (const [status, retryable] of [
        [503, true],
        [429, true],
        [400, false],
        [404, false],
      ] as const) {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply('nope', status)))
        await expect(subject.make(base).complete(request), String(status)).rejects.toMatchObject({
          kind: 'http',
          status,
          retryable,
          message: `p: HTTP ${status}: "nope"`,
        })
      }
      for (const body of ['<html>', '[]', 'null']) {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => textReply(body, 200)))
        await expect(subject.make(base).complete(request), body).rejects.toMatchObject({ kind: 'invalid-response', retryable: false })
      }
    })

    it('passes the request signal to fetch', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => jsonReply(subject.replies.ok))
      vi.stubGlobal('fetch', fetchMock)
      const signal = new AbortController().signal
      await subject.make(base).complete({ ...request, signal })
      expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].signal).toBe(signal)
    })
  })
}
