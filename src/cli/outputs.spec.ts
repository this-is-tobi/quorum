import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { outcome } from '../core/outcome.ts'
import { harness } from '../testing/cli.ts'
import { reportResult } from '../testing/report.ts'
import { checkOutputs, colorFor, reportPlan, writeOutputs } from './outputs.ts'
import type { ColorWhen, OutputFile } from './outputs.ts'

const ESC = String.fromCharCode(0x1B)

/** A directory of its own for each test, the working directory of the outputs it plans and writes. */
let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quorum-outputs-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('reportPlan', () => {
  const { io } = harness()

  it('writes json on stdout by default, and the format --format names', () => {
    expect(reportPlan({}, io)).toEqual({
      format: 'json',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      format: ['json'],
    }, io)).toEqual({
      format: 'json',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      format: ['brief'],
    }, io)).toEqual({
      format: 'brief',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      view: ['public'],
    }, io)).toEqual({
      format: 'json',
      color: false,
      view: 'public',
      outputs: [],
    })
  })

  it('chooses text on a terminal and json elsewhere, unless --format names one, and colors only text', () => {
    const terminal = harness({ stdoutIsTTY: true }).io
    const pipe = harness({ stdoutIsTTY: false }).io
    expect(reportPlan({}, terminal)).toEqual({
      format: 'text',
      color: true,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({}, pipe)).toEqual({
      format: 'json',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      format: ['json'],
    }, terminal)).toEqual({
      format: 'json',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      format: ['brief'],
      color: ['always'],
    }, terminal)).toEqual({
      format: 'brief',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      format: ['json'],
      color: ['always'],
    }, terminal)).toEqual({
      format: 'json',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      format: ['text'],
    }, pipe)).toEqual({
      format: 'text',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      format: ['text'],
      color: ['always'],
    }, pipe)).toEqual({
      format: 'text',
      color: true,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      color: ['never'],
    }, terminal)).toEqual({
      format: 'text',
      color: false,
      view: 'full',
      outputs: [],
    })
    expect(reportPlan({
      color: ['auto'],
    }, harness({
      stdoutIsTTY: true,
      env: { NO_COLOR: '1' },
    }).io)).toEqual({
      format: 'text',
      color: false,
      view: 'full',
      outputs: [],
    })
  })

  it.each<[{ format?: string[], color?: string[], view?: string[], output?: string[], 'print-config'?: boolean }, string]>([
    [
      {
        format: ['xml'],
      },
      '--format: must be text, json or brief',
    ],
    [
      {
        format: ['toString'],
      },
      '--format: must be text, json or brief',
    ],
    [
      {
        format: ['json', 'brief'],
      },
      '--format: takes one format',
    ],
    [
      {
        format: ['json'],
        'print-config': true,
      },
      '--print-config: prints the config as YAML, so it takes no --format, --output or --view',
    ],
    [
      {
        output: ['json=a.json'],
        'print-config': true,
      },
      '--print-config: prints the config as YAML, so it takes no --format, --output or --view',
    ],
    [
      {
        view: ['secret'],
      },
      '--view: must be full or public',
    ],
    [
      {
        view: ['full', 'public'],
      },
      '--view: takes one view',
    ],
    [
      {
        view: ['public'],
        'print-config': true,
      },
      '--print-config: prints the config as YAML, so it takes no --format, --output or --view',
    ],
    [
      {
        color: ['sometimes'],
      },
      '--color: must be auto, always or never',
    ],
    [
      {
        color: ['always', 'never'],
      },
      '--color: takes one value',
    ],
  ])('refuses %j', (values, message) => {
    expect(() => reportPlan(values, io)).toThrow(expect.objectContaining({ name: 'ConfigError', message }))
  })

  it.each<[string[], string]>([
    [
      ['json'],
      '--output: must be written <format>=<path>, the format text, json or brief',
    ],
    [
      ['=a.json'],
      '--output: must be written <format>=<path>, the format text, json or brief',
    ],
    [
      ['xml=a.json'],
      '--output: must be written <format>=<path>, the format text, json or brief',
    ],
    [
      ['json='],
      '--output: must be written <format>=<path>, the format text, json or brief',
    ],
    [
      ['json=-'],
      '--output: must be written <format>=<path>, the format text, json or brief',
    ],
    [
      ['json=fresh/'],
      '--output: must be written <format>=<path>, the format text, json or brief',
    ],
    [
      ['brief=out/fresh\\'],
      '--output: must be written <format>=<path>, the format text, json or brief',
    ],
    [
      ['json=a.json', 'text=./a.json'],
      '--output: names one file twice',
    ],
  ])('refuses %j before anything is read', (output, message) => {
    expect(() => reportPlan({ output }, harness({ cwd: root }).io)).toThrow(expect.objectContaining({ name: 'ConfigError', message }))
  })

  it('takes two formats to two files, and one format to two files', () => {
    const { io: here } = harness({ cwd: root })
    const elsewhere = join(tmpdir(), 'quorum-elsewhere', 'b.json')
    expect(reportPlan({
      output: ['json=a.json', 'text=sub/b.txt'],
    }, here).outputs).toEqual([
      {
        format: 'json',
        path: join(root, 'a.json'),
      },
      {
        format: 'text',
        path: join(root, 'sub', 'b.txt'),
      },
    ])
    expect(reportPlan({
      output: ['json=a.json', `json=${elsewhere}`, 'brief=x=y.txt'],
    }, here).outputs).toEqual([
      {
        format: 'json',
        path: join(root, 'a.json'),
      },
      { format: 'json', path: elsewhere },
      {
        format: 'brief',
        path: join(root, 'x=y.txt'),
      },
    ])
  })
})

describe('colorFor', () => {
  const FORCED = harness({
    stdoutIsTTY: false,
    env: { FORCE_COLOR: '1' },
  }).io
  const CLICOLOR_FORCED = harness({
    stdoutIsTTY: false,
    env: { CLICOLOR_FORCE: '1' },
  }).io

  it.each<[ColorWhen, string, () => boolean, boolean]>([
    [
      'auto',
      'a terminal, NO_COLOR unset',
      () => colorFor('auto', true, undefined),
      true,
    ],
    [
      'auto',
      'a terminal, NO_COLOR empty',
      () => colorFor('auto', true, ''),
      true,
    ],
    [
      'auto',
      'a terminal, NO_COLOR 1',
      () => colorFor('auto', true, '1'),
      false,
    ],
    [
      'auto',
      'a terminal, NO_COLOR 0',
      () => colorFor('auto', true, '0'),
      false,
    ],
    [
      'auto',
      'a pipe',
      () => colorFor('auto', undefined, undefined),
      false,
    ],
    [
      'always',
      'a pipe, NO_COLOR 1',
      () => colorFor('always', undefined, '1'),
      true,
    ],
    [
      'never',
      'a terminal',
      () => colorFor('never', true, undefined),
      false,
    ],
    [
      'auto',
      'a pipe, FORCE_COLOR=1, which no run reads',
      () => reportPlan({
        format: ['text'],
      }, FORCED).color,
      false,
    ],
    [
      'auto',
      'a pipe, CLICOLOR_FORCE=1, which no run reads',
      () => reportPlan({
        format: ['text'],
      }, CLICOLOR_FORCED).color,
      false,
    ],
  ])('colors %s: %s', (_when, _situation, colored, expected) => {
    expect(colored()).toBe(expected)
  })
})

/** The outputs a plan makes of `output`, as `reportPlan` makes them in the working directory `root`. */
function planned(...output: string[]): OutputFile[] {
  return [
    ...reportPlan({ output }, harness({ cwd: root }).io).outputs,
  ]
}

describe('checkOutputs', () => {
  it.each<[string, string, () => string]>([
    [
      'a symbolic link',
      '--output json: is a symbolic link',
      () => {
        writeFileSync(join(root, 'target'), 'mine')
        symlinkSync(join(root, 'target'), join(root, 'r.json'))
        return join(root, 'r.json')
      },
    ],
    [
      'a directory',
      '--output json: is not a regular file',
      () => {
        mkdirSync(join(root, 'r.json'))
        return join(root, 'r.json')
      },
    ],
    [
      'in no directory',
      '--output json: is in no directory',
      () => join(root, 'missing', 'r.json'),
    ],
  ])('refuses before any call an output whose path is %s, naming the format and never the path', async (_situation, message, arrange) => {
    const refusal = await checkOutputs([
      {
        format: 'json',
        path: arrange(),
      },
    ]).then(() => undefined, (error: unknown) => error)
    expect(refusal).toMatchObject({ name: 'ConfigError', message })
    expect((refusal as Error).message).not.toContain(root)
  })
})

describe('writeOutputs', () => {
  const result = reportResult()
  const done = outcome(result)

  it('writes each output whole and uncolored through a new file and a rename, with the process\'s mode, leaving no temporary file', async () => {
    const outputs = planned('text=r.txt', 'json=r.json')
    writeFileSync(join(root, 'r.txt'), 'an older report, longer than a line of the new one'.repeat(100))
    await checkOutputs(outputs)
    await writeOutputs(outputs, result, done)
    const text = readFileSync(join(root, 'r.txt'), 'utf8')
    expect(text.startsWith('quorum 0.6.0 · range ')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain(ESC)
    expect(JSON.parse(readFileSync(join(root, 'r.json'), 'utf8'))).toMatchObject({
      meta: { version: '0.6.0' },
    })
    expect(readdirSync(root).sort()).toEqual(['r.json', 'r.txt'])
    for (const { path } of outputs) expect(statSync(path).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  it('replaces a link made after the check, never writing through it', async () => {
    const outputs = planned('json=r.json')
    await checkOutputs(outputs)
    writeFileSync(join(root, 'mine'), 'mine')
    symlinkSync(join(root, 'mine'), join(root, 'r.json'))
    await writeOutputs(outputs, result, done)
    expect(readFileSync(join(root, 'mine'), 'utf8')).toBe('mine')
    expect(lstatSync(join(root, 'r.json')).isFile()).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'r.json'), 'utf8'))).toMatchObject({
      meta: { version: '0.6.0' },
    })
  })

  it('fails with the format and the error\'s code, never the path, when a write fails', async () => {
    const outputs = planned('json=r.json')
    await checkOutputs(outputs)
    mkdirSync(join(root, 'r.json'))
    const failure = await writeOutputs(outputs, result, done).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/^--output json: cannot be written \(E[A-Z]+\)$/)
  })
})
