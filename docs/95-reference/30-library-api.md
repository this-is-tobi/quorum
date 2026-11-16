# Library API

The TypeScript API that `@tobi-or-not/quorum` exports, from `src/index.ts`: `createQuorum` and its ports, a review and its events, an estimate of what a review may cost, reading a source, what a review comes to, abort, the errors, the config types, and every export. Install the package with `npm install @tobi-or-not/quorum` and import from it: the examples on this page do, from a file of a project that has it installed. The package is ES modules with declarations, which a TypeScript project resolves with `moduleResolution` set to `node16`, `nodenext` or `bundler`; the older `node10` ignores `exports` and finds no types. Node 22.18 or later on the 22 line, or 23.6 or later, runs a `.mts` file of these examples as it is, since the code is erasable TypeScript only, and so does Bun. A clone's `src/index.ts` exports the same API.

## `createQuorum`

```ts
declare function createQuorum(options: QuorumOptions, ports: QuorumPorts): Quorum

interface QuorumOptions {
  readonly profiles: readonly Profile[]
  readonly concurrency?: number
  readonly maxFindings?: number
  readonly exclude?: readonly string[]
  readonly maxReviewTokens?: number
  readonly reviewTimeoutMs?: number
  readonly partTokens?: number
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
  readonly review: (input: ReviewInput, options?: { readonly signal?: AbortSignal }) => Promise<QuorumResult>
  readonly estimate: (input: { readonly diff: string, readonly send?: readonly string[] }) => Estimate
  readonly warnings: readonly string[]
}

interface ReviewInput {
  readonly diff: string
  readonly source?: ReviewSource
  readonly leftOut?: readonly LeftOutFile[]
  readonly send?: readonly string[]
}
```

### Options and ports

| Field | Holds | Default |
| --- | --- | --- |
| `profiles` | The profiles to run: at least one, ids unique | Required |
| `concurrency` | The most provider calls in flight at once in one review, shared by every profile; a positive integer | `4` |
| `maxFindings` | The most findings of a research reply each profile reads, the only ones that can reach its panel; a positive integer | `50` |
| `exclude` | Path patterns of the files left out of every request ([Excludes](../20-using/20-configuration.md#excludes)). Each file excluded reaches no model and is listed in `meta.leftOut` as `excluded`, never as a gap. At most 100 patterns, each at most 256 characters | None |
| `maxReviewTokens` | The most tokens, input and output, one review may spend: [The token cap](../20-using/20-configuration.md#the-token-cap). A whole number from 1 to 9007199254740991 | `2000000` |
| `reviewTimeoutMs` | The deadline of one review, in milliseconds, from 1000 to 86400000: [The review's deadline](../20-using/20-configuration.md#the-reviews-deadline) | `1800000` |
| `partTokens` | The most tokens of diff text one research part holds: [Research in parts](../20-using/20-configuration.md#research-in-parts). A whole number from 1024 to 9007199254740991 | `32768` |
| `ports.profiles` | One entry per profile, keyed by profile id: `research`, its research provider, and `voters`, one provider per lens keyed by lens id. A provider may state its `timeoutMs`, its `retries`, its `worstCase` and its `room`: [What a provider states](../20-using/30-providers.md#what-a-provider-states) | Required |
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
| `maxReviewTokens` | `must be a whole number of tokens from 1 to 9007199254740991` |
| `reviewTimeoutMs` | `must be a whole number of milliseconds from 1000 to 86400000` |
| `partTokens` | `must be a whole number of tokens from 1024 to 9007199254740991` |
| `exclude` | `must be an array`, or `must hold at most 100 patterns` |
| `exclude.<index>` | `must be a string`, or what to write instead: `must not be empty`, `must be at most 256 characters long`, `ends with /, so it matches no file: end it with /** to leave out what the directory holds`, `holds ** inside a name: …`, `holds an empty, . or .. name, which no path in a diff has: …`, `holds \, which escapes nothing here: …`, `holds !, which negates nothing here: …` or `holds {, which lists no alternatives here: …` |
| `ports.profiles` | `must be an object keyed by profile id` |
| `ports.profiles.<id>` | `is missing`, `must be an object with a research provider and voters`, or `names no profile of the run` |
| `ports.profiles.<id>.research` | `is missing`, or `must be a provider: an object with a string id, a string model and a complete function` |
| `ports.profiles.<id>.voters` | `is missing`, or `must be an object keyed by lens id` |
| `ports.profiles.<id>.voters.<lens>` | `is missing`, the provider message above, or `names no lens of the profile` |
| `ports.profiles.<id>.research.timeoutMs`, `ports.profiles.<id>.voters.<lens>.timeoutMs` | `must be a whole number of milliseconds from 1000 to 518400000` |
| `ports.profiles.<id>.research.retries`, `ports.profiles.<id>.voters.<lens>.retries` | `must be a whole number from 0 to 5` |
| `ports.profiles.<id>.research.worstCase`, `ports.profiles.<id>.voters.<lens>.worstCase` | `must be a function` |
| `ports.profiles.<id>.research.room`, `ports.profiles.<id>.voters.<lens>.room` | `must be a function` |
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

Each profile is compiled once, when the quorum is created: its vote template rendered for each lens, its thresholds resolved, and its providers captured beside the `{ id, model }` each had then, which is what events and `meta` report. A later change to a profile, to `exclude`, or to which provider a port names, is never seen by a review of that quorum. The provider objects themselves are called as they are.

### `warnings`

The settings of the profiles that cannot take full effect, each starting at its profile id, such as a policy level that is never reached, the deprecated `gating`, or a `failOn` of `low` while the policy's `low` is off: [Warnings](../20-using/40-profiles.md#warnings). A quorum with warnings still runs.

## `review`

```ts
const result = await quorum.review({ diff, source, leftOut }, {
  signal: AbortSignal.timeout(10 * 60_000)
})
```

- **`diff`** is the unified diff, as a string. A blank one runs no stage, calls no model and resolves with empty lists, the review still sending `run:start` and `run:end`. One whose every file `exclude` leaves out does the same, except that its `meta.leftOut` lists the files, a `left-out` event is sent, and the text before the first header, a mail's message say, is still researched.
- **`source`**, optional, is where the diff came from: it is checked and recorded in `meta.source` as given, with its known fields only, and `{ kind: 'diff' }` when it is unset. [The source](./20-json-result.md#the-source) lists its five kinds.
- **`leftOut`**, optional, lists the files a source left out before it made the diff. They come first in `meta.leftOut` and in the `left-out` event, before the diff's own, each file, reason and rule once, and a `binary`, `submodule` or `secret` one is a gap of every profile, as the diff's are. A `skipped` one, with its `rule`, and a `deleted-secret` one are no gap, and one of the rule `secret`, or of the reason `secret` or `deleted-secret`, raises a `secret-file` flag ahead of the diff's flags: [A file left out](./20-json-result.md#a-file-left-out).
- **`send`**, optional, names the files to send the models though they are held back as secrets: each is the path as the diff writes it, the one `meta.leftOut` lists, matched exactly, so `./.env` names no file `.env`. A file named here is not held, so it is neither listed nor flagged as a secret, and an `exclude` pattern still leaves it out first. The text no header names, which has the empty name, can never be named, and neither can a file by a changed spelling: such a file stays held, with its path in `meta.leftOut` to write. The array is copied before the review's first `await`. A program that reads a config's `send` passes it here itself, as it passes `exclude` to `readSource`, and as the CLI does with the config's `send` and `--send` merged.
- **A file held back as a secret** is no part of any request: a file whose name is a secret's, or that holds a credential quorum recognizes, leaves the diff whole, is listed in `meta.leftOut` as `secret` with its `rule`, raises a `secret-file` flag and is a `secret` gap of every profile, which no flag lifts. A change that deletes a file named as a secret whole lists it as `deleted-secret`, with its flag and no gap; a deletion of a file held for a credential in it, whose removed code would go unread, is a `secret` gap. A diff whose every file is held runs no stage and still records the gaps: [Files held back as secrets](../20-using/15-sources.md#files-held-back-as-secrets).
- **`signal`**, optional, stops the review: [Abort](#abort).
- **A quorum reviews any number of diffs**, one per call. Each review has its own concurrency limit and its own signal, and several may run at once.

It resolves with the [result](./20-json-result.md), or rejects:

| With | When |
| --- | --- |
| A `ConfigError` | The input is malformed, before any event: `input: must be an object holding the diff string` when the input is not an object, such as the diff text passed on its own; `diff: must be a string`; `source: must be an object`, `source.kind: must be diff, range, local, staged or paths`, `source.objectFormat: must be sha1 or sha256`, `source.<field>: must be a full commit id of its object format: 40 lowercase hexadecimal characters for sha1, 64 for sha256` (and, for the `head` of a `local` or `staged` source, `, or null when nothing is committed`), `source.paths: must be an array of strings` or `source.skips: must be a boolean`; `leftOut: must be an array`, `leftOut.<index>: must be an object with a file and a reason`, `leftOut.<index>.file: must be a string`, `leftOut.<index>.reason: must be excluded, binary, submodule, skipped, secret or deleted-secret`, `leftOut.<index>.rule: must be vendored, lockfile, minified, secret, binary, submodule or lfs` (for a `skipped` file, which has one), `leftOut.<index>.rule: must be name, private-key, aws-key, github-token, slack-token, google-key, stripe-key, anthropic-key or openai-key` (for a `secret` or `deleted-secret` file, which has one) or `leftOut.<index>.rule: belongs to a skipped, secret or deleted-secret file only`; `send: must be an array` or `send.<index>: must name a file` (an entry that is not a non-empty string, a hole included); `options: must be an object`; or `signal: must be an AbortSignal` |
| The signal's reason | The signal aborted, before the review or while it ran |
| The sink's error | The event sink threw |
| A `ProviderError`, or what a provider of your own throws | A gating profile's research call failed, or the call of one part of its research in parts, unless it was a refusal of kind `too-large`, which is a gap |
| An `OutputError` | A gating profile's research reply, or the reply of one of its parts, is not one JSON object holding a `findings` array and nothing else |

A failed vote never rejects a review: it is recorded in its verdict.

## Events

The sink receives every event of a review, synchronously and in order, as each thing happens:

| Event | Fields | Sent |
| --- | --- | --- |
| `run:start` | `profiles`, the ids in order; `providers`, who reviews for each profile: `research` and `lenses`, each a `{ id, model }` | First, when the review starts |
| `left-out` | `files`, as `meta.leftOut` holds them, the input's own first: [A file left out](./20-json-result.md#a-file-left-out) | Once, right after `run:start`, when the review leaves a file out |
| `flag` | `flag`, as `meta.flags` holds it, the `secret-file` flags of the files left out first: [A flag](./20-json-result.md#a-flag) | Once per flag, after `run:start`, the `left-out` event and the gaps, before any stage |
| `stage:start` | `profile`; `stage`: `research`, `dedup` or `panel` | When a stage of a profile starts |
| `stage:end` | `profile`, `stage`; `durationMs`, the stage's wall-clock time, waits for a concurrency slot included; `count`, the findings it produced, or the verdicts for `panel` | When that stage ends |
| `call` | `profile`; `role`: `research` or `vote`; `lens`, for a vote; `provider`, its `{ id, model }`; `durationMs`, from the call's first attempt to its end, inside its slot, the waits between attempts included; `ok`; `attempts`, the number of attempts, only when the call made more than one; `usage`, summed over its attempts, when the counts they reported are valid: a call that succeeded, or one that failed on a reply its provider read and refused, whose error carries them in an own `usage` property ([`ProviderError`](../20-using/30-providers.md#providererror)); `spent`, the tokens the review's cap counted for the call: each attempt's reported usage, nothing for one the server refused before any work, else its reservation ([The token cap](../20-using/20-configuration.md#the-token-cap)) | Once per provider call, failed ones included; a research in parts makes one call per part, in order; none for a call that the cap, the deadline or the review's abort stopped before its first attempt |
| `finding:invalid` | `profile`; `reason`, such as `src/auth.js:3 is not in the diff` | Once per finding dropped for citing code outside the diff |
| `incomplete` | `entry`, as `meta.incomplete` will hold it | Once per gap, as it is recorded: the gaps of the binary, submodule and held files left out first, in that order, then the profile's `too-large` gap, right after `run:start` and the `left-out` event and before any call; the gaps of a research in parts once every part has answered, after the `finding:invalid` events; a limit's gap last for its profile, after the `stage:end` of its `panel` |
| `vote` | `profile`, `findingId`, `lens`; `keep`: `true`, `false`, or `null` when the vote failed; `error`, then `failure`, for a failed vote: its `kind` and, for an `http` failure, its `status`, as the result's vote holds them ([A vote](./20-json-result.md#a-vote)) | Once per vote |
| `verdict` | `profile`, `findingId`, `keptVotes`, `totalVotes`; `confidence`, when it reached one; `status`: `kept`, `discarded` or `unreviewed` | Once per finding, when all its votes are in |
| `run:end` | `kept`, `discarded`, `unreviewed` and `incomplete`, the counts; `durationMs` | Last, when the review ends |

The first events of the review on [The JSON result](./20-json-result.md#an-example), as the sink received them:

```text
{"type":"run:start","profiles":["security"],"providers":{"security":{"research":{"id":"default","model":"qwen3.6:27b"},"lenses":{"reachability":{"id":"default","model":"qwen3.6:27b"},"impact":{"id":"default","model":"qwen3.6:27b"},"defenses":{"id":"default","model":"qwen3.6:27b"}}}}}
{"type":"stage:start","profile":"security","stage":"research"}
{"type":"call","profile":"security","role":"research","provider":{"id":"default","model":"qwen3.6:27b"},"durationMs":0,"ok":true,"usage":{"inputTokens":1840,"outputTokens":412},"spent":2252}
{"type":"finding:invalid","profile":"security","reason":"src/auth.js:3 is not in the diff"}
{"type":"incomplete","entry":{"profile":"security","reason":"finding-unreadable","detail":"findings[4]: quote: Invalid input: expected string, received undefined"}}
{"type":"stage:end","profile":"security","stage":"research","durationMs":8,"count":3}
```

- **The sink runs inside the review.** Each event is delivered before the review goes on, so a slow sink slows the review.
- **Events carry no model text beyond `error` strings**, the file name a `finding:invalid` reason quotes, which is the finder's, cleaned and capped at 80 characters, and, for a diff without per-file headers, the `file` and `detail` of a `vote-failed` entry or of a vote's `request-too-large` entry, which hold the finder's name for the file, cleaned and capped at 260. The `file` of a `flag` event is the diff's own path, and absent for a diff without per-file headers. The `file` of a `left-out` event's files is the diff's own path, or `""`, and for a file the input's `leftOut` lists, the name the caller gave.
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
- **The signal is checked before every stage, and inside every call's concurrency slot** before the provider is called, so a call still queued when the review is aborted never starts. Every request carries its attempt's signal, so a provider can stop a call in flight. It is checked once more after the profiles have run, a blank diff included, so an abort that lands when no stage is left to check still rejects.
- **A vote cut by the abort is never a failed vote.** It rethrows the abort's reason, so an aborted review never resolves with a finding the abort left unreviewed, and the review rejects at once, without waiting for the votes still in flight.
- **No event is delivered once the review is aborted.**
- **One failed gating profile stops the others.** A gating profile whose research fails aborts the review with that error, and the review rejects with it. An advisory profile's failed research, the call or its reply, is its `research-failed` gap instead: it aborts nothing, and the other profiles go on. When the research call itself fails, the review is aborted before the call's concurrency slot is released, so no other profile starts a call after it. When the reply is not a valid envelope, the review is aborted when the reply is checked, which happens after the call has released its slot, so a call another profile had queued may already have started. Either way, no event arrives after the rejection.
- **An abort after `run:end` has no effect**: the review is over, and resolves with its result.
- **The review's deadline is no abort**: at `reviewTimeoutMs` the review resolves, its calls and waits stopped and recorded as `review-deadline` gaps, while an abort rejects. An abort that comes after the deadline still rejects, with its own reason: [The review's deadline](../20-using/20-configuration.md#the-reviews-deadline).
- **The review never waits for a call it stopped.** Each attempt has a signal of its own, aborted with the review's or at its deadline, and the review settles the attempt at once; the shipped adapters stop their request or process on it, and a provider that ignores it works on, outside the review.

## `estimate`

```ts
const estimate = quorum.estimate({ diff, send })
if (!estimate.fits) console.error('this review may not finish under its token cap')
```

```ts
interface Estimate {
  profiles: Record<string, ProfileEstimate>
  expected: number
  worst: number
  inFlight: number
  maxReviewTokens: number
  reviewTimeoutMs: number
  fits: boolean
}

interface ProfileEstimate {
  parts: number[]
  votes: number
  vote: Record<string, number>
  expected: number
  worst: number
}
```

`estimate` says what a review of the diff may cost, in tokens, before any call. It sends nothing and reads no file: it filters the diff and plans each profile's research as `review` does, then asks each provider for the `worstCase` and the `room` it states, on the requests the review would build. Every figure is what the review's token ledger reserves for a call, not what the call spends. The input is `{ diff, send }`, `send` optional as `review`'s is: the estimate reads the diff less its held files, so a file held back as a secret costs nothing and one `send` names is counted. It throws a `ConfigError` for an input `review` would refuse, such as a `diff` that is not a string.

| Field | Holds |
| --- | --- |
| `profiles` | One entry per profile, keyed by its id, in the run's order |
| `profiles.<id>.parts` | What the ledger reserves for each research request of the profile, in order: one for a diff researched whole, else one per part that holds more than white space, as [Research in parts](../20-using/20-configuration.md#research-in-parts) packs them. Empty when research makes no call |
| `profiles.<id>.votes` | The most votes the panel casts: `maxFindings` times the profile's lenses. 0 when research makes no call |
| `profiles.<id>.vote` | What the ledger reserves at most for one vote of each lens, keyed by lens id: the request for a finding at the longest the harness lets one be, citing the largest section of the diff. For a lens whose voter states a room that section exceeds, it is the partial request, filled to that room. Empty when research makes no call |
| `profiles.<id>.expected` | The research parts alone, each at a third of its reservation, rounded up: the bound is one token per byte, and code takes about one per three. The votes are not in it, since how many findings research reports is not known before it runs |
| `profiles.<id>.worst` | The parts in full, and `maxFindings` votes of every lens at its bound |
| `expected`, `worst` | The sums over the profiles |
| `inFlight` | What the calls that run at once reserve: the sum of the `concurrency` largest bounds among every research part and every vote of every profile, a lens's bound counted `maxFindings` times |
| `maxReviewTokens`, `reviewTimeoutMs` | The quorum's limits, as `createQuorum` took them |
| `fits` | `expected + inFlight <= maxReviewTokens`: whether the research may finish under the cap |

A blank diff, and one whose every file `exclude` leaves out or is held back as a secret, make no call: every figure is 0, `parts` and `vote` are empty and `fits` is true. The CLI prints the estimate of a path review and refuses one that does not fit unless `--large` is given: [What a path review costs](../20-using/15-sources.md#what-a-path-review-costs). It is an estimate, not a limit: each call of a review still reserves its worst case against `maxReviewTokens`, whatever `fits` says, so a review that does not fit stops at the cap with a `token-cap` gap, and one that fits may stop there too, since the votes are in `worst` alone.

## `readSource`

```ts
declare function readSource(spec: SourceSpec, context: {
  readonly cwd: string
  readonly env: Env
  readonly signal?: AbortSignal
  readonly exclude?: readonly string[]
  readonly send?: readonly string[]
}): Promise<SourceRead>

type SourceSpec
  = | { readonly kind: 'diff', readonly text: string }
    | { readonly kind: 'range', readonly range: string }
    | { readonly kind: 'local' | 'staged', readonly trustRepoConfig?: boolean }
    | { readonly kind: 'paths', readonly paths: readonly string[], readonly at?: string, readonly skips?: boolean }

interface SourceRead {
  readonly diff: string
  readonly source: ReviewSource
  readonly leftOut: LeftOutFile[]
}
```

`readSource` makes the diff a review reads, as the CLI does, and answers with what `review` takes as its input: the `diff`, where it came from (`source`, which `review` records in `meta.source`) and the files the source left out before it made the diff (`leftOut`). It is the one entry to every source of [Sources](../20-using/15-sources.md), whose pages say what each does:

| `kind` | Reads | Its fields |
| --- | --- | --- |
| `diff` | The text it holds, as it is | `text`: a diff over 16 MiB of UTF-8 is refused |
| `range` | The commits `<base>...<head>`: the merge base diffed with the head | `range`, written `<base>...<head>`, as `--range` takes it |
| `local` | What `git add -A` would commit: the staged, the unstaged and the untracked changes | `trustRepoConfig`: true when the repository is yours, so a filter its own config names may run: [Trust](../20-using/15-sources.md#trust) |
| `staged` | What the next commit holds | `trustRepoConfig`, as `local` |
| `paths` | The files under each path at a commit, each written as a new file | `paths`, relative to `cwd` as `--path` is; `at`, the commit, `HEAD` when unset; `skips`, whether the default skips (vendored, lockfile, minified and binary files) apply, true when unset: a secret is skipped whatever it says |

- **The context** is where it reads. `cwd` is the directory a git source opens as its repository, and a path of `paths` is relative to; `env` is the environment, whose `PATH` git is looked up in (its absolute entries only) and from which the git child gets an allowlist and nothing else; `signal` stops a git command in flight; `exclude` holds the patterns of [Excludes](../20-using/20-configuration.md#excludes), which a source that reads files applies before it reads them: the untracked files of `local`, and each file of `paths`; and `send` holds the files `paths` reads though it skips a secret otherwise, by its name or by a credential in its text, each the path as the diff writes it and `meta.leftOut` lists it, an exact string. The same list goes to `review`'s `send`, since the review holds back what it is sent all the same. The package fills in the platform, and takes no other git than the system's: a git source runs Linux and macOS, and needs git 2.41 or later.
- **It refuses with a `ConfigError`,** each issue naming the flag the CLI names for it as its path: `--range`, `--local`, `--staged` or `--path`, and `--at` for a commit that names nothing. A diff's issues have an empty path, and `kind` is the path of an unknown kind (`must be diff, range, local, staged or paths`), so a spec built without types never gets `undefined`. A git command that fails is a `GitError` instead: [Git errors](#git-errors).
- **Nothing is cut or dropped in silence.** A source that cannot read all of what it was asked to refuses, or lists what it left out in `leftOut`: a skipped file with its rule, an excluded one, a binary file or a submodule. A reader that meets a `kind`, a `reason` or a `rule` it does not know takes it as a source it cannot describe, or a file left out, never as an error.

```ts
import { readSource } from '@tobi-or-not/quorum'

// `quorum` comes from `createQuorum`, as in the complete example below.
const spec = {
  kind: 'paths',
  paths: ['src']
} as const
const input = await readSource(spec, {
  cwd: process.cwd(),
  env: process.env,
  exclude: ['**/*.spec.ts']
})
if (!quorum.estimate(input).fits) throw new Error('src may not finish under the token cap: name a narrower path')
const result = await quorum.review(input)
```

## `outcome`

```ts
declare function outcome(result: QuorumResult, options?: { readonly allowIncomplete?: boolean }): Outcome

type OutcomeStatus = 'pass' | 'findings' | 'incomplete'

interface Outcome {
  readonly status: OutcomeStatus
  readonly exitCode: 0 | 1 | 4
  readonly lifted: boolean
}
```

`outcome` says what a review comes to: the rule that decides the CLI's exit code, for a program that reads a result. `status` is `pass`, `findings` or `incomplete`, `exitCode` is the code that says it, and `lifted` is `true` when `allowIncomplete` turned an incomplete review into a pass, so a report never calls that run complete. It reads the result and calls nothing. What decides each, in this order:

- **`1`, `findings`.** A kept finding is at or above the level of its profile, `meta.profiles.<id>.failOn`: `high` fails a `high` finding, `medium` a `high` or `medium` one, `low` any, and `none` none ([Gating](../20-using/40-profiles.md#gating)). It wins over `4`, whatever else is missing.
- **`4`, `incomplete`.** An unreviewed finding, or an entry of `meta.incomplete`, belongs to a gating profile: one whose level is not `none`. The gaps and findings of a profile at `none` change nothing.
- **`0`, `pass`.** Neither of the two.

A result of an earlier release has no `failOn`, and `outcome` reads its `gating`: `false` is `none`, anything else `high`, and a `failOn` that is a level wins. A `failOn` that is no level, or that the entry only inherits, is unreadable, so `outcome` reads the `gating` beside it the same way: `gating: false` gives `none`. A profile with no readable field at all, one missing from `meta.profiles` or an entry that is `null`, gates at `high`, so a gap in a result never hides a finding.

`allowIncomplete` lifts what the CLI's `--allow-incomplete` lifts, and nothing else: the `4` becomes `0`, `lifted` is `true`, only when every gap of a gating profile is a `vote-failed` one and every failed vote behind the gaps failed in passing, never when a `1` is due: [Exit codes](../20-using/10-cli.md#exit-codes). A `secret` gap, a `too-large` gap and every other reason stay `4`, since a pull request can cause them.

```ts
import { outcome } from '@tobi-or-not/quorum'

// `result` comes from `quorum.review`, as in the complete example below.
const { status, exitCode, lifted } = outcome(result, { allowIncomplete: true })
```

## Errors

| Class | Extends | Fields | Thrown for |
| --- | --- | --- | --- |
| `QuorumError` | `Error` | `name`, the class's own name | The base of every error quorum raises on purpose |
| `ConfigError` | `QuorumError` | `issues`, each a `{ path, message }`, every one; the message holds one `path: message` line per issue for the first 50, then `and <n> more issues` | Invalid configuration or input, every issue at once. The CLI exits `2` on it |
| `ProviderError` | `QuorumError` | `providerId`, `kind`, `status`, `retryable`, `retryAfterMs`, `usage` | A provider call that failed: [`ProviderError`](../20-using/30-providers.md#providererror) |
| `OutputError` | `QuorumError` | `stage`, `reason`; `snippet`, the first 200 characters of the reply | A model reply that could not be read: `<stage> reply unusable: <reason> (reply starts: "<snippet>")` |
| `GitError` | `QuorumError` | `operation`, the git subcommand (`diff`, `rev-parse`, `ls-tree`, and `version` for `--version`); `exitCode`, git's, or `null` when it did not start or did not finish | A git command a source ran that failed: [below](#git-errors). The CLI exits `3` on it |

A gating profile's failed research call rejects the review with its `ProviderError`, and its unusable research reply with its `OutputError`. An advisory profile's is its `research-failed` gap instead, in words the code writes: `the research call failed (http 503) after 3 attempts`, or `the research reply could not be read: <reason>`, which quote nothing a server or a model wrote. The same errors from a vote are recorded in the vote's `error` and `failure` instead. A `ProviderError` of kind `too-large`, from research or from a vote, is a `request-too-large` gap instead: the review does not reject, and a provider of your own raises it to have its own refusal of an oversized request recorded so. Any object with an own `kind` property of `'too-large'` counts, whatever its class, so a refusal from a second copy of quorum is a gap too.

### Git errors

A `GitError` comes from `readSource`, never from `review`. Its message says the git subcommand and what happened, and holds git's stderr only cut to 500 characters and written as a JSON string, so a line of it is inert: `git diff failed (exit 128): "fatal: bad object"`. The others are `git could not start (ENOENT)`, `git diff did not finish within 120000 ms`, `git diff was stopped by SIGKILL`, `git rev-parse printed an object format quorum does not read`, `git ls-tree printed an entry quorum cannot read`, `git ls-tree could not size an object the commit names: the repository lacks it, as a partial clone does`, `git cat-file did not return each listed blob at its listed size`, `git <subcommand> printed more than quorum reads`, when a call prints over the cap it is held to, and `git <subcommand> printed something quorum cannot read`, when a call exits cleanly and prints what is no full id or list of filter keys. A revision as typed and a path are never in it: [How quorum runs git](../20-using/15-sources.md#how-quorum-runs-git). A source that refuses what it was given, git missing or older than 2.41 included, is a `ConfigError` instead.

## Config types

```ts
declare function defineConfig(config: QuorumConfig): QuorumConfig
```

`loadConfig` reads a named config file and `fromConfig` builds a quorum from a config: [`loadConfig` and `fromConfig`](#loadconfig-and-fromconfig). The CLI and `runQuorum` read their settings through these two functions: [Configuration](../20-using/20-configuration.md). These exports write and type-check a config:

- **`QuorumConfig`** types what a TS or JS config exports as its default: `$schema`, for an editor, `version`, `providers`, `roles`, `concurrency`, `maxFindings`, `partTokens`, `maxReviewTokens`, `reviewTimeoutMs`, `exclude`, `send` and `profiles`, every one optional. `send` is a list of non-empty file paths, the files to send the models though they are held back as secrets: [Sending a held file](../20-using/20-configuration.md#sending-a-held-file). A provider is an object implementing `Provider`, or its settings, every one optional too: `preset`, `protocol`, `baseUrl`, `model`, `contextTokens`, `apiKeyEnv` and `apiKey`, then `auth`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField`, `systemPrompt`, `timeoutMs` and `retries`, as [Providers](../20-using/30-providers.md#options) and [Deadlines and retries](../20-using/30-providers.md#deadlines-and-retries) describe them, and the fields of a `claude-code` provider, `args` and, in a code config only, `command`: [Claude Code options](../20-using/30-providers.md#claude-code-options).
- **`QuorumConfigFile`** types what a YAML or JSON config holds: the same settings, as data only, so a provider is always its settings, and names the environment variable that holds its key in `apiKeyEnv`, never holding one.
- **`ConfigInput`** types what `fromConfig` takes: the settings of `QuorumConfig`, with every prompt a string, since a program's config reads no file and so holds no `{ file }`.
- **`defineConfig`** returns the config it is given, as it is. Wrapping a default export in it has the editor check every field.

A config that imports nothing from quorum when it runs types its object with `import type` and `satisfies` instead, since `import type` is erased:

```ts
// quorum.config.mts
import type { QuorumConfig } from '@tobi-or-not/quorum'

export default {
  providers: {
    local: { preset: 'ollama', model: 'qwen3.6:27b', contextTokens: 131072 },
    hosted: {
      preset: 'openai',
      model: 'gpt-5',
      contextTokens: 400000,
      apiKey: process.env.OPENAI_API_KEY
    },
  },
  roles: { research: 'local', voter: 'hosted' },
} satisfies QuorumConfig
```

The import is erased when the file loads, so it matters to the editor alone: it resolves the types when the package is installed in the project that holds the config, for example as a dev dependency. The `.mts` extension makes the file an ES module whatever the nearest `package.json` says: Node refuses `export` in a `.ts` or `.js` file of a package whose `package.json` says `"type": "commonjs"`. Node also strips erasable TypeScript only, so a config holds no `enum`, `namespace` or parameter property. An editor checks a YAML or JSON config against the JSON Schema committed as [`schema/quorum.schema.json`](../../schema/quorum.schema.json), which the package ships as `node_modules/@tobi-or-not/quorum/schema/quorum.schema.json`: a YAML file names it in a comment, `# yaml-language-server: $schema=<path or URL of the schema>`, and a JSON file in its `"$schema"` field.

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
import { fromConfig, inertLine, loadConfig } from '@tobi-or-not/quorum'

const { config } = await loadConfig({ configPath: 'quorum.yaml' })
const quorum = await fromConfig(config)
for (const warning of quorum.warnings) console.error(inertLine(`warning: ${warning}`))
const result = await quorum.review({ diff })
```

`fromConfig({}, { env: process.env })` needs no file: the environment alone names a provider, a model and the model's context size, with `QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS`. The CLI and `runQuorum` read the `QUORUM_*` variables, with the deprecated `RESEARCH_*` and `VOTER_*` aliases, and the file `QUORUM_CONFIG` names through these two functions.

- **`options.cwd`** is the directory a relative `configPath` resolves against, the working directory by default. `source` is the absolute path of the file read, and `undefined` when none was.
- **`QUORUM_CONFIG` must be an absolute path.** A relative one is refused with a `ConfigError` holding the issue `QUORUM_CONFIG: must be an absolute path`, whether or not `configPath` is given: a variable set once would resolve inside whatever directory the process runs in, and in CI that is a pull request's checkout, which could plant the file. A `configPath` is named per call, so it may be relative.
- **`options.selection`** names the profiles that run, over `QUORUM_PROFILES`, which is still read and checked: a malformed variable is refused even when a selection is given. `path` is what the selection's issues name, and the CLI passes `--profile`. Each id must match `^[a-z][a-z0-9_-]*$`, and none may repeat.
- **`options.events`** is the event sink of the quorum, as `createQuorum` takes it.
- **`options.env` is also the environment a `claude-code` provider's child starts from**, less what the provider's auth mode removes: [The auth modes](../20-using/30-providers.md#the-auth-modes). Without an `env`, `fromConfig` hands `process.env` to the `claude` child, the whole of it, for a `ResolvedConfig` too. A program that holds secrets `claude` does not need passes an `env` of its own, with `PATH` and what `claude` authenticates with.
- **A process imports a TS or JS config once.** A second `loadConfig` of the same file gets the module the first import cached, since Node and Bun cache a module by its URL.
- **A program passes its config's `send` itself.** `fromConfig` builds a quorum, and `send` belongs to one review's input, so a program that reads `config.send` of a `ResolvedConfig` gives it to `readSource`'s context and to `review` (and `estimate`) itself, as the CLI does, with whatever it adds of its own: `const send = [...config.send ?? [], ...mine]`. A review that is not given it holds the file back.
- **A named config is trusted input.** It chooses where each key goes, and a TS or JS one runs code: in CI it must come from the base branch or from outside the pull request's checkout, never from the pull request under review, and its prompt files with it ([Layering](#layering)).
- **A `ResolvedConfig`** holds `providers`, the ones a profile that runs uses, by name: a spec with its key read into `apiKey`, or the snapshot of an object implementing `Provider`; `profiles`, each a `ResolvedProfile`: its `profile`, `research`, the name of its research provider, and `voters`, the name of each lens's provider, by lens id; `concurrency`, `maxFindings`, `maxReviewTokens` and `reviewTimeoutMs` when the variables or the config set them, `partTokens` when the config sets it, `exclude` when the config lists a pattern, `send` when it lists a file, and `warnings`. It is a copy, frozen all the way down: a provider object is a frozen snapshot of the program's, with no prototype, named by its config key as its `id`, and holding the `timeoutMs`, `retries`, `worstCase` and `room` it states.
- **A `ResolvedConfig` holds the keys it read**, as a code config does: never print or log one. The CLI's [`--print-config`](../20-using/10-cli.md#printing-the-resolved-config) redacts them.
- **`fromConfig` of a `ResolvedConfig` reads no environment**: what `loadConfig` resolved is what runs, whatever `options.env` holds, except that a `claude-code` provider's child still starts from `options.env`, else `process.env`.
- **A config is read as its own fields, with one limit.** A field planted on `Object.prototype` is a prototype pollution bug in the same process. An enumerable one is a field of every object, so it is refused as `is not a known field` wherever the schema does not know it: a planted `baseUrl` is refused at the top level, while a planted `concurrency`, `maxFindings`, `partTokens`, `maxReviewTokens`, `reviewTimeoutMs`, `exclude`, `send` or `version` passes when the config holds no object that refuses it, and a planted `exclude` is the one that widens what passes unread, and a planted `send` what a provider is sent. One planted with `Object.defineProperty` is not enumerable, and the schema reads each field it knows through the prototype, so it becomes a field of the config, or of every provider that leaves it unset. Code that can plant either can read the keys directly: quorum does not defend against it.

### Layering

Each layer sits over the one before it: the built-in defaults, then the file `configPath` names (else the one `QUORUM_CONFIG` names), then the environment.

- **The built-in defaults.** A config that defines no provider gets one named `default`, with no model and no context size, so `QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS`, or a file, must set them. The rule: with no provider configured and no base URL, preset or protocol variable for a role, that role talks to the Ollama on this machine through its native API, `http://localhost:11434`, where Ollama listens, on `127.0.0.1`, by default; a role whose variables set a base URL without a preset or a protocol speaks `openai-compatible` to that URL, as before. A voter with no variables of its own shares the research provider: [The voter's fallback](../20-using/20-configuration.md#the-voters-fallback). The native API tells Ollama the context size and makes it refuse an overflow (Ollama 0.12.6 or later; an older server ignores `truncate` and `shift`), where its OpenAI-compatible `/v1` cuts an oversized prompt in silence. A config with no `profiles` field runs the `security` profile.
- **A profile over its base.** A profile named after a built-in profile, or with `extends`, starts from it: its prompts and its policy levels replace the base's one field at a time, and its lenses replace the base's lenses as a whole.
- **`undefined` is unset, `null` is set.** In a program's config or a code config, a field set to `undefined` leaves the layer below's value in place, as if it were not written; `null` is a value, such as `temperature: null`, which leaves the field out of the request.
- **No file is searched for.** A file loads only when it is named, by `configPath` first, then `QUORUM_CONFIG`: a `quorum.config.yaml` in the working directory is never read, since in CI that directory is a pull request's checkout, and a pull request could plant one.
- **A named config is trusted like code.** It chooses where each key goes: a `baseUrl` of its own beside an `apiKeyEnv` sends the key that variable holds to that host. A TS or JS config also runs, with the job's environment. So in CI a named config must come from the base branch or from a path outside the pull request's checkout, never from the pull request under review, and its prompt files, which resolve against its directory, must come from the same place.

### The environment variables

| Variable | Sets |
| --- | --- |
| `QUORUM_CONFIG` | `loadConfig` only: the config file to read, when `configPath` is not given. It must be an absolute path |
| `QUORUM_PROFILES` | The profiles that run: ids separated by commas, each a profile the config defines or a built-in one, none twice |
| `QUORUM_RESEARCH_PRESET`, `QUORUM_VOTER_PRESET` | A role's provider, built from a [preset](../20-using/30-providers.md#presets) |
| `QUORUM_RESEARCH_PROTOCOL`, `QUORUM_VOTER_PROTOCOL` | A role's provider, built from a wire protocol: `openai-compatible`, `anthropic`, `gemini` or `ollama`, or `claude-code` for your installed Claude Code CLI |
| `QUORUM_RESEARCH_BASE_URL`, `QUORUM_VOTER_BASE_URL` | The base URL of a role's provider. Set on its own, with no provider in a config and no preset or protocol variable for the role, it names an `openai-compatible` server, except for a voter derived from a research provider whose variables name a preset or a protocol, which keeps that protocol: [The role variables](#the-role-variables) |
| `QUORUM_RESEARCH_MODEL`, `QUORUM_VOTER_MODEL` | The model of a role's provider |
| `QUORUM_RESEARCH_CONTEXT_TOKENS`, `QUORUM_VOTER_CONTEXT_TOKENS` | The context window of a role's provider's model, in tokens: a whole number from 1 to 999999999. It has no deprecated alias |
| `QUORUM_RESEARCH_TIMEOUT_MS`, `QUORUM_VOTER_TIMEOUT_MS` | The deadline of one attempt of a role's provider, in milliseconds: a whole number from 1000 to 86400000. On a `claude-code` provider it is Claude Code's wait for each attempt's response headers, and the whole run's deadline is that times the retries plus one: [Stopping, nesting and the version](../20-using/30-providers.md#stopping-nesting-and-the-version). It has no deprecated alias |
| `QUORUM_RESEARCH_RETRIES`, `QUORUM_VOTER_RETRIES` | How many times a call of a role's provider that failed in passing is tried again: a whole number from 0 to 5. It has no deprecated alias |
| `QUORUM_RESEARCH_API_KEY`, `QUORUM_VOTER_API_KEY` | The key of a role's provider, as a literal `apiKey` |
| `QUORUM_CLAUDE_CODE_COMMAND` | The `claude` executable of every `claude-code` provider a profile uses: an absolute path, or a name found in the absolute entries of `PATH`; a relative path and a `.cmd` or `.bat` file are refused. It wins over a code config's `command`: [Where the command comes from](../20-using/20-configuration.md#where-the-command-comes-from) |
| `QUORUM_MAX_REVIEW_TOKENS` | The review's token cap: a whole number of tokens from 1 to 9007199254740991, over the config's `maxReviewTokens` |
| `QUORUM_REVIEW_TIMEOUT_MS` | The review's deadline, in milliseconds: a whole number from 1000 to 86400000, over the config's `reviewTimeoutMs` |
| `RESEARCH_BASE_URL`, `RESEARCH_API_KEY`, `RESEARCH_MODEL`, `VOTER_BASE_URL`, `VOTER_API_KEY`, `VOTER_MODEL` | Deprecated aliases: each is read as the `QUORUM_` variable of the same name |

- **The `QUORUM_` form wins** over its alias when both are set, and one warning names every alias that is set, whichever form won: `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead`. A preset, a protocol, a context size, a deadline and a retry count have no alias.
- **Every value is trimmed, and a blank one is unset.** Only the variables the environment holds itself are read, never one an object it inherits from holds.
- **`QUORUM_PROFILES` refuses what would review nothing or the wrong thing**: an empty id, an id that is not lower-case letters, digits, `_` and `-` after a letter, or an id named twice.
- **`QUORUM_MAX_REVIEW_TOKENS` and `QUORUM_REVIEW_TIMEOUT_MS` belong to no role.** Each is read as strictly as a role's numbers, and a value that is read wins over the config's field; `fromConfig` hands both to `createQuorum`: [The limits of a review](../20-using/20-configuration.md#the-limits-of-a-review).

### The role variables

- **The research variables** set the provider `roles.research` names, which a voter or a lens that shares it inherits.
- **The voter variables** set the provider `roles.voter` names when that is another provider than research's. When the voter shares the research provider, they derive a provider named `voter` from it, and bind the voter role to it. A config that already has a provider named `voter` cannot be derived over: rename it.
- **A derived voter keeps what is safe on its endpoint**, as the voter's fallback of [Configuration](../20-using/20-configuration.md#the-voters-fallback) does, and a key, header, query parameter, body field or model never reaches another origin:

| `QUORUM_VOTER_BASE_URL` | The voter's base URL | Its key | Its model | Its context size | The rest of the research provider's settings |
| --- | --- | --- | --- | --- | --- |
| Unset | The research provider's | `QUORUM_VOTER_API_KEY`, else the research provider's key | `QUORUM_VOTER_MODEL`, else the research provider's | `QUORUM_VOTER_CONTEXT_TOKENS`, else the research provider's while the voter variables name no preset, protocol, base URL or model | All kept |
| The same origin as the research provider's | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else the research provider's key | `QUORUM_VOTER_MODEL`, else the research provider's | `QUORUM_VOTER_CONTEXT_TOKENS` only | All kept |
| Another origin, or no `http(s)` origin | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else none: a preset's own variable is not read | `QUORUM_VOTER_MODEL`, which is then required | `QUORUM_VOTER_CONTEXT_TOKENS` only | `apiKeyEnv`, `headers`, `query`, `extraBody` and `model` dropped; the preset, protocol, `auth`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField`, `systemPrompt`, `timeoutMs` and `retries` kept |
| A `QUORUM_VOTER_PRESET` or `QUORUM_VOTER_PROTOCOL` is set | Its own, or the preset's | `QUORUM_VOTER_API_KEY`, else the preset's own variable at the preset's origin | `QUORUM_VOTER_MODEL`, which is then required | `QUORUM_VOTER_CONTEXT_TOKENS` only | None: the provider is built from the voter variables alone |

The origin is compared as the voter's fallback compares it: the scheme, the host in lower case with no trailing dot, and a port that is not the default.

- **On the built-in `default` provider, a voter base URL on its own is `openai-compatible`.** A derived voter whose variables set a base URL with no preset or protocol speaks `openai-compatible`, on another origin than research's and on the same one too (`QUORUM_VOTER_BASE_URL=http://localhost:11434/v1`), and does not inherit the default's native protocol. One that sets only a model, a context size or a key keeps research's endpoint and protocol. A voter derived from a provider a config defines, or from a research provider whose variables name a preset or a protocol, inherits that provider's protocol, as before.
- **A `PRESET` or `PROTOCOL` variable builds the role's provider afresh.** `QUORUM_RESEARCH_PRESET=anthropic` is not merged into the `default` provider, whose protocol it would contradict: the research provider is a provider of that preset, from the role's variables alone. `BASE_URL`, `MODEL`, `CONTEXT_TOKENS`, `TIMEOUT_MS`, `RETRIES` and `API_KEY` alone override fields of the provider they reach.
- **A context size belongs to one model on one endpoint.** A role's preset, protocol, base URL or model variable drops the context size of the provider it sets, unless `QUORUM_<ROLE>_CONTEXT_TOKENS` sets one; a variable that sets only a key, a deadline or a retry count keeps it. A derived voter never inherits the research provider's context size for another model or another endpoint.
- **No variable changes a provider object.** A role bound to an object that implements `Provider` with a variable set for it is an issue at the variable, never an ignored one.

### Roles and profiles

- **The role defaults.** One provider binds both roles. Several need `roles.research`, or the config is refused; `roles.voter` is `roles.research` when unset. A profile's own `roles` override the top-level ones, and a lens's `provider` overrides both.
- **Which profiles run.** The ones `selection` names, else the ones `QUORUM_PROFILES` names, else the ones `profiles` defines, else `security`. `profiles: {}` with no selection is refused: a run that reviews nothing never passes.
- **A profile's base.** A profile named after a built-in profile starts from it, so `profiles: { security: { failOn: 'none' } }` is the security profile without gating; so does one with `extends`. A profile of its own needs both prompts and its lenses. Its `failOn` is the entry's own, else what its deprecated `gating` says (`true` is `high`, `false` is `none`), else the base's, else `high`; a profile never keeps a `gating`, and an entry that sets both is refused.
- **Every defined profile and provider is checked**, whether or not a run selects or uses it, so a broken definition fails every run, as an unknown field does.

### Keys

A provider's key is the first of:

1. A literal `apiKey`: a program's or a code config's, or `QUORUM_<ROLE>_API_KEY`, which wins over a variable a file names with `apiKeyEnv`. An empty one is unset, as a blank variable is, so the next source applies.
2. The variable `apiKeyEnv` names. A variable that is not set is an issue, never a silent run without a key.
3. The preset's own variable (`OPENAI_API_KEY` for `openai`), only while the base URL keeps the preset's origin. At another origin it is not read, and a warning says so.
4. For `azure-openai`, whose preset has no base URL, `AZURE_OPENAI_API_KEY`, only on an `https` host under `openai.azure.com`.

- **A `claude-code` provider reads a key in `api-key` mode only**: `apiKey`, then the variable `apiKeyEnv` names, else `ANTHROPIC_API_KEY`. It has no preset, and a key in another mode is refused.
- **`AZURE_OPENAI_API_KEY` is one variable for every Azure resource.** It is read for any host under `openai.azure.com`, so a voter whose own variables name the `azure-openai` preset on another Azure host sends that key there.
- **A `QUORUM_<ROLE>_BASE_URL` set on a provider with an explicit `apiKeyEnv` keeps that key at the new URL.** It overrides the provider itself, not a fallback, so a literal `apiKey`, `headers`, `query`, `extraBody` and `model` also stay with the provider at the new URL. A preset's own variable is withheld off its origin, with a warning.
- **A voter derived onto another origin gets no key of the research provider**, whichever way it was set: `apiKey`, `apiKeyEnv`, a preset's variable or a `QUORUM_RESEARCH_API_KEY`.
- **Keys are read only for the providers a profile that runs uses**, so a CI job that runs one profile needs that profile's keys alone. Every provider is still checked, without its key.
- **A key sent over plain `http` to a host other than this machine** (`localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]` are this machine) is warned about.
- **A resolved config holds its keys**, so never print or log one. No message or warning repeats a key, a URL, a header value or a variable's value, and a variable's name is printed only when it is an upper-case name.

### Warnings and errors

`loadConfig` returns the config's `warnings`: the deprecation line, the line naming the `QUORUM_` variables that nothing reads, a preset's key that is not sent, a key sent over plain `http`, a key that Claude Code would bill, and a profile entry's deprecated `gating`. The `warnings` of the quorum `fromConfig` returns hold those first, then the core's: a profile setting that cannot take full effect, [Warnings](../20-using/40-profiles.md#warnings). A provider object is read only while its config is checked, inside the guard that keeps what it throws to the error's name: its `model` once and its `complete` twice (the check of plain data, then the snapshot), into a frozen snapshot with no prototype that calls the object as it is, and that snapshot is named by its config key in events and in `meta`, whatever `id` the object holds. Its `timeoutMs` and `retries` are read there too, as own data and never through a getter, into the snapshot, which keeps each that is in range; one out of range is refused at `providers.<name>.timeoutMs` or `providers.<name>.retries`, and a getter or an inherited property states nothing. So is its `worstCase`: read as own data into a function of the snapshot that calls it on the object, so the review's token cap reserves what the object says one call may cost, and refused at `providers.<name>.worstCase` when it is no function; the fingerprint and `--print-config` never see it, as they never see its `complete`. So is its `room`, read into a function of the snapshot that calls it on the object and refused at `providers.<name>.room` when it is no function; the fingerprint and `--print-config` never see it either.

| Path | Message | Cause |
| --- | --- | --- |
| The path as given | The file's own problem, such as `does not exist`, `is not valid YAML at line 2, column 1 (DUPLICATE_KEY)`, `has a syntax error` or `failed to load (Error)` | `loadConfig` could not read the file, or it is not valid |
| `QUORUM_CONFIG` | `must be an absolute path` | `loadConfig` read a relative `QUORUM_CONFIG`; `configPath` may be relative to `cwd` |
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
| `QUORUM_RESEARCH_CONTEXT_TOKENS`, `QUORUM_VOTER_CONTEXT_TOKENS` | `must be a whole number of tokens, from 1 to 999999999` | A context size variable that is not a whole number written in decimal digits in that range: `32k`, `1e5`, `0x10`, `1.5` and `0` are refused, and the message never repeats the value |
| `QUORUM_RESEARCH_TIMEOUT_MS`, `QUORUM_VOTER_TIMEOUT_MS` | `must be a whole number of milliseconds, from 1000 to 86400000` | A deadline variable that is not a whole number written in decimal digits in that range: `999`, `120s`, `1e5`, `0x3e8` and `0120000` are refused, and the message never repeats the value |
| `QUORUM_RESEARCH_RETRIES`, `QUORUM_VOTER_RETRIES` | `must be a whole number, from 0 to 5` | A retries variable that is not a whole number written in decimal digits in that range: `6`, `-1`, `1.5` and `02` are refused, and the message never repeats the value |
| `QUORUM_MAX_REVIEW_TOKENS` | `must be a whole number of tokens, from 1 to 9007199254740991` | The review's token cap variable is not a whole number written in decimal digits in that range: `0`, `1e6`, `+5`, `02000000` and `9007199254740992` are refused, and the message never repeats the value |
| `QUORUM_REVIEW_TIMEOUT_MS` | `must be a whole number of milliseconds, from 1000 to 86400000` | The review's deadline variable is not a whole number written in decimal digits in that range: `999`, `86400001` and `30m` are refused, and the message never repeats the value |
| `QUORUM_VOTER_MODEL` | `must be set when the voter variables name another endpoint than the research provider's` | The voter variables name another origin, a preset or a protocol, and no model |
| `QUORUM_RESEARCH_MODEL`, and the other variables of a role | `cannot change providers.mine, an object implementing Provider` | A variable set for a role bound to a provider object |
| `providers.voter` | `is the name the voter variables give the provider they derive: rename this provider` | The voter variables derive a provider, and one is already named `voter` |
| `profiles` | `must hold at least one profile, or be left out` | `profiles: {}` with no `QUORUM_PROFILES` |
| `profiles.<id>.prompts.research`, `profiles.<id>.prompts.vote`, `profiles.<id>.lenses` | `is required: the profile extends no built-in profile` | A profile of its own without prompts or lenses |
| `roles.research`, `roles.voter`, `profiles.<id>.roles.research`, `profiles.<id>.roles.voter`, `profiles.<id>.lenses.<index>.provider` | `unknown provider "claud" (did you mean "claude"?)`, or `unknown provider "x": the providers are a and b` | A reference to a provider that is not defined: the defined name one or two edits away, else the names. A name that is not a safe name is not repeated: `names an unknown provider` |
| `roles.research` | `is required when several providers are defined` | Several providers, and no research role |
| `profiles.<id>.failOn` | `must be one of high, medium, low or none` | A `failOn` that is none of the four levels |
| `profiles.<id>.gating` | `is deprecated and cannot be set with failOn: remove it` | An entry that sets both `failOn` and the deprecated `gating` |
| `profiles.<id>` and below | The profile's own issues: [The checks](../20-using/40-profiles.md#the-checks) | A profile that fails a check |
| No path | `no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` | The built-in provider has no model |
| No path | `no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens` | The built-in provider has no context size. A missing model is reported first, and alone |
| `providers.<name>.contextTokens` | `is required: the model's context window in tokens, which quorum checks every request against` | A provider of the config with no `contextTokens`, used by a profile or not. A derived voter that shares the research provider, context size included, is not reported twice: the research provider's issue stands for it |
| `QUORUM_RESEARCH_CONTEXT_TOKENS` | `must be set when the research variables name a model or an endpoint: a context size belongs to one model on one endpoint` | The research variables name a preset, a protocol, a base URL or a model, which drops the context size of the provider they set |
| `QUORUM_VOTER_CONTEXT_TOKENS` | `must be set when the voter variables name a model or an endpoint: a context size belongs to one model on one endpoint` | The same for the voter variables, on the derived voter or on the voter's own provider |
| `providers.<name>` | `CORP_KEY is not set` | The variable `apiKeyEnv` names, or the preset's own, is not set; `ANTHROPIC_API_KEY` for a `claude-code` provider in `api-key` mode |
| `providers.<name>` | `claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND` | A `claude-code` provider a profile uses, and no command and no `claude` in an absolute entry of `PATH` |
| `QUORUM_CLAUDE_CODE_COMMAND` | `must be an absolute path, or a name to find on PATH`, `is a Windows script, which runs only through a shell: name claude.exe instead`, or `names no executable file` | A relative path, a `.cmd` or `.bat` file, or a command that is no executable file. A code config's `command` has the last at `providers.<name>.command` |
| `providers.<name>.apiKeyEnv` | `names a variable that is not set` | The same, for a name that is not an upper-case variable name: a key pasted there is never printed |
| `providers.<name>.<field>` | The builder's: [Presets as data](../20-using/30-providers.md#presets-as-data) and [Configuration errors](../20-using/30-providers.md#configuration-errors) | A provider that the builder refuses, defined or derived |
| `QUORUM_RESEARCH_PRESET` and the other variables of a role: the preset, the protocol, the base URL, the model, the context size, the deadline, the retries and the key | The builder's, such as `must be one of ollama, ollama-cloud, ...` | A provider that the builder refuses on a field a variable set: the issue names the variable, never the provider the variables built |
| `providers.<name>.model` | `must be a string` | A provider object whose model is not a string |
| `providers.<name>.timeoutMs`, `providers.<name>.retries` | `must be a whole number of milliseconds from 1000 to 518400000`, or `must be a whole number from 0 to 5` | A provider object that states one out of range, as an own data property |
| `providers.<name>.worstCase` | `must be a function` | A provider object that states a `worstCase`, as an own data property, that is no function |
| `providers.<name>.room` | `must be a function` | A provider object that states a `room`, as an own data property, that is no function |

The warnings, each but the first two starting at the path it is about:

| Warning | Cause |
| --- | --- |
| `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead` | A deprecated alias is set; one line names every alias, and every `QUORUM_` variable to set instead |
| `QUORUM_PROFILE is not a variable quorum reads` | A `QUORUM_` variable that is set and that quorum does not read: one line names every such variable, sorted, and prints a name that is not an upper-case variable name as `*` |
| `providers.gpt.baseUrl: is not the endpoint of the openai preset, so OPENAI_API_KEY is not sent: set apiKeyEnv to send a key` | A provider of a preset whose base URL is not the preset's origin |
| `providers.voter.baseUrl: is not the endpoint of the research provider, so OPENAI_API_KEY is not sent: set QUORUM_VOTER_API_KEY to send a key` | A derived voter on another origin than research's, whose provider keeps a preset that has a key variable |
| `providers.gpu.baseUrl: sends the key over plain http to a host other than this machine` | A key that would travel in cleartext |
| `providers.default: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key` | A `claude-code` provider a profile uses, under `inherit` or with no `auth`, while `ANTHROPIC_API_KEY` is set |
| `profiles.team.gating is deprecated: set failOn instead, high for true and none for false` | A profile entry that sets `gating`, which still reads: `true` as `high`, `false` as `none` |

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
| `claudeCode` | The adapter that runs your installed Claude Code CLI: [Providers](../20-using/30-providers.md#claudecode) |
| `gemini` | The Gemini `generateContent` adapter: [Providers](../20-using/30-providers.md#gemini) |
| `ollama` | The Ollama native chat adapter: [Providers](../20-using/30-providers.md#ollama) |
| `openaiCompatible` | The OpenAI-compatible adapter: [Providers](../20-using/30-providers.md#openaicompatible) |
| `presets` | The presets, frozen: [Presets](../20-using/30-providers.md#presets) |
| `readSource` | Read the diff, its source and the files it left out, from a diff, a range, the local changes or the files at a commit: [`readSource`](#readsource) |
| `outcome` | What a review comes to, its status and the exit code that says it: [`outcome`](#outcome) |
| `QuorumError`, `ConfigError`, `ProviderError`, `OutputError`, `GitError` | The error classes |
| `inertLine`, `inertJson` | Render a line for a terminal or a log, and a value as JSON, inert: [Output handling](../30-security/30-output-handling.md#printing-a-review-yourself) |
| `runQuorum` | Deprecated: [below](#runquorum) |

The types: `Confidence`, `CoverageEntry`, `CoverageReason`, `CoverageStatus`, `CredentialKind`, `Estimate`, `FailOn`, `Finding`, `Flag`, `FlagCode`, `IncompleteEntry`, `IncompleteReason`, `LeftOutFile`, `LeftOutReason`, `LeftRange`, `Lens`, `LensVote`, `ObjectFormat`, `Outcome`, `OutcomeStatus`, `Profile`, `ProfileEstimate`, `ProfileMeta`, `ProfileProviders`, `Prompts`, `ProviderRef`, `Quorum`, `QuorumEvent`, `QuorumMeta`, `QuorumOptions`, `QuorumResult`, `ReviewInput`, `ReviewSource`, `SecretRule`, `SkipRule`, `SourceRead`, `SourceSpec`, `StageName`, `Thresholds`, `Usage`, `Verdict`, `VerdictStatus`, `Vote`, `VoteFailure` and `VoteFailureKind`; `ChatMessage`, `CompletionRequest`, `CompletionResponse`, `EventSink`, `JsonSchema`, `ProfilePorts`, `Provider` and `QuorumPorts`; `ConfigIssue` and `ProviderErrorKind`; `PolicyRules` and `Rule`; `AnthropicOptions`, `Auth`, `ClaudeCodeAuth`, `ClaudeCodeOptions`, `GeminiOptions`, `HttpProviderOptions`, `OllamaOptions`, `OpenAICompatibleOptions`, `StructuredOutput` and `SystemPrompt`; `Preset`, `PresetName` and `Protocol`; `ConfigInput`, `QuorumConfig` and `QuorumConfigFile`; `Env`, `ProfileSelection`, `ResolvedConfig`, `ResolvedProfile` and `ResolvedProvider`. `HttpProviderOptions` holds the options an HTTP provider takes, `OpenAICompatibleOptions` adds `maxTokensField`, and `AnthropicOptions`, `GeminiOptions` and `OllamaOptions` are `HttpProviderOptions` as it is: [Providers](../20-using/30-providers.md#options). `ClaudeCodeOptions` holds the options of `claudeCode` and `ClaudeCodeAuth` its three auth modes. `Preset` types a row of `presets`, `PresetName` names one, and `Protocol` names the four wire protocols.

The stages and the profile checks are not exported: a program reaches the stages through `createQuorum`. The exit-code rule is `outcome`.

## `runQuorum`

```ts
declare function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult>
```

Deprecated: use `loadConfig` and `fromConfig`. `runQuorum` reviews `diff` as the CLI does with no flag: it calls `loadConfig()` and `fromConfig` on the result, so it reads the file `QUORUM_CONFIG` names, if any, which must be an absolute path, and the `QUORUM_*` variables of `process.env` with their `RESEARCH_*` and `VOTER_*` aliases, and it runs the profiles they select, the security profile alone by default: [Configuration](../20-using/20-configuration.md). It gives the review the config's `send`, so a file that list names is sent though held as a secret, and it takes no `send` of its own. `onProgress` receives the CLI's progress lines, the `left out:` and `flag:` lines included, each one inert and each profile's line starting with `[<id>] ` when several run, but neither the banner, nor a warning, nor `empty diff: nothing to review`, which the CLI writes itself. A configuration error, a missing model included, rejects with a `ConfigError`, for an empty diff too.

## A complete example

`review.mts`, in a project that has the package installed: the finder on a local model, the panel on a hosted one, a line on stderr per verdict and per gap and the result on stdout, both inert, a ten-minute limit, and the CLI's exit codes.

```ts
import { readFile } from 'node:fs/promises'
import { ConfigError, createQuorum, inertJson, inertLine, ollama, openaiCompatible, outcome, securityProfile } from '@tobi-or-not/quorum'
import type { QuorumEvent } from '@tobi-or-not/quorum'

const USAGE = 'Usage: node ./review.mts <diff-file>'

function progress(event: QuorumEvent): void {
  if (event.type === 'verdict') console.error(inertLine(`${event.findingId}: ${event.keptVotes}/${event.totalVotes} ${event.status}`))
  if (event.type === 'incomplete') console.error(inertLine(`incomplete: ${event.entry.reason} (${event.entry.detail})`))
}

/** The `Error:` line of a failure, inert: its message can hold text a server sent, and a value with no text form gets a fixed one. */
function errorLine(error: unknown): string {
  let message: string
  try {
    message = error instanceof Error
      ? error.message
      : String(error)
  } catch {
    message = 'an error with no text form'
  }
  return inertLine(`Error: ${message}`)
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
    const finder = ollama({
      id: 'local',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3.6:27b',
      contextTokens: 131072
    })
    const panel = openaiCompatible({
      id: 'hosted',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-6-astra',
      contextTokens: 400000,
      apiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
      temperature: null,
      maxTokensField: 'max_completion_tokens'
    })
    const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, panel]))
    const quorum = createQuorum({
      profiles: [securityProfile]
    }, {
      profiles: {
        security: { research: finder, voters }
      },
      events: progress
    })
    const result = await quorum.review({ diff }, {
      signal: AbortSignal.timeout(10 * 60_000)
    })
    console.log(inertJson(result))
    return outcome(result).exitCode
  } catch (error) {
    console.error(errorLine(error))
    return error instanceof ConfigError
      ? 2
      : 3
  }
}

process.exitCode = await main(process.argv[2])
```

```bash
OPENAI_API_KEY=sk-... node ./review.mts ./my.diff > result.json
```

It exits as the CLI does: `0`, `1` or `4` by [`outcome`](#outcome) of the result; `2` when no file is given, the file cannot be read, or a setting is invalid, such as a key with a space inside it once trimmed; and `3` when the review fails, its ten-minute limit included.

## Related

- [Providers](../20-using/30-providers.md) — the provider port, the shipped adapters and writing a provider.
- [Profiles](../20-using/40-profiles.md) — writing a profile, and running several in one review.
- [The JSON result](./20-json-result.md) — every field `review` resolves with.
- [Architecture](./40-architecture.md) — the modules behind this API, and the stages of a review.
