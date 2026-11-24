import { describe, expect, it } from 'vitest'
import type { Provider } from '../core/ports.ts'
import type { Estimate } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { bannerLines, boundWarnings, estimateLines, EXACT_WORDS, findingsCapOf, profileProviders, providerOrigin, viewFacts } from './render.ts'
import type { Bounds } from './render.ts'

/** A right-to-left override, which the sanitizer writes as text. */
const RLO = String.fromCharCode(0x202E)

describe('estimateLines', () => {
  const estimate: Estimate = {
    profiles: {
      security: {
        parts: [30_000, 20_000],
        votes: 150,
        vote: { reachability: 4000, impact: 4000, defenses: 4000 },
        expected: 16_667,
        worst: 1_850_000,
        findings: 50,
        provider: 'api',
        documents: { research: 0, vote: 0 },
      },
    },
    expected: 16_667,
    worst: 1_850_000,
    inFlight: 50_000,
    maxFindings: 50,
    findingsCap: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
    held: 2,
  }
  const bounds: Bounds = { cap: 'config', deadline: 'config', findings: 'config' }
  const cost = 'estimate: research about 16.6k tokens expected, at most 1.85M with every vote and every part recovered, 50.0k of them reserved at once'
  const limits = 'bounds: the token cap 2.00M (maxReviewTokens); the deadline 30m00s (reviewTimeoutMs); the finding cap 50 (maxFindings)'

  it('writes the estimate\'s lines, a profile\'s prefixed when several run', () => {
    expect(estimateLines(estimate, bounds)).toEqual([
      'estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all',
      cost,
      limits,
    ])
    const team = {
      parts: [8000],
      votes: 100,
      vote: { naming: 3000, layout: 3000 },
      expected: 2667,
      worst: 608_000,
      findings: 50,
      provider: 'api',
      documents: { research: 0, vote: 0 },
    }
    expect(estimateLines({
      ...estimate,
      profiles: { security: estimate.profiles.security, team },
    }, bounds)).toEqual([
      '[security] estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all',
      '[team] estimate: 1 research part(s), about 2.66k tokens expected for them; then up to 100 vote(s), at most 608k tokens in all',
      cost,
      limits,
    ])
    // A profile's id is a caller's text: it is shown inert.
    const [first] = estimateLines({
      ...estimate,
      profiles: { [`a${RLO}b`]: estimate.profiles.security, team },
    }, bounds)
    expect(first).toBe('[a<U+202E>b] estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all')
  })

  it('ends a profile\'s estimate line with what its documents add, when they add anything', () => {
    const clause = (research: string, vote: string): string => `; its documents add ${research} tokens to each research request and ${vote} to each vote`
    const profile = (documents: { research: number, vote: number }): Estimate['profiles'][string] => ({ ...estimate.profiles.security, documents })
    const first = (profiles: Estimate['profiles'], words?: Parameters<typeof estimateLines>[2]): string => estimateLines({ ...estimate, profiles }, bounds, words)[0]
    const line = 'estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all'
    // A person reads the counts scaled, a program under --progress json reads the integers.
    expect(first({
      security: profile({ research: 4402, vote: 4402 }),
    })).toBe(`${line}${clause('4.40k', '4.40k')}`)
    expect(first({
      security: profile({ research: 4402, vote: 4402 }),
    }, EXACT_WORDS)).toBe(`estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all${clause('4402', '4402')}`)
    // Each count is its own: the do-not-report text reaches research alone, so a vote's is 0, and the clause is written while either is above 0.
    expect(first({
      security: profile({ research: 1500, vote: 0 }),
    })).toBe(`${line}${clause('1.50k', '0')}`)
    expect(first({
      security: profile({ research: 0, vote: 1500 }),
    })).toBe(`${line}${clause('0', '1.50k')}`)
    // No clause at 0, for either: the line is as it was.
    expect(first({
      security: profile({ research: 0, vote: 0 }),
    })).toBe(line)
    // Each profile's line holds its own, prefixed when several run, and the review's two lines hold none.
    const lines = estimateLines({
      ...estimate,
      profiles: {
        security: profile({ research: 0, vote: 0 }),
        naming: profile({ research: 4402, vote: 1500 }),
      },
    }, bounds)
    expect(lines[0]).toBe(`[security] ${line}`)
    expect(lines[1]).toBe(`[naming] ${line}${clause('4.40k', '1.50k')}`)
    expect(lines[2]).toBe(cost)
    expect(lines.filter(entry => entry.includes('its documents add'))).toHaveLength(1)
  })

  it('writes the cap line when research expects over half the cap, with the cap the review needs', () => {
    // Expected 1000001 of a cap of 2000000 is over half; the review needs expected and inFlight, and every vote at a third of its bound: 150 votes of 4000 each, 200000, so 1250001 rounded up to 1300000.
    const heavy: Estimate = {
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
    }
    const lines = estimateLines(heavy, bounds)
    expect(lines).toEqual([
      'estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all',
      'estimate: research about 1.00M tokens expected, at most 1.85M with every vote and every part recovered, 50.0k of them reserved at once',
      limits,
      'estimate: research alone expects about 1.00M of the review\'s token cap of 2.00M (50%): a review of this size needs a cap of about 1300000: raise maxReviewTokens, or narrow the path',
    ])
    // Half the cap is not over half: no line. The need rounds up to the next 100000, and an exact multiple stays.
    expect(estimateLines({ ...estimate, expected: 1_000_000 }, bounds)).toHaveLength(3)
    expect(estimateLines({ ...estimate, expected: 1_000_000 - 1 }, bounds)).toHaveLength(3)
    const vote = {
      ...estimate.profiles.security,
      vote: { only: 3000 },
    }
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 49_999,
      profiles: { security: vote },
    }, bounds)[3]).toContain('needs a cap of about 1100000')
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
      profiles: { security: vote },
    }, bounds)[3]).toContain('needs a cap of about 1200000')
    // Several profiles: every one's votes count, and the line is never prefixed.
    const two = estimateLines({
      ...heavy,
      profiles: {
        security: estimate.profiles.security,
        team: { ...estimate.profiles.security },
      },
    }, bounds)
    expect(two.at(-1)).toBe('estimate: research alone expects about 1.00M of the review\'s token cap of 2.00M (50%): a review of this size needs a cap of about 1500000: raise maxReviewTokens, or narrow the path')
  })

  it('writes the N line once per research provider below maxFindings', () => {
    const profile = (findings: number, provider: string, parts = [1000]): Estimate['profiles'][string] => ({
      ...estimate.profiles.security,
      parts,
      findings,
      provider,
    })
    const line = (provider: string, n: number): string => `estimate: on ${provider} a research reply asks for at most ${n} of maxFindings 50 findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N`
    // One line for a provider below maxFindings, none for one at it.
    expect(estimateLines({
      ...estimate,
      profiles: {
        a: profile(15, 'local'),
        b: profile(50, 'api'),
      },
    }, bounds).slice(4)).toEqual([
      line('local', 15),
    ])
    // A provider two profiles share is named once; each provider below maxFindings has its own line, in profile order.
    expect(estimateLines({
      ...estimate,
      profiles: {
        a: profile(15, 'local'),
        b: profile(15, 'local'),
        c: profile(7, 'small'),
      },
    }, bounds).slice(5)).toEqual([
      line('local', 15),
      line('small', 7),
    ])
    // A profile whose research makes no call asks nothing, and a provider's id is a caller's text, shown inert.
    expect(estimateLines({
      ...estimate,
      profiles: {
        a: profile(15, 'local', []),
        b: profile(7, `x${RLO}y`),
      },
    }, bounds).slice(4)).toEqual([
      line('x<U+202E>y', 7),
    ])
  })

  it.each([
    [
      'all three follow the estimate',
      { cap: 'estimate', deadline: 'longest', findings: 'floor' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 50, the default, which holds one per research part; the config sets none of them',
    ],
    [
      'the config sets the cap',
      { cap: 'config', deadline: 'longest', findings: 'floor' },
      'the token cap 2.00M (maxReviewTokens); the deadline 24h00m00s, the longest allowed; the finding cap 50, the default, which holds one per research part',
    ],
    [
      'the config sets the deadline',
      { cap: 'estimate', deadline: 'config', findings: 'floor' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 1h00m00s (reviewTimeoutMs); the finding cap 50, the default, which holds one per research part',
    ],
    [
      'the floor holds the worst case',
      { cap: 'floor', deadline: 'longest', findings: 'floor' },
      'the token cap 2.00M, the default, which holds this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 50, the default, which holds one per research part; the config sets none of them',
    ],
    [
      'the finding cap follows the parts',
      { cap: 'estimate', deadline: 'longest', findings: 'parts' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 121, one per research part; the config sets none of them',
    ],
    [
      'the config sets maxFindings alone',
      { cap: 'estimate', deadline: 'longest', findings: 'config' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 121 (maxFindings)',
    ],
  ] as const)('ends the estimate with its bounds when %s', (_name, bounds, ending) => {
    const cap = bounds.cap === 'estimate'
      ? 9_864_619
      : 2_000_000
    const ms = bounds.deadline === 'longest'
      ? 86_400_000
      : 3_600_000
    const findingsCap = bounds.findings === 'floor'
      ? 50
      : 121
    const [, , last] = estimateLines({
      ...estimate,
      maxReviewTokens: cap,
      reviewTimeoutMs: ms,
      findingsCap,
    }, bounds)
    expect(last).toBe(`bounds: ${ending}`)
  })

  it('writes the estimate in two lines, the cost then the bounds, each count scaled and the deadline in hours and minutes', () => {
    const lines = estimateLines({ ...estimate, reviewTimeoutMs: 86_400_000 }, { cap: 'floor', deadline: 'longest', findings: 'floor' })
    expect(lines.slice(1)).toEqual([
      'estimate: research about 16.6k tokens expected, at most 1.85M with every vote and every part recovered, 50.0k of them reserved at once',
      'bounds: the token cap 2.00M, the default, which holds this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 50, the default, which holds one per research part; the config sets none of them',
    ])
  })

  it.each<[number, string]>([
    [1500, '1.5s'],
    [42_000, '42s'],
    [59_400, '59s'],
    [90_000, '1m30s'],
  ])('writes a deadline of %i ms as every line writes a duration, %s, and never rounds one it states', (ms, words) => {
    const [, , last] = estimateLines({ ...estimate, reviewTimeoutMs: ms }, bounds)
    expect(last).toBe(`bounds: the token cap 2.00M (maxReviewTokens); the deadline ${words} (reviewTimeoutMs); the finding cap 50 (maxFindings)`)
  })

  it('writes every number of the estimate exact with EXACT_WORDS', () => {
    const lines = estimateLines({ ...estimate, reviewTimeoutMs: 86_400_000 }, { cap: 'floor', deadline: 'longest', findings: 'floor' }, EXACT_WORDS)
    expect(lines).toEqual([
      'estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      'estimate: research about 16667 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once',
      'bounds: the token cap 2000000, the default, which holds this estimate\'s worst case; the deadline 86400000 ms, the longest allowed; the finding cap 50, the default, which holds one per research part; the config sets none of them',
    ])
    const heavy: Estimate = { ...estimate, expected: 1_000_001 }
    expect(estimateLines(heavy, bounds, EXACT_WORDS)[3]).toBe('estimate: research alone expects about 1000001 of the review\'s token cap of 2000000 (50%): a review of this size needs a cap of about 1300000: raise maxReviewTokens, or narrow the path')
    const large: Estimate = { ...estimate, worst: 9_864_619, expected: 1_950_001 }
    expect(boundWarnings(large, { cap: 'estimate', deadline: 'longest', findings: 'floor' }, EXACT_WORDS)).toEqual([
      'warning: a large review: 2 research part(s) and up to 150 vote(s), about 1950001 tokens expected and at most 9864619: Ctrl-C stops it and keeps what it read',
    ])
  })

  it('counts the cap line\'s votes at the findingsCap, and compares N to maxFindings', () => {
    // 121 findings of 3 lenses at 4000 each, a third of it: 484000, so 1000001 + 50000 + 484000 rounds up to 1600000.
    const heavy: Estimate = { ...estimate, expected: 1_000_001, findingsCap: 121 }
    expect(estimateLines(heavy, { cap: 'config', deadline: 'config', findings: 'parts' })[3]).toContain('needs a cap of about 1600000')
    // N below maxFindings is still compared to maxFindings, whatever the finding cap.
    const narrow: Estimate = {
      ...estimate,
      findingsCap: 121,
      profiles: {
        security: { ...estimate.profiles.security, findings: 15, provider: 'local' },
      },
    }
    expect(estimateLines(narrow, { cap: 'config', deadline: 'config', findings: 'parts' }).at(-1)).toBe('estimate: on local a research reply asks for at most 15 of maxFindings 50 findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N')
  })

  it('writes the large review\'s warning, and the cap\'s when the estimate passes an explicit cap', () => {
    // A small review's worst case passes the default through recovery's bound alone, and says nothing.
    const small: Estimate = {
      ...estimate,
      worst: 9_864_619,
      maxReviewTokens: 9_864_619,
      reviewTimeoutMs: 86_400_000,
    }
    expect(boundWarnings(small, { cap: 'estimate', deadline: 'longest', findings: 'floor' })).toEqual([])
    // What 0.8.0 held: the expected spend and the calls in flight pass the default, 2000000.
    const large: Estimate = { ...small, expected: 1_950_001 }
    expect(boundWarnings(large, { cap: 'estimate', deadline: 'longest', findings: 'floor' })).toEqual([
      'warning: a large review: 2 research part(s) and up to 150 vote(s), about 1.95M tokens expected and at most 9.86M: Ctrl-C stops it and keeps what it read',
    ])
    expect(boundWarnings({ ...large, expected: 1_950_000 }, { cap: 'estimate', deadline: 'longest', findings: 'floor' })).toEqual([])
    // An explicit cap writes the cap's warning alone, never the large review's.
    const explicit: Estimate = {
      ...large,
      maxReviewTokens: 120_000,
      fits: false,
      held: 0,
    }
    expect(boundWarnings(explicit, { cap: 'config', deadline: 'longest', findings: 'floor' })).toHaveLength(1)
    expect(boundWarnings(explicit, { cap: 'config', deadline: 'longest', findings: 'floor' })[0]).toContain('the token cap of 120k (maxReviewTokens) holds about 0 of the 2')
    // The default floor holds the worst case, and a cap the estimate fits under is no warning.
    expect(boundWarnings(estimate, { cap: 'floor', deadline: 'longest', findings: 'floor' })).toEqual([])
    expect(boundWarnings(estimate, { cap: 'config', deadline: 'config', findings: 'config' })).toEqual([])
    const below: Estimate = {
      ...estimate,
      maxReviewTokens: 120_000,
      fits: false,
      held: 1,
    }
    expect(boundWarnings(below, { cap: 'config', deadline: 'longest', findings: 'floor' })).toEqual([
      'warning: the token cap of 120k (maxReviewTokens) holds about 1 of the 2 research parts this estimate expects: the review runs to the cap, and what it cannot pay for is a token-cap gap; unset maxReviewTokens to let a path review\'s cap follow its estimate',
    ])
  })
})

describe('findingsCapOf', () => {
  const profileOf = (parts: number): Estimate['profiles'][string] => ({
    parts: Array.from<number>({ length: parts }).fill(1000),
    votes: 0,
    vote: {},
    expected: 0,
    worst: 0,
    findings: 50,
    provider: 'api',
    documents: { research: 0, vote: 0 },
  })
  const estimateOf = (...parts: number[]): Estimate => ({
    profiles: Object.fromEntries(parts.map((count, index) => [
      `p${index}`,
      profileOf(count),
    ])),
    expected: 0,
    worst: 0,
    inFlight: 0,
    maxFindings: 50,
    findingsCap: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
    held: 0,
  })

  it('is the larger of 50 and each profile\'s research part count', () => {
    expect(findingsCapOf(estimateOf(121))).toBe(121)
    expect(findingsCapOf(estimateOf(44))).toBe(50)
    expect(findingsCapOf(estimateOf(30, 70))).toBe(70)
    expect(findingsCapOf(estimateOf())).toBe(50)
  })
})

describe('bannerLines', () => {
  const local = {
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3.6:27b',
    contextTokens: 131072,
  } as const
  const mistral = { preset: 'mistral', model: 'mistral-small-latest', contextTokens: 131072 } as const
  const lenses = securityProfile.lenses.map(lens => lens.id)
  const config = (providers: Record<string, ResolvedProvider>, bindings: Array<{ id?: string, research: string, voters: Record<string, string> }>): ResolvedConfig => ({
    providers,
    profiles: bindings.map(({ id = 'security', research, voters }) => ({
      profile: { ...securityProfile, id },
      research,
      voters,
      repository: [],
    })),
    warnings: [],
  }) satisfies ResolvedConfig
  const sharing = (name: string): Record<string, string> => Object.fromEntries(lenses.map(lens => [lens, name]))

  it('names the provider of the research and of the panel once, when every lens shares it', () => {
    expect(bannerLines(config({ local }, [
      {
        research: 'local',
        voters: sharing('local'),
      },
    ]))).toEqual([
      'Research (qwen3.6:27b @ http://localhost:11434)...',
      'Panel will use qwen3.6:27b @ http://localhost:11434',
    ])
  })

  it('names each lens\'s provider when they differ, one of them reached through its preset\'s base URL', () => {
    const voters = { reachability: 'local', impact: 'mistral', defenses: 'local' }
    expect(bannerLines(config({ local, mistral }, [
      { research: 'local', voters },
    ]))[1]).toBe('Panel will use reachability (qwen3.6:27b @ http://localhost:11434), impact (mistral-small-latest @ https://api.mistral.ai), defenses (qwen3.6:27b @ http://localhost:11434)')
  })

  it('names a claude-code provider by its model and its protocol', () => {
    const cc = {
      protocol: 'claude-code',
      command: '/c',
      model: 'sonnet',
      contextTokens: 1000000,
    } as const
    expect(bannerLines(config({ cc }, [
      {
        research: 'cc',
        voters: sharing('cc'),
      },
    ]))).toEqual(['Research (sonnet @ claude-code)...', 'Panel will use sonnet @ claude-code'])
  })

  it('names a claude-code provider among others, and never its command', () => {
    const cc = {
      protocol: 'claude-code',
      command: '/secret/claude',
      model: 'haiku',
      contextTokens: 1000000,
    } as const
    const voters = { reachability: 'cc', impact: 'local', defenses: 'cc' }
    const lines = bannerLines(config({ local, cc }, [
      { research: 'local', voters },
    ]))
    expect(lines[1]).toBe('Panel will use reachability (haiku @ claude-code), impact (qwen3.6:27b @ http://localhost:11434), defenses (haiku @ claude-code)')
    expect(lines.join('\n')).not.toContain('secret')
  })

  it('starts each line with the profile when several run', () => {
    const lines = bannerLines(config({ local }, [
      {
        research: 'local',
        voters: sharing('local'),
      },
      {
        id: 'team',
        research: 'local',
        voters: sharing('local'),
      },
    ]))
    expect(lines).toHaveLength(4)
    expect(lines.map(line => line.slice(0, line.indexOf(' ')))).toEqual([
      '[security]',
      '[security]',
      '[team]',
      '[team]',
    ])
    expect(lines[2]).toBe('[team] Research (qwen3.6:27b @ http://localhost:11434)...')
  })

  it('names a provider object by its config key, and writes every line inert', () => {
    const complete: Provider['complete'] = async () => ({ text: '', model: 'm' })
    const mine: Provider = { id: 'mine', model: `m${String.fromCharCode(0x202E)}`, complete }
    const lines = bannerLines(config({ mine }, [
      {
        research: 'mine',
        voters: sharing('mine'),
      },
    ]))
    expect(lines[0]).toBe('Research (m<U+202E> @ the provider object mine)...')
    expect(lines[1]).toBe('Panel will use m<U+202E> @ the provider object mine')
  })

  it('names each provider by its config key alone in the public banner', () => {
    const providers = { default: local, voter: mistral }
    const lines = bannerLines(config(providers, [
      {
        research: 'default',
        voters: sharing('voter'),
      },
    ]), 'public')
    expect(lines).toEqual(['Research (default)...', 'Panel will use voter'])
    const split = bannerLines(config(providers, [
      {
        research: 'default',
        voters: { grounded: 'default', significant: 'voter' },
      },
    ]), 'public')
    expect(split[1]).toBe('Panel will use grounded (default), significant (voter)')
    const several = bannerLines(config(providers, [
      {
        research: 'default',
        voters: sharing('default'),
      },
      {
        id: 'team',
        research: 'voter',
        voters: sharing('voter'),
      },
    ]), 'public')
    expect(several).toEqual([
      '[security] Research (default)...',
      '[security] Panel will use default',
      '[team] Research (voter)...',
      '[team] Panel will use voter',
    ])
    expect([
      ...lines,
      ...split,
      ...several,
    ].join('\n')).not.toMatch(/qwen|mistral-small|localhost|11434|https?:|@/)
  })

  it('reads a base URL as an own field, never the one a polluted prototype holds', () => {
    const proto = Object.prototype as Record<string, unknown>
    proto.baseUrl = 'https://attacker.example/v1'
    try {
      const lines = bannerLines(config({ mistral }, [
        {
          research: 'mistral',
          voters: sharing('mistral'),
        },
      ]))
      expect(lines[0]).toBe('Research (mistral-small-latest @ https://api.mistral.ai)...')
      expect(providerOrigin(mistral)).toBe('https://api.mistral.ai')
      expect(lines.join('')).not.toContain('attacker')
    } finally {
      delete proto.baseUrl
    }
  })
})

describe('profileProviders', () => {
  it('names who researches and who votes in each profile, as the banner names them', () => {
    const config = resolvedConfig({
      providers: {
        fake: {
          model: 'm',
          complete: async () => ({ text: '{}', model: 'm' }),
        },
      },
    })
    expect(profileProviders(config)).toEqual([
      { profile: 'security', research: 'm @ the provider object fake', panel: 'm @ the provider object fake' },
    ])
  })
})

describe('viewFacts', () => {
  it('reads the view\'s facts from the config, with the defaults the review uses, and a path review\'s estimate', () => {
    const config = resolvedConfig({
      providers: {
        fake: {
          model: 'm',
          complete: async () => ({ text: '{}', model: 'm' }),
        },
      },
    })
    // `concurrency` unset is `auto`: each provider's own lane
    expect(viewFacts(config)).toEqual({
      concurrency: 'auto',
      cap: { tokens: 2_000_000, origin: 'default' },
      deadlineMs: 1_800_000,
      maxFindings: 50,
    })
    const set = {
      ...config,
      concurrency: 2,
      maxFindings: 9,
      maxReviewTokens: 300_000,
      reviewTimeoutMs: 60_000,
    }
    const estimate = {
      profiles: {},
      expected: 0,
      worst: 0,
      inFlight: 0,
      maxFindings: 9,
      findingsCap: 9,
      maxReviewTokens: 300_000,
      reviewTimeoutMs: 60_000,
      fits: true,
      held: 0,
    } satisfies Estimate
    expect(viewFacts(set, estimate)).toEqual({
      concurrency: 2,
      cap: { tokens: 300_000, origin: 'config' },
      deadlineMs: 60_000,
      maxFindings: 9,
      estimate,
    })
    // A path review's finding cap is the facts' maxFindings, which sizes the votes to come.
    expect(viewFacts(config, estimate, {
      cap: { tokens: 300_000, origin: 'config' },
      deadlineMs: 60_000,
      findingsCap: 121,
    }).maxFindings).toBe(121)
  })
})
