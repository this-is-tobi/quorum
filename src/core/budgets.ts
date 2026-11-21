import type { ProfileRun, Target } from './stages/context.ts'

/**
 * The reply budget of each request kind, which the core derives from what a provider states of itself (its
 * window, its `maxTokens` and its `thinking`) so that a reply of one kind is never given more room than it
 * needs, nor less than it must have. With `W` the window, `M` `maxFindings`, `F` `FINDING_TOKENS`, `E`
 * `ENVELOPE_TOKENS` and `T` the thinking allowance (`THINKING_TOKENS`):
 *
 * - a research reply takes `R = min(M * F + E + T, floor(W / 4))`: what its findings and its thinking need,
 *   and at most a quarter of the window, so three quarters stay for the request. With `maxTokens` set, `R` is
 *   `maxTokens`: the owner's ceiling, the decision of the one who knows the server;
 * - the research request asks for `N = max(1, min(M, floor((R - T' - E) / F)))` findings, `T' = min(T, floor(R / 2))`,
 *   so the thinking keeps its room and takes at most half of the budget. `N'` is the same without the
 *   thinking, `max(1, min(M, floor((R - E) / F)))`, for a model that shows none;
 * - a vote takes `V = min(maxTokens, VOTE_TOKENS + T, floor(W / 4))`: 1024 tokens hold a verdict and its
 *   reasoning, and the thinking allowance comes on top. `maxTokens` is a ceiling of the vote too, so a large
 *   one set for research no longer reserves that much for every vote.
 *
 * A term whose fact a provider does not state drops out: with neither a window nor `maxTokens`, `R` and `V`
 * are undefined, the request sizes nothing and `N` is `M`, so a provider object that states nothing is
 * reserved and asked as it always was.
 *
 * The allowances sit below OpenAI's advice of 25 000 tokens for reasoning and outputs, since quorum's replies
 * are short and recovery lowers the thinking of a reply that is cut off. `FINDING_TOKENS` is an assumption,
 * the design's placeholder: no recorded run holds the output tokens of one finding, so the figure is not yet
 * measured.
 */

/** The output tokens one finding takes, a placeholder until a recorded run measures it (an assumption). */
export const FINDING_TOKENS = 256

/** The output tokens of a research reply's envelope, around its findings. */
export const ENVELOPE_TOKENS = 32

/** The tokens a verdict and its reasoning take, before the thinking allowance. */
export const VOTE_TOKENS = 1024

/** The most findings of a research reply each profile reads, when a quorum sets none. */
export const DEFAULT_MAX_FINDINGS = 50

/** How much a provider is told to think: its own default, a lowered level, or none. */
export type ThinkingLevel = 'default' | 'low' | 'off'

/** The tokens a reply is given for thinking, by level. */
export const THINKING_TOKENS: Readonly<Record<ThinkingLevel, number>> = { off: 0, low: 4096, default: 8192 }

/** What a provider states of its replies: its window and its `maxTokens` when it sets them, and its thinking level, `default` when unstated. */
export interface ReplyFacts {
  readonly window?: number
  readonly maxTokens?: number
  readonly thinking: ThinkingLevel
}

/** The reply budgets of one provider, in tokens: undefined where nothing is stated to size a reply by. */
export interface ReplyBudget {
  readonly research: number | undefined
  readonly vote: number | undefined
  /** The findings a research request asks for at most: `N`. */
  readonly findings: number
  /** The findings it asks for from a model that shows no thinking: `N'`. */
  readonly findingsWithoutThinking: number
}

/**
 * The reply budgets of `facts`' provider on `window`, the effective window, which is the stated one until a
 * review learns another: a research reply's, a vote's, and the findings a research request asks for with and
 * without the thinking allowance.
 */
export function replyBudget(facts: ReplyFacts, window: number | undefined, maxFindings: number): ReplyBudget {
  const thinking = THINKING_TOKENS[facts.thinking]
  const quarter = window === undefined
    ? Number.POSITIVE_INFINITY
    : Math.floor(window / 4)
  const { maxTokens } = facts
  const research = maxTokens ?? (window === undefined
    ? undefined
    : Math.min(maxFindings * FINDING_TOKENS + ENVELOPE_TOKENS + thinking, quarter))
  const vote = maxTokens === undefined && window === undefined
    ? undefined
    : Math.min(maxTokens ?? Number.POSITIVE_INFINITY, VOTE_TOKENS + thinking, quarter)
  if (research === undefined) {
    return {
      research,
      vote,
      findings: maxFindings,
      findingsWithoutThinking: maxFindings,
    }
  }
  const held = (tokens: number): number => Math.max(1, Math.min(maxFindings, Math.floor((research - tokens - ENVELOPE_TOKENS) / FINDING_TOKENS)))
  return {
    research,
    vote,
    findings: held(Math.min(thinking, Math.floor(research / 2))),
    findingsWithoutThinking: held(0),
  }
}

/** What a profile's budgets read of a quorum's settings. `partTokens` and `maxReviewTokens` are read by room accounting alone, which a later task adds to this result. */
export interface BudgetSettings {
  readonly maxFindings: number
  readonly partTokens: number
  readonly maxReviewTokens: number
}

/** The budgets of one profile: its research provider's, with the findings its requests ask for, and each lens's voter's. */
export interface ProfileBudgets {
  readonly research: {
    readonly provider: string
    readonly window?: number
    readonly replyTokens?: number
    readonly findings: number
    readonly findingsWithoutThinking: number
  }
  readonly lenses: Readonly<Record<string, {
    readonly provider: string
    readonly window?: number
    readonly replyTokens?: number
  }>>
}

/** The facts a target stated when the quorum was created. */
function factsOf(target: Target): ReplyFacts {
  return {
    thinking: target.thinking,
    ...target.window === undefined
      ? {}
      : { window: target.window },
    ...target.maxTokens === undefined
      ? {}
      : { maxTokens: target.maxTokens },
  }
}

/** A window and a reply budget as a profile's budgets hold them: each left out when it is undefined. */
function sizes(window: number | undefined, replyTokens: number | undefined): { readonly window?: number, readonly replyTokens?: number } {
  return {
    ...window === undefined
      ? {}
      : { window },
    ...replyTokens === undefined
      ? {}
      : { replyTokens },
  }
}

/**
 * The reply budgets of one profile, from its providers' stated facts and the window `windowOf` gives each of
 * them. `createQuorum` calls it with the stated windows (`target => target.window`); a later phase calls it again
 * for each review with the effective ones, and the signature stays. Of `settings`, only `maxFindings` is read
 * here: `partTokens` and `maxReviewTokens` are for the room accounting that comes later.
 */
export function profileBudgets(run: ProfileRun, windowOf: (target: Target) => number | undefined, settings: BudgetSettings): ProfileBudgets {
  const research = windowOf(run.research)
  const budget = replyBudget(factsOf(run.research), research, settings.maxFindings)
  return {
    research: {
      provider: run.research.ref.id,
      ...sizes(research, budget.research),
      findings: budget.findings,
      findingsWithoutThinking: budget.findingsWithoutThinking,
    },
    lenses: Object.fromEntries(run.lenses.map((lens) => {
      const window = windowOf(lens)
      return [
        lens.id,
        {
          provider: lens.ref.id,
          ...sizes(window, replyBudget(factsOf(lens), window, settings.maxFindings).vote),
        },
      ]
    })),
  }
}
