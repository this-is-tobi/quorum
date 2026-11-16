import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { beneath } from './beneath.ts'
import type { Beneath } from './beneath.ts'

const both = process.platform === 'darwin' || process.platform === 'linux'

/** A temporary directory's real path (macOS's lies under the link `/var`), the tree under `tree`, and `outside`, whose files hold `OUTSIDE`. */
let root = ''
let tree = ''
let outside = ''
let reader: Beneath | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-beneath-')))
  tree = join(root, 'tree')
  outside = join(root, 'outside')
  mkdirSync(join(tree, 'sub'), { recursive: true })
  mkdirSync(join(tree, 'deep', 'sub'), { recursive: true })
  mkdirSync(join(outside, 'sub'), { recursive: true })
  writeFileSync(join(tree, 'sub', 'a.txt'), 'abc')
  writeFileSync(join(tree, 'deep', 'sub', 'a.txt'), 'abc')
  writeFileSync(join(outside, 'a.txt'), 'OUTSIDE')
  writeFileSync(join(outside, 'sub', 'a.txt'), 'OUTSIDE')
})

afterEach(async () => {
  await reader?.close()
  reader = undefined
  rmSync(root, { recursive: true, force: true })
})

/** The reader of the tree for the platform the suite runs on. */
function readerOfTree(): Beneath {
  reader = beneath(tree, process.platform)
  if (reader === undefined) throw new Error('no reader on this platform')
  return reader
}

/** Moves the directory `name` of the tree aside and puts a link to `outside` in its place, as a process writing into the tree could. */
function swapForLink(name: string): void {
  renameSync(join(tree, name), join(tree, `${name}.moved`))
  symlinkSync(outside, join(tree, name))
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString()

describe('the reader beneath the top level', () => {
  it.runIf(both)('reads a regular file beneath the top level, up to its limit', async () => {
    const files = readerOfTree()
    const read = await files.file('sub/a.txt', 16, '16 MiB')
    expect('value' in read
      ? text(read.value)
      : read).toBe('abc')
    expect(await files.file('sub/a.txt', 2, '16 MiB')).toEqual({ problem: 'is over 16 MiB', counted: 2 })
  })

  it.runIf(both).each([
    ['parent', 'sub', 'sub/a.txt'],
    ['grandparent', 'deep', 'deep/sub/a.txt'],
  ])('refuses a file whose %s was swapped for a link to a directory outside the top level, reading none of it', async (_which, swapped, name) => {
    const files = readerOfTree()
    swapForLink(swapped)
    const read = await files.file(name, 16, '16 MiB')
    expect('value' in read).toBe(false)
    expect(read).toMatchObject({
      problem: expect.stringMatching(/^(is a symbolic link|was moved)$/),
    })
    expect(JSON.stringify(read)).not.toContain('OUTSIDE')
  })

  it.runIf(both)('reads a second name of a parent swapped after the first, never a file outside the top level', async () => {
    writeFileSync(join(tree, 'sub', 'b.txt'), 'inside')
    writeFileSync(join(outside, 'b.txt'), 'OUTSIDE')
    const files = readerOfTree()
    const first = await files.file('sub/a.txt', 16, '16 MiB')
    expect('value' in first
      ? text(first.value)
      : first).toBe('abc')

    swapForLink('sub')
    const second = await files.file('sub/b.txt', 16, '16 MiB')
    // Linux reads through the handle it holds, the directory that was moved aside; macOS opens the path again and meets the link.
    expect('value' in second
      ? text(second.value)
      : second).toEqual(process.platform === 'linux'
      ? 'inside'
      : { problem: 'is a symbolic link' })
    expect(JSON.stringify(second)).not.toContain('OUTSIDE')
    expect(text('value' in second
      ? second.value
      : new Uint8Array())).not.toContain('OUTSIDE')
  })

  it.runIf(both)('refuses a link or a FIFO swapped in for the file', async () => {
    const files = readerOfTree()
    rmSync(join(tree, 'sub', 'a.txt'))
    symlinkSync(join(outside, 'a.txt'), join(tree, 'sub', 'a.txt'))
    expect(await files.file('sub/a.txt', 16, '16 MiB')).toEqual({ problem: 'is a symbolic link' })

    rmSync(join(tree, 'sub', 'a.txt'))
    execFileSync('mkfifo', [
      join(tree, 'sub', 'a.txt'),
    ])
    expect(await files.file('sub/a.txt', 16, '16 MiB')).toEqual({ problem: 'is not a file' })
  })

  it.runIf(both)('reads a link\'s target as bytes, never what it names', async () => {
    const files = readerOfTree()
    symlinkSync('target', join(tree, 'sub', 'l'))
    symlinkSync('../../outside/a.txt', join(tree, 'sub', 'm'))
    const dangling = await files.link('sub/l')
    const outer = await files.link('sub/m')
    expect('value' in dangling
      ? text(dangling.value)
      : dangling).toBe('target')
    expect('value' in outer
      ? text(outer.value)
      : outer).toBe('../../outside/a.txt')
    expect(await files.link('sub/a.txt')).toEqual({ problem: 'is not a link' })
    expect(await files.link('sub/gone')).toEqual({ problem: 'does not exist' })
  })

  it.runIf(process.platform === 'linux')('refuses a link whose parent directory was swapped, reading no target outside', async () => {
    const files = readerOfTree()
    symlinkSync('target', join(tree, 'sub', 'l'))
    symlinkSync('outside-target', join(outside, 'l'))
    swapForLink('sub')
    const read = await files.link('sub/l')
    expect('value' in read).toBe(false)
    expect(JSON.stringify(read)).not.toContain('outside-target')
  })

  it.runIf(process.platform === 'darwin')('reads a link\'s target by its path on macOS, so a parent swapped at that instant shows an outside link\'s target: the residual the docs state', async () => {
    const files = readerOfTree()
    symlinkSync('target', join(tree, 'sub', 'l'))
    symlinkSync('outside-target', join(outside, 'l'))
    swapForLink('sub')
    expect(readlinkSync(join(tree, 'sub', 'l'))).toBe('outside-target')
    const read = await files.link('sub/l')
    expect('value' in read
      ? text(read.value)
      : read).toBe('outside-target')
  })

  it.runIf(process.platform === 'darwin')('cannot check a directory on Linux where /proc/self/fd shows nothing', async () => {
    reader = beneath(join(root, 'tree'), 'linux')
    expect(await reader!.file('sub/a.txt', 10, '16 MiB')).toEqual({ problem: 'cannot be checked' })
  })

  it.runIf(process.platform === 'linux')('cannot check a file on macOS\'s terms where the kernel ignores O_NOFOLLOW_ANY', async () => {
    reader = beneath(join(root, 'tree'), 'darwin')
    expect(await reader!.file('sub/a.txt', 10, '16 MiB')).toEqual({ problem: 'cannot be checked' })
  })

  it('has no way to read beneath the top level on any other platform', () => {
    for (const platform of [
      'win32',
      'freebsd',
      'openbsd',
      'sunos',
      'aix',
      'android',
    ] as const) {
      expect(beneath(root, platform)).toBeUndefined()
    }
  })

  it.runIf(both)('leaves no handle open once closed, after reading files of three directories', async () => {
    for (const directory of ['one', 'two', 'three']) {
      mkdirSync(join(tree, directory))
      writeFileSync(join(tree, directory, 'a.txt'), directory)
      writeFileSync(join(tree, directory, 'b.txt'), directory)
    }
    const before = readdirSync('/dev/fd').length
    const files = readerOfTree()
    for (const name of [
      'one/a.txt',
      'one/b.txt',
      'two/a.txt',
      'three/a.txt',
      'three/b.txt',
    ]) {
      expect('value' in await files.file(name, 16, '16 MiB')).toBe(true)
    }
    await files.close()
    expect(readdirSync('/dev/fd').length).toBe(before)
  })
})
