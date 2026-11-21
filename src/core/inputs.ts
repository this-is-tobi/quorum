import type { ConfigIssue } from './errors.ts'
import { isRecord } from './output.ts'
import { SECRET_RULES } from './secrets.ts'
import type { LeftOutFile, LeftOutReason, ObjectFormat, ReviewSource, SkipRule } from './types.ts'

/** The kinds of source whose ids name a git repository's objects, each with the fields that hold a full commit id. */
const ID_FIELDS: Readonly<Record<Exclude<ReviewSource['kind'], 'diff'>, readonly string[]>> = {
  range: ['base', 'mergeBase', 'head'],
  local: ['head'],
  staged: ['head'],
  paths: ['commit'],
}

const OBJECT_FORMATS: readonly ObjectFormat[] = ['sha1', 'sha256']

/** A full object id of each format: 40 lowercase hexadecimal characters for sha1, 64 for sha256. */
const OBJECT_IDS: Readonly<Record<ObjectFormat, RegExp>> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
}

const ID_MESSAGE = 'must be a full commit id of its object format: 40 lowercase hexadecimal characters for sha1, 64 for sha256'
const LEFT_OUT_REASONS: ReadonlySet<unknown> = new Set<LeftOutReason>([
  'excluded',
  'binary',
  'submodule',
  'skipped',
  'secret',
  'deleted-secret',
])
/** The reasons of a file held back as a secret, which carry the rule that held it. */
const HELD_REASONS: ReadonlySet<unknown> = new Set<LeftOutReason>(['secret', 'deleted-secret'])
const SECRET_RULE_SET: ReadonlySet<unknown> = new Set<string>(SECRET_RULES)

/** The rules a path review skips a file by: the bench's schema takes the same list. */
export const SKIP_RULES = [
  'vendored',
  'lockfile',
  'minified',
  'test',
  'secret',
  'binary',
  'submodule',
  'lfs',
] as const satisfies readonly SkipRule[]
const SKIP_RULE_SET: ReadonlySet<unknown> = new Set<string>(SKIP_RULES)

function isGitKind(kind: unknown): kind is keyof typeof ID_FIELDS {
  return typeof kind === 'string' && Object.hasOwn(ID_FIELDS, kind)
}

/**
 * Every problem with a value given as a review's `source`, so an untyped caller gets issues, never a
 * TypeError: none when it is unset, `source: must be an object`, `source.kind` when the kind is not one
 * of the five, else `source.objectFormat`, and, once the format is known, each id field that is not a full
 * commit id of it (a local or staged source's `head` may be null), a `paths` that is not an array of
 * strings and a `skips` that is not a boolean. A field it does not know is no problem: `sourceOf` leaves it
 * out of the record. No message repeats a value.
 */
export function sourceIssues(value: unknown): ConfigIssue[] {
  if (value === undefined) return []
  if (!isRecord(value)) {
    return [
      { path: 'source', message: 'must be an object' },
    ]
  }
  const { kind } = value
  if (kind === 'diff') return []
  if (!isGitKind(kind)) {
    return [
      { path: 'source.kind', message: 'must be diff, range, local, staged or paths' },
    ]
  }
  const issues: ConfigIssue[] = []
  const format = OBJECT_FORMATS.find(candidate => candidate === value.objectFormat)
  if (format === undefined) {
    issues.push({ path: 'source.objectFormat', message: 'must be sha1 or sha256' })
  } else {
    const nullable = kind === 'local' || kind === 'staged'
    for (const field of ID_FIELDS[kind]) {
      const id = value[field]
      if (nullable && id === null) continue
      if (typeof id === 'string' && OBJECT_IDS[format].test(id)) continue
      issues.push({
        path: `source.${field}`,
        message: nullable
          ? `${ID_MESSAGE}, or null when nothing is committed`
          : ID_MESSAGE,
      })
    }
  }
  if (kind === 'paths') {
    // `Array.from` reads a hole as `undefined`, so a sparse array is no array of strings.
    if (!Array.isArray(value.paths) || !Array.from<unknown>(value.paths).every(path => typeof path === 'string')) {
      issues.push({ path: 'source.paths', message: 'must be an array of strings' })
    }
    if (typeof value.skips !== 'boolean') issues.push({ path: 'source.skips', message: 'must be a boolean' })
  }
  return issues
}

/**
 * Every problem with a value given as a review's `leftOut`: none when it is unset, `leftOut: must be an
 * array`, else for each entry `leftOut.<index>` when it is no object, its `file` that is not a string, its
 * `reason` that is none of `excluded`, `binary`, `submodule`, `skipped`, `secret` and `deleted-secret`, and
 * its `rule`: one of the seven a skipped file has, one of the nine a held file has (`secret` and
 * `deleted-secret`), which no other reason has. A reason or a rule is a value of this release: a reader of
 * a result takes one it does not know as a file left out, but a caller of `review` names ones it can.
 */
export function leftOutIssues(value: unknown): ConfigIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    return [
      { path: 'leftOut', message: 'must be an array' },
    ]
  }
  const issues: ConfigIssue[] = []
  // `Array.from` reads a hole as `undefined`, so it is reported like any other entry that is no object.
  for (const [index, entry] of Array.from<unknown>(value).entries()) {
    const path = `leftOut.${index}`
    if (!isRecord(entry)) {
      issues.push({ path, message: 'must be an object with a file and a reason' })
      continue
    }
    if (typeof entry.file !== 'string') issues.push({ path: `${path}.file`, message: 'must be a string' })
    if (!LEFT_OUT_REASONS.has(entry.reason)) {
      issues.push({ path: `${path}.reason`, message: 'must be excluded, binary, submodule, skipped, secret or deleted-secret' })
    } else if (entry.reason === 'skipped') {
      if (!SKIP_RULE_SET.has(entry.rule)) issues.push({ path: `${path}.rule`, message: 'must be vendored, lockfile, minified, test, secret, binary, submodule or lfs' })
    } else if (HELD_REASONS.has(entry.reason)) {
      if (!SECRET_RULE_SET.has(entry.rule)) issues.push({ path: `${path}.rule`, message: `must be ${SECRET_RULES.slice(0, -1).join(', ')} or ${SECRET_RULES.at(-1)}` })
    } else if (entry.rule !== undefined) {
      issues.push({ path: `${path}.rule`, message: 'belongs to a skipped, secret or deleted-secret file only' })
    }
  }
  return issues
}

/**
 * Every problem with a value given as a review's `send`: none when it is unset, `send: must be an array`,
 * else `send.<index>: must name a file` for each entry that is not a non-empty string, a hole included. The
 * empty name is the text no header names, which no file of the diff is, so it is no file to send.
 */
export function sendIssues(value: unknown): ConfigIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    return [
      { path: 'send', message: 'must be an array' },
    ]
  }
  // `Array.from` reads a hole as `undefined`, so it is reported like any other entry that is no name.
  return Array.from<unknown>(value).flatMap((entry, index) => typeof entry === 'string' && entry !== ''
    ? []
    : [
        { path: `send.${index}`, message: 'must name a file' },
      ])
}

/**
 * A checked source as the review records it: a copy of its known fields, so the caller's later changes to
 * the object, or to its `paths`, never reach the result, and `{ kind: 'diff' }` for an unset source.
 */
export function sourceOf(value: ReviewSource | undefined): ReviewSource {
  if (value === undefined) return { kind: 'diff' }
  switch (value.kind) {
    case 'diff':
      return { kind: 'diff' }
    case 'range':
      return {
        kind: 'range',
        base: value.base,
        mergeBase: value.mergeBase,
        head: value.head,
        objectFormat: value.objectFormat,
      }
    case 'local':
    case 'staged':
      return { kind: value.kind, head: value.head, objectFormat: value.objectFormat }
    case 'paths':
      return {
        kind: 'paths',
        commit: value.commit,
        paths: [...value.paths],
        skips: value.skips,
        objectFormat: value.objectFormat,
      }
  }
}

/** A copy of a file left out with its known fields: `rule` only for a skipped or a held file. */
function copyOf(entry: LeftOutFile): LeftOutFile {
  switch (entry.reason) {
    case 'skipped':
      return { file: entry.file, reason: entry.reason, rule: entry.rule }
    case 'secret':
    case 'deleted-secret':
      return { file: entry.file, reason: entry.reason, rule: entry.rule }
    default:
      return { file: entry.file, reason: entry.reason }
  }
}

/**
 * The files a review leaves out as one list: the source's first, then the diff's, each file, reason and rule
 * once, the first kept. Every entry is a copy of its known fields, `rule` only for a skipped or a held file.
 */
export function mergeLeftOut(source: readonly LeftOutFile[], diff: readonly LeftOutFile[]): LeftOutFile[] {
  const listed = new Set<string>()
  const merged: LeftOutFile[] = []
  for (const entry of [
    ...source,
    ...diff,
  ]) {
    const copy = copyOf(entry)
    const key = JSON.stringify([
      copy.reason,
      copy.file,
      'rule' in copy
        ? copy.rule
        : null,
    ])
    if (listed.has(key)) continue
    listed.add(key)
    merged.push(copy)
  }
  return merged
}
