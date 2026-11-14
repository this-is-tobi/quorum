import { diffSections } from './diff.ts'
import type { IncompleteEntry, LeftOutFile, LeftOutReason } from './types.ts'

const BINARY_FILES_START = 'Binary files '
const BINARY_FILES_END = ' differ'
const BINARY_PATCH = 'GIT binary patch'
const SUBPROJECT_COMMIT = 'Subproject commit '
const SUBMODULE_MODES: ReadonlySet<string> = new Set([
  'new file mode 160000',
  'deleted file mode 160000',
  'old mode 160000',
  'new mode 160000',
])
const INDEX_START = 'index '
const GITLINK_MODE_END = ' 160000'
/** The line git's `log` and `diff` submodule formats print in place of a header, at the end of the section before it. */
const SUBMODULE_LINE_START = 'Submodule '
/** The characters a hunk row starts with, the only ones that can come before `Subproject commit`. */
const ROW_MARKERS = '+- '

/** What a review covers of a diff: the diff every stage reads, and the files whose change it does not carry. */
export interface ReviewScope {
  /** The diff every stage reads. */
  readonly diff: string
  /** The files whose change the diff does not carry, in the diff's order, once per file and reason. */
  readonly leftOut: LeftOutFile[]
}

/** What one section shows of content the diff does not carry. */
interface Markers {
  /** A `Binary files ... differ` line or a `GIT binary patch` line. */
  binary: boolean
  /** A line of the section's own submodule: a `Subproject commit` row, a mode 160000 header or an `index` line of mode 160000. */
  submodule: boolean
  /** A `Submodule` line, which belongs to no section. */
  submoduleLine: boolean
}

/** Whether `line` (less its `\r`) is a line of the section's own submodule. */
function isOwnSubmodule(line: string): boolean {
  return line.startsWith(SUBPROJECT_COMMIT)
    || (line.startsWith(SUBPROJECT_COMMIT, 1) && ROW_MARKERS.includes(line[0]))
    || SUBMODULE_MODES.has(line)
    || (line.startsWith(INDEX_START) && line.endsWith(GITLINK_MODE_END))
}

/** The markers of one section, each line read on its own, with no hunk parsing, and at most one marker for a line: binary first, then the section's own submodule, then a `Submodule` line. */
function markersOf(text: string): Markers {
  const markers: Markers = { binary: false, submodule: false, submoduleLine: false }
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r')
      ? raw.slice(0, -1)
      : raw
    if ((line.startsWith(BINARY_FILES_START) && line.endsWith(BINARY_FILES_END)) || line.startsWith(BINARY_PATCH)) markers.binary = true
    else if (isOwnSubmodule(line)) markers.submodule = true
    else if (line.startsWith(SUBMODULE_LINE_START)) markers.submoduleLine = true
  }
  return markers
}

/**
 * What a review covers of a diff: the files whose change the diff does not carry, found from the
 * markers git prints in their place, each section read line by line (a trailing `\r` is dropped), so a
 * Windows-made diff reads as any other. In each section:
 * - a `binary` file shows as a line that starts with `Binary files ` and ends with ` differ`, or one
 *   that starts with `GIT binary patch`;
 * - a `submodule` shows as a `Subproject commit` row (past at most one leading `+`, `-` or space), a
 *   header of mode 160000 (`new file mode`, `deleted file mode`, `old mode` and `new mode`), or an
 *   `index` line that ends in ` 160000`;
 * - a `Submodule` line, which git's `log` and `diff` formats print in place of a header, at the end of
 *   the section before it, lists a `submodule` under the empty name, whatever section holds it.
 *
 * A file is listed by the diff's own path, decoded, in the diff's order, once per file and reason. The
 * empty name stands for a part of the diff that no `diff --git` header names: the text before the
 * first header, a diff without such headers, a header that names no path quorum reads, and a
 * `Submodule` line. A readable header never names the empty path, so it is never a file's.
 *
 * Detection is generous: a line of the same form elsewhere, such as a commit message line of a
 * `format-patch` series, lists the file whose section holds it, since a gap it should not have stops a
 * review for a person to look, where a missed one would pass a change unread. The scope's `diff` is
 * the given string.
 */
export function reviewScope(diff: string): ReviewScope {
  const leftOut: LeftOutFile[] = []
  const listed: Record<LeftOutReason, Set<string>> = {
    binary: new Set(),
    submodule: new Set(),
  }
  const list = (file: string, reason: LeftOutReason): void => {
    if (listed[reason].has(file)) return
    listed[reason].add(file)
    leftOut.push({ file, reason })
  }
  for (const { path, text } of diffSections(diff)) {
    const markers = markersOf(text)
    if (markers.binary) list(path ?? '', 'binary')
    if (markers.submodule) list(path ?? '', 'submodule')
    if (markers.submoduleLine) list('', 'submodule')
  }
  return { diff, leftOut }
}

/** How a gap's detail names what it counts. */
const GAP_THINGS: Readonly<Record<LeftOutReason, string>> = {
  binary: 'binary file(s)',
  submodule: 'submodule(s)',
}

/** The gaps the files left out make for one profile: one per reason, binary then submodule, counting its files, and none for a reason with no file. */
export function leftOutGaps(profile: string, leftOut: readonly LeftOutFile[]): IncompleteEntry[] {
  return (['binary', 'submodule'] as const).flatMap((reason) => {
    const count = leftOut.filter(entry => entry.reason === reason).length
    return count === 0
      ? []
      : [
          {
            profile,
            reason,
            detail: `the diff carries no content for ${count} ${GAP_THINGS[reason]}, listed in meta.leftOut`,
          },
        ]
  })
}
