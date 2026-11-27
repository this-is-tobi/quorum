import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { scanReports } from '../core/candidates.ts'
import { splitDiff } from '../core/diff.ts'
import { cutRead, MAX_RESULTS, MAX_RUNS, READ_COMMIT, READ_MESSAGE, READ_RULE_ID, READ_RULE_TEXT, READ_SCANNER, READ_SNIPPET } from '../core/reports.ts'
import { reportPathsOf } from './paths.ts'
import { sarifReport } from './sarif.ts'

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

function result(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: 'R1',
    message: { text: 'a message' },
    ...extra,
  }
}
function run(results: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: {
      driver: { name: 'Scanner' },
    },
    results,
    ...extra,
  }
}
const log = (...runs: unknown[]): string => JSON.stringify({ version: '2.1.0', runs })
function at(uri: string, startLine?: number): Record<string, unknown> {
  return {
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          ...(startLine === undefined
            ? {}
            : {
                region: { startLine },
              }),
        },
      },
    ],
  }
}
const read = (...runs: unknown[]): ReturnType<typeof sarifReport> => sarifReport(log(...runs), checkout)

const trivy = fixture('trivy.sarif').runs[0]
const semgrep = fixture('semgrep.sarif').runs[0]
const codeql = fixture('codeql.sarif').runs[0]
const eslint = fixture('eslint.sarif').runs[0]
const snippetOf = (found: any): string => found.locations[0].physicalLocation.region.snippet.text

describe('sarifReport', () => {
  it.each([
    [
      'trivy.sarif',
      {
        scanner: 'Trivy',
        problems: [],
        skipped: 0,
        unreadable: 0,
        issues: [
          {
            path: 'package-lock.json',
            line: 1,
            scanner: 'Trivy',
            ruleId: 'CVE-0000-0001',
            ruleText: trivy.tool.driver.rules[0].help.text,
            message: trivy.results[0].message.text,
            level: 'error',
          },
          {
            path: 'Dockerfile',
            line: 1,
            scanner: 'Trivy',
            ruleId: 'DS002',
            ruleText: trivy.tool.driver.rules[1].fullDescription.text,
            message: trivy.results[1].message.text,
            level: 'error',
          },
          {
            path: 'Dockerfile',
            line: 3,
            scanner: 'Trivy',
            ruleId: 'DS026',
            message: trivy.results[2].message.text,
            level: 'error',
          },
        ],
      },
    ],
    [
      'semgrep.sarif',
      {
        scanner: 'Semgrep OSS',
        problems: [],
        skipped: 0,
        unreadable: 0,
        issues: [
          {
            path: 'src/db.js',
            line: 12,
            scanner: 'Semgrep OSS',
            ruleId: semgrep.results[0].ruleId,
            ruleText: semgrep.tool.driver.rules[0].help.text,
            message: semgrep.results[0].message.text,
            level: 'error',
            snippet: snippetOf(semgrep.results[0]),
          },
          {
            path: 'src/app.js',
            line: 30,
            scanner: 'Semgrep OSS',
            ruleId: semgrep.results[1].ruleId,
            ruleText: semgrep.tool.driver.rules[1].help.text,
            message: semgrep.results[1].message.text,
            level: 'warning',
            suppressed: true,
            snippet: snippetOf(semgrep.results[1]),
          },
        ],
      },
    ],
    [
      'codeql.sarif',
      {
        scanner: 'CodeQL',
        commits: ['2222222222222222222222222222222222222222'],
        problems: [],
        skipped: 0,
        unreadable: 0,
        issues: [
          {
            path: 'src/db.js',
            line: 12,
            scanner: 'CodeQL',
            ruleId: 'js/sql-injection',
            ruleText: codeql.tool.extensions[0].rules[0].fullDescription.text,
            message: codeql.results[0].message.text,
            level: 'error',
          },
        ],
      },
    ],
    [
      'eslint.sarif',
      {
        scanner: 'ESLint',
        problems: [],
        skipped: 0,
        unreadable: 0,
        issues: [
          {
            path: 'src/a.js',
            line: 4,
            scanner: 'ESLint',
            ruleId: 'no-unused-vars',
            message: eslint.results[0].message.text,
            level: 'warning',
          },
        ],
      },
    ],
  ])('reads %s as its scanner writes it', (name, expected) => {
    expect(sarifReport(readFileSync(new URL(name, FIXTURES), 'utf8'), checkout)).toStrictEqual(expected)
  })

  it.each([
    [
      'null',
      { results: null },
    ],
    ['absent', {}],
    [
      'no list',
      {
        results: { a: 1 },
      },
    ],
  ])('reads a run whose results are %s as a scanner that failed', (_, extra) => {
    const failed = {
      tool: {
        driver: { name: 'Scanner' },
      },
      ...extra,
    }
    expect(read(failed).problems).toEqual(['no-results'])
    expect(read(failed, failed).problems).toEqual(['no-results'])
    expect(read(failed, run([])).problems).toEqual(['scanner-failed'])
    expect(read(run([]), failed).problems).toEqual(['scanner-failed'])
    expect(read(failed, run([
      result(),
    ]))).toMatchObject({
      problems: ['scanner-failed'],
      issues: [
        { ruleId: 'R1' },
      ],
    })
  })

  it('reads a log with no run, and a run that is no object, as holding no result list', () => {
    expect(read()).toStrictEqual({
      problems: ['no-results'],
      skipped: 0,
      unreadable: 0,
      issues: [],
    })
    expect(read(null)).toMatchObject({
      scanner: 'unnamed',
      problems: ['no-results'],
      issues: [],
    })
    expect(read('run', 3)).toMatchObject({
      problems: ['no-results'],
      issues: [],
    })
    expect(read(run([]), 7).problems).toEqual(['scanner-failed'])
  })

  it('reads an invocation that did not execute successfully as a scanner that failed', () => {
    const failed = (invocations: unknown) => read(run([
      result(),
    ], { invocations })).problems
    expect(failed([
      { executionSuccessful: false },
    ])).toEqual(['scanner-failed'])
    expect(failed([
      { executionSuccessful: true },
      { executionSuccessful: false },
    ])).toEqual(['scanner-failed'])
    expect(failed([
      { executionSuccessful: true },
    ])).toEqual([])
    expect(failed([{}])).toEqual([])
    expect(failed({ executionSuccessful: false })).toEqual([])
    expect(read(run(null, {
      invocations: [
        { executionSuccessful: false },
      ],
    })).problems).toEqual(['no-results', 'scanner-failed'])
  })

  it('counts a result of another kind as skipped, and one with no message, no rule id or an unsafe line as unreadable', () => {
    const text = log(run([
      result({ kind: 'pass' }),
      result({ kind: 'notApplicable' }),
      result({ message: {} }),
      {
        message: { text: 'no rule id' },
      },
      result({
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: 'src/a.js' },
              region: { startLine: 'AFTER_THE_LAST_SAFE_INTEGER' },
            },
          },
        ],
      }),
      result({ kind: 'fail', ruleId: 'FAILS' }),
      result({ ruleId: 'OPEN' }),
    ])).replace('"AFTER_THE_LAST_SAFE_INTEGER"', '9007199254740993')
    const report = sarifReport(text, checkout)
    expect(report).toMatchObject({ skipped: 2, unreadable: 3, problems: [] })
    expect(report.issues.map(issue => issue.ruleId)).toEqual(['FAILS', 'OPEN'])
  })

  it.each([
    ['a number', 7],
    ['null', null],
    ['an array', []],
    ['a string', 'result'],
  ])('counts a result that is %s as unreadable', (_, entry) => {
    expect(read(run([
      entry,
      result(),
    ]))).toMatchObject({
      unreadable: 1,
      skipped: 0,
      issues: [
        { ruleId: 'R1' },
      ],
    })
  })

  it.each([
    ['a number', 5],
    ['null', null],
    ['an object', {}],
  ])('counts a result whose kind is %s as unreadable, never as skipped', (_, kind) => {
    expect(read(run([
      result({ kind }),
    ]))).toMatchObject({ unreadable: 1, skipped: 0, issues: [] })
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '3'],
    ['null', null],
    ['an object', {}],
  ])('counts a result whose start line is %s as unreadable', (_, startLine) => {
    const entry = result({
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/a.js' },
            region: { startLine },
          },
        },
      ],
    })
    expect(read(run([entry]))).toMatchObject({ unreadable: 1, issues: [] })
  })

  it.each([
    [
      'a location that is no object',
      {
        locations: [7],
      },
    ],
    [
      'a physical location that is no object',
      {
        locations: [
          { physicalLocation: 'src/a.js' },
        ],
      },
    ],
    [
      'a region that is no object',
      {
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: 'a.js' },
              region: 'line 4',
            },
          },
        ],
      },
    ],
    [
      'a uri that is no string',
      {
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: 4 },
            },
          },
        ],
      },
    ],
    [
      'an artifact location that is no object',
      {
        locations: [
          {
            physicalLocation: { artifactLocation: 'a.js' },
          },
        ],
      },
    ],
  ])('counts a result with %s as unreadable, since quorum cannot say where it is', (_, entry) => {
    expect(read(run([
      result(entry),
    ]))).toMatchObject({ unreadable: 1, issues: [] })
  })

  it('reads a start line of 0, and a result with no region, as an issue', () => {
    expect(read(run([
      result(at('src/a.js', 0)),
    ])).issues).toStrictEqual([
      {
        path: 'src/a.js',
        line: 0,
        scanner: 'Scanner',
        ruleId: 'R1',
        message: 'a message',
        level: 'unknown',
      },
    ])
    expect(read(run([
      result(at('src/a.js')),
    ])).issues).toStrictEqual([
      {
        path: 'src/a.js',
        scanner: 'Scanner',
        ruleId: 'R1',
        message: 'a message',
        level: 'unknown',
      },
    ])
  })

  it('reads a result that names no file as an issue with neither a path nor an unmapped mark', () => {
    for (const entry of [
      {},
      { locations: [] },
      { locations: 'none' },
      {
        locations: [
          {
            logicalLocations: [
              { name: 'f' },
            ],
          },
        ],
      },
      {
        locations: [
          { physicalLocation: {} },
        ],
      },
      {
        locations: [
          {
            physicalLocation: { artifactLocation: {} },
          },
        ],
      },
    ]) {
      expect(read(run([
        result(entry),
      ])).issues).toStrictEqual([
        {
          scanner: 'Scanner',
          ruleId: 'R1',
          message: 'a message',
          level: 'unknown',
        },
      ])
    }
  })

  it('marks a path quorum cannot place as unmapped, with no path', () => {
    for (const uri of [
      'file:///elsewhere/a.js',
      '/elsewhere/a.js',
      'https://example.invalid/a.js',
      'src/../a.js',
      'C:/a.js',
      '',
    ]) {
      expect(read(run([
        result(at(uri, 3)),
      ])).issues).toStrictEqual([
        {
          unmapped: true,
          line: 3,
          scanner: 'Scanner',
          ruleId: 'R1',
          message: 'a message',
          level: 'unknown',
        },
      ])
    }
  })

  it('reads a relative uri from the scan root whatever its uriBaseId and originalUriBaseIds say', () => {
    const entry = result({
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/a.js', uriBaseId: 'ELSEWHERE' },
            region: { startLine: 2 },
          },
        },
      ],
    })
    const report = read(run([entry], {
      originalUriBaseIds: {
        ELSEWHERE: { uri: 'file:///elsewhere/' },
      },
    }))
    expect(report.issues).toMatchObject([
      { path: 'src/a.js', line: 2 },
    ])
  })

  it('puts the scan root\'s place below the top level in front of the paths it maps', () => {
    const app = reportPathsOf('/repo/packages/app', '/repo')
    const report = sarifReport(log(run([
      result(at('src/a.js', 1)),
      result(at('file:///repo/packages/app/src/b.js', 2)),
      result(at('file:///repo/src/c.js', 3)),
    ])), app)
    expect(report.issues.map(issue => issue.path)).toEqual(['packages/app/src/a.js', 'packages/app/src/b.js', undefined])
    expect(report.issues[2]).toMatchObject({ unmapped: true })
  })

  it('reads the first location alone', () => {
    const second = {
      physicalLocation: {
        artifactLocation: { uri: 'src/b.js' },
        region: { startLine: -4 },
      },
    }
    const entry = result({
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/a.js' },
            region: { startLine: 5 },
          },
        },
        second,
        3,
      ],
    })
    expect(read(run([entry]))).toMatchObject({
      unreadable: 0,
      issues: [
        { path: 'src/a.js', line: 5 },
      ],
    })
    expect(read(run([
      result({
        locations: [
          { logicalLocations: [] },
          second,
        ],
      }),
    ])).issues).toMatchObject([
      { scanner: 'Scanner' },
    ])
  })

  it('reads a missing level as unknown, never as ignorable', () => {
    expect(read(run([
      result(),
    ])).issues[0].level).toBe('unknown')
    expect(read(run([
      result({ level: 'critical' }),
    ])).issues[0].level).toBe('unknown')
    expect(read(run([
      result({ level: 3 }),
    ])).issues[0].level).toBe('unknown')
    expect(read(run([
      result({ level: '' }),
    ])).issues[0].level).toBe('unknown')
    expect(read(run([
      result(),
    ], {
      tool: {
        driver: {
          name: 'Scanner',
          rules: [
            {
              id: 'R1',
              defaultConfiguration: { level: 'verbose' },
            },
          ],
        },
      },
    })).issues[0].level).toBe('unknown')
  })

  it.each(['error', 'warning', 'note', 'none'])('reads the level %s as it is written', (level) => {
    expect(read(run([
      result({ level }),
    ])).issues[0].level).toBe(level)
  })

  it('takes the level of the result, else the rule\'s default', () => {
    const driver = {
      name: 'Scanner',
      rules: [
        {
          id: 'R1',
          defaultConfiguration: { level: 'error' },
        },
        {
          id: 'R2',
          defaultConfiguration: { level: 7 },
        },
      ],
    }
    const report = read(run([
      result({ level: 'note' }),
      result(),
      result({ ruleId: 'R2' }),
    ], {
      tool: { driver },
    }))
    expect(report.issues.map(issue => issue.level)).toEqual(['note', 'error', 'unknown'])
  })

  it('finds a rule by the result\'s own index, rule.index before ruleIndex, in the component rule.toolComponent names, else the driver', () => {
    const rule = (id: string, text: string): Record<string, unknown> => ({
      id,
      shortDescription: { text },
    })
    const tool = {
      driver: {
        name: 'Scanner',
        rules: [
          rule('A', 'driver 0'),
          rule('B', 'driver 1'),
        ],
      },
      extensions: [
        {
          rules: [
            rule('A', 'extension 0, 0'),
          ],
        },
        {
          rules: [
            rule('X', 'extension 1, 0'),
            rule('Y', 'extension 1, 1'),
          ],
        },
      ],
    }
    const text = (entry: Record<string, unknown>): string | undefined => read(run([
      result({ ruleId: 'Z', ...entry }),
    ], { tool })).issues[0].ruleText
    expect(text({ ruleIndex: 1 })).toBe('driver 1')
    expect(text({
      rule: { index: 0 },
      ruleIndex: 1,
    })).toBe('driver 0')
    expect(text({
      rule: {
        index: 1,
        toolComponent: { index: 1 },
      },
    })).toBe('extension 1, 1')
    expect(text({
      ruleIndex: 0,
      rule: {
        toolComponent: { index: 1 },
      },
    })).toBe('extension 1, 0')
    expect(text({
      rule: {
        index: 0,
        toolComponent: { index: 0 },
      },
    })).toBe('extension 0, 0')
    expect(text({ ruleIndex: 5 })).toBeUndefined()
    expect(text({
      rule: {
        index: 0,
        toolComponent: { index: 5 },
      },
    })).toBeUndefined()
    expect(text({ ruleIndex: -1 })).toBeUndefined()
    expect(text({ ruleIndex: 1.5 })).toBeUndefined()
    expect(text({ ruleIndex: '0' })).toBeUndefined()
  })

  it('finds a rule by its id when no index leads to one, the driver\'s before an extension\'s', () => {
    const tool = {
      driver: {
        name: 'Scanner',
        rules: [
          null,
          'rule',
          { id: 7, name: 'id 7' },
          { id: 'A', name: 'driver A' },
        ],
      },
      extensions: [
        {
          rules: [
            { id: 'A', name: 'extension A' },
            { id: 'B', name: 'extension B' },
          ],
        },
        'extension',
        { name: 'no rules' },
      ],
    }
    const text = (entry: Record<string, unknown>): string | undefined => read(run([
      result(entry),
    ], { tool })).issues[0].ruleText
    expect(text({ ruleId: 'A' })).toBe('driver A')
    expect(text({ ruleId: 'B' })).toBe('extension B')
    expect(text({ ruleId: 'B', ruleIndex: 9 })).toBe('extension B')
    expect(text({ ruleId: 'C' })).toBeUndefined()
    expect(text({ ruleId: 'constructor' })).toBeUndefined()
    expect(text({ ruleId: '__proto__' })).toBeUndefined()
  })

  it('reads the rule id from rule.id when the result has no ruleId', () => {
    const tool = {
      driver: {
        name: 'Scanner',
        rules: [
          { id: 'R9', name: 'nine' },
        ],
      },
    }
    const entry = {
      message: { text: 'm' },
      rule: { id: 'R9' },
    }
    expect(read(run([entry], { tool })).issues).toStrictEqual([
      {
        scanner: 'Scanner',
        ruleId: 'R9',
        ruleText: 'nine',
        message: 'm',
        level: 'unknown',
      },
    ])
    expect(read(run([
      { ...entry, ruleId: 'R1' },
    ], { tool })).issues[0]).toMatchObject({ ruleId: 'R1' })
    expect(read(run([
      { ...entry, ruleId: '' },
    ], { tool })).issues[0]).toMatchObject({ ruleId: 'R9' })
  })

  it.each([
    [
      'help.text',
      {
        help: { text: 'help' },
        fullDescription: { text: 'full' },
        shortDescription: { text: 'short' },
        name: 'name',
      },
      'help',
    ],
    [
      'fullDescription.text',
      {
        help: { text: '' },
        fullDescription: { text: 'full' },
        shortDescription: { text: 'short' },
        name: 'name',
      },
      'full',
    ],
    [
      'shortDescription.text',
      {
        help: {},
        fullDescription: { text: 4 },
        shortDescription: { text: 'short' },
        name: 'name',
      },
      'short',
    ],
    [
      'name',
      {
        help: 'help',
        fullDescription: null,
        shortDescription: [],
        name: 'name',
      },
      'name',
    ],
    [
      'nothing',
      {
        help: { markdown: 'only markdown' },
        id: 'R1',
      },
      undefined,
    ],
  ])('takes a rule\'s text from its %s', (_, rule, expected) => {
    const report = read(run([
      result(),
    ], {
      tool: {
        driver: {
          name: 'Scanner',
          rules: [
            { id: 'R1', ...rule },
          ],
        },
      },
    }))
    expect(report.issues[0].ruleText).toBe(expected)
    expect(Object.keys(report.issues[0])).toEqual(expected === undefined
      ? [
          'scanner',
          'ruleId',
          'message',
          'level',
        ]
      : [
          'scanner',
          'ruleId',
          'ruleText',
          'message',
          'level',
        ])
  })

  it('takes the message from the result, else from the rule\'s short description', () => {
    const tool = {
      driver: {
        name: 'Scanner',
        rules: [
          {
            id: 'R1',
            shortDescription: { text: 'the short description' },
            help: { text: 'help' },
          },
        ],
      },
    }
    const entry = { ruleId: 'R1' }
    expect(read(run([
      {
        ...entry,
        message: { text: 'own' },
      },
    ], { tool })).issues[0].message).toBe('own')
    expect(read(run([
      {
        ...entry,
        message: { text: '' },
      },
    ], { tool })).issues[0].message).toBe('the short description')
    expect(read(run([
      {
        ...entry,
        message: { markdown: 'only markdown' },
      },
    ], { tool })).issues[0].message).toBe('the short description')
    expect(read(run([entry], { tool })).issues[0].message).toBe('the short description')
    expect(read(run([entry], {
      tool: {
        driver: {
          name: 'Scanner',
          rules: [
            {
              id: 'R1',
              help: { text: 'help' },
            },
          ],
        },
      },
    }))).toMatchObject({ unreadable: 1, issues: [] })
  })

  it('marks an issue suppressed by an accepted suppression alone', () => {
    const suppressed = (suppressions: unknown): boolean => read(run([
      result({ suppressions }),
    ])).issues[0].suppressed === true
    expect(suppressed([
      { kind: 'inSource' },
    ])).toBe(true)
    expect(suppressed([
      { kind: 'external', status: 'accepted' },
      {},
    ])).toBe(true)
    expect(suppressed([{}])).toBe(true)
    expect(suppressed([
      { status: 'accepted' },
    ])).toBe(true)
    expect(suppressed([
      { status: 'rejected' },
      { status: 'accepted' },
    ])).toBe(true)
    expect(suppressed([
      0,
      { status: 'underReview' },
      {},
    ])).toBe(true)
    expect(suppressed([])).toBe(false)
    expect(suppressed(undefined)).toBe(false)
    expect(suppressed({ kind: 'inSource' })).toBe(false)
    expect(suppressed('inSource')).toBe(false)
    expect('suppressed' in read(run([
      result({ suppressions: [] }),
    ])).issues[0]).toBe(false)
  })

  it.each([
    [
      'a rejected suppression',
      [
        { kind: 'inSource', status: 'rejected' },
      ],
    ],
    [
      'a suppression under review',
      [
        { status: 'underReview' },
      ],
    ],
    [
      'a suppression whose status is no known word',
      [
        { status: 'ACCEPTED' },
      ],
    ],
    [
      'a suppression whose status is no string',
      [
        { status: true },
      ],
    ],
    [
      'a suppression whose status is null',
      [
        { status: null },
      ],
    ],
    [
      'a rejected one and one under review',
      [
        { status: 'rejected' },
        { status: 'underReview' },
      ],
    ],
    [
      'an entry that is the number 0',
      [0],
    ],
    [
      'an entry that is null',
      [null],
    ],
    [
      'an entry that is a string',
      ['accepted'],
    ],
    [
      'an entry that is an array',
      [
        [{}],
      ],
    ],
    [
      'an entry that is a boolean',
      [true],
    ],
    [
      'entries that are no objects, one after another',
      [0, null, 'accepted', [], false],
    ],
  ])('does not mark an issue suppressed by %s, and still reads it', (_, suppressions) => {
    const report = read(run([
      result({ suppressions }),
    ]))
    expect(report).toMatchObject({
      unreadable: 0,
      skipped: 0,
      problems: [],
      issues: [
        { ruleId: 'R1' },
      ],
    })
    expect(report.issues[0]).not.toHaveProperty('suppressed')
  })

  it('reads the snippet of the first location\'s region, when it holds text', () => {
    const snippet = (value: unknown): string | undefined => read(run([
      result({
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: 'a.js' },
              region: { startLine: 1, snippet: value },
            },
          },
        ],
      }),
    ])).issues[0].snippet
    expect(snippet({ text: 'code();' })).toBe('code();')
    expect(snippet({ text: '' })).toBeUndefined()
    expect(snippet({ text: 4 })).toBeUndefined()
    expect(snippet('code();')).toBeUndefined()
    expect(snippet(undefined)).toBeUndefined()
  })

  it('names the scanner by each run\'s tool.driver.name, and a name that is no string as unnamed', () => {
    const named = (name: unknown): ReturnType<typeof sarifReport> => read({
      tool: {
        driver: { name },
      },
      results: [
        result(),
      ],
    })
    expect(named('Scanner A')).toMatchObject({
      scanner: 'Scanner A',
      issues: [
        { scanner: 'Scanner A' },
      ],
    })
    for (const name of [
      undefined,
      null,
      5,
      '',
      {},
      ['a'],
    ]) {
      expect(named(name)).toMatchObject({
        scanner: 'unnamed',
        issues: [
          { scanner: 'unnamed' },
        ],
      })
    }
    expect(read({
      results: [
        result(),
      ],
    })).toMatchObject({ scanner: 'unnamed' })
    expect(read({
      tool: 'tool',
      results: [
        result(),
      ],
    })).toMatchObject({ scanner: 'unnamed' })
    expect(read({
      tool: { driver: 'driver' },
      results: [
        result(),
      ],
    })).toMatchObject({ scanner: 'unnamed' })
    const two = read(run([
      result({ ruleId: 'A' }),
    ]), {
      tool: {
        driver: { name: 'Second' },
      },
      results: [
        result({ ruleId: 'B' }),
      ],
    })
    expect(two.scanner).toBe('Scanner')
    expect(two.issues.map(issue => [issue.scanner, issue.ruleId])).toEqual([
      ['Scanner', 'A'],
      ['Second', 'B'],
    ])
  })

  it('collects each revision a run states, once, cut at 64 units', () => {
    const states = (revisions: unknown): unknown => read(run([
      result(),
    ], { versionControlProvenance: revisions })).commits
    expect(states([
      {
        revisionId: 'a'.repeat(40),
      },
      {
        revisionId: 'b'.repeat(40),
      },
      {
        revisionId: 'a'.repeat(40),
      },
    ])).toEqual([
      'a'.repeat(40),
      'b'.repeat(40),
    ])
    expect(states([
      {
        revisionId: 'c'.repeat(READ_COMMIT + 36),
      },
    ])).toEqual([
      'c'.repeat(READ_COMMIT),
    ])
    expect(states([
      { revisionId: '' },
      { revisionId: 4 },
      { branch: 'main' },
      null,
      'dddd',
      { revisionId: 'main' },
    ])).toEqual(['main'])
    for (const none of [
      [],
      undefined,
      {},
      'dddddddd',
      [{}],
    ]) expect(states(none)).toBeUndefined()
    const two = read(run([
      result(),
    ], {
      versionControlProvenance: [
        {
          revisionId: 'a'.repeat(40),
        },
      ],
    }), run([
      result(),
    ], {
      versionControlProvenance: [
        {
          revisionId: 'b'.repeat(40),
        },
      ],
    }))
    expect(two.commits).toEqual([
      'a'.repeat(40),
      'b'.repeat(40),
    ])
    expect('commits' in read(run([
      result(),
    ]))).toBe(false)
  })

  it('reads at most 20 runs and 25000 results a run, and says the rest was not read', () => {
    const many = Array.from({ length: MAX_RUNS + 1 }, (_, at) => run([
      result({ ruleId: `R${at}` }),
    ]))
    const runs = read(...many)
    expect(runs.problems).toEqual(['too-many'])
    expect(runs.issues).toHaveLength(MAX_RUNS)
    expect(runs.issues.at(-1)?.ruleId).toBe(`R${MAX_RUNS - 1}`)
    const results = read(run(Array.from({ length: MAX_RESULTS + 1 }, () => result())))
    expect(results.problems).toEqual(['too-many'])
    expect(results.issues).toHaveLength(MAX_RESULTS)
    const exact = read(run(Array.from({ length: MAX_RESULTS }, () => result())))
    expect(exact.problems).toEqual([])
    expect(exact.issues).toHaveLength(MAX_RESULTS)
    expect(read(...many.slice(0, MAX_RUNS)).problems).toEqual([])
  })

  it('counts the results it did not read, and the runs, so a limit is said as N of M', () => {
    const results = (count: number): unknown[] => Array.from({ length: count }, () => result())
    // A run of 25001 results: the one past the limit is not read, and no run is cut.
    expect(read(run(results(MAX_RESULTS + 1)))).toMatchObject({
      notRead: 1,
      problems: ['too-many'],
    })
    expect(read(run(results(MAX_RESULTS + 1)))).not.toHaveProperty('runs')
    // 21 runs: the results of the one past the limit are counted without reading an entry, whatever they are.
    const cut = read(...Array.from({ length: MAX_RUNS }, () => run(results(1))), run([
      5,
      result({ kind: 'pass' }),
      result(),
    ]))
    expect(cut).toMatchObject({
      notRead: 3,
      runs: MAX_RUNS + 1,
      skipped: 0,
      unreadable: 0,
      problems: ['too-many'],
    })
    expect(cut.issues).toHaveLength(MAX_RUNS)
    // Both at once, a run past the limit and a read run over it: the counts add up.
    expect(read(run(results(MAX_RESULTS + 2)), ...Array.from({ length: MAX_RUNS }, () => run(results(2))))).toMatchObject({ notRead: 4, runs: MAX_RUNS + 1 })
    // Runs past the limit that hold no result lose no result, and are still said: a run with no list, an empty list, an entry that is no run.
    const empty = read(...Array.from({ length: MAX_RUNS }, () => run(results(1))), run([]), run(null), 'not a run')
    expect(empty).toMatchObject({
      runs: MAX_RUNS + 3,
      problems: ['too-many'],
    })
    expect(empty).not.toHaveProperty('notRead')
    // Within the limits, neither count is there.
    const within = read(...Array.from({ length: MAX_RUNS }, () => run(results(1))))
    expect(within).not.toHaveProperty('notRead')
    expect(within).not.toHaveProperty('runs')
    expect(read(run(results(MAX_RESULTS)))).not.toHaveProperty('notRead')
  })

  it('hands the core what lets it say every limit as N of M: what the file held is what the report lists, and the gap carries the numbers', () => {
    const sections = splitDiff([
      'diff --git a/src/a.js b/src/a.js',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1,1 +1,2 @@',
      ' one',
      '+two',
    ].join('\n'))
    const placed = (...runs: unknown[]): { listed: number, notRead?: number, sum: number, gap?: string } => {
      const scan = scanReports({
        reports: [
          {
            format: 'sarif',
            profile: 'security',
            ...read(...runs),
          },
        ],
        sections,
        leftOut: [],
        maxScannerIssues: 50,
      })
      const { listed, fileLevel: _, ...counts } = scan.records[0].issues!
      return {
        listed,
        notRead: counts.notRead,
        sum: Object.values(counts).reduce((total, count) => total + count, 0),
        gap: scan.profiles.get('security')?.gaps[0]?.detail,
      }
    }
    // A log of 21 runs of 2 results: the 21st is not read, and its 2 results are counted.
    expect(placed(...Array.from({ length: MAX_RUNS + 1 }, () => run([
      result(),
      result({ ruleId: 'R2' }),
    ])))).toEqual({
      listed: 42,
      notRead: 2,
      sum: 42,
      gap: 'report 1 (sarif) was read in part: 2 of its 42 results and 1 of its 21 runs were not read',
    })
    // A run of 25001 results, which the file held.
    expect(placed(run(Array.from({ length: MAX_RESULTS + 1 }, () => result())))).toEqual({
      listed: MAX_RESULTS + 1,
      notRead: 1,
      sum: MAX_RESULTS + 1,
      gap: 'report 1 (sarif) was read in part: 1 of its 25001 results were not read',
    })
    // Runs past the 20th that hold no result.
    expect(placed(...Array.from({ length: MAX_RUNS }, () => run([
      result(),
    ])), run([]))).toEqual({
      listed: MAX_RUNS,
      sum: MAX_RUNS,
      gap: 'report 1 (sarif) was read in part: 1 of its 21 runs were not read',
    })
  })

  it('counts nothing past the 25000 results it reads as skipped or unreadable', () => {
    const past = Array.from({ length: MAX_RESULTS }, () => result())
    expect(read(run([
      ...past,
      5,
      result({ kind: 'pass' }),
    ]))).toMatchObject({
      problems: ['too-many'],
      skipped: 0,
      unreadable: 0,
    })
  })

  it('names every problem a log has, in the order of the problem list', () => {
    const report = read(
      run(null),
      ...Array.from({ length: MAX_RUNS }, () => run(Array.from({ length: 1 }, () => result()), {
        invocations: [
          { executionSuccessful: false },
        ],
      })),
    )
    expect(report.problems).toEqual(['too-many', 'scanner-failed'])
    expect(read(run(null, {
      invocations: [
        { executionSuccessful: false },
      ],
    })).problems).toEqual(['no-results', 'scanner-failed'])
  })

  it.each([
    ['an empty text', ''],
    ['a truncated object', '{'],
    ['an array', '[]'],
    ['a string', '"runs"'],
    ['null', 'null'],
    ['a number', '3'],
    ['runs that is an object', '{"runs":{}}'],
    ['runs that is a string', '{"runs":"none"}'],
    ['no runs', '{"version":"2.1.0"}'],
    ['runs that is null', '{"runs":null}'],
    ['a saved SonarQube response', '{"issues":[],"total":0}'],
  ])('reads %s as no SARIF log', (_, text) => {
    expect(sarifReport(text, checkout)).toStrictEqual({
      problems: ['not-the-format'],
      skipped: 0,
      unreadable: 0,
      issues: [],
    })
  })

  it('cuts a message, a rule text, a rule id, a scanner name and a snippet to their read bounds, and a rule\'s text once for all its issues', () => {
    const big = 'x'.repeat(1024 * 1024)
    const tool = {
      driver: {
        name: 'n'.repeat(1000),
        rules: [
          {
            id: 'r'.repeat(5000),
            help: {
              text: 't'.repeat(20_000),
            },
          },
        ],
      },
    }
    const location = {
      physicalLocation: {
        artifactLocation: { uri: 'a.js' },
        region: {
          startLine: 1,
          snippet: {
            text: 's'.repeat(5000),
          },
        },
      },
    }
    const entry = result({
      ruleId: 'r'.repeat(5000),
      message: { text: big },
      locations: [location],
    })
    vi.mocked(cutRead).mockClear()
    const report = read(run([entry, entry, entry], { tool }))
    const [first, second] = report.issues
    // A string is compared by its characters, so only the count of cuts says the text was cut once.
    expect(vi.mocked(cutRead).mock.calls.filter(([text]) => text.length === 20_000)).toHaveLength(1)
    expect(first.message).toBe('x'.repeat(READ_MESSAGE))
    expect(first.ruleId).toBe('r'.repeat(READ_RULE_ID))
    expect(first.ruleText).toBe('t'.repeat(READ_RULE_TEXT))
    expect(first.scanner).toBe('n'.repeat(READ_SCANNER))
    expect(first.snippet).toBe('s'.repeat(READ_SNIPPET))
    expect(report.scanner).toBe('n'.repeat(READ_SCANNER))
    expect(first.ruleText).toBe(second.ruleText)
  })

  it('cuts the rule\'s short description, which a result with no message takes, to the message bound', () => {
    const tool = {
      driver: {
        name: 'Scanner',
        rules: [
          {
            id: 'R1',
            shortDescription: {
              text: 'd'.repeat(10_000),
            },
          },
        ],
      },
    }
    expect(read(run([
      { ruleId: 'R1' },
    ], { tool })).issues[0].message).toBe('d'.repeat(READ_MESSAGE))
  })

  it('cuts a text without splitting a surrogate pair', () => {
    const half = `${'a'.repeat(READ_MESSAGE - 1)}${String.fromCodePoint(0x1F600)}`
    expect(read(run([
      result({
        message: { text: half },
      }),
    ])).issues[0].message).toBe('a'.repeat(READ_MESSAGE - 1))
  })

  it('reads a deeply nested properties object without walking it', () => {
    const depth = 100_000
    const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`
    const text = `{"runs":[{"tool":{"driver":{"name":"S","properties":${nested},"rules":[{"id":"R1","properties":${nested},"help":{"text":"h"}}]}},"properties":${nested},"results":[{"ruleId":"R1","message":{"text":"m","properties":${nested}},"properties":${nested},"suppressions":[{"kind":"external","properties":${nested}},${nested}]}]}]}`
    expect(sarifReport(text, checkout)).toMatchObject({
      problems: [],
      unreadable: 0,
      issues: [
        {
          ruleId: 'R1',
          ruleText: 'h',
          message: 'm',
          suppressed: true,
        },
      ],
    })
  })
})
