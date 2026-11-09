import { describe, expect, it } from 'vitest'
import { endedEarly, joinedText, replyFailure, tokenUsage } from './reply.ts'

describe('replyFailure', () => {
  it('builds a ProviderError of the provider, retryable as its kind and status say', () => {
    const fail = replyFailure('p')
    expect(fail('http', 'server error 503', 503)).toMatchObject({ name: 'ProviderError', providerId: 'p', kind: 'http', status: 503, retryable: true, message: 'p: server error 503' })
    expect(fail('truncated', 'reply was cut off by the token limit')).toMatchObject({ kind: 'truncated', status: undefined, retryable: false })
  })
})

describe('tokenUsage', () => {
  it('reads the two counts under their first keys, only when both are numbers', () => {
    expect(tokenUsage({ in: 3, out: 2 }, ['in'], ['out'])).toEqual({ inputTokens: 3, outputTokens: 2 })
    for (const source of [undefined, null, 'x', [3, 2], { in: 3 }, { in: '3', out: 2 }]) {
      expect(tokenUsage(source, ['in'], ['out']), JSON.stringify(source)).toBeUndefined()
    }
  })

  it('adds each other key of a list when it holds a number, but never stands in for the first', () => {
    expect(tokenUsage({ in: 3, cached: 5, read: 1, out: 2, thought: 7 }, ['in', 'cached', 'read'], ['out', 'thought'])).toEqual({ inputTokens: 9, outputTokens: 9 })
    expect(tokenUsage({ in: 3, cached: null, read: '1', out: 2 }, ['in', 'cached', 'read'], ['out', 'thought'])).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(tokenUsage({ cached: 5, out: 2 }, ['in', 'cached'], ['out'])).toBeUndefined()
    expect(tokenUsage({ in: 3, thought: 7 }, ['in'], ['out', 'thought'])).toBeUndefined()
  })
})

describe('endedEarly', () => {
  it('quotes a string reason, redacted and cut to 40 characters, and leaves out any other', () => {
    expect(endedEarly('pause_turn', [])).toBe('reply ended early: "pause_turn"')
    expect(endedEarly('x'.repeat(60), [])).toBe(`reply ended early: "${'x'.repeat(40)}"`)
    expect(endedEarly('bad sk-k', ['sk-k'])).toBe('reply ended early: "bad [redacted]"')
    for (const reason of [undefined, null, 7, {}]) expect(endedEarly(reason, []), JSON.stringify(reason)).toBe('reply ended early')
  })
})

describe('joinedText', () => {
  const isText = (part: Record<string, unknown>): boolean => part.type === 'text'

  it('joins the string text of the parts it keeps, an empty one included', () => {
    expect(joinedText([{ type: 'text', text: 'a' }, { type: 'thinking', text: 'x' }, { type: 'text', text: '' }, { type: 'text', text: 'b' }], isText)).toBe('ab')
    expect(joinedText([{ type: 'text', text: '' }], isText)).toBe('')
  })

  it('finds no text in anything but an array holding a part it keeps', () => {
    for (const parts of [undefined, 'ab', {}, [], [null, 'x', { type: 'text', text: 1 }, { type: 'thinking', text: 'x' }]]) {
      expect(joinedText(parts, isText), JSON.stringify(parts)).toBeUndefined()
    }
  })
})
