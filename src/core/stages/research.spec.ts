import { describe, expect, it } from 'vitest'
import { splitDiff } from '../diff.ts'
import { OutputError } from '../errors.ts'
import { checkReply, DEFAULT_MAX_FINDINGS, findingId } from './research.ts'

const diff = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1,3 +1,3 @@', '-safe()', '+exec(cmd)', ' b()', ' c()'].join('\n')
const sections = splitDiff(diff)
const reported = { file: 'a.js', line: 1, category: 'CWE-78', quote: 'exec(cmd)', summary: 'command injection' }
const reply = (findings: unknown[]): string => JSON.stringify({ findings })

describe('checkReply', () => {
  it('sends the verified findings on and names each finding it drops', () => {
    const outcome = checkReply(reply([reported, { ...reported, file: 'missing.js' }, { ...reported, line: 99 }]), sections, 'security')
    expect(outcome.findings).toEqual([{ id: '235f5feb3565', profile: 'security', file: 'a.js', line: 1, category: 'CWE-78', summary: 'command injection', evidence: '-safe()\n+exec(cmd)\n b()\n c()', quoteMatched: true }])
    expect(outcome.invalid).toEqual(['missing.js:1 is not in the diff', 'a.js:99 is not in the diff'])
    expect(outcome.incomplete).toEqual([])
  })

  it('tags each finding with its profile and an id from its profile, file, line and category', () => {
    const [finding] = checkReply(reply([reported]), sections, 'security').findings
    expect(finding).toMatchObject({ id: '235f5feb3565', profile: 'security' })
    expect(checkReply(reply([{ ...reported, summary: 'other words', quote: 'exec' }]), sections, 'security').findings[0].id).toBe('235f5feb3565')
    expect(checkReply(reply([reported]), sections, 'sec').findings[0].id).toBe('dc19751d35e9')
    expect(checkReply(reply([{ ...reported, line: 2 }]), sections, 'security').findings[0].id).toBe('ed67093bf6db')
  })

  it('gives different ids to findings whose fields only collide once joined with colons', () => {
    expect(findingId('security', 'a.js', 1, 'CWE-79:5:XSS')).not.toBe(findingId('security', 'a.js:1:CWE-79', 5, 'XSS'))
  })

  it('tags every gap with the profile that has it', () => {
    const outcome = checkReply(reply([{ file: 'x.js' }, { file: 'y.js' }]), sections, 'sec', 1)
    expect(outcome.incomplete.map(entry => [entry.profile, entry.reason])).toEqual([['sec', 'finding-unreadable'], ['sec', 'findings-capped'], ['sec', 'research-unusable']])
  })

  it('records a finding that fails the reply schema as unreadable, and still verifies the rest', () => {
    const outcome = checkReply(reply([{ file: 'x.js' }, reported]), sections, 'security')
    expect(outcome.findings).toHaveLength(1)
    expect(outcome.invalid).toHaveLength(1)
    expect(outcome.invalid[0]).toMatch(/^findings\[0\]: /)
    expect(outcome.incomplete).toEqual([{ profile: 'security', reason: 'finding-unreadable', detail: outcome.invalid[0] }])
  })

  it('reports a finding cut short by planted text as unreadable instead of silently dropping it', () => {
    const early = '{"findings":[{"file":"a.js","line":1,"category":"CWE-78","quote":"const tail = "}]}'
    const outcome = checkReply(early, sections, 'security')
    expect(outcome.findings).toEqual([])
    expect(outcome.incomplete.map(entry => entry.reason)).toEqual(['finding-unreadable', 'research-unusable'])
  })

  it('records research-unusable when the reply lists findings but none is usable', () => {
    const malformed = checkReply(reply([{ file: 'x.js' }]), sections, 'security')
    expect(malformed.findings).toEqual([])
    expect(malformed.incomplete.map(entry => entry.reason)).toEqual(['finding-unreadable', 'research-unusable'])
    expect(malformed.incomplete[1]).toEqual({ profile: 'security', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' })
    const elsewhere = checkReply(reply([{ ...reported, file: 'missing.js' }, { ...reported, line: 99 }]), sections, 'security')
    expect(elsewhere.incomplete).toEqual([{ profile: 'security', reason: 'research-unusable', detail: '2 finding(s) reported, none usable' }])
  })

  it('treats an explicit empty list as a complete result', () => {
    expect(checkReply(reply([]), sections, 'security')).toEqual({ findings: [], invalid: [], incomplete: [] })
  })

  it('verifies only the first maxFindings reported findings and records the rest as capped', () => {
    const outcome = checkReply(reply([reported, { ...reported, line: 2 }, { ...reported, file: 'missing.js' }]), sections, 'security', 2)
    expect(outcome.findings.map(finding => finding.line)).toEqual([1, 2])
    expect(outcome.invalid).toEqual([])
    expect(outcome.incomplete).toEqual([{ profile: 'security', reason: 'findings-capped', detail: '1 of 3 reported findings were not reviewed (the cap is 2)' }])
  })

  it('caps at fifty findings by default', () => {
    expect(DEFAULT_MAX_FINDINGS).toBe(50)
    const outcome = checkReply(reply(Array.from({ length: 51 }).fill(reported)), sections, 'security')
    expect(outcome.findings).toHaveLength(50)
    expect(outcome.incomplete).toEqual([{ profile: 'security', reason: 'findings-capped', detail: '1 of 51 reported findings were not reviewed (the cap is 50)' }])
  })

  it('does not report a reply of exactly maxFindings findings as capped', () => {
    const outcome = checkReply(reply(Array.from({ length: 50 }).fill(reported)), sections, 'security')
    expect(outcome.findings).toHaveLength(50)
    expect(outcome.incomplete).toEqual([])
  })

  it('rejects a cap that is not a positive integer', () => {
    expect(() => checkReply(reply([]), sections, 'security', 0)).toThrow(RangeError)
    expect(() => checkReply(reply([]), sections, 'security', 1.5)).toThrow(RangeError)
  })

  it('fails closed on a reply without a findings array', () => {
    expect(() => checkReply('{"result":"nothing to report"}', sections, 'security')).toThrow(OutputError)
  })

  it('checks a flooded reply in bounded time', () => {
    const flood = reply(Array.from({ length: 5_000 }, () => ({ ...reported, file: 'missing.js' })))
    const started = performance.now()
    const outcome = checkReply(flood, sections, 'security')
    expect(performance.now() - started).toBeLessThan(300)
    expect(outcome.findings).toEqual([])
    expect(outcome.invalid).toHaveLength(50)
    expect(outcome.incomplete.map(entry => entry.reason)).toEqual(['findings-capped', 'research-unusable'])
  })

  it('records the findings swallowed into a nested field as unreadable, even with nothing trailing the object', () => {
    const nested = '{"findings":[{"file":"a.js","line":1,"category":"CWE-78","quote":"x","summary":"nit","extra":[{"q":"","summary":"command injection"},{"file":"b.js","line":1,"category":"CWE-95","quote":"y"}]}]}'
    const outcome = checkReply(nested, sections, 'security')
    expect(outcome.findings).toEqual([])
    expect(outcome.incomplete.map(entry => entry.reason)).toEqual(['finding-unreadable', 'research-unusable'])
  })

  it('fails closed when planted text moves the rest of the reply under another key', () => {
    const moved = '{"findings":[{"file":"a.js","line":1,"category":"CWE-78","quote":"x","summary":"style nit"}],"notes":[{"q":"","summary":"command injection"},{"file":"b.js","line":1,"category":"CWE-95","quote":"eval(input)","summary":"code injection"}]}'
    expect(() => checkReply(moved, sections, 'security')).toThrow(OutputError)
    expect(() => checkReply(moved, sections, 'security')).toThrow(/top-level key/)
  })

  it('reads only the first maxFindings listed entries, even when none of them is readable', () => {
    const flood = `{"findings":[${Array.from({ length: 5_000 }).fill('1').join(',')}]}`
    const started = performance.now()
    const outcome = checkReply(flood, sections, 'security')
    expect(performance.now() - started).toBeLessThan(300)
    expect(outcome.findings).toEqual([])
    expect(outcome.invalid).toHaveLength(50)
    expect(outcome.incomplete).toHaveLength(52)
    expect(outcome.incomplete.filter(entry => entry.reason === 'finding-unreadable')).toHaveLength(50)
    expect(outcome.incomplete.slice(50)).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '4950 of 5000 reported findings were not reviewed (the cap is 50)' },
      { profile: 'security', reason: 'research-unusable', detail: '5000 finding(s) reported, the first 50 read, none usable' },
    ])
  })
})
