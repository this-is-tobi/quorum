import type { QuorumEvent } from '../core/types.ts'

/**
 * The progress line of an event, or undefined for the events the CLI keeps quiet about. These lines
 * are the CLI's progress output on stderr, so a person follows a run without the full event stream.
 * Their text reaches a terminal: `detail` and `reason` hold JSON-quoted or cleaned file names today,
 * and once the sanitizer arrives (2c) any model text a line carries passes through it first.
 */
export function renderEvent(event: QuorumEvent): string | undefined {
  switch (event.type) {
    case 'stage:end':
      return event.stage === 'dedup' ? `${event.count} candidate(s) after dedup` : undefined
    case 'finding:invalid':
      return `invalid finding dropped: ${event.reason}`
    case 'incomplete':
      return `incomplete: ${event.entry.reason} (${event.entry.detail})`
    case 'run:end':
      return `${event.kept} kept, ${event.discarded} discarded, ${event.unreviewed} unreviewed by panel`
    default:
      return undefined
  }
}
