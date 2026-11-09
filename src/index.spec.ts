import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './index.ts'
import { runQuorum } from './index.ts'
import { jsonReply } from './testing/http.ts'

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
  it('exports createQuorum, the security profile, the default policy, the adapters, the errors, the sanitizer and runQuorum', () => {
    expect(Object.keys(api).sort()).toEqual(['ConfigError', 'OutputError', 'ProviderError', 'QuorumError', 'anthropic', 'createQuorum', 'defaultPolicy', 'gemini', 'inertJson', 'inertLine', 'openaiCompatible', 'runQuorum', 'securityProfile'])
  })
})

describe('runQuorum', () => {
  it('builds its providers from process.env', async () => {
    vi.stubEnv('RESEARCH_MODEL', 'env-model')
    vi.stubEnv('RESEARCH_BASE_URL', 'http://env.example/v1')
    vi.stubEnv('RESEARCH_API_KEY', '')
    vi.stubEnv('VOTER_BASE_URL', '')
    vi.stubEnv('VOTER_API_KEY', '')
    vi.stubEnv('VOTER_MODEL', '')
    const fetchMock = vi.fn().mockImplementation(async () => jsonReply({ choices: [{ message: { content: '{"findings":[]}' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await runQuorum(diff)
    expect(fetchMock.mock.calls[0][0]).toBe('http://env.example/v1/chat/completions')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('env-model')
  })

  it('reports a missing research model as a configuration error, even for an empty diff', async () => {
    vi.stubEnv('RESEARCH_MODEL', '')
    await expect(runQuorum(diff)).rejects.toThrow(/RESEARCH_MODEL/)
    await expect(runQuorum('  \n')).rejects.toThrow(/RESEARCH_MODEL/)
  })

  it('sends onProgress the progress lines the CLI prints', async () => {
    vi.stubEnv('RESEARCH_MODEL', 'env-model')
    vi.stubEnv('RESEARCH_BASE_URL', '')
    vi.stubEnv('RESEARCH_API_KEY', '')
    vi.stubEnv('VOTER_BASE_URL', '')
    vi.stubEnv('VOTER_API_KEY', '')
    vi.stubEnv('VOTER_MODEL', '')
    const content = (text: string): Response => jsonReply({ choices: [{ message: { content: text } }] })
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => content(JSON.stringify({ findings: [{ file: 'a.js', line: 1, category: 'CWE-78', quote: 'exec(cmd)', summary: 'command injection' }] })))
      .mockImplementation(async () => content(JSON.stringify({ keep: true, reasoning: 'r' }))))
    const lines: string[] = []
    await runQuorum(diff, line => lines.push(line))
    expect(lines).toEqual(['1 candidate(s) after dedup', '1 kept, 0 discarded, 0 unreviewed by panel'])
  })
})
