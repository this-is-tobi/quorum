import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './index.ts'
import { runQuorum } from './index.ts'
import { isolateEnv } from './testing/env.ts'
import { chatReply, ollamaReply } from './testing/http.ts'

const diff = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1 +1 @@',
  '-safe()',
  '+exec(cmd)',
  'diff --git a/other.js b/other.js',
  '--- /dev/null',
  '+++ b/other.js',
  '@@ -0,0 +1 @@',
  '+UNRELATED',
].join('\n')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the public API', () => {
  it('exports createQuorum, defineConfig, fromConfig, loadConfig, the security profile, the default policy, the adapters, the presets, the errors, the sanitizer and runQuorum', () => {
    expect(Object.keys(api).sort()).toEqual(['ConfigError', 'OutputError', 'ProviderError', 'QuorumError', 'anthropic', 'claudeCode', 'createQuorum', 'defaultPolicy', 'defineConfig', 'fromConfig', 'gemini', 'inertJson', 'inertLine', 'loadConfig', 'ollama', 'openaiCompatible', 'presets', 'runQuorum', 'securityProfile'])
  })
})

describe('runQuorum', () => {
  it('builds its providers from process.env', async () => {
    isolateEnv({ RESEARCH_MODEL: 'env-model', RESEARCH_BASE_URL: 'http://env.example/v1', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' })
    const fetchMock = vi.fn().mockImplementation(async () => chatReply('{"findings":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    await runQuorum(diff)
    expect(fetchMock.mock.calls[0][0]).toBe('http://env.example/v1/chat/completions')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('env-model')
  })

  it('reports a missing research model as a configuration error, even for an empty diff', async () => {
    isolateEnv()
    const message = 'no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one'
    await expect(runQuorum(diff)).rejects.toMatchObject({ name: 'ConfigError', message })
    await expect(runQuorum('  \n')).rejects.toMatchObject({ name: 'ConfigError', message })
  })

  it('reports a provider with no context size as a configuration error, even for an empty diff, and sends nothing', async () => {
    isolateEnv({ RESEARCH_MODEL: 'env-model' })
    const fetchMock = vi.fn().mockImplementation(async () => chatReply('{"findings":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    const message = 'no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens'
    await expect(runQuorum(diff)).rejects.toMatchObject({ name: 'ConfigError', message })
    await expect(runQuorum('  \n')).rejects.toMatchObject({ name: 'ConfigError', message })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends onProgress the progress lines the CLI prints', async () => {
    isolateEnv({ RESEARCH_MODEL: 'env-model', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' })
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => ollamaReply(JSON.stringify({ findings: [{ file: 'a.js', line: 1, category: 'CWE-78', quote: 'exec(cmd)', summary: 'command injection' }] })))
      .mockImplementation(async () => ollamaReply(JSON.stringify({ keep: true, reasoning: 'r' }))))
    const lines: string[] = []
    await runQuorum(diff, line => lines.push(line))
    expect(lines).toEqual(['1 candidate(s) after dedup', '1 kept, 0 discarded, 0 unreviewed by panel'])
  })
})
