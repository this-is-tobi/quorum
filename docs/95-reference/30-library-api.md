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
  readonly review: (input: ReviewInput, options?: { readonly signal?: AbortSignal, readonly interrupt?: AbortSignal, readonly store?: ReplyStore, readonly maxReviewTokens?: number, readonly reviewTimeoutMs?: number, readonly findingsCap?: number }) => Promise<QuorumResult>
  readonly estimate: (input: { readonly diff: string, readonly send?: readonly string[], readonly context?: ReviewContext }, limits?: { readonly maxReviewTokens?: number, readonly reviewTimeoutMs?: number, readonly findingsCap?: number }) => Estimate
  readonly warnings: readonly string[]
  readonly budgets: Readonly<Record<string, ProfileBudgets>>
}

interface ReviewInput {
  readonly diff: string
  readonly source?: ReviewSource
  readonly leftOut?: readonly LeftOutFile[]
  readonly send?: readonly string[]
  readonly context?: ReviewContext
}
```

### Options and ports

| Field | Holds | Default |
| --- | --- | --- |
| `profiles` | The profiles to run: at least one, ids unique | Required |
| `concurrency` | The most provider calls in flight at once in one review, shared by every profile, with no lane and no adaptation; a positive integer. Unset, each provider has a lane of its own that follows its rate-limit headers, from `LANE_START` (4) calls at once, up to `REVIEW_CEILING` (16) calls in all: [Lanes](../20-using/30-providers.md#lanes) | Lanes |
| `maxFindings` | The most findings of a research reply each profile reads, the only ones that can reach its panel; a positive integer | `50` |
| `exclude` | Path patterns of the files left out of every request ([Excludes](../20-using/20-configuration.md#excludes)). Each file excluded reaches no model and is listed in `meta.leftOut` as `excluded`, never as a gap. At most 100 patterns, each at most 256 characters | None |
| `maxReviewTokens` | The most tokens, input and output, one review may spend: [The token cap](../20-using/20-configuration.md#the-token-cap). A whole number from 1 to 9007199254740991 | `2000000` |
| `reviewTimeoutMs` | The deadline of one review, in milliseconds, from 1000 to 86400000: [The review's deadline](../20-using/20-configuration.md#the-reviews-deadline) | `1800000` |
| `partTokens` | The most tokens of diff text one research part holds: [Research in parts](../20-using/20-configuration.md#research-in-parts). A whole number from 1024 to 9007199254740991 | `32768` |
| `ports.profiles` | One entry per profile, keyed by profile id: `research`, its research provider, and `voters`, one provider per lens keyed by lens id. A provider may state its `timeoutMs`, its `stallTimeoutMs`, its `retries`, its `worstCase`, its `room`, its `window`, its `maxTokens`, its `thinking`, its `adapts`, what quorum may change by itself in a review, its `streams`, `true` when it streams its replies, and its `slots`, how many calls its server serves at once, a whole number of at least 1, which its lane starts and stays at (the lesser of it and 16): [What a provider states](../20-using/30-providers.md#what-a-provider-states). A request carries `thinking` (`low` or `off`), `structuredOutput` (`prompt`) and `stream` (`false`, whole replies, or `'bare'`, a stream with no stream options) when quorum made that change, which an adapter honours only when it states the matching `adapts`, and `onProgress`, which hears each sign of life of a streamed reply as a `StreamSignal`: `{ kind: 'headers' }`, sent for a reply whose media type is the stream's alone, never for a whole reply, `{ kind: 'data', outputTokens, answer, reasoning }` or `{ kind: 'keep-alive' }`. A response carries `whole: true` when the server answered a streamed request whole: [Streaming](../20-using/30-providers.md#streaming). The changes: [What quorum adapts by itself](../20-using/20-configuration.md#what-quorum-adapts-by-itself). A shipped adapter takes the option `thinking`, `'low'` or `'off'`, sent as its protocol's own control and stated as its level: [Thinking](../20-using/30-providers.md#thinking) | Required |
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
| `ports.profiles.<id>.research.stallTimeoutMs`, `ports.profiles.<id>.voters.<lens>.stallTimeoutMs` | `must be a whole number of milliseconds from 1000 to 86400000` |
| `ports.profiles.<id>.research.retries`, `ports.profiles.<id>.voters.<lens>.retries` | `must be a whole number from 0 to 5` |
| `ports.profiles.<id>.research.window`, `ports.profiles.<id>.research.maxTokens` and the same under `voters.<lens>` | `must be a whole number of tokens of at least 1` |
| `ports.profiles.<id>.research.thinking`, `ports.profiles.<id>.voters.<lens>.thinking` | `must be default, low or off` |
| `ports.profiles.<id>.research.adapts`, `ports.profiles.<id>.voters.<lens>.adapts` | `must be an object whose thinking is low or off and whose prompt and stream are true, each optional` |
| `ports.profiles.<id>.research.worstCase`, `ports.profiles.<id>.voters.<lens>.worstCase` | `must be a function` |
| `ports.profiles.<id>.research.room`, `ports.profiles.<id>.voters.<lens>.room` | `must be a function` |
| `ports.events` | `must be a function` |
| `profiles.<id>` | `the research request on <provider> leaves <room> tokens for the diff, less than the 1024 a hunk may need: contextTokens <window> counts <fixed> for <parts>, <template> for the chat template and <reply> for the reply: <fix>` (for a room below 0, `leaves no tokens for the diff, its other tokens <n> over the window, where a hunk may need 1024`, `<n>` being the room's absolute value), and the same for `the vote request on <provider> for the longest finding`: a profile whose fixed text leaves a provider that states its `room` and its `window` no room for a diff, checked once the ports pass. `<parts>` is `the instructions` alone for a profile with no document, else the instructions and each document the request carries with its tokens (`the instructions (1685), the guidelines (16308) and the do-not-report text (5259)`), and `<fix>` names those documents, the largest first, before `lower maxTokens, or state a larger window` ([Room accounting](../20-using/20-configuration.md#room-accounting)) |

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

Each profile is compiled once, when the quorum is created: its vote template rendered for each lens, its thresholds resolved, and its providers captured beside the `{ id, model }` each had then, which is what events and `meta` report, with the `window`, `maxTokens` and `thinking` each stated, from which the profile's reply budgets are computed once ([Reply budgets](../20-using/20-configuration.md#reply-budgets)). A later change to a profile, to `exclude`, or to which provider a port names, is never seen by a review of that quorum. The provider objects themselves are called as they are.

### `budgets`

`Quorum.budgets` holds each profile's `ProfileBudgets` by profile id, frozen, at its providers' stated windows: the reply budget of its research and of each lens's vote (`replyTokens`), the `N` its research asks for (`findings`, and `findingsWithoutThinking`), the tokens of diff its research provider's stated room leaves a one-request research and a part (`rooms.one` and `rooms.part`), the room each voter leaves the vote of the longest finding (`room`), and `worstPart`, the tokens the review's token cap reserves for a part that holds as much diff as its room and `partTokens` allow, with how many of them `maxReviewTokens` holds: the worst case of a part that lists no file, so where `partTokens` bounds the diff the figure runs low and `holds` high, by the size of the file list a real part carries, and where the room bounds it both are exact. A provider that states no room has no `rooms`, `worstPart` or `room`. [`--print-config`](../20-using/10-cli.md#printing-the-resolved-config) prints them. A profile whose rooms fall below 1,024 tokens never gets this far: `createQuorum` throws it ([Room accounting](../20-using/20-configuration.md#room-accounting)). `fromConfig` keeps the field.

### `warnings`

The settings of the profiles that cannot take full effect, each starting at its profile id, such as a policy level that is never reached, the deprecated `gating`, or a `failOn` of `low` while the policy's `low` is off: [Warnings](../20-using/40-profiles.md#warnings). A quorum with warnings still runs.

## `review`

```ts
const result = await quorum.review({ diff, source, leftOut }, {
  signal: AbortSignal.timeout(10 * 60_000),
  store: await fileStore('/home/me/.quorum-state', { providers: config.providers })
})
```

- **`diff`** is the unified diff, as a string. A blank one runs no stage, calls no model and resolves with empty lists, the review still sending `run:start` and `run:end`. One whose every file `exclude` leaves out does the same, except that its `meta.leftOut` lists the files, a `left-out` event is sent, and the text before the first header, a mail's message say, is still researched.
- **`source`**, optional, is where the diff came from: it is checked and recorded in `meta.source` as given, with its known fields only, and `{ kind: 'diff' }` when it is unset. [The source](./20-json-result.md#the-source) lists its five kinds.
- **`leftOut`**, optional, lists the files a source left out before it made the diff. They come first in `meta.leftOut` and in the `left-out` event, before the diff's own, each file, reason and rule once, and a `binary`, `submodule` or `secret` one is a gap of every profile, as the diff's are. A `skipped` one, with its `rule`, and a `deleted-secret` one are no gap, and one of the rule `secret`, or of the reason `secret` or `deleted-secret`, raises a `secret-file` flag ahead of the diff's flags: [A file left out](./20-json-result.md#a-file-left-out).
- **`send`**, optional, names the files to send the models though they are held back as secrets: each is the path as the diff writes it, the one `meta.leftOut` lists, matched exactly, so `./.env` names no file `.env`. A file named here is not held, so it is neither listed nor flagged as a secret, and an `exclude` pattern still leaves it out first. The text no header names, which has the empty name, can never be named, and neither can a file by a changed spelling: such a file stays held, with its path in `meta.leftOut` to write. The array is copied before the review's first `await`. A program that reads a config's `send` passes it here itself, as it passes `exclude` to `readSource`, and as the CLI does with the config's `send` and `--send` merged.
- **`context`**, optional, is the review's repository documents, as the CLI's reader of the repository hands them over: each is sent with the profile it names, after that profile's own text and documents, cleaned and capped as every document is, and recorded in `meta.context`: [Documents](#documents). Each names the commit its text was read at, which the core checks against `source`: a range's base, a path review's commit, a local source's head. A `diff` source, and a local source before a first commit, names none and takes no document.
- **A file held back as a secret** is no part of any request: a file whose name is a secret's, or that holds a credential quorum recognizes, leaves the diff whole, is listed in `meta.leftOut` as `secret` with its `rule`, raises a `secret-file` flag and is a `secret` gap of every profile, which no flag lifts for a gating profile (`--fail-on none` makes a profile advisory, and its gaps then change no code). A change that deletes a file named as a secret whole lists it as `deleted-secret`, with its flag and no gap; a deletion of a file held for a credential in it, whose removed code would go unread, is a `secret` gap. A diff whose every file is held runs no stage and still records the gaps: [Files held back as secrets](../20-using/15-sources.md#files-held-back-as-secrets).
- **`signal`**, optional, stops the review: [Abort](#abort). Its meaning is unchanged.
- **`interrupt`**, optional, stops the review gently, and the review resolves with what it read: [Interrupt](#interrupt). `INTERRUPT_GRACE_MS`, exported, is the 5000 ms it gives the calls in flight.
- **`store`**, optional, is a [`ReplyStore`](#replystore): where the review keeps the calls it paid for and finds them again on a rerun, which reuses every call the store holds for a request sent as it was, and still pays the calls that failed, about the calls in flight more (`concurrency`, or up to 16 with lanes), and every call of a provider whose settings changed. Each research call whose reply passed its envelope check and each vote that parsed is put as it completes, and a research reply that was cut off or listed as many findings as it was asked for at most is put as a marker that sends its part straight to recovery; a failed call is never put. Each send is looked up under a key of the request as it is sent, never of its bytes, so a changed diff, prompt, budget, thinking level or mode is a miss. A stored reply is checked as a fresh one and reused only if it passes, and spends nothing: no reservation, no usage, a `call` event that says `reused`, and the count in `meta.reused`. A `get` or a `put` that throws, rejects or never settles in a review that is stopped is a miss or a write that did not happen, and a stored call that is no `StoredCall` is a miss: the review is as if it had no store. [`fileStore`](#filestore) is the CLI's own: [Saved state](../20-using/20-configuration.md#saved-state).
- **`findingsCap`**, optional, is the most findings of the research each profile sends to its panel in this review alone, in place of `maxFindings`: a positive integer, else a `ConfigError` before any event (`findingsCap: must be a positive integer`). Every research request is still sized by `maxFindings`, its reply budget and the findings it asks for, so a `findingsCap` above it changes no request, splits no reply and moves no store key; the findings past it are the `findings-capped` gap. The CLI gives a `--path` review whose config sets no `maxFindings` one finding per research part, at least 50: [The bounds of a path review](../20-using/15-sources.md#the-bounds-of-a-path-review). It is no option of `createQuorum`.
- **`maxReviewTokens`** and **`reviewTimeoutMs`**, optional, are the token cap and the deadline of this review alone, in place of the quorum's, and each is checked as the quorum's is: a whole number of tokens from 1 to 9007199254740991, and of milliseconds from 1000 to 86400000, else a `ConfigError` before any event. A caller that knows how large its input is gives its review the bounds that fit it, and the reviews that give none keep the quorum's. The CLI gives a `--path` review its estimate's worst case, never below 2000000, and 24 hours when the config sets none: [The bounds of a path review](../20-using/15-sources.md#the-bounds-of-a-path-review). The gaps read the limits the review kept to, and so do `run:stopping` and the summary's bounds.
- **A quorum reviews any number of diffs**, one per call. Each review has its own concurrency limit and its own signal, and several may run at once.

It resolves with the [result](./20-json-result.md), or rejects:

| With | When |
| --- | --- |
| A `ConfigError` | The input is malformed, before any event: `input: must be an object holding the diff string` when the input is not an object, such as the diff text passed on its own; `diff: must be a string`; `source: must be an object`, `source.kind: must be diff, range, local, staged or paths`, `source.objectFormat: must be sha1 or sha256`, `source.<field>: must be a full commit id of its object format: 40 lowercase hexadecimal characters for sha1, 64 for sha256` (and, for the `head` of a `local` or `staged` source, `, or null when nothing is committed`), `source.paths: must be an array of strings` or `source.skips: must be a boolean`; `leftOut: must be an array`, `leftOut.<index>: must be an object with a file and a reason`, `leftOut.<index>.file: must be a string`, `leftOut.<index>.reason: must be excluded, binary, submodule, skipped, secret or deleted-secret`, `leftOut.<index>.rule: must be vendored, lockfile, minified, test, secret, binary, submodule or lfs` (for a `skipped` file, which has one), `leftOut.<index>.rule: must be name, private-key, aws-key, github-token, slack-token, google-key, stripe-key, anthropic-key or openai-key` (for a `secret` or `deleted-secret` file, which has one) or `leftOut.<index>.rule: belongs to a skipped, secret or deleted-secret file only`; `send: must be an array` or `send.<index>: must name a file` (an entry that is not a non-empty string, a hole included); `context: must be an object holding documents`, and the messages of a context's documents, which [Documents](#documents) lists; `options: must be an object`; `signal: must be an AbortSignal`, `interrupt: must be an AbortSignal`, or `store: must be a reply store: an object with get and put functions` |
| The signal's reason | The signal aborted, before the review or while it ran |
| The sink's error | The event sink threw |
| A `ProviderDownError` | No research call of any profile answered, and a research provider was found down, or each of whose calls failed for a reason of its own, though fewer than three did: [`ProviderDownError`](#errors). It is the only error a model's failure rejects a review with |

A failed research part, its call or its reply, never rejects a review: it is its profile's `research-failed` gap, a gating profile's too. A failed vote never rejects a review either: it is recorded in its verdict. A provider that is down is called no more, and the research parts and votes it was never sent are `provider-down` gaps: the review rejects only when no part of any profile was read.

A finding's `line` is the line its finder cited, unless the harness moved the finding to the nearest occurrence of its quote in the cited file's section before the panel voted: `Finding.citedLine` then holds the cited line, and the key is absent, never `undefined`, for a finding that stayed where it was cited. `quoteMatched` is of the final line. [A verdict](./20-json-result.md#a-verdict) lists the fields, and [the quote check](../30-security/10-threat-model.md#code-derived-evidence-and-the-quote-check) says when a finding moves.

## Documents

A profile reads policy as documents: text a person wrote, which a model reads as the criteria to judge by (`guidelines`) or as what the finder is told not to report (`do-not-report`). The core cleans, caps, joins, sends and records them, and reads no file: a program, or the CLI's readers, hand it the text.

```ts
interface Profile {
  guidelines?: string
  doNotReport?: string
  documents?: readonly ReviewDocument[]
  // ...
}

interface ReviewDocument {
  readonly profile: string
  readonly kind: 'guidelines' | 'do-not-report'
  readonly origin: DocumentOrigin
  readonly text?: string
  readonly removed?: Removed
}

type DocumentOrigin
  = | { readonly kind: 'config', readonly sha256?: string }
    | { readonly kind: 'repository', readonly path: string, readonly commit: string, readonly sha256?: string }

interface ReviewContext {
  readonly documents?: readonly ReviewDocument[]
}
```

- **Where a profile's documents come from.** `Profile.guidelines` and `Profile.doNotReport` are its own text. `Profile.documents` holds documents of origin `config`, each naming the profile that holds it. `ReviewInput.context.documents` holds documents of origin `repository`, each naming a profile of the quorum and the commit its text was read at, and `Quorum.estimate` takes the same `context`. The texts of a kind are joined by a blank line in that order: the profile's own, its documents, then the review's. A blank one is recorded and sent as nothing, and a repository document with no `text` is an optional one that was not found; a config document with none is refused (`.text: must be a string: a config document is never missing`).
- **What the core does to each text**, whoever read it: it cleans it with [`cleanProse`](#cleanprose), adds what its pass removed to the `removed` its reader gave, and refuses it over its cap once cleaned. A profile's own `guidelines`, which 0.12.0 sent as given, are cleaned and capped too.
- **Where each kind goes.** The guidelines are a block of every request of the profile, the research call and every vote. The do-not-report text is a paragraph of the research system message, right after the instructions, and no vote carries it: [The layout of a request](../20-using/60-prompts.md#the-layout-of-a-request).
- **The caps**, in UTF-8 bytes of the cleaned text:

| What | Cap |
| --- | --- |
| A guidelines document, and a profile's guidelines in all | 16 KiB (16,384 bytes) |
| A do-not-report document, and a profile's do-not-report text in all | 8 KiB (8,192 bytes) |
| A document's text before it is cleaned, as a reader decodes it | 64 KiB (65,536 bytes) |
| The documents of one kind a profile holds | 16 |
| The documents of a review's context | 256 |

- **Nothing is cut.** A document over a cap, one the cleaner still changes after 16 passes, a review whose repository documents leave a research provider less than 1,024 tokens of diff ([Room accounting](../20-using/20-configuration.md#room-accounting)), and an input that is no context are refused as a `ConfigError` before any call, and no message holds a text, only counts and a path. The room check runs again on the run a review builds for a profile its context names a document of, since a repository document only adds to the profile's fixed text; a profile the context names none of keeps the run it was created with.
- **Every document is in the request's key.** The guidelines are a block of the request and the do-not-report text is in its instructions, so a rerun with a store after a document changed reuses no stored reply of a request that carries it.

What `createQuorum` and `review` refuse of documents, each message at its path:

| Path | Message |
| --- | --- |
| `<id>.guidelines`, `<id>.doNotReport` | `must be a string`, `holds <n> bytes once cleaned, over the 16 KiB a guidelines document may hold` (`8 KiB a do-not-report document`), or `nests HTML comments or character references too deep to clean in 16 passes: remove them` |
| `<id>.documents` | `must be an array of documents`, or `must hold at most 16 documents of one kind` |
| `<id>.documents.<index>` | `must be an object`; the cap and unsettled messages above; or `takes the profile's guidelines to <n> bytes once cleaned, over the 16 KiB they may hold in all` (`do-not-report text`, `8 KiB it may hold in all`), at the first document that takes the profile's texts of its kind over the cap, its own text counted first |
| `<id>.documents.<index>.profile`, `.kind`, `.origin`, `.origin.sha256`, `.text`, `.removed` | `must name the profile that holds it`; `must be guidelines or do-not-report`; `must be a config document: a { repository } document comes from the review's context`; `must be 64 lowercase hexadecimal digits`; `must be a string`, or `holds <n> bytes, over the 64 KiB quorum reads of a document`; `must hold counts of characters, comments and entities` |
| `context` | `must be an object holding documents` |
| `context.documents` | `must be an array of at most 256 documents` |
| `context.documents.<index>.profile` | `names no profile of the quorum` |
| `context.documents.<index>.origin` | `must be a repository document: a { file } document belongs in the profile's documents` |
| `context.documents.<index>.origin.commit` | `must be the commit the review's source reads documents from`, or, for an estimate, which names no source, `must be a full commit id: 40 or 64 lowercase hexadecimal digits` |
| `context.documents.<index>.origin.path` | `must be a path of at most 4096 characters` |
| `context.documents.<index>` | `needs a commit to read it from, which the review's source does not name` (a `diff` source, or local changes before a first commit); `"REVIEW.md" at 1f3a9c2 holds 17020 bytes once cleaned, over the 16 KiB a guidelines document may hold`, the path JSON-quoted and cut at 100 characters and the first 7 characters of the commit before the cap, unsettled and in-all messages above; or the shape messages of `.profile` to `.removed` above |
| `profiles.<id>` | The room message of [Input checks](#input-checks), for a review whose repository documents leave a provider no room |

A review records every document in [`meta.context`](./20-json-result.md#the-context) and sends one [`context` event](#events); neither holds a text. The types `ReviewDocument`, `ReviewContext`, `DocumentKind`, `DocumentOrigin`, `ContextDocument` and `ContextRecord` are exported.

## `readContext`

```ts
declare function readContext(config: ResolvedConfig, options: {
  readonly source: ReviewSource
  readonly cwd: string
  readonly env: Env
  readonly signal?: AbortSignal
}): Promise<ReviewContext>
```

`readContext` reads the documents a review takes from the repository, as the CLI does: the `{ repository }` entries of the profiles of a `ResolvedConfig`, which a profile holds as `ResolvedProfile.repository`, each read from the commit `options.source` names, never from the working tree or the change. `options.source` is the `source` of `readSource`'s answer. It gives the `context` of `review` and `estimate`, which `fromConfig` refuses an input without, as below.

```ts
import { fromConfig, loadConfig, readContext, readSource } from '@tobi-or-not/quorum'

const { config } = await loadConfig({ configPath: 'quorum.yaml' })
const quorum = await fromConfig(config)
const env = process.env
const input = await readSource({ kind: 'range', range: 'main...feature' }, {
  cwd: process.cwd(),
  env
})
const context = await readContext(config, {
  source: input.source,
  cwd: process.cwd(),
  env
})
const result = await quorum.review({ ...input, context })
```

- **The commit** is `documentCommit(source)`: a range's `base`, a path review's `commit`, the `head` of a local or staged source. A `diff` source names none and a local source before a first commit has none, so each entry is refused at its `repository` path, before any git runs: `"REVIEW.md" needs a commit to read it from, which a diff file or standard input does not name: review with --range, --local, --staged or --path, or name the file with { file }`, or `..., and the repository has none yet: make a first commit, or name the file with { file }`.
- **One listing and one read.** The profiles' entries are listed in one `git ls-tree` of that commit and their files read in one `git cat-file --batch`, every problem reported at once as one `ConfigError` with an issue for each refused entry: a path the commit lacks (unless `optional`), a link, a submodule, a file over 64 KiB, a text that is no UTF-8 or holds a NUL among its first 8000 bytes, one the cleaner cannot settle and one over a cap: [Rules and guidelines](../20-using/45-rules-and-guidelines.md#one-read-and-every-message) has each message. A git command that fails is a `GitError`.
- **A config with no entry** gives `{}` and runs no git. Otherwise each document is a `ReviewDocument` of origin `repository`, in the order of the entries, with the SHA-256 of its text as read and what the cleaner removed; an optional file the commit lacks is a document with no `text`. The package fills in the platform and takes no other git than the system's, as `readSource` does.
- **The completeness check.** A quorum `fromConfig` builds refuses a `review` or an `estimate` whose `context` holds no document for a `{ repository }` entry of its config, or holds one with no `text` for an entry that is not `optional` (only an optional entry may be missing), with its profile, kind and path, as a `ConfigError` before any call, one issue at each entry's `repository` path: `"REVIEW.md" was not read for this review: pass the context readContext reads to the estimate and the review`. So a program that forgets `readContext` never runs a profile without its policy. A quorum from `createQuorum` has no entries to check: its profiles hold no repository entry, since a `{ repository }` entry lives beside a `Profile` in `ResolvedProfile.repository`, so a profile a program hands `createQuorum` reads no repository document. Build such a quorum with `fromConfig`, or pass `readContext`'s documents in the review's context; its input is checked as [Documents](#documents) says.
- **`ResolvedProfile.repository`** lists a profile's entries, `guidelines` then `doNotReport`, each as a `RepositoryEntry`: its `kind`, `path`, `optional`, `at`, the config path of its `repository` field, and `index`, its place among its field's entries. The type `RepositoryEntry` is exported.

## Events

The sink receives every event of a review, synchronously and in order, as each thing happens:

| Event | Fields | Sent |
| --- | --- | --- |
| `run:start` | `profiles`, the ids in order; `providers`, who reviews for each profile: `research` and `lenses`, each a `{ id, model }` | First, when the review starts |
| `left-out` | `files`, as `meta.leftOut` holds them, the input's own first: [A file left out](./20-json-result.md#a-file-left-out) | Once, right after `run:start`, when the review leaves a file out |
| `context` | `context`, as `meta.context` holds it: `documents`, one record for each document the review sends as policy, by hash, path, commit and counts, never text: [The context](./20-json-result.md#the-context) | Once, right after `run:start` and the `left-out` event and before the gaps, when a profile has a document; none otherwise |
| `flag` | `flag`, as `meta.flags` holds it, the `secret-file` flags of the files left out first: [A flag](./20-json-result.md#a-flag) | Once per flag, after `run:start`, the `left-out` and `context` events and the gaps, before any stage |
| `stage:start` | `profile`; `stage`: `research`, `dedup` or `panel`; `parts`, for `research`, the plan's count of research parts, 1 for a change in one request; `votes`, for `panel`, the votes it will cast, its findings times the profile's lenses | When a stage of a profile starts |
| `stage:end` | `profile`, `stage`; `durationMs`, the stage's wall-clock time, waits for a concurrency slot included; `count`, the findings it produced, or the verdicts for `panel` | When that stage ends |
| `call` | `call`, the call's number, the one its `call:start` carried, absent for a call that sent none (one the store answered); `profile`; `role`: `research` or `vote`; `lens`, for a vote; `part`, for a research call, its position as `call:start` gives it; `finding`, for a vote, the finding's id; `listed`, for a research reply its check read, the findings it listed; `reasoning`, `true` or `false` when the provider could tell whether the reply showed reasoning; `firstTokenMs` and `longestSilenceMs`, on a call that answered after a streamed attempt that showed a data event: the time from that attempt's send to its first data event, the headers excluded, and its longest silence, the time between two signs of progress, its send and its end included, the headers one of them, in whole milliseconds on the review's clock; `ceilingMs`, on such a call whose answered attempt had its deadline grow while it streamed: the ceiling it reached, in milliseconds ([The deadline of an attempt](../20-using/30-providers.md#the-deadline-of-an-attempt)); `provider`, its `{ id, model }`; `durationMs`, from the call's first attempt to its end, inside its slot, the waits between attempts included; `ok`; `attempts`, the number of attempts, an adaptation's re-send counted as one of the call's, only when the call made more than one; `usage`, summed over its attempts, when the counts they reported are valid: a call that succeeded, or one that failed on a reply its provider read and refused, whose error carries them in an own `usage` property ([`ProviderError`](../20-using/30-providers.md#providererror)); `spent`, the tokens the review's cap counted for the call: each attempt's reported usage, nothing for one the server refused before any work, else its reservation ([The token cap](../20-using/20-configuration.md#the-token-cap)); `reused`, `true` only for a call the review's store answered with no attempt made, which holds no `usage` and no `attempts`, has a `spent` of 0 and reserved nothing | Once per provider call, failed ones included, sent after the check of its reply, which is why it holds `listed`; a research in parts makes one call per part, in order, and up to 15 for a part that recovery splits; none for a call that the cap, the deadline or the review's abort stopped before its first attempt |
| `call:start` | `call`, the call's number in the review, from 1, in the order calls start; `profile`; `role`; `lens`, for a vote; `provider`, its `{ id, model }`; `part`, for a research call, its position `{ index, count }` of its research parts, with `piece` `{ index, count }` when recovery split the part; `finding`, for a vote, the finding's id; `reserved`, the tokens its first attempt reserved in the review's ledger; `timeoutMs`, the ceiling of its first request's attempts: the provider's `timeoutMs`, else the one its reply budget sizes ([The deadline of an attempt](../20-using/30-providers.md#the-deadline-of-an-attempt)); `stream`, `true` when its first attempt is streamed, so it is watched for progress | Once per call, inside its slot, when its first attempt's token reservation is granted and before the attempt is sent. A call the store answered, the down rule refused or the token cap or the deadline stopped before its first attempt sends none. A call its provider's size guard refuses as too large sends one, the guard refusing inside the attempt. Every field is a number, an id or a code word |
| `call:retry` | `call`, the call's number; `attempt`, the number of the attempt that failed, from 1, within the send that was retried; `retries`, the retries the provider states; `failure`, what the failure said of itself, a `CallFailure`: `kind`, `status` for an `http` failure, `exhausted`, and `stalledMs` for a `timeout` that was a stream with no progress, the window it stalled at, and `ceilingMs` for a `timeout` at a ceiling that grew while its stream progressed, the ceiling it reached; or an `UnusableReply`, `{ kind: 'unusable-reply' }`, for a reply that came back and the stage could not read. A `kind` of `no-answer` (a reply of only reasoning), a vote's `truncated` and an `unusable-reply` are the call's one more send of a bad reply, as it is, once the adaptations had their try, within the provider's retries: no other retry has them; `attemptMs`, how long the failed attempt ran, from the moment its request was handed to the provider to its failure, on the review's clock, in whole milliseconds; `waitMs`, the wait before the next attempt, in milliseconds | Once before each wait between two attempts of a call, once the wait is known and the review's stop has not fired. A failure the stop ends instead of a retry sends none. Every field is a number or a code word |
| `call:progress` | `call`, the call's number; `outputTokens`, the output its streamed attempt has shown, the larger of the server's own count and a quarter of the characters streamed; `signal`: `tokens` when the output grew since the call's last `call:progress`, `keep-alive` when only keep-alives came | At most once a second per call, on the review's clock, from the signs of life of a streamed attempt: never for its headers alone, and never for a call that is not streamed. Every field is a number or a code word |
| `adapted` | `adaptation`, as `meta.adaptations` holds it: `provider`, `setting`, `from`, `to` and `cause`, a provider's id and code words: [The adaptations](./20-json-result.md#the-adaptations) | Once per provider and setting in a review, when a probe settles on a move: thinking lowered, a lowering the server refused (`lowering-refused`), the structured output moved to `prompt`, or the stream moved to `bare`, a stream with no stream options, or to `whole`, whole replies (`stream-refused`), and, with no probe, when a streamed call was answered whole (`stream-answered-whole`), or a derived reply budget was held to what a learned cut lets through (`replyTokens`, `cut-on-the-way`, sent after the `cut` event). Sent before the `call` event of the call that was the probe, and a probe that moved nothing sends none |
| `cut` | `provider`, the provider's id; `afterMs`, the length of its cut in milliseconds; `holds`, the tokens a reply may hold at the lowest rate the attempts cut at that length streamed, four fifths of what the cut lets through and at least 1024, absent when no rate was measured; `lowered`, whether a derived reply budget the provider serves was held to `holds` (never with `maxTokens` set, where `holds` is the value to lower it to); `fits`, `true` when `maxTokens` is unset and every derived budget it serves was already at or under `holds`, so nothing was lowered and there is no advice | Once per provider in a review, when two of its cut attempts ended at about the same length (the larger of 5 percent of the shorter and 5000 ms apart at most): each later call cut there is read as a reply cut off at its limit. A `lowered` cut is followed by an `adapted` event of `replyTokens`. An exhaustive `switch` over the event types needs this case: [A gateway that cuts long calls](../20-using/30-providers.md#a-gateway-that-cuts-long-calls) |
| `concurrency` | `provider`, its `{ id, model }`; `limit`, its lane's limit once the change is made; `cause`: `grown` (one more call, the headers holding it), `regrown` (back toward its start after a cut, with no header), `cut` (halved by a throttle signal, with `from`, the limit before it, and `failure`, the throttle as `call:retry` words it), `paused` (new calls held for a `Retry-After`, with `waitMs`, at most 60000, and `failure`), `paced` (a call waits `waitMs`, at most 60000, for the headers' reset) or `slots` (the lane holds the slots the provider states, `limit` the lesser of them and 16); `waitMs` and `failure` where the cause says | Once per change of a lane's limit, pause and pacing wait of a review with `concurrency` unset, and once per provider that states `slots`, when its lane begins: [Lanes](../20-using/30-providers.md#lanes). A pause and a pacing wait are sent once each time one is set or lengthened, not once per call that waits. With `concurrency` set none is sent |
| `stored-refused` | `provider`, the provider's id; `role`: `research` or `vote` | Once per provider and role in a review given a store, when a reply the store held failed the check a fresh reply passes, so it was not used and the call was made: whoever wrote the store wrote it. It holds no text, key or path: [Saved state](../20-using/20-configuration.md#saved-state) |
| `finding:invalid` | `profile`; `reason`, such as `src/auth.js:3 is not in the diff` | Once per finding dropped for citing code outside the diff |
| `provider-down` | `provider`, the id of the provider found down; `kind`, what its calls failed with, and for an `http` failure `status`; `calls`, how many failed in a row, 3, or 1 with `exhausted`; `noAnswer`, for a `no-answer` kind, what the last reply lacked, `thinking` or `empty`; `exhausted`, `true` only when the failure said the account's credit, quota or spend limit is used up; `cutAfterMs`, present only when every call of the streak was cut on the way (a `network` failure, or an HTTP 502, 504 or 524, whose last attempt ran at least 60 000 ms), the shortest of their attempts' lengths; `stalledMs`, present only when every call of the streak stalled, the shortest of their windows, which fixes with `raise stallTimeoutMs, or timeoutMs`; `refused`, `stream` only when the last failure was an HTTP 400 or 422 that named the stream or its options, which fixes with `stream: false` | Once per provider, when the third of its calls in a row ends with a failure of its own (`network`, `http`, `timeout`, `process`, `unsupported`, `invalid-response` or `no-answer`), or at its first call that failed with a used-up quota (`exhausted`, an `http` failure alone, never retried), whatever profile or role asked it: no call goes to it for the rest of the review, and the calls in flight run to their end. A reply that came back resets the count |
| `reply-lacked` | `provider`, the provider's id; `kind`: `truncated` or `no-answer`; `noAnswer`: `reply`, `thinking`, `window` or `empty`; `limit`, the reply limit the request was sent with, `outputTokens`, `inputTokens` and `window`, each when known | Once per provider and line in a review, the first time a call's final failure is a reply that lacked its answer in a way that needs a setting changed: a server that caps replies below `limit` (`truncated`, with `outputTokens` below `limit`), a window that ended a reply (`window`), a reply with only reasoning (`no-answer`, `thinking`), or with nothing (`no-answer`, `empty`). A cut-off at its limit sends none. Every field is a count or a code word the code read, never a word the error's message or the reply held: [What a reply lacked](../20-using/30-providers.md#what-a-reply-lacked) |
| `recovered` | `profile`; `part` and `parts`, the part's position, from 1, and 1 and 1 for a research of one request; `noAnswer`, what the first reply that was split lacked: `reply`, `thinking`, `window` or `saturated`; `limit`, the reply limit it was cut at, when the request carried one, `cutAfterMs`, in place of `limit`, the length in milliseconds a reply was cut on the way at, for a part split for a learned cut, and `findings`, the findings a saturated reply was asked for at most; `thinkingLowered`, whether the provider's thinking had been lowered when recovery began; `pieces`, how many final pieces the part ended with, each read or left at the floor, not every piece asked on the way, `read`, how many were read, and `unreadHunks` and `unreadFiles`, what the floor left unread, cut off even alone | Once per research part that recovery split, once its pieces have answered, and no event for a part that was cut off at the floor at once: [Recovering a cut-off part](../20-using/20-configuration.md#recovering-a-cut-off-part). Every field is a count or a code word |
| `part` | `profile`; `part`, `{ index, count }`, the part's position among its profile's research parts, 1 and 1 for a research of one request; `outcome`, what became of it: `reviewed` when every piece was read, else the first unread piece's in the diff's order (`request-too-large`, `token-cap`, `review-deadline`, `research-failed`, `provider-down` or `reply-cut-off`); `durationMs`, from the start of its first call to its end, 0 when it made none; `spent`, the tokens its calls counted; `reused`, `true` only for a part that made at least one call and whose every call the review's store answered, which spent 0 tokens (the CLI words it `reused from the saved state` in place of `answered in`); `listed`, the findings its read replies listed, absent when none was read; `failure`, for a failed part, what the first call that failed said of itself, as `call:retry` gives it, with `cutAfterMs` when its last attempt was cut on the way, the attempt's length in milliseconds, `stalledMs` when it was a stalled stream, the window in milliseconds, `ceilingMs` when it was a timeout at a grown ceiling, the ceiling in milliseconds, and `refused`, `stream`, when an HTTP 400 or 422 named the stream or its options; `pieces`, for a part recovery split, `{ count, read, unread }`, `unread` counting the unread pieces by outcome | Once per research part, as it ends, in the order parts end, after its `recovered` event when it has one, whatever became of it: a part a limit or the down rule settled with no call sends one with a `durationMs` of 0. A research that is one request, a blank part of a packing of one included, is part 1 of 1. Every field is a count, a duration or a code word |
| `incomplete` | `entry`, as `meta.incomplete` will hold it | Once per gap, as it is recorded: the gaps of the binary, submodule and held files left out first, in that order, then the profile's `too-large` gap, right after `run:start`, the `left-out` and `context` events and before any call; the gaps of a research in parts once every part has answered, after the `finding:invalid` events; a limit's gap last for its profile, after the `stage:end` of its `panel` |
| `vote` | `profile`, `findingId`, `lens`; `keep`: `true`, `false`, or `null` when the vote failed; `error`, then `failure`, for a failed vote: its `kind`, for an `http` failure its `status`, and for a `truncated` or `no-answer` failure its `noAnswer` when it said what the reply lacked, as the result's vote holds them (`VoteFailure`, [A vote](./20-json-result.md#a-vote)) | Once per vote |
| `verdict` | `profile`, `findingId`, `keptVotes`, `totalVotes`; `confidence`, when it reached one; `status`: `kept`, `discarded` or `unreviewed` | Once per finding, when all its votes are in |
| `run:stopping` | `cause`: `review-deadline` or `interrupt`; `inFlight`, the attempts sent and not settled; `graceMs`, for the interrupt, the time they have to end | Once, when the review's deadline falls or its `interrupt` aborts while its stages run, before the calls it stops end. At the deadline no call in flight is waited for and no new call starts, and what is left undone is a `review-deadline` gap. At the interrupt no new call starts and every wait ends, the calls in flight have `graceMs` (`INTERRUPT_GRACE_MS`, 5000) to end, and what is left undone is an `interrupted` gap. None for a review that ends before either |
| `run:end` | `kept`, `discarded`, `unreviewed` and `incomplete`, the counts; `durationMs` | Last, when the review ends |

The first events of the review on [The JSON result](./20-json-result.md#an-example), as the sink received them:

```text
{"type":"run:start","profiles":["security"],"providers":{"security":{"research":{"id":"default","model":"qwen3.6:27b"},"lenses":{"reachability":{"id":"default","model":"qwen3.6:27b"},"impact":{"id":"default","model":"qwen3.6:27b"},"defenses":{"id":"default","model":"qwen3.6:27b"}}}}}
{"type":"stage:start","profile":"security","stage":"research","parts":1}
{"type":"call:start","call":1,"profile":"security","role":"research","provider":{"id":"default","model":"qwen3.6:27b"},"part":{"index":1,"count":1},"reserved":12000,"timeoutMs":600000,"stream":true}
{"type":"call","call":1,"profile":"security","role":"research","provider":{"id":"default","model":"qwen3.6:27b"},"part":{"index":1,"count":1},"durationMs":0,"ok":true,"usage":{"inputTokens":1840,"outputTokens":412},"spent":2252,"listed":5,"firstTokenMs":0,"longestSilenceMs":0}
{"type":"part","profile":"security","part":{"index":1,"count":1},"outcome":"reviewed","durationMs":0,"spent":2252,"listed":5}
{"type":"finding:invalid","profile":"security","reason":"src/auth.js:3 is not in the diff"}
{"type":"incomplete","entry":{"profile":"security","reason":"finding-unreadable","detail":"findings[4]: quote: Invalid input: expected string, received undefined"}}
{"type":"stage:end","profile":"security","stage":"research","durationMs":8,"count":3}
```

- **A sink ignores an event type it does not know.** The events grow: a release adds an event type, as one added `concurrency`, and a sink that switches over `type` ends on a `default` that does nothing. A `switch` that must name every type no longer compiles when a release adds one, which is why a type added is a breaking change while quorum is v0.
- **The sink runs inside the review.** Each event is delivered before the review goes on, so a slow sink slows the review.
- **Events carry no model text beyond `error` strings**, the file name a `finding:invalid` reason quotes, which is the finder's, cleaned and capped at 80 characters, and, for a diff without per-file headers, the `file` and `detail` of a `vote-failed` entry or of a vote's `request-too-large` entry, which hold the finder's name for the file, cleaned and capped at 260. The `file` of a `flag` event is the diff's own path, and absent for a diff without per-file headers. The `file` of a `left-out` event's files is the diff's own path, or `""`, and for a file the input's `leftOut` lists, the name the caller gave.
- **The sink gets a copy of each event.** Changing one changes neither the review nor its result.
- **`meta` agrees with the events.** `meta.usage` and each `invalidFindings` are counted from them, `meta.context` is the record the `context` event holds, `meta.reused` counts the `call` events that say `reused` by role, and `meta.adaptations` holds the `adaptation` of each `adapted` event, in order, `meta.profiles.<id>.recovery` counts the `recovered` events of the profile, and `meta.concurrency` records, per provider, the range of the limits the `concurrency` events gave its lane and how many were cuts.
- **A sink that throws aborts the review** with its error, so the bug surfaces instead of being swallowed: no profile starts another call, no further event is delivered, and the review rejects with that error, even when it threw on `run:end`.

### `ReplyStore`

```ts
type StoredCall
  = | { readonly reply: { readonly text: string, readonly model: string, readonly usage?: Usage } }
    | { readonly lacked: { readonly noAnswer: 'reply' | 'thinking' | 'window' | 'saturated', readonly usage?: Usage } }

interface ReplyStore {
  readonly get: (entry: { readonly key: string, readonly provider: string }) => Promise<StoredCall | undefined>
  readonly put: (entry: { readonly key: string, readonly provider: string }, call: StoredCall) => Promise<void>
}
```

The port a review keeps its paid calls through. `key` is the core's, a SHA-256 of the call's role, the request's content, its reply budget and the thinking level and mode it is sent with, and `provider` is the id of the provider it went to: a store that serves several providers or versions adds what tells them apart to its own key, as `fileStore` does. A `reply` is one call that passed its check, and a `lacked` marker is a research reply that was cut off (`reply`, `thinking` or `window`) or saturated, with its usage and never any text: it can only send a part to recovery. Whatever a store gives back is as untrusted as a reply: the review reads it as own data, checks a reply as a fresh one, and takes a `get` or a `put` that throws or rejects, or a call that is no `StoredCall`, for a miss or a write that did not happen.

### `fileStore`

```ts
declare function fileStore(directory: string, options: { readonly providers: ResolvedConfig['providers'] }): Promise<ReplyStore>
```

The store the CLI's `--state <dir>` opens, one file per call in `directory`. `providers` are the config's: the settings of each, every field but its key, `timeoutMs`, `stallTimeoutMs`, `retries`, `stream`, `streams` and `slots`, are part of an entry's key, so a changed provider is a miss (a raised deadline, a stall window, a retry count, a stream setting or a lane's slots is not: each decides whether a reply arrives, never what it says), and a provider the config does not name keeps nothing. The platform, the user that owns the process, quorum's version and the process's standard error, where each warning is one inert line, are filled in from `process`. It makes the directory with mode `0700` when it is missing, and rejects with a `ConfigError` at `--state`, naming the flag and never the path, for a directory that is a symbolic link or no directory, that another user owns or that its group or others may write, that lies inside a git work tree, or that holds files but no marker quorum wrote. Whoever can write the directory can write a part's review, so keep it where only you can, never restore it from a cache another job can write, and remove it once the review it serves is done: [Saved state](../20-using/20-configuration.md#saved-state).

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
- **A failed research part stops no profile.** It is its profile's `research-failed` gap, a gating profile's too, and the other parts and profiles go on. A review that rejects with a `ProviderDownError` does so once every profile's research has ended, so no event arrives after the rejection, and no call is in flight.
- **An abort after `run:end` has no effect**: the review is over, and resolves with its result.
- **The review's deadline is no abort**: at `reviewTimeoutMs` the review resolves, its calls and waits stopped and recorded as `review-deadline` gaps, while an abort rejects. An abort that comes after the deadline still rejects, with its own reason: [The review's deadline](../20-using/20-configuration.md#the-reviews-deadline).
- **The review never waits for a call it stopped.** Each attempt has a signal of its own, aborted with the review's or at its deadline, and the review settles the attempt at once; the shipped adapters stop their request or process on it, and a provider that ignores it works on, outside the review.

## Interrupt

```ts
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
const result = await quorum.review({ diff }, { interrupt: controller.signal })
// result.meta.incomplete holds the interrupted gaps; outcome(result) is { status: 'interrupted', exitCode: 130, lifted: false }
```

`interrupt` is what the CLI's first Ctrl-C or SIGTERM is. An abort rejects at once. An interrupt rejects as any review does, on an abort, on a sink's error, or with `ProviderDownError` when nothing was read and a provider was found down, and otherwise resolves, and never fails open:

- **No new call starts and every wait ends at once**, when it aborts or at once when it was aborted already: a call queued behind a call in flight, waiting for room under the token cap or backing off after a failure ends where it is, sending nothing. One `run:stopping` event, with `cause` `interrupt`, says how many calls are in flight and the grace.
- **The calls in flight have `INTERRUPT_GRACE_MS`, 5000 ms on the review's clock, to end.** A reply that comes within it is read, checked and put in the `store` as in any review, and the review asks no vote on what it reads. A call still in flight at the end is cancelled, its attempt's signal aborted.
- **It resolves with what it read.** What it stopped, the research parts not read and the votes not asked, is an `interrupted` gap of each profile, `interrupted` in the files' coverage, and a failed vote of kind `interrupted` on each finding left `unreviewed`. No option lifts it.
- **An abort still rejects.** `signal` aborting during the grace, or before the interrupt, rejects with its reason; so does an interrupt that is not an `AbortSignal`, with a `ConfigError` (`interrupt: must be an AbortSignal`).
- **The timer and the listener go however the review ends.** None is left armed when it resolves or rejects.

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
  maxFindings: number
  findingsCap: number
  maxReviewTokens: number
  reviewTimeoutMs: number
  fits: boolean
  held: number
}

interface ProfileEstimate {
  parts: number[]
  votes: number
  vote: Record<string, number>
  expected: number
  worst: number
  findings: number
  provider: string
  documents: { research: number, vote: number }
}
```

`estimate` says what a review of the diff may cost, in tokens, before any call. Its input takes the review's `context` too, the repository documents of [Documents](#documents): each is counted in the reservation of every part and the bound of every vote of the profile it names, as `review` sends it, and refused as `review` refuses it, a document that leaves a provider no room included, but its commit is not checked, since an estimate names no source. Its second argument, `limits`, is the cap, the deadline and the findings cap the estimate is made under, in place of the quorum's, as `review`'s `maxReviewTokens`, `reviewTimeoutMs` and `findingsCap` are, and checked the same way: the estimate's `maxReviewTokens`, `reviewTimeoutMs`, `fits` and `held` read the first two, and `findingsCap` counts each lens's votes, so it moves `findingsCap`, each profile's `votes` and `worst`, `inFlight` and what `fits` and `held` read of it, and no part, request or `expected` figure, as `maxFindings` sizes them. The worst case is the same whatever the token cap, which is why a caller may make one estimate for its worst case and another under the cap it derives from it. It sends nothing and reads no file: it filters the diff and plans each profile's research as `review` does, then asks each provider for the `worstCase` and the `room` it states, on the requests the review would build. Every figure is what the review's token ledger reserves for a call, not what the call spends. The input is `{ diff, send, context }`, `send` and `context` optional as `review`'s are: the estimate reads the diff less its held files, so a file held back as a secret costs nothing and one `send` names is counted, and it counts the repository documents of `context`, with no commit to check them against. It throws a `ConfigError` for an input `review` would refuse, such as a `diff` that is not a string.

| Field | Holds |
| --- | --- |
| `profiles` | One entry per profile, keyed by its id, in the run's order |
| `profiles.<id>.parts` | What the ledger reserves for each research request of the profile, in order: one for a diff researched whole, else one per part that holds more than white space, as [Research in parts](../20-using/20-configuration.md#research-in-parts) packs them. Empty when research makes no call |
| `profiles.<id>.votes` | The most votes the panel casts: `findingsCap` times the profile's lenses. 0 when research makes no call |
| `profiles.<id>.vote` | What the ledger reserves at most for one vote of each lens, keyed by lens id: the request for a finding at the longest the harness lets one be, citing the largest section of the diff. For a lens whose voter states a room that section exceeds, it is the partial request, filled to that room. Empty when research makes no call |
| `profiles.<id>.expected` | The research parts alone, each counted at a third of its input, rounded up (the bound is one token per byte, and code takes about one per three), and its reply at the lesser of its budget and 4096 tokens, its usual size, so a large `maxTokens` is headroom and no expectation. No recovery and no vote is in it, since how many findings research reports is not known before it runs |
| `profiles.<id>.worst` | An upper bound: the parts in full, each with what recovery may add to it (`3d + 14h + 14 (r - d + e)` for a part of `d` diff tokens, reservation `r`, largest file header `h` and `e` the tokens a piece's request holds beyond its part's: [Recovering a cut-off part](../20-using/20-configuration.md#recovering-a-cut-off-part)), and `findingsCap` votes of every lens at its bound |
| `profiles.<id>.findings` | The findings its research requests ask for at most, `N`: `maxFindings`, or fewer when the research provider's reply budget holds fewer ([Reply budgets](../20-using/20-configuration.md#reply-budgets)). Below `maxFindings`, a part whose reply lists that many is split, which `expected` counts no call for |
| `profiles.<id>.provider` | The id of the profile's research provider |
| `profiles.<id>.documents` | What the profile's documents add to what the ledger reserves for one research request (`research`: its guidelines and its do-not-report text) and for one vote (`vote`: its guidelines, at the lens that adds most), each the difference of the request built over no diff with them and without them, a review's repository documents included. 0 and 0 for a profile with none, and for one whose research makes no call. It is not in `expected`, `worst` or `inFlight`, which already count the documents in each request: it says what share of each request they are |
| `expected` | The sum over the profiles |
| `worst` | The sum over the profiles, each call once more of a provider that states a retry, whatever its thinking (its research parts, each with recovery's bound, and `findingsCap` votes of each of its lenses at their bound: a bad reply is sent once more, [What is retried](../20-using/30-providers.md#what-is-retried)), and the calls an adaptation sends once more: for each provider and each setting its `adapts` states, a `stream` counting as two, one per step, per setting at most `concurrency` calls (16 with lanes), counted as the `concurrency` (else 16) largest reservations of its calls, a research part's with what a piece's position adds. A provider that states no `adapts` adds none ([What quorum adapts by itself](../20-using/20-configuration.md#what-quorum-adapts-by-itself)) |
| `inFlight` | What the calls that run at once reserve: the sum of the `concurrency` largest bounds among every research part and every vote of every profile, a lens's bound counted `findingsCap` times. With `concurrency` unset, each provider counts the largest bounds among its own calls, as many as its lane starts with (4, or its `slots`), and the 16 largest of those count in all |
| `maxFindings`, `findingsCap`, `maxReviewTokens`, `reviewTimeoutMs` | The limits the estimate was made under: `limits`' when given, else the quorum's, as `createQuorum` took them: `findingsCap` is `maxFindings` unless `limits` give one |
| `fits` | `expected + inFlight <= maxReviewTokens`: whether the research may finish under the cap. It leaves recovery and the adaptations out, which only a failing or an adversarial review reaches and which would refuse every large path review: `worst` counts them |
| `held` | How many research parts the cap holds: the parts of every profile, in profile order and then in the order they are sent, counted while their expected spends and `inFlight` stay within `maxReviewTokens`. 0 for a cap below `inFlight`, every part when `fits`. The CLI's warning for a cap the config sets below the estimate names it |

A blank diff, and one whose every file `exclude` leaves out or is held back as a secret, make no call: every token figure is 0, `parts` and `vote` are empty and `fits` is true, with `findings` and `provider` as the profile's research provider states them. The CLI prints the estimate of a path review, derives the review's token cap and deadline from it and never refuses one for its size: [The bounds of a path review](../20-using/15-sources.md#the-bounds-of-a-path-review). A blank diff has `held` 0. It is an estimate, not a limit: each call of a review still reserves its worst case against `maxReviewTokens`, whatever `fits` says, so a review that does not fit stops at the cap with a `token-cap` gap, and one that fits may stop there too, since the votes are in `worst` alone.

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
| `paths` | The files under each path at a commit, each written as a new file | `paths`, relative to `cwd` as `--path` is; `at`, the commit, `HEAD` when unset; `skips`, whether the default skips (vendored, lockfile, minified, binary and test files) apply, true when unset: a secret is skipped whatever it says |

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
// The cap follows the estimate's worst case, never below the default, as the CLI's does for a path review.
const { worst } = quorum.estimate(input)
const limits = {
  maxReviewTokens: Math.max(worst, 2_000_000),
  reviewTimeoutMs: 86_400_000
}
const result = await quorum.review(input, limits)
```

## `outcome`

```ts
declare function outcome(result: QuorumResult | PublicView, options?: { readonly allowIncomplete?: boolean }): Outcome

type OutcomeStatus = 'pass' | 'findings' | 'incomplete' | 'interrupted'

interface Outcome {
  readonly status: OutcomeStatus
  readonly exitCode: 0 | 1 | 4 | 130
  readonly lifted: boolean
}
```

`outcome` says what a review comes to: the rule that decides the CLI's exit code, for a program that reads a result. `status` is `pass`, `findings`, `incomplete` or `interrupted`, `exitCode` is the code that says it, and `lifted` is `true` when `allowIncomplete` turned an incomplete review into a pass, so a report never calls that run complete. It reads the result, or its [public view](#publicview), as the result it came from, and calls nothing. What decides each, in this order:

- **`130`, `interrupted`.** An entry of `meta.incomplete` is an `interrupted` gap, of any profile, an advisory one's included. It wins over everything else, and `allowIncomplete` never lifts it.
- **`1`, `findings`.** A kept finding is at or above the level of its profile, `meta.profiles.<id>.failOn`: `high` fails a `high` finding, `medium` a `high` or `medium` one, `low` any, and `none` none ([Gating](../20-using/40-profiles.md#gating)). It wins over `4`, whatever else is missing.
- **`4`, `incomplete`.** An unreviewed finding, or an entry of `meta.incomplete`, belongs to a gating profile: one whose level is not `none`. The gaps and findings of a profile at `none` change nothing.
- **`0`, `pass`.** Neither of the two.

A result of an earlier release has no `failOn`, and `outcome` reads its `gating`: `false` is `none`, anything else `high`, and a `failOn` that is a level wins. A `failOn` that is no level, or that the entry only inherits, is unreadable, so `outcome` reads the `gating` beside it the same way: `gating: false` gives `none`. A profile with no readable field at all, one missing from `meta.profiles` or an entry that is `null`, gates at `high`, so a gap in a result never hides a finding.

`allowIncomplete` lifts what the CLI's `--allow-incomplete` lifts, and nothing else: the `4` becomes `0`, `lifted` is `true`, only when every gap of a gating profile is a `vote-failed` one and every failed vote behind the gaps failed in passing, never when a `1` is due: [Exit codes](../20-using/10-cli.md#exit-codes). A `secret` gap, a `too-large` gap and every other reason stay `4`, since a pull request can cause them. A public view has no vote's `vote`, so `outcome` reads a vote of a view by its `keep`: cast when it is a boolean and the vote's `failure` is `null` or absent, failed otherwise. A job that holds only the view, such as the post job of a review run with `--view public`, concludes what the review job's `--allow-incomplete` did.

```ts
import { outcome } from '@tobi-or-not/quorum'

// `result` comes from `quorum.review`, as in the complete example below.
const { status, exitCode, lifted } = outcome(result, { allowIncomplete: true })
```

## `renderReport`

```ts
declare function renderReport(input: ReportInput, options: ReportOptions): string

type ReportInput = QuorumResult | PublicView
type ReportFormat = 'text' | 'json' | 'brief' | 'markdown' | 'payload' | 'sarif'

interface ReportOptions {
  readonly format: ReportFormat
  readonly color?: boolean
  readonly outcome?: Outcome
}
```

`renderReport` writes a review's result, or its [public view](#publicview), as the report the CLI writes on stdout, a text that ends in a line feed: [The report](../20-using/10-cli.md#the-report). It reads the input, as `review` returns it, and the options, and nothing else: no terminal, no environment, no file. It hands the input to the format as it is, so `json` of a view is the view, and `text` and `brief` of a view are the report of the result it came from, but for the two lines of `text` that the view has no detail or usage for: a gap is written in the fixed words of its reason, and the time has no token count.

- **`format`** is `text`, the report for a person, `json`, the result as `inertJson` writes it, `brief`, one line of counts and code words that holds no file name and no model text, or `markdown`, the summary a pull request or a job summary shows, or `payload`, the document `quorum-action` posts, as `inertJson` writes it: a JSON object with `version`, `head`, `conclusion`, `summary`, `comments` and `unplaced`, typed `ActionPayload`, whose comments are `ActionComment`s: [The Action's payload](./50-action-payload.md), or `sarif`, SARIF 2.1.0 for GitHub's code scanning as `inertJson` writes it: one run, a result for each kept or unreviewed finding on a file of the diff and a notification for each gap, whose levels agree with the exit code. `markdown`, `payload` and `sarif` render the public view of what they are given, so they hold no reasoning, no discarded finding, no model and no usage whatever the input is: [Reports for GitHub](../20-using/80-reports.md). Any other value throws a `ConfigError` at `format`: `format: must be text, json, brief, markdown, payload or sarif`. `text` has the findings with their evidence, each profile's counts and coverage, what was left out, the gaps, the flags, the time and the tokens, and last the verdict, as [The text report](../20-using/10-cli.md#the-text-report) shows: every line is `inertLine` of its text, 80 columns wide but for a path, a category or a row of code.
- **`color`** is `false` unless it is `true`. `text` is the one format that colors: with `true` it wraps the level, the location, the cited row's marker, a row's `+` or `-` and the verdict's status word in SGR sequences, never a word a model or the diff wrote, and a line whose text `inertLine` changes beyond its hidden characters is written uncolored. `json`, `brief`, `markdown`, `payload` and `sarif` never color. The CLI colors on a terminal unless `NO_COLOR` is set, which `renderReport` does not read: it reads no environment, so the choice is yours.
- **`outcome`** is what the report says the review came to, which `text` states as its last line, `brief` as its status and its exit code, `markdown` as its verdict and `payload` as its `conclusion`; `sarif` states no outcome, since its levels and its `executionSuccessful` come from the result, by the rules the exit code is made of. Pass the one your program exits with: when it is absent, `renderReport` computes `outcome(result)`, which lifts nothing. A program that calls `outcome(result, { allowIncomplete: true })` for its exit code passes that, so the report and the code say the same.

```ts
import { outcome, renderReport } from '@tobi-or-not/quorum'

// `result` comes from `quorum.review`, as in the complete example below.
const done = outcome(result, { allowIncomplete: true })
process.stdout.write(renderReport(result, { format: 'brief', outcome: done }))
process.exitCode = done.exitCode
```

Every part of the report that holds text from a model or from the diff passes `inertLine` or `inertJson`, so a program can print it as it is: [Printing a review yourself](../30-security/30-output-handling.md#printing-a-review-yourself).

## `publicView`

```ts
declare function publicView(input: QuorumResult | PublicView): PublicView
```

`publicView` makes the result less what helps an attacker, for a sink a stranger can read: a pull request comment, the job summary, an artifact, a CI log. It withholds each vote's `reasoning` and `error`, the discarded findings, which it counts in `meta.profiles.<id>.discarded`, the providers and models, `meta.usage` and each gap's `detail`, and keeps every other field, a held file's name, reason and rule and the flags with their details included. `meta.view` is `"public"`. Each field and why it goes: [The public view](../30-security/30-output-handling.md#the-public-view); the shape: [The JSON result](./20-json-result.md#the-public-view).

- **The types** are `PublicView`, `PublicVerdict`, `PublicVote`, `PublicMeta`, `PublicProfileMeta` and `PublicGap`. A `PublicVerdict` is a `Verdict` whose `votes` are `PublicVote`s, `{ angle, keep, failure }`, and `PublicView['discarded']` is `[]`.
- **It is pure and idempotent.** The view holds new arrays and objects and never a part of the result, the result is never changed, and `publicView(view)` is `view`.
- **It checks every view it returns,** the one it makes and the one it is given, against the strict schema [`readResult`](#readresult) reads a public view by. A view that fails it throws a `TypeError`: `the public view is not one quorum writes, at <path>`, the path of the first issue written as `readResult`'s is, and never a value. So a forged `meta.view` that keeps a vote's `reasoning`, a profile id or a fingerprint that holds Markdown, and a reason, a rule or a flag's code outside its closed list, are refused before a reporter writes them bare. A file is refused earlier, by `readResult`.
- **`renderReport` and `outcome` take either**, the result or its view, and the exit code and the conclusion are the same for both.

```ts
import { outcome, publicView, renderReport } from '@tobi-or-not/quorum'

// `result` comes from `quorum.review`, as in the complete example below.
const view = publicView(result)
const done = outcome(view, { allowIncomplete: true })
process.stdout.write(renderReport(view, { format: 'json', outcome: done }))
```

## `readResult`

```ts
declare function readResult(text: string): QuorumResult | PublicView
```

`readResult` reads a result a review saved, or its [public view](#publicview), back from its JSON text. It is the reader behind `quorum report` and takes text, since only the program reads a file: [quorum report](../20-using/10-cli.md#quorum-report). The text is untrusted, so it is checked in this order, and the first check that fails throws a `ConfigError` with one issue at the empty path, a message of quorum's own words that holds no value and no part of the text, and no key but a code word:

| Check | Message |
| --- | --- |
| The size, in bytes of UTF-8, at most 256 MiB | `the result is over 256 MiB, the most quorum reads` |
| `JSON.parse` | `the result is not JSON` |
| `meta.version`, as own data, equals the `version` of this release | `the result was written by another release of quorum: render it with the release that wrote it` |
| The strict schema: the public view's when `meta.view` is `public`, the result's otherwise | `the result is not one quorum writes, at <path>`, or without the path when the first issue has none |

- **The cap** holds every result a review of the largest diff quorum reads can write, and stays under the longest string the engine makes.
- **The same release only.** A result of another release is refused before its shape is read, since a release mismatch is the likeliest mistake of two jobs, and the schema is the release's own: render a result with the release that wrote it.
- **The schema is strict at every level.** An unknown key anywhere is refused, and so is a value outside a closed list, a profile id that matches no `^[a-z][a-z0-9_-]*$`, a verdict or a gap of a profile the result does not hold, a fingerprint or a finding id of the wrong form, a text over its cap, a kept finding with no confidence and a discarded or an unreviewed one with one. A public view is refused when it still holds a vote's `reasoning` or `error`, a `usage`, a profile's `providers`, a gap's `detail`, or a discarded finding. The path of an issue names a key that is no code word as `*`, as a config error does.
- **It runs nothing and reads nothing** but its text. What it returns is data a reporter may render: `renderReport` and `outcome` take it as they take a review's result.

```ts
import { readFile } from 'node:fs/promises'
import { readResult, renderReport } from '@tobi-or-not/quorum'

const result = readResult(await readFile('result.json', 'utf8'))
process.stdout.write(renderReport(result, { format: 'markdown' }))
```

## `cleanProse`

```ts
declare function cleanProse(text: string): CleanedProse

interface CleanedProse {
  readonly text: string
  readonly removed: Removed
  readonly settled: boolean
}

interface Removed {
  readonly characters: number
  readonly comments: number
  readonly entities: number
}
```

`cleanProse` removes from prose a model reads as policy, a guideline or a rules file, three kinds of text a renderer does not show: the HTML comments, the numeric character references and the hidden characters but the line feed and the tab, in passes until one removes nothing, at most 16. Other Markdown a renderer hides, a link reference definition such as `[//]: # (...)`, passes untouched, and the hidden characters include joiners and variation selectors a reader sees (ZWJ, ZWNJ, U+FE0F). It makes the text well formed and every line end a line feed first. What it removes, in what order and why one pass is not enough: [Prose a review reads as policy](../30-security/30-output-handling.md#prose-a-review-reads-as-policy).

- **`text`** is the cleaned text, and `removed` counts the hidden characters (by code point), the comments and the references removed. A line end it rewrites and a lone surrogate it replaces count nothing.
- **`settled`** is `false` when the text was still changing in the 16th pass, which nesting deeper than 15 levels causes. Refuse such a text, and never send it: `text` is what the passes left of it.
- **It is pure.** It reads no profile, file or setting, and it cleans prose, never code: the diff and the evidence do not pass through it.

```ts
import { readFile } from 'node:fs/promises'
import { cleanProse } from '@tobi-or-not/quorum'

const { text, removed, settled } = cleanProse(await readFile('guidelines.md', 'utf8'))
if (!settled) throw new Error('guidelines.md nests comments or references too deep to clean: remove them')
console.error(`removed ${removed.characters} hidden characters, ${removed.comments} comments and ${removed.entities} references`)
// `text` is what a model may read as policy.
```

## Errors

| Class | Extends | Fields | Thrown for |
| --- | --- | --- | --- |
| `QuorumError` | `Error` | `name`, the class's own name | The base of every error quorum raises on purpose |
| `ConfigError` | `QuorumError` | `issues`, each a `{ path, message }`, every one; the message holds one `path: message` line per issue for the first 50, then `and <n> more issues` | Invalid configuration or input, every issue at once. The CLI exits `2` on it |
| `ProviderError` | `QuorumError` | `providerId`, `kind`, `status`, `retryable`, `exhausted`, `retryAfterMs`, `usage`, `noAnswer`, `refused` (`structuredOutput`, `streamOptions` or `stream`: the field an HTTP 400 or 422 named as a whole word), `stalledMs` (set by the core alone, on a `timeout` that is a stalled stream: the window it showed no progress for), `ceilingMs` (set by the core alone, on a `timeout` at a ceiling that grew while its stream progressed: the ceiling it reached), `cutAfterMs` (set by the core alone, on the `truncated` failure it reads a learned cut as), `rateLimit` (a [`RateLimit`](#ratelimit): what the failed reply's rate-limit headers stated) | A provider call that failed: [`ProviderError`](../20-using/30-providers.md#providererror) |
| `OutputError` | `QuorumError` | `stage`, `reason`; `snippet`, the first 200 characters of the reply | A model reply that could not be read: `<stage> reply unusable: <reason> (reply starts: "<snippet>")` |
| `ProviderDownError` | `QuorumError` | `providerId`, `kind`, `status`, `count`, `streak`, `exhausted`, `cutAfterMs`, the shortest attempt in milliseconds when every call it counts was cut on the way, `noAnswer`, for a `no-answer` kind, `refused`, `stream` when the last failure was a refused stream, `stalledMs`, the shortest window in milliseconds when every call it counts stalled; `cause`, the last failure | A provider whose calls stopped: `<id>: 3 calls in a row failed (<kind>): no more calls go to it in this review: <fix>` when three of its calls in a row failed for a reason of its own, else `<id>: its one call failed (<kind>): <fix>` or `its <n> calls failed`, for a provider every call of which failed though fewer than three did. `<fix>` is a phrase naming what to check, as the CLI's progress line words it; for a provider whose quota is used up (`exhausted`) the message is `<id>: the account's credit, quota or spend limit is used up (<kind> <status>): no more calls go to it in this review: add credit or raise the limit at the provider, or wait until it resets`, whatever the count; for a provider down by replies with no answer the message says what they lacked instead: `<id>: 3 calls in a row had no answer, only reasoning: ...`, or `had no answer and no reasoning: ...`. It rejects a review only when no research call of any profile answered, and it is recognised by `instanceof` alone, as a limit's error is, so a provider cannot raise one. It is no `ProviderError`. The CLI exits `3` on it, and writes its message, then the cause's |
| `GitError` | `QuorumError` | `operation`, the git subcommand (`diff`, `rev-parse`, `ls-tree`, and `version` for `--version`); `exitCode`, git's, or `null` when it did not start or did not finish | A git command a source ran that failed: [below](#git-errors). The CLI exits `3` on it |

A failed research call or an unusable research reply, a gating profile's included, is its profile's `research-failed` gap, in words the code writes: `the research call failed (http 503) after 3 attempts`, or `the research reply could not be read: <reason>`, which quote nothing a server or a model wrote, and a provider found down leaves `provider-down` gaps. A research call's `ProviderError` or `OutputError` never rejects the review itself. The same errors from a vote are recorded in the vote's `error` and `failure` instead, a vote its provider was never sent with the failure `provider-down`. A `ProviderError` of kind `too-large`, from research or from a vote, is a `request-too-large` gap instead: the review does not reject, and a provider of your own raises it to have its own refusal of an oversized request recorded so. Any object with an own `kind` property of `'too-large'` counts, whatever its class, so a refusal from a second copy of quorum is a gap too.

### `RateLimit`

What a reply's rate-limit headers stated, as numbers, on a `CompletionResponse`, on the `headers` `StreamSignal` of a stream and on a `ProviderError`, a whole reply's failure included, each field there only when the reply sent it well formed:

```ts
interface RateLimit {
  readonly requests?: number
  readonly tokens?: number
  readonly tokensLimit?: number
  readonly requestsResetMs?: number
  readonly tokensResetMs?: number
}
```

`requests` and `tokens` are what is left of the window, `tokensLimit` is the window's tokens, and the resets are milliseconds until each count resets. A provider object of your own may state it on its responses and errors. The names the shipped adapters read, and what they ignore: [The rate-limit headers](../20-using/30-providers.md#the-rate-limit-headers).

### Git errors

A `GitError` comes from `readSource`, never from `review`. Its message says the git subcommand and what happened, and holds git's stderr only cut to 500 characters and written as a JSON string, so a line of it is inert: `git diff failed (exit 128): "fatal: bad object"`. The others are `git could not start (ENOENT)`, `git diff did not finish within 120000 ms`, `git diff was stopped by SIGKILL`, `git rev-parse printed an object format quorum does not read`, `git ls-tree printed an entry quorum cannot read`, `git ls-tree could not size an object the commit names: the repository lacks it, as a partial clone does`, `git cat-file did not return each listed blob at its listed size`, `git <subcommand> printed more than quorum reads`, when a call prints over the cap it is held to, and `git <subcommand> printed something quorum cannot read`, when a call exits cleanly and prints what is no full id or list of filter keys. A revision as typed and a path are never in it: [How quorum runs git](../20-using/15-sources.md#how-quorum-runs-git). A source that refuses what it was given, git missing or older than 2.41 included, is a `ConfigError` instead.

## Config types

```ts
declare function defineConfig(config: QuorumConfig): QuorumConfig
```

`loadConfig` reads a named config file and `fromConfig` builds a quorum from a config: [`loadConfig` and `fromConfig`](#loadconfig-and-fromconfig). The CLI and `runQuorum` read their settings through these two functions: [Configuration](../20-using/20-configuration.md). These exports write and type-check a config:

- **`QuorumConfig`** types what a TS or JS config exports as its default: `$schema`, for an editor, `version`, `providers`, `roles`, `concurrency`, `maxFindings`, `partTokens`, `maxReviewTokens`, `reviewTimeoutMs`, `strict`, `exclude`, `send` and `profiles`, every one optional. `send` is a list of non-empty file paths, the files to send the models though they are held back as secrets: [Sending a held file](../20-using/20-configuration.md#sending-a-held-file). A provider is an object implementing `Provider`, or its settings, every one optional too: `preset`, `protocol`, `baseUrl`, `model`, `contextTokens`, `apiKeyEnv` and `apiKey`, then `auth`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature`, `maxTokens`, `maxTokensField`, `systemPrompt`, `stream`, `timeoutMs`, `stallTimeoutMs` and `retries`, as [Providers](../20-using/30-providers.md#options) and [Deadlines and retries](../20-using/30-providers.md#deadlines-and-retries) describe them, and the fields of a `claude-code` provider, `args` and, in a code config only, `command`: [Claude Code options](../20-using/30-providers.md#claude-code-options).
- **`QuorumConfigFile`** types what a YAML or JSON config holds: the same settings, as data only, so a provider is always its settings, and names the environment variable that holds its key in `apiKeyEnv`, never holding one.
- **`ConfigInput`** types what `fromConfig` takes: the settings of `QuorumConfig`, with every prompt a string and every document a `{ text }` or a `{ repository, optional }`, since a program's config reads no file and so holds no `{ file }`: the config loader puts the text of a file in the same place. A `{ repository }` entry is read by [`readContext`](#readcontext), not by `fromConfig`.
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
  readonly failOn?: FailOnOverride
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

interface FailOnOverride {
  readonly all?: FailOn
  readonly profiles: ReadonlyMap<string, FailOn>
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
- **`options.failOn`** sets the fail-on level of the profiles that run, over the config's. It is a `FailOnOverride`: `all` is the level of every profile that runs, `profiles` the level of each profile it names, which wins over `all`, and `path` what its issues name; the CLI passes `--fail-on`. Each profile that runs is then a new frozen `ResolvedProfile` with that level as its `failOn`, so `meta.profiles` records it. A name in `profiles` that is not among the profiles that run is refused with a `ConfigError` at `path`, `names the profile "<id>", which does not run`, or `names a profile that does not run` for an id that is not a safe name: a typo must not leave a gate weaker or missing. A level that is none of the four is refused when `fromConfig` builds the quorum: `<id>.failOn: must be one of high, medium, low or none`.
- **The CLI reads each `--fail-on` value** with `parseFailOn`, which the package does not export, as `<level>` or `<profile>=<level>`: the level is `high`, `medium`, `low` or `none`, the profile matches `^[a-z][a-z0-9_-]*$`, and the value is split at its first `=`. It is checked before any config is read, and refused at `--fail-on`, each issue once and none repeating a value: `must be a level, high, medium, low or none, or <profile>=<level>` for a value that is neither form, `takes one level for every profile` for a second level for every profile, equal or not, and `names a profile more than once`.
- **`options.events`** is the event sink of the quorum, as `createQuorum` takes it.
- **`options.env` is also the environment a `claude-code` provider's child starts from**, less what the provider's auth mode removes: [The auth modes](../20-using/30-providers.md#the-auth-modes). Without an `env`, `fromConfig` hands `process.env` to the `claude` child, the whole of it, for a `ResolvedConfig` too. A program that holds secrets `claude` does not need passes an `env` of its own, with `PATH` and what `claude` authenticates with.
- **A process imports a TS or JS config once.** A second `loadConfig` of the same file gets the module the first import cached, since Node and Bun cache a module by its URL.
- **A program passes its config's `send` itself.** `fromConfig` builds a quorum, and `send` belongs to one review's input, so a program that reads `config.send` of a `ResolvedConfig` gives it to `readSource`'s context and to `review` (and `estimate`) itself, as the CLI does, with whatever it adds of its own: `const send = [...config.send ?? [], ...mine]`. A review that is not given it holds the file back.
- **A named config is trusted input.** It chooses where each key goes, and a TS or JS one runs code: in CI it must come from the base branch or from outside the pull request's checkout, never from the pull request under review, and its prompt files with it ([Layering](#layering)).
- **A `ResolvedConfig`** holds `providers`, the ones a profile that runs uses, by name: a spec with its key read into `apiKey`, or the snapshot of an object implementing `Provider`; `profiles`, each a `ResolvedProfile`: its `profile`, `research`, the name of its research provider, `voters`, the name of each lens's provider, by lens id, and `repository`, its `{ repository }` entries, which [`readContext`](#readcontext) reads; `concurrency`, `maxFindings`, `maxReviewTokens` and `reviewTimeoutMs` when the variables or the config set them, `strict`, `true`, when the config's `strict` or `QUORUM_STRICT` is `true`, `partTokens` when the config sets it, `exclude` when the config lists a pattern, `send` when it lists a file, and `warnings`. It is a copy, frozen all the way down: a provider object is a frozen snapshot of the program's, with no prototype, named by its config key as its `id`, and holding the `timeoutMs`, `retries`, `window`, `maxTokens`, `thinking`, `worstCase` and `room` it states.
- **A `ResolvedConfig` holds the keys it read**, as a code config does: never print or log one. The CLI's [`--print-config`](../20-using/10-cli.md#printing-the-resolved-config) redacts them.
- **`fromConfig` of a `ResolvedConfig` reads no environment**: what `loadConfig` resolved is what runs, whatever `options.env` holds, except that a `claude-code` provider's child still starts from `options.env`, else `process.env`.
- **A config is read as its own fields, with one limit.** A field planted on `Object.prototype` is a prototype pollution bug in the same process. An enumerable one is a field of every object, so it is refused as `is not a known field` wherever the schema does not know it: a planted `baseUrl` is refused at the top level, while a planted `concurrency`, `maxFindings`, `partTokens`, `maxReviewTokens`, `reviewTimeoutMs`, `strict`, `exclude`, `send` or `version` passes when the config holds no object that refuses it, and a planted `exclude` is the one that widens what passes unread, and a planted `send` what a provider is sent. One planted with `Object.defineProperty` is not enumerable, and the schema reads each field it knows through the prototype, so it becomes a field of the config, or of every provider that leaves it unset. Code that can plant either can read the keys directly: quorum does not defend against it.

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
| `QUORUM_RESEARCH_TIMEOUT_MS`, `QUORUM_VOTER_TIMEOUT_MS` | The deadline of one attempt of a role's provider, in milliseconds: a whole number from 1000 to 86400000; unset, it grows with the attempt's reply budget. On a `claude-code` provider it is Claude Code's wait for each attempt's response headers, and the whole run's deadline is that times the retries plus one: [Stopping, nesting and the version](../20-using/30-providers.md#stopping-nesting-and-the-version). It has no deprecated alias |
| `QUORUM_RESEARCH_STALL_TIMEOUT_MS`, `QUORUM_VOTER_STALL_TIMEOUT_MS` | How long a streamed attempt of a role's provider may show no progress before it fails as a timeout, in milliseconds: a whole number from 1000 to 86400000. Unset, the window is learned: [The stall window](../20-using/30-providers.md#the-stall-window). It has no deprecated alias |
| `QUORUM_RESEARCH_RETRIES`, `QUORUM_VOTER_RETRIES` | How many times a call of a role's provider that failed in passing is tried again: a whole number from 0 to 5. It has no deprecated alias |
| `QUORUM_RESEARCH_STREAM`, `QUORUM_VOTER_STREAM` | Whether a role's provider streams its replies: `true` or `false`, written exactly. `true` pins the stream and `false` asks for whole replies, as the `stream` field does; unset, the provider streams and steps down by itself when a server refuses: [Streaming](../20-using/30-providers.md#streaming). It has no deprecated alias |
| `QUORUM_RESEARCH_THINKING`, `QUORUM_VOTER_THINKING` | The `thinking` of a role's provider: `off` or `low`, sent as its protocol's own control: [Thinking](../20-using/20-configuration.md#thinking). It has no deprecated alias |
| `QUORUM_RESEARCH_API_KEY`, `QUORUM_VOTER_API_KEY` | The key of a role's provider, as a literal `apiKey` |
| `QUORUM_CLAUDE_CODE_COMMAND` | The `claude` executable of every `claude-code` provider a profile uses: an absolute path, or a name found in the absolute entries of `PATH`; a relative path and a `.cmd` or `.bat` file are refused. It wins over a code config's `command`: [Where the command comes from](../20-using/20-configuration.md#where-the-command-comes-from) |
| `QUORUM_MAX_REVIEW_TOKENS` | The review's token cap: a whole number of tokens from 1 to 9007199254740991, over the config's `maxReviewTokens` |
| `QUORUM_REVIEW_TIMEOUT_MS` | The review's deadline, in milliseconds: a whole number from 1000 to 86400000, over the config's `reviewTimeoutMs` |
| `QUORUM_STRICT` | `true` or `false`, written exactly: `true` turns the config's `strict` on, `false` sets nothing and never turns it off. Under `strict`, a key sent over plain `http` to a host other than this machine is refused before any call, not warned of: [Keys](../20-using/20-configuration.md#keys) |
| `RESEARCH_BASE_URL`, `RESEARCH_API_KEY`, `RESEARCH_MODEL`, `VOTER_BASE_URL`, `VOTER_API_KEY`, `VOTER_MODEL` | Deprecated aliases: each is read as the `QUORUM_` variable of the same name |

- **The `QUORUM_` form wins** over its alias when both are set, and one warning names every alias that is set, whichever form won: `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead`. A preset, a protocol, a context size, a thinking, a deadline and a retry count have no alias.
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
| Another origin, or no `http(s)` origin | `QUORUM_VOTER_BASE_URL` | `QUORUM_VOTER_API_KEY`, else none: a preset's own variable is not read | `QUORUM_VOTER_MODEL`, which is then required | `QUORUM_VOTER_CONTEXT_TOKENS` only | `apiKeyEnv`, `headers`, `query`, `extraBody` and `model` dropped; the preset, protocol, `auth`, `structuredOutput`, `thinking`, `temperature`, `maxTokens`, `maxTokensField`, `systemPrompt`, `stream`, `timeoutMs`, `stallTimeoutMs` and `retries` kept |
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
| `QUORUM_RESEARCH_STALL_TIMEOUT_MS`, `QUORUM_VOTER_STALL_TIMEOUT_MS` | `must be a whole number of milliseconds, from 1000 to 86400000` | A stall window variable that is not a whole number written in decimal digits in that range, as a deadline variable is: the message never repeats the value |
| `QUORUM_RESEARCH_RETRIES`, `QUORUM_VOTER_RETRIES` | `must be a whole number, from 0 to 5` | A retries variable that is not a whole number written in decimal digits in that range: `6`, `-1`, `1.5` and `02` are refused, and the message never repeats the value |
| `QUORUM_RESEARCH_STREAM`, `QUORUM_VOTER_STREAM` | `must be true or false` | A stream variable that is neither `true` nor `false`, written exactly, and the message never repeats the value |
| `QUORUM_RESEARCH_THINKING`, `QUORUM_VOTER_THINKING` | `must be low or off` | A thinking variable that is neither `low` nor `off`, and the message never repeats the value. A `thinking` the provider's protocol cannot honour, or that sits beside the same control in `extraBody`, is refused at the variable too, with the builder's words: [Thinking](../20-using/30-providers.md#thinking) |
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
| `QUORUM_RESEARCH_PRESET` and the other variables of a role: the preset, the protocol, the base URL, the model, the context size, the deadline, the stall window, the retries and the key | The builder's, such as `must be one of ollama, ollama-cloud, ...` | A provider that the builder refuses on a field a variable set: the issue names the variable, never the provider the variables built |
| `providers.<name>.model` | `must be a string` | A provider object whose model is not a string |
| `providers.<name>.timeoutMs`, `providers.<name>.stallTimeoutMs`, `providers.<name>.retries` | `must be a whole number of milliseconds from 1000 to 518400000`, `must be a whole number of milliseconds from 1000 to 86400000` (`stallTimeoutMs`), or `must be a whole number from 0 to 5` | A provider object that states one out of range, as an own data property |
| `providers.<name>.streams` | `must be true` | A provider object that states a `streams` that is not `true`, as an own data property |
| `providers.<name>.window`, `providers.<name>.maxTokens` | `must be a whole number of tokens of at least 1` | A provider object that states one that is not, as an own data property |
| `providers.<name>.thinking` | `must be default, low or off` | A provider object that states another value, as an own data property |
| `providers.<name>.worstCase` | `must be a function` | A provider object that states a `worstCase`, as an own data property, that is no function |
| `providers.<name>.room` | `must be a function` | A provider object that states a `room`, as an own data property, that is no function |
| `providers.gpu.baseUrl` | `sends the key over plain http to a host other than this machine, and strict refuses it: use an https URL` | `strict` is on, in the config or in `QUORUM_STRICT`, and a key would travel in cleartext: the refusal of the warning below. When a `QUORUM_*` variable set the base URL, the path is that variable's, `QUORUM_RESEARCH_BASE_URL` or, for a derived voter, `QUORUM_VOTER_BASE_URL` |
| `QUORUM_STRICT` | `must be true or false` | The variable is neither, written exactly |

The warnings, each but the first two starting at the path it is about:

| Warning | Cause |
| --- | --- |
| `RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead` | A deprecated alias is set; one line names every alias, and every `QUORUM_` variable to set instead |
| `QUORUM_PROFILE is not a variable quorum reads` | A `QUORUM_` variable that is set and that quorum does not read: one line names every such variable, sorted, and prints a name that is not an upper-case variable name as `*` |
| `providers.gpt.baseUrl: is not the endpoint of the openai preset, so OPENAI_API_KEY is not sent: set apiKeyEnv to send a key` | A provider of a preset whose base URL is not the preset's origin |
| `providers.voter.baseUrl: is not the endpoint of the research provider, so OPENAI_API_KEY is not sent: set QUORUM_VOTER_API_KEY to send a key` | A derived voter on another origin than research's, whose provider keeps a preset that has a key variable |
| `providers.gpu.baseUrl: sends the key over plain http to a host other than this machine` | A key that would travel in cleartext, without `strict` |
| `providers.default: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key` | A `claude-code` provider a profile uses, under `inherit` or with no `auth`, while `ANTHROPIC_API_KEY` is set |
| `profiles.team.gating is deprecated: set failOn instead, high for true and none for false` | A profile entry that sets `gating`, which still reads: `true` as `high`, `false` as `none` |

## Exports

| Values | |
| --- | --- |
| `createQuorum` | Build a quorum |
| `defineConfig` | Type a TS config: [Config types](#config-types) |
| `INTERRUPT_GRACE_MS` | How long the calls in flight have to end once a review's `interrupt` aborts, 5000 ms: [Interrupt](#interrupt) |
| `LANE_START`, `REVIEW_CEILING` | Where a provider's lane starts, 4 calls at once, and the most calls in flight over every lane, 16: [Lanes](../20-using/30-providers.md#lanes) |
| `fileStore` | The CLI's `--state` store, as a `ReplyStore` for `review`'s `store`: [`fileStore`](#filestore) |
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
| `renderReport` | Write a result, or its public view, as the report the CLI writes, in the format `text`, `json`, `brief`, `markdown`, `payload` or `sarif`: [`renderReport`](#renderreport) |
| `publicView` | The result less each vote's reasoning and error, the discarded findings, the providers, the usage and each gap's detail, for a sink a stranger can read: [`publicView`](#publicview) |
| `readResult` | Read a saved result or public view back from its JSON text, of this release only, through a strict schema and a cap: [`readResult`](#readresult) |
| `QuorumError`, `ConfigError`, `ProviderError`, `ProviderDownError`, `OutputError`, `GitError` | The error classes |
| `inertLine`, `inertJson`, `codeSpan`, `fencedBlock`, `inertPlain` | Render a line for a terminal or a log, a value as JSON, text in Markdown and plain text a viewer may link, inert: [Output handling](../30-security/30-output-handling.md#printing-a-review-yourself) |
| `cleanProse` | Remove the HTML comments, numeric character references and hidden characters from prose a model reads as policy, to a fixpoint of at most 16 passes: [`cleanProse`](#cleanprose) |
| `runQuorum` | Deprecated: [below](#runquorum) |

The types: `ActionComment`, `ActionPayload`, `Adaptation`, `CleanedProse`, `ConcurrencyRecord`, `Confidence`, `CoverageEntry`, `CoverageReason`, `CoverageStatus`, `CredentialKind`, `Estimate`, `FailOn`, `Finding`, `Flag`, `FlagCode`, `IncompleteEntry`, `IncompleteReason`, `LeftOutFile`, `LeftOutReason`, `LeftRange`, `Lens`, `LensVote`, `ObjectFormat`, `Outcome`, `OutcomeStatus`, `Profile`, `ProfileEstimate`, `ProfileMeta`, `ProfileProviders`, `Prompts`, `ProviderRef`, `PublicGap`, `PublicMeta`, `PublicProfileMeta`, `PublicVerdict`, `PublicView`, `PublicVote`, `Quorum`, `QuorumEvent`, `QuorumMeta`, `QuorumOptions`, `QuorumResult`, `Removed`, `ReportFormat`, `ReportInput`, `ReportOptions`, `ReportView`, `ReviewInput`, `ReviewSource`, `SecretRule`, `SkipRule`, `SourceRead`, `SourceSpec`, `StageName`, `Thresholds`, `Usage`, `Verdict`, `VerdictStatus`, `Vote`, `VoteFailure` and `VoteFailureKind`; `Adapts`, `ChatMessage`, `CompletionRequest`, `CompletionResponse`, `EventSink`, `JsonSchema`, `ProfilePorts`, `Provider`, `QuorumPorts`, `ReplyStore`, `StoredCall` and `StreamSignal`; `ConfigIssue`, `NoAnswer`, `ProviderErrorKind` and `ReplyLack`; `ProfileBudgets`, `ReplyFacts` and `ThinkingLevel`; `PolicyRules` and `Rule`; `AnthropicOptions`, `Auth`, `ClaudeCodeAuth`, `ClaudeCodeOptions`, `GeminiOptions`, `HttpProviderOptions`, `OllamaOptions`, `OpenAICompatibleOptions`, `StructuredOutput` and `SystemPrompt`; `Preset`, `PresetName` and `Protocol`; `ConfigInput`, `QuorumConfig` and `QuorumConfigFile`; `Env`, `FailOnOverride`, `ProfileSelection`, `ResolvedConfig`, `ResolvedProfile` and `ResolvedProvider`. `HttpProviderOptions` holds the options an HTTP provider takes, `OpenAICompatibleOptions` adds `maxTokensField`, and `AnthropicOptions`, `GeminiOptions` and `OllamaOptions` are `HttpProviderOptions` as it is: [Providers](../20-using/30-providers.md#options). `ClaudeCodeOptions` holds the options of `claudeCode` and `ClaudeCodeAuth` its three auth modes. `Preset` types a row of `presets`, `PresetName` names one, and `Protocol` names the four wire protocols.

The stages and the profile checks are not exported: a program reaches the stages through `createQuorum`. The exit-code rule is `outcome`.

## `runQuorum`

```ts
declare function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult>
```

Deprecated: use `loadConfig` and `fromConfig`. `runQuorum` reviews `diff` as the CLI does with no flag: it calls `loadConfig()` and `fromConfig` on the result, so it reads the file `QUORUM_CONFIG` names, if any, which must be an absolute path, and the `QUORUM_*` variables of `process.env` with their `RESEARCH_*` and `VOTER_*` aliases, and it runs the profiles they select, the security profile alone by default: [Configuration](../20-using/20-configuration.md). It gives the review the config's `send`, so a file that list names is sent though held as a secret, and it takes no `send` of its own. `onProgress` receives the CLI's progress lines, the `left out:` and `flag:` lines included, each one inert and each profile's line starting with `[<id>] ` when several run, but neither the banner, nor a warning, nor `empty diff: nothing to review`, which the CLI writes itself. A configuration error, a missing model included, rejects with a `ConfigError`, for an empty diff too. It passes no context, so a config that lists a `{ repository }` entry is refused before any call, at the entry, with `reads a document of the repository, which runQuorum cannot read: build the quorum with fromConfig and pass readContext's context to review`.

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
