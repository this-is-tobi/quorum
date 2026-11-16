# The JSON result

What a review returns: the JSON the CLI prints on stdout, and the object `review` resolves with. It holds three lists of verdicts and `meta`. Every field below is listed in the order it is written, which is the order of its keys in the JSON. The CLI writes it with `inertJson`: a hidden character in a string is written as a `\uXXXX` escape, which a JSON parser reads back as the character. `quorum bench` keeps a result in each line of its `results.jsonl`, written with `inertJsonLine`, which escapes the same characters on one line.

## The top level

| Field | Type | Holds |
| --- | --- | --- |
| `kept` | verdict[] | The findings whose kept votes reach a confidence level |
| `discarded` | verdict[] | The findings that reached none, and whose failed votes could not have changed that |
| `unreviewed` | verdict[] | The findings that reached none while their failed votes could have lifted them to a level: neither kept nor cleared |
| `meta` | object | What the review records about itself |

Each list keeps the order in which the finder listed its findings, the first profile's verdicts first, in the order of the review's profiles. [Failed votes](../20-using/50-lenses-and-policy.md#failed-votes) says which list a verdict lands in.

## A verdict

| Field | Type | Holds |
| --- | --- | --- |
| `id` | string | Names the finding, stable across runs: the first 12 hexadecimal characters of the SHA-256 of the JSON array `[profile, file, line, category]` |
| `profile` | string | The id of the profile that found it |
| `file` | string | The diff's own path for the cited file. For a diff without per-file headers, the finder's name for it, cleaned and capped at 260 characters |
| `line` | number | The cited line of the new file, inside a hunk of the diff |
| `category` | string | The finder's category, cleaned and capped at 80 characters; the security profile asks for a CWE |
| `summary` | string | The finder's claim, cleaned and capped at 500 characters |
| `evidence` | string | The diff's lines around `line`, up to two on each side within its hunk, each with its `+`, `-` or space marker, read from the diff by the harness and capped at 2,000 characters |
| `quoteMatched` | boolean | Whether the code the finder quoted appears in the evidence, once each evidence line's marker is removed and whitespace is collapsed on both sides; a quote that keeps its own `+` or `-` does not match. A measure of hallucinated citations |
| `keptVotes` | number | The votes that kept the finding |
| `totalVotes` | number | The votes asked for, one per lens, failed ones included |
| `confidence` | `"high"`, `"medium"` or `"low"` | The highest level the kept votes reach. A discarded or unreviewed verdict reached none: the JSON leaves the key out, and in the object `review` resolves with, the key is there with the value `undefined` |
| `votes` | vote[] | One per lens, in the profile's lens order |

Cleaned means stripped of control, format and other invisible characters, with whitespace collapsed to single spaces. A value cut at its cap ends with `…`. A trailing carriage return is removed from each evidence line.

### A vote

| Field | Type | Holds |
| --- | --- | --- |
| `angle` | string | The id of the lens the vote was cast from |
| `vote` | object or `null` | `keep`, a boolean, then `reasoning`, a string; `null` when the vote failed |
| `error` | string or `null` | `null`, or why the vote failed: the message of the error, such as `default: HTTP 503: "model is loading"`, or the text of anything else the provider threw |
| `failure` | object or `null` | `null` for a vote that was cast; else `kind`, what the vote failed with: a provider's kind (`http`, `network`, `timeout`, `refusal`, `truncated` and the rest: [`ProviderError`](../20-using/30-providers.md#providererror)), `token-cap` or `review-deadline` for a vote the review's token cap or its deadline stopped, `unusable-reply` for a reply the panel could not read, or `unknown`; and `status`, an `http` failure's HTTP status, when the provider stated one |

A failed vote counts as a reject. Its `failure` holds only what the code read, never a word of the server's or the model's, and it is what the CLI's `--allow-incomplete` reads to tell a vote that failed in passing from one a pull request can cause: [Exit codes](../20-using/10-cli.md#exit-codes).

## meta

| Field | Type | Holds |
| --- | --- | --- |
| `version` | string | The version of quorum that ran the review, from `package.json` |
| `startedAt` | string | When the review started, in ISO 8601 and UTC: `2026-11-08T02:04:20.361Z` |
| `durationMs` | number | How long it took, in whole milliseconds |
| `source` | object | Where the diff came from: [The source](#the-source) |
| `profiles` | object | One entry per profile, keyed by profile id, in the order of the review's profiles |
| `usage` | object | Only when at least one call reported valid counts: `inputTokens` and `outputTokens` summed over those calls, then `costUsd`, summed over the calls that reported one, when any did |
| `incomplete` | entry[] | The gaps of the review, profile by profile, each profile's gaps for the files left out first, then its `too-large` gap, then its research gaps, then its panel's, then its limits'. A review is complete when this list and `unreviewed` are both empty |
| `leftOut` | entry[] | Every file the review left out, once per file, reason and rule: the files its source left out before it made the diff first, then the diff's own in its order: [A file left out](#a-file-left-out). Empty when it left none out, a blank diff included |
| `flags` | flag[] | The advisory flags, the `secret-file` flags of the files left out first, in the order `leftOut` lists them, then those read from the diff, file by file in its order: [A flag](#a-flag). Empty when nothing was flagged, a blank diff included |

A usage count is valid when it is a finite number of at least 0. A failed call's usage counts too, when its reply reported valid counts, as a reply refused or cut off at its token limit does. `meta.usage` and each `invalidFindings` are counted from the review's own events, so `meta` and the events cannot disagree.

### Per profile

| Field | Type | Holds |
| --- | --- | --- |
| `providers` | object | `research`, the `{ id, model }` of the research provider, then `lenses`, the `{ id, model }` of each lens's provider, keyed by lens id |
| `policy` | object | `high`, `medium` and `low`: the kept votes each level needed, `null` for a level that is off |
| `gating` | boolean | Whether its kept `high` findings set exit code `1`, and its gaps exit code `4` |
| `invalidFindings` | number | How many findings it dropped for citing code outside the diff |
| `coverage` | entry[] | Every file of the diff once, in its order, with how much of it the profile's research reviewed: [Coverage](#coverage) |

### The source

`meta.source` says where the diff came from. A program that calls [`review`](./30-library-api.md#review) names the source it made the diff from, and a review given none records `{ "kind": "diff" }`. Its `kind` is one of five, and the other fields depend on it:

| `kind` | Other fields | Where the diff came from |
| --- | --- | --- |
| `diff` | None | A diff file or standard input, about which nothing more is known |
| `range` | `base`, `mergeBase`, `head`, `objectFormat` | The commits `base...head` of a git repository: `mergeBase` is the commit where their histories meet, which the diff starts from |
| `local`, `staged` | `head`, `objectFormat` | The local changes of a git repository, or only its staged ones, over the commit `head`; `head` is `null` before a first commit |
| `paths` | `commit`, `paths`, `skips`, `objectFormat` | The files under `paths` at `commit`: `paths` holds the normalized selections, `.` for the whole tree, and `skips` whether the default skips applied |

- **Every id is a full commit id**, never a revision as written: `base`, `mergeBase`, `head` and `commit` are 40 lowercase hexadecimal characters when `objectFormat` is `sha1`, and 64 when it is `sha256`.
- **It never holds a revision as written, a local file name or a git version.**
- **Later releases may add kinds**, a container image's say. A reader takes a kind it does not know as a source it cannot describe, never as an error, and goes on reading the rest of the result.

[Sources](../20-using/15-sources.md) says how each source makes its diff.

### Coverage

A review lists, for each profile, every file of the input diff once, in the diff's order, and how much of it that profile's research reviewed. A gap says that something was not reviewed and the coverage says what, so a reader can tell the files a model read from the lines it did not.

| Field | Type | Holds |
| --- | --- | --- |
| `file` | string | The diff's own path of the file, decoded from git's quoting, as in [A file left out](#a-file-left-out): `""` for a part of the diff that no header names |
| `status` | string | How much of the file was reviewed, below |
| `reason` | string | Why the file is unreviewed, below. The key is absent for any other status |
| `left` | range[] | The ranges of a partly reviewed file that were not reviewed, in the diff's order: `start` and `end`, new-file lines, both ends included, a hunk that only deletes lines at its start line, and the `reason` of each, below. The key is absent for any other status |

| `status` | What the profile's research reviewed of the file |
| --- | --- |
| `reviewed` | All of it |
| `partial` | Some of it: `left` lists the ranges that were not |
| `unreviewed` | None of it: `reason` says why |
| `excluded` | None of it, by choice: an `exclude` pattern leaves all of it out of every request, and it is no gap |

| `reason` | Why the file, or the range, was not reviewed |
| --- | --- |
| `binary` | The diff carries no content for the file, or the input's `leftOut` lists it as binary: [A file left out](#a-file-left-out). Its section is still sent, and the model reads nothing of the change |
| `submodule` | The diff carries only a submodule's commit, or the input's `leftOut` lists the file as one |
| `secret` | The file was held back as a secret, so no model was sent any of it: [A file left out](#a-file-left-out) |
| `deleted-secret` | The change deletes a file named as a secret, whole, so no model was sent it either, and it is no gap |
| `too-large` | The hunk, or a section with no hunk, fits in no research part of the profile's model's window: no part holds it, so no model read it. It is the `too-large` gap's |
| `request-too-large` | The provider refused the research part that held it as too large for its model, so it was not sent |
| `token-cap` | The review's token cap stopped the research part that held it, so it was not sent |
| `review-deadline` | The review's deadline stopped the research part that held it, in flight or not yet sent |
| `research-failed` | An advisory profile's research part that held it failed after its retries, or its reply was no findings envelope |

- **Reviewed means read by research.** A research request that carried the file's text was answered with a valid findings envelope, whatever it found. The votes read only what a finding cites.
- **A `binary` or `submodule` file is unreviewed** with that reason, though its section is sent, whatever became of its part. A `secret` or `deleted-secret` file is unreviewed with that reason too, and none of it is sent.
- **A file is `excluded`** when `exclude` left all of it out of the diff the research read.
- **Each profile has its own coverage**, since each has its own research model, with its own window and so its own parts.
- **A range is one hunk's lines, as a finding can cite them**, one range for each hunk left, not merged with a neighbour. A piece with no hunk adds no range, so a file of several sections, as a `format-patch` series has, can be `partial` with `left: []` when its only unread piece is a section with no hunk: the `too-large` gap, which counts it, is then the pointer.

A file name is the author's text, so print it as [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence) says.

### An incomplete entry

| Field | Type | Holds |
| --- | --- | --- |
| `profile` | string | The profile whose run has the gap |
| `reason` | string | One of the twelve [incomplete reasons](#incomplete-reasons) |
| `file` | string | The file of the finding the gap is about, when it is about one finding the harness could read: `vote-failed` has it, and so does a vote's `request-too-large` |
| `detail` | string | What is missing, in words |

### A file left out

| Field | Type | Holds |
| --- | --- | --- |
| `file` | string | The path of the file as the review names it. A file the diff lists is named by the diff's own path, as the `diff --git` header names it, decoded from git's quoting: the new path of a rename, the old one of a deletion. `""` for a part of the diff that no header names: the text before the first header, a diff without such headers, a section whose header names no path quorum reads, such as a rename under `--no-prefix`, and a submodule that git's `log` or `diff` format prints as a `Submodule` line. A readable header never names `""`, and no file of a change has an empty path, so the empty name is never a file's. A part of the diff with no path is never excluded. A file the review holds back as a secret is named the same way, so `--send`, the config's `send` and a program's `send` name it exactly as `meta.leftOut` writes it. A file the input's `leftOut` lists, as a [path review](../20-using/15-sources.md#the-files-at-a-commit)'s skipped files are, is named as its source named it: for a path review, the path in the tree, decoded as a diff would name it |
| `reason` | string | Why the review left it out, below |
| `rule` | string | The rule that skipped the file, for `skipped`: [below](#the-rules-of-a-skip); the rule that held it, for `secret` and `deleted-secret`: [The rules of a hold](#the-rules-of-a-hold). The key is absent for any other reason |

| `reason` | Why the review left the file out |
| --- | --- |
| `excluded` | An `exclude` pattern of the review matches its path, so its section reached no model, the size guard did not count it, and a finding that cites it was dropped as outside the diff. It is no gap: leaving it out was the operator's choice. A path review lists an excluded file and never reads it |
| `binary` | The diff shows its change only as `Binary files <a> and <b> differ`, or as a `GIT binary patch` block, with none of the content. Git prints it for a file that holds a NUL byte near its start, or that an attribute marks `-diff`: the change's own `.gitattributes` included, when the diff is made in its checkout. A path review writes such a file the same way when its default skips are off, and the input's `leftOut` may list one |
| `submodule` | The diff shows a submodule's change only as its commit: its `Subproject commit` lines, a header of mode `160000`, or a `Submodule` line, and none of its code. The input's `leftOut` may list one |
| `skipped` | A [path review](../20-using/15-sources.md#what-a-path-review-skips) skipped the file, by the `rule` the entry names: it reached no model, and it is no gap, since the review listed it and nothing in the diff was left unread |
| `secret` | The review held the file back, by the `rule` the entry names: its name is a secret's (`name`), or a line of it holds a credential of one kind. No model was sent any of it, every section of it left the diff, and the file is a gap of every profile. The input's `leftOut` may list one. [Files held back as secrets](../20-using/15-sources.md#files-held-back-as-secrets) |
| `deleted-secret` | The change deletes a file named as a secret whole, so it adds no code a review would read. No model was sent it, and it is no gap; the file's `secret-file` flag says that the history still holds it. Its `rule` is `name`: a whole deletion of a file held for a credential in it is listed `secret`, a gap, since the code it removes would go unread. The input's `leftOut` may list a `deleted-secret` file with any rule |

A `binary`, `submodule` or `secret` file makes the review incomplete: every profile records a gap of that reason that counts them, which no flag lifts for a gating profile ([Incomplete reasons](#incomplete-reasons)). That holds for such a file the input's `leftOut` lists as for one the diff shows. An `excluded` file, a `skipped` one and a `deleted-secret` one are no gap. To send a `secret` file all the same, an operator names it with `--send` or the config's `send`, and a program in `review`'s `send`: [Sending a held file](../20-using/20-configuration.md#sending-a-held-file), [`review`](./30-library-api.md#review). To review a change that holds images, fonts or other assets, list them in the named config's `exclude`: [Excludes](../20-using/20-configuration.md#excludes). The section of a `binary` or `submodule` file still reaches the models, which read nothing of the change; no section of a `secret` file does. A line of the same form elsewhere, such as a line of a commit message in a `format-patch` series, lists the file whose section holds it: quorum counts it, since a gap it should not have stops a review for a person to look, where a missed one would pass a change unread. A file stored outside git, such as a Git LFS pointer, is not detected in a diff, where a path review skips a pointer and lists it as `lfs`: [Content the diff does not carry](../30-security/10-threat-model.md#content-the-diff-does-not-carry).

#### The rules of a skip

| `rule` | What it matches |
| --- | --- |
| `vendored` | A file under a directory named `node_modules`, `bower_components`, `jspm_packages`, `vendor`, `Vendor`, `vendors`, `third_party`, `third-party`, `thirdparty`, `Pods` or `Carthage`, at any depth. The file's own name is not looked at: `vendor.go` is reviewed |
| `lockfile` | A file named `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `deno.lock`, `poetry.lock`, `Pipfile.lock`, `pdm.lock`, `uv.lock`, `go.sum`, `go.work.sum`, `Cargo.lock`, `composer.lock`, `gradle.lockfile`, `Gemfile.lock`, `packages.lock.json` or `paket.lock` |
| `minified` | A file whose name ends, in any case, in `.min.js`, `.min.mjs`, `.min.cjs`, `.min.css`, `.js.map`, `.mjs.map`, `.cjs.map` or `.css.map`; or a `.js`, `.mjs`, `.cjs` or `.css` file whose lines average over 110 bytes, linguist's rule |
| `secret` | A file whose name is a secret's, by the `name` row of [The rules of a hold](#the-rules-of-a-hold), templates apart: a `.env.example`, `.env.sample`, `.env.template` or `.env.dist` and a Helm chart's `templates/secrets.yaml` are no secret by name, and are read; or a file whose text holds a credential of one of that section's kinds, found once the file is read, a template included. It is skipped whatever the default skips are, and raises a `secret-file` [flag](#a-flag), which says by name or by content; a file named in `send` stays unskipped |
| `binary` | A file with a NUL byte among its first 8000 bytes, as git reads one |
| `submodule` | A gitlink: the commit of another repository, which a path review never enters. Always skipped |
| `lfs` | A Git LFS pointer: under 1024 bytes of printable ASCII, exactly the `version`, optional `ext-` lines, `oid` and `size` lines of the spec. A pointer holds no code. Always skipped |

The rules are tried in the order `submodule` (always), then `secret` by name, then `vendored`, `lockfile` and `minified` by name, then `lfs` once the file is read, then `binary`, then `secret` by content, then `minified` by content, so a file is listed under the first rule it fits. Only a path review skips, and only `--no-default-skips` turns the four default rules off, `vendored`, `lockfile`, `minified` and `binary`: a secret stays skipped and flagged, whatever the skips, and only `--send` or `send` sends it: [What a path review skips](../20-using/15-sources.md#what-a-path-review-skips).

#### The rules of a hold

A file is held back by its name, or by a line of it that holds a credential. Its `rule` says which: `name`, or the kind of credential. The name is judged first, so a `.env` that holds a key is `name`.

| `rule` | What holds a file | gitleaks 8.30.1 rule ids it takes |
| --- | --- | --- |
| `name` | A name that is one of `.env`, `.npmrc`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, `.htpasswd`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials`, `credentials.json`, `secrets.json`, `secrets.toml`, `secrets.yaml` or `secrets.yml`; a name that starts with `.env.`; or a name that ends in `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.kdbx`, `.tfstate` or `.tfstate.backup`. Only the last segment of a path counts, in any case, and an `a/` or `b/` prefix changes nothing. A name that starts with `.env.` and ends in `.example`, `.sample`, `.template` or `.dist`, and a `secrets.yaml` or `secrets.yml` whose directory is named `templates`, a Helm chart's, are templates and no secret by name | None: the names are quorum's own |
| `private-key` | A private key's armor line, followed by a body: a run of at least 32 characters of the base64 alphabet that holds a digit and a letter, on the same line after the armor or on one of the next six lines. The ten markers are pre-commit-hooks' `detect-private-key`: the armor of an RSA, DSA, EC, OpenSSH, SSH2 encrypted and encrypted private key, of a PKCS#8 key that names no algorithm, and of a PGP private key block, PuTTY's first line of a version 2 key file, and the header of an OpenVPN static key. Code that parses keys, or a document that names a header, has no body, and is no hit | None: the markers are pre-commit-hooks' |
| `aws-key` | An access key id: `AKIA`, `ASIA`, `ABIA`, `ACCA`, or `A3T` and a letter or digit, then 16 capital letters and digits from 2 to 7, ending at a word boundary, one that ends in `EXAMPLE` being no hit; and a long-lived Bedrock API key, which starts with `ABSK` | `aws-access-token`, `aws-amazon-bedrock-api-key-long-lived` |
| `github-token` | A token that starts with `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` and 36 more letters and digits, or with `github_pat_` and 82 more word characters | `github-pat`, `github-oauth`, `github-app-token`, `github-refresh-token`, `github-fine-grained-pat` |
| `slack-token` | A bot token (`xoxb-`, in two forms), a user token (`xoxp-` or `xoxe-`), an app-level token (`xapp-`), a configuration access token (`xoxe.xoxb-` or `xoxe.xoxp-`) or refresh token (`xoxe-`), a legacy token (`xoxo-`, `xoxs-`, `xoxa-` or `xoxr-`), and a webhook URL of `hooks.slack.com` | `slack-bot-token`, `slack-user-token`, `slack-app-token`, `slack-config-access-token`, `slack-config-refresh-token`, `slack-legacy-bot-token`, `slack-legacy-token`, `slack-legacy-workspace-token`, `slack-webhook-url` |
| `google-key` | A Google API key: `AIza` and 35 more characters | `gcp-api-key` |
| `stripe-key` | A Stripe secret or restricted key: `sk_` or `rk_`, then `test_`, `live_` or `prod_`, and 10 to 99 letters and digits | `stripe-access-token` |
| `anthropic-key` | An Anthropic API or admin key: `sk-ant-api03-` or `sk-ant-admin01-`, then 93 characters and `AA` | `anthropic-api-key`, `anthropic-admin-api-key` |
| `openai-key` | An OpenAI key: `sk-`, then `proj-`, `svcacct-` or `admin-` and a long body, or 20 letters and digits, with `T3BlbkFJ` in the middle | `openai-api-key` |

- **The two sources.** The credential rules are [gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1's, for the seven providers of the table, each with its pattern as gitleaks ships it, MIT licensed, Copyright (c) 2019 Zachary Rice. The private-key markers are those of [pre-commit-hooks](https://github.com/pre-commit/pre-commit-hooks) v5.0.0's `detect-private-key`, MIT licensed, Copyright (c) 2014 pre-commit dev team. Quorum's source carries both notices.
- **What is left of gitleaks.** The Bedrock key that expires within twelve hours, gitleaks' own `private-key` rule, which matches across lines, the allowlist of 16 public Google keys and the config's global allowlist are not taken: a key of a pattern quorum does not read is sent.
- **The entropy floor.** A rule's match is no hit when its secret has a Shannon entropy, in bits per character, at or below the rule's floor, which gitleaks sets from 2 to 4 for each rule but Anthropic's two and Slack's webhook, which have none. A placeholder such as one character repeated is no hit.
- **Line by line.** A line is tested for a private-key marker, which looks at most six lines ahead for its body, and, when it holds a keyword of the rules in any case, for each rule in order and every match of it. The first hit decides, a line of any length is read in linear time, and a removed or context line counts as an added one.
- **A hit holds the file.** Never a line of it: no model is sent the rest, and nothing is redacted.

**A later release may add reasons and rules.** A reader takes a `reason` or a `rule` it does not know as a file left out, never as an error, and goes on reading the rest of the result.

### A flag

| Field | Type | Holds |
| --- | --- | --- |
| `code` | `"hidden-characters"`, `"ai-addressed-text"` or `"secret-file"` | What the flag is about |
| `file` | string | The path of the file the flag is about: the diff's own path, or for `secret-file` the path of the file held back or skipped. The key is absent for a diff without per-file headers, and for a `secret-file` flag about the text no header names |
| `line` | number | The first added line, in the new file, that the flag is about. The key is absent for a flag about the file name, and for `secret-file` |
| `detail` | string | What was found, in words the code wrote, never text of the diff |

A file raises at most one flag for each row of this table, in this order:

| `code` | About | `line` | `detail`, for instance |
| --- | --- | --- | --- |
| `hidden-characters` | The file name | Absent | `the file name holds U+202E` |
| `hidden-characters` | The added lines | The first added line that holds one | `U+202E, U+200B on 3 added line(s)` |
| `ai-addressed-text` | The added lines | The first added line that matches | `a chat-template token, a tool-call tag on 2 added line(s)` |
| `secret-file` | A file held back by its name | Absent | `named as a secret, so no model was sent any of it: check that it belongs in the change` |
| `secret-file` | A file held back by a credential in it | Absent | `holds what reads as an AWS key, so no model was sent any of it: keep it out of the repository, and rotate it if it is real` |
| `secret-file` | A file named as a secret that the change deletes whole | Absent | `deletes a file named as a secret, so no model was sent any of it: the history still holds the file, so rotate what it held` |
| `secret-file` | A file a path review skipped by its name | Absent | `named as a secret, so a path review sent none of it: check that it belongs in the repository` |
| `secret-file` | A file a path review skipped by a credential in its text | Absent | `holds what reads as a credential, so a path review sent none of it: remove it from the repository, and rotate it if it is real` |

A `secret-file` flag comes from `meta.leftOut`, not from the diff: one for each `skipped` file of the rule `secret`, `secret` file and `deleted-secret` file, in its order, ahead of the diff's flags. The detail of a held file by a credential names the kind in words (`a private key`, `an AWS key`, `a GitHub token`, `a Slack token or webhook`, `a Google API key`, `a Stripe key`, `an Anthropic key` or `an OpenAI key`), and a `deleted-secret` entry that names a kind, which only the input's `leftOut` can hold, reads `deletes a file that holds what reads as an AWS key, so no model was sent any of it: the history still holds it, so rotate it`. A flag quotes no line of the file. A secret that an `exclude` pattern matched first is listed as `excluded` and raises none. A detail names at most eight code points or patterns, then `and N more`. [Advisory flags](../30-security/30-output-handling.md#advisory-flags) says what each code looks for. A flag never changes a verdict, a gap or the exit code.

## Incomplete reasons

| Reason | Recorded when | `detail` |
| --- | --- | --- |
| `finding-unreadable` | A finding among the first `maxFindings` the research reply lists does not match the reply schema, names an empty file or a line below 1, or holds an object or array under a key the schema does not name | `findings[<index>]: ` and what is wrong: `findings[4]: quote: Invalid input: expected string, received undefined`, `findings[2]: file must be non-empty and line at least 1`, or `findings[3]: carries a nested object or array outside the reply schema`. In a research in parts, `part <n>: ` comes first: `part 2: findings[4]: quote: Invalid input: expected string, received undefined` |
| `findings-capped` | The reply lists more findings than `maxFindings`, 50 by default: the rest are counted, not read. The cap spans every part of a research in parts: the replies are read in the parts' order, up to the cap in all, and one gap counts the rest | `12 of 62 reported findings were not reviewed (the cap is 50)` |
| `research-unusable` | The reply, or the replies of all the parts, list findings, and not one of those read is usable: each was unreadable or cited code outside the diff | `2 finding(s) reported, none usable`, or, when the cap applied, `62 finding(s) reported, the first 50 read, none usable` |
| `research-failed` | An advisory profile's research call failed after its retries, or its reply was not one JSON object holding a `findings` array and nothing else: the profile reviews nothing, and the gap gates nothing. In a research in parts it is the parts that failed, the other parts going on: one gap counts them. A gating profile's ends the review instead, exit `3` | `the research call failed (http 503) after 3 attempts`, or `the research reply could not be read: reply contains no JSON object`; in parts, `2 of 6 research parts failed: the research call failed (http 503)`, the first failed part's words |
| `vote-failed` | A kept finding's failed votes, had they been keeps, would have raised it to a higher level | `"src/a.js":12 is kept at medium, but 1 failed vote(s) could have made it high`, the file written as a JSON string |
| `request-too-large` | A request may not fit its provider's context, so it was not sent: the profile's research request, which leaves the profile with no finding, or the vote requests of a finding, each a failed vote. In a research in parts, a part its provider refused: one gap counts them | `the research request was not sent: <the provider's message>`, or `"src/a.js":12: 2 of 3 vote requests were not sent: <the first provider's message>`, the file written as a JSON string; in parts, `1 of 6 research requests were not sent: <the first provider's message>` |
| `too-large` | A hunk of a file, with its header, or a section with no hunk, is too large for any research part of the profile's model's window, even in a part whose request lists no file name: no part holds it, so no model read it. One gap per profile, counting hunks and files, recorded before any call is sent; `meta.profiles.<id>.coverage` lists the ranges. A file that `meta.leftOut` lists as `binary` or `submodule` is not counted, since its own gap stands and its coverage entry is `unreviewed` with that reason | `1 hunk(s) of 1 file(s) fit in no research part of its model's window, listed as too-large in meta.profiles.security.coverage` |
| `token-cap` | The review's token cap stopped part of the profile's work: its research request, which leaves it with no finding, or the parts of its research that were not sent, or votes, each a failed vote whose `failure` is `token-cap`. One gap per profile, counting them | `the review's token cap of 2000000 tokens stopped 7 vote(s)`, or `... stopped its research`, or `... stopped its research and 7 vote(s)`; in parts, `... stopped 4 of its 6 research parts`, or `... stopped 4 of its 6 research parts and 7 vote(s)` |
| `review-deadline` | The review reached its deadline, `reviewTimeoutMs`, which stopped part of the profile's work: its research request, which leaves it with no finding, or the parts of its research in flight or not yet sent, or votes, in flight or not yet sent, each a failed vote whose `failure` is `review-deadline`. One gap per profile, counting them | `the review's deadline of 1800000 ms stopped 7 vote(s)`, or `... stopped its research`, or `... stopped its research and 7 vote(s)`; in parts, `... stopped 5 of its 6 research parts` |
| `binary` | `meta.leftOut` lists a file whose change the diff shows only as binary, or one the input's `leftOut` names as `binary`: one gap per profile, counting the files. A file a path review skipped as `binary` is no such file: it is listed as `skipped` and is no gap | `the diff carries no content for 2 binary file(s), listed in meta.leftOut` |
| `submodule` | `meta.leftOut` lists a submodule whose change the diff shows only as a commit, or one the input's `leftOut` names as `submodule`: one gap per profile, counting them. A gitlink a path review skipped is listed as `skipped` and is no gap | `the diff carries no content for 1 submodule(s), listed in meta.leftOut` |
| `secret` | `meta.leftOut` lists a file held back as a secret, or one the input's `leftOut` names as `secret`: one gap per profile, counting the files. A `deleted-secret` file and a file a path review skipped as a secret are no such file, and no gap | `no model was sent 2 file(s) held as secrets, listed in meta.leftOut` |

Each gap makes the review incomplete, as an unreviewed finding does: the CLI exits `4` for a gap of a gating profile, unless a gating profile kept a `high` finding. `--allow-incomplete` lifts a gating profile's gaps only when each is an unreviewed finding or a `vote-failed` gap, and every failed vote behind them failed in passing: a dropped connection, a timeout of its own, or an HTTP 408, 409, 429 or 5xx, as the votes' `failure` says ([Exit codes](../20-using/10-cli.md#exit-codes)). Every other gap exits `4` whatever the flags, since a pull request causes it directly: a `too-large` gap by making one hunk larger than any window, a `request-too-large` gap by padding a request until its provider refuses it, a `token-cap` gap by decoy findings and drawn-out replies that spend the review's tokens, a `review-deadline` gap by replies drawn out until the review's deadline, `binary` and `submodule` with one `.gitattributes` line, one NUL byte or a submodule's bump, `secret` with a file named `.env` or one line that reads as a key, `findings-capped` with decoy findings, and `finding-unreadable` and `research-unusable` with text that breaks the finder's reply. A `vote-failed` gap beside a vote that was refused, cut off at its token limit, stopped by a limit of the review or unusable exits `4` too. On a gating profile, do not use the flag for a pull request you do not trust.

## An example

A review of a diff that touches three files, run on the one provider, named `default`, that the CLI builds from `QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS` alone, answering for the finder and every voter; its replies are fake. The finder listed five findings: one cited `src/auth.js`, which the diff does not touch, and was dropped (`invalidFindings` is 1); one had no `quote` and could not be read (the `finding-unreadable` gap). The three others went to the panel. The SQL injection was kept by all three lenses: `high`. The path traversal was kept by one: `discarded`. The session token got one keep, one reject and a vote whose endpoint answered 503: one more keep would have reached `medium`, so it is `unreviewed`. The CLI would exit `1` for this result.

```json
{
  "kept": [
    {
      "id": "6f4bcc15476f",
      "profile": "security",
      "file": "src/users.js",
      "line": 12,
      "category": "CWE-89",
      "summary": "The id from the query string is interpolated into the SQL text.",
      "evidence": "-  return db.query('SELECT * FROM users WHERE id = $1', [id])\n+  const sql = `SELECT * FROM users WHERE id = ${id}`\n+  return db.query(sql)\n }",
      "quoteMatched": true,
      "keptVotes": 3,
      "totalVotes": 3,
      "confidence": "high",
      "votes": [
        {
          "angle": "reachability",
          "vote": {
            "keep": true,
            "reasoning": "request.query.id reaches the query text unchanged on every call of findUser."
          },
          "error": null,
          "failure": null
        },
        {
          "angle": "impact",
          "vote": {
            "keep": true,
            "reasoning": "Any caller can read or change every row of the users table."
          },
          "error": null,
          "failure": null
        },
        {
          "angle": "defenses",
          "vote": {
            "keep": true,
            "reasoning": "No validation or parameter binding is left on this path."
          },
          "error": null,
          "failure": null
        }
      ]
    }
  ],
  "discarded": [
    {
      "id": "31c4f568c9be",
      "profile": "security",
      "file": "src/upload.js",
      "line": 5,
      "category": "CWE-22",
      "summary": "A file name from the request is joined into the upload path.",
      "evidence": "   const name = path.basename(file.name)\n+  fs.writeFileSync(path.join(UPLOADS, name), file.data)\n }",
      "quoteMatched": true,
      "keptVotes": 1,
      "totalVotes": 3,
      "votes": [
        {
          "angle": "reachability",
          "vote": {
            "keep": true,
            "reasoning": "file.name comes from the multipart request."
          },
          "error": null,
          "failure": null
        },
        {
          "angle": "impact",
          "vote": {
            "keep": false,
            "reasoning": "The name has no directory part left, so the write stays inside UPLOADS."
          },
          "error": null,
          "failure": null
        },
        {
          "angle": "defenses",
          "vote": {
            "keep": false,
            "reasoning": "path.basename on the line above already removes any traversal."
          },
          "error": null,
          "failure": null
        }
      ]
    }
  ],
  "unreviewed": [
    {
      "id": "ea9ff1bf2f29",
      "profile": "security",
      "file": "src/session.js",
      "line": 20,
      "category": "CWE-338",
      "summary": "Session tokens come from Math.random, which is not a cryptographic generator.",
      "evidence": "-  return crypto.randomBytes(32).toString('hex')\n+  return Math.random().toString(36).slice(2)\n }",
      "quoteMatched": true,
      "keptVotes": 1,
      "totalVotes": 3,
      "votes": [
        {
          "angle": "reachability",
          "vote": {
            "keep": true,
            "reasoning": "newToken is called on every login."
          },
          "error": null,
          "failure": null
        },
        {
          "angle": "impact",
          "vote": null,
          "error": "default: HTTP 503: \"model is loading\"",
          "failure": {
            "kind": "http",
            "status": 503
          }
        },
        {
          "angle": "defenses",
          "vote": {
            "keep": false,
            "reasoning": "Each token is bound to the client address and expires after five minutes."
          },
          "error": null,
          "failure": null
        }
      ]
    }
  ],
  "meta": {
    "version": "0.1.0",
    "startedAt": "2026-11-08T02:04:20.361Z",
    "durationMs": 12,
    "source": {
      "kind": "diff"
    },
    "profiles": {
      "security": {
        "providers": {
          "research": {
            "id": "default",
            "model": "qwen3.6:27b"
          },
          "lenses": {
            "reachability": {
              "id": "default",
              "model": "qwen3.6:27b"
            },
            "impact": {
              "id": "default",
              "model": "qwen3.6:27b"
            },
            "defenses": {
              "id": "default",
              "model": "qwen3.6:27b"
            }
          }
        },
        "policy": {
          "high": 3,
          "medium": 2,
          "low": null
        },
        "gating": true,
        "invalidFindings": 1,
        "coverage": [
          {
            "file": "src/users.js",
            "status": "reviewed"
          },
          {
            "file": "src/upload.js",
            "status": "reviewed"
          },
          {
            "file": "src/session.js",
            "status": "reviewed"
          }
        ]
      }
    },
    "usage": {
      "inputTokens": 9080,
      "outputTokens": 1180
    },
    "incomplete": [
      {
        "profile": "security",
        "reason": "finding-unreadable",
        "detail": "findings[4]: quote: Invalid input: expected string, received undefined"
      }
    ],
    "leftOut": [],
    "flags": []
  }
}
```

## Related

- [The CLI](../20-using/10-cli.md#exit-codes) — the exit code each result leads to.
- [Lenses and policy](../20-using/50-lenses-and-policy.md) — how kept votes become a confidence, and when a finding is unreviewed.
- [Library API](./30-library-api.md#events) — the events a review sends while it builds this result.
- [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence) — which fields hold text an attacker can influence, and how to render them.
