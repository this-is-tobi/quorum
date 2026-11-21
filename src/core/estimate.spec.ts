import { describe, expect, it } from 'vitest'
import { securityProfile } from '../profiles/security.ts'
import { splitDiff } from './diff.ts'
import { ConfigError } from './errors.ts'
import type { CompletionRequest, Provider, QuorumPorts } from './ports.ts'
import { researchRequest, voteRequest } from './prompts.ts'
import { createQuorum } from './quorum.ts'
import { requestTokens } from './tokens.ts'
import type { Estimate, Finding, Profile, Quorum, QuorumEvent } from './types.ts'

/** What a provider keeps over a request's own bound: 512 tokens for the chat template and 16000 for the reply, which the providers here state as an attempt's worst case. */
const RESERVE = 512 + 16_000

const sum = (numbers: readonly number[]): number => numbers.reduce((total, number) => total + number, 0)

/** A provider that states a window, and no usage: the room a request leaves it, and what one attempt of it may cost. */
function windowed(window: number, answer: (request: CompletionRequest) => string): Provider & { readonly requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  return {
    id: 'windowed',
    model: 'windowed-model',
    requests,
    room: request => window - (requestTokens(request) + RESERVE),
    worstCase: request => requestTokens(request) + RESERVE,
    async complete(request) {
      requests.push(request)
      return {
        text: answer(request),
        model: 'windowed-model',
      }
    },
  }
}

/** A provider that states nothing about its window and what an attempt costs: `worstCase` is its own, when it has one. */
function silent(worstCase?: (request: CompletionRequest) => number): Provider {
  return {
    id: 'silent',
    model: 'silent-model',
    ...worstCase === undefined
      ? {}
      : { worstCase },
    async complete() {
      return { text: '{"findings":[]}', model: 'silent-model' }
    },
  }
}

/** One provider for the research and for every lens of the profile. */
function portsFor(profile: Profile, provider: Provider, events?: (event: QuorumEvent) => void): QuorumPorts {
  return {
    profiles: {
      [profile.id]: {
        research: provider,
        voters: Object.fromEntries(profile.lenses.map(lens => [lens.id, provider])),
      },
    },
    ...events === undefined
      ? {}
      : { events },
  }
}

/** A file added whole, in hunks of 50 lines as the all-added writer cuts one, each line some 50 bytes. */
function addedFile(name: string, lines: number): string {
  const hunks: string[] = []
  for (let first = 1; first <= lines; first += 50) {
    const count = Math.min(50, lines - first + 1)
    hunks.push(
      `@@ -0,0 +${first},${count} @@`,
      ...Array.from({ length: count }, (_, index) => `+export const value${first + index} = compute(${first + index}) // ${name}`),
    )
  }
  return [
    `diff --git a/${name} b/${name}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${name}`,
    ...hunks,
  ].join('\n')
}

/** Four files of 300, 40, 700 and 5 lines: a diff of some 55 KB. */
const DIFF = [
  addedFile('a.js', 300),
  addedFile('b.js', 40),
  addedFile('c.js', 700),
  addedFile('d.js', 5),
].join('\n')

const FINDINGS = JSON.stringify({
  findings: [
    {
      file: 'a.js',
      line: 1,
      category: 'CWE-78',
      quote: 'compute(1)',
      summary: 'command injection',
    },
    {
      file: 'c.js',
      line: 350,
      category: 'CWE-89',
      quote: 'compute(350)',
      summary: 'sql injection',
    },
    {
      file: 'd.js',
      line: 5,
      category: 'CWE-22',
      quote: 'compute(5)',
      summary: 'path traversal',
    },
  ],
})

const KEEP = JSON.stringify({ keep: true, reasoning: 'r' })

/** The review of `DIFF` with every voter keeping what research reports once, and its events. */
async function reviewed(window: number): Promise<{ quorum: Quorum, events: QuorumEvent[] }> {
  const events: QuorumEvent[] = []
  let researched = 0
  const finder = windowed(window, (request) => {
    if (request.output.name === 'panel_vote') return KEEP
    researched += 1
    return researched === 1
      ? FINDINGS
      : '{"findings":[]}'
  })
  const quorum = createQuorum({
    profiles: [securityProfile],
    concurrency: 1,
  }, portsFor(securityProfile, finder, event => events.push(event)))
  await quorum.review({ diff: DIFF })
  return { quorum, events }
}

describe('estimate', () => {
  it.each([
    [32_768, 4],
    [200_000, 2],
  ])('states each research part as the review reserves it, and bounds every vote, at a window of %i', async (window, parts) => {
    const { quorum, events } = await reviewed(window)
    const estimate = quorum.estimate({ diff: DIFF })
    const { security } = estimate.profiles
    const calls = events.filter(event => event.type === 'call')
    const research = calls.filter(call => call.role === 'research')
    const votes = calls.filter(call => call.role === 'vote')

    expect(security.parts).toHaveLength(parts)
    expect(research.map(call => call.spent)).toEqual(security.parts)
    // Three findings, each voted by the three lenses: a vote is as large as its section lets it be, and no larger than its lens's bound.
    expect(votes).toHaveLength(9)
    for (const call of votes) expect(call.spent).toBeLessThanOrEqual(security.vote[call.lens ?? ''])
    expect(sum(calls.map(call => call.spent))).toBeLessThanOrEqual(estimate.worst)
  })

  it('builds each request at the reply budget and the findings its provider\'s window gives, as the review does, so each reservation is the one the review takes', async () => {
    const asked: CompletionRequest[] = []
    const reserve = (request: CompletionRequest): number => requestTokens(request) + 512 + (request.replyTokens ?? 16_000)
    const events: QuorumEvent[] = []
    const finder: Provider & { readonly requests: CompletionRequest[] } = {
      ...windowed(32_768, request => request.output.name === 'panel_vote'
        ? KEEP
        : '{"findings":[]}'),
      window: 32_768,
      worstCase: (request) => {
        asked.push(request)
        return reserve(request)
      },
      room: request => 32_768 - reserve(request),
    }
    const quorum = createQuorum({
      profiles: [securityProfile],
      concurrency: 1,
    }, portsFor(securityProfile, finder, event => events.push(event)))
    const estimate = quorum.estimate({ diff: DIFF })
    const research = asked.filter(request => request.output.name === 'research_findings')
    const votes = asked.filter(request => request.output.name === 'panel_vote')
    // A window of 32768 gives research 8192 tokens and 15 findings, and a vote the 8192 a quarter of the window holds.
    expect(research.length).toBeGreaterThan(1)
    expect(research.map(request => [
      request.replyTokens,
      request.system.includes('List at most 15 findings,'),
    ])).toEqual(research.map(() => [8192, true]))
    expect(votes.length).toBeGreaterThan(0)
    expect(new Set(votes.map(request => request.replyTokens))).toEqual(new Set([8192]))
    await quorum.review({ diff: DIFF })
    expect(events.filter(event => event.type === 'call').map(call => call.spent)).toEqual(estimate.profiles.security.parts)
  })

  it('counts the research parts at a third of their bound, rounded up, and the votes in the worst case only', () => {
    const finder = windowed(32_768, () => '{"findings":[]}')
    const quorum = createQuorum({
      profiles: [securityProfile],
      maxFindings: 7,
    }, portsFor(securityProfile, finder))
    const estimate = quorum.estimate({ diff: DIFF })
    const { security } = estimate.profiles

    expect(security.parts.length).toBeGreaterThan(1)
    expect(Object.keys(security.vote)).toEqual(['reachability', 'impact', 'defenses'])
    expect(security.votes).toBe(7 * 3)
    expect(security.expected).toBe(sum(security.parts.map(part => Math.ceil(part / 3))))
    expect(security.worst).toBe(sum(security.parts) + 7 * sum(Object.values(security.vote)))
    expect(estimate.expected).toBe(security.expected)
    expect(estimate.worst).toBe(security.worst)
    expect(finder.requests).toEqual([])
  })

  it('estimates a blank diff, and one whose every file is excluded, as no call', () => {
    const finder = windowed(32_768, () => '{"findings":[]}')
    const none: Estimate = {
      profiles: {
        security: {
          parts: [],
          votes: 0,
          vote: {},
          expected: 0,
          worst: 0,
        },
      },
      expected: 0,
      worst: 0,
      inFlight: 0,
      maxReviewTokens: 2_000_000,
      reviewTimeoutMs: 1_800_000,
      fits: true,
    }
    const quorum = createQuorum({
      profiles: [securityProfile],
    }, portsFor(securityProfile, finder))
    expect(quorum.estimate({ diff: '' })).toEqual(none)
    expect(quorum.estimate({ diff: '  \n' })).toEqual(none)
    const excluding = createQuorum({
      profiles: [securityProfile],
      exclude: ['*.js'],
    }, portsFor(securityProfile, finder))
    expect(excluding.estimate({ diff: DIFF })).toEqual(none)
    expect(finder.requests).toEqual([])
  })

  it('reserves the concurrency largest bounds as what is in flight at once', () => {
    const lone: Profile = {
      id: 'lone',
      prompts: { research: 'Find bugs.', vote: 'Judge as {{lens.id}}.' },
      lenses: [
        { id: 'only', question: 'Is it real?' },
      ],
      policy: { high: 'unanimous', medium: 'off', low: 'off' },
    }
    const other: Profile = { ...lone, id: 'other' }
    const inFlight = (profiles: Profile[], concurrency: number): number => createQuorum({ profiles, concurrency, maxFindings: 3 }, {
      profiles: Object.fromEntries(profiles.map(profile => [
        profile.id,
        {
          research: silent(() => 10),
          voters: {
            only: silent(() => 50),
          },
        },
      ])),
    }).estimate({
      diff: addedFile('a.js', 3),
    }).inFlight

    // One research part of 10, and one lens's vote of 50 counted three times, as three findings may be voted at once.
    expect(inFlight([lone], 1)).toBe(50)
    expect(inFlight([lone], 3)).toBe(150)
    expect(inFlight([lone], 4)).toBe(160)
    expect(inFlight([lone], 100)).toBe(160)
    // The limit is the review's, so the profiles share it.
    expect(inFlight([lone, other], 4)).toBe(200)
    expect(inFlight([lone, other], 100)).toBe(320)
  })

  it('takes the largest section for a voter that states no room, and fills the room of one whose room it exceeds', () => {
    const style: Profile = {
      id: 'style',
      prompts: { research: 'Find style issues.', vote: 'Judge as {{lens.id}}.' },
      lenses: [
        { id: 'free', question: 'Is it real?' },
        { id: 'roomy', question: 'Is it real?' },
        { id: 'tight', question: 'Is it real?' },
      ],
      policy: { high: 'unanimous', medium: 'off', low: 'off' },
    }
    const diff = [
      addedFile('small.js', 3),
      addedFile('big.js', 200),
    ].join('\n')
    const big = splitDiff(diff).get('big.js') ?? ''
    const quorum = createQuorum({
      profiles: [style],
    }, {
      profiles: {
        style: {
          research: silent(),
          voters: {
            free: silent(request => requestTokens(request) + RESERVE),
            roomy: windowed(200_000, () => KEEP),
            tight: windowed(25_000, () => KEEP),
          },
        },
      },
    })
    const cited: Finding = {
      id: 'finding',
      fingerprint: 'a1b2c3d4e5f60718:1',
      profile: 'style',
      file: 'big.js',
      line: Number.MAX_SAFE_INTEGER,
      category: 'x'.repeat(80),
      summary: 'x'.repeat(500),
      evidence: 'x'.repeat(2000),
      quoteMatched: true,
    }
    const whole = (lens: string): number => requestTokens(voteRequest(`Judge as ${lens}.`, cited, big)) + RESERVE
    const { vote } = quorum.estimate({ diff }).profiles.style

    // The finding at the caps with the largest section in full: a voter with no room, and one whose room holds it.
    expect(vote.free).toBe(whole('free'))
    expect(vote.roomy).toBe(whole('roomy'))
    // The section exceeds the room of `tight`, so its vote is the partial request filled to that room: the window it states.
    expect(vote.tight).toBe(25_000)
    expect(vote.tight).toBeLessThan(whole('tight'))
  })

  it('reads the whole diff as one part for a research provider that states no room', () => {
    const quorum = createQuorum({
      profiles: [securityProfile],
    }, portsFor(securityProfile, silent(request => requestTokens(request) + RESERVE)))
    const { parts } = quorum.estimate({ diff: DIFF }).profiles.security
    expect(parts).toEqual([requestTokens(researchRequest(securityProfile.prompts.research, DIFF)) + RESERVE])
  })

  it('estimates the diff less its held files, and counts a file the input sends', () => {
    const quorum = createQuorum({
      profiles: [securityProfile],
    }, portsFor(securityProfile, silent(request => requestTokens(request) + RESERVE)))
    const whole = `${addedFile('.env', 40)}\n${DIFF}`
    const reservation = (diff: string): number => requestTokens(researchRequest(securityProfile.prompts.research, diff)) + RESERVE
    expect(quorum.estimate({ diff: whole }).profiles.security.parts).toEqual([
      reservation(DIFF),
    ])
    expect(quorum.estimate({ diff: whole })).toEqual(quorum.estimate({ diff: DIFF }))
    expect(quorum.estimate({
      diff: whole,
      send: ['.env'],
    }).profiles.security.parts).toEqual([
      reservation(whole),
    ])
    expect(quorum.estimate({
      diff: whole,
      send: ['./.env'],
    }).profiles.security.parts).toEqual([
      reservation(DIFF),
    ])
  })

  it('fits exactly when the expected spend and what is in flight are at most the cap', () => {
    const finder = windowed(32_768, () => '{"findings":[]}')
    const estimateAt = (maxReviewTokens: number): Estimate => createQuorum({
      profiles: [securityProfile],
      maxReviewTokens,
    }, portsFor(securityProfile, finder)).estimate({ diff: DIFF })
    const { expected, inFlight } = estimateAt(2_000_000)
    expect(expected).toBeGreaterThan(0)
    expect(inFlight).toBeGreaterThan(0)

    expect(estimateAt(expected + inFlight)).toMatchObject({ fits: true, maxReviewTokens: expected + inFlight })
    expect(estimateAt(expected + inFlight - 1)).toMatchObject({ fits: false, maxReviewTokens: expected + inFlight - 1 })
  })

  it('refuses an input a review would refuse, as a ConfigError', () => {
    const quorum = createQuorum({
      profiles: [securityProfile],
    }, portsFor(securityProfile, silent()))
    for (const input of [
      'diff text',
      { diff: 5 },
      undefined,
    ]) {
      expect(() => quorum.estimate(input as unknown as { diff: string })).toThrow(ConfigError)
    }
    expect(() => quorum.estimate({ diff: 5 } as unknown as { diff: string })).toThrow('diff: must be a string')
    expect(() => quorum.estimate('diff text' as unknown as { diff: string })).toThrow('input: must be an object holding the diff string')
  })
})
