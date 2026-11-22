import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './ports.ts'
import type { Provider } from './ports.ts'
import type { Target } from './stages/context.ts'

/** The shortest window a provider's stall window is learned as: five minutes. */
export const STALL_FLOOR_MS = 300_000

/** How many times its longest silence a provider's stall window is learned as. */
export const STALL_FACTOR = 3

/** The least time between two `call:progress` events of one call: one second. */
export const PROGRESS_MS = 1000

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

/** What one answered attempt showed of its stream: the facts the stall window is learned from. */
export interface AttemptSeen {
  /** How long the attempt ran, from its send to its answer. */
  readonly attemptMs: number
  /** From the attempt's send to its first data event, the headers excluded; absent when it had none, as a whole reply has none. */
  readonly firstTokenMs?: number
  /** The longest time between two signs of progress, the attempt's send and its answer included. */
  readonly longestSilenceMs: number
  /** The output tokens it streamed, or its reply reported when it did not stream. */
  readonly outputTokens: number
  /** Whether its stream showed answer text. */
  readonly answer: boolean
  /** Whether its stream showed reasoning. */
  readonly reasoning: boolean
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
}

/** The clocks of one review: what they learn is kept per provider object, so two providers named alike are apart. */
export function createClocks(): Clocks {
  const longest = new WeakMap<Provider, number>()
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
  }
}
