# Installation

Quorum is a TypeScript program. It installs from npm and runs on Node, downloads from a release as a binary that needs neither Node nor Bun, runs from a container image that holds that binary, or builds from a clone of its repository and runs under Bun, from the clone or as a standalone binary. This page installs it any of these ways, puts it on your `$PATH`, and checks that it works before any model is running.

A TypeScript program that uses quorum as a library installs the same package and imports `@tobi-or-not/quorum`, as the [Library API](../95-reference/30-library-api.md) shows.

## Prerequisites

- **[Node.js](https://nodejs.org/) `^22.18.0 || >=23.6.0`, to run the npm package.** The `engines` field of [`package.json`](../../package.json) asks for it. From those versions Node strips TypeScript types without a flag, which loading a `.mts` config needs: [Configuration](../20-using/20-configuration.md).
- **[Bun](https://bun.sh/) 1.3.0 or newer, to build from source.** The `engines` field asks for it too, and it installs the dependencies, runs the CLI from a clone and builds the binary.
- **A container engine such as [Docker](https://docs.docker.com/get-started/get-docker/), to run the image.**
- **A model endpoint**, for the reviews themselves. With no config file and no base URL, preset or protocol variable it is the [Ollama](https://ollama.com/) on your machine, through its native API at `http://localhost:11434`, the address Ollama listens on, on `127.0.0.1`, by default. `QUORUM_RESEARCH_BASE_URL` on its own points quorum at an OpenAI-compatible `/chat/completions` endpoint instead, a self-hosted vLLM, TGI or llama.cpp server or a hosted API, `QUORUM_RESEARCH_PRESET` names a vendor's preset, such as `anthropic` or `vllm`, and a config file can name an Anthropic, Gemini or Ollama endpoint as well: [Configuration](../20-using/20-configuration.md). The check at the end of this page needs none.
- **[Claude Code](https://code.claude.com/docs), for a `claude-code` provider only.** It is the model's endpoint then: `claude` on your `PATH`, signed in or with a key, run once per request, headless and isolated: [`claudeCode`](../20-using/30-providers.md#claudecode). Quorum requires Claude Code 2.1.311 or newer.

## From npm

```bash
npm install -g @tobi-or-not/quorum
quorum --version
```

`npm install -g` puts a `quorum` command on your `$PATH`, and `quorum --version` prints `quorum` and the installed version. To use the package as a library, install it in your project instead, with `npm install @tobi-or-not/quorum`.

The command runs on Node, never on `bun`: the file the package's `bin` names starts with `#!/usr/bin/env node`. Bun reads a `.env` and a `bunfig.toml` from its working directory before quorum's own code runs, and Node reads neither, so this `quorum` is the simple way to review in a directory you do not control, such as a pull request's checkout: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).

Each version is published by this repository's CD with npm's provenance, a signed record of the repository, the workflow file, the commit and the run that built it. There are two ways to see it:

- **On the package's page.** npmjs.com shows a green check beside the version, and its details link to the source commit and to the workflow run that built the package: [Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance).
- **With `npm audit signatures`**, in a project that has installed the package, one with a `package.json` and a `node_modules`:

  ```bash
  npm install @tobi-or-not/quorum
  npm audit signatures
  ```

  It prints how many of the installed packages have verified registry signatures and how many have verified attestations; this package counts in both. It checks that the signature and the provenance of each installed version verify, and it does not pin where a package was built the way `gh attestation verify --repo` does for a binary: read the repository, the commit and the run on the package's page. It does not cover a global install, which has no project to audit: install the package in a scratch directory to check it.

## A release binary

Each [release](https://github.com/this-is-tobi/quorum/releases) carries a binary for each platform it supports, `quorum-linux-x64`, `quorum-linux-arm64`, `quorum-darwin-x64` and `quorum-darwin-arm64` (`darwin` is macOS, and `uname -m` prints `x86_64` for `x64` and `arm64` or `aarch64` for `arm64`), and a `SHA256SUMS` file that lists their checksums. Download the binary for your system with the checksums, replacing `<version>` with the release's version and `<target>` with your platform, `linux-x64` for example:

```bash
gh release download v<version> --repo this-is-tobi/quorum --pattern 'quorum-<target>' --pattern SHA256SUMS
```

Or, without `gh`:

```bash
curl -fsSLO https://github.com/this-is-tobi/quorum/releases/download/v<version>/quorum-<target>
curl -fsSLO https://github.com/this-is-tobi/quorum/releases/download/v<version>/SHA256SUMS
```

Check the file against the checksums before you run it. On Linux, with the `sha256sum` of GNU coreutils:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

On macOS, with its `shasum`:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Both print `quorum-<target>: OK`. `--ignore-missing` leaves out the three binaries you did not download, which the check would report as missing. The checksums come from the same release as the binary, so they catch a damaged or incomplete download but not a file that was swapped along with them. The build provenance attestation of each binary does: it is a signed record that GitHub Actions in this repository built that file, and `gh attestation verify` checks the file against it:

```bash
gh attestation verify quorum-<target> --repo this-is-tobi/quorum
```

Then make it executable, check it and put it on your `$PATH`:

```bash
chmod +x quorum-<target>
./quorum-<target> --version
install -m 0755 quorum-<target> /usr/local/bin/quorum
```

The last line needs `sudo` where `/usr/local/bin` is not yours; any directory on your `$PATH` will do.

The binary holds the Bun runtime, so it needs neither Bun nor Node, and, like the one `bun run compile` builds below, it reads no `.env` and no `bunfig.toml` from the directory it runs in. The Linux binaries are linked against glibc: they run on Debian, Ubuntu and the like, not on Alpine, which uses musl. On macOS, download with `gh` or `curl` as above: a download in a browser marks the file with the `com.apple.quarantine` attribute, which `gh` and `curl` do not add.

## A container image

Each release also publishes an image for `linux/amd64` and `linux/arm64`, `ghcr.io/this-is-tobi/quorum`, tagged with the release's version without its `v`, `0.2.0` for `v0.2.0`, with its minor and major, `0.2` and `0`, and with `latest`. Pin a version rather than `latest`, and replace `<version>` below with it. The image holds the binary above and nothing else: no shell, no `claude` CLI, so a `claude-code` provider does not run in it. It runs as the distroless `nonroot` user, uid 65532, in the working directory `/work`, and, like the binary, reads no `.env` and no `bunfig.toml` from it.

The diff arrives on stdin, which `docker run` forwards with `-i`, the result goes to stdout, and the settings are the `QUORUM_*` variables, passed with `-e`:

```bash
docker run --rm -i \
  -e QUORUM_RESEARCH_PROTOCOL=ollama \
  -e QUORUM_RESEARCH_BASE_URL=http://host.docker.internal:11434 \
  -e QUORUM_RESEARCH_MODEL=qwen3.6:27b \
  -e QUORUM_RESEARCH_CONTEXT_TOKENS=32768 \
  ghcr.io/this-is-tobi/quorum:<version> < my.diff > result.json
```

The arguments after the image name are quorum's own, `--print-config` or `--config` for instance. With no voter variable the panel shares the finder's provider, so these four variables serve both: [The voter's fallback](../20-using/20-configuration.md#the-voters-fallback).

- **`localhost` is the container.** Inside it, the default endpoint, Ollama's native API at `http://localhost:11434`, finds nothing, so name the endpoint. A base URL variable on its own means an `openai-compatible` server, so the example names the protocol too: Ollama's native API at another address takes `QUORUM_RESEARCH_PROTOCOL=ollama` with `QUORUM_RESEARCH_BASE_URL`, and a vLLM, TGI or llama.cpp server or a hosted API takes `QUORUM_RESEARCH_BASE_URL` alone: [A base URL variable on its own](../20-using/20-configuration.md#the-environment-variables).
- **A server on the host is `host.docker.internal`.** Docker Desktop resolves that name to the host: on Docker Desktop 4.99.0 for macOS it resolved with no option, and a server of the host that listened only on `127.0.0.1` answered through it. On Linux, add the name yourself, `--add-host=host.docker.internal:host-gateway`, which Docker resolves to the host's internal IP address. That is not the host's loopback address, so a service that listens only on `127.0.0.1`, as Ollama does by default, is not reachable through it from a Linux container: Ollama's `OLLAMA_HOST` variable sets the address it listens on, `0.0.0.0:11434` for every interface, which opens the service to whatever else can reach the host.
- **A key is passed by name, from your environment.** `-e QUORUM_RESEARCH_API_KEY`, with no `=` and no value, has the Docker client read the value from its own environment, where the variable must be exported: Docker leaves one that is not exported unset in the container. The value is then not among the arguments of the `docker run` line, so it is not in that line's entry in your shell history or in the list of processes. Get it into the environment without typing it into a shell, as `export QUORUM_RESEARCH_API_KEY=...` would, which puts it in your history: from your secret store, or from a CI secret that the job exposes as that variable. The key is still in the container's environment, and `docker inspect` shows the variables of a container, a running one's key among them, to whoever can reach your Docker daemon. See [Keys](../20-using/20-configuration.md#keys). A key sent to `http://host.docker.internal` draws that section's warning about a key sent over plain `http` to a host other than this machine, since only `localhost` and the loopback addresses count as this machine.
- **A config file is mounted read-only and named with `--config`**, a path inside the container:

  ```bash
  docker run --rm -i \
    -v "$PWD/quorum.yaml:/etc/quorum/quorum.yaml:ro" \
    ghcr.io/this-is-tobi/quorum:<version> --config /etc/quorum/quorum.yaml < my.diff > result.json
  ```

  The user the image runs as, uid 65532, must be able to read the file. A bind mount keeps the host file's owner and mode on Linux, where a file that only its owner can read, mode `0600`, fails as `Error: /etc/quorum/quorum.yaml: cannot be read`: give it mode `0644`. A provider's `apiKeyEnv` names a variable that you pass with `-e`, and its `baseUrl` is an address the container reaches, `host.docker.internal` for a server on the host.
- **A diff file is named from `/work`.** Mount its directory there, `-v "$PWD:/work:ro"`, and pass the file as the argument, `my.diff`, in place of `-i` and the redirection.

`docker run --rm ghcr.io/this-is-tobi/quorum:<version> --version` prints `quorum` and the version, and the empty-diff check at the end of this page runs in the image too, with its two variables passed by `-e` and the empty diff piped to `docker run -i`.

Check the image against its attestation before you run it. The release's CD signs the image with cosign, attaches an SPDX SBOM to it, and records a build provenance attestation, a signed record that a GitHub Actions run of this repository built that image. `gh attestation verify` checks that record; the signature and the SBOM are cosign's, and `gh` does not read them:

```bash
gh attestation verify oci://ghcr.io/this-is-tobi/quorum:<version> --owner this-is-tobi
```

The record's certificate names two workflows. Its signer, which `gh` matches, is the shared `attest-docker` workflow of `this-is-tobi/github-workflows`, and it records this repository's `cd.yml` as the build configuration. Since `gh` matches the signer, the check names the owner where a binary's names the repository, and `--repo this-is-tobi/quorum` alone refuses it. To pin the repository too, add the signer's: `--repo this-is-tobi/quorum --signer-repo this-is-tobi/github-workflows` in place of `--owner this-is-tobi`.

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

`bun run compile:release` builds the four binaries of a release instead, whatever system you run it on, and writes them with their `SHA256SUMS` to `bin/release/`. Bun downloads the runtimes of the other platforms the first time.

The binary reads no `.env` and no `bunfig.toml` from the directory it runs in, which a Bun-compiled binary does by default. Bun itself reads both from its working directory, so `bun run start` reads the clone's own, a `bunfig.toml` can name code to run before quorum starts, and a `.env` can set any `QUORUM_*` variable, `QUORUM_CONFIG` included, which names the config file quorum reads. In a directory you do not control, such as a pull request's checkout, run the binary, or the npm package's `quorum`, which runs on Node: [Nothing read from the working directory](../30-security/10-threat-model.md#nothing-read-from-the-working-directory).

The pages that follow write the command as `quorum`, which is the npm package's command or a binary. Without either, read `quorum` as `bun run start` run from the clone, except after a `--`: the npm package's command and the binary read `quorum -- --help` as a file named `--help`, and Bun itself drops the first `--`, so `bun run start -- --help` prints the help.

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
