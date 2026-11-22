# Configuration

The CLI reads its settings from three sources, each laid over the one before: the built-in defaults, a config file the CLI is named, and the environment. The flags come last: `--config` names the file, `--profile` chooses which profiles run and `--fail-on` sets fail-on levels. With no file named, `QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS` set, the defaults and those two variables are enough: the CLI reviews against Ollama on this machine, through its native API. This page covers the config file, how to name it, how the layers combine, the `QUORUM_*` variables, the voter's fallback, the context size, the files to exclude, the held files to send, the limits of a review, running Claude Code, the keys, the trust a named config needs in CI, and the errors a bad setting causes.

A program that uses quorum as a library builds its providers itself, as [Providers](./30-providers.md) shows, or has `loadConfig` and `fromConfig` read the same settings: [`loadConfig` and `fromConfig`](../95-reference/30-library-api.md#loadconfig-and-fromconfig).

## A config file

A config file sets what the variables cannot: several providers, a different provider for a lens, every option of an adapter, and profiles of your own. Its extension chooses its format:

| Extension | Format | What it may hold |
| --- | --- | --- |
| `.yaml`, `.yml` | YAML 1.2 | Data only. A provider names the variable that holds its key in `apiKeyEnv` and never holds one: `apiKey` is refused as `is not a known field` |
| `.json` | JSON | The same, as JSON |
| `.mts`, `.mjs`, `.ts`, `.js` | A module whose default export is the config | Code: the file runs when quorum loads it, and a provider may hold its key in `apiKey`, or be an object that implements `Provider` |

A file is a regular file of at most 1 MiB, in UTF-8. A YAML file may not use an alias, a repeated key or a YAML 1.1 tag such as `!!binary`, and a JSON file may not repeat a key. Every object of a config is strict, so a field quorum does not know is an error, not an ignored line. This config puts the finder on a local model and the panel on a company gateway, and adds two profiles: `payments`, which extends the built-in `security` profile with a research prompt of its own, and `naming`, a profile of its own that never gates:

```yaml
# yaml-language-server: $schema=../quorum/schema/quorum.schema.json
version: 1
providers:
  local:
    preset: ollama
    model: qwen3.6:27b
    contextTokens: 131072
  gateway:
    protocol: openai-compatible
    baseUrl: https://llm.corp.example/v1
    model: review-1
    contextTokens: 200000
    apiKeyEnv: GATEWAY_KEY
roles:
  research: local
  voter: gateway
profiles:
  payments:
    extends: security
    prompts:
      research:
        file: ./prompts/payments.md
  naming:
    failOn: none
    prompts:
      research:
        file: ./prompts/naming.md
      vote: |
        One vote in a {{panel.size}}-voter panel on a naming finding. Lens: {{lens.id}}.
        {{lens.question}}
        Judge only from the blocks you receive. Default keep=false unless convinced.
    lenses:
    - id: meaning
      question: Does the name say something the code does not do?
    policy:
      high: any
      medium: off
```

- **`providers`** names each endpoint, by a name of lower-case letters, digits, `_` and `-`, which starts with a letter. A provider starts from a [preset](./30-providers.md#presets), or from a `protocol` and a `baseUrl`, and sets the [options](./30-providers.md#options) of its adapter: its `contextTokens` ([The context size](#the-context-size)), `auth`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField`, `systemPrompt`, `stream` ([Streaming](./30-providers.md#streaming)), `timeoutMs`, `stallTimeoutMs` and `retries` ([Deadlines and retries](./30-providers.md#deadlines-and-retries)). One with `protocol: claude-code` runs your Claude Code CLI instead, has no base URL, and sets `args` besides: [Claude Code](#claude-code).
- **`roles`** says which provider researches and which votes. A profile's own `roles`, and a lens's `provider`, override them.
- **`profiles`** defines the review profiles: [Profiles](./40-profiles.md), [Lenses and policy](./50-lenses-and-policy.md) and [Prompts](./60-prompts.md) say what each field means. A prompt is a string, or `{ file }`: the file's text. A prompt file resolves against the directory of the config file, whatever the working directory is, and holds at most 64 KiB, and the prompt files of a config 1 MiB in all. A profile's `failOn` is the confidence at or above which its kept findings fail the review with exit `1`, `high` when unset, and `none` for a profile that reports and fails nothing; the deprecated `gating` reads as `high` for `true` and `none` for `false`, with a warning: [Gating](./40-profiles.md#gating).
- **`exclude`** lists the files every review leaves out, as path patterns: [Excludes](#excludes).
- **`send`** lists the files to send the models though they are held back as secrets, each a path as the diff writes it: [Sending a held file](#sending-a-held-file).
- **`partTokens`** bounds the diff text one research request of a large change holds, 32768 when unset: [Research in parts](#research-in-parts).
- **`concurrency`** pins how many provider calls run at once in a review, shared by every provider. Unset, each provider has a lane of its own that follows its rate-limit headers: [The calls at once](#the-calls-at-once).
- **`maxReviewTokens`** and **`reviewTimeoutMs`** bound one review: the most tokens it spends, 2000000 when unset, and its deadline in milliseconds, 1800000 when unset. `QUORUM_MAX_REVIEW_TOKENS` and `QUORUM_REVIEW_TIMEOUT_MS` set them over the file's: [The limits of a review](#the-limits-of-a-review).

The JSON Schema in [`schema/quorum.schema.json`](../../schema/quorum.schema.json) lets an editor check and complete a YAML or JSON config. A YAML file names it in a comment on its first line, `# yaml-language-server: $schema=<path or URL of the schema>`, as the example does with the path of a clone beside the directory that holds the config, or `./node_modules/@tobi-or-not/quorum/schema/quorum.schema.json`, the copy the npm package ships, when the package is installed in the project that holds the config; a JSON file names it in its `"$schema"` field. Quorum itself ignores both.

A TS or JS config types its object with `import type` and `satisfies`, which Node and Bun erase when they load the file. This one is the same providers as above, with the gateway's key read from the environment by code:

```ts
// quorum.config.mts
import type { QuorumConfig } from '@tobi-or-not/quorum'

export default {
  providers: {
    local: { preset: 'ollama', model: 'qwen3.6:27b', contextTokens: 131072 },
    gateway: {
      protocol: 'openai-compatible',
      baseUrl: 'https://llm.corp.example/v1',
      model: 'review-1',
      contextTokens: 200000,
      apiKey: process.env.GATEWAY_KEY,
    },
  },
  roles: { research: 'local', voter: 'gateway' },
} satisfies QuorumConfig
```

Name the file `.mts` or `.mjs`: the extension makes it an ES module whatever the nearest `package.json` says, where `export` in a `.ts` or `.js` file of a package whose `package.json` says `"type": "commonjs"` is a syntax error. Node strips erasable TypeScript only, so a config holds no `enum`, `namespace` or parameter property. The import is erased when the file loads, so it matters to the editor alone, and a global install of the package runs the config as it is. The editor resolves the types when the package is installed in the project that holds the config, for example as a dev dependency. [Config types](../95-reference/30-library-api.md#config-types) lists every field.

Prefer `apiKeyEnv` to `apiKey: process.env.GATEWAY_KEY`, even in code: a variable that is not set is an error with `apiKeyEnv`, while `apiKey: undefined` is an unset field, and the review runs without a key.

## Naming the file

A config file is read only when it is named: `--config <path>`, else the variable `QUORUM_CONFIG`. The flag wins over the variable, and a blank `QUORUM_CONFIG` is unset.

`--config` is named for one command, so its path may be relative, and a relative path resolves against the working directory. `QUORUM_CONFIG` must be an absolute path: a relative one is refused with `Error: QUORUM_CONFIG: must be an absolute path` and exit `2`, even when `--config` is also given. A variable is set once, in a shell profile or for a whole CI job, and a relative path in it would resolve inside whatever checkout quorum runs in. In CI that checkout is the pull request's, so the file it names would be the pull request's own, which is the search that quorum never makes.

```bash
quorum --config ./quorum.yaml ./my.diff
QUORUM_CONFIG=/home/me/.config/quorum.yaml quorum ./my.diff
```

Nothing is ever searched for. A `quorum.config.yaml`, a `quorum.yaml` or a `quorum.config.mts` in the working directory, or above it, is not read unless a flag or the variable names it. In CI the working directory is a pull request's checkout, which the pull request's author writes, and a file found there would be an attacker's: [Trust](#trust). A local user sets `QUORUM_CONFIG` once to an absolute path, in a shell profile or an environment manager, or passes `--config`.

## Layering

Each layer sits over the one before it:

1. **The built-in defaults.** A config that defines no provider gets one named `default`, with the adapter's own defaults and no model, and this rule: with no provider configured and no base URL, preset or protocol variable for a role, that role talks to the Ollama on this machine through its native API, `http://localhost:11434` ([`ollama`](./30-providers.md#ollama)); a role whose variables set a base URL without a preset or a protocol speaks `openai-compatible` to that URL, as before ([`openaiCompatible`](./30-providers.md#openaicompatible)). A panel with no voter variables shares the finder's provider: [The voter's fallback](#the-voters-fallback). `http://localhost:11434` is where Ollama listens, on `127.0.0.1`, by default. The native API is the default because it tells Ollama the context size and makes it refuse an overflow, where Ollama's OpenAI-compatible `/v1` cuts an oversized prompt in silence. Refusing needs Ollama 0.12.6 or later: an older server ignores `truncate: false` and `shift: false`, and cuts the prompt in silence too ([`ollama`](./30-providers.md#ollama)). Without a file, then, `QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS` are the two settings the CLI requires, and `no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` and `no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens` are the errors without them, the model's first. A config that defines providers has no `default` one, and a provider of its own with no model is `providers.<name>.model: is required`, with no context size `providers.<name>.contextTokens: is required: ...` ([The context size](#the-context-size)).
2. **The file**, when one is named: its providers, roles and profiles.
3. **The environment.** The `QUORUM_*` variables of a role set fields of the provider that role is bound to, and `QUORUM_MAX_REVIEW_TOKENS` and `QUORUM_REVIEW_TIMEOUT_MS` set the review's limits: [The environment variables](#the-environment-variables). A variable never changes a provider object that a TS or JS config defines: it is an error.
4. **The flags.** `--config` names the file, `--profile` chooses the profiles, and `--fail-on` sets their fail-on levels over the file's.

The roles bind a provider to the finder and to the panel. One provider binds both. Several providers need `roles.research`, or the config is refused, and `roles.voter` is `roles.research` when it is unset.

The profiles that run are the ones `--profile` names, else the ones `QUORUM_PROFILES` names, else every profile the file's `profiles` defines, else the `security` profile alone. A file that defines `profiles` therefore runs those and no other: list `security` as well to keep it. A profile named `security`, or one with `extends: security`, starts from the built-in profile and replaces its prompts and policy levels one at a time and its lenses as a whole; any other profile needs both prompts and its lenses. A profile of the file that no selection names is still checked, as is every provider, so a broken definition fails every run.

## The environment variables

| Variable | Sets |
| --- | --- |
| `QUORUM_CONFIG` | The config file to read, when `--config` does not name one. It must be an absolute path |
| `QUORUM_PROFILES` | The profiles that run: ids separated by commas, each a profile the config defines or a built-in one, none twice. `--profile` wins over it, and a malformed value is refused even then |
| `QUORUM_PROGRESS` | How stderr shows the review, when `--progress` does not name a mode: `auto`, `live`, `plain`, `json` or `none` (`auto` by default): [The modes](./10-cli.md#the-modes). The CLI reads it, so a library program ignores it. A blank value is unset, a value that is no mode is a usage error, and `QUORUM_PROGRESS=plain` set once in a shell profile is the screen-reader mode |
| `QUORUM_RESEARCH_PRESET`, `QUORUM_VOTER_PRESET` | A role's provider, built from a [preset](./30-providers.md#presets) |
| `QUORUM_RESEARCH_PROTOCOL`, `QUORUM_VOTER_PROTOCOL` | A role's provider, built from a wire protocol: `openai-compatible`, `anthropic`, `gemini` or `ollama`, or `claude-code` for your installed Claude Code CLI: [Claude Code](#claude-code) |
| `QUORUM_RESEARCH_BASE_URL`, `QUORUM_VOTER_BASE_URL` | The base URL of a role's provider. Requests go to it, its trailing slashes removed, followed by the adapter's path, `/chat/completions` for `openai-compatible` and `/api/chat` for `ollama` |
| `QUORUM_RESEARCH_MODEL`, `QUORUM_VOTER_MODEL` | The model of a role's provider, as its endpoint names it |
| `QUORUM_RESEARCH_CONTEXT_TOKENS`, `QUORUM_VOTER_CONTEXT_TOKENS` | The context window of a role's provider's model, in tokens: a whole number from 1 to 999999999. It has no deprecated alias |
| `QUORUM_RESEARCH_TIMEOUT_MS`, `QUORUM_VOTER_TIMEOUT_MS` | The deadline of one attempt of a role's provider, in milliseconds: a whole number from 1000 to 86400000. Unset, it grows with the attempt's reply budget, from 600000 up to a day: [The deadline of an attempt](./30-providers.md#the-deadline-of-an-attempt). On a `claude-code` provider it is Claude Code's wait for each attempt's response headers, and the whole run's deadline is that times the retries plus one: [Stopping, nesting and the version](./30-providers.md#stopping-nesting-and-the-version). It has no deprecated alias |
| `QUORUM_RESEARCH_STALL_TIMEOUT_MS`, `QUORUM_VOTER_STALL_TIMEOUT_MS` | How long a streamed attempt of a role's provider may show no progress before it fails as a timeout, in milliseconds: a whole number from 1000 to 86400000. Unset, the window is learned from the provider's own streams: [The stall window](./30-providers.md#the-stall-window). It has no deprecated alias, and a `claude-code` provider refuses it |
| `QUORUM_RESEARCH_RETRIES`, `QUORUM_VOTER_RETRIES` | How many times a call of a role's provider that failed in passing is tried again: a whole number from 0 to 5. It has no deprecated alias |
| `QUORUM_RESEARCH_STREAM`, `QUORUM_VOTER_STREAM` | Whether a role's provider streams its replies: `true` or `false`, written exactly, and nothing else. `true` pins the stream and `false` asks for whole replies, as the `stream` field does; unset, the provider streams and steps down by itself when a server refuses: [Streaming](./30-providers.md#streaming). It has no deprecated alias |
| `QUORUM_RESEARCH_THINKING`, `QUORUM_VOTER_THINKING` | The thinking of a role's provider: `off` or `low`, sent as its protocol's own control: [Thinking](#thinking). It has no deprecated alias |
| `QUORUM_RESEARCH_API_KEY`, `QUORUM_VOTER_API_KEY` | The key of a role's provider, sent in the header its `auth` names, `Authorization: Bearer <key>` by default. Without a key, no key header is sent |
| `QUORUM_CLAUDE_CODE_COMMAND` | The `claude` executable of every `claude-code` provider a profile uses: an absolute path, or a name found in the absolute entries of `PATH`. A relative path and a `.cmd` or `.bat` file are refused. It wins over a code config's `command`, which a YAML or JSON config cannot hold: [Where the command comes from](#where-the-command-comes-from) |
| `QUORUM_MAX_REVIEW_TOKENS` | The review's token cap: a whole number of tokens from 1 to 9007199254740991, over the config's |
| `QUORUM_REVIEW_TIMEOUT_MS` | The review's deadline, in milliseconds: a whole number from 1000 to 86400000, over the config's |
| `RESEARCH_BASE_URL`, `RESEARCH_API_KEY`, `RESEARCH_MODEL`, `VOTER_BASE_URL`, `VOTER_API_KEY`, `VOTER_MODEL` | Deprecated aliases: each is read as the `QUORUM_` variable of the same name |

- **The research variables** set the provider `roles.research` names. A voter or a lens that shares that provider inherits what they set, and the `QUORUM_RESEARCH_*` variables never fall back to the voter ones.
- **The voter variables** set the provider `roles.voter` names when it is another provider than the finder's. When the panel shares the finder's provider, they derive a provider of their own: [The voter's fallback](#the-voters-fallback).
- **`QUORUM_CLAUDE_CODE_COMMAND` belongs to no role.** It names the executable of every `claude-code` provider, whichever role it serves, and is never read from a data file.
- **`QUORUM_MAX_REVIEW_TOKENS` and `QUORUM_REVIEW_TIMEOUT_MS` belong to no role either.** They bound the whole review, and come only from the config a run names and the environment, never from the change: nothing in a pull request sets them. Each is read as strictly as a role's numbers, in decimal digits with no sign and no leading zero, and wins over the config's field of the same meaning.
- **The deprecated aliases** still work, with one `warning:` line that names every alias that is set and the variable to set instead, such as `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead`. When both forms are set, the `QUORUM_` one wins. A preset and a protocol have no alias.
- **A preset or a protocol variable builds the role's provider afresh.** `QUORUM_RESEARCH_PRESET=anthropic` is not merged into a provider whose protocol it would contradict: the finder's provider is then a provider of that preset, from the role's variables alone. A base URL, a model, a context size, a deadline, a retry count and a key variable alone override the fields of the provider they reach.
- **A base URL variable on its own means an `openai-compatible` server.** With no provider in a file, `QUORUM_RESEARCH_BASE_URL=http://gpu:8000/v1` makes the `default` provider `openai-compatible` at that URL ([Layering](#layering)). To reach Ollama's native API at another address, name the protocol with the URL, `QUORUM_RESEARCH_PROTOCOL=ollama` with `QUORUM_RESEARCH_BASE_URL=http://gpu:11434`, since a base URL alone is `openai-compatible`: at Ollama's root, without `/v1`, it posts to `/chat/completions` and gets a 404. A provider a config file defines keeps the protocol it names, whatever a base URL variable says.
- **A context size belongs to one model on one endpoint.** A role's preset, protocol, base URL or model variable drops the context size of the provider it sets, unless `QUORUM_<ROLE>_CONTEXT_TOKENS` sets one; a variable that sets only a key, a deadline or a retry count keeps it.
- **Every value is trimmed, and a blank one is unset**, so a variable that is empty or only whitespace never counts as a value.
- **A `QUORUM_` variable that quorum does not read** is one `warning:` line, `QUORUM_PROFILE is not a variable quorum reads`, which names every such variable, sorted, so a typo shows. No value is ever printed.

A local finder, and a panel on a hosted API:

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_RESEARCH_CONTEXT_TOKENS=131072
export QUORUM_VOTER_BASE_URL=https://api.mistral.ai/v1
export QUORUM_VOTER_MODEL=mistral-small-latest
export QUORUM_VOTER_CONTEXT_TOKENS=131072
export QUORUM_VOTER_API_KEY="$MISTRAL_API_KEY"
```

The panel names another endpoint and another model, so it states a context size of its own: the finder's would describe a model that is not the panel's.

## The voter's fallback

When the panel shares the finder's provider and a voter variable is set, the voter variables derive a provider named `voter` from it, and bind the panel to it. The derived provider keeps what is safe on its endpoint and drops what is not, so that a key, a header, a query parameter, a body field or a model of the finder's never reaches another origin:

| `QUORUM_VOTER_BASE_URL` | The voter's base URL | Its key | Its model | Its context size | The rest of the finder's provider |
| --- | --- | --- | --- | --- | --- |
| Unset | The finder's | `QUORUM_VOTER_API_KEY`, else the finder's key | `QUORUM_VOTER_MODEL`, else the finder's | `QUORUM_VOTER_CONTEXT_TOKENS`, else the finder's while the voter variables name no preset, protocol, base URL or model | All kept |
| The same origin as the finder's | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else the finder's key | `QUORUM_VOTER_MODEL`, else the finder's | `QUORUM_VOTER_CONTEXT_TOKENS` only | All kept |
| Another origin, or no `http(s)` origin | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else no key: a preset's own variable is not read | `QUORUM_VOTER_MODEL`, which is then required | `QUORUM_VOTER_CONTEXT_TOKENS` only | `apiKeyEnv`, `headers`, `query`, `extraBody` and the model are dropped; the preset, protocol, `auth`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField`, `systemPrompt`, `stream`, `timeoutMs`, `stallTimeoutMs` and `retries` are kept |
| `QUORUM_VOTER_PRESET` or `QUORUM_VOTER_PROTOCOL` is set | Its own, or the preset's | `QUORUM_VOTER_API_KEY`, else the preset's own variable at the preset's origin | `QUORUM_VOTER_MODEL`, which is then required | `QUORUM_VOTER_CONTEXT_TOKENS` only | None: the provider is built from the voter variables alone |

On the built-in `default` provider, a voter variable that sets a base URL with no preset or protocol makes the voter `openai-compatible`, at another origin than the finder's and at the same one too, such as `QUORUM_VOTER_BASE_URL=http://localhost:11434/v1` beside a finder on `http://localhost:11434`: the table says what the voter keeps, and the protocol it does not keep is the default's native one, which a base URL alone does not name. A voter that sets only a model, a context size or a key stays on the finder's endpoint and protocol. A finder whose own variables name a preset or a protocol is not the built-in default, and its voter inherits that protocol, as it does from a provider a file defines.

The deprecated `VOTER_BASE_URL`, `VOTER_API_KEY` and `VOTER_MODEL` fall back the same way, as `QUORUM_VOTER_*`. When `roles.voter` names another provider than the finder's, the voter variables set that provider's fields as the research variables set the finder's, and nothing falls back. A config that already defines a provider named `voter` cannot have one derived over it: rename it.

The voter never inherits the finder's context size for another model or another endpoint. A context size describes one model on one endpoint, so a voter variable that names a model, a base URL, a preset or a protocol leaves the voter without one until `QUORUM_VOTER_CONTEXT_TOKENS` sets it: the finder's window means nothing for a model that is not the finder's.

The origin is the scheme, the host and the port, compared once both URLs are parsed. Letter case, a default port written out (`:443` on `https`), one trailing dot after the host (`h.example.` is `h.example`) and the path never make another origin, so a gateway that serves several paths on one origin shares its key. `http` against `https`, or another port, does, so a fallback never carries a key from an encrypted connection to a cleartext one. A value without an `http(s)` origin, such as `localhost:11434/v1` without its scheme, or one that does not parse as a URL, inherits nothing, and then fails the base URL check: [Configuration errors](#configuration-errors).

A panel on another endpoint must name its model. The finder's model name usually means nothing there, and an error before the review is better than a review in which every vote fails.

A `claude-code` finder has no base URL, so it has no origin, and a panel the voter variables derive from it counts as being on another endpoint. It keeps the finder's `protocol`, `auth`, `args`, `structuredOutput` and `command`, and drops the key variable, the model and the context size, so `QUORUM_VOTER_MODEL` and `QUORUM_VOTER_CONTEXT_TOKENS` state them: `QUORUM_VOTER_MODEL=haiku` with `QUORUM_VOTER_CONTEXT_TOKENS=1000000` votes through the same CLI on another model. A panel in `api-key` mode reads `ANTHROPIC_API_KEY`, as any `claude-code` provider in that mode does.

## The context size

`contextTokens` is the model's whole context window in tokens, prompt and reply together: the number a vendor calls its context window or context length. Quorum checks every request against it before sending, and refuses one that may not fit, so that a prompt a server would cut in silence is never reviewed as if the model had read it. A research request that may not fit is split into parts that do ([Research in parts](#research-in-parts)); any other request that may not fit is refused, a `request-too-large` gap, which exits `4` for a gating profile whatever the flags: [Exit codes](./10-cli.md#exit-codes). [The size of a request](./30-providers.md#the-size-of-a-request) says how a request is counted.

Every provider defined as data, an HTTP one or a `claude-code` one, must state one, whether a profile that runs uses it or not, since every provider is checked: a provider without one is refused before any request, with exit `2` and a message that names what to set ([Configuration errors](#configuration-errors)). Even a hosted API that refuses an oversized prompt itself is held to it, since that refusal does less than the guard: on research it is a `research-failed` gap, exit `4`, or exit `3` when no research request of any profile answered, and on a vote it is a failed vote with no `request-too-large` gap, which only a refusal quorum makes itself records. A provider object, which a TS or JS config defines, states none: it is its author's code and checks its own requests ([Writing a provider](./30-providers.md#writing-a-provider)). The built-in `default` provider has none either, so `QUORUM_RESEARCH_CONTEXT_TOKENS` is required with it. A panel that shares the finder's provider, context size included, is reported by the finder's issue alone, whether the size is missing, malformed or leaves no room: the user wrote one value, and reads one line, at the place they set it.

A provider's context size comes from, in this order:

1. **The provider's `contextTokens`**, a whole number from 1 to 999999999, in the config file or in a code config.
2. **`QUORUM_RESEARCH_CONTEXT_TOKENS` or `QUORUM_VOTER_CONTEXT_TOKENS`**, which set the field of the role's provider as the other role variables do, over the file's. A value that is not a whole number from 1 to 999999999 written in decimal digits is refused at its variable, `32k`, `1e5` and `0x10` included.
3. **Nowhere else**: quorum does not read it from the endpoint or from a table of models.

A context size belongs to one model on one endpoint, so it never crosses to another: a role's variables that name a preset, a protocol, a base URL or a model drop the context size of the provider they set, unless they set one, and the derived voter does not inherit the finder's for another model or endpoint ([The voter's fallback](#the-voters-fallback)). A key variable alone keeps it.

[`--print-config`](./10-cli.md#printing-the-resolved-config) shows each provider's `contextTokens` after its `model`.

### Finding the number

The number is the window the server gives the model, which can be less than the model's maximum. [Local models](../90-recipes/10-local-models.md) says how to set the window of Ollama, vLLM and llama.cpp. Where to read it:

- **Ollama**, through its native API (the built-in provider's, and the `ollama` preset's), is sent `num_ctx` by quorum, so it loads the context you state. A `num_ctx` above the model's trained context is clamped to it, so keep `contextTokens` at most what `ollama show <model>` prints, and read the context a running model loaded in the `CONTEXT` column of `ollama ps`. On Ollama's `/v1`, which a base URL variable on its own, an `openai-compatible` protocol variable with its base URL or a provider of a file reaches, quorum cannot set it, and Ollama picks 4096, 32768 or 262144 tokens by the GPUs' memory, unless `OLLAMA_CONTEXT_LENGTH` or a Modelfile's `num_ctx` says otherwise: set `OLLAMA_CONTEXT_LENGTH` on the server to at least `contextTokens`, and trust `ollama ps`, since a Modelfile's `num_ctx` or the model's own default outranks the variable for `/v1` requests.
- **llama.cpp** splits the context its `-c` option sets across its `-np` slots unless the KV cache is unified, and a request gets one slot's share: state the per-slot `n_ctx` that `/props` reports.
- **vLLM** serves what its `--max-model-len` option sets.
- **LM Studio** serves the context length the model is loaded with, not the maximum it supports: its documentation shows a model loaded with 4096 tokens of the 262144 it takes.
- **A hosted API** states it on the model's page or on its models endpoint: `max_input_tokens` for Anthropic, `inputTokenLimit` for Gemini, `max_context_length` for Mistral, `context_length` for OpenRouter. Anthropic's and Gemini's are limits of the input alone, which is the safe side, since the guard keeps the room of the reply inside them.
- **An Azure deployment** has its own limit, which can differ from the documented one of its model.

A number above the real window defeats the guard, which counts against the number it is given. An endpoint that cuts a prompt in silence, Ollama's `/v1` or an OpenRouter endpoint of 8192 tokens or less among them, then answers as if it had read all of it. When in doubt, state the smaller number.

### What it counts, and what it costs

A request is counted at one token per byte of what it carries, each code point at its longest form (as it is, decomposed, or compatibility-decomposed), so that a tokenizer that normalizes with NFC, NFKC, NFD or NFKD first stays bounded. Case folding is not proven covered. Accented letters count one more byte per accent, and Hangul syllables up to three times their size. The count adds 512 tokens for the chat template (4096 for a `claude-code` provider, [The context size of Claude's models](#the-context-size-of-claudes-models)) and the request's reply budget ([Reply budgets](#reply-budgets)), and the request is sent only when the sum is at most `contextTokens`: [The size of a request](./30-providers.md#the-size-of-a-request) has the rule and the message of a refusal.

One token per byte is the price of a bound that holds for every tokenizer checked. Code runs about three bytes per token, so the guard accepts about a third of the diff that would really fit. The diff that a research request of the `security` profile leaves room for, as ASCII text with no guidelines, `maxTokens` and `thinking` unset and the default `systemPrompt: 'native'` (`inline` leaves 2 bytes less):

| `contextTokens` | The largest diff, in bytes | Before this release |
| --- | --- | --- |
| `8192` | 4,014 | refused |
| `16384` | 10,158 | refused |
| `32768` | 22,446 | 14,759 |
| `65536` | 47,022 | 47,527 |
| `131072` | 107,918 | 113,063 |
| `200000` | 176,846 | 181,991 |
| `1000000` | 976,846 | 981,991 |

A larger diff is reviewed in parts of at most that size, or of `partTokens` when it is smaller. A part's own request holds the parts block too, so a part takes a few hundred bytes less than the figure says.

Each row is `contextTokens` less 1,618 for the instructions, the fences, the reply schema and the line that asks for at most 50 findings, less 512 tokens for the chat template, less the research reply's budget, which a row's window gives as [Reply budgets](#reply-budgets) says: 21,024 from 131072 tokens up, 16,384 at 65536, 8,192 at 32768, 4,096 at 16384 and 2,048 at 8192. A `maxTokens` replaces that budget, so `maxTokens: 4096` at 32768 tokens adds 4,096 bytes to the row, and the guidelines of a profile take room of their own. A vote request carries the diff section of the cited file (the whole diff when the file has no section of its own), up to five lines of evidence and the claim, and reserves a vote's own, smaller budget, and when that section does not fit the voter's window, the hunks nearest the cited line: [Research in parts](#research-in-parts). A panel on a smaller model refuses sooner.

## Reply budgets

A reply takes room from the window, so each request reserves the room its reply needs, and no more. With `maxTokens` unset, quorum derives a reply budget for each kind of request from the provider's window, its `maxTokens` and its thinking level, and the research request asks for as many findings as its budget holds. A request used to reserve and send `maxTokens`, else 16000, whatever it was: a window of 32768 tokens gave half of it to a reply of a few dozen tokens, and a window of 16384 tokens or less refused every request.

With `W` the window, `M` the most findings a research reply is read for (`maxFindings`, 50 by default), and `T` the tokens the provider's thinking may take:

| Thinking | `T` |
| --- | --- |
| the server's own (`default`) | 8192 |
| `low` | 4096 |
| `off` | 0 |

- **A research reply** is given what its findings and its thinking need, and at most a quarter of the window: `min(M * 256 + 32 + T, W / 4)` tokens, rounded down. Three quarters of the window stay for the request. The 256 tokens are what one finding is assumed to take and the 32 the reply's envelope.
- **The findings it asks for** are what the budget holds once the thinking has taken its share, which is at most half of it: with `R` the budget and `T'` the lesser of `T` and `R / 2`, `N = max(1, min(M, (R - T' - 32) / 256))`, rounded down. The request says so in its system message, after the instructions and before the reply format: `List at most <N> findings, the most serious first. For each, quote the shortest verbatim span of the diff that shows it.` A reply that lists more is read as any reply is, up to `maxFindings`; the line is what is asked, not a cap.
- **A vote's reply** is given 1,024 tokens for its verdict and its reasoning, plus `T`, and at most a quarter of the window: `min(1024 + T, W / 4)`.
- **`maxTokens`, when set, is the ceiling of every reply.** A research request sends it as its budget, and a vote sends the lesser of it and the vote's own, so a large `maxTokens` set for research no longer reserves that much for every vote. `N` is then computed from it as above.

| `contextTokens` | Research reply | Findings asked | A vote's reply |
| --- | --- | --- | --- |
| `8192` | 2,048 | 3 | 2,048 |
| `16384` | 4,096 | 7 | 4,096 |
| `32768` | 8,192 | 15 | 8,192 |
| `65536` | 16,384 | 31 | 9,216 |
| `200000` | 21,024 | 50 | 9,216 |

The figures are for `maxTokens` unset and `thinking` default. With `maxTokens: 100000` on a window of 240000 tokens a research reply is given 100,000 tokens and asks for 50 findings, and a vote 9,216.

The allowances sit below OpenAI's advice of 25,000 tokens for reasoning and outputs, since quorum's replies are short. The 256 tokens of a finding are an assumption, not a measurement. The budgets are fixed for a review, computed when it starts: what a provider sends is its budget, at most `maxTokens`, and the research planner packs each part for the widest line, `N` at `maxFindings`, so a part always fits whatever `N` its request asks.

When a provider's calls are cut at a length it learned ([A gateway that cuts long calls](./30-providers.md#a-gateway-that-cuts-long-calls)), its research and vote budgets are `min` of the figures above and what the cut lets through, four fifths of the cut at the lowest pace the attempts cut at it streamed, at least 1,024 tokens, and `N` follows from the lowered research budget. A `maxTokens` you set is never lowered: the line says what to lower it to. The change is the `replyTokens` adaptation, from `derived` to the tokens held, recorded in `meta.adaptations` only when a derived budget of the provider is above what the cut lets through ([The adaptations](../95-reference/20-json-result.md#the-adaptations)).

A provider that states neither a window nor a `maxTokens`, a provider object of a library program that does not state them ([What a provider states](./30-providers.md#what-a-provider-states)), has nothing to size a reply by: its requests carry no budget, its reservation is the request's text plus 512 and 16000, as before, and its research asks for `maxFindings` findings. A `claude-code` provider is given its budget as Claude Code's limit on each reply ([The context size of Claude's models](#the-context-size-of-claudes-models)).

### Raising the limit knowingly

To review a larger diff, change what is true and state it, not what is counted:

- **Give the model a larger window, and state it.** On Ollama's native API, the built-in default's and the `ollama` preset's, raise `contextTokens` itself, up to what `ollama show <model>` prints: quorum sends it as `num_ctx`, and `OLLAMA_CONTEXT_LENGTH` matters for Ollama's `/v1` only. For `/v1` raise `OLLAMA_CONTEXT_LENGTH`, and for the other servers llama.cpp's `-c`, vLLM's `--max-model-len` or the context length LM Studio loads, then set `contextTokens` to the number the server really loads. A larger window costs the server memory.
- **Set `maxTokens`** to what the model needs to answer, when its replies are shorter than the budget quorum derives ([Reply budgets](#reply-budgets)). It is the ceiling of every reply: the server stops a reply there, and the reserve shrinks with it. A thinking model needs more, and a reply cut off at the limit is split and asked again in pieces, which costs calls: [Recovering a cut-off part](#recovering-a-cut-off-part). `maxTokens` is the one setting of the reply limit: `extraBody` cannot set `max_tokens` or its equivalents ([The size of a request](./30-providers.md#the-size-of-a-request)).
- **Review fewer commits at once**, so fewer parts are spent: quorum splits a diff that does not fit one request into parts, and leaves unreviewed only a hunk that no request of the window holds ([Research in parts](#research-in-parts)).

Two other ways are not offered, because each reopens the padding attack that [The size guard](../30-security/10-threat-model.md#the-size-guard) describes:

- **A bytes-per-token ratio.** Encoded content, such as base64, hex, CJK text or emoji, takes 1 to 1.5 bytes per token, so a pull request could pad past any ratio above one.
- **Lifting the gap with `--allow-incomplete`.** It would let the same padding through for a gating profile.

Neither of these is done today. Counting with a vendor's own tokenizer would shrink the margin, since one token per byte overestimates code about three times, so it would accept more of a diff. Reading the window from the endpoint would take the smaller of its number and yours, so it could only lower what is accepted. Neither would take the window past the number you state.

### What happens

A research request is split into parts first, so its profile records a `request-too-large` gap, counting the parts, only for a part its provider refused all the same, and a `too-large` gap for a hunk no part can hold, and the other profiles run. A refused vote is a failed vote ([Failed votes](./50-lenses-and-policy.md#failed-votes)), and its finding records a `request-too-large` gap as well, whatever its status: kept, discarded or `unreviewed`, the gap stays. A gating profile with such a gap exits `4`, even with `--allow-incomplete`, unless it also kept a finding at or above its fail-on level, `high` by default, which exits `1`; the gap of an advisory profile changes no code. The result says what was not sent: [Incomplete reasons](../95-reference/20-json-result.md#incomplete-reasons). A provider with no context size is a configuration error, exit `2`, before any request.

## Room accounting

The window holds three things besides the diff: the request's fixed text (the instructions, the fences, the reply schema, the line that asks for at most `N` findings and the guidelines), the chat template, and the reply's budget ([Reply budgets](#reply-budgets)). What is left is the room for the diff. A profile that leaves a provider less than 1,024 tokens of it, the least a hunk may need, would run every request into a `request-too-large` gap, so quorum refuses it when it is created, before any call, with exit `2`: [Exit codes](./10-cli.md#exit-codes).

Two requests are read, each over an empty diff, and each asks its provider's own `room`:

- **The research request** of the one-request research, with `N` at `maxFindings`, the widest its line can be. Its message names the profile and the provider's id, then the figures, which add up to the window:

  ```text
  profiles.security: the research request on local leaves -630 tokens for the diff, less than the 1024 a hunk may need: contextTokens 2000 counts 1618 for the instructions, guidelines and rules, 512 for the chat template and 500 for the reply: shorten the guidelines or rules, lower maxTokens, or state a larger window
  ```

- **The vote request for the longest finding**, the one the [estimate](../95-reference/30-library-api.md#estimate) bounds a vote by, whose fixed text is the instructions of one lens, the guidelines and a finding at its caps. Its message reads `the vote request on <provider> for the longest finding leaves <room> tokens for the diff, less than the 1024 a hunk may need: contextTokens <window> counts <fixed> for the instructions, guidelines and finding, <template> for the chat template and <reply> for the reply: shorten the guidelines, lower maxTokens, or state a larger window`. Each lens whose voter is refused is a line.

The fixed text is counted as the size guard counts it, one token per byte, and the template is what the provider's own room leaves of the window besides the other three, so its reserve is read and never assumed: 512, or 4,096 for a `claude-code` provider. A part's request carries the parts block too, whose size depends on the diff, so a part's room is printed under `budgets`, with no file listed, and refuses nothing. A provider that states no room, a provider object of a library program that does not state one or states a room and no `window`, is checked by nothing here; its own size guard still refuses each request that is too large.

To fix a refusal, lower what the message names: shorten the guidelines or the rules, lower `maxTokens` (the reply's budget is the largest term of a small window), or state a larger window if the server really loads one ([Finding the number](#finding-the-number)). The table in [What it counts, and what it costs](#what-it-counts-and-what-it-costs) shows what a window leaves.

### The budgets

[`--print-config`](./10-cli.md#printing-the-resolved-config) prints each profile's budgets under `budgets`, after `profiles`, and `Quorum.budgets` holds them as data ([Library API](../95-reference/30-library-api.md#budgets)):

```yaml
budgets:
  security:
    research:
      provider: local
      contextTokens: 131072
      replyTokens: 21024
      findings: 50
      findingsWithoutThinking: 50
      rooms:
        one: 107918
        part: 107606
      worstPart:
        tokens: 56234
        holds: 35
    lenses:
      reachability:
        provider: local
        contextTokens: 131072
        replyTokens: 9216
        room: 117322
```

`replyTokens` is the reply budget of a request of that kind and `findings` the `N` its research request asks for; `rooms.one` is the tokens of diff the one-request research may hold and `rooms.part` a part's; each lens's `room` is the vote's. `worstPart` is what the token cap reserves for a part that holds as much diff as its room and `partTokens` allow, the worst case of a part that lists no file, and `holds` how many of them `maxReviewTokens` holds. Where `partTokens` bounds the diff, the figure runs low and `holds` runs high, by the size of the file list a real part carries; where the room bounds it, both are exact. When that is fewer than 20, `warnings` says so: `the token cap of 2000000 holds the worst case of 16 research parts of local (120000 tokens each, maxTokens 100000): lower maxTokens, or raise maxReviewTokens`, since a large `maxTokens` makes each part reserve that much. A provider that states no room prints no `rooms`, `worstPart` or `room`.

## Thinking

A reasoning model can spend its whole reply on thinking, so a provider takes `thinking`, `off` or `low`, in a config file or in `QUORUM_RESEARCH_THINKING` and `QUORUM_VOTER_THINKING`:

```yaml
providers:
  local:
    preset: ollama
    model: qwen3.6:27b
    contextTokens: 32768
    thinking: off
```

- **Unset, the server's own default holds.** No control is sent, and the reply budget leaves room for the thinking a model does by default ([Reply budgets](#reply-budgets)). Quorum lowers it by itself, once, for the rest of a review, when a reply runs out of room while reasoning: [What quorum adapts by itself](#what-quorum-adapts-by-itself).
- **A value is sent as the protocol's own control**, with every request of the provider: `reasoning_effort` on `openai-compatible`, `output_config.effort` on `anthropic`, `generationConfig.thinkingConfig.thinkingLevel` on `gemini` and `think` on `ollama`. The table of values is in [Thinking](./30-providers.md#thinking) of the providers page.
- **An explicit value is never undone.** It sizes the reply budget too: `low` leaves 4096 tokens for thinking and `off` none, where the default leaves 8192.
- **A control in `extraBody` is explicit as well.** `extraBody` is merged last, so a provider that sets the protocol's control there thinks as that value says. Quorum cannot read it, so it sizes the budget as for the default's thinking. Setting `thinking` and the same control in `extraBody` is refused, since the two would disagree.
- **Two refusals,** when the provider is built: `off` on `anthropic`, whose models have no one setting that turns thinking off, and any `thinking` on `claude-code`, whose effort is `--effort` in `args`.
- **A value that is neither `off` nor `low` is refused**, never clamped: `QUORUM_RESEARCH_THINKING: must be low or off`, or `providers.local.thinking: must be one of off or low` in a file.

`--print-config` prints a provider's `thinking` when it sets one.

## What quorum adapts by itself

Quorum moves a setting by itself when a reply shows that it must, says so in one line, and never moves one you set. Each move holds for the rest of one review, and the next review starts from the provider's own settings again: nothing is learned across reviews, and nothing is saved.

| Adaptation | When | Turned off by |
| --- | --- | --- |
| Thinking lowered | A reply was cut off while it reasoned (`truncated`, `thinking`), or held only reasoning (`no-answer`, `thinking`) | `thinking` set, or the control in `extraBody` |
| Prompt mode | A reply in JSON mode was empty (`no-answer`, `empty`), or the server answered a 400 or 422 whose body names the structured-output field | `structuredOutput` set, or the field in `extraBody` |
| Stream without `stream_options` | The server answered a 400 or 422 whose body names `stream_options` | `stream` set (`true` or `false`) |
| Whole replies | The server answered a 400 or 422 whose body names `stream`, `streamGenerateContent` for `gemini`, or answered a streamed call with a whole reply | `stream` set (`true` or `false`) |
| Reply budgets per kind | Always | `maxTokens` ([Reply budgets](#reply-budgets)) |
| Reply budgets held to a cut | Two of its attempts were cut on the way at about the same length ([A gateway that cuts long calls](./30-providers.md#a-gateway-that-cuts-long-calls)) | `maxTokens` set, which stays and is named in the line; every derived budget already under what the cut lets through, which moves nothing |

- **Thinking lowered** goes to `low`, and to `off` on `ollama`, and on `openaiCompatible` under the `vllm` and `llamacpp` presets, whose chat templates may not know `low` and can fall back to maximum reasoning. The line is `api: thinking lowered to low for the rest of the review: a reply ran out of room while reasoning; set thinking to choose it yourself`, or `a reply held only reasoning` for the second cause. It is sent as the protocol's own control ([Thinking](./30-providers.md#thinking)), with every later request of the provider, votes included.
- **Prompt mode** moves a provider from `json` to `prompt`, for finder and voter alike: `api: structuredOutput moved to prompt for the rest of the review: a reply in JSON mode was empty; set structuredOutput to choose it yourself`, or `the server refused the request's JSON mode`. It starts only from automatic `json`: the mode a preset or a protocol gives when `structuredOutput` is unset. It never starts from `schema`, whose strict schema and verdict first are what a vote's independence rests on, nor from a mode you set, `json` included. Prompt mode gives up the server's guarantee of well-formed JSON, so a weak model's reply is unreadable more often: a gap or a failed vote, never a pass. A 400 or 422 is matched by code against the field's name as a whole word, and the body is never quoted.
- **A stream steps down in two steps**, for a provider whose `stream` is unset, each probed once per provider and review: to a stream without its options, `api: its calls stream without stream_options for the rest of the review: the server refused the field, so each call settles at its reservation`, since the server then sends no usage; then to whole replies, `api: its calls ask for whole replies for the rest of the review: the server refused streaming; set stream: false to choose it yourself`. A server that answers a streamed call whole moves it to whole replies at once, with no probe: `api: its calls ask for whole replies for the rest of the review: the server answered a streamed call whole; set stream: false to choose it yourself`. A server that refuses the bare stream as a stream goes on to whole replies in the same call. `stream: true` pins the stream, so a refusal fails the call and a provider found down by it is told `set stream: false`; `stream: false` asks for whole replies from the start. A 400 or 422 is matched against the words `stream_options` and `stream` as whole words, and the body is never quoted: [Streaming](./30-providers.md#streaming).
- **A refused lowering goes back.** A model that answers a 400 or 422 to the lowered value (a template that raises on an effort, an OpenAI model that refuses `none`) keeps the server's own level: `api: the server refused thinking lowered to low: thinking stays as the server sets it for the rest of the review; set thinking to choose it yourself`. No other request sends the lowered value, and the refusal counts toward no provider being down.
- **An explicit setting is never moved.** A provider whose `thinking` is set, or whose `extraBody` sets the control, does not lower; one whose `structuredOutput` is set, or whose `extraBody` sets the field, does not move to prompt mode; one whose `stream` is set does not step its stream down. A provider object states which settings it lets quorum move in `adapts` ([What a provider states](./30-providers.md#what-a-provider-states)), and one that states none moves none.
- **A research request asks for more findings** once a reply of its provider shows that the model does not reason: a reply that reports no reasoning and holds no `<think>` block. The request then asks for the findings its budget holds with no thinking allowance (`N'` for `N`, [Reply budgets](#reply-budgets)), for the rest of the review. The reply budget itself never moves, but for a learned cut on the way: [Reply budgets](#reply-budgets).

How a move is found out, so that no call fails for it: the first call whose failure a setting answers becomes that setting's probe, and is sent once more with the new setting. While the probe is pending, the provider's new calls wait for it, inside their slots, and then go at the settled setting. The calls already in flight, which still hold the old setting, wait for the probe too when they fail the same way, and are sent once more at the setting it settled on. So a voter whose JSON mode answers empty leaves no failed vote in its first wave, and a research part in flight does not split for a setting the review has already moved. A setting is probed once per provider in a review. The thinking probe sets the lowered level and records it once the server shows it took the request: it answers, or its reply is cut off, empty, only reasoning, unreadable or refused by the model, or it times out, a gateway's 504 or 524 included. After a reply that held only reasoning, any other failure but a 400 or 422 sets it too, since the server's own level was answering nothing. After a cut-off, any other failure (a network error, or a status such as 429, 500 or 503) moves nothing and records nothing: the setting counts as tried, and the call ends with its first failure, so the part is split. A 400 or 422 refuses the lowering. The prompt-mode probe moves only when it answered, and a probe that failed leaves `json`, says nothing and ends its call with its first failure; a stream step's probe moves it on an answer alone as well. A probe or a call the token cap or the deadline stops moves nothing. The bound is per setting, at most `concurrency` calls (16 with lanes) sent once more, the probe included, and a stream counts as two settings, one per step. Every wait ends with the review's deadline or abort.

Each move is one progress line ([Progress lines](./10-cli.md#progress-lines)), one `adapted` event ([Library API](../95-reference/30-library-api.md#events)) and one entry of `meta.adaptations` ([The adaptations](../95-reference/20-json-result.md#the-adaptations)), in the order they happened.

## Research in parts

A change larger than one research request is reviewed in parts, not refused. Each part is a research call of the profile, or up to 15 when its reply is cut off and recovery splits it ([Recovering a cut-off part](#recovering-a-cut-off-part)), and the profile's findings are those of all its parts.

- **What a part holds.** The files of the diff, in its order, packed into parts whose diff text is at most `partTokens` (32768 by default, counted as the size guard counts) and whose whole request fits the research model's window, a part's request holding the parts block that names its position and the change's files, which takes room from the window. A diff within both is one part, today's request, with no parts block. The default sits below the window on purpose: smaller parts caught more planted attacks in the one measurement of it, and most models read a long prompt worse well before their window is full: [Research in parts](../30-security/10-threat-model.md#research-in-parts).
- **A file larger than a part** is split between its hunks, each piece with the file's header, never inside a hunk.
- **A hunk larger than `partTokens`** goes alone into a part of its own when that part's request, its parts block included, fits the window. One whose part does not fit the window, even with a block that names no file, is left unreviewed, as is a section with no hunk that does not fit: a `too-large` gap that no flag lifts for a gating profile, its lines listed in the profile's coverage ([Coverage](../95-reference/20-json-result.md#coverage)).
- **Each part's request names the change**: `Part 2 of 5 of the change.` and the change's files, at most 100 names and a quarter of the lesser of the room a request leaves and `partTokens`, then `and N more`, so the list stays small beside the part's diff whatever the window. A model that reads one part still knows where it is, and which files the others hold. The names are dropped from every part, the block reading `and N more` alone, when they would leave a hunk out that a part holds without them.
- **A part whose reply is cut off at its limit, or lists as many findings as it was asked for at most, is split in two by code** and each half researched as a part, to a floor of one hunk and three splits: [Recovering a cut-off part](#recovering-a-cut-off-part).
- **Each part is at least one research call**, each reserved by the token cap and stopped by the review's deadline. What a limit stops is a `token-cap` or `review-deadline` gap counting the parts, and the parts after it are not sent. A failed part, a gating profile's too, is a `research-failed` gap counting its parts, while its other parts go on, and the parts a provider found down was never sent are one `provider-down` gap: [When the research call fails](./10-cli.md#when-the-research-call-fails).
- **The findings of all parts** are read in their order, up to `maxFindings` in all, each checked against the whole diff, and a repeat across parts is dropped.
- **A vote's context.** A vote takes its finding's file section, as before. When its voter states a room that the section does not fit, it takes the section's header and the hunks nearest the cited line that fit: the cited hunk first, then the nearer neighbour on either side, the earlier on a tie, each side ending at the first hunk that does not fit, and the request says it holds part of the section. A cited hunk that does not fit alone is sent as before, which its provider refuses: a `request-too-large` gap.
- **A provider that states no room**, a provider object that does not state `room` among them, is sent the whole diff in one request, as before ([What a provider states](./30-providers.md#what-a-provider-states)).

`partTokens` is a whole number of tokens from 1024 to 9007199254740991, set in the config a run names or in the options of `createQuorum` ([Library API](../95-reference/30-library-api.md#options-and-ports)), and 32768 when unset. No `QUORUM_*` variable sets it, since it tunes a review rather than bounding it, like `maxFindings`, and it never comes from the change: [`--print-config`](./10-cli.md#printing-the-resolved-config) prints the value a run applies. A smaller value means more, smaller parts and more calls; a larger one, fewer and longer requests. A value below 1024 is refused, never raised: [Configuration errors](#configuration-errors).

## Recovering a cut-off part

A reply cut off at its limit used to be a lost part. Quorum now recovers it by code, in this order, and no text of the cut reply is read:

1. **Thinking first.** When the reply was cut off while it reasoned and the provider's thinking is automatic, the call is sent once more with thinking lowered, before the stage sees a cut-off: [What quorum adapts by itself](#what-quorum-adapts-by-itself). A provider whose `thinking` you set is never lowered.
2. **Then split.** The part is split in two, between its files when it holds several, at the boundary that leaves the two halves' token counts nearest (the first on a tie), else between the hunks of its one file, each half keeping the file's header and no hunk ever cut. Each half is researched as a part is, in the part's own worker, one after the other and depth first in the diff's order, so a recovered part never takes more of the concurrency than its own slot, and a half whose reply is cut off or saturated is split again by the same rules. A piece whose request its provider refuses as too large, which the planner sized only as a part, is split again too, where a part is not: the refused request was never sent, and each node of the tree still makes one request at most. Each piece's request is its part's, with the piece's text and a position line that names the piece: `Part 7 of 44 of the change, piece 3 of 4.` A change in one request that is split gains a parts block holding the position line alone: `Piece 1 of 2 of the change.` ([The prompts](./60-prompts.md)).
3. **The floor.** A piece that holds one hunk, or that lies three splits deep, and whose reply is still cut off, is not split again. Its hunks are the `reply-cut-off` gap, with their lines in the profile's coverage ([Coverage](../95-reference/20-json-result.md#coverage)): `3 hunk(s) of 2 file(s) were cut off at their reply's limit even alone, listed as reply-cut-off in meta.profiles.security.coverage: raise maxTokens, set thinking: low, or lower partTokens`. No flag lifts it, `--allow-incomplete` included, since the reviewed content can force it.

The pieces' replies stand in the part's place: they are read in the diff's order, up to `maxFindings` findings in all, each checked against the whole diff, and a finding two pieces report is dropped as one two parts report is. A file is `reviewed` only when every piece that held a hunk of it was read.

**Saturation.** A reply that lists as many findings as it was asked for at most (`N`, [Reply budgets](#reply-budgets)) may have stopped at the ask. When `N` is below `maxFindings`, the part is recovered as a cut-off is, by splitting, and its saturated reply is not read: its pieces' are. At the floor, or when `N` is `maxFindings`, the reply is read, and the profile records one `findings-capped` gap that counts such replies and names the largest ask. A gating profile with it exits `4` as before, and `--allow-incomplete` does not lift it.

**What it costs.** A part makes at most 15 research calls: 1, then 2, 4 and 8 pieces, so the worst case is a constant multiple of the part whatever the reply: an output-length attack can cut every piece at every depth, and the depth bound is what keeps it from costing more. Every call is reserved by the token cap and stopped by the deadline like any, and a limit that stops one piece stops the part's later pieces and the profile's later parts without a call. In tokens a part of `d` tokens of diff, whose reservation is `r` and whose largest file header is `h`, spends at most its own reservation plus `3d + 14h + 14 (r - d + e)`: each of the three depths holds the diff once, and each of the 14 pieces repeats at most one header and holds the request's fixed text, its template reserve and its reply budget (`r - d`), with `e`, the tokens a piece's request holds beyond its part's: the longest position line (`, piece 8 of 8`) and, for a change in one request, the parts block its pieces gain. The adaptations add their own bound, per setting, at most `concurrency` calls (16 with lanes) sent once more ([What quorum adapts by itself](#what-quorum-adapts-by-itself)). The path review's estimate counts both in its worst case, which its cap follows: [The bounds of a path review](./15-sources.md#the-bounds-of-a-path-review).

Each part recovered is one progress line, once its pieces have answered, and `meta.profiles.<id>.recovery` counts them: [Progress lines](./10-cli.md#progress-lines), [Per profile](../95-reference/20-json-result.md#per-profile).

## Saved state

A review on a slow or flaky gateway can fail late, and every call it had paid for was lost. With `--state <dir>`, each of them is kept as it completes, and a rerun reuses them: [`--state`](./10-cli.md#the-invocation) in the CLI, `fileStore` in the library ([Library API](../95-reference/30-library-api.md#filestore)). Nothing is saved without it but for one case: a path review on a terminal keeps its calls in a default directory of its own (below). No variable names a directory, since one set in a shell profile would write files in every run, and `--no-state` turns the default off.

**Where.** A directory you name, which must be yours alone to write: it is made with mode `0700` when it is missing, and one that exists must be a directory, not a symbolic link, owned by the user that runs quorum and writable by no other (no group or other write bit), and either empty or one quorum made, which holds its marker file `quorum-state.json`. A directory that holds other files is refused, never written into. A directory whose real path, or any parent's, holds a `.git` entry is inside a git work tree and refused: a pull request writes its checkout, so it could plant a stored reply there. Each refusal is a configuration error, exit `2` before any call, that names `--state` and never the path. It is not offered under `quorum mcp`, whose calling agent could write the directory, and not in the bench, whose trials must each call the model.

**The default.** A `--path` review run on a terminal (stderr a terminal and `CI` unset or empty, whatever `--progress` says) with neither `--state` nor `--no-state` keeps its answered calls in `<cache>/quorum/state/<key>`, in the user's cache directory (`$XDG_CACHE_HOME` when absolute, else `$HOME/.cache`, and `$HOME/Library/Caches` on macOS), keyed by the repository, and a rerun of the same command reuses them: [The default state directory](./10-cli.md#the-default-state-directory). Its missing parents are made with mode `0700`, and the checks below apply to it. One that refuses it skips the default with a `warning:` line, and the review goes on with no store: a home directory kept in git is such a case. It is removed once the review completes with nothing left for a rerun to fill (no `interrupted`, `token-cap`, `review-deadline`, `provider-down`, `research-failed` or `vote-failed` gap and no unreviewed finding), and kept otherwise, with the summary's `resume:` line saying so. A diff, a range, the local changes, CI, `quorum mcp` and the bench never use it, and `--no-state` keeps none.

**What is saved.** One file per call, written whole through a new file and a rename, with mode `0600`, as the call completes:

- each research call whose reply passed its envelope check, a recovery's pieces included, and each vote whose reply parsed as a vote: the reply's text, the model it reports and its usage;
- for a research call whose reply was cut off at its limit, or listed as many findings as it was asked for at most, a **marker**: what the reply lacked and its usage, never any text. A rerun that finds it sends the part straight to recovery under the same bounds ([Recovering a cut-off part](#recovering-a-cut-off-part)), so a resumed review does not pay for its cut-offs again. A marker can only send a part to recovery: it makes nothing read as clean.

A call that failed is never saved, so a rerun asks it again, and neither is a vote that did not parse. Each send of a call has its own entry, so a call that was sent once more at a lowered thinking level or in prompt mode ([What quorum adapts by itself](#what-quorum-adapts-by-itself)) keeps what each send got, and a rerun replays them.

**Reuse.** A rerun with the same directory looks up each request before it sends it. An entry is found only for a request sent as it was: its key holds the request's instructions, every block it carries, the reply schema, the reply budget, the thinking level and the mode it was sent with, quorum's version and the provider's settings, every field of them but its key, `timeoutMs` and `retries`, so a changed diff, prompt, budget, provider (its model, endpoint or context size, say) or version is a miss and the call is made, and a raised `timeoutMs` or `retries` still reuses every call. A stored reply is then checked as a fresh one (a research reply's envelope, and each finding against the whole diff; a vote's parse), and reused only if it passes. It spends nothing: no reservation under the token cap, no usage in `meta.usage`, and its `call` event says `reused`. `meta.reused` counts the research calls and the votes reused, and the review prints `reused from --state: <r> research call(s), <v> vote(s)` ([Progress lines](./10-cli.md#progress-lines)). A provider found down in the review is called no more, and its stored replies are not read either. A reply read from the directory teaches the review nothing about the model, so a request the first run sent after it had learned a larger `N` ([Reply budgets](#reply-budgets)) is another request, and is sent again. A thinking or prompt-mode setting that settled is the same case: a call the first run made after it settled is stored under the moved setting's key alone, and a rerun call that starts before its replayed probe settles misses, so a rerun pays again about the calls in flight: `concurrency`, or up to 16 with lanes. A rerun also pays the calls that failed, and every call of a provider whose settings changed. A path review's estimate does not read the store, so a rerun is estimated whole.

**What it never trusts.** The directory holds code from the diff and model text, and is as trusted as the provider: whoever can write it can write a part's review. The refusals above are the guard. An entry that is no regular file, is over 8 MiB, fails its strict schema (`version: 1`, the key, a text of at most 1 000 000 characters, a model of at most 256, the usage as counts) or holds another key is a miss, with one warning line per reason: `--state: a stored reply could not be read (<why>): the call is made again`. A stored reply that fails the check a fresh reply passes is a miss too, with one `--state: a stored reply failed its check: the call is made again` for each provider and role, since it was saved only once checked and so was written by something else. A write that fails is one warning line, `--state: a reply could not be saved (<code>): the review goes on without saving it`, and never fails the review. No line holds a reply's text, a key or a path.

**Keeping it.** The directory grows by one file for each distinct request and quorum never prunes it: remove it once the review it serves is done. In CI, name a directory under `$RUNNER_TEMP` (or the runner's own temporary directory), never one in the checkout or in a cache another job can write: the `.git` check covers a git checkout only, so a workspace with no `.git`, such as a downloaded archive, that holds a planted directory passes every check. Never restore it from a cache another job can write, such as a pull request's CI cache: a stored reply it plants is reused as the provider's own answer. On Windows the owner and mode checks do not apply, since the platform has no such bits to read: keep the directory in the user's profile, where only that user can write.

## Excludes

`exclude` lists the files a review leaves out, as path patterns. Nothing is excluded by default, and every file excluded is listed in the result, never dropped in silence:

```yaml
exclude:
- package-lock.json
- "*.min.js"
- vendor/**
- /docs/images/**
```

- **What it does, for every source.** `exclude` applies to a diff file, to stdin, to a range of commits and to the local changes of `--local` and `--staged` alike, a range's and the local changes' as a piped diff's, and an untracked file of `--local` that it matches is listed and never read: [Sources](./15-sources.md). A path review applies it before it reads a blob: an excluded file is listed as `excluded` and never read, and the name rules, the secret rule included, come after it, so an excluded secret raises no `secret-file` flag (a gitlink is skipped first): [What a path review skips](./15-sources.md#what-a-path-review-skips). A pattern matches a file's path as the diff names it: the new path of a rename, the old one of a deletion, a name git quotes decoded. A renamed or copied file is left out only when git's `rename to` or `copy to` line names the same path as its header: a path that holds a space before `b/`, such as `src/x b/dist/auth.js`, makes the header read two ways, so such a file is reviewed. The file's section then reaches no model, neither the research request nor a vote, so the size guard does not count it, and a finding that cites it is dropped as outside the diff. It is listed in `meta.leftOut` as `excluded` and on stderr, and it is no gap, even when it is binary: leaving it out is your choice. The advisory flags still read it, since they are code and call no model.
- **The syntax.** `*` stands for any characters of a name and `?` for one, both within a directory; `**`, as a whole segment between slashes, for any number of directories, none included. A pattern with no `/` matches a file's name in any directory: `*.min.js` matches `dist/app.min.js`. A pattern with a `/` matches the whole path from the root of the repository, and a leading `/` only anchors: `/package-lock.json` is the root's alone, where `package-lock.json` is any directory's. A pattern that ends with `/**` matches everything inside its directory, at any depth, and never a file named like the directory. A directory's name alone names a file: `dist` leaves out a file called `dist`, not what a `dist` directory holds, which `dist/**` does for the root's and `**/dist/**` for any. Every other character stands for itself, `[` and `]` included, so `pages/[id].js` names that file, and case counts: `*.PNG` does not match `logo.png`.
- **What is refused**, before any call, with what to write instead: an empty pattern, one over 256 characters, one that ends with `/` (`vendor/` matches no file: write `vendor/**`), a `**` inside a name (`**.js`: write `**/*.js`), an empty, `.` or `..` name (`./dist/**`: write `dist/**`), a `\`, a `!` or a `{`, none of which means anything here, and more than 100 patterns. A pattern written for another tool can only exclude less: no character but the three wildcards matches more than itself.
- **What is never excluded:** a part of the diff that no `diff --git` header names, which is listed under the empty name. That is the text before the first header, a diff without such headers, a section whose header quorum cannot read, and a submodule that git's `log` or `diff` format prints as a `Submodule` line. Make the diff with `--submodule=short`, as the [CI command](./10-cli.md#using-it-in-ci) does, and a submodule has a section of its own, which a pattern matches: `vendor/**`. In a `format-patch` series, though, the next mail's headers and message sit at the end of the previous file's section, and leave with it when that file is excluded; the patches themselves are sections of their own.
- **Only from the config you name.** No `QUORUM_*` variable and no flag sets it, since it widens what passes unread: it belongs in the config a reviewer of the job reads, which [`--print-config`](./10-cli.md#printing-the-resolved-config) prints. Nothing of the change is read as an exclude: no `.gitattributes`, no `linguist-generated` attribute, no file's content. The base branch's own attributes still shape the diff, though: a `-diff` the base sets, for a lockfile say, shows that file as binary, which is a gap unless `exclude` lists it.
- **A pattern lets the change choose what passes unread.** A pull request can add a file at any path a pattern matches, and no model reads it. Keep each pattern as narrow as the files it names, anchored with a leading `/` where a file has one place (`/package-lock.json`). The code that loads such a file is still reviewed, and the stderr line and `meta.leftOut` name every file left out, a new one included. A file moved out of an excluded path into a reviewed one shows only what changed in the move, so content no model read can enter reviewed code: make the diff with `--no-renames` to show every moved file whole, at the cost of its tokens.
- **What excluding a lockfile gives up.** A lockfile is a real place to hide an attack: a `resolved` URL pointed at a copy of a package its author controls keeps the package's name and version, and few people read thousands of generated lines. Excluding it saves the calls it costs, and can save research parts or make a hunk the size guard refused fit, since the guard counts only what is sent; but no model reads its change. Check lockfiles another way, with a tool such as lockfile-lint, which checks every `resolved` host, or review their changes by hand.

quorum matches a pattern with code of its own, segment by segment, never turning it into a regular expression, so a long path in the diff cannot make it slow. [A file left out](../95-reference/20-json-result.md#a-file-left-out) says what the result lists.

## Sending a held file

Every source holds back a file named as a secret or holding a credential, so a repository that commits one on purpose exits `4` on every change to it: [Files held back as secrets](./15-sources.md#files-held-back-as-secrets). `send` lists the files to send the models all the same. Nothing is sent by default, and `--send <path>` on the command line adds to the config's list:

```yaml
send:
- web/.env.production
- src/firebase.ts
```

- **What it sends.** A file named is not held: its lines go to the models like any other file's, it is not listed as `secret` in `meta.leftOut`, and it raises no `secret-file` flag. That holds for a diff file, stdin, a range, the local changes and a path review alike, and for the estimate a path review prints.
- **Exact paths.** Each entry is the path as the diff writes it and the `left out:` line prints it, a name git quotes decoded, compared as text and never normalized: `./web/.env.production` and a path relative to a subdirectory name no file, and the file stays held, exit `4`, with the path to write on the `left out:` line. In a path review the path is relative to the repository's top level, where `--path` is relative to the working directory. The text no header names has the empty name, which no entry can be. An empty entry, or one that is no string, is refused: `quorum.yaml: send.0: must name a file`.
- **`exclude` first.** A file `exclude` matches is listed as `excluded` and never sent, `send` or not.
- **It widens what a provider receives.** A file sent is read by every model of the review, and a hosted provider keeps what it is sent: [Secrets held back](../30-security/10-threat-model.md#secrets-held-back). Name a file only when what it holds is meant to be public or is no secret of yours. A `send` entry covers every future change to that path, a key added to the file included.
- **The cases it is for.** A Next.js project commits its `.env`, `.env.development` and `.env.production`, which hold defaults and nothing private, so every change to one exits `4` until its path is in `send`. A Firebase web config holds a Google API key, which Google calls public and quorum holds as a key: `send` names the file that holds it.
- **The config's and the command line's alone.** No `QUORUM_*` variable sets it, and nothing of the change is read as a `send`: no file, no attribute, no commit message, since it widens what leaves your machine. In CI it belongs in the config a reviewer reads, which [`--print-config`](./10-cli.md#printing-the-resolved-config) prints, or in the job's command line. The CLI sends the config's list and every `--send`, merged, to the source, the estimate and the review.

## The limits of a review

A review is bounded, so that nothing a pull request holds can make it run away. Each limit stops part of the work and says so in a gap of its own, never as a failed run. Both are set by the operator alone, in the config a run names or in the environment, and [`--print-config`](./10-cli.md#printing-the-resolved-config) prints the values the config gives a run. A `--path` review that finds the cap or the deadline unset derives its own from its estimate, which `--print-config` cannot show, since it reads no diff: [The bounds of a path review](./15-sources.md#the-bounds-of-a-path-review).

### The token cap

A review spends at most `maxReviewTokens`, 2000000 by default (a `--path` review's follows its estimate, below), input and output together, with every attempt counted, retries included. So neither a pull request nor text planted in it can spend past it: padding a diff, flooding the research with decoy findings or drawing out a reply all run into the same number.

- **Before each attempt the review reserves its worst case**: the provider's [`worstCase`](./30-providers.md#what-a-provider-states), else the request's text at one token per byte with 512 tokens for the template and 16000 for the reply. **It settles when the attempt ends**, at the usage the reply reports, at nothing for a request the server refused before any work (an `http` failure with a client status but 408, or a refusal as too large), else at the whole reservation, so a failure that reports nothing never costs less than it may have.
- **An attempt that does not fit beside what was already spent is not sent**, and its call is a `token-cap` gap: a research request leaves its profile with no finding (a research in parts loses the parts not sent), a vote is a failed vote of kind `token-cap`, and each profile has one gap that counts them. A gating profile's gap exits `4`, with or without `--allow-incomplete`: [Exit codes](./10-cli.md#exit-codes). A review the cap stops is no failed review, and the other profiles and votes run as far as it lets them.
- **An attempt that fits beside what was spent, but not beside the calls in flight, waits for them**, holding its slot, and goes as soon as a settlement leaves room. Waiting attempts go in the order they began to wait, and a newcomer waits behind them. Because the reservation counts code at about three times its tokens, the cap waits more than it refuses.
- **A large change spends up to the cap.** A diff of several megabytes is reviewed in parts, each reserved before it is sent, so the cap stops the parts it cannot fund, a `token-cap` gap that counts them, where 0.5.0 refused the whole diff at once. A single request whose worst case alone passes the cap, such as a vote on a very large file, is refused as `token-cap` before its provider's size guard sees it.
- **A path review's cap follows its estimate.** A codebase is as large as its tree, so `--path` prints an estimate before any call, and with `maxReviewTokens` unset its cap is that estimate's worst case, never below 2000000: the review is never held at exit `2` for its size, and `--large` is deprecated and does nothing: [The bounds of a path review](./15-sources.md#the-bounds-of-a-path-review). The estimate counts a research reply at the lesser of its budget and 4096 tokens, so a large `maxTokens` is headroom and no longer makes the estimate several times what a review spends; its worst case counts every part recovered and the calls an adaptation sends once more, but it counts one attempt per call, and a retry reserves its tokens again, so a review that retries a great deal can still reach a cap that follows it, and what it cannot pay for is a `token-cap` gap. **A cap the config sets is kept**: below the estimate, the review runs to the cap after a warning that says how many of its research parts the cap holds, and what it cannot pay for is a `token-cap` gap, exit `4`; unset `maxReviewTokens` to let the cap follow the estimate. A diff, a range and the local changes keep the cap the config sets, 2000000 when it sets none, whatever their size.
- **It counts tokens, not dollars**, so it holds for a local model as well as a hosted one, whatever the price.

A typical review spends a few hundred thousand tokens, and a `claude-code` vote counts its text twice, which its worst case reserves: [The size of a Claude Code request](./30-providers.md#the-size-of-a-claude-code-request). In `schema` mode each vote sends its text twice and carries its first reply into the second turn, so a heavy review (many findings on large files) can reach 2000000 tokens on `claude-code` where it fits on an HTTP provider: raise `maxReviewTokens` for such a review, or set `structuredOutput: prompt`, which makes one turn. Raising `maxTokens` at a high `--effort` adds three times the increase to every vote's reservation in `schema` mode. To raise the cap, set `maxReviewTokens`, a whole number of tokens from 1 to 9007199254740991, in the config, in `QUORUM_MAX_REVIEW_TOKENS`, which wins over the config's, or in the options of `createQuorum`: [Library API](../95-reference/30-library-api.md#options-and-ports). There is no off switch, only a larger number, so the default stays on when nothing says otherwise. What the cap leaves open, and why, is in the threat model: [The token cap](../30-security/10-threat-model.md#the-token-cap).

### The review's deadline

A review ends at `reviewTimeoutMs`, 1800000 ms (30 minutes) by default, so a CI job ends with an answer instead of waiting on a model that never replies. A `--path` review, which may be hours of calls on a slow provider, has 86400000 ms (24 hours), the longest a deadline may be, when the config sets none: [The bounds of a path review](./15-sources.md#the-bounds-of-a-path-review). A diff, a range and the local changes keep 30 minutes, or the config's.

- **At the deadline every call in flight and every wait is stopped at once**, a wait for room under the token cap and one between two attempts included, and no new call starts, a call still queued for a slot included. It is a limit of the whole review, apart from each attempt's own `timeoutMs`: [The deadline of an attempt](./30-providers.md#the-deadline-of-an-attempt).
- **What was not done is a `review-deadline` gap of its profile**: a research request that was not done leaves the profile with no finding from it (for a research in parts, the parts in flight or not yet sent are counted in the gap), and votes that were not cast are failed votes of kind `review-deadline`, with one gap per profile counting them. The review resolves with its findings so far, and a finding that the votes it cut could still have kept is `unreviewed`. A call whose retry the deadline prevented is recorded as the deadline's, never as the failure it was retrying after, so no flag lifts it. A gating profile's gap exits `4` whatever the flags, `--allow-incomplete` included: [Exit codes](./10-cli.md#exit-codes).
- **An interrupt still exits `130`**, before the deadline or after it: the deadline resolves the review, and the first signal resolves it too, with its own gaps: [Interrupting a review](./10-cli.md#interrupting-a-review). A library abort still rejects it.
- **A server's hint longer than the time the review has left ends its call at once**, since the wait would outlast the review. The call keeps its own failure, an HTTP 429 for instance, which `--allow-incomplete` lifts like any 429, unlike a call whose retry the deadline prevented, which is the deadline's and which no flag lifts: [The wait between attempts](./30-providers.md#the-wait-between-attempts).

A slow local model raises it: set `reviewTimeoutMs`, a whole number of milliseconds from 1000 to 86400000, in the config, in `QUORUM_REVIEW_TIMEOUT_MS`, which wins over the config's, or in the options of `createQuorum`: [Library API](../95-reference/30-library-api.md#options-and-ports). Like the token cap, it has no off switch, only a longer deadline, so the default stays on when nothing says otherwise. What it leaves open is in the threat model: [Deadlines and bounded retries](../30-security/10-threat-model.md#deadlines-and-bounded-retries).

### The calls at once

`concurrency` is how many provider calls run at once in a review. Unset, which is the default, it is adaptive: each provider has a lane of its own, which starts at 4 calls at once, grows by one after a window of clean answers while the provider's rate-limit headers say there is room for one more, halves when the provider throttles, and waits out a `Retry-After`, under a ceiling of 16 calls in flight over every provider. One gateway's throttling then slows its own calls, and no other provider's. A provider that sends no rate-limit headers stays at 4, and a throttle still cuts it. The rule, with its numbers: [Lanes](./30-providers.md#lanes).

- **Set, it is exact**: `concurrency: 6` is one limit of 6, shared by every provider of the review, as a review ran before lanes. No lane grows or shrinks, nothing pauses or paces, and no `concurrency` event is sent: the setting is the one place to hold a review to a number, such as the parallel requests a local server takes ([Local models](../90-recipes/10-local-models.md#how-many-calls-at-once)).
- **The research workers follow it**: a profile reads up to 16 parts of its research at once with lanes, and `concurrency` of them when it is set. Each worker's call waits for its provider's lane.
- **`--print-config` prints `auto`** for an unset `concurrency`, and `meta.concurrency` of the result records what each provider's lane did: [The JSON result](../95-reference/20-json-result.md#the-lanes).
- **A bench run** keeps `concurrency` in its configuration's fingerprint, `auto` when unset: [The fingerprint](./70-bench.md#the-fingerprint).

## Claude Code

A `claude-code` provider runs your installed Claude Code CLI as the model, headless and isolated, once per request. [`claudeCode`](./30-providers.md#claudecode) has its command line, its isolation and its errors; this section sets one up.

### From the environment alone

Three variables are enough:

```bash
export QUORUM_RESEARCH_PROTOCOL=claude-code
export QUORUM_RESEARCH_MODEL=sonnet            # an alias, or a model id, that `claude --model` takes
export QUORUM_RESEARCH_CONTEXT_TOKENS=1000000  # the context window of that model
quorum ./my.diff > result.json
```

A protocol variable builds the provider afresh, so the panel shares it, its `auth` is `inherit` and `claude` comes from `PATH`. Choosing `login` or `api-key` takes a config file.

### In a config file

```yaml
providers:
  claude:
    protocol: claude-code
    model: sonnet
    contextTokens: 1000000
    auth: login
    args:
    - --effort
    - high
```

- **`protocol: claude-code` has no preset and no base URL.** `preset: claude-code` is refused as an unknown preset, and a `baseUrl`, `headers`, `query`, `extraBody`, `temperature` or `systemPrompt` is refused.
- **`auth`** is `inherit`, `login` or `api-key`, `inherit` when unset: [The auth modes](#the-auth-modes).
- **`args`** passes `--effort`, `--fallback-model`, `--max-budget-usd` and, in `api-key` mode, `--betas`, each followed by its value or written `--flag=value`. No other flag is accepted, so `args` cannot loosen the isolation: [Claude Code options](./30-providers.md#claude-code-options).
- **`timeoutMs` and `retries` bound the run.** Its deadline is `timeoutMs` times `retries` plus one, 30 minutes by default, so raise `timeoutMs` for a long run, such as one at `--effort high`: [Stopping, nesting and the version](./30-providers.md#stopping-nesting-and-the-version).
- **`maxTokens`** is the ceiling of Claude Code's own limit on each reply, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`: each run is given the reply budget of its request, at most `maxTokens`, else `maxTokens`, else 16000 ([Reply budgets](#reply-budgets)). Raise it, with `timeoutMs`, at a high `--effort`: [Stopping, nesting and the version](./30-providers.md#stopping-nesting-and-the-version).
- **`structuredOutput`** is `schema` by default, and `prompt` leaves the reply's shape to the prompt.
- **`apiKeyEnv`** names the variable that holds the key in `api-key` mode, `ANTHROPIC_API_KEY` by default. Under `inherit` or `login` it is refused, `providers.claude.apiKeyEnv: is set, but auth is not api-key`, and the variable is never read.
- **A YAML or JSON provider cannot name the executable.** `command` is code-only: [Where the command comes from](#where-the-command-comes-from).

### The Claude Code version

Quorum requires Claude Code 2.1.311 or newer. Before a provider's first request it runs `claude --version` once and keeps the answer for the life of the process; an older version fails every request with `Claude Code 2.1.311 or newer is required, found 2.1.310`, and a research request that fails is a `research-failed` gap, exit `4`, or exit `3` when no research request of any profile answered. The isolation depends on environment variables that an older Claude Code ignores, one of which keeps a file named in the diff from reaching the model: [Stopping, nesting and the version](./30-providers.md#stopping-nesting-and-the-version).

### The context size of Claude's models

`contextTokens` is what the model gives you, stated as for any provider: [The context size](#the-context-size). On Anthropic's API, `sonnet`, `opus` and `haiku` resolve to models with a 1M window, so `1000000`. On Bedrock and Vertex, `sonnet` and `haiku` resolve to the 4.5 models, whose window is `200000`. A 4.6 model has the 1M window only with the `[1m]` suffix, as in `opus[1m]`, and `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` in the environment holds the 1M models to 200K. When in doubt, state the smaller number.

The guard keeps 4096 tokens for what Claude Code adds around the messages, and the request's reply budget ([Reply budgets](#reply-budgets)), so the window must be more than 4096 when `maxTokens` is unset, and more than 4096 and `maxTokens` together when it is set. The diff a research request of the `security` profile leaves room for is `contextTokens` less 1,618 bytes of instructions, fences, reply schema and findings line, less 4096 and the reply's budget. [The size of a Claude Code request](./30-providers.md#the-size-of-a-claude-code-request) has the rule.

### The auth modes

- **`inherit`**, the default, runs `claude` with your environment as it is, so it authenticates as `claude -p` does on its own. Claude Code takes the first credential that is set, in its own order: a cloud provider (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY`), `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, an `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, an Anthropic profile or federation, then the `/login` session. Quorum has `claude` read no settings file, so an `apiKeyHelper`, or the cloud provider or base URL that an `env` block of your settings file sets, is not applied: `inherit` equals your own `claude -p` for the environment's variables only. An organization's managed settings still apply.
- **`login`** forces the Claude Code login: the subscription session of `/login`, or in CI the `CLAUDE_CODE_OAUTH_TOKEN` that `claude setup-token` prints. Every variable that would pick another credential or another host is removed, so the login reaches Anthropic's own API unless a managed setting routes it elsewhere: [The auth modes](./30-providers.md#the-auth-modes) lists them.
- **`api-key`** hands an API key to `claude` in its environment, as `ANTHROPIC_API_KEY`, and nowhere else, with `--bare`. It reads the variable `apiKeyEnv` names, else `ANTHROPIC_API_KEY`, so `auth: api-key` alone works, and a variable that is not set is exit `2`, `providers.claude: ANTHROPIC_API_KEY is not set`. A code config may hold the key in `apiKey`. Claude Code's documentation says `--bare` reads no login, so the key is the credential; that was not observed live.

**The billing warning.** Headless Claude Code uses `ANTHROPIC_API_KEY` whenever it is set, rather than the login. So a provider a profile uses that runs under `inherit`, or sets no `auth`, while `ANTHROPIC_API_KEY` is set, gets one warning, which never prints the key:

```text
warning: providers.default: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key
```

**In CI**, use an API key with `auth: api-key`, or the token of `claude setup-token`, as `CLAUDE_CODE_OAUTH_TOKEN`, with `auth: login`. Anthropic's Agent SDK documentation says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in this document instead." Quorum runs your own CLI, which authenticates however you set it up: in the `inherit` and `login` modes it hands its environment to `claude`, less the variables the mode removes, and reads the credential variables' values only to redact them from a quoted error. It stores and logs none, and sends them nowhere but the child.

### Where the command comes from

The executable of a `claude-code` provider is, in this order:

1. `QUORUM_CLAUDE_CODE_COMMAND`, for every `claude-code` provider.
2. The `command` of a code config's provider.
3. `claude`.

The environment wins over the file, as every layer does. A command is an absolute path or a bare name:

- **A relative path with a separator is refused**, `QUORUM_CLAUDE_CODE_COMMAND: must be an absolute path, or a name to find on PATH`, since it would resolve inside the pull request's checkout. So is a `.cmd` or `.bat` file, which runs only through a shell, and quorum never uses one.
- **A data file never names it.** `providers.claude.command: is not a known field` in a YAML or JSON config.
- **A bare name is looked up in the absolute entries of `PATH` only.** An empty entry, `.` or `bin` would be the working directory, so a relative entry is skipped. On Windows the name is looked up as `<name>.exe`. The match must be a regular file the process may run, and its absolute path goes in the resolved config, which [`--print-config`](./10-cli.md#printing-the-resolved-config) shows.
- **Only the providers a profile uses are looked up**, as their keys are. A config can define a `claude-code` provider on a machine without `claude`.
- **One that is not found is exit `2`**: `providers.default: claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND`, and `QUORUM_CLAUDE_CODE_COMMAND: names no executable file` or `providers.claude.command: names no executable file`, when a command that is set does not name a file that runs. No message repeats a path.

In CI, name it absolutely, `QUORUM_CLAUDE_CODE_COMMAND=/usr/local/bin/claude`, so that no `PATH` entry inside the checkout can supply a `claude`: [Claude Code, isolated](../30-security/10-threat-model.md#claude-code-isolated).

## Keys

A provider's key is the first of these:

1. **A literal `apiKey`**, which only a TS or JS config holds, or `QUORUM_<ROLE>_API_KEY`, which wins over a variable `apiKeyEnv` names. An empty one is unset, as a blank variable is, so the next source applies.
2. **The variable `apiKeyEnv` names.** A variable that is not set is an error, `providers.gateway: GATEWAY_KEY is not set`, never a silent run without a key.
3. **The preset's own variable** (`OPENAI_API_KEY` for `openai`, `MISTRAL_API_KEY` for `mistral`: the column of [Presets](./30-providers.md#presets)), only while the base URL keeps the preset's origin. At another origin it is not read, and a warning says so.

A `claude-code` provider has no preset, and takes a key in `api-key` mode only: the first two sources, else `ANTHROPIC_API_KEY`. In another mode a key is refused, `providers.claude.apiKey: is set, but auth is not api-key, so it would never be sent`, and so is an `apiKeyEnv`, `providers.claude.apiKeyEnv: is set, but auth is not api-key`, which is not read: [The auth modes](#the-auth-modes).

Three more rules keep a key at its own endpoint:

- **A base URL may not hold a user name or a password.** A server behind basic auth takes the base64 of `user:password` as the key, with `auth: { header: authorization, prefix: 'Basic ' }`: [The key header](./30-providers.md#the-key-header).
- **Keys are read only for the providers a profile that runs uses.** A job that runs one profile needs that profile's keys alone, and every provider is still checked, without its key.
- **A key sent over plain `http` to a host other than this machine** (`localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]` are this machine) is a warning: `providers.gateway.baseUrl: sends the key over plain http to a host other than this machine`.

No message, warning or line of `--print-config` repeats a key. [The keys](../95-reference/30-library-api.md#keys) of the library API have the rest, such as Azure's.

## Trust

A named config is trusted input, as code is. Naming it is the decision to trust it, because of three things it can do:

- **It chooses where each key goes.** A `baseUrl` beside an `apiKeyEnv` sends the key that variable holds to that host, whoever wrote the file.
- **A TS or JS config runs.** It runs when quorum loads it, with the job's environment, so everything the job holds, its keys included, is in its reach. A YAML or JSON config runs nothing.
- **Its prompt files are as trusted as it is.** A prompt path resolves against the config's directory without being confined to it, and a prompt is the instruction every model of the profile receives, so whoever writes it steers the review. A config copied from the base branch into the pull request's checkout, which names `./prompts/research.md`, reads the pull request's own copy of that prompt.

So in CI a named config comes from the base branch, or from another path the pull request cannot write, and never from the pull request's checkout, and its prompt files come from the same place. Check out the base branch's config directory, not one file of it:

```bash
git worktree add --detach ../base origin/main
git --attr-source=origin/main diff --no-textconv --no-ext-diff --no-color --submodule=short --ignore-submodules=none origin/main...HEAD | quorum --config ../base/ci/quorum.yaml > result.json
```

The diff reads the base branch's attributes too, not the checkout's: [Using it in CI](./10-cli.md#using-it-in-ci).

The runtime matters as much. `bun` reads a `.env` and a `bunfig.toml` from the working directory before quorum's own code runs. A planted `.env` can set `QUORUM_CONFIG`, which names a config of the pull request's (a TS or JS one then runs), or any other `QUORUM_*` variable, such as a base URL for the finder, and a planted `bunfig.toml` can run code. The binary reads neither, and neither does Node. Review a checkout with the binary, or with the `quorum` that `npm install -g` installs, which runs on Node, never with `bun run start`, and never through `npx`, `npm exec` or `pnpm dlx`, which read the checkout's `.npmrc`, where `npm install -g` does not read the project's: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).

[`--print-config`](./10-cli.md#printing-the-resolved-config) shows what a job will run: the file, the providers' origins, the profiles and a hash of each prompt, with no key.

## Configuration errors

Each of these exits `2` with `Error:` and the message, instead of the banner and before any model call; the CLI page lists the [usage errors](./10-cli.md#the-invocation) that come before them. No message repeats the value it is about: a base URL can carry credentials, a key is a secret, and a file can hold anything. A problem of the file is named by the path as it was given, `quorum.yaml: ...`; a problem after the layers merge is named by the field, `providers.gateway.model`, or by the variable that set it, `QUORUM_RESEARCH_BASE_URL`.

| Message | Cause |
| --- | --- |
| `--config: must name a file` | `--config=`, with no path |
| `--send: must name a file` | `--send=`, with no path. It is a usage error before any config is read |
| `QUORUM_CONFIG: must be an absolute path` | A relative `QUORUM_CONFIG`: set once, it would resolve inside whatever checkout quorum runs in. `--config` may be relative |
| `--profile: must be a profile id matching ^[a-z][a-z0-9_-]*$` | An empty `--profile`, or an id of another form |
| `--profile: names a profile more than once` | `-p security -p security` |
| `--fail-on: must be a level, high, medium, low or none, or <profile>=<level>` | A `--fail-on` value that is neither a level nor `<profile>=<level>` with a profile id matching `^[a-z][a-z0-9_-]*$`. It is a usage error: the usage follows the message, and the value is never repeated |
| `--fail-on: takes one level for every profile` | `--fail-on low --fail-on none`, or the same level twice. A usage error |
| `--fail-on: names a profile more than once` | `--fail-on security=low --fail-on security=none`. A usage error |
| `--fail-on: names the profile "nmaing", which does not run`, or `--fail-on: names a profile that does not run` | A `--fail-on <profile>=<level>` for a profile that is not among those that run, `-p` and `QUORUM_PROFILES` counted, a typo that would leave a gate weaker or missing. A configuration error: no usage text follows. The second text is for an id over 64 characters, which a message never prints |
| `--profile: unknown profile "nmaing" (did you mean "naming"?)`, or `unknown profile "nope": the profiles are security` | An id that the config neither defines nor builds in. `QUORUM_PROFILES` has the same two problems under its own name, and `QUORUM_PROFILES: must list profile ids separated by commas, each matching ^[a-z][a-z0-9_-]*$` for an empty id or an id of another form |
| `no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` | No file defines a provider, and no research model is set: the built-in provider has none. A blank diff meets it too |
| `no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens` | No file defines a provider, and no research context size is set: the built-in provider has none. A blank diff meets it too. A missing model is reported first, and alone |
| `providers.local.contextTokens: is required: the model's context window in tokens, which quorum checks every request against` | A provider of the file with no `contextTokens`, used by a profile or not: every provider is checked |
| `QUORUM_RESEARCH_CONTEXT_TOKENS: must be set when the research variables name a model or an endpoint: a context size belongs to one model on one endpoint` | The research variables name a preset, a protocol, a base URL or a model, which drops the file's context size for the provider they set: state one for it. `QUORUM_VOTER_CONTEXT_TOKENS: must be set when the voter variables name a model or an endpoint: a context size belongs to one model on one endpoint` is the same for the voter variables |
| `QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host` | The base URL is not an `http://` or `https://` URL with a host; a missing scheme is the usual slip |
| `QUORUM_RESEARCH_BASE_URL: must not hold a user name or password: send a key with apiKey` | The base URL holds a user name or a password. Send a key with `QUORUM_RESEARCH_API_KEY` or `apiKeyEnv` instead |
| `QUORUM_RESEARCH_BASE_URL: must not hold a query or a fragment` | The base URL holds a `?` or a `#`; quorum appends the endpoint's path to it |
| `QUORUM_RESEARCH_API_KEY: must only contain visible ASCII characters, which an HTTP header can carry` | The key, once trimmed, holds a space, a control character or a character outside ASCII |
| `QUORUM_VOTER_BASE_URL: ...`, `QUORUM_VOTER_API_KEY: ...` | The same two checks, for the panel's variables |
| `QUORUM_RESEARCH_CONTEXT_TOKENS: must be a whole number of tokens, from 1 to 999999999` | The variable is not a whole number written in decimal digits, from 1 to 999999999: `32k`, `1e5`, `0x10`, `1.5` and `0` are refused. `QUORUM_VOTER_CONTEXT_TOKENS` has the same check. The message never repeats the value |
| `QUORUM_RESEARCH_TIMEOUT_MS: must be a whole number of milliseconds, from 1000 to 86400000` | The variable is not a whole number written in decimal digits, from 1000 to 86400000: `999`, `120s`, `1e5`, `0x3e8` and `0120000` are refused. `QUORUM_VOTER_TIMEOUT_MS` has the same check. The message never repeats the value |
| `QUORUM_RESEARCH_STALL_TIMEOUT_MS: must be a whole number of milliseconds, from 1000 to 86400000` | The variable is not a whole number written in decimal digits, from 1000 to 86400000, as the deadline's is. `QUORUM_VOTER_STALL_TIMEOUT_MS` has the same check. The message never repeats the value |
| `QUORUM_RESEARCH_RETRIES: must be a whole number, from 0 to 5` | The variable is not a whole number written in decimal digits, from 0 to 5: `6`, `-1`, `1.5` and `02` are refused. `QUORUM_VOTER_RETRIES` has the same check. The message never repeats the value |
| `QUORUM_RESEARCH_STREAM: must be true or false` | The variable is neither `true` nor `false`, written exactly: `1`, `yes`, `True` and `on` are refused, never read as a switch. `QUORUM_VOTER_STREAM` has the same check. The message never repeats the value |
| `QUORUM_RESEARCH_THINKING: must be low or off` | The variable is neither `low` nor `off`: `medium`, `none` and `true` are refused, never clamped. `QUORUM_VOTER_THINKING` has the same check. The message never repeats the value |
| `providers.api.thinking: the anthropic protocol has no one setting that turns thinking off on every model: set thinking: low, or set thinking in extraBody for your model` | `thinking: off` on an `anthropic` provider. Set `low`, or put the control in `extraBody` for your model |
| `providers.cc.thinking: claude-code takes its effort from args: --effort low` | A `thinking` on a `claude-code` provider. Set `--effort` in `args` |
| `providers.local.thinking: is set, and extraBody sets think too: two settings for one control, so keep one` | `thinking` beside the protocol's own control in `extraBody`: `reasoning_effort`, `output_config.effort`, `generationConfig.thinkingConfig` or `think`. Keep one |
| `QUORUM_MAX_REVIEW_TOKENS: must be a whole number of tokens, from 1 to 9007199254740991` | The variable is not a whole number written in decimal digits, from 1 to 9007199254740991: `0`, `1e6`, `+5`, `02000000`, `2,000,000` and `9007199254740992` are refused, never rounded down. The message never repeats the value |
| `QUORUM_REVIEW_TIMEOUT_MS: must be a whole number of milliseconds, from 1000 to 86400000` | The variable is not a whole number written in decimal digits, from 1000 to 86400000: `999`, `86400001` and `30m` are refused. The message never repeats the value |
| `providers.local.contextTokens: must be more than 512, the tokens kept for the chat template` | A window that leaves no room even for the chat template, with `maxTokens` unset: raise the window. Set by a variable, the issue names the variable instead |
| `providers.local.contextTokens: must be more than 1000, the 488 tokens of the reply budget and 512 for the chat template` | A window that leaves no room for a request beside the `maxTokens` set: lower `maxTokens`, or raise the window |
| `profiles.security: the research request on local leaves -630 tokens for the diff, less than the 1024 a hunk may need: contextTokens 2000 counts 1618 for the instructions, guidelines and rules, 512 for the chat template and 500 for the reply: shorten the guidelines or rules, lower maxTokens, or state a larger window` | A profile whose research request, with an empty diff, leaves its provider less than 1024 tokens for the diff. It is refused before any diff is read, and before a source error: [Room accounting](#room-accounting) |
| `profiles.security: the vote request on small for the longest finding leaves 188 tokens for the diff, less than the 1024 a hunk may need: contextTokens 2000 counts 800 for the instructions, guidelines and finding, 512 for the chat template and 500 for the reply: shorten the guidelines, lower maxTokens, or state a larger window` | The same for a voter, the vote of the longest finding, one line for each lens refused: [Room accounting](#room-accounting) |
| `--state: is a symbolic link`, `is not a directory`, `is owned by another user`, `can be written by its group or by others: chmod 700 it`, `lies inside a git work tree, which a change could write to: name a directory outside every repository`, `holds files but no quorum-state.json, so it is not a state directory quorum made: name an empty or new directory`, `holds a quorum-state.json quorum did not write`, or `cannot be created` or `cannot be read` with an error code | A state directory the store refuses, before any call. None names the path: [Saved state](#saved-state). A `--state` that is empty, given twice or given with `--print-config`, and a `--no-state` given with `--state` or `--print-config`, are usage errors, listed on [the CLI page](./10-cli.md#the-invocation). The default directory's refusals are the same words after `warning: the default state directory`, and skip it instead of failing the review |
| `QUORUM_VOTER_MODEL: must be set when the voter variables name another endpoint than the research provider's` | A panel on another origin, a preset or a protocol, without a model of its own |
| `QUORUM_RESEARCH_PRESET: must be one of ollama, ollama-cloud, ...` | The builder refuses what a variable set: the issue names the variable. Every `QUORUM_` variable of a role does the same |
| `QUORUM_RESEARCH_MODEL: cannot change providers.mine, an object implementing Provider` | A variable set for a role bound to a provider object |
| `quorum.yaml: does not exist`, `is not a file`, `cannot be read`, `is over 1 MiB` or `is not UTF-8 text` | The file cannot be read as a config |
| `quorum.txt: must end in .yaml, .yml, .json, .mts, .mjs, .ts or .js` | The extension chooses the format, so another one is refused |
| `quorum.yaml: is not valid YAML at line 3, column 1 (BAD_INDENT)`, or `quorum.json: is not valid JSON` | The file is not valid YAML, or not valid JSON; a YAML alias, a repeated key and a YAML 1.1 tag are refused too |
| `quorum.yaml: is empty` | The file is empty, holds only comments, or holds `null` |
| `quorum.yaml: must hold a mapping of settings` | The file holds a list or a scalar |
| `quorum.yaml: providers.a.modl: is not a known field` | A field quorum does not know, `apiKey` in a YAML or JSON file included. Every issue of the file is reported at once, one per line |
| `quorum.yaml: version: must be 1, the only config version this quorum reads: upgrade quorum to read a later one` | A `version` other than `1` |
| `quorum.yaml: profiles.naming.prompts.research.file: does not exist` | A prompt file that cannot be read: it does not exist, is not a file, is over 64 KiB, is not UTF-8, or takes the prompt files over 1 MiB in all |
| `quorum.yaml: profiles.naming.failOn: must be one of high, medium, low or none` | A `failOn` that is none of the four levels |
| `profiles.naming.gating: is deprecated and cannot be set with failOn: remove it` | A profile that sets both `failOn` and the deprecated `gating`: set `failOn` alone |
| `quorum.yaml: exclude.2: ends with /, so it matches no file: end it with /** to leave out what the directory holds` | A pattern that can mislead; [Excludes](#excludes) lists what each message refuses |
| `quorum.yaml: exclude: must hold at most 100 patterns` | More than 100 patterns |
| `quorum.yaml: send.1: must name a file` | An entry of `send` that is empty or is no string: [Sending a held file](#sending-a-held-file) |
| `quorum.yaml: maxReviewTokens: must be at least 1`, `must be an integer`, `must be a number` or `must be at most 9007199254740991` | A `maxReviewTokens` that is not a whole number of tokens from 1 to 9007199254740991: `0`, `1.5`, `'5'` and `9007199254740992` are refused |
| `quorum.yaml: partTokens: must be at least 1024`, `must be an integer`, `must be a number` or `must be at most 9007199254740991` | A `partTokens` that is not a whole number of tokens from 1024 to 9007199254740991: `1023`, `1.5`, `'32768'` and a value written in thousands, `32`, are refused, never raised |
| `quorum.yaml: reviewTimeoutMs: must be at least 1000` or `must be at most 86400000` | A `reviewTimeoutMs` outside 1000 to 86400000 ms: `999` and `86400001` are refused; a value that is no whole number is `must be an integer` or `must be a number`, as every number of a config is |
| `quorum.config.mts: has a syntax error`, `failed to load (Error)` or `must export an object as its default` | A TS or JS config that does not load, whose code threw, or whose default export is not an object. Only the error's name is kept: what a config threw can hold a secret |
| `roles.research: is required when several providers are defined` | Several providers, and no research role |
| `roles.research: unknown provider "aa" (did you mean "a"?)` | A role, a profile's role or a lens's `provider` names a provider that is not defined |
| `providers.gateway: GATEWAY_KEY is not set` | The variable `apiKeyEnv` names, or the preset's own, is not set. For a `claude-code` provider in `api-key` mode it is `ANTHROPIC_API_KEY`, when `apiKeyEnv` names no other |
| `providers.default: claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND` | A `claude-code` provider a profile uses, and no `QUORUM_CLAUDE_CODE_COMMAND`, no `command` and no `claude` in an absolute entry of `PATH` |
| `QUORUM_CLAUDE_CODE_COMMAND: must be an absolute path, or a name to find on PATH` | A relative path with a separator: it would resolve inside the checkout. `QUORUM_CLAUDE_CODE_COMMAND: is a Windows script, which runs only through a shell: name claude.exe instead` is a `.cmd` or `.bat` file |
| `QUORUM_CLAUDE_CODE_COMMAND: names no executable file` | The variable names a file that is not an executable regular file, or a name found on no absolute entry of `PATH`. A code config's `command` has the same issue at `providers.claude.command` |
| `providers.claude.command: is not a known field` | A YAML or JSON provider that names the executable: only a code config may |
| `providers.local.model: is required` | A provider of the file with no model |
| `profiles.mine.prompts.research: is required: the profile extends no built-in profile` | A profile of its own without both prompts and its lenses |
| `providers.voter: is the name the voter variables give the provider they derive: rename this provider` | The voter variables must derive a provider, and the config has one named `voter` |

The other issues of a provider, a preset or a profile are the builder's and the profile checks': [Configuration errors](./30-providers.md#configuration-errors), [Claude Code configuration errors](./30-providers.md#claude-code-configuration-errors) for a `claude-code` provider, and [The checks](./40-profiles.md#the-checks), with the path of the provider or profile in front. The library API has [the whole table](../95-reference/30-library-api.md#warnings-and-errors), with the warnings.

A step reports every problem it finds at once, one per line, and the steps run in order: the file is read and checked before the layers are resolved, so a file that fails its checks reports those alone. A base URL and a key that are both wrong:

```text
Error: QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host
QUORUM_RESEARCH_API_KEY: must only contain visible ASCII characters, which an HTTP header can carry
```

## Next

[Providers](./30-providers.md) — what a provider is, the shipped adapters, the presets and the options a config sets on each, their errors, and writing a provider of your own.
