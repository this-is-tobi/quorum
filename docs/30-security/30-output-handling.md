# Output handling

Quorum writes the JSON result on stdout, and `warning:` lines, a banner, progress lines and `Error:` lines on stderr. All of it can carry text that models wrote, servers sent or the diff holds, and an attacker can influence that text. Quorum stores it as it came, apart from the cleaning the table below lists, and makes each place that prints it inert: nothing in it acts on a terminal or a GitHub Actions log, and every hidden character of the class defined below is shown or escaped. It also flags the hidden characters and the text addressed to an AI reviewer that a diff holds, as a hint to a human. Read this page before you print a review yourself.

## Text an attacker can influence

A result carries text that models wrote while reading a change an attacker may have written, and text that the change itself holds:

| Field | Written by | Before it reaches the result |
| --- | --- | --- |
| `summary`, `category` | The finder | Stripped of control, format and other invisible characters, then capped |
| `votes[].vote.reasoning` | A voter | Nothing is done to it |
| `votes[].error`, and the CLI's `Error:` line | The provider, or the core when a reply is unusable | The server text or reply they quote is a JSON string, cut short; a provider of your own writes its messages as it likes |
| `file` | The pull request, which named the file | The diff's own path, which can hold any character a file name can; for a diff without per-file headers, the finder's name for it, cleaned |
| `evidence` | The pull request | The diff's lines around the cited one, as they are, hidden characters included, capped at 2,000 characters |

Apart from the cleaning in the table, the result stores this text as it came, and each place that prints it makes it inert.

## What the CLI writes

The CLI writes to two streams, and each has its own function. Both act on the same class of hidden characters: those a reader cannot see, or a terminal may act on. The class holds:

- the control characters (C0, DEL and C1), which covers every escape sequence and every line break;
- the format characters, among them the zero-width, bidirectional and tag characters;
- unpaired surrogates;
- the other default-ignorable code points, such as variation selectors and Hangul fillers;
- the line and paragraph separators.

The class leaves out what acts on no terminal and what no character property marks as invisible: the other spaces, which print as spaces; private-use and unassigned code points, which print as a glyph or a box; U+2800, which prints as a blank, and U+FFFC, which prints as a box; and look-alike letters, which no character property finds. U+2800 and look-alike letters can still hide text from a reader.

- **stdout** is the JSON result, written by `inertJson`. It is what `JSON.stringify` writes, with every hidden character it would leave raw written as a `\uXXXX` escape: DEL, the C1 controls, the format and other default-ignorable characters, and the line and paragraph separators. A `##[` inside a string is written `##\u005b`. A JSON parser reads the escapes back as the characters, so the data is exact. No line of it can start a workflow command: after its indentation, each line starts with a quote, a bracket, a brace or a literal, and none holds `##[`. With `--print-config`, stdout is the config's YAML instead, and each of its lines passes through `inertLine`, as the lines of stderr do: [Printing the resolved config](../20-using/10-cli.md#printing-the-resolved-config). The help and version text are constants, and the CLI writes them as they are.
- **stderr**: every line that carries text from outside the CLI passes through `inertLine`: the `warning:` lines, the banner, the progress lines and the `Error:` lines. The usage text and `empty diff: nothing to review` are constants, and the CLI writes them as they are. A hidden character is shown as `<U+XXXX>`, with its code point in upper-case hexadecimal, four digits at least, and a character above U+FFFF as one label. So a line holds no line break of its own and starts no escape sequence, and no character of the class reorders or hides its text. A line that would start with `::`, after any leading whitespace, shows its first colon as `<U+003A>`, and each `##[` shows its bracket as `<U+005B>`.
- **Errors**: a configuration error keeps one issue per line, each line inert. Any other error is one line, so a line break in a file name, or in text a server sent, cannot start a line of its own.

### An example

A server answers HTTP 500 with a body that holds a C1 control, a right-to-left override, an escape sequence and a line separator, and the diff adds a line to `a.js` that holds the override too. The CLI writes these two lines on stderr, the flag first, since the flags come before the research:

```text
flag: hidden-characters at "a.js":1 (U+202E on 1 added line(s))
Error: default: HTTP 500: "boom <U+009B>2J <U+202E> \u001b]8;;x\u0007 <U+2028> end"
```

The escape character and the bell arrive as `\u001b` and `\u0007` text, not as characters, because the snippet of the body is a JSON string: `JSON.stringify` has already escaped them. The three characters it leaves raw, U+009B, U+202E and U+2028, `inertLine` shows as labels.

### Why

**Terminals read some controls as commands.** GNOME Terminal (VTE), the VS Code terminal (xterm.js) and WezTerm read a UTF-8 C1 control such as U+009B as the start of an escape sequence. xterm, kitty, Alacritty, iTerm2 and Windows Terminal ignore it. An ESC-based sequence works everywhere. So `inertLine` shows every control, not the ones one terminal acts on.

**The GitHub Actions runner reads workflow commands in a log.** It reads them on stdout and stderr alike, in two forms. One is a line that starts with `::` once its leading whitespace is trimmed. The other is a legacy `##[command]`, which the runner finds anywhere in a line. A model or a diff could otherwise add an annotation, or mask text in the log: `##[add-mask]e` hides every later `e`. Quorum makes these two forms inert; it does not handle the logging commands of other CI systems, such as `##vso[` of Azure Pipelines and `##teamcity[` of TeamCity.

**The runner splits lines on LF and CR.** That is why a CR inside a text is shown too, as the other controls are.

## Advisory flags

The harness reads the diff by code, before any model sees it, and raises a flag for what a human should look at. A flag is a hint and never a gate.

### What they look for

| Code | Looks for |
| --- | --- |
| `hidden-characters` | A hidden character, as the class above defines it, in the name of a file or in an added line |
| `ai-addressed-text` | In an added line, text that speaks to an AI reviewer instead of a person |

The second code knows nine kinds of text, and a flag names each by these words:

- **a chat-template token**: the markup that chat models read as a turn or a tool call, such as the `<|...|>` tokens of ChatML, harmony and Llama 3, Llama's `[INST]` and `<<SYS>>`, Gemma's turn tags, Mistral's tool markers and DeepSeek's tokens in full-width bars;
- **a tool-call tag**: `<tool_call>`, `<tool_response>`, `<function_calls>`, `<function_results>` or `<invoke name=`;
- **a fence tag of quorum**: the tag quorum fences a block of data with, such as `<untrusted-diff-1a2b3c4d>`, or one of that name without a nonce or with a nonce of another shape, such as `</untrusted-diff>`. Nothing else writes one, so it is the strongest signal;
- **a forged vote reply**: a `keep` and a `reasoning`, in either order, written in the shape of a voter's reply;
- **a forged research reply**: an empty `findings` list written in the shape of the finder's reply;
- **an instruction to ignore earlier instructions**;
- **an instruction to approve the change**: to mark or treat it as safe, secure, correct or clean;
- **an instruction not to report it**: not to flag or report the change as a vulnerability, a security issue or a finding;
- **a note to an AI**: a note, message, memo or reminder addressed to an AI, an LLM or an automated reviewer.

Each kind is matched on one added line at a time, in two forms: with the line's hidden characters removed, and with them read as spaces. The first form finds a phrase with a hidden character inside a word, and the second a phrase with one between words. All nine kinds ignore letter case. A phrase split by zero-width characters still matches, and its line raises both flags. Looser phrasings, such as "you are a helpful assistant" or "do not report", are left out: they match ordinary code and docs, the usual sentence of a `SECURITY.md` file included.

### Where they look

Added lines and file names only. That leaves out removed and context lines, and the commit message of a `git format-patch` series.

A diff section whose `diff --git` header quorum cannot read raises no flag. Today that means a renamed file under git's `--no-prefix` or `diff.mnemonicPrefix` settings. The model still reads those lines.

### What a hidden-characters flag leaves alone

In an added line, a `hidden-characters` flag does not count:

- the tab;
- the line ends of a CRLF file: the diff reader drops the carriage return that ends a row, so one inside a line is still flagged;
- a byte-order mark that starts the first line of a file;
- the joiners, variation selectors and tag characters inside an emoji sequence of the Unicode RGI set. That covers sequences joined with a zero-width joiner, emoji presentation, keycaps, skin tones and the three subdivision flags. The exemption follows the Unicode data of the runtime, so an emoji newer than that data may be flagged on an older runtime.

Everything else in the class is flagged, a lone joiner and variation selectors stacked after an emoji, which can smuggle bytes, included. The name of a file has no exception.

### The shape

Quorum raises at most one flag per file, code and subject, so a file raises at most three, in this order: its name holds hidden characters, its added lines do, and its added lines address an AI reviewer. A flag about lines points at the first such line and counts them. Its `detail` names at most eight code points or patterns, then `and N more`. The code writes every word of a detail: the only text of the diff that a flag carries is `file`, the diff's own path, which is absent for a diff without per-file headers. [A flag](../95-reference/20-json-result.md#a-flag) lists the fields.

| Code | About | Example `detail` |
| --- | --- | --- |
| `hidden-characters` | The file name | `the file name holds U+202E` |
| `hidden-characters` | The added lines | `U+202E, U+200B on 3 added line(s)` |
| `ai-addressed-text` | The added lines | `a chat-template token, a tool-call tag on 2 added line(s)` |

### Where they appear

| Where | What it holds |
| --- | --- |
| `meta.flags` | Every flag, file by file in the diff's order: [A flag](../95-reference/20-json-result.md#a-flag) |
| A `flag` event | One per flag, right after `run:start` and before any stage: [Events](../95-reference/30-library-api.md#events) |
| A `flag:` line on stderr | One per flag, before the research starts: [Progress lines](../20-using/10-cli.md#progress-lines) |

### What they are not

- **They change nothing.** No verdict, gap or exit code reads a flag.
- **They are a hint, not a defense.** A phrase split across lines, written with look-alike letters, in another language or encoded is not matched. Neither is a phrase with a zero-width character both inside a word and between words, though its line still raises `hidden-characters`. The most effective attack in the research, comments that fabricate an analyzer's verdict, reads like an ordinary comment. [Residual risk](./10-threat-model.md#residual-risk) says what remains.
- **They flag some honest text.** Text in a script that uses joiners or direction marks, such as Persian or Hindi, raises a `hidden-characters` flag too.

## Printing a review yourself

`src/index.ts` exports both functions, for a program that prints a review:

| Function | Use it for | What it does |
| --- | --- | --- |
| `inertLine(text)` | A line of a terminal or a log | Shows every hidden character as `<U+XXXX>`, then breaks both forms of a GitHub Actions workflow command, as [above](#what-the-cli-writes) |
| `inertJson(value)` | The result, or another value, as JSON | Writes `JSON.stringify(value, null, 2)` with each hidden character as an escape, as [above](#what-the-cli-writes). It throws a `TypeError` for a value with no JSON form, such as `undefined` |

An event sink that prints the gaps of a review on stderr, and a function that prints the result on stdout:

```ts
import { inertJson, inertLine } from './src/index.ts'
import type { QuorumEvent, QuorumResult } from './src/index.ts'

function events(event: QuorumEvent): void {
  if (event.type === 'incomplete') console.error(inertLine(`incomplete: ${event.entry.reason} (${event.entry.detail})`))
}

function show(result: QuorumResult): void {
  console.log(inertJson(result))
}
```

Pass `events` as `ports.events` of `createQuorum`: [Library API](../95-reference/30-library-api.md#events) has the events.

- **Apply `inertLine` to the whole line you print**, never to its pieces apart. Two inert pieces printed side by side can still meet as `::` or `##[`.
- **`inertLine` shows each line break as its own label**: LF as `<U+000A>`, CR as `<U+000D>`, and U+0085, U+2028 and U+2029 as `<U+0085>`, `<U+2028>` and `<U+2029>`. So a text of several lines, such as a vote's `reasoning`, prints as one long line. To keep its lines, split the text on LF and CRLF and apply `inertLine` to each line: `text.split(/\r?\n/).map(line => inertLine(line)).join('\n')`. The other breaks stay as labels.
- **For Markdown, HTML or a pull request comment, escape for that format yourself.** Quorum has no Markdown renderer yet.
- **URLs stay as they are.** `inertLine` leaves them alone, and GitHub's log viewer makes a raw URL clickable. Never follow a link, a mention or a command found in the result.

## Next

[Local models](../90-recipes/10-local-models.md) — running quorum against Ollama, vLLM and llama.cpp: the window each gives a request, choosing a model, and reasoning mode.
