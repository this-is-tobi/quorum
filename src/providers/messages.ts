import type { ChatMessage, CompletionRequest } from '../core/ports.ts'

/**
 * Where the system text goes: `native` keeps it apart, for the protocol's own place (a `system` message,
 * Anthropic's top-level `system`, Gemini's `systemInstruction`); `inline` puts it at the head of the
 * first user message, for local chat templates that reject a system role.
 */
export type SystemPrompt = 'native' | 'inline'

/** The system text, when it stays apart, and the conversation an adapter sends. */
export interface ShapedMessages {
  system: string | undefined
  messages: ChatMessage[]
}

/** Shape a request's messages for `mode`. Inline, the system text and the first user message are joined by a blank line. */
export function shapeMessages(request: CompletionRequest, mode: SystemPrompt): ShapedMessages {
  const messages = request.messages.map(message => ({ role: message.role, content: message.content }))
  if (mode === 'native') return { system: request.system, messages }
  const [first, ...rest] = messages
  return first?.role === 'user'
    ? {
        system: undefined,
        messages: [
          { role: 'user', content: `${request.system}\n\n${first.content}` },
          ...rest,
        ],
      }
    : {
        system: undefined,
        messages: [
          { role: 'user', content: request.system },
          ...messages,
        ],
      }
}
