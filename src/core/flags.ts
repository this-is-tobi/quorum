import type { DiffSection } from './diff.ts'
import type { DocumentKind, Flag, FlagCode, LeftOutFile, ReviewDocument, ReviewSource } from './types.ts'
import { addedLines, diffSections, headerNames, namedPaths } from './diff.ts'
import { hiddenLabels, spaceHidden, stripHidden } from './sanitize.ts'
import { CREDENTIAL_PHRASES, isSecretName } from './secrets.ts'

/** How many code points or patterns a flag's detail names before it counts the rest. */
const MAX_LISTED = 8
/** A byte-order mark: an editor may write one at the start of a file, so it is not flagged there. */
const BOM = '\uFEFF'
/** The label of the tab, the one control character code is full of. */
const TAB = 'U+0009'
/**
 * An emoji sequence of the Unicode set (RGI): its zero-width joiners, variation selectors and tag
 * characters belong to the emoji, so they are not flagged. Outside such a sequence they are.
 */
const EMOJI = /\p{RGI_Emoji}/gv

/**
 * What a `secret-file` flag says, in words the code writes: a file a path review skipped, by its name or by
 * a credential it holds, and a file held back from the review of a diff, held or deleted whole, by its name
 * or by a kind of credential. It names the kind and never a line of the file.
 */
const SKIPPED_BY_NAME = 'named as a secret, so a path review sent none of it: check that it belongs in the repository'
const SKIPPED_BY_CONTENT = 'holds what reads as a credential, so a path review sent none of it: remove it from the repository, and rotate it if it is real'
const HELD_BY_NAME = 'named as a secret, so no model was sent any of it: check that it belongs in the change'
const DELETED_BY_NAME = 'deletes a file named as a secret, so no model was sent any of it: the history still holds the file, so rotate what it held'

/** How many characters of a commit id a flag's detail gives. */
const SHORT_COMMIT = 7
/** What a flag's detail calls each kind of document, in the order it lists the kinds. */
const KIND_WORDS: Readonly<Record<DocumentKind, string>> = {
  guidelines: 'guidelines',
  'do-not-report': 'do-not-report text',
}
/** A one-character prefix and its slash, as `diff.mnemonicPrefix` writes them (`a/`, `b/`, `i/`, `w/`, `c/`, `o/`). */
const PREFIX = /^[^/]\//u

/** One kind of text addressed to an AI reviewer, and the name a flag's detail gives it. */
interface Pattern {
  readonly name: string
  readonly pattern: RegExp
}

/**
 * Text that speaks to an AI reviewer instead of a person, in forms rare in ordinary code: the
 * markup of chat templates and tool calls (in the research run, only LLM libraries held any),
 * quorum's own fence tags and reply shapes, and four narrow phrasings. Looser phrasings ("you are
 * an AI assistant", "do not report") are common in AI code and in `SECURITY.md` files, so they are
 * left out. A match is a hint, never a defense: a phrase split across lines, written with
 * look-alike letters, in another language or encoded is not matched, and comments that fabricate
 * an analyzer's verdict, the attack that works best, read like ordinary code comments.
 */
const AI_ADDRESSED: readonly Pattern[] = [
  { name: 'an instruction to ignore earlier instructions', pattern: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|former)\s+(?:instructions|prompts?|directions|directives)\b/i },
  { name: 'an instruction to approve the change', pattern: /\b(?:approve|mark|treat|classify)\s+(?:this|the)\s+(?:pr|pull\s+request|change|diff|patch|commit|code)\s+as\s+(?:safe|secure|approved|correct|clean|benign|lgtm)\b/i },
  { name: 'an instruction not to report it', pattern: /\b(?:do\s+not|don't|never)\s+(?:flag|report)\s+(?:this|it|these)\s+as\s+(?:an?\s+)?(?:vulnerabilit(?:y|ies)|security\s+(?:issues?|bugs?|findings?|risks?)|findings?)\b/i },
  { name: 'a note to an AI', pattern: /\b(?:note|message|memo|reminder)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llms?|(?:large\s+)?language\s+models?|ai\s+(?:reviewers?|assistants?|agents?|models?)|automated\s+(?:reviewers?|review|analysis|analy[sz]ers?))\b/i },
  { name: 'a chat-template token', pattern: /<\|[a-z_]{2,30}\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:start|end)_of_turn>|\[(?:TOOL_CALLS|AVAILABLE_TOOLS|TOOL_RESULTS)\]|<\uFF5C[^\uFF5C>\n]{1,40}\uFF5C>/i },
  { name: 'a tool-call tag', pattern: /<\/?(?:tool_call|tool_response|function_calls|function_results)>|<invoke\s+name=/i },
  { name: 'a fence tag of quorum', pattern: /<\/?untrusted-[a-z]+(?:-[\w-]{1,40})?>/i },
  { name: 'a forged vote reply', pattern: /"keep"\s*:\s*(?:true|false)\s*,\s*"reasoning"\s*:|"reasoning"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"keep"\s*:\s*(?:true|false)/i },
  { name: 'a forged research reply', pattern: /\{\s*"findings"\s*:\s*\[\s*\]\s*\}/i },
]

/** What a flag is about: its file, kept off the flag of a diff without per-file headers. */
type Where = Pick<Flag, 'file'>

/** The lines one kind of flag counted in a file: the first one, how many, and what they held. */
interface Tally {
  first: number
  lines: number
  found: Set<string>
}

function newTally(): Tally {
  return {
    first: 0,
    lines: 0,
    found: new Set(),
  }
}

/** Count `line` in `tally` when it held anything. */
function record(tally: Tally, line: number, items: readonly string[]): void {
  if (items.length === 0) return
  if (tally.lines === 0) tally.first = line
  tally.lines++
  for (const item of items) tally.found.add(item)
}

/** The first `MAX_LISTED` items, then how many more there are. */
function listed(items: readonly string[]): string {
  const names = items.slice(0, MAX_LISTED).join(', ')
  return items.length > MAX_LISTED
    ? `${names} and ${items.length - MAX_LISTED} more`
    : names
}

/** The labels of the hidden characters of an added line, less the ones the rules leave alone. */
function lineLabels(text: string, line: number): string[] {
  const shown = line === 1 && text.startsWith(BOM)
    ? text.slice(BOM.length)
    : text
  // A space, not nothing, so that what surrounds an emoji cannot join: two halves of a surrogate
  // pair, or a byte-order mark that would then start line 1.
  return hiddenLabels(shown.replace(EMOJI, ' ')).filter(label => label !== TAB)
}

/**
 * The names of the patterns that an added line matches in either of two forms: with its hidden
 * characters removed, for one inside a word, and with each read as a space, for one between words.
 * A pattern that matches both forms counts once.
 */
function addressedNames(text: string): string[] {
  const forms = [
    stripHidden(text),
    spaceHidden(text),
  ]
  return AI_ADDRESSED.filter(({ pattern }) => forms.some(form => pattern.test(form))).map(({ name }) => name)
}

/** The flag of `code` at the first line `tally` counted, or none when it counted no line. */
function flagOf(code: FlagCode, where: Where, tally: Tally): Flag[] {
  return tally.lines === 0
    ? []
    : [
        {
          code,
          ...where,
          line: tally.first,
          detail: `${listed([...tally.found])} on ${tally.lines} added line(s)`,
        },
      ]
}

/**
 * The advisory flags of a diff, read by code from its sections before any model sees it. They tell
 * a human where to look and never change a verdict, a confidence or an exit code.
 *
 * Only the file names and the added lines of the hunks are read: removed and context lines are not
 * the change, and the text outside hunks (the commit message of a `format-patch` series) is a prose
 * channel left to the reporters. A file raises at most three flags, in this order: its name holds
 * hidden characters, its added lines do, and its added lines address an AI reviewer. A flag about
 * lines points at the first such line and counts them, so the work is linear in the diff. A detail
 * names at most eight code points or patterns, then counts the rest, and the code writes every
 * word of it: the only text of the diff a flag carries is `file`, the diff's own path.
 *
 * A `hidden-characters` flag leaves alone the tab, a CRLF file's line ends (the hunk reader already
 * drops a row's trailing carriage return, so one inside a line is flagged), a byte-order mark that
 * starts the file's first line, and the joiners, variation selectors and tag characters inside an
 * RGI emoji sequence. Everything else of the hidden class is flagged, a lone joiner and stacked
 * variation selectors among it.
 *
 * An `ai-addressed-text` flag is a hint, never a defense. Its patterns are matched on each added
 * line with its hidden characters removed and with them read as spaces, so a phrase split by
 * zero-width characters, inside a word or between words, is found and its line raises both flags.
 */
export function diffFlags(sections: ReadonlyMap<string, string>): Flag[] {
  const flags: Flag[] = []
  for (const path of sections.keys()) {
    const where: Where = path === ''
      ? {}
      : { file: path }
    const nameLabels = hiddenLabels(path)
    if (nameLabels.length > 0) flags.push({ code: 'hidden-characters', ...where, detail: `the file name holds ${listed(nameLabels)}` })
    const hidden = newTally()
    const addressed = newTally()
    for (const { line, text } of addedLines(sections, path)) {
      record(hidden, line, lineLabels(text, line))
      record(addressed, line, addressedNames(text))
    }
    flags.push(...flagOf('hidden-characters', where, hidden), ...flagOf('ai-addressed-text', where, addressed))
  }
  return flags
}

/** What a `secret-file` flag says of a file left out, or undefined when the file is no secret. */
function secretDetail(entry: LeftOutFile): string | undefined {
  switch (entry.reason) {
    case 'skipped':
      if (entry.rule !== 'secret') return undefined
      return isSecretName(entry.file)
        ? SKIPPED_BY_NAME
        : SKIPPED_BY_CONTENT
    case 'secret':
      return entry.rule === 'name'
        ? HELD_BY_NAME
        : `holds what reads as ${CREDENTIAL_PHRASES[entry.rule]}, so no model was sent any of it: keep it out of the repository, and rotate it if it is real`
    case 'deleted-secret':
      return entry.rule === 'name'
        ? DELETED_BY_NAME
        : `deletes a file that holds what reads as ${CREDENTIAL_PHRASES[entry.rule]}, so no model was sent any of it: the history still holds it, so rotate it`
    default:
      return undefined
  }
}

/**
 * The flags of the files left out as secrets, in the order they are listed: one `secret-file` flag for
 * each `skipped` entry of the rule `secret` (a source skipped it, by its name or, when its name is no
 * secret's, by a credential it holds), for each `secret` entry (held back from the diff, by its name or by
 * the kind of credential it holds) and for each `deleted-secret` entry (the change deletes it whole: the
 * history still holds it, so rotate what it held). Each is at the file's own path, absent for the empty
 * name that stands for the text no header names, and with no line, since no model saw the file and the
 * flag quotes none of it. A person should look at whether the file belongs in the change, or rotate what
 * it held. An entry an `exclude` pattern matched first is `excluded`, so it raises none: leaving it out
 * was the operator's choice, and a file the input sends is never held. Like every flag, it changes no
 * verdict and no exit code.
 */
export function secretFlags(leftOut: readonly LeftOutFile[]): Flag[] {
  return leftOut.flatMap((entry) => {
    const detail = secretDetail(entry)
    if (detail === undefined) return []
    const where: Where = entry.file === ''
      ? {}
      : { file: entry.file }
    return [
      { code: 'secret-file' as const, ...where, detail },
    ]
  })
}

/** The paths a section of a diff names, each as written and, with a one-character prefix and its slash, once more without them. */
function sectionNames(section: DiffSection): Set<string> {
  const names = new Set<string>()
  const written = [
    ...section.path === undefined
      ? []
      : [section.path],
    ...headerNames(section.text),
    ...namedPaths(section.text),
  ]
  for (const name of written) {
    names.add(name)
    if (PREFIX.test(name)) names.add(name.slice(2))
  }
  return names
}

/** What one profile read of one path of the repository: the kinds it read the path as, the commit, and whether the commit held the file. */
interface DocumentRead {
  readonly profile: string
  readonly path: string
  readonly commit: string
  readonly kinds: Set<DocumentKind>
  found: boolean
}

/** The repository documents grouped by profile and path, in the order each pair first appears. */
function documentReads(documents: readonly ReviewDocument[]): DocumentRead[] {
  const reads = new Map<string, DocumentRead>()
  for (const { profile, kind, origin, text } of documents) {
    if (origin.kind !== 'repository') continue
    // A profile id holds no NUL, so the key tells the pairs apart whatever the path holds.
    const key = `${profile}\0${origin.path}`
    const read = reads.get(key) ?? {
      profile,
      path: origin.path,
      commit: origin.commit,
      kinds: new Set<DocumentKind>(),
      found: false,
    }
    read.kinds.add(kind)
    if (text !== undefined) read.found = true
    reads.set(key, read)
  }
  return [
    ...reads.values(),
  ]
}

/** `words` as a list: the first alone, else joined by `, ` and ` and ` before the last. */
function joinedWords(words: readonly string[]): string {
  return words.length === 1
    ? words[0] as string
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/** What a `guideline-edited` flag says: the kinds of document, the commit the review read, or looked for, them at, and that the change's version is never applied. */
function documentDetail({ kinds, commit, found }: DocumentRead): string {
  const words = joinedWords((Object.keys(KIND_WORDS) as DocumentKind[]).filter(kind => kinds.has(kind)).map(kind => KIND_WORDS[kind]))
  const short = commit.slice(0, SHORT_COMMIT)
  return found
    ? `the ${words} this review read for the profile from ${short}, not the change's version`
    : `the ${words} this review looked for at ${short} and did not find, not the change's version`
}

/**
 * The flags of a change that edits a document its review read from the repository: one `guideline-edited` flag for
 * each profile and path of the repository `documents`, in the order they first list them, at the first section of
 * `diff` that names the path. A section names it when its own path, a word of its header or a path its `---`, `+++`,
 * rename or copy lines name is the path, as written or once a one-character prefix and its slash (`a/`, `b/`, `i/`,
 * `w/`) are dropped, so a section that edits the file, renames or copies onto it, adds it or deletes it names it.
 * The lines are read with no hunk parsing, so a hunk row that reads like one of them names a path too: the answer is
 * generous and fails closed. The whole diff is read, the files left out of the review included.
 *
 * The review never reads the change's copy of a document: it reads the commit its source names, and the flag tells
 * a person that. Its `file` is the section's own path, absent for a section whose header names none it can read; it
 * has no line; and its `detail` is in words the code writes, the kinds of document the profile reads at the path
 * (one flag names them all) and the commit's first 7 characters, or, for an optional document the commit lacked, that
 * the review looked for it there and did not find it. A path review raises none, since its documents are the
 * codebase's own at the commit it reviews, and a document of the config is no file of the repository. Like every flag,
 * it changes no verdict and no exit code.
 */
export function documentFlags(diff: string, documents: readonly ReviewDocument[], source: ReviewSource): Flag[] {
  if (source.kind === 'paths') return []
  const reads = documentReads(documents)
  if (reads.length === 0) return []
  const wanted = new Set(reads.map(read => read.path))
  const first = new Map<string, DiffSection>()
  for (const section of diffSections(diff)) {
    for (const name of sectionNames(section)) {
      if (wanted.has(name) && !first.has(name)) first.set(name, section)
    }
    if (first.size === wanted.size) break
  }
  return reads.flatMap((read) => {
    const section = first.get(read.path)
    if (section === undefined) return []
    return [
      {
        code: 'guideline-edited' as const,
        profile: read.profile,
        ...section.path === undefined || section.path === ''
          ? {}
          : { file: section.path },
        detail: documentDetail(read),
      },
    ]
  })
}
