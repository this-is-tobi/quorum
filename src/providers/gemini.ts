import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import { postJson, snippet } from './http.ts'
import { shapeMessages } from './messages.ts'
import { isRecord, mergeBody, prepareHttp, unlessEmpty } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput } from './options.ts'
import { endedEarly, joinedText, replyFailure, tokenUsage } from './reply.ts'

/** The options of a Gemini provider: the ones every HTTP adapter takes, and no other. */
export type GeminiOptions = HttpProviderOptions

/** A Gemini model id, such as `gemini-3.8-flash`. It goes in the URL's path, so it holds no `/`, `?`, `#`, `%` or `:`. */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/i
/** The longest block reason quoted, in characters: the pattern's bound and the quote's cut. */
const MAX_BLOCK_REASON = 64
/** A block reason as the API writes one: only one of this shape is quoted. */
const BLOCK_REASON = new RegExp(`^[A-Z_]{1,${MAX_BLOCK_REASON}}$`)
/** The protocol's rules. The tool fields: `tools`, `toolConfig`, and `cachedContent`, since a cache can hold tools of its own. */
const RULES: Omit<AdapterRules, 'auth'> = {
  reservedBodyKeys: ['contents', 'systemInstruction'],
  toolBodyKeys: ['tools', 'toolConfig', 'cachedContent'],
  fixedHeaders: [],
  structuredOutputs: ['prompt', 'json', 'schema'],
}
/** The finish reasons of a reply cut off by the token limit: `CONTINUATION` stops at the per-request limit before the model is done. */
const CUT_OFF: ReadonlySet<unknown> = new Set(['MAX_TOKENS', 'CONTINUATION'])
/** The finish reasons of a reply the safety filter stopped. */
const FILTERED: ReadonlySet<unknown> = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'])

/** A `key` query parameter, in any letter case, would put the key in the URL: it travels only in the header `auth` names. */
function keyParameterIssues(id: string, query: Readonly<Record<string, unknown>>): ConfigIssue[] {
  return Object.keys(query)
    .filter(name => name.toLowerCase() === 'key')
    .map(name => ({ path: `${id}.query.${name}`, message: 'would carry a key in the URL: set apiKey instead' }))
}

/** What shapes the generation config: the options that set it, and the mode. */
interface Generation {
  temperature: number | null | undefined
  maxTokens: number | undefined
  structuredOutput: StructuredOutput
}

/** The generation config of a request, or undefined when it would be empty. */
function generationConfig({ temperature, maxTokens, structuredOutput }: Generation, output: CompletionRequest['output']): Record<string, unknown> | undefined {
  return unlessEmpty({
    temperature: temperature ?? undefined,
    maxOutputTokens: maxTokens,
    responseMimeType: structuredOutput === 'prompt' ? undefined : 'application/json',
    responseJsonSchema: structuredOutput === 'schema' ? output.schema : undefined,
  })
}

/**
 * Turn a `generateContent` reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted. A blocked prompt comes first, since its reply has no candidates.
 */
function readReply(reply: unknown, { id, model }: Pick<GeminiOptions, 'id' | 'model'>, redact: readonly string[]): CompletionResponse {
  const fail = replyFailure(id)
  if (!isRecord(reply)) throw fail('invalid-response', 'reply is not a JSON object')

  const blocked = isRecord(reply.promptFeedback) ? reply.promptFeedback.blockReason : undefined
  if (blocked !== undefined && blocked !== null) {
    const quoted = typeof blocked === 'string' && BLOCK_REASON.test(blocked) ? `: ${snippet(blocked, MAX_BLOCK_REASON, redact)}` : ''
    throw fail('refusal', `prompt was blocked${quoted}`)
  }

  const candidate: unknown = Array.isArray(reply.candidates) ? reply.candidates[0] : undefined
  if (!isRecord(candidate)) throw fail('invalid-response', 'reply has no candidates')

  const reason = candidate.finishReason
  if (reason === undefined || reason === null) throw fail('invalid-response', 'reply has not finished')
  if (CUT_OFF.has(reason)) throw fail('truncated', 'reply was cut off by the token limit')
  if (FILTERED.has(reason)) throw fail('refusal', 'reply was stopped by the safety filter')
  if (reason !== 'STOP') throw fail('invalid-response', endedEarly(reason, redact))

  const content = isRecord(candidate.content) ? candidate.content : {}
  const text = joinedText(content.parts, part => !part.thought)
  if (text === undefined) throw fail('invalid-response', 'reply has no text')

  return {
    text,
    model: typeof reply.modelVersion === 'string' && reply.modelVersion !== '' ? reply.modelVersion : model,
    usage: tokenUsage(reply.usageMetadata, ['promptTokenCount'], ['candidatesTokenCount', 'thoughtsTokenCount']),
  }
}

/**
 * A provider for the Gemini API's `generateContent`. The key, when there is one, travels only in the
 * header `auth` names, `x-goog-api-key` by default (invariant I1), never in the `key` query parameter.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function gemini(options: GeminiOptions): Provider {
  const { id, model, auth = { header: 'x-goog-api-key' } as Auth, query, temperature, maxTokens, systemPrompt = 'native', structuredOutput = 'json' } = options
  const modelId = typeof model === 'string' ? model.replace(/^models\//, '') : ''
  const issues = isRecord(query) ? keyParameterIssues(id, query) : []
  if (!MODEL_ID.test(modelId)) issues.push({ path: `${id}.model`, message: 'must be a Gemini model id, such as gemini-3.8-flash' })
  // The path is built before the checks, harmlessly: nothing is sent when they fail.
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, `/v1beta/models/${modelId}:generateContent`, issues)

  return {
    id,
    model,
    async complete(request) {
      const { system, messages } = shapeMessages(request, systemPrompt)
      // JSON.stringify drops the undefined fields: no systemInstruction inline, no generationConfig when it is empty.
      const reply = await postJson<unknown>({
        providerId: id,
        url,
        headers,
        body: mergeBody({
          contents: messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
          systemInstruction: system === undefined ? undefined : { parts: [{ text: system }] },
          generationConfig: generationConfig({ temperature, maxTokens, structuredOutput }, request.output),
        }, extraBody),
        signal: request.signal,
        redact,
      })
      return readReply(reply, { id, model }, redact)
    },
  }
}
