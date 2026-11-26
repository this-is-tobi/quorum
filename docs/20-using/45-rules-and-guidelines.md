# Rules and guidelines

A review judges a change by what its profile asks for, and a project can say more: the conventions it expects, what it does not want reported, and the rules a finding may cite. quorum reads that policy as documents, texts a person wrote, and a profile takes them from its config as text or files, or from the repository the change is in, at a commit quorum chooses and the change cannot. This page covers what a document is, how a config names one, how a file of the repository is read and from which commit, the flag a change raises when it edits one, what every request carries of it, the caps and the cleaner, review rules, what a person sees of the documents a review read, what `--print-config` shows, and what they cost.

## What a document is

A document is a text a review reads as policy, in one of three kinds:

| Kind | A model reads it as | Field |
| --- | --- | --- |
| `guidelines` | The criteria to judge by: what this project counts as a problem and the conventions it expects | `guidelines` |
| `do-not-report` | What the finder is told not to report | `doNotReport` |
| `rules` | The review rules a finding may cite by their ids: a list of rules, in place of a text | `rules`: [Review rules](#review-rules) |

A profile holds its own text of each prose kind, which a program sets ([Profiles](./40-profiles.md#guidelines)), and the documents its configuration names. Each is cleaned and capped by the core, and recorded in the result's `meta.context` by its hash and counts, never its text: [The context](../95-reference/20-json-result.md#the-context).

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

`true` is the default. The `code-review`, `best-practices` and `performance` profiles each carry one ([The built-in profiles](./40-profiles.md#the-built-in-profiles)); the security profile carries none, so the field changes nothing for it.

## Review rules

A review rule is a criterion a finding may cite by its id: `no-any`, say, with the text `No any outside tests.` A profile that lists rules sends each research request the ones that apply to the change, asks every finding for the id of the rule it breaks, and checks that id by code. A config gives a profile rules three ways, in one `rules` list, whatever the profile is: one of your own, or the entry of a built-in profile, `security` included.

```yaml
profiles:
  team:
    extends: security
    rules:
    - id: no-any
      text: No any outside tests.
      paths: [src/**, lib/**]
    - file: ./rules/license.yaml
    - repository: .quorum/rules.yaml
      optional: true
    requireRule: true
```

A rule has the shape of a `ReviewRule` ([the library page](../95-reference/30-library-api.md#documents)):

| Field | Holds |
| --- | --- |
| `id` | Matches `^[a-z][a-z0-9._-]{0,63}$`, and is unique across every rule of the profile, the built-in profile's included |
| `text` | 1 to 1,024 characters once cleaned, as a guideline is cleaned |
| `paths` | Optional, 1 to 20 path patterns in the syntax of [`exclude`](./20-configuration.md#excludes): the rule applies when a file of the change matches one of them, and to every file when there are none |

- **A rule written in the config** is an entry of `rules` with its `id`, its `text` and its `paths`, and nothing else: an unknown key is an issue at the entry. It is a document of its own, with no hash, since the config is the only place it exists.
- **`{ file }`** names a rules file, read when the config loads as a guideline file is: relative to the directory of the config file, at most 64 KiB, the distinct files 1 MiB in all with the prompt and document files, and as trusted as the config ([Trust](./20-configuration.md#trust)). Its extension says its format: `.yaml` and `.yml` are YAML, `.json` is JSON, and any other extension (the case of a letter counts) is refused before the file is read, at the entry's file path: `review.yaml: profiles.team.rules.1.file: must end in .yaml, .yml or .json`.
- **`{ repository, optional? }`** names a rules file of the repository, read at the commit the review's source names and never from the change, as a repository guideline is: [Naming a file of the repository](#naming-a-file-of-the-repository), with the same `optional`, the same refusals and the same `guideline-edited` flag when a change edits the file. It is read when the review runs, by the same extension rule, so a `.quorum/rules.yaml` of the base branch is the project's rules and a pull request cannot change them. The messages of [One read, and every message](#one-read-and-every-message) apply, and a rules file adds its own below.
- **At most 100 rules** in all, of at most 16 entries that name a file, `{ file }` or `{ repository }`, and the order is the order of the list: the built-in profile's own rules, then the entries in the order they are written, then the repository's files, each file's rules in the order it holds them.

### A rules file

A rules file is a list of rules, read as a config file is: YAML 1.2 or JSON, no alias, no tag, no repeated key, and a strict shape, every rule an object of `id`, `text` and `paths` and nothing else:

```yaml
- id: license
  text: Each file starts with the license header.
- id: io-errors
  text: Every I/O call handles its error.
  paths: [src/**]
```

- **A file that is not valid is refused at the entry,** in the parser's own words or as `<n>.<field> <problem>` for the rule at position `<n>` of the file, counted from 0, and no message holds a word of the file: `profiles.team.rules.0: 3.id must match ^[a-z][a-z0-9._-]{0,63}$`. A file that is no list reads `must be a list of rules`, and a key that is not a safe name is never repeated.
- **A file with no rule is no problem.** A file that holds `[]`, or nothing at all (a YAML file of comments alone, an empty file, or white space alone in JSON), reads as a list of no rules, as an empty guidelines file reads as no text and `rules: []` in the config lists none: a `{ file }` and a `{ repository }` entry, optional or not, take it, `meta.context` records it with `rules: 0`, and `--print-config` prints it with `ids: []`. A profile that sets `requireRule` and lists no rule at all sends none, and asks its finder nothing ([The citation](./60-prompts.md#the-citation)).
- **Each rule is checked as every rule is,** by the one check a program's rules pass too: the id's pattern, the text's length once cleaned (a text of hidden characters is blank), the patterns, the caps below, and ids unique across the profile. The first rule that repeats an id or takes a cap over is the one told, at the entry that wrote it: `profiles.team.rules.1: 0.id repeats the rule id "no-any"`, or `profiles.team.rules.3.id: repeats the rule id "no-any"` for a rule written in the config.
- **A repository file is checked the same way when the review runs,** before any call, each message at the entry's `repository` path and after the file's path and the commit's first 7 characters: `profiles.team.rules.2.repository: ".quorum/rules.yaml" at 1f3a9c2 repeats the rule id "no-any"`. A file over the 32 KiB alone is told there too, with the profile's own rules and its config's counted first, and so is one that makes the profile hold more than 100 rules.
- **The hash is of the text as read,** as for a guideline: `--print-config` prints it with the ids a file holds, and `meta.context` records it.

### `builtInRules` and `requireRule`

- **`builtInRules: false`** drops the rules of the built-in profile this one starts from. By default they come first, counted in the same caps, and an id of the config that repeats one of theirs is refused. A profile with no built-in profile has none to drop. `best-practices` lists four rules and `performance` six ([The built-in profiles](./40-profiles.md#the-built-in-profiles)); the security and `code-review` profiles list none, so the field changes nothing for them.
- **`requireRule: true`** makes the profile report only what a rule asks for: a finding that cites no rule, or whose citation fails its check, is dropped and counted in `invalidRules`. `false` is the default, and the built-in profile's own value holds unless the entry sets one. With no rule sent for a change, such a profile asks its finder nothing: [The citation](./60-prompts.md#the-citation).

### Which rules a review sends, and the citation

Each research request carries the rules whose `paths` match a file of the change, and every rule with none, in a block after the diff; a change researched in parts sends the same block in every part. A profile that lists any rule, sent or not, asks each finding for a sixth field, `rule`. Once a finding is anchored, code checks that its trimmed `rule` names a rule this review sent whose `paths` match the finding's file: a citation that holds stays as the rule's own id, and its votes read that rule alone; any other is dropped, with its finding when the profile requires a rule. A refusal never holds what the finder cited, and a wrong citation sends no reply again: [Review rules](./60-prompts.md#review-rules) has the block, the notice and the reasons.

### The limits

| What | Limit |
| --- | --- |
| The rules of a profile, whatever their origin | 100 |
| The entries of `rules` that name a file | 16 |
| A rule's text | 1,024 characters once cleaned |
| The patterns of a rule | 20 |
| The cleaned texts of a profile's rules in all | 32 KiB (32,768 bytes) |
| A rules file as read, before it is cleaned | 64 KiB (65,536 bytes) |

| Path and message | Means |
| --- | --- |
| `profiles.team.rules: must hold at most 100 rules` | More than 100 entries, or files that make more than 100 rules in all |
| `profiles.team.rules: must hold at most 16 rules files` | More than 16 entries name a file |
| `profiles.team.rules.1.id: must match ^[a-z][a-z0-9._-]{0,63}$` | A rule written in the config has an id that is no id |
| `profiles.team.rules.0.text: must hold 1 to 1024 characters once cleaned` | A text that is blank or too long once cleaned (`0.text must hold ...` for a rule of a file) |
| `profiles.team.rules.1: takes the profile's rules to 33000 bytes once cleaned, over the 32 KiB they may hold in all` | The first rule that takes the cleaned texts of the profile over the cap, the built-in profile's own counted first |

Rules are never split into groups. A profile whose rules, beside its guidelines and do-not-report text, leave a research provider less than 1,024 tokens of diff is refused before any call, and the message names the tokens the rules take: at the full 56 KiB of documents, a window under about 80,000 tokens. Every research request carries the whole block of the rules it sends, so a profile whose rules do not fit beside a hunk would need a request for each group of them, and a change's findings would no longer come from one pass over each part. The fix is shorter rules, a larger window, or two profiles that each hold part of the rules, which a config already lets you write: [Room accounting](./20-configuration.md#room-accounting).

## What a person sees of the documents

A review records each document it read in `meta.context` and says so, one line for each, so a person sees which policy it judged by, where each document came from and what the cleaner changed. The line is one sentence, written once, which the log, the text report and the Markdown summary each use:

```text
context: security guidelines "docs/threat-model.md" at 1f3a9c2, 1830 bytes
context: naming guidelines from a file, sha256 3f2a9c1d0b7e, 4100 bytes; the cleaner removed 3 hidden character(s) and 1 comment(s)
context: naming do-not-report text "REVIEW-skip.md" at 1f3a9c2: missing, and optional
context: naming rules from a file, sha256 8d48c37e1a02, 4 rule(s)
```

The figures here are an example: a line holds the counts of its own review. A line has these parts, in this order:

| Part | Reads |
| --- | --- |
| `context: <profile> <kind>` | The profile's id, then `guidelines`, `do-not-report text` or `rules`. Every profile with a document has its lines, a built-in one included |
| Where it came from | `of the profile` for the text a program set on the profile. `from a file, sha256 <12 hex>` for a document of the config, with the first 12 hexadecimal digits of the SHA-256 of its text as read, which [`--print-config`](#what---print-config-shows) prints whole. `<path> at <short id>` for a `{ repository }` document: its path as JSON, cut at 100 characters, and the first 7 characters of the commit it was read at. `written in the config` for a text the config holds with no hash |
| Its size | `, <bytes> bytes`: the UTF-8 bytes of the cleaned text as sent, an integer, so a person compares it with [the caps](#the-caps-and-the-cleaner). A rules document has `, <k> rule(s)` in its place, the number of rules it holds, since its entries are no text to count in bytes. An optional document its commit lacks is `: missing, and optional`, with no bytes |
| What the cleaner removed | `; the cleaner removed <c> hidden character(s), <m> comment(s) and <e> character reference(s)`, only the counts above 0, joined by `, ` and ` and `. A document with nothing removed has no such clause. The counts are what the reader removed and what the core removed again: [Prose a review reads as policy](../30-security/30-output-handling.md#prose-a-review-reads-as-policy) |

A line holds ids, a hash's first digits, a path, a commit's first characters and counts: never a word of the document, whatever it says. It is inert, as every line is, so a path with a hidden character shows it as `<U+XXXX>`.

Where the lines are:

- **The log, before the stages.** Plain mode and the live view's log write one line for each document, once, right after the `left out:` line and before the research starts, in the order `meta.context` holds them: each profile's guidelines, then its do-not-report text, then its rules, each in the order they are joined, followed by one line for each profile that lists or requires a rule ([What a person sees of the rules](#what-a-person-sees-of-the-rules)). They come from the `context` event, start with no `[<id>] `, since a line names its profile itself, and carry no glyph. `--view public` writes the same lines. A review with no document writes none. `--progress json` writes the event as it is: [Events](../95-reference/30-library-api.md#events).
- **The text report,** after the profiles' lines and before the files left out, one line for each record of `meta.context`, in the same words, wrapped at 80 columns as a flag's detail is: the head, which holds the path, the hash or the commit, stays whole on one line, and what follows wraps at spaces. `quorum report` writes them from a saved result, since the result holds the records: [The context](../95-reference/20-json-result.md#the-context).
- **The summary,** after the `calls:` line, one line for each profile that has a document: the bytes of each kind of text it read, the rules it sent of those it lists, the optional documents missing and how many documents the cleaner removed text from. A kind it read none of, and a count of 0, are left out:

  ```text
  context: security: guidelines 1830 bytes
  context: naming: guidelines 4100 bytes, 1 optional document(s) missing, hidden text removed from 1
  context: team: guidelines 4100 bytes, rules 3 of 5 sent
  ```

- **The Markdown summary** lists them under `#### Documents read`, after the flags, each as an item in the same words with its path, its commit and its hash in code spans, the first 20 and then how many more, the first cut when the summary is over its budget: [The summary](./80-reports.md#the-summary).

SARIF holds no document, and the payload holds them only in its summary, as the Markdown summary does: a document is no result and no comment.

## What a person sees of the rules

A rule is read in four places: on a finding that cites it, on the line of the profile that sent it, in the log before the stages, and in the summary. The figures in the examples are illustrative: a line holds the counts of its own review.

**A finding's rule.** A finding that cites a rule its review sent, and whose citation held ([The citation](./60-prompts.md#the-citation)), names it by its id, the one the configuration gives the rule, never the finder's text. A finding that cites none, or whose citation failed its check, names none, and a profile that lists no rule and requires none writes no rules words anywhere. Each report writes it where it writes the finding's category:

| Report | Reads |
| --- | --- |
| The text report | `MEDIUM  naming  src/api/users.ts:40  test_gap  rule tests-for-new-code`: the head of the finding ends with two spaces and `rule <id>` |
| The Markdown summary | ``- **MEDIUM** naming · `src/api/users.ts` line 40 · `test_gap` · rule `tests-for-new-code` · kept by 2 of 3 lenses``: after the category, the id in a code span |
| A line comment | ``**MEDIUM** naming · `test_gap` · rule `tests-for-new-code` · kept by 2 of 3 lenses``: the summary's words, in the body of the comment the Action posts |
| SARIF | `MEDIUM, kept by 2 of 3 lenses. test_gap, rule tests-for-new-code: <claim>`: `, rule <id>` after the category in the message of the result, whose `ruleId` stays `quorum/<profile>` |
| The MCP result | `rule` in the finding, after its `fingerprint` and before its `category`: a code-checked field, so `--code-fields-only` keeps it |
| The JSON result | `rule` in the finding, absent when it cites none |

**A profile's rules.** The text report ends a profile's line with the rules it sent and the citations that failed, and wraps it at 80 columns after `<id> (fail-on <level>):`:

```text
naming (fail-on none): 1 kept, 0 unreviewed, 2 discarded; rules: 3 of 5 sent, 1
  citation(s) refused
  3 of 3 files reviewed
```

`rules: <sent> of <listed> sent` says how many of the profile's rules the review sent, those whose `paths` match a file of the change and those with none. `, <k> citation(s) refused` follows when `<k>`, `invalidRules`, is above 0: the findings whose `rule` named no rule this review sent whose `paths` match their file, and, in a profile that requires a rule, the findings that cited none. A refused citation is counted apart from `, <n> outside the diff`, the findings that cite code the diff does not hold. The MCP result carries the same count as the profile's `invalidRules`. A profile that lists no rule has neither clause, unless it requires one, as the next paragraph says.

**A profile that asked nothing.** A profile that requires a rule (`requireRule`) and was sent none asks its finder nothing, whether it lists none or lists rules that apply to no file of the change: its parts read as reviewed, so its line would read `0 kept` and its files `reviewed`, as a review that found nothing does. The reports say what happened, on the profile's line, from `meta.profiles.<id>.asksNothing`, which is `true` for such a profile and absent for every other:

```text
strict (fail-on high): 0 kept, 0 unreviewed, 0 discarded; rules: 0 of 0 sent,
  so its research asks nothing
  3 of 3 files reviewed
```

The same clause ends the rules part of the summary's context line (`context: strict: rules 0 of 0 sent, so its research asks nothing`, a line of its own when the profile has no document), the profile's coverage cell in the Markdown summary and so in the Action's comment (`3 of 3 files reviewed; rules 0 of 0 sent, so its research asks nothing`), and the profile's entry in the MCP result (`asksNothing: true`, kept under `--code-fields-only`). `quorum report` writes it from a saved result, since the result holds it. A profile that lists no rule and requires none writes no rules words anywhere.

**The log.** Plain mode and the live view's log write, right after the documents' lines and before the research starts, one line for each profile that lists a rule or requires one, and a line for each citation that fails:

```text
context: naming rules: 3 of 5 sent
context: naming rules: 0 of 5 sent, so its research asks nothing
rule citation refused: "src/a.ts":40 cites no rule this review sent
```

- **`context: <profile> rules: <sent> of <listed> sent`** is written once per profile, from the `context` event, with no `[<id>] ` and no glyph, under `--view public` too. A profile that sends none of its rules, and does not require one, still asks its research, and the line says nothing more.
- **`, so its research asks nothing`** ends the line of a profile that requires a rule and sends none for this change: its finder is never asked, since every finding it could report would be dropped for want of a rule, and its parts read as reviewed. `0 of 0 sent` is the line of a profile that requires a rule and lists none: it reports nothing, and the line is how a person sees why. `parts: 0` in the profile's `stage:start` says it to a program.
- **`rule citation refused: <reason>`** is written once for each citation that fails its check, whether the finding goes on with no rule or, in a profile that requires one, is dropped with it. The reason names the finding's file as JSON and its line, `"src/a.ts":40 cites no rule this review sent` or `"src/a.ts":40 cites no rule, which the profile requires`, and never the rule the finder cited. Under `--view public` it is `rule citation refused`, with no reason, as a dropped finding's line is. In a review of several profiles it starts with `[<id>] `. The count is the profile's `invalidRules`.

**The summary.** The context line of a profile that lists a rule adds `rules <sent> of <listed> sent`, after the kinds of text it read and before the optional documents missing: `context: naming: guidelines 4100 bytes, rules 3 of 5 sent`. A profile with rules and no text reads `context: naming: rules 3 of 5 sent`, and one that asked nothing ends the part with `, so its research asks nothing`.

## What `--print-config` shows

[`--print-config`](./10-cli.md#printing-the-resolved-config) prints each document as the SHA-256 of its text as read, never the text, a built-in profile's own text as `builtIn`, and a `{ repository }` entry as its path, with `optional: true` when it is, each at its place in the list. A profile's rules print as ids, never a text: a rule written in the config as its id, a rules file as the hash of its text and the ids it holds, a built-in profile's own rules as `builtIn` with their ids, a `{ repository }` file as its path, then `builtInRules: false` and `requireRule: true` when the profile sets them (a profile that sets `builtInRules: false` has no `builtIn` rules to print, so the example below sets `requireRule` alone):

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
    rules:
      - builtIn:
          - license
      - no-any
      - sha256: 6a1d09c4…
        ids:
          - io-errors
          - naming
      - repository: .quorum/rules.yaml
    requireRule: true
```

The hashes are cut here; the output holds all 64 hexadecimal digits of each.

- **The hash is of the text as read,** before cleaning, in UTF-8: `sha256sum` of the file gives the same hex, a byte-order mark aside (the decoder drops one), so a job can compare it with the hash of the file on the base branch.
- **A repository file has no hash to print,** since quorum reads it from a commit only when a review runs: `--print-config` reads no diff and runs no git, so it prints the path.
- **A list is left out when empty,** so a config with no document prints as it did before documents.
- **The rooms count the documents.** The `budgets` it prints already leave out what the guidelines and the do-not-report text take of the window: [Room accounting](./20-configuration.md#room-accounting).

## What they cost

A profile's guidelines are in every research request and every vote, and its do-not-report text in every research request, so a long guideline raises the reservation of every call, the estimate and the cap that follows it. What a guideline of 4 KiB and one of 16 KiB cost a path review of 172 research parts, whose finding cap is 688, four per part, on a window of 248000 tokens with `thinking: low` and `partTokens: 16000`, counted as the estimate counts them (`1.71M` is 1712225 floored):

| The guideline | Each request reserves | `expected` (research) | `worst`, the derived cap | Reserved at once |
| --- | --- | --- | --- | --- |
| None | | 1.71M | 459M | 315k |
| 4 KiB | 4.40k more | 1.96M (252k more) | 500M (41.0M more) | 332k |
| 16 KiB | 16.6k more | 2.66M (956k more) | 614M (155M more) | 382k |

A reservation counts one token per byte, while English prose takes about four bytes a token, so a guideline of 4 KiB costs about 1.04k tokens in each call it is in, a quarter of what a request reserves for it. `expected` counts research at a third of its bound and no vote, so it shows about a fifth of a guideline's real cost, and `worst`, which the cap follows, is a bound, not a spend. The estimate's line for the profile says what its documents add to each request, and the summary's tokens line what the review spent: [The token cap](./20-configuration.md#the-token-cap). Guidelines that leave a window no room for a hunk are refused when the profile is created, before any call: [Room accounting](./20-configuration.md#room-accounting).

## In a bench

A document is part of a configuration's [fingerprint](./70-bench.md#the-fingerprint), its text and hash, so `quorum bench` measures the effect of a guideline: the same suite under the same configuration with and without it is two configurations, and another text is another one. So is a rule: its id, its text and its patterns are in the fingerprint, and `requireRule` with them, so the same suite with and without a rule, or with one more word in it, is two configurations. A configuration with no document and no rule keeps the fingerprint it had. A `{ repository }` document is refused, since a bench case is a patch with no commit to read a file from: name the file with `{ file }`, and the bench measures it.

## Next

[Lenses and policy](./50-lenses-and-policy.md) — the panel's questions, the rules that turn kept votes into a confidence, failed votes, and what a confidence level means.
