import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveProfiles } from '../config/profiles.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import type { ConfigInput } from '../config/schema.ts'
import { MAX_REPORT_BYTES } from '../core/reports.ts'
import type { ScannerReport } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import { reportPathsOf } from './paths.ts'
import { readReports, reportRequestIssues } from './reports.ts'
import type { ReportRequest } from './reports.ts'

/** How many files the bounded reader has open at once, counted through a spy that calls through to it. */
const reading = vi.hoisted(() => ({ now: 0, peak: 0 }))
vi.mock('../config/load.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.ts')>()
  return {
    ...actual,
    readBounded: async (...given: Parameters<typeof actual.readBounded>) => {
      reading.now += 1
      reading.peak = Math.max(reading.peak, reading.now)
      try {
        return await actual.readBounded(...given)
      } finally {
        reading.now -= 1
      }
    },
  }
})

const FIXTURES = new URL('./fixtures/', import.meta.url)
const TRIVY = new URL('trivy.sarif', FIXTURES)
const NAMING = {
  prompts: { research: 'Find naming issues.', vote: 'Judge from {{lens.id}}: {{lens.question}}' },
  lenses: [
    { id: 'grounded', question: 'Is it backed by a stated convention?' },
  ],
}

/** A resolved config that runs the profiles `profiles` holds, the built-in `security` among them. */
function configOf(profiles: ConfigInput['profiles']): ResolvedConfig {
  const result = resolveProfiles({
    profiles,
    roles: { research: 'main', voter: 'main' },
    providers: ['main'],
    builtIn: new Map([
      [securityProfile.id, securityProfile],
    ]),
  })
  expect(result.issues).toEqual([])
  return { providers: {}, profiles: result.profiles, warnings: [] }
}

const ONE = configOf({ security: {} })
const TWO = configOf({ security: {}, naming: NAMING })

/** A directory of its own for the files these tests read. */
let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-reports-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const REPO = reportPathsOf(undefined, '/repo')

/** What `readReports` makes of one request, the file in the temporary directory. */
async function readOne(request: ReportRequest): Promise<ScannerReport> {
  const [report] = await readReports([request], {
    cwd: dir,
    paths: REPO,
    profiles: ['security'],
  })
  return report
}

describe('readReports', () => {
  beforeAll(() => {
    writeFileSync(join(dir, 'big.sarif'), Buffer.alloc(MAX_REPORT_BYTES + 1, 0x20))
    writeFileSync(join(dir, 'exact.sarif'), Buffer.alloc(MAX_REPORT_BYTES, 0x20))
    writeFileSync(join(dir, 'binary.sarif'), Buffer.from([0x7B, 0xFF, 0xFE, 0x7D]))
    writeFileSync(join(dir, 'prose.json'), 'not a log')
    mkdirSync(join(dir, 'folder.sarif'))
    symlinkSync(TRIVY, join(dir, 'link.sarif'))
  })

  it.each([
    [
      'does not exist',
      'missing',
      'missing.sarif',
      undefined,
    ],
    [
      'is a symbolic link to a fixture',
      'not-a-file',
      'link.sarif',
      undefined,
    ],
    [
      'is a directory',
      'not-a-file',
      'folder.sarif',
      undefined,
    ],
    [
      'is 16 MiB and one byte',
      'too-large',
      'big.sarif',
      undefined,
    ],
    [
      'holds bytes that are no UTF-8 text',
      'not-the-format',
      'binary.sarif',
      createHash('sha256').update(Buffer.from([0x7B, 0xFF, 0xFE, 0x7D])).digest('hex'),
    ],
  ] as const)('reads a report file that %s as %s', async (_words, problem, file, sha256) => {
    for (const format of ['sarif', 'sonarqube'] as const) {
      expect(await readOne({ format, path: file })).toEqual({
        format,
        profile: 'security',
        ...(sha256 === undefined
          ? {}
          : { sha256 }),
        problems: [problem],
        skipped: 0,
        unreadable: 0,
        issues: [],
      })
    }
  })

  it('reads a file of exactly 16 MiB as the format\'s reader reads its text, never as too large', async () => {
    expect((await readOne({ format: 'sarif', path: 'exact.sarif' })).problems).toEqual(['not-the-format'])
  })

  it('reads a text that is in no known format as not the format, with the hash of its bytes', async () => {
    expect(await readOne({ format: 'sonarqube', path: 'prose.json' })).toMatchObject({
      problems: ['not-the-format'],
      sha256: createHash('sha256').update('not a log').digest('hex'),
    })
  })

  it('hashes the bytes of the file as read, a byte-order mark included, though the reader reads the text without it', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from(JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            tool: {
              driver: { name: 'Scanner' },
            },
            results: [],
          },
        ],
      })),
    ])
    writeFileSync(join(dir, 'bom.sarif'), bytes)
    expect(await readOne({ format: 'sarif', path: 'bom.sarif' })).toMatchObject({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      scanner: 'Scanner',
      problems: [],
    })
  })

  it('reads one file at a time, so 16 reports never hold 16 buffers of 16 MiB at once', async () => {
    reading.peak = 0
    const request: ReportRequest = { format: 'sarif', path: 'log.sarif' }
    writeFileSync(join(dir, 'log.sarif'), JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: { name: 'Scanner' },
          },
          results: [],
        },
      ],
    }))
    const reports = await readReports(Array.from<ReportRequest>({ length: 8 }).fill(request), {
      cwd: dir,
      paths: REPO,
      profiles: ['security'],
    })
    expect(reports).toHaveLength(8)
    expect(reading.peak).toBe(1)
  })

  it('reads trivy.sarif with the SHA-256 of its bytes, the issues its reader reads and the profile that runs', async () => {
    const bytes = readFileSync(TRIVY)
    const report = await readOne({ format: 'sarif', path: TRIVY.pathname })
    expect(report.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(report).toMatchObject({
      format: 'sarif',
      profile: 'security',
      scanner: 'Trivy',
      problems: [],
      skipped: 0,
      unreadable: 0,
    })
    expect(report.issues.map(issue => [issue.path, issue.line])).toEqual([
      ['package-lock.json', 1],
      ['Dockerfile', 1],
      ['Dockerfile', 3],
    ])
  })

  it('reads a relative path from the working directory, and gives each request the profile it names, else the one that runs', async () => {
    writeFileSync(join(dir, 'log.sarif'), JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: { name: 'Scanner' },
          },
          results: [],
        },
      ],
    }))
    const reports = await readReports([
      { format: 'sarif', path: 'log.sarif', profile: 'naming' },
      { format: 'sonarqube', path: 'log.sarif' },
      {
        format: 'sarif',
        path: join(dir, 'log.sarif'),
        profile: 'security',
      },
    ], {
      cwd: dir,
      paths: REPO,
      profiles: ['naming'],
    })
    expect(reports.map(report => [report.format, report.profile, report.problems])).toEqual([
      ['sarif', 'naming', []],
      [
        'sonarqube',
        'naming',
        ['not-the-format'],
      ],
      ['sarif', 'security', []],
    ])
  })

  it('places each issue by the paths it is given', async () => {
    writeFileSync(join(dir, 'abs.sarif'), JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: { name: 'Scanner' },
          },
          results: [
            {
              ruleId: 'R',
              message: { text: 'm' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'file:///repo/src/a.js' },
                    region: { startLine: 4 },
                  },
                },
              ],
            },
            {
              ruleId: 'R',
              message: { text: 'm' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'file:///elsewhere/a.js' },
                    region: { startLine: 4 },
                  },
                },
              ],
            },
          ],
        },
      ],
    }))
    const request = { format: 'sarif', path: 'abs.sarif' } as const
    const [top] = await readReports([request], {
      cwd: dir,
      paths: reportPathsOf(undefined, '/repo'),
      profiles: ['security'],
    })
    expect(top.issues.map(({ path, unmapped }) => [path, unmapped])).toEqual([
      ['src/a.js', undefined],
      [undefined, true],
    ])
    const [none] = await readReports([request], {
      cwd: dir,
      paths: reportPathsOf(undefined, undefined),
      profiles: ['security'],
    })
    expect(none.issues.map(({ path, unmapped }) => [path, unmapped])).toEqual([
      [undefined, true],
      [undefined, true],
    ])
  })

  it('reads every request, in the order given, and none when given none', async () => {
    expect(await readReports([], {
      cwd: dir,
      paths: REPO,
      profiles: ['security'],
    })).toEqual([])
    const reports = await readReports([
      { format: 'sarif', path: 'missing.sarif' },
      { format: 'sonarqube', path: 'folder.sarif' },
      { format: 'sarif', path: 'log.sarif' },
    ], {
      cwd: dir,
      paths: REPO,
      profiles: ['security'],
    })
    expect(reports.map(report => report.problems)).toEqual([
      ['missing'],
      ['not-a-file'],
      [],
    ])
  })
})

describe('reportRequestIssues', () => {
  it('refuses a report for a profile that does not run, and one with no profile while several run', () => {
    expect(reportRequestIssues(TWO, [
      { format: 'sarif', path: 'a.sarif', profile: 'securty' },
      { format: 'sonarqube', path: 'b.json' },
    ])).toEqual([
      { path: '--sarif', message: 'names the profile "securty", which does not run' },
      { path: '--sonarqube', message: 'must name a profile when several run' },
    ])
  })

  it('takes a report that names any running profile, the built-in ones and a user\'s alike, and one with no profile while one runs', () => {
    expect(reportRequestIssues(TWO, [
      { format: 'sarif', path: 'a.sarif', profile: 'security' },
      { format: 'sonarqube', path: 'b.json', profile: 'naming' },
    ])).toEqual([])
    expect(reportRequestIssues(ONE, [
      { format: 'sarif', path: 'a.sarif' },
      { format: 'sonarqube', path: 'b.json', profile: 'security' },
    ])).toEqual([])
    expect(reportRequestIssues(ONE, [])).toEqual([])
  })

  it('says each problem once for each flag, and names a profile only when it is safe to print', () => {
    expect(reportRequestIssues(TWO, [
      { format: 'sarif', path: 'a.sarif' },
      { format: 'sarif', path: 'b.sarif' },
      { format: 'sarif', path: 'c.sarif', profile: 'team' },
      { format: 'sarif', path: 'd.sarif', profile: 'team' },
      { format: 'sonarqube', path: 'e.json' },
      {
        format: 'sonarqube',
        path: 'f.json',
        profile: 'a'.repeat(65),
      },
    ])).toEqual([
      { path: '--sarif', message: 'must name a profile when several run' },
      { path: '--sarif', message: 'names the profile "team", which does not run' },
      { path: '--sonarqube', message: 'must name a profile when several run' },
      { path: '--sonarqube', message: 'names a profile that does not run' },
    ])
  })
})
