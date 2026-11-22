import { describe, expect, it } from 'vitest'
import type { ConcurrencyRecord } from '../../core/lanes.ts'
import type { IncompleteReason, QuorumEvent, StageName } from '../../core/types.ts'
import type { ReportView } from '../../report/view.ts'
import { longReview, replay } from '../../testing/events.ts'
import { reportResult, SQL, TOKEN } from '../../testing/report.ts'
import { DEFAULT_FACTS, fold, startState } from './model.ts'
import type { ViewState } from './model.ts'
import { rerunCouldFill, summaryLines } from './summary.ts'
import type { SummaryFacts } from './writer.ts'

const ESC = String.fromCharCode(0x1B)

/** Where the report went: stdout a pipe carrying JSON, no file, and a result of 38m05s and 2 412 833 tokens in. */
function factsOf(changes: Partial<SummaryFacts> = {}): SummaryFacts {
  return {
    stdout: { format: 'json', terminal: false },
    stderr: { terminal: false },
    outputs: [],
    state: { kind: 'none', kept: 0 },
    result: reportResult({
      unreviewed: [],
      meta: {
        durationMs: 2_285_000,
        usage: { inputTokens: 2_412_833, outputTokens: 312_094 },
      },
    }),
    ...changes,
  }
}

function lines(state: ViewState, facts: SummaryFacts = factsOf(), view: ReportView = 'full'): string[] {
  return summaryLines(state, facts, view, '-')
}

/** A review whose research started, which folded `events` after. */
function reviewed(...events: QuorumEvent[]): ViewState {
  const first: QuorumEvent[] = [
    {
      type: 'run:start',
      profiles: ['security'],
      providers: {
        security: {
          research: { id: 'api', model: 'm' },
          lenses: {},
        },
      },
    },
    {
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 2,
    },
  ]
  return [
    ...first,
    ...events,
  ].reduce((state, event) => fold(state, event, 1000), startState(DEFAULT_FACTS))
}

/** The detail the core writes for a gap of `reason`, counting `count` research parts for the three reasons that count them. */
function detailOf(reason: IncompleteReason, count: number): string {
  switch (reason) {
    case 'research-failed':
      return `${count} of 51 research parts failed: the research call failed (http 503)`
    case 'provider-down':
      return `${count} of 51 research parts were not sent, since their provider was down`
    case 'request-too-large':
      return `${count} of 51 research requests were not sent: a detail`
    default:
      return 'a detail'
  }
}

function incomplete(reason: IncompleteReason, count = 1, profile = 'security'): QuorumEvent {
  return {
    type: 'incomplete',
    entry: {
      profile,
      reason,
      detail: detailOf(reason, count),
    },
  }
}

function failedPart(index: number, failure?: { kind: 'http' | 'timeout' | 'network', status?: number, exhausted?: true, cutAfterMs?: number, refused?: 'stream', stalledMs?: number }): QuorumEvent {
  return {
    type: 'part',
    profile: 'security',
    part: { index, count: 2 },
    outcome: 'research-failed',
    durationMs: 5,
    spent: 0,
    ...failure === undefined
      ? {}
      : { failure },
  }
}

describe('summaryLines', () => {
  it('writes the time of each stage, the profiles\' together, and the first estimate beside research', () => {
    const state = replay(longReview())
    // Research spans 0 to 1 811 600 ms, dedup nothing, the panel 1 811 600 to 2 271 600 ms. The first estimate was read
    // 310 000 ms in, put 1 455 000 to 1 545 937 ms more: research at 1 765 000 to 1 855 937 ms, 30 to 31 minutes.
    expect(lines(state)[0]).toBe('time: research 30m12s, dedup 0.0s, panel 7m40s; the first estimate, 5m10s in, put research at 30-31m; done in 38m05s, 2412833 tokens in and 312094 out')
    expect(lines(state, factsOf({
      stdout: { format: 'text', terminal: true },
      stderr: { terminal: true },
    }))[0]).toBe('time: research 30m12s, dedup 0.0s, panel 7m40s; the first estimate, 5m10s in, put research at 30-31m')
    // A stage that has not ended has no time, and a review that made no estimate has none to compare.
    expect(lines(replay(longReview(), 100_000)).some(line => line.startsWith('time:'))).toBe(false)
    expect(lines(reviewed({
      type: 'stage:end',
      profile: 'security',
      stage: 'research',
      durationMs: 4,
      count: 0,
    }), factsOf({
      stdout: { format: 'text', terminal: true },
      stderr: { terminal: true },
    }))[0]).toBe('time: research 0.0s')
  })

  it.each([
    [
      'this review\'s estimated worst case',
      'estimate',
      9_864_619,
      'this review\'s estimated worst case',
    ],
    [
      'the default, which holds this review\'s estimated worst case',
      'floor',
      2_000_000,
      'the default, which holds this review\'s estimated worst case',
    ],
  ] as const)('names a cap that is %s', (_name, origin, tokens, words) => {
    const state = replay(longReview())
    const derived = {
      ...state,
      spent: 1_000_000,
      facts: {
        ...state.facts,
        cap: { tokens, origin },
      },
    }
    expect(lines(derived)[1]).toBe(`tokens: ${Math.floor(1_000_000 * 100 / tokens)} percent of the cap of ${tokens}, ${words}`)
  })

  it('writes the share of the cap spent and where the cap came from, and each provider\'s usage when several answered', () => {
    const state = replay(longReview())
    expect(lines(state)[1]).toBe('tokens: 74 percent of the cap of 2000000, the default')

    const set = {
      ...state,
      spent: 240_000,
      facts: {
        ...state.facts,
        cap: { tokens: 2_000_000, origin: 'config' as const },
      },
    }
    expect(lines(set)[1]).toBe('tokens: 12 percent of the cap of 2000000, maxReviewTokens')

    const several = {
      ...state,
      usage: new Map([
        [
          'api',
          { inputTokens: 200_000, outputTokens: 40_000 },
        ],
        [
          'local',
          { inputTokens: 1000, outputTokens: 200 },
        ],
      ]),
    }
    expect(lines(several)[1]).toBe('tokens: 74 percent of the cap of 2000000, the default; api 200000 in and 40000 out, local 1000 in and 200 out')
  })

  it('leaves the tokens line out under the public view, and a used-up quota\'s words with it', () => {
    const state = replay(longReview())
    const shown = lines(state, factsOf(), 'public')
    expect(shown.some(line => line.startsWith('tokens:'))).toBe(false)
    expect(shown[0]).toBe('time: research 30m12s, dedup 0.0s, panel 7m40s; the first estimate, 5m10s in, put research at 30-31m; done in 38m05s')

    const quota = reviewed(failedPart(1, { kind: 'http', status: 429, exhausted: true }), incomplete('research-failed'))
    expect(lines(quota).at(-2)).toBe('gaps: 1 part(s) research-failed (http 429): add credit or raise the limit at the provider, or wait until it resets')
    // A stranger is not told the account is out of money: the public view shows the cause and no fix, and every other gap keeps its fix.
    expect(lines(quota, factsOf(), 'public').at(-2)).toBe('gaps: 1 part(s) research-failed (http 429)')
    const mixed = reviewed(failedPart(1, { kind: 'timeout' }), failedPart(2, { kind: 'http', status: 429, exhausted: true }), incomplete('research-failed'), incomplete('token-cap'))
    expect(lines(mixed, factsOf(), 'public').at(-2)).toBe('gaps: 1 part(s) research-failed (timeout, http 429): raise timeoutMs; 1 gap(s) token-cap: raise maxReviewTokens')
  })

  it('writes the time of each stage as the time some profile was in it, with several profiles', () => {
    // Two profiles' research ends at 100 s and 1000 s, each then dedups for 50 ms and runs a panel of 60 s.
    const stage = (profile: string, type: 'stage:start' | 'stage:end', name: StageName): QuorumEvent => type === 'stage:start'
      ? { type, profile, stage: name }
      : {
          type,
          profile,
          stage: name,
          durationMs: 0,
          count: 0,
        }
    const at = (...entries: Array<[number, QuorumEvent]>): ViewState => entries.reduce((state, [time, event]) => fold(state, event, time), startState(DEFAULT_FACTS))
    const state = at(
      [
        0,
        {
          type: 'run:start',
          profiles: ['security', 'style'],
          providers: {
            security: {
              research: { id: 'api', model: 'm' },
              lenses: {},
            },
            style: {
              research: { id: 'api', model: 'm' },
              lenses: {},
            },
          },
        },
      ],
      [
        0,
        stage('security', 'stage:start', 'research'),
      ],
      [
        0,
        stage('style', 'stage:start', 'research'),
      ],
      [
        100_000,
        stage('security', 'stage:end', 'research'),
      ],
      [
        100_000,
        stage('security', 'stage:start', 'dedup'),
      ],
      [
        100_050,
        stage('security', 'stage:end', 'dedup'),
      ],
      [
        100_050,
        stage('security', 'stage:start', 'panel'),
      ],
      [
        160_050,
        stage('security', 'stage:end', 'panel'),
      ],
      [
        1_000_000,
        stage('style', 'stage:end', 'research'),
      ],
      [
        1_000_000,
        stage('style', 'stage:start', 'dedup'),
      ],
      [
        1_000_050,
        stage('style', 'stage:end', 'dedup'),
      ],
      [
        1_000_050,
        stage('style', 'stage:start', 'panel'),
      ],
      [
        1_060_050,
        stage('style', 'stage:end', 'panel'),
      ],
    )
    expect(lines(state, factsOf({
      stdout: { format: 'text', terminal: true },
      stderr: { terminal: true },
    }))[0]).toBe('time: research 16m40s, dedup 0.1s, panel 2m00s')
  })

  it('never says 100 percent of a cap that was not reached', () => {
    const state = replay(longReview())
    const spent = (tokens: number): string => lines({ ...state, spent: tokens })[1]
    expect(spent(1_992_000)).toBe('tokens: 99 percent of the cap of 2000000, the default')
    expect(spent(1_999_999)).toBe('tokens: 99 percent of the cap of 2000000, the default')
    expect(spent(2_000_000)).toBe('tokens: 100 percent of the cap of 2000000, the default')
    expect(spent(580_000)).toBe('tokens: 29 percent of the cap of 2000000, the default')
  })

  it('writes the calls: research and votes, retried and recovered, leaving out what is 0, and no limit while no lane has a record', () => {
    const state = replay(longReview())
    expect(lines(state)[2]).toBe('calls: 46 research (2 retried, 1 recovered into 2 pieces), 18 vote(s)')

    const one = {
      ...state,
      made: { research: 1, votes: 3 },
      retried: { research: 0, votes: 0 },
      recovered: { parts: 0, pieces: 0 },
    }
    expect(lines(one)[2]).toBe('calls: 1 research, 3 vote(s)')

    const votes = {
      ...one,
      made: { research: 0, votes: 3 },
      retried: { research: 0, votes: 2 },
    }
    expect(lines(votes)[2]).toBe('calls: 3 vote(s) (2 retried)')

    const none = {
      ...one,
      made: { research: 0, votes: 0 },
    }
    expect(lines(none).some(line => line.startsWith('calls:'))).toBe(false)
  })

  it('names each provider\'s longest first token and silence', () => {
    const answered = (call: number, provider: string, firstTokenMs: number, longestSilenceMs: number, role: 'research' | 'vote' = 'research'): QuorumEvent => ({
      type: 'call',
      call,
      profile: 'security',
      role,
      provider: { id: provider, model: 'm' },
      durationMs: 1000,
      ok: true,
      usage: { inputTokens: 1, outputTokens: 1 },
      spent: 2,
      firstTokenMs,
      longestSilenceMs,
    })
    const state = reviewed(
      answered(1, 'api', 2000, 220_000),
      answered(2, 'api', 190_000, 9000),
      answered(3, 'api', 500, 500),
      answered(4, 'api', 400, 400, 'vote'),
      answered(5, 'api', 300, 300, 'vote'),
      answered(6, 'api', 200, 200, 'vote'),
      answered(7, 'api', 100, 100, 'vote'),
      answered(8, 'api', 100, 100, 'vote'),
      answered(9, 'api', 100, 100, 'vote'),
    )
    const calls = (of: ViewState): string | undefined => lines(of).find(line => line.startsWith('calls:'))
    expect(calls(state)).toBe('calls: 3 research, 6 vote(s); api\'s longest first token 3m10s, its longest silence 3m40s')
    // a provider with no timing has no clause, and each one that has gets its own, in the order they answered
    const two = fold(state, answered(10, 'second', 1500, 800), 2000)
    expect(calls(two)).toBe('calls: 4 research, 6 vote(s); api\'s longest first token 3m10s, its longest silence 3m40s; second\'s longest first token 1.5s, its longest silence 0.8s')
    expect(calls(replay(longReview()))).toBe('calls: 46 research (2 retried, 1 recovered into 2 pieces), 18 vote(s)')
  })

  describe('the lanes in the calls line', () => {
    const answered = (call: number, provider: string, firstTokenMs: number, longestSilenceMs: number, role: 'research' | 'vote' = 'research'): QuorumEvent => ({
      type: 'call',
      call,
      profile: 'security',
      role,
      provider: { id: provider, model: 'm' },
      durationMs: 1000,
      ok: true,
      usage: { inputTokens: 1, outputTokens: 1 },
      spent: 2,
      firstTokenMs,
      longestSilenceMs,
    })
    const record = (limit: 'auto' | number, start: number, lowest: number, highest: number, cuts: number, headers: boolean): ConcurrencyRecord => ({
      limit,
      start,
      lowest,
      highest,
      cuts,
      headers,
    })
    /** A review whose api answered streamed calls, one of them 3m10s to its first token. */
    const timed = (): ViewState => reviewed(answered(1, 'api', 190_000, 220_000), answered(2, 'api', 2000, 9000))
    /** The summary's calls line of a review of 44 research parts and 42 votes, whose result holds `concurrency`. */
    const callsOf = (concurrency: Record<string, ConcurrencyRecord> | undefined, state: ViewState = timed()): string | undefined => {
      const facts = factsOf({
        result: reportResult({
          unreviewed: [],
          meta: {
            durationMs: 2_285_000,
            ...concurrency === undefined
              ? {}
              : { concurrency },
          },
        }),
      })
      return lines({
        ...state,
        made: { research: 44, votes: 42 },
        retried: { research: 0, votes: 0 },
      }, facts).find(line => line.startsWith('calls:'))
    }

    it('gives each provider\'s range, then its own longest first token and silence', () => {
      expect(callsOf({
        api: record('auto', 4, 2, 4, 1, true),
      })).toBe('calls: 44 research, 42 vote(s); api ran 2 to 4 at once; its longest first token 3m10s, its longest silence 3m40s')
      // one number when the lane did not move, and a provider with no timing has only its range
      expect(callsOf({
        api: record('auto', 4, 8, 8, 0, true),
      }, reviewed())).toBe('calls: 44 research, 42 vote(s); api ran 8 at once')
      // a provider the lanes know and no call timed, and one the timings know and no lane does
      expect(callsOf({
        api: record('auto', 4, 4, 9, 0, true),
        other: record('auto', 4, 4, 4, 0, true),
      })).toBe('calls: 44 research, 42 vote(s); api ran 4 to 9 at once; its longest first token 3m10s, its longest silence 3m40s; other ran 4 at once')
      expect(callsOf({
        other: record('auto', 4, 4, 6, 0, true),
      })).toBe('calls: 44 research, 42 vote(s); other ran 4 to 6 at once; api\'s longest first token 3m10s, its longest silence 3m40s')
    })

    it('says how far a provider\'s slowest stream grew its deadline', () => {
      const grown = (call: number, ceilingMs?: number): QuorumEvent => ({
        ...answered(call, 'api', 5000, 100_000),
        ...ceilingMs === undefined
          ? {}
          : { ceilingMs },
      })
      const slow = reviewed(grown(1, 1_000_000), grown(2, 2_522_880), grown(3), grown(4, 600_001))
      expect(callsOf({
        api: record('auto', 4, 2, 4, 1, true),
      }, slow)).toBe('calls: 44 research, 42 vote(s); api ran 2 to 4 at once; its longest first token 5.0s, its longest silence 1m40s; its slowest stream grew its deadline to 42m03s')
      // with concurrency set, or no lane record, the provider is named
      const set = {
        ...slow,
        facts: { ...DEFAULT_FACTS, concurrency: 8 },
      }
      expect(callsOf({
        api: record(8, 8, 8, 8, 0, false),
      }, set)).toBe('calls: 44 research, 42 vote(s); 8 at once; api\'s longest first token 5.0s, its longest silence 1m40s; api\'s slowest stream grew its deadline to 42m03s')
      // a provider whose calls grew no deadline has no such clause
      expect(callsOf({
        api: record('auto', 4, 2, 4, 1, true),
      }, reviewed(grown(1), grown(2)))).toBe('calls: 44 research, 42 vote(s); api ran 2 to 4 at once; its longest first token 5.0s, its longest silence 1m40s')
    })

    it('says a lane that stayed at its start sent no rate-limit headers, with the setting that runs more', () => {
      expect(callsOf({
        api: record('auto', 4, 4, 4, 0, false),
      })).toBe('calls: 44 research, 42 vote(s); api sent no rate-limit headers, so it ran at most 4 at once: set concurrency to run more, if its gateway has room; its longest first token 3m10s, its longest silence 3m40s')
      // a lane that grew had headers, and one cut by a throttle is not told to run more
      expect(callsOf({
        api: record('auto', 4, 4, 6, 0, false),
      }, reviewed())).toBe('calls: 44 research, 42 vote(s); api ran 4 to 6 at once')
      expect(callsOf({
        api: record('auto', 4, 2, 4, 1, false),
      }, reviewed())).toBe('calls: 44 research, 42 vote(s); api ran 2 to 4 at once')
      // a lane that stayed at 4 and had headers has nothing to say of them
      expect(callsOf({
        api: record('auto', 4, 4, 4, 0, true),
      }, reviewed())).toBe('calls: 44 research, 42 vote(s); api ran 4 at once')
    })

    it('says the calls at once as concurrency set them, for every provider together', () => {
      const set = {
        ...timed(),
        facts: { ...DEFAULT_FACTS, concurrency: 8 },
      }
      expect(callsOf({
        api: record(8, 8, 8, 8, 0, false),
      }, set)).toBe('calls: 44 research, 42 vote(s); 8 at once; api\'s longest first token 3m10s, its longest silence 3m40s')
      // whatever the result holds
      expect(callsOf(undefined, set)).toBe('calls: 44 research, 42 vote(s); 8 at once; api\'s longest first token 3m10s, its longest silence 3m40s')
    })

    it('writes no clause of the calls at once while no lane has a record, and the timings in their own form', () => {
      expect(callsOf(undefined)).toBe('calls: 44 research, 42 vote(s); api\'s longest first token 3m10s, its longest silence 3m40s')
    })

    it('makes a provider\'s id inert, in the public view too', () => {
      const hostile = `a${String.fromCharCode(0x202E)}b`
      const facts = factsOf({
        result: reportResult({
          unreviewed: [],
          meta: {
            durationMs: 1,
            concurrency: {
              [hostile]: record('auto', 4, 4, 4, 0, false),
            },
          },
        }),
      })
      const state = {
        ...timed(),
        made: { research: 1, votes: 0 },
      }
      expect(lines(state, facts, 'public').find(line => line.startsWith('calls:'))).toBe(`calls: 1 research; a<U+202E>b sent no rate-limit headers, so it ran at most 4 at once: set concurrency to run more, if its gateway has room; api's longest first token 3m10s, its longest silence 3m40s`)
    })
  })

  it.each<[string, QuorumEvent[], string]>([
    [
      'token-cap',
      [
        incomplete('token-cap'),
      ],
      '1 gap(s) token-cap: raise maxReviewTokens',
    ],
    [
      'review-deadline',
      [
        incomplete('review-deadline'),
      ],
      '1 gap(s) review-deadline: raise reviewTimeoutMs',
    ],
    [
      'research-failed (timeout)',
      [
        failedPart(1, { kind: 'timeout' }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (timeout): raise timeoutMs',
    ],
    [
      'research-failed of two causes',
      [
        failedPart(1, { kind: 'timeout' }),
        failedPart(2, { kind: 'http', status: 503 }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (timeout, http 503): raise timeoutMs, or lower concurrency or wait',
    ],
    [
      'research-failed with no cause',
      [
        failedPart(1),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed: see the gap in the report',
    ],
    [
      'research-failed of a used-up quota',
      [
        failedPart(1, { kind: 'http', status: 429, exhausted: true }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (http 429): add credit or raise the limit at the provider, or wait until it resets',
    ],
    [
      'provider-down of a used-up quota',
      [
        {
          type: 'provider-down',
          provider: 'api',
          kind: 'http',
          status: 429,
          calls: 1,
          exhausted: true,
        },
        incomplete('provider-down'),
      ],
      '1 part(s) provider-down (http 429): add credit or raise the limit at the provider, or wait until it resets',
    ],
    [
      'provider-down (network)',
      [
        {
          type: 'provider-down',
          provider: 'api',
          kind: 'network',
          calls: 3,
        },
        incomplete('provider-down'),
      ],
      '1 part(s) provider-down (network): check that the server at its origin is running',
    ],
    [
      'research-failed of a cut',
      [
        failedPart(1, { kind: 'network', cutAfterMs: 600_000 }),
        failedPart(2, { kind: 'network', cutAfterMs: 601_000 }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (network): make replies shorter, with a lower maxTokens or partTokens',
    ],
    [
      'research-failed of a cut and a failure at once',
      [
        failedPart(1, { kind: 'network', cutAfterMs: 600_000 }),
        failedPart(2, { kind: 'network' }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (network): make replies shorter, with a lower maxTokens or partTokens, or check that the server at its origin is running',
    ],
    [
      'research-failed of a stall',
      [
        failedPart(1, { kind: 'timeout', stalledMs: 300_000 }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (timeout, stalled): raise stallTimeoutMs, or timeoutMs',
    ],
    [
      'research-failed of a stall and a plain timeout',
      [
        failedPart(1, { kind: 'timeout', stalledMs: 300_000 }),
        failedPart(2, { kind: 'timeout' }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (timeout, stalled): raise stallTimeoutMs, or timeoutMs',
    ],
    [
      'provider-down of stalls',
      [
        {
          type: 'provider-down',
          provider: 'api',
          kind: 'timeout',
          calls: 3,
          stalledMs: 300_000,
        },
        incomplete('provider-down'),
      ],
      '1 part(s) provider-down (timeout, stalled): raise stallTimeoutMs, or timeoutMs',
    ],
    [
      'research-failed of a refused stream',
      [
        failedPart(1, { kind: 'http', status: 400, refused: 'stream' }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (http 400): set stream: false',
    ],
    [
      'research-failed of a refused stream and a plain 400',
      [
        failedPart(1, { kind: 'http', status: 400, refused: 'stream' }),
        failedPart(2, { kind: 'http', status: 400 }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (http 400): set stream: false, or check the provider\'s settings',
    ],
    [
      'provider-down of a refused stream',
      [
        {
          type: 'provider-down',
          provider: 'api',
          kind: 'http',
          status: 422,
          calls: 3,
          refused: 'stream',
        },
        incomplete('provider-down'),
      ],
      '1 part(s) provider-down (http 422): set stream: false',
    ],
    [
      'provider-down of a cut',
      [
        {
          type: 'provider-down',
          provider: 'api',
          kind: 'network',
          calls: 3,
          cutAfterMs: 600_000,
        },
        incomplete('provider-down'),
      ],
      '1 part(s) provider-down (network): make replies shorter, with a lower maxTokens or partTokens',
    ],
    [
      'research-failed of a fast network failure',
      [
        failedPart(1, { kind: 'network' }),
        incomplete('research-failed'),
      ],
      '1 part(s) research-failed (network): check that the server at its origin is running',
    ],
    [
      'research-failed and provider-down of a run that lost 46 of 51 parts',
      [
        failedPart(1, { kind: 'network' }),
        {
          type: 'provider-down',
          provider: 'api',
          kind: 'network',
          calls: 3,
        },
        incomplete('research-failed', 5),
        incomplete('provider-down', 41),
      ],
      '5 part(s) research-failed (network): check that the server at its origin is running; 41 part(s) provider-down (network): check that the server at its origin is running',
    ],
    [
      'research-failed of two profiles, summed',
      [
        failedPart(1, { kind: 'timeout' }),
        incomplete('research-failed', 5),
        incomplete('research-failed', 2, 'style'),
      ],
      '7 part(s) research-failed (timeout): raise timeoutMs',
    ],
    [
      'vote-failed, counting votes',
      [
        {
          type: 'incomplete',
          entry: { profile: 'security', reason: 'vote-failed', detail: `${JSON.stringify('a.js')}:3 is kept at medium, but 2 failed vote(s) could have made it undecided` },
        },
        {
          type: 'incomplete',
          entry: { profile: 'security', reason: 'vote-failed', detail: `${JSON.stringify('b.js')}:9 is kept at low, but 1 failed vote(s) could have made it undecided` },
        },
      ],
      '3 vote(s) vote-failed: see resume',
    ],
    [
      'vote-failed of one finding',
      [
        {
          type: 'incomplete',
          entry: { profile: 'security', reason: 'vote-failed', detail: `${JSON.stringify('a.js')}:3 is kept at medium, but 1 failed vote(s) could have made it undecided` },
        },
      ],
      '1 vote(s) vote-failed: see resume',
    ],
    [
      'interrupted, counting its parts and votes',
      [
        {
          type: 'incomplete',
          entry: { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 5 of its 6 research parts and 3 vote(s)' },
        },
      ],
      '5 part(s) and 3 vote(s) interrupted: see resume',
    ],
    [
      'interrupted, of words it does not know',
      [
        {
          type: 'incomplete',
          entry: { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 5 of its 6 research parts and some' },
        },
      ],
      '1 gap(s) interrupted: see resume',
    ],
    [
      'token-cap, counting its parts and votes',
      [
        {
          type: 'incomplete',
          entry: { profile: 'security', reason: 'token-cap', detail: 'the review\'s token cap of 2000000 tokens stopped 4 of its 6 research parts and 7 vote(s)' },
        },
      ],
      '4 part(s) and 7 vote(s) token-cap: raise maxReviewTokens',
    ],
    [
      'review-deadline, counting its research',
      [
        {
          type: 'incomplete',
          entry: { profile: 'security', reason: 'review-deadline', detail: 'the review\'s deadline of 1800000 ms stopped its research' },
        },
      ],
      '1 part(s) review-deadline: raise reviewTimeoutMs',
    ],
    [
      'request-too-large of parts, votes and an entry that counts neither',
      [
        incomplete('request-too-large', 3),
        {
          type: 'incomplete',
          entry: { profile: 'security', reason: 'request-too-large', detail: `${JSON.stringify('a.js')}:3: 2 of 3 vote requests were not sent: refused` },
        },
        {
          type: 'incomplete',
          entry: { profile: 'style', reason: 'request-too-large', detail: 'the research request was not sent: refused' },
        },
      ],
      '3 part(s) and 2 vote(s) and 1 gap(s) request-too-large: raise contextTokens, or lower partTokens',
    ],
    [
      'reply-cut-off',
      [
        incomplete('reply-cut-off'),
      ],
      '1 gap(s) reply-cut-off: raise maxTokens, set thinking: low, or lower partTokens',
    ],
    [
      'reply-cut-off after a cut was learned',
      [
        {
          type: 'cut',
          provider: 'api',
          afterMs: 900_000,
          holds: 36_000,
          lowered: false,
        },
        incomplete('reply-cut-off'),
      ],
      '1 gap(s) reply-cut-off: make replies shorter, with a lower maxTokens or partTokens',
    ],
    [
      'findings-capped',
      [
        incomplete('findings-capped'),
      ],
      '1 gap(s) findings-capped: raise maxFindings',
    ],
    [
      'request-too-large',
      [
        incomplete('request-too-large'),
      ],
      '1 part(s) request-too-large: raise contextTokens, or lower partTokens',
    ],
    [
      'binary',
      [
        incomplete('binary'),
      ],
      '1 gap(s) binary',
    ],
  ])('writes a %s gap with its fix', (_name, events, entry) => {
    expect(lines(reviewed(...events))).toContain(`gaps: ${entry}`)
  })

  it('names the cut\'s advice for a reply-cut-off gap of a provider that learned its cut, and the limit\'s fix for one that did not', () => {
    const run: QuorumEvent = {
      type: 'run:start',
      profiles: ['security', 'style'],
      providers: {
        security: {
          research: { id: 'api', model: 'm' },
          lenses: {},
        },
        style: {
          research: { id: 'local', model: 'm' },
          lenses: {},
        },
      },
    }
    const cut: QuorumEvent = {
      type: 'cut',
      provider: 'api',
      afterMs: 900_000,
      holds: 36_000,
      lowered: false,
    }
    const research: QuorumEvent = {
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 2,
    }
    const after = (...events: QuorumEvent[]): string[] => lines([run, research, cut, ...events].reduce((state, event) => fold(state, event, 1000), startState(DEFAULT_FACTS)))
    expect(after(incomplete('reply-cut-off', 1, 'security'), incomplete('reply-cut-off', 1, 'style'))).toContain('gaps: 2 gap(s) reply-cut-off: make replies shorter, with a lower maxTokens or partTokens (api), or raise maxTokens, set thinking: low, or lower partTokens (local)')
    expect(after(incomplete('reply-cut-off', 1, 'style'))).toContain('gaps: 1 gap(s) reply-cut-off: raise maxTokens, set thinking: low, or lower partTokens')
    expect(after(incomplete('reply-cut-off', 1, 'style'), incomplete('reply-cut-off', 1, 'security'))).toContain('gaps: 2 gap(s) reply-cut-off: raise maxTokens, set thinking: low, or lower partTokens (local), or make replies shorter, with a lower maxTokens or partTokens (api)')
    const localCut: QuorumEvent = { ...cut, provider: 'local' }
    const both = lines([
      run,
      research,
      cut,
      localCut,
      incomplete('reply-cut-off', 1, 'security'),
      incomplete('reply-cut-off', 1, 'style'),
    ].reduce((state, event) => fold(state, event, 1000), startState(DEFAULT_FACTS)))
    expect(both).toContain('gaps: 2 gap(s) reply-cut-off: make replies shorter, with a lower maxTokens or partTokens')
  })

  it('writes the ids of a reply-cut-off gap\'s providers inertly', () => {
    const escaped = `api${String.fromCharCode(27)}[31m`
    const run: QuorumEvent = {
      type: 'run:start',
      profiles: ['security', 'style'],
      providers: {
        security: {
          research: { id: escaped, model: 'm' },
          lenses: {},
        },
        style: {
          research: { id: 'local', model: 'm' },
          lenses: {},
        },
      },
    }
    const cut: QuorumEvent = {
      type: 'cut',
      provider: escaped,
      afterMs: 900_000,
      holds: 36_000,
      lowered: false,
    }
    const research: QuorumEvent = {
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 2,
    }
    const shown = lines([
      run,
      research,
      cut,
      incomplete('reply-cut-off', 1, 'security'),
      incomplete('reply-cut-off', 1, 'style'),
    ].reduce((state, event) => fold(state, event, 1000), startState(DEFAULT_FACTS))).join('\n')
    expect(shown).toContain('(api')
    expect(shown).toContain('(local)')
    expect(shown).not.toContain(ESC)
  })

  it.each<[string, Partial<Pick<SummaryFacts, 'state'>> & { readonly reason?: IncompleteReason, readonly unreviewed?: boolean }, string | undefined]>([
    [
      'naming --state and its kept calls after an interrupt',
      {
        reason: 'interrupted',
        state: { kind: 'flag', kept: 43 },
      },
      'resume: rerun with the same --state: its 43 answered call(s) are kept, and the rerun reuses each one whose request is unchanged',
    ],
    [
      'naming --state when it kept none',
      {
        reason: 'interrupted',
        state: { kind: 'flag', kept: 0 },
      },
      'resume: rerun with the same --state: its 0 answered call(s) are kept, and the rerun reuses each one whose request is unchanged',
    ],
    [
      'asking for --state when the review ran with none',
      {
        reason: 'interrupted',
        state: { kind: 'none', kept: 0 },
      },
      'resume: to keep the answered calls for a rerun, pass --state <dir>; this review kept none',
    ],
    [
      'after a research-failed gap, naming the same command for the default directory',
      {
        reason: 'research-failed',
        state: { kind: 'default', kept: 1 },
      },
      'resume: rerun the same command: its 1 answered call(s) are kept, and the rerun reuses each one whose request is unchanged',
    ],
    [
      'after an unreviewed finding',
      { unreviewed: true },
      'resume: to keep the answered calls for a rerun, pass --state <dir>; this review kept none',
    ],
    [
      'nowhere when nothing is left for a rerun',
      {
        reason: 'binary',
        state: { kind: 'flag', kept: 43 },
      },
      undefined,
    ],
  ])('writes the resume line %s', (_name, { reason, unreviewed = false, state = { kind: 'none', kept: 0 } }, expected) => {
    const result = reportResult({
      unreviewed: unreviewed
        ? undefined
        : [],
      meta: {
        incomplete: reason === undefined
          ? []
          : [
              { profile: 'security', reason, detail: 'a detail' },
            ],
      },
    })
    expect(rerunCouldFill(result)).toBe(expected !== undefined)
    const shown = lines(replay(longReview()), factsOf({ result, state }))
    // the resume line is the last, after the line that says where the report went, whatever the view
    expect(shown.filter(line => line.startsWith('resume:'))).toEqual(expected === undefined
      ? []
      : [expected])
    if (expected !== undefined) expect(shown.at(-1)).toBe(expected)
    expect(lines(replay(longReview()), factsOf({ result, state }), 'public').filter(line => line.startsWith('resume:'))).toEqual(expected === undefined
      ? []
      : [expected])
  })

  it('writes where the report went: above, on stdout in its format and view, and the --output formats, never a path', () => {
    const state = reviewed()
    const terminal = factsOf({
      stdout: { format: 'text', terminal: true },
      stderr: { terminal: true },
    })
    expect(lines(state, terminal).at(-1)).toBe('result: the text report above')
    // Stderr in a log, with stdout a terminal: nothing is above the summary, so the report is said to be on stdout.
    expect(lines(state, {
      ...terminal,
      stderr: { terminal: false },
    }).at(-1)).toBe('result: text on stdout')
    expect(lines(state, {
      ...terminal,
      stderr: { terminal: false },
    }, 'public').at(-1)).toBe('result: text on stdout (public view)')
    expect(lines(state, {
      ...terminal,
      outputs: ['json'],
      stderr: { terminal: false },
    }).at(-1)).toBe('result: text on stdout; --output json written')
    expect(lines(state, factsOf({
      stdout: { format: 'json', terminal: true },
    })).at(-1)).toBe('result: json on stdout')
    expect(lines(state, factsOf({
      stdout: { format: 'text', terminal: false },
    })).at(-1)).toBe('result: text on stdout')
    expect(lines(state, factsOf(), 'public').at(-1)).toBe('result: json on stdout (public view)')
    expect(lines(state, terminal, 'public').at(-1)).toBe('result: the text report above (public view)')
    expect(lines(state, {
      ...terminal,
      outputs: ['json', 'sarif', 'brief'],
    }).at(-1)).toBe('result: the text report above; --output json, sarif and brief written')
    expect(lines(state, {
      ...terminal,
      outputs: ['json', 'sarif'],
    }).at(-1)).toBe('result: the text report above; --output json and sarif written')
    expect(lines(state, {
      ...terminal,
      outputs: ['json'],
    }).at(-1)).toBe('result: the text report above; --output json written')
  })

  it('adds the totals to the time line when stderr is a log beside a terminal\'s text report', () => {
    const state = reviewed({
      type: 'stage:end',
      profile: 'security',
      stage: 'research',
      durationMs: 4,
      count: 0,
    })
    const text = { format: 'text' as const, terminal: true }
    // `quorum --path src 2> run.log`: the report is on the terminal, and nothing is above the log's lines.
    expect(lines(state, factsOf({
      stdout: text,
      stderr: { terminal: false },
    }))[0]).toBe('time: research 0.0s; done in 38m05s, 2412833 tokens in and 312094 out')
    expect(lines(state, factsOf({
      stdout: text,
      stderr: { terminal: false },
    }), 'public')[0]).toBe('time: research 0.0s; done in 38m05s')
    expect(lines(state, factsOf({
      stdout: text,
      stderr: { terminal: true },
    }))[0]).toBe('time: research 0.0s')
  })

  it('adds the totals to the time line only when stdout carries no text report', () => {
    const state = reviewed({
      type: 'stage:end',
      profile: 'security',
      stage: 'research',
      durationMs: 4,
      count: 0,
    })
    expect(lines(state)[0]).toBe('time: research 0.0s; done in 38m05s, 2412833 tokens in and 312094 out')
    expect(lines(state, factsOf(), 'public')[0]).toBe('time: research 0.0s; done in 38m05s')
    expect(lines(state, factsOf({
      stdout: { format: 'text', terminal: false },
    }))[0]).toBe('time: research 0.0s; done in 38m05s, 2412833 tokens in and 312094 out')
    expect(lines(state, factsOf({
      stdout: { format: 'text', terminal: true },
      stderr: { terminal: true },
    }))[0]).toBe('time: research 0.0s')
    const unused = factsOf({
      result: reportResult({
        meta: { durationMs: 2_285_000, usage: undefined },
      }),
    })
    expect(lines(state, unused)[0]).toBe('time: research 0.0s; done in 38m05s')
  })

  it('repeats no line of the report: no finding, no verdict, no gap\'s detail', () => {
    const state = replay(longReview())
    const result = reportResult({
      meta: { durationMs: 2_285_000 },
    })
    const shown = lines(state, factsOf({ result })).filter(line => !line.startsWith('resume:')).join('\n')
    for (const text of [
      'part 12 of 44 was not read',
      SQL.summary,
      SQL.file,
      TOKEN.summary,
      result.meta.incomplete[0].detail,
      result.meta.profiles.security.coverage[0].file,
      'kept',
      'discarded',
      'unreviewed',
    ]) {
      expect(shown).not.toContain(text)
    }
    expect(shown).toContain('gaps: 1 part(s) research-failed (timeout): raise timeoutMs')
    // The gaps come in the order they were first seen, once each.
    const seen = reviewed(incomplete('binary'), incomplete('token-cap'), incomplete('binary'))
    expect(lines(seen)).toContain('gaps: 2 gap(s) binary; 1 gap(s) token-cap: raise maxReviewTokens')
  })

  it('writes every line inert', () => {
    const state = replay(longReview())
    const hostile = {
      ...state,
      usage: new Map([
        [
          `api${ESC}[2J`,
          { inputTokens: 1, outputTokens: 2 },
        ],
        [
          'local',
          { inputTokens: 3, outputTokens: 4 },
        ],
      ]),
    }
    const shown = lines(hostile)
    expect(shown[1]).toBe('tokens: 74 percent of the cap of 2000000, the default; api<U+001B>[2J 1 in and 2 out, local 3 in and 4 out')
    for (const line of shown) expect(line).not.toContain(ESC)
  })

  it('writes no summary for a review that ran no stage', () => {
    expect(lines(startState(DEFAULT_FACTS))).toEqual([])
    const empty = [
      {
        type: 'run:start',
        profiles: ['security'],
        providers: {
          security: {
            research: { id: 'api', model: 'm' },
            lenses: {},
          },
        },
      },
      {
        type: 'run:end',
        kept: 0,
        discarded: 0,
        unreviewed: 0,
        incomplete: 0,
        durationMs: 3,
      },
    ] satisfies QuorumEvent[]
    expect(lines(empty.reduce((state, event) => fold(state, event, 0), startState(DEFAULT_FACTS)))).toEqual([])
  })
})
