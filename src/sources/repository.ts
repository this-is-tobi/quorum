import { findExecutable } from '../config/command.ts'
import { ConfigError } from '../core/errors.ts'
import { openRepository } from '../git/run.ts'
import type { Repository } from '../git/run.ts'
import type { SourceContext } from './read.ts'

/**
 * Opens the repository the working directory is in, for the source `flag` names. Every git source starts
 * here: on Windows it refuses before anything is spawned, it finds git on the environment's absolute
 * `PATH` entries unless `context.git` names the executable, and `openRepository` checks the version and
 * the work tree. Each refusal is a `ConfigError` at `flag`.
 */
export async function openSourceRepository(context: SourceContext, flag: string): Promise<Repository> {
  const refusal = (message: string): ConfigError => new ConfigError([
    { path: flag, message },
  ])
  if (context.platform === 'win32') throw refusal('the git sources run on Linux and macOS: on Windows, pipe a diff in')
  const git = context.git?.executable ?? findExecutable('git', context.env, context.platform)
  if (git === undefined) throw refusal('needs git 2.41 or later on PATH, and none was found: install it, or pipe a diff in')
  return openRepository({
    git,
    cwd: context.cwd,
    env: context.env,
    flag,
    signal: context.signal,
    spawn: context.git?.spawn,
    clock: context.git?.clock,
  })
}
