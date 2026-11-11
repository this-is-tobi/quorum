import { ProviderError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import type { ShapedMessages } from './messages.ts'

/**
 * Tokens kept for what a server adds around the messages: the chat template's role markers, a thinking
 * or Harmony preamble, a tokenizer's dummy prefix. Measured at 10 to 29 tokens for Llama 3 and Qwen 2.5;
 * the margin is many times that, since a preamble can be longer than any measured.
 */
export const TEMPLATE_TOKENS = 512

/**
 * Tokens kept for the reply when `maxTokens` is not set: the limit `anthropic` sends then, and room for a
 * thinking model's longest reply. Every other adapter sends no limit, so there it is room the guard keeps.
 */
export const DEFAULT_REPLY_TOKENS = 16_000

/** The model's context window, the tokens a reply may take of it, and the tokens kept for what is added around the messages. */
export interface ContextBudget {
  readonly contextTokens: number
  readonly replyTokens: number
  /** The reserve for what the server or CLI adds around the messages; `TEMPLATE_TOKENS` when absent. */
  readonly templateTokens?: number
}

const encoder = new TextEncoder()

/**
 * The budget a request is checked against: the context size, the reply budget, `maxTokens` else
 * `DEFAULT_REPLY_TOKENS`, and the template reserve, which an adapter whose server adds more context than a
 * chat template raises.
 */
export function contextBudget(contextTokens: number, maxTokens: number | undefined, templateTokens = TEMPLATE_TOKENS): ContextBudget {
  return { contextTokens, replyTokens: maxTokens ?? DEFAULT_REPLY_TOKENS, templateTokens }
}

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
 * A bound of the UTF-8 bytes of `text` in any normalization: the sum over its code points of each one's
 * longest form. The text itself is never normalized, since that takes quadratic time on a long run of
 * combining marks (canonical reordering) and a gigabyte on a run of U+FDFA. It is a bound because
 * decomposition works on one code point at a time, reordering only permutes code points, and composing
 * never lengthens UTF-8 (true of every code point, which `size.spec.ts` checks), so no NFC, NFKC, NFD or
 * NFKD form of the whole text is longer. Normalizing each character as NFC, or the text in chunks, is not
 * a bound: a mark that composes first, or one that crosses a chunk, can lengthen the whole.
 */
function normalizedLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) {
      bytes += 1
      continue
    }
    const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
    const pair = unit >= 0xD800 && unit <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF
    bytes += longestFormLength(pair ? 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00) : unit)
    if (pair) index++
  }
  return bytes
}

/**
 * A bound of the tokens in the text of a request: one per UTF-8 byte of the system text, of every message,
 * and of the reply schema's JSON, each counted at the sum of its code points' longest forms. One token per
 * byte bounds a byte-level BPE or a byte-fallback SentencePiece tokenizer, since every byte is in its base
 * vocabulary and a merge only joins bytes. The longest forms cover one that normalizes first with NFC,
 * NFKC, NFD or NFKD: Qwen 2.5's NFC normalizer turns 300 bytes of U+0F81 into 500 tokens, which is why
 * the count is not the raw bytes. One that folds case is not covered; no chat model's tokenizer is known
 * to. The price is that accented letters count one more byte per accent and Hangul syllables up to three
 * times their size. The schema counts once more than the body carries it, since a server may add it to the
 * prompt.
 */
export function textTokens(shaped: ShapedMessages, output: CompletionRequest['output']): number {
  const texts = [shaped.system ?? '', ...shaped.messages.map(message => message.content), JSON.stringify(output.schema)]
  return texts.reduce((sum, text) => sum + normalizedLength(text), 0)
}

/**
 * Refuse, before it is sent, a request that may not fit the model's context: some endpoints cut an oversized
 * prompt in silence and answer 200, which would leave a review of text the model never read. The request
 * fits only when its text, the budget's template reserve (`TEMPLATE_TOKENS` unless it names one) and the
 * reply budget together stay within `contextTokens`.
 * The message holds the provider id and numbers, never the text.
 *
 * @throws ProviderError of kind `too-large`, which is not retryable
 */
export function checkFits(providerId: string, shaped: ShapedMessages, output: CompletionRequest['output'], budget: ContextBudget): void {
  const text = textTokens(shaped, output)
  const template = budget.templateTokens ?? TEMPLATE_TOKENS
  const need = text + template + budget.replyTokens
  if (need <= budget.contextTokens) return
  throw new ProviderError({
    providerId,
    kind: 'too-large',
    message: `may need ${need} tokens, more than contextTokens (${budget.contextTokens}): ${text} for its text at one token per byte, ${template} for the chat template and ${budget.replyTokens} for the reply`,
  })
}
