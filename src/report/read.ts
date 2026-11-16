import { ConfigError, issuePath } from '../core/errors.ts'
import { publicViewSchema, resultSchema } from '../core/result-schema.ts'
import { ownData } from '../core/stages/context.ts'
import { utf8Length } from '../core/tokens.ts'
import type { PublicView, QuorumResult } from '../core/types.ts'
import { VERSION } from '../core/version.ts'

/** The most text `readResult` takes, in bytes of UTF-8: 256 MiB, which holds every result a review of the largest diff quorum reads can write, and stays under the longest string the engine makes. */
export const MAX_RESULT_BYTES = 256 * 1024 * 1024

/** A refusal of the reader: its message names what is wrong in this code's words, never the input. */
function refusal(message: string): ConfigError {
  return new ConfigError([
    { path: '', message },
  ])
}

/**
 * The result, or the public view, that `text` holds, as a saved file or a pipe carries it. The text is untrusted,
 * so it is checked in this order, and the first check that fails refuses it with a `ConfigError` at the empty
 * path, in words that hold no value, no text and no key but a code word of the input: its size, measured in
 * bytes of UTF-8 (`MAX_RESULT_BYTES`), then `JSON.parse`, then `meta.version` as own data against this
 * release's (a result of another release is refused as such, before its shape is read), then the strict schema of the view when `meta.view` is `public` and of the
 * full result otherwise (`resultSchema`, `publicViewSchema`), which names the first issue's path with every key
 * that is no code word written `*`. Nothing is run and nothing is read but `text`.
 *
 * @throws ConfigError when the text is over the cap, is no JSON, was written by another release, or is no
 * result or public view that quorum writes
 *
 * @example
 * const result = readResult(await readFile('result.json', 'utf8'))
 */
export function readResult(text: string): QuorumResult | PublicView {
  return readResultWith(text, MAX_RESULT_BYTES)
}

/** `readResult` with the cap `maxBytes`, for the specs. */
export function readResultWith(text: string, maxBytes: number): QuorumResult | PublicView {
  if (utf8Length(text) > maxBytes) throw refusal('the result is over 256 MiB, the most quorum reads')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw refusal('the result is not JSON')
  }
  const meta = ownData(parsed, 'meta')
  const version = ownData(meta, 'version')
  if (typeof version === 'string' && version !== VERSION) throw refusal('the result was written by another release of quorum: render it with the release that wrote it')
  const read = ownData(meta, 'view') === 'public'
    ? publicViewSchema.safeParse(parsed)
    : resultSchema.safeParse(parsed)
  if (read.success) return read.data
  const path = read.error.issues[0]?.path ?? []
  throw refusal(path.length === 0
    ? 'the result is not one quorum writes'
    : `the result is not one quorum writes, at ${issuePath(path)}`)
}
