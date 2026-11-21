# The MCP server

`quorum mcp` serves one tool, `review`, over MCP on standard input and output, to one client such as Claude Code, so an agent can have a change reviewed by quorum's finder and panel and read the result. A call names a source, never a diff: `local`, `staged`, a range of commits, or paths at a commit. Quorum reads the repository itself, so the agent never chooses the code that is reviewed, and what the operator allows, the gates, is fixed when the server starts. This page is how to start it, what the tool takes, what it answers and what it refuses.

## Starting it

A client starts the server, as it starts any MCP server. For Claude Code, in your own settings:

```bash
claude mcp add --scope user quorum -- quorum mcp --config "$HOME/.config/quorum/mcp.yaml"
```

- **The binary, or a global npm install with the SDK beside it.** A release binary and the container image hold the MCP SDK. With the npm package, install quorum globally, then the SDK the package names as an optional peer beside it, at the one version `quorum mcp` runs: `npm install -g @modelcontextprotocol/server@2.4.0`. Another version is refused before it is loaded, with this command in the message, and exit `2`: [From npm](../10-getting-started/10-installation.md#from-npm). Run `quorum mcp` from one of these and never from a project's `node_modules`: the agent can write in the project, so it could change the code the next launch runs, with your keys and your gates.
- **The config lies outside the project.** `--config`, or `QUORUM_CONFIG`, which must be an absolute path, names the config file, which is read once, at the start, and its profiles, providers and `send` list are the server's for as long as it runs. Quorum refuses it, with exit `2`, when the path as named lies inside the root, through a link or not, and when its real path does or it is a link in the root that leads out, and it does so before the file is read: reading a config can run it, when it is code, with your keys in the environment. The reason is that the agent can write in the project, so a config there could set `send`, a provider's endpoint or a prompt for the next launch, and a link there could be pointed at a file of its own.
- **Never from a repository's `.mcp.json`.** The command and the flags in it are the repository's, and `claude -p`, the Agent SDK and cloud sessions load a project's servers without asking, so a repository could start `quorum mcp` with the gates lifted. Add it to your own settings, as above.
- **The root** is the directory the server serves: `CLAUDE_PROJECT_DIR`, which Claude Code sets and which must be an absolute path to a directory, else the directory the server was launched in. A call's paths stay inside it, and its git sources review the repository the root is in, which may be a larger one: a Claude Code session opened in `packages/web` has paths of `packages/web`, and `local`, `staged` and a range review the whole repository, as `quorum` does from that directory.
- **The log is stderr.** Standard output carries the protocol's messages and nothing else. The banner, the progress lines of each review, the config's warnings and each failure's reason are on stderr, which a client keeps in its own log. A terminal on standard input is refused: the server reads a client's messages, and a person at a prompt would see nothing.
- **The profiles** are the config's, or those `--profile` names, as the review command runs them.

```text
Usage: quorum mcp [options]

Serve quorum's review tool over MCP, on standard input and output, to one client such as Claude Code.

Options:
  -c, --config <path>             Read this config file, which must lie outside the project; over QUORUM_CONFIG
  -p, --profile <id>              Serve only this profile; repeat it to serve several
      --large                     Run a review of paths that may pass the token cap, reviewing what the cap allows
      --trust-repo-config         Review local or staged changes where the repository's own config names a filter program
      --send <path>               Send a file held as a secret to the models all the same; repeat it to send several
      --max-session-tokens <n>    Spend at most this many tokens over the server's life; four times maxReviewTokens by default
      --code-fields-only          Leave each finding's category and summary out of what the agent receives
      --require-approval          Have Claude Code ask before every call
  -h, --help                      Print this help and exit
```

## The tool

The tool is `review`. Its description, its schema and its annotations are the same for every config and every project, and a call takes these arguments:

| Argument | Meaning |
| --- | --- |
| `source` | Required: `local` (what `git add -A` would commit), `staged`, `range` or `paths` |
| `range` | With `range` alone: the commits to review, written `<base>...<head>` |
| `paths` | With `paths` alone: at most 100 paths, each relative to the root and inside it, a file, a directory or `.` for all of it |
| `at` | With `paths` alone: the commit to read, `HEAD` by default |
| `profiles` | The profiles to run, among the server's own, none twice; all of them by default |

An argument of another name is refused, `large`, `send` and `diff` included. The sources are the CLI's: [Sources](./15-sources.md).

- **`profiles` narrows.** The server holds the config it read at the start, resolved again for the profiles a call names, and reads no file again.
- **One review at a time.** A call made while a review runs is answered at once that a review is running, and so is one made right after a call was cancelled, until the cancelled review has stopped: the agent waits, then calls again.
- **Progress** goes to a call that sent a progress token. The first notification says `reading the change`, the next ones count the research parts done, `research: 2 parts done`, and the findings the panel decided, `panel: 3 findings decided`, and a notification is sent at least once a minute while nothing happens, repeating the last message. They are fixed words and counts: no profile, file or model text. A client that sends no token gets none.
- **Cancelling** a call, as Claude Code does when the person presses Escape, aborts the review, which stops its calls to the models; closing the connection does the same. A cancelled call is not answered, and the log says `quorum mcp: a review was cancelled`.
- **A review is long.** One takes minutes. Claude Code moves a tool call to the background after 2 minutes, closes a stdio server that is silent for 30 minutes, which each progress notification resets, and ends a call at about 28 hours; quorum's own deadline for a review is the config's `reviewTimeoutMs`, 30 minutes by default. A client that cuts a call at about 60 seconds is not served by this server.

## Gates

`--large`, `--trust-repo-config` and `--send` are the operator's, set when the server starts, and no argument of a call lifts one:

- `--large` lets a review of paths run that may pass the token cap: the review then reviews what the cap allows and ends incomplete, as it does on the command line. Without it the call is refused.
- `--trust-repo-config` lets `local` and `staged` run where the repository's own config names a filter program, which git then runs: [Trust](./15-sources.md#trust).
- `--send` names files held as secrets that are sent to the models all the same, added to the config's `send` list.

## Limits

The review's token cap and its deadline are the config's, `maxReviewTokens` (2,000,000 by default) and `reviewTimeoutMs`, and the server runs every review under them: to have the agent's reviews bounded tighter, name a config with lower limits. Three flags of the launch bound or narrow what an agent can do beyond that, and no argument of a call changes one:

- **`--max-session-tokens <n>`** bounds the tokens the server spends over its life, four times `maxReviewTokens` by default, so a looping or steered agent stops. It takes one whole number of tokens, from 1, and not below the config's `maxReviewTokens`, since no review could start; either is a usage error, exit `2`.
  - **What counts** is each provider call's spent tokens while a review runs, the usage the call reported or, for a call that reported none, what the review's cap reserved for it. A review that ends without a result, cancelled, aborted or failed, is charged its whole cap, less what its calls already counted, since quorum reports no call once a review is aborted: what its calls in flight spent is never seen, and a review spends no more than its cap, so the cap bounds it whatever was lost.
  - **A call starts only while a review's whole cap fits** in what is left. The server therefore passes the budget by no more than what a provider reports above a call's reservation. Once what is left cannot hold the cap, every call is answered `this server has spent its session's tokens: start it again, or launch it with a larger --max-session-tokens`, and no git command or model is run.
  - The log says `quorum mcp: the session has spent <n> of <total> tokens` after each review, whether it returned, failed or was cancelled. The agent is never told the number.
- **`--code-fields-only`** leaves each finding's `category` and `summary` out of the result, so the agent receives only what quorum's code checked: the file, the line, the confidence, the votes and the fingerprint. It is the strongest control a tool has against a claim that steers the agent, since no model text is left to carry one, and it costs the agent the claim, which it must then read from the code: [What a calling agent receives](../30-security/30-output-handling.md#what-a-calling-agent-receives).
- **`--require-approval`** has Claude Code ask the person before every call of `review`, even in its auto modes, with no "don't ask again". It marks the tool with `anthropic/requiresUserInteraction` in its `_meta`, a hint that a client other than Claude Code may ignore.

## The result

The agent receives the result in a fixed shape, in a structured form and as the same JSON in a text block, within 10,000 bytes each: code-checked fields first, a model's category and summary last, each capped and made inert, and a notice that says they are claims: [What a calling agent receives](../30-security/30-output-handling.md#what-a-calling-agent-receives). A review that read less than the change says so in `gaps`, each with its `reason`, one of [the incomplete reasons](../95-reference/20-json-result.md#incomplete-reasons): a research part that failed (`research-failed`) and the parts and votes a provider found down was never sent (`provider-down`) are among them, and the review's status is `incomplete` for either.

## Errors

A call that gives no result answers with `isError` and one text, which holds nothing of the call, of the repository or of a model:

| Text | When |
| --- | --- |
| `Input validation error: Invalid arguments for tool review: ` and a fixed message for each rule broken, as `takes only source, range, paths, at and profiles` or `paths.1: must be a path of 1 to 4096 characters` | The arguments do not fit the schema |
| `source range takes range, and no other source does`, and `source paths takes paths, and at with them; no other source does` | An argument that does not go with the source |
| `profiles: names a profile this server does not run` and `profiles: names a profile more than once` | `profiles` |
| `paths.<n>: leaves the project` | A path that leaves the root, though it may stay in the repository |
| `a review is running: wait for its result, then call again` | A review runs, or a cancelled one has not stopped |
| `these paths may not finish under the review's token cap: name fewer paths, or launch quorum mcp with --large to review what the cap allows` | `paths` over the token cap, without `--large` |
| `the repository's own config names a filter program, which a review of the working tree runs: review a range, or launch quorum mcp with --trust-repo-config if the repository is yours` | `local` or `staged` in a repository whose config names a filter, without `--trust-repo-config` |
| `quorum could not read the change: the server's log says why` | The source refused: an untracked file quorum will not read, for one, whose name the text leaves out |
| `git failed: the server's log says why` | A git command failed |
| `the review failed: the server's log says why` | The review failed: no research call of any profile answered, since a provider was found down, for one |
| `this server has spent its session's tokens: start it again, or launch it with a larger --max-session-tokens` | What is left of the session budget cannot hold a review's cap: [Limits](#limits) |

A refusal of the range, a path or `at` is the one exception, since those texts repeat nothing of what was written and tell the agent how to correct the call. It is passed through under the argument's name, as `range: its base names no commit of this repository: fetch it first, as actions/checkout does with fetch-depth: 0`, `paths: path 1 names no file tracked at the commit` or `at: names no commit of this repository`. They are the command line's own texts, so they can name its flags, such as `--at` or `--send`, which a call has no way to give, and count paths from 1, where the argument's own errors write `paths.0` for the first.

The reason for each of the others is written to the server's log, on stderr, as the review command writes it. The agent never sees it, since it can quote a file name or a model's text.

## Next

[Claude Code](../90-recipes/20-claude-code.md) — the MCP server, the /quorum-review skill and a hook that reviews a commit before Claude makes it.
