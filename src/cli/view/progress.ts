/**
 * The choice of mode, and the writer of each: `--progress` and `QUORUM_PROGRESS` pick `live`, `plain`, `json` or
 * `none`, or leave it to `auto`, which is the live view on a terminal and plain lines elsewhere. This module reads no
 * environment, platform or clock itself: the CLI hands them over, so the specs run it with injected facts.
 */

import type { Clock } from '../../core/clock.ts'
import { ConfigError } from '../../core/errors.ts'
import type { ReportView } from '../../report/view.ts'
import { glyphsFor } from './glyphs.ts'
import { jsonWriter, quietWriter } from './json.ts'
import { plainWriter } from './plain.ts'
import { liveWriter } from './terminal.ts'
import type { ViewStream, ViewWriter } from './writer.ts'

/** What `--progress` and `QUORUM_PROGRESS` take. */
export const PROGRESS_MODES = [
  'auto',
  'live',
  'plain',
  'json',
  'none',
] as const

/** A mode a review runs in: `auto` is one of the others once the terminal and the environment are read. */
export type ProgressMode = 'live' | 'plain' | 'json' | 'none'

const WORDS = 'must be auto, live, plain, json or none'

/** A variable's value trimmed, and a blank one as unset. */
function valueOf(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === ''
    ? undefined
    : value
}

/**
 * The mode a review runs in: the flag, else `QUORUM_PROGRESS`, else `auto`. `auto` is `live` when stderr is a terminal,
 * `CI` is unset or empty and `TERM` is not `dumb`, else `plain`. A refusal is a `ConfigError` at the flag or the
 * variable that chose the mode: a value that is none of the five, a flag given twice, `live` off a terminal (an
 * explicit setting that cannot be honoured is refused, not changed), and `json` with the public view, whose events are
 * the library's, whole, usage and server text included. `QUORUM_PROGRESS`, `CI` and `TERM` are read trimmed, a blank
 * value as unset.
 */
export function progressMode(given: { readonly flag?: readonly string[], readonly env: Readonly<Record<string, string | undefined>>, readonly terminal: boolean, readonly view: ReportView }): ProgressMode {
  const { flag, env, terminal, view } = given
  const refuse = (path: string, message: string): ConfigError => new ConfigError([
    { path, message },
  ])
  if (flag !== undefined && flag.length > 1) throw refuse('--progress', 'takes one mode')
  const path = flag === undefined
    ? 'QUORUM_PROGRESS'
    : '--progress'
  const chosen = flag?.[0] ?? valueOf(env, 'QUORUM_PROGRESS') ?? 'auto'
  if (!(PROGRESS_MODES as readonly string[]).includes(chosen)) throw refuse(path, WORDS)
  if (chosen === 'live' && !terminal) throw refuse(path, 'live needs stderr to be a terminal: use plain')
  if (chosen === 'json' && view === 'public') throw refuse(path, 'json writes the library\'s events, which hold usage and server text: it cannot be given with --view public')
  if (chosen !== 'auto') return chosen as ProgressMode
  return terminal && valueOf(env, 'CI') === undefined && valueOf(env, 'TERM') !== 'dumb'
    ? 'live'
    : 'plain'
}

/**
 * The writer of a mode: the live one with the glyphs of `glyphsFor(env, platform)` and `color`, the plain one with its
 * heartbeat, the JSON one, or the quiet one, the last three writing their lines to `stderr`, one text a line.
 */
export function viewWriter(mode: ProgressMode, facts: { readonly stderr: ViewStream, readonly env: Readonly<Record<string, string | undefined>>, readonly platform: string, readonly clock: Clock, readonly color: boolean, readonly view: ReportView }): ViewWriter {
  const { stderr, clock, view } = facts
  const write = (line: string): void => {
    stderr.write(`${line}\n`)
  }
  switch (mode) {
    case 'live':
      return liveWriter(stderr, {
        clock,
        glyphs: glyphsFor(facts.env, facts.platform),
        color: facts.color,
        view,
      })
    case 'plain':
      return plainWriter({ write, view, clock, heartbeat: true })
    case 'json':
      return jsonWriter(write)
    case 'none':
      return quietWriter(write)
  }
}
