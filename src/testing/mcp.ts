/** Test helpers for the MCP server: a client that speaks each protocol era, the launch of a server on a fake model, and the CLI's I/O over streams. */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, LATEST_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'
import type { InMemoryTransport, JSONRPCMessage } from '@modelcontextprotocol/server'
import type { CliIO } from '../cli/io.ts'
import { checkCodeValue } from '../config/load.ts'
import { resolveConfig } from '../config/resolve.ts'
import { configInputSchema } from '../config/schema.ts'
import type { ConfigInput } from '../config/schema.ts'
import type { McpLaunch } from '../mcp/tool.ts'
import type { GitSeam } from '../sources/read.ts'
import { fakeProvider } from './bench.ts'
import type { FakeModel } from './bench.ts'
import { fakeClock } from './clock.ts'
import { fakeGit } from './git.ts'
import type { GitCall, GitReply } from './git.ts'

/** The commits and the change a fake repository holds: HEAD, `main`, the merge base, and one added line a finding can cite. */
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const MERGE = 'c'.repeat(40)
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'
export const CHANGE_FINDING = {
  file: 'a.js',
  line: 1,
  category: 'CWE-78',
  quote: 'exec(cmd)',
  summary: 'command injection',
}

/** The revision a `modern` client claims in the envelope of each message: the first of the 2026 era. */
const MODERN_REVISION = '2026-07-28'

/** One response of the server, by the id of the request it answers. */
export interface Reply {
  readonly id: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number, readonly message: string }
}

/** One notification of the server. */
export interface Notice {
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** A client of the server over one end of an in-memory pair. */
export interface ScriptedClient {
  /** What the server said of itself in the opening: `initialize`'s result for `legacy`, `server/discover`'s for `modern`. */
  readonly opening: Record<string, unknown>
  /** Sends a request and resolves with the response to its id. */
  readonly request: (method: string, params?: Record<string, unknown>) => Promise<Reply>
  /** Sends a notification. */
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<void>
  /** The id of the request sent last. */
  readonly lastId: () => number
  /** Every notification the server sent, in order. */
  readonly notifications: Notice[]
  /** Every response the server sent, in order. */
  readonly replies: Reply[]
  /** Closes the client's end, and with it the server's. */
  readonly close: () => Promise<void>
}

/**
 * A client on `transport`, the other end of the one a server is served on, that has done its era's opening:
 * `legacy` sends `initialize`, at the SDK's latest 2025 protocol version, then `notifications/initialized`;
 * `modern` sends `server/discover`, and puts the envelope of the 2026 revision in the `_meta` of every message
 * it sends: the protocol version, its capabilities and its name. A `_meta` the caller gives is kept beside it.
 */
export async function scriptedClient(transport: InMemoryTransport, era: 'legacy' | 'modern'): Promise<ScriptedClient> {
  let sent = 0
  const waiting = new Map<number, (reply: Reply) => void>()
  const notifications: Notice[] = []
  const replies: Reply[] = []
  transport.onmessage = (message) => {
    const received = message as unknown as Record<string, unknown>
    if (typeof received.id === 'number' && ('result' in received || 'error' in received)) {
      const reply = received as unknown as Reply
      replies.push(reply)
      waiting.get(reply.id)?.(reply)
      waiting.delete(reply.id)
    } else if (typeof received.method === 'string' && !('id' in received)) {
      notifications.push(received as unknown as Notice)
    }
  }
  await transport.start()

  const paramsOf = (params: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (era === 'legacy') return params
    return {
      ...params,
      _meta: {
        ...params?._meta as Record<string, unknown> | undefined,
        [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
        [CLIENT_CAPABILITIES_META_KEY]: {},
        [CLIENT_INFO_META_KEY]: { name: 'scripted', version: '0.0.0' },
      },
    }
  }
  const send = async (method: string, params?: Record<string, unknown>): Promise<void> => {
    await transport.send({
      jsonrpc: '2.0',
      method,
      params: paramsOf(params),
    } as JSONRPCMessage)
  }
  const request = (method: string, params?: Record<string, unknown>): Promise<Reply> => new Promise((resolve, reject) => {
    sent += 1
    waiting.set(sent, resolve)
    transport.send({
      jsonrpc: '2.0',
      id: sent,
      method,
      params: paramsOf(params),
    } as JSONRPCMessage).catch(reject)
  })
  const client = {
    request,
    send,
    lastId: () => sent,
    notifications,
    replies,
    close: async () => {
      waiting.clear()
      await transport.close()
    },
  }
  if (era === 'legacy') {
    const { result } = await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'scripted', version: '0.0.0' },
    })
    await send('notifications/initialized')
    return { ...client, opening: result ?? {} }
  }
  const { result } = await request('server/discover')
  return { ...client, opening: result ?? {} }
}

/** The temporary roots `launchFor` made, for `removeRoots`. */
const roots: string[] = []

/** Removes every temporary root `launchFor` made: call it after each test. */
export function removeRoots(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** The checked input and the resolved config of `input`, as a launch holds them: the input as a code config is checked, the config as the environment `env` resolves it. */
export function launchConfig(input: ConfigInput, env: Record<string, string> = {}): Pick<McpLaunch, 'input' | 'config'> {
  const checked = checkCodeValue(configInputSchema, () => input, { notAnObject: 'must be an object', threw: 'could not be read' })
  return {
    input: checked,
    config: resolveConfig(checked, { env }),
  }
}

/**
 * A launch of the server on one fake provider, `fakeProvider(fake)`, that every profile uses: a temporary root
 * (a real path, removed by `removeRoots`), no environment, no `--send`, no gate lifted, this platform and a fake
 * clock. `fields` replace any of it.
 */
export function launchFor(fake: FakeModel = {}, fields: Partial<McpLaunch> = {}): McpLaunch {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-mcp-')))
  roots.push(root)
  return {
    root,
    ...launchConfig({
      providers: {
        fake: fakeProvider(fake),
      },
    }),
    env: {},
    platform: process.platform,
    large: false,
    trustRepoConfig: false,
    send: [],
    clock: fakeClock(),
    ...fields,
  }
}

/**
 * The I/O of `quorum mcp` over streams: `input` is stdin, which the test writes the client's messages to, and
 * what the server writes to stdout is read back as `lines()`, one entry for each line. `stderr()` is the log.
 * The working directory is the process's unless `cwd` is given, the environment empty unless `env` is.
 */
export function streamIO(options: { readonly cwd?: string, readonly env?: Record<string, string>, readonly git?: GitSeam } = {}): { io: CliIO, input: PassThrough, lines: () => string[], stderr: () => string } {
  const input = new PassThrough()
  const output = new PassThrough()
  const written: string[] = []
  const logged: string[] = []
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => written.push(chunk))
  const io: CliIO = {
    argv: [],
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? {},
    stdin: input,
    stdout: output,
    stderr: {
      write: text => logged.push(text),
    },
    git: options.git,
  }
  return {
    io,
    input,
    lines: () => written.join('').split('\n').filter(line => line !== ''),
    stderr: () => logged.join(''),
  }
}

/** What the fake git says of the repository a root is in. */
export interface Repository {
  /** The files at HEAD, by path, for a review of paths. */
  readonly tree?: Readonly<Record<string, string>>
  /** The untracked files `git ls-files` lists. */
  readonly untracked?: readonly string[]
  /** Whether the repository's own config names a filter program. */
  readonly filter?: boolean
  /** The revisions that name no commit. */
  readonly missing?: readonly string[]
  /** The reply to `git diff`, the working tree's or the range's. */
  readonly diff?: GitReply
  /** The top level, the root's by default, and the root's place under it. */
  readonly top?: string
  readonly prefix?: string
}

/** A fake git for every source: HEAD is `HEAD`, `main` is `BASE`, and the changes are `DIFF`. */
export function fakeRepository(root: string, options: Repository = {}): { readonly seam: NonNullable<McpLaunch['git']>, readonly calls: GitCall[] } {
  const entries = Object.entries(options.tree ?? {}).map(([path, content], index) => ({
    path,
    content,
    id: String(index + 1).repeat(40),
  }))
  const fake = fakeGit(({ command, stdin }) => {
    if (command[0] === 'config') {
      return options.filter === true
        ? { stdout: 'local\0filter.evil.clean\n/bin/evil\0' }
        : { code: 1 }
    }
    if (command[0] === 'rev-parse' && command[1] === '--verify') {
      const revision = (command[4] ?? '').replace('^{commit}', '')
      if (options.missing?.includes(revision)) return { code: 1 }
      return { stdout: `${revision === 'main'
        ? BASE
        : HEAD}\n` }
    }
    if (command[0] === 'hash-object') return { stdout: `${EMPTY_TREE}\n` }
    if (command[0] === 'merge-base') return { stdout: `${MERGE}\n` }
    if (command[1] === 'diff') return options.diff ?? { stdout: DIFF }
    if (command[0] === 'ls-files') {
      return {
        stdout: (options.untracked ?? []).map(name => `${name}\0`).join(''),
      }
    }
    if (command[0] === 'ls-tree') {
      return {
        stdout: entries.map(({ path, content, id }) => `100644 blob ${id} ${String(content.length).padStart(7)}\t${path}\0`).join(''),
      }
    }
    if (command[0] === 'cat-file') {
      return {
        stdout: stdin.split('\n').filter(id => id !== '').map((id) => {
          const content = entries.find(entry => entry.id === id)?.content ?? ''
          return `${id} blob ${content.length}\n${content}\n`
        }).join(''),
      }
    }
    return undefined
  }, { top: options.top ?? root, prefix: options.prefix })
  return {
    seam: { executable: '/usr/bin/git', spawn: fake.spawn },
    calls: fake.calls,
  }
}
