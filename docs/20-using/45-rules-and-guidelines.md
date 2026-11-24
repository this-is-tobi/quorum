# Rules and guidelines

A review judges a change by what its profile asks for, and a project can say more: the conventions it expects, and what it does not want reported. quorum reads that policy as documents, texts a person wrote, and a profile takes them from its config as files, or from the repository the change is in, at a commit quorum chooses and the change cannot. This page covers what a document is, how a config names one, how a file of the repository is read and from which commit, the flag a change raises when it edits one, what every request carries of it, the caps and the cleaner, what `--print-config` shows, and what they cost.

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

## Naming a file of the repository

A project often keeps its policy in its repository, a `REVIEW.md` say, and a pull request can edit it. A `{ repository }` entry names such a file by its path from the repository's top level, and quorum reads it from a commit the review's source names, never from the change under review:

```yaml
profiles:
  security:
    guidelines:
    - repository: REVIEW.md
    doNotReport:
    - repository: .github/review-skip.md
      optional: true
```

It takes the same two fields, under the same names, as `{ file }`, for any profile, a built-in one included, and the two forms mix in one list.

- **The path** is relative to the top level of the repository, whatever directory quorum runs in, `/`-separated, with no empty, `.` or `..` segment, and at most 4096 characters. Anything else is refused when the config is read, at the entry's `repository`: `must be a path of the repository: relative to its top level, /-separated, with no empty, . or .. segment, and at most 4096 characters`.
- **`optional: true`** lets the commit lack the file: the review goes on, and `meta.context` records the document as `missing`, with no bytes. Without it a file the commit lacks is a configuration error. It excuses an absent file alone: a link, a submodule or a file over 64 KiB is refused whether it is optional or not.
- **The order is fixed by the kind of entry.** A profile's texts of a kind are joined as its own text, then its `{ file }` documents in the order they are listed, then its `{ repository }` documents in theirs, each pair separated by a blank line.
- **The caps are the files'.** A repository document is cleaned and capped as a file is, 16 KiB of guidelines and 8 KiB of do-not-report text, counted in all with the profile's own text and its `{ file }` documents: [The caps and the cleaner](#the-caps-and-the-cleaner).
- **The result records it.** `meta.context` holds one record for it, with `origin: 'repository'`, its `path`, the full `commit` it was read at and the SHA-256 of its text, and no text: [The context](../95-reference/20-json-result.md#the-context).

### The commit a document is read from

The policy that judges a change never comes from that change. A pull request controls every file of its branch, `REVIEW.md` included, so a review that read the head's copy, or the working tree's, would let a change write the rules it is judged by: a guideline that calls its own code allowed, or a do-not-report line that hides it. quorum reads the document from the commit its source names:

| The source | The commit |
| --- | --- |
| `--range <base>...<head>` | The range's base, the commit `<base>` names: the project as it was before the change |
| `--path <path>`, with `--at <rev>` or without | The commit the review reads, `--at`'s, else `HEAD`: a path review is a codebase and not a change, so its documents are the codebase's |
| `--local`, `--staged` | `HEAD`, never the working tree or the index. Before a repository's first commit there is none, and the entry is refused |
| A diff file, standard input | None: the entry is refused, since a diff names no commit |

The change's own edit of the file is in the diff, to be reviewed as code, and reaches no request as policy. The core checks each document against the commit its review's source names, so a program that hands over a document read at another commit is refused: [Documents](../95-reference/30-library-api.md#documents).

### One read, and every message

Once the source is read, and before any call, quorum lists the commit's tree once, keeping the paths the profiles name, and reads the files it keeps in one more call, with its own git and the protections of every git source ([Sources](./15-sources.md)): it reads no working tree, and hands git an id it has checked, never a path or a revision. A file two profiles name is read once. Every entry is checked, and every problem is reported at once, exit `2`, each at its entry's `repository` path, with `<path>` the path as JSON, cut at 100 characters, and `<short id>` the first 7 characters of the commit:

```text
Error: profiles.security.guidelines.0.repository: "REVIEW.md" needs a commit to read it from, which a diff file or standard input does not name: review with --range, --local, --staged or --path, or name the file with { file }
```

| Message | Means |
| --- | --- |
| `<path> needs a commit to read it from, which a diff file or standard input does not name: review with --range, --local, --staged or --path, or name the file with { file }` | The source is a diff file or standard input |
| `<path> needs a commit to read it from, and the repository has none yet: make a first commit, or name the file with { file }` | `--local` or `--staged` in a repository with no commit |
| `<path> is not a file of the commit <short id> the review reads it from` | The commit has no such path, or it is a directory, and the entry is not optional |
| `<path> is a symbolic link at <short id>, which quorum does not follow` | The path is a link, optional or not |
| `<path> is a submodule's commit at <short id>, which quorum does not read` | The path is a submodule, optional or not |
| `<path> is not UTF-8 text at <short id>` | The file does not decode as UTF-8, or holds a NUL byte among its first 8000, which is what git itself counts as binary |
| `<path> holds <n> bytes at <short id>, over the 64 KiB quorum reads of a document` | The file is over 64 KiB, which is known from the listing, before it is read |
| `<path> at <short id> holds 17020 bytes once cleaned, over the 16 KiB a guidelines document may hold` | The file is over a cap once cleaned; the messages of [the caps](#the-caps-and-the-cleaner), the in-all one and the unsettled one included, follow the path and the commit |

A program that builds the quorum itself reads the documents with `readContext` and passes the result to `estimate` and `review`: [`readContext`](../95-reference/30-library-api.md#readcontext). One that does not is refused, before any call, at each entry it skipped: `profiles.security.guidelines.0.repository: "REVIEW.md" was not read for this review: pass the context readContext reads to the estimate and the review`.

### A commit you do not trust

A repository document is as trusted as the commit it is read from. The base of a pull request is a commit the project already merged, and `HEAD` of your own clone is yours; a commit that a stranger, or an agent working in the project, can write is not. Under a git hook, an agent can write `HEAD`, so a config that runs there names `{ file }` documents kept outside the project instead, as the server's config is kept: [Git hooks](../90-recipes/30-git-hooks.md), [Claude Code](../90-recipes/20-claude-code.md). `quorum mcp` refuses a `{ repository }` document for the same reason ([The MCP server](./90-mcp.md#starting-it)), and `quorum bench` refuses one because a case is a patch with no commit ([Running a bench](./70-bench.md#running-a-bench)).

## When the change edits a document

A pull request can edit the very file its review reads as policy, or rename, copy, add or delete it. The review never obeys that edit: it reads the document at the commit its source names, so the change's text reaches no request as policy. It does not say nothing about it either. A change that touches the path of a `{ repository }` document raises an advisory `guideline-edited` flag, naming the profile and the commit the review read instead, so a person looks at what the change did to the file:

```text
flag: guideline-edited at "REVIEW.md" for security (the guidelines this review read for the profile from 1f3a9c2, not the change's version)
```

- **What raises it.** A section of the diff, the whole diff, so a file `exclude` leaves out or a file held back as a secret counts, that edits the path, renames or copies a file onto it, adds it or deletes it. The section names the path when its own path, a word of its `diff --git` header or a path its `---`, `+++`, `rename` or `copy` lines write is the document's path, as written or once a one-character prefix and its slash (`a/`, `b/`, `i/`, `w/`) are dropped. Those lines are read with no hunk parsing, so the flag may also be raised for a section whose hunk holds a line that reads like one of them: it fails closed.
- **One flag per profile and path.** Two profiles that read `REVIEW.md` each get a flag, and a profile that reads one path as its guidelines and as its do-not-report text gets one flag that names both kinds, `the guidelines and do-not-report text this review read ...`. The flag is at the first section that names the path.
- **Its fields.** `code`, the `profile`, and `file`, the section's own path, which is absent for a section whose header names no path quorum can read. It has no `line`: [A flag](../95-reference/20-json-result.md#a-flag).
- **Its detail is quorum's words,** never a line of the file or of the diff: `the guidelines this review read for the profile from 1f3a9c2, not the change's version`, with `guidelines`, `do-not-report text` or both in place of the kind, and the commit's first 7 characters. For an optional document the commit lacked, which a change that adds the file hits, it reads `the guidelines this review looked for at 1f3a9c2 and did not find, not the change's version`.
- **The change's version is never applied.** The flag changes no verdict, no gap and no exit code, and the edited file is read by no request: it is in the diff, reviewed as code. To adopt an edit, merge it, and the next review reads it from its new base. The flag is a hint for a person, and the commit the review reads from is the control: [The commit a document is read from](#the-commit-a-document-is-read-from).
- **When it is not raised.** A path review (`--path`) raises none: its documents are the codebase's own, read at the commit it reviews, and a file of that name is the input, not a change to it. A `{ file }` document is no file of the repository, so a change cannot edit it. A section that names another path, `REVIEW.md.bak` or `docs/REVIEW.md` for a document `REVIEW.md`, raises none, nor does a review with no `{ repository }` document.

It is in `meta.flags`, after the diff's flags, in a `flag` event, and in the `flag:` line before the stages, so the log, the text report and the Markdown summary each show it with its profile: [Advisory flags](../30-security/30-output-handling.md#advisory-flags).

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

[`--print-config`](./10-cli.md#printing-the-resolved-config) prints each document as the SHA-256 of its text as read, never the text, a built-in profile's own text as `builtIn`, and a `{ repository }` entry as its path, with `optional: true` when it is, each at its place in the list:

```text
profiles:
  naming:
    prompts:
      research: sha256:8d48c37e…
      vote: sha256:10b0e7f4…
    guidelines:
      - sha256:ec3b5f71…
      - repository: REVIEW.md
      - sha256:3f2a0c6d…
    doNotReport:
      - builtIn: sha256:13ddc203…
      - sha256:35fcffa9…
      - repository: .github/review-skip.md
        optional: true
```

The hashes are cut here; the output holds all 64 hexadecimal digits of each.

- **The hash is of the text as read,** before cleaning, in UTF-8: `sha256sum` of the file gives the same hex, a byte-order mark aside (the decoder drops one), so a job can compare it with the hash of the file on the base branch.
- **A repository file has no hash to print,** since quorum reads it from a commit only when a review runs: `--print-config` reads no diff and runs no git, so it prints the path.
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

A document is part of a configuration's [fingerprint](./70-bench.md#the-fingerprint), its text and hash, so `quorum bench` measures the effect of a guideline: the same suite under the same configuration with and without it is two configurations, and another text is another one. A configuration with no document keeps the fingerprint it had. A `{ repository }` document is refused, since a bench case is a patch with no commit to read a file from: name the file with `{ file }`, and the bench measures it.

## Next

[Lenses and policy](./50-lenses-and-policy.md) — the panel's questions, the rules that turn kept votes into a confidence, failed votes, and what a confidence level means.
