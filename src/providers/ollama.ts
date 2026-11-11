import { issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../core/ports.ts'
import { postJson, snippet } from './http.ts'
import { shapeMessages } from './messages.ts'
import { bodyKeyForm, isRecord, mergeBody, prepareHttp, unlessEmpty } from './options.ts'
import type { AdapterRules, Auth, HttpProviderOptions, StructuredOutput } from './options.ts'
import { MAX_MODEL_TEXT, replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget } from './size.ts'

/** The options of an Ollama provider: the ones every HTTP adapter takes, and no other. */
export type OllamaOptions = HttpProviderOptions

/**
 * The protocol's rules. The tool fields: `tools`, its only one, and `_debug_render_only`, which answers
 * 200 with the rendered template instead of a reply.
 */
const RULES: Omit<AdapterRules, 'auth'> = {
  reservedBodyKeys: ['model', 'messages', 'stream', 'truncate', 'shift'],
  toolBodyKeys: ['tools', '_debug_render_only'],
  replyLimitPaths: [['options', 'num_predict']],
  fixedHeaders: [],
  structuredOutputs: ['prompt', 'json', 'schema'],
}
/** The done reasons of a finished reply: `length` is one cut off by the token limit, or by a context that filled. */
const DONE: ReadonlySet<unknown> = new Set(['stop', 'length'])

/**
 * The problems of an `extraBody` options that would undo `contextTokens`: a `num_ctx` key, which it sets, and
 * a value that is no object, which would replace the options the adapter sends and drop `num_ctx` with them.
 * The server reads a key in any letter case, so the options object and `num_ctx` are matched as it reads them.
 */
function numCtxIssues(id: string, extraBody: unknown): ConfigIssue[] {
  if (!isRecord(extraBody)) return []
  return Object.entries(extraBody).flatMap(([key, value]): ConfigIssue[] => {
    if (bodyKeyForm(key) !== 'options') return []
    if (!isRecord(value)) return [{ path: `${id}.${issuePath(['extraBody', key])}`, message: 'must be an object' }]
    return Object.keys(value)
      .filter(name => bodyKeyForm(name) === 'numctx')
      .map(name => ({ path: `${id}.${issuePath(['extraBody', key, name])}`, message: 'is set from contextTokens: set contextTokens instead' }))
  })
}

function format(mode: StructuredOutput, output: CompletionRequest['output']): unknown {
  if (mode === 'json') return 'json'
  if (mode === 'schema') return output.schema
  return undefined
}

/**
 * Turn an `/api/chat` reply into text, or a `ProviderError`. Every property is read defensively: the
 * reply is untrusted. A server error comes first: a local server answers one with an error status, but
 * the reply of a remote model could carry one in a 200.
 */
function readReply(reply: unknown, { id, model }: Pick<OllamaOptions, 'id' | 'model'>, redact: readonly string[]): CompletionResponse {
  const fail = replyFailure(id)
  if (!isRecord(reply)) throw fail('invalid-response', 'reply is not a JSON object')
  if (typeof reply.error === 'string') throw fail('invalid-response', `server error: ${snippet(reply.error, MAX_MODEL_TEXT, redact)}`)

  if (reply.done !== true || !DONE.has(reply.done_reason)) throw fail('invalid-response', 'reply has not finished')
  if (reply.done_reason === 'length') throw fail('truncated', 'reply was cut off by the token limit or the context')

  const message = isRecord(reply.message) ? reply.message : {}
  if (typeof message.content !== 'string') throw fail('invalid-response', 'reply has no text')

  return {
    text: message.content,
    model: typeof reply.model === 'string' && reply.model !== '' ? reply.model : model,
    usage: tokenUsage(reply, ['prompt_eval_count'], ['eval_count']),
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
 * fit it.
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function ollama(options: OllamaOptions): Provider {
  const { id, model, auth = 'bearer' as Auth, temperature = 0, maxTokens, contextTokens, systemPrompt = 'native', structuredOutput = 'json' } = options
  const { url, headers, redact, extraBody } = prepareHttp(options, { ...RULES, auth }, '/api/chat', numCtxIssues(id, options.extraBody))
  const budget = contextBudget(contextTokens, maxTokens)

  return {
    id,
    model,
    async complete(request) {
      const { system, messages } = shapeMessages(request, systemPrompt)
      checkFits(id, { system, messages }, request.output, budget)
      // JSON.stringify drops the undefined fields: no format for `prompt`, no options when they would be empty.
      const reply = await postJson<unknown>({
        providerId: id,
        url,
        headers,
        body: mergeBody({
          model,
          messages: system === undefined ? messages : [{ role: 'system', content: system }, ...messages],
          stream: false,
          truncate: false,
          shift: false,
          options: unlessEmpty({ temperature: temperature ?? undefined, num_predict: maxTokens, num_ctx: contextTokens }),
          format: format(structuredOutput, request.output),
        }, extraBody),
        signal: request.signal,
        redact,
      })
      return readReply(reply, { id, model }, redact)
    },
  }
}
