import { ConfigError, ProviderError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import type { Usage } from '../core/types.ts'
import { endpointUrl, postJson, redactionsOf, snippet } from './http.ts'
import { shapeMessages } from './messages.ts'
import { httpOptionIssues, isRecord, mergeBody, requestHeaders } from './options.ts'
import type { Auth, HttpProviderOptions, StructuredOutput } from './options.ts'

/** The options of an OpenAI-compatible provider. */
export interface OpenAICompatibleOptions extends HttpProviderOptions {
  /** The body field that carries `maxTokens`: `max_tokens`, or `max_completion_tokens`, which OpenAI's reasoning models need. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
}

const MAX_MODEL_TEXT = 200
/** The body fields the adapter writes for the conversation, which `extraBody` cannot replace. */
const RESERVED_BODY_KEYS = ['model', 'messages', 'stream']
const MAX_TOKENS_FIELDS: ReadonlySet<unknown> = new Set(['max_tokens', 'max_completion_tokens'])
const STRUCTURED_OUTPUTS: ReadonlySet<unknown> = new Set(['prompt', 'json', 'schema'])

function responseFormat(mode: StructuredOutput, output: CompletionRequest['output']): unknown {
  if (mode === 'json') return { type: 'json_object' }
  if (mode === 'schema') return { type: 'json_schema', json_schema: { name: output.name, schema: output.schema, strict: true } }
  return undefined
}

function usageOf(reply: Record<string, unknown>): Usage | undefined {
  const usage = reply.usage
  if (!isRecord(usage)) return undefined
  const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = usage
  return typeof inputTokens === 'number' && typeof outputTokens === 'number' ? { inputTokens, outputTokens } : undefined
}

/**
 * Turn a chat completion reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted, and a malformed shape must fail as a provider error, not as a `TypeError`.
 */
function readReply(reply: unknown, { id, model }: Pick<OpenAICompatibleOptions, 'id' | 'model'>, redact: readonly string[]): CompletionResponse {
  const fail = (kind: ProviderErrorKind, message: string): ProviderError => new ProviderError({ providerId: id, kind, message })

  if (!isRecord(reply)) throw fail('invalid-response', 'reply is not a JSON object')

  const choice: unknown = Array.isArray(reply.choices) ? reply.choices[0] : undefined
  if (!isRecord(choice)) {
    const serverError = isRecord(reply.error) && typeof reply.error.message === 'string'
      ? `: server error ${snippet(reply.error.message, MAX_MODEL_TEXT, redact)}`
      : ''
    throw fail('invalid-response', `reply has no choices${serverError}`)
  }

  const message = isRecord(choice.message) ? choice.message : {}
  if (message.refusal) {
    const refusal = message.refusal
    throw fail('refusal', typeof refusal === 'string' ? `model refused: ${snippet(refusal, MAX_MODEL_TEXT, redact)}` : 'model refused')
  }
  if (choice.finish_reason === 'content_filter') throw fail('refusal', 'reply was stopped by the content filter')
  if (choice.finish_reason === 'length') throw fail('truncated', 'reply was cut off by the token limit')

  const { content } = message
  if (typeof content !== 'string') throw fail('invalid-response', 'reply has no message content')

  return {
    text: content,
    model: typeof reply.model === 'string' && reply.model !== '' ? reply.model : model,
    usage: usageOf(reply),
  }
}

/**
 * A provider for any OpenAI-compatible `/chat/completions` endpoint. The key, when there is one, travels
 * only in the header `auth` names, `Authorization: Bearer` by default (invariant I1).
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function openaiCompatible(options: OpenAICompatibleOptions): Provider {
  const { id, baseUrl, model, apiKey, auth = 'bearer' as Auth, headers, query, extraBody, temperature = 0, maxTokens, maxTokensField = 'max_tokens', systemPrompt = 'native', structuredOutput = 'json' } = options
  const issues = httpOptionIssues(options, auth, RESERVED_BODY_KEYS)
  if (!MAX_TOKENS_FIELDS.has(maxTokensField)) issues.push({ path: `${id}.maxTokensField`, message: 'must be max_tokens or max_completion_tokens' })
  if (!STRUCTURED_OUTPUTS.has(structuredOutput)) issues.push({ path: `${id}.structuredOutput`, message: 'must be prompt, json or schema' })
  if (issues.length > 0) throw new ConfigError(issues)
  const url = endpointUrl(baseUrl, '/chat/completions', query)
  const sent = requestHeaders(auth, apiKey, headers)
  const redact = redactionsOf(baseUrl, apiKey)

  return {
    id,
    model,
    async complete(request) {
      const { system, messages } = shapeMessages(request, systemPrompt)
      // JSON.stringify drops the undefined fields: no response_format for `prompt`, no temperature for null, no limit unless set.
      const reply = await postJson<unknown>({
        providerId: id,
        url,
        headers: sent,
        body: mergeBody({
          model,
          messages: system === undefined ? messages : [{ role: 'system', content: system }, ...messages],
          response_format: responseFormat(structuredOutput, request.output),
          temperature: temperature ?? undefined,
          [maxTokensField]: maxTokens,
        }, extraBody),
        signal: request.signal,
        redact,
      })
      return readReply(reply, { id, model }, redact)
    },
  }
}
