import type { Flag, FlagCode } from './types.ts'
import { addedLines } from './diff.ts'
import { hiddenLabels, stripHidden } from './sanitize.ts'

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

/** One kind of text addressed to an AI reviewer, and the name a flag's detail gives it. */
interface Pattern {
  readonly name: string
  readonly pattern: RegExp
}

/**
 * Text that speaks to an AI reviewer instead of a person, in forms rare in ordinary code: the
 * markup of chat templates and tool calls (in the research run, only LLM libraries held any),
 * quorum's own fence tags and reply shapes, and three narrow phrasings. Looser phrasings ("you are
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
  { name: 'a fence tag of quorum', pattern: /<\/?untrusted-[a-z]+-[0-9a-f]{8}>/i },
  { name: 'a forged vote reply', pattern: /"keep"\s*:\s*(?:true|false)\s*,\s*"reasoning"\s*:/ },
  { name: 'a forged research reply', pattern: /\{\s*"findings"\s*:\s*\[\s*\]\s*\}/ },
]

/** What a flag is about: its file, kept off the flag of a diff without per-file headers. */
type Where = Pick<Flag, 'file'>

/** The lines one kind of flag counted in a file: the first one, how many, and what they held. */
interface Tally {
  first: number
  lines: number
  found: Set<string>
}

const newTally = (): Tally => ({ first: 0, lines: 0, found: new Set() })

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
  return items.length > MAX_LISTED ? `${names} and ${items.length - MAX_LISTED} more` : names
}

/** The labels of the hidden characters of an added line, less the ones the rules leave alone. */
function lineLabels(text: string, line: number): string[] {
  const shown = line === 1 && text.startsWith(BOM) ? text.slice(BOM.length) : text
  // A space, not nothing, so that what surrounds an emoji cannot join: two halves of a surrogate pair, or a byte-order mark that would then start line 1.
  return hiddenLabels(shown.replace(EMOJI, ' ')).filter(label => label !== TAB)
}

/** The names of the patterns that an added line matches, once its hidden characters are removed. */
function addressedNames(text: string): string[] {
  const visible = stripHidden(text)
  return AI_ADDRESSED.filter(({ pattern }) => pattern.test(visible)).map(({ name }) => name)
}

function flagOf(code: FlagCode, where: Where, tally: Tally): Flag[] {
  return tally.lines === 0 ? [] : [{ code, ...where, line: tally.first, detail: `${listed([...tally.found])} on ${tally.lines} added line(s)` }]
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
 * line without its hidden characters, so a phrase split by zero-width characters is found and its
 * line raises both flags.
 */
export function diffFlags(sections: ReadonlyMap<string, string>): Flag[] {
  const flags: Flag[] = []
  for (const path of sections.keys()) {
    const where: Where = path === '' ? {} : { file: path }
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
