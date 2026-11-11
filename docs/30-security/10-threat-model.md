# Threat model

What an attacker can do to a review, what quorum protects, which controls stand in the way today, and what remains. Read it before you run quorum on changes you did not write: none of it is a setting to turn on, it is how quorum works.

## The attacker

Quorum feeds text an attacker controls to language models and reports what they answer. The attacker is anyone who can open a pull request, from a fork included, and they control the whole diff: its code, comments, strings and file names, and the commit messages a `git format-patch` series carries. They control every file of the pull request's branch too, so guidelines a caller loads from that branch's checkout are theirs as well, and so are a config file and the prompt files it names.

What quorum answers goes to the JSON result on stdout and the lines on stderr, and from there to CI logs, terminals and whatever renders the result. It usually runs in CI, with a model API key in its environment.

## Assets

| Asset | The attacker wants to | What stands in the way |
| --- | --- | --- |
| Verdict integrity | Suppress a real finding, sway a verdict, or forge a finding | Code-derived evidence, strict parsing, blind votes and arithmetic confidence, within the limits of the [residual risk](#residual-risk) |
| Secrets: the model key, a CI token, repository credentials | Have a model read or leak them | A model path with no tool and no secret, a key sent only to its own endpoint, and a binary that reads nothing from the working directory, a config file included unless it is named |
| Output channels: CI logs, terminals, what renders the result | Turn model text into markup, a link, a workflow command or an escape sequence | The CLI makes the text it writes inert for a terminal and a GitHub Actions log; anything else that renders the result must treat its text as untrusted: [Output handling](./30-output-handling.md) |
| Availability and spend | Multiply the calls and their cost with a huge or finding-flooding pull request | `maxFindings`, the concurrency limit and the reply caps |
| Coverage | Have the run review less than the whole change, silently | The size guard, which refuses a request that may not fit the model's context, and unreviewed findings and incomplete reviews, exit `4`, for the gaps the harness detects; what the guard cannot know is not one of them: [What the harness cannot detect](#what-the-harness-cannot-detect) |

## Residual risk

A determined adaptive attacker may suppress or sway findings. In published studies no prompt-level defense held under adaptive attack, and a panel of blind voters filters false positives but cannot restore a finding the finder never proposed. Quorum keeps the model path harmless, raises the cost of an attack, and shows a human where to look: each verdict's vote split, its `quoteMatched` flag (whether the code the finder quoted appears in the evidence), the `invalidFindings` count of findings that cited code outside the diff, the unreviewed findings, the advisory flags of `meta.flags`, and the entries of `meta.incomplete`. It assists a reviewer; it does not replace human review of untrusted changes.

With no tool and no secret in the model path, the incident classes of 2025 and 2026, token theft and code execution through an AI agent in CI, do not apply. What remains is verdict manipulation, the places where model text is rendered, cost, and files that look trusted, such as guidelines or a config read from the pull request's checkout.

## Controls in place

### A model path with no tool and no secret

A provider receives text and returns text. Quorum offers no tool, function, file or network capability to a model, and the request type has no field for one. Each shipped adapter refuses, in a program's `extraBody`, the body fields of its protocol that would offer one, such as `tools`, OpenRouter's `plugins`, Anthropic's `mcp_servers` or Gemini's `cachedContent`, in any letter case and with or without underscores: [The tool fields](../20-using/30-providers.md#the-tool-fields). A model id can bring tools of its own, which no body check sees, so a provider built from a preset, or pointed at a preset's origin, refuses the ids its vendor documents as running tools by themselves: OpenAI's search models, which search the web before every answer, OpenRouter's `:online` models, which add a web search, and Groq's gpt-oss, which searches the web by itself, among others: [The model ids a preset refuses](../20-using/30-providers.md#the-model-ids-a-preset-refuses). `fromConfig` builds each provider a config defines from its preset or its protocol, through these refusals, and the CLI builds its providers through `fromConfig`: [`loadConfig` and `fromConfig`](../95-reference/30-library-api.md#loadconfig-and-fromconfig). A program that passes a preset's values to an adapter itself gets only the adapter's checks. The refusals of the body fields apply to every adapter today, and the reply check of `openaiCompatible` is the one that covers a tool a model id brings: a reply that shows a tool the server ran, Groq's `executed_tools` or a `url_citation` annotation, fails the call. That check runs after the server ran the tool. It keeps a review from being built on the tool's output, but what the tool sent has already left, and a search query can quote the diff. Groq reports `executed_tools` whatever the model does, while a `url_citation` appears only when the reply cites a source, so a search model that cites nothing can pass: choose a model that runs no tool. A finder's failure fails the review, and a voter's is recorded as a failed vote: [Failed votes](../20-using/50-lenses-and-policy.md#failed-votes). Two gaps remain. A model id no preset knows, or one reached through a gateway or a proxy at another origin, can still bring tools, and only a reply that reports them to `openaiCompatible` is caught: the `anthropic`, `gemini` and `ollama` readers do no such check. And `headers` are sent as given. A program that sets either breaks this control. No environment value, key, token or credential appears in any request: keys live in the adapters, and the core never reads the environment. The suite checks with fake providers that no environment value reaches a request, the CLI's key variables included.

### A key sent only to its own endpoint

Each shipped adapter sends its `apiKey` only in the header its `auth` names, `Authorization` by default and `x-goog-api-key` for `gemini`, and never in a URL, a body or another header. Three further rules keep the key from leaking:

- **A base URL may not carry credentials.** A user name or a password is a configuration error, and the key goes in `apiKey`.
- **No redirect is followed.** A redirect is an error, so the key header never reaches another endpoint.
- **Server text is redacted.** The key, the base URL's path and the values of the `headers` option, as written and trimmed, are replaced with `[redacted]` in any server text an error quotes. The `query` option is not redacted, so never put a key there: a `query` value equal to the key is refused.

The CLI reads its providers through the config layer of `loadConfig` and `fromConfig`, which keeps the same rule and starts from a named config being trusted: it chooses where each key goes, and a TS or JS config runs code, so in CI it must come from the base branch or from outside the pull request's checkout, its prompt files with it, never from the pull request under review: [Trust](../20-using/20-configuration.md#trust). Under that, a panel that the `QUORUM_VOTER_*` variables derive onto another origin than the finder's keeps no key, header, query parameter, body field or model of the finder's provider, so no fallback carries a key to another endpoint, or from `https` to `http`: [The voter's fallback](../20-using/20-configuration.md#the-voters-fallback). A preset's own key variable is read only at the preset's origin, which for `azure-openai`, whose preset has no base URL, is any `https` host ending in `.openai.azure.com`. An explicit `apiKeyEnv` or a literal `apiKey` follows a `QUORUM_<ROLE>_BASE_URL` override of its own provider, since that override changes the provider and is no fallback. [The keys](../95-reference/30-library-api.md#keys) has the order and the rest.

### Nothing read from the working directory

In CI, quorum runs inside the checkout of the pull request it reviews, a directory the attacker writes. Quorum looks for no config file there: it reads one only when `--config` or `QUORUM_CONFIG` names it, and never a `quorum.config.yaml`, a `quorum.yaml` or a `quorum.config.mts` it finds, since a file found in the checkout would be the attacker's. A YAML or JSON one could point a provider's `baseUrl` at the attacker's server while its `apiKeyEnv` names the job's real key, and a TS or JS one would run in the job. A Bun-compiled binary loads a `.env` and a `bunfig.toml` from its working directory by default: a `bunfig.toml` can `preload` code, which then runs with the job's secrets, and a `.env` can set any variable the environment leaves unset, such as the one that chooses the finder's endpoint, which would then receive its key. `bun run compile` turns both off, and a test holds the script to it. Bun itself, as `bun run start` or `bun ./src/cli/bin.ts`, reads both from the directory it runs in, before any of quorum's code runs. A planted `.env` can then set `QUORUM_CONFIG`, and so name a config of the pull request's. The binary reads no `.env`, nor does Node. So run the binary, or Node, in a checkout you do not control, never Bun.

### Strict single-object parsing

Every reply must hold exactly one JSON object, and quorum fails closed instead of guessing:

- A reply holding several different objects is refused: text echoed from the diff could pose as the answer. The same object twice, such as a fenced copy beside a prose copy, is accepted.
- A group that opens like a JSON object, `{` then `"` or the end of the reply, but never closes or does not parse, fails the reply: it is cut off or malformed, and an object quoted inside it or echoed beside it could be planted.
- An object that repeats a key is refused, since parsing keeps the last value and planted text that closes a string early could supply it.
- Text after the answer that reads like JSON syntax, a quote, a brace or a bracket, fails the reply: it is what the model's own continuation leaves when planted text closed a string and the object early. Plain prose after the answer, and code fence markers, are accepted.
- Closed reasoning blocks (`<think>`) are dropped in one linear pass, and an object that starts after a `<think>` that never closes is a draft, never read as the answer.
- A reply over 1,000,000 characters is refused before it is read, and one with more than 100 brace groups is refused as it is scanned, so a reply built to be expensive stays cheap.

The research reply must then be exactly `{ "findings": [...] }`: a missing array, or any other top-level key, fails the profile, so a malformed reply never reads as "no findings" (exit `3`). A finding that does not match the schema, or holds an object or array under a key the schema does not name, where swallowed findings would hide, is unreadable: a `finding-unreadable` gap. An unusable vote is a failed vote.

The trailing-syntax rule works only where the model's continuation is written: an endpoint that enforces JSON stops generating when the root object closes, so there a planted early close leaves nothing to refuse.

### Code-derived evidence and the quote check

A finding must cite a line of the new file inside one of the diff's hunks and, when the diff has per-file headers, one of its files, or it is dropped with its reason. What a voter receives about the code is then read from the diff by the harness, never taken from the finder: the `file` is the diff's own path when the diff has per-file headers, and the `evidence` is the diff's lines around the cited one, capped at 2,000 characters. The finder's `quote` is only compared with the evidence, which sets `quoteMatched`; it is never sent to a voter. The only text a model wrote that a voter reads is the finder's `summary` and `category`, capped at 500 and 80 characters, and, for a diff without per-file headers, the file name, capped at 260: each stripped of control, format and other invisible characters, and fenced as an unverified claim.

### Blind votes and arithmetic confidence

Each vote request is built only from the finding, the lens's instructions, the diff context and the profile's guidelines: no request carries another vote, so no voter sees another's verdict or reasoning. The suite checks it by structure: the vote requests of a review are the same, nonces aside, whatever the voters answer. A vote reply is `{ keep, reasoning }`, and the confidence is computed in code from the kept votes: a voter cannot raise a finding by sounding sure. [Lenses and policy](../20-using/50-lenses-and-policy.md#confidence) has the arithmetic.

### Fenced data and the notices

All the data a model reads, the diff, the claim, the evidence, the diff section and the guidelines, is in the user message, each block fenced with a random nonce it cannot predict. The system message names every block of the request by its exact tag, so a tag planted in the diff is never named, and ends with the notice that fenced content is data and that text asking to skip or approve is suspicious. This is friction, not a control: [Prompts](../20-using/60-prompts.md#fencing-is-friction-not-a-control). A provider built with `systemPrompt: 'inline'` sends that system text at the head of the same user message as the data, so the instructions lose the role that sets them apart from it.

### `maxFindings` and the concurrency limit

Only the first `maxFindings` findings a research reply lists, 50 by default, are read, and only those can reach the panel; the rest are counted in a `findings-capped` gap, so a reply built to flood the run costs bounded work. With the security profile and the default cap, a review of one diff makes at most 151 calls: one research call, and three votes for each of 50 findings. `concurrency`, 4 by default, caps the calls in flight across every profile of the review. The size of what each call carries is bounded too: [The size guard](#the-size-guard).

### The size guard

A model that reads less than the whole diff can miss what an attacker put in the part it did not read, and quorum cannot see what a model read. So it bounds what it sends, and refuses what may not fit:

- **The diff is read to 16 MiB and no further.** A larger one is refused before any request, with exit `2`.
- **Every request is bounded before it is sent**, the research request and each vote alike. One token per UTF-8 byte of its text, each code point at its longest form (as it is, decomposed, or compatibility-decomposed), plus 512 tokens for the chat template and the reply budget, `maxTokens` else 16000, must fit the `contextTokens` that the provider states for its model. Every HTTP provider must state one, and a provider without one is a configuration error, exit `2`. What the bound costs, and how to raise it knowingly: [The context size](../20-using/20-configuration.md#the-context-size).
- **A request over the bound is a gap, and no flag lifts it for a gating profile.** Nothing is sent. The review records a `request-too-large` gap and keeps what it can still review, and the CLI exits `4` for a gating profile even with `--allow-incomplete`; a kept `high` finding of a gating profile still exits `1`.

The flag stays out of reach because of the padding attack. A pull request that pads its diff, or one file of it, until a request is refused needs no persuasion of any model, and a flag that waved the gap through would let the padding push a finding out of the reviewed text. `--allow-incomplete` lifts every other gap, including gaps a pull request can cause: decoy findings that push a real one past `maxFindings`, or text that trips a hosted voter's content filter. On a gating profile, do not use it for a pull request you do not trust. This is also why no ratio of bytes to tokens is offered: encoded content takes 1 to 1.5 bytes per token, so any ratio above one lets the padding past.

### Unreviewed and incomplete reviews

A discard never rests on a failed vote: a finding that a failed vote could still have kept is `unreviewed`. A finding the harness could not read, a kept finding whose failed votes could have raised it to a higher level, a research reply whose findings were all unusable, findings beyond the cap, and a request its provider refused as too large for its model are recorded in `meta.incomplete`. Either makes the review incomplete, so the CLI never exits `0` for a gap of a gating profile that the harness detects: it exits `4`, or `1` when a gating profile also kept a `high` finding. Two choices lift the `4` to `0`: a profile with `gating: false` in the config, and `--allow-incomplete` in the command, which lifts every gap but a `request-too-large` gap of a gating profile: a pull request can cause that one by padding the diff until a request is refused, so no flag lifts it. The flag lifts the others even where a pull request caused them (decoy findings that push a real one past `maxFindings`, or text that trips a hosted voter's content filter), so on a gating profile do not use it for a pull request you do not trust. The gap stays in the result either way.

### Advisory flags

The harness reads the added lines and the file names of the diff by code, before any model sees them, and flags hidden characters and text addressed to an AI reviewer. A flag appears in `meta.flags`, in a `flag` event and in a `flag:` line on stderr, and it is never a gate: it changes no verdict, gap or exit code. It tells a human where to look, and it is not a defense: [Advisory flags](./30-output-handling.md#advisory-flags).

### Inert output

The CLI writes nothing that a terminal or a GitHub Actions runner would act on, and shows or escapes every hidden character of the class in the text it carries. Every line of stderr that carries text from outside the CLI passes through `inertLine`, which shows each hidden character as `<U+XXXX>` and breaks the forms of a GitHub Actions workflow command, and stdout is written by `inertJson`, which escapes them and parses back to the same data. [What the CLI writes](./30-output-handling.md#what-the-cli-writes) has the details and the limits.

## What the harness cannot detect

Quorum cannot tell what a model read: it checks what the model answered, never what it saw of the prompt. An endpoint that truncates an oversized prompt answers all the same. Ollama's `/v1`, the CLI's default endpoint, cuts a prompt past the model's context length and still returns HTTP 200, so a review of what was left can come back clean, with exit `0`. So quorum refuses to send what may not fit, by [the size guard](#the-size-guard), a bound that holds for the open tokenizers checked. What the guard cannot know remains:

- **A `contextTokens` above the server's real window.** Quorum trusts the number it is given and reads it from nowhere else. Ollama's `/v1` cannot be told its context, so a server that loaded less than you stated cuts a prompt in silence. LM Studio loads less than its maximum, and an Azure deployment can differ from its model's documentation. State the window the server really gives: [Finding the number](../20-using/20-configuration.md#finding-the-number).
- **A tokenizer that takes more than one token per byte.** The bound holds for the byte-level BPE and byte-fallback SentencePiece tokenizers checked, and for one that normalizes with NFC, NFKC, NFD or NFKD first, since each code point counts at its longest form. It is not proven for a closed tokenizer (Claude, Gemini, Grok). Of the hosted vendors, Anthropic, Gemini and OpenAI refuse an oversized prompt with an error, and xAI's behaviour is not known. That refusal does less than the guard: on research it ends the run with exit `3`, and on a vote it is a failed vote, whose gap `--allow-incomplete` lifts. A tokenizer that folds case is not covered either, which no chat model's is known to do.
- **A server that adds more than 512 tokens around the messages**, such as the `TEMPLATE` or `SYSTEM` text of an Ollama Modelfile.
- **Text that `extraBody` adds** to a request, which the guard does not count, and a server-side switch that truncates the prompt, such as vLLM's `truncate_prompt_tokens` or OpenRouter's `transforms`, which the guard cannot see. The config is trusted, so quorum documents them and does not refuse them.
- **A provider object**, which checks its own requests: the guard lives in the shipped adapters.
- **A reply that outruns its reserve.** A server that shifts its context as the reply is written, such as Ollama's `/v1` or LM Studio's rolling window, can drop the start of a prompt to make room for a reply that runs past the 16000 tokens the guard keeps when `maxTokens` is unset; a `maxTokens` that is set, the server enforces. A thinking model's reasoning counts against that reserve, and a long or hard diff lengthens it, so no persuasion is needed. The `ollama` preset closes it: it sends `shift: false`, so a reply that fills the context stops as a truncation, and the quick start uses it.

Beyond the guard, a job that reviews untrusted changes can bound the diff further before piping it in.

## Independence

Voters are blind to each other, so their reasoning is independent. Their errors are not statistically independent: one study put nine judges from seven model families at about 2.2 effective votes, and prompt, ordering or temperature variants did not help, so three lenses on one model are probably worth one or two votes. Blind voting is still right: voting captures most of the gain of debate, and avoids sycophancy between agents.

- **A provider per lens is variance reduction, not a security measure.** Mixed model families helped in older studies, and nothing shows they stop a tuned attack.
- **Voting filters false positives only.** Recall rests on the finder, which reads the same poisoned diff, so the finder is a single point of failure for suppression: the panel cannot judge a finding that was never proposed.

## Model-written text is untrusted

A result carries text that models wrote, servers sent or the diff holds. Quorum stores it as it came, apart from some cleaning, and makes its own output inert. [Output handling](./30-output-handling.md#text-an-attacker-can-influence) has the fields, the cleaning and what a renderer must do.

## Next

[Output handling](./30-output-handling.md) — what the CLI writes and how it is made inert, the advisory flags, and printing a review yourself.
