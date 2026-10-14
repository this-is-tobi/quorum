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

const DIFF = 'diff --git a/a.js b/a.js\n+exec(cmd)\n'
const FINDING = { file: 'a.js', line: 1, category: 'CWE-78', sink: 'exec(cmd)', summary: 'command injection' }
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

  it('exits 0 when the panel discards every finding', async () => {
    process.env.RESEARCH_MODEL = 'm'
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(false), vote(false), vote(true))
    const { io } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
  })
})
