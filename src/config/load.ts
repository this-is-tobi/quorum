import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument } from 'yaml'
import type { Document, YAMLError } from 'yaml'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { checkConfig, configCodeSchema, configFileSchema, configPath, isProvider, parseConfig } from './schema.ts'
import type { QuorumConfig } from './schema.ts'

/** The most a config file may hold: a named FIFO or a huge file never hangs the load or fills memory. */
const CONFIG_LIMIT = 1024 * 1024
/** The most a prompt file may hold. */
const PROMPT_LIMIT = 64 * 1024
/** The most the distinct prompt files of a config may hold together, whatever the number of profiles that name them. */
const PROMPT_TOTAL_LIMIT = 1024 * 1024
/** How many keys deep a value of a config may sit: deeper data could overflow the stack of a walk over it. */
const MAX_DEPTH = 64
/** How many values a config may hold: more would be a walk and a schema check of unbounded work, and issues of unbounded number. */
const MAX_VALUES = 10_000

type Format = 'yaml' | 'json' | 'code'

/** The format of each extension a config may have, read from the map alone, never from an object's prototype. */
const FORMATS: ReadonlyMap<string, Format> = new Map([['.yaml', 'yaml'], ['.yml', 'yaml'], ['.json', 'json'], ['.mts', 'code'], ['.mjs', 'code'], ['.ts', 'code'], ['.js', 'code']])
/** A name a message may give what a config threw: a class name, never text the config could have written a secret into. */
const ERROR_NAME = /^[A-Z][A-Za-z]{0,63}$/
const STAGES = ['research', 'vote'] as const

/** A config file once read and checked. */
export interface LoadedConfig {
  /** The checked config, with the text of every prompt file in place of its `{ file }`. */
  readonly config: QuorumConfig
  /** The absolute path of the file. */
  readonly source: string
}

/** What a read found, or the problem with the file, as an issue words it, and how many bytes the problem counts toward a total. */
type Read<T> = { readonly value: T } | { readonly problem: string, readonly counted?: number }

function fail(path: string, message: string): never {
  throw new ConfigError([{ path, message }])
}

/**
 * The bytes of a regular file of at most `limit` bytes. The file is opened without blocking, so a FIFO
 * is refused instead of waiting for a writer, and at most one byte past the limit is read, however large
 * the file is or grows. The runtime's own message is never kept.
 */
async function readBounded(absolute: string, limit: number, size: string): Promise<Read<Uint8Array>> {
  let handle: FileHandle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return { problem: code === 'ENOENT' || code === 'ENOTDIR' ? 'does not exist' : code === 'EISDIR' ? 'is not a file' : 'cannot be read' }
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return { problem: 'is not a file' }
    const buffer = new Uint8Array(limit + 1)
    let length = 0
    for (let read = -1; read !== 0 && length < buffer.length; length += read) {
      read = (await handle.read(buffer, length, buffer.length - length, length)).bytesRead
    }
    return length > limit ? { problem: `is over ${size}`, counted: limit } : { value: buffer.subarray(0, length) }
  } catch {
    return { problem: 'cannot be read' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** The UTF-8 text of `bytes`, a leading byte-order mark dropped (the decoder's default). */
function decode(bytes: Uint8Array): Read<string> {
  try {
    return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { problem: 'is not UTF-8 text' }
  }
}

/** The UTF-8 text of a regular file of at most `limit` bytes. */
async function readText(absolute: string, limit: number, size: string): Promise<Read<string>> {
  const bytes = await readBounded(absolute, limit, size)
  return 'problem' in bytes ? bytes : decode(bytes.value)
}

/** Where `offset` sits in the text, as a line and a column. */
function position(lines: LineCounter, offset: number): string {
  const { line, col } = lines.linePos(offset)
  return `line ${line}, column ${col}`
}

/** What an error of the yaml package says, by its code and where it points: its message can quote the source, and is never used. */
function yamlProblem(error: YAMLError, lines: LineCounter): string {
  return error.code === 'TAG_RESOLVE_FAILED'
    ? `uses a tag quorum does not read at ${position(lines, error.pos[0])} (TAG_RESOLVE_FAILED)`
    : `is not valid YAML at ${position(lines, error.pos[0])} (${error.code})`
}

/**
 * Where the first key of a document that repeats a key of its own mapping starts, or undefined. The yaml
 * package's `uniqueKeys` compares each key with every earlier key of its mapping, which takes seconds on
 * a mapping of tens of thousands of keys; a set per mapping takes one pass. Every key is a scalar here,
 * compared by its value as the package compares them: `stringKeys` refuses any other key in YAML, and
 * JSON has no other. The walk keeps its own stack, in the order of the package's `visit` (which copies its
 * path at every node, so it takes seconds on a document thousands deep), and enters no node more than
 * `MAX_DEPTH` keys deep: `dataIssues` refuses that data whatever the walk finds there.
 */
function repeatedKeyAt(doc: Document): number | undefined {
  const stack: { node: unknown, depth: number }[] = [{ node: doc.contents, depth: 0 }]
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const { node, depth } = entry
    if (depth > MAX_DEPTH) continue
    if (isPair(node)) {
      stack.push({ node: node.value, depth }, { node: node.key, depth })
    } else if (isMap(node) || isSeq(node)) {
      if (isMap(node)) {
        const seen = new Set<unknown>()
        for (const { key } of node.items) {
          const value = isScalar(key) ? key.value : key
          if (seen.has(value)) return (isScalar(key) ? key.range?.[0] : undefined) ?? 0
          seen.add(value)
        }
      }
      for (let index = node.items.length - 1; index >= 0; index--) stack.push({ node: node.items[index], depth: depth + 1 })
    }
  }
  return undefined
}

/**
 * One YAML 1.2 document of the core schema, as plain data. The schema is given explicitly, since a
 * `%YAML 1.1` directive overrides the version alone (and 1.1 reads `off` as false); the YAML 1.1 tags
 * are not resolved; any error, any warning (an unknown tag is only a warning to the parser), a key that
 * repeats one of its mapping and any alias refuse the file; no problem carries source text.
 */
function parseYaml(text: string): Read<unknown> {
  const lines = new LineCounter()
  try {
    const doc = parseDocument(text, { schema: 'core', version: '1.2', merge: false, resolveKnownTags: false, uniqueKeys: false, stringKeys: true, prettyErrors: false, logLevel: 'error', strict: true, lineCounter: lines })
    const first = doc.errors[0] ?? doc.warnings[0]
    if (first !== undefined) return { problem: yamlProblem(first, lines) }
    const repeated = repeatedKeyAt(doc)
    if (repeated !== undefined) return { problem: `is not valid YAML at ${position(lines, repeated)} (DUPLICATE_KEY)` }
    const value: unknown = doc.toJS({ maxAliasCount: 0 })
    return value === null ? { problem: 'is empty' } : { value }
  } catch (error) {
    // An alias throws a ReferenceError once aliases are disabled; deep nesting can throw a RangeError.
    return { problem: error instanceof ReferenceError ? 'uses an alias, which quorum does not read' : 'is not valid YAML' }
  }
}

/**
 * JSON, refusing a duplicate key, which `JSON.parse` resolves silently to the last value: the same text
 * goes through the yaml package's JSON schema, whose document shows the repeat. `JSON.parse` stays the
 * authority for syntax and values, and its message, which quotes the source, is never used.
 */
function parseJson(text: string): Read<unknown> {
  if (text.trim() === '') return { problem: 'is empty' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { problem: 'is not valid JSON' }
  }
  const lines = new LineCounter()
  try {
    const doc = parseDocument(text, { schema: 'json', uniqueKeys: false, prettyErrors: false, logLevel: 'error', lineCounter: lines })
    const first = doc.errors[0]
    if (first !== undefined) return { problem: `is not valid JSON at ${position(lines, first.pos[0])} (${first.code})` }
    const repeated = repeatedKeyAt(doc)
    return repeated === undefined ? { value } : { problem: `has a duplicate key at ${position(lines, repeated)}` }
  } catch {
    return { problem: 'is not valid JSON' }
  }
}

/** Whether `value` is an object of data: an object whose prototype is `Object.prototype` or none, never a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Every value of a config that is not plain data (an object of data, an array, a string, a finite
 * number, a boolean or null), every own `__proto__` key, and every value more than `MAX_DEPTH` keys
 * deep, each at its path after the file's. A record drops a `__proto__` key silently, and a later merge
 * could turn one into a prototype change: it is refused here, before any schema reads the data.
 * `constructor` and `prototype` stay allowed: they are valid names, and only `__proto__` runs a setter.
 * Only a code config can hand over the rest: a provider object, which is not entered, and `undefined`,
 * which leaves a field unset. Every value the walk visits counts, a provider object too, and past
 * `MAX_VALUES` it stops and the config has that one issue, at the file: the schema never sees more data
 * than that, and an object that refers to itself ends the walk instead of repeating it.
 */
function dataIssues(value: unknown, file: string): ConfigIssue[] {
  const budget = { left: MAX_VALUES }
  const issues = valueIssues(value, [], file, 0, budget)
  return budget.left < 0 ? [{ path: file, message: `holds more than ${MAX_VALUES} values` }] : issues
}

function valueIssues(value: unknown, segments: readonly PropertyKey[], file: string, depth: number, budget: { left: number }): ConfigIssue[] {
  if (--budget.left < 0) return []
  if (depth > MAX_DEPTH) return [{ path: configPath(segments, file), message: `is nested more than ${MAX_DEPTH} keys deep` }]
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return []
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [{ path: configPath(segments, file), message: 'must be a finite number' }]
  if (isProvider(value)) return []
  if (Array.isArray(value)) return value.flatMap((item, index) => valueIssues(item, [...segments, index], file, depth + 1, budget))
  if (!isPlainObject(value)) return [{ path: configPath(segments, file), message: 'must be plain data: an object, an array, a string, a finite number, true, false or null' }]
  return Object.keys(value).flatMap(key => key === '__proto__'
    ? [{ path: configPath([...segments, key], file), message: 'is not allowed as a key: it can replace the prototype of an object' }]
    : valueIssues(value[key], [...segments, key], file, depth + 1, budget))
}

/** The name a message gives what a config threw. Reading it can run the config's code too, so nothing it throws gets out. */
function thrownName(error: unknown): string {
  try {
    if (typeof error !== 'object' || error === null) return 'a value that is not an error'
    const { name } = error as { name?: unknown }
    return typeof name === 'string' && ERROR_NAME.test(name) ? name : 'an error'
  } catch {
    return 'an error'
  }
}

/** What a failed import means, read from what Node says: its code, then the error's name. Its message is never used. */
function importProblem(error: unknown): string {
  let code: unknown
  try {
    code = (error as { code?: unknown } | null)?.code
  } catch {
    code = undefined
  }
  if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') return 'uses TypeScript that Node cannot strip (an enum, a namespace or a parameter property)'
  if (code === 'ERR_UNKNOWN_FILE_EXTENSION') return 'needs Node 22.18 or later to load TypeScript: name it .mjs'
  if (code === 'ERR_MODULE_NOT_FOUND') return 'imports a module that cannot be found'
  const name = thrownName(error)
  if (name === 'SyntaxError') return 'has a syntax error (a .ts or .js config with export in a "type": "commonjs" package needs the .mts or .mjs extension)'
  return `failed to load (${name})`
}

/**
 * A TS or JS config: the plain object its module exports as its default, checked by the code schema. The
 * config is trusted code, but what it throws can hold a secret, so a throw while it loads, or while its
 * object is read (a getter or a proxy runs the config's code, in the data walk and again in the schema's
 * own reads), is reported by its name alone, a `ConfigError` included. Every read of the config's objects
 * is inside the `try`; the issues of the loader itself are built there as values and thrown after it.
 */
async function loadCode(source: string, path: string): Promise<QuorumConfig> {
  let module: { default?: unknown }
  try {
    module = await import(pathToFileURL(source).href) as { default?: unknown }
  } catch (error) {
    fail(path, importProblem(error))
  }
  let checked: { readonly config: QuorumConfig } | { readonly issues: ConfigIssue[] }
  try {
    const value = module.default
    const issues = isPlainObject(value) ? dataIssues(value, path) : [{ path, message: 'must export an object as its default' }]
    checked = issues.length > 0 ? { issues } : checkConfig(configCodeSchema, value, path)
  } catch (error) {
    fail(path, `failed to load (${thrownName(error)})`)
  }
  if ('issues' in checked) throw new ConfigError(checked.issues)
  return checked.config
}

/**
 * A YAML or JSON config: its parsed value, which must be a mapping of plain data, checked by the file
 * schema. A throw from the schema check that is no `ConfigError` is one issue at the file, by its name
 * alone, so the read of a data file only ever throws a `ConfigError`.
 */
function checkData(parsed: Read<unknown>, path: string): QuorumConfig {
  if ('problem' in parsed) fail(path, parsed.problem)
  if (!isPlainObject(parsed.value)) fail(path, 'must hold a mapping of settings')
  const issues = dataIssues(parsed.value, path)
  if (issues.length > 0) throw new ConfigError(issues)
  try {
    return parseConfig(configFileSchema, parsed.value, path)
  } catch (error) {
    if (error instanceof ConfigError) throw error
    fail(path, `could not be checked (${thrownName(error)})`)
  }
}

/**
 * Put the text of every prompt file in place of its `{ file }`, read relative to `directory` (an absolute
 * path stays absolute) as UTF-8 text of at most 64 KiB. Each distinct path is read once, so a file named
 * by many profiles costs once and every place holds the same text, and the distinct files may hold 1 MiB
 * in all, counted in bytes as read, an oversized file as 64 KiB: the file that takes the total over it is
 * an issue, and reading stops there. `config` is the schema's output, a copy, so the caller's own
 * objects are never changed.
 *
 * @throws ConfigError with the problem of every prompt file that cannot be read, at its path, or with
 * those found so far and the file that takes the prompt files over 1 MiB in total
 */
async function readPromptFiles(config: QuorumConfig, directory: string, path: string): Promise<QuorumConfig> {
  const issues: ConfigIssue[] = []
  const reads = new Map<string, Read<string>>()
  let total = 0
  for (const [id, { prompts }] of Object.entries(config.profiles ?? {})) {
    if (prompts === undefined) continue
    for (const stage of STAGES) {
      const prompt = prompts[stage]
      if (typeof prompt !== 'object') continue
      const at = configPath(['profiles', id, 'prompts', stage, 'file'], path)
      const absolute = resolve(directory, prompt.file)
      let text = reads.get(absolute)
      if (text === undefined) {
        const bytes = await readBounded(absolute, PROMPT_LIMIT, '64 KiB')
        total += 'problem' in bytes ? bytes.counted ?? 0 : bytes.value.length
        if (total > PROMPT_TOTAL_LIMIT) throw new ConfigError([...issues, { path: at, message: 'takes the prompt files over 1 MiB in total' }])
        text = 'problem' in bytes ? bytes : decode(bytes.value)
        reads.set(absolute, text)
      }
      if ('problem' in text) issues.push({ path: at, message: text.problem })
      else prompts[stage] = text.value
    }
  }
  if (issues.length > 0) throw new ConfigError(issues)
  return config
}

/**
 * Read one named config file into a checked config. The path resolves against `options.cwd` (the
 * working directory by default), and the extension chooses the format: `.yaml` or `.yml` for YAML and
 * `.json` for JSON, both data only, and `.mts`, `.mjs`, `.ts` or `.js` for a module whose default export
 * is the config, which runs as code. The file must be a regular file of at most 1 MiB, in UTF-8. A data
 * file's value must be a mapping of plain data, a module's default a plain object; neither may hold a
 * `__proto__` key; then the schema of its variant checks it, and every prompt file it names is read, once
 * however many profiles name it: each of at most 64 KiB, and the distinct files 1 MiB in all. Issues name
 * the path as the caller gave it, and never quote a file, repeat the runtime's message or repeat what a
 * config threw.
 *
 * @throws ConfigError with the first problem of the file, or every problem of its data, or every issue of the schema, or of its prompt files
 */
export async function readConfigFile(path: string, options: { readonly cwd?: string } = {}): Promise<LoadedConfig> {
  const source = resolve(options.cwd ?? process.cwd(), path)
  const format = FORMATS.get(extname(source))
  if (format === undefined) fail(path, 'must end in .yaml, .yml, .json, .mts, .mjs, .ts or .js')
  const text = await readText(source, CONFIG_LIMIT, '1 MiB')
  if ('problem' in text) fail(path, text.problem)
  const config = format === 'code' ? await loadCode(source, path) : checkData(format === 'yaml' ? parseYaml(text.value) : parseJson(text.value), path)
  return { config: await readPromptFiles(config, dirname(source), path), source }
}
