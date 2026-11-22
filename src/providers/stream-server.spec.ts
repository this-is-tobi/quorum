import { describe, expect, it } from 'vitest'
import type { CompletionRequest, Provider } from '../core/ports.ts'
import { fakeServer } from '../testing/server.ts'
import { sse } from '../testing/streams.ts'
import { anthropic } from './anthropic.ts'
import { gemini } from './gemini.ts'
import { ollama } from './ollama.ts'
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

/** What each other adapter's server writes for the reply `{"findings":[]}`, after thinking in text with an accent and an emoji, and the request it expects. */
const THINKING = 'Thinking: café \u{1F600}'
const OTHER_ADAPTERS: ReadonlyArray<[
  string,
  (baseUrl: string) => Provider,
  { type: string, path: string, body: string, sent: object },
  { model: string, usage: { inputTokens: number, outputTokens: number } },
]> = [
  [
    'anthropic',
    baseUrl => anthropic({
      id: 'claude',
      baseUrl,
      model: 'claude-opus-5-5',
      contextTokens: 131072,
    }),
    {
      type: 'text/event-stream; charset=utf-8',
      path: '/v1/messages',
      body: sse([
        {
          type: 'message_start',
          message: {
            model: 'claude-opus-5-5',
            content: [],
            usage: { input_tokens: 12, output_tokens: 1 },
          },
        },
        { type: 'ping' },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: THINKING },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: '{"findings"' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: ':[]}' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 8 },
        },
        { type: 'message_stop' },
      ].map(data => ({ event: data.type, data }))),
      sent: { stream: true },
    },
    {
      model: 'claude-opus-5-5',
      usage: { inputTokens: 12, outputTokens: 8 },
    },
  ],
  [
    'gemini',
    baseUrl => gemini({
      id: 'gemini',
      baseUrl,
      model: 'gemini-3.8-flash',
      contextTokens: 131072,
    }),
    {
      type: 'text/event-stream',
      path: '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
      body: sse([
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: THINKING, thought: true },
                ],
                role: 'model',
              },
            },
          ],
          modelVersion: 'gemini-3.8-flash',
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: '{"findings"' },
                ],
                role: 'model',
              },
            },
          ],
          modelVersion: 'gemini-3.8-flash',
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: ':[]}' },
                ],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 4 },
          modelVersion: 'gemini-3.8-flash',
        },
      ].map(data => ({ data }))),
      sent: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'data' },
            ],
          },
        ],
      },
    },
    {
      model: 'gemini-3.8-flash',
      usage: { inputTokens: 12, outputTokens: 8 },
    },
  ],
  [
    'ollama',
    baseUrl => ollama({
      id: 'local',
      baseUrl,
      model: 'qwen3.6:27b',
      contextTokens: 131072,
    }),
    {
      type: 'application/x-ndjson',
      path: '/api/chat',
      body: [
        {
          model: 'qwen3.6:27b',
          message: { role: 'assistant', content: '', thinking: THINKING },
          done: false,
        },
        '',
        {
          model: 'qwen3.6:27b',
          message: { role: 'assistant', content: '{"findings"' },
          done: false,
        },
        {
          model: 'qwen3.6:27b',
          message: { role: 'assistant', content: ':[]}' },
          done: false,
        },
        {
          model: 'qwen3.6:27b',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 12,
          eval_count: 8,
        },
      ].map(line => `${typeof line === 'string'
        ? line
        : JSON.stringify(line)}\n`).join(''),
      sent: { stream: true },
    },
    {
      model: 'qwen3.6:27b',
      usage: { inputTokens: 12, outputTokens: 8 },
    },
  ],
]

describe('the other adapters against a server on the loopback', () => {
  it.each(OTHER_ADAPTERS)('streams a %s reply from a server one byte at a time', async (_protocol, make, served, expected) => {
    let seen = ''
    let path = ''
    const server = await fakeServer(async (incoming, response) => {
      path = incoming.url ?? ''
      for await (const part of incoming) seen += String(part)
      response.writeHead(200, { 'content-type': served.type, 'cache-control': 'no-cache' })
      await writeByByte(response, served.body)
      response.end()
    })
    try {
      await expect(make(server.url).complete(request)).resolves.toEqual({
        text: '{"findings":[]}',
        reasoning: true,
        ...expected,
      })
      expect(path).toBe(served.path)
      expect(JSON.parse(seen)).toMatchObject(served.sent)
    } finally {
      await server.close()
    }
  })
})
