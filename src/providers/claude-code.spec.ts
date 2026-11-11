import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, ProviderError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { ChatMessage, CompletionRequest } from '../core/ports.ts'
import { fakeClaudeEnv, isRunning, readFakeRecord, readFakeVersionRecords, writeFakeClaude } from '../testing/claude.ts'
import * as fixtures from '../testing/fixtures/claude-code.ts'
import { childEnv, claudeArgs, claudeCode, claudeCodeIssues, credentialValues, KILL_GRACE_MS, MAX_STDERR_BYTES, MAX_STDOUT_BYTES, MIN_CLAUDE_CODE_VERSION, prepareRun, readCapped, readResult, stopLiveRuns, trackRun, VERSION_CHECK_MS, versionProblem } from './claude-code.ts'
import type { ClaudeCodeOptions } from './claude-code.ts'
import { CONTEXT_REQUIRED } from './options.ts'
import { replyFailure } from './reply.ts'

const options: ClaudeCodeOptions = { id: 'cc', model: 'sonnet', contextTokens: 200000 }
const ISOLATED = ['--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']

/** A list with a hole at 0: `[ , '--effort', 'low']`, which `every` and `map` skip. */
function sparseArgs(): unknown[] {
  const args = Array.from<unknown>({ length: 3 })
  delete args[0]
  args[1] = '--effort'
  args[2] = 'low'
  return args
}

/** The error `run` throws, for `toMatchObject`. */
function failure(run: () => unknown): ProviderError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError)
    return error as ProviderError
  }
  throw new Error('no failure')
}

describe('claudeArgs', () => {
  it('runs claude headless as a pure completion, with the reply schema in schema mode', () => {
    expect(claudeArgs({ model: 'sonnet', auth: 'inherit', structuredOutput: 'schema', args: [] }, '/run/system.txt', { type: 'object' })).toEqual([
      '-p',
      '--output-format=json',
      '--model=sonnet',
      '--system-prompt-file=/run/system.txt',
      ...ISOLATED,
      '--json-schema={"type":"object"}',
    ])
  })

  it('sends no schema in prompt mode, adds --bare in api-key mode, and passes the args last as --flag=value', () => {
    expect(claudeArgs({ model: 'opus[1m]', auth: 'api-key', structuredOutput: 'prompt', args: ['--effort', 'high', '--betas=context-1m'] }, '/run/system.txt', { type: 'object' })).toEqual([
      '-p',
      '--output-format=json',
      '--model=opus[1m]',
      '--system-prompt-file=/run/system.txt',
      ...ISOLATED,
      '--bare',
      '--effort=high',
      '--betas=context-1m',
    ])
  })

  it('never passes an element the checks refuse, whatever it asks of claude', () => {
    const args = ['--tools=Bash', '--effort=low', '--effort', 'high', '--betas', 'context-1m', '--fallback-model', '-x', '--max-budget-usd=0.05', '--mcp-config', 'x.json']
    expect(claudeArgs({ model: 'sonnet', auth: 'login', structuredOutput: 'prompt', args }, '/run/system.txt', { type: 'object' }).slice(11)).toEqual(['--effort=low', '--max-budget-usd=0.05'])
  })

  it('does not throw on a sparse list or an element that is no string, and passes none of them', () => {
    const settings = (args: unknown[]) => ({ model: 'sonnet', auth: 'login' as const, structuredOutput: 'prompt' as const, args: args as string[] })
    expect(claudeArgs(settings(sparseArgs()), '/run/system.txt', { type: 'object' }).slice(11)).toEqual(['--effort=low'])
    expect(claudeArgs(settings([7, '--effort', 'low', '--fallback-model', null, '--max-budget-usd', {}]), '/run/system.txt', { type: 'object' }).slice(11)).toEqual(['--effort=low'])
  })
})

describe('childEnv', () => {
  const KEPT = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    HTTPS_PROXY: 'http://proxy:3128',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    ANTHROPIC_BETAS: 'context-1m-2025-08-07',
    CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
  }
  const CREDENTIALS = {
    ANTHROPIC_API_KEY: 'sk-env',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'https://gw.example',
    ANTHROPIC_PROFILE: 'work',
    ANTHROPIC_FEDERATION_RULE_ID: 'r',
    ANTHROPIC_ORGANIZATION_ID: 'o',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer other',
    ANTHROPIC_UNIX_SOCKET: '/tmp/proxy.sock',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_USE_LATER_CLOUD: '1',
  }
  const SESSION = {
    CLAUDE_CODE_MESSAGING_TOKEN: 'parent-secret',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
    CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
    CLAUDE_CODE_EMIT_STARTUP_TIMING: '1',
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
  }
  /** What loads plugins, skills, tools or a launcher, or adds to the request body, in any mode. */
  const CAPABILITIES = {
    CLAUDE_CODE_PLUGIN_DIRS: '/plugins',
    CLAUDE_CODE_PLUGIN_SEED_DIR: '/seed',
    CLAUDE_CODE_PLUGIN_CACHE_DIR: '/cache',
    CLAUDE_CODE_SYNC_PLUGINS: '1',
    CLAUDE_CODE_SYNC_SKILLS: '1',
    CLAUDE_CODE_PROCESS_WRAPPER: '/launcher',
    CLAUDE_CODE_ENABLE_CFC: '1',
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    CLAUDE_CODE_ENABLE_TASKS: '1',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
    CLAUDE_CODE_EXTRA_BODY: '{"tools":[]}',
    CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
  }
  const env = {
    ...KEPT,
    ...CREDENTIALS,
    ...SESSION,
    ...CAPABILITIES,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    DISABLE_COMPACT: '0',
    CLAUDE_CODE_TMPDIR: '/elsewhere',
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'true',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '0',
    CLAUDE_CODE_DISABLE_FILE_MENTIONS: '0',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '0',
    CLAUDE_CODE_DISABLE_POLICY_SKILLS: '0',
    UNSET: undefined,
  }
  const ISOLATION = {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_COMPACT: '1',
    CLAUDE_CODE_TMPDIR: '/run/tmp',
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
    CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
  }

  it('passes the environment through under inherit, without the parent session\'s variables or what loads or adds, and with the isolation set: the connectors, attachments, mentions, CLAUDE.md files and bundled and managed skills off', () => {
    expect(childEnv(env, 'inherit', undefined, '/run/tmp')).toEqual({ ...KEPT, ...CREDENTIALS, ...ISOLATION })
  })

  it('removes every credential, header and endpoint variable under login, so the Claude Code login answers', () => {
    expect(childEnv(env, 'login', undefined, '/run/tmp')).toEqual({ ...KEPT, ...ISOLATION })
  })

  it('removes the same variables under api-key, then sets its key', () => {
    expect(childEnv(env, 'api-key', 'sk-mine', '/run/tmp')).toEqual({ ...KEPT, ...ISOLATION, ANTHROPIC_API_KEY: 'sk-mine' })
  })

  it('keeps the environment\'s ANTHROPIC_API_KEY under api-key when it is given no key', () => {
    expect(childEnv(env, 'api-key', undefined, '/run/tmp')).toEqual({ ...KEPT, ...ISOLATION, ANTHROPIC_API_KEY: 'sk-env' })
  })

  it('matches names in any letter case, as Windows reads them', () => {
    const mixed = {
      PATH: '/usr/bin',
      Anthropic_Api_Key: 'sk-win',
      claude_code_use_bedrock: '1',
      Claude_Code_Plugin_Dirs: '/p',
      claude_code_messaging_token: 'parent-secret',
      claude_code_tmpdir: '/elsewhere',
      Disable_Compact: '0',
      enable_claudeai_mcp_servers: 'true',
      Anthropic_Custom_Headers: 'X: y',
      claude_code_disable_attachments: '0',
      Claude_Code_Disable_File_Mentions: '0',
      CLAUDE_CODE_disable_claude_mds: '0',
      claude_code_disable_bundled_skills: '0',
      Claude_Code_Disable_Policy_Skills: '0',
      claude_code_force_session_persistence: '1',
    }
    expect(childEnv(mixed, 'login', undefined, '/run/tmp')).toEqual({ PATH: '/usr/bin', ...ISOLATION })
    expect(childEnv(mixed, 'api-key', undefined, '/run/tmp')).toEqual({ PATH: '/usr/bin', ...ISOLATION, ANTHROPIC_API_KEY: 'sk-win' })
    expect(childEnv(mixed, 'inherit', undefined, '/run/tmp')).toEqual({ PATH: '/usr/bin', Anthropic_Api_Key: 'sk-win', claude_code_use_bedrock: '1', Anthropic_Custom_Headers: 'X: y', ...ISOLATION })
  })

  it('reads only the environment\'s own variables', () => {
    expect(childEnv(Object.create({ ANTHROPIC_API_KEY: 'inherited' }) as Record<string, string>, 'inherit', undefined, '/t')).toEqual({ ...ISOLATION, CLAUDE_CODE_TMPDIR: '/t' })
  })
})

describe('credentialValues', () => {
  const SECRETS = {
    ANTHROPIC_API_KEY: 'sk-env',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer other',
    AWS_BEARER_TOKEN_BEDROCK: 'aws-bearer',
    ANTHROPIC_AWS_API_KEY: 'aws-key',
    ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key',
    ANTHROPIC_FOUNDRY_AUTH_TOKEN: 'foundry-tok',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_SESSION_TOKEN: 'aws-session',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'oauth-refresh',
    CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'passphrase',
  }
  const env = { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_BASE_URL: 'https://gw.example', ...SECRETS }
  /** What `login` and `api-key` keep: every credential but the four they remove. */
  const KEPT_BY_LOGIN = ['aws-bearer', 'aws-key', 'foundry-key', 'foundry-tok', 'oauth', 'aws-secret', 'aws-session', 'oauth-refresh', 'passphrase']
  const valuesOf = (auth: 'inherit' | 'login' | 'api-key', apiKey?: string): string[] => credentialValues(childEnv(env, auth, apiKey, '/run/tmp')).sort()

  it('holds every credential the child receives under inherit, and nothing else', () => {
    expect(valuesOf('inherit')).toEqual(Object.values(SECRETS).sort())
  })

  it('holds the credentials login keeps, which are not the ones it removes', () => {
    expect(valuesOf('login')).toEqual([...KEPT_BY_LOGIN].sort())
  })

  it('holds the key api-key sends, not the one it replaces', () => {
    expect(valuesOf('api-key', 'sk-mine')).toEqual([...KEPT_BY_LOGIN, 'sk-mine'].sort())
    expect(valuesOf('api-key')).toContain('sk-env')
  })

  it('holds a value as written and trimmed, matches names in any letter case, and leaves out a value that is blank once trimmed', () => {
    const odd = { claude_code_oauth_token: ' spaced ', Anthropic_Auth_Token: '  ', ANTHROPIC_API_KEY: '', HOME: ' not-a-secret ' }
    expect(credentialValues(childEnv(odd, 'inherit', undefined, '/t')).sort()).toEqual([' spaced ', 'spaced'])
  })
})

describe('versionProblem', () => {
  const REQUIRED = 'Claude Code 2.1.311 or newer is required, found'

  it('requires 2.1.311, exported as the minimum', () => {
    expect(MIN_CLAUDE_CODE_VERSION).toBe('2.1.311')
  })

  it.each(['2.1.311 (Claude Code)', '2.1.311', '2.1.312\n', '  2.1.311 (Claude Code)\n', '2.2.0', '2.10.0', '3.0.0', '10.0.0 (Claude Code)', '2.1.311-beta.1', '99999.0.0'])('takes %j', (output) => {
    expect(versionProblem(output)).toBeUndefined()
  })

  it.each<[string, string]>([
    ['2.1.310 (Claude Code)', '2.1.310'],
    ['2.0.999', '2.0.999'],
    ['1.99.99', '1.99.99'],
    ['0.0.1', '0.0.1'],
  ])('refuses %j as older, quoting its version', (output, version) => {
    expect(versionProblem(output)).toBe(`${REQUIRED} ${version}`)
  })

  it.each(['', '  \n', 'Claude Code 2.1.311', 'v2.1.311', '2.1', '2.1.x', '2,1,311', 'error: unknown option --version', 'sk-SECRET'])('refuses %j as an unknown version, quoting none of it', (output) => {
    expect(versionProblem(output)).toBe(`${REQUIRED} an unknown version`)
  })

  it('quotes a version of at most four digits in each part, else writes an unknown version', () => {
    expect(versionProblem('0.9999.9999')).toBe(`${REQUIRED} 0.9999.9999`)
    expect(versionProblem('0.0.10000')).toBe(`${REQUIRED} an unknown version`)
    expect(versionProblem('1.99999.1')).toBe(`${REQUIRED} an unknown version`)
  })
})

describe('readCapped', () => {
  /** Feed `chunks` to a stream read by `readCapped` and wait until it has ended. */
  async function capture(max: number, chunks: Array<Buffer | string>) {
    const stream = new PassThrough()
    const overflows = vi.fn()
    const capped = readCapped(stream, max, overflows)
    for (const chunk of chunks) stream.write(chunk)
    stream.end()
    await once(stream, 'end')
    return { text: capped.text(), overflowed: capped.overflowed(), overflows }
  }

  it('keeps stdout up to 16 MiB, and stops claude once at the first byte over', async () => {
    expect(MAX_STDOUT_BYTES).toBe(16 * 1024 * 1024)
    const full = await capture(MAX_STDOUT_BYTES, [Buffer.alloc(MAX_STDOUT_BYTES, 'a')])
    expect(full).toMatchObject({ overflowed: false })
    expect(full.text).toHaveLength(MAX_STDOUT_BYTES)
    expect(full.overflows).not.toHaveBeenCalled()
    const over = await capture(MAX_STDOUT_BYTES, [Buffer.alloc(MAX_STDOUT_BYTES, 'a'), 'b', Buffer.alloc(1000, 'c')])
    expect(over.overflowed).toBe(true)
    expect(over.text).toHaveLength(MAX_STDOUT_BYTES)
    expect(over.text.endsWith('a')).toBe(true)
    expect(over.overflows).toHaveBeenCalledTimes(1)
  })

  it('keeps stderr up to 64 KiB and drops the rest, without stopping claude', async () => {
    expect(MAX_STDERR_BYTES).toBe(64 * 1024)
    const output = await capture(MAX_STDERR_BYTES, [Buffer.alloc(MAX_STDERR_BYTES - 5, 'a'), 'tail-of-stderr', 'more'])
    expect(output.text).toBe(`${'a'.repeat(MAX_STDERR_BYTES - 5)}tail-`)
  })

  it('cuts a chunk at the cap, decodes a character split between chunks, and writes U+FFFD for one the cap cuts', async () => {
    const euro = Buffer.from('€')
    expect((await capture(100, [euro.subarray(0, 1), euro.subarray(1), 'x'])).text).toBe('€x')
    const cut = await capture(4, ['ab', euro])
    expect(cut.text).toBe(`ab${String.fromCharCode(0xFFFD)}`)
    expect(cut.overflowed).toBe(true)
  })

  it('reads nothing from a child with no pipe', () => {
    const capped = readCapped(null, 10)
    expect(capped.text()).toBe('')
    expect(capped.overflowed()).toBe(false)
  })
})

describe('claudeCodeIssues', () => {
  const issuesOf = (fields: Record<string, unknown>): ConfigIssue[] => claudeCodeIssues({ ...options, ...fields } as ClaudeCodeOptions)
  const at = (path: string, message: string): ConfigIssue => ({ path: `cc.${path}`, message })
  const FLAGS = 'is not a flag quorum passes to claude: use --effort, --fallback-model, --max-budget-usd or --betas'
  const RELATIVE = 'must be an absolute path, or a name to find on PATH'
  const SCRIPT = 'is a Windows script, which runs only through a shell: name claude.exe instead'
  const MODEL = 'must be a model id of visible ASCII characters, with no space, that does not start with -'
  const NOT_AN_OPTION = 'is not an option of the claude-code protocol'
  const NOT_A_STRING = 'must be a string'
  const BUDGET = 'must be a positive number of dollars, such as 0.50'

  it('takes the defaults, every auth mode and every allowlisted flag', () => {
    expect(issuesOf({})).toEqual([])
    expect(issuesOf({ auth: 'login', command: 'claude' })).toEqual([])
    expect(issuesOf({ auth: 'api-key', apiKey: 'sk-k', structuredOutput: 'prompt', args: ['--effort', 'max', '--fallback-model=haiku', '--max-budget-usd', '0.50', '--betas', 'context-1m'], command: '/opt/claude/bin/claude' })).toEqual([])
    expect(issuesOf({ args: ['--max-budget-usd=99999999.999'] })).toEqual([])
  })

  it.each<[Record<string, unknown>, ConfigIssue[]]>([
    [{ model: '-p' }, [at('model', MODEL)]],
    [{ model: 'son net' }, [at('model', MODEL)]],
    [{ contextTokens: undefined }, [at('contextTokens', CONTEXT_REQUIRED)]],
    [{ contextTokens: 20096 }, [at('contextTokens', 'must be more than 20096, the 16000 tokens of the reply budget and 4096 for the chat template')]],
    [{ auth: 'bearer' }, [at('auth', 'must be inherit, login or api-key')]],
    [{ apiKey: 'sk-k' }, [at('apiKey', 'is set, but auth is not api-key, so it would never be sent')]],
    [{ auth: 'api-key', apiKey: 'sk k' }, [at('apiKey', 'must only contain visible ASCII characters')]],
    [{ structuredOutput: 'json' }, [at('structuredOutput', 'must be prompt or schema')]],
    [{ args: '--effort high' }, [at('args', 'must be a list of strings')]],
    [{ args: ['--tools', 'Bash'] }, [at('args.0', FLAGS), at('args.1', FLAGS)]],
    [{ args: ['--effort'] }, [at('args.0', 'needs a value')]],
    [{ args: ['--effort', 'turbo'] }, [at('args.1', 'must be low, medium, high, xhigh or max')]],
    [{ args: ['--effort=high --tools=Bash'] }, [at('args.0', 'must be low, medium, high, xhigh or max')]],
    [{ args: ['--max-budget-usd', '0'] }, [at('args.1', BUDGET)]],
    [{ args: ['--fallback-model', '--tools'] }, [at('args.1', 'must be visible ASCII characters that do not start with -')]],
    [{ args: sparseArgs() }, [at('args.0', NOT_A_STRING)]],
    [{ args: [7, '--effort', 'low'] }, [at('args.0', NOT_A_STRING)]],
    [{ args: ['--effort', 7] }, [at('args.1', NOT_A_STRING)]],
    [{ args: ['--effort', undefined] }, [at('args.1', NOT_A_STRING)]],
    [{ args: ['--max-budget-usd', '9'.repeat(13)] }, [at('args.1', BUDGET)]],
    [{ args: ['--max-budget-usd=99999999.9999'] }, [at('args.0', BUDGET)]],
    [{ args: ['--effort', 'low', '--effort', 'high'] }, [at('args.2', 'repeats a flag')]],
    [{ args: ['--betas', 'context-1m'] }, [at('args.0', 'is only for auth: api-key')]],
    [{ command: '' }, [at('command', 'must name an executable')]],
    [{ command: './claude' }, [at('command', RELATIVE)]],
    [{ command: 'claude.cmd' }, [at('command', SCRIPT)]],
    [{ command: '/opt/claude/claude.BAT' }, [at('command', SCRIPT)]],
    [
      { baseUrl: 'https://api.anthropic.com', headers: {}, query: {}, extraBody: {}, temperature: 0, maxTokens: 100, systemPrompt: 'native' },
      ['baseUrl', 'headers', 'query', 'extraBody', 'temperature', 'maxTokens', 'systemPrompt'].map(field => at(field, NOT_AN_OPTION)),
    ],
  ])('refuses %j', (fields, issues) => {
    expect(issuesOf(fields)).toEqual(issues)
  })

  it('never repeats a value it refuses', () => {
    const issues = issuesOf({ model: '-sk-SECRET', apiKey: 'sk-SECRET', args: ['sk-SECRET', '--fallback-model', '-sk-SECRET'], command: './sk-SECRET' })
    expect(issues).toHaveLength(5)
    expect(JSON.stringify(issues)).not.toContain('SECRET')
  })
})

describe('readResult', () => {
  /** `stdout` with `fields` set over its result; a field set to `undefined` drops out. */
  const change = (stdout: string, fields: Record<string, unknown>): string => `${JSON.stringify({ ...JSON.parse(stdout), ...fields })}\n`
  const read = (stdout: string, run: { code?: number | null, stderr?: string, signal?: string | null, structuredOutput?: 'prompt' | 'schema', redact?: string[] } = {}) =>
    readResult({ stdout, stderr: run.stderr ?? '', code: run.code === undefined ? 0 : run.code, signal: run.signal ?? null }, { id: 'cc', model: 'sonnet', structuredOutput: run.structuredOutput ?? 'schema', redact: run.redact ?? [] })

  it('reads the structured output of a schema run, the usage of every turn, its cost and the model that answered', () => {
    expect(read(fixtures.schema)).toEqual({ text: '{"keep":true}', model: 'claude-haiku-5-5', usage: { inputTokens: 2662, outputTokens: 225, costUsd: 0.000525 } })
  })

  it('reads the result of a prompt run', () => {
    expect(read(fixtures.plain, { structuredOutput: 'prompt' })).toEqual({ text: 'pong', model: 'claude-haiku-5-5', usage: { inputTokens: 955, outputTokens: 4, costUsd: 0.0001928 } })
  })

  it('reads an API error from the JSON on stdout, whatever the exit code and the subtype say', () => {
    expect(failure(() => read(fixtures.unknownModel, { code: 1, stderr: fixtures.unknownModelStderr }))).toMatchObject({
      kind: 'http',
      status: 404,
      retryable: false,
      message: `cc: HTTP 404 from the model API: "There's an issue with the selected model (claude-nonexistent-9-9). It may not exist or you may not have access to it."`,
    })
  })

  it('reads a prompt Claude Code finds too long as too-large, so the review records a gap', () => {
    expect(failure(() => read(fixtures.promptTooLong, { code: 1 }))).toMatchObject({ kind: 'too-large', retryable: false, message: 'cc: Claude Code refused the prompt as too long for the model\'s context' })
  })

  it('reads a refusal', () => {
    expect(failure(() => read(fixtures.refusal))).toMatchObject({ kind: 'refusal', message: 'cc: model refused' })
  })

  it('reads a reply the token limit cut off as truncated, in both modes, before it reads the text', () => {
    const cut = { kind: 'truncated', retryable: false, message: 'cc: reply was cut off by the token limit' }
    expect(failure(() => read(change(fixtures.schema, { stop_reason: 'max_tokens' })))).toMatchObject(cut)
    expect(failure(() => read(change(fixtures.plain, { stop_reason: 'max_tokens' }), { structuredOutput: 'prompt' }))).toMatchObject(cut)
    // Before the text: a cut reply with no structured output is not read as a reply that has none.
    expect(failure(() => read(change(fixtures.schema, { stop_reason: 'max_tokens', structured_output: undefined })))).toMatchObject(cut)
    // An error result stays an error.
    expect(failure(() => read(change(fixtures.unknownModel, { stop_reason: 'max_tokens' }), { code: 1 }))).toMatchObject({ kind: 'http', status: 404 })
  })

  it('fails a schema run that ends without structured output, though it reports no error', () => {
    expect(failure(() => read(fixtures.noStructuredOutput))).toMatchObject({ kind: 'invalid-response', message: 'cc: reply has no structured output' })
  })

  it('fails a run that reports an error subtype, naming it', () => {
    expect(failure(() => read(fixtures.retriesExhausted, { code: 1 }))).toMatchObject({ kind: 'process', status: 1, message: 'cc: claude failed (error_max_structured_output_retries): "Failed to provide valid structured output after 5 attempts"' })
  })

  it('fails a reply that shows a tool the server ran', () => {
    expect(failure(() => read(fixtures.serverTool, { structuredOutput: 'prompt' }))).toMatchObject({ kind: 'invalid-response', message: 'cc: the server ran a tool for this reply, which quorum never allows' })
  })

  it('fails a success result that comes with a non-zero exit', () => {
    expect(failure(() => read(fixtures.schema, { code: 1 }))).toMatchObject({ kind: 'process', status: 1, message: 'cc: claude exited 1 after its result' })
  })

  it('fails a success result from a child that a signal ended, naming the signal', () => {
    expect(failure(() => read(fixtures.schema, { code: null, signal: 'SIGKILL' }))).toMatchObject({ kind: 'process', status: undefined, message: 'cc: claude was stopped by SIGKILL after its result' })
    expect(failure(() => read(fixtures.schema, { code: null, signal: 'sig kill sk-SECRET' }))).toMatchObject({ kind: 'process', message: 'cc: claude was stopped by a signal after its result' })
  })

  it('reads a result as too long from its text alone, only when it reports an error', () => {
    const tooLong = change(fixtures.unknownModel, { api_error_status: 400, terminal_reason: 'api_error', result: 'Prompt is too long: 250000 tokens > 200000 maximum' })
    expect(failure(() => read(tooLong, { code: 1 }))).toMatchObject({ kind: 'too-large' })
    expect(read(change(fixtures.plain, { result: 'Prompt is too long' }), { structuredOutput: 'prompt' })).toMatchObject({ text: 'Prompt is too long' })
  })

  it('fails a reply whose model usage counts a web search, or whose usage counts a web fetch', () => {
    const entry = Object.values(JSON.parse(fixtures.plain).modelUsage)[0] as Record<string, unknown>
    const search = change(fixtures.plain, { modelUsage: { 'claude-haiku-5-5': { ...entry, webSearchRequests: 2 } } })
    const fetched = change(fixtures.plain, { usage: { ...JSON.parse(fixtures.plain).usage, server_tool_use: { web_search_requests: 0, web_fetch_requests: 1 } } })
    for (const stdout of [search, fetched]) {
      expect(failure(() => read(stdout, { structuredOutput: 'prompt' }))).toMatchObject({ kind: 'invalid-response', message: 'cc: the server ran a tool for this reply, which quorum never allows' })
    }
  })

  it('fails a prompt run with no text, and a schema run whose output is no object', () => {
    expect(failure(() => read(change(fixtures.plain, { result: undefined }), { structuredOutput: 'prompt' }))).toMatchObject({ kind: 'invalid-response', message: 'cc: reply has no text' })
    for (const structured_output of [null, [], '{"keep":true}']) {
      expect(failure(() => read(change(fixtures.schema, { structured_output })))).toMatchObject({ kind: 'invalid-response', message: 'cc: reply has no structured output' })
    }
  })

  it('fails a structured output that cannot be serialized, as an invalid response', () => {
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    let thrown: ProviderError
    try {
      thrown = failure(() => read(fixtures.schema))
    } finally {
      stringify.mockRestore()
    }
    expect(thrown).toMatchObject({ kind: 'invalid-response', message: 'cc: reply structured output could not be serialized' })
  })

  it.each([429, 500, 529])('keeps an API error with status %i retryable', (status) => {
    expect(failure(() => read(change(fixtures.unknownModel, { api_error_status: status }), { code: 1 }))).toMatchObject({ kind: 'http', status, retryable: true })
  })

  it.each<unknown>([399, 600, 404.5, '404', null])('reads an error with status %j as a process failure, naming its terminal reason', (status) => {
    expect(failure(() => read(change(fixtures.unknownModel, { api_error_status: status }), { code: 1 }))).toMatchObject({
      kind: 'process',
      status: 1,
      retryable: false,
      message: `cc: claude failed (api_error): "There's an issue with the selected model (claude-nonexistent-9-9). It may not exist or you may not have access to it."`,
    })
  })

  it.each<unknown>([undefined, null, 'false', 0])('fails a result whose is_error is %j, which is no boolean false', (isError) => {
    expect(failure(() => read(change(fixtures.schema, { is_error: isError })))).toMatchObject({ kind: 'process', message: expect.stringContaining('cc: claude failed') })
  })

  it('reports a non-zero exit without JSON by its stderr, redacted', () => {
    expect(failure(() => read('', { code: 2, stderr: 'error: unknown option for sk-SECRET\n', redact: ['sk-SECRET'] }))).toMatchObject({ kind: 'process', status: 2, message: 'cc: claude exited 2: "error: unknown option for [redacted]\\n"' })
  })

  it('reports a stop by a signal, and an exit 0 without JSON', () => {
    expect(failure(() => read('', { code: null, signal: 'SIGKILL' }))).toMatchObject({ kind: 'process', message: 'cc: claude was stopped by SIGKILL' })
    expect(failure(() => read('', { code: null, signal: 'sig kill sk-SECRET' }))).toMatchObject({ kind: 'process', message: 'cc: claude was stopped by a signal' })
    expect(failure(() => read('not json'))).toMatchObject({ kind: 'invalid-response', message: 'cc: claude printed no JSON result' })
  })

  it('leaves out a cost that is not a number of at least 0, and counts only the numbers of a model\'s usage', () => {
    const usage = { inputTokens: 2662, outputTokens: 225 }
    expect(read(change(fixtures.schema, { total_cost_usd: -1 }))).toMatchObject({ usage })
    expect(read(change(fixtures.schema, { total_cost_usd: 'free' }))).toMatchObject({ usage })
    expect(read(change(fixtures.schema, { total_cost_usd: undefined })).usage).toEqual(usage)
    expect(read(change(fixtures.schema, { modelUsage: { x: { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: '3', cacheCreationInputTokens: null } } }))).toMatchObject({ model: 'x', usage: { inputTokens: 5, outputTokens: 6 } })
  })

  it('reports no usage when no model counts both its input and its output', () => {
    for (const modelUsage of [{}, { x: { inputTokens: 5 } }, { x: { outputTokens: 5 } }, { x: 'many' }, 'many']) {
      expect(read(change(fixtures.schema, { modelUsage }))).not.toHaveProperty('usage')
    }
  })

  it('sums the usage of several models, and names the configured model then', () => {
    const two = `${JSON.stringify({ ...JSON.parse(fixtures.schema), modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }, b: { inputTokens: 10, outputTokens: 20 } } })}\n`
    expect(read(two)).toEqual({ text: '{"keep":true}', model: 'sonnet', usage: { inputTokens: 18, outputTokens: 22, costUsd: 0.000525 } })
  })
})

describe('live runs', () => {
  let base = ''
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'quorum-cc-live-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(base, { recursive: true, force: true })
  })

  /** A run directory under `base` that holds a file, as a live run's does. */
  function runDirectory(name: string): string {
    const dir = join(base, name)
    mkdirSync(join(dir, 'cwd'), { recursive: true })
    writeFileSync(join(dir, 'system.txt'), 'instructions')
    return dir
  }
  const listening = (): number => process.listeners('exit').filter(listener => listener === stopLiveRuns).length

  it('kills the group of every live run and removes every directory when quorum exits, whatever fails on the way', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }).mockImplementation(() => true)
    const [gone, running, groupless] = ['gone', 'running', 'groupless'].map(runDirectory) as [string, string, string]
    const untrack = [trackRun({ dir: gone, pid: 4242 }), trackRun({ dir: running, pid: 4343 }), trackRun({ dir: groupless })]
    expect(listening()).toBe(1)
    stopLiveRuns()
    expect(kill.mock.calls).toEqual([[-4242, 'SIGKILL'], [-4343, 'SIGKILL']])
    expect([gone, running, groupless].map(dir => existsSync(dir))).toEqual([false, false, false])
    // A directory that is gone already is no error.
    expect(() => stopLiveRuns()).not.toThrow()
    for (const forget of untrack) forget()
  })

  it('listens once while any run is live, and no more once the last has closed', () => {
    expect(listening()).toBe(0)
    const first = trackRun({ dir: join(base, 'first') })
    const second = trackRun({ dir: join(base, 'second'), pid: 4242 })
    expect(listening()).toBe(1)
    first()
    expect(listening()).toBe(1)
    second()
    second()
    expect(listening()).toBe(0)
    trackRun({ dir: join(base, 'third') })()
    expect(listening()).toBe(0)
    const again = trackRun({ dir: join(base, 'fourth') })
    expect(listening()).toBe(1)
    again()
  })
})

describe('claudeCode', () => {
  const request: CompletionRequest = { system: 'instructions', messages: [{ role: 'user', content: 'data' }], output: { name: 'panel_vote', schema: { type: 'object' } } }
  let dir = ''
  let runs = ''
  let claude = ''
  let missing = ''

  /** A fake `claude` of its own, so the version check of one command is not another test's. */
  const claudeIn = (name: string): string => {
    mkdirSync(join(dir, name))
    return writeFakeClaude(join(dir, name))
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'quorum-cc-spec-'))
    runs = join(dir, 'runs')
    mkdirSync(runs)
    claude = writeFakeClaude(dir)
    missing = join(dir, 'missing')
  })
  // The run directories go under the spec's own directory, so each test sees them go.
  beforeEach(() => {
    vi.stubEnv('TMPDIR', runs)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses its options when it is called, before any request', () => {
    expect(() => claudeCode({ ...options, auth: 'bearer' as never })).toThrow(ConfigError)
    expect(() => claudeCode({ ...options, auth: 'bearer' as never })).toThrow('cc.auth: must be inherit, login or api-key')
  })

  it.each<[ChatMessage[]]>([
    [[]],
    [[{ role: 'assistant', content: 'x' }]],
    [[{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]],
  ])('takes only a request of one user message, not %j', async (messages) => {
    await expect(claudeCode({ ...options, command: missing }).complete({ ...request, messages })).rejects.toMatchObject({ kind: 'unsupported', message: 'cc: takes a request of exactly one user message' })
  })

  it('refuses a message that would run as a Claude Code command, before starting claude', async () => {
    await expect(claudeCode({ ...options, command: missing }).complete({ ...request, messages: [{ role: 'user', content: '  /model opus' }] })).rejects.toMatchObject({ kind: 'unsupported', message: 'cc: a message that starts with / would run as a Claude Code command' })
  })

  it('refuses a message over the 10000000 bytes Claude Code reads on stdin, before starting claude', async () => {
    const huge = { ...request, messages: [{ role: 'user' as const, content: 'a'.repeat(10_000_001) }] }
    await expect(claudeCode({ ...options, contextTokens: 999_999_999, command: missing }).complete(huge)).rejects.toMatchObject({ kind: 'too-large', message: 'cc: the message is 10000001 bytes, more than the 10000000 Claude Code reads on stdin' })
  })

  it('refuses a request that may not fit contextTokens, keeping 4096 tokens for what Claude Code adds', async () => {
    await expect(claudeCode({ ...options, contextTokens: 20128, command: missing }).complete(request)).rejects.toMatchObject({
      kind: 'too-large',
      message: 'cc: may need 20129 tokens, more than contextTokens (20128): 33 for its text at one token per byte, 4096 for the chat template and 16000 for the reply',
    })
  })

  it('rejects as aborted, and starts nothing, when the signal has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(claudeCode({ ...options, command: missing }).complete({ ...request, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', message: 'cc: request aborted' })
    expect(readdirSync(runs)).toEqual([])
  })

  it('reports a command that cannot start, and leaves no directory', async () => {
    await expect(claudeCode({ ...options, command: missing, env: {} }).complete(request)).rejects.toMatchObject({ kind: 'process', message: 'cc: could not start the claude CLI (ENOENT)' })
    expect(readdirSync(runs)).toEqual([])
  })

  it('makes the run directory at an absolute path, though TMPDIR is relative', async () => {
    vi.stubEnv('TMPDIR', relative(process.cwd(), runs))
    const run = await prepareRun('instructions', replyFailure('cc'))
    try {
      expect(run.dir).toBe(join(runs, basename(run.dir)))
      expect([run.cwd, run.tmp, run.systemFile].every(path => isAbsolute(path))).toBe(true)
    } finally {
      rmSync(run.dir, { recursive: true, force: true })
    }
  })

  it('runs claude in a fresh empty directory with the message on stdin and the system text in a file, then removes it all', async () => {
    const env = fakeClaudeEnv(dir, 'round', fixtures.schema, { CLAUDE_CODE_MESSAGING_TOKEN: 'parent-secret', HOME: '/home/u', FAKE_CLAUDE_GRANDCHILD: '1' })
    const provider = claudeCode({ id: 'cc', model: 'haiku', contextTokens: 200000, command: claude, env })
    expect(await provider.complete(request)).toEqual({ text: '{"keep":true}', model: 'claude-haiku-5-5', usage: { inputTokens: 2662, outputTokens: 225, costUsd: 0.000525 } })
    const record = readFakeRecord(dir, 'round')
    const run = join(runs, basename(dirname(record.cwd)))
    expect(basename(run)).toMatch(/^quorum-claude-/)
    expect(record.cwd).toBe(join(realpathSync(runs), basename(run), 'cwd'))
    expect(record.cwdEntries).toEqual([])
    expect(record.stdin).toBe('data')
    expect(record.systemPrompt).toBe('instructions')
    expect(record.argv).toEqual(claudeArgs({ model: 'haiku', auth: 'inherit', structuredOutput: 'schema', args: [] }, join(run, 'system.txt'), { type: 'object' }))
    expect(record.env).toMatchObject({ HOME: '/home/u', CLAUDE_CODE_TMPDIR: join(run, 'tmp'), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_COMPACT: '1' })
    expect(record.env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined()
    expect(record.tmpExists).toBe(true)
    expect(record.env).toMatchObject({ CLAUDE_CODE_DISABLE_ATTACHMENTS: '1', CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1' })
    // The first request on this command checks the version first, with the request's environment and an empty directory.
    expect(readFakeVersionRecords(dir, 'round')).toEqual([{ argv: ['--version'], env: record.env, cwd: record.cwd, cwdEntries: [], pid: expect.any(Number) }])
    if (process.platform !== 'win32') expect([record.runMode, record.systemMode]).toEqual([0o700, 0o600])
    // The fake exited while its grandchild still held the pipes: the call did not wait, and the group is gone.
    await vi.waitFor(() => expect(isRunning(record.grandchild as number)).toBe(false), { timeout: 2000 })
    expect(readdirSync(runs)).toEqual([])
  })

  it('runs api-key mode bare with its key, and reports an exit without JSON by its stderr, redacted of every credential it holds', async () => {
    const env = fakeClaudeEnv(dir, 'bare', '', { FAKE_CLAUDE_STDERR: 'error: key sk-SECRET refused, login oauth-SECRET', FAKE_CLAUDE_EXIT: '2', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-SECRET' })
    const provider = claudeCode({ id: 'cc', model: 'haiku', contextTokens: 200000, auth: 'api-key', apiKey: 'sk-SECRET', command: claude, env })
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'process', status: 2, message: 'cc: claude exited 2: "error: key [redacted] refused, login [redacted]"' })
    const record = readFakeRecord(dir, 'bare')
    expect(record.argv).toContain('--bare')
    expect(record.env.ANTHROPIC_API_KEY).toBe('sk-SECRET')
    expect(record.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    // The round trip above checked this command's version already: it is checked once per command.
    expect(readFakeVersionRecords(dir, 'bare')).toEqual([])
    expect(readdirSync(runs)).toEqual([])
  })

  it('settles two seconds after claude exits though a process outside its group holds the pipes, and stops a stdout past 16 MiB', async () => {
    const env = fakeClaudeEnv(dir, 'detached', 'a'.repeat(MAX_STDOUT_BYTES + 1), { FAKE_CLAUDE_GRANDCHILD: 'detached' })
    const started = Date.now()
    let helper: number | undefined
    try {
      await expect(claudeCode({ ...options, command: claude, env }).complete(request)).rejects.toMatchObject({ kind: 'invalid-response', message: 'cc: reply is over 16 MiB' })
      const elapsed = Date.now() - started
      helper = readFakeRecord(dir, 'detached').grandchild
      // The grace runs from the exit; the helper would hold the pipes for 20 seconds.
      expect(elapsed).toBeGreaterThanOrEqual(KILL_GRACE_MS - 100)
      expect(elapsed).toBeLessThan(KILL_GRACE_MS + 5000)
      expect(isRunning(helper as number)).toBe(true)
      expect(readdirSync(runs)).toEqual([])
    } finally {
      // Out of the group, it is beyond quorum's reach: the spec ends it.
      helper ??= existsSync(join(dir, 'detached.record.json')) ? readFakeRecord(dir, 'detached').grandchild : undefined
      if (helper !== undefined && isRunning(helper)) process.kill(helper, 'SIGKILL')
    }
  }, 15_000)

  it('refuses a claude older than 2.1.311 before it starts the request, checks again when another request\'s abort cut the check short, and lets a request that waits abort on its own signal', async () => {
    const env = fakeClaudeEnv(dir, 'old', fixtures.schema, { FAKE_CLAUDE_VERSION: '2.1.310 (Claude Code)', FAKE_CLAUDE_VERSION_DELAY_MS: '800' })
    const provider = claudeCode({ ...options, command: claudeIn('old'), env })
    const cancelled = new AbortController()
    const impatient = new AbortController()
    const first = provider.complete({ ...request, signal: cancelled.signal })
    await vi.waitFor(() => expect(readFakeVersionRecords(dir, 'old')).toHaveLength(1), { timeout: 5000 })
    // The other two wait for the check the first one started.
    const second = provider.complete(request)
    const third = provider.complete({ ...request, signal: impatient.signal })
    await new Promise(resolve => setTimeout(resolve, 100))
    impatient.abort()
    // The one that waits aborts on its own signal, and the check it waited for runs on.
    await expect(third).rejects.toMatchObject({ kind: 'aborted', message: 'cc: request aborted' })
    expect(isRunning((readFakeVersionRecords(dir, 'old')[0] as { pid: number }).pid)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 100))
    cancelled.abort()
    await expect(first).rejects.toMatchObject({ kind: 'aborted', message: 'cc: request aborted' })
    await expect(second).rejects.toMatchObject({ kind: 'process', message: 'cc: Claude Code 2.1.311 or newer is required, found 2.1.310' })
    expect(readFakeVersionRecords(dir, 'old')).toHaveLength(2)
    expect(existsSync(join(dir, 'old.record.json'))).toBe(false)
    expect(readdirSync(runs)).toEqual([])
  })

  it('stops a claude --version that never answers at its deadline as an abort stops it, removes the directory and fails closed', async () => {
    expect(VERSION_CHECK_MS).toBe(10_000)
    // The deadline is held to 0.4 s here, and then until the fake has recorded its start, so the check it
    // stops is running: on a loaded machine, Node can take longer than that to start. Every other timer
    // keeps its delay.
    const realSetTimeout = globalThis.setTimeout
    const began = Date.now()
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      if (ms !== VERSION_CHECK_MS) return realSetTimeout(handler, ms)
      // The record is read while the fake may still be writing it: a line that does not parse yet is no start.
      const started = (): boolean => {
        try {
          return readFakeVersionRecords(dir, 'silent').length > 0
        } catch {
          return false
        }
      }
      const fire = (): void => {
        if (started() || Date.now() - began > 5000) handler()
        else realSetTimeout(fire, 50)
      }
      return realSetTimeout(fire, 400)
    }) as typeof setTimeout)
    const env = fakeClaudeEnv(dir, 'silent', fixtures.schema, { FAKE_CLAUDE_VERSION_DELAY_MS: '60000' })
    try {
      await expect(claudeCode({ ...options, command: claudeIn('silent'), env }).complete(request)).rejects.toMatchObject({ kind: 'process', message: 'cc: claude --version did not answer within 10 s' })
      expect(timers.mock.calls.filter(([, ms]) => ms === VERSION_CHECK_MS)).toHaveLength(1)
    } finally {
      timers.mockRestore()
    }
    const [check, ...more] = readFakeVersionRecords(dir, 'silent')
    expect(more).toEqual([])
    expect(isRunning((check as { pid: number }).pid)).toBe(false)
    expect(existsSync(join(dir, 'silent.record.json'))).toBe(false)
    expect(readdirSync(runs)).toEqual([])
  }, 15_000)

  it('refuses a claude whose version it cannot read, quoting nothing of what it printed, before it starts the request', async () => {
    const env = fakeClaudeEnv(dir, 'garbled', fixtures.schema, { FAKE_CLAUDE_VERSION: 'sk-SECRET' })
    await expect(claudeCode({ ...options, command: claudeIn('garbled'), env }).complete(request)).rejects.toMatchObject({ kind: 'process', message: 'cc: Claude Code 2.1.311 or newer is required, found an unknown version' })
    expect(readFakeVersionRecords(dir, 'garbled')).toHaveLength(1)
    expect(existsSync(join(dir, 'garbled.record.json'))).toBe(false)
    expect(readdirSync(runs)).toEqual([])
  })

  it('stops claude and what it started with SIGTERM when the request aborts, waits for them, removes its directory and rejects as aborted, and a quorum that exits meanwhile would SIGKILL its group and remove its directory', async () => {
    const controller = new AbortController()
    const env = fakeClaudeEnv(dir, 'term', fixtures.schema, { FAKE_CLAUDE_HANG: '1', FAKE_CLAUDE_GRANDCHILD: '1' })
    const call = claudeCode({ ...options, command: claude, env }).complete({ ...request, signal: controller.signal })
    // A failed assertion below must not leave the call, or the fake it started, running.
    call.catch(() => {})
    let pid = 0
    let grandchild = 0
    try {
      await vi.waitFor(() => expect(existsSync(join(dir, 'term.record.json'))).toBe(true), { timeout: 5000 })
      ;({ pid, grandchild } = readFakeRecord(dir, 'term') as { pid: number, grandchild: number })
      expect(isRunning(grandchild)).toBe(true)
      // The listener quorum registers for its exit, with the kill held back, finds this run's group and directory.
      expect(process.listeners('exit')).toContain(stopLiveRuns)
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      stopLiveRuns()
      const killed = [...kill.mock.calls]
      kill.mockRestore()
      expect(killed).toEqual([[-pid, 'SIGKILL']])
      expect(readdirSync(runs)).toEqual([])
    } finally {
      controller.abort()
    }
    await expect(call).rejects.toMatchObject({ kind: 'aborted', message: 'cc: request aborted' })
    expect(isRunning(pid)).toBe(false)
    await vi.waitFor(() => expect(isRunning(grandchild)).toBe(false), { timeout: 2000 })
    expect(readdirSync(runs)).toEqual([])
    expect(process.listeners('exit')).not.toContain(stopLiveRuns)
  })

  it('kills claude with SIGKILL when it still runs two seconds after SIGTERM', async () => {
    const controller = new AbortController()
    const env = fakeClaudeEnv(dir, 'kill', fixtures.schema, { FAKE_CLAUDE_HANG: '1', FAKE_CLAUDE_IGNORE_TERM: '1' })
    const call = claudeCode({ ...options, command: claude, env }).complete({ ...request, signal: controller.signal })
    call.catch(() => {})
    let pid = 0
    let aborted = 0
    try {
      await vi.waitFor(() => expect(existsSync(join(dir, 'kill.record.json'))).toBe(true), { timeout: 5000 })
      ;({ pid } = readFakeRecord(dir, 'kill'))
    } finally {
      aborted = Date.now()
      controller.abort()
    }
    await expect(call).rejects.toMatchObject({ kind: 'aborted' })
    expect(Date.now() - aborted).toBeGreaterThanOrEqual(KILL_GRACE_MS - 100)
    expect(isRunning(pid)).toBe(false)
    expect(readdirSync(runs)).toEqual([])
  }, 15_000)
})
