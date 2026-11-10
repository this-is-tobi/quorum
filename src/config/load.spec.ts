import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { readConfigFile } from './load.ts'

const SECRET = 'sk-planted-secret'
const TAB = String.fromCharCode(9)
const BOM = String.fromCharCode(0xFEFF)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-load-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write `content` to `name` in the test's directory, and return the name. */
function file(name: string, content: string | Uint8Array): string {
  writeFileSync(join(dir, name), content)
  return name
}

/** The issues of the ConfigError that reading `name` throws; none when it loads. */
async function issuesOf(name: string): Promise<readonly ConfigIssue[]> {
  try {
    await readConfigFile(name, { cwd: dir })
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues
  }
  return []
}

/** The config read from `name` in the test's directory. */
async function configOf(name: string): Promise<Record<string, unknown>> {
  return (await readConfigFile(name, { cwd: dir })).config as Record<string, unknown>
}

describe('readConfigFile', () => {
  it('reads a YAML file into a checked config, with its absolute path', async () => {
    file('quorum.yaml', 'version: 1\nproviders:\n  local: {preset: ollama, model: "qwen3.6:27b"}\nroles: {research: local}\n')
    expect(await readConfigFile('quorum.yaml', { cwd: dir })).toEqual({
      config: { version: 1, providers: { local: { preset: 'ollama', model: 'qwen3.6:27b' } }, roles: { research: 'local' } },
      source: join(dir, 'quorum.yaml'),
    })
  })

  it('reads a .yml file and a JSON file the same way', async () => {
    file('a.yml', 'concurrency: 2\n')
    file('a.json', '{"$schema": "https://example.test/s.json", "concurrency": 2}')
    expect(await configOf('a.yml')).toEqual({ concurrency: 2 })
    expect(await configOf('a.json')).toEqual({ $schema: 'https://example.test/s.json', concurrency: 2 })
  })

  it('resolves a relative path against the working directory by default, and keeps an absolute path', async () => {
    const name = file('cwd.yaml', 'maxFindings: 3\n')
    expect((await readConfigFile(relative(process.cwd(), join(dir, name)))).source).toBe(join(dir, name))
    expect((await readConfigFile(join(dir, name), { cwd: '/nowhere' })).config).toEqual({ maxFindings: 3 })
  })

  it.each(['quorum.toml', 'quorum', 'quorum.YAML', 'quorum.yaml.bak', 'quorum.constructor', 'quorum.__proto__'])('refuses the extension of %s, and reads nothing', async (name) => {
    expect(await issuesOf(name)).toEqual([{ path: name, message: 'must end in .yaml, .yml or .json' }])
  })

  it('refuses a missing file, a directory and a device, naming the path as the caller gave it', async () => {
    mkdirSync(join(dir, 'folder.yaml'))
    expect(await issuesOf('missing.yaml')).toEqual([{ path: 'missing.yaml', message: 'does not exist' }])
    expect(await issuesOf('./missing/inner.json')).toEqual([{ path: './missing/inner.json', message: 'does not exist' }])
    expect(await issuesOf('folder.yaml')).toEqual([{ path: 'folder.yaml', message: 'is not a file' }])
    file('plain.json', '{}')
    expect(await issuesOf('plain.json/inner.json')).toEqual([{ path: 'plain.json/inner.json', message: 'does not exist' }])
  })

  it.skipIf(process.platform === 'win32')('follows a link to a regular file, and refuses one to a device, which is no regular file', async () => {
    symlinkSync(join(dir, file('real.yaml', 'concurrency: 1\n')), join(dir, 'link.yaml'))
    symlinkSync('/dev/null', join(dir, 'device.yaml'))
    expect(await configOf('link.yaml')).toEqual({ concurrency: 1 })
    expect(await issuesOf('device.yaml')).toEqual([{ path: 'device.yaml', message: 'is not a file' }])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a file it cannot read, without the runtime\'s message', async () => {
    file('locked.yaml', 'concurrency: 1\n')
    chmodSync(join(dir, 'locked.yaml'), 0o000)
    expect(await issuesOf('locked.yaml')).toEqual([{ path: 'locked.yaml', message: 'cannot be read' }])
  })

  it('reads a file of exactly 1 MiB, and refuses one byte more', async () => {
    const mib = 1024 * 1024
    file('full.yaml', `concurrency: 1\n#${'x'.repeat(mib - 17)}\n`)
    file('over.yaml', `concurrency: 1\n#${'x'.repeat(mib - 16)}\n`)
    expect(await configOf('full.yaml')).toEqual({ concurrency: 1 })
    expect(await issuesOf('over.yaml')).toEqual([{ path: 'over.yaml', message: 'is over 1 MiB' }])
  })

  it('refuses bytes that are not UTF-8, and drops a leading byte-order mark', async () => {
    file('latin1.yaml', Uint8Array.from([0x6D, 0x3A, 0x20, 0xE9, 0x0A]))
    file('bom.yaml', `${BOM}concurrency: 2\n`)
    file('bom.json', `${BOM}{"concurrency": 2}`)
    expect(await issuesOf('latin1.yaml')).toEqual([{ path: 'latin1.yaml', message: 'is not UTF-8 text' }])
    expect(await configOf('bom.yaml')).toEqual({ concurrency: 2 })
    expect(await configOf('bom.json')).toEqual({ concurrency: 2 })
  })

  it.each([['empty.yaml', ''], ['comments.yaml', '# nothing yet\n'], ['dashes.yaml', '---\n'], ['empty.json', ''], ['blank.json', ` ${TAB}\n`]])('refuses %s, which holds no settings', async (name, content) => {
    expect(await issuesOf(file(name, content))).toEqual([{ path: name, message: 'is empty' }])
  })

  it.each([['list.yaml', '- concurrency: 1\n'], ['scalar.yaml', 'concurrency\n'], ['list.json', '[{"concurrency": 1}]'], ['number.json', '4'], ['null.json', 'null']])('refuses %s, whose value is not a mapping', async (name, content) => {
    expect(await issuesOf(file(name, content))).toEqual([{ path: name, message: 'must hold a mapping of settings' }])
  })

  it('reports the schema\'s issues at their paths after the file\'s, all at once', async () => {
    file('bad.yaml', 'version: 2\nproviders:\n  local: {preset: gpt, model: 1}\ncolour: blue\n')
    expect(await issuesOf('bad.yaml')).toEqual([
      { path: 'bad.yaml: version', message: 'must be 1, the only config version this quorum reads: upgrade quorum to read a later one' },
      { path: 'bad.yaml: providers.local.preset', message: 'must be one of ollama, ollama-cloud, lmstudio, llamacpp, vllm, openai, azure-openai, openrouter, groq, mistral, deepseek, together, fireworks, xai, anthropic or gemini' },
      { path: 'bad.yaml: providers.local.model', message: 'must be a string' },
      { path: 'bad.yaml: colour', message: 'is not a known field' },
    ])
  })

  it('refuses a key in YAML or JSON, which only a code config may hold', async () => {
    file('key.yaml', `providers:\n  p: {preset: openai, apiKey: ${SECRET}}\n`)
    expect(await issuesOf('key.yaml')).toEqual([{ path: 'key.yaml: providers.p.apiKey', message: 'is not a known field' }])
  })
})

describe('readConfigFile on YAML', () => {
  it('keeps off, no and a date as strings, as YAML 1.2 reads them', async () => {
    file('words.yaml', 'providers:\n  a: {model: off}\n  b: {model: no}\n  c: {model: 2024-10-21}\n  d: {model: yes}\n')
    expect(await configOf('words.yaml')).toEqual({ providers: { a: { model: 'off' }, b: { model: 'no' }, c: { model: '2024-10-21' }, d: { model: 'yes' } } })
  })

  it('reads a %YAML 1.1 directive as YAML 1.2 all the same: off stays a string, and << stays a key', async () => {
    file('old.yaml', '%YAML 1.1\n---\nproviders:\n  a: {model: off}\n')
    file('merge.yaml', '%YAML 1.1\n---\nproviders:\n  a:\n    <<: {model: m}\n')
    expect(await configOf('old.yaml')).toEqual({ providers: { a: { model: 'off' } } })
    expect(await issuesOf('merge.yaml')).toEqual([{ path: 'merge.yaml: providers.a', message: 'holds a field that is not known' }])
  })

  it.each([
    ['!!js/function', 'a: !!js/function "function () { return 1 }"'],
    ['!!binary', 'a: !!binary aGVsbG8='],
    ['!!set', 'a: !!set {x, y}'],
    ['!!timestamp', 'a: !!timestamp 2024-10-21'],
    ['!!omap', 'a: !!omap [b: 1]'],
    ['!custom', 'a: !custom value'],
  ])('refuses the tag %s, with where it is', async (_tag, line) => {
    file('tag.yaml', `concurrency: 1\n${line}\n`)
    expect(await issuesOf('tag.yaml')).toEqual([{ path: 'tag.yaml', message: 'uses a tag quorum does not read at line 2, column 4 (TAG_RESOLVE_FAILED)' }])
  })

  it('refuses an alias, and a merge key, which stays a key quorum does not know', async () => {
    file('alias.yaml', 'roles: &roles {research: a}\nprofiles:\n  team: {roles: *roles}\n')
    file('merge.yaml', 'providers:\n  a:\n    <<: {model: m}\n    preset: ollama\n')
    expect(await issuesOf('alias.yaml')).toEqual([{ path: 'alias.yaml', message: 'uses an alias, which quorum does not read' }])
    expect(await issuesOf('merge.yaml')).toEqual([{ path: 'merge.yaml: providers.a', message: 'holds a field that is not known' }])
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
  ])('refuses %s, with where it is and the parser\'s code, and never the text of the file', async (_name, content, message) => {
    file('bad.yaml', content)
    const issues = await issuesOf('bad.yaml')
    expect(issues).toEqual([{ path: 'bad.yaml', message }])
    expect(JSON.stringify(issues)).not.toContain('planted')
  })

  it('refuses a number that is not finite, at its path', async () => {
    file('inf.yaml', 'concurrency: .inf\nproviders:\n  a: {temperature: .nan}\n')
    expect(await issuesOf('inf.yaml')).toEqual([
      { path: 'inf.yaml: concurrency', message: 'must be a finite number' },
      { path: 'inf.yaml: providers.a.temperature', message: 'must be a finite number' },
    ])
  })
})

describe('readConfigFile on JSON', () => {
  it.each([
    ['at the top level', '{"concurrency": 1,\n  "concurrency": 2}', 'has a duplicate key at line 2, column 3'],
    ['in a nested object', '{"providers": {"a": {"model": "m", "model": "sk-planted-secret"}}}', 'has a duplicate key at line 1, column 36'],
    ['in an array', '{"profiles": {"t": {"lenses": [{"id": "a", "id": "b", "question": "q"}]}}}', 'has a duplicate key at line 1, column 44'],
    ['spelled with an escape', '{"concurrency": 1, "\\u0063oncurrency": 2}', 'has a duplicate key at line 1, column 20'],
    ['named __proto__', '{"__proto__": {}, "__proto__": {}}', 'has a duplicate key at line 1, column 19'],
  ])('refuses a duplicate key %s, which JSON.parse would resolve to the last value', async (_name, content, message) => {
    file('dup.json', content)
    const issues = await issuesOf('dup.json')
    expect(issues).toEqual([{ path: 'dup.json', message }])
    expect(JSON.stringify(issues)).not.toContain('planted')
  })

  it.each([
    ['a value that is no JSON', `{"apiKeyEnv": ${SECRET}}`],
    ['a trailing comma', `{"model": "${SECRET}",}`],
    ['single quotes', `{'model': '${SECRET}'}`],
    ['a comment', `{"model": "m" /* ${SECRET} */}`],
    ['text after the object', `{"model": "m"} ${SECRET}`],
  ])('refuses %s as JSON, without position or the runtime\'s message, which can quote the file', async (_name, content) => {
    file('bad.json', content)
    const issues = await issuesOf('bad.json')
    expect(issues).toEqual([{ path: 'bad.json', message: 'is not valid JSON' }])
  })

  it('refuses a number past the largest double, which JSON.parse reads as Infinity', async () => {
    file('big.json', '{"maxFindings": 1e999}')
    expect(await issuesOf('big.json')).toEqual([{ path: 'big.json: maxFindings', message: 'must be a finite number' }])
  })

  it('refuses a value more than 64 keys deep, before any schema reads it', async () => {
    const deep = (levels: number): string => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`
    file('deep.json', `{"providers": {"p": {"extraBody": ${deep(61)}}}}`)
    file('deeper.json', `{"providers": {"p": {"extraBody": ${deep(62)}}}}`)
    expect(await issuesOf('deep.json')).toEqual([])
    const issues = await issuesOf('deeper.json')
    expect(issues).toEqual([{ path: `deeper.json: providers.p.extraBody.${Array.from({ length: 62 }).fill('a').join('.')}`, message: 'is nested more than 64 keys deep' }])
  })
})

describe('readConfigFile on a wide mapping', () => {
  it('finds a key repeated among tens of thousands in one pass, where comparing every pair takes seconds', async () => {
    const keys = Array.from({ length: 40_000 }, (_, index) => `h${index}`)
    const json = `{"providers": {"p": {"headers": {${keys.map(key => `"${key}": "v"`).join(', ')}, "h0": "v"}}}}`
    file('wide.json', json)
    file('wide.yaml', `providers:\n  p:\n    headers:\n${keys.map(key => `      ${key}: v`).join('\n')}\n      h0: v\n`)
    const started = performance.now()
    expect(await issuesOf('wide.json')).toEqual([{ path: 'wide.json', message: `has a duplicate key at line 1, column ${json.lastIndexOf('"h0"') + 1}` }])
    expect(await issuesOf('wide.yaml')).toEqual([{ path: 'wide.yaml', message: 'is not valid YAML at line 40004, column 7 (DUPLICATE_KEY)' }])
    expect(performance.now() - started).toBeLessThan(2500)
  })
})

describe('readConfigFile on a __proto__ key', () => {
  const PROTO = 'is not allowed as a key: it can replace the prototype of an object'

  it.each([
    ['proto.yaml', '__proto__: {polluted: true}\n', '__proto__'],
    ['proto.json', '{"__proto__": {"polluted": true}}', '__proto__'],
    ['providers.yaml', 'providers:\n  __proto__: {polluted: true}\n', 'providers.__proto__'],
    ['providers.json', '{"providers": {"__proto__": {"polluted": true}}}', 'providers.__proto__'],
    ['headers.yaml', 'providers:\n  a:\n    headers: {__proto__: {polluted: "yes"}}\n', 'providers.a.headers.__proto__'],
    ['headers.json', '{"providers": {"a": {"headers": {"__proto__": {"polluted": "yes"}}}}}', 'providers.a.headers.__proto__'],
    ['extra.yaml', 'providers:\n  a:\n    extraBody: {options: {__proto__: {polluted: true}}}\n', 'providers.a.extraBody.options.__proto__'],
    ['extra.json', '{"providers": {"a": {"extraBody": {"options": {"__proto__": {"polluted": true}}}}}}', 'providers.a.extraBody.options.__proto__'],
    ['quoted.yaml', 'profiles:\n  t:\n    lenses:\n      - {"__proto__": {polluted: true}}\n', 'profiles.t.lenses.0.__proto__'],
  ])('refuses the key in %s at its path, and changes no prototype', async (name, content, path) => {
    file(name, content)
    expect(await issuesOf(name)).toEqual([{ path: `${name}: ${path}`, message: PROTO }])
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('allows constructor and prototype, which are valid names, as own keys', async () => {
    file('names.yaml', 'providers:\n  constructor: {model: m}\n  prototype: {model: m}\nroles: {research: constructor}\n')
    const config = await configOf('names.yaml')
    expect(Object.keys(config.providers as object)).toEqual(['constructor', 'prototype'])
    expect(Object.getPrototypeOf(config.providers)).toBe(Object.prototype)
  })
})
