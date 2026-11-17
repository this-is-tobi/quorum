import { describe, expect, it } from 'vitest'
import { sessionBudget } from './budget.ts'

describe('sessionBudget', () => {
  it('holds a review while what is left covers its cap, and no longer', () => {
    const budget = sessionBudget(100)
    expect(budget.total).toBe(100)
    expect(budget.holds(100)).toBe(true)
    expect(budget.holds(101)).toBe(false)

    budget.add(1)
    expect(budget.holds(99)).toBe(true)
    expect(budget.holds(100)).toBe(false)

    budget.add(98)
    expect(budget.holds(1)).toBe(true)
    expect(budget.holds(2)).toBe(false)

    // The budget passes its total by what a provider reported above a reservation: nothing then holds.
    budget.add(50)
    expect(budget.spent()).toBe(149)
    expect(budget.holds(1)).toBe(false)
  })

  it('adds what each call spent', () => {
    const budget = sessionBudget(1000)
    expect(budget.spent()).toBe(0)
    budget.add(15)
    budget.add(0)
    budget.add(15)
    expect(budget.spent()).toBe(30)

    // A charge is never negative: a count that is not a positive number takes nothing off the spend.
    budget.add(-500)
    budget.add(Number.NaN)
    expect(budget.spent()).toBe(30)
  })
})
