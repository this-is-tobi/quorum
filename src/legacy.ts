/**
 * The RESEARCH_* / VOTER_* environment wiring, kept until the config layer replaces it. That layer keeps
 * these names as deprecated aliases, so a caller written against this module keeps working.
 */
import { envValue } from './config/env.ts'
import type { Env } from './config/env.ts'
import { ConfigError } from './core/errors.ts'
import type { EventSink, Provider } from './core/ports.ts'
import { createQuorum } from './core/quorum.ts'
import type { Quorum } from './core/types.ts'
import { securityProfile } from './profiles/security.ts'
import { httpOrigin } from './providers/http.ts'
import { openaiCompatible } from './providers/openai-compatible.ts'

export type { Env }
export type Role = 'RESEARCH' | 'VOTER'

export interface RoleSettings {
  baseUrl: string
  apiKey: string | undefined
  model: string
}

const DEFAULT_BASE_URL = 'http://localhost:11434/v1'

/**
 * The scheme, host or port tell origins apart: letter case, a default port and one trailing dot of the
 * host do not (`httpOrigin`). A URL without an http(s) origin matches nothing, itself included.
 */
function sameOrigin(a: string, b: string): boolean {
  const origin = httpOrigin(a)
  return origin !== undefined && origin === httpOrigin(b)
}

/**
 * Resolve connection settings for a role. RESEARCH_* never falls back to VOTER_*. VOTER_* falls back to
 * RESEARCH_* field by field, but only while the voter has no base URL of its own or shares the research
 * origin (scheme, host and port): a key is only sent to the endpoint it was configured for. On another
 * origin the voter gets its own VOTER_* values and nothing else, so its model may come back empty. An
 * empty or blank value is unset, and no key means no placeholder.
 */
export function roleSettings(role: Role, env: Env): RoleSettings {
  const researchBaseUrl = envValue(env, 'RESEARCH_BASE_URL') ?? DEFAULT_BASE_URL
  const voterBaseUrl = envValue(env, 'VOTER_BASE_URL')
  const inherits = role === 'VOTER' && (voterBaseUrl === undefined || sameOrigin(voterBaseUrl, researchBaseUrl))
  const get = (name: string): string | undefined =>
    envValue(env, `${role}_${name}`) ?? (inherits ? envValue(env, `RESEARCH_${name}`) : undefined)
  return {
    baseUrl: get('BASE_URL') ?? DEFAULT_BASE_URL,
    apiKey: get('API_KEY'),
    model: get('MODEL') ?? '',
  }
}

function providerFor(role: Role, env: Env): Provider {
  const { baseUrl, apiKey, model } = roleSettings(role, env)
  const provider = openaiCompatible({ id: role.toLowerCase(), baseUrl, apiKey, model })
  if (!model) {
    // The voter's model is only empty on another origin: on the same one it inherits the research model, built first.
    const message = role === 'VOTER'
      ? 'must be set when VOTER_BASE_URL has another scheme, host or port than RESEARCH_BASE_URL'
      : 'is not set'
    throw new ConfigError([{ path: `${role}_MODEL`, message }])
  }
  return provider
}

/**
 * Build the research and voter providers from the environment.
 *
 * @throws ConfigError when there is no research model, when a voter on another endpoint than the research
 * one has no model of its own, when a key has a character an HTTP header cannot carry, or when a base URL
 * is not an http(s) URL with a host or holds a user name, a password, a query or a fragment
 */
export function providersFromEnv(env: Env): { research: Provider, voter: Provider } {
  return { research: providerFor('RESEARCH', env), voter: providerFor('VOTER', env) }
}

/**
 * Build a quorum that runs the security profile from the environment: the research provider
 * researches, and the voter provider answers every lens of the panel.
 *
 * @throws what `providersFromEnv` throws
 */
export function quorumFromEnv(env: Env, events?: EventSink): Quorum {
  const { research, voter } = providersFromEnv(env)
  const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, voter]))
  return createQuorum({ profiles: [securityProfile] }, { profiles: { security: { research, voters } }, events })
}
