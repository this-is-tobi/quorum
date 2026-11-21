import { describe, expect, it } from 'vitest'
import type { Provider } from '../core/ports.ts'
import type { Estimate } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { bannerLines, estimateLines, profileProviders, providerOrigin, viewFacts } from './render.ts'

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
  }
  const total = 'estimate: research about 16667 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once; the review\'s token cap is 2000000 and its deadline 1800000 ms'

  it('writes the estimate\'s lines, a profile\'s prefixed when several run', () => {
    expect(estimateLines(estimate)).toEqual([
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
    })).toEqual([
      '[security] estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      '[team] estimate: 1 research part(s), about 2667 tokens expected for them; then up to 100 vote(s), at most 608000 tokens in all',
      total,
    ])
    // A profile's id is a caller's text: it is shown inert.
    const [first] = estimateLines({
      ...estimate,
      profiles: { [`a${RLO}b`]: estimate.profiles.security, team },
    })
    expect(first).toBe('[a<U+202E>b] estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all')
  })

  it('writes the cap line when research expects over half the cap, with the cap the review needs', () => {
    // Expected 1000001 of a cap of 2000000 is over half; the review needs expected and inFlight, and every vote at a third of its bound: 150 votes of 4000 each, 200000, so 1250001 rounded up to 1300000.
    const heavy: Estimate = {
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
    }
    const lines = estimateLines(heavy)
    expect(lines).toEqual([
      'estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      'estimate: research about 1000001 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once; the review\'s token cap is 2000000 and its deadline 1800000 ms',
      'estimate: research alone expects about 1000001 of the review\'s token cap of 2000000 (50%): a review of this size needs a cap of about 1300000: raise maxReviewTokens, or narrow the path',
    ])
    // Half the cap is not over half: no line. The need rounds up to the next 100000, and an exact multiple stays.
    expect(estimateLines({ ...estimate, expected: 1_000_000 })).toHaveLength(2)
    expect(estimateLines({ ...estimate, expected: 1_000_000 - 1 })).toHaveLength(2)
    const vote = {
      ...estimate.profiles.security,
      vote: { only: 3000 },
    }
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 49_999,
      profiles: { security: vote },
    })[2]).toContain('needs a cap of about 1100000')
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
      profiles: { security: vote },
    })[2]).toContain('needs a cap of about 1200000')
    // Several profiles: every one's votes count, and the line is never prefixed.
    const two = estimateLines({
      ...heavy,
      profiles: {
        security: estimate.profiles.security,
        team: { ...estimate.profiles.security },
      },
    })
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
    }).slice(3)).toEqual([
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
    }).slice(4)).toEqual([
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
    }).slice(3)).toEqual([
      line('x<U+202E>y', 7),
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
    expect(viewFacts(config)).toEqual({
      concurrency: 4,
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
