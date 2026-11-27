import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentSha256 } from '../core/documents.ts'
import { ConfigError, ProviderError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { CompletionRequest, CompletionResponse } from '../core/ports.ts'
import { researchRequest } from '../core/prompts.ts'
import { requestTokens } from '../core/tokens.ts'
import type { Quorum, QuorumEvent, ReviewDocument, ScannerIssue } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import { isolateEnv } from '../testing/env.ts'
import { chatReply, ollamaReply, sent } from '../testing/http.ts'
import { fromConfig } from './from-config.ts'
import { resolveConfig } from './resolve.ts'
import type { ConfigInput } from './schema.ts'

const SECRET = 'sk-planted-secret'
const diff = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1 +1 @@',
  '-safe()',
  '+exec(cmd)',
].join('\n')
const finding = JSON.stringify({
  findings: [
    {
      file: 'a.js',
      line: 1,
      category: 'CWE-78',
      quote: 'exec(cmd)',
      summary: 'command injection',
    },
  ],
})

/** A fetch stub answering the research call with one finding, and every vote with a keep, each as `research` and `votes` shape a reply: OpenAI-compatible unless a protocol is given. */
function stubReview(research: (content: string) => Response = chatReply, votes: (content: string) => Response = research): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementationOnce(async () => research(finding)).mockImplementation(async () => votes(JSON.stringify({ keep: true, reasoning: 'r' })))
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
    const fetchMock = stubReview(ollamaReply, chatReply)
    const env = {
      QUORUM_RESEARCH_MODEL: 'qwen',
      QUORUM_RESEARCH_API_KEY: 'sk-r',
      QUORUM_VOTER_BASE_URL: 'https://api.mistral.ai/v1',
      QUORUM_VOTER_MODEL: 'mistral-small-latest',
      QUORUM_VOTER_API_KEY: 'sk-m',
      QUORUM_RESEARCH_CONTEXT_TOKENS: '131072',
      QUORUM_VOTER_CONTEXT_TOKENS: '131072',
    }
    const result = await (await fromConfig({}, { env })).review({ diff })
    expect(sent(fetchMock, 0)).toMatchObject({
      url: 'http://localhost:11434/api/chat',
      headers: { authorization: 'Bearer sk-r' },
    })
    expect(fetchMock.mock.calls).toHaveLength(4)
    for (const call of [1, 2, 3]) {
      expect(sent(fetchMock, call)).toMatchObject({
        url: 'https://api.mistral.ai/v1/chat/completions',
        headers: { authorization: 'Bearer sk-m' },
      })
      expect(JSON.stringify(fetchMock.mock.calls[call])).not.toContain('sk-r')
    }
    const voter = { id: 'voter', model: 'mistral-small-latest' }
    expect(result.meta.profiles.security.providers).toEqual({
      research: { id: 'default', model: 'qwen' },
      lenses: { reachability: voter, impact: voter, defenses: voter },
    })
  })

  it('hands the events of a review to options.events, the run first and its end last', async () => {
    stubReview(ollamaReply)
    const events: QuorumEvent[] = []
    await (await fromConfig({}, {
      env: { QUORUM_RESEARCH_MODEL: 'qwen', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
      events: event => events.push(event),
    })).review({ diff })
    expect(events[0]).toMatchObject({
      type: 'run:start',
      profiles: ['security'],
      providers: {
        security: {
          research: { id: 'default', model: 'qwen' },
        },
      },
    })
    expect(events.at(-1)).toMatchObject({ type: 'run:end', kept: 1 })
    expect(events.filter(event => event.type === 'call')).toHaveLength(4)
  })

  it('resolves a ConfigInput with process.env when no environment is given', async () => {
    isolateEnv({ QUORUM_RESEARCH_MODEL: 'from-process', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' })
    const fetchMock = stubReview(ollamaReply)
    await (await fromConfig({})).review({ diff })
    expect(sent(fetchMock).body.model).toBe('from-process')
  })

  it('uses a resolved config as it is, without reading the environment again', async () => {
    const fetchMock = stubReview(ollamaReply)
    const config = resolveConfig({}, {
      env: { QUORUM_RESEARCH_MODEL: 'resolved', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
    })
    await (await fromConfig(config, {
      env: { QUORUM_RESEARCH_MODEL: 'other', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
    })).review({ diff })
    expect(sent(fetchMock).body.model).toBe('resolved')
  })

  it('checks a ConfigInput as a code config is checked, so a caller gets issues, never a TypeError', async () => {
    expect(await issuesOf('nope')).toEqual([
      { path: 'config', message: 'must be an object' },
    ])
    expect(await issuesOf({ concurrency: 0 })).toEqual([
      { path: 'concurrency', message: 'must be at least 1' },
    ])
    expect(await issuesOf({
      profiles: {
        team: {
          prompts: {
            research: { file: 'r.md' },
          },
        },
      },
    })).toEqual([
      { path: 'profiles.team.prompts.research', message: 'must be a string' },
    ])
  })

  it('takes a program\'s { text } documents, as the loader gives them', async () => {
    const fetchMock = stubReview(ollamaReply)
    const guideline = 'Name things for what they do.'
    const skipped = 'Generated files.'
    const quorum = await fromConfig({
      profiles: {
        naming: {
          prompts: { research: 'Find naming issues.', vote: 'Judge from {{lens.id}}: {{lens.question}}' },
          lenses: [
            { id: 'grounded', question: 'Is it backed by a convention?' },
          ],
          guidelines: [
            { text: guideline },
          ],
          doNotReport: [
            { text: skipped },
          ],
        },
      },
    }, {
      env: { QUORUM_RESEARCH_MODEL: 'qwen', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
    })
    const result = await quorum.review({ diff })
    const bodies = fetchMock.mock.calls.map((_, call) => JSON.stringify(sent(fetchMock, call).body))
    // The research asks for what to skip and the votes never see it; every request carries the guideline.
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.every(body => body.includes(guideline))).toBe(true)
    expect(bodies[0]).toContain(`This review does not report:\\n${skipped}`)
    expect(bodies.slice(1).some(body => body.includes(skipped))).toBe(false)
    expect(result.meta.context.documents).toEqual([
      {
        profile: 'naming',
        kind: 'guidelines',
        origin: 'config',
        sha256: documentSha256(guideline),
        status: 'read',
        bytes: guideline.length,
        removed: { characters: 0, comments: 0, entities: 0 },
      },
      {
        profile: 'naming',
        kind: 'do-not-report',
        origin: 'config',
        sha256: documentSha256(skipped),
        status: 'read',
        bytes: skipped.length,
        removed: { characters: 0, comments: 0, entities: 0 },
      },
    ])
  })

  it('refuses a { file } document in a ConfigInput, which reads no file, and a document over its cap, at its entry', async () => {
    const team = {
      prompts: { research: 'r', vote: 'v' },
      lenses: [
        { id: 'a', question: 'q' },
      ],
    }
    const providers = {
      local: {
        protocol: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        model: 'm',
        contextTokens: 131072,
      },
    }
    expect(await issuesOf({
      providers,
      profiles: {
        team: {
          ...team,
          guidelines: [
            { file: 'g.md' },
          ],
        },
      },
    })).toEqual([
      { path: 'profiles.team.guidelines.0', message: 'must be { text } or { repository }' },
    ])
    expect(await issuesOf({
      providers,
      profiles: {
        team: {
          ...team,
          guidelines: [
            {
              text: 'x'.repeat(16_385),
            },
          ],
        },
      },
    })).toEqual([
      { path: 'profiles.team.guidelines.0', message: 'holds 16385 bytes once cleaned, over the 16 KiB a guidelines document may hold' },
    ])
  })

  it('refuses a review whose context lacks a document for a repository entry, and takes one with it', async () => {
    const fetchMock = stubReview(ollamaReply)
    const quorum = await fromConfig({
      profiles: {
        naming: {
          prompts: { research: 'Find naming issues.', vote: 'Judge from {{lens.id}}: {{lens.question}}' },
          lenses: [
            { id: 'grounded', question: 'Is it backed by a convention?' },
          ],
          guidelines: [
            { repository: 'REVIEW.md' },
            { repository: 'ADDENDUM.md', optional: true },
          ],
          doNotReport: [
            { repository: 'SKIP.md' },
          ],
          rules: [
            { repository: 'RULES.yaml' },
            { repository: 'MORE.json', optional: true },
          ],
        },
      },
    }, {
      env: { QUORUM_RESEARCH_MODEL: 'local', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
    })
    const commit = 'a'.repeat(40)
    const source = { kind: 'local', head: commit, objectFormat: 'sha1' } as const
    const document = (path: string, kind: ReviewDocument['kind'], text?: string, profile = 'naming'): ReviewDocument => ({
      profile,
      kind,
      origin: { kind: 'repository', path, commit },
      ...text === undefined
        ? {}
        : { text },
    })
    // A rules document holds `rules` where another holds `text`: absent for a file the commit lacks.
    const rulesDocument = (path: string, rules?: Array<{ id: string, text: string }>): ReviewDocument => ({
      profile: 'naming',
      kind: 'rules',
      origin: { kind: 'repository', path, commit },
      ...rules === undefined
        ? {}
        : { rules },
    })
    const unread = (path: string): string => `"${path}" was not read for this review: pass the context readContext reads to the estimate and the review`
    const refused = [
      {
        path: 'profiles.naming.guidelines.0.repository',
        message: unread('REVIEW.md'),
      },
      {
        path: 'profiles.naming.guidelines.1.repository',
        message: unread('ADDENDUM.md'),
      },
      {
        path: 'profiles.naming.doNotReport.0.repository',
        message: unread('SKIP.md'),
      },
      {
        path: 'profiles.naming.rules.0.repository',
        message: unread('RULES.yaml'),
      },
      {
        path: 'profiles.naming.rules.1.repository',
        message: unread('MORE.json'),
      },
    ]
    const issuesOfCall = async (call: () => unknown): Promise<readonly ConfigIssue[]> => {
      const error: unknown = await Promise.resolve().then(call).then(() => undefined, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(ConfigError)
      return (error as ConfigError).issues
    }

    // No context, an empty one, one that is no object, and documents of another kind, path or profile each leave every entry unread.
    for (const context of [
      undefined,
      {},
      { documents: [] },
      'REVIEW.md',
      {
        documents: [
          document('REVIEW.md', 'do-not-report'),
          document('OTHER.md', 'guidelines'),
          document('SKIP.md', 'do-not-report', 'x', 'other'),
          // A text is no rules: a guidelines document at the rules file's path reads none of it.
          document('RULES.yaml', 'guidelines', 'x'),
          document('MORE.json', 'do-not-report', 'x'),
        ],
      },
    ]) {
      expect(await issuesOfCall(() => quorum.review({ diff, source, context: context as never }))).toEqual(refused)
      expect(await issuesOfCall(() => quorum.estimate({ diff, context: context as never }))).toEqual(refused)
    }
    expect(await issuesOfCall(() => quorum.review(diff as never))).toEqual(refused)
    // One entry left unread is named alone.
    expect(await issuesOfCall(() => quorum.review({
      diff,
      source,
      context: {
        documents: [
          document('REVIEW.md', 'guidelines', 'Name things.'),
          document('SKIP.md', 'do-not-report', 'Generated files.'),
          rulesDocument('RULES.yaml', [
            { id: 'no-any', text: 'No any.' },
          ]),
          rulesDocument('MORE.json'),
        ],
      },
    }))).toEqual([
      {
        path: 'profiles.naming.guidelines.1.repository',
        message: unread('ADDENDUM.md'),
      },
    ])
    // A required entry whose document holds no text is as unread as one with no document, for a review and an estimate; only an
    // optional entry may be missing.
    const unfound = {
      documents: [
        document('REVIEW.md', 'guidelines'),
        document('ADDENDUM.md', 'guidelines'),
        document('SKIP.md', 'do-not-report'),
        rulesDocument('RULES.yaml'),
        rulesDocument('MORE.json'),
      ],
    }
    const required = [
      {
        path: 'profiles.naming.guidelines.0.repository',
        message: unread('REVIEW.md'),
      },
      {
        path: 'profiles.naming.doNotReport.0.repository',
        message: unread('SKIP.md'),
      },
      {
        path: 'profiles.naming.rules.0.repository',
        message: unread('RULES.yaml'),
      },
    ]
    expect(await issuesOfCall(() => quorum.review({ diff, source, context: unfound }))).toEqual(required)
    expect(await issuesOfCall(() => quorum.estimate({ diff, context: unfound }))).toEqual(required)
    expect(fetchMock).not.toHaveBeenCalled()

    // A document for every entry, one of them missing while optional, is a context the review takes.
    const context = {
      documents: [
        document('REVIEW.md', 'guidelines', 'Name things.'),
        document('ADDENDUM.md', 'guidelines'),
        document('SKIP.md', 'do-not-report', 'Generated files.'),
        rulesDocument('RULES.yaml', [
          { id: 'no-any', text: 'No any.' },
        ]),
        rulesDocument('MORE.json'),
      ],
    }
    expect(() => quorum.estimate({ diff, context })).not.toThrow()
    const result = await quorum.review({ diff, source, context })
    const none = { characters: 0, comments: 0, entities: 0 }
    const record = {
      profile: 'naming',
      origin: 'repository',
      commit,
      removed: none,
    }
    expect(result.meta.context.documents).toEqual([
      {
        ...record,
        kind: 'guidelines',
        path: 'REVIEW.md',
        status: 'read',
        bytes: 12,
      },
      {
        ...record,
        kind: 'guidelines',
        path: 'ADDENDUM.md',
        status: 'missing',
        bytes: 0,
      },
      {
        ...record,
        kind: 'do-not-report',
        path: 'SKIP.md',
        status: 'read',
        bytes: 16,
      },
      {
        ...record,
        kind: 'rules',
        path: 'RULES.yaml',
        status: 'read',
        bytes: 31,
        rules: 1,
      },
      {
        ...record,
        kind: 'rules',
        path: 'MORE.json',
        status: 'missing',
        bytes: 0,
        rules: 0,
      },
    ])
    expect(fetchMock).toHaveBeenCalled()
  })

  it('refuses a __proto__ key in a ConfigInput, and changes no prototype', async () => {
    expect(await issuesOf(JSON.parse('{"providers":{"__proto__":{"polluted":true}}}'))).toEqual([
      { path: 'providers.__proto__', message: 'is not allowed as a key: it can replace the prototype of an object' },
    ])
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('reports a ConfigInput whose getter throws by the error\'s name alone', async () => {
    const issues = await issuesOf({
      get providers(): never {
        throw new Error('sk-zz-secret')
      },
    })
    expect(issues).toEqual([
      { path: 'config', message: 'could not be read (Error)' },
    ])
  })

  it('refuses a config while a baseUrl is planted on Object.prototype, and sends no request', async () => {
    const fetchMock = stubReview()
    const proto = Object.prototype as Record<string, unknown>
    proto.baseUrl = 'https://evil.example/v1'
    try {
      const issues = await issuesOf({
        providers: {
          p: {
            preset: 'openai',
            model: 'gpt-5',
            contextTokens: 131072,
            apiKeyEnv: 'OPENAI_API_KEY',
          },
        },
      })
      expect(issues).toEqual([
        { path: 'baseUrl', message: 'is not a known field' },
      ])
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
    const result = await (await fromConfig({
      providers: { mine },
    }, { env: {} })).review({ diff })
    expect(result.meta.profiles.security.providers.research).toEqual({ id: 'mine', model: 'm' })
    expect(reads).toBe(1)
    expect(calledOnObject).toBe(true)
  })

  it('reports a provider object whose model cannot be read by the error\'s name alone, and one whose model is no string', async () => {
    const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
    expect(await issuesOf({
      providers: {
        mine: {
          get model(): never {
            throw new Error('sk-zz-secret')
          },
          complete,
        },
      },
    })).toEqual([
      { path: 'config', message: 'could not be read (Error)' },
    ])
    expect(await issuesOf({
      providers: {
        mine: { model: 7, complete },
      },
    })).toEqual([
      { path: 'providers.mine.model', message: 'must be a string' },
    ])
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
    const issues = await issuesOf({
      providers: { mine },
    })
    expect([
      [],
      [
        { path: 'config', message: 'could not be read (Error)' },
      ],
    ]).toContainEqual(issues)
    expect(JSON.stringify(issues)).not.toContain(SECRET)
  })

  it.each(CHANGES.flatMap(change => [1, 2, 3, 4, 5, 6, 7, 8].map(reads => ({ change, reads }))))('a provider whose complete getter changes at read $reads ($change) is never read after the guard', async ({ change, reads }) => {
    const outcome = await outcomeOf({
      providers: {
        mine: changingProvider(change, reads),
      },
    })
    expect(JSON.stringify(outcome)).not.toContain('SECRET')
  })

  it('hands a code config\'s provider object\'s stated retries to the review, so the call it states them for is retried', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResponse>>()
        .mockRejectedValueOnce(new ProviderError({ providerId: 'mine', kind: 'network', message: 'down' }))
        .mockResolvedValue({ text: '{"findings":[]}', model: 'm' })
      const config = {
        providers: {
          mine: { model: 'm', retries: 1, complete },
        },
      }
      await expect((await fromConfig(config, { env: {} })).review({ diff })).resolves.toBeDefined()
      expect(complete).toHaveBeenCalledTimes(2)
    } finally {
      random.mockRestore()
    }
  })

  it('hands the review\'s limits to the quorum it builds', async () => {
    const complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResponse>>()
      .mockResolvedValue({ text: '{"findings":[]}', model: 'm' })
    const result = await (await fromConfig({
      providers: {
        mine: { model: 'm', complete },
      },
      maxReviewTokens: 10,
    }, { env: {} })).review({ diff })
    expect(result.meta.incomplete).toEqual([
      { profile: 'security', reason: 'token-cap', detail: 'the review\'s token cap of 10 tokens stopped its research' },
    ])
    expect(complete).not.toHaveBeenCalled()
  })

  it('hands a code config\'s provider object\'s stated worstCase to the review', async () => {
    const complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResponse>>()
      .mockResolvedValue({ text: '{"findings":[]}', model: 'm' })
    const worstCase = vi.fn<(request: CompletionRequest) => number>().mockReturnValue(50)
    const mine = { model: 'm', complete, worstCase }
    const refused = await (await fromConfig({
      providers: { mine },
      maxReviewTokens: 49,
    }, { env: {} })).review({ diff })
    expect(refused.meta.incomplete).toEqual([
      { profile: 'security', reason: 'token-cap', detail: 'the review\'s token cap of 49 tokens stopped its research' },
    ])
    expect(complete).not.toHaveBeenCalled()
    // The size the object states is below the core's own count of a request, so only its worstCase lets this cap hold the call.
    const sent = await (await fromConfig({
      providers: { mine },
      maxReviewTokens: 1000,
    }, { env: {} })).review({ diff })
    expect(sent.meta.incomplete).toEqual([])
    expect(complete).toHaveBeenCalledTimes(1)
    expect(worstCase).toHaveBeenCalledTimes(2)
  })

  it('hands a code config\'s provider object\'s stated window, maxTokens and thinking to the review, which sizes each reply from them', async () => {
    const complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResponse>>()
      .mockResolvedValue({ text: '{"findings":[]}', model: 'm' })
    await (await fromConfig({
      providers: {
        mine: {
          model: 'm',
          complete,
          window: 8192,
          thinking: 'off',
        },
      },
    }, { env: {} })).review({ diff })
    // A window of 8192 with no thinking: a quarter of it, 2048 tokens, which hold 7 findings.
    const request = complete.mock.calls[0][0]
    expect(request.replyTokens).toBe(2048)
    expect(request.system).toContain('List at most 7 findings,')
    complete.mockClear()
    await (await fromConfig({
      providers: {
        mine: {
          model: 'm',
          complete,
          window: 8192,
          maxTokens: 700,
        },
      },
    }, { env: {} })).review({ diff })
    expect(complete.mock.calls[0][0].replyTokens).toBe(700)
  })

  it('hands a code config\'s provider object\'s stated room to the review, which then researches in parts', async () => {
    // Six files of 92 tokens each, which a request that leaves 500 tokens holds in six parts, not in one.
    const six = [
      'a.js',
      'b.js',
      'c.js',
      'd.js',
      'e.js',
      'f.js',
    ].map(file => [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1 +1 @@',
      '-safe(input)',
      `+exec(input) // ${file}`,
    ].join('\n')).join('\n')
    const base = requestTokens(researchRequest(securityProfile.prompts.research, ''))
    const requests: CompletionRequest[] = []
    const mine = {
      model: 'm',
      room: (request: CompletionRequest): number => base + 500 - requestTokens(request),
      async complete(request: CompletionRequest): Promise<CompletionResponse> {
        requests.push(request)
        return { text: '{"findings":[]}', model: 'm' }
      },
    }
    const result = await (await fromConfig({
      providers: { mine },
    }, { env: {} })).review({ diff: six })
    expect(requests.map(request => /Part (\d+) of (\d+) of the change\./.exec(request.messages[0].content)?.slice(1))).toEqual([
      ['1', '6'],
      ['2', '6'],
      ['3', '6'],
      ['4', '6'],
      ['5', '6'],
      ['6', '6'],
    ])
    expect(result.meta.profiles.security.coverage.map(entry => entry.status)).toEqual(Array.from({ length: 6 }).fill('reviewed'))
    expect(result.meta.incomplete).toEqual([])
  })

  it('hands partTokens to the quorum it builds', async () => {
    // Two files of about 900 tokens each, which a part of 1024 tokens holds one of, and the default part both of.
    const two = ['a.js', 'b.js'].map(file => [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -0,0 +1,35 @@',
      ...Array.from({ length: 35 }, (_, row) => `+exec(input${String(row).padStart(2, '0')}); // ${file}`),
    ].join('\n')).join('\n')
    const base = requestTokens(researchRequest(securityProfile.prompts.research, ''))
    const research = async (partTokens?: number): Promise<number> => {
      const requests: CompletionRequest[] = []
      const mine = {
        model: 'm',
        room: (request: CompletionRequest): number => base + 100_000 - requestTokens(request),
        async complete(request: CompletionRequest): Promise<CompletionResponse> {
          requests.push(request)
          return { text: '{"findings":[]}', model: 'm' }
        },
      }
      await (await fromConfig({
        providers: { mine },
        ...partTokens === undefined
          ? {}
          : { partTokens },
      }, { env: {} })).review({ diff: two })
      return requests.length
    }
    expect(await research()).toBe(1)
    expect(await research(1024)).toBe(2)
  })

  it('hands the quorum it builds an estimate that reads its limits and its exclude, and calls no provider', async () => {
    const complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResponse>>()
    const mine = {
      model: 'm',
      worstCase: () => 100,
      complete,
    }
    const estimateOf = async (config: Omit<ConfigInput, 'providers'>): Promise<ReturnType<Quorum['estimate']>> => (await fromConfig({
      providers: { mine },
      ...config,
    }, { env: {} })).estimate({ diff })

    expect(await estimateOf({ maxReviewTokens: 5000 })).toMatchObject({
      profiles: {
        security: {
          parts: [100],
          // A worst case below the reply budget holds no input to count at a third: the part expects the reservation it has.
          expected: 100,
        },
      },
      maxReviewTokens: 5000,
      reviewTimeoutMs: 1_800_000,
      fits: true,
    })
    expect(await estimateOf({ maxReviewTokens: 50 })).toMatchObject({ maxReviewTokens: 50, fits: false })
    expect(await estimateOf({
      exclude: ['a.js'],
    })).toMatchObject({
      profiles: {
        security: { parts: [] },
      },
      expected: 0,
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('gives the quorum the config\'s findingsCap', async () => {
    const reply = JSON.stringify({
      findings: [JSON.parse(finding).findings[0], JSON.parse(finding).findings[0]],
    })
    const complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResponse>>()
      .mockResolvedValueOnce({ text: reply, model: 'm' })
      .mockResolvedValue({
        text: JSON.stringify({ keep: true, reasoning: 'r' }),
        model: 'm',
      })
    const quorum = await fromConfig({
      providers: {
        mine: { model: 'm', complete },
      },
      findingsCap: 1,
    }, { env: {} })
    expect(quorum.estimate({ diff })).toMatchObject({ findingsCap: 1, maxFindings: 50 })
    const result = await quorum.review({ diff })
    expect(result.meta.incomplete).toEqual([
      { profile: 'security', reason: 'findings-capped', detail: '1 of 2 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 1): raise findingsCap' },
    ])
  })

  it('gives the quorum the config\'s maxScannerIssues, the most issues of a report each profile\'s panel judges', async () => {
    const complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResponse>>()
      .mockResolvedValue({ text: '{"findings":[]}', model: 'm' })
    const twoLines = `${diff}\n+eval(x)`.replace('@@ -1 +1 @@', '@@ -1 +1,2 @@')
    const issue = (line: number): ScannerIssue => ({
      path: 'a.js',
      line,
      scanner: 'Semgrep',
      ruleId: 'js.exec',
      message: 'user input reaches a command',
      level: 'warning',
    })
    const context = {
      reports: [
        {
          format: 'sarif',
          profile: 'security',
          problems: [],
          skipped: 0,
          unreadable: 0,
          issues: [
            issue(1),
            issue(2),
          ],
        },
      ],
    } as const
    const quorumOf = (extra: Record<string, unknown>): Promise<Quorum> => fromConfig({
      providers: {
        mine: { model: 'm', complete },
      },
      ...extra,
    }, { env: {} })

    expect((await quorumOf({})).estimate({ diff: twoLines, context }).profiles.security.candidates).toBe(2)
    expect((await quorumOf({ maxScannerIssues: 1 })).estimate({ diff: twoLines, context }).profiles.security.candidates).toBe(1)
  })

  it('hands exclude to the quorum it builds', async () => {
    const requests: CompletionRequest[] = []
    const mine = {
      model: 'm',
      async complete(request: CompletionRequest): Promise<CompletionResponse> {
        requests.push(request)
        return { text: '{"findings":[]}', model: 'm' }
      },
    }
    const result = await (await fromConfig({
      providers: { mine },
      exclude: ['a.js'],
    }, { env: {} })).review({ diff })
    expect(requests).toEqual([])
    expect(result.meta.leftOut).toEqual([
      { file: 'a.js', reason: 'excluded' },
    ])
  })

  it('lists the config\'s warnings, then the core\'s', async () => {
    const config: ConfigInput = {
      profiles: {
        team: {
          prompts: { research: 'Find it.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
          lenses: [
            { id: 'one', question: 'Real?' },
          ],
        },
      },
    }
    const expected = ['RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead', 'team.policy.medium needs the same 1 vote(s) as policy.high with 1 lens(es), so it never applies']
    const env = { RESEARCH_MODEL: 'q', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' }
    expect((await fromConfig(config, { env })).warnings).toEqual(expected)
    expect((await fromConfig(resolveConfig(config, { env }))).warnings).toEqual(expected)
  })

  it('refuses a provider with no context size, as a configuration error that names what to set, and sends nothing', async () => {
    const fetchMock = stubReview()
    const message = 'no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens'
    await expect(fromConfig({}, {
      env: { QUORUM_RESEARCH_MODEL: 'q' },
    })).rejects.toMatchObject({ name: 'ConfigError', message })
    expect(() => resolveConfig({}, {
      env: { QUORUM_RESEARCH_MODEL: 'q' },
    })).toThrow(expect.objectContaining({ name: 'ConfigError', message }))
    expect(await issuesOf({
      providers: {
        local: { preset: 'ollama', model: 'q' },
      },
    })).toEqual([
      { path: 'providers.local.contextTokens', message: 'is required: the model\'s context window in tokens, which quorum checks every request against' },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends nothing when a provider is invalid', async () => {
    const fetchMock = stubReview()
    await expect(fromConfig({
      providers: {
        local: {
          preset: 'ollama',
          model: 'q',
          contextTokens: 131072,
          maxTokens: 0,
        },
      },
    }, { env: {} })).rejects.toThrow(ConfigError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
