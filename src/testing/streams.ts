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
