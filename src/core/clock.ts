/**
 * The time and the randomness the core reads, and the one timer it arms: the system's, unless a spec
 * injects its own. The review holds it in its context and nothing outside the core sets it.
 */
export interface Clock {
  /** Milliseconds on a monotonic clock, from an origin of its own: only the difference of two readings means anything. */
  readonly now: () => number
  /** A number from 0 up to, and not including, 1. */
  readonly random: () => number
  /** Calls `fire` once, after `ms` milliseconds; returns the function that cancels it, which may be called at any time and any number of times. */
  readonly timer: (ms: number, fire: () => void) => () => void
}

/**
 * The system's clock. Each reading goes through a function that reads the global at the call, never a
 * reference taken when the module loads, so a spec that replaces `Math.random` is seen.
 */
export const systemClock: Clock = Object.freeze({
  now: (): number => performance.now(),
  random: (): number => Math.random(),
  timer: (ms: number, fire: () => void): () => void => {
    const handle = setTimeout(fire, ms)
    return (): void => {
      clearTimeout(handle)
    }
  },
})
