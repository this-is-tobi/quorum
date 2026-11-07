import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from './core/errors.ts'
import type { CompletionRequest } from './core/ports.ts'
import { providersFromEnv, roleSettings } from './legacy.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [{ role: 'user', content: 'data' }],
  output: { name: 'panel_vote', schema: {} },
}

const replyOk = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('roleSettings', () => {
  it('falls back to the local Ollama endpoint, no key and no model', () => {
    expect(roleSettings('RESEARCH', {})).toEqual({ baseUrl: 'http://localhost:11434/v1', apiKey: undefined, model: '' })
  })

  it('reads RESEARCH_* directly', () => {
    expect(roleSettings('RESEARCH', { RESEARCH_MODEL: 'qwen3.6:27b' }).model).toBe('qwen3.6:27b')
  })

  it('falls every VOTER_* field back to RESEARCH_*, and never the reverse', () => {
    const research = { RESEARCH_BASE_URL: 'https://r.example/v1', RESEARCH_API_KEY: 'sk-r', RESEARCH_MODEL: 'r' }
    expect(roleSettings('VOTER', research)).toEqual({ baseUrl: 'https://r.example/v1', apiKey: 'sk-r', model: 'r' })
    const voter = { VOTER_BASE_URL: 'https://v.example/v1', VOTER_API_KEY: 'sk-v', VOTER_MODEL: 'v' }
    expect(roleSettings('RESEARCH', voter)).toEqual({ baseUrl: 'http://localhost:11434/v1', apiKey: undefined, model: '' })
  })

  it('lets VOTER_* override RESEARCH_* independently', () => {
    const env = { RESEARCH_MODEL: 'qwen3.6:27b', VOTER_MODEL: 'gpt-5.4' }
    expect(roleSettings('VOTER', env).model).toBe('gpt-5.4')
    expect(roleSettings('RESEARCH', env).model).toBe('qwen3.6:27b')
  })

  it('trims surrounding whitespace, as fetch always did with a header value, and treats a blank value as unset', () => {
    const env = { RESEARCH_MODEL: ' qwen ', RESEARCH_API_KEY: ' sk-test\n', RESEARCH_BASE_URL: ' http://h/v1\r\n', VOTER_MODEL: '  ', VOTER_API_KEY: ' ' }
    expect(roleSettings('RESEARCH', env)).toEqual({ baseUrl: 'http://h/v1', apiKey: 'sk-test', model: 'qwen' })
    expect(roleSettings('VOTER', env)).toEqual({ baseUrl: 'http://h/v1', apiKey: 'sk-test', model: 'qwen' })
    expect(roleSettings('RESEARCH', { RESEARCH_API_KEY: ' \n' }).apiKey).toBeUndefined()
  })

  it('treats every empty variable as unset', () => {
    const env = { RESEARCH_MODEL: 'qwen3.6:27b', RESEARCH_API_KEY: '', RESEARCH_BASE_URL: '', VOTER_MODEL: '', VOTER_BASE_URL: '' }
    expect(roleSettings('RESEARCH', env)).toEqual({ baseUrl: 'http://localhost:11434/v1', apiKey: undefined, model: 'qwen3.6:27b' })
    expect(roleSettings('VOTER', env)).toEqual({ baseUrl: 'http://localhost:11434/v1', apiKey: undefined, model: 'qwen3.6:27b' })
  })
})

describe('providersFromEnv', () => {
  it('throws a ConfigError naming RESEARCH_MODEL when it is unset, even if VOTER_MODEL is set', () => {
    expect(() => providersFromEnv({})).toThrow(ConfigError)
    expect(() => providersFromEnv({ VOTER_MODEL: 'gpt-5.4' })).toThrow(/RESEARCH_MODEL/)
  })

  it('builds one provider per role, named after the role', () => {
    const { research, voter } = providersFromEnv({ RESEARCH_MODEL: 'qwen', VOTER_MODEL: 'gpt' })
    expect([research.id, research.model, voter.id, voter.model]).toEqual(['research', 'qwen', 'voter', 'gpt'])
  })

  it('reproduces the request of the first import: the Ollama URL, json_object and temperature 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(replyOk)
    vi.stubGlobal('fetch', fetchMock)
    await providersFromEnv({ RESEARCH_MODEL: 'qwen' }).voter.complete(request)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(JSON.parse(init.body)).toMatchObject({ model: 'qwen', response_format: { type: 'json_object' }, temperature: 0 })
  })

  it('sends no authorization header unless a key is set, and never a placeholder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(replyOk)
    vi.stubGlobal('fetch', fetchMock)
    await providersFromEnv({ RESEARCH_MODEL: 'qwen' }).research.complete(request)
    await providersFromEnv({ RESEARCH_MODEL: 'qwen', RESEARCH_API_KEY: 'sk-test' }).research.complete(request)
    await providersFromEnv({ RESEARCH_MODEL: 'qwen', RESEARCH_API_KEY: 'sk-test\n' }).research.complete(request)
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('authorization')
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ authorization: 'Bearer sk-test' })
    expect(fetchMock.mock.calls[2][1].headers).toMatchObject({ authorization: 'Bearer sk-test' })
  })

  it('refuses a key with a character an HTTP header cannot carry, without repeating it', () => {
    const env = { RESEARCH_MODEL: 'qwen', RESEARCH_API_KEY: `sk-te${String.fromCharCode(10)}st` }
    expect(() => providersFromEnv(env)).toThrow(ConfigError)
    expect(() => providersFromEnv(env)).toThrow(/research\.apiKey/)
    expect(() => providersFromEnv(env)).not.toThrow(/sk-/)
  })

  it('refuses a base URL without a scheme, a common slip', () => {
    expect(() => providersFromEnv({ RESEARCH_MODEL: 'qwen', RESEARCH_BASE_URL: 'localhost:11434/v1' })).toThrow(/research\.baseUrl/)
  })
})
