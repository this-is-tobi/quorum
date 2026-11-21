/**
 * Recorded event lists for the view's specs: whole reviews as a provider would have lived them, each event with the
 * time it arrived, in milliseconds from the review's start. They are fixtures, never a measurement: the durations are
 * made up to the shapes the view must read, and every field is a number, an id or a code word.
 */

import { DEFAULT_FACTS, fold, startState } from '../cli/view/model.ts'
import type { ViewFacts, ViewState } from '../cli/view/model.ts'
import type { PartOutcome } from '../core/parts.ts'
import type { CallFailure, ProviderRef, QuorumEvent, Usage } from '../core/types.ts'

/** An event and when it arrived. */
export interface Timed {
  readonly at: number
  readonly event: QuorumEvent
}

const API: ProviderRef = { id: 'api', model: 'model' }
const LENSES = ['reachability', 'impact', 'defenses']
const TIMEOUT_MS = 600_000
const RESERVED = 60_000
const VOTE_RESERVED = 6000

/** One call of a part: how long it takes whole, and what it ends with. */
interface Step {
  readonly ms: number
  readonly piece?: { readonly index: number, readonly count: number }
  /** The call's one retry: after how long its first attempt failed with `failure`, and the wait before the second. */
  readonly retry?: { readonly afterMs: number, readonly failure: CallFailure, readonly waitMs: number }
  /** What the call fails with, after its attempts: none when it is answered. */
  readonly failure?: CallFailure
  readonly listed?: number
}

/** A research part to run: its calls one after the other in one lane, and what becomes of it. */
interface Job {
  readonly profile: string
  readonly index: number
  readonly count: number
  readonly steps: readonly Step[]
  readonly outcome?: PartOutcome
  readonly recovered?: { readonly pieces: number, readonly read: number }
}

/** A call placed in time. */
interface Placed {
  readonly job: Job
  readonly step: Step
  readonly start: number
  readonly end: number
}

interface Entry extends Timed {
  readonly rank: number
  readonly seq: number
}

/** The tokens a research call of part `index` spends, from its usage. */
function researchUsage(index: number): Usage {
  return { inputTokens: 26_000 + (index * 977 % 7) * 500, outputTokens: 3000 + (index % 5) * 300 }
}

const total = ({ inputTokens, outputTokens }: Usage): number => inputTokens + outputTokens

/** The listing order of events that arrive together: a call's end, then its retry, then a start. */
const ENDS = 0
const RETRIES = 1
const STARTS = 2

/**
 * Runs `jobs` in order on `lanes` lanes from `from`, each part in the first lane to be free, and writes the events of
 * their calls and parts. Calls are numbered in the order they start. Returns the entries and when the last part ended.
 */
function runParts(jobs: readonly Job[], lanes: number, from: number, entries: Entry[], firstCall: number): { readonly end: number, readonly calls: number } {
  const free = Array.from<number>({ length: lanes }).fill(from)
  const placed: Placed[] = []
  const ends: Array<{ readonly job: Job, readonly at: number }> = []
  for (const job of jobs) {
    const lane = free.indexOf(Math.min(...free))
    let at = free[lane]
    for (const step of job.steps) {
      placed.push({
        job,
        step,
        start: at,
        end: at + step.ms,
      })
      at += step.ms
    }
    free[lane] = at
    ends.push({ job, at })
  }
  const numbered = [...placed].sort((a, b) => a.start - b.start)
  let seq = entries.length
  const push = (at: number, rank: number, event: QuorumEvent): void => {
    entries.push({ at, event, rank, seq: seq++ })
  }
  numbered.forEach(({ job, step, start, end }, order) => {
    const call = firstCall + order
    const part = {
      index: job.index,
      count: job.count,
      ...step.piece === undefined
        ? {}
        : { piece: step.piece },
    }
    const usage = researchUsage(job.index)
    const spent = step.failure === undefined
      ? total(usage)
      : 0
    push(start, STARTS, {
      type: 'call:start',
      call,
      profile: job.profile,
      role: 'research',
      provider: API,
      part,
      reserved: RESERVED,
      timeoutMs: TIMEOUT_MS,
    })
    if (step.retry !== undefined) {
      push(start + step.retry.afterMs, RETRIES, {
        type: 'call:retry',
        call,
        attempt: 1,
        retries: 2,
        failure: step.retry.failure,
        waitMs: step.retry.waitMs,
      })
    }
    push(end, ENDS, {
      type: 'call',
      call,
      profile: job.profile,
      role: 'research',
      provider: API,
      part,
      durationMs: step.ms,
      ok: step.failure === undefined,
      ...step.retry === undefined
        ? {}
        : { attempts: 2 },
      ...step.failure === undefined
        ? { usage, listed: step.listed ?? 0 }
        : {},
      spent,
    })
  })
  for (const { job, at } of ends) {
    const first = placed.find(call => call.job === job)!
    if (job.recovered !== undefined) {
      push(at, ENDS, {
        type: 'recovered',
        profile: job.profile,
        part: job.index,
        parts: job.count,
        noAnswer: 'reply',
        limit: 16_000,
        thinkingLowered: false,
        pieces: job.recovered.pieces,
        read: job.recovered.read,
        unreadHunks: 0,
        unreadFiles: 0,
      })
    }
    const read = job.steps.filter(step => step.failure === undefined)
    const failure = job.steps.find(step => step.failure !== undefined)?.failure
    const listed = read.reduce((sum, step) => sum + (step.listed ?? 0), 0)
    push(at, ENDS, {
      type: 'part',
      profile: job.profile,
      part: { index: job.index, count: job.count },
      outcome: job.outcome ?? 'reviewed',
      durationMs: at - first.start,
      spent: read.length * total(researchUsage(job.index)),
      ...listed === 0
        ? {}
        : { listed },
      ...failure === undefined
        ? {}
        : { failure },
      ...job.recovered === undefined
        ? {}
        : {
            pieces: { count: job.recovered.pieces, read: job.recovered.read, unread: {} },
          },
    })
    if (job.outcome === 'research-failed' || job.outcome === 'provider-down') {
      push(at, ENDS, {
        type: 'incomplete',
        entry: { profile: job.profile, reason: job.outcome, detail: `part ${job.index} of ${job.count} was not read` },
      })
    }
  }
  return {
    end: Math.max(...ends.map(({ at }) => at)),
    calls: numbered.length,
  }
}

/** The events in the order they arrived: by time, a call's end before its retry before a start, then as written. */
function ordered(entries: readonly Entry[]): Timed[] {
  return [...entries]
    .sort((a, b) => a.at - b.at || a.rank - b.rank || a.seq - b.seq)
    .map(({ at, event }) => ({ at, event }))
}

function started(profiles: readonly string[]): Timed {
  return {
    at: 0,
    event: {
      type: 'run:start',
      profiles: [...profiles],
      providers: Object.fromEntries(profiles.map(id => [
        id,
        {
          research: API,
          lenses: Object.fromEntries(LENSES.map(lens => [lens, API])),
        },
      ])),
    },
  }
}

/** A part answered in `ms`, listing a finding when its number is a multiple of 4. */
function answered(profile: string, index: number, count: number, ms: number): Job {
  return {
    profile,
    index,
    count,
    steps: [
      {
        ms,
        listed: index % 4 === 0
          ? 1
          : 0,
      },
    ],
  }
}

/** The 18 votes of a panel of 6 findings by 3 lenses, four at once from `from`, and the verdicts they decide; returns when the last vote ended. */
function runPanel(profile: string, from: number, firstCall: number, entries: Entry[]): number {
  const free = Array.from<number>({ length: 4 }).fill(from)
  let seq = entries.length
  let call = firstCall
  let last = from
  for (let finding = 1; finding <= 6; finding++) {
    let decided = from
    for (const lens of LENSES) {
      const lane = free.indexOf(Math.min(...free))
      const start = free[lane]
      const ms = 85_000 + (call % 4) * 5000
      const end = start + ms
      free[lane] = end
      const id = `finding-${finding}`
      const number = call++
      entries.push({
        at: start,
        rank: STARTS,
        seq: seq++,
        event: {
          type: 'call:start',
          call: number,
          profile,
          role: 'vote',
          lens,
          provider: API,
          finding: id,
          reserved: VOTE_RESERVED,
          timeoutMs: TIMEOUT_MS,
        },
      })
      entries.push({
        at: end,
        rank: ENDS,
        seq: seq++,
        event: {
          type: 'call',
          call: number,
          profile,
          role: 'vote',
          lens,
          provider: API,
          finding: id,
          durationMs: ms,
          ok: true,
          usage: { inputTokens: 5000, outputTokens: 300 },
          spent: 5300,
        },
      })
      entries.push({
        at: end,
        rank: ENDS,
        seq: seq++,
        event: {
          type: 'vote',
          profile,
          findingId: id,
          lens,
          keep: finding <= 4,
        },
      })
      decided = Math.max(decided, end)
      last = Math.max(last, end)
    }
    entries.push({
      at: decided,
      rank: ENDS,
      seq: seq++,
      event: {
        type: 'verdict',
        profile,
        findingId: `finding-${finding}`,
        keptVotes: finding <= 4
          ? 3
          : 0,
        totalVotes: 3,
        ...finding <= 4
          ? { confidence: 'high' as const }
          : {},
        status: finding <= 4
          ? 'kept'
          : 'discarded',
      },
    })
  }
  return last
}

/**
 * A review of 44 research parts, four calls at once, on provider `api`, then a panel of 6 findings by 3 lenses.
 * Each part is answered in 100 to 180 s and lists one finding in every fourth; part 7's first attempt fails with an
 * `http 503` after 428 s, which puts its call in a wait at the tenth minute; part 9 is cut off and recovered into 2
 * pieces, both read; part 12 fails with a `timeout` after 2 attempts. The review ends at 2 285 000 ms.
 */
export function longReview(): Timed[] {
  const entries: Entry[] = [
    {
      ...started(['security']),
      rank: ENDS,
      seq: 0,
    },
  ]
  const count = 44
  const jobs: Job[] = Array.from({ length: count }, (_, at) => {
    const index = at + 1
    const ms = index <= 8
      ? 150_000 + (index * 37 % 4) * 10_000
      : 100_000 + (index * 37 % 5) * 10_000
    if (index === 7) {
      return {
        profile: 'security',
        index,
        count,
        steps: [
          {
            ms: 428_000 + 3600 + 60_000,
            retry: {
              afterMs: 428_000,
              failure: { kind: 'http', status: 503 },
              waitMs: 3600,
            },
          },
        ],
      }
    }
    if (index === 9) {
      return {
        profile: 'security',
        index,
        count,
        recovered: { pieces: 2, read: 2 },
        steps: [
          { ms: 50_000 },
          {
            ms: 55_000,
            piece: { index: 1, count: 2 },
          },
          {
            ms: 60_000,
            piece: { index: 2, count: 2 },
          },
        ],
      }
    }
    if (index === 12) {
      return {
        profile: 'security',
        index,
        count,
        outcome: 'research-failed',
        steps: [
          {
            ms: 2 * TIMEOUT_MS + 2000,
            retry: {
              afterMs: TIMEOUT_MS,
              failure: { kind: 'timeout' },
              waitMs: 2000,
            },
            failure: { kind: 'timeout' },
          },
        ],
      }
    }
    return answered('security', index, count, ms)
  })
  entries.push({
    at: 0,
    rank: ENDS,
    seq: 1,
    event: {
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: count,
    },
  })
  const { end, calls } = runParts(jobs, 4, 0, entries, 1)
  let seq = entries.length
  const add = (at: number, event: QuorumEvent): void => {
    entries.push({ at, rank: ENDS, seq: seq++, event })
  }
  add(end, {
    type: 'stage:end',
    profile: 'security',
    stage: 'research',
    durationMs: end,
    count: 10,
  })
  add(end, { type: 'stage:start', profile: 'security', stage: 'dedup' })
  add(end, {
    type: 'stage:end',
    profile: 'security',
    stage: 'dedup',
    durationMs: 0,
    count: 6,
  })
  add(end, {
    type: 'stage:start',
    profile: 'security',
    stage: 'panel',
    votes: 18,
  })
  const last = runPanel('security', end, calls + 1, entries)
  add(last, {
    type: 'stage:end',
    profile: 'security',
    stage: 'panel',
    durationMs: last - end,
    count: 6,
  })
  add(2_285_000, {
    type: 'run:end',
    kept: 4,
    discarded: 2,
    unreviewed: 0,
    incomplete: 1,
    durationMs: 2_285_000,
  })
  return ordered(entries)
}

/** Two profiles, `security` and `style`, on one provider `api` and one limit of four calls at once, 10 parts each, interleaved. */
export function twoProfiles(): Timed[] {
  const entries: Entry[] = [
    {
      ...started(['security', 'style']),
      rank: ENDS,
      seq: 0,
    },
  ]
  const jobs: Job[] = []
  for (let index = 1; index <= 10; index++) {
    for (const profile of ['security', 'style']) jobs.push(answered(profile, index, 10, 100_000 + ((index + profile.length) % 4) * 20_000))
  }
  entries.push({
    at: 0,
    rank: ENDS,
    seq: 1,
    event: {
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 10,
    },
  })
  entries.push({
    at: 0,
    rank: ENDS,
    seq: 2,
    event: {
      type: 'stage:start',
      profile: 'style',
      stage: 'research',
      parts: 10,
    },
  })
  const { end } = runParts(jobs, 4, 0, entries, 1)
  const add = (event: QuorumEvent): void => {
    entries.push({
      at: end,
      rank: ENDS,
      seq: entries.length,
      event,
    })
  }
  for (const profile of ['security', 'style']) {
    add({
      type: 'stage:end',
      profile,
      stage: 'research',
      durationMs: end,
      count: 0,
    })
  }
  add({
    type: 'run:end',
    kept: 0,
    discarded: 0,
    unreviewed: 0,
    incomplete: 0,
    durationMs: end,
  })
  return ordered(entries)
}

/**
 * A provider that fails: three calls in a row end with an `http 503` after their retries, the provider is found down,
 * and the parts left are not sent. Six parts, three calls at once.
 */
export function providerDown(): Timed[] {
  const entries: Entry[] = [
    {
      ...started(['security']),
      rank: ENDS,
      seq: 0,
    },
  ]
  const failing = (index: number): Job => ({
    profile: 'security',
    index,
    count: 6,
    outcome: 'research-failed',
    steps: [
      {
        ms: 9000,
        retry: {
          afterMs: 3000,
          failure: { kind: 'http', status: 503 },
          waitMs: 3000,
        },
        failure: { kind: 'http', status: 503 },
      },
    ],
  })
  const jobs = [1, 2, 3].map(failing)
  entries.push({
    at: 0,
    rank: ENDS,
    seq: 1,
    event: {
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 6,
    },
  })
  const { end } = runParts(jobs, 3, 0, entries, 1)
  const add = (event: QuorumEvent): void => {
    entries.push({
      at: end,
      rank: ENDS,
      seq: entries.length,
      event,
    })
  }
  add({
    type: 'provider-down',
    provider: 'api',
    kind: 'http',
    status: 503,
    calls: 3,
  })
  for (const index of [4, 5, 6]) {
    add({
      type: 'part',
      profile: 'security',
      part: { index, count: 6 },
      outcome: 'provider-down',
      durationMs: 0,
      spent: 0,
    })
    add({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'provider-down', detail: `part ${index} of 6 was not sent` },
    })
  }
  add({
    type: 'stage:end',
    profile: 'security',
    stage: 'research',
    durationMs: end,
    count: 0,
  })
  add({
    type: 'run:end',
    kept: 0,
    discarded: 0,
    unreviewed: 0,
    incomplete: 6,
    durationMs: end,
  })
  return ordered(entries)
}

/** The state after the events of `events` that arrived at or before `until`, each folded at its own time, from `facts`. */
export function replay(events: readonly Timed[], until = Infinity, facts: ViewFacts = DEFAULT_FACTS): ViewState {
  let state = startState(facts)
  for (const { at, event } of events) {
    if (at > until) break
    state = fold(state, event, at)
  }
  return state
}
