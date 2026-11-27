import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { decode, readBounded } from '../config/load.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { isSafeSegment } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { MAX_REPORT_BYTES } from '../core/reports.ts'
import type { ReaderProblem, ScannerReport } from '../core/types.ts'
import type { ReportPaths } from './paths.ts'
import { sarifReport } from './sarif.ts'
import { sonarqubeReport } from './sonarqube.ts'

/** One scanner report a review is asked to read: the format its file is in, the file (a path, relative to the working directory or absolute) and the profile it feeds. A request that names no profile feeds the one profile that runs. */
export interface ReportRequest {
  readonly format: 'sarif' | 'sonarqube'
  readonly path: string
  readonly profile?: string
}

/** The size cap in the words the bounded reader says it in. */
const SIZE = `${MAX_REPORT_BYTES / (1024 * 1024)} MiB`

/** What a failed read of the bounded reader means for a report: the words it says, and the problem a report records for them. Any other is a file that cannot be read. */
const FILE_PROBLEMS: ReadonlyMap<string, ReaderProblem> = new Map([
  ['does not exist', 'missing'],
  ['is a symbolic link', 'not-a-file'],
  ['is not a file', 'not-a-file'],
  [`is over ${SIZE}`, 'too-large'],
])

/** What is wrong with the profile a report names, given the ids of the profiles that run: nothing, or the words of its error. */
function profileProblem(profile: string | undefined, running: readonly string[]): string | undefined {
  if (profile === undefined) {
    return running.length > 1
      ? 'must name a profile when several run'
      : undefined
  }
  if (running.includes(profile)) return undefined
  return isSafeSegment(profile)
    ? `names the profile "${profile}", which does not run`
    : 'names a profile that does not run'
}

/**
 * The configuration errors of the reports a review is asked to read, each at the flag of its format (`--sarif`, `--sonarqube`) and
 * none repeated: a report for a profile that does not run (`names the profile "<id>", which does not run`, the id left out when it is no
 * safe name to print), and a report that names no profile while several run (`must name a profile when several run`). A typo never
 * drops a report silently. The CLI runs it right after the config loads and `readContext` runs it again.
 */
export function reportRequestIssues(config: ResolvedConfig, requests: readonly ReportRequest[]): ConfigIssue[] {
  const running = config.profiles.map(({ profile }) => profile.id)
  const issues: ConfigIssue[] = []
  for (const { format, profile } of requests) {
    const path = `--${format}`
    const message = profileProblem(profile, running)
    if (message !== undefined && !issues.some(issue => issue.path === path && issue.message === message)) issues.push({ path, message })
  }
  return issues
}

/** The report of a file that gave no text: the format, the profile and the one problem, with the hash of the bytes when any were read. */
function unreadable(request: ReportRequest, profile: string, problem: ReaderProblem, sha256?: string): ScannerReport {
  return {
    format: request.format,
    profile,
    ...(sha256 === undefined
      ? {}
      : { sha256 }),
    problems: [problem],
    skipped: 0,
    unreadable: 0,
    issues: [],
  }
}

/**
 * One report: its file read through the bounded reader as a regular file, never through a link, of at most `MAX_REPORT_BYTES`, then
 * its bytes hashed and its text read by the reader of its format. A file that cannot be read is no throw: it is a report with its
 * problem, a gap of the profile it feeds, so a scan job that crashed costs its report and never the model's review.
 */
async function readReport(request: ReportRequest, options: { readonly cwd: string, readonly paths: ReportPaths, readonly profile: string }): Promise<ScannerReport> {
  const { profile } = options
  const bytes = await readBounded(resolve(options.cwd, request.path), MAX_REPORT_BYTES, SIZE, { noFollow: true })
  if ('problem' in bytes) return unreadable(request, profile, FILE_PROBLEMS.get(bytes.problem) ?? 'cannot-read')
  const sha256 = createHash('sha256').update(bytes.value).digest('hex')
  const text = decode(bytes.value)
  if ('problem' in text) return unreadable(request, profile, 'not-the-format', sha256)
  return {
    format: request.format,
    profile,
    sha256,
    ...(request.format === 'sarif'
      ? sarifReport(text.value, options.paths)
      : sonarqubeReport(text.value, options.paths)),
  }
}

/**
 * The scanner reports `requests` name, read one at a time in the order given (each file's buffer is freed before the next is read, so
 * 16 reports never hold 16 buffers at once), each for the profile it names, else for the first of `options.profiles`, the one that runs
 * when only one does. Each path is read from `options.cwd` unless it is absolute, and is opened by no other path. The issues' paths
 * follow `options.paths`. It never throws for a file: a missing one, a link, a file that is no regular file or is over 16 MiB, one that
 * is no UTF-8 text and one in no known format is a report with its problem.
 */
export async function readReports(requests: readonly ReportRequest[], options: { readonly cwd: string, readonly paths: ReportPaths, readonly profiles: readonly string[] }): Promise<ScannerReport[]> {
  const reports: ScannerReport[] = []
  for (const request of requests) {
    reports.push(await readReport(request, {
      cwd: options.cwd,
      paths: options.paths,
      profile: request.profile ?? options.profiles[0],
    }))
  }
  return reports
}
