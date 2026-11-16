import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Outcome } from '../core/outcome.ts'
import { PROFILE_ID_PATTERN } from '../core/profile.ts'
import { FINGERPRINT_PATTERN } from '../core/stages/research.ts'
import type { PublicView, QuorumResult, ReviewSource, Verdict } from '../core/types.ts'
import { codeFree, expectCodeWritten, HOSTILE, RLO } from '../testing/markdown.ts'
import { blankResult, FINDINGS, INCOMPLETE, LIFTED, PASS, RANGE, reportResult, SQL, TOKEN } from '../testing/report.ts'
import { summaryMarkdown } from './markdown.ts'
import { commentBody, payload } from './payload.ts'
import { publicView } from './view.ts'

/** The head of the main fixture's range. */
const HEAD = '7b2e4d0'.padEnd(40, 'a')

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The shape of the document, strict at every level: what `quorum-action` reads. */
const payloadSchema = z.strictObject({
  version: z.literal(1),
  head: z.string().regex(COMMIT).nullable(),
  conclusion: z.enum(['pass', 'findings', 'incomplete']),
  summary: z.string().max(60_000),
  comments: z.array(z.strictObject({
    fingerprint: z.string().regex(FINGERPRINT_PATTERN),
    profile: z.string().regex(PROFILE_ID_PATTERN),
    confidence: z.enum(['high', 'medium', 'low', 'unreviewed']),
    path: z.string().min(1),
    line: z.number().int().min(0),
    side: z.literal('RIGHT'),
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
      version: 1,
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
          body: expect.stringContaining(`<!-- quorum:finding:v1 ${SQL.fingerprint} -->\n`),
        },
        {
          fingerprint: TOKEN.fingerprint,
          profile: 'security',
          confidence: 'unreviewed',
          path: 'src/session.js',
          line: 20,
          side: 'RIGHT',
          body: expect.stringContaining(`<!-- quorum:finding:v1 ${TOKEN.fingerprint} -->\n`),
        },
      ],
      unplaced: 0,
    })
  })

  it('writes each body with the marker and fingerprint first, then the level, profile, category, votes and claim', () => {
    expect(document(reportResult()).comments[0].body).toBe([
      '<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->',
      '**HIGH** security · `CWE-89` · kept by 3 of 3 lenses',
      '',
      '`SQL built from the request\'s id parameter reaches db.query`',
    ].join('\n'))
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

  it('orders the comments by file, then line', () => {
    const at = (file: string, line: number): Verdict => ({ ...SQL, file, line })
    const result = reportResult({
      kept: [
        at('src/b.ts', 3),
        at('src/a.ts', 12),
        at('src/b.ts', 1),
      ],
      unreviewed: [
        at('src/a.ts', 2),
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
