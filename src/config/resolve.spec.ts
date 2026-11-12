import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionResponse, Provider } from '../core/ports.ts'
import type { Env } from './env.ts'
import type { ProfileSelection } from './profiles.ts'
import { isResolvedConfig, resolveConfig } from './resolve.ts'
import type { ResolvedConfig } from './resolve.ts'
import type { ConfigInput, ProviderSettings } from './schema.ts'

// A fixture held in a constant is typed ProviderSettings, so `protocol` and `preset` keep their literal types.
const SECRET = 'sk-zz-secret'
const NO_MODEL = 'no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one'
const PROFILES = 'must list profile ids separated by commas, each matching ^[a-z][a-z0-9_-]*$'
const VOTER_MODEL = 'must be set when the voter variables name another endpoint than the research provider\'s'
/** The built-in provider, with the context size every run here that has no file states. */
const LOCAL = { protocol: 'ollama', baseUrl: 'http://localhost:11434', contextTokens: 131072 }
/** The variables that state that context size for each role. */
const SIZE = { QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' }
const VOTER_SIZE = { QUORUM_VOTER_CONTEXT_TOKENS: '131072' }
const TEAM = {
  prompts: { research: 'Find style issues in this diff.', vote: 'Judge from {{lens.id}}: {{lens.question}}' },
  lenses: [
    { id: 'grounded', question: 'Is it backed by a stated convention?' },
  ],
}
const all = (name: string) => ({ reachability: name, impact: name, defenses: name })
const object: Provider = {
  id: 'x',
  model: 'm',
  complete: async (): Promise<CompletionResponse> => ({ text: '', model: 'm' }),
}

const resolve = (input: ConfigInput, env: Env = {}): ReturnType<typeof resolveConfig> => resolveConfig(input, { env })

/** The issues of the ConfigError that resolving throws; none when it resolves. */
function issuesOf(input: ConfigInput, env: Env = {}, selection?: ProfileSelection): readonly ConfigIssue[] {
  try {
    resolveConfig(input, { env, selection })
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues
  }
  return []
}

describe('resolveConfig', () => {
  it('resolves the environment alone to the built-in default provider, bound to both roles, and the security profile', () => {
    const config = resolve({}, { QUORUM_RESEARCH_MODEL: 'qwen3.6:27b', ...SIZE })
    expect(config.providers).toEqual({
      default: { ...LOCAL, model: 'qwen3.6:27b' },
    })
    expect(config.profiles.map(({ profile, research, voters }) => [profile.id, research, voters])).toEqual([
      [
        'security',
        'default',
        all('default'),
      ],
    ])
    expect(config.warnings).toEqual([])
    expect(resolve({ providers: {} }, { QUORUM_RESEARCH_MODEL: 'q', ...SIZE }).providers).toEqual({
      default: { ...LOCAL, model: 'q' },
    })
  })

  it('refuses a run with no model anywhere, naming the variable to set', () => {
    expect(issuesOf({})).toEqual([
      { path: '', message: NO_MODEL },
    ])
  })

  it('resolves a context size from the file, and from QUORUM_RESEARCH_CONTEXT_TOKENS over it', () => {
    const local: ProviderSettings = { preset: 'ollama', model: 'q', contextTokens: 65536 }
    expect(resolve({
      providers: { local },
    }).providers.local).toMatchObject({ contextTokens: 65536 })
    expect(resolve({
      providers: { local },
    }, { QUORUM_RESEARCH_CONTEXT_TOKENS: '32768' }).providers.local).toMatchObject({ contextTokens: 32768 })
  })

  it('names the variable that set a context size the adapter refuses, and the rule a malformed one breaks', () => {
    expect(issuesOf({}, { QUORUM_RESEARCH_MODEL: 'q', QUORUM_RESEARCH_CONTEXT_TOKENS: '16512' })).toEqual([
      { path: 'QUORUM_RESEARCH_CONTEXT_TOKENS', message: 'must be more than 16512, the 16000 tokens of the reply budget and 512 for the chat template' },
    ])
    expect(issuesOf({}, { QUORUM_RESEARCH_MODEL: 'q', QUORUM_RESEARCH_CONTEXT_TOKENS: '32k' })).toEqual([
      { path: 'QUORUM_RESEARCH_CONTEXT_TOKENS', message: 'must be a whole number of tokens, from 1 to 999999999' },
    ])
  })

  it('reads the deprecated aliases as today\'s CLI does, with one warning', () => {
    const config = resolve({}, {
      RESEARCH_MODEL: 'qwen',
      RESEARCH_API_KEY: 'sk-r',
      VOTER_BASE_URL: 'https://api.mistral.ai/v1',
      VOTER_MODEL: 'mistral-small-latest',
      VOTER_API_KEY: 'sk-m',
      ...SIZE,
      ...VOTER_SIZE,
    })
    expect(config.providers).toEqual({
      default: { ...LOCAL, model: 'qwen', apiKey: 'sk-r' },
      voter: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.mistral.ai/v1',
        model: 'mistral-small-latest',
        contextTokens: 131072,
        apiKey: 'sk-m',
      },
    })
    expect(config.profiles[0]).toMatchObject({
      research: 'default',
      voters: all('voter'),
    })
    expect(config.warnings).toEqual(['RESEARCH_API_KEY, RESEARCH_MODEL, VOTER_BASE_URL, VOTER_API_KEY and VOTER_MODEL are deprecated: set QUORUM_RESEARCH_API_KEY, QUORUM_RESEARCH_MODEL, QUORUM_VOTER_BASE_URL, QUORUM_VOTER_API_KEY and QUORUM_VOTER_MODEL instead'])
  })

  it('builds an environment-only provider from a preset, its key read from the preset\'s variable', () => {
    expect(resolve({}, {
      QUORUM_RESEARCH_PRESET: 'anthropic',
      QUORUM_RESEARCH_MODEL: 'claude-sonnet-5',
      ANTHROPIC_API_KEY: 'sk-ant',
      ...SIZE,
    }).providers).toEqual({
      default: {
        preset: 'anthropic',
        model: 'claude-sonnet-5',
        contextTokens: 131072,
        apiKey: 'sk-ant',
      },
    })
  })

  it('binds both roles to the one provider a file defines, and requires roles.research once there are several', () => {
    const a: ProviderSettings = { preset: 'ollama', model: 'q', contextTokens: 131072 }
    expect(resolve({
      providers: { local: a },
    }).profiles[0]).toMatchObject({
      research: 'local',
      voters: all('local'),
    })
    expect(issuesOf({
      providers: { a, b: a },
    })).toEqual([
      { path: 'roles.research', message: 'is required when several providers are defined' },
    ])
    expect(resolve({
      providers: { a, b: a },
      roles: { research: 'a' },
    }).profiles[0]).toMatchObject({
      research: 'a',
      voters: all('a'),
    })
  })

  it('refuses a role that names no provider, with a suggestion, and nothing after it', () => {
    const providers: Record<string, ProviderSettings> = {
      claude: { preset: 'anthropic', model: 'claude-sonnet-5', contextTokens: 131072 },
      local: { preset: 'ollama', model: 'q', contextTokens: 131072 },
    }
    expect(issuesOf({
      providers,
      roles: { research: 'local', voter: 'claud' },
    })).toEqual([
      { path: 'roles.voter', message: 'unknown provider "claud" (did you mean "claude"?)' },
    ])
  })

  it('reads a key from the variable apiKeyEnv names, and refuses one that is not set, naming the variable', () => {
    const corp: ProviderSettings = {
      protocol: 'openai-compatible',
      baseUrl: 'https://llm.corp.example/v1',
      model: 'm',
      contextTokens: 131072,
      apiKeyEnv: 'CORP_KEY',
    }
    expect(resolve({
      providers: { corp },
    }, { CORP_KEY: ' sk-c ' }).providers.corp).toEqual({
      protocol: 'openai-compatible',
      baseUrl: 'https://llm.corp.example/v1',
      model: 'm',
      contextTokens: 131072,
      apiKey: 'sk-c',
    })
    expect(issuesOf({
      providers: { corp },
    })).toEqual([
      { path: 'providers.corp', message: 'CORP_KEY is not set' },
    ])
    expect(issuesOf({
      providers: {
        claude: { preset: 'anthropic', model: 'claude-sonnet-5', contextTokens: 131072 },
      },
    })).toEqual([
      { path: 'providers.claude', message: 'ANTHROPIC_API_KEY is not set' },
    ])
  })

  it('never prints a variable name that is not an upper-case name, since a key pasted as one would show', () => {
    const pasted = `gsk_${'aB3'.repeat(17)}`
    const issues = issuesOf({
      providers: {
        groq: {
          preset: 'groq',
          model: 'llama-3.3-70b-versatile',
          contextTokens: 131072,
          apiKeyEnv: pasted,
        },
      },
    })
    expect(issues).toEqual([
      { path: 'providers.groq.apiKeyEnv', message: 'names a variable that is not set' },
    ])
    expect(JSON.stringify(issues)).not.toContain('aB3')
  })

  it('sends a preset\'s key variable only while the base URL keeps the preset\'s origin, and warns when it is not sent', () => {
    const env = { OPENAI_API_KEY: 'sk-o' }
    expect(resolve({
      providers: {
        gpt: {
          preset: 'openai',
          model: 'gpt-5',
          contextTokens: 131072,
          baseUrl: 'HTTPS://API.OPENAI.COM.:443/v1/',
        },
      },
    }, env).providers.gpt).toMatchObject({ apiKey: 'sk-o' })
    const moved = resolve({
      providers: {
        gpt: {
          preset: 'openai',
          model: 'gpt-5',
          contextTokens: 131072,
          baseUrl: 'https://gateway.example/openai/v1',
        },
      },
    }, env)
    expect(moved.providers.gpt).not.toHaveProperty('apiKey')
    expect(moved.warnings).toEqual(['providers.gpt.baseUrl: is not the endpoint of the openai preset, so OPENAI_API_KEY is not sent: set apiKeyEnv to send a key'])
  })

  it('sends the azure-openai key to an https Azure OpenAI host only', () => {
    const env = { AZURE_OPENAI_API_KEY: 'az-k' }
    const az = (baseUrl: string) => resolve({
      providers: {
        az: {
          preset: 'azure-openai',
          baseUrl,
          model: 'review',
          contextTokens: 131072,
        },
      },
    }, env)
    expect(az('https://res.openai.azure.com/openai/v1').providers.az).toMatchObject({ apiKey: 'az-k' })
    for (const baseUrl of ['https://evil.example/openai/v1', 'http://res.openai.azure.com/openai/v1', 'https://openai.azure.com.evil.example/v1']) {
      expect(az(baseUrl).providers.az, baseUrl).not.toHaveProperty('apiKey')
      expect(az(baseUrl).warnings, baseUrl).toEqual(['providers.az.baseUrl: is not the endpoint of the azure-openai preset, so AZURE_OPENAI_API_KEY is not sent: set apiKeyEnv to send a key'])
    }
  })

  it('lets a literal key win over a variable, as the environment\'s key wins over the file\'s', () => {
    const corp: ProviderSettings = {
      protocol: 'openai-compatible',
      baseUrl: 'https://llm.corp.example/v1',
      model: 'm',
      contextTokens: 131072,
      apiKeyEnv: 'CORP_KEY',
    }
    expect(resolve({
      providers: { corp },
    }, { CORP_KEY: 'sk-file', QUORUM_RESEARCH_API_KEY: 'sk-env' }).providers.corp).toMatchObject({ apiKey: 'sk-env' })
  })

  it('never gives a derived voter on another endpoint the research key, set by apiKeyEnv, the openai preset\'s variable or a RESEARCH_ variable', () => {
    const voterEnv = { QUORUM_VOTER_BASE_URL: 'https://v.example/v1', QUORUM_VOTER_MODEL: 'v', ...VOTER_SIZE }
    const byVariable = resolve({
      providers: {
        main: {
          protocol: 'openai-compatible',
          baseUrl: 'https://r.example/v1',
          model: 'r',
          contextTokens: 131072,
          apiKeyEnv: 'R_KEY',
        },
      },
    }, { R_KEY: 'sk-r', ...voterEnv })
    expect(byVariable.providers.voter).toEqual({
      protocol: 'openai-compatible',
      baseUrl: 'https://v.example/v1',
      model: 'v',
      contextTokens: 131072,
    })
    const byPreset = resolve({
      providers: {
        main: { preset: 'openai', model: 'gpt-5', contextTokens: 131072 },
      },
    }, { OPENAI_API_KEY: 'sk-r', ...voterEnv })
    expect(byPreset.providers.voter).toEqual({
      preset: 'openai',
      baseUrl: 'https://v.example/v1',
      model: 'v',
      contextTokens: 131072,
    })
    for (const env of [
      { QUORUM_RESEARCH_API_KEY: 'sk-r' },
      { RESEARCH_API_KEY: 'sk-r' },
    ]) {
      expect(JSON.stringify(resolve({}, {
        QUORUM_RESEARCH_MODEL: 'r',
        ...SIZE,
        ...env,
        ...voterEnv,
      }).providers.voter)).not.toContain('sk-r')
    }
  })

  it('never gives a derived voter on another Azure host the research preset\'s key', () => {
    const az: ProviderSettings = {
      preset: 'azure-openai',
      baseUrl: 'https://a.openai.azure.com/openai/v1',
      model: 'review',
      contextTokens: 131072,
    }
    const elsewhere = {
      AZURE_OPENAI_API_KEY: 'az-k',
      QUORUM_VOTER_BASE_URL: 'https://b.openai.azure.com/openai/v1',
      QUORUM_VOTER_MODEL: 'v',
      ...VOTER_SIZE,
    }
    const config = resolve({
      providers: { az },
    }, elsewhere)
    expect(config.providers.az).toMatchObject({ apiKey: 'az-k' })
    expect(config.providers.voter).not.toHaveProperty('apiKey')
    expect(config.warnings).toEqual(['providers.voter.baseUrl: is not the endpoint of the research provider, so AZURE_OPENAI_API_KEY is not sent: set QUORUM_VOTER_API_KEY to send a key'])
  })

  it('gives a derived voter the preset\'s key when its own variables name the preset, or while it stays on the research host', () => {
    const az: ProviderSettings = {
      preset: 'azure-openai',
      baseUrl: 'https://a.openai.azure.com/openai/v1',
      model: 'review',
      contextTokens: 131072,
    }
    const env = { AZURE_OPENAI_API_KEY: 'az-k', QUORUM_VOTER_MODEL: 'v', ...VOTER_SIZE }
    const named = resolve({
      providers: { az },
    }, { ...env, QUORUM_VOTER_PRESET: 'azure-openai', QUORUM_VOTER_BASE_URL: 'https://b.openai.azure.com/openai/v1' })
    expect(named.providers.voter).toMatchObject({ apiKey: 'az-k' })
    const same = resolve({
      providers: { az },
    }, env)
    expect(same.providers.voter).toMatchObject({ apiKey: 'az-k' })
    expect(same.warnings).toEqual([])
  })

  it('reports a derived voter with no model once, at QUORUM_VOTER_MODEL', () => {
    const voter = { QUORUM_VOTER_BASE_URL: 'https://v.example/v1', ...VOTER_SIZE }
    const only = [
      { path: 'QUORUM_VOTER_MODEL', message: VOTER_MODEL },
    ]
    expect(issuesOf({}, {
      QUORUM_RESEARCH_MODEL: 'r',
      ...SIZE,
      ...voter,
    })).toEqual(only)
    expect(issuesOf({
      providers: {
        main: { preset: 'anthropic', model: 'claude-sonnet-5', contextTokens: 131072 },
      },
    }, { ANTHROPIC_API_KEY: 'sk-a', ...voter })).toEqual(only)
  })

  it('warns when a key would travel over plain http to another machine, and not to this one', () => {
    const gpu = (baseUrl: string) => resolve({
      providers: {
        gpu: {
          protocol: 'openai-compatible',
          baseUrl,
          model: 'm',
          contextTokens: 131072,
          apiKeyEnv: 'GPU_KEY',
        },
      },
    }, { GPU_KEY: 'k' }).warnings
    expect(gpu('http://gpu.lan:8000/v1')).toEqual(['providers.gpu.baseUrl: sends the key over plain http to a host other than this machine'])
    for (const baseUrl of [
      'http://localhost:8000/v1',
      'http://127.0.0.1:8000/v1',
      'http://[::1]:8000/v1',
      'http://box.localhost/v1',
      'https://gpu.lan/v1',
    ]) expect(gpu(baseUrl), baseUrl).toEqual([])
  })

  it('checks every defined provider with the builder, and reads the keys of the ones in use only', () => {
    const main: ProviderSettings = { preset: 'ollama', model: 'q', contextTokens: 131072 }
    expect(issuesOf({
      providers: {
        main,
        spare: {
          preset: 'anthropic',
          model: 'claude-sonnet-5',
          contextTokens: 131072,
          structuredOutput: 'json',
        },
      },
      roles: { research: 'main' },
    })).toEqual([
      { path: 'providers.spare.structuredOutput', message: 'must be prompt or schema' },
    ])
    expect(Object.keys(resolve({
      providers: {
        main,
        spare: { preset: 'anthropic', model: 'claude-sonnet-5', contextTokens: 131072 },
      },
      roles: { research: 'main' },
    }).providers)).toEqual(['main'])
    expect(issuesOf({
      providers: {
        local: { preset: 'ollama', contextTokens: 131072 },
      },
    })).toEqual([
      { path: 'providers.local.model', message: 'is required' },
    ])
  })

  it('throws the issues of the environment alone, before any provider is checked', () => {
    const broken: ProviderSettings = { preset: 'ollama', contextTokens: 131072 }
    expect(issuesOf({
      providers: { local: broken },
    }, { QUORUM_PROFILES: 'Bad Id' })).toEqual([
      { path: 'QUORUM_PROFILES', message: PROFILES },
    ])
  })

  it('throws the issue of a profile QUORUM_PROFILES names that is not defined', () => {
    expect(issuesOf({
      providers: {
        local: { preset: 'ollama', model: 'q', contextTokens: 131072 },
      },
    }, { QUORUM_PROFILES: 'nope' })).toEqual([
      { path: 'QUORUM_PROFILES', message: 'unknown profile "nope": the profiles are security' },
    ])
  })

  it('throws the issue of a variable aimed at a provider object, with the builder\'s issues after it', () => {
    const broken: ProviderSettings = { preset: 'ollama', contextTokens: 131072 }
    expect(issuesOf({
      providers: { mine: object, broken },
      roles: { research: 'mine' },
    }, { QUORUM_RESEARCH_MODEL: 'q' })).toEqual([
      { path: 'QUORUM_RESEARCH_MODEL', message: 'cannot change providers.mine, an object implementing Provider' },
      { path: 'providers.broken.model', message: 'is required' },
    ])
  })

  it('reads a literal apiKey that is empty as unset, as a blank variable is, so the key variable applies', () => {
    expect(resolve({
      providers: {
        p: {
          preset: 'ollama',
          model: 'q',
          contextTokens: 131072,
          apiKey: '',
          apiKeyEnv: 'P_KEY',
        },
      },
    }, { P_KEY: 'sk-p' }).providers.p).toMatchObject({ apiKey: 'sk-p' })
    expect(resolve({
      providers: {
        p: {
          preset: 'openai',
          model: 'gpt-5',
          contextTokens: 131072,
          apiKey: '',
        },
      },
    }, { OPENAI_API_KEY: 'sk-o' }).providers.p).toMatchObject({ apiKey: 'sk-o' })
    expect(resolve({
      providers: {
        p: {
          preset: 'ollama',
          model: 'q',
          contextTokens: 131072,
          apiKey: '',
        },
      },
    }).providers.p).not.toHaveProperty('apiKey')
    expect(issuesOf({
      providers: {
        p: {
          preset: 'ollama',
          model: 'q',
          contextTokens: 131072,
          apiKey: '',
          apiKeyEnv: 'P_KEY',
        },
      },
    })).toEqual([
      { path: 'providers.p', message: 'P_KEY is not set' },
    ])
  })

  it('reports a value that cannot be copied at its field, never as the raw error that prints it', () => {
    const copy = (auth: unknown): ConfigInput => ({
      providers: {
        p: {
          protocol: 'openai-compatible',
          baseUrl: 'https://h.example/v1',
          model: 'm',
          contextTokens: 131072,
          auth,
        },
      },
    }) as ConfigInput
    const issues = issuesOf(copy({
      header: 'x-key',
      extra: () => SECRET,
    }))
    expect(issues).toEqual([
      { path: 'providers.p.auth', message: 'cannot be copied' },
    ])
    expect(JSON.stringify(issues)).not.toContain('zz')
    expect(issuesOf(copy({
      header: 'x-key',
      extra: {
        get inner(): never {
          throw new Error(SECRET)
        },
      },
    }))).toEqual([
      { path: 'providers.p.auth', message: 'cannot be copied' },
    ])
  })

  describe('an issue on a field a variable set', () => {
    const PRESETS = 'must be one of ollama, ollama-cloud, lmstudio, llamacpp, vllm, openai, azure-openai, openrouter, groq, mistral, deepseek, together, fireworks, xai, anthropic or gemini'
    const TOOL_MODEL = 'runs tools on the server by itself, which quorum never allows'
    const URL_FORM = 'must be an http:// or https:// URL with a host'

    it.each([
      [
        'research',
        { QUORUM_RESEARCH_PRESET: 'antropic', QUORUM_RESEARCH_MODEL: 'm', ...SIZE },
        'QUORUM_RESEARCH_PRESET',
        PRESETS,
      ],
      [
        'voter',
        {
          QUORUM_RESEARCH_MODEL: 'm',
          QUORUM_VOTER_PRESET: 'antropic',
          QUORUM_VOTER_MODEL: 'v',
          ...SIZE,
          ...VOTER_SIZE,
        },
        'QUORUM_VOTER_PRESET',
        PRESETS,
      ],
      [
        'research',
        { QUORUM_RESEARCH_BASE_URL: 'not a url', QUORUM_RESEARCH_MODEL: 'm', ...SIZE },
        'QUORUM_RESEARCH_BASE_URL',
        URL_FORM,
      ],
      [
        'voter',
        {
          QUORUM_RESEARCH_MODEL: 'm',
          QUORUM_VOTER_BASE_URL: 'not a url',
          QUORUM_VOTER_MODEL: 'v',
          ...SIZE,
          ...VOTER_SIZE,
        },
        'QUORUM_VOTER_BASE_URL',
        URL_FORM,
      ],
      [
        'research',
        {
          GROQ_API_KEY: 'sk-g',
          QUORUM_RESEARCH_PRESET: 'groq',
          QUORUM_RESEARCH_MODEL: 'openai/gpt-oss-120b',
          ...SIZE,
        },
        'QUORUM_RESEARCH_MODEL',
        TOOL_MODEL,
      ],
      [
        'voter',
        {
          GROQ_API_KEY: 'sk-g',
          QUORUM_RESEARCH_MODEL: 'm',
          QUORUM_VOTER_PRESET: 'groq',
          QUORUM_VOTER_MODEL: 'openai/gpt-oss-120b',
          ...SIZE,
          ...VOTER_SIZE,
        },
        'QUORUM_VOTER_MODEL',
        TOOL_MODEL,
      ],
      [
        'voter alias',
        {
          RESEARCH_MODEL: 'm',
          VOTER_BASE_URL: 'not a url',
          VOTER_MODEL: 'v',
          ...SIZE,
          ...VOTER_SIZE,
        },
        'QUORUM_VOTER_BASE_URL',
        URL_FORM,
      ],
    ])('is reported at the variable, for the %s role', (_role, env, path, message) => {
      expect(issuesOf({}, env)).toEqual([
        { path, message },
      ])
    })

    it('is reported at the variable when the voter has a provider of its own, and at the provider for a field the config set', () => {
      const providers: Record<string, ProviderSettings> = {
        a: { preset: 'ollama', model: 'q', contextTokens: 131072 },
        b: {
          preset: 'ollama',
          model: 'q',
          contextTokens: 131072,
          maxTokens: 0,
        },
      }
      expect(issuesOf({
        providers,
        roles: { research: 'a', voter: 'b' },
      }, { QUORUM_VOTER_PRESET: 'antropic', QUORUM_VOTER_MODEL: 'v', ...VOTER_SIZE })).toEqual([
        { path: 'QUORUM_VOTER_PRESET', message: PRESETS },
      ])
      expect(issuesOf({
        providers,
        roles: { research: 'a', voter: 'b' },
      }, { QUORUM_VOTER_MODEL: 'v', ...VOTER_SIZE })).toEqual([
        { path: 'providers.b.maxTokens', message: 'must be a whole number of at least 1' },
      ])
      expect(issuesOf({
        providers: {
          a: { preset: 'gpt', model: 'q', contextTokens: 131072 },
        } as never,
      }, { QUORUM_RESEARCH_MODEL: 'm', ...SIZE })).toEqual([
        { path: 'providers.a.preset', message: PRESETS },
      ])
    })
  })

  it('runs the profiles QUORUM_PROFILES names over the config\'s', () => {
    const config = resolve({
      providers: {
        local: { preset: 'ollama', model: 'q', contextTokens: 131072 },
      },
      profiles: { team: TEAM },
    }, { QUORUM_PROFILES: 'security' })
    expect(config.profiles.map(({ profile }) => profile.id)).toEqual(['security'])
  })

  it('keeps a provider object as it is, unread and unfrozen', () => {
    const config = resolve({
      providers: { mine: object },
    })
    expect(config.providers.mine).toBe(object)
    expect(Object.isFrozen(object)).toBe(false)
  })

  it('reads only own fields: a polluted Object.prototype gives no provider a key, a role, a profile or a limit', () => {
    const proto = Object.prototype as Record<string, unknown>
    const planted: Record<string, unknown> = {
      apiKey: 'sk-planted',
      providers: { planted: object },
      roles: { research: 'planted' },
      profiles: ['planted'],
      concurrency: 99,
      maxFindings: 99,
    }
    for (const [key, value] of Object.entries(planted)) proto[key] = value
    try {
      const config = resolve({}, { QUORUM_RESEARCH_MODEL: 'q', ...SIZE })
      expect(config.providers).toEqual({
        default: { ...LOCAL, model: 'q' },
      })
      expect(config.profiles.map(({ profile, research }) => [profile.id, research])).toEqual([
        ['security', 'default'],
      ])
      expect(Object.hasOwn(config, 'concurrency') || Object.hasOwn(config, 'maxFindings')).toBe(false)
    } finally {
      for (const key of Object.keys(planted)) delete proto[key]
    }
  })

  it('passes concurrency and maxFindings through', () => {
    expect(resolve({ concurrency: 2, maxFindings: 10 }, { QUORUM_RESEARCH_MODEL: 'q', ...SIZE })).toMatchObject({ concurrency: 2, maxFindings: 10 })
  })

  it('returns a frozen copy it knows as resolved, and a resolved config as it is', () => {
    const headers = { 'x-team': 'sec' }
    const config = resolve({
      providers: {
        local: {
          preset: 'ollama',
          model: 'q',
          contextTokens: 131072,
          headers,
        },
      },
    })
    expect(isResolvedConfig(config)).toBe(true)
    expect(isResolvedConfig({ ...config })).toBe(false)
    expect(Object.isFrozen(config) && Object.isFrozen(config.providers) && Object.isFrozen(config.providers.local) && Object.isFrozen(config.profiles)).toBe(true)
    expect(Object.isFrozen(headers)).toBe(false)
    // An environment that would refuse the resolution if it were read.
    expect(resolveConfig(config, {
      env: { QUORUM_PROFILES: 'Bad Id' },
    })).toBe(config)
  })

  it('repeats no value in an issue or a warning', () => {
    const env = { QUORUM_RESEARCH_API_KEY: SECRET }
    expect(JSON.stringify(resolve({
      providers: {
        gpu: {
          protocol: 'openai-compatible',
          baseUrl: `http://gpu.lan/${SECRET}/v1`,
          model: 'm',
          contextTokens: 131072,
        },
      },
    }, env).warnings)).not.toContain('zz')
    expect(JSON.stringify(issuesOf({
      providers: {
        gpu: {
          protocol: 'openai-compatible',
          baseUrl: 'https://h.example/v1',
          model: 'm',
          contextTokens: 131072,
          query: { k: SECRET },
        },
      },
    }, env))).not.toContain('zz')
  })
})

describe('a provider without a context size', () => {
  const NO_CONTEXT = 'no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens'
  const REQUIRED = 'is required: the model\'s context window in tokens, which quorum checks every request against'
  const RESEARCH_CONTEXT = 'must be set when the research variables name a model or an endpoint: a context size belongs to one model on one endpoint'
  const VOTER_CONTEXT = 'must be set when the voter variables name a model or an endpoint: a context size belongs to one model on one endpoint'
  const sized: ProviderSettings = { preset: 'ollama', model: 'q', contextTokens: 65536 }

  it('refuses the built-in provider, naming the variable to set', () => {
    expect(issuesOf({}, { QUORUM_RESEARCH_MODEL: 'q' })).toEqual([
      { path: '', message: NO_CONTEXT },
    ])
  })

  it('reports a missing model alone, before the context size, as the builder checks the model first', () => {
    expect(issuesOf({}, { QUORUM_RESEARCH_API_KEY: 'sk-r' })).toEqual([
      { path: '', message: NO_MODEL },
    ])
  })

  it('refuses a provider of the file at its field, used or not, as every provider is checked', () => {
    expect(issuesOf({
      providers: {
        local: { preset: 'ollama', model: 'q' },
      },
    })).toEqual([
      { path: 'providers.local.contextTokens', message: REQUIRED },
    ])
    expect(issuesOf({
      providers: {
        a: sized,
        b: { preset: 'ollama', model: 'q' },
      },
      roles: { research: 'a' },
    })).toEqual([
      { path: 'providers.b.contextTokens', message: REQUIRED },
    ])
  })

  it('names QUORUM_RESEARCH_CONTEXT_TOKENS when the research variables set another model or endpoint', () => {
    expect(issuesOf({
      providers: { local: sized },
    }, { QUORUM_RESEARCH_MODEL: 'q2' })).toEqual([
      { path: 'QUORUM_RESEARCH_CONTEXT_TOKENS', message: RESEARCH_CONTEXT },
    ])
    expect(issuesOf({
      providers: { local: sized },
    }, { QUORUM_RESEARCH_BASE_URL: 'http://gpu.example:11434' })).toEqual([
      { path: 'QUORUM_RESEARCH_CONTEXT_TOKENS', message: RESEARCH_CONTEXT },
    ])
  })

  it('never gives a derived voter on another endpoint the research context size, and names QUORUM_VOTER_CONTEXT_TOKENS (ADR-0013)', () => {
    const env = {
      QUORUM_RESEARCH_MODEL: 'q',
      QUORUM_RESEARCH_CONTEXT_TOKENS: '65536',
      QUORUM_VOTER_BASE_URL: 'https://v.example/v1',
      QUORUM_VOTER_MODEL: 'v',
    }
    expect(issuesOf({}, env)).toEqual([
      { path: 'QUORUM_VOTER_CONTEXT_TOKENS', message: VOTER_CONTEXT },
    ])
    expect(resolve({}, { ...env, QUORUM_VOTER_CONTEXT_TOKENS: '32768' }).providers.voter).toMatchObject({ contextTokens: 32768 })
  })

  it('names QUORUM_VOTER_CONTEXT_TOKENS when the voter variables set another model, on the same endpoint or on the voter\'s own provider', () => {
    expect(issuesOf({}, { QUORUM_RESEARCH_MODEL: 'q', QUORUM_RESEARCH_CONTEXT_TOKENS: '65536', QUORUM_VOTER_MODEL: 'v' })).toEqual([
      { path: 'QUORUM_VOTER_CONTEXT_TOKENS', message: VOTER_CONTEXT },
    ])
    expect(issuesOf({
      providers: { a: sized, b: sized },
      roles: { research: 'a', voter: 'b' },
    }, { QUORUM_VOTER_MODEL: 'v' })).toEqual([
      { path: 'QUORUM_VOTER_CONTEXT_TOKENS', message: VOTER_CONTEXT },
    ])
  })

  it('reports a derived voter that shares the research provider\'s model and endpoint under the research provider\'s issue alone', () => {
    expect(issuesOf({}, { QUORUM_RESEARCH_MODEL: 'q', QUORUM_VOTER_API_KEY: 'sk-v' })).toEqual([
      { path: '', message: NO_CONTEXT },
    ])
    expect(resolve({}, { QUORUM_RESEARCH_MODEL: 'q', QUORUM_RESEARCH_CONTEXT_TOKENS: '65536', QUORUM_VOTER_API_KEY: 'sk-v' }).providers.voter).toMatchObject({ contextTokens: 65536 })
  })

  it('reports a context size that leaves a derived voter no room under the research provider\'s issue alone, at the path its user wrote', () => {
    const tight: ProviderSettings = { preset: 'ollama', model: 'q', maxTokens: 20000 }
    const room = 'must be more than 20512, the 20000 tokens of the reply budget and 512 for the chat template'
    expect(issuesOf({
      providers: { local: tight },
    }, { QUORUM_RESEARCH_CONTEXT_TOKENS: '20000', QUORUM_VOTER_API_KEY: 'sk-v' })).toEqual([
      { path: 'QUORUM_RESEARCH_CONTEXT_TOKENS', message: room },
    ])
    expect(issuesOf({
      providers: {
        local: { ...tight, contextTokens: 20000 },
      },
    }, { QUORUM_VOTER_API_KEY: 'sk-v' })).toEqual([
      { path: 'providers.local.contextTokens', message: room },
    ])
  })
})

describe('the built-in default provider', () => {
  const RESEARCH = { QUORUM_RESEARCH_MODEL: 'm', QUORUM_RESEARCH_CONTEXT_TOKENS: '32768' }
  const VOTER = { QUORUM_VOTER_MODEL: 'v', QUORUM_VOTER_CONTEXT_TOKENS: '32768' }
  const NATIVE = { protocol: 'ollama', baseUrl: 'http://localhost:11434' }
  const GPU = { protocol: 'openai-compatible', baseUrl: 'http://gpu:8000/v1' }

  // Each row: the variables beyond the research model and context size, the default provider that results, and the derived voter, if any.
  it.each<[string, Env, object, object | undefined]>([
    [
      'no other variable',
      {},
      NATIVE,
      undefined,
    ],
    [
      'a research base URL alone',
      { QUORUM_RESEARCH_BASE_URL: 'http://gpu:8000/v1' },
      GPU,
      undefined,
    ],
    [
      'the deprecated alias of a research base URL alone',
      { RESEARCH_BASE_URL: 'http://gpu:8000/v1' },
      GPU,
      undefined,
    ],
    [
      'a research protocol and base URL',
      { QUORUM_RESEARCH_PROTOCOL: 'ollama', QUORUM_RESEARCH_BASE_URL: 'http://gpu:11434' },
      { protocol: 'ollama', baseUrl: 'http://gpu:11434' },
      undefined,
    ],
    [
      'a research preset',
      { QUORUM_RESEARCH_PRESET: 'vllm' },
      { preset: 'vllm' },
      undefined,
    ],
    [
      'a voter model alone',
      { ...VOTER },
      NATIVE,
      NATIVE,
    ],
    [
      'a voter base URL on another origin',
      { ...VOTER, QUORUM_VOTER_BASE_URL: 'http://gpu:8000/v1' },
      NATIVE,
      GPU,
    ],
    [
      'a voter base URL on the default\'s origin',
      { ...VOTER, QUORUM_VOTER_BASE_URL: 'http://localhost:11434/v1' },
      NATIVE,
      { protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
    ],
    [
      'the deprecated alias of a voter base URL',
      { ...VOTER, VOTER_BASE_URL: 'http://gpu:8000/v1' },
      NATIVE,
      GPU,
    ],
    [
      'a research base URL and a voter model',
      { ...VOTER, QUORUM_RESEARCH_BASE_URL: 'http://gpu:8000/v1' },
      GPU,
      GPU,
    ],
  ])('resolves %s', (_name, env, expectedDefault, expectedVoter) => {
    const config = resolve({}, {
      ...RESEARCH,
      ...env,
    })
    expect(config.providers.default).toEqual({ ...expectedDefault, model: 'm', contextTokens: 32768 })
    if (expectedVoter === undefined) {
      expect(Object.keys(config.providers)).toEqual(['default'])
      expect(config.profiles[0]).toMatchObject({
        research: 'default',
        voters: all('default'),
      })
    } else {
      expect(config.providers.voter).toEqual({ ...expectedVoter, model: 'v', contextTokens: 32768 })
      expect(config.profiles[0]).toMatchObject({
        research: 'default',
        voters: all('voter'),
      })
    }
  })

  it('keeps a research preset\'s protocol for a voter base URL alone, which names no protocol of its own', () => {
    const env = {
      ...RESEARCH,
      ...VOTER,
      QUORUM_RESEARCH_PRESET: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-a',
      QUORUM_VOTER_BASE_URL: 'https://proxy.example',
    }
    expect(resolve({}, env).providers.voter).toEqual({
      preset: 'anthropic',
      baseUrl: 'https://proxy.example',
      model: 'v',
      contextTokens: 32768,
    })
  })

  it('sends a research key variable only to the endpoint it was set for, whatever protocol the default speaks (ADR-0013)', () => {
    const env = {
      ...RESEARCH,
      ...VOTER,
      QUORUM_RESEARCH_API_KEY: 'sk-r',
    }
    const named = (voter: Env) => resolve({}, {
      ...env,
      ...voter,
    }).providers
    expect(named({}).default).toMatchObject({ ...NATIVE, apiKey: 'sk-r' })
    expect(named({ QUORUM_VOTER_BASE_URL: 'http://gpu:8000/v1' }).voter).not.toHaveProperty('apiKey')
    expect(named({ QUORUM_VOTER_BASE_URL: 'http://localhost:11434/v1' }).voter).toMatchObject({ protocol: 'openai-compatible', apiKey: 'sk-r' })
    expect(named({ QUORUM_VOTER_BASE_URL: 'http://localhost:11435/v1' }).voter).not.toHaveProperty('apiKey')
  })

  it('leaves the providers of a config as the file wrote them, for a voter base URL included', () => {
    const file: ProviderSettings = {
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      contextTokens: 32768,
    }
    expect(resolve({
      providers: { local: file },
    }).providers).toEqual({ local: file })
    const native: ProviderSettings = {
      protocol: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'm',
      contextTokens: 32768,
    }
    const voter = resolve({
      providers: { local: native },
    }, { ...VOTER, QUORUM_VOTER_BASE_URL: 'http://localhost:11434/v1' }).providers.voter
    expect(voter).toMatchObject({ protocol: 'ollama', baseUrl: 'http://localhost:11434/v1' })
  })
})

describe('a selection of profiles', () => {
  const TWO: ConfigInput = {
    profiles: { security: {}, team: TEAM },
  }
  const MODEL = { QUORUM_RESEARCH_MODEL: 'm', ...SIZE }
  const ID = 'must be a profile id matching ^[a-z][a-z0-9_-]*$'
  const select = (ids: string[]): ProfileSelection => ({ ids, path: '--profile' })
  const idsOf = (config: ResolvedConfig): string[] => config.profiles.map(({ profile }) => profile.id)

  it('runs the profiles it names, over QUORUM_PROFILES and the config\'s own list', () => {
    expect(idsOf(resolveConfig(TWO, {
      env: { ...MODEL, QUORUM_PROFILES: 'team' },
      selection: select(['security']),
    }))).toEqual(['security'])
    expect(idsOf(resolveConfig({
      profiles: { team: TEAM },
    }, {
      env: MODEL,
      selection: select(['team', 'security']),
    }))).toEqual(['team', 'security'])
  })

  it.each<[string, string[], ConfigIssue[]]>([
    [
      'an id of another form',
      ['Security'],
      [
        { path: '--profile', message: ID },
      ],
    ],
    [
      'an empty id',
      [''],
      [
        { path: '--profile', message: ID },
      ],
    ],
    [
      'an id named twice',
      ['security', 'security'],
      [
        { path: '--profile', message: 'names a profile more than once' },
      ],
    ],
    [
      'a malformed id named twice',
      ['Bad', 'Bad'],
      [
        { path: '--profile', message: ID },
        { path: '--profile', message: 'names a profile more than once' },
      ],
    ],
    [
      'an unknown id',
      ['secrity'],
      [
        { path: '--profile', message: 'unknown profile "secrity" (did you mean "security"?)' },
      ],
    ],
    [
      'no id',
      [],
      [
        { path: '--profile', message: 'must name at least one profile' },
      ],
    ],
  ])('refuses %s at the selection\'s path', (_name, ids, issues) => {
    expect(issuesOf(TWO, MODEL, select(ids))).toEqual(issues)
  })

  it('still refuses a malformed QUORUM_PROFILES, before the selection\'s own issue', () => {
    expect(issuesOf(TWO, { ...MODEL, QUORUM_PROFILES: ',' }, select(['Bad']))).toEqual([
      { path: 'QUORUM_PROFILES', message: PROFILES },
      { path: '--profile', message: ID },
    ])
  })
})

describe('a claude-code provider', () => {
  /** A directory of its own, made when the file loads and removed after the last test: two `claude` and an empty directory. */
  const dir = mkdtempSync(join(tmpdir(), 'quorum-resolve-'))
  const bin = join(dir, 'bin')
  const other = join(dir, 'other')
  const empty = join(dir, 'empty')
  for (const folder of [bin, other, empty]) mkdirSync(folder)
  for (const folder of [bin, other]) {
    writeFileSync(join(folder, 'claude'), '#!/bin/sh\n')
    chmodSync(join(folder, 'claude'), 0o755)
  }
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const ENV = { QUORUM_RESEARCH_PROTOCOL: 'claude-code', QUORUM_RESEARCH_MODEL: 'sonnet', QUORUM_RESEARCH_CONTEXT_TOKENS: '1000000' }
  const code = (fields: Record<string, unknown> = {}): ConfigInput => ({
    providers: {
      cc: {
        protocol: 'claude-code',
        model: 'sonnet',
        contextTokens: 1000000,
        ...fields,
      },
    },
  })

  it('runs from the environment alone, with claude from PATH', () => {
    expect(resolveConfig({}, {
      env: { ...ENV, PATH: bin },
    }).providers).toEqual({
      default: {
        protocol: 'claude-code',
        model: 'sonnet',
        contextTokens: 1000000,
        command: join(bin, 'claude'),
      },
    })
  })

  it('takes QUORUM_CLAUDE_CODE_COMMAND over a code config\'s command, and that over PATH', () => {
    expect(resolveConfig(code({
      command: join(other, 'claude'),
    }), {
      env: { PATH: bin },
    }).providers.cc).toMatchObject({
      command: join(other, 'claude'),
    })
    expect(resolveConfig(code({
      command: join(other, 'claude'),
    }), {
      env: {
        PATH: bin,
        QUORUM_CLAUDE_CODE_COMMAND: join(bin, 'claude'),
      },
    }).providers.cc).toMatchObject({
      command: join(bin, 'claude'),
    })
  })

  it.each<[string, ConfigInput, Env, ConfigIssue]>([
    [
      'claude on no PATH entry',
      code(),
      { PATH: empty },
      { path: 'providers.cc', message: 'claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND' },
    ],
    [
      'a QUORUM_CLAUDE_CODE_COMMAND that names no file',
      code(),
      {
        QUORUM_CLAUDE_CODE_COMMAND: join(empty, 'claude'),
      },
      { path: 'QUORUM_CLAUDE_CODE_COMMAND', message: 'names no executable file' },
    ],
    [
      'a command that names no file',
      code({
        command: join(empty, 'claude'),
      }),
      { PATH: bin },
      { path: 'providers.cc.command', message: 'names no executable file' },
    ],
  ])('refuses %s, and repeats no path', (_, input, env, issue) => {
    expect(issuesOf(input, env)).toEqual([issue])
  })

  it('leaves a command the adapter refuses to the adapter, which names it by its field', () => {
    expect(issuesOf(code({ command: './claude' }), { PATH: bin })).toEqual([
      { path: 'providers.cc.command', message: 'must be an absolute path, or a name to find on PATH' },
    ])
  })

  it('looks claude up only for a provider a profile uses', () => {
    const input: ConfigInput = {
      providers: {
        local: {
          protocol: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'm',
          contextTokens: 131072,
        },
        ...code().providers,
      },
      roles: { research: 'local' },
    }
    expect(Object.keys(resolveConfig(input, {
      env: { PATH: empty },
    }).providers)).toEqual(['local'])
  })

  it('reads ANTHROPIC_API_KEY in api-key mode when apiKeyEnv is unset, and refuses the run without it', () => {
    expect(resolveConfig(code({ auth: 'api-key' }), {
      env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-k' },
    }).providers.cc).toMatchObject({ auth: 'api-key', apiKey: 'sk-k' })
    expect(issuesOf(code({ auth: 'api-key' }), { PATH: bin })).toEqual([
      { path: 'providers.cc', message: 'ANTHROPIC_API_KEY is not set' },
    ])
  })

  it('reads the variable apiKeyEnv names in api-key mode, instead of ANTHROPIC_API_KEY', () => {
    expect(resolveConfig(code({ auth: 'api-key', apiKeyEnv: 'TEAM_KEY' }), {
      env: { PATH: bin, TEAM_KEY: 'sk-team', ANTHROPIC_API_KEY: 'sk-k' },
    }).providers.cc).toMatchObject({ apiKey: 'sk-team' })
    expect(issuesOf(code({ auth: 'api-key', apiKeyEnv: 'TEAM_KEY' }), { PATH: bin, ANTHROPIC_API_KEY: 'sk-k' })).toEqual([
      { path: 'providers.cc', message: 'TEAM_KEY is not set' },
    ])
  })

  it.each<Record<string, unknown>>([
    {},
    { auth: 'inherit' },
    { auth: 'login' },
  ])('refuses an apiKeyEnv under %j at apiKeyEnv itself, and never reads the variable', (fields) => {
    const refused = [
      { path: 'providers.cc.apiKeyEnv', message: 'is set, but auth is not api-key' },
    ]
    const issues = issuesOf(code({ ...fields, apiKeyEnv: 'TEAM_KEY' }), { PATH: bin, TEAM_KEY: 'sk-SECRET' })
    expect(issues).toEqual(refused)
    expect(JSON.stringify(issues)).not.toContain('SECRET')
    // Unset or set, the refusal is the same: a variable that is read can be reported as not set.
    expect(issuesOf(code({ ...fields, apiKeyEnv: 'TEAM_KEY' }), { PATH: bin })).toEqual(refused)
  })

  it('reads no key under inherit or login, whatever ANTHROPIC_API_KEY holds', () => {
    for (const fields of [
      {},
      { auth: 'inherit' },
      { auth: 'login' },
    ]) {
      expect(resolveConfig(code(fields), {
        env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-k' },
      }).providers.cc).not.toHaveProperty('apiKey')
    }
  })

  it('warns that inherit bills ANTHROPIC_API_KEY when it is set, and login does not', () => {
    expect(resolveConfig(code(), {
      env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-k' },
    }).warnings).toEqual(['providers.cc: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key'])
    expect(resolveConfig(code({ auth: 'login' }), {
      env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-k' },
    }).warnings).toEqual([])
  })

  it('warns about no provider a profile does not use, and about none without the key', () => {
    const input: ConfigInput = {
      providers: {
        local: {
          protocol: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'm',
          contextTokens: 131072,
        },
        ...code().providers,
      },
      roles: { research: 'local' },
    }
    expect(resolveConfig(input, {
      env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-k' },
    }).warnings).toEqual([])
    expect(resolveConfig(code(), {
      env: { PATH: bin },
    }).warnings).toEqual([])
  })

  it('prints no path, no PATH entry and no key in a warning or an issue', () => {
    const text = JSON.stringify([
      resolveConfig(code(), {
        env: { PATH: bin, ANTHROPIC_API_KEY: 'sk-SECRET' },
      }).warnings,
      issuesOf(code(), { PATH: empty, ANTHROPIC_API_KEY: 'sk-SECRET' }),
      issuesOf(code(), {
        QUORUM_CLAUDE_CODE_COMMAND: join(empty, 'claude'),
        PATH: bin,
      }),
      issuesOf(code({
        command: join(empty, 'claude'),
      }), { PATH: bin }),
    ])
    expect(text).not.toContain(dir)
    expect(text).not.toContain('SECRET')
  })

  describe('as the voter the variables derive from a claude-code finder', () => {
    const VOTER = { QUORUM_VOTER_MODEL: 'haiku', QUORUM_VOTER_CONTEXT_TOKENS: '1000000' }

    it('is another endpoint, since the CLI has no base URL: it keeps the protocol, auth, args and command, and drops the key variable, the model and the context size', () => {
      const finder = code({
        auth: 'api-key',
        apiKeyEnv: 'FINDER_KEY',
        args: ['--effort', 'high'],
        command: join(other, 'claude'),
      })
      const { providers, profiles } = resolveConfig(finder, {
        env: {
          PATH: bin,
          FINDER_KEY: 'sk-finder',
          ANTHROPIC_API_KEY: 'sk-default',
          ...VOTER,
        },
      })
      expect(providers.cc).toEqual({
        protocol: 'claude-code',
        command: join(other, 'claude'),
        model: 'sonnet',
        contextTokens: 1000000,
        auth: 'api-key',
        args: ['--effort', 'high'],
        apiKey: 'sk-finder',
      })
      expect(providers.voter).toEqual({
        protocol: 'claude-code',
        command: join(other, 'claude'),
        model: 'haiku',
        contextTokens: 1000000,
        auth: 'api-key',
        args: ['--effort', 'high'],
        apiKey: 'sk-default',
      })
      expect(profiles.map(({ research, voters }) => [
        research,
        Object.values(voters),
      ])).toEqual([
        [
          'cc',
          ['voter', 'voter', 'voter'],
        ],
      ])
    })

    it('works from the environment alone: QUORUM_VOTER_MODEL=haiku with QUORUM_VOTER_CONTEXT_TOKENS', () => {
      const { providers } = resolveConfig({}, {
        env: {
          ...ENV,
          ...VOTER,
          PATH: bin,
        },
      })
      expect(providers).toEqual({
        default: {
          protocol: 'claude-code',
          model: 'sonnet',
          contextTokens: 1000000,
          command: join(bin, 'claude'),
        },
        voter: {
          protocol: 'claude-code',
          model: 'haiku',
          contextTokens: 1000000,
          command: join(bin, 'claude'),
        },
      })
    })

    it('has no model of the finder\'s and no context size of its, so each is asked for at its variable', () => {
      expect(issuesOf({}, { ...ENV, PATH: bin, QUORUM_VOTER_CONTEXT_TOKENS: '1000000' })).toEqual([
        { path: 'QUORUM_VOTER_MODEL', message: VOTER_MODEL },
      ])
      expect(issuesOf({}, { ...ENV, PATH: bin, QUORUM_VOTER_MODEL: 'haiku' })).toEqual([
        { path: 'QUORUM_VOTER_CONTEXT_TOKENS', message: 'must be set when the voter variables name a model or an endpoint: a context size belongs to one model on one endpoint' },
      ])
    })

    it('names a command that is no executable once, at its variable, though both providers look it up', () => {
      expect(issuesOf({}, {
        ...ENV,
        ...VOTER,
        QUORUM_CLAUDE_CODE_COMMAND: join(empty, 'claude'),
      })).toEqual([
        { path: 'QUORUM_CLAUDE_CODE_COMMAND', message: 'names no executable file' },
      ])
    })

    it('names a claude that is on no PATH entry at each provider', () => {
      expect(issuesOf({}, {
        ...ENV,
        ...VOTER,
        PATH: empty,
      })).toEqual([
        { path: 'providers.default', message: 'claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND' },
        { path: 'providers.voter', message: 'claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND' },
      ])
    })
  })
})
