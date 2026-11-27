import { z } from 'zod'
import { isPlainObject } from '../config/load.ts'
import { cutRead, MAX_RESULTS, READ_MESSAGE, READ_RULE_ID, READ_RULE_TEXT } from '../core/reports.ts'
import type { IssueLevel, ReaderProblem, ScannerIssue, ScannerReport } from '../core/types.ts'
import { reportPath } from './paths.ts'
import type { ReportPaths } from './paths.ts'

/** What a reader hands over: a report, less what the caller that read the file adds. */
type ReaderResult = Omit<ScannerReport, 'format' | 'profile' | 'sha256'>

/** The scanner a saved response names for every issue it holds. */
const SCANNER = 'SonarQube'

/** A field quorum reads for its own sake: one of the wrong type is as good as one that is absent, and never makes an entry unreadable. */
function lenient<T extends z.ZodType>(schema: T): z.ZodCatch<z.ZodOptional<T>> {
  return schema.optional().catch(undefined)
}

const NAME = lenient(z.string().min(1))

/** A line: a safe integer of at least 0. An issue whose line is anything else cannot be placed, so it is unreadable. */
const LINE = z.number().int().nonnegative()

/** The fields of an issue that quorum reads: where it stands is read strictly, the rest leniently. */
const ISSUE = z.object({
  component: z.string(),
  project: NAME,
  rule: NAME,
  message: NAME,
  line: LINE.optional(),
  textRange: z.object({
    startLine: LINE.optional(),
  }).optional(),
  issueStatus: lenient(z.string()),
  status: lenient(z.string()),
  severity: lenient(z.string()),
  impacts: lenient(z.array(lenient(z.object({
    severity: lenient(z.string()),
  })))),
})

/** SonarQube's severities, and the severities of an impact, as the core's levels. */
const LEVELS: ReadonlyMap<string, IssueLevel> = new Map([
  ['BLOCKER', 'error'],
  ['CRITICAL', 'error'],
  ['HIGH', 'error'],
  ['MAJOR', 'warning'],
  ['MEDIUM', 'warning'],
  ['MINOR', 'note'],
  ['INFO', 'note'],
  ['LOW', 'note'],
])

/** The levels a severity can have, from the one that matters most to the one that matters least. */
const BY_IMPORTANCE: readonly IssueLevel[] = ['error', 'warning', 'note', 'unknown']

const levelOf = (severity: string): IssueLevel => LEVELS.get(severity) ?? 'unknown'

/** The level of an issue: the highest of its impacts' severities, else its own severity, else unknown. */
function issueLevel(severity: string | undefined, impacts: readonly (string | undefined)[]): IssueLevel {
  const severities = impacts.filter(impact => impact !== undefined)
  if (severities.length > 0) {
    const levels = severities.map(levelOf)
    return BY_IMPORTANCE.find(level => levels.includes(level)) ?? 'unknown'
  }
  return severity === undefined
    ? 'unknown'
    : levelOf(severity)
}

/** Whether an issue is open: by its `issueStatus` when it has one, else by its `status`. An issue that is resolved, closed, accepted or a false positive is none to review. */
function isOpen(issueStatus: string | undefined, status: string | undefined): boolean {
  return issueStatus === undefined
    ? status === 'OPEN' || status === 'CONFIRMED' || status === 'REOPENED'
    : issueStatus === 'OPEN' || issueStatus === 'CONFIRMED'
}

/** A total as a count, or none. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/** What the response's lists say, by key: a file component's path, and a rule's name cut once for all the issues that hold it. */
interface Lists {
  readonly paths: ReadonlyMap<string, string>
  readonly rules: ReadonlyMap<string, string>
}

/** The first entry of a list of objects for each key, as its `field` says, when that is a string that is not empty. */
function listOf(entries: unknown, key: string, field: string, read: (text: string) => string): Map<string, string> {
  const found = new Map<string, string>()
  if (!Array.isArray(entries)) return found
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    const name = entry[key]
    const text = entry[field]
    if (typeof name === 'string' && typeof text === 'string' && text !== '' && !found.has(name)) found.set(name, read(text))
  }
  return found
}

/** What an issue says of the file it is on: its path from `components` by its component key, else the key less its project key and its colon; none on the project itself, and unmapped when quorum cannot place it. */
function placeOf(component: string, project: string | undefined, listed: ReadonlyMap<string, string>, paths: ReportPaths): Pick<ScannerIssue, 'path' | 'unmapped'> {
  const written = listed.get(component)
  const key = project ?? component.slice(0, component.includes(':')
    ? component.indexOf(':')
    : component.length)
  const relative = written ?? (component.startsWith(`${key}:`)
    ? component.slice(key.length + 1)
    : undefined)
  if (written === undefined && component === key) return {}
  const path = relative === undefined
    ? undefined
    : reportPath(relative, paths, 'path')
  return path === undefined
    ? { unmapped: true }
    : { path }
}

/** The issue an entry is, or why it is none: one that is not open is skipped, and one quorum cannot read is unreadable. */
function issueOf(entry: unknown, lists: Lists, paths: ReportPaths): ScannerIssue | 'skipped' | 'unreadable' {
  const parsed = ISSUE.safeParse(entry)
  if (!parsed.success) return 'unreadable'
  const { component, project, rule, message, issueStatus, status, severity, impacts } = parsed.data
  if (!isOpen(issueStatus, status)) return 'skipped'
  if (rule === undefined || message === undefined) return 'unreadable'
  const line = parsed.data.line ?? parsed.data.textRange?.startLine
  const ruleText = lists.rules.get(rule)
  return {
    ...placeOf(component, project, lists.paths, paths),
    ...(line === undefined
      ? {}
      : { line }),
    scanner: SCANNER,
    ruleId: cutRead(rule, READ_RULE_ID),
    ...(ruleText === undefined
      ? {}
      : { ruleText }),
    message: cutRead(message, READ_MESSAGE),
    level: issueLevel(severity, (impacts ?? []).map(impact => impact?.severity)),
  }
}

/** The problems of a read, in the order of `ReaderProblem`. */
function problemsOf(truncated: boolean, tooMany: boolean): ReaderProblem[] {
  return [
    ...(truncated
      ? ['truncated' as const]
      : []),
    ...(tooMany
      ? ['too-many' as const]
      : []),
  ]
}

/**
 * The issues of a saved `api/issues/search` response, from its text. Every issue is read alone, so one that quorum cannot read is
 * counted as `unreadable` and the rest are read: an issue that is not open (by `issueStatus`, else `status`) is counted as
 * `skipped`, and one with no rule, no message, no component or a line that is no safe integer of at least 0 is `unreadable`. The
 * level is the highest of the issue's impacts, else its severity; the path comes from the response's components, else from the
 * issue's component key, by the path rules and never opened. A response that holds fewer issues than its search found
 * (`total`, else `paging.total`) is `truncated` and says the total, and one of more than 25 000 issues is read to that limit
 * (`too-many`), the issues past it counted in `notRead`. It never throws: text that is no JSON, or no response, is `not-the-format`.
 */
export function sonarqubeReport(text: string, paths: ReportPaths): ReaderResult {
  let response: unknown
  try {
    response = JSON.parse(text)
  } catch {
    response = undefined
  }
  if (!isPlainObject(response) || !Array.isArray(response.issues)) {
    return {
      problems: ['not-the-format'],
      skipped: 0,
      unreadable: 0,
      issues: [],
    }
  }
  const notRead = Math.max(response.issues.length - MAX_RESULTS, 0)
  const lists: Lists = {
    paths: listOf(response.components, 'key', 'path', path => path),
    rules: listOf(response.rules, 'key', 'name', name => cutRead(name, READ_RULE_TEXT)),
  }
  const issues: ScannerIssue[] = []
  let skipped = 0
  let unreadable = 0
  for (const entry of notRead > 0
    ? response.issues.slice(0, MAX_RESULTS)
    : response.issues) {
    const read = issueOf(entry, lists, paths)
    if (read === 'skipped') skipped += 1
    else if (read === 'unreadable') unreadable += 1
    else issues.push(read)
  }
  const total = countOf(response.total) ?? countOf(isPlainObject(response.paging)
    ? response.paging.total
    : undefined)
  const truncated = total !== undefined && total > response.issues.length
  return {
    scanner: SCANNER,
    problems: problemsOf(truncated, notRead > 0),
    ...(truncated
      ? { total }
      : {}),
    skipped,
    unreadable,
    ...(notRead === 0
      ? {}
      : { notRead }),
    issues,
  }
}
