import { spawnSync } from 'node:child_process'
import { chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import { hiddenLabels } from '../core/sanitize.ts'
import { handleDescriptors, isClosed, record, RESULT, RUN_SUITE } from '../testing/bench.ts'
import { MAX_RECORD_BYTES, recordLine } from './records.ts'
import type { ResultRecord, RunFile } from './records.ts'
import { createRun, inspectRunDir, openRecords, readRecords, runDifferences, writeAtomic, writeRunFile } from './run-dir.ts'

let root = ''
let out = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quorum-run-'))
  out = join(root, 'out')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const RUN: RunFile = {
  format: 2,
  quorum: '0.2.0',
  suite: RUN_SUITE,
  salt: 'a'.repeat(64),
  configurations: [
    {
      path: 'a.yaml',
      fingerprint: 'f'.repeat(64),
    },
    {
      path: null,
      fingerprint: 'e'.repeat(64),
    },
  ],
}
const LINE_1 = recordLine(record({ trial: 1 }))
const LINE_2 = recordLine(record({ trial: 2 }))
const results = (): string => join(out, 'results.jsonl')
/** The permission bits of `path`. */
const modeOf = (path: string): number => statSync(path).mode & 0o777
/** The temporary run.json a run killed while it wrote can leave. */
const LEFTOVER = '.run.json.0123abcd.tmp'
/** The program that makes a FIFO, where the platform has one. */
const MKFIFO = ['/usr/bin/mkfifo', '/bin/mkfifo'].find(path => existsSync(path))
/** What a read of a directory that holds no results.jsonl finds. */
const NOTHING_READ = { validBytes: 0, bytes: 0 }

/** The issues `run` is refused with, each written `path: message`. */
async function refused(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues.map(({ path, message }) => `${path}: ${message}`)
  }
  throw new Error('not refused')
}

describe('inspectRunDir', () => {
  it('finds nothing where nothing is, an empty directory, or a run', async () => {
    expect(await inspectRunDir(out)).toEqual({ kind: 'none' })
    mkdirSync(out)
    expect(await inspectRunDir(out)).toEqual({ kind: 'empty' })
    await createRun(out, RUN)
    expect(await inspectRunDir(out)).toEqual({ kind: 'run', run: RUN })
  })

  it.each<[string, () => void, string]>([
    [
      'a directory that holds files but no run.json',
      () => {
        mkdirSync(out)
        writeFileSync(join(out, 'notes.txt'), 'mine')
      },
      '--out: holds files but no run.json, so it is not a run directory: name a new directory, or an empty one',
    ],
    [
      'a symbolic link',
      () => {
        mkdirSync(join(root, 'real'))
        symlinkSync(join(root, 'real'), out)
      },
      '--out: is a symbolic link',
    ],
    [
      'a file',
      () => writeFileSync(out, ''),
      '--out: is not a directory',
    ],
    [
      'a run.json that is a symbolic link',
      () => {
        mkdirSync(out)
        writeFileSync(join(root, 'run.json'), JSON.stringify(RUN))
        symlinkSync(join(root, 'run.json'), join(out, 'run.json'))
      },
      'run.json: is a symbolic link',
    ],
    [
      'a run.json that is no run file',
      () => {
        mkdirSync(out)
        writeFileSync(join(out, 'run.json'), '{}')
      },
      'run.json: is not a run file this quorum writes',
    ],
    [
      'a run.json that is not JSON',
      () => {
        mkdirSync(out)
        writeFileSync(join(out, 'run.json'), 'run')
      },
      'run.json: is not a run file this quorum writes',
    ],
  ])('refuses %s', async (_name, setup, issue) => {
    setup()
    expect(await refused(() => inspectRunDir(out))).toEqual([issue])
  })
})

describe('inspectRunDir, other ways to be refused', () => {
  it('refuses a symbolic link named with a trailing separator, which a stat would follow', async () => {
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), out)
    expect(await refused(() => inspectRunDir(`${out}/`))).toEqual(['--out: is a symbolic link'])
    expect(await refused(() => inspectRunDir(`${out}/.`))).toEqual(['--out: is a symbolic link'])
  })

  it('refuses a run.json over 1 MiB, and one that is a directory', async () => {
    mkdirSync(out)
    writeFileSync(join(out, 'run.json'), 'x'.repeat(1024 * 1024 + 1))
    expect(await refused(() => inspectRunDir(out))).toEqual(['run.json: is over 1 MiB'])
    rmSync(join(out, 'run.json'))
    mkdirSync(join(out, 'run.json'))
    expect(await refused(() => inspectRunDir(out))).toEqual(['run.json: is not a file'])
  })

  it('refuses a run.json that is not UTF-8', async () => {
    mkdirSync(out)
    writeFileSync(join(out, 'run.json'), Buffer.from([0xFF, 0xFE]))
    expect(await refused(() => inspectRunDir(out))).toEqual(['run.json: is not a run file this quorum writes'])
  })

  it('finds a hidden file in a directory with no run.json a reason to refuse it', async () => {
    mkdirSync(out)
    writeFileSync(join(out, '.hidden'), '')
    expect((await refused(() => inspectRunDir(out)))[0]).toMatch(/^--out: holds files but no run\.json/)
  })
})

describe('inspectRunDir and createRun, after a run killed while it wrote run.json', () => {
  it('takes a directory that holds only the temporary run.json a killed run left, and leaves that file', async () => {
    mkdirSync(out)
    writeFileSync(join(out, LEFTOVER), '{"format":')
    expect(await inspectRunDir(out)).toEqual({ kind: 'empty' })
    await createRun(out, RUN)
    expect(readdirSync(out).sort()).toEqual([LEFTOVER, 'run.json'])
    expect(readFileSync(join(out, LEFTOVER), 'utf8')).toBe('{"format":')
  })

  it.each<[string, string[]]>([
    [
      'that leftover and another file',
      [LEFTOVER, 'notes.txt'],
    ],
    [
      'a name with upper-case hex digits',
      ['.run.json.0123ABCD.tmp'],
    ],
    [
      'a name with seven hex digits',
      ['.run.json.0123abc.tmp'],
    ],
    [
      'a report\'s temporary file',
      ['.report.md.0123abcd.tmp'],
    ],
  ])('refuses a directory with no run.json that holds %s', async (_name, names) => {
    mkdirSync(out)
    for (const name of names) writeFileSync(join(out, name), '')
    expect(await refused(() => inspectRunDir(out))).toEqual(['--out: holds files but no run.json, so it is not a run directory: name a new directory, or an empty one'])
  })
})

describe('the modes of the files a run writes', () => {
  // Under a umask of 077 a new file is 0600 whatever mode it is asked for, so this test cannot fail there: a
  // regression that dropped OWNER_ONLY shows only under a umask such as 022, CI's.
  it('makes run.json and results.jsonl readable by their owner only, and a report as any new file', async () => {
    await createRun(out, RUN)
    await (await openRecords(out, NOTHING_READ)).close()
    await writeAtomic(out, 'report.md', '# report\n')
    writeFileSync(join(root, 'plain'), '')
    expect([
      modeOf(join(out, 'run.json')),
      modeOf(results()),
    ]).toEqual([0o600, 0o600])
    expect(modeOf(join(out, 'report.md'))).toBe(modeOf(join(root, 'plain')))
  })

  it('keeps the mode of a results.jsonl that is already there', async () => {
    mkdirSync(out)
    writeFileSync(results(), LINE_1)
    chmodSync(results(), 0o640)
    await (await openRecords(out, {
      validBytes: Buffer.byteLength(LINE_1),
      bytes: Buffer.byteLength(LINE_1),
    })).close()
    expect(modeOf(results())).toBe(0o640)
  })
})

describe('runDifferences', () => {
  const current = { quorum: RUN.quorum, suite: RUN.suite, configurations: RUN.configurations }

  it('finds none for the same run, its configurations in another order', () => {
    expect(runDifferences(RUN, {
      ...current,
      configurations: [...RUN.configurations].reverse(),
    })).toEqual([])
  })

  it('names every difference: the build, the suite\'s content, a configuration added and one left out', () => {
    expect(runDifferences(RUN, {
      quorum: '0.3.0',
      suite: { ...RUN_SUITE, reviewHash: `sha256:${'3'.repeat(64)}` },
      configurations: [
        {
          path: 'b.yaml',
          fingerprint: 'd'.repeat(64),
        },
        RUN.configurations[1],
      ],
    })).toEqual([
      { path: 'run.json', message: 'was written by quorum 0.2.0, and this is quorum 0.3.0: a run belongs to one build, so name a new --out' },
      { path: 'run.json', message: 'the suite\'s case ids, trials or patches changed since the run began: name a new --out' },
      { path: '--config', message: 'b.yaml is not one of the run\'s configurations' },
      { path: 'run.json', message: 'its configuration a.yaml is not given' },
    ])
  })

  it('names a configuration whose settings changed as one issue, whether it has a path or is the usual resolution', () => {
    expect(runDifferences(RUN, {
      ...current,
      configurations: [
        {
          path: 'a.yaml',
          fingerprint: 'd'.repeat(64),
        },
        {
          path: null,
          fingerprint: 'c'.repeat(64),
        },
      ],
    })).toEqual([
      { path: '--config', message: 'the settings of a.yaml changed since the run began: name a new --out' },
      { path: '--config', message: 'the settings of (default configuration) changed since the run began: name a new --out' },
    ])
  })

  it('keeps the two messages for a configuration added or left out beside one that changed', () => {
    expect(runDifferences(RUN, {
      ...current,
      configurations: [
        {
          path: 'a.yaml',
          fingerprint: 'd'.repeat(64),
        },
        {
          path: 'b.yaml',
          fingerprint: 'c'.repeat(64),
        },
      ],
    })).toEqual([
      { path: '--config', message: 'the settings of a.yaml changed since the run began: name a new --out' },
      { path: '--config', message: 'b.yaml is not one of the run\'s configurations' },
      { path: 'run.json', message: 'its configuration (default configuration) is not given' },
    ])
  })

  it('finds none for a suite whose scoring hash alone changed, which the run re-scores', () => {
    expect(runDifferences(RUN, {
      ...current,
      suite: { ...RUN_SUITE, scoringHash: `sha256:${'4'.repeat(64)}` },
    })).toEqual([])
  })

  it('refuses another quorum version alone, since a preset\'s defaults can change under the same fingerprint', () => {
    expect(runDifferences(RUN, { ...current, quorum: '0.2.1' })).toEqual([
      { path: 'run.json', message: 'was written by quorum 0.2.0, and this is quorum 0.2.1: a run belongs to one build, so name a new --out' },
    ])
  })

  it('names another suite by its name, and the usual resolution as the default configuration', () => {
    expect(runDifferences(RUN, {
      ...current,
      suite: { ...RUN_SUITE, name: 'other' },
      configurations: [RUN.configurations[0]],
    })).toEqual([
      { path: 'run.json', message: 'is a run of the suite demo, not other: name a new --out' },
      { path: 'run.json', message: 'its configuration (default configuration) is not given' },
    ])
  })
})

describe('createRun', () => {
  it('makes the directory and its parents, and writes run.json whole, with no temporary file left', async () => {
    const nested = join(out, 'a', 'b')
    await createRun(nested, RUN)
    expect(JSON.parse(readFileSync(join(nested, 'run.json'), 'utf8'))).toEqual(RUN)
    expect(readdirSync(nested)).toEqual(['run.json'])
  })

  it('writes into an empty directory it is given', async () => {
    mkdirSync(out)
    await createRun(out, RUN)
    expect(readdirSync(out)).toEqual(['run.json'])
  })
})

describe('writeRunFile', () => {
  it('writes run.json again whole, readable by its owner only, leaving no temporary file', async () => {
    const rescored: RunFile = {
      ...RUN,
      suite: { ...RUN.suite, scoringHash: `sha256:${'4'.repeat(64)}` },
    }
    await createRun(out, RUN)
    chmodSync(join(out, 'run.json'), 0o644)
    await writeRunFile(out, rescored)
    expect(await inspectRunDir(out)).toEqual({ kind: 'run', run: rescored })
    expect(modeOf(join(out, 'run.json'))).toBe(0o600)
    expect(readdirSync(out)).toEqual(['run.json'])
  })
})

describe('createRun, other ways to end', () => {
  it('writes run.json as inert JSON, a path with a hidden character escaped', async () => {
    const run: RunFile = {
      ...RUN,
      configurations: [
        {
          path: `a${String.fromCharCode(0x202E)}.yaml`,
          fingerprint: 'f'.repeat(64),
        },
      ],
    }
    await createRun(out, run)
    const text = readFileSync(join(out, 'run.json'), 'utf8')
    expect(hiddenLabels(text.replaceAll('\n', ''))).toEqual([])
    expect(JSON.parse(text)).toEqual(run)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('names the directory as given and the error\'s code when it cannot be made', async () => {
    writeFileSync(out, '')
    const target = join(out, 'inside')
    const error = await createRun(target, RUN).then(() => undefined, (thrown: unknown) => thrown as Error)
    expect(error?.message.startsWith(`${target}: `)).toBe(true)
    expect(error?.message.slice(target.length)).toMatch(/^: cannot be created \(E[A-Z]+\)$/)
  })
})

describe('the records', () => {
  it('appends one line per record, in order, and reads them back', async () => {
    mkdirSync(out)
    const writer = await openRecords(out, NOTHING_READ)
    await writer.append(LINE_1)
    await writer.append(LINE_2)
    await writer.close()
    const seen: Array<[number, number]> = []
    expect(await readRecords(out, (entry, line) => {
      seen.push([entry.trial, line])
      return undefined
    })).toEqual({
      lines: 2,
      validBytes: Buffer.byteLength(LINE_1 + LINE_2),
      bytes: Buffer.byteLength(LINE_1 + LINE_2),
      torn: false,
    })
    expect(seen).toEqual([
      [1, 1],
      [2, 2],
    ])
  })

  it('reports a last line cut short, and drops it before the next append', async () => {
    mkdirSync(out)
    writeFileSync(results(), `${LINE_1}${LINE_2.slice(0, 40)}`)
    const read = await readRecords(out, () => undefined)
    expect(read).toEqual({
      lines: 1,
      validBytes: Buffer.byteLength(LINE_1),
      bytes: Buffer.byteLength(LINE_1 + LINE_2.slice(0, 40)),
      torn: true,
    })
    const writer = await openRecords(out, read)
    await writer.append(LINE_2)
    await writer.close()
    expect(readFileSync(results(), 'utf8')).toBe(LINE_1 + LINE_2)
  })

  it('drops a last line that is a whole record without its line break, so the next append cannot join two records', async () => {
    mkdirSync(out)
    writeFileSync(results(), `${LINE_1}${LINE_2.slice(0, -1)}`)
    const seen: number[] = []
    const read = await readRecords(out, (entry) => {
      seen.push(entry.trial)
      return undefined
    })
    expect(read).toEqual({
      lines: 1,
      validBytes: Buffer.byteLength(LINE_1),
      bytes: Buffer.byteLength(LINE_1 + LINE_2.slice(0, -1)),
      torn: true,
    })
    expect(seen).toEqual([1])
    const writer = await openRecords(out, read)
    await writer.append(LINE_2)
    await writer.close()
    expect(readFileSync(results(), 'utf8')).toBe(LINE_1 + LINE_2)
  })

  it('finds no record and no torn line where there is no results.jsonl', async () => {
    mkdirSync(out)
    expect(await readRecords(out, () => undefined)).toEqual({
      lines: 0,
      validBytes: 0,
      bytes: 0,
      torn: false,
    })
  })

  it.each<[string, () => void, (entry: unknown) => string | undefined, string]>([
    [
      'a line in the middle that is no record',
      () => writeFileSync(results(), `${LINE_1}{}\n${LINE_2}`),
      () => undefined,
      'results.jsonl: line 2 is not a record of this run',
    ],
    [
      'an empty line',
      () => writeFileSync(results(), `${LINE_1}\n${LINE_2}`),
      () => undefined,
      'results.jsonl: line 2 is not a record of this run',
    ],
    [
      'a record its reader refuses',
      () => writeFileSync(results(), LINE_1),
      () => 'names a case the suite does not have',
      'results.jsonl: line 1 names a case the suite does not have',
    ],
    [
      'a results.jsonl that is a symbolic link',
      () => {
        writeFileSync(join(root, 'elsewhere.jsonl'), LINE_1)
        symlinkSync(join(root, 'elsewhere.jsonl'), results())
      },
      () => undefined,
      'results.jsonl: is a symbolic link',
    ],
  ])('refuses %s', async (_name, setup, visit, issue) => {
    mkdirSync(out)
    setup()
    expect(await refused(() => readRecords(out, visit))).toEqual([issue])
  })

  it('refuses a line over 16 MiB', async () => {
    mkdirSync(out)
    writeFileSync(results(), `${'x'.repeat(MAX_RECORD_BYTES + 1)}\n`)
    expect(await refused(() => readRecords(out, () => undefined))).toEqual(['results.jsonl: line 1 is over 16 MiB'])
  })

  it('never appends through a symbolic link planted at results.jsonl', async () => {
    mkdirSync(out)
    writeFileSync(join(root, 'target'), 'kept')
    symlinkSync(join(root, 'target'), results())
    await expect(openRecords(out, NOTHING_READ)).rejects.toThrow('results.jsonl: cannot be written')
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('kept')
  })

  it('writes appends made at once one after the other, whole', async () => {
    mkdirSync(out)
    const writer = await openRecords(out, NOTHING_READ)
    await Promise.all([
      writer.append(LINE_1),
      writer.append(LINE_2),
      writer.append(LINE_1),
    ])
    await writer.close()
    expect(readFileSync(results(), 'utf8')).toBe(LINE_1 + LINE_2 + LINE_1)
  })
})

describe('the records, other cases', () => {
  const big = (text: string): string => recordLine(record({
    result: {
      ...RESULT,
      kept: [
        { ...RESULT.kept[0], summary: text },
      ],
    },
  }))

  it('reads a line longer than a chunk, characters of several bytes across its chunks, and a torn tail longer than a chunk', async () => {
    mkdirSync(out)
    const accent = String.fromCharCode(0xE9)
    const long = big(accent.repeat(100_000))
    writeFileSync(results(), `${long}${LINE_1}${'x'.repeat(150_000)}`)
    const summaries: number[] = []
    const read = await readRecords(out, (entry) => {
      summaries.push((entry as ResultRecord).result.kept[0].summary.length)
      return undefined
    })
    expect(summaries).toEqual([100_000, RESULT.kept[0].summary.length])
    expect(read).toEqual({
      lines: 2,
      validBytes: Buffer.byteLength(long + LINE_1),
      bytes: Buffer.byteLength(`${long}${LINE_1}${'x'.repeat(150_000)}`),
      torn: true,
    })
  })

  it('refuses a line that is not UTF-8, and a results.jsonl that is not a file', async () => {
    mkdirSync(out)
    writeFileSync(results(), Buffer.from([0xFF, 0x0A]))
    expect(await refused(() => readRecords(out, () => undefined))).toEqual(['results.jsonl: line 1 is not a record of this run'])
    rmSync(results())
    mkdirSync(results())
    expect(await refused(() => readRecords(out, () => undefined))).toEqual(['results.jsonl: is not a file'])
  })

  it('refuses an unfinished last line over 16 MiB as it refuses a whole one', async () => {
    mkdirSync(out)
    writeFileSync(results(), `${LINE_1}${'x'.repeat(MAX_RECORD_BYTES + 1)}`)
    expect(await refused(() => readRecords(out, () => undefined))).toEqual(['results.jsonl: line 2 is over 16 MiB'])
  })

  it('creates results.jsonl when it is not there, and cuts a longer one to the bytes found valid', async () => {
    mkdirSync(out)
    await (await openRecords(out, NOTHING_READ)).close()
    expect(readFileSync(results(), 'utf8')).toBe('')
    writeFileSync(results(), `${LINE_1}${LINE_2}`)
    await (await openRecords(out, {
      validBytes: Buffer.byteLength(LINE_1),
      bytes: Buffer.byteLength(LINE_1 + LINE_2),
    })).close()
    expect(readFileSync(results(), 'utf8')).toBe(LINE_1)
  })

  it('names the error\'s code when a write fails, and writes nothing after a failed write', async () => {
    mkdirSync(out)
    const probe = await open(join(root, 'probe'), 'w')
    vi.spyOn(Object.getPrototypeOf(probe) as { appendFile: () => Promise<void> }, 'appendFile').mockRejectedValueOnce(Object.assign(new Error('disk said: secret'), { code: 'ENOSPC' }))
    await probe.close()
    const writer = await openRecords(out, NOTHING_READ)
    const first = writer.append(LINE_1)
    const second = writer.append(LINE_2)
    await expect(first).rejects.toThrow(/^results\.jsonl: cannot be written \(ENOSPC\)$/)
    await expect(second).rejects.toThrow(/^results\.jsonl: cannot be written \(ENOSPC\)$/)
    await expect(writer.append(LINE_1)).rejects.toThrow(/^results\.jsonl: cannot be written \(ENOSPC\)$/)
    await writer.close()
    expect(readFileSync(results(), 'utf8')).toBe('')
  })

  it('names no code that is not one, and never the runtime\'s text', async () => {
    mkdirSync(out)
    const writer = await openRecords(out, NOTHING_READ)
    await writer.close()
    const error = await writer.append(LINE_1).then(() => undefined, (thrown: unknown) => thrown as Error)
    expect(error?.message).toMatch(/^results\.jsonl: cannot be written( \(E[A-Z]+\))?$/)
  })
})

describe('the records, when results.jsonl changed after it was read', () => {
  it('refuses a results.jsonl cut or appended to after it was read, cuts and writes nothing, and closes it', async () => {
    const changed = 'results.jsonl: changed after this run read it, so another run may be using this --out: run one at a time'
    mkdirSync(out)
    writeFileSync(results(), LINE_1 + LINE_2)
    const read = await readRecords(out, () => undefined)
    const descriptors = await handleDescriptors(root, 'stat')
    truncateSync(results(), Buffer.byteLength(LINE_1))
    expect(await refused(() => openRecords(out, read))).toEqual([changed])
    expect(readFileSync(results(), 'utf8')).toBe(LINE_1)
    // Another run's record, appended after this run's read: kept, never cut back.
    writeFileSync(results(), LINE_1 + LINE_2 + LINE_2)
    expect(await refused(() => openRecords(out, read))).toEqual([changed])
    expect(readFileSync(results(), 'utf8')).toBe(LINE_1 + LINE_2 + LINE_2)
    expect(descriptors).toHaveLength(2)
    expect(descriptors.map(descriptor => isClosed(descriptor))).toEqual([true, true])
  })

  it('refuses a results.jsonl deleted after it was read, and does not make it again', async () => {
    mkdirSync(out)
    writeFileSync(results(), LINE_1 + LINE_2)
    const read = await readRecords(out, () => undefined)
    rmSync(results())
    expect(await refused(() => openRecords(out, read))).toEqual(['results.jsonl: changed after this run read it, so another run may be using this --out: run one at a time'])
    expect(existsSync(results())).toBe(false)
  })

  it('refuses a directory swapped in at results.jsonl, as the read refuses one', async () => {
    mkdirSync(out)
    mkdirSync(results())
    expect(await refused(() => openRecords(out, NOTHING_READ))).toEqual(['results.jsonl: is not a file'])
  })

  it.skipIf(MKFIFO === undefined)('refuses a FIFO swapped in at results.jsonl, held by a reader or not, and never waits for one', async () => {
    mkdirSync(out)
    expect(spawnSync(MKFIFO ?? '', [
      results(),
    ]).status).toBe(0)
    // A reader first, so that an open that blocks returns at once and the test can never hang.
    const reader = await open(results(), constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      expect(await refused(() => openRecords(out, NOTHING_READ))).toEqual(['results.jsonl: is not a file'])
    } finally {
      await reader.close()
    }
    expect(await refused(() => openRecords(out, NOTHING_READ))).toEqual(['results.jsonl: is not a file'])
  })
})

describe('writeAtomic', () => {
  it('writes the text through a new file and a rename, leaving no temporary file', async () => {
    mkdirSync(out)
    await writeAtomic(out, 'report.md', '# one\n')
    await writeAtomic(out, 'report.md', '# two\n')
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toBe('# two\n')
    expect(readdirSync(out)).toEqual(['report.md'])
  })

  it('replaces a symbolic link at the name without writing through it', async () => {
    mkdirSync(out)
    writeFileSync(join(root, 'bashrc'), 'mine')
    symlinkSync(join(root, 'bashrc'), join(out, 'report.md'))
    await writeAtomic(out, 'report.md', '# report\n')
    expect(readFileSync(join(root, 'bashrc'), 'utf8')).toBe('mine')
    expect(lstatSync(join(out, 'report.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toBe('# report\n')
  })

  it('names the error\'s code when the directory is missing, and when the name is a directory, and leaves no temporary file', async () => {
    await expect(writeAtomic(join(root, 'missing'), 'report.md', 'x')).rejects.toThrow(/^report\.md: cannot be written \(ENOENT\)$/)
    mkdirSync(out)
    mkdirSync(join(out, 'report.md'))
    await expect(writeAtomic(out, 'report.md', 'x')).rejects.toThrow(/^report\.md: cannot be written \(E[A-Z]+\)$/)
    expect(readdirSync(out)).toEqual(['report.md'])
  })
})
