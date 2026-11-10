# Configuration

The CLI is configured by six environment variables and nothing else: three for the finder's endpoint, `RESEARCH_*`, and three for the panel's, `VOTER_*`. There is no configuration file and no flag. This page lists the variables and their defaults, the rule by which the panel falls back to the finder's settings, the settings no variable changes, and the errors a bad value causes.

A program that uses quorum as a library builds its providers itself and reads none of these variables: [Providers](./30-providers.md).

## The variables

| Variable | Default | Sets |
| --- | --- | --- |
| `RESEARCH_BASE_URL` | `http://localhost:11434/v1`, Ollama's address | The finder's OpenAI-compatible endpoint. Requests go to the base URL, its trailing slashes removed, followed by `/chat/completions` |
| `RESEARCH_API_KEY` | None | The finder's key, sent as `Authorization: Bearer <key>`. Without a key, no `Authorization` header is sent |
| `RESEARCH_MODEL` | None: it is required | The finder's model, as the endpoint names it |
| `VOTER_BASE_URL` | `RESEARCH_BASE_URL` | The panel's endpoint |
| `VOTER_API_KEY` | `RESEARCH_API_KEY`, on the same endpoint only | The panel's key |
| `VOTER_MODEL` | `RESEARCH_MODEL`, on the same endpoint only | The panel's model |

Every value is trimmed, and a value that is empty or only whitespace counts as unset. On the finder's endpoint, then, the panel cannot do without the finder's key: an empty `VOTER_API_KEY` is unset, and falls back.

A local finder, and a panel on a hosted API:

```bash
export RESEARCH_MODEL=qwen3.6:27b
export VOTER_BASE_URL=https://api.mistral.ai/v1
export VOTER_MODEL=mistral-small-latest
export VOTER_API_KEY="$MISTRAL_API_KEY"
```

The `RESEARCH_*` variables never fall back to the `VOTER_*` ones.

## The voter's fallback

Each `VOTER_*` variable falls back to its `RESEARCH_*` counterpart only while the panel talks to the finder's endpoint, so that a key is only ever sent to the endpoint it was configured for:

| `VOTER_BASE_URL` | The panel's base URL | Its key | Its model |
| --- | --- | --- | --- |
| Unset | `RESEARCH_BASE_URL`, or its default | `VOTER_API_KEY`, else `RESEARCH_API_KEY` | `VOTER_MODEL`, else `RESEARCH_MODEL` |
| The same origin as `RESEARCH_BASE_URL` | `VOTER_BASE_URL` | `VOTER_API_KEY`, else `RESEARCH_API_KEY` | `VOTER_MODEL`, else `RESEARCH_MODEL` |
| Another origin, or no `http(s)` origin | `VOTER_BASE_URL` | `VOTER_API_KEY`, else no key | `VOTER_MODEL`, which is then required |

The origin is the scheme, the host and the port, compared once both URLs are parsed. Letter case, a default port written out (`:443` on `https`), one trailing dot after the host (`h.example.` is `h.example`) and the path never make another origin, so a gateway that serves several paths on one origin shares its key. `http` against `https`, or another port, does, so a fallback never carries a key from an encrypted connection to a cleartext one. A value without an `http(s)` origin, such as `localhost:11434/v1` without its scheme, or one that does not parse as a URL, inherits nothing, and then fails the base URL check below.

A panel on another endpoint must name its model. The finder's model name usually means nothing there, and an error before the review is better than a review in which every vote fails.

## One provider for the whole panel

The CLI builds two providers, named `research` and `voter`, and every lens of the security profile votes through the `voter` one: one endpoint and one model for the whole panel, as `meta.profiles.security.providers` records. A different provider per lens needs the [Library API](../95-reference/30-library-api.md), where the ports name one for each lens.

## Fixed settings

Both providers are built with `openaiCompatible` and its defaults, which no variable changes:

| Setting | Value |
| --- | --- |
| `auth` | `bearer`: a key is sent as `Authorization: Bearer <key>` |
| `temperature` | `0` |
| `structuredOutput` | `json`: every request asks for a JSON object with `response_format: { "type": "json_object" }` |
| `systemPrompt` | `native`: the instructions go in a `system` message of their own |
| `maxTokensField` | `max_tokens`, unused while no `maxTokens` is set |
| `maxTokens`, `headers`, `query`, `extraBody` | None is set: no token limit, no extra header, no query parameter and nothing merged into the body |

A model that rejects `temperature: 0`, or an endpoint without that JSON mode, cannot be used through these variables. OpenAI's reasoning models are among the models that reject `temperature: 0`, so the CLI cannot use them. A program builds its provider for a reasoning model with `temperature: null`, which leaves the field out, and `maxTokensField: 'max_completion_tokens'`, the body field that holds its `maxTokens` limit. It can also choose another `structuredOutput`: [the options of `openaiCompatible`](./30-providers.md#openaicompatible).

## Configuration errors

Each of these exits `2` with `Error:` and the message, instead of the banner and before any model call. No message repeats the value it is about: a base URL can carry credentials, and a key is a secret.

| Message | Cause |
| --- | --- |
| `RESEARCH_MODEL: is not set` | No research model, for a blank diff too |
| `VOTER_MODEL: must be set when VOTER_BASE_URL has another scheme, host or port than RESEARCH_BASE_URL` | A panel on another origin without a model of its own |
| `research.baseUrl: must be an http:// or https:// URL with a host` | `RESEARCH_BASE_URL` is not an `http://` or `https://` URL with a host; a missing scheme is the usual slip |
| `research.baseUrl: must not hold a user name or password: send a key with apiKey` | `RESEARCH_BASE_URL` holds a user name or a password. The CLI sends a key only from `RESEARCH_API_KEY`, as `Authorization: Bearer <key>` |
| `research.baseUrl: must not hold a query or a fragment` | `RESEARCH_BASE_URL` holds a `?` or a `#`; quorum appends the endpoint's path to the base URL |
| `research.apiKey: must only contain visible ASCII characters, which an HTTP header can carry` | `RESEARCH_API_KEY`, once trimmed, holds a space, a control character or a character outside ASCII |
| `voter.baseUrl: must be an http:// or https:// URL with a host` | The same, for the panel's base URL |
| `voter.baseUrl: must not hold a user name or password: send a key with apiKey` | The same, for the panel's base URL and its key, `VOTER_API_KEY` |
| `voter.baseUrl: must not hold a query or a fragment` | The same, for the panel's base URL |
| `voter.apiKey: must only contain visible ASCII characters, which an HTTP header can carry` | The same, for the panel's key |

A server behind basic auth refuses a bearer key, so the CLI cannot reach it. A program can: it sets `auth: { header: 'authorization', prefix: 'Basic ' }` and passes the base64 of `user:password` as `apiKey`, as [The key header](./30-providers.md#the-key-header) shows.

The finder's settings are checked first, then the panel's, and for each the base URL and the key come before the model, so only the first role with a problem is reported. Its base URL and its key problems are reported together, one per line:

```text
Error: research.baseUrl: must be an http:// or https:// URL with a host
research.apiKey: must only contain visible ASCII characters, which an HTTP header can carry
```

## Next

[Providers](./30-providers.md) — what a provider is, the shipped adapters, the `openaiCompatible` options this wiring leaves at their defaults, their errors, and writing a provider of your own.
