# Reports for GitHub

One review's result is written for GitHub in a few ways, each a format of `--format` (`-f`) and each from the [public view](../30-security/30-output-handling.md#the-public-view), so no sink a stranger reads holds a model's reasoning, a discarded finding, a model's name or the usage: a summary for a pull request or the job summary, the payload that `quorum-action` posts, and SARIF for code scanning. This page lists the formats and describes the summary, the payload and SARIF.

## The formats

| Format | What it writes | Public view only |
| --- | --- | --- |
| `text` | The review as a person reads it: [The report](./10-cli.md#the-report) | No |
| `json` | The whole result as JSON: [The report](./10-cli.md#the-report) | No |
| `brief` | One line of counts and code words: [The report](./10-cli.md#the-report) | No |
| `markdown` | The summary of the review, below | Yes |
| `payload` | The payload `quorum-action` posts, below | Yes |
| `sarif` | SARIF for GitHub's code scanning, below | Yes |

A format marked public only renders the public view of whatever it is given, a full result included, so no way of calling it publishes the reasoning: [Public-only formats](../30-security/30-output-handling.md#public-only-formats). `--view` does not change it. The three that are not marked write what they are given, so `--view public` is what makes them the public view.

## The summary

`-f markdown` writes the summary, which a CI job posts as a pull request comment or appends to its job summary. For a review of a range that kept one finding, left one unreviewed and had a gap, it is:

````markdown
<!-- quorum:summary:v1 -->
### quorum review

**exit 1, findings:** a gating profile kept a finding at or above its fail-on level

| Profile | Fail-on | Kept | Unreviewed | Discarded | Outside the diff | Coverage |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| security | high | 1 | 1 | 1 | 0 | 1 of 3 files reviewed, 1 in part, 1 not |

#### Findings

- **HIGH** security · `src/auth/login.ts` line 42 · `CWE-89` · kept by 3 of 3 lenses

  `SQL built from the request's id parameter reaches db.query`

  ```text
        41   const sql = 'SELECT * FROM users WHERE id = ' + id
     >  42 + db.query(sql)
        43   return rows
  ```

- **UNREVIEWED** security · `src/session.js` line 20 · `CWE-338` · kept by 1 of 3 lenses, 1 vote failed

  `Session tokens come from Math.random, which is not a cryptographic generator.`

  ```text
           -   return crypto.randomBytes(32).toString('hex')
     >  20 +   return Math.random().toString(36).slice(2)
        21   }
  ```

#### Gaps

- security, binary: the diff carries no content for a binary file

#### Files left out

- `assets/logo.png` (binary)

#### Flags

- hidden-characters at `src/session.js` line 20: `U+202E on 1 added line(s)`

---

quorum 0.6.0 · range `1f3a9c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`...`7b2e4d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
````

- **The first line** is the marker, `<!-- quorum:summary:v1 -->`, the only raw HTML the summary holds. It names the summary and its version, so a program can find its own comment. It proves nothing without its author: anyone can write the marker, so check who wrote the comment too.
- **The verdict** says what the exit code says, in the words of the last line of the text report: `exit 1, findings`, `exit 4, incomplete`, `exit 130, interrupted` or `exit 0, pass`. An interrupted review says `the review was stopped before its end; what it read is above`: its gaps are `interrupted`, which no flag lifts.
- **The table** has a row for each profile: the level it fails at (`none` for an advisory profile), how many findings it kept and left unreviewed, how many the panel discarded (counted, never listed), how many findings it dropped for citing code outside the diff, and how much of the diff it reviewed.
- **The findings** are the kept and the unreviewed ones, each with its level, its profile, its file and line, its category, how its lenses voted, its claim and its evidence, numbered as the text report numbers it: the cited row is marked `>`. A finding that fails its profile comes first, then the high ones, the medium, the unreviewed and the low, each group by file and then by line, so the budget drops the least important last.
- **The gaps** are one line for each profile and reason, in fixed words that say nothing of the diff, with a count in parentheses when a profile records a reason more than once.
- **The files left out** and **the flags** list the first 20 each, then how many more. A file with no name, the part of a diff that no header names, is `(no path)`. A held file's line carries its reason and its rule: `(secret: name)`.
- **The trailer** is the version and what was reviewed: a range's two commits, the commit a local or staged review sits on, the commit of a path review, or `diff`.

A section with nothing to list is left out, so the review of a blank diff is a heading, a verdict, a table and a trailer.

### Why every text is in a code span

A claim, a category, a file name, a row of code and a flag's detail are text that a model or the diff wrote, and an attacker can influence it. Written bare, a name or a claim could mention a person, link an issue or a commit, load an image, become an emoji or math, or hold HTML. A code span is the one Markdown construct that stops all of that at once, and a backslash does not stop a mention, so the summary puts each such text in a span, whose fence quorum computes to be longer than any run of backticks inside, and the evidence in a fenced block that no row can close. No such text is in a table cell, since a `|` splits a cell even inside a span. Every line passes `inertLine`, so a log that echoes the summary starts no workflow command. The rule, and what the summary never writes, are in [Markdown](../30-security/30-output-handling.md#markdown).

### The size

A summary is at most 60,000 UTF-16 code units, inside GitHub's limit on a comment and the job summary's. A large review can hold more: 100 findings with their evidence are about 280,000 characters. The summary drops whole pieces until it fits, in this order, and counts what it dropped:

1. the evidence of the findings, from the last one up, with a note that says how many findings lost theirs;
2. the flags, last first;
3. the files left out, last first;
4. the findings, last first, so those that fail their profile go last;
5. the gap lines;
6. the profiles' rows.

Each list that lost entries ends with a line that counts them, as `- and 5 more, listed in the review's JSON result`, and the findings' line names their levels. The marker, the heading, the verdict, the section headings, the count lines, the note and the trailer stay whatever the budget, since they hold only words quorum wrote, numbers, the version and commit ids. A string is never cut, so a code span or a block is whole or gone.

### Writing it

```bash
quorum --range "$BASE...$HEAD" -f markdown >> "$GITHUB_STEP_SUMMARY"
```

`-f markdown` writes the summary on stdout, and `--output markdown=<path>` writes it to a file as well as the format on stdout: `--output markdown="$RUNNER_TEMP/summary.md"`. Either is the public view whatever `--view` says. The exit code is the review's, so the step fails on a finding as the review does; the summary is written first. A program calls `renderReport(result, { format: 'markdown' })`: [`renderReport`](../95-reference/30-library-api.md#renderreport).

## The payload

`-f payload` writes the document that `quorum-action` posts as it is: one versioned JSON object that holds the commit the review is about (`head`), what it concluded (`conclusion`: `pass`, `findings`, `incomplete` or `interrupted`, the exit code's meaning), the summary above, and a line comment for each kept or unreviewed finding that sits on a file of the diff, with the count of the findings no line can hold (`unplaced`). Each comment's body starts with a marker that holds the finding's fingerprint, then the level, the profile, the category, how the lenses voted and the claim, the category and the claim in code spans. The JSON is written by `inertJson`, so every text in it is inert and the Action composes none of its own. It is the public view whatever `--view` says.

```bash
quorum --range "$BASE...$HEAD" -f brief --output payload="$RUNNER_TEMP/payload.json"
```

Every field, the body and what the Action owns: [The Action's payload](../95-reference/50-action-payload.md).

## SARIF

`-f sarif` writes SARIF 2.1.0, the format GitHub's code scanning reads, as one run of the public view:

- **The tool** is `quorum`, with its version, and a rule for each profile, `quorum/<profile>`, whose texts quorum's code writes and whose help says what each level means for that profile's `failOn`.
- **A result** for each kept or unreviewed finding that sits on a file of the diff, at its path, its line and the columns of its cited row. Its message is the level, how the lenses voted, the category and the claim, so a reviewer sees what the summary says. Its `quorumFingerprint/v1` is the finding's fingerprint. A kept finding also gets its confidence as `precision`. A finding that names no file of the diff, as a review of a diff with no per-file headers has, or a path that is not a clean relative path (it starts with `/`, or has an empty, `.` or `..` segment), has no place for a result and is counted in a notification.
- **The run's commit**, when the source has one: a range's head, a local or staged review's head, or a path review's commit.

```bash
quorum --range "$BASE...$HEAD" -f brief --output sarif="$RUNNER_TEMP/quorum.sarif"
```

### The levels

A result's level agrees with the exit code. It is `error` exactly when the finding fails its profile, the rule that sets exit 1: a kept finding at or above the profile's `failOn`. Another kept `high` or `medium` finding and an unreviewed one are `warning`, a kept `low` one is `note`, and a profile at `none` writes no `error`. GitHub's check fails on an `error` alert, so it fails where quorum's gate does.

A result sets no `security-severity`. GitHub reads that number before the level, so a number quorum chose would decide the check instead of the profile's `failOn`, which is what the owner configured.

### The notifications

The run's `executionSuccessful` is `false` whenever a gating profile has a gap or an unreviewed finding, or any profile, an advisory one included, has an `interrupted` gap, even when a kept finding sets exit 1 or `--allow-incomplete` lifted the gaps, since a run that did not review everything is not complete. A gap's notification has the level `error` for a gating profile and `warning` for an advisory one, the gap's fixed words, and the files it is about, at most 100 with their count. Only a file that is a clean relative path, as for a result, gets a location: another is counted and never located, so no location names another place. A file left out with no gap, which is one that an `exclude` pattern or a path review's skip rule left out, or a deleted secret, is a `note`, and so is the count of the findings no result holds. They come in that order: the gaps, the files left out, the count.

GitHub does not show notifications. They are in the file for the tools that read it and for the person who opens it, and the [summary](#the-summary) is where a gap is read.

### What GitHub does with it

- **Duplicate alerts.** GitHub matches an alert across uploads by `primaryLocationLineHash`, which `upload-sarif` computes from the code at the result's line, by reading the files under its checkout, when the file leaves it out. Without a checkout, as in the post job below, no line hash is computed, so each push can open new alerts. Quorum's own fingerprint is a different hash, so it sits under its own key, which GitHub ignores. A finding whose line moves in a later push can open a new alert beside the old one. This is the price of keeping an alert from being matched to a dismissed one by a reading quorum did not foresee.
- **Private repositories.** Code scanning is free for a public repository, and a private one needs GitHub Code Security. A review is then never only SARIF: the summary and the exit code say the same, where code scanning is not there.
- **Nothing uploads it.** quorum writes the file and uploads nothing; `github/codeql-action/upload-sarif` does.

## quorum report

The post job of a two-job workflow holds no model key and no checkout of the pull request: it downloads the result the review job saved and renders it with `quorum report`, which calls no model, reads no config and runs no git.

```bash
quorum report result.json -f payload --output markdown="$GITHUB_STEP_SUMMARY" --output sarif=quorum.sarif
```

It reads the full result or the public view, a file or stdin, only from the same release, through a strict schema, and writes any format as the review command would have from the same result: the summary, the payload and the SARIF are the public view whatever `--view` says. It exits `0` whatever the review found, since the review job's exit code is the gate, and `2` for a result it refuses, which fails the post job: a result of another release, a truncated download and a public view with a field added are each one message that names the cause and holds no value, no text and no key but a code word of the file. Its flags, its refusals and its exit codes: [quorum report](./10-cli.md#quorum-report).

## A GitHub workflow

Two jobs keep the model key, the write token and the pull request's code apart: a review job that holds the key and a post job that holds the token. A fork's pull request runs neither.

```yaml
name: Quorum

on:
  pull_request:

permissions: {}

env:
  QUORUM_VERSION: 0.7.0

jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
    - name: Check out the base, with the history the range needs
      uses: actions/checkout@v7
      with:
        ref: ${{ github.event.pull_request.base.sha }}
        fetch-depth: 0
        persist-credentials: false
    - uses: actions/setup-node@v7
      with:
        node-version: 24
    - name: Install quorum
      run: npm install -g "@tobi-or-not/quorum@$QUORUM_VERSION"
    - name: Review the pull request's commits
      env:
        BASE: ${{ github.event.pull_request.base.sha }}
        HEAD: ${{ github.event.pull_request.head.sha }}
        QUORUM_RESEARCH_PRESET: anthropic
        QUORUM_RESEARCH_MODEL: ${{ vars.QUORUM_MODEL }}
        QUORUM_RESEARCH_CONTEXT_TOKENS: ${{ vars.QUORUM_CONTEXT_TOKENS }}
        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      run: exec quorum --range "$BASE...$HEAD" --view public -f brief --output json="$RUNNER_TEMP/quorum-result.json"
    - name: Keep the public view for the post job
      if: ${{ !cancelled() }}
      uses: actions/upload-artifact@v7
      with:
        name: quorum-result
        path: ${{ runner.temp }}/quorum-result.json
        retention-days: 1

  post:
    needs: review
    if: ${{ !cancelled() && needs.review.result != 'skipped' }}
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      security-events: write
    steps:
    - uses: actions/download-artifact@v8
      with:
        name: quorum-result
        path: ${{ runner.temp }}
    - uses: actions/setup-node@v7
      with:
        node-version: 24
    - name: Install quorum
      run: npm install -g "@tobi-or-not/quorum@$QUORUM_VERSION"
    - name: Render the summary and SARIF from the saved result
      run: |
        quorum report "$RUNNER_TEMP/quorum-result.json" -f brief \
          --output markdown="$RUNNER_TEMP/quorum-summary.md" --output sarif="$RUNNER_TEMP/quorum.sarif"
        cat "$RUNNER_TEMP/quorum-summary.md" >> "$GITHUB_STEP_SUMMARY"
    - uses: github/codeql-action/upload-sarif@v4
      with:
        sarif_file: ${{ runner.temp }}/quorum.sarif
        category: quorum
        ref: refs/pull/${{ github.event.pull_request.number }}/head
        sha: ${{ github.event.pull_request.head.sha }}
```

Set `QUORUM_VERSION` to the release you run. The model variables are the example's: use the provider, model and window of your own config, and a config file from the base checkout, as [Trust](./20-configuration.md#trust) says.

### The review job

- **It checks out the base, not the pull request.** `ref` is the base commit, so no checkout of the pull request's head exists in a job that holds a key, and a config file the job reads is the base's. `--range` reads the head's commits with plumbing alone, `rev-parse`, `merge-base` and `diff` of two commits, whose objects the fetch brought: [A pull request from a fork](./15-sources.md#a-pull-request-from-a-fork) explains the reading. `persist-credentials: false` leaves no token in the checkout's git config.
- **`fetch-depth: 0`** brings the history where the two sides meet, which a shallow clone lacks: [A range of commits](./15-sources.md#a-range-of-commits).
- **`--view public`** keeps the reasoning, the discarded findings, the models and the usage out of the artifact and the log, which anyone signed in can read on a public repository: [The public view](../30-security/30-output-handling.md#the-public-view).
- **`exec` starts quorum as the step's own process.** GitHub's runner signals the step's shell and not its children, so a cancelled job's SIGINT or SIGTERM reaches quorum only once `exec` has replaced the shell with it. It then stops the review as [Interrupting a review](./10-cli.md#interrupting-a-review) says: what it read is written to the result, with an `interrupted` gap, and the step exits `130`. A step that runs commands after quorum cannot use `exec`: put quorum last.
- **The result goes to `$RUNNER_TEMP`,** a directory of the runner that a pull request cannot plant a file in, as it can in the workspace. The step's exit code is the gate: `0`, `1`, `2`, `3` or `4`, as [Using it in CI](./10-cli.md#using-it-in-ci) lists. The upload runs whatever it was, and the post job renders a review that wrote a result: a review that found something (`1`) or left a gap (`4`) did. An exit `2` or `3` reviewed nothing and wrote none, so the post job fails at its download, and the review job's own failure is the cause to read.

### The post job

- **It holds no model key,** and it runs nothing a model wrote: it downloads the saved result and renders it with `quorum report`, which calls no model, reads no config and runs no git.
- **It installs the same release,** since the reader takes only a result of its own release: [quorum report](#quorum-report).
- **The summary** is appended to the job summary, and **the SARIF** goes to code scanning with `github/codeql-action/upload-sarif`. A private repository needs GitHub Code Security for that step: [What GitHub does with it](#what-github-does-with-it).
- **The upload names the head.** `ref` and `sha` are the pull request's head, `refs/pull/<number>/head` and its commit, because quorum reviews the changes from the merge base to the head, so every line of a result is a line of the head. Without them `upload-sarif` on a `pull_request` uses the merge commit, which the post job has no checkout to correct, and an alert can land on another line, or outside the pull request's diff, when the base has changed the same file since the merge base.
- **`actions: read` and `contents: read` stay.** On a private repository `upload-sarif` reads the run and the repository with them, so a job trimmed to `security-events: write` alone fails at the upload there. They grant no write.

### What the workflow settles

- **A fork's pull request runs neither job.** The review job's `if` compares the pull request's head repository with this one and skips a fork's, and the post job's `needs` skips with it. A fork's run gets no secret, and `pull_request_target`, which would give it one, runs the base's workflow beside the fork's code, so the workflow never uses it. A maintainer reviews a fork's pull request from a clone of their own: [A pull request from a fork](./15-sources.md#a-pull-request-from-a-fork).
- **Every value reaches a script through `env:`.** No `run:` holds a `${{ }}` expression: the commit ids, the key and the variables are set in `env:` and read as `$BASE` and `$HEAD`, so none of them is parsed as shell code.
- **Pin each action to a commit,** as this repository's workflows do, with the tag in a comment: `uses: actions/checkout@<commit> # v7.0.1`. The tags above keep the example short, and a tag can be moved.
- **Line comments on the pull request** are `quorum-action`'s, from the payload: [The payload](#the-payload). The workflow above posts the summary and SARIF only.

## Next

[Threat model](../30-security/10-threat-model.md) — the attacker, the assets, the residual risk stated plainly, the controls in place today, and what the panel's independence is worth.
