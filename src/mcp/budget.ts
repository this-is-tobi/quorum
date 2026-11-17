/** How many reviews' caps the session budget holds by default: four times the config's `maxReviewTokens`. */
export const SESSION_FACTOR = 4

/** The tokens one server may spend over its life, and what it has spent. */
export interface SessionBudget {
  readonly total: number
  /** The tokens counted so far. */
  readonly spent: () => number
  /** Counts `tokens`; a number that is not positive counts nothing, so a charge is never negative. */
  readonly add: (tokens: number) => void
  /** Whether what is left, `total` less what is spent, covers a review's whole `cap`. */
  readonly holds: (cap: number) => boolean
}

/**
 * The budget of a server's life, `total` tokens. What counts is what each provider call spent while a review
 * ran, and the whole cap of a review that ended without a result (`reviewCall`). A review starts only while
 * what is left covers its whole cap (`holds`): each review is bounded by its cap, so the budget is passed by no
 * more than what a provider reports above a call's reservation, which the review's own cap counts too.
 */
export function sessionBudget(total: number): SessionBudget {
  let spent = 0
  return {
    total,
    spent: () => spent,
    add: (tokens) => {
      if (tokens > 0) spent += tokens
    },
    holds: cap => total - spent >= cap,
  }
}
