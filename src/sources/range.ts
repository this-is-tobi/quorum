import { decodeDiff } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import { openSourceRepository } from './repository.ts'
import type { SourceContext, SourceRead } from './read.ts'

const FLAG = '--range'

/**
 * The two sides of a range written `<base>...<head>`, split at its first `...`, or the problem with the
 * text, worded to follow `--range: `. Each side must be non-empty, hold no `..` and not start with `-`:
 * a revision is never an option, so no side can be read as one. A problem never repeats the text.
 */
export function parseRange(range: string): { readonly base: string, readonly head: string } | string {
  if (range === '') return 'must name a range, written <base>...<head>'
  const at = range.indexOf('...')
  if (at === -1) {
    return range.includes('..')
      ? 'must be written <base>...<head>, with three dots: <base>..<head> compares the two ends, and shows what <base> gained since as removed'
      : 'must be written <base>...<head>: a single revision names no range'
  }
  const base = range.slice(0, at)
  const head = range.slice(at + 3)
  if (base === '' || head === '') return 'must name a revision on each side of ...'
  if (base.includes('..') || head.includes('..')) return 'must hold one ... between two revisions'
  if (base.startsWith('-') || head.startsWith('-')) return 'a revision may not start with -'
  return { base, head }
}

/**
 * The range source: what `<head>` changed since it left `<base>`, written `--range <base>...<head>`. Both
 * sides are resolved to full commit ids (a revision goes to git once, after `--end-of-options`, and is never
 * printed back), then the diff is the merge base of the two against the head, with the base's attributes. It
 * is git's own `<base>...<head>`, and `<base>..<head>` is refused: that form compares the two ends, so what
 * `<base>` gained since the branch left it shows up as removed lines no one on the branch wrote. A
 * `ConfigError` refuses a side that names no commit, two sides that are one commit (there is nothing to
 * review) and sides with no shared history, as a shallow clone has, and a diff over 16 MiB; a merge base
 * equal to the head is an empty diff. The diff is git's bytes read as `decodeDiff` reads them.
 */
export async function rangeSource(range: string, context: SourceContext): Promise<SourceRead> {
  const refusal = (message: string): ConfigError => new ConfigError([
    { path: FLAG, message },
  ])
  const parsed = parseRange(range)
  if (typeof parsed === 'string') throw refusal(parsed)
  const repository = await openSourceRepository(context, FLAG)
  const base = await repository.resolveCommit(parsed.base)
  if (base === undefined) throw refusal('its base names no commit of this repository: fetch it first, as actions/checkout does with fetch-depth: 0')
  const head = await repository.resolveCommit(parsed.head)
  if (head === undefined) throw refusal('its head names no commit of this repository')
  if (base === head) throw refusal('its two sides are one commit, so it names nothing to review')
  const mergeBase = await repository.mergeBase(base, head)
  if (mergeBase === undefined) throw refusal('its two sides share no history in this clone: fetch the base\'s history, as actions/checkout does with fetch-depth: 0')
  const bytes = await repository.diffCommits(mergeBase, head, base)
  const diff = bytes === undefined
    ? undefined
    : await decodeDiff([bytes])
  if (diff === undefined) throw refusal('its diff is over 16 MiB, the most quorum reads: review a shorter range')
  return {
    diff,
    source: {
      kind: 'range',
      base,
      mergeBase,
      head,
      objectFormat: repository.objectFormat,
    },
    leftOut: [],
  }
}
