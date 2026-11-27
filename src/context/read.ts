import type { Env } from '../config/env.ts'
import type { RepositoryEntry } from '../config/profiles.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { documentCommit, quotedPath } from '../core/documents.ts'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { MAX_REPORTS } from '../core/reports.ts'
import type { ReviewContext, ReviewSource } from '../core/types.ts'
import type { Repository } from '../git/run.ts'
import { openSourceRepository } from '../sources/repository.ts'
import type { GitSeam } from '../sources/read.ts'
import { readRepositoryDocuments } from './documents.ts'
import { isScanRoot, reportPathsOf } from './paths.ts'
import { readReports, reportRequestIssues } from './reports.ts'
import type { ReportRequest } from './reports.ts'

/** What `readContext` reads from the machine: the review's source, which names the commit the documents are read at, the working directory and the environment, the platform (the layer reads no `process`), an abort signal and the git to run, as `SourceContext` names them. */
export interface ContextOptions {
  readonly source: ReviewSource
  readonly cwd: string
  readonly env: Env
  readonly platform: NodeJS.Platform
  readonly signal?: AbortSignal
  readonly git?: GitSeam
  /** The scanner reports to read, at most 16: each names its format, its file and the profile it feeds (`ReportRequest`). */
  readonly reports?: readonly ReportRequest[]
  /** The absolute directory the scanners ran in, with no empty, `.` or `..` segment: the root their reports' absolute paths are read from. The repository's top level when unset, and none for a diff source. */
  readonly scanRoot?: string
}

const NO_SOURCE_COMMIT = 'needs a commit to read it from, which a diff file or standard input does not name: review with --range, --local, --staged or --path, or name the file with { file }'
const NO_COMMIT_YET = 'needs a commit to read it from, and the repository has none yet: make a first commit, or name the file with { file }'

/** The flag the CLI names the source by, which an issue of the repository's opening names: `--range`, `--local`, `--staged` and `--path`. */
function flagOf(source: ReviewSource): string {
  return source.kind === 'paths'
    ? '--path'
    : `--${source.kind}`
}

/** The commit the documents of `entries` are read at, or undefined when there is no entry to read. A source that names none refuses every entry, at its own path, before any git runs for it. */
function commitOf(entries: ReadonlyArray<{ readonly entry: RepositoryEntry }>, source: ReviewSource): string | undefined {
  if (entries.length === 0) return undefined
  const commit = documentCommit(source)
  if (typeof commit === 'string') return commit
  const words = commit === undefined
    ? NO_SOURCE_COMMIT
    : NO_COMMIT_YET
  throw new ConfigError(entries.map(({ entry }) => ({ path: entry.at, message: `${quotedPath(entry.path)} ${words}` })))
}

/** The problems of the reports a caller asks `readContext` to read, before any is read and before any git runs: the config's (`reportRequestIssues`), more than 16 reports, and a scan root that is no absolute directory. */
function reportIssues(config: ResolvedConfig, options: ContextOptions, requests: readonly ReportRequest[]): ConfigIssue[] {
  return [
    ...requests.length > MAX_REPORTS
      ? [
          { path: 'reports', message: `takes at most ${MAX_REPORTS} reports in all` },
        ]
      : reportRequestIssues(config, requests),
    ...options.scanRoot === undefined || isScanRoot(options.scanRoot)
      ? []
      : [
          { path: 'scanRoot', message: 'must be an absolute directory' },
        ],
  ]
}

/**
 * The context of a review that reads files besides its diff: the repository documents of every profile of `config`, and the scanner
 * reports `options.reports` names.
 *
 * The `{ repository }` entries of the profiles are read from the commit `options.source` names, never from the working tree or the
 * change under review (see `readRepositoryDocuments`). A range's documents come from its base, a path review's from its commit, local
 * and staged changes' from HEAD; a diff file or standard input names no commit, and local changes before a first commit have none,
 * so each entry is refused, at its own path, before any git runs for it. A config with no entry reads nothing: a profile of a
 * hand-built config with no `repository` field has no entry.
 *
 * The reports are read as data, each by the reader of its format and for the profile it names (`readReports`), with the scan root's
 * place below the repository's top level: `options.scanRoot`, else the top level, which is none for a diff source (`reportPathsOf`).
 * A report that names a profile that does not run, or none while several run, more than 16 reports and a scan root that is no
 * absolute directory are refused first, before any git. A report's file that is missing, a link, no regular file, over 16 MiB, no
 * text or in no known format is no refusal: it is a report with its problem, which the review turns into a gap of its profile.
 *
 * The repository is opened once, as the source's flag opens it, when a document is read or a report is named under a git source (a
 * report needs the top level, for the root and for the root's place below it), and every document is read in one listing and one read
 * of the blobs. A config with no entry and no report runs no git: the context is `{}`. The result is what `review` and `estimate`
 * take as their `context`, and is checked there against the same commit.
 *
 * @throws ConfigError with an issue at each entry that is refused, at `--sarif` or `--sonarqube` for a report that names no profile
 * that runs, at `reports` or `scanRoot`, or at the source's flag when the repository cannot be opened
 * @throws GitError when git cannot list the tree or read the blobs
 */
export async function readContext(config: ResolvedConfig, options: ContextOptions): Promise<ReviewContext> {
  const requests = options.reports ?? []
  const refused = reportIssues(config, options, requests)
  if (refused.length > 0) throw new ConfigError(refused)
  // A config a program built by hand may leave out a profile's `repository`: it lists no entry, and is no `TypeError`.
  const entries = config.profiles.flatMap(profile => ((profile as { readonly repository?: readonly RepositoryEntry[] }).repository ?? []).map(entry => ({ profile, entry })))
  const commit = commitOf(entries, options.source)
  let opened: Promise<Repository> | undefined
  const repository = (): Promise<Repository> => opened ??= openSourceRepository({
    cwd: options.cwd,
    env: options.env,
    platform: options.platform,
    signal: options.signal,
    git: options.git,
  }, flagOf(options.source))
  const documents = commit === undefined
    ? undefined
    : await readRepositoryDocuments(entries, await repository(), commit)
  const reports = requests.length === 0
    ? undefined
    : await readReports(requests, {
        cwd: options.cwd,
        paths: reportPathsOf(options.scanRoot, options.source.kind === 'diff'
          ? undefined
          : (await repository()).top),
        profiles: config.profiles.map(({ profile }) => profile.id),
      })
  return {
    ...documents === undefined
      ? {}
      : { documents },
    ...reports === undefined
      ? {}
      : { reports },
  }
}
