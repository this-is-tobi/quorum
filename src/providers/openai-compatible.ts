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

/** Finish reasons that end a reply before the model is done, besides the token limit and the content filter. */
const ENDED_EARLY: ReadonlySet<unknown> = new Set(['error', 'insufficient_system_resource', 'aborted'])
/** Finish reasons of a reply cut off by a limit: the token limit, or the model's context (Mistral's `model_length`). */
const CUT_OFF: ReadonlySet<unknown> = new Set(['length', 'model_length'])

/** The status a server error carries in its `code`, when that is an HTTP error status. */
function statusOf(code: unknown): number | undefined {
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : undefined
}

/** The text of a message's content: a string, or the `text` parts of an array of parts (Mistral), joined; thinking parts are skipped. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content.flatMap(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
  return texts.length === 0 ? undefined : texts.join('')
}

/**
 * Turn a chat completion reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted, and a malformed shape must fail as a provider error, not as a `TypeError`. A
 * server error comes first, since some servers answer 200 with one beside an empty choice (OpenRouter,
 * for a failure during generation), as `{ error: { message, code } }` or `{ error: "text" }`.
 */
function readReply(reply: unknown, { id, model }: Pick<OpenAICompatibleOptions, 'id' | 'model'>, redact: readonly string[]): CompletionResponse {
  const fail = (kind: ProviderErrorKind, message: string, status?: number): ProviderError => new ProviderError({ providerId: id, kind, message, status })

  if (!isRecord(reply)) throw fail('invalid-response', 'reply is not a JSON object')

  const { error } = reply
  if (typeof error === 'string' || isRecord(error)) {
    const text = typeof error === 'string' ? error : error.message
    const quoted = typeof text === 'string' ? `: ${snippet(text, MAX_MODEL_TEXT, redact)}` : ''
    const status = isRecord(error) ? statusOf(error.code) : undefined
    throw status === undefined ? fail('invalid-response', `server error${quoted}`) : fail('http', `server error ${status}${quoted}`, status)
  }

  const choice: unknown = Array.isArray(reply.choices) ? reply.choices[0] : undefined
  if (!isRecord(choice)) throw fail('invalid-response', 'reply has no choices')

  const message = isRecord(choice.message) ? choice.message : {}
  if (message.refusal) {
    const refusal = message.refusal
    throw fail('refusal', typeof refusal === 'string' ? `model refused: ${snippet(refusal, MAX_MODEL_TEXT, redact)}` : 'model refused')
  }
  const reason = choice.finish_reason
  if (reason === 'content_filter') throw fail('refusal', 'reply was stopped by the content filter')
  if (CUT_OFF.has(reason)) throw fail('truncated', 'reply was cut off by the token limit')
  if (ENDED_EARLY.has(reason)) throw fail('invalid-response', `reply ended early: ${JSON.stringify(reason)}`)

  const text = textOf(message.content)
  if (text === undefined) throw fail('invalid-response', 'reply has no message content')

  return {
    text,
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
  // Captured once checked, like the URL and the headers: a caller who changes the options later sends nothing unchecked.
  const extra = extraBody === undefined ? undefined : structuredClone(extraBody)
  const url = endpointUrl(baseUrl, '/chat/completions', query)
  const sent = requestHeaders(auth, apiKey, headers)
  const redact = redactionsOf(baseUrl, apiKey, headers)

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
        }, extra),
        signal: request.signal,
        redact,
      })
      return readReply(reply, { id, model }, redact)
    },
  }
}
