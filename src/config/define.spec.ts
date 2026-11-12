import { describe, expect, it } from 'vitest'
import type { CompletionResponse, Provider } from '../core/ports.ts'
import type { QuorumConfig, QuorumConfigFile } from '../index.ts'
import { defineConfig } from './define.ts'

const mine: Provider = {
  id: 'mine',
  model: 'm',
  complete: async (): Promise<CompletionResponse> => ({ text: '{}', model: 'm' }),
}

describe('defineConfig', () => {
  it('returns the config it is given, as it is', () => {
    const config: QuorumConfig = {
      providers: {
        local: { preset: 'ollama', model: 'qwen3.6:27b' },
      },
    }
    expect(defineConfig(config)).toBe(config)
  })

  it('takes what a code config may hold, a key and a provider object, and every data config', () => {
    const code = {
      providers: {
        keyed: { preset: 'openai', apiKey: 'sk-k' },
        mine,
      },
      roles: { research: 'mine' },
    } satisfies QuorumConfig
    const data: QuorumConfigFile = {
      version: 1,
      providers: {
        local: { preset: 'ollama', apiKeyEnv: 'OLLAMA_KEY' },
      },
    }
    expect(defineConfig(code)).toBe(code)
    expect(defineConfig(data)).toBe(data)
    const _keyed: QuorumConfigFile = {
      providers: {
        // @ts-expect-error a data config names the variable that holds a key, and never holds one
        p: { apiKey: 'sk-k' },
      },
    }
  })
})
