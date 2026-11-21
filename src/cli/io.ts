/**
 * What every subcommand of the CLI shares: the I/O it runs with, the exit codes of a review, how a
 * failure is written and the strict flag parser. `main.ts` and `bench.ts` both import it, so neither
 * imports the other.
 */

import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import type { Env } from '../config/env.ts'
import { WriteFailure } from '../bench/run-dir.ts'
import { ConfigError, OutputError, ProviderDownError, ProviderError } from '../core/errors.ts'
import { inertLine } from '../core/sanitize.ts'
import { GitError } from '../git/run.ts'
import type { ReportView } from '../report/view.ts'
import type { GitSeam } from '../sources/read.ts'

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
  /** Where the report goes; `isTTY` is `true` on a terminal and absent on a pipe and a file, which is how the CLI chooses its format and its color. */
  stdout: { write: (text: string) => unknown, readonly isTTY?: boolean }
  stderr: { write: (text: string) => unknown }
  /** The review's signal: once it is aborted, a run that ends without a result exits 130. */
  readonly signal?: AbortSignal
  /** The git a source runs, for the specs: its executable and its spawn. A run looks git up on `PATH` when unset. */
  readonly git?: GitSeam
  /** The platform the git sources check, `process.platform` when unset: for the specs. */
  readonly platform?: NodeJS.Platform
}

/**
 * The `Error:` lines of a failure, each inert: a ConfigError's issues one per line, as its message
 * lists them, and any other failure's message on one line, so a line break in a file name or in text
 * a server sent cannot start a line of its own.
 *
 * Four failures hold text from outside quorum: an `OutputError` quotes the first 200 characters of a model's
 * reply, a `ProviderError` quotes what its server sent and can name its origin, a `ProviderDownError` carries
 * the last such error as its cause, and a `GitError` quotes what git printed. A `ProviderDownError` is written
 * as its message, which holds code words, numbers and the provider's id alone, then the cause's message on a
 * line of its own, the server's own words. Under the public view, whose log a stranger may read, the others
 * are written in fixed words instead, after `Error: `: `<stage> reply unusable: <reason>` (the reason is
 * quorum's), `<provider>: the call failed (<kind>[ <status>])`, `git <operation> failed[ (exit <code>)]`, and
 * `the review failed` for any other, and a `ProviderDownError` in its message alone. A
 * `ConfigError` is written as the full view writes it: it holds config paths and words quorum wrote, and a
 * `WriteFailure` too: its message names a file's label and an error code, never a path.
 */
export function errorLines(error: unknown, view: ReportView = 'full'): string {
  const lines = error instanceof ConfigError || error instanceof WriteFailure || view === 'full'
    ? fullLines(error)
    : [
        publicMessage(error),
      ]
  return lines.map((line, index) => inertLine(index === 0
    ? `Error: ${line}`
    : line)).join('\n')
}

function fullLines(error: unknown): string[] {
  if (error instanceof ConfigError) return error.message.split('\n')
  if (error instanceof ProviderDownError && error.cause !== undefined) {
    return [
      error.message,
      errorMessage(error.cause),
    ]
  }
  return [
    errorMessage(error),
  ]
}

/** A failure other than a `ConfigError` or a `WriteFailure` in the fixed words of the public view. */
function publicMessage(error: unknown): string {
  if (error instanceof ProviderDownError) return error.message
  if (error instanceof OutputError) return `${error.stage} reply unusable: ${error.reason}`
  if (error instanceof ProviderError) {
    return `${error.providerId}: the call failed (${error.kind}${error.status === undefined
      ? ''
      : ` ${error.status}`})`
  }
  if (error instanceof GitError) {
    return `git ${error.operation} failed${error.exitCode === null
      ? ''
      : ` (exit ${error.exitCode})`}`
  }
  return 'the review failed'
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
