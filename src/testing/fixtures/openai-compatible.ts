/**
 * Replies of OpenAI-compatible servers, in the shapes their documentation gives. Each names its source;
 * the text is replaced by a reply quorum can read.
 */

/** A chat completion, as the OpenAI API reference shows one (`CreateChatCompletionResponse`). */
export const chatCompletion = {
  id: 'chatcmpl-B9MBs8CjcvOU2jLn4n570S5qMJKcT',
  object: 'chat.completion',
  created: 1741569952,
  model: 'gpt-6-astra-2026-09-30',
  choices: [{ index: 0, message: { role: 'assistant', content: '{}', refusal: null, annotations: [] }, logprobs: null, finish_reason: 'stop' }],
  usage: { prompt_tokens: 19, completion_tokens: 10, total_tokens: 29 },
  service_tier: 'default',
}

/** A refusal: `content` null and `message.refusal` set (`ChatCompletionResponseMessage`). */
export const refusal = {
  ...chatCompletion,
  choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'I cannot help with that request.' }, logprobs: null, finish_reason: 'stop' }],
}

/** A reply cut off by the token limit: `finish_reason: 'length'`. */
export const truncated = {
  ...chatCompletion,
  choices: [{ index: 0, message: { role: 'assistant', content: '{"kee', refusal: null }, logprobs: null, finish_reason: 'length' }],
}
