/**
 * Replies of the Anthropic Messages API, in the shapes its reference gives
 * (https://platform.claude.com/docs/en/api/messages/create). Each names its source; the text is replaced
 * by a reply quorum can read.
 */

/** A message, as the reference shows one. Adaptive thinking is on by default, so a thinking block comes first. */
export const message = {
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    { type: 'thinking', thinking: 'The id reaches the query as a bound parameter.', signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds' },
    { type: 'text', text: '{}' },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 2095,
    output_tokens: 503,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
}

/** A refusal: `stop_reason: 'refusal'` (https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons). */
export const refusal = { ...message, content: [], stop_reason: 'refusal' }

/**
 * A reply cut off by the token limit while it was thinking: `stop_reason: 'max_tokens'` and no text block
 * (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting).
 */
export const truncated = {
  ...message,
  content: [
    { type: 'thinking', thinking: 'The id reaches the query', signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrk' },
  ],
  stop_reason: 'max_tokens',
}

/** A reply cut off when the conversation filled the model's context window: `stop_reason: 'model_context_window_exceeded'`. */
export const contextWindowFull = {
  ...message,
  content: [
    { type: 'text', text: '{"kee' },
  ],
  stop_reason: 'model_context_window_exceeded',
}

/** A reply that stops to call a tool: a `tool_use` block and `stop_reason: 'tool_use'`. */
export const toolUse = {
  ...message,
  content: [
    {
      type: 'tool_use',
      id: 'toolu_01A09q90qw90lq917835lq9',
      name: 'get_weather',
      input: { location: 'San Francisco, CA' },
    },
  ],
  stop_reason: 'tool_use',
}

/** The error body of a non-2xx reply (https://platform.claude.com/docs/en/api/errors). */
export const notFound = {
  type: 'error',
  error: { type: 'not_found_error', message: 'model: claude-opus-9' },
  request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
}
