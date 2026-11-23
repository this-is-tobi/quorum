import { describe, expect, it } from 'vitest'
import type { Finding } from '../types.ts'
import { dedup } from './dedup.ts'

/** A finding as the research stage hands it on; the tests vary its location. */
const finding: Finding = {
  id: '235f5feb3565',
  fingerprint: '7e14f27a57f3c349:1',
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

  it('keeps, for one key, the finding the finder anchored itself over a moved one listed before it', () => {
    const moved = { ...finding, summary: 'decoy planted beside the real code', citedLine: 12 }
    const anchored = { ...finding, summary: 'command injection' }
    const other = { ...finding, line: 2 }
    // The kept finding holds the key's first place, so the order of the candidates is the order of their keys.
    expect(dedup([moved, other, anchored])).toEqual([anchored, other])
    expect(dedup([anchored, other, moved])).toEqual([anchored, other])
  })

  it('keeps the first of two moved findings of one key, and the first of two the finder anchored', () => {
    const first = { ...finding, summary: 'first', citedLine: 12 }
    const second = { ...finding, summary: 'second', citedLine: 20 }
    expect(dedup([first, second])).toEqual([first])
    const plain = { ...finding, summary: 'first' }
    expect(dedup([
      plain,
      { ...plain, summary: 'second' },
    ])).toEqual([plain])
  })

  it('keeps findings that differ only by category', () => {
    const a = { ...finding }
    const b = { ...finding, category: 'CWE-89' }
    expect(dedup([a, b])).toEqual([a, b])
  })

  it('keeps findings whose fields only collide once joined with colons', () => {
    const a = {
      ...finding,
      file: 'a.js',
      line: 1,
      category: 'CWE-79:5:XSS',
    }
    const b = {
      ...finding,
      file: 'a.js:1:CWE-79',
      line: 5,
      category: 'XSS',
    }
    expect(dedup([a, b])).toEqual([a, b])
  })
})
