import { issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from '../core/ports.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import { postJson, snippet } from './http.ts'
import { shapeMessages } from './messages.ts'
import { bodyKeyForm, isRecord, mergeBody, prepareHttp, spellingIssues, thinkingIssues } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput, Thinking, ThinkingControl } from './options.ts'
import { MAX_MODEL_TEXT, readAnswer, replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget, replyBudgetOf, roomTokens, statedReply, worstCaseTokens } from './size.ts'
import type { ContextBudget } from './size.ts'

/** The options of an Ollama provider: the ones every HTTP adapter takes, and no other. */
export type OllamaOptions = HttpProviderOptions

/**
 * The protocol's rules. The tool fields: `tools`, its only one, and `_debug_render_only`, which answers
 * 200 with the rendered template instead of a reply.
 */
const RULES: Omit<AdapterRules, 'auth'> = {
  reservedBodyKeys: [
    'model',
    'messages',
    'stream',
    'truncate',
    'shift',
  ],
  toolBodyKeys: ['tools', '_debug_render_only'],
  replyLimitPaths: [
    ['options', 'num_predict'],
  ],
  fixedHeaders: [],
  structuredOutputs: ['prompt', 'json', 'schema'],
}
/** `think`, which `low` sends as the level `"low"`, a model without named levels reading it as its default, and `off` as `false`, the lowest level of a model that cannot turn thinking off. */
const THINKING: ThinkingControl = {
  path: ['think'],
}
/** The one spelling of the options key that the adapter merges its own into. */
const OPTIONS = 'options'
/** The done reasons of a finished reply: `length` is one cut off by the token limit, or by a context that filled. */
const DONE: ReadonlySet<unknown> = new Set(['stop', 'length'])

/**
 * The problems of an `extraBody` options that would undo `contextTokens`: a `num_ctx` key, which it sets, a
 * value that is no object, which would replace the options the adapter sends and drop `num_ctx` with them,
 * and a spelling of `options` other than the one the adapter merges, which would send a second key. The server
 * reads a key in any letter case, so the options object and `num_ctx` are matched as it reads them.
 */
function numCtxIssues(id: string, extraBody: unknown): ConfigIssue[] {
  if (!isRecord(extraBody)) return []
  return Object.entries(extraBody).flatMap(([key, value]): ConfigIssue[] => {
    if (bodyKeyForm(key) !== OPTIONS) return []
    if (!isRecord(value)) {
      return [
        { path: `${id}.${issuePath(['extraBody', key])}`, message: 'must be an object' },
      ]
    }
    const numCtx = Object.keys(value)
      .filter(name => bodyKeyForm(name) === 'numctx')
      .map(name => ({ path: `${id}.${issuePath(['extraBody', key, name])}`, message: 'is set from contextTokens: set contextTokens instead' }))
    return [
      ...spellingIssues(id, key, OPTIONS),
      ...numCtx,
    ]
  })
}

function think(thinking: Thinking | undefined): string | false | undefined {
  return thinking === 'off'
    ? false
    : thinking
}

function format(mode: StructuredOutput, output: CompletionRequest['output']): unknown {
  if (mode === 'json') return 'json'
  if (mode === 'schema') return output.schema
  return undefined
}

/**
 * Turn an `/api/chat` reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted. A server error comes first: a local server answers one with an error status, but
 * the reply of a remote model could carry one in a 200. The counts are read once, after the body check,
 * and every failure from then on carries them, since the server generated those tokens. What the reply lacked,
 * once it is done, is `readAnswer`'s: `length` or `eval_count` at `num_predict`, a window the server ended
 * (`length` with the input and output at `num_ctx`), only `message.thinking`, or nothing.
 */
function readReply(reply: unknown, { id, model, budget }: Pick<OllamaOptions, 'id' | 'model'> & { readonly budget: ContextBudget }, redact: readonly string[]): CompletionResponse {
  if (!isRecord(reply)) throw replyFailure(id)('invalid-response', 'reply is not a JSON object')

  const usage = tokenUsage(reply, ['prompt_eval_count'], ['eval_count'])
  const fail = replyFailure(id, usage)
  if (typeof reply.error === 'string') throw fail('invalid-response', `server error: ${snippet(reply.error, MAX_MODEL_TEXT, redact)}`)

  if (reply.done !== true || !DONE.has(reply.done_reason)) throw fail('invalid-response', 'reply has not finished')

  const message = isRecord(reply.message)
    ? reply.message
    : {}
  const { text, reasoning } = readAnswer(id, {
    text: typeof message.content === 'string'
      ? message.content
      : undefined,
    flaggedCutOff: reply.done_reason === 'length',
    windowEnded: false,
    reasoned: typeof message.thinking === 'string' && message.thinking.trim() !== '',
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

/**
 * A provider for Ollama's native chat API, `/api/chat`, on a local server or Ollama's cloud. The key, when
 * there is one, travels only in the header `auth` names, `Authorization: Bearer` by default (invariant
 * I1); a local server needs none. `truncate: false` makes a prompt past the model's context a 400, instead
 * of its oldest messages dropped in silence, and `shift: false` makes a reply that fills the context
 * stop as a truncation, instead of part of the prompt dropped so the reply can go on (Ollama 0.12.6 or
 * later; an older server ignores both fields). It sends `contextTokens` as `options.num_ctx`, so the server
 * loads the context the size guard counts with, and refuses, before any request, a request that may not
 * fit it. It sends the reply's limit, the request's reply budget at most `maxTokens`, else `maxTokens`, else
 * 16000 (`replyBudgetOf`), as `options.num_predict`, so the server bounds a reply's length. It states its worst
 * case from the count its size guard keeps: the text it sends, the template reserve and that budget, and the
 * room its guard leaves from the same count: `contextTokens` less those three. It also states its window, its
 * `maxTokens` when set, and its thinking: the option's level, else `default`, which it sends as `think`, `"low"` or `false`.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function ollama(options: OllamaOptions): Provider {
  const { id, model, auth = 'bearer' as Auth, temperature = 0, maxTokens, contextTokens, systemPrompt = 'native', structuredOutput = 'json', thinking, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = options
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, '/api/chat', [
    ...numCtxIssues(id, options.extraBody),
    ...thinkingIssues(id, thinking, options.extraBody, THINKING),
  ])
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
      // JSON.stringify drops the undefined fields: no format for `prompt`, no temperature for null.
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
          stream: false,
          truncate: false,
          shift: false,
          options: { temperature: temperature ?? undefined, num_predict: budget.replyTokens, num_ctx: contextTokens },
          format: format(structuredOutput, request.output),
          think: think(thinking),
        }, extraBody),
        signal: request.signal,
        redact,
      })
      return readReply(reply, { id, model, budget }, redact)
    },
  }
}
