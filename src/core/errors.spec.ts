import { describe, expect, it } from 'vitest'
import { ConfigError, issuePath, ProviderError, QuorumError } from './errors.ts'
import type { ConfigIssue, ProviderErrorKind } from './errors.ts'

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

  it('keeps the usage it is given, and holds undefined when it is given none', () => {
    const details = { providerId: 'p', kind: 'truncated', message: 'm' } as const
    expect(new ProviderError({
      ...details,
      usage: { inputTokens: 10, outputTokens: 20 },
    }).usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(new ProviderError(details).usage).toBeUndefined()
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
