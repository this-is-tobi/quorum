import { describe, expect, it } from 'vitest'
import type { Finding } from '../types.ts'
import { dedup } from './dedup.ts'

/** A finding as the research stage hands it on; the tests vary its location. */
const finding: Finding = {
  id: '235f5feb3565',
  profile: 'security',
  file: 'a.js',
  line: 1,
  category: 'CWE-78',
  summary: 'command injection',
  evidence: '-safe()\n+exec(cmd)',
  quoteMatched: true,
}

describe('dedup', () => {
  it('drops repeats keyed by file, line and category', () => {
    const a = { ...finding }
    const b = { ...finding, line: 2 }
    expect(dedup([a, b, a])).toEqual([a, b])
  })

  it('keeps findings that differ only by category', () => {
    const a = { ...finding }
    const b = { ...finding, category: 'CWE-89' }
    expect(dedup([a, b])).toEqual([a, b])
  })

  it('keeps findings whose fields only collide once joined with colons', () => {
    const a = { ...finding, file: 'a.js', line: 1, category: 'CWE-79:5:XSS' }
    const b = { ...finding, file: 'a.js:1:CWE-79', line: 5, category: 'XSS' }
    expect(dedup([a, b])).toEqual([a, b])
  })
})
