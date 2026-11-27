import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Outcome } from '../core/outcome.ts'
import { PROFILE_ID_PATTERN } from '../core/profile.ts'
import { FINGERPRINT_PATTERN } from '../core/stages/research.ts'
import type { PublicView, QuorumResult, ReviewSource, Verdict } from '../core/types.ts'
import { codeFree, expectCodeWritten, HOSTILE, RLO } from '../testing/markdown.ts'
import { blankResult, cast, FINDINGS, foundByScanner, INCOMPLETE, INTERRUPTED, LIFTED, PASS, RANGE, reportResult, SCANNED_CONTEXT, scannedResult, SERVED_AS_TWO, SQL, TOKEN, TRIVY } from '../testing/report.ts'
import { summaryMarkdown } from './markdown.ts'
import { commentBody, payload } from './payload.ts'
import { publicView } from './view.ts'

/** The head of the main fixture's range. */
const HEAD = '7b2e4d0'.padEnd(40, 'a')

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The shape of the document, strict at every level: what `quorum-action` reads. */
const payloadSchema = z.strictObject({
  version: z.literal(2),
  head: z.string().regex(COMMIT).nullable(),
  conclusion: z.enum([
    'pass',
    'findings',
    'incomplete',
    'interrupted',
  ]),
  summary: z.string().max(60_000),
  comments: z.array(z.strictObject({
    fingerprint: z.string().regex(FINGERPRINT_PATTERN),
    profile: z.string().regex(PROFILE_ID_PATTERN),
    confidence: z.enum(['high', 'medium', 'low', 'unreviewed']),
    path: z.string().min(1),
    line: z.number().int().min(0),
    side: z.literal('RIGHT'),
    subject: z.enum(['line', 'file']),
    body: z.string(),
  })),
  unplaced: z.number().int().min(0),
})

type Document = z.infer<typeof payloadSchema>

function render(result: QuorumResult | PublicView, outcome: Outcome = FINDINGS): string {
  return payload.render(result, { color: false, outcome })
}

function document(result: QuorumResult | PublicView, outcome: Outcome = FINDINGS): Document {
  return JSON.parse(render(result, outcome)) as Document
}

/** The review of the main fixture, with its source replaced. */
function reviewOf(source: ReviewSource): QuorumResult {
  return reportResult({
    meta: { source },
  })
}

/** `reportResult`'s review of `kept` and nothing else, the hostile finding's file among its coverage. */
function hostileResult(kept: Verdict[]): QuorumResult {
  const result = reportResult({ kept, unreviewed: [] })
  result.meta.profiles.security.coverage.push({ file: HOSTILE.file, status: 'reviewed' })
  return result
}

describe('payload', () => {
  it('writes the payload of a review: the commit, the conclusion, the summary and a comment per finding on a file of the diff', () => {
    expect(document(reportResult())).toEqual({
      version: 2,
      head: HEAD,
      conclusion: 'findings',
      summary: summaryMarkdown(publicView(reportResult()), FINDINGS),
      comments: [
        {
          fingerprint: SQL.fingerprint,
          profile: 'security',
          confidence: 'high',
          path: 'src/auth/login.ts',
          line: 42,
          side: 'RIGHT',
          subject: 'line',
          body: expect.stringContaining(`<!-- quorum:finding:v1 ${SQL.fingerprint} -->\n`),
        },
        {
          fingerprint: TOKEN.fingerprint,
          profile: 'security',
          confidence: 'unreviewed',
          path: 'src/session.js',
          line: 20,
          side: 'RIGHT',
          subject: 'line',
          body: expect.stringContaining(`<!-- quorum:finding:v1 ${TOKEN.fingerprint} -->\n`),
        },
      ],
      unplaced: 0,
    })
  })

  it('writes a review that names no report as it was written but for the payload\'s version and each comment\'s subject', () => {
    const { version, comments, ...rest } = document(reportResult())
    expect(version).toBe(2)
    expect(rest).toEqual({
      head: HEAD,
      conclusion: 'findings',
      summary: summaryMarkdown(publicView(reportResult()), FINDINGS),
      unplaced: 0,
    })
    expect(comments.map(({ subject, ...comment }) => [subject, comment])).toEqual([
      [
        'line',
        {
          fingerprint: SQL.fingerprint,
          profile: 'security',
          confidence: 'high',
          path: 'src/auth/login.ts',
          line: 42,
          side: 'RIGHT',
          body: '<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->\n**HIGH** security · `CWE-89` · kept by 3 of 3 lenses\n\n`SQL built from the request\'s id parameter reaches db.query`',
        },
      ],
      [
        'line',
        {
          fingerprint: TOKEN.fingerprint,
          profile: 'security',
          confidence: 'unreviewed',
          path: 'src/session.js',
          line: 20,
          side: 'RIGHT',
          body: '<!-- quorum:finding:v1 b1c2d3e4f5061728:1 -->\n**UNREVIEWED** security · `CWE-338` · kept by 1 of 3 lenses, 1 vote failed: a network error\n\n`Session tokens come from Math.random, which is not a cryptographic generator.`',
        },
      ],
    ])
    // The subject sits after the side and before the body, in each comment and in the document the Action reads.
    expect(Object.keys(JSON.parse(render(reportResult())).comments[0])).toEqual([
      'fingerprint',
      'profile',
      'confidence',
      'path',
      'line',
      'side',
      'subject',
      'body',
    ])
  })

  it.each<[string, Verdict, 'line' | 'file']>([
    ['file-level scanner', TRIVY, 'file'],
    [
      'scanner\'s line',
      foundByScanner({ ...SQL, file: 'package-lock.json', line: 300 }, { scanner: 'Semgrep OSS' }),
      'line',
    ],
    [
      'model\'s line',
      { ...SQL, file: 'package-lock.json', line: 300 },
      'line',
    ],
  ])('gives a %s finding the subject %s, and keeps its line', (_name, verdict, subject) => {
    const result = reportResult({
      kept: [verdict],
      unreviewed: [],
      meta: { context: SCANNED_CONTEXT },
    })
    result.meta.profiles.security.coverage = [
      { file: 'package-lock.json', status: 'reviewed' },
    ]
    const [comment] = document(result).comments
    expect(comment.subject).toBe(subject)
    expect(comment.line).toBe(300)
    expect(comment.path).toBe('package-lock.json')
  })

  it('names a scanner\'s finding\'s scanner in its comment, after the rule, and says nothing of a file-level finding there', () => {
    const result = reportResult({
      kept: [
        TRIVY,
        foundByScanner({ ...SQL, rule: 'tests-for-new-code' }, { scanner: '@octocat `x` #1' }),
      ],
      unreviewed: [],
      meta: { context: SCANNED_CONTEXT },
    })
    result.meta.profiles.security.coverage = [
      { file: 'package-lock.json', status: 'reviewed' },
      { file: 'src/auth/login.ts', status: 'reviewed' },
    ]
    const [trivy, other] = document(result).comments
    expect(trivy.body).toBe([
      `<!-- quorum:finding:v1 ${TRIVY.fingerprint} -->`,
      '**HIGH** security · `CVE-0000-0001` · `Trivy` · kept by 3 of 3 lenses',
      '',
      '`The locked version of a library is affected by CVE-0000-0001.`',
    ].join('\n'))
    expect(other.body).toBe([
      '<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->',
      '**HIGH** security · `CWE-89` · rule `tests-for-new-code` · ``@octocat `x` #1`` · kept by 3 of 3 lenses',
      '',
      '`SQL built from the request\'s id parameter reaches db.query`',
    ].join('\n'))
    expectCodeWritten(trivy.body, `<!-- quorum:finding:v1 ${TRIVY.fingerprint} -->`)
    expectCodeWritten(other.body, '<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->')
    expect(commentBody(publicView(result).kept[0])).toBe(trivy.body)
  })

  it('says a scanner\'s finding is marked suppressed in its comment, after the scanner, with or without file-level, and says it of no other', () => {
    const result = reportResult({
      kept: [
        foundByScanner({ ...SQL, file: 'src/a.js', line: 2 }, { scanner: 'Semgrep OSS', suppressed: true }),
        {
          ...TRIVY,
          foundBy: { ...TRIVY.foundBy, suppressed: true } as Verdict['foundBy'],
        },
        foundByScanner({ ...SQL, file: 'src/c.js', line: 4 }, { scanner: 'Semgrep OSS' }),
        { ...SQL, file: 'src/d.js', line: 5 },
      ],
      unreviewed: [],
      meta: { context: SCANNED_CONTEXT },
    })
    result.meta.profiles.security.coverage = [
      'src/a.js',
      'package-lock.json',
      'src/c.js',
      'src/d.js',
    ].map(file => ({ file, status: 'reviewed' }))
    const comments = new Map(document(result).comments.map(comment => [comment.path, comment]))
    const second = (path: string): string => comments.get(path)!.body.split('\n')[1]
    expect(second('src/a.js')).toBe('**HIGH** security · `CWE-89` · `Semgrep OSS` · marked suppressed · kept by 3 of 3 lenses')
    // The file-level finding's body still says nothing of its file: `subject` does.
    expect(second('package-lock.json')).toBe('**HIGH** security · `CVE-0000-0001` · `Trivy` · marked suppressed · kept by 3 of 3 lenses')
    expect(comments.get('package-lock.json')!.subject).toBe('file')
    expect(second('src/c.js')).toBe('**HIGH** security · `CWE-89` · `Semgrep OSS` · kept by 3 of 3 lenses')
    expect(second('src/d.js')).toBe('**HIGH** security · `CWE-89` · kept by 3 of 3 lenses')
    expectCodeWritten(comments.get('src/a.js')!.body, `<!-- quorum:finding:v1 ${SQL.fingerprint} -->`)
    // A review that read no report writes the comments it always wrote.
    expect(document(reportResult()).comments.map(({ body }) => body).join('\n')).not.toContain('suppressed')
  })

  it('posts a scanned review\'s file-level finding as a comment on its file and lists the dismissed issue in its summary only', () => {
    const result = scannedResult()
    result.meta.profiles.security.coverage = [
      { file: 'package-lock.json', status: 'reviewed' },
    ]
    const posted = document(result)
    expect(posted.comments).toHaveLength(1)
    expect(posted.comments[0].subject).toBe('file')
    expect(posted.summary).toContain('#### Dismissed scanner issues')
    expect(posted.summary).toContain('#### Scanner and coverage reports')
    expect(posted.unplaced).toBe(0)
    expect(payloadSchema.parse(JSON.parse(render(result)))).toBeDefined()
  })

  it('holds no served model', () => {
    const answered = reportResult({
      meta: { calls: SERVED_AS_TWO },
    })
    expect(render(answered)).toBe(render(reportResult()))
    expect(render(answered)).not.toContain('local-model-2026')
    expect(render(answered)).not.toContain('local-model-2027')
  })

  it('writes each body with the marker and fingerprint first, then the level, profile, category, votes and claim', () => {
    expect(document(reportResult()).comments[0].body).toBe([
      '<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->',
      '**HIGH** security · `CWE-89` · kept by 3 of 3 lenses',
      '',
      '`SQL built from the request\'s id parameter reaches db.query`',
    ].join('\n'))
  })

  it('writes a finding\'s rule in a code span in the summary and its comment, and none for a finding that cites none', () => {
    const result = reportResult({
      kept: [
        { ...SQL, rule: 'tests-for-new-code' },
      ],
      unreviewed: [],
    })
    const [comment] = document(result).comments
    expect(comment.body).toBe([
      '<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->',
      '**HIGH** security · `CWE-89` · rule `tests-for-new-code` · kept by 3 of 3 lenses',
      '',
      '`SQL built from the request\'s id parameter reaches db.query`',
    ].join('\n'))
    expectCodeWritten(comment.body, '<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->')
    // The summary the payload carries says it the same way, in the finding's head.
    expect(document(result).summary.split('\n')).toContain('- **HIGH** security · `src/auth/login.ts` line 42 · `CWE-89` · rule `tests-for-new-code` · kept by 3 of 3 lenses')
    expect(commentBody(publicView(result).kept[0])).toBe(comment.body)
    // A finding that cites none has the body it always had.
    expect(commentBody(publicView(reportResult()).kept[0])).toBe([
      '<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->',
      '**HIGH** security · `CWE-89` · kept by 3 of 3 lenses',
      '',
      '`SQL built from the request\'s id parameter reaches db.query`',
    ].join('\n'))
  })

  it('carries, in the summary it posts, that a profile\'s research asked nothing, and changes no comment', () => {
    const { security } = reportResult().meta.profiles
    const result = reportResult({
      kept: [],
      unreviewed: [],
      meta: {
        profiles: {
          security: {
            ...security,
            rules: { listed: 0, sent: 0 },
            asksNothing: true,
            coverage: [
              { file: 'a.js', status: 'reviewed' },
            ],
          },
        },
      },
    })
    const posted = document(result)
    expect(posted.comments).toEqual([])
    expect(posted.summary.split('\n')).toContain('| security | high | 0 | 0 | 1 | 0 | 1 of 1 file reviewed; rules 0 of 0 sent, so its research asks nothing |')
    expect(posted.summary).toBe(summaryMarkdown(publicView(result), FINDINGS))
  })

  it('puts every text a model or the diff wrote in a code span, and no marker but on the first line', () => {
    const [comment] = document(hostileResult([HOSTILE])).comments
    expect(comment.path).toBe(HOSTILE.file)
    expectCodeWritten(comment.body, `<!-- quorum:finding:v1 ${HOSTILE.fingerprint} -->`)
    expect(codeFree(comment.body).slice(1).filter(line => line.includes('<!--'))).toEqual([])
    expect(comment.body.split('\n')).toHaveLength(4)
    expect(comment.body).not.toContain('##[')
    expect(comment.body).not.toContain(RLO)
    expect(comment.body.split('\n').filter(line => /^\s*::/.test(line))).toEqual([])
    expect(commentBody(publicView(hostileResult([HOSTILE])).kept[0])).toBe(comment.body)
  })

  it('counts a finding of a diff with no per-file headers as unplaced, which the summary still lists', () => {
    const { comments, unplaced, summary } = document(reportResult({
      kept: [
        { ...SQL, file: 'the finder\'s name' },
      ],
      unreviewed: [],
    }))
    expect(comments).toEqual([])
    expect(unplaced).toBe(1)
    expect(summary).toContain('- **HIGH** security · `the finder\'s name` line 42')
  })

  it('counts a finding on a path that is not a clean relative path as unplaced, with no comment', () => {
    const files = [
      '/abs/x.js',
      'a//b.js',
      '../x.js',
      'a/./b.js',
    ]
    const result = reportResult({
      kept: files.map(file => ({ ...SQL, file })),
      unreviewed: [],
    })
    result.meta.profiles.security.coverage = files.map(file => ({ file, status: 'reviewed' }))
    const { comments, unplaced } = document(result)
    expect(comments).toEqual([])
    expect(unplaced).toBe(4)
  })

  it('counts a finding on an empty file, or on a file its profile has no coverage entry for, as unplaced', () => {
    const result = reportResult({
      kept: [
        { ...SQL, file: '' },
        { ...SQL, file: 'src/auth/login.ts', fingerprint: 'f1f1f1f1f1f1f1f1:1' },
        { ...SQL, file: 'src/other.ts', fingerprint: 'f2f2f2f2f2f2f2f2:1' },
      ],
      unreviewed: [],
    })
    result.meta.profiles.security.coverage = [
      { file: '', status: 'reviewed' },
      { file: 'src/auth/login.ts', status: 'reviewed' },
    ]
    const { comments, unplaced } = document(result)
    expect(comments.map(({ path, fingerprint }) => `${path} ${fingerprint}`)).toEqual(['src/auth/login.ts f1f1f1f1f1f1f1f1:1'])
    expect(unplaced).toBe(2)
  })

  it('keeps line 0 as 0, and puts a kept finding before an unreviewed one at one file and line', () => {
    const at = (verdict: Verdict, fingerprint: string): Verdict => ({
      ...verdict,
      file: 'src/a.ts',
      line: 0,
      fingerprint,
    })
    const result = reportResult({
      kept: [
        at(SQL, 'a1a1a1a1a1a1a1a1:1'),
      ],
      unreviewed: [
        at(TOKEN, 'b2b2b2b2b2b2b2b2:1'),
      ],
    })
    result.meta.profiles.security.coverage = [
      { file: 'src/a.ts', status: 'reviewed' },
    ]
    const { comments } = document(result)
    expect(comments.map(({ fingerprint, line, confidence }) => [fingerprint, line, confidence])).toEqual([
      ['a1a1a1a1a1a1a1a1:1', 0, 'high'],
      ['b2b2b2b2b2b2b2b2:1', 0, 'unreviewed'],
    ])
  })

  it('writes the payload of a full result as that of its view, with no reasoning', () => {
    const result = reportResult({
      kept: [
        {
          ...SQL,
          votes: [
            {
              ...cast(true),
              vote: { keep: true, reasoning: 'REASONING-CANARY' },
            },
          ],
        },
      ],
    })
    const written = render(result)
    expect(written).toBe(render(publicView(result)))
    expect(written).not.toContain('REASONING-CANARY')
  })

  it.each<[string, ReviewSource, string | null]>([
    [
      'diff',
      { kind: 'diff' },
      null,
    ],
    ['range', RANGE, HEAD],
    [
      'local',
      { kind: 'local', head: null, objectFormat: 'sha1' },
      null,
    ],
    [
      'staged',
      {
        kind: 'staged',
        head: 'e'.repeat(40),
        objectFormat: 'sha1',
      },
      'e'.repeat(40),
    ],
    [
      'paths',
      {
        kind: 'paths',
        commit: 'c'.repeat(64),
        paths: ['src'],
        skips: false,
        objectFormat: 'sha256',
      },
      'c'.repeat(64),
    ],
  ])('names the reviewed commit of a %s source', (_kind, source, head) => {
    expect(document(reviewOf(source)).head).toBe(head)
  })

  it.each([
    ['findings', 'FINDINGS', FINDINGS],
    ['incomplete', 'INCOMPLETE', INCOMPLETE],
    ['pass', 'PASS', PASS],
    ['pass', 'LIFTED', LIFTED],
  ] as const)('concludes %s for %s', (conclusion, _name, outcome) => {
    expect(document(reportResult(), outcome).conclusion).toBe(conclusion)
  })

  it('concludes an interrupted review as interrupted', () => {
    const stopped = reportResult({
      meta: {
        incomplete: [
          { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 2 of its 3 research parts' },
        ],
      },
    })
    const concluded = document(stopped, INTERRUPTED)
    expect(concluded.conclusion).toBe('interrupted')
    expect(payloadSchema.parse(concluded)).toEqual(concluded)
    expect(concluded.summary).toContain('**exit 130, interrupted:** the review was stopped before its end; what it read is above')
  })

  it('orders the comments by file, then line', () => {
    const at = (file: string, line: number): Verdict => ({ ...SQL, file, line })
    const result = reportResult({
      kept: [
        at('src/b.ts', 3),
        at('src/a.ts', 12),
        at('src/b.ts', 1),
      ],
      unreviewed: [
        { ...TOKEN, file: 'src/a.ts', line: 2 },
      ],
    })
    result.meta.profiles.security.coverage = ['src/a.ts', 'src/b.ts'].map(file => ({ file, status: 'reviewed' }))
    expect(document(result).comments.map(({ path, line }) => `${path}:${line}`)).toEqual([
      'src/a.ts:2',
      'src/a.ts:12',
      'src/b.ts:1',
      'src/b.ts:3',
    ])
  })

  it('passes the payload\'s schema for every fixture', () => {
    const secrets = blankResult({
      source: {
        kind: 'staged',
        head: 'a'.repeat(40),
        objectFormat: 'sha1',
      },
      leftOut: [
        { file: '.env', reason: 'secret', rule: 'name' },
      ],
      flags: [
        { code: 'secret-file', file: '.env', detail: 'named as a secret' },
      ],
    })
    for (const result of [
      reportResult(),
      blankResult(),
      secrets,
      hostileResult([HOSTILE]),
    ]) {
      expect(payloadSchema.parse(JSON.parse(render(result)))).toBeDefined()
    }
  })
})
