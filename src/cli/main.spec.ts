import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { securityProfile } from '../profiles/security.ts'
import { fakeClaudeEnv, readFakeRecord, writeFakeClaude } from '../testing/claude.ts'
import { fakeClock } from '../testing/clock.ts'
import { fakeCredential } from '../testing/credentials.ts'
import * as fixtures from '../testing/fixtures/claude-code.ts'
import * as diffs from '../testing/fixtures/git.ts'
import { harness } from '../testing/cli.ts'
import { fakeGit } from '../testing/git.ts'
import { fakeTerminal } from '../testing/terminal.ts'
import type { GitCall, GitReply } from '../testing/git.ts'
import { chatReply, jsonReply, sent, stubChat, stubFetch, stubOllamaChat, textReply } from '../testing/http.ts'
import { CSI, CURSOR_SHOW } from './view/terminal.ts'
import { EXIT, interruptSignal, runCli } from './main.ts'
import type { CliIO } from './main.ts'

/** A directory of its own for the config files and the working directories of these tests. */
let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-cli-'))
})
// Every adapter retries by default, and the system clock reads this at each wait: pinned, no backoff takes time.
beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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

/** The environment of a run with no endpoint set: the built-in default, Ollama's native API on this machine. */
const DEFAULT = { QUORUM_RESEARCH_MODEL: 'm', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' }
/** The environment of a configured run, on Ollama's OpenAI-compatible endpoint, whose replies `stubChat` gives. */
const MODEL = { ...DEFAULT, QUORUM_RESEARCH_BASE_URL: 'http://localhost:11434/v1' }

const DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'
/** Two added lines, so two findings can be cited. */
const TWO_LINE_DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-safe()\n+exec(cmd)\n+eval(x)\n'
const SECOND_FINDING = {
  file: 'a.js',
  line: 2,
  category: 'CWE-95',
  quote: 'eval(x)',
  summary: 'code injection',
}
const FINDING = {
  file: 'a.js',
  line: 1,
  category: 'CWE-78',
  quote: 'exec(cmd)',
  summary: 'command injection',
}
const vote = (keep: boolean): string => JSON.stringify({ keep, reasoning: 'r' })

/** Two profiles, the second with a lens on a provider of its own; every test that uses it writes it, so none depends on another. */
const TWO_YAML = [
  'providers:',
  '  local: {protocol: openai-compatible, baseUrl: "http://localhost:11434/v1", model: m, contextTokens: 131072}',
  '  hosted: {protocol: openai-compatible, baseUrl: "https://v.example/v1", model: v, contextTokens: 131072}',
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
const TEAM_YAML = 'providers:\n  team: {protocol: openai-compatible, baseUrl: "https://team.example/v1", model: t, contextTokens: 131072}\n'

/** The usage text, which `--help` prints on stdout and every usage error prints on stderr. */
const USAGE = [
  'Usage: quorum [options] [diff-file]',
  '       git diff | quorum [options]',
  '       quorum --range <base>...<head> [options]',
  '       quorum --local | --staged [options]',
  '       quorum --path <path> [--at <rev>] [options]',
  '       quorum bench [options] <suite>',
  '       quorum report [options] [<result>|-]',
  '       quorum mcp [options]',
  '',
  'Options:',
  '  -c, --config <path>      Read this config file, over QUORUM_CONFIG',
  '  -p, --profile <id>       Run only this profile; repeat it to run several',
  '      --range <range>      Review a range of commits, written <base>...<head>',
  '      --local              Review the local changes: staged, unstaged and untracked',
  '      --staged             Review the staged changes: what the next commit holds',
  '      --trust-repo-config  Run --local or --staged where the repository\'s own config names a filter program',
  '      --path <path>        Review the files under a path at a commit; repeat it to review several',
  '      --at <rev>           The commit --path reads, HEAD by default',
  '      --no-default-skips   Review in --path the vendored, lockfile, minified, binary and test files too',
  '      --large              Does nothing, and goes in a later release: a --path review\'s token cap follows its estimate',
  '      --send <path>        Send a file held as a secret to the models all the same; repeat it to send several',
  '      --allow-incomplete   Exit 0 instead of 4 when every gap is a vote that failed in passing: a dropped connection, a timeout, or an HTTP 408, 409, 429 or 5xx',
  '      --fail-on <level>    Exit 1 for a kept finding at or above high, medium or low, or never with none; <profile>=<level> sets one profile',
  '  -f, --format <format>    Write the report on stdout in this format: text, json, brief, markdown, payload or sarif; text on a terminal, else json',
  '  -o, --output <output>    Also write a report to a file, written <format>=<path>; repeat it to write several',
  '      --color <when>       Color the text report and the live view: auto, on a terminal unless NO_COLOR is set; always; or never',
  '      --progress <mode>    Show progress on stderr: auto, live on a terminal and plain lines elsewhere; live; plain; json; or none',
  '      --view <view>        Show the full result, or the public view with public: no reasoning, discarded findings, models or usage',
  '      --state <dir>        Save every answered call in this directory, and reuse the calls it holds; a path review on a terminal keeps them in the user\'s cache by default',
  '      --no-state           Keep no answered call, not even in a path review\'s default directory',
  '      --print-config       Print the resolved config, keys redacted, and exit',
  '  -h, --help               Print this help and exit',
  '  -v, --version            Print the version and exit',
  '',
].join('\n')

/** The text a config prints for a prompt: `sha256:` and the lowercase hex SHA-256 of its UTF-8 text. */
const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`

const ESC = String.fromCharCode(0x1B)
/** The sequences quorum colors with: ESC `[`, a code of the SGR table, `m`, and the reset. */
const SGR = new RegExp(`${ESC}\\[(?:1;31|33|36|35|1|32|31|0)m`, 'g')

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
    const { io } = harness({
      argv: ['does-not-exist.diff'],
    })
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
    const env = { QUORUM_RESEARCH_MODEL: 'banner-model', QUORUM_RESEARCH_BASE_URL: 'https://h.example/token-secret/v1', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' }
    const { io, stderr } = harness({ stdin: '  \n', env })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toContain('Research (banner-model @ https://h.example)...')
    expect(stderr()).toContain('Panel will use banner-model @ https://h.example')
    expect(stderr()).not.toMatch(/secret|leaked/)
  })

  it('exits 2 for a base URL holding credentials or a query, and prints neither', async () => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({
      stdin: DIFF,
      env: { ...MODEL, QUORUM_RESEARCH_BASE_URL: 'https://user:pw-secret@h.example/v1?key=q-secret' },
    })
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

  it('refuses a run without a context size before any request, a blank diff included', async () => {
    for (const stdin of [DIFF, '']) {
      const fetchMock = stubChat()
      const { io, stdout, stderr } = harness({
        env: { QUORUM_RESEARCH_MODEL: 'm' },
        stdin,
      })
      expect(await runCli(io)).toBe(EXIT.usage)
      expect(stdout()).toBe('')
      expect(stderr()).toBe('Error: no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens\n')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('runs against the local Ollama\'s native protocol from the variables alone, telling the server the context size and refusing an overflow', async () => {
    const fetchMock = stubOllamaChat('{"findings":[]}')
    const { io } = harness({
      env: { QUORUM_RESEARCH_MODEL: 'qwen3.6:27b', QUORUM_RESEARCH_CONTEXT_TOKENS: '32768' },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, body } = sent(fetchMock)
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(body).toMatchObject({
      model: 'qwen3.6:27b',
      stream: true,
      truncate: false,
      shift: false,
      options: { num_ctx: 32768 },
    })
  })

  it('exits 1 on a unanimous finding through the built-in default, research and votes alike on the native protocol', async () => {
    const fetchMock = stubOllamaChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const { io, stdout } = harness({ env: DEFAULT, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(JSON.parse(stdout()).kept[0]).toMatchObject({ file: 'a.js', confidence: 'high' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array.from({ length: 4 }).fill('http://localhost:11434/api/chat'))
  })

  it('writes a line on stderr as each research part ends, with its time, tokens and findings listed', async () => {
    stubOllamaChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const { io, stderr } = harness({ env: DEFAULT, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(stderr()).toMatch(/^part 1 of 1: answered in \d+(\.\d)?s, \d+ tokens, 1 finding\(s\) listed$/m)
  })

  it('refuses a voter on another endpoint that states no context size of its own', async () => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({
      env: { ...MODEL, QUORUM_VOTER_BASE_URL: 'https://v.example/v1', QUORUM_VOTER_MODEL: 'v' },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe('Error: QUORUM_VOTER_CONTEXT_TOKENS: must be set when the voter variables name a model or an endpoint: a context size belongs to one model on one endpoint\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 3 when the model endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const { io } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
  })

  it('exits 4 with a research-failed gap, instead of throwing, for a failure that has no text form', async () => {
    const reply = {
      get ok(): boolean {
        throw Object.create(null)
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(JSON.parse(stdout()).meta.incomplete.map((entry: { reason: string }) => entry.reason)).toEqual(['research-failed'])
  })

  it('exits 4 with a reply-cut-off gap when a gating profile\'s research reply is cut off, its one-hunk diff being at the floor at once', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonReply({
      choices: [
        {
          finish_reason: 'length',
          message: { content: '{"findings":[' },
        },
      ],
    })))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toEqual([])
    const gapWords = '1 hunk(s) of 1 file(s) were cut off at their reply\'s limit even alone, listed as reply-cut-off in meta.profiles.security.coverage: raise maxTokens, set thinking: low, or lower partTokens'
    expect(result.meta.incomplete).toEqual([
      { profile: 'security', reason: 'reply-cut-off', detail: gapWords },
    ])
    expect(stderr()).toContain(`incomplete: reply-cut-off (${gapWords})`)
  })

  it('exits 3 with the provider-down line, then the server\'s own words, when the endpoint answers 500 to every call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => failed('busy now')))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(stdout()).toBe('')
    expect(stderr().trimEnd().split('\n').slice(-2)).toEqual([
      'Error: default: its one call failed (http 500): lower concurrency or wait',
      'default: HTTP 500: "busy now"',
    ])
  })

  it('calls an endpoint that answers billing_hard_limit_reached once, and records the votes it was never sent as provider-down', async () => {
    const config = write('quota.yaml', 'concurrency: 1\n')
    const fetchMock = stubChat(JSON.stringify({
      findings: [FINDING],
    }))
    fetchMock.mockImplementationOnce(async () => textReply(JSON.stringify({
      error: { code: 'billing_hard_limit_reached', message: 'hard limit' },
    }), 429))
    const { io, stdout, stderr } = harness({
      env: { ...MODEL, QUORUM_CONFIG: config },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stderr()).toContain('default: the account\'s credit, quota or spend limit is used up (http 429): no more calls go to it in this review: add credit or raise the limit at the provider, or wait until it resets')
    const result = JSON.parse(stdout())
    expect(result.unreviewed[0].votes.map((lensVote: { failure: unknown }) => lensVote.failure)).toEqual([
      { kind: 'http', status: 429 },
      { kind: 'provider-down' },
      { kind: 'provider-down' },
    ])
  })

  it('exits 1 on a unanimous finding and prints the result as JSON', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(JSON.parse(stdout()).kept[0]).toMatchObject({
      id: '235f5feb3565',
      profile: 'security',
      file: 'a.js',
      confidence: 'high',
    })
  })

  it('exits 0 when the panel keeps a finding only at medium confidence', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(false))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]).toMatchObject({ file: 'a.js', confidence: 'medium', keptVotes: 2 })
  })

  it('exits 1 for a kept medium finding when the config sets failOn medium', async () => {
    const strict = write('fail-on-medium.yaml', 'profiles:\n  security: {failOn: medium}\n')
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(false))
    const { io, stdout } = harness({
      cwd: dir,
      env: { ...MODEL, QUORUM_CONFIG: strict },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.finding)
    const result = JSON.parse(stdout())
    expect(result.kept[0]).toMatchObject({ confidence: 'medium' })
    expect(result.meta.profiles.security).toMatchObject({ failOn: 'medium', gating: true })
  })

  it('reads gating false in a config as failOn none, with its warning on stderr, and exits 0 for a kept high finding', async () => {
    const deprecated = write('deprecated-gating.yaml', 'profiles:\n  security: {gating: false}\n')
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const { io, stdout, stderr } = harness({
      cwd: dir,
      env: { ...MODEL, QUORUM_CONFIG: deprecated },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr().startsWith('warning: profiles.security.gating is deprecated: set failOn instead, high for true and none for false\n')).toBe(true)
    const result = JSON.parse(stdout())
    expect(result.kept[0]).toMatchObject({ confidence: 'high' })
    expect(result.meta.profiles.security).toMatchObject({ failOn: 'none', gating: false })
  })

  it('exits 1 for a kept medium finding with --fail-on medium, and 0 for a kept high one with --fail-on security=none', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(false))
    const strict = harness({
      argv: ['--fail-on', 'medium'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(strict.io)).toBe(EXIT.finding)
    const medium = JSON.parse(strict.stdout())
    expect(medium.kept[0]).toMatchObject({ confidence: 'medium' })
    expect(medium.meta.profiles.security).toMatchObject({ failOn: 'medium', gating: true })

    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const advisory = harness({
      argv: ['--fail-on', 'security=none'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(advisory.io)).toBe(EXIT.ok)
    const high = JSON.parse(advisory.stdout())
    expect(high.kept[0]).toMatchObject({ confidence: 'high' })
    expect(high.meta.profiles.security).toMatchObject({ failOn: 'none', gating: false })
  })

  it('exits 0 when the panel discards every finding', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(false), vote(false), vote(true))
    const { io } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
  })

  it('retries a vote whose endpoint failed in passing, twice by default, and keeps the finding', async () => {
    const fetchMock = stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => chatReply(vote(true)))
    const { io } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('exits 4 when every voter fails, instead of reading the outage as a clean review', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    })).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toEqual([])
    expect(result.discarded).toEqual([])
    expect(result.unreviewed).toHaveLength(1)
    expect(stderr()).toContain('1 unreviewed')
  })

  it('turns 4 into 0 with --allow-incomplete, and keeps the result', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    })).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({
      argv: ['--allow-incomplete'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(JSON.parse(stdout()).unreviewed).toHaveLength(1)
  })

  it('still exits 1 with --allow-incomplete when a gating high finding is kept', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING, SECOND_FINDING],
    }), vote(true), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io } = harness({
      argv: ['--allow-incomplete'],
      env: MODEL,
      stdin: TWO_LINE_DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.finding)
  })

  it('exits 0 when only an advisory profile\'s review is incomplete', async () => {
    const advisory = write('advisory.yaml', 'profiles:\n  security: {failOn: none}\n')
    stubChat(JSON.stringify({
      findings: [FINDING],
    })).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({
      cwd: dir,
      env: { ...MODEL, QUORUM_CONFIG: advisory },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.unreviewed).toHaveLength(1)
    expect(result.meta.profiles.security.gating).toBe(false)
  })

  it('exits 0 with a research-failed gap when the one profile is advisory and its research reply cannot be read', async () => {
    const advisory = write('advisory.yaml', 'profiles:\n  security: {failOn: none}\n')
    stubChat('No issues found.')
    const { io, stdout, stderr } = harness({
      cwd: dir,
      env: { ...MODEL, QUORUM_CONFIG: advisory },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    const gap = { profile: 'security', reason: 'research-failed', detail: 'the research reply could not be read: reply contains no JSON object' }
    expect(JSON.parse(stdout()).meta.incomplete).toEqual([gap])
    expect(stderr()).toContain(`incomplete: research-failed (${gap.detail})`)
  })

  it('exits 4 when the research reply lists only unusable findings', async () => {
    const fetchMock = stubChat(JSON.stringify({
      findings: [
        { file: 'x.js' },
      ],
    }))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const reasons = JSON.parse(stdout()).meta.incomplete.map((entry: { reason: string }) => entry.reason)
    expect(reasons).toEqual(['finding-unreadable', 'research-unusable'])
    expect(stderr()).toContain('research-unusable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exits 4 when one finding is unreadable, even though another is kept', async () => {
    stubChat(JSON.stringify({
      findings: [
        FINDING,
        { file: 'a.js' },
      ],
    }), vote(true), vote(true), vote(false))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.meta.incomplete).toEqual([
      {
        profile: 'security',
        reason: 'finding-unreadable',
        detail: expect.stringMatching(/^findings\[1\]: /),
      },
    ])
    expect(stderr()).toContain('finding-unreadable')
  })

  it('exits 1 when a high finding is kept, even if another finding is unreviewed', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING, SECOND_FINDING],
    }), vote(true), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ env: MODEL, stdin: TWO_LINE_DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.unreviewed).toHaveLength(1)
  })

  it('exits 0 when a failed vote could not have changed a discard', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(false), vote(false)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.ok)
    const result = JSON.parse(stdout())
    expect(result.discarded).toHaveLength(1)
    expect(result.unreviewed).toEqual([])
  })

  it('exits 4 when a kept medium finding has a failed vote that could have made it high', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true)).mockRejectedValue(new TypeError('fetch failed'))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0].confidence).toBe('medium')
    expect(result.meta.incomplete).toEqual([
      {
        profile: 'security',
        reason: 'vote-failed',
        file: 'a.js',
        detail: expect.stringMatching(/^"a\.js":1 is kept at medium/),
      },
    ])
    expect(stderr()).toContain('vote-failed')
  })

  it('exits 4 with --allow-incomplete when a gating profile\'s vote was cut off at its token limit', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true)).mockImplementationOnce(async () => jsonReply({
      choices: [
        {
          finish_reason: 'length',
          message: { content: '' },
        },
      ],
    }))
    const { io, stdout } = harness({
      argv: ['--allow-incomplete'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    const result = JSON.parse(stdout())
    expect(result.kept[0].confidence).toBe('medium')
    expect(result.kept[0].votes.map((lensVote: { failure: unknown }) => lensVote.failure)).toEqual([
      null,
      null,
      { kind: 'truncated' },
    ])
    expect(result.meta.incomplete).toEqual([
      {
        profile: 'security',
        reason: 'vote-failed',
        file: 'a.js',
        detail: expect.stringMatching(/^"a\.js":1 is kept at medium/),
      },
    ])
  })

  it('prints each warning once, inert, before the banner, and keeps stdout to the JSON result', async () => {
    const { io, stdout, stderr } = harness({
      env: { RESEARCH_MODEL: 'm', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
      stdin: '  \n',
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toBe('warning: RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead\nResearch (m @ http://localhost:11434)...\nPanel will use m @ http://localhost:11434\nempty diff: nothing to review\n0 kept, 0 discarded, 0 unreviewed by panel\n')
    expect(JSON.parse(stdout())).toMatchObject({ kept: [], discarded: [], unreviewed: [] })
  })

  it('sends Ollama\'s native request for an environment-only run, and no key header without a key', async () => {
    const fetchMock = stubOllamaChat('{"findings":[]}', '{"findings":[]}')
    expect(await runCli(harness({
      env: { QUORUM_RESEARCH_MODEL: 'qwen', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
      stdin: DIFF,
    }).io)).toBe(EXIT.ok)
    expect(await runCli(harness({
      env: { QUORUM_RESEARCH_MODEL: 'qwen', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072', QUORUM_RESEARCH_API_KEY: 'sk-test\n' },
      stdin: DIFF,
    }).io)).toBe(EXIT.ok)
    expect(sent(fetchMock, 0)).toMatchObject({
      url: 'http://localhost:11434/api/chat',
      body: {
        model: 'qwen',
        format: 'json',
        options: { temperature: 0, num_ctx: 131072 },
      },
    })
    expect(sent(fetchMock, 0).headers).not.toHaveProperty('authorization')
    expect(sent(fetchMock, 1).headers).toMatchObject({ authorization: 'Bearer sk-test' })
  })

  it('sends the OpenAI-compatible request when a base URL is the only endpoint variable, as before', async () => {
    const fetchMock = stubChat('{"findings":[]}', '{"findings":[]}')
    expect(await runCli(harness({
      env: { ...DEFAULT, QUORUM_RESEARCH_MODEL: 'qwen', QUORUM_RESEARCH_BASE_URL: 'http://localhost:11434/v1' },
      stdin: DIFF,
    }).io)).toBe(EXIT.ok)
    expect(await runCli(harness({
      env: {
        ...DEFAULT,
        QUORUM_RESEARCH_MODEL: 'qwen',
        RESEARCH_BASE_URL: 'http://localhost:11434/v1',
        QUORUM_RESEARCH_API_KEY: 'sk-test',
      },
      stdin: DIFF,
    }).io)).toBe(EXIT.ok)
    expect(sent(fetchMock, 0)).toMatchObject({
      url: 'http://localhost:11434/v1/chat/completions',
      body: {
        model: 'qwen',
        response_format: { type: 'json_object' },
        temperature: 0,
      },
    })
    expect(sent(fetchMock, 0).headers).not.toHaveProperty('authorization')
    expect(sent(fetchMock, 1)).toMatchObject({
      url: 'http://localhost:11434/v1/chat/completions',
      headers: { authorization: 'Bearer sk-test' },
    })
  })

  it('never sends the research key to a voter on another origin, set through the deprecated variables', async () => {
    const fetchMock = stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const env = {
      RESEARCH_BASE_URL: 'https://r.example/v1',
      RESEARCH_API_KEY: 'sk-r',
      RESEARCH_MODEL: 'r',
      VOTER_BASE_URL: 'https://v.example/v1',
      VOTER_MODEL: 'v',
      QUORUM_RESEARCH_CONTEXT_TOKENS: '131072',
      QUORUM_VOTER_CONTEXT_TOKENS: '131072',
    }
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
    const { io, stdout, stderr } = harness({
      env: { RESEARCH_BASE_URL: 'localhost:11434', RESEARCH_MODEL: 'm', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
      stdin: DIFF,
    })
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
    const { io, stdout, stderr } = harness({
      env: {
        ...MODEL,
        QUORUM_VOTER_BASE_URL: 'https://v.example/v1',
        QUORUM_VOTER_CONTEXT_TOKENS: '131072',
        QUORUM_VOTER_MODLE: 'v',
      },
      stdin: DIFF,
    })
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
    const { io, stderr } = harness({
      cwd: dir,
      env: { QUORUM_CONFIG: team },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(sent(fetchMock).url).toBe('https://team.example/v1/chat/completions')
    expect(stderr()).toMatch(/^Research \(t @ https:\/\/team\.example\)\.\.\.\nPanel will use t @ https:\/\/team\.example\nteam: its calls ask for whole replies for the rest of the review: the server answered a streamed call whole; set stream: false to choose it yourself\npart 1 of 1: answered in \d+(\.\d)?s, \d+ tokens, 0 finding\(s\) listed\n0 candidate\(s\) after dedup\n0 kept, 0 discarded, 0 unreviewed by panel\ntime: research \d+(\.\d)?s, dedup \d+(\.\d)?s, panel \d+(\.\d)?s; done in \d+s\ntokens: \d+ percent of the cap of 2000000, the default\ncalls: 1 research; team sent no rate-limit headers, so it ran at most 4 at once: set concurrency to run more, if its gateway has room\nresult: json on stdout\n$/)
  })

  it('exits 2 when the file QUORUM_CONFIG names does not exist, naming it as given', async () => {
    const missing = join(dir, 'missing.yaml')
    const { io, stderr } = harness({
      cwd: dir,
      env: { QUORUM_CONFIG: missing },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: ${missing}: does not exist\n`)
  })

  it('exits 2 when QUORUM_CONFIG is not an absolute path, and reads no file of the working directory', async () => {
    write('team.yaml', TEAM_YAML)
    const fetchMock = stubChat('{"findings":[]}')
    const { io, stdout, stderr } = harness({
      cwd: dir,
      env: { QUORUM_CONFIG: 'team.yaml' },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Error: QUORUM_CONFIG: must be an absolute path\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads no config file it is not named, whatever the working directory holds', async () => {
    const planted = join(dir, 'planted')
    mkdirSync(planted)
    const evil = 'providers:\n  evil: {protocol: openai-compatible, baseUrl: "https://attacker.example/v1", model: e, contextTokens: 131072, apiKeyEnv: JOB_KEY}\n'
    writeFileSync(join(planted, 'quorum.config.yaml'), evil)
    writeFileSync(join(planted, 'quorum.yaml'), evil)
    writeFileSync(join(planted, 'quorum.config.mts'), 'globalThis.quorumPlanted = true\nexport default {}\n')
    const fetchMock = stubChat('{"findings":[]}')
    const { io, stderr } = harness({
      cwd: planted,
      env: { ...MODEL, JOB_KEY: 'sk-job' },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://localhost:11434/v1/chat/completions'])
    expect((globalThis as { quorumPlanted?: unknown }).quorumPlanted).toBeUndefined()
    expect(stderr()).not.toMatch(/attacker|warning/)
  })

  it('prefixes the lines of each profile when several run, lists each lens\'s provider when they differ, and prints the core\'s warnings', async () => {
    const two = write('two.yaml', TWO_YAML)
    stubFetch({
      choices: [
        {
          message: { content: '{"findings":[]}' },
        },
      ],
    })
    const { io, stderr } = harness({
      cwd: dir,
      env: { QUORUM_CONFIG: two },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    const lines = stderr().split('\n')
    expect(lines.slice(0, 5)).toEqual([
      'warning: team.policy.medium needs the same 2 vote(s) as policy.high with 2 lens(es), so it never applies',
      '[security] Research (m @ http://localhost:11434)...',
      '[security] Panel will use m @ http://localhost:11434',
      '[team] Research (m @ http://localhost:11434)...',
      '[team] Panel will use grounded (m @ http://localhost:11434), significant (v @ https://v.example)',
    ])
    // Each profile's part line comes before its dedup line, with its prefix; how the two profiles interleave depends on scheduling.
    for (const profile of ['security', 'team']) {
      expect(lines.filter(line => line.startsWith(`[${profile}] `) && /part \d|dedup/.test(line))).toEqual([
        expect.stringMatching(new RegExp(`^\\[${profile}\\] part 1 of 1: answered in \\d+(\\.\\d)?s, \\d+ tokens, 0 finding\\(s\\) listed$`)),
        `[${profile}] 0 candidate(s) after dedup`,
      ])
    }
    // The JSON stub answers each streamed request whole, so the provider the two profiles share is moved to whole replies, said once.
    expect(lines.filter(line => line.includes('the server answered a streamed call whole'))).toEqual([
      expect.stringMatching(/^[\w-]+: its calls ask for whole replies for the rest of the review: the server answered a streamed call whole; set stream: false to choose it yourself$/),
    ])
    expect(lines.slice(5)).toHaveLength(11)
    // The summary ends the review, after the totals line.
    expect(lines.slice(-6)).toEqual([
      '0 kept, 0 discarded, 0 unreviewed by panel',
      expect.stringMatching(/^time: research \d+(\.\d)?s, dedup \d+(\.\d)?s, panel \d+(\.\d)?s; done in \d+s$/),
      expect.stringMatching(/^tokens: \d+ percent of the cap of 2000000, the default$/),
      'calls: 2 research; local sent no rate-limit headers, so it ran at most 4 at once: set concurrency to run more, if its gateway has room',
      'result: json on stdout',
      '',
    ])
  })
})

describe('--state', () => {
  /** A directory of its own for the state a test keeps, which no other test reads. */
  let state = ''
  beforeEach(() => {
    state = realpathSync(mkdtempSync(join(dir, 'state-')))
  })
  const refusedWith = async (argv: string[], env = DEFAULT): Promise<{ readonly code: number, readonly stderr: string }> => {
    const fetchMock = stubOllamaChat()
    const { io, stderr } = harness({ env, stdin: DIFF, argv })
    const code = await runCli(io)
    expect(fetchMock).not.toHaveBeenCalled()
    return {
      code,
      stderr: stderr(),
    }
  }

  it('reuses a --state directory on a rerun, printing what it reused', async () => {
    const directory = join(state, 'calls')
    const first = stubOllamaChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const run = harness({
      env: DEFAULT,
      stdin: DIFF,
      argv: ['--state', directory],
    })
    expect(await runCli(run.io)).toBe(EXIT.finding)
    expect(first).toHaveBeenCalledTimes(4)
    // A first run reuses nothing and says nothing of it.
    expect(run.stderr()).not.toContain('reused from the saved state')
    expect(JSON.parse(run.stdout()).meta.reused).toEqual({ research: 0, votes: 0 })
    expect(readdirSync(directory)).toHaveLength(5)
    // The rerun asks no model, and spends nothing: its result is the first's.
    vi.unstubAllGlobals()
    const second = stubOllamaChat()
    const rerun = harness({
      env: DEFAULT,
      stdin: DIFF,
      argv: ['--state', directory],
    })
    expect(await runCli(rerun.io)).toBe(EXIT.finding)
    expect(second).not.toHaveBeenCalled()
    expect(rerun.stderr()).toContain('reused from the saved state: 1 research call(s), 3 vote(s)\n')
    const result = JSON.parse(rerun.stdout())
    expect(result.meta.reused).toEqual({ research: 1, votes: 3 })
    expect(result.meta).not.toHaveProperty('usage')
    expect(result.kept[0]).toMatchObject({ file: 'a.js', confidence: 'high' })
    // The line comes before the report, and names no path.
    expect(rerun.stderr()).not.toContain(directory)
    // A run with no --state has no reused count.
    const plain = harness({ env: DEFAULT, stdin: '  \n' })
    await runCli(plain.io)
    expect(JSON.parse(plain.stdout()).meta).not.toHaveProperty('reused')
  })

  it('refuses --state twice, empty, or with --print-config', async () => {
    expect(await refusedWith([
      '--state',
      join(state, 'a'),
      '--state',
      join(state, 'b'),
    ])).toEqual({ code: EXIT.usage, stderr: `Error: --state: takes one directory\n${USAGE}` })
    expect(await refusedWith(['--state', ''])).toEqual({ code: EXIT.usage, stderr: `Error: --state: must name a directory\n${USAGE}` })
    expect(await refusedWith([
      '--state',
      join(state, 'a'),
      '--print-config',
    ])).toEqual({ code: EXIT.usage, stderr: `Error: --print-config: reads no diff and calls no model, so it takes no --state\n${USAGE}` })
    // A directory the store refuses is refused before any call, by the flag and never the path.
    symlinkSync(state, join(state, 'link'))
    const linked = await refusedWith([
      '--state',
      join(state, 'link'),
    ])
    expect(linked).toEqual({ code: EXIT.usage, stderr: 'Error: --state: is a symbolic link\n' })
    expect(readdirSync(state)).toEqual(['link'])
  })
})

describe('content the diff does not carry', () => {
  const WITH_IMAGE = `${DIFF}diff --git a/img.png b/img.png\nindex 9597448..9ad844f 100644\nBinary files a/img.png and b/img.png differ\n`

  it('exits 4 for a binary file, even with --allow-incomplete, lists it in the result, and still sends its section', async () => {
    for (const argv of [
      [],
      ['--allow-incomplete'],
    ]) {
      const fetchMock = stubChat(JSON.stringify({ findings: [] }))
      const { io, stdout, stderr } = harness({ argv, env: MODEL, stdin: WITH_IMAGE })
      expect(await runCli(io)).toBe(EXIT.incomplete)
      expect(JSON.parse(stdout()).meta.leftOut).toEqual([
        { file: 'img.png', reason: 'binary' },
      ])
      expect(stderr()).toContain('\nleft out: 1 file(s): "img.png" (binary)\nincomplete: binary (the diff carries no content for 1 binary file(s), listed in meta.leftOut)\n')
      expect((sent(fetchMock).body.messages as Array<{ content: string }>)[1].content).toContain('Binary files a/img.png and b/img.png differ')
    }
  })
})

describe('files held back as secrets', () => {
  const ENV = 'diff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+MODE=production\n'
  const NOTHING = JSON.stringify({ findings: [] })
  /** The text of every request the stub received, whole. */
  const requests = (fetchMock: ReturnType<typeof stubChat>): string[] => fetchMock.mock.calls.map(call => String(call[1].body))

  it('exits 4 for a piped diff holding .env, sending none of it, with the left out and flag lines', async () => {
    const fetchMock = stubChat(NOTHING)
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: `${ENV}${DIFF}` })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const body of requests(fetchMock)) expect(body).not.toContain('MODE=production')
    expect(requests(fetchMock)[0]).toContain('exec(cmd)')
    expect(JSON.parse(stdout()).meta.leftOut).toEqual([
      { file: '.env', reason: 'secret', rule: 'name' },
    ])
    expect(stderr()).toContain('\nleft out: 1 file(s): ".env" (secret: name)\n')
    expect(stderr()).toContain('\nflag: secret-file at ".env" (named as a secret, so no model was sent any of it: check that it belongs in the change)\n')
    expect(stderr()).toContain('\nincomplete: secret (no model was sent 1 file(s) held as secrets, listed in meta.leftOut)\n')
  })

  it('exits 4 for a piped diff whose only file is held, with no call', async () => {
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: ENV })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(stdout()).meta.incomplete).toEqual([
      { profile: 'security', reason: 'secret', detail: 'no model was sent 1 file(s) held as secrets, listed in meta.leftOut' },
    ])
    expect(stderr()).toContain('\nleft out: 1 file(s): ".env" (secret: name)\n')
  })

  it('exits 0 for a piped diff that deletes .env whole', async () => {
    const fetchMock = stubChat(NOTHING)
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: diffs.DELETED_SECRET })
    expect(await runCli(io)).toBe(EXIT.ok)
    for (const body of requests(fetchMock)) expect(body).not.toContain('A=1')
    expect(JSON.parse(stdout()).meta.leftOut).toEqual([
      { file: '.env', reason: 'deleted-secret', rule: 'name' },
    ])
    expect(JSON.parse(stdout()).meta.incomplete).toEqual([])
    expect(stderr()).toContain('\nleft out: 1 file(s): ".env" (deleted-secret: name)\n')
    expect(stderr()).toContain('\nflag: secret-file at ".env" (deletes a file named as a secret, so no model was sent any of it: the history still holds the file, so rotate what it held)\n')
    expect(stderr()).not.toContain('incomplete:')
  })

  it('keeps exit 4 for a held file under --allow-incomplete', async () => {
    const fetchMock = stubChat(NOTHING)
    const { io, stdout } = harness({
      argv: ['--allow-incomplete'],
      env: MODEL,
      stdin: `${ENV}${DIFF}`,
    })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(stdout()).meta.incomplete.map((entry: { reason: string }) => entry.reason)).toEqual(['secret'])
  })

  it('exits 4 for a piped diff that deletes a code file holding a key, echoing no piece of it', async () => {
    const key = fakeCredential('github-token')
    const removal = `diff --git a/src/authz.ts b/src/authz.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/src/authz.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-export const allowed = false\n-const k = '${key}'\n`
    const fetchMock = stubChat(NOTHING)
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: `${removal}${DIFF}` })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(JSON.parse(stdout()).meta.leftOut).toEqual([
      { file: 'src/authz.ts', reason: 'secret', rule: 'github-token' },
    ])
    expect(stderr()).toContain('\nleft out: 1 file(s): "src/authz.ts" (secret: github-token)\n')
    expect(stderr()).toContain('\nincomplete: secret (no model was sent 1 file(s) held as secrets, listed in meta.leftOut)\n')
    const pieces = key.match(/.{1,8}/g) ?? []
    expect(pieces.length).toBeGreaterThan(2)
    for (const text of [
      stdout(),
      stderr(),
      ...requests(fetchMock),
    ]) {
      for (const piece of pieces) expect(text).not.toContain(piece)
    }
    expect(requests(fetchMock).join('')).not.toContain('export const allowed')
  })

  it('exits 4 for a key in an ordinary file, echoing no piece of it', async () => {
    const key = fakeCredential('stripe-key')
    const stripe = `diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1,2 @@\n const a = 1\n+const k = '${key}'\n`
    const fetchMock = stubChat(NOTHING)
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: `${stripe}${DIFF}` })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(JSON.parse(stdout()).meta.leftOut).toEqual([
      { file: 'src/app.js', reason: 'secret', rule: 'stripe-key' },
    ])
    expect(stderr()).toContain('\nleft out: 1 file(s): "src/app.js" (secret: stripe-key)\n')
    const pieces = key.match(/.{1,8}/g) ?? []
    expect(pieces.length).toBeGreaterThan(2)
    for (const text of [
      stdout(),
      stderr(),
      ...requests(fetchMock),
    ]) {
      for (const piece of pieces) expect(text).not.toContain(piece)
    }
  })

  it('sends a held file that --send names, by the path the left out line prints', async () => {
    const fetchMock = stubChat(NOTHING)
    const { io, stdout, stderr } = harness({
      argv: ['--send', '.env'],
      env: MODEL,
      stdin: ENV,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requests(fetchMock)[0]).toContain('+MODE=production')
    expect(JSON.parse(stdout()).meta.leftOut).toEqual([])
    expect(stderr()).not.toContain('left out:')
    expect(stderr()).not.toContain('secret-file')
  })

  it('keeps a file held when --send names it otherwise than the diff does', async () => {
    const nested = ENV.replaceAll('.env', 'src/.env')
    // The diff's header writes the name as git quotes it, and the file's path is the decoded one: a `--send` in git's quoted spelling, as typed, names no file.
    const quotedName = String.raw`caf\303\251/.env`
    const quoted = ENV.replaceAll('a/.env', `"a/${quotedName}"`).replaceAll('b/.env', `"b/${quotedName}"`)
    const decoded = `caf${String.fromCharCode(0xE9)}/.env`
    for (const [send, stdin, file] of [
      ['./.env', ENV, '.env'],
      ['.env', nested, 'src/.env'],
      [`"${quotedName}"`, quoted, decoded],
    ]) {
      const fetchMock = stubChat(NOTHING)
      const { io, stdout, stderr } = harness({
        argv: ['--send', send],
        env: MODEL,
        stdin,
      })
      expect(await runCli(io)).toBe(EXIT.incomplete)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(JSON.parse(stdout()).meta.leftOut).toEqual([
        { file, reason: 'secret', rule: 'name' },
      ])
      expect(stderr()).toContain(`\nleft out: 1 file(s): "${file}" (secret: name)\n`)
      vi.unstubAllGlobals()
    }
  })
})

describe('the files a named config excludes', () => {
  it('leaves out the files the named config excludes, lists them, and calls no model when it excludes every file', async () => {
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({
      argv: [
        '--config',
        write('exclude.yaml', `${TEAM_YAML}exclude:\n  - "*.js"\n`),
      ],
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(stdout()).meta.leftOut).toEqual([
      { file: 'a.js', reason: 'excluded' },
    ])
    expect(stderr()).toContain('\nleft out: 1 file(s): "a.js" (excluded)\n')
  })

  it('exits 2 for a misleading pattern of the named config, naming the file and the index, before any call', async () => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({
      argv: [
        '--config',
        write('slash.yaml', `${TEAM_YAML}exclude:\n  - vendor/\n`),
      ],
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stderr()).toBe(`Error: ${join(dir, 'slash.yaml')}: exclude.0: ends with /, so it matches no file: end it with /** to leave out what the directory holds\n`)
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
    return {
      stdin: Object.assign(chunks(), { isTTY: false }),
      pulled: () => pulled,
    }
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
    const { io, stderr } = harness({
      env: MODEL,
      stdin: String.fromCharCode(0xE9).repeat(8 * MiB + 1),
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(OVER)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a diff file over 16 MiB', async () => {
    const fetchMock = stubChat()
    const path = join(dir, 'huge.diff')
    writeFileSync(path, new Uint8Array(16 * MiB + 1).fill(0x61))
    const { io, stderr } = harness({
      argv: [path],
      env: MODEL,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(OVER)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops a byte-order mark at the start of a diff file, as it does on stdin', async () => {
    const fetchMock = stubChat(JSON.stringify({ findings: [] }))
    const { io } = harness({
      argv: [
        write('bom.diff', `${String.fromCharCode(0xFEFF)}${DIFF}`),
      ],
      env: MODEL,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect((sent(fetchMock).body.messages as Array<{ content: string }>)[1].content).toContain(`>\n${DIFF}\n</untrusted-diff-`)
  })
})

describe('the room accounting', () => {
  /** The refusal of the research request, for the one provider `local` of 2000 tokens: 2000 less 1791 of text, 512 of template and 500 of reply. */
  const RESEARCH = 'profiles.security: the research request on local leaves -803 tokens for the diff, less than the 1024 a hunk may need: contextTokens 2000 counts 1791 for the instructions, guidelines and rules, 512 for the chat template and 500 for the reply: shorten the guidelines or rules, lower maxTokens, or state a larger window\n'

  it('refuses before any call, exit 2, a profile whose research request leaves its model no room for a diff', async () => {
    const config = write('small.yaml', 'providers:\n  local: {protocol: openai-compatible, baseUrl: "http://localhost:11434/v1", model: m, contextTokens: 2000}\n')
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({
      argv: ['--config', config, '--allow-incomplete'],
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stdout()).toBe('')
    // The one provider holds the votes too, whose fixed text leaves no room either: both are refused at once.
    expect(stderr()).toContain(`Error: ${RESEARCH}`)
    expect(stderr()).toMatch(/\nprofiles\.security: the vote request on local for the longest finding leaves -\d+ tokens for the diff, less than the 1024 a hunk may need: contextTokens 2000 counts \d+ for the instructions, guidelines and finding, 512 for the chat template and 500 for the reply: shorten the guidelines, lower maxTokens, or state a larger window\n/)
    expect(stderr()).not.toContain('http')
  })

  it('refuses a profile before it reads the source, a range or a path: no git runs', async () => {
    const config = write('small-source.yaml', 'providers:\n  local: {protocol: openai-compatible, baseUrl: "http://localhost:11434/v1", model: m, contextTokens: 2000}\n')
    for (const source of [
      ['--range', 'main...feature'],
      ['--path', 'src'],
    ]) {
      const fetchMock = stubChat()
      const fake = fakeGit(() => ({ stdout: `${'a'.repeat(40)}\n` }))
      const { io, stdout, stderr } = harness({
        argv: [
          '--config',
          config,
          ...source,
        ],
        git: { executable: '/usr/bin/git', spawn: fake.spawn },
        platform: 'linux',
      })
      expect(await runCli(io)).toBe(EXIT.usage)
      expect(stderr()).toContain(`Error: ${RESEARCH}`)
      expect(stdout()).toBe('')
      expect(fake.calls, source[0]).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('refuses before any call, exit 2, a voter whose request for the longest finding leaves no room for a diff', async () => {
    const yaml = [
      'providers:',
      '  local: {protocol: openai-compatible, baseUrl: "http://localhost:11434/v1", model: m, contextTokens: 1000000}',
      '  small: {protocol: openai-compatible, baseUrl: "https://v.example/v1", model: v, contextTokens: 2000}',
      'roles: {research: local, voter: small}',
      '',
    ].join('\n')
    const fetchMock = stubChat(JSON.stringify({
      findings: [FINDING],
    }))
    const { io, stdout, stderr } = harness({
      argv: [
        '--config',
        write('small-voter.yaml', yaml),
        '--allow-incomplete',
      ],
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stdout()).toBe('')
    expect(stderr()).toMatch(/^Error: profiles\.security: the vote request on small for the longest finding leaves -\d+ tokens for the diff, less than the 1024 a hunk may need: contextTokens 2000 counts \d+ for the instructions, guidelines and finding, 512 for the chat template and 500 for the reply: shorten the guidelines, lower maxTokens, or state a larger window\n/)
    expect(stderr()).not.toContain('the research request')
  })
})

describe('flags', () => {
  it('prints the help on stdout and exits 0, reading neither the diff nor a config', async () => {
    for (const flag of ['--help', '-h']) {
      const fetchMock = stubChat()
      const { io, stdout, stderr } = harness({
        argv: [flag, 'ignored.diff'],
        isTTY: true,
      })
      expect(await runCli(io)).toBe(EXIT.ok)
      expect(stdout()).toBe(USAGE)
      expect(stderr()).toBe('')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('prints the version on stdout and exits 0', async () => {
    const { io, stdout } = harness({
      argv: ['--version'],
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toBe(`quorum ${packageJson.version}\n`)
  })

  it('reads a diff file named like a flag after --', async () => {
    const { io, stderr } = harness({
      argv: ['--', '--help'],
      env: MODEL,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: the diff file does not exist\n${USAGE}`)
  })

  it('exits 2 for an unknown flag, naming it and never a value given with it', async () => {
    const { io, stdout, stderr } = harness({
      argv: ['--nope=sk-SECRET'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--nope"\n${USAGE}`)
    expect(`${stdout()}${stderr()}`).not.toContain('SECRET')
  })

  it('keeps a usage error of several lines to one inert line each', async () => {
    const { io, stderr } = harness({
      argv: ['--config', '--help'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: Option '--config' argument is ambiguous.\nDid you forget to specify the option argument for '--config'?\nTo specify an option argument starting with a dash use '--config=-XYZ'.\n${USAGE}`)
  })

  it('exits 2 for a second diff argument', async () => {
    const { io, stderr } = harness({
      argv: ['a.diff', 'b.diff'],
      env: MODEL,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: takes one diff file, and 1 more argument(s) were given\n${USAGE}`)
  })

  it('exits 2 for an empty --config instead of reading the working directory', async () => {
    const { io, stderr } = harness({
      argv: ['--config='],
      cwd: dir,
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(`Error: --config: must name a file\n${USAGE}`)
  })

  it('reads the file --config names, over the one QUORUM_CONFIG names', async () => {
    write('flag.yaml', 'providers:\n  flag: {protocol: openai-compatible, baseUrl: "https://flag.example/v1", model: f, contextTokens: 131072}\n')
    const team = write('team.yaml', TEAM_YAML)
    const fetchMock = stubChat('{"findings":[]}')
    const { io } = harness({
      argv: ['-c', 'flag.yaml'],
      cwd: dir,
      env: { QUORUM_CONFIG: team },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(sent(fetchMock).url).toBe('https://flag.example/v1/chat/completions')
  })

  it('runs only the profiles --profile names, over QUORUM_PROFILES', async () => {
    const two = write('two.yaml', TWO_YAML)
    stubFetch({
      choices: [
        {
          message: { content: '{"findings":[]}' },
        },
      ],
    })
    const team = harness({
      argv: ['--profile', 'team'],
      cwd: dir,
      env: { QUORUM_CONFIG: two },
      stdin: DIFF,
    })
    expect(await runCli(team.io)).toBe(EXIT.ok)
    expect(Object.keys(JSON.parse(team.stdout()).meta.profiles)).toEqual(['team'])
    expect(team.stderr()).toContain('\nPanel will use grounded (m @ http://localhost:11434), significant (v @ https://v.example)\n')
    const security = harness({
      argv: ['-p', 'security'],
      cwd: dir,
      env: { QUORUM_CONFIG: two, QUORUM_PROFILES: 'team' },
      stdin: DIFF,
    })
    expect(await runCli(security.io)).toBe(EXIT.ok)
    expect(Object.keys(JSON.parse(security.stdout()).meta.profiles)).toEqual(['security'])
  })

  it.each<[string[], string]>([
    [
      [
        '--profile',
        'security',
        '--profile',
        'security',
      ],
      'Error: --profile: names a profile more than once\n',
    ],
    [
      ['--profile', 'secrity'],
      'Error: --profile: unknown profile "secrity" (did you mean "security"?)\n',
    ],
    [
      ['-p', 'Security'],
      'Error: --profile: must be a profile id matching ^[a-z][a-z0-9_-]*$\n',
    ],
  ])('exits 2 for --profile %j, before any request', async (argv, error) => {
    const fetchMock = stubChat()
    const { io, stderr } = harness({ argv, env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe(error)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each<[string[], string]>([
    [
      ['--fail-on', 'critical'],
      'must be a level, high, medium, low or none, or <profile>=<level>',
    ],
    [
      [
        '--fail-on',
        'high',
        '--fail-on',
        'low',
      ],
      'takes one level for every profile',
    ],
    [
      ['--fail-on=team=x'],
      'must be a level, high, medium, low or none, or <profile>=<level>',
    ],
  ])('refuses %j before any config, with the usage', async (argv, message) => {
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({ argv, env: {}, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: --fail-on: ${message}\n${USAGE}`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 2 for --fail-on naming a profile that does not run, before any call', async () => {
    const two = write('two.yaml', TWO_YAML)
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({
      argv: [
        '--profile',
        'security',
        '--fail-on',
        'team=none',
      ],
      cwd: dir,
      env: { QUORUM_CONFIG: two },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Error: --fail-on: names the profile "team", which does not run\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('writes the brief line on stdout with -f brief, and exits with the code it names', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const failing = harness({
      argv: ['-f', 'brief'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(failing.io)).toBe(EXIT.finding)
    expect(failing.stdout()).toBe('quorum: findings: 1 kept (1 high), 0 unreviewed, 0 gaps, 0 left out, 0 flags; exit 1\n')
    expect(failing.stderr()).toContain('Research (m @ http://localhost:11434)...\n')

    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(false))
    const passing = harness({
      argv: ['--format=brief'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(passing.io)).toBe(EXIT.ok)
    expect(passing.stdout()).toBe('quorum: pass: 1 kept (1 medium), 0 unreviewed, 0 gaps, 0 left out, 0 flags; exit 0\n')
  })

  it('writes the summary with -f markdown, the public view whatever --view says', async () => {
    const reasoning = JSON.stringify({ keep: true, reasoning: 'REASONING-CANARY' })
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), reasoning, reasoning, reasoning)
    const { io, stdout } = harness({
      argv: ['-f', 'markdown', '--view', 'full'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.finding)
    const lines = stdout().split('\n')
    expect(lines.slice(0, 4)).toEqual([
      '<!-- quorum:summary:v1 -->',
      '### quorum review',
      '',
      '**exit 1, findings:** a gating profile kept a finding at or above its fail-on level',
    ])
    expect(lines).toContain('- **HIGH** security · `a.js` line 1 · `CWE-78` · kept by 3 of 3 lenses')
    expect(lines.at(-2)).toBe(`quorum ${packageJson.version} · diff`)
    expect(stdout()).not.toContain('CANARY')
  })

  it('chooses the format by stdout alone: text on a terminal whatever stdin is, json on a pipe though stdin is a terminal', async () => {
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const terminal = harness({
      env: MODEL,
      stdin: DIFF,
      stdoutIsTTY: true,
    })
    expect(await runCli(terminal.io)).toBe(EXIT.finding)
    expect(terminal.stdout().startsWith(`quorum ${packageJson.version} · diff · security · 1 file\n`)).toBe(true)

    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const pipe = harness({
      argv: [
        write('chosen.diff', DIFF),
      ],
      env: MODEL,
      isTTY: true,
    })
    expect(await runCli(pipe.io)).toBe(EXIT.finding)
    expect(JSON.parse(pipe.stdout())).toMatchObject({
      kept: [
        { file: 'a.js', confidence: 'high' },
      ],
    })
  })

  it('colors the report on a terminal unless NO_COLOR is set, and keeps JSON there with -f json', async () => {
    const stub = (): void => {
      stubChat(JSON.stringify({
        findings: [FINDING],
      }), vote(true), vote(true), vote(true))
    }
    stub()
    const colored = harness({
      env: MODEL,
      stdin: DIFF,
      stdoutIsTTY: true,
    })
    expect(await runCli(colored.io)).toBe(EXIT.finding)
    expect(colored.stdout()).toContain(`${ESC}[1;31mHIGH${ESC}[0m  security  ${ESC}[1ma.js:1${ESC}[0m  CWE-78\n`)
    expect(colored.stdout()).toContain(`exit 1, ${ESC}[31mfindings${ESC}[0m: `)

    stub()
    const plain = harness({
      env: { ...MODEL, NO_COLOR: '1' },
      stdin: DIFF,
      stdoutIsTTY: true,
    })
    expect(await runCli(plain.io)).toBe(EXIT.finding)
    expect(plain.stdout()).toContain('HIGH  security  a.js:1  CWE-78\n')
    expect(plain.stdout()).not.toContain(ESC)

    stub()
    const json = harness({
      argv: ['-f', 'json'],
      env: MODEL,
      stdin: DIFF,
      stdoutIsTTY: true,
    })
    expect(await runCli(json.io)).toBe(EXIT.finding)
    expect(JSON.parse(json.stdout())).toMatchObject({
      kept: [
        { file: 'a.js' },
      ],
    })
    expect(json.stdout()).not.toContain(ESC)
  })

  it('prints a hostile claim inert on a terminal, with color on', async () => {
    stubChat(JSON.stringify({
      findings: [
        { ...FINDING, summary: '::error::x ##[add-mask]e' },
      ],
    }), vote(true), vote(true), vote(true))
    const { io, stdout } = harness({
      env: MODEL,
      stdin: DIFF,
      stdoutIsTTY: true,
    })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(stdout().split('\n')).toContain('  <U+003A>:error::x ##<U+005B>add-mask]e')
    expect(stdout()).toContain(`${ESC}[1;31mHIGH${ESC}[0m`)
    expect(stdout().replace(SGR, '')).not.toContain(ESC)
  })

  it('writes the --output files beside the report on stdout, and exits with the review\'s code', async () => {
    const cwd = mkdtempSync(join(dir, 'outputs-'))
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), vote(true), vote(true), vote(true))
    const { io, stdout } = harness({
      argv: [
        '-f',
        'brief',
        '--output',
        'json=r.json',
        '--output',
        'text=r.txt',
      ],
      cwd,
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(stdout()).toBe('quorum: findings: 1 kept (1 high), 0 unreviewed, 0 gaps, 0 left out, 0 flags; exit 1\n')
    expect(JSON.parse(readFileSync(join(cwd, 'r.json'), 'utf8'))).toMatchObject({
      kept: [
        { file: 'a.js', confidence: 'high' },
      ],
    })
    expect(readFileSync(join(cwd, 'r.txt'), 'utf8').startsWith('quorum ')).toBe(true)
  })

  it('writes the summary on stderr after the report on stdout and the --output files', async () => {
    const cwd = mkdtempSync(join(dir, 'outputs-'))
    stubChat('{"findings":[]}')
    const order: string[] = []
    let fileThen: boolean | undefined
    const { io, stderr } = harness({
      argv: ['--output', 'json=r.json'],
      cwd,
      env: MODEL,
      stdin: DIFF,
      onStderr: (text) => {
        order.push(`stderr: ${text.trimEnd()}`)
        if (text.startsWith('time: ')) fileThen = existsSync(join(cwd, 'r.json'))
      },
    })
    const base = io.stdout.write
    io.stdout.write = (text) => {
      order.push('stdout')
      base(text)
    }
    expect(await runCli(io)).toBe(EXIT.ok)
    const report = order.indexOf('stdout')
    const summary = order.findIndex(entry => entry.startsWith('stderr: time: '))
    expect(report).toBeGreaterThan(-1)
    expect(summary).toBeGreaterThan(report)
    expect(order.slice(summary).every(entry => entry.startsWith('stderr: '))).toBe(true)
    expect(fileThen).toBe(true)
    expect(order.at(-1)).toBe('stderr: result: json on stdout; --output json written')
    expect(stderr()).not.toContain(cwd)
    expect(stderr()).not.toContain('r.json')
  })

  it('exits 2 before any call for an --output whose path is a symbolic link', async () => {
    const cwd = mkdtempSync(join(dir, 'outputs-'))
    writeFileSync(join(cwd, 'mine'), 'mine')
    symlinkSync(join(cwd, 'mine'), join(cwd, 'r.json'))
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({
      argv: ['--output', 'json=r.json'],
      cwd,
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Error: --output json: is a symbolic link\n')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readFileSync(join(cwd, 'mine'), 'utf8')).toBe('mine')
  })

  it('exits 3 when an --output file cannot be written, after writing stdout', async () => {
    const cwd = mkdtempSync(join(dir, 'outputs-'))
    const gone = join(cwd, 'gone')
    mkdirSync(gone)
    const fetchMock = vi.fn()
    fetchMock.mockImplementationOnce(async () => {
      rmSync(gone, { recursive: true })
      return chatReply(JSON.stringify({
        findings: [FINDING],
      }))
    })
    for (let calls = 0; calls < 3; calls += 1) fetchMock.mockImplementationOnce(async () => chatReply(vote(true)))
    vi.stubGlobal('fetch', fetchMock)
    const { io, stdout, stderr } = harness({
      argv: ['--output', 'json=gone/r.json'],
      cwd,
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(JSON.parse(stdout())).toMatchObject({
      kept: [
        { file: 'a.js', confidence: 'high' },
      ],
    })
    expect(stderr().endsWith('Error: --output json: cannot be written (ENOENT)\n')).toBe(true)
    expect(stderr()).not.toContain(cwd)
  })

  it('keeps the message of an --output file that cannot be written under --view public', async () => {
    const cwd = mkdtempSync(join(dir, 'outputs-'))
    const gone = join(cwd, 'gone')
    mkdirSync(gone)
    const fetchMock = vi.fn()
    fetchMock.mockImplementationOnce(async () => {
      rmSync(gone, { recursive: true })
      return chatReply(JSON.stringify({
        findings: [FINDING],
      }))
    })
    for (let calls = 0; calls < 3; calls += 1) fetchMock.mockImplementationOnce(async () => chatReply(vote(true)))
    vi.stubGlobal('fetch', fetchMock)
    const { io, stderr } = harness({
      argv: [
        '--view',
        'public',
        '--output',
        'json=gone/r.json',
      ],
      cwd,
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(stderr().endsWith('Error: --output json: cannot be written (ENOENT)\n')).toBe(true)
    expect(stderr()).not.toContain(cwd)
  })

  it('refuses an unknown --format before any config, with the usage', async () => {
    const fetchMock = stubChat()
    const { io, stdout, stderr } = harness({
      argv: ['--format', 'xml'],
      env: {},
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: --format: must be text, json, brief, markdown, payload or sarif\n${USAGE}`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('writes the public view on stdout and in an --output file under --view public, with the public banner', async () => {
    const cwd = mkdtempSync(join(dir, 'public-'))
    const reasoning = JSON.stringify({ keep: true, reasoning: 'REASONING-CANARY' })
    stubChat(JSON.stringify({
      findings: [FINDING],
    }), reasoning, reasoning, reasoning)
    const { io, stdout, stderr } = harness({
      argv: [
        '--view',
        'public',
        '--output',
        'json=r.json',
      ],
      cwd,
      env: { ...MODEL, QUORUM_RESEARCH_MODEL: 'MODEL-CANARY' },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.finding)
    const result = JSON.parse(stdout())
    expect(result.meta.view).toBe('public')
    expect(result.kept[0].votes).toEqual([
      { angle: 'reachability', keep: true, failure: null },
      { angle: 'impact', keep: true, failure: null },
      { angle: 'defenses', keep: true, failure: null },
    ])
    expect(stdout()).not.toContain('reasoning')
    expect(stdout()).not.toContain('CANARY')
    expect(readFileSync(join(cwd, 'r.json'), 'utf8')).toBe(stdout())
    expect(stderr().startsWith('Research (default)...\nPanel will use default\n')).toBe(true)
    expect(stderr()).not.toMatch(/CANARY|localhost/)
  })

  it('writes a failing research reply, a provider\'s error, a gap and a dropped finding in fixed words under --view public, holding none of their text', async () => {
    const run = async (env: Record<string, string>, stdin = DIFF): Promise<{ code: number, stderr: string, stdout: string }> => {
      const { io, stderr, stdout } = harness({
        argv: ['--view', 'public'],
        cwd: dir,
        env,
        stdin,
      })
      return {
        code: await runCli(io),
        stderr: stderr(),
        stdout: stdout(),
      }
    }

    stubChat('SNIPPET-CANARY this reply holds no object')
    const unusable = await run(MODEL)
    expect(unusable.code).toBe(EXIT.incomplete)
    expect(unusable.stderr.trimEnd().split('\n')).toContain('incomplete: research-failed')
    expect(unusable.stderr).not.toMatch(/SNIPPET|CANARY|holds no object/)
    expect(unusable.stdout).not.toMatch(/SNIPPET|CANARY|holds no object|"detail"/)

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => failed('SERVER-CANARY')))
    const refused = await run(MODEL)
    expect(refused.code).toBe(EXIT.runtime)
    expect(refused.stderr.trimEnd().split('\n').at(-1)).toBe('Error: default: its one call failed (http 500): lower concurrency or wait')
    expect(refused.stderr).not.toMatch(/SERVER|CANARY|localhost/)

    const advisory = write('advisory-public.yaml', 'profiles:\n  security: {failOn: none}\n')
    stubChat('SNIPPET-CANARY this reply holds no object')
    const gap = await run({ ...MODEL, QUORUM_CONFIG: advisory })
    expect(gap.code).toBe(EXIT.ok)
    expect(gap.stderr).toContain('incomplete: research-failed\n')
    expect(gap.stderr).not.toMatch(/SNIPPET|CANARY|holds no object/)
    expect(gap.stdout).not.toMatch(/SNIPPET|CANARY|holds no object|"detail"/)

    stubChat(JSON.stringify({
      findings: [
        { ...FINDING, file: 'FILE-CANARY.js' },
      ],
    }))
    const dropped = await run(MODEL)
    expect(dropped.stderr).toContain('invalid finding dropped\n')
    expect(dropped.stderr).not.toMatch(/CANARY|is not in the diff/)
    expect(dropped.stdout).not.toContain('CANARY')
  })

  it('writes a provider down in its fixed words alone under --view public', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => failed('SERVER-CANARY')))
    const { io, stderr, stdout } = harness({
      argv: ['--view', 'public'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(stdout()).toBe('')
    expect(stderr().trimEnd().split('\n').at(-1)).toBe('Error: default: its one call failed (http 500): lower concurrency or wait')
    expect(stderr()).not.toMatch(/SERVER|CANARY|HTTP 500|localhost/)
  })

  it('refuses --view twice, with another value, or with --print-config, before any config', async () => {
    const fetchMock = stubChat()
    const refused = async (argv: string[]): Promise<{ code: number, stdout: string, stderr: string }> => {
      const { io, stdout, stderr } = harness({ argv, env: {}, stdin: DIFF })
      return {
        code: await runCli(io),
        stdout: stdout(),
        stderr: stderr(),
      }
    }
    expect(await refused(['--view', 'full', '--view', 'public'])).toEqual({ code: EXIT.usage, stdout: '', stderr: `Error: --view: takes one view\n${USAGE}` })
    expect(await refused(['--view', 'secret'])).toEqual({ code: EXIT.usage, stdout: '', stderr: `Error: --view: must be full or public\n${USAGE}` })
    expect(await refused(['--view', 'public', '--print-config'])).toEqual({
      code: EXIT.usage,
      stdout: '',
      stderr: `Error: --print-config: prints the config as YAML, so it takes no --format, --output or --view\n${USAGE}`,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('--print-config', () => {
  it('prints the resolved config as YAML, with no key, header, query or body value, and no path of a base URL', async () => {
    const fetchMock = stubChat()
    write('gateway.yaml', [
      'providers:',
      '  local: {preset: ollama, model: qwen3.6:27b, contextTokens: 131072}',
      '  gateway:',
      '    protocol: openai-compatible',
      '    baseUrl: https://gw.example/token-SECRET/v1',
      '    model: gpt-5',
      '    contextTokens: 131072',
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
    const { io, stdout, stderr } = harness({
      argv: ['--print-config', '--config', 'gateway.yaml'],
      cwd: dir,
      env: { GATEWAY_KEY: 'sk-live-SECRET' },
      isTTY: true,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toBe([
      `source: ${join(dir, 'gateway.yaml')}`,
      'providers:',
      '  local:',
      '    preset: ollama',
      '    origin: http://localhost:11434',
      '    model: qwen3.6:27b',
      '    contextTokens: 131072',
      '  gateway:',
      '    protocol: openai-compatible',
      '    origin: https://gw.example',
      '    model: gpt-5',
      '    contextTokens: 131072',
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
      '    failOn: high',
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
      'budgets:',
      '  security:',
      '    research:',
      '      provider: local',
      '      contextTokens: 131072',
      '      replyTokens: 21024',
      '      findings: 50',
      '      findingsWithoutThinking: 50',
      '      rooms:',
      '        one: 107745',
      '        part: 107433',
      '      worstPart:',
      '        tokens: 56407',
      '        holds: 35',
      '    lenses:',
      '      reachability:',
      '        provider: gateway',
      '        contextTokens: 131072',
      '        replyTokens: 9216',
      '        room: 117322',
      '      impact:',
      '        provider: gateway',
      '        contextTokens: 131072',
      '        replyTokens: 9216',
      '        room: 117370',
      '      defenses:',
      '        provider: gateway',
      '        contextTokens: 131072',
      '        replyTokens: 9216',
      '        room: 117374',
      'concurrency: 2',
      'maxFindings: 50',
      'partTokens: 32768',
      'maxReviewTokens: 2000000',
      'reviewTimeoutMs: 1800000',
      'strict: false',
      'exclude: []',
      'send: []',
      'warnings: []',
      '',
    ].join('\n'))
    expect(stdout()).not.toContain('SECRET')
    expect(stderr()).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('redacts a key from the environment and a token in the base URL\'s path, and prints source null with no file', async () => {
    const preset = harness({
      argv: ['--print-config'],
      env: {
        QUORUM_RESEARCH_PRESET: 'openai',
        QUORUM_RESEARCH_MODEL: 'gpt-5',
        QUORUM_RESEARCH_CONTEXT_TOKENS: '131072',
        OPENAI_API_KEY: 'sk-openai-SECRET',
      },
    })
    expect(await runCli(preset.io)).toBe(EXIT.ok)
    expect(preset.stdout()).toMatch(/^source: null\nproviders:\n {2}default:\n {4}preset: openai\n {4}origin: https:\/\/api\.openai\.com\n {4}model: gpt-5\n {4}contextTokens: 131072\n {4}apiKey: "\[redacted\]"\nprofiles:\n/)
    const path = harness({
      argv: ['--print-config'],
      env: {
        QUORUM_RESEARCH_BASE_URL: 'https://h.example/token-SECRET/v1',
        QUORUM_RESEARCH_MODEL: 'm',
        QUORUM_RESEARCH_CONTEXT_TOKENS: '131072',
        QUORUM_RESEARCH_API_KEY: 'sk-SECRET',
      },
    })
    expect(await runCli(path.io)).toBe(EXIT.ok)
    expect(path.stdout()).toContain('    protocol: openai-compatible\n    origin: https://h.example\n    model: m\n    contextTokens: 131072\n    apiKey: "[redacted]"\n')
    expect(`${preset.stdout()}${path.stdout()}`).not.toContain('SECRET')
  })

  it('prints the built-in default as Ollama\'s native protocol on this machine, and a base URL alone as an OpenAI-compatible server', async () => {
    const native = harness({
      argv: ['--print-config'],
      env: DEFAULT,
    })
    expect(await runCli(native.io)).toBe(EXIT.ok)
    expect(native.stdout()).toMatch(/^source: null\nproviders:\n {2}default:\n {4}protocol: ollama\n {4}origin: http:\/\/localhost:11434\n {4}model: m\n {4}contextTokens: 131072\nprofiles:\n/)
    const url = harness({
      argv: ['--print-config'],
      env: MODEL,
    })
    expect(await runCli(url.io)).toBe(EXIT.ok)
    expect(url.stdout()).toMatch(/^source: null\nproviders:\n {2}default:\n {4}protocol: openai-compatible\n {4}origin: http:\/\/localhost:11434\n {4}model: m\n {4}contextTokens: 131072\nprofiles:\n/)
  })

  it('lists the config\'s warnings in the YAML, and none on stderr', async () => {
    const { io, stdout, stderr } = harness({
      argv: ['--print-config'],
      env: { RESEARCH_MODEL: 'm', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toMatch(/\nwarnings:\n {2}- "RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead"\n$/)
    expect(stderr()).toBe('')
  })

  it('prints only the profiles --profile selects, and a custom prompt by its SHA-256', async () => {
    write('abc.yaml', 'profiles:\n  team: {prompts: {research: abc, vote: abc}, lenses: [{id: a, question: q}]}\n')
    const { io, stdout } = harness({
      argv: [
        '--print-config',
        '-c',
        'abc.yaml',
        '-p',
        'team',
      ],
      cwd: dir,
      env: MODEL,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toContain('\nprofiles:\n  team:\n    failOn: high\n    research: default\n    lenses:\n      a: default\n    thresholds:\n      high: 1\n      medium: 1\n      low: null\n    prompts:\n      research: sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n')
    expect(stdout()).not.toContain('security')
  })

  it('prints the levels --fail-on sets with --print-config', async () => {
    const fetchMock = stubChat()
    const { io, stdout } = harness({
      argv: ['--print-config', '--fail-on', 'medium'],
      env: MODEL,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toContain('\nprofiles:\n  security:\n    failOn: medium\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads no diff: a diff argument is a usage error', async () => {
    const { io, stdout, stderr } = harness({
      argv: ['--print-config', 'x.diff'],
      env: MODEL,
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: --print-config takes no diff file\n${USAGE}`)
  })

  it('prints every line inert, a hidden character in the source path included', async () => {
    const name = `q${String.fromCharCode(0x202E)}.yaml`
    write(name, 'providers:\n  a: {preset: ollama, model: m, contextTokens: 131072}\n')
    const { io, stdout } = harness({
      argv: ['--print-config', '--config', name],
      cwd: dir,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toContain(`source: ${join(dir, 'q<U+202E>.yaml')}\n`)
    expect(stdout().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
  })

  it('exits 2 on a configuration error, as a run does', async () => {
    const { io, stdout, stderr } = harness({
      argv: ['--print-config'],
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one\n')
  })

  it('exits 2 for a provider with no context size, as a run does, and sends nothing', async () => {
    const NO_CONTEXT = 'Error: no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens\n'
    const fetchMock = stubChat()
    const env = harness({
      argv: ['--print-config'],
      env: { QUORUM_RESEARCH_MODEL: 'm' },
    })
    expect(await runCli(env.io)).toBe(EXIT.usage)
    expect(env.stdout()).toBe('')
    expect(env.stderr()).toBe(NO_CONTEXT)
    const file = harness({
      argv: [
        '--print-config',
        '--config',
        write('no-context.yaml', 'providers:\n  a: {preset: ollama, model: m}\n'),
      ],
      cwd: dir,
    })
    expect(await runCli(file.io)).toBe(EXIT.usage)
    expect(file.stdout()).toBe('')
    expect(file.stderr()).toBe('Error: providers.a.contextTokens: is required: the model\'s context window in tokens, which quorum checks every request against\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 2 for a config only the run\'s own build refuses, a provider object whose model is not a string', async () => {
    const bad = write('print-model.mjs', 'export default { providers: { mine: { model: 42, complete: async () => ({ text: \'{}\', model: \'m\' }) } } }\n')
    const printing = harness({
      argv: ['--print-config', '--config', bad],
    })
    expect(await runCli(printing.io)).toBe(EXIT.usage)
    expect(printing.stdout()).toBe('')
    expect(printing.stderr()).toBe('Error: providers.mine.model: must be a string\n')
    const running = harness({
      argv: ['--config', bad],
      stdin: DIFF,
    })
    expect(await runCli(running.io)).toBe(EXIT.usage)
    expect(running.stderr()).toBe(printing.stderr())
  })
})

describe('interrupts', () => {
  /** A fetch whose first call waits for `release`, the way a research reply in flight does, and whose later calls answer the votes. */
  function heldReply(): { readonly fetchMock: ReturnType<typeof vi.fn>, readonly release: (content: string) => void } {
    let release: (content: string) => void = () => {}
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => {
      release = content => resolve(chatReply(content))
    })).mockImplementation(async () => chatReply(vote(true)))
    vi.stubGlobal('fetch', fetchMock)
    return {
      fetchMock,
      release: content => release(content),
    }
  }

  it('writes the report of what it read and exits 130 on an interrupt during the review, its calls in flight ending within the grace', async () => {
    const { fetchMock, release } = heldReply()
    const controller = new AbortController()
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF, signal: controller.signal })
    const exit = runCli(io)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    release(JSON.stringify({
      findings: [FINDING],
    }))
    expect(await exit).toBe(EXIT.interrupted)
    // The call in flight ended within the grace and was read, and no vote was asked.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const result = JSON.parse(stdout())
    expect(result.kept).toEqual([])
    expect(result.unreviewed).toHaveLength(1)
    expect(result.unreviewed[0]).toMatchObject({ file: 'a.js' })
    expect(result.unreviewed[0].votes.map((cast: { failure: unknown }) => cast.failure)).toEqual(Array.from({ length: 3 }).fill({ kind: 'interrupted' }))
    expect(result.meta.incomplete).toEqual([
      { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 3 vote(s)' },
    ])
    const lines = stderr().split('\n')
    const stopping = lines.indexOf('stopping: no new calls; the 1 call(s) in flight have 5 s to end; press Ctrl-C again to quit at once, without the result')
    const resume = lines.indexOf('resume: to keep the answered calls for a rerun, pass --state <dir>; this review kept none')
    expect(stopping).toBeGreaterThan(-1)
    expect(resume).toBeGreaterThan(stopping)
    expect(lines).toContain('gaps: 3 vote(s) interrupted: see resume')
    // The run is over: no line says it was interrupted, the report and the summary say what was read.
    expect(lines).not.toContain('interrupted')
  })

  it('writes the resume line naming --state and the calls it kept, never its path', async () => {
    const directory = join(realpathSync(mkdtempSync(join(dir, 'state-'))), 'calls')
    const { fetchMock, release } = heldReply()
    const controller = new AbortController()
    const { io, stderr } = harness({
      env: MODEL,
      stdin: DIFF,
      signal: controller.signal,
      argv: ['--state', directory],
    })
    const exit = runCli(io)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    release(JSON.stringify({
      findings: [FINDING],
    }))
    expect(await exit).toBe(EXIT.interrupted)
    // The one reply that ended within the grace was saved, and a rerun reuses it.
    expect(readdirSync(directory)).toHaveLength(2)
    expect(stderr().split('\n')).toContain('resume: rerun with the same --state: its 1 answered call(s) are kept, and the rerun reuses each one whose request is unchanged')
    expect(stderr()).not.toContain(directory)
    expect(stderr()).not.toContain('pass --state <dir>')
  })

  it('writes interrupted and no result for an interrupt during the setup, before the review starts', async () => {
    const fetchMock = stubChat()
    const fake = fakeGit(({ command }) => {
      if (command[0] === 'rev-parse' && command[1] === '--verify') {
        return { stdout: `${(command[4] === 'a^{commit}'
          ? 'a'
          : 'b').repeat(40)}\n` }
      }
      if (command[0] === 'merge-base') return { stdout: `${'c'.repeat(40)}\n` }
      return command[1] === 'diff'
        ? { hang: true }
        : undefined
    })
    const controller = new AbortController()
    const { io, stdout, stderr } = harness({
      argv: ['--range', 'a...b'],
      env: MODEL,
      git: { executable: '/usr/bin/git', spawn: fake.spawn },
      platform: 'linux',
      signal: controller.signal,
    })
    const exit = runCli(io)
    await vi.waitFor(() => expect(fake.calls.some(call => call.command[1] === 'diff')).toBe(true))
    controller.abort()
    expect(await exit).toBe(EXIT.interrupted)
    expect(stdout()).toBe('')
    expect(stderr().endsWith('interrupted\n')).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps an --output write\'s failure its own error and exit 3 once an interrupted review has resolved', async () => {
    const { fetchMock, release } = heldReply()
    const controller = new AbortController()
    const out = realpathSync(mkdtempSync(join(dir, 'out-')))
    const { io, stderr } = harness({
      env: MODEL,
      stdin: DIFF,
      signal: controller.signal,
      argv: ['--output', `json=${join(out, 'result.json')}`],
    })
    const exit = runCli(io)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // The directory checked before the review is gone when its files are written, after the signal came and the review resolved.
    rmSync(out, { recursive: true })
    controller.abort()
    release(JSON.stringify({
      findings: [FINDING],
    }))
    expect(await exit).toBe(EXIT.runtime)
    expect(stderr()).toContain('Error: --output json: cannot be written (ENOENT)')
    expect(stderr().endsWith('interrupted\n')).toBe(false)
  })

  it('stops the view\'s timers when the review fails, which sends no run:end', async () => {
    let fail: (error: Error) => void = () => {}
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => {
      fail = reject
    })).mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    const clock = fakeClock()
    const { io, stderr } = harness({
      env: MODEL,
      stdin: DIFF,
      clock,
    })
    const exit = runCli(io)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(clock.pending()).toBe(1)
    fail(new TypeError('fetch failed'))
    expect(await exit).toBe(EXIT.runtime)
    expect(stderr()).toContain('\nError: ')
    expect(clock.pending()).toBe(0)
  })

  it('ends a run whose stdin never closes at the first signal: interrupted, exit 130', async () => {
    const fetchMock = stubChat()
    const destroy = vi.fn()
    async function* open(): AsyncGenerator<string> {
      await new Promise<never>(() => {})
    }
    const controller = new AbortController()
    // A config that cannot be read: a run that read it would end on its error, not on `interrupted`.
    const { io, stdout, stderr } = harness({
      env: {
        ...MODEL,
        QUORUM_CONFIG: join(dir, 'missing.yaml'),
      },
      signal: controller.signal,
    })
    const exit = runCli({
      ...io,
      stdin: Object.assign(open(), { isTTY: false, destroy }),
    })
    await Promise.resolve()
    controller.abort()
    expect(await exit).toBe(EXIT.interrupted)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('interrupted\n')
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 130 when its signal aborted before the review started, and calls no model', async () => {
    const fetchMock = stubChat()
    const controller = new AbortController()
    controller.abort()
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF, signal: controller.signal })
    expect(await runCli(io)).toBe(EXIT.interrupted)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('interrupted\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 3, never 130, when the review rejects with an AbortError its own signal did not raise', async () => {
    const answers = write('answers.mjs', 'export default { providers: { mine: { model: \'m\', complete: async () => ({ text: \'{"findings":[]}\', model: \'m\' }) } } }\n')
    const controller = new AbortController()
    const { io, stdout, stderr } = harness({
      cwd: dir,
      env: { QUORUM_CONFIG: answers },
      stdin: DIFF,
      signal: controller.signal,
      // The progress line the review writes throws, and the review ends with that error: an AbortError its own signal never raised.
      onStderr: (text) => {
        if (text.includes('candidate(s)')) throw new DOMException('The operation was aborted', 'AbortError')
      },
    })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(controller.signal.aborted).toBe(false)
    expect(stdout()).toBe('')
    expect(stderr()).toMatch(/\nError: .+\n$/)
    expect(stderr()).not.toContain('interrupted')
  })
})

/** A fetch whose first call waits until the test releases it with `first`, and whose others answer at once, one reply each. */
function heldChat(first: Response, ...rest: string[]): { fetchMock: ReturnType<typeof vi.fn>, release: () => void } {
  let release = (): void => {}
  const queue = [...rest]
  const fetchMock = vi.fn().mockImplementation(() => {
    if (fetchMock.mock.calls.length > 1) return Promise.resolve(chatReply(queue.shift() ?? '{"findings":[]}'))
    return new Promise<Response>((resolve) => {
      release = () => resolve(first)
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    release: () => release(),
  }
}

/** What the live block draws, whatever its width: its rule, its calls, tokens and time lines, and a profile's bar. */
const BLOCK_ROW = /^─+ \d|^-+ \d|^calls {5}|^tokens {4}|^time {6}|^security {2}research /

describe('progress modes', () => {
  const LIVE = { ...MODEL, LANG: 'en_US.UTF-8' }

  it('draws the live view on a terminal, and erases it before the report on stdout', async () => {
    const { release } = heldChat(chatReply('{"findings":[]}'))
    const clock = fakeClock()
    const terminal = fakeTerminal({ columns: 80, rows: 24 })
    const { io, stdout, stderr } = harness({
      env: LIVE,
      stdin: DIFF,
      terminal,
      stdoutIsTTY: true,
      clock,
    })
    const exit = runCli(io)
    await vi.waitFor(() => expect(clock.pending()).toBeGreaterThan(0))
    await vi.waitFor(() => expect(terminal.written()).toContain('Panel will use'))
    // The first frame, 500 ms in: the block is on the screen under the banner, and the cursor is hidden.
    expect(clock.fireNext()).toBe(true)
    expect(clock.now()).toBe(500)
    expect(terminal.screen().filter(row => BLOCK_ROW.test(row)).length).toBeGreaterThanOrEqual(4)
    expect(terminal.cursorVisible()).toBe(false)
    release()
    expect(await exit).toBe(EXIT.ok)

    // Nothing of the block is left: the log lines, then the report, then the summary, and the cursor shows.
    const rows = terminal.screen().filter(row => row !== '')
    expect(rows.filter(row => BLOCK_ROW.test(row))).toEqual([])
    const report = rows.indexOf(stdout().split('\n')[0])
    const last = rows.indexOf('0 kept, 0 discarded, 0 unreviewed by panel')
    expect(rows[0]).toBe('Research (m @ http://localhost:11434)...')
    expect(last).toBeGreaterThan(0)
    expect(report).toBeGreaterThan(last)
    expect(rows.findIndex(row => row.startsWith('time: '))).toBeGreaterThan(report)
    // The report is above the summary only because stdout and stderr are one terminal.
    expect(stderr().split('\n').filter(row => row !== '').at(-1)).toBe('result: the text report above')
    expect(terminal.cursorVisible()).toBe(true)
    expect(terminal.history()).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it('writes the report on stdout only once the erase of the block has been written', async () => {
    const { release } = heldChat(chatReply('{"findings":[]}'))
    const clock = fakeClock()
    const terminal = fakeTerminal({ columns: 80, rows: 24 })
    // The write of the erase, the only one that asks to be told, is not done until the test says so.
    const done: Array<() => void> = []
    const { io, stdout } = harness({
      env: LIVE,
      stdin: DIFF,
      terminal,
      stdoutIsTTY: true,
      clock,
      drain: held => done.push(held),
    })
    const exit = runCli(io)
    await vi.waitFor(() => expect(terminal.written()).toContain('Panel will use'))
    expect(clock.fireNext()).toBe(true)
    expect(terminal.cursorVisible()).toBe(false)
    release()
    await vi.waitFor(() => expect(done).toHaveLength(1))
    // The erase is on the terminal and not yet drained: nothing is on stdout, and the review has not ended.
    expect(terminal.cursorVisible()).toBe(true)
    expect(stdout()).toBe('')
    let ended = false
    void exit.then(() => {
      ended = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(stdout()).toBe('')
    expect(ended).toBe(false)
    done[0]()
    expect(await exit).toBe(EXIT.ok)
    expect(stdout()).not.toBe('')
  })

  it('erases the block and shows the cursor before the Error line of a failed review', async () => {
    const { release } = heldChat(textReply('bad request', 400))
    const clock = fakeClock()
    const terminal = fakeTerminal({ columns: 80, rows: 24 })
    const hooks = new Set<() => void>()
    const { io, stdout } = harness({
      env: LIVE,
      stdin: DIFF,
      terminal,
      stdoutIsTTY: true,
      clock,
      exitHooks: hooks,
    })
    const exit = runCli(io)
    await vi.waitFor(() => expect(terminal.written()).toContain('Panel will use'))
    expect(clock.fireNext()).toBe(true)
    expect(terminal.cursorVisible()).toBe(false)
    // The run adds its restorer to the exit hooks while it lasts.
    expect(hooks.size).toBe(1)
    release()
    expect(await exit).toBe(EXIT.runtime)
    expect(hooks.size).toBe(0)
    expect(stdout()).toBe('')
    const rows = terminal.screen().filter(row => row !== '')
    expect(rows.filter(row => BLOCK_ROW.test(row))).toEqual([])
    expect(rows.findIndex(row => row.startsWith('Error: '))).toBeGreaterThan(1)
    expect(terminal.cursorVisible()).toBe(true)
    const written = terminal.written()
    expect(written.indexOf(CURSOR_SHOW)).toBeGreaterThan(-1)
    expect(written.indexOf(CURSOR_SHOW)).toBeLessThan(written.indexOf('Error: '))
    expect(clock.pending()).toBe(0)
  })

  it('writes the events as JSON lines with --progress json, and its own lines as cli:line', async () => {
    stubChat('{"findings":[]}')
    const { io, stderr } = harness({
      argv: ['--progress', 'json'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    const lines = stderr().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as { type: string, level?: string, text?: string })
    expect(lines[0]).toMatchObject({ type: 'cli:line', level: 'banner', text: 'Research (m @ http://localhost:11434)...' })
    const types = lines.map(line => line.type)
    for (const type of [
      'run:start',
      'call:start',
      'part',
      'run:end',
    ]) expect(types, type).toContain(type)
    // The summary is the text modes': a tool has the events.
    expect(lines.filter(line => line.type === 'cli:line').map(line => line.text).some(text => /^(?:time|tokens|calls|result): /.test(text ?? ''))).toBe(false)
    expect(types.at(-1)).toBe('run:end')
  })

  it('writes only the warning and Error lines with --progress none', async () => {
    const warned = harness({
      argv: ['--progress', 'none'],
      env: { RESEARCH_MODEL: 'm', QUORUM_RESEARCH_CONTEXT_TOKENS: '131072' },
      stdin: '  \n',
    })
    expect(await runCli(warned.io)).toBe(EXIT.ok)
    expect(warned.stderr()).toBe('warning: RESEARCH_MODEL is deprecated: set QUORUM_RESEARCH_MODEL instead\n')

    stubChat('{"findings":[]}')
    const clean = harness({
      argv: ['--progress', 'none'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(clean.io)).toBe(EXIT.ok)
    expect(clean.stderr()).toBe('')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textReply('bad request', 400)))
    const failed = harness({
      argv: ['--progress', 'none'],
      env: MODEL,
      stdin: DIFF,
    })
    expect(await runCli(failed.io)).toBe(EXIT.runtime)
    expect(failed.stderr()).toMatch(/^Error: /)
    expect(failed.stderr()).not.toMatch(/Research|Panel|part \d|kept|calls:/)
  })

  it('refuses an unknown mode, live off a terminal and json with --view public, before any config, with the usage', async () => {
    const fetchMock = stubChat()
    const refused: Array<[string[], Record<string, string>, string]> = [
      [
        ['--progress', 'fancy'],
        {},
        '--progress: must be auto, live, plain, json or none',
      ],
      [
        [],
        { QUORUM_PROGRESS: 'fancy' },
        'QUORUM_PROGRESS: must be auto, live, plain, json or none',
      ],
      [
        ['--progress', 'live'],
        {},
        '--progress: live needs stderr to be a terminal: use plain',
      ],
      [
        [],
        { QUORUM_PROGRESS: 'live' },
        'QUORUM_PROGRESS: live needs stderr to be a terminal: use plain',
      ],
      [
        [
          '--progress',
          'json',
          '--view',
          'public',
        ],
        {},
        '--progress: json writes the library\'s events, which hold usage and server text: it cannot be given with --view public',
      ],
      [
        [
          '--progress',
          'plain',
          '--progress',
          'json',
        ],
        {},
        '--progress: takes one mode',
      ],
    ]
    for (const [argv, env, message] of refused) {
      // No model is configured, so a config read first would refuse with another message.
      const { io, stdout, stderr } = harness({ argv, env, stdin: DIFF })
      expect(await runCli(io), message).toBe(EXIT.usage)
      expect(stdout()).toBe('')
      expect(stderr()).toBe(`Error: ${message}\n${USAGE}`)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads QUORUM_PROGRESS, which the flag wins over, and warns of no unread variable', async () => {
    const viaVariable = harness({
      env: { ...MODEL, QUORUM_PROGRESS: 'json' },
      stdin: '  \n',
    })
    expect(await runCli(viaVariable.io)).toBe(EXIT.ok)
    const lines = viaVariable.stderr().split('\n').filter(line => line !== '')
    expect(lines.map(line => JSON.parse(line) as { text?: string }).some(line => line.text?.includes('is not a variable quorum reads'))).toBe(false)
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'cli:line', level: 'banner' })

    const flagged = harness({
      argv: ['--progress', 'plain'],
      env: { ...MODEL, QUORUM_PROGRESS: 'json' },
      stdin: '  \n',
    })
    expect(await runCli(flagged.io)).toBe(EXIT.ok)
    expect(flagged.stderr()).toBe('Research (m @ http://localhost:11434)...\nPanel will use m @ http://localhost:11434\nempty diff: nothing to review\n0 kept, 0 discarded, 0 unreviewed by panel\n')

    // A blank variable is unset, and one that is not a mode is refused with the usage.
    const blank = harness({
      env: { ...MODEL, QUORUM_PROGRESS: ' ' },
      stdin: '  \n',
    })
    expect(await runCli(blank.io)).toBe(EXIT.ok)
    expect(blank.stderr()).toMatch(/^Research \(m/)
  })

  it('colours the live view unless NO_COLOR or --color never, and never colours plain lines with --color always', async () => {
    const colours = async (argv: string[], env: Record<string, string> = {}): Promise<string> => {
      stubChat('{"findings":[]}')
      const terminal = fakeTerminal({ columns: 80, rows: 24 })
      const { io } = harness({
        argv,
        env: {
          ...LIVE,
          ...env,
        },
        stdin: DIFF,
        terminal,
      })
      expect(await runCli(io)).toBe(EXIT.ok)
      return terminal.written()
    }
    // The part line's glyph is green, and the colour is the live view's own, set with the glyph.
    expect(await colours([])).toContain(`${CSI}32m✓${CSI}0m part 1 of 1`)
    expect(await colours(['--color', 'always'], { NO_COLOR: '1' })).toContain(`${CSI}32m✓${CSI}0m`)
    for (const [argv, env] of [
      [
        ['--color', 'never'],
        {},
      ],
      [
        [],
        { NO_COLOR: '1' },
      ],
    ] as const) {
      const written = await colours([...argv], { ...env })
      expect(written).toContain('✓ part 1 of 1')
      expect(written).not.toMatch(/\[\d+m/)
    }

    // Plain lines are never coloured: stderr is no terminal, whatever --color says.
    stubChat('{"findings":[]}')
    const plain = harness({
      argv: ['--color', 'always'],
      env: LIVE,
      stdin: DIFF,
    })
    expect(await runCli(plain.io)).toBe(EXIT.ok)
    expect(plain.stderr()).toContain('part 1 of 1')
    expect(plain.stderr()).not.toContain(String.fromCharCode(0x1B))
  })
})

describe('interruptSignal', () => {
  it('aborts on the first SIGINT or SIGTERM, and exits 130 on the next', () => {
    for (const [first, second] of [
      ['SIGINT', 'SIGTERM'],
      ['SIGTERM', 'SIGINT'],
      ['SIGINT', 'SIGINT'],
    ]) {
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
  it('writes the server text an error quotes inert, on one line, as the line after the provider-down line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => failed('\u009B2J\u202Eboom\n::error::x')))
    const { io, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(stderr()).toContain('Error: default: its one call failed (http 500): lower concurrency or wait\ndefault: HTTP 500: "<U+009B>2J<U+202E>boom\\n::error::x"\n')
    expect(stderr().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
  })

  it('writes the banner inert, a provider object\'s model with a hidden character included', async () => {
    const object = write('object.mjs', `export default { providers: { mine: { model: 'm${String.fromCharCode(0x202E)}', complete: async () => ({ text: '{"findings":[]}', model: 'm' }) } } }\n`)
    const { io, stderr } = harness({
      cwd: dir,
      env: { QUORUM_CONFIG: object },
      stdin: '  \n',
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toContain('Research (m<U+202E> @ the provider object mine)...\n')
    expect(stderr().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
  })

  it('keeps a configuration error to one issue per line, and a diff file\'s failure to a text that holds no part of its path', async () => {
    const config = harness({
      env: { ...MODEL, QUORUM_RESEARCH_BASE_URL: 'localhost:11434/v1', QUORUM_RESEARCH_API_KEY: 'sk bad' },
      stdin: DIFF,
    })
    expect(await runCli(config.io)).toBe(EXIT.usage)
    expect(config.stderr()).toBe('Error: QUORUM_RESEARCH_BASE_URL: must be an http:// or https:// URL with a host\nQUORUM_RESEARCH_API_KEY: must only contain visible ASCII characters, which an HTTP header can carry\n')
    const missing = harness({
      argv: ['no\nsuch.diff'],
      env: MODEL,
    })
    expect(await runCli(missing.io)).toBe(EXIT.usage)
    expect(missing.stderr()).toBe(`Error: the diff file does not exist\n${USAGE}`)
  })

  it('writes the JSON result inert: it parses back to the text the servers sent', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => chatReply(JSON.stringify({
        findings: [FINDING],
      })))
      .mockImplementation(async () => failed('\u009B2J\u202E')))
    const { io, stdout } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.incomplete)
    expect(stdout().replaceAll('\n', '')).not.toMatch(ANY_HIDDEN)
    expect(JSON.parse(stdout()).unreviewed[0].votes[0].error).toBe('default: HTTP 500: "\u009B2J\u202E"')
  })

  it('writes no legacy workflow command, on stderr or in the JSON', async () => {
    stubChat(JSON.stringify({
      findings: [
        { ...FINDING, file: '##[error]x.js' },
        { ...FINDING, summary: '##[add-mask]e' },
      ],
    }), vote(true), vote(true), vote(true))
    const { io, stdout, stderr } = harness({ env: MODEL, stdin: DIFF })
    expect(await runCli(io)).toBe(EXIT.finding)
    expect(stderr()).toContain('invalid finding dropped: ##<U+005B>error]x.js:1 is not in the diff\n')
    expect(stdout()).toContain('"summary": "##\\u005badd-mask]e"')
    expect(`${stderr()}${stdout()}`).not.toContain('##[')
    expect(JSON.parse(stdout()).kept[0].summary).toBe('##[add-mask]e')
  })

  it('prints a flag on stderr and keeps it out of the exit code', async () => {
    stubChat(JSON.stringify({ findings: [] }))
    const { io, stdout, stderr } = harness({
      env: MODEL,
      stdin: DIFF.replace('+exec(cmd)', '+exec(cmd)\u202E'),
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toContain('flag: hidden-characters at "a.js":1 (U+202E on 1 added line(s))\n')
    expect(JSON.parse(stdout()).meta.flags).toEqual([
      {
        code: 'hidden-characters',
        file: 'a.js',
        line: 1,
        detail: 'U+202E on 1 added line(s)',
      },
    ])
  })
})

describe('a claude-code provider', () => {
  let claude = ''
  beforeAll(() => {
    claude = writeFakeClaude(dir)
  })
  const ccEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    QUORUM_RESEARCH_PROTOCOL: 'claude-code',
    QUORUM_RESEARCH_MODEL: 'haiku',
    QUORUM_RESEARCH_CONTEXT_TOKENS: '1000000',
    QUORUM_CLAUDE_CODE_COMMAND: claude,
    ...extra,
  })

  it('reviews a diff through claude from the environment alone, and names the provider claude-code', async () => {
    const { io, stdout, stderr } = harness({
      env: {
        ...ccEnv(),
        ...fakeClaudeEnv(dir, 'cli', fixtures.noFindings),
      },
      stdin: DIFF,
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(JSON.parse(stdout()).kept).toEqual([])
    expect(stderr()).toContain('Research (haiku @ claude-code)...\nPanel will use haiku @ claude-code\n')
    expect(stderr()).not.toContain('warning:')
    expect(stderr()).not.toContain(dir)
    expect(readFakeRecord(dir, 'cli').stdin).toContain(DIFF)
  })

  it('prints the claude it found, and exits 2 when the variable names none', async () => {
    const printed = harness({
      argv: ['--print-config'],
      env: ccEnv(),
    })
    expect(await runCli(printed.io)).toBe(EXIT.ok)
    expect(printed.stdout()).toContain(`  default:\n    protocol: claude-code\n    command: ${claude}\n    model: haiku\n    contextTokens: 1000000\n    auth: inherit\nprofiles:\n`)
    const missing = harness({
      argv: ['--print-config'],
      env: ccEnv({
        QUORUM_CLAUDE_CODE_COMMAND: join(dir, 'no-claude'),
      }),
    })
    expect(await runCli(missing.io)).toBe(EXIT.usage)
    expect(missing.stderr()).toBe('Error: QUORUM_CLAUDE_CODE_COMMAND: names no executable file\n')
  })

  it('warns that claude bills the key in the environment, without printing it or the command', async () => {
    const { io, stdout } = harness({
      argv: ['--print-config'],
      env: ccEnv({ ANTHROPIC_API_KEY: 'sk-SECRET' }),
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stdout()).toContain('warnings:\n  - "providers.default: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key"\n')
    expect(stdout()).not.toContain('SECRET')
  })

  it('exits 2 naming the provider when claude is on no PATH entry, and prints no PATH entry', async () => {
    const { io, stderr } = harness({
      argv: ['--print-config'],
      env: {
        ...ccEnv({ QUORUM_CLAUDE_CODE_COMMAND: '' }),
        PATH: join(dir, 'empty-bin'),
      },
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stderr()).toBe('Error: providers.default: claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND\n')
  })
})

describe('the sources', () => {
  const BASE = 'a'.repeat(40)
  const HEAD = 'b'.repeat(40)
  const MERGE = 'c'.repeat(40)

  /** A fake git that knows `secret-base`, `secret-head` and their merge base, and prints `DIFF` for them; `replies` replaces any of its answers. */
  function git(replies: { readonly base?: GitReply, readonly diff?: GitReply } = {}): { seam: { executable: string, spawn: ReturnType<typeof fakeGit>['spawn'] }, calls: GitCall[] } {
    const fake = fakeGit(({ command }) => {
      if (command[0] === 'rev-parse' && command[1] === '--verify') {
        return command[4] === 'secret-base^{commit}'
          ? replies.base ?? { stdout: `${BASE}\n` }
          : { stdout: `${HEAD}\n` }
      }
      if (command[0] === 'merge-base') return { stdout: `${MERGE}\n` }
      if (command[1] === 'diff') return replies.diff ?? { stdout: DIFF }
      return undefined
    })
    return {
      seam: { executable: '/usr/bin/git', spawn: fake.spawn },
      calls: fake.calls,
    }
  }

  it('reviews --range base...head with the git it is given, and writes the range in meta.source', async () => {
    const fetchMock = stubChat(JSON.stringify({ findings: [] }))
    const fake = git()
    const { io, stdout, stderr } = harness({
      argv: ['--range', 'secret-base...secret-head'],
      env: MODEL,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect((sent(fetchMock).body.messages as Array<{ content: string }>)[1].content).toContain(`>\n${DIFF}\n</untrusted-diff-`)
    expect(JSON.parse(stdout()).meta.source).toEqual({
      kind: 'range',
      base: BASE,
      mergeBase: MERGE,
      head: HEAD,
      objectFormat: 'sha1',
    })
    expect(stderr()).not.toMatch(/secret-base|secret-head/)
    expect(fake.calls.at(-1)?.command.slice(0, 2)).toEqual([`--attr-source=${BASE}`, 'diff'])
  })

  it.each([
    [
      ['--range', 'a...b', 'x.diff'],
      '--range: cannot be given with a diff file: give one source',
    ],
    [
      ['--range', 'a...b', '--range', 'c...d'],
      '--range: takes one range',
    ],
    [
      ['--print-config', '--range', 'a...b'],
      '--print-config: reads no diff, so it takes no --range, --local, --staged or --path',
    ],
    [
      ['--local', '--staged'],
      '--staged: cannot be given with --local: give one source',
    ],
    [
      ['--trust-repo-config'],
      '--trust-repo-config: needs --local or --staged',
    ],
    [
      ['--at', 'HEAD'],
      '--at: needs --path',
    ],
    [
      ['--no-default-skips'],
      '--no-default-skips: needs --path',
    ],
    [
      ['--large'],
      '--large: needs --path',
    ],
    [
      ['--path', 'a', '--range', 'b...c'],
      '--path: cannot be given with --range: give one source',
    ],
    [
      ['--path', '.', '--at=-x'],
      '--at: a revision may not start with -',
    ],
    [
      ['x.diff', 'y.diff'],
      'takes one diff file, and 1 more argument(s) were given',
    ],
  ])('refuses %j before any git runs', async (argv, message) => {
    const fetchMock = stubChat()
    const fake = git()
    const { io, stdout, stderr } = harness({
      argv,
      env: MODEL,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: ${message}\n${USAGE}`)
    expect(fake.calls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a range written wrongly with the usage, before the config and before any git', async () => {
    const fetchMock = stubChat()
    const fake = git()
    const { io, stdout, stderr } = harness({
      argv: ['--range', 'main'],
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: --range: must be written <base>...<head>: a single revision names no range\n${USAGE}`)
    expect(stderr()).not.toContain('no model configured')
    expect(fake.calls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['', '--path: must name a path'],
    ['/etc', '--path: must be relative to the working directory'],
  ])('refuses --path %j with the usage before the config and before any git', async (value, message) => {
    const fetchMock = stubChat()
    const fake = git()
    // No model is configured, so the config would fail first if it were read.
    const { io, stdout, stderr } = harness({
      argv: ['--path', 'src', '--path', value],
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: ${message}\n${USAGE}`)
    expect(stderr()).not.toContain('no model configured')
    expect(fake.calls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      ['--send='],
      '--send: must name a file',
    ],
  ])('refuses %j before any config', async (argv, message) => {
    const fetchMock = stubChat()
    const fake = git()
    // No model is configured, so the config would fail first if it were read.
    const { io, stdout, stderr } = harness({
      argv,
      stdin: DIFF,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: ${message}\n${USAGE}`)
    expect(fake.calls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an --at that starts with - with the usage before the config and before any git', async () => {
    const fetchMock = stubChat()
    const fake = git()
    // No model is configured, so the config would fail first if it were read.
    const { io, stdout, stderr } = harness({
      argv: ['--path', '.', '--at=-x'],
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: --at: a revision may not start with -\n${USAGE}`)
    expect(stderr()).not.toContain('no model configured')
    expect(stderr()).not.toContain('-x')
    expect(fake.calls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 2 for a range git refuses, after the config and before the banner', async () => {
    const fetchMock = stubChat()
    const fake = git({
      base: { code: 1 },
    })
    const refused = harness({
      argv: ['--range', 'secret-base...secret-head'],
      env: MODEL,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(refused.io)).toBe(EXIT.usage)
    expect(refused.stdout()).toBe('')
    expect(refused.stderr()).toBe('Error: --range: its base names no commit of this repository: fetch it first, as actions/checkout does with fetch-depth: 0\n')

    // The config is read first: a run with no model never reaches git.
    const calls = fake.calls.length
    const unconfigured = harness({
      argv: ['--range', 'secret-base...secret-head'],
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(unconfigured.io)).toBe(EXIT.usage)
    expect(unconfigured.stderr()).toBe('Error: no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one\n')
    expect(fake.calls).toHaveLength(calls)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exits 3 for a GitError, with its message on one inert line', async () => {
    const fetchMock = stubChat()
    const hidden = String.fromCharCode(0x202E)
    const fake = git({
      diff: { code: 128, stderr: `fatal: bad\nnext${hidden}line\n` },
    })
    const { io, stdout, stderr } = harness({
      argv: ['--range', 'secret-base...secret-head'],
      env: MODEL,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.runtime)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Error: git diff failed (exit 128): "fatal: bad\\nnext<U+202E>line"\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /** A fake git for the local changes: HEAD is `HEAD`, no untracked file, `DIFF` for the changes, and `config` for what `config` prints of the filters. */
  function localGit(config: GitReply = { code: 1 }): { seam: { executable: string, spawn: ReturnType<typeof fakeGit>['spawn'] }, calls: GitCall[] } {
    const fake = fakeGit(({ command }) => {
      if (command[0] === 'config') return config
      if (command[0] === 'rev-parse' && command[1] === '--verify') return { stdout: `${HEAD}\n` }
      if (command[1] === 'diff') return { stdout: DIFF }
      if (command[0] === 'ls-files') return { stdout: '' }
      return undefined
    })
    return {
      seam: { executable: '/usr/bin/git', spawn: fake.spawn },
      calls: fake.calls,
    }
  }

  it('reviews --local and --staged with the git it is given, writing meta.source', async () => {
    for (const kind of ['local', 'staged'] as const) {
      const fetchMock = stubChat(JSON.stringify({ findings: [] }))
      const fake = localGit()
      const { io, stdout, stderr } = harness({
        argv: [`--${kind}`],
        env: MODEL,
        git: fake.seam,
        platform: 'linux',
      })
      expect(await runCli(io)).toBe(EXIT.ok)
      expect((sent(fetchMock).body.messages as Array<{ content: string }>)[1].content).toContain(`>\n${DIFF}\n</untrusted-diff-`)
      expect(JSON.parse(stdout()).meta.source).toEqual({ kind, head: HEAD, objectFormat: 'sha1' })
      expect(stderr()).not.toContain(HEAD)
      const diff = fake.calls.find(call => call.command[1] === 'diff')?.command ?? []
      expect(diff.includes('--cached')).toBe(kind === 'staged')
      expect(fake.calls.some(call => call.command[0] === 'ls-files')).toBe(kind === 'local')
      vi.unstubAllGlobals()
    }
  })

  it('exits 2 for a repository whose own config names a filter, naming --trust-repo-config', async () => {
    const fetchMock = stubChat(JSON.stringify({ findings: [] }))
    const fake = localGit({ stdout: 'local\0filter.evil.clean\n/bin/evil\0' })
    const refused = harness({
      argv: ['--local'],
      env: MODEL,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(refused.io)).toBe(EXIT.usage)
    expect(refused.stdout()).toBe('')
    expect(refused.stderr()).toBe('Error: --local: the repository\'s own config names a filter program, which a working-tree diff runs: pass --trust-repo-config if the repository is yours, or review a range\n')
    expect(fake.calls.some(call => call.command[1] === 'diff')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    const trusted = harness({
      argv: ['--staged', '--trust-repo-config'],
      env: MODEL,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(trusted.io)).toBe(EXIT.ok)
    expect(JSON.parse(trusted.stdout()).meta.source).toEqual({ kind: 'staged', head: HEAD, objectFormat: 'sha1' })
  })

  /** The tree of a path review of most tests: a `.env` and code. */
  const PATH_TREE: Readonly<Record<string, string>> = {
    'src/.env': 'KEY=sk-live-1234\n',
    'src/a.js': 'export const a = 1\n',
  }

  /** A fake git for a path review: HEAD is `HEAD`, and its tree holds the files given, `src/.env` and `src/a.js` by default, with ids `1` repeated, `2` repeated, and so on. */
  function pathGit(files: Readonly<Record<string, string>> = PATH_TREE): { seam: { executable: string, spawn: ReturnType<typeof fakeGit>['spawn'] }, calls: GitCall[] } {
    const entries = Object.entries(files).map(([path, content], index) => ({
      path,
      content,
      id: String(index + 1).repeat(40),
    }))
    const fake = fakeGit(({ command, stdin }) => {
      if (command[0] === 'rev-parse' && command[1] === '--verify') return { stdout: `${HEAD}\n` }
      if (command[0] === 'ls-tree') {
        return {
          stdout: entries.map(({ path, content, id }) => `100644 blob ${id} ${String(content.length).padStart(7)}\t${path}\0`).join(''),
        }
      }
      if (command[0] === 'cat-file') {
        return {
          stdout: stdin.split('\n').filter(id => id !== '').map((id) => {
            const content = entries.find(entry => entry.id === id)?.content ?? ''
            return `${id} blob ${content.length}\n${content}\n`
          }).join(''),
        }
      }
      return undefined
    })
    return {
      seam: { executable: '/usr/bin/git', spawn: fake.spawn },
      calls: fake.calls,
    }
  }

  it('reviews --path with the git it is given, listing the skips and flagging the secret on stderr', async () => {
    const fetchMock = stubChat(JSON.stringify({ findings: [] }))
    const fake = pathGit()
    const { io, stdout, stderr } = harness({
      argv: ['--path', 'src', '--at', 'secret-rev'],
      env: MODEL,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.ok)

    const result = JSON.parse(stdout())
    expect(result.meta.source).toEqual({
      kind: 'paths',
      commit: HEAD,
      paths: ['src'],
      skips: true,
      objectFormat: 'sha1',
    })
    expect(result.meta.leftOut).toEqual([
      { file: 'src/.env', reason: 'skipped', rule: 'secret' },
    ])
    expect(result.meta.flags).toEqual([
      {
        code: 'secret-file',
        file: 'src/.env',
        detail: 'named as a secret, so a path review sent none of it: check that it belongs in the repository',
      },
    ])
    // A skip is no gap, and the secret reached no model.
    expect(result.meta.incomplete).toEqual([])
    const request = (sent(fetchMock).body.messages as Array<{ content: string }>)[1].content
    expect(request).toContain('+export const a = 1')
    expect(request).not.toContain('sk-live')
    expect(stderr()).toContain('left out: 1 file(s): "src/.env" (skipped: secret)\n')
    expect(stderr()).toContain('flag: secret-file at "src/.env" (named as a secret, so a path review sent none of it: check that it belongs in the repository)\n')
    expect(stderr()).not.toContain('secret-rev')
    expect(fake.calls.some(call => call.command[0] === 'cat-file' && call.stdin.includes('1'.repeat(40)))).toBe(false)
    // The commit --at names is the one git is asked to resolve, after --end-of-options.
    expect(fake.calls.find(call => call.command[0] === 'rev-parse' && call.command[1] === '--verify')?.command).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'secret-rev^{commit}',
    ])
  })

  it('lists a path review\'s content skip and flags it as a credential', async () => {
    const credential = fakeCredential('aws-key')
    const fetchMock = stubChat(JSON.stringify({ findings: [] }))
    const { io, stdout, stderr } = harness({
      argv: ['--path', 'src'],
      env: MODEL,
      git: pathGit({
        'src/a.js': 'export const a = 1\n',
        'src/config.ts': `export const id = '${credential}'\n`,
      }).seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.ok)

    const result = JSON.parse(stdout())
    expect(result.meta.leftOut).toEqual([
      { file: 'src/config.ts', reason: 'skipped', rule: 'secret' },
    ])
    expect(result.meta.flags).toEqual([
      {
        code: 'secret-file',
        file: 'src/config.ts',
        detail: 'holds what reads as a credential, so a path review sent none of it: remove it from the repository, and rotate it if it is real',
      },
    ])
    // A skip is no gap, and the key reached no model and no output.
    expect(result.meta.incomplete).toEqual([])
    expect((sent(fetchMock).body.messages as Array<{ content: string }>)[1].content).toContain('+export const a = 1')
    expect(JSON.stringify(sent(fetchMock).body)).not.toContain(credential)
    expect(stderr()).toContain('left out: 1 file(s): "src/config.ts" (skipped: secret)\n')
    expect(stderr()).toContain('flag: secret-file at "src/config.ts" (holds what reads as a credential, so a path review sent none of it: remove it from the repository, and rotate it if it is real)\n')
    expect(stderr() + stdout()).not.toContain(credential)
  })

  it('skips a .env under --path --no-default-skips, sending none of it, and exits 0', async () => {
    const fetchMock = stubChat(JSON.stringify({ findings: [] }))
    const fake = pathGit()
    const { io, stdout, stderr } = harness({
      argv: ['--path', 'src', '--no-default-skips'],
      env: MODEL,
      git: fake.seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.ok)

    const result = JSON.parse(stdout())
    expect(result.meta.source).toEqual({
      kind: 'paths',
      commit: HEAD,
      paths: ['src'],
      skips: false,
      objectFormat: 'sha1',
    })
    // Only the default skips are off: the secret stays skipped, a skip is no gap, and the core holds back nothing.
    expect(result.meta.leftOut).toEqual([
      { file: 'src/.env', reason: 'skipped', rule: 'secret' },
    ])
    expect(result.meta.flags).toEqual([
      {
        code: 'secret-file',
        file: 'src/.env',
        detail: 'named as a secret, so a path review sent none of it: check that it belongs in the repository',
      },
    ])
    expect(result.meta.incomplete).toEqual([])
    const request = (sent(fetchMock).body.messages as Array<{ content: string }>)[1].content
    expect(request).toContain('+export const a = 1')
    expect(JSON.stringify(sent(fetchMock).body)).not.toContain('sk-live-1234')
    expect(stderr()).toContain('left out: 1 file(s): "src/.env" (skipped: secret)\n')
    expect(fake.calls.some(call => call.command[0] === 'cat-file' && call.stdin.includes('1'.repeat(40)))).toBe(false)
    expect(fake.calls.find(call => call.command[0] === 'rev-parse' && call.command[1] === '--verify')?.command[4]).toBe('HEAD^{commit}')
  })

  it('merges the config\'s send with --send, for a path review, its estimate and its review', async () => {
    const credential = fakeCredential('aws-key')
    const tree = {
      'src/.env': 'MODE=production\n',
      'src/a.js': 'export const a = 1\n',
      'src/config.ts': `export const id = '${credential}'\n`,
    }
    const listing = write('send.yaml', `${TEAM_YAML}send:\n  - src/.env\n`)
    const plain = write('plain.yaml', TEAM_YAML)
    /** A path review under `config` with `send` on the command line: what it sent, its left out files and the research part of its estimate. */
    async function review(config: string, send: readonly string[]) {
      const fetchMock = stubChat(JSON.stringify({ findings: [] }))
      const { io, stdout, stderr } = harness({
        argv: [
          '--config',
          config,
          '--path',
          'src',
          ...send.flatMap(path => ['--send', path]),
        ],
        git: pathGit(tree).seam,
        platform: 'linux',
      })
      expect(await runCli(io)).toBe(EXIT.ok)
      vi.unstubAllGlobals()
      return {
        request: (sent(fetchMock).body.messages as Array<{ content: string }>)[1].content,
        leftOut: JSON.parse(stdout()).meta.leftOut as unknown[],
        expected: estimateOf(stderr()).expected,
      }
    }

    const merged = await review(listing, ['src/config.ts'])
    expect(merged.request).toContain('+MODE=production')
    expect(merged.request).toContain(`+export const id = '${credential}'`)
    expect(merged.leftOut).toEqual([])

    // Every file the diff holds is counted: as much as when the command line names both, and more than when nothing is sent.
    const flags = await review(plain, ['src/.env', 'src/config.ts'])
    expect(flags.leftOut).toEqual([])
    expect(merged.expected).toBe(flags.expected)
    const none = await review(plain, [])
    expect(none.request).not.toContain('MODE=production')
    expect(none.leftOut).toEqual([
      { file: 'src/.env', reason: 'skipped', rule: 'secret' },
      { file: 'src/config.ts', reason: 'skipped', rule: 'secret' },
    ])
    expect(merged.expected).toBeGreaterThan(none.expected)
  })

  /** A fake git for a path review of one large file, `src/big.js`, which a research in parts spreads over several parts. */
  function bigGit(lines = 3000): { seam: { executable: string, spawn: ReturnType<typeof fakeGit>['spawn'] }, calls: GitCall[] } {
    const code = `${Array.from({ length: lines }, (_, index) => `export const value${index} = compute(${index}) // padding`).join('\n')}\n`
    const id = '3'.repeat(40)
    const fake = fakeGit(({ command }) => {
      if (command[0] === 'rev-parse' && command[1] === '--verify') return { stdout: `${HEAD}\n` }
      if (command[0] === 'ls-tree') return { stdout: `100644 blob ${id} ${String(Buffer.byteLength(code)).padStart(7)}\tsrc/big.js\0` }
      if (command[0] === 'cat-file') return { stdout: `${id} blob ${Buffer.byteLength(code)}\n${code}\n` }
      return undefined
    })
    return {
      seam: { executable: '/usr/bin/git', spawn: fake.spawn },
      calls: fake.calls,
    }
  }

  /** The lines of the estimate a run printed, and the numbers of the first and the total's. */
  function estimateOf(stderr: string): { lines: string[], parts: number, votes: number, expected: number, inFlight: number } {
    const lines = stderr.split('\n').filter(line => line.startsWith('estimate: '))
    const total = /^estimate: research about (\d+) tokens expected, at most \d+ with every vote and every part recovered, (\d+) of them reserved at once; the review's token cap is .+$/.exec(lines[1] ?? '')
    const parts = /^estimate: (\d+) research part\(s\), about \d+ tokens expected for them; then up to (\d+) vote\(s\), at most \d+ tokens in all$/.exec(lines[0] ?? '')
    return {
      lines,
      parts: Number(parts?.[1]),
      votes: Number(parts?.[2]),
      expected: Number(total?.[1]),
      inFlight: Number(total?.[2]),
    }
  }

  it('prints the estimate of a path review on stderr before any call', async () => {
    const written: string[] = []
    let beforeTheCall = ''
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      beforeTheCall ||= written.join('')
      return chatReply(JSON.stringify({ findings: [] }))
    }))
    const { io, stderr } = harness({
      argv: ['--path', 'src'],
      env: MODEL,
      git: pathGit().seam,
      platform: 'linux',
      onStderr: text => written.push(text),
    })
    expect(await runCli(io)).toBe(EXIT.ok)

    const estimate = estimateOf(beforeTheCall)
    expect(estimate.lines).toHaveLength(2)
    // The cap follows the estimate's worst case, which recovery's bound puts over the default even for one part, and the deadline is the longest allowed: the config sets neither.
    const worst = /at most (\d+) with every vote/.exec(estimate.lines[1])?.[1]
    expect(estimate.lines[1]).toMatch(new RegExp(`; the review's token cap is ${worst}, this estimate's worst case, its deadline 86400000 ms, the longest allowed, and its finding cap 50, the default, which holds one per research part: the config sets none of them$`))
    expect(estimate.parts).toBe(1)
    expect(estimate.votes).toBe(150)
    expect(estimate.expected).toBeGreaterThan(0)
    expect(estimate.inFlight).toBeGreaterThan(0)
    // The banner, then the estimate, then whatever the review says: all before the first request.
    const lines = beforeTheCall.split('\n')
    expect(lines.slice(0, 2)).toEqual(['Research (m @ http://localhost:11434)...', 'Panel will use m @ http://localhost:11434'])
    expect(lines.slice(2, 4)).toEqual(estimate.lines)
    // Printed once, and no later line repeats it.
    expect(estimateOf(stderr()).lines).toEqual(estimate.lines)
  })

  it('runs a path review that 0.8.0 would have held, its expected spend and calls in flight past 2000000, to its end, under its worst case as cap and a deadline of 24 hours, after the large review\'s warning', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => chatReply(JSON.stringify({ findings: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { io, stdout, stderr } = harness({
      argv: ['--path', 'src'],
      env: MODEL,
      git: bigGit(60_000).seam,
      platform: 'linux',
    })
    expect([EXIT.ok, EXIT.finding]).toContain(await runCli(io))

    const { lines, parts, votes } = estimateOf(stderr())
    const warning = /^warning: a large review: (\d+) research part\(s\) and up to (\d+) vote\(s\), about (\d+) tokens expected and at most (\d+): Ctrl-C stops it and keeps what it read$/m.exec(stderr())
    expect(warning).not.toBeNull()
    expect(Number(warning?.[1])).toBe(parts)
    expect(parts).toBe(109)
    // The panel reads one finding per research part: its three lenses vote 109 findings, and the estimate and its warning count them.
    expect(votes).toBe(327)
    expect(Number(warning?.[2])).toBe(327)
    const worst = Number(warning?.[4])
    expect(worst).toBeGreaterThan(2_000_000)
    // The cap is the estimate's worst case, the deadline the longest allowed and the finding cap one per part, all said on the estimate's last line.
    expect(lines[1]).toMatch(new RegExp(`; the review's token cap is ${worst}, this estimate's worst case, its deadline 86400000 ms, the longest allowed, and its finding cap 109, one per research part: the config sets none of them$`))
    expect(stderr().indexOf(lines[1])).toBeLessThan(stderr().indexOf('warning: a large review'))
    expect(stderr()).not.toContain('Error:')
    // The review is never held: every part's request is sent, and no cap stops it.
    expect(parts).toBeGreaterThan(2)
    expect(fetchMock).toHaveBeenCalledTimes(parts)
    expect(JSON.parse(stdout()).meta.incomplete).toEqual([])
  })

  it('names a set maxFindings in a path review\'s estimate, and counts the votes at it', async () => {
    const config = write('findings.yaml', `${TEAM_YAML}maxFindings: 3\n`)
    const fetchMock = vi.fn().mockImplementation(async () => chatReply(JSON.stringify({ findings: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { io, stderr } = harness({
      argv: ['--config', config, '--path', 'src'],
      git: bigGit().seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    const { lines, parts, votes } = estimateOf(stderr())
    // The cap is the one the config sets, however many parts there are, and the votes are counted at it.
    expect(parts).toBeGreaterThan(3)
    expect(votes).toBe(3 * 3)
    expect(lines[1]).toMatch(/, and its finding cap 3 \(maxFindings\)$/)
    expect(lines[1]).not.toContain('the config sets none of them')
    expect(fetchMock).toHaveBeenCalledTimes(parts)
  })

  it('writes no large review\'s warning for a small path review whose worst case passes 2000000 through recovery\'s bound alone', async () => {
    stubChat(JSON.stringify({ findings: [] }))
    const { io, stderr } = harness({
      argv: ['--path', 'src'],
      env: MODEL,
      git: pathGit().seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    const { lines, expected, inFlight } = estimateOf(stderr())
    const worst = Number(/at most (\d+) with every vote/.exec(lines[1])?.[1])
    expect(worst).toBeGreaterThan(2_000_000)
    expect(expected + inFlight).toBeLessThanOrEqual(2_000_000)
    expect(lines[1]).toContain(`token cap is ${worst}, this estimate's worst case`)
    expect(stderr()).not.toContain('warning:')
  })

  it('runs a path review under an explicit maxReviewTokens below its estimate to the cap, after its warning, the rest a token-cap gap', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => chatReply(JSON.stringify({ findings: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { io, stdout, stderr } = harness({
      argv: ['--path', 'src'],
      env: { ...MODEL, QUORUM_MAX_REVIEW_TOKENS: '120000' },
      git: bigGit().seam,
      platform: 'linux',
    })
    expect(await runCli(io)).toBe(EXIT.incomplete)

    const { lines, parts, expected, inFlight } = estimateOf(stderr())
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/; the review's token cap is 120000 \(maxReviewTokens\), its deadline 86400000 ms, the longest allowed, and its finding cap \d+(, one per research part|, the default, which holds one per research part)$/)
    expect(lines[2]).toContain('research alone expects about')
    // The estimate says the review may pass the cap, and the warning says how much of it the cap holds.
    expect(parts).toBeGreaterThan(2)
    expect(expected + inFlight).toBeGreaterThan(120_000)
    const warning = /^warning: the token cap of 120000 \(maxReviewTokens\) holds about (\d+) of the (\d+) research parts this estimate expects: the review runs to the cap, and what it cannot pay for is a token-cap gap; unset maxReviewTokens to let a path review's cap follow its estimate$/m.exec(stderr())
    expect(warning).not.toBeNull()
    expect(Number(warning?.[2])).toBe(parts)
    expect(Number(warning?.[1])).toBeLessThan(parts)
    expect(stderr().indexOf(lines[2])).toBeLessThan(stderr().indexOf('warning: the token cap'))
    expect(stderr()).not.toContain('Error:')
    expect(stderr()).not.toContain('a large review')
    // What the cap funds is sent, and the parts it cannot fund are not, and are a gap.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    expect(fetchMock.mock.calls.length).toBeLessThan(parts)
    const result = JSON.parse(stdout())
    expect(result.meta.incomplete).toEqual([
      {
        profile: 'security',
        reason: 'token-cap',
        detail: `the review's token cap of 120000 tokens stopped ${parts - fetchMock.mock.calls.length} of its ${parts} research parts`,
      },
    ])
    expect(JSON.stringify(result.meta.profiles.security.coverage)).toContain('"reason":"token-cap"')
  })

  it('warns that --large does nothing, and runs as without it', async () => {
    const run = async (argv: string[]) => {
      const fetchMock = stubChat(JSON.stringify({ findings: [] }))
      const { io, stdout, stderr } = harness({
        argv,
        env: MODEL,
        git: pathGit().seam,
        platform: 'linux',
      })
      const code = await runCli(io)
      vi.unstubAllGlobals()
      return {
        code,
        stdout: JSON.parse(stdout()),
        stderr: stderr(),
        calls: fetchMock.mock.calls.length,
      }
    }
    const plain = await run(['--path', 'src'])
    const large = await run(['--path', 'src', '--large'])
    const warning = 'warning: --large is no longer needed and does nothing: a path review\'s token cap follows its estimate'
    expect(plain.stderr).not.toContain('--large')
    expect(large.stderr.split('\n')).toContain(warning)
    expect(large.code).toBe(plain.code)
    expect(large.calls).toBe(plain.calls)
    expect(large.stdout.meta.incomplete).toEqual(plain.stdout.meta.incomplete)
    expect(estimateOf(large.stderr).lines).toEqual(estimateOf(plain.stderr).lines)
  })

  it('prints no estimate for a diff, a range or local changes, and never gates them', async () => {
    const env = { ...MODEL, QUORUM_MAX_REVIEW_TOKENS: '1000' }
    const runs = [
      harness({ argv: [], stdin: DIFF, env }),
      harness({
        argv: ['--range', 'secret-base...secret-head'],
        env,
        git: git().seam,
        platform: 'linux',
      }),
      harness({
        argv: ['--local'],
        env,
        git: localGit().seam,
        platform: 'linux',
      }),
    ]
    for (const { io, stdout, stderr } of runs) {
      const fetchMock = stubChat()
      // The cap leaves no room for the research request: the review ends at that, not at a gate.
      expect(await runCli(io)).toBe(EXIT.incomplete)
      expect(stderr()).not.toContain('estimate:')
      expect(stderr()).not.toContain('Error:')
      const { incomplete } = JSON.parse(stdout()).meta as { incomplete: Array<{ reason: string, detail: string }> }
      expect(incomplete.map(entry => entry.reason)).toEqual(['token-cap'])
      // A diff review keeps the config's cap, and the quorum's deadline of 30 minutes, never a path review's 24 hours.
      expect(incomplete[0].detail).toBe('the review\'s token cap of 1000 tokens stopped its research')
      expect(stderr()).not.toContain('86400000')
      expect(fetchMock).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    }
  })

  describe('the default state directory', () => {
    /** The key of the repository `pathGit` makes: the first 12 hex characters of the SHA-256 of its top level, `/repo`. */
    const KEY = createHash('sha256').update('/repo').digest('hex').slice(0, 12)
    const TREE: Readonly<Record<string, string>> = { 'src/a.js': 'exec(cmd)\n' }
    const CODE_FINDING = { ...FINDING, file: 'src/a.js' }
    let home = ''
    beforeEach(() => {
      home = realpathSync(mkdtempSync(join(dir, 'home-')))
    })
    /** The place of the default directory under `home`, on Linux. */
    const place = (): string => join(home, '.cache', 'quorum', 'state', KEY)
    /** A path review on a fake terminal, plain so that no timer runs, in the environment of `home`. */
    const review = (options: { readonly argv?: readonly string[], readonly env?: Record<string, string>, readonly signal?: AbortSignal, readonly terminal?: boolean } = {}): ReturnType<typeof harness> => harness({
      argv: [
        '--path',
        'src',
        '--progress',
        'plain',
        ...options.argv ?? [],
      ],
      env: {
        ...MODEL,
        HOME: home,
        ...options.env,
      },
      git: pathGit(TREE).seam,
      platform: 'linux',
      signal: options.signal,
      terminal: options.terminal === false
        ? undefined
        : fakeTerminal({ columns: 80, rows: 24 }),
    })
    /** A fetch whose first call, the research reply, waits for `release`, and whose later calls keep the finding. */
    function heldReply(): { readonly fetchMock: ReturnType<typeof vi.fn>, readonly release: (content: string) => void } {
      let release: (content: string) => void = () => {}
      const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => {
        release = content => resolve(chatReply(content))
      })).mockImplementation(async () => chatReply(vote(true)))
      vi.stubGlobal('fetch', fetchMock)
      return {
        fetchMock,
        release: content => release(content),
      }
    }

    it('keeps a path review\'s answered calls in the default directory on a terminal, and reuses them on a rerun of the same command', async () => {
      const { fetchMock, release } = heldReply()
      const controller = new AbortController()
      const first = review({ signal: controller.signal })
      const exit = runCli(first.io)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      controller.abort()
      release(JSON.stringify({
        findings: [CODE_FINDING],
      }))
      expect(await exit).toBe(EXIT.interrupted)
      // The marker and the one reply that ended within the grace, in a directory made with its parents at mode 0700.
      expect(readdirSync(place())).toHaveLength(2)
      expect(statSync(place()).mode & 0o777).toBe(0o700)
      expect(statSync(join(home, '.cache')).mode & 0o777).toBe(0o700)
      expect(first.stderr().split('\n')).toContain('resume: rerun the same command: its 1 answered call(s) are kept, and the rerun reuses each one whose request is unchanged')
      expect(first.stderr()).not.toContain(home)
      expect(first.stderr()).not.toContain('pass --state <dir>')
      // The rerun asks for the votes alone: the research reply is read from the directory.
      vi.unstubAllGlobals()
      const second = stubChat(vote(true), vote(true), vote(true))
      const rerun = review()
      expect(await runCli(rerun.io)).toBe(EXIT.finding)
      expect(second).toHaveBeenCalledTimes(3)
      for (const call of second.mock.calls) expect(String(call[1].body)).toContain('One vote in a 3-voter panel')
      expect(rerun.stderr()).toContain('reused from the saved state: 1 research call(s), 0 vote(s)\n')
      expect(rerun.stderr()).not.toContain(home)
    })

    it('removes the default directory once the review completes with nothing left for a rerun', async () => {
      let during = false
      vi.stubGlobal('fetch', vi.fn(async () => {
        during = existsSync(place())
        return chatReply('{"findings":[]}')
      }))
      const { io, stderr } = review()
      expect(await runCli(io)).toBe(EXIT.ok)
      expect(during).toBe(true)
      expect(existsSync(place())).toBe(false)
      expect(stderr()).not.toContain('resume:')
      expect(stderr()).not.toContain('could not be removed')
    })

    it('keeps no default directory in CI, with --no-state, or for a diff', async () => {
      for (const start of [
        () => review({
          env: { CI: 'true' },
        }),
        () => review({
          argv: ['--no-state'],
        }),
        () => review({ terminal: false }),
        () => harness({
          env: { ...MODEL, HOME: home },
          stdin: DIFF,
          platform: 'linux',
          terminal: fakeTerminal({ columns: 80, rows: 24 }),
        }),
      ]) {
        stubChat('{"findings":[]}')
        const { io, stderr } = start()
        expect(await runCli(io), stderr()).toBe(EXIT.ok)
        expect(existsSync(join(home, '.cache'))).toBe(false)
      }
      expect(readdirSync(home)).toEqual([])
    })

    it('warns and reviews without it when the default directory is refused, a home kept in git', async () => {
      mkdirSync(join(home, '.git'))
      stubChat('{"findings":[]}')
      const { io, stderr } = review()
      expect(await runCli(io)).toBe(EXIT.ok)
      expect(stderr()).toContain('warning: the default state directory lies inside a git work tree, which a change could write to: name a directory outside every repository: the review keeps no answered call; pass --state <dir> to keep them elsewhere\n')
      expect(stderr()).not.toContain(home)
      // Nothing was made inside the work tree.
      expect(readdirSync(home)).toEqual(['.git'])
      // The review's exit code is the one it has with no store.
      stubChat('{"findings":[]}')
      const without = review({
        argv: ['--no-state'],
      })
      expect(await runCli(without.io)).toBe(EXIT.ok)
    })

    it('refuses --no-state with --state or --print-config', async () => {
      for (const [argv, issue] of [
        [
          [
            '--no-state',
            '--state',
            join(home, 'calls'),
          ],
          '--no-state: cannot be given with --state',
        ],
        [
          ['--no-state', '--print-config'],
          '--print-config: reads no diff and calls no model, so it takes no --no-state',
        ],
      ] as const) {
        const fetchMock = stubChat()
        const { io, stderr } = harness({
          argv: [...argv],
          env: MODEL,
          stdin: DIFF,
        })
        expect(await runCli(io)).toBe(EXIT.usage)
        expect(stderr()).toBe(`Error: ${issue}\n${USAGE}`)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(existsSync(join(home, 'calls'))).toBe(false)
      }
    })
  })

  it('prints the usage of the sources, every description at column 27', async () => {
    const { io, stdout, stderr } = harness({
      argv: ['--help'],
    })
    expect(await runCli(io)).toBe(EXIT.ok)
    expect(stderr()).toBe('')
    expect(stdout()).toBe(USAGE)
    const lines = stdout().split('\n')
    expect(lines.filter(line => line.startsWith('Usage:') || line.startsWith('       '))).toEqual([
      'Usage: quorum [options] [diff-file]',
      '       git diff | quorum [options]',
      '       quorum --range <base>...<head> [options]',
      '       quorum --local | --staged [options]',
      '       quorum --path <path> [--at <rev>] [options]',
      '       quorum bench [options] <suite>',
      '       quorum report [options] [<result>|-]',
      '       quorum mcp [options]',
    ])
    const options = lines.slice(lines.indexOf('Options:') + 1).filter(line => line !== '')
    expect(options).toHaveLength(23)
    for (const line of options) {
      expect(line.slice(0, 27).trim(), line).toMatch(/^(?:-\w, )?--[a-z-]+(?: <\w+>)?$/)
      expect(line.slice(25, 27), line).toBe('  ')
      expect(line[27], line).not.toBe(' ')
    }
  })

  it('hands the arguments after report to quorum report, and reviews a file named report as ./report', async () => {
    const cwd = mkdtempSync(join(dir, 'report-'))
    const fetchMock = stubChat()
    const missing = harness({
      argv: ['report', 'none.json'],
      cwd,
      env: MODEL,
    })
    expect(await runCli(missing.io)).toBe(EXIT.usage)
    expect(missing.stderr()).toMatch(/^Error: the result file does not exist\nUsage: quorum report \[options\] \[<result>\|-\]\n/)
    expect(missing.stdout()).toBe('')

    writeFileSync(join(cwd, 'report'), '\n')
    const reviewed = harness({
      argv: ['./report'],
      cwd,
      env: MODEL,
    })
    expect(await runCli(reviewed.io)).toBe(EXIT.ok)
    expect(reviewed.stderr()).toContain('empty diff: nothing to review')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hands the arguments after mcp to quorum mcp, and reviews a file named mcp as ./mcp', async () => {
    const cwd = mkdtempSync(join(dir, 'mcp-'))
    const fetchMock = stubChat()
    const refused = harness({
      argv: ['mcp', '--watch'],
      cwd,
      env: MODEL,
    })
    expect(await runCli(refused.io)).toBe(EXIT.usage)
    expect(refused.stderr()).toMatch(/^Error: Unknown option '--watch'.*\nUsage: quorum mcp \[options\]\n/)
    expect(refused.stdout()).toBe('')

    writeFileSync(join(cwd, 'mcp'), '\n')
    const reviewed = harness({
      argv: ['./mcp'],
      cwd,
      env: MODEL,
    })
    expect(await runCli(reviewed.io)).toBe(EXIT.ok)
    expect(reviewed.stderr()).toContain('empty diff: nothing to review')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
