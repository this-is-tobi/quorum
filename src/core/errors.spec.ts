import { describe, expect, it } from 'vitest'
import { ProviderError, QuorumError } from './errors.ts'
import type { ProviderErrorKind } from './errors.ts'

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
    ['process', 1, false],
  ] as Array<[ProviderErrorKind, number | undefined, boolean]>)('marks a %s error with status %s as retryable=%s', (kind, status, retryable) => {
    expect(new ProviderError({ providerId: 'p', kind, message: 'm', status }).retryable).toBe(retryable)
  })

  it('prefixes the message with the provider id and keeps the kind, the status and the cause', () => {
    const cause = new Error('socket closed')
    const error = new ProviderError({ providerId: 'research', kind: 'http', status: 502, message: 'HTTP 502', cause })
    expect(error).toBeInstanceOf(QuorumError)
    expect(error).toMatchObject({ name: 'ProviderError', message: 'research: HTTP 502', providerId: 'research', kind: 'http', status: 502, cause })
  })
})
