/**
 * The stream of a gateway that serves a reasoning model, in the shape one streamed request with `stream_options`,
 * `max_tokens` 4000 and a 67-token prompt showed: `delta.reasoning` chunks and nothing else for the whole limit, so
 * 14 285 characters of reasoning and no answer; a chunk that holds `finish_reason: "length"`; a chunk with no choices
 * that holds the usage, 67 in and 4000 out; then `[DONE]`. It is served as `text/event-stream; charset=utf-8`, with
 * `cache-control: no-cache` and the rate-limit headers of a whole reply, the OpenAI-named ones and the generic ones.
 * The origin and the model are made up.
 */

import { sse } from '../streams.ts'

/** The origin of the gateway the stream pins. */
export const GATEWAY_ORIGIN = 'https://gateway.example'
/** The model the gateway serves. */
export const GATEWAY_MODEL = 'code'
/** The characters of reasoning the stream holds in all. */
export const GATEWAY_REASONING_CHARS = 14_285
/** The usage chunk's counts. */
export const GATEWAY_USAGE = { prompt_tokens: 67, completion_tokens: 4000, total_tokens: 4067 } as const

/** The headers the gateway serves a stream with. */
export const GATEWAY_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'x-ratelimit-limit-requests': '300',
  'x-ratelimit-remaining-requests': '299',
  'x-ratelimit-limit-tokens': '1000000',
  'x-ratelimit-remaining-tokens': '1000000',
  'x-ratelimit-reset-requests': '1s',
  'x-ratelimit-reset-tokens': '0s',
  'x-ratelimit-limit': '300',
  'x-ratelimit-remaining': '299',
  'x-ratelimit-reset': '60',
}

/** The reasoning of the stream: 14 285 characters in chunks of 143, the last one shorter. */
function reasoningChunks(): string[] {
  const chunks: string[] = []
  for (let used = 0; used < GATEWAY_REASONING_CHARS; used += 143) chunks.push('r'.repeat(Math.min(143, GATEWAY_REASONING_CHARS - used)))
  return chunks
}

/** The stream's text, as the server-sent events the gateway writes. */
export function gatewayStreamText(): string {
  const base = {
    id: 'chatcmpl-8f1c',
    object: 'chat.completion.chunk',
    created: 1_790_000_000,
    model: GATEWAY_MODEL,
  }
  const chunk = (delta: unknown, finish: unknown = null): Record<string, unknown> => ({
    ...base,
    choices: [
      { index: 0, delta, finish_reason: finish },
    ],
  })
  return sse([
    {
      data: chunk({ role: 'assistant', content: '' }),
    },
    ...reasoningChunks().map(text => ({
      data: chunk({ reasoning: text }),
    })),
    {
      data: chunk({}, 'length'),
    },
    {
      data: { ...base, choices: [], usage: GATEWAY_USAGE },
    },
    { data: '[DONE]' },
  ])
}

/** The gateway's stream as a response: a body is read once, so build a fresh one for every call. */
export function gatewayStream(): Response {
  return new Response(gatewayStreamText(), { headers: GATEWAY_HEADERS })
}
