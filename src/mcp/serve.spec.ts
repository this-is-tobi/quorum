import { PassThrough } from 'node:stream'
import { InMemoryTransport, SERVER_INFO_META_KEY } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VERSION } from '../core/version.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { fakeProvider } from '../testing/bench.ts'
import { fakeClock } from '../testing/clock.ts'
import type { FakeClock } from '../testing/clock.ts'
import type { FakeModel } from '../testing/bench.ts'
import { CHANGE_FINDING, fakeRepository, launchConfig, launchFor, removeRoots, scriptedClient } from '../testing/mcp.ts'
import type { ScriptedClient } from '../testing/mcp.ts'
import { agentResultSchema } from './result.ts'
import { serveMcp } from './serve.ts'
import { TOOL_ANNOTATIONS, TOOL_DESCRIPTION } from './tool.ts'
import type { McpLaunch } from './tool.ts'

/** Every server, client and signal the test opened, closed after it. */
const open: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
  removeRoots()
})

/** A promise and its resolver. */
function deferred(): { readonly promise: Promise<void>, readonly resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface Served {
  readonly client: ScriptedClient
  /** What `serveMcp` resolves to, once it does. */
  readonly done: Promise<number>
  readonly clock: FakeClock
  readonly logged: () => string
  readonly requests: CompletionRequest[]
  readonly abort: () => void
}

/** `serveMcp` over one end of an in-memory pair on a fake model and a fake git, and a client of `era` on the other. */
async function serving(era: 'legacy' | 'modern', options: { readonly fake?: FakeModel, readonly fields?: Partial<McpLaunch> } = {}): Promise<Served> {
  const [serverEnd, clientEnd] = InMemoryTransport.createLinkedPair()
  const requests: CompletionRequest[] = []
  const fake: FakeModel = {
    ...options.fake,
    onCall: (request) => {
      requests.push(request)
      options.fake?.onCall?.(request)
    },
  }
  const clock = fakeClock()
  const base = launchFor(fake, { clock, ...options.fields })
  const launch: McpLaunch = { ...base, git: fakeRepository(base.root).seam }
  const controller = new AbortController()
  const logged: string[] = []
  const done = serveMcp(launch, {
    input: new PassThrough(),
    output: new PassThrough(),
    stderr: {
      write: text => logged.push(text),
    },
    signal: controller.signal,
    transport: serverEnd,
  })
  const client = await scriptedClient(clientEnd, era)
  open.push(async () => {
    controller.abort()
    await client.close()
    await done
  })
  return {
    client,
    done,
    clock,
    logged: () => logged.join(''),
    requests,
    abort: () => controller.abort(),
  }
}

/** A `tools/call` of the review tool, its response resolved. */
function review(client: ScriptedClient, args: Record<string, unknown>, meta?: Record<string, unknown>): ReturnType<ScriptedClient['request']> {
  return client.request('tools/call', {
    name: 'review',
    arguments: args,
    ...meta === undefined
      ? {}
      : { _meta: meta },
  })
}

/** The text of the one block of an error result. */
const textOf = (result: Record<string, unknown> | undefined): string => (result?.content as Array<{ text: string }>)[0].text

describe('serveMcp', () => {
  it('lists one tool, review, with a constant description, schema and annotations, whatever the config', async () => {
    const plain = await serving('legacy')
    const other = await serving('legacy', {
      fields: launchConfig({
        providers: {
          another: fakeProvider({ model: 'x' }),
        },
        profiles: {
          security: {},
          team: { extends: 'security' },
        },
        maxReviewTokens: 5000,
      }),
    })
    const first = (await plain.client.request('tools/list')).result as { tools: Array<Record<string, unknown>> }
    const second = (await other.client.request('tools/list')).result as { tools: Array<Record<string, unknown>> }
    expect(second).toEqual(first)

    expect(first.tools).toHaveLength(1)
    const [tool] = first.tools as Array<{ name: string, title: string, description: string, annotations: unknown, inputSchema: Record<string, unknown>, outputSchema?: unknown }>
    expect(tool.name).toBe('review')
    expect(tool.title).toBe('Review a change with quorum')
    expect(tool.description).toBe(TOOL_DESCRIPTION)
    expect(tool.annotations).toEqual(TOOL_ANNOTATIONS)
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual([
      'source',
      'range',
      'paths',
      'at',
      'profiles',
    ])
    expect(tool.inputSchema.required).toEqual(['source'])
    expect(tool.inputSchema.additionalProperties).toBe(false)
    expect((tool.inputSchema.properties as { paths: { maxItems: number } }).paths.maxItems).toBe(100)
    expect(tool.outputSchema).toBeDefined()
    // The SDK sets the key and the in-memory transport hands the object over unserialized: the key is there, and holds nothing.
    expect('_meta' in tool).toBe(true)
    expect((tool as { _meta?: unknown })._meta).toBeUndefined()
  })

  it.each(['legacy', 'modern'] as const)('serves a %s client: its opening, the tool list and a review\'s result', async (era) => {
    const { client } = await serving(era, {
      fake: {
        findings: [CHANGE_FINDING],
      },
    })
    const opening = client.opening as { serverInfo?: unknown, capabilities?: Record<string, unknown>, _meta?: Record<string, unknown> }
    expect(era === 'legacy'
      ? opening.serverInfo
      : opening._meta?.[SERVER_INFO_META_KEY]).toEqual({ name: 'quorum', version: VERSION })
    expect(Object.keys(opening.capabilities ?? {})).toEqual(['tools'])
    expect(Object.keys(opening)).not.toContain('instructions')

    const tools = (await client.request('tools/list')).result as { tools: Array<{ name: string }> }
    expect(tools.tools.map(({ name }) => name)).toEqual(['review'])

    const { result } = await review(client, { source: 'local' })
    expect(result?.isError).toBeUndefined()
    const parsed = agentResultSchema.safeParse(result?.structuredContent)
    expect(parsed.success).toBe(true)
    expect(result?.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify(result?.structuredContent),
      },
    ])
    expect(parsed.data?.findings).toMatchObject([
      { file: 'a.js', line: 1 },
    ])
  })

  it('sends progress only to a call that asked for it, its progress rising', async () => {
    const { client, clock } = await serving('legacy', {
      fake: {
        findings: [CHANGE_FINDING],
      },
    })
    await review(client, { source: 'local' })
    expect(client.notifications.filter(({ method }) => method === 'notifications/progress')).toEqual([])

    await review(client, { source: 'local' }, { progressToken: 'tok-1' })
    const notes = client.notifications.filter(({ method }) => method === 'notifications/progress').map(({ params }) => params as { progressToken: string, progress: number, message: string })
    expect(notes.length).toBeGreaterThan(2)
    expect(notes.every(({ progressToken }) => progressToken === 'tok-1')).toBe(true)
    expect(notes.map(({ progress }) => progress)).toEqual(notes.map((_, index) => index + 1))
    expect(notes[0].message).toBe('reading the change')
    expect(notes.map(({ message }) => message)).toContain('research: 1 part done')
    expect(notes.at(-1)?.message).toBe('panel: 1 finding decided')
    // The call is over: its heartbeat is gone with it.
    expect(clock.pending()).toBe(0)
  })

  it('has Claude Code ask before every call under --require-approval, and only then', async () => {
    const asking = await serving('legacy', {
      fields: { requireApproval: true },
    })
    const plain = await serving('legacy')
    const [asked] = ((await asking.client.request('tools/list')).result as { tools: Array<{ _meta?: unknown }> }).tools
    const [unasked] = ((await plain.client.request('tools/list')).result as { tools: Array<{ _meta?: unknown }> }).tools
    expect(asked._meta).toEqual({ 'anthropic/requiresUserInteraction': true })
    expect(unasked._meta).toBeUndefined()
  })

  it('leaves each finding\'s category and summary out under --code-fields-only', async () => {
    const whole = await serving('legacy', {
      fake: {
        findings: [CHANGE_FINDING],
      },
    })
    const bare = await serving('legacy', {
      fake: {
        findings: [CHANGE_FINDING],
      },
      fields: { codeFieldsOnly: true },
    })
    const full = (await review(whole.client, { source: 'local' })).result
    const narrowed = (await review(bare.client, { source: 'local' })).result
    expect(Object.keys((full?.structuredContent as { findings: Array<object> }).findings[0])).toContain('summary')

    expect(narrowed?.isError).toBeUndefined()
    expect(agentResultSchema.safeParse(narrowed?.structuredContent).success).toBe(true)
    const [finding] = (narrowed?.structuredContent as { findings: Array<Record<string, unknown>> }).findings
    expect(finding).toMatchObject({ file: 'a.js', line: 1 })
    expect(Object.keys(finding)).not.toContain('category')
    expect(Object.keys(finding)).not.toContain('summary')
    expect(textOf(narrowed)).toBe(JSON.stringify(narrowed?.structuredContent))
    expect(textOf(narrowed)).not.toMatch(/CWE-78|command injection/)
  })

  it('aborts the review when the client cancels the call, and never answers it', async () => {
    const started = deferred()
    const gate = deferred()
    let signal: AbortSignal | undefined
    const { client, logged } = await serving('legacy', {
      fake: {
        gate: gate.promise,
        onCall: (request) => {
          signal = request.signal
          started.resolve()
        },
      },
    })
    void review(client, { source: 'local' })
    const id = client.lastId()
    await started.promise
    expect(signal?.aborted).toBe(false)

    await client.send('notifications/cancelled', { requestId: id, reason: 'the person pressed escape' })
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    await vi.waitFor(() => expect(logged()).toContain('quorum mcp: a review was cancelled\n'))
    // The review settles only now, so a reply that came late would come after this.
    gate.resolve()
    await vi.waitFor(() => expect(logged()).toMatch(/the session has spent \d+ of \d+ tokens\n/))
    await new Promise(done => setTimeout(done, 20))
    expect(client.replies.some(reply => reply.id === id)).toBe(false)
  })

  it.each([
    { source: 'local', large: true },
    {
      source: 'local',
      send: ['.env'],
    },
    { diff: 'X-CANARY' },
  ])('refuses %j in fixed text that holds none of it', async (args) => {
    const { client, requests } = await serving('legacy')
    const { result } = await review(client, args)
    expect(result?.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('takes only source, range, paths, at and profiles')
    for (const word of [
      'large',
      'send',
      'diff',
      '.env',
      'X-CANARY',
    ]) expect(text).not.toContain(word)
    expect(requests).toEqual([])
  })

  it('aborts a review in flight when the client closes the connection, and resolves 0', async () => {
    const started = deferred()
    let signal: AbortSignal | undefined
    const { client, done } = await serving('legacy', {
      fake: {
        gate: new Promise(() => undefined),
        onCall: (request) => {
          signal = request.signal
          started.resolve()
        },
      },
    })
    void review(client, { source: 'local' })
    await started.promise
    await client.close()
    expect(await done).toBe(0)
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  })

  it('resolves 130 when its signal aborts, stopping the review in flight', async () => {
    const started = deferred()
    let signal: AbortSignal | undefined
    const { client, done, abort } = await serving('legacy', {
      fake: {
        gate: new Promise(() => undefined),
        onCall: (request) => {
          signal = request.signal
          started.resolve()
        },
      },
    })
    void review(client, { source: 'local' })
    await started.promise
    abort()
    expect(await done).toBe(130)
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  })

  it('exits 2 before serving when a provider of the config cannot be built', async () => {
    const [serverEnd, clientEnd] = InMemoryTransport.createLinkedPair()
    open.push(async () => {
      await clientEnd.close()
    })
    // A config that was not resolved is checked when the quorum is built, and its provider refused there: the server never starts.
    const launch = launchFor({}, {
      config: {
        providers: {
          broken: {
            protocol: 'openai-compatible',
            baseUrl: 'ftp://example.invalid/v1',
            model: 'm',
            contextTokens: 131072,
          },
        },
      } as unknown as McpLaunch['config'],
    })
    const logged: string[] = []
    const code = await serveMcp(launch, {
      input: new PassThrough(),
      output: new PassThrough(),
      stderr: {
        write: text => logged.push(text),
      },
      transport: serverEnd,
    })
    expect(code).toBe(2)
    expect(logged.join('')).toMatch(/^Error: providers\.broken\.baseUrl: must be an http:\/\/ or https:\/\/ URL with a host\n/)
    expect(logged.join('')).not.toContain('serving the review tool')
  })
})
