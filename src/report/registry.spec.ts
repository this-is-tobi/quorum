import { describe, expect, it } from 'vitest'
import { inertJson } from '../core/sanitize.ts'
import { LIFTED, reportResult } from '../testing/report.ts'
import { renderReport } from './registry.ts'

describe('renderReport', () => {
  it('renders json as inertJson writes the result, then a line feed', () => {
    const result = reportResult()
    expect(renderReport(result, { format: 'json' })).toBe(`${inertJson(result)}\n`)
  })

  it('refuses a format it does not know, naming the formats', () => {
    expect(() => renderReport(reportResult(), { format: 'xml' } as never)).toThrow(expect.objectContaining({
      name: 'ConfigError',
      message: 'format: must be json or brief',
      issues: [
        { path: 'format', message: 'must be json or brief' },
      ],
    }))
  })

  it('computes the outcome when none is given, and renders the one given', () => {
    const result = reportResult()
    expect(renderReport(result, { format: 'brief' }).endsWith('; exit 1\n')).toBe(true)
    expect(renderReport(result, { format: 'brief', outcome: LIFTED }).startsWith('quorum: pass:')).toBe(true)
  })
})
