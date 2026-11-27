/**
 * The `quorum report` subcommand: it reads a result a review saved, from a file or stdin, and writes it in any
 * format, as the review command would have from the same run. It calls no model, reads no config and runs no git,
 * so a job that holds no key can render what another job reviewed.
 */

import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { decodeDiff } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import { outcome } from '../core/outcome.ts'
import { MAX_RESULT_BYTES, readResult } from '../report/read.ts'
import { renderReport } from '../report/registry.ts'
import { publicView } from '../report/view.ts'
import { errorLines, EXIT, parseFlags } from './io.ts'
import type { CliIO } from './io.ts'
import { checkOutputs, reportPlan, writeOutputs } from './outputs.ts'

export const REPORT_USAGE = [
  'Usage: quorum report [options] [<result>|-]',
  '',
  'Write a saved result, read from a file or stdin, in a format: no model, config or git is used.',
  '',
  'Options:',
  '  -f, --format <format>    Write the report on stdout in this format: text, json, brief, markdown, payload or sarif; text on a terminal, else json',
  '  -o, --output <output>    Also write a report to a file, written <format>=<path>; repeat it to write several',
  '      --color <when>       Color the text report: auto, on a terminal unless NO_COLOR is set; always; or never',
  '      --view <view>        Show the full result, or the public view with public: no reasoning, the finder\'s discarded findings, models or usage',
  '      --allow-incomplete   Conclude pass, as the review would with it, when every gap is a vote that failed in passing',
  '  -h, --help               Print this help and exit',
  '',
].join('\n')

const OPTIONS = {
  format: { type: 'string', short: 'f', multiple: true },
  output: { type: 'string', short: 'o', multiple: true },
  color: { type: 'string', multiple: true },
  view: { type: 'string', multiple: true },
  'allow-incomplete': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

/** A usage error of this subcommand: it names no flag, and its message holds no part of what the user typed. */
function problem(message: string): ConfigError {
  return new ConfigError([
    { path: '', message },
  ])
}

/** What went wrong reading the result file, in words that repeat no path: the system's own message holds it. */
function fileProblem(error: unknown): ConfigError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return problem('the result file does not exist')
    case 'EISDIR':
      return problem('the result file is a directory')
    default:
      return problem('the result file cannot be read')
  }
}

/**
 * The text of the result `file` names, resolved against `cwd`, or of stdin when `file` is `-` or none is named, as
 * `decodeDiff` reads it, counted in bytes: a result past `maxBytes` (256 MiB) is refused and reading stops at the chunk
 * that crosses it. A terminal with no file is refused, not waited on. Each failure is a `ConfigError` with an empty
 * path, in this code's words and never the path: no result given, no file, a directory, a file that cannot be read,
 * a result over the cap.
 */
export async function readResultText(cwd: string, file: string | undefined, stdin: CliIO['stdin'], maxBytes = MAX_RESULT_BYTES): Promise<string> {
  const piped = file === undefined || file === '-'
  if (piped && stdin.isTTY) throw problem('no result given')
  let text: string | undefined
  if (piped) {
    text = await decodeDiff(stdin, maxBytes)
  } else {
    try {
      text = await decodeDiff(createReadStream(resolve(cwd, file)), maxBytes)
    } catch (error) {
      throw fileProblem(error)
    }
  }
  if (text === undefined) throw problem('the result is over 256 MiB, the most quorum reads')
  return text
}

/**
 * Run `quorum report` and return the process exit code. It reads the result from the file its one argument names,
 * or from stdin for `-` or no argument, at most 256 MiB, through `readResult`: a result of another release or one
 * that quorum does not write is refused. Its flags are `--format`, `--output`, `--color`, `--view`,
 * `--allow-incomplete` and `--help`, each checked as the review command checks it (`reportPlan`); there is no
 * `--fail-on`, since the report concludes by the thresholds the review recorded. The steps run in this order, and
 * nothing is written before the last two: the flags, the plan, the input, the `--output` files (`checkOutputs`),
 * the review's outcome (`outcome`, lifted by `--allow-incomplete` as the review's would be), the report on stdout
 * in the plan's view, and the `--output` files (`writeOutputs`).
 *
 * It exits 0 whatever the review found, since the review's own exit code is the gate and this command only
 * renders what it saw, 2 for a usage error, an input it refuses or an `--output` it cannot use, with the message
 * and the usage on stderr and nothing on stdout, and 3 when an `--output` file cannot be written, after stdout.
 */
export async function runReport(io: CliIO, argv: readonly string[]): Promise<number> {
  try {
    const { values, positionals } = parseFlags(argv, OPTIONS)
    if (values.help) {
      io.stdout.write(REPORT_USAGE)
      return EXIT.ok
    }
    const plan = reportPlan(values, io)
    const [file, ...extra] = positionals
    if (extra.length > 0) throw problem(`takes one result file, and ${extra.length} more argument(s) were given`)
    const input = readResult(await readResultText(io.cwd, file, io.stdin))
    await checkOutputs(plan.outputs)
    const done = outcome(input, { allowIncomplete: values['allow-incomplete'] === true })
    const shown = plan.view === 'public'
      ? publicView(input)
      : input
    io.stdout.write(renderReport(shown, { format: plan.format, color: plan.color, outcome: done }))
    await writeOutputs(plan.outputs, shown, done)
    return EXIT.ok
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${errorLines(error)}\n${REPORT_USAGE}`)
      return EXIT.usage
    }
    io.stderr.write(`${errorLines(error)}\n`)
    return EXIT.runtime
  }
}
