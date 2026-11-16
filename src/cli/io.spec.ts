import { describe, expect, it } from 'vitest'
import { WriteFailure } from '../bench/run-dir.ts'
import { ConfigError, OutputError, ProviderError } from '../core/errors.ts'
import { GitError } from '../git/run.ts'
import { errorLines } from './io.ts'

const outputError = new OutputError('research', 'reply contains no JSON object', 'SNIPPET-CANARY')
const serverError = new ProviderError({
  providerId: 'default',
  kind: 'http',
  status: 500,
  message: 'HTTP 500: "SERVER-CANARY"',
})
const networkError = new ProviderError({ providerId: 'default', kind: 'network', message: 'cannot reach 10.0.0.1:11434' })
const gitError = new GitError('git diff failed (exit 128): "GIT-CANARY"', 'diff', 128)
const rangeError = new ConfigError([
  { path: '--range', message: 'takes one range' },
])

describe('errorLines', () => {
  it.each<[string, unknown, string]>([
    ['an unusable reply', outputError, 'Error: research reply unusable: reply contains no JSON object'],
    ['a provider\'s HTTP error', serverError, 'Error: default: the call failed (http 500)'],
    ['a provider\'s network error', networkError, 'Error: default: the call failed (network)'],
    ['a failed git command', gitError, 'Error: git diff failed (exit 128)'],
    [
      'any other error',
      new Error('OTHER-CANARY'),
      'Error: the review failed',
    ],
    ['a configuration error', rangeError, 'Error: --range: takes one range'],
    [
      'a file that cannot be written, whose message holds no path',
      new WriteFailure('--output json: cannot be written (EACCES)'),
      'Error: --output json: cannot be written (EACCES)',
    ],
  ])('writes %s in fixed words under the public view', (_name, error, expected) => {
    expect(errorLines(error, 'public')).toBe(expected)
  })

  it('writes every failure as before under the full view', () => {
    expect(errorLines(outputError)).toBe('Error: research reply unusable: reply contains no JSON object (reply starts: "SNIPPET-CANARY")')
    expect(errorLines(serverError, 'full')).toBe('Error: default: HTTP 500: "SERVER-CANARY"')
    expect(errorLines(networkError)).toBe('Error: default: cannot reach 10.0.0.1:11434')
    expect(errorLines(gitError)).toBe('Error: git diff failed (exit 128): "GIT-CANARY"')
    expect(errorLines(new Error('OTHER-CANARY'))).toBe('Error: OTHER-CANARY')
    expect(errorLines(rangeError)).toBe('Error: --range: takes one range')
    expect(errorLines(new ConfigError([
      { path: 'a', message: 'one' },
      { path: 'b', message: 'two' },
    ]), 'public')).toBe('Error: a: one\nb: two')
    expect(errorLines(new GitError('GIT-CANARY', 'version'), 'public')).toBe('Error: git version failed')
    expect(errorLines(new ProviderError({ providerId: 'default', kind: 'timeout', message: 'SERVER-CANARY' }), 'public')).toBe('Error: default: the call failed (timeout)')
  })
})
