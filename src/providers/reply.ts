import { lackWords, ProviderError } from '../core/errors.ts'
import type { NoAnswer, ProviderErrorKind, ReplyLack } from '../core/errors.ts'
import type { Usage } from '../core/types.ts'
import { snippet } from './http.ts'
import { isRecord } from './options.ts'

/** The most characters of model text, or of server text in a 2xx reply, that an error message quotes. */
export const MAX_MODEL_TEXT = 200
/** The most characters of a stop reason that an error message quotes. */
const MAX_REASON = 40
/**
 * What an assembled stream holds where a reader checks a reasoning field's text: a stream's reasoning is counted as it
 * arrives and never kept, since only the fact that it showed is read, so the assembly writes this one word in its place.
 */
export const STREAMED_REASONING = 'streamed'

/**
 * The failures of one provider: a `ProviderError` of `kind`, with its message and, for `http`, its status.
 * Each carries `usage`, the counts of a reply the adapter read before it failed, so the review counts the
 * tokens of a reply it refuses.
 */
export function replyFailure(providerId: string, usage?: Usage): (kind: ProviderErrorKind, message: string, status?: number) => ProviderError {
  return (kind, message, status) => new ProviderError({
    providerId,
    kind,
    message,
    status,
    usage,
  })
}

/** The count `source` holds under the first key, plus each other key's when it is a number; undefined unless the first is one. */
function countOf(source: Record<string, unknown>, [first = '', ...others]: readonly string[]): number | undefined {
  const base = source[first]
  if (typeof base !== 'number') return undefined
  return others.reduce((sum, key) => {
    const count = source[key]
    return typeof count === 'number'
      ? sum + count
      : sum
  }, base)
}

/**
 * The token counts of `source`, or undefined unless both are known. Each list names the key of its
 * count, which must hold a number, then the keys of the parts the protocol counts apart, added when
 * they hold one: so the input is every prompt token, cached ones included, and the output every token
 * generated, thinking included.
 */
export function tokenUsage(source: unknown, inputKeys: readonly string[], outputKeys: readonly string[]): Usage | undefined {
  if (!isRecord(source)) return undefined
  const inputTokens = countOf(source, inputKeys)
  const outputTokens = countOf(source, outputKeys)
  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens }
}

/** The message of a reply that stopped for a reason the adapter does not accept, quoting the reason when it is a string. */
export function endedEarly(reason: unknown, redact: readonly string[]): string {
  return typeof reason === 'string'
    ? `reply ended early: ${snippet(reason, MAX_REASON, redact)}`
    : 'reply ended early'
}

/** The string `text` of the parts `keep` accepts, joined, or undefined when `parts` is not an array or holds no such part. */
export function joinedText(parts: unknown, keep: (part: Record<string, unknown>) => boolean): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const texts = parts.flatMap(part => isRecord(part) && typeof part.text === 'string' && keep(part)
    ? [part.text]
    : [])
  return texts.length === 0
    ? undefined
    : texts.join('')
}

/**
 * A `ProviderError` of a reply that lacked its answer: `truncated` or `no-answer`, worded by `lackWords` from
 * the facts alone, carrying `noAnswer` and the counts the reply reported. Nothing the reply held is quoted.
 */
export function lackFailure(providerId: string, kind: 'truncated' | 'no-answer', lack: ReplyLack, usage?: Usage): ProviderError {
  return new ProviderError({
    providerId,
    kind,
    message: lackWords(kind, lack),
    noAnswer: lack.noAnswer,
    usage,
  })
}

/** What an adapter read of a reply whose own earlier checks passed: the facts `readAnswer` tells what it lacked from. */
export interface ReplyReading {
  /** The reply's visible answer, when the reply has a text field at all: reasoning is never passed as the answer. */
  readonly text: string | undefined
  /** Whether the protocol says the reply was cut off by the limit: its finish or stop reason. */
  readonly flaggedCutOff: boolean
  /** Whether the protocol says the server's window ended the reply. */
  readonly windowEnded: boolean
  /** Whether the reply showed reasoning: a reasoning field or part with text, or a reasoning token count above 0. */
  readonly reasoned: boolean
  /** The reply limit the request was sent with, in tokens. */
  readonly limit: number
  /** The model's context window, `contextTokens`: the number a window end's message names. */
  readonly window?: number
  /** Whether a cut-off whose output stays under the limit while its input and output reach `window` is a window end: `openai-compatible` and `ollama`, whose servers clamp the limit to what the window leaves. */
  readonly windowByCount?: boolean
  readonly usage?: Usage
}

/**
 * The answer of a reply, or the `ProviderError` of what it lacked, by one rule for every HTTP adapter. A reply
 * is cut off when its protocol says so or its reported output tokens reach the limit sent, whatever its flag.
 * A cut-off is `window` when the protocol says the window ended it, or when its output stays under the limit
 * while its input and output reach `window` (only for an adapter that sets `windowByCount`); else, with no visible answer and reasoning shown, `thinking`; else
 * `reply`. A reply not cut off with no visible answer is `no-answer`: `thinking` when it showed reasoning,
 * else `empty`. A visible answer is text that is not blank once trimmed. Reasoning text is never read as the
 * answer, and no text of the reply is quoted.
 *
 * @throws ProviderError of kind `truncated` (`reply`, `thinking` or `window`) or `no-answer` (`thinking` or `empty`)
 */
export function readAnswer(providerId: string, reading: ReplyReading): { readonly text: string, readonly reasoning: boolean } {
  const { text, flaggedCutOff, windowEnded, reasoned, limit, window, windowByCount, usage } = reading
  const answer = text !== undefined && text.trim() !== ''
    ? text
    : undefined
  const output = usage?.outputTokens
  const atLimit = output !== undefined && output >= limit
  const cutOff = flaggedCutOff || atLimit
  const fail = (kind: 'truncated' | 'no-answer', noAnswer: NoAnswer): ProviderError => lackFailure(providerId, kind, {
    noAnswer,
    limit,
    outputTokens: usage?.outputTokens,
    inputTokens: usage?.inputTokens,
    window,
  }, usage)
  const reachedWindow = windowByCount === true && cutOff && !atLimit && usage !== undefined && window !== undefined && usage.inputTokens + usage.outputTokens >= window
  if (windowEnded || reachedWindow) throw fail('truncated', 'window')
  if (cutOff) {
    throw fail('truncated', answer === undefined && reasoned
      ? 'thinking'
      : 'reply')
  }
  if (answer === undefined) {
    throw fail('no-answer', reasoned
      ? 'thinking'
      : 'empty')
  }
  return { text: answer, reasoning: reasoned }
}
