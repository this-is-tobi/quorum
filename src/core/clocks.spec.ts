import { describe, expect, it } from 'vitest'
import { attemptCeiling, createClocks } from './clocks.ts'
import type { AttemptSeen } from './clocks.ts'
import type { Provider } from './ports.ts'
import { targetOf } from './stages/context.ts'
import type { Target } from './stages/context.ts'

/** A target of a streaming provider named `p`, with the facts it states. */
function streaming(facts: Partial<Provider> = {}, id = 'p'): Target {
  return targetOf({
    id,
    model: 'm',
    streams: true,
    complete: async () => ({ text: '', model: 'm' }),
    ...facts,
  })
}

/** What an answered streamed attempt showed: its first token at 1000 ms, and `longestSilenceMs` as its longest silence. */
function streamed(longestSilenceMs: number): AttemptSeen {
  return {
    attemptMs: 900_000,
    firstTokenMs: 1000,
    longestSilenceMs,
    outputTokens: 100,
    answer: true,
    reasoning: false,
  }
}

describe('the ceiling of an attempt', () => {
  it.each([
    [600_000, 21_024],
    [600_000, 16_000],
    [600_000, 9_216],
    [4_218_750, 150_000],
    [86_400_000, 3_072_000],
    [86_400_000, 10_000_000],
  ])('derives a ceiling of %i ms from a reply budget of %i', (ceiling, budget) => {
    expect(attemptCeiling(undefined, budget)).toBe(ceiling)
  })

  it('keeps a stated timeoutMs whatever the budget', () => {
    expect(attemptCeiling(1000, 150_000)).toBe(1000)
    expect(attemptCeiling(518_400_000, 16_000)).toBe(518_400_000)
    expect(attemptCeiling(120_000, 10_000_000)).toBe(120_000)
  })
})

describe('the stall window', () => {
  it('gives 600000 until a streamed attempt answered, then three times the longest silence, at least 300000, never above the ceiling', () => {
    const clocks = createClocks()
    const target = streaming()
    expect(clocks.window(target, 4_218_750, true)).toBe(600_000)
    clocks.answered(target, streamed(10_000))
    expect(clocks.window(target, 4_218_750, true)).toBe(300_000)
    clocks.answered(target, streamed(150_000))
    expect(clocks.window(target, 4_218_750, true)).toBe(450_000)
    // The longest silence is kept: a shorter one later teaches nothing less.
    clocks.answered(target, streamed(20_000))
    expect(clocks.window(target, 4_218_750, true)).toBe(450_000)
    clocks.answered(target, streamed(540_000))
    expect(clocks.window(target, 4_218_750, true)).toBe(1_620_000)
    expect(clocks.window(target, 1_000_000, true)).toBe(1_000_000)
    expect(clocks.window(target, 600_000, false)).toBe(600_000)
  })

  it('gives the larger of 600000 and the learned window until the first data event', () => {
    const clocks = createClocks()
    const target = streaming()
    clocks.answered(target, streamed(10_000))
    expect(clocks.window(target, 4_218_750, false)).toBe(600_000)
    expect(clocks.window(target, 4_218_750, true)).toBe(300_000)
    clocks.answered(target, streamed(540_000))
    expect(clocks.window(target, 4_218_750, false)).toBe(1_620_000)
    expect(clocks.window(target, 900_000, false)).toBe(900_000)
  })

  it('learns from a streamed attempt alone: a whole reply, and a stream with no data event, teach nothing', () => {
    const clocks = createClocks()
    const target = streaming()
    clocks.answered(target, {
      attemptMs: 800_000,
      longestSilenceMs: 800_000,
      outputTokens: 5000,
      answer: false,
      reasoning: false,
    })
    expect(clocks.window(target, 4_218_750, true)).toBe(600_000)
    expect(clocks.window(target, 4_218_750, false)).toBe(600_000)
  })

  it('keeps a set stallTimeoutMs exactly, under the ceiling, with no learning', () => {
    const clocks = createClocks()
    const target = streaming({ stallTimeoutMs: 120_000 })
    expect(clocks.window(target, 4_218_750, true)).toBe(120_000)
    expect(clocks.window(target, 4_218_750, false)).toBe(120_000)
    clocks.answered(target, streamed(540_000))
    expect(clocks.window(target, 4_218_750, true)).toBe(120_000)
    expect(clocks.window(target, 4_218_750, false)).toBe(120_000)
    expect(clocks.window(streaming({ stallTimeoutMs: 900_000 }), 600_000, true)).toBe(600_000)
  })

  it('learns per provider object, so two providers named alike are apart', () => {
    const clocks = createClocks()
    const first = streaming({}, 'same')
    const second = streaming({}, 'same')
    clocks.answered(first, streamed(540_000))
    expect(clocks.window(first, 4_218_750, true)).toBe(1_620_000)
    expect(clocks.window(second, 4_218_750, true)).toBe(600_000)
  })
})
