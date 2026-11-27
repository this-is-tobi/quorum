# Scanner reports

A scan job that ran before the review, Trivy, Semgrep, CodeQL, ESLint or SonarQube, wrote a report of what it found. `--sarif` and `--sonarqube` hand that report to a review: the issues it lists on the change go to the panel of the profile it names, as candidates, and are judged by the same blind votes as the finder's findings. This page says what quorum reads, the flags, how each format is read, how a path is placed against the change, what the panel sees, and every limit that leaves a gap.

## What quorum reads, and never runs

- **Files only.** Quorum reads the file a flag names and never runs a scanner, calls a scanner's server or reads a path a report names. The scan job is the CI's, and it runs before the review.
- **As data, never as configuration.** A report is text the change can influence, since the change's own code and files are what the scanner read. Each is read through the bounded reader, as a regular file and never through a link, at most 16 MiB; its text is cleaned and capped before a model reads it, a text that reads as a credential is never sent, and what a model reads of it is fenced as a claim, for the voters of its own candidate alone: [What the panel sees](#what-the-panel-sees).
- **A scanner never decides.** Its issue is a candidate: it goes through the same panel as a finding and is kept or dismissed by the votes. A report can add candidates and facts to a review, and never removes a finding or lowers a verdict.
- **Nothing local is written out.** No result, event, line or detail holds a report's path, a file name it lists or its text; they hold counts, hashes, code words and a cleaned scanner name.
- **A review that names no report** gets no new gap, no new block and no new line.

## The formats and the flags

| Flag | Reads | Feeds |
| --- | --- | --- |
| `--sarif [<profile>=]<path>` | A SARIF 2.1.0 log | The named profile's panel |
| `--sonarqube [<profile>=]<path>` | A saved response of SonarQube's `api/issues/search` | The named profile's panel |
| `--scan-root <dir>` | | The absolute directory the scanners ran in, stripped from the absolute paths their reports name: [The paths](#the-paths) |

```bash
quorum --range "$BASE...$HEAD" \
  --sarif security=scan/trivy.sarif \
  --sonarqube security=scan/issues.json \
  --scan-root /src
```

- **Each report names its profile.** `security=trivy.sarif` feeds the `security` profile and no other, and any profile that runs can be named, the built-in ones and one of your own alike. With one profile running, `<profile>=` may be left out. With several it must name a running one, so a report is never read for a profile by guess. To feed two profiles one file, name it twice.
- **A value that starts with a profile id and `=` names the profile.** The id is lower case letters, digits, `_` and `-`, starting with a letter. A file whose name looks like one is written with a path: `./a=b.sarif`. Any other value is a path, relative to the working directory unless it is absolute.
- **The flags repeat**, once for each report, at most 16 reports in all, `--sarif` and `--sonarqube` together. The reports are read in the order of the flags, the `--sarif` ones first, and each report's place in `meta.context.reports`, and its number from 1 in the lines, follow that order.
- **`--scan-root` takes one directory**, and only beside a report.

### What an error looks like

| Error | When | Exit |
| --- | --- | --- |
| `Error: --sarif: must name a file` | An empty path, `--sarif ''`, or a profile with no path, `--sarif security=`. `--sonarqube` has the same | `2`, with the usage, before any config |
| `Error: --sarif: takes at most 16 reports in all` | A seventeenth report, named at the flag of the seventeenth | `2`, with the usage |
| `Error: --scan-root: must be an absolute directory` | A directory that does not start with `/`, or that holds an empty, `.` or `..` segment, a trailing `/` aside | `2`, with the usage |
| `Error: --scan-root: takes one directory` | A second `--scan-root` | `2`, with the usage |
| `Error: --scan-root: needs --sarif or --sonarqube` | A scan root and no report | `2`, with the usage |
| `Error: --print-config: reads no report, so it takes no --sarif, --sonarqube or --scan-root` | Any of the three with `--print-config`, which reads no diff | `2`, with the usage |
| `Error: --sarif: names the profile "securty", which does not run` | A report for a profile that is not among the ones that run: a typo never drops a report silently | `2`, no usage, after the config loads and before any git |
| `Error: --sarif: must name a profile when several run` | A report with no profile while several run | `2`, no usage, after the config loads and before any git |

No message repeats a path or a value given, but a profile's id, which is named when it is safe to print. `quorum mcp` defines none of the three flags, so each is `Unknown option` there, exit `2`: an agent's review reads the changes it names, and a scan is the CLI's. A report's file is never an exit `2`: a file that is missing, a link, over 16 MiB or in no known format is a gap of the profile it feeds ([The limits and the gaps](#the-limits-and-the-gaps)), so a scan job that crashed costs its report and never the model's review.

`maxScannerIssues` is the one setting: how many issues on the change each profile's panel judges in one review, 50 by default: [The outcomes and the cap](#the-outcomes-and-the-cap).

## Reading a SARIF log

The log is read as SARIF 2.1.0 reads it, its optional parts as optional, at most 20 runs and 25000 results in a run, GitHub's own limits: what is past them is not read, and the report is read in part. What the file held past them is counted, not dropped: the results of a run beyond its 25000, and every result of each run past the 20th, are `notRead` in the report's record, and the report's `listed` is what the file held.

- **A result is an issue** when its `kind` is absent or `fail`. Any other kind, `pass` or `informational`, is counted as skipped, and so is no issue.
- **What is read of a result** is its rule (`ruleId`, else `rule.id`), its level, its message and its first location: `physicalLocation.artifactLocation.uri`, `region.startLine` and `region.snippet.text`. Later locations, related locations and code flows are not read, nor is `uriBaseId`: [The paths](#the-paths).
- **The message** is `message.text`, else the rule's `shortDescription.text`. A result with neither, with no rule id, or whose line is no whole number of 0 or more, is counted as unreadable, and the rest are read.
- **The rule's text**, which the voters of the issue read, is the first of the rule's `help.text`, `fullDescription.text`, `shortDescription.text` and `name`, found by the result's rule index (in the extension the result names, else the driver) and else by the rule's id.
- **A missing level is unknown, never ignorable.** The level is the result's, else its rule's `defaultConfiguration.level`, else `unknown`. An issue of unknown severity is a candidate like any other and is capped last.
- **A run that failed is no clean run.** A run with no `results` list at all (absent or `null`) is a scanner that failed, where an empty list is a clean run. A log whose every run has none is unreadable (`no-results`), and one with some, or with a run whose `invocations` say `executionSuccessful: false`, is read in part, since what the scanner did not scan is unknown.
- **Suppressions are recorded and never honoured.** A result with a suppression whose `status` is `accepted`, or absent, is marked suppressed: SARIF sets no default for a status, and quorum reads a suppression with no status as in effect. One that is `rejected` or `underReview` marks nothing. It is a candidate all the same, since a suppression is the change's own comment or a baseline the change can edit. Its finding says `marked suppressed` in the summary and the line comment, and it is no SARIF `suppression` in the SARIF quorum writes: [SARIF](./80-reports.md#sarif).
- **The scanner** is the first run's `tool.driver.name`; the commit a run states, `versionControlProvenance[].revisionId`: [The commit](#the-commit).

## Reading a saved SonarQube response

The response is what `api/issues/search` answers, saved to a file by the scan job: its `issues`, `components`, `rules`, `total` and `paging`, read leniently, so a field a version adds is no trouble. A response with no `issues` list is no response and is unreadable.

- **An issue's file** is its component's `path` in `components`, else the component's key less its project key and the colon. An issue on the project itself names no file and is not in the change.
- **Its line** is `line`, else `textRange.startLine`; an issue with neither has no line of its own and is file-level: [The outcomes and the cap](#the-outcomes-and-the-cap).
- **An open issue** is one whose `issueStatus` is `OPEN` or `CONFIRMED`, or, with no `issueStatus`, whose `status` is `OPEN`, `CONFIRMED` or `REOPENED`. Any other, resolved, closed, accepted or a false positive, is skipped: a decision a person with SonarQube's rights recorded outside the change is honoured, and a suppression the change writes is not.
- **Its level** is the highest of its `impacts` severities, else its `severity`: `BLOCKER`, `CRITICAL` and `HIGH` are `error`, `MAJOR` and `MEDIUM` are `warning`, `MINOR`, `INFO` and `LOW` are `note`, and any other is unknown.
- **Its rule's text** is the rule's `name` in `rules`, when the response holds it. The scanner is `SonarQube`, and a response states no commit.
- **A response that holds fewer issues than its search found** is read in part: its `total` (else `paging.total`) is above the issues it holds, so the file is one page of the answer. At 10000 the gap says that is SonarQube's own cap on a search, and to narrow the query.

## The paths

A report names a file as its scan job saw it, so quorum makes the path the repository's own by rules that never open a file and never match by suffix:

1. A SARIF `uri` with a scheme other than `file`, or a `file` URI whose host is not empty or `localhost`, is unmapped. A `uri` is percent-decoded once, and one that does not decode is unmapped. A SonarQube path or any other path is never decoded.
2. An absolute path under the scan root loses that prefix. Any other absolute path is unmapped.
3. A leading `./` is dropped, and a path with an empty, `.` or `..` segment is unmapped.
4. The scan root's own place below the repository's top level, with its trailing `/`, goes in front of the path.
5. The result is compared as it is with the diff's own paths. An issue whose path matches is on a file of the change; the others are counted and never reviewed.

- **The scan root** is `--scan-root` when given, else the repository's top level, for every git source: a range, the local or staged changes, or a path review. A job that checks the repository out to the runner's default directory and scans there has the top level as its root, so it needs no flag. A scan in a container names its own: `--scan-root /src`. It is never opened or resolved through the file system: it is compared as a string with the top level git prints (`git rev-parse --show-toplevel`), so name it as git does, a symbolic link not followed.
- **A monorepo package's place.** A package's scan writes paths relative to the package, such as `src/a.ts`. Named `--scan-root <top>/packages/app`, with `<top>` the repository's top level, the root's place below it is `packages/app/`, so the path becomes `packages/app/src/a.ts`, the file the diff names. A scan root outside the top level, a container's `/src`, stands for the top level itself and adds no place.
- **A diff file or standard input has no top level.** A review of one has no repository to ask, so an absolute path is placed only under a `--scan-root`, and a relative path is read as the repository's own. Without a root, an absolute path is unmapped.
- **Windows paths.** A backslash is a character like any other, since a file name may hold one, and a Windows drive path is no absolute path quorum reads, so an absolute path a Windows scan wrote is unmapped or names no file of the change, and a `--scan-root` of `C:/src` is refused. Convert the paths to relative paths with forward slashes in the scan job. The git sources run on Linux and macOS, and a diff piped in on Windows has no top level.
- **An unmapped path makes the report partial**, since an issue that quorum could not place may sit on a changed file: an absolute path outside the scan root is how a whole report once made every file look unreported.

## The commit

A scan reports the files it read, so a report made at another commit says nothing of this change. When a report states the commit it was made at, quorum checks it:

- **The reviewed commit** is a range's head, a path review's commit and HEAD for the local and staged changes. A commit a report states as a hexadecimal prefix of 7 to 64 digits, in any case, matches it when the reviewed commit starts with it.
- **A report that names another commit is refused whole**, as unreadable with the reason `another-commit`: no issue of it is used. So is one that states a revision that is no commit id, such as a branch name, since it cannot be checked. A report that states none is not checked, and one a stale scan wrote can pass: the scan job must scan the commit the review is of.
- **A diff file or standard input names no commit**, so its reports are not checked, and `meta.context.reports` records the commit each one states.
- **A local review reads files the working tree may have changed since HEAD.** A scan of `--local` or `--staged` must therefore be run on the working tree as it is reviewed, since no scanner states the state of the working tree and quorum cannot tell a stale scan of it from a fresh one.

## The outcomes and the cap

Each issue of a report ends in exactly one outcome, counted in `meta.context.reports`, in this order:

| Outcome | When |
| --- | --- |
| skipped | The reader counted it as no open issue: a SARIF result of another kind, a SonarQube issue that is not open |
| unreadable | The reader could not read the entry: a line that is no whole number, no message or no rule id |
| held | Its message, rule text, rule id or scanner name reads as a credential: no model is sent it, whatever else it holds |
| unmapped | Its path is one quorum cannot place: [The paths](#the-paths) |
| left out | Its file is one the review left out: excluded, held as a secret, binary or a submodule |
| not in the change | It names no file of the diff, or none |
| used | A candidate the panel judges: its line is within two rows of a row the change adds or removes, or it has no usable line (below) |
| on an unchanged line | Any other line of a file of the diff: a pre-existing issue elsewhere in a touched file is counted and not reviewed |
| capped | A candidate past the profile's `maxScannerIssues` |

- **What the reader did not read** ends in no outcome: a result past a run's 25000, a result of a run past the log's 20th, an issue of a response past its 25000. The record counts it in `notRead`, beside the outcomes, and `listed`, what the file held, is the nine outcomes and `notRead` added, so `1 of 25030 issues used` says what the file held, and the gap says how many of them were not read: `30 of its 25030 issues were not read`.
- **A file-level issue** is one with no usable line: no region, no start line, a start line of 0, or a Trivy result at line 1, since Trivy writes line 1 for any result it cannot place, so a real line 1 cannot be told from the fallback. When the change touches its file, it goes on the file's first changed line, and its verdict says `file-level`. Any other scanner's line 1 is a line.
- **Near the change** is the rule a profile that reviews changed lines only applies to a finding: a line within two rows of a row the change adds or removes. A change can make an unchanged line wrong, a check removed above it for one, so the lines around it count.
- **A candidate** is a finding detail checked as any is: its file is the diff's path, its category the rule's id, its summary the scanner's message, cleaned and capped at 500 characters, and its evidence the diff's lines, read by the harness. The report's snippet is only the quote the evidence is compared with. It joins the finder's findings before dedup, the finder's first, so a scanner's issue and a finder's finding on one line are two verdicts when their categories differ. A profile whose research failed or asked nothing still judges its candidates, since the panel does not depend on research.
- **The cap** is `maxScannerIssues`, 50 by default, a cap of its own beside `findingsCap`: a candidate is counted in this one and a finder's finding in that one, so a flood of issues never pushes a finding out and the reverse. A panel judges at most the sum of the two caps. The candidates are ordered by level, `error`, `warning`, `note`, `none` and then `unknown`, then in the order of the reports and each report's own order, and those past the cap are `capped`: they are never reviewed, and the profile records an `issues-capped` gap. Raise it in the config: [Configuration](./20-configuration.md#keys).
- **What a person reads.** The log says each report's counts in one line, `context: report 1 sarif "Trivy" for security: 1 of 14 issues used (1 file-level); 13 not in the change`, each outcome that is not 0 after the first, and `; read in part` when it was, and the text report and the Markdown summary list the same words. A report that could not be read says so: `context: report 1 sarif for security: could not be read`. The summary on stderr ends with counts the reports read, read in part and unreadable (`reports: 1 read, 1 could not be read`), and the result records each, with its hash and its counts: [A scanner report's record](../95-reference/20-json-result.md#a-scanner-reports-record).

## What the panel sees

A candidate is voted on as a finding is, blind, one vote for each lens, and its confidence is computed from the votes. Its voters, and no other, read two blocks of its own, each fenced as data and described in the data notice as what it is:

- **Its claim**, in place of the finder's: `Finding: <file>:<line> [<rule id>]`, `Reported by: <scanner>, rule <rule id>` and `Claim by the scanner (unverified): <message>`, each name's hidden characters shown as `<U+XXXX>`. The notice calls it the scanner's claim, unverified, that may be wrong or planted.
- **Its rule's text**, cleaned and capped at 2048 characters, the scanner's own description of the rule it reports, as its report gives it.

A candidate's level and whether its report marks it suppressed are not sent: no study measured them as a voter's input, and a suppression is the change's own word. No report text reaches the finder or any system message. The finder reviews the diff as it always did, and a model's finding takes no scanner text.

## Dismissed issues and the public view

A scanner's issue the panel dismisses stays in the result with its votes, in `discarded`, as any discarded finding does, so a real issue a panel cleared is in front of the reviewer who reads the result. The public view lists these dismissed issues, with their public votes, and still withholds and only counts the finder's: the finder's discarded findings tell an attacker what the finder saw and the panel cleared, where a scanner's issue is no such secret, since the scan ran on the attacker's own code and its report is theirs to read. What remains is the per-lens `keep` of a dismissed issue, which shows which refutation angle a planted text swayed, as a kept finding's already does: [The public view](../30-security/30-output-handling.md#the-public-view). The text report and the Markdown summary list them, and SARIF counts them in a notification: [Reports for GitHub](./80-reports.md#the-summary).

## The limits and the gaps

Every limit is said as `N of M used` and never read as complete. A report that is not read whole is a gap of each profile it feeds, in fixed words that name the report by its place and never by a file name:

| Reason | One for | When | The detail |
| --- | --- | --- | --- |
| `report-unreadable` | A report | Nothing of it was used | `report <n> (<format>) could not be read: <why>` |
| `report-partial` | A report | Part of it was not read or not placed | `report <n> (<format>) was read in part: <why>`, joined by `; ` |
| `issues-capped` | A profile | Candidates fell past `maxScannerIssues` | `<k> of <m> scanner issues on the change were not reviewed (the cap is <c>)` |

- **Unreadable**, by cause: `the file does not exist` (`missing`), `the file cannot be read` (`cannot-read`), `it is a symbolic link or no regular file, which quorum does not read` (`not-a-file`), `it is over 16 MiB` (`too-large`), `it is no SARIF 2.1.0 log` or `it is no saved api/issues/search response` (`not-the-format`, which a file that is no UTF-8 text is too), `no run holds a result list, so its scanner failed` (`no-results`) and `it states the commit <short>, and the review is of <short>` (`another-commit`).
- **In part**, by cause: `it holds <h> of the <t> issues its search found` (`truncated`), `<r> of its <t> results were not read` (`too-many`; `issues` for a SonarQube response, and for the runs a log holds past its 20th `<q> of its <n> runs`, joined to the results by `and`), `a run says its scanner failed, or holds no result list` (`scanner-failed`), `<u> of its <l> entries could not be read`, `<m> issue(s) name a path quorum could not place in the repository` and `<k> issue(s) hold what reads as a credential, so no model was sent them`.
- **No flag lifts one.** `--allow-incomplete` lifts a gap only when every failed vote behind it failed in passing, and the change's own scan job can cause each of these: a change can crash its scanner, pad a report past its size or plant an entry that cannot be read. A gating profile's gap exits `4` and an advisory profile's is reported and exits nothing: [Exit codes](./10-cli.md#exit-codes). The summary says the fix: `check the report's path, and that the scan job wrote it for the reviewed commit` for an unreadable report, `see the gap in the report` for a partial one and `raise maxScannerIssues` for a cap.
- **Not a gap:** an issue on a file the change does not touch, on a line it does not touch, on a file the review already lists as left out with its own gap, or one its scanner or a person closed. Each is counted and none is read as a failure.
- **The limit of the scan itself.** The scan job is the change's: it can leave an issue out of its report, and a dismissal cannot restore an issue that is not there, and a report that states no commit can be stale. A candidate judged by the panel is as strong as the panel; the report only says where a scanner looked: [Threat model](../30-security/10-threat-model.md).

## Next

[Threat model](../30-security/10-threat-model.md) — the attacker, the assets, the residual risk stated plainly, the controls in place today, and what the panel's independence is worth.
