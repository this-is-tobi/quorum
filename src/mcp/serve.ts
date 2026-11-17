/**
 * The MCP server: the one module that imports the SDK as a value, and the one the CLI loads with `import()`
 * alone, so a quorum that does not run `quorum mcp` never loads the SDK (and a binary built without it fails to
 * build, since this module imports it statically). The SDK may call the server factory twice, once for a probe a
 * 2026-era client opens with and once for the connection it settles on, so nothing lives in what the factory
 * returns: the lock, the quorum and the current call's progress live in the `ReviewSession`, outside it.
 */

import { McpServer } from '@modelcontextprotocol/server'
import type { Transport } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import type { Readable, Writable } from 'node:stream'
import { ConfigError } from '../core/errors.ts'
import { VERSION } from '../core/version.ts'
import { inertLine } from '../core/sanitize.ts'
import { errorLines, EXIT } from '../cli/io.ts'
import { agentResultSchema } from './result.ts'
import type { ProgressNote } from './progress.ts'
import { MAX_ARGUMENT_ELEMENTS, openSession, REVIEW_ARGUMENTS, reviewCall, TOOL_ANNOTATIONS, TOOL_DESCRIPTION, TOOL_NAME, TOOL_TITLE } from './tool.ts'
import type { McpLaunch, ReviewSession } from './tool.ts'

/** The most code points of the SDK's own error text the log keeps. */
const ERROR_CAP = 300

/** The key under which Claude Code asks the person before every call of the tool, even in its auto modes, and offers no "don't ask again". A client that does not read it ignores it. */
const REQUIRES_APPROVAL = { 'anthropic/requiresUserInteraction': true }

/** What `serveMcp` runs on: the streams the protocol travels on, the log, the signal that stops it, and for the specs a transport of its own. */
export interface McpIO {
  readonly input: Readable
  readonly output: Writable
  readonly stderr: { readonly write: (text: string) => unknown }
  /** Aborted by SIGINT or SIGTERM: the server closes and the run resolves 130. */
  readonly signal?: AbortSignal
  /** A transport in place of the one over `input` and `output`, for the specs. */
  readonly transport?: Transport
}

/**
 * A server of the tool `review`: the identity `{ name: 'quorum', version }`, the capability of tools alone and
 * no `instructions`, with the call's arguments bounded before any parse (`maxToolInputElements`). The handler
 * builds a progress notifier only for a call that sent a `progressToken` (a string or a number), through
 * `notifications/progress` whose failures it ignores, and hands `reviewCall` the call's signal, which the SDK
 * aborts when the client cancels the call and when the connection closes. The description, the schemas and the
 * annotations are the release's constants, whatever the config; under `--require-approval` the tool's `_meta`
 * asks Claude Code to have the person approve every call, and holds nothing otherwise. The heartbeat of the
 * progress runs on the launch's clock (`reviewCall`).
 */
export function reviewServer(session: ReviewSession): McpServer {
  const server = new McpServer({ name: 'quorum', version: VERSION }, {
    capabilities: { tools: {} },
    maxToolInputElements: MAX_ARGUMENT_ELEMENTS,
  })
  server.registerTool(TOOL_NAME, {
    title: TOOL_TITLE,
    description: TOOL_DESCRIPTION,
    inputSchema: REVIEW_ARGUMENTS,
    outputSchema: agentResultSchema,
    annotations: TOOL_ANNOTATIONS,
    _meta: session.launch.requireApproval
      ? REQUIRES_APPROVAL
      : undefined,
  }, async (args, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken
    const notify = typeof token === 'string' || typeof token === 'number'
      ? (note: ProgressNote): void => {
          ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress: note.progress, message: note.message },
          }).catch(() => undefined)
        }
      : undefined
    // Spread into a plain object, which the SDK's result type accepts where an interface's index signature is missing.
    return {
      ...await reviewCall(session, args, { signal: ctx.mcpReq.signal, notify }),
    }
  })
  return server
}

/** The first `ERROR_CAP` code points of `text`. */
function cut(text: string): string {
  return [
    ...text.slice(0, ERROR_CAP * 2),
  ].slice(0, ERROR_CAP).join('')
}

/**
 * Serve the review tool on `io` until the client ends the connection or `io.signal` aborts, and return the exit
 * code. In this order: the session (`openSession`), whose `ConfigError`, a provider of the config that cannot be
 * built, writes its lines and returns 2; the session's warnings and `quorum mcp: serving the review tool` on
 * `io.stderr`; then the SDK's `serveStdio` over `io.transport` or a `StdioServerTransport` on `io.input` and
 * `io.output`, which serves a 2025-era client and a 2026-era one from the same factory. The SDK's own errors
 * (`onerror`) go to the log, cut to 300 characters, and stdout carries protocol messages alone.
 *
 * It resolves 0 once the transport closes, which is the client closing stdin: the SDK aborts every call in
 * flight, and answers none. It resolves 130 once `io.signal` aborts, after closing the server, which aborts
 * them the same way.
 */
export async function serveMcp(launch: McpLaunch, io: McpIO): Promise<number> {
  const log = (text: string): void => {
    io.stderr.write(`${inertLine(text)}\n`)
  }
  let session: ReviewSession
  try {
    session = await openSession(launch, text => io.stderr.write(`${text}\n`))
  } catch (error) {
    io.stderr.write(`${errorLines(error)}\n`)
    return error instanceof ConfigError
      ? EXIT.usage
      : EXIT.runtime
  }
  for (const warning of session.quorum.warnings) log(`warning: ${warning}`)
  log('quorum mcp: serving the review tool')

  const transport = io.transport ?? new StdioServerTransport(io.input, io.output)
  const handle = serveStdio(() => reviewServer(session), {
    transport,
    onerror: error => log(`quorum mcp: ${cut(error.message)}`),
  })
  const code = await new Promise<number>((resolve) => {
    const closed = transport.onclose
    transport.onclose = () => {
      closed?.()
      resolve(EXIT.ok)
    }
    if (io.signal?.aborted === true) resolve(EXIT.interrupted)
    else io.signal?.addEventListener('abort', () => resolve(EXIT.interrupted), { once: true })
  })
  await handle.close()
  return code
}
