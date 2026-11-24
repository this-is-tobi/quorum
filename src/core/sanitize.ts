/**
 * Renders the text that models, servers and diffs wrote for the places a person reads it: a
 * terminal, a CI log, the JSON result, Markdown and the plain text a viewer may link. The text is
 * stored as it came, and each sink renders it inert (invariant I3): nothing in it acts on a
 * terminal or a GitHub Actions runner, and no character of the hidden class below hides from the
 * reader. `cleanProse` goes the other way: it removes three kinds of hidden text from what a person
 * wrote as policy, so that a model reads none of them.
 *
 * @see ../../docs/30-security/30-output-handling.md
 */

/**
 * The body of the hidden-character class, for a character class under the `u` flag: controls (C0,
 * DEL, C1), format characters, unpaired surrogate halves, other default-ignorable code points, and
 * line and paragraph separators. Every check for hidden characters in the product code and in the
 * docs test is built from it; the two spec oracles are not, on purpose, so that they stay
 * independent of the class they check.
 */
export const HIDDEN_CLASS = String.raw`\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}`

/** The hidden class, matched one character at a time over the whole text. */
const HIDDEN = new RegExp(`[${HIDDEN_CLASS}]`, 'gu')

/** `::` after any leading whitespace: how a GitHub Actions workflow command starts once the runner trims the line. */
const COMMAND_START = /^(\s*):(?=:)/u

/** `##[`: the runner's legacy command marker, which it reads anywhere in a line. */
const LEGACY_COMMAND = /##\[/g

/** `U+`, then the code point of the first character in upper-case hexadecimal, four digits at least. */
export function codePointLabel(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
}

/** The distinct labels of the hidden characters in `text`, in the order they first appear. */
export function hiddenLabels(text: string): string[] {
  const labels = new Set<string>()
  for (const [char] of text.matchAll(HIDDEN)) labels.add(codePointLabel(char))
  return [...labels]
}

/**
 * Remove the hidden characters in one pass. One pass is enough: every unpaired surrogate half is
 * removed in the same pass, so removing a character never leaves two halves to join into a new
 * one, and the characters that remain are whole.
 */
export function stripHidden(text: string): string {
  return text.replace(HIDDEN, '')
}

/** The text with each hidden character replaced by a space: what a reader sees when an invisible character separates two words. */
export function spaceHidden(text: string): string {
  return text.replace(HIDDEN, ' ')
}

/**
 * The text with each hidden character shown as `<U+XXXX>` and nothing else changed: for text that
 * reaches a model or a reader but is no line of a log, such as a file name cited in a prompt.
 * `inertLine` adds the workflow-command rules.
 */
export function showHidden(text: string): string {
  return text.replace(HIDDEN, char => `<${codePointLabel(char)}>`)
}

/**
 * One line of a terminal or a CI log. Every hidden character is shown as `<U+XXXX>`, so the line
 * holds no line break and starts no escape sequence, and no character of the class reorders or
 * hides its text. Strong right-to-left letters are outside the class, and can still reorder the
 * line under the bidi algorithm. Then both forms of a GitHub Actions workflow command are broken:
 * a line that starts with `::` once its leading whitespace is trimmed shows its first colon as
 * `<U+003A>`, and each `##[` shows its bracket as `<U+005B>`. Apply it to the whole line: two
 * inert pieces printed side by side can still meet as `::` or `##[`.
 */
export function inertLine(text: string): string {
  return showHidden(text)
    .replace(COMMAND_START, '$1<U+003A>')
    .replace(LEGACY_COMMAND, '##<U+005B>')
}

/** A run of backticks. */
const BACKTICK_RUN = /`+/g

/**
 * An `@` that no ASCII letter, digit or `_` precedes (`\B@`, `\w` being ASCII): where a viewer starts a mention. A viewer's
 * word boundary may be ASCII only, so an `@` after `é` or `你` starts a mention there and is broken.
 */
const MENTION_START = /\B@/g

/** A `#` before an ASCII digit: where a viewer starts an issue or pull request reference. */
const REFERENCE_START = /#(?=\d)/g

/** `://`: the end of a scheme, where a viewer starts an autolink. */
const URL_SCHEME_END = /:\/\//g

/** The length of the longest run of backticks in `text`, 0 when it holds none. */
function longestBacktickRun(text: string): number {
  let longest = 0
  for (const [run] of text.matchAll(BACKTICK_RUN)) longest = Math.max(longest, run.length)
  return longest
}

/**
 * One line of Markdown that shows `text` literally: a code span, the one Markdown construct that
 * stops mentions, references, emoji, math, links, images and HTML at once. A backslash would not
 * stop a mention, so no escaping can stand in for it. Every hidden character and line break is shown
 * as a label first, so the span is one line. Its fence is a run of backticks one longer than the
 * longest run in the text, so no run in the text closes the span, and a space inside each end, which
 * a reader strips back off, keeps a backtick or a space at either end of the text, or an empty text,
 * from joining the fence. A text of only spaces gets none, since a reader strips no space from it. A
 * `|` still splits a table cell, even inside a code span, so a table cell holds no text from a model
 * or a diff.
 */
export function codeSpan(text: string): string {
  const shown = showHidden(text)
  const fence = '`'.repeat(longestBacktickRun(shown) + 1)
  const pad = shown === '' || (/^[ `]|[ `]$/.test(shown) && /[^ ]/.test(shown))
    ? ' '
    : ''
  return `${fence}${pad}${shown}${pad}${fence}`
}

/**
 * Rows of code as a fenced block, a row a line: each row has its hidden characters and line breaks
 * shown as labels, so no row adds a line, and the fence is at least three backticks and longer than
 * any run in a row, so no row closes the block. The info string is a type, `text` or `diff`, so no
 * caller can ask for a fence a viewer renders, such as `suggestion` or `mermaid`: the type says so
 * to TypeScript, and a `TypeError` says so to a caller that is not typed. The lines are joined by
 * line feeds, with none after the closing fence; a caller that nests the block, in a list item,
 * indents each of its lines itself.
 *
 * @throws TypeError when `info` is anything but the string `text` or `diff`
 */
export function fencedBlock(rows: readonly string[], info: 'text' | 'diff'): string {
  if (info !== 'text' && info !== 'diff') throw new TypeError('fencedBlock\'s info must be text or diff')
  const shown = rows.map(showHidden)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(shown.join('\n')) + 1))
  return [`${fence}${info}`, ...shown, fence].join('\n')
}

/**
 * Plain text a viewer may still link, such as a SARIF message: the first `max` code points of
 * `text`, each hidden character shown as a label, and what a linker triggers on broken: an `@` that
 * no ASCII letter, digit or `_` precedes (a mention, so an `@` after `é` or `你` is broken too), a
 * `#` before a digit (an issue or pull request reference) and `://` (an autolink), each written as
 * the label of its character. `…` follows when `text` held more. The cap is on the input, so no
 * label and no surrogate pair is cut, and a `max` that is not a number caps everything.
 */
export function inertPlain(text: string, max = 1000): string {
  let head = ''
  let count = 0
  let capped = false
  for (const char of text) {
    // Written so that a `max` that is not a number, which no comparison holds, caps everything.
    if (!(count < max)) {
      capped = true
      break
    }
    head += char
    count++
  }
  const shown = showHidden(head)
    .replace(MENTION_START, '<U+0040>')
    .replace(REFERENCE_START, '<U+0023>')
    .replace(URL_SCHEME_END, '<U+003A>//')
  return capped
    ? `${shown}…`
    : shown
}

/**
 * The JSON result as text: `JSON.stringify(value, null, 2)`, with every hidden character it
 * leaves raw written as a \uXXXX escape (lower case, a character outside the BMP as its two
 * halves) and each `##[` written `##\u005b`. Its own line breaks stay. It is lossless:
 * `JSON.parse` gives back the same value. After its indentation, each line starts with a quote, a
 * bracket, a brace or a literal, and none holds `##[`, so the text holds no workflow command. A
 * value with no JSON form, such as `undefined`, throws instead of returning `undefined`.
 */
export function inertJson(value: unknown): string {
  return escapeJson(JSON.stringify(value, null, 2) as string | undefined)
}

/**
 * The JSON of `value` on one line: `JSON.stringify(value)`, escaped as `inertJson` escapes. The line
 * holds no line break, since `JSON.stringify` writes a line feed inside a string as `\n` and the
 * escaping covers every other hidden character, so it is one line of a file that is read line by line.
 * It is lossless, and a value with no JSON form throws.
 */
export function inertJsonLine(value: unknown): string {
  return escapeJson(JSON.stringify(value) as string | undefined)
}

/**
 * A JSON text with every hidden character it leaves raw, but a line feed, written as escapes, and
 * each `##[` broken. `undefined` is what `JSON.stringify` returns for a value with no JSON form.
 */
function escapeJson(json: string | undefined): string {
  if (json === undefined) throw new TypeError('the value has no JSON form')
  return json
    .replace(HIDDEN, char => (char === '\n'
      ? char
      : escapeUnits(char)))
    .replace(LEGACY_COMMAND, '##\\u005b')
}

/** The \uXXXX escape of each UTF-16 code unit of `char`. */
function escapeUnits(char: string): string {
  return Array.from({ length: char.length }, (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`).join('')
}

/**
 * The most passes `cleanProse` makes. A removal can join two halves into a new construct, and each
 * level of nesting needs a pass of its own, so a text nested 15 levels deep settles in the 16th, and
 * a deeper one is still changing after it.
 */
export const MAX_CLEAN_PASSES = 16

/** What `cleanProse` removed: hidden characters by code point, comments and character references by construct. */
export interface Removed {
  readonly characters: number
  readonly comments: number
  readonly entities: number
}

/** The result of `cleanProse`. */
export interface CleanedProse {
  readonly text: string
  readonly removed: Removed
  /** `false` when the text was still changing in the last of `MAX_CLEAN_PASSES` passes: its reader refuses it, and never sends it. */
  readonly settled: boolean
}

/** A CRLF or a lone CR: CommonMark reads each as a line end, so a person sees a break and no hidden character. */
const CARRIAGE_RETURN = /\r\n?/g

/**
 * A numeric character reference, its `;` optional: the HTML parser decodes `&#xE0041` as it does
 * `&#xE0041;`, so a tag character spelled without one hides from a reader and reaches a model.
 * Named entities are left alone.
 */
const NUMERIC_REFERENCE = /&#(?:x[0-9A-F]+|\d+);?/gi

/** The hidden class but the line feed and the tab, which prose keeps. */
const HIDDEN_BUT_LINE_BREAK_AND_TAB = new RegExp(String.raw`(?![\n\t])[${HIDDEN_CLASS}]`, 'gu')

/** A text with what was removed from it taken out, and how many pieces that was. */
interface Stripped {
  readonly text: string
  readonly count: number
}

function stripMatches(text: string, pattern: RegExp): Stripped {
  let count = 0
  const stripped = text.replace(pattern, () => {
    count++
    return ''
  })
  return { text: stripped, count }
}

/**
 * A search for `needle` in `text` that a caller only ever moves forward. It keeps the last hit while
 * the hit still lies ahead, so a needle the text holds once, or never, is searched for once, not once
 * for every comment.
 */
function forwardSearch(text: string, needle: string): (from: number) => number {
  let found: number | undefined
  return (from) => {
    if (found === undefined || (found !== -1 && found < from)) found = text.indexOf(needle, from)
    return found
  }
}

/**
 * The text without its HTML comments. A comment runs from `<!--` to the first `-->`, searched from
 * the opener's third character, so `<!-->` and `<!--->` are whole comments, as the HTML parser reads
 * them. With no `-->` ahead it runs to the first `--!>` searched from the opener's fifth
 * character, never the opener's own dashes (`<!--!>` is no comment end), and with neither to the end
 * of the text. That is the longer of CommonMark's reading, which ends a comment at `-->` alone, and
 * the HTML parser's, which also ends it at `--!>`, so a renderer that follows either hides no more
 * than is removed here: a mismatch can only remove visible text, and that is counted.
 */
function stripComments(text: string): Stripped {
  const nextClose = forwardSearch(text, '-->')
  const nextBangClose = forwardSearch(text, '--!>')
  let kept = ''
  let from = 0
  let count = 0
  for (let open = text.indexOf('<!--', from); open !== -1; open = text.indexOf('<!--', from)) {
    count++
    kept += text.slice(from, open)
    const close = nextClose(open + 2)
    const bangClose = close === -1
      ? nextBangClose(open + '<!--'.length)
      : -1
    if (close !== -1) from = close + '-->'.length
    else if (bangClose !== -1) from = bangClose + '--!>'.length
    else from = text.length
  }
  return { text: kept + text.slice(from), count }
}

/**
 * `text` without the HTML comments, numeric references and hidden characters that can spell an
 * instruction in what a model reads as policy, a guideline or a rules file, where a person reading
 * the rendered page sees none of them. It makes the text well formed (a lone surrogate becomes
 * U+FFFD), makes each CRLF and lone CR a line feed, then runs passes, each removing the comments,
 * then the numeric references, then the hidden characters but the line feed and the tab, until a
 * pass removes nothing. Passes repeat because a removal can join two halves into a construct
 * (`&#x4<!-- -->1;`), and nesting needs one pass a level. The line ends and the surrogates count as
 * nothing removed.
 *
 * It removes those three kinds and no other Markdown a renderer hides: a link reference definition
 * (`[//]: # (a note)`) passes untouched. The hidden class holds joiners and variation selectors
 * whose effect a reader sees (ZWJ, ZWNJ, U+FE0F in Persian or Hindi text and emoji), and they go too.
 *
 * A text still changing after `MAX_CLEAN_PASSES` passes comes back with `settled: false` and
 * what the passes made of it: it is nested too deep to trust, and its reader refuses it.
 */
export function cleanProse(text: string): CleanedProse {
  let current = text.toWellFormed().replace(CARRIAGE_RETURN, '\n')
  let characters = 0
  let comments = 0
  let entities = 0
  for (let pass = 0; pass < MAX_CLEAN_PASSES; pass++) {
    const withoutComments = stripComments(current)
    const withoutReferences = stripMatches(withoutComments.text, NUMERIC_REFERENCE)
    const withoutHidden = stripMatches(withoutReferences.text, HIDDEN_BUT_LINE_BREAK_AND_TAB)
    current = withoutHidden.text
    comments += withoutComments.count
    entities += withoutReferences.count
    characters += withoutHidden.count
    if (withoutComments.count + withoutReferences.count + withoutHidden.count === 0) {
      return {
        text: current,
        removed: { characters, comments, entities },
        settled: true,
      }
    }
  }
  return {
    text: current,
    removed: { characters, comments, entities },
    settled: false,
  }
}
