import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import type { QuorumResult, Verdict } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import { chatReply, sent, stubChat, stubFetch, textReply } from '../testing/http.ts'
import { EXIT, exitCodeFor, interruptSignal, runCli } from './main.ts'
import type { CliIO } from './main.ts'

/** A directory of its own for the config files and the working directories of these tests. */
let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-cli-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a file into the temporary directory, and return its path. */
function write(name: string, text: string): string {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

/** The environment of a configured run. */
const MODEL = { QUORUM_RESEARCH_MODEL: 'm' }

const DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'
/** Two added lines, so two findings can be cited. */
const TWO_LINE_DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-safe()\n+exec(cmd)\n+eval(x)\n'
const SECOND_FINDING = { file: 'a.js', line: 2, category: 'CWE-95', quote: 'eval(x)', summary: 'code injection' }
const FINDING = { file: 'a.js', line: 1, category: 'CWE-78', quote: 'exec(cmd)', summary: 'command injection' }
const vote = (keep: boolean): string => JSON.stringify({ keep, reasoning: 'r' })

/** Two profiles, the second with a lens on a provider of its own; every test that uses it writes it, so none depends on another. */
const TWO_YAML = [
  'providers:',
  '  local: {protocol: openai-compatible, baseUrl: "http://localhost:11434/v1", model: m}',
  '  hosted: {protocol: openai-compatible, baseUrl: "https://v.example/v1", model: v}',
  'roles: {research: local}',
  'profiles:',
  '  security: {}',
  '  team:',
  '    prompts: {research: "Find style issues in this diff.", vote: "Judge from {{lens.id}}: {{lens.question}}"}',
  '    lenses:',
  '      - {id: grounded, question: "Is it backed by a stated convention?"}',
  '      - {id: significant, question: "Would a maintainer block on it?", provider: hosted}',
  '',
].join('\n')

/** A config of one provider, on an origin of its own. */
const TEAM_YAML = 'providers:\n  team: {protocol: openai-compatible, baseUrl: "https://team.example/v1", model: t}\n'

function harness(options: { argv?: string[], cwd?: string, stdin?: string, isTTY?: boolean, env?: Record<string, string>, signal?: AbortSignal } = {}): { io: CliIO, stdout: () => string, stderr: () => string } {
  const out: string[] = []
  const err: string[] = []
  async function* chunks(): AsyncGenerator<string> {
    if (options.stdin !== undefined) yield options.stdin
  }
  const io: CliIO = {
    argv: options.argv ?? [],
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? {},
    stdin: Object.assign(chunks(), { isTTY: options.isTTY ?? false }),
    stdout: { write: text => out.push(text) },
    stderr: { write: text => err.push(text) },
    signal: options.signal,
  }
  return { io, stdout: () => out.join(''), stderr: () => err.join('') }
}

/** The usage text, which `--help` prints on stdout and every usage error prints on stderr. */
const USAGE = [
  'Usage: quorum [options] [diff-file]',
  '       git diff | quorum [options]',
  '',
  'Options:',
  '  -c, --config <path>     Read this config file, over QUORUM_CONFIG',
  '  -p, --profile <id>      Run only this profile; repeat it to run several',
  '      --allow-incomplete  Exit 0 instead of 4 when the review is incomplete',
  '      --print-config      Print the resolved config, keys redacted, and exit',
  '  -h, --help              Print this help and exit',
  '  -v, --version           Print the version and exit',
  '',
].join('\n')

/** The text a config prints for a prompt: `sha256:` and the lowercase hex SHA-256 of its UTF-8 text. */
const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`

/** Every hidden class the sanitizer knows, to check that the CLI writes none of them. */
const ANY_HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u

/** A failed HTTP reply whose body is `body`. */
const failed = (body: string): Response => textReply(body, 500)

describe('runCli', () => {
  it('exits 2 with usage instead of waiting on an interactive terminal', async () => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({ isTTY: true })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: no diff given\n${USAGE}`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 2 when the diff file does not exist', async () => {
    const { io } = harness({ argv: ['does-not-exist.diff'] })
    expect(await runCli(io)).toBe(EXIT.usage)
  })

  it('exits 0 without calling the model for an empty diff', async () => {
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: '  \n' })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(stdout())).toMatchObject({ kept: [], discarded: [] })
    expect(stderr()).toBe('Research (m @ http://localhost:11434)...\nPanel will use m @ http://localhost:11434\nempty diff: nothing to review\n0 kept, 0 discarded, 0 unreviewed by panel\n')
  })

  it('reads the injected environment and never process.env', async () => {
    vi.stubEnv('QUORUM_RESEARCH_MODEL', 'leaked')
    vi.stubEnv('QUORUM_CONFIG', write('leaked.yaml', 'providers:\n  leaked: {protocol: openai-compatible, baseUrl: "https://leaked.example/v1", model: l}\n'))
    const fetchMock = stubChat()
    const { io, stderr } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe('Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prints the origin of each role\'s endpoint, never its credentials, path or query, from the injected environment', async () => {
    vi.stubEnv('QUORUM_RESEARCH_MODEL', 'leaked')
    const env = { QUORUM_RESEARCH_MODEL: 'banner-model', QUORUM_RESEARCH_BASE_URL: 'https://h.example/token-secret/v1' }
    const { io, stderr } = harness({ stdin: '  \n', env })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toContain('Research (banner-model @ https://h.example)...')
    expect(stderr()).toContain('Panel will use banner-model @ https://h.example')
    expect(stderr()).not.toMatch(/secret|leaked/)
  })

  it('exits 2 for a base URL holding credentials or a query, and prints neither', async () => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({ stdin: DIFF, env: { ...MODEL, QUORUM_RESEARCH_BASE_URL: 'https://user:pw-secret@h.example/v1?key=q-secret' } })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toContain('Error: QUORUM_RESEARCH_BASE_URL: must not hold a user name or password: send a key with apiKey\nQUORUM_RESEARCH_BASE_URL: must not hold a query or a fragment\n')
    expect(stderr()).not.toContain('secret')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 2 when no model is configured', async () => {
    stubChat()
    const { io, stderr } = harness({ stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe('Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one\n')
  })

  it('exits 2 for an empty diff when no model is configured, before any banner', async () => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({ stdin: '  \n' })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe('Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 3 when the model endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const { io } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
  })

  it('exits 3 with a fixed text, instead of throwing, for a failure that has no text form', async () => {
    const reply = {
      get ok(): boolean {
        throw Object.create(null)
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply))
    const { io, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(stderr()).toContain('Error: an error with no text form\n')
  })

  it('exits 1 on a unanimous finding and prints the result as JSON', async () => {
    stubChat(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true), vote(true))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(JSON.parse(stdout()).kept[0]).toMatchObject({ id: '235f5feb3565', profile: 'security', file: 'a.js', confidence: 'high' })
  })

  it('exits 0 when the panel keeps a finding only at medium confidence', async () => {
    stubChat(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true), vote(false))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]).toMatchObject({ file: 'a.js', confidence: 'medium', keptVotes: 2 })
  })

  it('exits 0 when the panel discards every finding', async () => {
    stubChat(JSON.stringify({ findings: [FINDING] }), vote(false), vote(false), vote(true))
    const { io } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
  })

  it('exits 4 when every voter fails, instead of reading the outage as a clean review', async () => {
    stubChat(JSON.stringify({ findings: [FINDING] })).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toEqual([])
    expect(result.discarded).toEqual([])
    expect(result.unreviewed).toHaveLength(1)
    expect(stderr()).toContain('1 unreviewed')
  })

  it('turns 4 into 0 with --allow-incomplete, and keeps the result', async () => {
    stubChat(JSON.stringify({ findings: [FINDING] })).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ argv: ['--allow-incomplete'], env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(JSON.parse(stdout()).unreviewed).toHaveLength(1)
  })

  it('still exits 1 with --allow-incomplete when a gating high finding is kept', async () => {
    stubChat(JSON.stringify({ findings: [FINDING, SECOND_FINDING] }), vote(true), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io } = harness({ argv: ['--allow-incomplete'], env: MODEL, stdin: TWO_LINE_DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
  })

  it('exits 0 when only an advisory profile\'s review is incomplete', async () => {
    const advisory = write('advisory.yaml', 'profiles:\n  security: {gating: false}\n')
    stubChat(JSON.stringify({ findings: [FINDING] })).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ cwd: dir, env: { ...MODEL, QUORUM_CONFIG: advisory }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.unreviewed).toHaveLength(1)
    expect(result.meta.profiles.security.gating).toBe(false)
  })

  it('exits 4 when the research reply lists only unusable findings', async () => {
    const fetchMock = stubChat(JSON.stringify({ findings: [{ file: 'x.js' }] }))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const reasons = JSON.parse(stdout()).meta.incomplete.map((entry: { reason: string }) => entry.reason)
    expect(reasons).toEqual(['finding-unreadable', 'research-unusable'])
    expect(stderr()).toContain('research-unusable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exits 4 when one finding is unreadable, even though another is kept', async () => {
    stubChat(JSON.stringify({ findings: [FINDING, { file: 'a.js' }] }), vote(true), vote(true), vote(false))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.meta.incomplete).toEqual([{ profile: 'security', reason: 'finding-unreadable', detail: expect.stringMatching(/^findings\[1\]: /) }])
    expect(stderr()).toContain('finding-unreadable')
  })

  it('exits 1 when a high finding is kept, even if another finding is unreviewed', async () => {
    stubChat(JSON.stringify({ findings: [FINDING, SECOND_FINDING] }), vote(true), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ env: MODEL, stdin: TWO_LINE_DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.unreviewed).toHaveLength(1)
  })

  it('exits 0 when a failed vote could not have changed a discard', async () => {
    stubChat(JSON.stringify({ findings: [FINDING] }), vote(false), vote(false)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.discarded).toHaveLength(1)
    expect(result.unreviewed).toEqual([])
  })

  it('exits 4 when a kept medium finding has a failed vote that could have made it high', async () => {
    stubChat(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0].confidence).toBe('medium')
    expect(result.meta.incomplete).toEqual([{ profile: 'security', reason: 'vote-failed', file: 'a.js', detail: expect.stringMatching(/^"a\.js":1 is kept at medium/) }])
    expect(stderr()).toContain('vote-failed')
  })

  it('prints each warning once, inert, before the banner, and keeps stdout to the JSON result', async () => {
    const { io, stdout, stderr } = harness({ env: { RESEARCH_MODEL: 'm' }, stdin: '  \n' })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toBe('warning: RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead\nResearch (m @ http://localhost:11434)...\nPanel will use m @ http://localhost:11434\nempty diff: nothing to review\n0 kept, 0 discarded, 0 unreviewed by panel\n')
    expect(JSON.parse(stdout())).toMatchObject({ kept: [], discarded: [], unreviewed: [] })
  })

  it('sends the request of the initial import for an environment-only run, and no key header without a key', async () => {
    const fetchMock = stubChat('{"findings":[]}', '{"findings":[]}')
    expect(await runCli(harness({ env: { QUORUM_RESEARCH_MODEL: 'qwen' }, stdin: DIFF }).io)).toBe(EXIT.ok)
    expect(await runCli(harness({ env: { QUORUM_RESEARCH_MODEL: 'qwen', QUORUM_RESEARCH_API_KEY: 'sk-test\n' }, stdin: DIFF }).io)).toBe(EXIT.ok)
    expect(sent(fetchMock, 0)).toMatchObject({ url: 'http://localhost:11434/v1/chat/completions', body: { model: 'qwen', response_format: { type: 'json_object' }, temperature: 0 } })
    expect(sent(fetchMock, 0).headers).not.toHaveProperty('authorization')
    expect(sent(fetchMock, 1).headers).toMatchObject({ authorization: 'Bearer sk-test' })
  })

  it('never sends the research key to a voter on another origin, set through the deprecated variables', async () => {
    const fetchMock = stubChat(JSON.stringify({ findings: [FINDING] }), vote(true), vote(true), vote(true))
    const env = { RESEARCH_BASE_URL: 'https://r.example/v1', RESEARCH_API_KEY: 'sk-r', RESEARCH_MODEL: 'r', VOTER_BASE_URL: 'https://v.example/v1', VOTER_MODEL: 'v' }
    const { io, stderr } = harness({ env, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(sent(fetchMock, 0).headers).toMatchObject({ authorization: 'Bearer sk-r' })
    for (const call of [1, 2, 3]) {
      expect(sent(fetchMock, call).url).toBe('https://v.example/v1/chat/completions')
      expect(sent(fetchMock, call).headers).not.toHaveProperty('authorization')
    }
    expect(JSON.stringify(fetchMock.mock.calls.slice(1))).not.toContain('sk-r')
    expect(stderr()).toContain('warning: RESEARCH_BASE_URL, RESEARCH_API_KEY, RESEARCH_MODEL, VOTER_BASE_URL and VOTER_MODEL are deprecated: set QUORUM_RESEARCH_BASE_URL, QUORUM_RESEARCH_API_KEY, QUORUM_RESEARCH_MODEL, QUORUM_VOTER_BASE_URL and QUORUM_VOTER_MODEL instead\n')
  })

  it('prints the deprecation line before the configuration error it explains, and exits 2', async () => {
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({ env: { RESEARCH_BASE_URL: 'localhost:11434', RESEARCH_MODEL: 'm' }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe([
      'warning: RESEARCH_BASE_URL and RESEARCH_MODEL are deprecated: set QUORUM_RESEARCH_BASE_URL and QUORUM_RESEARCH_MODEL instead',
      'Error: QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host',
      '',
    ].join('\n'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prints the warning of a mistyped variable before the configuration error it causes', async () => {
    const { io, stdout, stderr } = harness({ env: { ...MODEL, QUORUM_VOTER_BASE_URL: 'https://v.example/v1', QUORUM_VOTER_MODLE: 'v' }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe([
      'warning: QUORUM_VOTER_MODLE is not a variable quorum reads',
      'Error: QUORUM_VOTER_MODEL: must be set when the voter variables name another endpoint than the research provider\'s',
      '',
    ].join('\n'))
  })

  it('reads the config file QUORUM_CONFIG names', async () => {
    const team = write('team.yaml', TEAM_YAML)
    const fetchMock = stubChat('{"findings":[]}')
    const { io, stderr } = harness({ cwd: dir, env: { QUORUM_CONFIG: team }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(sent(fetchMock).url).toBe('https://team.example/v1/chat/completions')
    expect(stderr()).toBe('Research (t @ https://team.example)...\nPanel will use t @ https://team.example\n0 candidate(s) after dedup\n0 kept, 0 discarded, 0 unreviewed by panel\n')
  })

  it('exits 2 when the file QUORUM_CONFIG names does not exist, naming it as given', async () => {
    const missing = join(dir, 'missing.yaml')
    const { io, stderr } = harness({ cwd: dir, env: { QUORUM_CONFIG: missing }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: ${missing}: does not exist\n`)
  })

  it('exits 2 when QUORUM_CONFIG is not an absolute path, and reads no file of the working directory', async () => {
    write('team.yaml', TEAM_YAML)
    const fetchMock = stubChat('{"findings":[]}')
    const { io, stdout, stderr } = harness({ cwd: dir, env: { QUORUM_CONFIG: 'team.yaml' }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Error: QUORUM_CONFIG: must be an absolute path\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads no config file it is not named, whatever the working directory holds', async () => {
    const planted = join(dir, 'planted')
    mkdirSync(planted)
    const evil = 'providers:\n  evil: {protocol: openai-compatible, baseUrl: "https://attacker.example/v1", model: e, apiKeyEnv: JOB_KEY}\n'
    writeFileSync(join(planted, 'quorum.config.yaml'), evil)
    writeFileSync(join(planted, 'quorum.yaml'), evil)
    writeFileSync(join(planted, 'quorum.config.mts'), 'globalThis.quorumPlanted = true\nexport default {}\n')
    const fetchMock = stubChat('{"findings":[]}')
    const { io, stderr } = harness({ cwd: planted, env: { ...MODEL, JOB_KEY: 'sk-job' }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://localhost:11434/v1/chat/completions'])
    expect((globalThis as { quorumPlanted?: unknown }).quorumPlanted).toBeUndefined()
    expect(stderr()).not.toMatch(/attacker|warning/)
  })

  it('prefixes the lines of each profile when several run, lists each lens\'s provider when they differ, and prints the core\'s warnings', async () => {
    const two = write('two.yaml', TWO_YAML)
    stubFetch({ choices: [{ message: { content: '{"findings":[]}' } }] })
    const { io, stderr } = harness({ cwd: dir, env: { QUORUM_CONFIG: two }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const lines = stderr().split('\n')
    expect(lines.slice(0, 5)).toEqual([
      'warning: team.policy.medium needs the same 2 vote(s) as policy.high with 2 lens(es), so it never applies',
      '[security] Research (m @ http://localhost:11434)...',
      '[security] Panel will use m @ http://localhost:11434',
      '[team] Research (m @ http://localhost:11434)...',
      '[team] Panel will use grounded (m @ http://localhost:11434), significant (v @ https://v.example)',
    ])
    // Each profile's dedup line is there with its prefix; which comes first depends on scheduling.
    expect(lines.slice(5, 7).sort()).toEqual(['[security] 0 candidate(s) after dedup', '[team] 0 candidate(s) after dedup'])
    expect(lines.slice(7)).toEqual(['0 kept, 0 discarded, 0 unreviewed by panel', ''])
  })
})

describe('exitCodeFor', () => {
  const kept = (profile: string, confidence: Verdict['confidence']): Verdict => ({ profile, confidence }) as Verdict
  const result = (verdicts: Verdict[], gating: Record<string, boolean>, gaps: ReadonlyArray<string | undefined> = [], unreviewed: Verdict[] = []): QuorumResult => ({
    kept: verdicts,
    discarded: [],
    unreviewed,
    meta: {
      profiles: Object.fromEntries(Object.entries(gating).map(([id, value]) => [id, { gating: value }])),
      incomplete: gaps.map(profile => profile === undefined ? {} : { profile }),
    },
  }) as unknown as QuorumResult

  it('exits 1 only for a kept high finding of a gating profile', () => {
    expect(exitCodeFor(result([kept('style', 'high')], { style: false }))).toBe(EXIT.ok)
    expect(exitCodeFor(result([kept('style', 'high')], { style: false }, [undefined]))).toBe(EXIT.incomplete)
    expect(exitCodeFor(result([kept('style', 'high'), kept('security', 'medium')], { style: false, security: true }))).toBe(EXIT.ok)
    expect(exitCodeFor(result([kept('style', 'high'), kept('security', 'high')], { style: false, security: true }, [undefined]))).toBe(EXIT.finding)
  })

  it('counts a profile missing from meta as gating, so a gap in the result never hides a finding', () => {
    expect(exitCodeFor(result([kept('security', 'high')], {}))).toBe(EXIT.finding)
    expect(exitCodeFor({ ...result([kept('security', 'high')], {}), meta: { profiles: { security: {} }, incomplete: [] } } as unknown as QuorumResult)).toBe(EXIT.finding)
  })

  it('exits 4 for a gap of a gating profile, and 0 for one of an advisory profile', () => {
    const gating = { security: true, style: false }
    expect(exitCodeFor(result([], gating, ['security']))).toBe(EXIT.incomplete)
    expect(exitCodeFor(result([], gating, ['style']))).toBe(EXIT.ok)
    expect(exitCodeFor(result([], gating, [], [kept('style', undefined)]))).toBe(EXIT.ok)
    expect(exitCodeFor(result([], gating, [], [kept('security', undefined)]))).toBe(EXIT.incomplete)
    expect(exitCodeFor(result([], {}, ['team']))).toBe(EXIT.incomplete)
  })

  it('turns 4 into 0 with allowIncomplete, and never 1', () => {
    expect(exitCodeFor(result([], { security: true }, ['security']), { allowIncomplete: true })).toBe(EXIT.ok)
    expect(exitCodeFor(result([kept('security', 'high')], { security: true }, ['security']), { allowIncomplete: true })).toBe(EXIT.finding)
  })

  const withGaps = (gating: Record<string, boolean>, gaps: object[], verdicts: Verdict[] = []): QuorumResult => {
    const base = result(verdicts, gating)
    return { ...base, meta: { ...base.meta, incomplete: gaps } } as unknown as QuorumResult
  }
  const refused = (profile?: string): object => ({ ...profile === undefined ? {} : { profile }, reason: 'request-too-large' })

  it('exits 4 for a request-too-large gap of a gating profile, even with allowIncomplete, and 1 when a gating high finding was kept', () => {
    for (const allowIncomplete of [false, true]) {
      expect(exitCodeFor(withGaps({ security: true }, [refused('security')]), { allowIncomplete })).toBe(EXIT.incomplete)
      expect(exitCodeFor(withGaps({}, [refused('team')]), { allowIncomplete })).toBe(EXIT.incomplete)
      expect(exitCodeFor(withGaps({ style: false }, [refused()]), { allowIncomplete })).toBe(EXIT.incomplete)
      expect(exitCodeFor(withGaps({ security: true }, [refused('security')], [kept('security', 'high')]), { allowIncomplete })).toBe(EXIT.finding)
    }
  })

  it('exits 0 for a request-too-large gap of an advisory profile, with or without allowIncomplete', () => {
    for (const allowIncomplete of [false, true]) {
      expect(exitCodeFor(withGaps({ security: true, style: false }, [refused('style')]), { allowIncomplete })).toBe(EXIT.ok)
    }
  })
})

describe('the diff byte cap', () => {
  const MiB = 1024 * 1024
  const OVER = `Error: the diff is over 16 MiB, the most quorum reads\n${USAGE}`

  /** stdin as `count` chunks of `size` bytes of `a`, each made when it is pulled; `pulled()` counts them. */
  function chunked(count: number, size = MiB): { stdin: CliIO['stdin'], pulled: () => number } {
    let pulled = 0
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < count; index++) {
        pulled += 1
        yield new Uint8Array(size).fill(0x61)
      }
    }
    return { stdin: Object.assign(chunks(), { isTTY: false }), pulled: () => pulled }
  }

  it('refuses a diff on stdin over 16 MiB, reads no further, and sends nothing', async () => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({ env: MODEL })
    const input = chunked(20)
    io.stdin = input.stdin
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(OVER)
    expect(input.pulled()).toBe(17)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads a diff of exactly 16 MiB, then the configuration', async () => {
    const { io, stderr } = harness()
    io.stdin = chunked(16).stdin
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe('Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one\n')
  })

  it('counts bytes, not characters', async () => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({ env: MODEL, stdin: String.fromCharCode(0xE9).repeat(8 * MiB + 1) })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(OVER)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a diff file over 16 MiB', async () => {
    const fetchMock = stubChat()
    const path = join(dir, 'huge.diff')
    writeFileSync(path, new Uint8Array(16 * MiB + 1).fill(0x61))
    const { io, stderr } = harness({ argv: [path], env: MODEL })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(OVER)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops a byte-order mark at the start of a diff file, as it does on stdin', async () => {
    const fetchMock = stubChat(JSON.stringify({ findings: [] }))
    const { io } = harness({ argv: [write('bom.diff', `${String.fromCharCode(0xFEFF)}${DIFF}`)], env: MODEL })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect((sent(fetchMock).body.messages as Array<{ content: string }>)[1].content).toContain(`>\n${DIFF}\n</untrusted-diff-`)
  })
})

describe('flags', () => {
  it('prints the help on stdout and exits 0, reading neither the diff nor a config', async () => {
    for (const flag of ['--help', '-h']) {
      const fetchMock = stubChat()
      const { io, stdout, stderr } = harness({ argv: [flag, 'ignored.diff'], isTTY: true })
      expect(await runCli(io)).toBe(EXIT.ok)
      expect(stdout()).toBe(USAGE)
      expect(stderr()).toBe('')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('prints the version on stdout and exits 0', async () => {
    const { io, stdout } = harness({ argv: ['--version'] })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toBe(`quorum ${packageJson.version}\n`)
  })

  it('reads a diff file named like a flag after --', async () => {
    const { io, stderr } = harness({ argv: ['--', '--help'], env: MODEL })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toMatch(/^Error: ENOENT: no such file or directory, open '.*--help'\nUsage:/)
  })

  it('exits 2 for an unknown flag, naming it and never a value given with it', async () => {
    const { io, stdout, stderr } = harness({ argv: ['--nope=sk-SECRET'], env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--nope"\n${USAGE}`)
    expect(`${stdout()}${stderr()}`).not.toContain('SECRET')
  })

  it('keeps a usage error of several lines to one inert line each', async () => {
    const { io, stderr } = harness({ argv: ['--config', '--help'], env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: Option '--config' argument is ambiguous.\nDid you forget to specify the option argument for '--config'?\nTo specify an option argument starting with a dash use '--config=-XYZ'.\n${USAGE}`)
  })

  it('exits 2 for a second diff argument', async () => {
    const { io, stderr } = harness({ argv: ['a.diff', 'b.diff'], env: MODEL })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: unexpected arguments: b.diff\n${USAGE}`)
  })

  it('exits 2 for an empty --config instead of reading the working directory', async () => {
    const { io, stderr } = harness({ argv: ['--config='], cwd: dir, env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: --config: must name a file\n${USAGE}`)
  })

  it('reads the file --config names, over the one QUORUM_CONFIG names', async () => {
    write('flag.yaml', 'providers:\n  flag: {protocol: openai-compatible, baseUrl: "https://flag.example/v1", model: f}\n')
    const team = write('team.yaml', TEAM_YAML)
    const fetchMock = stubChat('{"findings":[]}')
    const { io } = harness({ argv: ['-c', 'flag.yaml'], cwd: dir, env: { QUORUM_CONFIG: team }, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(sent(fetchMock).url).toBe('https://flag.example/v1/chat/completions')
  })

  it('runs only the profiles --profile names, over QUORUM_PROFILES', async () => {
    const two = write('two.yaml', TWO_YAML)
    stubFetch({ choices: [{ message: { content: '{"findings":[]}' } }] })
    const team = harness({ argv: ['--profile', 'team'], cwd: dir, env: { QUORUM_CONFIG: two }, stdin: DIFF })
    expect(await runCli(team.io)).toBe(EXIT.ok)
    expect(Object.keys(JSON.parse(team.stdout()).meta.profiles)).toEqual(['team'])
    expect(team.stderr()).toContain('\nPanel will use grounded (m @ http://localhost:11434), significant (v @ https://v.example)\n')
    const security = harness({ argv: ['-p', 'security'], cwd: dir, env: { QUORUM_CONFIG: two, QUORUM_PROFILES: 'team' }, stdin: DIFF })
    expect(await runCli(security.io)).toBe(EXIT.ok)
    expect(Object.keys(JSON.parse(security.stdout()).meta.profiles)).toEqual(['security'])
  })

  it.each<[string[], string]>([
    [['--profile', 'security', '--profile', 'security'], 'Error: --profile: names a profile more than once\n'],
    [['--profile', 'secrity'], 'Error: --profile: unknown profile "secrity" (did you mean "security"?)\n'],
    [['-p', 'Security'], 'Error: --profile: must be a profile id matching ^[a-z][a-z0-9_-]*$\n'],
  ])('exits 2 for --profile %j, before any request', async (argv, error) => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({ argv, env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(error)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('--print-config', () => {
  it('prints the resolved config as YAML, with no key, header, query or body value, and no path of a base URL', async () => {
    const fetchMock = stubChat()
    write('gateway.yaml', [
      'providers:',
      '  local: {preset: ollama, model: qwen3.6:27b}',
      '  gateway:',
      '    protocol: openai-compatible',
      '    baseUrl: https://gw.example/token-SECRET/v1',
      '    model: gpt-5',
      '    apiKeyEnv: GATEWAY_KEY',
      '    auth: {header: x-gateway-key, prefix: "Key "}',
      '    headers: {x-team: hdr-SECRET}',
      '    query: {api-version: q-SECRET}',
      '    extraBody: {user: body-SECRET}',
      '    temperature: null',
      'roles: {research: local, voter: gateway}',
      'concurrency: 2',
      '',
    ].join('\n'))
    const { io, stdout, stderr } = harness({ argv: ['--print-config', '--config', 'gateway.yaml'], cwd: dir, env: { GATEWAY_KEY: 'sk-live-SECRET' }, isTTY: true })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toBe([
      `source: ${join(dir, 'gateway.yaml')}`,
      'providers:',
      '  local:',
      '    preset: ollama',
      '    origin: http://localhost:11434',
      '    model: qwen3.6:27b',
      '  gateway:',
      '    protocol: openai-compatible',
      '    origin: https://gw.example',
      '    model: gpt-5',
      '    apiKey: "[redacted]"',
      '    auth:',
      '      header: x-gateway-key',
      '      prefix: "Key "',
      '    headers:',
      '      x-team: "[redacted]"',
      '    query:',
      '      api-version: "[redacted]"',
      '    extraBody:',
      '      user: "[redacted]"',
      '    temperature: null',
      'profiles:',
      '  security:',
      '    gating: true',
      '    research: local',
      '    lenses:',
      '      reachability: gateway',
      '      impact: gateway',
      '      defenses: gateway',
      '    thresholds:',
      '      high: 3',
      '      medium: 2',
      '      low: null',
      '    prompts:',
      `      research: ${sha256(securityProfile.prompts.research)}`,
      `      vote: ${sha256(securityProfile.prompts.vote)}`,
      'concurrency: 2',
      'maxFindings: 50',
      'warnings: []',
      '',
    ].join('\n'))
    expect(stdout()).not.toContain('SECRET')
    expect(stderr()).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('redacts a key from the environment and a token in the base URL\'s path, and prints source null with no file', async () => {
    const preset = harness({ argv: ['--print-config'], env: { QUORUM_RESEARCH_PRESET: 'openai', QUORUM_RESEARCH_MODEL: 'gpt-5', OPENAI_API_KEY: 'sk-openai-SECRET' } })
    expect(await runCli(preset.io)).toBe(EXIT.ok)
    expect(preset.stdout()).toMatch(/^source: null\nproviders:\n {2}default:\n {4}preset: openai\n {4}origin: https:\/\/api\.openai\.com\n {4}model: gpt-5\n {4}apiKey: "\[redacted\]"\nprofiles:\n/)
    const path = harness({ argv: ['--print-config'], env: { QUORUM_RESEARCH_BASE_URL: 'https://h.example/token-SECRET/v1', QUORUM_RESEARCH_MODEL: 'm', QUORUM_RESEARCH_API_KEY: 'sk-SECRET' } })
    expect(await runCli(path.io)).toBe(EXIT.ok)
    expect(path.stdout()).toContain('    protocol: openai-compatible\n    origin: https://h.example\n    model: m\n    apiKey: "[redacted]"\n')
    expect(`${preset.stdout()}${path.stdout()}`).not.toContain('SECRET')
  })

  it('lists the config\'s warnings in the YAML, and none on stderr', async () => {
    const { io, stdout, stderr } = harness({ argv: ['--print-config'], env: { RESEARCH_MODEL: 'm' } })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toMatch(/\nwarnings:\n {2}- "RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead"\n$/)
    expect(stderr()).toBe('')
  })

  it('prints only the profiles --profile selects, and a custom prompt by its SHA-256', async () => {
    write('abc.yaml', 'profiles:\n  team: {prompts: {research: abc, vote: abc}, lenses: [{id: a, question: q}]}\n')
    const { io, stdout } = harness({ argv: ['--print-config', '-c', 'abc.yaml', '-p', 'team'], cwd: dir, env: MODEL })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toContain('\nprofiles:\n  team:\n    gating: true\n    research: default\n    lenses:\n      a: default\n    thresholds:\n      high: 1\n      medium: 1\n      low: null\n    prompts:\n      research: sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n')
    expect(stdout()).not.toContain('security')
  })

  it('reads no diff: a diff argument is a usage error', async () => {
    const { io, stdout, stderr } = harness({ argv: ['--print-config', 'x.diff'], env: MODEL })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: --print-config takes no diff file\n${USAGE}`)
  })

  it('prints every line inert, a hidden character in the source path included', async () => {
    const name = `q${String.fromCharCode(0x202E)}.yaml`
    write(name, 'providers:\n  a: {preset: ollama, model: m}\n')
    const { io, stdout } = harness({ argv: ['--print-config', '--config', name], cwd: dir })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toContain(`source: ${join(dir, 'q<U+202E>.yaml')}\n`)
    expect(stdout().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
  })

  it('exits 2 on a configuration error, as a run does', async () => {
    const { io, stdout, stderr } = harness({ argv: ['--print-config'] })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one\n')
  })

  it('exits 2 for a config only the run\'s own build refuses, a provider object whose model is not a string', async () => {
    const bad = write('print-model.mjs', 'export default { providers: { mine: { model: 42, complete: async () => ({ text: \'{}\', model: \'m\' }) } } }\n')
    const printing = harness({ argv: ['--print-config', '--config', bad] })
    expect(await runCli(printing.io)).toBe(EXIT.usage)
    expect(printing.stdout()).toBe('')
    expect(printing.stderr()).toBe('Error: providers.mine.model: must be a string\n')
    const running = harness({ argv: ['--config', bad], stdin: DIFF })
    expect(await runCli(running.io)).toBe(EXIT.usage)
    expect(running.stderr()).toBe(printing.stderr())
  })
})

describe('interrupts', () => {
  it('exits 130 when its signal aborts the review, and writes no result', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF, signal: controller.signal })
    const exit = runCli(io)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    controller.abort()
    expect(await exit).toBe(130)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Research (m @ http://localhost:11434)...\nPanel will use m @ http://localhost:11434\ninterrupted\n')
  })

  it('exits 130 when its signal aborted before the review started, and calls no model', async () => {
    const fetchMock = stubChat()
    const controller = new AbortController()
    controller.abort()
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF, signal: controller.signal })
    expect(await runCli(io)).toBe(EXIT.interrupted)
    expect(stdout()).toBe('')
    expect(stderr()).toMatch(/\ninterrupted\n$/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 3, never 130, when the review rejects with an AbortError its own signal did not raise', async () => {
    const rejects = write('rejects.mjs', 'export default { providers: { mine: { model: \'m\', complete: () => Promise.reject(undefined) } } }\n')
    const controller = new AbortController()
    const { io, stdout, stderr } = harness({ cwd: dir, env: { QUORUM_CONFIG: rejects }, stdin: DIFF, signal: controller.signal })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(controller.signal.aborted).toBe(false)
    expect(stdout()).toBe('')
    expect(stderr()).toMatch(/\nError: .+\n$/)
    expect(stderr()).not.toContain('interrupted')
  })
})

describe('interruptSignal', () => {
  it('aborts on the first SIGINT or SIGTERM, and exits 130 on the next', () => {
    for (const [first, second] of [['SIGINT', 'SIGTERM'], ['SIGTERM', 'SIGINT'], ['SIGINT', 'SIGINT']]) {
      const source = new EventEmitter()
      const exit = vi.fn()
      const signal = interruptSignal(source, exit)
      expect(signal.aborted).toBe(false)
      source.emit(first)
      expect(signal.aborted).toBe(true)
      expect(exit).not.toHaveBeenCalled()
      source.emit(second)
      expect(exit).toHaveBeenCalledExactlyOnceWith(130)
    }
  })
})

describe('inert output', () => {
  it('writes the server text an error quotes inert, on one line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => failed('\u009B2J\u202Eboom\n::error::x')))
    const { io, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(stderr()).toContain('Error: default: HTTP 500: "<U+009B>2J<U+202E>boom\\n::error::x"\n')
    expect(stderr().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
  })

  it('writes the banner inert, a provider object\'s model with a hidden character included', async () => {
    const object = write('object.mjs', `export default { providers: { mine: { model: 'm${String.fromCharCode(0x202E)}', complete: async () => ({ text: '{"findings":[]}', model: 'm' }) } } }\n`)
    const { io, stderr } = harness({ cwd: dir, env: { QUORUM_CONFIG: object }, stdin: '  \n' })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toContain('Research (m<U+202E> @ the provider object mine)...\n')
    expect(stderr().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
  })

  it('keeps a configuration error to one issue per line, and any other error to one line', async () => {
    const config = harness({ env: { ...MODEL, QUORUM_RESEARCH_BASE_URL: 'localhost:11434/v1', QUORUM_RESEARCH_API_KEY: 'sk bad' }, stdin: DIFF })
    expect(await runCli(config.io)).toBe(EXIT.usage)
    expect(config.stderr()).toBe('Error: QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host\nQUORUM_RESEARCH_API_KEY: must only contain visible ASCII characters, which an HTTP header can carry\n')
    const missing = harness({ argv: ['no\nsuch.diff'], env: MODEL })
    expect(await runCli(missing.io)).toBe(EXIT.usage)
    expect(missing.stderr()).toMatch(/^Error: ENOENT: no such file or directory, open '.*no<U\+000A>such\.diff'\nUsage:/)
  })

  it('writes the JSON result inert: it parses back to the text the servers sent', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => chatReply(JSON.stringify({ findings: [FINDING] })))
      .mockImplementation(async () => failed('\u009B2J\u202E')))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(stdout().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
    expect(JSON.parse(stdout()).unreviewed[0].votes[0].error).toBe('default: HTTP 500: "\u009B2J\u202E"')
  })

  it('writes no legacy workflow command, on stderr or in the JSON', async () => {
    stubChat(JSON.stringify({ findings: [{ ...FINDING, file: '##[error]x.js' }, { ...FINDING, summary: '##[add-mask]e' }] }), vote(true), vote(true), vote(true))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(stderr()).toContain('invalid finding dropped: ##<U+005B>error]x.js:1 is not in the diff\n')
    expect(stdout()).toContain('"summary": "##\\u005badd-mask]e"')
    expect(`${stderr()}${stdout()}`).not.toContain('##[')
    expect(JSON.parse(stdout()).kept[0].summary).toBe('##[add-mask]e')
  })

  it('prints a flag on stderr and keeps it out of the exit code', async () => {
    stubChat(JSON.stringify({ findings: [] }))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF.replace('+exec(cmd)', '+exec(cmd)\u202E') })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toContain('flag: hidden-characters at "a.js":1 (U+202E on 1 added line(s))\n')
    expect(JSON.parse(stdout()).meta.flags).toEqual([{ code: 'hidden-characters', file: 'a.js', line: 1, detail: 'U+202E on 1 added line(s)' }])
  })
})
