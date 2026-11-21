import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import { inertJson } from '../core/sanitize.ts'
import { VERSION } from '../core/version.ts'
import { publicView } from '../report/view.ts'
import { harness } from '../testing/cli.ts'
import { stubChat } from '../testing/http.ts'
import { reportResult } from '../testing/report.ts'
import { EXIT, runCli } from './main.ts'
import { readResultText, REPORT_USAGE } from './report.ts'

const DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'
const FINDING = {
  file: 'a.js',
  line: 1,
  category: 'CWE-78',
  quote: 'exec(cmd)',
  summary: 'command injection',
}
const MODEL = {
  QUORUM_RESEARCH_MODEL: 'm',
  QUORUM_RESEARCH_CONTEXT_TOKENS: '131072',
  QUORUM_RESEARCH_BASE_URL: 'http://localhost:11434/v1',
}
const vote = (keep: boolean): string => JSON.stringify({ keep, reasoning: 'r' })
const FORMATS = [
  'text',
  'json',
  'brief',
  'markdown',
  'payload',
  'sarif',
] as const

let cwd = ''
beforeEach(() => {
  // The review's own clock, pinned: two reviews of one input write one result, so a file of one equals a file of the other.
  vi.useFakeTimers({
    toFake: ['Date', 'performance'],
  })
  vi.setSystemTime(new Date('2026-11-16T00:00:00.000Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0)
  cwd = mkdtempSync(join(tmpdir(), 'quorum-report-'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true, maxRetries: 2 })
})

const read = (name: string): string => readFileSync(join(cwd, name), 'utf8')
const write = (name: string, text: string): void => writeFileSync(join(cwd, name), text)

/** One `quorum` run in the temporary directory, with a `fetch` stub that the run must not call. */
async function quorum(argv: string[], options: { stdin?: string, isTTY?: boolean } = {}): Promise<{ code: number, stdout: string, stderr: string, fetch: ReturnType<typeof vi.fn>, git: ReturnType<typeof vi.fn> }> {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const spawn = vi.fn()
  const { io, stdout, stderr } = harness({
    argv,
    cwd,
    env: {},
    git: { executable: '/usr/bin/git', spawn },
    ...options,
  })
  const code = await runCli(io)
  return {
    code,
    stdout: stdout(),
    stderr: stderr(),
    fetch,
    git: spawn,
  }
}

/** Review `DIFF` as the review command does, with every output in `outputs` written beside the JSON result, and return its stdout. */
async function review(argv: string[], replies: string[] = [
  JSON.stringify({
    findings: [FINDING],
  }),
  vote(true),
  vote(true),
  vote(true),
], endsIn?: Error): Promise<{ code: number, stdout: string }> {
  const fetchMock = stubChat(...replies)
  if (endsIn !== undefined) fetchMock.mockRejectedValue(endsIn)
  const { io, stdout } = harness({ argv, cwd, env: MODEL, stdin: DIFF })
  const code = await runCli(io)
  return {
    code,
    stdout: stdout(),
  }
}

function OUTPUTS(prefix: string): string[] {
  return [
    'text',
    'brief',
    'markdown',
    'payload',
    'sarif',
  ].flatMap(format => ['--output', `${format}=${prefix}${format}`])
}

describe('quorum report', () => {
  it('renders every format from a saved result as the review command did from the same run', async () => {
    const full = await review([
      '-f',
      'json',
      ...OUTPUTS('f-'),
    ])
    expect(full.code).toBe(EXIT.finding)
    write('r.json', full.stdout)
    for (const format of FORMATS) {
      const done = await quorum(['report', 'r.json', '-f', format])
      expect([done.code, done.stderr]).toEqual([EXIT.ok, ''])
      expect(done.stdout).toBe(format === 'json'
        ? full.stdout
        : read(`f-${format}`))
      expect(done.fetch).not.toHaveBeenCalled()
    }

    const hidden = await review([
      '-f',
      'json',
      '--view',
      'public',
      ...OUTPUTS('p-'),
    ])
    write('pub.json', hidden.stdout)
    expect(JSON.parse(hidden.stdout).meta.view).toBe('public')
    for (const format of FORMATS) {
      const done = await quorum(['report', 'pub.json', '-f', format])
      expect(done.stdout).toBe(format === 'json'
        ? hidden.stdout
        : read(`p-${format}`))
    }
    expect((await quorum([
      'report',
      'r.json',
      '--view',
      'public',
      '-f',
      'text',
    ])).stdout).toBe(read('p-text'))
    expect((await quorum([
      'report',
      'r.json',
      '--view',
      'public',
      '-f',
      'json',
    ])).stdout).toBe(hidden.stdout)

    const outputs = await quorum([
      'report',
      'r.json',
      '-f',
      'json',
      '--output',
      'sarif=again.sarif',
      '--output',
      'markdown=again.md',
    ])
    expect(outputs.stdout).toBe(full.stdout)
    expect(read('again.sarif')).toBe(read('f-sarif'))
    expect(read('again.md')).toBe(read('f-markdown'))

    const lifting = await review([
      '-f',
      'payload',
      '--allow-incomplete',
      '--output',
      'json=lifted.json',
    ], [
      JSON.stringify({
        findings: [FINDING],
      }),
    ], new TypeError('fetch failed'))
    expect(lifting.code).toBe(EXIT.ok)
    const lifted = await quorum([
      'report',
      'lifted.json',
      '--allow-incomplete',
      '-f',
      'payload',
    ])
    expect(lifted.stdout).toBe(lifting.stdout)
    const unlifted = await quorum([
      'report',
      'lifted.json',
      '-f',
      'payload',
    ])
    expect(unlifted.stdout).not.toBe(lifting.stdout)
  })

  it('reads the result from stdin with - or no argument, and refuses a terminal', async () => {
    const text = inertJson(reportResult({
      meta: { version: VERSION },
    }))
    const none = await quorum(['report', '-f', 'brief'], { stdin: text })
    const dash = await quorum(['report', '-', '-f', 'brief'], { stdin: text })
    expect([none.code, none.stderr]).toEqual([EXIT.ok, ''])
    expect(none.stdout).toContain('quorum: findings: 1 kept')
    expect(dash.stdout).toBe(none.stdout)

    const terminal = await quorum(['report'], { isTTY: true })
    expect([terminal.code, terminal.stdout, terminal.stderr]).toEqual([EXIT.usage, '', `Error: no result given\n${REPORT_USAGE}`])
    const refusing = await quorum(['report', '-'], { isTTY: true })
    expect(refusing.stderr).toBe(`Error: no result given\n${REPORT_USAGE}`)
  })

  const RELEASE = 'the result was written by another release of quorum: render it with the release that wrote it'
  const NOT_ONE = 'the result is not one quorum writes'

  it.each<[string, () => Promise<{ code: number, stdout: string, stderr: string }>, string]>([
    [
      'a result of another release',
      async () => {
        write('other.json', inertJson(reportResult({
          meta: { version: '0.0.1' },
        })))
        return quorum(['report', 'other.json'])
      },
      RELEASE,
    ],
    [
      'a truncated file',
      async () => {
        write('cut.json', inertJson(reportResult({
          meta: { version: VERSION },
        })).slice(0, 200))
        return quorum(['report', 'cut.json'])
      },
      'the result is not JSON',
    ],
    [
      'an empty file',
      async () => {
        write('empty.json', '')
        return quorum(['report', 'empty.json'])
      },
      'the result is not JSON',
    ],
    [
      'a public view with a usage key',
      async () => {
        const view = JSON.parse(inertJson(publicView(reportResult({
          meta: { version: VERSION },
        })))) as { meta: Record<string, unknown> }
        view.meta.usage = { inputTokens: 1, outputTokens: 1 }
        write('forged.json', JSON.stringify(view))
        return quorum(['report', 'forged.json'])
      },
      `${NOT_ONE}, at meta`,
    ],
    [
      'a missing file',
      async () => quorum(['report', 'missing.json']),
      'the result file does not exist',
    ],
    [
      'a directory',
      async () => {
        mkdirSync(join(cwd, 'dir'))
        return quorum(['report', 'dir'])
      },
      'the result file is a directory',
    ],
    [
      'two files',
      async () => quorum(['report', 'a.json', 'b.json']),
      'takes one result file, and 1 more argument(s) were given',
    ],
    [
      'a file over the cap',
      async () => {
        write('big.json', '{"kept":[]}')
        let message = ''
        try {
          await readResultText(cwd, 'big.json', harness().io.stdin, 10)
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError)
          message = (error as ConfigError).issues[0].message
        }
        return { code: EXIT.usage, stdout: '', stderr: `Error: ${message}\n${REPORT_USAGE}` }
      },
      'the result is over 256 MiB, the most quorum reads',
    ],
  ])('refuses %s with exit 2 and the usage, rendering nothing', async (_name, run, message) => {
    const done = await run()
    expect(done).toMatchObject({ code: EXIT.usage, stdout: '', stderr: `Error: ${message}\n${REPORT_USAGE}` })
    expect(done.stderr).not.toContain(cwd)
  })

  it('exits 0 whatever the review found, and 3 when an output cannot be written', async () => {
    const findings = reportResult({
      meta: { version: VERSION },
    })
    write('findings.json', inertJson(findings))
    write('pass.json', inertJson(reportResult({
      kept: [],
      unreviewed: [],
      discarded: [],
      meta: {
        version: VERSION,
        incomplete: [],
        leftOut: [],
        flags: [],
      },
    })))
    write('incomplete.json', inertJson(reportResult({
      kept: [],
      meta: { version: VERSION },
    })))
    for (const file of ['findings.json', 'pass.json', 'incomplete.json']) {
      expect((await quorum(['report', file, '-f', 'brief'])).code).toBe(EXIT.ok)
    }
    expect((await quorum([
      'report',
      'findings.json',
      '-f',
      'brief',
    ])).stdout).toContain('exit 1')
    expect((await quorum([
      'report',
      'incomplete.json',
      '-f',
      'brief',
    ])).stdout).toContain('exit 4')

    expect((await quorum([
      'report',
      'findings.json',
      '--output',
      'markdown=gone/m.md',
    ])).code).toBe(EXIT.usage)
    expect((await quorum([
      'report',
      'findings.json',
      '--output',
      'markdown=gone/m.md',
    ])).stderr).toBe(`Error: --output markdown: is in no directory\n${REPORT_USAGE}`)

    if (process.getuid?.() !== 0) {
      const closed = join(cwd, 'closed')
      mkdirSync(closed)
      chmodSync(closed, 0o555)
      try {
        const done = await quorum([
          'report',
          'findings.json',
          '-f',
          'brief',
          '--output',
          'markdown=closed/m.md',
        ])
        expect(done.code).toBe(EXIT.runtime)
        expect(done.stdout).toContain('quorum: findings')
        expect(done.stderr).toBe('Error: --output markdown: cannot be written (EACCES)\n')
      } finally {
        chmodSync(closed, 0o755)
      }
    }
  })

  it('renders a saved interrupted result with its verdict, and exits 0 once its report is written', async () => {
    write('interrupted.json', inertJson(reportResult({
      kept: [],
      meta: {
        version: VERSION,
        incomplete: [
          { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 2 of its 3 research parts' },
        ],
      },
    })))
    const brief = await quorum([
      'report',
      'interrupted.json',
      '-f',
      'brief',
    ])
    expect(brief.code).toBe(EXIT.ok)
    expect(brief.stdout).toContain('quorum: interrupted: ')
    expect(brief.stdout).toContain('exit 130')
    const text = await quorum([
      'report',
      'interrupted.json',
      '-f',
      'text',
    ])
    expect(text.code).toBe(EXIT.ok)
    expect(text.stdout).toContain('exit 130, interrupted: the review was stopped before its end; what it read is above')
    expect((await quorum([
      'report',
      'interrupted.json',
      '-f',
      'payload',
    ])).stdout).toMatch(/"conclusion": "interrupted"/)
    expect(text.fetch).not.toHaveBeenCalled()
  })

  it('prints its usage with -h, and calls no model and no git', async () => {
    write('r.json', inertJson(reportResult({
      meta: { version: VERSION },
    })))
    const help = await quorum(['report', '-h'])
    expect([help.code, help.stdout, help.stderr]).toEqual([EXIT.ok, REPORT_USAGE, ''])
    const done = await quorum([
      'report',
      'r.json',
      '-f',
      'markdown',
      '--view',
      'public',
    ])
    expect(done.code).toBe(EXIT.ok)
    for (const run of [help, done]) {
      expect(run.fetch).not.toHaveBeenCalled()
      expect(run.git).not.toHaveBeenCalled()
    }
    const lines = REPORT_USAGE.split('\n')
    for (const line of lines.slice(lines.indexOf('Options:') + 1).filter(line => line !== '')) {
      expect(line.slice(25, 27), line).toBe('  ')
      expect(line[27], line).not.toBe(' ')
    }
    expect((await quorum([
      'report',
      '--fail-on',
      'high',
      'r.json',
    ])).code).toBe(EXIT.usage)
  })
})
