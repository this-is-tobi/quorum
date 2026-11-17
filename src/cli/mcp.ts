/**
 * The `quorum mcp` subcommand: it serves quorum's one tool, `review`, over MCP on standard input and output, to
 * one client such as Claude Code. The server itself is `src/mcp/`, which this module loads with `import()` alone,
 * so a quorum that never runs `quorum mcp` never loads the MCP SDK.
 */

import type { Readable, Writable } from 'node:stream'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { envValue } from '../config/env.ts'
import { readNamedConfig } from '../config/load.ts'
import { resolveConfig } from '../config/resolve.ts'
import { ConfigError } from '../core/errors.ts'
import { errorLines, EXIT, parseFlags } from './io.ts'
import type { CliIO } from './io.ts'
import { bannerLines, progressSink } from './render.ts'

export const MCP_USAGE = [
  'Usage: quorum mcp [options]',
  '',
  'Serve quorum\'s review tool over MCP, on standard input and output, to one client such as Claude Code.',
  '',
  'Options:',
  '  -c, --config <path>             Read this config file, which must lie outside the project; over QUORUM_CONFIG',
  '  -p, --profile <id>              Serve only this profile; repeat it to serve several',
  '      --large                     Run a review of paths that may pass the token cap, reviewing what the cap allows',
  '      --trust-repo-config         Review local or staged changes where the repository\'s own config names a filter program',
  '      --send <path>               Send a file held as a secret to the models all the same; repeat it to send several',
  '  -h, --help                      Print this help and exit',
  '',
].join('\n')

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  profile: { type: 'string', short: 'p', multiple: true },
  large: { type: 'boolean' },
  'trust-repo-config': { type: 'boolean' },
  send: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
} as const

const ROOT_MESSAGE = 'must be an absolute path to a directory'
const TERMINAL_MESSAGE = 'reads MCP messages on standard input, which is a terminal here: let an MCP client start it, as claude mcp add quorum -- quorum mcp does'
const INSIDE_MESSAGE = 'names a file inside the project, which the calling agent can change: keep the server\'s config outside the project'
const NOT_STREAMS = 'needs standard input and output as streams'

function refusal(path: string, message: string): ConfigError {
  return new ConfigError([
    { path, message },
  ])
}

/** Whether `path` is `directory` or lies under it: a path-segment prefix, so `/work/app-two` is not inside `/work/app`. */
function isInside(path: string, directory: string): boolean {
  const from = relative(directory, path)
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from))
}

/**
 * The root the server serves, as a real path and as given: `CLAUDE_PROJECT_DIR` when set, which must be an
 * absolute path to a directory, else the directory the server was launched in. The two differ where a link or a
 * system alias lies in the path, such as `/var` and `/private/var`.
 */
async function projectRoot(io: CliIO): Promise<{ real: string, given: string }> {
  const given = envValue(io.env, 'CLAUDE_PROJECT_DIR')
  if (given === undefined) {
    const launched = resolve(io.cwd)
    return { real: await realpath(launched), given: launched }
  }
  const real = isAbsolute(given)
    ? await realpath(given).catch(() => undefined)
    : undefined
  if (real === undefined || !(await stat(real)).isDirectory()) throw refusal('CLAUDE_PROJECT_DIR', ROOT_MESSAGE)
  return {
    real,
    given: resolve(given),
  }
}

/**
 * The config file the launch names, as a real path, or `undefined` when none is named: `--config` against the
 * launch directory, else `QUORUM_CONFIG`, which must be absolute (a relative one is refused first, a path given
 * or not, as `readNamedConfig` refuses it). It is refused when it lies inside the root, whether the path as typed
 * (resolved, never through `realpath`, against the root as given and as a real path), the path with its
 * directory resolved, or the file it leads to does, since the calling agent can write in the root and so can
 * change a config there, and link or relink one, even a link it typed the path through to a directory outside.
 * A path that does not resolve is returned as named, for `readNamedConfig` to word.
 */
async function namedConfig(io: CliIO, flag: string | undefined, root: { real: string, given: string }): Promise<string | undefined> {
  const fromEnv = envValue(io.env, 'QUORUM_CONFIG')
  if (fromEnv !== undefined && !isAbsolute(fromEnv)) throw refusal('QUORUM_CONFIG', 'must be an absolute path')
  const named = flag === undefined
    ? fromEnv
    : resolve(io.cwd, flag)
  if (named === undefined) return undefined
  const refuse = (): ConfigError => refusal(flag === undefined
    ? 'QUORUM_CONFIG'
    : '--config', INSIDE_MESSAGE)
  const typed = resolve(named)
  if (isInside(typed, root.given) || isInside(typed, root.real)) throw refuse()
  const real = await realpath(named).catch(() => undefined)
  if (real === undefined) return named
  const parent = await realpath(dirname(named)).catch(() => undefined)
  const linked = parent === undefined
    ? real
    : join(parent, basename(named))
  if (isInside(real, root.real) || isInside(linked, root.real)) throw refuse()
  return real
}

/** `value` as a stream, or an `Error` that says the server needs one: a spec's I/O may hand over plain functions. */
function streamOf<T extends Readable | Writable>(value: unknown): T {
  if (typeof (value as { on?: unknown } | null)?.on !== 'function') throw new TypeError(NOT_STREAMS)
  return value as T
}

/**
 * Run `quorum mcp` and return the process exit code. Its flags are `--config`, `--profile`, `--large`,
 * `--trust-repo-config`, `--send` and `--help`, and it takes no argument. The steps run in this order, and
 * nothing is read before the last two:
 *
 * 1. the flags: a usage error prints its lines and `MCP_USAGE` on stderr, exit 2; `-h` prints it on stdout;
 * 2. an empty `--config` or `--send`, and a positional argument, each a usage error too;
 * 3. a terminal on stdin, which no client is, refused;
 * 4. the root, `CLAUDE_PROJECT_DIR` else the launch directory;
 * 5. the SDK's version (`sdkProblem`), checked before the SDK is imported, so another version never loads;
 * 6. the server's module, whose import fails when the SDK is absent;
 * 7. the config: its path is resolved and refused when it lies inside the root as typed, or by its real path,
 *    and only then is the file read. The check comes first because reading a config can run it as code, with the
 *    operator's keys in the environment, and a config inside the root is one the calling agent could have written;
 * 8. the profiles' resolution, `--profile` the selection, so a config whose provider cannot be built, or whose
 *    selection runs nothing, is refused before the client is served;
 * 9. the banner on stderr, as the review command prints it;
 * 10. the server, over standard input and output, with the review's progress lines on stderr.
 *
 * A `ConfigError` exits 2, and any other failure 3, with its lines on stderr. Nothing but the protocol's
 * messages is ever written to stdout, apart from `--help`.
 */
export async function runMcp(io: CliIO, argv: readonly string[]): Promise<number> {
  let values: ReturnType<typeof parseFlags<typeof OPTIONS>>['values']
  try {
    const flags = parseFlags(argv, OPTIONS)
    values = flags.values
    if (values.help) {
      io.stdout.write(MCP_USAGE)
      return EXIT.ok
    }
    if (values.config === '') throw refusal('--config', 'must name a file')
    if (values.send?.includes('')) throw refusal('--send', 'must name a file')
    if (flags.positionals.length > 0) throw refusal('', `takes no argument, and ${flags.positionals.length} were given`)
  } catch (error) {
    io.stderr.write(`${errorLines(error)}\n${MCP_USAGE}`)
    return error instanceof ConfigError
      ? EXIT.usage
      : EXIT.runtime
  }

  try {
    if (io.stdin.isTTY) throw refusal('', TERMINAL_MESSAGE)
    const root = await projectRoot(io)
    const sdk = await import('../mcp/sdk.ts')
    const problem = await sdk.sdkProblem()
    if (problem !== undefined) throw refusal('', problem)
    const serve = await import('../mcp/serve.ts').catch(() => {
      throw refusal('', sdk.SDK_ABSENT)
    })
    const path = await namedConfig(io, values.config, root)
    const { input } = await readNamedConfig({ cwd: io.cwd, env: io.env, configPath: path })
    const selection = values.profile === undefined
      ? undefined
      : { ids: values.profile, path: '--profile' }
    const config = resolveConfig(input, { env: io.env, selection })
    for (const line of bannerLines(config)) io.stderr.write(`${line}\n`)
    return await serve.serveMcp({
      root: root.real,
      input,
      config,
      env: io.env,
      platform: io.platform ?? process.platform,
      large: values.large === true,
      trustRepoConfig: values['trust-repo-config'] === true,
      send: [
        ...config.send ?? [],
        ...values.send ?? [],
      ],
      observe: progressSink(line => io.stderr.write(`${line}\n`)),
      git: io.git,
    }, {
      input: streamOf<Readable>(io.stdin),
      output: streamOf<Writable>(io.stdout),
      stderr: io.stderr,
      signal: io.signal,
    })
  } catch (error) {
    io.stderr.write(`${errorLines(error)}\n`)
    return error instanceof ConfigError
      ? EXIT.usage
      : EXIT.runtime
  }
}
