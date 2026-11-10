# Installation

Quorum is a TypeScript program that runs under Bun, from a clone of its repository or as a standalone binary built from that clone. This page installs it, builds the binary, puts it on your `$PATH`, and checks that it works before any model is running.

There is no npm package yet: a TypeScript program that uses quorum as a library imports `src/index.ts` from the clone, as the [Library API](../95-reference/30-library-api.md) shows.

## Prerequisites

- **[Bun](https://bun.sh/) 1.3.0 or newer.** The `engines` field of [`package.json`](../../package.json) asks for it, and it installs the dependencies, runs the CLI and builds the binary.
- **An OpenAI-compatible `/chat/completions` endpoint** that serves a model, for the reviews themselves: [Ollama](https://ollama.com/) on your machine, a self-hosted vLLM, TGI or llama.cpp server, or a hosted API. The check at the end of this page needs none.

## From source

```bash
git clone https://github.com/this-is-tobi/quorum.git
cd quorum
bun install
```

`bun install` installs quorum's two runtime dependencies, [zod](https://zod.dev), which validates every model reply, and [yaml](https://eemeli.org/yaml/), which parses a YAML config file once quorum reads one, and the development tools.

From the root of the clone, `bun run start` runs the CLI: `bun run start ./my.diff`. Bun first prints the script it runs, `$ bun run ./src/cli/bin.ts`, on stderr, and `bun run --silent start` leaves that line out.

## A standalone binary

```bash
bun run compile
install -m 0755 ./bin/quorum /usr/local/bin/quorum
```

`bun run compile` writes `./bin/quorum`: one executable with the Bun runtime inside, for the system you build it on, which runs without Bun and without the clone. The second line copies it onto your `$PATH` (with `sudo` where `/usr/local/bin` is not yours; any directory on your `$PATH` will do).

The binary reads no `.env` and no `bunfig.toml` from the directory it runs in, which a Bun-compiled binary does by default. Bun itself reads both from its working directory, so `bun run start` reads the clone's own, and a `bunfig.toml` can name code to run before quorum starts. In a directory you do not control, such as a pull request's checkout, run the binary: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).

The pages that follow write the command as `quorum`, which is that binary. Without it, read `quorum` as `bun run start` run from the clone.

## Check that it works

With no diff and stdin a terminal, quorum prints its usage and exits `2` instead of waiting for input:

```bash
quorum
echo $?
```

```text
Error: no diff given
Usage: quorum <diff-file>
       git diff | quorum
2
```

An empty diff on stdin, with a research model named, is reviewed without calling any model, so this works before you have one running. The JSON result goes to stdout, sent to `/dev/null` here:

```bash
printf '' | RESEARCH_MODEL=qwen3.6:27b quorum > /dev/null
echo $?
```

```text
Research (qwen3.6:27b @ http://localhost:11434)...
Panel will use qwen3.6:27b @ http://localhost:11434
empty diff: nothing to review
0 kept, 0 discarded, 0 unreviewed by panel
0
```

The first two lines name the model of each role and the origin of the endpoint it would call. Without `RESEARCH_MODEL`, the same command prints `Error: RESEARCH_MODEL: is not set` and exits `2`: a research model must be named even for an empty diff.

## Next

[Quick start](./20-quickstart.md) — point it at a model, review a diff, and read the progress, the result and the exit code.
