import { bytesOf, capProblem, documentSha256, repositoryPathProblem, totalProblem, UNSETTLED } from '../core/documents.ts'
import { ConfigError, isSafeSegment, issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { defaultPolicy } from '../core/policy.ts'
import type { PolicyRules, Rule } from '../core/policy.ts'
import { FAIL_ON_LEVELS, profileIssues } from '../core/profile.ts'
import { cleanProse } from '../core/sanitize.ts'
import type { DocumentKind, FailOn, Profile, ReviewDocument } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import { PROFILE_ID } from './env.ts'
import type { RoleBinding } from './env.ts'
import { unknownName } from './schema.ts'
import type { ConfigInput } from './schema.ts'

type ProfileEntry = NonNullable<ConfigInput['profiles']>[string]

/**
 * A `{ repository }` entry of a profile's documents: a file of the repository, which a review reads at the commit its source names
 * (`readContext`) and never from the working tree or the change under review.
 */
export interface RepositoryEntry {
  readonly kind: DocumentKind
  /** The path from the repository's top level, as the entry wrote it. */
  readonly path: string
  /** Whether the review goes on, the document recorded as missing, when the commit has no such file. */
  readonly optional: boolean
  /** Where an issue with the entry goes: `profiles.<id>.<field>.<n>.repository`. */
  readonly at: string
  /** The entry's position among its field's entries, where `--print-config` prints it. */
  readonly index: number
}

/** A profile that runs, with the providers it is bound to. */
export interface ResolvedProfile {
  readonly profile: Profile
  /** The provider that looks for candidate findings. */
  readonly research: string
  /** The provider each lens votes with, by lens id. */
  readonly voters: Readonly<Record<string, string>>
  /** The profile's `{ repository }` entries, `guidelines` then `doNotReport`, each in the order it is written: the files `readContext` reads for a review. */
  readonly repository: readonly RepositoryEntry[]
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
/** The fields of an entry that list documents, in the order the profile's documents are built, each with the kind it holds. */
const DOCUMENT_FIELDS = [
  { field: 'guidelines', kind: 'guidelines' },
  { field: 'doNotReport', kind: 'do-not-report' },
] as const satisfies ReadonlyArray<{ readonly field: 'guidelines' | 'doNotReport', readonly kind: DocumentKind }>

/** One entry of a document list, whichever form it takes: `{ text }`, or `{ repository, optional }`. */
interface DocumentItem {
  readonly text?: string
  readonly repository?: string
  readonly optional?: boolean
}

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

/** What a profile is bound against: the roles, and the names of the providers that are defined, in order and as a set, and the built-in profiles it can start from. */
interface Bindings {
  readonly roles: RoleBinding
  readonly providers: readonly string[]
  readonly known: ReadonlySet<string>
  readonly builtIn: ReadonlyMap<string, Profile>
}

/**
 * The documents the entry lists, `guidelines` then `doNotReport`, each cleaned as the core cleans one, with what the
 * cleaner removed and the hash of the text as read, its `{ repository }` entries (read for a review, so only named here, each at
 * its own path, `.repository`), and the issue of each entry that cannot be kept, at its own path: a repository path that is none,
 * a text the cleaner cannot settle, one over its kind's cap once cleaned, and the first whose bytes take the kind's total
 * (`start` counts the profile's own text, which comes first) over what the profile may hold in all. An entry with an issue
 * is left out, so the profile the check reads holds none the core would refuse again.
 */
function documentsOf(id: string, entry: ProfileEntry, start: Readonly<Record<DocumentKind, number>>, at: (...segments: PropertyKey[]) => string): { readonly documents: ReviewDocument[], readonly repository: RepositoryEntry[], readonly issues: ConfigIssue[] } {
  const documents: ReviewDocument[] = []
  const repository: RepositoryEntry[] = []
  const issues: ConfigIssue[] = []
  for (const { field, kind } of DOCUMENT_FIELDS) {
    let total = start[kind]
    // Once a document takes the total over its cap, it is reported and no later one is counted: only the first is the one to shorten or drop.
    let fits = true
    for (const [index, entryItem] of (own(entry, field) ?? []).entries()) {
      // The schema holds every entry to `{ text }` or `{ repository, optional }`, the fields read as own fields only.
      const item: DocumentItem = entryItem
      const path = own(item, 'repository')
      if (path !== undefined) {
        const problem = repositoryPathProblem(path)
        if (problem === undefined) {
          repository.push({
            kind,
            path,
            optional: own(item, 'optional') === true,
            at: at(field, index, 'repository'),
            index,
          })
        } else {
          issues.push({
            path: at(field, index, 'repository'),
            message: problem,
          })
        }
        continue
      }
      const text = own(item, 'text') as string
      const cleaned = cleanProse(text)
      const bytes = bytesOf(cleaned.text)
      const problem = cleaned.settled
        ? capProblem(kind, bytes)
        : UNSETTLED
      if (problem !== undefined) {
        issues.push({
          path: at(field, index),
          message: problem,
        })
        continue
      }
      if (!fits) continue
      total += bytes
      const over = totalProblem(kind, total)
      if (over !== undefined) {
        issues.push({
          path: at(field, index),
          message: over,
        })
        fits = false
        continue
      }
      documents.push(Object.freeze({
        profile: id,
        kind,
        origin: Object.freeze({
          kind: 'config' as const,
          sha256: documentSha256(text),
        }),
        text: cleaned.text,
        removed: Object.freeze(cleaned.removed),
      }))
    }
  }
  return { documents, repository, issues }
}

/** What one profile of the config resolves to, or every issue that keeps it from running, and the warnings its fields earn. */
function resolveEntry(id: string, entry: ProfileEntry, { roles, providers, known, builtIn }: Bindings): { readonly resolved?: ResolvedProfile, readonly issues: ConfigIssue[], readonly warnings: string[] } {
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
  const base = builtIn.get(own(entry, 'extends') ?? id)
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

  // The base's own do-not-report text comes first, unless the entry drops it; the core checks it, and the documents are counted after it.
  const doNotReport = own(entry, 'builtInDoNotReport') === false
    ? undefined
    : base?.doNotReport
  const ownText = doNotReport === undefined
    ? undefined
    : cleanProse(doNotReport)
  const { documents, repository, issues: documentIssues } = documentsOf(id, entry, {
    guidelines: 0,
    'do-not-report': ownText?.settled === true
      ? bytesOf(ownText.text)
      : 0,
  }, at)

  const profile: Profile = Object.freeze({
    id,
    prompts: Object.freeze({ research, vote }),
    lenses: Object.freeze(lenses.map(lens => Object.freeze({ id: lens.id, question: lens.question }))),
    policy: policyOf(base, own(entry, 'policy')),
    failOn: failOn ?? fromGating(gating) ?? base?.failOn ?? 'high',
    ...doNotReport === undefined
      ? {}
      : { doNotReport },
    ...documents.length === 0
      ? {}
      : {
          documents: Object.freeze(documents),
        },
  })
  // `profileIssues` starts its paths at the id given as the fallback root, which is the profile's own id here.
  const issues = [
    ...both,
    ...documentIssues,
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
      repository: Object.freeze(repository.map(found => Object.freeze(found))),
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
 * an issue at its `path`: a typo must not leave a gate weaker or missing. A profile holds the documents its
 * entry lists as `documents`, `guidelines` then `doNotReport`, each cleaned, with what the cleaner removed and the
 * SHA-256 of the text as read; one the cleaner cannot settle, or over its cap once cleaned, or the first that takes
 * a kind over the cap of all of them, is an issue at its entry (`profiles.<id>.<field>.<n>`). A `{ repository }` entry is no
 * document yet: the profile lists it in `repository`, at `profiles.<id>.<field>.<n>.repository`, for `readContext` to read at
 * the commit a review's source names, and a path that is none is an issue there. Its `doNotReport` is
 * the base's own text, unless the entry sets `builtInDoNotReport: false`, and counts first toward that cap. A profile
 * with no document holds neither key. `inputs.builtIn` is the map of the profiles a config can run or extend, the
 * security profile alone by default. `research` is bound to
 * `roles.research`, and each lens to its own provider, else the profile's voter, else `roles.voter`; every provider a profile names
 * must be in `providers`. A selection that runs nothing is an issue, and a profile with an issue does not run.
 */
export function resolveProfiles(inputs: {
  readonly profiles: ConfigInput['profiles']
  readonly selection?: ProfileSelection
  readonly roles: RoleBinding
  readonly providers: readonly string[]
  readonly failOn?: FailOnOverride
  readonly builtIn?: ReadonlyMap<string, Profile>
}): { readonly profiles: readonly ResolvedProfile[], readonly issues: readonly ConfigIssue[], readonly warnings: readonly string[] } {
  const configured = new Map(Object.entries(inputs.profiles ?? {}))
  const selected = inputs.selection?.ids ?? (inputs.profiles === undefined
    ? [securityProfile.id]
    : [
        ...configured.keys(),
      ])
  const builtIn = inputs.builtIn ?? BUILT_IN
  const bindings: Bindings = {
    roles: inputs.roles,
    providers: inputs.providers,
    known: new Set(inputs.providers),
    builtIn,
  }
  const defined = [
    ...configured.keys(),
    ...[
      ...builtIn.keys(),
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
    if (builtIn.has(id)) resolutions.set(id, resolveEntry(id, {}, bindings))
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
