import { describe, expect, it } from 'vitest'
import { inertJson } from '../core/sanitize.ts'
import { LIFTED, reportResult } from '../testing/report.ts'
import { renderReport } from './registry.ts'
import { publicView } from './view.ts'

const ESC = String.fromCharCode(0x1B)

describe('renderReport', () => {
  it('renders json as inertJson writes the result, then a line feed', () => {
    const result = reportResult()
    expect(renderReport(result, { format: 'json' })).toBe(`${inertJson(result)}\n`)
  })

  it('renders the input it is given: json of a public view is the view', () => {
    const view = publicView(reportResult())
    expect(renderReport(view, { format: 'json' })).toBe(`${inertJson(view)}\n`)
    expect(renderReport(view, { format: 'json' })).not.toContain('"reasoning"')
    expect(renderReport(view, { format: 'brief' })).toBe(renderReport(reportResult(), { format: 'brief' }))
  })

  it('refuses a format it does not know, naming the formats', () => {
    expect(() => renderReport(reportResult(), { format: 'xml' } as never)).toThrow(expect.objectContaining({
      name: 'ConfigError',
      message: 'format: must be text, json, brief, markdown, payload or sarif',
      issues: [
        { path: 'format', message: 'must be text, json, brief, markdown, payload or sarif' },
      ],
    }))
  })

  it('colors the text report when asked and no other format, and nothing unless asked', () => {
    const result = reportResult()
    expect(renderReport(result, { format: 'text' })).not.toContain(ESC)
    expect(renderReport(result, { format: 'text', color: true })).toContain(`${ESC}[1;31mHIGH${ESC}[0m`)
    expect(renderReport(result, { format: 'json', color: true })).toBe(renderReport(result, { format: 'json' }))
    expect(renderReport(result, { format: 'brief', color: true })).toBe(renderReport(result, { format: 'brief' }))
  })

  it('computes the outcome when none is given, and renders the one given', () => {
    const result = reportResult()
    expect(renderReport(result, { format: 'brief' }).endsWith('; exit 1\n')).toBe(true)
    expect(renderReport(result, { format: 'brief', outcome: LIFTED }).startsWith('quorum: pass:')).toBe(true)
  })
})
