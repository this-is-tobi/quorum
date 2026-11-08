import { inertLine } from '../core/sanitize.ts'
import type { Flag, QuorumEvent } from '../core/types.ts'

/**
 * The progress line of an event, or undefined for the events the CLI keeps quiet about. These lines
 * are the CLI's progress output on stderr, so a person follows a run without the full event stream.
 * Each line passes through `inertLine` whole: the reasons, details and file names it carries come
 * from the finder or the diff, and nothing in them can act on a terminal or a CI log.
 */
export function renderEvent(event: QuorumEvent): string | undefined {
  const line = progressLine(event)
  return line === undefined ? undefined : inertLine(line)
}

function progressLine(event: QuorumEvent): string | undefined {
  switch (event.type) {
    case 'stage:end':
      return event.stage === 'dedup' ? `${event.count} candidate(s) after dedup` : undefined
    case 'finding:invalid':
      return `invalid finding dropped: ${event.reason}`
    case 'incomplete':
      return `incomplete: ${event.entry.reason} (${event.entry.detail})`
    case 'flag':
      return `flag: ${event.flag.code}${where(event.flag)} (${event.flag.detail})`
    case 'run:end':
      return `${event.kept} kept, ${event.discarded} discarded, ${event.unreviewed} unreviewed by panel`
    default:
      return undefined
  }
}

/** Where a flag points: the file as a JSON string, with the line when it has one, else the line alone. */
function where({ file, line }: Flag): string {
  if (file !== undefined && line !== undefined) return ` at ${JSON.stringify(file)}:${line}`
  if (file !== undefined) return ` at ${JSON.stringify(file)}`
  if (line !== undefined) return ` at line ${line}`
  return ''
}
