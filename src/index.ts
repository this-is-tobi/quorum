import { renderEvent } from './cli/render.ts'
import type { QuorumEvent, QuorumResult } from './core/types.ts'
import { quorumFromEnv } from './legacy.ts'

export { ConfigError, OutputError, ProviderError, QuorumError } from './core/errors.ts'
export type { ConfigIssue, ProviderErrorKind } from './core/errors.ts'
export { defaultPolicy } from './core/policy.ts'
export type { PolicyRules, Rule } from './core/policy.ts'
export type { ChatMessage, CompletionRequest, CompletionResponse, EventSink, JsonSchema, ProfilePorts, Provider, QuorumPorts } from './core/ports.ts'
export { createQuorum } from './core/quorum.ts'
export { inertJson, inertLine } from './core/sanitize.ts'
export type {
  Confidence,
  Finding,
  Flag,
  FlagCode,
  IncompleteEntry,
  IncompleteReason,
  Lens,
  LensVote,
  Profile,
  ProfileMeta,
  ProfileProviders,
  Prompts,
  ProviderRef,
  Quorum,
  QuorumEvent,
  QuorumMeta,
  QuorumOptions,
  QuorumResult,
  StageName,
  Thresholds,
  Usage,
  Verdict,
  VerdictStatus,
  Vote,
} from './core/types.ts'
export { securityProfile } from './profiles/security.ts'
export { anthropic } from './providers/anthropic.ts'
export type { AnthropicOptions } from './providers/anthropic.ts'
export type { SystemPrompt } from './providers/messages.ts'
export { openaiCompatible } from './providers/openai-compatible.ts'
export type { OpenAICompatibleOptions } from './providers/openai-compatible.ts'
export type { Auth, HttpProviderOptions, StructuredOutput } from './providers/options.ts'

/**
 * Review a diff with the security profile and providers built from the RESEARCH_* / VOTER_*
 * environment variables of `process.env`. `onProgress` receives the lines the CLI prints on stderr.
 * A research model that is not set is a `ConfigError`, even for an empty diff.
 *
 * @deprecated Use createQuorum with explicit providers
 *
 * @example
 * const { kept } = await runQuorum(diffText)
 */
export async function runQuorum(diff: string, onProgress?: (message: string) => void): Promise<QuorumResult> {
  const events = onProgress === undefined
    ? undefined
    : (event: QuorumEvent): void => {
        const line = renderEvent(event)
        if (line !== undefined) onProgress(line)
      }
  return quorumFromEnv(process.env, events).review({ diff })
}
