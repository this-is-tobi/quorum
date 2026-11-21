import { describe, expect, it } from 'vitest'
import type { Provider } from '../core/ports.ts'
import type { Estimate, LeftOutFile, QuorumEvent } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { bannerLines, estimateLines, profileProviders, progressSink, providerOrigin, renderEvent } from './render.ts'

/** A right-to-left override, which the sanitizer writes as text. */
const RLO = String.fromCharCode(0x202E)

describe('renderEvent', () => {
  it('turns the events a person follows into progress lines', () => {
    expect(renderEvent({
      type: 'stage:end',
      profile: 'security',
      stage: 'dedup',
      durationMs: 1,
      count: 2,
    })).toBe('2 candidate(s) after dedup')
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'missing.js:1 is not in the diff' })).toBe('invalid finding dropped: missing.js:1 is not in the diff')
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' },
    })).toBe('incomplete: research-unusable (1 finding(s) reported, none usable)')
    expect(renderEvent({
      type: 'run:end',
      kept: 1,
      discarded: 2,
      unreviewed: 3,
      incomplete: 0,
      durationMs: 5,
    })).toBe('1 kept, 2 discarded, 3 unreviewed by panel')
  })

  it('writes a provider-down event as the line that names its fix', () => {
    expect(renderEvent({
      type: 'provider-down',
      provider: 'finder',
      kind: 'http',
      status: 503,
      calls: 3,
    })).toBe('finder: 3 calls in a row failed (http 503): no more calls go to it in this review: lower concurrency or wait')
    expect(renderEvent({
      type: 'provider-down',
      provider: 'finder',
      kind: 'network',
      calls: 3,
    })).toBe('finder: 3 calls in a row failed (network): no more calls go to it in this review: check that the server at its origin is running')
    expect(renderEvent({
      type: 'provider-down',
      provider: `f${RLO}x`,
      kind: 'timeout',
      calls: 3,
    }, true, 'public')).toBe('f<U+202E>x: 3 calls in a row failed (timeout): no more calls go to it in this review: raise timeoutMs')
  })

  it('renders a flag with where it points', () => {
    expect(renderEvent({
      type: 'flag',
      flag: {
        code: 'hidden-characters',
        file: 'src/a.js',
        line: 3,
        detail: 'U+202E on 1 added line(s)',
      },
    })).toBe('flag: hidden-characters at "src/a.js":3 (U+202E on 1 added line(s))')
    expect(renderEvent({
      type: 'flag',
      flag: { code: 'hidden-characters', file: `src/${RLO}gnp.js`, detail: 'the file name holds U+202E' },
    })).toBe('flag: hidden-characters at "src/<U+202E>gnp.js" (the file name holds U+202E)')
    expect(renderEvent({
      type: 'flag',
      flag: { code: 'ai-addressed-text', line: 2, detail: 'a tool-call tag on 1 added line(s)' },
    })).toBe('flag: ai-addressed-text at line 2 (a tool-call tag on 1 added line(s))')
    expect(renderEvent({
      type: 'flag',
      flag: { code: 'hidden-characters', file: 'a\nb.js', detail: 'the file name holds U+000A' },
    })).toBe('flag: hidden-characters at "a\\nb.js" (the file name holds U+000A)')
  })

  it('renders the files left out in one line: five at most, each a JSON string with its reason, the empty name as <no path>, inert, never prefixed', () => {
    const file = (name: string, reason: 'excluded' | 'binary' | 'submodule' = 'binary'): LeftOutFile => ({ file: name, reason })
    expect(renderEvent({
      type: 'left-out',
      files: [
        file('a.png'),
        file(''),
        file('vendor/lib', 'submodule'),
      ],
    }))
      .toBe('left out: 3 file(s): "a.png" (binary), <no path> (binary), "vendor/lib" (submodule)')
    expect(renderEvent({
      type: 'left-out',
      files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => file(`${name}.png`)),
    }))
      .toBe('left out: 7 file(s): "a.png" (binary), "b.png" (binary), "c.png" (binary), "d.png" (binary), "e.png" (binary) and 2 more')
    expect(renderEvent({
      type: 'left-out',
      files: [
        file(`x${String.fromCharCode(0x202E)}\n.png`),
      ],
    }, true))
      .toBe('left out: 1 file(s): "x<U+202E>\\n.png" (binary)')
  })

  it('writes a skipped file with its rule on the left out line', () => {
    expect(renderEvent({
      type: 'left-out',
      files: [
        { file: 'go.sum', reason: 'skipped', rule: 'lockfile' },
        { file: 'img.png', reason: 'binary' },
      ],
    }))
      .toBe('left out: 2 file(s): "go.sum" (skipped: lockfile), "img.png" (binary)')
    expect(renderEvent({
      type: 'left-out',
      files: [
        { file: `.env${String.fromCharCode(0x202E)}\n`, reason: 'skipped', rule: 'secret' },
      ],
    }))
      .toBe('left out: 1 file(s): ".env<U+202E>\\n" (skipped: secret)')
  })

  it('writes a held file with its reason and rule on the left out line', () => {
    expect(renderEvent({
      type: 'left-out',
      files: [
        { file: '.env', reason: 'secret', rule: 'name' },
        { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
      ],
    }))
      .toBe('left out: 2 file(s): ".env" (secret: name), "old/.env" (deleted-secret: name)')
    expect(renderEvent({
      type: 'left-out',
      files: [
        { file: '', reason: 'secret', rule: 'aws-key' },
      ],
    }))
      .toBe('left out: 1 file(s): <no path> (secret: aws-key)')
  })

  it('renders the text a line carries inert', () => {
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'a\u001B[2J.js:1 is not in the diff' })).toBe('invalid finding dropped: a<U+001B>[2J.js:1 is not in the diff')
    expect(renderEvent({
      type: 'incomplete',
      entry: {
        profile: 'security',
        reason: 'vote-failed',
        file: `a${RLO}.js`,
        detail: `"a${RLO}.js":1 is kept at medium, but 1 failed vote(s) could have made it high`,
      },
    })).toBe('incomplete: vote-failed ("a<U+202E>.js":1 is kept at medium, but 1 failed vote(s) could have made it high)')
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'finding-unreadable', detail: 'findings[0]: x\n::error::y' },
    })).toBe('incomplete: finding-unreadable (findings[0]: x<U+000A>::error::y)')
  })

  it('writes a gap with no detail and a dropped finding with no reason in the public view, and every other line as the full view does', () => {
    const detail = 'DETAIL-CANARY'
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'binary', detail },
    }, false, 'public')).toBe('incomplete: binary')
    expect(renderEvent({
      type: 'incomplete',
      entry: {
        profile: 'security',
        reason: 'vote-failed',
        file: 'a.js',
        detail,
      },
    }, false, 'public')).toBe('incomplete: vote-failed at "a.js"')
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'REASON-CANARY.js:1 is not in the diff' }, false, 'public')).toBe('invalid finding dropped')
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'binary', detail },
    }, true, 'public')).toBe('[security] incomplete: binary')
    expect(renderEvent({ type: 'finding:invalid', profile: 'team', reason: 'x' }, true, 'public')).toBe('[team] invalid finding dropped')

    const same: QuorumEvent[] = [
      {
        type: 'left-out',
        files: [
          { file: '.env', reason: 'secret', rule: 'name' },
          { file: 'a.png', reason: 'binary' },
        ],
      },
      {
        type: 'flag',
        flag: {
          code: 'hidden-characters',
          file: 'src/a.js',
          line: 3,
          detail: 'U+202E on 1 added line(s)',
        },
      },
      {
        type: 'run:end',
        kept: 1,
        discarded: 2,
        unreviewed: 3,
        incomplete: 0,
        durationMs: 5,
      },
      {
        type: 'stage:end',
        profile: 'team',
        stage: 'dedup',
        durationMs: 1,
        count: 2,
      },
    ]
    for (const event of same) expect(renderEvent(event, true, 'public')).toBe(renderEvent(event, true, 'full'))

    const lines: string[] = []
    const sink = progressSink(line => lines.push(line), 'public')
    sink({
      type: 'run:start',
      profiles: ['security'],
      providers: {},
    })
    sink({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'binary', detail },
    })
    expect(lines).toEqual(['incomplete: binary'])
  })

  it('prints nothing for the other events', () => {
    expect(renderEvent({
      type: 'stage:end',
      profile: 'security',
      stage: 'research',
      durationMs: 1,
      count: 2,
    })).toBeUndefined()
    expect(renderEvent({ type: 'stage:start', profile: 'security', stage: 'panel' })).toBeUndefined()
    expect(renderEvent({
      type: 'vote',
      profile: 'security',
      findingId: 'f',
      lens: 'impact',
      keep: null,
      error: 'endpoint down',
    })).toBeUndefined()
    expect(renderEvent({
      type: 'verdict',
      profile: 'security',
      findingId: 'f',
      keptVotes: 3,
      totalVotes: 3,
      confidence: 'high',
      status: 'kept',
    })).toBeUndefined()
  })

  it('prefixes a profile\'s lines, and never the flag or totals lines', () => {
    expect(renderEvent({
      type: 'stage:end',
      profile: 'team',
      stage: 'dedup',
      durationMs: 1,
      count: 2,
    }, true)).toBe('[team] 2 candidate(s) after dedup')
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'missing.js:1 is not in the diff' }, true)).toBe('[security] invalid finding dropped: missing.js:1 is not in the diff')
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' },
    }, true)).toBe('[security] incomplete: research-unusable (1 finding(s) reported, none usable)')
    expect(renderEvent({
      type: 'flag',
      flag: {
        code: 'hidden-characters',
        file: 'src/a.js',
        line: 3,
        detail: 'U+202E on 1 added line(s)',
      },
    }, true)).toBe('flag: hidden-characters at "src/a.js":3 (U+202E on 1 added line(s))')
    expect(renderEvent({
      type: 'run:end',
      kept: 1,
      discarded: 2,
      unreviewed: 3,
      incomplete: 0,
      durationMs: 5,
    }, true)).toBe('1 kept, 2 discarded, 3 unreviewed by panel')
  })
})

describe('estimateLines', () => {
  const estimate: Estimate = {
    profiles: {
      security: {
        parts: [30_000, 20_000],
        votes: 150,
        vote: { reachability: 4000, impact: 4000, defenses: 4000 },
        expected: 16_667,
        worst: 1_850_000,
      },
    },
    expected: 16_667,
    worst: 1_850_000,
    inFlight: 50_000,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
  }

  it('writes the estimate\'s lines, a profile\'s prefixed when several run', () => {
    const total = 'estimate: research about 16667 tokens expected, at most 1850000 with every vote, 50000 of them reserved at once; the review\'s token cap is 2000000 and its deadline 1800000 ms'
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
})

describe('progressSink', () => {
  const dedup: QuorumEvent = {
    type: 'stage:end',
    profile: 'team',
    stage: 'dedup',
    durationMs: 1,
    count: 2,
  }
  const started = (profiles: string[]): QuorumEvent => ({
    type: 'run:start',
    profiles,
    providers: Object.fromEntries(profiles.map(id => [
      id,
      {
        research: { id: 'default', model: 'm' },
        lenses: {},
      },
    ])),
  })

  it('learns from run:start whether to prefix, and writes only the lines it renders', () => {
    const lines: string[] = []
    const sink = progressSink(line => lines.push(line))
    sink(started(['security', 'team']))
    sink(dedup)
    sink({
      type: 'vote',
      profile: 'team',
      findingId: 'f',
      lens: 'impact',
      keep: null,
      error: 'endpoint down',
    })
    expect(lines).toEqual(['[team] 2 candidate(s) after dedup'])

    const single: string[] = []
    const alone = progressSink(line => single.push(line))
    alone(started(['team']))
    alone(dedup)
    expect(single).toEqual(['2 candidate(s) after dedup'])
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
