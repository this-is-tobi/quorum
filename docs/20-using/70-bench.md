# Benchmarks

`quorum bench` measures what configurations of quorum catch. It reviews every case of a suite, a set of patches whose bugs are known, with each configuration you name, and reports for each one how many of the bugs it caught, before the panel and after it, what the reviews cost in tokens and time, and how sure those numbers are. Use it to choose a model or a config by measurement, or to see what a change of prompt, lens or policy did.

Scoring is code, and no model judges anything: a finding catches a bug when it cites the file of the bug's location, on a line within a few lines of it. The case is the unit, not the trial: a case scores the share of its trials that caught it, a rate is the mean of the case scores, and its interval is taken over the cases. More trials steady a case's score, and only more cases make a rate surer.

This page covers the command, writing a suite, the run directory a run resumes from, reading the report, what a run costs, where not to run it, and the real-bug suite in the repository.

## Running a bench

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

`bench` must be the first argument ([The invocation](./10-cli.md#the-invocation)). The argument after the options is a suite's directory, the one that holds its `suite.yaml`. With no `--config` there is one configuration, the usual resolution: `QUORUM_CONFIG` and the `QUORUM_*` variables, as for a review ([Configuration](./20-configuration.md)). Each `--config` adds another, up to 16, and the **first is the reference**: the report compares every other one with it. A `QUORUM_*` variable overrides every config alike, so two configs it makes identical are refused before any call, naming both.

| Flag | Effect |
| --- | --- |
| `-c, --config <path>` | A config file to compare. Repeat it for several; the first is the reference. An empty path is a usage error |
| `-p, --profile <id>` | Run only this profile, as in a review, in every configuration. It repeats to run several. Every profile that runs counts toward a catch |
| `--trials <n>` | The reviews of each case with each configuration, from 1 to 100: the suite's `trials`, else 1. Raising it on a run that exists adds the new trials: [The run directory](#the-run-directory) |
| `--case <id>` | Run only this case, and report only it. It repeats for several. An id the suite lacks, or one given twice, is a usage error |
| `-j, --jobs <n>` | The reviews that run at once, from 1 to 16, 1 by default. Each review keeps the config's own `concurrency` for its calls, so up to `--jobs` times that many calls are in flight |
| `-o, --out <dir>` | The run directory, `quorum-bench/<suite name>` in the working directory by default |
| `--retry-incomplete` | Run again the recorded reviews that came back incomplete, for use after an outage |
| `--dry-run` | Check everything, print the plan, and exit, writing nothing |
| `-h, --help` | Print the usage on stdout and exit `0` |

### The plan

`--dry-run` does everything a run does before its first call, and stops there: the suite is validated, each configuration is loaded and built, the run directory is checked to be one this run may use, and a run it holds is checked to be this one. It writes nothing, not even the run directory. The plan goes to stdout and the command exits `0`. A run prints the same plan on stderr before its first call. For the real-bug suite of a clone, with one provider:

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_RESEARCH_CONTEXT_TOKENS=131072
quorum bench --dry-run bench/bugs
```

```text
Suite bugs: 10 of 10 cases, 8 bug cases and 2 controls
Configurations:
  1. (default configuration)
     security: research qwen3.6:27b @ http://localhost:11434; panel qwen3.6:27b @ http://localhost:11434
Trials: 1
Reviews: 10 planned, 0 recorded, 10 to run, at most 1 at a time
Run directory: quorum-bench/bugs
Dry run: no review was run, and nothing was written.
```

With two configs, three trials and two reviews at a time, the reference is marked and the reviews are the cases times the trials times the configurations:

```bash
quorum bench --dry-run -c qwen.yaml -c gpt-oss.yaml --trials 3 --jobs 2 bench/bugs
```

```text
Suite bugs: 10 of 10 cases, 8 bug cases and 2 controls
Configurations:
  1. qwen.yaml (reference)
     security: research qwen3.6:27b @ http://localhost:11434; panel qwen3.6:27b @ http://localhost:11434
  2. gpt-oss.yaml
     security: research gpt-oss:120b @ http://localhost:11434; panel gpt-oss:120b @ http://localhost:11434
Trials: 3
Reviews: 60 planned, 0 recorded, 60 to run, at most 2 at a time
Run directory: quorum-bench/bugs
Dry run: no review was run, and nothing was written.
```

On a run directory that holds records, `recorded` counts the reviews already there and `to run` those left, with `(<n> of them again)` for the recorded ones `--retry-incomplete` runs again. Each profile of a configuration names the provider that researches and the one that votes, by model and origin, as the banner of a review does ([stdout and stderr](./10-cli.md#stdout-and-stderr)). A configuration's own warnings print before the plan, one line each, as `warning: configuration <i>: <text>`.

### Progress and the report

A run prints one line on stderr for each review that finishes, counted against the reviews it has to run:

```text
[1/60] trial 1, case code-graph-rag-ghsa-vvr2-h2jp-838m, configuration 1: caught by a kept finding; 2 kept, 4 discarded, 0 unreviewed, 0 gaps; 96.0 s
[2/60] trial 1, case code-graph-rag-ghsa-vvr2-h2jp-838m, configuration 2: caught by a proposed finding only; 0 kept, 3 discarded, 0 unreviewed, 0 gaps; 58.7 s
[3/60] trial 1, case mistune-ghsa-h7ww-273w-6cm8, configuration 1: missed; 1 kept, 2 discarded, 0 unreviewed, 0 gaps; 41.2 s
[4/60] trial 1, case mistune-ghsa-h7ww-273w-6cm8, configuration 2: failed: local: request to http://localhost:11434 failed (ECONNREFUSED)
```

The numbers are an example. The lines follow the plan's order, which is by trial, then case, then configuration, and with `--jobs` above 1 they come in the order the reviews end.

- **A review that was recorded** says what it found of its case: `control` for a control, else `caught by a kept finding`, `caught by a proposed finding only` or `missed`, then its counts of kept, discarded and unreviewed findings, its gaps (`meta.incomplete`) and its time.
- **A review that failed** ends with the error as the review command prints it for the same failure: [When the research call fails](./10-cli.md#when-the-research-call-fails). It is not recorded, the other reviews run, and the next run on the same directory runs it again. A review that resolves with gaps is not a failure: it is recorded with them, and counted as incomplete in the report.

When the reviews end, the report is written as `report.md` and `report.json` in the run directory and the Markdown is printed on stdout: [Reading the report](#reading-the-report). The reports are written after every run that reached the run directory, on exit `0`, on exit `4` and on an interrupt, so a stopped run shows what it recorded. A script reads stdout, and everything else is on stderr: the warnings, the plan, the progress lines, `interrupted` and an `Error:` line.

`--retry-incomplete` is for an outage. A review whose provider was down fails and is not recorded, so the next run runs it, but one in which a vote failed or a finding could not be read resolves, and is recorded with its gap. Those stay as they are until you ask: `--retry-incomplete` runs them again, and the later record replaces the earlier one in the report. A review that comes back incomplete again is recorded again and ends the run with `0`, as a gap is data.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every planned review is recorded. A dry run exits `0` too |
| `2` | A usage, config or suite error: a flag, a suite that does not validate, a config that cannot be built, two configs that resolve alike. Or a run directory that holds another run or a file the bench cannot trust. Nothing was reviewed, and stdout is empty |
| `3` | A read or a write of the run directory failed, such as `results.jsonl: cannot be written (EACCES)`, or the run stopped for any other reason. The records already written stay |
| `4` | Some reviews failed. They are not recorded, the others are, and the next run runs the failed ones |
| `130` | Interrupted by SIGINT or SIGTERM. No new review starts, the reviews in flight are cut, the records are kept and the reports are written, and `interrupted` is on stderr. A second signal exits at once, without waiting |

These are the bench's own codes, not the review command's: its `4` means reviews failed, not that a review has a gap, and it has no `1`. [The CLI](./10-cli.md#quorum-bench) lists them with the command. A bench gates nothing: `0` says the reviews ran, not that the numbers are good.

## Writing a suite

A suite is a directory, and it is data: nothing in it runs.

```text
my-suite/
  suite.yaml
  cases/
    exec-shell.patch
    docs-rename.patch
```

```yaml
name: mine
trials: 3
window: 3
cases:
- id: exec-shell
  kind: bug
  patch: exec-shell.patch
  locations:
  - file: src/app.js
    start: 4
    end: 4
- id: docs-rename
  kind: control
  patch: docs-rename.patch
```

`suite.yaml` is read as a config file is read ([A config file](./20-configuration.md#a-config-file)): a regular file of at most 1 MiB, in UTF-8, one YAML 1.2 document with no repeated key, no alias and no YAML 1.1 tag, plain data at most 64 levels deep with at most 10 000 values, and no `__proto__` key. Every object is strict, so a field this table does not list is an error. In `suite.yaml`:

| Field | Rule |
| --- | --- |
| `name` | Required. At most 64 characters, matching `^[a-z0-9][a-z0-9._-]*$`. It names the default run directory, `quorum-bench/<name>`, so it holds no separator and no `..` |
| `trials` | Optional, a whole number from 1 to 100: the trials a run takes when `--trials` is not given |
| `window` | Optional, a whole number from 0 to 100, 3 by default: [Locations and the window](#locations-and-the-window) |
| `cases` | Required, from 1 to 1000 cases |

And in each case:

| Field | Rule |
| --- | --- |
| `id` | Required. The same rule as `name`, and unique in the suite. The records and the report name a case by it |
| `kind` | Required. `bug`, a patch that introduces a flaw at its locations, or `control`, a patch that introduces none |
| `patch` | Required. The name of the patch in `cases/`: bare, at most 128 characters, matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` |
| `locations` | Required for a `bug`, refused on a control. From 1 to 32 entries of `{ file, start, end }`: `file` at most 4096 characters, `start` and `end` new-file lines from 1, `start` at most `end`, spanning at most 500 lines |
| `repo` | An `https://` URL of at most 200 characters, with no credentials, query or fragment |
| `fixCommit`, `introducingCommit` | A `bug` only. A full commit hash: 40 or 64 lowercase hex digits |
| `commit` | A `control` only. A full commit hash |
| `license` | One SPDX license id, such as `MIT` or `Apache-2.0`, not an expression |
| `copyright` | A list of 1 to 20 lines, each one line of visible text of at most 500 characters. A notice can span several lines, so each is its own entry |
| `date` | A real day, written `YYYY-MM-DD` |
| `note` | One line of visible text of at most 500 characters, for people. It is never sent to a model |

Visible text holds no hidden character: [Output handling](../30-security/30-output-handling.md#what-the-cli-writes).

### Patches

A patch is a pure diff in `cases/`, and the file a case's `patch` names is read by that bare name.

- **A regular file, never a symbolic link.** `suite.yaml`, `cases/` and each patch are refused when they are links, since nothing a suite holds reaches outside it.
- **At most 16 MiB each**, the review command's cap, and 64 MiB for all the patches of a suite, since a loaded suite holds them in memory.
- **Decoded as the review command decodes a diff.** A leading byte-order mark is dropped and a byte that is not UTF-8 is replaced, the same code as `quorum <patch>`.
- **Starts at its first `diff --git` line.** A commit header, an author's address or a message before it is refused, and the patch must name at least one file in a `diff --git` header quorum reads. A merge commit's combined diff starts with `diff --cc`, so it is refused too.
- **Named by a case to be read.** A file of `cases/` that no case names is not read. Several cases may name one patch.

A patch that a configuration's context size cannot hold is not an error of the suite: it is a `request-too-large` gap in the reviews made with that configuration ([What a run costs](#what-a-run-costs)), so size the patches for the models you compare.

### Locations and the window

A location's `file` is the path as the diff's own `diff --git` header names it, decoded from git's quoting: `src/app.js` for a header that reads `a/src/app.js b/src/app.js`, never `a/src/app.js`, `b/src/app.js` or `./src/app.js`, and the new path for a renamed file. Its `start` and `end` are new-file lines, and every line from `start` to `end` must sit inside a hunk of the patch, as an added line or as a context line the diff shows.

A finding catches a location when it cites the same file, on a line from `window` lines before `start` to `window` lines after `end`. `window` is 3 by default, a starting value and not a measured one: 0 catches only the lines of the location themselves, and a wider window catches more. A bug with several locations is caught by a finding at any one of them.

### Provenance

Where a case comes from is optional in the schema, since a suite built from your own history needs none of it, and required by the repository's own suites (`src/bench/suites.spec.ts` checks it): `repo`, the two commits of a bug or the commit of a control, `license`, `copyright`, `date` and a `note`. A `note` is the place to say what a reader of the report should know about a case: [Reading the report](#reading-the-report) says why.

A case's `date` is the day of its fix commit for a bug, when the answer became public, and of its commit for a control, so a reader can compare it with a model's training cutoff. Write it as `git show -s --format=%cs <commit>` prints it: the committer's local day. It can differ by one from the UTC date GitHub shows.

### Validation

A suite is validated in full before any call, by a run and by `--dry-run` alike: each patch is read and decoded, each location is looked up in its patch, and ids are checked to be unique. An issue names the file and the case by its index, and never quotes a patch:

```text
Error: my-suite/suite.yaml: cases.0.locations.0: line 40 is not in a hunk of the patch
```

Other issues read `cases.0.locations.0.file: is not a file of the patch, as its diff --git header names it`, for a path the header does not name that way, and `cases.0.patch: must be a pure diff that starts at its first diff --git line`.

### Building a case from your own history

A bug your project fixed is a case: the patch is the commit that introduced it. Choose bugs of the kind the profile you measure looks for: for the `security` profile, vulnerabilities.

1. **Find the fix, and the commit that introduced the bug.** Blame the lines the fix changed, in the fix's parent, so that they still read as they did when the bug was in them: `git blame -L <start>,<end> <fix>^ -- <file>`. The commit it names is the introducing commit. It must not be a merge: `git show -s --format=%p <commit>` prints one hash for a commit that is not.
2. **Write the patch.** `git show --format= --no-color <commit> > cases/<id>.patch`. The empty format leaves out the commit header, which the loader refuses, and `--no-color` keeps the escape codes out. A merge's combined diff starts with `diff --cc` and is refused as well.
3. **Find the lines.** The new-file lines of the introducing commit are the lines of the file as that commit left it: `git show <commit>:<file> | grep -n '<the code>'`. Take the lines the fix changed, or the lines next to which it added its check, and write them as a `location`, with the file as its `diff --git` header names it.
4. **Say where it comes from.** `repo`, the two commits, and a `note` for the weakness; a `date` as above.
5. **Add controls.** A control is a commit of the same project that you know no flaw in, with no `locations`. Every kept finding on it is unmatched, which is the nearest thing a bench has to a rate of false alarms.
6. **Check it.** `quorum bench --dry-run my-suite` validates the whole suite, every location included, and costs nothing.

A commit can change files that should not go into a patch that is sent to a model and kept in a repository: a lockfile, a generated file, or a test fixture that holds a key or a secret. Leave them out with `:(exclude)` pathspecs, and say so in the case's `note`:

```bash
git show --format= --no-color <commit> -- . ':(exclude)package-lock.json' ':(exclude)tests/fixtures/id_rsa' > cases/<id>.patch
```

The patch is then a diff of the rest.

## The run directory

A run keeps everything in one directory, `--out`, which is `quorum-bench/<suite name>` in the working directory unless it says otherwise. It holds four files, and the temporary file a write renames over its name, and nothing else:

| File | Holds |
| --- | --- |
| `run.json` | Written once, whole, when the run begins: the quorum version, the suite's name and content hash, the run's salt, and each configuration's path as given and its fingerprint |
| `results.jsonl` | One line per review that resolved, appended as it ends: the configuration's fingerprint, the case, the trial, the latency, the calls and failed calls, the usage, whether every call reported a cost, and the review's full result, as the review command prints it |
| `report.md`, `report.json` | The report of the last run, rewritten whole after every run that reached the directory |

A `--out` that does not exist is made, with its parents. An empty directory is taken. A directory that holds a `run.json` is a run to resume. A directory that holds anything else is refused with exit `2`, so `--out .` in a repository never writes into it:

```text
Error: --out: holds files but no run.json, so it is not a run directory: name a new directory, or an empty one
```

`--out` as a symbolic link, or as anything but a directory, is refused too (`Error: --out: is a symbolic link`). Its parents may be links, since they are your own path. No write follows a symbolic link: `results.jsonl` is opened without following one, and every other file is written whole to a new file that is renamed over its name, which replaces a link at that name and never writes through it. `results.jsonl` holds what models wrote about each patch, in full, so treat it as the review command's result is treated: [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence).

### Resuming

Resuming is running the same command again. The reviews already recorded are not run again, so a run stopped by an interrupt, an outage or a closed laptop picks up where it was. More trials or more cases add to a run: `--trials 5` after `--trials 3` runs trials 4 and 5, and a `--case` that names more cases runs those. A smaller selection reports only what it names, and deletes nothing.

A run directory begun with other settings is refused with exit `2`, and the differences it can name, so no review is made against records that are not comparable:

```text
Error: run.json: was written by quorum 0.0.1, and this is quorum 0.2.0: a run belongs to one build, so name a new --out
run.json: the suite's suite.yaml or patches changed since the run began: name a new --out
--config: qwen.yaml is not one of the run's configurations
run.json: its configuration old.yaml is not given
```

Each line shows when it applies, and a suite of another name reads `run.json: is a run of the suite <name>, not <name>: name a new --out`. They mean:

- **A run belongs to one build of quorum.** A release can change what a review does without changing a fingerprint, since a preset's defaults and the code that builds a request are not in it, so the quorum version is checked first. The version does not change between development commits, so after you change quorum's own code, start a new `--out`.
- **A run belongs to one suite as it was.** The content hash covers `suite.yaml`, a `note` included, and each patch a case names. Change any byte of them and the run is another one.
- **A run belongs to its set of configurations.** One added or left out is refused, and so is one whose settings changed, since its fingerprint no longer matches. The same set in another order is the same run, and the first `--config` is the reference of the report either way.

### The fingerprint

A configuration is known by its fingerprint, not by its file name: the HMAC-SHA-256, under the run's salt, of the settings a review uses. In plain words, it holds **every setting a review uses, except the key**: the profiles that run, with their prompts, lenses, policy and gating; each provider's every field, the base URL and the values of `headers`, `query` and `extraBody` among them; and `concurrency` and `maxFindings`. It is taken of the resolved configuration, so a `QUORUM_*` variable that changes a setting changes it, and it holds no file path, no warning and no provider name, so the same settings in another file, or under other names, are one configuration.

That settles when a run can go on:

- **A rotated key keeps the run.** The key is not in the fingerprint.
- **A rotated credential in a header, a query parameter or the base path does not.** They are settings, so they are in it: start a new `--out`.
- **A `claude-code` provider's resolved command path is in it.** The same run on another machine, or after `claude` moves, needs a new `--out`.

What it cannot see is outside the configuration. A provider object, which a TS or JS config defines, is its config key and its model, since its code cannot be hashed: change its implementation under the same key and model and the fingerprint stays. Nor does it see the environment a `claude-code` provider inherits. For either, start a new `--out`.

`run.json` holds the fingerprints, not the settings in the clear, and its salt keeps a short value from being looked up in a table made ahead of time. The salt is in the same file, though, so whoever reads `run.json` and knows the rest of a config can check a guess at a short value in it, a short credential in a header or a query. Keep `run.json` as private as the config.

### Stopped runs

A run killed while it appended, by SIGKILL, a crash or a closed laptop, can leave a last line of `results.jsonl` cut short: a last line with no line break, whatever it holds. The next run drops it, says so, and runs that review again, and it never joins its next record to the fragment. A dry run counts that review as not recorded.

```text
warning: results.jsonl: its last line was cut short, as a stopped run leaves it: that review runs again
```

Any other line that is no record of this run, is over 16 MiB, or names a configuration or a case the run does not have, refuses the directory with exit `2`, as `results.jsonl: line 12 is not a record of this run`. A review whose record would be over 16 MiB is a failed review. A read or write of the directory that fails stops the run with exit `3`, and its message holds the file and the error's code, as `results.jsonl: cannot be written (EACCES)`, never the runtime's text.

Run one run at a time per directory: two runs on one `--out` could interleave their records, and nothing locks the directory.

## Reading the report

A run prints its report on stdout and writes it as `report.md`, with the same numbers as `report.json`. This one is made up, to show the shape: two configs on eight bug cases and two controls, one trial.

```text
# quorum bench: example

quorum 0.2.0; 8 bug cases and 2 controls; trial 1; window 3 lines.

A review counts when it is recorded for one of these cases and trials. A case scores the share of its counted trials with the outcome, and a case with none counted is left out. A rate is the mean of the case scores, with its 95% Wilson interval over the cases scored.

## Configurations

1. base.yaml (reference)
2. candidate.yaml

| Configuration | Reviews | Kept recall | Proposed recall | Unmatched kept per case, bug / control | Incomplete | Tokens per review, median / total | Latency, p50 / p95 | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 10 of 10 | 62.5% [30.6%, 86.3%] over 8 cases | 75.0% [40.9%, 92.9%] over 8 cases | 0.63 / 0.50 | 0 | 61200 / 623500 | 106.4 s / 121.9 s | n/a |
| 2 | 10 of 10 | 87.5% [52.9%, 97.8%] over 8 cases | 100.0% [67.6%, 100.0%] over 8 cases | 0.88 / 1.50 | 1 | 80200 / 813500 | 140.4 s / 155.9 s | n/a |

## Comparisons with the reference

Each line pairs the cases both configurations scored and is its own exact sign test, so with several lines some can resolve by chance.

- 2, kept recall: +25.0 points; 2 better, 0 worse, 6 tied; p = 0.5000, unresolved
- 2, proposed recall: +25.0 points; 2 better, 0 worse, 6 tied; p = 0.5000, unresolved
- 2, unmatched kept findings per control: +1.00; 0 better, 2 worse, 0 tied; p = 0.5000, unresolved
- 2, incomplete reviews: +10.0 points; 0 better, 1 worse, 9 tied; p = 1.0000, unresolved
- 2, tokens per review: +19000; 0 better, 10 worse, 0 tied; p = 0.0020, resolved
```

### The table

Each configuration is a row, numbered as in the list above it, which names it by the path it was given, or `(default configuration)`. The reference is marked when there are several.

| Column | What it holds |
| --- | --- |
| Reviews | The reviews that count, of the reviews planned: the selected cases times the trials |
| Kept recall | The share of the bug cases caught by a kept finding, at any confidence, with its interval and the number of cases it is over |
| Proposed recall | The share caught by any finding that reached the panel, whatever its verdict: kept, discarded or unreviewed. It is the finder's recall before the panel, and never below the kept recall. A finding the harness dropped for citing code outside the diff, or as a repeat, is not in it |
| Unmatched kept per case, bug / control | The mean number of kept findings that catch no location, over the bug cases and over the controls |
| Incomplete | The reviews with a gap or an unreviewed finding, in any profile. A patch too large for a model's context is one |
| Tokens per review | The median, and the total, of input plus output tokens, over the reviews that reported usage; `n/a` when none did |
| Latency | A review's time, at the 50th and 95th percentile, by nearest rank |
| Cost | The total in US dollars, only when every call of every counted review reported a cost; otherwise `n/a`. A provider that reports none, a local model for one, leaves it `n/a` |

**Which reviews count.** A review counts when it is recorded for one of the selected cases and a trial from 1 to `--trials`. A case scores the share of its counted trials with the outcome, so a case with fewer counted trials, after an interrupt or a failure, scores the share of those, and a case with none counted is left out of the rates.

**Kept recall against proposed recall.** The gap between them is the bugs the finder found and the panel did not keep. A proposed recall far above the kept recall says the panel throws away real findings, and a kept recall that equals it says the panel lost none of the bugs the finder found.

**Unmatched kept findings.** They are never called false positives, since a gold set is never complete: a kept finding on a bug case that matches no location can be a real flaw the suite does not list. A suite's `note` can say so, as the note of the mistune case of the real-bug suite does, which names two other advisories its fix closes. On a control, a kept finding is the nearest thing to a false alarm, since a control is a commit no advisory names, though that does not prove it clean.

### The interval

The interval after a recall is a 95% Wilson interval over the cases. In plain words, it is the range of recalls this suite's cases are compatible with. It is wide on ten cases: 5 bugs caught of 8 is 62.5%, and recalls from about 31% to 86% are compatible with it. It narrows as the suite grows and not with more trials, which steady each case's score without adding a case. **Two intervals that overlap do not settle a comparison**, in either direction, so the report pairs the cases instead.

### The comparison lines

Each configuration after the reference gets five lines, one per measure: kept recall, proposed recall, unmatched kept findings per control, incomplete reviews, and tokens per review. A line pairs the cases both configurations scored, and gives the mean difference, the cases where the configuration is better, worse and tied, and the p of an exact sign test over the cases that differ. Ties are left out. Lower is better for the last three, and a line is resolved when p is below 0.05.

**Each line is its own test**, so with several configurations and five measures some lines resolve by chance: with nothing behind them, up to one line in twenty does. Read a resolved line as a lead, and read the whole report before a conclusion. Ten cases are also few: with fewer than six cases that differ, no line can resolve, and six resolve only when all six differ the same way.

A configuration with no case scored by both reads `no case scored by both`, and a run of one configuration has no comparison section.

### `report.json`

The same numbers as the table and the lines, plus each case's scores for each configuration, which are the inputs of every line: a reader can recompute any of them. It holds numbers, suite ids and config paths, and never text a model wrote.

## What a run costs

A bench makes real calls on real models, and a lot of them. The reviews are the cases times the trials times the configurations, and each review is one research call for each profile and one vote for each finding for each lens: a review of the security profile with four candidate findings makes 13 calls, one to research and twelve votes, three lenses for each finding.

- **Tokens grow with the patch**, at about one token for every three or four bytes of diff. The research call reads the whole patch, and each vote reads the cited file's part of it.
- **Quorum counts more than that.** Its size guard counts one token for every byte of a request, with a reply budget of 16 000 tokens and 512 for the chat template, and refuses one that may not fit `contextTokens`: [The size of a request](./30-providers.md#the-size-of-a-request). A refused request is a `request-too-large` gap, so the review resolves, is recorded as incomplete, and catches nothing. At the default reply budget, the real-bug suite's largest patch, about 40 KB, needs a `contextTokens` of about 59 000, and a window of 32 768 refuses the research request of four of its ten cases: state the window the server really gives ([The context size](./20-configuration.md#the-context-size)), and compare configs whose windows hold the suite.
- **Run `--dry-run` first**, which prints how many reviews a run makes and costs nothing.
- **There is no spend cap yet.** A hosted model bills every call. Try one case and one trial first (`--case <id> --trials 1`), then widen. A stopped run resumes, so interrupting one loses nothing but the reviews in flight.

## Where not to run it

Run a bench by hand, or on a schedule on a trusted branch, never on a pull request. A pull request's author could change the suite, the configs or the prompts, and would spend your keys' budget on whatever they chose.

A suite is data, so nothing in it runs. But its patches go to the configured models, and the configs it is run with are trusted input: they must come from a place the run trusts, as for a review ([Trust](./20-configuration.md#trust)). A TS or JS config runs when it loads, and its prompt files steer every review.

## The real-bug suite

`bench/bugs/` is a suite of real security vulnerabilities, since the shipped profile is `security`, and a suite of other defects would measure that prompt and not the models. It holds eight bug cases and two controls, in five languages: code-graph-rag, mistune and banks in Python, praktor and goshs in Go, CakePHP in PHP, lettre in Rust and flat-to-nested-js in JavaScript. Their weaknesses are path traversal (CWE-22) three times, and code injection through an import a template names (CWE-94), a missing authentication (CWE-306), SQL injection (CWE-89), a hostname check that is off by default (CWE-295) and prototype pollution (CWE-1321), once each.

- **Where the cases come from.** Each bug case is a vulnerability whose fix an advisory names, a GitHub security advisory (`GHSA-...`) or a CVE record. The case's patch is the diff of the commit that introduced it, and its locations are the lines of that diff the fix changed, or next to which the fix added its check. A case whose bug does not show in that diff is left out. Recent advisories are preferred, and each case's `date` is recorded, so a reader can compare it with a model's training cutoff.
- **The controls** are two commits of the same projects that no advisory names: one of praktor and one of lettre. Their locations are none, and a kept finding on one is unmatched.
- **Provenance.** Every case holds its `repo`, its fix and introducing commits, or its commit for a control, its `license`, its `copyright` lines, its `date` and a `note`. Where a patch leaves out a file, as the goshs case leaves out two test keys, the note says so. The dates are the committer's local day, as [Provenance](#provenance) says.
- **Licenses.** The projects are permissively licensed, MIT and BSD-3-Clause today. `bench/LICENSES/` holds the text of each license the cases use, in one file named by its SPDX id, which is the REUSE layout, and a test checks that every case's license has its file there and that the directory holds no other. A project under Apache-2.0 with a `NOTICE` file is left out for now, since that layout does not carry its notice. `.gitattributes` keeps each patch byte for byte, and each is under 64 KiB, about 17 to 22 thousand tokens of diff at most.
- **It ships nowhere.** The suite is in the repository and in no package, binary or image: to run it, use a clone, and point `quorum bench` at `bench/bugs`. `src/bench/suites.spec.ts` validates it in the default test suite, as a run does, with no model.

The suite will grow to 30 to 50 cases. At ten cases, every interval of a report is wide, so read a first bench of it as a first look, and not as a ranking.

## Next

[Threat model](../30-security/10-threat-model.md) — the attacker, the assets, the residual risk stated plainly, the controls in place today, and what the panel's independence is worth.
