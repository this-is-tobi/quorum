import type { ConfigIssue } from '../core/errors.ts'
import { commandProblem } from '../providers/claude-code.ts'
import { findExecutable } from './command.ts'
import { CLAUDE_CODE_COMMAND, envValue } from './env.ts'
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
export const CLAUDE_NOT_FOUND = `claude CLI not found; install Claude Code or set ${CLAUDE_CODE_COMMAND}`
const NO_EXECUTABLE = 'names no executable file'
const DEFAULT_COMMAND = 'claude'

/**
 * The executable `command` names (`findExecutable`), unless the adapter refuses the command first: a relative
 * path with a separator, which would climb out of an entry, or a Windows script names no executable.
 */
export function findCommand(command: string, env: Env, platform: NodeJS.Platform = process.platform): string | undefined {
  return commandProblem(command) === undefined
    ? findExecutable(command, env, platform)
    : undefined
}

/** What a provider's command comes to: the executable it runs, or the issues that say why there is none. */
export interface CommandLookup {
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
  if (variable !== undefined) {
    return {
      issues: [
        { path: CLAUDE_CODE_COMMAND, message: NO_EXECUTABLE },
      ],
    }
  }
  if (named !== undefined) {
    return {
      issues: [
        {
          path: configPath(['providers', name, 'command']),
          message: NO_EXECUTABLE,
        },
      ],
    }
  }
  return {
    issues: [
      {
        path: configPath(['providers', name]),
        message: CLAUDE_NOT_FOUND,
      },
    ],
  }
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
