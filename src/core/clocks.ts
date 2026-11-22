import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './ports.ts'
import type { Provider } from './ports.ts'
import type { Target } from './stages/context.ts'
import { VOTE_TOKENS } from './tokens.ts'
import type { AttemptSeen } from './watch.ts'

/** The shortest window a provider's stall window is learned as: five minutes. */
export const STALL_FLOOR_MS = 300_000

/** How many times its longest silence a provider's stall window is learned as. */
export const STALL_FACTOR = 3

/**
 * What a review learns of a provider's cut. A path (a proxy, a gateway) may end any call at a fixed length, whatever the
 * model was doing: each such attempt used to be retried to the same end until the provider was found down. Three numbers
 * decide what is learned, each with its reason:
 *
 * - the tolerance: two cut attempts are one lesson when they differ by at most the larger of 5 percent of the shorter and
 *   5000 ms. A path's limit is a constant, so its cuts fall within a second of each other, and a few seconds of queueing
 *   or a slower first byte move them by little. A false lesson costs a split of a part, a missed one costs the provider,
 *   so the tolerance is kept wide, and an attempt that failed within a minute (`CUT_AFTER_MS`) is no cut at all;
 * - the rate: what the attempts cut at the learned length streamed, those that taught the cut, each one's streamed
 *   estimate over its own length, its first wait included, which is what the cut lets through of such a call. An answered
 *   attempt's rate is no part of it: a part that queued long before its first token and wrote little would hold the
 *   budget far under what the cut lets through. The lowest of those, scaled to the cut's length, is the conservative
 *   statistic, and an attempt that showed no count is left out;
 * - the margin, `CUT_MARGIN`: a reply is held to four fifths of what the cut lets through at that rate, since the first
 *   token of a call may be slower than any seen and a shared server's pace varies. The streamed estimate, a quarter of
 *   the characters, undercounts code, which errs the same way. A reply always keeps `VOTE_TOKENS`, a verdict's room.
 *
 * It holds per provider object, so two providers named alike are apart, and per review.
 */

/** The share of what a cut lets through that a lowered reply budget holds: four fifths, a fifth being left for a slow first token. */
const CUT_MARGIN_NUMERATOR = 4
const CUT_MARGIN_DENOMINATOR = 5
export const CUT_MARGIN = CUT_MARGIN_NUMERATOR / CUT_MARGIN_DENOMINATOR

/** What a cut attempt's length may differ from another's, or from the learned cut, in the larger of a twentieth of the shorter and this: 5000 ms. */
const CUT_TOLERANCE_MS = 5000

/** The reply budget Anthropic's SDK sizes a request's deadline by: an hour for 128000 tokens. */
const CEILING_MS_PER_BUDGET = 3_600_000
const CEILING_BUDGET_TOKENS = 128_000

/**
 * The deadline of one attempt, its ceiling, in milliseconds: the `timeoutMs` the provider stated, whatever the
 * budget, else a time that grows with the reply the attempt may take, by Anthropic's SDK rule of an hour for 128000
 * tokens: never under `DEFAULT_TIMEOUT_MS` (ten minutes), and never over `MAX_TIMEOUT_MS` (a day), since a timer past
 * 2^31 milliseconds fires at once. `replyTokens` is the reply limit of the request, or the default one.
 */
export function attemptCeiling(stated: number | undefined, replyTokens: number): number {
  if (stated !== undefined) return stated
  return Math.min(MAX_TIMEOUT_MS, Math.max(DEFAULT_TIMEOUT_MS, Math.ceil(CEILING_MS_PER_BUDGET * replyTokens / CEILING_BUDGET_TOKENS)))
}

/** What a review learns of how its providers' streams pace, and what each attempt may wait for by it. */
export interface Clocks {
  /**
   * How long a streamed attempt of `target` may show no progress before it stalls, never over its `ceiling`. A
   * `stallTimeoutMs` the provider states is the window, exactly. Else it is `DEFAULT_TIMEOUT_MS` until the provider has
   * answered a streamed attempt in this review, then the larger of `STALL_FLOOR_MS` and `STALL_FACTOR` times the longest
   * silence among those; and until the attempt's first data event (`firstData` false) the larger of `DEFAULT_TIMEOUT_MS`
   * and that, since a busy server queues a request before its first token with no sign.
   */
  readonly window: (target: Target, ceiling: number, firstData: boolean) => number
  /** An attempt of `target` answered: a streamed one, which showed a data event, teaches the provider's window. */
  readonly answered: (target: Target, seen: AttemptSeen) => void
  /**
   * An attempt of `target` was cut on the way (`cutOf`) after `attemptMs`, and showed `seen` of its stream, which is
   * undefined for an attempt that did not stream. A provider learns its cut when two of its cut attempts, of any calls,
   * differ by at most the larger of 5 percent of the shorter and 5000 ms: the cut is the shorter. Every attempt cut at
   * the learned length less that tolerance or later, the one that taught it included, is `cutOff`: `thinking` when its
   * stream showed reasoning and no answer, else `reply`, as 3e reads a reply cut off at its limit. `learned` comes once,
   * with the cut's length, what a reply may be held to at the lowest rate the two attempts that taught it streamed
   * (`holds`, never under `VOTE_TOKENS`, absent when neither showed a count), and whether the provider's derived reply
   * budget is lowered to it (`lowered`: it has no `maxTokens`, and a rate was measured).
   */
  readonly cut: (target: Target, attemptMs: number, seen: AttemptSeen | undefined) => {
    readonly cutOff?: 'thinking' | 'reply'
    readonly learned?: { readonly afterMs: number, readonly holds?: number, readonly lowered: boolean }
  }
  /** The reply budget a learned cut holds a derived budget to, in tokens: undefined until `target`'s provider learned its cut, when it set `maxTokens`, and when no rate was measured. */
  readonly ceiling: (target: Target) => number | undefined
}

/** One cut attempt: its length, and the output tokens it streamed when it showed a count. */
interface CutAttempt {
  readonly ms: number
  readonly tokens?: number
}

/** What one provider's review knows of its cut. */
interface Cuts {
  /** The cut attempts seen before a lesson was learned. */
  readonly seen: CutAttempt[]
  /** The lesson, once learned. */
  learned?: { readonly afterMs: number, readonly holds?: number }
}

/** How far a cut attempt may be from `afterMs` and still be of its cut: the larger of a twentieth of it and `CUT_TOLERANCE_MS`. */
function toleranceOf(afterMs: number): number {
  return Math.max(afterMs / 20, CUT_TOLERANCE_MS)
}

/**
 * What a reply may be held to, in tokens, for a cut at `afterMs`: the lowest of what the attempts that taught it streamed
 * over their own length, scaled to the cut's and to `CUT_MARGIN`, never under `VOTE_TOKENS`; undefined when none showed a
 * count. Whole numbers all through, so a rate is never a float times a length.
 */
function heldTo(afterMs: number, taught: readonly CutAttempt[]): number | undefined {
  const held = taught.flatMap(({ ms, tokens }) => tokens === undefined
    ? []
    : [
        Math.floor(afterMs * tokens * CUT_MARGIN_NUMERATOR / (CUT_MARGIN_DENOMINATOR * ms)),
      ])
  return held.length === 0
    ? undefined
    : Math.max(VOTE_TOKENS, Math.min(...held))
}

/** The clocks of one review: what they learn is kept per provider object, so two providers named alike are apart. */
export function createClocks(): Clocks {
  const longest = new WeakMap<Provider, number>()
  const cuts = new WeakMap<Provider, Cuts>()
  const cutsOf = (provider: Provider): Cuts => {
    const known = cuts.get(provider)
    if (known !== undefined) return known
    const fresh: Cuts = { seen: [] }
    cuts.set(provider, fresh)
    return fresh
  }
  return {
    window: (target, ceiling, firstData) => {
      if (target.stallTimeoutMs !== undefined) return Math.min(target.stallTimeoutMs, ceiling)
      const silence = longest.get(target.provider)
      const learned = silence === undefined
        ? DEFAULT_TIMEOUT_MS
        : Math.max(STALL_FLOOR_MS, STALL_FACTOR * silence)
      return Math.min(ceiling, firstData || silence === undefined
        ? learned
        : Math.max(DEFAULT_TIMEOUT_MS, learned))
    },
    answered: (target, seen) => {
      if (seen.firstTokenMs === undefined) return
      longest.set(target.provider, Math.max(longest.get(target.provider) ?? 0, seen.longestSilenceMs))
    },
    cut: (target, attemptMs, seen) => {
      const { provider } = target
      const state = cutsOf(provider)
      const cutOff = seen?.reasoning === true && !seen.answer
        ? 'thinking' as const
        : 'reply' as const
      if (state.learned !== undefined) {
        return attemptMs >= state.learned.afterMs - toleranceOf(state.learned.afterMs)
          ? { cutOff }
          : {}
      }
      const tokens = seen !== undefined && seen.outputTokens > 0
        ? seen.outputTokens
        : undefined
      const here: CutAttempt = tokens === undefined
        ? { ms: attemptMs }
        : { ms: attemptMs, tokens }
      const mate = state.seen.find(other => Math.abs(other.ms - attemptMs) <= toleranceOf(Math.min(other.ms, attemptMs)))
      if (mate === undefined) {
        state.seen.push(here)
        return {}
      }
      const afterMs = Math.min(mate.ms, attemptMs)
      const holds = heldTo(afterMs, [mate, here])
      state.learned = {
        afterMs,
        ...holds === undefined
          ? {}
          : { holds },
      }
      state.seen.length = 0
      return {
        cutOff,
        learned: {
          afterMs,
          ...holds === undefined
            ? {}
            : { holds },
          lowered: holds !== undefined && target.maxTokens === undefined,
        },
      }
    },
    ceiling: target => target.maxTokens === undefined
      ? cuts.get(target.provider)?.learned?.holds
      : undefined,
  }
}
