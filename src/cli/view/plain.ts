/**
 * Plain mode, the CI and screen-reader view: one line of text for each event worth a line and for each line of the
 * CLI's own, no glyph, no colour and no control sequence, and, in a quiet minute, a heartbeat that says where the
 * review stands. It is a fold of the review's events (`model.ts`) written as lines (`lines.ts`).
 */

import type { Clock } from '../../core/clock.ts'
import { systemClock } from '../../core/clock.ts'
import { inertLine } from '../../core/sanitize.ts'
import type { ReportView } from '../../report/view.ts'
import { heartbeatLine, logLines } from './lines.ts'
import { DEFAULT_FACTS, fold, startState } from './model.ts'
import type { ViewFacts } from './model.ts'
import type { ViewWriter } from './writer.ts'

/** The quiet that earns a heartbeat. */
export const HEARTBEAT_MS = 60_000

/**
 * The plain writer: each event's log lines and each CLI line are handed to `write` as they come. With `heartbeat`, a
 * timer of `HEARTBEAT_MS` is armed at each line written while a review runs (after `run:start`, before `run:end`),
 * and writes the heartbeat when it fires, then arms again. `facts` are the review's, which `begin` sets again
 * for each review; the clock is the system's unless given.
 */
export function plainWriter(options: { readonly write: (line: string) => void, readonly view?: ReportView, readonly clock?: Clock, readonly heartbeat?: boolean, readonly facts?: ViewFacts }): ViewWriter {
  const { write, heartbeat = false } = options
  const view = options.view ?? 'full'
  const clock = options.clock ?? systemClock
  let state = startState(options.facts ?? DEFAULT_FACTS)
  let running = false
  let stopped = false
  let cancel: (() => void) | undefined

  const disarm = (): void => {
    cancel?.()
    cancel = undefined
  }
  const arm = (): void => {
    disarm()
    if (!heartbeat || !running || stopped) return
    cancel = clock.timer(HEARTBEAT_MS, () => {
      cancel = undefined
      write(heartbeatLine(state, clock.now(), view))
      arm()
    })
  }
  const emit = (text: string): void => {
    write(text)
    arm()
  }

  return {
    sink: (event) => {
      state = fold(state, event, clock.now())
      if (event.type === 'run:start') running = true
      if (event.type === 'run:end') running = false
      for (const { text } of logLines(event, state, view)) emit(text)
      if (event.type === 'run:start' || event.type === 'run:end') arm()
    },
    line: (_level, text) => {
      emit(inertLine(text))
    },
    begin: (facts) => {
      state = startState(facts)
    },
    close: () => {
      stopped = true
      disarm()
      return Promise.resolve()
    },
    restore: () => {
      stopped = true
      disarm()
    },
  }
}
