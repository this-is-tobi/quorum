import type { ConfigIssue } from './errors.ts'
import { isRecord } from './output.ts'
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
])

/** The rules a path review skips a file by: the bench's schema takes the same list. */
export const SKIP_RULES = [
  'vendored',
  'lockfile',
  'minified',
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
 * `reason` that is none of `excluded`, `binary`, `submodule` and `skipped`, and its `rule`: one of the seven
 * a skipped file has, which no other reason has. A reason or a rule is a value of this release: a reader of
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
      issues.push({ path: `${path}.reason`, message: 'must be excluded, binary, submodule or skipped' })
    } else if (entry.reason === 'skipped') {
      if (!SKIP_RULE_SET.has(entry.rule)) issues.push({ path: `${path}.rule`, message: 'must be vendored, lockfile, minified, secret, binary, submodule or lfs' })
    } else if (entry.rule !== undefined) {
      issues.push({ path: `${path}.rule`, message: 'belongs to a skipped file only' })
    }
  }
  return issues
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

/**
 * The files a review leaves out as one list: the source's first, then the diff's, each file, reason and rule
 * once, the first kept. Every entry is a copy of its known fields, `rule` only for a skipped file.
 */
export function mergeLeftOut(source: readonly LeftOutFile[], diff: readonly LeftOutFile[]): LeftOutFile[] {
  const listed = new Set<string>()
  const merged: LeftOutFile[] = []
  for (const entry of [
    ...source,
    ...diff,
  ]) {
    const copy: LeftOutFile = entry.reason === 'skipped'
      ? { file: entry.file, reason: entry.reason, rule: entry.rule }
      : { file: entry.file, reason: entry.reason }
    const key = JSON.stringify([
      copy.reason,
      copy.file,
      copy.reason === 'skipped'
        ? copy.rule
        : null,
    ])
    if (listed.has(key)) continue
    listed.add(key)
    merged.push(copy)
  }
  return merged
}
