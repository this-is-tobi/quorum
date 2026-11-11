# Configuration

The CLI reads its settings from three sources, each laid over the one before: the built-in defaults, a config file the CLI is named, and the environment. The flags come last: `--config` names the file and `--profile` chooses which profiles run. With no file named and `QUORUM_RESEARCH_MODEL` set, the defaults and that one variable are enough: the CLI reviews against Ollama on this machine, as it always did. This page covers the config file, how to name it, how the layers combine, the `QUORUM_*` variables, the voter's fallback, the keys, the trust a named config needs in CI, and the errors a bad setting causes.

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
  gateway:
    protocol: openai-compatible
    baseUrl: https://llm.corp.example/v1
    model: review-1
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

- **`providers`** names each endpoint, by a name of lower-case letters, digits, `_` and `-`, which starts with a letter. A provider starts from a [preset](./30-providers.md#presets), or from a `protocol` and a `baseUrl`, and sets the [options](./30-providers.md#options) of its adapter: its `auth`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField` and `systemPrompt`.
- **`roles`** says which provider researches and which votes. A profile's own `roles`, and a lens's `provider`, override them.
- **`profiles`** defines the review profiles: [Profiles](./40-profiles.md), [Lenses and policy](./50-lenses-and-policy.md) and [Prompts](./60-prompts.md) say what each field means. A prompt is a string, or `{ file }`: the file's text. A prompt file resolves against the directory of the config file, whatever the working directory is, and holds at most 64 KiB, and the prompt files of a config 1 MiB in all.

The JSON Schema in [`schema/quorum.schema.json`](../../schema/quorum.schema.json) lets an editor check and complete a YAML or JSON config. A YAML file names it in a comment on its first line, `# yaml-language-server: $schema=<path or URL of the schema>`, as the example does with the path of a clone beside the directory that holds the config; a JSON file names it in its `"$schema"` field. Quorum itself ignores both.

A TS or JS config types its object with `import type` and `satisfies`, which Node and Bun erase when they load the file. This one is the same providers as above, with the gateway's key read from the environment by code:

```ts
// quorum.config.mts
import type { QuorumConfig } from './src/index.ts'

export default {
  providers: {
    local: { preset: 'ollama', model: 'qwen3.6:27b' },
    gateway: {
      protocol: 'openai-compatible',
      baseUrl: 'https://llm.corp.example/v1',
      model: 'review-1',
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

1. **The built-in defaults.** A config that defines no provider gets one named `default`: the OpenAI-compatible protocol at `http://localhost:11434/v1`, Ollama's address, with the adapter's own defaults ([`openaiCompatible`](./30-providers.md#openaicompatible)) and no model. Without a file, then, `QUORUM_RESEARCH_MODEL` is the one setting the CLI requires, and `no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` is the error without it. A config that defines providers has no `default` one, and a provider of its own with no model is `providers.<name>.model: is required`.
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
| `QUORUM_RESEARCH_PROTOCOL`, `QUORUM_VOTER_PROTOCOL` | A role's provider, built from a wire protocol: `openai-compatible`, `anthropic`, `gemini` or `ollama` |
| `QUORUM_RESEARCH_BASE_URL`, `QUORUM_VOTER_BASE_URL` | The base URL of a role's provider. Requests go to it, its trailing slashes removed, followed by the adapter's path, `/chat/completions` for `openai-compatible` |
| `QUORUM_RESEARCH_MODEL`, `QUORUM_VOTER_MODEL` | The model of a role's provider, as its endpoint names it |
| `QUORUM_RESEARCH_API_KEY`, `QUORUM_VOTER_API_KEY` | The key of a role's provider, sent in the header its `auth` names, `Authorization: Bearer <key>` by default. Without a key, no key header is sent |
| `RESEARCH_BASE_URL`, `RESEARCH_API_KEY`, `RESEARCH_MODEL`, `VOTER_BASE_URL`, `VOTER_API_KEY`, `VOTER_MODEL` | Deprecated aliases: each is read as the `QUORUM_` variable of the same name |

- **The research variables** set the provider `roles.research` names. A voter or a lens that shares that provider inherits what they set, and the `QUORUM_RESEARCH_*` variables never fall back to the voter ones.
- **The voter variables** set the provider `roles.voter` names when it is another provider than the finder's. When the panel shares the finder's provider, they derive a provider of their own: [The voter's fallback](#the-voters-fallback).
- **The deprecated aliases** still work, with one `warning:` line that names every alias that is set and the variable to set instead, such as `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead`. When both forms are set, the `QUORUM_` one wins. A preset and a protocol have no alias.
- **A preset or a protocol variable builds the role's provider afresh.** `QUORUM_RESEARCH_PRESET=anthropic` is not merged into a provider whose protocol it would contradict: the finder's provider is then a provider of that preset, from the role's variables alone. A base URL, a model and a key variable alone override the fields of the provider they reach.
- **Every value is trimmed, and a blank one is unset**, so a variable that is empty or only whitespace never counts as a value.
- **A `QUORUM_` variable that quorum does not read** is one `warning:` line, `QUORUM_PROFILE is not a variable quorum reads`, which names every such variable, sorted, so a typo shows. No value is ever printed.

A local finder, and a panel on a hosted API:

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_VOTER_BASE_URL=https://api.mistral.ai/v1
export QUORUM_VOTER_MODEL=mistral-small-latest
export QUORUM_VOTER_API_KEY="$MISTRAL_API_KEY"
```

## The voter's fallback

When the panel shares the finder's provider and a voter variable is set, the voter variables derive a provider named `voter` from it, and bind the panel to it. The derived provider keeps what is safe on its endpoint and drops what is not, so that a key, a header, a query parameter, a body field or a model of the finder's never reaches another origin:

| `QUORUM_VOTER_BASE_URL` | The voter's base URL | Its key | Its model | The rest of the finder's provider |
| --- | --- | --- | --- | --- |
| Unset | The finder's | `QUORUM_VOTER_API_KEY`, else the finder's key | `QUORUM_VOTER_MODEL`, else the finder's | All kept |
| The same origin as the finder's | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else the finder's key | `QUORUM_VOTER_MODEL`, else the finder's | All kept |
| Another origin, or no `http(s)` origin | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else no key: a preset's own variable is not read | `QUORUM_VOTER_MODEL`, which is then required | `apiKeyEnv`, `headers`, `query`, `extraBody` and the model are dropped; the preset, protocol, `auth`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField` and `systemPrompt` are kept |
| `QUORUM_VOTER_PRESET` or `QUORUM_VOTER_PROTOCOL` is set | Its own, or the preset's | `QUORUM_VOTER_API_KEY`, else the preset's own variable at the preset's origin | `QUORUM_VOTER_MODEL`, which is then required | None: the provider is built from the voter variables alone |

The deprecated `VOTER_BASE_URL`, `VOTER_API_KEY` and `VOTER_MODEL` fall back the same way, as `QUORUM_VOTER_*`. When `roles.voter` names another provider than the finder's, the voter variables set that provider's fields as the research variables set the finder's, and nothing falls back. A config that already defines a provider named `voter` cannot have one derived over it: rename it.

The origin is the scheme, the host and the port, compared once both URLs are parsed. Letter case, a default port written out (`:443` on `https`), one trailing dot after the host (`h.example.` is `h.example`) and the path never make another origin, so a gateway that serves several paths on one origin shares its key. `http` against `https`, or another port, does, so a fallback never carries a key from an encrypted connection to a cleartext one. A value without an `http(s)` origin, such as `localhost:11434/v1` without its scheme, or one that does not parse as a URL, inherits nothing, and then fails the base URL check: [Configuration errors](#configuration-errors).

A panel on another endpoint must name its model. The finder's model name usually means nothing there, and an error before the review is better than a review in which every vote fails.

## Keys

A provider's key is the first of these:

1. **A literal `apiKey`**, which only a TS or JS config holds, or `QUORUM_<ROLE>_API_KEY`, which wins over a variable `apiKeyEnv` names. An empty one is unset, as a blank variable is, so the next source applies.
2. **The variable `apiKeyEnv` names.** A variable that is not set is an error, `providers.gateway: GATEWAY_KEY is not set`, never a silent run without a key.
3. **The preset's own variable** (`OPENAI_API_KEY` for `openai`, `MISTRAL_API_KEY` for `mistral`: the column of [Presets](./30-providers.md#presets)), only while the base URL keeps the preset's origin. At another origin it is not read, and a warning says so.

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
| `--profile: must be a profile id matching ^[a-z][a-z0-9_-]*$` | An empty `--profile`, or an id of another form |
| `--profile: names a profile more than once` | `-p security -p security` |
| `--profile: unknown profile "nmaing" (did you mean "naming"?)`, or `unknown profile "nope": the profiles are security` | An id that the config neither defines nor builds in. `QUORUM_PROFILES` has the same two problems under its own name, and `QUORUM_PROFILES: must list profile ids separated by commas, each matching ^[a-z][a-z0-9_-]*$` for an empty id or an id of another form |
| `no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` | No file defines a provider, and no research model is set: the built-in provider has none. A blank diff meets it too |
| `QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host` | The base URL is not an `http://` or `https://` URL with a host; a missing scheme is the usual slip |
| `QUORUM_RESEARCH_BASE_URL: must not hold a user name or password: send a key with apiKey` | The base URL holds a user name or a password. Send a key with `QUORUM_RESEARCH_API_KEY` or `apiKeyEnv` instead |
| `QUORUM_RESEARCH_BASE_URL: must not hold a query or a fragment` | The base URL holds a `?` or a `#`; quorum appends the endpoint's path to it |
| `QUORUM_RESEARCH_API_KEY: must only contain visible ASCII characters, which an HTTP header can carry` | The key, once trimmed, holds a space, a control character or a character outside ASCII |
| `QUORUM_VOTER_BASE_URL: ...`, `QUORUM_VOTER_API_KEY: ...` | The same two checks, for the panel's variables |
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
| `providers.gateway: GATEWAY_KEY is not set` | The variable `apiKeyEnv` names, or the preset's own, is not set |
| `providers.local.model: is required` | A provider of the file with no model |
| `profiles.mine.prompts.research: is required: the profile extends no built-in profile` | A profile of its own without both prompts and its lenses |
| `providers.voter: is the name the voter variables give the provider they derive: rename this provider` | The voter variables must derive a provider, and the config has one named `voter` |

The other issues of a provider, a preset or a profile are the builder's and the profile checks': [Configuration errors](./30-providers.md#configuration-errors) and [The checks](./40-profiles.md#the-checks), with the path of the provider or profile in front. The library API has [the whole table](../95-reference/30-library-api.md#warnings-and-errors), with the warnings.

A step reports every problem it finds at once, one per line, and the steps run in order: the file is read and checked before the layers are resolved, so a file that fails its checks reports those alone. A base URL and a key that are both wrong:

```text
Error: QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host
QUORUM_RESEARCH_API_KEY: must only contain visible ASCII characters, which an HTTP header can carry
```

## Next

[Providers](./30-providers.md) — what a provider is, the shipped adapters, the presets and the options a config sets on each, their errors, and writing a provider of your own.
