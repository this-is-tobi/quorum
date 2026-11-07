import { EXIT, runCli } from './main.ts'

runCli({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`Error: ${String(error)}\n`)
    process.exitCode = EXIT.runtime
  })
