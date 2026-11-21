import { describe, expect, it } from 'vitest'
import { securityProfile } from '../profiles/security.ts'
import { splitDiff } from './diff.ts'
import { ConfigError } from './errors.ts'
import type { CompletionRequest, Provider, QuorumPorts } from './ports.ts'
import { researchRequest, voteRequest } from './prompts.ts'
import { createQuorum } from './quorum.ts'
import { requestTokens, tokenBound } from './tokens.ts'
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

  it('counts the research parts at a third of their input and a reply at its usual size, and the votes in the worst case only', () => {
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
    // A provider that states no window nor maxTokens is reserved the 16000 tokens of the core's own reply budget.
    expect(security.expected).toBe(sum(security.parts.map(part => Math.ceil((part - 16_000) / 3) + 4096)))
    expect(security.worst).toBeGreaterThan(sum(security.parts) + 7 * sum(Object.values(security.vote)))
    expect(estimate.expected).toBe(security.expected)
    expect(estimate.worst).toBeGreaterThanOrEqual(security.worst)
    expect(finder.requests).toEqual([])
  })

  it('expects a research reply at the lesser of its budget and 4096, not a third of maxTokens', () => {
    const diff = Array.from({ length: 8 }, (_, index) => addedFile(`f${index}.js`, 120)).join('\n')
    const reserve = (request: CompletionRequest): number => requestTokens(request) + 512 + (request.replyTokens ?? 16_000)
    const expectedOf = (parts: readonly number[], reply: number): number => sum(parts.map(part => Math.ceil((part - reply) / 3) + Math.min(reply, 4096)))
    const estimateFor = (provider: Provider): Estimate => createQuorum({
      profiles: [securityProfile],
      partTokens: 10_000,
    }, portsFor(securityProfile, provider)).estimate({ diff })

    for (const maxTokens of [100_000, 2000]) {
      const finder: Provider = {
        ...windowed(240_000, () => '{"findings":[]}'),
        window: 240_000,
        maxTokens,
        worstCase: reserve,
        room: request => 240_000 - reserve(request),
      }
      const { parts, expected } = estimateFor(finder).profiles.security
      expect(parts).toHaveLength(8)
      // Each part's input at a third, and its reply at the lesser of its budget and 4096: a larger maxTokens is headroom.
      expect(expected).toBe(expectedOf(parts, maxTokens))
      if (maxTokens === 100_000) expect(expected).toBeLessThan(sum(parts.map(part => Math.ceil(part / 3))))
    }
    // With nothing stated to size a reply by, the reply is the core's 16000.
    const silentFinder = silent(reserve)
    const alone = estimateFor(silentFinder).profiles.security
    expect(alone.expected).toBe(expectedOf(alone.parts, 16_000))
  })

  it('counts recovery\'s bound for each part, and concurrency of each provider\'s largest reservations for each of its two settings, in worst', () => {
    /** What recovery may spend beyond a part's own reservation: each of three depths holds the diff once, and its 14 pieces repeat one header and the part's fixed text each, with what a piece's position adds. */
    const recoveryBound = (reservation: number, d: number, h: number, extra: number): number => 3 * d + 14 * h + 14 * (reservation - d + extra)
    const headerOf = (section: string): number => tokenBound(section.slice(0, section.indexOf('@@') - 1)) + 1
    const topSum = (bounds: readonly number[], count: number): number => sum([...bounds].sort((a, b) => b - a).slice(0, count))
    const lone: Profile = {
      id: 'lone',
      prompts: { research: 'Find bugs.', vote: 'Judge as {{lens.id}}.' },
      lenses: [
        { id: 'only', question: 'Is it real?' },
      ],
      policy: { high: 'unanimous', medium: 'off', low: 'off' },
    }
    const reserve = (request: CompletionRequest): number => requestTokens(request) + RESERVE
    const ports = (research: Provider, voter: Provider): QuorumPorts => ({
      profiles: {
        lone: {
          research,
          voters: { only: voter },
        },
      },
    })

    // A research of one request: the part is the whole diff, and a piece adds a parts block with a position line alone.
    const small = addedFile('a.js', 3)
    const ask = { findings: 3 }
    const oneRequest = researchRequest('Find bugs.', '', undefined, undefined, ask)
    const asPiece = researchRequest('Find bugs.', '', undefined, {
      piece: { index: 8, count: 8 },
      files: [],
      unlisted: 0,
    }, ask)
    const pieceExtra = requestTokens(asPiece) - requestTokens(oneRequest)
    expect(pieceExtra).toBeGreaterThan(0)
    const researcher: Provider = {
      ...silent(reserve),
      adapts: { thinking: 'low', prompt: true },
    }
    const voter: Provider = {
      ...silent(reserve),
      adapts: { prompt: true },
    }
    const single = createQuorum({
      profiles: [lone],
      maxFindings: 3,
      concurrency: 2,
    }, ports(researcher, voter)).estimate({ diff: small })
    const [reservation] = single.profiles.lone.parts
    const vote = single.profiles.lone.vote.only
    const d = tokenBound(small)
    const bound = recoveryBound(reservation, d, headerOf(small), pieceExtra)
    // The profile counts the part, its recovery and its three votes; the review adds each provider's calls sent once more: the researcher's two settings over its one call (as a piece, its position included), the voter's one over two of its three votes.
    expect(single.profiles.lone.worst).toBe(reservation + bound + 3 * vote)
    expect(single.worst).toBe(single.profiles.lone.worst + 2 * topSum([reservation + pieceExtra], 2) + topSum([vote, vote, vote], 2))

    // A provider that states no adapts sends no probe: nothing is added.
    const plain = createQuorum({
      profiles: [lone],
      maxFindings: 3,
      concurrency: 2,
    }, ports(silent(reserve), silent(reserve))).estimate({ diff: small })
    expect(plain.worst).toBe(plain.profiles.lone.worst)

    // A research in parts, one file to a part: each part's own diff, header and position (the parts block lists the files).
    const files = ['f1.js', 'f2.js', 'f3.js']
    const diff = files.map(name => addedFile(name, 100)).join('\n')
    const sections = files.map(name => splitDiff(diff).get(name) ?? '')
    const partTokens = tokenBound(sections[0]) + 100
    const solo: Provider = {
      ...windowed(200_000, () => '{"findings":[]}'),
      adapts: { thinking: 'low' },
    }
    const profile = securityProfile
    const packed = createQuorum({
      profiles: [profile],
      partTokens,
      concurrency: 2,
    }, portsFor(profile, solo)).estimate({ diff })
    const { security } = packed.profiles
    expect(security.parts).toHaveLength(3)
    const asked = { findings: 50 }
    const instructions = profile.prompts.research
    const partOf = {
      index: 1,
      count: 3,
      files,
      unlisted: 0,
    }
    const partExtra = requestTokens(researchRequest(instructions, '', undefined, {
      ...partOf,
      piece: { index: 8, count: 8 },
    }, asked)) - requestTokens(researchRequest(instructions, '', undefined, partOf, asked))
    expect(partExtra).toBeGreaterThan(0)
    const recovery = sum(security.parts.map((part, index) => part + recoveryBound(part, tokenBound(sections[index]), headerOf(sections[index]), partExtra)))
    expect(security.worst).toBe(recovery + 50 * sum(Object.values(security.vote)))
    // One setting over the two largest of the provider's calls, whether research parts or the votes each lens may cast.
    const calls = [
      ...security.parts.map(part => part + partExtra),
      ...Object.values(security.vote).flatMap(bound => Array.from<number>({ length: 50 }).fill(bound)),
    ]
    expect(packed.worst).toBe(security.worst + topSum(calls, 2))
  })

  it('counts a provider object that serves research and votes once in the adaptations\' bound', () => {
    const lone: Profile = {
      id: 'lone',
      prompts: { research: 'Find bugs.', vote: 'Judge as {{lens.id}}.' },
      lenses: [
        { id: 'only', question: 'Is it real?' },
      ],
      policy: { high: 'unanimous', medium: 'off', low: 'off' },
    }
    const reserve = (request: CompletionRequest): number => requestTokens(request) + RESERVE
    const topSum = (bounds: readonly number[], count: number): number => sum([...bounds].sort((a, b) => b - a).slice(0, count))
    const small = addedFile('a.js', 3)
    const pieceExtra = requestTokens(researchRequest('Find bugs.', '', undefined, {
      piece: { index: 8, count: 8 },
      files: [],
      unlisted: 0,
    }, { findings: 3 })) - requestTokens(researchRequest('Find bugs.', '', undefined, undefined, { findings: 3 }))
    const adapts = { thinking: 'low' as const, prompt: true as const }
    const options = {
      profiles: [lone],
      maxFindings: 3,
      concurrency: 2,
    }
    // The owner's own configuration: one provider object is the research and every voter.
    const one: Provider = {
      ...silent(reserve),
      adapts,
    }
    const shared = createQuorum(options, portsFor(lone, one)).estimate({ diff: small })
    const [reservation] = shared.profiles.lone.parts
    const vote = shared.profiles.lone.vote.only
    // Its two settings count once over its research part (as a piece) and its three votes together, `concurrency` of the largest in all.
    expect(shared.worst).toBe(shared.profiles.lone.worst + 2 * topSum([
      reservation + pieceExtra,
      vote,
      vote,
      vote,
    ], 2))
    // Two objects of the same states, as two providers would be, each count their own calls: more than the one object does.
    const separate = createQuorum(options, {
      profiles: {
        lone: {
          research: {
            ...silent(reserve),
            adapts,
          },
          voters: {
            only: {
              ...silent(reserve),
              adapts,
            },
          },
        },
      },
    }).estimate({ diff: small })
    expect(separate.worst).toBe(separate.profiles.lone.worst + 2 * topSum([reservation + pieceExtra], 2) + 2 * topSum([vote, vote, vote], 2))
    expect(separate.worst).toBeGreaterThan(shared.worst)
  })

  it('states the N each profile\'s research asks for, and its provider', () => {
    const profile = (id: string): Profile => ({
      id,
      prompts: { research: 'Find bugs.', vote: 'Judge as {{lens.id}}.' },
      lenses: [
        { id: 'only', question: 'Is it real?' },
      ],
      policy: { high: 'unanimous', medium: 'off', low: 'off' },
    })
    const small: Provider = {
      ...windowed(32_768, () => '{"findings":[]}'),
      window: 32_768,
    }
    const estimate = createQuorum({
      profiles: [
        profile('tight'),
        profile('free'),
      ],
    }, {
      profiles: {
        tight: {
          research: small,
          voters: { only: small },
        },
        free: {
          research: silent(),
          voters: {
            only: silent(),
          },
        },
      },
    }).estimate({
      diff: addedFile('a.js', 3),
    })

    // A window of 32768 gives research 8192 tokens and 15 findings; a provider that states none asks for maxFindings.
    expect(estimate.maxFindings).toBe(50)
    expect(estimate.profiles.tight).toMatchObject({ findings: 15, provider: 'windowed' })
    expect(estimate.profiles.free).toMatchObject({ findings: 50, provider: 'silent' })
  })

  it('keeps fits to expected and inFlight within the cap', () => {
    const diff = Array.from({ length: 8 }, (_, index) => addedFile(`f${index}.js`, 120)).join('\n')
    const reserve = (request: CompletionRequest): number => requestTokens(request) + 512 + (request.replyTokens ?? 16_000)
    const finder: Provider = {
      ...windowed(240_000, () => '{"findings":[]}'),
      window: 240_000,
      maxTokens: 100_000,
      worstCase: reserve,
      room: request => 240_000 - reserve(request),
      adapts: { thinking: 'low', prompt: true },
    }
    const estimateAt = (maxReviewTokens: number): Estimate => createQuorum({
      profiles: [securityProfile],
      partTokens: 10_000,
      maxReviewTokens,
    }, portsFor(securityProfile, finder)).estimate({ diff })
    const { expected, inFlight, worst } = estimateAt(2_000_000)
    const needed = expected + inFlight

    // The worst case, which counts every part recovered, is many times the cap, and `fits` leaves it out.
    expect(worst).toBeGreaterThan(5 * needed)
    expect(estimateAt(needed)).toMatchObject({ fits: true, worst })
    expect(estimateAt(needed - 1).fits).toBe(false)
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
          findings: 50,
          provider: 'windowed',
        },
      },
      expected: 0,
      worst: 0,
      inFlight: 0,
      maxFindings: 50,
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
