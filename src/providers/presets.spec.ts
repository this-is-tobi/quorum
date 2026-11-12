import { describe, expect, it } from 'vitest'
import type { StructuredOutput } from './options.ts'
import { presets } from './presets.ts'
import type { Protocol } from './presets.ts'

/** The structured-output modes each protocol's adapter supports. */
const MODES: Record<Protocol, readonly StructuredOutput[]> = {
  'openai-compatible': ['prompt', 'json', 'schema'],
  anthropic: ['prompt', 'schema'],
  gemini: ['prompt', 'json', 'schema'],
  ollama: ['prompt', 'json', 'schema'],
}

describe('presets', () => {
  it('holds one row per preset, with the defaults its vendor documents', () => {
    const chat = { protocol: 'openai-compatible', auth: 'bearer' }
    expect(presets).toEqual({
      ollama: {
        protocol: 'ollama',
        baseUrl: 'http://localhost:11434',
        auth: 'bearer',
        structuredOutput: 'json',
        temperature: 0,
        toolModels: [],
      },
      'ollama-cloud': {
        protocol: 'ollama',
        baseUrl: 'https://ollama.com',
        auth: 'bearer',
        apiKeyEnv: 'OLLAMA_API_KEY',
        structuredOutput: 'json',
        temperature: 0,
        toolModels: [],
      },
      lmstudio: {
        ...chat,
        baseUrl: 'http://localhost:1234/v1',
        structuredOutput: 'schema',
        temperature: 0,
        maxTokensField: 'max_tokens',
        toolModels: [],
      },
      llamacpp: {
        ...chat,
        baseUrl: 'http://127.0.0.1:9931/v1',
        structuredOutput: 'json',
        temperature: 0,
        maxTokensField: 'max_tokens',
        toolModels: [],
      },
      vllm: {
        ...chat,
        baseUrl: 'http://localhost:8000/v1',
        structuredOutput: 'json',
        temperature: 0,
        maxTokensField: 'max_tokens',
        toolModels: [],
      },
      openai: {
        ...chat,
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        structuredOutput: 'json',
        temperature: null,
        maxTokensField: 'max_completion_tokens',
        toolModels: ['*search*', '*computer-use*'],
      },
      'azure-openai': {
        protocol: 'openai-compatible',
        auth: { header: 'api-key' },
        apiKeyEnv: 'AZURE_OPENAI_API_KEY',
        structuredOutput: 'json',
        temperature: null,
        maxTokensField: 'max_completion_tokens',
        toolModels: [],
      },
      openrouter: {
        ...chat,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        structuredOutput: 'prompt',
        temperature: 0,
        maxTokensField: 'max_tokens',
        toolModels: [
          '*:online*',
          '*@preset/*',
          'openrouter/fusion*',
          'openrouter/auto*',
          'perplexity/*',
          '*search*',
        ],
      },
      groq: {
        ...chat,
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKeyEnv: 'GROQ_API_KEY',
        structuredOutput: 'json',
        temperature: 0,
        maxTokensField: 'max_completion_tokens',
        toolModels: ['openai/gpt-oss-*', 'groq/compound*', 'compound-beta*'],
      },
      mistral: {
        ...chat,
        baseUrl: 'https://api.mistral.ai/v1',
        apiKeyEnv: 'MISTRAL_API_KEY',
        structuredOutput: 'json',
        temperature: 0,
        maxTokensField: 'max_tokens',
        toolModels: [],
      },
      deepseek: {
        ...chat,
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        structuredOutput: 'json',
        temperature: 0,
        maxTokensField: 'max_tokens',
        toolModels: [],
      },
      together: {
        ...chat,
        baseUrl: 'https://api.together.ai/v1',
        apiKeyEnv: 'TOGETHER_API_KEY',
        structuredOutput: 'json',
        temperature: 0,
        maxTokensField: 'max_tokens',
        toolModels: [],
      },
      fireworks: {
        ...chat,
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        apiKeyEnv: 'FIREWORKS_API_KEY',
        structuredOutput: 'json',
        temperature: 0,
        maxTokensField: 'max_tokens',
        toolModels: [],
      },
      xai: {
        ...chat,
        baseUrl: 'https://api.x.ai/v1',
        apiKeyEnv: 'XAI_API_KEY',
        structuredOutput: 'json',
        temperature: 0,
        maxTokensField: 'max_completion_tokens',
        toolModels: ['*multi-agent*'],
      },
      anthropic: {
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        auth: 'bearer',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        structuredOutput: 'schema',
        temperature: null,
        toolModels: [],
      },
      gemini: {
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        auth: { header: 'x-goog-api-key' },
        apiKeyEnv: 'GEMINI_API_KEY',
        structuredOutput: 'json',
        temperature: null,
        toolModels: ['*deep-research*', '*antigravity*', '*computer-use*'],
      },
    })
  })

  it('is frozen through and through: the table, each row, its auth and its toolModels', () => {
    expect(Object.isFrozen(presets)).toBe(true)
    for (const [name, preset] of Object.entries(presets)) {
      expect([
        Object.isFrozen(preset),
        Object.isFrozen(preset.auth),
        Object.isFrozen(preset.toolModels),
      ], name).toEqual([true, true, true])
    }
  })

  it('throws a TypeError on any change, and keeps its values', () => {
    expect(() => {
      (presets.openai as { baseUrl?: string }).baseUrl = 'http://evil.example'
    }).toThrow(TypeError)
    expect(() => (presets.openai.toolModels as string[]).push('gpt-*')).toThrow(TypeError)
    expect(() => {
      (presets['azure-openai'].auth as { header: string }).header = 'x-evil'
    }).toThrow(TypeError)
    expect(() => {
      (presets as Record<string, unknown>).evil = presets.openai
    }).toThrow(TypeError)
    expect(presets.openai.baseUrl).toBe('https://api.openai.com/v1')
    expect(presets.openai.toolModels).toEqual(['*search*', '*computer-use*'])
    expect(presets['azure-openai'].auth).toEqual({ header: 'api-key' })
    expect(Object.keys(presets)).toHaveLength(16)
  })

  it('fills in a structured-output mode its protocol supports', () => {
    for (const [name, { protocol, structuredOutput }] of Object.entries(presets)) expect(MODES[protocol], name).toContain(structuredOutput)
  })
})
