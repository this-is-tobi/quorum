import { describe, expect, it } from 'vitest'
import { nearestRank, signTest, wilson } from './stats.ts'

describe('wilson', () => {
  it.each<[number, number, number, number]>([
    [0.5, 10, 0.2366, 0.7634],
    [0, 10, 0, 0.2775],
    [1, 10, 0.7225, 1],
  ])('gives the 95%% interval of a rate of %s over %i cases', (rate, n, low, high) => {
    const interval = wilson(rate, n)
    expect(interval.low).toBeCloseTo(low, 4)
    expect(interval.high).toBeCloseTo(high, 4)
  })

  it('stays inside 0 and 1', () => {
    expect(wilson(0, 10).low).toBe(0)
    expect(wilson(1, 10).high).toBe(1)
  })

  it('refuses no case, a share of cases, or a rate outside 0 and 1', () => {
    for (const [rate, n] of [
      [0.5, 0],
      [0.5, 1.5],
      [-0.1, 5],
      [1.1, 5],
    ]) expect(() => wilson(rate, n)).toThrow(RangeError)
  })
})

describe('signTest', () => {
  it.each<[number, number, number]>([
    [1, 9, 0.021484375],
    [9, 1, 0.021484375],
    [5, 15, 0.04138946533203125],
    [0, 6, 0.03125],
    [0, 5, 0.0625],
    [0, 0, 1],
    [1, 0, 1],
  ])('gives the exact two-sided p of %i better and %i worse: %s', (better, worse, p) => {
    expect(signTest(better, worse)).toBe(p)
  })

  it('stays finite and exact enough for thousands of cases', () => {
    expect(signTest(1000, 1000)).toBe(1)
    expect(signTest(0, 2000)).toBe(0)
    expect(signTest(450, 550)).toBeGreaterThan(0.0017)
    expect(signTest(450, 550)).toBeLessThan(0.0018)
  })

  it('refuses a count that is not a whole number of at least 0', () => {
    for (const [better, worse] of [
      [-1, 2],
      [1.5, 2],
    ]) expect(() => signTest(better, worse)).toThrow(RangeError)
  })
})

describe('nearestRank', () => {
  it('gives the value at rank ceil(percent * n / 100) of the sorted values', () => {
    expect(nearestRank([4, 1, 3, 2], 50)).toBe(2)
    expect(nearestRank([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(nearestRank(Array.from({ length: 20 }, (_, index) => index + 1), 95)).toBe(19)
    expect(nearestRank([5], 95)).toBe(5)
    expect(nearestRank([1, 2, 3], 100)).toBe(3)
  })

  it('refuses no value, or a share outside 0 to 100', () => {
    for (const [values, percent] of [
      [[], 50],
      [
        [1],
        0,
      ],
      [
        [1],
        101,
      ],
    ] as const) expect(() => nearestRank(values, percent)).toThrow(RangeError)
  })
})
