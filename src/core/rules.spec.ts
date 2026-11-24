import { describe, expect, it } from 'vitest'
import { UNSETTLED } from './sanitize.ts'
import { entriesBytes, largestRule, MAX_RULE_PATHS, MAX_RULE_TEXT, MAX_RULES, RULE_ID, ruleEntry, ruleIssues, RULES_CAP, rulesBlock, rulesCountProblem, rulesSent, ruleTextBytes, ruleTextSizes } from './rules.ts'
import type { ReviewRule } from './types.ts'

const char = (code: number): string => String.fromCharCode(code)
const nested = (levels: number): string => '<'.repeat(levels) + '!---->'.repeat(levels)

const noAny: ReviewRule = {
  id: 'no-any',
  text: 'No any outside tests.',
  paths: ['src/**'],
}
const license: ReviewRule = { id: 'license', text: 'Each file starts with the license header.' }

/** The issues of `rules` as `path: message` pairs, at the root the profile's rules have. */
const issuesOf = (rules: unknown): Array<readonly [string, string]> => ruleIssues(rules, 'naming.rules').map(issue => [issue.path, issue.message] as const)

describe('the values of a rule', () => {
  it('holds the values the design states', () => {
    expect(RULE_ID.source).toBe('^[a-z][a-z0-9._-]{0,63}$')
    expect([
      MAX_RULES,
      MAX_RULE_TEXT,
      RULES_CAP,
      MAX_RULE_PATHS,
    ]).toEqual([100, 1024, 32_768, 20])
  })
})

describe('ruleIssues', () => {
  it.each<[string, () => unknown, Array<readonly [string, string]>]>([
    [
      'id is No-any',
      () => [
        { ...noAny, id: 'No-any' },
      ],
      [
        ['naming.rules.0.id', 'must match ^[a-z][a-z0-9._-]{0,63}$'],
      ],
    ],
    [
      'id holds 65 characters',
      () => [
        { ...noAny, id: `a${'b'.repeat(64)}` },
      ],
      [
        ['naming.rules.0.id', 'must match ^[a-z][a-z0-9._-]{0,63}$'],
      ],
    ],
    [
      'id repeats an earlier one',
      () => [
        noAny,
        license,
        { ...license, id: 'no-any' },
      ],
      [
        ['naming.rules.2.id', 'repeats the rule id "no-any"'],
      ],
    ],
    [
      'text holds 1025 code points once cleaned',
      () => [
        {
          ...license,
          text: 'a'.repeat(1025),
        },
      ],
      [
        ['naming.rules.0.text', 'must hold 1 to 1024 characters once cleaned'],
      ],
    ],
    [
      'text is blank once cleaned',
      () => [
        { ...license, text: ` ${char(0x200B)}<!-- note -->\n` },
      ],
      [
        ['naming.rules.0.text', 'must hold 1 to 1024 characters once cleaned'],
      ],
    ],
    [
      'text is unsettled',
      () => [
        {
          ...license,
          text: nested(17),
        },
      ],
      [
        ['naming.rules.0.text', UNSETTLED],
      ],
    ],
    [
      'paths are empty',
      () => [
        { ...noAny, paths: [] },
      ],
      [
        ['naming.rules.0.paths', 'must hold 1 to 20 patterns'],
      ],
    ],
    [
      'paths hold 21 patterns',
      () => [
        {
          ...noAny,
          paths: Array.from({ length: 21 }, (_, index) => `dir${index}/**`),
        },
      ],
      [
        ['naming.rules.0.paths', 'must hold 1 to 20 patterns'],
      ],
    ],
    [
      'paths hold a pattern exclude refuses',
      () => [
        {
          ...noAny,
          paths: ['src/**', 'docs/'],
        },
      ],
      [
        ['naming.rules.0.paths.1', 'ends with /, so it matches no file: end it with /** to leave out what the directory holds'],
      ],
    ],
    [
      'list holds 101 rules',
      () => Array.from({ length: 101 }, (_, index) => ({ id: `rule-${index}`, text: 'Keep it short.' })),
      [
        ['naming.rules', 'must hold at most 100 rules'],
      ],
    ],
    [
      'texts take 32769 bytes in all',
      () => [
        ...Array.from({ length: 32 }, (_, index) => ({
          id: `rule-${index}`,
          text: 'a'.repeat(1024),
        })),
        { id: 'one-more', text: 'b' },
        { id: 'and-another', text: 'c' },
      ],
      [
        ['naming.rules.32', 'takes the profile\'s rules to 32769 bytes once cleaned, over the 32 KiB they may hold in all'],
      ],
    ],
  ])('refuses a rule list whose %s', (_name, rules, issues) => {
    expect(issuesOf(rules())).toEqual(issues)
  })

  it('accepts a rule of 1024 code points of text and 20 patterns', () => {
    const wide = Array.from({ length: 20 }, (_, index) => `dir${index}/**`)
    expect(issuesOf([
      {
        id: 'a',
        text: 'x'.repeat(1024),
        paths: wide,
      },
    ])).toEqual([])
    // The cleaned text is what is counted: a hidden character, a comment and a code point of four bytes.
    expect(issuesOf([
      { id: 'b', text: `${'x'.repeat(1023)}${String.fromCodePoint(0x1F600)}${char(0x200B)}<!-- c -->` },
    ])).toEqual([])
    expect(issuesOf([])).toEqual([])
    expect(issuesOf(Array.from({ length: 100 }, (_, index) => ({ id: `rule-${index}`, text: 'Keep it short.' })))).toEqual([])
    // 32 rules of 1024 bytes are the whole 32 KiB.
    expect(issuesOf(Array.from({ length: 32 }, (_, index) => ({
      id: `rule-${index}`,
      text: 'a'.repeat(1024),
    })))).toEqual([])
  })

  it('refuses what is no list of rules, no rule, or no text or patterns, each at its field', () => {
    expect(issuesOf('no-any')).toEqual([
      ['naming.rules', 'must be an array of rules'],
    ])
    expect(issuesOf([
      null,
      'license',
      { id: 'a' },
      { id: 'b', text: 'x', paths: 'src/**' },
      {
        id: 'c',
        text: 'x',
        paths: [7],
      },
      { text: 'x' },
    ])).toEqual([
      ['naming.rules.0', 'must be an object with an id and a text'],
      ['naming.rules.1', 'must be an object with an id and a text'],
      ['naming.rules.2.text', 'must be a string'],
      ['naming.rules.3.paths', 'must be an array of patterns'],
      ['naming.rules.4.paths.0', 'must be a string'],
      ['naming.rules.5.id', 'must match ^[a-z][a-z0-9._-]{0,63}$'],
    ])
  })

  it('never repeats a rule\'s text in a message', () => {
    const words = ruleIssues([
      {
        id: 'no-any',
        text: `SECRET${'x'.repeat(2000)}`,
        paths: [''],
      },
    ], 'naming.rules').map(issue => issue.message).join('\n')
    expect(words).not.toContain('SECRET')
  })
})

describe('the rules a profile holds in all', () => {
  it('words the count of rules over the 100 a profile may list, whatever their origin', () => {
    expect(rulesCountProblem(100)).toBeUndefined()
    expect(rulesCountProblem(101)).toBe('must hold at most 100 rules')
  })

  it('measures the cleaned texts of every rule, however many there are, and of no list that cannot be measured', () => {
    const rules = Array.from({ length: 150 }, (_, index) => ({ id: `rule-${index}`, text: `${'x'.repeat(10)}${char(0x200B)}<!-- c -->` }))
    expect(ruleTextBytes(rules)).toBe(1500)
    expect(ruleTextBytes([])).toBe(0)
    expect(ruleTextBytes('x')).toBeUndefined()
    expect(ruleTextBytes([
      { id: 'a' },
    ])).toBeUndefined()
    expect(ruleTextBytes([
      {
        id: 'a',
        text: nested(17),
      },
    ])).toBeUndefined()
  })
})

describe('the bytes a rules list is told over the 32 KiB by', () => {
  const wide = Array.from({ length: 33 }, (_, index) => ({
    id: `rule-${index}`,
    text: 'a'.repeat(1024),
  }))
  const words = (bytes: number): string => `takes the profile's rules to ${bytes} bytes once cleaned, over the 32 KiB they may hold in all`

  it('names the profile\'s total at the rule that takes the list over, what the profile holds before it counted first', () => {
    expect(ruleIssues(wide, 'x')).toEqual([
      {
        path: 'x.32',
        message: words(33_792),
      },
    ])
    expect(ruleIssues(wide, 'x', 0)).toEqual([
      {
        path: 'x.32',
        message: words(33_792),
      },
    ])
    expect(ruleIssues(wide, 'x', 100)).toEqual([
      {
        path: 'x.32',
        message: words(33_892),
      },
    ])
    // The place is where the list is over by itself, and a list within the cap by itself is no issue of this list, whatever the profile held: the documents' check tells the total.
    expect(ruleIssues(wide.slice(0, 32), 'x', 100)).toEqual([])
  })

  it('measures each rule\'s cleaned text, and no list that cannot be measured', () => {
    expect(ruleTextSizes([
      { id: 'a', text: `abc${char(0x200B)}` },
      { id: 'b', text: 'é' },
    ])).toEqual([3, 2])
    expect(ruleTextSizes([])).toEqual([])
    expect(ruleTextSizes('x')).toBeUndefined()
    expect(ruleTextSizes([
      {
        id: 'a',
        text: nested(17),
      },
    ])).toBeUndefined()
  })
})

describe('rulesSent', () => {
  it('sends the rules whose paths match a file of the change, in order, and every rule without paths', () => {
    expect(rulesSent([noAny, license], ['docs/a.md'])).toEqual([license])
    expect(rulesSent([noAny, license], ['src/x.ts', 'docs/a.md'])).toEqual([noAny, license])
    expect(rulesSent([license, noAny], ['src/x.ts'])).toEqual([license, noAny])
    // A diff with no header names its one file '', which no pattern of a directory matches, and which every rule without paths takes.
    expect(rulesSent([noAny, license], [''])).toEqual([license])
    expect(rulesSent([noAny, license], [])).toEqual([license])
    expect(rulesSent([], ['src/x.ts'])).toEqual([])
  })

  it('reads a pattern as exclude does: a name alone in any directory, a directory from the root', () => {
    const scripts: ReviewRule = {
      id: 'scripts',
      text: 'Scripts are shell.',
      paths: ['*.sh', '/tools/**'],
    }
    expect(rulesSent([scripts], ['deep/dir/run.sh'])).toEqual([scripts])
    expect(rulesSent([scripts], ['tools/run.py'])).toEqual([scripts])
    expect(rulesSent([scripts], ['src/tools/run.py'])).toEqual([])
  })
})

describe('the rules block', () => {
  it('writes one rule a paragraph, its patterns shown, its text after the line', () => {
    expect(rulesBlock([noAny, license])).toBe('no-any, for src/**:\nNo any outside tests.\n\nlicense, for every file:\nEach file starts with the license header.')
    expect(ruleEntry({
      id: 'docs',
      text: 'Say why.',
      paths: ['docs/**', '*.md'],
    })).toBe('docs, for docs/**, *.md:\nSay why.')
    expect(rulesBlock([license])).toBe(ruleEntry(license))
  })

  it('shows the hidden characters of a pattern as <U+XXXX>, so a pattern stays on its line', () => {
    expect(ruleEntry({
      id: 'odd',
      text: 'Keep it.',
      paths: [`src${char(0x200B)}/**`, `a${char(0x0A)}b`],
    })).toBe('odd, for src<U+200B>/**, a<U+000A>b:\nKeep it.')
  })

  it('counts the bytes of its entries in UTF-8', () => {
    const accented: ReviewRule = { id: 'accents', text: 'Évitez les accents.' }
    expect(entriesBytes([noAny, accented])).toBe(Buffer.byteLength(ruleEntry(noAny)) + Buffer.byteLength(ruleEntry(accented)))
    expect(entriesBytes([])).toBe(0)
  })
})

describe('largestRule', () => {
  it('picks the rule whose entry takes the most bytes, the first of equals', () => {
    const wide: ReviewRule = {
      id: 'wide',
      text: 'x'.repeat(200),
    }
    const same: ReviewRule = {
      id: 'same',
      text: 'y'.repeat(200),
    }
    expect(largestRule([noAny, wide, license])).toBe(wide)
    expect(largestRule([same, wide])).toBe(same)
    expect(largestRule([wide, same])).toBe(wide)
    // The entry counts, not the text: a long list of patterns weighs.
    const where: ReviewRule = {
      id: 'where',
      text: 'z',
      paths: Array.from({ length: 20 }, (_, index) => `directory-${index}/**`),
    }
    expect(largestRule([license, where])).toBe(where)
    expect(largestRule([])).toBeUndefined()
  })
})
