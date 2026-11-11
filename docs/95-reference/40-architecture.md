# Architecture

How the code is laid out, which module may depend on which, what happens in a review, and how the suite runs. For a reader who changes quorum, or wants to know where a behaviour lives before trusting it.

## Modules

| Module | Holds |
| --- | --- |
| `src/core/` | The core, with no access to the environment, the network, files or the process. `quorum.ts` is `createQuorum`: the input checks, the compiled profiles, and the review that runs them. `types.ts` holds the shared types, `ports.ts` the `Provider` port, `EventSink`, `ProfilePorts` and `QuorumPorts`, and `errors.ts` the error classes, `isSafeSegment` and `issuePath`, which build every issue path |
| `src/core/stages/` | The stages of one profile: `research.ts`, `dedup.ts`, `panel.ts`, and `context.ts`, which they share: the compiled profile, a call inside the concurrency limit, and the stage events |
| The rest of `src/core/` | `policy.ts`: the rules, thresholds, confidence and where a verdict lands. `profile.ts`: the profile checks and warnings. `prompts.ts`: templates, fences and the notices. `output.ts`: the strict parsing of replies. `diff.ts`: splitting a diff and locating a line in it. `verify.ts`: checking findings against the diff, and their evidence. `concurrency.ts`: the shared limiter. `sanitize.ts`: the hidden-character class, and the inert rendering of a line and of JSON. `flags.ts`: the advisory flags read from the diff |
| `src/profiles/` | Profiles, as data: `security.ts` |
| `src/providers/` | Adapters behind the `Provider` port, and what they share. `openai-compatible.ts`, `anthropic.ts`, `gemini.ts` and `ollama.ts` are the adapters, each with the reader of its replies. `http.ts` is the request: no redirect is followed, reads are capped, every failure becomes a `ProviderError`, and the key, the base URL's path and the header values are redacted from what a server sends back. `options.ts` holds the shared options and their checks, under the rules each adapter declares: the body fields it writes, its tool fields, the headers it always sends and its structured-output modes; and `prepareHttp`, which runs those checks, then the adapter's own, and builds what every request sends, the URL, the headers, the values to redact and a copy of `extraBody`. `presets.ts` holds the presets, frozen data. `build.ts` builds a provider from a spec that names a preset or a protocol, after the spec's checks and the adapter's; `resolve.ts` calls it to check each provider and `fromConfig` to build each one, and it is not exported from the package. `reply.ts` holds what the readers share: the failure, the token counts, the message of a reply that ended early, and the joined text of its parts. `messages.ts` places the system text, natively or inline. `size.ts` is the size guard every HTTP adapter runs before a request: it bounds the request by one token per UTF-8 byte of its text, a reserve for the chat template and the reply budget, and refuses one that may not fit `contextTokens`. |
| `src/config/` | The config layer, which the CLI and `runQuorum` call through `loadConfig` and `fromConfig`: `src/index.ts` exports them with `defineConfig` and the types, and `scripts/schema.ts` calls the schema to write the JSON Schema. `schema.ts` holds the zod schemas of a config, strict at every level: the file variant, for YAML and JSON, which is data only, and the code variant, for TS and JS, where a provider may also hold its key or be an object implementing `Provider`; their types, `QuorumConfig` and `QuorumConfigFile`; the issues a parse reports, which repeat no value and print a key that is not a safe name as `*`; and the JSON Schema of the file variant. `load.ts` is `readConfigFile`, which reads one named file into a checked config: a regular file of at most 1 MiB in UTF-8, holding YAML 1.2 of the core schema, which refuses an unknown tag, a YAML 1.1 tag such as `!!binary`, an alias and a repeated key; JSON, which refuses a repeated key; or a module whose default export is the config. Its value must be plain data, a provider object aside, with no `__proto__` key, and at most 10000 values; then the schema checks it, and every prompt file it names is read once, however many profiles name it: at most 64 KiB each and 1 MiB in all. A prompt path is read as given, relative to the config file or absolute, and is not confined to its directory: a config is trusted like code. `env.ts` reads the `QUORUM_*` variables, their deprecated aliases and the voter they derive, which never carries a key or a model to another origin. `profiles.ts` resolves the profiles that run, each from a built-in profile or its own fields. `resolve.ts` layers a config with the environment and the built-in defaults, binds the roles, reads the keys and checks every provider with the builder, and returns the frozen resolved config. `from-config.ts` is `fromConfig`, which checks a program's config as a code config is checked, builds each provider and wraps each provider object under its config key; `loadConfig`, in `load.ts`, reads the file `configPath` or `QUORUM_CONFIG` names, never one it finds, and resolves it. `define.ts` is `defineConfig` |
| `src/cli/` | The CLI: `bin.ts`, the process entry point, which holds exit code `3` until the run settles; `main.ts`, `runCli` and the exit codes; `render.ts`, the banner, the progress lines and the progress sink the CLI and `runQuorum` share; `print-config.ts`, the YAML of `--print-config` |
| `src/index.ts` | The public API, and the deprecated `runQuorum` |
| `schema/quorum.schema.json` | The JSON Schema of a YAML or JSON config, for editors: draft-07, generated from the file variant by `bun run schema`, which runs `scripts/schema.ts`, and committed |
| `src/testing/` | The test helpers, among them the `fetch` stub the adapter specs share, the provider contract suite every adapter's spec runs, and each protocol's recorded replies. Spec files import them; `bun run lint` refuses an import from any other file |

## The dependency rule

The core knows no domain, no model vendor and no process. A profile is data, an adapter sees the core only through its port, and only the outer layers touch the process:

| Layer | May import | May not use |
| --- | --- | --- |
| `src/core/` | Other core modules, `zod`, `node:crypto` and the `package.json` version | The globals `process`, `fetch`, `WebSocket`, `EventSource`, `Worker`, `Bun`, `globalThis`, `global` and `self` |
| `src/profiles/` | Types from `src/core/`, and nothing else | The same globals |
| `src/providers/` | Its own modules, and `core/ports.ts`, `core/errors.ts` and `core/types.ts` | `process`, `Bun`, `globalThis`, `global` and `self`; it may use `fetch`, `WebSocket`, `EventSource` and `Worker` |
| `src/config/` | Its own modules, `src/core/`, `src/profiles/`, `src/providers/`, `zod`, `yaml`, `node:fs`, `node:fs/promises`, `node:path` and `node:url` | `fetch`, `WebSocket`, `EventSource`, `Worker`, `globalThis`, `global` and `self`; it may read `process` |
| `src/cli/`, `src/index.ts` | Any layer but `src/testing/` | |

The core never imports a profile. `src/config/` reads the config file it is named, the prompt files that file names, and `process.env` when `loadConfig` or `fromConfig` is given no environment, `src/cli/` is the one module that reads the diff and stdin and writes stdout and stderr, and `runQuorum` in `src/index.ts` calls `loadConfig` with no options, so it reads `process.env` and the file `QUORUM_CONFIG` names, which must be an absolute path. `bun run lint` enforces the table through the overrides at the end of [`eslint.config.js`](../../eslint.config.js), on every production file; a spec file may import across layers, and `src/testing/`. `src/lint.spec.ts` lints a probe file in each layer through ESLint's API, so a boundary that stops refusing an import or a global fails the suite.

## The stages of a review

`review` runs every profile of the quorum at once, on a diff split into one section per file once for all of them, under one concurrency limit. Before any stage, the harness reads the advisory flags from that split diff. Each profile goes through three stages on its own:

1. **Research.** One call to the profile's research provider, with its research instructions, the fenced diff and its guidelines. The reply is parsed strictly, only the first `maxFindings` findings it lists are read, and each is checked against the diff: a finding that cites code outside the diff is dropped, and one the harness cannot read is a gap. Each finding that passes the check is named by its id and tagged with its profile.
2. **Dedup.** Plain code drops a finding that repeats the file, line and category of an earlier one.
3. **Panel.** Every finding goes to every lens, each vote to the lens's own provider, each voter receiving the claim, the evidence, the diff section of the cited file, and the guidelines when the profile has them. The verdict is computed in code from the votes, by the profile's thresholds.

The result joins the profiles' verdicts and gaps in profile order, its `meta.usage` and `invalidFindings` are counted from the review's own events, its `meta.flags` holds the flags, and each event reaches the sink as a copy. Every stage and every call checks the review's signal: [Abort](./30-library-api.md#abort).

## Testing

```bash
bun run test        # the whole suite, once
bun run test:cov    # the same, with coverage
bun run typecheck   # tsc --noEmit
bun run lint        # eslint, the Markdown pages and their code blocks included
bun run format      # eslint --fix
bun run schema      # write schema/quorum.schema.json from the zod schema
```

- **`bun run test` runs Vitest under Node**, once, on every `src/**/*.spec.ts`. Never run bare `bun test`, which starts Bun's own test runner instead of the Vitest setup the specs are written for, and never run Vitest in watch mode.
- **At most two test workers**, set in [`vitest.config.ts`](../../vitest.config.ts), so the suite stays light on a laptop.
- **No network and no model call.** Every test uses fake providers, or a stubbed `fetch`. The controls of the threat model are checked by structure in the default suite, such as no environment value in any request, and vote requests that are the same whatever the other voters answer.
- **`bun run test:cov`** measures coverage with Istanbul over `src/**/*.ts`, the specs and `src/cli/bin.ts` left out.
- **Files and processes.** `src/config/load.spec.ts` writes the files it reads to fresh temporary directories, removed afterwards, and runs one `node` process on the loader: vitest's own import transforms TypeScript that Node itself refuses, such as an `enum`, so only a real `node` shows what Node reports. `src/cli/main.spec.ts` writes its config files to a temporary directory too, and `src/cli/bin.spec.ts` runs `node` on `bin.ts`, for what only a process shows: the exit code it sets, a run that stops with nothing left to wait for, an error nothing caught, SIGTERM, and a second SIGINT. `src/lint.spec.ts` starts ESLint once, about a second, and lints a probe file in each layer through its API, in memory: it writes no file.
- **`src/config/schema.spec.ts`** fails when `schema/quorum.schema.json` differs from the JSON Schema of the zod schema, byte for byte: run `bun run schema` after changing the schema, and commit the file.
- **`bun run lint`** applies `@antfu/eslint-config` and the dependency rule. From an editor's terminal, run it as `CI=1 bun run lint`: the config turns some rules off when it detects an editor.
- **`src/docs.spec.ts`** holds these pages to their links: every relative link resolves to a file and every anchor to a heading of it, every page outside the start page and the reference section ends with a `## Next` that names one page, the table of contents in the README's `## Documentation` section lists every page, and neither the README nor any page holds a hidden character.

When you commit, the Git hooks that `bun install` sets up run lint-staged, which runs eslint on the staged files, and commitlint on the message, which must follow Conventional Commits.

## Related

- [Library API](./30-library-api.md) — what `src/index.ts` exports, and how a review runs from a program.
- [Threat model](../30-security/10-threat-model.md#controls-in-place) — the controls these modules implement.
- [Prompts](../20-using/60-prompts.md) — what `prompts.ts` builds for every call.
