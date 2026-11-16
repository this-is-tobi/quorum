import { describe, expect, it } from 'vitest'
import { harness } from '../testing/cli.ts'
import { reportPlan } from './outputs.ts'

describe('reportPlan', () => {
  const { io } = harness()

  it('writes json on stdout by default, and the format --format names', () => {
    expect(reportPlan({}, io)).toEqual({ format: 'json', color: false })
    expect(reportPlan({
      format: ['json'],
    }, io)).toEqual({ format: 'json', color: false })
    expect(reportPlan({
      format: ['brief'],
    }, io)).toEqual({ format: 'brief', color: false })
  })

  it.each<[{ format?: string[], 'print-config'?: boolean }, string]>([
    [
      {
        format: ['xml'],
      },
      '--format: must be json or brief',
    ],
    [
      {
        format: ['json', 'brief'],
      },
      '--format: takes one format',
    ],
    [
      {
        format: ['json'],
        'print-config': true,
      },
      '--print-config: prints the config as YAML, so it takes no --format',
    ],
  ])('refuses %j', (values, message) => {
    expect(() => reportPlan(values, io)).toThrow(expect.objectContaining({ name: 'ConfigError', message }))
  })
})
