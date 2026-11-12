import { describe, expect, it } from 'vitest'
import { codePointLabel, hiddenLabels, inertJson, inertJsonLine, inertLine, showHidden, spaceHidden, stripHidden } from './sanitize.ts'

/** Every hidden class the sanitizer knows, to check that an output holds none of them. */
const ANY_HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u

describe('showHidden', () => {
  it('shows every hidden character as its code point, and leaves the workflow command rules to inertLine', () => {
    const text = `::a${String.fromCharCode(0x0A)}b${String.fromCharCode(0x202E)}c ##[d`
    expect(showHidden(text)).toBe('::a<U+000A>b<U+202E>c ##[d')
    expect(inertLine(text)).toBe('<U+003A>:a<U+000A>b<U+202E>c ##<U+005B>d')
  })
})

describe('inertLine', () => {
  it('leaves plain text as it is', () => {
    expect(inertLine('src/a.js:12 is not in the diff, \u00E9t\u00E9')).toBe('src/a.js:12 is not in the diff, \u00E9t\u00E9')
  })

  it('shows every control character as its code point, escape sequences included', () => {
    expect(inertLine('red \u001B[31mtext\u001B[0m')).toBe('red <U+001B>[31mtext<U+001B>[0m')
    expect(inertLine('\u009B2J and \u009D0;title\u009C')).toBe('<U+009B>2J and <U+009D>0;title<U+009C>')
    expect(inertLine('\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007')).toBe('<U+001B>]8;;https://example.com<U+0007>link<U+001B>]8;;<U+0007>')
    expect(inertLine('tab\tdel\u007F')).toBe('tab<U+0009>del<U+007F>')
  })

  it('holds no line break, whatever kind the text has', () => {
    expect(inertLine('a\nb\rc\u0085d\u2028e\u2029f')).toBe('a<U+000A>b<U+000D>c<U+0085>d<U+2028>e<U+2029>f')
  })

  it('shows bidirectional, invisible and tag characters, and unpaired surrogates', () => {
    expect(inertLine('a\u202Eb\u2066c\u200Bd\uFEFFe\u00ADf')).toBe('a<U+202E>b<U+2066>c<U+200B>d<U+FEFF>e<U+00AD>f')
    expect(inertLine('x\u{E0041}\u{E007F}')).toBe('x<U+E0041><U+E007F>')
    expect(inertLine('\uD800x\uDC80')).toBe('<U+D800>x<U+DC80>')
    expect(inertLine('\u2764\uFE0F \u3164')).toBe('\u2764<U+FE0F> <U+3164>')
  })

  it('never starts a workflow command', () => {
    expect(inertLine('::add-mask::secret')).toBe('<U+003A>:add-mask::secret')
    expect(inertLine(' \u00A0::error::x')).toBe(' \u00A0<U+003A>:error::x')
    expect(inertLine('\n::set-env name=x::y')).toBe('<U+000A>::set-env name=x::y')
    expect(inertLine('\u3000::error::x')).toBe('\u3000<U+003A>:error::x')
    expect(inertLine('\u0085::error::x')).toBe('<U+0085>::error::x')
    expect(inertLine('note: a::b')).toBe('note: a::b')
  })

  it('holds no legacy workflow command, wherever the line holds one', () => {
    expect(inertLine('a ##[error]b ###[warning]c')).toBe('a ##<U+005B>error]b ###<U+005B>warning]c')
    expect(inertLine('##[add-mask]e')).toBe('##<U+005B>add-mask]e')
  })
})

describe('inertJson', () => {
  const value = {
    file: 'a\u202Eb.js',
    error: 'HTTP 500: "\u009B2J\u007F"',
    reasoning: 'x\u2028y \u{E0041}',
    plain: '\u00E9t\u00E9 \u{1F600}',
  }

  it('writes what JSON.stringify writes, with the hidden characters it leaves as escapes', () => {
    expect(inertJson(value)).toBe([
      '{',
      '  "file": "a\\u202eb.js",',
      '  "error": "HTTP 500: \\"\\u009b2J\\u007f\\"",',
      '  "reasoning": "x\\u2028y \\udb40\\udc41",',
      '  "plain": "\u00E9t\u00E9 \u{1F600}"',
      '}',
    ].join('\n'))
  })

  it('parses back to the same value', () => {
    expect(JSON.parse(inertJson(value))).toEqual(value)
  })

  it('writes the legacy command marker as an escape, which parses back to the bracket', () => {
    expect(inertJson({ summary: '##[add-mask]e ###[error]x' })).toBe('{\n  "summary": "##\\u005badd-mask]e ###\\u005berror]x"\n}')
    expect(JSON.parse(inertJson({ summary: '##[add-mask]e' })).summary).toBe('##[add-mask]e')
  })

  it('holds no hidden character but its own line breaks', () => {
    const controls = Array.from({ length: 0xA0 }, (_, code) => String.fromCharCode(code)).join('')
    const json = inertJson({
      controls,
      lone: '\uD800',
      tags: '\u{E0001}\u{E0068}',
      selectors: '\uFE0F\u{E0100}',
      separators: '\u2028\u2029',
    })
    expect(json.replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
  })

  it('is JSON.stringify for values without hidden characters', () => {
    const plain = {
      kept: [
        { line: 1, file: 'a.js', confidence: undefined },
      ],
      meta: { usage: null, ok: true },
    }
    expect(inertJson(plain)).toBe(JSON.stringify(plain, null, 2))
  })

  it('refuses a value that has no JSON form', () => {
    expect(() => inertJson(undefined)).toThrow(TypeError)
    expect(() => inertJson(undefined)).toThrow(/^the value has no JSON form$/)
  })
})

describe('inertJsonLine', () => {
  it('writes the JSON on one line, every hidden character escaped and the legacy marker broken, and parses back', () => {
    const value = { a: `x${String.fromCharCode(0x2028)}y`, b: 'line\nbreak', c: `##[error]${String.fromCharCode(0x202E)}` }
    const line = inertJsonLine(value)
    expect(line).not.toContain('\n')
    expect(hiddenLabels(line)).toEqual([])
    expect(line).not.toContain('##[')
    expect(JSON.parse(line)).toEqual(value)
  })

  it('is JSON.stringify for values without hidden characters', () => {
    const plain = {
      kept: [
        { line: 1, file: 'a.js' },
      ],
      meta: { ok: true },
    }
    expect(inertJsonLine(plain)).toBe(JSON.stringify(plain))
  })

  it('refuses a value that has no JSON form', () => {
    expect(() => inertJsonLine(undefined)).toThrow(/^the value has no JSON form$/)
  })
})

describe('the shared helpers', () => {
  it('find, remove and name the hidden characters', () => {
    expect(hiddenLabels('a\u200Bb\u{E0041}c\u200B\t')).toEqual(['U+200B', 'U+E0041', 'U+0009'])
    expect(stripHidden('a\u200Bb\u202Ec\u{E0041}d\uFE0Fe\u0085f\u2028g')).toBe('abcdefg')
    expect([
      '\u001B',
      '\u202E',
      '\u{E0041}',
      '\uDC80',
    ].map(codePointLabel)).toEqual([
      'U+001B',
      'U+202E',
      'U+E0041',
      'U+DC80',
    ])
  })

  it('reads each hidden character as a space, and leaves an emoji and visible text alone', () => {
    expect(spaceHidden('a\u200Bb\tc \u{1F600}d')).toBe('a b c \u{1F600}d')
  })
})
