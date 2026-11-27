import { describe, expect, it } from 'vitest'
import { cutRead, MAX_REPORT_BYTES, MAX_REPORTS, MAX_RESULTS, MAX_RUNS, READ_COMMIT, READ_MESSAGE, READ_RULE_ID, READ_RULE_TEXT, READ_SCANNER, READ_SNIPPET, SONARQUBE_SEARCH_CAP } from './reports.ts'

describe('the read bounds', () => {
  it('are the values the spec fixes', () => {
    expect({
      MAX_REPORT_BYTES,
      MAX_REPORTS,
      MAX_RUNS,
      MAX_RESULTS,
      SONARQUBE_SEARCH_CAP,
    }).toEqual({
      MAX_REPORT_BYTES: 16 * 1024 * 1024,
      MAX_REPORTS: 16,
      MAX_RUNS: 20,
      MAX_RESULTS: 25_000,
      SONARQUBE_SEARCH_CAP: 10_000,
    })
    expect({
      READ_MESSAGE,
      READ_RULE_TEXT,
      READ_RULE_ID,
      READ_SCANNER,
      READ_SNIPPET,
      READ_COMMIT,
    }).toEqual({
      READ_MESSAGE: 2000,
      READ_RULE_TEXT: 8192,
      READ_RULE_ID: 1024,
      READ_SCANNER: 256,
      READ_SNIPPET: 2000,
      READ_COMMIT: 64,
    })
  })
})

describe('cutRead', () => {
  it('hands a text within its bound over as it is, the same string', () => {
    const text = 'a'.repeat(10)
    expect(Object.is(cutRead(text, 10), text)).toBe(true)
    expect(cutRead('', 0)).toBe('')
    expect(cutRead('abc', 5)).toBe('abc')
  })

  it('cuts a longer text to its bound in UTF-16 units', () => {
    expect(cutRead('abcdef', 3)).toBe('abc')
    expect(cutRead('é'.repeat(10), 4)).toBe('éééé')
    expect(cutRead('abc', 0)).toBe('')
  })

  it('leaves out the high half of a surrogate pair its bound would cut in two', () => {
    const emoji = String.fromCodePoint(0x1F600)
    expect(cutRead(`ab${emoji}`, 3)).toBe('ab')
    expect(cutRead(`ab${emoji}`, 4)).toBe(`ab${emoji}`)
    expect(cutRead(`${emoji}${emoji}`, 3)).toBe(emoji)
    expect(cutRead(`${emoji}ab`, 1)).toBe('')
  })

  it('keeps a lone high surrogate that ends the text within its bound, which the core cleans', () => {
    const high = String.fromCharCode(0xD83D)
    expect(cutRead(`ab${high}`, 3)).toBe(`ab${high}`)
  })
})
