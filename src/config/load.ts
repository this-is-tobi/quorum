import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { z } from 'zod'
import { DOCUMENT_READ_LIMIT } from '../core/documents.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { envValue } from './env.ts'
import type { Env } from './env.ts'
import { decode, MAX_DEPTH, parseJson, parseYaml, RULES_EXTENSION, rulesFormat } from './parse.ts'
import type { Read } from './parse.ts'
import type { FailOnOverride, ProfileSelection } from './profiles.ts'
import { resolveConfig } from './resolve.ts'
import type { ResolvedConfig } from './resolve.ts'
import { checkConfig, configCodeSchema, configFileSchema, configPath, isProvider, nameSnapshot, parseConfig } from './schema.ts'
import type { ConfigInput, QuorumConfig } from './schema.ts'

/** The most a config file may hold: a named FIFO or a huge file never hangs the load or fills memory. */
const CONFIG_LIMIT = 1024 * 1024
/** The most the distinct prompt and document files of a config may hold together, whatever the number of profiles and entries that name them. */
const NAMED_FILES_TOTAL_LIMIT = 1024 * 1024
/** How many values a config may hold: more would be a walk and a schema check of unbounded work, and issues of unbounded number. */
const MAX_VALUES = 10_000

type Format = 'yaml' | 'json' | 'code'

/** The format of each extension a config may have, read from the map alone, never from an object's prototype. */
const FORMATS: ReadonlyMap<string, Format> = new Map([
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.json', 'json'],
  ['.mts', 'code'],
  ['.mjs', 'code'],
  ['.ts', 'code'],
  ['.js', 'code'],
])
/** A name a message may give what a config threw: a class name, never text the config could have written a secret into. */
const ERROR_NAME = /^[A-Z][A-Za-z]{0,63}$/
const STAGES = ['research', 'vote'] as const
/** The fields of a profile that list prose documents, each entry a `{ file }` in a file or a code config and a `{ text }` once read. The `rules` list is read apart: its file entries become `{ text, format }`. */
const DOCUMENT_FIELDS = ['guidelines', 'doNotReport'] as const
/** An error code worth printing: `EACCES`, never text. */
const ERROR_CODE = /^E[A-Z]+$/
/** A new file, which `O_EXCL` never makes through a link. */
const NEW_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL

/** A prompt or document file a config named and `readConfigFile` read: where the config names it, and the absolute path it was read from. */
export interface NamedFile {
  /** The config path of its `{ file }`, such as `profiles.security.guidelines.0.file`. */
  readonly at: string
  /** Its path as resolved: relative to the config file's directory, or absolute as given. */
  readonly path: string
}

/** A config file once read and checked. */
export interface LoadedConfig {
  /** The checked config, with the text of every prompt file in place of its `{ file }`, of every document file as a `{ text }` and of every rules file as a `{ text, format }`. */
  readonly config: ConfigInput
  /** The absolute path of the file. */
  readonly source: string
  /** The prompt, document and rules files it read, each distinct path once, at the config path of the entry that first named it, in the order read. */
  readonly files: readonly NamedFile[]
}

// The readers moved to `parse.ts`, which the profile resolution and `readContext` share; the modules that read through them import them here.
export { decode, parseYaml }
export type { Read }

function fail(path: string, message: string): never {
  throw new ConfigError([
    { path, message },
  ])
}

/** What an open that failed means, by its code: the runtime's own message is never kept. */
function openProblem(error: unknown, noFollow: boolean): string {
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'does not exist'
  if (code === 'EISDIR') return 'is not a file'
  return code === 'ELOOP' && noFollow
    ? 'is a symbolic link'
    : 'cannot be read'
}

/** The `lstat` of a path, or the problem a failed one means by its code: the path is missing, or it cannot be read. */
export async function lstatOf(absolute: string): Promise<Read<Stats>> {
  try {
    return { value: await lstat(absolute) }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return {
      problem: code === 'ENOENT' || code === 'ENOTDIR'
        ? 'does not exist'
        : 'cannot be read',
    }
  }
}

/** The problem a path has before an open that must not follow a link: it is one, or it is missing or unreadable; undefined when it is not a link. */
async function linkProblem(absolute: string): Promise<string | undefined> {
  const stats = await lstatOf(absolute)
  if ('problem' in stats) return stats.problem
  return stats.value.isSymbolicLink()
    ? 'is a symbolic link'
    : undefined
}

/**
 * The bytes of a regular file of at most `limit` bytes. The file is opened without blocking, so a FIFO
 * is refused instead of waiting for a writer, and at most one byte past the limit is read, however large
 * the file is or grows. The runtime's own message is never kept. A symbolic link is followed, unless
 * `options.noFollow` is set: then a link is `is a symbolic link`, refused by an `lstat` before the open,
 * and the open itself refuses one with `O_NOFOLLOW` where the platform has it, which closes the race
 * between the two on Linux and macOS (without it, on Windows, a link swapped in after the `lstat` is
 * followed).
 */
export async function readBounded(absolute: string, limit: number, size: string, options: { readonly noFollow?: boolean } = {}): Promise<Read<Uint8Array>> {
  const noFollow = options.noFollow === true
  if (noFollow) {
    const linked = await linkProblem(absolute)
    if (linked !== undefined) return { problem: linked }
  }
  const flags = noFollow && typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    : constants.O_RDONLY | constants.O_NONBLOCK
  let handle: FileHandle
  try {
    handle = await open(absolute, flags)
  } catch (error) {
    return {
      problem: openProblem(error, noFollow),
    }
  }
  return readHandle(handle, limit, size)
}

/**
 * The bytes of the file `handle` holds, a regular file of at most `limit` bytes: `is not a file` unless its
 * `stat` says one, and at most one byte past the limit read, however large the file is or grows (`is over
 * <size>`, counting `limit`). The runtime's own message is never kept. It closes the handle, whatever the
 * outcome, so the caller keeps none.
 */
export async function readHandle(handle: FileHandle, limit: number, size: string): Promise<Read<Uint8Array>> {
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return { problem: 'is not a file' }
    const buffer = new Uint8Array(limit + 1)
    let length = 0
    for (let read = -1; read !== 0 && length < buffer.length; length += read) {
      read = (await handle.read(buffer, length, buffer.length - length, length)).bytesRead
    }
    return length > limit
      ? { problem: `is over ${size}`, counted: limit }
      : {
          value: buffer.subarray(0, length),
        }
  } catch {
    return { problem: 'cannot be read' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** The UTF-8 text of a regular file of at most `limit` bytes. */
async function readText(absolute: string, limit: number, size: string): Promise<Read<string>> {
  const bytes = await readBounded(absolute, limit, size)
  return 'problem' in bytes
    ? bytes
    : decode(bytes.value)
}

/** Whether `value` is an object of data: an object whose prototype is `Object.prototype` or none, never a class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
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
export function dataIssues(value: unknown, file: string | undefined): ConfigIssue[] {
  const budget = { left: MAX_VALUES }
  const issues = valueIssues(value, [], file, 0, budget)
  return budget.left < 0
    ? [
        { path: file ?? 'config', message: `holds more than ${MAX_VALUES} values` },
      ]
    : issues
}

function valueIssues(value: unknown, segments: readonly PropertyKey[], file: string | undefined, depth: number, budget: { left: number }): ConfigIssue[] {
  if (--budget.left < 0) return []
  if (depth > MAX_DEPTH) {
    return [
      {
        path: configPath(segments, file),
        message: `is nested more than ${MAX_DEPTH} keys deep`,
      },
    ]
  }
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return []
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? []
      : [
          {
            path: configPath(segments, file),
            message: 'must be a finite number',
          },
        ]
  }
  if (isProvider(value)) return []
  if (Array.isArray(value)) return value.flatMap((item, index) => valueIssues(item, [...segments, index], file, depth + 1, budget))
  if (!isPlainObject(value)) {
    return [
      {
        path: configPath(segments, file),
        message: 'must be plain data: an object, an array, a string, a finite number, true, false or null',
      },
    ]
  }
  return Object.keys(value).flatMap(key => key === '__proto__'
    ? [
        {
          path: configPath([...segments, key], file),
          message: 'is not allowed as a key: it can replace the prototype of an object',
        },
      ]
    : valueIssues(value[key], [...segments, key], file, depth + 1, budget))
}

/** The name a message gives what a config threw. Reading it can run the config's code too, so nothing it throws gets out. */
function thrownName(error: unknown): string {
  try {
    if (typeof error !== 'object' || error === null) return 'a value that is not an error'
    const { name } = error as { name?: unknown }
    return typeof name === 'string' && ERROR_NAME.test(name)
      ? name
      : 'an error'
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
  // Bun reports a syntax error in a TS or JS config as a `BuildMessage`, and its message quotes the source.
  if (name === 'BuildMessage') return 'has a syntax error'
  if (name === 'SyntaxError') return 'has a syntax error (a .ts or .js config with export in a "type": "commonjs" package needs the .mts or .mjs extension)'
  return `failed to load (${name})`
}

/** A checked config with each provider snapshot named by its config key, the rest as the schema returned it. Only the snapshots' own data is read. */
function nameProviders<T>(config: T): T {
  if (typeof config !== 'object' || config === null || !Object.hasOwn(config, 'providers')) return config
  const providers = (config as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null) return config
  return {
    ...config,
    providers: Object.fromEntries(Object.entries(providers).map(([name, entry]) => [
      name,
      nameSnapshot(name, entry),
    ])),
  }
}

/**
 * The plain object a config's code hands over, checked by `schema`: `read` returns it, then it must be a
 * plain object, hold plain data, and pass the schema, which reads each provider object it holds once into
 * a snapshot, named by its config key. The config is trusted code, but what it throws can hold a secret, so
 * a throw while it is read (a getter or a proxy runs the config's code, in the data walk and in the schema's
 * own reads, the snapshots included) is one issue by the error's name alone, a `ConfigError` included, at
 * `words.file`, else at `config`. Every read of the config's objects is inside the `try`, and nothing after
 * it reads one again, since the config then holds only snapshots; the issues of the check itself are built
 * there as values and thrown after it.
 *
 * @throws ConfigError with the issue of a throw, or every issue of the data and the schema
 */
export function checkCodeValue<T>(schema: z.ZodType<T>, read: () => unknown, words: { readonly file?: string, readonly notAnObject: string, readonly threw: string }): T {
  const at = words.file ?? 'config'
  let checked: { readonly config: T } | { readonly issues: ConfigIssue[] }
  try {
    const value = read()
    const issues = isPlainObject(value)
      ? dataIssues(value, words.file)
      : [
          { path: at, message: words.notAnObject },
        ]
    const result = issues.length > 0
      ? { issues }
      : checkConfig(schema, value, words.file)
    checked = 'issues' in result
      ? result
      : {
          config: nameProviders(result.config),
        }
  } catch (error) {
    fail(at, `${words.threw} (${thrownName(error)})`)
  }
  if ('issues' in checked) throw new ConfigError(checked.issues)
  return checked.config
}

/** A TS or JS config: the plain object its module exports as its default, checked by the code schema. */
async function loadCode(source: string, path: string): Promise<QuorumConfig> {
  let module: { default?: unknown }
  try {
    module = await import(pathToFileURL(source).href) as { default?: unknown }
  } catch (error) {
    fail(path, importProblem(error))
  }
  return checkCodeValue(configCodeSchema, () => module.default, { file: path, notAnObject: 'must export an object as its default', threw: 'failed to load' })
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

/** A file a profile names, where its issue goes, and how its text takes the place of the name. */
interface FileEntry {
  readonly segments: readonly PropertyKey[]
  readonly file: string
  /** What is wrong with the name itself, found before the file is read: a rules file whose extension names no format. */
  readonly problem?: string
  readonly put: (text: string) => void
}

/** The files a profile names, in the order they are read: its prompts, then its guidelines, then its do-not-report documents, then its rules files, each as the entry holds them. */
function fileEntries(id: string, profile: NonNullable<QuorumConfig['profiles']>[string]): FileEntry[] {
  const named: FileEntry[] = []
  // A profile with no prompts names no prompt file, so nothing is ever put into this empty object.
  const prompts = profile.prompts ?? {}
  for (const stage of STAGES) {
    const prompt = prompts[stage]
    if (typeof prompt !== 'object') continue
    named.push({
      segments: [
        'profiles',
        id,
        'prompts',
        stage,
        'file',
      ],
      file: prompt.file,
      put: (text) => {
        prompts[stage] = text
      },
    })
  }
  for (const field of DOCUMENT_FIELDS) {
    // The entries are `{ file }` as the schema checked them; each is replaced by the `{ text }` of the input form.
    const entries = profile[field] as Array<{ file: string } | { text: string }> | undefined
    entries?.forEach((entry, index) => {
      if (!('file' in entry)) return
      named.push({
        segments: ['profiles', id, field, index, 'file'],
        file: entry.file,
        put: (text) => {
          entries[index] = { text }
        },
      })
    })
  }
  // An entry of `rules` is an inline rule, a `{ repository }` or a `{ file }`, and only the last names a file here: it is read as a
  // document is, and its text takes its place with the format its extension names, which no other extension has.
  const rules = profile.rules as Array<Record<string, unknown>> | undefined
  rules?.forEach((entry, index) => {
    if (!('file' in entry)) return
    const file = entry.file as string
    const format = rulesFormat(file)
    named.push({
      segments: ['profiles', id, 'rules', index, 'file'],
      file,
      ...format === undefined
        ? { problem: RULES_EXTENSION }
        : {},
      put: (text) => {
        rules[index] = { text, format }
      },
    })
  })
  return named
}

/**
 * Put the text of every prompt file in place of its `{ file }`, and the text of every guidelines and
 * do-not-report file as the `{ text }` of its entry, and that of every rules file with the format its extension names
 * (`.yaml` and `.yml` YAML, `.json` JSON, another extension an issue at its file path, and the file is not read) as
 * `{ text, format }`, each read relative to `directory` (an absolute path stays
 * absolute) as UTF-8 text of at most 64 KiB. Each distinct path is read once, so a file named by many
 * profiles or entries costs once and every place holds the same text, and the distinct files may hold 1 MiB
 * in all, counted in bytes as read, an oversized file as 64 KiB: the file that takes the total over it is
 * an issue, and reading stops there. A document is neither cleaned nor capped here: that is the profile's
 * resolution. `config` is the schema's output, a copy, so the caller's own objects are never changed. The
 * files read come back with the config, each distinct path once, at the config path of the entry that named
 * it first, as `NamedFile` says.
 *
 * @throws ConfigError with the problem of every file that cannot be read, at its path, or with
 * those found so far and the file that takes the files over 1 MiB in total
 */
async function readNamedFiles(config: QuorumConfig, directory: string, path: string): Promise<{ readonly config: ConfigInput, readonly files: readonly NamedFile[] }> {
  const issues: ConfigIssue[] = []
  const reads = new Map<string, Read<string>>()
  const files: NamedFile[] = []
  let total = 0
  for (const [id, profile] of Object.entries(config.profiles ?? {})) {
    for (const { segments, file, problem, put } of fileEntries(id, profile)) {
      const at = configPath(segments, path)
      if (problem !== undefined) {
        issues.push({ path: at, message: problem })
        continue
      }
      const absolute = resolve(directory, file)
      let text = reads.get(absolute)
      if (text === undefined) {
        files.push({
          at: configPath(segments),
          path: absolute,
        })
        const bytes = await readBounded(absolute, DOCUMENT_READ_LIMIT, '64 KiB')
        total += 'problem' in bytes
          ? bytes.counted ?? 0
          : bytes.value.length
        if (total > NAMED_FILES_TOTAL_LIMIT) {
          throw new ConfigError([
            ...issues,
            { path: at, message: 'takes the prompt and document files over 1 MiB in total' },
          ])
        }
        text = 'problem' in bytes
          ? bytes
          : decode(bytes.value)
        reads.set(absolute, text)
      }
      if ('problem' in text) issues.push({ path: at, message: text.problem })
      else put(text.value)
    }
  }
  if (issues.length > 0) throw new ConfigError(issues)
  // The loop above replaced every `{ file }` in the profiles, the only place one can be.
  return { config: config as ConfigInput, files }
}

/**
 * Read one named config file into a checked config. The path resolves against `options.cwd` (the
 * working directory by default), and the extension chooses the format: `.yaml` or `.yml` for YAML and
 * `.json` for JSON, both data only, and `.mts`, `.mjs`, `.ts` or `.js` for a module whose default export
 * is the config, which runs as code. The file must be a regular file of at most 1 MiB, in UTF-8. A data
 * file's value must be a mapping of plain data, a module's default a plain object; neither may hold a
 * `__proto__` key; then the schema of its variant checks it, and every prompt file and every guidelines, do-not-report and
 * rules file it names is read, once however many profiles and entries name it: each of at most 64 KiB, and the distinct files 1 MiB in all. Issues name
 * the path as the caller gave it, and never quote a file, repeat the runtime's message or repeat what a
 * config threw.
 *
 * @throws ConfigError with the first problem of the file, or every problem of its data, or every issue of the schema, or of its prompt and document files
 */
export async function readConfigFile(path: string, options: { readonly cwd?: string } = {}): Promise<LoadedConfig> {
  const source = resolve(options.cwd ?? process.cwd(), path)
  const format = FORMATS.get(extname(source))
  if (format === undefined) fail(path, 'must end in .yaml, .yml, .json, .mts, .mjs, .ts or .js')
  const text = await readText(source, CONFIG_LIMIT, '1 MiB')
  if ('problem' in text) fail(path, text.problem)
  const config = format === 'code'
    ? await loadCode(source, path)
    : checkData(format === 'yaml'
        ? parseYaml(text.value)
        : parseJson(text.value), path)
  return {
    ...await readNamedFiles(config, dirname(source), path),
    source,
  }
}

/**
 * The config file a run names, read and checked but not resolved: the file `options.configPath` names, else the
 * one `QUORUM_CONFIG` names, read as `readConfigFile` reads it, or none (`{ input: {}, source: undefined }`).
 * No file is ever searched for, whatever the working directory holds: a checkout can plant one, so a file
 * loads only when it is named (ADR-0014). `QUORUM_CONFIG` must be an absolute path, a path given or not: set
 * once, a relative one would resolve inside whatever checkout quorum runs in and load that checkout's file,
 * which is the search ADR-0014 forbids. `options.configPath` is named per call, so it may be relative.
 * `options.env` defaults to `process.env`. The input holds the file's data and its prompt files' text, and no
 * key: the caller resolves it, as often as it needs, with `resolveConfig`. `files` are the prompt and document
 * files it read, as `readConfigFile` returns them, none without a file.
 *
 * @throws ConfigError with every problem of the file, or the one issue of a `QUORUM_CONFIG` that is not absolute
 */
export async function readNamedConfig(options: { readonly cwd?: string, readonly env?: Env, readonly configPath?: string } = {}): Promise<{ readonly input: ConfigInput, readonly source: string | undefined, readonly files: readonly NamedFile[] }> {
  const env = options.env ?? process.env
  const named = envValue(env, 'QUORUM_CONFIG')
  if (named !== undefined && !isAbsolute(named)) fail('QUORUM_CONFIG', 'must be an absolute path')
  const path = options.configPath ?? named
  const loaded = path === undefined
    ? undefined
    : await readConfigFile(path, { cwd: options.cwd })
  return { input: loaded?.config ?? {}, source: loaded?.source, files: loaded?.files ?? [] }
}

/**
 * Load the config a run uses: the file `readNamedConfig` reads, and then the layers of the environment over
 * it, resolved as `resolveConfig` resolves them. `options.env` defaults to `process.env`. `options.selection`
 * names the profiles that run, over `QUORUM_PROFILES`, as `resolveConfig` reads it, and `options.failOn`
 * sets the fail-on level of the profiles that run, over the config's, as `resolveConfig` applies it (the levels
 * `parseFailOn` read from the command line). The resolved config holds the keys it read: never print or log one.
 *
 * @returns the resolved config, the absolute path of the file it came from (none without a file) and its warnings
 * @throws ConfigError with every problem of the file or of the resolution, or the one issue of a `QUORUM_CONFIG` that is not absolute
 */
export async function loadConfig(options: { readonly cwd?: string, readonly env?: Env, readonly configPath?: string, readonly selection?: ProfileSelection, readonly failOn?: FailOnOverride } = {}): Promise<{ readonly config: ResolvedConfig, readonly source: string | undefined, readonly warnings: readonly string[] }> {
  const env = options.env ?? process.env
  const { input, source } = await readNamedConfig({ cwd: options.cwd, env, configPath: options.configPath })
  const config = resolveConfig(input, { env, selection: options.selection, failOn: options.failOn })
  return { config, source, warnings: config.warnings }
}

/** The code of a failed system call, when it is one worth printing. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && ERROR_CODE.test(code)
    ? code
    : undefined
}

/** ` (EACCES)`, or nothing for an error without a code worth printing. */
export function codeSuffix(error: unknown): string {
  const code = errorCode(error)
  return code === undefined
    ? ''
    : ` (${code})`
}

/**
 * A file quorum writes that could not be written. Its message is `<file>: cannot be written (<code>)`: it names
 * the file's label and the error's code, never a path, so a log a stranger may read can hold it.
 */
export class WriteFailure extends Error {}

/** The `WriteFailure` of the file `file` for `error`, worded with its code alone. */
export function writeFailure(file: string, error: unknown): WriteFailure {
  return new WriteFailure(`${file}: cannot be written${codeSuffix(error)}`)
}

/**
 * Write `text` as `name` in `directory` whole or not at all: to a new file `.<name>.<8 hex digits>.tmp`
 * made with `O_EXCL` (which never follows a link), written, synced and closed, then renamed over `name`.
 * The rename replaces a symbolic link at `name`, and never writes through it. The temporary file is made
 * with `options.mode`, which the rename keeps: Node's own default unless a caller asks for another. A
 * failure removes the temporary file it made, and names `options.label` in place of `name` when the caller
 * has one, so a message can say what was being written without the path it was written to. The digits are
 * drawn with the global `crypto`, so this layer imports no module for them.
 *
 * @throws WriteFailure `<label or name>: cannot be written (<code>)`
 */
export async function writeAtomic(directory: string, name: string, text: string, options: { readonly mode?: number, readonly label?: string } = {}): Promise<void> {
  const { mode = 0o666, label = name } = options
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(4)), byte => byte.toString(16).padStart(2, '0')).join('')
  const temporary = join(directory, `.${name}.${digits}.tmp`)
  let made = false
  try {
    const handle = await open(temporary, NEW_FILE_FLAGS, mode)
    made = true
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, join(directory, name))
  } catch (error) {
    if (made) await unlink(temporary).catch(() => undefined)
    throw writeFailure(label, error)
  }
}
