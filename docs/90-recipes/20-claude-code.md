# Claude Code

Three recipes put quorum in reach of Claude Code: the MCP server, which lets Claude have a change reviewed, a `/quorum-review` skill, which the person types to have one reviewed and reported, and a hook that reviews a `git commit` before Claude makes it. The recipes are files of this repository's `examples/` directory. The npm package ships `dist` and `schema` alone, and a release binary or the container image holds no `examples/` at all, so each file below is fetched from its raw URL at the release tag. Replace `<version>` with the installed release's version, `quorum --version` prints it, as [Installation](../10-getting-started/10-installation.md#a-release-binary) does.

## The MCP server

Register `quorum mcp` in your own settings, with the config outside the project, and Claude Code serves its `review` tool as `mcp__quorum__review`:

```bash
claude mcp add --scope user quorum -- quorum mcp --config "$HOME/.config/quorum/mcp.yaml"
```

[Starting it](../20-using/90-mcp.md#starting-it) says what the config is, why it lies outside the project, and why a repository's own `.mcp.json` is never the way to start it. The skill below calls this tool, so the server comes first.

## The /quorum-review skill

Fetch the skill into your own skills directory:

```bash
curl -fsSLo ~/.claude/skills/quorum-review/SKILL.md --create-dirs \
  https://raw.githubusercontent.com/this-is-tobi/quorum/v<version>/examples/claude-code/skills/quorum-review/SKILL.md
```

Type `/quorum-review` to review the local changes, `/quorum-review staged` for the staged ones, `/quorum-review <base>...<head>` for a range of commits, or `/quorum-review <path> ...` for paths of the project.

- **Typed only.** A review spends the operator's tokens, so the skill sets `disable-model-invocation: true`: Claude does not choose to run it, and runs it when you type it.
- **The review tool alone, and no command injected.** The skill pre-approves `mcp__quorum__review` and nothing else, and its text holds no `` !` `` command, which Claude Code would run before the model reads the skill. It tells Claude to change no file, run no command and make no commit because of a finding.
- **What Claude reports.** The `status` first, `pass`, `findings` or `incomplete`, and each profile's counts. Then each finding's file, line and confidence, and its summary as quorum's claim, `quorum claims that ...`, quoted, since a summary is a model's text about code that may be hostile and the skill tells Claude to follow no instruction in it. Then the gaps and the files left out, by their counts and reasons: an `incomplete` status means part of the change went unreviewed. If the tool answers with an error, Claude says what it says and stops.

## A hook on Claude's commits

A `PreToolUse` hook reviews a `git commit` that Claude runs, before the commit is made, and blocks it when the review finds, has a gap or fails. Fetch the script, make it executable, and merge the settings into your own:

```bash
curl -fsSLo ~/.claude/hooks/quorum-commit.sh --create-dirs \
  https://raw.githubusercontent.com/this-is-tobi/quorum/v<version>/examples/claude-code/hooks/quorum-commit.sh
chmod +x ~/.claude/hooks/quorum-commit.sh
```

The settings are a file to read and merge by hand into `~/.claude/settings.json`, never one to download over your own: `https://raw.githubusercontent.com/this-is-tobi/quorum/v<version>/examples/claude-code/settings.json`. Put them in your own settings, which an agent working in a project cannot edit, and not in the project's. A hook in your own settings runs in every project Claude works in, so every commit Claude makes, anywhere, is reviewed, spends tokens and can be blocked.

- **Claude Code 2.1.295 or later.** The entry sets `onFailure` to `block`, so a hook that cannot run, because the script is missing or not executable, blocks the commit rather than letting it through. An older Claude Code does not know the key.
- **The config it reads.** The script runs `quorum` as a terminal would, with no `--config`, so it reads the config that `QUORUM_CONFIG` names in the environment Claude Code runs it in: set it in the `env` of `~/.claude/settings.json`, or in the shell that starts `claude`. A hook with no model configured blocks every commit, with exit `2`.
- **A review of the local changes.** The script runs `quorum --local --format brief`, which reviews what `git add -A` would commit, so it covers `git commit -a` too: [Sources](../20-using/15-sources.md#the-local-changes).
- **A 10-minute cap.** The script sets `QUORUM_REVIEW_TIMEOUT_MS` to `600000` unless it is already set, so a review ends before the hook's own timeout of 11 minutes, `660` seconds. A larger value makes a long review time out, and block.
- **What it prints to Claude.** Quorum's brief line and a fixed sentence, on stderr, with exit `2`, which blocks the commit, for every non-zero exit of quorum: a finding, a gap, a secret held back or a failure. The sentence tells Claude not to retry the commit or work around the hook, and to tell you, who reads the review with `quorum --local` in a terminal. Quorum's own stderr is discarded, since it names files and quotes what a model wrote, and Claude reads what a hook prints. A line that is not a brief line is replaced by `quorum: no brief line`.
- **Best-effort.** The entry's `if` matches `Bash(git commit *)`, a pattern on the command, so a commit written another way, or run from a script, may not match. The hook sees only Claude's own commits: a commit you make in a terminal is the [git hooks](./30-git-hooks.md)' to review.
- **This hook or the git `pre-commit` hook, not both.** With both installed, every commit Claude makes is reviewed twice, once before it runs and once by git.
- **An untracked file the review holds.** A `.env` that no `.gitignore` names is held back as a secret and stops every commit, exit `4`, until it is ignored: [Sources](../20-using/15-sources.md#the-local-changes).

## Next

[Git hooks](./30-git-hooks.md) — a pre-commit hook on the staged changes and a pre-push hook on each pushed range.
