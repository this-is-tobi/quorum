import { describe, expect, it } from 'vitest'
import type { CompletionRequest } from '../core/ports.ts'
import { fakeServer } from '../testing/server.ts'
import { sse } from '../testing/streams.ts'
import { openaiCompatible } from './openai-compatible.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [
    { role: 'user', content: 'data' },
  ],
  output: {
    name: 'panel_vote',
    schema: { type: 'object' },
  },
}

function chunk(delta: unknown, finish: unknown = null): Record<string, unknown> {
  return {
    model: 'qwen-1',
    choices: [
      { index: 0, delta, finish_reason: finish },
    ],
  }
}

/** Writes `text` to `response` one byte at a time, each write handed over before the next. */
async function writeByByte(response: { write: (chunk: Uint8Array, done: () => void) => unknown }, text: string): Promise<void> {
  for (const byte of new TextEncoder().encode(text)) await new Promise<void>(resolve => response.write(Uint8Array.of(byte), resolve))
}

describe('the OpenAI-compatible adapter against a server on the loopback', () => {
  it('streams a reply from a server one byte at a time through the real fetch', async () => {
    let seen = ''
    const server = await fakeServer(async (incoming, response) => {
      for await (const part of incoming) seen += String(part)
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      await writeByByte(response, `${sse([
        chunk({ role: 'assistant' }),
        chunk({ reasoning: 'Thinking: café \u{1F600}' }),
        chunk({ content: '{"findings"' }),
        chunk({ content: ':[]}' }),
        chunk({}, 'stop'),
        {
          model: 'qwen-1',
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        },
      ].map(data => ({ data })))}data: [DONE]\n\n`)
      response.end()
    })
    try {
      const provider = openaiCompatible({
        id: 'local',
        baseUrl: `${server.url}/v1`,
        model: 'qwen',
        contextTokens: 131072,
      })
      await expect(provider.complete(request)).resolves.toEqual({
        text: '{"findings":[]}',
        model: 'qwen-1',
        usage: { inputTokens: 12, outputTokens: 8 },
        reasoning: true,
      })
      expect(JSON.parse(seen)).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      })
    } finally {
      await server.close()
    }
  })

  it('ends a stream at once when its attempt is aborted mid-body, and the server sees the connection close', async () => {
    let closed = (): void => {}
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const server = await fakeServer(async (incoming, response) => {
      for await (const _part of incoming) { /* the request body is read to its end */ }
      response.on('close', closed)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(sse([
        {
          data: chunk({ content: '{"kee' }),
        },
      ]))
      // The body never ends: only the abort can.
      await new Promise<void>(() => {})
    })
    try {
      const provider = openaiCompatible({
        id: 'local',
        baseUrl: `${server.url}/v1`,
        model: 'qwen',
        contextTokens: 131072,
      })
      const controller = new AbortController()
      const aborted = provider.complete({
        ...request,
        signal: controller.signal,
        onProgress: (signal) => {
          if (signal.kind === 'data') controller.abort()
        },
      })
      await expect(aborted).rejects.toMatchObject({ kind: 'aborted', message: 'local: request aborted' })
      await connectionClosed
    } finally {
      await server.close()
    }
  })
})
