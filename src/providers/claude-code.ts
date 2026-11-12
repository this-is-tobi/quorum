import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue, ProviderError } from '../core/errors.ts'
import type { ChatMessage, CompletionRequest, CompletionResponse, JsonSchema, Provider } from '../core/ports.ts'
import type { Usage } from '../core/types.ts'
import { snippet } from './http.ts'
import { contextTokensIssues, isRecord, NOT_VISIBLE_ASCII, wordList } from './options.ts'
import { replyFailure, tokenUsage } from './reply.ts'
import { checkFits, contextBudget, utf8Length } from './size.ts'

/**
 * The `claude-code` adapter runs the user's installed `claude` CLI once per request, headless and isolated,
 * as a pure completion: no tool but the schema tool, no settings file, MCP server, slash command or
 * session from the user's or the project's setup, the system text in a file, the message on stdin, and no
 * credential on the command line. It requires Claude Code `MIN_CLAUDE_CODE_VERSION` or newer, checked with
 * `claude --version` before the first request: the isolation rests on environment variables that an older
 * CLI ignores, and one it ignores would run with less isolation, a file mention among them.
 *
 * The first half is pure: the options and their checks, the command line, the child's environment and the
 * reading of the JSON result, each testable without a process. The second, `claudeCode`, runs the child:
 * a directory per request, the spawn, stdin, the output caps, abort and cleanup.
 */

/** The tokens kept around a request for the context Claude Code adds itself: 953 for a one-line prompt and 1463 with the schema tool's second turn, measured live. */
export const CLAUDE_CODE_TEMPLATE_TOKENS = 4096
/** The most bytes of a request sent to `claude` on stdin: 10 000 000, the smaller reading of 10 MB. */
export const MAX_STDIN_BYTES = 10_000_000
/** The milliseconds `claude` has to exit after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 2000
/** The oldest Claude Code the isolation was checked with, and so the oldest a run accepts: its variables are unknown to an older one. */
export const MIN_CLAUDE_CODE_VERSION = '2.1.311'
/** The milliseconds `claude --version` has to answer: past them it is stopped as an abort stops a run, and the check fails. */
export const VERSION_CHECK_MS = 10_000

/**
 * Whose credentials `claude` uses: the environment's, as it is (`inherit`); the Claude Code login alone
 * (`login`); or an API key handed to it through the environment, with `--bare` (`api-key`).
 */
export type ClaudeCodeAuth = 'inherit' | 'login' | 'api-key'

/** How the reply shape reaches `claude`: described in the prompt only, or as a JSON schema it enforces with its schema tool. */
type ClaudeCodeStructuredOutput = 'prompt' | 'schema'

/** The options of a `claude-code` provider. */
export interface ClaudeCodeOptions {
  /** Names the provider in events, `meta` and its error messages. */
  id: string
  /** An alias or a model id `claude --model` takes: visible ASCII that does not start with `-`. */
  model: string
  /**
   * The model's context window in tokens, prompt and reply together. Required: every request is checked
   * against it and refused, before it is run, when it may not fit. It must be more than 20096, the reply
   * budget and the reserve for what Claude Code adds.
   */
  contextTokens: number
  /** Whose credentials `claude` uses. Default `inherit`. */
  auth?: ClaudeCodeAuth
  /**
   * The API key of `api-key` mode, handed to `claude` in its environment and nowhere else. Without one,
   * `api-key` mode keeps the environment's own `ANTHROPIC_API_KEY`. Refused under any other mode.
   */
  apiKey?: string
  /** `schema` has `claude` enforce the reply schema; `prompt` leaves it to the prompt. Default `schema`. */
  structuredOutput?: ClaudeCodeStructuredOutput
  /**
   * Flags passed to `claude`, each followed by its value or written `--flag=value`, each at most once:
   * `--effort` (`low`, `medium`, `high`, `xhigh` or `max`), `--fallback-model`, `--max-budget-usd` and
   * `--betas` (`api-key` mode only). Any other element is refused, so no option loosens the isolation.
   * Default none.
   */
  args?: readonly string[]
  /** The executable: an absolute path, or a name `spawn` finds on `PATH`. Never run through a shell. Default `claude`. */
  command?: string
  /** The environment `claude` inherits, less what its auth mode removes. Read once, when the provider is made. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
}

/** The command-line settings of a run. */
export interface ClaudeArgsSettings {
  readonly model: string
  readonly auth: ClaudeCodeAuth
  readonly structuredOutput: ClaudeCodeStructuredOutput
  readonly args: readonly string[]
}

/** What a finished `claude` process left: its stdout and stderr as text, its exit code and the signal that ended it. */
export interface ClaudeRun {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly signal: string | null
}

/** What the reading of a result needs to know of its provider. */
interface ResultContext {
  readonly id: string
  readonly model: string
  readonly structuredOutput: ClaudeCodeStructuredOutput
  /** Values redacted from any quoted text: the key. */
  readonly redact: readonly string[]
}

const AUTH_MODES: readonly ClaudeCodeAuth[] = ['inherit', 'login', 'api-key']
const STRUCTURED_OUTPUTS: readonly ClaudeCodeStructuredOutput[] = ['prompt', 'schema']
/** The fields of a provider that belong to an HTTP endpoint, none of which a CLI has. */
const HTTP_FIELDS = ['baseUrl', 'headers', 'query', 'extraBody', 'temperature', 'maxTokens', 'systemPrompt'] as const
const WINDOWS_SCRIPT = /\.(?:cmd|bat)$/i
const PATH_SEPARATOR = /[/\\]/

/**
 * The flags of the isolation, in their order: no tool (`--tools ''` leaves the schema tool alone), no
 * settings source, only the MCP servers named on the command line (none), no session on disk and no slash
 * command. Nothing configures or drops one. The two empty values keep their two-argument form, which is
 * the one verified live.
 */
const ISOLATION_FLAGS: readonly string[] = ['--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']

/** The variables of a parent Claude Code session, which a nested run must not inherit: its messaging channel and its entry point. */
const SESSION_VARIABLES: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_CODE_STARTUP_FAILURE_RESULTS',
])
/**
 * The variables that load or enable what the isolation flags turn off, or add to the request body, removed
 * in every mode, since no flag governs them: plugin directories, which load a plugin and its hooks the way
 * `--plugin-dir` does, the plugin roots and seeds, the syncs of plugins and skills, a launcher for the
 * processes `claude` starts, the Chrome integration, the task and agent-team tools, the PowerShell tool,
 * a JSON object merged into every request body and the persistence of a session that
 * `--no-session-persistence` turns off. Claude Code's own settings keep the launcher, sync and plugin root
 * variables from a checked-out repository for the same reason.
 */
const CAPABILITY_VARIABLES: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_PLUGIN_DIRS',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_SYNC_PLUGINS',
  'CLAUDE_CODE_SYNC_SKILLS',
  'CLAUDE_CODE_PROCESS_WRAPPER',
  'CLAUDE_CODE_ENABLE_CFC',
  'CLAUDE_CODE_ENABLE_TODO_TOOLS',
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE',
])
/**
 * The credential, header and endpoint variables `login` and `api-key` remove, besides every one that starts
 * with `CLAUDE_CODE_USE_`. `ANTHROPIC_CUSTOM_HEADERS` is one since a header can carry another credential,
 * and `ANTHROPIC_UNIX_SOCKET` since it sends every request through a local socket, as a base URL would.
 */
const CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_UNIX_SOCKET',
])
/**
 * The variables whose values no quoted text may repeat, whichever the mode keeps in the child's environment:
 * the credentials `login` and `api-key` remove, the Claude Code login's own token and its refresh token, the
 * passphrase of a client key, and the bearer tokens, keys and session tokens of the cloud providers. A text
 * that comes back from `claude` can echo any of them.
 */
const REDACTED_VARIABLES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
])
const CLOUD_PROVIDER_PREFIX = 'CLAUDE_CODE_USE_'
const KEY_VARIABLE = 'ANTHROPIC_API_KEY'

/** The prefix of a run's directory under the system's temporary directory. */
const RUN_DIRECTORY_PREFIX = 'quorum-claude-'
/** The most bytes of stdout read: a result over this is refused, and 16 MiB is as much as an HTTP adapter reads of a reply. */
export const MAX_STDOUT_BYTES = 16 * 1024 * 1024
/** The most bytes of stderr kept: far more than the 500 characters an error message quotes. */
export const MAX_STDERR_BYTES = 64 * 1024
/** A code of a system error as a message writes it: `ENOENT`, `ERR_INVALID_ARG_VALUE`. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,39}$/

/** The failures of one provider, as `replyFailure` builds them. */
type Failure = ReturnType<typeof replyFailure>

const REASON = /^[a-z_]{1,64}$/
const SIGNAL = /^SIG[A-Z0-9]{1,12}$/
/** The most characters of a result's text that an error message quotes. */
const MAX_RESULT_TEXT = 200
/** The most characters of stderr that an error message quotes. */
const MAX_STDERR_TEXT = 500

/** The flags `args` may hold, and the checks of their values. */
const ALLOWED_FLAGS = ['--effort', '--fallback-model', '--max-budget-usd', '--betas'] as const
type AllowedFlag = typeof ALLOWED_FLAGS[number]
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** The most characters of a `--max-budget-usd` value: a decimal that long is finite. */
const MAX_BUDGET_CHARACTERS = 12
const NOT_A_STRING = 'must be a string'
const NOT_A_FLAG = `is not a flag quorum passes to claude: use ${wordList(ALLOWED_FLAGS)}`
const PLAIN_VALUE = 'must be visible ASCII characters that do not start with -'
const VALUE_PROBLEMS: Record<AllowedFlag, (value: string) => string | undefined> = {
  '--effort': value => EFFORTS.includes(value) ? undefined : `must be ${wordList(EFFORTS)}`,
  '--max-budget-usd': value => value.length <= MAX_BUDGET_CHARACTERS && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 ? undefined : 'must be a positive number of dollars, such as 0.50',
  '--fallback-model': value => plainValue(value) ? undefined : PLAIN_VALUE,
  '--betas': value => plainValue(value) ? undefined : PLAIN_VALUE,
}

function plainValue(value: string): boolean {
  return value !== '' && !NOT_VISIBLE_ASCII.test(value) && !value.startsWith('-')
}

/** The message refusing `command` as the executable, or undefined when it may be run. */
export function commandProblem(command: string): string | undefined {
  if (typeof command !== 'string' || command === '') return 'must name an executable'
  if (WINDOWS_SCRIPT.test(command)) return 'is a Windows script, which runs only through a shell: name claude.exe instead'
  if (!isAbsolute(command) && PATH_SEPARATOR.test(command)) return 'must be an absolute path, or a name to find on PATH'
  return undefined
}

/** A problem of one element of `args`, at its index. */
interface ArgsProblem {
  readonly index: number
  readonly message: string
}

/** What a walk of `args` found: the flags it accepts with their values, in order, and the problems of the rest. */
interface ArgsWalk {
  readonly pairs: ReadonlyArray<readonly [AllowedFlag, string]>
  readonly problems: readonly ArgsProblem[]
}

/**
 * Walk `args` once: an element that equals an allowlisted flag takes the next one as its value, one that
 * starts with `<flag>=` holds its value, any other is refused and the walk goes on with the next. An
 * element, or a value, that is no string (a hole of a sparse list too) is refused at its index. A pair is
 * kept only when its flag is not a repeat, `--betas` has `api-key` auth and the value passes its check,
 * so what `pairs` holds is safe to pass whatever the problems are.
 */
function walkArgs(args: readonly unknown[], auth: unknown): ArgsWalk {
  const pairs: Array<readonly [AllowedFlag, string]> = []
  const problems: ArgsProblem[] = []
  const seen = new Set<AllowedFlag>()
  let valueIndex = -1
  for (const [index, element] of args.entries()) {
    if (index === valueIndex) continue
    if (typeof element !== 'string') {
      problems.push({ index, message: NOT_A_STRING })
      continue
    }
    const flag = ALLOWED_FLAGS.find(name => element === name || element.startsWith(`${name}=`))
    if (flag === undefined) {
      problems.push({ index, message: NOT_A_FLAG })
      continue
    }
    const separate = element === flag
    if (separate && index + 1 >= args.length) {
      problems.push({ index, message: 'needs a value' })
      continue
    }
    const value = separate ? args[index + 1] : element.slice(flag.length + 1)
    if (separate) valueIndex = index + 1
    if (typeof value !== 'string') {
      problems.push({ index: index + 1, message: NOT_A_STRING })
      continue
    }
    const flagProblem = seen.has(flag) ? 'repeats a flag' : flag === '--betas' && auth !== 'api-key' ? 'is only for auth: api-key' : undefined
    seen.add(flag)
    const valueProblem = flagProblem === undefined ? VALUE_PROBLEMS[flag](value) : undefined
    if (flagProblem !== undefined) problems.push({ index, message: flagProblem })
    else if (valueProblem !== undefined) problems.push({ index: separate ? index + 1 : index, message: valueProblem })
    else pairs.push([flag, value])
  }
  return { pairs, problems }
}

/** The problems of `apiKey` given `auth`: set under another mode, where it would never be sent, or not visible ASCII. */
function apiKeyIssues(path: string, auth: unknown, apiKey: unknown): ConfigIssue[] {
  if (auth !== 'api-key') return typeof apiKey === 'string' && apiKey !== '' ? [{ path, message: 'is set, but auth is not api-key, so it would never be sent' }] : []
  if (apiKey === undefined || apiKey === '') return []
  return typeof apiKey === 'string' && !NOT_VISIBLE_ASCII.test(apiKey) ? [] : [{ path, message: 'must only contain visible ASCII characters' }]
}

/**
 * Every problem of the options, one issue per problem at `<id>.<field>`, in the order of the fields. No
 * message repeats a value: a key, a model id or an argument can be a secret.
 */
export function claudeCodeIssues(options: ClaudeCodeOptions): ConfigIssue[] {
  const { id, model, contextTokens, auth, apiKey, structuredOutput, args, command } = options
  const at = (field: string, message: string): ConfigIssue => ({ path: `${id}.${field}`, message })
  const given = options as unknown as Record<string, unknown>
  const issues: ConfigIssue[] = HTTP_FIELDS
    .filter(field => Object.hasOwn(given, field) && given[field] !== undefined)
    .map(field => at(field, 'is not an option of the claude-code protocol'))
  if (typeof model !== 'string' || !plainValue(model)) issues.push(at('model', 'must be a model id of visible ASCII characters, with no space, that does not start with -'))
  issues.push(...contextTokensIssues(id, contextTokens, undefined, CLAUDE_CODE_TEMPLATE_TOKENS))
  if (auth !== undefined && !AUTH_MODES.includes(auth)) issues.push(at('auth', `must be ${wordList(AUTH_MODES)}`))
  issues.push(...apiKeyIssues(`${id}.apiKey`, auth, apiKey))
  if (structuredOutput !== undefined && !STRUCTURED_OUTPUTS.includes(structuredOutput)) issues.push(at('structuredOutput', `must be ${wordList(STRUCTURED_OUTPUTS)}`))
  if (args !== undefined) {
    if (!Array.isArray(args)) issues.push(at('args', 'must be a list of strings'))
    else issues.push(...walkArgs(args, auth).problems.map(problem => at(`args.${problem.index}`, problem.message)))
  }
  if (command !== undefined) {
    const problem = commandProblem(command)
    if (problem !== undefined) issues.push(at('command', problem))
  }
  return issues
}

/**
 * The command line of one run, in this order: headless with a JSON result, the model, the system text's
 * file, the isolation flags, the reply schema in `schema` mode, `--bare` in `api-key` mode, then the
 * allowlisted `args`. Every value is written `--flag=value`, so none is read as a flag whatever it starts
 * with. `args` should have passed `claudeCodeIssues`; an element that did not is never passed.
 */
export function claudeArgs(settings: ClaudeArgsSettings, systemPromptFile: string, schema: JsonSchema): string[] {
  const { model, auth, structuredOutput, args } = settings
  return [
    '-p',
    '--output-format=json',
    `--model=${model}`,
    `--system-prompt-file=${systemPromptFile}`,
    ...ISOLATION_FLAGS,
    ...(structuredOutput === 'schema' ? [`--json-schema=${JSON.stringify(schema)}`] : []),
    ...(auth === 'api-key' ? ['--bare'] : []),
    ...walkArgs(args, auth).pairs.map(([flag, value]) => `${flag}=${value}`),
  ]
}

/** Whether `name`, in any letter case, is a variable removed from the child's environment, `auth` and the run's own variables given. */
function removedVariable(name: string, auth: ClaudeCodeAuth, runVariables: Readonly<Record<string, string>>): boolean {
  const upper = name.toUpperCase()
  if (SESSION_VARIABLES.has(upper) || CAPABILITY_VARIABLES.has(upper) || Object.hasOwn(runVariables, upper)) return true
  return auth !== 'inherit' && (CREDENTIAL_VARIABLES.has(upper) || upper.startsWith(CLOUD_PROVIDER_PREFIX))
}

/**
 * The environment of one run: the environment's own string entries, less the variables of a parent Claude
 * Code session, the ones that load or add what the isolation turns off and, under `login` and `api-key`,
 * every credential, header and endpoint variable, so a login or a key never reaches another host or travels
 * with another credential. Names are matched in any letter case, since Windows reads them so. Under
 * `api-key`, `ANTHROPIC_API_KEY` is then `apiKey` when it is a non-empty string, else the environment's
 * own, trimmed, when that is not blank. Last come ten variables the run sets over whatever the environment
 * held, in any case: no auto memory, no compaction of a long prompt, a temporary directory of its own, no
 * IDE connection or claude.ai MCP connector, which are on by default, and no attachment, file mention,
 * `CLAUDE.md` file, bundled skill or managed skill. A line naming a path (`@/path`) in the message makes
 * Claude Code attach that file for the model to read, with every tool off, unless the first two are set.
 */
export function childEnv(env: Readonly<Record<string, string | undefined>>, auth: ClaudeCodeAuth, apiKey: string | undefined, tmpDir: string): Record<string, string> {
  const isolation = {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_COMPACT: '1',
    CLAUDE_CODE_TMPDIR: tmpDir,
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
    CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
  }
  const own = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  const inheritedKey = (own.find(([name]) => name === KEY_VARIABLE) ?? own.find(([name]) => name.toUpperCase() === KEY_VARIABLE))?.[1].trim()
  const key = typeof apiKey === 'string' && apiKey !== '' ? apiKey : inheritedKey
  return {
    ...Object.fromEntries(own.filter(([name]) => !removedVariable(name, auth, isolation))),
    ...(auth === 'api-key' && key !== undefined && key !== '' ? { [KEY_VARIABLE]: key } : {}),
    ...isolation,
  }
}

/**
 * The values a quoted text must be redacted of: those of the credential variables of the environment a run
 * gets (`childEnv`'s result), each as written and trimmed, with names matched in any letter case. A value
 * that is blank once trimmed is left out, since redacting it would redact every run of spaces. Under
 * `api-key` the environment holds the run's own key.
 */
export function credentialValues(environment: Readonly<Record<string, string>>): string[] {
  const values = Object.entries(environment)
    .filter(([name]) => REDACTED_VARIABLES.has(name.toUpperCase()))
    .flatMap(([, value]) => [value, value.trim()])
  return [...new Set(values)].filter(value => value.trim() !== '')
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)/
/** A version an error message may quote: short plain numbers, so nothing else `claude` printed can come along. */
const QUOTABLE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const MIN_VERSION_PARTS = MIN_CLAUDE_CODE_VERSION.split('.').map(Number)

/** Whether a `[major, minor, patch]` is older than `MIN_CLAUDE_CODE_VERSION`. */
function isOlder(parts: readonly number[]): boolean {
  for (const [index, minimum] of MIN_VERSION_PARTS.entries()) {
    const part = parts[index] ?? 0
    if (part !== minimum) return part < minimum
  }
  return false
}

/**
 * The message refusing what `claude --version` printed, or undefined when it starts with a version of
 * `MIN_CLAUDE_CODE_VERSION` or newer (`2.1.311 (Claude Code)`). An older one and an output that starts with no
 * `<major>.<minor>.<patch>` are both refused. The message quotes the version only when it is plain numbers,
 * else it writes `an unknown version`: the output is the CLI's to write, never trusted.
 */
export function versionProblem(output: string): string | undefined {
  const digits = VERSION.exec(output.trim())?.slice(1)
  if (digits !== undefined && !isOlder(digits.map(Number))) return undefined
  const found = digits?.join('.')
  return `Claude Code ${MIN_CLAUDE_CODE_VERSION} or newer is required, found ${found !== undefined && QUOTABLE_VERSION.test(found) ? found : 'an unknown version'}`
}

/** The parsed result on `stdout`, or undefined when it holds no JSON object whose `type` is `result`. */
function parseResult(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    return isRecord(parsed) && parsed.type === 'result' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Whether `result` says Claude Code refused the prompt as too long for the model's context. */
function isPromptTooLong(result: Record<string, unknown>): boolean {
  if (result.terminal_reason === 'prompt_too_long') return true
  return result.is_error === true && typeof result.result === 'string' && result.result.startsWith('Prompt is too long')
}

/** What a failed result says, quoted: its `result` text, else its `errors` joined, else nothing. */
function failureDetail(result: Record<string, unknown>, redact: readonly string[]): string {
  const { errors } = result
  const text = typeof result.result === 'string'
    ? result.result
    : Array.isArray(errors) ? errors.filter((error): error is string => typeof error === 'string').join('; ') : ''
  return snippet(text, MAX_RESULT_TEXT, redact)
}

function isAboveZero(count: unknown): boolean {
  return typeof count === 'number' && count > 0
}

/** Whether the result counts a tool the server ran: a web search or fetch in `usage.server_tool_use`, or a web search in a model's usage. */
function ranServerTool(result: Record<string, unknown>, modelUsage: readonly Record<string, unknown>[]): boolean {
  const { usage } = result
  const serverTools = isRecord(usage) && isRecord(usage.server_tool_use) ? Object.values(usage.server_tool_use) : []
  return serverTools.some(isAboveZero) || modelUsage.some(entry => isAboveZero(entry.webSearchRequests))
}

/** The counts of a model's usage that make up its input: the prompt, then what the cache read and what it wrote. */
const MODEL_INPUT_KEYS = ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']

/**
 * The usage over every model that answered, since the result's own `usage` covers the last turn only (2
 * input tokens against 1199 in the schema run): the input is every prompt token, cached ones included, the
 * output every token generated. Undefined when no model reports both counts; the cost is `total` when it
 * is a number of at least 0.
 */
function sumUsage(modelUsage: readonly Record<string, unknown>[], total: unknown): Usage | undefined {
  const usages = modelUsage.flatMap(entry => tokenUsage(entry, MODEL_INPUT_KEYS, ['outputTokens']) ?? [])
  if (usages.length === 0) return undefined
  const usage: Usage = {
    inputTokens: usages.reduce((sum, each) => sum + each.inputTokens, 0),
    outputTokens: usages.reduce((sum, each) => sum + each.outputTokens, 0),
  }
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) usage.costUsd = total
  return usage
}

/** The text of a result: the structured output serialized in `schema` mode, `result` in `prompt` mode. */
function replyText(result: Record<string, unknown>, structuredOutput: ClaudeCodeStructuredOutput, fail: Failure): string {
  if (structuredOutput === 'schema') {
    if (!isRecord(result.structured_output)) throw fail('invalid-response', 'reply has no structured output')
    try {
      return JSON.stringify(result.structured_output)
    } catch {
      throw fail('invalid-response', 'reply structured output could not be serialized')
    }
  }
  if (typeof result.result !== 'string') throw fail('invalid-response', 'reply has no text')
  return result.result
}

/**
 * The failure of a result that reports an error: `http` with the status when `api_error_status` is one from
 * 400 to 599, so 429 and 5xx stay retryable, else `process` with the exit code, naming the reason when it
 * is a short word.
 */
function errorFailure(result: Record<string, unknown>, run: ClaudeRun, { id, redact }: ResultContext): ProviderError {
  const fail = replyFailure(id)
  const status = result.api_error_status
  const detail = failureDetail(result, redact)
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return fail('http', `HTTP ${status} from the model API: ${detail}`, status)
  const reason = result.subtype !== 'success' ? result.subtype : result.terminal_reason
  return fail('process', `claude failed${typeof reason === 'string' && REASON.test(reason) ? ` (${reason})` : ''}: ${detail}`, run.code ?? undefined)
}

/** The signal's name in a message when it is one, else a generic word: the signal is the child's to name, never trusted. */
function signalName(signal: string): string {
  return SIGNAL.test(signal) ? signal : 'a signal'
}

/**
 * The reply of a result, or the `ProviderError` it amounts to, in this order: a prompt too long, a
 * refusal, an error (anything but an `is_error` of `false` is one), a child a signal ended or a non-zero
 * exit after a success, a tool the server ran, a reply the token limit cut off, then the text. Claude Code
 * reports an API error as exit 1 with `subtype: "success"` and `is_error: true`, so the JSON on stdout is
 * read before the exit code.
 */
function readFinished(result: Record<string, unknown>, run: ClaudeRun, context: ResultContext): CompletionResponse {
  const fail = replyFailure(context.id)
  if (isPromptTooLong(result)) throw fail('too-large', 'Claude Code refused the prompt as too long for the model\'s context')
  if (result.stop_reason === 'refusal') throw fail('refusal', 'model refused')
  if (result.is_error !== false || result.subtype !== 'success') throw errorFailure(result, run, context)
  if (run.signal !== null) throw fail('process', `claude was stopped by ${signalName(run.signal)} after its result`)
  if (run.code !== null && run.code !== 0) throw fail('process', `claude exited ${run.code} after its result`, run.code)
  const modelUsage = isRecord(result.modelUsage) ? Object.values(result.modelUsage).filter(isRecord) : []
  if (ranServerTool(result, modelUsage)) throw fail('invalid-response', 'the server ran a tool for this reply, which quorum never allows')
  if (result.stop_reason === 'max_tokens') throw fail('truncated', 'reply was cut off by the token limit')
  const text = replyText(result, context.structuredOutput, fail)
  const usage = sumUsage(modelUsage, result.total_cost_usd)
  const models = isRecord(result.modelUsage) ? Object.keys(result.modelUsage) : []
  const model = models.length === 1 && models[0] !== undefined ? models[0] : context.model
  return usage === undefined ? { text, model } : { text, model, usage }
}

/**
 * Read what a finished `claude` left as a reply, or throw the `ProviderError` it amounts to. Without a
 * JSON result: a signal, a non-zero exit with a quote of stderr, or nothing at all, each a failure. Every
 * quoted text goes through `snippet`, redacted of the key.
 *
 * @throws ProviderError of the kind the failure is: `too-large`, `refusal`, `http`, `process` or `invalid-response`
 */
export function readResult(run: ClaudeRun, context: ResultContext): CompletionResponse {
  const result = parseResult(run.stdout)
  if (result !== undefined) return readFinished(result, run, context)
  const fail = replyFailure(context.id)
  if (run.signal !== null) throw fail('process', `claude was stopped by ${signalName(run.signal)}`)
  if (run.code !== null && run.code !== 0) throw fail('process', `claude exited ${run.code}: ${snippet(run.stderr, MAX_STDERR_TEXT, context.redact)}`, run.code)
  throw fail('invalid-response', 'claude printed no JSON result')
}

/** The directory of one run and what it holds. */
interface RunDirectory {
  /** The directory itself, which holds all the rest. */
  readonly dir: string
  /** The child's working directory: empty, so a checked-out repository's `CLAUDE.md` or settings are never in reach. */
  readonly cwd: string
  /** `CLAUDE_CODE_TMPDIR`: where `claude` keeps its scratch files. */
  readonly tmp: string
  /** The system text, which stays off the command line, where `ps` shows it to every user. */
  readonly systemFile: string
}

/** A run in flight: its directory, and the pid that leads its process group while `claude` lives, for `stopLiveRuns`. */
export interface LiveRun {
  readonly dir: string
  pid?: number
}

/** How to start `claude`: the executable, its arguments, its working directory and its whole environment, and the run it belongs to. */
interface Launch {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly live: LiveRun
}

/** What a run came to: the process's end, and whether its stdout went past the cap and was cut. */
interface Finished {
  readonly run: ClaudeRun
  readonly overflow: boolean
}

/** `error`'s system code as a message writes it, ` (ENOENT)`, or nothing when it has none or one that is no plain identifier. */
function codeSuffix(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined
  return typeof code === 'string' && ERROR_CODE.test(code) ? ` (${code})` : ''
}

/**
 * Remove a run's directory. A failure is ignored: the directory holds only the system text, and a reply
 * must not turn into an error because a file could not be removed.
 */
async function removeRun(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/**
 * Make the directory of one run, its working and scratch directories and the system text's file (mode 0600),
 * or remove what was made and fail. The directory is at an absolute path, though `TMPDIR` is relative: the
 * child resolves the path of the system text against a working directory of its own.
 */
export async function prepareRun(system: string, fail: Failure): Promise<RunDirectory> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(resolve(tmpdir()), RUN_DIRECTORY_PREFIX))
    const run = { dir, cwd: join(dir, 'cwd'), tmp: join(dir, 'tmp'), systemFile: join(dir, 'system.txt') }
    await mkdir(run.cwd)
    await mkdir(run.tmp)
    await writeFile(run.systemFile, system, { mode: 0o600 })
    return run
  } catch (error) {
    if (dir !== undefined) await removeRun(dir)
    throw fail('process', `could not prepare a directory for claude${codeSuffix(error)}`)
  }
}

/** The only message of a request, which must be a user message `claude` reads as text: not one `-p` would expand as a slash command, nor one over the stdin cap. */
function messageOf(request: CompletionRequest, fail: Failure): ChatMessage {
  const [message, ...rest] = request.messages
  if (message?.role !== 'user' || rest.length > 0) throw fail('unsupported', 'takes a request of exactly one user message')
  if (message.content.trimStart().startsWith('/')) throw fail('unsupported', 'a message that starts with / would run as a Claude Code command')
  const bytes = utf8Length(message.content)
  if (bytes > MAX_STDIN_BYTES) throw fail('too-large', `the message is ${bytes} bytes, more than the ${MAX_STDIN_BYTES} Claude Code reads on stdin`)
  return message
}

function throwIfAborted(signal: AbortSignal | undefined, fail: Failure): void {
  if (signal?.aborted) throw fail('aborted', 'request aborted')
}

/**
 * What a child's output pipe holds, up to `max` bytes. The rest is dropped but still read, so a full pipe
 * never stalls the child, and `onOverflow` runs once at the first byte over. A character cut at the cap
 * decodes as U+FFFD.
 *
 * Exported for the spec: the build strips it from the declarations, which would otherwise need Node's types
 * in every project that type-checks the package.
 *
 * @internal
 */
export function readCapped(stream: ChildProcess['stdout'], max: number, onOverflow: () => void = () => {}): { text: () => string, overflowed: () => boolean } {
  const chunks: Buffer[] = []
  let bytes = 0
  let overflow = false
  stream?.on('data', (chunk: Buffer) => {
    if (overflow) return
    const room = max - bytes
    chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
    bytes += Math.min(chunk.length, room)
    if (chunk.length > room) {
      overflow = true
      onOverflow()
    }
  })
  return { text: () => Buffer.concat(chunks).toString('utf8'), overflowed: () => overflow }
}

/** Whether `claude` leads a process group of its own: on every platform but Windows, which has none. */
const GROUPED = process.platform !== 'win32'

/** SIGKILL what is left of the process group `pid` leads. None left is fine: the group is gone, and `ESRCH` says so. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Nothing is left of the group.
  }
}

/** The runs in flight, whose groups and directories must not outlive quorum. */
const liveRuns = new Set<LiveRun>()

/**
 * What quorum does as it exits while a run is live: SIGKILL each run's process group and remove each run's
 * directory, synchronously, since nothing else runs after an `exit` listener. Any error is ignored, as there
 * is nothing left to do about it. A detached group takes no signal from the terminal, so without this an
 * exit that skips the abort (a second interrupt, `process.exit`) would leave `claude` running and billing.
 * A SIGKILL of quorum, or a death by a default signal, runs no listener.
 */
export function stopLiveRuns(): void {
  for (const { dir, pid } of liveRuns) {
    if (pid !== undefined) killGroup(pid)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // The directory holds no secret, and quorum is exiting.
    }
  }
}

/** Add `run` to the live runs, listening for the exit while there is one. Returns what removes it again, and the listener with the last. */
export function trackRun(run: LiveRun): () => void {
  liveRuns.add(run)
  if (liveRuns.size === 1) process.on('exit', stopLiveRuns)
  return () => {
    liveRuns.delete(run)
    if (liveRuns.size === 0) process.off('exit', stopLiveRuns)
  }
}

/**
 * Start `claude` and settle once it has closed, or fails to start: the message goes to its stdin, which is
 * then ended (an error there is ignored, since the exit says what happened), and its stdout and stderr are
 * read to their caps. Where there are process groups (not Windows) it leads one of its own, so every process
 * it starts can be stopped with it: the signal's abort, or stdout past its cap, sends SIGTERM to the group,
 * then SIGKILL `KILL_GRACE_MS` later if the child has not closed, and the child's exit sends SIGKILL to
 * what is left of the group, since a process that still holds the pipes keeps `close` from ever firing.
 * A process that left the group (it called `setsid`, or was started detached) is beyond that kill and may
 * hold the pipes still, so `KILL_GRACE_MS` after the child's exit its stdout and stderr are destroyed and
 * `close` fires. The listener and the timers go once it has closed. A synchronous throw of `spawn`, or an
 * `error` event before the child runs, is a `process` failure, and there is no child to wait for. The pid
 * that leads the group is kept in `launch.live` while the child lives, for `stopLiveRuns`.
 */
function runChild(launch: Launch, input: string, signal: AbortSignal | undefined, fail: Failure): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const startFailure = (error: unknown): ProviderError => fail('process', `could not start the claude CLI${codeSuffix(error)}`)
    let child: ChildProcess
    try {
      child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'pipe', shell: false, windowsHide: true, detached: GROUPED })
    } catch (error) {
      reject(startFailure(error))
      return
    }
    if (GROUPED) launch.live.pid = child.pid
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let pipeTimer: ReturnType<typeof setTimeout> | undefined
    // The group when the child leads one, else the child alone.
    const send = (name: 'SIGTERM' | 'SIGKILL'): void => {
      if (GROUPED && child.pid !== undefined) {
        try {
          process.kill(-child.pid, name)
          return
        } catch {
          // No such group: the child is gone or never led one, so the signal goes to it alone.
        }
      }
      child.kill(name)
    }
    const stop = (): void => {
      send('SIGTERM')
      killTimer ??= setTimeout(send, KILL_GRACE_MS, 'SIGKILL')
    }
    const release = (): void => {
      clearTimeout(killTimer)
      clearTimeout(pipeTimer)
      launch.live.pid = undefined
      signal?.removeEventListener('abort', stop)
    }
    const stdout = readCapped(child.stdout, MAX_STDOUT_BYTES, stop)
    const stderr = readCapped(child.stderr, MAX_STDERR_BYTES)
    let started = false
    child.once('spawn', () => {
      started = true
    })
    child.on('error', (error) => {
      if (started) return
      release()
      reject(startFailure(error))
    })
    child.once('exit', () => {
      if (GROUPED && child.pid !== undefined) killGroup(child.pid)
      pipeTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, KILL_GRACE_MS)
    })
    child.once('close', (code, endedBy) => {
      release()
      resolve({ run: { stdout: stdout.text(), stderr: stderr.text(), code, signal: endedBy }, overflow: stdout.overflowed() })
    })
    signal?.addEventListener('abort', stop, { once: true })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

/**
 * Run `claude --version` as a request is run, from its empty directory and with its environment: the problem
 * with the version it names (`versionProblem`), or undefined when it is recent enough. It has `VERSION_CHECK_MS`
 * to answer; past them the child's group is stopped as an abort stops it (SIGTERM, then SIGKILL after
 * `KILL_GRACE_MS`) and the check fails with `process`. An abort of the request wins over the deadline.
 */
async function checkVersion(launch: Launch, signal: AbortSignal | undefined, fail: Failure): Promise<string | undefined> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), VERSION_CHECK_MS)
  try {
    const stopped = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
    const { run } = await runChild({ ...launch, args: ['--version'] }, '', stopped, fail)
    throwIfAborted(signal, fail)
    if (deadline.signal.aborted) throw fail('process', `claude --version did not answer within ${VERSION_CHECK_MS / 1000} s`)
    return versionProblem(run.code === 0 && run.signal === null ? run.stdout : '')
  } finally {
    clearTimeout(timer)
  }
}

/** The version check of each command, as one promise, for the life of the process. A check that came to a problem, or failed, is dropped, so the next request runs it again. */
const versionChecks = new Map<string, Promise<string | undefined>>()

/** `promise`, unless `signal` aborts first: then the call rejects as aborted, and `promise` runs on. */
function orAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, fail: Failure): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(fail('aborted', 'request aborted'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function startVersionCheck(launch: Launch, signal: AbortSignal | undefined, fail: Failure): Promise<string | undefined> {
  const check = checkVersion(launch, signal, fail).then(
    (problem) => {
      if (problem !== undefined) versionChecks.delete(launch.command)
      return problem
    },
    (error: unknown) => {
      versionChecks.delete(launch.command)
      throw error
    },
  )
  versionChecks.set(launch.command, check)
  return check
}

/**
 * Fail unless `launch.command` names a recent enough Claude Code, running `claude --version` when no request
 * has: a request that arrives while one runs waits for it, and a command that passed is not checked again.
 * The check runs with the signal and the name of the request that started it, so a request never reports
 * another's failure: one that waited for a check that failed runs it again itself. A request that waits
 * aborts on its own signal, without stopping the check the others still wait for.
 */
async function requireVersion(launch: Launch, signal: AbortSignal | undefined, fail: Failure): Promise<void> {
  for (;;) {
    const shared = versionChecks.get(launch.command)
    let problem: string | undefined
    try {
      problem = await (shared === undefined ? startVersionCheck(launch, signal, fail) : orAbort(shared, signal, fail))
    } catch (error) {
      if (shared === undefined) throw error
      throwIfAborted(signal, fail)
      continue
    }
    if (problem !== undefined) throw fail('process', problem)
    return
  }
}

/**
 * A provider that runs the user's `claude` CLI once per request, headless and isolated, as a pure completion
 * (see the header of this file). The key of `api-key` mode travels only in the child's environment (invariant
 * I1), and no text an error quotes repeats it. A request goes through these steps, in order:
 *
 * 1. exactly one message, a user message, else `unsupported`;
 * 2. a message that starts with `/` after white space, which `-p` would run as a command: `unsupported`;
 * 3. a message over `MAX_STDIN_BYTES` bytes: `too-large`;
 * 4. the size guard, with `CLAUDE_CODE_TEMPLATE_TOKENS` kept for the context Claude Code adds: `too-large`;
 * 5. an aborted signal: `aborted`;
 * 6. a directory of its own, under the temporary directory, holding an empty working directory, `claude`'s
 *    scratch directory and the system text's file: a failure to make it is `process`;
 * 7. `claude --version`, the first time for this command, from that directory and with the child's
 *    environment: a version below `MIN_CLAUDE_CODE_VERSION`, or none, or no answer within `VERSION_CHECK_MS`,
 *    is `process`, and nothing more is run;
 * 8. `claude` spawned there, with `claudeArgs` and `childEnv`, never through a shell, leading a process group
 *    of its own where there are groups: a failure to start is `process`;
 * 9. the message written to its stdin, which is then ended;
 * 10. stdout read to 16 MiB and stderr to 64 KiB, the rest dropped: more stdout stops the child, and is `invalid-response`;
 * 11. on the signal's abort, or stdout past its cap: SIGTERM to the group, then SIGKILL after `KILL_GRACE_MS`;
 *     when the child exits, SIGKILL to what is left of the group, and `KILL_GRACE_MS` later its pipes closed,
 *     so no process, one that left the group included, keeps the call from settling;
 * 12. once the child has closed, the directory removed, on every path, before the call settles, and when
 *     quorum exits first, the group killed and the directory removed (`stopLiveRuns`);
 * 13. an aborted signal: `aborted`; else `readResult`'s reply or failure, with every credential of the
 *     child's environment redacted from the text it quotes (`credentialValues`).
 *
 * No timeout is set: Claude Code retries a failed API call by itself, for minutes, and a deadline is the
 * caller's own (a signal).
 *
 * @throws ConfigError with every problem of the options, before any request
 */
export function claudeCode(options: ClaudeCodeOptions): Provider {
  const issues = claudeCodeIssues(options)
  if (issues.length > 0) throw new ConfigError(issues)
  const { id, model, contextTokens, auth = 'inherit', apiKey, structuredOutput = 'schema', command = 'claude' } = options
  const args = [...options.args ?? []]
  const env = Object.fromEntries(Object.entries(options.env ?? process.env))
  const budget = contextBudget(contextTokens, undefined, CLAUDE_CODE_TEMPLATE_TOKENS)

  return {
    id,
    model,
    async complete(request) {
      const fail = replyFailure(id)
      const message = messageOf(request, fail)
      checkFits(id, { system: request.system, messages: [message] }, request.output, budget)
      const { signal } = request
      throwIfAborted(signal, fail)
      const run = await prepareRun(request.system, fail)
      const live: LiveRun = { dir: run.dir }
      const untrack = trackRun(live)
      try {
        throwIfAborted(signal, fail)
        const environment = childEnv(env, auth, apiKey, run.tmp)
        await requireVersion({ command, args: [], cwd: run.cwd, env: environment, live }, signal, fail)
        throwIfAborted(signal, fail)
        const launch = { command, args: claudeArgs({ model, auth, structuredOutput, args }, run.systemFile, request.output.schema), cwd: run.cwd, env: environment, live }
        const finished = await runChild(launch, message.content, signal, fail)
        throwIfAborted(signal, fail)
        if (finished.overflow) throw fail('invalid-response', 'reply is over 16 MiB')
        return readResult(finished.run, { id, model, structuredOutput, redact: credentialValues(environment) })
      } finally {
        await removeRun(run.dir)
        untrack()
      }
    },
  }
}
