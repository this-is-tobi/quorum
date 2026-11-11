import { isAbsolute } from 'node:path'
import type { ConfigIssue, ProviderError } from '../core/errors.ts'
import type { CompletionResponse, JsonSchema } from '../core/ports.ts'
import type { Usage } from '../core/types.ts'
import { snippet } from './http.ts'
import { contextTokensIssues, isRecord, NOT_VISIBLE_ASCII, wordList } from './options.ts'
import { replyFailure, tokenUsage } from './reply.ts'

/**
 * The `claude-code` adapter runs the user's installed `claude` CLI once per request, headless and isolated,
 * as a pure completion: no tool but the schema tool, no settings file, MCP server, slash command or
 * session from the user's or the project's setup, the system text in a file, the message on stdin, and no
 * credential on the command line. Written against Claude Code 2.1.311: a CLI that lacks one of the flags
 * below fails the run, but one that ignores an environment variable runs with less isolation.
 *
 * This half is pure: the options and their checks, the command line, the child's environment and the
 * reading of the JSON result, each testable without a process.
 */

/** The tokens kept around a request for the context Claude Code adds itself: 953 for a one-line prompt and 1463 with the schema tool's second turn, measured live. */
export const CLAUDE_CODE_TEMPLATE_TOKENS = 4096
/** The most bytes of a request sent to `claude` on stdin: 10 000 000, the smaller reading of 10 MB. */
export const MAX_STDIN_BYTES = 10_000_000
/** The milliseconds `claude` has to exit after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 2000

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
 * processes `claude` starts, the Chrome integration, the task and agent-team tools, the PowerShell tool
 * and a JSON object merged into every request body. Claude Code's own settings keep the launcher, sync and
 * plugin root variables from a checked-out repository for the same reason.
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
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
  'CLAUDE_CODE_EXTRA_BODY',
])
/** The credential and endpoint variables `login` and `api-key` remove, besides every one that starts with `CLAUDE_CODE_USE_`. */
const CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
])
const CLOUD_PROVIDER_PREFIX = 'CLAUDE_CODE_USE_'
const KEY_VARIABLE = 'ANTHROPIC_API_KEY'

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
 * every credential and endpoint variable, so a login or a key never reaches another host. Names are matched
 * in any letter case, since Windows reads them so. Under `api-key`, `ANTHROPIC_API_KEY` is then `apiKey`
 * when it is a non-empty string, else the environment's own, trimmed, when that is not blank. Last come
 * three variables the run sets over whatever the environment held, in any case: no auto memory, no
 * compaction of a long prompt, and a temporary directory of its own.
 */
export function childEnv(env: Readonly<Record<string, string | undefined>>, auth: ClaudeCodeAuth, apiKey: string | undefined, tmpDir: string): Record<string, string> {
  const isolation = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_COMPACT: '1', CLAUDE_CODE_TMPDIR: tmpDir }
  const own = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  const inheritedKey = (own.find(([name]) => name === KEY_VARIABLE) ?? own.find(([name]) => name.toUpperCase() === KEY_VARIABLE))?.[1].trim()
  const key = typeof apiKey === 'string' && apiKey !== '' ? apiKey : inheritedKey
  return {
    ...Object.fromEntries(own.filter(([name]) => !removedVariable(name, auth, isolation))),
    ...(auth === 'api-key' && key !== undefined && key !== '' ? { [KEY_VARIABLE]: key } : {}),
    ...isolation,
  }
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
function replyText(result: Record<string, unknown>, structuredOutput: ClaudeCodeStructuredOutput, fail: ReturnType<typeof replyFailure>): string {
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
 * exit after a success, a tool the server ran, then the text. Claude Code
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
