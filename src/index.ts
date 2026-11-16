import { progressSink } from './cli/render.ts'
import { fromConfig } from './config/from-config.ts'
import { loadConfig } from './config/load.ts'
import type { QuorumResult } from './core/types.ts'
import { readSource as readSourceOf } from './sources/read.ts'
import type { SourceContext, SourceRead, SourceSpec } from './sources/read.ts'

export { defineConfig } from './config/define.ts'
export type { Env } from './config/env.ts'
export { fromConfig } from './config/from-config.ts'
export { loadConfig } from './config/load.ts'
export type { ProfileSelection, ResolvedProfile } from './config/profiles.ts'
export type { ResolvedConfig, ResolvedProvider } from './config/resolve.ts'
export type { ConfigInput, QuorumConfig, QuorumConfigFile } from './config/schema.ts'
export { ConfigError, OutputError, ProviderError, QuorumError } from './core/errors.ts'
export type { ConfigIssue, ProviderErrorKind } from './core/errors.ts'
export { defaultPolicy } from './core/policy.ts'
export type { PolicyRules, Rule } from './core/policy.ts'
export type { ChatMessage, CompletionRequest, CompletionResponse, EventSink, JsonSchema, ProfilePorts, Provider, QuorumPorts } from './core/ports.ts'
export { createQuorum } from './core/quorum.ts'
export { inertJson, inertLine } from './core/sanitize.ts'
export type {
  Confidence,
  CoverageEntry,
  CoverageReason,
  CoverageStatus,
  Estimate,
  Finding,
  Flag,
  FlagCode,
  IncompleteEntry,
  IncompleteReason,
  LeftOutFile,
  LeftOutReason,
  LeftRange,
  Lens,
  LensVote,
  ObjectFormat,
  Profile,
  ProfileEstimate,
  ProfileMeta,
  ProfileProviders,
  Prompts,
  ProviderRef,
  Quorum,
  QuorumEvent,
  QuorumMeta,
  QuorumOptions,
  QuorumResult,
  ReviewInput,
  ReviewSource,
  SkipRule,
  StageName,
  Thresholds,
  Usage,
  Verdict,
  VerdictStatus,
  Vote,
  VoteFailure,
  VoteFailureKind,
} from './core/types.ts'
export { GitError } from './git/run.ts'
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
export type { SourceRead, SourceSpec } from './sources/read.ts'

/**
 * Read the diff a review is about from a source, as the CLI does for a diff, `--range`, `--local`, `--staged`
 * and `--path`: `spec` names the source and `context` the working directory, the environment, a `signal` and the
 * config's `exclude` patterns, which a source that reads files applies before it reads them. It answers with the
 * `diff`, where it came from (`source`) and the files it left out (`leftOut`), which `review` takes as its input.
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
    platform: process.platform,
  })
}

/**
 * Review a diff as the CLI does with no flag: with the file `QUORUM_CONFIG` names, if any (an absolute
 * path), and the `QUORUM_*` variables of `process.env` with their `RESEARCH_*` and `VOTER_*` aliases, on the profiles
 * they select, the security profile alone by default. `onProgress` receives the progress lines the CLI
 * prints on stderr after its banner, never the banner or a warning. A configuration error, a missing
 * model included, rejects with a `ConfigError`, even for an empty diff.
 *
 * @deprecated Use loadConfig and fromConfig
 *
 * @example
 * const { kept } = await runQuorum(diffText)
 */
export async function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult> {
  const { config } = await loadConfig()
  const quorum = await fromConfig(config, {
    events: onProgress === undefined
      ? undefined
      : progressSink(onProgress),
  })
  return quorum.review({ diff })
}
