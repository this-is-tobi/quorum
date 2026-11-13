import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBounded } from '../config/load.ts'
import { ConfigError } from '../core/errors.ts'
import { PATCHES, SUITE, writeSuite } from '../testing/bench.ts'
import { loadSuite } from './suite.ts'

/** `readBounded` as a spy that calls through, so a test can count the reads of one patch. */
vi.mock('../config/load.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.ts')>()
  return {
    ...actual,
    readBounded: vi.fn(actual.readBounded),
  }
})

let root = ''
let directory = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quorum-suite-'))
  directory = join(root, 'demo')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const MIB = 1024 * 1024
const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** The suite with `fields` set on case `index`; a field set to `undefined` is left out of the YAML. */
function withCase(index: number, fields: Record<string, unknown>): object {
  return {
    ...SUITE,
    cases: SUITE.cases.map((entry, at) => at === index
      ? {
          ...entry,
          ...fields,
        }
      : entry),
  }
}

/** The issues the suite is refused with, each written `path: message`. */
async function refused(): Promise<string[]> {
  try {
    await loadSuite(directory, 'demo')
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues.map(({ path, message }) => `${path}: ${message}`)
  }
  throw new Error('the suite was not refused')
}

describe('loadSuite', () => {
  it('reads the suite, its defaults, its patches and its content hash', async () => {
    writeSuite(directory)
    const suite = await loadSuite(directory, 'demo')
    expect([suite.name, suite.window, suite.trials]).toEqual(['demo', 3, undefined])
    expect(suite.cases.map(({ id, kind }) => [id, kind])).toEqual([
      ['exec', 'bug'],
      ['sql', 'bug'],
      ['docs', 'control'],
    ])
    expect([...suite.patches]).toEqual([
      ['exec.patch', PATCHES.exec],
      ['sql.patch', PATCHES.sql],
      ['docs.patch', PATCHES.docs],
    ])
    const files = [
      [
        'suite.yaml',
        sha256(readFileSync(join(directory, 'suite.yaml'))),
      ],
      [
        'cases/docs.patch',
        sha256(PATCHES.docs),
      ],
      [
        'cases/exec.patch',
        sha256(PATCHES.exec),
      ],
      [
        'cases/sql.patch',
        sha256(PATCHES.sql),
      ],
    ]
    expect(suite.hash).toBe(`sha256:${sha256(JSON.stringify(files))}`)
  })

  it('decodes a patch as the review command decodes a diff: a byte-order mark dropped, a byte that is not UTF-8 replaced', async () => {
    writeSuite(directory, SUITE, {
      'docs.patch': Uint8Array.from([
        0xEF,
        0xBB,
        0xBF,
        ...new TextEncoder().encode(PATCHES.docs),
        0xFF,
        0x0A,
      ]),
    })
    expect((await loadSuite(directory, 'demo')).patches.get('docs.patch')).toBe(`${PATCHES.docs}${String.fromCharCode(0xFFFD)}\n`)
  })

  it('takes a location at a file name git quotes, by its decoded name', async () => {
    const name = `a${String.fromCharCode(0x0A)}b.js`
    const quoted = PATCHES.exec.replaceAll('a/a.js', '"a/a\\nb.js"').replaceAll('b/a.js', '"b/a\\nb.js"')
    writeSuite(directory, withCase(0, {
      locations: [
        { file: name, start: 2, end: 2 },
      ],
    }), { 'exec.patch': quoted })
    expect((await loadSuite(directory, 'demo')).cases[0]).toMatchObject({
      locations: [
        { file: name, start: 2, end: 2 },
      ],
    })
  })

  it.each<[string, object, string]>([
    [
      'an unknown field',
      { ...SUITE, extra: 1 },
      'demo/suite.yaml: extra: is not a known field',
    ],
    [
      'a name outside the id pattern',
      { ...SUITE, name: 'Demo' },
      'demo/suite.yaml: name: must match ^[a-z0-9][a-z0-9._-]*$',
    ],
    [
      'a kind no case has',
      withCase(0, { kind: 'attack' }),
      'demo/suite.yaml: cases.0.kind: must be one of bug or control',
    ],
    [
      'a bug without locations',
      withCase(0, { locations: undefined }),
      'demo/suite.yaml: cases.0.locations: is required for a bug',
    ],
    [
      'a control with locations',
      withCase(2, {
        locations: [
          { file: 'README.md', start: 1, end: 1 },
        ],
      }),
      'demo/suite.yaml: cases.2.locations: is only for a bug',
    ],
    [
      'a control with a fix commit',
      withCase(2, {
        fixCommit: 'a'.repeat(40),
      }),
      'demo/suite.yaml: cases.2.fixCommit: is only for a bug',
    ],
    [
      'a bug with a control\'s commit',
      withCase(0, {
        commit: 'a'.repeat(40),
      }),
      'demo/suite.yaml: cases.0.commit: is only for a control',
    ],
    [
      'a patch name with a path',
      withCase(0, { patch: '../exec.patch' }),
      'demo/suite.yaml: cases.0.patch: must be a bare file name: letters, digits, dots, underscores and dashes, not starting with a dot',
    ],
    [
      'a location that ends before it starts',
      withCase(0, {
        locations: [
          { file: 'a.js', start: 3, end: 2 },
        ],
      }),
      'demo/suite.yaml: cases.0.locations.0: must start at or before its end',
    ],
    [
      'a location of 501 lines',
      withCase(0, {
        locations: [
          { file: 'a.js', start: 1, end: 501 },
        ],
      }),
      'demo/suite.yaml: cases.0.locations.0: must span at most 500 lines',
    ],
    [
      'a location at line 0',
      withCase(0, {
        locations: [
          { file: 'a.js', start: 0, end: 2 },
        ],
      }),
      'demo/suite.yaml: cases.0.locations.0.start: must be at least 1',
    ],
    [
      'a note of two lines',
      withCase(0, { note: 'one\ntwo' }),
      'demo/suite.yaml: cases.0.note: must be one line of visible text',
    ],
    [
      'an empty note',
      withCase(0, { note: '' }),
      'demo/suite.yaml: cases.0.note: must not be empty',
    ],
    [
      'an empty copyright line',
      withCase(0, {
        copyright: ['Copyright (c) A', ''],
      }),
      'demo/suite.yaml: cases.0.copyright.1: must not be empty',
    ],
    [
      'a date that is no day',
      withCase(0, { date: '2026-02-30' }),
      'demo/suite.yaml: cases.0.date: must be a date written YYYY-MM-DD',
    ],
    [
      'a repository over plain http',
      withCase(0, { repo: 'http://github.com/a/b' }),
      'demo/suite.yaml: cases.0.repo: must be an https:// URL with no credentials, query or fragment',
    ],
    [
      'a repository with an empty query',
      withCase(0, { repo: 'https://github.com/a/b?' }),
      'demo/suite.yaml: cases.0.repo: must be an https:// URL with no credentials, query or fragment',
    ],
    [
      'a repository with a line break',
      withCase(0, { repo: `https://github.com/a${String.fromCharCode(0x0A)}b` }),
      'demo/suite.yaml: cases.0.repo: must be an https:// URL with no credentials, query or fragment',
    ],
    [
      'a short commit hash',
      withCase(0, { fixCommit: 'abc1234' }),
      'demo/suite.yaml: cases.0.fixCommit: must be a full commit hash: 40 or 64 lowercase hex digits',
    ],
    [
      'a license expression',
      withCase(0, { license: 'MIT OR Apache-2.0' }),
      'demo/suite.yaml: cases.0.license: must be one SPDX license id, such as MIT or Apache-2.0',
    ],
    [
      '101 trials',
      { ...SUITE, trials: 101 },
      'demo/suite.yaml: trials: must be at most 100',
    ],
    [
      'a negative window',
      { ...SUITE, window: -1 },
      'demo/suite.yaml: window: must be at least 0',
    ],
    [
      'a repeated id',
      withCase(1, { id: 'exec' }),
      'demo/suite.yaml: cases.1.id: repeats the id of cases.0',
    ],
  ])('refuses %s', async (_name, suite, issue) => {
    writeSuite(directory, suite)
    expect(await refused()).toEqual([issue])
  })

  it('reads and hashes once a patch that two cases name', async () => {
    writeSuite(directory, {
      ...SUITE,
      cases: [
        ...SUITE.cases,
        { id: 'exec-again', kind: 'control', patch: 'exec.patch' },
      ],
    })
    vi.mocked(readBounded).mockClear()
    const suite = await loadSuite(directory, 'demo')
    expect(vi.mocked(readBounded).mock.calls.filter(([path]) => path.endsWith('exec.patch'))).toHaveLength(1)
    expect([
      ...suite.patches.keys(),
    ]).toEqual(['exec.patch', 'sql.patch', 'docs.patch'])
    expect(suite.hash).toBe(`sha256:${sha256(JSON.stringify([
      [
        'suite.yaml',
        sha256(readFileSync(join(directory, 'suite.yaml'))),
      ],
      [
        'cases/docs.patch',
        sha256(PATCHES.docs),
      ],
      [
        'cases/exec.patch',
        sha256(PATCHES.exec),
      ],
      [
        'cases/sql.patch',
        sha256(PATCHES.sql),
      ],
    ]))}`)
  })

  it('refuses a patch that two cases name with an issue for each', async () => {
    writeSuite(directory, {
      ...SUITE,
      cases: [
        ...SUITE.cases,
        { id: 'sql-again', kind: 'control', patch: 'sql.patch' },
      ],
    })
    rmSync(join(directory, 'cases', 'sql.patch'))
    expect(await refused()).toEqual([
      'demo/suite.yaml: cases.1.patch: does not exist',
      'demo/suite.yaml: cases.3.patch: does not exist',
    ])
  })

  it.each<[string, () => void, string[]]>([
    [
      'no suite.yaml',
      () => mkdirSync(join(directory, 'cases'), { recursive: true }),
      ['demo/suite.yaml: does not exist'],
    ],
    [
      'a suite.yaml that is a symbolic link',
      () => {
        writeSuite(join(root, 'elsewhere'))
        mkdirSync(join(directory, 'cases'), { recursive: true })
        symlinkSync(join(root, 'elsewhere', 'suite.yaml'), join(directory, 'suite.yaml'))
      },
      ['demo/suite.yaml: is a symbolic link'],
    ],
    [
      'a suite.yaml that repeats a key',
      () => {
        writeSuite(directory)
        writeFileSync(join(directory, 'suite.yaml'), 'name: demo\nname: again\ncases: []\n')
      },
      ['demo/suite.yaml: is not valid YAML at line 2, column 1 (DUPLICATE_KEY)'],
    ],
    [
      'no cases directory',
      () => {
        writeSuite(directory)
        rmSync(join(directory, 'cases'), { recursive: true })
      },
      ['demo/cases: does not exist'],
    ],
    [
      'a cases directory that is a symbolic link',
      () => {
        writeSuite(join(root, 'elsewhere'))
        writeSuite(directory)
        rmSync(join(directory, 'cases'), { recursive: true })
        symlinkSync(join(root, 'elsewhere', 'cases'), join(directory, 'cases'))
      },
      ['demo/cases: is a symbolic link'],
    ],
    [
      'a missing patch',
      () => {
        writeSuite(directory)
        rmSync(join(directory, 'cases', 'sql.patch'))
      },
      ['demo/suite.yaml: cases.1.patch: does not exist'],
    ],
    [
      'a patch that is a symbolic link',
      () => {
        writeSuite(directory)
        writeFileSync(join(root, 'outside.patch'), PATCHES.sql)
        rmSync(join(directory, 'cases', 'sql.patch'))
        symlinkSync(join(root, 'outside.patch'), join(directory, 'cases', 'sql.patch'))
      },
      ['demo/suite.yaml: cases.1.patch: is a symbolic link'],
    ],
    [
      'a patch that is a directory',
      () => {
        writeSuite(directory)
        rmSync(join(directory, 'cases', 'sql.patch'))
        mkdirSync(join(directory, 'cases', 'sql.patch'))
      },
      ['demo/suite.yaml: cases.1.patch: is not a file'],
    ],
    [
      'a patch with a commit header',
      () => writeSuite(directory, SUITE, { 'docs.patch': `commit ${'a'.repeat(40)}\nAuthor: A <a@example.com>\n\n${PATCHES.docs}` }),
      ['demo/suite.yaml: cases.2.patch: must be a pure diff that starts at its first diff --git line'],
    ],
    [
      'a patch whose header names no file quorum reads',
      () => writeSuite(directory, SUITE, {
        'docs.patch': PATCHES.docs.replace('diff --git a/README.md b/README.md', 'diff --git x y'),
      }),
      ['demo/suite.yaml: cases.2.patch: names no file in a diff --git header quorum reads'],
    ],
    [
      'a location at a path the patch does not key',
      () => writeSuite(directory, withCase(0, {
        locations: [
          { file: 'b/a.js', start: 2, end: 2 },
        ],
      })),
      ['demo/suite.yaml: cases.0.locations.0.file: is not a file of the patch, as its diff --git header names it'],
    ],
    [
      'a location past the hunk',
      () => writeSuite(directory, withCase(0, {
        locations: [
          { file: 'a.js', start: 2, end: 4 },
        ],
      })),
      ['demo/suite.yaml: cases.0.locations.0: line 4 is not in a hunk of the patch'],
    ],
    [
      'a patch over 16 MiB',
      () => {
        writeSuite(directory)
        truncateSync(join(directory, 'cases', 'docs.patch'), 16 * MIB + 1)
      },
      ['demo/suite.yaml: cases.2.patch: is over 16 MiB'],
    ],
    [
      'patches over 64 MiB in total',
      () => {
        const cases = [0, 1, 2, 3, 4].map(index => ({ id: `c${index}`, kind: 'control', patch: `c${index}.patch` }))
        writeSuite(directory, { name: 'demo', cases }, {
          'c0.patch': '',
          'c1.patch': '',
          'c2.patch': '',
          'c3.patch': '',
          'c4.patch': PATCHES.docs,
        })
        for (const index of [0, 1, 2, 3]) truncateSync(join(directory, 'cases', `c${index}.patch`), 16 * MIB)
      },
      [
        ...[0, 1, 2, 3].map(index => `demo/suite.yaml: cases.${index}.patch: must be a pure diff that starts at its first diff --git line`),
        'demo/suite.yaml: cases.4.patch: takes the patches over 64 MiB in total',
      ],
    ],
  ])('refuses %s', async (_name, setup, issues) => {
    setup()
    expect(await refused()).toEqual(issues)
  })
})
