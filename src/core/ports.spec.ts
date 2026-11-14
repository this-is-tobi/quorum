import { describe, expect, it } from 'vitest'
import { MAX_STATED_TIMEOUT_MS, retriesProblem, timeoutProblem } from './ports.ts'

describe('timeoutProblem', () => {
  it('takes a deadline of whole milliseconds from 1000 to the maximum it is given, and words any other value with what to write', () => {
    expect(timeoutProblem(1000)).toBeUndefined()
    expect(timeoutProblem(86_400_000)).toBeUndefined()
    for (const value of [
      86_400_001,
      999,
      1.5,
      '1000',
      Number.NaN,
      undefined,
    ]) {
      expect(timeoutProblem(value)).toBe('must be a whole number of milliseconds from 1000 to 86400000')
    }
    expect(timeoutProblem(518_400_000, MAX_STATED_TIMEOUT_MS)).toBeUndefined()
    expect(timeoutProblem(518_400_001, MAX_STATED_TIMEOUT_MS)).toBe('must be a whole number of milliseconds from 1000 to 518400000')
  })
})

describe('retriesProblem', () => {
  it('takes retries that are a whole number from 0 to 5, and words any other value with what to write', () => {
    expect(retriesProblem(0)).toBeUndefined()
    expect(retriesProblem(5)).toBeUndefined()
    for (const value of [
      -1,
      6,
      1.5,
      '2',
      undefined,
    ]) {
      expect(retriesProblem(value)).toBe('must be a whole number from 0 to 5')
    }
  })
})
