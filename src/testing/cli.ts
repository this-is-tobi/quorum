/** Test helper for the CLI: the I/O of a run, with its output kept in memory. */

import type { CliIO } from '../cli/io.ts'

/**
 * The I/O of one `runCli` call: `argv`, a working directory (the process's by default), an environment
 * (empty by default), `stdin` as one chunk (none by default, and a terminal when `isTTY`), and the
 * `signal` it is given. What the run writes is read back with `stdout()` and `stderr()`; `onStderr` is
 * called with each text written to stderr, as the run writes it.
 */
export function harness(options: { argv?: string[], cwd?: string, stdin?: string, isTTY?: boolean, env?: Record<string, string>, signal?: AbortSignal, onStderr?: (text: string) => void } = {}): { io: CliIO, stdout: () => string, stderr: () => string } {
  const out: string[] = []
  const err: string[] = []
  async function* chunks(): AsyncGenerator<string> {
    if (options.stdin !== undefined) yield options.stdin
  }
  const io: CliIO = {
    argv: options.argv ?? [],
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? {},
    stdin: Object.assign(chunks(), { isTTY: options.isTTY ?? false }),
    stdout: {
      write: text => out.push(text),
    },
    stderr: {
      write: (text) => {
        err.push(text)
        options.onStderr?.(text)
      },
    },
    signal: options.signal,
  }
  return {
    io,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}
