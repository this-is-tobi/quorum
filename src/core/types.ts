/**
 * Shared types of the quorum core: profiles, findings, verdicts, the result and its metadata, and events.
 *
 * @see ../../docs/95-reference/40-architecture.md for the module overview.
 * @see ../../docs/95-reference/30-library-api.md for usage.
 */

import type { PolicyRules } from './policy.ts'

/**
 * A candidate issue after the harness checked it against the diff. The finder supplies the file,
 * line, category and claim; the evidence is read from the diff by code, never from the finder.
 */
export interface Finding {
  /** Names the finding, stable across runs: the first 12 hex characters of SHA-256 over the JSON array `[profile, file, line, category]`. */
  id: string
  /** The id of the profile whose run found it. */
  profile: string
  /** The diff's own path; for a diff without per-file headers, the finder's name for it, cleaned. */
  file: string
  line: number
  /** The finder's category, cleaned and capped like the summary. */
  category: string
  /** The finder's claim, stripped of control, format and other invisible characters and capped. */
  summary: string
  /** The diff lines around `line` with their +, - or space markers (a line's trailing carriage return removed), capped. */
  evidence: string
  /** Whether the finder's quote appears in the evidence: a measure of hallucinated citations. */
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
 * What a vote failed with: a provider's kind of failure, the limit that stopped it (`token-cap` or
 * `review-deadline`), `unusable-reply` for a reply the panel could not read as a vote, or `unknown` for
 * anything else thrown.
 * The kinds a gating profile's `--allow-incomplete` lifts are `network`, `timeout` and an `http` failure of
 * status 408, 409, 429 or 5xx.
 */
export type VoteFailureKind = 'http' | 'network' | 'process' | 'timeout' | 'aborted' | 'refusal' | 'truncated' | 'invalid-response' | 'unsupported' | 'too-large' | 'token-cap' | 'review-deadline' | 'unusable-reply' | 'unknown'

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
  /** Whether its kept high findings set exit code 1; true when unset. */
  readonly gating?: boolean
  /** Reference text the caller already loaded; the core never reads files. */
  readonly guidelines?: string
}

/** A confidence level a kept finding reaches; 'low' only when the policy enables it. */
export type Confidence = 'high' | 'medium' | 'low'

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
 * Why part of a review is missing, as an `IncompleteEntry` records it. `research-failed`: an
 * advisory profile's research call failed after its retries, or its reply was no findings
 * envelope, so the profile reviewed nothing; a gating profile's ends the review instead.
 * `request-too-large`: a provider refused a request that may not fit its model's context, so it was
 * not sent. `binary` and `submodule`: the diff carries no content for a file, shown only as binary
 * or as a submodule's commit; `meta.leftOut` lists the files. `too-large`: a hunk of a file, or a
 * section with no hunk, fits in no research part of the profile's model's window, so no part holds it and no
 * model read it; one entry per profile counts them, and `meta.profiles.<id>.coverage` lists their
 * ranges. `token-cap`: the review's token cap stopped part of the profile's work, its research (some
 * of its parts, for a large change) or some of its votes, which were not sent; `review-deadline`: the
 * review reached its deadline, which stopped part of the profile's work, its research (some of its
 * parts) or some of its votes, in flight or not yet sent; one entry per limit and profile counts them.
 * For a large change researched in parts, `research-failed` and `request-too-large` count the parts that
 * failed or were refused, and each of the other reasons its parts' share.
 */
export type IncompleteReason = 'research-unusable' | 'research-failed' | 'findings-capped' | 'finding-unreadable' | 'vote-failed' | 'request-too-large' | 'too-large' | 'token-cap' | 'review-deadline' | 'binary' | 'submodule'

/**
 * Work the run could not review: a research reply with findings but none usable, an advisory
 * profile's research that failed (`research-failed`), findings beyond the cap, a finding the
 * harness could not read, a kept finding whose failed votes could have raised it to a higher
 * level, a request its provider refused as too large to send, work the review's token cap or deadline
 * stopped, or a file whose change the diff does not carry, binary or a submodule's commit. It is reported and
 * counted, never dropped silently (ADR-0012).
 */
export interface IncompleteEntry {
  /** The id of the profile whose run has the gap. */
  profile: string
  reason: IncompleteReason
  /** The file of the finding the gap is about, when it is about one finding the harness could read: held by `vote-failed` and by a vote's `request-too-large`. */
  file?: string
  detail: string
}

/** Why a file is in `meta.leftOut`: an `exclude` pattern matches it, or its change reaches the models only as binary, or as a submodule's commit. */
export type LeftOutReason = 'excluded' | 'binary' | 'submodule'

/** A file the review left out: one an `exclude` pattern matches, which is no gap, or one whose change the diff does not carry, which is a gap of every profile. */
export interface LeftOutFile {
  /** The diff's own path, decoded; '' for a part of the diff that no `diff --git` header names. */
  file: string
  reason: LeftOutReason
}

/**
 * Why part of a file was not reviewed, as `CoverageEntry` records it: a `LeftOutReason`'s `binary` or
 * `submodule`, `too-large` for a hunk, or a section with no hunk, that fits in no research part
 * of its model's window, or the `IncompleteReason` of the research part that held it and did not
 * read it: `request-too-large`, `token-cap`, `review-deadline` or `research-failed`.
 */
export type CoverageReason = 'binary' | 'submodule' | 'too-large' | 'request-too-large' | 'token-cap' | 'review-deadline' | 'research-failed'

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

/** What an advisory flag points at. */
export type FlagCode = 'hidden-characters' | 'ai-addressed-text'

/**
 * An advisory signal the harness read from the diff by code, before any model saw it: it tells a
 * human where to look, and never changes a verdict, a confidence or an exit code.
 */
export interface Flag {
  code: FlagCode
  /** The diff's own path for the file; absent for a diff without per-file headers. */
  file?: string
  /** The first added line, in the new file, the flag is about; absent when it is about the file name. */
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
  /** Whether its kept high findings set exit code 1. */
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
  /** The files the review left out, the input's own first, then the diff's, once per file and reason. Each, but an excluded one, is also a gap of every profile. */
  leftOut: LeftOutFile[]
  /** Advisory signals the harness read from the diff: where a human should look. They change no verdict and no exit code. */
  flags: Flag[]
}

/** Final review output. */
export interface QuorumResult {
  kept: Verdict[]
  discarded: Verdict[]
  /** Findings a failed vote left undecided: neither kept nor cleared. */
  unreviewed: Verdict[]
  meta: QuorumMeta
}

/** What a quorum runs, and the limits every one of its reviews keeps to. */
export interface QuorumOptions {
  /** At least one, ids unique: each runs research, dedup and panel on its own, concurrently with the others. */
  readonly profiles: readonly Profile[]
  /** Maximum simultaneous provider calls per review, shared by every profile; `DEFAULT_CONCURRENCY` when unset. */
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

/** What one review takes: the diff, and optionally where it came from and the files its source left out before it made the diff. */
export interface ReviewInput {
  readonly diff: string
  /** Where the diff came from, checked and recorded in `meta.source` as given; `{ kind: 'diff' }` when unset. */
  readonly source?: ReviewSource
  /**
   * The files the source left out before it made the diff, listed in `meta.leftOut` and in the `left-out`
   * event ahead of the diff's own. A `binary` or `submodule` one is a gap of every profile, as the diff's are.
   */
  readonly leftOut?: readonly LeftOutFile[]
}

/** A quorum built by createQuorum: its profiles compiled once, ready to review any number of diffs. */
export interface Quorum {
  /**
   * Review one diff with every profile of the quorum, recording its `source` in `meta.source` and
   * listing the files its source left out (`leftOut`) before the diff's own. Once `signal` aborts, the
   * review stops and rejects with the signal's reason; an aborted review never resolves. The review is
   * over once it has sent `run:end`: an abort from that event's handler, or later, has no effect, and the
   * review resolves with its result.
   */
  readonly review: (input: ReviewInput, options?: { readonly signal?: AbortSignal }) => Promise<QuorumResult>
  /** Settings that cannot take full effect, such as a policy level that never applies; each starts at its profile id. */
  readonly warnings: readonly string[]
}

/** The stages every profile runs through, in this order. */
export type StageName = 'research' | 'dedup' | 'panel'

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
    /** An advisory flag read from the diff, sent before any stage starts. */
    | { type: 'flag', flag: Flag }
    /** A stage of one profile starts. */
    | { type: 'stage:start', profile: string, stage: StageName }
    /** A stage of one profile ends; `count` is the findings it produced, or the verdicts for `panel`. */
    | { type: 'stage:end', profile: string, stage: StageName, durationMs: number, count: number }
    /**
     * One per provider call, failed ones included, sent when the call ends. The call runs its
     * attempts inside its slot, retried as the retry policy decides, so `durationMs` runs from its
     * first attempt to its end, the waits between attempts included; `attempts` is their number,
     * only when the call made more than one; `usage` is summed over the attempts that reported
     * valid counts; `spent` is the tokens the review's cap counted for the call: each attempt's
     * reported usage, nothing for one the server refused before any work, else its reservation.
     */
    | { type: 'call', profile: string, role: 'research' | 'vote', lens?: string, provider: ProviderRef, durationMs: number, ok: boolean, attempts?: number, usage?: Usage, spent: number }
    /** A finding was dropped for citing code outside the diff, with the reason. */
    | { type: 'finding:invalid', profile: string, reason: string }
    /** A gap was recorded, as `meta.incomplete` will hold it. */
    | { type: 'incomplete', entry: IncompleteEntry }
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
