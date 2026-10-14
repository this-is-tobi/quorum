import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, roleConfig } from './client.ts'
import { ConfigError } from './core/errors.ts'
import type { CompletionRequest } from './core/ports.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [{ role: 'user', content: 'data' }],
  output: { name: 'test', schema: {} },
}

const ENV_KEYS = ['RESEARCH_BASE_URL', 'RESEARCH_API_KEY', 'RESEARCH_MODEL', 'VOTER_BASE_URL', 'VOTER_API_KEY', 'VOTER_MODEL']
const original: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    original[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  vi.unstubAllGlobals()
})

describe('roleConfig', () => {
  it('falls back to defaults when nothing is set', () => {
    expect(roleConfig('RESEARCH')).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'not-needed',
      model: '',
    })
  })

  it('reads RESEARCH_* directly', () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    expect(roleConfig('RESEARCH').model).toBe('qwen3.6:27b')
  })

  it('falls VOTER_* back to RESEARCH_* when unset', () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    expect(roleConfig('VOTER').model).toBe('qwen3.6:27b')
  })

  it('lets VOTER_* override RESEARCH_* independently', () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    process.env.VOTER_MODEL = 'gpt-5.4'
    expect(roleConfig('VOTER').model).toBe('gpt-5.4')
    expect(roleConfig('RESEARCH').model).toBe('qwen3.6:27b')
  })

  it('never falls RESEARCH_* back to VOTER_* - fallback is one-directional', () => {
    process.env.VOTER_MODEL = 'gpt-5.4'
    expect(roleConfig('RESEARCH').model).toBe('')
  })
})

describe('chat', () => {
  it('throws a ConfigError naming the variable when the role model is unset', async () => {
    await expect(chat('RESEARCH', request)).rejects.toThrow(ConfigError)
    await expect(chat('RESEARCH', request)).rejects.toThrow(/RESEARCH_MODEL/)
  })

  it('returns the reply text untouched', async () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Sure: {"keep":true}' } }] }),
    }))
    await expect(chat('RESEARCH', request)).resolves.toBe('Sure: {"keep":true}')
  })

  it('returns an empty string when the reply has no content', async () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) }))
    await expect(chat('RESEARCH', request)).resolves.toBe('')
  })

  it('throws when the endpoint responds with an error status', async () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }))
    await expect(chat('RESEARCH', request)).rejects.toThrow('call failed: 500')
  })

  it('truncates long error bodies', async () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'x'.repeat(10_000) }))
    const error = (await chat('RESEARCH', request).catch((caught: Error) => caught)) as Error
    expect(error.message.length).toBeLessThan(600)
  })

  it('sends the instructions as a system message before the data', async () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) })
    vi.stubGlobal('fetch', fetchMock)
    await chat('RESEARCH', request)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toEqual([
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'data' },
    ])
  })
})
