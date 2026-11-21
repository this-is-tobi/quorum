/** Test helper for the CLI: the I/O of a run, with its output kept in memory. */

import type { CliIO } from '../cli/io.ts'
import type { Clock } from '../core/clock.ts'
import type { GitSeam } from '../sources/read.ts'
import type { FakeTerminal } from './terminal.ts'

/**
 * The I/O of one `runCli` call: `argv`, a working directory (the process's by default), an environment
 * (empty by default), `stdin` as one chunk (none by default, and a terminal when `isTTY`), a `stdout` that is
 * a terminal when `stdoutIsTTY` and a pipe otherwise, and the `signal` it is given, and the `git` seam and
 * `platform` of its git sources, which a run takes from the process when a spec gives none, the `clock` of its view and the
 * `exitHooks` it adds its restorer to. What the run writes is read back with `stdout()` and `stderr()`; `onStderr` is called
 * with each text written to stderr, as the run writes it. With a `terminal`, stderr is that terminal, with its size and its
 * resize event, and stdout writes to it too when `stdoutIsTTY`, as one terminal does for both; `stderr()` and `stdout()` still
 * read back what each was given. With `drain`, the `done` of a stderr write that asks to be told is handed to it, to call when the
 * write is to count as drained, in place of being called as the write is made.
 */
export function harness(options: { argv?: string[], cwd?: string, stdin?: string, isTTY?: boolean, stdoutIsTTY?: boolean, env?: Record<string, string>, signal?: AbortSignal, git?: GitSeam, platform?: NodeJS.Platform, clock?: Clock, exitHooks?: Set<() => void>, terminal?: FakeTerminal, onStderr?: (text: string) => void, drain?: (done: () => void) => void } = {}): { io: CliIO, stdout: () => string, stderr: () => string } {
  const { terminal } = options
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
      write: (text) => {
        out.push(text)
        if (options.stdoutIsTTY === true) terminal?.stream.write(text)
      },
      isTTY: options.stdoutIsTTY,
    },
    stderr: {
      write: (text, done) => {
        err.push(text)
        options.onStderr?.(text)
        const { drain } = options
        const told = done === undefined || drain === undefined
          ? done
          : () => drain(done)
        if (terminal === undefined) {
          told?.()
          return true
        }
        return terminal.stream.write(text, told)
      },
      isTTY: terminal?.stream.isTTY,
      get columns() {
        return terminal?.stream.columns
      },
      get rows() {
        return terminal?.stream.rows
      },
      on: terminal?.stream.on,
      off: terminal?.stream.off,
    },
    signal: options.signal,
    git: options.git,
    platform: options.platform,
    clock: options.clock,
    exitHooks: options.exitHooks,
  }
  return {
    io,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}
