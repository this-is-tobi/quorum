# The Action's payload

The document `-f payload` writes, and `quorum-action`, the GitHub Action that reviews a pull request with quorum, posts as it is: the commit the review is about, what it concluded, the summary, and a line comment for each finding that sits on a file of the diff. Every text in it is inert, so the Action composes no text of its own from it. The payload is the public view's: it holds no reasoning, no discarded finding, no model and no usage. [Reports for GitHub](../20-using/80-reports.md#the-payload) says how to write it.

## The document

For the review of a range that kept one finding and left one unreviewed, with the summary shortened:

```json
{
  "version": 1,
  "head": "7b2e4d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "conclusion": "findings",
  "summary": "<!-- quorum:summary:v1 -->\n### quorum review\n\n**exit 1, findings:** a gating profile kept a finding at or above its fail-on level\n\n...",
  "comments": [
    {
      "fingerprint": "a1b2c3d4e5f60718:1",
      "profile": "security",
      "confidence": "high",
      "path": "src/auth/login.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->\n**HIGH** security · `CWE-89` · kept by 3 of 3 lenses\n\n`SQL built from the request's id parameter reaches db.query`"
    },
    {
      "fingerprint": "b1c2d3e4f5061728:1",
      "profile": "security",
      "confidence": "unreviewed",
      "path": "src/session.js",
      "line": 20,
      "side": "RIGHT",
      "body": "<!-- quorum:finding:v1 b1c2d3e4f5061728:1 -->\n**UNREVIEWED** security · `CWE-338` · kept by 1 of 3 lenses, 1 vote failed\n\n`Session tokens come from Math.random, which is not a cryptographic generator.`"
    }
  ],
  "unplaced": 0
}
```

The JSON is written by `inertJson`, so a hidden character in a string is a `\uXXXX` escape that a JSON parser reads back, and no line starts a workflow command. The keys are in this order, and a comment's too.

| Field | Type | Holds |
| --- | --- | --- |
| `version` | `1` | The version of the document's shape: [Versions](#versions) |
| `head` | string or `null` | The commit the changes sit on, 40 or 64 hex characters |
| `conclusion` | `pass`, `findings` or `incomplete` | What the review came to, as the exit code says it |
| `summary` | string | The Markdown summary, at most 60,000 UTF-16 code units |
| `comments` | comment[] | A line comment for each kept or unreviewed finding on a file of the diff |
| `unplaced` | number | How many such findings no line comment holds |

## `head`

`head` is the commit the review's changes sit on, so the Action can check that the pull request still has it before it posts. It depends on the source:

| Source | `head` |
| --- | --- |
| A range, `--range` | The range's head |
| The local or the staged changes | The commit they sit on, or `null` before a first commit |
| A path review, `--path` | The commit it reads |
| A diff file or stdin | `null` |

## `conclusion`

`conclusion` is the `outcome` the review's exit code is made of: `findings` for exit 1, `incomplete` for exit 4, and `pass` for exit 0. A run that `--allow-incomplete` lifted concludes `pass`, as its exit code does, and its summary says so. The conclusion is not the Action's to compute: it reads it here.

## `summary`

The summary is the text `-f markdown` writes, without its last line feed, whole: [The summary](../20-using/80-reports.md#the-summary). Its first line is the marker `<!-- quorum:summary:v1 -->`.

## A comment

| Field | Type | Holds |
| --- | --- | --- |
| `fingerprint` | string | The finding's fingerprint: [fingerprint of a finding](./10-glossary.md) |
| `profile` | string | The profile that found it |
| `confidence` | `high`, `medium`, `low` or `unreviewed` | The level the finding reached |
| `path` | string | The file, as the diff writes it, never empty |
| `line` | number | The line in the new file |
| `side` | `RIGHT` | Always the new file's side |
| `body` | string | The text to post, below |

A finding is a comment when its file is a non-empty path of its profile's coverage, a file of the diff. The comments go by file, then line, as the text report orders its findings.

**The body** is four lines, the third blank, with no line feed after the last:

```markdown
<!-- quorum:finding:v1 a1b2c3d4e5f60718:1 -->
**HIGH** security · `CWE-89` · kept by 3 of 3 lenses

`SQL built from the request's id parameter reaches db.query`
```

- **The marker** is the first line and the only raw HTML in the body. It holds the finding's fingerprint, which a push that moves the finding's line keeps, so the Action finds the comment it posted for a finding by the marker and never posts it twice. It proves nothing without its author: anyone can write the marker.
- **The second line** is the level, the profile, the category and how the lenses voted. The category is in a code span.
- **The claim** is in a code span. No evidence is written: the comment sits on the code.
- **Every line passes `inertLine`,** and the category and the claim, the texts a model wrote, are in code spans, as [Markdown](../30-security/30-output-handling.md#markdown) describes.

**`side` is always `RIGHT`:** the line is a line of the new file. **A line of 0** stays 0: a finding on a file the change empties has no line. GitHub refuses a comment on line 0, so the Action turns it into a comment on the file.

## `unplaced`

`unplaced` counts the kept and unreviewed findings with no line comment, since their file is no file of the diff. A diff with no per-file headers, such as a plain `diff` of two trees, has findings that carry the finder's name for the file, not a path. The summary lists each of them, so none is lost; the count tells the Action how many comments it cannot post.

## What `quorum-action` owns

The payload is data. The Action does the posting, and these are its to do:

- **The marker and its author.** Find the comments to update by their marker, `<!-- quorum:summary:v1 -->` or `<!-- quorum:finding:v1 <fingerprint> -->`, and by the author of the comment too, since anyone can write a marker.
- **Every page read.** Read every page of the pull request's comments and review comments before it decides that a comment is missing.
- **`COMMENT` reviews only.** Post the line comments as one review of the type `COMMENT`, never `APPROVE` or `REQUEST_CHANGES`: the review job's exit code is the gate.
- **Pacing.** Post at the pace GitHub's secondary limits allow, and handle a refusal by waiting, not by posting faster.
- **The fallback.** Turn a comment GitHub refuses on its line, such as one on line 0, or on a line no hunk shows, into a comment on the file, or into the summary's own lines.
- **Deduping by fingerprint.** Post no comment whose fingerprint a comment of the Action already holds, on the pull request's present or an earlier push.
- **The summary, updated in place.** Update the one summary comment, and create it when it is missing.
- **`head` checked.** Compare `head` with the pull request's head before it posts, and post nothing for a review of a commit the pull request has moved past.
- **The number from the event.** Take the pull request's number from the event that started the run, never from the payload.

## Versions

`version` is `1`. A change of the document's shape, a field added, removed or retyped, raises it, so an Action that reads a `version` it does not know refuses the payload instead of misreading it. The texts the Action posts are not part of the shape: the summary and a comment's body can change within a version, and the markers `quorum:summary:v1` and `quorum:finding:v1` carry their own.
