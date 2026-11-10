/** Test helpers for code that calls `fetch`. A body is read once, so build a fresh reply for every call. */

import { vi } from 'vitest'

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
