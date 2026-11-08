# The CLI

The `quorum` command reviews one diff with the security profile, prints the result as JSON and exits with a code that says what to do with it. This page is its whole surface: the invocation, what it reads, what goes to stdout and stderr, every exit code, and how a CI job should read them. Its settings are environment variables, on [Configuration](./20-configuration.md).

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
- **There are no flags.** Every argument is a file path, so `quorum --help` looks for a file named `--help`, prints `Error: ENOENT: no such file or directory, open '--help'` and the usage, and exits `2`. A file that cannot be read fails the same way.

## What it reads

A unified diff:

- **A git diff**, as `git diff` or `git format-patch` writes it, is split into one section per file at its `diff --git` lines. Paths with or without the `a/` and `b/` prefixes are read, a file renamed under those prefixes is read under its new path, and a name git quotes is decoded.
- **A diff without `diff --git` headers**, as plain `diff -u` writes it, is one section that stands for any file.

A finding must cite a file of the diff and a line of the new file inside one of its hunks, or it is dropped with a reason. The finder's path is matched against the diff's as given, trimmed, without an `a/`, `b/` or `./` prefix, decoded from git's quoting, and last by the one diff path that ends with it or that it ends with, since models often shorten paths. Each voter receives the section of the cited file, or the whole diff when no single section matches.

A blank diff, empty or only whitespace, is reviewed without calling a model.

## stdout and stderr

**stdout carries only the JSON result**, indented by two spaces and followed by a newline, written once the review ends. A script reads it whole; [The JSON result](../95-reference/20-json-result.md) has every field. When the run exits `2` or `3`, nothing was reviewed and stdout stays empty.

**stderr carries everything else**, in this order: the banner, the progress lines while the review runs, and an `Error:` line when it fails.

```text
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
```

The banner names the model of each role and the origin of its endpoint: the scheme, host and port, never a path, a query, a key or credentials. The second line is the one provider every lens of the panel votes through. A configuration error is reported before the banner; a blank diff adds `empty diff: nothing to review` after it.

### Progress lines

| Line | Printed |
| --- | --- |
| `invalid finding dropped: <reason>` | Once per finding that cites code outside the diff. The reason reads `<file>:<line> is not in the diff`, or `line <line> names no file` |
| `incomplete: <reason> (<detail>)` | Once per gap, as it is recorded in `meta.incomplete`; [the reasons](../95-reference/20-json-result.md#incomplete-reasons) say what each detail holds |
| `<n> candidate(s) after dedup` | When research and dedup are done: the findings the panel judges |
| `<k> kept, <d> discarded, <u> unreviewed by panel` | When the review ends, a blank diff included |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The review is complete, and no gating profile kept a `high` finding: nothing was found, every finding was discarded, or findings were kept at `medium` at most. A blank diff exits `0` without calling a model, once a research model is set |
| `1` | A gating profile kept at least one finding at `high` confidence. The security profile gates, and with its three lenses `high` means all three kept the finding |
| `2` | A usage or configuration error, before any model call: no diff given on a terminal, more than one argument, a diff file that cannot be read, a research model that is not set (for a blank diff too), a voter on another endpoint without a model of its own, a base URL that is not an `http://` or `https://` URL with a host, or a key with a character an HTTP header cannot carry. [Configuration errors](./20-configuration.md#configuration-errors) lists the messages |
| `3` | The research call failed: its endpoint is unreachable, answers with an HTTP error, refuses, stops on its content filter, is cut off by its token limit, or sends a body or a reply quorum cannot use. A failing voter does not fail the run: see `4` |
| `4` | The review is incomplete, and no gating profile kept a `high` finding: a finding is `unreviewed` because a failed vote could still have kept it, or `meta.incomplete` holds a gap, which is a finding the harness could not read (`finding-unreadable`), a research reply whose findings were all unusable (`research-unusable`), findings beyond the cap of 50 (`findings-capped`), or a kept finding whose failed votes could have raised it to a higher level (`vote-failed`) |

`1` wins over `4`: a kept `high` finding exits `1` even when the review is also incomplete. `2` and `3` end the run before there is a result.

A voter that fails, because its endpoint is down or its reply is unusable, does not end the run. Its vote counts as a reject, and its error is recorded in the vote's `error`. What follows depends on what that vote could have changed: the finding is `unreviewed` when the vote could have kept it, kept with a `vote-failed` gap when it could have raised its level, and unchanged otherwise. Two rejects and one failure is a decided discard under the security profile, so such a run can still exit `0`. [Failed votes](./50-lenses-and-policy.md#failed-votes) has the arithmetic.

### When the research call fails

The `Error:` line says what failed. With the CLI's research provider, which is named `research`:

| Failure | `Error:` line |
| --- | --- |
| The endpoint cannot be reached | `research: request to http://localhost:11434 failed (ECONNREFUSED)` |
| It answers with an HTTP error | `research: HTTP 503: "model is loading"`, quoting up to 500 characters of the body |
| The model refuses | `research: model refused: "I cannot help with that."` |
| The content filter stops the reply | `research: reply was stopped by the content filter` |
| The token limit cuts the reply off | `research: reply was cut off by the token limit` |
| The body is not JSON | `research: response body is not JSON` |
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
| `4` | Fail: the review did not cover the whole change; run it again, or read the unreviewed findings and `meta.incomplete` |

A step that keeps the result and says which case it hit:

```bash
set -o pipefail
status=0
git diff origin/main...HEAD | quorum > result.json || status=$?
case $status in
  0) echo "complete: no gating profile kept a high finding" ;;
  1) echo "a high finding was kept: read result.json" ;;
  4) echo "incomplete: read the unreviewed findings and meta.incomplete in result.json" ;;
  *) echo "nothing was reviewed (exit $status): read the Error line above" ;;
esac
exit $status
```

- **`set -o pipefail`** makes a failing `git diff` fail the step. Without it, a base branch the job never fetched leaves quorum an empty stdin, which it reviews as a blank diff and passes with `0`.
- **The base must be in the clone.** `origin/main...HEAD` needs `origin/main` and the commit where the branch left it, which a shallow clone may not have.
- **The result is untrusted text.** It holds what models wrote about a change an attacker may have written: the [Threat model](../30-security/10-threat-model.md#model-written-text-is-untrusted) says how to treat it before you render it anywhere.

## Next

[Configuration](./20-configuration.md) — the environment variables that pick the finder's and the panel's endpoints, models and keys, and the errors a bad value causes.
