import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { Provider } from '../core/ports.ts'
import { buildProvider } from '../providers/build.ts'
import type { ProviderSpec } from '../providers/build.ts'
import { httpOrigin } from '../providers/http.ts'
import { presetOf, withoutPrototype } from '../providers/presets.ts'
import type { Preset } from '../providers/presets.ts'
import { applyRoleOverrides, atVariables, baseUrlOf, envValue, readEnv } from './env.ts'
import type { Env, ProviderEntry, RoleBinding } from './env.ts'
import { own, resolveProfiles } from './profiles.ts'
import type { ResolvedProfile } from './profiles.ts'
import { configPath, isProvider, unknownName } from './schema.ts'
import type { ConfigInput, ProviderSettings } from './schema.ts'

/** A provider a run uses: a spec with its key read into `apiKey`, or the frozen snapshot of an object implementing `Provider`, which holds its config key as its `id`. */
export type ResolvedProvider = Omit<ProviderSpec, 'id'> | Readonly<Provider>

/**
 * A config with every layer merged, every reference bound and every key read, ready to build a quorum from.
 * It holds keys, as a code config does: print it redacted.
 */
export interface ResolvedConfig {
  /** The providers a profile that runs uses, in definition order. A spec has no `apiKey` field when it has no key. */
  readonly providers: Readonly<Record<string, ResolvedProvider>>
  readonly profiles: readonly ResolvedProfile[]
  readonly concurrency?: number
  readonly maxFindings?: number
  readonly warnings: readonly string[]
}

const DEFAULT_NAME = 'default'
/** The provider of a config that defines none: Ollama's OpenAI-compatible endpoint on this machine. The adapter's own defaults fill the rest. */
const DEFAULT_PROVIDER: ProviderSettings = { protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }
const NO_MODEL = 'no model configured: set QUORUM_RESEARCH_MODEL, or name a config file that sets one'
/** The only variable names a message prints: a key pasted where a name belongs must never show. */
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const VOTER_KEY = 'QUORUM_VOTER_API_KEY'
const VOTER_MODEL = 'QUORUM_VOTER_MODEL'
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/

/** The configs this module resolved: a frozen copy is recognised by its identity, never by its shape. */
const RESOLVED = new WeakSet<object>()

/** Whether `value` is a config `resolveConfig` returned. */
export function isResolvedConfig(value: unknown): value is ResolvedConfig {
  return typeof value === 'object' && value !== null && RESOLVED.has(value)
}

/** `value` frozen with everything it holds, except a provider object, which is a frozen snapshot already. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !isProvider(value)) {
    for (const field of Object.values(value)) deepFreeze(field)
    Object.freeze(value)
  }
  return value
}

/** A spec's own fields, read once into an object with no prototype: a polluted `Object.prototype` fills none of them. */
function ownFields(spec: ProviderSettings): ProviderSettings {
  return withoutPrototype<ProviderSettings>(Object.entries(spec))
}

/** The host of an origin `httpOrigin` returned, without its port. */
function hostOf(origin: string): string {
  return new URL(origin).hostname
}

/** Whether `host` is this machine: `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`. */
function isThisMachine(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || LOOPBACK_IPV4.test(host)
}

/** Whether `baseUrl` is the endpoint a preset's own key variable belongs to: its origin, or for Azure, an Azure OpenAI resource. */
function atPresetOrigin(presetName: string | undefined, preset: Preset, baseUrl: string | undefined): boolean {
  const origin = httpOrigin(baseUrl)
  if (origin === undefined) return false
  // The preset has no base URL: the documented v1 endpoint is https://<resource>.openai.azure.com/openai/v1.
  if (presetName === 'azure-openai') return origin.startsWith('https://') && hostOf(origin).endsWith('.openai.azure.com')
  return origin === httpOrigin(preset.baseUrl)
}

/** The issue of a key variable that is not set. The variable is named only when it is an upper-case name. */
function unsetKey(provider: string, variable: string): ConfigIssue {
  return VARIABLE_NAME.test(variable)
    ? { path: configPath(['providers', provider]), message: `${variable} is not set` }
    : { path: configPath(['providers', provider, 'apiKeyEnv']), message: 'names a variable that is not set' }
}

interface KeyReading {
  /** Always an own field, so a polluted `Object.prototype` fills none. */
  readonly apiKey: string | undefined
  readonly issues: readonly ConfigIssue[]
  readonly warnings: readonly string[]
}

const NO_KEY: KeyReading = Object.freeze({ apiKey: undefined, issues: Object.freeze([]), warnings: Object.freeze([]) })

/** The key a variable holds, or the issue that it is not set. */
function readVariable(name: string, variable: string, env: Env): KeyReading {
  const apiKey = envValue(env, variable)
  return { apiKey, issues: apiKey === undefined ? [unsetKey(name, variable)] : [], warnings: [] }
}

/**
 * The key of a spec that a profile uses: its own `apiKey` (an empty one is unset, as a blank variable is),
 * else the variable `apiKeyEnv` names, else its preset's own variable, which is read only while the base URL is the preset's endpoint (I1) and `presetKey`
 * allows it: at another endpoint it is not read, and the warning says so.
 */
function readKey(name: string, fields: ProviderSettings, env: Env, presetKey: boolean): KeyReading {
  if (fields.apiKey !== undefined && fields.apiKey !== '') return { apiKey: fields.apiKey, issues: [], warnings: [] }
  if (fields.apiKeyEnv !== undefined) return readVariable(name, fields.apiKeyEnv, env)
  const preset = presetOf(fields.preset)
  const variable = preset?.apiKeyEnv
  if (preset === undefined || variable === undefined) return NO_KEY
  const notSent = (reason: string, remedy: string): KeyReading => ({ apiKey: undefined, issues: [], warnings: [`${configPath(['providers', name, 'baseUrl'])}: ${reason}, so ${variable} is not sent: set ${remedy} to send a key`] })
  if (!presetKey) return notSent('is not the endpoint of the research provider', VOTER_KEY)
  if (!atPresetOrigin(fields.preset, preset, baseUrlOf(fields))) return notSent(`is not the endpoint of the ${fields.preset} preset`, 'apiKeyEnv')
  return readVariable(name, variable, env)
}

/** The warnings of a key that is sent over plain http to a host other than this machine. */
function cleartextWarnings(name: string, apiKey: string | undefined, baseUrl: string | undefined): string[] {
  const origin = httpOrigin(baseUrl)
  if (!apiKey || origin === undefined || !origin.startsWith('http:') || isThisMachine(hostOf(origin))) return []
  return [`${configPath(['providers', name, 'baseUrl'])}: sends the key over plain http to a host other than this machine`]
}

interface CheckedSpec {
  readonly spec: Omit<ProviderSpec, 'id'>
  readonly issues: ConfigIssue[]
  readonly warnings: string[]
}

/**
 * One provider's spec, checked by the builder. A spec in use gets its key first; one that is not is
 * checked without a key, and none of its variables is read. `presetKey` is false for a provider that
 * is never sent its preset's key variable.
 */
function checkSpec(name: string, entry: ProviderSettings, inUse: boolean, env: Env, presetKey: boolean): CheckedSpec {
  const fields = ownFields(entry)
  const key = inUse ? readKey(name, fields, env, presetKey) : NO_KEY
  const { apiKeyEnv: _apiKeyEnv, apiKey: _apiKey, ...rest } = fields
  // The builder refuses a spec with no model, and a spec it refuses is never kept.
  const spec = (key.apiKey === undefined ? rest : { ...rest, apiKey: key.apiKey }) as Omit<ProviderSpec, 'id'>
  const issues = [...key.issues]
  try {
    buildProvider({ ...spec, id: name })
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    issues.push(...error.issues.map(({ path, message }) => ({ path: `providers.${path}`, message })))
  }
  return { spec, issues, warnings: [...key.warnings, ...cleartextWarnings(name, key.apiKey, baseUrlOf(fields))] }
}

/** A copy of a spec, field by field, so the config's own objects stay out of the resolved config; or an issue at each field that cannot be copied, which never repeats what it holds. */
function copySpec(name: string, spec: Omit<ProviderSpec, 'id'>): { readonly copy: Omit<ProviderSpec, 'id'> } | { readonly issues: ConfigIssue[] } {
  const copies: Array<[string, unknown]> = []
  const issues: ConfigIssue[] = []
  for (const [field, value] of Object.entries(spec)) {
    try {
      copies.push([field, structuredClone(value)])
    } catch {
      issues.push({ path: configPath(['providers', name, field]), message: 'cannot be copied' })
    }
  }
  return issues.length > 0 ? { issues } : { copy: Object.fromEntries(copies) as Omit<ProviderSpec, 'id'> }
}

/** Every provider of the config checked by the builder, and the specs and objects a profile uses. `withheld` names the provider that is never sent its preset's key variable. */
function checkProviders(providers: Readonly<Record<string, ProviderEntry>>, inUse: ReadonlySet<string>, env: Env, withheld: string | undefined): { providers: Array<[string, ResolvedProvider]>, issues: ConfigIssue[], warnings: string[] } {
  const result: Array<[string, ResolvedProvider]> = []
  const issues: ConfigIssue[] = []
  const warnings: string[] = []
  for (const [name, entry] of Object.entries(providers)) {
    const used = inUse.has(name)
    if (isProvider(entry)) {
      if (used) result.push([name, entry])
      continue
    }
    const checked = checkSpec(name, entry, used, env, name !== withheld)
    issues.push(...checked.issues)
    warnings.push(...checked.warnings)
    if (!used) continue
    const copied = copySpec(name, checked.spec)
    if ('issues' in copied) issues.push(...copied.issues)
    else result.push([name, copied.copy])
  }
  return { providers: result, issues, warnings }
}

/**
 * A missing model is reported where the user sets it. The built-in default's is what to set, not that a
 * field of a provider nobody wrote is missing. A derived voter's is `QUORUM_VOTER_MODEL`, which the role
 * overrides already reported (`reportedVoter` names it then): the builder's second report is dropped.
 */
function reportMissingModel(issues: readonly ConfigIssue[], builtIn: boolean, reportedVoter: string | undefined): ConfigIssue[] {
  return issues.flatMap((issue) => {
    if (issue.message !== 'is required') return [issue]
    if (builtIn && issue.path === `providers.${DEFAULT_NAME}.model`) return [{ path: '', message: NO_MODEL }]
    return reportedVoter !== undefined && issue.path === `providers.${reportedVoter}.model` ? [] : [issue]
  })
}

/** The origin of a provider's settings, as endpoints are compared; none for a provider object. */
function originOf(entry: ProviderEntry | undefined): string | undefined {
  return entry === undefined || isProvider(entry) ? undefined : httpOrigin(baseUrlOf(ownFields(entry)))
}

/** The providers research and the voter are bound to: `roles`, else the only provider, else research. Or the issues of the roles. */
function bindRoles(roles: ConfigInput['roles'], names: readonly string[]): { readonly roles?: RoleBinding, readonly issues: ConfigIssue[] } {
  const named = { research: own(roles, 'research'), voter: own(roles, 'voter') }
  const research = named.research ?? (names.length === 1 ? names[0] : undefined)
  const voter = named.voter ?? research
  const issues: ConfigIssue[] = []
  if (research === undefined) issues.push({ path: 'roles.research', message: 'is required when several providers are defined' })
  else if (!names.includes(research)) issues.push(unknownName('roles.research', 'provider', research, names))
  if (named.voter !== undefined && !names.includes(named.voter)) issues.push(unknownName('roles.voter', 'provider', named.voter, names))
  return research === undefined || voter === undefined || issues.length > 0 ? { issues } : { roles: { research, voter }, issues }
}

/**
 * Resolve a config and the environment into the providers and profiles a run uses: the `QUORUM_*`
 * variables over the config, the built-in `default` provider when the config defines none, the roles,
 * the profiles that run, and the key of each provider they use. Every provider is checked by the builder,
 * the ones that are not used without a key. A key is sent only to the endpoint it was configured for: a
 * preset's own variable is read only at the preset's origin. A resolved config is returned as it is. The
 * input must already have passed a config schema.
 *
 * @throws ConfigError with every issue at once, none of which repeats a value
 */
export function resolveConfig(input: ConfigInput | ResolvedConfig, options: { readonly env: Env }): ResolvedConfig {
  if (isResolvedConfig(input)) return input
  const { env } = options
  const layer = readEnv(env)
  const defined = Object.entries(own(input, 'providers') ?? {})
  const builtIn = defined.length === 0
  const entries: Array<[string, ProviderEntry]> = builtIn ? [[DEFAULT_NAME, DEFAULT_PROVIDER]] : defined

  const bound = bindRoles(own(input, 'roles'), entries.map(([name]) => name))
  if (layer.issues.length > 0 || bound.issues.length > 0 || bound.roles === undefined) throw new ConfigError([...layer.issues, ...bound.issues])

  // Read as own fields: a polluted `Object.prototype` selects no profile.
  const ids = own(layer, 'profiles')
  const applied = applyRoleOverrides(Object.fromEntries(entries), bound.roles, layer)
  const profiles = resolveProfiles({
    profiles: own(input, 'profiles'),
    selection: ids === undefined ? undefined : { ids, path: 'QUORUM_PROFILES' },
    roles: applied.roles,
    providers: Object.keys(applied.providers),
  })
  const inUse = new Set(profiles.profiles.flatMap(({ research, voters }) => [research, ...Object.values(voters)]))
  // The voter the variables derived is the one the role moved to. On another origin than research's, with no
  // preset of its own, it is never sent a preset's key variable: that is research's key by another name (ADR-0013).
  const derived = applied.roles.voter === bound.roles.voter ? undefined : applied.roles.voter
  const elsewhere = derived !== undefined && own(layer.voter, 'preset') === undefined && originOf(applied.providers[derived]) !== originOf(applied.providers[applied.roles.research])
  const checked = checkProviders(applied.providers, inUse, env, elsewhere ? derived : undefined)

  const reportedVoter = applied.issues.some(issue => issue.path === VOTER_MODEL) ? derived : undefined
  const issues = [...applied.issues, ...profiles.issues, ...atVariables(reportMissingModel(checked.issues, builtIn, reportedVoter), applied.roles, layer)]
  if (issues.length > 0) throw new ConfigError(issues)

  const concurrency = own(input, 'concurrency')
  const maxFindings = own(input, 'maxFindings')
  const resolved: ResolvedConfig = Object.freeze({
    providers: deepFreeze(Object.fromEntries(checked.providers)),
    profiles: Object.freeze([...profiles.profiles]),
    ...concurrency === undefined ? {} : { concurrency },
    ...maxFindings === undefined ? {} : { maxFindings },
    warnings: Object.freeze([...layer.warnings, ...checked.warnings]),
  })
  RESOLVED.add(resolved)
  return resolved
}
