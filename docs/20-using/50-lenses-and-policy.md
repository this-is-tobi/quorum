# Lenses and policy

The panel is where a finding is judged. Its lenses say what each voter is asked, and the profile's policy says how many kept votes each confidence level needs. This page covers lenses, the policy rules and their checks, how a confidence is computed, what a failed vote does, and what a confidence level means and does not.

## Lenses

A lens is an id and a question:

```ts
const lens = { id: 'reachability', question: 'Is this sink actually reachable from untrusted input in normal flow - not just syntactically present?' }
```

- **One vote per lens per finding.** Every finding that reaches the panel goes to every lens of the profile, each through the provider its ports name for that lens, so a finding costs one call per lens.
- **Blind.** Each vote request is built only from the finding, the lens's rendered instructions, the diff context and the profile's guidelines: no request carries another vote, its verdict or its reasoning, and the votes of one finding are requested together, none waiting for another's answer.
- **The question reaches the voter** through the vote template's `{{lens.question}}`, and the lens id through `{{lens.id}}`: [Templates](./60-prompts.md#templates).

The security profile has three lenses, reachability, impact and defenses, each an angle from which the finding may not hold. Three is not a round number waiting for more: self-consistency research shows most of the gain of repeated sampling arriving by roughly five to ten samples on a capable model, while each vote costs one more call per finding and running them in parallel has a real latency cost, so three differently angled votes are close to the cost-effective floor. Three is also the fewest lenses with which the default policy has a level below unanimity: 2 of 3.

## Policy rules

A policy gives one rule for each level, `high`, `medium` and `low`, and each rule resolves to the number of kept votes the level needs, its threshold, once the lens count `n` is known:

| Rule | Threshold with `n` lenses |
| --- | --- |
| `'unanimous'` | `n` |
| `'majority'` | More than half: `n` halved and rounded down, plus 1 |
| `'any'` | 1 |
| `'off'` or `false` | None: the level is disabled |
| `{ minVotes: k }` | `k`, an integer from 1 to `n` |
| `{ minRatio: r }` | `r` times `n`, rounded up, and at least 1; `r` is greater than 0 and at most 1 |

```ts
import type { PolicyRules } from '@tobi-or-not/quorum'

const policy: PolicyRules = {
  high: 'unanimous',
  medium: { minRatio: 0.5 },
  low: 'off'
}
```

A profile without a policy gets `defaultPolicy`, exported by `@tobi-or-not/quorum`: `{ high: 'unanimous', medium: 'majority', low: 'off' }`. It resolves this way:

| Lenses | `high` | `medium` |
| --- | --- | --- |
| 1 | 1 | 1, never reached: a warning |
| 2 | 2 | 2, never reached: a warning |
| 3 | 3 | 2 |
| 4 | 4 | 3 |
| 5 | 5 | 3 |

`meta.profiles.<id>.policy` records the thresholds a review used, `null` for a disabled level.

### Validation

Each of these is an issue of the `ConfigError` that `createQuorum` throws, at the path of the level, here with three lenses:

| Message | Cause |
| --- | --- |
| `expected unanimous, majority, any, off, { minVotes } or { minRatio }` | The rule is none of these, or the level is missing |
| `minVotes must be an integer between 1 and 3` | `minVotes` is not an integer from 1 to the lens count |
| `minRatio must be a number greater than 0 and at most 1` | `minRatio` is out of range |
| `a rule holds either minVotes or minRatio, not both` | The rule names both |
| `needs 3 votes, more than policy.high (2)` | A level needs more kept votes than an enabled level above it |
| `at least one confidence level must be enabled` | Every level is `off`, at the path `<id>.policy` |

The levels are compared in order, `high`, then `medium`, then `low`, skipping a disabled one. A level that needs exactly as many votes as the enabled level above it can never be reached, since the higher one wins: that is a warning, not an issue, because the default policy does it with one or two lenses.

## Confidence

A finding's confidence is the highest level whose threshold its kept votes reach: `high` first, then `medium`, then `low`. A verdict that reaches a level is **kept** at that level. One that reaches none has no confidence, and is **discarded** or **unreviewed**, by its failed votes.

No model has a say in it. The vote reply is `{ keep, reasoning }` with no confidence field, and anything else a voter writes is dropped, so a 2 of 3 split is `medium` under the security profile however certain each voter sounded.

## Failed votes

A vote fails when its call fails or its reply is unusable, or when its provider refuses the request as too large for its model. It is recorded with its error and counts as a reject, but a discard never rests on it:

- **Unreviewed.** When the finding reaches no level, quorum counts its failed votes as if they had been keeps. If that would reach an enabled level, the outcome was never decided: the finding is `unreviewed`, neither kept nor cleared.
- **Kept, with a gap.** When a kept finding's failed votes, counted as keeps, would reach a higher level than the one it earned, it stays kept at its level, and a `vote-failed` entry in `meta.incomplete` records that the gate between the two levels rested on a vote never cast.

Both make the review incomplete: for a gating profile, the CLI exits `4`, unless a gating profile kept a `high` finding. A vote refused as too large counts as any failed vote, and its finding also records a `request-too-large` gap whatever its status (kept, discarded or `unreviewed`), which `--allow-incomplete` does not lift for a gating profile: a pull request can cause it by padding the diff. The flag lifts every other gap, including gaps a pull request can cause, such as text that trips a hosted voter's content filter and fails the vote. On a gating profile, do not use it for a pull request you do not trust. Under the security profile:

| Kept | Rejected | Failed | Verdict |
| --- | --- | --- | --- |
| 3 | 0 | 0 | Kept, `high` |
| 2 | 1 | 0 | Kept, `medium` |
| 2 | 0 | 1 | Kept, `medium`, and a `vote-failed` gap: it could have been `high` |
| 1 | 2 | 0 | Discarded |
| 1 | 1 | 1 | Unreviewed: one more keep would reach `medium` |
| 1 | 0 | 2 | Unreviewed |
| 0 | 3 | 0 | Discarded |
| 0 | 2 | 1 | Discarded: one more keep would still reach no level |
| 0 | 1 | 2 | Unreviewed |
| 0 | 0 | 3 | Unreviewed |

A review cut by its abort signal records no failed vote: it rejects instead, as [Abort](../95-reference/30-library-api.md#abort) says.

## What a confidence level means

A level is a procedural fact: under the profile's policy, that many lenses kept the finding, each judging from its own request, which holds the finding, its evidence and the diff, never another vote. With the security profile, `high` means all three lenses kept it, and `medium` that two did.

It is not a probability, and the votes are not statistically independent judgments. Voters blind to each other reason independently, but voters on one model share its failure modes: three lenses on one model are probably worth one or two votes. A provider per lens reduces variance, and nothing shows that it stops a tuned attack. The panel filters false positives; it cannot restore a finding the finder never proposed. The [Threat model](../30-security/10-threat-model.md#independence) has the evidence behind this.

## Next

[Prompts](./60-prompts.md) — the layout of every request, the templates and their variables, the notices, and what is not configurable and why.
