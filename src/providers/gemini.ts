import { issuePath, ProviderError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { DEFAULT_RETRIES } from '../core/ports.ts'
import type { CompletionRequest, CompletionResponse, Provider, StreamSignal } from '../core/ports.ts'
import { endpointUrl, postStream, replyOf, snippet } from './http.ts'
import type { ErrorHints, PostStreamOptions } from './http.ts'
import { shapeMessages } from './messages.ts'
import { adaptsOf, attemptFacts, bodyKeyForm, isRecord, mergeBody, prepareHttp, requestSettings, spellingIssues, streamFacts, thinkingIssues } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput, Thinking, ThinkingControl } from './options.ts'
import { endedEarly, joinedText, MAX_MODEL_TEXT, readAnswer, replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget, replyBudgetOf, roomTokens, statedReply, worstCaseTokens } from './size.ts'
import type { ContextBudget } from './size.ts'
import { answerTooLong, listField, malformedStream, MAX_ANSWER_CHARS, objectField, objectValue, streamedTokens, streamEnded, textField } from './stream.ts'
import type { StreamItem } from './stream.ts'

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
/** The path of the model's method that answers a whole reply, and of the one that streams it, which the query's `alt=sse` turns into server-sent events. */
const WHOLE_METHOD = 'generateContent'
const STREAM_METHOD = 'streamGenerateContent'
/** The words a 400 may name when the server refuses streaming: the method's name, since this protocol streams by its path and has no body field for it. */
const STREAM_WORDS: NonNullable<PostStreamOptions['streamWords']> = [
  { word: STREAM_METHOD, refused: 'stream' },
]
/** The one spelling of the generation config's key that the adapter merges its own into. */
const GENERATION_CONFIG = 'generationConfig'
/** `generationConfig.thinkingConfig`, whose `thinkingLevel` is `LOW`, or `MINIMAL` for `off`, "little to no thinking": a level Gemini does not let a model turn off. Its `thinkingBudget` is the same control, so a config of either is one. */
const THINKING: ThinkingControl = {
  path: [GENERATION_CONFIG, 'thinkingConfig'],
}
/** The body fields that set the structured-output mode, in each spelling a 400 may name them, which the server reads in camel or snake case. */
const FORMAT_FIELDS = [
  'responseMimeType',
  'responseJsonSchema',
  'response_mime_type',
  'response_json_schema',
]
/** Where an `extraBody` would set the mode: the proto JSON name, which `bodyKeyForm` reads in either spelling. */
const FORMAT_PATHS = [
  [GENERATION_CONFIG, 'responseMimeType'],
  [GENERATION_CONFIG, 'responseJsonSchema'],
]
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

const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo'
const QUOTA_FAILURE = 'type.googleapis.com/google.rpc.QuotaFailure'
/** A `retryDelay` as Google's protobuf JSON writes a duration: whole or fractional seconds, nine digits at most. */
const RETRY_DELAY = /^(\d+(?:\.\d{1,9})?)s$/
/** The part of a quota's id that names a per-day limit, which no wait of seconds lifts. */
const PER_DAY = 'PerDay'
/** The string `error.code` of Google's Interactions API for a used-up quota or a payment owed, which a gateway may forward. */
const EXHAUSTED_CODES: ReadonlySet<unknown> = new Set(['quota_exceeded', 'payment_required'])

/** The entries of `list` that are objects of the given `@type`, when it is a list. */
function detailsOfType(list: unknown, type: string): Array<Record<string, unknown>> {
  return Array.isArray(list)
    ? list.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry['@type'] === type)
    : []
}

/** A `retryDelay` as milliseconds, when it is a positive duration in seconds. */
function delayMs(retryDelay: unknown): number | undefined {
  const match = typeof retryDelay === 'string'
    ? RETRY_DELAY.exec(retryDelay)
    : null
  const ms = Number(match?.[1]) * 1000
  return Number.isFinite(ms) && ms > 0
    ? ms
    : undefined
}

/**
 * What an error body of Google's `{ error: { details } }` says of a retry, read defensively: the first
 * `RetryInfo` with a valid `retryDelay` is the wait, and a `QuotaFailure` violation whose `quotaId` names
 * a per-day limit turns the retry off, whatever the delay says, since the quota is back only the next day, and
 * the quota is used up. So is an `error.code` that is the string `quota_exceeded` or `payment_required`, the
 * Interactions API's form: `generateContent` answers Google's standard body, whose `error.code` is the HTTP
 * status as a number, so a 402 of that form holds neither and is read by its status alone, never exhausted.
 * Only numbers and a verdict leave this function: no text of the body does.
 */
function errorHints(body: unknown): ErrorHints {
  const details = isRecord(body) && isRecord(body.error)
    ? body.error.details
    : undefined
  const retryAfterMs = detailsOfType(details, RETRY_INFO).map(info => delayMs(info.retryDelay)).find(ms => ms !== undefined)
  const perDay = detailsOfType(details, QUOTA_FAILURE).some(failure => Array.isArray(failure.violations)
    && failure.violations.some(violation => isRecord(violation) && typeof violation.quotaId === 'string' && violation.quotaId.includes(PER_DAY)))
  const exhausted = perDay || (isRecord(body) && isRecord(body.error) && EXHAUSTED_CODES.has(body.error.code))
  return {
    ...(retryAfterMs === undefined
      ? {}
      : { retryAfterMs }),
    ...(exhausted
      ? { retryable: false as const, exhausted: true as const }
      : {}),
  }
}

/** A `key` query parameter, in any letter case, would put the key in the URL: it travels only in the header `auth` names. */
function keyParameterIssues(id: string, query: Readonly<Record<string, unknown>>): ConfigIssue[] {
  return Object.keys(query)
    .filter(name => name.toLowerCase() === 'key')
    .map(name => ({ path: `${id}.${issuePath(['query', name])}`, message: 'would carry a key in the URL: set apiKey instead' }))
}

/** An `alt` query parameter, in any letter case, would change the form of the reply the adapter reads: the adapter sets it for a stream. */
function altParameterIssues(id: string, query: Readonly<Record<string, unknown>>): ConfigIssue[] {
  return Object.keys(query)
    .filter(name => name.toLowerCase() === 'alt')
    .map(name => ({ path: `${id}.${issuePath(['query', name])}`, message: 'is set by the adapter and cannot be replaced' }))
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

/** What shapes the generation config: the options that set it, the reply's limit and the mode. */
interface Generation {
  temperature: number | null | undefined
  replyTokens: number
  structuredOutput: StructuredOutput
  thinking: Thinking | undefined
}

/** The generation config of a request: it always holds the reply's limit. */
function generationConfig({ temperature, replyTokens, structuredOutput, thinking }: Generation, output: CompletionRequest['output']): Record<string, unknown> {
  return {
    temperature: temperature ?? undefined,
    maxOutputTokens: replyTokens,
    responseMimeType: structuredOutput === 'prompt'
      ? undefined
      : 'application/json',
    responseJsonSchema: structuredOutput === 'schema'
      ? output.schema
      : undefined,
    thinkingConfig: thinking === undefined
      ? undefined
      : {
          thinkingLevel: thinking === 'off'
            ? 'MINIMAL'
            : 'LOW',
        },
  }
}

/** Whether the reply showed thoughts: a part flagged `thought`, or a `thoughtsTokenCount` above 0. Only the fact is read, never a thought's text. */
function showedThoughts(parts: unknown, usageMetadata: unknown): boolean {
  if (Array.isArray(parts) && parts.some(part => isRecord(part) && part.thought === true)) return true
  const tokens = isRecord(usageMetadata)
    ? usageMetadata.thoughtsTokenCount
    : undefined
  return typeof tokens === 'number' && tokens > 0
}

/**
 * Turn a `generateContent` reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted. A blocked prompt comes first, since its reply has no candidates. The counts are read
 * once, after the body check, and every failure from then on carries them, since the server generated those
 * tokens. Gemini leaves a zero count out of its JSON, so a candidates count the reply leaves out reads as 0. What
 * the reply lacked, once its finish reason is `STOP` or a cut-off, is `readAnswer`'s: its output is the candidates
 * plus the thoughts, which the limit counts.
 */
function readReply(reply: unknown, { id, model, budget }: Pick<GeminiOptions, 'id' | 'model'> & { readonly budget: ContextBudget }, redact: readonly string[]): CompletionResponse {
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
  if (FILTERED.has(reason)) throw fail('refusal', 'reply was stopped by the safety filter')
  const cutOff = CUT_OFF.has(reason)
  if (!cutOff && reason !== 'STOP') throw fail('invalid-response', endedEarly(reason, redact))

  const content = isRecord(candidate.content)
    ? candidate.content
    : {}
  const { text, reasoning } = readAnswer(id, {
    text: joinedText(content.parts, part => !part.thought),
    flaggedCutOff: cutOff,
    windowEnded: false,
    reasoned: showedThoughts(content.parts, reply.usageMetadata),
    limit: budget.replyTokens,
    usage,
  })

  return {
    text,
    reasoning,
    model: typeof reply.modelVersion === 'string' && reply.modelVersion !== ''
      ? reply.modelVersion
      : model,
    usage,
  }
}

/** One part of the candidate a stream builds: a text joined from the chunks, or a thought known by the fact alone. */
type Part = { text: string, thought?: undefined } | { thought: true }

/** The error a chunk holds, as a failed reply's: Google's standard body, whose numeric `code` is the status, read through `errorHints`. */
function streamError(chunk: Record<string, unknown>, providerId: string, redact: readonly string[]): ProviderError {
  const { error } = chunk
  const code = isRecord(error)
    ? error.code
    : undefined
  const status = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599
    ? code
    : undefined
  const hints = errorHints(chunk)
  const text = isRecord(error)
    ? error.message
    : error
  const quoted = typeof text === 'string'
    ? `: ${snippet(text, MAX_MODEL_TEXT, redact)}`
    : ''
  return new ProviderError({
    providerId,
    kind: status === undefined
      ? 'invalid-response'
      : 'http',
    message: status === undefined
      ? `server error${quoted}`
      : `server error ${status}${quoted}`,
    status,
    retryAfterMs: hints.retryAfterMs,
    retryable: hints.retryable,
    ...hints.exhausted === true
      ? { exhausted: true as const }
      : {},
  })
}

/** The output tokens `usageMetadata` has counted so far: the candidates' and the thoughts', each when it is a number. */
function countedOutput(usageMetadata: unknown): number {
  if (!isRecord(usageMetadata)) return 0
  return ['candidatesTokenCount', 'thoughtsTokenCount'].reduce((sum, key) => {
    const count = usageMetadata[key]
    return typeof count === 'number' && Number.isFinite(count) && count >= 0
      ? sum + count
      : sum
  }, 0)
}

/**
 * The whole reply a `streamGenerateContent` stream amounts to, in the shape `readReply` reads, so every check of a whole
 * reply runs on it unchanged: the `modelVersion` of the first chunk that names one; the prompt feedback's `blockReason`;
 * the last `usageMetadata` seen, whose counts are cumulative; and `candidates[0]` of each chunk, its parts in order, the
 * text parts joined, a `thought` part kept with no text, since only the fact that it showed is read, and any other part
 * left out, with the last `finishReason` it names. Reasoning is counted and never kept. A chunk's `error` ends the read at
 * once, as the failure `streamError` names, read through `errorHints`.
 *
 * The stream is complete at a candidate's `finishReason`, or a prompt's `blockReason`, and is read on to the body's end,
 * since the usage may come in a chunk after it. A body that ends with neither is a broken stream, the `network` failure
 * `streamEnded` names, never an answer. One rule holds for every field: an unknown part type, and an absent field, are
 * tolerated, and a chunk whose field is present with the wrong type, a chunk, candidate or part that is no object, `parts`
 * or `candidates` that is no list, or a text that is no text, ends the read as an `invalid-response` that is never retried,
 * with the body cancelled, so a dropped field never lets a partial answer be read as a whole one. A text that passes
 * 1 000 000 characters ends it the same way. Each chunk
 * reports a `data` signal: the larger of the server's own output count and a quarter of the characters streamed so far,
 * and whether an answer or reasoning has shown text.
 */
export async function assembleGemini(items: AsyncIterable<StreamItem>, providerId: string, onProgress?: (signal: StreamSignal) => void, redact: readonly string[] = []): Promise<Record<string, unknown>> {
  const parts: Part[] = []
  let modelVersion: string | undefined
  let blockReason: unknown
  let usageMetadata: Record<string, unknown> | undefined
  let finishReason: unknown
  let seenCandidate = false
  let answerChars = 0
  let reasoningChars = 0

  const readPart = (part: Record<string, unknown>): void => {
    const text = textField(providerId, part.text, 'text')
    const last = parts.at(-1)
    if (part.thought === true) {
      if (text !== undefined) reasoningChars += text.length
      if (last?.thought !== true) parts.push({ thought: true })
      return
    }
    if (text === undefined) return
    answerChars += text.length
    if (answerChars > MAX_ANSWER_CHARS) throw answerTooLong(providerId)
    if (last !== undefined && last.thought === undefined) last.text += text
    else parts.push({ text })
  }
  const readChunk = (chunk: Record<string, unknown>): void => {
    const version = textField(providerId, chunk.modelVersion, 'modelVersion')
    if (modelVersion === undefined && version !== undefined && version !== '') modelVersion = version
    usageMetadata = objectField(providerId, chunk.usageMetadata, 'usageMetadata') ?? usageMetadata
    const feedback = objectField(providerId, chunk.promptFeedback, 'promptFeedback')
    if (feedback !== undefined && blockReason === undefined) blockReason = feedback.blockReason ?? undefined
    const candidates = listField(providerId, chunk.candidates, 'candidates')
    if (candidates === undefined || candidates.length === 0) return
    const candidate = objectValue(providerId, candidates[0], 'candidate')
    seenCandidate = true
    if (candidate.finishReason !== undefined && candidate.finishReason !== null) finishReason = candidate.finishReason
    const content = objectField(providerId, candidate.content, 'content')
    for (const part of listField(providerId, content?.parts, 'parts') ?? []) readPart(objectValue(providerId, part, 'part'))
  }
  const finished = (): boolean => finishReason !== undefined || (blockReason !== undefined && blockReason !== null)
  const assembled = (): Record<string, unknown> => ({
    ...modelVersion === undefined
      ? {}
      : { modelVersion },
    ...blockReason === undefined
      ? {}
      : {
          promptFeedback: { blockReason },
        },
    ...seenCandidate
      ? {
          candidates: [
            {
              content: { parts, role: 'model' },
              ...finishReason === undefined
                ? {}
                : { finishReason },
              index: 0,
            },
          ],
        }
      : {},
    ...usageMetadata === undefined
      ? {}
      : { usageMetadata },
  })

  for await (const item of items) {
    if (item.kind !== 'event') continue
    const chunk = objectValue(providerId, item.value, 'chunk')
    if (chunk.error !== undefined && chunk.error !== null) {
      if (typeof chunk.error !== 'string' && !isRecord(chunk.error)) throw malformedStream(providerId, 'error', 'object')
      throw streamError(chunk, providerId, redact)
    }
    readChunk(chunk)
    onProgress?.({
      kind: 'data',
      outputTokens: streamedTokens(countedOutput(usageMetadata), answerChars + reasoningChars),
      answer: answerChars > 0,
      reasoning: reasoningChars > 0,
    })
  }
  if (!finished()) throw streamEnded(providerId)
  return assembled()
}

/**
 * A provider for the Gemini API's `generateContent`. The key, when there is one, travels only in the
 * header `auth` names, `x-goog-api-key` by default (invariant I1), never in the `key` query parameter. It
 * refuses, before any request, a request that may not fit `contextTokens`. It sends the reply's limit,
 * the request's reply budget at most `maxTokens`, else `maxTokens`, else 16000 (`replyBudgetOf`), as
 * `generationConfig.maxOutputTokens`, so the server bounds a reply's length. It states its worst case from the
 * count its size guard keeps: the text it sends, the template reserve and that budget, and the room its guard
 * leaves from the same count: `contextTokens` less those three. It also states its window, its `maxTokens` when
 * set, and its thinking: the option's level, else `default`, which it sends as `thinkingConfig.thinkingLevel`. Unless
 * the options set `thinking`, or `extraBody` sets `thinkingConfig`, it states that the core may lower thinking to `low`,
 * and honours the request's `thinking`; unless the options set `structuredOutput`, or `extraBody` sets the mode, it
 * states that the core may move it from `json` to `prompt`, and honours the request's `structuredOutput`. A 400 or
 * 422 that names `responseMimeType` or `responseJsonSchema`, in either spelling, sent in `json` or `schema` mode, is
 * marked `refused` for the structured output.
 *
 * It streams every reply, a whole request's too, through `postStream`: the model's `streamGenerateContent` with `alt=sse`
 * added to the query, which `assembleGemini` reads into the whole reply `readReply` checks, complete at a finish reason.
 * It states `streams` unless the option `stream` is `false`, and that it may step down, `adapts.stream`, when the option is
 * unset: the request's `stream` `false`, and the option `false`, post to `generateContent` for a whole reply. A 400 or 422
 * that names `streamGenerateContent` is marked `refused` as `stream`. A server that answers a streamed request whole gives
 * a reply marked `whole`. The options' `query` may not set `alt`.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function gemini(options: GeminiOptions): Provider {
  const { id, model, auth = { header: 'x-goog-api-key' } as Auth, query, temperature, maxTokens, contextTokens, systemPrompt = 'native', structuredOutput = 'json', thinking, retries = DEFAULT_RETRIES, stream: streamOption } = options
  const modelId = typeof model === 'string'
    ? model.replace(/^models\//, '')
    : ''
  const issues = [
    ...(isRecord(query)
      ? [
          ...keyParameterIssues(id, query),
          ...altParameterIssues(id, query),
        ]
      : []),
    ...generationConfigIssues(id, options.extraBody),
    ...thinkingIssues(id, thinking, options.extraBody, THINKING),
  ]
  if (!MODEL_ID.test(modelId)) issues.push({ path: `${id}.model`, message: 'must be a Gemini model id, such as gemini-3.8-flash' })
  // The path is built before the checks, harmlessly: nothing is sent when they fail.
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, `/v1beta/models/${modelId}:${WHOLE_METHOD}`, issues)
  // The stream's URL is the same with its method and `alt=sse`, written after the options' own query, which holds no `alt`.
  const streamUrl = endpointUrl(options.baseUrl, `/v1beta/models/${modelId}:${STREAM_METHOD}`, { ...query, alt: 'sse' })
  const budgetOf = (request: CompletionRequest): ContextBudget => contextBudget(contextTokens, replyBudgetOf(request, maxTokens))
  const adapting = adaptsOf(options, {
    level: 'low',
    control: THINKING,
    format: FORMAT_PATHS,
    streams: true,
  })

  return {
    id,
    model,
    ...attemptFacts(options),
    retries,
    ...streamFacts(streamOption),
    ...statedReply(contextTokens, maxTokens, thinking),
    ...adapting,
    worstCase: request => worstCaseTokens(shapeMessages(request, systemPrompt), request.output, budgetOf(request)),
    room: request => roomTokens(shapeMessages(request, systemPrompt), request.output, budgetOf(request)),
    async complete(request) {
      const { system, messages } = shapeMessages(request, systemPrompt)
      const budget = budgetOf(request)
      checkFits(id, { system, messages }, request.output, budget)
      const settings = requestSettings({ thinking, structuredOutput }, adapting.adapts, request)
      const streams = streamOption !== false && settings.stream !== false
      // JSON.stringify drops the undefined fields: no systemInstruction inline, no temperature unless set.
      const sentReply = await postStream({
        providerId: id,
        url: streams
          ? streamUrl
          : url,
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
          generationConfig: generationConfig({
            temperature,
            replyTokens: budget.replyTokens,
            structuredOutput: settings.structuredOutput,
            thinking: settings.thinking,
          }, request.output),
        }, extraBody),
        signal: request.signal,
        redact,
        errorHints,
        format: 'sse',
        onProgress: request.onProgress,
        ...streams
          ? { streamWords: STREAM_WORDS }
          : {},
        ...settings.structuredOutput === 'prompt'
          ? {}
          : { formatFields: FORMAT_FIELDS },
      })
      return replyOf(sentReply, streams, items => assembleGemini(items, id, request.onProgress, redact), reply => readReply(reply, { id, model, budget }, redact))
    },
  }
}
