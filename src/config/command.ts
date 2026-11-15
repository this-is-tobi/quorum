import { accessSync, constants, statSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { envValue } from './env.ts'
import type { Env } from './env.ts'

/** Whether `path` names a regular file the process may run; on Windows no file has an execute bit, so a regular file is enough. Any file system error is no. */
function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The `PATH` of the environment: its own variable, in the letter case Windows gives its name, else undefined. */
function searchPath(env: Env, platform: NodeJS.Platform): string | undefined {
  const name = platform === 'win32'
    ? Object.keys(env).find(key => key.toUpperCase() === 'PATH')
    : 'PATH'
  return name === undefined
    ? undefined
    : envValue(env, name)
}

/**
 * The executable `command` names: an absolute path as it is, a bare name in the first absolute entry of the
 * environment's `PATH` that holds it (`;` separates the entries on Windows, `:` elsewhere, and a name with no
 * extension is looked up as `<name>.exe` there). A match is a regular file the process may run; any file
 * system error is no match. Never reads a relative entry, and never a variable the environment only inherits.
 * It takes the command as it is given: a caller whose command a user wrote refuses a relative path with a
 * separator, which would climb out of an entry, before it gets here (`findCommand` does).
 */
export function findExecutable(command: string, env: Env, platform: NodeJS.Platform): string | undefined {
  if (isAbsolute(command)) {
    return isExecutableFile(command, platform)
      ? command
      : undefined
  }
  const file = platform === 'win32' && extname(command) === ''
    ? `${command}.exe`
    : command
  const entries = (searchPath(env, platform) ?? '').split(platform === 'win32'
    ? ';'
    : ':').filter(entry => isAbsolute(entry))
  return entries.map(entry => join(entry, file)).find(candidate => isExecutableFile(candidate, platform))
}
