import { describe, expect, it } from 'vitest'
import type { Provider } from '../core/ports.ts'
import type { Estimate } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { bannerLines, boundWarnings, estimateLines, profileProviders, providerOrigin, viewFacts } from './render.ts'
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
      },
    },
    expected: 16_667,
    worst: 1_850_000,
    inFlight: 50_000,
    maxFindings: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
    held: 2,
  }
  const bounds: Bounds = { cap: 'config', deadline: 'config' }
  const total = 'estimate: research about 16667 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once; the review\'s token cap is 2000000 (maxReviewTokens), and its deadline 1800000 ms (reviewTimeoutMs)'

  it('writes the estimate\'s lines, a profile\'s prefixed when several run', () => {
    expect(estimateLines(estimate, bounds)).toEqual([
      'estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      total,
    ])
    const team = {
      parts: [8000],
      votes: 100,
      vote: { naming: 3000, layout: 3000 },
      expected: 2667,
      worst: 608_000,
      findings: 50,
      provider: 'api',
    }
    expect(estimateLines({
      ...estimate,
      profiles: { security: estimate.profiles.security, team },
    }, bounds)).toEqual([
      '[security] estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      '[team] estimate: 1 research part(s), about 2667 tokens expected for them; then up to 100 vote(s), at most 608000 tokens in all',
      total,
    ])
    // A profile's id is a caller's text: it is shown inert.
    const [first] = estimateLines({
      ...estimate,
      profiles: { [`a${RLO}b`]: estimate.profiles.security, team },
    }, bounds)
    expect(first).toBe('[a<U+202E>b] estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all')
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
      'estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      'estimate: research about 1000001 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once; the review\'s token cap is 2000000 (maxReviewTokens), and its deadline 1800000 ms (reviewTimeoutMs)',
      'estimate: research alone expects about 1000001 of the review\'s token cap of 2000000 (50%): a review of this size needs a cap of about 1300000: raise maxReviewTokens, or narrow the path',
    ])
    // Half the cap is not over half: no line. The need rounds up to the next 100000, and an exact multiple stays.
    expect(estimateLines({ ...estimate, expected: 1_000_000 }, bounds)).toHaveLength(2)
    expect(estimateLines({ ...estimate, expected: 1_000_000 - 1 }, bounds)).toHaveLength(2)
    const vote = {
      ...estimate.profiles.security,
      vote: { only: 3000 },
    }
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 49_999,
      profiles: { security: vote },
    }, bounds)[2]).toContain('needs a cap of about 1100000')
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
      profiles: { security: vote },
    }, bounds)[2]).toContain('needs a cap of about 1200000')
    // Several profiles: every one's votes count, and the line is never prefixed.
    const two = estimateLines({
      ...heavy,
      profiles: {
        security: estimate.profiles.security,
        team: { ...estimate.profiles.security },
      },
    }, bounds)
    expect(two.at(-1)).toBe('estimate: research alone expects about 1000001 of the review\'s token cap of 2000000 (50%): a review of this size needs a cap of about 1500000: raise maxReviewTokens, or narrow the path')
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
    }, bounds).slice(3)).toEqual([
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
    }, bounds).slice(4)).toEqual([
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
    }, bounds).slice(3)).toEqual([
      line('x<U+202E>y', 7),
    ])
  })

  it.each([
    [
      'both follow the estimate',
      { cap: 'estimate', deadline: 'longest' },
      'the review\'s token cap is 9864619, this estimate\'s worst case, and its deadline 86400000 ms, the longest allowed: the config sets neither',
    ],
    [
      'the config sets the cap',
      { cap: 'config', deadline: 'longest' },
      'the review\'s token cap is 2000000 (maxReviewTokens), and its deadline 86400000 ms, the longest allowed',
    ],
    [
      'the config sets the deadline',
      { cap: 'estimate', deadline: 'config' },
      'the review\'s token cap is 9864619, this estimate\'s worst case, and its deadline 3600000 ms (reviewTimeoutMs)',
    ],
    [
      'the floor holds the worst case',
      { cap: 'floor', deadline: 'longest' },
      'the review\'s token cap is 2000000, the default, which holds this estimate\'s worst case, and its deadline 86400000 ms, the longest allowed: the config sets neither',
    ],
  ] as const)('ends the estimate with its bounds when %s', (_name, bounds, ending) => {
    const cap = bounds.cap === 'estimate'
      ? 9_864_619
      : 2_000_000
    const ms = bounds.deadline === 'longest'
      ? 86_400_000
      : 3_600_000
    const [, last] = estimateLines({ ...estimate, maxReviewTokens: cap, reviewTimeoutMs: ms }, bounds)
    expect(last).toBe(`estimate: research about 16667 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once; ${ending}`)
  })

  it('writes the large review\'s warning, and the cap\'s when the estimate passes an explicit cap', () => {
    // A small review's worst case passes the default through recovery's bound alone, and says nothing.
    const small: Estimate = {
      ...estimate,
      worst: 9_864_619,
      maxReviewTokens: 9_864_619,
      reviewTimeoutMs: 86_400_000,
    }
    expect(boundWarnings(small, { cap: 'estimate', deadline: 'longest' })).toEqual([])
    // What 0.8.0 held: the expected spend and the calls in flight pass the default, 2000000.
    const large: Estimate = { ...small, expected: 1_950_001 }
    expect(boundWarnings(large, { cap: 'estimate', deadline: 'longest' })).toEqual([
      'warning: a large review: 2 research part(s) and up to 150 vote(s), about 1950001 tokens expected and at most 9864619: Ctrl-C stops it and keeps what it read',
    ])
    expect(boundWarnings({ ...large, expected: 1_950_000 }, { cap: 'estimate', deadline: 'longest' })).toEqual([])
    // An explicit cap writes the cap's warning alone, never the large review's.
    const explicit: Estimate = {
      ...large,
      maxReviewTokens: 120_000,
      fits: false,
      held: 0,
    }
    expect(boundWarnings(explicit, { cap: 'config', deadline: 'longest' })).toHaveLength(1)
    expect(boundWarnings(explicit, { cap: 'config', deadline: 'longest' })[0]).toContain('the token cap of 120000 (maxReviewTokens) holds about 0 of the 2')
    // The default floor holds the worst case, and a cap the estimate fits under is no warning.
    expect(boundWarnings(estimate, { cap: 'floor', deadline: 'longest' })).toEqual([])
    expect(boundWarnings(estimate, { cap: 'config', deadline: 'config' })).toEqual([])
    const below: Estimate = {
      ...estimate,
      maxReviewTokens: 120_000,
      fits: false,
      held: 1,
    }
    expect(boundWarnings(below, { cap: 'config', deadline: 'longest' })).toEqual([
      'warning: the token cap of 120000 (maxReviewTokens) holds about 1 of the 2 research parts this estimate expects: the review runs to the cap, and what it cannot pay for is a token-cap gap; unset maxReviewTokens to let a path review\'s cap follow its estimate',
    ])
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
  })
})
