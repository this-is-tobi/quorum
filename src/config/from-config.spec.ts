import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionRequest, CompletionResponse } from '../core/ports.ts'
import type { Quorum, QuorumEvent } from '../core/types.ts'
import { isolateEnv } from '../testing/env.ts'
import { chatReply, sent } from '../testing/http.ts'
import { fromConfig } from './from-config.ts'
import { resolveConfig } from './resolve.ts'
import type { ConfigInput } from './schema.ts'

const SECRET = 'sk-planted-secret'
const diff = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1 +1 @@', '-safe()', '+exec(cmd)'].join('\n')
const finding = JSON.stringify({ findings: [{ file: 'a.js', line: 1, category: 'CWE-78', quote: 'exec(cmd)', summary: 'command injection' }] })

/** A fetch stub answering the research call with one finding, and every vote with a keep. */
function stubReview(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementationOnce(async () => chatReply(finding)).mockImplementation(async () => chatReply(JSON.stringify({ keep: true, reasoning: 'r' })))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The issues of the ConfigError that building `config` throws, with no variable set (a variable aimed at a provider object would be an issue of its own). */
async function issuesOf(config: unknown): Promise<readonly ConfigIssue[]> {
  try {
    await fromConfig(config as ConfigInput, { env: {} })
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).issues
  }
  return []
}

/** How a provider's complete getter changes its answer from the read it is told: undefined from then on, a throw from then on, or undefined once and a throw after. */
const CHANGES = ['becomes undefined', 'throws', 'becomes undefined, then throws'] as const
type Change = typeof CHANGES[number]

/** A provider object whose complete getter answers until read `reads`, and then changes as `change` says. */
function changingProvider(change: Change, reads: number): unknown {
  let seen = 0
  return {
    model: 'm',
    get complete() {
      seen += 1
      if (seen < reads) return async (): Promise<CompletionResponse> => ({ text: '{"findings":[]}', model: 'm' })
      if (change === 'throws' || (change === 'becomes undefined, then throws' && seen > reads)) throw new Error('SECRET')
      return undefined
    },
  }
}

/** What building a quorum from `config` comes to: its provider answering a review, or the issues of the ConfigError. Any other error fails the test. */
async function outcomeOf(config: unknown): Promise<'answers' | readonly ConfigIssue[]> {
  let quorum: Quorum
  try {
    quorum = await fromConfig(config as ConfigInput, { env: {} })
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).message).not.toContain('SECRET')
    return (error as ConfigError).issues
  }
  const result = await quorum.review({ diff })
  expect(result.meta.profiles.security.providers.research).toEqual({ id: 'mine', model: 'm' })
  return 'answers'
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('fromConfig', () => {
  it('builds the providers of an environment-only config and reviews with them, the research key never reaching the voter', async () => {
    const fetchMock = stubReview()
    const env = { QUORUM_RESEARCH_MODEL: 'qwen', QUORUM_RESEARCH_API_KEY: 'sk-r', QUORUM_VOTER_BASE_URL: 'https://api.mistral.ai/v1', QUORUM_VOTER_MODEL: 'mistral-small-latest', QUORUM_VOTER_API_KEY: 'sk-m', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072', QUORUM_VOTER_CONTEXT_TOKENS: '131072' }
    const result = await (await fromConfig({}, { env })).review({ diff })
    expect(sent(fetchMock, 0)).toMatchObject({ url: 'http://localhost:11434/v1/chat/completions', headers: { authorization: 'Bearer sk-r' } })
    expect(fetchMock.mock.calls).toHaveLength(4)
    for (const call of [1, 2, 3]) {
      expect(sent(fetchMock, call)).toMatchObject({ url: 'https://api.mistral.ai/v1/chat/completions', headers: { authorization: 'Bearer sk-m' } })
      expect(JSON.stringify(fetchMock.mock.calls[call])).not.toContain('sk-r')
    }
    const voter = { id: 'voter', model: 'mistral-small-latest' }
    expect(result.meta.profiles.security.providers).toEqual({ research: { id: 'default', model: 'qwen' }, lenses: { reachability: voter, impact: voter, defenses: voter } })
  })

  it('hands the events of a review to options.events, the run first and its end last', async () => {
    stubReview()
    const events: QuorumEvent[] = []
    await (await fromConfig({}, { env: { QUORUM_RESEARCH_MODEL: 'qwen', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' }, events: event => events.push(event) })).review({ diff })
    expect(events[0]).toMatchObject({ type: 'run:start', profiles: ['security'], providers: { security: { research: { id: 'default', model: 'qwen' } } } })
    expect(events.at(-1)).toMatchObject({ type: 'run:end', kept: 1 })
    expect(events.filter(event => event.type === 'call')).toHaveLength(4)
  })

  it('resolves a ConfigInput with process.env when no environment is given', async () => {
    isolateEnv({ QUORUM_RESEARCH_MODEL: 'from-process', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' })
    const fetchMock = stubReview()
    await (await fromConfig({})).review({ diff })
    expect(sent(fetchMock).body.model).toBe('from-process')
  })

  it('uses a resolved config as it is, without reading the environment again', async () => {
    const fetchMock = stubReview()
    const config = resolveConfig({}, { env: { QUORUM_RESEARCH_MODEL: 'resolved', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' } })
    await (await fromConfig(config, { env: { QUORUM_RESEARCH_MODEL: 'other', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' } })).review({ diff })
    expect(sent(fetchMock).body.model).toBe('resolved')
  })

  it('checks a ConfigInput as a code config is checked, so a caller gets issues, never a TypeError', async () => {
    expect(await issuesOf('nope')).toEqual([{ path: 'config', message: 'must be an object' }])
    expect(await issuesOf({ concurrency: 0 })).toEqual([{ path: 'concurrency', message: 'must be at least 1' }])
    expect(await issuesOf({ profiles: { team: { prompts: { research: { file: 'r.md' } } } } })).toEqual([{ path: 'profiles.team.prompts.research', message: 'must be a string' }])
  })

  it('refuses a __proto__ key in a ConfigInput, and changes no prototype', async () => {
    expect(await issuesOf(JSON.parse('{"providers":{"__proto__":{"polluted":true}}}'))).toEqual([{ path: 'providers.__proto__', message: 'is not allowed as a key: it can replace the prototype of an object' }])
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('reports a ConfigInput whose getter throws by the error\'s name alone', async () => {
    const issues = await issuesOf({ get providers(): never {
      throw new Error('sk-zz-secret')
    } })
    expect(issues).toEqual([{ path: 'config', message: 'could not be read (Error)' }])
  })

  it('refuses a config while a baseUrl is planted on Object.prototype, and sends no request', async () => {
    const fetchMock = stubReview()
    const proto = Object.prototype as Record<string, unknown>
    proto.baseUrl = 'https://evil.example/v1'
    try {
      const issues = await issuesOf({ providers: { p: { preset: 'openai', model: 'gpt-5', contextTokens: 131072, apiKeyEnv: 'OPENAI_API_KEY' } } })
      expect(issues).toEqual([{ path: 'baseUrl', message: 'is not a known field' }])
    } finally {
      delete proto.baseUrl
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('wraps a provider object under its config key, reading its model and complete once', async () => {
    let reads = 0
    let calledOnObject = false
    const mine = {
      id: 'own-id',
      get model() {
        reads += 1
        return 'm'
      },
      async complete(this: unknown, _request: CompletionRequest): Promise<CompletionResponse> {
        calledOnObject = this === mine
        return { text: '{"findings":[]}', model: 'm' }
      },
    }
    const result = await (await fromConfig({ providers: { mine } }, { env: {} })).review({ diff })
    expect(result.meta.profiles.security.providers.research).toEqual({ id: 'mine', model: 'm' })
    expect(reads).toBe(1)
    expect(calledOnObject).toBe(true)
  })

  it('reports a provider object whose model cannot be read by the error\'s name alone, and one whose model is no string', async () => {
    const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
    expect(await issuesOf({ providers: { mine: { get model(): never {
      throw new Error('sk-zz-secret')
    }, complete } } })).toEqual([{ path: 'config', message: 'could not be read (Error)' }])
    expect(await issuesOf({ providers: { mine: { model: 7, complete } } })).toEqual([{ path: 'providers.mine.model', message: 'must be a string' }])
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('a provider whose complete getter throws from read %i on never has its message printed', async (reads) => {
    let seen = 0
    const mine = {
      model: 'm',
      get complete() {
        seen += 1
        if (seen >= reads) throw new Error(SECRET)
        return async (): Promise<CompletionResponse> => ({ text: '{"findings":[]}', model: 'm' })
      },
    }
    const issues = await issuesOf({ providers: { mine } })
    expect([[], [{ path: 'config', message: 'could not be read (Error)' }]]).toContainEqual(issues)
    expect(JSON.stringify(issues)).not.toContain(SECRET)
  })

  it.each(CHANGES.flatMap(change => [1, 2, 3, 4, 5, 6, 7, 8].map(reads => ({ change, reads }))))('a provider whose complete getter changes at read $reads ($change) is never read after the guard', async ({ change, reads }) => {
    const outcome = await outcomeOf({ providers: { mine: changingProvider(change, reads) } })
    expect(JSON.stringify(outcome)).not.toContain('SECRET')
  })

  it('lists the config\'s warnings, then the core\'s', async () => {
    const config: ConfigInput = { profiles: { team: { prompts: { research: 'Find it.', vote: 'Judge {{lens.id}}: {{lens.question}}' }, lenses: [{ id: 'one', question: 'Real?' }] } } }
    const expected = ['RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead', 'team.policy.medium needs the same 1 vote(s) as policy.high with 1 lens(es), so it never applies']
    const env = { RESEARCH_MODEL: 'q', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' }
    expect((await fromConfig(config, { env })).warnings).toEqual(expected)
    expect((await fromConfig(resolveConfig(config, { env }))).warnings).toEqual(expected)
  })

  it('sends nothing when a provider is invalid', async () => {
    const fetchMock = stubReview()
    await expect(fromConfig({ providers: { local: { preset: 'ollama', model: 'q', contextTokens: 131072, maxTokens: 0 } } }, { env: {} })).rejects.toThrow(ConfigError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
