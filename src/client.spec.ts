import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatJSON, roleConfig } from './client.ts'

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

describe('chatJSON', () => {
  it('throws when the role model is unset', async () => {
    await expect(chatJSON('RESEARCH', 'prompt')).rejects.toThrow('RESEARCH_MODEL is not set')
  })

  it('extracts JSON even when the model wraps it in prose', async () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Sure, here you go:\n{"keep":true,"reasoning":"ok"}\nHope that helps!' } }],
      }),
    }))
    const result = await chatJSON('RESEARCH', 'prompt')
    expect(result).toEqual({ keep: true, reasoning: 'ok' })
  })

  it('throws a descriptive error when the reply has no JSON', async () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'no json here' } }] }),
    }))
    await expect(chatJSON('RESEARCH', 'prompt')).rejects.toThrow('had no JSON')
  })

  it('throws when the endpoint responds with an error status', async () => {
    process.env.RESEARCH_MODEL = 'qwen3.6:27b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }))
    await expect(chatJSON('RESEARCH', 'prompt')).rejects.toThrow('call failed: 500')
  })
})
