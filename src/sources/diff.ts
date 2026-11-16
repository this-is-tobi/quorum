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
 * Reads the diff from the file `file` names, resolved against `cwd`, or from `stdin` when none is named.
 * Both are read as `decodeDiff` reads them, counted in bytes: a diff past 16 MiB is refused, and reading
 * stops at the chunk that crosses the cap. A terminal with no file is refused, not waited on. Each failure
 * is a `ConfigError` with an empty path, in a text that says what failed in this code's words, never the
 * path: no file, a directory, a file that cannot be read, no diff given, a diff over the cap.
 */
export async function readDiffInput(cwd: string, file: string | undefined, stdin: AsyncIterable<Uint8Array | string> & { readonly isTTY?: boolean }): Promise<string> {
  if (!file && stdin.isTTY) throw problem('no diff given')
  let text: string | undefined
  if (file) {
    try {
      text = await decodeDiff(createReadStream(resolve(cwd, file)))
    } catch (error) {
      throw fileProblem(error)
    }
  } else {
    text = await decodeDiff(stdin)
  }
  if (text === undefined) throw problem(OVER)
  return text
}
