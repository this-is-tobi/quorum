# Providers

A provider is how quorum reaches a model: an object that takes one request and returns the text of the reply. The CLI builds two from the environment; a program builds its own, with the shipped `openaiCompatible` adapter or from scratch. This page covers the port, `openaiCompatible` and the options every HTTP adapter shares, the key header styles, the limits of a request, the reply shapes it reads, the errors a provider raises, and writing a provider of your own.

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
const hosted = openaiCompatible({ id: 'hosted', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra', apiKey: process.env.OPENAI_API_KEY, temperature: null, maxTokensField: 'max_completion_tokens' })
```

The hosted provider sets `temperature: null` and `maxTokensField: 'max_completion_tokens'` because OpenAI's reasoning models reject a `temperature`, and OpenAI deprecates `max_tokens` for every model. `maxTokensField` takes effect once `maxTokens` is set.

### Options

| Option | Type | Default | Does |
| --- | --- | --- | --- |
| `id` | `string` | Required | Names the provider in events, `meta` and its error messages |
| `baseUrl` | `string` | Required | An `http://` or `https://` URL with a host, and no user name, password, query or fragment. Requests go to it, its trailing slashes removed, followed by `/chat/completions` and the `query` |
| `model` | `string` | Required | Sent as `model` in every request |
| `apiKey` | `string` | None | Sent as `auth` says, and nowhere else. Without it, or with an empty one, no key header is sent |
| `auth` | `'bearer' \| 'x-api-key' \| 'none' \| { header, prefix? }` | `'bearer'` | How the key is sent: [The key header](#the-key-header) |
| `headers` | `Record<string, string>` | None | Sent with every request, names lower-cased. They cannot replace `content-type`, `content-length`, `host` or the key header |
| `query` | `Record<string, string>` | None | Added to every request URL. Not redacted from error messages: never put a key here |
| `extraBody` | `Record<string, unknown>` | None | JSON values deep-merged into the body last: objects merge key by key, anything else replaces. It cannot replace `model`, `messages` or `stream` |
| `temperature` | `number \| null` | `0` | Sent as `temperature`; `null` leaves it out, for a model that rejects it |
| `maxTokens` | `number` | None | The most tokens the reply may hold, sent under `maxTokensField`. Not sent unless set |
| `maxTokensField` | `'max_tokens' \| 'max_completion_tokens'` | `'max_tokens'` | The body field of `maxTokens`. OpenAI's reasoning models need `max_completion_tokens` |
| `systemPrompt` | `'native' \| 'inline'` | `'native'` | `native` sends the system text as a `system` message; `inline` puts it at the head of the first user message, joined by a blank line, for a chat template that rejects a system role |
| `structuredOutput` | `'prompt' \| 'json' \| 'schema'` | `'json'` | How the reply's shape reaches the endpoint: [Structured output](#structured-output) |

`HttpProviderOptions` types every option here except `maxTokensField`, which `OpenAICompatibleOptions` adds.

The body of every request holds, in this order:

- `model` and `messages`: the request's messages, with the system text first as a `system` message, or inline at the head of the first user message;
- `response_format`, unless `structuredOutput` is `prompt`;
- `temperature`, unless it is `null`;
- `maxTokens` under `maxTokensField`, when set;
- then `extraBody`, merged.

### The key header

`auth` names the header that carries `apiKey`, and the key goes nowhere else:

| `auth` | Header |
| --- | --- |
| `'bearer'` | `Authorization: Bearer <key>` |
| `'x-api-key'` | `x-api-key: <key>` |
| `'none'` | none; a key set as well is a configuration error |
| `{ header: 'api-key' }` | `api-key: <key>` |
| `{ header: 'X-Token', prefix: 'Token ' }` | `x-token: Token <key>` |

A custom header name is lower-cased, and its `prefix` goes before the key. A request sends its headers in this order: the content type, the provider's own `headers`, then the key header.

### Structured output

| Mode | `response_format` sent |
| --- | --- |
| `prompt` | None: the schema is only in the system message |
| `json` | `{ "type": "json_object" }` |
| `schema` | `{ "type": "json_schema", "json_schema": { "name": <output.name>, "schema": <output.schema>, "strict": true } }` |

Every mode keeps the schema in the system message, and the core validates the reply the same way in each. `schema` asks the endpoint to enforce the shape; use it where the endpoint supports it, `json` where it supports only JSON mode, and `prompt` where it supports neither.

### The limits of a request

Every request goes through one hardened path:

- **A redirect is not followed.** It is an `http` error that names it, `HTTP 307 (redirects are not followed): "<body>"`, so a key in any header never reaches another endpoint.
- **A reply body over 16 MiB is refused**, without reading the rest.
- **At most 64 KiB of an error body is read**, enough for the 500 characters a message quotes.
- **Server text in a message is redacted** of the key and of the base URL's path, before and after escaped ASCII is decoded, and cut to 500 characters (200 for model text). A server echoes the path in a 404, so the path is redacted too.

### The reply

The text is the first choice's `message.content`: a string, or an array of parts whose `text` parts are joined, as Mistral sends it. Every other part is skipped, thinking parts included. `model` is the one the reply names, or the configured one when it names none. `usage` is read from `usage.prompt_tokens` and `usage.completion_tokens` when both are numbers; the adapter reports no cost.

A top-level `error` in the reply fails the call before the choices are read, since some servers answer a failure with status 200 (OpenRouter does, for a failure during generation). The error is `{ message, code }` or a string. An `error` of `null` beside the choices is a success.

### Its configuration errors

`openaiCompatible` checks its options when it is called, before any request, and throws one `ConfigError` with each problem. No message repeats a value:

| Path | Message |
| --- | --- |
| `<id>.baseUrl` | `must be an http:// or https:// URL with a host` |
| `<id>.baseUrl` | `must not hold a user name or password: send a key with apiKey` |
| `<id>.baseUrl` | `must not hold a query or a fragment` |
| `<id>.apiKey` | `must only contain visible ASCII characters, which an HTTP header can carry` |
| `<id>.apiKey` | `is set, but auth is none, so it would never be sent` |
| `<id>.auth` | `must be bearer, x-api-key, none or { header, prefix }` |
| `<id>.auth.header` | `must be an HTTP header name` |
| `<id>.auth.header` | `must not be content-type, content-length or host` |
| `<id>.auth.prefix` | `must only contain printable ASCII characters` |
| `<id>.headers.<name>` | `must be an HTTP header name` |
| `<id>.headers.<name>` | `must not be content-type, content-length or host` |
| `<id>.headers.<name>` | `is the header that carries the key: set apiKey instead` |
| `<id>.headers.<name>` | `must be a string of printable ASCII characters` |
| `<id>.query` | `must map names to strings` |
| `<id>.extraBody` | `must be an object of JSON values, with no __proto__ key` |
| `<id>.extraBody.<key>` | `is written by the adapter and cannot be replaced` |
| `<id>.temperature` | `must be a finite number, or null to leave it out` |
| `<id>.maxTokens` | `must be a whole number of at least 1` |
| `<id>.maxTokensField` | `must be max_tokens or max_completion_tokens` |
| `<id>.systemPrompt` | `must be native or inline` |
| `<id>.structuredOutput` | `must be prompt, json or schema` |

## `ProviderError`

Every failure of an `openaiCompatible` call is a `ProviderError`, the error class the core exports for any provider to use. Its message starts with the provider id, and the adapter never puts a request header, a key or the runtime's own error text in it: text a server or a model sent is quoted as a JSON string and cut short, and a key the server echoes, or the base URL's path, is replaced by `[redacted]` first.

| Field | Holds |
| --- | --- |
| `providerId` | The provider's id |
| `kind` | What went wrong, below |
| `status` | The HTTP status, for `http` |
| `retryable` | `true` for `network` and `timeout`, and for `http` with status 408, 409, 429 or 5xx: a caller may try the call again |

| Kind | Raised by `openaiCompatible` when |
| --- | --- |
| `http` | The endpoint answers with a status outside 2xx: `HTTP 503: "model is loading"`, quoting up to 500 characters of the body. A 3xx adds `(redirects are not followed)`: `HTTP 307 (redirects are not followed): "moved"`. A server error in a 2xx reply, with an error status (400 to 599) as its `code`, reads `server error 502: "<message>"`, and is retryable as that status would be |
| `network` | The request fails, `request to http://localhost:11434 failed (ECONNREFUSED)`, or reading the reply does, `reading the reply from <origin> failed` |
| `aborted` | The review's signal stopped the request: `request aborted` |
| `refusal` | The model refused, `model refused: "<up to 200 characters>"`, or the content filter stopped the reply (the finish reason `content_filter`), `reply was stopped by the content filter` |
| `truncated` | The token limit or the model's context cut the reply off, with the finish reason `length` or `model_length`: `reply was cut off by the token limit` |
| `invalid-response` | The body is not JSON (`response body is not JSON`), is over 16 MiB (`reply body is over 16 MiB`) or is not an object (`reply is not a JSON object`). Or the reply holds a server error with no error status as its `code` (`server error: "<message>"`, the quote left out when the server sends no text), has no choices (`reply has no choices`), ended early with the finish reason `error`, `insufficient_system_resource` or `aborted` (`reply ended early: "<finish reason>"`), or has no message content (`reply has no message content`) |
| `timeout`, `process`, `unsupported` | Never: these are for other providers |

The core raises one more itself: a provider whose reply has no string `text` fails that call with `<id>: returned no reply text`, of kind `invalid-response`.

Quorum does not retry a call. A failed research call fails the review: the CLI exits `3`, and `review` rejects with the error. A failed vote is recorded in the vote's `error` and counts as a reject: [Failed votes](./50-lenses-and-policy.md#failed-votes).

## Writing a provider

Any object of the port's shape is a provider. It must:

- **return the model's raw text** in `text`, without parsing it: the core extracts and validates the JSON itself, and a reply it cannot use is a failed vote, or, for research, a failed review;
- **honour `request.signal`**, settling soon after it aborts: stopping a call in flight is cooperative, so a review that was aborted can wait for a provider that ignores its signal;
- **throw when the call fails**, a `ProviderError` with the closest `kind` for preference. A vote records the message of any `Error`, and the text of anything else thrown;
- **report `usage` only when it knows it**: `inputTokens` and `outputTokens`, and `costUsd` when it knows the price.

A provider can wrap another. Quorum sets no time limit on a call, so this one adds a limit to any provider that honours its signal, as `openaiCompatible` does, and reports a call that ran out of time as a `timeout`. It does not stop a provider that ignores its signal: it waits for that call to settle, however long it takes:

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
