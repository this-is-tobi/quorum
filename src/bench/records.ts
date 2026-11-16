/**
 * The two files of a bench run directory, as data: `run.json`, which holds what makes the run one run
 * (the quorum version, the suite's name and two hashes, the salt, and the fingerprints of its configurations),
 * and `results.jsonl`, which holds one line per review. Both are read as untrusted: another run or a
 * person may have written them, so each is parsed with `JSON.parse` and a strict schema at every level,
 * and anything the schema does not describe is refused. The result's schema is the core's (`resultSchema`),
 * shared with `readResult`; its comment says what it drops and why.
 *
 * A record keeps the facts of a review, not its scores: the report scores every record with the suite's
 * locations when it is built, so a score never goes stale. It keeps the review's result or, for a review
 * that a model's reply denied, which denial it was, never the reply.
 */

import { z } from 'zod'
import { resultSchema, usageSchema } from '../core/result-schema.ts'
import { inertJsonLine } from '../core/sanitize.ts'
import type { QuorumResult, Usage } from '../core/types.ts'
import { MAX_TRIALS, SUITE_ID } from './suite.ts'

/** The `format` of the run file this quorum writes and reads. */
export const RUN_FORMAT = 2
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

/** The suite a run was made under: its name and the two hashes of `loadSuite`, and the scoring hash the run began with. */
export interface RunSuite {
  readonly name: string
  readonly reviewHash: string
  readonly scoringHash: string
  /** The scoring hash of the suite when the run began, which a later scoring hash is told apart from. */
  readonly firstScoringHash: string
}

/** What `run.json` holds. */
export interface RunFile {
  readonly format: 2
  /** The version of the quorum that began the run. */
  readonly quorum: string
  readonly suite: RunSuite
  /** The key the fingerprints are keyed with: 32 random bytes as 64 lowercase hex digits. */
  readonly salt: string
  readonly configurations: readonly RunConfiguration[]
}

/**
 * How a model's reply denied a review: its research reply could not be used, the model refused the
 * research request, or its reply was cut off at its token limit.
 */
export const DENIALS = ['unusable-reply', 'refusal', 'truncated'] as const

export type Denial = typeof DENIALS[number]

/** What every line of `results.jsonl` holds of a review, as the bench saw it, whatever came back. */
interface RecordFacts {
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
}

/** A review that resolved: its facts and its full result. */
export type ResultRecord = RecordFacts & { readonly result: QuorumResult }

/** A review that a model's reply denied: its facts and which denial, and no result. */
export type DeniedRecord = RecordFacts & { readonly denied: Denial }

/** What one line of `results.jsonl` holds: a review that resolved, or one that a model's reply denied. */
export type ReviewRecord = ResultRecord | DeniedRecord

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const identifier = z.string().max(MAX_ID).regex(SUITE_ID)
const count = z.int().min(0)

const facts = {
  fingerprint: digest,
  case: identifier,
  trial: z.int().min(1).max(MAX_TRIALS),
  latencyMs: count,
  calls: count,
  failedCalls: count,
  usage: usageSchema.optional(),
  costComplete: z.boolean(),
}

/** A record holds exactly one of a result and a denial: each alternative is strict, so a line with both, or with neither, is refused. */
const recordSchema: z.ZodType<ReviewRecord> = z.union([
  z.strictObject({ ...facts, result: resultSchema }),
  z.strictObject({
    ...facts,
    denied: z.enum(DENIALS),
  }),
]).refine(({ calls, failedCalls }) => failedCalls <= calls)

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/)

const runFileSchema: z.ZodType<RunFile> = z.strictObject({
  format: z.literal(RUN_FORMAT),
  quorum: z.string().min(1).max(MAX_QUORUM_VERSION),
  suite: z.strictObject({
    name: identifier,
    reviewHash: hash,
    scoringHash: hash,
    firstScoringHash: hash,
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
