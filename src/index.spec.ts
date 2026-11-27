import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './index.ts'
import { fileStore, readContext, readSource, runQuorum, securityProfile } from './index.ts'
import type { ReportRequest, ResolvedConfig } from './index.ts'
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
  it('exports createQuorum, defineConfig, fileStore, fromConfig, loadConfig, outcome, readContext, readSource, renderReport, the security, code-review, best-practices and performance profiles, the default policy, the adapters, the presets, the errors, the sanitizer, cleanProse, publicView, readResult, reviewSettings and runQuorum', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ConfigError',
      'GitError',
      'INTERRUPT_GRACE_MS',
      'LANE_START',
      'OutputError',
      'ProviderDownError',
      'ProviderError',
      'QuorumError',
      'REVIEW_CEILING',
      'anthropic',
      'bestPracticesProfile',
      'claudeCode',
      'cleanProse',
      'codeReviewProfile',
      'codeSpan',
      'createQuorum',
      'defaultPolicy',
      'defineConfig',
      'fencedBlock',
      'fileStore',
      'fromConfig',
      'gemini',
      'inertJson',
      'inertLine',
      'inertPlain',
      'loadConfig',
      'ollama',
      'openaiCompatible',
      'outcome',
      'performanceProfile',
      'presets',
      'publicView',
      'readContext',
      'readResult',
      'readSource',
      'renderReport',
      'reviewSettings',
      'runQuorum',
      'securityProfile',
    ])
  })
})

describe('fileStore', () => {
  it('opens a state directory for the providers of a resolved config, and keeps a call for each of them', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-index-')))
    try {
      const providers = {
        api: {
          protocol: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'm',
          contextTokens: 8192,
        },
      } as const
      const store = await fileStore(join(root, 'state'), { providers })
      const call = {
        reply: { text: '{"findings":[]}', model: 'm' },
      }
      await store.put({ key: 'k', provider: 'api' }, call)
      expect(await store.get({ key: 'k', provider: 'api' })).toEqual(call)
      // A provider the config does not hold has no identity: nothing is kept for it.
      await store.put({ key: 'k', provider: 'ghost' }, call)
      expect(readdirSync(join(root, 'state'))).toHaveLength(2)
      // A raised deadline or retry count is the same provider, so the call is still kept for it; another model is a miss.
      const raised = {
        api: { ...providers.api, timeoutMs: 900_000, retries: 5 },
      }
      expect(await (await fileStore(join(root, 'state'), { providers: raised })).get({ key: 'k', provider: 'api' })).toEqual(call)
      const another = {
        api: { ...providers.api, model: 'n' },
      }
      expect(await (await fileStore(join(root, 'state'), { providers: another })).get({ key: 'k', provider: 'api' })).toBeUndefined()
      // The directory is refused as the CLI refuses it.
      writeFileSync(join(root, 'plain'), 'x')
      await expect(fileStore(join(root, 'plain'), { providers })).rejects.toThrow('--state: is not a directory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('readSource', () => {
  const context = {
    cwd: process.cwd(),
    env: {},
  }

  it('reads a source through the package\'s readSource, with the platform filled in', async () => {
    await expect(readSource({ kind: 'diff', text: diff }, context)).resolves.toEqual({
      diff,
      source: { kind: 'diff' },
      leftOut: [],
    })

    // The package takes no platform and no git: a git source refuses on the one of the process, before it spawns anything.
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
    try {
      await expect(readSource({ kind: 'range', range: 'a...b' }, context)).rejects.toMatchObject({
        name: 'ConfigError',
        issues: [
          { path: '--range', message: 'the git sources run on Linux and macOS: on Windows, pipe a diff in' },
        ],
      })
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })

  it('refuses a source of a kind it does not know, as a ConfigError', async () => {
    const unknown = { kind: 'nope' } as unknown as Parameters<typeof readSource>[0]
    await expect(readSource(unknown, context)).rejects.toMatchObject({
      name: 'ConfigError',
      issues: [
        { path: 'kind', message: 'must be diff, range, local, staged or paths' },
      ],
    })
  })
})

describe('readContext', () => {
  const config: ResolvedConfig = {
    providers: {},
    profiles: [
      {
        profile: securityProfile,
        research: 'p',
        voters: Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, 'p'])),
        repository: [],
      },
    ],
    warnings: [],
  }

  it('takes the reports to read and the scan root they were written at, and reads them as data', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-index-')))
    try {
      writeFileSync(join(root, 'scan.sarif'), JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            tool: {
              driver: { name: 'Semgrep' },
            },
            results: [
              {
                ruleId: 'js.exec',
                message: { text: 'user input reaches a command' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'file:///scan/a.js' },
                      region: { startLine: 1 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }))
      // The path is the working directory's own, and a diff has no repository to open.
      const reports: ReportRequest[] = [
        { format: 'sarif', path: 'scan.sarif' },
      ]
      const rooted = await readContext(config, {
        source: { kind: 'diff' },
        cwd: root,
        env: {},
        reports,
        scanRoot: '/scan',
      })
      expect(rooted.reports?.map(report => [
        report.profile,
        report.scanner,
        report.issues.map(issue => issue.path),
      ])).toEqual([
        [
          'security',
          'Semgrep',
          ['a.js'],
        ],
      ])
      const bare = await readContext(config, {
        source: { kind: 'diff' },
        cwd: root,
        env: {},
        reports,
      })
      expect(bare.reports?.[0].issues.map(issue => issue.unmapped)).toEqual([true])
      await expect(readContext(config, {
        source: { kind: 'diff' },
        cwd: root,
        env: {},
        reports,
        scanRoot: 'scan',
      })).rejects.toMatchObject({
        name: 'ConfigError',
        issues: [
          { path: 'scanRoot', message: 'must be an absolute directory' },
        ],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  it('sends the files the config\'s send names, held as secrets otherwise, as the CLI does with no flag', async () => {
    const env = 'diff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+MODE=production\n'
    const dir = mkdtempSync(join(tmpdir(), 'quorum-index-'))
    try {
      const bodiesOf = async (config: string | undefined): Promise<string> => {
        const variables: Record<string, string> = { RESEARCH_MODEL: 'env-model', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' }
        if (config !== undefined) {
          const file = join(dir, 'quorum.yaml')
          writeFileSync(file, config)
          variables.QUORUM_CONFIG = file
        }
        isolateEnv(variables)
        const fetchMock = vi.fn().mockImplementation(async () => ollamaReply('{"findings":[]}'))
        vi.stubGlobal('fetch', fetchMock)
        await runQuorum(`${env}${diff}`)
        return fetchMock.mock.calls.map(call => String(call[1].body)).join('\n')
      }
      expect(await bodiesOf(undefined)).not.toContain('MODE=production')
      expect(await bodiesOf('send:\n  - .env\n')).toContain('+MODE=production')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a config that lists a repository document, at each entry and before any call, since it can pass no context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-index-'))
    try {
      const file = join(dir, 'quorum.yaml')
      writeFileSync(file, [
        'profiles:',
        '  security:',
        '    guidelines: [{repository: REVIEW.md}]',
        '    doNotReport: [{repository: SKIP.md, optional: true}]',
        '    rules: [{id: inline, text: Written in the config.}, {repository: RULES.yaml}]',
        '',
      ].join('\n'))
      isolateEnv({ RESEARCH_MODEL: 'env-model', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072', QUORUM_CONFIG: file })
      const fetchMock = vi.fn().mockImplementation(async () => chatReply('{"findings":[]}'))
      vi.stubGlobal('fetch', fetchMock)
      const message = 'reads a document of the repository, which runQuorum cannot read: build the quorum with fromConfig and pass readContext\'s context to review'
      const refusal = {
        name: 'ConfigError',
        issues: [
          { path: 'profiles.security.guidelines.0.repository', message },
          { path: 'profiles.security.doNotReport.0.repository', message },
          { path: 'profiles.security.rules.1.repository', message },
        ],
      }
      await expect(runQuorum(diff)).rejects.toMatchObject(refusal)
      await expect(runQuorum('  \n')).rejects.toMatchObject(refusal)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends onProgress the progress lines the CLI prints', async () => {
    isolateEnv({ RESEARCH_MODEL: 'env-model', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' })
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => ollamaReply(JSON.stringify({
        findings: [
          {
            file: 'a.js',
            line: 1,
            category: 'CWE-78',
            quote: 'exec(cmd)',
            summary: 'command injection',
          },
        ],
      })))
      .mockImplementation(async () => ollamaReply(JSON.stringify({ keep: true, reasoning: 'r' }))))
    const lines: string[] = []
    await runQuorum(diff, line => lines.push(line))
    // The JSON stub answers a streamed request whole, so the provider is moved to whole replies, said once.
    expect(lines).toEqual([
      'default: its calls ask for whole replies for the rest of the review: the server answered a streamed call whole; set stream: false to choose it yourself',
      expect.stringMatching(/^part 1 of 1: answered in \d+(\.\d)?s, \d+(\.\d+)?[kM]? tokens, 1 finding\(s\) listed$/),
      '1 candidate(s) after dedup',
      '1 kept, 0 discarded, 0 unreviewed by panel',
    ])
  })
})
