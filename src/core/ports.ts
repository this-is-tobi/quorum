import type { QuorumEvent, Usage } from './types.ts'

/** A JSON Schema document, as produced by z.toJSONSchema. */
export type JsonSchema = Record<string, unknown>

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** One model call: instructions in `system`, attacker-influenced data only in `messages` (ADR-0007). */
export interface CompletionRequest {
  system: string
  messages: readonly ChatMessage[]
  /** The reply shape the caller validates against; adapters may also use it for native enforcement. */
  output: { name: string, schema: JsonSchema }
  signal?: AbortSignal
}

/** What a provider returns: the reply text, the model that produced it and, when reported, its usage. */
export interface CompletionResponse {
  text: string
  model: string
  usage?: Usage
}

/**
 * A model behind a port: it receives text and returns text (invariant I1). No environment value, key
 * or credential appears in a request; keys live in adapters only. The core never trusts the reply
 * and extracts and validates it itself.
 */
export interface Provider {
  readonly id: string
  readonly model: string
  /**
   * Answer one request. It should honour `request.signal`, settling soon after the signal aborts:
   * stopping a call in flight is cooperative, so a review can wait for a call it cut until the
   * provider settles.
   */
  complete: (request: CompletionRequest) => Promise<CompletionResponse>
}

/** Receives every event of a review, synchronously and in order. */
export type EventSink = (event: QuorumEvent) => void

/** The providers of one profile: its research provider, and one voter per lens keyed by lens id. */
export interface ProfilePorts {
  readonly research: Provider
  readonly voters: Readonly<Record<string, Provider>>
}

/** What a quorum is wired to: the providers of every profile, keyed by profile id, and an optional event sink. */
export interface QuorumPorts {
  readonly profiles: Readonly<Record<string, ProfilePorts>>
  readonly events?: EventSink
}
