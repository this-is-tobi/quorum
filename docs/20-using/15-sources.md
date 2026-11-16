# Sources

Quorum reviews a diff, and a source makes one: a diff file or stdin, a range of commits, or the local changes. One source runs at a time, and the result records which one in [`meta.source`](#provenance). A source that reads a git repository runs git itself, in one hardened place, so that nothing the repository holds can run a program: [How quorum runs git](#how-quorum-runs-git).

## Choosing a source

| Source | Flag | What it reviews | Runs git |
| --- | --- | --- | --- |
| A diff file or stdin | `quorum <diff-file>`, or a pipe | The diff it holds, as it is | No |
| A range of commits | `--range <base>...<head>` | What `<head>` changed since it left `<base>` | Yes |
| The local changes | `--local` | What `git add -A` would commit: the staged, the unstaged and the untracked changes | Yes |
| The staged changes | `--staged` | What the next commit holds | Yes |

Two sources in one command are a usage error, exit `2`, before any git and any config: `Error: --range: cannot be given with a diff file: give one source`. The sources are taken in the order diff file, `--range`, `--local`, `--staged`, and the second one present is refused, naming the first: `--staged: cannot be given with --local: give one source`. So is `--range` twice (`--range: takes one range`), `--range`, `--local` or `--staged` with `--print-config`, which reads no diff, and `--trust-repo-config` without `--local` or `--staged` (`--trust-repo-config: needs --local or --staged`).

A git source reads no stdin: a diff piped in beside `--range`, `--local` or `--staged` is ignored. A pipe cannot be told apart from no diff in CI, where stdin is rarely a terminal, so quorum does not refuse it.

## A diff file or stdin

A diff file is the one argument of `quorum <diff-file>`, read as UTF-8. With no argument quorum reads stdin until it closes, and when stdin is a terminal it refuses with `no diff given` instead of waiting for input. Nothing is left out, and the diff is reviewed as it is made: whatever its producer pinned or did not pin is what quorum reads, so make it as [Using it in CI](./10-cli.md#using-it-in-ci) says, or review a range.

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
- **A hook.** In a pre-commit hook, `quorum --staged` reviews the index git is about to commit. Where git points the hook at another index through `GIT_INDEX_FILE`, as it does for some forms of `git commit`, quorum passes that variable on to its git, so it reads that index.

### Trust

A diff of the working tree runs the clean and process filters an attribute names, whatever the flags say. A repository someone else made can name such a program in its own config, and `--local` would run it with the job's rights. So both flags first read the filter settings (`filter.<name>.clean`, `.smudge` and `.process`) with the scope each came from, and refuse a repository whose own config names one:

- **A filter in the repository's own config exits `2`:** `--local: the repository's own config names a filter program, which a working-tree diff runs: pass --trust-repo-config if the repository is yours, or review a range`. Any key whose scope is not `system` or `global` refuses, the repository's, its work tree's, the command line's and a scope git adds later, whatever its value. A diff of the index runs no filter, and `--staged` is refused all the same: one rule covers both flags.
- **`--trust-repo-config` says the repository is yours,** and lifts the refusal. A repository that needs a filter of its own config, as `git-crypt` and `git lfs install --local` set up, needs the flag. It is a usage error without `--local` or `--staged`.
- **Your global and system filters run** as they do with your own git: they are your own.
- **Attributes come from `HEAD`.** The diff is made with `--attr-source=<HEAD>`, so the `.gitattributes` of the working tree, which the change may have edited, does not choose what a file goes through.

What is left once the check passes: [Git, run by quorum](../30-security/10-threat-model.md#git-run-by-quorum).

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

## Next

[Configuration](./20-configuration.md) — the config file and the trust it needs in CI, the `QUORUM_*` variables, how the panel falls back to the finder's settings, the context size each provider states, the keys, `--print-config`, and the errors a bad setting causes.
