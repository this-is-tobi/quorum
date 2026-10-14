import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputError } from './core/errors.ts'
import { createLimiter } from './core/concurrency.ts'
import type { Finding } from './core/types.ts'

vi.mock('./client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client.ts')>()
  return { ...actual, chat: vi.fn() }
})

const { chat } = await import('./client.ts')
const { dedup, panel, research, runQuorum } = await import('./pipeline.ts')
const mockChat = vi.mocked(chat)

const finding: Finding = {
  file: 'a.js',
  line: 1,
  category: 'CWE-78',
  sink: 'exec(cmd)',
  summary: 'command injection',
}

const vote = (keep: boolean, reasoning = 'r'): string => JSON.stringify({ keep, reasoning })
const limit = createLimiter(4)

beforeEach(() => {
  mockChat.mockReset()
})

describe('research', () => {
  it('fails closed on a reply without a findings array', async () => {
    mockChat.mockResolvedValue('{"result":"nothing to report"}')
    await expect(research('diff', limit)).rejects.toThrow(OutputError)
  })

  it('keeps valid findings and reports invalid ones', async () => {
    mockChat.mockResolvedValue(JSON.stringify({ findings: [finding, { file: 'x.js' }] }))
    const result = await research('diff', limit)
    expect(result.findings).toEqual([finding])
    expect(result.invalid).toHaveLength(1)
  })
})

describe('dedup', () => {
  it('drops repeats keyed by file:line:category', () => {
    const a = { ...finding }
    const b = { ...finding, line: 2 }
    expect(dedup([a, b, a])).toEqual([a, b])
  })

  it('keeps findings that differ only by category', () => {
    const a = { ...finding }
    const b = { ...finding, category: 'CWE-89' }
    expect(dedup([a, b])).toEqual([a, b])
  })
})

describe('panel', () => {
  it('grants high confidence on a unanimous 3/3 keep', async () => {
    mockChat.mockResolvedValue(vote(true, 'convinced'))
    const verdict = await panel(finding, '+exec(cmd)', limit)
    expect(verdict.keptVotes).toBe(3)
    expect(verdict.confidence).toBe('high')
  })

  it('caps confidence at medium on a 2/3 split', async () => {
    mockChat
      .mockResolvedValueOnce(vote(true, 'a'))
      .mockResolvedValueOnce(vote(true, 'b'))
      .mockResolvedValueOnce(vote(false, 'c'))
    const verdict = await panel(finding, '+exec(cmd)', limit)
    expect(verdict.keptVotes).toBe(2)
    expect(verdict.confidence).toBe('medium')
  })

  it('discards on a 0/3 split', async () => {
    mockChat.mockResolvedValue(vote(false, 'not convinced'))
    const verdict = await panel(finding, '+exec(cmd)', limit)
    expect(verdict.keptVotes).toBe(0)
    expect(verdict.confidence).toBeUndefined()
  })

  it('counts a failed vote as a discard for that lens, not a crash', async () => {
    mockChat
      .mockResolvedValueOnce(vote(true, 'a'))
      .mockResolvedValueOnce(vote(true, 'b'))
      .mockRejectedValueOnce(new Error('endpoint down'))
    const verdict = await panel(finding, '+exec(cmd)', limit)
    expect(verdict.keptVotes).toBe(2)
    expect(verdict.confidence).toBe('medium')
    expect(verdict.votes[2]).toMatchObject({ angle: 'defenses', vote: null, error: 'endpoint down' })
  })

  it('counts an unparseable vote as a discard for that lens', async () => {
    mockChat
      .mockResolvedValueOnce(vote(true))
      .mockResolvedValueOnce(vote(true))
      .mockResolvedValueOnce('I cannot answer in JSON')
    const verdict = await panel(finding, '+exec(cmd)', limit)
    expect(verdict.keptVotes).toBe(2)
    expect(verdict.votes[2]).toMatchObject({ angle: 'defenses', vote: null })
    expect(verdict.votes[2].error).toMatch(/vote reply unusable/)
  })
})

describe('runQuorum', () => {
  it('returns without any model call for an empty diff', async () => {
    await expect(runQuorum('  \n')).resolves.toEqual({ kept: [], discarded: [] })
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('gives voters the diff section of the cited file only', async () => {
    const diff = 'diff --git a/a.js b/a.js\n+exec(cmd)\ndiff --git a/other.js b/other.js\n+UNRELATED'
    mockChat.mockResolvedValueOnce(JSON.stringify({ findings: [finding] })).mockResolvedValue(vote(true))
    await runQuorum(diff)
    const voteContents = mockChat.mock.calls.slice(1).map(([, request]) => request.messages[0].content)
    expect(voteContents).toHaveLength(3)
    for (const content of voteContents) {
      expect(content).toContain('+exec(cmd)')
      expect(content).not.toContain('UNRELATED')
    }
  })

  it('never has more than four model calls in flight', async () => {
    const findings = [1, 2, 3].map(line => ({ ...finding, line }))
    let active = 0
    let peak = 0
    mockChat.mockResolvedValueOnce(JSON.stringify({ findings }))
    mockChat.mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return vote(true)
    })
    await runQuorum('diff --git a/a.js b/a.js\n+exec(cmd)')
    expect(mockChat).toHaveBeenCalledTimes(10)
    expect(peak).toBe(4)
  })
})
