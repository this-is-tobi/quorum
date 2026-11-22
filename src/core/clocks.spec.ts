import { describe, expect, it } from 'vitest'
import { attemptCeiling, createClocks, CUT_MARGIN, grownCeiling, GROWTH_FLOOR_MS_PER_TOKEN } from './clocks.ts'
import type { AttemptSeen } from './watch.ts'
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

describe('the ceiling that grows with a stream', () => {
  it.each([
    [
      600_000,
      2_522_880,
      5000,
      21_024,
      600_000,
    ],
    [
      600_000,
      10_512_000,
      500,
      21_024,
      600_000,
    ],
    [
      600_000,
      600_000,
      30_000,
      21_024,
      600_000,
    ],
    [
      600_000,
      10_512_000,
      0,
      21_024,
      600_000,
    ],
    [
      4_218_750,
      75_000_000,
      1000,
      150_000,
      4_218_750,
    ],
    [
      5_625_000,
      86_400_000,
      10,
      200_000,
      5_625_000,
    ],
  ])('grows a ceiling of %i ms to %i ms for %i tokens of a %i-token budget after %i ms', (derived, grown, tokens, budget, after) => {
    expect(grownCeiling(derived, budget, tokens, after)).toBe(grown)
  })

  it('floors the pace at 2 tokens a second, and never shrinks a ceiling', () => {
    expect(GROWTH_FLOOR_MS_PER_TOKEN).toBe(500)
    expect(grownCeiling(3_000_000, 21_024, 25_000, 3_000_000)).toBe(3_000_000)
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

describe('a learned cut', () => {
  /** What a cut stream showed: reasoning and no answer, `outputTokens` of output, by an attempt of 900 s. */
  const cutStream = (outputTokens: number, facts: Partial<AttemptSeen> = {}): AttemptSeen => ({
    attemptMs: 900_000,
    firstTokenMs: 1000,
    longestSilenceMs: 300_000,
    outputTokens,
    answer: false,
    reasoning: true,
    ...facts,
  })
  /** An answered attempt of `attemptMs` that showed `outputTokens`. */
  const answeredIn = (attemptMs: number, outputTokens: number, facts: Partial<AttemptSeen> = {}): AttemptSeen => ({
    attemptMs,
    firstTokenMs: 1000,
    longestSilenceMs: 10_000,
    outputTokens,
    answer: true,
    reasoning: false,
    ...facts,
  })

  it.each<[number, number, boolean]>([
    [900_120, 900_110, true],
    [600_150, 600_140, true],
    [900_000, 940_000, true],
    [100_000, 104_000, true],
    [100_000, 106_000, false],
    [60_000, 600_000, false],
  ])('learns a cut from two attempts of %i and %i ms: %s', (first, second, learns) => {
    const clocks = createClocks()
    const target = streaming()
    expect(clocks.cut(target, first, undefined)).toEqual({})
    expect(clocks.cut(target, second, undefined)).toEqual(learns
      ? {
          cutOff: 'reply',
          learned: {
            afterMs: Math.min(first, second),
            lowered: false,
          },
        }
      : {})
  })

  it('reads an attempt cut at the learned length less the tolerance or later as cut off: thinking with reasoning and no answer, else reply', () => {
    const clocks = createClocks()
    const target = streaming()
    clocks.cut(target, 900_000, cutStream(10))
    expect(clocks.cut(target, 900_000, cutStream(10))).toMatchObject({
      cutOff: 'thinking',
      learned: { afterMs: 900_000 },
    })
    // The lesson is told once, and the tolerance of 5 percent of 900 s is 45 s.
    expect(clocks.cut(target, 900_000, cutStream(10))).toEqual({ cutOff: 'thinking' })
    expect(clocks.cut(target, 855_000, cutStream(10))).toEqual({ cutOff: 'thinking' })
    expect(clocks.cut(target, 954_000, cutStream(10, { answer: true }))).toEqual({ cutOff: 'reply' })
    expect(clocks.cut(target, 900_000, cutStream(10, { reasoning: false }))).toEqual({ cutOff: 'reply' })
    expect(clocks.cut(target, 900_000, undefined)).toEqual({ cutOff: 'reply' })
    // A cut shorter than that, or a call that is another provider's, is no part of the lesson.
    expect(clocks.cut(target, 854_999, cutStream(10))).toEqual({})
    expect(clocks.cut(streaming(), 900_000, cutStream(10))).toEqual({})
  })

  it('measures the rate from the attempts cut at the learned length, the lowest, and holds four fifths of the cut, at least 1024', () => {
    const clocks = createClocks()
    const target = streaming()
    expect(CUT_MARGIN).toBe(0.8)
    // A cut stream of 45000 estimated tokens over 900 s: 0.05 a millisecond, so 900 s hold 45000 and four fifths of them 36000.
    clocks.cut(target, 900_000, cutStream(45_000))
    expect(clocks.cut(target, 900_000, cutStream(45_000))).toEqual({
      cutOff: 'thinking',
      learned: { afterMs: 900_000, holds: 36_000, lowered: true },
    })
    expect(clocks.ceiling(target)).toBe(36_000)

    // The lowest of the two that taught the cut counts, over its own length: 30000 tokens over 910 s let 900 s through 29670, four fifths of it 23736.
    const lowest = createClocks()
    lowest.cut(target, 910_000, cutStream(30_000, { attemptMs: 910_000 }))
    expect(lowest.cut(target, 900_000, cutStream(45_000))).toMatchObject({
      learned: { afterMs: 900_000, holds: 23_736 },
    })

    // An attempt that showed no count is left out, as is one that streamed none.
    const uncounted = createClocks()
    uncounted.cut(target, 900_000, undefined)
    expect(uncounted.cut(target, 900_000, cutStream(45_000))).toMatchObject({
      learned: { holds: 36_000 },
    })

    const tiny = createClocks()
    tiny.cut(target, 900_000, cutStream(5))
    expect(tiny.cut(target, 900_000, cutStream(5))).toMatchObject({
      learned: { holds: 1024 },
    })
  })

  it('learns no rate from an answered attempt, whatever it waited for its first token', () => {
    const clocks = createClocks()
    const target = streaming()
    // A part queued 120 s, then answered 2200 tokens at 164 s: 0.0134 a millisecond, which scaled up to the cut would hold 9658.
    clocks.answered(target, answeredIn(164_000, 2200, { firstTokenMs: 120_000 }))
    clocks.cut(target, 900_000, cutStream(45_000))
    expect(clocks.cut(target, 900_000, cutStream(45_000))).toMatchObject({
      learned: { holds: 36_000 },
    })
  })

  it('holds what the cut streamed to the whole number, with no float rounding it down', () => {
    const clocks = createClocks()
    const target = streaming()
    // 8535 tokens over 67919 ms, the cut's own length: four fifths of 8535 is 6828, where a float rate times the length reads 6827.
    clocks.cut(target, 67_919, cutStream(8535, { attemptMs: 67_919 }))
    expect(clocks.cut(target, 67_919, cutStream(8535, { attemptMs: 67_919 }))).toMatchObject({
      learned: {
        afterMs: 67_919,
        holds: Math.floor(8535 * 0.8),
      },
    })
    expect(Math.floor(8535 * 0.8)).toBe(6828)
  })

  it('holds nothing and lowers nothing when no rate was measured', () => {
    const clocks = createClocks()
    const target = streaming()
    // A whole reply cut, a stream that showed no count, and an answered attempt, which teaches no rate: no rate.
    clocks.answered(target, answeredIn(300_000, 500))
    clocks.cut(target, 900_000, undefined)
    const learned = clocks.cut(target, 900_000, cutStream(0))
    expect(learned).toEqual({
      cutOff: 'thinking',
      learned: { afterMs: 900_000, lowered: false },
    })
    expect(learned.learned).not.toHaveProperty('holds')
    expect(clocks.ceiling(target)).toBeUndefined()
  })

  it('lowers only a derived budget: maxTokens set keeps it, with holds for the advice', () => {
    const set = streaming({ maxTokens: 150_000 })
    const derived = streaming()
    const clocks = createClocks()
    for (const target of [set, derived]) clocks.cut(target, 900_000, cutStream(45_000))
    expect(clocks.cut(set, 900_000, cutStream(45_000))).toMatchObject({
      learned: { holds: 36_000, lowered: false },
    })
    expect(clocks.cut(derived, 900_000, cutStream(45_000))).toMatchObject({
      learned: { holds: 36_000, lowered: true },
    })
    expect(clocks.ceiling(set)).toBeUndefined()
    expect(clocks.ceiling(derived)).toBe(36_000)
    // What was learned of one provider holds nothing for another that has learned nothing.
    expect(clocks.ceiling(streaming())).toBeUndefined()
  })
})
