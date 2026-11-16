import { ConfigError } from '../core/errors.ts'
import { formatWords, isReportFormat } from '../report/registry.ts'
import type { ReportFormat } from '../report/registry.ts'
import type { CliIO } from './io.ts'

/** What `--color` takes: color when stdout is a terminal and `NO_COLOR` allows it (`auto`), always, or never. */
export type ColorWhen = 'auto' | 'always' | 'never'

const COLOR_WHENS: readonly ColorWhen[] = ['auto', 'always', 'never']

/** What a run writes on stdout: the report's format, and whether it is colored. */
export interface ReportPlan {
  readonly format: ReportFormat
  readonly color: boolean
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
 * The report a run writes on stdout, from the flags that choose it and the terminal it writes to: `--format`'s
 * format, else `text` when stdout is a terminal and `json` when it is not, a pipe or a file, whatever stdin is.
 * Color is for the text report alone, as `--color` says (`auto` by default, see `colorFor`). The checks run in this
 * order, the first that fails refused as a `ConfigError` before any config is read, and no message holds the
 * value given: `--format` with `--print-config`, which writes YAML; a second `--format`; a format that is none of
 * the reporters; a second `--color`; a `--color` that is none of the three.
 */
export function reportPlan(values: { readonly format?: readonly string[], readonly color?: readonly string[], readonly 'print-config'?: boolean }, io: Pick<CliIO, 'cwd' | 'env' | 'stdout'>): ReportPlan {
  const refuse = (path: string, message: string): ConfigError => new ConfigError([
    { path, message },
  ])
  const { format: formats, color: whens } = values
  if (formats !== undefined && values['print-config'] === true) throw refuse('--print-config', 'prints the config as YAML, so it takes no --format')
  if (formats !== undefined && formats.length > 1) throw refuse('--format', 'takes one format')
  const format = formats?.[0] ?? (io.stdout.isTTY === true
    ? 'text'
    : 'json')
  if (!isReportFormat(format)) throw refuse('--format', `must be ${formatWords()}`)
  if (whens !== undefined && whens.length > 1) throw refuse('--color', 'takes one value')
  const when = whens?.[0] ?? 'auto'
  if (!(COLOR_WHENS as readonly string[]).includes(when)) throw refuse('--color', 'must be auto, always or never')
  return { format, color: format === 'text' && colorFor(when as ColorWhen, io.stdout.isTTY, io.env.NO_COLOR) }
}
