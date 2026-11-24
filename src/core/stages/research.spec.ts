import { describe, expect, it } from 'vitest'
import { splitDiff } from '../diff.ts'
import { OutputError } from '../errors.ts'
import { checkReplies, checkReply, DEFAULT_MAX_FINDINGS, findingFingerprint, findingId, FINGERPRINT_PATTERN } from './research.ts'

const diff = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1,3 +1,3 @@',
  '-safe()',
  '+exec(cmd)',
  ' b()',
  ' c()',
].join('\n')
const sections = splitDiff(diff)
const reported = {
  file: 'a.js',
  line: 1,
  category: 'CWE-78',
  quote: 'exec(cmd)',
  summary: 'command injection',
}
const reply = (findings: unknown[]): string => JSON.stringify({ findings })

describe('checkReply', () => {
  it('sends the verified findings on and names each finding it drops', () => {
    const outcome = checkReply(reply([
      reported,
      { ...reported, file: 'missing.js' },
      { ...reported, line: 99 },
    ]), sections, 'security')
    expect(outcome.findings).toEqual([
      {
        id: '235f5feb3565',
        fingerprint: '7e14f27a57f3c349:1',
        profile: 'security',
        file: 'a.js',
        line: 1,
        category: 'CWE-78',
        summary: 'command injection',
        evidence: '-safe()\n+exec(cmd)\n b()\n c()',
        evidenceRow: 1,
        quoteMatched: true,
      },
    ])
    expect(outcome.invalid).toEqual(['missing.js:1 is not in the diff', 'a.js:99 is not in the diff'])
    expect(outcome.incomplete).toEqual([])
  })

  it('tags each finding with its profile and an id from its profile, file, line and category', () => {
    const [finding] = checkReply(reply([reported]), sections, 'security').findings
    expect(finding).toMatchObject({ id: '235f5feb3565', profile: 'security' })
    expect(checkReply(reply([
      { ...reported, summary: 'other words', quote: 'exec' },
    ]), sections, 'security').findings[0].id).toBe('235f5feb3565')
    expect(checkReply(reply([reported]), sections, 'sec').findings[0].id).toBe('dc19751d35e9')
    expect(checkReply(reply([
      { ...reported, line: 2 },
    ]), sections, 'security').findings[0].id).toBe('ed67093bf6db')
  })

  it('gives different ids to findings whose fields only collide once joined with colons', () => {
    expect(findingId('security', 'a.js', 1, 'CWE-79:5:XSS')).not.toBe(findingId('security', 'a.js:1:CWE-79', 5, 'XSS'))
  })

  it('tags every gap with the profile that has it', () => {
    const outcome = checkReply(reply([
      { file: 'x.js' },
      { file: 'y.js' },
    ]), sections, 'sec', 1)
    expect(outcome.incomplete.map(entry => [entry.profile, entry.reason])).toEqual([
      ['sec', 'finding-unreadable'],
      ['sec', 'findings-capped'],
      ['sec', 'research-unusable'],
    ])
  })

  it('records a finding that fails the reply schema as unreadable, and still verifies the rest', () => {
    const outcome = checkReply(reply([
      { file: 'x.js' },
      reported,
    ]), sections, 'security')
    expect(outcome.findings).toHaveLength(1)
    expect(outcome.invalid).toEqual([])
    expect(outcome.incomplete).toEqual([
      {
        profile: 'security',
        reason: 'finding-unreadable',
        detail: expect.stringMatching(/^findings\[0\]: /),
      },
    ])
  })

  it('reports a finding cut short by planted text as unreadable instead of silently dropping it', () => {
    const early = '{"findings":[{"file":"a.js","line":1,"category":"CWE-78","quote":"const tail = "}]}'
    const outcome = checkReply(early, sections, 'security')
    expect(outcome.findings).toEqual([])
    expect(outcome.incomplete.map(entry => entry.reason)).toEqual(['finding-unreadable', 'research-unusable'])
  })

  it('records research-unusable when the reply lists findings but none is usable', () => {
    const malformed = checkReply(reply([
      { file: 'x.js' },
    ]), sections, 'security')
    expect(malformed.findings).toEqual([])
    expect(malformed.incomplete.map(entry => entry.reason)).toEqual(['finding-unreadable', 'research-unusable'])
    expect(malformed.incomplete[1]).toEqual({ profile: 'security', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' })
    const elsewhere = checkReply(reply([
      { ...reported, file: 'missing.js' },
      { ...reported, line: 99 },
    ]), sections, 'security')
    expect(elsewhere.incomplete).toEqual([
      { profile: 'security', reason: 'research-unusable', detail: '2 finding(s) reported, none usable' },
    ])
  })

  it('treats an explicit empty list as a complete result', () => {
    expect(checkReply(reply([]), sections, 'security')).toEqual({
      findings: [],
      invalid: [],
      invalidRules: [],
      incomplete: [],
    })
  })

  it('verifies only the first maxFindings reported findings and records the rest as capped', () => {
    const outcome = checkReply(reply([
      reported,
      { ...reported, line: 2 },
      { ...reported, file: 'missing.js' },
    ]), sections, 'security', 2)
    expect(outcome.findings.map(finding => finding.line)).toEqual([1, 2])
    expect(outcome.invalid).toEqual([])
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '1 of 3 reported findings were not reviewed (the cap is 2)' },
    ])
  })

  it('caps at fifty findings by default', () => {
    expect(DEFAULT_MAX_FINDINGS).toBe(50)
    const outcome = checkReply(reply(Array.from({ length: 51 }).fill(reported)), sections, 'security')
    expect(outcome.findings).toHaveLength(50)
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '1 of 51 reported findings were not reviewed (the cap is 50)' },
    ])
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
    expect(outcome.invalid).toEqual([])
    expect(outcome.incomplete).toHaveLength(52)
    expect(outcome.incomplete.filter(entry => entry.reason === 'finding-unreadable')).toHaveLength(50)
    expect(outcome.incomplete.slice(50)).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '4950 of 5000 reported findings were not reviewed (the cap is 50)' },
      { profile: 'security', reason: 'research-unusable', detail: '5000 finding(s) reported, the first 50 read, none usable' },
    ])
  })
})

describe('findingFingerprint', () => {
  it('fingerprints a finding by its profile, file, folded category and cited row, never its line', () => {
    const fingerprint = findingFingerprint('security', 'a.js', 'sql-injection', ' q( x )')
    expect(findingFingerprint('security', 'a.js', 'SQL Injection!', '+  q( x )  ')).toBe(fingerprint)
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(findingFingerprint('style', 'a.js', 'sql-injection', ' q( x )')).not.toBe(fingerprint)
    expect(findingFingerprint('security', 'b.js', 'sql-injection', ' q( x )')).not.toBe(fingerprint)
    expect(findingFingerprint('security', 'a.js', 'xss', ' q( x )')).not.toBe(fingerprint)
    expect(findingFingerprint('security', 'a.js', 'sql-injection', ' q( y )')).not.toBe(fingerprint)
    expect(findingFingerprint('security', 'a.js', 'sql-injection', '')).not.toBe(fingerprint)
  })

  it('gives the composed and the decomposed form of a category one fingerprint', () => {
    const composed = 'café'
    const decomposed = `cafe${String.fromCharCode(0x301)}`
    expect(decomposed).not.toBe(composed)
    expect(findingFingerprint('security', 'a.js', decomposed, ' q( x )')).toBe(findingFingerprint('security', 'a.js', composed, ' q( x )'))
    expect(findingFingerprint('security', 'a.js', composed, ' q( x )')).not.toBe(findingFingerprint('security', 'a.js', 'cafe', ' q( x )'))
  })
})

describe('checkReplies', () => {
  const named = (prefix: string, count: number): unknown[] => Array.from({ length: count }, (_, index) => ({ ...reported, category: `${prefix}${index}` }))

  it('reads the replies in order, up to maxFindings entries in all, and counts the rest in one findings-capped gap', () => {
    const outcome = checkReplies([
      {
        text: reply(named('A', 30)),
      },
      {
        text: reply(named('B', 30)),
      },
    ], sections, 'security')
    expect(outcome.findings.map(found => found.category)).toEqual([
      ...named('A', 30).map(entry => (entry as { category: string }).category),
      ...named('B', 20).map(entry => (entry as { category: string }).category),
    ])
    expect(outcome.findings).toHaveLength(50)
    expect(outcome.invalid).toEqual([])
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '10 of 60 reported findings were not reviewed (the cap is 50)' },
    ])
  })

  it('still counts the findings of a reply that comes after the cap was reached', () => {
    const outcome = checkReplies([
      {
        text: reply(named('A', 2)),
      },
      {
        text: reply(named('B', 3)),
      },
    ], sections, 'security', 2)
    expect(outcome.findings.map(found => found.category)).toEqual(['A0', 'A1'])
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '3 of 5 reported findings were not reviewed (the cap is 2)' },
    ])
  })

  it('names the part of each unreadable entry', () => {
    const outcome = checkReplies([
      {
        text: reply([reported]),
        label: 'part 1',
      },
      {
        text: reply([
          { ...reported, quote: undefined },
        ]),
        label: 'part 2',
      },
    ], sections, 'security')
    expect(outcome.findings).toHaveLength(1)
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'finding-unreadable', detail: 'part 2: findings[0]: quote: Invalid input: expected string, received undefined' },
    ])
  })

  it('records research-unusable when the parts reported findings and none was usable', () => {
    const outcome = checkReplies([
      {
        text: reply([
          { file: 'x.js' },
        ]),
        label: 'part 1',
      },
      {
        text: reply([
          { ...reported, line: 99 },
        ]),
        label: 'part 2',
      },
    ], sections, 'security')
    expect(outcome.findings).toEqual([])
    expect(outcome.invalid).toEqual(['a.js:99 is not in the diff'])
    expect(outcome.incomplete.map(entry => [entry.reason, entry.detail])).toEqual([
      [
        'finding-unreadable',
        expect.stringMatching(/^part 1: findings\[0\]: /),
      ],
      ['research-unusable', '2 finding(s) reported, none usable'],
    ])
  })

  it('reads one reply as checkReply always has', () => {
    const texts = [
      reply([
        reported,
        { ...reported, file: 'missing.js' },
        { file: 'x.js' },
      ]),
      reply([]),
      reply(named('A', 3)),
      reply([
        { file: 'x.js' },
        { file: 'y.js' },
      ]),
    ]
    for (const text of texts) {
      expect(checkReplies([
        { text },
      ], sections, 'security')).toEqual(checkReply(text, sections, 'security'))
      expect(checkReplies([
        { text },
      ], sections, 'security', 2)).toEqual(checkReply(text, sections, 'security', 2))
    }
  })

  it('fails closed on a reply that is no envelope, and rejects a cap that is not a positive integer', () => {
    expect(() => checkReplies([
      {
        text: reply([]),
      },
      { text: '{"result":"nothing"}' },
    ], sections, 'security')).toThrow(OutputError)
    expect(() => checkReplies([
      {
        text: reply([]),
      },
    ], sections, 'security', 0)).toThrow(RangeError)
  })

  it('reads no reply as a complete result', () => {
    expect(checkReplies([], sections, 'security')).toEqual({
      findings: [],
      invalid: [],
      invalidRules: [],
      incomplete: [],
    })
  })

  it('keeps the fingerprint when a push shifts the finding\'s line', () => {
    const before = splitDiff([
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,4 +1,4 @@',
      ' a()',
      ' b()',
      ' c()',
      '-safe()',
      '+exec(cmd)',
    ].join('\n'))
    const after = splitDiff([
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,4 +1,7 @@',
      '+x()',
      '+y()',
      '+z()',
      ' a()',
      ' b()',
      ' c()',
      '-safe()',
      '+exec(cmd)',
    ].join('\n'))
    const [first] = checkReplies([
      {
        text: reply([
          { ...reported, line: 4 },
        ]),
      },
    ], before, 'security').findings
    const [second] = checkReplies([
      {
        text: reply([
          { ...reported, line: 7 },
        ]),
      },
    ], after, 'security').findings
    expect(first.fingerprint).toMatch(FINGERPRINT_PATTERN)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.id).not.toBe(first.id)
  })

  it('ranks the findings that share a hash in research order, a repeat of one taking its rank', () => {
    const twice = splitDiff([
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -0,0 +1,6 @@',
      '+a()',
      '+q(x)',
      '+b()',
      '+c()',
      '+q(x)',
      '+d()',
    ].join('\n'))
    const { findings } = checkReplies([
      {
        text: reply([
          { ...reported, line: 2 },
          { ...reported, line: 5 },
          { ...reported, line: 2 },
        ]),
      },
    ], twice, 'security')
    const hash = findingFingerprint('security', 'a.js', 'CWE-78', '+q(x)')
    expect(findings.map(found => found.fingerprint)).toEqual([`${hash}:1`, `${hash}:2`, `${hash}:1`])
  })

  it('ranks two findings at one line whose categories differ raw and fold alike, one and two', () => {
    const one = splitDiff([
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -0,0 +1,2 @@',
      '+a()',
      '+q(x)',
    ].join('\n'))
    const { findings } = checkReplies([
      {
        text: reply([
          { ...reported, line: 2, category: 'SQL Injection' },
          { ...reported, line: 2, category: 'sql-injection' },
        ]),
      },
    ], one, 'security')
    const hash = findingFingerprint('security', 'a.js', 'sql-injection', '+q(x)')
    expect(findings.map(found => found.fingerprint)).toEqual([`${hash}:1`, `${hash}:2`])
  })

  it('fingerprints a finding with no cited row by the empty row', () => {
    const removed = splitDiff([
      'diff --git a/a.js b/a.js',
      '@@ -5,2 +4,0 @@',
      '-one()',
      '-two()',
    ].join('\n'))
    const [finding] = checkReplies([
      {
        text: reply([
          { ...reported, line: 4 },
        ]),
      },
    ], removed, 'security').findings
    expect(Object.hasOwn(finding, 'evidenceRow')).toBe(false)
    expect(finding.fingerprint).toBe(`${findingFingerprint('security', 'a.js', 'CWE-78', '')}:1`)
  })
})
