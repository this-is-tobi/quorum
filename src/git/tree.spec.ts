import { describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import { fakeGit } from '../testing/git.ts'
import type { GitBase, GitCall, GitReply } from '../testing/git.ts'
import { GitError, MAX_GIT_OUTPUT_BYTES, openRepository } from './run.ts'
import type { Repository, SpawnGit } from './run.ts'
import { listTree, readBlobs } from './tree.ts'
import type { TreeEntry } from './tree.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const COMMIT = '1'.repeat(40)

const UNREADABLE = 'git ls-tree printed an entry quorum cannot read'
const UNSIZED = 'git ls-tree could not size an object the commit names: the repository lacks it, as a partial clone does'
const NOT_RETURNED = 'git cat-file did not return each listed blob at its listed size'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** One record of `ls-tree -r -z --long`, as git pads it: the size right-aligned in 7 columns, a tab, the path, a NUL. */
function record(mode: string, type: string, id: string, size: string, path: string): string {
  return `${mode} ${type} ${id} ${size.padStart(7)}\t${path}\0`
}

/** A repository opened on a fake git, `reply` answering the calls made after it opened, and the calls it saw. */
async function open(reply: (call: GitCall) => GitReply | undefined, base?: GitBase, wrap: (spawn: SpawnGit) => SpawnGit = spawn => spawn): Promise<{ repository: Repository, calls: GitCall[] }> {
  let opened = false
  const fake = fakeGit(call => opened
    ? reply(call)
    : undefined, base)
  const repository = await openRepository({
    git: '/usr/bin/git',
    cwd: '/repo',
    env: { PATH: '/bin' },
    flag: '--path',
    spawn: wrap(fake.spawn),
  })
  opened = true
  fake.calls.splice(0)
  return { repository, calls: fake.calls }
}

/** A repository whose `ls-tree` prints `stdout`. */
function listing(stdout: GitReply['stdout'], base?: GitBase): ReturnType<typeof open> {
  return open(call => call.command[0] === 'ls-tree'
    ? { stdout }
    : undefined, base)
}

const keepAll = (): boolean => true

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => {
    throw new Error('expected a rejection')
  }, (error: unknown) => error)
}

function blob(id: string, size: number, path = 'f'): TreeEntry {
  return {
    mode: '100644',
    type: 'blob',
    id,
    size,
    path: encode(path),
  }
}

describe('listTree', () => {
  it('lists each entry of the commit in git\'s order, with its mode, type, id, size and the bytes of its path', async () => {
    const { repository, calls } = await listing([
      record('100644', 'blob', A, '12', 'a.txt'),
      record('100755', 'blob', B, '5', 'bin/run'),
      record('120000', 'blob', C, '9', 'link'),
      record('160000', 'commit', D, '-', 'sm'),
    ].join(''))

    const entries = await listTree(repository, COMMIT, keepAll)

    expect(entries?.map(entry => ({
      ...entry,
      path: decode(entry.path),
    }))).toStrictEqual([
      {
        mode: '100644',
        type: 'blob',
        id: A,
        size: 12,
        path: 'a.txt',
      },
      {
        mode: '100755',
        type: 'blob',
        id: B,
        size: 5,
        path: 'bin/run',
      },
      {
        mode: '120000',
        type: 'blob',
        id: C,
        size: 9,
        path: 'link',
      },
      {
        mode: '160000',
        type: 'commit',
        id: D,
        size: undefined,
        path: 'sm',
      },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toEqual([
      'ls-tree',
      '-r',
      '-z',
      '--long',
      '--full-tree',
      COMMIT,
    ])
  })

  it('keeps only the entries keep takes, reading the listing as it streams', async () => {
    const all = [
      record('100644', 'blob', A, '12', 'a.txt'),
      record('100644', 'blob', B, '7', 'src/b.ts'),
      record('100755', 'blob', C, '3', 'c.sh'),
    ].join('')
    // The cuts fall inside the second record's id and inside the third record's path.
    const first = all.indexOf(B) + 10
    const second = all.indexOf('c.sh') + 2
    const chunks = [
      all.slice(0, first),
      all.slice(first, second),
      all.slice(second),
    ]
    let reads = 0
    const { repository } = await open(call => call.command[0] === 'ls-tree'
      ? { stdout: chunks }
      : undefined, undefined, spawn => (file, args, options) => {
      const child = spawn(file, args, options)
      if (args.includes('ls-tree')) {
        child.stdout?.on('data', () => {
          reads += 1
        })
      }
      return child
    })
    const seen: string[] = []

    const entries = await listTree(repository, COMMIT, (path) => {
      seen.push(decode(path))
      return decode(path) !== 'a.txt'
    })

    expect(reads).toBe(3)
    expect(seen).toEqual(['a.txt', 'src/b.ts', 'c.sh'])
    expect(entries?.map(entry => decode(entry.path))).toEqual(['src/b.ts', 'c.sh'])
    expect(entries?.map(entry => entry.id)).toEqual([B, C])
  })

  it('reads a path with a tab, a line feed, a space and bytes that are not UTF-8 verbatim', async () => {
    const odd = Uint8Array.from([
      ...encode('a\tb\nc d'),
      0xFF,
      0xFE,
      0x80,
    ])
    const { repository } = await listing([
      Uint8Array.from([
        ...encode(`100644 blob ${A} ${'3'.padStart(7)}\t`),
        ...odd,
        0,
      ]),
      record('100644', 'blob', B, '1', ' lead and trail '),
    ])

    const entries = await listTree(repository, COMMIT, keepAll)

    expect(entries).toHaveLength(2)
    expect(entries?.[0].path).toEqual(odd)
    expect(decode((entries as TreeEntry[])[1].path)).toBe(' lead and trail ')
  })

  it('reads the 64-hex ids of a sha256 repository', async () => {
    const wide = 'e'.repeat(64)
    const gitlink = 'f'.repeat(64)
    const { repository } = await listing([
      record('100644', 'blob', wide, '4', 'a.txt'),
      record('160000', 'commit', gitlink, '-', 'sm'),
    ].join(''), { objectFormat: 'sha256' })

    const entries = await listTree(repository, '2'.repeat(64), keepAll)

    expect(repository.objectFormat).toBe('sha256')
    expect(entries?.map(entry => entry.id)).toEqual([wide, gitlink])

    // An id of the other format's length is no id of this repository.
    const short = await listing(record('100644', 'blob', A, '4', 'a.txt'), { objectFormat: 'sha256' })
    const error = await rejection(listTree(short.repository, '2'.repeat(64), keepAll))
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe(UNREADABLE)
  })

  it.each([
    [
      'a mode of 100664',
      record('100664', 'blob', A, '1', 'f'),
    ],
    [
      'a tree',
      record('100644', 'tree', A, '1', 'f'),
    ],
    [
      'an id of 39 hex',
      record('100644', 'blob', 'a'.repeat(39), '1', 'f'),
    ],
    [
      'an id of 64 hex in a sha1 repository',
      record('100644', 'blob', 'a'.repeat(64), '1', 'f'),
    ],
    ['a record with no tab', `100644 blob ${A} ${'1'.padStart(7)} f\0`],
    [
      'a gitlink with a size',
      record('160000', 'commit', D, '5', 'sm'),
    ],
    [
      'a blob with a dash for its size',
      record('100644', 'blob', A, '-', 'f'),
    ],
  ])('refuses %s as an entry it cannot read', async (_name, stdout) => {
    const { repository } = await listing(stdout)

    const error = await rejection(listTree(repository, COMMIT, keepAll))

    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe(UNREADABLE)
  })

  it('refuses a size git printed as BAD, which a partial clone\'s missing blob gives', async () => {
    const { repository } = await listing([
      record('100644', 'blob', A, '12', 'a.txt'),
      record('100644', 'blob', B, 'BAD', 'b.txt'),
    ].join(''))

    const error = await rejection(listTree(repository, COMMIT, path => decode(path) === 'b.txt'))

    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe(UNSIZED)
  })

  it('reads past a size git printed as BAD for an entry keep refuses, and still refuses a malformed record it refuses', async () => {
    const { repository } = await listing([
      record('100644', 'blob', A, '12', 'a.txt'),
      record('100644', 'blob', B, 'BAD', 'big.bin'),
      record('100644', 'blob', C, '3', 'c.txt'),
    ].join(''))

    const entries = await listTree(repository, COMMIT, path => decode(path) !== 'big.bin')

    expect(entries?.map(entry => decode(entry.path))).toEqual(['a.txt', 'c.txt'])
    expect(entries?.map(entry => entry.size)).toEqual([12, 3])

    const malformed = await listing([
      record('100644', 'blob', A, '12', 'a.txt'),
      record('100664', 'blob', B, 'BAD', 'big.bin'),
    ].join(''))
    const error = await rejection(listTree(malformed.repository, COMMIT, path => decode(path) !== 'big.bin'))
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe(UNREADABLE)
  })

  it('stops once the kept paths pass their cap, returning no entry', async () => {
    // 5 and 7 bytes of path pass 10: the second chunk would be refused if it were read.
    const passing = await listing([
      record('100644', 'blob', A, '1', 'a.txt') + record('100644', 'blob', B, '1', 'bin/run'),
      'not an entry\0',
    ])
    await expect(listTree(passing.repository, COMMIT, keepAll, 10)).resolves.toBeUndefined()

    // A path of exactly the cap fits, and an entry keep refuses costs nothing.
    const within = await listing(record('100644', 'blob', A, '1', 'abcde') + record('100644', 'blob', B, '1', 'skipped-name') + record('100644', 'blob', C, '1', 'fghij'))
    const entries = await listTree(within.repository, COMMIT, path => decode(path) !== 'skipped-name', 10)
    expect(entries?.map(entry => decode(entry.path))).toEqual(['abcde', 'fghij'])

    // A record that goes on past a header and the cap with no end is no entry either.
    const endless = await listing('x'.repeat(200))
    await expect(listTree(endless.repository, COMMIT, keepAll, 10)).resolves.toBeUndefined()

    // The cap is the listings' own, 16 MiB, unless a caller says.
    const long = await listing(record('100644', 'blob', A, '1', 'x'.repeat(MAX_GIT_OUTPUT_BYTES + 1)))
    await expect(listTree(long.repository, COMMIT, keepAll)).resolves.toBeUndefined()
  })

  it('fails closed when ls-tree exits with a failure, or ends inside an entry', async () => {
    const failing = await open(call => call.command[0] === 'ls-tree'
      ? { code: 128, stderr: 'fatal: not a tree object\n' }
      : undefined)
    const failure = await rejection(listTree(failing.repository, COMMIT, keepAll))
    expect(failure).toBeInstanceOf(GitError)
    expect((failure as GitError).message).toBe('git ls-tree failed (exit 128): "fatal: not a tree object"')

    const cut = await listing(record('100644', 'blob', A, '1', 'a.txt').slice(0, -1))
    const ended = await rejection(listTree(cut.repository, COMMIT, keepAll))
    expect(ended).toBeInstanceOf(GitError)
    expect((ended as GitError).message).toBe(UNREADABLE)
  })
})

describe('readBlobs', () => {
  const batch = (reply: GitReply): ReturnType<typeof open> => open(call => call.command[0] === 'cat-file'
    ? reply
    : undefined)

  it('reads the kept blobs by id through one cat-file --batch --buffer, in the entries\' order, each to its listed size', async () => {
    const { repository, calls } = await batch({ stdout: `${A} blob 3\nabc\n${B} blob 0\n\n` })

    // Three bytes in all, exactly the limit.
    const blobs = await readBlobs(repository, [
      blob(A, 3),
      blob(B, 0),
    ], 3)

    expect(blobs.map(decode)).toEqual(['abc', ''])
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toEqual(['cat-file', '--batch', '--buffer'])
    expect(calls[0].stdin).toBe(`${A}\n${B}\n`)
  })

  it('refuses blobs over its limit before git runs', async () => {
    const { repository, calls } = await batch({ stdout: '' })

    const error = await rejection(readBlobs(repository, [
      blob(A, 5),
      blob(B, 3),
    ], 7))

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).issues).toEqual([
      { path: '--path', message: 'the files to read hold 8 bytes, over the 7 a review reads' },
    ])
    expect((error as ConfigError).message).toBe('--path: the files to read hold 8 bytes, over the 7 a review reads')
    expect(calls).toHaveLength(0)
  })

  it('refuses a gitlink and an id that is no id with a RangeError, before git runs', async () => {
    const { repository, calls } = await batch({ stdout: '' })
    const gitlink: TreeEntry = {
      mode: '160000',
      type: 'commit',
      id: D,
      size: undefined,
      path: encode('sm'),
    }

    await expect(readBlobs(repository, [
      blob(A, 1),
      gitlink,
    ], 100)).rejects.toThrow(RangeError)
    await expect(readBlobs(repository, [
      blob('HEAD\n', 1),
    ], 100)).rejects.toThrow(RangeError)
    expect(calls).toHaveLength(0)
  })

  it('fails with git\'s own words when cat-file exits with a failure', async () => {
    const { repository } = await batch({ code: 128, stderr: 'fatal: bad object\n' })

    const error = await rejection(readBlobs(repository, [
      blob(A, 3),
    ], 100))

    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe('git cat-file failed (exit 128): "fatal: bad object"')
  })

  it.each([
    ['answers missing', `${A} missing\n${B} blob 0\n\n`],
    ['returns a type tree', `${A} tree 3\nabc\n${B} blob 0\n\n`],
    ['returns a size other than listed', `${A} blob 4\nabcd\n${B} blob 0\n\n`],
    ['returns an id other than asked', `${B} blob 3\nabc\n${B} blob 0\n\n`],
    ['stops short', `${A} blob 3\nabc\n${B} blob 0\n`],
    ['prints past the last blob', `${A} blob 3\nabc\n${B} blob 0\n\nextra\n`],
  ])('fails closed when cat-file %s', async (_name, stdout) => {
    const { repository } = await batch({ stdout })

    const error = await rejection(readBlobs(repository, [
      blob(A, 3),
      blob(B, 0),
    ], 100))

    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).message).toBe(NOT_RETURNED)
  })
})
