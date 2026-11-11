import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionResponse, Provider } from '../core/ports.ts'
import { configCodeSchema, configFileSchema, configInputSchema, configIssues, configJsonSchema, parseConfig, unknownName } from './schema.ts'
import type { QuorumConfigFile } from './schema.ts'

/** The issues of the ConfigError that parsing `value` with `schema` throws, each after the file name; none when it parses. */
function issuesOf(value: unknown, schema: z.ZodType = configFileSchema): readonly ConfigIssue[] {
  try {
    parseConfig(schema, value, 'q.yaml')
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues
  }
  return []
}

/** One issue at `path` inside the file. */
const at = (path: string, message: string): ConfigIssue => ({ path: `q.yaml: ${path}`, message })

const RULES = 'must be unanimous, majority, any, off, false, { minVotes } or { minRatio }'
const PRESETS = 'must be one of ollama, ollama-cloud, lmstudio, llamacpp, vllm, openai, azure-openai, openrouter, groq, mistral, deepseek, together, fireworks, xai, anthropic or gemini'
const NAME = 'must match ^[a-z][a-z0-9_-]*$'

/** Every field of the file variant, each with a valid value. */
const FULL: QuorumConfigFile = {
  $schema: 'https://example.test/quorum.schema.json',
  version: 1,
  providers: {
    local: { preset: 'ollama', model: 'qwen3.6:27b' },
    hosted_2: {
      protocol: 'openai-compatible',
      baseUrl: 'https://gateway.example/v1',
      model: 'gpt-5',
      apiKeyEnv: 'GATEWAY_KEY',
      auth: { header: 'x-gateway-key', prefix: 'Key ' },
      headers: { 'x-team': 'review' },
      query: { 'api-version': '2026-10-01' },
      extraBody: { reasoning: { effort: 'low', budget: [1, null, true] } },
      structuredOutput: 'schema',
      temperature: null,
      maxTokens: 4096,
      maxTokensField: 'max_completion_tokens',
      systemPrompt: 'inline',
    },
    'x-api': { preset: 'anthropic', auth: 'x-api-key', temperature: 0.2 },
  },
  roles: { research: 'local', voter: 'hosted_2' },
  concurrency: 4,
  maxFindings: 50,
  profiles: {
    security: {},
    'security-strict': { extends: 'security', policy: { high: 'unanimous', medium: 'unanimous', low: 'off' } },
    'team-style': {
      gating: false,
      roles: { research: 'local', voter: 'local' },
      prompts: { research: { file: './prompts/research.md' }, vote: 'Judge from {{lens.id}}: {{lens.question}}' },
      lenses: [{ id: 'grounded', question: 'Is it backed by a convention?' }, { id: 'significant', question: 'Would a maintainer block on it?', provider: 'x-api' }],
      policy: { high: { minVotes: 2 }, medium: { minRatio: 0.5 }, low: false },
    },
  },
}

const provider = (fields: Record<string, unknown>): unknown => ({ providers: { p: fields } })
const profile = (fields: Record<string, unknown>): unknown => ({ profiles: { team: fields } })

/** A provider object, as a code config can hand one over. */
const fakeProvider: Provider = {
  id: 'mine',
  model: 'm',
  complete: async (): Promise<CompletionResponse> => ({ text: '{"findings":[]}', model: 'm' }),
}

describe('configFileSchema', () => {
  it('parses a config that sets every field, and returns its data', () => {
    expect(parseConfig(configFileSchema, FULL)).toEqual(FULL)
  })

  it('parses an empty config: every field is optional, since a later layer can fill it', () => {
    expect(parseConfig(configFileSchema, {})).toEqual({})
  })

  it.each<[string, unknown, ConfigIssue[]]>([
    ['$schema', { $schema: 7 }, [at('$schema', 'must be a string')]],
    ['concurrency', { concurrency: '4' }, [at('concurrency', 'must be a number')]],
    ['maxFindings', { maxFindings: true }, [at('maxFindings', 'must be a number')]],
    ['providers', { providers: ['local'] }, [at('providers', 'must be an object')]],
    ['a provider', { providers: { p: 'ollama' } }, [at('providers.p', 'must be an object')]],
    ['roles', { roles: 'local' }, [at('roles', 'must be an object')]],
    ['roles.voter', { roles: { voter: 1 } }, [at('roles.voter', 'must be a string')]],
    ['profiles', { profiles: 'security' }, [at('profiles', 'must be an object')]],
    ['a profile', { profiles: { team: [] } }, [at('profiles.team', 'must be an object')]],
    ['preset', provider({ preset: 1 }), [at('providers.p.preset', PRESETS)]],
    ['protocol', provider({ protocol: 'openai' }), [at('providers.p.protocol', 'must be one of openai-compatible, anthropic, gemini or ollama')]],
    ['baseUrl', provider({ baseUrl: 8080 }), [at('providers.p.baseUrl', 'must be a string')]],
    ['model', provider({ model: null }), [at('providers.p.model', 'must be a string')]],
    ['apiKeyEnv', provider({ apiKeyEnv: ['KEY'] }), [at('providers.p.apiKeyEnv', 'must be a string')]],
    ['auth', provider({ auth: 'basic' }), [at('providers.p.auth', 'must be bearer, x-api-key, none or { header, prefix }')]],
    ['auth.header', provider({ auth: { header: 1 } }), [at('providers.p.auth.header', 'must be a string')]],
    ['auth.prefix', provider({ auth: { header: 'h', prefix: false } }), [at('providers.p.auth.prefix', 'must be a string')]],
    ['headers', provider({ headers: 'x-team: review' }), [at('providers.p.headers', 'must be an object')]],
    ['a header value', provider({ headers: { 'x-team': 1 } }), [at('providers.p.headers.x-team', 'must be a string')]],
    ['a query value', provider({ query: { v: 2 } }), [at('providers.p.query.v', 'must be a string')]],
    ['extraBody', provider({ extraBody: [1] }), [at('providers.p.extraBody', 'must be an object')]],
    ['structuredOutput', provider({ structuredOutput: 'xml' }), [at('providers.p.structuredOutput', 'must be one of prompt, json or schema')]],
    ['temperature', provider({ temperature: '0' }), [at('providers.p.temperature', 'must be a number')]],
    ['maxTokens', provider({ maxTokens: 1.5 }), [at('providers.p.maxTokens', 'must be an integer')]],
    ['maxTokensField', provider({ maxTokensField: 'max_output_tokens' }), [at('providers.p.maxTokensField', 'must be one of max_tokens or max_completion_tokens')]],
    ['systemPrompt', provider({ systemPrompt: 'system' }), [at('providers.p.systemPrompt', 'must be one of native or inline')]],
    ['extends', profile({ extends: 'code-review' }), [at('profiles.team.extends', 'must be security')]],
    ['gating', profile({ gating: 'yes' }), [at('profiles.team.gating', 'must be true or false')]],
    ['a profile\'s roles', profile({ roles: { research: 2 } }), [at('profiles.team.roles.research', 'must be a string')]],
    ['prompts', profile({ prompts: 'review it' }), [at('profiles.team.prompts', 'must be an object')]],
    ['a prompt', profile({ prompts: { research: 1 } }), [at('profiles.team.prompts.research', 'must be a string or { file }')]],
    ['a prompt file', profile({ prompts: { vote: { file: 1 } } }), [at('profiles.team.prompts.vote.file', 'must be a string')]],
    ['lenses', profile({ lenses: { id: 'a' } }), [at('profiles.team.lenses', 'must be an array')]],
    ['a lens', profile({ lenses: ['a'] }), [at('profiles.team.lenses.0', 'must be an object')]],
    ['a lens question', profile({ lenses: [{ id: 'a', question: 1 }] }), [at('profiles.team.lenses.0.question', 'must be a string')]],
    ['policy', profile({ policy: 'strict' }), [at('profiles.team.policy', 'must be an object')]],
  ])('reports a wrong type for %s at its path', (_name, value, issues) => {
    expect(issuesOf(value)).toEqual(issues)
  })

  it('reports a required field that is missing, and a number that is not finite, in words of their own', () => {
    expect(issuesOf(profile({ lenses: [{}], prompts: { research: {} } }))).toEqual([
      at('profiles.team.prompts.research.file', 'is required'),
      at('profiles.team.lenses.0.id', 'is required'),
      at('profiles.team.lenses.0.question', 'is required'),
    ])
    expect(issuesOf(provider({ auth: { prefix: 'Key ' }, temperature: Number.POSITIVE_INFINITY }))).toEqual([
      at('providers.p.auth.header', 'is required'),
      at('providers.p.temperature', 'must be a finite number'),
    ])
  })

  it.each<[string, unknown, string]>([
    ['the root', { colour: 'blue' }, 'colour'],
    ['a provider', provider({ modle: 'm' }), 'providers.p.modle'],
    ['an auth header', provider({ auth: { header: 'h', suffix: 'x' } }), 'providers.p.auth.suffix'],
    ['the roles', { roles: { reviewer: 'local' } }, 'roles.reviewer'],
    ['a profile', profile({ guidelines: 'be kind' }), 'profiles.team.guidelines'],
    ['a profile\'s roles', profile({ roles: { voters: 'local' } }), 'profiles.team.roles.voters'],
    ['the prompts', profile({ prompts: { panel: 'x' } }), 'profiles.team.prompts.panel'],
    ['a prompt file', profile({ prompts: { vote: { file: 'v.md', encoding: 'utf8' } } }), 'profiles.team.prompts.vote.encoding'],
    ['a lens', profile({ lenses: [{ id: 'a', question: 'q', weight: 2 }] }), 'profiles.team.lenses.0.weight'],
    ['the policy', profile({ policy: { critical: 'any' } }), 'profiles.team.policy.critical'],
    ['a minVotes rule', profile({ policy: { high: { minVotes: 2, of: 3 } } }), 'profiles.team.policy.high.of'],
  ])('reports an unknown key in %s at its own path', (_name, value, path) => {
    expect(issuesOf(value)).toEqual([at(path, 'is not a known field')])
  })

  it('reports an own __proto__ key in a strict object as an unknown key, at the top level and in a provider', () => {
    expect(issuesOf(JSON.parse('{"__proto__": {"polluted": true}}'))).toEqual([at('__proto__', 'is not a known field')])
    expect(issuesOf(JSON.parse('{"providers": {"p": {"__proto__": {"model": "m"}}}}'))).toEqual([at('providers.p.__proto__', 'is not a known field')])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('prints a key that is not a safe name as *, once for every such key of an object, since a record key is the user\'s text', () => {
    const secret = 'sk planted secret'
    expect(issuesOf({ [secret]: 1, 'other key': 2, colour: 3 })).toEqual([at('colour', 'is not a known field'), { path: 'q.yaml', message: 'holds a field that is not known' }])
    expect(issuesOf({ providers: { [secret]: {} } })).toEqual([at('providers.*', `is a key that ${NAME}`)])
    expect(issuesOf(provider({ headers: { [secret]: 1 } }))).toEqual([at('providers.p.headers.*', 'must be a string')])
    expect(issuesOf(provider({ headers: { [`x-${'a'.repeat(63)}`]: 1 } }))).toEqual([at('providers.p.headers.*', 'must be a string')])
    expect(issuesOf(provider({ headers: { [`x-${'a'.repeat(62)}`]: 1 } }))).toEqual([at(`providers.p.headers.x-${'a'.repeat(62)}`, 'must be a string')])
  })

  it.each<[string, unknown, ConfigIssue[]]>([
    ['a provider name', { providers: { Local: {} } }, [at('providers.Local', `is a key that ${NAME}`)]],
    ['a profile id', { profiles: { 'team style': {} } }, [at('profiles.*', `is a key that ${NAME}`)]],
    ['a role', { roles: { research: 'Local' } }, [at('roles.research', NAME)]],
    ['a profile role', profile({ roles: { voter: '1st' } }), [at('profiles.team.roles.voter', NAME)]],
    ['a lens id', profile({ lenses: [{ id: 'Grounded', question: 'q' }] }), [at('profiles.team.lenses.0.id', NAME)]],
    ['a lens provider', profile({ lenses: [{ id: 'a', question: 'q', provider: 'my provider' }] }), [at('profiles.team.lenses.0.provider', NAME)]],
    ['a variable name', provider({ apiKeyEnv: '1KEY' }), [at('providers.p.apiKeyEnv', 'must match ^[A-Za-z_][A-Za-z0-9_]*$')]],
  ])('holds %s to its pattern', (_name, value, issues) => {
    expect(issuesOf(value)).toEqual(issues)
  })

  it('accepts names and variable names at the edges of their patterns', () => {
    expect(issuesOf({ providers: { a: {}, 'a-b_c9': {}, constructor: {} }, roles: { research: 'constructor' } })).toEqual([])
    expect(issuesOf(provider({ apiKeyEnv: '_lower_Case_9' }))).toEqual([])
  })

  it('refuses any version but 1, and says to upgrade quorum', () => {
    const message = 'must be 1, the only config version this quorum reads: upgrade quorum to read a later one'
    expect(issuesOf({ version: 2 })).toEqual([at('version', message)])
    expect(issuesOf({ version: '1' })).toEqual([at('version', message)])
    expect(issuesOf({ version: 1 })).toEqual([])
  })

  it('refuses a lens list that is empty', () => {
    expect(issuesOf(profile({ lenses: [] }))).toEqual([at('profiles.team.lenses', 'must not be empty')])
  })

  it.each<[string, unknown]>([
    ['unanimous', 'unanimous'],
    ['majority', 'majority'],
    ['any', 'any'],
    ['off', 'off'],
    ['false', false],
    ['{ minVotes: 1 }', { minVotes: 1 }],
    ['{ minRatio: 1 }', { minRatio: 1 }],
    ['{ minRatio: 0.01 }', { minRatio: 0.01 }],
  ])('accepts the rule %s', (_name, rule) => {
    expect(issuesOf(profile({ policy: { high: rule } }))).toEqual([])
  })

  it.each<[string, unknown, ConfigIssue]>([
    ['a word it does not know', 'sometimes', at('profiles.team.policy.high', RULES)],
    ['true', true, at('profiles.team.policy.high', RULES)],
    ['both minVotes and minRatio', { minVotes: 1, minRatio: 0.5 }, at('profiles.team.policy.high', RULES)],
    ['minVotes of 0', { minVotes: 0 }, at('profiles.team.policy.high.minVotes', 'must be at least 1')],
    ['minVotes of 1.5', { minVotes: 1.5 }, at('profiles.team.policy.high.minVotes', 'must be an integer')],
    ['minRatio of 0', { minRatio: 0 }, at('profiles.team.policy.high.minRatio', 'must be greater than 0')],
    ['minRatio of 1.5', { minRatio: 1.5 }, at('profiles.team.policy.high.minRatio', 'must be at most 1')],
  ])('refuses the rule %s', (_name, rule, issue) => {
    expect(issuesOf(profile({ policy: { high: rule } }))).toEqual([issue])
  })

  it('reports a value of a field that takes several forms by the one form it took, and by the field\'s own message when it took none or several', () => {
    expect(issuesOf(profile({ prompts: { vote: { fil: 'v.md' } } }))).toEqual([at('profiles.team.prompts.vote.file', 'is required'), at('profiles.team.prompts.vote.fil', 'is not a known field')])
    expect(issuesOf(profile({ policy: { high: { minVotes: 'two' } } }))).toEqual([at('profiles.team.policy.high.minVotes', 'must be a number')])
    expect(issuesOf(profile({ policy: { high: { minVotes: 2, of: 3 } } }))).toEqual([at('profiles.team.policy.high.of', 'is not a known field')])
    expect(issuesOf(profile({ policy: { high: { minVotes: 2, minRatio: 3 } } }))).toEqual([at('profiles.team.policy.high', RULES)])
    expect(issuesOf(provider({ auth: ['bearer'] }))).toEqual([at('providers.p.auth', 'must be bearer, x-api-key, none or { header, prefix }')])
  })

  it.each<[string, unknown, ConfigIssue]>([
    ['concurrency of 0', { concurrency: 0 }, at('concurrency', 'must be at least 1')],
    ['concurrency of 2.5', { concurrency: 2.5 }, at('concurrency', 'must be an integer')],
    ['maxFindings of -1', { maxFindings: -1 }, at('maxFindings', 'must be at least 1')],
    ['maxFindings past the safe integers', { maxFindings: 2 ** 53 }, at('maxFindings', 'must be at most 9007199254740991')],
    ['maxTokens of 0', provider({ maxTokens: 0 }), at('providers.p.maxTokens', 'must be at least 1')],
  ])('holds a count to the bounds createQuorum checks: %s', (_name, value, issue) => {
    expect(issuesOf(value)).toEqual([issue])
  })

  it('accepts the smallest counts', () => {
    expect(issuesOf({ concurrency: 1, maxFindings: 1, providers: { p: { maxTokens: 1 } } })).toEqual([])
  })

  it('reports every issue at once', () => {
    expect(issuesOf({ version: 2, concurrency: 0, providers: { p: { preset: 'gpt' } } })).toEqual([
      at('version', 'must be 1, the only config version this quorum reads: upgrade quorum to read a later one'),
      at('providers.p.preset', PRESETS),
      at('concurrency', 'must be at least 1'),
    ])
  })

  it('refuses a key and a provider object, which only a code config may hold', () => {
    expect(issuesOf(provider({ preset: 'openai', apiKey: 'sk-k' }))).toEqual([at('providers.p.apiKey', 'is not a known field')])
    expect(issuesOf({ providers: { p: fakeProvider } })).toEqual([at('providers.p.id', 'is not a known field'), at('providers.p.complete', 'is not a known field')])
  })

  it('repeats no value in a message', () => {
    const secret = 'sk-planted-secret'
    const values = [
      { version: secret },
      { $schema: [secret] },
      provider({ preset: secret, protocol: secret, model: [secret], apiKeyEnv: secret, auth: secret, temperature: secret, maxTokens: secret }),
      provider({ auth: { header: [secret] }, headers: { h: [secret] }, query: secret }),
      profile({ extends: secret, gating: secret, prompts: { research: [secret] }, lenses: [{ id: secret, question: [secret] }], policy: { high: secret, medium: { minVotes: secret } } }),
      { roles: { research: secret }, concurrency: secret, maxFindings: secret },
    ]
    for (const value of values) {
      const issues = issuesOf(value)
      expect(issues.length).toBeGreaterThan(0)
      expect(JSON.stringify(issues)).not.toContain('planted')
    }
  })
})

describe('configCodeSchema', () => {
  it('accepts a key on a provider, and a provider object, which it reads once into a frozen snapshot with no prototype', () => {
    const parsed = parseConfig(configCodeSchema, { providers: { keyed: { preset: 'openai', apiKey: 'sk-k' }, mine: fakeProvider } })
    expect(parsed.providers?.keyed).toEqual({ preset: 'openai', apiKey: 'sk-k' })
    const mine = parsed.providers?.mine as Provider
    expect(mine).not.toBe(fakeProvider)
    expect(Object.isFrozen(mine) && Object.getPrototypeOf(mine) === null).toBe(true)
    expect(Object.keys(mine)).toEqual(['model', 'complete'])
    expect(mine.model).toBe('m')
  })

  it('accepts a provider object whose complete comes from its class, which its snapshot calls on the object itself', async () => {
    class Echo {
      readonly id = 'echo'
      readonly model = 'm'
      async complete(): Promise<CompletionResponse> {
        return { text: this.id, model: this.model }
      }
    }
    const echo = parseConfig(configCodeSchema, { providers: { echo: new Echo() } }).providers?.echo as Provider
    expect(await echo.complete({ system: '', messages: [], output: { name: 'x', schema: {} } })).toEqual({ text: 'echo', model: 'm' })
  })

  it('reads the model and the complete of a provider object once each, and nothing off the function it calls', async () => {
    const reads = { model: 0, complete: 0 }
    const object: { value?: unknown } = {}
    let calledOnObject = false
    async function complete(this: unknown): Promise<CompletionResponse> {
      calledOnObject = this === object.value
      return { text: '{}', model: 'm' }
    }
    Object.defineProperty(complete, 'call', { get: () => {
      throw new Error('SECRET')
    } })
    object.value = {
      get model() {
        reads.model += 1
        return 'm'
      },
      get complete() {
        reads.complete += 1
        return complete
      },
    }
    const snapshot = parseConfig(configCodeSchema, { providers: { mine: object.value } }).providers?.mine as Provider
    await snapshot.complete({ system: '', messages: [], output: { name: 'x', schema: {} } })
    await snapshot.complete({ system: '', messages: [], output: { name: 'x', schema: {} } })
    expect(reads).toEqual({ model: 1, complete: 1 })
    expect(calledOnObject).toBe(true)
  })

  it('reports a provider\'s settings at their field, and a value that is neither form at the entry', () => {
    expect(issuesOf({ providers: { p: { preset: 'gpt', apiKey: 1 } } }, configCodeSchema)).toEqual([at('providers.p.preset', PRESETS), at('providers.p.apiKey', 'must be a string')])
    expect(issuesOf({ providers: { p: { maxTokens: 0 } } }, configCodeSchema)).toEqual([at('providers.p.maxTokens', 'must be at least 1')])
    expect(issuesOf({ providers: { p: { complete: 'not a function' } } }, configCodeSchema)).toEqual([at('providers.p.complete', 'is not a known field')])
    expect(issuesOf({ providers: { p: 'openai' } }, configCodeSchema)).toEqual([at('providers.p', 'must be the settings of a provider, or an object whose complete is a function')])
  })

  it('reports a value in extraBody that is no JSON value, which only code can hand over', () => {
    expect(issuesOf({ providers: { p: { extraBody: { think: () => false } } } }, configCodeSchema)).toEqual([at('providers.p.extraBody.think', 'matches none of the forms it can take')])
  })

  it('checks every other field as the file variant does', () => {
    expect(issuesOf({ version: 2, colour: 1, profiles: { team: { lenses: [] } } }, configCodeSchema)).toEqual(issuesOf({ version: 2, colour: 1, profiles: { team: { lenses: [] } } }))
  })
})

describe('configInputSchema', () => {
  it('takes a prompt as a string only, since a program\'s config is read from no file', () => {
    expect(issuesOf({ profiles: { team: { prompts: { research: { file: 'r.md' } } } } }, configInputSchema)).toEqual([at('profiles.team.prompts.research', 'must be a string')])
    expect(parseConfig(configInputSchema, { providers: { mine: fakeProvider, key: { preset: 'openai', apiKey: 'sk-k' } }, profiles: { team: { prompts: { research: 'Find it.' } } } })).toEqual({ providers: { mine: { model: 'm', complete: expect.any(Function) }, key: { preset: 'openai', apiKey: 'sk-k' } }, profiles: { team: { prompts: { research: 'Find it.' } } } })
  })
})

describe('unknownName', () => {
  it('suggests a defined name one or two edits away, the first on a tie', () => {
    expect(unknownName('roles.voter', 'provider', 'claud', ['local', 'claude'])).toEqual({ path: 'roles.voter', message: 'unknown provider "claud" (did you mean "claude"?)' })
    expect(unknownName('p', 'provider', 'mian', ['main'])).toEqual({ path: 'p', message: 'unknown provider "mian" (did you mean "main"?)' })
    expect(unknownName('p', 'provider', 'ab', ['ac', 'ad'])).toEqual({ path: 'p', message: 'unknown provider "ab" (did you mean "ac"?)' })
  })

  it('lists the defined names when none is close', () => {
    expect(unknownName('QUORUM_PROFILES', 'profile', 'style', ['team-style', 'security'])).toEqual({ path: 'QUORUM_PROFILES', message: 'unknown profile "style": the profiles are team-style and security' })
  })

  it('never repeats a name that is not a safe name, nor lists one', () => {
    const long = `sk-${'a'.repeat(70)}`
    expect(unknownName('roles.research', 'provider', long, ['local', long])).toEqual({ path: 'roles.research', message: 'names an unknown provider: the providers are local and *' })
  })
})

describe('configIssues', () => {
  it('turns the issues of a plain safeParse into issues, one per unknown key, never naming a key that is not a safe name', () => {
    const result = configFileSchema.safeParse({ colour: 1, [String.fromCharCode(0x200B)]: 2, providers: { p: { modle: 'm' } } })
    expect(result.success).toBe(false)
    expect(configIssues(result.error!)).toEqual([
      { path: 'providers.p.modle', message: 'is not a known field' },
      { path: 'colour', message: 'is not a known field' },
      { path: '', message: 'holds a field that is not known' },
    ])
  })

  it('puts the prefix and a colon before every path, and the prefix alone for the root', () => {
    const result = configFileSchema.safeParse({ colour: 1, 'a b': 2 })
    expect(configIssues(result.error!, 'q.json')).toEqual([{ path: 'q.json: colour', message: 'is not a known field' }, { path: 'q.json', message: 'holds a field that is not known' }])
  })
})

/** The node of the generated JSON Schema at `keys`. */
function node(...keys: string[]): unknown {
  return keys.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], configJsonSchema())
}

/** The path of every property of a JSON Schema node, at any depth, that has no description. */
function undescribed(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => undescribed(item, `${path}.${index}`))
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  const own = typeof record.properties === 'object' && record.properties !== null
    ? Object.entries(record.properties).filter(([, field]) => typeof (field as Record<string, unknown>).description !== 'string').map(([name]) => `${path}.properties.${name}`)
    : []
  return [...own, ...Object.entries(record).flatMap(([key, field]) => undescribed(field, `${path}.${key}`))]
}

describe('configJsonSchema', () => {
  it('is a draft-07 schema that requires no field of the root', () => {
    expect(node('$schema')).toBe('http://json-schema.org/draft-07/schema#')
    expect(node('type')).toBe('object')
    expect(node('required')).toBeUndefined()
  })

  it('refuses a key it does not know on the root, a provider and a profile', () => {
    expect(node('additionalProperties')).toBe(false)
    expect(node('properties', 'providers', 'additionalProperties', 'additionalProperties')).toBe(false)
    expect(node('properties', 'profiles', 'additionalProperties', 'additionalProperties')).toBe(false)
  })

  it('holds the names of providers and the ids of profiles to the name pattern', () => {
    expect(node('properties', 'providers', 'propertyNames')).toEqual({ type: 'string', pattern: '^[a-z][a-z0-9_-]*$' })
    expect(node('properties', 'profiles', 'propertyNames')).toEqual({ type: 'string', pattern: '^[a-z][a-z0-9_-]*$' })
  })

  it('describes every field, for an editor to show, and offers no key field', () => {
    expect(undescribed(configJsonSchema(), '#')).toEqual([])
    expect(Object.keys(node('properties', 'providers', 'additionalProperties', 'properties') as object)).not.toContain('apiKey')
  })

  it('is what schema/quorum.schema.json holds, byte for byte', () => {
    const committed = readFileSync(new URL('../../schema/quorum.schema.json', import.meta.url), 'utf8')
    expect(committed, 'schema/quorum.schema.json differs from the zod schema: run bun run schema').toBe(`${JSON.stringify(configJsonSchema(), null, 2)}\n`)
  })
})
