import { describe, expect, it } from 'vitest'
import { ProviderError } from '../core/errors.ts'
import { checkFits, contextBudget, textTokens, utf8Length } from './size.ts'

const output = {
  name: 'panel_vote',
  schema: { type: 'object' },
}
const shaped = {
  system: 'instructions',
  messages: [
    { role: 'user' as const, content: 'data' },
  ],
}

describe('utf8Length', () => {
  it.each<[string, number]>([
    ['', 0],
    ['abc', 3],
    [
      String.fromCharCode(0xE9),
      2,
    ],
    [
      String.fromCharCode(0x4E2D),
      3,
    ],
    [
      String.fromCodePoint(0x1F600),
      4,
    ],
    [
      String.fromCharCode(0xD800),
      3,
    ],
  ])('counts %j as %i bytes of UTF-8, a lone surrogate as U+FFFD', (text, bytes) => {
    expect(utf8Length(text)).toBe(bytes)
  })
})

describe('textTokens', () => {
  it('counts the system text, every message and the reply schema, one token per byte', () => {
    expect(textTokens(shaped, output)).toBe(33)
    expect(textTokens({
      system: undefined,
      messages: [
        { role: 'user', content: 'instructions\n\ndata' },
      ],
    }, output)).toBe(35)
    expect(textTokens({
      system: String.fromCharCode(0xE9),
      messages: [
        { role: 'assistant', content: 'a' },
        {
          role: 'user',
          content: String.fromCharCode(0x4E2D),
        },
      ],
    }, output)).toBe(3 + 1 + 3 + 17)
  })

  describe('with a tokenizer that normalizes first', () => {
    const schemaBytes = 17
    const char = (codePoint: number): string => String.fromCodePoint(codePoint)
    /** U+0F81 is 3 bytes as sent and 6 decomposed; U+FDFA is 3 bytes and 33 compatibility-decomposed. */
    const decomposed = String.fromCharCode(0x0F81)
    const expanded = String.fromCharCode(0xFDFA)
    const inMessage = (content: string): number => textTokens({
      system: undefined,
      messages: [
        { role: 'user', content },
      ],
    }, output) - schemaBytes

    it.each<[string, string, number]>([
      ['U+0F81, which decomposes into two 3-byte marks', decomposed, 6],
      ['U+FDFA, which expands into 18 letters', expanded, 33],
      [
        'U+00E9, which NFD writes as e and U+0301',
        String.fromCharCode(0xE9),
        3,
      ],
      [
        'U+AC00, which NFD writes as two jamo of 3 bytes',
        String.fromCharCode(0xAC00),
        6,
      ],
      [
        'a lone surrogate',
        String.fromCharCode(0xD800),
        3,
      ],
      [
        'a lone low surrogate',
        String.fromCharCode(0xDC00),
        3,
      ],
      ['an ASCII text', 'abc', 3],
      [
        'a code point above U+FFFF',
        char(0x1F600),
        4,
      ],
      [
        'an astral character that decomposes',
        char(0x1D15E),
        8,
      ],
    ])('counts %s at its longest form', (_name, text, bytes) => {
      expect(inMessage(text)).toBe(bytes)
    })

    it('counts a text as the sum of its code points, so a repeat scales', () => {
      expect(inMessage(decomposed.repeat(100))).toBe(600)
    })

    it('counts the system text and the reply schema the same way', () => {
      expect(textTokens({ system: expanded, messages: [] }, output) - schemaBytes).toBe(33)
      // `{"` and `":1}` are 6 ASCII bytes around the key.
      expect(textTokens({ system: undefined, messages: [] }, {
        name: 'panel_vote',
        schema: { [decomposed]: 1 },
      })).toBe(6 + 6)
    })

    it('does not count each character alone as NFC: a mark that composes first can lengthen the whole', () => {
      // U+00E9 then U+0323 is 4 bytes as sent, and U+1EB9 U+0301 (5 bytes) in NFC as a whole.
      const text = String.fromCharCode(0xE9, 0x0323)
      expect(utf8Length(text.normalize('NFC'))).toBe(5)
      expect(inMessage(text)).toBeGreaterThanOrEqual(5)
    })

    it('does not count chunks apart: a split can lose the composition that lengthens the whole', () => {
      // U+212B then two U+0323 is 7 bytes in NFC as a whole, and 6 when normalized in pieces.
      const text = String.fromCharCode(0x212B, 0x0323, 0x0323)
      expect(utf8Length(text.normalize('NFC'))).toBe(7)
      expect(inMessage(text)).toBeGreaterThanOrEqual(7)
    })

    it('rests on a property that holds for every code point: composing is never longer than decomposing', () => {
      const violations: number[] = []
      for (let codePoint = 0; codePoint <= 0x10FFFF; codePoint++) {
        if (codePoint >= 0xD800 && codePoint <= 0xDFFF) continue
        const text = char(codePoint)
        const nfkd = text.normalize('NFKD')
        // a code point NFKD leaves alone has no canonical decomposition either, so all four forms are itself
        if (nfkd === text) continue
        if (utf8Length(text.normalize('NFC')) > utf8Length(text.normalize('NFD')) || utf8Length(text.normalize('NFKC')) > utf8Length(nfkd)) violations.push(codePoint)
      }
      expect(violations).toEqual([])
    }, 20_000)

    it('bounds every form of a text: 10000 seeded random strings count at least their raw, NFC, NFKC, NFD and NFKD lengths', () => {
      const starters = [
        0x61,
        0x65,
        0x41,
        0x0915,
        0x304B,
        0x110A5,
      ]
      const precomposed = [
        0xE9,
        0x1E0A,
        0x1E69,
        0x212B,
        0x2126,
        0xFB01,
      ]
      // combining marks of classes 230, 220, 202, 240, 8, 7, 129, 130 and 132
      const marks = [
        0x0301,
        0x0307,
        0x0316,
        0x0323,
        0x0327,
        0x0345,
        0x3099,
        0x093C,
        0x0F71,
        0x0F72,
        0x0F74,
        0x110BA,
      ]
      const hangul = [
        0xAC00,
        0xAC01,
        0xD7A3,
        0x1100,
        0x1161,
        0x11A8,
      ]
      const expanders = [0x0F81, 0x0344, 0xFDFA]
      const pool = [
        ...starters,
        ...precomposed,
        ...marks,
        ...hangul,
        ...expanders,
      ].map(char)
      let seed = 0x9E3779B9
      const next = (limit: number): number => {
        // mulberry32
        seed = (seed + 0x6D2B79F5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * limit)
      }
      const undercounts: string[] = []
      for (let trial = 0; trial < 10_000; trial++) {
        const text = Array.from({ length: 1 + next(20) }, () => pool[next(pool.length)]).join('')
        const counted = inMessage(text)
        const longest = Math.max(...(['NFC', 'NFKC', 'NFD', 'NFKD'] as const).map(form => utf8Length(text.normalize(form))), utf8Length(text))
        if (counted < longest) undercounts.push(`${[...text].map(c => c.codePointAt(0)?.toString(16)).join(' ')}: ${counted} < ${longest}`)
      }
      expect(undercounts.slice(0, 3)).toEqual([])
    })

    it('counts a run of 200000 alternating combining marks in linear time, at the exact length', () => {
      // Normalizing this whole run takes minutes (canonical reordering is quadratic in a run of marks), so the
      // test's own time limit is the bound: both marks are 2 bytes in every form.
      const marks = (String.fromCharCode(0x0301) + String.fromCharCode(0x0316)).repeat(100_000)
      expect(inMessage(marks)).toBe(400_000)
    })
  })
})

describe('contextBudget', () => {
  it('reserves maxTokens for the reply, else 16000', () => {
    expect(contextBudget(32768, undefined)).toEqual({ contextTokens: 32768, replyTokens: 16000, templateTokens: 512 })
    expect(contextBudget(32768, 900)).toEqual({ contextTokens: 32768, replyTokens: 900, templateTokens: 512 })
  })

  it('keeps the chat template reserve a budget names', () => {
    expect(contextBudget(200000, undefined, 4096)).toEqual({ contextTokens: 200000, replyTokens: 16000, templateTokens: 4096 })
    expect(() => checkFits('p', shaped, output, { contextTokens: 4229, replyTokens: 100, templateTokens: 4096 })).not.toThrow()
    expect(() => checkFits('p', shaped, output, { contextTokens: 4228, replyTokens: 100, templateTokens: 4096 })).toThrow('p: may need 4229 tokens, more than contextTokens (4228): 33 for its text at one token per byte, 4096 for the chat template and 100 for the reply')
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
    expect(thrown).toMatchObject({
      providerId: 'p',
      kind: 'too-large',
      retryable: false,
      message: 'p: may need 645 tokens, more than contextTokens (644): 33 for its text at one token per byte, 512 for the chat template and 100 for the reply',
    })
  })

  it('lets a request through at the bound', () => {
    expect(() => checkFits('p', shaped, output, { contextTokens: 645, replyTokens: 100 })).not.toThrow()
  })
})
