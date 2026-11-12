import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../config/resolve.ts'
import type { ConfigInput } from '../config/schema.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { canonicalSettings, fingerprint, newSalt } from './fingerprint.ts'

const PROVIDER = {
  protocol: 'openai-compatible',
  baseUrl: 'https://gw.example/team-a/v1',
  model: 'm',
  contextTokens: 32768,
} as const
const SALT = 'a'.repeat(64)
function of(provider: Record<string, unknown>, name = 'p'): ResolvedConfig {
  return resolvedConfig({
    providers: { [name]: provider },
  } as ConfigInput)
}
const same = (a: ResolvedConfig, b: ResolvedConfig): boolean => fingerprint(a, SALT) === fingerprint(b, SALT)
function object(model: string) {
  return {
    model,
    complete: async () => ({ text: '{}', model }),
  }
}

describe('fingerprint', () => {
  it('is 64 hex digits, the same for the same settings and salt', () => {
    expect(fingerprint(of(PROVIDER), SALT)).toMatch(/^[0-9a-f]{64}$/)
    expect(same(of(PROVIDER), of({ ...PROVIDER }))).toBe(true)
  })

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'an extraBody value',
      {
        extraBody: { reasoning_effort: 'low' },
      },
      {
        extraBody: { reasoning_effort: 'high' },
      },
    ],
    [
      'the base URL\'s path',
      { baseUrl: 'https://gw.example/team-a/v1' },
      { baseUrl: 'https://gw.example/team-b/v1' },
    ],
    [
      'a header value',
      {
        headers: { 'x-team': 'a' },
      },
      {
        headers: { 'x-team': 'b' },
      },
    ],
    [
      'a query value',
      {
        query: { tier: 'a' },
      },
      {
        query: { tier: 'b' },
      },
    ],
    [
      'the model',
      { model: 'm' },
      { model: 'n' },
    ],
  ])('sees a change of %s', (_name, a, b) => {
    expect(same(of({
      ...PROVIDER,
      ...a,
    }), of({
      ...PROVIDER,
      ...b,
    }))).toBe(false)
  })

  it('leaves the key out, so a rotated key keeps the run', () => {
    expect(same(of({ ...PROVIDER, apiKey: 'sk-one' }), of({ ...PROVIDER, apiKey: 'sk-two' }))).toBe(true)
  })

  it('names no provider: the same settings under another name are the same configuration', () => {
    expect(same(of(PROVIDER, 'local'), of(PROVIDER, 'remote'))).toBe(true)
  })

  it('sees configurations that a QUORUM_* variable makes alike as alike', () => {
    const env = { QUORUM_RESEARCH_MODEL: 'x', QUORUM_RESEARCH_CONTEXT_TOKENS: '32768' }
    expect(same(resolvedConfig({
      providers: { a: PROVIDER },
    }, env), resolvedConfig({
      providers: {
        b: { ...PROVIDER, model: 'other' },
      },
    }, env))).toBe(true)
  })

  it('leaves the warnings out', () => {
    const warned = resolvedConfig({
      providers: { p: PROVIDER },
    }, { QUORUM_NOPE: '1' })
    expect(warned.warnings).not.toEqual([])
    expect(same(warned, of(PROVIDER))).toBe(true)
  })

  it('sees the profiles that run and their prompts', () => {
    const team = {
      prompts: { research: 'Find style issues.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
      lenses: [
        { id: 'grounded', question: 'Backed by a convention?' },
      ],
    }
    expect(same(resolvedConfig({
      providers: { p: PROVIDER },
      profiles: { security: {}, team },
    }), of(PROVIDER))).toBe(false)
    expect(same(resolvedConfig({
      providers: { p: PROVIDER },
      profiles: {
        security: {
          prompts: { research: 'Another prompt.' },
        },
      },
    }), of(PROVIDER))).toBe(false)
  })

  it('fills the defaults, so an unset limit and its default are alike', () => {
    expect(same(resolvedConfig({
      providers: { p: PROVIDER },
      concurrency: 4,
      maxFindings: 50,
    }), of(PROVIDER))).toBe(true)
    expect(same(resolvedConfig({
      providers: { p: PROVIDER },
      concurrency: 2,
    }), of(PROVIDER))).toBe(false)
  })

  it('reads a provider object by its config key and its model, never its code', () => {
    expect(same(of(object('m'), 'fake'), of(object('m'), 'fake'))).toBe(true)
    expect(same(of(object('m'), 'fake'), of(object('m'), 'other'))).toBe(false)
    expect(same(of(object('m'), 'fake'), of(object('n'), 'fake'))).toBe(false)
  })

  it('changes with the salt', () => {
    expect(fingerprint(of(PROVIDER), SALT)).not.toBe(fingerprint(of(PROVIDER), 'b'.repeat(64)))
  })

  it('refuses a salt that is not 64 lowercase hex digits', () => {
    for (const salt of [
      '',
      'a'.repeat(63),
      'A'.repeat(64),
    ]) expect(() => fingerprint(of(PROVIDER), salt)).toThrow(RangeError)
  })
})

describe('canonicalSettings', () => {
  it('holds every setting a review uses, providers written out, keys sorted, and never the key', () => {
    const config = of({ ...PROVIDER, apiKey: 'sk-SECRET' })
    const text = canonicalSettings(config)
    expect(text).not.toContain('sk-SECRET')
    expect(text.startsWith('{"concurrency":4,"maxFindings":50,"profiles":[{"profile":{')).toBe(true)
    const provider = {
      baseUrl: PROVIDER.baseUrl,
      contextTokens: 32768,
      model: 'm',
      protocol: 'openai-compatible',
    }
    expect(JSON.parse(text)).toEqual({
      concurrency: 4,
      maxFindings: 50,
      profiles: [
        {
          profile: JSON.parse(JSON.stringify(config.profiles[0].profile)),
          research: provider,
          voters: { reachability: provider, impact: provider, defenses: provider },
        },
      ],
    })
  })

  it('never holds a key, whether the config wrote it, a variable it names or a QUORUM_* variable supplied it', () => {
    const named = resolvedConfig({
      providers: {
        p: { ...PROVIDER, apiKeyEnv: 'GW_KEY' },
      },
    }, { GW_KEY: 'sk-NAMED' })
    expect(Object.values(named.providers).some(provider => 'apiKey' in provider)).toBe(true)
    expect(canonicalSettings(named)).not.toMatch(/sk-NAMED|apiKey/)
    const voter = { QUORUM_VOTER_MODEL: 'v', QUORUM_VOTER_CONTEXT_TOKENS: '32768', QUORUM_VOTER_API_KEY: 'sk-VOTER' }
    const derived = resolvedConfig({
      providers: { p: PROVIDER },
    }, voter)
    expect(Object.values(derived.providers).some(provider => 'apiKey' in provider)).toBe(true)
    expect(canonicalSettings(derived)).not.toMatch(/sk-VOTER|apiKey/)
  })

  it('refuses a profile that names a provider the config does not hold, rather than leave a gap', () => {
    const config = of(PROVIDER)
    const broken = {
      ...config,
      profiles: [
        { ...config.profiles[0], research: 'missing' },
      ],
    }
    expect(() => canonicalSettings(broken)).toThrow(RangeError)
    expect(() => canonicalSettings({ ...config, providers: {} })).toThrow(RangeError)
  })
})

describe('newSalt', () => {
  it('is 64 random hex digits', () => {
    expect(newSalt()).toMatch(/^[0-9a-f]{64}$/)
    expect(newSalt()).not.toBe(newSalt())
  })
})
