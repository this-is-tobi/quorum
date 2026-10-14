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
