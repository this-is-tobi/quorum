# Glossary

The words these pages use in one particular way, and the acronyms they assume you know, each with the chapter that says the rest. A term here means the same thing on every page; when a page seems to use one differently, the page is wrong, not the glossary.

## Terms

- **claim** — the finder's account of a finding as a voter receives it: the file, the line, the category and the summary, fenced and introduced as unverified. It holds the only text a model wrote that a voter reads. [Prompts](../20-using/60-prompts.md#the-layout-of-a-request)
- **confidence** — the highest level, `high`, `medium` or `low`, whose threshold a finding's kept votes reach, computed in code by the policy. No model reports one: a vote has no confidence field. [Lenses and policy](../20-using/50-lenses-and-policy.md#confidence)
- **data notice** — the part of every system message that names each fenced block of the request by its exact tag, and says what it holds. The code writes it, not the profile. [Prompts](../20-using/60-prompts.md#the-data-notice)
- **discarded** — a verdict that reached no confidence level, and whose failed votes, had they been keeps, would not have reached one either. [Lenses and policy](../20-using/50-lenses-and-policy.md#failed-votes)
- **evidence** — the diff's lines around a finding's cited line, in its hunk, read from the diff by the harness and never taken from the finder. [The JSON result](./20-json-result.md#a-verdict)
- **fence** — the pair of tags around one block of data in the user message, `<untrusted-diff-1a2b3c4d>` and its closing tag, with a random nonce for each block of each request, so the data cannot close its own block. Friction, not a control. [Prompts](../20-using/60-prompts.md#fencing-is-friction-not-a-control)
- **finder** — the model that reads the diff in the research stage and proposes the findings, through the profile's research provider. [Start here](../01-readme.md#what-you-are-about-to-use)
- **finding** — a candidate issue the finder reports. The harness checks each one against the diff: a finding passes the check only when it cites a line inside a hunk and, when the diff has per-file headers, one of its files. A finding that passes has a file, a line, a category, a summary and its evidence, and goes to the panel unless it repeats an earlier one; the others are dropped with a reason, or recorded as gaps. [The JSON result](./20-json-result.md#a-verdict)
- **flag** — an advisory signal the harness reads from the diff by code, before any model sees it. It marks hidden characters, or text addressed to an AI reviewer, and tells a human where to look; it changes no verdict and no exit code. [Output handling](../30-security/30-output-handling.md#advisory-flags)
- **gating** — whether a profile's kept `high` findings set exit code `1`, and its gaps exit code `4`: true unless the profile says otherwise. [Profiles](../20-using/40-profiles.md#gating)
- **guidelines** — reference text a program loads and sets on a profile, fenced in every request of that profile and described to the model as criteria. [Profiles](../20-using/40-profiles.md#guidelines)
- **harness** — quorum's own code around the models: it reads the diff, builds every request, checks every reply and computes every verdict. [Architecture](./40-architecture.md#the-stages-of-a-review)
- **hidden character** — a character a reader cannot see or a terminal may act on. That covers the control and format characters, unpaired surrogates, the other default-ignorable code points, and the line and paragraph separators. [Output handling](../30-security/30-output-handling.md#what-the-cli-writes)
- **incomplete** — said of a review in which a finding is unreviewed, or `meta.incomplete` holds a gap. The CLI exits `4` for an incomplete review of a gating profile, unless a gating profile kept a `high` finding. [The JSON result](./20-json-result.md#incomplete-reasons)
- **inert** — said of text printed so that nothing in it acts on a terminal or a GitHub Actions log. Its hidden characters are shown as `<U+XXXX>` in a line, and escaped in JSON. [Output handling](../30-security/30-output-handling.md#what-the-cli-writes)
- **kept** — a verdict whose kept votes reach a confidence level. [Lenses and policy](../20-using/50-lenses-and-policy.md#confidence)
- **lens** — one angle of the panel: an id and the question its voter is asked. Each finding gets one vote per lens. [Lenses and policy](../20-using/50-lenses-and-policy.md#lenses)
- **panel** — the stage that sends every finding to every lens of the profile, one blind vote each, and computes its verdict. Also the voters themselves. [Lenses and policy](../20-using/50-lenses-and-policy.md)
- **policy** — a profile's rules for how many kept votes each confidence level needs: `unanimous`, `majority`, `any`, `off`, `{ minVotes }` or `{ minRatio }`. [Lenses and policy](../20-using/50-lenses-and-policy.md#policy-rules)
- **profile** — what a review looks for, as data: the research and vote instructions, the lenses, the policy, `gating` and optional guidelines. `security` is the default, and the CLI runs every profile its config selects. [Profiles](../20-using/40-profiles.md)
- **provider** — how quorum reaches a model: an object with an id, a model and a `complete` function that takes a request and returns the reply's text. [Providers](../20-using/30-providers.md)
- **quote** — the code the finder says a finding is about. It is only compared with the evidence, which sets `quoteMatched`, and is never sent to a voter. [The JSON result](./20-json-result.md#a-verdict)
- **research** — the first stage of a profile: one call to its research provider, whose reply lists the candidate findings. [Architecture](./40-architecture.md#the-stages-of-a-review)
- **sink** — two things, told apart by what surrounds them. The *event sink* is the function a program passes as `ports.events`, which receives every event of a review. In the security profile's instructions, *the sink* is the code a vulnerability ends in, which the finder quotes and the reachability lens asks about. [Library API](./30-library-api.md#events) · [Profiles](../20-using/40-profiles.md#the-security-profile)
- **stage** — one step of a profile's review: research, then dedup, which drops a finding that repeats the file, line and category of an earlier one, then panel. [Architecture](./40-architecture.md#the-stages-of-a-review)
- **threshold** — the number of kept votes a confidence level needs, once the policy is resolved for the profile's lens count; `null` for a level that is off. [Lenses and policy](../20-using/50-lenses-and-policy.md#policy-rules)
- **unreviewed** — a verdict that reached no confidence level while its failed votes, had they been keeps, would have reached one: neither kept nor cleared. It makes the review incomplete. [Lenses and policy](../20-using/50-lenses-and-policy.md#failed-votes)
- **verdict** — a finding once the panel has voted on it: its votes, the kept and total counts, and its confidence when it reached one. [The JSON result](./20-json-result.md#a-verdict)
- **vote** — one lens's judgment of one finding, `keep` and `reasoning`; or a failed vote, `null` with its error, which counts as a reject. [The JSON result](./20-json-result.md#a-vote)

## Acronyms

- **API** — application programming interface: the functions and types `src/index.ts` exports, and the HTTP interface of a model endpoint. [Library API](./30-library-api.md)
- **CI** — continuous integration: the jobs that run on each change, which gate on quorum's exit code. [The CLI](../20-using/10-cli.md#using-it-in-ci)
- **CLI** — command-line interface: `quorum` typed at a shell. [The CLI](../20-using/10-cli.md)
- **CWE** — Common Weakness Enumeration, the numbered weaknesses (`CWE-89`) the security profile asks the finder to name as a finding's category.
- **JSON** — JavaScript Object Notation: the format of the result on stdout and of every model reply quorum reads. [The JSON result](./20-json-result.md)
- **LLM** — large language model: the finder and the voters are LLMs, reached through providers. [Providers](../20-using/30-providers.md)
- **PR** — pull request: a proposed change, whose diff quorum reviews and whose author is the attacker of the threat model. [Threat model](../30-security/10-threat-model.md#the-attacker)
- **TTY** — a terminal. With no file argument and stdin a TTY, quorum prints its usage instead of waiting for a diff. [The CLI](../20-using/10-cli.md#the-invocation)
