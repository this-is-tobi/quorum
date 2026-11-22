import { createHash } from 'node:crypto'
import { stringify } from 'yaml'
import { own } from '../config/profiles.ts'
import type { ResolvedProfile } from '../config/profiles.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { isProvider, statedFacts } from '../config/schema.ts'
import type { ProfileBudgets } from '../core/budgets.ts'
import type { Provider } from '../core/ports.ts'
import { DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS } from '../core/limits.ts'
import { DEFAULT_PART_TOKENS } from '../core/parts.ts'
import { thresholdsFor } from '../core/profile.ts'
import { inertLine } from '../core/sanitize.ts'
import { DEFAULT_MAX_FINDINGS } from '../core/stages/research.ts'
import { isClaudeCode } from '../providers/build.ts'
import { providerOrigin } from './render.ts'

/** What stands for a secret in the view: the word `http.ts` redacts with. */
const REDACTED = '[redacted]'

type ProviderSpec = Exclude<ResolvedProvider, Provider>

/** `sha256:` and the lowercase hex SHA-256 of the UTF-8 text: what a prompt prints as, short, and a CI job can compare it with the hash of a file. */
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/** The keys of a record, each with the redacted word: a header, query or body value can be a credential. */
function redactedValues(record: Readonly<Record<string, unknown>> | undefined): Record<string, string> | undefined {
  return record === undefined
    ? undefined
    : Object.fromEntries(Object.keys(record).map(key => [key, REDACTED]))
}

/** The auth style as set: a name, or the header and the prefix a key is sent with. Neither holds the key. */
function authView(auth: ProviderSpec['auth']): unknown {
  return typeof auth === 'object'
    ? {
        header: own(auth, 'header'),
        prefix: own(auth, 'prefix'),
      }
    : auth
}

/** Where the instructions go (`native` or `inline`), the only values a spec accepts; any other value is a prompt, so it prints as its hash. */
function systemPromptView(value: unknown): string | undefined {
  if (value === undefined || value === 'native' || value === 'inline') return value
  return typeof value === 'string'
    ? sha256(value)
    : REDACTED
}

/**
 * A provider defined as data, field by field: a field of a spec that is not listed here prints nothing.
 * `undefined` leaves a field out, as `stringify` keeps no `undefined` value. A `claude-code` provider has
 * no origin and runs a `command` and `args`, and its `auth` is `inherit` when it sets none, as it runs.
 */
function specView(spec: ProviderSpec): Record<string, unknown> {
  const cli = isClaudeCode(own(spec, 'protocol'))
  return {
    preset: own(spec, 'preset'),
    protocol: own(spec, 'protocol'),
    command: own(spec, 'command'),
    origin: cli
      ? undefined
      : providerOrigin(spec),
    model: own(spec, 'model'),
    contextTokens: own(spec, 'contextTokens'),
    apiKey: own(spec, 'apiKey') === undefined
      ? undefined
      : REDACTED,
    auth: authView(own(spec, 'auth') ?? (cli ? 'inherit' : undefined)),
    args: own(spec, 'args'),
    headers: redactedValues(own(spec, 'headers')),
    query: redactedValues(own(spec, 'query')),
    extraBody: redactedValues(own(spec, 'extraBody')),
    structuredOutput: own(spec, 'structuredOutput'),
    temperature: own(spec, 'temperature'),
    maxTokens: own(spec, 'maxTokens'),
    maxTokensField: own(spec, 'maxTokensField'),
    thinking: own(spec, 'thinking'),
    systemPrompt: systemPromptView(own(spec, 'systemPrompt')),
    stream: own(spec, 'stream'),
    timeoutMs: own(spec, 'timeoutMs'),
    stallTimeoutMs: own(spec, 'stallTimeoutMs'),
    retries: own(spec, 'retries'),
  }
}

/** A provider object by what it implements, its model when that is a string, and the `timeoutMs`, `stallTimeoutMs` and `retries` it states; never its function. */
function objectView(provider: Readonly<Provider>): Record<string, unknown> {
  const model = own(provider, 'model')
  const { timeoutMs, stallTimeoutMs, retries } = statedFacts(provider).stated
  return {
    implements: 'Provider',
    model: typeof model === 'string'
      ? model
      : undefined,
    timeoutMs,
    stallTimeoutMs,
    retries,
  }
}

/** A profile that runs: the level its kept findings fail the review at (`none` for an advisory profile), its providers, the votes its policy needs, and each prompt as its hash. */
function profileView({ profile, research, voters }: ResolvedProfile): Record<string, unknown> {
  return {
    failOn: profile.failOn ?? 'high',
    research,
    lenses: { ...voters },
    thresholds: thresholdsFor(profile),
    prompts: {
      research: sha256(profile.prompts.research),
      vote: sha256(profile.prompts.vote),
    },
  }
}

/** The research parts whose worst case the token cap must hold at least, before the config is warned of. */
const WARNED_BELOW_PARTS = 20

/** A profile's budgets as printed: the provider's context size by the name the config uses, and every figure a reader needs to size a window. Absent figures print nothing. */
function budgetsView(budgets: ProfileBudgets): Record<string, unknown> {
  const { research } = budgets
  return {
    research: {
      provider: research.provider,
      contextTokens: research.window,
      replyTokens: research.replyTokens,
      findings: research.findings,
      findingsWithoutThinking: research.findingsWithoutThinking,
      rooms: research.rooms,
      worstPart: research.worstPart,
    },
    lenses: Object.fromEntries(Object.entries(budgets.lenses).map(([id, lens]) => [
      id,
      {
        provider: lens.provider,
        contextTokens: lens.window,
        replyTokens: lens.replyTokens,
        room: lens.room,
      },
    ])),
  }
}

/** What the config says of a provider's `maxTokens`, as the text a warning adds after the tokens of a part: empty when it sets none. */
function maxTokensNote(config: ResolvedConfig, provider: string): string {
  const spec = own(config.providers, provider)
  const maxTokens = spec === undefined
    ? undefined
    : isProvider(spec)
      ? statedFacts(spec).stated.maxTokens
      : own(spec, 'maxTokens')
  return typeof maxTokens === 'number'
    ? `, maxTokens ${maxTokens}`
    : ''
}

/** The warnings the budgets add: a token cap that holds the worst case of fewer than 20 research parts of a profile's provider, with what to lower. */
function budgetWarnings(config: ResolvedConfig, budgets: Readonly<Record<string, ProfileBudgets>>): string[] {
  const cap = config.maxReviewTokens ?? DEFAULT_MAX_REVIEW_TOKENS
  return Object.values(budgets).flatMap(({ research }) => research.worstPart === undefined || research.worstPart.holds >= WARNED_BELOW_PARTS
    ? []
    : [
        `the token cap of ${cap} holds the worst case of ${research.worstPart.holds} research parts of ${research.provider} (${research.worstPart.tokens} tokens each${maxTokensNote(config, research.provider)}): lower maxTokens, or raise maxReviewTokens`,
      ])
}

/**
 * The resolved config as the YAML `--print-config` writes, for a CI log that anyone can read: the file it
 * came from (`null` for none), the providers, the profiles that run, the limits the review applies
 * (`concurrency`, `auto` when unset, `maxFindings`, `partTokens`, `maxReviewTokens` and `reviewTimeoutMs`, defaults filled in), `strict`, the
 * patterns it excludes, the files it sends though held as secrets, and the warnings. A key and every value of
 * `headers`, `query` and `extraBody` print as `[redacted]`, a base URL as its origin, and a prompt as its
 * SHA-256. A provider's `timeoutMs`, `stallTimeoutMs` and `retries` print when it sets them, a provider object's when it states
 * them. A `claude-code` provider prints its protocol, command, model, context size, key (redacted), auth mode and args, and no origin:
 * the command and the args are the user's own config. The view is an allowlist, so a field added to the
 * config prints nothing until it is added here on purpose.
 *
 * With `budgets`, a quorum's (`Quorum.budgets`), each profile's follow `profiles` under `budgets`: each request kind's reply
 * budget, the findings a research request asks for, the tokens of diff each provider's stated room leaves, and the worst
 * case of a research part with how many the token cap holds; a cap that holds fewer than 20 of them adds a warning.
 * A provider that states no room prints none of it.
 *
 * The text ends with a newline, and each line passes through `inertLine`. It is YAML 1.1, so a reader of
 * that version reads `off` as a string, and no line folds.
 */
export function printConfig(config: ResolvedConfig, source: string | undefined, budgets?: Readonly<Record<string, ProfileBudgets>>): string {
  const view = {
    source: source ?? null,
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [
      name,
      isProvider(provider)
        ? objectView(provider)
        : specView(provider),
    ])),
    profiles: Object.fromEntries(config.profiles.map(resolved => [
      resolved.profile.id,
      profileView(resolved),
    ])),
    budgets: budgets === undefined
      ? undefined
      : Object.fromEntries(Object.entries(budgets).map(([id, profile]) => [
          id,
          budgetsView(profile),
        ])),
    concurrency: config.concurrency ?? 'auto',
    maxFindings: config.maxFindings ?? DEFAULT_MAX_FINDINGS,
    partTokens: config.partTokens ?? DEFAULT_PART_TOKENS,
    maxReviewTokens: config.maxReviewTokens ?? DEFAULT_MAX_REVIEW_TOKENS,
    reviewTimeoutMs: config.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    strict: config.strict === true,
    exclude: [
      ...config.exclude ?? [],
    ],
    send: [
      ...config.send ?? [],
    ],
    warnings: [
      ...config.warnings,
      ...budgets === undefined
        ? []
        : budgetWarnings(config, budgets),
    ],
  }
  return stringify(view, { version: '1.1', lineWidth: 0, blockQuote: false }).split('\n').map(line => inertLine(line)).join('\n')
}
