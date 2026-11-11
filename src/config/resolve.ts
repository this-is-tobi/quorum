import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { Provider } from '../core/ports.ts'
import { buildProvider, isClaudeCode } from '../providers/build.ts'
import type { ProviderSpec } from '../providers/build.ts'
import { httpOrigin } from '../providers/http.ts'
import { CONTEXT_REQUIRED } from '../providers/options.ts'
import { presetOf, withoutPrototype } from '../providers/presets.ts'
import type { Preset } from '../providers/presets.ts'
import { billingWarnings, claudeCodeCommand } from './claude-code.ts'
import type { CommandLookup } from './claude-code.ts'
import { applyRoleOverrides, atVariables, baseUrlOf, envValue, namesModelOrEndpoint, PROFILE_ID, readEnv, setsContextSize, VARIABLE_NAME } from './env.ts'
import type { Env, EnvLayer, ProviderEntry, RoleBinding } from './env.ts'
import { own, resolveProfiles } from './profiles.ts'
import type { ProfileSelection, ResolvedProfile } from './profiles.ts'
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
const NO_CONTEXT = 'no context size configured: set QUORUM_RESEARCH_CONTEXT_TOKENS, or name a config file that sets contextTokens'
const VOTER_KEY = 'QUORUM_VOTER_API_KEY'
const VOTER_MODEL = 'QUORUM_VOTER_MODEL'
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/
/** The variable `claude` reads its key from, and so the one `api-key` mode reads when `apiKeyEnv` names none. */
const CLAUDE_KEY_VARIABLE = 'ANTHROPIC_API_KEY'

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

/** What a provider in use that runs `claude` gets besides its key: the executable found, or why not, and the warning of a key that is billed. */
interface ClaudeReading extends CommandLookup {
  readonly warnings: readonly string[]
}

const NO_CLAUDE: ClaudeReading = Object.freeze({ issues: Object.freeze([]), warnings: Object.freeze([]) })

/** The key a variable holds, or the issue that it is not set. */
function readVariable(name: string, variable: string, env: Env): KeyReading {
  const apiKey = envValue(env, variable)
  return { apiKey, issues: apiKey === undefined ? [unsetKey(name, variable)] : [], warnings: [] }
}

/**
 * The key of a spec that a profile uses: its own `apiKey` (an empty one is unset, as a blank variable is),
 * else the variable `apiKeyEnv` names, else its preset's own variable, which is read only while the base URL is the preset's endpoint (I1) and `presetKey`
 * allows it: at another endpoint it is not read, and the warning says so. A `claude-code` spec has no preset: its key is
 * `apiKeyEnv`'s variable, else `ANTHROPIC_API_KEY`, under `api-key`, and none under another mode, where an
 * `apiKeyEnv` is refused.
 */
function readKey(name: string, fields: ProviderSettings, env: Env, presetKey: boolean): KeyReading {
  // A key variable no mode would send is refused where it is written, and never read.
  if (isClaudeCode(fields.protocol) && fields.apiKeyEnv !== undefined && fields.auth !== 'api-key') return { apiKey: undefined, issues: [{ path: configPath(['providers', name, 'apiKeyEnv']), message: 'is set, but auth is not api-key' }], warnings: [] }
  if (fields.apiKey !== undefined && fields.apiKey !== '') return { apiKey: fields.apiKey, issues: [], warnings: [] }
  if (fields.apiKeyEnv !== undefined) return readVariable(name, fields.apiKeyEnv, env)
  if (isClaudeCode(fields.protocol)) return fields.auth === 'api-key' ? readVariable(name, CLAUDE_KEY_VARIABLE, env) : NO_KEY
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

/** The `claude` of a provider in use, when it runs one: found by `claudeCodeCommand`, with the billing warning. */
function readClaude(name: string, fields: ProviderSettings, env: Env, variable: string | undefined): ClaudeReading {
  if (!isClaudeCode(fields.protocol)) return NO_CLAUDE
  return { ...claudeCodeCommand(name, fields, variable, env), warnings: billingWarnings(name, fields, env) }
}

/**
 * One provider's spec, checked by the builder. A spec in use gets its key first, and its `claude` when it
 * runs one (`command` is the one of `QUORUM_CLAUDE_CODE_COMMAND`, if set); one that is not is checked without
 * a key or a command, and none of its variables is read. `presetKey` is false for a provider that is never
 * sent its preset's key variable.
 */
function checkSpec(name: string, entry: ProviderSettings, inUse: boolean, env: Env, presetKey: boolean, command: string | undefined): CheckedSpec {
  const fields = ownFields(entry)
  const key = inUse ? readKey(name, fields, env, presetKey) : NO_KEY
  const claude = inUse ? readClaude(name, fields, env, command) : NO_CLAUDE
  const { apiKeyEnv: _apiKeyEnv, apiKey: _apiKey, ...rest } = fields
  // The builder refuses a spec with no model, and a spec it refuses is never kept.
  const spec = { ...rest, ...key.apiKey === undefined ? {} : { apiKey: key.apiKey }, ...claude.command === undefined ? {} : { command: claude.command } } as Omit<ProviderSpec, 'id'>
  const issues = [...key.issues, ...claude.issues]
  try {
    buildProvider({ ...spec, id: name }, { env })
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    issues.push(...error.issues.map(({ path, message }) => ({ path: `providers.${path}`, message })))
  }
  return { spec, issues, warnings: [...key.warnings, ...claude.warnings, ...cleartextWarnings(name, key.apiKey, baseUrlOf(fields))] }
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

/** Every provider of the config checked by the builder, and the specs and objects a profile uses. `withheld` names the provider that is never sent its preset's key variable, `command` is `QUORUM_CLAUDE_CODE_COMMAND`'s. An issue two providers share (the variable names no file) is reported once. */
function checkProviders(providers: Readonly<Record<string, ProviderEntry>>, inUse: ReadonlySet<string>, env: Env, withheld: string | undefined, command: string | undefined): { providers: Array<[string, ResolvedProvider]>, issues: ConfigIssue[], warnings: string[] } {
  const result: Array<[string, ResolvedProvider]> = []
  const issues: ConfigIssue[] = []
  const warnings: string[] = []
  for (const [name, entry] of Object.entries(providers)) {
    const used = inUse.has(name)
    if (isProvider(entry)) {
      if (used) result.push([name, entry])
      continue
    }
    const checked = checkSpec(name, entry, used, env, name !== withheld, command)
    issues.push(...checked.issues.filter(issue => !issues.some(({ path, message }) => path === issue.path && message === issue.message)))
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

/** The issue of a role whose variables name a model or an endpoint and set no context size: the variable to set, and why. */
function contextOfRole(role: 'research' | 'voter'): ConfigIssue {
  return { path: `QUORUM_${role.toUpperCase()}_CONTEXT_TOKENS`, message: `must be set when the ${role} variables name a model or an endpoint: a context size belongs to one model on one endpoint` }
}

/** What `reportMissingContext` needs of the run: whether the provider is the built-in one, the roles after the variables, the name of the voter they derived, and the variables. */
interface ContextReport {
  readonly builtIn: boolean
  readonly roles: RoleBinding
  readonly derived: string | undefined
  readonly layer: Pick<EnvLayer, 'research' | 'voter'>
}

/**
 * A missing context size is reported where the user sets it, by the first rule that applies to a provider:
 * the built-in default's is what to set; the voter the variables derived, when they name a model or an
 * endpoint, is `QUORUM_VOTER_CONTEXT_TOKENS`; the research provider, when the research variables name a
 * model or an endpoint, is `QUORUM_RESEARCH_CONTEXT_TOKENS`, and the voter's own provider the voter's
 * variable on the same condition; any other stays at its field. A derived voter that shares the research
 * provider whole, its context size included, is reported by the research provider's issue alone, whatever
 * the issue on that size is (missing, malformed or leaving no room for `maxTokens`): the user wrote one value.
 */
function reportMissingContext(issues: readonly ConfigIssue[], { builtIn, roles, derived, layer }: ContextReport): ConfigIssue[] {
  const voterNames = namesModelOrEndpoint(layer.voter)
  const shared = derived !== undefined && !voterNames && !setsContextSize(layer.voter)
  const voterOwn = roles.voter !== roles.research && roles.voter !== derived ? roles.voter : undefined
  return issues.flatMap((issue) => {
    const at = (name: string | undefined): boolean => name !== undefined && issue.path === `providers.${name}.contextTokens`
    if (shared && at(derived)) return []
    if (issue.message !== CONTEXT_REQUIRED) return [issue]
    if (builtIn && at(DEFAULT_NAME)) return [{ path: '', message: NO_CONTEXT }]
    if (at(derived) || at(voterOwn)) return voterNames ? [contextOfRole('voter')] : [issue]
    if (at(roles.research)) return namesModelOrEndpoint(layer.research) ? [contextOfRole('research')] : [issue]
    return [issue]
  })
}

/** The origin of a provider's settings, as endpoints are compared; none for a provider object. */
function originOf(entry: ProviderEntry | undefined): string | undefined {
  return entry === undefined || isProvider(entry) ? undefined : httpOrigin(baseUrlOf(ownFields(entry)))
}

/** The issues of a selection's ids, each at most once and never naming an id: one for a form, one for a repeat. */
function selectionIssues({ ids, path }: ProfileSelection): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!ids.every(id => PROFILE_ID.test(id))) issues.push({ path, message: `must be a profile id matching ${PROFILE_ID.source}` })
  if (new Set(ids).size < ids.length) issues.push({ path, message: 'names a profile more than once' })
  return issues
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
 * preset's own variable is read only at the preset's origin. Every provider needs a context size, and the issue
 * of a missing one names what to set (`reportMissingContext`). A `claude-code` provider in use gets its
 * command as it gets its key: `QUORUM_CLAUDE_CODE_COMMAND`, else the config's, else `claude` in an absolute
 * entry of `PATH`, found or refused here, and its billing warning. A resolved config is returned as it is. The
 * input must already have passed a config schema. `options.selection`, when given, names the profiles that
 * run, over `QUORUM_PROFILES`, which is still checked; its ids are checked before anything is resolved.
 *
 * @throws ConfigError with every issue at once, none of which repeats a value
 */
export function resolveConfig(input: ConfigInput | ResolvedConfig, options: { readonly env: Env, readonly selection?: ProfileSelection }): ResolvedConfig {
  if (isResolvedConfig(input)) return input
  const { env, selection } = options
  const layer = readEnv(env)
  const defined = Object.entries(own(input, 'providers') ?? {})
  const builtIn = defined.length === 0
  const entries: Array<[string, ProviderEntry]> = builtIn ? [[DEFAULT_NAME, DEFAULT_PROVIDER]] : defined

  const bound = bindRoles(own(input, 'roles'), entries.map(([name]) => name))
  const refused = selection === undefined ? [] : selectionIssues(selection)
  if (layer.issues.length > 0 || refused.length > 0 || bound.issues.length > 0 || bound.roles === undefined) throw new ConfigError([...layer.issues, ...refused, ...bound.issues])

  // The environment layer's profiles are read as own fields, so a polluted `Object.prototype` selects none
  // through `QUORUM_PROFILES`; `options.selection` is read directly, as the caller gave it.
  const ids = own(layer, 'profiles')
  const applied = applyRoleOverrides(Object.fromEntries(entries), bound.roles, layer)
  const profiles = resolveProfiles({
    profiles: own(input, 'profiles'),
    selection: selection ?? (ids === undefined ? undefined : { ids, path: 'QUORUM_PROFILES' }),
    roles: applied.roles,
    providers: Object.keys(applied.providers),
  })
  const inUse = new Set(profiles.profiles.flatMap(({ research, voters }) => [research, ...Object.values(voters)]))
  // The voter the variables derived is the one the role moved to. On another origin than research's, with no
  // preset of its own, it is never sent a preset's key variable: that is research's key by another name (ADR-0013).
  const derived = applied.roles.voter === bound.roles.voter ? undefined : applied.roles.voter
  const elsewhere = derived !== undefined && own(layer.voter, 'preset') === undefined && originOf(applied.providers[derived]) !== originOf(applied.providers[applied.roles.research])
  const checked = checkProviders(applied.providers, inUse, env, elsewhere ? derived : undefined, own(layer, 'claudeCodeCommand'))

  const reportedVoter = applied.issues.some(issue => issue.path === VOTER_MODEL) ? derived : undefined
  const reported = reportMissingContext(reportMissingModel(checked.issues, builtIn, reportedVoter), { builtIn, roles: applied.roles, derived, layer })
  const issues = [...applied.issues, ...profiles.issues, ...atVariables(reported, applied.roles, layer)]
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
