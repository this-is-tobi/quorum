/**
 * The readers of the text a config and its files hold: UTF-8 bytes to text, YAML and JSON to plain data, and a rules file's list
 * of review rules. The config loader, the profile resolution and `readContext` share them, so a rules file is read one way
 * wherever it comes from, and nothing here reads a file: it takes bytes or text, and a problem it finds is worded without a
 * word of the text it was handed.
 */

import { extname } from 'node:path'
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument } from 'yaml'
import type { Document, YAMLError } from 'yaml'
import { isSafeSegment } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { isRecord } from '../core/output.ts'
import type { ReviewRule } from '../core/types.ts'

/** How many keys deep a value of a config may sit: deeper data could overflow the stack of a walk over it. */
export const MAX_DEPTH = 64

/** What a read found, or the problem with the file, as an issue words it, and how many bytes the problem counts toward a total. */
export type Read<T> = { readonly value: T } | { readonly problem: string, readonly counted?: number }

/** What a read says of a file that holds nothing: only comments or `null` in YAML, only white space in JSON. */
const EMPTY = 'is empty'

/** The UTF-8 text of `bytes`, a leading byte-order mark dropped (the decoder's default). */
export function decode(bytes: Uint8Array): Read<string> {
  try {
    return {
      value: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    }
  } catch {
    return { problem: 'is not UTF-8 text' }
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
 * JSON has no other. The walk keeps its own stack, in the order of the package's `visit` (which copies its
 * path at every node, so it takes seconds on a document thousands deep), and enters no node more than
 * `MAX_DEPTH` keys deep: `dataIssues` refuses that data whatever the walk finds there.
 */
function repeatedKeyAt(doc: Document): number | undefined {
  const stack: { node: unknown, depth: number }[] = [
    { node: doc.contents, depth: 0 },
  ]
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const { node, depth } = entry
    if (depth > MAX_DEPTH) continue
    if (isPair(node)) {
      stack.push({ node: node.value, depth }, { node: node.key, depth })
    } else if (isMap(node) || isSeq(node)) {
      if (isMap(node)) {
        const seen = new Set<unknown>()
        for (const { key } of node.items) {
          const value = isScalar(key)
            ? key.value
            : key
          if (seen.has(value)) {
            return (isScalar(key)
              ? key.range?.[0]
              : undefined) ?? 0
          }
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
export function parseYaml(text: string): Read<unknown> {
  const lines = new LineCounter()
  try {
    const doc = parseDocument(text, {
      schema: 'core',
      version: '1.2',
      merge: false,
      resolveKnownTags: false,
      uniqueKeys: false,
      stringKeys: true,
      prettyErrors: false,
      logLevel: 'error',
      strict: true,
      lineCounter: lines,
    })
    const first = doc.errors[0] ?? doc.warnings[0]
    if (first !== undefined) {
      return {
        problem: yamlProblem(first, lines),
      }
    }
    const repeated = repeatedKeyAt(doc)
    if (repeated !== undefined) return { problem: `is not valid YAML at ${position(lines, repeated)} (DUPLICATE_KEY)` }
    const value: unknown = doc.toJS({ maxAliasCount: 0 })
    return value === null
      ? { problem: EMPTY }
      : { value }
  } catch (error) {
    // An alias throws a ReferenceError once aliases are disabled; deep nesting can throw a RangeError.
    return {
      problem: error instanceof ReferenceError
        ? 'uses an alias, which quorum does not read'
        : 'is not valid YAML',
    }
  }
}

/**
 * JSON, refusing a duplicate key, which `JSON.parse` resolves silently to the last value: the same text
 * goes through the yaml package's JSON schema, whose document shows the repeat. `JSON.parse` stays the
 * authority for syntax and values, and its message, which quotes the source, is never used.
 */
export function parseJson(text: string): Read<unknown> {
  if (text.trim() === '') return { problem: EMPTY }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { problem: 'is not valid JSON' }
  }
  const lines = new LineCounter()
  try {
    const doc = parseDocument(text, {
      schema: 'json',
      uniqueKeys: false,
      prettyErrors: false,
      logLevel: 'error',
      lineCounter: lines,
    })
    const first = doc.errors[0]
    if (first !== undefined) return { problem: `is not valid JSON at ${position(lines, first.pos[0])} (${first.code})` }
    const repeated = repeatedKeyAt(doc)
    return repeated === undefined
      ? { value }
      : { problem: `has a duplicate key at ${position(lines, repeated)}` }
  } catch {
    return { problem: 'is not valid JSON' }
  }
}

/** The format a rules file's extension names, read from the map alone, never from an object's prototype. */
const RULES_FORMATS: ReadonlyMap<string, 'yaml' | 'json'> = new Map([
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.json', 'json'],
])

/** The words of a rules file's extension that is none of the three. */
export const RULES_EXTENSION = 'must end in .yaml, .yml or .json'

/** The format a rules file's path names by its extension: `.yaml` and `.yml` are YAML, `.json` is JSON, anything else (the case of a letter included) none. */
export function rulesFormat(path: string): 'yaml' | 'json' | undefined {
  return RULES_FORMATS.get(extname(path))
}

/** The fields of a rule, in the order a rules file writes them. */
const RULE_FIELDS: ReadonlySet<string> = new Set(['id', 'text', 'paths'])

/**
 * What is wrong with the shape of the rule at `index` of a rules file, or the rule itself: it is an object that holds no field
 * but `id`, `text` and `paths`, an `id` and a `text` that are strings, and `paths`, when it is there, a list of strings. A
 * problem reads `<index>.<field> <problem>`, and names a field only when it is safe to print: a key that is not a safe name is
 * never repeated.
 */
function ruleShape(rule: unknown, index: number): { readonly problem: string } | { readonly rule: ReviewRule } {
  if (!isRecord(rule)) return { problem: `${index} must be an object with an id and a text` }
  for (const key of Object.keys(rule)) {
    if (!RULE_FIELDS.has(key)) {
      return {
        problem: isSafeSegment(key)
          ? `${index}.${key} is not a known field`
          : `${index} holds a field that is not known`,
      }
    }
  }
  const { id, text, paths } = rule
  for (const [field, value] of [
    ['id', id],
    ['text', text],
  ] as const) {
    if (value === undefined) return { problem: `${index}.${field} is required` }
    if (typeof value !== 'string') return { problem: `${index}.${field} must be a string` }
  }
  if (paths === undefined) {
    return {
      rule: { id: id as string, text: text as string },
    }
  }
  if (!Array.isArray(paths)) return { problem: `${index}.paths must be an array of patterns` }
  const bad = Array.from<unknown>(paths).findIndex(pattern => typeof pattern !== 'string')
  if (bad !== -1) return { problem: `${index}.paths.${bad} must be a string` }
  return {
    rule: {
      id: id as string,
      text: text as string,
      paths: [...paths as string[]],
    },
  }
}

/**
 * The review rules a rules file holds: `text` read as `format` (YAML as a config is, JSON with a repeated key refused) must be
 * a list of rules, each an object of an `id`, a `text` and optionally `paths`, a list of strings, and nothing else: an unknown
 * key, a repeated key, an alias or a tag is a problem. A file that holds nothing (YAML of comments alone, or `null`; JSON of white
 * space alone) and a file that holds `[]` hold no rule, as an empty guidelines file holds no text: they are no problem. Only the shape is checked here (the rule checks are
 * `ruleIssues`'s: the id's pattern, the text's length once cleaned, the patterns, the caps), and the rules come back as they
 * are written, each of its own fields alone. The problem is the parser's own words, or `<n>.<field> <problem>` for the first
 * rule whose shape is wrong, and holds no text of the file.
 */
export function parseRules(text: string, format: 'yaml' | 'json'): Read<ReviewRule[]> {
  const parsed = format === 'yaml'
    ? parseYaml(text)
    : parseJson(text)
  if ('problem' in parsed) {
    return parsed.problem === EMPTY
      ? { value: [] }
      : parsed
  }
  if (!Array.isArray(parsed.value)) return { problem: 'must be a list of rules' }
  const rules: ReviewRule[] = []
  // `Array.from` reads a hole as `undefined`, so it is reported like any other rule that is no object.
  for (const [index, rule] of Array.from<unknown>(parsed.value).entries()) {
    const shaped = ruleShape(rule, index)
    if ('problem' in shaped) return shaped
    rules.push(shaped.rule)
  }
  return { value: rules }
}

/**
 * Where `ruleIssues` put an issue, read back: the place of the rule in the list it checked, as a number, and the path of the
 * field below it, both absent and empty for an issue of the list as a whole. An issue of the rule's own (the cap its text takes
 * the total over) has a place and no field. The path starts with the root the list was checked under, one segment.
 */
export function rulePlace(issue: ConfigIssue): { readonly place?: number, readonly field: readonly string[] } {
  const [, place, ...field] = issue.path.split('.')
  return place === undefined
    ? { field }
    : {
        place: Number(place),
        field,
      }
}
