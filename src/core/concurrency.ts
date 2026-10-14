/** Maximum simultaneous provider calls per review (ADR-0009). */
export const DEFAULT_CONCURRENCY = 4

/** Runs `task` once a slot is free and settles with the task's own result. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

/**
 * A FIFO concurrency limiter. A finishing task hands its slot straight to the next queued task, so
 * a newcomer can never slip in between and push the count above `concurrency`.
 */
export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`)
  }
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < concurrency) {
      active++
    } else {
      await new Promise<void>(resolve => waiting.push(resolve))
    }
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
