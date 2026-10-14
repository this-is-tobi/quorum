const GIT_HEADER = 'diff --git '
const HEADER_PATH = /^diff --git "?a\/.+ "?b\/(.+?)"?$/
const PATH_PREFIX = /^(?:[ab]\/|\.\/)/

/**
 * Split a git-style unified diff into sections keyed by file path. Only `diff --git` lines open a
 * section: inside a hunk every line starts with ' ', '+', '-' or '\', so that text cannot appear
 * there. Outside hunks it can (a `format-patch` series carries unindented commit messages), so a
 * path seen more than once keeps every occurrence, in order, rather than the last one winning.
 * A diff without such headers (plain `diff -u` output) comes back as one section keyed '' rather
 * than risk a wrong split.
 */
export function splitDiff(diff: string): Map<string, string> {
  const sections = new Map<string, string>()
  let path = ''
  let lines: string[] = []
  const flush = (): void => {
    if (lines.length === 0) return
    const text = lines.join('\n')
    const previous = sections.get(path)
    sections.set(path, previous === undefined ? text : `${previous}\n${text}`)
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith(GIT_HEADER)) {
      flush()
      path = HEADER_PATH.exec(line)?.[1] ?? ''
      lines = []
    }
    lines.push(line)
  }
  flush()
  return sections
}

/**
 * The diff a voter needs for `file`: the exact section first, then a unique path-suffix match
 * (models often shorten paths); the whole diff when nothing, or more than one section, matches.
 */
export function diffSectionFor(sections: ReadonlyMap<string, string>, file: string, wholeDiff: string): string {
  const wanted = file.trim().replace(PATH_PREFIX, '')
  const exact = sections.get(wanted)
  if (exact !== undefined) return exact
  const candidates = [...sections.keys()].filter(path => path !== '' && (path.endsWith(`/${wanted}`) || wanted.endsWith(`/${path}`)))
  return candidates.length === 1 ? sections.get(candidates[0]) ?? wholeDiff : wholeDiff
}
