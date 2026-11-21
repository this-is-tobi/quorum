import { ProviderError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { DEFAULT_REPLY_TOKENS, replyLimit, TEMPLATE_TOKENS, tokenBound } from '../core/tokens.ts'
import type { ShapedMessages } from './messages.ts'

export { DEFAULT_REPLY_TOKENS, TEMPLATE_TOKENS, utf8Length } from '../core/tokens.ts'

/** The model's context window, the tokens a reply may take of it, and the tokens kept for what is added around the messages. */
export interface ContextBudget {
  readonly contextTokens: number
  readonly replyTokens: number
  /** The reserve for what the server or CLI adds around the messages; `TEMPLATE_TOKENS` when absent. */
  readonly templateTokens?: number
}

/**
 * The budget a request is checked against: the context size, the reply budget `replyTokens` (see
 * `replyBudgetOf`), and the template reserve, which an adapter whose server adds more context than a chat
 * template raises.
 */
export function contextBudget(contextTokens: number, replyTokens: number, templateTokens = TEMPLATE_TOKENS): ContextBudget {
  return { contextTokens, replyTokens, templateTokens }
}

/**
 * The tokens a reply of `request` may take, which the size guard keeps, the room and the worst case count, and
 * the adapter sends as the server's limit: the request's `replyTokens` when it is a whole number of at least 1,
 * at most `maxTokens` when the options set one, the owner's ceiling; else `maxTokens`; else
 * `DEFAULT_REPLY_TOKENS`.
 */
export function replyBudgetOf(request: Pick<CompletionRequest, 'replyTokens'>, maxTokens: number | undefined): number {
  return replyLimit(request, maxTokens) ?? DEFAULT_REPLY_TOKENS
}

/**
 * What an HTTP adapter states of itself to the core, which sizes a request's reply from it: its window, its
 * `maxTokens` when the options set one, and its thinking, which is the server's default.
 */
export function statedReply(contextTokens: number, maxTokens: number | undefined): { readonly window: number, readonly maxTokens?: number, readonly thinking: 'default' } {
  return {
    window: contextTokens,
    ...maxTokens === undefined
      ? {}
      : { maxTokens },
    thinking: 'default',
  }
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
 * prompt. The core counts a request's text with the same bound (`requestTokens`), so the worst case an adapter
 * states and the core's own count never drift.
 */
export function textTokens(shaped: ShapedMessages, output: CompletionRequest['output']): number {
  const texts = [
    shaped.system ?? '',
    ...shaped.messages.map(message => message.content),
    JSON.stringify(output.schema),
  ]
  return texts.reduce((sum, text) => sum + tokenBound(text), 0)
}

/**
 * The most tokens, input and output, that one attempt of a request may spend as the provider is billed for
 * it, from what the guard counts: each of `turns` model turns sends the text and the template reserve, and
 * the reply of every turn but the last is the input of the next, so the replies count `2 * turns - 1` times.
 * One turn is the text, the template reserve and the reply budget, which `checkFits` keeps within the context.
 */
export function worstCaseTokens(shaped: ShapedMessages, output: CompletionRequest['output'], budget: ContextBudget, turns = 1): number {
  const template = budget.templateTokens ?? TEMPLATE_TOKENS
  return turns * (textTokens(shaped, output) + template) + (2 * turns - 1) * budget.replyTokens
}

/** What a request needs of its context: the tokens of its text, the template reserve, the reply budget, and their sum. */
function neededOf(shaped: ShapedMessages, output: CompletionRequest['output'], budget: ContextBudget): { readonly text: number, readonly template: number, readonly need: number } {
  const text = textTokens(shaped, output)
  const template = budget.templateTokens ?? TEMPLATE_TOKENS
  return { text, template, need: text + template + budget.replyTokens }
}

/**
 * How many more tokens of text a request could hold and still fit the model's context, from what the guard
 * counts: the context less the text, the budget's template reserve (`TEMPLATE_TOKENS` unless it names one)
 * and the reply budget. It is negative exactly when the request does not fit, and `checkFits` reads the same
 * count, so the guard and the room an adapter states never drift: a request at a room of 0 is sent, one at -1
 * is refused.
 */
export function roomTokens(shaped: ShapedMessages, output: CompletionRequest['output'], budget: ContextBudget): number {
  return budget.contextTokens - neededOf(shaped, output, budget).need
}

/**
 * Refuse, before it is sent, a request that may not fit the model's context: some endpoints cut an oversized
 * prompt in silence and answer 200, which would leave a review of text the model never read. The request
 * fits only when its text, the budget's template reserve (`TEMPLATE_TOKENS` unless it names one) and the
 * reply budget together stay within `contextTokens`, which is when its room is not negative.
 * The message holds the provider id and numbers, never the text.
 *
 * @throws ProviderError of kind `too-large`, which is not retryable
 */
export function checkFits(providerId: string, shaped: ShapedMessages, output: CompletionRequest['output'], budget: ContextBudget): void {
  const { text, template, need } = neededOf(shaped, output, budget)
  if (need <= budget.contextTokens) return
  throw new ProviderError({
    providerId,
    kind: 'too-large',
    message: `may need ${need} tokens, more than contextTokens (${budget.contextTokens}): ${text} for its text at one token per byte, ${template} for the chat template and ${budget.replyTokens} for the reply`,
  })
}
