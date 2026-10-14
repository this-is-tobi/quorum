import { readFile } from 'node:fs/promises'
import { roleConfig } from '../client.ts'
import { ConfigError } from '../core/errors.ts'
import { runQuorum } from '../pipeline.ts'

/** Exit codes (ADR-0008). */
export const EXIT = { ok: 0, finding: 1, usage: 2, runtime: 3 } as const

export interface CliIO {
  /** Arguments after the executable and script, e.g. `process.argv.slice(2)`. */
  argv: readonly string[]
  stdin: AsyncIterable<Uint8Array | string> & { isTTY?: boolean }
  stdout: { write: (text: string) => unknown }
  stderr: { write: (text: string) => unknown }
}

const USAGE = 'Usage: quorum <diff-file>\n       git diff | quorum\n'

/**
 * Run one review and return the process exit code. Never throws: usage and configuration problems
 * exit 2, runtime failures exit 3, so CI can tell a broken run from a real finding (exit 1).
 */
export async function runCli(io: CliIO): Promise<number> {
  let diff: string
  try {
    diff = await readDiff(io)
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n${USAGE}`)
    return EXIT.usage
  }

  try {
    const research = roleConfig('RESEARCH')
    const voter = roleConfig('VOTER')
    io.stderr.write(`Research (${research.model} @ ${research.baseUrl})...\n`)
    io.stderr.write(`Panel will use ${voter.model} @ ${voter.baseUrl}\n`)
    const result = await runQuorum(diff, message => io.stderr.write(`${message}\n`))
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.kept.some(verdict => verdict.confidence === 'high') ? EXIT.finding : EXIT.ok
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`)
    return error instanceof ConfigError ? EXIT.usage : EXIT.runtime
  }
}

/** Read the diff from the file argument, or from stdin unless stdin is an interactive terminal. */
async function readDiff(io: CliIO): Promise<string> {
  const [path, ...extra] = io.argv
  if (extra.length > 0) throw new Error(`unexpected arguments: ${extra.join(' ')}`)
  if (path) return readFile(path, 'utf8')
  if (io.stdin.isTTY) throw new Error('no diff given')
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of io.stdin) {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
