const GIT_HEADER = 'diff --git '
const NEW_SIDE_MARKERS = [' "b/', ' b/']
const PATH_PREFIX = /^(?:[ab]\/|\.\/)/
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
/** How many diff lines of a hunk, either side of the cited one, make up a finding's evidence. */
const EVIDENCE_RADIUS = 2

/** A path without the double quotes git puts around one with special characters. */
function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

/**
 * The path both names of a `diff --git` header share, or '' when they differ. Git writes the same
 * path on both sides unless the file is renamed: `P P` (`--no-prefix`) or `X/P Y/P` with a
 * one-character prefix (`a/ b/`, and `i/ w/` or `c/ o/` with `diff.mnemonicPrefix`), either name
 * possibly quoted. The halves are cut at the middle space, a position and not a search, so a path
 * that contains spaces or ` b/` is read whole and in linear time. An even length has no middle.
 */
function sharedPath(names: string): string {
  const middle = (names.length - 1) / 2
  if (names[middle] !== ' ') return ''
  const before = unquote(names.slice(0, middle))
  const after = unquote(names.slice(middle + 1))
  if (before === after) return before
  return before[1] === '/' && after[1] === '/' && before.slice(2) === after.slice(2) ? before.slice(2) : ''
}

/**
 * The new path of a renamed or copied file, whose two names differ: what follows the last ` b/`
 * (` "b/` for a quoted path). Searching from the end keeps paths with spaces working and cannot
 * backtrack, unlike a pattern that matches both sides. Known limit: a new name that itself
 * contains ` b/` is cut short, and a rename between other prefixes has no ` b/` and is not read.
 */
function renamedPath(names: string): string {
  let start = -1
  for (const marker of NEW_SIDE_MARKERS) {
    const at = names.lastIndexOf(marker)
    if (at !== -1) start = Math.max(start, at + marker.length)
  }
  if (start === -1) return ''
  const path = names.slice(start)
  return path.endsWith('"') ? path.slice(0, -1) : path
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
 * A header that names no readable path leaves its section out of the map: the whole diff still
 * holds it, which `diffSectionFor` falls back to. Text before the first header, and a diff
 * without such headers (plain `diff -u` output), come back as one section keyed '' rather than
 * risk a wrong split, except that a preamble followed only by unreadable headers is left out too.
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
 * The section of `file`: the exact path first, then a unique path-suffix match (models often
 * shorten paths). `path` is the diff's own path. A diff without per-file headers has a single
 * unkeyed section, which stands for any file. Undefined when nothing, or more than one section,
 * matches.
 */
export function sectionFor(sections: ReadonlyMap<string, string>, file: string): { path: string, text: string } | undefined {
  const wanted = file.trim().replace(PATH_PREFIX, '')
  const exact = wanted === '' ? undefined : sections.get(wanted)
  if (exact !== undefined) return { path: wanted, text: exact }
  const unkeyed = sections.get('')
  if (sections.size === 1 && unkeyed !== undefined) return { path: '', text: unkeyed }
  const candidates = [...sections.keys()].filter(path => path !== '' && (path.endsWith(`/${wanted}`) || wanted.endsWith(`/${path}`)))
  const [only] = candidates
  return candidates.length === 1 && only !== undefined ? { path: only, text: sections.get(only) ?? '' } : undefined
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
  /** The diff lines around the cited line, exactly as the diff has them (with +, - or space markers). */
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
  for (const hunk of parseHunks(section.text)) {
    if (hunk.rows.length === 0 || line < hunk.start || line >= hunk.start + Math.max(hunk.count, 1)) continue
    const at = hunk.rows.findIndex(row => row.newLine === line)
    if (at === -1 && hunk.count > 0) continue
    const center = Math.max(at, 0)
    const rows = hunk.rows.slice(Math.max(0, center - EVIDENCE_RADIUS), center + EVIDENCE_RADIUS + 1)
    return { path: section.path, evidence: rows.map(row => row.text).join('\n') }
  }
  return undefined
}

interface Hunk {
  /** First new-file line of the hunk. */
  start: number
  /** Number of new-file lines the header promises. */
  count: number
  rows: Array<{ newLine: number | undefined, text: string }>
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
  let newLine = 0
  const lines = section.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const raw of lines) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const marker = text === '' ? ' ' : text[0]
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (marker === '\\') continue
      if (marker === '-') {
        oldLeft--
        current.rows.push({ newLine: undefined, text })
        continue
      }
      if (marker === '+' || marker === ' ') {
        if (marker === ' ') oldLeft--
        newLeft--
        current.rows.push({ newLine: newLine++, text })
        continue
      }
      current = undefined
    }
    const header = HUNK_HEADER.exec(text)
    if (header) {
      oldLeft = Number(header[1] ?? 1)
      newLine = Number(header[2])
      newLeft = Number(header[3] ?? 1)
      current = { start: newLine, count: newLeft, rows: [] }
      hunks.push(current)
    }
  }
  return hunks
}
