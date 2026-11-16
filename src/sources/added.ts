import { decodeQuoted } from '../core/diff.ts'
import { utf8Length } from '../core/tokens.ts'

/**
 * The all-added writer: files that have no diff of their own (a path review's, the untracked files of a
 * local review) written as git writes a new file, so the core reads them as it reads any diff. The form
 * is git's new-file form less its `index` line, with each name quoted as git quotes it, and a file cut
 * into hunks of at most `HUNK_BYTES` at line ends, so research in parts spreads a large file across
 * parts. It is a reading form and not a patch: `git apply` refuses a new file cut in several hunks.
 *
 * @see ../../docs/95-reference/40-architecture.md for where it sits in the layers.
 */

/** The most bytes of rows a hunk holds, line feeds included, a longer line aside, which goes alone in its hunk. */
export const HUNK_BYTES = 4096

/** How many leading bytes git looks at for a NUL to call a file binary. */
export const BINARY_PROBE_BYTES = 8000

/** The modes git gives a new file: a file, an executable, a link and a gitlink (a submodule's commit). */
export type AddedMode = '100644' | '100755' | '120000' | '160000'

/** One file to write. */
export interface AddedFile {
  /** The path as git names it: bytes, not text, since a name can hold any byte but NUL. */
  readonly path: Uint8Array
  readonly mode: AddedMode
  /** The file's bytes, or a link's target; empty for a gitlink, which holds another repository's commit. */
  readonly content: Uint8Array
}

/** Reads a name git writes as it is, which holds printable ASCII only. */
const ASCII_DECODER = new TextDecoder()

const NAMED: Readonly<Record<number, string>> = {
  0x07: 'a',
  0x08: 'b',
  0x09: 't',
  0x0A: 'n',
  0x0B: 'v',
  0x0C: 'f',
  0x0D: 'r',
  0x22: '"',
  0x5C: '\\',
}

// A byte's escape under core.quotePath=true, as git's cq_lookup writes it, or undefined when git writes it as it is.
function escapeOf(byte: number): string | undefined {
  return byte in NAMED
    ? `\\${NAMED[byte]}`
    : byte < 0x20 || byte >= 0x7F
      ? `\\${byte.toString(8).padStart(3, '0')}`
      : undefined
}

/**
 * The inside of git's quoting of a name, as `core.quotePath=true` writes it: `\a \b \t \n \v \f \r \" \\`
 * for those nine bytes and three octal digits for every other byte below 0x20 and from 0x7F up.
 * `undefined` when git writes the name as it is.
 */
export function quotedPath(raw: Uint8Array): string | undefined {
  const escapes = Array.from(raw, escapeOf)
  return escapes.some(escape => escape !== undefined)
    ? escapes.map((escape, at) => escape ?? String.fromCharCode(raw[at])).join('')
    : undefined
}

/**
 * The name `diffSections` reads back from the header this writer writes for `raw`: the name itself when
 * git writes it as it is, else `decodeQuoted`, the core's own reading of git's quoted names, of its
 * quoting, so writer and reader cannot drift.
 */
export function pathName(raw: Uint8Array): string {
  const quoted = quotedPath(raw)
  return quoted === undefined
    ? ASCII_DECODER.decode(raw)
    : decodeQuoted(quoted)
}

/** Whether git would call `content` binary: a NUL among its first `BINARY_PROBE_BYTES` bytes. */
export function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

/** A label of a header: the name behind `a/` or `b/`, the whole label quoted when any byte of the name needs it. */
function labelOf(prefix: string, raw: Uint8Array): string {
  const quoted = quotedPath(raw)
  return quoted === undefined
    ? `${prefix}${ASCII_DECODER.decode(raw)}`
    : `"${prefix}${quoted}"`
}

const BLOB_DECODER = new TextDecoder('utf-8', { ignoreBOM: true })

/** The text of a blob: a byte that is not UTF-8 becomes U+FFFD, as `decodeDiff` makes it of git's own output, and a leading byte-order mark stays. */
export function blobText(content: Uint8Array): string {
  return BLOB_DECODER.decode(content)
}

/** The lines of a text, split at line feeds, with no empty piece after a last one. */
function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** A hunk's header: no old lines, and `count` new ones from line `first`, with no count for a single line, as git writes it. */
function hunkHeader(first: number, count: number): string {
  return count === 1
    ? `@@ -0,0 +${first} @@`
    : `@@ -0,0 +${first},${count} @@`
}

/** The hunks of `lines`: whole lines while their UTF-8 bytes, line feeds included, stay within `HUNK_BYTES`, a longer line alone. */
function hunksOf(lines: readonly string[]): string[] {
  const hunks: string[] = []
  for (let start = 0; start < lines.length;) {
    let end = start
    for (let bytes = 0; end < lines.length; end++) {
      const size = utf8Length(lines[end]) + 1
      if (end > start && bytes + size > HUNK_BYTES) break
      bytes += size
    }
    hunks.push([
      hunkHeader(start + 1, end - start),
      ...lines.slice(start, end).map(line => `+${line}`),
    ].join('\n'))
    start = end
  }
  return hunks
}

/**
 * One file as git's new-file diff less its `index` line, with no final line feed: the header, the mode,
 * then `--- /dev/null`, `+++` and the hunks, or git's binary line for a file with a NUL among its first
 * 8000 bytes, or nothing more for an empty file and a gitlink. The `+++` line ends with a tab when its
 * label holds a space, as git writes it, and a last line with no line feed is followed by git's
 * `\ No newline at end of file`.
 */
export function addedSection(file: AddedFile): string {
  const oldLabel = labelOf('a/', file.path)
  const newLabel = labelOf('b/', file.path)
  const lines = [`diff --git ${oldLabel} ${newLabel}`, `new file mode ${file.mode}`]
  if (file.content.length === 0) return lines.join('\n')
  if (isBinary(file.content)) return [...lines, `Binary files /dev/null and ${newLabel} differ`].join('\n')
  const text = blobText(file.content)
  const tab = newLabel.includes(' ')
    ? '\t'
    : ''
  lines.push('--- /dev/null', `+++ ${newLabel}${tab}`, ...hunksOf(linesOf(text)))
  if (!text.endsWith('\n')) lines.push('\\ No newline at end of file')
  return lines.join('\n')
}

/** The sections of `files`, joined by line feeds and ending with one: `''` for no file. */
export function addedDiff(files: readonly AddedFile[]): string {
  return files.map(file => `${addedSection(file)}\n`).join('')
}
