import type { Stats } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { errorCode, writeAtomic } from '../bench/run-dir.ts'
import { ConfigError } from '../core/errors.ts'
import type { Outcome } from '../core/outcome.ts'
import { formatWords, isReportFormat, renderReport } from '../report/registry.ts'
import type { ReportFormat } from '../report/registry.ts'
import type { ReportInput } from '../report/reporter.ts'
import { REPORT_VIEWS } from '../report/view.ts'
import type { ReportView } from '../report/view.ts'
import type { CliIO } from './io.ts'

/** What `--color` takes: color when stdout is a terminal and `NO_COLOR` allows it (`auto`), always, or never. */
export type ColorWhen = 'auto' | 'always' | 'never'

const COLOR_WHENS: readonly ColorWhen[] = ['auto', 'always', 'never']

/** A report a run also writes to a file: its format, and the file's absolute path. */
export interface OutputFile {
  readonly format: ReportFormat
  readonly path: string
}

/** What a run writes: the report on stdout, its format and whether it is colored, the view every report is written in, and the files it also writes. */
export interface ReportPlan {
  readonly format: ReportFormat
  readonly color: boolean
  readonly view: ReportView
  readonly outputs: readonly OutputFile[]
}

/**
 * Whether a run colors the text report. `always` and `never` decide alone. `auto` colors when stdout is a
 * terminal and `NO_COLOR` is unset or empty, as no-color.org says: any other value turns color off. `NO_COLOR`
 * is the one variable read: `FORCE_COLOR` and the `CLICOLOR` family are not, so a variable a CI job or a
 * wrapper sets cannot put escape sequences into a log or a file.
 */
export function colorFor(when: ColorWhen, isTTY: boolean | undefined, noColor: string | undefined): boolean {
  if (when !== 'auto') return when === 'always'
  return isTTY === true && (noColor === undefined || noColor === '')
}

/**
 * The reports a run writes, from the flags that choose them and the terminal stdout is: stdout's format is
 * `--format`'s, else `text` when stdout is a terminal and `json` when it is not, a pipe or a file, whatever
 * stdin is. Color is for the text report on stdout alone, as `--color` says (`auto` by default, see
 * `colorFor`). Each `--output` is written `<format>=<path>`, split at the first `=`, and its path is resolved
 * against the working directory, so two outputs that name one file are refused. The checks run in this order,
 * the first that fails refused as a `ConfigError` before any config is read, and no message holds the value
 * given: `--format`, `--output` or `--view` with `--print-config`, which writes YAML; a second `--format`; a
 * format that is none of the reporters; a second `--color`; a `--color` that is none of the three; a second
 * `--view`; a `--view` that is neither `full` nor `public`; an `--output` that is not written `<format>=<path>`
 * with a reporter's format and a path; two outputs to one file. `--view` is `full` by default: it is the view
 * of stdout and of every file, and of the banner and the progress lines too. What the files
 * are is `checkOutputs`' to check, and the write `writeOutputs`'.
 */
export function reportPlan(values: { readonly format?: readonly string[], readonly color?: readonly string[], readonly view?: readonly string[], readonly output?: readonly string[], readonly 'print-config'?: boolean }, io: Pick<CliIO, 'cwd' | 'env' | 'stdout'>): ReportPlan {
  const refuse = (path: string, message: string): ConfigError => new ConfigError([
    { path, message },
  ])
  const { format: formats, color: whens, view: views, output: outputs } = values
  if ((formats !== undefined || outputs !== undefined || views !== undefined) && values['print-config'] === true) throw refuse('--print-config', 'prints the config as YAML, so it takes no --format, --output or --view')
  if (formats !== undefined && formats.length > 1) throw refuse('--format', 'takes one format')
  const format = formats?.[0] ?? (io.stdout.isTTY === true
    ? 'text'
    : 'json')
  if (!isReportFormat(format)) throw refuse('--format', `must be ${formatWords()}`)
  if (whens !== undefined && whens.length > 1) throw refuse('--color', 'takes one value')
  const when = whens?.[0] ?? 'auto'
  if (!(COLOR_WHENS as readonly string[]).includes(when)) throw refuse('--color', 'must be auto, always or never')
  if (views !== undefined && views.length > 1) throw refuse('--view', 'takes one view')
  const view = views?.[0] ?? 'full'
  if (!(REPORT_VIEWS as readonly string[]).includes(view)) throw refuse('--view', 'must be full or public')
  return {
    format,
    color: format === 'text' && colorFor(when as ColorWhen, io.stdout.isTTY, io.env.NO_COLOR),
    view: view as ReportView,
    outputs: outputFiles(outputs ?? [], io.cwd),
  }
}

/**
 * The files `--output` names, in order, each path resolved against `cwd`. The form is checked on the raw path,
 * before `resolve` can hide it: a path of `-` is refused, since it would write a file named `-` where a person
 * means stdout, and so is one that ends in `/` or `\`, which names a directory and would write a regular file
 * of the name before it.
 */
function outputFiles(values: readonly string[], cwd: string): OutputFile[] {
  const files = values.map((value): OutputFile => {
    const at = value.indexOf('=')
    const format = value.slice(0, at)
    const path = value.slice(at + 1)
    if (at === -1 || path === '' || path === '-' || /[/\\]$/.test(path) || !isReportFormat(format)) {
      throw new ConfigError([
        { path: '--output', message: `must be written <format>=<path>, the format ${formatWords()}` },
      ])
    }
    return {
      format,
      path: resolve(cwd, path),
    }
  })
  if (new Set(files.map(({ path }) => path)).size < files.length) {
    throw new ConfigError([
      { path: '--output', message: 'names one file twice' },
    ])
  }
  return files
}

/**
 * Check each output file, so a review never spends its tokens and then fails to write: its path must be a
 * regular file or no file at all, in a directory that exists. The check is for a person's sake, to refuse a
 * mistake before any call; it is no defence against a path changed afterwards, which is the rename's, since
 * `writeOutputs` replaces whatever is at the path and never writes through it. `lstat` looks at the path
 * itself, so a symbolic link is refused as one, a dangling link too, and a parent that is a link is the
 * person's own path. A message names the flag and the format, never the path.
 *
 * @throws ConfigError `--output <format>`: `is a symbolic link`, `is not a regular file`, `is in no
 * directory`, or `cannot be checked (<code>)`
 */
export async function checkOutputs(outputs: readonly OutputFile[]): Promise<void> {
  for (const { format, path } of outputs) await checkOutput(format, path)
}

/** What `find` finds at `path`: its stats, undefined when there is nothing there or a parent is no directory, or a refusal for any other failure. */
async function look(find: (path: string) => Promise<Stats>, path: string, refuse: (message: string) => ConfigError): Promise<Stats | undefined> {
  try {
    return await find(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw refuse(code === undefined
      ? 'cannot be checked'
      : `cannot be checked (${code})`)
  }
}

async function checkOutput(format: ReportFormat, path: string): Promise<void> {
  const refuse = (message: string): ConfigError => new ConfigError([
    { path: `--output ${format}`, message },
  ])
  const found = await look(lstat, path, refuse)
  if (found === undefined) {
    if (!(await look(stat, dirname(path), refuse))?.isDirectory()) throw refuse('is in no directory')
    return
  }
  if (found.isSymbolicLink()) throw refuse('is a symbolic link')
  if (!found.isFile()) throw refuse('is not a regular file')
}

/**
 * Write each output file after the report on stdout, in order, and stop at the first that fails. Each file is
 * its format's report of the same input (the result, or its public view) and outcome stdout's was made from, and is never colored: a file
 * ends up in a CI artifact or a log, where an escape sequence is noise at best. It is written whole through
 * `writeAtomic`, a new file in the file's directory and a rename, with the process's file mode, so the rename
 * replaces a link made since `checkOutputs` and never writes through it.
 *
 * @throws Error `--output <format>: cannot be written (<code>)`, which names the format and never the path
 */
export async function writeOutputs(outputs: readonly OutputFile[], input: ReportInput, outcome: Outcome): Promise<void> {
  for (const { format, path } of outputs) {
    await writeAtomic(dirname(path), basename(path), renderReport(input, { format, color: false, outcome }), { label: `--output ${format}` })
  }
}
