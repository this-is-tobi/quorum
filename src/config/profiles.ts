import { issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { defaultPolicy } from '../core/policy.ts'
import type { PolicyRules, Rule } from '../core/policy.ts'
import { profileIssues } from '../core/profile.ts'
import type { Profile } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import type { RoleBinding } from './env.ts'
import { unknownName } from './schema.ts'
import type { ConfigInput } from './schema.ts'

type ProfileEntry = NonNullable<ConfigInput['profiles']>[string]

/** A profile that runs, with the providers it is bound to. */
export interface ResolvedProfile {
  readonly profile: Profile
  /** The provider that looks for candidate findings. */
  readonly research: string
  /** The provider each lens votes with, by lens id. */
  readonly voters: Readonly<Record<string, string>>
}

/** The profiles a caller selects to run: `QUORUM_PROFILES`, or the flag of the CLI. `path` is what an issue with the ids names. */
export interface ProfileSelection {
  readonly ids: readonly string[]
  readonly path: string
}

/** The built-in profiles a config can run or extend, by id. */
const BUILT_IN: ReadonlyMap<string, Profile> = new Map([
  [securityProfile.id, securityProfile],
])

const NEEDS_BASE = 'is required: the profile extends no built-in profile'
const LEVELS = ['high', 'medium', 'low'] as const

/** A lens as the config gives it, or as a built-in profile holds it, which names no provider. */
interface LensEntry {
  readonly id: string
  readonly question: string
  readonly provider: string | undefined
}

/** A field a record holds itself: a prototype, a polluted one included, fills none. */
export function own<T extends object, K extends keyof T>(record: T | undefined, key: K): T[K] | undefined {
  return record !== undefined && Object.hasOwn(record, key)
    ? record[key]
    : undefined
}

/** A rule as a new frozen value: the config's own objects stay out of a frozen profile. */
function copyRule(rule: Rule): Rule {
  return typeof rule === 'object'
    ? Object.freeze({ ...rule })
    : rule
}

/** The base's policy, else the default one, with the levels the entry sets (not `undefined`) over it. */
function policyOf(base: Profile | undefined, entry: ProfileEntry['policy']): PolicyRules {
  const set = Object.fromEntries(LEVELS.flatMap((level) => {
    const rule = own(entry, level)
    return rule === undefined
      ? []
      : [
          [level, rule],
        ]
  }))
  const merged = {
    ...base?.policy ?? defaultPolicy,
    ...set,
  }
  return Object.freeze({
    high: copyRule(merged.high),
    medium: copyRule(merged.medium),
    low: copyRule(merged.low),
  })
}

/** The lenses of the entry, else of the base: the fields the check reads, each read once, whatever the lens holds besides. */
function lensesOf(entry: ProfileEntry['lenses'], base: Profile | undefined): LensEntry[] | undefined {
  // `profileIssues` refuses a lens whose id or question is not a string, so the casts hide nothing.
  if (entry !== undefined) {
    return entry.map(lens => ({
      id: own(lens, 'id') as string,
      question: own(lens, 'question') as string,
      provider: own(lens, 'provider'),
    }))
  }
  return base?.lenses.map(({ id, question }) => ({ id, question, provider: undefined }))
}

/** What a profile is bound against: the roles, and the names of the providers that are defined, in order and as a set. */
interface Bindings {
  readonly roles: RoleBinding
  readonly providers: readonly string[]
  readonly known: ReadonlySet<string>
}

/** What one profile of the config resolves to, or every issue that keeps it from running. */
function resolveEntry(id: string, entry: ProfileEntry, { roles, providers, known }: Bindings): { readonly resolved?: ResolvedProfile, readonly issues: ConfigIssue[] } {
  const at = (...segments: PropertyKey[]): string => issuePath(['profiles', id, ...segments])
  const base = BUILT_IN.get(own(entry, 'extends') ?? id)
  const entryPrompts = own(entry, 'prompts')
  const research = own(entryPrompts, 'research') ?? base?.prompts.research
  const vote = own(entryPrompts, 'vote') ?? base?.prompts.vote
  const lenses = lensesOf(own(entry, 'lenses'), base)

  if (research === undefined || vote === undefined || lenses === undefined) {
    const needed: Array<[unknown, ...string[]]> = [
      [research, 'prompts', 'research'],
      [vote, 'prompts', 'vote'],
      [lenses, 'lenses'],
    ]
    return {
      issues: needed.filter(([value]) => value === undefined).map(([, ...segments]) => ({
        path: at(...segments),
        message: NEEDS_BASE,
      })),
    }
  }

  const profile: Profile = Object.freeze({
    id,
    prompts: Object.freeze({ research, vote }),
    lenses: Object.freeze(lenses.map(lens => Object.freeze({ id: lens.id, question: lens.question }))),
    policy: policyOf(base, own(entry, 'policy')),
    gating: own(entry, 'gating') ?? base?.gating ?? true,
  })
  // `profileIssues` starts its paths at the id given as the fallback root, which is the profile's own id here.
  const issues = profileIssues(profile, id).map(issue => ({ path: `${at()}${issue.path.slice(id.length)}`, message: issue.message }))

  const entryRoles = own(entry, 'roles')
  const references = [
    {
      path: at('roles', 'research'),
      name: own(entryRoles, 'research'),
    },
    {
      path: at('roles', 'voter'),
      name: own(entryRoles, 'voter'),
    },
    ...lenses.map((lens, index) => ({
      path: at('lenses', index, 'provider'),
      name: lens.provider,
    })),
  ]
  for (const { path, name } of references) {
    if (name !== undefined && !known.has(name)) issues.push(unknownName(path, 'provider', name, providers))
  }
  if (issues.length > 0) return { issues }

  const voter = own(entryRoles, 'voter') ?? roles.voter
  return {
    resolved: Object.freeze({
      profile,
      research: own(entryRoles, 'research') ?? roles.research,
      voters: Object.freeze(Object.fromEntries(lenses.map(lens => [lens.id, lens.provider ?? voter]))),
    }),
    issues,
  }
}

/**
 * The profiles a config runs: `selection.ids` (`QUORUM_PROFILES`, or the flag of the CLI, named by
 * `selection.path`), else the keys of `profiles`, else the security profile. Every entry of `profiles` is
 * resolved and checked, selected or not, and a selected built-in profile the config does not list runs as
 * it is. A profile starts from the built-in profile it `extends`, else the one of its id, else from nothing,
 * and then needs prompts and lenses of its own: prompts and policy levels merge field by field over the
 * base's, lenses replace its lenses. Each profile is a new frozen value, built field by field, never by
 * assigning a key of the input. `research` is bound to `roles.research`, and each lens to its own provider,
 * else the profile's voter, else `roles.voter`; every provider a profile names must be in `providers`.
 * A selection that runs nothing is an issue, and a profile with an issue does not run.
 */
export function resolveProfiles(inputs: {
  readonly profiles: ConfigInput['profiles']
  readonly selection?: ProfileSelection
  readonly roles: RoleBinding
  readonly providers: readonly string[]
}): { readonly profiles: readonly ResolvedProfile[], readonly issues: readonly ConfigIssue[] } {
  const configured = new Map(Object.entries(inputs.profiles ?? {}))
  const selected = inputs.selection?.ids ?? (inputs.profiles === undefined
    ? [securityProfile.id]
    : [
        ...configured.keys(),
      ])
  const bindings: Bindings = {
    roles: inputs.roles,
    providers: inputs.providers,
    known: new Set(inputs.providers),
  }
  const defined = [
    ...configured.keys(),
    ...[
      ...BUILT_IN.keys(),
    ].filter(id => !configured.has(id)),
  ]

  const issues: ConfigIssue[] = selected.length > 0
    ? []
    : [
        inputs.selection === undefined
          ? { path: 'profiles', message: 'must hold at least one profile, or be left out' }
          : { path: inputs.selection.path, message: 'must name at least one profile' },
      ]
  const resolutions = new Map([...configured].map(([id, entry]) => [
    id,
    resolveEntry(id, entry, bindings),
  ] as const))
  for (const id of selected) {
    if (resolutions.has(id)) continue
    if (BUILT_IN.has(id)) resolutions.set(id, resolveEntry(id, {}, bindings))
    else issues.push(unknownName(inputs.selection?.path ?? 'profiles', 'profile', id, defined))
  }
  issues.push(...[
    ...resolutions.values(),
  ].flatMap(resolution => resolution.issues))
  return {
    profiles: selected.flatMap(id => resolutions.get(id)?.resolved ?? []),
    issues,
  }
}
