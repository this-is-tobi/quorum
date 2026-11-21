#!/usr/bin/env node
import { inertLine } from '../core/sanitize.ts'
import { errorMessage, EXIT, interruptSignal, runCli } from './main.ts'

// What puts the terminal back as the live view found it, which `runCli` adds to while a review runs: the exits it does
// not reach through its return run it, each once over, and every restorer is idempotent.
const exitHooks = new Set<() => void>()
function restoreTerminal(): void {
  for (const hook of [...exitHooks]) {
    try {
      hook()
    } catch {
      // A restorer that fails must not stop the next one, nor the line or the exit that follows.
    }
  }
}

// The first SIGINT or SIGTERM aborts the review; the second restores the terminal, says so and exits 130 at once, for a provider that ignores it.
const signal = interruptSignal(process, (code) => {
  restoreTerminal()
  process.stderr.write('interrupted\n')
  process.exit(code)
})

// An error nothing caught is a failed run, never a finding (exit 1): the terminal restored, one inert line, no stack, exit 3.
function fail(error: unknown): never {
  restoreTerminal()
  process.stderr.write(`${inertLine(`Error: ${errorMessage(error)}`)}\n`)
  process.exit(EXIT.runtime)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
// Last of all, on any way out, with writes that are synchronous on a terminal.
process.on('exit', restoreTerminal)

// Exit 3 until the run settles. A config module whose loading never finishes leaves nothing to wait
// for and empties the event loop: the runtime then exits with the code it holds, which must never be 0 with no result.
process.exitCode = EXIT.runtime
let settled = false
process.once('beforeExit', () => {
  if (settled) return
  restoreTerminal()
  if (signal.aborted) process.exitCode = EXIT.interrupted
  process.stderr.write(signal.aborted ? 'interrupted\n' : 'Error: the run stopped without a result\n')
})

// Inside the async function, so a working directory that no longer exists fails the run with exit 3.
async function main(): Promise<number> {
  return runCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signal,
    exitHooks,
  })
}

main()
  .then((code) => {
    settled = true
    process.exitCode = code
  })
  .catch((error: unknown) => {
    settled = true
    restoreTerminal()
    process.stderr.write(`${inertLine(`Error: ${errorMessage(error)}`)}\n`)
    process.exitCode = EXIT.runtime
  })
