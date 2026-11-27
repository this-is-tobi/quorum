import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { scanReports } from '../core/candidates.ts'
import { splitDiff } from '../core/diff.ts'
import { cutRead, MAX_RESULTS, READ_MESSAGE, READ_RULE_ID, READ_RULE_TEXT } from '../core/reports.ts'
import { reportPathsOf } from './paths.ts'
import { sonarqubeReport } from './sonarqube.ts'

/** `cutRead` as a spy that calls through, so a test can count the texts a reader cuts. */
vi.mock('../core/reports.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/reports.ts')>()
  return {
    ...actual,
    cutRead: vi.fn(actual.cutRead),
  }
})

const CHECKOUT = '/home/runner/work/app/app'
const FIXTURES = new URL('./fixtures/', import.meta.url)
const checkout = reportPathsOf(undefined, CHECKOUT)

/** A fixture's file, parsed as it is, for the values the reader must hand over unchanged. */
function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))
}

function issue(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rule: 'js:S1',
    component: 'app:src/a.js',
    project: 'app',
    status: 'OPEN',
    message: 'a message',
    severity: 'MAJOR',
    ...extra,
  }
}
const response = (issues: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ issues, ...extra })
const read = (issues: unknown, extra: Record<string, unknown> = {}): ReturnType<typeof sonarqubeReport> => sonarqubeReport(response(issues, extra), checkout)

describe('sonarqubeReport', () => {
  it('reads a SonarQube 10 response: the open issues, their paths, levels and rule names', () => {
    const raw = fixture('sonarqube-10.json')
    const report = sonarqubeReport(readFileSync(new URL('sonarqube-10.json', FIXTURES), 'utf8'), checkout)
    expect(report).toStrictEqual({
      scanner: 'SonarQube',
      problems: [],
      skipped: 1,
      unreadable: 0,
      issues: [
        {
          path: 'src/config.js',
          line: 7,
          scanner: 'SonarQube',
          ruleId: 'javascript:S2068',
          ruleText: 'Credentials should not be hard-coded',
          message: raw.issues[0].message,
          level: 'error',
        },
        {
          scanner: 'SonarQube',
          ruleId: 'javascript:S1135',
          message: raw.issues[2].message,
          level: 'note',
        },
      ],
    })
    expect(report.issues.length + report.skipped + report.unreadable).toBe(raw.total)
  })

  it('reads a 2025 response by its issue status and impacts, and a truncated one as such', () => {
    const raw = fixture('sonarqube-2025.json')
    const report = sonarqubeReport(readFileSync(new URL('sonarqube-2025.json', FIXTURES), 'utf8'), checkout)
    expect(report).toStrictEqual({
      scanner: 'SonarQube',
      problems: ['truncated'],
      total: 12000,
      skipped: 1,
      unreadable: 0,
      issues: [
        {
          path: 'src/a.js',
          line: 3,
          scanner: 'SonarQube',
          ruleId: 'javascript:S1481',
          ruleText: 'Unused local variables should be removed',
          message: raw.issues[0].message,
          level: 'error',
        },
        {
          path: 'src/b.js',
          scanner: 'SonarQube',
          ruleId: 'javascript:S4423',
          message: raw.issues[2].message,
          level: 'warning',
        },
      ],
    })
    expect(raw.paging.total).toBe(12000)
    expect(raw.issues.every((found: any) => found.severity === undefined)).toBe(true)
  })

  it('reads a response with no issues array as no response', () => {
    for (const text of [
      '',
      '{',
      '[]',
      'null',
      '3',
      '"issues"',
      '{}',
      '{"issues":{}}',
      '{"issues":null}',
      '{"issues":"none"}',
      '{"runs":[]}',
    ]) {
      expect(sonarqubeReport(text, checkout)).toStrictEqual({
        problems: ['not-the-format'],
        skipped: 0,
        unreadable: 0,
        issues: [],
      })
    }
  })

  it('reads an empty issues array as a response with no issue', () => {
    expect(read([])).toStrictEqual({
      scanner: 'SonarQube',
      problems: [],
      skipped: 0,
      unreadable: 0,
      issues: [],
    })
  })

  it.each([
    ['a number', 7],
    ['null', null],
    ['an array', []],
    ['a string', 'issue'],
    [
      'an issue with no rule',
      issue({ rule: undefined }),
    ],
    [
      'an issue with an empty rule',
      issue({ rule: '' }),
    ],
    [
      'an issue with a rule that is no string',
      issue({ rule: 4 }),
    ],
    [
      'an issue with no message',
      issue({ message: undefined }),
    ],
    [
      'an issue with an empty message',
      issue({ message: '' }),
    ],
    [
      'an issue with no component',
      issue({ component: undefined }),
    ],
    [
      'an issue with a component that is no string',
      issue({ component: 9 }),
    ],
    [
      'a negative line',
      issue({ line: -1 }),
    ],
    [
      'a fractional line',
      issue({ line: 1.5 }),
    ],
    [
      'a line that is a string',
      issue({ line: '7' }),
    ],
    [
      'a line that is null',
      issue({ line: null }),
    ],
    [
      'an unsafe line',
      issue({ line: 2 ** 53 }),
    ],
    [
      'a text range that is no object',
      issue({ textRange: 'line 4' }),
    ],
    [
      'a text range with an unsafe start line',
      issue({
        textRange: { startLine: -2 },
      }),
    ],
  ])('counts %s as unreadable', (_, entry) => {
    expect(read([
      entry,
      issue({ rule: 'js:S2' }),
    ])).toMatchObject({
      unreadable: 1,
      skipped: 0,
      problems: [],
      issues: [
        { ruleId: 'js:S2' },
      ],
    })
  })

  it('counts an issue that is not open as skipped before it reads the rest of it', () => {
    expect(read([
      issue({ status: 'RESOLVED', message: undefined }),
    ])).toMatchObject({ skipped: 1, unreadable: 0, issues: [] })
  })

  it.each([
    ['OPEN', undefined, true],
    ['CONFIRMED', undefined, true],
    ['ACCEPTED', undefined, false],
    ['FALSE_POSITIVE', undefined, false],
    ['FIXED', undefined, false],
    ['OPEN', 'RESOLVED', true],
    ['ACCEPTED', 'OPEN', false],
    ['FALSE_POSITIVE', 'CONFIRMED', false],
    [undefined, 'OPEN', true],
    [undefined, 'CONFIRMED', true],
    [undefined, 'REOPENED', true],
    [undefined, 'RESOLVED', false],
    [undefined, 'CLOSED', false],
    [undefined, 'TO_REVIEW', false],
    [undefined, undefined, false],
    [4, 'OPEN', true],
    [null, 'REOPENED', true],
    ['REOPENED', undefined, false],
    ['open', undefined, false],
  ])('reads the issue status %s with the status %s as open: %s', (issueStatus, status, open) => {
    const report = read([
      issue({ issueStatus, status }),
    ])
    expect(report.issues).toHaveLength(open
      ? 1
      : 0)
    expect(report.skipped).toBe(open
      ? 0
      : 1)
  })

  it.each([
    ['BLOCKER', 'error'],
    ['CRITICAL', 'error'],
    ['HIGH', 'error'],
    ['MAJOR', 'warning'],
    ['MEDIUM', 'warning'],
    ['MINOR', 'note'],
    ['INFO', 'note'],
    ['LOW', 'note'],
    ['SEVERE', 'unknown'],
    ['high', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    [3, 'unknown'],
  ])('reads the severity %s as %s', (severity, level) => {
    expect(read([
      issue({ severity }),
    ]).issues[0].level).toBe(level)
  })

  it.each([
    [
      [
        { severity: 'HIGH' },
      ],
      'error',
    ],
    [
      [
        { severity: 'MEDIUM' },
        { severity: 'LOW' },
      ],
      'warning',
    ],
    [
      [
        { severity: 'LOW' },
        { severity: 'MEDIUM' },
      ],
      'warning',
    ],
    [
      [
        { severity: 'INFO' },
        { severity: 'BLOCKER' },
        { severity: 'LOW' },
      ],
      'error',
    ],
    [
      [
        { severity: 'LOW' },
        { severity: 'UNHEARD' },
      ],
      'note',
    ],
    [
      [
        { severity: 'UNHEARD' },
      ],
      'unknown',
    ],
    [
      [
        null,
        7,
        { severity: 'MEDIUM' },
        { softwareQuality: 'SECURITY' },
        { severity: 4 },
      ],
      'warning',
    ],
    [[], 'error'],
    [
      [null, {}],
      'error',
    ],
    ['HIGH', 'error'],
  ])('reads the level of the impacts %j as the highest, else the severity (CRITICAL): %s', (impacts, level) => {
    expect(read([
      issue({ severity: 'CRITICAL', impacts }),
    ]).issues[0].level).toBe(level)
  })

  it('reads the level of impacts alone when an issue has no severity', () => {
    expect(read([
      issue({
        severity: undefined,
        impacts: [
          { severity: 'MEDIUM' },
          { severity: 'LOW' },
        ],
      }),
    ]).issues[0].level).toBe('warning')
    expect(read([
      issue({ severity: undefined, impacts: [] }),
    ]).issues[0].level).toBe('unknown')
  })

  it('takes the line, else the text range\'s start line', () => {
    const line = (extra: Record<string, unknown>): number | undefined => read([
      issue(extra),
    ]).issues[0].line
    expect(line({
      line: 7,
      textRange: { startLine: 9 },
    })).toBe(7)
    expect(line({
      textRange: { startLine: 9, endLine: 11 },
    })).toBe(9)
    expect(line({ line: 0 })).toBe(0)
    expect(line({ textRange: {} })).toBeUndefined()
    expect(line({})).toBeUndefined()
    expect('line' in read([
      issue(),
    ]).issues[0]).toBe(false)
  })

  it('takes a file\'s path from the response\'s components, by key, else from the component less its project key', () => {
    const path = (extra: Record<string, unknown>, components?: unknown): unknown => {
      const found = read([
        issue(extra),
      ], components === undefined
        ? {}
        : { components }).issues[0]
      return found.unmapped === true
        ? 'unmapped'
        : found.path
    }
    expect(path({}, [
      { key: 'app:src/a.js', path: 'lib/b.js' },
    ])).toBe('lib/b.js')
    expect(path({}, [
      { key: 'app:other.js', path: 'lib/b.js' },
      { key: 'app:src/a.js', path: 'first.js' },
      { key: 'app:src/a.js', path: 'second.js' },
    ])).toBe('first.js')
    expect(path({})).toBe('src/a.js')
    expect(path({}, [
      { key: 'app:src/a.js' },
      7,
      null,
      { path: 'no-key.js' },
    ])).toBe('src/a.js')
    expect(path({}, { key: 'app:src/a.js', path: 'lib/b.js' })).toBe('src/a.js')
    expect(path({ project: undefined })).toBe('src/a.js')
    expect(path({ project: 'org:app', component: 'org:app:src/a.js' })).toBe('src/a.js')
    expect(path({ project: undefined, component: 'org:app:src/a.js' })).toBe('app:src/a.js')
    expect(path({ project: 'app', component: 'other:src/a.js' })).toBe('unmapped')
    expect(path({ project: 'app', component: 'app:' })).toBe('unmapped')
    expect(path({ project: 'app', component: 'app::a.js' })).toBe(':a.js')
  })

  it('reads an issue on the project itself as on no file, not as unmapped', () => {
    for (const extra of [
      { component: 'app' },
      { component: 'app', project: undefined },
      { component: 'org:app', project: 'org:app' },
    ]) {
      expect(read([
        issue(extra),
      ]).issues).toStrictEqual([
        {
          scanner: 'SonarQube',
          ruleId: 'js:S1',
          message: 'a message',
          level: 'warning',
        },
      ])
    }
    expect(read([
      issue({ component: 'app' }),
    ], {
      components: [
        { key: 'app', path: '' },
      ],
    }).issues[0]).not.toHaveProperty('unmapped')
  })

  it('reads a component path as a path: relative to the scan root, never decoded, and unmapped when it cannot be placed', () => {
    const mapped = (written: string): unknown => {
      const found = read([
        issue(),
      ], {
        components: [
          { key: 'app:src/a.js', path: written },
        ],
      }).issues[0]
      return found.unmapped === true
        ? 'unmapped'
        : found.path
    }
    expect(mapped('./src/a.js')).toBe('src/a.js')
    expect(mapped(`${CHECKOUT}/src/a.js`)).toBe('src/a.js')
    expect(mapped('/elsewhere/src/a.js')).toBe('unmapped')
    expect(mapped('src/../a.js')).toBe('unmapped')
    expect(mapped('src//a.js')).toBe('unmapped')
    expect(mapped('src\\a.js')).toBe('src\\a.js')
    expect(mapped('src/a%20b.js')).toBe('src/a%20b.js')
    const app = reportPathsOf('/repo/packages/app', '/repo')
    expect(sonarqubeReport(response([
      issue(),
    ]), app).issues[0].path).toBe('packages/app/src/a.js')
    expect(sonarqubeReport(response([
      issue({ component: 'app' }),
    ]), app).issues[0]).not.toHaveProperty('path')
  })

  it('takes a rule\'s text from the response\'s rules, by key, once for all its issues', () => {
    const rules = [
      {
        key: 'js:S1',
        name: 'n'.repeat(20_000),
      },
      { key: 'js:S2', name: 'second' },
      { key: 'js:S1', name: 'repeat' },
    ]
    vi.mocked(cutRead).mockClear()
    const report = read([
      issue(),
      issue({ line: 4 }),
      issue({ rule: 'js:S2' }),
      issue({ rule: 'js:S3' }),
    ], { rules })
    const [first, again, second, none] = report.issues
    expect(first.ruleText).toBe('n'.repeat(READ_RULE_TEXT))
    // A string is compared by its characters, so only the count of cuts says the text was cut once.
    expect(vi.mocked(cutRead).mock.calls.filter(([text]) => text.length === 20_000)).toHaveLength(1)
    expect(first.ruleText).toBe(again.ruleText)
    expect(second.ruleText).toBe('second')
    expect(none).not.toHaveProperty('ruleText')
    for (const odd of [
      [
        { key: 'js:S1' },
      ],
      [
        { key: 'js:S1', name: '' },
      ],
      [
        { key: 'js:S1', name: 4 },
      ],
      [
        { name: 'no key' },
      ],
      ['js:S1'],
      [null],
      { key: 'js:S1', name: 'object' },
      'rules',
    ]) {
      expect(read([
        issue(),
      ], { rules: odd }).issues[0]).not.toHaveProperty('ruleText')
    }
    expect(read([
      issue({ rule: 'constructor' }),
    ], { rules }).issues[0]).not.toHaveProperty('ruleText')
  })

  it('says a response holds fewer issues than its search found, as truncated with the total', () => {
    const two = [
      issue(),
      issue(),
    ]
    expect(read(two, { total: 3 })).toMatchObject({
      problems: ['truncated'],
      total: 3,
    })
    expect(read(two, {
      paging: { total: 12_000 },
    })).toMatchObject({
      problems: ['truncated'],
      total: 12_000,
    })
    expect(read(two, {
      total: 3,
      paging: { total: 99 },
    })).toMatchObject({
      problems: ['truncated'],
      total: 3,
    })
    expect(read(two, {
      total: 'many',
      paging: { total: 5 },
    })).toMatchObject({
      problems: ['truncated'],
      total: 5,
    })
    expect(read(two, {
      total: -1,
      paging: { total: 5 },
    })).toMatchObject({ total: 5 })
    expect(read(two, {
      total: 1.5,
      paging: { total: 4 },
    })).toMatchObject({ total: 4 })
    expect(read(two, { total: 2 })).not.toHaveProperty('total')
    expect(read(two, { total: 1 })).toMatchObject({ problems: [] })
    expect(read(two, {
      total: 0,
      paging: { total: 9 },
    })).toMatchObject({ problems: [] })
    expect(read(two, {
      paging: { total: 2 },
    })).toMatchObject({ problems: [] })
    for (const total of [undefined, null, 'many', true, {}, 1.5]) expect(read(two, { total })).toMatchObject({ problems: [] })
    expect(read(two, { paging: 'none' })).toMatchObject({ problems: [] })
    expect(read(two, {
      paging: { total: 'many' },
    })).toMatchObject({ problems: [] })
  })

  it('counts every entry the response holds, skipped and unreadable too, against its total', () => {
    const entries = [
      issue(),
      issue({ status: 'RESOLVED' }),
      7,
    ]
    expect(read(entries, { total: 3 })).toMatchObject({ problems: [], skipped: 1, unreadable: 1 })
    expect(read(entries, { total: 4 })).toMatchObject({
      problems: ['truncated'],
      total: 4,
      skipped: 1,
      unreadable: 1,
    })
  })

  it('reads at most 25000 issues, and says the rest was not read', () => {
    const issues = Array.from({ length: MAX_RESULTS + 1 }, () => issue())
    const report = read(issues, { total: MAX_RESULTS + 1 })
    expect(report.problems).toEqual(['too-many'])
    expect(report.issues).toHaveLength(MAX_RESULTS)
    expect(read(issues.slice(0, MAX_RESULTS)).problems).toEqual([])
    expect(read([
      ...issues.slice(0, MAX_RESULTS),
      5,
      issue({ status: 'CLOSED' }),
    ])).toMatchObject({
      problems: ['too-many'],
      skipped: 0,
      unreadable: 0,
    })
  })

  it('counts the issues it did not read, so a limit is said as N of M, and none within the limit', () => {
    const issues = Array.from({ length: MAX_RESULTS + 30 }, () => issue())
    const report = read(issues)
    expect(report).toMatchObject({
      problems: ['too-many'],
      notRead: 30,
      skipped: 0,
      unreadable: 0,
    })
    expect(report.issues).toHaveLength(MAX_RESULTS)
    expect(read([
      ...issues.slice(0, MAX_RESULTS),
      7,
    ])).toMatchObject({ notRead: 1, unreadable: 0 })
    expect(read(issues.slice(0, MAX_RESULTS))).not.toHaveProperty('notRead')
    expect(read([])).not.toHaveProperty('notRead')
  })

  it('hands the core what lets it say the limit as N of M: what the file held is what the report lists, and the gap carries the numbers', () => {
    const sections = splitDiff([
      'diff --git a/src/a.js b/src/a.js',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1,1 +1,2 @@',
      ' one',
      '+two',
    ].join('\n'))
    const page = read(Array.from({ length: MAX_RESULTS + 30 }, () => issue({ component: 'app:src/other.js' })), { total: MAX_RESULTS + 30 })
    const scan = scanReports({
      reports: [
        { format: 'sonarqube', profile: 'security', ...page },
      ],
      sections,
      leftOut: [],
      maxScannerIssues: 50,
    })
    const { listed, fileLevel: _, ...counts } = scan.records[0].issues!
    expect(listed).toBe(MAX_RESULTS + 30)
    expect(counts).toMatchObject({ notInChange: MAX_RESULTS, notRead: 30 })
    expect(Object.values(counts).reduce((total, count) => total + count, 0)).toBe(listed)
    expect(scan.profiles.get('security')?.gaps.map(gap => gap.detail)).toEqual([
      'report 1 (sonarqube) was read in part: 30 of its 25030 issues were not read',
    ])
  })

  it('says both when a response holds more issues than it reads and fewer than its search found', () => {
    const report = read(Array.from({ length: MAX_RESULTS + 1 }, () => issue()), { total: 30_000 })
    expect(report).toMatchObject({
      problems: ['truncated', 'too-many'],
      total: 30_000,
    })
    expect(report.issues).toHaveLength(MAX_RESULTS)
  })

  it('cuts a message, a rule key and a rule text to their read bounds', () => {
    const report = read([
      issue({
        message: 'x'.repeat(1024 * 1024),
        rule: 'r'.repeat(5000),
      }),
    ], {
      rules: [
        {
          key: 'r'.repeat(5000),
          name: 't'.repeat(20_000),
        },
      ],
    })
    expect(report.issues[0].message).toBe('x'.repeat(READ_MESSAGE))
    expect(report.issues[0].ruleId).toBe('r'.repeat(READ_RULE_ID))
    expect(report.issues[0].ruleText).toBe('t'.repeat(READ_RULE_TEXT))
  })

  it('cuts a text without splitting a surrogate pair', () => {
    const half = `${'a'.repeat(READ_MESSAGE - 1)}${String.fromCodePoint(0x1F600)}`
    expect(read([
      issue({ message: half }),
    ]).issues[0].message).toBe('a'.repeat(READ_MESSAGE - 1))
  })

  it('names no commit, and sets no suppressed mark, snippet or level it was not given', () => {
    const [found] = read([
      issue({
        suppressions: [{}],
        snippet: 'code',
      }),
    ]).issues
    expect(found).not.toHaveProperty('suppressed')
    expect(found).not.toHaveProperty('snippet')
    expect(read([
      issue(),
    ])).not.toHaveProperty('commits')
  })

  it('reads a deeply nested extra field without walking it', () => {
    const depth = 100_000
    const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`
    const text = `{"paging":{"total":1,"extra":${nested}},"issues":[{"rule":"js:S1","component":"app:src/a.js","project":"app","status":"OPEN","message":"m","flows":${nested},"impacts":[{"severity":"HIGH","extra":${nested}}]}],"components":[{"key":"app:src/a.js","path":"src/a.js","extra":${nested}}],"rules":[{"key":"js:S1","name":"n","extra":${nested}}],"extra":${nested}}`
    expect(sonarqubeReport(text, checkout)).toMatchObject({
      problems: [],
      unreadable: 0,
      issues: [
        {
          path: 'src/a.js',
          ruleId: 'js:S1',
          ruleText: 'n',
          message: 'm',
          level: 'error',
        },
      ],
    })
  })
})
