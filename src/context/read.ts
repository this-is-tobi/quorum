import type { Env } from '../config/env.ts'
import type { RepositoryEntry } from '../config/profiles.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { documentCommit, quotedPath } from '../core/documents.ts'
import { ConfigError } from '../core/errors.ts'
import type { ReviewContext, ReviewSource } from '../core/types.ts'
import { openSourceRepository } from '../sources/repository.ts'
import type { GitSeam } from '../sources/read.ts'
import { readRepositoryDocuments } from './documents.ts'

/** What `readContext` reads from the machine: the review's source, which names the commit the documents are read at, the working directory and the environment, the platform (the layer reads no `process`), an abort signal and the git to run, as `SourceContext` names them. */
export interface ContextOptions {
  readonly source: ReviewSource
  readonly cwd: string
  readonly env: Env
  readonly platform: NodeJS.Platform
  readonly signal?: AbortSignal
  readonly git?: GitSeam
}

const NO_SOURCE_COMMIT = 'needs a commit to read it from, which a diff file or standard input does not name: review with --range, --local, --staged or --path, or name the file with { file }'
const NO_COMMIT_YET = 'needs a commit to read it from, and the repository has none yet: make a first commit, or name the file with { file }'

/** The flag the CLI names the source by, which an issue of the repository's opening names: `--range`, `--local`, `--staged` and `--path`. */
function flagOf(source: ReviewSource): string {
  return source.kind === 'paths'
    ? '--path'
    : `--${source.kind}`
}

/**
 * The repository documents of a review: the `{ repository }` entries of every profile of `config`, read from the commit
 * `options.source` names, never from the working tree or the change under review (see `readRepositoryDocuments`). A range's
 * documents come from its base, a path review's from its commit, local and staged changes' from HEAD; a diff file or standard
 * input names no commit, and local changes before a first commit have none, so each entry is refused, at its own path, before any
 * git runs for it. A config with no entry reads nothing and runs no git: the context is `{}`, and a profile of a hand-built config
 * with no `repository` field has no entry. Otherwise the repository is opened as
 * the source's flag opens it, and every entry is read in one listing and one read of the blobs. The result is what `review` and
 * `estimate` take as their `context`, and is checked there against the same commit.
 *
 * @throws ConfigError with an issue at each entry that is refused, or at the source's flag when the repository cannot be opened
 * @throws GitError when git cannot list the tree or read the blobs
 */
export async function readContext(config: ResolvedConfig, options: ContextOptions): Promise<ReviewContext> {
  // A config a program built by hand may leave out a profile's `repository`: it lists no entry, and is no `TypeError`.
  const entries = config.profiles.flatMap(profile => ((profile as { readonly repository?: readonly RepositoryEntry[] }).repository ?? []).map(entry => ({ profile, entry })))
  if (entries.length === 0) return {}
  const commit = documentCommit(options.source)
  if (typeof commit !== 'string') {
    const message = commit === undefined
      ? NO_SOURCE_COMMIT
      : NO_COMMIT_YET
    throw new ConfigError(entries.map(({ entry }) => ({ path: entry.at, message: `${quotedPath(entry.path)} ${message}` })))
  }
  const repository = await openSourceRepository({
    cwd: options.cwd,
    env: options.env,
    platform: options.platform,
    signal: options.signal,
    git: options.git,
  }, flagOf(options.source))
  return { documents: await readRepositoryDocuments(entries, repository, commit) }
}
