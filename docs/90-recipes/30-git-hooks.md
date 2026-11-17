# Git hooks

Two git hooks review a change before it leaves your machine: a `pre-commit` hook reviews the staged changes, and a `pre-push` hook reviews each range a push would send. Each stops the commit or the push when the review finds, has a gap or fails, and prints quorum's brief line and a fixed sentence alone: quorum's own stderr names files and quotes what a model wrote, and an agent that runs git reads what a hook prints. The hooks are files of this repository's `examples/` directory. The npm package ships `dist` and `schema` alone, and a release binary or the container image holds no `examples/` at all, so each file is fetched from its raw URL at the release tag. Replace `<version>` with the installed release's version, `quorum --version` prints it, as [Installation](../10-getting-started/10-installation.md#a-release-binary) does.

## pre-commit

Fetch it into the repository's hooks directory and make it executable:

```bash
curl -fsSLo .git/hooks/pre-commit --create-dirs \
  https://raw.githubusercontent.com/this-is-tobi/quorum/v<version>/examples/git-hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

To have every repository of yours use it, fetch it into a directory of your own instead and name that directory with `git config --global core.hooksPath <dir>`: git then reads no hook from a repository's `.git/hooks`. A repository that sets its own `core.hooksPath` in its local config, as husky does, overrides the global one, so these hooks do not run there.

- **The config both hooks read.** A hook runs `quorum` as a terminal would, with no `--config`, so it reads the config that `QUORUM_CONFIG` names in the environment git runs it in: set it there, which a GUI git client's environment may not have. A hook with no model configured stops every commit and every push, with exit `2`, and prints `quorum: no brief line`, since quorum's own stderr never reaches it.
- **What it reviews.** The index git is about to commit, with `quorum --staged --format brief`: [Sources](../20-using/15-sources.md#the-local-changes).
- **What it prints.** When quorum exits non-zero, quorum's brief line, then `quorum stopped the commit (exit <n>): run quorum --staged in a terminal to read the review.`, and the commit stops. A line that is not a brief line is replaced by `quorum: no brief line`.
- **A held secret stops the commit.** A staged file that quorum holds back as a secret is a gap of every profile and exit `4`, so the hook stops the commit: keep the file out of the commit, or name it in the config's `send` if it is meant to be sent: [Files held back as secrets](../20-using/15-sources.md#files-held-back-as-secrets).
- **Not with the Claude Code hook.** With [the hook on Claude's commits](./20-claude-code.md#a-hook-on-claudes-commits) installed too, every commit Claude makes is reviewed twice. Install one of the two for Claude's commits.

## pre-push

Fetch it the same way:

```bash
curl -fsSLo .git/hooks/pre-push --create-dirs \
  https://raw.githubusercontent.com/this-is-tobi/quorum/v<version>/examples/git-hooks/pre-push
chmod +x .git/hooks/pre-push
```

- **What it reviews.** Each ref git reports, with `quorum --range <remote sha>...<local sha> --format brief`. A deleted ref has nothing to review and is skipped.
- **A new branch's base.** A branch the remote does not have yet is reviewed against the remote's default branch, `refs/remotes/<remote>/HEAD`. When git does not know it, the hook stops the push and says so: run `git remote set-head <remote> --auto`, then push again. A push to a URL with a new branch always stops, since `refs/remotes/<url>/HEAD` cannot exist, so push by a remote's name. A first push to an empty remote has no base to review against, so push it with `--no-verify` and let CI review it.
- **A commit the base already holds goes through.** A new branch at the default branch's tip, or a tag on it, adds nothing to review, and `--range` refuses two sides that are one commit, so the hook lets it through with no review.
- **What it prints.** When a review exits non-zero, quorum's brief line, then `quorum stopped the push (exit <n>): review the pushed commits with quorum --range in a terminal.`, and the push stops at the first review that fails. It never prints the remote's name or URL, which can hold a credential.
- **A held secret stops the push**, as it stops a commit: a file of the pushed range that quorum holds back is a gap and exit `4`.
- **A commit id that is not hex.** A commit id git gives that is not hexadecimal is refused with a fixed line, never passed to quorum.

## What a hook cannot do

`git commit --no-verify` and `git push --no-verify` skip both hooks, and a hook is a file on one machine that its owner can edit. So the control is the CI review of [Using it in CI](../20-using/10-cli.md#using-it-in-ci), which a contributor cannot skip: a hook shortens the wait for a finding, and does not replace it.

## Next

[Threat model](../30-security/10-threat-model.md) — the attacker, the assets, the residual risk stated plainly, the controls in place today, and what the panel's independence is worth.
