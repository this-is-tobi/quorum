import type { Env } from '../config/env.ts'
import type { Clock } from '../core/clock.ts'
import { ConfigError } from '../core/errors.ts'
import type { LeftOutFile, ReviewSource } from '../core/types.ts'
import type { SpawnGit } from '../git/run.ts'
import { diffSource } from './diff.ts'
import { localSource } from './local.ts'
import { pathsSource } from './paths.ts'
import { rangeSource } from './range.ts'

/**
 * What a review reads its diff from: `diff`, the text of a diff file or of standard input; `range`, the
 * commits `<base>...<head>` as the user wrote them; `local`, what `git add -A` would commit (staged, unstaged
 * and untracked); `staged`, what the next commit holds; or `paths`, the files under `paths` at the commit
 * `at` names, HEAD when unset, as they are written in the user's working directory. `trustRepoConfig` says the
 * repository is the user's, so a filter its own config names may run. `skips` says whether a path review
 * skips what it skips by default, vendored, lockfile, minified, test and binary files, and is true when unset: a
 * path review skips a secret, by its name or by what it holds, whatever `skips` says, and only the
 * context's `send` sends one.
 */
export type SourceSpec
  = | { readonly kind: 'diff', readonly text: string }
    | { readonly kind: 'range', readonly range: string }
    | { readonly kind: 'local' | 'staged', readonly trustRepoConfig?: boolean }
    | { readonly kind: 'paths', readonly paths: readonly string[], readonly at?: string, readonly skips?: boolean }

/** The executable and the spawn of git, which a spec replaces: an absolute path, `spawn` and the clock a deadline runs on. */
export interface GitSeam {
  readonly executable: string
  readonly spawn: SpawnGit
  readonly clock?: Clock
}

/** What a source reads from the machine: the working directory, the environment, the platform (the layer reads no `process`), and the abort signal, `exclude` patterns and git seam of the run. */
export interface SourceContext {
  readonly cwd: string
  readonly env: Env
  readonly platform: NodeJS.Platform
  readonly signal?: AbortSignal
  /** The config's `exclude` patterns, which a source that reads files applies before it reads them. */
  readonly exclude?: readonly string[]
  /** The files the operator sends to the models though held as secrets, each a path as the diff writes it: a path review does not skip them as secrets. */
  readonly send?: readonly string[]
  /** The git to run, for a spec; git is looked up on the environment's `PATH` when unset. */
  readonly git?: GitSeam
}

/** What a source made: the diff a review reads, where it came from, and the files the source left out before it made the diff. */
export interface SourceRead {
  readonly diff: string
  readonly source: ReviewSource
  readonly leftOut: LeftOutFile[]
  /** A path review's repository, its top level as git prints it, which keys the review's default state directory. It is a path, so it reaches no result and no line: only a path source sets it. */
  readonly repository?: string
}

/**
 * Reads the diff a review is about, from the source `spec` names: a diff file's or standard input's text
 * (`diff`), the commits of a range (`range`), the local changes (`local`, `staged`) or the files at a commit
 * (`paths`). Every source answers with the diff, where it came from (`meta.source`) and the files it left
 * out. No source cuts a diff, drops a file without listing it or reads outside the repository's top level:
 * a source that cannot read what it was asked to refuses with a `ConfigError` that names its flag, or fails
 * with a `GitError`. A `kind` it does not know is a `ConfigError` too, so a caller whose spec is untyped
 * never gets `undefined`.
 *
 * @throws ConfigError for a source it refuses, as each source says, and for a `kind` that is none of the five
 * @throws GitError when a git command a source runs fails
 *
 * @see ../../docs/20-using/15-sources.md for the sources and how quorum runs git.
 */
export async function readSource(spec: SourceSpec, context: SourceContext): Promise<SourceRead> {
  switch (spec.kind) {
    case 'diff':
      return diffSource(spec.text)
    case 'range':
      return rangeSource(spec.range, context)
    case 'local':
    case 'staged':
      return localSource(spec.kind, spec.trustRepoConfig === true, context)
    case 'paths':
      return pathsSource(spec.paths, spec.at, spec.skips ?? true, context)
    default:
      // A library caller's spec is untyped: a kind it does not know fails closed, never as `undefined`.
      throw new ConfigError([
        { path: 'kind', message: 'must be diff, range, local, staged or paths' },
      ])
  }
}
