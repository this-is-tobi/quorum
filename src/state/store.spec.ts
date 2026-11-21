import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { StoredCall } from '../core/ports.ts'
import { openFileStore } from './store.ts'
import type { FileStore } from './store.ts'

const VERSION = '1.2.3'
const IDENTITIES = new Map([
  ['api', 'identity of api'],
  ['other', 'identity of other'],
])
const MARKER = 'quorum-state.json'
const MIB = 1024 * 1024
const REPLY: StoredCall = {
  reply: {
    text: '{"findings":[]}',
    model: 'm-1',
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
  },
}
const CUT_OFF: StoredCall = {
  lacked: {
    noAnswer: 'thinking',
    usage: { inputTokens: 7, outputTokens: 3 },
  },
}

let root = ''
let warnings: string[] = []

beforeEach(() => {
  // The real path: macOS keeps its temporary directory under a link, and the store refuses a link.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-state-')))
  warnings = []
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A file store on `directory` that Linux would accept, its warnings kept in `warnings`. */
function open(directory: string, options: Partial<Parameters<typeof openFileStore>[1]> = {}): Promise<FileStore> {
  return openFileStore(directory, {
    identities: IDENTITIES,
    version: VERSION,
    platform: 'linux',
    warn: line => warnings.push(line),
    ...options,
  })
}

/** The issues a refused directory raises, each written `path: message`. */
async function refused(directory: string, options: Partial<Parameters<typeof openFileStore>[1]> = {}): Promise<string[]> {
  try {
    await open(directory, options)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues.map(({ path, message }) => `${path}: ${message}`)
  }
  throw new Error('not refused')
}

const modeOf = (path: string): number => statSync(path).mode & 0o777
/** The name of the file that holds the entry of `key` for the provider `identity`, as the store names it. */
const entryName = (key: string, identity = IDENTITIES.get('api'), version = VERSION): string => `${createHash('sha256').update(JSON.stringify([version, identity, key])).digest('hex')}.json`
const entry = (key: string, provider = 'api'): { readonly key: string, readonly provider: string } => ({ key, provider })

describe('openFileStore', () => {
  it('makes a missing directory with mode 0700 and its marker, and an entry with mode 0600', async () => {
    const directory = join(root, 'state')
    const store = await open(directory)
    expect(modeOf(directory)).toBe(0o700)
    expect(readFileSync(join(directory, MARKER), 'utf8')).toBe('{"quorum":"state","version":1}')
    expect(modeOf(join(directory, MARKER))).toBe(0o600)
    await store.put(entry('k1'), REPLY)
    expect(readdirSync(directory).toSorted()).toEqual([
      MARKER,
      entryName('k1'),
    ].toSorted())
    expect(modeOf(join(directory, entryName('k1')))).toBe(0o600)
    // A second open of the directory the first made takes its marker, and an empty one it was given is made its own.
    await open(directory)
    mkdirSync(join(root, 'empty'), { mode: 0o700 })
    await open(join(root, 'empty'))
    expect(readdirSync(join(root, 'empty'))).toEqual([MARKER])
    expect(warnings).toEqual([])
  })

  it.each([
    [
      'is a link',
      (directory: string) => {
        mkdirSync(join(root, 'real'), { mode: 0o700 })
        symlinkSync(join(root, 'real'), directory)
      },
      () => ({}),
      '--state: is a symbolic link',
    ],
    [
      'is a file',
      (directory: string) => writeFileSync(directory, 'x'),
      () => ({}),
      '--state: is not a directory',
    ],
    [
      'is group-writable',
      (directory: string) => {
        mkdirSync(directory)
        chmodSync(directory, 0o770)
      },
      () => ({}),
      '--state: can be written by its group or by others: chmod 700 it',
    ],
    // The owner the store is told is one more than the directory's own.
    [
      'is owned by another user',
      (directory: string) => mkdirSync(directory, { mode: 0o700 }),
      () => ({ owner: statSync(root).uid + 1 }),
      '--state: is owned by another user',
    ],
    [
      'holds a foreign file',
      (directory: string) => {
        mkdirSync(directory, { mode: 0o700 })
        writeFileSync(join(directory, 'notes.txt'), 'mine')
      },
      () => ({}),
      '--state: holds files but no quorum-state.json, so it is not a state directory quorum made: name an empty or new directory',
    ],
    [
      'holds a marker quorum did not write',
      (directory: string) => {
        mkdirSync(directory, { mode: 0o700 })
        writeFileSync(join(directory, MARKER), '{"quorum":"state","version":2}')
      },
      () => ({}),
      '--state: holds a quorum-state.json quorum did not write',
    ],
    [
      'lies under a directory holding .git',
      (directory: string) => mkdirSync(join(directory, '..', '.git')),
      () => ({}),
      '--state: lies inside a git work tree, which a change could write to: name a directory outside every repository',
    ],
    // An existing directory with quorum's own marker passes every other check: only the second work-tree check refuses it.
    [
      'exists with its marker under a directory holding .git',
      (directory: string) => {
        mkdirSync(directory, { mode: 0o700 })
        writeFileSync(join(directory, MARKER), '{"quorum":"state","version":1}')
        mkdirSync(join(directory, '..', '.git'))
      },
      () => ({}),
      '--state: lies inside a git work tree, which a change could write to: name a directory outside every repository',
    ],
    [
      'exists with its marker under a directory holding the .git file of a worktree',
      (directory: string) => {
        mkdirSync(directory, { mode: 0o700 })
        writeFileSync(join(directory, MARKER), '{"quorum":"state","version":1}')
        writeFileSync(join(directory, '..', '.git'), 'gitdir: elsewhere')
      },
      () => ({}),
      '--state: lies inside a git work tree, which a change could write to: name a directory outside every repository',
    ],
  ] as const)('refuses a state directory that %s', async (_label, arrange, options, issue) => {
    const directory = join(root, 'repo', 'state')
    mkdirSync(join(root, 'repo'))
    arrange(directory)
    expect(await refused(directory, options())).toEqual([issue])
  })

  it('refuses a directory in a work tree without making it, a .git file of a worktree included, and a marker that is a link', async () => {
    mkdirSync(join(root, 'repo'))
    writeFileSync(join(root, 'repo', '.git'), 'gitdir: elsewhere')
    expect(await refused(join(root, 'repo', 'state'))).toEqual(['--state: lies inside a git work tree, which a change could write to: name a directory outside every repository'])
    expect(readdirSync(join(root, 'repo'))).toEqual(['.git'])
    // A directory whose marker is a link is not one quorum made.
    mkdirSync(join(root, 'linked'), { mode: 0o700 })
    writeFileSync(join(root, 'target'), '{"quorum":"state","version":1}')
    symlinkSync(join(root, 'target'), join(root, 'linked', MARKER))
    expect(await refused(join(root, 'linked'))).toEqual(['--state: holds a quorum-state.json quorum did not write'])
    // A parent that cannot be made is named by its code, never by its path.
    expect(await refused(join(root, 'missing', 'state'))).toEqual(['--state: cannot be created (ENOENT)'])
  })

  it('finishes making a directory a first open was killed in, whose only file is the temporary marker', async () => {
    const directory = join(root, 'state')
    mkdirSync(directory, { mode: 0o700 })
    const leftover = '.quorum-state.json.0a1b2c3d.tmp'
    writeFileSync(join(directory, leftover), '{"quorum"')
    const store = await open(directory)
    expect(readFileSync(join(directory, MARKER), 'utf8')).toBe('{"quorum":"state","version":1}')
    await store.put(entry('k1'), REPLY)
    expect(await store.get(entry('k1'))).toEqual(REPLY)
    // The leftover is left where it is, and the directory opens again.
    expect(readdirSync(directory)).toContain(leftover)
    await open(directory)
    // Only that one name is tolerated: any other file, a temporary of another name included, is a foreign directory.
    for (const other of [
      '.quorum-state.json.0a1b2c3.tmp',
      '.quorum-state.json.0A1B2C3D.tmp',
      '.other.json.0a1b2c3d.tmp',
      'quorum-state.json.tmp',
    ]) {
      const foreign = join(root, `foreign-${other}`)
      mkdirSync(foreign, { mode: 0o700 })
      writeFileSync(join(foreign, other), 'x')
      expect(await refused(foreign), other).toEqual(['--state: holds files but no quorum-state.json, so it is not a state directory quorum made: name an empty or new directory'])
    }
    // The leftover next to a file of another kind is still a foreign directory.
    const mixed = join(root, 'mixed')
    mkdirSync(mixed, { mode: 0o700 })
    writeFileSync(join(mixed, leftover), 'x')
    writeFileSync(join(mixed, 'notes.txt'), 'mine')
    expect(await refused(mixed)).toHaveLength(1)
  })

  it('reads back what it wrote, by key and provider', async () => {
    const directory = join(root, 'state')
    const store = await open(directory)
    await store.put(entry('k1'), REPLY)
    await store.put(entry('k2'), CUT_OFF)
    await store.put(entry('k1', 'other'), CUT_OFF)
    expect(await store.get(entry('k1'))).toEqual(REPLY)
    expect(await store.get(entry('k2'))).toEqual(CUT_OFF)
    expect(await store.get(entry('k1', 'other'))).toEqual(CUT_OFF)
    expect(await store.get(entry('k3'))).toBeUndefined()
    // Another version of quorum, or another identity of the provider, is another entry: a miss.
    expect(await (await open(directory, { version: '1.2.4' })).get(entry('k1'))).toBeUndefined()
    expect(await (await open(directory, {
      identities: new Map([
        ['api', 'changed'],
      ]),
    })).get(entry('k1'))).toBeUndefined()
    // A reopened directory holds what was written, and nothing was warned about.
    expect(await (await open(directory)).get(entry('k1'))).toEqual(REPLY)
    expect(warnings).toEqual([])
  })

  it('misses an entry that is no regular file, is over 8 MiB, fails the schema or holds another key, warning once', async () => {
    const directory = join(root, 'state')
    const store = await open(directory)
    const names = ['k1', 'k2', 'k3', 'k4'].map(key => join(directory, entryName(key)))
    mkdirSync(names[0])
    writeFileSync(names[1], Buffer.alloc(8 * MIB + 1))
    writeFileSync(names[2], JSON.stringify({
      version: 1,
      key: 'k3',
      reply: { text: 5, model: 'm' },
    }))
    writeFileSync(names[3], JSON.stringify({ version: 1, key: 'another', ...REPLY }))
    for (const key of ['k1', 'k2', 'k3', 'k4']) expect(await store.get(entry(key)), key).toBeUndefined()
    const secret = 'must-not-appear'
    expect(warnings).toEqual([
      '--state: a stored reply could not be read (is not a file): the call is made again',
      '--state: a stored reply could not be read (is over 8 MiB): the call is made again',
      '--state: a stored reply could not be read (is not a stored reply): the call is made again',
      '--state: a stored reply could not be read (holds another key): the call is made again',
    ])
    // Each reason is said once per store, however many entries meet it, and an entry that is not there says nothing.
    await store.get(entry('k1'))
    await store.get(entry('k-missing'))
    writeFileSync(join(directory, entryName('k5')), `${secret} not json`)
    await store.get(entry('k5'))
    expect(warnings).toHaveLength(4)
    expect(warnings.join('\n')).not.toContain(secret)
    // A link in an entry's place is refused, and an entry with a field no quorum writes fails its schema.
    symlinkSync(join(root, 'elsewhere'), join(directory, entryName('k6')))
    expect(await store.get(entry('k6'))).toBeUndefined()
    writeFileSync(join(directory, entryName('k7')), JSON.stringify({
      version: 1,
      key: 'k7',
      extra: 1,
      ...REPLY,
    }))
    expect(await store.get(entry('k7'))).toBeUndefined()
    expect(warnings).toHaveLength(5)
    expect(warnings[4]).toBe('--state: a stored reply could not be read (is a symbolic link): the call is made again')
    // A text longer than a reply may be, and a model longer than a model's name, are no reply.
    writeFileSync(join(directory, entryName('k8')), JSON.stringify({
      version: 1,
      key: 'k8',
      reply: {
        text: 'x'.repeat(1_000_001),
        model: 'm',
      },
    }))
    writeFileSync(join(directory, entryName('k9')), JSON.stringify({
      version: 1,
      key: 'k9',
      reply: {
        text: 'x',
        model: 'm'.repeat(257),
      },
    }))
    expect(await store.get(entry('k8'))).toBeUndefined()
    expect(await store.get(entry('k9'))).toBeUndefined()
    expect(warnings).toHaveLength(5)
  })

  it('counts in kept() the entries the run wrote or read back, each once', async () => {
    const directory = join(root, 'state')
    const store = await open(directory)
    expect(store.kept()).toBe(0)
    await store.put(entry('k1'), REPLY)
    await store.put(entry('k2'), CUT_OFF)
    expect(store.kept()).toBe(2)
    // The same entry written again, or read back, is the same call.
    await store.put(entry('k1'), REPLY)
    await store.get(entry('k1'))
    await store.get(entry('k1'))
    expect(store.kept()).toBe(2)
    // A provider's entry of the same key is another entry; a miss, a provider no identity names and a reply that is not saved count for nothing.
    await store.put(entry('k1', 'other'), CUT_OFF)
    expect(store.kept()).toBe(3)
    await store.get(entry('k9'))
    await store.put(entry('k1', 'ghost'), REPLY)
    await store.get(entry('k1', 'ghost'))
    await store.put(entry('k5'), {
      reply: {
        text: 'x'.repeat(1_000_001),
        model: 'm',
      },
    })
    expect(store.kept()).toBe(3)
    // A store opened on the directory afterwards starts at none, and counts what it reads back.
    const reopened = await open(directory)
    expect(reopened.kept()).toBe(0)
    expect(await reopened.get(entry('k2'))).toEqual(CUT_OFF)
    expect(await reopened.get(entry('k2'))).toEqual(CUT_OFF)
    await reopened.get(entry('k7'))
    expect(reopened.kept()).toBe(1)
    // A write that fails is not kept.
    rmSync(directory, { recursive: true })
    await store.put(entry('k8'), REPLY)
    expect(store.kept()).toBe(3)
  })

  it('misses a provider the identities do not name, and writes nothing for it', async () => {
    const directory = join(root, 'state')
    const store = await open(directory)
    await store.put(entry('k1', 'ghost'), REPLY)
    expect(readdirSync(directory)).toEqual([MARKER])
    expect(await store.get(entry('k1', 'ghost'))).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('writes nothing for a reply it would refuse to read, and warns', async () => {
    const store = await open(join(root, 'state'))
    await store.put(entry('k1'), {
      reply: {
        text: 'x'.repeat(1_000_001),
        model: 'm',
      },
    })
    expect(readdirSync(join(root, 'state'))).toEqual([MARKER])
    expect(warnings).toEqual(['--state: a reply could not be saved (EFBIG): the review goes on without saving it'])
  })

  it('warns once when an entry cannot be written, and resolves', async () => {
    const directory = join(root, 'state')
    const store = await open(directory)
    rmSync(directory, { recursive: true })
    await expect(store.put(entry('k1'), REPLY)).resolves.toBeUndefined()
    await expect(store.put(entry('k2'), REPLY)).resolves.toBeUndefined()
    expect(warnings).toEqual(['--state: a reply could not be saved (ENOENT): the review goes on without saving it'])
    // A directory that is gone is a miss too.
    expect(await store.get(entry('k1'))).toBeUndefined()
  })

  it('skips the owner and mode checks on win32', async () => {
    const directory = join(root, 'state')
    mkdirSync(directory)
    chmodSync(directory, 0o777)
    await expect(open(directory, { platform: 'win32', owner: statSync(directory).uid + 1 })).resolves.toBeDefined()
    expect(readFileSync(join(directory, MARKER), 'utf8')).toBe('{"quorum":"state","version":1}')
    // Every other refusal holds there.
    writeFileSync(join(root, 'plain'), 'x')
    expect(await refused(join(root, 'plain'), { platform: 'win32' })).toEqual(['--state: is not a directory'])
  })
})
