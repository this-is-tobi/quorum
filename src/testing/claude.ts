/** Test helpers for the claude-code adapter's specs: the fake `claude` and what it recorded. */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What the fake `claude` wrote of its run. */
export interface FakeRecord {
  argv: string[]
  env: Record<string, string>
  cwd: string
  cwdEntries: string[]
  stdin: string
  /** The text of the file `--system-prompt-file=` named, or undefined when no such argument was given. */
  systemPrompt: string | undefined
  pid: number
  /** The permission bits of the run directory (the working directory's parent) and of the system text's file. */
  runMode: number
  systemMode: number | undefined
  /** Whether `CLAUDE_CODE_TMPDIR` named a directory that exists. */
  tmpExists: boolean
  /** The pid of the process `FAKE_CLAUDE_GRANDCHILD=1` started, in the fake's own process group. */
  grandchild: number | undefined
}

const FAKE_CLAUDE = fileURLToPath(new URL('fake-claude.mjs', import.meta.url))

/** `text` as one word of a shell command: in single quotes, a single quote inside them written `'\''`. */
function shellQuoted(text: string): string {
  return `'${text.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Write `<dir>/claude`, a script that runs the fake with this Node, and return its path. It names Node and
 * the fake by absolute path, so neither an execute bit in git nor `PATH` matters.
 */
export function writeFakeClaude(dir: string): string {
  const path = join(dir, 'claude')
  writeFileSync(path, `#!/bin/sh\nexec ${shellQuoted(process.execPath)} ${shellQuoted(FAKE_CLAUDE)} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

/**
 * The environment that has the fake print `stdout`: the text goes to `<dir>/<name>.out`, and the run is
 * recorded at `<dir>/<name>.record.json`. `extra` adds the variables of the run, whatever it holds.
 */
export function fakeClaudeEnv(dir: string, name: string, stdout: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const file = join(dir, `${name}.out`)
  writeFileSync(file, stdout)
  return { FAKE_CLAUDE_STDOUT: file, FAKE_CLAUDE_RECORD: join(dir, `${name}.record.json`), ...extra }
}

/** What the fake recorded of the run `name`. */
export function readFakeRecord(dir: string, name: string): FakeRecord {
  return JSON.parse(readFileSync(join(dir, `${name}.record.json`), 'utf8')) as FakeRecord
}

/** Whether a process with this pid is alive. A zombie, which an init that never reaps leaves behind, is not. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
}
