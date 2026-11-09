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

/** OpenRouter's answer, with status 200, to a failure during generation: a top-level `error` beside an empty choice. */
export const openRouterGenerationError = {
  id: 'gen-1762651234-abc',
  object: 'chat.completion',
  model: 'openai/gpt-6-astra',
  error: { code: 502, message: 'Provider returned error', metadata: { error_type: 'provider_unavailable' } },
  choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'error', native_finish_reason: 'error' }],
}

/** Mistral's assistant content as an array of chunks, a thinking chunk first (`AssistantMessage.content`). */
export const mistralChunks = {
  id: 'cmpl-e5cc70bb28c444948073e77776eb30ef',
  object: 'chat.completion',
  model: 'magistral-medium-2610',
  created: 1762651234,
  choices: [{
    index: 0,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'The diff calls exec.' }] }, { type: 'text', text: '{"keep":true,' }, { type: 'text', text: '"reasoning":"r"}' }] },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
}

/** The error body LM Studio sends when it refuses a request: a bare string. Ollama's native API sends the same shape. */
export const stringError = { error: '\'response_format.type\' must be \'json_schema\' or \'text\'' }
