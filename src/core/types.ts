/**
 * Shared types for the Quorum security-review pipeline.
 *
 * @see ../../README.md for the module overview and usage.
 */

/**
 * A candidate issue after the harness checked it against the diff. The finder supplies the file,
 * line, category and claim; the evidence is read from the diff by code, never from the finder.
 */
export interface Finding {
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

/** One of the three fixed, orthogonal angles a voter is assigned. */
export interface Lens {
  angle: 'reachability' | 'impact' | 'defenses'
  question: string
}

/** One lens's vote, or the error if that call failed. */
export interface LensVote {
  angle: Lens['angle']
  vote: Vote | null
  error: string | null
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
 * Work the run could not review: a research reply with findings but none usable, findings beyond
 * the cap, a finding the harness could not read, or a kept finding whose failed votes could have
 * raised it to a higher level. It is reported and counted, never dropped silently (ADR-0012).
 */
export interface IncompleteEntry {
  reason: 'research-unusable' | 'findings-capped' | 'finding-unreadable' | 'vote-failed'
  detail: string
}

/** Final pipeline output. */
export interface QuorumResult {
  kept: Verdict[]
  discarded: Verdict[]
  /** Findings a failed vote left undecided: neither kept nor cleared. */
  unreviewed: Verdict[]
  meta: {
    /** Gaps that are not findings. An entry here, or an unreviewed finding, makes the review incomplete. */
    incomplete: IncompleteEntry[]
  }
}

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
