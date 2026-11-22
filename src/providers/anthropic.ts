import { ProviderError } from '../core/errors.ts'
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from '../core/ports.ts'
import type { CompletionRequest, CompletionResponse, Provider, StreamSignal } from '../core/ports.ts'
import { postStream, snippet, vendorExhausted } from './http.ts'
import type { PostStreamOptions } from './http.ts'
import { shapeMessages } from './messages.ts'
import { adaptsOf, isRecord, mergeBody, prepareHttp, requestSettings, streamFacts, thinkingIssues } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput, Thinking, ThinkingControl } from './options.ts'
import { endedEarly, joinedText, MAX_MODEL_TEXT, readAnswer, replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget, replyBudgetOf, roomTokens, statedReply, worstCaseTokens } from './size.ts'
import type { ContextBudget } from './size.ts'
import { answerTooLong, MAX_ANSWER_CHARS, objectField, objectValue, streamedTokens, streamEnded, textField } from './stream.ts'
import type { StreamItem } from './stream.ts'

/** The options of an Anthropic Messages provider: the ones every HTTP adapter takes, and no other. */
export type AnthropicOptions = HttpProviderOptions

/**
 * The API version every request names. For this call it differs from `2023-06-01` only in refusing any
 * `temperature`, `top_p` or `top_k`, so no temperature is sent unless one is set.
 */
const ANTHROPIC_VERSION = '2026-10-21'
/**
 * The protocol's rules. The tool fields: `tools` and `tool_choice`; `mcp_servers`, which offers an MCP
 * server's tools with no `tools` entry under the deprecated `mcp-client-2025-04-04` beta; `container`,
 * which loads skills; and the beta's server-side fields. `anthropic-beta` stays open, since no beta
 * header offers a tool by itself.
 */
const RULES: Omit<AdapterRules, 'auth'> = {
  reservedBodyKeys: [
    'model',
    'messages',
    'system',
    'stream',
  ],
  toolBodyKeys: [
    'tools',
    'tool_choice',
    'mcp_servers',
    'container',
    'thread',
    'fallbacks',
    'fallback_credit_token',
    'context_management',
    'compaction',
  ],
  replyLimitPaths: [
    ['max_tokens'],
  ],
  fixedHeaders: ['anthropic-version'],
  structuredOutputs: ['prompt', 'schema'],
}
/** `output_config.effort`, which turns thinking down to `low`. No one setting turns it off on every model: Opus 5.5 answers a 400 to `disabled` and Sonnet 5.5 takes `between_tools`. */
const THINKING: ThinkingControl = {
  path: ['output_config', 'effort'],
  offRefusal: 'the anthropic protocol has no one setting that turns thinking off on every model: set thinking: low, or set thinking in extraBody for your model',
}
/** The words a 400 may name when the server refuses streaming: the one body field this adapter sends for it. */
const STREAM_WORDS: NonNullable<PostStreamOptions['streamWords']> = [
  { word: 'stream', refused: 'stream' },
]
/** The most content blocks an assembled stream keeps: a reply holds a few, and the reader reads the text and the thinking. */
const MAX_BLOCKS = 64
/**
 * The status each error type of an `event: error` stands for, copied from the errors page of the Claude API reference
 * (https://platform.claude.com/docs/en/api/errors). A type this table does not hold has no status.
 */
export const ANTHROPIC_ERROR_STATUSES: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
}
/** The stop reasons of a finished reply. */
const FINISHED: ReadonlySet<unknown> = new Set(['end_turn', 'stop_sequence'])

/** Whether the reply showed thinking: a `thinking` or `redacted_thinking` block, or a thinking token count above 0. Only the fact is read, never the thinking's text. */
function showedThinking(reply: Record<string, unknown>): boolean {
  if (Array.isArray(reply.content) && reply.content.some(block => isRecord(block) && (block.type === 'thinking' || block.type === 'redacted_thinking'))) return true
  const details = isRecord(reply.usage)
    ? reply.usage.output_tokens_details
    : undefined
  const tokens = isRecord(details)
    ? details.thinking_tokens
    : undefined
  return typeof tokens === 'number' && tokens > 0
}

/**
 * Turn a Messages reply into text, or a `ProviderError`. Every property is read defensively: the reply
 * is untrusted. The stop reason comes first, since a refused or cut-off reply can still hold some text.
 * The counts are read once, after the body check, and every failure from then on carries them, since the
 * server generated those tokens. What the reply lacked, once the stop reason is one of a finished, a cut-off or a
 * window-ended reply, is `readAnswer`'s: `max_tokens` or output tokens that reach the limit sent, the window
 * (`model_context_window_exceeded`), only thinking, or nothing.
 */
function readReply(reply: unknown, { id, model, budget }: Pick<AnthropicOptions, 'id' | 'model'> & { readonly budget: ContextBudget }, redact: readonly string[]): CompletionResponse {
  if (!isRecord(reply)) throw replyFailure(id)('invalid-response', 'reply is not a JSON object')

  const usage = tokenUsage(reply.usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'], ['output_tokens'])
  const fail = replyFailure(id, usage)
  const reason = reply.stop_reason
  if (reason === 'refusal') throw fail('refusal', 'model refused')
  const cutOff = reason === 'max_tokens'
  const windowEnded = reason === 'model_context_window_exceeded'
  if (!cutOff && !windowEnded && !FINISHED.has(reason)) throw fail('invalid-response', endedEarly(reason, redact))

  const { text, reasoning } = readAnswer(id, {
    text: joinedText(reply.content, block => block.type === 'text'),
    flaggedCutOff: cutOff,
    windowEnded,
    reasoned: showedThinking(reply),
    limit: budget.replyTokens,
    window: budget.contextTokens,
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

/** One content block of a stream as it is built: a text joined, any other block known by its type alone. */
interface Block {
  readonly type: string
  text: string
}

/**
 * The failure of an `event: error`: an `http` failure of the status its error type has in `ANTHROPIC_ERROR_STATUSES`,
 * retried as the status is, else an `invalid-response` that is never retried, as an OpenAI error with no status is. The
 * message is quoted as a server error's is, redacted, and a spend limit the vendor's own code names is `exhausted`.
 */
function streamError(event: Record<string, unknown>, providerId: string, redact: readonly string[]): ProviderError {
  const error = isRecord(event.error)
    ? event.error
    : {}
  const status = typeof error.type === 'string' && Object.hasOwn(ANTHROPIC_ERROR_STATUSES, error.type)
    ? ANTHROPIC_ERROR_STATUSES[error.type]
    : undefined
  const quoted = typeof error.message === 'string'
    ? `: ${snippet(error.message, MAX_MODEL_TEXT, redact)}`
    : ''
  return status === undefined
    ? new ProviderError({ providerId, kind: 'invalid-response', message: `server error${quoted}` })
    : new ProviderError({
        providerId,
        kind: 'http',
        message: `server error ${status}${quoted}`,
        status,
        ...vendorExhausted(event, status)
          ? { exhausted: true as const }
          : {},
      })
}

/** The entries of `source` that hold a value, laid over `base`: a count the server leaves null never undoes one it gave. */
function overlaid(base: Record<string, unknown>, source: unknown): Record<string, unknown> {
  if (!isRecord(source)) return base
  return {
    ...base,
    ...Object.fromEntries(Object.entries(source).filter(([, value]) => value !== null && value !== undefined)),
  }
}

/**
 * The whole reply a Messages stream amounts to, in the shape `readReply` reads, so every check of a whole reply runs on
 * it unchanged: the `model` of `message_start`; `content` as the blocks by index, a text joined from its deltas, a
 * `thinking` or `redacted_thinking` block kept with no text, since only the fact that it showed is read, and any other
 * block kept by its type; the `stop_reason` of the last `message_delta` that holds one; and the usage `message_start` gave,
 * laid over by the last `message_delta`'s, whose counts are cumulative. Reasoning is counted and never kept.
 *
 * The stream is complete at `message_stop`, after a `message_delta` that holds a stop reason: the read ends there, with the
 * body cancelled. A body that ends without it is a broken stream, the `network` failure `streamEnded` names, never an
 * answer, and so is a `message_stop` with no stop reason. An `event: error` ends the read at once, as the failure
 * `streamError` names. One rule holds for every field: an unknown event, block or delta type, and an absent field, are
 * tolerated, and a known event whose field is present with the wrong type ends the read as an `invalid-response` that is
 * never retried, with the body cancelled, so a dropped field never lets a partial answer be read as a whole one. The same
 * failure ends a stream of more than 64 content blocks, a block opened twice, an index that is none, a delta aimed at a
 * block of another type, and a text that passes 1 000 000 characters. Each event but a `ping` reports a
 * `data` signal: the larger of the server's own output count and a quarter of the characters streamed so far, and whether
 * an answer or reasoning has shown text. A `ping` is a keep-alive, which is no progress.
 */
export async function assembleAnthropic(items: AsyncIterable<StreamItem>, providerId: string, onProgress?: (signal: StreamSignal) => void, redact: readonly string[] = []): Promise<Record<string, unknown>> {
  const blocks = new Map<number, Block>()
  let model: string | undefined
  let usage: Record<string, unknown> = {}
  let stopReason: unknown
  let answerChars = 0
  let reasoningChars = 0
  let counted = 0

  const broken = (message: string): ProviderError => new ProviderError({
    providerId,
    kind: 'invalid-response',
    message,
    retryable: false,
  })
  /** The block at `index`, opened as `type` when it is none yet. A stream that passes the cap, names no valid index or aims at a block of another type is refused, never read on with text dropped. */
  const blockOf = (index: unknown, type: string): Block => {
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw broken('the reply stream holds a content block with no valid index')
    const known = blocks.get(index)
    if (known !== undefined) {
      if (known.type !== type) throw broken('the reply stream holds a delta for a content block of another type')
      return known
    }
    if (blocks.size >= MAX_BLOCKS) throw broken(`the reply stream holds more than ${MAX_BLOCKS} content blocks`)
    const fresh: Block = { type, text: '' }
    blocks.set(index, fresh)
    return fresh
  }
  const answer = (block: Block, text: string): void => {
    block.text += text
    answerChars += text.length
    if (answerChars > MAX_ANSWER_CHARS) throw answerTooLong(providerId)
  }
  const setUsage = (source: unknown): void => {
    usage = overlaid(usage, objectField(providerId, source, 'usage'))
    const tokens = usage.output_tokens
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) counted = tokens
  }
  const readEvent = (type: string, event: Record<string, unknown>): void => {
    if (type === 'message_start') {
      const message = objectField(providerId, event.message, 'message')
      if (message === undefined) return
      const name = textField(providerId, message.model, 'model')
      if (name !== undefined && name !== '') model = name
      setUsage(message.usage)
    } else if (type === 'content_block_start') {
      const opened = objectField(providerId, event.content_block, 'content block')
      const blockType = textField(providerId, opened?.type, 'content block type')
      if (opened === undefined || blockType === undefined) return
      if (typeof event.index === 'number' && blocks.has(event.index)) throw broken('the reply stream opens a content block twice')
      const block = blockOf(event.index, blockType)
      const first = textField(providerId, opened.text, 'text')
      if (block.type === 'text' && first !== undefined) answer(block, first)
    } else if (type === 'content_block_delta') {
      const delta = objectField(providerId, event.delta, 'delta')
      if (delta === undefined) return
      const deltaType = textField(providerId, delta.type, 'delta type')
      if (deltaType === 'text_delta') {
        const block = blockOf(event.index, 'text')
        const piece = textField(providerId, delta.text, 'text')
        if (piece !== undefined) answer(block, piece)
      } else if (deltaType === 'thinking_delta') {
        const block = blockOf(event.index, 'thinking')
        const piece = textField(providerId, delta.thinking, 'thinking')
        if (piece !== undefined && block.type === 'thinking') reasoningChars += piece.length
      }
    } else if (type === 'message_delta') {
      const delta = objectField(providerId, event.delta, 'delta')
      if (delta !== undefined && delta.stop_reason !== undefined && delta.stop_reason !== null) stopReason = delta.stop_reason
      setUsage(event.usage)
    }
  }
  const assembled = (): Record<string, unknown> => ({
    ...model === undefined
      ? {}
      : { model },
    content: [
      ...blocks.entries(),
    ].sort(([a], [b]) => a - b).map(([, block]) => block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: block.type }),
    stop_reason: stopReason,
    usage,
  })

  for await (const item of items) {
    if (item.kind !== 'event') continue
    const event = objectValue(providerId, item.value, 'event')
    const type = item.event !== 'message'
      ? item.event
      : textField(providerId, event.type, 'event type')
    if (type === 'ping') {
      onProgress?.({ kind: 'keep-alive' })
      continue
    }
    if (type === 'error') throw streamError(event, providerId, redact)
    if (type !== undefined) readEvent(type, event)
    onProgress?.({
      kind: 'data',
      outputTokens: streamedTokens(counted, answerChars + reasoningChars),
      answer: answerChars > 0,
      reasoning: reasoningChars > 0,
    })
    if (type === 'message_stop') {
      if (stopReason === undefined) break
      return assembled()
    }
  }
  throw streamEnded(providerId)
}

/** The request's `output_config`: the reply schema in `schema` mode and the effort `low` when thinking is set, merged in one object, or none. */
function outputConfig(structuredOutput: StructuredOutput, thinking: Thinking | undefined, output: CompletionRequest['output']): Record<string, unknown> | undefined {
  const config = {
    ...structuredOutput === 'schema'
      ? {
          format: { type: 'json_schema', schema: output.schema },
        }
      : {},
    ...thinking === undefined
      ? {}
      : { effort: 'low' },
  }
  return Object.keys(config).length === 0
    ? undefined
    : config
}

/**
 * A provider for the Anthropic Messages API, `/v1/messages`, or a gateway that speaks it. The key, when
 * there is one, travels only in the header `auth` names, `Authorization: Bearer` by default (invariant
 * I1). It never sends an assistant prefill, which current models reject. It refuses, before any request,
 * a request that may not fit `contextTokens`. It always sends a token limit, since the Messages API
 * requires one: the request's reply budget at most `maxTokens`, else `maxTokens`, else 16000
 * (`replyBudgetOf`). It states its worst case from the count its size guard keeps: the text it sends, the
 * template reserve and that budget, and the room its guard leaves from the same count: `contextTokens` less
 * those three. It also states its window, its `maxTokens` when set, and its thinking: `low` when the option sets it,
 * which it sends as `output_config.effort`, else `default`; `off` is refused. Unless the options set `thinking`, or
 * `extraBody` sets `output_config.effort`, it states that the core may lower thinking to `low`, and honours the
 * request's `thinking`. Its structured output is `prompt` by default, which never moves, so it states no `prompt`.
 *
 * It streams every reply, a whole request's too, through `postStream`: `stream: true`, which `assembleAnthropic` reads into
 * the whole reply `readReply` checks, complete at `message_stop`. It states `streams` unless the option `stream` is `false`,
 * and that it may step down, `adapts.stream`, when the option is unset: the request's `stream` `false` asks a whole reply, and
 * sends no `stream`. A 400 or 422 that names `stream` is marked `refused` as `stream`. A server that answers a streamed
 * request whole gives a reply marked `whole`.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function anthropic(options: AnthropicOptions): Provider {
  const { id, model, auth = 'bearer' as Auth, temperature, maxTokens, contextTokens, systemPrompt = 'native', structuredOutput = 'prompt', thinking, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, stream: streamOption } = options
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, '/v1/messages', thinkingIssues(id, thinking, options.extraBody, THINKING))
  // The version goes last, so no header can replace it.
  const sent = { ...headers, 'anthropic-version': ANTHROPIC_VERSION }
  const budgetOf = (request: CompletionRequest): ContextBudget => contextBudget(contextTokens, replyBudgetOf(request, maxTokens))
  const adapting = adaptsOf(options, { level: 'low', control: THINKING, streams: true })

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
      // JSON.stringify drops the undefined fields: no system inline, no temperature unless set, no output_config outside schema mode, no stream for whole replies.
      const sentReply = await postStream({
        providerId: id,
        url,
        headers: sent,
        body: mergeBody({
          model,
          max_tokens: budget.replyTokens,
          system,
          messages,
          temperature: temperature ?? undefined,
          output_config: outputConfig(settings.structuredOutput, settings.thinking, request.output),
          stream: streams
            ? true
            : undefined,
        }, extraBody),
        signal: request.signal,
        redact,
        format: 'sse',
        onProgress: request.onProgress,
        ...streams
          ? { streamWords: STREAM_WORDS }
          : {},
      })
      const answered = 'whole' in sentReply
      const reply = answered
        ? sentReply.whole
        : await assembleAnthropic(sentReply.items, id, request.onProgress, redact)
      const read = readReply(reply, { id, model, budget }, redact)
      return streams && answered
        ? { ...read, whole: true }
        : read
    },
  }
}
