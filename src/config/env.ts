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

/** What the variables of one role set: only the variables that are set. */
export interface RoleOverrides {
  readonly preset?: string
  readonly protocol?: string
  readonly baseUrl?: string
  readonly model?: string
  readonly apiKey?: string
}

/** What the environment holds for the config layer. */
export interface EnvLayer {
  /** The profiles `QUORUM_PROFILES` selects; unset when it is, or when it is refused. */
  readonly profiles?: readonly string[]
  readonly research: RoleOverrides
  readonly voter: RoleOverrides
  /** The one deprecation line, when an alias is set. */
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
  { field: 'apiKey', suffix: 'API_KEY', aliased: true },
]
const ROLES: readonly Role[] = ['RESEARCH', 'VOTER']
/** Each role as `RoleBinding` names it, with its variables' prefix. */
const BINDINGS = [['research', 'RESEARCH'], ['voter', 'VOTER']] as const
/** The aliases in the order the deprecation line lists them, role by role. */
const ALIAS_SUFFIXES = ['BASE_URL', 'API_KEY', 'MODEL']
const PROFILE_ID = /^[a-z][a-z0-9_-]*$/

const canonicalName = (role: Role, suffix: string): string => `QUORUM_${role}_${suffix}`

/** The variables of one role that are set, each as its field and value: the `QUORUM_` form, else its alias. */
function readRole(env: Env, role: Role): RoleOverrides {
  const entries = VARIABLES.flatMap(({ field, suffix, aliased }): Array<[string, string]> => {
    const value = envValue(env, canonicalName(role, suffix)) ?? (aliased ? envValue(env, `${role}_${suffix}`) : undefined)
    return value === undefined ? [] : [[field, value]]
  })
  return Object.fromEntries(entries)
}

/** The one deprecation line: every alias that is set, whether or not its `QUORUM_` form won, and what to set instead. */
function deprecationWarnings(env: Env): string[] {
  const aliases = ROLES.flatMap(role => ALIAS_SUFFIXES.filter(suffix => envValue(env, `${role}_${suffix}`) !== undefined).map(suffix => [`${role}_${suffix}`, canonicalName(role, suffix)] as const))
  if (aliases.length === 0) return []
  const verb = aliases.length === 1 ? 'is' : 'are'
  return [`${wordList(aliases.map(([alias]) => alias), 'and')} ${verb} deprecated: set ${wordList(aliases.map(([, canonical]) => canonical), 'and')} instead`]
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
 * Read the `QUORUM_*` variables: the preset, protocol, base URL, model and key of each role, which are
 * `QUORUM_RESEARCH_*` and `QUORUM_VOTER_*`, and `QUORUM_PROFILES`. `RESEARCH_*` and `VOTER_*` are read as
 * deprecated aliases of the base URL, model and key, and the `QUORUM_` form wins. No message repeats a value.
 */
export function readEnv(env: Env): EnvLayer {
  return { ...readProfiles(env), research: readRole(env, 'RESEARCH'), voter: readRole(env, 'VOTER'), warnings: deprecationWarnings(env) }
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

/** The variables of a role that are set, in the order issues name them. */
function setVariables(overrides: RoleOverrides): Variable[] {
  return VARIABLES.filter(({ field }) => Object.hasOwn(overrides, field) && overrides[field] !== undefined)
}

/** The fields the variables set, as a record of only those. */
function fieldsOf(overrides: RoleOverrides, variables: readonly Variable[]): Partial<ProviderSettings> {
  return Object.fromEntries(variables.map(({ field }) => [field, overrides[field]])) as Partial<ProviderSettings>
}

/** Whether the variables name a preset or a protocol: the provider is then theirs alone, since a preset's defaults and another's explicit fields conflict. */
function startsAfresh(variables: readonly Variable[]): boolean {
  return variables.some(({ field }) => field === 'preset' || field === 'protocol')
}

/** The settings with the fields the variables set, or those fields alone when the variables name a preset or a protocol. */
function withVariables(settings: ProviderSettings, overrides: RoleOverrides, variables: readonly Variable[]): ProviderSettings {
  return { ...startsAfresh(variables) ? {} : settings, ...fieldsOf(overrides, variables) }
}

/** One issue per variable set, at that variable: none of them can change a provider object. */
function objectIssues(role: Role, variables: readonly Variable[], providerName: string): ConfigIssue[] {
  return variables.map(({ suffix }) => ({ path: canonicalName(role, suffix), message: `cannot change ${configPath(['providers', providerName])}, an object implementing Provider` }))
}

/** The provider the voter variables derive from the research provider `base`: all of it on the same endpoint, and nothing that is a secret or a model of it elsewhere (ADR-0013). */
function derivedVoter(base: ProviderSettings, overrides: RoleOverrides, variables: readonly Variable[]): { provider: ProviderSettings, issues: ConfigIssue[] } {
  const fields = fieldsOf(overrides, variables)
  const origin = httpOrigin(baseUrlOf(base))
  const sameEndpoint = origin !== undefined && origin === httpOrigin(own(fields, 'baseUrl') ?? baseUrlOf(base))
  const { apiKeyEnv: _apiKeyEnv, apiKey: _apiKey, headers: _headers, query: _query, extraBody: _extraBody, model: _model, ...endpoint } = base
  const provider: ProviderSettings = startsAfresh(variables) ? fields : { ...sameEndpoint ? base : endpoint, ...fields }
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
 * with no key, header, query, body field or model (ADR-0013). A preset or a protocol variable builds the
 * role's provider from its variables alone. A provider object cannot be changed: each variable aimed at one
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
