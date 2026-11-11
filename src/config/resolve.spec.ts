import { describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionResponse, Provider } from '../core/ports.ts'
import type { Env } from './env.ts'
import { isResolvedConfig, resolveConfig } from './resolve.ts'
import type { ConfigInput, ProviderSettings } from './schema.ts'

// A fixture held in a constant is typed ProviderSettings, so `protocol` and `preset` keep their literal types.
const SECRET = 'sk-zz-secret'
const NO_MODEL = 'no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one'
const PROFILES = 'must list profile ids separated by commas, each matching ^[a-z][a-z0-9_-]*$'
const VOTER_MODEL = 'must be set when the voter variables name another endpoint than the research provider\'s'
const LOCAL = { protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }
const TEAM = { prompts: { research: 'Find style issues in this diff.', vote: 'Judge from {{lens.id}}: {{lens.question}}' }, lenses: [{ id: 'grounded', question: 'Is it backed by a stated convention?' }] }
const all = (name: string) => ({ reachability: name, impact: name, defenses: name })
const object: Provider = { id: 'x', model: 'm', complete: async (): Promise<CompletionResponse> => ({ text: '', model: 'm' }) }

const resolve = (input: ConfigInput, env: Env = {}): ReturnType<typeof resolveConfig> => resolveConfig(input, { env })

/** The issues of the ConfigError that resolving throws; none when it resolves. */
function issuesOf(input: ConfigInput, env: Env = {}): readonly ConfigIssue[] {
  try {
    resolve(input, env)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues
  }
  return []
}

describe('resolveConfig', () => {
  it('resolves the environment alone to the built-in default provider, bound to both roles, and the security profile', () => {
    const config = resolve({}, { QUORUM_RESEARCH_MODEL: 'qwen3.6:27b' })
    expect(config.providers).toEqual({ default: { ...LOCAL, model: 'qwen3.6:27b' } })
    expect(config.profiles.map(({ profile, research, voters }) => [profile.id, research, voters])).toEqual([['security', 'default', all('default')]])
    expect(config.warnings).toEqual([])
    expect(resolve({ providers: {} }, { QUORUM_RESEARCH_MODEL: 'q' }).providers).toEqual({ default: { ...LOCAL, model: 'q' } })
  })

  it('refuses a run with no model anywhere, naming the variable to set', () => {
    expect(issuesOf({})).toEqual([{ path: '', message: NO_MODEL }])
  })

  it('reads the deprecated aliases as today\'s CLI does, with one warning', () => {
    const config = resolve({}, { RESEARCH_MODEL: 'qwen', RESEARCH_API_KEY: 'sk-r', VOTER_BASE_URL: 'https://api.mistral.ai/v1', VOTER_MODEL: 'mistral-small-latest', VOTER_API_KEY: 'sk-m' })
    expect(config.providers).toEqual({
      default: { ...LOCAL, model: 'qwen', apiKey: 'sk-r' },
      voter: { protocol: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', apiKey: 'sk-m' },
    })
    expect(config.profiles[0]).toMatchObject({ research: 'default', voters: all('voter') })
    expect(config.warnings).toEqual(['RESEARCH_API_KEY, RESEARCH_MODEL, VOTER_BASE_URL, VOTER_API_KEY and VOTER_MODEL are deprecated: set QUORUM_RESEARCH_API_KEY, QUORUM_RESEARCH_MODEL, QUORUM_VOTER_BASE_URL, QUORUM_VOTER_API_KEY and QUORUM_VOTER_MODEL instead'])
  })

  it('builds an environment-only provider from a preset, its key read from the preset\'s variable', () => {
    expect(resolve({}, { QUORUM_RESEARCH_PRESET: 'anthropic', QUORUM_RESEARCH_MODEL: 'claude-sonnet-5', ANTHROPIC_API_KEY: 'sk-ant' }).providers).toEqual({ default: { preset: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant' } })
  })

  it('binds both roles to the one provider a file defines, and requires roles.research once there are several', () => {
    const a: ProviderSettings = { preset: 'ollama', model: 'q' }
    expect(resolve({ providers: { local: a } }).profiles[0]).toMatchObject({ research: 'local', voters: all('local') })
    expect(issuesOf({ providers: { a, b: a } })).toEqual([{ path: 'roles.research', message: 'is required when several providers are defined' }])
    expect(resolve({ providers: { a, b: a }, roles: { research: 'a' } }).profiles[0]).toMatchObject({ research: 'a', voters: all('a') })
  })

  it('refuses a role that names no provider, with a suggestion, and nothing after it', () => {
    const providers: Record<string, ProviderSettings> = { claude: { preset: 'anthropic', model: 'claude-sonnet-5' }, local: { preset: 'ollama', model: 'q' } }
    expect(issuesOf({ providers, roles: { research: 'local', voter: 'claud' } })).toEqual([{ path: 'roles.voter', message: 'unknown provider "claud" (did you mean "claude"?)' }])
  })

  it('reads a key from the variable apiKeyEnv names, and refuses one that is not set, naming the variable', () => {
    const corp: ProviderSettings = { protocol: 'openai-compatible', baseUrl: 'https://llm.corp.example/v1', model: 'm', apiKeyEnv: 'CORP_KEY' }
    expect(resolve({ providers: { corp } }, { CORP_KEY: ' sk-c ' }).providers.corp).toEqual({ protocol: 'openai-compatible', baseUrl: 'https://llm.corp.example/v1', model: 'm', apiKey: 'sk-c' })
    expect(issuesOf({ providers: { corp } })).toEqual([{ path: 'providers.corp', message: 'CORP_KEY is not set' }])
    expect(issuesOf({ providers: { claude: { preset: 'anthropic', model: 'claude-sonnet-5' } } })).toEqual([{ path: 'providers.claude', message: 'ANTHROPIC_API_KEY is not set' }])
  })

  it('never prints a variable name that is not an upper-case name, since a key pasted as one would show', () => {
    const pasted = `gsk_${'aB3'.repeat(17)}`
    const issues = issuesOf({ providers: { groq: { preset: 'groq', model: 'llama-3.3-70b-versatile', apiKeyEnv: pasted } } })
    expect(issues).toEqual([{ path: 'providers.groq.apiKeyEnv', message: 'names a variable that is not set' }])
    expect(JSON.stringify(issues)).not.toContain('aB3')
  })

  it('sends a preset\'s key variable only while the base URL keeps the preset\'s origin, and warns when it is not sent', () => {
    const env = { OPENAI_API_KEY: 'sk-o' }
    expect(resolve({ providers: { gpt: { preset: 'openai', model: 'gpt-5', baseUrl: 'HTTPS://API.OPENAI.COM.:443/v1/' } } }, env).providers.gpt).toMatchObject({ apiKey: 'sk-o' })
    const moved = resolve({ providers: { gpt: { preset: 'openai', model: 'gpt-5', baseUrl: 'https://gateway.example/openai/v1' } } }, env)
    expect(moved.providers.gpt).not.toHaveProperty('apiKey')
    expect(moved.warnings).toEqual(['providers.gpt.baseUrl: is not the endpoint of the openai preset, so OPENAI_API_KEY is not sent: set apiKeyEnv to send a key'])
  })

  it('sends the azure-openai key to an https Azure OpenAI host only', () => {
    const env = { AZURE_OPENAI_API_KEY: 'az-k' }
    const az = (baseUrl: string) => resolve({ providers: { az: { preset: 'azure-openai', baseUrl, model: 'review' } } }, env)
    expect(az('https://res.openai.azure.com/openai/v1').providers.az).toMatchObject({ apiKey: 'az-k' })
    for (const baseUrl of ['https://evil.example/openai/v1', 'http://res.openai.azure.com/openai/v1', 'https://openai.azure.com.evil.example/v1']) {
      expect(az(baseUrl).providers.az, baseUrl).not.toHaveProperty('apiKey')
      expect(az(baseUrl).warnings, baseUrl).toEqual(['providers.az.baseUrl: is not the endpoint of the azure-openai preset, so AZURE_OPENAI_API_KEY is not sent: set apiKeyEnv to send a key'])
    }
  })

  it('lets a literal key win over a variable, as the environment\'s key wins over the file\'s', () => {
    const corp: ProviderSettings = { protocol: 'openai-compatible', baseUrl: 'https://llm.corp.example/v1', model: 'm', apiKeyEnv: 'CORP_KEY' }
    expect(resolve({ providers: { corp } }, { CORP_KEY: 'sk-file', QUORUM_RESEARCH_API_KEY: 'sk-env' }).providers.corp).toMatchObject({ apiKey: 'sk-env' })
  })

  it('never gives a derived voter on another endpoint the research key, set by apiKeyEnv, the openai preset\'s variable or a RESEARCH_ variable', () => {
    const voterEnv = { QUORUM_VOTER_BASE_URL: 'https://v.example/v1', QUORUM_VOTER_MODEL: 'v' }
    const byVariable = resolve({ providers: { main: { protocol: 'openai-compatible', baseUrl: 'https://r.example/v1', model: 'r', apiKeyEnv: 'R_KEY' } } }, { R_KEY: 'sk-r', ...voterEnv })
    expect(byVariable.providers.voter).toEqual({ protocol: 'openai-compatible', baseUrl: 'https://v.example/v1', model: 'v' })
    const byPreset = resolve({ providers: { main: { preset: 'openai', model: 'gpt-5' } } }, { OPENAI_API_KEY: 'sk-r', ...voterEnv })
    expect(byPreset.providers.voter).toEqual({ preset: 'openai', baseUrl: 'https://v.example/v1', model: 'v' })
    for (const env of [{ QUORUM_RESEARCH_API_KEY: 'sk-r' }, { RESEARCH_API_KEY: 'sk-r' }]) {
      expect(JSON.stringify(resolve({}, { QUORUM_RESEARCH_MODEL: 'r', ...env, ...voterEnv }).providers.voter)).not.toContain('sk-r')
    }
  })

  it('never gives a derived voter on another Azure host the research preset\'s key', () => {
    const az: ProviderSettings = { preset: 'azure-openai', baseUrl: 'https://a.openai.azure.com/openai/v1', model: 'review' }
    const elsewhere = { AZURE_OPENAI_API_KEY: 'az-k', QUORUM_VOTER_BASE_URL: 'https://b.openai.azure.com/openai/v1', QUORUM_VOTER_MODEL: 'v' }
    const config = resolve({ providers: { az } }, elsewhere)
    expect(config.providers.az).toMatchObject({ apiKey: 'az-k' })
    expect(config.providers.voter).not.toHaveProperty('apiKey')
    expect(config.warnings).toEqual(['providers.voter.baseUrl: is not the endpoint of the research provider, so AZURE_OPENAI_API_KEY is not sent: set QUORUM_VOTER_API_KEY to send a key'])
  })

  it('gives a derived voter the preset\'s key when its own variables name the preset, or while it stays on the research host', () => {
    const az: ProviderSettings = { preset: 'azure-openai', baseUrl: 'https://a.openai.azure.com/openai/v1', model: 'review' }
    const env = { AZURE_OPENAI_API_KEY: 'az-k', QUORUM_VOTER_MODEL: 'v' }
    const named = resolve({ providers: { az } }, { ...env, QUORUM_VOTER_PRESET: 'azure-openai', QUORUM_VOTER_BASE_URL: 'https://b.openai.azure.com/openai/v1' })
    expect(named.providers.voter).toMatchObject({ apiKey: 'az-k' })
    const same = resolve({ providers: { az } }, env)
    expect(same.providers.voter).toMatchObject({ apiKey: 'az-k' })
    expect(same.warnings).toEqual([])
  })

  it('reports a derived voter with no model once, at QUORUM_VOTER_MODEL', () => {
    const voter = { QUORUM_VOTER_BASE_URL: 'https://v.example/v1' }
    const only = [{ path: 'QUORUM_VOTER_MODEL', message: VOTER_MODEL }]
    expect(issuesOf({}, { QUORUM_RESEARCH_MODEL: 'r', ...voter })).toEqual(only)
    expect(issuesOf({ providers: { main: { preset: 'anthropic', model: 'claude-sonnet-5' } } }, { ANTHROPIC_API_KEY: 'sk-a', ...voter })).toEqual(only)
  })

  it('warns when a key would travel over plain http to another machine, and not to this one', () => {
    const gpu = (baseUrl: string) => resolve({ providers: { gpu: { protocol: 'openai-compatible', baseUrl, model: 'm', apiKeyEnv: 'GPU_KEY' } } }, { GPU_KEY: 'k' }).warnings
    expect(gpu('http://gpu.lan:8000/v1')).toEqual(['providers.gpu.baseUrl: sends the key over plain http to a host other than this machine'])
    for (const baseUrl of ['http://localhost:8000/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1', 'http://box.localhost/v1', 'https://gpu.lan/v1']) expect(gpu(baseUrl), baseUrl).toEqual([])
  })

  it('checks every defined provider with the builder, and reads the keys of the ones in use only', () => {
    const main: ProviderSettings = { preset: 'ollama', model: 'q' }
    expect(issuesOf({ providers: { main, spare: { preset: 'anthropic', model: 'claude-sonnet-5', structuredOutput: 'json' } }, roles: { research: 'main' } })).toEqual([{ path: 'providers.spare.structuredOutput', message: 'must be prompt or schema' }])
    expect(Object.keys(resolve({ providers: { main, spare: { preset: 'anthropic', model: 'claude-sonnet-5' } }, roles: { research: 'main' } }).providers)).toEqual(['main'])
    expect(issuesOf({ providers: { local: { preset: 'ollama' } } })).toEqual([{ path: 'providers.local.model', message: 'is required' }])
  })

  it('throws the issues of the environment alone, before any provider is checked', () => {
    const broken: ProviderSettings = { preset: 'ollama' }
    expect(issuesOf({ providers: { local: broken } }, { QUORUM_PROFILES: 'Bad Id' })).toEqual([{ path: 'QUORUM_PROFILES', message: PROFILES }])
  })

  it('throws the issue of a profile QUORUM_PROFILES names that is not defined', () => {
    expect(issuesOf({ providers: { local: { preset: 'ollama', model: 'q' } } }, { QUORUM_PROFILES: 'nope' })).toEqual([{ path: 'QUORUM_PROFILES', message: 'unknown profile "nope": the profiles are security' }])
  })

  it('throws the issue of a variable aimed at a provider object, with the builder\'s issues after it', () => {
    const broken: ProviderSettings = { preset: 'ollama' }
    expect(issuesOf({ providers: { mine: object, broken }, roles: { research: 'mine' } }, { QUORUM_RESEARCH_MODEL: 'q' })).toEqual([
      { path: 'QUORUM_RESEARCH_MODEL', message: 'cannot change providers.mine, an object implementing Provider' },
      { path: 'providers.broken.model', message: 'is required' },
    ])
  })

  it('runs the profiles QUORUM_PROFILES names over the config\'s', () => {
    const config = resolve({ providers: { local: { preset: 'ollama', model: 'q' } }, profiles: { team: TEAM } }, { QUORUM_PROFILES: 'security' })
    expect(config.profiles.map(({ profile }) => profile.id)).toEqual(['security'])
  })

  it('keeps a provider object as it is, unread and unfrozen', () => {
    const config = resolve({ providers: { mine: object } })
    expect(config.providers.mine).toBe(object)
    expect(Object.isFrozen(object)).toBe(false)
  })

  it('reads only own fields: a polluted Object.prototype gives no provider a key, a role, a profile or a limit', () => {
    const proto = Object.prototype as Record<string, unknown>
    const planted: Record<string, unknown> = { apiKey: 'sk-planted', providers: { planted: object }, roles: { research: 'planted' }, profiles: ['planted'], concurrency: 99, maxFindings: 99 }
    for (const [key, value] of Object.entries(planted)) proto[key] = value
    try {
      const config = resolve({}, { QUORUM_RESEARCH_MODEL: 'q' })
      expect(config.providers).toEqual({ default: { ...LOCAL, model: 'q' } })
      expect(config.profiles.map(({ profile, research }) => [profile.id, research])).toEqual([['security', 'default']])
      expect(Object.hasOwn(config, 'concurrency') || Object.hasOwn(config, 'maxFindings')).toBe(false)
    } finally {
      for (const key of Object.keys(planted)) delete proto[key]
    }
  })

  it('passes concurrency and maxFindings through', () => {
    expect(resolve({ concurrency: 2, maxFindings: 10 }, { QUORUM_RESEARCH_MODEL: 'q' })).toMatchObject({ concurrency: 2, maxFindings: 10 })
  })

  it('returns a frozen copy it knows as resolved, and a resolved config as it is', () => {
    const headers = { 'x-team': 'sec' }
    const config = resolve({ providers: { local: { preset: 'ollama', model: 'q', headers } } })
    expect(isResolvedConfig(config)).toBe(true)
    expect(isResolvedConfig({ ...config })).toBe(false)
    expect(Object.isFrozen(config) && Object.isFrozen(config.providers) && Object.isFrozen(config.providers.local) && Object.isFrozen(config.profiles)).toBe(true)
    expect(Object.isFrozen(headers)).toBe(false)
    expect(resolveConfig(config, { env: { QUORUM_RESEARCH_MODEL: 'other' } })).toBe(config)
  })

  it('repeats no value in an issue or a warning', () => {
    const env = { QUORUM_RESEARCH_API_KEY: SECRET }
    expect(JSON.stringify(resolve({ providers: { gpu: { protocol: 'openai-compatible', baseUrl: `http://gpu.lan/${SECRET}/v1`, model: 'm' } } }, env).warnings)).not.toContain('zz')
    expect(JSON.stringify(issuesOf({ providers: { gpu: { protocol: 'openai-compatible', baseUrl: 'https://h.example/v1', model: 'm', query: { k: SECRET } } } }, env))).not.toContain('zz')
  })
})
