import type { Usage } from './types.ts'

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
  complete: (request: CompletionRequest) => Promise<CompletionResponse>
}
