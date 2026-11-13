/**
 * The `quorum bench` subcommand: it reviews every case of a suite with every configuration, `--trials`
 * times each, records each review in a run directory it can resume, and reports what each configuration
 * caught. It ties the bench modules to the CLI: the flags, the plan, the progress lines and the exit codes.
 */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../../package.json' with { type: 'json' }
import { fingerprint, newSalt } from '../bench/fingerprint.ts'
import { MAX_CONFIGURATIONS, reviewKey, RUN_FORMAT } from '../bench/records.ts'
import type { ReviewRecord, RunConfiguration, RunFile } from '../bench/records.ts'
import { buildReport, reportJson, reportMarkdown, reviewScore } from '../bench/report.ts'
import type { ReviewScore } from '../bench/report.ts'
import { createRun, inspectRunDir, openRecords, readRecords, REPORT_JSON, REPORT_MARKDOWN, runDifferences, writeAtomic } from '../bench/run-dir.ts'
import type { RunState } from '../bench/run-dir.ts'
import { planReviews, runReviews } from '../bench/runner.ts'
import type { BenchReview, RunReviewsOutcome } from '../bench/runner.ts'
import { loadSuite, MAX_TRIALS, SUITE_ID } from '../bench/suite.ts'
import type { Suite, SuiteCase } from '../bench/suite.ts'
import { readEnv } from '../config/env.ts'
import { fromConfig } from '../config/from-config.ts'
import { loadConfig } from '../config/load.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { inertLine } from '../core/sanitize.ts'
import { errorLines, errorMessage } from './io.ts'
import type { CliIO } from './io.ts'
import { profileProviders } from './render.ts'

export const BENCH_USAGE = [
  'Usage: quorum bench [options] <suite>',
  '',
  'Review every case of a suite with every config, --trials times each, and report what each caught.',
  '',
  'Options:',
  '  -c, --config <path>     A config file to compare; repeat it, and the first is the reference',
  '  -p, --profile <id>      Run only this profile; repeat it to run several',
  '      --trials <n>        Reviews of each case per config: the suite\'s trials, else 1',
  '      --case <id>         Run only this case; repeat it to run several',
  '  -j, --jobs <n>          The reviews run at once (default 1)',
  '  -o, --out <dir>         The run directory (default quorum-bench/<suite name>)',
  '      --retry-incomplete  Run again the recorded reviews that came back incomplete',
  '      --dry-run           Check the suite and the configs, print the plan, and exit',
  '  -h, --help              Print this help and exit',
  '',
].join('\n')

/**
 * The bench's own exit codes (Decision 18), not the review's `EXIT`: `failed` means reviews failed and were
 * not recorded, not that a review left a gap, and `stopped` means the run could not go on.
 */
const BENCH_EXIT = {
  ok: 0,
  usage: 2,
  stopped: 3,
  failed: 4,
  interrupted: 130,
} as const

const MAX_JOBS = 16
const DEFAULT_CONFIGURATION = '(default configuration)'
const TORN_LINE = 'warning: results.jsonl: its last line was cut short, as a stopped run leaves it: that review runs again'

const OPTIONS = {
  config: { type: 'string', short: 'c', multiple: true },
  profile: { type: 'string', short: 'p', multiple: true },
  trials: { type: 'string' },
  case: { type: 'string', multiple: true },
  jobs: { type: 'string', short: 'j' },
  out: { type: 'string', short: 'o' },
  'retry-incomplete': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

/** What the flags say, checked. */
interface BenchOptions {
  readonly suite: string
  readonly configs: readonly string[]
  readonly profiles: readonly string[] | undefined
  readonly trials: number | undefined
  readonly cases: readonly string[]
  readonly jobs: number
  readonly out: string | undefined
  readonly retryIncomplete: boolean
  readonly dryRun: boolean
}

/** A configuration as loaded: the path it was named by (none for the usual resolution), the resolved config and the warnings of building it. */
interface LoadedConfiguration {
  readonly path: string | undefined
  readonly config: ResolvedConfig
  readonly warnings: readonly string[]
}

/** The flags of `argv` and its positional arguments; a usage error of `parseArgs` is raised as a `ConfigError`, one issue per line of its message. */
function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    if (!(error instanceof Error) || !(error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS_')) throw error
    throw new ConfigError(error.message.split('\n').map(message => ({ path: '', message })))
  }
}

function usageIssue(path: string, message: string): ConfigError {
  return new ConfigError([
    { path, message },
  ])
}

/** `text` as a whole number from 1 to `max`; undefined when the flag was not given. */
function wholeNumber(flag: string, text: string | undefined, max: number): number | undefined {
  if (text === undefined) return undefined
  if (!/^[1-9]\d*$/.test(text) || Number(text) > max) throw usageIssue(flag, `must be a whole number from 1 to ${max}`)
  return Number(text)
}

/** The options the flags of `argv` give, or the usage error they hold. */
function checkOptions(values: ReturnType<typeof parseFlags>['values'], positionals: readonly string[]): BenchOptions {
  const [suite, ...extra] = positionals
  if (suite === undefined) throw new Error('no suite given')
  if (extra.length > 0) throw new Error(`unexpected arguments: ${extra.join(' ')}`)
  const trials = wholeNumber('--trials', values.trials, MAX_TRIALS)
  const jobs = wholeNumber('--jobs', values.jobs, MAX_JOBS)
  const configs = values.config ?? []
  if (configs.includes('')) throw usageIssue('--config', 'must name a file')
  if (configs.length > MAX_CONFIGURATIONS) throw usageIssue('--config', `names more than ${MAX_CONFIGURATIONS} configurations`)
  if (values.out === '') throw usageIssue('--out', 'must name a directory')
  const cases = values.case ?? []
  if (cases.some(id => !SUITE_ID.test(id))) throw usageIssue('--case', `must be a case id matching ${SUITE_ID.source}`)
  if (new Set(cases).size < cases.length) throw usageIssue('--case', 'names a case more than once')
  return {
    suite,
    configs,
    profiles: values.profile,
    trials,
    cases,
    jobs: jobs ?? 1,
    out: values.out,
    retryIncomplete: values['retry-incomplete'] === true,
    dryRun: values['dry-run'] === true,
  }
}

/** Write `lines` to `stream`, each inert, one write per line. */
function writeLines(stream: CliIO['stderr'], lines: readonly string[]): void {
  for (const line of lines) stream.write(`${inertLine(line)}\n`)
}

function nameOf({ path }: RunConfiguration): string {
  return path ?? DEFAULT_CONFIGURATION
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1
    ? ''
    : 's'}`
}

/** The cases of `suite` the flags select, in the suite's order; every `--case` must be one of its cases. */
function selectCases(suite: Suite, ids: readonly string[]): readonly SuiteCase[] {
  const unknown = ids.filter(id => !suite.cases.some(suiteCase => suiteCase.id === id))
  if (unknown.length > 0) throw new ConfigError(unknown.map(id => ({ path: '--case', message: `unknown case "${id}"` })))
  return ids.length === 0
    ? suite.cases
    : suite.cases.filter(({ id }) => ids.includes(id))
}

/**
 * Each configuration, in order: loaded with the run's `--profile` selection, then built once, as a review
 * builds it, so one that cannot be built is refused before any call, and its warnings are known. With no
 * `--config`, the usual resolution is the one configuration. The first that fails ends the run, after the
 * environment's warnings, since a deprecated or mistyped variable is often what caused the error.
 */
async function loadConfigurations(io: CliIO, options: BenchOptions): Promise<LoadedConfiguration[]> {
  const selection = options.profiles === undefined
    ? undefined
    : { ids: options.profiles, path: '--profile' }
  const paths: ReadonlyArray<string | undefined> = options.configs.length === 0
    ? [undefined]
    : options.configs
  const loaded: LoadedConfiguration[] = []
  try {
    for (const path of paths) {
      const { config } = await loadConfig({
        cwd: io.cwd,
        env: io.env,
        configPath: path,
        selection,
      })
      const quorum = await fromConfig(config, { env: io.env })
      loaded.push({ path, config, warnings: quorum.warnings })
    }
  } catch (error) {
    if (error instanceof ConfigError) writeLines(io.stderr, readEnv(io.env).warnings.map(warning => `warning: ${warning}`))
    throw error
  }
  return loaded
}

/** One issue for each configuration whose fingerprint an earlier one already has. */
function duplicateIssues(configurations: readonly RunConfiguration[]): ConfigIssue[] {
  const earliest = new Map<string, RunConfiguration>()
  const issues: ConfigIssue[] = []
  for (const configuration of configurations) {
    const earlier = earliest.get(configuration.fingerprint)
    if (earlier === undefined) earliest.set(configuration.fingerprint, configuration)
    else issues.push({ path: '--config', message: `${nameOf(configuration)} resolves to the same settings as ${nameOf(earlier)}: a QUORUM_* variable overrides every configuration alike` })
  }
  return issues
}

/** What a recorded review says of its case, as its progress line puts it. */
function verdictOf(suiteCase: SuiteCase, score: ReviewScore): string {
  if (suiteCase.kind === 'control') return 'control'
  if (score.keptCatch) return 'caught by a kept finding'
  return score.proposedCatch
    ? 'caught by a proposed finding only'
    : 'missed'
}

/** The progress line of a review that was recorded, after `[<n>/<total>] trial <t>, case <id>, configuration <i>: `. */
function recordedText(record: ReviewRecord, suiteCase: SuiteCase, score: ReviewScore): string {
  const { kept, discarded, unreviewed, meta } = record.result
  return `${verdictOf(suiteCase, score)}; ${kept.length} kept, ${discarded.length} discarded, ${unreviewed.length} unreviewed, ${meta.incomplete.length} gaps; ${(record.latencyMs / 1000).toFixed(1)} s`
}

/** The plan a run prints before its first call. */
function planLines(plan: {
  readonly suite: Suite
  readonly selected: readonly SuiteCase[]
  readonly loaded: readonly LoadedConfiguration[]
  readonly trials: number
  readonly planned: number
  readonly recorded: number
  readonly toRun: number
  readonly again: number
  readonly jobs: number
  readonly directory: string
}): string[] {
  const { suite, selected, loaded, trials, planned, recorded, toRun, again, jobs, directory } = plan
  const bugs = selected.filter(({ kind }) => kind === 'bug').length
  return [
    `Suite ${suite.name}: ${selected.length} of ${suite.cases.length} cases, ${plural(bugs, 'bug case')} and ${plural(selected.length - bugs, 'control')}`,
    'Configurations:',
    ...loaded.flatMap(({ path, config }, index) => [
      `  ${index + 1}. ${path ?? DEFAULT_CONFIGURATION}${loaded.length > 1 && index === 0
        ? ' (reference)'
        : ''}`,
      ...profileProviders(config).map(({ profile, research, panel }) => `     ${profile}: research ${research}; panel ${panel}`),
    ]),
    `Trials: ${trials}`,
    `Reviews: ${planned} planned, ${recorded} recorded, ${toRun} to run${again > 0
      ? ` (${again} of them again)`
      : ''}, at most ${jobs} at a time`,
    `Run directory: ${directory}`,
  ]
}

/** What a run is made of once the suite, the configurations and the run directory are checked. */
interface Checked {
  readonly suite: Suite
  /** The cases the flags select, in the suite's order. */
  readonly selected: readonly SuiteCase[]
  readonly loaded: readonly LoadedConfiguration[]
  /** Every case of the suite by its id, the unselected ones too: a record of an earlier run may name one. */
  readonly byId: ReadonlyMap<string, SuiteCase>
  /** The run directory as the plan names it: `--out` as given, or the default. */
  readonly directory: string
  /** The run directory as a path. */
  readonly out: string
  readonly state: RunState
  /** What `run.json` holds, or will hold. */
  readonly runFile: RunFile
}

/**
 * Check everything a run depends on before its first call, and write nothing: the suite, the cases, the
 * configurations (loaded and built), the run directory, and that the run it holds, if any, is this one.
 * The fingerprints are keyed with the salt of the run being resumed, else a new one.
 */
async function check(io: CliIO, options: BenchOptions): Promise<Checked> {
  const suite = await loadSuite(resolve(io.cwd, options.suite), options.suite)
  const selected = selectCases(suite, options.cases)
  const loaded = await loadConfigurations(io, options)
  const directory = options.out ?? `quorum-bench/${suite.name}`
  const out = resolve(io.cwd, directory)
  const state = await inspectRunDir(out)
  const salt = state.kind === 'run'
    ? state.run.salt
    : newSalt()
  const configurations = loaded.map(({ path, config }): RunConfiguration => ({
    path: path ?? null,
    fingerprint: fingerprint(config, salt),
  }))
  const duplicates = duplicateIssues(configurations)
  if (duplicates.length > 0) throw new ConfigError(duplicates)
  const runFile: RunFile = {
    format: RUN_FORMAT,
    quorum: packageJson.version,
    suite: { name: suite.name, hash: suite.hash },
    salt,
    configurations,
  }
  if (state.kind === 'run') {
    const differences = runDifferences(state.run, runFile)
    if (differences.length > 0) throw new ConfigError(differences)
  }
  const byId = new Map(suite.cases.map(suiteCase => [suiteCase.id, suiteCase]))
  return {
    suite,
    selected,
    loaded,
    byId,
    directory,
    out,
    state,
    runFile,
  }
}

/** `record` scored against its case and kept in `scores` under its key, replacing an earlier record of the same review. */
function keepScore(scores: Map<string, ReviewScore>, record: ReviewRecord, suiteCase: SuiteCase, window: number): ReviewScore {
  const scored = reviewScore(record, suiteCase, window)
  scores.set(reviewKey(record.fingerprint, record.case, record.trial), scored)
  return scored
}

/**
 * The score of every review the run being resumed holds, by `reviewKey`, and where its valid lines end
 * (what `openRecords` cuts to). A line that names a configuration the run does not have, or a case the suite
 * does not have, refuses the run directory. A last line a killed run cut short is not scored, and says so.
 * A new run holds nothing.
 */
async function readScores(io: CliIO, { suite, byId, out, state, runFile }: Checked): Promise<{ readonly scores: Map<string, ReviewScore>, readonly validBytes: number }> {
  const scores = new Map<string, ReviewScore>()
  if (state.kind !== 'run') return { scores, validBytes: 0 }
  const known = new Set(runFile.configurations.map(({ fingerprint }) => fingerprint))
  const read = await readRecords(out, (record) => {
    const suiteCase = byId.get(record.case)
    if (!known.has(record.fingerprint)) return 'names a configuration this run does not have'
    if (suiteCase === undefined) return 'names a case the suite does not have'
    keepScore(scores, record, suiteCase, suite.window)
    return undefined
  })
  if (read.torn) writeLines(io.stderr, [TORN_LINE])
  return { scores, validBytes: read.validBytes }
}

/**
 * Make the run (when it is new), open `results.jsonl` and run the reviews of `toRun`, each recorded as it
 * resolves and each reported with its progress line. The order matters: `createRun` renames over any
 * run.json and `openRecords` cuts results.jsonl to the bytes it is given, so a run being resumed has been
 * read before either, and only a new run is created. The writer is closed whatever happens; when the run
 * rejects, with the error of a failed write, that error is the one thrown.
 */
async function execute(io: CliIO, options: BenchOptions, checked: Checked, scores: Map<string, ReviewScore>, validBytes: number, toRun: readonly BenchReview[]): Promise<RunReviewsOutcome> {
  const { suite, loaded, byId, out, state, runFile } = checked
  if (state.kind !== 'run') await createRun(out, runFile)
  const writer = await openRecords(out, validBytes)
  let finished = 0
  let outcome: RunReviewsOutcome
  try {
    outcome = await runReviews({
      suite,
      configurations: loaded.map(({ config }, index) => ({ config, fingerprint: runFile.configurations[index].fingerprint })),
      reviews: toRun,
      jobs: options.jobs,
      env: io.env,
      signal: io.signal,
      append: writer.append,
      events: (event) => {
        finished += 1
        const { trial, caseId, configuration } = event.review
        const suiteCase = byId.get(caseId) as SuiteCase
        const text = event.type === 'recorded'
          ? recordedText(event.record, suiteCase, keepScore(scores, event.record, suiteCase, suite.window))
          : `failed: ${errorMessage(event.error)}`
        writeLines(io.stderr, [`[${finished}/${toRun.length}] trial ${trial}, case ${caseId}, configuration ${configuration + 1}: ${text}`])
      },
    })
  } catch (error) {
    await writer.close().catch(() => undefined)
    throw error
  }
  await writer.close()
  return outcome
}

/** Build the report from the scores, write `report.md` and `report.json` into the run directory, and print the Markdown. */
async function writeReports(io: CliIO, { suite, selected, out, runFile }: Checked, trials: number, scores: ReadonlyMap<string, ReviewScore>): Promise<void> {
  const report = buildReport({
    suite: { name: suite.name, window: suite.window },
    quorum: packageJson.version,
    cases: selected,
    trials,
    configurations: runFile.configurations,
    scores,
  })
  const markdown = reportMarkdown(report)
  await writeAtomic(out, REPORT_MARKDOWN, markdown)
  await writeAtomic(out, REPORT_JSON, reportJson(report))
  io.stdout.write(markdown)
}

/** One whole bench run: the checks, the plan, the reviews and the reports; what ends it early is thrown. */
async function bench(io: CliIO, options: BenchOptions): Promise<number> {
  const checked = await check(io, options)
  const { suite, selected, loaded, directory, runFile } = checked
  const { scores, validBytes } = await readScores(io, checked)

  const trials = options.trials ?? suite.trials ?? 1
  const planned = planReviews({
    trials,
    cases: selected.map(({ id }) => id),
    configurations: runFile.configurations.length,
  })
  const scoreOf = ({ configuration, caseId, trial }: BenchReview): ReviewScore | undefined => scores.get(reviewKey(runFile.configurations[configuration].fingerprint, caseId, trial))
  const toRun = planned.filter((review) => {
    const recorded = scoreOf(review)
    return recorded === undefined || (options.retryIncomplete && recorded.incomplete)
  })

  writeLines(io.stderr, loaded.flatMap(({ warnings }, index) => warnings.map(warning => `warning: configuration ${index + 1}: ${warning}`)))
  writeLines(options.dryRun ? io.stdout : io.stderr, planLines({
    suite,
    selected,
    loaded,
    trials,
    planned: planned.length,
    recorded: planned.filter(review => scoreOf(review) !== undefined).length,
    toRun: toRun.length,
    again: toRun.filter(review => scoreOf(review) !== undefined).length,
    jobs: options.jobs,
    directory,
  }))
  if (options.dryRun) {
    writeLines(io.stdout, ['Dry run: no review was run, and nothing was written.'])
    return BENCH_EXIT.ok
  }
  if (io.signal?.aborted) {
    io.stderr.write('interrupted\n')
    return BENCH_EXIT.interrupted
  }

  const outcome = await execute(io, options, checked, scores, validBytes, toRun)
  await writeReports(io, checked, trials, scores)
  if (outcome.interrupted) {
    io.stderr.write('interrupted\n')
    return BENCH_EXIT.interrupted
  }
  return outcome.failed > 0
    ? BENCH_EXIT.failed
    : BENCH_EXIT.ok
}

/** Write a usage error and the usage, and return its exit code. */
function usageError(io: CliIO, error: unknown): number {
  io.stderr.write(`${errorLines(error)}\n${BENCH_USAGE}`)
  return BENCH_EXIT.usage
}

/**
 * Run `quorum bench` with its arguments (those after `bench`) and return the exit code. Never throws.
 *
 * It reviews every case of the suite the argument names with every `--config` (the usual resolution when
 * there is none), `--trials` times each, at most `--jobs` at once, and records each review that resolved
 * in the run directory `--out` names (`quorum-bench/<suite name>` by default), one line of `results.jsonl`
 * at a time. It prints the plan on stderr before the first call (on stdout with `--dry-run`, which then
 * stops and writes nothing), a progress line on stderr for each finished review, and the Markdown report
 * on stdout, which it also writes, with `report.json`, into the run directory.
 *
 * A run directory that holds a run resumes it: the reviews it records are not run again, `--retry-incomplete`
 * runs again those that came back incomplete, and a last line a killed run cut short is dropped, with a
 * warning. A run directory of another suite, another quorum or other configurations, one that holds files
 * of another kind, and a suite or a configuration that does not validate or cannot be built are refused
 * before the first call.
 *
 * Exit codes: 0 when every planned review is recorded, 2 for a usage, suite, configuration or run
 * directory error, 3 when the run stops (a file cannot be written or read), 4 when a review failed (the
 * others are recorded, and the next run runs the failed ones), 130 when interrupted. The reports are
 * written on 0, 4 and 130, so a stopped run shows what it recorded; an interrupt that comes before the
 * first review starts leaves the run directory untouched, even one that does not exist yet.
 *
 * Every line it writes is inert (invariant I3).
 */
export async function runBench(io: CliIO, argv: readonly string[]): Promise<number> {
  let options: BenchOptions
  try {
    const { values, positionals } = parseFlags(argv)
    if (values.help) {
      io.stdout.write(BENCH_USAGE)
      return BENCH_EXIT.ok
    }
    options = checkOptions(values, positionals)
  } catch (error) {
    return usageError(io, error)
  }
  try {
    return await bench(io, options)
  } catch (error) {
    if (io.signal?.aborted) {
      io.stderr.write('interrupted\n')
      return BENCH_EXIT.interrupted
    }
    io.stderr.write(`${errorLines(error)}\n`)
    return error instanceof ConfigError
      ? BENCH_EXIT.usage
      : BENCH_EXIT.stopped
  }
}
