# Quorum :ballot_box:

**Quorum** reviews a diff with several model calls instead of one. A model, the finder, proposes candidate findings, and a panel of voters blind to each other, one per lens, judges each one. Whether a finding is kept, and at what confidence, is computed in code from the split of their votes, never reported by a model. The default profile reviews security through a model you point it at: over four HTTP protocols (Ollama's native API, OpenAI-compatible `/chat/completions`, the Anthropic Messages API and the Gemini API), with presets for the common vendors, local or hosted, or through your installed Claude Code CLI.

Quorum is pre-release (`0.x`): the API may change. It assists a reviewer; it does not replace human review of untrusted changes.

## Install

```bash
npm install -g @tobi-or-not/quorum   # the quorum command, which runs on Node
```

It needs Node `^22.18.0 || >=23.6.0`. Each release also carries a standalone binary for Linux and macOS, on x64 and arm64, that needs neither Node nor Bun:

```bash
gh release download --repo this-is-tobi/quorum --pattern 'quorum-linux-x64' --pattern SHA256SUMS   # or linux-arm64, darwin-x64, darwin-arm64
```

Or run the image, which holds a binary compiled the same way, from the same commit, and runs as a non-root user. Inside it `localhost` is the container, so name the endpoint. On Docker Desktop a server on your machine is `host.docker.internal`; on Linux add `--add-host=host.docker.internal:host-gateway` ([Installation](./docs/10-getting-started/10-installation.md#a-container-image) has the rest):

```bash
docker run --rm -i \
  -e QUORUM_RESEARCH_PROTOCOL=ollama -e QUORUM_RESEARCH_BASE_URL=http://host.docker.internal:11434 \
  -e QUORUM_RESEARCH_MODEL=qwen3.6:27b -e QUORUM_RESEARCH_CONTEXT_TOKENS=32768 \
  ghcr.io/this-is-tobi/quorum:<version> < my.diff > result.json
```

To build it from a clone instead, with Bun 1.3.0 or newer:

```bash
git clone https://github.com/this-is-tobi/quorum.git && cd quorum
bun install
bun run compile                                      # a standalone binary in ./bin/quorum
install -m 0755 ./bin/quorum /usr/local/bin/quorum   # on your $PATH
```

[Installation](./docs/10-getting-started/10-installation.md) has the prerequisites, checking the npm package's provenance, checking a release binary against its checksums and its attestation, running the image with a config file, a key and a model on the host and checking its attestation, why the installed command runs on Node and not on Bun, running it from the clone without the binary, and a check that it works without a model.

## Try it

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b      # a model your local Ollama serves
export QUORUM_RESEARCH_CONTEXT_TOKENS=32768   # its context window, in tokens
quorum ./my.diff > result.json                # review a diff file
git diff origin/main...HEAD | quorum > result.json   # or what your branch changes
```

`QUORUM_RESEARCH_CONTEXT_TOKENS` is the model's context window in tokens, which quorum checks every request against, and without it the run exits `2` with a message that names it. With no provider configured and no base URL, preset or protocol variable, quorum talks to the Ollama on this machine through its native API, `http://localhost:11434`, which Ollama listens on, on `127.0.0.1`, by default. That API takes `num_ctx`, `truncate: false` and `shift: false`, so quorum tells the server the context size and the server refuses an overflow, where Ollama's OpenAI-compatible `/v1` would cut the prompt in silence. Refusing needs Ollama 0.12.6 or later: an older server ignores `truncate` and `shift`. A base URL variable set on its own means an OpenAI-compatible server, as before. Keep the number at most what `ollama show <model>` reports for the model, since Ollama clamps a larger `num_ctx` to it, and read the context a running model loaded in the `CONTEXT` column of `ollama ps`.

To review through your installed Claude Code CLI instead, run `claude` headless and isolated for each request:

```bash
export QUORUM_RESEARCH_PROTOCOL=claude-code     # your installed Claude Code CLI, found on PATH
export QUORUM_RESEARCH_MODEL=sonnet             # an alias, or a model id, that `claude --model` takes
export QUORUM_RESEARCH_CONTEXT_TOKENS=1000000   # its context window, in tokens
quorum ./my.diff > result.json
```

Requires Claude Code 2.1.311 or newer. [`claudeCode`](./docs/20-using/30-providers.md#claudecode) has the command line, the isolation and the auth modes, and [Claude Code](./docs/20-using/20-configuration.md#claude-code) the setup, in CI too.

The JSON result goes to stdout, and the exit code says what to do with it: `0` for a complete review in which no gating profile kept a `high` finding, `1` when one did, complete or not, `2` for a usage or configuration error, `3` when the research call failed, `4` when a gating profile's review is incomplete otherwise, and `130` when the run was interrupted. [Quick start](./docs/10-getting-started/20-quickstart.md) walks one review through, and [Start here](./docs/01-readme.md) lays out four tracks: review a diff, use it from code or review something else, know what it protects against, and measure configurations.

## Documentation

**Website:** <https://this-is-tobi.com/quorum/introduction>

**Table of Contents** *- md sources*:

*Getting started*
- [Installation](./docs/10-getting-started/10-installation.md) *- Node and the npm package, a release binary, the container image, or Bun and the clone, a standalone binary on your `$PATH`, and a check that it works without a model*
- [Quick start](./docs/10-getting-started/20-quickstart.md) *- Point it at a model, review a diff, and read the progress, the result and the exit code*

*Using it*
- [The CLI](./docs/20-using/10-cli.md) *- The invocation, stdout and stderr, every exit code and its causes, and gating a CI job on them*
- [Configuration](./docs/20-using/20-configuration.md) *- The config file and its trust model in CI, the `QUORUM_*` variables and the voter's fallback, the context size each provider states, running Claude Code, the keys, `--print-config`, and the errors a bad setting causes*
- [Providers](./docs/20-using/30-providers.md) *- The provider port, the shipped adapters and their options, Claude Code run isolated as a provider, the presets, `ProviderError`, and writing a provider of your own*
- [Profiles](./docs/20-using/40-profiles.md) *- The security profile, writing your own, several in one review, gating and guidelines*
- [Lenses and policy](./docs/20-using/50-lenses-and-policy.md) *- The panel's questions, the rules that turn kept votes into a confidence, failed votes, and what a level means*
- [Prompts](./docs/20-using/60-prompts.md) *- The layout of every request, the templates and their variables, the notices, and what is not configurable*
- [Benchmarks](./docs/20-using/70-bench.md) *- quorum bench: measure configurations on a suite of real bugs, write a suite, resume a run, and read the report and its intervals*

*Security*
- [Threat model](./docs/30-security/10-threat-model.md) *- The attacker, the assets, the residual risk stated plainly, the controls in place, and what the panel's independence is worth*
- [Output handling](./docs/30-security/30-output-handling.md) *- What the CLI writes and how it is made inert, the advisory flags, and printing a review yourself*

*Recipes*
- [Local models](./docs/90-recipes/10-local-models.md) *- Ollama, vLLM and llama.cpp: the window each gives a request, choosing a model, and what reasoning mode does to a request*

*Reference*
- [Glossary](./docs/95-reference/10-glossary.md) *- The words these pages use in one particular way, and the acronyms they assume*
- [The JSON result](./docs/95-reference/20-json-result.md) *- Every field of a result in the order it is written, the incomplete reasons, and an example*
- [Library API](./docs/95-reference/30-library-api.md) *- `createQuorum`, its ports, the events, abort, the errors and every export*
- [Architecture](./docs/95-reference/40-architecture.md) *- The modules, the dependency rule, the stages of a review, and how the suite runs*

## License

quorum is released under the [Apache License 2.0](./LICENSE).
