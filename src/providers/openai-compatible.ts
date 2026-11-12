import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import { postJson, snippet } from './http.ts'
import { shapeMessages } from './messages.ts'
import { isRecord, mergeBody, prepareHttp } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput } from './options.ts'
import { endedEarly, joinedText, MAX_MODEL_TEXT, replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget } from './size.ts'

/** The options of an OpenAI-compatible provider. */
export interface OpenAICompatibleOptions extends HttpProviderOptions {
  /** The body field that carries `maxTokens`: `max_tokens`, or `max_completion_tokens`, which OpenAI's reasoning models need. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
}

/**
 * The protocol's rules. The tool fields are the union over the OpenAI-compatible vendors: OpenAI's and
 * the others' function tools and web search, OpenRouter's plugins, server-tool loop, presets and model
 * fallbacks, xAI's live search, Groq's built-in tools, and Azure's `data_sources`, which grounds the reply
 * on an external search index (On Your Data). Not `chat_template_kwargs`, which sets chat-template
 * variables, such as turning thinking off on vLLM or Together, and runs nothing on the server.
 */
const RULES: Omit<AdapterRules, 'auth'> = {
  reservedBodyKeys: ['model', 'messages', 'stream'],
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
const MAX_TOKENS_FIELDS: ReadonlySet<unknown> = new Set(['max_tokens', 'max_completion_tokens'])

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

/**
 * Turn a chat completion reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted, and a malformed shape must fail as a provider error, not as a `TypeError`. A
 * server error comes first, since some servers answer 200 with one beside an empty choice (OpenRouter,
 * for a failure during generation), as `{ error: { message, code } }` or `{ error: "text" }`. A tool the
 * server ran comes next, before a refusal or a finish reason.
 */
function readReply(reply: unknown, { id, model }: Pick<OpenAICompatibleOptions, 'id' | 'model'>, redact: readonly string[]): CompletionResponse {
  const fail = replyFailure(id)

  if (!isRecord(reply)) throw fail('invalid-response', 'reply is not a JSON object')

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
  if (CUT_OFF.has(reason)) throw fail('truncated', 'reply was cut off by the token limit')
  if (ENDED_EARLY.has(reason)) throw fail('invalid-response', endedEarly(reason, redact))

  const text = textOf(message.content)
  if (text === undefined) throw fail('invalid-response', 'reply has no message content')

  return {
    text,
    model: typeof reply.model === 'string' && reply.model !== ''
      ? reply.model
      : model,
    usage: tokenUsage(reply.usage, ['prompt_tokens'], ['completion_tokens']),
  }
}

/**
 * A provider for any OpenAI-compatible `/chat/completions` endpoint. The key, when there is one, travels
 * only in the header `auth` names, `Authorization: Bearer` by default (invariant I1). It refuses, before
 * any request, a request that may not fit `contextTokens`.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function openaiCompatible(options: OpenAICompatibleOptions): Provider {
  const { id, model, auth = 'bearer' as Auth, temperature = 0, maxTokens, contextTokens, maxTokensField = 'max_tokens', systemPrompt = 'native', structuredOutput = 'json' } = options
  const fieldIssues = MAX_TOKENS_FIELDS.has(maxTokensField)
    ? []
    : [
        { path: `${id}.maxTokensField`, message: 'must be max_tokens or max_completion_tokens' },
      ]
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, '/chat/completions', fieldIssues)
  const budget = contextBudget(contextTokens, maxTokens)

  return {
    id,
    model,
    async complete(request) {
      const { system, messages } = shapeMessages(request, systemPrompt)
      checkFits(id, { system, messages }, request.output, budget)
      // JSON.stringify drops the undefined fields: no response_format for `prompt`, no temperature for null, no limit unless set.
      const reply = await postJson<unknown>({
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
