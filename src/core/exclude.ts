import type { ConfigIssue } from './errors.ts'

/** The most patterns `exclude` may hold. */
export const MAX_PATTERNS = 100
/** The longest pattern, in characters. */
export const MAX_PATTERN_LENGTH = 256
/** What a list of more than `MAX_PATTERNS` patterns is told. */
export const TOO_MANY_PATTERNS = `must hold at most ${MAX_PATTERNS} patterns`

const STAR = 0x2A
const QUESTION = 0x3F
const HIGH_SURROGATES = [0xD800, 0xDBFF] as const
const LOW_SURROGATES = [0xDC00, 0xDFFF] as const
const WHOLE_DIRECTORIES = '**'

/** How many code units the character at `at` takes: 2 for a surrogate pair, else 1. */
function width(text: string, at: number): number {
  const unit = text.charCodeAt(at)
  if (unit < HIGH_SURROGATES[0] || unit > HIGH_SURROGATES[1]) return 1
  const next = text.charCodeAt(at + 1)
  return next >= LOW_SURROGATES[0] && next <= LOW_SURROGATES[1]
    ? 2
    : 1
}

/** The segments of a pattern with a `/` in it: those of the pattern less one leading `/`. */
function anchoredSegments(pattern: string): string[] {
  return (pattern.startsWith('/')
    ? pattern.slice(1)
    : pattern).split('/')
}

/**
 * The first problem with a pattern, with what to write instead, or undefined when it can be taken.
 * The problems come in this order: empty, too long, a `\`, a `!`, a `{`, a trailing `/`, and a `**`
 * inside a name (a segment other than `**` that holds it). A pattern that would exclude something
 * other than what its author meant is refused rather than guessed at. No message repeats the pattern.
 */
export function patternProblem(pattern: string): string | undefined {
  if (pattern === '') return 'must not be empty'
  if (pattern.length > MAX_PATTERN_LENGTH) return `must be at most ${MAX_PATTERN_LENGTH} characters long`
  if (pattern.includes('\\')) return 'holds \\, which escapes nothing here: write / between directories, and every other character as it is'
  if (pattern.includes('!')) return 'holds !, which negates nothing here: list only the paths to leave out'
  if (pattern.includes('{')) return 'holds {, which lists no alternatives here: write one pattern for each'
  if (pattern.endsWith('/')) return 'ends with /, so it matches no file: end it with /** to leave out what the directory holds'
  if (anchoredSegments(pattern).some(segment => segment !== WHOLE_DIRECTORIES && segment.includes(WHOLE_DIRECTORIES))) {
    return 'holds ** inside a name: ** stands for whole directories, as in **/*.min.js, and * for any characters of a name'
  }
  return undefined
}

/**
 * Every problem with a value given as `exclude`, so an untyped caller gets issues, never a
 * TypeError: none when it is unset, `exclude: must be an array`, `exclude: must hold at most 100
 * patterns` (the entries are then not read), or, for each entry, `exclude.<index>` with `must be a
 * string` or the pattern's own problem.
 */
export function excludeIssues(value: unknown): ConfigIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    return [
      { path: 'exclude', message: 'must be an array' },
    ]
  }
  if (value.length > MAX_PATTERNS) {
    return [
      { path: 'exclude', message: TOO_MANY_PATTERNS },
    ]
  }
  // `Array.from` reads a hole as `undefined`, so it is reported like any other entry that is not a string.
  return Array.from<unknown>(value).flatMap((pattern, index) => {
    const problem = typeof pattern === 'string'
      ? patternProblem(pattern)
      : 'must be a string'
    return problem === undefined
      ? []
      : [
          { path: `exclude.${index}`, message: problem },
        ]
  })
}

/**
 * Whether `glob`, where `*` stands for any run of characters and `?` for one (a surrogate pair
 * counts once), matches the whole of `name`; every other character is literal and case counts. It
 * is the greedy algorithm: it goes back to the last `*` only, so it takes at most as many steps as
 * the glob has characters times the name has, whatever the two hold. It compares code units, since
 * indexing a string allocates a string per character on Bun.
 */
export function matchName(glob: string, name: string): boolean {
  let g = 0
  let n = 0
  let star = -1
  let mark = 0
  while (n < name.length) {
    if (g < glob.length && glob.charCodeAt(g) === STAR) {
      star = g++
      mark = n
    } else if (g < glob.length && glob.charCodeAt(g) === QUESTION) {
      g++
      n += width(name, n)
    } else if (g < glob.length && glob.charCodeAt(g) === name.charCodeAt(n)) {
      g++
      n++
    } else if (star !== -1) {
      g = star + 1
      mark += width(name, mark)
      n = mark
    } else {
      return false
    }
  }
  while (g < glob.length && glob.charCodeAt(g) === STAR) g++
  return g === glob.length
}

/** Whether the segments of a pattern, `**` standing for any number of directories, match all the segments of a path: `matchName`'s loop, over segments. */
function matchPath(pattern: readonly string[], path: readonly string[]): boolean {
  let p = 0
  let s = 0
  let star = -1
  let mark = 0
  while (s < path.length) {
    if (p < pattern.length && pattern[p] === WHOLE_DIRECTORIES) {
      star = p++
      mark = s
    } else if (p < pattern.length && matchName(pattern[p], path[s])) {
      p++
      s++
    } else if (star !== -1) {
      p = star + 1
      mark++
      s = mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === WHOLE_DIRECTORIES) p++
  return p === pattern.length
}

/**
 * The segments a checked pattern matches a path by: no `/` in it reads as `**` then the pattern, so
 * it matches a file's name in any directory; else the pattern less one leading `/`, matched from the
 * root; a last segment `**` gains `*` after it, so `dir/**` holds what is inside `dir` and never a
 * file named `dir`; consecutive `**` collapse into one.
 */
function segmentsOf(pattern: string): string[] {
  const segments = pattern.includes('/')
    ? anchoredSegments(pattern)
    : [WHOLE_DIRECTORIES, pattern]
  if (segments.at(-1) === WHOLE_DIRECTORIES) segments.push('*')
  return segments.filter((segment, index) => segment !== WHOLE_DIRECTORIES || segments[index - 1] !== WHOLE_DIRECTORIES)
}

/**
 * The test of a path against checked patterns, each compiled once into its segments: `*` and `?`
 * inside a name, `**` for whole directories, every other character literal and case-sensitive, and
 * no pattern ever becomes a regular expression. The paths come from the diff, so an attacker
 * controls them, and a matcher that backtracks would hang the review: this one is greedy, going back
 * to the last star only. One pattern and one path cost at most as many steps as the pattern has
 * characters times the path has, so with the caps (100 patterns of 256 characters) a review's
 * matching costs at most 25 600 steps per character of path text, and an ordinary pattern a few.
 * The matcher keeps no reference to the array it was given.
 */
export function excludeMatcher(patterns: readonly string[]): (path: string) => boolean {
  const compiled = patterns.map(segmentsOf)
  if (compiled.length === 0) return () => false
  return (path) => {
    const parts = path.split('/')
    return compiled.some(segments => matchPath(segments, parts))
  }
}
