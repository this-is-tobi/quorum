/** Test helpers for code that calls `fetch`. A body is read once, so build a fresh reply for every call. */

import { vi } from 'vitest'
import { chatResponse } from './fixtures/ollama.ts'

/** A reply holding `body` as JSON, as a server sends it. */
export function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A stub put in place of the global `fetch`, answering every call with `body` as JSON. */
export function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async () => jsonReply(body, status))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** An OpenAI-compatible chat completion holding `content`. */
export function chatReply(content: string): Response {
  return jsonReply({ choices: [{ message: { content } }] })
}

/** An Ollama native chat completion (`/api/chat`) holding `content`. */
export function ollamaReply(content: string): Response {
  return jsonReply({ ...chatResponse, message: { role: 'assistant', content } })
}

/**
 * A stub put in place of the global `fetch`, answering call `i` with `reply(contents[i])`. A call past
 * `contents` gets what the caller chains: `.mockRejectedValue(...)` or `.mockImplementation(...)`.
 */
export function stubReplies(reply: (content: string) => Response, ...contents: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn()
  for (const content of contents) fetchMock.mockImplementationOnce(async () => reply(content))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** `stubReplies` with `chatReply`: call `i` is answered with an OpenAI-compatible completion holding `contents[i]`. */
export function stubChat(...contents: string[]): ReturnType<typeof vi.fn> {
  return stubReplies(chatReply, ...contents)
}

/** `stubReplies` with `ollamaReply`: call `i` is answered with a native Ollama completion holding `contents[i]`. */
export function stubOllamaChat(...contents: string[]): ReturnType<typeof vi.fn> {
  return stubReplies(ollamaReply, ...contents)
}

/** What one call of a fetch stub sent, the first by default: the URL, the headers and the parsed body. */
export function sent(fetchMock: ReturnType<typeof vi.fn>, call = 0): { url: string, headers: Record<string, string>, body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[call]
  return { url, headers: init.headers, body: JSON.parse(init.body) }
}

/** A reply holding `text` as it is. */
export function textReply(text: string, status: number): Response {
  return new Response(text, { status })
}

/** A reply whose body is `chunk` repeated `count` times, each made only when it is read, and how many were read. */
export function streamedReply(chunk: string, count: number, status = 200): { response: Response, pulled: () => number } {
  const bytes = new TextEncoder().encode(chunk)
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === count) {
        controller.close()
        return
      }
      pulled += 1
      controller.enqueue(bytes)
    },
  })
  return { response: new Response(body, { status }), pulled: () => pulled }
}

/** A reply whose body fails while it is read, as a connection that drops does; `before` runs first. */
export function brokenReply(error: unknown, status = 200, before?: () => void): Response {
  const body = new ReadableStream({
    pull(controller) {
      before?.()
      controller.error(error)
    },
  })
  return new Response(body, { status })
}
