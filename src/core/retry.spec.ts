import { describe, expect, it } from 'vitest'
import { isTimeout, retryWait } from './retry.ts'
import type { CallState, FailureFacts } from './retry.ts'

const network: FailureFacts = {
  kind: 'network',
  status: undefined,
  retryable: true,
  retryAfterMs: undefined,
}
const timeout: FailureFacts = {
  kind: 'timeout',
  status: undefined,
  retryable: true,
  retryAfterMs: undefined,
}
function http(status: number, retryAfterMs?: unknown): FailureFacts {
  return {
    kind: 'http',
    status,
    retryable: true,
    retryAfterMs,
  }
}
const first: CallState = {
  retried: 0,
  retries: 5,
  timedOut: false,
  timeLeftMs: 1_800_000,
}

describe('retryWait', () => {
  it.each<[string, FailureFacts, CallState]>([
    [
      'a refusal',
      { ...network, kind: 'refusal', retryable: false },
      first,
    ],
    [
      'a reply cut off',
      { ...network, kind: 'truncated' },
      first,
    ],
    [
      'an unusable reply',
      { ...network, kind: 'invalid-response' },
      first,
    ],
    [
      'a request too large',
      { ...network, kind: 'too-large' },
      first,
    ],
    [
      'a process failure',
      { ...network, kind: 'process' },
      first,
    ],
    [
      'an unsupported request',
      { ...network, kind: 'unsupported' },
      first,
    ],
    [
      'an aborted call',
      { ...network, kind: 'aborted' },
      first,
    ],
    [
      'an HTTP 400',
      {
        ...http(400),
        retryable: false,
      },
      first,
    ],
    [
      'a value that does not say it may be retried',
      { ...network, retryable: undefined },
      first,
    ],
    [
      'a retryable of the string true',
      { ...network, retryable: 'true' },
      first,
    ],
    [
      'a call whose retries are spent',
      network,
      { ...first, retried: 2, retries: 2 },
    ],
    [
      'a call that states none',
      network,
      { ...first, retries: 0 },
    ],
    [
      'a call whose retry count is not a number',
      network,
      {
        retried: 0,
        retries: Number.NaN,
        timedOut: false,
        timeLeftMs: 1_800_000,
      },
    ],
    [
      'a second timeout',
      timeout,
      { ...first, timedOut: true },
    ],
    [
      'a 504 after a timeout',
      http(504),
      { ...first, timedOut: true },
    ],
    [
      'a 524 after a timeout',
      http(524),
      { ...first, timedOut: true },
    ],
    [
      'a 429 whose hint is 60001',
      http(429, 60_001),
      first,
    ],
  ])('never retries %s', (_name, failure, call) => {
    expect(retryWait(failure, call, () => 0.5)).toBeUndefined()
  })

  it('backs off uniform(0, min(8000, 500 x 2^n)) before retry n, the first retry being n = 0', () => {
    const waits = [0, 1, 2, 3, 4].map(retried => retryWait(network, { ...first, retried }, () => 0.5))
    expect(waits).toEqual([250, 500, 1000, 2000, 4000])
    expect(retryWait(network, first, () => 0)).toBe(0)
    expect(retryWait(network, { ...first, retried: 4 }, () => 0.999)).toBe(7992)
  })

  it('waits a server hint above 0 and up to 60000 ms in place of the backoff, plus up to a second', () => {
    expect(retryWait(http(429, 2000), first, () => 0.5)).toBe(2500)
    expect(retryWait(http(429, 60_000), first, () => 0.5)).toBe(60_500)
    expect(retryWait(http(429, 1), first, () => 0)).toBe(1)
  })

  it('ends the call on a hint longer than the time the review has left, and waits one that fits', () => {
    expect(retryWait(http(429, 2000), { ...first, timeLeftMs: 1999 }, () => 0.5)).toBeUndefined()
    expect(retryWait(http(429, 2000), { ...first, timeLeftMs: 2000 }, () => 0.5)).toBe(2500)
  })

  it('takes a hint of 0, a negative one or one that is not a finite number for none, and backs off', () => {
    for (const hint of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '2000',
    ]) {
      expect(retryWait(http(429, hint), first, () => 0.5)).toBe(250)
    }
  })

  it('retries a call\'s first timeout once, a 504 or 524 included, and a failure that passes after a timeout', () => {
    for (const failure of [
      timeout,
      http(504),
      http(524),
    ]) {
      expect(retryWait(failure, first, () => 0.5)).toBe(250)
    }
    expect(retryWait(http(503), { ...first, timedOut: true }, () => 0.5)).toBe(250)
  })
})

describe('isTimeout', () => {
  it('reads a timeout as the core\'s deadline or a gateway\'s 504 or 524', () => {
    expect(isTimeout(timeout)).toBe(true)
    expect(isTimeout(http(504))).toBe(true)
    expect(isTimeout(http(524))).toBe(true)
    expect(isTimeout(http(503))).toBe(false)
    expect(isTimeout(network)).toBe(false)
  })
})
