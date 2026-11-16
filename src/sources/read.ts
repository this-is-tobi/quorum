import type { Env } from '../config/env.ts'
import type { Clock } from '../core/clock.ts'
import type { LeftOutFile, ReviewSource } from '../core/types.ts'
import type { SpawnGit } from '../git/run.ts'
import { diffSource } from './diff.ts'
import { rangeSource } from './range.ts'

/**
 * What a review reads its diff from: `diff`, the text of a diff file or of standard input, or `range`, the
 * commits `<base>...<head>` as the user wrote them. The kinds of the local changes and of the files at a
 * commit join it with their sources.
 */
export type SourceSpec
  = | { readonly kind: 'diff', readonly text: string }
    | { readonly kind: 'range', readonly range: string }

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
  /** The git to run, for a spec; git is looked up on the environment's `PATH` when unset. */
  readonly git?: GitSeam
}

/** What a source made: the diff a review reads, where it came from, and the files the source left out before it made the diff. */
export interface SourceRead {
  readonly diff: string
  readonly source: ReviewSource
  readonly leftOut: LeftOutFile[]
}

/**
 * Reads the diff a review is about, from the source `spec` names: a diff file's or standard input's text
 * (`diff`) or the commits of a range (`range`). Every source answers with the diff, where it came from
 * (`meta.source`) and the files it left out. No source cuts a diff, drops a file without listing it or
 * reads outside the repository's top level: a source that cannot read what it was asked to refuses
 * with a `ConfigError` that names its flag, or fails with a `GitError`.
 *
 * @see ../../docs/20-using/15-sources.md for the sources and how quorum runs git.
 */
export async function readSource(spec: SourceSpec, context: SourceContext): Promise<SourceRead> {
  switch (spec.kind) {
    case 'diff':
      return diffSource(spec.text)
    case 'range':
      return rangeSource(spec.range, context)
  }
}
