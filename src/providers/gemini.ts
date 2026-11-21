import { issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from '../core/ports.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import { postJson, snippet } from './http.ts'
import type { ErrorHints } from './http.ts'
import { shapeMessages } from './messages.ts'
import { bodyKeyForm, isRecord, mergeBody, prepareHttp, spellingIssues, thinkingIssues } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput, Thinking, ThinkingControl } from './options.ts'
import { endedEarly, joinedText, readAnswer, replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget, replyBudgetOf, roomTokens, statedReply, worstCaseTokens } from './size.ts'
import type { ContextBudget } from './size.ts'

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
/** `generationConfig.thinkingConfig`, whose `thinkingLevel` is `LOW`, or `MINIMAL` for `off`, "little to no thinking": a level Gemini does not let a model turn off. Its `thinkingBudget` is the same control, so a config of either is one. */
const THINKING: ThinkingControl = {
  path: [GENERATION_CONFIG, 'thinkingConfig'],
}
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
 * a per-day limit turns the retry off, whatever the delay says, since the quota is back only the next day.
 * Only numbers and a verdict leave this function: no text of the body does.
 */
function errorHints(body: unknown): ErrorHints {
  const details = isRecord(body) && isRecord(body.error)
    ? body.error.details
    : undefined
  const retryAfterMs = detailsOfType(details, RETRY_INFO).map(info => delayMs(info.retryDelay)).find(ms => ms !== undefined)
  const perDay = detailsOfType(details, QUOTA_FAILURE).some(failure => Array.isArray(failure.violations)
    && failure.violations.some(violation => isRecord(violation) && typeof violation.quotaId === 'string' && violation.quotaId.includes(PER_DAY)))
  return {
    ...(retryAfterMs === undefined
      ? {}
      : { retryAfterMs }),
    ...(perDay
      ? { retryable: false }
      : {}),
  }
}

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

/**
 * A provider for the Gemini API's `generateContent`. The key, when there is one, travels only in the
 * header `auth` names, `x-goog-api-key` by default (invariant I1), never in the `key` query parameter. It
 * refuses, before any request, a request that may not fit `contextTokens`. It sends the reply's limit,
 * the request's reply budget at most `maxTokens`, else `maxTokens`, else 16000 (`replyBudgetOf`), as
 * `generationConfig.maxOutputTokens`, so the server bounds a reply's length. It states its worst case from the
 * count its size guard keeps: the text it sends, the template reserve and that budget, and the room its guard
 * leaves from the same count: `contextTokens` less those three. It also states its window, its `maxTokens` when
 * set, and its thinking: the option's level, else `default`, which it sends as `thinkingConfig.thinkingLevel`.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function gemini(options: GeminiOptions): Provider {
  const { id, model, auth = { header: 'x-goog-api-key' } as Auth, query, temperature, maxTokens, contextTokens, systemPrompt = 'native', structuredOutput = 'json', thinking, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = options
  const modelId = typeof model === 'string'
    ? model.replace(/^models\//, '')
    : ''
  const issues = [
    ...(isRecord(query)
      ? keyParameterIssues(id, query)
      : []),
    ...generationConfigIssues(id, options.extraBody),
    ...thinkingIssues(id, thinking, options.extraBody, THINKING),
  ]
  if (!MODEL_ID.test(modelId)) issues.push({ path: `${id}.model`, message: 'must be a Gemini model id, such as gemini-3.8-flash' })
  // The path is built before the checks, harmlessly: nothing is sent when they fail.
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, `/v1beta/models/${modelId}:generateContent`, issues)
  const budgetOf = (request: CompletionRequest): ContextBudget => contextBudget(contextTokens, replyBudgetOf(request, maxTokens))

  return {
    id,
    model,
    timeoutMs,
    retries,
    ...statedReply(contextTokens, maxTokens, thinking),
    worstCase: request => worstCaseTokens(shapeMessages(request, systemPrompt), request.output, budgetOf(request)),
    room: request => roomTokens(shapeMessages(request, systemPrompt), request.output, budgetOf(request)),
    async complete(request) {
      const { system, messages } = shapeMessages(request, systemPrompt)
      const budget = budgetOf(request)
      checkFits(id, { system, messages }, request.output, budget)
      // JSON.stringify drops the undefined fields: no systemInstruction inline, no temperature unless set.
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
          generationConfig: generationConfig({
            temperature,
            replyTokens: budget.replyTokens,
            structuredOutput,
            thinking,
          }, request.output),
        }, extraBody),
        signal: request.signal,
        redact,
        errorHints,
      })
      return readReply(reply, { id, model, budget }, redact)
    },
  }
}
