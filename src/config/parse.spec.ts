import { describe, expect, it } from 'vitest'
import { decode, parseJson, parseRules, parseYaml, rulesFormat } from './parse.ts'

const SECRET = 'sk-planted-secret'
const TAB = String.fromCharCode(9)
const BOM = String.fromCharCode(0xFEFF)

describe('decode', () => {
  it('reads UTF-8 text with its byte-order mark dropped, and refuses bytes that are not UTF-8', () => {
    expect(decode(new TextEncoder().encode(`${BOM}a: 1`))).toEqual({ value: 'a: 1' })
    expect(decode(Uint8Array.from([0x6D, 0x3A, 0x20, 0xE9]))).toEqual({ problem: 'is not UTF-8 text' })
  })
})

describe('parseYaml', () => {
  it.each([
    ['!!js/function', 'a: !!js/function "function () { return 1 }"'],
    ['!!binary', 'a: !!binary aGVsbG8='],
    ['!!set', 'a: !!set {x, y}'],
    ['!!timestamp', 'a: !!timestamp 2024-10-21'],
    ['!!omap', 'a: !!omap [b: 1]'],
    ['!custom', 'a: !custom value'],
  ])('refuses the tag %s, with where it is', (_tag, line) => {
    expect(parseYaml(`concurrency: 1\n${line}\n`)).toEqual({ problem: 'uses a tag quorum does not read at line 2, column 4 (TAG_RESOLVE_FAILED)' })
  })

  it('refuses an alias, and reads a merge key as a key', () => {
    expect(parseYaml('roles: &roles {research: a}\nprofiles:\n  team: {roles: *roles}\n')).toEqual({ problem: 'uses an alias, which quorum does not read' })
    expect(parseYaml('providers:\n  a:\n    <<: {model: m}\n')).toEqual({
      value: {
        providers: {
          a: {
            '<<': { model: 'm' },
          },
        },
      },
    })
  })

  it('keeps off, no and a date as strings, as YAML 1.2 reads them, whatever a %YAML directive says', () => {
    const expected = {
      value: { a: 'off', b: 'no', c: '2024-10-21' },
    }
    expect(parseYaml('a: off\nb: no\nc: 2024-10-21\n')).toEqual(expected)
    expect(parseYaml('%YAML 1.1\n---\na: off\nb: no\nc: 2024-10-21\n')).toEqual(expected)
  })

  it.each([
    ['a duplicate key', `concurrency: 1\nconcurrency: ${SECRET}\n`, 'is not valid YAML at line 2, column 1 (DUPLICATE_KEY)'],
    ['a duplicate key in a provider', `providers:\n  a: {model: m, model: ${SECRET}}\n`, 'is not valid YAML at line 2, column 17 (DUPLICATE_KEY)'],
    ['a duplicate key in a list item', `profiles:\n  t:\n    lenses:\n      - {id: a, question: q, id: ${SECRET}}\n`, 'is not valid YAML at line 4, column 30 (DUPLICATE_KEY)'],
    ['two documents', `concurrency: 1\n---\nmodel: ${SECRET}\n`, 'is not valid YAML at line 2, column 1 (MULTIPLE_DOCS)'],
    ['a tab indent', `roles:\n${TAB}research: ${SECRET}\n`, 'is not valid YAML at line 2, column 1 (TAB_AS_INDENT)'],
    ['a bad indent', `roles:\n  research: a\n voter: ${SECRET}\n`, 'is not valid YAML at line 3, column 1 (BAD_INDENT)'],
    ['an unclosed quote', `model: "${SECRET}\n`, 'is not valid YAML at line 2, column 1 (MISSING_CHAR)'],
    ['a key that is not a scalar', `? [${SECRET}]\n: 1\n`, 'is not valid YAML at line 1, column 3 (NON_STRING_KEY)'],
    ['a directive of another version', '%YAML 1.3\n---\nconcurrency: 1\n', 'is not valid YAML at line 1, column 7 (BAD_DIRECTIVE)'],
  ])('refuses %s, with where it is and the parser\'s code, and never the text of the file', (_name, content, message) => {
    const parsed = parseYaml(content)
    expect(parsed).toEqual({ problem: message })
    expect(JSON.stringify(parsed)).not.toContain('planted')
  })

  it('refuses a document with nothing in it', () => {
    for (const text of ['', '# nothing yet\n', '---\n']) expect(parseYaml(text)).toEqual({ problem: 'is empty' })
  })

  it('finds a key repeated among tens of thousands in one pass, where comparing every pair takes seconds', () => {
    const keys = Array.from({ length: 40_000 }, (_, index) => `h${index}`)
    const json = `{"providers": {"p": {"headers": {${keys.map(key => `"${key}": "v"`).join(', ')}, "h0": "v"}}}}`
    const yaml = `providers:\n  p:\n    headers:\n${keys.map(key => `      ${key}: v`).join('\n')}\n      h0: v\n`
    const started = performance.now()
    expect(parseJson(json)).toEqual({ problem: `has a duplicate key at line 1, column ${json.lastIndexOf('"h0"') + 1}` })
    expect(parseYaml(yaml)).toEqual({ problem: 'is not valid YAML at line 40004, column 7 (DUPLICATE_KEY)' })
    expect(performance.now() - started).toBeLessThan(2500)
  })
})

describe('parseJson', () => {
  it.each([
    ['at the top level', '{"concurrency": 1,\n  "concurrency": 2}', 'has a duplicate key at line 2, column 3'],
    ['in a nested object', '{"providers": {"a": {"model": "m", "model": "sk-planted-secret"}}}', 'has a duplicate key at line 1, column 36'],
    ['in an array', '{"profiles": {"t": {"lenses": [{"id": "a", "id": "b", "question": "q"}]}}}', 'has a duplicate key at line 1, column 44'],
    ['spelled with an escape', '{"concurrency": 1, "\\u0063oncurrency": 2}', 'has a duplicate key at line 1, column 20'],
    ['named __proto__', '{"__proto__": {}, "__proto__": {}}', 'has a duplicate key at line 1, column 19'],
  ])('refuses a duplicate key %s, which JSON.parse would resolve to the last value', (_name, content, message) => {
    const parsed = parseJson(content)
    expect(parsed).toEqual({ problem: message })
    expect(JSON.stringify(parsed)).not.toContain('planted')
  })

  it.each([
    ['a value that is no JSON', `{"apiKeyEnv": ${SECRET}}`],
    ['a trailing comma', `{"model": "${SECRET}",}`],
    ['single quotes', `{'model': '${SECRET}'}`],
    ['a comment', `{"model": "m" /* ${SECRET} */}`],
    ['text after the object', `{"model": "m"} ${SECRET}`],
  ])('refuses %s as JSON, without position or the runtime\'s message, which can quote the file', (_name, content) => {
    expect(parseJson(content)).toEqual({ problem: 'is not valid JSON' })
  })

  it('refuses a document with nothing in it', () => {
    for (const text of ['', ` ${TAB}\n`]) expect(parseJson(text)).toEqual({ problem: 'is empty' })
  })
})

describe('rulesFormat', () => {
  it.each([
    ['rules.yaml', 'yaml'],
    ['.quorum/rules.yml', 'yaml'],
    ['dir/rules.json', 'json'],
    ['rules.YAML', undefined],
    ['rules.toml', undefined],
    ['rules', undefined],
    ['.yaml', undefined],
    ['rules.yaml.bak', undefined],
  ])('reads the extension of %s as %s', (path, format) => {
    expect(rulesFormat(path)).toBe(format)
  })
})

describe('parseRules', () => {
  const LICENSE = { id: 'license', text: 'Each file starts with the license header.' }
  const NO_ANY = {
    id: 'no-any',
    text: 'No any outside tests.',
    paths: ['src/**', '*.test.ts'],
  }
  const YAML = [
    '- id: license',
    '  text: Each file starts with the license header.',
    '- id: no-any',
    '  text: No any outside tests.',
    '  paths: [src/**, "*.test.ts"]',
    '',
  ].join('\n')

  it.each<[string, string, 'yaml' | 'json']>([
    ['a YAML list', YAML, 'yaml'],
    [
      'a JSON list',
      JSON.stringify([LICENSE, NO_ANY]),
      'json',
    ],
  ])('reads the rules file %s as %j', (_name, text, format) => {
    expect(parseRules(text, format)).toEqual({
      value: [LICENSE, NO_ANY],
    })
  })

  it('reads a rule as its three fields alone, and leaves a rule with no paths none', () => {
    const parsed = parseRules(YAML, 'yaml')
    expect('value' in parsed && parsed.value.map(rule => Object.keys(rule))).toEqual([
      ['id', 'text'],
      ['id', 'text', 'paths'],
    ])
  })

  it.each<[string, string, 'yaml' | 'json']>([
    ['an empty YAML list', '[]\n', 'yaml'],
    ['an empty JSON list', '[]', 'json'],
    ['a YAML file of comments alone', '# nothing yet\n', 'yaml'],
    ['a YAML file with nothing in it', '', 'yaml'],
    ['a YAML file of a document marker alone', '---\n', 'yaml'],
    ['a JSON file with nothing in it', ' \n', 'json'],
  ])('reads %s as a file that holds no rule, never an error', (_name, text, format) => {
    expect(parseRules(text, format)).toEqual({ value: [] })
  })

  it.each<[string, string, 'yaml' | 'json', string]>([
    [
      'is no list',
      'id: license\ntext: x\n',
      'yaml',
      'must be a list of rules',
    ],
    [
      'is a JSON object',
      '{"id": "license", "text": "x"}',
      'json',
      'must be a list of rules',
    ],
    [
      'holds an unknown key',
      '- id: license\n  text: x\n  colour: blue\n',
      'yaml',
      '0.colour is not a known field',
    ],
    [
      'holds a key that is no safe name',
      `[{"id": "a", "text": "x"}, {"id": "b", "text": "x", "${SECRET} ": 1}]`,
      'json',
      '1 holds a field that is not known',
    ],
    [
      'holds a __proto__ key',
      '[{"id": "a", "text": "x", "__proto__": {}}]',
      'json',
      '0.__proto__ is not a known field',
    ],
    [
      'repeats a key',
      '- id: license\n  text: x\n  text: y\n',
      'yaml',
      'is not valid YAML at line 3, column 3 (DUPLICATE_KEY)',
    ],
    [
      'repeats a key in JSON',
      '[{"id": "a", "id": "b", "text": "x"}]',
      'json',
      'has a duplicate key at line 1, column 14',
    ],
    [
      'holds an alias',
      '- &a {id: license, text: x}\n- *a\n',
      'yaml',
      'uses an alias, which quorum does not read',
    ],
    [
      'holds a tag',
      '- id: license\n  text: !!binary aGVsbG8=\n',
      'yaml',
      'uses a tag quorum does not read at line 2, column 9 (TAG_RESOLVE_FAILED)',
    ],
    [
      'holds a rule whose paths is no list',
      '- id: license\n  text: x\n  paths: src/**\n',
      'yaml',
      '0.paths must be an array of patterns',
    ],
    [
      'holds a pattern that is no string',
      '[{"id": "a", "text": "x", "paths": ["src/**", 7]}]',
      'json',
      '0.paths.1 must be a string',
    ],
    [
      'holds a rule that is no object',
      '- id: a\n  text: x\n- just words\n',
      'yaml',
      '1 must be an object with an id and a text',
    ],
    [
      'holds a rule with no id',
      '- text: x\n',
      'yaml',
      '0.id is required',
    ],
    [
      'holds a rule with no text',
      '- id: a\n- id: b\n  text: x\n',
      'yaml',
      '0.text is required',
    ],
    [
      'holds an id that is no string',
      '- id: 7\n  text: x\n',
      'yaml',
      '0.id must be a string',
    ],
    [
      'holds a text that is no string',
      '- id: a\n  text: [x]\n',
      'yaml',
      '0.text must be a string',
    ],
    [
      'is not JSON',
      '[{"id": "a", "text": "x",}]',
      'json',
      'is not valid JSON',
    ],
  ])('refuses a rules file that %s', (_name, text, format, problem) => {
    expect(parseRules(text, format)).toEqual({ problem })
  })

  it('names the rule by its position, and holds no text of the file in a problem', () => {
    const parsed = parseRules('- id: a\n  text: x\n- id: Planted-Text\n  text: [planted]\n', 'yaml')
    expect(parsed).toEqual({ problem: '1.text must be a string' })
    expect(JSON.stringify(parsed)).not.toContain('lanted')
  })
})
