/** The results the reporters' specs render: a review of a range with one kept, one unreviewed and one discarded finding, and a blank one. */

import type { Outcome } from '../core/outcome.ts'
import type { ContextDocument, LensVote, QuorumMeta, QuorumResult, ReviewSource, Verdict } from '../core/types.ts'

const id = (start: string, length = 40): string => start.padEnd(length, 'a')
export function cast(keep: boolean): LensVote {
  return {
    angle: 'a',
    vote: { keep, reasoning: 'r' },
    error: null,
    failure: null,
  }
}
export const FAILED: LensVote = {
  angle: 'b',
  vote: null,
  error: 'x',
  failure: { kind: 'network' },
}
export const RANGE: ReviewSource = {
  kind: 'range',
  base: id('1f3a9c2'),
  mergeBase: id('0e2b8a1'),
  head: id('7b2e4d0'),
  objectFormat: 'sha1',
}
export const SQL: Verdict = {
  id: 'a1b2c3d4e5f6',
  fingerprint: 'a1b2c3d4e5f60718:1',
  profile: 'security',
  file: 'src/auth/login.ts',
  line: 42,
  category: 'CWE-89',
  summary: 'SQL built from the request\'s id parameter reaches db.query',
  evidence: ' const sql = \'SELECT * FROM users WHERE id = \' + id\n+db.query(sql)\n return rows',
  evidenceRow: 1,
  quoteMatched: true,
  keptVotes: 3,
  totalVotes: 3,
  confidence: 'high',
  votes: [
    cast(true),
    cast(true),
    cast(true),
  ],
}
export const TOKEN: Verdict = {
  id: 'b1c2d3e4f506',
  fingerprint: 'b1c2d3e4f5061728:1',
  profile: 'security',
  file: 'src/session.js',
  line: 20,
  category: 'CWE-338',
  summary: 'Session tokens come from Math.random, which is not a cryptographic generator.',
  evidence: '-  return crypto.randomBytes(32).toString(\'hex\')\n+  return Math.random().toString(36).slice(2)\n }',
  evidenceRow: 1,
  quoteMatched: true,
  keptVotes: 1,
  totalVotes: 3,
  votes: [
    cast(true),
    FAILED,
    cast(false),
  ],
}
export const UPLOAD: Verdict = {
  ...SQL,
  id: 'c1d2e3f40516',
  fingerprint: 'c1d2e3f405162738:1',
  file: 'src/upload.js',
  line: 5,
  keptVotes: 1,
  confidence: undefined,
}

/** The meta of `reportResult`: a profile `security` at fail-on high over three files, one binary file left out, its gap and one flag. */
export function reportMeta(): QuorumMeta {
  return {
    version: '0.6.0',
    startedAt: '2026-11-16T00:00:00.000Z',
    durationMs: 41_000,
    source: RANGE,
    profiles: {
      security: {
        providers: {
          research: { id: 'p', model: 'm' },
          lenses: {},
        },
        policy: { high: 3, medium: 2, low: null },
        failOn: 'high',
        gating: true,
        invalidFindings: 0,
        rules: { listed: 0, sent: 0 },
        invalidRules: 0,
        research: {
          parts: 1,
          listed: 3,
          panel: 3,
          capped: 0,
          saturated: 0,
        },
        coverage: [
          { file: 'src/auth/login.ts', status: 'reviewed' },
          {
            file: 'src/session.js',
            status: 'partial',
            left: [
              { start: 30, end: 34, reason: 'token-cap' },
            ],
          },
          { file: 'assets/logo.png', status: 'unreviewed', reason: 'binary' },
        ],
      },
    },
    usage: { inputTokens: 48_120, outputTokens: 4190 },
    incomplete: [
      { profile: 'security', reason: 'binary', detail: 'the diff carries no content for 1 binary file(s), listed in meta.leftOut' },
    ],
    leftOut: [
      { file: 'assets/logo.png', reason: 'binary' },
    ],
    flags: [
      {
        code: 'hidden-characters',
        file: 'src/session.js',
        line: 20,
        detail: 'U+202E on 1 added line(s)',
      },
    ],
    context: { documents: [] },
    adaptations: [],
  }
}

/** `kept: [SQL]`, `unreviewed: [TOKEN]`, `discarded: [UPLOAD]` and `reportMeta()`, each part replaced by `changes`, meta field by field. */
export function reportResult(changes: { readonly kept?: Verdict[], readonly unreviewed?: Verdict[], readonly discarded?: Verdict[], readonly meta?: Partial<QuorumMeta> } = {}): QuorumResult {
  return {
    kept: changes.kept ?? [SQL],
    discarded: changes.discarded ?? [UPLOAD],
    unreviewed: changes.unreviewed ?? [TOKEN],
    meta: {
      ...reportMeta(),
      ...changes.meta,
    },
  }
}

/** A document the review read: `security`'s guidelines as its own text, 1830 bytes, nothing removed from it; `changes` replaces its fields. */
export function contextDocument(changes: Partial<ContextDocument> = {}): ContextDocument {
  return {
    profile: 'security',
    kind: 'guidelines',
    origin: 'profile',
    status: 'read',
    bytes: 1830,
    removed: { characters: 0, comments: 0, entities: 0 },
    ...changes,
  }
}

/** A review of a blank diff: no finding, no file, no gap, no usage, 3 ms; `meta` replaces its fields. */
export function blankResult(meta: Partial<QuorumMeta> = {}): QuorumResult {
  const { usage: _usage, ...base } = reportMeta()
  return {
    kept: [],
    discarded: [],
    unreviewed: [],
    meta: {
      ...base,
      durationMs: 3,
      source: { kind: 'diff' },
      profiles: {
        security: {
          ...base.profiles.security,
          research: {
            parts: 0,
            listed: 0,
            panel: 0,
            capped: 0,
            saturated: 0,
          },
          coverage: [],
        },
      },
      incomplete: [],
      leftOut: [],
      flags: [],
      ...meta,
    },
  }
}

export const FINDINGS: Outcome = { status: 'findings', exitCode: 1, lifted: false }
export const INCOMPLETE: Outcome = { status: 'incomplete', exitCode: 4, lifted: false }
export const INTERRUPTED: Outcome = { status: 'interrupted', exitCode: 130, lifted: false }
export const PASS: Outcome = { status: 'pass', exitCode: 0, lifted: false }
export const LIFTED: Outcome = { status: 'pass', exitCode: 0, lifted: true }
