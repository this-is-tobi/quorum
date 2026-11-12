#!/usr/bin/env node
import { inertLine } from '../core/sanitize.ts'
import { errorMessage, EXIT, interruptSignal, runCli } from './main.ts'

// The first SIGINT or SIGTERM aborts the review; the second says so and exits 130 at once, for a provider that ignores it.
const signal = interruptSignal(process, (code) => {
  process.stderr.write('interrupted\n')
  process.exit(code)
})

// An error nothing caught is a failed run, never a finding (exit 1): one inert line, no stack, exit 3.
function fail(error: unknown): never {
  process.stderr.write(`${inertLine(`Error: ${errorMessage(error)}`)}\n`)
  process.exit(EXIT.runtime)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

// Exit 3 until the run settles. A provider whose promise never settles, and holds no timer or socket,
// empties the event loop: the runtime then exits with the code it holds, which must never be 0 with no result.
process.exitCode = EXIT.runtime
let settled = false
process.once('beforeExit', () => {
  if (settled) return
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
  })
}

main()
  .then((code) => {
    settled = true
    process.exitCode = code
  })
  .catch((error: unknown) => {
    settled = true
    process.stderr.write(`${inertLine(`Error: ${errorMessage(error)}`)}\n`)
    process.exitCode = EXIT.runtime
  })
