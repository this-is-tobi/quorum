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
import { join } from 'node:path'
import { z } from 'zod'
import { dataIssues, decode, isPlainObject, lstatOf, parseYaml, readBounded } from '../config/load.ts'
import { configPath, parseConfig } from '../config/schema.ts'
import { decodeDiff, firstLineOutside, MAX_DIFF_BYTES, splitDiff } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { hiddenLabels } from '../core/sanitize.ts'

/** A suite name or a case id: a name for a directory and for a record, so it is never `.` or `..`, and holds no separator. */
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

/** The most characters of a suite name or a case id. */
export const MAX_ID = 64
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

/** What an attack case tries to do to the review of its twin, in the security model's order. */
export const GOALS = [
  'suppression',
  'forced-keep',
  'cost-bloat',
  'denial-of-review',
] as const
/** Where an attack case plants its text in the patch. */
export const CARRIERS = [
  'comment',
  'string-literal',
  'file-name',
  'documentation',
  'guideline-file',
] as const
/** How an attack case writes its text. */
export const ENCODINGS = [
  'plain',
  'multilingual',
  'hidden-unicode',
  'base64',
  'html-comment',
  'fake-delimiter',
] as const

export type Goal = typeof GOALS[number]
export type Carrier = typeof CARRIERS[number]
export type Encoding = typeof ENCODINGS[number]

/** A span of lines of the new file, at the file's own path in the patch: where a bug is, or a decoy. */
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

/**
 * The patch of a bug case with text planted in it to turn its review: the case's twin. Its patch is
 * the twin's own code, so it carries no commit: the twin holds them.
 */
export interface AttackCase extends CaseOrigin {
  readonly kind: 'attack'
  /** The id of the bug case of the suite whose patch this one poisons. */
  readonly twin: string
  readonly goal: Goal
  readonly carrier: Carrier
  readonly encoding: Encoding
  /** Where the twin's bug is in this patch, whose lines the planted text may have moved. */
  readonly locations: readonly Location[]
  /** A forced keep's bait: lines of this patch a finding must not keep. */
  readonly decoy?: Location
  /** The same code's lines in the twin's patch, so the twin's review is checked for the same finding. */
  readonly twinDecoy?: Location
}

export type SuiteCase = BugCase | ControlCase | AttackCase

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

/** A suite name or a case id, as a schema: at most `MAX_ID` characters matching `SUITE_ID`. */
export const idSchema = z.string().max(MAX_ID, { error: `must be at most ${MAX_ID} characters` }).regex(SUITE_ID)
const textSchema = z.string().min(1, { error: 'must not be empty' }).max(MAX_TEXT, { error: `must be at most ${MAX_TEXT} characters` }).refine(text => hiddenLabels(text).length === 0, { error: 'must be one line of visible text' })
const commitSchema = z.string().regex(COMMIT, { error: 'must be a full commit hash: 40 or 64 lowercase hex digits' })

const locationSchema = z.strictObject({
  file: z.string().min(1, { error: 'must not be empty' }).max(MAX_FILE, { error: `must be at most ${MAX_FILE} characters` }),
  start: z.int().min(1),
  end: z.int().min(1),
})
  .refine(({ start, end }) => start <= end, { error: 'must start at or before its end' })
  .refine(({ start, end }) => end - start < MAX_RANGE_LINES, { error: `must span at most ${MAX_RANGE_LINES} lines` })

/** A case of any kind; the rules of each kind are checked after the fields. */
const caseSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['bug', 'control', 'attack']),
  patch: z.string().max(MAX_PATCH_NAME, { error: `must be at most ${MAX_PATCH_NAME} characters` }).regex(PATCH_NAME, { error: 'must be a bare file name: letters, digits, dots, underscores and dashes, not starting with a dot' }),
  twin: idSchema.optional(),
  goal: z.enum(GOALS).optional(),
  carrier: z.enum(CARRIERS).optional(),
  encoding: z.enum(ENCODINGS).optional(),
  locations: z.array(locationSchema).min(1).max(MAX_LOCATIONS, { error: `must hold at most ${MAX_LOCATIONS} locations` }).optional(),
  decoy: locationSchema.optional(),
  twinDecoy: locationSchema.optional(),
  repo: z.string().refine(isRepository, { error: 'must be an https:// URL with no credentials, query or fragment' }).optional(),
  fixCommit: commitSchema.optional(),
  introducingCommit: commitSchema.optional(),
  commit: commitSchema.optional(),
  license: z.string().regex(LICENSE, { error: 'must be one SPDX license id, such as MIT or Apache-2.0' }).optional(),
  copyright: z.array(textSchema).min(1).max(MAX_COPYRIGHT_LINES, { error: `must hold at most ${MAX_COPYRIGHT_LINES} lines` }).optional(),
  date: z.string().refine(isDay, { error: 'must be a date written YYYY-MM-DD' }).optional(),
  note: textSchema.optional(),
}).superRefine((entry, context) => {
  const flag = (field: keyof typeof entry, message: string): void => {
    context.addIssue({
      code: 'custom',
      path: [field],
      message,
    })
  }
  const only = (field: keyof typeof entry, kind: string): void => {
    if (entry[field] !== undefined) flag(field, `is only for ${kind}`)
  }
  const required = (field: keyof typeof entry, kind: string): void => {
    if (entry[field] === undefined) flag(field, `is required for ${kind}`)
  }
  if (entry.kind !== 'attack') {
    for (const field of ['twin', 'goal', 'carrier', 'encoding'] as const) only(field, 'an attack')
    for (const field of ['decoy', 'twinDecoy'] as const) only(field, 'a forced keep')
  }
  if (entry.kind === 'bug') {
    required('locations', 'a bug')
    only('commit', 'a control')
  } else if (entry.kind === 'control') {
    only('locations', 'a bug or an attack')
    only('fixCommit', 'a bug')
    only('introducingCommit', 'a bug')
  } else {
    for (const field of [
      'locations',
      'twin',
      'goal',
      'carrier',
      'encoding',
    ] as const) required(field, 'an attack')
    only('fixCommit', 'a bug')
    only('introducingCommit', 'a bug')
    only('commit', 'a control')
    for (const field of ['decoy', 'twinDecoy'] as const) {
      if (entry.goal === 'forced-keep') required(field, 'a forced keep')
      else if (entry.goal !== undefined) only(field, 'a forced keep')
    }
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
  const stats = await lstatOf(join(directory, 'cases'))
  if ('problem' in stats) return stats.problem
  if (stats.value.isSymbolicLink()) return 'is a symbolic link'
  return stats.value.isDirectory()
    ? undefined
    : 'is not a directory'
}

/** What `suite.yaml` holds once the schema has read it. */
type Header = z.output<typeof suiteSchema>

/** The path of a field of case `index`, as an issue writes it. */
type CasePath = (index: number, ...segments: PropertyKey[]) => string

/**
 * Read `suite.yaml` of a suite: a regular file, never a link, of at most 1 MiB, decoded, parsed as
 * YAML, checked to be plain data and read by the schema. `file` stands for it in the issues.
 *
 * @throws ConfigError with the first problem of the file's bytes, its text or its YAML (a document
 * that is no mapping included), or with every issue its data has
 */
async function readHeader(directory: string, file: string): Promise<{ readonly header: Header, readonly bytes: Uint8Array }> {
  const bytes = await readBounded(join(directory, 'suite.yaml'), MAX_SUITE_BYTES, '1 MiB', { noFollow: true })
  if ('problem' in bytes) fail(file, bytes.problem)
  const text = decode(bytes.value)
  if ('problem' in text) fail(file, text.problem)
  const parsed = parseYaml(text.value)
  if ('problem' in parsed) fail(file, parsed.problem)
  if (!isPlainObject(parsed.value)) fail(file, 'must hold a mapping')
  const data = dataIssues(parsed.value, file)
  if (data.length > 0) throw new ConfigError(data)
  return {
    header: parseConfig(suiteSchema, parsed.value, file),
    bytes: bytes.value,
  }
}

/** An issue for each case that repeats the id of an earlier one, naming that case. */
function repeatedIds(cases: Header['cases'], at: CasePath): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const firstWith = new Map<string, number>()
  for (const [index, { id }] of cases.entries()) {
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
  return issues
}

/**
 * Read each patch the cases name, once, in the order they first name it: its bytes as a regular file
 * of at most 16 MiB, never a link, checked as a diff. Each case whose patch has a problem gets an issue
 * for it; the case at which the bytes read take more than 64 MiB in total gets that issue instead, and
 * no more is read.
 */
async function readPatches(directory: string, cases: Header['cases'], at: CasePath): Promise<{ readonly patches: ReadonlyMap<string, Patch>, readonly issues: readonly ConfigIssue[] }> {
  const issues: ConfigIssue[] = []
  const patches = new Map<string, Patch>()
  const problems = new Map<string, string>()
  let total = 0
  for (const [index, { patch }] of cases.entries()) {
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
  return { patches, issues }
}

/** The issue a span has against the patch whose sections are given, or undefined when its file is one of the patch and its lines are all in a hunk. `patch` words the patch in the issue; `where` makes the span's path. */
function spanProblem(sections: ReadonlyMap<string, string>, span: Location, patch: string, where: (...segments: PropertyKey[]) => string): ConfigIssue | undefined {
  if (!sections.has(span.file)) {
    return {
      path: where('file'),
      message: `is not a file of ${patch}, as its diff --git header names it`,
    }
  }
  const outside = firstLineOutside(sections, span.file, span.start, span.end)
  return outside === undefined
    ? undefined
    : {
        path: where(),
        message: `line ${outside} is not in a hunk of ${patch}`,
      }
}

/** Whether one finding could catch both spans: the same file, and their ranges, each widened by `window` lines either side, meet. */
function meet(first: Location, second: Location, window: number): boolean {
  return first.file === second.file && first.start - window <= second.end + window && second.start - window <= first.end + window
}

/**
 * The issue a decoy has: its span problem against the patch, or, when it passed, that one finding
 * could catch it together with a location of `against` at `window`. `twin` says the decoy is a
 * twin decoy, checked against the twin's patch and locations.
 */
function decoyIssue(sections: ReadonlyMap<string, string>, decoy: Location, against: readonly Location[], window: number, twin: boolean, where: (...segments: PropertyKey[]) => string): ConfigIssue | undefined {
  const problem = spanProblem(sections, decoy, twin ? 'the twin\'s patch' : 'the patch', where)
  if (problem !== undefined) return problem
  return against.some(location => meet(decoy, location, window))
    ? {
        path: where(),
        message: `is within twice the window of a location${twin ? ' of the twin' : ''}, so one finding could catch both`,
      }
    : undefined
}

/**
 * The issues of the spans of the cases, in one pass. First, each attack whose twin is no bug case of
 * the suite (a missing id, a control, an attack, itself) gets one. Then, case by case: each location of
 * a bug or an attack and an attack's decoy are checked against the case's own patch, and the twin
 * decoy against the twin's patch, that each names a file of it, as its `diff --git` header names it, and
 * that all its lines sit in a hunk (the issue names the first that does not). A decoy that passed and
 * meets a location of its case at the suite's `window`, and a twin decoy that passed and meets a
 * location of its twin, get one more: one finding could catch both, and would read as a catch and as a
 * forced keep. A case whose patch was not read is left out: its patch has an issue of its own.
 */
function spanIssues(cases: Header['cases'], patches: ReadonlyMap<string, Patch>, window: number, at: CasePath): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const bugs = new Map(cases.flatMap(entry => entry.kind === 'bug'
    ? [
        [entry.id, entry] as const,
      ]
    : []))
  for (const [index, entry] of cases.entries()) {
    if (entry.kind === 'attack' && (entry.twin === undefined || !bugs.has(entry.twin))) {
      issues.push({
        path: at(index, 'twin'),
        message: 'must be the id of a bug case of the suite',
      })
    }
  }
  for (const [index, entry] of cases.entries()) {
    const read = patches.get(entry.patch)
    if (entry.kind === 'control' || read === undefined) continue
    const locations = entry.locations ?? []
    for (const [position, location] of locations.entries()) {
      const issue = spanProblem(read.sections, location, 'the patch', (...segments) => at(index, 'locations', position, ...segments))
      if (issue !== undefined) issues.push(issue)
    }
    const twin = entry.twinDecoy === undefined || entry.twin === undefined
      ? undefined
      : bugs.get(entry.twin)
    const twinRead = twin === undefined
      ? undefined
      : patches.get(twin.patch)
    const found = [
      entry.decoy === undefined
        ? undefined
        : decoyIssue(read.sections, entry.decoy, locations, window, false, (...segments) => at(index, 'decoy', ...segments)),
      entry.twinDecoy === undefined || twin === undefined || twinRead === undefined
        ? undefined
        : decoyIssue(twinRead.sections, entry.twinDecoy, twin.locations ?? [], window, true, (...segments) => at(index, 'twinDecoy', ...segments)),
    ]
    for (const issue of found) {
      if (issue !== undefined) issues.push(issue)
    }
  }
  return issues
}

/** The suite's content hash: `sha256:` and the hex SHA-256 of the files' own hashes, `suite.yaml` first, then each patch by name. */
function contentHash(suiteBytes: Uint8Array, patches: ReadonlyMap<string, Patch>): string {
  const files = [
    [
      'suite.yaml',
      sha256(suiteBytes),
    ],
    ...[...patches].sort(([first], [second]) => first < second
      ? -1
      : 1).map(([name, { hash }]) => [`cases/${name}`, hash]),
  ]
  return `sha256:${sha256(JSON.stringify(files))}`
}

/**
 * Read the suite in `directory`: `suite.yaml` and the patches in `cases/` that its cases name. Each
 * patch is read once, as a regular file of at most 16 MiB (all together at most 64 MiB), decoded as
 * the review command decodes a diff, and must start with `diff --git ` and name at least one file;
 * each location of a bug or an attack, and an attack's decoy, must name a file of its patch by the
 * diff's own path, and each of its lines must sit in a hunk of the patch; an attack's twin must be a
 * bug case of the suite, its twin decoy must do the same against the twin's patch, and no decoy may
 * be within twice the window of a location it could be caught with. A file of `cases/` that no case
 * names is not read. The hash covers `suite.yaml` and each patch a case names, once.
 *
 * `label` stands for the directory in the issues, which name `<label>/suite.yaml` and a path in it, or
 * `<label>/cases`; no issue quotes a file.
 *
 * @throws ConfigError with the first problem of the bytes, the text or the YAML of `suite.yaml`, or every
 * issue its data has; or the repeated ids and the problem of `cases/`; or every other issue found
 */
export async function loadSuite(directory: string, label = directory): Promise<Suite> {
  const file = `${label}/suite.yaml`
  const { header, bytes } = await readHeader(directory, file)
  const at: CasePath = (index, ...segments) => configPath(['cases', index, ...segments], file)

  const ids = repeatedIds(header.cases, at)
  const casesIssue = await casesProblem(directory)
  if (casesIssue !== undefined) {
    throw new ConfigError([
      ...ids,
      { path: `${label}/cases`, message: casesIssue },
    ])
  }

  const { patches, issues } = await readPatches(directory, header.cases, at)
  const found = [
    ...ids,
    ...issues,
    ...spanIssues(header.cases, patches, header.window, at),
  ]
  if (found.length > 0) throw new ConfigError(found)

  return {
    name: header.name,
    trials: header.trials,
    window: header.window,
    // The kind rules of `caseSchema` make each case a `BugCase`, a `ControlCase` or an `AttackCase`.
    cases: header.cases as SuiteCase[],
    patches: new Map([...patches].map(([name, { text }]) => [name, text])),
    hash: contentHash(bytes, patches),
  }
}
