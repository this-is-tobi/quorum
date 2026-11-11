import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionRequest, Provider } from '../core/ports.ts'
import { loadConfig, readConfigFile } from './load.ts'
import { configFileSchema } from './schema.ts'

const SECRET = 'sk-planted-secret'
const REQUEST: CompletionRequest = { system: '', messages: [], output: { name: 'x', schema: {} } }
const TAB = String.fromCharCode(9)
const BOM = String.fromCharCode(0xFEFF)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-load-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write `content` to `name` in the test's directory, its folders made as needed, and return the name. */
function file(name: string, content: string | Uint8Array): string {
  mkdirSync(join(dir, name, '..'), { recursive: true })
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

  it.each(['quorum.toml', 'quorum', 'quorum.YAML', 'quorum.yaml.bak', 'quorum.cts', 'quorum.cjs', 'quorum.tsx', 'quorum.constructor', 'quorum.__proto__'])('refuses the extension of %s, and reads nothing', async (name) => {
    expect(await issuesOf(name)).toEqual([{ path: name, message: 'must end in .yaml, .yml, .json, .mts, .mjs, .ts or .js' }])
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

  it.each([
    ['an error', new RangeError(SECRET), 'could not be checked (RangeError)'],
    ['a string', SECRET, 'could not be checked (a value that is not an error)'],
  ])('reports %s thrown by the schema check of a data file by its name, at the file', async (_name, thrown, message) => {
    file('quorum.yaml', 'concurrency: 1\n')
    const safeParse = vi.spyOn(configFileSchema, 'safeParse').mockImplementation(() => {
      throw thrown
    })
    try {
      const issues = await issuesOf('quorum.yaml')
      expect(issues).toEqual([{ path: 'quorum.yaml', message }])
      expect(JSON.stringify(issues)).not.toContain('planted')
    } finally {
      safeParse.mockRestore()
    }
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

describe('readConfigFile on a deep file', () => {
  const LEVELS = 5000

  // Under Node the parser may refuse a file this deep with its own resource issue before any walk of ours;
  // under Bun it reads it whole, and only the check of the duplicate keys, which stops at the depth limit, keeps it fast.
  it('refuses JSON nested 5000 deep within a second', async () => {
    file('deep.json', `${'{"a":'.repeat(LEVELS)}1${'}'.repeat(LEVELS)}`)
    const started = performance.now()
    expect(await issuesOf('deep.json')).not.toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('refuses YAML nested 5000 deep within a second', async () => {
    file('deep.yaml', `a: ${'['.repeat(LEVELS)}${']'.repeat(LEVELS)}\n`)
    const started = performance.now()
    expect(await issuesOf('deep.yaml')).not.toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('readConfigFile on a file of many values', () => {
  const MANY = { path: 'many.json', message: 'holds more than 10000 values' }

  /** A JSON config whose one profile holds `count` empty lenses: the schema finds two issues in each. */
  const lenses = (count: number): string => `{"version":1,"profiles":{"p":{"lenses":[${Array.from<string>({ length: count }).fill('{}').join(',')}]}}}`
  /** A JSON config of `count` headers, which holds `count` + 4 values: the root, providers, one provider and its headers. */
  const headers = (count: number): string => JSON.stringify({ providers: { p: { headers: Object.fromEntries(Array.from({ length: count }, (_, index) => [`h${index}`, 'v'])) } } })

  it('refuses a file of more than 10000 values with one issue at the file', async () => {
    // 205 KiB, whose 140000 schema issues were more than the runtime takes in one call.
    file('many.json', lenses(70_000))
    expect(await issuesOf('many.json')).toEqual([MANY])
  })

  it('reads a config of exactly 10000 values, and refuses one with a value more', async () => {
    file('full.json', headers(9996))
    file('many.json', headers(9997))
    expect(await issuesOf('full.json')).toEqual([])
    expect(await issuesOf('many.json')).toEqual([MANY])
  })

  it('refuses a code config that refers to itself twice', async () => {
    file('self.mts', 'const a = {}\na.l = a\na.r = a\nexport default a\n')
    const started = performance.now()
    expect(await issuesOf('self.mts')).toEqual([{ path: 'self.mts', message: 'holds more than 10000 values' }])
    expect(performance.now() - started).toBeLessThan(1000)
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
    ['query.yaml', 'providers:\n  a:\n    query: {__proto__: {polluted: "yes"}}\n', 'providers.a.query.__proto__'],
    ['query.json', '{"providers": {"a": {"query": {"__proto__": {"polluted": "yes"}}}}}', 'providers.a.query.__proto__'],
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

/** A config whose provider object has an id of its own and an answer that shows the object it is called on, its function giving up its `call` to no one. */
const NAMED_SOURCE = [
  'const complete = async function () { return { text: this.id, model: "m" } }',
  'Object.defineProperty(complete, "call", { get() { throw new Error("SECRET") } })',
  'export default { providers: { keyed: { id: "own", model: "m", complete } } }',
].join('\n')

/** A provider object written as a module's source, its reply fixed. */
const PROVIDER_SOURCE = '{ id: "mine", model: "m", async complete() { return { text: "{}", model: "m" } } }'

describe('readConfigFile on a TS or JS config', () => {
  it.each(['quorum.config.mts', 'quorum.config.mjs', 'quorum.config.ts', 'quorum.config.js'])('reads %s, a module whose default export is the config, key included', async (name) => {
    file(name, 'export default { concurrency: 2, providers: { keyed: { preset: "openai", apiKey: "sk-k" } } }\n')
    expect(await readConfigFile(name, { cwd: dir })).toEqual({ config: { concurrency: 2, providers: { keyed: { preset: 'openai', apiKey: 'sk-k' } } }, source: join(dir, name) })
  })

  it('reads a provider object, and one built from a class, into a snapshot that calls each one as it is', async () => {
    file('providers.mts', `class Echo { id = "echo"; model = "m"; async complete() { return { text: this.id, model: "m" } } }\nexport const mine = ${PROVIDER_SOURCE}\nexport const echo = new Echo()\nexport default { providers: { mine, echo }, roles: { research: "mine" } }\n`)
    const providers = (await configOf('providers.mts')).providers as Record<string, Provider>
    expect(Object.isFrozen(providers.mine) && Object.getPrototypeOf(providers.mine) === null).toBe(true)
    expect(providers.mine.model).toBe('m')
    expect(await providers.mine.complete(REQUEST)).toEqual({ text: '{}', model: 'm' })
    expect(await providers.echo.complete(REQUEST)).toEqual({ text: 'echo', model: 'm' })
  })

  it('names a provider object\'s snapshot by its config key, and calls the original with its own this, reading nothing off its function', async () => {
    file('named.mts', NAMED_SOURCE)
    const keyed = ((await configOf('named.mts')).providers as Record<string, Provider>).keyed
    expect(keyed.id).toBe('keyed')
    expect(Object.isFrozen(keyed) && Object.getPrototypeOf(keyed) === null).toBe(true)
    expect(Object.keys(keyed)).toEqual(['id', 'model', 'complete'])
    expect(await keyed.complete(REQUEST)).toEqual({ text: 'own', model: 'm' })
  })

  it('leaves a field set to undefined unset, as a spread of an unset value gives', async () => {
    file('unset.mts', 'export default { providers: { p: { preset: "ollama", model: undefined } } }\n')
    expect(await configOf('unset.mts')).toEqual({ providers: { p: { preset: 'ollama' } } })
  })

  it.each([
    ['no default export', 'export const config = { concurrency: 1 }'],
    ['a function', 'export default () => ({ concurrency: 1 })'],
    ['an array', 'export default [{ concurrency: 1 }]'],
    ['null', 'export default null'],
    ['a class instance', 'export default new Map([["concurrency", 1]])'],
  ])('refuses %s as the default export', async (_name, source) => {
    file('bad.mts', `${source}\n`)
    expect(await issuesOf('bad.mts')).toEqual([{ path: 'bad.mts', message: 'must export an object as its default' }])
  })

  it('refuses a value that is not plain data, and a __proto__ key, as in a data file', async () => {
    file('data.mts', 'export default { profiles: { team: new Date(0) }, providers: { ["__proto__"]: { model: "m" }, p: { maxTokens: 2n ** 64n } } }\n')
    expect(await issuesOf('data.mts')).toEqual([
      { path: 'data.mts: profiles.team', message: 'must be plain data: an object, an array, a string, a finite number, true, false or null' },
      { path: 'data.mts: providers.__proto__', message: 'is not allowed as a key: it can replace the prototype of an object' },
      { path: 'data.mts: providers.p.maxTokens', message: 'must be plain data: an object, an array, a string, a finite number, true, false or null' },
    ])
  })

  it('reports the schema\'s issues at their paths after the file\'s', async () => {
    file('bad.mts', 'export default { version: 2, providers: { p: { preset: "gpt" } } }\n')
    expect(await issuesOf('bad.mts')).toEqual([
      { path: 'bad.mts: version', message: 'must be 1, the only config version this quorum reads: upgrade quorum to read a later one' },
      { path: 'bad.mts: providers.p.preset', message: 'must be one of ollama, ollama-cloud, lmstudio, llamacpp, vllm, openai, azure-openai, openrouter, groq, mistral, deepseek, together, fireworks, xai, anthropic or gemini' },
    ])
  })

  it.each([
    ['an Error', `throw new Error("${SECRET}")`, 'failed to load (Error)'],
    ['a TypeError from its own code', `const key = undefined; key.trim(); export default {}`, 'failed to load (TypeError)'],
    ['a string', `throw "${SECRET}"`, 'failed to load (a value that is not an error)'],
    ['undefined', 'throw undefined', 'failed to load (a value that is not an error)'],
    ['an error named with its text', `const error = new Error("x"); error.name = "${SECRET}"; throw error`, 'failed to load (an error)'],
    ['an object whose name cannot be read', `throw { get name() { throw new Error("${SECRET}") } }`, 'failed to load (an error)'],
    ['a getter of its object', `export default { get concurrency() { throw new RangeError("${SECRET}") } }`, 'failed to load (RangeError)'],
    ['a proxy as its object', `export default new Proxy({}, { getPrototypeOf() { throw new Error("${SECRET}") } })`, 'failed to load (Error)'],
  ])('reports a config that throws %s by its name, never by what it says', async (_name, source, message) => {
    file('throws.mts', `${source}\n`)
    const issues = await issuesOf('throws.mts')
    expect(issues).toEqual([{ path: 'throws.mts', message }])
    expect(JSON.stringify(issues)).not.toContain('planted')
  })

  it('does not print the issues of a ConfigError the config throws while it is read', async () => {
    const errors = pathToFileURL(fileURLToPath(new URL('../core/errors.ts', import.meta.url))).href
    file('throws.mts', `import { ConfigError } from ${JSON.stringify(errors)}\nexport default { get concurrency() { throw new ConfigError([{ path: 'x', message: '${SECRET}' }]) } }\n`)
    const issues = await issuesOf('throws.mts')
    expect(issues).toEqual([{ path: 'throws.mts', message: 'failed to load (ConfigError)' }])
    expect(JSON.stringify(issues)).not.toContain('planted')
  })

  it.each([1, 2, 3, 4, 5, 6])('a provider whose complete getter throws from read %i on never has its message printed', async (reads) => {
    file('getter.mts', `let reads = 0\nconst mine = { get complete() { if (++reads >= ${reads}) throw new Error('${SECRET}'); return async () => ({ text: '{}', model: 'm' }) } }\nexport default { providers: { mine } }\n`)
    const issues = await issuesOf('getter.mts')
    expect([[], [{ path: 'getter.mts', message: 'failed to load (Error)' }]]).toContainEqual(issues)
    expect(JSON.stringify(issues)).not.toContain('planted')
  })
})

describe('readConfigFile on prompt files', () => {
  const team = (research: string, vote = '{file: ./vote.md}'): string => `profiles:\n  team:\n    prompts: {research: ${research}, vote: ${vote}}\n`

  it('reads every prompt file relative to the directory of the config, and keeps an inline prompt', async () => {
    file('conf/prompts/research.md', 'Look for {{nothing}}.\n')
    file('conf/vote.md', `${BOM}Vote from {{lens.id}}.\n`)
    file('conf/quorum.yaml', `${team('{file: ./prompts/research.md}')}  other:\n    prompts: {research: inline text}\n`)
    expect(await configOf('conf/quorum.yaml')).toEqual({
      profiles: { team: { prompts: { research: 'Look for {{nothing}}.\n', vote: 'Vote from {{lens.id}}.\n' } }, other: { prompts: { research: 'inline text' } } },
    })
  })

  it('reads a prompt file at an absolute path as it is', async () => {
    file('elsewhere/research.md', 'absolute')
    file('vote.md', 'vote')
    file('quorum.json', JSON.stringify({ profiles: { team: { prompts: { research: { file: join(dir, 'elsewhere/research.md') }, vote: { file: 'vote.md' } } } } }))
    expect(await configOf('quorum.json')).toEqual({ profiles: { team: { prompts: { research: 'absolute', vote: 'vote' } } } })
  })

  it('reads a prompt file of a code config, and leaves the module\'s own object as it was', async () => {
    file('research.md', 'from a file')
    file('quorum.mts', 'export const prompts = { research: { file: "./research.md" } }\nexport default { profiles: { team: { prompts } } }\n')
    expect(await configOf('quorum.mts')).toEqual({ profiles: { team: { prompts: { research: 'from a file' } } } })
    const module = await import(pathToFileURL(join(dir, 'quorum.mts')).href) as { prompts: unknown }
    expect(module.prompts).toEqual({ research: { file: './research.md' } })
  })

  it('reports every prompt file that cannot be read, each at its path', async () => {
    mkdirSync(join(dir, 'folder.md'))
    file('latin1.md', Uint8Array.from([0xE9]))
    file('full.md', 'x'.repeat(64 * 1024))
    file('over.md', 'x'.repeat(64 * 1024 + 1))
    file('quorum.yaml', `${team('{file: missing.md}', '{file: folder.md}')}  other:\n    prompts: {research: {file: latin1.md}, vote: {file: over.md}}\n  fine:\n    prompts: {research: {file: full.md}}\n`)
    expect(await issuesOf('quorum.yaml')).toEqual([
      { path: 'quorum.yaml: profiles.team.prompts.research.file', message: 'does not exist' },
      { path: 'quorum.yaml: profiles.team.prompts.vote.file', message: 'is not a file' },
      { path: 'quorum.yaml: profiles.other.prompts.research.file', message: 'is not UTF-8 text' },
      { path: 'quorum.yaml: profiles.other.prompts.vote.file', message: 'is over 64 KiB' },
    ])
  })

  it('reads no prompt file while the schema finds an issue', async () => {
    file('quorum.yaml', `${team('{file: missing.md}')}concurrency: 0\n`)
    expect(await issuesOf('quorum.yaml')).toEqual([{ path: 'quorum.yaml: concurrency', message: 'must be at least 1' }])
  })

  /** A JSON config of one profile per file, each profile's research prompt naming its file. */
  const profilesNaming = (files: readonly string[]): string => JSON.stringify({ profiles: Object.fromEntries(files.map((name, index) => [`p${index}`, { prompts: { research: { file: name } } }])) })

  it('reads a prompt file named by several profiles once, with the same text in each', async () => {
    const text = 'x'.repeat(64 * 1024)
    file('shared.md', text)
    file('quorum.json', profilesNaming(Array.from<string>({ length: 32 }).fill('shared.md')))
    const { profiles } = await configOf('quorum.json') as { profiles: Record<string, { prompts: { research: string } }> }
    const texts = Object.values(profiles).map(profile => profile.prompts.research)
    expect(texts).toHaveLength(32)
    expect(new Set(texts)).toEqual(new Set([text]))
  })

  it('refuses prompt files over 1 MiB in total, at the file that takes them over', async () => {
    const names = Array.from({ length: 17 }, (_, index) => file(`prompt${index}.md`, 'x'.repeat(64 * 1024)))
    // A further file that does not exist: reading stops at the 17th, so it is never opened.
    file('quorum.json', profilesNaming([...names, 'missing.md']))
    expect(await issuesOf('quorum.json')).toEqual([{ path: 'quorum.json: profiles.p16.prompts.research.file', message: 'takes the prompt files over 1 MiB in total' }])
  })

  it('counts an oversized prompt file as 64 KiB toward the total', async () => {
    const names = Array.from({ length: 20 }, (_, index) => file(`big${index}.md`, 'x'.repeat(65 * 1024)))
    file('quorum.json', profilesNaming(names))
    expect(await issuesOf('quorum.json')).toEqual([
      ...Array.from({ length: 16 }, (_, index) => ({ path: `quorum.json: profiles.p${index}.prompts.research.file`, message: 'is over 64 KiB' })),
      { path: 'quorum.json: profiles.p16.prompts.research.file', message: 'takes the prompt files over 1 MiB in total' },
    ])
  })
})

describe.skipIf('bun' in process.versions)('readConfigFile under Node itself, which vitest\'s own import does not show', () => {
  const LOAD = pathToFileURL(fileURLToPath(new URL('./load.ts', import.meta.url))).href
  const SCHEMA = fileURLToPath(new URL('./schema.ts', import.meta.url))
  let root: string
  let results: Record<string, unknown>
  let stderr: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'quorum-node-'))
    const write = (name: string, content: string): void => {
      mkdirSync(join(root, name, '..'), { recursive: true })
      writeFileSync(join(root, name), content)
    }
    write('typed.mts', `import type { QuorumConfig } from '${SCHEMA}'\nexport default { concurrency: 2 } satisfies QuorumConfig\n`)
    write('enum.ts', `enum Level { High }\nexport default { concurrency: Level.High, note: '${SECRET}' }\n`)
    write('cjs/package.json', '{"type": "commonjs"}\n')
    write('cjs/quorum.config.ts', `export default { concurrency: 1, note: '${SECRET}' }\n`)
    write('cjs/quorum.config.mts', 'export default { concurrency: 3 }\n')
    write('missing.mts', `import config from './nowhere.ts'\nexport default config\n`)
    write('run.mjs', [
      `import { readConfigFile } from '${LOAD}'`,
      'const results = {}',
      'for (const name of process.argv.slice(2)) {',
      '  results[name] = await readConfigFile(name).then(loaded => loaded.config, error => error.issues ?? error.name)',
      '}',
      'console.log(JSON.stringify(results))',
    ].join('\n'))
    const run = spawnSync(process.execPath, ['run.mjs', 'typed.mts', 'enum.ts', 'cjs/quorum.config.ts', 'cjs/quorum.config.mts', 'missing.mts'], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    results = JSON.parse(run.stdout) as Record<string, unknown>
    stderr = run.stderr
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('loads a .mts config typed with import type and satisfies, and one inside a commonjs package', () => {
    expect(results['typed.mts']).toEqual({ concurrency: 2 })
    expect(results['cjs/quorum.config.mts']).toEqual({ concurrency: 3 })
  })

  it('reports an enum, which Node cannot strip', () => {
    expect(results['enum.ts']).toEqual([{ path: 'enum.ts', message: 'uses TypeScript that Node cannot strip (an enum, a namespace or a parameter property)' }])
  })

  it('reports an export in a .ts config of a commonjs package, and names the extension that works', () => {
    expect(results['cjs/quorum.config.ts']).toEqual([{ path: 'cjs/quorum.config.ts', message: 'has a syntax error (a .ts or .js config with export in a "type": "commonjs" package needs the .mts or .mjs extension)' }])
  })

  it('reports an import that cannot be found', () => {
    expect(results['missing.mts']).toEqual([{ path: 'missing.mts', message: 'imports a module that cannot be found' }])
  })

  it('leaves the text of a config out of what Node itself writes', () => {
    expect(stderr).not.toContain('planted')
  })
})

describe('loadConfig', () => {
  const NO_MODEL = 'no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one'

  it('reads the file configPath names, then layers the environment over it', async () => {
    const name = file('q.yaml', 'providers:\n  local: {preset: ollama, model: q}\n')
    const loaded = await loadConfig({ cwd: dir, env: { QUORUM_RESEARCH_MODEL: 'other' }, configPath: name })
    expect(loaded.config.providers.local).toMatchObject({ preset: 'ollama', model: 'other' })
    expect(loaded.source).toBe(join(dir, name))
    expect(loaded.warnings).toEqual([])
  })

  it('reads the file QUORUM_CONFIG names when no path is given, and a path given wins', async () => {
    const named = join(dir, file('env.yaml', 'providers:\n  fromenv: {preset: ollama, model: q}\n'))
    file('flag.yaml', 'providers:\n  fromflag: {preset: ollama, model: q}\n')
    expect(Object.keys((await loadConfig({ cwd: dir, env: { QUORUM_CONFIG: ` ${named} ` } })).config.providers)).toEqual(['fromenv'])
    expect(Object.keys((await loadConfig({ cwd: dir, env: { QUORUM_CONFIG: named }, configPath: 'flag.yaml' })).config.providers)).toEqual(['fromflag'])
  })

  it.each(['env.yaml', './env.yaml', '../env.yaml', '~/env.yaml'])('refuses a QUORUM_CONFIG that is not an absolute path (%s), a path given or not, and reads nothing', async (relative) => {
    file('env.yaml', 'providers:\n  fromenv: {preset: ollama, model: q}\n')
    file('flag.yaml', 'providers:\n  fromflag: {preset: ollama, model: q}\n')
    const issue = [{ path: 'QUORUM_CONFIG', message: 'must be an absolute path' }]
    await expect(loadConfig({ cwd: dir, env: { QUORUM_CONFIG: relative } })).rejects.toMatchObject({ issues: issue })
    await expect(loadConfig({ cwd: dir, env: { QUORUM_CONFIG: ` ${relative} ` }, configPath: 'flag.yaml' })).rejects.toMatchObject({ issues: issue })
  })

  it('takes a blank QUORUM_CONFIG as unset, and a relative configPath as named per call', async () => {
    file('flag.yaml', 'providers:\n  fromflag: {preset: ollama, model: q}\n')
    await expect(loadConfig({ cwd: dir, env: { QUORUM_CONFIG: '  ' } })).rejects.toThrow(NO_MODEL)
    expect(Object.keys((await loadConfig({ cwd: dir, env: { QUORUM_CONFIG: '' }, configPath: 'flag.yaml' })).config.providers)).toEqual(['fromflag'])
  })

  it('reads no file that is not named, whatever the working directory holds (ADR-0014)', async () => {
    file('quorum.config.yaml', 'providers:\n  planted: {preset: ollama, model: q}\n')
    await expect(loadConfig({ cwd: dir, env: {} })).rejects.toThrow(NO_MODEL)
    const loaded = await loadConfig({ cwd: dir, env: { QUORUM_RESEARCH_MODEL: 'q' } })
    expect(loaded.source).toBeUndefined()
    expect(Object.keys(loaded.config.providers)).toEqual(['default'])
  })

  it('hands a selection to the resolution, over QUORUM_PROFILES', async () => {
    const loaded = await loadConfig({ env: { QUORUM_RESEARCH_MODEL: 'm', QUORUM_PROFILES: 'nope' }, selection: { ids: ['security'], path: '--profile' } })
    expect(loaded.config.profiles.map(({ profile }) => profile.id)).toEqual(['security'])
  })

  it('reports a config that Bun cannot build as a syntax error, never by its message', async () => {
    file('built.mjs', `const error = new Error('${SECRET} in the source')\nerror.name = 'BuildMessage'\nthrow error\n`)
    const issues = await loadConfig({ cwd: dir, env: {}, configPath: 'built.mjs' }).then(() => [], (error: unknown) => (error as ConfigError).issues)
    expect(issues).toEqual([{ path: 'built.mjs', message: 'has a syntax error' }])
  })

  it('returns the config\'s warnings', async () => {
    const loaded = await loadConfig({ cwd: dir, env: { RESEARCH_MODEL: 'q' } })
    expect(loaded.warnings).toEqual(['RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead'])
    expect(loaded.warnings).toBe(loaded.config.warnings)
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('a provider whose complete getter throws from read %i on never has its message printed', async (reads) => {
    file('getter.mts', `let reads = 0\nconst mine = { model: 'm', get complete() { if (++reads >= ${reads}) throw new Error('${SECRET}'); return async () => ({ text: '{}', model: 'm' }) } }\nexport default { providers: { mine } }\n`)
    const issues = await loadConfig({ cwd: dir, env: {}, configPath: 'getter.mts' }).then(() => [], (error: unknown) => {
      expect(error).toBeInstanceOf(ConfigError)
      return (error as ConfigError).issues
    })
    expect([[], [{ path: 'getter.mts', message: 'failed to load (Error)' }]]).toContainEqual(issues)
    expect(JSON.stringify(issues)).not.toContain('planted')
  })

  it('holds a provider object as the snapshot, named by its config key, whose function answers with the object it is called on', async () => {
    file('named.mts', NAMED_SOURCE)
    const keyed = (await loadConfig({ cwd: dir, env: {}, configPath: 'named.mts' })).config.providers.keyed as Provider
    expect([keyed.id, Object.isFrozen(keyed), Object.getPrototypeOf(keyed)]).toEqual(['keyed', true, null])
    expect(await keyed.complete(REQUEST)).toEqual({ text: 'own', model: 'm' })
  })

  /** The source of a config whose provider's complete getter answers until read `reads`, and then changes as `change` says. */
  const changingSource = (change: string, reads: number): string => [
    'let seen = 0',
    'const mine = { model: "m", get complete() {',
    '  seen += 1',
    `  if (seen < ${reads}) return async () => ({ text: "{}", model: "m" })`,
    `  if (${JSON.stringify(change)} === "throws" || (${JSON.stringify(change)} === "becomes undefined, then throws" && seen > ${reads})) throw new Error("SECRET")`,
    '  return undefined',
    '} }',
    'export default { providers: { mine } }',
  ].join('\n')

  /** What loading `name` comes to: its provider answering, or the issues of the ConfigError. Any other error fails the test. */
  async function outcomeOf(name: string): Promise<'answers' | readonly ConfigIssue[]> {
    let provider: Provider
    try {
      provider = (await loadConfig({ cwd: dir, env: {}, configPath: name })).config.providers.mine as Provider
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).message).not.toContain('SECRET')
      return (error as ConfigError).issues
    }
    expect(await provider.complete(REQUEST)).toEqual({ text: '{}', model: 'm' })
    return 'answers'
  }

  it.each(['becomes undefined', 'throws', 'becomes undefined, then throws'].flatMap(change => [1, 2, 3, 4, 5, 6, 7, 8].map(reads => ({ change, reads }))))('a provider whose complete getter changes at read $reads ($change) is never read after the guard', async ({ change, reads }) => {
    file('changing.mts', changingSource(change, reads))
    expect(JSON.stringify(await outcomeOf('changing.mts'))).not.toContain('SECRET')
  })

  it('puts the text of a prompt file in the profile that names it', async () => {
    file('prompts/r.md', 'Find style issues.')
    const name = file('q.yaml', 'providers:\n  local: {preset: ollama, model: q}\nprofiles:\n  team:\n    prompts: {research: {file: ./prompts/r.md}, vote: "Judge {{lens.id}}: {{lens.question}}"}\n    lenses: [{id: one, question: "Real?"}]\n')
    expect((await loadConfig({ cwd: dir, env: {}, configPath: name })).config.profiles[0].profile.prompts.research).toBe('Find style issues.')
  })
})
