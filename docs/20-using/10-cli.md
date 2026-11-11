# The CLI

The `quorum` command reviews one diff with the profiles its config selects, the security profile alone by default, prints the result as JSON and exits with a code that says what to do with it. This page is its whole surface: the invocation, what it reads, what goes to stdout and stderr, every exit code, and how a CI job should read them. Its settings are a config file that `QUORUM_CONFIG` names and the environment variables, on [Configuration](./20-configuration.md).

```text
Usage: quorum <diff-file>
       git diff | quorum
```

```bash
quorum ./my.diff
git diff origin/main...HEAD | quorum
```

## The invocation

- **One argument** is the path of a diff file, read as UTF-8.
- **No argument** reads the diff from stdin, until it closes. When stdin is a terminal, quorum prints `Error: no diff given` and the usage, and exits `2`, instead of waiting for input.
- **A second argument** is an error: `Error: unexpected arguments: …` names the extra ones, then the usage, exit `2`.
- **There are no command-line flags.** Every argument is a file path, so `quorum --help` looks for a file named `--help`, prints `Error: ENOENT: no such file or directory, open '--help'` and the usage, and exits `2`. A file that cannot be read fails the same way.

## What it reads

A unified diff:

- **A git diff**, as `git diff` or `git format-patch` writes it, is split into one section per file at its `diff --git` lines. Paths with or without the `a/` and `b/` prefixes are read, a file renamed under those prefixes is read under its new path, and a name git quotes is decoded.
- **A diff without `diff --git` headers**, as plain `diff -u` writes it, is one section that stands for any file.

A finding must cite a line of the new file inside one of the diff's hunks and, when the diff has per-file headers, one of its files, or it is dropped with a reason. The finder's path is matched against the diff's as given, trimmed, without an `a/`, `b/` or `./` prefix, decoded from git's quoting, and last by the one diff path that ends with it or that it ends with, since models often shorten paths. Each voter receives the section of the cited file, or the whole diff when no single section matches.

A blank diff, empty or only whitespace, is reviewed without calling a model.

## stdout and stderr

**stdout carries only the JSON result**, indented by two spaces and followed by a newline, written once the review ends. A script reads it whole; [The JSON result](../95-reference/20-json-result.md) has every field. A hidden character in a string is written as a `\uXXXX` escape, which a JSON parser reads back: [Output handling](../30-security/30-output-handling.md#what-the-cli-writes). When the run exits `2` or `3`, nothing was reviewed and stdout stays empty.

**stderr carries everything else**, in this order: the `warning:` lines, the banner, the progress lines while the review runs, and an `Error:` line when it fails. Every line is inert: a hidden character is shown as `<U+XXXX>`.

```text
warning: RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
```

Each `warning:` line is printed once, before the banner, and holds no value: a deprecated variable, a variable nothing reads, a setting that cannot take effect. The banner names the model of each provider and the origin of its endpoint: the scheme, host and port of its base URL, or of its preset's, never a path, a query, a key or credentials. A run with no config file has one provider, named `default`, built from the `QUORUM_RESEARCH_*` variables; the voter variables add a second, named `voter`. A provider object that a config file defines reads `<model> @ the provider object <name>`, by its config key. The second line is the provider every lens of the panel votes through; when the lenses vote through different providers it names each one: `Panel will use grounded (m @ http://localhost:11434), significant (v @ https://v.example)`. When several profiles run, every line of the banner starts with `[<id>] `, the profile's id. A usage or configuration error is reported instead of the banner; a blank diff adds `empty diff: nothing to review` after it.

### Progress lines

| Line | Printed |
| --- | --- |
| `flag: <code> at "<file>":<line> (<detail>)` | Once per [advisory flag](../30-security/30-output-handling.md#advisory-flags), before the research starts. It reads `at "<file>"` for a file name and `at line <line>` for a diff without per-file headers. A flag changes no exit code |
| `invalid finding dropped: <reason>` | Once per finding that cites code outside the diff. The reason reads `<file>:<line> is not in the diff`, or `line <line> names no file` |
| `incomplete: <reason> (<detail>)` | Once per gap, as it is recorded in `meta.incomplete`; [the reasons](../95-reference/20-json-result.md#incomplete-reasons) say what each detail holds |
| `<n> candidate(s) after dedup` | When research and dedup are done: the findings the panel judges |
| `<k> kept, <d> discarded, <u> unreviewed by panel` | When the review ends, a blank diff included |

When several profiles run, the `invalid finding dropped`, `incomplete` and `candidate(s) after dedup` lines start with `[<id>] `, the id of the profile they belong to. The `flag:` and totals lines belong to the whole review and never do.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The review is complete, and no gating profile kept a `high` finding: nothing was found, every finding was discarded, or findings were kept at `medium` at most. A blank diff exits `0` without calling a model, once the configuration is valid |
| `1` | A gating profile kept at least one finding at `high` confidence. The security profile gates, and with its three lenses `high` means all three kept the finding |
| `2` | A usage or configuration error, before any model call: no diff given on a terminal, more than one argument, a diff file that cannot be read, a research model that is not set, a voter on another endpoint without a model of its own, a base URL that is not an `http://` or `https://` URL with a host, or a key with a character an HTTP header cannot carry. The configuration is checked before the diff is reviewed, so a blank diff meets these errors too. [Configuration errors](./20-configuration.md#configuration-errors) lists the messages |
| `3` | The research call failed: its endpoint is unreachable, answers with an HTTP error, refuses, stops on its content filter, is cut off by its token limit, or sends a body or a reply quorum cannot use. Or the run stopped with nothing left to wait for, as a provider object whose call never settles leaves it: `Error: the run stopped without a result`, and never `0`. A failing voter does not fail the run: see `4` |
| `4` | The review is incomplete, and no gating profile kept a `high` finding: a finding is `unreviewed` because a failed vote could still have kept it, or `meta.incomplete` holds a gap, which is a finding the harness could not read (`finding-unreadable`), a research reply whose findings were all unusable (`research-unusable`), findings beyond the cap of 50 (`findings-capped`), or a kept finding whose failed votes could have raised it to a higher level (`vote-failed`) |

`1` wins over `4`: a kept `high` finding exits `1` even when the review is also incomplete. `2` and `3` end the run before there is a result.

A voter that fails, because its endpoint is down or its reply is unusable, does not end the run. Its vote counts as a reject, and its error is recorded in the vote's `error`. What follows depends on what that vote could have changed: the finding is `unreviewed` when the vote could have kept it, kept with a `vote-failed` gap when it could have raised its level, and unchanged otherwise. Two rejects and one failure is a decided discard under the security profile, so such a run can still exit `0`. [Failed votes](./50-lenses-and-policy.md#failed-votes) has the arithmetic.

### When the research call fails

The `Error:` line says what failed, and names the provider by its config key: `default` for a run with no config file. With that provider:

| Failure | `Error:` line |
| --- | --- |
| The endpoint cannot be reached | `default: request to http://localhost:11434 failed (ECONNREFUSED)` |
| It answers with an HTTP error | `default: HTTP 503: "model is loading"`, quoting up to 500 characters of the body; the hidden characters that JSON leaves raw show as `<U+XXXX>` |
| The model refuses | `default: model refused: "I cannot help with that."` |
| The content filter stops the reply | `default: reply was stopped by the content filter` |
| The token limit cuts the reply off | `default: reply was cut off by the token limit` |
| The body is not JSON | `default: response body is not JSON` |
| The reply is not one JSON object holding a `findings` array and nothing else | `research reply unusable: reply contains no JSON object (reply starts: "No issues found.")`, with the reason, and the first 200 characters of the reply as a JSON string |

The reasons a reply is unusable are listed under [strict parsing](../30-security/10-threat-model.md#strict-single-object-parsing). A reply that holds `findings` but none quorum could use is not this error: it is a `research-unusable` gap, exit `4`.

## Using it in CI

Every code but `0` fails a CI step, which is right for each of them; they differ in what to do next:

| Code | What the job should do |
| --- | --- |
| `0` | Pass |
| `1` | Fail, and point at the kept findings in the result |
| `2` | Fail: the job's command or variables are wrong, and nothing was reviewed |
| `3` | Fail: the research endpoint failed, and nothing was reviewed; running it again may pass |
| `4` | Fail: the review has a gap the harness detected; run it again, or read the unreviewed findings and `meta.incomplete` |

A step that keeps the result and says which case it hit:

```bash
set -o pipefail
code=0
git diff origin/main...HEAD | quorum > result.json || code=$?
case $code in
  0) echo "complete: no gating profile kept a high finding" ;;
  1) echo "a high finding was kept: read result.json" ;;
  4) echo "incomplete: read the unreviewed findings and meta.incomplete in result.json" ;;
  *) echo "nothing was reviewed (exit $code): read the error above" ;;
esac
exit $code
```

- **`set -o pipefail`** makes a failing `git diff` fail the step. Without it, a base branch the job never fetched leaves quorum an empty stdin, which it reviews as a blank diff and passes with `0`.
- **Run the binary, not `bun run start`.** The job's working directory is the pull request's checkout, and Bun reads a `bunfig.toml` and a `.env` from its working directory: the pull request could add one that runs its code first, or one that points the finder at its own endpoint. A `.env` can also set `QUORUM_CONFIG`, which names a config the pull request wrote (and a TS or JS one runs), and any `QUORUM_*` variable. The binary reads neither: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).
- **The base must be in the clone.** `origin/main...HEAD` needs `origin/main` and the commit where the branch left it, which a shallow clone may not have.
- **A clean exit covers what the harness can detect.** An endpoint that cut an oversized prompt can still give a clean review of what was left, so bound the size of the diffs the job reviews: [What the harness cannot detect](../30-security/10-threat-model.md#what-the-harness-cannot-detect).
- **The result is untrusted text.** It holds what models wrote about a change an attacker may have written: [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence) says how to treat it before you render it anywhere.

## Next

[Configuration](./20-configuration.md) — the environment variables that pick the finder's and the panel's endpoints, models and keys, and the errors a bad value causes.
