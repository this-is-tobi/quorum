# Architecture

How the code is laid out, which module may depend on which, what happens in a review, and how the suite runs. For a reader who changes quorum, or wants to know where a behaviour lives before trusting it.

## Modules

| Module | Holds |
| --- | --- |
| `src/core/` | The core, with no access to the environment, the network, files or the process. `quorum.ts` is `createQuorum`: the input checks, the compiled profiles, and the review that runs them. `types.ts` holds the shared types, `ports.ts` the `Provider` port, `EventSink`, `ProfilePorts` and `QuorumPorts`, and `errors.ts` the error classes |
| `src/core/stages/` | The stages of one profile: `research.ts`, `dedup.ts`, `panel.ts`, and `context.ts`, which they share: the compiled profile, a call inside the concurrency limit, and the stage events |
| The rest of `src/core/` | `policy.ts`: the rules, thresholds, confidence and where a verdict lands. `profile.ts`: the profile checks and warnings. `prompts.ts`: templates, fences and the notices. `output.ts`: the strict parsing of replies. `diff.ts`: splitting a diff and locating a line in it. `verify.ts`: checking findings against the diff, and their evidence. `concurrency.ts`: the shared limiter. `sanitize.ts`: the hidden-character class, and the inert rendering of a line and of JSON. `flags.ts`: the advisory flags read from the diff |
| `src/profiles/` | Profiles, as data: `security.ts` |
| `src/providers/` | Adapters behind the `Provider` port, and what they share. `openai-compatible.ts` is the adapter. `http.ts` is the request: no redirect is followed, reads are capped, every failure becomes a `ProviderError`, and the key and the base URL's path are redacted from what a server sends back. `options.ts` holds the shared options and their checks. `messages.ts` places the system text |
| `src/cli/` | The CLI: `bin.ts`, the process entry point; `main.ts`, `runCli` and the exit codes; `render.ts`, the progress lines |
| `src/legacy.ts` | The `RESEARCH_*` and `VOTER_*` environment wiring the CLI and `runQuorum` use, and the voter's fallback rule |
| `src/index.ts` | The public API, and the deprecated `runQuorum` |
| `src/testing/` | The test helpers, the provider contract suite and the recorded replies. Spec files import them; nothing else does |

## The dependency rule

The core knows no domain, no model vendor and no process. A profile is data, an adapter sees the core only through its port, and only the outer layers touch the process:

| Layer | May import | May not use |
| --- | --- | --- |
| `src/core/` | Other core modules, `zod`, `node:crypto` and the `package.json` version | The globals `process`, `fetch`, `WebSocket`, `EventSource`, `Worker`, `Bun`, `globalThis`, `global` and `self` |
| `src/profiles/` | Types from `src/core/`, and nothing else | The same globals |
| `src/providers/` | Its own modules, and `core/ports.ts`, `core/errors.ts` and `core/types.ts` | `process`, `Bun`, `globalThis`, `global` and `self`; it may use `fetch`, `WebSocket`, `EventSource` and `Worker` |
| `src/cli/`, `src/legacy.ts`, `src/index.ts` | Any layer | |

The core never imports a profile. `src/cli/` is the one module that reads files and stdin and writes stdout and stderr, and `runQuorum` in `src/index.ts` reads `process.env`. `bun run lint` enforces the table through the overrides at the end of [`eslint.config.js`](../../eslint.config.js), on every production file; a spec file may import across layers.

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
```

- **`bun run test` runs Vitest under Node**, once, on every `src/**/*.spec.ts`. Never run bare `bun test`, which starts Bun's own test runner instead of the Vitest setup the specs are written for, and never run Vitest in watch mode.
- **At most two test workers**, set in [`vitest.config.ts`](../../vitest.config.ts), so the suite stays light on a laptop.
- **No network and no model call.** Every test uses fake providers, or a stubbed `fetch`. The controls of the threat model are checked by structure in the default suite, such as no environment value in any request, and vote requests that are the same whatever the other voters answer.
- **`bun run test:cov`** measures coverage with Istanbul over `src/**/*.ts`, the specs and `src/cli/bin.ts` left out.
- **`bun run lint`** applies `@antfu/eslint-config` and the dependency rule. From an editor's terminal, run it as `CI=1 bun run lint`: the config turns some rules off when it detects an editor.
- **`src/docs.spec.ts`** holds these pages to their links: every relative link resolves to a file and every anchor to a heading of it, every page outside the start page and the reference section ends with a `## Next` that names one page, the table of contents in the README's `## Documentation` section lists every page, and neither the README nor any page holds a hidden character.

When you commit, the Git hooks that `bun install` sets up run lint-staged, which runs eslint on the staged files, and commitlint on the message, which must follow Conventional Commits.

## Related

- [Library API](./30-library-api.md) — what `src/index.ts` exports, and how a review runs from a program.
- [Threat model](../30-security/10-threat-model.md#controls-in-place) — the controls these modules implement.
- [Prompts](../20-using/60-prompts.md) — what `prompts.ts` builds for every call.
