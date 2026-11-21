/**
 * The time a review has left, estimated from what it has already done. Research is weighed in planned tokens:
 * each answered part gives a rate (milliseconds per planned token), the 25th and 75th percentile of the rates
 * bound the range, and the profiles' parts are pooled, since they share the review's one limit on calls at once.
 * The panel is weighed in votes. Nothing is read before enough parts have answered: until then the answer is
 * `estimating`. It is a pure function of the state it is given.
 */

import type { ViewState } from './model.ts'

/**
 * What is left: nothing, nothing yet known, or a range of the stage the review is in. `then` is the votes still to
 * come once research ends, when known: the panels' `votes`, else the estimate's, else `maxFindings` for each lens.
 */
export type TimeLeft
  = | { readonly kind: 'none' }
    | { readonly kind: 'estimating', readonly then?: number }
    | { readonly kind: 'range', readonly stage: 'research' | 'panel', readonly lowMs: number, readonly highMs: number, readonly then?: number }

/** The fewest answered parts a range is read from, and the share of the plan that must have answered. */
const SAMPLE_FLOOR = 3
const SAMPLE_SHARE = 10

/** How many answered parts the time left waits for, for `total` research parts: 3, or a tenth of the plan. */
export function sampleNeeded(total: number): number {
  return Math.max(SAMPLE_FLOOR, Math.ceil(total / SAMPLE_SHARE))
}

/** The research parts of a profile: its stage's count, else the estimate's for a profile not yet started, else none known. */
export function partsOf(state: ViewState, profile: string): number {
  return state.profiles.get(profile)?.parts
    ?? state.facts.estimate?.profiles[profile]?.parts.length
    ?? 0
}

/** The research parts of every profile, pooled. */
export function researchTotal(state: ViewState): number {
  let total = 0
  for (const id of state.profiles.keys()) total += partsOf(state, id)
  return total
}

/** The tokens planned for part `index` of `profile`: the estimate's reservation when its parts match the stage's count, else the part's first call's. */
export function plannedOf(state: ViewState, profile: string, index: number): number | undefined {
  const estimated = state.facts.estimate?.profiles[profile]?.parts
  if (estimated !== undefined && estimated.length === partsOf(state, profile) && index <= estimated.length) return estimated[index - 1]
  return state.planned.get(`${profile}|${index}`)
}

/** The votes a profile's panel casts: its stage's count, else the estimate's, else `maxFindings` for each of its lenses. */
function votesOf(state: ViewState, profile: string): number {
  return state.profiles.get(profile)?.votes
    ?? state.facts.estimate?.profiles[profile]?.votes
    ?? state.facts.maxFindings * (state.lenses.get(profile) ?? 0)
}

/** The votes not yet cast, over every profile. */
function votesLeft(state: ViewState): number {
  let left = 0
  for (const [id, profile] of state.profiles) left += Math.max(0, votesOf(state, id) - profile.cast)
  return left
}

/** The value at percentile `p` of `sorted`, by nearest rank. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)]
}

const ascending = (a: number, b: number): number => a - b

/** Whether any profile still has research parts to answer: one not started, or one whose parts are not all done. The heartbeat, the block and the time left all read it. */
export function researchRuns(state: ViewState): boolean {
  for (const profile of state.profiles.values()) {
    if (profile.stage === 'waiting') return true
    if (profile.stage === 'research' && (profile.parts === undefined || profile.done < profile.parts)) return true
  }
  return false
}

/** The mean of the tokens planned for the parts started, which weighs a part whose plan nothing states. */
function meanPlanned(state: ViewState): number {
  if (state.planned.size === 0) return 0
  let sum = 0
  for (const planned of state.planned.values()) sum += planned
  return sum / state.planned.size
}

/** When each part in flight's first call started, by `<profile>|<part>`. */
function startsOfParts(state: ViewState): ReadonlyMap<string, number> {
  const starts = new Map<string, number>()
  for (const call of state.calls.values()) {
    if (call.role !== 'research' || call.part === undefined) continue
    const key = `${call.profile}|${call.part.index}`
    const known = starts.get(key)
    if (known === undefined || call.startedAt < known) starts.set(key, call.startedAt)
  }
  return starts
}

function researchLeft(state: ViewState, now: number, then: number | undefined): TimeLeft {
  if (state.sample.parts.length < sampleNeeded(researchTotal(state))) return estimating(then)
  const rates = state.sample.parts.map(({ planned, durationMs }) => durationMs / planned).sort(ascending)
  const [low, mid, high] = [25, 50, 75].map(p => percentile(rates, p))
  const mean = meanPlanned(state)
  const starts = startsOfParts(state)
  let left = 0
  let pending = 0
  for (const id of state.profiles.keys()) {
    for (let index = 1; index <= partsOf(state, id); index++) {
      const key = `${id}|${index}`
      if (state.partsEnded.has(key)) continue
      pending += 1
      const planned = plannedOf(state, id, index) ?? mean
      const started = starts.get(key)
      const covered = started === undefined
        ? 0
        : mid > 0
          ? Math.min(planned, Math.max(0, now - started) / mid)
          : planned
      left += planned - covered
    }
  }
  if (pending === 0) return estimating(then)
  const atOnce = Math.max(1, Math.min(state.facts.concurrency, pending))
  return range('research', left * low / atOnce, left * high / atOnce, then)
}

function panelLeft(state: ViewState, then: number): TimeLeft {
  if (state.sample.votes.length === 0) return estimating(then)
  const durations = [...state.sample.votes].sort(ascending)
  const atOnce = Math.max(1, Math.min(state.facts.concurrency, then))
  return range('panel', then * percentile(durations, 25) / atOnce, then * percentile(durations, 75) / atOnce)
}

function estimating(then: number | undefined): TimeLeft {
  return then === undefined || then <= 0
    ? { kind: 'estimating' }
    : { kind: 'estimating', then }
}

function range(stage: 'research' | 'panel', lowMs: number, highMs: number, then?: number): TimeLeft {
  return then === undefined || then <= 0
    ? { kind: 'range', stage, lowMs, highMs }
    : {
        kind: 'range',
        stage,
        lowMs,
        highMs,
        then,
      }
}

/**
 * What is left of the review, as of `now`: nothing before `run:start` and after `run:end`; while research
 * runs, `estimating` until `sampleNeeded` parts have answered, then the range over the planned tokens left, over the
 * calls at once; and once research is done, the votes left over the votes' own durations, after the first vote was
 * cast. `then` is the votes still to come once research ends, as a figure to show beside it.
 */
export function timeLeft(state: ViewState, now: number): TimeLeft {
  if (state.startedAt === undefined || state.ended || state.profiles.size === 0) return { kind: 'none' }
  if (researchRuns(state)) {
    const then = votesLeft(state)
    return researchLeft(state, now, then)
  }
  const left = votesLeft(state)
  const waiting = [
    ...state.profiles.values(),
  ].some(profile => profile.votes === undefined && profile.stage !== 'done')
  if (left <= 0) {
    return waiting
      ? estimating(undefined)
      : { kind: 'none' }
  }
  return panelLeft(state, left)
}

/** One bound of a time left, as a number of minutes rounded up from 120 s, else of seconds rounded up. */
function bound(ms: number): { readonly count: number, readonly unit: 's' | 'm' } {
  return ms >= 120_000
    ? {
        count: Math.ceil(ms / 60_000),
        unit: 'm',
      }
    : {
        count: Math.ceil(ms / 1000),
        unit: 's',
      }
}

/**
 * A time left's range in words: one unit when both bounds share it (`12-16m`, `40-90s`), each its own when they
 * differ (`90s-3m`), and one bound when they are equal (`3m`). `dash` is the glyph set's.
 */
export function rangeWords(lowMs: number, highMs: number, dash: string): string {
  const low = bound(lowMs)
  const high = bound(highMs)
  if (low.unit === high.unit) {
    return low.count === high.count
      ? `${low.count}${low.unit}`
      : `${low.count}${dash}${high.count}${low.unit}`
  }
  return `${low.count}${low.unit}${dash}${high.count}${high.unit}`
}
