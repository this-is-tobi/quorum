import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from '../core/ports.ts'
import type { CompletionRequest, CompletionResponse, Provider, StreamSignal } from '../core/ports.ts'
import { postStream, snippet } from './http.ts'
import type { PostStreamOptions } from './http.ts'
import { shapeMessages } from './messages.ts'
import { adaptsOf, isRecord, mergeBody, prepareHttp, requestSettings, streamFacts, thinkingIssues } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput, Thinking, ThinkingControl } from './options.ts'
import { endedEarly, joinedText, MAX_MODEL_TEXT, readAnswer, replyFailure, STREAMED_REASONING, tokenUsage } from './reply.ts'
import { checkFits, contextBudget, replyBudgetOf, roomTokens, statedReply, worstCaseTokens } from './size.ts'
import type { ContextBudget } from './size.ts'
import { answerTooLong, listField, malformedStream, MAX_ANSWER_CHARS, objectField, objectValue, streamedTokens, streamEnded, textField } from './stream.ts'
import type { StreamItem } from './stream.ts'

/** The options of an OpenAI-compatible provider. */
export interface OpenAICompatibleOptions extends HttpProviderOptions {
  /** The body field that carries `maxTokens`: `max_tokens`, or `max_completion_tokens`, which OpenAI's reasoning models need. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /**
   * The level an automatic lowering of thinking sends: `low` unless this is `off`. A server whose chat template may not
   * know `low` and falls back to maximum reasoning (vLLM, llama.cpp) lowers to `off`, which it reads as `none`. The
   * builder sets it from the preset, so no configuration sets it.
   */
  lowersThinkingTo?: 'off'
}

/**
 * The protocol's rules. The tool fields are the union over the OpenAI-compatible vendors: OpenAI's and
 * the others' function tools and web search, OpenRouter's plugins, server-tool loop, presets and model
 * fallbacks, xAI's live search, Groq's built-in tools, and Azure's `data_sources`, which grounds the reply
 * on an external search index (On Your Data). Not `chat_template_kwargs`, which sets chat-template
 * variables, such as turning thinking off on vLLM or Together, and runs nothing on the server.
 */
const RULES: Omit<AdapterRules, 'auth'> = {
  reservedBodyKeys: [
    'model',
    'messages',
    'stream',
    'stream_options',
  ],
  toolBodyKeys: [
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'functions',
    'function_call',
    'web_search_options',
    'plugins',
    'deferred_tools',
    'stop_server_tools_when',
    'x_search_filter',
    'preset',
    'models',
    'search_parameters',
    'compound_custom',
    'search_settings',
    'include_domains',
    'exclude_domains',
    'disable_tool_validation',
    'documents',
    'data_sources',
  ],
  replyLimitPaths: [
    ['max_tokens'],
    ['max_completion_tokens'],
  ],
  fixedHeaders: [],
  structuredOutputs: ['prompt', 'json', 'schema'],
}
/** `reasoning_effort`, which `low` sends as it is and `off` as `none`, the value that turns thinking off where a server takes one. */
const THINKING: ThinkingControl = {
  path: ['reasoning_effort'],
}
const MAX_TOKENS_FIELDS: ReadonlySet<unknown> = new Set(['max_tokens', 'max_completion_tokens'])
/** The body field that sets the structured-output mode, which a 400 may name. */
const FORMAT_FIELDS = ['response_format']
/** The streaming fields a 400 may name: the options first, so a body that names them is no refusal of streaming itself. */
const STREAM_OPTIONS_WORD = { word: 'stream_options', refused: 'streamOptions' } as const
const STREAM_WORD = { word: 'stream', refused: 'stream' } as const
/** The data of the last event of a stream. */
const SENTINEL = '[DONE]'
/** The most distinct choices an assembled stream keeps: a request asks for one, and the reader reads choice index 0, the one kept first or not at all. */
const MAX_CHOICES = 8

function responseFormat(mode: StructuredOutput, output: CompletionRequest['output']): unknown {
  if (mode === 'json') return { type: 'json_object' }
  if (mode === 'schema') {
    return {
      type: 'json_schema',
      json_schema: { name: output.name, schema: output.schema, strict: true },
    }
  }
  return undefined
}

function reasoningEffort(thinking: Thinking | undefined): string | undefined {
  return thinking === 'off'
    ? 'none'
    : thinking
}

/** Finish reasons that end a reply before the model is done, besides the token limit and the content filter. */
const ENDED_EARLY: ReadonlySet<unknown> = new Set(['error', 'insufficient_system_resource', 'aborted'])
/** Finish reasons of a reply cut off by a limit: the token limit, or the model's context (Mistral's `model_length`). */
const CUT_OFF: ReadonlySet<unknown> = new Set(['length', 'model_length'])

/** The status a server error carries in its `code`, when that is an HTTP error status. */
function statusOf(code: unknown): number | undefined {
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599
    ? code
    : undefined
}

/**
 * Whether a message shows a tool the server ran: a non-empty `executed_tools` (Groq's built-in tools), or
 * a `url_citation` annotation (OpenAI's search models, OpenRouter's web plugin). A model or a gateway that
 * runs a tool by itself leaves a review that cannot be trusted, whatever the request offered.
 */
function ranTool(message: Record<string, unknown>): boolean {
  const { executed_tools: executed, annotations } = message
  if (Array.isArray(executed) && executed.length > 0) return true
  return Array.isArray(annotations) && annotations.some(entry => isRecord(entry) && entry.type === 'url_citation')
}

/** The text of a message's content: a string, or the `text` parts of an array of parts (Mistral), joined; thinking parts are skipped. */
function textOf(content: unknown): string | undefined {
  return typeof content === 'string'
    ? content
    : joinedText(content, part => part.type === 'text')
}

/** Whether `value` is a string with something in it besides white space. */
function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Whether the reply showed reasoning: a `reasoning` (vLLM) or `reasoning_content` (llama.cpp, DeepSeek) field
 * with text, a `thinking` part of the content (Mistral), or a reasoning token count above 0. Only the fact
 * is read: the reasoning's text is never the answer and never quoted.
 */
function showedReasoning(message: Record<string, unknown>, usage: unknown): boolean {
  if (hasText(message.reasoning) || hasText(message.reasoning_content)) return true
  if (Array.isArray(message.content) && message.content.some(part => isRecord(part) && part.type === 'thinking')) return true
  const details = isRecord(usage)
    ? usage.completion_tokens_details
    : undefined
  const tokens = isRecord(details)
    ? details.reasoning_tokens
    : undefined
  return typeof tokens === 'number' && tokens > 0
}

/**
 * Turn a chat completion reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted, and a malformed shape must fail as a provider error, not as a `TypeError`. A
 * server error comes first, since some servers answer 200 with one beside an empty choice (OpenRouter,
 * for a failure during generation), as `{ error: { message, code } }` or `{ error: "text" }`. A tool the
 * server ran comes next, before a refusal or a finish reason. The counts are read once, after the body
 * check, and every failure from then on carries them, since the server generated those tokens. What the reply
 * lacked, once these checks pass, is `readAnswer`'s: a cut-off by the finish reason or by output tokens that reach
 * the limit sent, a window the server ended, only reasoning, or nothing.
 */
function readReply(reply: unknown, { id, model, budget }: Pick<OpenAICompatibleOptions, 'id' | 'model'> & { readonly budget: ContextBudget }, redact: readonly string[]): CompletionResponse {
  if (!isRecord(reply)) throw replyFailure(id)('invalid-response', 'reply is not a JSON object')

  const usage = tokenUsage(reply.usage, ['prompt_tokens'], ['completion_tokens'])
  const fail = replyFailure(id, usage)
  const { error } = reply
  if (typeof error === 'string' || isRecord(error)) {
    const text = typeof error === 'string'
      ? error
      : error.message
    const quoted = typeof text === 'string'
      ? `: ${snippet(text, MAX_MODEL_TEXT, redact)}`
      : ''
    const status = isRecord(error)
      ? statusOf(error.code)
      : undefined
    throw status === undefined
      ? fail('invalid-response', `server error${quoted}`)
      : fail('http', `server error ${status}${quoted}`, status)
  }

  const choice: unknown = Array.isArray(reply.choices)
    ? reply.choices[0]
    : undefined
  if (!isRecord(choice)) throw fail('invalid-response', 'reply has no choices')

  const message = isRecord(choice.message)
    ? choice.message
    : {}
  if (ranTool(message)) throw fail('invalid-response', 'the server ran a tool for this reply, which quorum never allows')
  if (message.refusal) {
    const refusal = message.refusal
    throw fail('refusal', typeof refusal === 'string'
      ? `model refused: ${snippet(refusal, MAX_MODEL_TEXT, redact)}`
      : 'model refused')
  }
  const reason = choice.finish_reason
  if (reason === 'content_filter') throw fail('refusal', 'reply was stopped by the content filter')
  if (ENDED_EARLY.has(reason)) throw fail('invalid-response', endedEarly(reason, redact))

  const { text, reasoning } = readAnswer(id, {
    text: textOf(message.content),
    flaggedCutOff: CUT_OFF.has(reason),
    windowEnded: false,
    reasoned: showedReasoning(message, reply.usage),
    limit: budget.replyTokens,
    window: budget.contextTokens,
    windowByCount: true,
    usage,
  })

  return {
    text,
    reasoning,
    model: typeof reply.model === 'string' && reply.model !== ''
      ? reply.model
      : model,
    usage,
  }
}

/** One choice of a stream as it is built: its text joined, its reasoning only known to have shown, never kept. */
interface Streamed {
  content: string
  refusal: string
  reasoned: boolean
  annotations: Set<string>
  ranTool: boolean
  finish: unknown
}

/** The characters of the text a part of a thinking content holds, nested as Mistral writes it, or a plain string. */
function thinkingChars(thinking: unknown): number {
  if (typeof thinking === 'string') return thinking.length
  return Array.isArray(thinking)
    ? thinking.reduce<number>((sum, part) => sum + (isRecord(part) && typeof part.text === 'string'
        ? part.text.length
        : 0), 0)
    : 0
}

/**
 * The whole reply a stream of chat completion chunks amounts to, in the shape `readReply` reads, so every check of a
 * whole reply runs on it unchanged: the model of the first chunk that names one; per choice, `content` joined from
 * string deltas and text parts, `refusal` joined, the annotation types and a non-empty `executed_tools` kept as markers
 * (`ranTool` reads them), the reasoning as the one word `STREAMED_REASONING` when any showed, its text never kept, and
 * the last `finish_reason` that is not null; the usage of the last chunk that holds one; and a chunk's `error`, which
 * ends the read as the reply's own `error`, read as a whole reply's is.
 *
 * The stream is complete at the `finish_reason` of choice index 0, the one `readReply` reads, and is read on to `[DONE]` or
 * the body's end, since a server sends its usage after it; another choice's finish completes nothing. A `[DONE]` or an end
 * where choice 0 never showed or never finished, with no error, is a broken stream: the failure `streamEnded` names, a
 * `network` one, retried as a dropped connection is, never an answer. The reply holds that choice alone. One rule holds
 * for every field: an unknown content part type, and an absent field, are tolerated, and a chunk, choice, delta or part that is no object, a `choices`,
 * `annotations` or `executed_tools` that is no list, or a text field that is no text, ends the read as an `invalid-response`
 * that is never retried, with the body cancelled, so a dropped field never lets a partial answer be read as a whole one.
 * A text that passes 1 000 000 characters ends it the same way. Each data event reports a `data` signal: the larger of the server's own output count and a
 * quarter of the characters streamed so far, and whether an answer or reasoning has shown text.
 */
export async function assembleOpenAi(items: AsyncIterable<StreamItem>, providerId: string, onProgress?: (signal: StreamSignal) => void): Promise<Record<string, unknown>> {
  const choices = new Map<number, Streamed>()
  let model: string | undefined
  let usage: Record<string, unknown> | undefined
  let error: unknown
  let answerChars = 0
  let reasoningChars = 0
  let counted = 0

  const choiceOf = (index: number): Streamed | undefined => {
    const known = choices.get(index)
    if (known !== undefined) return known
    if (choices.size >= MAX_CHOICES) return undefined
    const fresh: Streamed = {
      content: '',
      refusal: '',
      reasoned: false,
      annotations: new Set(),
      ranTool: false,
      finish: undefined,
    }
    choices.set(index, fresh)
    return fresh
  }
  const answer = (choice: Streamed, field: 'content' | 'refusal', text: string): void => {
    choice[field] += text
    answerChars += text.length
    if (answerChars > MAX_ANSWER_CHARS) throw answerTooLong(providerId)
  }
  const reasoning = (choice: Streamed, chars: number, shown: boolean): void => {
    reasoningChars += chars
    if (shown) choice.reasoned = true
  }
  const readDelta = (choice: Streamed, delta: Record<string, unknown>): void => {
    const { content } = delta
    if (typeof content === 'string') {
      answer(choice, 'content', content)
    } else if (Array.isArray(content)) {
      for (const entry of content) {
        const part = objectValue(providerId, entry, 'content part')
        const type = textField(providerId, part.type, 'content part type')
        if (type === 'text') {
          const text = textField(providerId, part.text, 'text')
          if (text !== undefined) answer(choice, 'content', text)
        } else if (type === 'thinking') {
          reasoning(choice, thinkingChars(part.thinking), true)
        }
      }
    } else if (content !== undefined && content !== null) {
      throw malformedStream(providerId, 'content', 'text')
    }
    const refusal = textField(providerId, delta.refusal, 'refusal')
    if (refusal !== undefined) answer(choice, 'refusal', refusal)
    for (const field of ['reasoning', 'reasoning_content'] as const) {
      const text = textField(providerId, delta[field], field)
      if (text !== undefined) reasoning(choice, text.length, text.trim() !== '')
    }
    for (const entry of listField(providerId, delta.annotations, 'annotations') ?? []) {
      const annotation = objectValue(providerId, entry, 'annotation')
      const type = textField(providerId, annotation.type, 'annotation type')
      if (type !== undefined) choice.annotations.add(type)
    }
    if ((listField(providerId, delta.executed_tools, 'executed_tools') ?? []).length > 0) choice.ranTool = true
  }
  const readChunk = (chunk: Record<string, unknown>): void => {
    const named = textField(providerId, chunk.model, 'model')
    if (model === undefined && named !== undefined && named !== '') model = named
    const reported = objectField(providerId, chunk.usage, 'usage')
    if (reported !== undefined) {
      usage = reported
      const tokens = reported.completion_tokens
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) counted = tokens
    }
    if (chunk.error !== undefined && chunk.error !== null) {
      if (typeof chunk.error !== 'string' && !isRecord(chunk.error)) throw malformedStream(providerId, 'error', 'object')
      error = chunk.error
    }
    const entries = listField(providerId, chunk.choices, 'choices')
    entries?.forEach((entry: unknown, position) => {
      const item = objectValue(providerId, entry, 'choice')
      const index = typeof item.index === 'number' && Number.isSafeInteger(item.index) && item.index >= 0
        ? item.index
        : position
      const choice = choiceOf(index)
      if (choice === undefined) return
      const delta = objectField(providerId, item.delta, 'delta')
      if (delta !== undefined) readDelta(choice, delta)
      if (item.finish_reason !== undefined && item.finish_reason !== null) choice.finish = item.finish_reason
    })
  }
  const finished = (): boolean => choices.get(0)?.finish !== undefined
  const assembled = (): Record<string, unknown> => ({
    ...model === undefined
      ? {}
      : { model },
    ...error === undefined
      ? {}
      : { error },
    choices: [
      ...choices.entries(),
    ].filter(([index]) => index === 0).map(([index, choice]) => ({
      index,
      message: {
        role: 'assistant',
        ...choice.content === ''
          ? {}
          : { content: choice.content },
        ...choice.refusal === ''
          ? {}
          : { refusal: choice.refusal },
        ...choice.reasoned
          ? { reasoning: STREAMED_REASONING }
          : {},
        ...choice.annotations.size === 0
          ? {}
          : {
              annotations: [...choice.annotations].map(type => ({ type })),
            },
        ...choice.ranTool
          ? {
              executed_tools: [{}],
            }
          : {},
      },
      finish_reason: choice.finish,
    })),
    ...usage === undefined
      ? {}
      : { usage },
  })

  for await (const item of items) {
    if (item.kind === 'keep-alive') continue
    if (item.kind === 'done') {
      if (!finished()) throw streamEnded(providerId)
      return assembled()
    }
    readChunk(objectValue(providerId, item.value, 'chunk'))
    onProgress?.({
      kind: 'data',
      outputTokens: streamedTokens(counted, answerChars + reasoningChars),
      answer: answerChars > 0,
      reasoning: reasoningChars > 0,
    })
    // An error ends the read at once: it is the reply, and nothing after it changes it.
    if (error !== undefined) return assembled()
  }
  if (!finished()) throw streamEnded(providerId)
  return assembled()
}

/**
 * A provider for any OpenAI-compatible `/chat/completions` endpoint. The key, when there is one, travels
 * only in the header `auth` names, `Authorization: Bearer` by default (invariant I1). It refuses, before
 * any request, a request that may not fit `contextTokens`. It sends the reply's limit, the request's reply
 * budget at most `maxTokens`, else `maxTokens`, else 16000 (`replyBudgetOf`), under `maxTokensField`, so the
 * server bounds a reply's length. It states its worst case from the count its size guard keeps: the text it
 * sends, the template reserve and that budget, and the room its guard leaves from the same count:
 * `contextTokens` less those three. It also states its window, its `maxTokens` when set, and its thinking: the
 * option's level, else `default`. A set `thinking` is sent as `reasoning_effort`, `low` or `none`. Unless the
 * options set `thinking`, or `extraBody` sets `reasoning_effort`, it states that the core may lower thinking, to
 * `low`, or to `off` under `lowersThinkingTo`, and honours the request's `thinking`; unless the options set
 * `structuredOutput`, or `extraBody` sets `response_format`, it states that the core may move it from `json` to
 * `prompt`, and honours the request's `structuredOutput`. A 400 or 422 that names `response_format`, sent in
 * `json` or `schema` mode, is marked `refused` for the structured output.
 *
 * It streams every reply, a whole request's too, through `postStream`: `stream: true` with `stream_options:
 * { include_usage: true }`, which `assembleOpenAi` reads into the whole reply `readReply` checks. It states `streams`
 * unless the option `stream` is `false`, and that it may step down, `adapts.stream`, when the option is unset: the
 * request's `stream` `'bare'` leaves the options out, and `false` asks a whole reply, neither field sent. A 400 or 422
 * that names `stream_options` is marked `refused` as `streamOptions`, and one that names `stream`, as `stream`. A server
 * that answers a streamed request whole gives a reply marked `whole`.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function openaiCompatible(options: OpenAICompatibleOptions): Provider {
  const { id, model, auth = 'bearer' as Auth, temperature = 0, maxTokens, contextTokens, maxTokensField = 'max_tokens', thinking, systemPrompt = 'native', structuredOutput = 'json', timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, lowersThinkingTo, stream: streamOption } = options
  const fieldIssues = [
    ...MAX_TOKENS_FIELDS.has(maxTokensField)
      ? []
      : [
          { path: `${id}.maxTokensField`, message: 'must be max_tokens or max_completion_tokens' },
        ],
    ...lowersThinkingTo === undefined || lowersThinkingTo === 'off'
      ? []
      : [
          { path: `${id}.lowersThinkingTo`, message: 'must be off' },
        ],
  ]
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, '/chat/completions', [
    ...fieldIssues,
    ...thinkingIssues(id, thinking, options.extraBody, THINKING),
  ])
  const budgetOf = (request: CompletionRequest): ContextBudget => contextBudget(contextTokens, replyBudgetOf(request, maxTokens))
  const adapting = adaptsOf(options, {
    level: lowersThinkingTo ?? 'low',
    control: THINKING,
    format: [FORMAT_FIELDS],
    streams: true,
  })

  return {
    id,
    model,
    timeoutMs,
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
      const streamWords: PostStreamOptions['streamWords'] = !streams
        ? undefined
        : settings.stream === 'bare'
          ? [STREAM_WORD]
          : [STREAM_OPTIONS_WORD, STREAM_WORD]
      // JSON.stringify drops the undefined fields: no response_format for `prompt`, no temperature for null, no stream for whole replies.
      const sentReply = await postStream({
        providerId: id,
        url,
        headers,
        body: mergeBody({
          model,
          messages: system === undefined
            ? messages
            : [
                { role: 'system', content: system },
                ...messages,
              ],
          response_format: responseFormat(settings.structuredOutput, request.output),
          temperature: temperature ?? undefined,
          reasoning_effort: reasoningEffort(settings.thinking),
          [maxTokensField]: budget.replyTokens,
          stream: streams
            ? true
            : undefined,
          stream_options: streams && settings.stream !== 'bare'
            ? { include_usage: true }
            : undefined,
        }, extraBody),
        signal: request.signal,
        redact,
        format: 'sse',
        sentinel: SENTINEL,
        onProgress: request.onProgress,
        ...streamWords === undefined
          ? {}
          : { streamWords },
        ...settings.structuredOutput === 'prompt'
          ? {}
          : { formatFields: FORMAT_FIELDS },
      })
      const answered = 'whole' in sentReply
      const reply = answered
        ? sentReply.whole
        : await assembleOpenAi(sentReply.items, id, request.onProgress)
      const read = readReply(reply, { id, model, budget }, redact)
      return streams && answered
        ? { ...read, whole: true }
        : read
    },
  }
}
