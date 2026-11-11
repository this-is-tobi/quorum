import { describe, expect, it } from 'vitest'
import { ProviderError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import * as fixtures from '../testing/fixtures/claude-code.ts'
import { childEnv, claudeArgs, claudeCodeIssues, readResult } from './claude-code.ts'
import type { ClaudeCodeOptions } from './claude-code.ts'
import { CONTEXT_REQUIRED } from './options.ts'

const options: ClaudeCodeOptions = { id: 'cc', model: 'sonnet', contextTokens: 200000 }
const ISOLATED = ['--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']

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
})

describe('childEnv', () => {
  const KEPT = { PATH: '/usr/bin', HOME: '/home/u', HTTPS_PROXY: 'http://proxy:3128', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }
  const CREDENTIALS = {
    ANTHROPIC_API_KEY: 'sk-env',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'https://gw.example',
    ANTHROPIC_PROFILE: 'work',
    ANTHROPIC_FEDERATION_RULE_ID: 'r',
    ANTHROPIC_ORGANIZATION_ID: 'o',
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
  const env = { ...KEPT, ...CREDENTIALS, ...SESSION, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', DISABLE_COMPACT: '0', CLAUDE_CODE_TMPDIR: '/elsewhere', UNSET: undefined }
  const ISOLATION = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_COMPACT: '1', CLAUDE_CODE_TMPDIR: '/run/tmp' }

  it('passes the environment through under inherit, without the parent session\'s variables, and with the isolation set', () => {
    expect(childEnv(env, 'inherit', undefined, '/run/tmp')).toEqual({ ...KEPT, ...CREDENTIALS, ...ISOLATION })
  })

  it('removes every credential and endpoint variable under login, so the Claude Code login answers', () => {
    expect(childEnv(env, 'login', undefined, '/run/tmp')).toEqual({ ...KEPT, ...ISOLATION })
  })

  it('removes the same variables under api-key, then sets its key', () => {
    expect(childEnv(env, 'api-key', 'sk-mine', '/run/tmp')).toEqual({ ...KEPT, ...ISOLATION, ANTHROPIC_API_KEY: 'sk-mine' })
  })

  it('keeps the environment\'s ANTHROPIC_API_KEY under api-key when it is given no key', () => {
    expect(childEnv(env, 'api-key', undefined, '/run/tmp')).toEqual({ ...KEPT, ...ISOLATION, ANTHROPIC_API_KEY: 'sk-env' })
  })

  it('reads only the environment\'s own variables', () => {
    expect(childEnv(Object.create({ ANTHROPIC_API_KEY: 'inherited' }) as Record<string, string>, 'inherit', undefined, '/t')).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_COMPACT: '1', CLAUDE_CODE_TMPDIR: '/t' })
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

  it('takes the defaults, every auth mode and every allowlisted flag', () => {
    expect(issuesOf({})).toEqual([])
    expect(issuesOf({ auth: 'login', command: 'claude' })).toEqual([])
    expect(issuesOf({ auth: 'api-key', apiKey: 'sk-k', structuredOutput: 'prompt', args: ['--effort', 'max', '--fallback-model=haiku', '--max-budget-usd', '0.50', '--betas', 'context-1m'], command: '/opt/claude/bin/claude' })).toEqual([])
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
    [{ args: ['--max-budget-usd', '0'] }, [at('args.1', 'must be a positive number of dollars, such as 0.50')]],
    [{ args: ['--fallback-model', '--tools'] }, [at('args.1', 'must be visible ASCII characters that do not start with -')]],
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

  it('reports a non-zero exit without JSON by its stderr, redacted', () => {
    expect(failure(() => read('', { code: 2, stderr: 'error: unknown option for sk-SECRET\n', redact: ['sk-SECRET'] }))).toMatchObject({ kind: 'process', status: 2, message: 'cc: claude exited 2: "error: unknown option for [redacted]\\n"' })
  })

  it('reports a stop by a signal, and an exit 0 without JSON', () => {
    expect(failure(() => read('', { code: null, signal: 'SIGKILL' }))).toMatchObject({ kind: 'process', message: 'cc: claude was stopped by SIGKILL' })
    expect(failure(() => read('not json'))).toMatchObject({ kind: 'invalid-response', message: 'cc: claude printed no JSON result' })
  })

  it('sums the usage of several models, and names the configured model then', () => {
    const two = `${JSON.stringify({ ...JSON.parse(fixtures.schema), modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }, b: { inputTokens: 10, outputTokens: 20 } } })}\n`
    expect(read(two)).toEqual({ text: '{"keep":true}', model: 'sonnet', usage: { inputTokens: 18, outputTokens: 22, costUsd: 0.000525 } })
  })
})
