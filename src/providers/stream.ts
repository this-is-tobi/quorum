/**
 * The readers of a reply streamed as server-sent events or NDJSON, which an adapter reads its stream through.
 *
 * Every cap is counted after decoding, on what the reader keeps, never on what the wire sent. A body is
 * compressed, so its size on the wire says nothing about the text it holds: a few kilobytes of gzip inflate to
 * a gigabyte of one line. The body's total is the bytes `fetch` hands over, which is after its decompression,
 * and a line, an event and an answer are counted in decoded characters, before a line is kept (Long 33).
 *
 * A passed cap, or an event or line that is not JSON, ends the read as an `invalid-response` that is never
 * retried, with the body cancelled first, so a server cannot make quorum hold more than the caps allow.
 */

import { ProviderError } from '../core/errors.ts'

/** The caps of a reader: the body's bytes, a line's characters, an event's data characters and its lines. */
export const STREAM_LIMITS = {
  totalBytes: 16_777_216,
  lineChars: 1_048_576,
  eventChars: 4_194_304,
  eventLines: 1000,
} as const

/** The characters of an answer, which each assembler checks: the core's own cap on a reply's text. */
export const MAX_ANSWER_CHARS = 1_000_000

/** The characters of streamed text one token is taken to hold, when the server counts none. */
export const CHARS_PER_TOKEN = 4

/** The output tokens a `data` signal reports, a whole number: the larger of the server's own running count, floored, and a quarter of the characters streamed. */
export function streamedTokens(counted: number, chars: number): number {
  return Math.max(Math.floor(counted), Math.ceil(chars / CHARS_PER_TOKEN))
}

/** The failure of an answer that passed `MAX_ANSWER_CHARS`, which each assembler throws. */
export function answerTooLong(providerId: string): ProviderError {
  return new ProviderError({ providerId, kind: 'invalid-response', message: `the reply stream's answer is over ${MAX_ANSWER_CHARS} characters` })
}

/**
 * What a reader gives: an event with its name (`message` when a server-sent event names none, `line` for an NDJSON
 * line) and its data parsed as JSON, the protocol's sentinel as `done`, and a comment or a blank line as `keep-alive`.
 */
export type StreamItem
  = | { readonly kind: 'event', readonly event: string, readonly value: unknown }
    | { readonly kind: 'done' }
    | { readonly kind: 'keep-alive' }

export interface ReadOptions {
  readonly providerId: string
  /** The data a server-sent event holds when it is the protocol's last, such as OpenAI's `[DONE]`: read as `done`. */
  readonly sentinel?: string
  /** Maps a read that rejects, which the adapter words as an abort or a network failure. */
  readonly lost: (error: unknown) => ProviderError
}

const LINE_FEED = 10
const CARRIAGE_RETURN = 13

function invalid(providerId: string, message: string): ProviderError {
  return new ProviderError({
    providerId,
    kind: 'invalid-response',
    message,
    retryable: false,
  })
}

/** The failure of a stream whose body ended with no terminal event, which an assembler throws. */
export function streamEnded(providerId: string): ProviderError {
  return new ProviderError({ providerId, kind: 'network', message: 'the reply stream ended before its last event' })
}

/**
 * The lines of a body, decoded across chunk boundaries: a line ends at a line feed, a carriage return and a line
 * feed, or a carriage return, and a pair split between two chunks is one ending. A line that is not ended when the
 * body does is given only when `flushLast` says so. A passed cap throws, and a generator that ends early, by a
 * throw or by its consumer, cancels the body.
 */
async function* readLines(body: ReadableStream<Uint8Array>, options: ReadOptions, flushLast: boolean): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: false })
  let settled = false
  let total = 0
  let pending = ''
  let skipLineFeed = false

  const checkLine = (length: number): void => {
    if (length > STREAM_LIMITS.lineChars) throw invalid(options.providerId, 'the reply stream passed its line cap')
  }

  try {
    for (;;) {
      let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
      try {
        chunk = await reader.read()
      } catch (error) {
        settled = true
        throw options.lost(error)
      }
      if (chunk.done) {
        settled = true
        break
      }

      total += chunk.value.byteLength
      if (total > STREAM_LIMITS.totalBytes) throw invalid(options.providerId, 'the reply stream is over 16 MiB')

      // The decoder drops a byte-order mark at the start of the body, as the server-sent events rules ask.
      const text = decoder.decode(chunk.value, { stream: true })
      let start = skipLineFeed && text.charCodeAt(0) === LINE_FEED
        ? 1
        : 0
      // An empty chunk ends nothing: a carriage return at the end of the one before still owes its line feed a skip.
      if (text !== '') skipLineFeed = false
      for (let index = start; index < text.length; index++) {
        const code = text.charCodeAt(index)
        if (code !== LINE_FEED && code !== CARRIAGE_RETURN) continue
        checkLine(pending.length + index - start)
        const line = pending + text.slice(start, index)
        pending = ''
        if (code === CARRIAGE_RETURN) {
          if (text.charCodeAt(index + 1) === LINE_FEED) index++
          else if (index + 1 === text.length) skipLineFeed = true
        }
        start = index + 1
        yield line
      }
      checkLine(pending.length + text.length - start)
      pending += text.slice(start)
    }

    pending += decoder.decode()
    checkLine(pending.length)
    if (flushLast && pending !== '') yield pending
  } finally {
    if (!settled) await reader.cancel().catch(() => undefined)
  }
}

/** An event's data parsed as JSON, or the failure of a server that sent something else. */
function parseJson(text: string, providerId: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw invalid(providerId, 'the reply stream holds an event that is not JSON')
  }
}

/**
 * A body read as server-sent events, by the WHATWG rules: a comment is a keep-alive, an unknown field is ignored,
 * data lines are joined by a line feed, and an event is dispatched at a blank line, so one the body leaves
 * unclosed is discarded. Each event's data is JSON, but for the sentinel, which is `done`.
 */
export async function* sseItems(body: ReadableStream<Uint8Array>, options: ReadOptions): AsyncGenerator<StreamItem, void, undefined> {
  const { providerId, sentinel } = options
  let name = ''
  let data: string[] = []
  let dataChars = 0
  let lines = 0

  const reset = (): void => {
    name = ''
    data = []
    dataChars = 0
    lines = 0
  }
  const overCap = (): ProviderError => invalid(providerId, 'the reply stream holds an event over its cap')

  for await (const line of readLines(body, options, false)) {
    if (line === '') {
      const text = data.join('\n')
      const event = name === ''
        ? 'message'
        : name
      const dispatch = data.length > 0
      reset()
      if (!dispatch) continue
      if (sentinel !== undefined && text === sentinel) {
        yield { kind: 'done' }
      } else {
        yield {
          kind: 'event',
          event,
          value: parseJson(text, providerId),
        }
      }
      continue
    }
    if (line.startsWith(':')) {
      yield { kind: 'keep-alive' }
      continue
    }

    lines++
    if (lines > STREAM_LIMITS.eventLines) throw overCap()
    const colon = line.indexOf(':')
    const field = colon === -1
      ? line
      : line.slice(0, colon)
    let value = colon === -1
      ? ''
      : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      // The data lines are joined by a line feed: one before each line but the first.
      dataChars += value.length + (data.length > 0
        ? 1
        : 0)
      if (dataChars > STREAM_LIMITS.eventChars) throw overCap()
      data.push(value)
    } else if (field === 'event') {
      name = value
    }
  }
}

/** A body read as NDJSON: each line is JSON, a blank line is a keep-alive, and the last line may end with no line feed. */
export async function* ndjsonItems(body: ReadableStream<Uint8Array>, options: ReadOptions): AsyncGenerator<StreamItem, void, undefined> {
  for await (const line of readLines(body, options, true)) {
    if (line.trim() === '') {
      yield { kind: 'keep-alive' }
    } else {
      yield {
        kind: 'event',
        event: 'line',
        value: parseJson(line, options.providerId),
      }
    }
  }
}

/** What an assembler may take as given of a stream's fields: an absent one is `undefined` or `null`, which is tolerated; any other type than the one the protocol writes is not. */
const EXPECTED = { text: 'text', object: 'an object', list: 'a list' } as const

/**
 * The failure of a known event, chunk or line whose field has the wrong type, which an assembler throws: an
 * `invalid-response` that is never retried, in code words, quoting nothing the server wrote. A field that is dropped
 * could let a partial answer be read as a whole one, so it ends the read instead.
 */
export function malformedStream(providerId: string, field: string, expected: keyof typeof EXPECTED): ProviderError {
  return invalid(providerId, `the reply stream's ${field} is not ${EXPECTED[expected]}`)
}

/** `value` as the text it is, `undefined` when it is absent (`undefined` or `null`), and the failure `malformedStream` names when it is any other type. */
export function textField(providerId: string, value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw malformedStream(providerId, field, 'text')
  return value
}

/** `value` as the object it is, `undefined` when it is absent, and the failure `malformedStream` names when it is any other type. */
export function objectField(providerId: string, value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw malformedStream(providerId, field, 'object')
  return value as Record<string, unknown>
}

/** `value` as the list it is, `undefined` when it is absent, and the failure `malformedStream` names when it is any other type. */
export function listField(providerId: string, value: unknown, field: string): unknown[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw malformedStream(providerId, field, 'list')
  return value
}

/** `value` as the object it must be, a whole event, chunk or line: any other type, `null` included, is the failure `malformedStream` names. */
export function objectValue(providerId: string, value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformedStream(providerId, field, 'object')
  return value as Record<string, unknown>
}
