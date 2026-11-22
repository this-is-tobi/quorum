import type { CompletionRequest } from './ports.ts'

/**
 * Tokens kept for what a server adds around the messages: the chat template's role markers, a thinking
 * or Harmony preamble, a tokenizer's dummy prefix. Measured at 10 to 29 tokens for Llama 3 and Qwen 2.5;
 * the margin is many times that, since a preamble can be longer than any measured.
 */
export const TEMPLATE_TOKENS = 512

/**
 * Tokens kept for the reply when neither the request nor `maxTokens` names a budget, and the limit every adapter
 * sends as the server's then, so the budget the guard keeps is the one the server enforces.
 */
export const DEFAULT_REPLY_TOKENS = 16_000

/**
 * The most tokens a reply of `request` may take, as an adapter sends it as the server's limit: the request's
 * `replyTokens` when it is a whole number of at least 1, at most `maxTokens` when that is set (the owner's
 * ceiling); else `maxTokens`; else undefined, which an adapter reads as `DEFAULT_REPLY_TOKENS`.
 */
export function replyLimit(request: Pick<CompletionRequest, 'replyTokens'>, maxTokens: number | undefined): number | undefined {
  const { replyTokens } = request
  if (typeof replyTokens === 'number' && Number.isSafeInteger(replyTokens) && replyTokens >= 1) {
    return Math.min(replyTokens, maxTokens ?? replyTokens)
  }
  return maxTokens
}

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

/** The tokens a verdict and its reasoning take, before the thinking allowance. */
export const VOTE_TOKENS = 1024

/**
 * The output tokens a research reply usually takes, which the estimate counts a reply at when its budget is larger
 * (an assumption, the design's placeholder: no recorded run holds the output tokens of each research call, so the
 * figure is not yet measured). A larger `maxTokens` is headroom, not an expectation.
 */
export const EXPECTED_REPLY_TOKENS = 4096

/**
 * How many times the bound of a research request over-counts the tokens of code. The bound is one token per
 * UTF-8 byte, and code diffs run 2.9 to 3.8 bytes per token across the tokenizers measured, so a third of the
 * bound is what code most likely takes, and a diff of prose or of encoded data takes more. It only scales the
 * expected spend of an estimate: the ledger reserves the whole bound at run time.
 */
export const BOUND_OVER_CODE = 3

/**
 * A research part's expected spend: its input at a third of its bound, rounded up, which code takes about that
 * many tokens of, and its reply at the lesser of its budget and `EXPECTED_REPLY_TOKENS`. `reservation` holds the
 * reply budget once, so the input is what it holds besides; a reservation a provider states below its reply
 * budget counts the reply at the reservation, and the part never expects more than it reserves.
 */
export function expectedOf(reservation: number, reply: number): number {
  const held = Math.min(reply, reservation)
  return Math.ceil((reservation - held) / BOUND_OVER_CODE) + Math.min(held, EXPECTED_REPLY_TOKENS)
}
