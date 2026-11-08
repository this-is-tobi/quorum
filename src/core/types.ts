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

/** One lens's vote, or the error if that call failed. */
export interface LensVote {
  /** The id of the lens the vote was cast from. */
  angle: string
  vote: Vote | null
  error: string | null
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

/** Why part of a review is missing, as an `IncompleteEntry` records it. */
export type IncompleteReason = 'research-unusable' | 'findings-capped' | 'finding-unreadable' | 'vote-failed'

/**
 * Work the run could not review: a research reply with findings but none usable, findings beyond
 * the cap, a finding the harness could not read, or a kept finding whose failed votes could have
 * raised it to a higher level. It is reported and counted, never dropped silently (ADR-0012).
 */
export interface IncompleteEntry {
  /** The id of the profile whose run has the gap. */
  profile: string
  reason: IncompleteReason
  /** The file of the finding the gap is about, when it is about one finding the harness could read. */
  file?: string
  detail: string
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
}

/** What a review records about itself, besides its verdicts. */
export interface QuorumMeta {
  /** The version of quorum that ran the review, read from package.json. */
  version: string
  /** When the review started, as an ISO 8601 timestamp. */
  startedAt: string
  /** How long the review took, in whole milliseconds. */
  durationMs: number
  /** One entry per profile, keyed by profile id, in the run's profile order. */
  profiles: Record<string, ProfileMeta>
  /** The usage summed over the calls that reported valid counts; absent when none did. */
  usage?: Usage
  /** Gaps that are not findings. An entry here, or an unreviewed finding, makes the review incomplete. */
  incomplete: IncompleteEntry[]
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
}

/** A quorum built by createQuorum: its profiles compiled once, ready to review any number of diffs. */
export interface Quorum {
  /**
   * Review one diff with every profile of the quorum. Once `signal` aborts, the review stops and
   * rejects with the signal's reason; an aborted review never resolves. The review is over once it
   * has sent `run:end`: an abort from that event's handler, or later, has no effect, and the review
   * resolves with its result.
   */
  readonly review: (input: { readonly diff: string }, options?: { readonly signal?: AbortSignal }) => Promise<QuorumResult>
  /** Settings that cannot take full effect, such as a policy level that never applies; each starts at its profile id. */
  readonly warnings: readonly string[]
}

/** The stages every profile runs through, in this order. */
export type StageName = 'research' | 'dedup' | 'panel'

/** What a review reports while it runs, delivered synchronously to the event sink as it happens. */
export type QuorumEvent
  /** The review starts: the profiles it runs, and who reviews for each. */
  = | { type: 'run:start', profiles: string[], providers: Record<string, ProfileProviders> }
    /** A stage of one profile starts. */
    | { type: 'stage:start', profile: string, stage: StageName }
    /** A stage of one profile ends; `count` is the findings it produced, or the verdicts for `panel`. */
    | { type: 'stage:end', profile: string, stage: StageName, durationMs: number, count: number }
    /** One per provider call, failed ones included: its latency inside its slot and its usage, when valid. */
    | { type: 'call', profile: string, role: 'research' | 'vote', lens?: string, provider: ProviderRef, durationMs: number, ok: boolean, usage?: Usage }
    /** A finding was dropped for citing code outside the diff, with the reason. */
    | { type: 'finding:invalid', profile: string, reason: string }
    /** A gap was recorded, as `meta.incomplete` will hold it. */
    | { type: 'incomplete', entry: IncompleteEntry }
    /** One lens voted on one finding; `keep` is null, with the error, when the vote failed. */
    | { type: 'vote', profile: string, findingId: string, lens: string, keep: boolean | null, error?: string }
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
