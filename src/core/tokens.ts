import type { CompletionRequest } from './ports.ts'

/**
 * Tokens kept for what a server adds around the messages: the chat template's role markers, a thinking
 * or Harmony preamble, a tokenizer's dummy prefix. Measured at 10 to 29 tokens for Llama 3 and Qwen 2.5;
 * the margin is many times that, since a preamble can be longer than any measured.
 */
export const TEMPLATE_TOKENS = 512

/**
 * Tokens kept for the reply when `maxTokens` is not set, and the limit every adapter sends as the server's
 * then, so the budget the guard keeps is the one the server enforces.
 */
export const DEFAULT_REPLY_TOKENS = 16_000

const encoder = new TextEncoder()

/** The length of `text` in UTF-8 bytes. A lone surrogate counts the 3 bytes of U+FFFD, as the encoder writes it. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length
}

/**
 * The bytes of the longest form of each code point, 0 until it is first seen, so a repeated character is
 * normalized once. A fixed table of 1.1 MB, where a map grew past 200 MB on a text holding every code
 * point; the longest form, U+FDFA's, is 33 bytes, so a byte holds any of them.
 */
const longestFormBytes = new Uint8Array(0x110000)

/**
 * The most UTF-8 bytes a code point takes as sent, decomposed (NFD) or compatibility-decomposed (NFKD): U+0F81
 * is 3 bytes and 6 decomposed, U+00E9 is 2 and 3, a Hangul syllable up to 3 times its size, U+FDFA is 3 and 33.
 * A lone surrogate is 3, the bytes of the U+FFFD the encoder writes for it.
 */
function longestFormLength(codePoint: number): number {
  if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return 3
  const cached = longestFormBytes[codePoint]
  if (cached !== undefined && cached !== 0) return cached
  const char = String.fromCodePoint(codePoint)
  const bytes = Math.max(utf8Length(char), utf8Length(char.normalize('NFD')), utf8Length(char.normalize('NFKD')))
  longestFormBytes[codePoint] = bytes
  return bytes
}

/**
 * A bound of the tokens in `text`, one per UTF-8 byte in any normalization: the sum over its code points of
 * each one's longest form. The text itself is never normalized, since that takes quadratic time on a long run of
 * combining marks (canonical reordering) and a gigabyte on a run of U+FDFA. It is a bound because
 * decomposition works on one code point at a time, reordering only permutes code points, and composing
 * never lengthens UTF-8 (true of every code point, which `size.spec.ts` checks), so no NFC, NFKC, NFD or
 * NFKD form of the whole text is longer. Normalizing each character as NFC, or the text in chunks, is not
 * a bound: a mark that composes first, or one that crosses a chunk, can lengthen the whole.
 */
export function tokenBound(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) {
      bytes += 1
      continue
    }
    const low = index + 1 < text.length
      ? text.charCodeAt(index + 1)
      : 0
    const pair = unit >= 0xD800 && unit <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF
    bytes += longestFormLength(pair
      ? 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
      : unit)
    if (pair) index++
  }
  return bytes
}

/**
 * A bound of the tokens in the text of a request: `tokenBound` of the system text, of every message and of
 * the reply schema's JSON, the schema counted once more than the body carries it, since a server may add it
 * to the prompt. The size guard counts what an adapter sends with the same bound, so the core's count and an
 * adapter's never drift.
 */
export function requestTokens(request: Pick<CompletionRequest, 'system' | 'messages' | 'output'>): number {
  const texts = [
    request.system,
    ...request.messages.map(message => message.content),
    JSON.stringify(request.output.schema),
  ]
  return texts.reduce((sum, text) => sum + tokenBound(text), 0)
}
