/**
 * A stand-in for the `claude` CLI, for the specs of the claude-code adapter: it records how it was run and
 * replays a file as its stdout. Plain JavaScript that reads only `FAKE_CLAUDE_*` from its environment:
 *
 * - `FAKE_CLAUDE_RECORD`: the file it writes what it was run with to, as JSON (see `FakeRecord` in claude.ts)
 * - `FAKE_CLAUDE_STDOUT`: the file whose text it prints on stdout
 * - `FAKE_CLAUDE_STDERR`: the text it prints on stderr
 * - `FAKE_CLAUDE_EXIT`: its exit code, 0 by default
 * - `FAKE_CLAUDE_HANG=1`: it records, then waits until it is stopped
 * - `FAKE_CLAUDE_IGNORE_TERM=1`: it ignores SIGTERM
 * - `FAKE_CLAUDE_GRANDCHILD=1`: it starts a process that shares its stdout and stderr and lives a while, and
 *   records its pid, as a `claude` that starts a helper would; `detached` starts it in a process group of
 *   its own, out of reach of a signal sent to the fake's group
 * - `FAKE_CLAUDE_VERSION`: what `--version` prints, `2.1.311 (Claude Code)` by default
 * - `FAKE_CLAUDE_VERSION_DELAY_MS`: the milliseconds `--version` waits before it prints; a delay longer than
 *   the spec waits makes it a `--version` that never answers, until it is stopped
 *
 * Run as `claude --version` it prints the version and exits at once, whatever else is set, and records the run
 * as a line of `<FAKE_CLAUDE_RECORD>.version` (see `VersionRecord` in claude.ts), so a request's record is
 * never overwritten by the version check that precedes it.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SYSTEM_PROMPT_FLAG = '--system-prompt-file='
const HANG_INTERVAL_MS = 60_000
/** A grandchild ends by itself, so a spec that fails to stop it leaves nothing behind for long. */
const GRANDCHILD_LIFETIME_MS = 20_000
const FILE_PERMISSIONS = 0o777
const DEFAULT_VERSION = '2.1.311 (Claude Code)'

// Before anything else, so a SIGTERM sent the moment the record exists is already ignored.
if (process.env.FAKE_CLAUDE_IGNORE_TERM === '1') process.on('SIGTERM', () => {})

const argv = process.argv.slice(2)
const record = process.env.FAKE_CLAUDE_RECORD

if (argv[0] === '--version') {
  if (record !== undefined) {
    const contents = {
      argv,
      env: process.env,
      cwd: process.cwd(),
      cwdEntries: readdirSync(process.cwd()),
      pid: process.pid,
    }
    appendFileSync(`${record}.version`, `${JSON.stringify(contents)}\n`)
  }
  setTimeout(() => process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? DEFAULT_VERSION}\n`), Number(process.env.FAKE_CLAUDE_VERSION_DELAY_MS ?? 0))
} else {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)

  const grandchildMode = process.env.FAKE_CLAUDE_GRANDCHILD
  const grandchild = grandchildMode === '1' || grandchildMode === 'detached'
    ? spawn(process.execPath, ['-e', `setTimeout(() => {}, ${GRANDCHILD_LIFETIME_MS})`], {
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: grandchildMode === 'detached',
      })
    : undefined
  // Unreferenced, so the fake can exit while its grandchild still holds the pipes.
  grandchild?.unref()
  if (record !== undefined) {
    const systemFile = argv.find(argument => argument.startsWith(SYSTEM_PROMPT_FLAG))?.slice(SYSTEM_PROMPT_FLAG.length)
    const contents = {
      argv,
      env: process.env,
      cwd: process.cwd(),
      cwdEntries: readdirSync(process.cwd()),
      stdin: Buffer.concat(chunks).toString('utf8'),
      systemPrompt: systemFile === undefined
        ? undefined
        : readFileSync(systemFile, 'utf8'),
      pid: process.pid,
      runMode: statSync(dirname(process.cwd())).mode & FILE_PERMISSIONS,
      systemMode: systemFile === undefined
        ? undefined
        : statSync(systemFile).mode & FILE_PERMISSIONS,
      tmpExists: process.env.CLAUDE_CODE_TMPDIR !== undefined && existsSync(process.env.CLAUDE_CODE_TMPDIR),
      grandchild: grandchild?.pid,
    }
    // Renamed into place, so a spec that sees the file never reads half of it.
    writeFileSync(`${record}.part`, JSON.stringify(contents))
    renameSync(`${record}.part`, record)
  }

  if (process.env.FAKE_CLAUDE_HANG === '1') {
    setInterval(() => {}, HANG_INTERVAL_MS)
  } else {
    const stdout = process.env.FAKE_CLAUDE_STDOUT
    if (stdout !== undefined) process.stdout.write(readFileSync(stdout, 'utf8'))
    if (process.env.FAKE_CLAUDE_STDERR !== undefined) process.stderr.write(process.env.FAKE_CLAUDE_STDERR)
    process.exitCode = Number(process.env.FAKE_CLAUDE_EXIT ?? 0)
  }
}
