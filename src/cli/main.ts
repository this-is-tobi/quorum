import packageJson from '../../package.json' with { type: 'json' }
import { readEnv } from '../config/env.ts'
import { fromConfig } from '../config/from-config.ts'
import { loadConfig } from '../config/load.ts'
import { parseFailOn } from '../config/profiles.ts'
import type { FailOnOverride } from '../config/profiles.ts'
import { ConfigError } from '../core/errors.ts'
import { outcome } from '../core/outcome.ts'
import { inertLine } from '../core/sanitize.ts'
import type { Estimate, Quorum } from '../core/types.ts'
import { renderReport } from '../report/registry.ts'
import { readDiffInput } from '../sources/diff.ts'
import { atProblem, pathProblem } from '../sources/paths.ts'
import { parseRange } from '../sources/range.ts'
import { readSource } from '../sources/read.ts'
import type { SourceSpec } from '../sources/read.ts'
import { runBench } from './bench.ts'
import { errorLines, errorMessage, EXIT, parseFlags } from './io.ts'
import type { CliIO } from './io.ts'
import { reportPlan } from './outputs.ts'
import type { ReportPlan } from './outputs.ts'
import { printConfig } from './print-config.ts'
import { bannerLines, estimateLines, progressSink } from './render.ts'

export { errorMessage, EXIT }
export type { CliIO }

const USAGE = [
  'Usage: quorum [options] [diff-file]',
  '       git diff | quorum [options]',
  '       quorum --range <base>...<head> [options]',
  '       quorum --local | --staged [options]',
  '       quorum --path <path> [--at <rev>] [options]',
  '       quorum bench [options] <suite>',
  '',
  'Options:',
  '  -c, --config <path>      Read this config file, over QUORUM_CONFIG',
  '  -p, --profile <id>       Run only this profile; repeat it to run several',
  '      --range <range>      Review a range of commits, written <base>...<head>',
  '      --local              Review the local changes: staged, unstaged and untracked',
  '      --staged             Review the staged changes: what the next commit holds',
  '      --trust-repo-config  Run --local or --staged where the repository\'s own config names a filter program',
  '      --path <path>        Review the files under a path at a commit; repeat it to review several',
  '      --at <rev>           The commit --path reads, HEAD by default',
  '      --no-default-skips   Review in --path the vendored, lockfile, minified and binary files too',
  '      --large              Run a --path review that may pass the token cap, reviewing what the cap allows',
  '      --send <path>        Send a file held as a secret to the models all the same; repeat it to send several',
  '      --allow-incomplete   Exit 0 instead of 4 when every gap is a vote that failed in passing: a dropped connection, a timeout, or an HTTP 408, 409, 429 or 5xx',
  '      --fail-on <level>    Exit 1 for a kept finding at or above high, medium or low, or never with none; <profile>=<level> sets one profile',
  '  -f, --format <format>    Write the report on stdout in this format: json or brief; json by default',
  '      --print-config       Print the resolved config, keys redacted, and exit',
  '  -h, --help               Print this help and exit',
  '  -v, --version            Print the version and exit',
  '',
].join('\n')

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  profile: { type: 'string', short: 'p', multiple: true },
  range: { type: 'string', multiple: true },
  local: { type: 'boolean' },
  staged: { type: 'boolean' },
  'trust-repo-config': { type: 'boolean' },
  path: { type: 'string', multiple: true },
  at: { type: 'string', multiple: true },
  'no-default-skips': { type: 'boolean' },
  large: { type: 'boolean' },
  send: { type: 'string', multiple: true },
  'allow-incomplete': { type: 'boolean' },
  'fail-on': { type: 'string', multiple: true },
  format: { type: 'string', short: 'f', multiple: true },
  'print-config': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

/** What `parseFlags` makes of the arguments of a review. */
type Flags = ReturnType<typeof parseFlags<typeof OPTIONS>>

/**
 * Run one review and return the process exit code. Never throws: usage and configuration problems
 * exit 2, a gating profile's failed research and other runtime failures exit 3, an interrupt exits
 * 130, and an incomplete review (a finding its failed votes left undecided, or a gap) of a gating
 * profile exits 4 unless a kept finding reached its profile's fail-on level (`high` by default), so CI can
 * tell a broken run and a partial review from a real finding (exit 1) and from a clean one (exit 0).
 * `--allow-incomplete` turns that exit 4 into 0 only when every failed vote behind it failed in passing
 * (see `outcome`). `outcome` maps the result to its exit code; advisory flags never change it.
 *
 * It reads at most 16 MiB of diff, from stdin, a file, a range of commits, the local changes or the files at
 * a commit, counted in bytes: a larger diff is a usage error. A diff file or stdin stops at the chunk that
 * crosses the cap, and the child of a git source is stopped at its own cap.
 *
 * The diff comes from one source: a diff file, stdin, `--range <base>...<head>`, `--local` (what `git add
 * -A` would commit), `--staged` (what the next commit holds) or `--path <path>` (the files under it at the
 * commit `--at` names, HEAD by default, skipping by default what `--no-default-skips` reviews), the last four
 * running git itself (see `rangeSource`, `localSource` and `pathsSource`). Every usage rule of the source is
 * checked first, before any git and any config, the form of a range included (`parseRange`), and a diff file
 * or stdin is read then. A git source is read once the config is: it needs the config's `exclude` and `send`,
 * and a source git refuses, or a repository whose own config names a filter without `--trust-repo-config`, exits 2
 * before the banner, a git command that fails exits 3.
 *
 * A path review is a codebase and not a change, so its size is the tree's. After the banner and before any
 * call it prints its estimate on stderr (see `Quorum.estimate`), and exits 2 when its research's expected
 * spend and what the calls in flight reserve pass `maxReviewTokens`, unless `--large` is given: the review then
 * reviews what the cap allows and ends incomplete, exit 4, where the cap stops it. A diff, a range and the
 * local changes print no estimate and are never gated, since their size is the change's.
 *
 * Its flags are `--config`, `--profile`, `--range`, `--local`, `--staged`, `--trust-repo-config`, `--path`,
 * `--at`, `--no-default-skips`, `--large`, `--send`, `--allow-incomplete`, `--fail-on`, `--format`, `--print-config`,
 * `--help` and `--version`; a usage error prints the usage after its message. Its settings are the config file `--config` or `QUORUM_CONFIG`
 * names (`--config` resolved against `io.cwd`, `QUORUM_CONFIG` an absolute path), and the `QUORUM_*`
 * variables of `io.env` with their deprecated aliases. Each warning is printed once, before the banner, and
 * when the configuration is refused the environment's warnings come before the `Error:` lines, since a
 * deprecated or mistyped variable is often what caused the error.
 *
 * `--print-config` reads no diff and calls no model: it writes the resolved config as YAML on stdout
 * (see `printConfig`), warnings included, and returns 0; a diff argument or a git source with it is a usage error, and
 * a configuration the run refuses, one of its providers that cannot be built included, exits 2 as in a run.
 *
 * A file held back as a secret is sent all the same when `--send <path>` names it, repeatable, or the config's
 * `send` lists it: the path is the one the diff writes and the `left out:` line prints, matched exactly. The
 * CLI merges both lists, the config's first, and gives them to the source, the estimate and the review, so
 * the operator alone, never the change, lifts the hold. An empty `--send` is a usage error, before any config.
 *
 * `--fail-on <level>` sets the fail-on level of every profile that runs, and `--fail-on <profile>=<level>` of one
 * profile, which wins; both win over the config's `failOn`, and no variable sets one. The level is `high`,
 * `medium`, `low` or `none`, and the flag repeats, once for every profile and once for each profile. The
 * values are checked first, before the diff and any config (`parseFailOn`), and a profile that does not run is
 * refused with the configuration, before any call, so `--print-config` and `meta.profiles` show the levels the
 * run uses.
 *
 * `--format <format>` (`-f`) names the report stdout carries: `json`, the JSON result and the default, or `brief`, one
 * line of counts (see `renderReport`). It takes one format, is a usage error for any other and with `--print-config`,
 * which writes YAML, and is checked before the source and any config (`reportPlan`). Every format says what the exit
 * code says, from the one `outcome` the exit code is made of.
 *
 * The run is interrupted when `io.signal` aborts: it then writes `interrupted` and returns 130, whatever
 * error ended the review, and writes no result. A review that has already resolved is complete.
 *
 * The one subcommand is `bench`: when the first argument is `bench`, the rest goes to `runBench` and its exit
 * code is returned, before any review flag is read. A file named `bench` is reviewed as `quorum ./bench`.
 *
 * Everything the CLI writes is inert (invariant I3): each stderr line passes through `inertLine`, and
 * each report through its reporter, `json` through `inertJson` and `brief` through `inertLine`.
 */
export async function runCli(io: CliIO): Promise<number> {
  if (io.argv[0] === 'bench') return runBench(io, io.argv.slice(1))
  let flags: Flags
  try {
    flags = parseFlags(io.argv, OPTIONS)
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

  let spec: SourceSpec | undefined
  let failOn: FailOnOverride | undefined
  let plan: ReportPlan
  try {
    if (values.config === '') {
      throw new ConfigError([
        { path: '--config', message: 'must name a file' },
      ])
    }
    failOn = values['fail-on'] === undefined
      ? undefined
      : parseFailOn(values['fail-on'], '--fail-on')
    plan = reportPlan(values, io)
    spec = await sourceSpec(io, values, positionals)
  } catch (error) {
    return usageError(io, error)
  }

  let quorum: Quorum | undefined
  try {
    const selection = values.profile === undefined
      ? undefined
      : { ids: values.profile, path: '--profile' }
    const { config, source } = await loadConfig({
      cwd: io.cwd,
      env: io.env,
      configPath: values.config,
      selection,
      failOn,
    })
    const send = [
      ...config.send ?? [],
      ...values.send ?? [],
    ]
    const read = spec === undefined
      ? undefined
      : await readSource(spec, {
          cwd: io.cwd,
          env: io.env,
          platform: io.platform ?? process.platform,
          signal: io.signal,
          exclude: config.exclude,
          send,
          git: io.git,
        })
    quorum = await fromConfig(config, {
      env: io.env,
      events: progressSink(line => io.stderr.write(`${line}\n`)),
    })
    if (read === undefined) {
      io.stdout.write(printConfig(config, source))
      return EXIT.ok
    }
    writeWarnings(io, quorum.warnings)
    for (const line of bannerLines(config)) io.stderr.write(`${line}\n`)
    if (spec?.kind === 'paths') holdLargeReview(io, quorum.estimate({ diff: read.diff, send }), values.large === true)
    if (read.diff.trim() === '') io.stderr.write('empty diff: nothing to review\n')
    const result = await quorum.review({ ...read, send }, { signal: io.signal })
    const done = outcome(result, { allowIncomplete: values['allow-incomplete'] === true })
    io.stdout.write(renderReport(result, { format: plan.format, color: plan.color, outcome: done }))
    return done.exitCode
  } catch (error) {
    if (io.signal?.aborted) {
      io.stderr.write('interrupted\n')
      return EXIT.interrupted
    }
    if (error instanceof ConfigError && quorum === undefined) writeWarnings(io, readEnv(io.env).warnings)
    io.stderr.write(`${errorLines(error)}\n`)
    return error instanceof ConfigError
      ? EXIT.usage
      : EXIT.runtime
  }
}

/**
 * Print a path review's estimate on stderr, and refuse the review when it may not finish under the token cap:
 * its research's expected spend and what the calls in flight reserve are over `maxReviewTokens`. The gate is
 * a `ConfigError` that names `--path`, a narrower path, the cap and `--large`, which `large` lifts: the review
 * then runs, spends no more than the cap and ends incomplete where the cap stops it. It runs before any call.
 */
function holdLargeReview(io: CliIO, estimate: Estimate, large: boolean): void {
  for (const line of estimateLines(estimate)) io.stderr.write(`${line}\n`)
  if (estimate.fits || large) return
  throw new ConfigError([
    {
      path: '--path',
      message: `may not finish under the review's token cap of ${estimate.maxReviewTokens} tokens: its research alone expects about ${estimate.expected}, with ${estimate.inFlight} reserved at once: name a narrower path, raise maxReviewTokens, or pass --large to review what the cap allows`,
    },
  ])
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
 * way out when what a provider still runs, after the review settled its call, keeps the process alive.
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

/** Write a usage error and the usage, and return its exit code. */
function usageError(io: CliIO, error: unknown): number {
  io.stderr.write(`${errorLines(error)}\n${USAGE}`)
  return EXIT.usage
}

/**
 * The one source the flags and the positional arguments name, with its usage rules checked before anything
 * is read, in this order: a source beside `--print-config`, which reads no diff, so it names none
 * (undefined); a second source, taken in the order diff file, `--range`, `--local`, `--staged`, `--path`,
 * which names the first it cannot be given with; `--trust-repo-config` without `--local` or `--staged`;
 * `--at`, `--large` or `--no-default-skips` without `--path`; an empty `--send`; a second range, a second commit. A
 * diff file, or stdin when no file is named, is read here, as the usage errors of its own come before the config's. A range
 * written wrongly is refused here too, in the words `rangeSource` refuses it with, and so is an empty or
 * absolute `--path` value (`pathProblem`) and an `--at` that starts with `-` (`atProblem`), so no config is
 * read for any of them.
 */
async function sourceSpec(io: CliIO, values: Flags['values'], positionals: readonly string[]): Promise<SourceSpec | undefined> {
  const refuse = (path: string, message: string): ConfigError => new ConfigError([
    { path, message },
  ])
  const local = values.local === true
  const staged = values.staged === true
  const paths = values.path
  if (values['print-config']) {
    if (values.range !== undefined || local || staged || paths !== undefined) throw refuse('--print-config', 'reads no diff, so it takes no --range, --local, --staged or --path')
    if (positionals.length > 0) throw new Error('--print-config takes no diff file')
  }
  const [first, second] = [
    { flag: 'a diff file', given: positionals.length > 0 },
    { flag: '--range', given: values.range !== undefined },
    { flag: '--local', given: local },
    { flag: '--staged', given: staged },
    { flag: '--path', given: paths !== undefined },
  ].filter(({ given }) => given)
  if (second !== undefined) throw refuse(second.flag, `cannot be given with ${first.flag}: give one source`)
  if (values['trust-repo-config'] === true && !local && !staged) throw refuse('--trust-repo-config', 'needs --local or --staged')
  if (paths === undefined) {
    if (values.at !== undefined) throw refuse('--at', 'needs --path')
    if (values.large === true) throw refuse('--large', 'needs --path')
    if (values['no-default-skips'] === true) throw refuse('--no-default-skips', 'needs --path')
  }
  if (values.send?.includes('')) throw refuse('--send', 'must name a file')
  if (values['print-config']) return undefined
  if (values.range !== undefined) {
    if (values.range.length > 1) throw refuse('--range', 'takes one range')
    const [range] = values.range
    const problem = parseRange(range)
    if (typeof problem === 'string') throw refuse('--range', problem)
    return { kind: 'range', range }
  }
  if (local || staged) {
    return {
      kind: local
        ? 'local'
        : 'staged',
      trustRepoConfig: values['trust-repo-config'] === true,
    }
  }
  if (paths !== undefined) {
    for (const value of paths) {
      const problem = pathProblem(value)
      if (problem !== undefined) throw refuse('--path', problem)
    }
    if (values.at !== undefined && values.at.length > 1) throw refuse('--at', 'takes one commit')
    const at = values.at?.[0]
    const atIssue = atProblem(at)
    if (atIssue !== undefined) throw refuse('--at', atIssue)
    return {
      kind: 'paths',
      paths,
      at,
      skips: values['no-default-skips'] !== true,
    }
  }
  const [file, ...extra] = positionals
  if (extra.length > 0) throw refuse('', `takes one diff file, and ${extra.length} more argument(s) were given`)
  return { kind: 'diff', text: await readDiffInput(io.cwd, file, io.stdin) }
}
