/**
 * Renders the text that models, servers and diffs wrote for the places a person reads it: a
 * terminal, a CI log, the JSON result. The text is stored as it came, and each sink renders it
 * inert (invariant I3), so nothing in it acts on a terminal or a runner, or hides from the reader.
 *
 * @see ../../docs/30-security/30-output-handling.md
 */

/** Controls (C0, DEL, C1), format characters, unpaired surrogate halves, other default-ignorable code points, line and paragraph separators. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu

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

/**
 * One line of a terminal or a CI log. Every hidden character is shown as `<U+XXXX>`, so the line
 * holds no line break, starts no escape sequence, reorders nothing and hides nothing. Then both
 * forms of a GitHub Actions workflow command are broken: a line that starts with `::` once its
 * leading whitespace is trimmed shows its first colon as `<U+003A>`, and each `##[` shows its
 * bracket as `<U+005B>`. Apply it to the whole line: two inert pieces printed side by side can
 * still meet as `::` or `##[`.
 */
export function inertLine(text: string): string {
  return text
    .replace(HIDDEN, char => `<${codePointLabel(char)}>`)
    .replace(COMMAND_START, '$1<U+003A>')
    .replace(LEGACY_COMMAND, '##<U+005B>')
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
  const json = JSON.stringify(value, null, 2) as string | undefined
  if (json === undefined) throw new TypeError('the value has no JSON form')
  return json
    .replace(HIDDEN, char => (char === '\n' ? char : escapeUnits(char)))
    .replace(LEGACY_COMMAND, '##\\u005b')
}

/** The \uXXXX escape of each UTF-16 code unit of `char`. */
function escapeUnits(char: string): string {
  return Array.from({ length: char.length }, (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`).join('')
}
