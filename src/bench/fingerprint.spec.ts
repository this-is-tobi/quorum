import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../config/resolve.ts'
import type { ConfigInput } from '../config/schema.ts'
import { documentSha256 } from '../core/documents.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { canonicalSettings, fingerprint, newSalt, providerIdentity } from './fingerprint.ts'

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

  it('tells code-review from security, and a code-review that sets maxFindings or changedLinesOnly from the built-in one', () => {
    const configured = (profiles: Record<string, unknown>): ResolvedConfig => resolvedConfig({
      providers: { p: PROVIDER },
      profiles,
    } as ConfigInput)
    const review = configured({ 'code-review': {} })
    expect(same(review, of(PROVIDER))).toBe(false)
    expect(same(configured({
      'code-review': { maxFindings: 30 },
    }), review)).toBe(false)
    expect(same(configured({
      'code-review': { changedLinesOnly: false },
    }), review)).toBe(false)
    // A value the built-in profile already holds is no change, and the form holds the two fields only when the profile does.
    expect(same(configured({
      'code-review': { maxFindings: 20 },
    }), review)).toBe(true)
    expect(canonicalSettings(review)).toContain('"maxFindings":20')
    expect(canonicalSettings(review)).toContain('"changedLinesOnly":true')
    expect(canonicalSettings(of(PROVIDER))).not.toContain('"changedLinesOnly"')
    // The base a profile starts from is no part of the form: a profile that extends one is the one it resolves to.
    expect(canonicalSettings(of(PROVIDER))).not.toContain('"base"')
    // A configuration of security alone and one of a profile of its own keep the fingerprints they had.
    expect(fingerprint(of(PROVIDER), SALT)).toBe('f55669a5bb98cb55e4416cdaf20ca6aa12a3154a45df7b0cfea145478a3d81a8')
    expect(fingerprint(configured({
      team: {
        prompts: { research: 'Find style issues.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
        lenses: [
          { id: 'grounded', question: 'Backed by a convention?' },
        ],
      },
    }), SALT)).toBe('a420b59732101ceda4e6e9b3645f35183a944adcb7dd11339a4ab85837a874ad')
  })

  it('holds failOn in the form, so gating false and failOn none fingerprint alike', () => {
    const security = (fields: Record<string, unknown>): ResolvedConfig => resolvedConfig({
      providers: { p: PROVIDER },
      profiles: { security: fields },
    } as ConfigInput)
    expect(same(security({ gating: false }), security({ failOn: 'none' }))).toBe(true)
    expect(same(security({ gating: true }), security({ failOn: 'high' }))).toBe(true)
    expect(same(security({ failOn: 'high' }), of(PROVIDER))).toBe(true)
    expect(same(security({ failOn: 'medium' }), of(PROVIDER))).toBe(false)
    expect(same(security({ failOn: 'none' }), of(PROVIDER))).toBe(false)
    expect(canonicalSettings(security({ gating: false }))).toContain('"failOn":"none"')
  })

  it('moves a configuration\'s fingerprint with a file guideline\'s text, and keeps it for one that names none', () => {
    const team = {
      prompts: { research: 'Find style issues.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
      lenses: [
        { id: 'grounded', question: 'Backed by a convention?' },
      ],
    }
    const configured = (fields: Record<string, unknown>): ResolvedConfig => resolvedConfig({
      providers: { p: PROVIDER },
      profiles: {
        team: {
          ...team,
          ...fields,
        },
      },
    } as ConfigInput)
    const none = configured({})
    // The form of a configuration with no document holds no key for one, so its fingerprint is the one 0.12.0 gave it.
    expect(canonicalSettings(none)).not.toContain('"documents"')
    expect(canonicalSettings(none)).not.toContain('"doNotReport"')
    expect(fingerprint(none, SALT)).toBe('a420b59732101ceda4e6e9b3645f35183a944adcb7dd11339a4ab85837a874ad')
    expect(same(configured({ guidelines: [], doNotReport: [] }), none)).toBe(true)

    const guided = configured({
      guidelines: [
        { text: 'Use parameters.' },
      ],
    })
    expect(same(guided, none)).toBe(false)
    expect(canonicalSettings(guided)).toContain(documentSha256('Use parameters.'))
    expect(same(guided, configured({
      guidelines: [
        { text: 'Use parameters.' },
      ],
    }))).toBe(true)
    expect(same(configured({
      guidelines: [
        { text: 'Use named parameters.' },
      ],
    }), guided)).toBe(false)
    expect(same(configured({
      doNotReport: [
        { text: 'Use parameters.' },
      ],
    }), guided)).toBe(false)
  })

  it('moves a configuration\'s fingerprint with a rule\'s id, text or paths and with requireRule, and keeps it for one that lists no rule', () => {
    const team = {
      prompts: { research: 'Find style issues.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
      lenses: [
        { id: 'grounded', question: 'Backed by a convention?' },
      ],
    }
    const configured = (fields: Record<string, unknown>): ResolvedConfig => resolvedConfig({
      providers: { p: PROVIDER },
      profiles: {
        team: {
          ...team,
          ...fields,
        },
      },
    } as ConfigInput)
    const none = configured({})
    // The form of a configuration that lists no rule holds no key for one, so its fingerprint is the one it had before rules.
    expect(canonicalSettings(none)).not.toContain('"rules"')
    expect(canonicalSettings(none)).not.toContain('"requireRule"')
    expect(fingerprint(none, SALT)).toBe('a420b59732101ceda4e6e9b3645f35183a944adcb7dd11339a4ab85837a874ad')
    expect(same(configured({ rules: [], requireRule: false, builtInRules: false }), none)).toBe(true)

    const rule = {
      id: 'no-any',
      text: 'No any outside tests.',
      paths: ['src/**'],
    }
    const ruled = configured({
      rules: [rule],
    })
    expect(same(ruled, none)).toBe(false)
    expect(canonicalSettings(ruled)).toContain('"id":"no-any"')
    expect(same(ruled, configured({
      rules: [
        { ...rule },
      ],
    }))).toBe(true)
    // Each part of a rule moves it: its id, its text, its paths, and a rule written as a file by the hash and the rules of its text.
    for (const changed of [
      { ...rule, id: 'no-any-type' },
      { ...rule, text: 'No any anywhere.' },
      {
        ...rule,
        paths: ['lib/**'],
      },
      { id: rule.id, text: rule.text },
    ]) {
      expect(same(configured({
        rules: [changed],
      }), ruled)).toBe(false)
    }
    const file = configured({
      rules: [
        {
          text: JSON.stringify([rule]),
          format: 'json',
        },
      ],
    })
    expect(same(file, ruled)).toBe(false)
    expect(canonicalSettings(file)).toContain(documentSha256(JSON.stringify([rule])))
    expect(same(file, configured({
      rules: [
        {
          text: JSON.stringify([
            { ...rule, text: 'No any anywhere.' },
          ]),
          format: 'json',
        },
      ],
    }))).toBe(false)
    // requireRule moves it, and a value that changes nothing does not.
    const required = configured({
      rules: [rule],
      requireRule: true,
    })
    expect(same(required, ruled)).toBe(false)
    expect(canonicalSettings(required)).toContain('"requireRule":true')
    expect(same(configured({
      rules: [rule],
      requireRule: false,
    }), ruled)).toBe(true)
    expect(same(configured({ requireRule: true }), none)).toBe(false)
  })

  it('fills the defaults, so an unset limit and its default are alike', () => {
    expect(same(resolvedConfig({
      providers: { p: PROVIDER },
      maxFindings: 50,
    }), of(PROVIDER))).toBe(true)
    expect(same(resolvedConfig({
      providers: { p: PROVIDER },
      concurrency: 2,
    }), of(PROVIDER))).toBe(false)
  })

  it('holds concurrency auto when unset, so a set one, 4 included, is another configuration', () => {
    expect(JSON.parse(canonicalSettings(of(PROVIDER)))).toMatchObject({ concurrency: 'auto' })
    expect(JSON.parse(canonicalSettings(resolvedConfig({
      providers: { p: PROVIDER },
      concurrency: 4,
    })))).toMatchObject({ concurrency: 4 })
    expect(same(resolvedConfig({
      providers: { p: PROVIDER },
      concurrency: 4,
    }), of(PROVIDER))).toBe(false)
  })

  it('changes with the review\'s limits, and holds their defaults when unset', () => {
    const providers = { p: PROVIDER }
    const plain = resolvedConfig({ providers })
    expect(same(resolvedConfig({ providers, maxReviewTokens: 500000 }), plain)).toBe(false)
    expect(same(resolvedConfig({ providers, reviewTimeoutMs: 600000 }), plain)).toBe(false)
    expect(same(resolvedConfig({ providers, maxReviewTokens: 2000000, reviewTimeoutMs: 1800000 }), plain)).toBe(true)
  })

  it('holds findingsCap only when the config sets it, so a configuration that sets none keeps its fingerprint', () => {
    const providers = { p: PROVIDER }
    const plain = resolvedConfig({ providers })
    expect(canonicalSettings(plain)).not.toContain('findingsCap')
    expect(canonicalSettings(resolvedConfig({ providers, maxFindings: 50 }))).toBe(canonicalSettings(plain))
    const capped = resolvedConfig({ providers, findingsCap: 300 })
    expect((JSON.parse(canonicalSettings(capped)) as { findingsCap: unknown }).findingsCap).toBe(300)
    expect(same(capped, plain)).toBe(false)
    expect(same(capped, resolvedConfig({ providers, findingsCap: 301 }))).toBe(false)
    // Equal to the default is still a setting: the form names it, as a set concurrency of 4 is another configuration.
    expect(same(resolvedConfig({ providers, findingsCap: 50 }), plain)).toBe(false)
  })

  it('changes with partTokens, and holds its default when unset', () => {
    const providers = { p: PROVIDER }
    const plain = resolvedConfig({ providers })
    expect(same(resolvedConfig({ providers, partTokens: 4096 }), plain)).toBe(false)
    expect(same(resolvedConfig({ providers, partTokens: 32768 }), plain)).toBe(true)
  })

  it('holds exclude when the config lists a pattern, and leaves a config without one as it was', () => {
    const plain = resolvedConfig({
      providers: { p: PROVIDER },
    })
    const none = resolvedConfig({
      providers: { p: PROVIDER },
      exclude: [],
    })
    const one = resolvedConfig({
      providers: { p: PROVIDER },
      exclude: ['*.lock'],
    })
    expect(canonicalSettings(none)).toBe(canonicalSettings(plain))
    expect(canonicalSettings(plain)).not.toContain('exclude')
    expect(same(one, plain)).toBe(false)
    expect((JSON.parse(canonicalSettings(one)) as { exclude: unknown }).exclude).toEqual(['*.lock'])
  })

  it('holds send in the form when the config lists a file, and keeps the form of a config that lists none', () => {
    const plain = resolvedConfig({
      providers: { p: PROVIDER },
    })
    const none = resolvedConfig({
      providers: { p: PROVIDER },
      send: [],
    })
    const one = resolvedConfig({
      providers: { p: PROVIDER },
      send: ['src/.env'],
    })
    const other = resolvedConfig({
      providers: { p: PROVIDER },
      send: ['src/.env.production'],
    })
    expect(canonicalSettings(none)).toBe(canonicalSettings(plain))
    expect(Object.hasOwn(JSON.parse(canonicalSettings(plain)) as object, 'send')).toBe(false)
    expect(same(one, plain)).toBe(false)
    expect(same(one, other)).toBe(false)
    expect((JSON.parse(canonicalSettings(one)) as { send: unknown }).send).toEqual(['src/.env'])
  })

  it('reads a provider object by its config key and its model, never its code', () => {
    expect(same(of(object('m'), 'fake'), of(object('m'), 'fake'))).toBe(true)
    expect(same(of(object('m'), 'fake'), of(object('m'), 'other'))).toBe(false)
    expect(same(of(object('m'), 'fake'), of(object('n'), 'fake'))).toBe(false)
  })

  it('holds a provider object\'s stated deadline and retries beside its key and model, and leaves one that states none as it was', () => {
    const stated = of({
      ...object('m'),
      timeoutMs: 120000,
    }, 'fake')
    const unstated = of(object('m'), 'fake')
    expect(same(stated, unstated)).toBe(false)
    const researchOf = (config: ResolvedConfig): unknown => (JSON.parse(canonicalSettings(config)) as { profiles: Array<{ research: unknown }> }).profiles[0].research
    expect(researchOf(stated)).toEqual({ model: 'm', object: 'fake', timeoutMs: 120000 })
    expect(researchOf(unstated)).toEqual({ model: 'm', object: 'fake' })
  })

  it('holds the window, the maxTokens and the thinking a provider object states beside its deadline', () => {
    const stated = of({
      ...object('m'),
      window: 8192,
      maxTokens: 700,
      thinking: 'low',
    }, 'fake')
    const researchOf = (config: ResolvedConfig): unknown => (JSON.parse(canonicalSettings(config)) as { profiles: Array<{ research: unknown }> }).profiles[0].research
    expect(researchOf(stated)).toEqual({
      model: 'm',
      object: 'fake',
      window: 8192,
      maxTokens: 700,
      thinking: 'low',
    })
    expect(same(stated, of(object('m'), 'fake'))).toBe(false)
    expect(same(stated, of({
      ...object('m'),
      window: 8192,
      maxTokens: 700,
      thinking: 'off',
    }, 'fake'))).toBe(false)
  })

  it('never holds the worstCase a provider object states: one that states it is the same configuration as one that does not', () => {
    const stated = of({
      ...object('m'),
      worstCase: () => 123456,
    }, 'fake')
    const unstated = of(object('m'), 'fake')
    expect(same(stated, unstated)).toBe(true)
  })

  it('never holds the room a provider object states: one that states it is the same configuration as one that does not', () => {
    const stated = of({
      ...object('m'),
      room: () => 123456,
    }, 'fake')
    const unstated = of(object('m'), 'fake')
    expect(same(stated, unstated)).toBe(true)
  })

  it('changes with a provider\'s timeoutMs or retries', () => {
    expect(same(of({ ...PROVIDER, retries: 0 }), of(PROVIDER))).toBe(false)
    expect(same(of({ ...PROVIDER, timeoutMs: 120000 }), of(PROVIDER))).toBe(false)
    expect(same(of({ ...PROVIDER, stallTimeoutMs: 300000 }), of(PROVIDER))).toBe(false)
  })

  it('moves the fingerprint when thinking is set, and keeps it when it is not', () => {
    expect(same(of({ ...PROVIDER, thinking: 'low' }), of(PROVIDER))).toBe(false)
    expect(same(of({ ...PROVIDER, thinking: 'off' }), of({ ...PROVIDER, thinking: 'low' }))).toBe(false)
    expect(same(of({ ...PROVIDER, thinking: undefined }), of(PROVIDER))).toBe(true)
  })

  it('changes with the salt', () => {
    expect(fingerprint(of(PROVIDER), SALT)).not.toBe(fingerprint(of(PROVIDER), 'b'.repeat(64)))
  })

  it.each([
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    `g${'a'.repeat(63)}`,
    `${'a'.repeat(64)}\n`,
  ])('refuses the salt %j, in a message that never holds it', (salt) => {
    let thrown: unknown
    try {
      fingerprint(of(PROVIDER), salt)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RangeError)
    expect((thrown as RangeError).message).toBe('the salt must be 64 lowercase hex digits')
  })
})

describe('canonicalSettings', () => {
  it('holds every setting a review uses, providers written out, keys sorted, and never the key', () => {
    const config = of({ ...PROVIDER, apiKey: 'sk-SECRET' })
    const text = canonicalSettings(config)
    expect(text).not.toContain('sk-SECRET')
    expect(text.startsWith('{"concurrency":"auto","maxFindings":50,"maxReviewTokens":2000000,"partTokens":32768,"profiles":[{"profile":{')).toBe(true)
    expect(text.endsWith(',"reviewTimeoutMs":1800000}')).toBe(true)
    const provider = {
      baseUrl: PROVIDER.baseUrl,
      contextTokens: 32768,
      model: 'm',
      protocol: 'openai-compatible',
    }
    expect(JSON.parse(text)).toEqual({
      concurrency: 'auto',
      maxFindings: 50,
      maxReviewTokens: 2000000,
      partTokens: 32768,
      profiles: [
        {
          profile: JSON.parse(JSON.stringify(config.profiles[0].profile)),
          research: provider,
          voters: { reachability: provider, impact: provider, defenses: provider },
        },
      ],
      reviewTimeoutMs: 1800000,
    })
  })

  it('is the same whatever order the config writes its keys in, and sorts them at every depth', () => {
    const written = {
      model: 'm',
      protocol: 'openai-compatible',
      baseUrl: PROVIDER.baseUrl,
      contextTokens: 32768,
      headers: { 'x-a': '1', 'x-b': '2' },
      query: { alpha: 'a', beta: 'b' },
      extraBody: {
        reasoning: { effort: 'low', budget: 3 },
        seed: 7,
      },
    }
    const reversed = {
      extraBody: {
        seed: 7,
        reasoning: { budget: 3, effort: 'low' },
      },
      query: { beta: 'b', alpha: 'a' },
      headers: { 'x-b': '2', 'x-a': '1' },
      contextTokens: 32768,
      baseUrl: PROVIDER.baseUrl,
      protocol: 'openai-compatible',
      model: 'm',
    }
    expect(Object.keys(written)).not.toEqual(Object.keys(reversed))
    const policy = {
      high: { minVotes: 2 },
      medium: 'any',
      low: 'off',
    } as const
    const first = resolvedConfig({
      providers: { p: written },
      profiles: {
        security: { policy },
      },
    } as ConfigInput)
    const second = resolvedConfig({
      providers: { p: reversed },
      profiles: {
        security: {
          policy: {
            low: 'off',
            medium: 'any',
            high: { minVotes: 2 },
          },
        },
      },
    } as ConfigInput)
    expect(canonicalSettings(first)).toBe(canonicalSettings(second))
    expect(same(first, second)).toBe(true)
    const research = JSON.parse(canonicalSettings(first)).profiles[0].research
    const keysAt = (value: object): string[] => Object.keys(value)
    for (const level of [
      research,
      research.headers,
      research.query,
      research.extraBody,
      research.extraBody.reasoning,
    ]) {
      expect(keysAt(level)).toEqual(keysAt(level).sort())
    }
    expect(keysAt(research)).toEqual([
      'baseUrl',
      'contextTokens',
      'extraBody',
      'headers',
      'model',
      'protocol',
      'query',
    ])
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

describe('providerIdentity', () => {
  const identityOf = (provider: Record<string, unknown>, name = 'p'): string => providerIdentity(of(provider, name).providers[name])

  it('leaves out the key, timeoutMs and retries of a spec, and the bench fingerprint keeps them', () => {
    const base = identityOf(PROVIDER)
    expect(identityOf({ ...PROVIDER, timeoutMs: 120000 })).toBe(base)
    expect(identityOf({ ...PROVIDER, retries: 5 })).toBe(base)
    expect(identityOf({ ...PROVIDER, stallTimeoutMs: 300000 })).toBe(base)
    expect(identityOf({
      ...PROVIDER,
      timeoutMs: 120000,
      retries: 0,
      apiKey: 'a-secret',
    })).toBe(base)
    expect(base).not.toContain('timeoutMs')
    expect(same(of({ ...PROVIDER, timeoutMs: 120000 }), of(PROVIDER))).toBe(false)
    expect(same(of({ ...PROVIDER, stallTimeoutMs: 300000 }), of(PROVIDER))).toBe(false)
  })

  it('leaves out the timeoutMs and retries a provider object states, and keeps every other field', () => {
    const base = identityOf(object('m'), 'fake')
    expect(identityOf({
      ...object('m'),
      timeoutMs: 120000,
      stallTimeoutMs: 300000,
      retries: 4,
    }, 'fake')).toBe(base)
    expect(identityOf({
      ...object('n'),
    }, 'fake')).not.toBe(base)
    expect(identityOf({
      ...object('m'),
      window: 8192,
    }, 'fake')).not.toBe(base)
    expect(identityOf({
      ...object('m'),
      maxTokens: 700,
    }, 'fake')).not.toBe(base)
    expect(identityOf({
      ...object('m'),
      thinking: 'low',
    }, 'fake')).not.toBe(base)
    expect(identityOf(object('m'), 'other')).not.toBe(base)
  })

  it('leaves stream out of a provider\'s identity and keeps it in the fingerprint', () => {
    const base = identityOf(PROVIDER)
    for (const stream of [true, false]) {
      expect(identityOf({ ...PROVIDER, stream }), String(stream)).toBe(base)
      expect(same(of({ ...PROVIDER, stream }), of(PROVIDER)), String(stream)).toBe(false)
    }
    expect(same(of({ ...PROVIDER, stream: true }), of({ ...PROVIDER, stream: false }))).toBe(false)
    expect(base).not.toContain('stream')
    // A provider object that states it streams is the same provider as one that states nothing: the stream decides whether a reply arrives, never what it says.
    const objectBase = identityOf(object('m'), 'fake')
    expect(identityOf({
      ...object('m'),
      streams: true,
    }, 'fake')).toBe(objectBase)
    expect(same(of({
      ...object('m'),
      streams: true,
    }, 'fake'), of(object('m'), 'fake'))).toBe(false)
    // Nor do the slots it states: they decide how many calls it takes at once, never what a reply says, and the fingerprint keeps them.
    expect(identityOf({
      ...object('m'),
      slots: 2,
    }, 'fake')).toBe(objectBase)
    expect(same(of({
      ...object('m'),
      slots: 2,
    }, 'fake'), of(object('m'), 'fake'))).toBe(false)
  })

  it.each([
    [
      'the model',
      { model: 'n' },
    ],
    [
      'the context size',
      { contextTokens: 8192 },
    ],
    [
      'the base URL',
      { baseUrl: 'https://gw.example/team-b/v1' },
    ],
    [
      'a header value',
      {
        headers: { 'x-team': 'b' },
      },
    ],
    [
      'the thinking level',
      { thinking: 'low' },
    ],
  ])('still changes with %s of a spec', (_name, change) => {
    expect(identityOf({
      ...PROVIDER,
      ...change,
    })).not.toBe(identityOf(PROVIDER))
  })
})

describe('newSalt', () => {
  it('is 64 random hex digits', () => {
    expect(newSalt()).toMatch(/^[0-9a-f]{64}$/)
    expect(newSalt()).not.toBe(newSalt())
  })
})
