# Sources

Quorum reviews a diff, and a source makes one: a diff file or stdin, a range of commits, the local changes, or the files at a commit. One source runs at a time, and the result records which one in [`meta.source`](#provenance). A source that reads a git repository runs git itself, in one hardened place, so that nothing the repository holds can run a program: [How quorum runs git](#how-quorum-runs-git).

## Choosing a source

| Source | Flag | What it reviews | Runs git |
| --- | --- | --- | --- |
| A diff file or stdin | `quorum <diff-file>`, or a pipe | The diff it holds, as it is | No |
| A range of commits | `--range <base>...<head>` | What `<head>` changed since it left `<base>` | Yes |
| The local changes | `--local` | What `git add -A` would commit: the staged, the unstaged and the untracked changes | Yes |
| The staged changes | `--staged` | What the next commit holds | Yes |
| The files at a commit | `--path <path>`, with `--at <rev>` | The files under one or more paths at a commit, each written as a new file: a whole codebase, or a directory of it | Yes |

Two sources in one command are a usage error, exit `2`, before any git and any config: `Error: --range: cannot be given with a diff file: give one source`. The sources are taken in the order diff file, `--range`, `--local`, `--staged`, `--path`, and the second one present is refused, naming the first: `--staged: cannot be given with --local: give one source`. So is `--range` twice (`--range: takes one range`), `--at` twice (`--at: takes one commit`), `--range`, `--local`, `--staged` or `--path` with `--print-config`, which reads no diff, `--trust-repo-config` without `--local` or `--staged` (`--trust-repo-config: needs --local or --staged`), and `--at`, `--large` or `--no-default-skips` without `--path` (`--at: needs --path`, `--large: needs --path`, `--no-default-skips: needs --path`).

A git source reads no stdin: a diff piped in beside `--range`, `--local`, `--staged` or `--path` is ignored. A pipe cannot be told apart from no diff in CI, where stdin is rarely a terminal, so quorum does not refuse it.

## Files held back as secrets

Every source holds back a file that reads as a secret: no model is sent any of it, whatever made the diff. The rule is quorum's own, read by code before any model sees a line, and it applies to a piped diff, a range, the local changes, the staged changes and a path review alike.

- **What every source holds back.** A file whose name is a secret's, in any case: `.env`, `.npmrc`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, `.htpasswd`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials`, `credentials.json`, `secrets.json`, `secrets.toml`, `secrets.yaml` and `secrets.yml`; a name that starts with `.env.`; and a name that ends in `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.kdbx`, `.tfstate` or `.tfstate.backup`. And a file that holds a credential quorum recognizes: a private key's armor followed by its body, and the keys of AWS, GitHub, Slack, Google, Stripe, Anthropic and OpenAI, as gitleaks 8.30.1 reads them, a placeholder of low entropy aside: [The rules of a hold](../95-reference/20-json-result.md#the-rules-of-a-hold).
- **Where it looks.** At every path a file's section names (its `diff --git` header, read as git writes it and word by word, so a header forged to name no path still holds the `.env` it spells; its `---` and `+++` lines, and its `rename` and `copy` lines, so a file renamed from `.env` is held by its old name) and at every line of it, removed and context lines included. The text no header names, such as a `format-patch` mail's message or a plain `diff -u`, counts as one file, of the empty name.
- **What happens.** No model is sent any of the file, and a hit on one line holds the whole file, every section of it. `meta.leftOut` lists it as `secret`, with the `rule` that held it; a `secret-file` flag says why, on stderr and in `meta.flags`: [Advisory flags](../30-security/30-output-handling.md#advisory-flags); and every profile records a `secret` gap, which exits `4` for a gating profile, `--allow-incomplete` included. A diff whose every file is held calls no model, exits `4`, and still records the gap.
- **Why a gap.** A pull request chooses its file names and its lines, so a name or a key could keep the code of a file from the review. As with a binary file, the change can hide its code this way, but the run cannot pass: the review is incomplete, exit `4`, and a person looks.
- **A deletion.** A change that deletes a file named as a secret whole adds no code a review would read, so it passes with no gap, sends none of the file, and is listed as `deleted-secret`. Its flag says that the history still holds the file, so rotate what it held. That holds even for a `.npmrc`, whose lines can be install settings (`ignore-scripts`, a scoped registry) as well as tokens, so such a deletion is reviewed by no model, only flagged. A truncation to empty, an edit and a deletion in one `format-patch` series, a `---` line that names another file than the header does, or any deletion with another kind of line is no whole deletion, and the file is held as a gap. So is a deletion of a file held for a credential in it, a source file with a fixture key say: it is listed as `secret` with its kind, since the code it removes would go unread.
- **Templates.** A `.env.example`, `.env.sample`, `.env.template` or `.env.dist`, and a Helm chart's `templates/secrets.yaml` or `templates/secrets.yml`, are sent, unless they hold a credential.
- **`exclude` first.** A file `exclude` matches is listed as `excluded`, with no flag, and judged no further.
- **What remains.** A password, or a key of a provider the rule does not know, is sent. A `.env` moved to `config.txt` is a deletion of `.env` and a new `config.txt` under `--no-renames`, which quorum's own sources use: the new file is sent unless its content holds a credential. A provider keeps what it was sent for about 30 days, and flagged content for up to two years at Anthropic, so a key that reached one is to be rotated: [Secrets held back](../30-security/10-threat-model.md#secrets-held-back).
- **A path review** skips a file named as a secret before it reads it, and lists it as `skipped`, which is no gap: [What a path review skips](#what-a-path-review-skips). The hold applies to what it writes all the same.
- **The override,** for a program: `review`'s `send` names the files to send all the same, each by the path as `meta.leftOut` lists it: [`review`](../95-reference/30-library-api.md#review).

## A diff file or stdin

A diff file is the one argument of `quorum <diff-file>`, read as UTF-8. With no argument quorum reads stdin until it closes, and when stdin is a terminal it refuses with `no diff given` instead of waiting for input. Nothing is left out but the files [held back as secrets](#files-held-back-as-secrets), and the diff is reviewed as it is made: whatever its producer pinned or did not pin is what quorum reads, so make it as [Using it in CI](./10-cli.md#using-it-in-ci) says, or review a range.

- **The file is named in no message.** A path that does not exist, a directory and a file the process cannot read exit `2` with the usage and one of three texts: `the diff file does not exist`, `the diff file is a directory` and `the diff file cannot be read`.
- **A diff over 16 MiB** is refused, counted in UTF-8 bytes as they arrive: `the diff is over 16 MiB, the most quorum reads`. Reading stops at the chunk that crosses the cap.
- **A second file** is refused: `takes one diff file, and <n> more argument(s) were given`.

## A range of commits

```bash
quorum --range origin/main...HEAD > result.json
```

`--range <base>...<head>` reviews what `<head>` changed since it left `<base>`. Quorum resolves both sides to full commit ids, finds the merge base, the commit where their histories meet, and diffs the merge base with the head. It is git's own `<base>...<head>`, run with the pins of [How quorum runs git](#how-quorum-runs-git).

- **Three dots.** `<base>..<head>` compares the two ends, so everything `<base>` gained since the branch left it shows up as lines the branch removed, and a review would judge changes no one on the branch wrote. A single revision names no range. Both are refused with what to write instead, before any git and any config, and so are a side that is empty, one that starts with `-`, and a value with more than one `...`. Each is exit `2`.
- **A side that names no commit** of this repository exits `2`. For the base it says to fetch it, as a shallow single-branch checkout in CI lacks it: `--range: its base names no commit of this repository: fetch it first, as actions/checkout does with fetch-depth: 0`. For the head it is `--range: its head names no commit of this repository`. The message never repeats what you typed.
- **The same commit on both sides** exits `2`, since there is nothing to review: `--range: its two sides are one commit, so it names nothing to review`. A head already contained in the base is an empty diff instead, reviewed without calling a model: `empty diff: nothing to review`, exit `0`.
- **A shallow clone** may lack the history where the two sides meet. It exits `2`: `--range: its two sides share no history in this clone: fetch the base's history, as actions/checkout does with fetch-depth: 0`. With `actions/checkout`, set `fetch-depth: 0`.
- **A range whose diff is over 16 MiB** exits `2`: review a shorter range.
- **Attributes come from the base.** The diff is made with `--attr-source=<base>`, so the change's own `.gitattributes` cannot hide a file in it: [Content the diff does not carry](../30-security/10-threat-model.md#content-the-diff-does-not-carry). A file the base marks `-diff`, or one with a NUL byte near its start, is still listed as binary, a gap of every profile.
- **A moved file is reviewed whole.** `--no-renames` shows a move as a deletion and an addition, so the models read the moved file's content and not only its new name. GitHub shows the same move as a rename with no changed line, so a line comment a tool posts for a finding in it may land as a comment on the file.
- **`exclude` applies,** as it does to a piped diff: [Excludes](./20-configuration.md#excludes).

### A pull request from a fork

A maintainer can review a fork's pull request from a clone of their own, without checking its code out:

```bash
git fetch origin pull/123/head
quorum --range origin/main...FETCH_HEAD
```

The fetch brings commits, which quorum reads with the plumbing set alone: `rev-parse`, `merge-base` and `diff` of two commits. The fork's config, hooks and attributes never come with them.

## The local changes

```bash
quorum --local > result.json
quorum --staged > result.json
```

Two flags review what is not committed yet. Both diff against `HEAD`, or against the empty tree before a first commit, when `meta.source.head` is `null`, and both apply `exclude` as a range does.

- **The two flags.** `--local` reviews what `git add -A` would commit: the staged changes, the unstaged ones and the untracked files. `--staged` reviews what the next commit holds: the index against `HEAD`, and no untracked file.
- **Nothing to review** is an empty diff, reviewed without calling a model: `empty diff: nothing to review`, exit `0`. A diff over 16 MiB exits `2`: `--local: its diff is over 16 MiB, the most quorum reads: review fewer changes at once`. What git's diff holds and the untracked files' sizes are counted together before any file is read, and the diff quorum writes is held to the cap too.
- **Untracked files** are read by quorum itself, inside the top level and never through a link, as long as no other process is changing the tree during the review ([Git, run by quorum](../30-security/10-threat-model.md#git-run-by-quorum)), and written as new files, as `git add -A` would commit them. Their hunks are cut at 4 KiB, so research in parts can spread a large file: it is a form to read, and no patch that `git apply` takes.
  - **A link** is written as mode `120000` and its target, and what it names is never read: a link to `/etc` is the one row `/etc`, whether or not that exists, and so is a link to a directory of the tree or a dangling one, each its own target. An executable file is mode `100755`.
  - **A nested repository** is a gitlink, as `git add -A` commits it, and a `submodule` gap of every profile: its content is another repository's, which quorum never enters.
  - **A file `exclude` matches** is listed as `excluded` and never read.
  - **What quorum cannot read exits `2`:** a FIFO, a socket or a device (`--local: the untracked "<name>" is neither a regular file nor a link: remove it, or name it in .gitignore`), a file it has no permission to read (`--local: the untracked "<name>" cannot be read: check its permissions, or name it in .gitignore`), a name that is not UTF-8, which quorum cannot open (`--local: an untracked file's name is not UTF-8, which quorum cannot open: rename it, or name it in .gitignore`), a name that leaves the top level, and a file under a symbolic link (`--local: the untracked "<name>" lies under a symbolic link`). Each name is written as a JSON string.
  - **A file that changes while quorum reads it exits `2`** too: one that is gone by then, whose directory is gone, or that has outgrown the size it had when quorum listed it (`--local: the untracked "<name>" changed while quorum read it: run quorum again`). Run quorum again once what writes into the tree has stopped.
- **What git hides.** A file that a `.gitignore` names is not listed, so the review never sees it, and neither does the commit. A `.gitignore` the change itself edits hides a file from the review and from the commit alike.
- **An untracked `.env`** that no `.gitignore` names is held back as a secret, a gap of every profile and exit `4`: name it in `.gitignore`, so that git never lists it and the commit never holds it. [Files held back as secrets](#files-held-back-as-secrets) says what else is held.
- **A hook.** In a pre-commit hook, `quorum --staged` reviews the index git is about to commit. Where git points the hook at another index through `GIT_INDEX_FILE`, as it does for some forms of `git commit`, quorum passes that variable on to its git, so it reads that index.

### Trust

A diff of the working tree runs the clean and process filters an attribute names, whatever the flags say. A repository someone else made can name such a program in its own config, and `--local` would run it with the job's rights. So both flags first read the filter settings (`filter.<name>.clean`, `.smudge` and `.process`) with the scope each came from, and refuse a repository whose own config names one:

- **A filter in the repository's own config exits `2`:** `--local: the repository's own config names a filter program, which a working-tree diff runs: pass --trust-repo-config if the repository is yours, or review a range`. Any key whose scope is not `system` or `global` refuses, the repository's, its work tree's, the command line's and a scope git adds later, whatever its value. A diff of the index runs no filter, and `--staged` is refused all the same: one rule covers both flags.
- **`--trust-repo-config` says the repository is yours,** and lifts the refusal. A repository that needs a filter of its own config, as `git-crypt` and `git lfs install --local` set up, needs the flag. It is a usage error without `--local` or `--staged`.
- **Your global and system filters run** as they do with your own git: they are your own.
- **Attributes come from `HEAD`.** The diff is made with `--attr-source=<HEAD>`, so the `.gitattributes` of the working tree, which the change may have edited, does not choose what a file goes through.

What is left once the check passes: [Git, run by quorum](../30-security/10-threat-model.md#git-run-by-quorum).

## The files at a commit

```bash
quorum --path src --path docs > result.json
quorum --path . --at v1.2.0 > result.json
```

`--path <path>` reviews the files under a path at a commit, written as a diff that adds each of them: the review of a codebase, or of a directory of it, where the other sources review a change. The flag repeats, and `--at <rev>` names the commit, `HEAD` by default. Quorum reads the commit's tree by id and never the working tree, so an edit that is not committed is not in the review: [The local changes](#the-local-changes) reviews those.

- **The selection.** Each value is a path from the working directory, read as a path of the tree: from `src/`, `b.ts` is `src/b.ts`, `../a.ts` is `a.ts` and `.` is `src`. `src`, `src/` and `./src` name one path, and `.` at the top of the repository is the whole tree. A file is selected when its name is the path or starts with it and `/`, as the diff reads the name back (a name git quotes is decoded). The result records the normalized selections, each once, in [`meta.source.paths`](#provenance).
- **Quorum hands git no path.** It lists the commit's tree once, filters the listing in code and reads each blob it keeps by id, so no pathspec magic and no link applies: [Paths, never handed to git](../30-security/10-threat-model.md#paths-never-handed-to-git). The one string git is given is the commit, resolved once like a revision of `--range`.
- **A path that selects nothing exits `2`.** A value that is empty (`--path: must name a path`) or absolute (`--path: must be relative to the working directory`) is refused before any config and any git. Two more refusals come once the repository is open, as they need where the working directory sits in it and the commit's listing: a value that leaves the top level of the repository (`--path: path <n> leaves the repository's top level`), and one that names no file tracked at the commit (`--path: path <n> names no file tracked at the commit`), `<n>` counted from 1 among the values given and the value never repeated. A `HEAD` that names no commit is refused with what to do (`--path: needs a commit, and HEAD names none: commit first, or name one with --at`), and so is an `--at` that names none (`--at: names no commit of this repository`). An `--at` that starts with `-` is refused before any config and any git, as a revision of `--range` is (`--at: a revision may not start with -`).
- **A selection whose every file is left out exits `2`**, an empty review never passing: `--path: every selected file is left out (<n> skipped, <m> excluded): pass --no-default-skips to review the skipped ones, or narrow exclude`. With `--no-default-skips` given, only a gitlink and a Git LFS pointer are still skipped, so it advises otherwise: `--path: every selected file is left out (<n> skipped, <m> excluded): narrow exclude, or name a path that holds files other than gitlinks and Git LFS pointers`.
- **A selection over 16 MiB exits `2`.** The listed sizes of the files to read must be within 16 MiB before any blob is read (`--path: the selected files hold <bytes> bytes, over the 16 MiB (16777216 bytes) a review reads: name a narrower path`), as must the names (`--path: the selected files' names are over 16 MiB: name a narrower path`) and the diff quorum writes (`--path: its diff is over 16 MiB, the most quorum reads: name a narrower path`). A file a rule skips by its name, and one `exclude` leaves out, is not read and not counted.
- **The form.** The diff is an all-added one in git's new-file form, written by quorum: each file is `new file mode <mode>`, `--- /dev/null`, `+++ b/<path>` and its hunks, with a link as mode `120000` and its target, and an empty file as its header and mode alone. A file with a NUL byte among its first 8000 bytes is git's `Binary files /dev/null and b/<path> differ` line. Hunks are cut at 4 KiB, so research in parts can spread a large file: it is a form to read, and no patch that `git apply` takes.
- **`exclude` applies** before any blob is read: an excluded file is listed in `meta.leftOut` as `excluded` and never read: [Excludes](./20-configuration.md#excludes).

### What a path review skips

A review of a whole codebase should not spend its tokens on what no one reads or what no model should be sent. So a path review skips the files below by default, and lists each in `meta.leftOut` as `skipped`, with the `rule` that took it. A skip is no gap: the review is not incomplete for it, and nothing is dropped in silence.

| Rule | What it skips | By default |
| --- | --- | --- |
| `secret` | A file named `.env`, `.npmrc`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, `.htpasswd`, `id_rsa`, `id_dsa`, `id_ecdsa` or `id_ed25519`; a name that starts with `.env.`; a name that ends, in any case, in `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.kdbx`, `.tfstate` or `.tfstate.backup` | Skipped, and flagged |
| `vendored` | A file under a directory named `node_modules`, `bower_components`, `jspm_packages`, `vendor`, `Vendor`, `vendors`, `third_party`, `third-party`, `thirdparty`, `Pods` or `Carthage`. Only a directory counts, never the file's own name: `vendor.go` is reviewed | Skipped |
| `lockfile` | A file named `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `deno.lock`, `poetry.lock`, `Pipfile.lock`, `pdm.lock`, `uv.lock`, `go.sum`, `go.work.sum`, `Cargo.lock`, `composer.lock`, `gradle.lockfile`, `Gemfile.lock`, `packages.lock.json` or `paket.lock` | Skipped |
| `minified` | A name that ends, in any case, in `.min.js`, `.min.mjs`, `.min.cjs`, `.min.css`, `.js.map`, `.mjs.map`, `.cjs.map` or `.css.map`; and a `.js`, `.mjs`, `.cjs` or `.css` file whose lines average over 110 bytes, linguist's rule, line feeds not counted | Skipped |
| `binary` | A file with a NUL byte among its first 8000 bytes, as git reads one | Skipped |
| `submodule` | A gitlink: the commit of another repository, which quorum never enters | Always skipped |
| `lfs` | A Git LFS pointer: under 1024 bytes of printable ASCII and line feeds, exactly the `version` line, any `ext-` lines, `oid` and `size` of the spec, and nothing else, so it holds no code | Always skipped |

- **The order.** Each selected file, in git's order, is a gitlink first (`submodule`), then matched by `exclude` (`excluded`), then, with the skips on, by its name: `secret`, `vendored`, `lockfile`, `minified`, the first that fits. A file that is left is read, and then a pointer is skipped (`lfs`), and with the skips on a binary file (`binary`) and a minified one by its lines (`minified`).
- **`--no-default-skips` reviews them.** It turns off the five rules of the table that are skipped by default, so a secret, a vendored file, a lockfile and a minified file are written like any other. A binary file is then written as git's binary line, which makes the review incomplete as any binary file in a diff does: [A file left out](../95-reference/20-json-result.md#a-file-left-out). A gitlink and a pointer are skipped all the same, since the first is another repository's commit and the second holds no code to read.
- **Nothing is read from `.gitattributes`.** A `linguist-vendored`, `linguist-generated` or `-diff` line skips nothing here, and a file the tree marks so is written as text. The tree is the author's, and a rule that took its word would let a change choose what goes unread. A tree can still shape a file to match a rule, a name under `vendor/` or lines long enough to read as minified, which is why each skip is listed and the flag reviews them all.
- **A skipped secret is flagged.** A file skipped as `secret` also raises a `secret-file` flag, on stderr and in `meta.flags`, so that a person looks at whether it belongs in the repository: [Advisory flags](../30-security/30-output-handling.md#advisory-flags). No template is exempt: a `.env.example` can hold a real key pasted in, and skipping it costs the review of a template where sending it could cost the key. A secret that `exclude` matched first is listed as `excluded` and raises no flag, since the operator chose to leave it out. With `--no-default-skips` a secret is skipped no more, so it is sent to the models like any file and raises no flag.

### What a path review costs

A change is as large as its author made it, and a codebase as large as its tree: a path review of a whole repository can be hundreds of research parts. So a path review says what it may cost before it calls a model, and stops when that may pass the review's token cap. No other source does, and the reason is theirs: a diff, a range and the local changes are as large as the change, which is what a review is for, and a CI job that reviews a pull request must not stall at a gate. Only `--path`, where the size is the tree's, prints an estimate and can be held.

- **The estimate.** It is printed on stderr, after the banner and before the first call, in two kinds of lines: one for each profile, starting with `[<id>] ` when several run, and one for the whole review. This is quorum's own `src/core` with its specs left out by `exclude`, on a model with a window of 200000 tokens, the security profile alone:

  ```text
  estimate: 11 research part(s), about 166043 tokens expected for them; then up to 150 vote(s), at most 8864619 tokens in all
  estimate: research about 166043 tokens expected, at most 8864619 with every vote, 223240 of them reserved at once; the review's token cap is 2000000 and its deadline 1800000 ms
  ```

  Each research part is counted as the token cap reserves it: its request, built as the review builds it, at the worst case its provider states. The expected figure counts those parts at about a third of their bound, since the bound is one token per byte and code takes about one per three, and counts no vote. How many findings research reports is not known before it runs, so the votes are in the worst case alone, `maxFindings` votes of each lens at the bound of the longest finding that cites the largest file, and the review's token cap still stops a review that spends more. `<n> of them reserved at once` is what the calls that run together reserve: the largest bounds among the research parts and the votes, as many as `concurrency` allows.
- **The gate.** The review may finish under the cap when the research's expected spend and what the calls in flight reserve are within `maxReviewTokens`. When they are not, quorum sends nothing and exits `2`, after the estimate, with one line that names the flag, a way out and the cap:

  ```text
  Error: --path: may not finish under the review's token cap of 2000000 tokens: its research alone expects about 2635809, with 672656 reserved at once: name a narrower path, raise maxReviewTokens, or pass --large to review what the cap allows
  ```

  `--large` runs the review all the same, and reviews what the cap allows: each call still reserves its worst case before it is sent, so the cap holds, and the parts it cannot fund are not sent. The review ends incomplete, exit `4`, with a `token-cap` gap that counts them, and the files they hold are `unreviewed` or `partial` in each profile's coverage, with the reason `token-cap`: [The token cap](./20-configuration.md#the-token-cap). `--large` without `--path` is a usage error.
- **The numbers.** Quorum's own tree, some 4 MB, is a path review that needs `--large` at the default cap of 2000000 tokens: `--path .` expects about 5.2 million tokens of research at a window of 32768, in 513 parts, and 2.6 million at 200000, in 155. One directory of it does not: `--path src/core`, with its specs left out by `exclude`, expects about 250000 and 170000, and reserves 131072 and 223240 at once, so it runs. To review a codebase without `--large`, name the directories that matter, raise `maxReviewTokens` ([The limits of a review](./20-configuration.md#the-limits-of-a-review)), or use a model with a larger window, which needs fewer parts.
- **It is an estimate.** A model that reports its usage settles each call at what it spent, usually well under the bound, and the votes run only for the findings research reports, so a review that is held may have finished and one that fits may stop. The ledger holds the cap at run time, whatever the estimate says. The library states the same figures: [`estimate`](../95-reference/30-library-api.md#estimate).

## How quorum runs git

The git sources run git through one runner, `src/git/run.ts`. It is the only code that starts git:

- **Git 2.41 or later, the system's.** Quorum ships none, and the source needs `--attr-source`, which came with 2.41. An older git, no git, a version that cannot be read and Windows exit `2`: `--range: needs git 2.41 or later, and this git is 2.39: upgrade it, or pipe a diff in`, `--range: needs git 2.41 or later on PATH, and none was found: install it, or pipe a diff in` and `--range: the git sources run on Linux and macOS: on Windows, pipe a diff in`. The npm package and the binary use the git on `PATH`, and the container image holds none: in a container, pipe the diff in.
- **No shell, a closed set of calls.** Each call is a typed operation whose argument vector the runner builds, and every id in it is checked first, as 40 or 64 lowercase hexadecimal characters. Nothing a user typed reaches git but a revision, once.
- **The pins** go before every command and after every `diff`:

  | Pin | What it stops |
  | --- | --- |
  | `--no-pager`, `core.pager=cat`, `GIT_PAGER=cat` | A configured pager, which ran under a pseudo-terminal |
  | `core.fsmonitor=false` | A configured file-system monitor, which ran on any command that reads the index |
  | `core.hooksPath=/dev/null` | A hooks directory the config names |
  | `--no-ext-diff`, `--no-textconv` | An external diff program and a text converter, which a config or an attribute names |
  | `--attr-source=<base>`, `core.attributesFile=/dev/null` | The checkout's `.gitattributes`, which is the change's own, and the user's attributes file: the base commit's attributes are read instead, `HEAD`'s for the local changes |
  | `--no-replace-objects`, `GIT_NO_REPLACE_OBJECTS=1` | A replace ref that swaps one object for another |
  | `--literal-pathspecs`, and `--` after every diff | A name read as a pathspec or as a revision: a tracked file named like a commit id made `git diff <id> <id>` fatal |
  | `--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`, `diff.autoRefreshIndex=false` | Any write to the repository: a diff against the working tree rewrote `.git/index` |
  | `safe.bareRepository=explicit` | A bare repository committed in the tree, entered from inside it |
  | `core.quotePath=true`, `core.bigFileThreshold=512m`, `diff.suppressBlankEmpty=false` | A setting that changes how a name or a blank line is written, or which file counts as binary |
  | `--unified=3`, `--inter-hunk-context=0`, `--diff-algorithm=myers`, `--indent-heuristic`, `--full-index`, `--no-renames`, `--no-relative`, `--submodule=short`, `--ignore-submodules=none`, `--no-color`, `--src-prefix=a/`, `--dst-prefix=b/`, `-O/dev/null` | `diff.context`, `diff.algorithm`, `core.abbrev`, `diff.renames`, `diff.relative`, `diff.orderFile`, `color.ui`, the `ignore` setting of `.gitmodules` and the other settings that reshape a diff: the bytes are the same under any config |

- **The environment is an allowlist.** A child gets `PATH`, `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and, when the parent holds them, the `GIT_` variables that name a repository or a config file (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`). Quorum sets `LC_ALL=C`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_NO_LAZY_FETCH=1` and an empty `GIT_ALLOW_PROTOCOL`. Every other variable is dropped: `GIT_DIFF_OPTS` and `GIT_EXTERNAL_DIFF` reshaped and ran a diff, and `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_TRACE*` and a model's key stay out of git's environment.
- **No lazy fetch, and no write to the repository.** In a partial clone git fetches a missing object on demand. `GIT_NO_LAZY_FETCH=1` and an empty protocol allowlist, which refuses every transport, stop it on every release, so a missing object fails closed. A source never writes to the repository through git under these pins: no index refresh, no lock, no ref. Under `--local`, a global or system clean filter that quorum lets run (git-lfs, say) is the one exception, and can write to `.git` (`.git/lfs/objects`).
- **The repository must be the working directory's own.** Quorum reads the git directory from the working directory, then again from the top level it found, and refuses when they differ, so a `core.worktree` cannot point it at another repository: `--range: the repository's work tree belongs to another repository or to none (core.worktree, GIT_WORK_TREE): run quorum in a clone you made`. A working directory in no work tree exits `2` too, and so does a repository another user owns, which git refuses itself: `--range: git refuses this repository, as another user owns it: add it to safe.directory if you trust it, or pipe a diff in`.
- **A revision is never an option and never echoed.** It must not be empty or start with `-`, it reaches git once, after `--end-of-options`, as `<revision>^{commit}`, and every later call uses the full ids git printed. A failure to resolve one is reported without git's own message, which quotes the revision as typed.
- **The `git` on `PATH` must come from a place a pull request cannot write,** as `claude` must. Quorum looks it up in the absolute entries of `PATH` only, and has no setting to name another: [Where the command comes from](./20-configuration.md#where-the-command-comes-from). A `git` the pull request supplies would run with the job's rights and could print any diff.
- **Every failure is one line.** A git call that fails is `Error: git diff failed (exit 128): "..."`, git's stderr cut to 500 characters and written as a JSON string, exit `3`. A call that passes its 120-second deadline is `git diff did not finish within 120000 ms`. What git prints is capped at 16 MiB.

What the pins cannot promise, and what to do about it: [Git, run by quorum](../30-security/10-threat-model.md#git-run-by-quorum).

## Provenance

The result records the source in [`meta.source`](../95-reference/20-json-result.md#the-source). A diff file or stdin is `{ "kind": "diff" }`. A range is the full ids git resolved and never the revisions as written:

```json
{
  "kind": "range",
  "base": "<40 hexadecimal digits>",
  "mergeBase": "<40 hexadecimal digits>",
  "head": "<40 hexadecimal digits>",
  "objectFormat": "sha1"
}
```

`--local` and `--staged` record `{ "kind": "local", "head": "<40 hexadecimal digits>", "objectFormat": "sha1" }` and the same with `"kind": "staged"`: `head` is the commit the diff is against, and `null` before a first commit. No file name is recorded.

A path review records the commit and what it selected:

```json
{
  "kind": "paths",
  "commit": "<40 hexadecimal digits>",
  "paths": ["src", "docs"],
  "skips": true,
  "objectFormat": "sha1"
}
```

`commit` is the full id `--at` resolved, `paths` the normalized selections in order, each once, `.` for the whole tree, and `skips` whether the default skips applied. The result lists each file left out, with its rule, in `meta.leftOut`.

## Next

[Configuration](./20-configuration.md) — the config file and the trust it needs in CI, the `QUORUM_*` variables, how the panel falls back to the finder's settings, the context size each provider states, the keys, `--print-config`, and the errors a bad setting causes.
