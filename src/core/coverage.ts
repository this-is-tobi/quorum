import { diffSections, movedTo } from './diff.ts'
import type { DiffSection } from './diff.ts'
import { isWholeDeletion, secretRuleOf } from './secrets.ts'
import type { IncompleteEntry, LeftOutFile, LeftOutReason, SecretRule } from './types.ts'

/** The reasons a diff itself lists a file for: a path review's `skipped` is a source's, never a diff's. */
type DiffReason = Exclude<LeftOutReason, 'skipped'>

/** The files a diff lists: each reason a diff gives, with the rule of a held file. */
type DiffEntry = Extract<LeftOutFile, { reason: DiffReason }>

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

/** What a review covers of a diff: the diff every stage reads, and the files it leaves out. */
export interface ReviewScope {
  /** The diff every stage reads: the given one less the excluded and the held sections. */
  readonly diff: string
  /** The files left out, excluded, held as secrets or with a change the diff does not carry, in the diff's order, once per file and reason. */
  readonly leftOut: LeftOutFile[]
  /** Every file of the given diff, excluded and held ones too, in the diff's order, once each: '' for the text no header names, none for a blank preamble. */
  readonly files: string[]
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

/** What holds a file back: the first rule any of its sections gives, and whether it is a file named as a secret that the change deletes whole. */
interface Held {
  readonly rule: SecretRule
  deletion: boolean
}

/**
 * The files to hold back among the sections to judge, by file (the sections of one path; '' for the text
 * no header names). A file is held by the first rule found, in the diff's order, one section's name before
 * its content, and holds every section of it. It is a deletion, which is no gap, only when its rule is
 * `name` and every section of it is a whole deletion: a file named as a secret holds no code a review
 * would read. A file held for a credential in it may be code, and the removed lines of a deleted source
 * file are the code a review would read, so a deletion of one is held as a gap like any other.
 */
function heldFiles(judged: readonly DiffSection[]): Map<string, Held> {
  const held = new Map<string, Held>()
  for (const section of judged) {
    const file = section.path ?? ''
    if (held.has(file)) continue
    const rule = secretRuleOf(section)
    if (rule !== undefined) held.set(file, { rule, deletion: rule === 'name' })
  }
  for (const { path, text } of judged) {
    const file = held.get(path ?? '')
    if (file !== undefined && file.deletion) file.deletion = isWholeDeletion(text)
  }
  return held
}

/**
 * What a review covers of a diff: the files `excluded` leaves out, the files held back as secrets, and the
 * files whose change the diff does not carry, found from the markers git prints in their place, each
 * section read line by line (a trailing `\r` is dropped), so a Windows-made diff reads as any other. In
 * each section:
 * - a `binary` file shows as a line that starts with `Binary files ` and ends with ` differ`, or one
 *   that starts with `GIT binary patch`;
 * - a `submodule` shows as a `Subproject commit` row (past at most one leading `+`, `-` or space), a
 *   header of mode 160000 (`new file mode`, `deleted file mode`, `old mode` and `new mode`), or an
 *   `index` line that ends in ` 160000`;
 * - a `Submodule` line, which git's `log` and `diff` formats print in place of a header, at the end of
 *   the section before it, lists a `submodule` under the empty name, whatever section holds it.
 *
 * A file is listed by the diff's own path, decoded, in the diff's order, once per file and reason.
 * `excluded` is asked once per distinct path a header names; a section it takes is listed as
 * `excluded`, leaves the scope's `diff` and has its own markers left unread, but its `Submodule`
 * lines still list their submodule, since such a line belongs to no section. Nothing a header does
 * not name is ever excluded: the text before the first header, a diff without such headers and a
 * header that names no path quorum reads.
 *
 * A header can read two ways: git does not quote a path that holds a space, so a rename's header
 * (`a/src/auth.js b/src/x b/dist/auth.js`) can name a path the file does not have. A section is
 * therefore excluded only when every `rename to` and `copy to` line it holds names the header's
 * path, as `movedTo` reads them; otherwise it is kept, as a header quorum cannot read is, its markers
 * read and its text sent. A forged line, such as a `format-patch` series carries in the next mail's
 * message, can then only make quorum exclude less. That next mail's headers and message sit at the
 * end of the previous file's section and leave with it when that file is excluded: no code hides
 * there, since `git am` applies only the patch sections, and a `Submodule` line still counts.
 *
 * The empty name stands for a part of the diff that no `diff --git` header names: the text before the
 * first header, a diff without such headers, a header that names no path quorum reads, and a `Submodule`
 * line. A readable header never names the empty path, so it is never a file's.
 *
 * A file is held back when its name is a secret's, by any path its section names (its header, its `---`
 * and `+++` lines, its `rename` and `copy` lines), or a line of it, removed and context lines included,
 * holds a credential quorum recognizes (`secretRuleOf`). One file has one verdict: the sections of one
 * path are one file, held by the first rule found in the diff's order, so when any of them is held every
 * one leaves the scope's `diff`, and a credential in one holds the others. The file is listed once, at
 * its first section, as `secret` with its `rule`, or as `deleted-secret` when its rule is `name` and every
 * section of it is a whole deletion (`isWholeDeletion`): the change then adds no code, and the file is no
 * gap. A deletion of a file held for a credential in it is `secret` and a gap, since the code it removes
 * would go unread, as an edit of it would. A held section's own markers are left unread, as an excluded
 * one's are, so a held binary file is listed `secret` only; its `Submodule` lines still list their
 * submodule. The empty name is a file like any
 * other: the text before the first header, a diff without such headers and a header quorum cannot read
 * are held whole by one verdict.
 *
 * The order is: `excluded` first, so an excluded file is listed `excluded` only and judged no further;
 * then `sent`, asked of each path a header names and never of the empty name, which sends a file whatever
 * would hold it, so it is neither held nor listed; then the hold.
 *
 * The scope's `files` names every section's file as it is read, once each, in the diff's order, the held
 * ones too: the empty name for the text no header names, and again, after the section that holds one, for
 * a `Submodule` line; a preamble that is blank names no file.
 *
 * Detection is generous: a line of the same form elsewhere, such as a commit message line of a
 * `format-patch` series, lists the file whose section holds it, and a hit anywhere in a file holds all
 * of it, since a gap it should not have stops a review for a person to look, where a missed one would
 * pass a change unread. The scope's `diff` is the given string itself when no section was excluded or
 * held, the kept sections joined by line feeds when some were, and '' when every section was.
 */
export function reviewScope(diff: string, excluded: (path: string) => boolean = () => false, sent: (path: string) => boolean = () => false): ReviewScope {
  const leftOut: LeftOutFile[] = []
  const listed: Record<DiffReason, Set<string>> = {
    excluded: new Set(),
    binary: new Set(),
    submodule: new Set(),
    secret: new Set(),
    'deleted-secret': new Set(),
  }
  const list = (entry: DiffEntry): void => {
    if (listed[entry.reason].has(entry.file)) return
    listed[entry.reason].add(entry.file)
    leftOut.push(entry)
  }
  const answers = new Map<string, boolean>()
  const isExcluded = (path: string): boolean => {
    let answer = answers.get(path)
    if (answer === undefined) {
      answer = excluded(path)
      answers.set(path, answer)
    }
    return answer
  }
  /** The path of a section `excluded` takes, or undefined for any other. */
  const excludedPath = ({ path, text }: DiffSection): string | undefined => path !== undefined && path !== '' && isExcluded(path) && movedTo(text).every(moved => moved === path)
    ? path
    : undefined
  /** Whether the input sends the file of a section: only a path a header names can be sent, never the empty name. */
  const isSent = ({ path }: DiffSection): boolean => path !== undefined && path !== '' && sent(path)
  const files = new Set<string>()
  const sections = diffSections(diff)
  const held = heldFiles(sections.filter(section => excludedPath(section) === undefined && !isSent(section)))
  const kept: string[] = []
  for (const section of sections) {
    const { path, text } = section
    const markers = markersOf(text)
    if (path !== '' || text.trim() !== '') files.add(path ?? '')
    const gone = excludedPath(section)
    const hold = held.get(path ?? '')
    if (gone !== undefined) {
      list({ file: gone, reason: 'excluded' })
    } else if (hold !== undefined) {
      list({
        file: path ?? '',
        reason: hold.deletion ? 'deleted-secret' : 'secret',
        rule: hold.rule,
      })
    } else {
      kept.push(text)
      if (markers.binary) list({ file: path ?? '', reason: 'binary' })
      if (markers.submodule) list({ file: path ?? '', reason: 'submodule' })
    }
    if (markers.submoduleLine) {
      list({ file: '', reason: 'submodule' })
      files.add('')
    }
  }
  return {
    diff: kept.length === sections.length
      ? diff
      : kept.join('\n'),
    leftOut,
    files: [...files],
  }
}

/** The reasons of the gaps a diff's own files make for a profile, in the order they are recorded. A file excluded, skipped, or named as a secret and deleted whole, is no gap. */
const GAP_REASONS = ['binary', 'submodule', 'secret'] as const

/** What a gap's detail says of its `count` files. */
const GAP_DETAILS: Readonly<Record<typeof GAP_REASONS[number], (count: number) => string>> = {
  binary: count => `the diff carries no content for ${count} binary file(s), listed in meta.leftOut`,
  submodule: count => `the diff carries no content for ${count} submodule(s), listed in meta.leftOut`,
  secret: count => `no model was sent ${count} file(s) held as secrets, listed in meta.leftOut`,
}

/** The gaps the files left out make for one profile: one per reason, binary then submodule then secret, counting its files, and none for a reason with no file. A `deleted-secret` file is no gap. */
export function leftOutGaps(profile: string, leftOut: readonly LeftOutFile[]): IncompleteEntry[] {
  return GAP_REASONS.flatMap((reason) => {
    const count = leftOut.filter(entry => entry.reason === reason).length
    return count === 0
      ? []
      : [
          {
            profile,
            reason,
            detail: GAP_DETAILS[reason](count),
          },
        ]
  })
}
