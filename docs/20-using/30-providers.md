# Providers

A provider is how quorum reaches a model: an object that takes one request and returns the text of the reply. The CLI builds two from the environment; a program builds its own, with the shipped `openaiCompatible` adapter or from scratch. This page covers the port, `openaiCompatible` and its options, the errors a provider raises, and writing a provider of your own.

## The port

```ts
interface Provider {
  readonly id: string
  readonly model: string
  complete: (request: CompletionRequest) => Promise<CompletionResponse>
}

interface CompletionRequest {
  system: string
  messages: readonly ChatMessage[]
  output: { name: string, schema: JsonSchema }
  signal?: AbortSignal
}

interface CompletionResponse {
  text: string
  model: string
  usage?: Usage
}
```

- **Text in, text out.** A request carries the instructions in `system`, the fenced data in `messages` (one `user` message), the shape of the reply in `output` (named `research_findings` or `panel_vote`, with its JSON Schema), and the review's `signal`. The request has no field for a tool, a function, a file or a network capability, so none is ever offered to a model.
- **No secret in a request.** No environment value, key or credential appears in a request: a key lives in the adapter that holds it.
- **The core never trusts the reply.** It extracts and validates the JSON in `text` itself, whatever the provider did to get it, and reads `usage` (`inputTokens`, `outputTokens`, optional `costUsd`) only when its counts are finite numbers of at least 0.
- **`id` and `model` name the provider** in events and in `meta`, as they were when the quorum was created.

[Prompts](./60-prompts.md) shows what `system` and `messages` hold.

## `openaiCompatible`

The shipped adapter, for any OpenAI-compatible `/chat/completions` endpoint: Ollama, vLLM, TGI, llama.cpp or a hosted API.

```ts
import { openaiCompatible } from './src/index.ts'

const local = openaiCompatible({ id: 'local', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.6:27b' })
const hosted = openaiCompatible({ id: 'hosted', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', apiKey: process.env.OPENAI_API_KEY })
```

### Options

| Option | Type | Default | Does |
| --- | --- | --- | --- |
| `id` | `string` | Required | Names the provider in events, `meta` and its error messages |
| `baseUrl` | `string` | Required | An `http://` or `https://` URL with a host. Requests go to it, its trailing slashes removed, followed by `/chat/completions` |
| `model` | `string` | Required | Sent as `model` in every request |
| `apiKey` | `string` | None | Sent as `Authorization: Bearer <apiKey>` and nowhere else. Without it, or with an empty one, no `Authorization` header is sent |
| `temperature` | `number \| null` | `0` | Sent as `temperature`; `null` leaves the field out, for a model that rejects it |
| `structuredOutput` | `'prompt' \| 'json' \| 'schema'` | `'json'` | How the reply's shape reaches the endpoint |

The body of every request holds `model`, `messages` (the system message first, as a `system` role, then the request's messages), `response_format` and `temperature`.

### Structured output

| Mode | `response_format` sent |
| --- | --- |
| `prompt` | None: the schema is only in the system message |
| `json` | `{ "type": "json_object" }` |
| `schema` | `{ "type": "json_schema", "json_schema": { "name": <output.name>, "schema": <output.schema>, "strict": true } }` |

Every mode keeps the schema in the system message, and the core validates the reply the same way in each. `schema` asks the endpoint to enforce the shape; use it where the endpoint supports it, `json` where it supports only JSON mode, and `prompt` where it supports neither.

### The reply

The text is the first choice's `message.content`. `model` is the one the reply names, or the configured one when it names none. `usage` is read from `usage.prompt_tokens` and `usage.completion_tokens` when both are numbers; the adapter reports no cost.

### Its configuration errors

`openaiCompatible` checks its options when it is called, before any request, and throws one `ConfigError` with each problem. Neither message repeats the value:

| Path | Message |
| --- | --- |
| `<id>.baseUrl` | `must be an http:// or https:// URL with a host` |
| `<id>.apiKey` | `must only contain visible ASCII characters, which an HTTP header can carry` |

## `ProviderError`

Every failure of an `openaiCompatible` call is a `ProviderError`, the error class the core exports for any provider to use. Its message starts with the provider id, and the adapter never puts a request header, a key or the runtime's own error text in it: text a server or a model sent is quoted as a JSON string and cut short, and a key the server echoes is replaced by `[redacted]` first.

| Field | Holds |
| --- | --- |
| `providerId` | The provider's id |
| `kind` | What went wrong, below |
| `status` | The HTTP status, for `http` |
| `retryable` | `true` for `network` and `timeout`, and for `http` with status 408, 409, 429 or 5xx: a caller may try the call again |

| Kind | Raised by `openaiCompatible` when |
| --- | --- |
| `http` | The endpoint answers with a status outside 2xx: `HTTP 503: "model is loading"`, quoting up to 500 characters of the body |
| `network` | The request fails, `request to http://localhost:11434 failed (ECONNREFUSED)`, or reading the reply does, `reading the reply from <origin> failed` |
| `aborted` | The review's signal stopped the request: `request aborted` |
| `refusal` | The model refused, `model refused: "<up to 200 characters>"`, or the content filter stopped the reply, `reply was stopped by the content filter` |
| `truncated` | The token limit cut the reply off: `reply was cut off by the token limit` |
| `invalid-response` | The body is not JSON (`response body is not JSON`), is not an object, has no choices (`reply has no choices`, with the server's error message when it sends one), or no message content |
| `timeout`, `process`, `unsupported` | Never: these are for other providers |

The core raises one more itself: a provider whose reply has no string `text` fails that call with `<id>: returned no reply text`, of kind `invalid-response`.

Quorum does not retry a call. A failed research call fails the review: the CLI exits `3`, and `review` rejects with the error. A failed vote is recorded in the vote's `error` and counts as a reject: [Failed votes](./50-lenses-and-policy.md#failed-votes).

## Writing a provider

Any object of the port's shape is a provider. It must:

- **return the model's raw text** in `text`, without parsing it: the core extracts and validates the JSON itself, and a reply it cannot use is a failed vote, or, for research, a failed review;
- **honour `request.signal`**, settling soon after it aborts: stopping a call in flight is cooperative, so a review that was aborted can wait for a provider that ignores its signal;
- **throw when the call fails**, a `ProviderError` with the closest `kind` for preference. A vote records the message of any `Error`, and the text of anything else thrown;
- **report `usage` only when it knows it**: `inputTokens` and `outputTokens`, and `costUsd` when it knows the price.

A provider can wrap another. Quorum sets no time limit on a call, so this one adds a limit to any provider, and reports a call that ran out of time as a `timeout`:

```ts
import { openaiCompatible, ProviderError } from './src/index.ts'
import type { Provider } from './src/index.ts'

/** The same provider, with every call stopped after `ms` milliseconds. */
function withTimeout(inner: Provider, ms: number): Provider {
  return {
    id: inner.id,
    model: inner.model,
    async complete(request) {
      const timeout = AbortSignal.timeout(ms)
      const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
      try {
        return await inner.complete({ ...request, signal })
      } catch (error) {
        if (!timeout.aborted || request.signal?.aborted) throw error
        throw new ProviderError({ providerId: inner.id, kind: 'timeout', message: `no reply within ${ms} ms` })
      }
    },
  }
}

const voter = withTimeout(openaiCompatible({ id: 'voter', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.6:27b' }), 120_000)
```

A vote that runs out of time is then a failed vote, `voter: no reply within 120000 ms`, and a review aborted by its own signal still rejects with that signal's reason.

## Next

[Profiles](./40-profiles.md) — what a review looks for, the security profile, writing one of your own, gating and guidelines.
