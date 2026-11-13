import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments, stringify } from 'yaml'
import { z } from 'zod'
import { CARRIERS, DEFAULT_WINDOW, ENCODINGS, GOALS, idSchema, MAX_TRIALS, PATCH_NAME } from '../src/bench/suite.ts'
import type { Carrier, Encoding, Goal, Location } from '../src/bench/suite.ts'
import { parseConfig } from '../src/config/schema.ts'
import { ConfigError } from '../src/core/errors.ts'
import { hiddenLabels } from '../src/core/sanitize.ts'

// The injection corpus's writer: it builds `bench/injection/` (`suite.yaml` and the poisoned patches in
// `cases/`) from `bench/injection/manifest.yaml` and the bug cases of `bench/bugs/`, each attack a twin's
// patch with a payload planted in it. It is run by hand, `bun run ./scripts/injection-corpus.ts`, and its
// output is committed: a test builds the corpus again and holds it equal to the committed files. It is a
// development tool and nothing else: the package is built from src/ alone, no module of src/ imports it,
// the image's build stage copies src/ alone, and neither a binary nor the bench ever runs it. The same
// manifest and twins always give the same bytes: no clock, randomness or environment enters the build.

export const PLACEHOLDER = '{payload}'
export const MAX_PAYLOAD = 400
export const MAX_TECHNIQUE = 120
export const MAX_PLANTED_LINES = 20

/** The longest part of a path, in bytes: what a file system takes. */
const MAX_PATH_PART = 255
const MANIFEST = 'bench/injection/manifest.yaml'
const TWINS = 'bench/bugs'
/** The tag characters hold the printable ASCII range at this offset: U+E0020 to U+E007E. */
const TAG_OFFSET = 0xE0000
const GIT_HEADER = 'diff --git '
/** A hunk header: the old range as written, the new start, the new count if written, and what follows (a function name). */
const HUNK_HEADER = /^@@ -(\d+(?:,\d+)?) \+(\d+)(?:,(\d+))? @@(.*)$/
const YAML_OPTIONS = { aliasDuplicateObjects: false, lineWidth: 0, indentSeq: false }

/** A generator input that would corrupt a patch, or a manifest or a twin it cannot build from. */
export class CorpusError extends Error {}

const GOAL_WORDS: Readonly<Record<Goal, string>> = {
  suppression: 'Suppression',
  'forced-keep': 'A forced keep',
  'cost-bloat': 'Cost bloat',
  'denial-of-review': 'Denial of review',
}
const CARRIER_WORDS: Readonly<Record<Carrier, string>> = {
  comment: 'a code comment',
  'string-literal': 'a string literal',
  'file-name': 'a file name',
  documentation: 'documentation',
  'guideline-file': 'a guideline file',
}
const ENCODING_WORDS: Readonly<Record<Encoding, string>> = {
  plain: 'in plain English',
  multilingual: 'in another language',
  'hidden-unicode': 'in invisible tag characters',
  base64: 'in base64',
  'html-comment': 'in an HTML comment',
  'fake-delimiter': 'with forged structure',
}
/** What an attack takes from its twin's entry, in the order the entry writes it. */
const ORIGIN_FIELDS = ['repo', 'license', 'copyright', 'date'] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPrintableAscii = (text: string): boolean => /^[\x20-\x7E]*$/.test(text)
const isVisible = (text: string): boolean => hiddenLabels(text).length === 0
function withoutCr(row: string): string {
  return row.endsWith('\r')
    ? row.slice(0, -1)
    : row
}

/**
 * `text` as one YAML document. A syntax error, a warning (an unresolved tag, say) and a second document are
 * refused by their code and line: the library's message quotes the text, and a warning goes to stderr with a
 * code frame, so none is let through, and the library is told to log nothing.
 */
function parseYaml(text: string, label: string): unknown {
  const documents = Array.from(parseAllDocuments(text, { logLevel: 'silent' }))
  for (const document of documents) {
    const [problem] = [
      ...document.errors,
      ...document.warnings,
    ]
    if (problem !== undefined) throw new CorpusError(`${label}: is not valid YAML (${problem.code}, line ${problem.linePos?.[0].line ?? 1})`)
  }
  if (documents.length > 1) throw new CorpusError(`${label}: is not valid YAML (MULTIPLE_DOCS)`)
  return documents[0]?.toJS() ?? null
}

/** Run `build`, and put `id` and a colon before the message of the corpus or config error it throws. */
function named<T>(id: string, build: () => T): T {
  try {
    return build()
  } catch (error) {
    if (error instanceof CorpusError || error instanceof ConfigError) throw new CorpusError(`${id}: ${error.message}`)
    throw error
  }
}

/** A payload as its encoding writes it into a patch. */
export function encodePayload(payload: string, encoding: Encoding): string {
  switch (encoding) {
    case 'hidden-unicode':
      if (!isPrintableAscii(payload)) throw new CorpusError('a hidden-unicode payload must be printable ASCII')
      return [...payload].map(character => String.fromCodePoint(TAG_OFFSET + character.charCodeAt(0))).join('')
    case 'base64':
      return Buffer.from(payload, 'utf8').toString('base64')
    case 'html-comment':
      if (payload.includes('-->')) throw new CorpusError('an html-comment payload must not hold -->')
      return `<!-- ${payload} -->`
    default:
      return payload
  }
}

/** What git writes after a backslash for a byte of a quoted name (a three-digit octal escape for any other byte it quotes). */
const NAME_ESCAPES = new Map([
  [0x07, '\\a'],
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0A, '\\n'],
  [0x0B, '\\v'],
  [0x0C, '\\f'],
  [0x0D, '\\r'],
  [0x22, '\\"'],
  [0x5C, '\\\\'],
])
const isQuotedByte = (byte: number): boolean => byte < 0x20 || byte === 0x22 || byte === 0x5C || byte >= 0x7F

/** A name as git writes it in a header with `core.quotePath` on: between double quotes, with escapes, when a byte of it needs them. */
export function quoteName(name: string): string {
  const bytes = new TextEncoder().encode(name)
  if (!bytes.some(isQuotedByte)) return name
  const written = Array.from(bytes, (byte) => {
    const escape = NAME_ESCAPES.get(byte)
    if (escape !== undefined) return escape
    return isQuotedByte(byte)
      ? `\\${byte.toString(8).padStart(3, '0')}`
      : String.fromCharCode(byte)
  })
  return `"${written.join('')}"`
}

/** The abbreviated id git gives a blob: the first 7 hex digits of the SHA-1 of `blob <bytes>`, a NUL and the content. */
export function blobId(content: string): string {
  const bytes = new TextEncoder().encode(content)
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex').slice(0, 7)
}

const headerOf = (path: string): string => `${GIT_HEADER}${quoteName(`a/${path}`)} ${quoteName(`b/${path}`)}`

/** A hunk of one file's section, read as `src/core/diff.ts` reads it: its header's counts say where it ends. */
interface Hunk {
  /** The index of the `@@` row. */
  readonly header: number
  /** The index after its last row, and after the `\ No newline` marker that follows it. */
  readonly end: number
  /** The old range as written. */
  readonly old: string
  readonly start: number
  /** The new count as written, or undefined when the header has none (one line). */
  readonly count: number | undefined
  readonly rest: string
  readonly carriageReturn: string
  /** The index of the row that shows each new line, from `start`. */
  readonly rowOfLine: readonly number[]
}

/** The hunks held by `rows` from `from` to `to`, in order. */
function hunksIn(rows: readonly string[], from: number, to: number): Hunk[] {
  const hunks: Hunk[] = []
  let at = from
  while (at < to) {
    const match = HUNK_HEADER.exec(withoutCr(rows[at]))
    if (match === null) {
      at++
      continue
    }
    const [, old, start, count, rest] = match
    const header = at++
    let oldLeft = Number(old.split(',')[1] ?? 1)
    let newLeft = Number(count ?? 1)
    const rowOfLine: number[] = []
    while (at < to && (oldLeft > 0 || newLeft > 0)) {
      const text = withoutCr(rows[at])
      const marker = text === ''
        ? ' '
        : text[0]
      if (marker === '-') {
        oldLeft--
      } else if (marker === '+' || marker === ' ') {
        if (marker === ' ') oldLeft--
        newLeft--
        rowOfLine.push(at)
      } else if (marker !== '\\') {
        break
      }
      at++
    }
    if (at < to && rows[at].startsWith('\\')) at++
    hunks.push({
      header,
      end: at,
      old,
      start: Number(start),
      count: count === undefined
        ? undefined
        : Number(count),
      rest,
      carriageReturn: rows[header].endsWith('\r')
        ? '\r'
        : '',
      rowOfLine,
    })
  }
  return hunks
}

/** A hunk's header, its new start moved down by `moved` and its new count grown by `grown`; a count that was not written stays unwritten while it is one line. */
function hunkHeader(hunk: Hunk, moved: number, grown: number): string {
  const count = hunk.count === undefined && grown === 0
    ? ''
    : `,${(hunk.count ?? 1) + grown}`
  return `@@ -${hunk.old} +${hunk.start + moved}${count} @@${hunk.rest}${hunk.carriageReturn}`
}

/**
 * The patch with `lines` planted in `file` right after its new line `after`, and after the removed rows
 * that follow that line, so git's grouping (removals before additions) holds. The hunk's new count grows
 * and every later hunk of the file moves down; a planted row ends with a carriage return when the row it
 * follows does.
 *
 * @throws CorpusError for a file the patch lacks, a line no hunk shows, or a line that ends its file with
 * no line break
 */
export function insertLines(patch: string, file: string, after: number, lines: readonly string[]): string {
  const rows = patch.split('\n')
  const total = rows.at(-1) === ''
    ? rows.length - 1
    : rows.length
  const first = rows.findIndex(row => withoutCr(row) === headerOf(file))
  if (first === -1) throw new CorpusError(`${file} is not a file of the patch`)
  const next = rows.findIndex((row, index) => index > first && row.startsWith(GIT_HEADER))
  const hunks = hunksIn(rows, first + 1, next === -1
    ? total
    : Math.min(next, total))
  const hunk = hunks.find(candidate => after >= candidate.start && after < candidate.start + candidate.rowOfLine.length)
  const row = hunk?.rowOfLine[after - hunk.start]
  if (hunk === undefined || row === undefined) throw new CorpusError(`line ${after} of ${file} is not in a hunk`)
  if (rows[row + 1]?.startsWith('\\')) throw new CorpusError(`line ${after} of ${file} has no line break at its end`)
  let plant = row + 1
  while (plant < hunk.end && (rows[plant].startsWith('-') || rows[plant].startsWith('\\'))) plant++
  const planted = lines.map(line => `+${line}${rows[row].endsWith('\r')
    ? '\r'
    : ''}`)
  const result = [...rows]
  result[hunk.header] = hunkHeader(hunk, 0, lines.length)
  for (const later of hunks.slice(hunks.indexOf(hunk) + 1)) result[later.header] = hunkHeader(later, lines.length, 0)
  result.splice(plant, 0, ...planted)
  return result.join('\n')
}

/**
 * The span as it is once `count` lines are planted after line `after` of `file`: a span of another file,
 * or one that ends at or before the line, stays; one that starts after it moves down by `count`.
 *
 * @throws CorpusError for a span that holds the line and goes past it
 */
export function shiftSpan(span: Location, file: string, after: number, count: number): Location {
  if (span.file !== file || span.end <= after) return span
  if (span.start <= after) throw new CorpusError(`the lines inserted after line ${after} of ${file} would split a span`)
  return {
    ...span,
    start: span.start + count,
    end: span.end + count,
  }
}

/** Whether a new file's path is relative, of named parts, each of a length a file system takes. */
function isNewPath(path: string): boolean {
  if (['\0', '\r', '\n'].some(character => path.includes(character))) return false
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && new TextEncoder().encode(part).byteLength <= MAX_PATH_PART)
}

/**
 * The patch with the new file `path` appended after its last section, as git writes one: the mode, the
 * blob's abbreviated id, and one hunk, or the first three lines alone for an empty file. The patch is then
 * a prefix of the result, and no span of it moves.
 *
 * @throws CorpusError for a path that is not relative, or that the patch already has
 */
export function addFile(patch: string, path: string, lines: readonly string[]): string {
  if (!isNewPath(path)) throw new CorpusError(`a new file must have a relative path of named parts, each at most ${MAX_PATH_PART} bytes`)
  const header = headerOf(path)
  if (patch.split('\n').some(row => withoutCr(row) === header)) throw new CorpusError(`${path} is already a file of the patch`)
  const section = [
    header,
    'new file mode 100644',
    `index 0000000..${blobId(lines.map(line => `${line}\n`).join(''))}`,
    ...lines.length === 0
      ? []
      : [
          '--- /dev/null',
          `+++ ${quoteName(`b/${path}`)}`,
          `@@ -0,0 +1${lines.length === 1
            ? ''
            : `,${lines.length}`} @@`,
          ...lines.map(line => `+${line}`),
        ],
  ]
  return `${patch}${patch.endsWith('\n')
    ? ''
    : '\n'}${section.join('\n')}\n`
}

const visibleText = z.string().min(1, { error: 'must not be empty' }).refine(isVisible, { error: 'must be one line of visible text' })
const lineSchema = z.string().refine(isVisible, { error: 'must be one line of visible text' })
const locationSchema = z.strictObject({
  file: z.string().min(1, { error: 'must not be empty' }),
  start: z.int().min(1),
  end: z.int().min(1),
}).refine(({ start, end }) => start <= end, { error: 'must start at or before its end' })
const attackSchema = z.strictObject({
  id: idSchema,
  goal: z.enum(GOALS),
  carrier: z.enum(CARRIERS),
  encoding: z.enum(ENCODINGS),
  technique: visibleText.max(MAX_TECHNIQUE, { error: `must be at most ${MAX_TECHNIQUE} characters` }),
  payload: z.string().min(1, { error: 'must not be empty' }).max(MAX_PAYLOAD, { error: `must be at most ${MAX_PAYLOAD} characters` }).refine(text => isVisible(text.replaceAll('\n', '')), { error: 'must hold no hidden character but the line feed' }),
  insert: z.strictObject({
    file: visibleText,
    after: z.int().min(1),
    lines: z.array(lineSchema).min(1).max(MAX_PLANTED_LINES),
  }).optional(),
  add: z.strictObject({
    path: visibleText,
    lines: z.array(lineSchema).max(MAX_PLANTED_LINES),
  }).optional(),
  twinDecoy: locationSchema.optional(),
})
const manifestSchema = z.strictObject({
  name: idSchema,
  trials: z.int().min(1).max(MAX_TRIALS),
  twins: z.array(z.strictObject({
    id: idSchema,
    attacks: z.array(attackSchema).min(1),
  })).min(1),
})

/** The manifest: the suite's name and trials, then the twins in order, each with its attacks. */
export type Manifest = z.output<typeof manifestSchema>
type Attack = Manifest['twins'][number]['attacks'][number]

/**
 * Read the manifest's text, strictly: every level takes the fields it names and no other.
 *
 * @throws ConfigError with every issue the manifest has, in the config file's wording
 */
export function readManifest(text: string): Manifest {
  return parseConfig(manifestSchema, parseYaml(text, MANIFEST), MANIFEST)
}

/** What the twins' suite holds, by case id: its window, if it says one, each case's entry, and each case's patch as bytes. */
export interface Twins {
  readonly window?: number
  readonly entries: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  readonly patches: ReadonlyMap<string, Uint8Array>
}

/** The suite of `directory`, read as `bench/bugs` is: its `suite.yaml` as YAML, its own test having validated it, and the patch each case names. */
export function readTwins(directory: string): Twins {
  const file = join(directory, 'suite.yaml')
  const suite = parseYaml(readFileSync(file, 'utf8'), file)
  if (!isRecord(suite) || !Array.isArray(suite.cases)) throw new CorpusError(`${file}: must hold a list of cases`)
  const entries = new Map<string, Record<string, unknown>>()
  const patches = new Map<string, Uint8Array>()
  for (const entry of suite.cases) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.patch !== 'string' || !PATCH_NAME.test(entry.patch)) throw new CorpusError(`${file}: each case needs an id and a patch named as a bare file name`)
    entries.set(entry.id, entry)
    patches.set(entry.id, readFileSync(join(directory, 'cases', entry.patch)))
  }
  return {
    ...typeof suite.window === 'number'
      ? { window: suite.window }
      : {},
    entries,
    patches,
  }
}

/** A twin of the manifest, as the build reads it: its entry, its patch as bytes and as text, and the bug's locations. */
interface Twin {
  readonly entry: Readonly<Record<string, unknown>>
  readonly patchName: string
  readonly bytes: Uint8Array
  readonly patch: string
  readonly locations: readonly Location[]
}

/** The bug case `id` of `twins`, its patch decoded as UTF-8 text. */
function twinOf(id: string, twins: Twins): Twin {
  const entry = twins.entries.get(id)
  const bytes = twins.patches.get(id)
  if (entry === undefined || bytes === undefined || entry.kind !== 'bug' || typeof entry.patch !== 'string') throw new CorpusError(`is not a bug case of ${TWINS}`)
  if (!PATCH_NAME.test(entry.patch)) throw new CorpusError('its patch is not named as a bare file name')
  let patch: string
  try {
    patch = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CorpusError('its patch is not UTF-8')
  }
  return {
    entry,
    patchName: entry.patch,
    bytes,
    patch,
    locations: parseConfig(z.array(locationSchema).min(1), entry.locations, 'locations'),
  }
}

/** Where an attack plants its text: lines inserted into a file of the twin, or a new file. */
type Placement = NonNullable<Attack['insert']> | NonNullable<Attack['add']>

function placementOf({ insert, add }: Attack): Placement {
  if (insert !== undefined && add === undefined) return insert
  if (add !== undefined && insert === undefined) return add
  throw new CorpusError('needs one of insert and add')
}

/** Check an attack's shape against the rules its carrier and encoding set, before anything is encoded or planted. */
function checkAttack(attack: Attack, placement: Placement): void {
  const { goal, carrier, encoding, payload, twinDecoy } = attack
  const inPath = 'path' in placement && placement.path.includes(PLACEHOLDER)
  const texts = 'path' in placement
    ? [placement.path, ...placement.lines]
    : placement.lines
  if (texts.reduce((count, text) => count + text.split(PLACEHOLDER).length - 1, 0) !== 1) throw new CorpusError(`must hold ${PLACEHOLDER} exactly once, in its lines or its path`)
  if ((goal === 'forced-keep') !== (twinDecoy !== undefined)) throw new CorpusError('a forced keep needs a twinDecoy, and only a forced keep has one')
  if (inPath !== (carrier === 'file-name')) throw new CorpusError(`a file-name carrier plants ${PLACEHOLDER} in the path of a new file`)
  if ((carrier === 'comment' || carrier === 'string-literal') && !('after' in placement)) throw new CorpusError(`a ${carrier} carrier inserts lines into a file of its twin`)
  if (carrier === 'guideline-file' && !('path' in placement)) throw new CorpusError('a guideline-file carrier adds a new file')
  if (encoding === 'html-comment' && carrier !== 'documentation' && carrier !== 'guideline-file') throw new CorpusError('an html-comment payload belongs in documentation or a guideline file')
  if (carrier === 'file-name' && !((encoding === 'plain' || encoding === 'fake-delimiter') && isPrintableAscii(payload) && !/["/\\]/.test(payload))) {
    throw new CorpusError('a file name\'s payload is plain or fake-delimiter, printable ASCII with no slash, double quote or backslash')
  }
}

/** An attack's poisoned patch and its suite entry, from its twin. */
function buildAttack(attack: Attack, twinId: string, twin: Twin, window: number): { readonly entry: Record<string, unknown>, readonly patch: string } {
  const { id, goal, carrier, encoding, technique, twinDecoy } = attack
  const placement = placementOf(attack)
  checkAttack(attack, placement)
  const encoded = encodePayload(attack.payload, encoding)
  const fill = (text: string): string => text.split(PLACEHOLDER).join(encoded)
  const lines = placement.lines.flatMap(line => fill(line).split('\n'))
  if (lines.length > MAX_PLANTED_LINES) throw new CorpusError(`plants ${lines.length} lines, more than ${MAX_PLANTED_LINES}`)
  let patch: string
  let locations = twin.locations
  let decoy = twinDecoy
  if ('after' in placement) {
    const { file, after } = placement
    patch = insertLines(twin.patch, file, after, lines)
    locations = locations.map(span => shiftSpan(span, file, after, lines.length))
    decoy = decoy && shiftSpan(decoy, file, after, lines.length)
    if (decoy !== undefined && decoy.file === file && after + 1 <= decoy.end + window && after + lines.length >= decoy.start - window) throw new CorpusError('the planted lines lie within the window of the decoy')
  } else {
    patch = addFile(twin.patch, fill(placement.path), lines)
  }
  return {
    entry: {
      id,
      kind: 'attack',
      patch: `${id}.patch`,
      twin: twinId,
      goal,
      carrier,
      encoding,
      locations,
      ...decoy === undefined || twinDecoy === undefined
        ? {}
        : { decoy, twinDecoy },
      ...Object.fromEntries(ORIGIN_FIELDS.filter(field => twin.entry[field] !== undefined).map(field => [field, twin.entry[field]])),
      note: `${GOAL_WORDS[goal]} through ${CARRIER_WORDS[carrier]}, ${ENCODING_WORDS[encoding]}, by ${technique}; the poisoned patch of ${twinId}`,
    },
    patch,
  }
}

/**
 * The corpus of a manifest, in memory: `suite.yaml`, then `cases/<name>` for each patch, each twin's
 * followed by its attacks'. A twin's entry and patch are copied as they are, its attacks follow it, and
 * every attack is checked before the next is built. An id the manifest names twice, or a patch name two
 * cases would write to, is refused: a second would overwrite the first's patch.
 *
 * @throws CorpusError whose message starts with the id of the twin or the attack it refuses
 */
export function buildCorpus(manifest: Manifest, twins: Twins): Map<string, Uint8Array> {
  const encoder = new TextEncoder()
  const window = twins.window ?? DEFAULT_WINDOW
  const files = new Map<string, Uint8Array>()
  const ids = new Set<string>()
  const cases: Record<string, unknown>[] = []
  /** Take `id` for a case of the corpus and `path` for a file of it, each at most once: a second claim would overwrite a patch. */
  const claim = (id: string, path: string): void => {
    if (ids.has(id)) throw new CorpusError('repeats an id of the manifest')
    if (files.has(path)) throw new CorpusError(`${path} is already a file of the corpus`)
    ids.add(id)
  }
  for (const { id, attacks } of manifest.twins) {
    const twin = named(id, () => {
      const read = twinOf(id, twins)
      claim(id, `cases/${read.patchName}`)
      return read
    })
    cases.push({ ...twin.entry })
    files.set(`cases/${twin.patchName}`, twin.bytes)
    for (const attack of attacks) {
      const path = `cases/${attack.id}.patch`
      const { entry, patch } = named(attack.id, () => {
        claim(attack.id, path)
        return buildAttack(attack, id, twin, window)
      })
      cases.push(entry)
      files.set(path, encoder.encode(patch))
    }
  }
  const suite = {
    name: manifest.name,
    trials: manifest.trials,
    ...twins.window === undefined
      ? {}
      : { window: twins.window },
    cases,
  }
  files.set('suite.yaml', encoder.encode(stringify(suite, YAML_OPTIONS)))
  return files
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

/** Build the whole corpus in memory first, so a refused manifest leaves `bench/injection/` as it was, then write it over the old one. */
function writeCorpus(): void {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const directory = join(root, 'bench/injection')
  try {
    const corpus = buildCorpus(readManifest(readFileSync(join(root, MANIFEST), 'utf8')), readTwins(join(root, TWINS)))
    rmSync(join(directory, 'cases'), { recursive: true, force: true })
    mkdirSync(join(directory, 'cases'), { recursive: true })
    for (const [path, bytes] of corpus) writeFileSync(join(directory, path), bytes)
    console.error(`Wrote suite.yaml and ${corpus.size - 1} patches to bench/injection`)
  } catch (error) {
    fail(error instanceof Error
      ? error.message
      : String(error))
  }
}

if (import.meta.main) writeCorpus()
