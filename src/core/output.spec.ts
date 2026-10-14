import { describe, expect, it } from 'vitest'
import { OutputError } from './errors.ts'
import { extractJsonObject, parseResearchReply, parseVoteReply, researchReplyJsonSchema, voteReplyJsonSchema } from './output.ts'

const finding = { file: 'a.js', line: 1, category: 'CWE-78', sink: 'exec(cmd)', summary: 'command injection' }

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"keep":true}', 'vote')).toEqual({ keep: true })
  })

  it('finds the object inside surrounding prose', () => {
    expect(extractJsonObject('Sure:\n{"keep":true}\nHope that helps!', 'vote')).toEqual({ keep: true })
  })

  it('prefers a fenced json block', () => {
    expect(extractJsonObject('Example: {"keep":false}\n```json\n{"keep":true}\n```', 'vote')).toEqual({ keep: true })
  })

  it('ignores reasoning blocks from local reasoning models', () => {
    const reply = '<think>maybe {"keep":false}? braces { everywhere</think>\n{"keep":true,"reasoning":"ok"}'
    expect(extractJsonObject(reply, 'vote')).toEqual({ keep: true, reasoning: 'ok' })
  })

  it('skips brace groups that are not JSON', () => {
    expect(extractJsonObject('Use {braces} carefully. {"keep":true}', 'vote')).toEqual({ keep: true })
  })

  it('keeps braces that appear inside JSON strings', () => {
    expect(extractJsonObject('{"reasoning":"a } b { c","keep":true}', 'vote')).toEqual({ reasoning: 'a } b { c', keep: true })
  })

  it('handles escaped quotes inside JSON strings', () => {
    expect(extractJsonObject('{"reasoning":"say \\"}\\" now","keep":true}', 'vote')).toEqual({ reasoning: 'say "}" now', keep: true })
  })

  it('recovers after an unbalanced opening brace', () => {
    expect(extractJsonObject('note { unclosed then {"keep":true}', 'vote')).toEqual({ keep: true })
  })

  it('throws an OutputError naming the stage when there is no object', () => {
    expect(() => extractJsonObject('no json here', 'vote')).toThrow(OutputError)
    expect(() => extractJsonObject('no json here', 'vote')).toThrow(/vote reply unusable/)
  })
})

describe('parseResearchReply', () => {
  it('returns valid findings', () => {
    expect(parseResearchReply(JSON.stringify({ findings: [finding] }))).toEqual({ findings: [finding], invalid: [] })
  })

  it('accepts an explicit empty list', () => {
    expect(parseResearchReply('{"findings":[]}')).toEqual({ findings: [], invalid: [] })
  })

  it('fails closed when the findings array is missing', () => {
    expect(() => parseResearchReply('{"result":"looks fine"}')).toThrow(/no "findings" array/)
  })

  it('fails closed when findings is not an array', () => {
    expect(() => parseResearchReply('{"findings":"none"}')).toThrow(OutputError)
  })

  it('drops invalid findings with a reason and keeps the valid ones', () => {
    const { findings, invalid } = parseResearchReply(JSON.stringify({ findings: [finding, { file: 'b.js', line: 2 }] }))
    expect(findings).toEqual([finding])
    expect(invalid).toHaveLength(1)
    expect(invalid[0]).toMatch(/^findings\[1\]/)
  })

  it('coerces a numeric string line and strips unknown fields', () => {
    const { findings } = parseResearchReply(JSON.stringify({ findings: [{ ...finding, line: ' 42 ', confidence: 'high' }] }))
    expect(findings).toEqual([{ ...finding, line: 42 }])
  })

  it('rejects a line below 1 and an empty file', () => {
    const { findings, invalid } = parseResearchReply(JSON.stringify({ findings: [{ ...finding, line: 0 }, { ...finding, file: ' ' }] }))
    expect(findings).toEqual([])
    expect(invalid).toHaveLength(2)
  })
})

describe('parseVoteReply', () => {
  it('returns keep and reasoning', () => {
    expect(parseVoteReply('{"keep":true,"reasoning":"reachable"}')).toEqual({ keep: true, reasoning: 'reachable' })
  })

  it('coerces "true" / "false" strings', () => {
    expect(parseVoteReply('{"keep":"False","reasoning":"guarded"}')).toEqual({ keep: false, reasoning: 'guarded' })
  })

  it('drops a self-reported confidence field', () => {
    expect(parseVoteReply('{"keep":true,"reasoning":"r","confidence":0.99}')).toEqual({ keep: true, reasoning: 'r' })
  })

  it('throws an OutputError when keep is missing', () => {
    expect(() => parseVoteReply('{"reasoning":"r"}')).toThrow(OutputError)
  })
})

describe('reply JSON Schemas', () => {
  it('describe closed objects with every field required', () => {
    expect(voteReplyJsonSchema).toMatchObject({ type: 'object', required: ['keep', 'reasoning'], additionalProperties: false })
    expect(researchReplyJsonSchema).toMatchObject({ type: 'object', required: ['findings'] })
    expect(researchReplyJsonSchema).not.toHaveProperty('$schema')
  })
})
