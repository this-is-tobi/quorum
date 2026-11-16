import { describe, expect, it } from 'vitest'
import type { Outcome } from '../core/outcome.ts'
import type { FailOn, LeftOutFile, PublicView, QuorumResult, Verdict } from '../core/types.ts'
import { HOSTILE, RLO } from '../testing/markdown.ts'
import { blankResult, FINDINGS, LIFTED, reportMeta, reportResult, SQL, TOKEN, UPLOAD } from '../testing/report.ts'
import { githubSarif } from '../testing/sarif.ts'
import { artifactUri, DOCS_URL, FINGERPRINT_KEY, MAX_LOCATIONS, sarif, SARIF_SCHEMA } from './sarif.ts'
import { publicView } from './view.ts'

const HEAD = '7b2e4d0'.padEnd(40, 'a')

interface Notification {
  level: string
  message: { text: string }
  locations?: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>
  properties: Record<string, unknown>
}

interface Region {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

interface Run {
  invocations: Array<{ executionSuccessful: boolean, toolExecutionNotifications: Notification[] }>
  results: Array<{ level: string, message: { text: string }, locations: Array<{ physicalLocation: { artifactLocation: { uri: string }, region: Region } }> }>
}

function render(result: QuorumResult | PublicView, outcome: Outcome = FINDINGS): string {
  return sarif.render(result, { color: false, outcome })
}

/** The one run of a result's document. */
function runOf(result: QuorumResult | PublicView): Run {
  return (JSON.parse(render(result)) as { runs: Run[] }).runs[0]
}

const notificationsOf = (result: QuorumResult | PublicView): Notification[] => runOf(result).invocations[0].toolExecutionNotifications

/** What the secrets fix records for a held file, a reviewed one and a deleted secret, on the staged changes. */
function secrets(): QuorumResult {
  return blankResult({
    source: { kind: 'staged', head: HEAD, objectFormat: 'sha1' },
    profiles: {
      security: {
        ...reportMeta().profiles.security,
        coverage: [
          { file: '.env', status: 'unreviewed', reason: 'secret' },
          { file: 'a.js', status: 'reviewed' },
          { file: 'old/.env', status: 'unreviewed', reason: 'deleted-secret' },
        ],
      },
    },
    incomplete: [
      { profile: 'security', reason: 'secret', detail: 'no model was sent 1 file(s) held as secrets, listed in meta.leftOut' },
    ],
    leftOut: [
      { file: '.env', reason: 'secret', rule: 'name' },
      { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
    ],
    flags: [
      { code: 'secret-file', file: '.env', detail: 'named as a secret, so no model was sent any of it: check that it belongs in the change' },
    ],
  })
}

/** A review of `kept` and `unreviewed`, the profile `security` at `failOn`, and every finding's file among its coverage. */
function reviewOf(kept: Verdict[], unreviewed: Verdict[] = [], failOn: FailOn = 'high'): QuorumResult {
  const security = reportMeta().profiles.security
  return reportResult({
    kept,
    unreviewed,
    meta: {
      profiles: {
        security: {
          ...security,
          failOn,
          gating: failOn !== 'none',
          coverage: [
            ...kept,
            ...unreviewed,
          ].map(({ file }) => ({ file, status: 'reviewed' as const })),
        },
      },
      incomplete: [],
      leftOut: [],
      flags: [],
    },
  })
}

const MAIN = {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'quorum',
          version: '0.6.0',
          informationUri: 'https://this-is-tobi.com/quorum/introduction',
          rules: [
            {
              id: 'quorum/security',
              shortDescription: { text: 'A finding of quorum\'s security profile' },
              fullDescription: { text: 'A finding the security profile\'s research reported, which its panel of blind voters kept or left unreviewed: a claim about the code that a person checks.' },
              help: { text: 'Its level says what the finding does to the review: error at or above the profile\'s fail-on level, high; warning for another kept high or medium finding and an unreviewed one; note for low. The review\'s summary holds its evidence.' },
              defaultConfiguration: { level: 'warning' },
            },
          ],
        },
      },
      invocations: [
        {
          executionSuccessful: false,
          toolExecutionNotifications: [
            {
              level: 'error',
              message: { text: 'security, binary: the diff carries no content for a binary file (1 file)' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'assets/logo.png' },
                  },
                },
              ],
              properties: { profile: 'security', reason: 'binary', count: 1 },
            },
          ],
        },
      ],
      results: [
        {
          ruleId: 'quorum/security',
          ruleIndex: 0,
          level: 'error',
          message: { text: 'HIGH, kept by 3 of 3 lenses: CWE-89: SQL built from the request\'s id parameter reaches db.query' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'src/auth/login.ts' },
                region: {
                  startLine: 42,
                  startColumn: 1,
                  endLine: 42,
                  endColumn: 14,
                },
              },
            },
          ],
          partialFingerprints: { 'quorumFingerprint/v1': 'a1b2c3d4e5f60718:1' },
          properties: { precision: 'high' },
        },
        {
          ruleId: 'quorum/security',
          ruleIndex: 0,
          level: 'warning',
          message: { text: 'UNREVIEWED, kept by 1 of 3 lenses, 1 vote failed: CWE-338: Session tokens come from Math.random, which is not a cryptographic generator.' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'src/session.js' },
                region: {
                  startLine: 20,
                  startColumn: 1,
                  endLine: 20,
                  endColumn: 45,
                },
              },
            },
          ],
          partialFingerprints: { 'quorumFingerprint/v1': 'b1c2d3e4f5061728:1' },
        },
      ],
      properties: { commit: '7b2e4d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    },
  ],
}

describe('sarif', () => {
  it('writes one run of the review: its rule, its results, its notifications and its commit', () => {
    expect(JSON.parse(render(reportResult()))).toEqual(MAIN)
    expect(MAIN.$schema).toBe(SARIF_SCHEMA)
    expect(MAIN.runs[0].tool.driver.informationUri).toBe(DOCS_URL)
    expect(Object.keys(MAIN.runs[0].results[0].partialFingerprints)).toEqual([FINGERPRINT_KEY])
    expect(render(reportResult()).endsWith('\n')).toBe(true)
  })

  it('passes the schema of the fields GitHub reads for every fixture', () => {
    const hostile = reviewOf([HOSTILE])
    for (const result of [
      reportResult(),
      blankResult(),
      secrets(),
      hostile,
    ]) {
      expect(githubSarif.parse(JSON.parse(render(result)))).toBeDefined()
    }
    expect(runOf(hostile).results).toHaveLength(1)
  })

  it.each<[string, string, Verdict[], Verdict[], FailOn]>([
    [
      'error',
      'kept high finding at fail-on high',
      [
        { ...SQL, confidence: 'high' },
      ],
      [],
      'high',
    ],
    [
      'warning',
      'kept medium finding at fail-on high',
      [
        { ...SQL, confidence: 'medium' },
      ],
      [],
      'high',
    ],
    [
      'error',
      'kept medium finding at fail-on medium',
      [
        { ...SQL, confidence: 'medium' },
      ],
      [],
      'medium',
    ],
    [
      'error',
      'kept low finding at fail-on low',
      [
        { ...SQL, confidence: 'low' },
      ],
      [],
      'low',
    ],
    [
      'note',
      'kept low finding at fail-on high',
      [
        { ...SQL, confidence: 'low' },
      ],
      [],
      'high',
    ],
    [
      'warning',
      'kept high finding of an advisory profile',
      [
        { ...SQL, confidence: 'high' },
      ],
      [],
      'none',
    ],
    [
      'warning',
      'unreviewed finding',
      [],
      [TOKEN],
      'high',
    ],
  ])('sets %s for a %s', (level, _name, kept, unreviewed, failOn) => {
    expect(runOf(reviewOf(kept, unreviewed, failOn)).results.map(result => result.level)).toEqual([level])
  })

  it('says the run did not succeed when a gating profile has a gap or an unreviewed finding, a kept finding or the lift aside', () => {
    const successful = (result: QuorumResult): boolean => runOf(result).invocations[0].executionSuccessful
    expect(successful(reportResult())).toBe(false)
    expect(JSON.parse(sarif.render(reportResult(), { color: false, outcome: LIFTED })).runs[0].invocations[0].executionSuccessful).toBe(false)
    expect(successful(secrets())).toBe(false)
    expect(successful(blankResult())).toBe(true)
    const advisory = reportResult({
      kept: [],
      unreviewed: [],
      meta: {
        profiles: {
          security: {
            ...reportMeta().profiles.security,
            failOn: 'none',
            gating: false,
          },
        },
      },
    })
    expect(successful(advisory)).toBe(true)
    expect(notificationsOf(advisory).map(({ level }) => level)).toEqual(['warning'])
  })

  it('lists each gap with at most 100 of its files and their count, and the files left out with no gap as notes', () => {
    const files = Array.from({ length: 150 }, (_, index) => `img/${index}.png`)
    const many = blankResult({
      profiles: {
        security: {
          ...reportMeta().profiles.security,
          coverage: files.map(file => ({ file, status: 'unreviewed' as const, reason: 'binary' as const })),
        },
      },
      incomplete: [
        { profile: 'security', reason: 'binary', detail: 'd' },
      ],
      leftOut: files.map(file => ({ file, reason: 'binary' as const })),
    })
    const [binary, ...rest] = notificationsOf(many)
    expect(rest).toEqual([])
    expect(binary.level).toBe('error')
    expect(binary.message.text).toBe('security, binary: the diff carries no content for a binary file (150 files)')
    expect(binary.locations).toHaveLength(MAX_LOCATIONS)
    expect(binary.locations?.[0].physicalLocation.artifactLocation.uri).toBe('img/0.png')
    expect(binary.properties).toEqual({ profile: 'security', reason: 'binary', count: 150 })

    expect(notificationsOf(secrets())).toEqual([
      {
        level: 'error',
        message: { text: 'security, secret: a file held back as a secret was sent to no model (1 file)' },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: '.env' },
            },
          },
        ],
        properties: { profile: 'security', reason: 'secret', count: 1 },
      },
      {
        level: 'note',
        message: { text: '1 file left out: deleted-secret' },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: 'old/.env' },
            },
          },
        ],
        properties: { reason: 'deleted-secret', count: 1 },
      },
    ])

    const leftOut: LeftOutFile[] = [
      { file: 'z/.env', reason: 'deleted-secret', rule: 'name' },
      { file: 'vendor/x.js', reason: 'skipped', rule: 'vendored' },
      { file: 'dist/a.js', reason: 'excluded' },
      { file: 'dist/b.js', reason: 'excluded' },
    ]
    const notes = notificationsOf(blankResult({ leftOut }))
    expect(notes.map(({ level, message }) => `${level}: ${message.text}`)).toEqual([
      'note: 2 files left out: excluded',
      'note: 1 file left out: skipped',
      'note: 1 file left out: deleted-secret',
    ])
    expect(notes[0].locations?.map(({ physicalLocation }) => physicalLocation.artifactLocation.uri)).toEqual(['dist/a.js', 'dist/b.js'])
  })

  it('locates only the clean relative paths of a notification, and counts every file', () => {
    const unclean = [
      '//host/x',
      '/abs/x',
      '../x',
      'a//b',
    ]
    const files = [
      ...unclean,
      'img/ok.png',
    ]
    const result = blankResult({
      profiles: {
        security: {
          ...reportMeta().profiles.security,
          coverage: files.map(file => ({ file, status: 'unreviewed' as const, reason: 'binary' as const })),
        },
      },
      incomplete: [
        { profile: 'security', reason: 'binary', detail: 'd' },
      ],
      leftOut: [
        ...files.map(file => ({ file, reason: 'excluded' as const })),
        ...unclean.map((file): LeftOutFile => ({ file, reason: 'skipped', rule: 'vendored' })),
        ...unclean.map((file): LeftOutFile => ({ file, reason: 'deleted-secret', rule: 'name' })),
      ],
    })
    const [binary, excluded, skipped, deleted] = notificationsOf(result)
    expect(binary.message.text).toBe('security, binary: the diff carries no content for a binary file (5 files)')
    expect(binary.properties.count).toBe(5)
    expect(binary.locations?.map(({ physicalLocation }) => physicalLocation.artifactLocation.uri)).toEqual(['img/ok.png'])
    expect(excluded.message.text).toBe('5 files left out: excluded')
    expect(excluded.properties.count).toBe(5)
    expect(excluded.locations?.map(({ physicalLocation }) => physicalLocation.artifactLocation.uri)).toEqual(['img/ok.png'])
    for (const note of [skipped, deleted]) {
      expect(note.properties.count).toBe(4)
      expect(Object.hasOwn(note, 'locations')).toBe(false)
    }
    expect(render(result)).not.toContain('host')
    expect(githubSarif.parse(JSON.parse(render(result)))).toBeDefined()
  })

  it('writes a valid location for line 0, no cited row, a row of tabs, and a path with a space, a percent sign, a hash, a question mark, a hidden character or a lone surrogate', () => {
    const at = (file: string, changes: Partial<Verdict> = {}): Verdict => ({
      ...SQL,
      file,
      ...changes,
    })
    const verdicts = [
      at('line0.js', { line: 0 }),
      at('nocite.js', { evidenceRow: undefined }),
      at('removed.js', { evidence: '-gone()\n+kept()', evidenceRow: 0 }),
      at('tabs.js', { evidence: '+\t\tx', evidenceRow: 0 }),
      at('a b/c%d#e?f.js'),
      at(`x${RLO}.js`),
      at(`y${String.fromCharCode(0xD800)}.js`),
    ]
    const result = reviewOf(verdicts)
    const run = runOf(result)
    const byUri = new Map(run.results.map(({ locations }) => [locations[0].physicalLocation.artifactLocation.uri, locations[0].physicalLocation.region]))
    expect(byUri.get('line0.js')).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 14,
    })
    expect(byUri.get('nocite.js')).toEqual({
      startLine: 42,
      startColumn: 1,
      endLine: 42,
      endColumn: 1,
    })
    expect(byUri.get('removed.js')).toEqual({
      startLine: 42,
      startColumn: 1,
      endLine: 42,
      endColumn: 1,
    })
    expect(byUri.get('tabs.js')).toEqual({
      startLine: 42,
      startColumn: 1,
      endLine: 42,
      endColumn: 4,
    })
    expect([
      ...byUri.keys(),
    ]).toEqual([
      'a%20b/c%25d%23e%3Ff.js',
      'line0.js',
      'nocite.js',
      'removed.js',
      'tabs.js',
      'x%E2%80%AE.js',
      'y%EF%BF%BD.js',
    ])
    expect(run.results).toHaveLength(verdicts.length)
    expect(githubSarif.parse(JSON.parse(render(result)))).toBeDefined()
    expect(artifactUri('a b/c%d#e?f.js')).toBe('a%20b/c%25d%23e%3Ff.js')
    expect(artifactUri(`x${RLO}.js`)).toBe('x%E2%80%AE.js')
    expect(artifactUri(`y${String.fromCharCode(0xD800)}.js`)).toBe('y%EF%BF%BD.js')
  })

  it('leaves a finding of a diff with no per-file headers out of the results, and counts it in a note', () => {
    const result = reviewOf([SQL])
    result.kept = [
      { ...SQL, file: 'the finder\'s name' },
    ]
    result.meta.profiles.security.coverage = [
      { file: '', status: 'reviewed' },
    ]
    expect(runOf(result).results).toEqual([])
    expect(notificationsOf(result)).toEqual([
      {
        level: 'note',
        message: { text: 'findings that name no file of the diff, which no result holds: 1' },
        properties: { count: 1 },
      },
    ])
    expect(githubSarif.parse(JSON.parse(render(result)))).toBeDefined()
  })

  it('counts a finding on a path that is not a clean relative path in the note, and writes no result for it', () => {
    const files = [
      '/abs/x.js',
      'a//b.js',
      '../x.js',
      'a/./b.js',
    ]
    const result = reviewOf(files.map(file => ({ ...SQL, file })))
    expect(runOf(result).results).toEqual([])
    expect(notificationsOf(result)).toEqual([
      {
        level: 'note',
        message: { text: 'findings that name no file of the diff, which no result holds: 4' },
        properties: { count: 4 },
      },
    ])
    expect(githubSarif.parse(JSON.parse(render(result)))).toBeDefined()
    expect(artifactUri('a:b.js')).toBe('a%3Ab.js')
    expect(artifactUri('c:x/y.js')).toBe('c%3Ax/y.js')
  })

  it('writes the claim through inertPlain, and no Markdown', () => {
    const [{ message }] = runOf(reviewOf([
      { ...SQL, category: 'CWE-1', summary: '@octocat #12 https://e.example' },
    ])).results
    expect(message.text).toBe('HIGH, kept by 3 of 3 lenses: CWE-1: <U+0040>octocat <U+0023>12 https<U+003A>//e.example')
    expect(message.text.endsWith('<U+0040>octocat <U+0023>12 https<U+003A>//e.example')).toBe(true)
    expect(render(reviewOf([SQL]))).not.toContain('"markdown"')
  })

  it('renders the public view of a full result: no reasoning, no discarded finding', () => {
    const result = reportResult()
    const text = render(result)
    expect(text).toBe(render(publicView(result)))
    expect(text).not.toContain('reasoning')
    expect(text).not.toContain(UPLOAD.fingerprint)
    expect(text).not.toContain(UPLOAD.file)
  })
})
