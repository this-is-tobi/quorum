import { z } from 'zod'
import { isPlainObject } from '../config/load.ts'
import { cutRead, MAX_RESULTS, MAX_RUNS, READ_COMMIT, READ_MESSAGE, READ_RULE_ID, READ_RULE_TEXT, READ_SCANNER, READ_SNIPPET } from '../core/reports.ts'
import type { IssueLevel, ReaderProblem, ScannerIssue, ScannerReport } from '../core/types.ts'
import { reportPath } from './paths.ts'
import type { ReportPaths } from './paths.ts'

/** What a reader hands over: a report, less what the caller that read the file adds. */
type ReaderResult = Omit<ScannerReport, 'format' | 'profile' | 'sha256'>

/** What a run's tool is called when its log names none. */
const UNNAMED = 'unnamed'

/** A field quorum reads for its own sake: one of the wrong type is as good as one that is absent, and never makes an entry unreadable. */
function lenient<T extends z.ZodType>(schema: T): z.ZodCatch<z.ZodOptional<T>> {
  return schema.optional().catch(undefined)
}

const NAME = lenient(z.string().min(1))
const INDEX = lenient(z.number().int().nonnegative())
const DESCRIPTION = lenient(z.object({ text: NAME }))

/** A line: a safe integer of at least 0. A location whose line is anything else cannot be placed, so its entry is unreadable. */
const LINE = z.number().int().nonnegative()

/** The fields of a rule that quorum reads. */
const RULE = z.object({
  name: NAME,
  help: DESCRIPTION,
  fullDescription: DESCRIPTION,
  shortDescription: DESCRIPTION,
  defaultConfiguration: lenient(z.object({ level: NAME })),
})

/** The fields of a result that quorum reads, but where it stands: `kind` is read strictly, and `locations` is checked as far as its first entry. */
const RESULT = z.object({
  kind: z.string().optional(),
  ruleId: NAME,
  ruleIndex: INDEX,
  rule: lenient(z.object({
    id: NAME,
    index: INDEX,
    toolComponent: lenient(z.object({ index: INDEX })),
  })),
  level: NAME,
  message: DESCRIPTION,
  suppressions: lenient(z.array(lenient(z.object({
    status: z.string().optional(),
  })))),
  locations: lenient(z.array(z.unknown())),
})

/** A result's first location: where it stands, as far as quorum reads. A malformed container or a line that is no line makes the result unreadable. */
const LOCATION = z.object({
  physicalLocation: z.object({
    artifactLocation: z.object({
      uri: z.string().optional(),
    }).optional(),
    region: z.object({
      startLine: LINE.optional(),
      snippet: DESCRIPTION,
    }).optional(),
  }).optional(),
})

/** What quorum reads of one of a result's suppressions. */
interface SuppressionRead {
  readonly status?: string
}

/** What quorum reads of a rule, its text cut once for all the issues that name it. */
interface RuleRead {
  readonly text?: string
  readonly short?: string
  readonly level?: string
}

/** The rules a component lists. */
function rulesOf(component: unknown): readonly unknown[] {
  return isPlainObject(component) && Array.isArray(component.rules)
    ? component.rules
    : []
}

/** The rule's text, its short description for a result with no message, and its default level, as a rule states them. Every field is lenient, so a rule that is an object always parses. */
function ruleRead(rule: Record<string, unknown>): RuleRead {
  const { name, help, fullDescription, shortDescription, defaultConfiguration } = RULE.parse(rule)
  const text = help?.text ?? fullDescription?.text ?? shortDescription?.text ?? name
  const short = shortDescription?.text
  return {
    ...(text === undefined
      ? {}
      : {
          text: cutRead(text, READ_RULE_TEXT),
        }),
    ...(short === undefined
      ? {}
      : {
          short: cutRead(short, READ_MESSAGE),
        }),
    ...(defaultConfiguration?.level === undefined
      ? {}
      : { level: defaultConfiguration.level }),
  }
}

/**
 * The rules of one run, as a finder of what is read of the rule a result names: the rule at `index` of the component `component`
 * names (an extension's index) when given, else of the driver; failing that, the rule of its id, the driver's before an
 * extension's. What is read of a rule is kept, so its text is cut once for all the issues that name it.
 */
function rulesOfRun(tool: Record<string, unknown>): (id: string, index: number | undefined, component: number | undefined) => RuleRead | undefined {
  const driver = rulesOf(tool.driver)
  const extensions = Array.isArray(tool.extensions)
    ? tool.extensions
    : []
  const reads = new Map<Record<string, unknown>, RuleRead>()
  let byId: Map<string, Record<string, unknown>> | undefined
  const ids = (): Map<string, Record<string, unknown>> => {
    if (byId === undefined) {
      byId = new Map()
      for (const rule of [
        ...driver,
        ...extensions.flatMap(rulesOf),
      ]) {
        if (isPlainObject(rule) && typeof rule.id === 'string' && !byId.has(rule.id)) byId.set(rule.id, rule)
      }
    }
    return byId
  }
  return (id, index, component) => {
    const listed = component === undefined
      ? driver
      : rulesOf(extensions[component])
    const indexed = index === undefined
      ? undefined
      : listed[index]
    const found = isPlainObject(indexed)
      ? indexed
      : ids().get(id)
    if (found === undefined) return undefined
    let read = reads.get(found)
    if (read === undefined) {
      read = ruleRead(found)
      reads.set(found, read)
    }
    return read
  }
}

/** A SARIF level as the core's, and any other word, or none, as unknown. */
function levelOf(level: string | undefined): IssueLevel {
  return level === 'error' || level === 'warning' || level === 'note' || level === 'none'
    ? level
    : 'unknown'
}

/** What one run of a log gives. */
interface RunRead {
  readonly scanner: string
  readonly issues: readonly ScannerIssue[]
  readonly skipped: number
  readonly unreadable: number
  readonly noResults: boolean
  readonly unsuccessful: boolean
  /** The results past `MAX_RESULTS`, which are not read. */
  readonly notRead: number
}

/**
 * Whether a result's suppressions silence it: one is an object whose `status` is `accepted` or absent. SARIF 2.1.0 sets no default for
 * a status (3.35.3 lists `accepted`, `underReview` and `rejected`; 3.27.23 says to examine a suppression), so quorum reads a suppression
 * with no status as in effect. A `rejected` or `underReview` suppression, an entry that is no object, and a `status` that is no string
 * silence nothing, so a malformed entry never hides an issue.
 */
function isSuppressed(suppressions: readonly (SuppressionRead | undefined)[] | undefined): boolean {
  return suppressions?.some(suppression => suppression !== undefined && (suppression.status === undefined || suppression.status === 'accepted')) ?? false
}

/** The issue a result is, or why it is none: a result of another kind is skipped, and one quorum cannot read is unreadable. */
function issueOf(entry: unknown, scanner: string, findRule: ReturnType<typeof rulesOfRun>, paths: ReportPaths): ScannerIssue | 'skipped' | 'unreadable' {
  const parsed = RESULT.safeParse(entry)
  if (!parsed.success) return 'unreadable'
  const result = parsed.data
  if (result.kind !== undefined && result.kind !== 'fail') return 'skipped'
  const first = result.locations?.[0]
  const location = first === undefined
    ? undefined
    : LOCATION.safeParse(first)
  if (location !== undefined && !location.success) return 'unreadable'
  const physical = location?.data.physicalLocation
  const ruleId = result.ruleId ?? result.rule?.id
  if (ruleId === undefined) return 'unreadable'
  const rule = findRule(ruleId, result.rule?.index ?? result.ruleIndex, result.rule?.toolComponent?.index)
  const message = result.message?.text ?? rule?.short
  if (message === undefined) return 'unreadable'
  const uri = physical?.artifactLocation?.uri
  const path = uri === undefined
    ? undefined
    : reportPath(uri, paths, 'uri')
  const line = physical?.region?.startLine
  const snippet = physical?.region?.snippet?.text
  return {
    ...(path === undefined
      ? {}
      : { path }),
    ...(uri !== undefined && path === undefined
      ? { unmapped: true as const }
      : {}),
    ...(line === undefined
      ? {}
      : { line }),
    scanner,
    ruleId: cutRead(ruleId, READ_RULE_ID),
    ...(rule?.text === undefined
      ? {}
      : { ruleText: rule.text }),
    message: cutRead(message, READ_MESSAGE),
    level: levelOf(result.level ?? rule?.level),
    ...(isSuppressed(result.suppressions)
      ? { suppressed: true as const }
      : {}),
    ...(snippet === undefined
      ? {}
      : {
          snippet: cutRead(snippet, READ_SNIPPET),
        }),
  }
}

/** One run of a log: its tool's name, its issues from the results it lists, and what it says of its own scanner. */
function runOf(run: unknown, paths: ReportPaths): RunRead {
  const record = isPlainObject(run)
    ? run
    : {}
  const tool = isPlainObject(record.tool)
    ? record.tool
    : {}
  const driver = isPlainObject(tool.driver)
    ? tool.driver
    : {}
  const scanner = typeof driver.name === 'string' && driver.name !== ''
    ? cutRead(driver.name, READ_SCANNER)
    : UNNAMED
  const unsuccessful = Array.isArray(record.invocations)
    && record.invocations.some(invocation => isPlainObject(invocation) && invocation.executionSuccessful === false)
  if (!Array.isArray(record.results)) {
    return {
      scanner,
      issues: [],
      skipped: 0,
      unreadable: 0,
      noResults: true,
      unsuccessful,
      notRead: 0,
    }
  }
  const notRead = Math.max(record.results.length - MAX_RESULTS, 0)
  const findRule = rulesOfRun(tool)
  const issues: ScannerIssue[] = []
  let skipped = 0
  let unreadable = 0
  for (const entry of notRead > 0
    ? record.results.slice(0, MAX_RESULTS)
    : record.results) {
    const read = issueOf(entry, scanner, findRule, paths)
    if (read === 'skipped') skipped += 1
    else if (read === 'unreadable') unreadable += 1
    else issues.push(read)
  }
  return {
    scanner,
    issues,
    skipped,
    unreadable,
    noResults: false,
    unsuccessful,
    notRead,
  }
}

/** How many results a run holds, from the length of its result list, no entry of it read: 0 for a run with no list, or that is no run. */
function resultsOf(run: unknown): number {
  return isPlainObject(run) && Array.isArray(run.results)
    ? run.results.length
    : 0
}

/** Each revision a run states, as the log writes it. */
function revisionsOf(run: unknown): string[] {
  if (!isPlainObject(run) || !Array.isArray(run.versionControlProvenance)) return []
  return run.versionControlProvenance.flatMap(provenance =>
    isPlainObject(provenance) && typeof provenance.revisionId === 'string' && provenance.revisionId !== ''
      ? [
          cutRead(provenance.revisionId, READ_COMMIT),
        ]
      : [])
}

/** The problems of a read, in the order of `ReaderProblem`. */
function problemsOf(found: Record<'noResults' | 'tooMany' | 'failed', boolean>): ReaderProblem[] {
  return [
    ...(found.noResults
      ? ['no-results' as const]
      : []),
    ...(found.tooMany
      ? ['too-many' as const]
      : []),
    ...(found.failed
      ? ['scanner-failed' as const]
      : []),
  ]
}

/**
 * The issues of a SARIF 2.1.0 log, from its text. Every result is read alone, so one that quorum cannot read is counted as
 * `unreadable` and the rest are read: a result of a kind other than `fail` is counted as `skipped`, one with no message, no rule
 * id or a line that is no safe integer of at least 0 is `unreadable`. A missing level reads as `unknown`, and each text is cut to
 * what the core keeps four times over. A run with no result list, or whose invocation did not execute successfully, is a scanner
 * that failed (`no-results` when every run holds none, else `scanner-failed`), and a log of more than 20 runs, or a run of more
 * than 25 000 results, is read to those limits (`too-many`), the results past them counted in `notRead` (every result of a run
 * past the 20th, by its list's length) and the log's runs in `runs`. It never throws: text that is no JSON, or no log, is
 * `not-the-format`. Only the location of a result's first entry is read, its path by the path rules and never opened, whatever its
 * `uriBaseId` says.
 */
export function sarifReport(text: string, paths: ReportPaths): ReaderResult {
  let log: unknown
  try {
    log = JSON.parse(text)
  } catch {
    log = undefined
  }
  if (!isPlainObject(log) || !Array.isArray(log.runs)) {
    return {
      problems: ['not-the-format'],
      skipped: 0,
      unreadable: 0,
      issues: [],
    }
  }
  const cut = log.runs.length > MAX_RUNS
  const listed = cut
    ? log.runs.slice(0, MAX_RUNS)
    : log.runs
  const runs = listed.map(run => runOf(run, paths))
  const noResults = runs.filter(run => run.noResults).length
  const commits = [
    ...new Set(listed.flatMap(revisionsOf)),
  ]
  const notRead = runs.reduce((sum, run) => sum + run.notRead, 0) + (cut
    ? log.runs.slice(MAX_RUNS).reduce((sum, run) => sum + resultsOf(run), 0)
    : 0)
  return {
    ...(runs.length === 0
      ? {}
      : { scanner: runs[0].scanner }),
    ...(commits.length === 0
      ? {}
      : { commits }),
    problems: problemsOf({
      noResults: noResults === runs.length,
      tooMany: cut || notRead > 0,
      failed: runs.some(run => run.unsuccessful) || (noResults > 0 && noResults < runs.length),
    }),
    skipped: runs.reduce((sum, run) => sum + run.skipped, 0),
    unreadable: runs.reduce((sum, run) => sum + run.unreadable, 0),
    ...(notRead === 0
      ? {}
      : { notRead }),
    ...(cut
      ? { runs: log.runs.length }
      : {}),
    issues: runs.flatMap(run => run.issues),
  }
}
