import { z } from 'zod'
import { OutputError } from './errors.ts'
import { HIDDEN_CLASS } from './sanitize.ts'
import type { FindingDetails, Vote } from './types.ts'

/**
 * Keywords outside the portable subset every schema mode accepts: numeric and string constraints, and
 * `format`. Strict modes refuse some of them (Anthropic documents numeric constraints as unsupported),
 * and zod still enforces each one on the reply.
 */
const NON_PORTABLE_KEYWORDS: ReadonlySet<string> = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format'])

/** Wire shape of one finding. Semantic checks (line >= 1, non-empty file) run after parsing. */
const FindingReplySchema = z.object({
  file: z.string(),
  line: z.int(),
  category: z.string(),
  quote: z.string(),
  summary: z.string(),
})

/** Wire shape of a vote. There is deliberately no confidence field: confidence is computed, never self-reported. */
const VoteReplySchema = z.object({
  keep: z.boolean(),
  reasoning: z.string(),
})

const ResearchReplySchema = z.object({ findings: z.array(FindingReplySchema) })

/** JSON Schemas shown to the model; they stay free of transforms so zod can always emit them. */
export const researchReplyJsonSchema = toWireSchema(ResearchReplySchema)
export const voteReplyJsonSchema = toWireSchema(VoteReplySchema)

const MAX_REPLY_CHARS = 1_000_000
const MAX_BRACE_GROUPS = 100
const DIGITS = /^\d+$/
/** A quote, brace or bracket: what the model's own continuation holds when planted text closed its object early. */
const JSON_SYNTAX = /["{}[\]]/
/** The scans below read character codes: on Bun's engine, indexing a string of non-Latin-1 text allocates a string per character. */
const QUOTE = 0x22
const COMMA = 0x2C
const OPEN_BRACKET = 0x5B
const BACKSLASH = 0x5C
const CLOSE_BRACKET = 0x5D
const OPEN_BRACE = 0x7B
const CLOSE_BRACE = 0x7D

/**
 * Pull the one JSON object out of a model reply. Models wrap JSON in prose, code fences or
 * reasoning blocks despite instructions, so this drops reasoning, ignores fence markers and scans
 * for balanced, parseable objects. It fails closed instead of guessing: a reply holding several
 * different objects is ambiguous (text echoed from the diff could pose as the answer); a group that
 * opens like a JSON object (`{`, then `"` or the end of the reply) but never closes or does not
 * parse means the reply is cut off or malformed (and an object quoted inside it, or echoed next to
 * it, could be planted); an object that repeats a key is refused, because `JSON.parse` keeps the
 * last value and text planted in an unescaped string could close that string early and supply it;
 * text after the answer that reads like JSON syntax (a quote, brace or bracket) is refused too,
 * because it is what the model's own continuation leaves behind when planted text closed a string
 * and the object early (a forced reject, a swayed summary, later findings swallowed). That works
 * only where the continuation is written: a server that enforces JSON stops generating when the
 * root object closes, so there a planted early close leaves nothing to refuse. For a vote the
 * structural answer is schema-enforced output with the verdict written first; for a research reply
 * no grammar or code rule can see findings that were never written; and a reply too large or too
 * noisy to scan cheaply is refused. Plain prose after the answer, fence markers and the same object
 * twice (a fenced copy next to a prose copy) are accepted. A group that opens like prose (`{`
 * followed by anything else) is skipped whole when it is balanced, except a bare wrapper
 * (`{{...}}`), and only stepped over when it never closes, as prose often holds a stray brace.
 *
 * @throws OutputError when the reply has no object, several different objects, a broken object, a repeated key, JSON syntax after the answer, or cannot be scanned safely
 */
export function extractJsonObject(text: string, stage: string): Record<string, unknown> {
  if (text.length > MAX_REPLY_CHARS) {
    throw new OutputError(stage, `reply is longer than ${MAX_REPLY_CHARS} characters`, text)
  }
  const { visible, truncatedAt } = withoutReasoning(text)
  const [first, ...copies] = topLevelObjects(visible, truncatedAt, stage, text)
  if (!first) throw new OutputError(stage, 'reply contains no JSON object', text)
  const key = JSON.stringify(first.value)
  if (copies.some(other => JSON.stringify(other.value) !== key)) {
    throw new OutputError(stage, 'reply contains several different JSON objects', text)
  }
  const at = syntaxAfterAnswer(visible, first, copies)
  if (at !== -1) {
    throw new OutputError(stage, `reply continues after its JSON object with text that reads like JSON syntax (at position ${at} of the reply with its closed reasoning blocks removed; text planted in a string could have closed the object early)`, text)
  }
  return first.value
}

/**
 * Index in `visible` of the first quote, brace or bracket written after the answer, not counting the
 * later copies of that answer (the text between copies is checked too); -1 when there is none.
 */
function syntaxAfterAnswer(visible: string, first: Answer, copies: Answer[]): number {
  let from = first.end + 1
  for (const copy of copies) {
    const found = visible.slice(from, copy.start).search(JSON_SYNTAX)
    if (found !== -1) return from + found
    from = copy.end + 1
  }
  const found = visible.slice(from).search(JSON_SYNTAX)
  return found === -1 ? -1 : from + found
}

/** A parsed research reply: the findings read, why the others among the ones read were dropped, and how many were listed in all. */
export interface ResearchReply {
  findings: FindingDetails[]
  /** One reason per finding, among the first `limit` listed, that is unreadable: it does not match the schema, or holds a nested object or array outside it. */
  invalid: string[]
  /** How many findings the reply listed, read or not. */
  listed: number
}

/**
 * Validate a research reply. The envelope must be exactly `{ findings: [...] }`: a missing or
 * non-array `findings` fails the run, because a malformed reply must never read as "no findings",
 * and so does any other top-level key, because text planted in an unescaped string could close
 * the findings array early and move the rest of the reply under a key of its own, where it would
 * be dropped without a trace. Only the first `limit` listed findings are read, so a flooded reply
 * costs bounded work; each of those that does not match the schema, or holds a nested object or
 * array under a key the schema does not name (where findings swallowed by planted text would hide,
 * since the schema strips unknown keys), is reported with its index, and the count of listed
 * findings lets the caller record what was not read. `limit` must be a positive integer, or
 * Infinity to read every listed finding.
 */
export function parseResearchReply(text: string, limit = Infinity): ResearchReply {
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new RangeError(`limit must be a positive integer or Infinity, got ${limit}`)
  const reply = extractJsonObject(text, 'research')
  if (!Array.isArray(reply.findings)) {
    throw new OutputError('research', 'reply has no "findings" array', text)
  }
  const extraKeys = Object.keys(reply).filter(key => key !== 'findings').length
  if (extraKeys > 0) {
    throw new OutputError('research', `reply has ${extraKeys} top-level key(s) other than "findings"`, text)
  }
  const findings: FindingDetails[] = []
  const invalid: string[] = []
  reply.findings.slice(0, limit).forEach((item: unknown, index: number) => {
    const result = FindingReplySchema.safeParse(normalizeFinding(item))
    if (!result.success) {
      invalid.push(`findings[${index}]: ${describeIssue(result.error)}`)
    } else if (result.data.line < 1 || result.data.file.trim() === '') {
      invalid.push(`findings[${index}]: file must be non-empty and line at least 1`)
    } else if (hasNestedExtra(item)) {
      invalid.push(`findings[${index}]: carries a nested object or array outside the reply schema`)
    } else {
      findings.push(result.data)
    }
  })
  return { findings, invalid, listed: reply.findings.length }
}

/**
 * Whether a finding holds an object or array under a key the reply schema does not name. The schema
 * strips unknown keys, and a scalar extra (a self-reported confidence) is harmless, but planted text
 * that closes a string early can open such a field and let the model's own later findings be written
 * inside it, where stripping would drop them without a trace.
 */
function hasNestedExtra(item: unknown): boolean {
  return isRecord(item) && Object.entries(item).some(([key, value]) => !Object.hasOwn(FindingReplySchema.shape, key) && typeof value === 'object' && value !== null)
}

/** Validate one vote reply; unknown fields such as a self-reported confidence are dropped. */
export function parseVoteReply(text: string): Vote {
  const reply = extractJsonObject(text, 'vote')
  const result = VoteReplySchema.safeParse(normalizeVote(reply))
  if (!result.success) throw new OutputError('vote', describeIssue(result.error), text)
  return result.data
}

/**
 * Drop closed reasoning blocks in one linear pass (a lazy pattern over the whole reply would rescan
 * it from every unclosed opener) and report where a block that never closes opens, as an index into
 * `visible` (-1 when every block closed). Such a reply was cut off mid-reasoning: whatever starts
 * after that opener is a draft, never the answer. A literal `<think>` inside the answer's own JSON
 * is not affected, because the object that holds it starts before the opener.
 */
function withoutReasoning(text: string): { visible: string, truncatedAt: number } {
  const opener = /<think>/gi
  const closer = /<\/think>/gi
  let visible = ''
  let from = 0
  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    visible += text.slice(from, open.index)
    closer.lastIndex = open.index + open[0].length
    const close = closer.exec(text)
    if (!close) return { visible: visible + text.slice(open.index), truncatedAt: visible.length }
    from = close.index + close[0].length
    opener.lastIndex = from
  }
  return { visible: visible + text.slice(from), truncatedAt: -1 }
}

/** A parsed top-level object with the span of reply text it occupies (a bare wrapper's own braces included). */
interface Answer {
  value: Record<string, unknown>
  start: number
  end: number
}

/**
 * Every balanced, parseable JSON object that is not nested in another one, in order, among the
 * groups that open before `truncatedAt` (see `withoutReasoning`; -1 for no limit), so the draft
 * after a reasoning block that never closes is neither parsed nor counted toward the group cap.
 * Each comes with the span it occupies, so the caller can tell what was written after the answer.
 *
 * @throws OutputError when a group that opens like a JSON object never closes or does not parse, or an object repeats a key
 */
function topLevelObjects(text: string, truncatedAt: number, stage: string, reply: string): Answer[] {
  const found: Answer[] = []
  // Sticky, so the check reads only what follows the brace: whitespace and the characters a reader
  // cannot see (the hidden class of `sanitize.ts`), then a quote or the end of the reply. Linear
  // over the reply.
  const objectOpener = new RegExp(`\\{[\\s${HIDDEN_CLASS}]*(?:"|$)`, 'uy')
  const opensLikeObject = (start: number): boolean => {
    objectOpener.lastIndex = start
    return objectOpener.test(text)
  }
  let groups = 0
  // The bare wrapper (`{{...}}`) last stepped into: its own braces belong to the span of the object
  // inside it, but only when that object is the wrapper's whole content (blank before and after it).
  let wrapper: { start: number, end: number } | undefined
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    if (truncatedAt !== -1 && start >= truncatedAt) break
    if (++groups > MAX_BRACE_GROUPS) {
      throw new OutputError(stage, `reply has too many brace groups to scan safely (more than ${MAX_BRACE_GROUPS})`, reply)
    }
    const end = closingBrace(text, start)
    if (end === -1) {
      if (opensLikeObject(start)) throw new OutputError(stage, 'reply contains a group that opens like a JSON object but never closes (the reply may be cut off)', reply)
      continue
    }
    const json = text.slice(start, end + 1)
    let value: unknown
    try {
      value = JSON.parse(json)
    } catch {
      if (opensLikeObject(start)) throw new OutputError(stage, 'reply contains a group that opens like a JSON object but does not parse', reply)
      // Prose, not JSON. Look inside a bare wrapper (`{{...}}`) only: an object that follows other
      // text inside a broken group could be planted, so the group is skipped whole.
      if (text.slice(start + 1, end).trimStart().startsWith('{')) wrapper = { start, end }
      else start = end
      continue
    }
    if (!isRecord(value)) continue
    if (repeatsKey(json)) throw new OutputError(stage, 'reply contains a JSON object that repeats a key', reply)
    const span = wrapper && wrapper.end > end && isBlank(text, wrapper.start + 1, start) && isBlank(text, end + 1, wrapper.end)
      ? { start: wrapper.start, end: wrapper.end }
      : { start, end }
    found.push({ value, ...span })
    wrapper = undefined
    start = end
  }
  return found
}

/** Whether `text` holds only whitespace between `from` (inclusive) and `to` (exclusive). */
function isBlank(text: string, from: number, to: number): boolean {
  return text.slice(from, to).trim() === ''
}

/** Index of the brace closing the object opened at `start`, ignoring braces inside strings; -1 if unbalanced. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (code === BACKSLASH) {
        escaped = true
      } else if (code === QUOTE) {
        inString = false
      }
    } else if (code === QUOTE) {
      inString = true
    } else if (code === OPEN_BRACE) {
      depth++
    } else if (code === CLOSE_BRACE) {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Whether valid JSON text repeats a key inside one of its objects. `JSON.parse` keeps the last of
 * two values for a key, so text planted in a string the model did not escape could close that
 * string early and supply a second `findings` or `keep` that overrides the real one. One pass over
 * text that `JSON.parse` already accepted, so every string closes and every bracket is matched.
 */
function repeatsKey(json: string): boolean {
  // One entry per open bracket: the keys seen so far in an object, or undefined inside an array.
  const open: Array<Set<string> | undefined> = []
  let expectKey = false
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index)
    if (code === QUOTE) {
      let close = index + 1
      while (close < json.length && json.charCodeAt(close) !== QUOTE) close += json.charCodeAt(close) === BACKSLASH ? 2 : 1
      const keys = open.at(-1)
      if (expectKey && keys) {
        const key = String(JSON.parse(json.slice(index, close + 1)))
        if (keys.has(key)) return true
        keys.add(key)
      }
      expectKey = false
      index = close
    } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      open.push(code === OPEN_BRACE ? new Set() : undefined)
      expectKey = code === OPEN_BRACE
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      open.pop()
      expectKey = false
    } else if (code === COMMA) {
      expectKey = open.at(-1) !== undefined
    }
  }
  return false
}

/** Local models often quote numbers: accept "42" for line, reject anything else non-numeric. */
function normalizeFinding(item: unknown): unknown {
  if (!isRecord(item) || typeof item.line !== 'string') return item
  const line = item.line.trim()
  return DIGITS.test(line) ? { ...item, line: Number(line) } : item
}

/** Accept "true" / "false" strings for keep; anything else is left for the schema to reject. */
function normalizeVote(reply: Record<string, unknown>): Record<string, unknown> {
  const keep = typeof reply.keep === 'string' ? reply.keep.trim().toLowerCase() : undefined
  return keep === 'true' || keep === 'false' ? { ...reply, keep: keep === 'true' } : reply
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid value'
}

/** Whether `value` is a non-null object that is not an array: the shape every untyped input is checked against before its fields are read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A schema without its non-portable keywords, at any depth. The names under `properties` are field names, never keywords. */
function portable(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(portable)
  if (!isRecord(schema)) return schema
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !NON_PORTABLE_KEYWORDS.has(key))
    .map(([key, value]) => [key, key === 'properties' && isRecord(value)
      ? Object.fromEntries(Object.entries(value).map(([name, field]) => [name, portable(field)]))
      : portable(value)]))
}

function toWireSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...wire } = z.toJSONSchema(schema) as Record<string, unknown>
  return portable(wire) as Record<string, unknown>
}
