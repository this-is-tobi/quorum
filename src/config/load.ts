import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { isScalar, LineCounter, parseDocument, visit } from 'yaml'
import type { Document, YAMLError } from 'yaml'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { configFileSchema, configPath, parseConfig } from './schema.ts'
import type { QuorumConfig } from './schema.ts'

/** The most a config file may hold: a named FIFO or a huge file never hangs the load or fills memory. */
const CONFIG_LIMIT = 1024 * 1024
/** How many keys deep a value of a config may sit: deeper data could overflow the stack of a walk over it. */
const MAX_DEPTH = 64

type Format = 'yaml' | 'json'

/** The format of each extension a config may have, read from the map alone, never from an object's prototype. */
const FORMATS: ReadonlyMap<string, Format> = new Map([['.yaml', 'yaml'], ['.yml', 'yaml'], ['.json', 'json']])

/** A config file once read and checked. */
export interface LoadedConfig {
  readonly config: QuorumConfig
  /** The absolute path of the file. */
  readonly source: string
}

/** What a read found, or the problem with the file, as an issue words it. */
type Read<T> = { readonly value: T } | { readonly problem: string }

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
    return length > limit ? { problem: `is over ${size}` } : { value: buffer.subarray(0, length) }
  } catch {
    return { problem: 'cannot be read' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** UTF-8 text, a leading byte-order mark dropped (the decoder's default), or undefined for bytes that are not UTF-8. */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
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
 * JSON has no other.
 */
function repeatedKeyAt(doc: Document): number | undefined {
  let offset: number | undefined
  visit(doc, {
    Map(_, map) {
      const seen = new Set<unknown>()
      for (const { key } of map.items) {
        const value = isScalar(key) ? key.value : key
        if (seen.has(value)) {
          offset = (isScalar(key) ? key.range?.[0] : undefined) ?? 0
          return visit.BREAK
        }
        seen.add(value)
      }
      return undefined
    },
  })
  return offset
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
 * Every value of a parsed config that is not plain data (an object of data, an array, a string, a finite
 * number, a boolean or null), every own `__proto__` key, and every value more than `MAX_DEPTH` keys
 * deep, each at its path after the file's. A record drops a `__proto__` key silently, and a later merge
 * could turn one into a prototype change: it is refused here, before any schema reads the data.
 * `constructor` and `prototype` stay allowed: they are valid names, and only `__proto__` runs a setter.
 */
function dataIssues(value: unknown, segments: readonly PropertyKey[], file: string, depth = 0): ConfigIssue[] {
  if (depth > MAX_DEPTH) return [{ path: configPath(segments, file), message: `is nested more than ${MAX_DEPTH} keys deep` }]
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return []
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [{ path: configPath(segments, file), message: 'must be a finite number' }]
  if (Array.isArray(value)) return value.flatMap((item, index) => dataIssues(item, [...segments, index], file, depth + 1))
  if (!isPlainObject(value)) return [{ path: configPath(segments, file), message: 'must be plain data: an object, an array, a string, a finite number, true, false or null' }]
  return Object.keys(value).flatMap(key => key === '__proto__'
    ? [{ path: configPath([...segments, key], file), message: 'is not allowed as a key: it can replace the prototype of an object' }]
    : dataIssues(value[key], [...segments, key], file, depth + 1))
}

/**
 * Read one named config file into a checked config. The path resolves against `options.cwd` (the
 * working directory by default), and the extension chooses the format: `.yaml` or `.yml` for YAML, `.json`
 * for JSON, both data only. The file must be a regular file of at most 1 MiB, in UTF-8; its value must be
 * a mapping of plain data, with no `__proto__` key; then the file schema checks it. Issues name the path
 * as the caller gave it, and never quote the file or repeat the runtime's message.
 *
 * @throws ConfigError with the first problem of the file, or every problem of its data, or every issue of the schema
 */
export async function readConfigFile(path: string, options: { readonly cwd?: string } = {}): Promise<LoadedConfig> {
  const source = resolve(options.cwd ?? process.cwd(), path)
  const format = FORMATS.get(extname(source))
  if (format === undefined) fail(path, 'must end in .yaml, .yml or .json')
  const bytes = await readBounded(source, CONFIG_LIMIT, '1 MiB')
  if ('problem' in bytes) fail(path, bytes.problem)
  const text = utf8(bytes.value)
  if (text === undefined) fail(path, 'is not UTF-8 text')
  const parsed = format === 'yaml' ? parseYaml(text) : parseJson(text)
  if ('problem' in parsed) fail(path, parsed.problem)
  if (!isPlainObject(parsed.value)) fail(path, 'must hold a mapping of settings')
  const issues = dataIssues(parsed.value, [], path)
  if (issues.length > 0) throw new ConfigError(issues)
  return { config: parseConfig(configFileSchema, parsed.value, path), source }
}
