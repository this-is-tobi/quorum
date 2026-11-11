import { inertLine } from '../core/sanitize.ts'
import { errorMessage, EXIT, runCli } from './main.ts'

// Exit 3 until the run settles. A provider whose promise never settles, and holds no timer or socket,
// empties the event loop: the runtime then exits with the code it holds, which must never be 0 with no result.
process.exitCode = EXIT.runtime
let settled = false
process.once('beforeExit', () => {
  if (!settled) process.stderr.write('Error: the run stopped without a result\n')
})

runCli({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
  .then((code) => {
    settled = true
    process.exitCode = code
  })
  .catch((error: unknown) => {
    settled = true
    process.stderr.write(`${inertLine(`Error: ${errorMessage(error)}`)}\n`)
    process.exitCode = EXIT.runtime
  })
