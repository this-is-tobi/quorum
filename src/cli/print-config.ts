import { stringify } from 'yaml'
import { own } from '../config/profiles.ts'
import type { RepositoryEntry, ResolvedProfile } from '../config/profiles.ts'
import type { ResolvedConfig } from '../config/resolve.ts'
import { isProvider, statedFacts } from '../config/schema.ts'
import { objectView, providerView, textHash } from '../config/settings.ts'
import type { ProfileBudgets } from '../core/budgets.ts'
import { DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS } from '../core/limits.ts'
import { DEFAULT_PART_TOKENS } from '../core/parts.ts'
import { thresholdsFor } from '../core/profile.ts'
import { inertLine } from '../core/sanitize.ts'
import { DEFAULT_MAX_FINDINGS } from '../core/stages/research.ts'
import type { DocumentKind } from '../core/types.ts'
import { UNMEASURED } from '../profiles/index.ts'

/** A `{ repository }` entry as printed: its path, and `optional: true` when it is. */
function repositoryView(entry: RepositoryEntry): Record<string, unknown> {
  return {
    repository: entry.path,
    ...entry.optional
      ? { optional: true }
      : {},
  }
}

/** The entries of a field in the order the config wrote them: a `{ repository }` entry sits at its own position, and the others fill the places it leaves, in order. */
function inOrder(files: ReadonlyMap<number, unknown>, others: readonly unknown[]): unknown[] {
  const listed: unknown[] = []
  let next = 0
  for (let position = 0; position < others.length + files.size; position++) listed.push(files.get(position) ?? others[next++])
  return listed
}

/**
 * The documents of one kind a profile holds, as the list `--print-config` prints: the text the profile itself carries (a built-in
 * profile's own, which the config did not write) as `{ builtIn: <hash> }`, then each entry of the config in the order it is written:
 * a document as the hash of its text as read, a `{ repository }` entry as `{ repository: <path> }` and `optional: true` when it is. Never
 * a text. Undefined when the profile holds none, so the list is left out.
 */
function documentsView({ profile, repository }: ResolvedProfile, kind: DocumentKind, profileText: string | undefined): unknown[] | undefined {
  const documents = (profile.documents ?? []).filter(document => document.kind === kind).map(document => document.origin.sha256 === undefined
    ? textHash(document.text ?? '')
    : `sha256:${document.origin.sha256}`)
  const files = new Map(repository.filter(entry => entry.kind === kind).map(entry => [
    entry.index,
    repositoryView(entry),
  ]))
  const listed: unknown[] = profileText === undefined
    ? []
    : [
        {
          builtIn: textHash(profileText),
        },
      ]
  // A `{ repository }` entry sits at its own position among the field's entries, and the documents fill the others in order.
  listed.push(...inOrder(files, documents))
  return listed.length === 0
    ? undefined
    : listed
}

/**
 * The rules a profile holds, as the list `--print-config` prints: the rules the profile itself carries (a built-in profile's own,
 * which the config did not write) as `{ builtIn: [<id>, ...] }`, then each entry of the config in the order it is written: a rule
 * written in the config as its id, a rules file as `{ sha256: <hex>, ids: [<id>, ...] }`, the hash being that of its text as read,
 * and a `{ repository }` entry as its path, with `optional: true` when it is. Never a text. Undefined when the profile holds none,
 * so the list is left out.
 */
function rulesView({ profile, repository }: ResolvedProfile): unknown[] | undefined {
  const idsOf = (rules: readonly { readonly id: string }[] | undefined): string[] => (rules ?? []).map(rule => rule.id)
  const documents = (profile.documents ?? []).filter(document => document.kind === 'rules').map((document) => {
    const ids = idsOf(document.rules)
    if (document.origin.sha256 !== undefined) return { sha256: document.origin.sha256, ids }
    return ids.length === 1
      ? ids[0]
      : { ids }
  })
  const files = new Map(repository.filter(entry => entry.kind === 'rules').map(entry => [
    entry.index,
    repositoryView(entry),
  ]))
  const own = idsOf(profile.rules)
  const listed: unknown[] = own.length === 0
    ? []
    : [
        { builtIn: own },
      ]
  listed.push(...inOrder(files, documents))
  return listed.length === 0
    ? undefined
    : listed
}

/** A profile that runs: the level its kept findings fail the review at (`none` for an advisory profile), its providers, the votes its policy needs, each prompt as its hash, each document as its hash or, for a `{ repository }` entry, its path, and its rules by their ids, with `builtInRules: false` and `requireRule: true` when it sets them, then the `maxFindings` it holds, `changedLinesOnly: true` when it holds it, and `unmeasured: true` when the built-in profile it starts from is one no labelled set measures. */
function profileView(resolved: ResolvedProfile): Record<string, unknown> {
  const { profile, research, voters } = resolved
  return {
    failOn: profile.failOn ?? 'high',
    research,
    lenses: { ...voters },
    thresholds: thresholdsFor(profile),
    prompts: {
      research: textHash(profile.prompts.research),
      vote: textHash(profile.prompts.vote),
    },
    guidelines: documentsView(resolved, 'guidelines', profile.guidelines),
    doNotReport: documentsView(resolved, 'do-not-report', profile.doNotReport),
    rules: rulesView(resolved),
    builtInRules: resolved.builtInRules,
    requireRule: profile.requireRule === true
      ? true
      : undefined,
    maxFindings: profile.maxFindings,
    changedLinesOnly: profile.changedLinesOnly === true
      ? true
      : undefined,
    unmeasured: resolved.base !== undefined && UNMEASURED.has(resolved.base)
      ? true
      : undefined,
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
 * (`concurrency`, `auto` when unset, `maxFindings`, `findingsCap` only when set, `partTokens`, `maxReviewTokens` and `reviewTimeoutMs`, defaults filled in), `strict`, the
 * patterns it excludes, the files it sends though held as secrets, and the warnings. Every value of
 * `headers`, `query` and `extraBody` prints as `[redacted]`, and so does a key that is no safe string (it holds a credential,
 * an e-mail address, the provider's key or a long opaque run), the keys of one map that are none as one `[redacted]` entry, a base URL as its origin, and a prompt as its
 * SHA-256, as does each of a profile's guidelines and do-not-report documents (the hash of its text as read, and a built-in
 * profile's own text as `{ builtIn: <hash> }`), never a text; a `{ repository }` entry prints as its path, with `optional: true` when it is.
 * A profile's rules print as their ids, a rules file as the hash of its text and the ids it holds, never a rule's text, then
 * `builtInRules: false` and `requireRule: true` when the profile sets them, then its `maxFindings` when it holds one, `changedLinesOnly: true`
 * when it holds it and `unmeasured: true` when it is, or extends, a built-in profile no labelled set measures. A provider's `timeoutMs`, `stallTimeoutMs` and `retries` print when it sets them, a provider object's when it states
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
        : providerView(provider, 'print-config'),
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
    ...config.findingsCap === undefined
      ? {}
      : { findingsCap: config.findingsCap },
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
