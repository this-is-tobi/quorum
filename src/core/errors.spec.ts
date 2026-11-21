import { describe, expect, it } from 'vitest'
import { ConfigError, downWords, issuePath, lackWords, ProviderDownError, ProviderError, QuorumError } from './errors.ts'
import type { ConfigIssue, ProviderErrorKind, ReplyLack } from './errors.ts'

describe('provider errors', () => {
  it.each([
    ['http', 408, true],
    ['http', 409, true],
    ['http', 429, true],
    ['http', 500, true],
    ['http', 503, true],
    ['http', 504, true],
    ['http', 400, false],
    ['http', 401, false],
    ['http', 404, false],
    ['network', undefined, true],
    ['timeout', undefined, true],
    ['aborted', undefined, false],
    ['refusal', undefined, false],
    ['truncated', undefined, false],
    ['invalid-response', undefined, false],
    ['unsupported', undefined, false],
    ['too-large', undefined, false],
    ['process', 1, false],
  ] as Array<[ProviderErrorKind, number | undefined, boolean]>)('marks a %s error with status %s as retryable=%s', (kind, status, retryable) => {
    expect(new ProviderError({
      providerId: 'p',
      kind,
      message: 'm',
      status,
    }).retryable).toBe(retryable)
  })

  it('prefixes the message with the provider id and keeps the kind, the status and the cause', () => {
    const cause = new Error('socket closed')
    const error = new ProviderError({
      providerId: 'research',
      kind: 'http',
      status: 502,
      message: 'HTTP 502',
      cause,
    })
    expect(error).toBeInstanceOf(QuorumError)
    expect(error).toMatchObject({
      name: 'ProviderError',
      message: 'research: HTTP 502',
      providerId: 'research',
      kind: 'http',
      status: 502,
      cause,
    })
  })

  it('derives retryable from its kind and status unless it is given one, and keeps the hint it is given', () => {
    const details = { providerId: 'p', message: 'm' } as const
    expect(new ProviderError({
      ...details,
      kind: 'http',
      status: 400,
      retryable: true,
    }).retryable).toBe(true)
    expect(new ProviderError({
      ...details,
      kind: 'http',
      status: 503,
      retryable: false,
    }).retryable).toBe(false)
    expect(new ProviderError({ ...details, kind: 'http', status: 503 }).retryable).toBe(true)
    expect(new ProviderError({
      ...details,
      kind: 'http',
      status: 429,
      retryAfterMs: 1500,
    }).retryAfterMs).toBe(1500)
    expect(new ProviderError({ ...details, kind: 'http', status: 429 }).retryAfterMs).toBeUndefined()
  })

  it('keeps the usage it is given, and holds undefined when it is given none', () => {
    const details = { providerId: 'p', kind: 'truncated', message: 'm' } as const
    expect(new ProviderError({
      ...details,
      usage: { inputTokens: 10, outputTokens: 20 },
    }).usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(new ProviderError(details).usage).toBeUndefined()
  })
})

describe('a provider that is down', () => {
  it.each<[string, ProviderErrorKind, number | undefined, string]>([
    [
      'network',
      'network',
      undefined,
      'check that the server at its origin is running',
    ],
    [
      'timeout',
      'timeout',
      undefined,
      'raise timeoutMs',
    ],
    [
      'http 401',
      'http',
      401,
      'check apiKey',
    ],
    [
      'http 403',
      'http',
      403,
      'check apiKey',
    ],
    [
      'http 404',
      'http',
      404,
      'check baseUrl and model',
    ],
    [
      'http 429',
      'http',
      429,
      'lower concurrency or wait',
    ],
    [
      'http 503',
      'http',
      503,
      'lower concurrency or wait',
    ],
    [
      'http 418',
      'http',
      418,
      'check the provider\'s settings',
    ],
    [
      'invalid-response',
      'invalid-response',
      undefined,
      'check protocol and baseUrl',
    ],
  ])('words a provider down after %s with its fix', (_name, kind, status, fix) => {
    const failure = status === undefined
      ? kind
      : `${kind} ${status}`
    expect(downWords({
      providerId: 'api',
      kind,
      status,
      count: 3,
      streak: true,
    })).toBe(`api: 3 calls in a row failed (${failure}): no more calls go to it in this review: ${fix}`)
  })

  it('words a provider whose one call failed, and one whose two did', () => {
    expect(downWords({
      providerId: 'api',
      kind: 'http',
      status: 401,
      count: 1,
      streak: false,
    })).toBe('api: its one call failed (http 401): check apiKey')
    expect(downWords({
      providerId: 'api',
      kind: 'process',
      count: 2,
      streak: false,
    })).toBe('api: its 2 calls failed (process): check command')
  })

  it('words the kinds that have a fix of their own, and any other with the provider\'s settings', () => {
    expect(downWords({
      providerId: 'api',
      kind: 'unsupported',
      count: 3,
      streak: true,
    })).toContain('check the provider\'s settings')
    expect(downWords({
      providerId: 'api',
      kind: 'http',
      count: 3,
      streak: true,
    })).toBe('api: 3 calls in a row failed (http): no more calls go to it in this review: check the provider\'s settings')
  })

  it('keeps the last failure as the cause, and is no ProviderError', () => {
    const cause = new ProviderError({ providerId: 'api', kind: 'network', message: 'fetch failed' })
    const error = new ProviderDownError({
      providerId: 'api',
      kind: 'network',
      count: 3,
      streak: true,
      cause,
    })
    expect(error).toBeInstanceOf(QuorumError)
    expect(error).not.toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({
      name: 'ProviderDownError',
      message: downWords({
        providerId: 'api',
        kind: 'network',
        count: 3,
        streak: true,
      }),
      providerId: 'api',
      kind: 'network',
      status: undefined,
      count: 3,
      streak: true,
      cause,
    })
    expect('cause' in new ProviderDownError({
      providerId: 'api',
      kind: 'network',
      count: 1,
      streak: false,
    })).toBe(false)
  })
})

describe('what a reply lacked', () => {
  it.each<[string, 'truncated' | 'no-answer', ReplyLack, string]>([
    [
      'the window, below contextTokens',
      'truncated',
      {
        noAnswer: 'window',
        inputTokens: 30_100,
        outputTokens: 2668,
        window: 200_000,
      },
      'a reply ended at the server\'s window after 30100 input and 2668 output tokens, below contextTokens 200000: set contextTokens to at most 32768',
    ],
    [
      'the window, when its numbers reach contextTokens or are not all known',
      'truncated',
      {
        noAnswer: 'window',
        inputTokens: 30_100,
        outputTokens: 2668,
        window: 32_768,
      },
      'a reply ended at the server\'s window, which is smaller than contextTokens: lower contextTokens',
    ],
    [
      'a cut-off below the limit sent',
      'truncated',
      { noAnswer: 'reply', limit: 21_024, outputTokens: 8192 },
      'a reply was cut off at 8192 tokens, below the 21024 quorum asked for: the server caps replies near 8192: set maxTokens: 8192',
    ],
    [
      'a cut-off at a known limit',
      'truncated',
      { noAnswer: 'reply', limit: 16_000, outputTokens: 16_000 },
      'reply was cut off at its limit of 16000 tokens',
    ],
    [
      'a cut-off at a limit not known',
      'truncated',
      { noAnswer: 'reply' },
      'reply was cut off at its limit',
    ],
    [
      'reasoning that used a known limit',
      'truncated',
      { noAnswer: 'thinking', limit: 16_000, outputTokens: 16_000 },
      'reply was cut off at its limit of 16000 tokens while reasoning, before any answer',
    ],
    [
      'reasoning that used a limit not known',
      'truncated',
      { noAnswer: 'thinking' },
      'reply was cut off at its limit while reasoning, before any answer',
    ],
    [
      'a reply with only reasoning',
      'no-answer',
      { noAnswer: 'thinking' },
      'reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt',
    ],
    [
      'a reply with nothing',
      'no-answer',
      { noAnswer: 'empty' },
      'reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
  ])('words a reply that lacked its answer: %s', (_name, kind, lack, words) => {
    expect(lackWords(kind, lack)).toBe(words)
  })

  it('words a provider down by replies with no answer', () => {
    const only = 'had no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt'
    const nothing = 'had no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt'
    const facts = {
      providerId: 'api',
      kind: 'no-answer',
      count: 3,
      streak: true,
    } as const
    expect(downWords({ ...facts, noAnswer: 'thinking' })).toBe(`api: 3 calls in a row ${only}`)
    expect(downWords({ ...facts, noAnswer: 'empty' })).toBe(`api: 3 calls in a row ${nothing}`)
    expect(downWords({
      ...facts,
      count: 1,
      streak: false,
      noAnswer: 'thinking',
    })).toBe(`api: its one call ${only}`)
    expect(downWords({
      ...facts,
      count: 2,
      streak: false,
      noAnswer: 'empty',
    })).toBe(`api: its 2 calls ${nothing}`)
    expect(downWords(facts)).toBe(`api: 3 calls in a row ${nothing}`)
    expect(new ProviderDownError({ ...facts, noAnswer: 'thinking' })).toMatchObject({ kind: 'no-answer', noAnswer: 'thinking', message: `api: 3 calls in a row ${only}` })
  })
})

describe('issuePath', () => {
  it('joins safe names and indices with dots', () => {
    expect(issuePath([
      'providers',
      'local',
      'headers',
      'x-team',
    ])).toBe('providers.local.headers.x-team')
    expect(issuePath(['lenses', 0, 'id'])).toBe('lenses.0.id')
    expect(issuePath([
      'a'.repeat(64),
    ])).toBe('a'.repeat(64))
    expect(issuePath([])).toBe('')
  })

  it.each<[string, PropertyKey]>([
    ['a name past 64 characters', `sk-${'a'.repeat(62)}`],
    ['a line break', `x${String.fromCharCode(10)}y`],
    ['a dot', 'x.team'],
    ['a character outside ASCII', `tool${String.fromCharCode(0x17F)}`],
    ['an empty name', ''],
    [
      'a symbol',
      Symbol('s'),
    ],
  ])('prints %s as *', (_name, segment) => {
    expect(issuePath(['headers', segment])).toBe('headers.*')
  })
})

describe('config errors', () => {
  const issues = (count: number): ConfigIssue[] => Array.from({ length: count }, (_, index) => ({ path: `p${index}`, message: 'is wrong' }))

  it('lists up to 50 issues in its message, one per line', () => {
    const lines = new ConfigError(issues(50)).message.split('\n')
    expect(lines).toHaveLength(50)
    expect(lines.at(-1)).toBe('p49: is wrong')
  })

  it('lists the first 50 issues, then counts the rest, and keeps every one', () => {
    expect(new ConfigError(issues(51)).message.split('\n').slice(-2)).toEqual(['p49: is wrong', 'and 1 more issue'])
    const many = new ConfigError(issues(10_000))
    expect(many.message.split('\n')).toHaveLength(51)
    expect(many.message.split('\n').at(-1)).toBe('and 9950 more issues')
    expect(many.issues).toHaveLength(10_000)
  })

  it('prints an issue without a path as its message alone', () => {
    expect(new ConfigError([
      { path: '', message: 'no model configured' },
    ]).message).toBe('no model configured')
  })
})
