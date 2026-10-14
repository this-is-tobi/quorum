import { describe, expect, it } from 'vitest'
import { createLimiter } from './concurrency.ts'

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('createLimiter', () => {
  it('never runs more than the limit at once and keeps results in order', async () => {
    const limit = createLimiter(2)
    let active = 0
    let peak = 0
    const gates = Array.from({ length: 5 }, () => deferred())
    const results = gates.map((gate, index) => limit(async () => {
      active++
      peak = Math.max(peak, active)
      await gate.promise
      active--
      return index
    }))
    for (const gate of gates) {
      await Promise.resolve()
      gate.resolve()
    }
    await expect(Promise.all(results)).resolves.toEqual([0, 1, 2, 3, 4])
    expect(peak).toBe(2)
  })

  it('starts a queued task as soon as a slot frees', async () => {
    const limit = createLimiter(1)
    const gate = deferred()
    const order: string[] = []
    const first = limit(async () => {
      order.push('a:start')
      await gate.promise
      order.push('a:end')
    })
    const second = limit(async () => {
      order.push('b:start')
    })
    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('releases the slot when a task fails', async () => {
    const limit = createLimiter(1)
    await expect(limit(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(limit(async () => 'next')).resolves.toBe('next')
  })

  it('rejects a limit that is not a positive integer', () => {
    expect(() => createLimiter(0)).toThrow(RangeError)
    expect(() => createLimiter(1.5)).toThrow(RangeError)
  })
})
