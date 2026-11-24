# Rules and guidelines

A review judges a change by what its profile asks for, and a project can say more: the conventions it expects, and what it does not want reported. quorum reads that policy as documents, texts a person wrote, and a profile takes them from its config as files. This page covers what a document is, how a config names one, what every request carries of it, the caps and the cleaner, what `--print-config` shows, and what they cost.

## What a document is

A document is a text a review reads as policy, in one of two kinds:

| Kind | A model reads it as | Field |
| --- | --- | --- |
| `guidelines` | The criteria to judge by: what this project counts as a problem and the conventions it expects | `guidelines` |
| `do-not-report` | What the finder is told not to report | `doNotReport` |

A profile holds its own text of each kind, which a program sets ([Profiles](./40-profiles.md#guidelines)), and the documents its configuration names. Each is cleaned and capped by the core, and recorded in the result's `meta.context` by its hash and counts, never its text: [The context](../95-reference/20-json-result.md#the-context).

## Naming a file in a config

A profile entry of the config takes a list of `{ file }` entries under `guidelines` and `doNotReport`, whatever the profile is: one of your own, or the entry of a built-in profile, `security` included:

```yaml
profiles:
  naming:
    prompts:
      research:
        file: ./prompts/naming.md
      vote: |
        One vote in a {{panel.size}}-voter panel on a naming finding. Lens: {{lens.id}}.
        {{lens.question}}
        Judge only from the blocks you receive. Default keep=false unless convinced.
    lenses:
    - id: meaning
      question: Does the name say something the code does not do?
    guidelines:
    - file: ./guidelines/naming.md
    - file: ./guidelines/errors.md
    doNotReport:
    - file: ./guidelines/skip.md
```

- **A file is read when the config loads,** as a prompt file is: relative to the directory of the config file, whatever the working directory is (an absolute path stays absolute), as UTF-8 text of at most 64 KiB. Each distinct path is read once, however many entries and profiles name it, and the distinct prompt and document files of a config hold 1 MiB in all.
- **A config file holds no text of its own.** A YAML or JSON config names a file, so a long text is a file a person reviews as one. A TS or JS config names files the same way, and a program that loaded a text itself gives `fromConfig` `{ text }` in place of `{ file }`: [`ConfigInput`](../95-reference/30-library-api.md#config-types).
- **At most 16 entries** a field, and the order is the order of the list: the profile's own text, then its documents in the order they are listed, joined by a blank line.
- **A file that cannot be read is a configuration error,** exit `2`, before any call, at the entry's file path: `review.yaml: profiles.security.guidelines.0.file: is over 64 KiB`. A file that does not exist, is not a file, is over 64 KiB or is not UTF-8 text is refused the same way, and every one is reported at once.
- **A file is as trusted as the config.** In CI a document comes from the base branch, never from the pull request's checkout, as a prompt file does: [Trust](./20-configuration.md#trust).

## What each request carries

- **The guidelines go in every request of the profile,** the research call and every vote, as one more fenced block at the end of the user message, after the diff. The voters judge by the criteria the finder judged by: a vote that did not know them would discard what the project allows and keep what it forbids.
- **The do-not-report text goes in the research request alone,** in the system message right after the profile's instructions, as a paragraph that starts with the code-owned line `This review does not report:`. It tells the finder what to leave out, and no vote carries it, so a text that tries to bend a verdict never reaches the vote that decides one: [The layout of a request](./60-prompts.md#the-layout-of-a-request).
- **A document is data, and no template.** A `{{` in one is text, and the data notice describes the guidelines block as criteria, with the same warning as for the diff: [The data notice](./60-prompts.md#the-data-notice).

A profile with no document sends the requests it sent before, byte for byte.

## The caps and the cleaner

The core cleans each document before it counts it: the hidden characters, the HTML comments and the numeric character references go, so a model reads no instruction hidden in one of those three kinds. It removes those three and no other Markdown a renderer hides: a link reference definition (`[//]: # (a note)`) passes untouched, so read a document you did not write in its source. It also removes joiners and variation selectors whose effect a reader sees (ZWJ, ZWNJ and U+FE0F, in Persian or Hindi text and emoji), so an honest document can read "the cleaner removed ..." on its line. [Prose a review reads as policy](../30-security/30-output-handling.md#prose-a-review-reads-as-policy) says what it removes and why. The caps apply to the cleaned text, in UTF-8 bytes, so hidden text counts toward none:

| What | Cap |
| --- | --- |
| A guidelines document, and a profile's guidelines in all | 16 KiB (16,384 bytes) |
| A do-not-report document, and a profile's do-not-report text in all | 8 KiB (8,192 bytes) |
| A file as read, before it is cleaned | 64 KiB (65,536 bytes) |
| The entries of one field | 16 |

The profile's own text of a kind, and a built-in profile's, count first toward the cap of all of them. A document over a cap is refused, never cut, at its entry, with no text in the message:

| Path and message | Means |
| --- | --- |
| `profiles.security.guidelines.0: holds 17020 bytes once cleaned, over the 16 KiB a guidelines document may hold` | One document over its cap once cleaned (8 KiB for a `doNotReport` one) |
| `profiles.security.guidelines.3: takes the profile's guidelines to 18000 bytes once cleaned, over the 16 KiB they may hold in all` | The first document that takes the profile over the cap of all of them (`takes the profile's do-not-report text to <n> bytes once cleaned, over the 8 KiB it may hold in all`) |
| `profiles.security.guidelines.0: nests HTML comments or character references too deep to clean in 16 passes: remove them` | A text the cleaner still changes after 16 passes, so it cannot say what a reader sees |
| `profiles.security.guidelines: must hold at most 16 documents` | More than 16 entries |

## `builtInDoNotReport`

A built-in profile can carry a do-not-report text of its own, and a profile that starts from it keeps that text ahead of the documents the config names, counted in the same 8 KiB. `builtInDoNotReport: false` drops it:

```yaml
profiles:
  security:
    builtInDoNotReport: false
    doNotReport:
    - file: ./guidelines/skip.md
```

`true` is the default. No built-in profile carries a do-not-report text yet, so the field changes nothing for the security profile today.

## What `--print-config` shows

[`--print-config`](./10-cli.md#printing-the-resolved-config) prints each document as the SHA-256 of its text as read, never the text, and a built-in profile's own text as `builtIn`:

```text
profiles:
  naming:
    prompts:
      research: sha256:8d48c37e…
      vote: sha256:10b0e7f4…
    guidelines:
      - sha256:ec3b5f71…
      - sha256:3f2a0c6d…
    doNotReport:
      - builtIn: sha256:13ddc203…
      - sha256:35fcffa9…
```

The hashes are cut here; the output holds all 64 hexadecimal digits of each.

- **The hash is of the text as read,** before cleaning, in UTF-8: `sha256sum` of the file gives the same hex, a byte-order mark aside (the decoder drops one), so a job can compare it with the hash of the file on the base branch.
- **A list is left out when empty,** so a config with no document prints as it did before documents.
- **The rooms count the documents.** The `budgets` it prints already leave out what the guidelines and the do-not-report text take of the window: [Room accounting](./20-configuration.md#room-accounting).

## What they cost

A profile's guidelines are in every research request and every vote, and its do-not-report text in every research request, so a long guideline raises the reservation of every call, the estimate and the cap that follows it. What a guideline of 4 KiB and one of 16 KiB cost a path review of 137 research parts, on a window of 248000 tokens with `thinking: low` and `partTokens: 16000`, counted as the estimate counts them (`1.36M` is 1365607 floored):

| The guideline | Each request reserves | `expected` (research) | `worst`, the derived cap | Reserved at once |
| --- | --- | --- | --- | --- |
| None | | 1.36M | 168M | 297k |
| 4 KiB | 4.40k more | 1.56M (201k more) | 190M (21.9M more) | 314k |
| 16 KiB | 16.6k more | 2.12M (762k more) | 251M (83.1M more) | 363k |

A reservation counts one token per byte, while English prose takes about four bytes a token, so a guideline of 4 KiB costs about 1.04k tokens in each call it is in, a quarter of what a request reserves for it. `expected` counts research at a third of its bound and no vote, so it shows about a fifth of a guideline's real cost, and `worst`, which the cap follows, is a bound, not a spend. The estimate's line for the profile says what its documents add to each request, and the summary's tokens line what the review spent: [The token cap](./20-configuration.md#the-token-cap). Guidelines that leave a window no room for a hunk are refused when the profile is created, before any call: [Room accounting](./20-configuration.md#room-accounting).

## In a bench

A document is part of a configuration's [fingerprint](./70-bench.md#the-fingerprint), its text and hash, so `quorum bench` measures the effect of a guideline: the same suite under the same configuration with and without it is two configurations, and another text is another one. A configuration with no document keeps the fingerprint it had.

## Next

[Lenses and policy](./50-lenses-and-policy.md) — the panel's questions, the rules that turn kept votes into a confidence, failed votes, and what a confidence level means.
