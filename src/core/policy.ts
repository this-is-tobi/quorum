import type { ConfigIssue } from './errors.ts'
import type { Confidence, Thresholds, Verdict, VerdictStatus } from './types.ts'

/** How many kept votes a confidence level needs. `off` (or `false`) disables the level. */
export type Rule = 'unanimous' | 'majority' | 'any' | 'off' | false | { minVotes: number } | { minRatio: number }

export interface PolicyRules {
  high: Rule
  medium: Rule
  low: Rule
}

/** Today's arithmetic with three lenses: 3/3 → high, 2/3 → medium; low disabled. */
export const defaultPolicy: PolicyRules = { high: 'unanimous', medium: 'majority', low: 'off' }

const LEVELS: readonly Confidence[] = ['high', 'medium', 'low']

export interface ResolvedPolicy {
  thresholds: Thresholds
  issues: ConfigIssue[]
  warnings: string[]
}

/**
 * Resolve policy rules against the lens count. Invalid rules, a lens count below one, and a level
 * needing more votes than the one above it, are issues. A level needing exactly as many votes as
 * the one above can never apply; that is only a warning, because the default policy hits it
 * legitimately with 1 or 2 lenses.
 */
export function resolvePolicy(rules: PolicyRules, lensCount: number): ResolvedPolicy {
  const issues: ConfigIssue[] = []
  const warnings: string[] = []
  const thresholds: Thresholds = { high: null, medium: null, low: null }
  if (!Number.isInteger(lensCount) || lensCount < 1) {
    issues.push({ path: 'lenses', message: 'at least one lens is required' })
    return { thresholds, issues, warnings }
  }
  for (const level of LEVELS) {
    thresholds[level] = resolveRule(rules[level], lensCount, `policy.${level}`, issues)
  }
  const enabled: Array<{ level: Confidence, votes: number }> = []
  for (const level of LEVELS) {
    const votes = thresholds[level]
    if (votes !== null) enabled.push({ level, votes })
  }
  if (enabled.length === 0 && issues.length === 0) {
    issues.push({ path: 'policy', message: 'at least one confidence level must be enabled' })
  }
  for (let index = 1; index < enabled.length; index++) {
    const stricter = enabled[index - 1]
    const looser = enabled[index]
    if (looser.votes > stricter.votes) {
      issues.push({ path: `policy.${looser.level}`, message: `needs ${looser.votes} votes, more than policy.${stricter.level} (${stricter.votes})` })
    } else if (looser.votes === stricter.votes) {
      warnings.push(`policy.${looser.level} needs the same ${looser.votes} vote(s) as policy.${stricter.level} with ${lensCount} lens(es), so it never applies`)
    }
  }
  return { thresholds, issues, warnings }
}

/** The highest confidence level whose threshold `keptVotes` reaches; undefined means no level. */
export function confidenceFor(keptVotes: number, thresholds: Thresholds): Confidence | undefined {
  return LEVELS.find((level) => {
    const needed = thresholds[level]
    return needed !== null && keptVotes >= needed
  })
}

/**
 * Where a verdict lands. A discard never rests on a failed vote (ADR-0012): the votes that failed
 * are counted as if they had been kept, and when that would reach an enabled level the outcome was
 * never decided, so the finding is unreviewed. Two explicit rejects next to one failed vote are a
 * decided discard under the default policy, because one more keep would still reach no level.
 */
export function verdictStatus(verdict: Pick<Verdict, 'keptVotes' | 'votes'>, thresholds: Thresholds): VerdictStatus {
  if (confidenceFor(verdict.keptVotes, thresholds) !== undefined) return 'kept'
  const failed = verdict.votes.filter(vote => vote.vote === null).length
  return confidenceFor(verdict.keptVotes + failed, thresholds) === undefined ? 'discarded' : 'unreviewed'
}

/**
 * The higher level a kept verdict's failed votes leave undecided: the level its kept plus failed
 * votes would reach, when that is above the level it earned; undefined when the failed votes could
 * not have changed it. Such a verdict stays kept at its earned confidence, but the review is
 * incomplete (ADR-0012), because the gate between two levels rested on a vote never cast.
 */
export function undecidedLevel(verdict: Pick<Verdict, 'keptVotes' | 'votes' | 'confidence'>, thresholds: Thresholds): Confidence | undefined {
  const failed = verdict.votes.filter(vote => vote.vote === null).length
  if (failed === 0) return undefined
  const reachable = confidenceFor(verdict.keptVotes + failed, thresholds)
  return reachable !== undefined && reachable !== verdict.confidence ? reachable : undefined
}

/**
 * Resolve one rule. `rule` is typed `unknown` on purpose: a value outside the `Rule` type (what
 * untyped configuration could hand over) is reported as an issue at `path`, never thrown, and no
 * rule resolves below one vote, so no level can be granted to a finding with zero kept votes.
 */
function resolveRule(rule: unknown, lensCount: number, path: string, issues: ConfigIssue[]): number | null {
  if (rule === 'off' || rule === false) return null
  if (rule === 'unanimous') return lensCount
  if (rule === 'majority') return Math.floor(lensCount / 2) + 1
  if (rule === 'any') return 1
  if (typeof rule === 'object' && rule !== null) {
    if ('minVotes' in rule && 'minRatio' in rule) {
      issues.push({ path, message: 'a rule holds either minVotes or minRatio, not both' })
      return null
    }
    if ('minVotes' in rule) {
      const { minVotes } = rule
      if (typeof minVotes === 'number' && Number.isInteger(minVotes) && minVotes >= 1 && minVotes <= lensCount) return minVotes
      issues.push({ path, message: `minVotes must be an integer between 1 and ${lensCount}` })
      return null
    }
    if ('minRatio' in rule) {
      const { minRatio } = rule
      if (typeof minRatio === 'number' && minRatio > 0 && minRatio <= 1) return Math.max(1, Math.ceil(minRatio * lensCount - 1e-9))
      issues.push({ path, message: 'minRatio must be a number greater than 0 and at most 1' })
      return null
    }
  }
  issues.push({ path, message: 'expected unanimous, majority, any, off, { minVotes } or { minRatio }' })
  return null
}
