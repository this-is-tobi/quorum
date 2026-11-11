# Installation

Quorum is a TypeScript program that runs under Bun, from a clone of its repository or as a standalone binary built from that clone. This page installs it, builds the binary, puts it on your `$PATH`, and checks that it works before any model is running.

There is no npm package yet: a TypeScript program that uses quorum as a library imports `src/index.ts` from the clone, as the [Library API](../95-reference/30-library-api.md) shows.

## Prerequisites

- **[Bun](https://bun.sh/) 1.3.0 or newer.** The `engines` field of [`package.json`](../../package.json) asks for it, and it installs the dependencies, runs the CLI and builds the binary.
- **A model endpoint**, for the reviews themselves. With no config file and no preset it is an OpenAI-compatible `/chat/completions` endpoint that serves a model: [Ollama](https://ollama.com/) on your machine, a self-hosted vLLM, TGI or llama.cpp server, or a hosted API. `QUORUM_RESEARCH_PRESET` names a vendor's preset instead, such as `ollama` for Ollama's native protocol, which the quick start uses, and a config file can name an Anthropic, Gemini or Ollama endpoint as well: [Configuration](../20-using/20-configuration.md). The check at the end of this page needs none.
- **[Claude Code](https://code.claude.com/docs), for a `claude-code` provider only.** It is the model's endpoint then: `claude` on your `PATH`, signed in or with a key, run once per request, headless and isolated: [`claudeCode`](../20-using/30-providers.md#claudecode). Quorum requires Claude Code 2.1.311 or newer.

## From source

```bash
git clone https://github.com/this-is-tobi/quorum.git
cd quorum
bun install
```

`bun install` installs quorum's two runtime dependencies, [zod](https://zod.dev), which validates every model reply, and [yaml](https://eemeli.org/yaml/), which parses a YAML config file that `loadConfig` reads, and the development tools.

From the root of the clone, `bun run start` runs the CLI: `bun run start ./my.diff`. Bun first prints the script it runs, `$ bun run ./src/cli/bin.ts`, on stderr, and `bun run --silent start` leaves that line out.

## A standalone binary

```bash
bun run compile
install -m 0755 ./bin/quorum /usr/local/bin/quorum
```

`bun run compile` writes `./bin/quorum`: one executable with the Bun runtime inside, for the system you build it on, which runs without Bun and without the clone. The second line copies it onto your `$PATH` (with `sudo` where `/usr/local/bin` is not yours; any directory on your `$PATH` will do).

The binary reads no `.env` and no `bunfig.toml` from the directory it runs in, which a Bun-compiled binary does by default. Bun itself reads both from its working directory, so `bun run start` reads the clone's own, a `bunfig.toml` can name code to run before quorum starts, and a `.env` can set any `QUORUM_*` variable, `QUORUM_CONFIG` included, which names the config file quorum reads. In a directory you do not control, such as a pull request's checkout, run the binary, or Node as `node /path/to/quorum/src/cli/bin.ts`: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).

The pages that follow write the command as `quorum`, which is that binary. Without it, read `quorum` as `bun run start` run from the clone, except after a `--`: the binary and Node read `quorum -- --help` as a file named `--help`, and Bun itself drops the first `--`, so `bun run start -- --help` prints the help.

## Check that it works

With no diff and stdin a terminal, quorum prints its usage and exits `2` instead of waiting for input:

```bash
quorum
echo $?
```

```text
Error: no diff given
Usage: quorum [options] [diff-file]
       git diff | quorum [options]

Options:
  -c, --config <path>     Read this config file, over QUORUM_CONFIG
  -p, --profile <id>      Run only this profile; repeat it to run several
      --allow-incomplete  Exit 0 instead of 4 when the review is incomplete, except for a request too large for its model
      --print-config      Print the resolved config, keys redacted, and exit
  -h, --help              Print this help and exit
  -v, --version           Print the version and exit
2
```

An empty diff on stdin, with a research model and its context size named, is reviewed without calling any model, so this works before you have one running. The JSON result goes to stdout, sent to `/dev/null` here:

```bash
printf '' | QUORUM_RESEARCH_PRESET=ollama QUORUM_RESEARCH_MODEL=qwen3.6:27b QUORUM_RESEARCH_CONTEXT_TOKENS=32768 quorum > /dev/null
echo $?
```

```text
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
empty diff: nothing to review
0 kept, 0 discarded, 0 unreviewed by panel
0
```

The first two lines name the model of each role and the origin of the endpoint it would call. `QUORUM_RESEARCH_CONTEXT_TOKENS` is the model's context window in tokens, which quorum checks every request against, and `QUORUM_RESEARCH_PRESET=ollama` is set because on Ollama's OpenAI-compatible `/v1` a Modelfile's `num_ctx` outranks `OLLAMA_CONTEXT_LENGTH` and a thinking model's reasoning can run past the reserve, so Ollama would cut the prompt in silence, while the native protocol this preset speaks sends `num_ctx`, `truncate: false` and `shift: false`, telling the server the context size and refusing an overflow. Without `QUORUM_RESEARCH_MODEL`, the same command prints `Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` and exits `2`: a research model must be named even for an empty diff. With the model but without `QUORUM_RESEARCH_CONTEXT_TOKENS`, it prints `Error: no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens` and exits `2` too, for the same reason.

## Next

[Quick start](./20-quickstart.md) — point it at a model, review a diff, and read the progress, the result and the exit code.
