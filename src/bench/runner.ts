/**
 * The runner of a bench: it takes the planned reviews and runs each through a quorum of its own, at most
 * `jobs` at once, and hands every review that resolved, or that a model's reply denied, to the caller as a
 * record to write. It knows nothing of the run directory, the report or the terminal: the caller gives it
 * a way to write a line and a callback to report to.
 */

import type { Env } from '../config/env.ts'
import { fromConfig } from '../config/from-config.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { createLimiter } from '../core/concurrency.ts'
import { OutputError, ProviderError } from '../core/errors.ts'
import type { EventSink } from '../core/ports.ts'
import type { QuorumResult, Usage } from '../core/types.ts'
import { MAX_RECORD_BYTES, recordLine } from './records.ts'
import type { Denial, ResultRecord, ReviewRecord } from './records.ts'
import type { Suite } from './suite.ts'

const OVERSIZED_RECORD = 'its record is over the size a line of results.jsonl holds'
const UNKNOWN_REVIEW = 'its case or its configuration is not in the run'

/** One planned review: a trial of a case with a configuration. */
export interface BenchReview {
  readonly trial: number
  readonly caseId: string
  /** The configuration's index in `configurations`, from 0. */
  readonly configuration: number
}

/** A configuration to run: the resolved config, and the fingerprint its records are keyed with. */
export interface RunnerConfiguration {
  readonly config: ResolvedConfig
  readonly fingerprint: string
}

/** What the runner reports: a review that was recorded, resolved or denied, and written, or one that failed. */
export type RunnerEvent
  = | { readonly type: 'recorded', readonly review: BenchReview, readonly record: ReviewRecord }
    | { readonly type: 'failed', readonly review: BenchReview, readonly error: unknown }

export interface RunReviewsOptions {
  readonly suite: Suite
  readonly configurations: readonly RunnerConfiguration[]
  readonly reviews: readonly BenchReview[]
  /** At most this many reviews run at once. */
  readonly jobs: number
  /** What a `claude-code` provider's CLI inherits. */
  readonly env: Env
  readonly signal?: AbortSignal
  /** Writes one line of `results.jsonl`; it throws when the write fails. */
  readonly append: (line: string) => Promise<void>
  readonly events: (event: RunnerEvent) => void
  /** The most a line may hold, its line break not counted, in bytes; `MAX_RECORD_BYTES` when left out. */
  readonly maxRecordBytes?: number
}

export interface RunReviewsOutcome {
  /** The reviews written to the record. */
  readonly recorded: number
  /** The reviews that failed, a rejection that is no denial, or whose record was too large to write. */
  readonly failed: number
  /** Whether the caller's signal was aborted by the time the run ended. */
  readonly interrupted: boolean
}

/** The reviews of a bench in the order they run: by trial from 1, then by case, then by configuration. */
export function planReviews(options: { readonly trials: number, readonly cases: readonly string[], readonly configurations: number }): BenchReview[] {
  const reviews: BenchReview[] = []
  for (let trial = 1; trial <= options.trials; trial++) {
    for (const caseId of options.cases) {
      for (let configuration = 0; configuration < options.configurations; configuration++) reviews.push({ trial, caseId, configuration })
    }
  }
  return reviews
}

/** What a review's `call` events add up to, and the sink that counts them. */
function tallyCalls(): { readonly sink: EventSink, readonly counts: () => Pick<ResultRecord, 'calls' | 'failedCalls' | 'usage' | 'costComplete'> } {
  let calls = 0
  let failedCalls = 0
  let costed = 0
  let measured = false
  const total: Usage = { inputTokens: 0, outputTokens: 0 }
  return {
    sink: (event) => {
      if (event.type !== 'call') return
      calls += 1
      if (!event.ok) failedCalls += 1
      if (event.usage === undefined) return
      measured = true
      total.inputTokens += event.usage.inputTokens
      total.outputTokens += event.usage.outputTokens
      if (event.usage.costUsd === undefined) return
      costed += 1
      total.costUsd = (total.costUsd ?? 0) + event.usage.costUsd
    },
    counts: () => ({
      calls,
      failedCalls,
      ...(measured
        ? {
            usage: { ...total },
          }
        : {}),
      costComplete: costed === calls,
    }),
  }
}

/**
 * The denial a review's rejection records, or undefined when the review fails and is retried. A review
 * whose research reply could not be used (an `OutputError`), or whose research call the model refused or
 * cut off at its token limit (a `ProviderError` of kind `refusal` or `truncated`), was answered by its
 * model: a retry cannot tell the model's unreliability from an outage, and a poisoned patch provokes such
 * replies on purpose, so the review is recorded as denied, with no result, and counts as incomplete. Any
 * other rejection (an HTTP, network, timeout or process failure, a reply the server shaped wrong) says
 * nothing of the model's answer, so the review fails and runs again. The classes are matched with
 * `instanceof`: an error from a second copy of quorum is no denial, so it fails, which fails closed.
 */
export function denialOf(error: unknown): Denial | undefined {
  if (error instanceof OutputError) return 'unusable-reply'
  if (error instanceof ProviderError && (error.kind === 'refusal' || error.kind === 'truncated')) return error.kind
  return undefined
}

/**
 * Run the planned reviews in the order given, at most `jobs` at once, and give the caller each review
 * that resolved, or that a model's reply denied (`denialOf`), as a record: `append` writes its line, then
 * `events` reports it as `recorded`.
 *
 * Each review gets a quorum of its own through `fromConfig`, with an event sink of its own, so its record
 * counts only its own calls. A review that rejects with any other error is reported as `failed` and not
 * recorded, and the others run. One `AbortController` of the runner's, joined to the caller's `signal`,
 * cuts the reviews in flight when the caller is interrupted or a write fails, and a review that has not
 * started when it is aborted does not start. A review that rejects while the run is aborted is neither
 * recorded, a denial included, nor a failure: an interrupt is not a verdict on the review. A review that
 * resolved is recorded, even when the interrupt came while its record was written. A line over
 * `maxRecordBytes` is a failed review and is never written, since the reader of `results.jsonl` refuses
 * a line that long, and with it the whole directory. A write that fails stops the run: it reports
 * nothing for that review, cuts the others, and the run rejects with the error of the write once every
 * review has settled. A callback of `events` that throws does the same.
 *
 * @throws the error of the first `append` (or `events`) that threw
 */
export async function runReviews(options: RunReviewsOptions): Promise<RunReviewsOutcome> {
  const { suite, configurations, reviews, jobs, env, append, events, maxRecordBytes = MAX_RECORD_BYTES } = options
  const own = new AbortController()
  const signal = options.signal === undefined
    ? own.signal
    : AbortSignal.any([options.signal, own.signal])
  const patches = new Map(suite.cases.map(({ id, patch }) => [
    id,
    suite.patches.get(patch),
  ]))
  let recorded = 0
  let failed = 0
  let stopped: { readonly error: unknown } | undefined

  const stop = (error: unknown): void => {
    stopped ??= { error }
    own.abort()
  }
  const report = (event: RunnerEvent): void => {
    try {
      events(event)
    } catch (error) {
      stop(error)
    }
  }
  const fail = (review: BenchReview, error: unknown): void => {
    failed += 1
    report({ type: 'failed', review, error })
  }

  async function recordOf(review: BenchReview): Promise<ReviewRecord> {
    const configuration = configurations[review.configuration]
    const diff = patches.get(review.caseId)
    if (configuration === undefined || diff === undefined) throw new Error(UNKNOWN_REVIEW)
    const tally = tallyCalls()
    const quorum = await fromConfig(configuration.config, { env, events: tally.sink })
    const started = performance.now()
    const facts = (): Omit<ResultRecord, 'result'> => ({
      fingerprint: configuration.fingerprint,
      case: review.caseId,
      trial: review.trial,
      latencyMs: Math.round(performance.now() - started),
      ...tally.counts(),
    })
    let result: QuorumResult
    try {
      result = await quorum.review({ diff }, { signal })
    } catch (error) {
      const denied = signal.aborted
        ? undefined
        : denialOf(error)
      if (denied === undefined) throw error
      return {
        ...facts(),
        denied,
      }
    }
    return {
      ...facts(),
      result,
    }
  }

  async function runOne(review: BenchReview): Promise<void> {
    if (signal.aborted) return
    let record: ReviewRecord
    let line: string
    try {
      record = await recordOf(review)
      line = recordLine(record)
    } catch (error) {
      if (!signal.aborted) fail(review, error)
      return
    }
    if (stopped !== undefined) return
    if (Buffer.byteLength(line) - 1 > maxRecordBytes) {
      fail(review, new Error(OVERSIZED_RECORD))
      return
    }
    try {
      await append(line)
    } catch (error) {
      stop(error)
      return
    }
    recorded += 1
    report({ type: 'recorded', review, record })
  }

  const limit = createLimiter(jobs)
  await Promise.all(reviews.map(review => limit(() => runOne(review))))
  if (stopped !== undefined) throw stopped.error
  return { recorded, failed, interrupted: options.signal?.aborted === true }
}
