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
