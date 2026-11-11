# Quick start

Five steps: point quorum at a model, review a diff, then read the three things it gives back, which are progress on stderr, the result on stdout and an exit code. You need the `quorum` binary from [Installation](./10-installation.md) and a model that an endpoint serves; the commands below assume Ollama on this machine.

## 1. Point it at a model

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_RESEARCH_CONTEXT_TOKENS=32768
```

`QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS` are the two settings quorum requires: the model, as your endpoint names it, and the model's context window in tokens, which quorum checks every request against ([The context size](../20-using/20-configuration.md#the-context-size)). Without the context size the run exits `2` with a message that names the variable, a blank diff included. With nothing else set, the finder and the panel both use that model through Ollama's native API at `http://localhost:11434`, the address Ollama listens on, on `127.0.0.1`, by default, and send no key. That API takes `num_ctx`, `truncate: false` and `shift: false`, so the server is told the context size and refuses an overflow, where Ollama's OpenAI-compatible `/v1` would cut the prompt in silence. Refusing needs Ollama 0.12.6 or later: an older server ignores `truncate` and `shift` and cuts the prompt in silence too ([`ollama`](../20-using/30-providers.md#ollama)). Keep the number at most what `ollama show <model>` reports for the model: Ollama clamps a larger `num_ctx` to it, and the `CONTEXT` column of `ollama ps` shows the context a running model loaded. A hosted API, or a panel on another model than the finder, takes a few more `QUORUM_*` variables or a config file: [Configuration](../20-using/20-configuration.md).

## 2. Review a diff

Give it a diff file, and keep its exit status for step 5:

```bash
quorum ./my.diff > result.json
code=$?
```

Or pipe what your branch changes since it left `origin/main`, which is what a pull request would show:

```bash
git diff origin/main...HEAD | quorum > result.json
code=$?
```

`code=$?` must come right after the `quorum` command, since every later command sets `$?` again. Quorum reads stdin when no file is given and stdin is not a terminal. The review makes one call to the finder, then one call per lens for each finding that reaches the panel, so three per finding with the security profile, and never more than four at once.

## 3. Read the progress

Progress goes to stderr while the review runs. For a diff that touches three files, with a finder that proposed five findings, it prints:

```text
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
invalid finding dropped: src/auth.js:3 is not in the diff
incomplete: finding-unreadable (findings[4]: quote: Invalid input: expected string, received undefined)
3 candidate(s) after dedup
1 kept, 1 discarded, 1 unreviewed by panel
```

- `Research (…)...` and `Panel will use …` name the model of each role and the origin of its endpoint: the scheme, host and port, never a path, a key or credentials.
- `invalid finding dropped:` is a finding that cites code outside the diff, dropped with its reason. Here the finder named a file the diff does not touch.
- `incomplete:` is a gap in the review, with its reason and its detail, as the result records it. Here the finder reported a finding without its `quote` field, which the harness could not read.
- `3 candidate(s) after dedup` counts the findings the panel judges.
- The last line says where they landed.

An empty diff prints `empty diff: nothing to review` after the two banner lines, then `0 kept, 0 discarded, 0 unreviewed by panel`, without calling a model.

## 4. Read the result

stdout holds only the JSON result: `kept`, `discarded` and `unreviewed`, three lists of verdicts, and `meta`, what the review records about itself. The finding that run kept:

```bash
jq '.kept[0]' result.json
```

```json
{
  "id": "6f4bcc15476f",
  "profile": "security",
  "file": "src/users.js",
  "line": 12,
  "category": "CWE-89",
  "summary": "The id from the query string is interpolated into the SQL text.",
  "evidence": "-  return db.query('SELECT * FROM users WHERE id = $1', [id])\n+  const sql = `SELECT * FROM users WHERE id = ${id}`\n+  return db.query(sql)\n }",
  "quoteMatched": true,
  "keptVotes": 3,
  "totalVotes": 3,
  "confidence": "high",
  "votes": [
    {
      "angle": "reachability",
      "vote": {
        "keep": true,
        "reasoning": "request.query.id reaches the query text unchanged on every call of findUser."
      },
      "error": null
    },
    {
      "angle": "impact",
      "vote": {
        "keep": true,
        "reasoning": "Any caller can read or change every row of the users table."
      },
      "error": null
    },
    {
      "angle": "defenses",
      "vote": {
        "keep": true,
        "reasoning": "No validation or parameter binding is left on this path."
      },
      "error": null
    }
  ]
}
```

- `confidence` is `high` because all three lenses kept the finding: `keptVotes` is 3 of `totalVotes` 3.
- `evidence` is the diff's own lines around line 12, read by the harness, and `quoteMatched` says that the code the finder quoted appears in them.
- `votes` holds each lens's vote with its reasoning, in the profile's lens order. A failed vote would read `"vote": null` with its `error`.

The other two findings of that run went elsewhere. The path traversal in `src/upload.js` was kept by one lens of three, which reaches no level: it is in `discarded`. The session token in `src/session.js` got one keep, one reject and one failed vote; had the failed vote been a keep, it would have reached `medium`, so the finding is neither kept nor cleared: it is in `unreviewed`. And `meta.incomplete` holds the finding the harness could not read:

```bash
jq '.meta.incomplete' result.json
```

```json
[
  {
    "profile": "security",
    "reason": "finding-unreadable",
    "detail": "findings[4]: quote: Invalid input: expected string, received undefined"
  }
]
```

[The JSON result](../95-reference/20-json-result.md) has every field, and the whole result of this run.

## 5. Read the exit code

```bash
echo $code
```

```text
1
```

| Code | Means | In CI |
| --- | --- | --- |
| `0` | The review is complete, and no gating profile kept a `high` finding | Pass |
| `1` | A gating profile kept a `high` finding; the security profile gates | Fail: read the kept findings |
| `2` | A usage or configuration error: nothing was reviewed | Fail: fix the command or the variables |
| `3` | The research call failed: nothing was reviewed | Fail: fix the endpoint, or run again |
| `4` | The review is incomplete, and no gating profile kept a `high` finding | Fail: read the unreviewed findings and `meta.incomplete`; run again only for a failed vote |
| `130` | The run was interrupted by SIGINT or SIGTERM: nothing was reviewed | Fail: the job was cancelled, run it again |

This run exits `1`: it kept a `high` finding, and `1` wins over the `4` that its unreviewed finding and its unreadable one would otherwise give.

Running again does not fix a `request-too-large` gap, which the same diff on the same model repeats. A model with a larger window does, or a smaller diff. With the 32768 above, a research request leaves about 14.7 KB (14,757 bytes) of diff, so a longer branch needs one or the other: [What it counts, and what it costs](../20-using/20-configuration.md#what-it-counts-and-what-it-costs).

## Where to go next

| If you want to… | Read |
| --- | --- |
| Know every exit code's causes, and gate a CI job on them | [The CLI](../20-using/10-cli.md) |
| Put the panel on another model, or use a hosted API | [Configuration](../20-using/20-configuration.md) |
| Find your model's context size, and know what the size guard costs and how to raise the limit | [The context size](../20-using/20-configuration.md#the-context-size) |
| Read every field of the result | [The JSON result](../95-reference/20-json-result.md) |
| Know what `high` and `medium` mean, and when a finding is unreviewed | [Lenses and policy](../20-using/50-lenses-and-policy.md) |
| Review for something other than security | [Profiles](../20-using/40-profiles.md) |
| Call quorum from a TypeScript program | [Library API](../95-reference/30-library-api.md) |
| Know what it protects against before you run it on someone else's pull request | [Threat model](../30-security/10-threat-model.md) |
| See every track laid out | [Start here](../01-readme.md) |

## Next

[The CLI](../20-using/10-cli.md) — the invocation, stdout and stderr, every exit code and its causes, and what each should do to a CI job.
