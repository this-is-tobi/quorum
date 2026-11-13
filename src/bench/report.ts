/**
 * The report of a bench run: what each configuration caught, what it cost and how sure the numbers are,
 * built from the scored reviews and rendered as Markdown and as JSON. Pure code over scores, so the
 * report can be built again from a run directory. It holds numbers, suite ids and configuration paths,
 * never text a model wrote.
 */

import { inertJson, inertLine } from '../core/sanitize.ts'
import { reviewKey } from './records.ts'
import type { ReviewRecord, RunConfiguration } from './records.ts'
import { scoreReview } from './score.ts'
import type { ReviewOutcome } from './score.ts'
import { nearestRank, signTest, wilson } from './stats.ts'
import type { SuiteCase } from './suite.ts'

/** A comparison is resolved when its p is below this. */
const ALPHA = 0.05

/** What one review earned, with what it took: its latency, its tokens when it reported usage, and its cost when every call reported one. */
export interface ReviewScore extends ReviewOutcome {
  readonly latencyMs: number
  readonly tokens?: number
  readonly costUsd?: number
}

/** A rate, the mean of the case scores, with its Wilson interval over `cases` cases. */
export interface Rate {
  readonly value: number
  readonly low: number
  readonly high: number
  readonly cases: number
}

/** What one configuration did over the reviews that count. */
export interface ConfigurationSummary {
  /** The position of the configuration, from 1; the first is the reference. */
  readonly index: number
  readonly path: string | null
  readonly reviews: number
  readonly planned: number
  readonly incomplete: number
  readonly keptRecall: Rate | null
  readonly proposedRecall: Rate | null
  readonly unmatchedKept: { readonly bug: number | null, readonly control: number | null }
  readonly tokens: { readonly median: number, readonly total: number } | null
  readonly latencyMs: { readonly p50: number, readonly p95: number } | null
  readonly costUsd: number | null
}

/** What a comparison with the reference measures. */
export type Measure = 'kept-recall' | 'proposed-recall' | 'unmatched-kept-per-control' | 'incomplete' | 'tokens'

/** One configuration against the reference on one measure: an exact sign test over the cases both scored. */
export interface Comparison {
  readonly configuration: number
  readonly measure: Measure
  /** The mean over the pairs of the configuration's case score minus the reference's; null with no pair. */
  readonly difference: number | null
  readonly better: number
  readonly worse: number
  readonly tied: number
  readonly p: number
  readonly resolved: boolean
}

/** What one configuration scored on one case, over the trials that count. */
export interface CaseScore {
  readonly trials: number
  /** The share of the trials that caught the bug; null for a control. */
  readonly keptCatch: number | null
  readonly proposedCatch: number | null
  /** The mean over the trials of the kept findings that catch nothing. */
  readonly unmatchedKept: number
  /** The share of the trials with a gap. */
  readonly incomplete: number
  /** The mean over the trials that reported usage; null when none did. */
  readonly tokens: number | null
}

/** The scores of one case, one entry per configuration, null for a configuration that counted none of its trials. */
export interface CaseScores {
  readonly id: string
  readonly kind: 'bug' | 'control'
  readonly configurations: readonly (CaseScore | null)[]
}

export interface Report {
  readonly suite: string
  readonly quorum: string
  readonly trials: number
  readonly window: number
  readonly bugCases: number
  readonly controls: number
  readonly configurations: readonly ConfigurationSummary[]
  readonly comparisons: readonly Comparison[]
  readonly cases: readonly CaseScores[]
}

/** What the report is built from: the suite, the selected cases and trials, the configurations in order and the score of each recorded review by `reviewKey`. */
export interface ReportInput {
  readonly suite: { readonly name: string, readonly window: number }
  readonly quorum: string
  readonly cases: readonly SuiteCase[]
  readonly trials: number
  readonly configurations: readonly RunConfiguration[]
  readonly scores: ReadonlyMap<string, ReviewScore>
}

/** Score a record against its case: the outcome, the latency, the tokens (input plus output) when there is usage, and the cost when every call reported one. */
export function reviewScore(record: ReviewRecord, suiteCase: SuiteCase, window: number): ReviewScore {
  return {
    ...scoreReview(record.result, suiteCase, window),
    latencyMs: record.latencyMs,
    ...(record.usage === undefined
      ? {}
      : { tokens: record.usage.inputTokens + record.usage.outputTokens }),
    ...(record.costComplete
      ? { costUsd: record.usage?.costUsd ?? 0 }
      : {}),
  }
}

/** The plain mean: the sum over the count, so values that are all 1 give exactly 1 and all 0 exactly 0. */
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** The share of `scores` that `pick` holds for. */
function share(scores: readonly ReviewScore[], pick: (score: ReviewScore) => boolean): number {
  return scores.filter(pick).length / scores.length
}

function caseScore(kind: SuiteCase['kind'], scores: readonly ReviewScore[]): CaseScore | null {
  if (scores.length === 0) return null
  const tokens = scores.flatMap(score => score.tokens === undefined
    ? []
    : [score.tokens])
  return {
    trials: scores.length,
    keptCatch: kind === 'bug'
      ? share(scores, score => score.keptCatch)
      : null,
    proposedCatch: kind === 'bug'
      ? share(scores, score => score.proposedCatch)
      : null,
    unmatchedKept: mean(scores.map(score => score.unmatchedKept)),
    incomplete: share(scores, score => score.incomplete),
    tokens: tokens.length === 0
      ? null
      : mean(tokens),
  }
}

/** The scores of the reviews that count for a configuration, per selected case: those recorded for a trial from 1 to `trials`. */
function countedScores(input: ReportInput, fingerprint: string): ReviewScore[][] {
  return input.cases.map((suiteCase) => {
    const counted: ReviewScore[] = []
    for (let trial = 1; trial <= input.trials; trial++) {
      const score = input.scores.get(reviewKey(fingerprint, suiteCase.id, trial))
      if (score !== undefined) counted.push(score)
    }
    return counted
  })
}

function rate(values: readonly number[]): Rate | null {
  if (values.length === 0) return null
  const value = mean(values)
  return {
    value,
    ...wilson(value, values.length),
    cases: values.length,
  }
}

function meanOrNull(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : mean(values)
}

function summarize(input: ReportInput, index: number, counted: readonly ReviewScore[][], cases: readonly CaseScores[]): ConfigurationSummary {
  const scored = (kind: SuiteCase['kind'], pick: (score: CaseScore) => number | null): number[] => cases.flatMap(({ kind: caseKind, configurations }) => {
    const score = configurations[index - 1]
    const value = caseKind === kind && score !== null
      ? pick(score)
      : null
    return value === null
      ? []
      : [value]
  })
  const reviews = counted.flat()
  const latencies = reviews.map(score => score.latencyMs)
  const tokens = reviews.flatMap(({ tokens: used }) => used === undefined
    ? []
    : [used])
  return {
    index,
    path: input.configurations[index - 1].path,
    reviews: reviews.length,
    planned: input.cases.length * input.trials,
    incomplete: reviews.filter(score => score.incomplete).length,
    keptRecall: rate(scored('bug', score => score.keptCatch)),
    proposedRecall: rate(scored('bug', score => score.proposedCatch)),
    unmatchedKept: {
      bug: meanOrNull(scored('bug', score => score.unmatchedKept)),
      control: meanOrNull(scored('control', score => score.unmatchedKept)),
    },
    tokens: tokens.length === 0
      ? null
      : {
          median: nearestRank(tokens, 50),
          total: tokens.reduce((sum, used) => sum + used, 0),
        },
    latencyMs: latencies.length === 0
      ? null
      : {
          p50: nearestRank(latencies, 50),
          p95: nearestRank(latencies, 95),
        },
    costUsd: reviews.length > 0 && reviews.every(score => score.costUsd !== undefined)
      ? reviews.reduce((sum, score) => sum + (score.costUsd ?? 0), 0)
      : null,
  }
}

interface MeasureRule {
  readonly measure: Measure
  /** The kind of case the measure is over; every case when absent. */
  readonly kind?: SuiteCase['kind']
  readonly lowerIsBetter: boolean
  readonly pick: (score: CaseScore) => number | null
}

/** The five measures of a comparison, in the order of `Measure`. */
const MEASURES: readonly MeasureRule[] = [
  {
    measure: 'kept-recall',
    kind: 'bug',
    lowerIsBetter: false,
    pick: score => score.keptCatch,
  },
  {
    measure: 'proposed-recall',
    kind: 'bug',
    lowerIsBetter: false,
    pick: score => score.proposedCatch,
  },
  {
    measure: 'unmatched-kept-per-control',
    kind: 'control',
    lowerIsBetter: true,
    pick: score => score.unmatchedKept,
  },
  {
    measure: 'incomplete',
    lowerIsBetter: true,
    pick: score => score.incomplete,
  },
  {
    measure: 'tokens',
    lowerIsBetter: true,
    pick: score => score.tokens,
  },
]

/** The configuration at `index` (from 1, after the reference) against the reference on one measure, over the cases both scored. */
function compare(rule: MeasureRule, cases: readonly CaseScores[], index: number): Comparison {
  const differences: number[] = []
  let better = 0
  let worse = 0
  for (const { kind, configurations } of cases) {
    if (rule.kind !== undefined && rule.kind !== kind) continue
    const reference = configurations[0]
    const current = configurations[index - 1]
    const before = reference === null
      ? null
      : rule.pick(reference)
    const after = current === null
      ? null
      : rule.pick(current)
    if (before === null || after === null) continue
    const difference = after - before
    differences.push(difference)
    if (difference === 0) continue
    if ((difference < 0) === rule.lowerIsBetter) better++
    else worse++
  }
  const p = signTest(better, worse)
  return {
    configuration: index,
    measure: rule.measure,
    difference: meanOrNull(differences),
    better,
    worse,
    tied: differences.length - better - worse,
    p,
    resolved: p < ALPHA,
  }
}

/** Build the report: count the recorded reviews of the selected cases and trials, score each case, summarize each configuration and compare each with the first. */
export function buildReport(input: ReportInput): Report {
  const counted = input.configurations.map(({ fingerprint }) => countedScores(input, fingerprint))
  const cases = input.cases.map((suiteCase, position): CaseScores => ({
    id: suiteCase.id,
    kind: suiteCase.kind,
    configurations: counted.map(perCase => caseScore(suiteCase.kind, perCase[position])),
  }))
  return {
    suite: input.suite.name,
    quorum: input.quorum,
    trials: input.trials,
    window: input.suite.window,
    bugCases: input.cases.filter(({ kind }) => kind === 'bug').length,
    controls: input.cases.filter(({ kind }) => kind === 'control').length,
    configurations: counted.map((perCase, position) => summarize(input, position + 1, perCase, cases)),
    comparisons: input.configurations.slice(1).flatMap((_, position) => MEASURES.map(rule => compare(rule, cases, position + 2))),
    cases,
  }
}

const NOT_AVAILABLE = 'n/a'

const LABELS: Readonly<Record<Measure, string>> = {
  'kept-recall': 'kept recall',
  'proposed-recall': 'proposed recall',
  'unmatched-kept-per-control': 'unmatched kept findings per control',
  incomplete: 'incomplete reviews',
  tokens: 'tokens per review',
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1
    ? ''
    : 's'}`
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function rateText(rate: Rate | null): string {
  return rate === null
    ? NOT_AVAILABLE
    : `${percent(rate.value)} [${percent(rate.low)}, ${percent(rate.high)}] over ${plural(rate.cases, 'case')}`
}

function twoDecimals(value: number | null): string {
  return value === null
    ? NOT_AVAILABLE
    : value.toFixed(2)
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

/**
 * `value * scale` as `digits` decimals, with its sign written unless it reads as zero: a difference
 * that rounds to zero is `0.0`, never `-0.0` or `+0.0`.
 */
function signed(value: number, scale: number, digits: number): string {
  const magnitude = Math.abs(value * scale).toFixed(digits)
  if (Number(magnitude) === 0) return magnitude
  return `${value < 0
    ? '-'
    : '+'}${magnitude}`
}

function differenceText(measure: Measure, difference: number): string {
  switch (measure) {
    case 'kept-recall':
    case 'proposed-recall':
    case 'incomplete':
      return `${signed(difference, 100, 1)} points`
    case 'unmatched-kept-per-control':
      return signed(difference, 1, 2)
    case 'tokens':
      return signed(difference, 1, 0)
  }
}

function pText(p: number): string {
  return p < 0.0001
    ? 'p < 0.0001'
    : `p = ${p.toFixed(4)}`
}

function rowText(summary: ConfigurationSummary): string {
  const cells = [
    String(summary.index),
    `${summary.reviews} of ${summary.planned}`,
    rateText(summary.keptRecall),
    rateText(summary.proposedRecall),
    `${twoDecimals(summary.unmatchedKept.bug)} / ${twoDecimals(summary.unmatchedKept.control)}`,
    String(summary.incomplete),
    summary.tokens === null
      ? NOT_AVAILABLE
      : `${Math.round(summary.tokens.median)} / ${Math.round(summary.tokens.total)}`,
    summary.latencyMs === null
      ? NOT_AVAILABLE
      : `${seconds(summary.latencyMs.p50)} / ${seconds(summary.latencyMs.p95)}`,
    summary.costUsd === null
      ? NOT_AVAILABLE
      : `$${summary.costUsd.toFixed(4)}`,
  ]
  return `| ${cells.join(' | ')} |`
}

function comparisonText(comparison: Comparison): string {
  const label = `- ${comparison.configuration}, ${LABELS[comparison.measure]}`
  if (comparison.difference === null) return `${label}: no case scored by both`
  const counts = `${comparison.better} better, ${comparison.worse} worse, ${comparison.tied} tied`
  return `${label}: ${differenceText(comparison.measure, comparison.difference)}; ${counts}; ${pText(comparison.p)}, ${comparison.resolved
    ? 'resolved'
    : 'unresolved'}`
}

function configurationText(summary: ConfigurationSummary, several: boolean): string {
  const name = summary.path ?? '(default configuration)'
  return `${summary.index}. ${name}${several && summary.index === 1
    ? ' (reference)'
    : ''}`
}

/** The report as Markdown: its counts, the configurations and their table, and the comparison lines when there are two or more configurations. Every line is inert. */
export function reportMarkdown(report: Report): string {
  const several = report.configurations.length > 1
  const trials = report.trials === 1
    ? 'trial 1'
    : `trials 1 to ${report.trials}`
  const lines = [
    `# quorum bench: ${report.suite}`,
    '',
    `quorum ${report.quorum}; ${plural(report.bugCases, 'bug case')} and ${plural(report.controls, 'control')}; ${trials}; window ${plural(report.window, 'line')}.`,
    '',
    'A review counts when it is recorded for one of these cases and trials. A case scores the share of its counted trials with the outcome, and a case with none counted is left out. A rate is the mean of the case scores, with its 95% Wilson interval over the cases scored.',
    '',
    '## Configurations',
    '',
    ...report.configurations.map(summary => configurationText(summary, several)),
    '',
    '| Configuration | Reviews | Kept recall | Proposed recall | Unmatched kept per case, bug / control | Incomplete | Tokens per review, median / total | Latency, p50 / p95 | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.configurations.map(rowText),
    '',
  ]
  if (several) {
    lines.push(
      '## Comparisons with the reference',
      '',
      'Each line pairs the cases both configurations scored and is its own exact sign test, so with several lines some can resolve by chance.',
      '',
      ...report.comparisons.map(comparisonText),
      '',
    )
  }
  return lines.map(inertLine).join('\n')
}

/** The report as inert JSON and a line break; it parses back to the report. */
export function reportJson(report: Report): string {
  return `${inertJson(report)}\n`
}
