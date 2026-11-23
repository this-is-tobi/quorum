/**
 * Shared types of the quorum core: profiles, findings, verdicts, the result and its metadata, and events.
 *
 * @see ../../docs/95-reference/40-architecture.md for the module overview.
 * @see ../../docs/95-reference/30-library-api.md for usage.
 */

import type { ProfileBudgets } from './budgets.ts'
import type { NoAnswer, ProviderErrorKind } from './errors.ts'
import type { ConcurrencyRecord } from './lanes.ts'
import type { PartOutcome } from './parts.ts'
import type { PolicyRules } from './policy.ts'
import type { ReplyStore } from './ports.ts'

/**
 * A candidate issue after the harness checked it against the diff. The finder supplies the file,
 * line, category and claim; the evidence is read from the diff by code, never from the finder.
 */
export interface Finding {
  /** Names the finding, stable across runs: the first 12 hex characters of SHA-256 over the JSON array `[profile, file, line, category]`. */
  id: string
  /**
   * Names the finding across pushes: the first 16 hex characters of SHA-256 over the JSON array `[profile, file, category, row]`, the category in Unicode's composed form (NFC), in lower case with each run of other characters than letters and digits written `-`, and the cited row's code with its white space collapsed (empty when no row is cited), then `:` and the finding's rank, from 1, among the profile's findings with that hash, a repeat of one finding's file, line and category taking its rank. It holds no line number, so a push that moves the code keeps it, and it holds the category, so two findings on one line keep their own.
   */
  fingerprint: string
  /** The id of the profile whose run found it. */
  profile: string
  /** The diff's own path; for a diff without per-file headers, the finder's name for it, cleaned. */
  file: string
  line: number
  /**
   * The line the finder cited, when the harness moved the finding to the nearest occurrence of its quote, which `line` is
   * then. Absent, never `undefined`, for a finding that stayed where it was cited.
   */
  citedLine?: number
  /** The finder's category, cleaned and capped like the summary. */
  category: string
  /** The finder's claim, stripped of control, format and other invisible characters and capped. */
  summary: string
  /** The diff lines around `line` with their +, - or space markers (a line's trailing carriage return removed), capped. */
  evidence: string
  /**
   * The index, from 0, of the row of `evidence` that shows `line`, which a reporter marks as the
   * cited row and numbers the others from: a `+` or context row counts a new-file line and a `-`
   * row none. Absent, never `undefined`, when no row shows the line (a hunk that only deletes lines)
   * or when the evidence's cap cut that row.
   */
  evidenceRow?: number
  /** Whether the finder's quote appears in the evidence, which is read at the final `line`: a measure of hallucinated citations. */
  quoteMatched: boolean
}

/**
 * One voter's independent judgment on a single finding.
 */
export interface Vote {
  keep: boolean
  reasoning: string
}

/** One angle a voter judges a finding from: the question it is asked, and the id its vote reports. */
export interface Lens {
  /** Names the lens in `LensVote.angle` and in the vote template's `{{lens.id}}`. */
  readonly id: string
  /** What the voter judging from this lens is asked, filled into the vote template's `{{lens.question}}`. */
  readonly question: string
}

/**
 * What a vote failed with: a provider's kind of failure, the limit that stopped it (`token-cap`,
 * `review-deadline` or `interrupted`), `provider-down` for a vote never sent because its provider was found down, `unusable-reply` for a reply the panel could not read as a vote, or `unknown` for
 * anything else thrown.
 * The kinds a gating profile's `--allow-incomplete` lifts are `network`, `timeout` and an `http` failure of
 * status 408, 409, 429 or 5xx.
 */
export type VoteFailureKind = 'http' | 'network' | 'process' | 'timeout' | 'aborted' | 'refusal' | 'truncated' | 'no-answer' | 'invalid-response' | 'unsupported' | 'too-large' | 'token-cap' | 'review-deadline' | 'interrupted' | 'provider-down' | 'unusable-reply' | 'unknown'

/** The facts of a failed vote the code read, never a word a server or a model wrote. */
export interface VoteFailure {
  kind: VoteFailureKind
  /** An `http` failure's HTTP status, an integer from 100 to 599; absent for every other kind, and for an `http` failure that states none. */
  status?: number
}

/**
 * One lens's vote, or the error if that call failed. A failed vote also records its `failure`: what it
 * failed with, which the CLI's `--allow-incomplete` reads to lift only a vote that failed in passing.
 */
export interface LensVote {
  /** The id of the lens the vote was cast from. */
  angle: string
  vote: Vote | null
  error: string | null
  /** What a failed vote failed with; `null` for a vote that was cast. */
  failure: VoteFailure | null
}

/** Instruction templates, one per stage. `{{name}}` placeholders are filled by renderTemplate. */
export interface Prompts {
  readonly research: string
  readonly vote: string
}

/**
 * What a run reviews, as data: the instructions of both stages, the lenses of the panel, and how
 * the votes are graded.
 */
export interface Profile {
  /** Names the profile; matches `^[a-z][a-z0-9_-]*$`. */
  readonly id: string
  /** The `research` and `vote` instruction templates, owned by the profile. */
  readonly prompts: Prompts
  /** The angles of the panel: at least one, ids unique within the profile. */
  readonly lenses: readonly Lens[]
  /** How many kept votes each confidence level needs; `defaultPolicy` when unset. */
  readonly policy?: PolicyRules
  /**
   * The confidence at or above which a kept finding of this profile fails the review with exit code 1: `high`,
   * `medium` or `low`, and `none` for an advisory profile, whose findings and gaps change no exit code. `high`
   * when unset, and when `gating` is `true`; `none` when `gating` is `false`. Setting both is refused.
   */
  readonly failOn?: FailOn
  /**
   * Whether the profile gates the exit code: `true` reads as `failOn: 'high'` and `false` as `'none'`, with a
   * warning in `Quorum.warnings`.
   *
   * @deprecated Set `failOn`.
   */
  readonly gating?: boolean
  /** Reference text the caller already loaded; the core never reads files. */
  readonly guidelines?: string
}

/** A confidence level a kept finding reaches; 'low' only when the policy enables it. */
export type Confidence = 'high' | 'medium' | 'low'

/** The confidence at or above which a profile's kept findings fail the review, or `none` for a profile that never does. */
export type FailOn = Confidence | 'none'

/** The kept votes each level needs once the policy is resolved for a lens count; null for a disabled level. */
export interface Thresholds {
  high: number | null
  medium: number | null
  low: number | null
}

/**
 * A finding after the panel has voted on it. `confidence` is the highest level whose threshold the
 * kept votes reach, computed by the policy and never self-reported by a model: with the default
 * policy and three lenses, 3/3 -> 'high', 2/3 -> 'medium', anything else -> no confidence.
 */
export interface Verdict extends Finding {
  keptVotes: number
  /** The number of votes asked for, failed votes included. */
  totalVotes: number
  confidence?: Confidence
  votes: LensVote[]
}

/**
 * Where a verdict lands: kept at some confidence, discarded, or unreviewed because its failed votes
 * left it undecided (ADR-0012).
 */
export type VerdictStatus = 'kept' | 'discarded' | 'unreviewed'

/**
 * Why part of a review is missing, as an `IncompleteEntry` records it. `research-failed`: a research
 * call, of a gating profile or an advisory one, failed after its retries, or its reply was no findings
 * envelope, so the part of the change it held went unreviewed. `provider-down`: a provider was found down,
 * three of its calls in a row having failed for a reason of its own, so the research parts or the votes it
 * was never sent are missing.
 * `request-too-large`: a provider refused a request that may not fit its model's context, so it was
 * not sent. `binary` and `submodule`: the diff carries no content for a file, shown only as binary
 * or as a submodule's commit; `secret`: no model was sent a file, held back because its name is a
 * secret's or it holds a credential quorum recognizes; `meta.leftOut` lists the files. `too-large`: a
 * hunk of a file, or a section with no hunk, fits in no research part of the profile's model's window,
 * so no part holds it and no model read it; one entry per profile counts them, and
 * `meta.profiles.<id>.coverage` lists their ranges. `token-cap`: the review's token cap stopped part of the profile's work, its research (some
 * of its parts, for a large change) or some of its votes, which were not sent; `review-deadline`: the
 * review reached its deadline, which stopped part of the profile's work, its research (some of its
 * parts) or some of its votes, in flight or not yet sent; `interrupted`: the review was interrupted (its first SIGINT or
 * SIGTERM, as `review`'s `interrupt` carries it), which stopped part of the profile's work, its research (some of its
 * parts) or some of its votes, the calls in flight at the end of the grace included, and no flag lifts it; one entry per
 * limit and profile counts them.
 * `reply-cut-off`: a research reply was cut off at its limit even for the hunks it held after recovery split
 * its part as far as it goes (three splits deep, or one hunk), so those hunks went unreviewed; one entry per
 * profile counts them, `meta.profiles.<id>.coverage` lists their ranges, and no flag lifts it.
 * For a large change researched in parts, `research-failed`, `provider-down` and `request-too-large` count the
 * parts that failed, were not sent or were refused, and each of the other reasons its parts' share.
 */
export type IncompleteReason = 'research-unusable' | 'research-failed' | 'provider-down' | 'findings-capped' | 'finding-unreadable' | 'vote-failed' | 'request-too-large' | 'too-large' | 'token-cap' | 'review-deadline' | 'interrupted' | 'reply-cut-off' | 'binary' | 'submodule' | 'secret'

/**
 * Work the run could not review: a research reply with findings but none usable, a research part that
 * failed (`research-failed`) or was never sent (`provider-down`), findings beyond the cap, a finding the
 * harness could not read, a kept finding whose failed votes could have raised it to a higher
 * level, a request its provider refused as too large to send, work the review's token cap or deadline
 * stopped, a file whose change the diff does not carry, binary or a submodule's commit, or a file held back
 * as a secret, which no model was sent. It is reported and counted, never dropped silently (ADR-0012).
 */
export interface IncompleteEntry {
  /** The id of the profile whose run has the gap. */
  profile: string
  reason: IncompleteReason
  /** The file of the finding the gap is about, when it is about one finding the harness could read: held by `vote-failed` and by a vote's `request-too-large`. */
  file?: string
  detail: string
}

/**
 * Why a file is in `meta.leftOut`: an `exclude` pattern matches it, its change reaches the models only as
 * binary or as a submodule's commit, a path review skipped it (`skipped`), or it was held back as a secret
 * (`secret`, or `deleted-secret` when the change deletes a file named as one whole): a skipped or held file
 * has its `rule`.
 */
export type LeftOutReason = 'excluded' | 'binary' | 'submodule' | 'skipped' | 'secret' | 'deleted-secret'

/**
 * Why a path review skips a file: `vendored`, `lockfile`, `minified`, `test` and `binary` only while the default
 * skips are on, `secret` (a file named as a secret, or whose text holds a credential), `submodule` (a
 * gitlink) and `lfs` (a Git LFS pointer) always, a secret unless the operator sends it. A skip is no gap:
 * the file is listed with its rule, and `--no-default-skips` reviews the five it turns off.
 */
export type SkipRule = 'vendored' | 'lockfile' | 'minified' | 'test' | 'secret' | 'binary' | 'submodule' | 'lfs'

/**
 * The kinds of credential the content check reads, one per provider and `private-key`: the rules of
 * gitleaks 8.30.1 for AWS, GitHub, Slack, Google, Stripe, Anthropic and OpenAI, and the private-key
 * markers of pre-commit-hooks v5.0.0, each followed by a key's body.
 */
export type CredentialKind = 'private-key' | 'aws-key' | 'github-token' | 'slack-token' | 'google-key' | 'stripe-key' | 'anthropic-key' | 'openai-key'

/** Why a file is held back from every review: its name is a secret's (`name`), or it holds a credential of this kind. */
export type SecretRule = 'name' | CredentialKind

/**
 * A file the review left out: one an `exclude` pattern matches, which is no gap; one a path review
 * skipped, which is no gap either, and whose `rule` says which rule did; one whose change the diff
 * does not carry, `binary` or `submodule`, which is a gap of every profile; or one held back as a secret,
 * which no model was sent: `secret` is a gap of every profile, `deleted-secret` (the change deletes a file
 * named as a secret whole, so it adds no code a review would read) is none, and the `rule` of either says
 * whether its name or a credential in it held it. `rule` is there exactly for a skipped or a held file. A
 * reader takes a reason or a rule it does not know as a file left out, never as an error.
 */
export type LeftOutFile
  = | {
    /** The diff's own path, decoded; '' for a part of the diff that no `diff --git` header names. */
    file: string
    reason: 'excluded' | 'binary' | 'submodule'
  }
  | {
    /** The path as the source named it: a path review's, decoded as the diff would name it. */
    file: string
    reason: 'skipped'
    rule: SkipRule
  }
  | {
    /** The diff's own path, decoded, by which no model was sent the file; '' for the text no `diff --git` header names. */
    file: string
    reason: 'secret' | 'deleted-secret'
    /** What held it: `name` when its name is a secret's, else the kind of credential its text holds. */
    rule: SecretRule
  }

/**
 * Why part of a file was not reviewed, as `CoverageEntry` records it: a `LeftOutReason`'s `binary`,
 * `submodule`, `secret` or `deleted-secret`, `too-large` for a hunk, or a section with no hunk, that fits in
 * no research part of its model's window, or the `IncompleteReason` of the research part that held it and
 * did not read it: `request-too-large`, `token-cap`, `review-deadline`, `interrupted`, `research-failed`, `provider-down` or, for a
 * hunk still cut off when recovery had split it as far as it goes, `reply-cut-off`.
 */
export type CoverageReason = 'binary' | 'submodule' | 'secret' | 'deleted-secret' | 'too-large' | 'request-too-large' | 'token-cap' | 'review-deadline' | 'interrupted' | 'research-failed' | 'provider-down' | 'reply-cut-off'

/**
 * How much of a file a profile's research reviewed: `reviewed` when every part that holds it was
 * read, `partial` when some was not, `unreviewed` when none was, and `excluded` when an `exclude`
 * pattern keeps it out of every request.
 */
export type CoverageStatus = 'reviewed' | 'partial' | 'unreviewed' | 'excluded'

/** A run of new-file lines a profile's research did not review, both ends included, and why. */
export interface LeftRange {
  start: number
  end: number
  reason: CoverageReason
}

/** One file of the input diff and how much of it a profile's research reviewed. */
export interface CoverageEntry {
  /** The diff's own path, decoded; '' for a part of the diff that no `diff --git` header names. */
  file: string
  status: CoverageStatus
  /** Why the file is unreviewed; absent for any other status. */
  reason?: CoverageReason
  /** The ranges a partial file left unreviewed, in the diff's order; absent for any other status. */
  left?: LeftRange[]
}

/** What an advisory flag points at: hidden characters, text addressed to an AI reviewer, or a file held back or skipped as a secret, by its name or a credential it holds. */
export type FlagCode = 'hidden-characters' | 'ai-addressed-text' | 'secret-file'

/**
 * An advisory signal the harness read by code, before any model saw it, from the diff or from the files
 * the input's source left out: it tells a human where to look, and never changes a verdict, a confidence
 * or an exit code.
 */
export interface Flag {
  code: FlagCode
  /** The diff's own path for the file, or the path of a file held back or skipped as a secret; absent for a diff without per-file headers, and for the text no header names. */
  file?: string
  /** The first added line, in the new file, the flag is about; absent when it is about the file name, and for a `secret-file` flag. */
  line?: number
  /** What was found, in words the code wrote: code points or the names of patterns, never text of the diff. */
  detail: string
}

/** Names a provider in events and in `meta`: its id and model, captured when the quorum was created. */
export interface ProviderRef {
  id: string
  model: string
}

/** Who reviews for one profile: its research provider, and the provider of each lens keyed by lens id. */
export interface ProfileProviders {
  research: ProviderRef
  lenses: Record<string, ProviderRef>
}

/** What a review records about one of its profiles. */
export interface ProfileMeta {
  providers: ProfileProviders
  /** The kept votes each confidence level needed: the profile's policy resolved for its lens count. */
  policy: Thresholds
  /**
   * The confidence at or above which its kept findings exit 1, `none` for an advisory profile. A result of an
   * earlier release has none: a reader takes its `gating: false` as `none`, and anything else as `high`.
   */
  failOn: FailOn
  /** Whether it gates the exit code: true unless `failOn` is `none`. */
  gating: boolean
  /** How many findings it dropped for citing code outside the diff. */
  invalidFindings: number
  /**
   * Every file of the input diff once, in its order, with how much of it this profile's research
   * reviewed: `reviewed` when a research request that carried all of the file's text was answered with a
   * valid envelope, whatever it found; the other statuses, and the ranges a `partial` file left, say what
   * was not. Each profile has its own, since each has its own research model.
   */
  coverage: CoverageEntry[]
  /**
   * What recovery did for this profile's research, present when it split a part (and absent when it split none):
   * `parts` the parts it split, `pieces` the final pieces they ended with, each read or left at the floor, not every
   * piece asked on the way, `saturated` the replies that listed as many findings as they were asked for at most and
   * were split for it, and `unreadHunks` the hunks the floor left unread in those parts, cut off even alone. A part cut
   * off at the floor at once was not split: it has no entry here, and its hunks are in the `reply-cut-off` gap.
   */
  recovery?: { parts: number, pieces: number, saturated: number, unreadHunks: number }
}

/**
 * Where a review's diff came from, as `meta.source` records it: `diff` for a diff file or standard input,
 * `range` for the commits `base...head` (`mergeBase` the commit the diff starts from), `local` and `staged`
 * for the local changes (`head` null before a first commit), and `paths` for the files under `paths` at
 * `commit`, with `skips` whether the default skips applied. Every id is a full commit id of the repository's
 * `objectFormat`. It never holds a revision as written, a local file name or a git version.
 */
export type ReviewSource
  = | { kind: 'diff' }
    | { kind: 'range', base: string, mergeBase: string, head: string, objectFormat: ObjectFormat }
    | { kind: 'local' | 'staged', head: string | null, objectFormat: ObjectFormat }
    | { kind: 'paths', commit: string, paths: string[], skips: boolean, objectFormat: ObjectFormat }

/**
 * A setting quorum moved by itself for the rest of one review, as `meta.adaptations` records it and an `adapted`
 * event reports it: the provider's id, the `setting` and what it moved `from` and `to`, and the `cause`, a code
 * word. `thinking` is lowered when a reply ran out of room while reasoning (`cut-off-thinking`) or held only
 * reasoning (`no-answer-thinking`), and put back to the server's default when the server refused the lowered value
 * (`lowering-refused`, `from` the level tried); `structuredOutput` moves from `json` to `prompt` when a reply in JSON
 * mode was empty (`empty-reply`) or the server refused the mode (`format-refused`); `stream` moves from `stream` to
 * `bare`, a stream with no stream options, when the server refused them, and from `stream` or `bare` to `whole`, whole
 * replies, when the server refused streaming (`stream-refused`) or answered a streamed call whole
 * (`stream-answered-whole`); `replyTokens` moves from `derived`, a reply budget the core derives from the provider's facts, to the
 * tokens a learned cut on the way lets through, which every later reply of the provider is held to (`cut-on-the-way`). The causes `byte-bound-refused`
 * and `loaded-window` belong to the settings `tokenCount` and `window`, which a later release moves.
 */
export interface Adaptation {
  provider: string
  setting: 'thinking' | 'structuredOutput' | 'stream' | 'replyTokens' | 'tokenCount' | 'window'
  from: string
  to: string
  cause: 'cut-off-thinking' | 'no-answer-thinking' | 'empty-reply' | 'format-refused' | 'stream-refused' | 'stream-answered-whole' | 'cut-on-the-way' | 'byte-bound-refused' | 'loaded-window' | 'lowering-refused'
}

/** What a review records about itself, besides its verdicts. */
export interface QuorumMeta {
  /** The version of quorum that ran the review, read from package.json. */
  version: string
  /** When the review started, as an ISO 8601 timestamp. */
  startedAt: string
  /** How long the review took, in whole milliseconds. */
  durationMs: number
  /** Where the diff came from: `{ kind: 'diff' }` when the input names no source. It never holds a revision as written, a local file name or a git version. */
  source: ReviewSource
  /** One entry per profile, keyed by profile id, in the run's profile order. */
  profiles: Record<string, ProfileMeta>
  /** The usage summed over the calls that reported valid counts; absent when none did. */
  usage?: Usage
  /** Gaps that are not findings. An entry here, or an unreviewed finding, makes the review incomplete. */
  incomplete: IncompleteEntry[]
  /** The files the review left out, the input's own first, then the diff's, once per file, reason and rule. Each, but an excluded, a skipped or a `deleted-secret` one, is also a gap of every profile: a file held back as a secret is one no model was sent. */
  leftOut: LeftOutFile[]
  /** Advisory signals the harness read from the diff, and from the files left out as secrets, held back or skipped by a source, which come first: where a human should look. They change no verdict and no exit code. */
  flags: Flag[]
  /** What the review moved by itself, in the order it happened: empty when nothing moved. A setting an explicit option holds is never moved. */
  adaptations: Adaptation[]
  /** How many research calls and votes were reused from the review's store, counted from the `call` events that say `reused`: present when a store was given, even at 0. */
  reused?: { research: number, votes: number }
  /**
   * What each provider's lane did, by provider id: its `limit` (`auto` when `concurrency` is unset, else the number), where it started, its lowest and its highest
   * limit, how many times it was cut, and whether its replies carried rate-limit headers. Two provider objects of one id are merged. Present when a call was made.
   */
  concurrency?: Record<string, ConcurrencyRecord>
}

/** Final review output. */
export interface QuorumResult {
  kept: Verdict[]
  discarded: Verdict[]
  /** Findings a failed vote left undecided: neither kept nor cleared. */
  unreviewed: Verdict[]
  meta: QuorumMeta
}

/** A vote as the public view keeps it: the lens, whether it kept the finding (`null` when the vote failed) and its failure, never its reasoning or its error. */
export interface PublicVote {
  angle: string
  keep: boolean | null
  failure: VoteFailure | null
}

/** A verdict of the public view: the verdict with its votes reduced to `PublicVote`s. */
export type PublicVerdict = Omit<Verdict, 'votes'> & { votes: PublicVote[] }

/** What the public view records about a profile: no providers, and the count of its discarded findings, which the view does not list. */
export interface PublicProfileMeta extends Omit<ProfileMeta, 'providers'> {
  /** How many findings of the profile the panel discarded. */
  discarded: number
}

/** A gap as the public view keeps it: the profile, the reason and the file, never the detail. */
export type PublicGap = Omit<IncompleteEntry, 'detail'>

/** The meta of the public view: no usage, no providers, no gap detail, and `view` to say so. */
export interface PublicMeta extends Omit<QuorumMeta, 'profiles' | 'usage' | 'incomplete'> {
  view: 'public'
  profiles: Record<string, PublicProfileMeta>
  incomplete: PublicGap[]
}

/** A result less what helps an attacker, which every public sink renders: see `publicView`. */
export interface PublicView {
  kept: PublicVerdict[]
  /** Always empty: the discarded findings are counted in `meta.profiles.<id>.discarded`. */
  discarded: []
  unreviewed: PublicVerdict[]
  meta: PublicMeta
}

/** What a quorum runs, and the limits every one of its reviews keeps to. */
export interface QuorumOptions {
  /** At least one, ids unique: each runs research, dedup and panel on its own, concurrently with the others. */
  readonly profiles: readonly Profile[]
  /**
   * Maximum simultaneous provider calls per review, shared by every profile, which pins today's one limit with no lane, no event and no
   * pacing. Unset, each provider has a lane of its own under a ceiling of `REVIEW_CEILING` calls in all, which starts at `LANE_START`
   * (or at the `slots` the provider states), grows while the provider's rate-limit headers hold one more call, halves on a throttle and
   * waits out a Retry-After.
   */
  readonly concurrency?: number
  /** How many findings of a research reply each profile sends to the panel; `DEFAULT_MAX_FINDINGS` when unset. */
  readonly maxFindings?: number
  /** Path patterns of the files left out of every request; none when unset. */
  readonly exclude?: readonly string[]
  /**
   * The most tokens, input and output, one review may spend: a whole number from 1 to `Number.MAX_SAFE_INTEGER`,
   * 2000000 when unset. Each attempt reserves its worst case before it is sent and settles at what it spent; what
   * the cap stops is a `token-cap` gap of its profile.
   */
  readonly maxReviewTokens?: number
  /**
   * How long one review runs, in milliseconds: a whole number from 1000 to 86400000, 1800000 (30 minutes) when
   * unset. At it every call in flight and every wait is stopped at once and no new call starts, and what was not
   * done is a `review-deadline` gap of its profile: the review resolves with its findings so far. It is no abort.
   */
  readonly reviewTimeoutMs?: number
  /**
   * The most tokens of diff text, counted as the size guard counts, one research request of a large change
   * holds: a whole number from 1024 to `Number.MAX_SAFE_INTEGER`, 32768 when unset. A diff over it, or over
   * what the research model's window leaves, is researched in parts of at most this size; a provider that
   * states no room is sent the whole diff in one request.
   */
  readonly partTokens?: number
}

/**
 * What one review takes: the diff, and optionally where it came from, the files its source left out before it
 * made the diff, and the files to send though they are held back as secrets.
 */
export interface ReviewInput {
  readonly diff: string
  /** Where the diff came from, checked and recorded in `meta.source` as given; `{ kind: 'diff' }` when unset. */
  readonly source?: ReviewSource
  /**
   * The files the source left out before it made the diff, listed in `meta.leftOut` and in the `left-out`
   * event ahead of the diff's own. A `binary`, `submodule` or `secret` one is a gap of every profile, as the
   * diff's are; an `excluded`, a `skipped` or a `deleted-secret` one is no gap. A `skipped` one of the rule
   * `secret`, a `secret` and a `deleted-secret` one each raise a `secret-file` flag.
   */
  readonly leftOut?: readonly LeftOutFile[]
  /**
   * The files of the diff to send the models though they are held back as secrets, each the path as the diff
   * writes it, the one `meta.leftOut` lists, matched exactly: `./.env` names no file `.env`. A file named here
   * is never held, so it is neither listed nor flagged as a secret; the text no header names, the file of the
   * empty name, can never be named. None when unset.
   */
  readonly send?: readonly string[]
}

/**
 * What one profile's review may cost, in tokens, as `Quorum.estimate` counts it before any call. Each figure is
 * what the review's token ledger reserves for a call, not what the call spends.
 */
export interface ProfileEstimate {
  /** What the ledger reserves for each research request of the profile, in order: one for a diff researched whole, else one per part that holds more than white space. Empty when research makes no call. */
  parts: number[]
  /** The most votes the panel casts: `findingsCap` findings, each voted by every lens of the profile. 0 when research makes no call. */
  votes: number
  /** What the ledger reserves at most for one vote of each lens, keyed by lens id. Empty when research makes no call. */
  vote: Record<string, number>
  /** The research parts alone, each counted at a third of its input, rounded up (code takes about that many tokens, not one per byte), and its reply at the lesser of its budget and 4096 tokens, its usual size. The votes are not in it, since how many findings research reports is not known before it runs. */
  expected: number
  /** The most the profile may reserve in all: each research part in full and every piece recovery may make of it, and `findingsCap` votes of every lens at its bound. The calls an adaptation sends once more, and the calls a bad reply sends once more, are the provider's, and join `Estimate.worst` alone. */
  worst: number
  /** The findings its research requests ask for at most, the most serious first: `maxFindings`, or fewer when the research provider's reply budget holds fewer. */
  findings: number
  /** The id of the profile's research provider. */
  provider: string
}

/**
 * What a review of a diff may cost, as `Quorum.estimate` states it: no call is made. `profiles` is keyed by
 * profile id, in the run's order; `expected` sums the profiles', and `worst` too, plus what each provider's
 * adaptations may send once more: per setting its `adapts` states, the `concurrency` largest reservations of its
 * calls, plus each call once more of a provider that states a retry, whatever its thinking (a bad reply is sent once
 * more, and any of its calls may be the one). `worst` is an upper bound, never an average, with one attempt per call: a retry reserves again. `inFlight` is what the calls that run at once reserve, the
 * `concurrency` largest bounds among every research part and vote, and `fits` is whether `expected` and `inFlight`
 * together are within `maxReviewTokens`: recovery and the adaptations are in `worst` and not in `fits`. It is an
 * estimate: the review's ledger still holds the cap, whatever `fits` says.
 */
export interface Estimate {
  profiles: Record<string, ProfileEstimate>
  expected: number
  worst: number
  inFlight: number
  /** How many findings of a research reply each profile sends to the panel, as `createQuorum` was given or defaulted it. */
  maxFindings: number
  /** The most findings of the research each profile sends to its panel in the review the estimate is for: the `limits` it was given, else `maxFindings`. Every research request is still sized by `maxFindings`. */
  findingsCap: number
  /** The token cap the estimate was made under: the `limits` it was given, else the quorum's, as `createQuorum` was given or defaulted it. */
  maxReviewTokens: number
  /** The deadline the estimate was made under, in milliseconds: the `limits` it was given, else the quorum's. */
  reviewTimeoutMs: number
  fits: boolean
  /**
   * How many research parts the cap holds: the parts of every profile, in profile order and the order they are sent,
   * counted while their expected spends and `inFlight` stay within `maxReviewTokens`. 0 when the cap is below
   * `inFlight`, and every part when `fits`.
   */
  held: number
}

/** A quorum built by createQuorum: its profiles compiled once, ready to review any number of diffs. */
export interface Quorum {
  /**
   * Review one diff with every profile of the quorum, recording its `source` in `meta.source` and
   * listing the files its source left out (`leftOut`) before the diff's own. Once `signal` aborts, the
   * review stops and rejects with the signal's reason; an aborted review never resolves. Once `interrupt` aborts, the
   * review stops more gently: no new call starts, every wait ends, the calls in flight have `INTERRUPT_GRACE_MS` to end
   * and are read when they do, and the review resolves with what it read, the rest an `interrupted` gap. The review is
   * over once it has sent `run:end`: an abort from that event's handler, or later, has no effect, and the
   * review resolves with its result. With a `store`, the review saves each call that passed its check and reuses what
   * the store holds for a request sent as it was, checked as a fresh reply, spending nothing on it (`meta.reused`).
   * `maxReviewTokens` and `reviewTimeoutMs` are the token cap and the deadline of this review alone, in place of the
   * quorum's, each checked as `QuorumOptions` checks it: a caller that sizes a cap or a deadline to its input, as the
   * CLI does for a path review, gives them here and leaves the quorum's as its default for the reviews that give none.
   * `findingsCap` is the most findings of the research each profile sends to its panel in this review, a positive
   * integer, in place of `maxFindings`; every research request is still sized by `maxFindings`, so a `findingsCap`
   * above it changes no request and splits no reply, and the findings past it are a `findings-capped` gap.
   */
  readonly review: (input: ReviewInput, options?: { readonly signal?: AbortSignal, readonly interrupt?: AbortSignal, readonly store?: ReplyStore, readonly maxReviewTokens?: number, readonly reviewTimeoutMs?: number, readonly findingsCap?: number }) => Promise<QuorumResult>
  /**
   * What a review of `input.diff` may cost, before any call: per profile, what the token ledger reserves for each
   * research part, and a bound for every vote. It makes no call and reads no file. The research parts are counted
   * in `expected` at a third of their input, code taking about three bytes a token, and their reply at its usual
   * size, and the votes in the worst case only, which also counts every part recovered, the calls an adaptation
   * sends once more and the calls a bad reply sends once more; `fits` says whether `expected` and what the calls in flight reserve are within
   * `maxReviewTokens`. It is an estimate, not a promise: a review still reserves each call against the cap.
   * A file held back as a secret costs nothing, and one `input.send` names is counted, as `review` sends it.
   * `limits` are the cap and the deadline the estimate is made under, in place of the quorum's, as `review`'s
   * `maxReviewTokens` and `reviewTimeoutMs` are: `Estimate.maxReviewTokens`, `reviewTimeoutMs`, `fits` and `held` read them.
   * `findingsCap`, as `review` takes it, moves `Estimate.findingsCap`, each profile's `votes` and `worst`, and `inFlight`
   * and what `fits` and `held` read of it, since it counts each lens's votes; the parts, their reservations and
   * `expected` do not depend on it, as `maxFindings` sizes every request.
   * Throws a `ConfigError` for an input or a limit `review` would refuse.
   */
  readonly estimate: (input: { readonly diff: string, readonly send?: readonly string[] }, limits?: { readonly maxReviewTokens?: number, readonly reviewTimeoutMs?: number, readonly findingsCap?: number }) => Estimate
  /** Settings that cannot take full effect, such as a policy level that never applies; each starts at its profile id. */
  readonly warnings: readonly string[]
  /**
   * The budgets of each profile by id, at its providers' stated windows, frozen: each request kind's reply budget, the
   * findings a research request asks for, the tokens of diff each provider's stated room leaves a request, and the worst
   * case of a research part with how many the review's token cap holds. A provider that states no room has no rooms.
   */
  readonly budgets: Readonly<Record<string, ProfileBudgets>>
}

/** The stages every profile runs through, in this order. */
export type StageName = 'research' | 'dedup' | 'panel'

/**
 * Where a research call stands in its profile's research: the part's `index` among its `count` parts, both from
 * 1, and when recovery split the part, the `piece` among the `count` pieces of its depth. Numbers alone.
 */
export interface Position {
  index: number
  count: number
  piece?: { index: number, count: number }
}

/**
 * What a failed call says of itself, as facts and never its words: the `kind` of the failure, its HTTP `status` when
 * it is an `http` failure with one, and `exhausted` when that failure said the account's credit, quota or spend
 * limit is used up. `cutAfterMs` is set only on the failure a call ends with (a `part` event's), when its last attempt
 * was cut on the way: a `network` failure, or an `http` 502, 504 or 524, after at least `CUT_AFTER_MS`, and holds the
 * attempt's length in milliseconds. `refused` is `stream` when an `http` 400 or 422 named the stream or its options,
 * which a provider with `stream: true` can only be told to give up. `stalledMs` is set on a `timeout` that was a stream with
 * no progress for that long, in milliseconds: the window it stalled at. `ceilingMs` is set on a `timeout` at a ceiling that
 * grew while its stream progressed, in milliseconds: the ceiling it reached.
 */
export interface CallFailure {
  kind: ProviderErrorKind
  status?: number
  exhausted?: true
  cutAfterMs?: number
  refused?: 'stream'
  stalledMs?: number
  ceilingMs?: number
}

/**
 * What a `call:retry` says of a reply that came back and could not be read: the stage's own check refused it, so no
 * provider failure names it. The word is the one a failed vote has for the same reply (`VoteFailureKind`).
 */
export interface UnusableReply {
  kind: 'unusable-reply'
}

/**
 * What a review reports while it runs, delivered synchronously to the event sink as it happens.
 * Events are plain data, which the review hands the sink as copies; a field that a structured
 * clone cannot copy, or whose class matters, does not belong in one.
 */
export type QuorumEvent
  /** The review starts: the profiles it runs, and who reviews for each. */
  = | { type: 'run:start', profiles: string[], providers: Record<string, ProfileProviders> }
    /** The files the review leaves out, as `meta.leftOut` holds them, the input's first: sent once right after `run:start` when there is one. */
    | { type: 'left-out', files: LeftOutFile[] }
    /** An advisory flag, read from the diff or from the files left out as secrets, sent before any stage starts. */
    | { type: 'flag', flag: Flag }
    /**
     * A stage of one profile starts. `parts` is the research's part count, the plan's (1 when the change is not
     * packed, 0 when no part holds any of it), and `votes` the panel's vote count, its findings times its lenses.
     */
    | { type: 'stage:start', profile: string, stage: StageName, parts?: number, votes?: number }
    /** A stage of one profile ends; `count` is the findings it produced, or the verdicts for `panel`. */
    | { type: 'stage:end', profile: string, stage: StageName, durationMs: number, count: number }
    /**
     * A provider call starts: sent once per call, inside its slot, when its first attempt's reservation is granted
     * and before the attempt is sent. A call that was answered from the store, refused by the down rule or stopped
     * by a limit before its first attempt sends none. `call` is the call's number in the review, from 1, in the
     * order calls start, which its `call:retry` and `call` events repeat; `part` and `finding` say what it asks (a
     * research call's position, a vote's finding id); `reserved` is the tokens its first attempt reserved in the
     * review's ledger and `timeoutMs` the ceiling of its first attempt: the deadline the provider stated, else the one
     * its reply budget sizes. `stream` is `true` when that attempt is streamed, so the core watches it for progress.
     * Every field is a number, an id or a code word.
     */
    | { type: 'call:start', call: number, profile: string, role: 'research' | 'vote', lens?: string, provider: ProviderRef, part?: Position, finding?: string, reserved: number, timeoutMs: number, stream?: true }
    /**
     * A streamed call shows progress: sent at most once a second per call, on the review's clock. `outputTokens` is the
     * output its streamed attempt has shown, the larger of the server's own count and a quarter of the characters, and
     * `signal` is `tokens` when it grew since the call's last `call:progress`, `keep-alive` when only keep-alives came.
     * Never sent for a call that does not stream, nor for the headers alone. Numbers and a code word only.
     */
    | { type: 'call:progress', call: number, outputTokens: number, signal: 'tokens' | 'keep-alive' }
    /**
     * A call's attempt failed and the call waits to send another: sent before each wait, once the wait is known and
     * the review's stop has not fired. `call` is the call's number, `attempt` the number of the failed attempt of
     * its send, from 1, `retries` the retries its provider states, `failure` what the failure said of itself and
     * `attemptMs` how long the failed attempt ran, from its send to its failure, in whole milliseconds on the review's
     * clock, and `waitMs` the wait, in milliseconds. A failure the stop ends instead of a retry sends none. A `failure` of kind
     * `no-answer`, a vote's `truncated` and an `unusable-reply` (a reply the stage could not read) is the call's one more send of
     * a bad reply, as it is, once the adaptations had their try: a call sends one, within its provider's retries, and no other
     * retry has these kinds.
     */
    | { type: 'call:retry', call: number, attempt: number, retries: number, failure: CallFailure | UnusableReply, attemptMs: number, waitMs: number }
    /**
     * One per provider call, failed ones included, sent when the call ends. The call runs its
     * attempts inside its slot, retried as the retry policy decides, so `durationMs` runs from its
     * first attempt to its end, the waits between attempts included; `attempts` is their number,
     * only when the call made more than one; `usage` is summed over the attempts that reported
     * valid counts; `spent` is the tokens the review's cap counted for the call: each attempt's
     * reported usage, nothing for one the server refused before any work, else its reservation. `reused` is true for a call
     * the review's store answered with no attempt made: it holds no `usage` and no `attempts`, and `spent` is 0.
     * `call` is the call's number, the one its `call:start` carried, absent for a call that sent none; `part` and
     * `finding` are the research position or the finding it asked about; `listed` is the findings the research
     * reply listed, as the stage's check read it, and `reasoning` whether the reply showed reasoning, when the
     * provider could tell. An ok call whose answered attempt streamed adds `firstTokenMs`, from the attempt's send to its
     * first data event, the headers excluded, and `longestSilenceMs`, the longest time between two signs of its progress,
     * the headers counted as one; and `ceilingMs`, in milliseconds, when the deadline of that attempt grew while it streamed:
     * the ceiling it reached.
     */
    | { type: 'call', call?: number, profile: string, role: 'research' | 'vote', lens?: string, provider: ProviderRef, part?: Position, finding?: string, durationMs: number, ok: boolean, attempts?: number, usage?: Usage, spent: number, reused?: true, listed?: number, reasoning?: boolean, firstTokenMs?: number, longestSilenceMs?: number, ceilingMs?: number }
    /**
     * A provider was found down: three of its calls in a row failed for a reason of its own (`kind`, and for an
     * `http` failure its `status`), so no call goes to it for the rest of the review. Sent once per provider, at the
     * moment the third call ends; the calls in flight run to their end. `exhausted` is true when the failure said
     * the account's credit, quota or spend limit is used up: the provider is then found down at its first call
     * that failed so, `calls` is 1, and no retry was made. `cutAfterMs` is present only when every call of the streak
     * was cut on the way, and holds the shortest of their last attempts' lengths, in milliseconds. `stalledMs` is present
     * only when every call of the streak stalled, and holds the shortest of their windows. `refused` is `stream`
     * when the last failure was a stream the server refused.
     */
    | { type: 'provider-down', provider: string, kind: ProviderErrorKind, status?: number, calls: number, noAnswer?: NoAnswer, exhausted?: true, cutAfterMs?: number, stalledMs?: number, refused?: 'stream' }
    /**
     * A reply lacked what a review needs, said once per provider and line in a review: `truncated` with
     * `noAnswer` `window` (the server's window ended it) or `reply` or `thinking` with `outputTokens` below the
     * `limit` the request was sent with (the server caps replies lower), and `no-answer` with `thinking` (only
     * reasoning) or `empty` (nothing). A cut-off at its limit sends none. Every field is a code fact the call path
     * read, never a word a provider's error or a reply held.
     */
    | { type: 'reply-lacked', provider: string, kind: 'truncated' | 'no-answer', noAnswer: NoAnswer, limit?: number, outputTokens?: number, inputTokens?: number, window?: number }
    /**
     * A research part was recovered: its reply was cut off at its limit, or listed as many findings as it was asked
     * for at most, so it was split in two, each half researched as a part, to a floor of one hunk and three splits.
     * Sent once the part's pieces have answered. `noAnswer` is what the first reply lacked (`saturated` for a
     * saturated one), `limit` the reply limit it was cut at when the request carried one, `findings` the findings a
     * saturated reply was asked for, `cutAfterMs` in place of `limit` for a reply cut on the way at the length its provider learned (`cut`), `thinkingLowered` whether the provider's thinking had been lowered when recovery
     * began, `pieces` the final pieces the part ended with, each read or left at the floor, and `read` how many of them were read, and `unreadHunks` and
     * `unreadFiles` what the floor left unread. Every field is a count or a code word.
     */
    | { type: 'recovered', profile: string, part: number, parts: number, noAnswer: Exclude<NoAnswer, 'empty'> | 'saturated', limit?: number, cutAfterMs?: number, findings?: number, thinkingLowered: boolean, pieces: number, read: number, unreadHunks: number, unreadFiles: number }
    /**
     * A provider's calls are cut on the way: two of its cut attempts, of any calls, ended at about the same length, so each
     * later attempt cut there is read as a reply cut off at its limit, and 3e's path takes it, the thinking probe once, then the
     * split. Sent once per provider and review. `afterMs` is the cut's length, `holds` the tokens a reply may hold at the lowest
     * rate the two attempts that taught the cut streamed, four fifths of what the cut lets through (absent when no rate was measured), and `lowered`
     * whether a derived reply budget it serves was held to it (`adapted` records it); with `maxTokens` set it is not, and `holds` is
     * the value to lower it to. `fits` is `true` when `maxTokens` is unset and every derived budget the provider serves was
     * already at or under `holds`, so nothing was lowered and there is nothing to advise. Every field is a provider's id, a
     * number or a boolean.
     */
    | { type: 'cut', provider: string, afterMs: number, holds?: number, lowered: boolean, fits?: true }
    /**
     * A provider's lane changed its limit, paused or paced, with `concurrency` unset: `limit` is the lane's limit once the change is
     * made. `cause` is `grown` (one more call, the headers holding it), `regrown` (back toward its start, after a cut, with no header),
     * `cut` (halved by a throttle signal, `from` the limit before it, `failure` the throttle), `paused` (new calls held `waitMs` for a
     * Retry-After, `failure` the throttle, the calls in flight going on), `paced` (a call waits `waitMs` for the headers' reset) and `slots` (the
     * lane holds the slots the provider states, sent once when its lane begins). Every field is a provider's ref, a number or a code word.
     */
    | { type: 'concurrency', provider: ProviderRef, limit: number, cause: 'grown' | 'cut' | 'paused' | 'paced' | 'regrown' | 'slots', from?: number, waitMs?: number, failure?: CallFailure }
    /**
     * Quorum moved a setting of a provider by itself for the rest of the review, said once per provider and
     * setting: the same record `meta.adaptations` holds. Every field is a provider's id or a code word.
     */
    | { type: 'adapted', adaptation: Adaptation }
    /**
     * A reply the review's store held failed the check a fresh reply passes, so the call was made again: said once per
     * provider and role in a review. Whoever wrote the state directory wrote it. It holds a provider's id and a code word only.
     */
    | { type: 'stored-refused', provider: string, role: 'research' | 'vote' }
    /** A finding was dropped for citing code outside the diff, with the reason. */
    | { type: 'finding:invalid', profile: string, reason: string }
    /** A gap was recorded, as `meta.incomplete` will hold it. */
    | { type: 'incomplete', entry: IncompleteEntry }
    /**
     * A research part ended, sent once per part as it ends, after its `recovered` event when it has one. `part` is
     * its position, `outcome` what became of it (`reviewed` when every piece was read, else the first unread
     * piece's), `durationMs` the time from its first call's start (0 when it made none), `spent` the tokens its
     * calls counted, `reused` true when it made at least one call and the store answered every one, `listed` the
     * findings its read replies listed (absent when none was read), `failure` what the first call that failed said
     * of itself, and `pieces` the pieces recovery split it into, how many were read and how many were not, by outcome. Every field is a count, a duration or a code word.
     */
    | { type: 'part', profile: string, part: { index: number, count: number }, outcome: PartOutcome, durationMs: number, spent: number, reused?: true, listed?: number, failure?: CallFailure, pieces?: { count: number, read: number, unread: Partial<Record<Exclude<PartOutcome, 'reviewed'>, number>> } }
    /**
     * The review began to stop while its stages ran, sent once. The deadline (`cause` `review-deadline`) stops every call
     * in flight and starts no new one, and what is left undone is a `review-deadline` gap. The interrupt (`cause`
     * `interrupt`) starts no new call and ends every wait, gives the calls in flight `graceMs` to end, and leaves what is
     * undone an `interrupted` gap. `inFlight` counts the attempts sent and not settled when it began.
     */
    | { type: 'run:stopping', cause: 'interrupt' | 'review-deadline', inFlight: number, graceMs?: number }
    /** One lens voted on one finding; `keep` is null, with the error and the failure's kind and status, when the vote failed. */
    | { type: 'vote', profile: string, findingId: string, lens: string, keep: boolean | null, error?: string, failure?: VoteFailure }
    /** The panel decided one finding: its vote split, the confidence it earned and where it lands. */
    | { type: 'verdict', profile: string, findingId: string, keptVotes: number, totalVotes: number, confidence?: Confidence, status: VerdictStatus }
    /** The review ends: how many verdicts landed where, how many gaps it recorded, and how long it took. */
    | { type: 'run:end', kept: number, discarded: number, unreviewed: number, incomplete: number, durationMs: number }

/** A finding exactly as the finder reports it: the wire shape validated by core/output.ts. */
export interface FindingDetails {
  file: string
  line: number
  category: string
  /** The code the finder says the finding is about. It is only compared with the evidence and is never forwarded. */
  quote: string
  summary: string
}

/** Token counts, and the cost when the adapter knows it, for one provider call. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

/** The hash a repository names its objects with: `sha1` is git's default, `sha256` the repositories made with `--object-format=sha256`. A full id is 40 hexadecimal characters for the first and 64 for the second. */
export type ObjectFormat = 'sha1' | 'sha256'
