import { describe, expect, it } from 'vitest'
import { effectiveVotes, nearestRank, phi, signTest, wilson } from './stats.ts'
import { MAX_CASES } from './suite.ts'

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

  it('refuses a z outside 0 to 100, and takes both ends', () => {
    for (const z of [
      Number.NaN,
      -1,
      100.5,
      1e200,
      Number.POSITIVE_INFINITY,
    ]) expect(() => wilson(0.5, 10, z)).toThrow(RangeError)
    expect(wilson(0.5, 10, 0)).toEqual({ low: 0.5, high: 0.5 })
    expect(Object.values(wilson(0.5, 10, 100)).every(Number.isFinite)).toBe(true)
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

  it.each<[number, number, number]>([
    [30, 70, 0.0000785013964559367],
    [100, 140, 0.011664092317677663],
    [450, 550, 0.0017305360849763176],
    [0, 1000, 1.8665272370064378e-301],
    [700, 1300, 1.6293497027604705e-41],
    [900, 1100, 0.000008457089535503927],
  ])('gives the exact p, rounded once, of %i better and %i worse: %s', (better, worse, p) => {
    expect(signTest(better, worse)).toBe(p)
  })

  it('takes up to 10000 cases that differ, every count a suite can give, and refuses more', () => {
    expect(signTest(5000, 5000)).toBe(1)
    expect(() => signTest(0, MAX_CASES)).not.toThrow()
    expect(() => signTest(5000, 5001)).toThrow(RangeError)
    expect(() => signTest(10_001, 0)).toThrow(RangeError)
  })

  it('refuses a count that is not a whole number of at least 0', () => {
    for (const [better, worse] of [
      [-1, 2],
      [1.5, 2],
    ]) expect(() => signTest(better, worse)).toThrow(RangeError)
  })
})

describe('phi', () => {
  it.each<[readonly [number, number, number, number], number | undefined]>([
    [
      [10, 5, 5, 30],
      0.5238095238095238,
    ],
    [
      [5, 5, 5, 5],
      0,
    ],
    [
      [0, 10, 10, 0],
      -1,
    ],
    [
      [7, 0, 0, 3],
      1,
    ],
    [
      [0, 0, 4, 6],
      undefined,
    ],
  ])('gives the phi of the table %j: %s', ([both, onlyFirst, onlySecond, neither], value) => {
    expect(phi({ both, onlyFirst, onlySecond, neither })).toBe(value)
  })

  it('refuses a count that is not a whole number of at least 0', () => {
    for (const both of [-1, 1.5]) {
      expect(() => phi({
        both,
        onlyFirst: 0,
        onlySecond: 0,
        neither: 0,
      })).toThrow(RangeError)
    }
  })
})

describe('effectiveVotes', () => {
  it.each<[number, number, number | undefined]>([
    [3, 0, 3],
    [3, 1, 1],
    [3, 0.5, 1.5],
    [1, 0.3, 1],
    [3, -0.5, undefined],
  ])('gives %i lenses at a mean phi of %s: %s', (lenses, mean, votes) => {
    expect(effectiveVotes(lenses, mean)).toBe(votes)
  })

  it('refuses lenses that are not a positive integer, or a mean outside -1 and 1', () => {
    for (const [lenses, mean] of [
      [0, 0],
      [1.5, 0],
      [3, 1.1],
      [3, Number.NaN],
    ]) expect(() => effectiveVotes(lenses, mean)).toThrow(RangeError)
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
