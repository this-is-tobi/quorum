import { posix } from 'node:path'
import { z } from 'zod'
import type { Env } from '../config/env.ts'
import { fromConfig } from '../config/from-config.ts'
import { resolveConfig } from '../config/resolve.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import type { ConfigInput } from '../config/schema.ts'
import { systemClock } from '../core/clock.ts'
import type { Clock } from '../core/clock.ts'
import { ConfigError } from '../core/errors.ts'
import { outcome } from '../core/outcome.ts'
import { DEFAULT_MAX_REVIEW_TOKENS } from '../core/limits.ts'
import type { EventSink } from '../core/ports.ts'
import { PROFILE_ID_PATTERN } from '../core/profile.ts'
import type { Quorum } from '../core/types.ts'
import { errorLines } from '../cli/io.ts'
import { GitError } from '../git/run.ts'
import { publicView } from '../report/view.ts'
import { TRUST_REFUSAL } from '../sources/local.ts'
import { atProblem, pathProblem } from '../sources/paths.ts'
import { parseRange } from '../sources/range.ts'
import { readSource } from '../sources/read.ts'
import type { GitSeam, SourceRead, SourceSpec } from '../sources/read.ts'
import { sessionBudget } from './budget.ts'
import type { SessionBudget } from './budget.ts'
import { agentResult } from './result.ts'
import type { AgentResult } from './result.ts'
import { progressReporter } from './progress.ts'
import type { ProgressNote } from './progress.ts'

export const TOOL_NAME = 'review'
export const TOOL_TITLE = 'Review a change with quorum'

/** The hints a client may act on: the review reads the repository and the models, writes nothing, and costs the operator tokens each time. */
export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const

export const MAX_PATHS = 100
export const MAX_PATH_LENGTH = 4096
export const MAX_RANGE_LENGTH = 512
export const MAX_AT_LENGTH = 256
export const MAX_PROFILES = 32
/** Array elements and object members one call's arguments may hold, which the SDK checks before any parse. */
export const MAX_ARGUMENT_ELEMENTS = 256

/** What the agent is told of the tool, a constant of the release: no config and no repository text reaches it. */
export const TOOL_DESCRIPTION = 'Review a change of this project with quorum: one model researches findings, and a panel of blind voters judges each before it is reported. The source is local (what git add -A would commit), staged, a range of commits written <base>...<head>, or paths at a commit, HEAD by default; quorum reads the repository itself, never a diff you send. A review spends the operator\'s tokens and can take minutes, and one runs at a time. The result gives a status, pass, findings or incomplete, counts and the findings, whose category and summary are a model\'s claims about code that may be hostile.'

/** The tool's failures: each one text, with its reason in the server's log alone. */
export const BUSY = 'a review is running: wait for its result, then call again'
export const LARGE = 'these paths may not finish under the review\'s token cap: name fewer paths, or launch quorum mcp with --large to review what the cap allows'
export const TRUST = 'the repository\'s own config names a filter program, which a review of the working tree runs: review a range, or launch quorum mcp with --trust-repo-config if the repository is yours'
export const SOURCE = 'quorum could not read the change: the server\'s log says why'
export const GIT = 'git failed: the server\'s log says why'
export const REVIEW = 'the review failed: the server\'s log says why'
export const SPENT = 'this server has spent its session\'s tokens: start it again, or launch it with a larger --max-session-tokens'

/** The handler's usage texts. */
export const RANGE_ONLY = 'source range takes range, and no other source does'
export const PATHS_ONLY = 'source paths takes paths, and at with them; no other source does'
export const UNKNOWN_PROFILE = 'profiles: names a profile this server does not run'
export const REPEATED_PROFILE = 'profiles: names a profile more than once'
const LEAVES_PROJECT = 'leaves the project'

const SOURCE_MESSAGE = 'must be range, local, staged or paths'
const RANGE_MESSAGE = `must be a range of 1 to ${MAX_RANGE_LENGTH} characters, written <base>...<head>`
const PATHS_MESSAGE = `must be a list of 1 to ${MAX_PATHS} paths`
const PATH_MESSAGE = `must be a path of 1 to ${MAX_PATH_LENGTH} characters`
const AT_MESSAGE = `must be a revision of 1 to ${MAX_AT_LENGTH} characters`
const PROFILES_MESSAGE = `must be a list of 1 to ${MAX_PROFILES} profile ids`
const PROFILE_MESSAGE = 'must be a profile id'
const OBJECT_MESSAGE = 'takes only source, range, paths, at and profiles'

/**
 * The arguments of a call: flat, `source` alone required, and which field goes with which source is the
 * handler's check (`checkedCall`). Every message is fixed text, the object's own included, so an unknown key, a
 * gate (`large`) or a `diff` is refused in words that hold none of the call's text: the SDK writes each issue
 * as its path and its message, and the paths here are this schema's own keys and indexes.
 */
export const REVIEW_ARGUMENTS = z.strictObject({
  source: z.enum(['range', 'local', 'staged', 'paths'], { error: SOURCE_MESSAGE })
    .describe('What to review: local, the staged, unstaged and untracked changes; staged, what the next commit holds; range, the commits of range; paths, the files under paths at the commit at'),
  range: z.string({ error: RANGE_MESSAGE }).min(1, { error: RANGE_MESSAGE }).max(MAX_RANGE_LENGTH, { error: RANGE_MESSAGE }).describe('With source range: the commits to review, written <base>...<head>').optional(),
  paths: z.array(z.string({ error: PATH_MESSAGE }).min(1, { error: PATH_MESSAGE }).max(MAX_PATH_LENGTH, { error: PATH_MESSAGE }), { error: PATHS_MESSAGE })
    .min(1, { error: PATHS_MESSAGE })
    .max(MAX_PATHS, { error: PATHS_MESSAGE })
    .describe('With source paths: at most 100 paths, each relative to the project and inside it, a file, a directory or . for all of it')
    .optional(),
  at: z.string({ error: AT_MESSAGE }).min(1, { error: AT_MESSAGE }).max(MAX_AT_LENGTH, { error: AT_MESSAGE }).describe('With source paths: the commit to read, HEAD by default').optional(),
  profiles: z.array(z.string({ error: PROFILE_MESSAGE }).regex(PROFILE_ID_PATTERN, { error: PROFILE_MESSAGE }), { error: PROFILES_MESSAGE })
    .min(1, { error: PROFILES_MESSAGE })
    .max(MAX_PROFILES, { error: PROFILES_MESSAGE })
    .describe('The profiles to run, among the server\'s own; all of them by default')
    .optional(),
}, { error: OBJECT_MESSAGE })

/** The arguments of a call that passed the schema. */
export type ReviewArguments = z.output<typeof REVIEW_ARGUMENTS>

/**
 * What a server runs with: the operator's launch, read once. The agent can change none of it, and a call can
 * lift no gate: `large`, `trustRepoConfig` and `send` are the launch's alone.
 */
export interface McpLaunch {
  /** The directory the server serves, absolute: `CLAUDE_PROJECT_DIR`, else the directory it was launched in. */
  readonly root: string
  /** The checked config the launch read, which a call's `profiles` resolves again in memory: the file is never read again. */
  readonly input: ConfigInput
  /** `input` as the launch resolved it, under the launch's `--profile`. */
  readonly config: ResolvedConfig
  readonly env: Env
  readonly platform: NodeJS.Platform
  /** Whether a review of paths may pass the token cap, reviewing what the cap allows. */
  readonly large: boolean
  /** Whether a filter program the repository's own config names may run for a review of the working tree. */
  readonly trustRepoConfig: boolean
  /** The files sent to the models though held as secrets: the config's, then `--send`'s. */
  readonly send: readonly string[]
  /** The most tokens the server spends over its life: `--max-session-tokens`, else four times the review's cap. */
  readonly sessionTokens: number
  /** Whether a finding leaves its category and summary, a model's claims, out of what the agent receives. */
  readonly codeFieldsOnly: boolean
  /** Whether the tool asks Claude Code to have the person approve every call. */
  readonly requireApproval: boolean
  /** The operator's progress lines, which every review's events are handed to. */
  readonly observe?: EventSink
  /** The git a source runs, for the specs. */
  readonly git?: GitSeam
  /** The clock the heartbeat of a call's progress runs on, for the specs. */
  readonly clock?: Clock
}

/**
 * `path`, as a path of the root: normalized as a POSIX path with a trailing `/` dropped, or `undefined` when it
 * leaves the root (`..`, or a path that starts `../`). The root is `CLAUDE_PROJECT_DIR` or the launch directory,
 * which may be a subdirectory of the repository, so a path is contained in the root and not only in the
 * repository's top level: the path source reads it from there. `pathProblem` has refused an empty and an
 * absolute path before.
 */
export function containedPath(path: string): string | undefined {
  const joined = posix.normalize(path)
  const name = joined.length > 1 && joined.endsWith('/')
    ? joined.slice(0, -1)
    : joined
  return name === '..' || name.startsWith('../')
    ? undefined
    : name
}

/**
 * The source and the profiles a call names, or the text of the usage rule it breaks, checked in this order
 * and before any git or model: `range` goes with source `range` alone, `paths` and `at` with source `paths`
 * alone; the range's form (`parseRange`); each path, in order, refused empty or absolute (`pathProblem`) or
 * leaving the root (`containedPath`), by its index; `at` (`atProblem`); then the profiles: each must be one the
 * server serves, and none may be named twice. A text never holds the call's own: the range, a path and a
 * revision are named by their argument and their place.
 *
 * The source of `local` and `staged` is returned without `trustRepoConfig`, which is the launch's to add, and
 * a path review always skips what it skips by default: no argument turns the skips off.
 */
export function checkedCall(args: ReviewArguments, served: readonly string[]): { readonly spec: SourceSpec, readonly profiles?: readonly string[] } | string {
  const { source, range, paths, at, profiles } = args
  if ((source === 'range') !== (range !== undefined)) return RANGE_ONLY
  if ((source === 'paths') !== (paths !== undefined) || (source !== 'paths' && at !== undefined)) return PATHS_ONLY
  if (range !== undefined) {
    const problem = parseRange(range)
    if (typeof problem === 'string') return `range: ${problem}`
  }
  const contained: string[] = []
  for (const [index, path] of (paths ?? []).entries()) {
    const problem = pathProblem(path)
    if (problem !== undefined) return `paths.${index}: ${problem}`
    const inside = containedPath(path)
    if (inside === undefined) return `paths.${index}: ${LEAVES_PROJECT}`
    contained.push(inside)
  }
  const atIssue = atProblem(at)
  if (atIssue !== undefined) return `at: ${atIssue}`
  if (profiles !== undefined) {
    if (!profiles.every(id => served.includes(id))) return UNKNOWN_PROFILE
    if (new Set(profiles).size !== profiles.length) return REPEATED_PROFILE
  }
  const spec: SourceSpec = source === 'range'
    ? { kind: 'range', range: range as string }
    : source === 'paths'
      ? {
          kind: 'paths',
          paths: contained,
          at,
          skips: true,
        }
      : { kind: source }
  return profiles === undefined
    ? { spec }
    : { spec, profiles }
}

/** What a server holds for the life of its process: the launch, the quorum the launch built, and the one review that may run. It lives outside the SDK's server factory, which may run twice. */
export interface ReviewSession {
  readonly launch: McpLaunch
  /** The quorum of the launch's profiles, built once. */
  readonly quorum: Quorum
  /** The ids of the profiles the server serves. */
  readonly served: readonly string[]
  /** The sink every quorum of the session reports to: the operator's lines, then the current call's listener. */
  readonly events: EventSink
  /** Where the server writes what the agent never sees: each failure's reason, one inert text. */
  readonly log: (text: string) => void
  /** What the server may still spend: counted at each call's `spent` and at a review's whole cap when it ends without a result. */
  readonly budget: SessionBudget
  /** Whether a review runs. */
  running: boolean
  /** The tokens the events of the current call's review reported, which a review that ends without a result is charged the rest of its cap beyond. */
  counted: number
  /** The current call's event listener, while its review runs. */
  listener: EventSink | undefined
}

/** The tokens one review may spend, which a review's start and its charge are both counted by. */
function reviewCap(launch: McpLaunch): number {
  return launch.config.maxReviewTokens ?? DEFAULT_MAX_REVIEW_TOKENS
}

/**
 * The session of a launch: its quorum, built from the launch's resolved config, which reports each event to
 * `launch.observe`, to the session's budget, then to the listener of the call that runs. A `call` event adds
 * its `spent` to the budget and to the current call's count: the tokens the review's own cap counted for the
 * call, the reported usage or, for a call that reported none, its reservation, which is what bounds a review
 * and so the session. The result's usage would miss a call the review gave up on, and the cap never does.
 *
 * @throws ConfigError as `fromConfig` does, when a provider of the config cannot be built
 */
export async function openSession(launch: McpLaunch, log: (text: string) => void): Promise<ReviewSession> {
  let session: ReviewSession | undefined
  const events: EventSink = (event) => {
    launch.observe?.(event)
    if (session !== undefined && event.type === 'call') {
      session.budget.add(event.spent)
      session.counted += event.spent
    }
    session?.listener?.(event)
  }
  const quorum = await fromConfig(launch.config, { env: launch.env, events })
  session = {
    launch,
    quorum,
    served: launch.config.profiles.map(({ profile }) => profile.id),
    events,
    log,
    budget: sessionBudget(launch.sessionTokens),
    running: false,
    counted: 0,
    listener: undefined,
  }
  return session
}

/** What a call returns: the SDK's tool result. */
export interface CallOutcome {
  readonly content: Array<{ readonly type: 'text', readonly text: string }>
  readonly structuredContent?: AgentResult
  readonly isError?: true
}

/** A refusal or a failure, in one fixed text. */
function failure(text: string): CallOutcome {
  return {
    content: [
      { type: 'text', text },
    ],
    isError: true,
  }
}

/** The argument a refusal at a flag of the source is worded for, in the agent's own names. */
const ARGUMENT_OF: ReadonlyMap<string, string> = new Map([
  ['--range', 'range'],
  ['--path', 'paths'],
  ['--at', 'at'],
])

/** A failure of the source read, with the fixed text the agent receives of it, and the failure itself, for the log. */
class Refused extends Error {
  readonly text: string
  readonly reason: unknown

  constructor(text: string, reason: unknown) {
    super(text)
    this.text = text
    this.reason = reason
  }
}

/** Writes to the session's log, which a handler that never throws cannot let fail. */
function note(session: ReviewSession, text: string): void {
  try {
    session.log(text)
  } catch {
    // The operator's log is gone: the agent's answer is the same.
  }
}

/**
 * The text of a failure of the source: `TRUST` for the filter refusal; for a `ConfigError` at `--range`, `--path`
 * or `--at`, its issue's message after the argument's name; `SOURCE` for any other `ConfigError`, an untracked
 * file's among them; `GIT` for a `GitError`; `REVIEW` for the rest.
 */
function sourceText(error: unknown): string {
  if (error instanceof GitError) return GIT
  if (!(error instanceof ConfigError)) return REVIEW
  if (error.issues.some(({ message }) => message === TRUST_REFUSAL)) return TRUST
  const [issue] = error.issues
  const argument = issue === undefined
    ? undefined
    : ARGUMENT_OF.get(issue.path)
  return issue === undefined || argument === undefined
    ? SOURCE
    : `${argument}: ${issue.message}`
}

/** The quorum of the profiles a call names: the launch's checked config resolved again, never read again, reporting to the session's sink. */
async function narrowed(session: ReviewSession, ids: readonly string[]): Promise<Quorum> {
  const { env, input } = session.launch
  const config = resolveConfig(input, {
    env,
    selection: { ids, path: 'profiles' },
  })
  return fromConfig(config, { env, events: session.events })
}

/** What the source reads for `spec`, from the root, or a `Refused` with its text. */
async function readChange(session: ReviewSession, spec: SourceSpec, signal: AbortSignal): Promise<SourceRead> {
  const { launch } = session
  try {
    return await readSource(spec, {
      cwd: launch.root,
      env: launch.env,
      platform: launch.platform,
      signal,
      exclude: launch.config.exclude,
      send: launch.send,
      git: launch.git,
    })
  } catch (error) {
    throw new Refused(sourceText(error), error)
  }
}

/**
 * Charges what a review's events never reported and logs the session's spend, once the review's promise has
 * settled. A review that ended without a result (`unresolved`: a cancel, an abort, a failure or a sink error) is
 * charged the rest of its whole cap, `cap` less what its events counted, and never less than nothing: the core
 * reports no call once a review is aborted, and the panel rejects without waiting for its votes in flight, so
 * what those spent is never seen, and a review never spends more than its cap. Counting the cap bounds the
 * session whatever was lost, where a count of what was reported would let a loop of cancelled reviews spend
 * unseen.
 */
function settleSpend(session: ReviewSession, cap: number, unresolved: boolean): void {
  if (unresolved) session.budget.add(Math.max(0, cap - session.counted))
  note(session, `quorum mcp: the session has spent ${session.budget.spent()} of ${session.budget.total} tokens`)
}

/**
 * Review the change a call names and return what the agent receives. It never throws: every failure is one fixed
 * text with `isError`, and its reason, the failure's own lines, goes to the session's log alone. In this order:
 *
 * 1. `BUSY` at once when a review runs: one runs at a time, and the tokens are the operator's;
 * 2. `SPENT` at once when what the session's budget has left cannot hold one review's whole cap, which a
 *    review that is started may spend;
 * 3. the usage check (`checkedCall`), whose text is returned as it is;
 * 4. the lock, taken before anything is awaited, and then, inside the `try`, a progress reporter when the call
 *    asked for progress, stopped as soon as the call is cancelled;
 * 5. the quorum: the session's, or for `profiles` one built from the launch's checked config;
 * 6. the source, read from the root with the launch's `exclude`, `send` and platform;
 * 7. for `paths`, the estimate: `LARGE` unless it fits the token cap or the launch was `--large`;
 * 8. the review, under the call's signal;
 * 9. the result: `agentResult` of the public view, as `structuredContent` and as its JSON in one text block,
 *    without each finding's category and summary under `--code-fields-only`.
 *
 * The listener is cleared, the reporter stopped and the lock released in a `finally`, after the review's promise
 * has settled, so a call made right after a cancelled one is `BUSY` until the review has stopped spending. A review that ends
 * without a result, a cancel, an abort, a failure or a sink error, is charged its whole cap, less what its
 * events counted, there: the core reports no call once a review is aborted, so what its calls in flight spent
 * is never seen, and a review spends no more than its cap. A call refused before its review, or whose source
 * fails, spends nothing and is charged nothing. After each review the session's spend goes to the log.
 *
 * A failure's text: `TRUST` for a repository whose own config names a filter program, where the launch did not
 * trust it; `SOURCE` for any other refusal of the source, an untracked file's among them, whose message quotes a
 * file name; `GIT` for a failed git; `REVIEW` for the rest. A refusal at `--range`, `--path` or `--at` is the
 * one exception: it passes through, worded with the argument's name, since those texts never repeat what was
 * written and tell the agent how to correct its call ("its base names no commit", "path 1 names no file
 * tracked at the commit"). A cancelled call writes `a review was cancelled` to the log, and the SDK sends
 * nothing for it.
 */
export async function reviewCall(session: ReviewSession, args: ReviewArguments, call: { readonly signal: AbortSignal, readonly notify?: (note: ProgressNote) => void }): Promise<CallOutcome> {
  if (session.running) return failure(BUSY)
  const { launch } = session
  const cap = reviewCap(launch)
  if (!session.budget.holds(cap)) return failure(SPENT)
  const checked = checkedCall(args, session.served)
  if (typeof checked === 'string') return failure(checked)
  session.running = true
  session.counted = 0
  let reporter: ReturnType<typeof progressReporter> | undefined
  const stopReporter = (): void => reporter?.stop()
  // Where the call is: before its review is called, while it runs, and once it has resolved with a result.
  let stage: 'before' | 'reviewing' | 'resolved' = 'before'
  try {
    // Set up inside the `try`, so a throw here is an answer and never leaves the lock held. A cancel stops the
    // reporter at once, so no heartbeat follows it.
    if (call.notify !== undefined) reporter = progressReporter(call.notify, launch.clock ?? systemClock)
    session.listener = reporter?.onEvent
    if (call.signal.aborted) stopReporter()
    else call.signal.addEventListener('abort', stopReporter, { once: true })
    const quorum = checked.profiles === undefined
      ? session.quorum
      : await narrowed(session, checked.profiles)
    const spec: SourceSpec = checked.spec.kind === 'local' || checked.spec.kind === 'staged'
      ? { kind: checked.spec.kind, trustRepoConfig: launch.trustRepoConfig }
      : checked.spec
    const read = await readChange(session, spec, call.signal)
    if (spec.kind === 'paths' && !launch.large && !quorum.estimate({ diff: read.diff, send: launch.send }).fits) return failure(LARGE)
    stage = 'reviewing'
    const result = await quorum.review({ ...read, send: launch.send }, { signal: call.signal })
    stage = 'resolved'
    const agent = agentResult(publicView(result), outcome(result), { codeFieldsOnly: launch.codeFieldsOnly })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(agent),
        },
      ],
      structuredContent: agent,
    }
  } catch (error) {
    if (call.signal.aborted) {
      note(session, 'quorum mcp: a review was cancelled')
      return failure(REVIEW)
    }
    note(session, errorLines(error instanceof Refused
      ? error.reason
      : error))
    return failure(error instanceof Refused
      ? error.text
      : REVIEW)
  } finally {
    try {
      // The charge comes first, so nothing after it can leave a review's spend uncounted.
      if (stage !== 'before') settleSpend(session, cap, stage === 'reviewing')
    } finally {
      session.listener = undefined
      call.signal.removeEventListener('abort', stopReporter)
      stopReporter()
      session.running = false
    }
  }
}
