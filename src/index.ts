import { providerIdentity } from './bench/fingerprint.ts'
import { viewFacts } from './cli/render.ts'
import { plainWriter } from './cli/view/plain.ts'
import { fromConfig } from './config/from-config.ts'
import { loadConfig } from './config/load.ts'
import type { ResolvedConfig } from './config/resolve.ts'
import { readContext as readContextOf } from './context/read.ts'
import type { ContextOptions } from './context/read.ts'
import { ConfigError } from './core/errors.ts'
import { inertLine } from './core/sanitize.ts'
import type { ReplyStore } from './core/ports.ts'
import type { QuorumResult, ReviewContext } from './core/types.ts'
import { VERSION } from './core/version.ts'
import { openFileStore } from './state/store.ts'
import { readSource as readSourceOf } from './sources/read.ts'
import type { SourceContext, SourceRead, SourceSpec } from './sources/read.ts'

export { defineConfig } from './config/define.ts'
export type { Env } from './config/env.ts'
export { fromConfig } from './config/from-config.ts'
export { loadConfig } from './config/load.ts'
export type { FailOnOverride, ProfileSelection, RepositoryEntry, ResolvedProfile } from './config/profiles.ts'
export type { ResolvedConfig, ResolvedProvider } from './config/resolve.ts'
export type { ConfigInput, QuorumConfig, QuorumConfigFile } from './config/schema.ts'
export { reviewSettings } from './config/settings.ts'
export type { SettingsFacts } from './config/settings.ts'
export type { ProfileBudgets, ReplyFacts, ThinkingLevel } from './core/budgets.ts'
export { ConfigError, OutputError, ProviderDownError, ProviderError, QuorumError } from './core/errors.ts'
export type { ConfigIssue, NoAnswer, ProviderErrorKind, ReplyLack } from './core/errors.ts'
export { LANE_START, REVIEW_CEILING } from './core/lanes.ts'
export type { ConcurrencyRecord } from './core/lanes.ts'
export { INTERRUPT_GRACE_MS } from './core/limits.ts'
export { outcome } from './core/outcome.ts'
export type { Outcome, OutcomeStatus } from './core/outcome.ts'
export { defaultPolicy } from './core/policy.ts'
export type { PolicyRules, Rule } from './core/policy.ts'
export type { Adapts, ChatMessage, CompletionRequest, CompletionResponse, EventSink, JsonSchema, ProfilePorts, Provider, QuorumPorts, RateLimit, ReplyStore, StoredCall, StreamSignal } from './core/ports.ts'
export { createQuorum } from './core/quorum.ts'
export { cleanProse, codeSpan, fencedBlock, inertJson, inertLine, inertPlain } from './core/sanitize.ts'
export type { CleanedProse, Removed } from './core/sanitize.ts'
export type {
  Adaptation,
  CallFailure,
  Confidence,
  ContextDocument,
  ContextRecord,
  CoverageEntry,
  CoverageReason,
  CoverageStatus,
  CredentialKind,
  DocumentKind,
  DocumentOrigin,
  Estimate,
  FailOn,
  Finding,
  Flag,
  FlagCode,
  FoundBy,
  IncompleteEntry,
  IncompleteReason,
  LeftOutFile,
  LeftOutReason,
  LeftRange,
  Lens,
  LensVote,
  ObjectFormat,
  Position,
  Profile,
  ProfileEstimate,
  ProfileMeta,
  ProfileProviders,
  ProfileSettings,
  Prompts,
  ProviderCalls,
  ProviderRef,
  ProviderSettings,
  PublicGap,
  PublicMeta,
  PublicProfileMeta,
  PublicVerdict,
  PublicView,
  PublicVote,
  Quorum,
  QuorumEvent,
  QuorumMeta,
  QuorumOptions,
  QuorumResult,
  ResearchRecord,
  ReviewContext,
  ReviewDocument,
  ReviewInput,
  ReviewRule,
  ReviewSettings,
  ReviewSource,
  RoleCalls,
  RuntimeRecord,
  SecretRule,
  ServedModel,
  SettingOrigin,
  SettingValue,
  SkipRule,
  StageName,
  Thresholds,
  UnusableReply,
  Usage,
  Verdict,
  VerdictStatus,
  Vote,
  VoteFailure,
  VoteFailureKind,
} from './core/types.ts'
export { GitError } from './git/run.ts'
export { bestPracticesProfile } from './profiles/best-practices.ts'
export { codeReviewProfile } from './profiles/code-review.ts'
export { performanceProfile } from './profiles/performance.ts'
export { securityProfile } from './profiles/security.ts'
export { anthropic } from './providers/anthropic.ts'
export type { AnthropicOptions } from './providers/anthropic.ts'
export { claudeCode } from './providers/claude-code.ts'
export type { ClaudeCodeAuth, ClaudeCodeOptions } from './providers/claude-code.ts'
export { gemini } from './providers/gemini.ts'
export type { GeminiOptions } from './providers/gemini.ts'
export type { SystemPrompt } from './providers/messages.ts'
export { ollama } from './providers/ollama.ts'
export type { OllamaOptions } from './providers/ollama.ts'
export { openaiCompatible } from './providers/openai-compatible.ts'
export type { OpenAICompatibleOptions } from './providers/openai-compatible.ts'
export type { Auth, HttpProviderOptions, StructuredOutput } from './providers/options.ts'
export { presets } from './providers/presets.ts'
export type { Preset, PresetName, Protocol } from './providers/presets.ts'
export type { ActionComment, ActionPayload } from './report/payload.ts'
export { readResult } from './report/read.ts'
export { renderReport } from './report/registry.ts'
export type { ReportFormat, ReportOptions } from './report/registry.ts'
export type { ReportInput } from './report/reporter.ts'
export { publicView } from './report/view.ts'
export type { ReportView } from './report/view.ts'
export type { SourceRead, SourceSpec } from './sources/read.ts'

/**
 * The file store the CLI's `--state <dir>` uses, as a `ReplyStore` for `review(input, { store })`: every research call
 * whose reply passed its check and every vote that parsed is kept in `directory` as it completes, and a cut-off or
 * saturated research reply as a marker that sends its part straight to recovery, so a rerun of a review that failed
 * late reuses what it paid for, for a request sent as it was and checked as a fresh reply, and spends nothing on it.
 * `providers` are the config's (`ResolvedConfig['providers']`): each provider's identity (every field of it but its key and the six `OUT_OF_IDENTITY` leaves out: `timeoutMs`, `stallTimeoutMs`, `retries`, `stream`, `streams` and `slots`) is part of an entry's key, so
 * a changed provider is a miss, and a provider the config does not name keeps nothing. The rest is the process's: its
 * platform, the user that owns it (the directory must be that user's, and no other user's to write), quorum's own
 * version, and its standard error, where each warning is one inert line. The directory is made with mode 0700 when it is
 * missing; it must be a directory, no link, that the user owns and no one else may write, empty or made by quorum, and
 * outside every git work tree: whoever writes it writes a part's review, so it must never be restored from a cache another
 * job can write, and it is removed once the review it serves is done.
 *
 * @throws ConfigError at `--state` when the directory is refused, naming the flag and never the path
 *
 * @example
 * const store = await fileStore('/home/me/.quorum-state', { providers: config.providers })
 * const result = await quorum.review(input, { store })
 */
export async function fileStore(directory: string, options: { readonly providers: ResolvedConfig['providers'] }): Promise<ReplyStore> {
  return openFileStore(directory, {
    identities: new Map(Object.entries(options.providers).map(([id, provider]) => [
      id,
      providerIdentity(provider),
    ])),
    version: VERSION,
    owner: process.getuid?.(),
    platform: process.platform,
    warn: line => process.stderr.write(`${inertLine(line)}\n`),
  })
}

/**
 * Read the diff a review is about from a source, as the CLI does for a diff, `--range`, `--local`, `--staged`
 * and `--path`: `spec` names the source and `context` the working directory, the environment, a `signal`, the
 * config's `exclude` patterns, which a source that reads files applies before it reads them, and its `send`,
 * the files a path review reads though it skips a secret otherwise, each a path as the diff writes it. It
 * answers with the `diff`, where it came from (`source`) and the files it left out (`leftOut`), which `review`
 * takes as its input.
 * A git source runs the system's git, found on the `PATH` of `context.env`, on the platform of this process: it
 * needs git 2.41 or later, and Linux or macOS. No source cuts a diff, drops a file without listing it or reads
 * outside the repository's top level.
 *
 * @throws ConfigError, its every issue naming the flag the CLI names, when the source refuses what it was given
 * or the working directory is no repository it can read, or `kind` is none of the five
 * @throws GitError when a git command the source runs fails
 *
 * @example
 * const input = await readSource({ kind: 'paths', paths: ['src'] }, { cwd: process.cwd(), env: process.env })
 * const result = await quorum.review(input)
 */
export async function readSource(spec: SourceSpec, context: Omit<SourceContext, 'platform' | 'git'>): Promise<SourceRead> {
  return readSourceOf(spec, {
    cwd: context.cwd,
    env: context.env,
    signal: context.signal,
    exclude: context.exclude,
    send: context.send,
    platform: process.platform,
  })
}

/**
 * Read the documents a review takes from the repository, as the CLI does: the `{ repository }` entries of the profiles of
 * `config` (`ResolvedProfile.repository`), each read from the commit `options.source` names, never from the working tree or the
 * change under review. `options.source` is `SourceRead.source`, the `source` the diff came from: a range's base, a path review's
 * commit, HEAD for local and staged changes. A config with no entry reads nothing, runs no git and gives `{}`. The result is the
 * `context` of `review` and `estimate`, which refuse an input without it when a profile lists such a document, and refuse a document
 * read at another commit than the source's. Every entry's problem is reported at once, before any call.
 * A git run is the system's git, on the platform of this process: it needs git 2.41 or later, and Linux or macOS.
 *
 * @throws ConfigError, at each entry's `profiles.<id>.<field>.<n>.repository`, when the source names no commit to read from (a diff,
 * or local changes before a first commit) or a file is absent (unless optional), a link, a submodule, no UTF-8 text, over 64 KiB or
 * over its cap once cleaned
 * @throws GitError when a git command fails
 *
 * @example
 * const input = await readSource({ kind: 'range', range: 'main...feature' }, { cwd: process.cwd(), env: process.env })
 * const context = await readContext(config, { source: input.source, cwd: process.cwd(), env: process.env })
 * const result = await quorum.review({ ...input, context })
 */
export async function readContext(config: ResolvedConfig, options: Omit<ContextOptions, 'platform' | 'git'>): Promise<ReviewContext> {
  return readContextOf(config, {
    source: options.source,
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    platform: process.platform,
  })
}

/** What `runQuorum` says of a `{ repository }` entry: it passes no context, so it cannot read the document the entry names. */
const REPOSITORY_REFUSAL = 'reads a document of the repository, which runQuorum cannot read: build the quorum with fromConfig and pass readContext\'s context to review'

/**
 * Review a diff as the CLI does with no flag: with the file `QUORUM_CONFIG` names, if any (an absolute
 * path), and the `QUORUM_*` variables of `process.env` with their `RESEARCH_*` and `VOTER_*` aliases, on the profiles
 * they select, the security profile alone by default, sending the files the config's `send` names though
 * they are held as secrets. `onProgress` receives the progress lines the CLI
 * prints on stderr after its banner, never the banner or a warning. A configuration error, a missing
 * model included, rejects with a `ConfigError`, even for an empty diff. It cannot read the documents of the
 * repository that a `{ repository }` entry names, so a config that lists one is refused, before any call, at
 * the entry: build the quorum with `fromConfig` and pass `readContext`'s context to `review`.
 *
 * @deprecated Use loadConfig and fromConfig
 *
 * @throws ConfigError when the config is invalid, or lists a `{ repository }` document, at its entry's
 * `profiles.<id>.<field>.<n>.repository`
 *
 * @example
 * const { kept } = await runQuorum(diffText)
 */
export async function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult> {
  const { config } = await loadConfig()
  const unreadable = config.profiles.flatMap(({ repository }) => repository.map(entry => ({ path: entry.at, message: REPOSITORY_REFUSAL })))
  if (unreadable.length > 0) throw new ConfigError(unreadable)
  const quorum = await fromConfig(config, {
    events: onProgress === undefined
      ? undefined
      : plainWriter({
        write: onProgress,
        facts: viewFacts(config),
      }).sink,
  })
  return quorum.review({ diff, send: config.send })
}
