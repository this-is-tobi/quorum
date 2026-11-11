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
llama-server -m ./Qwen3-32B-Q4_K_M.gguf -c 65536 -np 2
```

```yaml
version: 1
providers:
  local:
    preset: llamacpp
    model: qwen3-32b
    contextTokens: 32768
```

The `llamacpp` preset points at `http://127.0.0.1:9931/v1`, where `llama-server` listens. A build older than b11800 listens on 8080 instead: set `baseUrl: http://127.0.0.1:8080/v1` beside the preset. `model` is the id that `GET /v1/models` lists for the loaded file.

- **Always set `-c`**, also written `--ctx-size`. Its default, 0, is the model's trained context, which `--fit` may lower to as little as 4096, and a request past that is refused by the server. An explicit `-c` is never lowered.
- **Set `-np` too, and make `-c` a multiple of it.** Left at auto, `-np` gives 4 slots sharing one cache, where one request may use all of `-c` and requests running together share it. With an explicit `-np N`, and no `--kv-unified`, each slot gets `-c / N`, so `-c` is the number of slots times the number you state: `-c 65536 -np 2` gives each request 32768. State the per-slot value, which is `default_generation_settings.n_ctx` in `/props`, and `/slots` shows it too. A slot never gets more than the model's trained context either, whatever `-c / N` gives.
- **A prompt past its slot is a 400**, `exceed_context_size_error`, and is never cut, whatever `--context-shift` says.
- **`--api-key`, `LLAMA_API_KEY` or `--api-key-file` sets the key**, which the server reads from `Authorization` or `X-Api-Key`. Quorum sends `Authorization: Bearer <key>`. `llama-server` listens on the loopback by default.

## Choosing a model

- **One that follows a JSON Schema.** All three servers constrain a reply by constrained decoding: Ollama through `format`, vLLM and llama-server through `response_format`. The `ollama`, `vllm` and `llamacpp` presets ask for a JSON object, `structuredOutput: json`, with the schema in the system message, and `structuredOutput: schema` has the server enforce the schema itself: [Structured output](../20-using/30-providers.md#structured-output). A reply quorum cannot read is never read as clean. An unreadable finding is a `finding-unreadable` gap and an unusable vote is a failed vote, either of which can make a gating profile exit `4`, and a research reply that is no usable object at all ends the run with exit `3`.
- **A window that holds your diffs.** The guard counts one token per byte and keeps 16000 tokens for the reply, so a window takes far less diff than its size suggests: 14,757 bytes at 32768 tokens, 113,061 at 131072. [What it counts, and what it costs](../20-using/20-configuration.md#what-it-counts-and-what-it-costs) has the table, and [Raising the limit knowingly](../20-using/20-configuration.md#raising-the-limit-knowingly) the ways to take more.
- **A voter from another family than the finder's.** Mixed model families helped in older studies, but one study put nine judges from seven families at about 2.2 effective votes, so blind voting is not independence, and a provider per lens is variance reduction, not a security measure ([Independence](../30-security/10-threat-model.md#independence)). On one Ollama, a panel of another model needs its model and its window:

```bash
export QUORUM_RESEARCH_MODEL=qwen3.6:27b
export QUORUM_RESEARCH_CONTEXT_TOKENS=32768
export QUORUM_VOTER_MODEL=gemma3:27b
export QUORUM_VOTER_CONTEXT_TOKENS=32768
```

## Reasoning mode

A thinking model writes its reasoning before the answer, and the reasoning counts against the reply's token limit, so against the context, on all three servers. With `maxTokens` set, the server stops the reply there. Unset, the adapters of these three servers send no limit, and the 16000 tokens are room that quorum's size guard keeps, not a cap ([The size of a request](../20-using/30-providers.md#the-size-of-a-request)): a model that reasons on runs until the window is full, where the server stops it. Either way, a reply cut off before its answer is a failed call, not a shorter review ([Raising the limit knowingly](../20-using/20-configuration.md#raising-the-limit-knowingly)). So for a thinking model either turn thinking off, or raise `maxTokens` and `contextTokens` together. Quorum reads the answer, `message.content`, and never the reasoning field.

`extraBody` and `maxTokens` need a config file. To turn thinking off:

| Server | Turn thinking off | Where the reasoning goes |
| --- | --- | --- |
| Ollama | `extraBody: { think: false }` | `message.thinking` |
| vLLM | `extraBody: { chat_template_kwargs: { enable_thinking: false } }`, or `extraBody: { reasoning_effort: "none" }` | `message.reasoning` with `--reasoning-parser`, else `content` |
| llama.cpp | The same two `extraBody` fields, or `--reasoning off` on the server | `message.reasoning_content`, unless `--reasoning-format none` leaves it in `content` |

On Ollama:

```yaml
version: 1
providers:
  local:
    preset: ollama
    model: qwen3.6:27b
    contextTokens: 32768
    extraBody:
      think: false
```

On vLLM, and the same under `preset: llamacpp` on llama.cpp:

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

- **`think` takes a boolean or a level**, `low`, `medium` or `high`. Unset, a thinking model thinks as it does by default, and `think: true` on a model that cannot think is a 400.
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

Each token of `maxTokens` takes a byte of diff off what the window holds: the largest diff is `contextTokens` less 2,011 less the reply budget, so this leaves 6,757 bytes of the 14,757 that 32768 tokens hold with the default. A thinking model on this window reviews small diffs, and a larger one needs a model configured for a larger window.

## Next

[Glossary](../95-reference/10-glossary.md) — the words these pages use in one particular way, and the acronyms they assume.
