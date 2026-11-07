import { readFile } from 'node:fs/promises'
import { ConfigError } from '../core/errors.ts'
import { providersFromEnv, roleSettings } from '../legacy.ts'
import type { Env } from '../legacy.ts'
import { review } from '../pipeline.ts'
import { originOf } from '../providers/http.ts'

/** Exit codes (ADR-0008, amended by ADR-0012). */
export const EXIT = { ok: 0, finding: 1, usage: 2, runtime: 3, incomplete: 4 } as const

export interface CliIO {
  /** Arguments after the executable and script, e.g. `process.argv.slice(2)`. */
  argv: readonly string[]
  /** Environment variables, e.g. `process.env`. */
  env: Env
  stdin: AsyncIterable<Uint8Array | string> & { isTTY?: boolean }
  stdout: { write: (text: string) => unknown }
  stderr: { write: (text: string) => unknown }
}

const USAGE = 'Usage: quorum <diff-file>\n       git diff | quorum\n'

/**
 * Run one review and return the process exit code. Never throws: usage and configuration problems
 * exit 2, runtime failures exit 3, and an incomplete review (a finding its failed votes left
 * undecided, or a research gap) exits 4 unless a `high` finding was kept, so CI can tell a broken
 * run and a partial review from a real finding (exit 1) and from a clean one (exit 0).
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
    const providers = providersFromEnv(io.env)
    const research = roleSettings('RESEARCH', io.env)
    const voter = roleSettings('VOTER', io.env)
    io.stderr.write(`Research (${research.model} @ ${originOf(research.baseUrl)})...\n`)
    io.stderr.write(`Panel will use ${voter.model} @ ${originOf(voter.baseUrl)}\n`)
    const result = await review(diff, providers, message => io.stderr.write(`${message}\n`))
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.kept.some(verdict => verdict.confidence === 'high')) return EXIT.finding
    return result.unreviewed.length > 0 || result.meta.incomplete.length > 0 ? EXIT.incomplete : EXIT.ok
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
