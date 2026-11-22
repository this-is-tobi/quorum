import { posix } from 'node:path'
import { MAX_DIFF_BYTES } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import { excludeMatcher } from '../core/exclude.ts'
import { credentialIn, isSecretName } from '../core/secrets.ts'
import { utf8Length } from '../core/tokens.ts'
import type { LeftOutFile } from '../core/types.ts'
import { listTree, readBlobs } from '../git/tree.ts'
import type { TreeEntry } from '../git/tree.ts'
import { addedDiff, blobText, isBinary, pathName } from './added.ts'
import type { AddedFile } from './added.ts'
import type { SourceContext, SourceRead } from './read.ts'
import { openSourceRepository } from './repository.ts'
import { isLfsPointer, isMinifiedContent, nameRule } from './skips.ts'

const FLAG = '--path'

const EMPTY_PATH = 'must name a path'
const ABSOLUTE_PATH = 'must be relative to the working directory'
const NEEDS_COMMIT = 'needs a commit, and HEAD names none: commit first, or name one with --at'
const NAMES_OVER = 'the selected files\' names are over 16 MiB: name a narrower path'
const DIFF_OVER = 'its diff is over 16 MiB, the most quorum reads: name a narrower path'

const leavesTop = (place: number): string => `path ${place} leaves the repository's top level`
const namesNothing = (place: number): string => `path ${place} names no file tracked at the commit`
const tooMany = (bytes: number): string => `the selected files hold ${bytes} bytes, over the 16 MiB (${MAX_DIFF_BYTES} bytes) a review reads: name a narrower path`
function allLeftOut(skipped: number, excluded: number, skips: boolean): string {
  return `every selected file is left out (${skipped} skipped, ${excluded} excluded): ${
    skips
      ? 'pass --no-default-skips to review the skipped ones, narrow exclude, or pass --send to send one held as a secret'
      : 'narrow exclude, pass --send to send one held as a secret, or name a path that holds files other than gitlinks, Git LFS pointers and secrets'
  }`
}

/**
 * The problem with a `--path` value that can be told from the text alone, worded to follow `--path: `: it
 * names no path when empty, and is absolute. The CLI refuses a value so before any config and any git, and
 * `pathsSource` for a library caller. A problem never repeats the value.
 */
export function pathProblem(value: string): string | undefined {
  if (value === '') return EMPTY_PATH
  return posix.isAbsolute(value)
    ? ABSOLUTE_PATH
    : undefined
}

/**
 * The problem with an `--at` value that can be told from the text alone, worded to follow `--at: `: a
 * revision that starts with `-` is an option to git, so it is refused before any git runs. The CLI refuses
 * it before any config, and `pathsSource` before it opens the repository, for a library caller. A problem
 * never repeats the value.
 */
export function atProblem(value: string | undefined): string | undefined {
  return value?.startsWith('-')
    ? 'a revision may not start with -'
    : undefined
}

function refusal(flag: string, message: string): ConfigError {
  return new ConfigError([
    { path: flag, message },
  ])
}

/** A selection: a path of the tree, or `.` for all of it, and the place, from 1, of the first `--path` that named it. */
interface Selection {
  readonly name: string
  readonly place: number
}

/**
 * The selections the `--path` values name, each once, in order. A value is taken from the working directory,
 * so `prefix`, its place under the top level, goes before it, and the result is normalized as a path of the
 * tree (`./src` and `src/` are `src`, `.` the whole tree): a value that leaves the top level is refused,
 * naming its place and never repeating it.
 */
function selectionsOf(paths: readonly string[], prefix: string): Selection[] {
  const selections = new Map<string, Selection>()
  for (const [index, value] of paths.entries()) {
    const joined = posix.normalize(`${prefix}${value}`)
    const name = joined.length > 1 && joined.endsWith('/')
      ? joined.slice(0, -1)
      : joined
    if (name === '..' || name.startsWith('../')) throw refusal(FLAG, leavesTop(index + 1))
    if (!selections.has(name)) selections.set(name, { name, place: index + 1 })
  }
  return [
    ...selections.values(),
  ]
}

/** Whether `name`, a path of the tree, is the selection or lies under it. */
function isSelected(name: string, selection: string): boolean {
  return selection === '.' || name === selection || name.startsWith(`${selection}/`)
}

/** A file of the tree and the name the diff reads it under. */
interface Candidate {
  readonly entry: TreeEntry
  readonly name: string
}

/**
 * The skip a name or a gitlink decides before any blob is read, or the exclusion that comes first: a gitlink,
 * then `exclude`, then a secret's name (the core's) unless `sent` names the file, whatever the skips, then,
 * while the skips are on, the other name rules.
 */
function leftOutBeforeReading({ entry, name }: Candidate, excluded: (path: string) => boolean, skips: boolean, sent: (path: string) => boolean): LeftOutFile | undefined {
  if (entry.type === 'commit') return { file: name, reason: 'skipped', rule: 'submodule' }
  if (excluded(name)) return { file: name, reason: 'excluded' }
  if (!sent(name) && isSecretName(name)) return { file: name, reason: 'skipped', rule: 'secret' }
  const rule = skips
    ? nameRule(name, false)
    : undefined
  return rule === undefined
    ? undefined
    : { file: name, reason: 'skipped', rule }
}

/**
 * The skip the bytes of a file decide, in this order: a Git LFS pointer always; while the skips are on, a
 * binary file; then, whatever the skips and unless `sent` names the file, one whose text holds a credential
 * (the core's `credentialIn`, of the text as the writer reads it), skipped as `secret`; and while the skips
 * are on, a minified one.
 */
function leftOutAfterReading(name: string, content: Uint8Array, skips: boolean, sent: (path: string) => boolean): LeftOutFile | undefined {
  if (isLfsPointer(content)) return { file: name, reason: 'skipped', rule: 'lfs' }
  if (skips && isBinary(content)) return { file: name, reason: 'skipped', rule: 'binary' }
  if (!sent(name) && credentialIn(blobText(content)) !== undefined) return { file: name, reason: 'skipped', rule: 'secret' }
  return skips && isMinifiedContent(name, content)
    ? { file: name, reason: 'skipped', rule: 'minified' }
    : undefined
}

/**
 * The path source: the files under one or more paths at a commit, written as an all-added diff, read from
 * the commit's tree by id and never from the working tree (uncommitted edits are `--local`'s). The tree is
 * listed once and filtered in code, so no user path reaches git: a value is checked, normalized against
 * where the working directory sits in the repository, and matched against each name as the diff reads it
 * back (`pathName`), with no pathspec magic and no link to follow. Git is handed one thing the user wrote,
 * the revision of `--at`, resolved once and then known as a full id.
 *
 * Each selected entry, in git's order, is decided in this order: a gitlink is skipped as `submodule`,
 * always; a name `exclude` matches is listed `excluded`; a name the core takes as a secret's is skipped as
 * `secret`, whatever the skips, unless the context's `send` names the file; and with the skips on a name is
 * skipped by the first other rule it fits, `vendored`, `lockfile`, `minified` or `test` (`nameRule`). The sizes of
 * what is left must then be within 16 MiB before any blob is read, and the blobs are read through one
 * `cat-file`. Once read, a Git LFS pointer is skipped as `lfs`, always; with the skips on a binary file is
 * skipped as `binary`; a file whose text holds a credential is skipped as `secret`, whatever the skips,
 * unless `send` names it; and with the skips on one whose lines are long is skipped as `minified`. With the
 * skips off a binary file is written as git's binary line, a gap of every profile. So only `send` sends a
 * secret, by its name and by its content, and `--no-default-skips` turns off the vendored, lockfile,
 * minified, test and binary rules alone. `send` holds exact paths, as the diff writes them and `leftOut` lists
 * them. A template (`.env.example`, a Helm chart's `secrets.yaml`) is no secret by name, so it is read and
 * written unless it holds a credential. Nothing is read from a `.gitattributes`: a tree can still shape a
 * file to match a rule, which is why each skip is listed in `leftOut` with its rule, and no skip is a gap.
 *
 * A `ConfigError` at `--path` or `--at` refuses a `--path` value that is empty or absolute and an `--at`
 * that starts with `-` (before any git), a `--path` that leaves the top level or names no tracked file, a
 * commit that does not exist or an unborn HEAD, a selection whose every file is left out (an empty review
 * never passes), and a selection or a diff over 16 MiB.
 *
 * @see ../../docs/20-using/15-sources.md#the-files-at-a-commit for what a path review reads and skips.
 */
export async function pathsSource(paths: readonly string[], at: string | undefined, skips: boolean, context: SourceContext): Promise<SourceRead> {
  if (paths.length === 0) throw refusal(FLAG, EMPTY_PATH)
  for (const value of paths) {
    const problem = pathProblem(value)
    if (problem !== undefined) throw refusal(FLAG, problem)
  }
  const atIssue = atProblem(at)
  if (atIssue !== undefined) throw refusal('--at', atIssue)
  const repository = await openSourceRepository(context, FLAG)
  const selections = selectionsOf(paths, repository.prefix)
  const commit = await repository.resolveCommit(at ?? 'HEAD')
  if (commit === undefined) {
    throw at === undefined
      ? refusal(FLAG, NEEDS_COMMIT)
      : refusal('--at', 'names no commit of this repository')
  }

  const matched = new Set<string>()
  const entries = await listTree(repository, commit, (path) => {
    const name = pathName(path)
    let chosen = false
    for (const { name: selection } of selections) {
      if (!isSelected(name, selection)) continue
      matched.add(selection)
      chosen = true
    }
    return chosen
  })
  if (entries === undefined) throw refusal(FLAG, NAMES_OVER)
  const unmatched = selections.find(({ name }) => !matched.has(name))
  if (unmatched !== undefined) throw refusal(FLAG, namesNothing(unmatched.place))

  const excluded = excludeMatcher(context.exclude ?? [])
  const sendNames: ReadonlySet<string> = new Set(context.send ?? [])
  const sent = (path: string): boolean => sendNames.has(path)
  const candidates: Candidate[] = entries.map(entry => ({
    entry,
    name: pathName(entry.path),
  }))
  const decided = candidates.map(candidate => leftOutBeforeReading(candidate, excluded, skips, sent))
  const toRead = candidates.filter((_, index) => decided[index] === undefined)
  const total = toRead.reduce((sum, { entry }) => sum + (entry.size ?? 0), 0)
  if (total > MAX_DIFF_BYTES) throw refusal(FLAG, tooMany(total))
  const contents = toRead.length === 0
    ? []
    : await readBlobs(repository, toRead.map(({ entry }) => entry), MAX_DIFF_BYTES)

  const files: AddedFile[] = []
  const leftOut: LeftOutFile[] = []
  let next = 0
  for (const [index, { entry, name }] of candidates.entries()) {
    const early = decided[index]
    if (early !== undefined) {
      leftOut.push(early)
      continue
    }
    const content = contents[next++]
    const late = leftOutAfterReading(name, content, skips, sent)
    if (late === undefined) files.push({ path: entry.path, mode: entry.mode, content })
    else leftOut.push(late)
  }
  if (files.length === 0) {
    const skipped = leftOut.filter(({ reason }) => reason === 'skipped').length
    throw refusal(FLAG, allLeftOut(skipped, leftOut.length - skipped, skips))
  }
  const diff = addedDiff(files)
  if (utf8Length(diff) > MAX_DIFF_BYTES) throw refusal(FLAG, DIFF_OVER)
  return {
    diff,
    source: {
      kind: 'paths',
      commit,
      paths: selections.map(({ name }) => name),
      skips,
      objectFormat: repository.objectFormat,
    },
    leftOut,
    repository: repository.top,
  }
}
