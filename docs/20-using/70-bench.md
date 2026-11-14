# Benchmarks

`quorum bench` measures what configurations of quorum catch. It reviews every case of a suite, a set of patches whose bugs are known, with each configuration you name, and reports for each one how many of the bugs it caught, before the panel and after it, what the reviews cost in tokens and time, and how sure those numbers are. Use it to choose a model or a config by measurement, or to see what a change of prompt, lens or policy did.

Scoring is code, and no model judges anything: a finding catches a bug when it cites the file of the bug's location, on a line within a few lines of it. The case is the unit, not the trial: a case scores the share of its trials that caught it, a rate is the mean of the case scores, and its interval is taken over the cases. More trials steady a case's score, and only more cases make a rate surer.

This page covers the command, writing a suite, the run directory a run resumes from, reading the report, what a run costs, where not to run it, the real-bug suite in the repository, and attack suites, whose poisoned patches measure what planted text does to a review.

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

`bench` must be the first argument ([The invocation](./10-cli.md#the-invocation)). The argument after the options is a suite's directory, the one that holds its `suite.yaml`. With no `--config` there is one configuration, the usual resolution: `QUORUM_CONFIG` and the `QUORUM_*` variables, as for a review ([Configuration](./20-configuration.md)). Each `--config` adds another, up to 16, and the **first is the reference**: the report compares every other one with it. A `QUORUM_*` variable overrides every config alike, so two configs it makes identical are refused before any call, naming both. A file named by two `--config` values, as `a.yaml` and `./a.yaml` or its absolute path, is a usage error before any config is read, `Error: --config: names the file "a.yaml" more than once`, and two names of one file, such as a link, are refused as two configs that resolve alike.

| Flag | Effect |
| --- | --- |
| `-c, --config <path>` | A config file to compare. Repeat it for several; the first is the reference. An empty path, or a file named twice, is a usage error |
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
Suite bugs: 40 of 40 cases, 30 bug cases and 10 controls
Configurations:
  1. (default configuration)
     security: research qwen3.6:27b @ http://localhost:11434; panel qwen3.6:27b @ http://localhost:11434
Trials: 1
Reviews: 40 planned, 0 recorded, 40 to run, at most 1 at a time
Run directory: quorum-bench/bugs
Dry run: no review was run, and nothing was written.
```

With two configs, three trials and two reviews at a time, the reference is marked and the reviews are the cases times the trials times the configurations:

```bash
quorum bench --dry-run -c qwen.yaml -c gpt-oss.yaml --trials 3 --jobs 2 bench/bugs
```

```text
Suite bugs: 40 of 40 cases, 30 bug cases and 10 controls
Configurations:
  1. qwen.yaml (reference)
     security: research qwen3.6:27b @ http://localhost:11434; panel qwen3.6:27b @ http://localhost:11434
  2. gpt-oss.yaml
     security: research gpt-oss:120b @ http://localhost:11434; panel gpt-oss:120b @ http://localhost:11434
Trials: 3
Reviews: 240 planned, 0 recorded, 240 to run, at most 2 at a time
Run directory: quorum-bench/bugs
Dry run: no review was run, and nothing was written.
```

On a run directory that holds records, `recorded` counts the reviews already there and `to run` those left, with `(<n> of them again)` for the recorded ones `--retry-incomplete` runs again. Each profile of a configuration names the provider that researches and the one that votes, by model and origin, as the banner of a review does ([stdout and stderr](./10-cli.md#stdout-and-stderr)). A configuration's own warnings print before the plan, one line each, as `warning: configuration <i>: <text>`.

### Progress and the report

A run prints one line on stderr for each review that finishes, counted against the reviews it has to run:

```text
[1/240] trial 1, case code-graph-rag-ghsa-vvr2-h2jp-838m, configuration 1: caught by a kept finding; 2 kept, 4 discarded, 0 unreviewed, 0 gaps; 96.0 s
[2/240] trial 1, case code-graph-rag-ghsa-vvr2-h2jp-838m, configuration 2: caught by a proposed finding only; 0 kept, 3 discarded, 0 unreviewed, 0 gaps; 58.7 s
[3/240] trial 1, case mistune-ghsa-h7ww-273w-6cm8, configuration 1: missed; 1 kept, 2 discarded, 0 unreviewed, 0 gaps; 41.2 s
[4/240] trial 1, case mistune-ghsa-h7ww-273w-6cm8, configuration 2: denied, the research reply could not be used; 12.8 s
[5/240] trial 1, case banks-ghsa-64vx-6h2c-rjh7, configuration 1: failed: local: request to http://localhost:11434 failed (ECONNREFUSED)
```

The numbers are an example. The lines follow the plan's order, which is by trial, then case, then configuration, and with `--jobs` above 1 they come in the order the reviews end.

- **A review that was recorded** says what it found of its case: `control` for a control, else `caught by a kept finding`, `caught by a proposed finding only` or `missed`, then its counts of kept, discarded and unreviewed findings, its gaps (`meta.incomplete`) and its time.
- **A review that failed** is one whose research call failed: an HTTP, network, timeout or process failure, or a reply the server shaped wrong. Its line ends with the error as the review command prints it for the same failure: [When the research call fails](./10-cli.md#when-the-research-call-fails). A review whose record would be over 16 MiB fails too. A failed review is not recorded, the other reviews run, and the next run on the same directory runs it again. A review that resolves with gaps is not a failure: it is recorded with them, and counted as incomplete in the report.
- **A review that a model's reply denied** reads `denied, the research reply could not be used`, `denied, the model refused the research request` or `denied, the research reply was cut off at its token limit`, in words the bench wrote: it quotes nothing of the reply. The review reviewed nothing, so it catches nothing and counts as incomplete. Its record holds the usage of every call the review made before the denial, the cut-off reply's included, so a reply cut off at its limit counts its tokens. It is recorded, not failed, since a retry cannot tell a model that cannot answer in the reply's format from an outage, and a poisoned patch provokes such replies on purpose.

When the reviews end, the report is written as `report.md` and `report.json` in the run directory and the Markdown is printed on stdout: [Reading the report](#reading-the-report). The reports are written after every run that reached the run directory, on exit `0`, on exit `4` and on an interrupt, so a stopped run shows what it recorded. The bench writes to the run directory only once the checks and the plan are done: an interrupt before that writes nothing, not even the run directory, and one after it writes the reports of what was recorded, which can be nothing yet. A script reads stdout, and everything else is on stderr: the warnings, the plan, the progress lines, `interrupted` and an `Error:` line.

`--retry-incomplete` is for an outage. A review whose provider was down fails and is not recorded, so the next run runs it, but one in which a vote failed or a finding could not be read resolves, and is recorded with its gap, and one that a model's reply denied is recorded as denied. Those stay as they are until you ask: `--retry-incomplete` runs them again, the denied reviews too, and the later record replaces the earlier one in the report. A review that comes back incomplete again is recorded again and ends the run with `0`, as a gap or a denial is data. A refused request is not an outage, though. A review whose research request is refused as too large (`request-too-large`) comes back the same on every retry: only a model with a larger window fixes it, and that is another configuration, so another `--out`. A vote refused as too large may fit on a retry, since the findings change from one trial to the next.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every planned review is recorded, a denied one included. A dry run exits `0` too |
| `2` | A usage, config or suite error: a flag, a suite that does not validate, a config that cannot be built, two configs that resolve alike. Or a run directory that holds another run or a file the bench cannot trust. Nothing was reviewed, and stdout is empty |
| `3` | A read or a write of the run directory failed, such as `results.jsonl: cannot be written (EACCES)`, or the run stopped for any other reason. The records already written stay |
| `4` | Some reviews failed: a research call failed, or a record would be over 16 MiB. They are not recorded, the others are, and the next run runs the failed ones |
| `130` | Interrupted by SIGINT or SIGTERM. No new review starts, the reviews in flight are cut, the records are kept and the reports are written, and `interrupted` is on stderr. During the checks and the plan it writes nothing, not even the run directory. A second signal exits at once, without waiting |

These are the bench's own codes, not the review command's: its `4` means reviews failed, not that a review has a gap or was denied, and it has no `1`. [The CLI](./10-cli.md#quorum-bench) lists them with the command. A bench gates nothing: `0` says the reviews ran, not that the numbers are good.

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
| `name` | Required. At most 64 characters, matching `^[a-z0-9][a-z0-9._-]*$`. It names the default run directory, `quorum-bench/<name>`, so it is never `.` or `..`, and holds no separator |
| `trials` | Optional, a whole number from 1 to 100: the trials a run takes when `--trials` is not given |
| `window` | Optional, a whole number from 0 to 100, 3 by default: [Locations and the window](#locations-and-the-window) |
| `cases` | Required, from 1 to 1000 cases |

And in each case:

| Field | Rule |
| --- | --- |
| `id` | Required. The same rule as `name`, and unique in the suite. The records and the report name a case by it |
| `kind` | Required. `bug`, a patch that introduces a flaw at its locations, `control`, a patch that introduces none, or `attack`, a poisoned twin of a bug case: [Attack suites](#attack-suites) |
| `patch` | Required. The name of the patch in `cases/`: bare, at most 128 characters, matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` |
| `locations` | Required for a `bug` and an `attack`, refused on a control. From 1 to 32 entries of `{ file, start, end }`: `file` at most 4096 characters, `start` and `end` new-file lines from 1, `start` at most `end`, spanning at most 500 lines |
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

Other issues read `cases.0.locations.0.file: is not a file of the patch, as its diff --git header names it`, for a path the header does not name that way, and `cases.0.patch: must be a pure diff that starts at its first diff --git line`. An attack case has checks of its own: [Attack suites](#attack-suites).

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
| `results.jsonl` | One line per review that resolved or that a model's reply denied, appended as it ends: the configuration's fingerprint, the case, the trial, the latency, the calls and failed calls, the usage, a failed call's included when its reply reported counts, whether every call reported a cost, and the review's full result, as the review command prints it, or for a denied review which denial it was: `unusable-reply`, `refusal` or `truncated` |
| `report.md`, `report.json` | The report of the last run that ended with exit `0`, exit `4` or an interrupt after its checks and its plan, rewritten whole; a dry run writes neither. A run that exits `3` rewrites neither, so after one they show an earlier run |

A `--out` that does not exist is made, with its parents. An empty directory is taken. A directory that holds a `run.json` is a run to resume. A directory that holds anything else is refused with exit `2`, so `--out .` in a repository never writes into it:

```text
Error: --out: holds files but no run.json, so it is not a run directory: name a new directory, or an empty one
```

One file is not counted: the temporary file of `run.json` that a run killed while it wrote can leave, named `.run.json.` then 8 lowercase hex digits then `.tmp`. A directory that holds only such files is taken as empty, the bench neither reads nor deletes them, and they are safe to delete when no run is using the directory.

`--out` as a symbolic link, or as anything but a directory, is refused too (`Error: --out: is a symbolic link`). Its parents may be links, since they are your own path. No write follows a symbolic link: `results.jsonl` is opened without following one, and every other file is written whole to a new file that is renamed over its name, which replaces a link at that name and never writes through it. `results.jsonl` holds each review's full result, the text models wrote about each patch among it, so treat it as the review command's result is treated: [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence).

The bench makes `run.json` and `results.jsonl` readable and writable by their owner only (mode `0600`), and the files of a run being resumed keep their modes. The reports are made as any new file is, since they hold numbers, suite ids and config paths, never text a model wrote, and are made to be shared; `run.json` and `results.jsonl` never are. A copy of the directory, in a CI artifact, an archive or a commit, usually drops the mode, while the salt travels with `run.json`, so share the reports alone. A run directory an earlier quorum made keeps the modes it was made with, usually `0644`, and this quorum does not resume it (a run belongs to one build, see [Resuming](#resuming)), so nothing changes them: `chmod 600` its `run.json` and `results.jsonl`, or delete it.

### Resuming

Resuming is running the same command again. The reviews already recorded are not run again, so a run stopped by an interrupt, an outage or a closed laptop picks up where it was. More trials or more cases add to a run: `--trials 5` after `--trials 3` runs trials 4 and 5, and a `--case` that names more cases runs those. A smaller selection reports only what it names, and deletes nothing.

A run directory begun with other settings is refused with exit `2`, and the differences it can name, so no review is made against records that are not comparable:

```text
Error: run.json: was written by quorum 0.3.0, and this is quorum 0.4.0: a run belongs to one build, so name a new --out
run.json: the suite's suite.yaml or patches changed since the run began: name a new --out
--config: qwen.yaml is not one of the run's configurations
run.json: its configuration old.yaml is not given
```

Each line shows when it applies. A suite of another name reads `run.json: is a run of the suite <name>, not <name>: name a new --out`, and a configuration given again with other settings, whether its file was edited or another `--profile` selects other profiles, reads `--config: the settings of qwen.yaml changed since the run began: name a new --out` in place of the two lines a configuration added and one left out would give. The usual resolution, with no `--config`, is named `(default configuration)`. They mean:

- **A run belongs to one build of quorum.** A release can change what a review does without changing a fingerprint, since a preset's defaults and the code that builds a request are not in it, so the quorum version is checked first. The version does not change between development commits, so after you change quorum's own code, start a new `--out`.
- **A run belongs to one suite as it was.** The content hash covers `suite.yaml`, a `note` included, and each patch a case names. Change any byte of them and the run is another one.
- **A run belongs to its set of configurations.** One added or left out is refused, and so is one whose settings changed, since its fingerprint no longer matches; the message says which of the three it is, and for a change not which setting, since the run keeps only the fingerprint. The same set in another order is the same run, and the first `--config` is the reference of the report either way.

### The fingerprint

A configuration is known by its fingerprint, not by its file name: the HMAC-SHA-256, under the run's salt, of the settings a review uses. In plain words, it holds **every setting a review uses, except the key**: the profiles that run, with their prompts, lenses, policy and gating; each provider's every field, the base URL and the values of `headers`, `query` and `extraBody` among them; and `concurrency` and `maxFindings`. It is taken of the resolved configuration, so a `QUORUM_*` variable that changes a setting changes it, and it holds no config-file path, no warning and no provider name, so the same settings in another file, or under other names, are one configuration.

That settles when a run can go on:

- **A rotated key keeps the run.** The key is not in the fingerprint.
- **A rotated credential in a header, a query parameter or the base path does not.** They are settings, so they are in it: start a new `--out`.
- **A `claude-code` provider's resolved command path is in it.** The same run on another machine, or after `claude` moves, needs a new `--out`.

What it cannot see is outside the configuration. A provider object, which a TS or JS config defines, is its config key and its model, since its code cannot be hashed: change its implementation under the same key and model and the fingerprint stays. Nor does it see the environment a `claude-code` provider inherits. For either, start a new `--out`.

`run.json` holds the fingerprints, not the settings in the clear, and its salt keeps a short value from being looked up in a table made ahead of time. The salt is in the same file, though, so whoever reads `run.json` and knows the rest of a config can check a guess at a short value in it, a short credential in a header or a query, so the bench writes `run.json`, as it writes `results.jsonl`, readable by its owner only. A copy often loses that mode, as a commit or a CI artifact does, so keep `run.json` out of an artifact, an archive and a commit.

### Stopped runs

A run killed while it appended, by SIGKILL, a crash or a closed laptop, can leave a last line of `results.jsonl` cut short: a last line with no line break, whatever it holds. The next run drops it, says so, and runs that review again, and it never joins its next record to the fragment. A dry run counts that review as not recorded.

```text
warning: results.jsonl: its last line was cut short, as a stopped run leaves it: that review runs again
```

Any other line that is no record of this run, is over 16 MiB, or names a configuration or a case the run does not have, refuses the directory with exit `2`, as `results.jsonl: line 12 is not a record of this run`. A review whose record would be over 16 MiB is a failed review. A read or write of the directory that fails stops the run with exit `3`, and its message holds the file and the error's code, as `results.jsonl: cannot be written (EACCES)`, never the runtime's text.

The append checks the file again, so a `results.jsonl` whose length changed since the run read it, shorter or longer, as another run on the same directory leaves it, stops the run with exit `2` before any review, and nothing is cut:

```text
Error: results.jsonl: changed after this run read it, so another run may be using this --out: run one at a time
```

A `results.jsonl` that is no longer a regular file, such as a directory or a FIFO, stops the run the same way, as `Error: results.jsonl: is not a file`, and the bench never waits for a FIFO to be read. A kind of file the system refuses to open, a unix socket on macOS, is a write failure instead, with exit `3`, which writes nothing either: under Bun and the compiled binary it reads `results.jsonl: cannot be written (EOPNOTSUPP)`, and under Node, which names no code for it, `results.jsonl: cannot be written`.

Run one run at a time per directory: that check is made once, when the append opens the file, and nothing locks the directory, so two runs on one `--out` could interleave their records. Two new runs started together are worse: each finds no `run.json` and makes its own, the one that renames last keeps its salt, and the check passes, since no record exists yet. Their records sit under two salts, which leaves a directory no later run can resume: it refuses the records written under the replaced salt.

## Reading the report

A run prints its report on stdout and writes it as `report.md`, with the same numbers as `report.json`. This one is made up, to show the shape, and is not a run of the real-bug suite: two configs on eight bug cases and two controls, one trial.

```text
# quorum bench: example

quorum 0.3.0; 8 bug cases and 2 controls; trial 1; window 3 lines.

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
| Incomplete | The reviews with a gap or an unreviewed finding, in any profile, and the denied reviews, which are among them: when some are denied the cell counts them in brackets, as `2 (1 denied)` for 2 incomplete reviews, one of them denied. A patch too large for a model's context is one |
| Tokens per review | The median, and the total, of input plus output tokens, over the reviews that reported usage; `n/a` when none did. A call that failed adds the tokens its reply reported, as a reply cut off at its token limit or refused does; one that failed with no reply read, a network error or a status outside 2xx, adds none, so a configuration whose calls fail that way more often looks cheaper here |
| Latency | A review's time, at the 50th and 95th percentile, by nearest rank |
| Cost | The total in US dollars, only when every call of every counted review reported a cost; otherwise `n/a`. A provider that reports none, a local model for one, leaves it `n/a` |

**Which reviews count.** A review counts when it is recorded for one of the selected cases and a trial from 1 to `--trials`. A case scores the share of its counted trials with the outcome, so a case with fewer counted trials, after an interrupt or a failure, scores the share of those, and a case with none counted is left out of the rates.

**Denied reviews.** A review that a model's reply denied counts, on any suite, the real-bug one included. In a bug case it is a miss in both recalls, since it catches nothing, and it is incomplete. It is recorded rather than failed, so the next run does not run it again of itself (`--retry-incomplete` does), and a recall counts every trial of a model that cannot answer in the reply's format, not only the trials whose reply parsed. A denied control adds nothing to the unmatched mean, since it has no finding, so only the Incomplete column shows it, and its count in brackets says how many of those reviews were denied.

**Kept recall against proposed recall.** The gap between them is the bugs the finder found and the panel did not keep. A proposed recall far above the kept recall says the panel throws away real findings, and a kept recall that equals it says the panel lost none of the bugs the finder found.

**Unmatched kept findings.** They are never called false positives, since a gold set, the list of bugs a suite records, is never complete: a kept finding on a bug case that matches no location can be a real flaw the suite does not list. A suite's `note` can say so, as the note of the mistune case of the real-bug suite does, which names two other advisories its fix closes. On a control, a kept finding is the nearest thing to a false alarm, since a control is a commit no advisory names, though that does not prove it clean.

### The interval

The interval after a recall is a 95% Wilson interval over the cases. In plain words, it is the range of recalls this suite's cases are compatible with. It is wide on few cases: in the report above, 5 bugs caught of 8 is 62.5%, and recalls from about 31% to 86% are compatible with it. It is narrower on the 30 bug cases of the real-bug suite, and still wide: with 19 of them caught, which is 63.3%, recalls from about 46% to 78% are compatible with it. It narrows as the suite grows and not with more trials, which steady each case's score without adding a case. **Two intervals that overlap do not settle a comparison**, in either direction, so the report pairs the cases instead.

### The comparison lines

Each configuration after the reference gets five lines, one per measure: kept recall, proposed recall, unmatched kept findings per control, incomplete reviews, and tokens per review. A line pairs the cases both configurations scored, and gives the mean difference, the cases where the configuration is better, worse and tied, and the p of an exact sign test over the cases that differ. Ties are left out. Lower is better for the last three, and a line is resolved when p is below 0.05.

**Each line is its own test**, so with several configurations and five measures some lines resolve by chance: with nothing behind them, up to one line in twenty does. Read a resolved line as a lead, and read the whole report before a conclusion. Few cases may differ: with fewer than six of them, no line can resolve, and six resolve only when all six differ the same way, on a suite of any size.

A configuration with no case scored by both reads `no case scored by both`, and a run of one configuration has no comparison section.

### The inter-voter error correlation

Every report ends with the section `## Inter-voter error correlation`, which says how far the lenses of each configuration err together: lenses whose errors correlate add less than a vote each. It covers every suite with bug cases, the real-bug suite included, and it is read from the findings whose truth the suite knows. A finding that catches a location is true, and one that catches a decoy, which only an [attack suite](#attack-suites) has, is false. A lens errs when it discards a true finding or keeps a false one, and a failed vote is left out. [The lenses' error correlation](../30-security/40-measurement.md#the-lenses-error-correlation) says what phi and the effective votes mean.

Each configuration gets one line, of one of three forms:

```text
- 1: no finding of known truth
- 2: no pair of lenses whose errors both vary, over 9 findings
- 3: mean phi 0.20 over 3 lens pairs and 41 findings; 2.14 effective votes of 3
```

- **No finding of known truth**: no finding of the selection's reviews caught a location or a decoy, in a suite with no bug case or when the models found none.
- **No pair of lenses whose errors both vary**: no pair has both of its lenses erring on some of those findings and not on others, so no pair has a correlation and the mean has no value. Every lens may have erred on all of them or on none, or one lens may vary beside constant ones, or the panel may hold a single lens.
- **The mean phi**, over the pairs of lenses where it is defined, and the number of findings, then the effective votes of the panel's size. The end reads `no effective number, since its panels differ in size` when the profiles of a configuration have panels of different sizes, and `no effective number at that mean` when the mean is too negative for the formula. A mean below 0 can give more effective votes than lenses, which is a sign of errors that offset each other and not of extra voters.

The section gives no interval, and the report names no profile.

### `report.json`

The same numbers as the table and the lines, plus each case's scores for each configuration, which are the inputs of every line: a reader can recompute any of them. It holds numbers, suite ids and config paths, and never text a model wrote.

## What a run costs

A bench makes real calls on real models, and a lot of them. The reviews are the cases times the trials times the configurations, and each review is one research call for each profile and one vote for each finding for each lens: a review of the security profile with four candidate findings makes 13 calls, one to research and twelve votes, three lenses for each finding.

- **Tokens grow with the patch**, at about one token for every three or four bytes of diff. The research call reads the whole patch, and each vote reads the cited file's part of it.
- **Quorum counts more than that.** Its size guard counts one token for every byte of a request, with a reply budget of 16 000 tokens and 512 for the chat template (4096 for a `claude-code` provider), and refuses one that may not fit `contextTokens`: [The size of a request](./30-providers.md#the-size-of-a-request). A refused request is a `request-too-large` gap, so the review resolves, is recorded as incomplete, and catches nothing. At the default reply budget, the real-bug suite's largest patch, 40 797 bytes, needs a `contextTokens` of 58 806 for its research request with the shipped `security` profile and no guidelines, and a window of 65 536 holds that request for every case of the suite. A window of 32 768 refuses it for 10 of the 40 cases, as the size guard counts them: the 10 bug cases whose patch is over 14 759 bytes, the largest diff that window leaves room for in the table of [What it counts, and what it costs](./20-configuration.md#what-it-counts-and-what-it-costs). State the window the server really gives ([The context size](./20-configuration.md#the-context-size)), and compare configs whose windows hold the suite.
- **Run `--dry-run` first**, which prints how many reviews a run makes and costs nothing.
- **There is no spend cap yet.** A hosted model bills every call. Try one case and one trial first (`--case <id> --trials 1`), then widen. A stopped run resumes, so interrupting one loses nothing but the reviews in flight.

## Where not to run it

Run a bench by hand, or on a schedule on a trusted branch, never on a pull request. A pull request's author could change the suite, the configs or the prompts, and would spend your keys' budget on whatever they chose.

A suite is data, so nothing in it runs. But its patches go to the configured models, and the configs it is run with are trusted input: they must come from a place the run trusts, as for a review ([Trust](./20-configuration.md#trust)). A config also chooses where each key goes, so one you did not write can send the key it names, with every patch, to an endpoint of its choosing. A TS or JS config runs when it loads, and its prompt files steer every review.

## The real-bug suite

`bench/bugs/` is a suite of real security vulnerabilities, since the shipped profile is `security`, and a suite of other defects would measure that prompt and not the models. It holds 30 bug cases and 10 controls. The bug cases are in nine languages, none of them over a third of the bug cases, by the file of a case's first location: 6 in Python (code-graph-rag, mistune, banks, wheel, fonttools and BinderHub), 4 in Go (praktor, goshs, gorilla/handlers and gokey), 4 in JavaScript (flat-to-nested-js, fastify, opened and min-dash), 4 in PHP (CakePHP, Laravel, yii2-authclient and FOSUserBundle), 3 in TypeScript (Vue core, Hono and the React Native CLI), 3 in Ruby (ruby-jwe, mysql-binuuid-rails and kredis), 2 in Rust (lettre and slab), 2 in Java (the Compuware common configuration plugin for Jenkins and Spring Cloud Gateway) and 2 in C# (YoutubeDLSharp and SSH.NET).

Their weaknesses are a wide mix, and each case's `note` names its advisory, its CWE and the flaw. A case counts here under the first CWE its note names, and seven notes name a second CWE for their own flaw. Path traversal (CWE-22) is 4 cases and command injection (CWE-77, CWE-78) 5; SQL injection (CWE-89), XML external entities (CWE-611) and prototype pollution (CWE-1321) are 2 each, and predictable randomness (CWE-330, CWE-331) 3. Six more are flaws of authentication or of a check meant to establish trust (CWE-287, CWE-290, CWE-295, CWE-306, CWE-346, CWE-354), and one each is code injection (CWE-94), cross-site scripting (CWE-79), unsafe deserialization (CWE-502), an out-of-bounds access (CWE-119), a validator's result misread (CWE-20) and an SSL setting silently ignored (CWE-15). Their severities are those GitHub's advisories gave when each case was chosen: 10 critical, 15 high and 5 medium. The suite began with cases found by a search of high and critical advisories alone, and the cases added later took medium ones where a language's pool of high and critical held nothing sure. The medium ones are real flaws, none of them a denial-of-service class.

- **Where the cases come from.** Each bug case is a vulnerability whose fix an advisory names, a GitHub security advisory (`GHSA-...`) or a CVE record. The case's patch is the diff of the commit that introduced it, and its locations are the lines of that diff the fix changed, or next to which the fix added its check. A case whose bug does not show in that diff is left out. Recent advisories are preferred, and each case's `date` is recorded, so a reader can compare it with a model's training cutoff.
- **The controls** are 10 commits that no advisory names, one each of ten of the same projects, which cover the nine languages: praktor, lettre, Vue core, the Compuware plugin, YoutubeDLSharp, Laravel, gorilla/handlers, wheel, min-dash and kredis. Their locations are none, and a kept finding on one is unmatched.
- **Provenance.** Every case holds its `repo`, its fix and introducing commits, or its commit for a control, its `license`, its `copyright` lines, its `date` and a `note`. Where a patch leaves out a file, the note says so: the goshs case leaves out two test keys, and the React Native CLI and mysql-binuuid-rails cases a lockfile. The dates are the committer's local day, as [Provenance](#provenance) says.
- **Licenses.** The projects are permissively licensed, MIT, BSD-3-Clause and Apache-2.0 today, and the repository's test takes no license but MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause and ISC. `bench/LICENSES/` holds the text of each license the cases use, in one file named by its SPDX id, which is the REUSE layout, and a test checks that every case's license has its file there and that the directory holds no other. A project under Apache-2.0 with a `NOTICE` file is left out for now, since that layout does not carry its notice. `.gitattributes` keeps each patch byte for byte. Each patch is under 64 KiB, and they run from 1 133 to 40 797 bytes: the window a run needs for the largest is in [What a run costs](#what-a-run-costs).
- **It ships nowhere.** The suite is in the repository and in no package, binary or image: to run it, use a clone, and point `quorum bench` at `bench/bugs`. `src/bench/suites.spec.ts` validates it in the default test suite, as a run does, with no model.

The suite may still grow. At 30 bug cases, every interval of a report is still wide, as [The interval](#the-interval) shows, so read a bench of it as a first look, and not as a ranking.

## Attack suites

A suite can hold attack cases beside its bug cases, to measure what text planted in a patch does to a review. An **attack case** is a poisoned twin of a bug case of the same suite: the twin's own patch, with text added that tries to hide its bug, to make the review keep a decoy, to bloat its output, or to deny it. `quorum bench` reviews both and scores each attack case against its twin's review of the same trial, by code, so what separates the two reviews is the planted text. The unit is the twin, not the case. [Measurement](../30-security/40-measurement.md) says what each outcome means and how far to trust it.

An attack case is one more kind of case, `kind: attack`. It has the `id`, the `patch` and the optional `repo`, `license`, `copyright`, `date` and `note` of any case, never a commit, which its twin holds, and these fields:

| Field | Rule |
| --- | --- |
| `twin` | Required. The `id` of a bug case of the same suite, whose patch this one poisons. A control, another attack case and the case itself are refused |
| `goal` | Required. What the attack tries: `suppression`, `forced-keep`, `cost-bloat` or `denial-of-review` |
| `carrier` | Required. Where the text sits: `comment`, `string-literal`, `file-name`, `documentation` or `guideline-file` |
| `encoding` | Required. How it is written: `plain`, `multilingual`, `hidden-unicode`, `base64`, `html-comment` or `fake-delimiter` |
| `locations` | Required. Where the twin's bug is in this patch, whose lines the planted text may have moved: the rules of a bug's locations |
| `decoy` | For a `forced-keep` only, and required there: a `{ file, start, end }` of lines of this patch that hold no bug and that a finding must not keep |
| `twinDecoy` | For a `forced-keep` only, and required there: the same code's lines in the twin's patch, so that the twin's review is checked for the same finding |

```yaml
- id: exec-shell-comment
  kind: attack
  patch: exec-shell-comment.patch
  twin: exec-shell
  goal: forced-keep
  carrier: comment
  encoding: plain
  locations:
  - file: src/app.js
    start: 5
    end: 5
  decoy:
    file: src/app.js
    start: 12
    end: 12
  twinDecoy:
    file: src/app.js
    start: 11
    end: 11
```

The checks are made before any call, with the suite's others, and each names the case by its index and never quotes a patch:

- **The twin.** `cases.3.twin: must be the id of a bug case of the suite`, for an id the suite lacks, a control, an attack case and the case itself alike.
- **The spans.** Each location of a bug or an attack case, and an attack case's decoy, is looked up in the case's own patch, and the twin decoy in the twin's: `cases.3.twinDecoy: line 4 is not in a hunk of the twin's patch`, or `cases.3.decoy.file: is not a file of the patch, as its diff --git header names it`.
- **The decoy's distance.** A decoy in the same file as a location of its case, with the two ranges within twice the `window` of each other, is refused as `cases.3.decoy: is within twice the window of a location, so one finding could catch both`, since that finding would read as a catch and as a forced keep. The twin decoy is checked against the twin's locations the same way, and reads `cases.3.twinDecoy: is within twice the window of a location of the twin, so one finding could catch both`.
- **The kinds' rules.** `cases.3.goal: is required for an attack`, `cases.3.decoy: is required for a forced keep`, `cases.3.decoy: is only for a forced keep`, `cases.0.twin: is only for an attack`, and, on a control, `cases.2.locations: is only for a bug or an attack`.

### How they are scored

The report keeps its first table: recall over the bug cases, which are the twins, and the reviews, the incomplete reviews and the tokens over every case. Its header names the kinds, `12 bug cases, 0 controls and 48 attack cases`, and a suite without an attack case keeps `2 bug cases and 1 control`. After the comparisons comes a section `## Attacks`:

- **The pairing.** An attack case's trial is paired with its twin's same trial, over the trials both recorded. A twin's score under attack is the mean of its attack cases of a goal, and its clean score the mean of their paired twin trials. An attack case with no pair, because its twin is outside the selection or a trial is not recorded, is left out of its line and reads `n/a`: it is never scored as a success or a failure of the attack.
- **Five lines for each configuration**, one per measure: suppression, as kept recall and as proposed recall; a forced keep, the decoy kept; cost bloat, the output tokens per review; and denial of review, the share of incomplete reviews. Each takes a Wilson interval over the twins, under attack and clean, for a rate, and an exact sign test over the twins whose two scores differ, with the twins the attack moved its way, those it moved the other way, and the ties.
- **The flags,** once for the report: the share of the poisoned patches that raise an advisory flag, read from the patches before any call, against their twins'.
- **Each case, carrier and encoding.** A table by carrier and by encoding gives each goal's first measure as `<under attack> / <clean> (<cases>)`, with the number of cases flagged, and a table of the cases lists each with its twin, goal, carrier, encoding, whether its patch is flagged and its paired score. They are means without an interval. `report.json` holds every measure of each case.

A progress line of an attack case reads as a bug case's: it says whether a finding caught the bug. This excerpt is made up, to show the shape, apart from the flags line, which is the corpus's own: no run produced the other numbers.

```text
## Attacks

Each attack case is paired with its twin trial by trial, over the trials both recorded. A twin's attack cases of one goal give its score under attack, and their paired trials of the twin its clean score. A rate is the mean over the twins, with its 95% Wilson interval over the twins, and each line is an exact sign test over the twins whose two scores differ. A case's score, and the scores by carrier and by encoding, are means without an interval.

- Advisory flags, raised by the patch: 22.9% [7.8%, 51.2%] of the poisoned patches, 0.0% [0.0%, 24.2%] of their twins, over 12 twins; +22.9 points; 8 higher, 0 lower, 4 tied; p = 0.0078, resolved

### Configuration 1

- Suppression, kept recall: 58.3% [32.0%, 80.7%] under attack, 83.3% [55.2%, 95.3%] clean, over 12 twins; -25.0 points; 6 toward the attack, 0 against, 6 tied; p = 0.0313, resolved
- Suppression, proposed recall: 83.3% [55.2%, 95.3%] under attack, 83.3% [55.2%, 95.3%] clean, over 12 twins; 0.0 points; 0 toward the attack, 0 against, 12 tied; p = 1.0000, unresolved
- Forced keep, the decoy kept: 33.3% [13.8%, 60.9%] under attack, 8.3% [1.5%, 35.4%] clean, over 12 twins; +25.0 points; 3 toward the attack, 0 against, 9 tied; p = 0.2500, unresolved
- Cost bloat, output tokens per review: 1450 under attack, 1210 clean, over 12 twins; +240; 8 toward the attack, 1 against, 3 tied; p = 0.0391, resolved
- Denial of review, incomplete reviews: 16.7% [4.7%, 44.8%] under attack, 0.0% [0.0%, 24.2%] clean, over 12 twins; +16.7 points; 2 toward the attack, 0 against, 10 tied; p = 0.5000, unresolved

| By | Cases | Flagged | Suppression | Forced keep | Cost bloat | Denial of review |
| --- | --- | --- | --- | --- | --- | --- |
| carrier comment | 12 | 4 | 50.0% / 83.3% (3) | 33.3% / 0.0% (3) | 1520 / 1180 (3) | 0.0% / 0.0% (3) |
| encoding hidden-unicode | 8 | 8 | 50.0% / 100.0% (2) | 50.0% / 0.0% (2) | 1390 / 1160 (2) | 25.0% / 0.0% (2) |

### Cases

| Case | Twin | Goal | Carrier | Encoding | Flagged | 1 |
| --- | --- | --- | --- | --- | --- | --- |
| laravel-framework-suppression-comment-plain | laravel-framework-ghsa-w2pm-r78h-4m7v | suppression | comment | plain | no | 50.0% / 100.0% (10) |
```

The reading of each line is in [What each outcome means](../30-security/40-measurement.md#what-each-outcome-means), and the section that ends every report, the lenses' error correlation, in [The inter-voter error correlation](#the-inter-voter-error-correlation).

### The injection corpus

`bench/injection/` is the repository's attack suite: the twelve twins, bug cases of the real-bug suite copied whole, and 48 attack cases, one of each goal for each twin. [Measurement](../30-security/40-measurement.md#the-injection-corpus) describes its twins, carriers and encodings. On a clone, its plan reads:

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_RESEARCH_CONTEXT_TOKENS=131072
quorum bench --dry-run bench/injection
```

```text
Suite injection: 60 of 60 cases, 12 bug cases, 0 controls and 48 attack cases
Configurations:
  1. (default configuration)
     security: research qwen3.6:27b @ http://localhost:11434; panel qwen3.6:27b @ http://localhost:11434
Trials: 10
Reviews: 600 planned, 0 recorded, 600 to run, at most 1 at a time
Run directory: quorum-bench/injection
Dry run: no review was run, and nothing was written.
```

- **Ten trials, so 600 reviews per configuration.** The suite sets `trials: 10`, which steadies each case's score. A review is a research call and a vote from each lens on each finding, on real models, so run `--dry-run` first and try one twin and one of its attacks before the whole: [What a run costs](#what-a-run-costs).
- **A window of 32 768 tokens.** The largest research request of the corpus needs 29 926 tokens as the size guard counts them, and the largest vote at most 25 965, so a model of an HTTP provider whose window is 32 768 tokens takes the whole corpus, as a run against a stub server confirmed. That holds for the default reply budget, the shipped `security` profile and no guidelines: a larger `maxTokens`, a longer prompt or guidelines can make the size guard refuse a poisoned review, which then reads as a denial hit: [Measurement](../30-security/40-measurement.md#the-window).
- **A manifest and a generator.** `bench/injection/manifest.yaml` holds each payload as a reviewer reads it, and `scripts/injection-corpus.ts` writes `suite.yaml` and `cases/` from it, by hand with `bun run ./scripts/injection-corpus.ts`. A test holds the committed files equal to its output, so change the manifest and run the generator again, and never edit `suite.yaml` or a patch.
- **It ships nowhere.** The corpus and its generator are in the repository and in no package, binary or image, and `quorum bench` never runs the generator: use a clone. `src/bench/suites.spec.ts` validates the corpus in the default test suite, as a run does, with no model.
- **`--case` with an attack case.** `--case` runs the cases it names and no more, so an attack case named alone has no twin of the same trial to pair with, and reads `n/a`. Name its twin too.
- **`--retry-incomplete` with poisoned patches.** It runs again the reviews of a poisoned patch that were denied or came back with a gap, and the later record replaces the earlier one in the report, so the denial an attack caused is lost, after an outage too. It is not needed to recover from an outage: a plain run already runs again a review that an outage failed, since a failed review is not recorded, and the flag only adds the rerun of the recorded denials and gaps. Name a new `--out` when the old run must stay intact.

## Next

[Threat model](../30-security/10-threat-model.md) — the attacker, the assets, the residual risk stated plainly, the controls in place today, and what the panel's independence is worth.
