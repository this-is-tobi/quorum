/** A clock for the specs of the call path: time moves only when a timer fires, so a deadline or a wait costs no real time. */

import type { Clock } from '../core/clock.ts'

export interface FakeClock extends Clock {
  /** The `ms` of every timer armed, in the order it was armed, the cancelled and the fired included. */
  readonly armed: number[]
  /** How many timers are armed and neither fired nor cancelled. */
  readonly pending: () => number
  /** Fires the earliest pending timer, ties in the order armed, moving time to its due time; false when none is pending. */
  readonly fireNext: () => boolean
}

interface Timer {
  readonly due: number
  readonly fire: () => void
}

/** A clock at time 0 whose `random` always answers `random`. */
export function fakeClock(random = 0.5): FakeClock {
  let time = 0
  const armed: number[] = []
  const pending = new Set<Timer>()
  return {
    armed,
    now: () => time,
    random: () => random,
    timer: (ms, fire) => {
      armed.push(ms)
      const timer: Timer = { due: time + ms, fire }
      pending.add(timer)
      return () => {
        pending.delete(timer)
      }
    },
    pending: () => pending.size,
    fireNext: () => {
      let next: Timer | undefined
      for (const timer of pending) {
        if (next === undefined || timer.due < next.due) next = timer
      }
      if (next === undefined) return false
      pending.delete(next)
      time = next.due
      next.fire()
      return true
    },
  }
}

/**
 * The outcome of `promise`, once it settles: each time the code under test waits, the earliest
 * pending timer fires. It takes a turn of the macrotask queue before each look, so every microtask
 * the code has queued has run. It throws when the promise is still open with no timer pending, or
 * after `max` timers.
 */
export async function settle<T>(clock: FakeClock, promise: Promise<T>, max = 100): Promise<T> {
  let settled = false
  promise.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  for (let fired = 0; ; fired++) {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (settled) return promise
    if (fired === max || !clock.fireNext()) throw new Error(`settle: the promise is still open with ${clock.pending()} timer(s) pending`)
  }
}
