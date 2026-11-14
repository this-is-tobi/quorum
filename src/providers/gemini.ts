import { issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import { postJson, snippet } from './http.ts'
import { shapeMessages } from './messages.ts'
import { bodyKeyForm, isRecord, mergeBody, prepareHttp, spellingIssues, unlessEmpty } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput } from './options.ts'
import { endedEarly, joinedText, replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget } from './size.ts'

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
  replyLimitPaths: [
    ['generationConfig', 'maxOutputTokens'],
  ],
  fixedHeaders: [],
  structuredOutputs: ['prompt', 'json', 'schema'],
}
/** The one spelling of the generation config's key that the adapter merges its own into. */
const GENERATION_CONFIG = 'generationConfig'
/** The finish reasons of a reply cut off by the token limit: `CONTINUATION` stops at the per-request limit before the model is done. */
const CUT_OFF: ReadonlySet<unknown> = new Set(['MAX_TOKENS', 'CONTINUATION'])
/** The finish reasons of a reply the safety filter stopped. */
const FILTERED: ReadonlySet<unknown> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
])

/** A `key` query parameter, in any letter case, would put the key in the URL: it travels only in the header `auth` names. */
function keyParameterIssues(id: string, query: Readonly<Record<string, unknown>>): ConfigIssue[] {
  return Object.keys(query)
    .filter(name => name.toLowerCase() === 'key')
    .map(name => ({ path: `${id}.${issuePath(['query', name])}`, message: 'would carry a key in the URL: set apiKey instead' }))
}

/**
 * The problems of a `generationConfig` in `extraBody`: one that is no object, which would replace the one the
 * adapter writes and drop the reply limit the guard reserves, and one spelled another way than the adapter
 * merges it, which would send a second key. Proto JSON takes the field as `generation_config` too, and a key in
 * any letter case, so the key is matched as the other rules match one.
 */
function generationConfigIssues(id: string, extraBody: unknown): ConfigIssue[] {
  if (!isRecord(extraBody)) return []
  return Object.entries(extraBody).flatMap(([key, value]): ConfigIssue[] => {
    if (bodyKeyForm(key) !== bodyKeyForm(GENERATION_CONFIG)) return []
    return isRecord(value)
      ? spellingIssues(id, key, GENERATION_CONFIG)
      : [
          { path: `${id}.${issuePath(['extraBody', key])}`, message: 'must be an object' },
        ]
  })
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
    responseMimeType: structuredOutput === 'prompt'
      ? undefined
      : 'application/json',
    responseJsonSchema: structuredOutput === 'schema'
      ? output.schema
      : undefined,
  })
}

/**
 * Turn a `generateContent` reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted. A blocked prompt comes first, since its reply has no candidates. The counts are read
 * once, after the body check, and every failure from then on carries them, since the server generated those
 * tokens. Gemini leaves a zero count out of its JSON, so a candidates count the reply leaves out reads as 0.
 */
function readReply(reply: unknown, { id, model }: Pick<GeminiOptions, 'id' | 'model'>, redact: readonly string[]): CompletionResponse {
  if (!isRecord(reply)) throw replyFailure(id)('invalid-response', 'reply is not a JSON object')

  const usage = isRecord(reply.usageMetadata)
    ? tokenUsage({ candidatesTokenCount: 0, ...reply.usageMetadata }, ['promptTokenCount'], ['candidatesTokenCount', 'thoughtsTokenCount'])
    : undefined
  const fail = replyFailure(id, usage)
  const blocked = isRecord(reply.promptFeedback)
    ? reply.promptFeedback.blockReason
    : undefined
  if (blocked !== undefined && blocked !== null) {
    const quoted = typeof blocked === 'string' && BLOCK_REASON.test(blocked)
      ? `: ${snippet(blocked, MAX_BLOCK_REASON, redact)}`
      : ''
    throw fail('refusal', `prompt was blocked${quoted}`)
  }

  const candidate: unknown = Array.isArray(reply.candidates)
    ? reply.candidates[0]
    : undefined
  if (!isRecord(candidate)) throw fail('invalid-response', 'reply has no candidates')

  const reason = candidate.finishReason
  if (reason === undefined || reason === null) throw fail('invalid-response', 'reply has not finished')
  if (CUT_OFF.has(reason)) throw fail('truncated', 'reply was cut off by the token limit')
  if (FILTERED.has(reason)) throw fail('refusal', 'reply was stopped by the safety filter')
  if (reason !== 'STOP') throw fail('invalid-response', endedEarly(reason, redact))

  const content = isRecord(candidate.content)
    ? candidate.content
    : {}
  const text = joinedText(content.parts, part => !part.thought)
  if (text === undefined) throw fail('invalid-response', 'reply has no text')

  return {
    text,
    model: typeof reply.modelVersion === 'string' && reply.modelVersion !== ''
      ? reply.modelVersion
      : model,
    usage,
  }
}

/**
 * A provider for the Gemini API's `generateContent`. The key, when there is one, travels only in the
 * header `auth` names, `x-goog-api-key` by default (invariant I1), never in the `key` query parameter. It
 * refuses, before any request, a request that may not fit `contextTokens`.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function gemini(options: GeminiOptions): Provider {
  const { id, model, auth = { header: 'x-goog-api-key' } as Auth, query, temperature, maxTokens, contextTokens, systemPrompt = 'native', structuredOutput = 'json' } = options
  const modelId = typeof model === 'string'
    ? model.replace(/^models\//, '')
    : ''
  const issues = [
    ...(isRecord(query)
      ? keyParameterIssues(id, query)
      : []),
    ...generationConfigIssues(id, options.extraBody),
  ]
  if (!MODEL_ID.test(modelId)) issues.push({ path: `${id}.model`, message: 'must be a Gemini model id, such as gemini-3.8-flash' })
  // The path is built before the checks, harmlessly: nothing is sent when they fail.
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, `/v1beta/models/${modelId}:generateContent`, issues)
  const budget = contextBudget(contextTokens, maxTokens)

  return {
    id,
    model,
    async complete(request) {
      const { system, messages } = shapeMessages(request, systemPrompt)
      checkFits(id, { system, messages }, request.output, budget)
      // JSON.stringify drops the undefined fields: no systemInstruction inline, no generationConfig when it is empty.
      const reply = await postJson<unknown>({
        providerId: id,
        url,
        headers,
        body: mergeBody({
          contents: messages.map(message => ({
            role: message.role === 'assistant'
              ? 'model'
              : 'user',
            parts: [
              { text: message.content },
            ],
          })),
          systemInstruction: system === undefined
            ? undefined
            : {
                parts: [
                  { text: system },
                ],
              },
          generationConfig: generationConfig({ temperature, maxTokens, structuredOutput }, request.output),
        }, extraBody),
        signal: request.signal,
        redact,
      })
      return readReply(reply, { id, model }, redact)
    },
  }
}
