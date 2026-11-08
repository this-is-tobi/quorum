import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuorumResult, Verdict } from '../core/types.ts'
import { EXIT, exitCodeFor, runCli } from './main.ts'
import type { CliIO } from './main.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** The environment of a configured run. */
const MODEL = { RESEARCH_MODEL: 'm' }

const DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'
/** Two added lines, so two findings can be cited. */
const TWO_LINE_DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-safe()\n+exec(cmd)\n+eval(x)\n'
const SECOND_FINDING = { file: 'a.js', line: 2, category: 'CWE-95', quote: 'eval(x)', summary: 'code injection' }
const FINDING = { file: 'a.js', line: 1, category: 'CWE-78', quote: 'exec(cmd)', summary: 'command injection' }
const vote = (keep: boolean): string => JSON.stringify({ keep, reasoning: 'r' })

function harness(options: { argv?: string[], stdin?: string, isTTY?: boolean, env?: Record<string, string> } = {}): { io: CliIO, stdout: () => string, stderr: () => string } {
  const out: string[] = []
  const err: string[] = []
  async function* chunks(): AsyncGenerator<string> {
    if (options.stdin !== undefined) yield options.stdin
  }
  const io: CliIO = {
    argv: options.argv ?? [],
    env: options.env ?? {},
    stdin: Object.assign(chunks(), { isTTY: options.isTTY ?? false }),
    stdout: { write: text => out.push(text) },
    stderr: { write: text => err.push(text) },
  }
  return { io, stdout: () => out.join(''), stderr: () => err.join('') }
}

function stubModel(...replies: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn()
  for (const content of replies) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Every hidden class the sanitizer knows, to check that the CLI writes none of them. */
const ANY_HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u

/** A failed HTTP reply whose body is `body`. */
const failed = (body: string): unknown => ({ ok: false, status: 500, text: async () => body })

describe('runCli', () => {
  it('exits 2 with usage instead of waiting on an interactive terminal', async () => {
    const fetchMock = stubModel()
    const { io, stderr } = harness({ isTTY: true })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toContain('Usage:')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 2 when the diff file does not exist', async () => {
    const { io } = harness({ argv: ['does-not-exist.diff'] })
    expect(await runCli(io)).toBe(EXIT.usage)
  })

  it('exits 0 without calling the model for an empty diff', async () => {
    const fetchMock = stubModel()
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: '  \n' })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(stdout())).toMatchObject({ kept: [], discarded: [] })
    expect(stderr()).toContain('empty diff: nothing to review')
  })

  it('reads the injected environment and never process.env', async () => {
    vi.stubEnv('RESEARCH_MODEL', 'leaked')
    const fetchMock = stubModel()
    const { io, stderr } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toContain('RESEARCH_MODEL')
    expect(stderr()).not.toContain('Research (')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prints the origin of each role\'s endpoint, never its credentials, path or query, from the injected environment', async () => {
    vi.stubEnv('RESEARCH_MODEL', 'leaked')
    const env = { RESEARCH_MODEL: 'banner-model', RESEARCH_BASE_URL: 'https://user:pw-secret@h.example/token-secret/v1?key=q-secret' }
    const { io, stderr } = harness({ stdin: '  \n', env })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toContain('Research (banner-model @ https://h.example)...')
    expect(stderr()).toContain('Panel will use banner-model @ https://h.example')
    expect(stderr()).not.toMatch(/secret|leaked/)
  })

  it('exits 2 when no model is configured', async () => {
    stubModel()
    const { io, stderr } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toContain('RESEARCH_MODEL')
  })

  it('exits 2 for an empty diff when no model is configured, before any banner', async () => {
    const fetchMock = stubModel()
    const { io, stderr } = harness({ stdin: '  \n' })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toContain('RESEARCH_MODEL')
    expect(stderr()).not.toContain('Research (')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 3 when the model endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const { io } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
  })

  it('exits 1 on a unanimous finding and prints the result as JSON', async () => {
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true), vote(true))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(JSON.parse(stdout()).kept[0]).toMatchObject({ id: '235f5feb3565', profile: 'security', file: 'a.js', confidence: 'high' })
  })

  it('exits 0 when the panel keeps a finding only at medium confidence', async () => {
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true), vote(false))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]).toMatchObject({ file: 'a.js', confidence: 'medium', keptVotes: 2 })
  })

  it('exits 0 when the panel discards every finding', async () => {
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(false), vote(false), vote(true))
    const { io } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
  })

  it('exits 4 when every voter fails, instead of reading the outage as a clean review', async () => {
    stubModel(JSON.stringify({ findings: [FINDING] })).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toEqual([])
    expect(result.discarded).toEqual([])
    expect(result.unreviewed).toHaveLength(1)
    expect(stderr()).toContain('1 unreviewed')
  })

  it('exits 4 when the research reply lists only unusable findings', async () => {
    const fetchMock = stubModel(JSON.stringify({ findings: [{ file: 'x.js' }] }))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const reasons = JSON.parse(stdout()).meta.incomplete.map((entry: { reason: string }) => entry.reason)
    expect(reasons).toEqual(['finding-unreadable', 'research-unusable'])
    expect(stderr()).toContain('research-unusable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exits 4 when one finding is unreadable, even though another is kept', async () => {
    stubModel(JSON.stringify({ findings: [FINDING, { file: 'a.js' }] }), vote(true), vote(true), vote(false))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.meta.incomplete).toEqual([{ profile: 'security', reason: 'finding-unreadable', detail: expect.stringMatching(/^findings\[1\]: /) }])
    expect(stderr()).toContain('finding-unreadable')
  })

  it('exits 1 when a high finding is kept, even if another finding is unreviewed', async () => {
    stubModel(JSON.stringify({ findings: [FINDING, SECOND_FINDING] }), vote(true), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ env: MODEL, stdin: TWO_LINE_DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.unreviewed).toHaveLength(1)
  })

  it('exits 0 when a failed vote could not have changed a discard', async () => {
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(false), vote(false)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.discarded).toHaveLength(1)
    expect(result.unreviewed).toEqual([])
  })

  it('exits 4 when a kept medium finding has a failed vote that could have made it high', async () => {
    stubModel(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0].confidence).toBe('medium')
    expect(result.meta.incomplete).toEqual([{ profile: 'security', reason: 'vote-failed', file: 'a.js', detail: expect.stringMatching(/^"a\.js":1 is kept at medium/) }])
    expect(stderr()).toContain('vote-failed')
  })
})

describe('exitCodeFor', () => {
  const kept = (profile: string, confidence: Verdict['confidence']): Verdict => ({ profile, confidence }) as Verdict
  const result = (verdicts: Verdict[], gating: Record<string, boolean>, gaps = 0): QuorumResult => ({
    kept: verdicts,
    discarded: [],
    unreviewed: [],
    meta: { profiles: Object.fromEntries(Object.entries(gating).map(([id, value]) => [id, { gating: value }])), incomplete: Array.from({ length: gaps }, () => ({})) },
  }) as unknown as QuorumResult

  it('exits 1 only for a kept high finding of a gating profile', () => {
    expect(exitCodeFor(result([kept('style', 'high')], { style: false }))).toBe(EXIT.ok)
    expect(exitCodeFor(result([kept('style', 'high')], { style: false }, 1))).toBe(EXIT.incomplete)
    expect(exitCodeFor(result([kept('style', 'high'), kept('security', 'medium')], { style: false, security: true }))).toBe(EXIT.ok)
    expect(exitCodeFor(result([kept('style', 'high'), kept('security', 'high')], { style: false, security: true }, 1))).toBe(EXIT.finding)
  })

  it('counts a profile missing from meta as gating, so a gap in the result never hides a finding', () => {
    expect(exitCodeFor(result([kept('security', 'high')], {}))).toBe(EXIT.finding)
    expect(exitCodeFor({ ...result([kept('security', 'high')], {}), meta: { profiles: { security: {} }, incomplete: [] } } as unknown as QuorumResult)).toBe(EXIT.finding)
  })
})

describe('inert output', () => {
  it('writes the server text an error quotes inert, on one line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failed('\u009B2J\u202Eboom\n::error::x')))
    const { io, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(stderr()).toContain('Error: research: HTTP 500: "<U+009B>2J<U+202E>boom\\n::error::x"\n')
    expect(stderr().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
  })

  it('keeps a configuration error to one issue per line, and any other error to one line', async () => {
    const config = harness({ env: { ...MODEL, RESEARCH_BASE_URL: 'localhost:11434/v1', RESEARCH_API_KEY: 'sk bad' }, stdin: DIFF })
    expect(await runCli(config.io)).toBe(EXIT.usage)
    expect(config.stderr()).toBe('Error: research.baseUrl: must be an http:// or https:// URL with a host\nresearch.apiKey: must only contain visible ASCII characters, which an HTTP header can carry\n')
    const missing = harness({ argv: ['no\nsuch.diff'], env: MODEL })
    expect(await runCli(missing.io)).toBe(EXIT.usage)
    expect(missing.stderr()).toMatch(/^Error: ENOENT: no such file or directory, open 'no<U\+000A>such\.diff'\nUsage:/)
  })

  it('writes the JSON result inert: it parses back to the text the servers sent', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ findings: [FINDING] }) } }] }) })
      .mockResolvedValue(failed('\u009B2J\u202E')))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(stdout().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
    expect(JSON.parse(stdout()).unreviewed[0].votes[0].error).toBe('voter: HTTP 500: "\u009B2J\u202E"')
  })

  it('writes no legacy workflow command, on stderr or in the JSON', async () => {
    stubModel(JSON.stringify({ findings: [{ ...FINDING, file: '##[error]x.js' }, { ...FINDING, summary: '##[add-mask]e' }] }), vote(true), vote(true), vote(true))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(stderr()).toContain('invalid finding dropped: ##<U+005B>error]x.js:1 is not in the diff\n')
    expect(stdout()).toContain('"summary": "##\\u005badd-mask]e"')
    expect(`${stderr()}${stdout()}`).not.toContain('##[')
    expect(JSON.parse(stdout()).kept[0].summary).toBe('##[add-mask]e')
  })

  it('prints a flag on stderr and keeps it out of the exit code', async () => {
    stubModel(JSON.stringify({ findings: [] }))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF.replace('+exec(cmd)', '+exec(cmd)\u202E') })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toContain('flag: hidden-characters at "a.js":1 (U+202E on 1 added line(s))\n')
    expect(JSON.parse(stdout()).meta.flags).toEqual([{ code: 'hidden-characters', file: 'a.js', line: 1, detail: 'U+202E on 1 added line(s)' }])
  })
})
