import { ConfigError } from './core/errors.ts'
import type { CompletionRequest } from './core/ports.ts'
import type { Role, RoleConfig } from './core/types.ts'

const MAX_ERROR_BODY = 500

/**
 * Resolve connection settings for a role from the environment.
 *
 * VOTER_* falls back to RESEARCH_* when unset, so pointing the finder and the
 * panel at different backends (self-hosted vs. frontier, or two different
 * model families for cross-model verification) is opt-in, not required.
 *
 * @example
 * // Single backend - only these two need setting
 * process.env.RESEARCH_MODEL = 'qwen3.6:27b'
 * process.env.RESEARCH_BASE_URL = 'http://localhost:11434/v1'
 * roleConfig('VOTER') // -> same baseUrl/model as RESEARCH, resolved via fallback
 *
 * @example
 * // Cross-model verification - a different family votes than the one that found it
 * process.env.RESEARCH_MODEL = 'qwen3.6:27b'
 * process.env.VOTER_MODEL = 'gpt-5.4'
 * process.env.VOTER_BASE_URL = 'https://api.openai.com/v1'
 * process.env.VOTER_API_KEY = 'sk-...'
 */
export function roleConfig(role: Role): RoleConfig {
  const get = (name: string): string | undefined => {
    const own = process.env[`${role}_${name}`]
    if (own) return own
    return role === 'VOTER' ? process.env[`RESEARCH_${name}`] : undefined
  }
  return {
    baseUrl: get('BASE_URL') ?? 'http://localhost:11434/v1',
    apiKey: get('API_KEY') ?? 'not-needed',
    model: get('MODEL') ?? '',
  }
}

/**
 * Send one request to an OpenAI-compatible /chat/completions endpoint and return the reply text.
 *
 * Still requests basic json_object mode but never trusts it: OpenAI-compatible servers vary in how
 * much of the API they implement, so callers extract and validate the reply with core/output.ts.
 *
 * @throws if the role's model is unset or the request fails
 */
export async function chat(role: Role, request: CompletionRequest): Promise<string> {
  const config = roleConfig(role)
  if (!config.model) {
    throw new ConfigError([{ path: `${role}_MODEL`, message: 'is not set' }])
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
    signal: request.signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${role} call failed: ${response.status} ${text.slice(0, MAX_ERROR_BODY)}`)
  }

  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return body.choices?.[0]?.message?.content ?? ''
}
