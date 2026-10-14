import { describe, expect, it, vi } from 'vitest'
import type { Finding } from './core/types.ts'

vi.mock('./client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client.ts')>()
  return { ...actual, chatJSON: vi.fn() }
})

const { chatJSON } = await import('./client.ts')
const { dedup, panel } = await import('./pipeline.ts')
const mockChatJSON = vi.mocked(chatJSON)

const finding: Finding = {
  file: 'a.js',
  line: 1,
  category: 'CWE-78',
  sink: 'exec(cmd)',
  summary: 'command injection',
}

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
    mockChatJSON.mockResolvedValue({ keep: true, reasoning: 'convinced' })
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(3)
    expect(verdict.confidence).toBe('high')
  })

  it('caps confidence at medium on a 2/3 split', async () => {
    mockChatJSON
      .mockResolvedValueOnce({ keep: true, reasoning: 'a' })
      .mockResolvedValueOnce({ keep: true, reasoning: 'b' })
      .mockResolvedValueOnce({ keep: false, reasoning: 'c' })
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(2)
    expect(verdict.confidence).toBe('medium')
  })

  it('discards on a 0/3 split', async () => {
    mockChatJSON.mockResolvedValue({ keep: false, reasoning: 'not convinced' })
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(0)
    expect(verdict.confidence).toBeUndefined()
  })

  it('counts a failed vote as a discard for that lens, not a crash', async () => {
    mockChatJSON
      .mockResolvedValueOnce({ keep: true, reasoning: 'a' })
      .mockResolvedValueOnce({ keep: true, reasoning: 'b' })
      .mockRejectedValueOnce(new Error('endpoint down'))
    const verdict = await panel(finding)
    expect(verdict.keptVotes).toBe(2)
    expect(verdict.confidence).toBe('medium')
    expect(verdict.votes[2]).toMatchObject({ angle: 'defenses', vote: null, error: 'endpoint down' })
  })
})
