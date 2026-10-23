import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT, runCli } from './main.ts'
import type { CliIO } from './main.ts'

const ENV_KEYS = ['RESEARCH_BASE_URL', 'RESEARCH_API_KEY', 'RESEARCH_MODEL', 'VOTER_BASE_URL', 'VOTER_API_KEY', 'VOTER_MODEL']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.unstubAllGlobals()
})

const DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'
/** Two added lines, so two findings can be cited. */
const TWO_LINE_DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-safe()\n+exec(cmd)\n+eval(x)\n'
const SECOND_FINDING = { file: 'a.js', line: 2, category: 'CWE-95', quote: 'eval(x)', summary: 'code injection' }
const FINDING = { file: 'a.js', line: 1, category: 'CWE-78', quote: 'exec(cmd)', summary: 'command injection' }
const vote = (keep: boolean): string => JSON.stringify({ keep, reasoning: 'r' })

function harness(options: { argv?: string[], stdin?: string, isTTY?: boolean } = {}): { io: CliIO, stdout: () => string, stderr: () => string } {
  const out: string[] = []
  const err: string[] = []
  async function* chunks(): AsyncGenerator<string> {
    if (options.stdin !== undefined) yield options.stdin
  }
  const io: CliIO = {
    argv: options.argv ?? [],
    stdin: Object.assign(chunks(), { isTTY: options.isTTY ?? false }),
    stdout: { write: text => out.push(text) },
    stderr: { write: text => err.push(text) },
  }
  return { io, stdout: () => out.join(''), stderr: () => err.join('') }
}

function stubModel(...replies: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn()
  for (const content of replies) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('runCli', () => {
  it('exits 2 with usage instead of waiting on an interactive terminal', async () => {
    const fetchMock = stubModel()
    const { io, stderr } = harness({ isTTY: true })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toContain('Usage:')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 2 when the diff file does not exist', async () => {
    const { io } = harness({ argv: ['does-not-exist.diff'] })
    expect(await runCli(io)).toBe(EXIT.usage)
  })

  it('exits 0 without calling the model for an empty diff', async () => {
    process.env.RESEARCH_MODEL = 'm'
    const fetchMock = stubModel()
    const { io, stdout } = harness({ stdin: '  \n' })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(stdout())).toMatchObject({ kept: [], discarded: [] })
  })

  it('exits 2 when no model is configured', async () => {
    stubModel()
    const { io, stderr } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toContain('RESEARCH_MODEL')
  })

  it('exits 3 when the model endpoint fails', async () => {
    process.env.RESEARCH_MODEL = 'm'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const { io } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
  })

  it('exits 1 on a unanimous finding and prints the result as JSON', async () => {
    process.env.RESEARCH_MODEL = 'm'
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true), vote(true))
    const { io, stdout } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(JSON.parse(stdout()).kept[0]).toMatchObject({ file: 'a.js', confidence: 'high' })
  })

  it('exits 0 when the panel keeps a finding only at medium confidence', async () => {
    process.env.RESEARCH_MODEL = 'm'
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true), vote(false))
    const { io, stdout } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]).toMatchObject({ file: 'a.js', confidence: 'medium', keptVotes: 2 })
  })

  it('exits 0 when the panel discards every finding', async () => {
    process.env.RESEARCH_MODEL = 'm'
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(false), vote(false), vote(true))
    const { io } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
  })

  it('exits 4 when every voter fails, instead of reading the outage as a clean review', async () => {
    process.env.RESEARCH_MODEL = 'm'
    stubModel(JSON.stringify({ findings: [FINDING] })).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout, stderr } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toEqual([])
    expect(result.discarded).toEqual([])
    expect(result.unreviewed).toHaveLength(1)
    expect(stderr()).toContain('1 unreviewed')
  })

  it('exits 4 when the research reply lists only unusable findings', async () => {
    process.env.RESEARCH_MODEL = 'm'
    const fetchMock = stubModel(JSON.stringify({ findings: [{ file: 'x.js' }] }))
    const { io, stdout, stderr } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const reasons = JSON.parse(stdout()).meta.incomplete.map((entry: { reason: string }) => entry.reason)
    expect(reasons).toEqual(['finding-unreadable', 'research-unusable'])
    expect(stderr()).toContain('research-unusable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exits 4 when one finding is unreadable, even though another is kept', async () => {
    process.env.RESEARCH_MODEL = 'm'
    stubModel(JSON.stringify({ findings: [FINDING, { file: 'a.js' }] }), vote(true), vote(true), vote(false))
    const { io, stdout, stderr } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.meta.incomplete).toEqual([{ reason: 'finding-unreadable', detail: expect.stringMatching(/^findings\[1\]: /) }])
    expect(stderr()).toContain('finding-unreadable')
  })

  it('exits 1 when a high finding is kept, even if another finding is unreviewed', async () => {
    process.env.RESEARCH_MODEL = 'm'
    stubModel(JSON.stringify({ findings: [FINDING, SECOND_FINDING] }), vote(true), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ stdin: TWO_LINE_DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.unreviewed).toHaveLength(1)
  })

  it('exits 0 when a failed vote could not have changed a discard', async () => {
    process.env.RESEARCH_MODEL = 'm'
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(false), vote(false)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.discarded).toHaveLength(1)
    expect(result.unreviewed).toEqual([])
  })
})
