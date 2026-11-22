import { FAIL_ON_LEVELS } from './profile.ts'
import { ownData } from './facts.ts'
import type { FailOn, PublicVerdict, PublicView, QuorumResult, Verdict } from './types.ts'

/** The HTTP statuses, besides 5xx, that a call fails with in passing: a request timeout, a conflict and a rate limit. */
const PASSING_STATUSES: ReadonlySet<number> = new Set([408, 409, 429])

/** What a review comes to: `pass` (nothing to fail on), `findings` (a kept finding reached its profile's level), `incomplete` (a gap or an unreviewed finding of a gating profile) or `interrupted` (the review was stopped before its end). */
export type OutcomeStatus = 'pass' | 'findings' | 'incomplete' | 'interrupted'

/**
 * What a review comes to, as `outcome` reads it from a result: the `status`, the process exit code that says it
 * (`0`, `1`, `4` or `130`), and whether `allowIncomplete` lifted an incomplete review into a pass, so a report never
 * calls that run complete.
 */
export interface Outcome {
  readonly status: OutcomeStatus
  readonly exitCode: 0 | 1 | 4 | 130
  readonly lifted: boolean
}

const PASS: Outcome = Object.freeze({ status: 'pass', exitCode: 0, lifted: false })
const LIFTED: Outcome = Object.freeze({ status: 'pass', exitCode: 0, lifted: true })
const FINDINGS: Outcome = Object.freeze({ status: 'findings', exitCode: 1, lifted: false })
const INCOMPLETE: Outcome = Object.freeze({ status: 'incomplete', exitCode: 4, lifted: false })
const INTERRUPTED: Outcome = Object.freeze({ status: 'interrupted', exitCode: 130, lifted: false })

/**
 * What a finished review comes to: `interrupted`, exit 130, when any gap is an `interrupted` one, an advisory profile's
 * included, ahead of everything else and never lifted: the review was stopped before its end, whatever it kept.
 * Otherwise `findings`, exit 1, when a kept finding is at or above the level of its
 * profile (`failOn`: `high`, `medium` or `low`), `incomplete`, exit 4, when an unreviewed finding or a gap
 * belongs to a gating profile, and `pass`, exit 0, otherwise. A profile gates unless its level is `none`. The
 * exit 1 comes before the other two: a kept finding that reached its level is reported whatever else is missing.
 * `allowIncomplete` turns that 4 into 0, `lifted`, only when every gap of a gating profile is a `vote-failed`
 * one (an unreviewed finding is no gap) and, for each gating profile that has a gap, every failed vote of its
 * own kept and unreviewed findings failed in passing, as `failedInPassing` says: a dropped connection, a
 * timeout, or an HTTP 408, 409, 429 or 5xx. A gating profile with no gap blocks no other profile's lift. A gap
 * with no failed vote behind it lifts nothing: an unreviewed finding whose votes hold none, or a
 * `vote-failed` gap beside kept findings that hold none, which no review writes. Advisory flags never change it.
 * The level of a profile is the one the result records (`profileFailOn`), so a profile missing from
 * `meta.profiles` gates at `high` and a gap never hides.
 *
 * It reads a public view (`publicView`) as the result it came from: a vote of a view is cast when its `keep` is a
 * boolean, so a job that holds only the view concludes what the review's own run did, a lifted gap included.
 *
 * Why so narrow: a pull request causes the other gaps directly (ADR-0012). It pads a hunk until no
 * research request holds it (`too-large`), floods the research with decoy findings past `maxFindings`, or
 * plants text that a voter refuses or that cuts its reply off or leaves it unusable, one
 * `.gitattributes` line, one NUL byte or a submodule's bump leaves a file's change out of the diff, and
 * a file named as a secret, or one that holds a credential, is held back from every request (`secret`).
 * The flag lifts only what the code names, so a reason added later is out of its reach by default,
 * and so is what a result built by hand or by an older quorum leaves unsaid: a failed vote with no
 * `failure`, a verdict whose `votes` is no array, a reason no quorum writes. A gating profile's
 * `research-failed` and `provider-down` gaps are out too, and so is a failed vote of kind `provider-down`:
 * a part the review never read is never turned into exit 0. Planted text can still draw out a reply that ends in a lifted failure, a
 * timeout of its own, so on a gating profile do not use the flag for a pull request you do not trust.
 *
 * @example
 * const { exitCode } = outcome(result, { allowIncomplete: true })
 */
export function outcome(result: QuorumResult | PublicView, options: { readonly allowIncomplete?: boolean } = {}): Outcome {
  if (isInterrupted(result)) return INTERRUPTED
  const gates = gatesOf(result)
  if (result.kept.some(verdict => failsItsProfile(result, verdict))) return FINDINGS
  if (!isIncomplete(result)) return PASS
  return options.allowIncomplete === true && liftable(result, gates)
    ? LIFTED
    : INCOMPLETE
}

/** Whether a profile gates the review, as `result` records it: its level is not `none` (`profileFailOn`). */
function gatesOf(result: QuorumResult | PublicView): (profile: unknown) => boolean {
  return profile => profileFailOn(result, profile) !== 'none'
}

/** Whether any gap of the review is an `interrupted` one, of any profile, an advisory one included: the review was stopped before its end. */
export function isInterrupted(result: QuorumResult | PublicView): boolean {
  return result.meta.incomplete.some(entry => entry.reason === 'interrupted')
}

/**
 * Whether a gating profile has a gap or an unreviewed finding, which is what makes a review `incomplete`
 * before a kept finding takes precedence over it and before `allowIncomplete` lifts it. A report that says a
 * run did not complete reads this, so a kept finding that sets exit 1 or a lifted gap never hides one.
 */
export function isIncomplete(result: QuorumResult | PublicView): boolean {
  const gates = gatesOf(result)
  return result.unreviewed.some(verdict => gates(verdict.profile)) || result.meta.incomplete.some(entry => gates(entry.profile))
}

/**
 * The level at or above which `profile`'s kept findings fail the review, as `result` records it: its own
 * `failOn` when that is one of the four levels, else `none` when its own `gating` is `false`, as a result
 * recorded before `failOn` says it, else `high`. So a profile missing from `meta.profiles`, a profile that is
 * no string, or an entry that says nothing readable gates at `high`. It reads own data only and never throws.
 */
export function profileFailOn(result: QuorumResult | PublicView, profile: unknown): FailOn {
  const entry = typeof profile === 'string'
    ? ownData(result.meta.profiles, profile)
    : undefined
  const failOn = ownData(entry, 'failOn')
  if (typeof failOn === 'string' && FAIL_ON_LEVELS.includes(failOn as FailOn)) return failOn as FailOn
  return ownData(entry, 'gating') === false
    ? 'none'
    : 'high'
}

/**
 * Whether a kept finding fails its profile: its confidence is at or above the level `result` records for its
 * profile (`profileFailOn`), and that level is not `none`. This is the rule `outcome` sets exit 1 by, so a
 * report that marks the findings that fail the review marks the ones that make its exit code.
 */
export function failsItsProfile(result: QuorumResult | PublicView, verdict: Verdict | PublicVerdict): boolean {
  return reaches(verdict.confidence, profileFailOn(result, verdict.profile))
}

/** Whether a kept finding of `confidence` fails a profile at `level`: it is at or above it, and the level is not `none`. `none` ranks last, so it is never at or above a level. */
function reaches(confidence: unknown, level: FailOn): boolean {
  const rank = FAIL_ON_LEVELS.indexOf(confidence as FailOn)
  return level !== 'none' && rank !== -1 && rank <= FAIL_ON_LEVELS.indexOf(level)
}

/** True when every gap of a gating profile is a `vote-failed` one, and each gating profile that has a gap passes `liftsProfile`. */
function liftable(result: QuorumResult | PublicView, gates: (profile: unknown) => boolean): boolean {
  const gaps = result.meta.incomplete.filter(entry => gates(entry.profile))
  if (gaps.some(entry => entry.reason !== 'vote-failed')) return false
  const unreviewed = (result.unreviewed as ReadonlyArray<Verdict | PublicVerdict>).filter(verdict => gates(verdict.profile))
  const profiles = new Set([
    ...gaps,
    ...unreviewed,
  ].map(({ profile }) => profile))
  return [...profiles].every(profile => liftsProfile(result, profile, gaps.some(entry => entry.profile === profile)))
}

/**
 * True when the failed votes behind `profile`'s gaps all failed in passing: those of its own kept and
 * unreviewed findings, each finding's `votes` an array. Every unreviewed finding holds a failed vote, and
 * so do the kept findings when the profile has a `vote-failed` gap (`gap`): a gap with no failed vote behind
 * it lifts nothing.
 */
function liftsProfile(result: QuorumResult | PublicView, profile: string, gap: boolean): boolean {
  const kept = failedVotesOf(of(result.kept, profile))
  const unreviewed = failedVotesOf(of(result.unreviewed, profile))
  if (kept === undefined || unreviewed === undefined) return false
  return [
    ...kept,
    ...unreviewed,
  ].every(failed => failed.every(lensVote => failedInPassing(ownData(lensVote, 'failure'))))
  && unreviewed.every(failed => failed.length > 0)
  && (!gap || kept.some(failed => failed.length > 0))
}

/** The verdicts of `profile`, from the list of either view. */
function of(verdicts: ReadonlyArray<Verdict | PublicVerdict>, profile: string): ReadonlyArray<Verdict | PublicVerdict> {
  return verdicts.filter(verdict => verdict.profile === profile)
}

/** Whether `value` has `key` as an own property, a getter or a throwing proxy included. */
function ownsKey(value: unknown, key: string): boolean {
  try {
    return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
  } catch {
    return false
  }
}

/**
 * Whether a vote of either view was cast. A vote with an own `vote` key is a full result's: cast only when its
 * own data `vote` is an object. A vote without one is a public view's: cast only when its own data `keep` is a
 * boolean. Either is cast only when its own data `failure` is `null` or absent, so a vote that records a
 * failure never counts as cast, and any other entry is failed.
 */
function isCast(lensVote: unknown): boolean {
  const failure = ownData(lensVote, 'failure')
  if (failure !== null && failure !== undefined) return false
  if (ownsKey(lensVote, 'vote')) {
    const cast = ownData(lensVote, 'vote')
    return typeof cast === 'object' && cast !== null
  }
  return typeof ownData(lensVote, 'keep') === 'boolean'
}

/**
 * The failed votes of each verdict, in order, or undefined when the `votes` of one is no array. A vote of the
 * full result is cast when its own data `vote` is an object and its own data `failure` is `null` or absent,
 * one of the public view when its own data `keep` is a boolean and its `failure` is `null` or absent (see
 * `isCast`): any other entry is failed, so the lift reads a public view as it reads the result it came from.
 */
function failedVotesOf(verdicts: ReadonlyArray<Verdict | PublicVerdict>): unknown[][] | undefined {
  const lists = verdicts.map((verdict) => {
    const votes: unknown = verdict.votes
    return Array.isArray(votes)
      ? votes.filter(lensVote => !isCast(lensVote))
      : undefined
  })
  return lists.every(list => list !== undefined)
    ? lists
    : undefined
}

/**
 * True for a vote's failure that is infrastructure's: its own data `kind` is `network` or `timeout`, or
 * `http` with an own data `status` of 408, 409, 429 or an integer from 500 to 599. Anything else is false:
 * a refusal, a reply cut off or unusable, a request too large, any other status, a status that is no
 * number, a kind no provider has, `null` and a value that is no object. It reads own data only, never
 * runs a getter and never throws.
 */
export function failedInPassing(failure: unknown): boolean {
  const kind = ownData(failure, 'kind')
  if (kind === 'network' || kind === 'timeout') return true
  const status = ownData(failure, 'status')
  return kind === 'http' && typeof status === 'number' && Number.isInteger(status) && (PASSING_STATUSES.has(status) || (status >= 500 && status <= 599))
}
