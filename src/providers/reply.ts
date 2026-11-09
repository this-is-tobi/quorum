import { ProviderError } from '../core/errors.ts'
import type { ProviderErrorKind } from '../core/errors.ts'
import type { Usage } from '../core/types.ts'
import { snippet } from './http.ts'
import { isRecord } from './options.ts'

/** The most characters of model text, or of server text in a 2xx reply, that an error message quotes. */
export const MAX_MODEL_TEXT = 200
/** The most characters of a stop reason that an error message quotes. */
const MAX_REASON = 40

/** The failures of one provider: a `ProviderError` of `kind`, with its message and, for `http`, its status. */
export function replyFailure(providerId: string): (kind: ProviderErrorKind, message: string, status?: number) => ProviderError {
  return (kind, message, status) => new ProviderError({ providerId, kind, message, status })
}

/** The count `source` holds under the first key, plus each other key's when it is a number; undefined unless the first is one. */
function countOf(source: Record<string, unknown>, [first = '', ...others]: readonly string[]): number | undefined {
  const base = source[first]
  if (typeof base !== 'number') return undefined
  return others.reduce((sum, key) => {
    const count = source[key]
    return typeof count === 'number' ? sum + count : sum
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
  return inputTokens === undefined || outputTokens === undefined ? undefined : { inputTokens, outputTokens }
}

/** The message of a reply that stopped for a reason the adapter does not accept, quoting the reason when it is a string. */
export function endedEarly(reason: unknown, redact: readonly string[]): string {
  return typeof reason === 'string' ? `reply ended early: ${snippet(reason, MAX_REASON, redact)}` : 'reply ended early'
}

/** The string `text` of the parts `keep` accepts, joined, or undefined when `parts` is not an array or holds no such part. */
export function joinedText(parts: unknown, keep: (part: Record<string, unknown>) => boolean): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const texts = parts.flatMap(part => isRecord(part) && typeof part.text === 'string' && keep(part) ? [part.text] : [])
  return texts.length === 0 ? undefined : texts.join('')
}
