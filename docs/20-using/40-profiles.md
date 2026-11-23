# Profiles

A profile is what a review looks for, as data: the finder's instructions, the panel's lenses and how their votes are graded, the level at which its findings fail the review, and optional guidelines. The CLI runs the `security` profile by default, and the profiles its config selects. A program can run it, change it, write a profile of its own, and run several in one review. This page covers the security profile, writing a profile and the checks it must pass, several profiles at once, gating, and guidelines.

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
| `<id>.prompts.research` | `{{diff}} is not allowed: the diff is appended automatically as fenced data`, or `{{file}} is not allowed: the research template takes no variables` |
| `<id>.prompts.vote` | `{{lens.name}} is not allowed: the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}` |
| `<id>.failOn` | `must be one of high, medium, low or none` |
| `<id>.gating` | `must be true or false`, or `is deprecated and cannot be set with failOn: remove it` |
| `<id>.guidelines` | `must be a string` |

A template gets one line per distinct variable it may not use, in the order they first appear, and a blank one gets `must not be empty` alone. The checks read the shape first, so a program without types that passes a malformed profile gets these lines, never a `TypeError`.

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

Guidelines are reference text for one profile: a project's conventions, what it counts as a problem. Quorum reads no guidelines file of its own: a program loads the text and sets it as the profile's `guidelines`. The CLI sets none.

- **They are fenced as data**, one more block at the end of the user message of every request of the profile, the research call and every vote, when the text is not blank. They are never part of the system message.
- **The model reads them as criteria.** The [data notice](./60-prompts.md#the-data-notice) describes the block in these words: "the project's review guidelines. Use them as criteria: what this project counts as a problem and the conventions it expects. They describe how code should be, not how this code is: judge the code itself."
- **They are still data.** Text in them that asks to skip or approve without checking falls under the same notice as the diff, which tells the model to treat it as suspicious and report it as its own finding rather than comply.

Write guidelines as criteria (`` `any` is acceptable in test helpers ``), not as orders (`` don't flag `any` ``). Whoever writes the guidelines steers the review, and fencing is friction, not a control, so load them from a source the change under review cannot edit, such as the base branch, never the pull request's checkout:

```ts
import { execFileSync } from 'node:child_process'
import { securityProfile } from '@tobi-or-not/quorum'

// The base branch's copy, which the pull request under review cannot change.
const guidelines = execFileSync('git', ['show', 'origin/main:REVIEW.md'], { encoding: 'utf8' })
const security = { ...securityProfile, guidelines }
```

## Next

[Lenses and policy](./50-lenses-and-policy.md) — the panel's questions, the rules that turn kept votes into a confidence, failed votes, and what a confidence level means.
