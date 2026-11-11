# The JSON result

What a review returns: the JSON the CLI prints on stdout, and the object `review` resolves with. It holds three lists of verdicts and `meta`. Every field below is listed in the order it is written, which is the order of its keys in the JSON. The CLI writes it with `inertJson`: a hidden character in a string is written as a `\uXXXX` escape, which a JSON parser reads back as the character.

## The top level

| Field | Type | Holds |
| --- | --- | --- |
| `kept` | verdict[] | The findings whose kept votes reach a confidence level |
| `discarded` | verdict[] | The findings that reached none, and whose failed votes could not have changed that |
| `unreviewed` | verdict[] | The findings that reached none while their failed votes could have lifted them to a level: neither kept nor cleared |
| `meta` | object | What the review records about itself |

Each list keeps the order in which the finder listed its findings, the first profile's verdicts first, in the order of the review's profiles. [Failed votes](../20-using/50-lenses-and-policy.md#failed-votes) says which list a verdict lands in.

## A verdict

| Field | Type | Holds |
| --- | --- | --- |
| `id` | string | Names the finding, stable across runs: the first 12 hexadecimal characters of the SHA-256 of the JSON array `[profile, file, line, category]` |
| `profile` | string | The id of the profile that found it |
| `file` | string | The diff's own path for the cited file. For a diff without per-file headers, the finder's name for it, cleaned and capped at 260 characters |
| `line` | number | The cited line of the new file, inside a hunk of the diff |
| `category` | string | The finder's category, cleaned and capped at 80 characters; the security profile asks for a CWE |
| `summary` | string | The finder's claim, cleaned and capped at 500 characters |
| `evidence` | string | The diff's lines around `line`, up to two on each side within its hunk, each with its `+`, `-` or space marker, read from the diff by the harness and capped at 2,000 characters |
| `quoteMatched` | boolean | Whether the code the finder quoted appears in the evidence, once each evidence line's marker is removed and whitespace is collapsed on both sides; a quote that keeps its own `+` or `-` does not match. A measure of hallucinated citations |
| `keptVotes` | number | The votes that kept the finding |
| `totalVotes` | number | The votes asked for, one per lens, failed ones included |
| `confidence` | `"high"`, `"medium"` or `"low"` | The highest level the kept votes reach. A discarded or unreviewed verdict reached none: the JSON leaves the key out, and in the object `review` resolves with, the key is there with the value `undefined` |
| `votes` | vote[] | One per lens, in the profile's lens order |

Cleaned means stripped of control, format and other invisible characters, with whitespace collapsed to single spaces. A value cut at its cap ends with `…`. A trailing carriage return is removed from each evidence line.

### A vote

| Field | Type | Holds |
| --- | --- | --- |
| `angle` | string | The id of the lens the vote was cast from |
| `vote` | object or `null` | `keep`, a boolean, then `reasoning`, a string; `null` when the vote failed |
| `error` | string or `null` | `null`, or why the vote failed: the message of the error, such as `default: HTTP 503: "model is loading"`, or the text of anything else the provider threw |

A failed vote counts as a reject.

## meta

| Field | Type | Holds |
| --- | --- | --- |
| `version` | string | The version of quorum that ran the review, from `package.json` |
| `startedAt` | string | When the review started, in ISO 8601 and UTC: `2026-11-08T02:04:20.361Z` |
| `durationMs` | number | How long it took, in whole milliseconds |
| `profiles` | object | One entry per profile, keyed by profile id, in the order of the review's profiles |
| `usage` | object | Only when at least one call reported valid counts: `inputTokens` and `outputTokens` summed over those calls, then `costUsd`, summed over the calls that reported one, when any did |
| `incomplete` | entry[] | The gaps of the review, profile by profile, each profile's research gaps before its panel's. A review is complete when this list and `unreviewed` are both empty |
| `flags` | flag[] | The advisory flags read from the diff, file by file in its order: [A flag](#a-flag). Empty when nothing was flagged, a blank diff included |

A usage count is valid when it is a finite number of at least 0. `meta.usage` and each `invalidFindings` are counted from the review's own events, so `meta` and the events cannot disagree.

### Per profile

| Field | Type | Holds |
| --- | --- | --- |
| `providers` | object | `research`, the `{ id, model }` of the research provider, then `lenses`, the `{ id, model }` of each lens's provider, keyed by lens id |
| `policy` | object | `high`, `medium` and `low`: the kept votes each level needed, `null` for a level that is off |
| `gating` | boolean | Whether its kept `high` findings set exit code `1`, and its gaps exit code `4` |
| `invalidFindings` | number | How many findings it dropped for citing code outside the diff |

### An incomplete entry

| Field | Type | Holds |
| --- | --- | --- |
| `profile` | string | The profile whose run has the gap |
| `reason` | string | One of the five [incomplete reasons](#incomplete-reasons) |
| `file` | string | The file of the finding the gap is about, when it is about one finding the harness could read: `vote-failed` has it, and so does a vote's `request-too-large` |
| `detail` | string | What is missing, in words |

### A flag

| Field | Type | Holds |
| --- | --- | --- |
| `code` | `"hidden-characters"` or `"ai-addressed-text"` | What the flag is about |
| `file` | string | The diff's own path of the file the flag is about. The key is absent for a diff without per-file headers |
| `line` | number | The first added line, in the new file, that the flag is about. The key is absent for a flag about the file name |
| `detail` | string | What was found, in words the code wrote, never text of the diff |

A file raises at most one flag for each row of this table, in this order:

| `code` | About | `line` | `detail`, for instance |
| --- | --- | --- | --- |
| `hidden-characters` | The file name | Absent | `the file name holds U+202E` |
| `hidden-characters` | The added lines | The first added line that holds one | `U+202E, U+200B on 3 added line(s)` |
| `ai-addressed-text` | The added lines | The first added line that matches | `a chat-template token, a tool-call tag on 2 added line(s)` |

A detail names at most eight code points or patterns, then `and N more`. [Advisory flags](../30-security/30-output-handling.md#advisory-flags) says what each code looks for. A flag never changes a verdict, a gap or the exit code.

## Incomplete reasons

| Reason | Recorded when | `detail` |
| --- | --- | --- |
| `finding-unreadable` | A finding among the first `maxFindings` the research reply lists does not match the reply schema, names an empty file or a line below 1, or holds an object or array under a key the schema does not name | `findings[<index>]: ` and what is wrong: `findings[4]: quote: Invalid input: expected string, received undefined`, `findings[2]: file must be non-empty and line at least 1`, or `findings[3]: carries a nested object or array outside the reply schema` |
| `findings-capped` | The reply lists more findings than `maxFindings`, 50 by default: the rest are counted, not read | `12 of 62 reported findings were not reviewed (the cap is 50)` |
| `research-unusable` | The reply lists findings, and not one of those read is usable: each was unreadable or cited code outside the diff | `2 finding(s) reported, none usable`, or, when the cap applied, `62 finding(s) reported, the first 50 read, none usable` |
| `vote-failed` | A kept finding's failed votes, had they been keeps, would have raised it to a higher level | `"src/a.js":12 is kept at medium, but 1 failed vote(s) could have made it high`, the file written as a JSON string |
| `request-too-large` | A request may not fit its provider's context, so it was not sent: the profile's research request, which leaves the profile with no finding, or the vote requests of a finding, each a failed vote | `the research request was not sent: <the provider's message>`, or `"src/a.js":12: 2 of 3 vote requests were not sent: <the first provider's message>`, the file written as a JSON string |

Each gap makes the review incomplete, as an unreviewed finding does: the CLI exits `4` for a gap of a gating profile, unless a gating profile kept a `high` finding. `--allow-incomplete` lifts every gap but this one for a gating profile: a `request-too-large` gap exits `4` whatever the flags, since a pull request can cause it by padding the diff.

## An example

A review of a diff that touches three files, run on the one provider, named `default`, that the CLI builds from `QUORUM_RESEARCH_MODEL` and `QUORUM_RESEARCH_CONTEXT_TOKENS` alone, answering for the finder and every voter; its replies are fake. The finder listed five findings: one cited `src/auth.js`, which the diff does not touch, and was dropped (`invalidFindings` is 1); one had no `quote` and could not be read (the `finding-unreadable` gap). The three others went to the panel. The SQL injection was kept by all three lenses: `high`. The path traversal was kept by one: `discarded`. The session token got one keep, one reject and a vote whose endpoint answered 503: one more keep would have reached `medium`, so it is `unreviewed`. The CLI would exit `1` for this result.

```json
{
  "kept": [
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
  ],
  "discarded": [
    {
      "id": "31c4f568c9be",
      "profile": "security",
      "file": "src/upload.js",
      "line": 5,
      "category": "CWE-22",
      "summary": "A file name from the request is joined into the upload path.",
      "evidence": "   const name = path.basename(file.name)\n+  fs.writeFileSync(path.join(UPLOADS, name), file.data)\n }",
      "quoteMatched": true,
      "keptVotes": 1,
      "totalVotes": 3,
      "votes": [
        {
          "angle": "reachability",
          "vote": {
            "keep": true,
            "reasoning": "file.name comes from the multipart request."
          },
          "error": null
        },
        {
          "angle": "impact",
          "vote": {
            "keep": false,
            "reasoning": "The name has no directory part left, so the write stays inside UPLOADS."
          },
          "error": null
        },
        {
          "angle": "defenses",
          "vote": {
            "keep": false,
            "reasoning": "path.basename on the line above already removes any traversal."
          },
          "error": null
        }
      ]
    }
  ],
  "unreviewed": [
    {
      "id": "ea9ff1bf2f29",
      "profile": "security",
      "file": "src/session.js",
      "line": 20,
      "category": "CWE-338",
      "summary": "Session tokens come from Math.random, which is not a cryptographic generator.",
      "evidence": "-  return crypto.randomBytes(32).toString('hex')\n+  return Math.random().toString(36).slice(2)\n }",
      "quoteMatched": true,
      "keptVotes": 1,
      "totalVotes": 3,
      "votes": [
        {
          "angle": "reachability",
          "vote": {
            "keep": true,
            "reasoning": "newToken is called on every login."
          },
          "error": null
        },
        {
          "angle": "impact",
          "vote": null,
          "error": "default: HTTP 503: \"model is loading\""
        },
        {
          "angle": "defenses",
          "vote": {
            "keep": false,
            "reasoning": "Each token is bound to the client address and expires after five minutes."
          },
          "error": null
        }
      ]
    }
  ],
  "meta": {
    "version": "0.1.0",
    "startedAt": "2026-11-08T02:04:20.361Z",
    "durationMs": 12,
    "profiles": {
      "security": {
        "providers": {
          "research": {
            "id": "default",
            "model": "qwen3.6:27b"
          },
          "lenses": {
            "reachability": {
              "id": "default",
              "model": "qwen3.6:27b"
            },
            "impact": {
              "id": "default",
              "model": "qwen3.6:27b"
            },
            "defenses": {
              "id": "default",
              "model": "qwen3.6:27b"
            }
          }
        },
        "policy": {
          "high": 3,
          "medium": 2,
          "low": null
        },
        "gating": true,
        "invalidFindings": 1
      }
    },
    "usage": {
      "inputTokens": 9080,
      "outputTokens": 1180
    },
    "incomplete": [
      {
        "profile": "security",
        "reason": "finding-unreadable",
        "detail": "findings[4]: quote: Invalid input: expected string, received undefined"
      }
    ],
    "flags": []
  }
}
```

## Related

- [The CLI](../20-using/10-cli.md#exit-codes) — the exit code each result leads to.
- [Lenses and policy](../20-using/50-lenses-and-policy.md) — how kept votes become a confidence, and when a finding is unreviewed.
- [Library API](./30-library-api.md#events) — the events a review sends while it builds this result.
- [Output handling](../30-security/30-output-handling.md#text-an-attacker-can-influence) — which fields hold text an attacker can influence, and how to render them.
