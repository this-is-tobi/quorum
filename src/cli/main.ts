import { resolve } from 'node:path'
import { providerIdentity } from '../bench/fingerprint.ts'
import { readEnv } from '../config/env.ts'
import { fromConfig } from '../config/from-config.ts'
import { loadConfig } from '../config/load.ts'
import { parseFailOn } from '../config/profiles.ts'
import type { FailOnOverride } from '../config/profiles.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { systemClock } from '../core/clock.ts'
import { ConfigError } from '../core/errors.ts'
import { DEFAULT_MAX_REVIEW_TOKENS } from '../core/limits.ts'
import { MAX_TIMEOUT_MS } from '../core/ports.ts'
import { VERSION } from '../core/version.ts'
import { outcome } from '../core/outcome.ts'
import type { Estimate, Quorum } from '../core/types.ts'
import { renderReport } from '../report/registry.ts'
import { publicView } from '../report/view.ts'
import { readDiffInput } from '../sources/diff.ts'
import { atProblem, pathProblem } from '../sources/paths.ts'
import { parseRange } from '../sources/range.ts'
import { readSource } from '../sources/read.ts'
import type { SourceSpec } from '../sources/read.ts'
import { openFileStore } from '../state/store.ts'
import type { FileStore } from '../state/store.ts'
import { runBench } from './bench.ts'
import { errorLines, errorMessage, EXIT, parseFlags } from './io.ts'
import type { CliIO } from './io.ts'
import { runMcp } from './mcp.ts'
import { checkOutputs, colorFor, reportPlan, writeOutputs } from './outputs.ts'
import type { ColorWhen, ReportPlan } from './outputs.ts'
import { printConfig } from './print-config.ts'
import { bannerLines, boundWarnings, estimateLines, viewFacts } from './render.ts'
import type { Bounds } from './render.ts'
import { runReport } from './report.ts'
import { progressMode, viewWriter } from './view/progress.ts'
import type { CapOrigin } from './view/model.ts'
import type { ProgressMode } from './view/progress.ts'
import type { ViewWriter } from './view/writer.ts'

export { errorMessage, EXIT }
export type { CliIO }

const USAGE = [
  'Usage: quorum [options] [diff-file]',
  '       git diff | quorum [options]',
  '       quorum --range <base>...<head> [options]',
  '       quorum --local | --staged [options]',
  '       quorum --path <path> [--at <rev>] [options]',
  '       quorum bench [options] <suite>',
  '       quorum report [options] [<result>|-]',
  '       quorum mcp [options]',
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
  '      --no-default-skips   Review in --path the vendored, lockfile, minified, binary and test files too',
  '      --large              Does nothing, and goes in a later release: a --path review\'s token cap follows its estimate',
  '      --send <path>        Send a file held as a secret to the models all the same; repeat it to send several',
  '      --allow-incomplete   Exit 0 instead of 4 when every gap is a vote that failed in passing: a dropped connection, a timeout, or an HTTP 408, 409, 429 or 5xx',
  '      --fail-on <level>    Exit 1 for a kept finding at or above high, medium or low, or never with none; <profile>=<level> sets one profile',
  '  -f, --format <format>    Write the report on stdout in this format: text, json, brief, markdown, payload or sarif; text on a terminal, else json',
  '  -o, --output <output>    Also write a report to a file, written <format>=<path>; repeat it to write several',
  '      --color <when>       Color the text report and the live view: auto, on a terminal unless NO_COLOR is set; always; or never',
  '      --progress <mode>    Show progress on stderr: auto, live on a terminal and plain lines elsewhere; live; plain; json; or none',
  '      --view <view>        Show the full result, or the public view with public: no reasoning, discarded findings, models or usage',
  '      --state <dir>        Save every answered call in this directory, and reuse the calls it holds',
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
  output: { type: 'string', short: 'o', multiple: true },
  color: { type: 'string', multiple: true },
  progress: { type: 'string', multiple: true },
  view: { type: 'string', multiple: true },
  state: { type: 'string', multiple: true },
  'print-config': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

/** What `parseFlags` makes of the arguments of a review. */
type Flags = ReturnType<typeof parseFlags<typeof OPTIONS>>

/**
 * Run one review and return the process exit code. Never throws: usage and configuration problems
 * exit 2, a review in which no research call answered (a provider found down) and other runtime failures
 * exit 3, an interrupt exits 130, and an incomplete review (a finding its failed votes left undecided, or a
 * gap, a failed research part included) of a gating profile exits 4 unless a kept finding reached its
 * profile's fail-on level (`high` by default), so CI can tell a broken run and a partial review from a real finding (exit 1) and from a clean one (exit 0).
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
 * A path review is a codebase and not a change, so its size is the tree's, and its bounds follow it (see `pathBounds`). After
 * the banner and before any call it prints its estimate on stderr (see `Quorum.estimate`), ending with the review's token cap and
 * deadline: with `maxReviewTokens` unset the cap is the estimate's worst case, never below 2000000, and with `reviewTimeoutMs`
 * unset the deadline is 24 hours, the longest allowed; a set one is kept. A large review, whose expected research spend and calls in flight pass 2000000 under a cap that follows the
 * estimate, is warned of, and so is a cap the config sets below what the estimate expects, which the review runs to, the rest a `token-cap`
 * gap, exit 4. A path review is never held for its size, and `--large` warns that it does nothing. A diff, a range and the
 * local changes print no estimate and keep the quorum's bounds, 2000000 tokens and 30 minutes unless the config sets them, since
 * their size is the change's.
 *
 * Its flags are `--config`, `--profile`, `--range`, `--local`, `--staged`, `--trust-repo-config`, `--path`,
 * `--at`, `--no-default-skips`, `--large`, `--send`, `--allow-incomplete`, `--fail-on`, `--format`, `--output`,
 * `--color`, `--progress`, `--view`, `--state`, `--print-config`, `--help` and `--version`; a usage error prints the usage after its message. Its
 * settings are the config file `--config` or `QUORUM_CONFIG`
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
 * `--format <format>` (`-f`) names the report stdout carries: `text`, the report for a person, `json`, the JSON result, or
 * `brief`, one line of counts (see `renderReport`). With no `--format` it is `text` when stdout is a terminal and `json` when
 * it is a pipe or a file, and stdin plays no part: a program that reads the result names `-f json`. `--color <when>` colors
 * the text report, and no other: `auto`, the default, when stdout is a terminal and `NO_COLOR` is unset or empty, `always`
 * or `never` alone (see `colorFor`). Each takes one value, is a usage error for any other, and `--format` is one with
 * `--print-config`, which writes YAML; both are checked before the source and any config (`reportPlan`). Every format says
 * what the exit code says, from the one `outcome` the exit code is made of.
 *
 * `--output <format>=<path>` (`-o`) also writes a report to a file, repeatable, each in its format and never colored.
 * Its form and its paths are checked with the other flags (`reportPlan`: two outputs to one file are refused, and so is
 * `--print-config` with one), and its files before any config is read or any call made (`checkOutputs`: a symbolic link, a
 * path that is no regular file and a missing directory exit 2, so a review never spends its tokens and then fails to
 * write). The files are written after the report on stdout, each through a new file and a rename (`writeOutputs`), and a
 * write that fails exits 3, never with the review's code.
 *
 * `--view <view>` is `full` by default, or `public` for a log or an artifact a stranger may read (see `publicView`). The
 * public view is what stdout and every `--output` file render, and stderr writes less too: the banner names a
 * provider by its config key (`bannerLines`), a gap and a dropped finding carry no detail or reason
 * (`renderEvent`), and a failure after the config is read is written in fixed words (`errorLines`). It takes one
 * value, is a usage error for any other, and is one with `--print-config`, all before the source and any config
 * (`reportPlan`). The exit code is the same: `outcome` reads the result, not the view.
 *
 * `--state <dir>` keeps every answered call of the review in that directory, and reuses the calls it holds (see
 * `openFileStore`): each research call whose reply passed its envelope check and each vote that parsed is saved as it
 * completes, and a cut-off or saturated research reply as a marker, so a rerun of a review that failed late pays for
 * none of it again, for a request sent as it was, checked as a fresh reply. It is opened once the config is read and
 * before the banner, with the identity of each of the config's providers, and the review says on stderr what it reused
 * (`reused from --state: <n> research call(s), <n> vote(s)`) when it reused any. It is a usage error when empty, given
 * twice or with `--print-config`, and a directory the store refuses (a link, one another user owns or others can
 * write, one inside a git work tree, one that is not a state directory quorum made) exits 2 before any call, naming
 * the flag and never the path. Its warnings are inert `--state:` lines, and a write that fails never fails the review.
 *
 * `--progress <mode>` (or `QUORUM_PROGRESS`, which the flag wins over) chooses how stderr shows the review: `auto`, the
 * default, is `live` when stderr is a terminal, `CI` is unset or empty and `TERM` is not `dumb`, else `plain`; `live`
 * redraws a block under the log lines (`liveWriter`); `plain` writes one line for each event worth one, with a heartbeat;
 * `json` writes each event and each line of the CLI's as a JSON line; `none` writes the warnings and the errors alone (see
 * `progressMode`). A value that is none of them, a flag given twice, `live` off a terminal and `json` with `--view public`
 * are usage errors, before any config. A usage error is text in every mode, as are the exit-path lines of `bin.ts`. `--color` colors the live
 * view too, over a terminal, and `NO_COLOR` or `never` removes it and keeps the block. The report on stdout is written
 * after the view's `close`, which has erased the block and shown the cursor, and the view's `restore` runs on each way out
 * of this function and, through `io.exitHooks`, of the process.
 *
 * Once the report and the `--output` files are written, the view writes the review's summary on stderr: the time of each
 * stage, the tokens against the cap, the calls, each gap with its fix, and where the report went, by format and never by
 * path (`summaryLines`). A run that fails writes none.
 *
 * The first SIGINT or SIGTERM, which aborts `io.signal`, means two things. Before the review is called it aborts the setup, as
 * it always did: the run writes `interrupted` and returns 130, whatever error ended the setup, with no review and no result;
 * a signal that came after the setup's last await finds the signal aborted just before the review and ends the same way.
 * From the review's call on it is the review's interrupt (`review`'s `interrupt`, never its `signal`): no new call starts,
 * the calls in flight have the grace to end, the view says so, and the review resolves with what it read, its gaps
 * `interrupted`. The report and the `--output` files are written, the summary says how a rerun resumes, and the exit code is
 * 130 (`outcome`). A review that fails for another reason while the signal is aborted is the same interruption, with no result.
 * A failure after the review resolved, an `--output` write, keeps its own line and exit code. The second signal is `bin.ts`'s: it
 * quits at once, with no result.
 *
 * The subcommands are `bench`, `report` and `mcp`: when the first argument is one of them, the rest goes to
 * `runBench`, `runReport` or `runMcp` and its exit code is returned, before any review flag is read. A file named
 * `bench`, `report` or `mcp` is reviewed as `quorum ./bench`, `quorum ./report` or `quorum ./mcp`.
 *
 * Everything the CLI writes is inert (invariant I3): each stderr line after the flags goes through one view writer
 * (`viewWriter`), which passes it through `inertLine` or `inertJsonLine`, and each report through its reporter, `json`
 * through `inertJson`, `brief` and `text` through `inertLine`, and `text`'s color around the words quorum wrote alone.
 */
export async function runCli(io: CliIO): Promise<number> {
  if (io.argv[0] === 'bench') return runBench(io, io.argv.slice(1))
  if (io.argv[0] === 'report') return runReport(io, io.argv.slice(1))
  if (io.argv[0] === 'mcp') return runMcp(io, io.argv.slice(1))
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
    io.stdout.write(`quorum ${VERSION}\n`)
    return EXIT.ok
  }

  let spec: SourceSpec | undefined
  let failOn: FailOnOverride | undefined
  let plan: ReportPlan
  let mode: ProgressMode
  let state: string | undefined
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
    mode = progressMode({
      flag: values.progress,
      env: io.env,
      terminal: io.stderr.isTTY === true,
      view: plan.view,
    })
    state = stateDirectory(values)
    spec = await sourceSpec(io, values, positionals)
  } catch (error) {
    return usageError(io, error)
  }

  // The live view's colour is `--color`'s over a terminal, which `mode` being live says stderr is: NO_COLOR and `never` remove it.
  const view = viewWriter(mode, {
    stderr: io.stderr,
    env: io.env,
    platform: io.platform ?? process.platform,
    clock: io.clock ?? systemClock,
    color: colorFor((values.color?.[0] ?? 'auto') as ColorWhen, true, io.env.NO_COLOR),
    view: plan.view,
  })
  io.exitHooks?.add(view.restore)
  let quorum: Quorum | undefined
  /** Whether the review has resolved: from then on an abort of the signal is no interruption of it. */
  let reviewed = false
  try {
    const selection = values.profile === undefined
      ? undefined
      : { ids: values.profile, path: '--profile' }
    await checkOutputs(plan.outputs)
    const { config, source } = await loadConfig({
      cwd: io.cwd,
      env: io.env,
      configPath: values.config,
      selection,
      failOn,
    })
    // The profiles are checked first, the room accounting among them: a profile refused for room is refused before any diff is read.
    const built = await fromConfig(config, {
      env: io.env,
      events: view.sink,
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
    // Only now is the review built: an error from the source above still writes the environment's warnings, as before.
    quorum = built
    if (read === undefined) {
      io.stdout.write(printConfig(config, source, quorum.budgets))
      return EXIT.ok
    }
    const store = state === undefined
      ? undefined
      : await openStore(io, view, resolve(io.cwd, state), config.providers)
    writeWarnings(view, quorum.warnings)
    for (const line of bannerLines(config, plan.view)) view.line('banner', line)
    const bounded = spec?.kind === 'paths'
      ? pathBounds(view, quorum, { diff: read.diff, send }, config, values.large === true)
      : undefined
    if (read.diff.trim() === '') view.line('notice', 'empty diff: nothing to review')
    view.begin(viewFacts(config, bounded?.estimate, bounded?.facts))
    // The setup's last await is behind: a signal that came before the review is called starts none, and leaves no result.
    if (io.signal?.aborted) {
      await view.close()
      view.line('notice', 'interrupted')
      return EXIT.interrupted
    }
    // From here the first signal is the review's interrupt, which resolves it with what it read, never its abort.
    const result = await quorum.review({ ...read, send }, { interrupt: io.signal, store, ...bounded?.limits })
    reviewed = true
    const { reused } = result.meta
    if (reused !== undefined && reused.research + reused.votes > 0) view.line('notice', `reused from --state: ${reused.research} research call(s), ${reused.votes} vote(s)`)
    await view.close()
    const done = outcome(result, { allowIncomplete: values['allow-incomplete'] === true })
    const input = plan.view === 'public'
      ? publicView(result)
      : result
    io.stdout.write(renderReport(input, { format: plan.format, color: plan.color, outcome: done }))
    await writeOutputs(plan.outputs, input, done)
    view.summary({
      stdout: { format: plan.format, terminal: io.stdout.isTTY === true },
      stderr: { terminal: io.stderr.isTTY === true },
      outputs: plan.outputs.map(output => output.format),
      result,
      state: store === undefined
        ? { kind: 'none', kept: 0 }
        : {
            kind: 'flag',
            kept: store.kept(),
          },
    })
    return done.exitCode
  } catch (error) {
    await view.close()
    if (io.signal?.aborted && !reviewed) {
      view.line('notice', 'interrupted')
      return EXIT.interrupted
    }
    if (error instanceof ConfigError && quorum === undefined) writeWarnings(view, readEnv(io.env).warnings)
    for (const line of errorLines(error, plan.view).split('\n')) view.line('error', line)
    return error instanceof ConfigError
      ? EXIT.usage
      : EXIT.runtime
  } finally {
    view.restore()
    io.exitHooks?.delete(view.restore)
  }
}

/** A path review's bounds, as the review keeps to them and the view shows them. */
interface PathBounds {
  /** The estimate made under the bounds, which the view weighs the parts not yet started with. */
  readonly estimate: Estimate
  /** The cap and the deadline the review is given, in place of the quorum's. */
  readonly limits: { readonly maxReviewTokens: number, readonly reviewTimeoutMs: number }
  /** The same, as the view's facts name them, the cap with where it came from. */
  readonly facts: { readonly cap: { readonly tokens: number, readonly origin: CapOrigin }, readonly deadlineMs: number }
}

/**
 * Derive a path review's bounds from its estimate and print them on stderr, before any call. A path review is a
 * codebase, so its size is the tree's: the first estimate is made under the quorum's own limits, and the cap is the
 * config's `maxReviewTokens` when it sets one, else that estimate's worst case, never below `DEFAULT_MAX_REVIEW_TOKENS`,
 * and the deadline the config's `reviewTimeoutMs`, else the longest a review may run. The estimate printed is a second
 * one, made under those bounds, with the warnings they call for: a large review, or a cap below what the estimate
 * expects. The review is never held for its size: it runs to its cap or its deadline, and what they stop is a gap.
 * `--large` warns and does nothing.
 */
function pathBounds(view: ViewWriter, quorum: Quorum, input: { readonly diff: string, readonly send: readonly string[] }, config: ResolvedConfig, large: boolean): PathBounds {
  const { worst } = quorum.estimate(input)
  const cap = config.maxReviewTokens === undefined
    ? {
        tokens: Math.max(worst, DEFAULT_MAX_REVIEW_TOKENS),
        origin: worst >= DEFAULT_MAX_REVIEW_TOKENS
          ? 'estimate'
          : 'floor',
      } as const
    : { tokens: config.maxReviewTokens, origin: 'config' } as const
  const deadlineMs = config.reviewTimeoutMs ?? MAX_TIMEOUT_MS
  const limits = { maxReviewTokens: cap.tokens, reviewTimeoutMs: deadlineMs }
  const estimate = quorum.estimate(input, limits)
  const bounds: Bounds = {
    cap: cap.origin,
    deadline: config.reviewTimeoutMs === undefined
      ? 'longest'
      : 'config',
  }
  for (const line of estimateLines(estimate, bounds)) view.line('estimate', line)
  for (const line of boundWarnings(estimate, bounds)) view.line('warning', line)
  if (large) view.line('warning', 'warning: --large is no longer needed and does nothing: a path review\'s token cap follows its estimate')
  return {
    estimate,
    limits,
    facts: { cap, deadlineMs },
  }
}

/**
 * The directory `--state` names, or undefined without the flag. It is checked with the other flags, before the source and
 * any config, and no message holds the value given: a second `--state`, an empty one, and one beside `--print-config`,
 * which reads no diff and calls no model, are usage errors.
 */
function stateDirectory(values: Flags['values']): string | undefined {
  const given = values.state
  if (given === undefined) return undefined
  const refuse = (path: string, message: string): ConfigError => new ConfigError([
    { path, message },
  ])
  if (given.length > 1) throw refuse('--state', 'takes one directory')
  if (given[0] === '') throw refuse('--state', 'must name a directory')
  if (values['print-config']) throw refuse('--print-config', 'reads no diff and calls no model, so it takes no --state')
  return given[0]
}

/**
 * The file store `--state` opens, in `directory`: its providers' identities are the config's, so a changed provider is a miss,
 * and its warnings are inert `--state:` lines on stderr. A directory it refuses is a `ConfigError` at `--state`, exit 2.
 */
function openStore(io: CliIO, view: ViewWriter, directory: string, providers: ResolvedConfig['providers']): Promise<FileStore> {
  return openFileStore(directory, {
    identities: new Map(Object.entries(providers).map(([id, provider]) => [
      id,
      providerIdentity(provider),
    ])),
    version: VERSION,
    owner: process.getuid?.(),
    platform: io.platform ?? process.platform,
    warn: line => view.line('warning', line),
  })
}

/** Write each warning as an inert `warning:` line. */
function writeWarnings(view: ViewWriter, warnings: readonly string[]): void {
  for (const warning of warnings) view.line('warning', `warning: ${warning}`)
}

/** The one source of signals the CLI listens to: `process`, or an emitter in a test. */
export interface SignalSource {
  on: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
}

/**
 * The signal of one run, aborted by the first SIGINT or SIGTERM: the setup's abort before the review runs, and the review's
 * interrupt from then on (see `runCli`). The next one calls `exit(130)`: the way out when what a provider still runs, after
 * the review settled its call, keeps the process alive.
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
