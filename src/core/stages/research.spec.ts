import { describe, expect, it } from 'vitest'
import { splitDiff } from '../diff.ts'
import { OutputError } from '../errors.ts'
import { capDepths, checkReplies, checkReply, DEFAULT_MAX_FINDINGS, findingFingerprint, findingId, FINGERPRINT_PATTERN, rankFingerprint } from './research.ts'

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
        foundBy: { kind: 'model' },
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

  it('says every finding the finder reported was found by the model', () => {
    const { findings } = checkReply(reply([reported]), sections, 'security')
    expect(findings[0].foundBy).toEqual({ kind: 'model' })
    const keys = Object.keys(findings[0])
    expect(keys.indexOf('foundBy')).toBe(keys.indexOf('quoteMatched') + 1)
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
      ranks: new Map(),
      invalid: [],
      away: [],
      invalidRules: [],
      incomplete: [],
      unread: [],
      counts: { listed: 0, capped: 0, saturated: 0 },
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
      { profile: 'security', reason: 'findings-capped', detail: '1 of 3 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 2): raise findingsCap' },
    ])
  })

  it('caps at fifty findings by default', () => {
    expect(DEFAULT_MAX_FINDINGS).toBe(50)
    const outcome = checkReply(reply(Array.from({ length: 51 }).fill(reported)), sections, 'security')
    expect(outcome.findings).toHaveLength(50)
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '1 of 51 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 50): raise findingsCap' },
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
      { profile: 'security', reason: 'findings-capped', detail: '4950 of 5000 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 50): raise findingsCap' },
      { profile: 'security', reason: 'research-unusable', detail: '5000 finding(s) reported, 50 of them read under the cap, none usable' },
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

describe('capDepths', () => {
  it.each([
    [
      [3, 0, 5, 1],
      6,
      [3, 0, 2, 1],
    ],
    [
      [3, 0, 5, 1],
      4,
      [2, 0, 1, 1],
    ],
    [
      [3, 0, 5, 1],
      9,
      [3, 0, 5, 1],
    ],
    [
      [2, 2],
      3,
      [2, 1],
    ],
    [
      [18, 1, 1],
      4,
      [2, 1, 1],
    ],
    [[], 5, []],
    [
      [0, 0],
      1,
      [0, 0],
    ],
  ])('takes %j at a cap of %i as %j', (listed, cap, depths) => {
    expect(capDepths(listed, cap)).toEqual(depths)
  })
})

describe('checkReplies', () => {
  const named = (prefix: string, count: number): unknown[] => Array.from({ length: count }, (_, index) => ({ ...reported, category: `${prefix}${index}` }))

  it('takes each reply\'s first finding before any reply\'s second, and keeps the parts\' order in what it reads', () => {
    const outcome = checkReplies([
      {
        text: reply(named('A', 30)),
      },
      {
        text: reply(named('B', 30)),
      },
    ], sections, 'security')
    expect(outcome.findings.map(found => found.category)).toEqual([
      ...named('A', 25).map(entry => (entry as { category: string }).category),
      ...named('B', 25).map(entry => (entry as { category: string }).category),
    ])
    expect(outcome.findings).toHaveLength(50)
    expect(outcome.invalid).toEqual([])
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '10 of 60 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 50): raise findingsCap' },
    ])
  })

  it('reads a later reply\'s first finding before an earlier reply\'s second', () => {
    const outcome = checkReplies([
      {
        text: reply(named('A', 2)),
      },
      {
        text: reply(named('B', 3)),
      },
    ], sections, 'security', 2)
    expect(outcome.findings.map(found => found.category)).toEqual(['A0', 'B0'])
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '3 of 5 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 2): raise findingsCap' },
    ])
  })

  it('checks no entry the cap leaves unread as a finding', () => {
    const texts = [
      reply([
        reported,
        { ...reported, line: 2 },
        1,
      ]),
      reply([
        { ...reported, line: 3 },
      ]),
    ]
    const unreadable = (cap: number): string[] => checkReplies(texts.map(text => ({ text })), sections, 'security', cap)
      .incomplete
      .filter(entry => entry.reason === 'finding-unreadable')
      .map(entry => entry.detail)
    expect(unreadable(2)).toEqual([])
    expect(unreadable(4)).toEqual([
      expect.stringMatching(/^findings\[2\]: /),
    ])
  })

  describe('the unread findings\' places', () => {
    const at = (line: number, file = 'a.js'): unknown => ({ ...reported, file, line })

    it('places the unread findings after the last one read, up to each reply\'s ask', () => {
      const outcome = checkReplies([
        {
          text: reply([
            at(1),
            at(2),
            at(3),
            at(3),
          ]),
          asked: 2,
        },
      ], sections, 'security', 1)
      expect(outcome.unread).toEqual([
        { file: 'a.js', line: 2 },
        { file: 'a.js', line: 3 },
      ])
    })

    it('places every unread finding of a reply that lists more than its ask, at a cap equal to its ask', () => {
      const outcome = checkReplies([
        {
          text: reply(Array.from({ length: 60 }, (_, index) => at((index % 3) + 1))),
          asked: 50,
        },
      ], sections, 'security', 50)
      expect(outcome.unread).toHaveLength(10)
      expect(outcome.incomplete.map(entry => entry.reason)).toEqual(['findings-capped'])
    })

    it('bounds a reply that carries no ask by the cap, and lists the replies\' places in their order', () => {
      expect(checkReplies([
        {
          text: reply(Array.from({ length: 5 }, () => at(1))),
        },
      ], sections, 'security', 2).unread).toHaveLength(2)
      expect(checkReplies([
        {
          text: reply([
            at(1),
            at(2),
            at(3),
          ]),
          asked: 3,
        },
        {
          text: reply([
            at(3),
            at(2),
            at(1),
          ]),
          asked: 3,
        },
      ], sections, 'security', 2).unread.map(({ line }) => line)).toEqual([2, 3, 2, 1])
    })

    it('places an unread finding whose line is quoted, as a read finding\'s quoted line is read', () => {
      const quoted = { ...reported, line: ' 2 ' }
      const outcome = checkReplies([
        {
          text: reply([
            at(1),
            quoted,
          ]),
          asked: 3,
        },
      ], sections, 'security', 1)
      expect(outcome.unread).toEqual([
        { file: 'a.js', line: 2 },
      ])
      expect(checkReplies([
        {
          text: reply([quoted]),
          asked: 3,
        },
      ], sections, 'security', 1).findings.map(found => found.line)).toEqual([2])
    })

    it('places nothing when the cap leaves nothing unread', () => {
      expect(checkReplies([
        {
          text: reply([
            at(1),
            at(2),
          ]),
          asked: 2,
        },
      ], sections, 'security', 2).unread).toEqual([])
      expect(checkReply(reply([]), sections, 'security').unread).toEqual([])
    })

    it.each([
      [
        'names a file outside the diff',
        at(1, 'missing.js'),
      ],
      [
        'names a line the diff does not show',
        at(9),
      ],
      [
        'names no file and no line',
        { summary: 'x' },
      ],
    ])('places no unread finding that %s', (_name, entry) => {
      const outcome = checkReplies([
        {
          text: reply([
            at(1),
            entry,
          ]),
          asked: 3,
        },
      ], sections, 'security', 1)
      expect(outcome.unread).toEqual([])
      expect(outcome.incomplete).toEqual([
        { profile: 'security', reason: 'findings-capped', detail: '1 of 2 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 1): raise findingsCap' },
      ])
    })
  })

  it('counts an unreadable entry the cap reads toward the cap', () => {
    const outcome = checkReplies([
      {
        text: reply([1, reported]),
      },
      {
        text: reply([reported]),
      },
    ], sections, 'security', 2)
    expect(outcome.incomplete.map(entry => [entry.reason, entry.detail])).toEqual([
      [
        'finding-unreadable',
        expect.stringMatching(/^findings\[0\]: /),
      ],
      ['findings-capped', '1 of 3 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 2): raise findingsCap'],
    ])
    expect(outcome.findings).toHaveLength(1)
  })

  it('counts what the replies listed, what the cap left unread and the replies that listed all they were asked for', () => {
    const outcome = checkReplies([
      {
        text: reply(named('A', 3)),
        asked: 3,
      },
      {
        text: reply(named('B', 1)),
        asked: 3,
      },
    ], sections, 'security', 2)
    expect(outcome.counts).toEqual({ listed: 4, capped: 2, saturated: 1 })
    expect(checkReplies([
      {
        text: reply(named('A', 2)),
        asked: 3,
      },
    ], sections, 'security').counts).toEqual({ listed: 2, capped: 0, saturated: 0 })
    expect(checkReplies([], sections, 'security').counts).toEqual({ listed: 0, capped: 0, saturated: 0 })
  })

  it.each([
    [
      'the cap\'s lever',
      [
        {
          text: reply(named('A', 5)),
        },
      ],
      3,
      3,
      '2 of 5 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 3): raise findingsCap',
    ],
    [
      'maxFindings, for a reply that asked for maxFindings',
      [
        {
          text: reply(named('A', 2)),
          asked: 2,
        },
      ],
      2,
      2,
      '1 research reply(ies) listed the 2 findings they were asked for at most, so they may have left some out: raise maxFindings',
    ],
    [
      'maxTokens, for a reply whose budget asked for fewer',
      [
        {
          text: reply(named('A', 2)),
          asked: 2,
        },
      ],
      50,
      50,
      '1 research reply(ies) listed the 2 findings they were asked for at most, so they may have left some out: raise maxTokens, since the reply budget holds 2 of maxFindings 50',
    ],
    [
      'both, joined',
      [
        {
          text: reply(named('A', 3)),
          asked: 3,
        },
        {
          text: reply(named('B', 1)),
          asked: 3,
        },
      ],
      2,
      3,
      '1 research reply(ies) listed the 3 findings they were asked for at most, so they may have left some out: raise maxFindings; 2 of 4 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 2): raise findingsCap',
    ],
  ])('ends the findings-capped detail with %s', (_name, replies, cap, requestFindings, detail) => {
    const outcome = checkReplies(replies, sections, 'security', cap, { requestFindings })
    expect(outcome.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail },
    ])
  })

  it('reads the saturation lever from the request\'s maxFindings, which is the cap unless given, and the cap does not move it', () => {
    const replies = [
      {
        text: reply(named('A', 50)),
        asked: 50,
      },
    ]
    const asks = '1 research reply(ies) listed the 50 findings they were asked for at most, so they may have left some out: raise maxFindings'
    const cap = '30 of 50 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 20): raise findingsCap'
    expect(checkReplies(replies, sections, 'security', 20, { requestFindings: 50 }).incomplete[0].detail).toBe(`${asks}; ${cap}`)
    expect(checkReplies(replies, sections, 'security', 20).incomplete[0].detail).toBe(`${asks}; ${cap}`)
    expect(checkReplies(replies, sections, 'security', 20, { requestFindings: 80 }).incomplete[0].detail).toContain('raise maxTokens, since the reply budget holds 50 of maxFindings 80; ')
  })

  it.each([
    [
      'the profile\'s maxFindings',
      20,
      '1 research reply(ies) listed the 20 findings they were asked for at most, so they may have left some out: raise the profile\'s maxFindings',
    ],
    [
      'maxTokens',
      12,
      '1 research reply(ies) listed the 12 findings they were asked for at most, so they may have left some out: raise maxTokens, since the reply budget holds 12 of the profile\'s maxFindings 20',
    ],
  ])('names %s as the lever of a saturated reply of a profile that sets its own maxFindings', (_name, asked, detail) => {
    const replies = [
      {
        text: reply(named('A', asked)),
        asked,
      },
    ]
    const outcome = checkReplies(replies, sections, 'code-review', 50, { requestFindings: 20, ownAsk: true })
    expect(outcome.incomplete).toEqual([
      { profile: 'code-review', reason: 'findings-capped', detail },
    ])
  })

  it('counts an unreadable entry among what the reply listed', () => {
    const outcome = checkReplies([
      {
        text: reply([1, reported, reported]),
      },
    ], sections, 'security', 2)
    expect(outcome.counts).toEqual({ listed: 3, capped: 1, saturated: 0 })
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
      ranks: new Map(),
      invalid: [],
      away: [],
      invalidRules: [],
      incomplete: [],
      unread: [],
      counts: { listed: 0, capped: 0, saturated: 0 },
    })
  })

  describe('a profile that reviews changed lines only', () => {
    /** Seven rows, the fourth added: line 1 and line 7 are context rows three rows from it. */
    const shown = splitDiff([
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,6 +1,7 @@',
      ' a()',
      ' b()',
      ' c()',
      '+d()',
      ' e()',
      ' f()',
      ' g()',
    ].join('\n'))
    const replies = [
      {
        text: reply([
          {
            ...reported,
            line: 1,
            quote: 'a()',
            rule: 'nothing-here',
          },
          {
            ...reported,
            line: 7,
            quote: 'g()',
            rule: 'nothing-here',
          },
        ]),
      },
    ]
    const away = (line: number): string => `"a.js":${line} is more than two lines from a line the change adds or removes`

    it('drops a changed-lines profile\'s findings away from the change before the citation check, and records no research-unusable when every one is away', () => {
      const outcome = checkReplies(replies, shown, 'naming', DEFAULT_MAX_FINDINGS, {
        changedLinesOnly: true,
        citation: { rules: [], requireRule: false },
      })
      expect(outcome.findings).toEqual([])
      expect(outcome.away).toEqual([
        away(1),
        away(7),
      ])
      // Their citations, which both fail, are never checked: the place is judged first.
      expect(outcome.invalidRules).toEqual([])
      expect(outcome.invalid).toEqual([])
      expect(outcome.incomplete).toEqual([])
    })

    it('keeps the findings away from the change of a profile that does not review changed lines only', () => {
      for (const policy of [
        {},
        { changedLinesOnly: false },
        {
          citation: { rules: [], requireRule: false },
        },
      ]) {
        const outcome = checkReplies(replies, shown, 'naming', DEFAULT_MAX_FINDINGS, policy)
        expect(outcome.findings.map(found => found.line), JSON.stringify(policy)).toEqual([1, 7])
        expect(outcome.away).toEqual([])
      }
    })

    it('keeps a finding near the change, reads the others, and still records research-unusable for a reply none of whose findings the diff shows', () => {
      const mixed = checkReplies([
        {
          text: reply([
            { ...reported, line: 3, quote: 'c()' },
            { ...reported, line: 1, quote: 'a()' },
            { ...reported, line: 99 },
          ]),
        },
      ], shown, 'naming', DEFAULT_MAX_FINDINGS, { changedLinesOnly: true })
      expect(mixed.findings.map(found => found.line)).toEqual([3])
      expect(mixed.invalid).toEqual(['a.js:99 is not in the diff'])
      expect(mixed.away).toEqual([
        away(1),
      ])
      expect(mixed.incomplete).toEqual([])
      const unusable = checkReplies([
        {
          text: reply([
            { ...reported, line: 99 },
          ]),
        },
      ], shown, 'naming', DEFAULT_MAX_FINDINGS, { changedLinesOnly: true })
      expect(unusable.away).toEqual([])
      expect(unusable.incomplete).toEqual([
        { profile: 'naming', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' },
      ])
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

  it('hands on the ranks it named the findings by, so a scanner\'s candidate is ranked after them from the same map', () => {
    const twice = splitDiff([
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -0,0 +1,3 @@',
      '+a()',
      '+q(x)',
      '+q(x)',
    ].join('\n'))
    const { findings, ranks } = checkReplies([
      {
        text: reply([
          { ...reported, line: 2 },
        ]),
      },
    ], twice, 'security')
    const hash = findingFingerprint('security', 'a.js', 'CWE-78', '+q(x)')
    expect(findings.map(found => found.fingerprint)).toEqual([`${hash}:1`])
    expect([
      ...ranks.keys(),
    ]).toEqual([hash])
    expect([
      ...ranks.get(hash)!.values(),
    ]).toEqual([1])
    // A finding of another line, named from the same map, takes the next rank, as a second finding of the reply would.
    const [second] = checkReply(reply([
      { ...reported, line: 3 },
    ]), twice, 'security').findings
    expect(rankFingerprint(ranks, 'security', second)).toBe(`${hash}:2`)
    expect(rankFingerprint(ranks, 'security', { ...second, line: 3 })).toBe(`${hash}:2`)
    expect(rankFingerprint(ranks, 'security', { ...second, line: 2 })).toBe(`${hash}:1`)
    // No reply read, no rank.
    expect(checkReplies([], twice, 'security').ranks.size).toBe(0)
  })

  it('hashes the row it is given in place of the cited row, and the empty row for a file-level candidate', () => {
    const [found] = checkReply(reply([reported]), sections, 'security').findings
    const own = findingFingerprint('security', 'a.js', 'CWE-78', '+exec(cmd)')
    const bare = findingFingerprint('security', 'a.js', 'CWE-78', '')
    expect(own).not.toBe(bare)
    expect(rankFingerprint(new Map(), 'security', found)).toBe(`${own}:1`)
    expect(rankFingerprint(new Map(), 'security', found, '')).toBe(`${bare}:1`)
    expect(rankFingerprint(new Map(), 'security', found, '+  exec(cmd)  ')).toBe(`${own}:1`)
    // A finding that cites no row hashes the empty row, as a given empty row does.
    expect(rankFingerprint(new Map(), 'security', { ...found, evidenceRow: undefined })).toBe(`${bare}:1`)
    // The ranks count by hash and by file, line and category: the same finding twice keeps its rank, another line takes the next.
    const ranks = new Map<string, Map<string, number>>()
    expect([
      rankFingerprint(ranks, 'security', found, ''),
      rankFingerprint(ranks, 'security', found, ''),
      rankFingerprint(ranks, 'security', { ...found, line: 9 }, ''),
    ]).toEqual([`${bare}:1`, `${bare}:1`, `${bare}:2`])
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
