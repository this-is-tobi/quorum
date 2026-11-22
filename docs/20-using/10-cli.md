# The CLI

The `quorum` command reviews one diff with the profiles its config selects, the security profile alone by default, writes the report on stdout and exits with a code that says what to do with it. This page is its whole surface: the invocation, what it reads, what goes to stdout and stderr, the report, every exit code, and how a CI job should read them. Its settings are a config file that `--config` or `QUORUM_CONFIG` names and the environment variables, on [Configuration](./20-configuration.md). Its three subcommands are `quorum report`, which renders a result a review saved, `quorum bench`, which measures configurations on a suite of bugs, and `quorum mcp`, which serves the review as a tool to an agent: [quorum report](#quorum-report), [quorum bench](#quorum-bench) and [quorum mcp](#quorum-mcp).

```text
Usage: quorum [options] [diff-file]
       git diff | quorum [options]
       quorum --range <base>...<head> [options]
       quorum --local | --staged [options]
       quorum --path <path> [--at <rev>] [options]
       quorum bench [options] <suite>
       quorum report [options] [<result>|-]
       quorum mcp [options]

Options:
  -c, --config <path>      Read this config file, over QUORUM_CONFIG
  -p, --profile <id>       Run only this profile; repeat it to run several
      --range <range>      Review a range of commits, written <base>...<head>
      --local              Review the local changes: staged, unstaged and untracked
      --staged             Review the staged changes: what the next commit holds
      --trust-repo-config  Run --local or --staged where the repository's own config names a filter program
      --path <path>        Review the files under a path at a commit; repeat it to review several
      --at <rev>           The commit --path reads, HEAD by default
      --no-default-skips   Review in --path the vendored, lockfile, minified, binary and test files too
      --large              Does nothing, and goes in a later release: a --path review's token cap follows its estimate
      --send <path>        Send a file held as a secret to the models all the same; repeat it to send several
      --allow-incomplete   Exit 0 instead of 4 when every gap is a vote that failed in passing: a dropped connection, a timeout, or an HTTP 408, 409, 429 or 5xx
      --fail-on <level>    Exit 1 for a kept finding at or above high, medium or low, or never with none; <profile>=<level> sets one profile
  -f, --format <format>    Write the report on stdout in this format: text, json, brief, markdown, payload or sarif; text on a terminal, else json
  -o, --output <output>    Also write a report to a file, written <format>=<path>; repeat it to write several
      --color <when>       Color the text report and the live view: auto, on a terminal unless NO_COLOR is set; always; or never
      --progress <mode>    Show progress on stderr: auto, live on a terminal and plain lines elsewhere; live; plain; json; or none
      --view <view>        Show the full result, or the public view with public: no reasoning, discarded findings, models or usage
      --state <dir>        Save every answered call in this directory, and reuse the calls it holds; a path review on a terminal keeps them in the user's cache by default
      --no-state           Keep no answered call, not even in a path review's default directory
      --print-config       Print the resolved config, keys redacted, and exit
  -h, --help               Print this help and exit
  -v, --version            Print the version and exit
```

```bash
quorum ./my.diff
git diff origin/main...HEAD | quorum
quorum --range origin/main...HEAD
quorum --local
quorum --staged
quorum --path src --at v1.2.0
```

## The invocation

- **One argument** is the path of a diff file, read as UTF-8.
- **No argument** reads the diff from stdin, until it closes. When stdin is a terminal, quorum prints `Error: no diff given` and the usage, and exits `2`, instead of waiting for input.
- **A second argument** is an error: `Error: takes one diff file, and <n> more argument(s) were given`, then the usage, exit `2`.
- **A file that cannot be read** is an error, in one of three texts that hold no part of its path: `Error: the diff file does not exist`, `Error: the diff file is a directory` or `Error: the diff file cannot be read`, then the usage, exit `2`.
- **`--range <base>...<head>`** is a source in place of the file and stdin, and one source runs at a time: a diff file with `--range` is `Error: --range: cannot be given with a diff file: give one source`, then the usage, exit `2`. Quorum then runs git itself, once the config is read: [Sources](./15-sources.md).
- **`--local` and `--staged`** are sources too, for what is not committed yet: `--local` is what `git add -A` would commit, untracked files included, and `--staged` what the next commit holds. A second source is refused as `--range` is: `Error: --staged: cannot be given with --local: give one source`. A repository whose own config names a filter program exits `2` unless `--trust-repo-config` says the repository is yours: [Trust](./15-sources.md#trust). `--trust-repo-config` alone is `Error: --trust-repo-config: needs --local or --staged`.
- **`--path <path>`** is a source too, for the files under a path at a commit rather than a change: `--at <rev>` names the commit, `HEAD` by default, and the tree is read by id, never the working tree. It repeats, to review several paths. By default it skips vendored, lockfile, minified, test and binary files, each listed in `meta.leftOut`, and `--no-default-skips` reviews them; it always skips a file named as a secret, or whose text holds a credential, listed and flagged the same way, unless `--send` names it: [The files at a commit](./15-sources.md#the-files-at-a-commit). Quorum prints what a path review may cost before it calls a model, and derives its token cap and its deadline from that estimate, never holding the review for its size: [The bounds of a path review](./15-sources.md#the-bounds-of-a-path-review). `--at`, `--large` and `--no-default-skips` without `--path` are `Error: --at: needs --path`, `Error: --large: needs --path` and `Error: --no-default-skips: needs --path`, and a second `--at` is `Error: --at: takes one commit`.
- **A diff over 16 MiB**, on stdin or in a file, is an error: `Error: the diff is over 16 MiB, the most quorum reads`, then the usage, exit `2`. The bytes are counted as they arrive, and quorum stops reading there.
- **`bench`, `report` or `mcp` as the first argument** runs [the bench](#quorum-bench), [`quorum report`](#quorum-report) or [`quorum mcp`](#quorum-mcp), with the arguments after it, before any flag of a review is read. A diff file named `bench`, `report` or `mcp` is reviewed as `quorum ./bench`, `quorum ./report` or `quorum ./mcp`.

The flags go before or after the file:

| Flag | Effect |
| --- | --- |
| `-c, --config <path>` | Read this config file, over `QUORUM_CONFIG`; a relative path is read from the working directory, while `QUORUM_CONFIG` itself must be absolute. An empty path is a usage error, so the working directory is never read as a config |
| `-p, --profile <id>` | Run only this profile, over `QUORUM_PROFILES`. It takes one id, and repeats to run several: `-p security -p team`. An id that is repeated, malformed or unknown is a usage error before any model call |
| `--range <range>` | Review the commits `<base>...<head>`: what `<head>` changed since it left `<base>`, the merge base diffed with the head, read by git run as [Sources](./15-sources.md#how-quorum-runs-git) says. It takes one range, and no diff file beside it |
| `--local` | Review the local changes against `HEAD`, or the empty tree before a first commit: the staged and the unstaged changes, and the untracked files, which quorum reads itself and never through a link. No diff file beside it: [The local changes](./15-sources.md#the-local-changes) |
| `--staged` | Review what the next commit holds, the index against `HEAD`, with no untracked file. No diff file beside it |
| `--trust-repo-config` | With `--local` or `--staged`, say that the repository is yours, so a filter its own config names may run, as `git-crypt` and `git lfs install --local` need. Without it such a repository exits `2`. A usage error without `--local` or `--staged` |
| `--path <path>` | Review the files under `<path>` at the commit `--at` names: the tree read by id, written as a diff that adds each file, with the vendored, lockfile, minified, test, secret and binary files skipped and listed, a secret by its name or by a credential in its text. `<path>` is relative to the working directory. It repeats, to review several paths, and takes no diff file beside it: [The files at a commit](./15-sources.md#the-files-at-a-commit) |
| `--at <rev>` | The commit `--path` reads, `HEAD` by default. A usage error without `--path`, and it takes one commit |
| `--no-default-skips` | With `--path`, review the vendored, lockfile, minified, binary and test files too: [What a path review skips](./15-sources.md#what-a-path-review-skips). A gitlink and a Git LFS pointer are still skipped. So is a file named as a secret or holding a credential: it is not sent to the models, and it raises its `secret-file` flag all the same, unless `--send` names it. A usage error without `--path` |
| `--large` | Deprecated: it warns (`--large is no longer needed and does nothing`), does nothing, and goes in a later release. A `--path` review is no longer held at exit `2` for its size: its token cap follows its estimate, and its deadline is 24 hours: [The bounds of a path review](./15-sources.md#the-bounds-of-a-path-review). A usage error without `--path` |
| `--send <path>` | Send a file held back as a secret to the models all the same, whatever the source. The path is the one the diff writes and the `left out:` line prints, matched exactly: `--send ./.env` names no file, and the file stays held. It is relative to the repository's top level, where `--path` is relative to the working directory. It repeats, to send several, and adds to the config's `send`. An empty path is a usage error, before any config. A file it names is neither held, listed nor flagged as a secret, and widens what a provider receives: [Sending a held file](./20-configuration.md#sending-a-held-file) |
| `--allow-incomplete` | Exit `0` instead of `4` when every gap of a gating profile is a vote that failed in passing: a dropped connection, a timeout of its own, or an HTTP 408, 409, 429 or 5xx. That is an unreviewed finding, or a `vote-failed` gap, whose failed votes all failed so. Any other gap still exits `4`. A kept finding of a gating profile at or above its fail-on level, `high` by default, still exits `1` |
| `--fail-on [<profile>=]<level>` | Set the fail-on level, the confidence at or above which a kept finding of a gating profile exits `1`: `high`, `medium` or `low`, or `none` to fail nothing ([Gating](./40-profiles.md#gating)). `--fail-on medium` sets the level of every profile that runs, and `--fail-on security=none` that of the one profile it names, which wins over the level for every profile. Both win over the config's `failOn`, and no variable sets one. It repeats, once for every profile and once for each profile named: `--fail-on low --fail-on team=none`. Three refusals are usage errors, checked before the diff and any config, with the usage printed after the message and none repeating the value given: a value that is neither form, two levels for every profile, and a profile named twice. A profile that does not run (a typo, which would leave a gate weaker or missing) is a configuration error instead, refused with the configuration before any model call: exit `2` with the `Error:` line and no usage text. It names the profile when its id is safe to print, 64 characters at most. `low` while the policy's `low` is off acts as `medium`, with a warning. [`--print-config`](#printing-the-resolved-config) and `meta.profiles` show the levels a run uses |
| `-f, --format <format>` | Write the report on stdout in this format, `text`, `json`, `brief`, `markdown`, `payload` or `sarif`, the last three always the public view: [The report](#the-report). It takes one format, `text` when stdout is a terminal and `json` when it is not, whatever stdin is. Any other format, a second `--format` and `--format` with `--print-config`, which writes YAML, are usage errors before any config is read and any model call, and no message repeats the value given |
| `-o, --output <format>=<path>` | Also write a report to a file, in `text`, `json`, `brief`, `markdown`, `payload` or `sarif`: `--output json=result.json`. It repeats, to write several files, in one format or in several: `-o json=a.json -o text=b.txt`. The path is resolved against the working directory, and each file is written whole, through a new file in its directory and a rename, with the process's file mode and no color. A symbolic link at the path itself is never written through, but the directories of the path are followed, so in CI name a path whose directories a pull request cannot write, such as one under `$RUNNER_TEMP`. Exit `2`, before any config is read and any model call, for a value that is not `<format>=<path>` (a path of `-` is not one, nor is a path that ends in `/` or `\`), two outputs to one path, `--output` with `--print-config`, and a path that is a symbolic link, is no regular file (a directory is none) or lies in no directory. No message repeats the path or the value given: [Files](#files) |
| `--color <when>` | Color the text report and the live view: `auto`, the default, colors when stdout is a terminal and `NO_COLOR` is unset or empty, `always` and `never` decide alone. Only `NO_COLOR` is read: `FORCE_COLOR` and the `CLICOLOR` variables are not. Of the reports only the text report is ever colored, never a JSON or a brief one, whatever `--color` says; the live view is colored on a terminal, and `NO_COLOR` or `never` removes it and keeps the block. It takes one value, and any other value or a second `--color` is a usage error before any config is read and any model call: [Colors](#colors) |
| `--progress <mode>` | How stderr shows the review: `auto`, the default, is `live` on a terminal and `plain` elsewhere; `live` draws a block under the log lines; `plain` writes one line for each event worth one, with a heartbeat; `json` writes each event as a JSON line; `none` writes the warnings and the errors alone. Over `QUORUM_PROGRESS`. It takes one mode: any other value, a second `--progress`, `live` off a terminal and `json` with `--view public` are usage errors before any config is read and any model call: [The modes](#the-modes) |
| `--view <view>` | Write the full result, `full`, the default, or the public view, `public`: the result less each vote's reasoning and error, the discarded findings, the providers and models, the usage and each gap's detail, for a log or an artifact a stranger can read: [The public view](../30-security/30-output-handling.md#the-public-view). It applies to every format, `json`, `text` and `brief`, to every `--output` file (`markdown`, `payload` and `sarif` are the public view whatever it says) and to stderr, whose banner names each provider by its config key and whose gap and dropped-finding lines carry no detail or reason, and whose `Error:` line after the config is read is in fixed words: [stdout and stderr](#stdout-and-stderr). The exit code is the same. It takes one value: any other value, a second `--view` and `--view` with `--print-config` are usage errors before any config is read and any model call, and no message repeats the value given |
| `--state <dir>` | Save every call the review paid for in `<dir>`, and reuse what it already holds, so a rerun reuses every call it holds for a request sent as it was: [Saved state](./20-configuration.md#saved-state). Each research call whose reply passed its envelope check and each vote that parsed is saved as it completes, and a research reply that was cut off or listed as many findings as it was asked for at most as a marker that sends its part straight to recovery; a failed call is never saved. A rerun reuses a stored reply only for a request sent as it was, checks it as a fresh reply, and spends nothing on it: `reused from --state: <r> research call(s), <v> vote(s)` on stderr says how many. The directory is made with mode `0700` when it is missing; one that exists must be a directory, no link, owned by you, writable by no one else, empty or made by quorum, and outside every git work tree. Any other is a configuration error, exit `2` before any call, that names `--state` and never the path. It takes one directory: a second `--state`, an empty one and `--state` with `--print-config` are usage errors before any config is read, and no message repeats the value given. A rerun still pays the calls that failed, about the calls in flight more (`concurrency`, or up to 16 with lanes), and every call of a provider whose settings changed, and a path review's estimate does not read the store. Whoever can write it writes a part's review, so in CI name a directory under `$RUNNER_TEMP` (or the runner's own temporary directory), never one in the checkout or in a cache another job can write: the work-tree check covers a git checkout only, and a workspace with no `.git`, such as a downloaded archive, that holds a planted directory passes every check. Not under `quorum mcp`, because its calling agent could write the directory, and not in the bench, which must call the model. A path review on a terminal needs no flag: see [the default state directory](#the-default-state-directory) |
| `--no-state` | Keep no answered call, not even in a path review's default directory ([below](#the-default-state-directory)). It is a usage error with `--state` and with `--print-config`, before any config is read: `--no-state: cannot be given with --state`, `--print-config: reads no diff and calls no model, so it takes no --no-state` |
| `--print-config` | Print the resolved config as YAML on stdout, every secret redacted, and exit `0`, reading no diff and calling no model: [Printing the resolved config](#printing-the-resolved-config). A diff file, `--range`, `--local`, `--staged` or `--path` with it is a usage error |
| `-h, --help` | Print the usage on stdout and exit `0`, reading neither a diff nor a config. It wins over `--version` |
| `-v, --version` | Print `quorum <version>` on stdout and exit `0`, reading neither a diff nor a config |

A value that starts with `-` takes the form `--flag=value`, as `--config=-odd.yaml`: `--config -odd.yaml` is an error, since quorum cannot tell the value from a flag. With the npm package's command or the binary, `--` ends the flags, so `quorum -- --help` reads a file named `--help`. Under `bun run start`, Bun itself drops the first `--`, so `bun run start -- --help` prints the help. An unknown flag, a flag without its value, a value given to a flag that takes none, and an empty `--config` are usage errors: `Error:` and what is wrong (`Unknown option '--nope'`), then the usage, exit `2`. The message names the flag and never the value given with it.

## What it reads

A unified diff:

- **A git diff**, as `git diff` or `git format-patch` writes it, is split into one section per file at its `diff --git` lines. Paths with or without the `a/` and `b/` prefixes are read, a file renamed under those prefixes is read under its new path, and a name git quotes is decoded.
- **A diff without `diff --git` headers**, as plain `diff -u` writes it, is one section that stands for any file.
- **A file the diff shows no content of**, a `Binary files … differ` line, a `GIT binary patch` or a submodule's commit, is listed in `meta.leftOut`, and every profile records it as a gap: exit `4` for a gating profile, whatever the flags. Its section still reaches the models: [A file left out](../95-reference/20-json-result.md#a-file-left-out). A file a path review skips is listed too, as `skipped` with its rule, and is no gap.
- **A file named as a secret, or holding a credential**, is held back from every source: no model is sent any of it, `meta.leftOut` lists it as `secret` with its `rule`, a `secret-file` flag says why, and every profile records a gap, exit `4` for a gating profile, whatever the flags. A change that deletes a file named as a secret whole lists it as `deleted-secret` and is no gap, and a deletion of a file held for a credential in it is a gap like any other. `--send` or the config's `send` sends one all the same: [Files held back as secrets](./15-sources.md#files-held-back-as-secrets).

A finding must cite a line of the new file inside one of the diff's hunks and, when the diff has per-file headers, one of its files, or it is dropped with a reason. The finder's path is matched against the diff's as given, trimmed, without an `a/`, `b/` or `./` prefix, decoded from git's quoting, and last by the one diff path that ends with it or that it ends with, since models often shorten paths. Each voter receives the section of the cited file or, when its window does not hold the section, its header and the hunks nearest the cited line ([Research in parts](./20-configuration.md#research-in-parts)); it receives the whole diff when no single section matches.

A blank diff, empty or only whitespace, is reviewed without calling a model.

Besides the diff, it reads the environment: the `QUORUM_*` variables of [Configuration](./20-configuration.md#the-environment-variables), and the variable that names a `claude-code` provider's executable, `QUORUM_CLAUDE_CODE_COMMAND`. It is an absolute path, or a bare name found in the absolute entries of `PATH`, and it wins over a code config's `command`. A relative path and a `.cmd` or `.bat` file are refused with exit `2`, and a YAML or JSON config never names one: [Where the command comes from](./20-configuration.md#where-the-command-comes-from).

## stdout and stderr

**stdout carries only the report**: the text report when stdout is a terminal, the JSON result when it is a pipe or a file, or the format `--format` names, written once the review ends: [The report](#the-report). When the run exits `2` or `3`, or `130` because the first signal came before the review ran or a second one quit it, nothing was reviewed and stdout stays empty, but for an `--output` file that cannot be written, which exits `3` after the report is on stdout. An interrupt during the review exits `130` with the report on stdout: [Interrupting a review](#interrupting-a-review). With `--print-config`, stdout carries the config's YAML instead, and nothing else. On a terminal stdout carries the text report, and the lines of stderr, written as the review runs, still come before it, but for the summary, which comes after it: [The summary](#the-summary).

**stderr carries everything else**, in this order: the `warning:` lines, the banner, a path review's estimate, the progress lines while the review runs, the summary once the report and the `--output` files are written, and an `Error:` line when it fails. After the flags are read, every line goes through one writer, at one of five levels: `warning` (the config's and the state directory's lines), `banner`, `estimate`, `notice` (`empty diff: nothing to review`, `reused from --state: ...` and `interrupted`) and `error`. The review's own events are the progress lines, which the writer folds into what it knows of the review: the plain lines below are what it writes with no terminal to draw on, which a CI log and a screen reader read, and on a terminal it draws [a block under them](#the-live-view) instead: [The modes](#the-modes) says how the mode is chosen. A run that fails on its configuration has no banner: its `Error:` lines come after the `warning:` lines of the environment, which often explain them. Every line is inert: a hidden character is shown as `<U+XXXX>`.

```text
warning: RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
```

Each `warning:` line is printed once, before the banner, and holds no value: a deprecated variable or a deprecated `gating`, a variable nothing reads, a setting that cannot take effect. When the configuration is refused, the deprecation line and the line naming a variable nothing reads are still printed, before the `Error:` lines: `RESEARCH_BASE_URL` set to a value that is not a URL gives the deprecation line, then `Error: QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host`, and a mistyped `QUORUM_VOTER_MODLE` is named before the error that follows from it. The banner names the model of each provider and the origin of its endpoint: the scheme, host and port of its base URL, or of its preset's, never a path, a query, a key or credentials. A run with no config file has one provider, named `default`, built from the `QUORUM_RESEARCH_*` variables, Ollama's native API on this machine unless a variable sets a base URL on its own, a preset or a protocol; the voter variables add a second, named `voter`. A provider object that a config file defines reads `<model> @ the provider object <name>`, by its config key, and a `claude-code` provider, which has no endpoint, reads `<model> @ claude-code`: `Research (sonnet @ claude-code)...`. The second line is the provider every lens of the panel votes through; when the lenses vote through different providers it names each one: `Panel will use grounded (m @ http://localhost:11434), significant (v @ https://v.example)`. When several profiles run, every line of the banner starts with `[<id>] `, the profile's id. A usage or configuration error is reported instead of the banner; a blank diff adds `empty diff: nothing to review` after it.

With `--view public` the lines that a stranger could read in a CI log carry less, and every other line is as above: the banner names each provider by its config key alone, `Research (default)...` then `Panel will use voter`, or `Panel will use grounded (default), significant (voter)` when the lenses use two providers, with no model and no origin; a gap is `incomplete: <reason>`, then ` at "<file>"` when it has a file, with no detail; a dropped finding is `invalid finding dropped`, with no reason; and a failure after the config is read is written in fixed words, `Error: research reply unusable: <reason>`, `Error: <provider>: the call failed (<kind>)`, with ` <status>` after the kind for an HTTP failure, `Error: git <operation> failed`, then ` (exit <code>)` when git exited with one, or `Error: the review failed`. A provider found down is written as its message alone, which holds code words, numbers and the provider's id, without the provider's own message that follows it under the full view, but for one whose quota is used up, which is `<provider>: the call failed (<kind> <status>)` like any failed call, since it tells a stranger the account is out of money: [When the research call fails](#when-the-research-call-fails). A configuration error is written as it is. [The public view](../30-security/30-output-handling.md#on-stderr) says why.

### Progress lines

| Line | Printed |
| --- | --- |
| `estimate: <n> research part(s), about <t> tokens expected for them; then up to <v> vote(s), at most <w> tokens in all`, then `estimate: research about <t> tokens expected, at most <w> with every vote and every part recovered, <f> of them reserved at once; the review's token cap is <cap>, <where it came from>, and its deadline <ms> ms, <where it came from>` | Once, in a `--path` review only, right after the banner and before any call: one line for each profile, starting with `[<id>] ` when several run, then one for the whole review. `<t>` counts each research part's input at about a third of what the token cap reserves for it, and its reply at the lesser of its budget and 4096 tokens, and `<w>` is an upper bound with one attempt per call, before any retry: every vote at its bound, every part recovered and the calls an adaptation sends once more; no other source prints it. The cap and the deadline are the review's own: with `maxReviewTokens` unset the cap is this estimate's worst case, never below 2000000, and with `reviewTimeoutMs` unset the deadline is 86400000 ms, the longest allowed: [The bounds of a path review](./15-sources.md#the-bounds-of-a-path-review) |
| `estimate: research alone expects about <t> of the review's token cap of <cap> (<p>%): a review of this size needs a cap of about <n>: raise maxReviewTokens, or narrow the path` | Once, in a `--path` review only, after the estimate's total, when its research alone expects over half the token cap. `<n>` is the cap the review needs, rounded up to the next 100000: what research expects and the calls in flight reserve, with every vote at a third of its bound |
| `estimate: on <provider> a research reply asks for at most <n> of maxFindings <m> findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N` | Once per research provider in a `--path` review whose research request asks for fewer findings than `maxFindings`, since its reply budget holds fewer: a part whose reply lists `<n>` findings is split in two, so the review makes more calls than `<t>` counts |
| `warning: a large review: <n> research part(s) and up to <v> vote(s), about <t> tokens expected and at most <w>: Ctrl-C stops it and keeps what it read` | Once, in a `--path` review only, after the estimate, when `maxReviewTokens` is unset, so the cap follows the estimate, and the research's expected spend plus what the calls in flight reserve pass 2000000, the review that older releases held at exit `2`; a small review writes none: [The bounds of a path review](./15-sources.md#the-bounds-of-a-path-review). It is a `warning` line, so every progress mode writes it, `none` included |
| `warning: the token cap of <cap> (maxReviewTokens) holds about <h> of the <n> research parts this estimate expects: the review runs to the cap, and what it cannot pay for is a token-cap gap; unset maxReviewTokens to let a path review's cap follow its estimate` | Once, in a `--path` review only, after the estimate, when the config sets `maxReviewTokens` and the estimate's research does not fit under it: `<h>` is how many research parts, in profile order and the order they are sent, the cap holds beside what the calls in flight reserve |
| `warning: --large is no longer needed and does nothing: a path review's token cap follows its estimate` | Once, in a `--path` review given `--large`, after the estimate |
| `left out: <n> file(s): "<file>" (<reason>), … and <k> more` | Once, before the research starts, when the review leaves a file out: the count, the first five files as JSON strings with their reasons, a file a path review skipped as `(skipped: <rule>)`, a file held back as a secret as `(secret: <rule>)` or `(deleted-secret: <rule>)`, `<no path>` for a part of the diff that no header names, then how many more. `meta.leftOut` holds every one: [A file left out](../95-reference/20-json-result.md#a-file-left-out) |
| `flag: <code> at "<file>":<line> (<detail>)` | Once per [advisory flag](../30-security/30-output-handling.md#advisory-flags), before the research starts. It reads `at "<file>"` for a file name, such as the `secret-file` flag of a file held back as a secret or skipped by a path review, `at line <line>` for a diff without per-file headers, and nothing for the `secret-file` flag of the text no header names. A flag changes no exit code |
| `invalid finding dropped: <reason>` | Once per finding that cites code outside the diff. The reason reads `<file>:<line> is not in the diff`, or `line <line> names no file` |
| `<provider>: <n> calls in a row failed (<kind>[ <status>]): no more calls go to it in this review: <fix>` | Once per provider found down, at the moment its third call in a row ends, whatever profile or role asked it: it is called no more in this review, and the parts and votes it was never sent are `provider-down` gaps. `<fix>` is `check that the server at its origin is running` for `network`, `raise timeoutMs` for `timeout`, `raise stallTimeoutMs, or timeoutMs` for a `timeout` that was a stalled stream, `check apiKey` for an HTTP 401 or 403, `check baseUrl and model` for a 404, `lower concurrency or wait` for a 429 or a 5xx, `check protocol and baseUrl` for `invalid-response`, `check command` for `process` and `check the provider's settings` for any other: [When the research call fails](#when-the-research-call-fails). A provider whose reply says its credit, quota or spend limit is used up is found down at its first such failure, with no retry and whatever the count: `<provider>: the account's credit, quota or spend limit is used up (http 429): no more calls go to it in this review: add credit or raise the limit at the provider, or wait until it resets`, and under `--view public` `<provider>: the call failed (http 429)`. A provider found down by calls that were each cut on the way says so instead of naming the server: `<provider>: 3 calls in a row failed (network): no more calls go to it in this review: each call was cut after about 10m00s, likely by a proxy or load balancer on the way: make replies shorter, with a lower maxTokens or partTokens`. A call is cut when its last attempt failed with `network`, or an HTTP 502, 504 or 524, after at least a minute, and the length is the shortest of the streak's: [A gateway that cuts long calls](./30-providers.md#a-gateway-that-cuts-long-calls). A provider found down by replies with no answer says what they lacked instead: `<provider>: 3 calls in a row had no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt`, or `had no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt` |
| `<provider>: a reply was cut off at <o> tokens, below the <l> quorum asked for: the server caps replies near <o>: set maxTokens: <o>` | Once per provider in a review, the first time a call's final failure is a reply cut off below the limit sent: the server caps replies lower than quorum asked. A cut-off at its limit prints none: [What a reply lacked](./30-providers.md#what-a-reply-lacked) |
| `<provider>: a reply ended at the server's window after <i> input and <o> output tokens, below contextTokens <c>: set contextTokens to at most <i + o>` | Once per provider, the first time a call's final failure is a reply the server's window ended: the numbers are the reply's own counts. When they are not all known, or reach `contextTokens`, the line reads `a reply ended at the server's window, which is smaller than contextTokens: lower contextTokens` |
| `<provider>: reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt` | Once per provider, the first time a call's final failure is a reply that ended on its own with reasoning and no answer |
| `<provider>: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt` | Once per provider, the first time a call's final failure is a reply that ended on its own with nothing in it |
| `<provider>: thinking lowered to <level> for the rest of the review: <because>; set thinking to choose it yourself` | Once per provider in a review, when a probe of its thinking is answered or shows the server took the request (a reply cut off, empty, only reasoning, unreadable or refused by the model, or a timeout, a gateway's 504 or 524 included), or fails in any way but a 400 or 422 after a reply that held only reasoning. After a cut-off, any other failure of the probe says nothing and moves nothing. `<because>` is `a reply ran out of room while reasoning` or `a reply held only reasoning`: [What quorum adapts by itself](./20-configuration.md#what-quorum-adapts-by-itself) |
| `<provider>: its calls are cut after about <d> on the way: a call cut so is read as a reply cut off at its limit, and its replies are held to <h> tokens for the rest of the review` | Once per provider in a review, when two of its cut attempts ended at about the same length: each later call cut there is read as a reply cut off at its limit, so thinking is lowered once, where the provider may, and then the part is split. With `maxTokens` set the line ends `; lower maxTokens to about <h> to keep each call under it`, with every derived budget of the provider already under the cut it ends at `at its limit`, since nothing moved, and with no rate measured, `; make replies shorter, with a lower maxTokens or partTokens`. Under `--view public` it ends at `at its limit`, with no token count: [A gateway that cuts long calls](./30-providers.md#a-gateway-that-cuts-long-calls) |
| `<provider>: structuredOutput moved to prompt for the rest of the review: <because>; set structuredOutput to choose it yourself` | Once per provider in a review, when the probe of prompt mode is answered. `<because>` is `a reply in JSON mode was empty` or `the server refused the request's JSON mode` |
| `<provider>: the server refused thinking lowered to <level>: thinking stays as the server sets it for the rest of the review; set thinking to choose it yourself` | Once per provider in a review, when the server answered a 400 or 422 to the probe's lowered value: no request sends it again, and the 400 counts toward no provider being down |
| `<provider>: its calls stream without stream_options for the rest of the review: the server refused the field, so each call settles at its reservation` | Once per provider in a review, when the probe of a stream without options is answered, after a 400 or 422 that named `stream_options`: the server sends no usage then, so each call settles at its reservation: [Streaming](./30-providers.md#streaming) |
| `<provider>: its calls ask for whole replies for the rest of the review: the server refused streaming; set stream: false to choose it yourself` | Once per provider in a review, when the probe of whole replies is answered, after a 400 or 422 that named `stream` |
| `<provider>: its calls ask for whole replies for the rest of the review: the server answered a streamed call whole; set stream: false to choose it yourself` | Once per provider in a review, when a reply to a streamed request came back whole, as a JSON body: the provider asks for whole replies from then on, with no probe |
| `<provider>: <n> call(s) at once for now, cut from <from> after <failure>` | Each time a provider's lane is cut, with no `concurrency` set: a throttle (a 429 that is no used-up quota, a 503, 504, 524 or 529, or a timeout, a stall included) halved the lane's limit, at least 1. `<failure>` is `http 429` or `timeout` as the retry line writes it. The same under `--view public`: [Lanes](./30-providers.md#lanes) |
| `<provider>: the server serves <n> calls at once: its lane holds <n>` | Once per provider, when its lane begins, if the provider states the slots its server serves. No provider states them yet |
| `part <n> of <parts>: reply cut off at its limit of <l> tokens (<what>): split into <p> pieces, all read` | Once per research part that recovery split, once its pieces have answered, starting with `[<id>] ` when several profiles run: [Recovering a cut-off part](./20-configuration.md#recovering-a-cut-off-part). `<what>` is what the reply lacked, `reply` or `thinking`; with no known limit the line reads `reply cut off at its limit (<what>)`, for a reply cut on the way at the length its provider learned `reply cut on the way after about <d> (<what>)`, and for a reply the server's window ended `reply cut off at the server's window (window)`. A part split because its reply listed as many findings as it was asked for at most reads `its reply listed the <n> findings it was asked for at most` in its place. The end is `, all read` when every piece was read; else, when the floor left hunks unread, `; <h> hunk(s) of <f> file(s) left unread, cut off even alone: raise maxTokens, set thinking: low, or lower partTokens`; else `; <k> not read, see the gaps` |
| `--state: a stored reply failed its check: the call is made again` | Once per provider and role in a review run with `--state`, when a reply the state directory held failed the check a fresh reply passes: whoever wrote the directory wrote it, so it is not used and the call is made. It names no file, key or text: [Saved state](./20-configuration.md#saved-state) |
| `--state: a stored reply could not be read (<why>): the call is made again` | Once per reason, the first time an entry of the state directory is no regular file, is over 8 MiB, is a link, is no stored reply, holds another key or cannot be read. `<why>` is `is not a file`, `is over 8 MiB`, `is a symbolic link`, `is not a stored reply`, `holds another key` or `cannot be read` |
| `--state: a reply could not be saved (<code>): the review goes on without saving it` | Once per error code, when a write into the state directory fails: the review's verdict owes nothing to it |
| `warning: the default state directory <why>: the review keeps no answered call; pass --state <dir> to keep them elsewhere` | Once, before the banner, when a path review on a terminal would keep its calls in [the default state directory](#the-default-state-directory) and the store refuses it. `<why>` is a refusal of a `--state` directory (`is a symbolic link`, `lies inside a git work tree, ...`, `is owned by another user`, `cannot be created (<code>)`, ...), and never holds the path. The review goes on with no store |
| `--state: the default state directory could not be removed (<code>)` | Once, when a review that completed with nothing left for a rerun could not remove its default directory, whose files are its own and stay until you remove them |
| `reused from --state: <r> research call(s), <v> vote(s)` | Once, when the review ends, when it reused any call from the state directory; `meta.reused` holds the counts, which are 0 and 0 for a review that was given `--state` and reused nothing |
| `part <i> of <n>: answered in <time>, <t> tokens, <k> finding(s) listed` | Once per research part as it ends, starting with `[<id>] ` when several profiles run: the time from its first call's start (`4.3s` under 10 s, whole seconds under a minute, then `2m14s` and `1h02m09s`), the tokens its calls counted and the findings its replies listed. Under `--view public` it is `part <i> of <n>: answered in <time>`, with no tokens and no findings. A part that recovery split and whose pieces were all read adds `, in <p> pieces` to that line (`part <i> of <n>: answered in <time>, <t> tokens, <k> finding(s) listed, in <p> pieces`, and under `--view public` `part <i> of <n>: answered in <time>, in <p> pieces`). A review of 44 parts prints one for each, where it printed nothing between its banner and its totals |
| `part <i> of <n>: failed (<kind>[ <status>]): its files are a research-failed gap` | Once for a research part whose call failed, `<kind>` the failure's (`timeout`, `network`, `http 503`) and its HTTP status when it has one. A part whose reply could not be read as findings is `part <i> of <n>: its reply could not be read: its files are a research-failed gap` |
| `part <i> of <n>: <what>` | Once for a research part that was not read: `stopped by the token cap`, `stopped by the deadline`, `stopped by the interrupt`, `not sent: provider-down`, `not sent: too large for its model`, or `cut off at its limit even alone: its hunks are a reply-cut-off gap`. A part that recovery split and some of whose pieces were not read is `part <i> of <n>: split into <p> pieces, <r> read, <k> <why>`, each outcome counted: `failed`, `cut off even alone`, `too large for its model`, `stopped by the token cap`, `stopped by the deadline`, `stopped by the interrupt` or `not sent, its provider down` |
| `part <i> of <n>: <failure>, retry <a> of <r> in <s>s` | Once per retry of a research call, before the wait: `<failure>` is `http 503 after 3s` or `network after 10m00s`, the failure and how long the attempt ran, from the moment its request was sent to its failure (a minute or more before a `network` failure or a 502, 504 or 524 reads as a call cut on the way), or `timeout after <ms> ms` (the call's ceiling) with no second length, or, for a stalled stream, `stalled, no progress for <ms> ms` (a streamed attempt that showed no progress for its window: [The stall window](./30-providers.md#the-stall-window)), `<a>` the attempt that failed and `<r>` the retries its provider states, and `<s>` the wait in whole seconds, rounded up. A part recovery split says `part <i> of <n>, piece <p> of <q>`. A vote's retry prints none |
| `stopping: the review reached its deadline of <ms> ms: the calls in flight are stopped, and what is left is a review-deadline gap` | Once, when the review's deadline falls (`reviewTimeoutMs`, [The limits of a review](./20-configuration.md#the-limits-of-a-review)): no new call starts, and the parts and votes left are `review-deadline` gaps |
| `stopping: no new calls; the <n> call(s) in flight have <s> s to end; press Ctrl-C again to quit at once, without the result` | Once, when the review's first SIGINT or SIGTERM arrives while it runs: no new call starts, every wait ends, `<n>` calls are in flight and have the grace, 5 seconds, to end, and what is left is an `interrupted` gap: [Interrupting a review](#interrupting-a-review) |
| `[<elapsed>] research <d> of <n> part(s), <c> call(s) in flight, <r> retried; <t> of <cap> tokens; about <range> left` | In a minute with no other line, while the review runs: the time since it started, the research parts done (`panel <d> of <n> vote(s)` once the votes are asked), the calls in flight, the calls that were retried, the tokens spent against the cap, and the time left. `<range>` is the 25th to the 75th percentile of what the parts answered so far say (`12-16m`, `40-90s`, `90s-3m`), and the line says `estimating the time left` until 3 parts, or a tenth of the plan, have answered. Under `--view public` it leaves out the tokens. `quorum mcp` writes none |
| `incomplete: <reason> (<detail>)` | Once per gap, as it is recorded in `meta.incomplete`; [the reasons](../95-reference/20-json-result.md#incomplete-reasons) say what each detail holds |
| `<n> candidate(s) after dedup` | When research and dedup are done: the findings the panel judges |
| `<k> kept, <d> discarded, <u> unreviewed by panel` | When the review ends, a blank diff included |

When several profiles run, the `invalid finding dropped`, `incomplete` and `candidate(s) after dedup` lines start with `[<id>] `, the id of the profile they belong to. The same goes for each profile's line of the estimate. The `left out:`, `flag:`, provider-down and adaptation lines, the totals line, and the estimate's total, belong to the whole review and never do. The `part <n> of <parts>:` lines, with the retry's, belong to a profile, and do. The stopping line and the heartbeat belong to the whole review and never do.

### The summary

Once the report is on stdout and the `--output` files are written, stderr ends with the review's summary: how it went. It comes last, after everything else on stderr and after the report, so a terminal shows it below the report. Each line is left out when it has nothing to say, a review that ran no stage (a blank diff) writes none, and a run that fails writes none: its `Error:` line is the last.

| Line | Says |
| --- | --- |
| `time: research <d>, dedup <d>, panel <d>` | The time of each stage on the review's clock: the time during which some profile was in it, so profiles that run side by side count their time once, and the time between one profile's stage and another's counts for nothing; a stage no profile ended has none |
| `; the first estimate, <at> in, put research at <range>` | On the same line, when the time left was ever estimated: how long after research started the first estimate was read, and the whole research time it put, that time in plus the time left it gave (`30-31m`), to set against `<d>` |
| `; done in <total>, <i> tokens in and <o> out` | On the same line, left out only when the text report is above the summary, that is when stdout and stderr are both terminals and the format is `text`; else it is added, so a log beside a JSON result, or `quorum --path src 2> run.log` with a terminal stdout, still says what the review took and spent. Under `--view public` it is `; done in <total>` |
| `tokens: <p> percent of the cap of <cap>, <origin>` | The share of the review's token cap spent, rounded down so it never says `100 percent` of a cap that was not reached, and where the cap came from: `the default`, `maxReviewTokens` when the config sets it, and for a `--path` review `this review's estimated worst case`, or `the default, which holds this review's estimated worst case` when that is below 2000000. When several providers answered, `; <id> <i> in and <o> out` for each, joined by `, `. Left out under `--view public` |
| `calls: <n> research (<r> retried, <k> recovered into <p> pieces), <v> vote(s) (<w> retried); <id> ran <lo> to <hi> at once` | The calls the review made, each parenthesis left out at 0 and with it the parentheses, then each provider's lane, in the order they began: `<id> ran <lo> to <hi> at once` (`<id> ran <n> at once` when the lane never moved), its lowest and highest limit. A lane that sent no rate-limit headers and never moved from its start says `<id> sent no rate-limit headers, so it ran at most <n> at once: set concurrency to run more, if its gateway has room`: it had no header to grow on, and quorum does not guess a gateway's room. With `concurrency` set it is `<n> at once` once, and a result with no lane record has no clause. A call `--state` answered is not counted: it was not made. For each provider whose streamed calls answered, `; its longest first token <d>, its longest silence <d>` after its own lane's clause, else `; <id>'s longest first token <d>, its longest silence <d>`: the longest wait of any of its calls from the request to its first token, and the longest time between two signs of the stream's progress, the wait from the headers to the first data event included. A stall window is learned from the longest silence alone. Raise `stallTimeoutMs` if a slow provider's calls are cut as stalled |
| `gaps: <count> <reason> (<causes>): <fix>` | Each reason in `meta.incomplete`, with what its entries count, summed over the profiles and joined by `; `: the research parts for a part reason (`5 part(s) research-failed`, from the entries' `<k> of <n> research parts`) and the failed votes for `vote-failed`, so a run that lost 46 of 51 parts reads `5 part(s) research-failed (network): ...; 41 part(s) provider-down (network): ...`. The `token-cap`, `review-deadline` and `interrupted` gaps count the parts and votes their detail says they stopped (`5 part(s) and 3 vote(s) interrupted`; a research in one request counts as 1 part). An entry that counts neither parts nor votes is counted as itself, as `1 gap(s) binary`. The causes, for `research-failed` and `provider-down`, are what the failed calls said (`timeout`, `http 503`), and the fix follows the table below |
| `result: the text report above` | Where the report went: `the text report above` when stdout and stderr are both terminals and the format is `text`, else `<format> on stdout` (so `quorum --path src 2> run.log` writes `text on stdout` into its log, where nothing is above), each followed by ` (public view)` under that view, then `; --output <formats> written` (`json`, `json and sarif`, `json, sarif and brief`) |
| `resume: rerun with the same --state: its <n> answered call(s) are reused` | Last, when a rerun could fill what is missing: the review has an `interrupted`, `token-cap`, `review-deadline`, `provider-down`, `research-failed` or `vote-failed` gap, or a finding left unreviewed. It names the flag and the count of calls the review kept, the ones it wrote to the state directory or read back from it, and never the directory. A review run with `--state` always says `resume: rerun with the same --state: its <n> answered call(s) are reused`, the count possibly 0, and one that kept its calls in the default directory says `resume: rerun the same command: its <n> answered call(s) are reused`; a review with no directory says `resume: to keep the answered calls for a rerun, pass --state <dir>; this review kept none` |

The fixes, by reason:

| Reason | Fix |
| --- | --- |
| `token-cap` | `raise maxReviewTokens` |
| `review-deadline` | `raise reviewTimeoutMs` |
| `research-failed`, `provider-down` | The fix of each cause, joined by `, or `: `raise timeoutMs` for `timeout`, `raise stallTimeoutMs, or timeoutMs` for a `timeout` that was a stalled stream (the gap says `timeout, stalled`), `lower concurrency or wait` for a 429 or a 5xx, `check apiKey` for a 401 or 403, `check baseUrl and model` for a 404, `check that the server at its origin is running` for `network`, `check protocol and baseUrl` for `invalid-response`, `check command` for `process`, `set stream: false` for a 400 or 422 that refused a stream of a provider whose `stream` is `true`, for a used-up quota `add credit or raise the limit at the provider, or wait until it resets`, and for a call cut on the way (a `network` failure, or a 502, 504 or 524, after a minute or more) `make replies shorter, with a lower maxTokens or partTokens`; the same words as the provider-down line's, which adds the length of the cut. A `research-failed` gap with no cause says `see the gap in the report` |
| `reply-cut-off` | `raise maxTokens, set thinking: low, or lower partTokens`; for a provider that learned a cut on the way, `make replies shorter, with a lower maxTokens or partTokens`, since a larger limit does not help a call a path ends at a length: with several providers behind the gap, each one's fix, joined by `, or `, and when the fixes differ each ends with the ids of its providers in parentheses, in the order they came: `make replies shorter, with a lower maxTokens or partTokens (api), or raise maxTokens, set thinking: low, or lower partTokens (local)`; when every provider behind the gap gets the same fix, the line has no parentheses |
| `findings-capped` | `raise maxFindings` |
| `request-too-large`, `too-large` | `raise contextTokens, or lower partTokens` |
| `research-unusable`, `finding-unreadable` | `see the gap in the report` |
| `vote-failed`, `interrupted` | `see resume`: the resume line says how a rerun reuses the answered calls |
| `binary`, `submodule`, `secret` | None: the file is left out by design |

The summary names formats and never paths: neither an `--output` file's nor the `--state` directory's. It repeats nothing the report says (no finding, no verdict, no gap's detail), prints no model or server text, and passes every line through the same inertness as the others. Under `--view public` it leaves out the tokens, and a gap whose cause is a used-up quota shows its count and its cause alone, with no fix (`1 part(s) research-failed (http 429)`), since the fix would tell a stranger the account is out of money; every other gap keeps its fix.

### The modes

How stderr shows the review is its mode: `--progress <mode>`, else `QUORUM_PROGRESS`, else `auto`. Both take `auto`, `live`, `plain`, `json` or `none`; the flag wins over the variable, and a blank variable is unset.

| Mode | What stderr holds |
| --- | --- |
| `auto` | `live` when stderr is a terminal, `CI` is unset or empty and `TERM` is not `dumb`, else `plain` |
| `live` | The log lines, with a block of where the review stands redrawn under them: [The live view](#the-live-view) |
| `plain` | One line of text for each event worth one, and a heartbeat in a quiet minute, with no glyph, no color and no control sequence: [Progress lines](#progress-lines). It is what a CI log and a screen reader read |
| `json` | Each event of the review as one JSON line, and each line of the CLI's own as a `cli:line`: [JSON lines](#json-lines) |
| `none` | The `warning:` and `Error:` lines alone: no banner, no estimate, no progress and no summary |

Four mistakes are usage errors, exit `2` with the usage, before any config is read and any model call, each at the flag or the variable that chose the mode: `--progress: must be auto, live, plain, json or none` (and `QUORUM_PROGRESS: must be ...`), `--progress: takes one mode`, `--progress: live needs stderr to be a terminal: use plain`, and `--progress: json writes the library's events, which hold usage and server text: it cannot be given with --view public`. A usage error is text in every mode, since it comes before any review and the usage is a person's, and so are the three lines the process writes on its way out, whatever the mode: `interrupted` after a second Ctrl-C, the `Error:` line of a failure nothing caught, and the `Error: the run stopped without a result` line.

- **Plain mode is the screen-reader mode.** It never moves the cursor and never redraws, so a screen reader reads each line once, in order. Set `QUORUM_PROGRESS=plain` once, in a shell profile, and every review is plain on a terminal too.
- **CI gets plain lines with a heartbeat by default,** since a CI job's stderr is no terminal, or sets `CI`: a log holds the lines of the review and, in a quiet minute, one line that says where it stands, so no step is silent long enough for a runner to call it hung. `--progress none` gives a quiet log, with the warnings and the errors alone.
- **`live` off a terminal is refused,** not changed: an explicit setting that cannot be honored is a mistake to fix, and `--progress plain` is what to write.

#### JSON lines

`--progress json` is for a tool that reads the review as it runs. Each event of the review is written as the library hands it, one JSON line on stderr (`run:start`, `call:start`, `call`, `part`, `run:end`, and the rest of [the events](../95-reference/30-library-api.md)), and each line the CLI would write is a line of its own:

```text
{"type":"cli:line","level":"banner","text":"Research (qwen3.6:27b @ http://localhost:11434)..."}
```

The `level` is `warning`, `banner`, `estimate`, `notice` or `error`, and the `text` is the inert line. Every line passes `inertJsonLine`, so it holds no line break and no escape sequence, and a hidden character is an escape in its JSON text. JSON mode writes no summary: a tool has the events and the result. The events are the library's, whole: they hold usage, and text a server sent, so treat their strings as untrusted as you treat the JSON result's, and `--view public` refuses the mode.

### The live view

On a terminal, in `auto` and `live` mode, the review draws a block under its log lines: where each profile's research and panel stand, the calls in flight, the tokens spent and the time left. At 80 columns, 14 minutes in:

```text
───────────────────────────────────────────────────────────────────── 14m00s ──
security  research ███████░░░░░░░░░░░░░  17/44 parts · 3 finding(s) listed
calls     api 6 at once, growing   ⠹ p12 6m50s ~6.10k   ⠙ p19 1m55s ~2.31k
          ⠋ p20 1m08s keep-alives only   p21 40s   +23 to go
tokens    588k of 2.00M   ▁▁▄█▅▅▄█▁▁▅▁▅▁█▁▅▅▅▁  61 tok/s
time      about 13–17m left for research, then up to 150 votes
Ctrl-C stops the review and keeps what it read
```

The calls are `p20` for a research part, `p7.3` for the third piece of a part recovery split, `f12` for a vote on the twelfth finding, and `↻ p23 http 503, 4s` for a call waiting to retry. A call that streams its reply, which is each call of a provider that streams (every HTTP provider unless `stream: false`), has a spinner before its label, and after its time the output it has shown so far:

- **The spinner turns only when the call makes progress,** its output growing, so a spinner that stands still is a call that has been silent: the first thing to look at when a review seems stuck. Keep-alives, which show the server is there and say nothing of its work, do not turn it. The spinner has ten turns (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), and in ASCII four (`|`, `/`, `-` and `\`).
- **`~<tokens>`** is the output the call's current attempt has shown, an estimate until the reply ends (`~6.10k`): the larger of the server's own count and a quarter of the characters streamed. A retried attempt starts again from 0. Under `--view public` the count is left out and the spinner stays.
- **`keep-alives only`** is a call whose last sign was a keep-alive, with no output yet.
- **A call with no sign yet** has its spinner and its time alone. A call that does not stream (a `stream: false` provider, or `claude-code`) has no spinner: its label and its time.

The calls line starts with what each provider's lane holds, one entry per provider, joined by `; `: [Lanes](./30-providers.md#lanes). With `concurrency` set it is `<n> at once (concurrency)`, for every provider together, since the setting keeps one limit and no lane.

| Entry | Says |
| --- | --- |
| `<id> <n> at once` | The lane's limit at its start, before any change: a cut always names its throttle and a growth always says `growing` |
| `<id> <n> at once, growing` | The lane's last change was a growth: by one call, since the headers held it, or a regrowth toward its start after a cut. It stays after the last growth, at 16 too |
| `<id> <n> at once after <failure>` | The lane's last change was a cut, halving its limit after a throttle: `http 429`, `http 503`, `timeout` (a stall included). The limit grows back toward its start with no header |
| `<id> paused <s>s (<failure>)` | The throttle's `Retry-After` holds the lane's new calls for `<s>` seconds, at most 60; the calls in flight go on |
| `<id> paced <s>s` | The lane's calls wait `<s>` seconds, at most 60, for the rate-limit headers' reset, so none is sent into a limit already used up |
| `<id> <n> at once (slots)` | The lane holds the slots its provider states |

A pause and a pacing wait that have ended leave the entry of what the lane did last. A lane is listed from its first call, at its start, 4. The entry holds a provider's id, numbers and code words, never a header's value, so the public view shows it as it is.

The count after a bar is the findings the replies listed, until the panel has verified any. A profile line is each profile's, up to two; more are `and <n> more profile(s)`. Above the block, each log line that is worth keeping scrolls into the terminal's history and stays: `✓ part 3 of 44: answered in 2m14s, 38420 tokens, 2 finding(s) listed`, `↻ part 7 of 44: http 503 after 3s, retry 1 of 2 in 4s`, `△` for an adaptation and `✗` for a failure.

- **When it is drawn.** The first frame comes 500 ms after the review starts, so a short review never draws one: until then, and for a review that ends sooner, the log lines are written straight, glyph and color included, with no block. A redraw comes at most every 100 ms and only when the block changed, and each second for its timers; the time left is recomputed at most every 5 seconds, so it does not jump. Each frame is one write, wrapped in synchronized output, so a terminal never shows half of one, and the cursor is hidden while the block is on screen.
- **The rate** after the sparkline is the output tokens of the last minute, per second: the tokens a streamed call has shown as they come, and the rest of a call's reported output when it ends, each counted once. The minute slides, so the rate does not step as a cell of the sparkline rolls over, and it is told over at least 10 seconds, so the first seconds of a review do not read high. It is left out while the minute holds no tokens, and the sparkline stays.
- **The glyphs** are Unicode when the locale says UTF-8 (`LC_ALL`, else `LC_CTYPE`, else `LANG`), and on Windows when `WT_SESSION` is set or `TERM_PROGRAM` is `vscode`, a Japanese, Korean or Chinese locale excepted: those terminals often draw the block elements two columns wide. Anything else gets ASCII: `+` for an answer, `~` for a retry, `^` for an adaptation, `x` for a failure, `#` and `-` for a bar, `_.-=+*#` for the sparkline, `|/-\` for the spinner and `-` for every rule and dot. No glyph is an emoji.
- **The time left** is the 25th to the 75th percentile of the rates of the parts answered, over the planned tokens left. With lanes, each research provider has its own estimate: its parts left at its own answered parts' rates, over its lane's limit (at most its parts left), and the time left is the longest of them, so profiles on different providers side by side are not averaged into one. When the lanes' limits pass 16, the review's ceiling, they are scaled down together to 16. It reads `estimating` until every provider with parts left has answered the larger of 3 parts and a tenth of its plan. The votes are read over the lanes' limits of the lenses' providers summed (4 for one with no lane yet), at most 16, so a provider that only researches is left out. With `concurrency` set every profile is pooled over that one limit.
- **The width and the height.** Every line is cut to the terminal's width less one column, with an ellipsis, so no terminal wraps one. Below 80 columns the sparkline goes and the bars are 10 cells, below 40 the block is one line (`research 17/44 · 4 calls · 14m00s`) cut to the width less one with its ellipsis, so at 3 columns it is `r…` and at 2 it is `…` with the Unicode glyphs, and with the ASCII ellipsis of three dots there is no block at 3 columns or fewer, nor with either set at 1. The block holds at most 8 lines and at most the terminal's rows less two: when the rows are short the hint goes first, then the second calls line, the profile lines after the first, the tokens line and the time line, in that order, and under 4 rows the log lines are written as plain lines and no block is drawn. The width and the height are read at every frame, so a terminal that is resized is followed, at once when it sends its resize event and at the next second when a missed one does not.
- **Color** is the 16-color palette, around quorum's own glyphs alone: `✓` green, `↻` and `△` yellow, `✗` red, and the finished cells of a bar cyan. A name from a config or a diff is made inert before it is cut and is never colored. `--color never` or a `NO_COLOR` that is set and not empty removes the color and keeps the block; `--color always` never colors plain lines, since a stderr that is no terminal is plain, so a CI log holds no escape sequence of quorum's.
- **A terminal that stdout shares** shows the report in the right place. Nothing is written on stdout while the block is live: the block is erased, with the cursor shown, before the report's first line, so nothing of it is left between the log lines and the report, and the summary follows the report.
- **A terminal that is made narrower** while the review runs: the next frame erases as many rows as the old lines now take at the new width, then is drawn whole. A terminal that re-flows its rows, which is nearly every one in use (Terminal.app, iTerm2, GNOME Terminal and the other VTE terminals, Konsole, kitty, Alacritty, WezTerm, Windows Terminal, tmux), wrapped each old line into those rows, so the old block is erased exactly. One that does not re-flow (xterm, rxvt, st, GNU screen) cut each line instead, so the erase also takes the rows the wrap would have added above the block: a few log lines that were on the screen and are lost, once. They are never in the terminal's history, since they were never scrolled off it. Write `--progress plain` for such a terminal.
- **A failure of the view never ends a review.** A throw while the view folds an event, draws a frame or ticks turns the block off for the rest of the review: the block is erased as well as the terminal allows, the cursor is shown, and the lines that follow are written straight, as before the first frame.
- **The last line is the hint.** `Ctrl-C stops the review and keeps what it read` says what the first signal does. Once it has come, the line is `stopping: <n> call(s) end within <s> s; Ctrl-C again quits without the result`, with the calls still in flight and the seconds of the grace left, rounded up, counting down at each tick. It is the first line to go when the rows are short, and the one-line block of a narrow terminal has none.
- **No key is read.** Quorum sets no raw mode and reads no input, since stdin may carry the diff: Ctrl-C is the terminal's.

The terminal is left as it was found on every way out of the process: the end of the review, an `Error:` line (written after the block is erased), the second signal, an uncaught failure and the process's exit all erase the block and show the cursor. A `SIGKILL` runs no handler anywhere, and leaves the cursor hidden, as does a `SIGQUIT` (Ctrl-\), which quorum does not handle: `tput cnorm` or `reset` shows it again. On Windows a terminal's writes are asynchronous, so a crash there may leave the cursor hidden too (an assumption: no Windows terminal was tested).

The only control sequences quorum writes are cursor movement, erasure, the cursor's visibility, synchronized output and color around its own glyphs, and never an OSC sequence (a tab title, a link or a notification): [Output handling](../30-security/30-output-handling.md#the-live-view).

### Interrupting a review

The first SIGINT (Ctrl-C) or SIGTERM stops a review gently, and keeps what it read:

- **No new call starts, and every wait ends at once:** a call queued behind a call in flight, a call waiting for room under the token cap and a call backing off after a failure end where they are, sending nothing. One line says so, and how many calls are in flight (`stopping: no new calls; ...`).
- **The calls in flight have 5 seconds to end,** the grace (`INTERRUPT_GRACE_MS`). A reply that comes within it is read, checked and saved, as in any review, and a call still in flight at its end is cancelled.
- **The review resolves with what it read.** What the interrupt stopped is an `interrupted` gap of its profile: the research parts not read are unreviewed files, the findings it did not vote on are `unreviewed` with `interrupted` votes. No flag lifts it, `--allow-incomplete` included, and it is the verdict `interrupted`.
- **The report is written,** on stdout and in each `--output` file, and the summary follows with a `resume:` line. The exit code is `130`.
- **A second signal quits at once,** with `interrupted` on stderr, exit `130` and no result, for a provider that ignores the first or a run that must stop now.

A signal that comes before the review runs, while the source is read or the config loaded, has no review to keep: the run writes `interrupted`, nothing on stdout and exits `130`. A review that has already resolved is complete: a failure after it, such as an `--output` file that cannot be written, keeps its own `Error:` line and exit `3`.

A rerun with `--state <dir>`, or, for a path review on a terminal, the same command again ([the default state directory](#the-default-state-directory)), reuses the answered calls, so what the interrupt stopped is the only thing it pays for: the `resume:` line of the summary says it, with the number of calls kept. On a GitHub runner, signal the step's `quorum` process itself, which `exec quorum ...` does: [Reports for GitHub](./80-reports.md).

### The default state directory

A path review is the review whose spend is large, so on a terminal it keeps its answered calls without a flag, and a rerun of the same command reuses them: a run that stopped, or lost its provider late, loses none of what it paid for.

- **When.** A `--path` review, stderr a terminal and `CI` unset or empty, whatever `--progress` says, with neither `--state` nor `--no-state`. A diff, a range and the local changes keep nothing by default, nor does a review in CI, under `quorum mcp` or in the bench: a CI job starts clean, and a cache another job can write is the channel [Saved state](./20-configuration.md#saved-state) warns of.
- **Where.** `<cache>/quorum/state/<key>`, `<cache>` being the user's cache directory as Go's `os.UserCacheDir` finds it: `$XDG_CACHE_HOME` when it is absolute, else `$HOME/.cache`, and on macOS `$HOME/Library/Caches` whatever `XDG_CACHE_HOME` says. The `<key>` is the first 12 hexadecimal characters of the SHA-256 of the repository's top level as git prints it, so each repository has a directory of its own, and a review of other paths of it shares that directory. An environment with no absolute cache directory, and Windows, which has no path review, get no default. The missing parents are made with mode `0700`, after the work-tree check of the nearest one that exists, so nothing is made inside a work tree. No line names the directory.
- **Its checks** are the ones `--state` has: a link, a file, a directory another user owns or others can write, one inside a git work tree (a home directory kept in git, say) and one that holds files but no marker are refused. A refusal skips the default with one `warning:` line (`warning: the default state directory <why>: the review keeps no answered call; pass --state <dir> to keep them elsewhere`), and the review goes on with no store, with the exit code it has without one.
- **Its removal.** Once the review has resolved and its `--output` files are written, the directory is removed when nothing is left for a rerun to fill: no `interrupted`, `token-cap`, `review-deadline`, `provider-down`, `research-failed` or `vote-failed` gap and no unreviewed finding. Otherwise it stays, and the summary says how to resume: `resume: rerun the same command: its <n> answered call(s) are reused`. A removal that fails is one `--state: the default state directory could not be removed (<code>)` line. A removal clears the repository's default directory, a review of other paths of it included. Two path reviews of one repository at once share its default directory, so the one that finishes cleanly removes it, and the other's later saves fail with a warning and its `resume:` count counts calls that are gone: give each its own `--state` to keep both.
- **`--no-state`** keeps none, in every mode, and **`--state <dir>`** names another directory, which is kept as ever and never removed.

The directory holds code from the diff and model text, in the user's cache: [the threat model](../30-security/10-threat-model.md#saved-state) says what that costs, a backup of the cache among it.

## The report

`--format <format>` (`-f`) chooses what stdout carries once the review ends. There are six formats, and it takes one of them:

| Format | What it writes | For |
| --- | --- | --- |
| `text` | The review as a person reads it: each finding with its evidence, then the counts, what was left out and the verdict. The default on a terminal | You, at a terminal |
| `json` | The whole result as JSON. The default when stdout is a pipe or a file | A program, a CI job, `jq`: [The JSON result](../95-reference/20-json-result.md) has every field |
| `brief` | One line of counts and code words | A hook, a log, a status line |
| `markdown` | The summary a pull request or a job summary shows, always from the public view | A CI job: [Reports for GitHub](./80-reports.md) |
| `payload` | The JSON document `quorum-action` posts: the commit, the conclusion, the summary and the line comments, always from the public view | The Action: [The Action's payload](../95-reference/50-action-payload.md) |
| `sarif` | SARIF 2.1.0 for GitHub's code scanning: a result for each finding on a file of the diff, always from the public view | A CI job that uploads it: [Reports for GitHub](./80-reports.md#sarif) |

The default follows stdout alone: `text` when stdout is a terminal, `json` when it is a pipe or a file. Stdin plays no part, so a diff piped in does not make the report JSON, and a terminal on stdin does not make it text. A terminal is not always a person: `docker run -t`, and the pseudo-terminal that an IDE task or `script` allocates, make stdout a terminal where a program expected JSON. A script that reads the report names `-f json`, which keeps JSON there. A mistyped format, a second `--format` and `--format` with `--print-config` are usage errors, exit `2`, before any config is read and any model call: no diff is read from stdin for them, and no message holds the value given.

**`json`** is indented by two spaces and followed by a newline. A hidden character in a string is written as a `\uXXXX` escape, which a JSON parser reads back: [Output handling](../30-security/30-output-handling.md#what-the-cli-writes).

**`brief`** is one line and a newline, made of the review's status, its counts and its exit code:

```text
quorum: findings: 1 kept (1 high), 1 unreviewed, 1 gap, 1 left out (1 secret), 1 flag; exit 1
```

| Part | What it holds |
| --- | --- |
| `findings`, `incomplete`, `interrupted` or `pass` | The review's status, as the exit code says it: `exit 1`, `exit 4`, `exit 130` and `exit 0` |
| `<n> kept`, with `(1 high, 2 medium)` | The kept findings, then how many are `high`, `medium` and `low`, the levels that have some, left out when none has a level |
| `<n> unreviewed` | The findings a failed vote left undecided |
| `<n> gap` | The entries of `meta.incomplete` |
| `<n> left out`, with `(<n> secret)` | The files in `meta.leftOut`, then how many of them are secrets: held back by name or by a credential in them, including a deleted one, or skipped by a path review under the rule `secret`. The count is left out when none is |
| `<n> flag` | The advisory flags |
| `exit <code>` | The exit code the run returns |

It holds no file name and no model text, only counts and words the code wrote, so a hook or a log can carry it where a name or a claim must not go. It says nothing of where a finding is: for that, read the text report or the JSON. A review whose gaps `--allow-incomplete` lifted says `pass`, as its exit code does. A hook can run it on the local changes, print the line and fail on the exit code:

```bash
quorum --local --format brief
```

**`markdown`** is the summary of the review as GitHub shows it, written from the public view whatever `--view` says, with every text a model or the diff wrote in a code span or a fenced block: [Reports for GitHub](./80-reports.md).

**`payload`** is the document `quorum-action` posts as it is, written from the public view whatever `--view` says: the reviewed commit, the conclusion, the summary and a line comment for each finding on a file of the diff, as `inertJson` writes it: [The Action's payload](../95-reference/50-action-payload.md).

**`sarif`** is SARIF for GitHub's code scanning, written from the public view whatever `--view` says: one run, a result for each kept or unreviewed finding on a file of the diff, at an `error` level exactly when the finding sets exit 1, and a notification for each gap: [Reports for GitHub](./80-reports.md#sarif).

Every format says what the exit code says, and from the same place: the run decides its outcome once, prints the report from it and returns its code. A format never states a status the exit code does not.

### The text report

**`text`** is what a person reads on a terminal. For a review of a range, with one kept finding, one unreviewed, one binary file left out and one flag:

```text
quorum 0.6.0 · range 1f3a9c2...7b2e4d0 · security · 3 files

HIGH  security  src/auth/login.ts:42  CWE-89
  SQL built from the request's id parameter reaches db.query
      41   const sql = 'SELECT * FROM users WHERE id = ' + id
   >  42 + db.query(sql)
      43   return rows
  kept by 3 of 3 lenses

UNREVIEWED  security  src/session.js:20  CWE-338
  Session tokens come from Math.random, which is not a cryptographic generator.
         -   return crypto.randomBytes(32).toString('hex')
   >  20 +   return Math.random().toString(36).slice(2)
      21   }
  kept by 1 of 3 lenses, 1 vote failed

security (fail-on high): 1 kept, 1 unreviewed, 1 discarded
  1 of 3 files reviewed, 1 in part, 1 not
left out: 1 file
  "assets/logo.png" (binary)
gap: security binary, the diff carries no content for 1 binary file(s), listed
  in meta.leftOut
flag: hidden-characters at "src/session.js":20, U+202E on 1 added line(s)
took 41 s, 48120 tokens in and 4190 out
exit 1, findings: a gating profile kept a finding at or above its fail-on level
```

Its parts come in this order:

| Part | What it holds |
| --- | --- |
| The header | `quorum <version> · <source> · <profiles> · <n> files`. The source is `diff`, `range <base>...<head>`, `local on <head>` or `staged on <head>` (`local, no commit yet` before a first commit) or `paths at <commit>`, each commit cut to its first seven characters. The files are those of the first profile's coverage |
| Each finding | Its level, `HIGH`, `MEDIUM` or `LOW` for a kept finding and `UNREVIEWED` for one a failed vote left undecided, then its profile, `<file>:<line>` and its category; its claim; its evidence rows; and `kept by <k> of <n> lenses`, with `, 1 vote failed` or `, 2 votes failed` when a lens's vote failed. The findings are grouped by file, then by line, the kept and the unreviewed together. The discarded ones are only counted |
| Its evidence rows | The diff's lines around the cited one, each as a marker, a number, the diff's `+`, `-` or space, and the code. The cited row is marked `>`, the added and context rows are numbered from the cited line, and a removed row, which is no line of the new file, has no number. When no row shows the cited line, as in a hunk that only deletes lines, the rows are shown unmarked and unnumbered |
| Each profile | `<id> (fail-on <level>): <k> kept, <u> unreviewed, <d> discarded`, with `, <n> outside the diff` for the findings it dropped for citing code outside the diff. Then how many of the diff's files it reviewed, `, <p> in part`, `, <x> not` and `, <e> excluded` for the nonzero counts, or `the diff holds no file`. In the order the profiles ran, each at the level it ran with |
| `left out:` | The files of `meta.leftOut` when there are some: their count, the first five, one a line as the [progress line](#progress-lines) writes each, then `and <n> more` |
| `gap:` | One for each entry of `meta.incomplete`: its profile, its reason and its detail, a comma after the reason. A gap with no detail, or one of white space only, is `gap: <profile> <reason>`, with no comma |
| `flag:` | One for each [advisory flag](../30-security/30-output-handling.md#advisory-flags): its code, where it points and its detail |
| `took` | The time: `<n> ms` under a second, one decimal and ` s` from one second to ten, whole seconds and ` s` after. Then the tokens in and out, with the cost when the usage holds one, or `no token count reported` |
| `exit` | The verdict |

**The verdict is last**, because the end of the output is what stays on a terminal's screen, and it is the line to act on. It says what the exit code says, from the same outcome, in one of four lines:

| Line | When |
| --- | --- |
| `exit 1, findings: a gating profile kept a finding at or above its fail-on level` | A gating profile kept a finding at or above its fail-on level |
| `exit 4, incomplete: a gating profile has a gap or an unreviewed finding` | No finding reached a level, and a gating profile has a gap or an unreviewed finding |
| `exit 0, pass: no gating profile kept a finding to fail on, and none has a gap` | Nothing to fail on, and no gap |
| `exit 0, pass: incomplete, but --allow-incomplete lifted every gap` | `--allow-incomplete` turned an exit `4` into `0` |

**It is 80 columns wide**, counted in code points. A claim, a gap's detail and a flag's detail wrap at spaces, each continuation indented by two spaces. Nothing else is cut or wrapped, and neither is a word longer than a line: a path, a category, a row of code or a URL stays whole, since a cut could hide code, and the terminal folds the line.

**A path is bare or quoted.** A finding's path is written as it is when it holds ASCII letters, digits and `._/@+~=,-` only, so a terminal can link `path:line`. Any other path is a JSON string, as every other line of quorum quotes a file: `"src/my file.ts":42`. A space, a quote, a colon or a hidden character in a name can then never pass for the columns after it. **A tab in a row of code** is shown as four spaces.

Each line is inert: every hidden character in a claim, a category, a row of code, a file name or a detail is shown as `<U+XXXX>`, and a line that starts with `::` or holds `##[` has it broken, as on stderr: [Output handling](../30-security/30-output-handling.md#what-the-cli-writes).

### Colors

With color on, the text report colors these pieces, and nothing else:

| Piece | Color |
| --- | --- |
| `HIGH` | Bold red |
| `MEDIUM` | Yellow |
| `LOW` | Cyan |
| `UNREVIEWED` | Magenta |
| The location of a finding, `<file>:<line>` | Bold |
| The `>` of the cited row | Bold |
| The `+` of an added row | Green |
| The `-` of a removed row | Red |
| `findings`, `incomplete` and `pass` in the last line | Red, yellow and green |

A claim, a row of code, a category and a file name are never colored, and no piece but the ones above is. A line is colored only if its text is exactly what it is uncolored: a line that `::` or `##[` changes is printed without color. So no escape sequence reaches the terminal but quorum's own, around words quorum wrote.

`--color auto`, the default, colors when stdout is a terminal and `NO_COLOR` is unset or empty, as [no-color.org](https://no-color.org) says: any other value turns it off, `0` included. `--color always` and `--color never` decide alone, whatever stdout is and `NO_COLOR` says. `FORCE_COLOR` and the `CLICOLOR` variables are not read, so a variable a wrapper sets cannot put escape sequences in a log. Only the text report is colored, never a JSON or a brief one.

The live view on stderr is colored by the same flag and variable, around its own glyphs alone: `--color auto` colors it on a terminal unless `NO_COLOR` is set and not empty, `never` removes the color and keeps the block, and `always` colors it on a terminal and never colors plain lines, whatever stderr is: [The live view](#the-live-view).

### Files

`--output <format>=<path>` (`-o`) writes a report to a file as well as the one on stdout, in any format, repeated for as many files as needed. Each file is its format's report of the same review, so a job can have the brief line in its log and the JSON result in a file:

```bash
quorum --range origin/main...HEAD -f brief --output json="$RUNNER_TEMP/result.json"
```

The log holds one line of counts, and `$RUNNER_TEMP/result.json` holds the whole result, in a file the pull request cannot plant. A checkout is the pull request's: a file or a link it planted at a path there is in place before quorum runs, and a run that fails before it writes leaves it for the next step to read as the result. `$RUNNER_TEMP` is the job's own directory, outside the checkout.

- **The path** is the text after the first `=`, resolved against the working directory, so `json=out/r.json` and `text=./out/r.txt` are two files, and `json=a.json` with `text=./a.json` is one file named twice, a usage error. A path of `-` is refused, since it would write a file named `-` where a person means stdout, and so is one that ends in `/` or `\`, which names a directory and would write a regular file of the name before it: both are the usage error `--output: must be written <format>=<path>, the format text, json, brief, markdown, payload or sarif`. The format before the `=` is `text`, `json`, `brief`, `markdown`, `payload` or `sarif`, and the same format may go to several files.
- **Before any config is read and any call**, quorum checks each path, so a review never spends its tokens and then fails to write. A path that is a symbolic link, a dangling one included, is refused: `Error: --output json: is a symbolic link`. So are a path that is no regular file, as a directory is (`is not a regular file`), and one in a directory that does not exist (`is in no directory`): quorum makes no directory. A file that is there is replaced whole. Each is exit `2`, and each message names the flag and the format and never the path. Only the path itself is checked: the directories of the path are followed, so a link planted as one, `planted -> elsewhere/` for `json=planted/r.json`, writes `elsewhere/r.json`. In CI, name a path whose directories the pull request cannot write, such as one under `$RUNNER_TEMP`.
- **After stdout**, the files are written in the order given, each whole and not at all: to a new file in the file's own directory, then renamed over the path. The rename replaces a file, or a symbolic link at the path made since the check, and never writes through one. The file has the process's file mode, as a file made by the shell's `>` has, and no temporary file stays. A write that fails stops the rest and exits `3`, with the report already on stdout: `Error: --output json: cannot be written (ENOENT)`.
- **A file is never colored**, whatever `--color` says and wherever it ends up: a CI artifact or a log holds no escape sequence of quorum's. A `text` file is the text report as stdout would write it with `--color never`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The review is complete, and no gating profile kept a finding at or above its fail-on level, `high` by default: nothing was found, every finding was discarded, or findings were kept below the level, at `medium` at most by default. What a profile at `failOn: none` finds, and its gaps, change no code. A blank diff exits `0` without calling a model, once the configuration is valid. `--allow-incomplete` also exits `0` where `4` would be the code, when every failed vote behind it failed in passing |
| `1` | A gating profile kept at least one finding at or above its fail-on level, `high` by default: `medium` or `low` for a profile whose `failOn` says so ([Gating](./40-profiles.md#gating)). The security profile gates, and with its three lenses `high` means all three kept the finding |
| `2` | A usage or configuration error, before any model call: an unknown flag, a flag without its value, an empty `--config` or `--send`, a `QUORUM_CONFIG` that is not an absolute path, a `--profile` that is repeated, malformed or unknown, a `--fail-on` that is malformed, gives two levels for every profile or names a profile twice (a usage error, with the usage printed), or names a profile that does not run (a configuration error, with no usage text), a `--format` that is unknown or given twice, or given with `--print-config`, a `--state` that is empty, given twice or given with `--print-config`, a `--no-state` given with `--state` or `--print-config`, or a `--state` that names a directory that is refused (a link, a file, one another user owns or others can write, one inside a git work tree, one that holds files but is no state directory quorum made, or one that cannot be made or read), a `--color` that is none of `auto`, `always` and `never` or is given twice, an `--output` that is not written `<format>=<path>` (a path of `-`, or one that ends in `/` or `\`, is not), names one file twice, is given with `--print-config`, or whose path is a symbolic link, is no regular file or lies in no directory, a diff file or a git source given with `--print-config`, no diff given on a terminal, more than one argument, a diff file that cannot be read, a diff over 16 MiB, a source misuse (a second source, `--range` or `--at` twice, `--trust-repo-config` without `--local` or `--staged`, or `--at`, `--large` or `--no-default-skips` without `--path`), a range written wrongly or that the repository does not hold, whose two sides are one commit or that share no history in a shallow clone, git missing, older than 2.41 or on Windows, a working directory in no work tree, a repository another user owns or whose work tree is another repository's: [Sources](./15-sources.md), a repository whose own config names a filter program that `--local` or `--staged` would run, without `--trust-repo-config`, an untracked file that is a FIFO, a socket or a device, that cannot be read, whose name is not UTF-8, that leaves the top level, lies under a symbolic link or changed while quorum read it, or local changes over 16 MiB: [The local changes](./15-sources.md#the-local-changes), a `--path` that is empty, absolute, leaves the top level or names no file tracked at the commit, an `--at` that starts with `-` or names no commit, a `HEAD` that names none, a selection whose every file is left out, or one over 16 MiB: [The files at a commit](./15-sources.md#the-files-at-a-commit), a research model that is not set, a provider without a context size, a profile whose fixed text leaves a provider less than 1024 tokens of diff, research or vote, named with its figures: [Room accounting](./20-configuration.md#room-accounting), a `claude` that cannot be found or a `QUORUM_CLAUDE_CODE_COMMAND` that is relative, a voter on another endpoint without a model of its own, a base URL that is not an `http://` or `https://` URL with a host, or a key with a character an HTTP header cannot carry. The configuration is checked before the diff is reviewed, so a blank diff meets these errors too. [Configuration errors](./20-configuration.md#configuration-errors) lists the messages |
| `3` | No research call of any profile answered, and a provider was found down, or each of its calls failed for a reason of its own: its endpoint is unreachable, answers with an HTTP error, has no reply within its deadline, or sends a body or a reply quorum cannot read. The run ends with the provider-down line, `Error: default: its one call failed (http 500): lower concurrency or wait`, then the provider's own message: [When the research call fails](#when-the-research-call-fails). Or a git command a source ran failed, as `Error: git diff failed (exit 128): "..."`, git's message cut and quoted as a JSON string. Or the run stopped with nothing left to wait for, as a config file whose code never finishes loading leaves it: `Error: the run stopped without a result`, and never `0`; a provider object whose call never settles fails at its deadline instead. An error that nothing caught, thrown by a provider object's own code, ends the run with `Error:` and its message on one line, never a stack. Or an `--output` file that cannot be written, as `Error: --output json: cannot be written (EACCES)`, which names the format and the error's code and never the path: the review ended and its report is on stdout, and the exit code says the file is missing, never the review's own. A failing voter does not fail the run: see `4` |
| `4` | The review of a gating profile is incomplete, and no gating profile kept a finding at or above its fail-on level, `high` by default: a finding is `unreviewed` because a failed vote could still have kept it, or `meta.incomplete` holds a gap, which is a finding the harness could not read (`finding-unreadable`), a research reply whose findings were all unusable (`research-unusable`), findings beyond the cap of 50, or a research reply that listed every finding it was asked for, so it may have left some out (`findings-capped`), a kept finding whose failed votes could have raised it to a higher level (`vote-failed`), a request its provider refused as too large for its model (`request-too-large`), a hunk too large for any research request of its model (`too-large`), a research call that failed or whose reply was no findings envelope, a gating profile's too, so that part of the change went unreviewed (`research-failed`), hunks whose reply was cut off at its limit even after recovery split their part as far as it goes, which no flag lifts (`reply-cut-off`: [Recovering a cut-off part](./20-configuration.md#recovering-a-cut-off-part)), the research parts and votes a provider found down was never sent (`provider-down`), work the review's token cap or its deadline stopped, a research request or votes, which no flag lifts, and which a `--path` review ends with when a cap the config sets stops its parts (`token-cap`: [The token cap](./20-configuration.md#the-token-cap), `review-deadline`: [The review's deadline](./20-configuration.md#the-reviews-deadline)), a file whose change the diff does not carry, binary (`binary`) or a submodule's commit (`submodule`), or a file held back as a secret, named so or holding a credential, which no model was sent (`secret`: [Files held back as secrets](./15-sources.md#files-held-back-as-secrets)), each listed in `meta.leftOut`. `--send` or the config's `send` names a held file to send, and a file so named is no gap. A gap of a profile at `failOn: none`, a failed research part (`research-failed`) included, is in the result and on stderr, and changes no code. `--allow-incomplete` turns this `4` into `0` only when each gap of a gating profile is an unreviewed finding or a `vote-failed` gap, and every failed vote behind them failed in passing: a dropped connection, a timeout of its own, or an HTTP 408, 409, 429 or 5xx. Every other gap still exits `4`, since a pull request causes it directly: by padding a hunk until no request holds it, with decoy findings that push a real one past `maxFindings`, with text that a voter refuses or that cuts its reply off or leaves it unusable, with text that cuts every piece's reply off, with replies drawn out until the review's deadline, by making a file binary, or by naming a file as a secret. Planted text can still draw out a reply that ends in a timeout of its own, so on a gating profile do not use the flag for a pull request you do not trust |
| `130` | The CLI received SIGINT or SIGTERM. During the review, the review stopped as [Interrupting a review](#interrupting-a-review) says and the report of what it read is written, its verdict `interrupted`; this code wins over `1` and `4`, and no flag lifts it. Before the review ran, nothing is written on stdout, and `interrupted` on stderr. A second signal writes `interrupted` too, with no result, and exits `130` at once, without waiting for what a provider that ignored the first still runs |

`2` and `3` end the run before there is a result, but for an `--output` write that fails, which `3` reports after the result was written on stdout. After them `130`, for a review an interrupt stopped, wins over `1`, and `1` wins over `4`: a kept finding of a gating profile at or above its fail-on level, `high` by default, exits `1` even when the review is also incomplete. `--allow-incomplete` turns `4` into `0` and never `1`, and only when every failed vote behind the gaps failed in passing: a vote that was refused, cut off at its token limit or unusable, a request too large, work the token cap or the deadline stopped, a research part that failed, hunks cut off even alone, a part or vote a provider that was down never got, an unreadable finding, findings past the cap, an unusable research reply, a binary or submodule file, a file held back as a secret, and a reason a later version adds, all still exit `4`. A pull request can cause each of them directly, which is why no flag lifts them. The failed votes counted are those of the findings of the profile that has the gap, and a gap with no failed vote behind it, which no review writes, is never lifted. On a gating profile, do not use the flag for a pull request you do not trust: planted text can still draw out a reply that ends in a timeout of its own. A run that stops with nothing left to wait for exits `3` (`Error: the run stopped without a result`), never `0`; `130` comes only from the CLI's own signal, through the review's `interrupted` gaps or the run's stop, so an abort error the CLI did not raise exits `3`. An error nothing catches, such as a provider's timer that throws, exits `3` with one `Error:` line, even after a result was written or an interrupt began: a crash is never a clean run.

A voter that fails, because its endpoint is down or its reply is unusable, does not end the run. Its vote counts as a reject, and its error is recorded in the vote's `error`. What follows depends on what that vote could have changed: the finding is `unreviewed` when the vote could have kept it, kept with a `vote-failed` gap when it could have raised its level, and unchanged otherwise. Two rejects and one failure is a decided discard under the security profile, so such a run can still exit `0`. [Failed votes](./50-lenses-and-policy.md#failed-votes) has the arithmetic.

### When the research call fails

A research call that fails is a gap, and the review goes on, whether its profile gates or not. A call that ends with a provider's failure, a refusal, or a reply that is not one JSON object holding a `findings` array and nothing else, is the `research-failed` gap of the profile that asked it: the part of the change it held is unreviewed, the other parts and profiles are read as they always are, and a research in parts ([Research in parts](./20-configuration.md#research-in-parts)) counts the parts that failed in one gap. The review exits `4` where an earlier release exited `3`. A reply cut off at its limit is no failure: its part is split and asked again in pieces, and only what is still cut off at the floor is a gap, `reply-cut-off`: [Recovering a cut-off part](./20-configuration.md#recovering-a-cut-off-part).

A provider that is down is called no more. Once three of its calls in a row fail for a reason of its own, or at its first call whose reply says its credit, quota or spend limit is used up (the account's, never retried: [What is retried](./30-providers.md#what-is-retried)), across every profile and role that shares it, quorum writes the provider-down line ([Progress lines](#progress-lines)), calls it no more in this review, and lets the calls in flight run to their end: their replies are read as any is. The parts and votes it was never sent are `provider-down` gaps. A call fails for a reason of its own when it ends, once its retries are spent, with `network` (the endpoint cannot be reached), `http` (an HTTP error), `timeout` (no reply within its deadline), `process` (a `claude` that fails), `unsupported`, `invalid-response` (a body or a reply quorum cannot read) or `no-answer` (a reply that ended on its own with no answer: only reasoning, or nothing). A call that returned a reply, whatever it holds, starts the count again, since the server answered; a refusal, a reply cut off, a request refused as too large, a limit and a reply that is no findings envelope never count. The review keeps what it read and exits `4`.

The run ends with an `Error:` line, exit `3`, only when no research call of any profile answered: for the first research provider, in the profiles' order, that was found down, else the first whose every call failed for a reason of its own though fewer than three did, as one `http 401` of a one-request research does. Under the full view the line is followed by the provider's own message, which names the provider by its config key (`default` for a run with no config file) and quotes the server. With a provider that is Ollama's native API unless a base URL variable on its own makes it `openai-compatible` ([Layering](./20-configuration.md#layering)):

| Failure | `Error:` line, then the provider's own message |
| --- | --- |
| The endpoint cannot be reached | `Error: default: its one call failed (network): check that the server at its origin is running`, then `default: request to http://localhost:11434 failed (ECONNREFUSED)` |
| It answers with an HTTP error | `Error: default: 3 calls in a row failed (http 503): no more calls go to it in this review: lower concurrency or wait`, then `default: HTTP 503: "model is loading"`, quoting up to 500 characters of the body; the hidden characters that JSON leaves raw show as `<U+XXXX>` |
| It refuses the key or the model | `Error: default: its one call failed (http 401): check apiKey`, `(http 403)` likewise, `(http 404): check baseUrl and model` |
| The reply carries an `error`, is not finished or is not JSON | `Error: default: its one call failed (invalid-response): check protocol and baseUrl`, then `default: server error: "<message>"`, `default: reply has not finished` or `default: response body is not JSON` |
| The reply has no answer | `Error: default: its one call had no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt`, or `had no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt`, then the cause's message, `default: reply has no answer and no reasoning: ...` |
| It has no reply within its deadline | `Error: default: its one call failed (timeout): raise timeoutMs`, then `default: no reply within 600000 ms` |
| `claude` fails, exits non-zero or cannot start | `Error: default: its one call failed (process): check command`, then `default: claude exited 2: "..."`, `default: claude failed (error_max_structured_output_retries): "..."` or `default: could not start the claude CLI (ENOENT)`, for a `claude-code` provider: [Claude Code replies and errors](./30-providers.md#claude-code-replies-and-errors) |

A provider whose quota is used up is written `Error: default: the account's credit, quota or spend limit is used up (http 429): no more calls go to it in this review: add credit or raise the limit at the provider, or wait until it resets`, and under `--view public` `Error: default: the call failed (http 429)`. The first line says `its one call failed` or `its <n> calls failed` for a provider that was never found down, and `<n> calls in a row failed` and `no more calls go to it in this review` for one that was. Under `--view public` the first line is the whole error. A reply that is cut off, refused or unusable is no `Error:` line: on an `openai-compatible` provider a refusal reads `default: model refused: "<reason>"`, the content filter `default: reply was stopped by the content filter` and the token limit `default: reply was cut off at its limit of <l> tokens`, and each is the failed call that a `research-failed` gap counts, but for the cut-off, which recovery splits: [`openaiCompatible`](./30-providers.md#openaicompatible). The reasons a reply is unusable are listed under [strict parsing](../30-security/10-threat-model.md#strict-single-object-parsing). A reply that holds `findings` but none quorum could use is a `research-unusable` gap, exit `4`. A research request refused as too large for its model is a `request-too-large` gap, exit `4`, and so is a hunk no request of its model holds, a `too-large` gap.

## Printing the resolved config

`--print-config` prints the config a run would use, as YAML on stdout, and exits `0`. It reads no diff and calls no model, so it needs no stdin, and a diff file with it is a usage error: `Error: --print-config takes no diff file`, and `--range`, `--local`, `--staged` and `--path` too: `Error: --print-config: reads no diff, so it takes no --range, --local, --staged or --path`, and `--format`, `--output` and `--view`, which choose a report it does not write: `Error: --print-config: prints the config as YAML, so it takes no --format, --output or --view`, then the usage, exit `2`. It reads its settings as a run does, from `--config` or `QUORUM_CONFIG`, the `QUORUM_*` variables, `--profile` and `--fail-on`, and fails as a run does, a provider that cannot be built included: a configuration error is an `Error:` line on stderr and exit `2`, any other failure exit `3`, and stdout stays empty. The config's warnings are in the YAML, and none is on stderr, except when the config is refused: then the environment's warnings print before the `Error:` line, as on a run.

```bash
QUORUM_RESEARCH_BASE_URL=https://gateway.example/team-token/v1 \
QUORUM_RESEARCH_MODEL=qwen3.6:27b \
QUORUM_RESEARCH_CONTEXT_TOKENS=131072 \
QUORUM_RESEARCH_API_KEY=sk-example \
quorum --print-config
```

```yaml
source: null
providers:
  default:
    protocol: openai-compatible
    origin: https://gateway.example
    model: qwen3.6:27b
    contextTokens: 131072
    apiKey: "[redacted]"
profiles:
  security:
    failOn: high
    research: default
    lenses:
      reachability: default
      impact: default
      defenses: default
    thresholds:
      high: 3
      medium: 2
      low: null
    prompts:
      research: sha256:<64 hex digits>
      vote: sha256:<64 hex digits>
budgets:
  security:
    research:
      provider: default
      contextTokens: 131072
      replyTokens: 21024
      findings: 50
      findingsWithoutThinking: 50
      rooms:
        one: 107918
        part: 107606
      worstPart:
        tokens: 56234
        holds: 35
    lenses:
      reachability:
        provider: default
        contextTokens: 131072
        replyTokens: 9216
        room: 117322
      impact:
        provider: default
        contextTokens: 131072
        replyTokens: 9216
        room: 117370
      defenses:
        provider: default
        contextTokens: 131072
        replyTokens: 9216
        room: 117374
concurrency: auto
maxFindings: 50
partTokens: 32768
maxReviewTokens: 2000000
reviewTimeoutMs: 1800000
exclude: []
send: []
warnings: []
```

That run set a base URL on its own, so its provider is `openai-compatible`. With no endpoint variable the provider is the built-in default, Ollama's native API on this machine, and prints `protocol: ollama` and `origin: http://localhost:11434` in their place.

| Field | What it holds |
| --- | --- |
| `source` | The absolute path of the config file, or `null` when no file is named |
| `providers` | Each provider a profile that runs uses, by its config key, in the order the config defines them. A provider defined as data prints the fields it sets, in this order: `preset`, `protocol`, `command`, `origin` (always, but for a `claude-code` provider, which has none), `model`, `contextTokens`, `apiKey`, `auth`, `args`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature` (`null` too), `maxTokens`, `maxTokensField`, `systemPrompt`, `stream`, `timeoutMs`, `stallTimeoutMs` and `retries`. A `claude-code` provider prints the absolute path of the `claude` it found as its `command`, and its `auth` is `inherit` when it sets none, as it runs. A provider object, which a TS or JS config defines, prints `implements: Provider`, its `model`, and the `timeoutMs`, `stallTimeoutMs` and `retries` it states, in that order, and never its code: a `worstCase` or a `room` it states is not printed |
| `profiles` | Each profile that runs, by id, in run order: `failOn` (the level the run uses: `high` unless the config or `--fail-on` sets another, `none` for an advisory profile), `research` (the provider that looks for findings), `lenses` (the provider each lens votes through), `thresholds` (the kept votes each confidence level needs, `null` for a level the policy disables) and `prompts` (`research` and `vote`, each as a hash) |
| `budgets` | Each profile's budgets, by id, after `profiles`: its research provider's `contextTokens`, `replyTokens` (the reply budget), `findings` (the `N` its research asks for, and `findingsWithoutThinking`), `rooms` (the tokens of diff one request holds, `one`, and a part, `part`) and `worstPart` (what the token cap reserves for the largest part, and how many of them it holds: the worst case of a part that lists no file, so where `partTokens` bounds the diff the figure runs low and `holds` high, by the size of the file list a real part carries, and where the room bounds it both are exact), then each lens's voter with its `contextTokens`, `replyTokens` and `room`. A provider that states no room prints none of the rooms: [Room accounting](./20-configuration.md#room-accounting). A profile that leaves a provider no room is refused instead, exit `2`, so no budgets print for it |
| `concurrency`, `maxFindings` | The values the review applies: the config's, else the defaults, `auto`, a lane for each provider ([Lanes](./30-providers.md#lanes)), and `50` |
| `partTokens` | The research part size the review applies: the config's, else `32768` ([Research in parts](./20-configuration.md#research-in-parts)) |
| `maxReviewTokens`, `reviewTimeoutMs` | The limits of a review as the review applies them, defaults filled in: `QUORUM_MAX_REVIEW_TOKENS` and `QUORUM_REVIEW_TIMEOUT_MS`, else the config's, else `2000000` tokens and `1800000` ms ([The limits of a review](./20-configuration.md#the-limits-of-a-review)) |
| `exclude` | The config's patterns, as written, `[]` when it lists none: what every review leaves out ([Excludes](./20-configuration.md#excludes)) |
| `send` | The config's files, as written, `[]` when it lists none: what every review sends though they are held as secrets, which `--send` adds to ([Sending a held file](./20-configuration.md#sending-a-held-file)). It prints the config's list alone, never `--send`'s |
| `warnings` | The config's warnings: the deprecated variables, the variables nothing reads, the keys that are not sent or sent in cleartext, and a profile that sets the deprecated `gating`. A run prints these as `warning:` lines before its banner, and adds the warnings of the profiles, such as a policy level that is never reached: [Warnings](./40-profiles.md#warnings). `--print-config` adds, from the budgets, a token cap that holds the worst case of fewer than 20 research parts of a provider: `the token cap of <cap> holds the worst case of <n> research parts of <provider> (<tokens> tokens each): lower maxTokens, or raise maxReviewTokens`, with `, maxTokens <n>` after the tokens when the provider sets one |

What it leaves out, so that the output can stay in a public CI log:

- **A key** prints as `apiKey: "[redacted]"`, whether it came from `apiKey`, from the variable `apiKeyEnv` names, from a preset's variable or from `QUORUM_RESEARCH_API_KEY`.
- **`headers`, `query` and `extraBody`** print their names, each with the value `[redacted]`: a gateway's own credential can sit in a header, a query parameter or a body field.
- **A `claude-code` provider's `command` and `args`** print as they are: the path of the executable and its flags are the config's own, and a job can check them.
- **A base URL** prints as its `origin`, the scheme, host and port, since a gateway can carry a token in the path, as `team-token` does above.
- **A prompt** prints as `sha256:` and the lowercase hex SHA-256 of its UTF-8 text, never the text. `sha256sum` of a prompt file gives the same hex, a byte-order mark aside, so a job can compare it with the hash of the file on the base branch. A provider's `systemPrompt` is only a placement, `native` or `inline`.
- **A field the view does not list** prints nothing. The view is built field by field, so a field added to the config later stays out of it until it is added on purpose.

Each line passes through `inertLine`, as the lines on stderr do, so a hidden character in a file name or a key shows as `<U+XXXX>` and no line starts a workflow command: [What the CLI writes](../30-security/30-output-handling.md#what-the-cli-writes). The YAML is version 1.1, so a reader of that version reads `off` as a string, and no line is folded.

A `claude-code` provider has a `command` and `args` in place of an `origin`, and a key only in `api-key` mode:

```text
providers:
  claude:
    protocol: claude-code
    command: /usr/local/bin/claude
    model: sonnet
    contextTokens: 1000000
    apiKey: "[redacted]"
    auth: api-key
    args:
      - --effort
      - high
```

Under `inherit`, with `ANTHROPIC_API_KEY` set, `warnings` holds the billing warning: `providers.default: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key`.

A CI job can print it before the review, to check which file, providers and profiles it runs.

## Using it in CI

Every code but `0` fails a CI step, which is right for each of them; they differ in what to do next:

| Code | What the job should do |
| --- | --- |
| `0` | Pass |
| `1` | Fail, and point at the kept findings in the result |
| `2` | Fail: the job's command or variables are wrong, and nothing was reviewed |
| `3` | Fail: no research call answered, since a research provider is down, and nothing was reviewed; running it again may pass |
| `4` | Fail: a gating profile's review has a gap the harness detected; run it again, or read the unreviewed findings, `meta.incomplete` and `meta.leftOut` |
| `130` | Fail: the job was cancelled or interrupted: the result, when the signal came during the review, holds what was read and an `interrupted` gap, and nothing was written when it came before |

On a pull request, review its commits with `--range`, which makes the diff itself, and keep the result and say which case it hit. The job sets `BASE` and `HEAD` in `env:` from the pull request's base and head commits, `github.event.pull_request.base.sha` and `github.event.pull_request.head.sha`, as the workflow on the reports page shows; unset, `"$BASE...$HEAD"` is `...` and the command exits `2`:

```bash
code=0
quorum --range "$BASE...$HEAD" -f brief --output json="$RUNNER_TEMP/result.json" || code=$?
case $code in
  0) echo "complete: no gating profile kept a finding at its fail-on level" ;;
  1) echo "a finding at or above a fail-on level was kept: read result.json" ;;
  4) echo "incomplete: read the unreviewed findings, meta.incomplete and meta.leftOut in result.json" ;;
  *) echo "nothing was reviewed (exit $code): read the error above" ;;
esac
exit $code
```

- **A complete workflow** that checks out the base, reviews with `--range`, and posts the summary and SARIF from a second job is on the reports page: [A GitHub workflow](./80-reports.md#a-github-workflow).
- **Give `docker run` `-i` when the image stands in for `quorum`.** Without `-i`, `docker run` gives the container an empty stdin, which quorum reviews as an empty diff and passes with `0`, so the gate passes having reviewed nothing. Always pass `-i` when the diff comes on stdin: [A container image](../10-getting-started/10-installation.md#a-container-image).
- **Plain lines with a heartbeat are CI's default.** A job's stderr is no terminal, or `CI` is set, so `--progress auto` writes plain lines: no color, no cursor movement, and in a quiet minute one line that says where the review stands. `--progress none` keeps the log to the warnings and the errors, and `--progress json` gives a tool the events: [The modes](#the-modes). A script that read stderr through a pseudo-terminal now gets the live view, and writes `--progress plain` to keep its lines.
- **Name `-f json` in a script that reads the result.** stdout is no terminal in a CI job, so the result is JSON unless `-f` names another format. A script that runs under `docker run -t`, in a pseudo-terminal or in an IDE task has a terminal for stdout, and would get the text report where it expects JSON: `-f json` keeps the result JSON there. A pipe and a file are JSON already, and `--color` colors the text report alone, so no log of a JSON result holds an escape sequence.
- **Run the binary or the npm package's `quorum`, not `bun run start`.** The job's working directory is the pull request's checkout, and Bun reads a `bunfig.toml` and a `.env` from its working directory: the pull request could add one that runs its code first, or one that points the finder at its own endpoint. A `.env` can also set `QUORUM_CONFIG`, which names a config the pull request wrote (and a TS or JS one runs), and any `QUORUM_*` variable. The binary reads neither, and neither does Node, which runs the npm package's `quorum`: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory). Install the package with `npm install -g @tobi-or-not/quorum`, and never run it through `npx`, `npm exec` or `pnpm dlx` in that directory: they read the checkout's `.npmrc`, which can name another registry for the package to come from, where `npm install -g` does not read the project's `.npmrc`.
- **Name a config from the base branch.** A config file loads only when `--config` or `QUORUM_CONFIG` names it, and in CI it must come from the base branch or another path the pull request cannot write, its prompt files included: [Trust](./20-configuration.md#trust). `QUORUM_CONFIG` must be an absolute path, since a relative one would name a file of the checkout, which is the pull request's; quorum refuses it with exit `2`.
- **The base must be in the clone.** `--range`, or a diff of `origin/main...HEAD`, needs the base and the commit where the branch left it, which a shallow clone may not have: `fetch-depth: 0` with `actions/checkout`.
- **A clean exit covers what the harness can detect.** Quorum refuses a request that may not fit the context size you state, but it trusts that number: an endpoint that loaded a smaller window than you stated cuts an oversized prompt in silence and can still give a clean review of what was left. Ollama's native API, the default, is sent the size you state and loads it, clamped to the model's trained context, so keep the number at most what `ollama show <model>` reports. State the window the server really gives: [What the harness cannot detect](../30-security/10-threat-model.md#what-the-harness-cannot-detect).
- **The result is untrusted text.** It holds what models wrote about a change an attacker may have written: [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence) says how to treat it before you render it anywhere.

### With a diff piped in

A job that makes its own diff pipes it in, and keeps the result the same way:

```bash
set -o pipefail
code=0
git --attr-source=origin/main diff --no-textconv --no-ext-diff --no-color --submodule=short --ignore-submodules=none origin/main...HEAD | quorum -f json > result.json || code=$?
case $code in
  0) echo "complete: no gating profile kept a finding at its fail-on level" ;;
  1) echo "a finding at or above a fail-on level was kept: read result.json" ;;
  4) echo "incomplete: read the unreviewed findings, meta.incomplete and meta.leftOut in result.json" ;;
  *) echo "nothing was reviewed (exit $code): read the error above" ;;
esac
exit $code
```

- **`set -o pipefail`** makes a failing `git diff` fail the step. Without it, a base branch the job never fetched leaves quorum an empty stdin, which it reviews as a blank diff and passes with `0`.
- **Make the diff with the base branch's attributes, and pin its format.** `--attr-source=origin/main` reads `.gitattributes` from the base branch, where `git diff` would read the checkout's, which is the pull request's. A line the pull request adds, `src/a.js -diff`, would make git print `Binary files a/src/a.js and b/src/a.js differ` and none of the change. `--ignore-submodules=none` overrides the `ignore` setting of `.gitmodules`, which git also reads from the checkout: an `ignore = all` the pull request adds there would hide its submodule's bump from the diff altogether. `--no-textconv` and `--no-ext-diff` keep a text converter or an external diff program from rewriting what the diff shows, `--no-color` keeps a `color.ui = always` in the runner's config from wrapping git's lines in escape codes quorum does not read, and `--submodule=short` prints each submodule as a section of its own, whatever `diff.submodule` says. The command needs git 2.41 or later, the release that added `--attr-source`: an older git refuses the option, and `set -o pipefail` fails the step. A file the diff still shows as binary, because it holds a NUL byte near its start or the base branch marks it `-diff`, and a submodule's bump are listed in `meta.leftOut`, and exit `4` for a gating profile: [A file left out](../95-reference/20-json-result.md#a-file-left-out). `--range <base>...<head>` makes the same diff, with the pins of [How quorum runs git](./15-sources.md#how-quorum-runs-git) and the base's attributes as the command above reads them, but for two differences of form: the `index` lines hold full ids, and a moved file is a deletion and an addition. To review your own change on your own machine, `git diff` is enough. A branch someone else wrote brings its own `.gitattributes` and `.gitmodules`: review it with the command above.

## quorum report

`quorum report` renders a result a review saved, from a file or stdin, in any of the formats a review writes, as the review command would have from the same run. It calls no model, reads no config and runs no git, so a job that holds no key, and no checkout, can write the summary and the SARIF of what another job reviewed: [Reports for GitHub](./80-reports.md#quorum-report).

```text
Usage: quorum report [options] [<result>|-]

Write a saved result, read from a file or stdin, in a format: no model, config or git is used.

Options:
  -f, --format <format>    Write the report on stdout in this format: text, json, brief, markdown, payload or sarif; text on a terminal, else json
  -o, --output <output>    Also write a report to a file, written <format>=<path>; repeat it to write several
      --color <when>       Color the text report: auto, on a terminal unless NO_COLOR is set; always; or never
      --view <view>        Show the full result, or the public view with public: no reasoning, discarded findings, models or usage
      --allow-incomplete   Conclude pass, as the review would with it, when every gap is a vote that failed in passing
  -h, --help               Print this help and exit
```

```bash
quorum report result.json -f payload --output markdown=summary.md --output sarif=quorum.sarif
```

- **What it reads** is the result of a review, the full result or its public view, in a file, or on stdin for `-` or no argument; stdin that is a terminal is `Error: no result given`. At most 256 MiB is read, counted in bytes, and a larger result is `Error: the result is over 256 MiB, the most quorum reads`.
- **Only a result of the same release.** The version in `meta.version` must be the one of the `quorum` that reads it: another release's is `Error: the result was written by another release of quorum: render it with the release that wrote it`, so the job that renders installs the version that reviewed.
- **Through the strict schema.** The result is untrusted text, since a pull request's own job may have written it. Every object is checked, an unknown key anywhere is refused, and so is a profile id that is no code word, a finding that names a profile the result does not hold, and a public view that still carries what the view withholds. The refusal is `Error: the result is not one quorum writes, at <path>`, the path written with `*` for a key that is no code word, and it holds no value, no text and no key but a code word of the file. [`readResult`](../95-reference/30-library-api.md#readresult) is the same reader.
- **The flags** are the review command's `--format`, `--output`, `--color` and `--view`, checked as it checks them, and `--allow-incomplete`, which concludes as the review's own would. It has no `--fail-on`: the summary and the payload conclude by the thresholds the review recorded. A public view given with `--view full` stays the view, since the withheld fields are not in it.
- **A file named `report`** is reviewed as `quorum ./report`.

| Code | Meaning |
| --- | --- |
| `0` | The report is written, whatever the review found: the review's own exit code is the gate |
| `2` | A usage error, an input it refuses, or an `--output` file it cannot use. The message and the usage are on stderr, and nothing is on stdout |
| `3` | An `--output` file could not be written, after the report on stdout |

The refusals are checked before anything is written: the flags, then the input, then the `--output` files.

## quorum mcp

`quorum mcp` serves one tool, `review`, over MCP on standard input and output, to one client such as Claude Code. The calling agent names a source and never a diff, and the launch flags are the gates: [The MCP server](./90-mcp.md). It is started by the client, not by a person, and refuses a terminal on standard input.

```text
Usage: quorum mcp [options]

Serve quorum's review tool over MCP, on standard input and output, to one client such as Claude Code.

Options:
  -c, --config <path>             Read this config file, which must lie outside the project; over QUORUM_CONFIG
  -p, --profile <id>              Serve only this profile; repeat it to serve several
      --large                     Run a review of paths that may pass the token cap, reviewing what the cap allows
      --trust-repo-config         Review local or staged changes where the repository's own config names a filter program
      --send <path>               Send a file held as a secret to the models all the same; repeat it to send several
      --max-session-tokens <n>    Spend at most this many tokens over the server's life; four times maxReviewTokens by default
      --code-fields-only          Leave each finding's category and summary out of what the agent receives
      --require-approval          Have Claude Code ask before every call
  -h, --help                      Print this help and exit
```

## quorum bench

`quorum bench` reviews every case of a suite, a directory of patches whose bugs are known, with every config it is given, `--trials` times each, and reports what each caught, what it cost and how sure the numbers are. It records each review in a run directory it can resume, prints the plan and a line for each review on stderr, and prints its report on stdout. Its options and its exit codes are its own:

```text
Usage: quorum bench [options] <suite>

Review every case of a suite with every config, --trials times each, and report what each caught.

Options:
  -c, --config <path>       A config file to compare; repeat it, and the first is the reference
  -p, --profile <id>        Run only this profile; repeat it to run several
      --trials <n>          Reviews of each case per config: the suite's trials, else 1
      --case <id>           Run only this case; repeat it to run several
  -j, --jobs <n>            The reviews run at once (default 1)
      --max-run-tokens <n>  Start no review once the run has spent <n> tokens; the next run runs the rest
  -o, --out <dir>           The run directory (default quorum-bench/<suite name>)
      --retry-incomplete    Run again the recorded reviews that came back incomplete
      --report-only         Write the reports of what is recorded, and run no review
      --dry-run             Check the suite and the configs, print the plan, and exit
  -h, --help                Print this help and exit
```

| Code | Meaning |
| --- | --- |
| `0` | Every planned review is recorded, `--report-only` wrote the reports, or `--dry-run` checked everything and printed the plan |
| `2` | A usage, config or suite error, two configs that resolve to the same settings, or a run directory that holds another run or a file the bench cannot trust |
| `3` | A read or a write of the run directory failed, or any other stop |
| `4` | Reviews failed, because no research call answered and a provider was down, or a review's record was too large to write: they are not recorded, and the next run runs them again. Or `--max-run-tokens` left reviews unrun, which one stderr line counts. A review with a gap, a profile's failed research (`research-failed`) included, is recorded and is not a failure |
| `130` | Interrupted: the records are kept and the reports are written, or nothing is written when it came during the checks and the plan |

These are the bench's own codes, not a review's: it has no `1`, and its `4` means failed or unrun reviews where a review's means an incomplete one. [Benchmarks](./70-bench.md) has the rest: the plan and the progress lines, writing a suite, the run directory, resuming it and re-scoring it, reading the report, what a run costs, and where not to run it.

## Next

[Sources](./15-sources.md) — a diff file, stdin, a range of commits, the local changes or the files at a commit, and how quorum runs git.
