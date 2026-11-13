/**
 * Reading a bench suite: a directory holding `suite.yaml` and a `cases/` directory of patches, each
 * patch a diff the bench reviews. A suite is data, never configuration or code, and is read as a config
 * file is read (see `src/config/load.ts`): `suite.yaml` is a regular file of at most 1 MiB, UTF-8, one
 * YAML 1.2 core-schema document with no repeated key, alias or YAML 1.1 tag, plain data at most 64 keys
 * deep and 10 000 values, with no `__proto__` key. Nothing in a suite reaches outside it: `suite.yaml`,
 * `cases/` and every patch must not be a symbolic link.
 *
 * Everything is checked before any call, and no message quotes the file or a patch.
 */

import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { dataIssues, decode, isPlainObject, parseYaml, readBounded } from '../config/load.ts'
import { configPath, parseConfig } from '../config/schema.ts'
import { decodeDiff, firstLineOutside, MAX_DIFF_BYTES, splitDiff } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { hiddenLabels } from '../core/sanitize.ts'

/** A suite name or a case id: a name for a directory and for a record, so it holds no separator and no `..`. */
export const SUITE_ID = /^[a-z0-9][a-z0-9._-]*$/
/** A patch's file name: bare, and not starting with a dot. */
export const PATCH_NAME = /^[A-Z0-9][\w.-]*$/i
/** The most `suite.yaml` may hold, in bytes. */
export const MAX_SUITE_BYTES = 1024 * 1024
export const MAX_CASES = 1000
export const MAX_LOCATIONS = 32
/** The most lines one location may span. */
export const MAX_RANGE_LINES = 500
/** The most characters of a note or of one copyright line. */
export const MAX_TEXT = 500
export const MAX_COPYRIGHT_LINES = 20
export const MAX_TRIALS = 100
export const MAX_WINDOW = 100
/** How many lines either side of a location still count as a catch, when the suite does not say. */
export const DEFAULT_WINDOW = 3
/** The most the patches of a suite may hold together, in bytes: a loaded suite holds them in memory. */
export const MAX_PATCH_TOTAL_BYTES = 64 * 1024 * 1024

const MAX_ID = 64
const MAX_PATCH_NAME = 128
const MAX_FILE = 4096
const MAX_REPO = 200
/** A full commit hash: SHA-1 (40 digits) or SHA-256 (64). */
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** One SPDX license id, not an expression. */
const LICENSE = /^[A-Z0-9][A-Z0-9.+-]{0,63}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
/** What every diff the bench reads starts with. */
const DIFF_START = 'diff --git '

/** A span of lines of the new file that holds a bug, at the file's own path in the patch. */
export interface Location {
  readonly file: string
  readonly start: number
  readonly end: number
}

/** What a case says about where it comes from, whatever its kind. */
interface CaseOrigin {
  readonly id: string
  /** The name of its patch in `cases/`. */
  readonly patch: string
  readonly repo?: string
  readonly license?: string
  readonly copyright?: readonly string[]
  readonly date?: string
  readonly note?: string
}

/** A patch that introduces a vulnerability at its locations. */
export interface BugCase extends CaseOrigin {
  readonly kind: 'bug'
  readonly locations: readonly Location[]
  readonly fixCommit?: string
  readonly introducingCommit?: string
}

/** A patch that introduces none. */
export interface ControlCase extends CaseOrigin {
  readonly kind: 'control'
  readonly commit?: string
}

export type SuiteCase = BugCase | ControlCase

/** A suite once read and checked. */
export interface Suite {
  readonly name: string
  /** How many trials a run takes when it is not told, if the suite says. */
  readonly trials?: number
  /** How many lines either side of a location still count as a catch. */
  readonly window: number
  readonly cases: readonly SuiteCase[]
  /** The decoded text of each patch by name, in the order the cases first name them. */
  readonly patches: ReadonlyMap<string, string>
  /** `sha256:` and the hex SHA-256 of the files' own hashes: `suite.yaml` and each patch a case names. */
  readonly hash: string
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** Whether `text` is a real day written YYYY-MM-DD. */
function isDay(text: string): boolean {
  if (!DAY.test(text)) return false
  const time = Date.parse(`${text}T00:00:00Z`)
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(text)
}

/** Whether `text` is an https:// URL with no credentials, query or fragment. */
function isRepository(text: string): boolean {
  if (text.length > MAX_REPO || /[\s?#]/u.test(text) || hiddenLabels(text).length > 0 || !URL.canParse(text)) return false
  const url = new URL(text)
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}

const idSchema = z.string().max(MAX_ID, { error: `must be at most ${MAX_ID} characters` }).regex(SUITE_ID)
const textSchema = z.string().min(1, { error: 'must not be empty' }).max(MAX_TEXT, { error: `must be at most ${MAX_TEXT} characters` }).refine(text => hiddenLabels(text).length === 0, { error: 'must be one line of visible text' })
const commitSchema = z.string().regex(COMMIT, { error: 'must be a full commit hash: 40 or 64 lowercase hex digits' })

const locationSchema = z.strictObject({
  file: z.string().min(1, { error: 'must not be empty' }).max(MAX_FILE, { error: `must be at most ${MAX_FILE} characters` }),
  start: z.int().min(1),
  end: z.int().min(1),
})
  .refine(({ start, end }) => start <= end, { error: 'must start at or before its end' })
  .refine(({ start, end }) => end - start < MAX_RANGE_LINES, { error: `must span at most ${MAX_RANGE_LINES} lines` })

/** A case of either kind; the rules of each kind are checked after the fields, and 7b adds `attack` to the kinds and its rules there. */
const caseSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['bug', 'control']),
  patch: z.string().max(MAX_PATCH_NAME, { error: `must be at most ${MAX_PATCH_NAME} characters` }).regex(PATCH_NAME, { error: 'must be a bare file name: letters, digits, dots, underscores and dashes, not starting with a dot' }),
  locations: z.array(locationSchema).min(1).max(MAX_LOCATIONS, { error: `must hold at most ${MAX_LOCATIONS} locations` }).optional(),
  repo: z.string().refine(isRepository, { error: 'must be an https:// URL with no credentials, query or fragment' }).optional(),
  fixCommit: commitSchema.optional(),
  introducingCommit: commitSchema.optional(),
  commit: commitSchema.optional(),
  license: z.string().regex(LICENSE, { error: 'must be one SPDX license id, such as MIT or Apache-2.0' }).optional(),
  copyright: z.array(textSchema).min(1).max(MAX_COPYRIGHT_LINES, { error: `must hold at most ${MAX_COPYRIGHT_LINES} lines` }).optional(),
  date: z.string().refine(isDay, { error: 'must be a date written YYYY-MM-DD' }).optional(),
  note: textSchema.optional(),
}).superRefine((entry, context) => {
  const only = (field: 'locations' | 'fixCommit' | 'introducingCommit' | 'commit', kind: string): void => {
    if (entry[field] !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `is only for a ${kind}`,
      })
    }
  }
  if (entry.kind === 'bug') {
    if (entry.locations === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['locations'],
        message: 'is required for a bug',
      })
    }
    only('commit', 'control')
  } else {
    only('locations', 'bug')
    only('fixCommit', 'bug')
    only('introducingCommit', 'bug')
  }
})

const suiteSchema = z.strictObject({
  name: idSchema,
  trials: z.int().min(1).max(MAX_TRIALS).optional(),
  window: z.int().min(0).max(MAX_WINDOW).default(DEFAULT_WINDOW),
  cases: z.array(caseSchema).min(1).max(MAX_CASES, { error: `must hold at most ${MAX_CASES} cases` }),
})

/** A patch that passed: its decoded text, the sections of its files and the hex SHA-256 of its bytes. */
interface Patch {
  readonly text: string
  readonly sections: ReadonlyMap<string, string>
  readonly hash: string
}

/** What reading a patch found: the patch, or the problem with it. */
type PatchRead = Patch | { readonly problem: string }

function fail(path: string, message: string): never {
  throw new ConfigError([
    { path, message },
  ])
}

/** A patch's bytes decoded as the review command decodes a diff, and checked to be a pure diff of at least one file quorum reads. */
async function checkPatch(bytes: Uint8Array): Promise<PatchRead> {
  const text = await decodeDiff([bytes])
  if (text === undefined) return { problem: 'is over 16 MiB' }
  if (!text.startsWith(DIFF_START)) return { problem: 'must be a pure diff that starts at its first diff --git line' }
  const sections = splitDiff(text)
  if (sections.size === 0) return { problem: 'names no file in a diff --git header quorum reads' }
  return {
    text,
    sections,
    hash: sha256(bytes),
  }
}

/** The problem `cases/` has, or undefined when it is a directory and no link. */
async function casesProblem(directory: string): Promise<string | undefined> {
  try {
    const stats = await lstat(join(directory, 'cases'))
    if (stats.isSymbolicLink()) return 'is a symbolic link'
    return stats.isDirectory()
      ? undefined
      : 'is not a directory'
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? 'does not exist'
      : 'cannot be read'
  }
}

/**
 * Read the suite in `directory`: `suite.yaml` and the patches in `cases/` that its cases name. Each
 * patch is read once, as a regular file of at most 16 MiB (all together at most 64 MiB), decoded as
 * the review command decodes a diff, and must start with `diff --git ` and name at least one file;
 * each location of a bug must name a file of its patch by the diff's own path, and each of its lines
 * must sit in a hunk of the patch. A file of `cases/` that no case names is not read. The hash covers
 * `suite.yaml` and each patch a case names, once.
 *
 * `label` stands for the directory in the issues, which name `<label>/suite.yaml` and a path in it, or
 * `<label>/cases`; no issue quotes a file.
 *
 * @throws ConfigError with the first problem of `suite.yaml`, or `cases/`, or every other issue found
 */
export async function loadSuite(directory: string, label = directory): Promise<Suite> {
  const file = `${label}/suite.yaml`
  const bytes = await readBounded(join(directory, 'suite.yaml'), MAX_SUITE_BYTES, '1 MiB', { noFollow: true })
  if ('problem' in bytes) fail(file, bytes.problem)
  const text = decode(bytes.value)
  if ('problem' in text) fail(file, text.problem)
  const parsed = parseYaml(text.value)
  if ('problem' in parsed) fail(file, parsed.problem)
  if (!isPlainObject(parsed.value)) fail(file, 'must hold a mapping')
  const data = dataIssues(parsed.value, file)
  if (data.length > 0) throw new ConfigError(data)
  const header = parseConfig(suiteSchema, parsed.value, file)
  const at = (index: number, ...segments: PropertyKey[]): string => configPath(['cases', index, ...segments], file)

  const issues: ConfigIssue[] = []
  const firstWith = new Map<string, number>()
  for (const [index, { id }] of header.cases.entries()) {
    const first = firstWith.get(id)
    if (first === undefined) {
      firstWith.set(id, index)
    } else {
      issues.push({
        path: at(index, 'id'),
        message: `repeats the id of cases.${first}`,
      })
    }
  }

  const casesIssue = await casesProblem(directory)
  if (casesIssue !== undefined) {
    throw new ConfigError([
      ...issues,
      { path: `${label}/cases`, message: casesIssue },
    ])
  }

  const patches = new Map<string, Patch>()
  const problems = new Map<string, string>()
  let total = 0
  for (const [index, { patch }] of header.cases.entries()) {
    if (!patches.has(patch) && !problems.has(patch)) {
      const patchBytes = await readBounded(join(directory, 'cases', patch), MAX_DIFF_BYTES, '16 MiB', { noFollow: true })
      total += 'problem' in patchBytes
        ? patchBytes.counted ?? 0
        : patchBytes.value.length
      if (total > MAX_PATCH_TOTAL_BYTES) {
        issues.push({
          path: at(index, 'patch'),
          message: 'takes the patches over 64 MiB in total',
        })
        break
      }
      const read = 'problem' in patchBytes
        ? patchBytes
        : await checkPatch(patchBytes.value)
      if ('problem' in read) problems.set(patch, read.problem)
      else patches.set(patch, read)
    }
    const problem = problems.get(patch)
    if (problem !== undefined) {
      issues.push({
        path: at(index, 'patch'),
        message: problem,
      })
    }
  }

  for (const [index, entry] of header.cases.entries()) {
    const read = patches.get(entry.patch)
    if (entry.kind !== 'bug' || read === undefined) continue
    for (const [position, { file: name, start, end }] of (entry.locations ?? []).entries()) {
      if (!read.sections.has(name)) {
        issues.push({
          path: at(index, 'locations', position, 'file'),
          message: 'is not a file of the patch, as its diff --git header names it',
        })
        continue
      }
      const outside = firstLineOutside(read.sections, name, start, end)
      if (outside !== undefined) {
        issues.push({
          path: at(index, 'locations', position),
          message: `line ${outside} is not in a hunk of the patch`,
        })
      }
    }
  }
  if (issues.length > 0) throw new ConfigError(issues)

  const files = [
    [
      'suite.yaml',
      sha256(bytes.value),
    ],
    ...[...patches].sort(([first], [second]) => first < second
      ? -1
      : 1).map(([name, { hash }]) => [`cases/${name}`, hash]),
  ]
  return {
    name: header.name,
    trials: header.trials,
    window: header.window,
    // The kind rules of `caseSchema` make each case a `BugCase` or a `ControlCase`.
    cases: header.cases as SuiteCase[],
    patches: new Map([...patches].map(([name, { text: patchText }]) => [name, patchText])),
    hash: `sha256:${sha256(JSON.stringify(files))}`,
  }
}
