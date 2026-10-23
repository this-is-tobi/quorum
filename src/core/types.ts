/**
 * Shared types for the Quorum security-review pipeline.
 *
 * @see ../../README.md for the module overview and usage.
 */

/**
 * Which side of the pipeline a model call belongs to: the finder that reads
 * a diff and proposes candidates, or a voter that independently judges one
 * candidate from a single fixed angle.
 */
export type Role = 'RESEARCH' | 'VOTER'

/**
 * Resolved connection settings for one role. VOTER falls back to the
 * RESEARCH_* env vars when its own are unset, so a single-backend setup only
 * needs to configure RESEARCH_*.
 */
export interface RoleConfig {
  /** Base URL of an OpenAI-compatible endpoint, e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl: string
  /** Bearer token. Use any placeholder for endpoints that don't require auth. */
  apiKey: string
  /** Model name/tag as the endpoint expects it, e.g. 'qwen3.6:27b' or 'gpt-5.4'. */
  model: string
}

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
  totalVotes: number
  confidence?: Confidence
  votes: LensVote[]
}

/** Final pipeline output. */
export interface QuorumResult {
  kept: Verdict[]
  discarded: Verdict[]
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
