import { describe, expect, it } from 'vitest'
import { ProviderError } from '../core/errors.ts'
import { endedEarly, joinedText, readAnswer, replyFailure, tokenUsage } from './reply.ts'
import type { ReplyReading } from './reply.ts'

describe('replyFailure', () => {
  it('builds a ProviderError of the provider, retryable as its kind and status say', () => {
    const fail = replyFailure('p')
    expect(fail('http', 'server error 503', 503)).toMatchObject({
      name: 'ProviderError',
      providerId: 'p',
      kind: 'http',
      status: 503,
      retryable: true,
      message: 'p: server error 503',
    })
    expect(fail('truncated', 'reply was cut off by the token limit')).toMatchObject({ kind: 'truncated', status: undefined, retryable: false })
  })

  it('puts the usage it is given on every error it builds, and none otherwise', () => {
    expect(replyFailure('p', { inputTokens: 1, outputTokens: 2 })('truncated', 'm').usage).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(replyFailure('p', { inputTokens: 1, outputTokens: 2 })('http', 'm', 503).usage).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(replyFailure('p')('truncated', 'm').usage).toBeUndefined()
  })
})

describe('tokenUsage', () => {
  it('reads the two counts under their first keys, only when both are numbers', () => {
    expect(tokenUsage({ in: 3, out: 2 }, ['in'], ['out'])).toEqual({ inputTokens: 3, outputTokens: 2 })
    for (const source of [
      undefined,
      null,
      'x',
      [3, 2],
      { in: 3 },
      { in: '3', out: 2 },
    ]) {
      expect(tokenUsage(source, ['in'], ['out']), JSON.stringify(source)).toBeUndefined()
    }
  })

  it('adds each other key of a list when it holds a number, but never stands in for the first', () => {
    expect(tokenUsage({
      in: 3,
      cached: 5,
      read: 1,
      out: 2,
      thought: 7,
    }, ['in', 'cached', 'read'], ['out', 'thought'])).toEqual({ inputTokens: 9, outputTokens: 9 })
    expect(tokenUsage({
      in: 3,
      cached: null,
      read: '1',
      out: 2,
    }, ['in', 'cached', 'read'], ['out', 'thought'])).toEqual({ inputTokens: 3, outputTokens: 2 })
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
    expect(joinedText([
      { type: 'text', text: 'a' },
      { type: 'thinking', text: 'x' },
      { type: 'text', text: '' },
      { type: 'text', text: 'b' },
    ], isText)).toBe('ab')
    expect(joinedText([
      { type: 'text', text: '' },
    ], isText)).toBe('')
  })

  it('finds no text in anything but an array holding a part it keeps', () => {
    for (const parts of [
      undefined,
      'ab',
      {},
      [],
      [
        null,
        'x',
        { type: 'text', text: 1 },
        { type: 'thinking', text: 'x' },
      ],
    ]) {
      expect(joinedText(parts, isText), JSON.stringify(parts)).toBeUndefined()
    }
  })
})

describe('readAnswer', () => {
  const usage = { inputTokens: 100, outputTokens: 50 }
  const finished: ReplyReading = {
    text: '{"findings":[]}',
    flaggedCutOff: false,
    windowEnded: false,
    reasoned: false,
    limit: 1000,
    usage,
  }

  /** What `readAnswer` throws for `reading`, which a test expects to throw. */
  function lackOf(reading: ReplyReading): ProviderError {
    try {
      readAnswer('p', reading)
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError)
      return error as ProviderError
    }
    throw new Error('the reading was read as an answer')
  }

  it.each<[string, Partial<ReplyReading>, string, string, string?]>([
    [
      'cut off by its flag, with visible text',
      { flaggedCutOff: true, text: '{"kee' },
      'truncated',
      'reply',
    ],
    [
      'cut off by its flag, with reasoning and no text',
      { flaggedCutOff: true, text: undefined, reasoned: true },
      'truncated',
      'thinking',
    ],
    [
      'cut off by its flag, with no text and no reasoning',
      { flaggedCutOff: true, text: '' },
      'truncated',
      'reply',
    ],
    [
      'whose output tokens reach the limit sent, whatever its flag',
      {
        usage: { inputTokens: 100, outputTokens: 1000 },
      },
      'truncated',
      'reply',
    ],
    [
      'that the protocol says the window ended',
      { windowEnded: true, text: '{"kee' },
      'truncated',
      'window',
      'a reply ended at the server\'s window, which is smaller than contextTokens: lower contextTokens',
    ],
    [
      'with no answer, only reasoning, that ended on its own',
      { text: undefined, reasoned: true },
      'no-answer',
      'thinking',
    ],
    [
      'with a blank text and no reasoning',
      { text: ' \n\t' },
      'no-answer',
      'empty',
    ],
  ])('reads a reply %s', (_label, reading, kind, noAnswer, words) => {
    const error = lackOf({
      ...finished,
      ...reading,
    })
    expect(error).toMatchObject({
      kind,
      noAnswer,
      retryable: false,
      providerId: 'p',
      usage: reading.usage ?? usage,
    })
    if (words !== undefined) expect(error.message).toBe(`p: ${words}`)
  })

  it.each<[string, Partial<ReplyReading>, boolean]>([
    [
      'with text and reasoning',
      { reasoned: true },
      true,
    ],
    ['with text and none', {}, false],
  ])('reads a reply %s', (_label, reading, reasoning) => {
    expect(readAnswer('p', {
      ...finished,
      ...reading,
    })).toEqual({ text: '{"findings":[]}', reasoning })
  })

  it('reads a cut-off below the limit sent as reply, with the server-cap words', () => {
    const error = lackOf({
      ...finished,
      flaggedCutOff: true,
      limit: 21_024,
      usage: { inputTokens: 30_100, outputTokens: 8192 },
    })
    expect(error).toMatchObject({ kind: 'truncated', noAnswer: 'reply' })
    expect(error.message).toBe('p: a reply was cut off at 8192 tokens, below the 21024 quorum asked for: the server caps replies near 8192: set maxTokens: 8192')
  })
})
