# Configuration

The CLI reads its settings from three sources, each laid over the one before: the built-in defaults, a config file the CLI is named, and the environment. The flags come last: `--config` names the file and `--profile` chooses which profiles run. With no file named, `QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS` set, the defaults and those two variables are enough: the CLI reviews against Ollama on this machine. This page covers the config file, how to name it, how the layers combine, the `QUORUM_*` variables, the voter's fallback, the context size, running Claude Code, the keys, the trust a named config needs in CI, and the errors a bad setting causes.

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
    gating: false
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

- **`providers`** names each endpoint, by a name of lower-case letters, digits, `_` and `-`, which starts with a letter. A provider starts from a [preset](./30-providers.md#presets), or from a `protocol` and a `baseUrl`, and sets the [options](./30-providers.md#options) of its adapter: its `contextTokens` ([The context size](#the-context-size)), `auth`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField` and `systemPrompt`. One with `protocol: claude-code` runs your Claude Code CLI instead, has no base URL, and sets `args` besides: [Claude Code](#claude-code).
- **`roles`** says which provider researches and which votes. A profile's own `roles`, and a lens's `provider`, override them.
- **`profiles`** defines the review profiles: [Profiles](./40-profiles.md), [Lenses and policy](./50-lenses-and-policy.md) and [Prompts](./60-prompts.md) say what each field means. A prompt is a string, or `{ file }`: the file's text. A prompt file resolves against the directory of the config file, whatever the working directory is, and holds at most 64 KiB, and the prompt files of a config 1 MiB in all.

The JSON Schema in [`schema/quorum.schema.json`](../../schema/quorum.schema.json) lets an editor check and complete a YAML or JSON config. A YAML file names it in a comment on its first line, `# yaml-language-server: $schema=<path or URL of the schema>`, as the example does with the path of a clone beside the directory that holds the config; a JSON file names it in its `"$schema"` field. Quorum itself ignores both.

A TS or JS config types its object with `import type` and `satisfies`, which Node and Bun erase when they load the file. This one is the same providers as above, with the gateway's key read from the environment by code:

```ts
// quorum.config.mts
import type { QuorumConfig } from './src/index.ts'

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

Name the file `.mts` or `.mjs`: the extension makes it an ES module whatever the nearest `package.json` says, where `export` in a `.ts` or `.js` file of a package whose `package.json` says `"type": "commonjs"` is a syntax error. Node strips erasable TypeScript only, so a config holds no `enum`, `namespace` or parameter property. The import path matters to the editor alone: point it at the clone's `src/index.ts`. [Config types](../95-reference/30-library-api.md#config-types) lists every field.

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

1. **The built-in defaults.** A config that defines no provider gets one named `default`: the OpenAI-compatible protocol at `http://localhost:11434/v1`, Ollama's address, with the adapter's own defaults ([`openaiCompatible`](./30-providers.md#openaicompatible)) and no model. Without a file, then, `QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS` are the two settings the CLI requires, and `no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` and `no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens` are the errors without them, the model's first. A config that defines providers has no `default` one, and a provider of its own with no model is `providers.<name>.model: is required`, with no context size `providers.<name>.contextTokens: is required: ...` ([The context size](#the-context-size)).
2. **The file**, when one is named: its providers, roles and profiles.
3. **The environment.** The `QUORUM_*` variables of a role set fields of the provider that role is bound to: [The environment variables](#the-environment-variables). A variable never changes a provider object that a TS or JS config defines: it is an error.
4. **The flags.** `--config` names the file, and `--profile` chooses the profiles.

The roles bind a provider to the finder and to the panel. One provider binds both. Several providers need `roles.research`, or the config is refused, and `roles.voter` is `roles.research` when it is unset.

The profiles that run are the ones `--profile` names, else the ones `QUORUM_PROFILES` names, else every profile the file's `profiles` defines, else the `security` profile alone. A file that defines `profiles` therefore runs those and no other: list `security` as well to keep it. A profile named `security`, or one with `extends: security`, starts from the built-in profile and replaces its prompts and policy levels one at a time and its lenses as a whole; any other profile needs both prompts and its lenses. A profile of the file that no selection names is still checked, as is every provider, so a broken definition fails every run.

## The environment variables

| Variable | Sets |
| --- | --- |
| `QUORUM_CONFIG` | The config file to read, when `--config` does not name one. It must be an absolute path |
| `QUORUM_PROFILES` | The profiles that run: ids separated by commas, each a profile the config defines or a built-in one, none twice. `--profile` wins over it, and a malformed value is refused even then |
| `QUORUM_RESEARCH_PRESET`, `QUORUM_VOTER_PRESET` | A role's provider, built from a [preset](./30-providers.md#presets) |
| `QUORUM_RESEARCH_PROTOCOL`, `QUORUM_VOTER_PROTOCOL` | A role's provider, built from a wire protocol: `openai-compatible`, `anthropic`, `gemini` or `ollama`, or `claude-code` for your installed Claude Code CLI: [Claude Code](#claude-code) |
| `QUORUM_RESEARCH_BASE_URL`, `QUORUM_VOTER_BASE_URL` | The base URL of a role's provider. Requests go to it, its trailing slashes removed, followed by the adapter's path, `/chat/completions` for `openai-compatible` |
| `QUORUM_RESEARCH_MODEL`, `QUORUM_VOTER_MODEL` | The model of a role's provider, as its endpoint names it |
| `QUORUM_RESEARCH_CONTEXT_TOKENS`, `QUORUM_VOTER_CONTEXT_TOKENS` | The context window of a role's provider's model, in tokens: a whole number from 1 to 999999999. It has no deprecated alias |
| `QUORUM_RESEARCH_API_KEY`, `QUORUM_VOTER_API_KEY` | The key of a role's provider, sent in the header its `auth` names, `Authorization: Bearer <key>` by default. Without a key, no key header is sent |
| `QUORUM_CLAUDE_CODE_COMMAND` | The `claude` executable of every `claude-code` provider a profile uses: an absolute path, or a name found in the absolute entries of `PATH`. A relative path and a `.cmd` or `.bat` file are refused. It wins over a code config's `command`, which a YAML or JSON config cannot hold: [Where the command comes from](#where-the-command-comes-from) |
| `RESEARCH_BASE_URL`, `RESEARCH_API_KEY`, `RESEARCH_MODEL`, `VOTER_BASE_URL`, `VOTER_API_KEY`, `VOTER_MODEL` | Deprecated aliases: each is read as the `QUORUM_` variable of the same name |

- **The research variables** set the provider `roles.research` names. A voter or a lens that shares that provider inherits what they set, and the `QUORUM_RESEARCH_*` variables never fall back to the voter ones.
- **The voter variables** set the provider `roles.voter` names when it is another provider than the finder's. When the panel shares the finder's provider, they derive a provider of their own: [The voter's fallback](#the-voters-fallback).
- **`QUORUM_CLAUDE_CODE_COMMAND` belongs to no role.** It names the executable of every `claude-code` provider, whichever role it serves, and is never read from a data file.
- **The deprecated aliases** still work, with one `warning:` line that names every alias that is set and the variable to set instead, such as `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead`. When both forms are set, the `QUORUM_` one wins. A preset and a protocol have no alias.
- **A preset or a protocol variable builds the role's provider afresh.** `QUORUM_RESEARCH_PRESET=anthropic` is not merged into a provider whose protocol it would contradict: the finder's provider is then a provider of that preset, from the role's variables alone. A base URL, a model, a context size and a key variable alone override the fields of the provider they reach.
- **A context size belongs to one model on one endpoint.** A role's preset, protocol, base URL or model variable drops the context size of the provider it sets, unless `QUORUM_<ROLE>_CONTEXT_TOKENS` sets one; a key variable alone keeps it.
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
| Unset | The finder's | `QUORUM_VOTER_API_KEY`, else the finder's key | `QUORUM_VOTER_MODEL`, else the finder's | `QUORUM_VOTER_CONTEXT_TOKENS`, else the finder's while no other voter variable but the key is set | All kept |
| The same origin as the finder's | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else the finder's key | `QUORUM_VOTER_MODEL`, else the finder's | `QUORUM_VOTER_CONTEXT_TOKENS` only | All kept |
| Another origin, or no `http(s)` origin | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else no key: a preset's own variable is not read | `QUORUM_VOTER_MODEL`, which is then required | `QUORUM_VOTER_CONTEXT_TOKENS` only | `apiKeyEnv`, `headers`, `query`, `extraBody` and the model are dropped; the preset, protocol, `auth`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField` and `systemPrompt` are kept |
| `QUORUM_VOTER_PRESET` or `QUORUM_VOTER_PROTOCOL` is set | Its own, or the preset's | `QUORUM_VOTER_API_KEY`, else the preset's own variable at the preset's origin | `QUORUM_VOTER_MODEL`, which is then required | `QUORUM_VOTER_CONTEXT_TOKENS` only | None: the provider is built from the voter variables alone |

The deprecated `VOTER_BASE_URL`, `VOTER_API_KEY` and `VOTER_MODEL` fall back the same way, as `QUORUM_VOTER_*`. When `roles.voter` names another provider than the finder's, the voter variables set that provider's fields as the research variables set the finder's, and nothing falls back. A config that already defines a provider named `voter` cannot have one derived over it: rename it.

The voter never inherits the finder's context size for another model or another endpoint. A context size describes one model on one endpoint, so a voter variable that names a model, a base URL, a preset or a protocol leaves the voter without one until `QUORUM_VOTER_CONTEXT_TOKENS` sets it: the finder's window means nothing for a model that is not the finder's.

The origin is the scheme, the host and the port, compared once both URLs are parsed. Letter case, a default port written out (`:443` on `https`), one trailing dot after the host (`h.example.` is `h.example`) and the path never make another origin, so a gateway that serves several paths on one origin shares its key. `http` against `https`, or another port, does, so a fallback never carries a key from an encrypted connection to a cleartext one. A value without an `http(s)` origin, such as `localhost:11434/v1` without its scheme, or one that does not parse as a URL, inherits nothing, and then fails the base URL check: [Configuration errors](#configuration-errors).

A panel on another endpoint must name its model. The finder's model name usually means nothing there, and an error before the review is better than a review in which every vote fails.

A `claude-code` finder has no base URL, so it has no origin, and a panel the voter variables derive from it counts as being on another endpoint. It keeps the finder's `protocol`, `auth`, `args`, `structuredOutput` and `command`, and drops the key variable, the model and the context size, so `QUORUM_VOTER_MODEL` and `QUORUM_VOTER_CONTEXT_TOKENS` state them: `QUORUM_VOTER_MODEL=haiku` with `QUORUM_VOTER_CONTEXT_TOKENS=1000000` votes through the same CLI on another model. A panel in `api-key` mode reads `ANTHROPIC_API_KEY`, as any `claude-code` provider in that mode does.

## The context size

`contextTokens` is the model's whole context window in tokens, prompt and reply together: the number a vendor calls its context window or context length. Quorum checks every request against it before sending, and refuses one that may not fit, so that a prompt a server would cut in silence is never reviewed as if the model had read it. A refused request is a `request-too-large` gap, which exits `4` for a gating profile whatever the flags: [Exit codes](./10-cli.md#exit-codes). [The size of a request](./30-providers.md#the-size-of-a-request) says how a request is counted.

Every provider defined as data, an HTTP one or a `claude-code` one, must state one, whether a profile that runs uses it or not, since every provider is checked: a provider without one is refused before any request, with exit `2` and a message that names what to set ([Configuration errors](#configuration-errors)). Even a hosted API that refuses an oversized prompt itself is held to it, since on a vote that refusal would be a failed vote, which `--allow-incomplete` lifts, and only a refusal quorum makes itself is kept out of the flag's reach. A provider object, which a TS or JS config defines, states none: it is its author's code and checks its own requests ([Writing a provider](./30-providers.md#writing-a-provider)). The built-in `default` provider has none either, so `QUORUM_RESEARCH_CONTEXT_TOKENS` is required with it. A panel that shares the finder's provider, context size included, is reported by the finder's issue alone, whether the size is missing, malformed or leaves no room: the user wrote one value, and reads one line, at the place they set it.

A provider's context size comes from, in this order:

1. **The provider's `contextTokens`**, a whole number from 1 to 999999999, in the config file or in a code config.
2. **`QUORUM_RESEARCH_CONTEXT_TOKENS` or `QUORUM_VOTER_CONTEXT_TOKENS`**, which set the field of the role's provider as the other role variables do, over the file's. A value that is not a whole number from 1 to 999999999 written in decimal digits is refused at its variable, `32k`, `1e5` and `0x10` included.
3. **Nowhere else**: quorum does not read it from the endpoint or from a table of models.

A context size belongs to one model on one endpoint, so it never crosses to another: a role's variables that name a preset, a protocol, a base URL or a model drop the context size of the provider they set, unless they set one, and the derived voter does not inherit the finder's for another model or endpoint ([The voter's fallback](#the-voters-fallback)). A key variable alone keeps it.

[`--print-config`](./10-cli.md#printing-the-resolved-config) shows each provider's `contextTokens` after its `model`.

### Finding the number

The number is the window the server gives the model, which can be less than the model's maximum. Where to read it:

- **Ollama** picks 4096, 32768 or 262144 tokens by the GPUs' memory, unless `OLLAMA_CONTEXT_LENGTH` or a Modelfile's `num_ctx` says otherwise, and `ollama ps` shows the loaded one in its `CONTEXT` column once the model has run. The `ollama` preset sends `num_ctx` itself, so its context is the one you state, capped by the model's own maximum, which `ollama show <model>` prints. On Ollama's `/v1`, the built-in provider's endpoint, quorum cannot set it: set `OLLAMA_CONTEXT_LENGTH` on the server to at least `contextTokens`, and trust `ollama ps`, since a Modelfile's `num_ctx` or the model's own default outranks the variable for `/v1` requests.
- **llama.cpp** splits the context its `-c` option sets across its `-np` slots unless the KV cache is unified, and a request gets one slot's share: state the per-slot `n_ctx` that `/props` reports.
- **vLLM** serves what its `--max-model-len` option sets.
- **LM Studio** serves the context length the model is loaded with, not the maximum it supports: its documentation shows a model loaded with 4096 tokens of the 262144 it takes.
- **A hosted API** states it on the model's page or on its models endpoint: `max_input_tokens` for Anthropic, `inputTokenLimit` for Gemini, `max_context_length` for Mistral, `context_length` for OpenRouter. Anthropic's and Gemini's are limits of the input alone, which is the safe side, since the guard keeps the room of the reply inside them.
- **An Azure deployment** has its own limit, which can differ from the documented one of its model.

A number above the real window defeats the guard, which counts against the number it is given. An endpoint that cuts a prompt in silence, Ollama's `/v1` or an OpenRouter endpoint of 8192 tokens or less among them, then answers as if it had read all of it. When in doubt, state the smaller number.

### What it counts, and what it costs

A request is counted at one token per byte of what it carries, each code point at its longest form (as it is, decomposed, or compatibility-decomposed), so that a tokenizer that normalizes with NFC, NFKC, NFD or NFKD first stays bounded. Case folding is not proven covered. Accented letters count one more byte per accent, and Hangul syllables up to three times their size. The count adds 512 tokens for the chat template (4096 for a `claude-code` provider, [The context size of Claude's models](#the-context-size-of-claudes-models)) and the reply budget, `maxTokens` else 16000, and the request is sent only when the sum is at most `contextTokens`: [The size of a request](./30-providers.md#the-size-of-a-request) has the rule and the message of a refusal.

One token per byte is the price of a bound that holds for every tokenizer checked. Code runs about three bytes per token, so the guard accepts about a third of the diff that would really fit. The diff that a research request of the `security` profile leaves room for, as ASCII text with no guidelines, `maxTokens` unset and the default `systemPrompt: 'native'` (`inline` leaves 2 bytes less):

| `contextTokens` | The largest diff, in bytes |
| --- | --- |
| `32768` | 14,757 |
| `65536` | 47,525 |
| `131072` | 113,061 |
| `200000` | 181,989 |
| `1000000` | 981,989 |

Each row is `contextTokens` less 18,011: 1,499 bytes of instructions, fences and reply schema, 512 tokens for the chat template and 16000 for the reply. `maxTokens: 4096` adds 11,904 bytes to each row, and the guidelines of a profile take room of their own. A vote request carries the diff section of the cited file (the whole diff when the file has no section of its own), up to five lines of evidence and the claim, and reserves the same reply budget, so a diff of one file that barely fits its research request can have its votes refused. A panel on a smaller model refuses sooner.

### Raising the limit knowingly

To review a larger diff, change what is true and state it, not what is counted:

- **Give the model a larger window on the server, and state it.** Raise `OLLAMA_CONTEXT_LENGTH`, llama.cpp's `-c`, vLLM's `--max-model-len` or the context length LM Studio loads, then set `contextTokens` to the number the server really loads. A larger window costs the server memory.
- **Lower `maxTokens`** to what the model needs to answer. The server then stops the reply there, and the reserve shrinks with it: 4096 leaves 11,904 bytes more. A thinking model needs more, and a reply cut off at the limit is a failed call, not a shorter review. `maxTokens` is the one setting of the reply limit: `extraBody` cannot set `max_tokens` or its equivalents ([The size of a request](./30-providers.md#the-size-of-a-request)).
- **Review fewer commits at once.** Quorum does not split or filter a diff that does not fit: it refuses the request.

Two other ways are not offered, because each reopens the padding attack that [The size guard](../30-security/10-threat-model.md#the-size-guard) describes:

- **A bytes-per-token ratio.** Encoded content, such as base64, hex, CJK text or emoji, takes 1 to 1.5 bytes per token, so a pull request could pad past any ratio above one.
- **Lifting the gap with `--allow-incomplete`.** It would let the same padding through for a gating profile.

Neither of these is done today. Counting with a vendor's own tokenizer would shrink the margin, since one token per byte overestimates code about three times, so it would accept more of a diff. Reading the window from the endpoint would take the smaller of its number and yours, so it could only lower what is accepted. Neither would take the window past the number you state.

### What happens

A refused research request leaves its profile with no finding and a `request-too-large` gap, and the other profiles run. A refused vote is a failed vote ([Failed votes](./50-lenses-and-policy.md#failed-votes)), and its finding records a `request-too-large` gap as well, whatever its status: kept, discarded or `unreviewed`, the gap stays. A gating profile with such a gap exits `4`, even with `--allow-incomplete`, unless it also kept a `high` finding, which exits `1`; the gap of an advisory profile changes no code. The result says what was not sent: [Incomplete reasons](../95-reference/20-json-result.md#incomplete-reasons). A provider with no context size is a configuration error, exit `2`, before any request.

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

- **`protocol: claude-code` has no preset and no base URL.** `preset: claude-code` is refused as an unknown preset, and a `baseUrl`, `headers`, `query`, `extraBody`, `temperature`, `maxTokens` or `systemPrompt` is refused.
- **`auth`** is `inherit`, `login` or `api-key`, `inherit` when unset: [The auth modes](#the-auth-modes).
- **`args`** passes `--effort`, `--fallback-model`, `--max-budget-usd` and, in `api-key` mode, `--betas`, each followed by its value or written `--flag=value`. No other flag is accepted, so `args` cannot loosen the isolation: [Claude Code options](./30-providers.md#claude-code-options).
- **`structuredOutput`** is `schema` by default, and `prompt` leaves the reply's shape to the prompt.
- **`apiKeyEnv`** names the variable that holds the key in `api-key` mode, `ANTHROPIC_API_KEY` by default.
- **A YAML or JSON provider cannot name the executable.** `command` is code-only: [Where the command comes from](#where-the-command-comes-from).

### The context size of Claude's models

`contextTokens` is what the model gives you, stated as for any provider: [The context size](#the-context-size). On Anthropic's API, `sonnet`, `opus` and `haiku` resolve to models with a 1M window, so `1000000`. On Bedrock and Vertex, `sonnet` and `haiku` resolve to the 4.5 models, whose window is `200000`. A 4.6 model has the 1M window only with the `[1m]` suffix, as in `opus[1m]`, and `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` in the environment holds the 1M models to 200K. When in doubt, state the smaller number.

The guard keeps 4096 tokens for what Claude Code adds around the messages and 16000 for the reply, so the window must be more than 20096, and the diff a research request of the `security` profile leaves room for is `contextTokens` less 21,595 bytes: 1,499 of instructions, fences and reply schema, 4096 and 16000. [The size of a Claude Code request](./30-providers.md#the-size-of-a-claude-code-request) has the rule.

### The auth modes

- **`inherit`**, the default, runs `claude` with your environment as it is, so it authenticates as `claude -p` does on its own. Claude Code takes the first credential that is set, in its own order: a cloud provider (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY`), `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, an `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, an Anthropic profile or federation, then the `/login` session. Quorum has `claude` read no settings file, so an `apiKeyHelper`, or the cloud provider or base URL that an `env` block of your settings file sets, is not applied: `inherit` equals your own `claude -p` for the environment's variables only. An organization's managed settings still apply.
- **`login`** forces the Claude Code login: the subscription session of `/login`, or in CI the `CLAUDE_CODE_OAUTH_TOKEN` that `claude setup-token` prints. Every variable that would pick another credential or another host is removed, so the login always reaches Anthropic's own API: [The auth modes](./30-providers.md#the-auth-modes) lists them.
- **`api-key`** hands an API key to `claude` in its environment, as `ANTHROPIC_API_KEY`, and nowhere else, with `--bare`. It reads the variable `apiKeyEnv` names, else `ANTHROPIC_API_KEY`, so `auth: api-key` alone works, and a variable that is not set is exit `2`, `providers.claude: ANTHROPIC_API_KEY is not set`. A code config may hold the key in `apiKey`. Under `--bare` Claude Code reads no login, so the key is the credential.

**The billing warning.** Headless Claude Code uses `ANTHROPIC_API_KEY` whenever it is set, rather than the login. So a provider a profile uses that runs under `inherit`, or sets no `auth`, while `ANTHROPIC_API_KEY` is set, gets one warning, which never prints the key:

```text
warning: providers.default: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key
```

**In CI**, use an API key, with `auth: api-key`, or the `CLAUDE_CODE_OAUTH_TOKEN` of `claude setup-token` with `auth: login`. Anthropic's usage policy does not explicitly address a program that wraps its CLI. Its Agent SDK documentation says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in this document instead." Quorum never reads, stores or forwards a Claude credential in the `inherit` and `login` modes: it runs your own CLI, which authenticates however you set it up. So use an API key, or the `anthropic` adapter, for CI, and the login as an opt-in for personal use.

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

A `claude-code` provider has no preset, and takes a key in `api-key` mode only: the first two sources, else `ANTHROPIC_API_KEY`. In another mode a key is refused, `providers.claude.apiKey: is set, but auth is not api-key, so it would never be sent`: [The auth modes](#the-auth-modes).

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
git diff origin/main...HEAD | quorum --config ../base/ci/quorum.yaml > result.json
```

The runtime matters as much. `bun` reads a `.env` and a `bunfig.toml` from the working directory before quorum's own code runs. A planted `.env` can set `QUORUM_CONFIG`, which names a config of the pull request's (a TS or JS one then runs), or any other `QUORUM_*` variable, such as a base URL for the finder, and a planted `bunfig.toml` can run code. The binary reads neither, and neither does Node. Review a checkout with the binary, or with Node 22.18 or later as `node /path/to/quorum/src/cli/bin.ts`, never with `bun run start`: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).

[`--print-config`](./10-cli.md#printing-the-resolved-config) shows what a job will run: the file, the providers' origins, the profiles and a hash of each prompt, with no key.

## Configuration errors

Each of these exits `2` with `Error:` and the message, instead of the banner and before any model call; the CLI page lists the [usage errors](./10-cli.md#the-invocation) that come before them. No message repeats the value it is about: a base URL can carry credentials, a key is a secret, and a file can hold anything. A problem of the file is named by the path as it was given, `quorum.yaml: ...`; a problem after the layers merge is named by the field, `providers.gateway.model`, or by the variable that set it, `QUORUM_RESEARCH_BASE_URL`.

| Message | Cause |
| --- | --- |
| `--config: must name a file` | `--config=`, with no path |
| `QUORUM_CONFIG: must be an absolute path` | A relative `QUORUM_CONFIG`: set once, it would resolve inside whatever checkout quorum runs in. `--config` may be relative |
| `--profile: must be a profile id matching ^[a-z][a-z0-9_-]*$` | An empty `--profile`, or an id of another form |
| `--profile: names a profile more than once` | `-p security -p security` |
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
| `providers.local.contextTokens: must be more than 16512, the 16000 tokens of the reply budget and 512 for the chat template` | A window that leaves no room for a request beside the reply budget: lower `maxTokens`, or raise the window. Set by a variable, the issue names the variable instead |
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
