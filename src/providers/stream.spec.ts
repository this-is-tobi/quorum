import { describe, expect, it } from 'vitest'
import { ProviderError } from '../core/errors.ts'
import { chunkedBody, sse } from '../testing/streams.ts'
import { fakeServer } from '../testing/server.ts'
import { MAX_ANSWER_CHARS, ndjsonItems, sseItems, STREAM_LIMITS, streamEnded } from './stream.ts'
import type { ReadOptions, StreamItem } from './stream.ts'

const BOM = String.fromCharCode(0xFEFF)
const GRINNING = String.fromCodePoint(0x1F600)

const OPTIONS: ReadOptions = {
  providerId: 'p',
  lost: () => new ProviderError({ providerId: 'p', kind: 'network', message: 'lost the stream' }),
}

async function collect(items: AsyncGenerator<StreamItem, void, undefined>): Promise<StreamItem[]> {
  const seen: StreamItem[] = []
  for await (const item of items) seen.push(item)
  return seen
}

async function failureOf(items: AsyncGenerator<StreamItem, void, undefined>): Promise<unknown> {
  try {
    await collect(items)
  } catch (error) {
    return error
  }
  return undefined
}

const event = (value: unknown, name = 'message'): StreamItem => ({ kind: 'event', event: name, value })
const keepAlive: StreamItem = { kind: 'keep-alive' }

describe('the limits', () => {
  it('holds the values the readers are specified with', () => {
    expect(STREAM_LIMITS).toEqual({
      totalBytes: 16_777_216,
      lineChars: 1_048_576,
      eventChars: 4_194_304,
      eventLines: 1000,
    })
    expect(MAX_ANSWER_CHARS).toBe(1_000_000)
  })

  it('words a stream that ended before its last event as a network failure', () => {
    const error = streamEnded('p')
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.kind).toBe('network')
    expect(error.message).toBe('p: the reply stream ended before its last event')
  })
})

/** A body that hands over each of `chunks` as it is, an empty one included, which `chunkedBody` cannot make. */
function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let next = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= chunks.length) controller.close()
      else controller.enqueue(encoder.encode(chunks[next++]))
    },
  }, { highWaterMark: 0 })
}

describe('a carriage return and its line feed with an empty chunk between', () => {
  it('reads the pair as one line ending, in server-sent events and in NDJSON', async () => {
    const events = await collect(sseItems(bodyOf(['data: [1,\r', '', '\ndata: 2]\r\n\r\n']), OPTIONS))
    expect(events).toEqual([
      event([1, 2]),
    ])
    const lines = await collect(ndjsonItems(bodyOf(['{"a":1}\r', '', '\n{"a":2}\n']), OPTIONS))
    expect(lines).toEqual([
      event({ a: 1 }, 'line'),
      event({ a: 2 }, 'line'),
    ])
  })
})

describe('sseItems', () => {
  it.each<[string, string, number, StreamItem[], string?]>([
    [
      'split one byte at a time, an accented letter and a four-byte character across chunks',
      `data: ${JSON.stringify({ t: `café${GRINNING}` })}\n\n`,
      1,
      [
        event({ t: `café${GRINNING}` }),
      ],
    ],
    [
      'with lines ended by a line feed, a CRLF and a lone CR',
      'data: {"n":1}\n\ndata: {"n":2}\r\n\r\ndata: {"n":3}\r\r',
      1,
      [
        event({ n: 1 }),
        event({ n: 2 }),
        event({ n: 3 }),
      ],
    ],
    [
      'with a carriage return that ends one chunk and a line feed that opens the next',
      'data:[\r\ndata:1]\r\n\r\n',
      7,
      [
        event([1]),
      ],
    ],
    [
      'after a byte-order mark',
      `${BOM}data: {"a":1}\n\n`,
      1,
      [
        event({ a: 1 }),
      ],
    ],
    [
      'with a comment between events',
      'data: {"a":1}\n\n: ping\n\ndata: {"a":2}\n\n',
      1,
      [
        event({ a: 1 }),
        keepAlive,
        event({ a: 2 }),
      ],
    ],
    [
      'with an unknown field and an id',
      'id: 7\nretry: 5\nfoo: bar\nbaz\ndata: {"a":1}\n\n',
      1,
      [
        event({ a: 1 }),
      ],
    ],
    [
      'with two data lines',
      'data: [1,\ndata: 2]\n\n',
      1,
      [
        event([1, 2]),
      ],
    ],
    [
      'with a named event',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      1,
      [
        event({ type: 'message_stop' }, 'message_stop'),
      ],
    ],
    [
      'with the sentinel',
      'data: [DONE]\n\n',
      1,
      [
        { kind: 'done' },
      ],
      '[DONE]',
    ],
  ])('reads server-sent events %s', async (_name, text, size, items, sentinel) => {
    const { body } = chunkedBody(text, size)
    expect(await collect(sseItems(body, { ...OPTIONS, sentinel }))).toEqual(items)
  })

  it('reads the sentinel as data when none is set', async () => {
    const { body } = chunkedBody('data: [DONE]\n\n')
    expect(await failureOf(sseItems(body, OPTIONS))).toMatchObject({ kind: 'invalid-response' })
  })

  it('drops a flood of comments as it reads them, each a keep-alive, so they cost only bytes', async () => {
    const { body } = chunkedBody(`${': x\n'.repeat(100_000)}data: {"n":1}\n\n`, 1024)
    const items = await collect(sseItems(body, OPTIONS))
    expect(items).toHaveLength(100_001)
    expect(items.slice(0, 100_000).every(item => item.kind === 'keep-alive')).toBe(true)
    expect(items[100_000]).toEqual(event({ n: 1 }))
  })

  it('discards an event the body leaves unclosed, as the rules say', async () => {
    const { body } = chunkedBody('data: {"n":1}\n')
    expect(await collect(sseItems(body, OPTIONS))).toEqual([])
  })

  it('accepts a line of exactly its cap', async () => {
    const { body } = chunkedBody(`:${'x'.repeat(STREAM_LIMITS.lineChars - 1)}\n`, 65_536)
    expect(await collect(sseItems(body, OPTIONS))).toEqual([keepAlive])
  })

  it.each<[string, string, number, string]>([
    [
      'a line holds 1 048 577 characters',
      `:${'x'.repeat(STREAM_LIMITS.lineChars)}\n`,
      65_536,
      'the reply stream passed its line cap',
    ],
    [
      'an event holds 1001 lines of a tiny unknown field',
      'x:1\n'.repeat(STREAM_LIMITS.eventLines + 1),
      4096,
      'the reply stream holds an event over its cap',
    ],
    [
      'an event\'s data passes 4 194 304 characters in lines under the line cap',
      `data: ${'x'.repeat(900_000)}\n`.repeat(5),
      65_536,
      'the reply stream holds an event over its cap',
    ],
    [
      'the body passes 16 777 216 bytes',
      `:${'x'.repeat(999)}\n`.repeat(16_778),
      262_144,
      'the reply stream is over 16 MiB',
    ],
    [
      'an event is not JSON',
      'data: not json\n\n',
      1,
      'the reply stream holds an event that is not JSON',
    ],
  ])('fails closed with invalid-response when %s, and cancels the body first', async (_name, text, size, message) => {
    const { body, cancelled } = chunkedBody(text, size)
    const error = await failureOf(sseItems(body, OPTIONS))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ kind: 'invalid-response', message: `p: ${message}`, retryable: false })
    expect(cancelled()).toBe(true)
  })

  it('cancels the body when its consumer stops early', async () => {
    const { body, cancelled } = chunkedBody(sse([
      {
        data: { n: 1 },
      },
      {
        data: { n: 2 },
      },
    ]), 4)
    const items = sseItems(body, OPTIONS)
    expect((await items.next()).value).toEqual(event({ n: 1 }))
    await items.return()
    expect(cancelled()).toBe(true)
  })

  it('does not cancel a body it read to its end', async () => {
    const { body, cancelled } = chunkedBody(sse([
      {
        data: { n: 1 },
      },
    ]))
    await collect(sseItems(body, OPTIONS))
    expect(cancelled()).toBe(false)
  })

  it('hands a read that rejects to lost, and throws what it makes', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"n":1}\n\n'))
      },
      pull(controller) {
        controller.error(new Error('dropped'))
      },
    })
    const seen: unknown[] = []
    const lost = (error: unknown): ProviderError => {
      seen.push(error)
      return new ProviderError({ providerId: 'p', kind: 'network', message: 'reading the reply failed' })
    }
    const items: StreamItem[] = []
    let thrown: unknown
    try {
      for await (const item of sseItems(body, { ...OPTIONS, lost })) items.push(item)
    } catch (error) {
      thrown = error
    }
    expect(items).toEqual([
      event({ n: 1 }),
    ])
    expect(thrown).toMatchObject({ kind: 'network', message: 'p: reading the reply failed' })
    expect(seen).toEqual([
      new Error('dropped'),
    ])
  })

  it('reads a stream through the real fetch, one byte at a time', async () => {
    const server = await fakeServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const bytes = new TextEncoder().encode(`${sse([
        {
          data: { t: `café${GRINNING}` },
        },
        {
          event: 'end',
          data: { n: 2 },
        },
      ])}: ping\n\n`)
      for (const byte of bytes) response.write(Buffer.from([byte]))
      response.end()
    })
    try {
      const response = await fetch(server.url)
      expect(await collect(sseItems(response.body!, OPTIONS))).toEqual([
        event({ t: `café${GRINNING}` }),
        event({ n: 2 }, 'end'),
        keepAlive,
      ])
    } finally {
      await server.close()
    }
  })
})

describe('ndjsonItems', () => {
  it.each<[string, string, StreamItem[]]>([
    [
      'split across chunks',
      '{"a":1}\n{"a":2}\n',
      [
        event({ a: 1 }, 'line'),
        event({ a: 2 }, 'line'),
      ],
    ],
    [
      'with CRLF endings',
      '{"a":1}\r\n{"a":2}\r\n',
      [
        event({ a: 1 }, 'line'),
        event({ a: 2 }, 'line'),
      ],
    ],
    [
      'with a blank line',
      '{"a":1}\n\n{"a":2}\n',
      [
        event({ a: 1 }, 'line'),
        keepAlive,
        event({ a: 2 }, 'line'),
      ],
    ],
    [
      'whose last line has no line feed',
      '{"a":1}\n{"a":2}',
      [
        event({ a: 1 }, 'line'),
        event({ a: 2 }, 'line'),
      ],
    ],
  ])('reads NDJSON lines %s', async (_name, text, items) => {
    const { body } = chunkedBody(text)
    expect(await collect(ndjsonItems(body, OPTIONS))).toEqual(items)
  })

  it.each<[string, string, number, string]>([
    [
      'a line holds 1 048 577 characters',
      `"${'x'.repeat(STREAM_LIMITS.lineChars - 1)}"\n`,
      65_536,
      'the reply stream passed its line cap',
    ],
    [
      'a line is not JSON',
      '{"a":1}\nnot json\n',
      1,
      'the reply stream holds an event that is not JSON',
    ],
  ])('fails an NDJSON stream closed when %s', async (_name, text, size, message) => {
    const { body, cancelled } = chunkedBody(text, size)
    const error = await failureOf(ndjsonItems(body, OPTIONS))
    expect(error).toMatchObject({ kind: 'invalid-response', message: `p: ${message}`, retryable: false })
    expect(cancelled()).toBe(true)
  })

  it('hands a read that rejects to lost, and throws what it makes', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('dropped'))
      },
    })
    expect(await failureOf(ndjsonItems(body, OPTIONS))).toMatchObject({ kind: 'network', message: 'p: lost the stream' })
  })
})
