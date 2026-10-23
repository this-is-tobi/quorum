const GIT_HEADER = 'diff --git '
const QUOTED_NEW_SIDE = ' "b/'
const NEW_SIDE_MARKERS = [QUOTED_NEW_SIDE, ' b/']
const PATH_PREFIX = /^(?:[ab]\/|\.\/)/
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
/** How many diff lines of a hunk, either side of the cited one, make up a finding's evidence. */
const EVIDENCE_RADIUS = 2
/** What a backslash and one more character stand for in a name git quotes (octal bytes are read apart). */
const QUOTED_ESCAPES = new Map([['a', '\x07'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'], ['\\', '\\'], ['"', '"']])
/** One byte as git writes it in a quoted name: a backslash then three octal digits (0 to 255). */
const OCTAL_BYTE = /^[0-3][0-7]{2}$/
/**
 * Git's names are UTF-8. A run of bytes that is not valid UTF-8 makes the decoder throw, and
 * `decodeQuoted` then keeps each byte as a lone surrogate. A byte-order mark is kept, or a name
 * that starts with one would read as the name without it.
 */
const NAME_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
/** A byte of a name that is not valid UTF-8 becomes the lone surrogate at this code plus the byte. */
const SURROGATE_ESCAPE = 0xDC00

const isQuoted = (name: string): boolean => name.startsWith('"') && name.endsWith('"')

/** A name without the double quotes git puts around one with special characters, escapes untouched. */
function unquote(name: string): string {
  return isQuoted(name) ? name.slice(1, -1) : name
}

/** A path without the `a/`, `b/` or `./` prefix a diff, or a model, may put in front of it. */
function withoutPrefix(path: string): string {
  return path.replace(PATH_PREFIX, '')
}

/**
 * Decode the inside of a quoted name (`core.quotePath` writes every non-ASCII byte as `\NNN`): a
 * backslash escape stands for one character (`\n`, `\t`, `\"`, `\\`, ...) and the `\NNN` bytes of a
 * run are decoded together as UTF-8. An escape git never writes is kept as it is. A run of bytes
 * that is not valid UTF-8 becomes one lone surrogate per byte (U+DC00 plus the byte, as Python
 * names a file it cannot decode): no valid name holds a lone surrogate, so two such names never
 * share a key, nor does one share a key with a name that spells out its escapes, and
 * `JSON.stringify` writes the surrogate as an escape. One pass over the name and no pattern that
 * can backtrack.
 */
function decodeQuoted(quoted: string): string {
  const bytes: number[] = []
  let name = ''
  const flush = (): void => {
    if (bytes.length === 0) return
    try {
      name += NAME_DECODER.decode(Uint8Array.from(bytes))
    } catch {
      name += bytes.map(byte => String.fromCharCode(SURROGATE_ESCAPE + byte)).join('')
    }
    bytes.length = 0
  }
  for (let at = 0; at < quoted.length; at++) {
    if (quoted[at] !== '\\') {
      flush()
      name += quoted[at]
      continue
    }
    const octal = quoted.slice(at + 1, at + 4)
    if (OCTAL_BYTE.test(octal)) {
      bytes.push(Number.parseInt(octal, 8))
      at += 3
      continue
    }
    flush()
    const character = QUOTED_ESCAPES.get(octal.slice(0, 1))
    name += character ?? '\\'
    if (character !== undefined) at++
  }
  flush()
  return name
}

/**
 * The path both names of a `diff --git` header share, or '' when they differ. Git writes the same
 * path on both sides unless the file is renamed: `P P` (`--no-prefix`) or `X/P Y/P` with a
 * one-character prefix (`a/ b/`, and `i/ w/` or `c/ o/` with `diff.mnemonicPrefix`), either name
 * possibly quoted. The halves are cut at the middle space, a position and not a search, so a path
 * that contains spaces or ` b/` is read whole and in linear time. An even length has no middle.
 * The halves are compared as written, and the shared path is decoded when both were quoted.
 */
function sharedPath(names: string): string {
  const middle = (names.length - 1) / 2
  if (names[middle] !== ' ') return ''
  const first = names.slice(0, middle)
  const second = names.slice(middle + 1)
  const before = unquote(first)
  const after = unquote(second)
  const decode = isQuoted(first) && isQuoted(second) ? decodeQuoted : (path: string): string => path
  if (before === after) return decode(before)
  return before[1] === '/' && after[1] === '/' && before.slice(2) === after.slice(2) ? decode(before.slice(2)) : ''
}

/**
 * The new path of a renamed or copied file, whose two names differ: what follows the last ` b/`
 * (` "b/` for a quoted path, which is decoded). Searching from the end keeps paths with spaces
 * working and cannot backtrack, unlike a pattern that matches both sides. Known limit: a new name
 * that itself contains ` b/` is cut short, and a rename between other prefixes has no ` b/` and is
 * not read.
 */
function renamedPath(names: string): string {
  let start = -1
  let quoted = false
  for (const marker of NEW_SIDE_MARKERS) {
    const at = names.lastIndexOf(marker)
    if (at !== -1 && at + marker.length > start) {
      start = at + marker.length
      quoted = marker === QUOTED_NEW_SIDE
    }
  }
  if (start === -1) return ''
  const path = names.slice(start)
  const inside = path.endsWith('"') ? path.slice(0, -1) : path
  return quoted ? decodeQuoted(inside) : inside
}

/** The path a `diff --git` header names, or undefined when it names none. */
function headerPath(header: string): string | undefined {
  const line = header.endsWith('\r') ? header.slice(0, -1) : header
  const names = line.slice(GIT_HEADER.length)
  return sharedPath(names) || renamedPath(names) || undefined
}

/**
 * Split a git-style unified diff into sections keyed by file path. Only `diff --git` lines open a
 * section: inside a hunk every line starts with ' ', '+', '-' or '\', so that text cannot appear
 * there. Outside hunks it can (a `format-patch` series carries unindented commit messages), so a
 * path seen more than once keeps every occurrence, in order, rather than the last one winning.
 * A header is read in three shapes: the path both sides share with one-character prefixes
 * (`a/P b/P`, or `i/P w/P` and `c/P o/P` with `diff.mnemonicPrefix`), the path both sides share
 * without prefixes (`P P`, from `--no-prefix`), and, for a rename, the new side (`a/old b/new`).
 * A quoted name is decoded, so the key is the file's real name (git quotes non-ASCII names by
 * default). A header that names no readable path leaves its section out of the map: the whole
 * diff still holds it, which `diffSectionFor` falls back to. Text before the first header, and a
 * diff without such headers (plain `diff -u` output), come back as one section keyed '' rather
 * than risk a wrong split, except that a preamble followed only by unreadable headers is left out
 * too.
 */
export function splitDiff(diff: string): Map<string, string> {
  const sections = new Map<string, string>()
  let path: string | undefined = ''
  let lines: string[] = []
  const flush = (): void => {
    if (path === undefined || lines.length === 0) return
    const text = lines.join('\n')
    const previous = sections.get(path)
    sections.set(path, previous === undefined ? text : `${previous}\n${text}`)
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith(GIT_HEADER)) {
      flush()
      path = headerPath(line)
      lines = []
    }
    lines.push(line)
  }
  flush()
  // `path` is '' only before the first header: when every header was unreadable, the preamble is
  // all that is left, and it must not stand for a file.
  if (path !== '' && sections.size === 1) sections.delete('')
  return sections
}

/**
 * The section of `file`: the path exactly as given first (a key can start or end with a character
 * `trim()` removes, and a verified finding's file is such a key), then trimmed (a repository can
 * have a `b/` directory of its own, so the path is tried before its prefix goes), then without an
 * `a/`, `b/` or `./` prefix, then, for a citation copied from a header in git's quoted spelling
 * (`"b/donn\303\251es.js"`), the decoded name with and without its prefix, and last a unique
 * path-suffix match on the trimmed path without its prefix (models often shorten paths). `path` is
 * the diff's own path. A diff without per-file headers has a single unkeyed section, which stands
 * for any file. Undefined when nothing, or more than one section, matches.
 */
export function sectionFor(sections: ReadonlyMap<string, string>, file: string): { path: string, text: string } | undefined {
  const written = file.trim()
  for (const path of citedSpellings(file, written)) {
    const text = sections.get(path)
    if (text !== undefined) return { path, text }
  }
  const wanted = withoutPrefix(written)
  const unkeyed = sections.get('')
  if (sections.size === 1 && unkeyed !== undefined) return { path: '', text: unkeyed }
  const candidates = [...sections.keys()].filter(path => path !== '' && (path.endsWith(`/${wanted}`) || wanted.endsWith(`/${path}`)))
  const [only] = candidates
  return candidates.length === 1 && only !== undefined ? { path: only, text: sections.get(only) ?? '' } : undefined
}

/**
 * The spellings a cited file is looked up under, in order: exactly as given, trimmed, without its
 * prefix and, when the citation carries git's quoting (a backslash escape or surrounding quotes),
 * the decoded name with and without its prefix. Neither the given spelling nor a decoded one is
 * trimmed: a name can start or end with a character `trim()` removes (a tab, a byte-order mark),
 * and those spellings are the ones that reach it. The empty spelling is left out, as '' keys the
 * preamble.
 */
function citedSpellings(given: string, written: string): string[] {
  const spellings = [given, written, withoutPrefix(written)]
  if (written.includes('\\') || isQuoted(written)) {
    const decoded = decodeQuoted(unquote(written))
    spellings.push(decoded, withoutPrefix(decoded))
  }
  return spellings.filter(path => path !== '')
}

/**
 * The diff a voter needs for `file`: its section, or the whole diff when nothing, or more than one
 * section, matches.
 */
export function diffSectionFor(sections: ReadonlyMap<string, string>, file: string, wholeDiff: string): string {
  return sectionFor(sections, file)?.text ?? wholeDiff
}

/** Where a finding really points, read from the diff. */
export interface FindingLocation {
  /** The diff's own path for the file; empty for a diff without per-file headers. */
  path: string
  /**
   * The diff lines around the cited line, each with its +, - or space marker. A line's trailing
   * carriage return is removed, and `\ No newline at end of file` markers are left out.
   */
  evidence: string
}

/**
 * Locate a finding in the diff: the diff's own path for the file, and the lines within two lines of
 * `line` in the hunk whose new-file range holds it. Undefined when the file is not in the diff,
 * `line` is not an integer, or no hunk shows the line (a hunk cut off short of the range its
 * header promises does not hold the lines it never shows), so a finding cannot cite code that is
 * not there. For removed code the finder cites the nearest surviving line, which a deletion-only
 * hunk (`+c,0`) holds at `c`.
 */
export function locate(sections: ReadonlyMap<string, string>, file: string, line: number): FindingLocation | undefined {
  if (!Number.isInteger(line)) return undefined
  const section = sectionFor(sections, file)
  if (!section) return undefined
  for (const hunk of hunksOf(sections, section.path, section.text)) {
    if (hunk.rows.length === 0 || line < hunk.start || line >= hunk.start + Math.max(hunk.count, 1)) continue
    const at = hunk.rowOfLine[line - hunk.start] ?? -1
    if (at === -1 && hunk.count > 0) continue
    const center = Math.max(at, 0)
    const rows = hunk.rows.slice(Math.max(0, center - EVIDENCE_RADIUS), center + EVIDENCE_RADIUS + 1)
    return { path: section.path, evidence: rows.join('\n') }
  }
  return undefined
}

interface Hunk {
  /** First new-file line of the hunk. */
  start: number
  /** Number of new-file lines the header promises. */
  count: number
  /** The hunk's lines (with their +, - or space marker), in order. */
  rows: string[]
  /** For each new-file line from `start`, the index in `rows` of the row that shows it. */
  rowOfLine: number[]
}

/**
 * The hunks of each section, parsed once: a finding costs a lookup and not a new parse of its whole
 * file. A sections map is never changed after `splitDiff` returns it, so what is cached for it
 * stays true, and the cache is dropped with the map.
 */
const parsedSections = new WeakMap<ReadonlyMap<string, string>, Map<string, Hunk[]>>()

function hunksOf(sections: ReadonlyMap<string, string>, path: string, text: string): Hunk[] {
  let parsed = parsedSections.get(sections)
  if (!parsed) {
    parsed = new Map()
    parsedSections.set(sections, parsed)
  }
  let hunks = parsed.get(path)
  if (!hunks) {
    hunks = parseHunks(text)
    parsed.set(path, hunks)
  }
  return hunks
}

/**
 * Read the hunks of one file section. The header's line counts say where a hunk ends, so file
 * headers and `\ No newline at end of file` markers are never mistaken for hunk lines, and a line
 * that cannot belong to a hunk closes it even when the counts promised more. The empty element
 * after a final newline is not a line; an empty line before it is a blank context row.
 */
function parseHunks(section: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  let oldLeft = 0
  let newLeft = 0
  const lines = section.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const raw of lines) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const marker = text === '' ? ' ' : text[0]
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (marker === '\\') continue
      if (marker === '-') {
        oldLeft--
        current.rows.push(text)
        continue
      }
      if (marker === '+' || marker === ' ') {
        if (marker === ' ') oldLeft--
        newLeft--
        current.rowOfLine.push(current.rows.length)
        current.rows.push(text)
        continue
      }
      current = undefined
    }
    const header = HUNK_HEADER.exec(text)
    if (header) {
      oldLeft = Number(header[1] ?? 1)
      newLeft = Number(header[3] ?? 1)
      current = { start: Number(header[2]), count: newLeft, rows: [], rowOfLine: [] }
      hunks.push(current)
    }
  }
  return hunks
}
