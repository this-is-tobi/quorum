# The CLI

The `quorum` command reviews one diff with the profiles its config selects, the security profile alone by default, prints the result as JSON and exits with a code that says what to do with it. This page is its whole surface: the invocation, what it reads, what goes to stdout and stderr, every exit code, and how a CI job should read them. Its settings are a config file that `--config` or `QUORUM_CONFIG` names and the environment variables, on [Configuration](./20-configuration.md). Its one subcommand, `quorum bench`, measures configurations on a suite of bugs: [quorum bench](#quorum-bench).

```text
Usage: quorum [options] [diff-file]
       git diff | quorum [options]
       quorum bench [options] <suite>

Options:
  -c, --config <path>     Read this config file, over QUORUM_CONFIG
  -p, --profile <id>      Run only this profile; repeat it to run several
      --allow-incomplete  Exit 0 instead of 4 when the review is incomplete, except for a request too large for its model
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
- **A diff over 16 MiB**, on stdin or in a file, is an error: `Error: the diff is over 16 MiB, the most quorum reads`, then the usage, exit `2`. The bytes are counted as they arrive, and quorum stops reading there.
- **`bench` as the first argument** runs [the bench](#quorum-bench), with the arguments after it, before any flag of a review is read. A diff file named `bench` is reviewed as `quorum ./bench`.

The flags go before or after the file:

| Flag | Effect |
| --- | --- |
| `-c, --config <path>` | Read this config file, over `QUORUM_CONFIG`; a relative path is read from the working directory, while `QUORUM_CONFIG` itself must be absolute. An empty path is a usage error, so the working directory is never read as a config |
| `-p, --profile <id>` | Run only this profile, over `QUORUM_PROFILES`. It takes one id, and repeats to run several: `-p security -p team`. An id that is repeated, malformed or unknown is a usage error before any model call |
| `--allow-incomplete` | Exit `0` instead of `4` when a gating profile's review is incomplete, except for a `request-too-large` gap of a gating profile, which still exits `4`. A kept `high` finding of a gating profile still exits `1` |
| `--print-config` | Print the resolved config as YAML on stdout, every secret redacted, and exit `0`, reading no diff and calling no model: [Printing the resolved config](#printing-the-resolved-config). A diff file with it is a usage error |
| `-h, --help` | Print the usage on stdout and exit `0`, reading neither a diff nor a config. It wins over `--version` |
| `-v, --version` | Print `quorum <version>` on stdout and exit `0`, reading neither a diff nor a config |

A value that starts with `-` takes the form `--flag=value`, as `--config=-odd.yaml`: `--config -odd.yaml` is an error, since quorum cannot tell the value from a flag. With the npm package's command or the binary, `--` ends the flags, so `quorum -- --help` reads a file named `--help`. Under `bun run start`, Bun itself drops the first `--`, so `bun run start -- --help` prints the help. An unknown flag, a flag without its value, a value given to a flag that takes none, and an empty `--config` are usage errors: `Error:` and what is wrong (`Unknown option '--nope'`), then the usage, exit `2`. The message names the flag and never the value given with it.

## What it reads

A unified diff:

- **A git diff**, as `git diff` or `git format-patch` writes it, is split into one section per file at its `diff --git` lines. Paths with or without the `a/` and `b/` prefixes are read, a file renamed under those prefixes is read under its new path, and a name git quotes is decoded.
- **A diff without `diff --git` headers**, as plain `diff -u` writes it, is one section that stands for any file.

A finding must cite a line of the new file inside one of the diff's hunks and, when the diff has per-file headers, one of its files, or it is dropped with a reason. The finder's path is matched against the diff's as given, trimmed, without an `a/`, `b/` or `./` prefix, decoded from git's quoting, and last by the one diff path that ends with it or that it ends with, since models often shorten paths. Each voter receives the section of the cited file, or the whole diff when no single section matches.

A blank diff, empty or only whitespace, is reviewed without calling a model.

Besides the diff, it reads the environment: the `QUORUM_*` variables of [Configuration](./20-configuration.md#the-environment-variables), and the variable that names a `claude-code` provider's executable, `QUORUM_CLAUDE_CODE_COMMAND`. It is an absolute path, or a bare name found in the absolute entries of `PATH`, and it wins over a code config's `command`. A relative path and a `.cmd` or `.bat` file are refused with exit `2`, and a YAML or JSON config never names one: [Where the command comes from](./20-configuration.md#where-the-command-comes-from).

## stdout and stderr

**stdout carries only the JSON result**, indented by two spaces and followed by a newline, written once the review ends. A script reads it whole; [The JSON result](../95-reference/20-json-result.md) has every field. A hidden character in a string is written as a `\uXXXX` escape, which a JSON parser reads back: [Output handling](../30-security/30-output-handling.md#what-the-cli-writes). When the run exits `2`, `3` or `130`, nothing was reviewed and stdout stays empty. With `--print-config`, stdout carries the config's YAML instead, and nothing else.

**stderr carries everything else**, in this order: the `warning:` lines, the banner, the progress lines while the review runs, and an `Error:` line when it fails. A run that fails on its configuration has no banner: its `Error:` lines come after the `warning:` lines of the environment, which often explain them. Every line is inert: a hidden character is shown as `<U+XXXX>`.

```text
warning: RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
```

Each `warning:` line is printed once, before the banner, and holds no value: a deprecated variable, a variable nothing reads, a setting that cannot take effect. When the configuration is refused, the deprecation line and the line naming a variable nothing reads are still printed, before the `Error:` lines: `RESEARCH_BASE_URL` set to a value that is not a URL gives the deprecation line, then `Error: QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host`, and a mistyped `QUORUM_VOTER_MODLE` is named before the error that follows from it. The banner names the model of each provider and the origin of its endpoint: the scheme, host and port of its base URL, or of its preset's, never a path, a query, a key or credentials. A run with no config file has one provider, named `default`, built from the `QUORUM_RESEARCH_*` variables, Ollama's native API on this machine unless a variable sets a base URL on its own, a preset or a protocol; the voter variables add a second, named `voter`. A provider object that a config file defines reads `<model> @ the provider object <name>`, by its config key, and a `claude-code` provider, which has no endpoint, reads `<model> @ claude-code`: `Research (sonnet @ claude-code)...`. The second line is the provider every lens of the panel votes through; when the lenses vote through different providers it names each one: `Panel will use grounded (m @ http://localhost:11434), significant (v @ https://v.example)`. When several profiles run, every line of the banner starts with `[<id>] `, the profile's id. A usage or configuration error is reported instead of the banner; a blank diff adds `empty diff: nothing to review` after it.

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
| `0` | The review is complete, and no gating profile kept a `high` finding: nothing was found, every finding was discarded, or findings were kept at `medium` at most. What a profile with `gating: false` finds, and its gaps, change no code. A blank diff exits `0` without calling a model, once the configuration is valid. `--allow-incomplete` also exits `0` where `4` would be the code, except for a `request-too-large` gap of a gating profile |
| `1` | A gating profile kept at least one finding at `high` confidence. The security profile gates, and with its three lenses `high` means all three kept the finding |
| `2` | A usage or configuration error, before any model call: an unknown flag, a flag without its value, an empty `--config`, a `QUORUM_CONFIG` that is not an absolute path, a `--profile` that is repeated, malformed or unknown, a diff file given with `--print-config`, no diff given on a terminal, more than one argument, a diff file that cannot be read, a diff over 16 MiB, a research model that is not set, a provider without a context size, a `claude` that cannot be found or a `QUORUM_CLAUDE_CODE_COMMAND` that is relative, a voter on another endpoint without a model of its own, a base URL that is not an `http://` or `https://` URL with a host, or a key with a character an HTTP header cannot carry. The configuration is checked before the diff is reviewed, so a blank diff meets these errors too. [Configuration errors](./20-configuration.md#configuration-errors) lists the messages |
| `3` | The research call failed: its endpoint is unreachable, answers with an HTTP error, refuses, stops on its content filter, is cut off by its token limit, or sends a body or a reply quorum cannot use. Or the run stopped with nothing left to wait for, as a provider object whose call never settles leaves it: `Error: the run stopped without a result`, and never `0`. An error that nothing caught, thrown by a provider object's own code, ends the run with `Error:` and its message on one line, never a stack. A failing voter does not fail the run: see `4` |
| `4` | The review of a gating profile is incomplete, and no gating profile kept a `high` finding: a finding is `unreviewed` because a failed vote could still have kept it, or `meta.incomplete` holds a gap, which is a finding the harness could not read (`finding-unreadable`), a research reply whose findings were all unusable (`research-unusable`), findings beyond the cap of 50 (`findings-capped`), a kept finding whose failed votes could have raised it to a higher level (`vote-failed`), or a request its provider refused as too large for its model (`request-too-large`). A gap of a profile with `gating: false` is in the result and on stderr, and changes no code. `--allow-incomplete` turns this `4` into `0` for every gap but a `request-too-large` gap of a gating profile, which a pull request can cause by padding the diff. It lifts the other gaps even where a pull request caused them (decoy findings that push a real one past `maxFindings`, or text that trips a hosted voter's content filter), so on a gating profile do not use it for a pull request you do not trust |
| `130` | The CLI received SIGINT or SIGTERM and stopped the review: nothing is written on stdout, and `interrupted` on stderr. A second signal writes `interrupted` too and exits `130` at once, without waiting for a provider that ignores the first |

`2`, `3` and `130` end the run before there is a result. After them `1` wins over `4`: a kept `high` finding of a gating profile exits `1` even when the review is also incomplete. `--allow-incomplete` turns `4` into `0` and never `1`, and it lifts every gap but a `request-too-large` gap of a gating profile, which a pull request can cause by padding the diff. It lifts gaps a pull request can cause too: decoy findings that push a real one past `maxFindings`, or text that trips a hosted voter's content filter. On a gating profile, do not use it for a pull request you do not trust. A run that stops with nothing left to wait for exits `3` (`Error: the run stopped without a result`), never `0`; `130` is decided from the CLI's own signal alone, so an abort error the CLI did not raise exits `3`. An error nothing catches, such as a provider's timer that throws, exits `3` with one `Error:` line, even after a result was written or an interrupt began: a crash is never a clean run.

A voter that fails, because its endpoint is down or its reply is unusable, does not end the run. Its vote counts as a reject, and its error is recorded in the vote's `error`. What follows depends on what that vote could have changed: the finding is `unreviewed` when the vote could have kept it, kept with a `vote-failed` gap when it could have raised its level, and unchanged otherwise. Two rejects and one failure is a decided discard under the security profile, so such a run can still exit `0`. [Failed votes](./50-lenses-and-policy.md#failed-votes) has the arithmetic.

### When the research call fails

The `Error:` line says what failed, and names the provider by its config key: `default` for a run with no config file. With that provider, which is Ollama's native API unless a base URL variable on its own makes it `openai-compatible` ([Layering](./20-configuration.md#layering)):

| Failure | `Error:` line |
| --- | --- |
| The endpoint cannot be reached | `default: request to http://localhost:11434 failed (ECONNREFUSED)` |
| It answers with an HTTP error | `default: HTTP 503: "model is loading"`, quoting up to 500 characters of the body; the hidden characters that JSON leaves raw show as `<U+XXXX>` |
| The reply carries an `error` | `default: server error: "<message>"` |
| The reply is cut off by the token limit or the context | `default: reply was cut off by the token limit or the context` |
| The reply is not finished, or holds no text | `default: reply has not finished`, `default: reply has no text` |
| The body is not JSON | `default: response body is not JSON` |
| `claude` fails, exits non-zero or cannot start | `default: claude exited 2: "..."`, `default: claude failed (error_max_structured_output_retries): "..."` or `default: could not start the claude CLI (ENOENT)`, for a `claude-code` provider: [Claude Code replies and errors](./30-providers.md#claude-code-replies-and-errors) |
| The reply is not one JSON object holding a `findings` array and nothing else | `research reply unusable: reply contains no JSON object (reply starts: "No issues found.")`, with the reason, and the first 200 characters of the reply as a JSON string |

On an `openai-compatible` provider a refusal reads `default: model refused: "<reason>"`, the content filter `default: reply was stopped by the content filter` and the token limit `default: reply was cut off by the token limit`: [`openaiCompatible`](./30-providers.md#openaicompatible). The reasons a reply is unusable are listed under [strict parsing](../30-security/10-threat-model.md#strict-single-object-parsing). A reply that holds `findings` but none quorum could use is not this error: it is a `research-unusable` gap, exit `4`. A research request refused as too large for its model is not this error: it is a `request-too-large` gap, exit `4`.

## Printing the resolved config

`--print-config` prints the config a run would use, as YAML on stdout, and exits `0`. It reads no diff and calls no model, so it needs no stdin, and a diff file with it is a usage error: `Error: --print-config takes no diff file`, then the usage, exit `2`. It reads its settings as a run does, from `--config` or `QUORUM_CONFIG`, the `QUORUM_*` variables and `--profile`, and fails as a run does, a provider that cannot be built included: a configuration error is an `Error:` line on stderr and exit `2`, any other failure exit `3`, and stdout stays empty. The config's warnings are in the YAML, and none is on stderr, except when the config is refused: then the environment's warnings print before the `Error:` line, as on a run.

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

That run set a base URL on its own, so its provider is `openai-compatible`. With no endpoint variable the provider is the built-in default, Ollama's native API on this machine, and prints `protocol: ollama` and `origin: http://localhost:11434` in their place.

| Field | What it holds |
| --- | --- |
| `source` | The absolute path of the config file, or `null` when no file is named |
| `providers` | Each provider a profile that runs uses, by its config key, in the order the config defines them. A provider defined as data prints the fields it sets, in this order: `preset`, `protocol`, `command`, `origin` (always, but for a `claude-code` provider, which has none), `model`, `contextTokens`, `apiKey`, `auth`, `args`, `headers`, `query`, `extraBody`, `structuredOutput`, `temperature` (`null` too), `maxTokens`, `maxTokensField` and `systemPrompt`. A `claude-code` provider prints the absolute path of the `claude` it found as its `command`, and its `auth` is `inherit` when it sets none, as it runs. A provider object, which a TS or JS config defines, prints `implements: Provider` and its `model` |
| `profiles` | Each profile that runs, by id, in run order: `gating` (`true` unless the profile sets `false`), `research` (the provider that looks for findings), `lenses` (the provider each lens votes through), `thresholds` (the kept votes each confidence level needs, `null` for a level the policy disables) and `prompts` (`research` and `vote`, each as a hash) |
| `concurrency`, `maxFindings` | The values the review applies: the config's, else the defaults, `4` and `50` |
| `warnings` | The config's warnings: the deprecated variables, the variables nothing reads and the keys that are not sent or sent in cleartext. A run prints these as `warning:` lines before its banner, and adds the warnings of the profiles, such as a policy level that is never reached: [Warnings](./40-profiles.md#warnings) |

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
- **Give `docker run` `-i` when the image stands in for `quorum`.** Without `-i`, `docker run` gives the container an empty stdin, which quorum reviews as an empty diff and passes with `0`, so the gate passes having reviewed nothing. Always pass `-i` when the diff comes on stdin: [A container image](../10-getting-started/10-installation.md#a-container-image).
- **Run the binary or the npm package's `quorum`, not `bun run start`.** The job's working directory is the pull request's checkout, and Bun reads a `bunfig.toml` and a `.env` from its working directory: the pull request could add one that runs its code first, or one that points the finder at its own endpoint. A `.env` can also set `QUORUM_CONFIG`, which names a config the pull request wrote (and a TS or JS one runs), and any `QUORUM_*` variable. The binary reads neither, and neither does Node, which runs the npm package's `quorum`: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory). Install the package with `npm install -g @tobi-or-not/quorum`, and never run it through `npx`, `npm exec` or `pnpm dlx` in that directory: they read the checkout's `.npmrc`, which can name another registry for the package to come from, where `npm install -g` does not read the project's `.npmrc`.
- **Name a config from the base branch.** A config file loads only when `--config` or `QUORUM_CONFIG` names it, and in CI it must come from the base branch or another path the pull request cannot write, its prompt files included: [Trust](./20-configuration.md#trust). `QUORUM_CONFIG` must be an absolute path, since a relative one would name a file of the checkout, which is the pull request's; quorum refuses it with exit `2`.
- **The base must be in the clone.** `origin/main...HEAD` needs `origin/main` and the commit where the branch left it, which a shallow clone may not have.
- **A clean exit covers what the harness can detect.** Quorum refuses a request that may not fit the context size you state, but it trusts that number: an endpoint that loaded a smaller window than you stated cuts an oversized prompt in silence and can still give a clean review of what was left. Ollama's native API, the default, is sent the size you state and loads it, clamped to the model's trained context, so keep the number at most what `ollama show <model>` reports. State the window the server really gives: [What the harness cannot detect](../30-security/10-threat-model.md#what-the-harness-cannot-detect).
- **The result is untrusted text.** It holds what models wrote about a change an attacker may have written: [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence) says how to treat it before you render it anywhere.

## quorum bench

`quorum bench` reviews every case of a suite, a directory of patches whose bugs are known, with every config it is given, `--trials` times each, and reports what each caught, what it cost and how sure the numbers are. It records each review in a run directory it can resume, prints the plan and a line for each review on stderr, and prints its report on stdout. Its options and its exit codes are its own:

```text
Usage: quorum bench [options] <suite>

Review every case of a suite with every config, --trials times each, and report what each caught.

Options:
  -c, --config <path>     A config file to compare; repeat it, and the first is the reference
  -p, --profile <id>      Run only this profile; repeat it to run several
      --trials <n>        Reviews of each case per config: the suite's trials, else 1
      --case <id>         Run only this case; repeat it to run several
  -j, --jobs <n>          The reviews run at once (default 1)
  -o, --out <dir>         The run directory (default quorum-bench/<suite name>)
      --retry-incomplete  Run again the recorded reviews that came back incomplete
      --dry-run           Check the suite and the configs, print the plan, and exit
  -h, --help              Print this help and exit
```

| Code | Meaning |
| --- | --- |
| `0` | Every planned review is recorded, or `--dry-run` checked everything and printed the plan |
| `2` | A usage, config or suite error, two configs that resolve to the same settings, or a run directory that holds another run or a file the bench cannot trust |
| `3` | A read or a write of the run directory failed, or any other stop |
| `4` | Reviews failed: they are not recorded, and the next run runs them again. A review with a gap is recorded and is not a failure |
| `130` | Interrupted: the records are kept and the reports are written, or nothing is written when it came before the first review started |

These are the bench's own codes, not a review's: it has no `1`, and its `4` means failed reviews where a review's means an incomplete one. [Benchmarks](./70-bench.md) has the rest: the plan and the progress lines, writing a suite, the run directory and resuming it, reading the report, what a run costs, and where not to run it.

## Next

[Configuration](./20-configuration.md) — the config file and how to name it, how the layers combine, the `QUORUM_*` variables, the voter's fallback, the context size, the keys, the trust a named config needs in CI, and the errors a bad setting causes.
