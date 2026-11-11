# Quorum :ballot_box:

**Quorum** reviews a diff with several model calls instead of one. A model, the finder, proposes candidate findings, and a panel of voters blind to each other, one per lens, judges each one. Whether a finding is kept, and at what confidence, is computed in code from the split of their votes, never reported by a model. The default profile reviews security, through any OpenAI-compatible `/chat/completions` endpoint, local or hosted.

Quorum is pre-release (`0.x`): the API may change. It assists a reviewer; it does not replace human review of untrusted changes.

## Install

```bash
git clone https://github.com/this-is-tobi/quorum.git && cd quorum
bun install
bun run compile                                      # a standalone binary in ./bin/quorum
install -m 0755 ./bin/quorum /usr/local/bin/quorum   # on your $PATH
```

It needs Bun 1.3.0 or newer. [Installation](./docs/10-getting-started/10-installation.md) has the prerequisites, running it from the clone without the binary, and a check that it works without a model.

## Try it

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b      # a model your local Ollama serves
export QUORUM_RESEARCH_CONTEXT_TOKENS=32768   # its context window, in tokens
quorum ./my.diff > result.json                # review a diff file
git diff origin/main...HEAD | quorum > result.json   # or what your branch changes
```

`QUORUM_RESEARCH_CONTEXT_TOKENS` is the model's context window in tokens, which quorum checks every request against, and without it the run exits `2` with a message that names it; Ollama sets it from your GPUs' memory (4096, 32768 or 262144) unless `OLLAMA_CONTEXT_LENGTH` says otherwise, so set `OLLAMA_CONTEXT_LENGTH` on the server to at least the same number.

The JSON result goes to stdout, and the exit code says what to do with it: `0` for a complete review in which no gating profile kept a `high` finding, `1` when one did, complete or not, `2` for a usage or configuration error, `3` when the research call failed, `4` when a gating profile's review is incomplete otherwise, and `130` when the run was interrupted. [Quick start](./docs/10-getting-started/20-quickstart.md) walks one review through, and [Start here](./docs/01-readme.md) lays out three tracks: review a diff, use it from code or review something else, and know what it protects against.

## Documentation

**Table of Contents** *- md sources*:

*Getting started*
- [Installation](./docs/10-getting-started/10-installation.md) *- Bun, the clone, a standalone binary on your `$PATH`, and a check that it works without a model*
- [Quick start](./docs/10-getting-started/20-quickstart.md) *- Point it at a model, review a diff, and read the progress, the result and the exit code*

*Using it*
- [The CLI](./docs/20-using/10-cli.md) *- The invocation, stdout and stderr, every exit code and its causes, and gating a CI job on them*
- [Configuration](./docs/20-using/20-configuration.md) *- The config file and its trust model in CI, the `QUORUM_*` variables and the voter's fallback, the context size each provider states, the keys, `--print-config`, and the errors a bad setting causes*
- [Providers](./docs/20-using/30-providers.md) *- The provider port, the shipped adapters and their options, the presets, `ProviderError`, and writing a provider of your own*
- [Profiles](./docs/20-using/40-profiles.md) *- The security profile, writing your own, several in one review, gating and guidelines*
- [Lenses and policy](./docs/20-using/50-lenses-and-policy.md) *- The panel's questions, the rules that turn kept votes into a confidence, failed votes, and what a level means*
- [Prompts](./docs/20-using/60-prompts.md) *- The layout of every request, the templates and their variables, the notices, and what is not configurable*

*Security*
- [Threat model](./docs/30-security/10-threat-model.md) *- The attacker, the assets, the residual risk stated plainly, the controls in place, and what the panel's independence is worth*
- [Output handling](./docs/30-security/30-output-handling.md) *- What the CLI writes and how it is made inert, the advisory flags, and printing a review yourself*

*Reference*
- [Glossary](./docs/95-reference/10-glossary.md) *- The words these pages use in one particular way, and the acronyms they assume*
- [The JSON result](./docs/95-reference/20-json-result.md) *- Every field of a result in the order it is written, the incomplete reasons, and an example*
- [Library API](./docs/95-reference/30-library-api.md) *- `createQuorum`, its ports, the events, abort, the errors and every export*
- [Architecture](./docs/95-reference/40-architecture.md) *- The modules, the dependency rule, the stages of a review, and how the suite runs*
