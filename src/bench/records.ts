/**
 * The two files of a bench run directory, as data: `run.json`, which holds what makes the run one run
 * (the quorum version, the suite's name and hash, the salt, and the fingerprints of its configurations),
 * and `results.jsonl`, which holds one line per review. Both are read as untrusted: another run or a
 * person may have written them, so each is parsed with `JSON.parse` and a strict schema at every level,
 * and anything the schema does not describe is refused. One thing is dropped, not refused: a `__proto__`
 * key of the result's `profiles` or of a profile's `lenses`, which zod's records skip, its value unread.
 * A record is scored, never merged into another object, so the key changes nothing, and refusing it as
 * the config loader does would walk every line again on each resume. A repeated key is not looked for:
 * the tree that finds one costs ten times the parse on a line of 16 MiB.
 *
 * A record keeps the facts of a review, not its scores: the report scores every record with the suite's
 * locations when it is built, so a score never goes stale.
 */

import { z } from 'zod'
import { inertJsonLine } from '../core/sanitize.ts'
import type { QuorumResult, Usage } from '../core/types.ts'
import { MAX_TRIALS, SUITE_ID } from './suite.ts'

/** The `format` of the run file this quorum writes and reads. */
export const RUN_FORMAT = 1
/** The most one line of `results.jsonl` may hold, its line break not counted, in bytes. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024
/** The most `run.json` may hold, in bytes. */
export const MAX_RUN_FILE_BYTES = 1024 * 1024

/** The most configurations a run holds. */
export const MAX_CONFIGURATIONS = 16

const MAX_ID = 64
const MAX_QUORUM_VERSION = 64
const MAX_CONFIG_PATH = 4096

/** One configuration of a run: the path as given (null for the usual resolution) and its fingerprint. */
export interface RunConfiguration {
  readonly path: string | null
  readonly fingerprint: string
}

/** What `run.json` holds. */
export interface RunFile {
  readonly format: 1
  /** The version of the quorum that began the run. */
  readonly quorum: string
  readonly suite: { readonly name: string, readonly hash: string }
  /** The key the fingerprints are keyed with: 32 random bytes as 64 lowercase hex digits. */
  readonly salt: string
  readonly configurations: readonly RunConfiguration[]
}

/** What one line of `results.jsonl` holds: a review that resolved, as the bench saw it. */
export interface ReviewRecord {
  readonly fingerprint: string
  /** The id of the suite's case. */
  readonly case: string
  readonly trial: number
  readonly latencyMs: number
  /** The provider calls the review made, failed ones included. */
  readonly calls: number
  readonly failedCalls: number
  /** The usage of the calls that reported one; absent when none did. */
  readonly usage?: Usage
  /** Whether every call reported a cost. */
  readonly costComplete: boolean
  readonly result: QuorumResult
}

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const identifier = z.string().max(MAX_ID).regex(SUITE_ID)
const count = z.int().min(0)
const amount = z.number().min(0)
const confidence = z.enum(['high', 'medium', 'low'])

const vote = z.strictObject({
  keep: z.boolean(),
  reasoning: z.string(),
})
const lensVote = z.strictObject({
  angle: z.string(),
  vote: vote.nullable(),
  error: z.string().nullable(),
})
const verdict = z.strictObject({
  id: z.string(),
  profile: z.string(),
  file: z.string(),
  line: count,
  category: z.string(),
  summary: z.string(),
  evidence: z.string(),
  quoteMatched: z.boolean(),
  keptVotes: count,
  totalVotes: count,
  confidence: confidence.optional(),
  votes: z.array(lensVote),
})
const providerRef = z.strictObject({
  id: z.string(),
  model: z.string(),
})
const thresholds = z.strictObject({
  high: count.nullable(),
  medium: count.nullable(),
  low: count.nullable(),
})
const usage = z.strictObject({
  inputTokens: amount,
  outputTokens: amount,
  costUsd: amount.optional(),
})
const profileMeta = z.strictObject({
  providers: z.strictObject({
    research: providerRef,
    lenses: z.record(z.string(), providerRef),
  }),
  policy: thresholds,
  gating: z.boolean(),
  invalidFindings: count,
})
const incompleteEntry = z.strictObject({
  profile: z.string(),
  reason: z.enum([
    'research-unusable',
    'findings-capped',
    'finding-unreadable',
    'vote-failed',
    'request-too-large',
  ]),
  file: z.string().optional(),
  detail: z.string(),
})
const flag = z.strictObject({
  code: z.enum(['hidden-characters', 'ai-addressed-text']),
  file: z.string().optional(),
  line: count.optional(),
  detail: z.string(),
})

/**
 * The schema of a result, strict at every level. `records.spec.ts` holds its output type equal to
 * `QuorumResult`, `readonly` aside, so a field the core adds, drops or retypes, optional or not, fails the
 * typecheck.
 */
export const resultSchema = z.strictObject({
  kept: z.array(verdict),
  discarded: z.array(verdict),
  unreviewed: z.array(verdict),
  meta: z.strictObject({
    version: z.string(),
    startedAt: z.string(),
    durationMs: count,
    profiles: z.record(z.string(), profileMeta),
    usage: usage.optional(),
    incomplete: z.array(incompleteEntry),
    flags: z.array(flag),
  }),
})

const recordSchema: z.ZodType<ReviewRecord> = z.strictObject({
  fingerprint: digest,
  case: identifier,
  trial: z.int().min(1).max(MAX_TRIALS),
  latencyMs: count,
  calls: count,
  failedCalls: count,
  usage: usage.optional(),
  costComplete: z.boolean(),
  result: resultSchema,
}).refine(({ calls, failedCalls }) => failedCalls <= calls)

const runFileSchema: z.ZodType<RunFile> = z.strictObject({
  format: z.literal(RUN_FORMAT),
  quorum: z.string().min(1).max(MAX_QUORUM_VERSION),
  suite: z.strictObject({
    name: identifier,
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  salt: digest,
  configurations: z.array(z.strictObject({
    path: z.string().min(1).max(MAX_CONFIG_PATH).nullable(),
    fingerprint: digest,
  })).min(1).max(MAX_CONFIGURATIONS),
})

/** `text` as JSON checked by `schema`; any failure, of the syntax or of the schema, is undefined. */
function parseWith<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success
      ? parsed.data
      : undefined
  } catch {
    return undefined
  }
}

/** The key of a planned review: the fingerprint, the case and the trial, as a JSON array. */
export function reviewKey(fingerprint: string, caseId: string, trial: number): string {
  return JSON.stringify([fingerprint, caseId, trial])
}

/** One line of `results.jsonl`: the record as inert JSON, on one line, and a line break. */
export function recordLine(record: ReviewRecord): string {
  return `${inertJsonLine(record)}\n`
}

/** The record a line of `results.jsonl` holds (without its line break), or undefined when the line is no record of this format. */
export function parseRecord(line: string): ReviewRecord | undefined {
  return parseWith(recordSchema, line)
}

/** The run file `text` holds, or undefined when it is no run file of this format. */
export function parseRunFile(text: string): RunFile | undefined {
  return parseWith(runFileSchema, text)
}
