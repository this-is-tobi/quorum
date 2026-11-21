import { describe, expect, it } from 'vitest'
import { createHealth, DOWN_AFTER, DOWN_KINDS } from './down.ts'
import { ProviderDownError, ProviderError } from './errors.ts'
import type { NoAnswer, ProviderErrorKind } from './errors.ts'
import { LimitError } from './limits.ts'
import type { Provider } from './ports.ts'

function provider(id = 'api'): Provider {
  return {
    id,
    model: 'm',
    complete: async () => ({ text: '', model: 'm' }),
  }
}

function failure(kind: ProviderErrorKind, status?: number, noAnswer?: NoAnswer): ProviderError {
  return new ProviderError({
    providerId: 'api',
    kind,
    message: 'it failed',
    status,
    noAnswer,
  })
}

describe('a provider being down', () => {
  it('finds a provider down at its first used-up quota, its error exhausted', () => {
    const health = createHealth()
    const api = provider()
    const error = new ProviderError({
      providerId: 'p',
      kind: 'http',
      status: 429,
      exhausted: true,
      message: 'x',
    })
    const down = health.failed(api, 'api', error)
    expect(down).toBeInstanceOf(ProviderDownError)
    expect(down).toMatchObject({
      count: 1,
      streak: true,
      exhausted: true,
      status: 429,
    })
    expect(health.refused(api)).toBe(down)
    expect(health.failed(api, 'api', error)).toBeUndefined()
  })

  it('reads exhausted on an http failure alone', () => {
    const health = createHealth()
    const api = provider()
    const error = { kind: 'network', exhausted: true }
    expect(health.failed(api, 'api', error)).toBeUndefined()
    expect(health.failed(api, 'api', error)).toBeUndefined()
    expect(health.failed(api, 'api', error)).toMatchObject({ count: 3, exhausted: false })
  })

  it('states the streak that finds a provider down and the kinds of failure that count toward it', () => {
    expect(DOWN_AFTER).toBe(3)
    expect([...DOWN_KINDS].sort()).toEqual([
      'http',
      'invalid-response',
      'network',
      'no-answer',
      'process',
      'timeout',
      'unsupported',
    ])
  })

  it.each<[string, ProviderErrorKind, number | undefined, NoAnswer | undefined]>([
    ['http 503', 'http', 503, undefined],
    [
      'network',
      'network',
      undefined,
      undefined,
    ],
    [
      'timeout',
      'timeout',
      undefined,
      undefined,
    ],
    [
      'process',
      'process',
      undefined,
      undefined,
    ],
    [
      'unsupported',
      'unsupported',
      undefined,
      undefined,
    ],
    [
      'invalid-response',
      'invalid-response',
      undefined,
      undefined,
    ],
    [
      'no-answer',
      'no-answer',
      undefined,
      'thinking',
    ],
  ])('counts a call that ended with %s toward a provider being down', (_name, kind, status, noAnswer) => {
    const health = createHealth()
    const api = provider()
    const error = failure(kind, status, noAnswer)
    expect(health.failed(api, 'api', error)).toBeUndefined()
    expect(health.failed(api, 'api', error)).toBeUndefined()
    expect(health.refused(api)).toBeUndefined()
    const down = health.failed(api, 'api', error)
    expect(down).toBeInstanceOf(ProviderDownError)
    expect(down).toMatchObject({
      providerId: 'api',
      kind,
      status,
      noAnswer,
      count: 3,
      streak: true,
      cause: error,
    })
    expect(health.refused(api)).toBe(down)
  })

  it.each<[string, unknown]>([
    [
      'refusal',
      failure('refusal'),
    ],
    [
      'truncated',
      failure('truncated'),
    ],
    [
      'too-large',
      failure('too-large'),
    ],
    [
      'aborted',
      failure('aborted'),
    ],
    [
      'a LimitError',
      new LimitError('token-cap', 'no room'),
    ],
    [
      'a plain Error with no kind',
      new Error('it failed'),
    ],
    [
      'a kind that is markup',
      { kind: '<b>x</b>' },
    ],
  ])('leaves a provider up after %s, however many end so', (_name, error) => {
    const health = createHealth()
    const api = provider()
    for (let calls = 0; calls < 10; calls++) expect(health.failed(api, 'api', error)).toBeUndefined()
    expect(health.refused(api)).toBeUndefined()
  })

  it('reports the first failure that finds it down, and no later one', () => {
    const health = createHealth()
    const api = provider()
    for (let calls = 0; calls < 2; calls++) health.failed(api, 'api', failure('network'))
    const down = health.failed(api, 'api', failure('network'))
    expect(down).toBeDefined()
    expect(health.failed(api, 'api', failure('network'))).toBeUndefined()
    expect(health.refused(api)).toBe(down)
  })

  it('starts the count again after a call that answered', () => {
    const health = createHealth()
    const api = provider()
    health.failed(api, 'api', failure('network'))
    health.failed(api, 'api', failure('network'))
    health.answered(api)
    health.failed(api, 'api', failure('network'))
    expect(health.failed(api, 'api', failure('network'))).toBeUndefined()
    expect(health.refused(api)).toBeUndefined()
    expect(health.failed(api, 'api', failure('network'))).toMatchObject({ count: 3 })
  })

  it('leaves the count as it is after a call that ended neutral', () => {
    const health = createHealth()
    const api = provider()
    health.failed(api, 'api', failure('network'))
    health.failed(api, 'api', failure('network'))
    health.failed(api, 'api', failure('truncated'))
    expect(health.failed(api, 'api', failure('network'))).toMatchObject({ count: 3 })
  })

  it('keeps a provider down for the review, whatever a call in flight answers', () => {
    const health = createHealth()
    const api = provider()
    for (let calls = 0; calls < 3; calls++) health.failed(api, 'api', failure('network'))
    health.answered(api)
    expect(health.refused(api)).toBeInstanceOf(ProviderDownError)
  })

  it('counts per provider object, not per id', () => {
    const health = createHealth()
    const first = provider('same')
    const second = provider('same')
    for (const api of [first, second, first, second]) health.failed(api, 'same', failure('network'))
    expect(health.refused(first)).toBeUndefined()
    expect(health.refused(second)).toBeUndefined()
  })

  it('finds a provider spent at the end when each of its fewer than three calls failed for a reason of its own, and not when one did not', () => {
    const health = createHealth()
    const one = provider('one')
    const mixed = provider('mixed')
    const idle = provider('idle')
    const answered = provider('answered')
    const down = provider('down')
    health.failed(one, 'one', failure('http', 401))
    health.failed(mixed, 'mixed', failure('http', 401))
    health.failed(mixed, 'mixed', failure('refusal'))
    health.failed(answered, 'answered', failure('http', 401))
    health.answered(answered)
    for (let calls = 0; calls < 3; calls++) health.failed(down, 'down', failure('network'))
    expect(health.spent(one, 'one')).toMatchObject({
      providerId: 'one',
      kind: 'http',
      status: 401,
      count: 1,
      streak: false,
      cause: expect.any(ProviderError),
    })
    expect(health.spent(mixed, 'mixed')).toBeUndefined()
    expect(health.spent(idle, 'idle')).toBeUndefined()
    expect(health.spent(answered, 'answered')).toBeUndefined()
    expect(health.spent(down, 'down')).toBeUndefined()
  })

  it('counts every call of a provider spent, and names the last failure', () => {
    const health = createHealth()
    const api = provider()
    const last = failure('process')
    health.failed(api, 'api', failure('http', 500))
    health.failed(api, 'api', last)
    expect(health.spent(api, 'api')).toMatchObject({
      kind: 'process',
      status: undefined,
      count: 2,
      streak: false,
      cause: last,
    })
  })
})
