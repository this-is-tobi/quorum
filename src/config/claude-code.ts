import { accessSync, constants, statSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import type { ConfigIssue } from '../core/errors.ts'
import { commandProblem } from '../providers/claude-code.ts'
import { envValue } from './env.ts'
import type { Env } from './env.ts'
import { own } from './profiles.ts'
import { configPath } from './schema.ts'
import type { ProviderSettings } from './schema.ts'

/**
 * Where the `claude` executable of a `claude-code` provider is found. In CI the working directory is the pull
 * request's checkout, so a relative `PATH` entry (an empty one, `.` or `bin`) would run a `claude` that the
 * pull request planted: only the absolute entries are searched, and a command that is neither an absolute path
 * nor a bare name is refused before it gets here (`commandProblem`).
 */

/** The issue of a provider whose command is neither set nor on `PATH`. */
export const CLAUDE_NOT_FOUND = 'claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND'
const COMMAND_VARIABLE = 'QUORUM_CLAUDE_CODE_COMMAND'
const NO_EXECUTABLE = 'names no executable file'
const DEFAULT_COMMAND = 'claude'

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
  const name = platform === 'win32' ? Object.keys(env).find(key => key.toUpperCase() === 'PATH') : 'PATH'
  return name === undefined ? undefined : envValue(env, name)
}

/**
 * The executable `command` names: an absolute path as it is, a bare name in the first absolute entry of the
 * environment's `PATH` that holds it (`;` separates the entries on Windows, `:` elsewhere, and a name with no
 * extension is looked up as `<name>.exe` there). A match is a regular file the process may run; any file
 * system error is no match. Never reads a relative entry, and never a variable the environment only inherits.
 */
export function findCommand(command: string, env: Env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (isAbsolute(command)) return isExecutableFile(command, platform) ? command : undefined
  const file = platform === 'win32' && extname(command) === '' ? `${command}.exe` : command
  const entries = (searchPath(env, platform) ?? '').split(platform === 'win32' ? ';' : ':').filter(entry => isAbsolute(entry))
  return entries.map(entry => join(entry, file)).find(candidate => isExecutableFile(candidate, platform))
}

/** What a provider's command comes to: the executable it runs, or the issues that say why there is none. */
interface CommandLookup {
  readonly command?: string
  readonly issues: readonly ConfigIssue[]
}

/**
 * The command of a `claude-code` provider in use: `variable` (`QUORUM_CLAUDE_CODE_COMMAND`, already checked),
 * else the settings' own `command`, else `claude`, the environment over the file as every layer is. A settings'
 * command that `commandProblem` refuses is left to the adapter, which names it at its field. Any other is
 * looked up, and one that is not found is an issue at where it came from. No issue repeats a command.
 */
export function claudeCodeCommand(name: string, settings: ProviderSettings, variable: string | undefined, env: Env): CommandLookup {
  const named = own(settings, 'command')
  if (variable === undefined && named !== undefined && commandProblem(named) !== undefined) return { issues: [] }
  const found = findCommand(variable ?? named ?? DEFAULT_COMMAND, env)
  if (found !== undefined) return { command: found, issues: [] }
  if (variable !== undefined) return { issues: [{ path: COMMAND_VARIABLE, message: NO_EXECUTABLE }] }
  if (named !== undefined) return { issues: [{ path: configPath(['providers', name, 'command']), message: NO_EXECUTABLE }] }
  return { issues: [{ path: configPath(['providers', name]), message: CLAUDE_NOT_FOUND }] }
}

/**
 * The warning of a provider that runs under `inherit` (or sets no `auth`) while `ANTHROPIC_API_KEY` is set:
 * headless Claude Code bills that key rather than the login. Never prints the key.
 */
export function billingWarnings(name: string, settings: ProviderSettings, env: Env): string[] {
  const auth = own(settings, 'auth')
  if ((auth !== undefined && auth !== 'inherit') || envValue(env, 'ANTHROPIC_API_KEY') === undefined) return []
  return [`${configPath(['providers', name])}: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key`]
}
