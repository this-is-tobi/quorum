# Profiles

A profile is what a review looks for, as data: the finder's instructions, the panel's lenses and how their votes are graded, the level at which its findings fail the review, and optional guidelines. Four ship with quorum: `security`, `code-review`, `best-practices` and `performance`. The CLI runs the `security` profile by default, and the profiles its config or `--profile` selects. A program can run one, change it, write a profile of its own, and run several in one review. This page covers the four built-in profiles, writing a profile and the checks it must pass, several profiles at once, gating, and guidelines.

## The security profile

`securityProfile`, exported by `@tobi-or-not/quorum`, is the default and the one the CLI runs by default:

| Field | Value |
| --- | --- |
| `id` | `security` |
| `prompts` | The finder's instructions and the vote template, quoted on [Prompts](./60-prompts.md#the-security-profiles-templates) |
| `lenses` | `reachability`, `impact` and `defenses`, below |
| `policy` | `{ high: 'unanimous', medium: 'majority', low: 'off' }`: 3 of 3 kept votes is `high`, 2 of 3 is `medium` |
| `failOn` | Unset: `high` |
| `guidelines` | None |

| Lens | Question |
| --- | --- |
| `reachability` | Is this sink actually reachable from untrusted input in normal flow - not just syntactically present? |
| `impact` | If reached, is the impact real - not just bad-looking code? |
| `defenses` | Do existing checks elsewhere already neutralize this? |

The sink these questions name is the code the vulnerability ends in, which the finder is asked to quote. The vote template calls each lens a refutation angle and tells the voter to default to `keep=false` unless genuinely convinced: [Lenses and policy](./50-lenses-and-policy.md#lenses) says why there are three.

The profile is frozen, down to each lens, so an assignment to it throws a `TypeError` in strict-mode code, which every ES module is, and a change made for one review cannot leak into the next. Spread it into a new object instead:

```ts
import { securityProfile } from '@tobi-or-not/quorum'

const security = { ...securityProfile, guidelines: 'Queries go through db.query with parameters.' }
```

## The built-in profiles

Three more profiles ship beside `security`, as data read by the same registry and resolved the same way: `codeReviewProfile`, `bestPracticesProfile` and `performanceProfile`, exported by `@tobi-or-not/quorum` and frozen as `securityProfile` is. Each is advisory: its kept findings never fail a review. Each asks its finder for 20 findings a request, keeps a finding only within two rows of a row the change adds or removes, and votes with the security profile's template, a refutation angle for each of three lenses, graded by the same policy, `{ high: 'unanimous', medium: 'majority', low: 'off' }`. `--profile` selects one, or several in one review:

```bash
quorum --range origin/main...HEAD --profile code-review --profile best-practices
```

| Profile | Looks for | `failOn` | `maxFindings` | `changedLinesOnly` | `requireRule` | Rules | Lenses |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `security` | Security vulnerabilities, by CWE id | Unset: `high` | Unset: the review's | Unset: `false` | Unset: `false` | None | `reachability`, `impact`, `defenses` |
| [`code-review`](#code-review) | Functional defects the changed lines cause or expose | `none` | 20 | `true` | Unset: `false` | None | `real`, `introduced`, `consequential` |
| [`best-practices`](#best-practices) | Changed code that lacks what one of its four rules asks for | `none` | 20 | `true` | `true` | `io-errors`, `input-validation`, `tests-for-new-code`, `resource-cleanup` | `asked`, `absent`, `introduced` |
| [`performance`](#performance) | A few known cost patterns, both halves in the changed lines | `none` | 20 | `true` | `true` | `query-in-loop`, `nested-loops`, `work-in-loop`, `sync-io-in-async`, `unbounded-list`, `unbounded-cache` | `visible`, `hot`, `unmitigated` |

The three read a review's log and report as any profile does, each line naming its profile: `context: best-practices do-not-report text of the profile, 169 bytes` and `context: best-practices rules: 4 of 4 sent` above the stages, the text report's `code-review (fail-on none): 1 kept, ...`, and, for a finding that cites a rule, a head that ends `  rule io-errors`. A finding dropped for standing away from the change is its own line and count: [Per profile](../95-reference/20-json-result.md#per-profile). A review of the three, or of one with the security profile, is one more research call and one more panel for each: [Several profiles in one review](#several-profiles-in-one-review).

### Unmeasured

The three are design intent rather than measured precision, until quorum has a labelled set of its own to measure them by: the security profile alone has one, [the real-bug suite](./70-bench.md#the-real-bug-suite). What is known of the design is a small, largely synthetic mutation study of five small and mid-size models (arXiv 2606.15689), which found a rule-bound review's best-practice recall at 0 to 6.7 percent and its performance recall near zero. So read a finding of the three as a lead to check, never as a verdict, and a review with none as a review that found none, not as proof there is none. That is why they fail nothing.

Each also reads the diff alone. It cannot see the code outside the change, the callers of a function, a test or a handler that lives in another file, or a limit set elsewhere, and reading the repository around a change is what sub-project 8 brings. The lenses ask the voters to refute a finding from what the diff shows.

### Who receives each text

Each text goes to the roles that need it, and no text of a built-in profile reaches a voter but its lens question and the rule its finding cites:

| Text | Finder (research) | Voters |
| --- | --- | --- |
| Research template | The system message | None |
| Do-not-report list | The system message, after the template (`This review does not report:`) | None |
| Built-in review rules | The rules block, every rule the review sends | The one rule its finding cites, in the `rule` block of every lens's vote; the `asked` lens judges by it |
| Vote template | None | Each lens's system message |
| Lens questions | None | Each lens its own |
| Guidelines | None of its own | None of its own |

A threat-model guideline sent to the finder and to every voter took kept recall from 60% to 40% in one ablation, the voters rejecting true findings. A do-not-report list in a vote would tell the voter what is out of scope and put the same pressure on it, so the list stays the finder's. Guidelines a config or a review adds go in every request as ever: [What each request carries](./45-rules-and-guidelines.md#what-each-request-carries).

### `code-review`

Functional defects that the changed lines cause or expose: wrong logic or results, broken error and edge paths, concurrency bugs, data loss or corruption, and a misused API or a broken contract. A finding's quote is the code that misbehaves, and its category is `bug`, `concurrency`, `data` or `api`. It lists no rule. Its research template is quoted on [Prompts](./60-prompts.md#the-built-in-profiles-templates), and its lenses `real`, `introduced` and `consequential` on [Lenses and policy](./50-lenses-and-policy.md#the-built-in-profiles-lenses). Its do-not-report list, 441 bytes, reaches the finder alone:

```text
- style, formatting, naming and comments
- design, architecture and refactoring preferences
- what a linter, a formatter or a type checker reports
- missing tests or documentation
- slow code that behaves correctly
- security vulnerabilities, which the security profile reviews
- issues in code the change does not touch
- speculation that rests on an input or a caller the diff does not show
- code a suppression comment silences on purpose
```

### `best-practices`

Code the change adds or alters that lacks what one of its rules asks for, and nothing else: it sets `requireRule`, so a finding that cites no rule the review sent is dropped. The finder cites the line where the missing piece belongs and quotes the code beside it, the handler, function, call or block, within two lines of that line, so the quote sits in the cited line's evidence and the finding keeps its line. A finding's category is `test_gap` for a missing test, `doc_defect` for missing documentation a rule asks for, else the kind of practice in a word or two, such as `error-handling`, `validation` or `cleanup`. Its research template is on [Prompts](./60-prompts.md#the-built-in-profiles-templates), its lenses `asked`, `absent` and `introduced` on [Lenses and policy](./50-lenses-and-policy.md#the-built-in-profiles-lenses). Its four rules apply to every file, and every review sends all four:

| Rule | Asks |
| --- | --- |
| `io-errors` | A call that crosses an I/O boundary (network, file system, database, subprocess) handles its failure on purpose: the error is caught and handled, returned or propagated, never dropped or ignored. |
| `input-validation` | Data that crosses a trust boundary (a request, a message, a file, input from a user or a tenant) is validated where it enters: its type, shape, size or range is checked before use. |
| `tests-for-new-code` | A new public function, route, endpoint or branch of behaviour comes with a test that runs it. |
| `resource-cleanup` | A resource the code acquires (a file handle, a connection, a lock, a timer, a subscription, a temporary file) is released on every path, error paths included. |

Its do-not-report list, 169 bytes, reaches the finder alone:

```text
- anything no review rule asks for
- style, naming and formatting
- a choice between two correct ways of writing the same thing
- a gap in code the change does not touch
```

### `performance`

A second opinion on a few known patterns, and not a profiler: the six rules below describe them, and the finder reports one only when the changed lines show both of its halves, the repetition or the blocking context (a loop, a request handler, an async function or a structure that grows) and the costly operation inside it. A finding's quote holds both halves, and its category is `perf`. Like `best-practices` it sets `requireRule`. Its research template is on [Prompts](./60-prompts.md#the-built-in-profiles-templates), its lenses `visible`, `hot` and `unmitigated` on [Lenses and policy](./50-lenses-and-policy.md#the-built-in-profiles-lenses).

| Rule | Describes |
| --- | --- |
| `query-in-loop` | A database query, an HTTP or RPC call, or another remote call made once per iteration of a loop over data, where one batched call could serve the loop. |
| `nested-loops` | A loop over a collection inside a loop over the same or a related collection, or a linear search inside a loop, so the work grows with the square of the input. |
| `work-in-loop` | Work that gives the same result on every iteration, such as compiling a pattern, parsing a document or building a large object, repeated inside a loop. |
| `sync-io-in-async` | A synchronous, blocking call (file or network I/O, a subprocess, a sleep) inside an async function, a request handler or an event-loop callback. |
| `unbounded-list` | An endpoint or a query that returns a list with no limit, page size or cap, so the caller or the data decides how much is read and sent. |
| `unbounded-cache` | A cache, map, list or buffer that entries are added to and never evicted, expired or capped, in code that lives as long as its process. |

Its do-not-report list, 259 bytes, reaches the finder alone:

```text
- micro-optimizations: a faster idiom for the same work, string building, the style of a loop
- costs bounded by a small fixed input
- code that runs once, such as startup, migrations, scripts and tests
- a pattern whose two halves the diff does not both show
```

### Changing one

A program spreads a built-in profile into a new object, as it does `securityProfile`, and sets what it wants over it: `{ ...codeReviewProfile, maxFindings: 40 }` asks the finder for 40 findings a request, over the profile's 20 ([Reply budgets](./20-configuration.md#reply-budgets) says what the ask costs and what limits it), and `{ ...performanceProfile, changedLinesOnly: false }` keeps a finding anywhere in the diff. A config entry named for a built-in profile starts from it and takes what it does not set: an entry named `code-review`, `best-practices` or `performance` keeps the built-in's finding cap, `changedLinesOnly`, do-not-report text and `failOn: none`, and, for `best-practices` and `performance`, its rules and `requireRule`. A profile of your own that took one of these names before they were built in would take all of that without a word, and its `failOn` would read as it was set while most findings that could trip it were dropped. So an entry named after one of the three that has no `extends` and brings both its own research template and its own lenses, the shape of a profile of its own, is refused before any call, `--print-config` included: `profiles.<id>: is named after the built-in <id> profile and brings its own research template and lenses: set extends: <id> to start from the built-in, or rename the profile to keep it your own`. Say `extends` to start from the built-in, or rename the profile to keep it yours. An entry that sets only the template, or only the lenses, starts from the built-in as written. `builtInDoNotReport: false` drops its do-not-report text and `builtInRules: false` its rules, as [Rules and guidelines](./45-rules-and-guidelines.md#builtindonotreport) says. A profile that requires a rule and lists none asks its finder nothing, so drop the rules of `best-practices` or `performance` only to put others in their place.

A config does the same without code. An entry `extends` any built-in profile, not `security` alone, and sets `maxFindings` and `changedLinesOnly` of its own, each the base's when unset; `changedLinesOnly: false` turns off a base that sets it, and `maxFindings` is a positive integer (`profiles.<id>.maxFindings: must be at least 1`, at the entry, exit `2`, for a `0`). A profile that `extends` an advisory built-in (`code-review`, `best-practices` or `performance`) takes its `failOn: none` unless it sets one, so a team that wants it to gate sets `failOn`. An `extends` that names none of the four is refused: `profiles.<id>.extends: must be one of security, code-review, best-practices or performance`.

```yaml
profiles:
  code-review: {}
  team-practices:
    extends: best-practices
    maxFindings: 40
    changedLinesOnly: false
```

`--print-config` prints both under a profile that holds them and `unmeasured: true` under a profile that is or extends one no labelled set measures, so `team-practices` prints `maxFindings: 40` and `unmeasured: true` (it holds no `changedLinesOnly`), and `code-review` prints `maxFindings: 20`, `changedLinesOnly: true` and `unmeasured: true`: [Printing the resolved config](./10-cli.md#printing-the-resolved-config). A config's top-level `maxFindings` sizes the requests of a profile that holds none, so it never changes the 20 of a built-in profile or of one that extends it.

## Writing a profile

| Field | Type | Rule |
| --- | --- | --- |
| `id` | `string` | Matches `^[a-z][a-z0-9_-]*$`, and no other profile of the review has it |
| `prompts.research` | `string` | Not blank, and takes no `{{…}}` variable: the diff is appended as fenced data |
| `prompts.vote` | `string` | Not blank, and takes `{{lens.id}}`, `{{lens.question}}` and `{{panel.size}}` only |
| `lenses` | `{ id: string, question: string }[]` | At least one. Each `id` matches the same pattern and is unique in the profile; each `question` is a string that is not blank |
| `policy` | `{ high, medium, low }` | Optional, `defaultPolicy` when unset. Each level is a rule: [Policy rules](./50-lenses-and-policy.md#policy-rules) |
| `failOn` | `'high' \| 'medium' \| 'low' \| 'none'` | Optional, `high` when unset: [Gating](#gating) |
| `gating` | `boolean` | Deprecated: `true` is `failOn: 'high'`, `false` is `'none'`; not with `failOn` |
| `guidelines` | `string` | Optional: [Guidelines](#guidelines) |
| `doNotReport` | `string` | Optional: what the research does not report, [Guidelines](#guidelines) |
| `documents` | `ReviewDocument[]` | Optional: the guidelines, do-not-report and rules documents of the profile's configuration, [Guidelines](#guidelines) |
| `rules` | `ReviewRule[]` | Optional: the profile's own review rules, a finding may cite by id: [Review rules](./45-rules-and-guidelines.md#review-rules) |
| `requireRule` | `boolean` | Optional, `false` when unset: every finding must cite a rule the review sent, or it is dropped: [Review rules](./45-rules-and-guidelines.md#review-rules) |
| `changedLinesOnly` | `boolean` | Optional, `false` when unset: a finding stands only within two rows of a row the change adds or removes, and any other is dropped as away from the change. quorum's git sources show three rows of context, so on such a diff it drops a finding on the outermost context row of a hunk; on a `-U20` diff, whose hunks hold twenty rows of context, it drops every finding more than two rows from a changed one; on a path review, whose diff only adds, none. Each is counted in `meta.profiles.<id>.awayFromChange`, apart from the findings outside the diff: [Per profile](../95-reference/20-json-result.md#per-profile) |
| `maxFindings` | `number` | Optional, the review's `maxFindings` when unset (50): the findings each research request of the profile asks for at most, a positive integer, over the review's for this profile alone. It is the profile's ask, never the panel's cap, which stays the review's `findingsCap`, one for every profile: [Reply budgets](./20-configuration.md#reply-budgets) |

The reply the finder must give is fixed, whatever the profile: a `findings` array whose every entry holds `file`, `line`, `category`, `quote` and `summary`. quorum's request names those five fields itself, in a paragraph of its own right after the line that asks for at most `N` findings, so every profile gets the same contract, yours included: `file` as the diff names it, `line` in the new file (for removed code, the nearest line that survives), `quote` the code that shows the finding, copied verbatim without the leading `+`, `-` or space, `category` the finding's kind, as your instructions define it, and `summary` why it is a finding. Your research instructions say what to look for, what a quote holds and what a category means for what you review, as the security profile's do (the sink, and a CWE id), and need not name a field otherwise.

A finding that leaves its category out, or gives `null` or a blank one, is reviewed all the same, as `uncategorized`: its head reads `<file>:<line>  uncategorized`, and the voters read `[uncategorized]` in the claim. Any other field left out, or a category that is not text, makes the finding unreadable, a `finding-unreadable` gap.

A naming review that reports but never gates:

```ts
import type { Profile } from '@tobi-or-not/quorum'

export const naming: Profile = {
  id: 'naming',
  prompts: {
    research: 'Review this diff for names that mislead: a function, variable or type whose name says something its code does not do. A finding\'s quote is the declaration that carries the name, and its category is the kind of problem: `overpromises`, `underpromises` or `wrong-verb`.',
    vote: [
      'One vote in a {{panel.size}}-voter panel on a naming finding - you do not see the other votes. Lens: {{lens.id}}.',
      '{{lens.question}}',
      '',
      'Judge only from the blocks you receive. Default keep=false unless convinced.',
    ].join('\n'),
  },
  lenses: [
    { id: 'meaning', question: 'Does the name say something the code does not do?' },
    { id: 'reader', question: 'Would someone reading only the calling code be misled by it?' },
  ],
  policy: { high: 'unanimous', medium: 'any', low: 'off' },
  failOn: 'none',
}
```

With two lenses, that policy makes 2 of 2 kept votes `high` and 1 of 2 `medium`.

### The checks

`createQuorum` checks every profile before any call, and reports every problem at once in one `ConfigError`, one `path: message` line each. A path starts at the profile's id, or at `profiles.<index>` while that id is invalid:

| Path | Message |
| --- | --- |
| `profiles.<index>` | `must be an object` |
| `profiles.<index>.id` | `must match ^[a-z][a-z0-9_-]*$, got "Security"`, or `repeats the profile id "security"` |
| `<id>.lenses` | `must be an array of lenses`, or `at least one lens is required` |
| `<id>.lenses.<index>` | `must be an object with an id and a question` |
| `<id>.lenses.<index>.id` | `must match ^[a-z][a-z0-9_-]*$, got "Scope"`, or `repeats the lens id "meaning"` |
| `<id>.lenses.<index>.question` | `must be a string`, or `must not be empty` |
| `<id>.policy` | `must be an object with high, medium and low rules`, or `at least one confidence level must be enabled` |
| `<id>.policy.<level>` | A rule that is malformed, or that needs more votes than a level above it: [Validation](./50-lenses-and-policy.md#validation) |
| `<id>.prompts` | `must be an object holding the research and vote templates` |
| `<id>.prompts.research`, `<id>.prompts.vote` | `must be a string`, or `must not be empty` |
| `<id>.prompts.research`, `<id>.prompts.vote` | `holds a {{ that opens no placeholder: write \{{ for a literal {{` |
| `<id>.prompts.research` | `the placeholder "diff" is not allowed: the diff is appended automatically as fenced data`, or `the placeholder "file" is not allowed: the research template takes no variables` |
| `<id>.prompts.vote` | `the placeholder "lens.name" is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}` |
| `<id>.failOn` | `must be one of high, medium, low or none` |
| `<id>.gating` | `must be true or false`, or `is deprecated and cannot be set with failOn: remove it` |
| `<id>.changedLinesOnly` | `must be true or false` |
| `<id>.maxFindings` | `must be a positive integer, got 0`, the value quoted when it is a number, else `must be a positive integer` |
| `<id>.guidelines`, `<id>.doNotReport` | `must be a string`, `holds <n> bytes once cleaned, over the 16 KiB a guidelines document may hold` (8 KiB for a do-not-report document), or `nests HTML comments or character references too deep to clean in 16 passes: remove them` |
| `<id>.documents` and below | A document's own issues, its cap and the caps of a kind in all: [Documents](../95-reference/30-library-api.md#documents) |

A template gets one line for its first `{{` that opens no placeholder, then one per distinct variable it may not use, in the order they first appear, and a blank one gets `must not be empty` alone. The name is JSON-quoted and cut at 64 characters, with `…` inside the quotes when it is cut. [Templates](./60-prompts.md#templates) says what is a placeholder and how to write a literal `{{`. The checks read the shape first, so a program without types that passes a malformed profile gets these lines, never a `TypeError`.

### Warnings

A profile the checks accept may still set something that cannot take full effect. `createQuorum` lists such settings in the quorum's `warnings`, each starting at the profile id, and runs anyway:

| Warning | Means |
| --- | --- |
| `<id>.policy.<level> needs the same <n> vote(s) as policy.<higher level> with <k> lens(es), so it never applies` | Two enabled levels need the same number of kept votes, so the lower one is never reached |
| `<id>.prompts.vote uses neither {{lens.id}} nor {{lens.question}}, so every lens gets the same instructions` | With more than one lens, a vote template that names neither asks every voter the same thing |
| `<id>.gating is deprecated: set failOn instead, high for true and none for false` | The profile sets `gating`, which still reads: [Gating](#gating) |
| `<id>.failOn is low, but policy.low is off, so it acts as medium` | No kept finding is `low` while the policy's `low` is off, so `low` fails what `medium` fails |

The default policy meets the first with one or two lenses: the `naming` profile above, with its policy left unset, would get `naming.policy.medium needs the same 2 vote(s) as policy.high with 2 lens(es), so it never applies`. The CLI prints each one as a `warning:` line before its banner, and the security profile has none.

## Several profiles in one review

```ts
import { createQuorum, ollama, securityProfile } from '@tobi-or-not/quorum'
import { naming } from './naming.ts'

const local = ollama({
  id: 'local',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.6:27b',
  contextTokens: 131072
})
const quorum = createQuorum({
  profiles: [securityProfile, naming]
}, {
  profiles: {
    security: {
      research: local,
      voters: { reachability: local, impact: local, defenses: local }
    },
    naming: {
      research: local,
      voters: { meaning: local, reader: local }
    },
  },
})
```

- **One pass each.** Every profile runs research, dedup and its panel on its own, all profiles at once: one research call per profile, then its own votes.
- **One set of lanes.** Each provider has a lane, shared by every profile that uses it, within a ceiling of 16 calls in flight across every profile of the review; `concurrency`, when it is set, is one limit for them all: [Lanes](./30-providers.md#lanes).
- **Every finding is tagged with its profile**, and its `id` hashes the profile too, so a line two profiles flag is two findings with two ids, each judged by its own panel.
- **Nothing is merged across profiles.** No request of one profile holds another profile's output. In each list of the result, a profile's verdicts follow the previous profile's, in the order of `profiles`, and `meta.profiles` has one entry per profile.
- **A failure ends no profile.** A research call or reply that fails is its profile's own `research-failed` gap, a gating profile's too, and the other parts and profiles go on: [Gating](#gating). Only a review in which no research call of any profile answered ends with an error: [When the research call fails](./10-cli.md#when-the-research-call-fails).

The cost grows with each profile: one more research call, and one call per lens for each of its findings.

## Gating

`failOn` is the confidence at or above which a profile's kept findings fail the review: `high`, `medium` or `low`, or `none` for an advisory profile. It is `high` when unset. A profile gates unless its `failOn` is `none`.

- **A kept finding at or above the level exits `1`.** The levels run `high`, then `medium`, then `low`: `failOn: 'medium'` fails a kept finding at `high` or `medium`, and `failOn: 'high'` one at `high` only. The finding counts for its own profile's level, so one review can fail one profile at `medium` and another at `high`.
- **The gaps of a gating profile exit `4`.** An unreviewed finding, or an entry of `meta.incomplete`, of a gating profile makes the review incomplete, and the CLI exits `4` unless a kept finding exits `1` first. A review with neither exits `0`.
- **`low` needs the policy's `low` on.** A finding reaches `low` only when the policy's `low` rule is not `off`, as in the default policy. With it off no kept finding is `low`, so `failOn: 'low'` fails what `medium` fails, and the profile warns of it ([Warnings](#warnings)).
- **`gating` is deprecated.** `true` reads as `failOn: 'high'` and `false` as `'none'`, with the warning `<id>.gating is deprecated: set failOn instead, high for true and none for false`, which the CLI prints before its banner and a config prints as `profiles.<id>.gating is deprecated: ...`. A profile or a config entry that sets both is refused, at its `gating` ([The checks](#the-checks)). The security profile states neither, so a program's `{ ...securityProfile, gating: false }` still runs, with the warning.
- **`--fail-on` sets the level from the command line.** `--fail-on medium` sets the level of every profile that runs, and `--fail-on security=none` that of one profile, which wins over the one for every profile. Both win over the config's `failOn`, and no variable sets one: the level a job runs with is in its command line, and [`--print-config`](./10-cli.md#printing-the-resolved-config) shows it. It repeats, once for every profile and once for each profile named, and it refuses a profile that does not run, so a typo never leaves a gate weaker or missing: [The flags](./10-cli.md#the-invocation).

```bash
quorum --range origin/main...HEAD --fail-on medium
```

A profile at `failOn: 'none'` reports every finding and every gap in full, and neither changes the exit code: its kept findings are in `kept`, its unreviewed findings and gaps in `unreviewed` and `meta.incomplete`, and the exit code follows the gating profiles alone. A failed research part, the call or its reply, is its profile's own gap, `research-failed`, whether it gates or not, and the other parts and profiles go on; for a gating profile it exits `4`. The CLI runs the profiles its config selects, and by default the security profile alone, which gates.

A result records each profile's level in `meta.profiles.<id>.failOn`, and `gating` beside it, true unless the level is `none`. A program that runs other profiles reads `failOn` there, or calls `outcome`, which applies the rule of the CLI's exit code: [`outcome`](../95-reference/30-library-api.md#outcome).

## Guidelines

Guidelines are reference text for one profile: a project's conventions, what it counts as a problem. A profile's `doNotReport` is reference text for what its research does not report. A program sets both as the profile's own text, a config names files for them, and a review can add the repository's own ([Documents](../95-reference/30-library-api.md#documents)). [Rules and guidelines](./45-rules-and-guidelines.md) says how each is read, cleaned, capped and sent, and what it costs.

A profile's `rules` are review rules, criteria with an id that a finding cites when the code breaks one, and `requireRule` makes the profile report only what a rule asks for. A program sets the profile's own `rules`, a config writes them inline or names files of them, in the config or the repository, and `builtInRules: false` drops those of a built-in profile it starts from. Each research request carries the rules that apply to the change, and code checks every citation: [Review rules](./45-rules-and-guidelines.md#review-rules) has the shape, the files, the caps and the checks.

- **The model reads them as criteria.** The [data notice](./60-prompts.md#the-data-notice) describes the guidelines block in these words: "the project's review guidelines. Use them as criteria: what this project counts as a problem and the conventions it expects. They describe how code should be, not how this code is: judge the code itself."
- **They are still data.** They are fenced like the diff, never part of the system message, and text in them that asks to skip or approve without checking falls under the same notice, which tells the model to treat it as suspicious and report it as its own finding rather than comply.

Write guidelines as criteria (`` `any` is acceptable in test helpers ``), not as orders (`` don't flag `any` ``). Whoever writes the guidelines steers the review, and fencing is friction, not a control, so load them from a source the change under review cannot edit, such as the base branch, never the pull request's checkout:

```ts
import { execFileSync } from 'node:child_process'
import { securityProfile } from '@tobi-or-not/quorum'

// The base branch's copy, which the pull request under review cannot change.
const guidelines = execFileSync('git', ['show', 'origin/main:REVIEW.md'], { encoding: 'utf8' })
const security = { ...securityProfile, guidelines }
```

## Next

[Rules and guidelines](./45-rules-and-guidelines.md) — how a config names guidelines and do-not-report text as files, what each request carries of them, their caps and what they cost.
