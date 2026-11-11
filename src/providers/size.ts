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

/** The model's context window and the tokens a reply may take of it. */
export interface ContextBudget {
  readonly contextTokens: number
  readonly replyTokens: number
}

const encoder = new TextEncoder()

/**
 * The budget a request is checked against, or undefined when the provider states no context size, which
 * checks nothing. The reply budget is `maxTokens`, else `DEFAULT_REPLY_TOKENS`.
 */
export function contextBudget(contextTokens: number | undefined, maxTokens: number | undefined): ContextBudget | undefined {
  return contextTokens === undefined ? undefined : { contextTokens, replyTokens: maxTokens ?? DEFAULT_REPLY_TOKENS }
}

/** The length of `text` in UTF-8 bytes. A lone surrogate counts the 3 bytes of U+FFFD, as the encoder writes it. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length
}

/**
 * An upper bound of the tokens in the text of a request: one per UTF-8 byte of the system text, of every
 * message, and of the reply schema's JSON. A byte-level BPE or a byte-fallback SentencePiece tokenizer
 * never makes more than one token of a byte, so the count holds for any text, however it is padded. The
 * schema counts once more than the body carries it, since a server may add it to the prompt.
 */
export function textTokens(shaped: ShapedMessages, output: CompletionRequest['output']): number {
  const texts = [shaped.system ?? '', ...shaped.messages.map(message => message.content), JSON.stringify(output.schema)]
  return texts.reduce((sum, text) => sum + utf8Length(text), 0)
}

/**
 * Refuse, before it is sent, a request that may not fit the model's context: some endpoints cut an oversized
 * prompt in silence and answer 200, which would leave a review of text the model never read. The request
 * fits only when its text, `TEMPLATE_TOKENS` and the reply budget together stay within `contextTokens`.
 * Nothing is checked without a budget. The message holds the provider id and numbers, never the text.
 *
 * @throws ProviderError of kind `too-large`, which is not retryable
 */
export function checkFits(providerId: string, shaped: ShapedMessages, output: CompletionRequest['output'], budget: ContextBudget | undefined): void {
  if (budget === undefined) return
  const text = textTokens(shaped, output)
  const need = text + TEMPLATE_TOKENS + budget.replyTokens
  if (need <= budget.contextTokens) return
  throw new ProviderError({
    providerId,
    kind: 'too-large',
    message: `may need ${need} tokens, more than contextTokens (${budget.contextTokens}): ${text} for its text at one token per byte, ${TEMPLATE_TOKENS} for the chat template and ${budget.replyTokens} for the reply`,
  })
}
