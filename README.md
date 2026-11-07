# Quorum

A multi-agent security-review pipeline: an LLM proposes candidate vulnerabilities in a diff, then three independent voters — blind to each other's reasoning — each judge the same candidate from a different fixed angle before it's reported. Talks to any OpenAI-compatible `/chat/completions` endpoint, with a single small runtime dependency ([zod](https://zod.dev), which validates every model reply).

## Status

Early / under active iteration. Currently implements the finder + independent panel + code-computed quorum (roughly phase 0-1 of the design). Escalation on marginal (2/3) splits, cross-model verification, and a patch-generation loop are on the [roadmap](#roadmap), not yet built here.

## Why a panel instead of "ask a second model"

Letting verifiers see each other's reasoning measurably converges results toward agreement rather than correctness, and a verifying model is worse at judging its own confidence than a proposing one is. So the three votes here run fully independently — no shared context between them — and the keep/discard decision plus its confidence ceiling (`3/3` -> `high`, `2/3` -> `medium`, otherwise discarded, or `unreviewed` when a failed vote could still have kept it) is ordinary arithmetic in [`src/core/policy.ts`](./src/core/policy.ts), applied by [`src/pipeline.ts`](./src/pipeline.ts), never a number a model reports about itself. Three voters is close to the cost-effective floor, not a placeholder for more: self-consistency research shows most of the achievable gain from repeated sampling arrives within a handful of samples, and each additional parallel call has a real latency cost.

This is expected to disagree with itself between runs sometimes — that's inherent to the approach, not a bug. A `2/3` split today is a real, still-open design gap: without the escalation phase, it lands as `medium` confidence and stops there rather than triggering a repanel and a dedicated adversarial pass.

## Key features

- One small runtime dependency (`zod`, validating every model reply) — plain `fetch`, works under Bun or Node
- Model-agnostic per role: point the finder and the panel at different backends (`RESEARCH_*` / `VOTER_*` env vars, `VOTER_*` falls back to `RESEARCH_*`)
- Compiles to a standalone binary via Bun (`bun run compile`) — no runtime dependency to distribute
- Defensive JSON extraction rather than trusting `response_format` schema enforcement, since OpenAI-compatible servers vary in how much of the real API surface they implement, followed by strict validation: a reply must hold exactly one JSON object (one cut off inside a reasoning block, holding several different objects, holding a group that opens like a JSON object but never closes or does not parse, holding an object that repeats a key, or followed by text that reads like JSON syntax (a quote, brace or bracket), fails the research call, or that vote; a research reply whose object holds a key other than `findings` fails too), and a malformed research reply fails the run instead of silently reporting nothing; an unparseable vote is recorded in `votes[].error` and counts as a reject, and the finding is `unreviewed` rather than discarded when that vote could still have kept it
- Untrusted data is fenced: instructions go in the system message, while the diff and every model-derived finding field go in the user message inside tags carrying a random nonce, since the diff is attacker-influenced input on any real PR. The code a finding points at is never taken from the finder: the harness reads it from the diff (a finding must cite a line inside a hunk of the diff and, when the diff has per-file headers, one of its files, or it is dropped), and voters receive that text, the diff section of the cited file, and the finder's summary and category, cleaned and capped, as an unverified claim.
- The gaps the harness detects are reported, not hidden: a finding whose failed votes could still have kept it is reported as `unreviewed` rather than discarded, a finding the harness could not read, a kept finding whose failed vote could have raised it to `high`, a research reply whose findings were all unusable and findings beyond the cap of 50 per reply are recorded in `meta.incomplete`, and the CLI exits `4` so CI fails until the run is complete

## Prerequisites

- [Bun](https://bun.sh/) >= 1.3
- An OpenAI-compatible `/chat/completions` endpoint (a local [Ollama](https://ollama.com/) install, self-hosted vLLM/TGI/llama.cpp server, or a hosted API such as OpenAI)

## Installation

```bash
git clone https://github.com/this-is-tobi/quorum.git
cd quorum
bun install
```

## Usage

```bash
# Run against a diff file
RESEARCH_MODEL=qwen3.6:27b bun run start ./my.diff

# Or pipe a diff on stdin
git diff origin/main...HEAD | RESEARCH_MODEL=qwen3.6:27b bun run start

# Compile to a standalone binary
bun run compile
./bin/quorum ./my.diff
```

Exit codes: `0` when the review is complete and no kept finding reaches `high` confidence (including findings kept only at `medium`); `1` when at least one does (unanimous 3/3), so it can gate CI without extra parsing; `2` for usage or configuration errors (no diff given on an interactive terminal, missing file, no model configured, a base URL that is not an `http://` or `https://` URL with a host, an API key with a character an HTTP header cannot carry); `3` when the run itself fails (for example the research model's endpoint is unreachable, refuses, is cut off by its token limit or returns an unusable reply; a failing voter does not fail the run; see `4`); `4` when the review is incomplete: a finding is `unreviewed` because a failed vote could still have kept it, the finder reported a finding the harness could not read (one that does not match the reply schema, or holds a nested object or array outside it), a kept finding has a failed vote that could have raised it to `high`, the research reply listed only unusable findings, or it listed more than 50 findings and the rest were not reviewed. A kept `high` finding takes precedence over an incomplete review. An empty diff exits `0` without calling any model, once a research model is configured (`2` otherwise).

## Configuration

All configuration is environment variables — no config file.

```bash
export RESEARCH_BASE_URL="http://localhost:11434/v1"  # default: that (Ollama)
export RESEARCH_API_KEY="sk-..."                       # omit for endpoints with no auth: no Authorization header is sent without a key
export RESEARCH_MODEL="qwen3.6:27b"                    # required

# Optional - point the panel at a different backend than the finder
export VOTER_MODEL="gpt-5.4"
export VOTER_BASE_URL="https://api.openai.com/v1"
export VOTER_API_KEY="sk-..."
```

Each `VOTER_*` variable falls back to its `RESEARCH_*` counterpart when it is unset or empty, as long as the voter uses the same endpoint. When `VOTER_BASE_URL` has another scheme, host or port than `RESEARCH_BASE_URL`, nothing is inherited: `VOTER_MODEL` must be set (exit `2` otherwise), and the voter sends a key only when `VOTER_API_KEY` is set, so the research key never reaches another endpoint.

Models that reject `temperature: 0` (OpenAI's reasoning models, current Claude models) cannot be used through these variables yet; per-provider settings arrive with the configuration layer.

## API

```typescript
import { review } from './src/pipeline.ts'
import { openaiCompatible } from './src/providers/openai-compatible.ts'

const provider = openaiCompatible({ id: 'local', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.6:27b' })
const diff = await Bun.file('./my.diff').text()
const { kept, discarded, unreviewed, meta } = await review(diff, { research: provider, voter: provider }, message => console.error(message))

for (const finding of kept) {
  console.log(`${finding.file}:${finding.line} [${finding.confidence}] ${finding.summary}`)
}
```

## Architecture

```
diff -> research (1 call)  ->  dedup  ->  panel (3 independent calls per finding)  ->  kept / discarded / unreviewed
```

- **`src/core/`** — the pure core, with no environment, network or process access: `types.ts` (shared interfaces), `policy.ts` (vote thresholds, confidence, and the kept / discarded / unreviewed status of a verdict), `stages/research.ts` (parses a research reply, caps it, checks each finding against the diff and records what could not be reviewed), `output.ts` (strict reply parsing), `diff.ts` and `verify.ts` (diff sections and code-derived evidence), `prompts.ts` (fenced requests), `concurrency.ts` (the shared call limit), `errors.ts` and `ports.ts`
- **`src/providers/`** — model backends behind the `Provider` port: `openai-compatible.ts` (any OpenAI-compatible `/chat/completions` endpoint, with normalized `ProviderError`s) and `http.ts` (the shared JSON POST helper); a provider returns the raw reply text and parsing stays in `src/core/output.ts`
- **`src/legacy.ts`** — the temporary `RESEARCH_*` / `VOTER_*` environment wiring that builds the providers; the config layer replaces it
- **`src/pipeline.ts`** — `research` (find candidates), `dedup` (drop repeats), `panel` (independent 3-vote judgment), `review` (wires them together over explicit providers), `runQuorum` (deprecated: `review` with providers from the environment)
- **`src/cli/`** — CLI: `bin.ts` is the process entry point, `main.ts` holds the testable `runCli`

## Testing

```bash
bun run test        # unit tests (pure logic only: dedup, panel's vote arithmetic, the reply parsing in src/core/output.ts - no network, no model calls, all model I/O is mocked)
bun run test:cov    # same, with coverage
```

> [!NOTE]
> Use `bun run test`, not bare `bun test` — the latter invokes Bun's own built-in test runner instead of the Vitest setup these specs are written against.

## Roadmap

- Escalation pass on `2/3` splits: repanel with an adversarial angle instead of settling for `medium`
- Cross-model verification as a first-class mode, not just an env-var fallback
- A patch-generation loop for kept findings
- Multi-platform compiled release assets attached to GitHub Releases

## Contributing

This is a personal tool under active iteration — issues and PRs are welcome, but expect the design to keep shifting until the phases above land.
