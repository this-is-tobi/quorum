/**
 * What every subcommand of the CLI shares: the I/O it runs with, the exit codes of a review, how a
 * failure is written and the strict flag parser. `main.ts` and `bench.ts` both import it, so neither
 * imports the other.
 */

import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import type { Env } from '../config/env.ts'
import { ConfigError } from '../core/errors.ts'
import { inertLine } from '../core/sanitize.ts'

/** Exit codes (ADR-0008, amended by ADR-0012). */
export const EXIT = {
  ok: 0,
  finding: 1,
  usage: 2,
  runtime: 3,
  incomplete: 4,
  interrupted: 130,
} as const

export interface CliIO {
  /** Arguments after the executable and script, e.g. `process.argv.slice(2)`. */
  argv: readonly string[]
  /** The directory a relative diff path and a relative `--config` resolve against, e.g. `process.cwd()`. */
  readonly cwd: string
  /** Environment variables, e.g. `process.env`. */
  env: Env
  stdin: AsyncIterable<Uint8Array | string> & { isTTY?: boolean }
  stdout: { write: (text: string) => unknown }
  stderr: { write: (text: string) => unknown }
  /** The review's signal: once it is aborted, a run that ends without a result exits 130. */
  readonly signal?: AbortSignal
}

/**
 * The `Error:` lines of a failure, each inert: a ConfigError's issues one per line, as its message
 * lists them, and any other failure's message on one line, so a line break in a file name or in text
 * a server sent cannot start a line of its own.
 */
export function errorLines(error: unknown): string {
  const lines = error instanceof ConfigError
    ? error.message.split('\n')
    : [
        errorMessage(error),
      ]
  return lines.map((line, index) => inertLine(index === 0
    ? `Error: ${line}`
    : line)).join('\n')
}

/**
 * The text of a failure, for any value a promise can reject with: an `Error`'s message, else the
 * value's text form, else a fixed text when even that throws, as it does for an object without a
 * prototype. It never throws, so neither do the lines built from it.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'an error with no text form'
  }
}

/** The flags of `argv` under `options`, and its positional arguments; a usage error of `parseArgs` is raised as a `ConfigError`, one issue per line of its message. */
export function parseFlags<T extends ParseArgsOptionsConfig>(argv: readonly string[], options: T) {
  try {
    return parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    if (!(error instanceof Error) || !(error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS_')) throw error
    throw new ConfigError(error.message.split('\n').map(message => ({ path: '', message })))
  }
}
