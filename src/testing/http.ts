/** Test helpers for code that calls `fetch`. A body is read once, so build a fresh reply for every call. */

/** A reply holding `body` as JSON, as a server sends it. */
export function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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
