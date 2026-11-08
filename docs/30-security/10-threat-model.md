# Threat model

What an attacker can do to a review, what quorum protects, which controls stand in the way today, and what remains. Read it before you run quorum on changes you did not write: none of it is a setting to turn on, it is how quorum works.

## The attacker

Quorum feeds text an attacker controls to language models and reports what they answer. The attacker is anyone who can open a pull request, from a fork included, and they control the whole diff: its code, comments, strings and file names, and the commit messages a `git format-patch` series carries. They control every file of the pull request's branch too, so guidelines a caller loads from that branch's checkout are theirs as well.

What quorum answers goes to the JSON result on stdout and the lines on stderr, and from there to CI logs, terminals and whatever renders the result. It usually runs in CI, with a model API key in its environment.

## Assets

| Asset | The attacker wants to | What stands in the way |
| --- | --- | --- |
| Verdict integrity | Suppress a real finding, sway a verdict, or forge a finding | Code-derived evidence, strict parsing, blind votes and arithmetic confidence, within the limits of the [residual risk](#residual-risk) |
| Secrets: the model key, a CI token, repository credentials | Have a model read or leak them | A model path with no tool and no secret, and a key sent only to its own endpoint |
| Output channels: CI logs, terminals, what renders the result | Turn model text into markup, a link, a workflow command or an escape sequence | The renderer, which must treat model text as untrusted: [below](#model-written-text-is-untrusted) |
| Availability and spend | Multiply the calls and their cost with a huge or finding-flooding pull request | `maxFindings`, the concurrency limit and the reply caps |
| Coverage | Have the run review less than the whole change, silently | Unreviewed findings and incomplete reviews, exit `4` |

## Residual risk

A determined adaptive attacker may suppress or sway findings. In published studies no prompt-level defense held under adaptive attack, and a panel of blind voters filters false positives but cannot restore a finding the finder never proposed. Quorum keeps the model path harmless, raises the cost of an attack, and shows a human where to look: each verdict's vote split, its `quoteMatched` flag (whether the code the finder quoted appears in the evidence), the `invalidFindings` count of findings that cited code outside the diff, the unreviewed findings, and the entries of `meta.incomplete`. It assists a reviewer; it does not replace human review of untrusted changes.

With no tool and no secret in the model path, the incident classes of 2025 and 2026, token theft and code execution through an AI agent in CI, do not apply. What remains is verdict manipulation, the places where model text is rendered, cost, and files that look trusted, such as guidelines read from the pull request's checkout.

## Controls in place

### A model path with no tool and no secret

A provider receives text and returns text. No tool, function, file or network capability is ever offered to a model, and the request type has no field for one. No environment value, key, token or credential appears in any request: keys live in the adapters, and the core never reads the environment. The suite checks with fake providers that no environment value reaches a request, the key variables of the environment wiring included.

### A key sent only to its own endpoint

`openaiCompatible` sends a key only in the `Authorization` header of its own endpoint, never in a URL or a body, and replaces it with `[redacted]` in any server text it quotes in an error. The CLI's panel inherits the finder's key only while it talks to the same origin, so no fallback carries a key to another endpoint, or from `https` to `http`: [The voter's fallback](../20-using/20-configuration.md#the-voters-fallback).

### Strict single-object parsing

Every reply must hold exactly one JSON object, and quorum fails closed instead of guessing:

- A reply holding several different objects is refused: text echoed from the diff could pose as the answer. The same object twice, such as a fenced copy beside a prose copy, is accepted.
- A group that opens like a JSON object, `{` then `"` or the end of the reply, but never closes or does not parse, fails the reply: it is cut off or malformed, and an object quoted inside it or echoed beside it could be planted.
- An object that repeats a key is refused, since parsing keeps the last value and planted text that closes a string early could supply it.
- Text after the answer that reads like JSON syntax, a quote, a brace or a bracket, fails the reply: it is what the model's own continuation leaves when planted text closed a string and the object early. Plain prose after the answer, and code fence markers, are accepted.
- Closed reasoning blocks (`<think>`) are dropped in one linear pass, and an object that starts after a `<think>` that never closes is a draft, never read as the answer.
- A reply over 1,000,000 characters is refused before it is read, and one with more than 100 brace groups is refused as it is scanned, so a reply built to be expensive stays cheap.

The research reply must then be exactly `{ "findings": [...] }`: a missing array, or any other top-level key, fails the profile, so a malformed reply never reads as "no findings" (exit `3`). A finding that does not match the schema, or holds an object or array under a key the schema does not name, where swallowed findings would hide, is unreadable: a `finding-unreadable` gap. An unusable vote is a failed vote.

The trailing-syntax rule works only where the model's continuation is written: an endpoint that enforces JSON stops generating when the root object closes, so there a planted early close leaves nothing to refuse.

### Code-derived evidence and the quote check

A finding must cite a file of the diff and a line of the new file inside one of its hunks, or it is dropped with its reason. What a voter receives about the code is then read from the diff by the harness, never taken from the finder: the `file` is the diff's own path when the diff has per-file headers, and the `evidence` is the diff's lines around the cited one, capped at 2,000 characters. The finder's `quote` is only compared with the evidence, which sets `quoteMatched`; it is never sent to a voter. The finder's `summary` and `category` are the only text a model wrote that a voter reads: stripped of control, format and other invisible characters, capped at 500 and 80 characters, and fenced as an unverified claim.

### Blind votes and arithmetic confidence

Each vote request is built only from the finding, the lens's instructions, the diff context and the profile's guidelines: no request carries another vote, so no voter sees another's verdict or reasoning. The suite checks it by structure: the vote requests of a review are the same, nonces aside, whatever the voters answer. A vote reply is `{ keep, reasoning }`, and the confidence is computed in code from the kept votes: a voter cannot raise a finding by sounding sure. [Lenses and policy](../20-using/50-lenses-and-policy.md#confidence) has the arithmetic.

### Fenced data and the notices

All the data a model reads, the diff, the claim, the evidence, the diff section and the guidelines, is in the user message, each block fenced with a random nonce it cannot predict. The system message names every block of the request by its exact tag, so a tag planted in the diff is never named, and ends with the notice that fenced content is data and that text asking to skip or approve is suspicious. This is friction, not a control: [Prompts](../20-using/60-prompts.md#fencing-is-friction-not-a-control).

### `maxFindings` and the concurrency limit

Only the first `maxFindings` findings a research reply lists, 50 by default, are read, and only those can reach the panel; the rest are counted in a `findings-capped` gap, so a reply built to flood the run costs bounded work. With the security profile and the default cap, a review of one diff makes at most 151 calls: one research call, and three votes for each of 50 findings. `concurrency`, 4 by default, caps the calls in flight across every profile of the review. Quorum does not cap the size of the diff it sends: a job that reviews untrusted changes can bound it before piping it in.

### Unreviewed and incomplete reviews

A discard never rests on a failed vote: a finding that a failed vote could still have kept is `unreviewed`. A finding the harness could not read, a kept finding whose failed votes could have raised it to a higher level, a research reply whose findings were all unusable, and findings beyond the cap are recorded in `meta.incomplete`. Either makes the review incomplete, which the CLI never exits `0` for: it exits `4`, or `1` when a gating profile also kept a `high` finding. A review that did not cover the whole change never reads as clean.

## Independence

Voters are blind to each other, so their reasoning is independent. Their errors are not statistically independent: one study put nine judges from seven model families at about 2.2 effective votes, and prompt, ordering or temperature variants did not help, so three lenses on one model are probably worth one or two votes. Blind voting is still right: voting captures most of the gain of debate, and avoids sycophancy between agents.

- **A provider per lens is variance reduction, not a security measure.** Mixed model families helped in older studies, and nothing shows they stop a tuned attack.
- **Voting filters false positives only.** Recall rests on the finder, which reads the same poisoned diff, so the finder is a single point of failure for suppression: the panel cannot judge a finding that was never proposed.

## Model-written text is untrusted

A result carries text that models wrote while reading a change an attacker may have written:

| Field | Written by | Before it reaches the result |
| --- | --- | --- |
| `summary`, `category` | The finder | Stripped of control, format and other invisible characters, and capped |
| `votes[].vote.reasoning` | A voter | Nothing: as the voter wrote it |
| `votes[].error`, and the CLI's `Error:` line | The provider, or the core when a reply is unusable | The server text or reply they quote is a JSON string, cut short; a provider of your own writes its messages as it likes |
| `file` | The pull request, which named the file | The diff's own path, which can hold any character a file name can; for a diff without per-file headers, the finder's name for it, cleaned |

The JSON on stdout stays valid whatever these fields hold: it escapes their quotes, backslashes and control characters. The CLI's own lines carry file names cleaned or as JSON strings, and server text as JSON strings, so a line break cannot start a workflow command in a log. Whatever renders the result elsewhere, a pull request comment, a web page or a terminal, must treat these fields as untrusted input: escape them for its format, and never follow a link, a mention or a command found in them.

## Next

[Glossary](../95-reference/10-glossary.md) — the words these pages use in one particular way, and the acronyms they assume.
