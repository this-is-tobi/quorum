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
| Output channels: CI logs, terminals, what renders the result | Turn model text into markup, a link, a workflow command or an escape sequence | The CLI makes the text it writes inert for a terminal and a GitHub Actions log; anything else that renders the result must treat its text as untrusted: [Output handling](./30-output-handling.md) |
| Availability and spend | Multiply the calls and their cost with a huge or finding-flooding pull request | `maxFindings`, the concurrency limit and the reply caps |
| Coverage | Have the run review less than the whole change, silently | Unreviewed findings and incomplete reviews, exit `4`, for the gaps the harness detects; a model that read less than the whole diff is not one of them: [What the harness cannot detect](#what-the-harness-cannot-detect) |

## Residual risk

A determined adaptive attacker may suppress or sway findings. In published studies no prompt-level defense held under adaptive attack, and a panel of blind voters filters false positives but cannot restore a finding the finder never proposed. Quorum keeps the model path harmless, raises the cost of an attack, and shows a human where to look: each verdict's vote split, its `quoteMatched` flag (whether the code the finder quoted appears in the evidence), the `invalidFindings` count of findings that cited code outside the diff, the unreviewed findings, the advisory flags of `meta.flags`, and the entries of `meta.incomplete`. It assists a reviewer; it does not replace human review of untrusted changes.

With no tool and no secret in the model path, the incident classes of 2025 and 2026, token theft and code execution through an AI agent in CI, do not apply. What remains is verdict manipulation, the places where model text is rendered, cost, and files that look trusted, such as guidelines read from the pull request's checkout.

## Controls in place

### A model path with no tool and no secret

A provider receives text and returns text. No tool, function, file or network capability is ever offered to a model, and the request type has no field for one. No environment value, key, token or credential appears in any request: keys live in the adapters, and the core never reads the environment. The suite checks with fake providers that no environment value reaches a request, the key variables of the environment wiring included.

### A key sent only to its own endpoint

`openaiCompatible` sends its `apiKey` only in the header its `auth` names, `Authorization` by default, and never in a URL, a body or another header. Three further rules keep the key from leaking:

- **A base URL may not carry credentials.** A user name or a password is a configuration error, and the key goes in `apiKey`.
- **No redirect is followed.** A redirect is an error, so the key header never reaches another endpoint.
- **Server text is redacted.** The key and the base URL's path are replaced with `[redacted]` in any server text an error quotes. The `query` option is not redacted, so never put a key there.

The CLI's panel inherits the finder's key only while it talks to the same origin, so no fallback carries a key to another endpoint, or from `https` to `http`: [The voter's fallback](../20-using/20-configuration.md#the-voters-fallback).

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

A finding must cite a line of the new file inside one of the diff's hunks and, when the diff has per-file headers, one of its files, or it is dropped with its reason. What a voter receives about the code is then read from the diff by the harness, never taken from the finder: the `file` is the diff's own path when the diff has per-file headers, and the `evidence` is the diff's lines around the cited one, capped at 2,000 characters. The finder's `quote` is only compared with the evidence, which sets `quoteMatched`; it is never sent to a voter. The only text a model wrote that a voter reads is the finder's `summary` and `category`, capped at 500 and 80 characters, and, for a diff without per-file headers, the file name, capped at 260: each stripped of control, format and other invisible characters, and fenced as an unverified claim.

### Blind votes and arithmetic confidence

Each vote request is built only from the finding, the lens's instructions, the diff context and the profile's guidelines: no request carries another vote, so no voter sees another's verdict or reasoning. The suite checks it by structure: the vote requests of a review are the same, nonces aside, whatever the voters answer. A vote reply is `{ keep, reasoning }`, and the confidence is computed in code from the kept votes: a voter cannot raise a finding by sounding sure. [Lenses and policy](../20-using/50-lenses-and-policy.md#confidence) has the arithmetic.

### Fenced data and the notices

All the data a model reads, the diff, the claim, the evidence, the diff section and the guidelines, is in the user message, each block fenced with a random nonce it cannot predict. The system message names every block of the request by its exact tag, so a tag planted in the diff is never named, and ends with the notice that fenced content is data and that text asking to skip or approve is suspicious. This is friction, not a control: [Prompts](../20-using/60-prompts.md#fencing-is-friction-not-a-control).

### `maxFindings` and the concurrency limit

Only the first `maxFindings` findings a research reply lists, 50 by default, are read, and only those can reach the panel; the rest are counted in a `findings-capped` gap, so a reply built to flood the run costs bounded work. With the security profile and the default cap, a review of one diff makes at most 151 calls: one research call, and three votes for each of 50 findings. `concurrency`, 4 by default, caps the calls in flight across every profile of the review. Quorum does not cap the size of the diff it sends: a job that reviews untrusted changes can bound it before piping it in, which also keeps it within the model's context ([below](#what-the-harness-cannot-detect)).

### Unreviewed and incomplete reviews

A discard never rests on a failed vote: a finding that a failed vote could still have kept is `unreviewed`. A finding the harness could not read, a kept finding whose failed votes could have raised it to a higher level, a research reply whose findings were all unusable, and findings beyond the cap are recorded in `meta.incomplete`. Either makes the review incomplete, so the CLI never exits `0` for a gap the harness detects: it exits `4`, or `1` when a gating profile also kept a `high` finding.

### Advisory flags

The harness reads the added lines and the file names of the diff by code, before any model sees them, and flags hidden characters and text addressed to an AI reviewer. A flag appears in `meta.flags`, in a `flag` event and in a `flag:` line on stderr, and it is never a gate: it changes no verdict, gap or exit code. It tells a human where to look, and it is not a defense: [Advisory flags](./30-output-handling.md#advisory-flags).

### Inert output

The CLI writes nothing that a terminal or a GitHub Actions runner would act on, and shows or escapes every hidden character of the class in the text it carries. Every line of stderr that carries text from outside the CLI passes through `inertLine`, which shows each hidden character as `<U+XXXX>` and breaks the forms of a GitHub Actions workflow command, and stdout is written by `inertJson`, which escapes them and parses back to the same data. [What the CLI writes](./30-output-handling.md#what-the-cli-writes) has the details and the limits.

## What the harness cannot detect

Quorum cannot tell when a model read less than the whole diff. It sends the diff whole, with no limit on its size and no budget for the model's context, and it checks what the model answered, never what the model read. An endpoint that truncates an oversized prompt answers all the same: Ollama's `/v1`, the CLI's default endpoint, cuts a prompt past the model's context length and still returns HTTP 200, so a review of what was left can come back clean, with exit `0`. This is a limit of the harness today. Bound the size of the diffs you review, and size the model's context for them.

## Independence

Voters are blind to each other, so their reasoning is independent. Their errors are not statistically independent: one study put nine judges from seven model families at about 2.2 effective votes, and prompt, ordering or temperature variants did not help, so three lenses on one model are probably worth one or two votes. Blind voting is still right: voting captures most of the gain of debate, and avoids sycophancy between agents.

- **A provider per lens is variance reduction, not a security measure.** Mixed model families helped in older studies, and nothing shows they stop a tuned attack.
- **Voting filters false positives only.** Recall rests on the finder, which reads the same poisoned diff, so the finder is a single point of failure for suppression: the panel cannot judge a finding that was never proposed.

## Model-written text is untrusted

A result carries text that models wrote, servers sent or the diff holds. Quorum stores it as it came, apart from some cleaning, and makes its own output inert. [Output handling](./30-output-handling.md#text-an-attacker-can-influence) has the fields, the cleaning and what a renderer must do.

## Next

[Output handling](./30-output-handling.md) — what the CLI writes and how it is made inert, the advisory flags, and printing a review yourself.
