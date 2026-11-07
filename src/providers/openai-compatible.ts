import { ConfigError, ProviderError } from '../core/errors.ts'
import type { ConfigIssue, ProviderErrorKind } from '../core/errors.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import type { Usage } from '../core/types.ts'
import { postJson, snippet } from './http.ts'

/** How the reply shape reaches the endpoint: described in the prompt only, as a JSON object, or as a strict schema. */
export type StructuredOutput = 'prompt' | 'json' | 'schema'

export interface OpenAICompatibleOptions {
  id: string
  baseUrl: string
  model: string
  apiKey?: string
  /** `null` omits the field, for models that reject it. */
  temperature?: number | null
  structuredOutput?: StructuredOutput
}

const MAX_MODEL_TEXT = 200
const HTTP_URL_WITH_HOST = /^https?:\/\/[^/\\?#\s]/i
const NOT_HEADER_SAFE = /[^\x21-\x7E]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A scheme, then a host: URL parsing skips extra slashes, so `https:///v1` would otherwise send the request to a host named `v1`. */
function isHttpUrlWithHost(baseUrl: string): boolean {
  if (!HTTP_URL_WITH_HOST.test(baseUrl)) return false
  try {
    return new URL(baseUrl).host !== ''
  } catch {
    return false
  }
}

/** Neither message repeats the value: a base URL can carry credentials, and a key is a secret. */
function assertValidOptions({ id, baseUrl, apiKey }: OpenAICompatibleOptions): void {
  const issues: ConfigIssue[] = []
  if (!isHttpUrlWithHost(baseUrl)) {
    issues.push({ path: `${id}.baseUrl`, message: 'must be an http:// or https:// URL with a host' })
  }
  if (apiKey !== undefined && NOT_HEADER_SAFE.test(apiKey)) {
    issues.push({ path: `${id}.apiKey`, message: 'must only contain visible ASCII characters, which an HTTP header can carry' })
  }
  if (issues.length > 0) throw new ConfigError(issues)
}

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
function readReply(reply: unknown, { id, model, apiKey }: Pick<OpenAICompatibleOptions, 'id' | 'model' | 'apiKey'>): CompletionResponse {
  const fail = (kind: ProviderErrorKind, message: string): ProviderError => new ProviderError({ providerId: id, kind, message })

  if (!isRecord(reply)) throw fail('invalid-response', 'reply is not a JSON object')

  const choice: unknown = Array.isArray(reply.choices) ? reply.choices[0] : undefined
  if (!isRecord(choice)) {
    const serverError = isRecord(reply.error) && typeof reply.error.message === 'string'
      ? `: server error ${snippet(reply.error.message, MAX_MODEL_TEXT, apiKey)}`
      : ''
    throw fail('invalid-response', `reply has no choices${serverError}`)
  }

  const message = isRecord(choice.message) ? choice.message : {}
  if (message.refusal) {
    const refusal = message.refusal
    throw fail('refusal', typeof refusal === 'string' ? `model refused: ${snippet(refusal, MAX_MODEL_TEXT, apiKey)}` : 'model refused')
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
 * only in the `Authorization` header (invariant I1).
 *
 * @throws ConfigError when the base URL is not an http(s) URL with a host or the key cannot be an HTTP header value
 */
export function openaiCompatible(options: OpenAICompatibleOptions): Provider {
  assertValidOptions(options)
  const { id, baseUrl, model, apiKey, temperature = 0, structuredOutput = 'json' } = options
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined

  return {
    id,
    model,
    async complete(request) {
      // JSON.stringify drops the undefined fields: no response_format for `prompt`, no temperature for null.
      const reply = await postJson<unknown>({
        providerId: id,
        url,
        headers,
        body: {
          model,
          messages: [{ role: 'system', content: request.system }, ...request.messages],
          response_format: responseFormat(structuredOutput, request.output),
          temperature: temperature ?? undefined,
        },
        signal: request.signal,
        secret: apiKey,
      })
      return readReply(reply, { id, model, apiKey })
    },
  }
}
