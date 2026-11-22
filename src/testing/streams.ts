import type { Clock } from '../core/clock.ts'
import { ProviderError } from '../core/errors.ts'
import type { CompletionRequest, CompletionResponse, Provider, StreamSignal } from '../core/ports.ts'
import { stubResponses } from './http.ts'

/** Test helpers for code that reads a streamed reply. */

/**
 * The UTF-8 bytes of `text` as a body that hands them over `size` bytes at a time, each chunk made only when it is
 * read, and whether the reader cancelled it.
 */
export function chunkedBody(text: string, size = 1): { readonly body: ReadableStream<Uint8Array>, readonly cancelled: () => boolean } {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
    cancel() {
      cancelled = true
    },
  }, { highWaterMark: 0 })
  return {
    body,
    cancelled: () => cancelled,
  }
}

/** Server-sent events as a server writes them: each event's `data` as JSON, a string as it is, ended by a blank line. */
export function sse(events: ReadonlyArray<{ readonly event?: string, readonly data: unknown }>): string {
  return events.map(({ event, data }) => {
    const name = event === undefined
      ? ''
      : `event: ${event}\n`
    const text = typeof data === 'string'
      ? data
      : JSON.stringify(data)
    return `${name}data: ${text}\n\n`
  }).join('')
}

/** The text of a streamed reply, cut into pieces of at most `size` characters, so a field arrives over several chunks as it does from a server. */
function pieces(text: string, size = 5): string[] {
  const parts: string[] = []
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size))
  return parts
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A recorded whole chat completion as the server-sent chunks an OpenAI-compatible server streams it in: a role chunk,
 * then the choice's reasoning, refusal and content as deltas a few characters each (a content of parts as one part a
 * chunk), its annotations and executed tools, a chunk that holds the finish reason (`stop` when the reply names none),
 * a usage chunk with no choices when the reply has a usage, and `[DONE]` last. The reply's `error` rides the finish
 * chunk. The response's content type is `text/event-stream`, and `headers` are added to it.
 */
export function openAiStream(reply: unknown, headers: Record<string, string> = {}): Response {
  const whole = isObject(reply)
    ? reply
    : {}
  const choice = Array.isArray(whole.choices) && isObject(whole.choices[0])
    ? whole.choices[0]
    : {}
  const message = isObject(choice.message)
    ? choice.message
    : {}
  const base = {
    id: whole.id,
    object: 'chat.completion.chunk',
    created: whole.created,
    model: whole.model,
  }
  const chunk = (delta: unknown, finish: unknown = null): Record<string, unknown> => ({
    ...base,
    choices: [
      { index: 0, delta, finish_reason: finish },
    ],
  })
  const events: unknown[] = [
    chunk({ role: 'assistant' }),
  ]
  for (const field of ['reasoning', 'reasoning_content', 'refusal'] as const) {
    const text = message[field]
    if (typeof text === 'string') events.push(...pieces(text).map(piece => chunk({ [field]: piece })))
  }
  const { content } = message
  if (typeof content === 'string') {
    events.push(...pieces(content).map(piece => chunk({ content: piece })))
  } else if (Array.isArray(content)) {
    events.push(...content.map(part => chunk({
      content: [part],
    })))
  }
  if (message.annotations !== undefined) events.push(chunk({ annotations: message.annotations }))
  if (message.executed_tools !== undefined) events.push(chunk({ executed_tools: message.executed_tools }))
  events.push({
    ...chunk({}, choice.finish_reason ?? 'stop'),
    ...whole.error === undefined
      ? {}
      : { error: whole.error },
  })
  if (whole.usage !== undefined) events.push({ ...base, choices: [], usage: whole.usage })
  return new Response(sse([
    ...events.map(data => ({ data })),
    { data: '[DONE]' },
  ]), {
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

/** The text of a reply's field as a string, or nothing. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : undefined
}

/**
 * A recorded whole Messages reply as the events the Anthropic API streams it in: a `message_start` that holds the
 * message with no content and the input counts, a `ping`, then each content block as a `content_block_start`, its
 * deltas (a text or a thinking a few characters each, a thinking's signature, a tool's input as one piece) and a
 * `content_block_stop`, a `message_delta` that holds the stop reason and the output count, and `message_stop`. Each
 * event names itself, as the API writes it. The response's content type is `text/event-stream`, and `headers` are added.
 */
export function anthropicStream(reply: unknown, headers: Record<string, string> = {}): Response {
  const whole = isObject(reply)
    ? reply
    : {}
  const usage = isObject(whole.usage)
    ? whole.usage
    : undefined
  const events: Array<{ event: string, data: Record<string, unknown> }> = []
  const emit = (data: Record<string, unknown>): number => events.push({
    event: String(data.type),
    data,
  })
  emit({
    type: 'message_start',
    message: {
      ...whole,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      ...usage === undefined
        ? {}
        : {
            usage: { ...usage, output_tokens: 1 },
          },
    },
  })
  emit({ type: 'ping' })
  const blocks = Array.isArray(whole.content)
    ? whole.content.filter(isObject)
    : []
  blocks.forEach((block, index) => {
    const { text, thinking, signature, ...rest } = block
    const empty = block.type === 'text'
      ? { text: '' }
      : block.type === 'thinking'
        ? { thinking: '', signature: '' }
        : block.type === 'tool_use'
          ? { input: {} }
          : {}
    emit({
      type: 'content_block_start',
      index,
      content_block: {
        ...rest,
        ...empty,
      },
    })
    const delta = (body: Record<string, unknown>): number => emit({ type: 'content_block_delta', index, delta: body })
    for (const piece of pieces(textOf(text) ?? '')) delta({ type: 'text_delta', text: piece })
    for (const piece of pieces(textOf(thinking) ?? '')) delta({ type: 'thinking_delta', thinking: piece })
    if (textOf(signature) !== undefined) delta({ type: 'signature_delta', signature })
    if (block.type === 'tool_use') {
      delta({
        type: 'input_json_delta',
        partial_json: JSON.stringify(block.input),
      })
    }
    emit({ type: 'content_block_stop', index })
  })
  emit({
    type: 'message_delta',
    delta: { stop_reason: whole.stop_reason ?? 'end_turn', stop_sequence: whole.stop_sequence ?? null },
    ...usage === undefined
      ? {}
      : {
          usage: { output_tokens: usage.output_tokens },
        },
  })
  emit({ type: 'message_stop' })
  return new Response(sse(events), {
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

/**
 * A recorded whole `generateContent` reply as the chunks Gemini's `streamGenerateContent` sends it in with `alt=sse`,
 * as events with no name: the candidate's parts as chunks of a few characters each (a part that is no text as one chunk),
 * then a chunk that holds the finish reason and the usage; a reply with no candidate, a blocked prompt, as one chunk that
 * holds the feedback and the usage. A reply's `error` is its one chunk. The response's content type is `text/event-stream`,
 * and `headers` are added.
 */
export function geminiStream(reply: unknown, headers: Record<string, string> = {}): Response {
  const whole = isObject(reply)
    ? reply
    : {}
  const base = {
    modelVersion: whole.modelVersion,
    responseId: whole.responseId,
  }
  const candidate = Array.isArray(whole.candidates) && isObject(whole.candidates[0])
    ? whole.candidates[0]
    : undefined
  const chunks: unknown[] = []
  if (whole.error !== undefined) {
    chunks.push({ error: whole.error })
  } else if (candidate === undefined) {
    chunks.push({ ...base, promptFeedback: whole.promptFeedback, usageMetadata: whole.usageMetadata })
  } else {
    const content = isObject(candidate.content)
      ? candidate.content
      : {}
    const role = content.role ?? 'model'
    const chunk = (parts: unknown[]): Record<string, unknown> => ({
      ...base,
      candidates: [
        {
          content: { parts, role },
          index: 0,
        },
      ],
    })
    for (const part of Array.isArray(content.parts)
      ? content.parts
      : []) {
      if (isObject(part) && typeof part.text === 'string') {
        chunks.push(...pieces(part.text).map(piece => chunk([
          { ...part, text: piece },
        ])))
      } else {
        chunks.push(chunk([part]))
      }
    }
    chunks.push({
      ...base,
      candidates: [
        {
          content: { role },
          finishReason: candidate.finishReason,
          index: 0,
        },
      ],
      usageMetadata: whole.usageMetadata,
    })
  }
  return new Response(sse(chunks.map(data => ({ data }))), {
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

/**
 * A recorded whole `/api/chat` reply as the NDJSON lines Ollama streams it in: the message's thinking, then its content,
 * a few characters a line, then the done line, which holds every other field of the reply and an empty content. A reply
 * that is only an `error` is its one line. The response's content type is `application/x-ndjson`, and `headers` are added.
 */
export function ollamaStream(reply: unknown, headers: Record<string, string> = {}): Response {
  const whole = isObject(reply)
    ? reply
    : {}
  const message = isObject(whole.message)
    ? whole.message
    : {}
  const line = (fields: Record<string, unknown>): Record<string, unknown> => ({
    model: whole.model,
    created_at: whole.created_at,
    message: { role: 'assistant', content: '', ...fields },
    done: false,
  })
  const lines: unknown[] = []
  if (typeof whole.error === 'string') {
    lines.push({ error: whole.error })
  } else {
    lines.push(...pieces(textOf(message.thinking) ?? '').map(piece => line({ thinking: piece })))
    lines.push(...pieces(textOf(message.content) ?? '').map(piece => line({ content: piece })))
    lines.push({
      ...whole,
      message: { ...message, content: '', thinking: undefined },
    })
  }
  return new Response(lines.map(data => `${JSON.stringify(data)}\n`).join(''), {
    headers: { 'content-type': 'application/x-ndjson', ...headers },
  })
}

/** What a streaming provider's plan says of one request: the signals it reports, each at the time since the request was sent, and how it ends. */
export interface StreamPlan {
  readonly script: ReadonlyArray<{ readonly afterMs: number, readonly signal: StreamSignal }>
  readonly end: CompletionResponse | ProviderError
}

/**
 * A provider that streams on `clock`, whose reply `plan` scripts for each request: it states `streams: true` and `facts`, then
 * waits on `clock` until each signal of the script is due, `afterMs` being the time since the request was sent, and reports it
 * through the request's `onProgress`; it answers or throws `end` right after the last signal, so a silence is a last signal far
 * off, which the core's own timers end first. It honours the request's signal: an abort rejects its wait with the abort's reason.
 */
export function streamingProvider(clock: Clock, plan: (request: CompletionRequest) => StreamPlan, facts: Partial<Provider> = {}): Provider {
  const wait = (ms: number, signal: AbortSignal | undefined): Promise<void> => {
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let cancel = (): void => {}
      const onAbort = (): void => {
        cancel()
        reject(signal!.reason)
      }
      cancel = clock.timer(ms, () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      })
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  return {
    id: 'streaming',
    model: 'm',
    streams: true,
    ...facts,
    async complete(request) {
      const { script, end } = plan(request)
      const sent = clock.now()
      for (const step of script) {
        await wait(step.afterMs - (clock.now() - sent), request.signal)
        request.onProgress?.(step.signal)
      }
      if (end instanceof ProviderError) throw end
      return end
    },
  }
}

/**
 * What a call of `provider` came to when `fetch` answers it with `reply`, for comparing a stream with a whole reply:
 * the reply less `whole`, or the failure's `kind`, `message`, `noAnswer` and `usage`, with no text of the server's
 * but what the error words.
 */
export async function outcomeOf(provider: Provider, request: CompletionRequest, reply: Response): Promise<unknown> {
  stubResponses(reply)
  return await provider.complete(request).then(
    ({ whole: _whole, ...reached }) => reached,
    (error: ProviderError) => ({
      kind: error.kind,
      message: error.message,
      noAnswer: error.noAnswer,
      usage: error.usage,
    }),
  )
}

/** The `lost` a reader of a stream is handed in a spec: a `network` failure of `providerId`'s, worded by the error. */
export function lostStream(providerId: string): (error: unknown) => ProviderError {
  return error => new ProviderError({
    providerId,
    kind: 'network',
    message: String(error),
  })
}
