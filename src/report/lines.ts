/**
 * The pieces of a line that the text report and the progress lines of the CLI write one way: how many of a
 * thing, a file left out, and where a flag points. None makes its text inert: a file name is a diff's and a
 * flag's detail a diff's too, so the line that holds them passes through `inertLine` whole.
 */

import type { Flag, LeftOutFile } from '../core/types.ts'

/** `1 gap`, `2 gaps`: the count, then the noun in the form the count takes. */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1
    ? word
    : many}`
}

/**
 * A file the review left out as a line names it: the file as a JSON string, as a flag's is, or `<no path>` for
 * the empty name, which stands for a part of the diff no header names, then its reason in parentheses, a skipped
 * or a held file with its rule: `".env" (secret: name)`.
 */
export function leftOutEntry(entry: LeftOutFile): string {
  const file = entry.file === ''
    ? '<no path>'
    : JSON.stringify(entry.file)
  const reason = 'rule' in entry
    ? `${entry.reason}: ${entry.rule}`
    : entry.reason
  return `${file} (${reason})`
}

/** Where a flag points: the file as a JSON string, with the line when it has one, else the line alone. */
export function flagWhere({ file, line }: Flag): string {
  if (file !== undefined && line !== undefined) return ` at ${JSON.stringify(file)}:${line}`
  if (file !== undefined) return ` at ${JSON.stringify(file)}`
  if (line !== undefined) return ` at line ${line}`
  return ''
}
