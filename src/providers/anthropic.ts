import { ConfigError } from '../core/errors.ts'
import type { CompletionResponse, Provider } from '../core/ports.ts'
import { endpointUrl, postJson, redactionsOf } from './http.ts'
import { shapeMessages } from './messages.ts'
import { httpOptionIssues, isRecord, mergeBody, requestHeaders } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions } from './options.ts'
import { endedEarly, joinedText, replyFailure, tokenUsage } from './reply.ts'

/** The options of an Anthropic Messages provider: the ones every HTTP adapter takes, and no other. */
export type AnthropicOptions = HttpProviderOptions

/**
 * The API version every request names. For this call it differs from `2023-06-01` only in refusing any
 * `temperature`, `top_p` or `top_k`, so no temperature is sent unless one is set.
 */
const ANTHROPIC_VERSION = '2026-10-21'
/** The token limit when `maxTokens` is not set: the Messages API requires one. */
const DEFAULT_MAX_TOKENS = 16_000
/**
 * The protocol's rules. The tool fields: `tools` and `tool_choice`; `mcp_servers`, which offers an MCP
 * server's tools with no `tools` entry under the deprecated `mcp-client-2025-04-04` beta; `container`,
 * which loads skills; and the beta's server-side fields. `anthropic-beta` stays open, since no beta
 * header offers a tool by itself.
 */
const RULES: Omit<AdapterRules, 'auth'> = {
  reservedBodyKeys: ['model', 'messages', 'system', 'stream'],
  toolBodyKeys: ['tools', 'tool_choice', 'mcp_servers', 'container', 'thread', 'fallbacks', 'fallback_credit_token', 'context_management', 'compaction'],
  fixedHeaders: ['anthropic-version'],
  structuredOutputs: ['prompt', 'schema'],
}
/** The stop reasons of a finished reply. */
const FINISHED: ReadonlySet<unknown> = new Set(['end_turn', 'stop_sequence'])

/**
 * Turn a Messages reply into text, or a `ProviderError`. Every property is read defensively: the reply
 * is untrusted. The stop reason comes first, since a refused or cut-off reply can still hold some text.
 */
function readReply(reply: unknown, { id, model }: Pick<AnthropicOptions, 'id' | 'model'>, redact: readonly string[]): CompletionResponse {
  const fail = replyFailure(id)
  if (!isRecord(reply)) throw fail('invalid-response', 'reply is not a JSON object')

  const reason = reply.stop_reason
  if (reason === 'refusal') throw fail('refusal', 'model refused')
  if (reason === 'max_tokens') throw fail('truncated', 'reply was cut off by the token limit')
  if (reason === 'model_context_window_exceeded') throw fail('truncated', 'reply was cut off: the context window is full')
  if (!FINISHED.has(reason)) throw fail('invalid-response', endedEarly(reason, redact))

  const text = joinedText(reply.content, block => block.type === 'text')
  if (text === undefined) throw fail('invalid-response', 'reply has no text')

  return {
    text,
    model: typeof reply.model === 'string' && reply.model !== '' ? reply.model : model,
    usage: tokenUsage(reply.usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'], ['output_tokens']),
  }
}

/**
 * A provider for the Anthropic Messages API, `/v1/messages`, or a gateway that speaks it. The key, when
 * there is one, travels only in the header `auth` names, `Authorization: Bearer` by default (invariant
 * I1). It never sends an assistant prefill, which current models reject.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function anthropic(options: AnthropicOptions): Provider {
  const { id, baseUrl, model, apiKey, auth = 'bearer' as Auth, headers, query, extraBody, temperature, maxTokens = DEFAULT_MAX_TOKENS, systemPrompt = 'native', structuredOutput = 'prompt' } = options
  const issues = httpOptionIssues(options, { ...RULES, auth })
  if (issues.length > 0) throw new ConfigError(issues)
  // Captured once checked, like the URL and the headers: a caller who changes the options later sends nothing unchecked.
  const extra = extraBody === undefined ? undefined : structuredClone(extraBody)
  const url = endpointUrl(baseUrl, '/v1/messages', query)
  // The version goes last, so no header can replace it.
  const sent = { ...requestHeaders(auth, apiKey, headers), 'anthropic-version': ANTHROPIC_VERSION }
  const redact = redactionsOf(baseUrl, apiKey, headers)

  return {
    id,
    model,
    async complete(request) {
      const { system, messages } = shapeMessages(request, systemPrompt)
      // JSON.stringify drops the undefined fields: no system inline, no temperature unless set, no output_config outside schema mode.
      const reply = await postJson<unknown>({
        providerId: id,
        url,
        headers: sent,
        body: mergeBody({
          model,
          max_tokens: maxTokens,
          system,
          messages,
          temperature: temperature ?? undefined,
          output_config: structuredOutput === 'schema' ? { format: { type: 'json_schema', schema: request.output.schema } } : undefined,
        }, extra),
        signal: request.signal,
        redact,
      })
      return readReply(reply, { id, model }, redact)
    },
  }
}
