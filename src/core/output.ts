import { z } from 'zod'
import { OutputError } from './errors.ts'
import type { FindingDetails, Vote } from './types.ts'

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

/**
 * Pull the one JSON object out of a model reply. Models wrap JSON in prose, code fences or
 * reasoning blocks despite instructions, so this drops reasoning, ignores fence markers and scans
 * for balanced, parseable objects. It fails closed instead of guessing: a reply holding several
 * different objects is ambiguous (text echoed from the diff could pose as the answer), and a reply
 * too large or too noisy to scan cheaply is refused. The same object twice (a fenced copy next to
 * a prose copy) is accepted. A group that is balanced but not JSON is skipped whole, except a bare
 * wrapper (`{{...}}`), so an object quoted inside it (a summary that quotes the diff with unescaped
 * quotes) is not read as the answer. A brace that never closes is only stepped over, as prose often
 * holds a stray one.
 *
 * @throws OutputError when the reply has no object, several different objects, or cannot be scanned safely
 */
export function extractJsonObject(text: string, stage: string): Record<string, unknown> {
  if (text.length > MAX_REPLY_CHARS) {
    throw new OutputError(stage, `reply is longer than ${MAX_REPLY_CHARS} characters`, text)
  }
  const { visible, truncatedAt } = withoutReasoning(text)
  const answers = topLevelObjects(visible, truncatedAt, stage, text)
  const [first] = answers
  if (!first) throw new OutputError(stage, 'reply contains no JSON object', text)
  const key = JSON.stringify(first)
  if (answers.some(other => JSON.stringify(other) !== key)) {
    throw new OutputError(stage, 'reply contains several different JSON objects', text)
  }
  return first
}

/**
 * Validate a research reply. A missing or non-array `findings` fails the run: a malformed reply
 * must never read as "no findings". Individual invalid findings are dropped, each with a reason.
 */
export function parseResearchReply(text: string): { findings: FindingDetails[], invalid: string[] } {
  const reply = extractJsonObject(text, 'research')
  if (!Array.isArray(reply.findings)) {
    throw new OutputError('research', 'reply has no "findings" array', text)
  }
  const findings: FindingDetails[] = []
  const invalid: string[] = []
  reply.findings.forEach((item: unknown, index: number) => {
    const result = FindingReplySchema.safeParse(normalizeFinding(item))
    if (!result.success) {
      invalid.push(`findings[${index}]: ${describeIssue(result.error)}`)
    } else if (result.data.line < 1 || result.data.file.trim() === '') {
      invalid.push(`findings[${index}]: file must be non-empty and line at least 1`)
    } else {
      findings.push(result.data)
    }
  })
  return { findings, invalid }
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

/**
 * Every balanced, parseable JSON object that is not nested in another one, in order, among the
 * groups that open before `truncatedAt` (see `withoutReasoning`; -1 for no limit), so the draft
 * after a reasoning block that never closes is neither parsed nor counted toward the group cap.
 */
function topLevelObjects(text: string, truncatedAt: number, stage: string, reply: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = []
  let groups = 0
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    if (truncatedAt !== -1 && start >= truncatedAt) break
    if (++groups > MAX_BRACE_GROUPS) {
      throw new OutputError(stage, `reply has too many brace groups to scan safely (more than ${MAX_BRACE_GROUPS})`, reply)
    }
    const end = closingBrace(text, start)
    if (end === -1) continue
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1))
      if (isRecord(value)) {
        found.push(value)
        start = end
      }
    } catch {
      // Not JSON. Look inside a bare wrapper (`{{...}}`) only: an object that follows other text
      // inside a broken group (a string quoting the diff) could be planted, so the group is skipped.
      if (!text.slice(start + 1, end).trimStart().startsWith('{')) start = end
    }
  }
  return found
}

/** Index of the brace closing the object opened at `start`, ignoring braces inside strings; -1 if unbalanced. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toWireSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...wire } = z.toJSONSchema(schema) as Record<string, unknown>
  return wire
}
