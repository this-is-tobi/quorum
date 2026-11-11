# The CLI

The `quorum` command reviews one diff with the profiles its config selects, the security profile alone by default, prints the result as JSON and exits with a code that says what to do with it. This page is its whole surface: the invocation, what it reads, what goes to stdout and stderr, every exit code, and how a CI job should read them. Its settings are a config file that `--config` or `QUORUM_CONFIG` names and the environment variables, on [Configuration](./20-configuration.md).

```text
Usage: quorum [options] [diff-file]
       git diff | quorum [options]

Options:
  -c, --config <path>     Read this config file, over QUORUM_CONFIG
  -p, --profile <id>      Run only this profile; repeat it to run several
      --allow-incomplete  Exit 0 instead of 4 when the review is incomplete
      --print-config      Print the resolved config, keys redacted, and exit
  -h, --help              Print this help and exit
  -v, --version           Print the version and exit
```

```bash
quorum ./my.diff
git diff origin/main...HEAD | quorum
```

## The invocation

- **One argument** is the path of a diff file, read as UTF-8.
- **No argument** reads the diff from stdin, until it closes. When stdin is a terminal, quorum prints `Error: no diff given` and the usage, and exits `2`, instead of waiting for input.
- **A second argument** is an error: `Error: unexpected arguments: …` names the extra ones, then the usage, exit `2`.
- **A file that cannot be read** is an error: `Error: ENOENT: no such file or directory, open '…'`, then the usage, exit `2`.

The flags go before or after the file:

| Flag | Effect |
| --- | --- |
| `-c, --config <path>` | Read this config file, over `QUORUM_CONFIG`; a relative path is read from the working directory, while `QUORUM_CONFIG` itself must be absolute. An empty path is a usage error, so the working directory is never read as a config |
| `-p, --profile <id>` | Run only this profile, over `QUORUM_PROFILES`. It takes one id, and repeats to run several: `-p security -p team`. An id that is repeated, malformed or unknown is a usage error before any model call |
| `--allow-incomplete` | Exit `0` instead of `4` when a gating profile's review is incomplete. A kept `high` finding of a gating profile still exits `1` |
| `--print-config` | Print the resolved config as YAML on stdout, every secret redacted, and exit `0`, reading no diff and calling no model: [Printing the resolved config](#printing-the-resolved-config). A diff file with it is a usage error |
| `-h, --help` | Print the usage on stdout and exit `0`, reading neither a diff nor a config. It wins over `--version` |
| `-v, --version` | Print `quorum <version>` on stdout and exit `0`, reading neither a diff nor a config |

A value that starts with `-` takes the form `--flag=value`, as `--config=-odd.yaml`: `--config -odd.yaml` is an error, since quorum cannot tell the value from a flag. With the binary or Node, `--` ends the flags, so `quorum -- --help` reads a file named `--help`. Under `bun run start`, Bun itself drops the first `--`, so `bun run start -- --help` prints the help. An unknown flag, a flag without its value, a value given to a flag that takes none, and an empty `--config` are usage errors: `Error:` and what is wrong (`Unknown option '--nope'`), then the usage, exit `2`. The message names the flag and never the value given with it.

## What it reads

A unified diff:

- **A git diff**, as `git diff` or `git format-patch` writes it, is split into one section per file at its `diff --git` lines. Paths with or without the `a/` and `b/` prefixes are read, a file renamed under those prefixes is read under its new path, and a name git quotes is decoded.
- **A diff without `diff --git` headers**, as plain `diff -u` writes it, is one section that stands for any file.

A finding must cite a line of the new file inside one of the diff's hunks and, when the diff has per-file headers, one of its files, or it is dropped with a reason. The finder's path is matched against the diff's as given, trimmed, without an `a/`, `b/` or `./` prefix, decoded from git's quoting, and last by the one diff path that ends with it or that it ends with, since models often shorten paths. Each voter receives the section of the cited file, or the whole diff when no single section matches.

A blank diff, empty or only whitespace, is reviewed without calling a model.

## stdout and stderr

**stdout carries only the JSON result**, indented by two spaces and followed by a newline, written once the review ends. A script reads it whole; [The JSON result](../95-reference/20-json-result.md) has every field. A hidden character in a string is written as a `\uXXXX` escape, which a JSON parser reads back: [Output handling](../30-security/30-output-handling.md#what-the-cli-writes). When the run exits `2`, `3` or `130`, nothing was reviewed and stdout stays empty. With `--print-config`, stdout carries the config's YAML instead, and nothing else.

**stderr carries everything else**, in this order: the `warning:` lines, the banner, the progress lines while the review runs, and an `Error:` line when it fails. A run that fails on its configuration has no banner: its `Error:` lines come after the `warning:` lines of the environment, which often explain them. Every line is inert: a hidden character is shown as `<U+XXXX>`.

```text
warning: RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
```

Each `warning:` line is printed once, before the banner, and holds no value: a deprecated variable, a variable nothing reads, a setting that cannot take effect. When the configuration is refused, the deprecation line and the line naming a variable nothing reads are still printed, before the `Error:` lines: `RESEARCH_BASE_URL` set to a value that is not a URL gives the deprecation line, then `Error: QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host`, and a mistyped `QUORUM_VOTER_MODLE` is named before the error that follows from it. The banner names the model of each provider and the origin of its endpoint: the scheme, host and port of its base URL, or of its preset's, never a path, a query, a key or credentials. A run with no config file has one provider, named `default`, built from the `QUORUM_RESEARCH_*` variables; the voter variables add a second, named `voter`. A provider object that a config file defines reads `<model> @ the provider object <name>`, by its config key. The second line is the provider every lens of the panel votes through; when the lenses vote through different providers it names each one: `Panel will use grounded (m @ http://localhost:11434), significant (v @ https://v.example)`. When several profiles run, every line of the banner starts with `[<id>] `, the profile's id. A usage or configuration error is reported instead of the banner; a blank diff adds `empty diff: nothing to review` after it.

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
| `0` | The review is complete, and no gating profile kept a `high` finding: nothing was found, every finding was discarded, or findings were kept at `medium` at most. What a profile with `gating: false` finds, and its gaps, change no code. A blank diff exits `0` without calling a model, once the configuration is valid. `--allow-incomplete` also exits `0` where `4` would be the code |
| `1` | A gating profile kept at least one finding at `high` confidence. The security profile gates, and with its three lenses `high` means all three kept the finding |
| `2` | A usage or configuration error, before any model call: an unknown flag, a flag without its value, an empty `--config`, a `--profile` that is repeated, malformed or unknown, a diff file given with `--print-config`, no diff given on a terminal, more than one argument, a diff file that cannot be read, a research model that is not set, a voter on another endpoint without a model of its own, a base URL that is not an `http://` or `https://` URL with a host, or a key with a character an HTTP header cannot carry. The configuration is checked before the diff is reviewed, so a blank diff meets these errors too. [Configuration errors](./20-configuration.md#configuration-errors) lists the messages |
| `3` | The research call failed: its endpoint is unreachable, answers with an HTTP error, refuses, stops on its content filter, is cut off by its token limit, or sends a body or a reply quorum cannot use. Or the run stopped with nothing left to wait for, as a provider object whose call never settles leaves it: `Error: the run stopped without a result`, and never `0`. An error that nothing caught, thrown by a provider object's own code, ends the run with `Error:` and its message on one line, never a stack. A failing voter does not fail the run: see `4` |
| `4` | The review of a gating profile is incomplete, and no gating profile kept a `high` finding: a finding is `unreviewed` because a failed vote could still have kept it, or `meta.incomplete` holds a gap, which is a finding the harness could not read (`finding-unreadable`), a research reply whose findings were all unusable (`research-unusable`), findings beyond the cap of 50 (`findings-capped`), or a kept finding whose failed votes could have raised it to a higher level (`vote-failed`). A gap of a profile with `gating: false` is in the result and on stderr, and changes no code. `--allow-incomplete` turns this `4` into `0` |
| `130` | The CLI received SIGINT or SIGTERM and stopped the review: nothing is written on stdout, and `interrupted` on stderr. A second signal writes `interrupted` too and exits `130` at once, without waiting for a provider that ignores the first |

`2`, `3` and `130` end the run before there is a result. After them `1` wins over `4`: a kept `high` finding of a gating profile exits `1` even when the review is also incomplete. `--allow-incomplete` turns `4` into `0` and never `1`. A run that stops with nothing left to wait for exits `3` (`Error: the run stopped without a result`), never `0`; `130` is decided from the CLI's own signal alone, so an abort error the CLI did not raise exits `3`.

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

## Printing the resolved config

`--print-config` prints the config a run would use, as YAML on stdout, and exits `0`. It reads no diff and calls no model, so it needs no stdin, and a diff file with it is a usage error: `Error: --print-config takes no diff file`, then the usage, exit `2`. It reads its settings as a run does, from `--config` or `QUORUM_CONFIG`, the `QUORUM_*` variables and `--profile`, and fails as a run does, a provider that cannot be built included: a configuration error is an `Error:` line on stderr and exit `2`, any other failure exit `3`, and stdout stays empty. The config's warnings are in the YAML, and none is on stderr.

```bash
QUORUM_RESEARCH_BASE_URL=https://gateway.example/team-token/v1 \
QUORUM_RESEARCH_MODEL=qwen3.6:27b \
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
    apiKey: "[redacted]"
profiles:
  security:
    gating: true
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
concurrency: 4
maxFindings: 50
warnings: []
```

| Field | What it holds |
| --- | --- |
| `source` | The absolute path of the config file, or `null` when no file is named |
| `providers` | Each provider a profile that runs uses, by its config key, in the order the config defines them. A provider defined as data prints the fields it sets, in this order: `preset`, `protocol`, `origin` (always), `model`, `apiKey`, `auth`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature` (`null` too), `maxTokens`, `maxTokensField` and `systemPrompt`. A provider object, which a TS or JS config defines, prints `implements: Provider` and its `model` |
| `profiles` | Each profile that runs, by id, in run order: `gating` (`true` unless the profile sets `false`), `research` (the provider that looks for findings), `lenses` (the provider each lens votes through), `thresholds` (the kept votes each confidence level needs, `null` for a level the policy disables) and `prompts` (`research` and `vote`, each as a hash) |
| `concurrency`, `maxFindings` | The values the review applies: the config's, else the defaults, `4` and `50` |
| `warnings` | The config's warnings: the deprecated variables, the variables nothing reads and the keys that are not sent or sent in cleartext. A run prints these as `warning:` lines before its banner, and adds the warnings of the profiles, such as a policy level that is never reached: [Warnings](./40-profiles.md#warnings) |

What it leaves out, so that the output can stay in a public CI log:

- **A key** prints as `apiKey: "[redacted]"`, whether it came from `apiKey`, from the variable `apiKeyEnv` names, from a preset's variable or from `QUORUM_RESEARCH_API_KEY`.
- **`headers`, `query` and `extraBody`** print their names, each with the value `[redacted]`: a gateway's own credential can sit in a header, a query parameter or a body field.
- **A base URL** prints as its `origin`, the scheme, host and port, since a gateway can carry a token in the path, as `team-token` does above.
- **A prompt** prints as `sha256:` and the lowercase hex SHA-256 of its UTF-8 text, never the text. `sha256sum` of a prompt file gives the same hex, a byte-order mark aside, so a job can compare it with the hash of the file on the base branch. A provider's `systemPrompt` is only a placement, `native` or `inline`.
- **A field the view does not list** prints nothing. The view is built field by field, so a field added to the config later stays out of it until it is added on purpose.

Each line passes through `inertLine`, as the lines on stderr do, so a hidden character in a file name or a key shows as `<U+XXXX>` and no line starts a workflow command: [What the CLI writes](../30-security/30-output-handling.md#what-the-cli-writes). The YAML is version 1.1, so a reader of that version reads `off` as a string, and no line is folded.

A CI job can print it before the review, to check which file, providers and profiles it runs.

## Using it in CI

Every code but `0` fails a CI step, which is right for each of them; they differ in what to do next:

| Code | What the job should do |
| --- | --- |
| `0` | Pass |
| `1` | Fail, and point at the kept findings in the result |
| `2` | Fail: the job's command or variables are wrong, and nothing was reviewed |
| `3` | Fail: the research endpoint failed, and nothing was reviewed; running it again may pass |
| `4` | Fail: a gating profile's review has a gap the harness detected; run it again, or read the unreviewed findings and `meta.incomplete` |
| `130` | Fail: the job was cancelled or interrupted, and nothing was reviewed |

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
- **Run the binary, or Node, not `bun run start`.** The job's working directory is the pull request's checkout, and Bun reads a `bunfig.toml` and a `.env` from its working directory: the pull request could add one that runs its code first, or one that points the finder at its own endpoint. A `.env` can also set `QUORUM_CONFIG`, which names a config the pull request wrote (and a TS or JS one runs), and any `QUORUM_*` variable. The binary reads neither, and neither does Node: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).
- **Name a config from the base branch.** A config file loads only when `--config` or `QUORUM_CONFIG` names it, and in CI it must come from the base branch or another path the pull request cannot write, its prompt files included: [Trust](./20-configuration.md#trust). `QUORUM_CONFIG` must be an absolute path, since a relative one would name a file of the checkout, which is the pull request's; quorum refuses it with exit `2`.
- **The base must be in the clone.** `origin/main...HEAD` needs `origin/main` and the commit where the branch left it, which a shallow clone may not have.
- **A clean exit covers what the harness can detect.** An endpoint that cut an oversized prompt can still give a clean review of what was left, so bound the size of the diffs the job reviews: [What the harness cannot detect](../30-security/10-threat-model.md#what-the-harness-cannot-detect).
- **The result is untrusted text.** It holds what models wrote about a change an attacker may have written: [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence) says how to treat it before you render it anywhere.

## Next

[Configuration](./20-configuration.md) — the config file and how to name it, how the layers combine, the `QUORUM_*` variables, the voter's fallback, the keys, the trust a named config needs in CI, and the errors a bad setting causes.
