/**
 * Replies of Ollama's native chat API, `/api/chat` with `stream: false`, in the shapes its documentation
 * gives (https://docs.ollama.com/api/chat) and its source writes (`ChatResponse` in
 * https://github.com/ollama/ollama/blob/main/api/types.go). Each names its source; the text is replaced by
 * a reply quorum can read.
 */

/** A finished reply of a thinking model: its thinking in `message.thinking`, its answer in `message.content`. */
export const chatResponse = {
  model: 'qwen3.6:27b',
  created_at: '2026-11-09T12:00:00.000000Z',
  message: { role: 'assistant', content: '{}', thinking: 'The id reaches the query as a bound parameter.' },
  done: true,
  done_reason: 'stop',
  total_duration: 5191566416,
  load_duration: 2154458,
  prompt_eval_count: 1840,
  prompt_eval_duration: 383809000,
  eval_count: 412,
  eval_duration: 4799921000,
}

/** A reply cut off by the token limit, or by a context that filled: `done_reason: 'length'`. */
export const truncated = { ...chatResponse, message: { role: 'assistant', content: '{"kee' }, done_reason: 'length' }

/** The answer to `_debug_render_only`: the rendered template in `debug_info`, and no `done` (server/routes.go, `ChatHandler`). */
export const debugRender = {
  model: 'qwen3.6:27b',
  created_at: '2026-11-09T12:00:00.000000Z',
  message: { role: 'assistant', content: '' },
  debug_info: { rendered_template: '<|im_start|>system\ninstructions<|im_end|>\n<|im_start|>user\ndata<|im_end|>\n' },
}

/** The 400 body of a prompt past the context, under `truncate: false` (llama.cpp's server, as Ollama passes it on). */
export const contextExceeded = { error: 'request (8253 tokens) exceeds the available context size (4096 tokens), try increasing it' }
