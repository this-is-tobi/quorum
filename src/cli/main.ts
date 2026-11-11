import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Env } from '../config/env.ts'
import { fromConfig } from '../config/from-config.ts'
import { loadConfig } from '../config/load.ts'
import { ConfigError } from '../core/errors.ts'
import { inertJson, inertLine } from '../core/sanitize.ts'
import type { QuorumResult } from '../core/types.ts'
import { bannerLines, progressSink } from './render.ts'

/** Exit codes (ADR-0008, amended by ADR-0012). */
export const EXIT = { ok: 0, finding: 1, usage: 2, runtime: 3, incomplete: 4 } as const

export interface CliIO {
  /** Arguments after the executable and script, e.g. `process.argv.slice(2)`. */
  argv: readonly string[]
  /** The directory a relative diff path and a relative `QUORUM_CONFIG` resolve against, e.g. `process.cwd()`. */
  readonly cwd: string
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
 * undecided, or a research gap) exits 4 unless a `high` finding was kept by a gating profile, so CI
 * can tell a broken run and a partial review from a real finding (exit 1) and from a clean one
 * (exit 0). `exitCodeFor` maps the result; advisory flags never change it.
 *
 * Its settings are the config file `QUORUM_CONFIG` names, resolved against `io.cwd`, and the `QUORUM_*`
 * variables of `io.env` with their deprecated aliases. Each warning is printed once, before the banner.
 *
 * Everything the CLI writes is inert (invariant I3): each stderr line passes through `inertLine`, and
 * the JSON result through `inertJson`.
 */
export async function runCli(io: CliIO): Promise<number> {
  let diff: string
  try {
    diff = await readDiff(io)
  } catch (error) {
    io.stderr.write(`${errorLines(error)}\n${USAGE}`)
    return EXIT.usage
  }

  try {
    const { config } = await loadConfig({ cwd: io.cwd, env: io.env })
    const quorum = await fromConfig(config, { env: io.env, events: progressSink(line => io.stderr.write(`${line}\n`)) })
    for (const warning of quorum.warnings) io.stderr.write(`${inertLine(`warning: ${warning}`)}\n`)
    for (const line of bannerLines(config)) io.stderr.write(`${line}\n`)
    if (diff.trim() === '') io.stderr.write('empty diff: nothing to review\n')
    const result = await quorum.review({ diff })
    io.stdout.write(`${inertJson(result)}\n`)
    return exitCodeFor(result)
  } catch (error) {
    io.stderr.write(`${errorLines(error)}\n`)
    return error instanceof ConfigError ? EXIT.usage : EXIT.runtime
  }
}

/**
 * The exit code of a finished review: 1 when a kept finding is `high` and its profile gates, 4 when
 * the review is incomplete, 0 otherwise. A profile missing from `meta.profiles` counts as gating,
 * so a gap in the result never hides a finding.
 */
export function exitCodeFor(result: QuorumResult): number {
  const gates = (profile: string): boolean => Object.hasOwn(result.meta.profiles, profile) ? result.meta.profiles[profile].gating !== false : true
  if (result.kept.some(verdict => verdict.confidence === 'high' && gates(verdict.profile))) return EXIT.finding
  return result.unreviewed.length > 0 || result.meta.incomplete.length > 0 ? EXIT.incomplete : EXIT.ok
}

/** Read the diff from the file argument, or from stdin unless stdin is an interactive terminal. */
async function readDiff(io: CliIO): Promise<string> {
  const [path, ...extra] = io.argv
  if (extra.length > 0) throw new Error(`unexpected arguments: ${extra.join(' ')}`)
  if (path) return readFile(resolve(io.cwd, path), 'utf8')
  if (io.stdin.isTTY) throw new Error('no diff given')
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of io.stdin) {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * The `Error:` lines of a failure, each inert: a ConfigError's issues one per line, as its message
 * lists them, and any other failure's message on one line, so a line break in a file name or in text
 * a server sent cannot start a line of its own.
 */
function errorLines(error: unknown): string {
  const lines = error instanceof ConfigError ? error.message.split('\n') : [errorMessage(error)]
  return lines.map((line, index) => inertLine(index === 0 ? `Error: ${line}` : line)).join('\n')
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
