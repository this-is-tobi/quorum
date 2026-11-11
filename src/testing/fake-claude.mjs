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
 */

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const SYSTEM_PROMPT_FLAG = '--system-prompt-file='
const HANG_INTERVAL_MS = 60_000

// Before anything else, so a SIGTERM sent the moment the record exists is already ignored.
if (process.env.FAKE_CLAUDE_IGNORE_TERM === '1') process.on('SIGTERM', () => {})

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)

const argv = process.argv.slice(2)
const record = process.env.FAKE_CLAUDE_RECORD
if (record !== undefined) {
  const systemFile = argv.find(argument => argument.startsWith(SYSTEM_PROMPT_FLAG))?.slice(SYSTEM_PROMPT_FLAG.length)
  const contents = {
    argv,
    env: process.env,
    cwd: process.cwd(),
    cwdEntries: readdirSync(process.cwd()),
    stdin: Buffer.concat(chunks).toString('utf8'),
    systemPrompt: systemFile === undefined ? undefined : readFileSync(systemFile, 'utf8'),
    pid: process.pid,
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
