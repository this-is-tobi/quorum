/** Test helpers for the bench: a small suite and the writer that puts it on disk, the verdicts and results its scorer reads, the resolved configs it fingerprints, the records it keeps, and the fake models its runner reviews with. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import packageJson from '../../package.json' with { type: 'json' }
import type { ReviewRecord } from '../bench/records.ts'
import type { Env } from '../config/env.ts'
import { checkCodeValue } from '../config/load.ts'
import { resolveConfig } from '../config/resolve.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { configInputSchema } from '../config/schema.ts'
import type { ConfigInput } from '../config/schema.ts'
import type { CompletionRequest, CompletionResponse } from '../core/ports.ts'
import { findingId } from '../core/stages/research.ts'
import type { Confidence, FindingDetails, IncompleteEntry, QuorumResult, Verdict } from '../core/types.ts'

/** Three patches: exec adds an exec(cmd) call at new line 2 of a.js, sql builds SQL text at new lines 2 and 3 of db.py, docs renames the README's title. */
export const PATCHES = {
  exec: [
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,2 +1,3 @@',
    ' const cmd = input()',
    '+exec(cmd)',
    ' done()',
    '',
  ].join('\n'),
  sql: [
    'diff --git a/db.py b/db.py',
    '--- a/db.py',
    '+++ b/db.py',
    '@@ -1,2 +1,3 @@',
    ' def find(db, name):',
    '-    return db.execute("SELECT * FROM users WHERE name = ?", [name])',
    '+    sql = "SELECT * FROM users WHERE name = \'" + name + "\'"',
    '+    return db.execute(sql)',
    '',
  ].join('\n'),
  docs: [
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1 @@',
    '-# Demo',
    '+# Demo app',
    '',
  ].join('\n'),
}

/** The suite the bench specs start from: two bugs, on exec and sql, and a control, on docs. */
export const SUITE = {
  name: 'demo',
  cases: [
    {
      id: 'exec',
      kind: 'bug',
      patch: 'exec.patch',
      locations: [
        { file: 'a.js', start: 2, end: 2 },
      ],
    },
    {
      id: 'sql',
      kind: 'bug',
      patch: 'sql.patch',
      locations: [
        { file: 'db.py', start: 2, end: 3 },
      ],
    },
    { id: 'docs', kind: 'control', patch: 'docs.patch' },
  ],
}

/**
 * Write a suite into `directory`, which it makes with its `cases/`: `suite.yaml` from `suite`, then the
 * three patches of `PATCHES` as `exec.patch`, `sql.patch` and `docs.patch`, then each of `patches` over
 * them by name, as given, so a spec can replace a patch or add one.
 */
export function writeSuite(directory: string, suite: object = SUITE, patches: Readonly<Record<string, string | Uint8Array>> = {}): void {
  mkdirSync(join(directory, 'cases'), { recursive: true })
  writeFileSync(join(directory, 'suite.yaml'), stringify(suite))
  const files: Readonly<Record<string, string | Uint8Array>> = {
    'exec.patch': PATCHES.exec,
    'sql.patch': PATCHES.sql,
    'docs.patch': PATCHES.docs,
    ...patches,
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, 'cases', name), content)
}

const CATEGORY = 'CWE-78'

/** One kept vote on a finding of the security profile at `file` and `line`, as the panel records it. */
export function verdict(file: string, line: number, confidence?: Confidence): Verdict {
  const made: Verdict = {
    id: findingId('security', file, line, CATEGORY),
    profile: 'security',
    file,
    line,
    category: CATEGORY,
    summary: 'A command is built from input.',
    evidence: '+exec(cmd)',
    quoteMatched: true,
    keptVotes: 1,
    totalVotes: 1,
    votes: [
      {
        angle: 'reachability',
        vote: { keep: true, reasoning: 'It is reachable.' },
        error: null,
      },
    ],
  }
  if (confidence) made.confidence = confidence
  return made
}

/**
 * A result holding `parts` (each list empty when left out), with the meta a review of the security
 * profile writes: three lenses on one fake provider, the profile's policy and gating, no invalid
 * finding, no flag and no usage.
 */
export function resultWith(parts: {
  readonly kept?: readonly Verdict[]
  readonly discarded?: readonly Verdict[]
  readonly unreviewed?: readonly Verdict[]
  readonly incomplete?: readonly IncompleteEntry[]
}): QuorumResult {
  const { kept = [], discarded = [], unreviewed = [], incomplete = [] } = parts
  const provider = { id: 'fake', model: 'm' }
  return {
    kept: [...kept],
    discarded: [...discarded],
    unreviewed: [...unreviewed],
    meta: {
      version: packageJson.version,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      profiles: {
        security: {
          providers: {
            research: provider,
            lenses: { reachability: provider, impact: provider, defenses: provider },
          },
          policy: { high: 3, medium: 2, low: null },
          gating: true,
          invalidFindings: 0,
        },
      },
      incomplete: [...incomplete],
      flags: [],
    },
  }
}

/**
 * A result that fills every field the type has: a kept verdict with a confidence and a failed vote
 * among its votes, a discarded and an unreviewed one, a gap with a file and one without, a flag with a
 * file and a line, usage with a cost, and a summary that holds `##[` and U+2028.
 */
export const RESULT: QuorumResult = (() => {
  const base = resultWith({
    kept: [
      {
        ...verdict('a.js', 2, 'high'),
        summary: `A command runs ##[error] input${String.fromCharCode(0x2028)}unchecked.`,
        keptVotes: 2,
        totalVotes: 3,
        votes: [
          {
            angle: 'reachability',
            vote: { keep: true, reasoning: 'It is reachable.' },
            error: null,
          },
          {
            angle: 'impact',
            vote: { keep: true, reasoning: 'It runs a command.' },
            error: null,
          },
          { angle: 'defenses', vote: null, error: 'HTTP 503' },
        ],
      },
    ],
    discarded: [
      {
        ...verdict('b.js', 5),
        keptVotes: 0,
        votes: [
          {
            angle: 'reachability',
            vote: { keep: false, reasoning: 'It is not reachable.' },
            error: null,
          },
        ],
      },
    ],
    unreviewed: [
      {
        ...verdict('c.js', 9),
        keptVotes: 1,
        totalVotes: 2,
        votes: [
          {
            angle: 'reachability',
            vote: { keep: true, reasoning: 'It is reachable.' },
            error: null,
          },
          { angle: 'impact', vote: null, error: 'timeout' },
        ],
      },
    ],
    incomplete: [
      {
        profile: 'security',
        reason: 'vote-failed',
        file: 'c.js',
        detail: 'a vote failed',
      },
      { profile: 'security', reason: 'findings-capped', detail: 'findings beyond the cap' },
    ],
  })
  return {
    ...base,
    meta: {
      ...base.meta,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      flags: [
        {
          code: 'hidden-characters',
          file: 'a.js',
          line: 2,
          detail: 'U+202E',
        },
      ],
    },
  }
})()

/** A review record of the security profile, `fields` over these defaults: the case exec, trial 1, 1200 ms, 4 calls of which 1 failed, usage with a cost and `RESULT`. */
export function record(fields: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    fingerprint: 'f'.repeat(64),
    case: 'exec',
    trial: 1,
    latencyMs: 1200,
    calls: 4,
    failedCalls: 1,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    costComplete: true,
    result: RESULT,
    ...fields,
  }
}

/** A config resolved as `fromConfig` resolves a program's: checked as a code config is, then bound to `env`. */
export function resolvedConfig(input: ConfigInput, env: Env = {}): ResolvedConfig {
  return resolveConfig(checkCodeValue(configInputSchema, () => input, { notAnObject: 'must be an object', threw: 'could not be read' }), { env })
}

/** The finding a fake model reports for the exec patch: the command built from input, quoted from the added line. */
export const EXEC_FINDING: FindingDetails = {
  file: 'a.js',
  line: 2,
  category: 'CWE-78',
  quote: 'exec(cmd)',
  summary: 'command injection',
}

/**
 * How a fake model answers: the model it names, the findings a research call reports (none by default),
 * whether a vote keeps them (it does by default), whether research fails, whether its answers report a
 * cost (they do by default), a gate its calls wait for, and a hook each call runs first.
 */
export interface FakeModel {
  readonly model?: string
  readonly findings?: readonly FindingDetails[]
  readonly keep?: boolean
  readonly failResearch?: boolean
  readonly cost?: boolean
  readonly gate?: Promise<void>
  readonly onCall?: (request: CompletionRequest) => void
}

/** Wait for `gate`, unless `signal` aborts first: then reject with the signal's reason. */
function waitFor(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return gate
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    gate.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, reject)
  })
}

/**
 * A provider that answers from `fake` and calls no model: a research request (`research_findings`) gets
 * the findings, or an `Error` under `failResearch`; a vote gets `keep` and a reason. Each answer reports
 * 10 input and 5 output tokens, and a cost of 0.001 unless `cost` is false.
 */
export function fakeProvider(fake: FakeModel = {}): { readonly model: string, readonly complete: (request: CompletionRequest) => Promise<CompletionResponse> } {
  const model = fake.model ?? 'm'
  return {
    model,
    complete: async (request) => {
      fake.onCall?.(request)
      if (fake.gate !== undefined) await waitFor(fake.gate, request.signal)
      const research = request.output.name === 'research_findings'
      if (research && fake.failResearch === true) throw new Error('research failed')
      return {
        text: JSON.stringify(research
          ? { findings: fake.findings ?? [] }
          : { keep: fake.keep ?? true, reasoning: 'r' }),
        model,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          ...(fake.cost === false
            ? {}
            : { costUsd: 0.001 }),
        },
      }
    },
  }
}

/** A config of one provider, `fakeProvider(fake)`, which every profile uses for its research and its votes. */
export function fakeConfig(fake: FakeModel = {}): ResolvedConfig {
  return resolvedConfig({
    providers: {
      fake: fakeProvider(fake),
    },
  })
}
