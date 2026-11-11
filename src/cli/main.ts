import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../../package.json' with { type: 'json' }
import { readEnv } from '../config/env.ts'
import type { Env } from '../config/env.ts'
import { fromConfig } from '../config/from-config.ts'
import { loadConfig } from '../config/load.ts'
import { ConfigError } from '../core/errors.ts'
import { inertJson, inertLine } from '../core/sanitize.ts'
import type { Quorum, QuorumResult } from '../core/types.ts'
import { printConfig } from './print-config.ts'
import { bannerLines, progressSink } from './render.ts'

/** Exit codes (ADR-0008, amended by ADR-0012). */
export const EXIT = { ok: 0, finding: 1, usage: 2, runtime: 3, incomplete: 4, interrupted: 130 } as const

/** The most diff the CLI reads, from stdin or a file, in bytes: a larger one is refused and reading stops there. */
export const MAX_DIFF_BYTES = 16 * 1024 * 1024

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

const USAGE = [
  'Usage: quorum [options] [diff-file]',
  '       git diff | quorum [options]',
  '',
  'Options:',
  '  -c, --config <path>     Read this config file, over QUORUM_CONFIG',
  '  -p, --profile <id>      Run only this profile; repeat it to run several',
  '      --allow-incomplete  Exit 0 instead of 4 when the review is incomplete, except for a request too large for its model',
  '      --print-config      Print the resolved config, keys redacted, and exit',
  '  -h, --help              Print this help and exit',
  '  -v, --version           Print the version and exit',
  '',
].join('\n')

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  profile: { type: 'string', short: 'p', multiple: true },
  'allow-incomplete': { type: 'boolean' },
  'print-config': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

/**
 * Run one review and return the process exit code. Never throws: usage and configuration problems
 * exit 2, runtime failures exit 3, an interrupt exits 130, and an incomplete review (a finding its
 * failed votes left undecided, or a research gap) of a gating profile exits 4 unless a `high` finding
 * was kept by a gating profile, so CI can tell a broken run and a partial review from a real finding
 * (exit 1) and from a clean one (exit 0). `exitCodeFor` maps the result; advisory flags never change it.
 *
 * It reads at most 16 MiB of diff, from stdin or a file, counted in bytes: a larger diff is a usage error,
 * and reading stops at the chunk that crosses the cap.
 *
 * Its flags are `--config`, `--profile`, `--allow-incomplete`, `--print-config`, `--help` and `--version`;
 * a usage error prints the usage after its message. Its settings are the config file `--config` or
 * `QUORUM_CONFIG` names (`--config` resolved against `io.cwd`, `QUORUM_CONFIG` an absolute path), and the
 * `QUORUM_*` variables of `io.env` with their deprecated aliases. Each warning is printed once, before the
 * banner, and when the configuration is refused the environment's warnings come before the `Error:` lines,
 * since a deprecated or mistyped variable is often what caused the error.
 *
 * `--print-config` reads no diff and calls no model: it writes the resolved config as YAML on stdout
 * (see `printConfig`), warnings included, and returns 0; a diff argument with it is a usage error, and
 * a configuration the run refuses, one of its providers that cannot be built included, exits 2 as in a run.
 *
 * The run is interrupted when `io.signal` aborts: it then writes `interrupted` and returns 130, whatever
 * error ended the review, and writes no result. A review that has already resolved is complete.
 *
 * Everything the CLI writes is inert (invariant I3): each stderr line passes through `inertLine`, and
 * the JSON result through `inertJson`.
 */
export async function runCli(io: CliIO): Promise<number> {
  let flags: ReturnType<typeof parseFlags>
  try {
    flags = parseFlags(io.argv)
  } catch (error) {
    return usageError(io, error)
  }
  const { values, positionals } = flags
  if (values.help) {
    io.stdout.write(USAGE)
    return EXIT.ok
  }
  if (values.version) {
    io.stdout.write(`quorum ${packageJson.version}\n`)
    return EXIT.ok
  }

  const printing = values['print-config'] === true
  let diff = ''
  try {
    if (values.config === '') throw new ConfigError([{ path: '--config', message: 'must name a file' }])
    if (printing && positionals.length > 0) throw new Error('--print-config takes no diff file')
    if (!printing) diff = await readDiff(io, positionals)
  } catch (error) {
    return usageError(io, error)
  }

  let quorum: Quorum | undefined
  try {
    const selection = values.profile === undefined ? undefined : { ids: values.profile, path: '--profile' }
    const { config, source } = await loadConfig({ cwd: io.cwd, env: io.env, configPath: values.config, selection })
    quorum = await fromConfig(config, { env: io.env, events: progressSink(line => io.stderr.write(`${line}\n`)) })
    if (printing) {
      io.stdout.write(printConfig(config, source))
      return EXIT.ok
    }
    writeWarnings(io, quorum.warnings)
    for (const line of bannerLines(config)) io.stderr.write(`${line}\n`)
    if (diff.trim() === '') io.stderr.write('empty diff: nothing to review\n')
    const result = await quorum.review({ diff }, { signal: io.signal })
    io.stdout.write(`${inertJson(result)}\n`)
    return exitCodeFor(result, { allowIncomplete: values['allow-incomplete'] === true })
  } catch (error) {
    if (io.signal?.aborted) {
      io.stderr.write('interrupted\n')
      return EXIT.interrupted
    }
    if (error instanceof ConfigError && quorum === undefined) writeWarnings(io, readEnv(io.env).warnings)
    io.stderr.write(`${errorLines(error)}\n`)
    return error instanceof ConfigError ? EXIT.usage : EXIT.runtime
  }
}

/** Write each warning as an inert `warning:` line. */
function writeWarnings(io: CliIO, warnings: readonly string[]): void {
  for (const warning of warnings) io.stderr.write(`${inertLine(`warning: ${warning}`)}\n`)
}

/** The one source of signals the CLI listens to: `process`, or an emitter in a test. */
export interface SignalSource {
  on: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
}

/**
 * The signal of one review, aborted by the first SIGINT or SIGTERM. The next one calls `exit(130)`: the
 * way out of a provider that ignores its signal, since no timer waits for it.
 */
export function interruptSignal(source: SignalSource, exit: (code: number) => void): AbortSignal {
  const controller = new AbortController()
  let received = 0
  const onSignal = (): void => {
    received += 1
    if (received === 1) controller.abort()
    else exit(EXIT.interrupted)
  }
  source.on('SIGINT', onSignal)
  source.on('SIGTERM', onSignal)
  return controller.signal
}

/**
 * The exit code of a finished review: 1 when a kept finding is `high` and its profile gates, 4 when
 * an unreviewed finding or a gap belongs to a gating profile (unless `allowIncomplete` turns it into
 * 0, which it does for every gap but a `request-too-large` one), 0 otherwise. A profile gates
 * unless `meta.profiles` holds it with `gating: false`, so a profile missing from the result counts
 * as gating and a gap never hides.
 *
 * A `request-too-large` gap of a gating profile exits 4 whatever `allowIncomplete` says: a pull
 * request can cause that gap by padding the diff until a request is refused, so no flag lifts it
 * (ADR-0012). The flag lifts every other gap, including gaps a pull request can cause: decoy findings
 * that push a real one past `maxFindings`, or text that trips a hosted voter's content filter. On a
 * gating profile, do not use it for a pull request you do not trust.
 */
export function exitCodeFor(result: QuorumResult, options: { readonly allowIncomplete?: boolean } = {}): number {
  const gates = (profile: string): boolean => !Object.hasOwn(result.meta.profiles, profile) || result.meta.profiles[profile].gating !== false
  if (result.kept.some(verdict => verdict.confidence === 'high' && gates(verdict.profile))) return EXIT.finding
  if (result.meta.incomplete.some(entry => entry.reason === 'request-too-large' && gates(entry.profile))) return EXIT.incomplete
  const incomplete = result.unreviewed.some(verdict => gates(verdict.profile)) || result.meta.incomplete.some(entry => gates(entry.profile))
  return incomplete && options.allowIncomplete !== true ? EXIT.incomplete : EXIT.ok
}

/** The flags of `argv` and its positional arguments; a usage error of `parseArgs` is raised as a `ConfigError`, one issue per line of its message. */
function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    if (!(error instanceof Error) || !(error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS_')) throw error
    throw new ConfigError(error.message.split('\n').map(message => ({ path: '', message })))
  }
}

/** Write a usage error and the usage, and return its exit code. */
function usageError(io: CliIO, error: unknown): number {
  io.stderr.write(`${errorLines(error)}\n${USAGE}`)
  return EXIT.usage
}

/** Read the diff from the file argument, or from stdin unless stdin is an interactive terminal. */
async function readDiff(io: CliIO, positionals: readonly string[]): Promise<string> {
  const [path, ...extra] = positionals
  if (extra.length > 0) throw new Error(`unexpected arguments: ${extra.join(' ')}`)
  if (path) return readCapped(createReadStream(resolve(io.cwd, path)))
  if (io.stdin.isTTY) throw new Error('no diff given')
  return readCapped(io.stdin)
}

/**
 * Read `chunks` to the end as UTF-8 text, through one streaming decoder, so a leading byte-order mark
 * goes and a character split between two chunks stays whole, whatever the source. The bytes are
 * counted as they arrive: the chunk that takes the count past `MAX_DIFF_BYTES` throws, and leaving
 * the loop closes the stream, so no more is read.
 */
async function readCapped(chunks: AsyncIterable<Uint8Array | string>): Promise<string> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  for await (const chunk of chunks) {
    const data = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    bytes += data.byteLength
    if (bytes > MAX_DIFF_BYTES) throw new Error('the diff is over 16 MiB, the most quorum reads')
    text += decoder.decode(data, { stream: true })
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
