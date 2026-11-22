# Local models

Quorum reviews against a server on your own machine through the same wire protocols as against a hosted API. A local server needs three things right: the window it gives a request, who can reach it, and, for a thinking model, how much of that window the reasoning takes. This page covers Ollama, vLLM and llama.cpp, then what to look for in a model and what reasoning mode does to a request.

One rule holds for all three: `contextTokens` must be at most the window the server gives **one request**. Quorum checks every request against the number you state and reads it from nowhere else, so a number above the real window lets a server that cuts a prompt in silence answer as if it had read all of it: [The context size](../20-using/20-configuration.md#the-context-size). [Finding the number](../20-using/20-configuration.md#finding-the-number) says where each server shows its window; this page says how to set it on the server, so that the number is true. What it says about each server was read from the server's source, at Ollama 0.40.16, vLLM 0.32.0 and llama.cpp's server at build b12177, and no server was run for it: check a flag against your version's `--help`.

## Ollama

Ollama is the CLI's default. With no provider configured and no base URL, preset or protocol variable, both roles talk to the Ollama on this machine through its native API, at `http://localhost:11434` ([Layering](../20-using/20-configuration.md#layering)), so two variables are all a run needs, once the model is pulled with `ollama pull <model>`:

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_RESEARCH_CONTEXT_TOKENS=32768
```

- **Keep `contextTokens` at most what `ollama show <model>` prints.** Quorum sends it as `num_ctx`, which sets the context for the request and replaces the one Ollama would choose by the GPU's memory. A value above the model's trained context is clamped to it, with a log line, and `ollama show` prints that trained context, not what a server loaded. Run `ollama ps` while a review runs and read the `CONTEXT` column: it is the context the model loaded.
- **Use one context size for the roles that share a model.** A request whose `num_ctx` differs from the loaded model's reloads the model, so a finder and a panel on one model with two sizes make Ollama load it again between calls. A panel on another model states its own size, as [The voter's fallback](../20-using/20-configuration.md#the-voters-fallback) says.
- **`OLLAMA_NUM_PARALLEL` multiplies the memory.** It defaults to 1. With N, Ollama loads `num_ctx` times N, so each request in parallel keeps the whole `num_ctx` and `contextTokens` stays true, and the memory grows with the product.
- **The native API needs Ollama 0.12.6 or later** to refuse a prompt past the context. An older server ignores `truncate: false` and `shift: false` and cuts the prompt in silence: [`ollama`](../20-using/30-providers.md#ollama).
- **The local API takes no key.** Ollama listens on `127.0.0.1:11434` (`OLLAMA_HOST` changes it) and asks for nothing, and its `OLLAMA_API_KEY` is the key of the hosted `ollama.com` API, which the `ollama-cloud` preset reads. An Ollama that another machine reaches sits behind a reverse proxy that adds a key. A base URL alone means `openai-compatible`, so name the protocol with the address, as [The environment variables](../20-using/20-configuration.md#the-environment-variables) says:

```bash
export QUORUM_RESEARCH_PROTOCOL=ollama
export QUORUM_RESEARCH_BASE_URL=https://ollama.corp.example
export QUORUM_RESEARCH_API_KEY="$OLLAMA_PROXY_KEY"
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_RESEARCH_CONTEXT_TOKENS=32768
```

Quorum sends the key as `Authorization: Bearer <key>`. A proxy that reads another header takes `auth` in a config file: [The key header](../20-using/30-providers.md#the-key-header).

## vLLM

```bash
vllm serve Qwen/Qwen3-32B --host 127.0.0.1 --max-model-len 32768
```

```yaml
version: 1
providers:
  local:
    preset: vllm
    model: Qwen/Qwen3-32B
    contextTokens: 32768
```

The `vllm` preset points at `http://localhost:8000/v1`. A config file is read when `--config` or `QUORUM_CONFIG` names it: [Naming the file](../20-using/20-configuration.md#naming-the-file).

- **Set `--host 127.0.0.1`.** vLLM binds every interface by default, on port 8000, where Ollama and llama-server bind the loopback.
- **`--max-model-len` is the window**, and `contextTokens` is that number. Left unset it is the model's own configured length, and `auto` is the length that fits the GPU's memory: in both cases `GET /v1/models` shows it as `max_model_len`. It is the window of one request and is not divided between requests running together. vLLM refuses to start with a `--max-model-len` above the length the model's own configuration gives, unless `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1`, which its message warns can give NaNs or out-of-bounds errors: keep the number at or below the model's.
- **A prompt past the window is a 400**, `This model's maximum context length is ... tokens`, and is never cut.
- **Never set `truncate_prompt_tokens`.** A request that sends it has its prompt cut. Quorum does not refuse it in `extraBody`, since the config is trusted, and its size guard cannot see the cut: the [threat model](../30-security/10-threat-model.md#what-the-harness-cannot-detect) lists it among what the harness cannot detect.
- **`--api-key`, or `VLLM_API_KEY`, guards only the paths under `/v1`, `/v2`, `/inference` and `/cohere`**, and vLLM's own help says not to rely on it alone, so keep `--host 127.0.0.1` or put a proxy in front. Quorum sends the key as `Authorization: Bearer <key>`:

```yaml
version: 1
providers:
  local:
    preset: vllm
    model: Qwen/Qwen3-32B
    contextTokens: 32768
    apiKeyEnv: VLLM_API_KEY
```

`apiKeyEnv` names the variable that holds the key, and quorum reads it when it loads the config.

## llama.cpp

```bash
llama-server -m ./Qwen3-32B-Q4_K_M.gguf --alias qwen3-32b -c 65536 -np 2
```

```yaml
version: 1
providers:
  local:
    preset: llamacpp
    model: qwen3-32b
    contextTokens: 32768
```

The `llamacpp` preset points at `http://127.0.0.1:9931/v1`, where `llama-server` listens. A build older than b11800 listens on 8080 instead: set `baseUrl: http://127.0.0.1:8080/v1` beside the preset. `model` is the id that `GET /v1/models` lists for the loaded file: the first `--alias`, else the model's own name, else the file name.

- **Always set `-c`**, also written `--ctx-size`. Its default, 0, is the model's trained context, which `--fit` may lower to as little as 4096, and a request past that is refused by the server. An explicit `-c` is never lowered.
- **Set `-np` too, and make `-c` a multiple of it.** Left at auto, `-np` gives 4 slots sharing one cache, where one request may use all of `-c` and requests running together share it. With an explicit `-np N`, and no `--kv-unified`, each slot gets `-c / N`, so `-c` is the number of slots times the number you state: `-c 65536 -np 2` gives each request 32768. State the per-slot value, which is `default_generation_settings.n_ctx` in `/props`, and `/slots` shows it too. A slot never gets more than the model's trained context either, whatever `-c / N` gives.
- **A prompt past its slot is a 400**, `exceed_context_size_error`, and is never cut, whatever `--context-shift` says.
- **Leave `--context-shift` off**, its default (`LLAMA_ARG_CONTEXT_SHIFT` sets it too). On, a reply that fills its slot makes llama-server drop the start of the prompt and keep writing, and the reply still ends as an ordinary stop, so nothing shows that the model lost part of the diff. Every adapter already sends a reply limit, which the guard keeps room for: the request's reply budget, a quarter of the window at most, or 16000 tokens for a request that carries none, and never more than `maxTokens` when that is set ([The reply's limit](../20-using/30-providers.md#the-replys-limit)). Set `maxTokens` to at most the room the model's slot leaves, so the reply stops before the slot is full.
- **`--api-key`, `LLAMA_API_KEY` or `--api-key-file` sets the key**, which the server reads from `Authorization` or `X-Api-Key`. Quorum sends `Authorization: Bearer <key>`. `llama-server` listens on the loopback by default.

## How many calls at once

A local server sends no rate-limit headers, so the lane of its provider stays at its start of 4 calls at once and never grows ([Lanes](../20-using/30-providers.md#lanes)). What the server takes at once is its own setting, and quorum cannot read it from Ollama, which has no endpoint for it, so set `concurrency` to it:

- **Ollama**: set `concurrency` to `OLLAMA_NUM_PARALLEL`, 1 by default. A review that sends four calls to a server that runs one waits in its queue, and a call that waits long enough is cut by its deadline and tried again.
- **llama.cpp**: set `concurrency` to the `-np` you gave `llama-server`, the number of slots.

`concurrency` is one limit for the whole review, shared by every provider, so a review of a local research model and a hosted panel holds the hosted calls to it too. When a local server is behind two providers, a research and a voter entry of one Ollama under two keys, each key has a lane of 4 and the server is sent 8 calls at once: set `concurrency` to the server's parallel requests, which counts both. A provider object of a library program may state `slots`, the number of calls its server serves, in place of a review-wide limit: its lane then starts and stays there, and the other providers keep their own lanes: [What a provider states](../20-using/30-providers.md#what-a-provider-states).

## Long replies and a loading model

- **A reverse proxy in front of a server cuts a reply it sees no byte of** within its idle limit, whatever quorum's deadline is: nginx's `proxy_read_timeout` is 60 s by default. A stream keeps a slow local reply alive: `ollama` streams its reply as NDJSON, a line for each piece the model writes, and an `openaiCompatible` server such as vLLM or llama.cpp streams server-sent events, so the proxy sees bytes all the while. The proxy must pass them unbuffered, as [What a gateway must pass](../20-using/30-providers.md#what-a-gateway-must-pass) says, and a server behind one that buffers still needs its idle limit raised. A server that cannot stream is set to `stream: false`: [Streaming](../20-using/30-providers.md#streaming). For a thinking model, which can send nothing for minutes before its first token, raise the limit above the deadline, 600000 ms or more by the reply budget, unless the provider states one: [The deadline of an attempt](../20-using/30-providers.md#the-deadline-of-an-attempt).
- **A slow model that streams needs no `timeoutMs`.** The deadline is 600000 ms an attempt at the default reply budget, more for a larger one, but it grows while the stream progresses, down to 2 tokens a second, so a model that streams slower than the derived deadline assumes is not cut while it streams: [The deadline of an attempt](../20-using/30-providers.md#the-deadline-of-an-attempt). Set `timeoutMs` only for a model that does not stream, for one slower than 2 tokens a second, or to pin a fixed ceiling at the summary's `slowest stream grew its deadline to <d>`, knowing that it turns the growth off, since a timeout is tried again once and the retry's tokens are spent again. Set it on the provider, or with `QUORUM_RESEARCH_TIMEOUT_MS` and `QUORUM_VOTER_TIMEOUT_MS`: [What a provider states](../20-using/30-providers.md#what-a-provider-states). The whole review ends at `reviewTimeoutMs`, 30 minutes by default, whatever `timeoutMs` says, so raise it too for a long run: [The review's deadline](../20-using/20-configuration.md#the-reviews-deadline).
- **A server answers 503 while it loads a model**: llama.cpp until the model is ready, and Ollama when its queue is full. A call that fails in passing is tried again, twice by default, but the two retries wait seconds where a load takes minutes, so start a review once the server answers: [What is retried](../20-using/30-providers.md#what-is-retried).

## A window too small

A small window is refused when quorum starts, before any call, with exit `2`, once the fixed text of a request, the chat template and the reply's budget leave no room for 1,024 tokens of diff, the least a hunk may need. It reads as:

```text
Error: profiles.security: the research request on local leaves -630 tokens for the diff, less than the 1024 a hunk may need: contextTokens 2000 counts 1618 for the instructions, guidelines and rules, 512 for the chat template and 500 for the reply: shorten the guidelines or rules, lower maxTokens, or state a larger window
```

The figures add up to `contextTokens`, so the message says what to change: a model that really loads a larger window needs it stated ([Finding the number](../20-using/20-configuration.md#finding-the-number)); a `maxTokens` that is larger than the replies need takes room from the diff, so lower it; and a long guideline or rule takes room of its own. A voter's window is checked the same way, for the vote of the longest finding, which carries more fixed text than a research request: on the default budgets that is about 4,000 tokens, so a voter needs a window of about 8,192 tokens to leave 1,600. [Room accounting](../20-using/20-configuration.md#room-accounting) has the rule, and `--print-config` prints each provider's rooms once a window passes.

## Choosing a model

- **One that follows a JSON Schema.** All three servers constrain a reply by constrained decoding: Ollama through `format`, vLLM and llama-server through `response_format`. The `ollama`, `vllm` and `llamacpp` presets ask for a JSON object, `structuredOutput: json`, with the schema in the system message, and `structuredOutput: schema` has the server enforce the schema itself: [Structured output](../20-using/30-providers.md#structured-output). A reply quorum cannot read is never read as clean. An unreadable finding is a `finding-unreadable` gap and an unusable vote is a failed vote, either of which can make a gating profile exit `4`, and a research reply that is no usable object at all is a `research-failed` gap of its part, which makes a gating profile exit `4`.
- **A window that holds your largest hunk.** The guard counts one token per byte and keeps the reply's budget, so a window takes far less diff than its size suggests: 22,446 bytes at 32768 tokens, 107,918 at 131072, for ASCII text and a profile with no guidelines. A small window works with no `maxTokens`: quorum gives a reply at most a quarter of the window and asks for as many findings as that holds, so 8192 tokens leave 4,014 bytes of diff for each request and 16384 leave 10,158, where a reply of 16000 tokens refused both ([Reply budgets](../20-using/20-configuration.md#reply-budgets)). A larger diff is reviewed in parts, more calls on a smaller window ([Research in parts](../20-using/20-configuration.md#research-in-parts)), and only a hunk that no request of the window holds is left unreviewed. [What it counts, and what it costs](../20-using/20-configuration.md#what-it-counts-and-what-it-costs) has the table, and [Raising the limit knowingly](../20-using/20-configuration.md#raising-the-limit-knowingly) the ways to take more.
- **A voter from another family than the finder's.** Mixed model families helped in older studies, but one study put nine judges from seven families at about 2.2 effective votes, so blind voting is not independence, and a provider per lens is variance reduction, not a security measure ([Independence](../30-security/10-threat-model.md#independence)). On one Ollama, a panel of another model needs its model and its window:

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_RESEARCH_CONTEXT_TOKENS=32768
export QUORUM_VOTER_MODEL=gemma3:27b
export QUORUM_VOTER_CONTEXT_TOKENS=32768
```

## Reasoning mode

A thinking model writes its reasoning before the answer, and the reasoning counts against the reply's token limit, so against the context, on all three servers. Every adapter sends the reply's budget as the server's limit, which includes the thinking: 8192 tokens of it are left in a research reply's budget, and `maxTokens`, when set, is the ceiling ([Reply budgets](../20-using/20-configuration.md#reply-budgets), [The reply's limit](../20-using/30-providers.md#the-replys-limit)), so the server stops a reply there: a model that reasons long is cut before its answer. A server that shifts its context as the reply is written (llama.cpp's `--context-shift`, Ollama's `/v1`) drops the start of the prompt and keeps writing. A reply cut off before its answer is a failed call, not a shorter review ([Raising the limit knowingly](../20-using/20-configuration.md#raising-the-limit-knowingly)). So for a thinking model either turn thinking off, or raise `maxTokens` and `contextTokens` together. Quorum reads the answer, `message.content`, and never the reasoning field.

**When the answer lands in the reasoning field**, as it does on a server that parses reasoning but leaves `content` empty, or one that mishandles JSON mode, the reply has no answer quorum can read, and it says so, once per provider, naming the cause and the fix and quoting nothing of the reply:

- `<provider>: reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt`. The reply held reasoning (`message.reasoning`, `message.reasoning_content`, `message.thinking`, a `thinking` part, or a reasoning token count) and no text. Turn thinking off with the table below, or send the schema in the prompt with `structuredOutput: prompt`.
- `<provider>: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt`. The reply ended on its own with nothing in it, as some gateways answer a JSON mode they do not support. `structuredOutput: prompt` asks for the JSON in the prompt instead.
- `<provider>: a reply was cut off at <o> tokens, below the <l> quorum asked for: the server caps replies near <o>: set maxTokens: <o>`. The server caps a reply lower than `maxTokens`, so a reasoning model is cut before its answer: set `maxTokens` to the number it names, and turn thinking off so the answer fits in it.
- `<provider>: a reply ended at the server's window ...: set contextTokens to at most <n>`. The server loaded a smaller window than `contextTokens` says.

A reply with no answer is a failed call, never a clean review: a research part is a `research-failed` gap, a vote a failed vote. Three of them in a row from one provider find it down (`<provider>: 3 calls in a row had no answer, only reasoning: ...`), and it is called no more in the review: [What a reply lacked](../20-using/30-providers.md#what-a-reply-lacked).

**Quorum acts on the first two by itself.** With `thinking` and `structuredOutput` unset, a reply that held only reasoning, or ran out of room while reasoning, lowers the provider's thinking once for the rest of the review (to `off` on Ollama and under the `vllm` and `llamacpp` presets, to `low` elsewhere), and a reply in JSON mode that came back empty, or a server that answers a 400 naming `response_format` (`format` on Ollama), moves it to prompt mode once that mode answers: each with one line saying so, and each asked again, so the review goes on. A server that refuses the lowered value, a template that raises on `none`, keeps its own level, with a line. [What quorum adapts by itself](../20-using/20-configuration.md#what-quorum-adapts-by-itself) has the rules. Set `thinking` or `structuredOutput` to choose them yourself, and nothing moves.

To turn thinking off, set `thinking: off` on the provider, or `QUORUM_RESEARCH_THINKING=off` for the finder and `QUORUM_VOTER_THINKING=off` for the panel. Quorum sends the control each protocol documents, so no server needs its own field written:

| Server | `thinking: off` sends | Where the reasoning goes |
| --- | --- | --- |
| Ollama | `think: false` | `message.thinking` |
| vLLM | `reasoning_effort: "none"` | `message.reasoning` with `--reasoning-parser`, else `content` |
| llama.cpp | `reasoning_effort: "none"` | `message.reasoning_content`, unless `--reasoning-format none` leaves it in `content` |

```yaml
version: 1
providers:
  local:
    preset: ollama
    model: qwen3.6:27b
    contextTokens: 32768
    thinking: off
```

`thinking: low` asks for less thinking instead of none: `think: "low"` on Ollama, `reasoning_effort: "low"` on vLLM and llama.cpp. A model whose chat template does not declare the value may keep thinking, or a server answer 400 to it: [Thinking](../20-using/30-providers.md#thinking). The table's fields are the protocol's own. A server whose template reads a field of its own takes it in `extraBody`, which needs a config file, as does `maxTokens`. `thinking` and the same control in `extraBody` are refused as two settings for one control, so use `extraBody` for the vendor's field alone.

On vLLM, and the same under `preset: llamacpp` on llama.cpp, a template that reads `enable_thinking`:

```yaml
version: 1
providers:
  local:
    preset: vllm
    model: Qwen/Qwen3-32B
    contextTokens: 32768
    extraBody:
      chat_template_kwargs:
        enable_thinking: false
```

- **`think` takes a boolean or a level**, `low`, `medium` or `high`, and `thinking` sends the two quorum needs, `"low"` and `false`. Unset, a thinking model thinks as it does by default.
- **`enable_thinking` and `reasoning_effort` are for the chat templates that declare them.** A model whose template does not may keep thinking.
- **Without `--reasoning-parser`, vLLM leaves the reasoning in `content`** and constrains the reply from its first token, so a thinking model cannot think. To let it think, start vLLM with `--reasoning-parser`, which takes the parser of the model's family, `qwen3` for a Qwen3 model: the reasoning then goes to `message.reasoning` and the constraint starts after it.
- **llama.cpp bounds the reasoning with `--reasoning-budget N`**, and its `--reasoning off` turns it off for every request.

A model that thinks, with room for it:

```bash
vllm serve Qwen/Qwen3-32B --host 127.0.0.1 --max-model-len 32768 --reasoning-parser qwen3
```

```yaml
version: 1
providers:
  local:
    preset: vllm
    model: Qwen/Qwen3-32B
    contextTokens: 32768
    maxTokens: 24000
```

Each token of `maxTokens` takes a byte of diff off what the window holds: the largest diff is `contextTokens` less 2,130 less the reply budget, so this leaves 6,638 bytes of the 22,446 that 32768 tokens hold with the budgets quorum derives, for ASCII text and a profile with no guidelines, as the configuration page's table counts them. A thinking model on this window reviews small diffs, and a larger one needs a model configured for a larger window.

## Next

[Glossary](../95-reference/10-glossary.md) — the words these pages use in one particular way, and the acronyms they assume.
