import type { Clock } from '../core/clock.ts'
import type { QuorumEvent } from '../core/types.ts'
import { plural } from '../report/lines.ts'

/** How long a review may go without a note before the reporter repeats its last: the 30-minute idle window of Claude Code's stdio transport is reset by each. */
export const HEARTBEAT_MS = 60_000

/** One note to the calling client: `progress` rises by one with each, and `message` is a fixed word with a count. */
export interface ProgressNote {
  readonly progress: number
  readonly message: string
}

const READING = 'reading the change'

/**
 * What a review reports to a client that asked for progress. It counts what the review has done and says
 * nothing about it: a note is `reading the change` at the start, `research: <n> part(s) done` for the research
 * calls that ended, across the profiles, and `panel: <n> finding(s) decided` for the verdicts the panel gave.
 * A vote, a flag, a gap, a stage's end and a call of the panel carry nothing a count would show, so they send
 * no note. The notes come at the call's start, when research or the panel starts, at each research call that
 * ends and at each verdict, and the heartbeat repeats the last message 60 000 ms after each note, on `clock`,
 * so a client that cuts a call that is silent for a minute is never silent that long.
 *
 * `progress` is the notification's own number, 1, 2, 3, and not a share of a total: a review's total is not
 * known before research ends, and the protocol asks only that `progress` rise. No message holds a profile id,
 * a file name or text of the change.
 *
 * The first note is sent at once, `onEvent` is the sink the review's events go to, and `stop` cancels the
 * heartbeat: once stopped, nothing is sent. It never throws, so no failure of the client's wire ends a review.
 */
export function progressReporter(send: (note: ProgressNote) => void, clock: Clock): { readonly onEvent: (event: QuorumEvent) => void, readonly stop: () => void } {
  let progress = 0
  let message = READING
  let parts = 0
  let decided = 0
  let stopped = false
  let cancel: (() => void) | undefined

  const note = (text: string): void => {
    if (stopped) return
    cancel?.()
    message = text
    progress += 1
    try {
      send({ progress, message })
    } catch {
      // The client's wire failed: the review goes on, and the next note may get through.
    }
    cancel = clock.timer(HEARTBEAT_MS, () => note(message))
  }
  const researched = (): string => `research: ${plural(parts, 'part')} done`
  const judged = (): string => `panel: ${plural(decided, 'finding')} decided`

  note(READING)
  return {
    onEvent: (event) => {
      if (event.type === 'stage:start') {
        if (event.stage === 'research') note(researched())
        else if (event.stage === 'panel') note(judged())
      } else if (event.type === 'call' && event.role === 'research') {
        parts += 1
        note(researched())
      } else if (event.type === 'verdict') {
        decided += 1
        note(judged())
      }
    },
    stop: () => {
      stopped = true
      cancel?.()
      cancel = undefined
    },
  }
}
