/**
 * The public view: a result less what helps an attacker, which every sink a stranger can read renders (a
 * public repository's job summary, line comments and code scanning alerts, a CI log, an artifact). A review of
 * a pull request is run on text its author wrote, and its author reads these sinks, so each field withheld is
 * one that answers a question an attacker asks of the review:
 *
 * - **a vote's reasoning and its error:** the reasoning is a model's text about the author's code, and the
 *   error quotes a server; either shows which wording moved a voter, an oracle to tune the next push by. A vote
 *   keeps its lens, whether it kept the finding (`null` when it failed) and what it failed with, which are
 *   words and numbers quorum wrote;
 * - **the discarded findings:** a finding the panel rejected is a probe the author can read back, and the text
 *   of each is the finder's. The view lists none and counts them per profile, in `discarded`;
 * - **the providers and models:** which model reviewed names what to craft a prompt injection for, and a
 *   provider's id can name an internal host. The view keeps the profile's policy, level and coverage;
 * - **the usage:** the tokens say how a review ran, and how near it came to its cap, which tells an author
 *   how much text it takes to push the review into a gap;
 * - **each gap's detail:** a detail quotes a file name, a finder's text or a server's, so the view keeps the
 *   profile, the reason and the file, and a reporter writes the reason's fixed words (`GAP_WORDS`).
 *
 * Everything else stays: the findings with their evidence, the files left out, a held file's name, reason and
 * rule included, and the flags with their details, which quorum's code writes. `meta.view` says it is the
 * public view, so no reader mistakes it for the full result.
 *
 * The functions are pure. A view is made of new arrays and objects, the parts kept whole copied with
 * `structuredClone`, so what holds the view never holds the result, and the result is never changed. The public
 * view of a public view is that view, so a reporter that must render the view renders it whatever it is given.
 *
 * **Every view `publicView` returns has passed `publicViewSchema`,** the strict schema `quorum report` reads a
 * file by: the profile ids, the fingerprints, the gaps' reasons, the files' reasons and rules and the flags' codes
 * are the code words quorum writes, which a reporter writes bare. So a library caller's hand-built object, or a
 * forged `meta.view`, cannot put text of its own where a reporter trusts quorum's.
 */

import { issuePath } from '../core/errors.ts'
import { publicViewSchema } from '../core/result-schema.ts'
import { ownData } from '../core/stages/context.ts'
import type { LensVote, PublicGap, PublicMeta, PublicProfileMeta, PublicVerdict, PublicView, PublicVote, QuorumResult, Verdict } from '../core/types.ts'

/** The views a report is written in: the full result, or the public view. */
export const REPORT_VIEWS = ['full', 'public'] as const

/** One of the views a report is written in. */
export type ReportView = typeof REPORT_VIEWS[number]

/** Whether `input` is a public view: its own data `meta.view` is `public`. A full result has no `view`, and an inherited one counts for nothing. */
export function isPublicView(input: QuorumResult | PublicView): input is PublicView {
  return ownData(ownData(input, 'meta'), 'view') === 'public'
}

/** A vote as the view keeps it: cast only when its vote is an object, so any other entry reads as failed. */
function publicVote(lensVote: LensVote): PublicVote {
  const cast = ownData(lensVote, 'vote')
  const keep = ownData(cast, 'keep')
  return {
    angle: lensVote.angle,
    keep: typeof keep === 'boolean'
      ? keep
      : null,
    failure: structuredClone(lensVote.failure ?? null),
  }
}

/** A verdict as the view keeps it: every field but the votes as they are, the votes reduced. A `votes` that is no array leaves none. */
function publicVerdict(verdict: Verdict): PublicVerdict {
  const votes: unknown = verdict.votes
  return {
    ...verdict,
    votes: Array.isArray(votes)
      ? votes.map(publicVote)
      : [],
  }
}

/** A gap as the view keeps it: the profile, the reason, and the file when there is one. */
function publicGap(gap: PublicGap): PublicGap {
  return {
    profile: gap.profile,
    reason: gap.reason,
    ...gap.file === undefined
      ? {}
      : { file: gap.file },
  }
}

/** How many discarded findings each profile has. */
function discardedByProfile(discarded: readonly Verdict[]): Map<unknown, number> {
  const counts = new Map<unknown, number>()
  for (const verdict of discarded) counts.set(verdict.profile, (counts.get(verdict.profile) ?? 0) + 1)
  return counts
}

/** A profile's meta as the view keeps it, read as own data only: no providers, and the count of its discarded findings. */
function publicProfile(entry: unknown, discarded: number): PublicProfileMeta {
  return {
    policy: structuredClone(ownData(entry, 'policy')) as PublicProfileMeta['policy'],
    failOn: ownData(entry, 'failOn') as PublicProfileMeta['failOn'],
    gating: ownData(entry, 'gating') as boolean,
    discarded,
    invalidFindings: ownData(entry, 'invalidFindings') as number,
    coverage: structuredClone(ownData(entry, 'coverage')) as PublicProfileMeta['coverage'],
  }
}

function publicMeta(result: QuorumResult): PublicMeta {
  const { meta } = result
  const counts = discardedByProfile(result.discarded)
  return {
    version: meta.version,
    view: 'public',
    startedAt: meta.startedAt,
    durationMs: meta.durationMs,
    source: structuredClone(meta.source),
    profiles: Object.fromEntries(Object.entries(meta.profiles).map(([id, entry]) => [
      id,
      publicProfile(entry, counts.get(id) ?? 0),
    ])),
    incomplete: meta.incomplete.map(publicGap),
    leftOut: structuredClone(meta.leftOut),
    flags: structuredClone(meta.flags),
  }
}

/**
 * The public view of a result, or of a public view, which is returned as it is: the result less each vote's
 * reasoning and error, the discarded findings (counted in `meta.profiles.<id>.discarded`), the providers, the
 * usage and each gap's detail. See the module's comment for why each goes. The result is never changed, and
 * the view shares no array or object with it.
 *
 * This is the check every public sink goes through, for a library caller too: the view, made here or given,
 * must pass `publicViewSchema`, so a forged `meta.view` that keeps a vote's reasoning, a profile id that holds
 * Markdown or a fingerprint that holds `-->` is refused here. A file is refused earlier, by `readResult`.
 *
 * @throws TypeError when the view fails `publicViewSchema`; its message names the path of the first issue, as
 * `issuePath` prints it, and never a value
 *
 * @example
 * const view = publicView(result)
 */
export function publicView(input: QuorumResult | PublicView): PublicView {
  return checked(isPublicView(input)
    ? input
    : {
        kept: input.kept.map(publicVerdict),
        discarded: [],
        unreviewed: input.unreviewed.map(publicVerdict),
        meta: publicMeta(input),
      })
}

/** `view`, when it passes `publicViewSchema`. */
function checked(view: PublicView): PublicView {
  const read = publicViewSchema.safeParse(view)
  if (read.success) return view
  const path = read.error.issues[0]?.path ?? []
  throw new TypeError(path.length === 0
    ? 'the public view is not one quorum writes'
    : `the public view is not one quorum writes, at ${issuePath(path)}`)
}

/** How many findings of `profile` the panel discarded: the count a public view records, else those a full result lists. */
export function discardedOf(input: QuorumResult | PublicView, profile: string): number {
  if (!isPublicView(input)) return input.discarded.filter(verdict => verdict.profile === profile).length
  const count = ownData(ownData(input.meta.profiles, profile), 'discarded')
  return typeof count === 'number'
    ? count
    : 0
}

/** Whether a vote failed: a full vote holds a `vote` of `null`, a public one a `keep` of `null`. */
export function voteFailed(vote: LensVote | PublicVote): boolean {
  return Object.hasOwn(vote, 'vote')
    ? (vote as LensVote).vote === null
    : (vote as PublicVote).keep === null
}
