/**
 * The review rules a profile holds: a criterion a finding may cite by its id. A rule is a record of an id, a text and
 * the patterns of the files it applies to. Each research request carries the rules whose patterns match a file of the
 * change, in a block of its own, and a rule's text is cleaned (`cleanProse`) and capped as every document is. A rule's
 * text never appears in a message: an issue holds the path of the field and the words of the check alone.
 *
 * @see ../../docs/20-using/60-prompts.md
 */

import type { ConfigIssue } from './errors.ts'
import { excludeMatcher, patternProblem } from './exclude.ts'
import { isRecord } from './output.ts'
import { cleanProse, showHidden, UNSETTLED } from './sanitize.ts'
import type { Removed } from './sanitize.ts'
import { utf8Length } from './tokens.ts'
import type { ReviewRule } from './types.ts'

/** What a rule's id matches. */
export const RULE_ID = /^[a-z][a-z0-9._-]{0,63}$/

/** The most rules a profile lists, whatever their origin. */
export const MAX_RULES = 100

/** The most code points a rule's text holds once cleaned. */
export const MAX_RULE_TEXT = 1024

/** The most UTF-8 bytes the cleaned texts of a profile's rules take in all. */
export const RULES_CAP = 32_768

/** The most patterns a rule's `paths` holds. */
export const MAX_RULE_PATHS = 20

const SHAPE = 'must be an object with an id and a text'
const TEXT_LENGTH = `must hold 1 to ${MAX_RULE_TEXT} characters once cleaned`
const PATHS_COUNT = `must hold 1 to ${MAX_RULE_PATHS} patterns`

/** What is wrong with a profile's rules that come to `bytes` once cleaned, for the cap of all of them, or undefined when they are within it. */
export function rulesTotalProblem(bytes: number): string | undefined {
  return bytes <= RULES_CAP
    ? undefined
    : `takes the profile's rules to ${bytes} bytes once cleaned, over the ${RULES_CAP / 1024} KiB they may hold in all`
}

/** What is wrong with a profile that lists `count` rules, whatever their origin, or undefined when it lists no more than it may. */
export function rulesCountProblem(count: number): string | undefined {
  return count <= MAX_RULES
    ? undefined
    : `must hold at most ${MAX_RULES} rules`
}

/** Whether a cleaned text holds more than `MAX_RULE_TEXT` code points: a text of more than twice that many code units must, and the others are counted. */
function overLength(text: string): boolean {
  return text.length > 2 * MAX_RULE_TEXT || Array.from(text).length > MAX_RULE_TEXT
}

/** What is wrong with a rule's id, or undefined: it is no id the pattern accepts, or it repeats one of `seen`. */
function idProblem(id: unknown, seen: ReadonlySet<string>): string | undefined {
  if (typeof id !== 'string' || !RULE_ID.test(id)) return `must match ${RULE_ID.source}`
  return seen.has(id)
    ? `repeats the rule id ${JSON.stringify(id)}`
    : undefined
}

/** The issues of a rule's `paths` at `path`: none when it is unset, else a list of 1 to 20 patterns `exclude` accepts. */
function pathsIssues(paths: unknown, path: string): ConfigIssue[] {
  if (paths === undefined) return []
  if (!Array.isArray(paths)) {
    return [
      { path, message: 'must be an array of patterns' },
    ]
  }
  if (paths.length < 1 || paths.length > MAX_RULE_PATHS) {
    return [
      { path, message: PATHS_COUNT },
    ]
  }
  // `Array.from` reads a hole as `undefined`, so it is reported like any other pattern that is no string.
  return Array.from<unknown>(paths).flatMap((pattern, index) => {
    const problem = typeof pattern === 'string'
      ? patternProblem(pattern)
      : 'must be a string'
    return problem === undefined
      ? []
      : [
          { path: `${path}.${index}`, message: problem },
        ]
  })
}

/** The bytes a rule's text is sent as once cleaned and what is wrong with it, each undefined when it cannot be said: a text that is no string or that the cleaner cannot settle has no bytes. */
function textOf(text: unknown): { readonly problem?: string, readonly bytes?: number } {
  if (typeof text !== 'string') return { problem: 'must be a string' }
  const cleaned = cleanProse(text)
  if (!cleaned.settled) return { problem: UNSETTLED }
  const bytes = utf8Length(cleaned.text)
  return cleaned.text.trim() === '' || overLength(cleaned.text)
    ? { problem: TEXT_LENGTH, bytes }
    : { bytes }
}

/**
 * Every problem with `rules`, which an untyped caller can hand over as anything, each at its own path under `root`: a list
 * of at most 100 (the rules are then not read), each rule a record whose `id` matches `RULE_ID` and repeats none before it,
 * whose `text` holds 1 to 1024 code points once cleaned and is settled (the cleaner changes nothing more in 16 passes),
 * whose `paths`, when set, hold 1 to 20 patterns each `patternProblem` accepts, and whose cleaned texts take at most
 * 32 KiB in all, reported once, at the first rule that takes the list's own total over. The bytes the message names are the
 * profile's, as `held`, what the profile's rules before this list take (its own, and the documents' before), plus the list's
 * up to that rule. No message holds a rule's text.
 */
export function ruleIssues(rules: unknown, root: string, held = 0): ConfigIssue[] {
  if (!Array.isArray(rules)) {
    return [
      { path: root, message: 'must be an array of rules' },
    ]
  }
  const tooMany = rulesCountProblem(rules.length)
  if (tooMany !== undefined) {
    return [
      { path: root, message: tooMany },
    ]
  }
  const issues: ConfigIssue[] = []
  const seen = new Set<string>()
  let total = 0
  let over = false
  // `Array.from` reads a hole as `undefined`, so it is reported like any other rule that is no object.
  Array.from<unknown>(rules).forEach((rule, index) => {
    const path = `${root}.${index}`
    if (!isRecord(rule)) {
      issues.push({ path, message: SHAPE })
      return
    }
    const id = idProblem(rule.id, seen)
    if (id !== undefined) issues.push({ path: `${path}.id`, message: id })
    if (typeof rule.id === 'string') seen.add(rule.id)
    const text = textOf(rule.text)
    if (text.problem !== undefined) issues.push({ path: `${path}.text`, message: text.problem })
    issues.push(...pathsIssues(rule.paths, `${path}.paths`))
    total += text.bytes ?? 0
    const problem = over || total <= RULES_CAP
      ? undefined
      : rulesTotalProblem(held + total)
    if (problem !== undefined) {
      over = true
      issues.push({ path, message: problem })
    }
  })
  return issues
}

/**
 * The bytes the cleaned text of each of `rules` takes, however many they are, or undefined when they cannot be said: `rules`
 * is no list of records with a string text, or a text is one the cleaner cannot settle.
 */
export function ruleTextSizes(rules: unknown): number[] | undefined {
  if (!Array.isArray(rules)) return undefined
  const sizes: number[] = []
  for (const rule of Array.from<unknown>(rules)) {
    if (!isRecord(rule) || typeof rule.text !== 'string') return undefined
    const cleaned = cleanProse(rule.text)
    if (!cleaned.settled) return undefined
    sizes.push(utf8Length(cleaned.text))
  }
  return sizes
}

/**
 * The bytes the cleaned texts of `rules` take in all, however many they are, or undefined when they cannot be said (see
 * `ruleTextSizes`). It is what the cap of all of a profile's rules counts.
 */
export function ruleTextBytes(rules: unknown): number | undefined {
  return ruleTextSizes(rules)?.reduce((total, size) => total + size, 0)
}

/**
 * `rules` as a request carries them: each text cleaned, and nothing of a rule but its id, its text and its patterns kept,
 * with what the cleaner removed from the texts in all. The caller's rules are not changed. The rules must be ones
 * `ruleIssues` accepts.
 */
export function cleanedRules(rules: readonly ReviewRule[]): { readonly rules: readonly ReviewRule[], readonly removed: Removed } {
  const removed = { characters: 0, comments: 0, entities: 0 }
  const cleaned = rules.map((rule) => {
    const text = cleanProse(rule.text)
    removed.characters += text.removed.characters
    removed.comments += text.removed.comments
    removed.entities += text.removed.entities
    return Object.freeze({
      id: rule.id,
      text: text.text,
      ...rule.paths === undefined
        ? {}
        : {
            paths: Object.freeze([...rule.paths]),
          },
    })
  })
  return {
    rules: Object.freeze(cleaned),
    removed,
  }
}

/**
 * The rules of `rules` a review sends, in order: each rule with no `paths`, which applies to every file, and each whose
 * patterns (`excludeMatcher`, in `exclude`'s syntax) match one of `files`, the paths of the change's sections as the diff
 * names them, the empty name for a section with none. A change with no section at all, a diff left blank by `exclude` or by the
 * files held back, sends no request and so no rule: none, whatever the rules' paths.
 */
export function rulesSent(rules: readonly ReviewRule[], files: readonly string[]): ReviewRule[] {
  if (files.length === 0) return []
  return rules.filter(rule => rule.paths === undefined || files.some(excludeMatcher(rule.paths)))
}

/**
 * One rule as the rules block writes it: the line `<id>, for <pattern>, <pattern>:`, or `<id>, for every file:` for a rule
 * with no patterns, then its text. Each pattern shows its hidden characters as `<U+XXXX>`, so a pattern stays on the line
 * it is on.
 */
export function ruleEntry(rule: ReviewRule): string {
  const where = rule.paths === undefined
    ? 'every file'
    : rule.paths.map(showHidden).join(', ')
  return `${rule.id}, for ${where}:\n${rule.text}`
}

/** The rules block: each rule's entry, a blank line between. */
export function rulesBlock(rules: readonly ReviewRule[]): string {
  return rules.map(ruleEntry).join('\n\n')
}

/** The bytes the entries of `rules` take in UTF-8, as the rules block holds them, the blank lines between them left out. */
export function entriesBytes(rules: readonly ReviewRule[]): number {
  return rules.reduce((total, rule) => total + utf8Length(ruleEntry(rule)), 0)
}

/** The rule whose entry takes the most bytes in UTF-8, the first of those that tie, or undefined for none. */
export function largestRule(rules: readonly ReviewRule[]): ReviewRule | undefined {
  let largest: ReviewRule | undefined
  let size = -1
  for (const rule of rules) {
    const bytes = utf8Length(ruleEntry(rule))
    if (bytes > size) {
      largest = rule
      size = bytes
    }
  }
  return largest
}
