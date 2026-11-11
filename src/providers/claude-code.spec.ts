import { describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import * as fixtures from '../testing/fixtures/claude-code.ts'
import { childEnv, claudeArgs, claudeCodeIssues, readResult } from './claude-code.ts'
import type { ClaudeCodeOptions } from './claude-code.ts'
import { CONTEXT_REQUIRED } from './options.ts'

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
    UNSET: undefined,
  }
  const ISOLATION = {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_COMPACT: '1',
    CLAUDE_CODE_TMPDIR: '/run/tmp',
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  }

  it('passes the environment through under inherit, without the parent session\'s variables or what loads or adds, and with the isolation set, the connectors off', () => {
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
    }
    expect(childEnv(mixed, 'login', undefined, '/run/tmp')).toEqual({ PATH: '/usr/bin', ...ISOLATION })
    expect(childEnv(mixed, 'api-key', undefined, '/run/tmp')).toEqual({ PATH: '/usr/bin', ...ISOLATION, ANTHROPIC_API_KEY: 'sk-win' })
    expect(childEnv(mixed, 'inherit', undefined, '/run/tmp')).toEqual({ PATH: '/usr/bin', Anthropic_Api_Key: 'sk-win', claude_code_use_bedrock: '1', Anthropic_Custom_Headers: 'X: y', ...ISOLATION })
  })

  it('reads only the environment\'s own variables', () => {
    expect(childEnv(Object.create({ ANTHROPIC_API_KEY: 'inherited' }) as Record<string, string>, 'inherit', undefined, '/t')).toEqual({ ...ISOLATION, CLAUDE_CODE_TMPDIR: '/t' })
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
