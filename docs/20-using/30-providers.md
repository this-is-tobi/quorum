# Providers

A provider is how quorum reaches a model: an object that takes one request and returns the text of the reply. The CLI builds two `openaiCompatible` providers from the environment; a program builds its own, with one of the four shipped adapters or from scratch. This page covers the port, the adapters, the presets, the options the adapters share, the key header styles, the tool fields each adapter refuses, the limits of a request, the body each adapter sends and the replies it reads, the errors a provider raises, and writing a provider of your own.

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

- **Text in, text out.** A request carries the instructions in `system`, the fenced data in `messages` (one `user` message), the shape of the reply in `output` (named `research_findings` or `panel_vote`, with its JSON Schema), and the review's `signal`. The request has no field for a tool, a function, a file or a network capability, and quorum offers none to a model. Each shipped adapter refuses the body fields of its protocol that would offer one, so `extraBody` cannot add them, but a model id can bring tools of its own, which only a preset's list refuses, and `headers` are sent as given: [The tool fields](#the-tool-fields).
- **No secret in a request.** No environment value, key or credential appears in a request: a key lives in the adapter that holds it.
- **The core never trusts the reply.** It extracts and validates the JSON in `text` itself, whatever the provider did to get it, and reads `usage` (`inputTokens`, `outputTokens`, optional `costUsd`) only when its counts are finite numbers of at least 0.
- **`id` and `model` name the provider** in events and in `meta`, as they were when the quorum was created.

[Prompts](./60-prompts.md) shows what `system` and `messages` hold.

## The adapters

Quorum ships one adapter per wire protocol:

| Adapter | For | Endpoint | Default `auth` | Default `temperature` | Default `structuredOutput` |
| --- | --- | --- | --- | --- | --- |
| `openaiCompatible` | Any OpenAI-compatible endpoint: Ollama's `/v1`, vLLM, TGI, llama.cpp, LM Studio or a hosted API | `POST {baseUrl}/chat/completions` | `'bearer'` | `0` | `'json'` |
| `anthropic` | The Anthropic Messages API, or a gateway that speaks it | `POST {baseUrl}/v1/messages` | `'bearer'` | Left out | `'prompt'` |
| `gemini` | The Gemini API's `generateContent` | `POST {baseUrl}/v1beta/models/{model}:generateContent` | `{ header: 'x-goog-api-key' }` | Left out | `'json'` |
| `ollama` | Ollama's native chat API, on a local server or Ollama's cloud | `POST {baseUrl}/api/chat` | `'bearer'` | `0` | `'json'` |

```ts
import { anthropic, gemini, ollama, openaiCompatible } from './src/index.ts'

const local = ollama({ id: 'local', baseUrl: 'http://localhost:11434', model: 'qwen3.6:27b' })
const claude = anthropic({ id: 'claude', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', apiKey: process.env.ANTHROPIC_API_KEY, structuredOutput: 'schema' })
const flash = gemini({ id: 'flash', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.8-flash', apiKey: process.env.GEMINI_API_KEY })
const hosted = openaiCompatible({ id: 'hosted', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra', apiKey: process.env.OPENAI_API_KEY, temperature: null, maxTokensField: 'max_completion_tokens' })
```

Every adapter sends one JSON `POST` per call through the same hardened path, [The limits of a request](#the-limits-of-a-request), passes the request's signal to `fetch`, and reports in `usage` every prompt token the request carried, cached ones included, and every token the model generated, thinking included, from the counts its protocol sends: never a cost. The counts a protocol keeps apart, such as Anthropic's cache tokens or Gemini's thought tokens, are added in when they are numbers; a reply without both main counts as numbers reports no `usage`.

## Presets

A preset is a row of data for a vendor's or a server's endpoint: the protocol it speaks, and the defaults it fills in for a provider, `baseUrl`, `auth`, `structuredOutput`, `temperature` and, for the `openai-compatible` protocol, `maxTokensField`. Any of them set on the provider wins. A field set to `undefined` counts as unset, so a spread of a value that was never given keeps the preset's; `temperature: null` is set, and leaves the temperature out.

| Preset | Protocol | Base URL | Key header | Key variable | `structuredOutput` | `temperature` | Token-limit field |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ollama` | `ollama` | `http://localhost:11434` | `Authorization: Bearer` | None | `json` | `0` | `options.num_predict` |
| `ollama-cloud` | `ollama` | `https://ollama.com` | `Authorization: Bearer` | `OLLAMA_API_KEY` | `json` | `0` | `options.num_predict` |
| `lmstudio` | `openai-compatible` | `http://localhost:1234/v1` | `Authorization: Bearer` | None | `schema` | `0` | `max_tokens` |
| `llamacpp` | `openai-compatible` | `http://127.0.0.1:9931/v1` | `Authorization: Bearer` | None | `json` | `0` | `max_tokens` |
| `vllm` | `openai-compatible` | `http://localhost:8000/v1` | `Authorization: Bearer` | None | `json` | `0` | `max_tokens` |
| `openai` | `openai-compatible` | `https://api.openai.com/v1` | `Authorization: Bearer` | `OPENAI_API_KEY` | `json` | Left out | `max_completion_tokens` |
| `azure-openai` | `openai-compatible` | None: the provider sets its own | `api-key` | `AZURE_OPENAI_API_KEY` | `json` | Left out | `max_completion_tokens` |
| `openrouter` | `openai-compatible` | `https://openrouter.ai/api/v1` | `Authorization: Bearer` | `OPENROUTER_API_KEY` | `prompt` | `0` | `max_tokens` |
| `groq` | `openai-compatible` | `https://api.groq.com/openai/v1` | `Authorization: Bearer` | `GROQ_API_KEY` | `json` | `0` | `max_completion_tokens` |
| `mistral` | `openai-compatible` | `https://api.mistral.ai/v1` | `Authorization: Bearer` | `MISTRAL_API_KEY` | `json` | `0` | `max_tokens` |
| `deepseek` | `openai-compatible` | `https://api.deepseek.com` | `Authorization: Bearer` | `DEEPSEEK_API_KEY` | `json` | `0` | `max_tokens` |
| `together` | `openai-compatible` | `https://api.together.ai/v1` | `Authorization: Bearer` | `TOGETHER_API_KEY` | `json` | `0` | `max_tokens` |
| `fireworks` | `openai-compatible` | `https://api.fireworks.ai/inference/v1` | `Authorization: Bearer` | `FIREWORKS_API_KEY` | `json` | `0` | `max_tokens` |
| `xai` | `openai-compatible` | `https://api.x.ai/v1` | `Authorization: Bearer` | `XAI_API_KEY` | `json` | `0` | `max_completion_tokens` |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | `Authorization: Bearer` | `ANTHROPIC_API_KEY` | `schema` | Left out | `max_tokens` |
| `gemini` | `gemini` | `https://generativelanguage.googleapis.com` | `x-goog-api-key` | `GEMINI_API_KEY` | `json` | Left out | `generationConfig.maxOutputTokens` |

- **The key variable** is the one the vendor documents for its key; nothing reads it yet. A preset sends no key it is not given, and a local server needs none: `vllm`, `llamacpp` and `lmstudio` take one as a bearer token once the server is started with one.
- **The defaults follow the vendors.** `temperature` is `0` unless the vendor rejects one, as OpenAI's reasoning models and Anthropic do, or its current models ignore it, as Gemini's do. `structuredOutput` is `json` where the server documents a JSON mode, `schema` where it documents only a schema (LM Studio, and Anthropic, which has no JSON mode), and `prompt` for OpenRouter, whose support depends on the model a request is routed to and which ignores a format the endpoint cannot honour. `openai`, `azure-openai`, `groq` and `xai` send `max_completion_tokens`, which their vendors document in place of a deprecated `max_tokens`. DeepSeek's base URL has no `/v1`.
- **`ollama-cloud`** is Ollama's cloud, `https://ollama.com`, reached through the same native `/api/chat` as a local server, with a key.
- **`azure-openai` has no base URL**: set your resource's v1 endpoint, `https://<resource>.openai.azure.com/openai/v1`, and name your deployment as the model. Without a base URL it is a configuration error.

### The model ids a preset refuses

A model id can bring tools of its own, which no body check sees. A preset lists the ids of its vendor that run a tool on the server by themselves, as patterns where `*` stands for any text, possibly empty, and every other character for itself. A provider built from the preset refuses a model that a pattern matches whole, in any letter case: `<id>.model: runs tools on the server by itself, which quorum never allows`.

| Preset | Refused model ids | Why |
| --- | --- | --- |
| `openai` | `*search*`, `*computer-use*` | The search models, such as `gpt-5-search-api`, search the web before every answer, and the computer-use models drive a browser |
| `openrouter` | `*:online*`, `*@preset/*`, `openrouter/fusion*`, `openrouter/auto*`, `perplexity/*`, `*search*` | `:online` adds a web search, a `@preset/` slug can hold tools, `openrouter/fusion` runs with web search and web fetch, `openrouter/auto` routes to a pool of models OpenRouter does not publish, which may hold search models, and Perplexity's models and any search model search by themselves |
| `groq` | `openai/gpt-oss-*`, `groq/compound*`, `compound-beta*` | gpt-oss runs Groq's built-in web search and code execution by itself, which no parameter turns off, and the compound models run tools by themselves |
| `xai` | `*multi-agent*` | The multi-agent model works only on the Responses API, where xAI runs its server-side tools |
| `gemini` | `*deep-research*`, `*antigravity*`, `*computer-use*` | Deep Research and Antigravity are agents that search, fetch URLs and run code, and the computer-use models drive a browser. A Gemini id is matched with its `models/` prefix too |

The other presets know no such id: on `azure-openai` the model is a deployment name you choose. A model no pattern knows, or one sent without a preset, can still run a tool: `openaiCompatible` then fails the reply that shows it, [`openaiCompatible`](#openaicompatible).

### Presets as data

`presets` is exported read-only: the table, each row, its `auth` and its `toolModels` are frozen, so a change throws a `TypeError` and no program can alter the defaults another provider reads. `Preset` types a row, `PresetName` names one and `Protocol` names the four wire protocols. No command and no exported function builds a provider from a preset yet: the configuration file still to come will, and the checks below and the model-id refusals apply from then on. Until then a program that passes a preset's values to an adapter itself gets only the adapter's checks, and must choose a model that runs no tool; the reply check of `openaiCompatible` is the control that applies now, [`openaiCompatible`](#openaicompatible).

A provider built from a preset or a protocol is checked first for the problems below, then with its adapter's own checks, [Configuration errors](#configuration-errors), and every problem comes in one `ConfigError`, these first. While the protocol or the base URL is still unknown, these come alone. No message repeats a value:

| Path | Message |
| --- | --- |
| `<id>.preset` | `must be one of ollama, ollama-cloud, lmstudio, llamacpp, vllm, openai, azure-openai, openrouter, groq, mistral, deepseek, together, fireworks, xai, anthropic or gemini` |
| `<id>.protocol` | `is required without a preset` |
| `<id>.protocol` | `must be openai-compatible, anthropic, gemini or ollama` |
| `<id>.protocol` | `must be <protocol>, the protocol of the <preset> preset`, for a protocol other than the preset's |
| `<id>.baseUrl` | `is required without a preset` |
| `<id>.baseUrl` | `is required: the azure-openai preset has none` |
| `<id>.maxTokensField` | `is only for the openai-compatible protocol` |
| `<id>.model` | `runs tools on the server by itself, which quorum never allows` |

## The shared options

### Options

| Option | Type | Default | Does |
| --- | --- | --- | --- |
| `id` | `string` | Required | Names the provider in events, `meta` and its error messages |
| `baseUrl` | `string` | Required | An `http://` or `https://` URL with a host, and no user name, password, query or fragment. Requests go to it, its trailing slashes removed, followed by the adapter's path and the `query` |
| `model` | `string` | Required | The model every request names: in the body, or in the URL for `gemini` |
| `apiKey` | `string` | None | Sent as `auth` says, and nowhere else. Without it, or with an empty one, no key header is sent |
| `auth` | `'bearer' \| 'x-api-key' \| 'none' \| { header, prefix? }` | The adapter's | How the key is sent: [The key header](#the-key-header) |
| `headers` | `Record<string, string>` | None | Sent with every request, names lower-cased. They cannot replace `content-type`, `content-length`, `host`, the key header, or `anthropic`'s `anthropic-version`. Their values are redacted from error messages, as the key is |
| `query` | `Record<string, string>` | None | Added to every request URL. Not redacted from error messages: never put a key here. A value equal to `apiKey` is refused |
| `extraBody` | `Record<string, unknown>` | None | JSON values deep-merged into the body last: objects merge key by key, anything else replaces. A top-level key cannot replace a field the adapter writes for the conversation, or set one that offers the model a tool: [The tool fields](#the-tool-fields) |
| `temperature` | `number \| null` | The adapter's | Sent where the protocol takes it; `null` leaves it out, for a model that rejects it |
| `maxTokens` | `number` | None, but `anthropic`'s 16000 | The most tokens the reply may hold, in the protocol's own field |
| `systemPrompt` | `'native' \| 'inline'` | `'native'` | `native` sends the system text in the protocol's own place; `inline` puts it at the head of the first user message, joined by a blank line, for a chat template that rejects a system role |
| `structuredOutput` | `'prompt' \| 'json' \| 'schema'` | The adapter's | How the reply's shape reaches the endpoint: [Structured output](#structured-output) |

`systemPrompt: 'inline'` sends the instructions in the same user message as the fenced data, so they lose the role that sets them apart from it: a weaker separation than the one [Prompts](./60-prompts.md#the-layout-of-a-request) describes. When the conversation does not start with a user message, `inline` sends the system text as a user message of its own.

`HttpProviderOptions` types every option here. `OpenAICompatibleOptions` adds `maxTokensField`, and `AnthropicOptions`, `GeminiOptions` and `OllamaOptions` are `HttpProviderOptions` as it is.

### The key header

`auth` names the header that carries `apiKey`, and the key goes nowhere else:

| `auth` | Header |
| --- | --- |
| `'bearer'` | `Authorization: Bearer <key>` |
| `'x-api-key'` | `x-api-key: <key>` |
| `'none'` | none; a key set as well is a configuration error |
| `{ header: 'api-key' }` | `api-key: <key>` |
| `{ header: 'X-Token', prefix: 'Token ' }` | `x-token: Token <key>` |
| `{ header: 'authorization', prefix: 'Basic ' }` | `authorization: Basic <key>`: basic auth, with the base64 of `user:password` as the key |

A custom header name is lower-cased, and its `prefix` goes before the key. A request sends its headers in this order: the content type, the provider's own `headers`, then the key header; `anthropic` sends its version header last.

### Structured output

| Mode | `openaiCompatible` | `anthropic` | `gemini` | `ollama` |
| --- | --- | --- | --- | --- |
| `prompt` | No `response_format` | No `output_config` | No `responseMimeType` | No `format` |
| `json` | `response_format: { "type": "json_object" }` | Refused: the Messages API has no JSON mode | `generationConfig.responseMimeType: "application/json"` | `format: "json"` |
| `schema` | `response_format: { "type": "json_schema", "json_schema": { "name": <output.name>, "schema": <output.schema>, "strict": true } }` | `output_config: { "format": { "type": "json_schema", "schema": <output.schema> } }` | `generationConfig.responseMimeType: "application/json"` and `generationConfig.responseJsonSchema: <output.schema>` | `format: <output.schema>` |

Every mode keeps the schema in the system message, and the core validates the reply the same way in each. `schema` asks the endpoint to enforce the shape; use it where the endpoint supports it, `json` where it supports only JSON mode, and `prompt` where it supports neither. An endpoint can drop the field without a word: Ollama's and DeepSeek's Anthropic-compatible endpoints ignore `output_config.format`, so `schema` is enforced only where the endpoint supports it, and Anthropic accepts it only on the models its structured-outputs page lists.

### The tool fields

Each adapter refuses, in `extraBody`, the body fields of its protocol that would offer the model a tool or a server-side capability. A tool the server runs, such as a web search, code execution, a URL fetch or an MCP server, could carry the data out, and quorum offers a model none:

| Adapter | Refused fields |
| --- | --- |
| `openaiCompatible` | `tools`, `tool_choice`, `parallel_tool_calls`, `functions`, `function_call` and `web_search_options`, which OpenAI and others take; OpenRouter's `plugins`, `deferred_tools`, `stop_server_tools_when`, `x_search_filter`, `preset` and `models`, a fallback list whose ids can bring tools as `:online` does; xAI's `search_parameters`; Groq's `compound_custom`, `search_settings`, `include_domains`, `exclude_domains`, `disable_tool_validation` and `documents`; Azure's `data_sources`, which grounds the reply on an external search index (On Your Data) |
| `anthropic` | `tools`, `tool_choice`, `mcp_servers`, which offers an MCP server's tools with no `tools` entry under a deprecated beta, `container`, which loads skills, and the beta's server-side fields `thread`, `fallbacks`, `fallback_credit_token`, `context_management` and `compaction` |
| `gemini` | `tools`, `toolConfig`, and `cachedContent`, since a cached content can hold tools of its own |
| `ollama` | `tools`, and `_debug_render_only`, which answers with the rendered template instead of a reply |

Each is a configuration error: `<id>.extraBody.<key>: offers the model a tool, which quorum never does`. A key matches in any letter case and with or without underscores, since Ollama's Go decoder reads a key in any letter case, U+017F matching `s` and U+212A matching `k`, and Gemini's proto JSON takes a field's snake_case name: `Tools` and `tool_config` are refused too, and so is a field the adapter writes, such as `Messages`. `openaiCompatible` lets `chat_template_kwargs` through: it sets chat-template variables, such as turning thinking off on vLLM or Together, and runs nothing on the server.

Two ways around these checks remain, and both are the program's to avoid:

- **A model id can bring tools of its own**, which no body check sees: OpenAI's search models search the web before every answer, and OpenRouter's `:online` suffix, its `openrouter/fusion` model and its `@preset/` ids add a web search or a stored preset's tools. A preset refuses the ids it knows, [The model ids a preset refuses](#the-model-ids-a-preset-refuses), and `openaiCompatible` fails a reply that shows a tool the server ran, but a model no list knows can still search before it answers. Choose a model that runs no tool.
- **`headers` are sent as given.** `anthropic` accepts an `anthropic-beta` header, which serves needs such as a longer context window: no documented beta header offers a tool by itself, and the body fields a beta would need are refused.

### The limits of a request

Every request goes through one hardened path:

- **A redirect is not followed.** It is an `http` error that names it, `HTTP 307 (redirects are not followed): "<body>"`, so a key in any header never reaches another endpoint.
- **A reply body over 16 MiB is refused**, without reading the rest.
- **At most 64 KiB of an error body is read**, enough for the 500 characters a message quotes.
- **Server text in a message is redacted** of the key, of the base URL's path and of the values of `headers`, as written and trimmed, since `fetch` sends a header value trimmed; a value that is blank once trimmed redacts nothing. Every occurrence is redacted, and values that overlap in the text become one `[redacted]`. It is redacted once escaped ASCII is decoded, each value matched as written and with its own escapes decoded, then cut to 500 characters: 200 for model text and for a server error in a 2xx reply, 40 for a stop or finish reason. A server echoes the path in a 404, and a gateway's own credential goes in a header, so both are redacted too.

### Configuration errors

Each adapter checks its options when it is called, before any request, and throws one `ConfigError` with each problem, in this order. No message repeats a value:

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
| `<id>.auth.header` | `is set by the adapter and cannot be replaced` |
| `<id>.auth.prefix` | `must only contain printable ASCII characters` |
| `<id>.headers` | `must map names to strings` |
| `<id>.headers.<name>` | `must be an HTTP header name` |
| `<id>.headers.<name>` | `must not be content-type, content-length or host` |
| `<id>.headers.<name>` | `is the header that carries the key: set apiKey instead` |
| `<id>.headers.<name>` | `is set by the adapter and cannot be replaced` |
| `<id>.headers.<name>` | `must be a string of printable ASCII characters` |
| `<id>.query` | `must map names to strings` |
| `<id>.query.<name>` | `holds the key, which travels only in the header auth names` |
| `<id>.extraBody` | `must be an object of JSON values, with no __proto__ key` |
| `<id>.extraBody.<key>` | `is written by the adapter and cannot be replaced` |
| `<id>.extraBody.<key>` | `offers the model a tool, which quorum never does` |
| `<id>.temperature` | `must be a finite number, or null to leave it out` |
| `<id>.maxTokens` | `must be a whole number of at least 1` |
| `<id>.systemPrompt` | `must be native or inline` |
| `<id>.structuredOutput` | `must be prompt, json or schema` |
| `<id>.structuredOutput` | `must be prompt or schema` |
| `<id>.maxTokensField` | `must be max_tokens or max_completion_tokens` |
| `<id>.query.<name>` | `would carry a key in the URL: set apiKey instead` |
| `<id>.model` | `must be a Gemini model id, such as gemini-3.8-flash` |

`is set by the adapter and cannot be replaced` names `anthropic`'s `anthropic-version`, in any letter case, as a header or as a custom `auth` header. `must be prompt or schema` is `anthropic`'s, whose protocol has no JSON mode. `maxTokensField` is checked by `openaiCompatible` only, and `model` and a `key` query parameter by `gemini` only.

## `openaiCompatible`

For any OpenAI-compatible `/chat/completions` endpoint. The hosted provider of [The adapters](#the-adapters) sets `temperature: null` and `maxTokensField: 'max_completion_tokens'`, as the `openai` preset does, because OpenAI's reasoning models reject a `temperature`, and OpenAI deprecates `max_tokens` for every model.

| Option | Type | Default | Does |
| --- | --- | --- | --- |
| `maxTokensField` | `'max_tokens' \| 'max_completion_tokens'` | `'max_tokens'` | The body field of `maxTokens`, once `maxTokens` is set. OpenAI's reasoning models need `max_completion_tokens` |

The body of every request holds, in this order:

- `model` and `messages`: the request's messages, with the system text first as a `system` message, or inline at the head of the first user message;
- `response_format`, unless `structuredOutput` is `prompt`;
- `temperature`, unless it is `null`;
- `maxTokens` under `maxTokensField`, when set;
- then `extraBody`, merged. It cannot replace `model`, `messages` or `stream`.

The text is the first choice's `message.content`: a string, or an array of parts whose `text` parts are joined, as Mistral sends it. Every other part is skipped, thinking parts included. `model` is the one the reply names, or the configured one when it names none. `usage` is read from `usage.prompt_tokens` and `usage.completion_tokens`.

A top-level `error` in the reply fails the call before the choices are read, since some servers answer a failure with status 200 (OpenRouter does, for a failure during generation). The error is `{ message, code }` or a string. An `error` of `null` beside the choices is a success. A message that shows a tool the server ran fails next, before a refusal or a finish reason is read: a model or a gateway that ran a tool by itself leaves a review that cannot be trusted. An empty `executed_tools`, and `annotations` without a `url_citation`, are not one.

| The reply | Kind | Message |
| --- | --- | --- |
| A server error, its `code` an error status (400 to 599) | `http`, retryable as that status would be | `server error 502: "<message>"` |
| A server error with no error status as its `code` | `invalid-response` | `server error: "<message>"`, and `server error: ""` for `{ "error": "" }`; the quote is left out only when `error` is an object without a string `message`, as in `{ "error": {} }` |
| No first choice | `invalid-response` | `reply has no choices` |
| A non-empty `executed_tools` array in the message (Groq's built-in tools), or a `url_citation` entry in its `annotations` (OpenAI's search models, OpenRouter's web plugin) | `invalid-response` | `the server ran a tool for this reply, which quorum never allows` |
| `message.refusal` set | `refusal` | `model refused: "<up to 200 characters>"`, or `model refused` when it is not a string |
| The finish reason `content_filter` | `refusal` | `reply was stopped by the content filter` |
| The finish reason `length` or `model_length` | `truncated` | `reply was cut off by the token limit` |
| The finish reason `error`, `insufficient_system_resource` or `aborted` | `invalid-response` | `reply ended early: "<finish reason>"` |
| No message content | `invalid-response` | `reply has no message content` |

## `anthropic`

For the Anthropic Messages API, or a gateway that speaks it, such as Ollama's or DeepSeek's Anthropic-compatible endpoint:

- **Every request names the API version** in `anthropic-version: 2026-10-21`, the current one, which Anthropic's TypeScript SDK sends since its 1.0.0. No `headers` entry can replace it; an `anthropic-beta` header goes through.
- **The key goes as `Authorization: Bearer <key>`** by default: Anthropic documents it as its primary key header, `x-api-key` as a legacy fallback it still accepts, and the gateways take bearer. `auth: 'x-api-key'` sends the legacy header.
- **No temperature is sent unless one is set.** Under `2026-10-21`, Anthropic answers 400 to any `temperature`, `top_p` or `top_k`, even at its default value; a gateway may accept one.
- **`max_tokens` is always sent**, 16000 unless `maxTokens` is set: the Messages API requires it, and thinking counts toward it.
- **No assistant prefill and no `thinking` field.** Current models reject a prefill, and Claude Opus 5.5 answers 400 to a request that turns thinking off.

The body of every request holds, in this order:

- `model`;
- `max_tokens`;
- `system`: the system text, unless `systemPrompt` is `inline`;
- `messages`: the request's messages, each `{ role, content }` with its text;
- `temperature`, when set;
- `output_config: { format: { type: 'json_schema', schema: <output.schema> } }`, in `schema` mode;
- then `extraBody`, merged: `{ output_config: { effort: 'low' } }` goes beside the format in `schema` mode. It cannot replace `model`, `messages`, `system` or `stream`.

A reply succeeds with the stop reason `end_turn` or `stop_sequence` and a text block. The stop reason is read first, since a refused or cut-off reply can still hold some text. The text is the `text` of the `type: 'text'` blocks, joined: `thinking` and `redacted_thinking` blocks are skipped, as is every block of another type. `model` is the one the reply names, or the configured one. The input count is `usage.input_tokens`, plus `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens` when they are numbers; the output count is `usage.output_tokens`. A status outside 2xx is an `http` error that quotes Anthropic's `{ "type": "error", "error": { "type", "message" } }` body.

| The reply | Kind | Message |
| --- | --- | --- |
| `stop_reason` `refusal` | `refusal` | `model refused` |
| `stop_reason` `max_tokens` | `truncated` | `reply was cut off by the token limit` |
| `stop_reason` `model_context_window_exceeded` | `truncated` | `reply was cut off: the context window is full` |
| Any other `stop_reason`, `tool_use` and `pause_turn` included | `invalid-response` | `reply ended early: "<stop reason>"`, or `reply ended early` when it is not a string |
| No text block | `invalid-response` | `reply has no text` |

## `gemini`

For the Gemini API's `generateContent`, which Google now calls a legacy API, still supported:

- **The model goes in the URL**, `/v1beta/models/<model>:generateContent`. It is written with or without a leading `models/`, which is stripped, and the id that remains must match `[a-z0-9][a-z0-9.-]*` in any letter case, as `gemini-3.8-flash` does: that keeps a `/`, a `?` or a `:` out of the path. Another is a configuration error, `<id>.model: must be a Gemini model id, such as gemini-3.8-flash`. A tuned model (`tunedModels/...`) is not supported.
- **The key goes in `x-goog-api-key`** by default, never in the `key` query parameter: a `query` entry named `key`, in any letter case, is a configuration error, since URLs get logged and error messages would not redact it.
- **No temperature is sent unless one is set.** Current models ignore it, and Google says a future model will answer 400 to it.

The body of every request holds, in this order:

- `contents`: each message as `{ role, parts: [{ text }] }`, an `assistant` message with the role `model`;
- `systemInstruction: { parts: [{ text: <system text> }] }`, unless `systemPrompt` is `inline`;
- `generationConfig`, left out when it would be empty: `temperature` when set, `maxOutputTokens` when `maxTokens` is set, `responseMimeType: 'application/json'` in `json` and `schema` mode, and `responseJsonSchema: <output.schema>` in `schema` mode, as Google's JavaScript SDK sends it (`responseSchema` is deprecated);
- then `extraBody`, merged: `{ generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }` goes beside the rest. It cannot replace `contents` or `systemInstruction`.

A reply succeeds with a first candidate whose `finishReason` is `STOP` and whose parts hold text. The text is the `text` of the first candidate's `content.parts`, joined, without the parts flagged as thoughts. `model` is the reply's `modelVersion`, or the configured model. The input count is `usageMetadata.promptTokenCount`; the output count is `usageMetadata.candidatesTokenCount`, plus `usageMetadata.thoughtsTokenCount` when it is a number. A status outside 2xx is an `http` error that quotes Google's `{ "error": { "code", "message", "status", "details" } }` body; a 402, which Google sends for a depleted prepay balance, is not retryable, unlike a 429.

| The reply | Kind | Message |
| --- | --- | --- |
| `promptFeedback.blockReason` set | `refusal` | `prompt was blocked: "<reason>"` for a reason of 1 to 64 capital letters and underscores, such as `PROHIBITED_CONTENT`, and `prompt was blocked` for any other |
| No first candidate | `invalid-response` | `reply has no candidates` |
| `finishReason` `MAX_TOKENS` or `CONTINUATION` | `truncated` | `reply was cut off by the token limit` |
| `finishReason` `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` or `IMAGE_SAFETY` | `refusal` | `reply was stopped by the safety filter` |
| No `finishReason`, or `null` | `invalid-response` | `reply has not finished` |
| Any other `finishReason` | `invalid-response` | `reply ended early: "<finish reason>"`, or `reply ended early` when it is not a string |
| No text part | `invalid-response` | `reply has no text` |

## `ollama`

For Ollama's native chat API, on a local server or Ollama's cloud, `https://ollama.com`, which needs a key. Its base URL is the server's root, such as `http://localhost:11434`, without the `/v1` that `openaiCompatible` takes there:

- **`truncate: false` keeps a prompt whole.** A prompt past the model's context is then a 400, `request (N tokens) exceeds the available context size (M tokens), try increasing it`, instead of its oldest messages dropped in silence. It needs Ollama 0.12.6 or later; an older server ignores the field and drops them.
- **`shift: false` keeps it whole as the reply is written.** A reply that fills the model's context then stops, as a truncation, instead of part of the prompt dropped so the reply can go on. It needs the same versions, and a server that loaded the model with context shift on loads it again, as it does each time a client asks for the other setting.
- **The key goes as `Authorization: Bearer <key>`**, only when one is set: a local server needs none.
- **No `think` field.** A thinking model thinks as it does by default, and its thinking comes back apart, in `message.thinking`, which the adapter ignores.

The body of every request holds, in this order:

- `model` and `messages`: the request's messages, with the system text first as a `system` message, or inline at the head of the first user message;
- `stream: false`, `truncate: false` and `shift: false`;
- `options`, left out when it would be empty: `temperature`, unless it is `null`, and `num_predict`, when `maxTokens` is set;
- `format`: `'json'` in `json` mode, `<output.schema>` in `schema` mode;
- then `extraBody`, merged: `{ options: { num_ctx: 32768 } }` goes beside the temperature. It cannot replace `model`, `messages`, `stream`, `truncate` or `shift`.

A reply succeeds with `done: true`, the `done_reason` `stop` and a string `message.content`. The text is `message.content`, as it came: a `<think>` block left in it, by a model or a template Ollama cannot split, is for the core's reply parser to drop. `model` is the one the reply names, or the configured one; `usage` is read from `prompt_eval_count` and `eval_count`. A status outside 2xx is an `http` error that quotes Ollama's `{ "error": "<message>" }` body.

| The reply | Kind | Message |
| --- | --- | --- |
| A string `error` | `invalid-response` | `server error: "<message>"` |
| `done: true` and `done_reason` `length` | `truncated` | `reply was cut off by the token limit or the context`: with `shift: false`, a reply that fills the context ends as `length` too |
| No `done: true`, or a `done_reason` other than `stop` or `length` | `invalid-response` | `reply has not finished` |
| No string `message.content` | `invalid-response` | `reply has no text` |

## `ProviderError`

Every failure of a shipped adapter's call is a `ProviderError`, the error class the core exports for any provider to use. Its message starts with the provider id, and the adapter never puts a request header, a key or the runtime's own error text in it: text a server or a model sent is quoted as a JSON string and cut short, and a key the server echoes, the base URL's path or a value of `headers` is replaced by `[redacted]` first.

| Field | Holds |
| --- | --- |
| `providerId` | The provider's id |
| `kind` | What went wrong, below |
| `status` | The HTTP status, for `http`. For a server error in an `openaiCompatible` 2xx reply, it is the status the body's `code` names |
| `retryable` | `true` for `network` and `timeout`, and for `http` with status 408, 409, 429 or 5xx: a caller may try the call again |

| Kind | Raised when |
| --- | --- |
| `http` | The endpoint answers with a status outside 2xx: `HTTP 503: "model is loading"`, quoting up to 500 characters of the body. A 3xx adds `(redirects are not followed)`: `HTTP 307 (redirects are not followed): "moved"`. Also an `openaiCompatible` server error in a 2xx reply whose `code` is an error status |
| `network` | The request fails, `request to http://localhost:11434 failed (ECONNREFUSED)`, or reading the reply does, `reading the reply from <origin> failed` |
| `aborted` | The review's signal stopped the request: `request aborted` |
| `refusal` | The model refused, or a filter stopped the reply or the prompt: each adapter's reply table names its messages |
| `truncated` | The token limit or the model's context cut the reply off: `reply was cut off by the token limit`, `anthropic`'s `reply was cut off: the context window is full`, or `ollama`'s `reply was cut off by the token limit or the context` |
| `invalid-response` | The body is not JSON (`response body is not JSON`), is over 16 MiB (`reply body is over 16 MiB`) or is not an object (`reply is not a JSON object`), for every adapter. Or the reply holds an error, has not finished, ended early or holds no text, as each adapter's reply table words it |
| `timeout`, `process`, `unsupported` | Never: these are for other providers |

The core raises one more itself: a provider whose reply has no string `text` fails that call with `<id>: returned no reply text`, of kind `invalid-response`.

Quorum does not retry a call. A failed research call fails the review: the CLI exits `3`, and `review` rejects with the error. A failed vote is recorded in the vote's `error` and counts as a reject: [Failed votes](./50-lenses-and-policy.md#failed-votes).

## Writing a provider

Any object of the port's shape is a provider. It must:

- **return the model's raw text** in `text`, without parsing it: the core extracts and validates the JSON itself, and a reply it cannot use is a failed vote, or, for research, a failed review;
- **honour `request.signal`**, settling soon after it aborts: stopping a call in flight is cooperative, so a review that was aborted can wait for a provider that ignores its signal;
- **throw when the call fails**, a `ProviderError` with the closest `kind` for preference. A vote records the message of any `Error`, and the text of anything else thrown;
- **report `usage` only when it knows it**: `inputTokens` and `outputTokens`, and `costUsd` when it knows the price.

A provider can wrap another. Quorum sets no time limit on a call, so this one adds a limit to any provider that honours its signal, as the shipped adapters do, and reports a call that ran out of time as a `timeout`. It does not stop a provider that ignores its signal: it waits for that call to settle, however long it takes:

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
