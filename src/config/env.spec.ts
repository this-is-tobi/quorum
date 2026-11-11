import { describe, expect, it } from 'vitest'
import type { CompletionResponse, Provider } from '../core/ports.ts'
import { applyRoleOverrides, baseUrlOf, envValue, READ_VARIABLES, readEnv } from './env.ts'
import type { Env, EnvLayer, ProviderEntry, RoleBinding } from './env.ts'
import type { ProviderSettings } from './schema.ts'

const SECRET = 'sk-zz-secret'
const VOTER_MODEL = 'must be set when the voter variables name another endpoint than the research provider\'s'
const PROFILES = 'must list profile ids separated by commas, each matching ^[a-z][a-z0-9_-]*$'

// Typed, so `protocol` and `preset` keep their literal types.
const local: ProviderSettings = { protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }
const research: ProviderSettings = { protocol: 'openai-compatible', baseUrl: 'https://r.example/v1', model: 'r', apiKeyEnv: 'R_KEY', headers: { 'x-team': 'sec' }, query: { v: '1' }, extraBody: { top_k: 20 }, maxTokens: 900 }
const shared: RoleBinding = { research: 'main', voter: 'main' }
const object: Provider = { id: 'x', model: 'm', complete: async (): Promise<CompletionResponse> => ({ text: '', model: 'm' }) }

function apply(providers: Record<string, ProviderEntry>, roles: RoleBinding, layer: Partial<Pick<EnvLayer, 'research' | 'voter'>>): ReturnType<typeof applyRoleOverrides> {
  return applyRoleOverrides(providers, roles, { research: {}, voter: {}, ...layer })
}

describe('envValue', () => {
  it('trims a value and reads a blank or absent one as unset', () => {
    expect(envValue({ A: ' x\n' }, 'A')).toBe('x')
    expect(envValue({ A: '  ' }, 'A')).toBeUndefined()
    expect(envValue({}, 'A')).toBeUndefined()
  })

  it('reads only the environment\'s own variables, never one its prototype holds', () => {
    const env = Object.create({ QUORUM_RESEARCH_BASE_URL: 'https://evil.example/v1' }) as Env
    expect(envValue(env, 'QUORUM_RESEARCH_BASE_URL')).toBeUndefined()
  })
})

describe('readEnv', () => {
  it('reads the five variables of each role, trimmed', () => {
    expect(readEnv({ QUORUM_RESEARCH_PRESET: ' anthropic ', QUORUM_RESEARCH_MODEL: 'claude-sonnet-5', QUORUM_VOTER_PROTOCOL: 'ollama', QUORUM_VOTER_BASE_URL: 'http://gpu:11434', QUORUM_VOTER_API_KEY: 'sk-v' })).toEqual({
      research: { preset: 'anthropic', model: 'claude-sonnet-5' },
      voter: { protocol: 'ollama', baseUrl: 'http://gpu:11434', apiKey: 'sk-v' },
      warnings: [],
      issues: [],
    })
  })

  it('reads RESEARCH_* and VOTER_* as deprecated aliases, with one warning that names them all', () => {
    expect(readEnv({ RESEARCH_MODEL: 'qwen', RESEARCH_BASE_URL: 'http://h/v1', VOTER_API_KEY: 'sk-v' })).toEqual({
      research: { baseUrl: 'http://h/v1', model: 'qwen' },
      voter: { apiKey: 'sk-v' },
      warnings: ['RESEARCH_BASE_URL, RESEARCH_MODEL and VOTER_API_KEY are deprecated: set QUORUM_RESEARCH_BASE_URL, QUORUM_RESEARCH_MODEL and QUORUM_VOTER_API_KEY instead'],
      issues: [],
    })
    expect(readEnv({ VOTER_MODEL: 'v' }).warnings).toEqual(['VOTER_MODEL is deprecated: set QUORUM_VOTER_MODEL instead'])
  })

  it('lets the QUORUM_ form win over its alias, and still warns about the alias', () => {
    expect(readEnv({ QUORUM_RESEARCH_MODEL: 'new', RESEARCH_MODEL: 'old' })).toEqual({
      research: { model: 'new' },
      voter: {},
      warnings: ['RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead'],
      issues: [],
    })
  })

  it('reads a blank alias as unset, with no warning, and knows no alias of a preset or a protocol', () => {
    expect(readEnv({ RESEARCH_MODEL: ' ', VOTER_BASE_URL: '', RESEARCH_PRESET: 'openai', VOTER_PROTOCOL: 'ollama' })).toEqual({ research: {}, voter: {}, warnings: [], issues: [] })
  })

  it('reads QUORUM_PROFILES as a list of profile ids', () => {
    expect(readEnv({ QUORUM_PROFILES: ' security , team-style ' }).profiles).toEqual(['security', 'team-style'])
    expect(readEnv({ QUORUM_PROFILES: ' ' }).profiles).toBeUndefined()
  })

  it.each([[','], ['security,,team'], ['Security'], ['security;team']])('refuses QUORUM_PROFILES=%j, naming no profile', (value) => {
    const layer = readEnv({ QUORUM_PROFILES: value })
    expect(layer.issues).toEqual([{ path: 'QUORUM_PROFILES', message: PROFILES }])
    expect(layer.profiles).toBeUndefined()
  })

  it('refuses a profile named twice in QUORUM_PROFILES', () => {
    expect(readEnv({ QUORUM_PROFILES: 'security,security' }).issues).toEqual([{ path: 'QUORUM_PROFILES', message: 'names a profile more than once' }])
  })

  it('repeats no value in a warning or an issue', () => {
    const layer = readEnv({ RESEARCH_API_KEY: SECRET, QUORUM_PROFILES: `${SECRET}!` })
    expect(JSON.stringify([layer.warnings, layer.issues])).not.toContain('zz')
  })
})

describe('the variables quorum does not read', () => {
  const QUORUM_VARIABLES = [...READ_VARIABLES].filter(name => name.startsWith('QUORUM_'))

  it('names each QUORUM_ variable it does not read, sorted, in one warning after the deprecation line', () => {
    expect(readEnv({ QUORUM_VOTER_BASEURL: 'https://v.example/v1', QUORUM_PROFILE: 'security', RESEARCH_MODEL: 'm' }).warnings).toEqual([
      'RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead',
      'QUORUM_PROFILE and QUORUM_VOTER_BASEURL are not variables quorum reads',
    ])
    expect(readEnv({ QUORUM_DEBUG: '1' }).warnings).toEqual(['QUORUM_DEBUG is not a variable quorum reads'])
  })

  it('warns about none of the variables it reads', () => {
    expect(QUORUM_VARIABLES).toContain('QUORUM_RESEARCH_API_KEY')
    expect(readEnv(Object.fromEntries(QUORUM_VARIABLES.map(name => [name, 'x']))).warnings).toEqual([])
  })

  it('ignores a blank variable, and one the environment only inherits', () => {
    expect(readEnv({ QUORUM_PROFILE: '  ' }).warnings).toEqual([])
    expect(readEnv(Object.create({ QUORUM_PROFILE: 'security' }) as Env).warnings).toEqual([])
  })

  it('prints a name of 64 characters, and one of 65 as *', () => {
    const name = (length: number): string => `QUORUM_${'A'.repeat(length - 'QUORUM_'.length)}`
    expect(readEnv({ [name(64)]: 'sk-SECRET' }).warnings).toEqual([`${name(64)} is not a variable quorum reads`])
    expect(readEnv({ [name(65)]: 'sk-SECRET' }).warnings).toEqual(['* is not a variable quorum reads'])
  })

  it('prints a name that is not an upper-case variable name as *, and never a value', () => {
    const warnings = readEnv({ QUORUM_research_model: 'sk-SECRET', QUORUM_PROFILE: 'sk-SECRET' }).warnings
    expect(warnings).toEqual(['QUORUM_PROFILE and * are not variables quorum reads'])
    expect(warnings.join('\n')).not.toContain('SECRET')
  })
})

describe('baseUrlOf', () => {
  it('reads the base URL and the preset of settings as their own fields, never what a polluted Object.prototype holds', () => {
    const proto = Object.prototype as Record<string, unknown>
    const planted: Record<string, unknown> = { baseUrl: 'https://planted.example/v1', preset: 'groq' }
    for (const [key, value] of Object.entries(planted)) proto[key] = value
    try {
      expect(baseUrlOf({ protocol: 'ollama' })).toBeUndefined()
      expect(baseUrlOf({ preset: 'openai' })).toBe('https://api.openai.com/v1')
      expect(baseUrlOf({ protocol: 'ollama', baseUrl: 'http://h:11434' })).toBe('http://h:11434')
    } finally {
      for (const key of Object.keys(planted)) delete proto[key]
    }
  })
})

describe('applyRoleOverrides', () => {
  it('changes nothing when no variable is set', () => {
    expect(apply({ main: research }, shared, {})).toEqual({ providers: { main: research }, roles: shared, issues: [] })
  })

  it('sets the research variables on the provider research is bound to, which a voter sharing it inherits', () => {
    expect(apply({ main: local }, shared, { research: { model: 'qwen', apiKey: 'sk-r' } })).toEqual({ providers: { main: { ...local, model: 'qwen', apiKey: 'sk-r' } }, roles: shared, issues: [] })
  })

  it('derives a voter on the research provider\'s endpoint that keeps everything it has', () => {
    expect(apply({ main: research }, shared, { voter: { model: 'v', baseUrl: 'HTTPS://R.EXAMPLE:443/v2' } })).toEqual({
      providers: { main: research, voter: { ...research, baseUrl: 'HTTPS://R.EXAMPLE:443/v2', model: 'v' } },
      roles: { research: 'main', voter: 'voter' },
      issues: [],
    })
  })

  it('derives a voter on another endpoint with no key, header, query, body field or model of the research provider (ADR-0013)', () => {
    expect(apply({ main: research }, shared, { voter: { baseUrl: 'https://v.example/v1', model: 'v' } }).providers.voter).toEqual({ protocol: 'openai-compatible', baseUrl: 'https://v.example/v1', model: 'v', maxTokens: 900 })
  })

  it.each([['another scheme', 'http://r.example/v1'], ['another port', 'https://r.example:8443/v1'], ['no scheme', 'r.example/v1'], ['another host', 'https://other.example/v1']])('counts %s as another endpoint, and requires the voter\'s model', (_name, baseUrl) => {
    expect(apply({ main: research }, shared, { voter: { baseUrl } })).toEqual({
      providers: { main: research, voter: { protocol: 'openai-compatible', baseUrl, maxTokens: 900 } },
      roles: { research: 'main', voter: 'voter' },
      issues: [{ path: 'QUORUM_VOTER_MODEL', message: VOTER_MODEL }],
    })
  })

  it('never matches a base URL without an http origin, not even the same text', () => {
    const unparsed: ProviderSettings = { ...research, baseUrl: 'localhost:11434/v1' }
    expect(apply({ main: unparsed }, shared, { voter: { baseUrl: 'localhost:11434/v1' } }).issues).toEqual([{ path: 'QUORUM_VOTER_MODEL', message: VOTER_MODEL }])
  })

  it('keeps everything for a host that differs only by a trailing dot', () => {
    expect(apply({ main: research }, shared, { voter: { baseUrl: 'https://r.example./v1' } }).providers.voter).toEqual({ ...research, baseUrl: 'https://r.example./v1' })
  })

  it('reads the endpoint of a preset that sets no base URL', () => {
    const openai: ProviderSettings = { preset: 'openai', model: 'gpt-5', apiKey: 'sk-o' }
    expect(apply({ main: openai }, shared, { voter: { baseUrl: 'https://api.openai.com/v1/', model: 'gpt-5-mini' } }).providers.voter).toEqual({ ...openai, baseUrl: 'https://api.openai.com/v1/', model: 'gpt-5-mini' })
    expect(apply({ main: openai }, shared, { voter: { baseUrl: 'https://gw.example/v1', model: 'm' } }).providers.voter).toEqual({ preset: 'openai', baseUrl: 'https://gw.example/v1', model: 'm' })
  })

  it('builds a provider from the variables alone once a role names a preset or a protocol', () => {
    expect(apply({ default: local }, { research: 'default', voter: 'default' }, { research: { preset: 'anthropic', model: 'claude-sonnet-5' } }).providers).toEqual({ default: { preset: 'anthropic', model: 'claude-sonnet-5' } })
    expect(apply({ main: research }, shared, { voter: { preset: 'mistral', model: 'mistral-small-latest' } }).providers).toEqual({ main: research, voter: { preset: 'mistral', model: 'mistral-small-latest' } })
    expect(apply({ main: { preset: 'ollama', model: 'q' } }, shared, { research: { protocol: 'openai-compatible', baseUrl: 'http://h/v1' } }).providers).toEqual({ main: { protocol: 'openai-compatible', baseUrl: 'http://h/v1' } })
    expect(apply({ main: research }, shared, { voter: { preset: 'mistral' } }).issues).toEqual([{ path: 'QUORUM_VOTER_MODEL', message: VOTER_MODEL }])
  })

  it('sets the voter variables on the voter\'s own provider when it has one', () => {
    expect(apply({ main: research, panel: local }, { research: 'main', voter: 'panel' }, { voter: { model: 'v' } })).toEqual({ providers: { main: research, panel: { ...local, model: 'v' } }, roles: { research: 'main', voter: 'panel' }, issues: [] })
  })

  it('refuses each variable of a role bound to a provider object, which no variable can change', () => {
    const roles = { research: 'mine', voter: 'mine' }
    expect(apply({ mine: object }, roles, { research: { model: 'm2', apiKey: 'k' } }).issues).toEqual([
      { path: 'QUORUM_RESEARCH_MODEL', message: 'cannot change providers.mine, an object implementing Provider' },
      { path: 'QUORUM_RESEARCH_API_KEY', message: 'cannot change providers.mine, an object implementing Provider' },
    ])
    expect(apply({ mine: object }, roles, { voter: { model: 'v' } }).issues).toEqual([{ path: 'QUORUM_VOTER_MODEL', message: 'cannot change providers.mine, an object implementing Provider' }])
  })

  it('refuses to derive a voter over a provider already named voter', () => {
    expect(apply({ voter: research }, { research: 'voter', voter: 'voter' }, { voter: { model: 'v' } }).issues).toEqual([{ path: 'providers.voter', message: 'is the name the voter variables give the provider they derive: rename this provider' }])
  })

  it('keeps a derived voter on the research endpoint when only its own variables are read, whatever a polluted Object.prototype holds', () => {
    const proto = Object.prototype as Record<string, unknown>
    proto.baseUrl = 'https://planted.example/v1'
    try {
      expect(apply({ main: research }, shared, { voter: { model: 'v' } }).providers.voter).toEqual({ ...research, model: 'v' })
    } finally {
      delete proto.baseUrl
    }
  })

  it('returns an issue, and applies nothing, for a role bound to a provider that is not defined', () => {
    const layer = { research: { model: 'r2' }, voter: { model: 'v' } }
    expect(apply({ main: research }, { research: 'gone', voter: 'main' }, layer)).toEqual({
      providers: { main: research },
      roles: { research: 'gone', voter: 'main' },
      issues: [{ path: 'roles.research', message: 'unknown provider "gone": the providers are main' }],
    })
    expect(apply({ main: research }, { research: 'main', voter: 'gone' }, layer).issues).toEqual([{ path: 'roles.voter', message: 'unknown provider "gone": the providers are main' }])
  })

  it('takes a role name a prototype holds for no provider, and prints a name that is not a safe name by its kind alone', () => {
    expect(apply({ main: research }, { research: 'toString', voter: 'main' }, { research: { model: 'r2' } }).issues).toEqual([{ path: 'roles.research', message: 'unknown provider "toString": the providers are main' }])
    expect(apply({ main: research }, { research: 'main', voter: `${SECRET} key` }, {}).issues).toEqual([{ path: 'roles.voter', message: 'names an unknown provider: the providers are main' }])
  })

  it('changes none of the objects it is given', () => {
    const frozen = Object.freeze({ main: Object.freeze({ ...research, headers: Object.freeze({ ...research.headers }) }) })
    expect(() => apply(frozen, Object.freeze({ ...shared }), { research: { model: 'r2' }, voter: { baseUrl: 'https://v.example/v1', model: 'v' } })).not.toThrow()
    expect(frozen.main.model).toBe('r')
  })

  it('repeats no value in an issue', () => {
    const { issues } = apply({ mine: object }, { research: 'mine', voter: 'mine' }, { research: { apiKey: SECRET, baseUrl: `https://${SECRET}.example` } })
    expect(JSON.stringify(issues)).not.toContain('zz')
  })
})
