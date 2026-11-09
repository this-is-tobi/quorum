import { inertLine } from '../core/sanitize.ts'
import { errorMessage, EXIT, runCli } from './main.ts'

runCli({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${inertLine(`Error: ${errorMessage(error)}`)}\n`)
    process.exitCode = EXIT.runtime
  })
