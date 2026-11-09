# Library API

The TypeScript API that `src/index.ts` exports: `createQuorum` and its ports, a review and its events, abort, the errors, and every export. There is no npm package yet: a program imports `src/index.ts` from a clone, and the examples on this page do so from a file at the root of the clone. Bun runs it as it is; the code is erasable TypeScript only, so a Node release that strips types loads it too.

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
- **Stopping a call in flight is cooperative.** The shipped `openaiCompatible` adapter passes the signal to `fetch`. A provider that ignores it can keep an aborted review waiting until its call settles, unless another call of the review stops on the signal first; the review then rejects all the same.

## Errors

| Class | Extends | Fields | Thrown for |
| --- | --- | --- | --- |
| `QuorumError` | `Error` | `name`, the class's own name | The base of every error quorum raises on purpose |
| `ConfigError` | `QuorumError` | `issues`, each a `{ path, message }`; the message holds one `path: message` line per issue | Invalid configuration or input, every issue at once. The CLI exits `2` on it |
| `ProviderError` | `QuorumError` | `providerId`, `kind`, `status`, `retryable` | A provider call that failed: [`ProviderError`](../20-using/30-providers.md#providererror) |
| `OutputError` | `QuorumError` | `stage`, `reason`; `snippet`, the first 200 characters of the reply | A model reply that could not be read: `<stage> reply unusable: <reason> (reply starts: "<snippet>")` |

A failed research call rejects the review with its `ProviderError`, and an unusable research reply with its `OutputError`. The same errors from a vote are recorded in the vote's `error` instead.

## Exports

| Values | |
| --- | --- |
| `createQuorum` | Build a quorum |
| `securityProfile` | The default profile, frozen: [Profiles](../20-using/40-profiles.md#the-security-profile) |
| `defaultPolicy` | `{ high: 'unanimous', medium: 'majority', low: 'off' }`, frozen |
| `openaiCompatible` | The shipped provider: [Providers](../20-using/30-providers.md#openaicompatible) |
| `QuorumError`, `ConfigError`, `ProviderError`, `OutputError` | The error classes |
| `inertLine`, `inertJson` | Render a line for a terminal or a log, and a value as JSON, inert: [Output handling](../30-security/30-output-handling.md#printing-a-review-yourself) |
| `runQuorum` | Deprecated: [below](#runquorum) |

The types: `Confidence`, `Finding`, `Flag`, `FlagCode`, `IncompleteEntry`, `IncompleteReason`, `Lens`, `LensVote`, `Profile`, `ProfileMeta`, `ProfileProviders`, `Prompts`, `ProviderRef`, `Quorum`, `QuorumEvent`, `QuorumMeta`, `QuorumOptions`, `QuorumResult`, `StageName`, `Thresholds`, `Usage`, `Verdict`, `VerdictStatus` and `Vote`; `ChatMessage`, `CompletionRequest`, `CompletionResponse`, `EventSink`, `JsonSchema`, `ProfilePorts`, `Provider` and `QuorumPorts`; `ConfigIssue` and `ProviderErrorKind`; `PolicyRules` and `Rule`; `Auth`, `HttpProviderOptions`, `OpenAICompatibleOptions`, `StructuredOutput` and `SystemPrompt`. `HttpProviderOptions` holds the options an HTTP provider takes, and `OpenAICompatibleOptions` adds `maxTokensField`: [Providers](../20-using/30-providers.md#options).

The stages, the profile checks and the CLI's exit-code rule are not exported: a program reaches the stages through `createQuorum`, and applies the exit codes itself, as the example below does.

## `runQuorum`

```ts
declare function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult>
```

Deprecated: use `createQuorum` with explicit providers. `runQuorum` reviews `diff` with the security profile and providers built from the `RESEARCH_*` and `VOTER_*` variables of `process.env`, exactly as the CLI builds them: [Configuration](../20-using/20-configuration.md). `onProgress` receives the CLI's progress lines, the `flag:` lines included, each one inert, but neither its banner nor `empty diff: nothing to review`, which the CLI writes itself. A research model that is not set rejects with a `ConfigError`, for an empty diff too.

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

- [Providers](../20-using/30-providers.md) — the provider port, `openaiCompatible` and writing a provider.
- [Profiles](../20-using/40-profiles.md) — writing a profile, and running several in one review.
- [The JSON result](./20-json-result.md) — every field `review` resolves with.
- [Architecture](./40-architecture.md) — the modules behind this API, and the stages of a review.
