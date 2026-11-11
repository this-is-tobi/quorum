# Library API

The TypeScript API that `src/index.ts` exports: `createQuorum` and its ports, a review and its events, abort, the errors, the config types, and every export. There is no npm package yet: a program imports `src/index.ts` from a clone, and the examples on this page do so from a file at the root of the clone. Bun runs it as it is; the code is erasable TypeScript only, so Node 22.18 or later on the 22 line, or 23.6 or later, which strip types by default and are what the `engines` field of `package.json` asks for, load it too.

## `createQuorum`

```ts
declare function createQuorum(options: QuorumOptions, ports: QuorumPorts): Quorum

interface QuorumOptions {
  readonly profiles: readonly Profile[]
  readonly concurrency?: number
  readonly maxFindings?: number
}

interface QuorumPorts {
  readonly profiles: Readonly<Record<string, ProfilePorts>>
  readonly events?: EventSink
}

interface ProfilePorts {
  readonly research: Provider
  readonly voters: Readonly<Record<string, Provider>>
}

interface Quorum {
  readonly review: (input: { readonly diff: string }, options?: { readonly signal?: AbortSignal }) => Promise<QuorumResult>
  readonly warnings: readonly string[]
}
```

### Options and ports

| Field | Holds | Default |
| --- | --- | --- |
| `profiles` | The profiles to run: at least one, ids unique | Required |
| `concurrency` | The most provider calls in flight at once in one review, shared by every profile; a positive integer | `4` |
| `maxFindings` | The most findings of a research reply each profile reads, the only ones that can reach its panel; a positive integer | `50` |
| `ports.profiles` | One entry per profile, keyed by profile id: `research`, its research provider, and `voters`, one provider per lens keyed by lens id | Required |
| `ports.events` | The event sink: a function that receives every event of every review | None |

One provider object may fill several ports: the research provider of a profile can also be every one of its voters.

### Input checks

`createQuorum` checks its options and ports before anything else, and throws one `ConfigError` that lists every issue, one `path: message` line each, never a `TypeError`, so a program without types gets the same report:

| Path | Message |
| --- | --- |
| `options`, `ports` | `must be an object` |
| `profiles` | `must be an array of profiles`, or `must hold at least one profile` |
| `profiles.<index>`, `<id>` and below | The profile's own issues: [The checks](../20-using/40-profiles.md#the-checks) |
| `profiles.<index>.id` | `repeats the profile id "security"` |
| `concurrency`, `maxFindings` | `must be a positive integer, got 0`, the value quoted when it is a number |
| `ports.profiles` | `must be an object keyed by profile id` |
| `ports.profiles.<id>` | `is missing`, `must be an object with a research provider and voters`, or `names no profile of the run` |
| `ports.profiles.<id>.research` | `is missing`, or `must be a provider: an object with a string id, a string model and a complete function` |
| `ports.profiles.<id>.voters` | `is missing`, or `must be an object keyed by lens id` |
| `ports.profiles.<id>.voters.<lens>` | `is missing`, the provider message above, or `names no lens of the profile` |
| `ports.events` | `must be a function` |

A port for a profile or a lens the review does not have is refused, as a likely typo. A profile's ports are checked only when the profile itself has no issue, and no port is checked when `profiles` is not an array. Every record keyed by an id is read through its own properties, so `constructor` is as valid an id as any other. For the security profile with `concurrency: 0`, `maxFindings: 2.5`, a research port that is not a provider, its `defenses` voter missing and one named `typo` instead, a port for a profile named `other`, and a sink that is a string, the message reads:

```text
concurrency: must be a positive integer, got 0
maxFindings: must be a positive integer, got 2.5
ports.profiles.security.research: must be a provider: an object with a string id, a string model and a complete function
ports.profiles.security.voters.defenses: is missing
ports.profiles.security.voters.typo: names no lens of the profile
ports.profiles.other: names no profile of the run
ports.events: must be a function
```

### The snapshot

Each profile is compiled once, when the quorum is created: its vote template rendered for each lens, its thresholds resolved, and its providers captured beside the `{ id, model }` each had then, which is what events and `meta` report. A later change to a profile, or to which provider a port names, is never seen by a review of that quorum. The provider objects themselves are called as they are.

### `warnings`

The settings of the profiles that cannot take full effect, each starting at its profile id, such as a policy level that is never reached: [Warnings](../20-using/40-profiles.md#warnings). A quorum with warnings still runs.

## `review`

```ts
const result = await quorum.review({ diff }, { signal: AbortSignal.timeout(10 * 60_000) })
```

- **`diff`** is the unified diff, as a string. A blank one runs no stage and calls no model; the review still sends `run:start` and `run:end`, and resolves with empty lists.
- **`signal`**, optional, stops the review: [Abort](#abort).
- **A quorum reviews any number of diffs**, one per call. Each review has its own concurrency limit and its own signal, and several may run at once.

It resolves with the [result](./20-json-result.md), or rejects:

| With | When |
| --- | --- |
| A `ConfigError` | The input is malformed, before any event: `input: must be an object holding the diff string` when the input is not an object, such as the diff text passed on its own; `diff: must be a string`; `options: must be an object`; or `signal: must be an AbortSignal` |
| The signal's reason | The signal aborted, before the review or while it ran |
| The sink's error | The event sink threw |
| A `ProviderError`, or what a provider of your own throws | A profile's research call failed |
| An `OutputError` | A profile's research reply is not one JSON object holding a `findings` array and nothing else |

A failed vote never rejects a review: it is recorded in its verdict.

## Events

The sink receives every event of a review, synchronously and in order, as each thing happens:

| Event | Fields | Sent |
| --- | --- | --- |
| `run:start` | `profiles`, the ids in order; `providers`, who reviews for each profile: `research` and `lenses`, each a `{ id, model }` | First, when the review starts |
| `flag` | `flag`, as `meta.flags` holds it: [A flag](./20-json-result.md#a-flag) | Once per flag, right after `run:start`, before any stage |
| `stage:start` | `profile`; `stage`: `research`, `dedup` or `panel` | When a stage of a profile starts |
| `stage:end` | `profile`, `stage`; `durationMs`, the stage's wall-clock time, waits for a concurrency slot included; `count`, the findings it produced, or the verdicts for `panel` | When that stage ends |
| `call` | `profile`; `role`: `research` or `vote`; `lens`, for a vote; `provider`, its `{ id, model }`; `durationMs`, the provider's latency inside its slot; `ok`; `usage`, when the call succeeded and its counts are valid | Once per provider call, failed ones included |
| `finding:invalid` | `profile`; `reason`, such as `src/auth.js:3 is not in the diff` | Once per finding dropped for citing code outside the diff |
| `incomplete` | `entry`, as `meta.incomplete` will hold it | Once per gap, as it is recorded |
| `vote` | `profile`, `findingId`, `lens`; `keep`: `true`, `false`, or `null` when the vote failed; `error`, for a failed vote | Once per vote |
| `verdict` | `profile`, `findingId`, `keptVotes`, `totalVotes`; `confidence`, when it reached one; `status`: `kept`, `discarded` or `unreviewed` | Once per finding, when all its votes are in |
| `run:end` | `kept`, `discarded`, `unreviewed` and `incomplete`, the counts; `durationMs` | Last, when the review ends |

The first events of the review on [The JSON result](./20-json-result.md#an-example), as the sink received them:

```text
{"type":"run:start","profiles":["security"],"providers":{"security":{"research":{"id":"research","model":"qwen3.6:27b"},"lenses":{"reachability":{"id":"voter","model":"qwen3.6:27b"},"impact":{"id":"voter","model":"qwen3.6:27b"},"defenses":{"id":"voter","model":"qwen3.6:27b"}}}}}
{"type":"stage:start","profile":"security","stage":"research"}
{"type":"call","profile":"security","role":"research","provider":{"id":"research","model":"qwen3.6:27b"},"durationMs":0,"ok":true,"usage":{"inputTokens":1840,"outputTokens":412}}
{"type":"finding:invalid","profile":"security","reason":"src/auth.js:3 is not in the diff"}
{"type":"incomplete","entry":{"profile":"security","reason":"finding-unreadable","detail":"findings[4]: quote: Invalid input: expected string, received undefined"}}
{"type":"stage:end","profile":"security","stage":"research","durationMs":8,"count":3}
```

- **The sink runs inside the review.** Each event is delivered before the review goes on, so a slow sink slows the review.
- **Events carry no model text beyond `error` strings**, the file name a `finding:invalid` reason quotes, which is the finder's, cleaned and capped at 80 characters, and, for a diff without per-file headers, the `file` and `detail` of a `vote-failed` entry, which hold the finder's name for the file, cleaned and capped at 260. The `file` of a `flag` event is the diff's own path, and absent for a diff without per-file headers.
- **The sink gets a copy of each event.** Changing one changes neither the review nor its result.
- **`meta` agrees with the events.** `meta.usage` and each `invalidFindings` are counted from them.
- **A sink that throws aborts the review** with its error, so the bug surfaces instead of being swallowed: no profile starts another call, no further event is delivered, and the review rejects with that error, even when it threw on `run:end`.

## Abort

```ts
const controller = new AbortController()
const pending = quorum.review({ diff }, { signal: controller.signal })
controller.abort()
await pending // rejects with controller.signal.reason
```

An aborted review never resolves, and never fails open:

- **It rejects with the signal's reason**, whatever error a call it cut raised. A signal already aborted rejects at once, before any event or call.
- **The signal is checked before every stage, and inside every call's concurrency slot** before the provider is called, so a call still queued when the review is aborted never starts. Every request carries the review's signal, so a provider can stop a call in flight. It is checked once more after the profiles have run, a blank diff included, so an abort that lands when no stage is left to check still rejects.
- **A vote cut by the abort is never a failed vote.** It rethrows the abort's reason, so an aborted review never resolves with a finding the abort left unreviewed, and the review rejects at once, without waiting for the votes still in flight.
- **No event is delivered once the review is aborted.**
- **One failed profile stops the others.** A profile whose research fails aborts the review with that error, and the review rejects with it. When the research call itself fails, the review is aborted before the call's concurrency slot is released, so no other profile starts a call after it. When the reply is not a valid envelope, the review is aborted when the reply is checked, which happens after the call has released its slot, so a call another profile had queued may already have started. Either way, no event arrives after the rejection.
- **An abort after `run:end` has no effect**: the review is over, and resolves with its result.
- **Stopping a call in flight is cooperative.** The shipped adapters pass the signal to `fetch`. A provider that ignores it can keep an aborted review waiting until its call settles, unless another call of the review stops on the signal first; the review then rejects all the same.

## Errors

| Class | Extends | Fields | Thrown for |
| --- | --- | --- | --- |
| `QuorumError` | `Error` | `name`, the class's own name | The base of every error quorum raises on purpose |
| `ConfigError` | `QuorumError` | `issues`, each a `{ path, message }`, every one; the message holds one `path: message` line per issue for the first 50, then `and <n> more issues` | Invalid configuration or input, every issue at once. The CLI exits `2` on it |
| `ProviderError` | `QuorumError` | `providerId`, `kind`, `status`, `retryable` | A provider call that failed: [`ProviderError`](../20-using/30-providers.md#providererror) |
| `OutputError` | `QuorumError` | `stage`, `reason`; `snippet`, the first 200 characters of the reply | A model reply that could not be read: `<stage> reply unusable: <reason> (reply starts: "<snippet>")` |

A failed research call rejects the review with its `ProviderError`, and an unusable research reply with its `OutputError`. The same errors from a vote are recorded in the vote's `error` instead.

## Config types

```ts
declare function defineConfig(config: QuorumConfig): QuorumConfig
```

`loadConfig` reads a named config file and `fromConfig` builds a quorum from a config: [`loadConfig` and `fromConfig`](#loadconfig-and-fromconfig). The CLI and `runQuorum` read their settings through these two functions: [Configuration](../20-using/20-configuration.md). These exports write and type-check a config:

- **`QuorumConfig`** types what a TS or JS config exports as its default: `$schema`, for an editor, `version`, `providers`, `roles`, `concurrency`, `maxFindings` and `profiles`, every one optional. A provider is an object implementing `Provider`, or its settings, every one optional too: `preset`, `protocol`, `baseUrl`, `model`, `apiKeyEnv` and `apiKey`, then `auth`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField` and `systemPrompt`, as [Providers](../20-using/30-providers.md#options) describes them.
- **`QuorumConfigFile`** types what a YAML or JSON config holds: the same settings, as data only, so a provider is always its settings, and names the environment variable that holds its key in `apiKeyEnv`, never holding one.
- **`ConfigInput`** types what `fromConfig` takes: the settings of `QuorumConfig`, with every prompt a string, since a program's config reads no file and so holds no `{ file }`.
- **`defineConfig`** returns the config it is given, as it is. Wrapping a default export in it has the editor check every field.

A config that imports nothing from quorum when it runs types its object with `import type` and `satisfies` instead, since `import type` is erased:

```ts
// quorum.config.mts
import type { QuorumConfig } from './src/index.ts'

export default {
  providers: {
    local: { preset: 'ollama', model: 'qwen3.6:27b' },
    hosted: { preset: 'openai', model: 'gpt-5', apiKey: process.env.OPENAI_API_KEY },
  },
  roles: { research: 'local', voter: 'hosted' },
} satisfies QuorumConfig
```

The `.mts` extension makes the file an ES module whatever the nearest `package.json` says: Node refuses `export` in a `.ts` or `.js` file of a package whose `package.json` says `"type": "commonjs"`. Node also strips erasable TypeScript only, so a config holds no `enum`, `namespace` or parameter property. An editor checks a YAML or JSON config against the JSON Schema committed as [`schema/quorum.schema.json`](../../schema/quorum.schema.json): a YAML file names it in a comment, `# yaml-language-server: $schema=<path or URL of the schema>`, and a JSON file in its `"$schema"` field.

## `loadConfig` and `fromConfig`

```ts
declare function loadConfig(options?: {
  readonly cwd?: string
  readonly env?: Env
  readonly configPath?: string
  readonly selection?: ProfileSelection
}): Promise<{ readonly config: ResolvedConfig, readonly source: string | undefined, readonly warnings: readonly string[] }>

declare function fromConfig(
  config: ConfigInput | ResolvedConfig,
  options?: { readonly env?: Env, readonly events?: EventSink },
): Promise<Quorum>

type Env = Readonly<Record<string, string | undefined>>

interface ProfileSelection {
  readonly ids: readonly string[]
  readonly path: string
}
```

`loadConfig` reads the config file it is named, if any, lays the environment over it and resolves the result into a `ResolvedConfig`: every layer merged, every reference bound, every key read. `fromConfig` builds a quorum from a config: a `ConfigInput`, which it checks and resolves, or a `ResolvedConfig`, which it uses as it is. Both read `process.env` when no `env` is given, and both throw a `ConfigError` before anything is sent, with every issue of the step that failed: `loadConfig`, those of the file, or else those of the resolution; `fromConfig`, those of the config's check, or else those of the resolution and the providers.

```ts
import { fromConfig, inertLine, loadConfig } from './src/index.ts'

const { config } = await loadConfig({ configPath: 'quorum.yaml' })
const quorum = await fromConfig(config)
for (const warning of quorum.warnings) console.error(inertLine(`warning: ${warning}`))
const result = await quorum.review({ diff })
```

`fromConfig({}, { env: process.env })` needs no file: the environment alone names a provider and a model. The CLI and `runQuorum` read the `QUORUM_*` variables, with the deprecated `RESEARCH_*` and `VOTER_*` aliases, and the file `QUORUM_CONFIG` names through these two functions.

- **`options.cwd`** is the directory a relative `configPath` and `QUORUM_CONFIG` resolve against, the working directory by default. `source` is the absolute path of the file read, and `undefined` when none was.
- **`options.selection`** names the profiles that run, over `QUORUM_PROFILES`, which is still read and checked: a malformed variable is refused even when a selection is given. `path` is what the selection's issues name, and the CLI passes `--profile`. Each id must match `^[a-z][a-z0-9_-]*$`, and none may repeat.
- **`options.events`** is the event sink of the quorum, as `createQuorum` takes it.
- **A process imports a TS or JS config once.** A second `loadConfig` of the same file gets the module the first import cached, since Node and Bun cache a module by its URL.
- **A named config is trusted input.** It chooses where each key goes, and a TS or JS one runs code: in CI it must come from the base branch or from outside the pull request's checkout, never from the pull request under review ([Layering](#layering)).
- **A `ResolvedConfig`** holds `providers`, the ones a profile that runs uses, by name: a spec with its key read into `apiKey`, or the snapshot of an object implementing `Provider`; `profiles`, each a `ResolvedProfile`: its `profile`, `research`, the name of its research provider, and `voters`, the name of each lens's provider, by lens id; `concurrency`, `maxFindings`, and `warnings`. It is a copy, frozen all the way down: a provider object is a frozen snapshot of the program's, with no prototype, named by its config key as its `id`.
- **A `ResolvedConfig` holds the keys it read**, as a code config does: never print or log one. The CLI's [`--print-config`](../20-using/10-cli.md#printing-the-resolved-config) redacts them.
- **`fromConfig` of a `ResolvedConfig` reads no environment**: what `loadConfig` resolved is what runs, whatever `options.env` holds.
- **A config is read as its own fields, with one limit.** A field planted on `Object.prototype` is a prototype pollution bug in the same process. An enumerable one is a field of every object, so it is refused as `is not a known field` wherever the schema does not know it: a planted `baseUrl` is refused at the top level, while a planted `concurrency`, `maxFindings` or `version` passes when the config holds no object that refuses it. One planted with `Object.defineProperty` is not enumerable, and the schema reads each field it knows through the prototype, so it becomes a field of the config, or of every provider that leaves it unset. Code that can plant either can read the keys directly: quorum does not defend against it.

### Layering

Each layer sits over the one before it: the built-in defaults, then the file `configPath` names (else the one `QUORUM_CONFIG` names), then the environment.

- **The built-in defaults.** A config that defines no provider gets one named `default`: the `openai-compatible` protocol at `http://localhost:11434/v1`, Ollama's address, with no model, so `QUORUM_RESEARCH_MODEL` or a file must set one. A config with no `profiles` field runs the `security` profile.
- **A profile over its base.** A profile named after a built-in profile, or with `extends`, starts from it: its prompts and its policy levels replace the base's one field at a time, and its lenses replace the base's lenses as a whole.
- **`undefined` is unset, `null` is set.** In a program's config or a code config, a field set to `undefined` leaves the layer below's value in place, as if it were not written; `null` is a value, such as `temperature: null`, which leaves the field out of the request.
- **No file is searched for.** A file loads only when it is named, by `configPath` first, then `QUORUM_CONFIG`: a `quorum.config.yaml` in the working directory is never read, since in CI that directory is a pull request's checkout, and a pull request could plant one.
- **A named config is trusted like code.** It chooses where each key goes: a `baseUrl` of its own beside an `apiKeyEnv` sends the key that variable holds to that host. A TS or JS config also runs, with the job's environment. So in CI a named config must come from the base branch or from a path outside the pull request's checkout, never from the pull request under review.

### The environment variables

| Variable | Sets |
| --- | --- |
| `QUORUM_CONFIG` | `loadConfig` only: the config file to read, when `configPath` is not given |
| `QUORUM_PROFILES` | The profiles that run: ids separated by commas, each a profile the config defines or a built-in one, none twice |
| `QUORUM_RESEARCH_PRESET`, `QUORUM_VOTER_PRESET` | A role's provider, built from a [preset](../20-using/30-providers.md#presets) |
| `QUORUM_RESEARCH_PROTOCOL`, `QUORUM_VOTER_PROTOCOL` | A role's provider, built from a wire protocol: `openai-compatible`, `anthropic`, `gemini` or `ollama` |
| `QUORUM_RESEARCH_BASE_URL`, `QUORUM_VOTER_BASE_URL` | The base URL of a role's provider |
| `QUORUM_RESEARCH_MODEL`, `QUORUM_VOTER_MODEL` | The model of a role's provider |
| `QUORUM_RESEARCH_API_KEY`, `QUORUM_VOTER_API_KEY` | The key of a role's provider, as a literal `apiKey` |
| `RESEARCH_BASE_URL`, `RESEARCH_API_KEY`, `RESEARCH_MODEL`, `VOTER_BASE_URL`, `VOTER_API_KEY`, `VOTER_MODEL` | Deprecated aliases: each is read as the `QUORUM_` variable of the same name |

- **The `QUORUM_` form wins** over its alias when both are set, and one warning names every alias that is set, whichever form won: `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead`. A preset and a protocol have no alias.
- **Every value is trimmed, and a blank one is unset.** Only the variables the environment holds itself are read, never one an object it inherits from holds.
- **`QUORUM_PROFILES` refuses what would review nothing or the wrong thing**: an empty id, an id that is not lower-case letters, digits, `_` and `-` after a letter, or an id named twice.

### The role variables

- **The research variables** set the provider `roles.research` names, which a voter or a lens that shares it inherits.
- **The voter variables** set the provider `roles.voter` names when that is another provider than research's. When the voter shares the research provider, they derive a provider named `voter` from it, and bind the voter role to it. A config that already has a provider named `voter` cannot be derived over: rename it.
- **A derived voter keeps what is safe on its endpoint**, as the voter's fallback of [Configuration](../20-using/20-configuration.md#the-voters-fallback) does, and a key, header, query parameter, body field or model never reaches another origin:

| `QUORUM_VOTER_BASE_URL` | The voter's base URL | Its key | Its model | The rest of the research provider's settings |
| --- | --- | --- | --- | --- |
| Unset | The research provider's | `QUORUM_VOTER_API_KEY`, else the research provider's key | `QUORUM_VOTER_MODEL`, else the research provider's | All kept |
| The same origin as the research provider's | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else the research provider's key | `QUORUM_VOTER_MODEL`, else the research provider's | All kept |
| Another origin, or no `http(s)` origin | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else none: a preset's own variable is not read | `QUORUM_VOTER_MODEL`, which is then required | `apiKeyEnv`, `headers`, `query`, `extraBody` and `model` dropped; the preset, protocol, `auth`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField` and `systemPrompt` kept |
| A `QUORUM_VOTER_PRESET` or `QUORUM_VOTER_PROTOCOL` is set | Its own, or the preset's | `QUORUM_VOTER_API_KEY`, else the preset's own variable at the preset's origin | `QUORUM_VOTER_MODEL`, which is then required | None: the provider is built from the voter variables alone |

The origin is compared as the voter's fallback compares it: the scheme, the host in lower case with no trailing dot, and a port that is not the default.

- **A `PRESET` or `PROTOCOL` variable builds the role's provider afresh.** `QUORUM_RESEARCH_PRESET=anthropic` is not merged into the `default` provider, whose protocol it would contradict: the research provider is a provider of that preset, from the role's variables alone. `BASE_URL`, `MODEL` and `API_KEY` alone override fields of the provider they reach.
- **No variable changes a provider object.** A role bound to an object that implements `Provider` with a variable set for it is an issue at the variable, never an ignored one.

### Roles and profiles

- **The role defaults.** One provider binds both roles. Several need `roles.research`, or the config is refused; `roles.voter` is `roles.research` when unset. A profile's own `roles` override the top-level ones, and a lens's `provider` overrides both.
- **Which profiles run.** The ones `selection` names, else the ones `QUORUM_PROFILES` names, else the ones `profiles` defines, else `security`. `profiles: {}` with no selection is refused: a run that reviews nothing never passes.
- **A profile's base.** A profile named after a built-in profile starts from it, so `profiles: { security: { gating: false } }` is the security profile without gating; so does one with `extends`. A profile of its own needs both prompts and its lenses. Its `gating` is the base's, else `true`.
- **Every defined profile and provider is checked**, whether or not a run selects or uses it, so a broken definition fails every run, as an unknown field does.

### Keys

A provider's key is the first of:

1. A literal `apiKey`: a program's or a code config's, or `QUORUM_<ROLE>_API_KEY`, which wins over a variable a file names with `apiKeyEnv`. An empty one is unset, as a blank variable is, so the next source applies.
2. The variable `apiKeyEnv` names. A variable that is not set is an issue, never a silent run without a key.
3. The preset's own variable (`OPENAI_API_KEY` for `openai`), only while the base URL keeps the preset's origin. At another origin it is not read, and a warning says so.
4. For `azure-openai`, whose preset has no base URL, `AZURE_OPENAI_API_KEY`, only on an `https` host under `openai.azure.com`.

- **`AZURE_OPENAI_API_KEY` is one variable for every Azure resource.** It is read for any host under `openai.azure.com`, so a voter whose own variables name the `azure-openai` preset on another Azure host sends that key there.
- **A `QUORUM_<ROLE>_BASE_URL` set on a provider with an explicit `apiKeyEnv` keeps that key at the new URL.** It overrides the provider itself, not a fallback, so a literal `apiKey`, `headers`, `query`, `extraBody` and `model` also stay with the provider at the new URL. A preset's own variable is withheld off its origin, with a warning.
- **A voter derived onto another origin gets no key of the research provider**, whichever way it was set: `apiKey`, `apiKeyEnv`, a preset's variable or a `QUORUM_RESEARCH_API_KEY`.
- **Keys are read only for the providers a profile that runs uses**, so a CI job that runs one profile needs that profile's keys alone. Every provider is still checked, without its key.
- **A key sent over plain `http` to a host other than this machine** (`localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]` are this machine) is warned about.
- **A resolved config holds its keys**, so never print or log one. No message or warning repeats a key, a URL, a header value or a variable's value, and a variable's name is printed only when it is an upper-case name.

### Warnings and errors

`loadConfig` returns the config's `warnings`: the deprecation line, the line naming the `QUORUM_` variables that nothing reads, a preset's key that is not sent, and a key sent over plain `http`. The `warnings` of the quorum `fromConfig` returns hold those first, then the core's: a profile setting that cannot take full effect, [Warnings](../20-using/40-profiles.md#warnings). A provider object is read only while its config is checked, inside the guard that keeps what it throws to the error's name: its `model` once and its `complete` twice (the check of plain data, then the snapshot), into a frozen snapshot with no prototype that calls the object as it is, and that snapshot is named by its config key in events and in `meta`, whatever `id` the object holds.

| Path | Message | Cause |
| --- | --- | --- |
| The path as given | The file's own problem, such as `does not exist`, `is not valid YAML at line 2, column 1 (DUPLICATE_KEY)`, `has a syntax error` or `failed to load (Error)` | `loadConfig` could not read the file, or it is not valid |
| `config` | `must be an object` | A `ConfigInput` that is not a plain object |
| `config` | `could not be read (Error)` | A getter or a proxy of the config threw, one of a provider object's included: each provider object is read only here, and only the error's name is kept, `an error` when that is not a plain class name |
| `config` | `holds more than 10000 values` | A `ConfigInput` too large to walk |
| `<path>` | `is not allowed as a key: it can replace the prototype of an object`, `must be plain data: an object, an array, a string, a finite number, true, false or null`, `must be a finite number`, or `is nested more than 64 keys deep` | A `ConfigInput` that holds data a config may not |
| `<path>` | The schema's: `is not a known field`, `is required`, `must be a string`, `must be at least 1`, and the like | A field of the wrong shape, at its path |
| `QUORUM_PROFILES` | `must list profile ids separated by commas, each matching ^[a-z][a-z0-9_-]*$` | An empty id, or an id of another form |
| `QUORUM_PROFILES` | `names a profile more than once` | `security,security` |
| `QUORUM_PROFILES`, or the selection's `path` (`--profile`) | `unknown profile "tema" (did you mean "team"?)`, or `unknown profile "style": the profiles are team and security` | An id that is neither defined nor built in |
| The selection's `path` | `must be a profile id matching ^[a-z][a-z0-9_-]*$` | An empty id, or an id of another form, in `selection.ids` |
| The selection's `path` | `names a profile more than once` | `selection.ids` names an id twice |
| The selection's `path` | `must name at least one profile` | `selection.ids` is empty |
| `QUORUM_VOTER_MODEL` | `must be set when the voter variables name another endpoint than the research provider's` | The voter variables name another origin, a preset or a protocol, and no model |
| `QUORUM_RESEARCH_MODEL`, and the other variables of a role | `cannot change providers.mine, an object implementing Provider` | A variable set for a role bound to a provider object |
| `providers.voter` | `is the name the voter variables give the provider they derive: rename this provider` | The voter variables derive a provider, and one is already named `voter` |
| `profiles` | `must hold at least one profile, or be left out` | `profiles: {}` with no `QUORUM_PROFILES` |
| `profiles.<id>.prompts.research`, `profiles.<id>.prompts.vote`, `profiles.<id>.lenses` | `is required: the profile extends no built-in profile` | A profile of its own without prompts or lenses |
| `roles.research`, `roles.voter`, `profiles.<id>.roles.research`, `profiles.<id>.roles.voter`, `profiles.<id>.lenses.<index>.provider` | `unknown provider "claud" (did you mean "claude"?)`, or `unknown provider "x": the providers are a and b` | A reference to a provider that is not defined: the defined name one or two edits away, else the names. A name that is not a safe name is not repeated: `names an unknown provider` |
| `roles.research` | `is required when several providers are defined` | Several providers, and no research role |
| `profiles.<id>` and below | The profile's own issues: [The checks](../20-using/40-profiles.md#the-checks) | A profile that fails a check |
| No path | `no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` | The built-in provider has no model |
| `providers.<name>` | `CORP_KEY is not set` | The variable `apiKeyEnv` names, or the preset's own, is not set |
| `providers.<name>.apiKeyEnv` | `names a variable that is not set` | The same, for a name that is not an upper-case variable name: a key pasted there is never printed |
| `providers.<name>.<field>` | The builder's: [Presets as data](../20-using/30-providers.md#presets-as-data) and [Configuration errors](../20-using/30-providers.md#configuration-errors) | A provider that the builder refuses, defined or derived |
| `QUORUM_RESEARCH_PRESET` and the other variables of a role: the preset, the protocol, the base URL, the model and the key | The builder's, such as `must be one of ollama, ollama-cloud, ...` | A provider that the builder refuses on a field a variable set: the issue names the variable, never the provider the variables built |
| `providers.<name>.model` | `must be a string` | A provider object whose model is not a string |

The warnings, each but the first two starting at the path it is about:

| Warning | Cause |
| --- | --- |
| `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead` | A deprecated alias is set; one line names every alias, and every `QUORUM_` variable to set instead |
| `QUORUM_PROFILE is not a variable quorum reads` | A `QUORUM_` variable that is set and that quorum does not read: one line names every such variable, sorted, and prints a name that is not an upper-case variable name as `*` |
| `providers.gpt.baseUrl: is not the endpoint of the openai preset, so OPENAI_API_KEY is not sent: set apiKeyEnv to send a key` | A provider of a preset whose base URL is not the preset's origin |
| `providers.voter.baseUrl: is not the endpoint of the research provider, so OPENAI_API_KEY is not sent: set QUORUM_VOTER_API_KEY to send a key` | A derived voter on another origin than research's, whose provider keeps a preset that has a key variable |
| `providers.gpu.baseUrl: sends the key over plain http to a host other than this machine` | A key that would travel in cleartext |

## Exports

| Values | |
| --- | --- |
| `createQuorum` | Build a quorum |
| `defineConfig` | Type a TS config: [Config types](#config-types) |
| `fromConfig` | Build a quorum from a config: [`loadConfig` and `fromConfig`](#loadconfig-and-fromconfig) |
| `loadConfig` | Read a named config file and resolve it with the environment: [`loadConfig` and `fromConfig`](#loadconfig-and-fromconfig) |
| `securityProfile` | The default profile, frozen: [Profiles](../20-using/40-profiles.md#the-security-profile) |
| `defaultPolicy` | `{ high: 'unanimous', medium: 'majority', low: 'off' }`, frozen |
| `anthropic` | The Anthropic Messages adapter: [Providers](../20-using/30-providers.md#anthropic) |
| `gemini` | The Gemini `generateContent` adapter: [Providers](../20-using/30-providers.md#gemini) |
| `ollama` | The Ollama native chat adapter: [Providers](../20-using/30-providers.md#ollama) |
| `openaiCompatible` | The OpenAI-compatible adapter: [Providers](../20-using/30-providers.md#openaicompatible) |
| `presets` | The presets, frozen: [Presets](../20-using/30-providers.md#presets) |
| `QuorumError`, `ConfigError`, `ProviderError`, `OutputError` | The error classes |
| `inertLine`, `inertJson` | Render a line for a terminal or a log, and a value as JSON, inert: [Output handling](../30-security/30-output-handling.md#printing-a-review-yourself) |
| `runQuorum` | Deprecated: [below](#runquorum) |

The types: `Confidence`, `Finding`, `Flag`, `FlagCode`, `IncompleteEntry`, `IncompleteReason`, `Lens`, `LensVote`, `Profile`, `ProfileMeta`, `ProfileProviders`, `Prompts`, `ProviderRef`, `Quorum`, `QuorumEvent`, `QuorumMeta`, `QuorumOptions`, `QuorumResult`, `StageName`, `Thresholds`, `Usage`, `Verdict`, `VerdictStatus` and `Vote`; `ChatMessage`, `CompletionRequest`, `CompletionResponse`, `EventSink`, `JsonSchema`, `ProfilePorts`, `Provider` and `QuorumPorts`; `ConfigIssue` and `ProviderErrorKind`; `PolicyRules` and `Rule`; `AnthropicOptions`, `Auth`, `GeminiOptions`, `HttpProviderOptions`, `OllamaOptions`, `OpenAICompatibleOptions`, `StructuredOutput` and `SystemPrompt`; `Preset`, `PresetName` and `Protocol`; `ConfigInput`, `QuorumConfig` and `QuorumConfigFile`; `Env`, `ProfileSelection`, `ResolvedConfig`, `ResolvedProfile` and `ResolvedProvider`. `HttpProviderOptions` holds the options an HTTP provider takes, `OpenAICompatibleOptions` adds `maxTokensField`, and `AnthropicOptions`, `GeminiOptions` and `OllamaOptions` are `HttpProviderOptions` as it is: [Providers](../20-using/30-providers.md#options). `Preset` types a row of `presets`, `PresetName` names one, and `Protocol` names the four wire protocols.

The stages, the profile checks and the CLI's exit-code rule are not exported: a program reaches the stages through `createQuorum`, and applies the exit codes itself, as the example below does.

## `runQuorum`

```ts
declare function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult>
```

Deprecated: use `loadConfig` and `fromConfig`. `runQuorum` reviews `diff` as the CLI does with no flag: it calls `loadConfig()` and `fromConfig` on the result, so it reads the file `QUORUM_CONFIG` names, if any, relative to `process.cwd()`, and the `QUORUM_*` variables of `process.env` with their `RESEARCH_*` and `VOTER_*` aliases, and it runs the profiles they select, the security profile alone by default: [Configuration](../20-using/20-configuration.md). `onProgress` receives the CLI's progress lines, the `flag:` lines included, each one inert and each profile's line starting with `[<id>] ` when several run, but neither the banner, nor a warning, nor `empty diff: nothing to review`, which the CLI writes itself. A configuration error, a missing model included, rejects with a `ConfigError`, for an empty diff too.

## A complete example

`review.ts`, at the root of the clone: the finder on a local model, the panel on a hosted one, a line on stderr per verdict and per gap and the result on stdout, both inert, a ten-minute limit, and the CLI's exit codes.

```ts
import { readFile } from 'node:fs/promises'
import { ConfigError, createQuorum, inertJson, inertLine, openaiCompatible, securityProfile } from './src/index.ts'
import type { QuorumEvent, QuorumResult } from './src/index.ts'

const USAGE = 'Usage: bun run ./review.ts <diff-file>'

function progress(event: QuorumEvent): void {
  if (event.type === 'verdict') console.error(inertLine(`${event.findingId}: ${event.keptVotes}/${event.totalVotes} ${event.status}`))
  if (event.type === 'incomplete') console.error(inertLine(`incomplete: ${event.entry.reason} (${event.entry.detail})`))
}

/** The `Error:` line of a failure, inert: its message can hold text a server sent, and a value with no text form gets a fixed one. */
function errorLine(error: unknown): string {
  let message: string
  try {
    message = error instanceof Error ? error.message : String(error)
  } catch {
    message = 'an error with no text form'
  }
  return inertLine(`Error: ${message}`)
}

/** The CLI's rule: 1 for a kept high finding of a gating profile, 4 for an incomplete review, else 0. */
function exitCode(result: QuorumResult): number {
  const gates = (profile: string): boolean => !Object.hasOwn(result.meta.profiles, profile) || result.meta.profiles[profile].gating !== false
  if (result.kept.some(verdict => verdict.confidence === 'high' && gates(verdict.profile))) return 1
  return result.unreviewed.length > 0 || result.meta.incomplete.length > 0 ? 4 : 0
}

/** Review the diff file at `path`, with the CLI's exit codes: 2 for usage or configuration, 3 for a review that failed. */
async function main(path: string | undefined): Promise<number> {
  let diff: string
  try {
    if (path === undefined) throw new Error('no diff file given')
    diff = await readFile(path, 'utf8')
  } catch (error) {
    console.error(errorLine(error))
    console.error(USAGE)
    return 2
  }
  try {
    const finder = openaiCompatible({ id: 'local', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.6:27b' })
    const panel = openaiCompatible({ id: 'hosted', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra', apiKey: process.env.OPENAI_API_KEY?.trim() || undefined, temperature: null, maxTokensField: 'max_completion_tokens' })
    const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, panel]))
    const quorum = createQuorum({ profiles: [securityProfile] }, { profiles: { security: { research: finder, voters } }, events: progress })
    const result = await quorum.review({ diff }, { signal: AbortSignal.timeout(10 * 60_000) })
    console.log(inertJson(result))
    return exitCode(result)
  } catch (error) {
    console.error(errorLine(error))
    return error instanceof ConfigError ? 2 : 3
  }
}

process.exitCode = await main(process.argv[2])
```

```bash
OPENAI_API_KEY=sk-... bun run ./review.ts ./my.diff > result.json
```

It exits as the CLI does: `0`, `1` or `4` by the result; `2` when no file is given, the file cannot be read, or a setting is invalid, such as a key with a space inside it once trimmed; and `3` when the review fails, its ten-minute limit included.

## Related

- [Providers](../20-using/30-providers.md) — the provider port, the shipped adapters and writing a provider.
- [Profiles](../20-using/40-profiles.md) — writing a profile, and running several in one review.
- [The JSON result](./20-json-result.md) — every field `review` resolves with.
- [Architecture](./40-architecture.md) — the modules behind this API, and the stages of a review.
