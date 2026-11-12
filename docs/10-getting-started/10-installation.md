# Installation

Quorum is a TypeScript program. It installs from npm and runs on Node, or builds from a clone of its repository and runs under Bun, from the clone or as a standalone binary. This page installs it either way, puts it on your `$PATH`, and checks that it works before any model is running.

A TypeScript program that uses quorum as a library installs the same package and imports `@tobi-or-not/quorum`, as the [Library API](../95-reference/30-library-api.md) shows.

## Prerequisites

- **[Node.js](https://nodejs.org/) `^22.18.0 || >=23.6.0`, to run the npm package.** The `engines` field of [`package.json`](../../package.json) asks for it. From those versions Node strips TypeScript types without a flag, which loading a `.mts` config needs: [Configuration](../20-using/20-configuration.md).
- **[Bun](https://bun.sh/) 1.3.0 or newer, to build from source.** The `engines` field asks for it too, and it installs the dependencies, runs the CLI from a clone and builds the binary.
- **A model endpoint**, for the reviews themselves. With no config file and no base URL, preset or protocol variable it is the [Ollama](https://ollama.com/) on your machine, through its native API at `http://localhost:11434`, the address Ollama listens on, on `127.0.0.1`, by default. `QUORUM_RESEARCH_BASE_URL` on its own points quorum at an OpenAI-compatible `/chat/completions` endpoint instead, a self-hosted vLLM, TGI or llama.cpp server or a hosted API, `QUORUM_RESEARCH_PRESET` names a vendor's preset, such as `anthropic` or `vllm`, and a config file can name an Anthropic, Gemini or Ollama endpoint as well: [Configuration](../20-using/20-configuration.md). The check at the end of this page needs none.
- **[Claude Code](https://code.claude.com/docs), for a `claude-code` provider only.** It is the model's endpoint then: `claude` on your `PATH`, signed in or with a key, run once per request, headless and isolated: [`claudeCode`](../20-using/30-providers.md#claudecode). Quorum requires Claude Code 2.1.311 or newer.

## From npm

```bash
npm install -g @tobi-or-not/quorum
quorum --version
```

`npm install -g` puts a `quorum` command on your `$PATH`, and `quorum --version` prints `quorum` and the installed version. To use the package as a library, install it in your project instead, with `npm install @tobi-or-not/quorum`.

The command runs on Node, never on `bun`: the file the package's `bin` names starts with `#!/usr/bin/env node`. Bun reads a `.env` and a `bunfig.toml` from its working directory before quorum's own code runs, and Node reads neither, so this `quorum` is the simple way to review in a directory you do not control, such as a pull request's checkout: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).

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

The binary reads no `.env` and no `bunfig.toml` from the directory it runs in, which a Bun-compiled binary does by default. Bun itself reads both from its working directory, so `bun run start` reads the clone's own, a `bunfig.toml` can name code to run before quorum starts, and a `.env` can set any `QUORUM_*` variable, `QUORUM_CONFIG` included, which names the config file quorum reads. In a directory you do not control, such as a pull request's checkout, run the binary, or the npm package's `quorum`, which runs on Node: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).

The pages that follow write the command as `quorum`, which is the npm package's command or that binary. Without either, read `quorum` as `bun run start` run from the clone, except after a `--`: the npm package's command and the binary read `quorum -- --help` as a file named `--help`, and Bun itself drops the first `--`, so `bun run start -- --help` prints the help.

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
printf '' | QUORUM_RESEARCH_MODEL=qwen3.6:27b QUORUM_RESEARCH_CONTEXT_TOKENS=32768 quorum > /dev/null
echo $?
```

```text
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
empty diff: nothing to review
0 kept, 0 discarded, 0 unreviewed by panel
0
```

The first two lines name the model of each role and the origin of the endpoint it would call. `QUORUM_RESEARCH_CONTEXT_TOKENS` is the model's context window in tokens, which quorum checks every request against. With no endpoint variable set, the endpoint is the local Ollama's native API, which takes `num_ctx`, `truncate: false` and `shift: false`, so the server is told the context size and refuses an overflow, where Ollama's OpenAI-compatible `/v1` would cut the prompt in silence (refusing needs Ollama 0.12.6 or later): [Layering](../20-using/20-configuration.md#layering). Without `QUORUM_RESEARCH_MODEL`, the same command prints `Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one` and exits `2`: a research model must be named even for an empty diff. With the model but without `QUORUM_RESEARCH_CONTEXT_TOKENS`, it prints `Error: no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens` and exits `2` too, for the same reason.

## Next

[Quick start](./20-quickstart.md) — point it at a model, review a diff, and read the progress, the result and the exit code.
