/** The results the reporters' specs render: a review of a range with one kept, one unreviewed and one discarded finding, and a blank one. */

import type { Outcome } from '../core/outcome.ts'
import type { ContextDocument, LensVote, QuorumMeta, QuorumResult, ReviewSettings, ReviewSource, Verdict } from '../core/types.ts'

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
  foundBy: { kind: 'model' },
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
  foundBy: { kind: 'model' },
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

/**
 * The calls a review records when its provider `p`, which its config names `m`, answered as two other models: one named for its 3
 * research calls and one for its 2 votes. The roles' tokens sum to the usage `reportMeta` records, as a review's do.
 */
export const SERVED_AS_TWO: QuorumMeta['calls'] = {
  p: {
    model: 'm',
    served: [
      { model: 'local-model-2026', calls: 3 },
      { model: 'local-model-2027', calls: 2 },
    ],
    research: {
      calls: 3,
      failed: {},
      stopped: 0,
      retried: 0,
      reused: 0,
      usage: { inputTokens: 40_000, outputTokens: 3000 },
      callMs: { total: 9000, longest: 4000 },
    },
    vote: {
      calls: 2,
      failed: {},
      stopped: 0,
      retried: 0,
      reused: 0,
      usage: { inputTokens: 8120, outputTokens: 1190 },
      callMs: { total: 5000, longest: 3000 },
    },
  },
}

/** A prompt or a lens question as a record writes it: `sha256:` and 64 hexadecimal digits, `digit` repeated. */
const hash = (digit: string): string => `sha256:${digit.repeat(64)}`

/**
 * The settings record of a review of the profile `security` through one provider `p`, as `reviewSettings` builds it from a
 * config that sets nothing but the provider: every bound its default, a header, a query and a body of safe values.
 */
export const SETTINGS: ReviewSettings = {
  runtime: {
    name: 'node',
    version: '26.12.0',
    platform: 'linux',
    arch: 'x64',
  },
  strict: false,
  concurrency: 'auto',
  exclude: [],
  partTokens: { value: 32_768, origin: 'default' },
  maxFindings: { value: 50, origin: 'default' },
  findingsCap: { value: 50, origin: 'default' },
  maxReviewTokens: { value: 2_000_000, origin: 'default' },
  reviewTimeoutMs: { value: 1_800_000, origin: 'default' },
  providers: {
    p: {
      preset: 'ollama',
      model: 'm',
      contextTokens: 131_072,
      headers: { 'x-team': '[redacted]' },
      query: { v: '[redacted]' },
      extraBody: { reasoning_effort: 'low', api_token: '[redacted]' },
    },
  },
  profiles: {
    security: {
      research: 'p',
      lenses: {
        reachability: {
          provider: 'p',
          question: hash('1'),
        },
        impact: {
          provider: 'p',
          question: hash('2'),
        },
        defenses: {
          provider: 'p',
          question: hash('3'),
        },
      },
      prompts: {
        research: hash('a'),
        vote: hash('b'),
      },
      findings: 50,
      replyTokens: {
        research: 21_024,
        votes: { reachability: 9216, impact: 9216, defenses: null },
      },
    },
  },
}

/** The meta of `reportResult`: a profile `security` at fail-on high over three files, one binary file left out, its gap and one flag. */
export function reportMeta(): QuorumMeta {
  return {
    version: '0.6.0',
    startedAt: '2026-11-16T00:00:00.000Z',
    durationMs: 41_000,
    source: RANGE,
    settings: null,
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
        stages: {},
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
    calls: {},
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
