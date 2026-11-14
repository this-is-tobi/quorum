# Providers

A provider is how quorum reaches a model: an object that takes one request and returns the text of the reply. The CLI builds its providers from its config, each from a preset or a protocol ([Configuration](./20-configuration.md)); a program builds its own, with one of the five shipped adapters or from scratch. This page covers the port, the adapters, the presets, the options the HTTP adapters share, the key header styles, the tool fields each of them refuses, the limits of a request, the body each sends and the replies it reads, the Claude Code adapter's command line, isolation and errors, the errors a provider raises, and writing a provider of your own.

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

Quorum ships one adapter per wire protocol, and one that runs your installed Claude Code CLI:

| Adapter | For | Endpoint | Default `auth` | Default `temperature` | Default `structuredOutput` |
| --- | --- | --- | --- | --- | --- |
| `openaiCompatible` | Any OpenAI-compatible endpoint: vLLM, TGI, llama.cpp, LM Studio or a hosted API. Ollama has `ollama`: its `/v1` cannot be told the context size | `POST {baseUrl}/chat/completions` | `'bearer'` | `0` | `'json'` |
| `anthropic` | The Anthropic Messages API, or a gateway that speaks it | `POST {baseUrl}/v1/messages` | `'bearer'` | Left out | `'prompt'` |
| `gemini` | The Gemini API's `generateContent` | `POST {baseUrl}/v1beta/models/{model}:generateContent` | `{ header: 'x-goog-api-key' }` | Left out | `'json'` |
| `ollama` | Ollama's native chat API, on a local server or Ollama's cloud: the CLI's built-in default | `POST {baseUrl}/api/chat` | `'bearer'` | `0` | `'json'` |
| `claudeCode` | Your installed Claude Code CLI, run headless for each request | Spawns `claude -p` | `'inherit'`, of its own three modes: [The auth modes](#the-auth-modes) | Not supported | `'schema'` |

```ts
import { anthropic, claudeCode, gemini, ollama, openaiCompatible } from '@tobi-or-not/quorum'

const local = ollama({
  id: 'local',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.6:27b',
  contextTokens: 131072
})
const claude = anthropic({
  id: 'claude',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
  contextTokens: 200000,
  apiKey: process.env.ANTHROPIC_API_KEY,
  structuredOutput: 'schema'
})
const flash = gemini({
  id: 'flash',
  baseUrl: 'https://generativelanguage.googleapis.com',
  model: 'gemini-3.8-flash',
  contextTokens: 1000000,
  apiKey: process.env.GEMINI_API_KEY
})
const hosted = openaiCompatible({
  id: 'hosted',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-6-astra',
  contextTokens: 400000,
  apiKey: process.env.OPENAI_API_KEY,
  temperature: null,
  maxTokensField: 'max_completion_tokens'
})
const code = claudeCode({ id: 'code', model: 'sonnet', contextTokens: 1000000 })
```

Every HTTP adapter sends one JSON `POST` per call through the same hardened path, [The limits of a request](#the-limits-of-a-request), passes the request's signal to `fetch`, and reports in `usage` every prompt token the request carried, cached ones included, and every token the model generated, thinking included, from the counts its protocol sends: never a cost. The counts a protocol keeps apart, such as Anthropic's cache tokens or Gemini's thought tokens, are added in when they are numbers; a reply without both main counts as numbers reports no `usage`. `claudeCode` sends no request of its own: it runs a process, [`claudeCode`](#claudecode), and is the one adapter that reports a cost.

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

- **The key variable** is the one the vendor documents for its key. `fromConfig` and `loadConfig` read it, but only while the base URL keeps the preset's origin, and warn when it does not: a key is sent only to the endpoint it belongs to. `AZURE_OPENAI_API_KEY` is one variable for every Azure resource, since the preset has no base URL: it is read for an `https` host under `openai.azure.com`, so a voter whose own variables name `azure-openai` on another Azure host sends that key there. A preset sends no key it is not given, and a local server needs none: `vllm`, `llamacpp` and `lmstudio` take one as a bearer token once the server is started with one.
- **The defaults follow the vendors.** `temperature` is `0` unless the vendor rejects one, as OpenAI's and Azure's reasoning models and Anthropic do, or its current models ignore it, as Gemini's do. `structuredOutput` is `json` where the server documents a JSON mode, `schema` where it documents only a schema (LM Studio, and Anthropic, which has no JSON mode), and `prompt` for OpenRouter, whose support depends on the model a request is routed to and which ignores a format the endpoint cannot honour. `openai`, `azure-openai`, `groq` and `xai` send `max_completion_tokens`, which their vendors document in place of a deprecated `max_tokens`. DeepSeek's base URL has no `/v1`.
- **`ollama-cloud`** is Ollama's cloud, `https://ollama.com`, reached through the same native `/api/chat` as a local server, with a key.
- **`azure-openai` has no base URL**: set your resource's v1 endpoint, `https://<resource>.openai.azure.com/openai/v1`, and name your deployment as the model. Without a base URL it is a configuration error.

### The model ids a preset refuses

A model id can bring tools of its own, which no body check sees. A preset lists the ids of its vendor that run a tool on the server by themselves, as patterns where `*` stands for any text, possibly empty, and every other character for itself. A provider built from the preset refuses a model that a pattern matches whole, in any letter case: `<id>.model: runs tools on the server by itself, which quorum never allows`. The patterns also apply to a provider whose base URL has a preset's origin (its scheme, host and port), whether or not it names a preset: a provider with only a protocol, pointed at Groq's endpoint, is held to Groq's patterns, and so is one built from another preset and pointed there. The host is read in lower case, a default port is dropped and so is one trailing dot, so `HTTPS://API.GROQ.COM:443/v9` and `https://api.groq.com./openai/v1` have Groq's origin; another port is another origin.

| Preset | Refused model ids | Why |
| --- | --- | --- |
| `openai` | `*search*`, `*computer-use*` | The search models, such as `gpt-5-search-api`, search the web before every answer, and the computer-use models drive a browser |
| `openrouter` | `*:online*`, `*@preset/*`, `openrouter/fusion*`, `openrouter/auto*`, `perplexity/*`, `*search*` | `:online` adds a web search, a `@preset/` slug can hold tools, `openrouter/fusion` runs with web search and web fetch, `openrouter/auto` routes to a pool of models OpenRouter does not publish, which may hold search models, and Perplexity's models and any search model search by themselves |
| `groq` | `openai/gpt-oss-*`, `groq/compound*`, `compound-beta*` | gpt-oss runs Groq's built-in web search and code execution by itself, which no parameter turns off, and the compound models run tools by themselves |
| `xai` | `*multi-agent*` | The multi-agent model works only on the Responses API, where xAI runs its server-side tools |
| `gemini` | `*deep-research*`, `*antigravity*`, `*computer-use*` | Deep Research and Antigravity are agents that search, fetch URLs and run code, and the computer-use models drive a browser. A Gemini id is matched with its `models/` prefix too |

The other presets know no such id: on `azure-openai` the model is a deployment name you choose. A model no pattern knows, or one reached through a gateway or a proxy at another origin, can still run a tool, and `openaiCompatible` then fails the reply that shows it, [`openaiCompatible`](#openaicompatible).

### Presets as data

`presets` is exported read-only: the table, each row, its `auth` and its `toolModels` are frozen, so a change throws a `TypeError` in strict-mode code, as every ES module is; elsewhere the write is ignored, and the values never change either way, so no program can alter the defaults another provider reads. A row has the fields `protocol`, `baseUrl`, `auth`, `apiKeyEnv`, `structuredOutput`, `temperature`, `maxTokensField` and `toolModels`, and `apiKeyEnv` is the "Key variable" column. `Preset` types a row, `PresetName` names one and `Protocol` names the four wire protocols. `fromConfig` builds each provider a config defines from its preset or its protocol, through the checks below and the model-id refusals: [`loadConfig` and `fromConfig`](../95-reference/30-library-api.md#loadconfig-and-fromconfig). The CLI builds its providers through `fromConfig`, so its refusals are the same. A program that passes a preset's values to an adapter itself gets only the adapter's checks. Those already refuse, in every adapter, the body fields that offer a tool; the reply check of `openaiCompatible` is the one that covers a tool a model id brings, [`openaiCompatible`](#openaicompatible), and it has limits. It runs after the server ran the tool: it keeps a review from being built on the tool's output, but what the tool sent has already left, and a search query can quote the diff. Groq reports `executed_tools` whatever the model does, while a `url_citation` appears only when the reply cites a source, so a search model that cites nothing can pass. So choose a model that runs no tool.

A provider built from a preset or a protocol is checked first for the problems below, then with its adapter's own checks, [Configuration errors](#configuration-errors), and every problem comes in one `ConfigError`, these first. While the protocol, the base URL or the model is unusable, these come alone. The builder reads a spec's fields once each, and only its own: a field that only a prototype holds, such as one planted on `Object.prototype`, is unset, and a getter is called once, so the checks and the adapter see the same value. The `auth` object goes to the adapter as a copy of its own fields too. That is the builder's own read: the schema that checks a config before the builder has a limit of its own, [`loadConfig` and `fromConfig`](../95-reference/30-library-api.md#loadconfig-and-fromconfig). No message repeats a value:

| Path | Message |
| --- | --- |
| `<id>.preset` | `must be one of ollama, ollama-cloud, lmstudio, llamacpp, vllm, openai, azure-openai, openrouter, groq, mistral, deepseek, together, fireworks, xai, anthropic or gemini` |
| `<id>.protocol` | `is required without a preset` |
| `<id>.protocol` | `must be openai-compatible, anthropic, gemini, ollama or claude-code` |
| `<id>.protocol` | `must be <protocol>, the protocol of the <preset> preset`, for a protocol other than the preset's |
| `<id>.baseUrl` | `is required without a preset`, for a protocol other than `claude-code`, which has no base URL |
| `<id>.baseUrl` | `is required: the azure-openai preset has none` |
| `<id>.baseUrl` | `must be a string`, for a base URL that is set to anything else, `null` and a `String` object included |
| `<id>.maxTokensField` | `is only for the openai-compatible protocol` |
| `<id>.args`, `<id>.command` | `is only for the claude-code protocol` |
| `<id>.model` | `is required`, for a model that is unset |
| `<id>.model` | `must be a model id of visible ASCII characters, with no space` |
| `<id>.model` | `runs tools on the server by itself, which quorum never allows` |

## The shared options

These are the options of the four HTTP adapters. `claudeCode` takes `id`, `model`, `contextTokens`, `apiKey` and `structuredOutput`, with its own rules, refuses the rest, and has options of its own: [Claude Code options](#claude-code-options).

### Options

| Option | Type | Default | Does |
| --- | --- | --- | --- |
| `id` | `string` | Required | Names the provider in events, `meta` and its error messages |
| `baseUrl` | `string` | Required | An `http://` or `https://` URL with a host, and no user name, password, query or fragment. Requests go to it, its trailing slashes removed, followed by the adapter's path and the `query` |
| `model` | `string` | Required | The model every request names: in the body, or in the URL for `gemini` |
| `contextTokens` | `number` | Required | The model's context window in tokens, prompt and reply together. A request that may not fit it is refused before it is sent: [The size of a request](#the-size-of-a-request) |
| `apiKey` | `string` | None | Sent as `auth` says, and nowhere else. Without it, or with an empty one, no key header is sent |
| `auth` | `'bearer' \| 'x-api-key' \| 'none' \| { header, prefix? }` | The adapter's | How the key is sent: [The key header](#the-key-header) |
| `headers` | `Record<string, string>` | None | Sent with every request, names lower-cased. They cannot replace `content-type`, `content-length`, `host`, the key header, or `anthropic`'s `anthropic-version`. Their values are redacted from error messages, as the key is |
| `query` | `Record<string, string>` | None | Added to every request URL. Not redacted from error messages: never put a key here. A value equal to `apiKey` is refused |
| `extraBody` | `Record<string, unknown>` | None | JSON values deep-merged into the body last: objects merge key by key, anything else replaces. A top-level key cannot replace a field the adapter writes for the conversation, or set one that offers the model a tool: [The tool fields](#the-tool-fields). Nor can it set the reply limit, which `maxTokens` sets: [The size of a request](#the-size-of-a-request) |
| `temperature` | `number \| null` | The adapter's | Sent where the protocol takes it; `null` leaves it out, for a model that rejects it |
| `maxTokens` | `number` | None, but `anthropic`'s 16000; the size guard keeps 16000 for the reply when it is unset | The most tokens the reply may hold, in the protocol's own field |
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

### The size of a request

Some endpoints cut a prompt that is too long for the model in silence and still answer 200, and a review of text the model never read is worse than none. So every adapter requires `contextTokens`, and checks every request, research and vote alike, after shaping it and before sending it, and refuses one that may not fit:

- **The text** is the system text and every message as the adapter sends them (`systemPrompt: 'inline'` counts the blank line that joins them), at one token per UTF-8 byte, each code point at its longest form (as it is, decomposed with NFD, or compatibility-decomposed with NFKD), and the reply schema's JSON once more, since a server may add it to the prompt.
- **The chat template** takes 512 tokens, for what a server adds around the messages. `claudeCode` keeps 4096 instead, for the context Claude Code adds itself: [The size of a Claude Code request](#the-size-of-a-claude-code-request).
- **The reply** takes `maxTokens`, else 16000. Only `anthropic` sends that number when `maxTokens` is unset; the other adapters send no limit then, so for them it is room the guard keeps, not a cap the server applies.

A request is sent only when `text + 512 + reply <= contextTokens`. One token per byte bounds byte-level BPE and byte-fallback SentencePiece tokenizers. Counting each code point at its longest form bounds every normalized form of the text, so a tokenizer that normalizes with NFC, NFKC, NFD or NFKD first stays bounded: Qwen 2.5's NFC normalizer turns 300 bytes of U+0F81 into 500 tokens, which is why the count is not the raw bytes. Decomposition works one code point at a time and composing never lengthens UTF-8, so the sum is an upper bound, and the text is never normalized as a whole, which takes quadratic time on a long run of combining marks. Case folding is not proven covered, and no chat model's tokenizer is known to fold case. It costs room: accented letters count one more byte per accent, Hangul syllables up to three times their size, and code runs about three bytes to a token, so the guard accepts about a third of the diff that would really fit.

A request over the bound is not sent. The call fails with a `ProviderError` of kind `too-large`, which is not retryable, and its message holds the provider id and numbers only, never the text or the URL: `<id>: may need <n> tokens, more than contextTokens (<c>): <t> for its text at one token per byte, 512 for the chat template and <r> for the reply`. The review records it as a gap: [`ProviderError`](#providererror).

A provider with no `contextTokens` is refused when the adapter is called, before any request, whether or not a profile uses it: `<id>.contextTokens: is required: the model's context window in tokens, which quorum checks every request against`. No adapter is exempt, the hosted APIs that refuse an oversized prompt themselves included: on a vote that refusal is a failed vote, which `--allow-incomplete` lifts, and only a refusal quorum makes itself is kept out of the flag's reach. The CLI's resolution names where to set one instead: [Configuration](./20-configuration.md#the-context-size).

A `contextTokens` that leaves no room for a request, at most the reply budget and the 512 tokens, would refuse every request, so it is a configuration error when the adapter is called: `<id>.contextTokens: must be more than 16512, the 16000 tokens of the reply budget and 512 for the chat template`, the reply budget being `maxTokens` when it is set.

`extraBody` cannot set the reply limit. The guard reserves `maxTokens` for the reply, so a limit set there would send more than it reserved. Each adapter refuses these fields, in any letter case, and `maxTokens` sets the limit instead:

| Adapter | Refused fields |
| --- | --- |
| `openaiCompatible` | Both `max_tokens` and `max_completion_tokens`, whatever `maxTokensField` names |
| `anthropic` | `max_tokens` |
| `gemini` | `generationConfig.maxOutputTokens` |
| `ollama` | `options.num_predict` |

Each is a configuration error, `<id>.extraBody.<key>: sets the reply limit: use maxTokens`, where `<key>` is the field's path, such as `generationConfig.maxOutputTokens`. The key is matched as in [The tool fields](#the-tool-fields).

The guard does not count the text that `extraBody` adds to a request, such as a vLLM `chat_template`, and the 512 tokens do not cover what a server adds beyond them, such as an Ollama Modelfile's `TEMPLATE` or `SYSTEM`. It does not see a server-side switch that truncates a prompt either, which `extraBody` can turn on: vLLM's `truncate_prompt_tokens`, or OpenRouter's `transforms` with `middle-out`. Do not set one. It trusts the number it is given: a server that loads a smaller context than `contextTokens` can still cut a prompt in silence, which is why `ollama` is told the context it counts with, below.

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
| `<id>.headers.<name>` | `repeats a header name in another letter case` |
| `<id>.headers.<name>` | `must be a string of printable ASCII characters` |
| `<id>.query` | `must map names to strings` |
| `<id>.query.<name>` | `holds the key, which travels only in the header auth names` |
| `<id>.extraBody` | `must be an object of JSON values, with no __proto__ key` |
| `<id>.extraBody.<key>` | `is written by the adapter and cannot be replaced` |
| `<id>.extraBody.<key>` | `offers the model a tool, which quorum never does` |
| `<id>.extraBody.<key>` | `sets the reply limit: use maxTokens` |
| `<id>.temperature` | `must be a finite number, or null to leave it out` |
| `<id>.maxTokens` | `must be a whole number of at least 1` |
| `<id>.contextTokens` | `is required: the model's context window in tokens, which quorum checks every request against` |
| `<id>.contextTokens` | `must be a whole number of at least 1` |
| `<id>.contextTokens` | `must be more than <n>, the <r> tokens of the reply budget and 512 for the chat template` |
| `<id>.systemPrompt` | `must be native or inline` |
| `<id>.structuredOutput` | `must be prompt, json or schema` |
| `<id>.structuredOutput` | `must be prompt or schema` |
| `<id>.maxTokensField` | `must be max_tokens or max_completion_tokens` |
| `<id>.query.<name>` | `would carry a key in the URL: set apiKey instead` |
| `<id>.extraBody.generationConfig` | `must be written generationConfig` |
| `<id>.extraBody.generationConfig` | `must be an object` |
| `<id>.model` | `must be a Gemini model id, such as gemini-3.8-flash` |
| `<id>.extraBody.options` | `must be written options` |
| `<id>.extraBody.options.<key>` | `is set from contextTokens: set contextTokens instead` |
| `<id>.extraBody.options` | `must be an object` |

`headers` and `query` must be plain objects, an object literal or one with no prototype: a `Headers` or a `Map` is refused with `must map names to strings`, since its entries are not its own fields. A header name that repeats an earlier one in another letter case is refused at the later one, since one request cannot send both.

`is set by the adapter and cannot be replaced` names `anthropic`'s `anthropic-version`, in any letter case, as a header or as a custom `auth` header. `must be prompt or schema` is `anthropic`'s, whose protocol has no JSON mode, and `claudeCode`'s. `maxTokensField` is checked by `openaiCompatible` only, `model`, a `key` query parameter and an `extraBody.generationConfig` that is no object or is not spelled `generationConfig`, by `gemini` only, and `options.num_ctx` in `extraBody`, with an `extraBody.options` that is no object or is not spelled `options`, by `ollama` only. Both servers read the key in any letter case, and Gemini as `generation_config` too, so a second spelling would send two keys for the field the adapter merges into: `must be written <name>` names the one spelling, never the key it was given. A key that is no object has the one issue, `must be an object`. `sets the reply limit: use maxTokens` names a field by its path, `<id>.extraBody.generationConfig.maxOutputTokens` for one that is nested. `is required: ...` is the one issue of a `contextTokens` that is unset, and the two after it are the issues of one that is set. `must be more than <n>, ...` is checked against a valid `maxTokens` only, with `<r>` its value, else 16000, and `<n>` that and 512.

These are the checks of the four HTTP adapters; `claudeCode`'s are its own: [Claude Code configuration errors](#claude-code-configuration-errors). A config file's schema reads `auth` for every protocol, so its message for a value no protocol takes is `<path>.auth: must be bearer, x-api-key, none, inherit, login, api-key or { header, prefix }`, where an HTTP adapter given `inherit`, `login` or `api-key` by the builder says the `<id>.auth` message above.

A header name, an `extraBody` key or a `query` name is printed in a path only when it is a safe name, at most 64 ASCII letters, digits, `_`, `$` and `-`. Any other prints as `*`, since a secret pasted as a name would otherwise show.

## `openaiCompatible`

For any OpenAI-compatible `/chat/completions` endpoint. Ollama's `/v1` is one, and it cuts an oversized prompt in silence, which the size guard cannot see: for Ollama use [`ollama`](#ollama), which tells it the context size. The hosted provider of [The adapters](#the-adapters) sets `temperature: null` and `maxTokensField: 'max_completion_tokens'`, as the `openai` preset does, because OpenAI's reasoning models reject a `temperature`, and OpenAI deprecates `max_tokens` for every model.

| Option | Type | Default | Does |
| --- | --- | --- | --- |
| `maxTokensField` | `'max_tokens' \| 'max_completion_tokens'` | `'max_tokens'` | The body field of `maxTokens`, once `maxTokens` is set. OpenAI's reasoning models need `max_completion_tokens` |

The body of every request holds, in this order:

- `model` and `messages`: the request's messages, with the system text first as a `system` message, or inline at the head of the first user message;
- `response_format`, unless `structuredOutput` is `prompt`;
- `temperature`, unless it is `null`;
- `maxTokens` under `maxTokensField`, when set;
- then `extraBody`, merged. It cannot replace `model`, `messages` or `stream`, or set `max_tokens` or `max_completion_tokens`, which `maxTokens` sets.

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
- then `extraBody`, merged: `{ output_config: { effort: 'low' } }` goes beside the format in `schema` mode. It cannot replace `model`, `messages`, `system` or `stream`, or set `max_tokens`, which `maxTokens` sets.

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
- then `extraBody`, merged: `{ generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }` goes beside the rest. It cannot replace `contents` or `systemInstruction`, or set `generationConfig.maxOutputTokens`, which `maxTokens` sets. Its `generationConfig` must be an object, written `generationConfig`: another spelling, such as `generation_config`, would send a second key, so it is refused.

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

- **It is the CLI's built-in default.** With no provider configured and no base URL, preset or protocol variable for a role, that role talks to the Ollama on this machine through this adapter, at `http://localhost:11434`, which Ollama listens on, on `127.0.0.1`, by default; a role whose variables set a base URL without a preset or a protocol speaks `openai-compatible` to that URL, as before: [Layering](./20-configuration.md#layering). A panel with no voter variables shares the finder's provider: [The voter's fallback](./20-configuration.md#the-voters-fallback).
- **`truncate: false` keeps a prompt whole.** A prompt past the model's context is then a 400, `request (N tokens) exceeds the available context size (M tokens), try increasing it`, instead of its oldest messages dropped in silence. It needs Ollama 0.12.6 or later; an older server ignores the field and drops them.
- **`shift: false` keeps it whole as the reply is written.** A reply that fills the model's context then stops, as a truncation, instead of part of the prompt dropped so the reply can go on. It needs the same versions, and a server that loaded the model with context shift on loads it again, as it does each time a client asks for the other setting.
- **`num_ctx` from `contextTokens`.** The adapter sends `options.num_ctx`, so the server loads the context the size guard counts with; a larger value than the model's own maximum is cut to it, so keep `contextTokens` at most what `ollama show <model>` reports, and read the context a running model loaded in the `CONTEXT` column of `ollama ps`. `extraBody` cannot set `options.num_ctx`, in any letter case, or replace `options` with anything but an object, which would drop it. Its `options` must be written `options`: another spelling, such as `Options`, would send a second key, so it is refused.
- **The key goes as `Authorization: Bearer <key>`**, only when one is set: a local server needs none.
- **No `think` field.** A thinking model thinks as it does by default, and its thinking comes back apart, in `message.thinking`, which the adapter ignores. `extraBody: { think: false }` sets one: [Reasoning mode](../90-recipes/10-local-models.md#reasoning-mode).

The body of every request holds, in this order:

- `model` and `messages`: the request's messages, with the system text first as a `system` message, or inline at the head of the first user message;
- `stream: false`, `truncate: false` and `shift: false`;
- `options`: `temperature`, unless it is `null`, `num_predict`, when `maxTokens` is set, and `num_ctx`, always, from `contextTokens`;
- `format`: `'json'` in `json` mode, `<output.schema>` in `schema` mode;
- then `extraBody`, merged: `{ options: { seed: 7 } }` goes beside the temperature. It cannot replace `model`, `messages`, `stream`, `truncate` or `shift`, or set `options.num_ctx`, which `contextTokens` sets, or `options.num_predict`, which `maxTokens` sets. Its `options` must be an object.

A reply succeeds with `done: true`, the `done_reason` `stop` and a string `message.content`. The text is `message.content`, as it came: a `<think>` block left in it, by a model or a template Ollama cannot split, is for the core's reply parser to drop. `model` is the one the reply names, or the configured one; `usage` is read from `prompt_eval_count` and `eval_count`. A status outside 2xx is an `http` error that quotes Ollama's `{ "error": "<message>" }` body.

| The reply | Kind | Message |
| --- | --- | --- |
| A string `error` | `invalid-response` | `server error: "<message>"` |
| `done: true` and `done_reason` `length` | `truncated` | `reply was cut off by the token limit or the context`: with `shift: false`, a reply that fills the context ends as `length` too |
| No `done: true`, or a `done_reason` other than `stop` or `length` | `invalid-response` | `reply has not finished` |
| No string `message.content` | `invalid-response` | `reply has no text` |

## `claudeCode`

For your installed Claude Code CLI, which it runs once per request, headless and isolated, as a pure completion: no tool but the one that captures the reply, nothing loaded from your setup or from the checkout it runs in, the message on stdin, and in the default modes no key that quorum picks, holds or sets: it hands its environment to your own CLI, less the variables it removes. It needs a model, an alias or an id, and a context size, and it finds `claude` on `PATH`:

```ts
import { claudeCode } from '@tobi-or-not/quorum'

const code = claudeCode({ id: 'code', model: 'sonnet', contextTokens: 1000000 })
```

From the CLI, `QUORUM_RESEARCH_PROTOCOL=claude-code` builds it: [Claude Code](./20-configuration.md#claude-code). It requires Claude Code 2.1.311 or newer: [Stopping, nesting and the version](#stopping-nesting-and-the-version).

### What it runs

One process per request:

```text
claude -p \
  --output-format=json \
  --model=<model> \
  --system-prompt-file=<run>/system.txt \
  --tools '' --setting-sources '' --strict-mcp-config --no-session-persistence --disable-slash-commands \
  --json-schema=<the reply schema as JSON> \
  --bare \
  --effort=high
```

- **The order is fixed**, and nothing is optional but the last three lines: `--json-schema` only in `schema` mode, `--bare` only in `api-key` mode, then the allowlisted `args`, here `--effort high`.
- **Every value quorum or the config supplies is written `--flag=value`**, so no value is read as a flag, whatever it starts with. The two isolation flags with an empty value keep the two-argument form, `--tools ''` and `--setting-sources ''`, which is the one verified with Claude Code 2.1.311.
- **The system text goes in a file, the message on stdin and the key in the environment.** Linux caps one argument at 128 KiB, Windows a command line at 32,767 characters, and `ps` shows a command line to every user: nothing secret, and nothing long, is on it.
- **Each request has a directory of its own**, `quorum-claude-<random>` under the system's temporary directory, made at an absolute path though `TMPDIR` is relative: `cwd/`, the child's empty working directory, `tmp/`, where Claude Code keeps its scratch files, and `system.txt`, mode `0600`. It is removed once `claude` has exited, on every path, before the call settles, and when quorum itself exits while a run is live.
- **It is never run through a shell.** A `.cmd` or `.bat` file, which runs only through one, is refused; any other executable is run as it is.

### The isolation

Each measure of the command line and of the environment, and what it stops:

| Measure | What it stops |
| --- | --- |
| `--tools ''` | Every built-in tool: no shell, file or web tool. `--json-schema` adds one, which only captures the reply as structured output, and `structuredOutput: 'prompt'` leaves it out |
| `--setting-sources ''` | The user's, the project's and the local settings: their hooks, plugins, agents, `CLAUDE.md` files, permission rules and configured credentials |
| `--strict-mcp-config` | Every MCP server that is not named on the command line, which is none |
| `--no-session-persistence` | A transcript written to disk |
| `--disable-slash-commands` | Slash commands, as Claude Code documents the flag: its effect was not observed live. A message that starts with `/`, after white space, is refused before `claude` starts, since `-p` expands one as a slash command, and that refusal is the guard that is tested |
| An empty working directory | A `CLAUDE.md`, a `.claude/` directory or a `.mcp.json` of the pull request's checkout: `claude` never runs there |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Auto memory, which would load what an earlier run wrote |
| `DISABLE_COMPACT=1` | Summarizing a long prompt, which would shorten what the model reads (from Claude Code's documentation, not observed live) |
| `CLAUDE_CODE_TMPDIR=<run>/tmp` | Claude Code's scratch files outside the request's directory |
| `CLAUDE_CODE_AUTO_CONNECT_IDE=false`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` | An IDE connection and the claude.ai MCP connectors, which are on by default |
| `CLAUDE_CODE_DISABLE_ATTACHMENTS=1`, `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` | A file named in the message. A line such as `@/path/to/file` in the diff makes Claude Code attach that file for the model to read, with every tool off, and the model repeated a canary file's content that way (observed live with 2.1.311). With both set the model saw none. They are why an older Claude Code is refused: [Stopping, nesting and the version](#stopping-nesting-and-the-version) |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | Every `CLAUDE.md` file, the managed one included (from Claude Code's documentation, not observed live) |
| `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, `CLAUDE_CODE_DISABLE_POLICY_SKILLS=1` | The skills Claude Code bundles and the ones an organization's managed policy brings (from Claude Code's documentation, not observed live) |
| The parent session's variables, removed in every mode | `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EMIT_STARTUP_TIMING` and `CLAUDE_CODE_STARTUP_FAILURE_RESULTS`: a run nested in a Claude Code session does not inherit its messaging token or socket |
| The capability variables, removed in every mode | `CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDE_CODE_PLUGIN_SEED_DIR`, `CLAUDE_CODE_PLUGIN_CACHE_DIR`, `CLAUDE_CODE_SYNC_PLUGINS`, `CLAUDE_CODE_SYNC_SKILLS`, `CLAUDE_CODE_PROCESS_WRAPPER`, `CLAUDE_CODE_ENABLE_CFC`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, `CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_USE_POWERSHELL_TOOL`, `CLAUDE_CODE_EXTRA_BODY` and `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE`: they load plugins and skills, start every process through a wrapper, enable a tool, merge a JSON object into every request body or keep the session `--no-session-persistence` drops, and no flag governs them |
| A process group of its own | What `claude` starts: an abort stops the whole group, and so does quorum's exit, `process.exit` or a second interrupt included (not on Windows, which has none) |
| The request's directory removed | Its working directory, its scratch files and the system text. Claude Code may still write its own session files under `~/.claude` and to `~/.claude.json`, and a SIGKILL of quorum can leave the directory, with the inbox socket that `CLAUDE_CODE_TMPDIR` puts in it (unverified): [Claude Code, isolated](../30-security/10-threat-model.md#claude-code-isolated) |

Variable names are matched in any letter case, as Windows reads them. The credentials and endpoints that a mode removes are in [The auth modes](#the-auth-modes).

Not everything is off, and no flag of this list turns the rest off: an organization's managed settings, hooks and MCP servers may still load (its `CLAUDE.md` and skills, and the bundled skills, have variables that turn them off, unverified live on a managed machine), Claude Code adds its own context to every request, a run binds an inbox socket, in its own directory, and keeps registry files under `~/.claude`, and `inherit` applies no credential that a settings file configures. [Claude Code, isolated](../30-security/10-threat-model.md#claude-code-isolated) states each of them.

### Claude Code options

| Option | Type | Default | Does |
| --- | --- | --- | --- |
| `id` | `string` | Required | Names the provider in events, `meta` and its error messages |
| `model` | `string` | Required | What `claude --model` takes: an alias, `sonnet`, `opus`, `haiku` or `fable`, or a full model id, with `[1m]` after it (`opus[1m]`) for a 1M window on a 4.6 model. Visible ASCII, no space, and not starting with `-` |
| `contextTokens` | `number` | Required | The model's context window in tokens, prompt and reply together. It must be more than 20096: [The size of a Claude Code request](#the-size-of-a-claude-code-request) |
| `auth` | `'inherit' \| 'login' \| 'api-key'` | `'inherit'` | Whose credentials `claude` uses: [The auth modes](#the-auth-modes) |
| `apiKey` | `string` | None | `api-key` only: the key handed to `claude` as `ANTHROPIC_API_KEY`, in its environment and nowhere else. Without one, `api-key` keeps the environment's own `ANTHROPIC_API_KEY`. Refused under another mode |
| `structuredOutput` | `'prompt' \| 'schema'` | `'schema'` | `schema` has `claude` enforce the reply schema with `--json-schema`, and reads the reply from its structured output; `prompt` leaves the shape to the prompt, adds no tool, and reads the result's text |
| `args` | `readonly string[]` | None | Flags passed to `claude`: `--effort` (`low`, `medium`, `high`, `xhigh` or `max`), `--fallback-model`, `--max-budget-usd` (a positive decimal) and `--betas` (`api-key` only), each followed by its value or written `--flag=value`, each at most once. A value is visible ASCII that does not start with `-`. Any other element is refused by its index, and never repeated, so no option loosens the isolation |
| `command` | `string` | `'claude'` | The executable: an absolute path, or a bare name that `spawn` finds on `PATH`. A path with a separator that is not absolute is refused, since it would resolve inside the working directory, and so is a `.cmd` or `.bat` file, which runs only through a shell |
| `env` | `Record<string, string \| undefined>` | `process.env` | The environment `claude` inherits, less what its mode removes. Read once, when the provider is made |

`ClaudeCodeOptions` types them and `ClaudeCodeAuth` types `auth`. The options of an HTTP endpoint (`baseUrl`, `headers`, `query`, `extraBody`, `temperature`, `maxTokens` and `systemPrompt`) are refused: the reply budget is fixed at 16000, and there is no endpoint.

### The auth modes

| Mode | The child's environment | Use |
| --- | --- | --- |
| `inherit` | The environment as it is, less the variables every mode removes | Whatever `claude -p` finds on its own, from the environment: a cloud provider (Bedrock, Vertex or Foundry), a gateway, a key or a login. The default. Quorum hands the environment to `claude`, less the variables it removes, and reads the credential variables' values only to redact them from a quoted error: it stores and logs none, and sends them nowhere but the child |
| `login` | `inherit`'s, less `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_UNIX_SOCKET` and every variable whose name starts with `CLAUDE_CODE_USE_` | The Claude Code login, `/login`, or the `CLAUDE_CODE_OAUTH_TOKEN` of `claude setup-token`, which stays in the environment. It reaches Anthropic's own API unless a managed setting says otherwise |
| `api-key` | `login`'s, then `ANTHROPIC_API_KEY` set to the key, and `--bare` on the command line | An API key. Under `--bare`, Claude Code is documented to read no login, keychain or `CLAUDE_CODE_OAUTH_TOKEN`, even when one is in the environment, so the key is the credential, and to drop some of the context Claude Code adds; neither was observed live |

- **`ANTHROPIC_BASE_URL` goes under `login` and `api-key`**, since a login or a key sent through another host is what [the threat model](../30-security/10-threat-model.md#a-key-sent-only-to-its-own-endpoint) rules out. A gateway stays reachable through `inherit`. `ANTHROPIC_CUSTOM_HEADERS` goes because a header can carry another credential, and `ANTHROPIC_UNIX_SOCKET` because it sends every request through a local socket, as a base URL would. A `CLAUDE_CODE_USE_` prefix catches a cloud provider added later.
- **The key of `api-key`** is `apiKey`, else the environment's `ANTHROPIC_API_KEY`, trimmed. With neither, Claude Code has no credential and the call fails: the CLI's resolution refuses it earlier, [Claude Code](./20-configuration.md#claude-code).
- **A text that quotes `claude`'s output is redacted** of the values of the credential variables the child holds, as written and trimmed: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`, `ANTHROPIC_CUSTOM_HEADERS`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_AUTH_TOKEN`. A reply from `claude` can echo any of them.

### The size of a Claude Code request

The guard of [The size of a request](#the-size-of-a-request), with two differences. Claude Code adds its own context to every request, which 512 tokens do not cover: 953 tokens for a one-line prompt and 1463 with the schema tool's second turn, measured, so the reserve is 4096. And `maxTokens` is not an option, so the reply budget is 16000. A request is sent only when `text + 4096 + 16000 <= contextTokens`, so `contextTokens` must be more than 20096, or the provider is refused: `<id>.contextTokens: must be more than 20096, the 16000 tokens of the reply budget and 4096 for the chat template`. The text is counted as for an HTTP adapter, the reply schema's JSON included. A request that may not fit fails with `may need <n> tokens, more than contextTokens (<c>): <t> for its text at one token per byte, 4096 for the chat template and 16000 for the reply`.

- **The message is at most 10,000,000 bytes**, the smaller reading of the 10 MB that Claude Code reads on stdin, checked first: a larger one is `too-large` too.
- **Claude Code's own refusal of a prompt is `too-large`** as well. When it reports `terminal_reason: "prompt_too_long"`, or an error result (`is_error`) whose text starts `Prompt is too long`, a prompt the guard let through and Claude refused is the same `request-too-large` gap, which `--allow-incomplete` does not lift.
- **A long prompt is not summarized.** `DISABLE_COMPACT=1` is meant to keep Claude Code from compacting it, so that what the model reads is the prompt the guard counted; that is from Claude Code's documentation, and was not observed live.

### Claude Code replies and errors

`claude -p --output-format=json` prints one JSON object. Only the unknown-model error and two success runs were observed live: the shapes of a refusal, a reply cut off by the token limit, a prompt too long and an auth failure follow Claude Code's documentation. Claude Code reports an API error as exit `1` with that object on stdout, `subtype: "success"` and `is_error: true`, so the object is read before the exit code, in this order:

| The result | Kind | Message |
| --- | --- | --- |
| `terminal_reason` `prompt_too_long`, or an error result that starts `Prompt is too long` | `too-large` | `Claude Code refused the prompt as too long for the model's context` |
| `stop_reason` `refusal` | `refusal` | `model refused` |
| An error (`is_error` is not `false`, or `subtype` is not `success`) with an `api_error_status` from 400 to 599 | `http`, retryable as that status would be, so 429 and 5xx are | `HTTP 404 from the model API: "<up to 200 characters>"` |
| Any other error | `process`, with the exit code as `status` | `claude failed (error_max_structured_output_retries): "<up to 200 characters>"`, the subtype, or the `terminal_reason` of a `success` one, left out when it is not a short word |
| A signal ended `claude` after a success result | `process` | `claude was stopped by SIGTERM after its result` |
| A non-zero exit after a success result | `process` | `claude exited 1 after its result` |
| A tool the server ran: `usage.server_tool_use` or a model's `webSearchRequests` above 0 | `invalid-response` | `the server ran a tool for this reply, which quorum never allows` |
| A success result with `stop_reason` `max_tokens`, checked before the text | `truncated` | `reply was cut off by the token limit` |
| `schema` mode and no structured output, though no error is reported | `invalid-response` | `reply has no structured output`, or `reply structured output could not be serialized` |
| `prompt` mode and no `result` text | `invalid-response` | `reply has no text` |

Without a JSON result, a signal, a non-zero exit and an exit `0` with nothing are each a failure:

| What happened | Kind | Message |
| --- | --- | --- |
| A signal ended `claude` | `process` | `claude was stopped by SIGKILL` |
| A non-zero exit | `process` | `claude exited 2: "<up to 500 characters of stderr>"` |
| Exit `0`, and no JSON `result` object on stdout | `invalid-response` | `claude printed no JSON result` |
| More than 16 MiB on stdout | `invalid-response` | `reply is over 16 MiB` |

Before `claude` starts, and around it:

| What happened | Kind | Message |
| --- | --- | --- |
| A request that is not exactly one user message | `unsupported` | `takes a request of exactly one user message` |
| A message that starts with `/` after white space | `unsupported` | `a message that starts with / would run as a Claude Code command` |
| A message over 10,000,000 bytes | `too-large` | `the message is <n> bytes, more than the 10000000 Claude Code reads on stdin` |
| A request that may not fit the context | `too-large` | `may need <n> tokens, ...`: [The size of a Claude Code request](#the-size-of-a-claude-code-request) |
| The signal aborted | `aborted` | `request aborted` |
| A directory that cannot be made | `process` | `could not prepare a directory for claude (EACCES)`, the code left out when there is none |
| A `claude` that cannot start | `process` | `could not start the claude CLI (ENOENT)` |
| `claude --version` names a version below 2.1.311, or none | `process` | `Claude Code 2.1.311 or newer is required, found 2.1.310`, or `found an unknown version` when the version is not plain numbers: [Stopping, nesting and the version](#stopping-nesting-and-the-version) |
| `claude --version` does not answer within 10 seconds | `process` | `claude --version did not answer within 10 s` |

Every message starts with the provider id. A quoted text is cut, written as a JSON string and redacted, as an HTTP adapter's is, and stdout is read to 16 MiB and stderr to 64 KiB, the rest dropped.

- **`usage` is the sum over every model the result reports** in `modelUsage`: the input is every prompt token, cached ones included (`inputTokens`, `cacheReadInputTokens` and `cacheCreationInputTokens`), and the output every token generated. The result's own `usage` covers the last turn only, 2 input tokens against 1199 in a schema run, so its token counts are not read.
- **`costUsd` is `total_cost_usd`**, Claude Code's own estimate, when it is a number of at least 0.
- **`model` is the one that answered**: the single key of `modelUsage`, since `--fallback-model` can change it, else the configured one.
- **The text** is `structured_output` serialized in `schema` mode, and `result` in `prompt` mode.

### Stopping, nesting and the version

- **An abort sends SIGTERM to `claude`'s process group**, then SIGKILL `2000` ms later if it has not closed, and the call rejects as `aborted` once the directory is removed. Stdout past 16 MiB stops it the same way. When `claude` exits, SIGKILL goes to what is left of its group, since a helper that still holds its pipes would keep the call from settling, and `2000` ms after the exit its stdout and stderr are closed, so a helper that left the group (it called `setsid`) and holds them cannot keep the call from settling either: it is beyond quorum's reach and is left running. While a run is live, quorum's own exit sends SIGKILL to the group and removes the directory, which covers `process.exit` and a second interrupt but not a SIGKILL of quorum. Windows has no process groups, so there only `claude` is signalled, and the adapter is not tested there yet.
- **It runs inside a Claude Code session too.** `CLAUDECODE=1` in the environment does no harm, which was checked live, and the parent session's own variables are removed: [The isolation](#the-isolation).
- **One process per call.** The review's concurrency limit, 4 by default, bounds the calls in flight across every provider, so it bounds the `claude` processes too.
- **No timeout is set.** Claude Code retries a failed API call by itself, for minutes, and a deadline is the program's own `signal`.
- **The version: 2.1.311 or newer.** The isolation rests on environment variables that an older Claude Code does not know, and one it ignores is a file mention that is not turned off. So before its first request a provider runs `claude --version`, with the request's environment, from the request's empty directory and with the request's signal, and the result is kept for the life of the process, once per command. A version below 2.1.311, or an output that does not start with `<major>.<minor>.<patch>`, fails the request as `process`: `Claude Code 2.1.311 or newer is required, found 2.1.310`. The version is quoted only when each of its parts is at most four digits, else the message reads `found an unknown version`, so nothing else `claude` printed comes with it. It has 10 seconds to answer: past them its process group is stopped as an abort stops one (SIGTERM, then SIGKILL `2000` ms later), the request's directory is removed and the request fails with `claude --version did not answer within 10 s`. A check that failed is run again by the next request, and a request that waits for a check another request started aborts on its own signal, without stopping that check. A Claude Code that lacks one of the flags fails the run too, closed. `bun run live:claude-code` checks the adapter against the real `claude`. You run it by hand, with Claude Code installed and logged in, and neither `bun run test` nor CI does: it makes four calls on `haiku`, each capped by `--max-budget-usd 0.05`: structured output from a directory that holds a planted `CLAUDE.md`, which shows the child runs in an empty directory of its own and not in that one, one in `prompt` mode, one whose message names a canary file with a random token as `@<its absolute path>`, which fails if the token comes back, and one that names a model that does not exist. It passed against Claude Code 2.1.311, at under a tenth of a cent.

### Claude Code configuration errors

`claudeCode` checks its options when it is called, before any request, and throws one `ConfigError` with each problem, in this order. No message repeats a value: a key, a model id or an argument can be a secret.

| Path | Message |
| --- | --- |
| `<id>.baseUrl`, `<id>.headers`, `<id>.query`, `<id>.extraBody`, `<id>.temperature`, `<id>.maxTokens`, `<id>.systemPrompt` | `is not an option of the claude-code protocol` |
| `<id>.model` | `must be a model id of visible ASCII characters, with no space, that does not start with -` |
| `<id>.contextTokens` | `is required: the model's context window in tokens, which quorum checks every request against` |
| `<id>.contextTokens` | `must be a whole number of at least 1` |
| `<id>.contextTokens` | `must be more than 20096, the 16000 tokens of the reply budget and 4096 for the chat template` |
| `<id>.auth` | `must be inherit, login or api-key` |
| `<id>.apiKey` | `is set, but auth is not api-key, so it would never be sent` |
| `<id>.apiKey` | `must only contain visible ASCII characters` |
| `<id>.structuredOutput` | `must be prompt or schema` |
| `<id>.args` | `must be a list of strings` |
| `<id>.args.<index>` | `must be a string` |
| `<id>.args.<index>` | `is not a flag quorum passes to claude: use --effort, --fallback-model, --max-budget-usd or --betas` |
| `<id>.args.<index>` | `needs a value`, for a flag that ends the list |
| `<id>.args.<index>` | `repeats a flag` |
| `<id>.args.<index>` | `is only for auth: api-key`, for `--betas` |
| `<id>.args.<index>` | `must be low, medium, high, xhigh or max`, for `--effort` |
| `<id>.args.<index>` | `must be a positive number of dollars, such as 0.50`, for `--max-budget-usd` |
| `<id>.args.<index>` | `must be visible ASCII characters that do not start with -`, for `--fallback-model` and `--betas` |
| `<id>.command` | `must name an executable` |
| `<id>.command` | `is a Windows script, which runs only through a shell: name claude.exe instead` |
| `<id>.command` | `must be an absolute path, or a name to find on PATH` |

`<index>` is the index of the element in `args`, or of the value after a flag when the value is the problem. `--tools`, `--mcp-config`, `--settings`, `--add-dir` and `--dangerously-skip-permissions` are refused as any element outside the allowlist is, and `--effort=high --tools=Bash` in one element is refused as an `--effort` value: no `args` element loosens the isolation.

## `ProviderError`

Every failure of a shipped adapter's call is a `ProviderError`, the error class the core exports for any provider to use. Its message starts with the provider id, and the adapter never puts a request header, a key or the runtime's own error text in it: text a server or a model sent is quoted as a JSON string and cut short, and a key the server echoes, the base URL's path or a value of `headers` is replaced by `[redacted]` first. `claudeCode` quotes the text of `claude` the same way, redacted of the credentials its child holds.

| Field | Holds |
| --- | --- |
| `providerId` | The provider's id |
| `kind` | What went wrong, below |
| `status` | The HTTP status, for `http`. For a server error in an `openaiCompatible` 2xx reply, it is the status the body's `code` names. For a `claudeCode` `process` error that follows an exit of `claude` (a reported error, or `claude exited 2`), it is that exit code. A signal, a version that is too old, a start failure and a directory failure carry none |
| `retryable` | `true` for `network` and `timeout`, and for `http` with status 408, 409, 429 or 5xx: a caller may try the call again |
| `usage` | The counts of the reply the call failed on, `{ inputTokens, outputTokens, costUsd? }`, when the provider read one that reports them; `undefined` otherwise. The review counts them as the failed call's usage, in its `call` event and in `meta.usage` |

| Kind | Raised when |
| --- | --- |
| `http` | The endpoint answers with a status outside 2xx: `HTTP 503: "model is loading"`, quoting up to 500 characters of the body. A 3xx adds `(redirects are not followed)`: `HTTP 307 (redirects are not followed): "moved"`. Also an `openaiCompatible` server error in a 2xx reply whose `code` is an error status, and a `claudeCode` result that reports an API error with a status from 400 to 599: `HTTP 429 from the model API: "..."` |
| `network` | The request fails, `request to http://localhost:11434 failed (ECONNREFUSED)`, or reading the reply does, `reading the reply from <origin> failed` |
| `aborted` | The review's signal stopped the request, a `claude` run included: `request aborted` |
| `refusal` | The model refused, or a filter stopped the reply or the prompt: each adapter's reply table names its messages, and `claudeCode`'s is [Claude Code replies and errors](#claude-code-replies-and-errors) |
| `truncated` | The token limit or the model's context cut the reply off: `reply was cut off by the token limit`, `anthropic`'s `reply was cut off: the context window is full`, or `ollama`'s `reply was cut off by the token limit or the context` |
| `invalid-response` | The body is not JSON (`response body is not JSON`), is over 16 MiB (`reply body is over 16 MiB`) or is not an object (`reply is not a JSON object`), for every HTTP adapter. Or the reply holds an error, has not finished, ended early or holds no text, as each adapter's reply table words it. For `claudeCode`: a `claude` that printed no JSON result, a result with no reply or one that shows a tool the server ran, or more than 16 MiB on stdout (`reply is over 16 MiB`) |
| `too-large` | A request may not fit the model's context, and the provider refused it before sending it: `<id>: may need <n> tokens, more than contextTokens (<c>): ...`, with the numbers [The size of a request](#the-size-of-a-request) explains. Not retryable. The review records it as a `request-too-large` gap, on research and on a vote alike, and never fails on it. `claudeCode` adds a message over its 10,000,000-byte stdin cap, and Claude Code's own refusal of a prompt as too long, which are gaps too: [The size of a Claude Code request](#the-size-of-a-claude-code-request) |
| `process` | A `claude` that failed, exited or could not start: `claude exited 2: "..."`, `claude failed (...): "..."`, `could not start the claude CLI (ENOENT)`. Only `claudeCode` raises it |
| `unsupported` | `claudeCode` refuses a request that is not exactly one user message, or whose message starts with `/`. Only `claudeCode` raises it |
| `timeout` | Never: it is for other providers |

The core raises one more itself: a provider whose reply has no string `text` fails that call with `<id>: returned no reply text`, of kind `invalid-response`.

Quorum does not retry a call. A failed research call fails the review, unless it is a `too-large` refusal: the CLI exits `3`, and `review` rejects with the error. A failed vote is recorded in the vote's `error` and counts as a reject: [Failed votes](./50-lenses-and-policy.md#failed-votes).

## Writing a provider

Any object of the port's shape is a provider. It must:

- **return the model's raw text** in `text`, without parsing it: the core extracts and validates the JSON itself, and a reply it cannot use is a failed vote, or, for research, a failed review;
- **honour `request.signal`**, settling soon after it aborts: stopping a call in flight is cooperative, so a review that was aborted can wait for a provider that ignores its signal;
- **throw when the call fails**, a `ProviderError` with the closest `kind` for preference. A vote records the message of any `Error`, and the text of anything else thrown;
- **report `usage` only when it knows it**: `inputTokens` and `outputTokens`, and `costUsd` when it knows the price. It reports it on a reply it returns, and in the `usage` of the `ProviderError` it throws for a reply it read but cannot use, which the review counts as the failed call's;
- **check the size of its own requests**: quorum states no context size for a provider object and counts nothing for it. A provider that refuses a request as too large throws a `ProviderError` of kind `too-large`, which the review records as a `request-too-large` gap, on research and on a vote alike, instead of a failure: [`ProviderError`](#providererror). The review recognises the refusal by an own `kind` property of `'too-large'`, not by class, so one raised by a second copy of quorum counts too.

A provider can wrap another. Quorum sets no time limit on a call, so this one adds a limit to any provider that honours its signal, as the shipped adapters do, and reports a call that ran out of time as a `timeout`. It does not stop a provider that ignores its signal: it waits for that call to settle, however long it takes:

```ts
import { ollama, ProviderError } from '@tobi-or-not/quorum'
import type { Provider } from '@tobi-or-not/quorum'

/** The same provider, with every call stopped after `ms` milliseconds. */
function withTimeout(inner: Provider, ms: number): Provider {
  return {
    id: inner.id,
    model: inner.model,
    async complete(request) {
      const timeout = AbortSignal.timeout(ms)
      const signal = request.signal === undefined
        ? timeout
        : AbortSignal.any([request.signal, timeout])
      try {
        return await inner.complete({ ...request, signal })
      } catch (error) {
        if (!timeout.aborted || request.signal?.aborted) throw error
        throw new ProviderError({ providerId: inner.id, kind: 'timeout', message: `no reply within ${ms} ms` })
      }
    },
  }
}

const voter = withTimeout(ollama({
  id: 'voter',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.6:27b',
  contextTokens: 131072
}), 120_000)
```

A vote that runs out of time is then a failed vote, `voter: no reply within 120000 ms`, and a review aborted by its own signal still rejects with that signal's reason.

## Next

[Profiles](./40-profiles.md) — what a review looks for, the security profile, writing one of your own, gating and guidelines.
