# Profiles

A profile is what a review looks for, as data: the finder's instructions, the panel's lenses and how their votes are graded, whether its findings gate, and optional guidelines. The CLI runs the `security` profile. A program can run it, change it, write a profile of its own, and run several in one review. This page covers the security profile, writing a profile and the checks it must pass, several profiles at once, gating, and guidelines.

## The security profile

`securityProfile`, exported by `src/index.ts`, is the default and the one the CLI runs:

| Field | Value |
| --- | --- |
| `id` | `security` |
| `prompts` | The finder's instructions and the vote template, quoted on [Prompts](./60-prompts.md#the-security-profiles-templates) |
| `lenses` | `reachability`, `impact` and `defenses`, below |
| `policy` | `{ high: 'unanimous', medium: 'majority', low: 'off' }`: 3 of 3 kept votes is `high`, 2 of 3 is `medium` |
| `gating` | `true` |
| `guidelines` | None |

| Lens | Question |
| --- | --- |
| `reachability` | Is this sink actually reachable from untrusted input in normal flow - not just syntactically present? |
| `impact` | If reached, is the impact real - not just bad-looking code? |
| `defenses` | Do existing checks elsewhere already neutralize this? |

The sink these questions name is the code the vulnerability ends in, which the finder is asked to quote. The vote template calls each lens a refutation angle and tells the voter to default to `keep=false` unless genuinely convinced: [Lenses and policy](./50-lenses-and-policy.md#lenses) says why there are three.

The profile is frozen, down to each lens, so an assignment to it throws a `TypeError` in strict-mode code, which every ES module is, and a change made for one review cannot leak into the next. Spread it into a new object instead:

```ts
import { securityProfile } from './src/index.ts'

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
| `gating` | `boolean` | Optional, `true` when unset |
| `guidelines` | `string` | Optional: [Guidelines](#guidelines) |

The reply the finder must give is fixed, whatever the profile: a `findings` array whose every entry holds `file`, `line` (a line of the new file), `category`, `quote` (the code, copied verbatim from the diff) and `summary`. The system message carries that schema, but your research instructions should say what each field means for what you review, as the security profile's do.

A naming review that reports but never gates:

```ts
import type { Profile } from './src/index.ts'

export const naming: Profile = {
  id: 'naming',
  prompts: {
    research: 'Review this diff for names that mislead: a function, variable or type whose name says something its code does not do. For each, give the file and the new-file line number, copy the code verbatim from the diff, without the leading +/- marker, into `quote`, name the kind of problem in `category`, and say in `summary` what the name promises and what the code does.',
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
  gating: false,
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
| `<id>.gating` | `must be true or false` |
| `<id>.guidelines` | `must be a string` |

A template gets one line per distinct variable it may not use, in the order they first appear, and a blank one gets `must not be empty` alone. The checks read the shape first, so a program without types that passes a malformed profile gets these lines, never a `TypeError`.

### Warnings

A profile the checks accept may still set something that cannot take full effect. `createQuorum` lists such settings in the quorum's `warnings`, each starting at the profile id, and runs anyway:

| Warning | Means |
| --- | --- |
| `<id>.policy.<level> needs the same <n> vote(s) as policy.<higher level> with <k> lens(es), so it never applies` | Two enabled levels need the same number of kept votes, so the lower one is never reached |
| `<id>.prompts.vote uses neither {{lens.id}} nor {{lens.question}}, so every lens gets the same instructions` | With more than one lens, a vote template that names neither asks every voter the same thing |

The default policy meets the first with one or two lenses: the `naming` profile above, with its policy left unset, would get `naming.policy.medium needs the same 2 vote(s) as policy.high with 2 lens(es), so it never applies`. The CLI prints no warnings, and the security profile has none.

## Several profiles in one review

```ts
import { createQuorum, openaiCompatible, securityProfile } from './src/index.ts'
import { naming } from './naming.ts'

const local = openaiCompatible({ id: 'local', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.6:27b' })
const quorum = createQuorum({ profiles: [securityProfile, naming] }, {
  profiles: {
    security: { research: local, voters: { reachability: local, impact: local, defenses: local } },
    naming: { research: local, voters: { meaning: local, reader: local } },
  },
})
```

- **One pass each.** Every profile runs research, dedup and its panel on its own, all profiles at once: one research call per profile, then its own votes.
- **One concurrency limit.** `concurrency` (4 by default) caps the provider calls in flight across every profile of the review.
- **Every finding is tagged with its profile**, and its `id` hashes the profile too, so a line two profiles flag is two findings with two ids, each judged by its own panel.
- **Nothing is merged across profiles.** No request of one profile holds another profile's output. In each list of the result, a profile's verdicts follow the previous profile's, in the order of `profiles`, and `meta.profiles` has one entry per profile.
- **One failure stops them all.** A profile whose research call or reply fails ends the whole review: [Abort](../95-reference/30-library-api.md#abort).

The cost grows with each profile: one more research call, and one call per lens for each of its findings.

## Gating

`gating`, `true` when unset, says whether a profile's kept `high` findings set exit code `1`. The CLI exits `1` when a kept finding is `high` and its profile's `meta.profiles.<id>.gating` is not `false`; a profile missing from `meta` counts as gating, so a gap in a result never hides a finding. Otherwise it exits `4` when the review is incomplete, and `0` when it is not.

A profile with `gating: false` still reports every finding in full, and its gaps still make the review incomplete: only a `high` finding of its own no longer exits `1`. The CLI runs the security profile alone, which gates. A program that runs other profiles reads each one's `gating` in `meta` to apply the same rule.

## Guidelines

Guidelines are reference text for one profile: a project's conventions, what it counts as a problem. Quorum reads no guidelines file of its own: a program loads the text and sets it as the profile's `guidelines`. The CLI sets none.

- **They are fenced as data**, one more block at the end of the user message of every request of the profile, the research call and every vote, when the text is not blank. They are never part of the system message.
- **The model reads them as criteria.** The [data notice](./60-prompts.md#the-data-notice) describes the block in these words: "the project's review guidelines. Use them as criteria: what this project counts as a problem and the conventions it expects. They describe how code should be, not how this code is: judge the code itself."
- **They are still data.** Text in them that asks to skip or approve without checking falls under the same notice as the diff, which tells the model to treat it as suspicious and report it as its own finding rather than comply.

Write guidelines as criteria (`` `any` is acceptable in test helpers ``), not as orders (`` don't flag `any` ``). Whoever writes the guidelines steers the review, and fencing is friction, not a control, so load them from a source the change under review cannot edit, such as the base branch, never the pull request's checkout:

```ts
import { execFileSync } from 'node:child_process'
import { securityProfile } from './src/index.ts'

// The base branch's copy, which the pull request under review cannot change.
const guidelines = execFileSync('git', ['show', 'origin/main:REVIEW.md'], { encoding: 'utf8' })
const security = { ...securityProfile, guidelines }
```

## Next

[Lenses and policy](./50-lenses-and-policy.md) — the panel's questions, the rules that turn kept votes into a confidence, failed votes, and what a confidence level means.
