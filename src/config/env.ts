import type { ConfigIssue } from '../core/errors.ts'
import type { Provider } from '../core/ports.ts'
import { httpOrigin } from '../providers/http.ts'
import { wordList } from '../providers/options.ts'
import { presetOf } from '../providers/presets.ts'
import { own } from './profiles.ts'
import { configPath, isProvider, unknownName } from './schema.ts'
import type { ProviderSettings } from './schema.ts'

/** The environment: a process's, or the one a caller hands over. */
export type Env = Readonly<Record<string, string | undefined>>

/**
 * One variable of the environment, trimmed, as `fetch` always trimmed a header value: a pasted newline must
 * not break a key. A blank variable is unset, and so is one the environment only inherits from its prototype.
 */
export function envValue(env: Env, name: string): string | undefined {
  return Object.hasOwn(env, name) ? env[name]?.trim() || undefined : undefined
}

/** What the variables of one role set: only the variables that are set. `contextTokens` is `QUORUM_<ROLE>_CONTEXT_TOKENS`, read as a whole number. */
export interface RoleOverrides {
  readonly preset?: string
  readonly protocol?: string
  readonly baseUrl?: string
  readonly model?: string
  readonly contextTokens?: number
  readonly apiKey?: string
}

/** What the environment holds for the config layer. */
export interface EnvLayer {
  /** The profiles `QUORUM_PROFILES` selects; unset when it is, or when it is refused. */
  readonly profiles?: readonly string[]
  readonly research: RoleOverrides
  readonly voter: RoleOverrides
  /** The deprecation line, when an alias is set, then the line naming the `QUORUM_` variables nothing reads. */
  readonly warnings: readonly string[]
  readonly issues: readonly ConfigIssue[]
}

type Role = 'RESEARCH' | 'VOTER'

/** The variables of a role, in the order issues name them; those with an alias are read as `<ROLE>_<suffix>` too. */
const VARIABLES: ReadonlyArray<{ readonly field: keyof RoleOverrides, readonly suffix: string, readonly aliased: boolean }> = [
  { field: 'preset', suffix: 'PRESET', aliased: false },
  { field: 'protocol', suffix: 'PROTOCOL', aliased: false },
  { field: 'baseUrl', suffix: 'BASE_URL', aliased: true },
  { field: 'model', suffix: 'MODEL', aliased: true },
  { field: 'contextTokens', suffix: 'CONTEXT_TOKENS', aliased: false },
  { field: 'apiKey', suffix: 'API_KEY', aliased: true },
]
const ROLES: readonly Role[] = ['RESEARCH', 'VOTER']
/** Each role as `RoleBinding` names it, with its variables' prefix. */
const BINDINGS = [['research', 'RESEARCH'], ['voter', 'VOTER']] as const
/** The aliases in the order the deprecation line lists them, role by role. */
const ALIAS_SUFFIXES = ['BASE_URL', 'API_KEY', 'MODEL']
/** The form of a profile id: what `QUORUM_PROFILES` and a selection of profiles may name. */
export const PROFILE_ID = /^[a-z][a-z0-9_-]*$/
/** The only variable names a message prints: a key pasted where a name belongs must never show. */
export const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

const canonicalName = (role: Role, suffix: string): string => `QUORUM_${role}_${suffix}`

/**
 * Every variable the environment layer reads: `QUORUM_CONFIG`, `QUORUM_PROFILES`, the `QUORUM_` form of each role's
 * variables and the deprecated aliases of those that have one. The one list: a variable added to `VARIABLES` joins it.
 */
export const READ_VARIABLES: ReadonlySet<string> = new Set([
  'QUORUM_CONFIG',
  'QUORUM_PROFILES',
  ...ROLES.flatMap(role => VARIABLES.map(({ suffix }) => canonicalName(role, suffix))),
  ...ROLES.flatMap(role => VARIABLES.filter(({ aliased }) => aliased).map(({ suffix }) => `${role}_${suffix}`)),
])

/** A context size variable: a whole number of tokens, written in decimal digits, from 1 to 999999999. */
const CONTEXT_TOKENS = /^[1-9]\d{0,8}$/
const CONTEXT_TOKENS_FORM = 'must be a whole number of tokens, from 1 to 999999999'

/**
 * The variables of one role that are set, each as its field and value: the `QUORUM_` form, else its alias. A
 * context size that is not a whole number in range sets nothing and is an issue at its variable, which never repeats it.
 */
function readRole(env: Env, role: Role): { overrides: RoleOverrides, issues: ConfigIssue[] } {
  const entries: Array<[string, string | number]> = []
  const issues: ConfigIssue[] = []
  for (const { field, suffix, aliased } of VARIABLES) {
    const name = canonicalName(role, suffix)
    const value = envValue(env, name) ?? (aliased ? envValue(env, `${role}_${suffix}`) : undefined)
    if (value === undefined) continue
    if (field !== 'contextTokens') entries.push([field, value])
    else if (CONTEXT_TOKENS.test(value)) entries.push([field, Number(value)])
    else issues.push({ path: name, message: CONTEXT_TOKENS_FORM })
  }
  return { overrides: Object.fromEntries(entries), issues }
}

/** The one deprecation line: every alias that is set, whether or not its `QUORUM_` form won, and what to set instead. */
function deprecationWarnings(env: Env): string[] {
  const aliases = ROLES.flatMap(role => ALIAS_SUFFIXES.filter(suffix => envValue(env, `${role}_${suffix}`) !== undefined).map(suffix => [`${role}_${suffix}`, canonicalName(role, suffix)] as const))
  if (aliases.length === 0) return []
  const verb = aliases.length === 1 ? 'is' : 'are'
  return [`${wordList(aliases.map(([alias]) => alias), 'and')} ${verb} deprecated: set ${wordList(aliases.map(([, canonical]) => canonical), 'and')} instead`]
}

/**
 * The one line that names every variable set under a `QUORUM_` name that quorum does not read, sorted, so a
 * typo is seen. A name that is not an upper-case variable name prints as `*`, and no value is ever printed.
 */
function unreadWarnings(env: Env): string[] {
  const names = Object.keys(env).filter(name => name.startsWith('QUORUM_') && !READ_VARIABLES.has(name) && envValue(env, name) !== undefined).sort()
  if (names.length === 0) return []
  const printed = names.map(name => VARIABLE_NAME.test(name) ? name : '*')
  return [names.length === 1 ? `${printed[0]} is not a variable quorum reads` : `${wordList(printed, 'and')} are not variables quorum reads`]
}

/** The profile ids of `QUORUM_PROFILES`, or the one issue that refuses it. Neither repeats the value. */
function readProfiles(env: Env): Pick<EnvLayer, 'profiles' | 'issues'> {
  const value = envValue(env, 'QUORUM_PROFILES')
  if (value === undefined) return { issues: [] }
  const ids = value.split(',').map(id => id.trim())
  if (!ids.every(id => PROFILE_ID.test(id))) return { issues: [{ path: 'QUORUM_PROFILES', message: `must list profile ids separated by commas, each matching ${PROFILE_ID.source}` }] }
  if (new Set(ids).size < ids.length) return { issues: [{ path: 'QUORUM_PROFILES', message: 'names a profile more than once' }] }
  return { profiles: ids, issues: [] }
}

/**
 * Read the `QUORUM_*` variables: the preset, protocol, base URL, model, context size and key of each role,
 * which are `QUORUM_RESEARCH_*` and `QUORUM_VOTER_*`, and `QUORUM_PROFILES`. `RESEARCH_*` and `VOTER_*` are
 * read as deprecated aliases of the base URL, model and key, and the `QUORUM_` form wins; the context size
 * (`QUORUM_RESEARCH_CONTEXT_TOKENS`, `QUORUM_VOTER_CONTEXT_TOKENS`) has no alias. Any other variable set under
 * a `QUORUM_` name is named in one warning. No message repeats a value.
 */
export function readEnv(env: Env): EnvLayer {
  const { issues: profileIssues, ...profiles } = readProfiles(env)
  const research = readRole(env, 'RESEARCH')
  const voter = readRole(env, 'VOTER')
  return {
    ...profiles,
    research: research.overrides,
    voter: voter.overrides,
    warnings: [...deprecationWarnings(env), ...unreadWarnings(env)],
    issues: [...profileIssues, ...research.issues, ...voter.issues],
  }
}

/** A provider of a config: its settings, or an object implementing `Provider`. */
export type ProviderEntry = ProviderSettings | Provider

/** The names of the providers the research and the voter roles are bound to. */
export interface RoleBinding {
  readonly research: string
  readonly voter: string
}

/** The base URL of a provider's settings: their own, else their preset's. Both are read as own fields, so a polluted `Object.prototype` sets neither. */
export function baseUrlOf(settings: ProviderSettings): string | undefined {
  return own(settings, 'baseUrl') ?? presetOf(own(settings, 'preset'))?.baseUrl
}

type Variable = (typeof VARIABLES)[number]

/** Whether the overrides set `field`: an own field, and one that is defined. */
function isSet(overrides: RoleOverrides, field: keyof RoleOverrides): boolean {
  return Object.hasOwn(overrides, field) && overrides[field] !== undefined
}

/** The variables of a role that are set, in the order issues name them. */
function setVariables(overrides: RoleOverrides): Variable[] {
  return VARIABLES.filter(({ field }) => isSet(overrides, field))
}

/** The fields that name a model on an endpoint: a context size describes what they name. */
const MODEL_OR_ENDPOINT: readonly (keyof RoleOverrides)[] = ['preset', 'protocol', 'baseUrl', 'model']

/** Whether the variables of a role name a preset, a protocol, a base URL or a model: another model, or another endpoint, than the provider they are set on. */
export function namesModelOrEndpoint(overrides: RoleOverrides): boolean {
  return MODEL_OR_ENDPOINT.some(field => isSet(overrides, field))
}

/** Whether a provider's context size stays when these variables are set on it: unless they name a model or an endpoint and set no context size of their own. */
function keepsContext(overrides: RoleOverrides): boolean {
  return !namesModelOrEndpoint(overrides) || isSet(overrides, 'contextTokens')
}

/** The settings the variables are set on: as they are, or without their context size when it would not describe the model the variables name. */
function inheritedBy(overrides: RoleOverrides, settings: ProviderSettings): ProviderSettings {
  if (keepsContext(overrides)) return settings
  const { contextTokens: _contextTokens, ...rest } = settings
  return rest
}

/** The fields the variables set, as a record of only those. */
function fieldsOf(overrides: RoleOverrides, variables: readonly Variable[]): Partial<ProviderSettings> {
  return Object.fromEntries(variables.map(({ field }) => [field, overrides[field]])) as Partial<ProviderSettings>
}

/** Whether the variables name a preset or a protocol: the provider is then theirs alone, since a preset's defaults and another's explicit fields conflict. */
function startsAfresh(variables: readonly Variable[]): boolean {
  return variables.some(({ field }) => field === 'preset' || field === 'protocol')
}

/** The settings with the fields the variables set, or those fields alone when the variables name a preset or a protocol; the context size stays only while the variables name no model or endpoint, unless they set one. */
function withVariables(settings: ProviderSettings, overrides: RoleOverrides, variables: readonly Variable[]): ProviderSettings {
  return { ...startsAfresh(variables) ? {} : inheritedBy(overrides, settings), ...fieldsOf(overrides, variables) }
}

/** One issue per variable set, at that variable: none of them can change a provider object. */
function objectIssues(role: Role, variables: readonly Variable[], providerName: string): ConfigIssue[] {
  return variables.map(({ suffix }) => ({ path: canonicalName(role, suffix), message: `cannot change ${configPath(['providers', providerName])}, an object implementing Provider` }))
}

/** The provider the voter variables derive from the research provider `base`: all of it on the same endpoint, and nothing that is a secret, a model or the context size of that model elsewhere (ADR-0013). Its context size crosses only while the variables name no model or endpoint. */
function derivedVoter(base: ProviderSettings, overrides: RoleOverrides, variables: readonly Variable[]): { provider: ProviderSettings, issues: ConfigIssue[] } {
  const fields = fieldsOf(overrides, variables)
  const origin = httpOrigin(baseUrlOf(base))
  const sameEndpoint = origin !== undefined && origin === httpOrigin(own(fields, 'baseUrl') ?? baseUrlOf(base))
  const { apiKeyEnv: _apiKeyEnv, apiKey: _apiKey, headers: _headers, query: _query, extraBody: _extraBody, model: _model, contextTokens: _contextTokens, ...endpoint } = base
  const provider: ProviderSettings = startsAfresh(variables) ? fields : { ...inheritedBy(overrides, sameEndpoint ? base : endpoint), ...fields }
  const needsModel = (startsAfresh(variables) || !sameEndpoint) && provider.model === undefined
  return { provider, issues: needsModel ? [{ path: canonicalName('VOTER', 'MODEL'), message: 'must be set when the voter variables name another endpoint than the research provider\'s' }] : [] }
}

/** One issue per role bound to a name that is not an own key of `providers`: a role is never assumed to be bound. */
function unboundRoles(providers: Readonly<Record<string, ProviderEntry>>, roles: RoleBinding): ConfigIssue[] {
  const names = Object.keys(providers)
  return BINDINGS.filter(([role]) => !Object.hasOwn(providers, roles[role])).map(([role]) => unknownName(`roles.${role}`, 'provider', roles[role], names))
}

/**
 * Set the variables of each role on its provider. The research variables go on the provider research is
 * bound to. The voter variables go on the voter's own provider, or, when the voter shares the research
 * provider, derive a provider named `voter` from it: a copy on the same endpoint, and on another one a copy
 * with no key, header, query, body field, model or context size (ADR-0013). A preset or a protocol variable
 * builds the role's provider from its variables alone. A context size describes one model on one endpoint,
 * so it crosses to neither: a role's variables that name a preset, a protocol, a base URL or a model drop the
 * context size of the provider they are set on, the derived voter's included, unless they set one; a key
 * variable alone leaves it. A provider object cannot be changed: each variable aimed at one
 * is an issue. Nothing it is given changes; nested objects are shared. A role bound to a name that is not an
 * own key of `providers` is an issue at that role, and nothing is applied.
 */
export function applyRoleOverrides(
  providers: Readonly<Record<string, ProviderEntry>>,
  roles: RoleBinding,
  layer: Pick<EnvLayer, 'research' | 'voter'>,
): { providers: Record<string, ProviderEntry>, roles: RoleBinding, issues: ConfigIssue[] } {
  const unbound = unboundRoles(providers, roles)
  if (unbound.length > 0) return { providers: { ...providers }, roles, issues: unbound }
  const issues: ConfigIssue[] = []
  let result: Record<string, ProviderEntry> = { ...providers }
  const setOn = (role: Role, name: string, overrides: RoleOverrides, variables: readonly Variable[]): void => {
    const entry = result[name]!
    if (isProvider(entry)) issues.push(...objectIssues(role, variables, name))
    else result = { ...result, [name]: withVariables(entry, overrides, variables) }
  }

  const researchVariables = setVariables(layer.research)
  if (researchVariables.length > 0) setOn('RESEARCH', roles.research, layer.research, researchVariables)

  const voterVariables = setVariables(layer.voter)
  let voterRole = roles.voter
  if (voterVariables.length > 0 && roles.voter !== roles.research) {
    setOn('VOTER', roles.voter, layer.voter, voterVariables)
  } else if (voterVariables.length > 0) {
    const base = result[roles.research]!
    if (Object.hasOwn(result, 'voter')) {
      issues.push({ path: configPath(['providers', 'voter']), message: 'is the name the voter variables give the provider they derive: rename this provider' })
    } else if (isProvider(base)) {
      issues.push(...objectIssues('VOTER', voterVariables, roles.research))
    } else {
      const derived = derivedVoter(base, layer.voter, voterVariables)
      issues.push(...derived.issues)
      result = { ...result, voter: derived.provider }
      voterRole = 'voter'
    }
  }
  return { providers: result, roles: { research: roles.research, voter: voterRole }, issues }
}

/**
 * `issues` of the builder, each one on a field a variable set moved to that variable, as its `QUORUM_` name
 * (`QUORUM_RESEARCH_PRESET: must be one of ...`, not `providers.default.preset`): the user wrote the variable,
 * and never that provider's field. The other issues stay where they are. `roles` is the binding after the
 * variables were applied.
 */
export function atVariables(issues: readonly ConfigIssue[], roles: RoleBinding, layer: Pick<EnvLayer, 'research' | 'voter'>): ConfigIssue[] {
  const named = new Map<string, string>()
  for (const [role, prefix] of BINDINGS) {
    // A voter bound to the research provider set none of its fields: its variables derive a provider of their own.
    if (role === 'voter' && roles.voter === roles.research) continue
    for (const { field, suffix } of setVariables(layer[role])) named.set(configPath(['providers', roles[role], field]), canonicalName(prefix, suffix))
  }
  return issues.map(issue => ({ ...issue, path: named.get(issue.path) ?? issue.path }))
}
