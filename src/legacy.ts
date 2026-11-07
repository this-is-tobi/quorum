/**
 * The RESEARCH_* / VOTER_* environment wiring, kept until the config layer replaces it. That layer keeps
 * these names as deprecated aliases, so a caller written against this module keeps working.
 */
import { ConfigError } from './core/errors.ts'
import type { Provider } from './core/ports.ts'
import { openaiCompatible } from './providers/openai-compatible.ts'

export type Env = Readonly<Record<string, string | undefined>>
export type Role = 'RESEARCH' | 'VOTER'

export interface RoleSettings {
  baseUrl: string
  apiKey: string | undefined
  model: string
}

const DEFAULT_BASE_URL = 'http://localhost:11434/v1'

/** A value counts once trimmed, as `fetch` always trimmed a header value: a pasted newline must not break a key. */
function read(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined
}

/**
 * Resolve connection settings for a role. VOTER_* falls back to RESEARCH_* field by field, so pointing
 * the panel at another backend is opt-in; RESEARCH_* never falls back to VOTER_*. An empty or blank
 * value is unset, and no key means no placeholder.
 */
export function roleSettings(role: Role, env: Env): RoleSettings {
  const get = (name: string): string | undefined =>
    read(env, `${role}_${name}`) ?? (role === 'VOTER' ? read(env, `RESEARCH_${name}`) : undefined)
  return {
    baseUrl: get('BASE_URL') ?? DEFAULT_BASE_URL,
    apiKey: get('API_KEY'),
    model: get('MODEL') ?? '',
  }
}

function providerFor(role: Role, env: Env): Provider {
  const { baseUrl, apiKey, model } = roleSettings(role, env)
  if (!model) throw new ConfigError([{ path: `${role}_MODEL`, message: 'is not set' }])
  return openaiCompatible({ id: role.toLowerCase(), baseUrl, apiKey, model })
}

/**
 * Build the research and voter providers from the environment.
 *
 * @throws ConfigError when a role has no model, a key has a character an HTTP header cannot carry or a
 * base URL is not http(s)
 */
export function providersFromEnv(env: Env): { research: Provider, voter: Provider } {
  return { research: providerFor('RESEARCH', env), voter: providerFor('VOTER', env) }
}
