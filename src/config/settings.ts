/**
 * What a result records of the settings a review ran under: the provider view that `--print-config` prints, shared by both sinks, and
 * `reviewSettings`, which builds the record a review is given. The one field no reader may take on trust is
 * `extraBody`. Quorum sends it as the body of every request, to servers it does not know, and a proxy
 * in front of a model may take a credential or an end user's personal data there (OpenAI's `user` names
 * one). So a record writes a value only when a rule that fails closed finds it safe, and writes
 * `[redacted]` for anything it cannot show safe: a value that is no number, boolean, `null` or short
 * string, a string that holds a credential of the hold rules, an e-mail address, the provider's own key
 * or a long run that mixes letters and digits, a value under a key that names a secret, an entry
 * nested past four levels or holding more than 64 values, and a key that is no safe string, which
 * leaves one entry of `[redacted]` for key and value. The same key rule holds the keys of `headers`
 * and `query`, whose values are never written, in both sinks.
 *
 * @see ../../docs/30-security/10-threat-model.md#what-a-result-records-of-a-provider for what a reader sees.
 */

import type { ProfileBudgets } from '../core/budgets.ts'
import { DEFAULT_MAX_SCANNER_ISSUES } from '../core/candidates.ts'
import { documentSha256 } from '../core/documents.ts'
import { DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS } from '../core/limits.ts'
import { DEFAULT_PART_TOKENS } from '../core/parts.ts'
import type { Provider } from '../core/ports.ts'
import { DEFAULT_MAX_FINDINGS } from '../core/prompts.ts'
import { EXTRA_BODY_DEPTH, EXTRA_BODY_STRING, EXTRA_BODY_VALUES, REDACTED } from '../core/result-schema.ts'
import { credentialIn } from '../core/secrets.ts'
import type { ProfileSettings, ProviderSettings, ReviewSettings, RuntimeRecord, SettingValue } from '../core/types.ts'
import { isClaudeCode } from '../providers/build.ts'
import { originOf } from '../providers/http.ts'
import { presetOf } from '../providers/presets.ts'
import { own } from './profiles.ts'
import type { ResolvedProfile } from './profiles.ts'
import type { ResolvedConfig, ResolvedProvider } from './resolve.ts'
import { isProvider, statedFacts } from './schema.ts'

/** A provider defined as data, as a resolved config holds it: the other kind is a provider object. */
export type ProviderSpec = Exclude<ResolvedProvider, Provider>

/** The fewest characters of a run, with no white space, that mixes letters and digits and so reads as an opaque token: a model id, a UUID, a key's body. */
export const OPAQUE_RUN = 20

/** The words of a key that name a secret, compared whole with the words `keyWords` splits it into. */
export const SECRET_WORDS: readonly string[] = Object.freeze([
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'authorization',
  'credential',
  'cookie',
  'session',
  'bearer',
  'signature',
  'user',
  'email',
])

/** What names a secret when it is anywhere in a key's letters, lower-cased and joined: it catches `apikey` and `userpassword`, which hold no word of `SECRET_WORDS` apart. */
export const SECRET_PARTS: readonly string[] = Object.freeze([
  'apikey',
  'accesskey',
  'privatekey',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'authorization',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'sessionid',
  'sessiontoken',
  'bearer',
  'cookie',
  'username',
  'email',
])

/** An e-mail address anywhere in a text: a name, an `@`, then a domain with a `.` between two of its characters, none of them white space or `@`. */
export const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/

/**
 * The words of a key, lower-cased: it splits where a lower-case letter or a digit meets an upper-case
 * one, before an upper-case letter that starts a word after another (`XAuthToken` is `x`, `auth`, `token`),
 * and on anything that is no letter or digit, so `maxTokens`, `max_tokens` and `max-tokens` are one.
 */
export function keyWords(key: string): string[] {
  return key
    .replaceAll(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replaceAll(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word !== '')
    .map(word => word.toLowerCase())
}

/**
 * Whether a key reads as naming a secret: one of its words is in `SECRET_WORDS`, or its letters,
 * lower-cased and joined with every other character removed, hold a `SECRET_PARTS` entry. So `apiKey`,
 * `X-Auth-Token`, `apikey` and `userpassword` do, and `keyword`, `monkey` and `max_tokens` do not.
 */
export function namesSecret(key: string): boolean {
  if (keyWords(key).some(word => SECRET_WORDS.includes(word))) return true
  const letters = key.replaceAll(/\P{L}/gu, '').toLowerCase()
  return SECRET_PARTS.some(part => letters.includes(part))
}

/** Whether a text holds a run of `OPAQUE_RUN` characters or more, with no white space, that has a letter and a digit. A hidden character is no white space, so it joins the runs it sits between. */
function holdsOpaqueRun(text: string): boolean {
  return text.split(/\s+/u).some(run => run.length >= OPAQUE_RUN && /\p{L}/u.test(run) && /\p{N}/u.test(run))
}

/**
 * Whether a string may be written: at most `EXTRA_BODY_STRING` code points (a surrogate pair is one), and
 * no credential of the hold rules, no e-mail address, not the provider's key (case and all; a missing or
 * empty key is none to look for) and no opaque run. The length is read first, and a text of more than
 * twice the limit in UTF-16 units is refused without another look, so a huge value costs nothing.
 */
export function safeString(text: string, apiKey: string | undefined): boolean {
  if (text.length > 2 * EXTRA_BODY_STRING || Array.from(text).length > EXTRA_BODY_STRING) return false
  const holdsKey = apiKey !== undefined && apiKey !== '' && text.includes(apiKey)
  return !holdsKey && credentialIn(text) === undefined && !EMAIL.test(text) && !holdsOpaqueRun(text)
}

/**
 * Whether an entry's value nests at most `EXTRA_BODY_DEPTH` levels of objects and arrays and holds at most
 * `EXTRA_BODY_VALUES` values, each object and array counted as one, a hole of an array one too. An
 * array or an object whose length passes what is left is refused before any of it is read, so a sparse
 * array of 20 million holes costs one comparison, and a cycle ends at its depth.
 */
function fitsBounds(entry: unknown): boolean {
  let left = EXTRA_BODY_VALUES
  const visit = (value: unknown, depth: number): boolean => {
    if (left-- <= 0) return false
    if (typeof value !== 'object' || value === null) return true
    if (depth > EXTRA_BODY_DEPTH) return false
    const children: readonly unknown[] = Array.isArray(value)
      ? value
      : Object.values(value)
    if (children.length > left) return false
    for (const child of children) {
      if (!visit(child, depth + 1)) return false
    }
    return true
  }
  return visit(entry, 1)
}

/** Whether a value is an object a config holds, made by `{}` or by a parser: any other (a map, a date, a class's) is not walked. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** An object's entries by the rule: its object redacted whole when a key itself is no safe string, else each value redacted or walked, a value under a key that names a secret redacted whole. */
function walkObject(object: Record<string, unknown>, apiKey: string | undefined): unknown {
  const entries = Object.entries(object)
  if (!entries.every(([key]) => safeString(key, apiKey))) return REDACTED
  return Object.fromEntries(entries.map(([key, value]) => [
    key,
    namesSecret(key)
      ? REDACTED
      : walk(value, apiKey),
  ]))
}

/** One value by the rule: a finite number, a boolean, `null` or a safe string as it is, an array or an object walked, and anything else redacted. */
function walk(value: unknown, apiKey: string | undefined): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : REDACTED
  }
  if (typeof value === 'boolean' || value === null) return value
  if (typeof value === 'string') {
    return safeString(value, apiKey)
      ? value
      : REDACTED
  }
  if (Array.isArray(value)) return Array.from(value, item => walk(item, apiKey))
  if (typeof value === 'object' && isPlainObject(value)) return walkObject(value, apiKey)
  return REDACTED
}

/** One top-level entry by the rule: its value `[redacted]` when its key names a secret or its value nests too deep or holds too many values, else walked. */
function entryValue(key: string, value: unknown, apiKey: string | undefined): unknown {
  return namesSecret(key) || !fitsBounds(value)
    ? REDACTED
    : walk(value, apiKey)
}

/**
 * A provider's `extraBody` as a result records it: each top-level entry whose key is a safe string
 * (`safeString`, and not the redacted word itself) with its key as it is and its value by the rule, or
 * `[redacted]` when its key names a secret or its value nests too deep or holds too many values. An
 * entry whose key is no safe string is dropped, and the record holds one entry, `[redacted]` for key
 * and value, where the first of them stood, however many there were. `apiKey` is the provider's
 * resolved key, which no key and no value may hold, or `undefined`. Each entry is bounded alone.
 */
export function extraBodyRecord(body: Readonly<Record<string, unknown>>, apiKey: string | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).map(([key, value]) => key === REDACTED || !safeString(key, apiKey)
    ? [REDACTED, REDACTED]
    : [
        key,
        entryValue(key, value, apiKey),
      ]))
}

/** `sha256:` and the lowercase hex SHA-256 of the UTF-8 text: what a prompt prints as, short, and a CI job can compare it with the hash of a file. */
export function textHash(text: string): string {
  return `sha256:${documentSha256(text)}`
}

/** A record with the fields whose value is `undefined` left out, as a YAML text and a JSON text leave them, so a copy of the record holds none. */
function defined(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

/**
 * The origin of a provider defined as data, as the banner and `--print-config` name its endpoint: the
 * scheme, host and port of its own base URL, else of its preset's. Both are read as own fields, so a
 * polluted `Object.prototype` fills neither.
 */
export function providerOrigin(spec: ProviderSpec): string {
  return originOf(own(spec, 'baseUrl') ?? presetOf(own(spec, 'preset'))?.baseUrl ?? '')
}

/**
 * The keys of a header, query or body record, each with the redacted word: a value can be a credential. A key that is no safe string
 * (`safeString`: it holds a credential, an e-mail address, the provider's key or a long opaque run, or it is too long) or that is
 * the redacted word itself becomes one entry, `[redacted]` for key and value, where the first of them stood, however many there were.
 */
function redactedKeys(record: Readonly<Record<string, unknown>> | undefined, apiKey: string | undefined): Record<string, string> | undefined {
  return record === undefined
    ? undefined
    : Object.fromEntries(Object.keys(record).map(key => [
        key === REDACTED || !safeString(key, apiKey)
          ? REDACTED
          : key,
        REDACTED,
      ]))
}

/** The auth style as set: a name, or the header and the prefix a key is sent with. Neither holds the key. */
function authView(auth: ProviderSpec['auth']): unknown {
  return typeof auth === 'object'
    ? defined({
        header: own(auth, 'header'),
        prefix: own(auth, 'prefix'),
      })
    : auth
}

/** Where the instructions go (`native` or `inline`), the only values a spec accepts; any other value is a prompt, so it is its hash. */
function systemPromptView(value: unknown): string | undefined {
  if (value === undefined || value === 'native' || value === 'inline') return value
  return typeof value === 'string'
    ? textHash(value)
    : REDACTED
}

/** What a provider's view is written for: `--print-config`, a CI log anyone may read, or a result's `meta.settings`. */
export type ProviderSink = 'print-config' | 'result'

/**
 * A provider defined as data, field by field: a field of a spec that is not listed here is written nowhere. A field that is
 * `undefined` is left out. A `claude-code` provider has no origin and runs a `command` and `args`, and its `auth` is `inherit` when it
 * sets none, as it runs. The keys of `headers`, `query` and `extraBody` are written by the key rule (`redactedKeys`) and their values
 * are `[redacted]`, apart from `extraBody` in a result, which is written by `extraBodyRecord`.
 *
 * The `print-config` sink writes the whole view. The `result` sink leaves out `command`, `origin`, `apiKey` and `args`, so a
 * result holds no base URL, no key and nothing a person runs, and writes `extraBody` by the rule of `extraBodyRecord`.
 */
export function providerView(spec: ProviderSpec, sink: ProviderSink): ProviderSettings {
  const cli = isClaudeCode(own(spec, 'protocol'))
  const recorded = sink === 'result'
  const apiKey = own(spec, 'apiKey')
  const body = own(spec, 'extraBody')
  return defined({
    preset: own(spec, 'preset'),
    protocol: own(spec, 'protocol'),
    command: recorded
      ? undefined
      : own(spec, 'command'),
    origin: cli || recorded
      ? undefined
      : providerOrigin(spec),
    model: own(spec, 'model'),
    contextTokens: own(spec, 'contextTokens'),
    apiKey: recorded || apiKey === undefined
      ? undefined
      : REDACTED,
    auth: authView(own(spec, 'auth') ?? (cli ? 'inherit' : undefined)),
    args: recorded
      ? undefined
      : own(spec, 'args'),
    headers: redactedKeys(own(spec, 'headers'), apiKey),
    query: redactedKeys(own(spec, 'query'), apiKey),
    extraBody: recorded && body !== undefined
      ? extraBodyRecord(body, apiKey)
      : redactedKeys(body, apiKey),
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
  })
}

/** A provider object by what it implements, its model when that is a string, and the `timeoutMs`, `stallTimeoutMs` and `retries` it states; never its function. */
export function objectView(provider: Readonly<Provider>): ProviderSettings {
  const model = own(provider, 'model')
  const { timeoutMs, stallTimeoutMs, retries } = statedFacts(provider).stated
  return defined({
    implements: 'Provider',
    model: typeof model === 'string'
      ? model
      : undefined,
    timeoutMs,
    stallTimeoutMs,
    retries,
  })
}

/**
 * What the review itself worked out, which the config cannot say: a path review's token cap and finding cap come from its estimate and
 * its parts, and its deadline is its own default, so its `bounds` are given with their origins and win over the config's. A review
 * that derives none gives no `bounds`, and each is the config's (`config`) or the default (`default`).
 */
export interface SettingsFacts {
  /** The quorum's budgets, by profile id (`Quorum.budgets`): the findings a research request asks for and the reply budgets. */
  readonly budgets: Readonly<Record<string, ProfileBudgets>>
  /** What ran the review. */
  readonly runtime: RuntimeRecord
  readonly bounds?: {
    readonly maxReviewTokens: SettingValue
    readonly reviewTimeoutMs: SettingValue
    readonly findingsCap: SettingValue
  }
}

/** A bound the config sets (`config`) or the default (`default`). */
function configured(value: number | undefined, standard: number): SettingValue {
  return value === undefined
    ? { value: standard, origin: 'default' }
    : { value, origin: 'config' }
}

/** One profile as the record holds it: its research provider and each lens's by config key, each lens question and prompt as its hash, and the budgets the quorum sized its replies by. */
function profileSettings({ profile, research, voters }: ResolvedProfile, budgets: ProfileBudgets): ProfileSettings {
  const { replyTokens } = budgets.research
  return {
    research,
    lenses: Object.fromEntries(profile.lenses.map(lens => [
      lens.id,
      {
        provider: voters[lens.id],
        question: textHash(lens.question),
      },
    ])),
    prompts: {
      research: textHash(profile.prompts.research),
      vote: textHash(profile.prompts.vote),
    },
    findings: budgets.research.findings,
    replyTokens: {
      ...replyTokens === undefined
        ? {}
        : { research: replyTokens },
      votes: Object.fromEntries(profile.lenses.map(lens => [
        lens.id,
        budgets.lenses[lens.id].replyTokens ?? null,
      ])),
    },
  }
}

/**
 * The settings a review of `config` ran under, for a result to record (`ReviewInput.settings`): the runtime, the config's `strict`,
 * `concurrency` (`auto` when unset) and `exclude`, the review's bounds each with where it came from, `maxScannerIssues` (the config's or the default), each provider of the config as
 * `providerView` writes it for a result, and each profile it runs. The bounds are those of `facts.bounds` when the review derived
 * them, else the config's or the default: `findingsCap` is the config's `findingsCap`, else its `maxFindings`, else the default.
 * A prompt and a lens question are their hashes, as `--print-config` prints them. The record holds no base URL, origin, command, args or key, no header or query
 * value, and an `extraBody` value only where the rule of `extraBodyRecord` finds it safe, so two results of two configs
 * compare field by field. It passes `settingsSchema`, and shares no object with the config.
 */
export function reviewSettings(config: ResolvedConfig, facts: SettingsFacts): ReviewSettings {
  const { bounds } = facts
  return {
    runtime: { ...facts.runtime },
    strict: config.strict === true,
    concurrency: config.concurrency ?? 'auto',
    exclude: [
      ...config.exclude ?? [],
    ],
    partTokens: configured(config.partTokens, DEFAULT_PART_TOKENS),
    maxFindings: configured(config.maxFindings, DEFAULT_MAX_FINDINGS),
    findingsCap: bounds === undefined
      ? configured(config.findingsCap ?? config.maxFindings, DEFAULT_MAX_FINDINGS)
      : { ...bounds.findingsCap },
    maxScannerIssues: configured(config.maxScannerIssues, DEFAULT_MAX_SCANNER_ISSUES),
    maxReviewTokens: bounds === undefined
      ? configured(config.maxReviewTokens, DEFAULT_MAX_REVIEW_TOKENS)
      : { ...bounds.maxReviewTokens },
    reviewTimeoutMs: bounds === undefined
      ? configured(config.reviewTimeoutMs, DEFAULT_REVIEW_TIMEOUT_MS)
      : { ...bounds.reviewTimeoutMs },
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [
      name,
      isProvider(provider)
        ? objectView(provider)
        : providerView(provider, 'result'),
    ])),
    profiles: Object.fromEntries(config.profiles.map(resolved => [
      resolved.profile.id,
      profileSettings(resolved, facts.budgets[resolved.profile.id]),
    ])),
  }
}
