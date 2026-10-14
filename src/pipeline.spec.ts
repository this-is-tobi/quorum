import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputError } from './core/errors.ts'
import type { Finding } from './core/types.ts'

vi.mock('./client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client.ts')>()
  return { ...actual, chat: vi.fn() }
})

const { chat } = await import('./client.ts')
const { dedup, panel, research } = await import('./pipeline.ts')
const mockChat = vi.mocked(chat)

const finding: Finding = {
  file: 'a.js',
  line: 1,
  category: 'CWE-78',
  sink: 'exec(cmd)',
  summary: 'command injection',
}

const vote = (keep: boolean, reasoning = 'r'): string => JSON.stringify({ keep, reasoning })

beforeEach(() => {
  mockChat.mockReset()
})

describe('research', () => {
  it('fails closed on a reply without a findings array', async () => {
    mockChat.mockResolvedValue('{"result":"nothing to report"}')
    await expect(research('diff')).rejects.toThrow(OutputError)
  })

  it('keeps valid findings and reports invalid ones', async () => {
    mockChat.mockResolvedValue(JSON.stringify({ findings: [finding, { file: 'x.js' }] }))
    const result = await research('diff')
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
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(3)
    expect(verdict.confidence).toBe('high')
  })

  it('caps confidence at medium on a 2/3 split', async () => {
    mockChat
      .mockResolvedValueOnce(vote(true, 'a'))
      .mockResolvedValueOnce(vote(true, 'b'))
      .mockResolvedValueOnce(vote(false, 'c'))
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(2)
    expect(verdict.confidence).toBe('medium')
  })

  it('discards on a 0/3 split', async () => {
    mockChat.mockResolvedValue(vote(false, 'not convinced'))
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(0)
    expect(verdict.confidence).toBeUndefined()
  })

  it('counts a failed vote as a discard for that lens, not a crash', async () => {
    mockChat
      .mockResolvedValueOnce(vote(true, 'a'))
      .mockResolvedValueOnce(vote(true, 'b'))
      .mockRejectedValueOnce(new Error('endpoint down'))
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(2)
    expect(verdict.confidence).toBe('medium')
    expect(verdict.votes[2]).toMatchObject({ angle: 'defenses', vote: null, error: 'endpoint down' })
  })

  it('counts an unparseable vote as a discard for that lens', async () => {
    mockChat
      .mockResolvedValueOnce(vote(true))
      .mockResolvedValueOnce(vote(true))
      .mockResolvedValueOnce('I cannot answer in JSON')
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(2)
    expect(verdict.votes[2]).toMatchObject({ angle: 'defenses', vote: null })
    expect(verdict.votes[2].error).toMatch(/vote reply unusable/)
  })
})
