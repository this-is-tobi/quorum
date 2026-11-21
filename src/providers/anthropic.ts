import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from '../core/ports.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import { postJson } from './http.ts'
import { shapeMessages } from './messages.ts'
import { isRecord, mergeBody, prepareHttp, thinkingIssues } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput, Thinking, ThinkingControl } from './options.ts'
import { endedEarly, joinedText, readAnswer, replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget, replyBudgetOf, roomTokens, statedReply, worstCaseTokens } from './size.ts'
import type { ContextBudget } from './size.ts'

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
 * which it sends as `output_config.effort`, else `default`; `off` is refused.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function anthropic(options: AnthropicOptions): Provider {
  const { id, model, auth = 'bearer' as Auth, temperature, maxTokens, contextTokens, systemPrompt = 'native', structuredOutput = 'prompt', thinking, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = options
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, '/v1/messages', thinkingIssues(id, thinking, options.extraBody, THINKING))
  // The version goes last, so no header can replace it.
  const sent = { ...headers, 'anthropic-version': ANTHROPIC_VERSION }
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
      // JSON.stringify drops the undefined fields: no system inline, no temperature unless set, no output_config outside schema mode.
      const reply = await postJson<unknown>({
        providerId: id,
        url,
        headers: sent,
        body: mergeBody({
          model,
          max_tokens: budget.replyTokens,
          system,
          messages,
          temperature: temperature ?? undefined,
          output_config: outputConfig(structuredOutput, thinking, request.output),
        }, extraBody),
        signal: request.signal,
        redact,
      })
      return readReply(reply, { id, model, budget }, redact)
    },
  }
}
