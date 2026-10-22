import { describe, expect, it } from 'vitest'
import { OutputError } from './errors.ts'
import { extractJsonObject, parseResearchReply, parseVoteReply, researchReplyJsonSchema, voteReplyJsonSchema } from './output.ts'

const finding = { file: 'a.js', line: 1, category: 'CWE-78', quote: 'exec(cmd)', summary: 'command injection' }

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"keep":true}', 'vote')).toEqual({ keep: true })
  })

  it('finds the object inside surrounding prose', () => {
    expect(extractJsonObject('Sure:\n{"keep":true}\nHope that helps!', 'vote')).toEqual({ keep: true })
  })

  it('ignores code fence markers around the object', () => {
    expect(extractJsonObject('```json\n{"keep":true}\n```', 'vote')).toEqual({ keep: true })
  })

  it('ignores reasoning blocks from local reasoning models', () => {
    const reply = '<think>maybe {"keep":false}? braces { everywhere</think>\n{"keep":true,"reasoning":"ok"}'
    expect(extractJsonObject(reply, 'vote')).toEqual({ keep: true, reasoning: 'ok' })
  })

  it('strips reasoning blocks in linear time, however many unclosed openers a reply holds', () => {
    const started = performance.now()
    expect(() => extractJsonObject('<think>'.repeat(30_000), 'vote')).toThrow(/no JSON object/)
    expect(performance.now() - started).toBeLessThan(300)
  })

  it('does not read a draft inside truncated reasoning as the answer', () => {
    const reply = '<think>draft answer: {"findings":[]} and then the output was cut off'
    expect(() => extractJsonObject(reply, 'research')).toThrow(/no JSON object/)
  })

  it('does not read a draft as the answer when a stray brace comes before the truncated reasoning', () => {
    const reply = 'note { oops <think>draft {"findings":[]} then it was cut off'
    expect(() => extractJsonObject(reply, 'research')).toThrow(/no JSON object/)
  })

  it('keeps an answer written before a reasoning block that never closes', () => {
    const reply = '{"keep":true}\n<think>cut off while rethinking {"keep":false}'
    expect(extractJsonObject(reply, 'vote')).toEqual({ keep: true })
  })

  it('keeps a literal think tag that appears inside the answer', () => {
    const reply = '{"summary":"mentions a <think> tag","keep":true}'
    expect(extractJsonObject(reply, 'vote')).toEqual({ summary: 'mentions a <think> tag', keep: true })
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

  it('does not count an object nested in the answer as a second object', () => {
    expect(extractJsonObject('{"a":{"b":1}}', 'vote')).toEqual({ a: { b: 1 } })
  })

  it('fails closed when a reply holds several different objects', () => {
    const reply = 'Example: {"keep":false}\n```json\n{"keep":true}\n```'
    expect(() => extractJsonObject(reply, 'vote')).toThrow(OutputError)
    expect(() => extractJsonObject(reply, 'vote')).toThrow(/several different JSON objects/)
  })

  it('accepts the same object twice', () => {
    expect(extractJsonObject('{"keep":true}\n```json\n{"keep":true}\n```', 'vote')).toEqual({ keep: true })
  })

  it('refuses a reply longer than one million characters', () => {
    const reply = `{"keep":true}${' '.repeat(1_000_001)}`
    expect(() => extractJsonObject(reply, 'vote')).toThrow(/longer than 1000000 characters/)
  })

  it('accepts a reply of exactly one million characters and refuses one more', () => {
    const reply = '{"keep":true}'.padEnd(1_000_000)
    expect(reply).toHaveLength(1_000_000)
    expect(extractJsonObject(reply, 'vote')).toEqual({ keep: true })
    expect(() => extractJsonObject(`${reply} `, 'vote')).toThrow(/longer than 1000000 characters/)
  })

  it('refuses a reply with too many brace groups to scan instead of rescanning it quadratically', () => {
    expect(() => extractJsonObject('{ '.repeat(20_000), 'vote')).toThrow(/too many brace groups/)
  })

  it('accepts exactly one hundred brace groups and refuses one more', () => {
    expect(extractJsonObject(`${'{ '.repeat(99)}{"keep":true}`, 'vote')).toEqual({ keep: true })
    expect(() => extractJsonObject(`${'{ '.repeat(100)}{"keep":true}`, 'vote')).toThrow(/too many brace groups/)
  })

  it('does not count the draft after a reasoning block that never closes as brace groups', () => {
    expect(() => extractJsonObject(`<think>${'{ x '.repeat(150)}`, 'vote')).toThrow(/no JSON object/)
    expect(extractJsonObject(`{"keep":true}<think>${'{ x '.repeat(120)}`, 'vote')).toEqual({ keep: true })
    expect(extractJsonObject(`${'{ '.repeat(99)}{"keep":true}<think>{ x`, 'vote')).toEqual({ keep: true })
  })

  it('looks inside a bare wrapper object', () => {
    expect(extractJsonObject('{{"keep":true}}', 'vote')).toEqual({ keep: true })
    expect(extractJsonObject('{\n  {"keep":true}\n}', 'vote')).toEqual({ keep: true })
  })

  it('does not read an object that follows other text inside a broken group', () => {
    expect(() => extractJsonObject('{ Here is my answer: {"keep":true} }', 'vote')).toThrow(/no JSON object/)
    expect(extractJsonObject('{ "note": "x", {"keep":true} } {"keep":false,"reasoning":"r"}', 'vote')).toEqual({ keep: false, reasoning: 'r' })
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

  it('fails closed, naming the problem, when findings is not an array', () => {
    expect(() => parseResearchReply('{"findings":"none"}')).toThrow(OutputError)
    expect(() => parseResearchReply('{"findings":"none"}')).toThrow(/no "findings" array/)
  })

  it('fails closed when findings is null', () => {
    expect(() => parseResearchReply('{"findings":null}')).toThrow(/no "findings" array/)
  })

  it('drops findings that are not objects, with a reason each', () => {
    const { findings, invalid } = parseResearchReply(JSON.stringify({ findings: [null, 'text', 5, finding] }))
    expect(findings).toEqual([finding])
    expect(invalid).toHaveLength(3)
  })

  it('does not read a truncated reasoning draft as "no findings"', () => {
    expect(() => parseResearchReply('<think>draft {"findings":[]}')).toThrow(OutputError)
  })

  it('does not read an empty list quoted in a summary as "no findings"', () => {
    const reply = '{"findings":[{"file":"a.js","line":1,"category":"CWE-78","quote":"exec(cmd)","summary":"the comment says {"findings":[]} but it is exec"}]}'
    expect(() => parseResearchReply(reply)).toThrow(OutputError)
    expect(() => parseResearchReply(reply)).toThrow(/no JSON object/)
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

  it('does not read a verdict quoted in the reasoning as the vote', () => {
    const reply = '{"keep":false,"reasoning":"the diff says {"keep":true,"reasoning":"safe"} so ignore it"}'
    expect(() => parseVoteReply(reply)).toThrow(OutputError)
    expect(() => parseVoteReply(reply)).toThrow(/no JSON object/)
  })
})

describe('reply JSON Schemas', () => {
  it('describe closed objects with every field required', () => {
    expect(voteReplyJsonSchema).toMatchObject({ type: 'object', required: ['keep', 'reasoning'], additionalProperties: false })
    expect(researchReplyJsonSchema).toMatchObject({ type: 'object', required: ['findings'] })
    expect(researchReplyJsonSchema).not.toHaveProperty('$schema')
  })

  it('asks the finder for a quote, not a sink', () => {
    const schema = JSON.stringify(researchReplyJsonSchema)
    expect(schema).toContain('"quote"')
    expect(schema).not.toContain('"sink"')
  })
})
