import { describe, expect, it } from 'vitest'
import { ProviderError } from '../core/errors.ts'
import { checkFits, contextBudget, textTokens, utf8Length } from './size.ts'

const output = { name: 'panel_vote', schema: { type: 'object' } }
const shaped = { system: 'instructions', messages: [{ role: 'user' as const, content: 'data' }] }

describe('utf8Length', () => {
  it.each<[string, number]>([
    ['', 0],
    ['abc', 3],
    [String.fromCharCode(0xE9), 2],
    [String.fromCharCode(0x4E2D), 3],
    [String.fromCodePoint(0x1F600), 4],
    [String.fromCharCode(0xD800), 3],
  ])('counts %j as %i bytes of UTF-8, a lone surrogate as U+FFFD', (text, bytes) => {
    expect(utf8Length(text)).toBe(bytes)
  })
})

describe('textTokens', () => {
  it('counts the system text, every message and the reply schema, one token per byte', () => {
    expect(textTokens(shaped, output)).toBe(33)
    expect(textTokens({ system: undefined, messages: [{ role: 'user', content: 'instructions\n\ndata' }] }, output)).toBe(35)
    expect(textTokens({ system: String.fromCharCode(0xE9), messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: String.fromCharCode(0x4E2D) }] }, output)).toBe(2 + 1 + 3 + 17)
  })

  describe('with a tokenizer that normalizes first', () => {
    const schemaBytes = 17
    /** U+0F81 is 3 bytes as sent and 6 after NFC, which decomposes it; U+FDFA is 3 bytes, 3 after NFC and 33 after NFKC. */
    const decomposedByNfc = String.fromCharCode(0x0F81)
    const expandedByNfkc = String.fromCharCode(0xFDFA)
    const inMessage = (content: string): number => textTokens({ system: undefined, messages: [{ role: 'user', content }] }, output) - schemaBytes

    it('counts a text at the largest of its raw, NFC and NFKC UTF-8 lengths', () => {
      expect(inMessage(decomposedByNfc)).toBe(6)
      expect(inMessage(expandedByNfkc)).toBe(33)
      expect(inMessage(decomposedByNfc.repeat(100))).toBe(600)
    })

    it('counts the system text and the reply schema the same way', () => {
      expect(textTokens({ system: expandedByNfkc, messages: [] }, output) - schemaBytes).toBe(33)
      // `{"` and `":1}` are 6 ASCII bytes around the key.
      expect(textTokens({ system: undefined, messages: [] }, { name: 'panel_vote', schema: { [decomposedByNfc]: 1 } })).toBe(6 + 6)
    })

    it('counts an ASCII text at its length and a lone surrogate at 3 bytes', () => {
      expect(inMessage('abc')).toBe(3)
      expect(inMessage(String.fromCharCode(0xD800))).toBe(3)
    })
  })
})

describe('contextBudget', () => {
  it('reserves maxTokens for the reply, else 16000, and is undefined without a context size', () => {
    expect(contextBudget(undefined, 900)).toBeUndefined()
    expect(contextBudget(32768, undefined)).toEqual({ contextTokens: 32768, replyTokens: 16000 })
    expect(contextBudget(32768, 900)).toEqual({ contextTokens: 32768, replyTokens: 900 })
  })
})

describe('checkFits', () => {
  it('refuses a request whose bound passes the context, as a too-large ProviderError that holds numbers only', () => {
    let thrown: unknown
    try {
      checkFits('p', shaped, output, { contextTokens: 644, replyTokens: 100 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProviderError)
    expect(thrown).toMatchObject({ providerId: 'p', kind: 'too-large', retryable: false, message: 'p: may need 645 tokens, more than contextTokens (644): 33 for its text at one token per byte, 512 for the chat template and 100 for the reply' })
  })

  it('lets a request through at the bound, and every request without a budget', () => {
    expect(() => checkFits('p', shaped, output, { contextTokens: 645, replyTokens: 100 })).not.toThrow()
    expect(() => checkFits('p', { system: 'x'.repeat(10_000), messages: [] }, output, undefined)).not.toThrow()
  })
})
