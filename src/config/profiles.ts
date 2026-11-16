import { ConfigError, isSafeSegment, issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { defaultPolicy } from '../core/policy.ts'
import type { PolicyRules, Rule } from '../core/policy.ts'
import { FAIL_ON_LEVELS, profileIssues } from '../core/profile.ts'
import type { FailOn, Profile } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import { PROFILE_ID } from './env.ts'
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

/**
 * The fail-on levels the command line sets, as `parseFailOn` read them: `all` for every profile that runs, and
 * `profiles` for the ones it names, each over `all`. `path` is what an issue with a name that does not run names.
 */
export interface FailOnOverride {
  readonly all?: FailOn
  readonly profiles: ReadonlyMap<string, FailOn>
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

/** The level the deprecated `gating` says: `true` is `high` and `false` is `none`. */
function fromGating(gating: boolean | undefined): FailOn | undefined {
  if (gating === undefined) return undefined
  return gating
    ? 'high'
    : 'none'
}

const FAIL_ON_FORM = 'must be a level, high, medium, low or none, or <profile>=<level>'

function isFailOn(value: string): value is FailOn {
  return (FAIL_ON_LEVELS as readonly string[]).includes(value)
}

/**
 * The fail-on levels of the values a flag was given, each written `<level>` for every profile or
 * `<profile>=<level>` for one: the level is `high`, `medium`, `low` or `none`, the profile matches `PROFILE_ID`,
 * and a value is split at its first `=`. The values are checked before any config is read. The issues are at
 * `path`, each at most once, and none holds a value: a value that is neither form, a second level for every
 * profile (equal or not), and a profile named twice. That a profile named here runs is for `resolveProfiles`.
 *
 * @throws ConfigError with every issue
 */
export function parseFailOn(values: readonly string[], path: string): FailOnOverride {
  const profiles = new Map<string, FailOn>()
  let all: FailOn | undefined
  let malformed = false
  let repeatedAll = false
  let repeatedProfile = false
  for (const value of values) {
    const split = value.indexOf('=')
    const id = split === -1
      ? undefined
      : value.slice(0, split)
    const level = split === -1
      ? value
      : value.slice(split + 1)
    if (!isFailOn(level) || (id !== undefined && !PROFILE_ID.test(id))) {
      malformed = true
    } else if (id === undefined) {
      repeatedAll ||= all !== undefined
      all = level
    } else {
      repeatedProfile ||= profiles.has(id)
      profiles.set(id, level)
    }
  }
  const messages = [
    ...malformed
      ? [FAIL_ON_FORM]
      : [],
    ...repeatedAll
      ? ['takes one level for every profile']
      : [],
    ...repeatedProfile
      ? ['names a profile more than once']
      : [],
  ]
  if (messages.length > 0) throw new ConfigError(messages.map(message => ({ path, message })))
  return {
    ...all === undefined
      ? {}
      : { all },
    profiles,
    path,
  }
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

/** The profile with the level the command line sets for it, as a new frozen profile and binding; the profile itself when the override sets none. */
function withFailOn(resolved: ResolvedProfile, failOn: FailOnOverride | undefined): ResolvedProfile {
  const level = failOn?.profiles.get(resolved.profile.id) ?? failOn?.all
  return level === undefined
    ? resolved
    : Object.freeze({
        ...resolved,
        profile: Object.freeze({ ...resolved.profile, failOn: level }),
      })
}

/** The issue of each profile an override names that is not among the ones that run: a typo must not leave a gate weaker or missing. */
function notRunIssues(failOn: FailOnOverride | undefined, selected: readonly string[]): ConfigIssue[] {
  if (failOn === undefined) return []
  return [
    ...failOn.profiles.keys(),
  ].filter(id => !selected.includes(id)).map(id => ({
    path: failOn.path,
    message: isSafeSegment(id)
      ? `names the profile "${id}", which does not run`
      : 'names a profile that does not run',
  }))
}

/** What a profile is bound against: the roles, and the names of the providers that are defined, in order and as a set. */
interface Bindings {
  readonly roles: RoleBinding
  readonly providers: readonly string[]
  readonly known: ReadonlySet<string>
}

/** What one profile of the config resolves to, or every issue that keeps it from running, and the warnings its fields earn. */
function resolveEntry(id: string, entry: ProfileEntry, { roles, providers, known }: Bindings): { readonly resolved?: ResolvedProfile, readonly issues: ConfigIssue[], readonly warnings: string[] } {
  const at = (...segments: PropertyKey[]): string => issuePath(['profiles', id, ...segments])
  const gating = own(entry, 'gating')
  const failOn = own(entry, 'failOn')
  const warnings = gating === undefined
    ? []
    : [
        `${at('gating')} is deprecated: set failOn instead, high for true and none for false`,
      ]
  const both: ConfigIssue[] = gating !== undefined && failOn !== undefined
    ? [
        {
          path: at('gating'),
          message: 'is deprecated and cannot be set with failOn: remove it',
        },
      ]
    : []
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
      issues: [
        ...both,
        ...needed.filter(([value]) => value === undefined).map(([, ...segments]) => ({
          path: at(...segments),
          message: NEEDS_BASE,
        })),
      ],
      warnings,
    }
  }

  const profile: Profile = Object.freeze({
    id,
    prompts: Object.freeze({ research, vote }),
    lenses: Object.freeze(lenses.map(lens => Object.freeze({ id: lens.id, question: lens.question }))),
    policy: policyOf(base, own(entry, 'policy')),
    failOn: failOn ?? fromGating(gating) ?? base?.failOn ?? 'high',
  })
  // `profileIssues` starts its paths at the id given as the fallback root, which is the profile's own id here.
  const issues = [
    ...both,
    ...profileIssues(profile, id).map(issue => ({ path: `${at()}${issue.path.slice(id.length)}`, message: issue.message })),
  ]

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
  if (issues.length > 0) return { issues, warnings }

  const voter = own(entryRoles, 'voter') ?? roles.voter
  return {
    resolved: Object.freeze({
      profile,
      research: own(entryRoles, 'research') ?? roles.research,
      voters: Object.freeze(Object.fromEntries(lenses.map(lens => [lens.id, lens.provider ?? voter]))),
    }),
    issues,
    warnings,
  }
}

/**
 * The profiles a config runs: `selection.ids` (`QUORUM_PROFILES`, or the flag of the CLI, named by
 * `selection.path`), else the keys of `profiles`, else the security profile. Every entry of `profiles` is
 * resolved and checked, selected or not, and a selected built-in profile the config does not list runs as
 * it is. A profile starts from the built-in profile it `extends`, else the one of its id, else from nothing,
 * and then needs prompts and lenses of its own: prompts and policy levels merge field by field over the
 * base's, lenses replace its lenses. Each profile is a new frozen value, built field by field, never by
 * assigning a key of the input. A profile states its `failOn`, the entry's own, else what its deprecated
 * `gating` says (`true` is `high`, `false` is `none`), else the base's, else `high`, and never a `gating`: an
 * entry that sets both is an issue at its `gating`, and one that sets `gating` earns a deprecation warning,
 * returned in `warnings` in the order the entries are written. `failOn`, the levels `parseFailOn` read from the
 * command line, then sets each selected profile's level over all of that: the level named for the profile, else
 * the level for every profile, as a new frozen profile and binding. A profile it names that is not selected is
 * an issue at its `path`: a typo must not leave a gate weaker or missing. `research` is bound to
 * `roles.research`, and each lens to its own provider, else the profile's voter, else `roles.voter`; every provider a profile names
 * must be in `providers`. A selection that runs nothing is an issue, and a profile with an issue does not run.
 */
export function resolveProfiles(inputs: {
  readonly profiles: ConfigInput['profiles']
  readonly selection?: ProfileSelection
  readonly roles: RoleBinding
  readonly providers: readonly string[]
  readonly failOn?: FailOnOverride
}): { readonly profiles: readonly ResolvedProfile[], readonly issues: readonly ConfigIssue[], readonly warnings: readonly string[] } {
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
  issues.push(...notRunIssues(inputs.failOn, selected))
  const resolved = [
    ...resolutions.values(),
  ]
  issues.push(...resolved.flatMap(resolution => resolution.issues))
  return {
    profiles: selected.flatMap((id) => {
      const profile = resolutions.get(id)?.resolved
      return profile === undefined
        ? []
        : [
            withFailOn(profile, inputs.failOn),
          ]
    }),
    issues,
    warnings: resolved.flatMap(resolution => resolution.warnings),
  }
}
