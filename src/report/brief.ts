import { inertLine } from '../core/sanitize.ts'
import type { Confidence, LeftOutFile, QuorumResult } from '../core/types.ts'
import type { Reporter } from './reporter.ts'

const LEVELS = ['high', 'medium', 'low'] as const satisfies readonly Confidence[]

/** `1 gap`, `2 gaps`: the count, then the noun in the form the count takes. */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1
    ? one
    : many}`
}

/** Whether a file was left out as a secret: held back by name or by a credential in it (`secret`, `deleted-secret`), or skipped by a path review under the rule `secret`. */
function isSecret(entry: LeftOutFile): boolean {
  return entry.reason === 'secret' || entry.reason === 'deleted-secret' || (entry.reason === 'skipped' && entry.rule === 'secret')
}

/** ` (1 high, 2 medium)`: the kept findings of each level that has some, highest first; empty when none has a level. */
function levelsOf(result: QuorumResult): string {
  const counts = LEVELS.map(level => ({ level, count: result.kept.filter(verdict => verdict.confidence === level).length }))
  const named = counts.filter(({ count }) => count > 0).map(({ level, count }) => `${count} ${level}`)
  return named.length === 0
    ? ''
    : ` (${named.join(', ')})`
}

/**
 * The review in one line, for a hook or a log: its status, the findings kept, in all and by level, the
 * unreviewed ones, the gaps, the files left out, with how many of them are secrets, the flags, and the exit
 * code, as `quorum: findings: 1 kept (1 high), 1 unreviewed, 1 gap, 1 left out (1 secret), 1 flag; exit 1`.
 * It holds only counts and words the code wrote, never a file name and never a word a model or the diff wrote,
 * and passes `inertLine` whole all the same. It never takes color.
 */
export const brief: Reporter = {
  render: (result, { outcome }) => {
    const { kept, unreviewed } = result
    const { incomplete, leftOut, flags } = result.meta
    const secrets = leftOut.filter(isSecret).length
    const left = secrets === 0
      ? ''
      : ` (${secrets} secret)`
    const line = `quorum: ${outcome.status}: ${kept.length} kept${levelsOf(result)}, ${unreviewed.length} unreviewed, ${plural(incomplete.length, 'gap')}, ${leftOut.length} left out${left}, ${plural(flags.length, 'flag')}; exit ${outcome.exitCode}`
    return `${inertLine(line)}\n`
  },
}
