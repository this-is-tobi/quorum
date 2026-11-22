/**
 * Where a path review keeps its answered calls when no `--state` says: a directory of its own in the user's cache,
 * keyed by the repository, so a rerun of the same command in the same repository finds what the last one paid for.
 *
 * The default applies to a path review on a terminal alone (the CLI decides: stderr a terminal and `CI` unset or
 * empty, whatever `--progress` says), because that is where a person who stopped a long run, or lost it to a
 * provider, will rerun it by hand. It is never used in CI, where each job starts clean and a cache another job can
 * write is the very thing the store's refusals guard against (a restored directory is never trusted), under
 * `quorum mcp`, where a client's cancel aborts and a rerun is the client's call, or in the bench, whose runs must
 * not depend on what an earlier one left. A diff, a range and the local changes keep nothing by default: a change is
 * small, and a path review is the one whose spend is large.
 *
 * The place follows Go's `os.UserCacheDir`: `$XDG_CACHE_HOME` when it is absolute, else `$HOME/.cache`, and on macOS
 * `$HOME/Library/Caches` whatever `XDG_CACHE_HOME` says; none when the directory would be relative, since a relative
 * one moves with the working directory. Windows has no default, since the git sources refuse it. This module reads
 * no `process`: the environment and the platform are the CLI's.
 */

import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

/** What the default's place and key come from. */
export interface DefaultStateFacts {
  /** The environment of the run: `XDG_CACHE_HOME` and `HOME`. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The platform, `process.platform`. */
  readonly platform: string
  /** The repository's top level as git prints it, which git resolves to a real path. */
  readonly repository: string
}

/** The characters of the repository's hash that name its directory. */
const KEY_LENGTH = 12

/** The user's cache directory, or undefined when the environment names no absolute one. */
function cacheDirectory({ env, platform }: DefaultStateFacts): string | undefined {
  const home = env.HOME
  const homeDirectory = home !== undefined && isAbsolute(home)
    ? home
    : undefined
  if (platform === 'darwin') {
    return homeDirectory === undefined
      ? undefined
      : join(homeDirectory, 'Library', 'Caches')
  }
  const cache = env.XDG_CACHE_HOME
  if (cache !== undefined && isAbsolute(cache)) return cache
  return homeDirectory === undefined
    ? undefined
    : join(homeDirectory, '.cache')
}

/**
 * The default state directory of the repository `facts.repository` names: `<cache>/quorum/state/<key>`, the key the
 * first 12 hex characters of the SHA-256 of the repository's top level. Undefined on Windows and when the
 * environment names no absolute cache directory.
 */
export function defaultStateDirectory(facts: DefaultStateFacts): string | undefined {
  if (facts.platform === 'win32') return undefined
  const cache = cacheDirectory(facts)
  if (cache === undefined) return undefined
  const key = createHash('sha256').update(facts.repository).digest('hex').slice(0, KEY_LENGTH)
  return join(cache, 'quorum', 'state', key)
}
