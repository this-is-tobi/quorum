import { ConfigError } from '../core/errors.ts'
import { formatWords, isReportFormat } from '../report/registry.ts'
import type { ReportFormat } from '../report/registry.ts'
import type { CliIO } from './io.ts'

/** What a run writes on stdout: the report's format, and whether it is colored. */
export interface ReportPlan {
  readonly format: ReportFormat
  readonly color: boolean
}

/**
 * The report a run writes on stdout, from the flags that choose it: `json` with no color unless `--format` names
 * another. The checks run in this order, the first that fails refused as a `ConfigError` before any config is read,
 * and no message holds the value given: `--format` with `--print-config`, which writes YAML; a second `--format`;
 * a format that is none of the reporters.
 */
export function reportPlan(values: { readonly format?: readonly string[], readonly 'print-config'?: boolean }, _io: Pick<CliIO, 'cwd' | 'env' | 'stdout'>): ReportPlan {
  const refuse = (path: string, message: string): ConfigError => new ConfigError([
    { path, message },
  ])
  const formats = values.format
  if (formats !== undefined && values['print-config'] === true) throw refuse('--print-config', 'prints the config as YAML, so it takes no --format')
  if (formats !== undefined && formats.length > 1) throw refuse('--format', 'takes one format')
  const format = formats?.[0] ?? 'json'
  if (!isReportFormat(format)) throw refuse('--format', `must be ${formatWords()}`)
  return { format, color: false }
}
