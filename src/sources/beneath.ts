/**
 * Reading an untracked file, or a link's target, beneath the top level, so that no link a process swaps into
 * a path is followed. `--local` reads each untracked file itself, and a process writing into the work tree
 * can swap a parent directory for a link between any check of that parent and the open of the file: every
 * path-based call resolves the whole path again. So the kernel checks the open itself, not a check around it.
 *
 * - **macOS** opens `join(realTop, name)` once, with `O_NOFOLLOW_ANY`, which refuses a link in any component
 *   of the path (`ELOOP`) in that one `open`. The flag goes alone: XNU refuses it beside `O_NOFOLLOW`. The
 *   reader first checks, once per run and at its first read, that the kernel honours the flag: `/var` is a
 *   link on every macOS, so opening it with the flag must fail with `ELOOP`. Linux ignores an unknown flag,
 *   and a library caller sets the platform by hand, so a Linux claimed as `darwin`, or an XNU that ignores
 *   the bit, would read through a link; any other outcome of the check makes every read `cannot be checked`.
 * - **Linux** opens the entry's parent directory as `join(realTop, parent)` with `O_DIRECTORY | O_NOFOLLOW`,
 *   then reads `/proc/self/fd/<n>`, the kernel's own record of where that handle is, which must equal that
 *   path byte for byte (`was moved` otherwise, `cannot be checked` where `/proc` shows nothing). The entry is
 *   then opened as `/proc/self/fd/<n>/<name>` with `O_NOFOLLOW`, which resolves inside the directory the handle
 *   holds, whatever becomes of its path. The handle is kept while the next name has the same parent.
 * - **Any other platform** has no reader: `beneath` answers `undefined`, and the caller refuses the file.
 *
 * What it refuses: a link in any part of the path, a directory that is not the one the top level names, a file
 * that is no regular file. Where nothing is known, it refuses: no state is read as safe.
 *
 * What remains: on macOS a link's target is read with `readlink` of its path, as XNU has no `O_NOFOLLOW_ANY`
 * for it, so a process that swaps a parent at that instant makes quorum write the target text of a link
 * outside the tree, never a file's bytes. A hard link is a regular file, to git too. A disk image or a share a
 * user mounts in the tree is no link, so neither mechanism refuses what it holds; neither does a `/proc` or a
 * bind mount an attacker with privileges set up.
 *
 * Cost per untracked file: on macOS one `open`, where an `lstat` and an `open` were, and one `open` per run for
 * the check; on Linux, per run of files that share a parent, one `open` and one `readlink`, and none per file.
 * A reader serves one call at a time.
 */
import { constants } from 'node:fs'
import { lstat, open, readlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { readHandle } from '../config/load.ts'
import type { Read } from '../config/load.ts'

/**
 * `O_NOFOLLOW_ANY`, 0x2000_0000 in macOS's `<sys/fcntl.h>` since macOS 11: an open that fails with `ELOOP`
 * when any component of the path is a link, not only the last. Node's and Bun's `fs.constants` lack it, and
 * both pass the number through to `open(2)`, as does a binary compiled by Bun. XNU refuses it beside
 * `O_NOFOLLOW` with `EINVAL`, so it is used alone.
 */
export const O_NOFOLLOW_ANY = 0x2000_0000

/** Where Linux shows what each open handle of the process is: `/proc/self/fd/<n>` is the kernel's own record of the handle's path, and a path through it resolves inside the handle's directory. */
export const PROC_FD = '/proc/self/fd'

/** A link on every macOS: opened with `O_NOFOLLOW_ANY`, it must fail with `ELOOP`. */
const PROBE = '/var'

/** A reader of the untracked files of a top level: `name` is a checked relative name of the listing, with `/` between its segments. */
export interface Beneath {
  /** The bytes of the regular file `name`, as `readHandle` reads them, or the problem. */
  readonly file: (name: string, limit: number, size: string) => Promise<Read<Uint8Array>>
  /** The bytes of the target of the link `name`, never what it names, or the problem. */
  readonly link: (name: string) => Promise<Read<Uint8Array>>
  /** Closes every handle the reader still holds. */
  readonly close: () => Promise<void>
}

/** What a failed open or `readlink` means, by its code: the runtime's own message is never kept. */
function problemOf(error: unknown): string {
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'does not exist'
  if (code === 'ELOOP') return 'is a symbolic link'
  if (code === 'EISDIR') return 'is not a file'
  return 'cannot be read'
}

/** What a failed `readlink` of a link means: the open's problems, and `is not a link` for anything that is none. */
function linkProblemOf(error: unknown): string {
  return (error as { code?: unknown }).code === 'EINVAL'
    ? 'is not a link'
    : problemOf(error)
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined)
}

/** The parent of `name` (`''` for the top level) and the name of the entry in it. */
function split(name: string): { readonly parent: string, readonly base: string } {
  const slash = name.lastIndexOf('/')
  return {
    parent: name.slice(0, Math.max(slash, 0)),
    base: name.slice(slash + 1),
  }
}

function macReader(realTop: string): Beneath {
  let honoured: Promise<boolean> | undefined
  /** Whether the kernel refuses a link with `O_NOFOLLOW_ANY`, asked once. */
  const kernelRefusesLinks = (): Promise<boolean> => {
    honoured ??= (async () => {
      let handle: FileHandle
      try {
        handle = await open(PROBE, constants.O_RDONLY | O_NOFOLLOW_ANY)
      } catch (error) {
        return (error as { code?: unknown }).code === 'ELOOP'
      }
      await closeQuietly(handle)
      return false
    })()
    return honoured
  }
  return {
    async file(name, limit, size) {
      if (!await kernelRefusesLinks()) return { problem: 'cannot be checked' }
      let handle: FileHandle
      try {
        handle = await open(join(realTop, name), constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY)
      } catch (error) {
        return {
          problem: problemOf(error),
        }
      }
      return readHandle(handle, limit, size)
    },
    async link(name) {
      if (!await kernelRefusesLinks()) return { problem: 'cannot be checked' }
      try {
        return { value: await readlink(join(realTop, name), { encoding: 'buffer' }) }
      } catch (error) {
        return {
          problem: linkProblemOf(error),
        }
      }
    },
    close: async () => undefined,
  }
}

function linuxReader(realTop: string): Beneath {
  let held: { readonly parent: string, readonly handle: FileHandle } | undefined

  const release = async (): Promise<void> => {
    const was = held
    held = undefined
    if (was !== undefined) await closeQuietly(was.handle)
  }

  /** The problem of a directory that could not be opened: a link as the last component is `ELOOP`, or `ENOTDIR` beside `O_DIRECTORY`, so an `lstat` tells a link from a file. */
  const openFailed = async (error: unknown, path: string): Promise<string> => {
    if ((error as { code?: unknown }).code === 'ENOTDIR') {
      const linked = await lstat(path).then(stats => stats.isSymbolicLink(), () => false)
      if (linked) return 'is a symbolic link'
    }
    return problemOf(error)
  }

  /** The handle of `parent`, kept for the next name that has it, once `/proc/self/fd` shows it is that directory of the real top level. */
  const directory = async (parent: string): Promise<{ readonly handle: FileHandle } | { readonly problem: string }> => {
    if (held?.parent === parent) return { handle: held.handle }
    await release()
    const expected = join(realTop, parent)
    let handle: FileHandle
    try {
      handle = await open(expected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    } catch (error) {
      return { problem: await openFailed(error, expected) }
    }
    let where: Buffer
    try {
      where = await readlink(`${PROC_FD}/${handle.fd}`, { encoding: 'buffer' })
    } catch {
      await closeQuietly(handle)
      return { problem: 'cannot be checked' }
    }
    if (!where.equals(Buffer.from(expected))) {
      await closeQuietly(handle)
      return { problem: 'was moved' }
    }
    held = { parent, handle }
    return { handle }
  }

  return {
    async file(name, limit, size) {
      const { parent, base } = split(name)
      const opened = await directory(parent)
      if ('problem' in opened) return opened
      let handle: FileHandle
      try {
        handle = await open(`${PROC_FD}/${opened.handle.fd}/${base}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      } catch (error) {
        return {
          problem: problemOf(error),
        }
      }
      return readHandle(handle, limit, size)
    },
    async link(name) {
      const { parent, base } = split(name)
      const opened = await directory(parent)
      if ('problem' in opened) return opened
      try {
        return { value: await readlink(`${PROC_FD}/${opened.handle.fd}/${base}`, { encoding: 'buffer' }) }
      } catch (error) {
        return {
          problem: linkProblemOf(error),
        }
      }
    },
    close: release,
  }
}

/**
 * The reader of the untracked files beneath `realTop`, the real path of the top level, for `platform`:
 * `darwin` and `linux` have one, as the module comment says, and any other platform has none.
 */
export function beneath(realTop: string, platform: NodeJS.Platform): Beneath | undefined {
  if (platform === 'darwin') return macReader(realTop)
  if (platform === 'linux') return linuxReader(realTop)
  return undefined
}
