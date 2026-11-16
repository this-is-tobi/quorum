import { lstat, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readBounded } from '../config/load.ts'
import { decodeDiff, MAX_DIFF_BYTES } from '../core/diff.ts'
import { ConfigError } from '../core/errors.ts'
import { excludeMatcher } from '../core/exclude.ts'
import { utf8Length } from '../core/tokens.ts'
import type { LeftOutFile } from '../core/types.ts'
import type { FilterKey } from '../git/run.ts'
import { addedDiff } from './added.ts'
import type { AddedFile, AddedMode } from './added.ts'
import type { SourceContext, SourceRead } from './read.ts'
import { openSourceRepository } from './repository.ts'

const UNTRACKED_FLAG = '--local'

const FILTER = 'the repository\'s own config names a filter program, which a working-tree diff runs: pass --trust-repo-config if the repository is yours, or review a range'
const OVER = 'its diff is over 16 MiB, the most quorum reads: review fewer changes at once'
const NOT_UTF8 = 'an untracked file\'s name is not UTF-8, which quorum cannot open: rename it, or name it in .gitignore'
const LEAVES = 'an untracked file\'s name leaves the top level'
const neither = (name: string): string => `the untracked ${JSON.stringify(name)} is neither a regular file nor a link: remove it, or name it in .gitignore`
const underLink = (name: string): string => `the untracked ${JSON.stringify(name)} lies under a symbolic link`
const unreadable = (name: string): string => `the untracked ${JSON.stringify(name)} cannot be read: check its permissions, or name it in .gitignore`
const changed = (name: string): string => `the untracked ${JSON.stringify(name)} changed while quorum read it: run quorum again`

function refusal(flag: string, message: string): ConfigError {
  return new ConfigError([
    { path: flag, message },
  ])
}

/**
 * Whether the filter keys of a repository's config are all the user's own: each key's scope is `system` or
 * `global`, the config of the machine and of the user, which run as they do with the user's own git. A key of
 * the repository (`local`), of its work tree (`worktree`), of the command line or the environment
 * (`command`), or of any scope git may add later is the repository's, whatever its value: a repository
 * someone else made can name a program there. An empty value runs nothing, but refusing it keeps the rule
 * one line.
 */
export function trustsConfig(keys: readonly FilterKey[]): boolean {
  return keys.every(({ scope }) => scope === 'system' || scope === 'global')
}

/**
 * Whether two paths are the same one: equal after Unicode normalization to NFC. Git lists a name as NFC on
 * macOS (`core.precomposeunicode`), where the file system may store it as NFD and `realpath` answers with
 * what is stored, so the two spellings of one directory must not read as two directories. A link still
 * resolves to another path, which no normalization makes equal.
 */
export function samePath(first: string, second: string): boolean {
  return first.normalize('NFC') === second.normalize('NFC')
}

/** Whether `error` says that what a path named is no longer there as it was: gone, no longer a directory, or no longer a link. */
function isChanged(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL'
}

/** Whether a failed `readBounded` says the file is no longer the regular file `lstat` saw: it is gone, is a link now, or holds more than its size. */
function vanished(read: { readonly problem: string, readonly counted?: number }): boolean {
  return read.counted !== undefined || read.problem === 'does not exist' || read.problem === 'is a symbolic link'
}

/** What a failed `lstat`, `realpath` or `readlink` of the untracked `name` says: `changed` for a path that is gone or no longer what it was, `unreadable` for a permission, `neither` for any other failure. */
function failedCall(name: string, error: unknown): string {
  if (isChanged(error)) return changed(name)
  return (error as { code?: unknown }).code === 'EACCES'
    ? unreadable(name)
    : neither(name)
}

/** What `call` resolves to, or a refusal naming `name`, as `failedCall` says. */
async function inspected<T>(name: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw refusal(UNTRACKED_FLAG, failedCall(name, error))
  }
}

/**
 * What a `readBounded` that failed on the untracked `name` says: `changed` when the file is gone, a link now
 * or larger than its size; `unreadable` when it cannot be read and is still a regular file, which is a
 * permission; `neither` for anything else, a FIFO, a socket or a device swapped in included.
 */
async function failedRead(name: string, absolute: string, read: { readonly problem: string, readonly counted?: number }): Promise<string> {
  if (vanished(read)) return changed(name)
  if (read.problem !== 'cannot be read') return neither(name)
  try {
    return (await lstat(absolute)).isFile()
      ? unreadable(name)
      : neither(name)
  } catch (error) {
    return failedCall(name, error)
  }
}

/** An untracked entry whose reading is left: its name as text, as git names it in bytes, where it is, what it is, how large `lstat` said it was and the mode it is written with. */
interface Planned {
  readonly name: string
  readonly path: Uint8Array
  readonly absolute: string
  readonly kind: 'file' | 'link' | 'gitlink'
  readonly size: number
  readonly mode: AddedMode
}

/**
 * The checks of the untracked names, each in listing order, that need no read of a file's bytes. A name is
 * refused when it is not UTF-8 (quorum opens files by their text name), holds a `..` segment or starts with
 * `/`. A name the config's `exclude` matches is listed `excluded`, and left unread and unsized. A name with a
 * trailing `/` is a nested repository, which git adds as a gitlink and quorum never enters. Any other is
 * `lstat`ed once its parent directory's real path is known to be the real top level joined with that parent
 * (`samePath`), which no link in the chain would give, and is refused unless it is a regular file or a link;
 * the sizes sum, and a sum over `budget` is refused before any file is read. An entry or a parent that is
 * gone by then is refused as changed.
 */
async function planUntracked(top: string, names: readonly Uint8Array[], excluded: (path: string) => boolean, budget: number): Promise<{ readonly planned: Planned[], readonly leftOut: LeftOutFile[] }> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const realParents = new Map<string, string>()
  let realTop: string | undefined
  let total = 0
  const planned: Planned[] = []
  const leftOut: LeftOutFile[] = []
  for (const raw of names) {
    let listed: string
    try {
      listed = decoder.decode(raw)
    } catch {
      throw refusal(UNTRACKED_FLAG, NOT_UTF8)
    }
    if (listed.startsWith('/') || listed.split('/').includes('..')) throw refusal(UNTRACKED_FLAG, LEAVES)
    const gitlink = listed.endsWith('/')
    const name = gitlink
      ? listed.slice(0, -1)
      : listed
    if (excluded(name)) {
      leftOut.push({ file: name, reason: 'excluded' })
      continue
    }
    if (gitlink) {
      planned.push({
        name,
        path: raw.subarray(0, raw.length - 1),
        absolute: '',
        kind: 'gitlink',
        size: 0,
        mode: '160000',
      })
      continue
    }

    realTop ??= await realpath(top)
    const parent = name.slice(0, Math.max(name.lastIndexOf('/'), 0))
    let realParent = realParents.get(parent)
    if (realParent === undefined) {
      realParent = await inspected(name, () => realpath(join(top, parent)))
      realParents.set(parent, realParent)
    }
    if (!samePath(realParent, join(realTop, parent))) throw refusal(UNTRACKED_FLAG, underLink(name))

    const absolute = join(top, name)
    const stats = await inspected(name, () => lstat(absolute))
    const link = stats.isSymbolicLink()
    if (!(link || stats.isFile())) throw refusal(UNTRACKED_FLAG, neither(name))
    total += stats.size
    if (total > budget) throw refusal(UNTRACKED_FLAG, OVER)
    const mode: AddedMode = link
      ? '120000'
      : (stats.mode & 0o100) === 0
          ? '100644'
          : '100755'
    planned.push({
      name,
      path: raw,
      absolute,
      kind: link ? 'link' : 'file',
      size: stats.size,
      mode,
    })
  }
  return { planned, leftOut }
}

/**
 * The files of `planned`, read in order: a link as the bytes of its target, read with `readlink` and never
 * followed; a regular file with `readBounded` without following a link, at most the size `lstat` gave it
 * (or what is left of `budget`, the whole 16 MiB less git's own diff, less what was read, when that is
 * less), so a buffer is a file's own size and a file that grew is caught; a gitlink as an empty file, which
 * the writer writes as its header and mode alone. An entry that is gone, or is no longer what it was, or has
 * outgrown its size, is refused as changed; a FIFO, a socket or a device swapped in as neither a file nor a
 * link; a file that cannot be read, for its permissions, as unreadable.
 */
async function readPlanned(planned: readonly Planned[], budget: number): Promise<AddedFile[]> {
  let left = budget
  const files: AddedFile[] = []
  for (const { name, path, absolute, kind, size, mode } of planned) {
    let content: Uint8Array = new Uint8Array(0)
    if (kind === 'link') {
      content = await inspected(name, () => readlink(absolute, { encoding: 'buffer' }))
    } else if (kind === 'file') {
      const read = await readBounded(absolute, Math.min(left, size), '16 MiB', { noFollow: true })
      if ('problem' in read) throw refusal(UNTRACKED_FLAG, await failedRead(name, absolute, read))
      content = read.value
    }
    left -= content.length
    files.push({ path, mode, content })
  }
  return files
}

/**
 * The local sources: `local`, what `git add -A` would commit (the working tree against HEAD, and the
 * untracked files), and `staged`, what the next commit holds (the index against HEAD). Both diff against
 * HEAD, or against the empty tree before a first commit, which also stands for HEAD as the attributes'
 * source, and `meta.source.head` is then null. The attributes are HEAD's, never the working tree's.
 *
 * A working-tree diff runs the clean and process filters a `filter=` attribute names, whatever the diff's
 * flags say, so a repository whose own config names one is refused before any diff, unless
 * `trustRepoConfig` says it is the user's ({@link trustsConfig}). The trust check runs for `staged` too,
 * as the flag is one for both. A `ConfigError` also refuses a diff over 16 MiB, git's own bytes, the
 * untracked files' sizes and what is written counted.
 *
 * The untracked files of `local` are read by quorum, never through git and never through a link. Git
 * lists a link as one entry and a nested repository as `name/`; a link is written as mode 120000 and its
 * target, a nested repository as a gitlink (the review lists it as a `submodule`), as `git add -A` would
 * commit them. A name that is not UTF-8, one that leaves the top level, one under a link, an entry that is
 * neither a regular file nor a link (a FIFO, a socket, a device) and a file that cannot be read are refused,
 * and so is one that is gone or has changed since the listing. An untracked file the config's `exclude` matches is listed `excluded` and
 * never read.
 *
 * @see ../../docs/20-using/15-sources.md#the-local-changes for what each source reviews.
 */
export async function localSource(kind: 'local' | 'staged', trustRepoConfig: boolean, context: SourceContext): Promise<SourceRead> {
  const flag = `--${kind}`
  const repository = await openSourceRepository(context, flag)
  if (!trustRepoConfig && !trustsConfig(await repository.filterConfig())) throw refusal(flag, FILTER)
  const head = await repository.resolveCommit('HEAD')
  const base = head ?? await repository.emptyTree()
  const bytes = kind === 'staged'
    ? await repository.diffIndex(base, base)
    : await repository.diffWorktree(base, base)
  const tracked = bytes === undefined
    ? undefined
    : await decodeDiff([bytes])
  if (bytes === undefined || tracked === undefined) throw refusal(flag, OVER)

  let diff = tracked
  let leftOut: LeftOutFile[] = []
  if (kind === 'local') {
    const names = await repository.untracked()
    if (names === undefined) throw refusal(flag, OVER)
    const budget = MAX_DIFF_BYTES - bytes.length
    const plan = await planUntracked(repository.top, names, excludeMatcher(context.exclude ?? []), budget)
    diff += addedDiff(await readPlanned(plan.planned, budget))
    leftOut = plan.leftOut
  }
  if (utf8Length(diff) > MAX_DIFF_BYTES) throw refusal(flag, OVER)
  return {
    diff,
    source: { kind, head: head ?? null, objectFormat: repository.objectFormat },
    leftOut,
  }
}
