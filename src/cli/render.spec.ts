import { describe, expect, it } from 'vitest'
import type { Provider } from '../core/ports.ts'
import type { QuorumEvent } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { bannerLines, profileProviders, progressSink, providerOrigin, renderEvent } from './render.ts'

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
