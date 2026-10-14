import { z } from 'zod'
import { OutputError } from './errors.ts'
import type { FindingDetails, Vote } from './types.ts'

/** Wire shape of one finding. Semantic checks (line >= 1, non-empty file) run after parsing. */
const FindingReplySchema = z.object({
  file: z.string(),
  line: z.int(),
  category: z.string(),
  sink: z.string(),
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

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi
const CODE_FENCE = /```(?:json)?([\s\S]*?)```/i
const DIGITS = /^\d+$/

/**
 * Pull the first JSON object out of a model reply. Models wrap JSON in prose, code fences or
 * reasoning blocks despite instructions, so this drops `<think>` blocks, prefers a fenced block,
 * and otherwise scans for the first balanced, parseable object. A greedy regex would break as soon
 * as a reply contains two brace groups.
 *
 * @throws OutputError when the reply contains no JSON object
 */
export function extractJsonObject(text: string, stage: string): Record<string, unknown> {
  const cleaned = text.replace(THINK_BLOCK, '')
  const fenced = CODE_FENCE.exec(cleaned)?.[1]
  const found = (fenced === undefined ? undefined : firstObject(fenced)) ?? firstObject(cleaned)
  if (!found) throw new OutputError(stage, 'reply contains no JSON object', text)
  return found
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

function firstObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = closingBrace(text, start)
    if (end === -1) continue
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1))
      if (isRecord(value)) return value
    } catch {
      // Not JSON from this brace: try the next one.
    }
  }
  return undefined
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
