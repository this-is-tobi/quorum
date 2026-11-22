import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { decodeDiff, MAX_DIFF_BYTES } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import { utf8Length } from '../core/tokens.ts'
import type { SourceRead } from './read.ts'

const OVER = 'the diff is over 16 MiB, the most quorum reads'

/** A usage error of the diff source: it names no flag, and its message holds no part of what the user typed. */
function problem(message: string): ConfigError {
  return new ConfigError([
    { path: '', message },
  ])
}

/** The diff source: a diff's text as the diff a review reads, nothing left out. A text over 16 MiB of UTF-8 is a `ConfigError`. */
export function diffSource(text: string): SourceRead {
  if (utf8Length(text) > MAX_DIFF_BYTES) throw problem(OVER)
  return {
    diff: text,
    source: { kind: 'diff' },
    leftOut: [],
  }
}

/** What went wrong reading the diff file, in words that repeat no path: the system's own message holds it. */
function fileProblem(error: unknown): ConfigError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return problem('the diff file does not exist')
    case 'EISDIR':
      return problem('the diff file is a directory')
    default:
      return problem('the diff file cannot be read')
  }
}

/**
 * What `read` settles with, or, once `signal` aborts, its reason at once, with `stream` destroyed: a stream that
 * never ends (a pipe its producer holds open) would hold the process past the first signal. The read's own later
 * settling is caught and dropped, and the listener is gone as soon as the read settles.
 */
function untilAbort<T>(stream: { readonly destroy?: () => void }, read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return read
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      stream.destroy?.()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    read.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Reads the diff from the file `file` names, resolved against `cwd`, or from `stdin` when none is named.
 * Both are read as `decodeDiff` reads them, counted in bytes: a diff past 16 MiB is refused, and reading
 * stops at the chunk that crosses the cap. A terminal with no file is refused, not waited on. Each failure
 * is a `ConfigError` with an empty path, in a text that says what failed in this code's words, never the
 * path: no file, a directory, a file that cannot be read, no diff given, a diff over the cap. When `signal`
 * aborts, a read in progress rejects at once with the signal's reason, its stream destroyed; a signal aborted
 * already rejects before any read.
 */
export async function readDiffInput(cwd: string, file: string | undefined, stdin: AsyncIterable<Uint8Array | string> & { readonly isTTY?: boolean, readonly destroy?: () => void }, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (!file && stdin.isTTY) throw problem('no diff given')
  let text: string | undefined
  if (file) {
    const stream = createReadStream(resolve(cwd, file))
    try {
      text = await untilAbort(stream, decodeDiff(stream), signal)
    } catch (error) {
      if (signal?.aborted) throw error
      throw fileProblem(error)
    }
  } else {
    text = await untilAbort(stdin, decodeDiff(stdin), signal)
  }
  if (text === undefined) throw problem(OVER)
  return text
}
