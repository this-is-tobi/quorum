import { bytesOf, capProblem, documentSha256, repositoryPathProblem, totalProblem, UNSETTLED } from '../core/documents.ts'
import type { ProseKind } from '../core/documents.ts'
import { ConfigError, isSafeSegment, issuePath } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import { defaultPolicy } from '../core/policy.ts'
import type { PolicyRules, Rule } from '../core/policy.ts'
import { FAIL_ON_LEVELS, profileIssues } from '../core/profile.ts'
import { cleanedRules, ruleIssues } from '../core/rules.ts'
import { cleanProse } from '../core/sanitize.ts'
import type { DocumentKind, FailOn, Profile, ReviewDocument, ReviewRule } from '../core/types.ts'
import { BUILT_IN } from '../profiles/index.ts'
import { securityProfile } from '../profiles/security.ts'
import { PROFILE_ID } from './env.ts'
import type { RoleBinding } from './env.ts'
import { parseRules, rulePlace } from './parse.ts'
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
  /** The profile's `{ repository }` entries, `guidelines`, `doNotReport` then `rules`, each in the order it is written: the files `readContext` reads for a review. */
  readonly repository: readonly RepositoryEntry[]
  /** `false` when the entry drops the rules of the built-in profile it starts from (`builtInRules: false`), which the profile no longer lists; absent otherwise. */
  readonly builtInRules?: false
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

const NEEDS_BASE = 'is required: the profile extends no built-in profile'
const LEVELS = ['high', 'medium', 'low'] as const
/** The fields of an entry that list documents, in the order the profile's documents are built, each with the kind it holds. */
const DOCUMENT_FIELDS = [
  { field: 'guidelines', kind: 'guidelines' },
  { field: 'doNotReport', kind: 'do-not-report' },
] as const satisfies ReadonlyArray<{ readonly field: 'guidelines' | 'doNotReport', readonly kind: ProseKind }>

/** One entry of a document list, whichever form it takes: `{ text }`, or `{ repository, optional }`. */
interface DocumentItem {
  readonly text?: string
  readonly repository?: string
  readonly optional?: boolean
}

/** One entry of `rules`, whichever form it takes: a rule written in the config, `{ text, format }`, or `{ repository, optional }`. */
interface RuleItem {
  readonly id?: string
  readonly text?: string
  readonly paths?: readonly string[]
  readonly format?: 'yaml' | 'json'
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
function documentsOf(id: string, entry: ProfileEntry, start: Readonly<Record<ProseKind, number>>, at: (...segments: PropertyKey[]) => string): { readonly documents: ReviewDocument[], readonly repository: RepositoryEntry[], readonly issues: ConfigIssue[] } {
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

/** Where a run of a profile's rules comes from: the entry that wrote them, none for the base's, and the SHA-256 of the file they were read from, none for a rule written in the config. */
interface RuleSource {
  readonly entry?: number
  readonly rules: readonly ReviewRule[]
  readonly sha256?: string
}

/**
 * The issue `ruleIssues` found, which names a rule by its place in the profile's whole list (`rules.<k>` and the field below it),
 * put where the config wrote the rule: a rule written in the config at its own entry and field, with the message as it is; a
 * rule of a file at the entry that names the file, the message starting with the rule's place in the file and its field
 * (`3.id must match ...`); and one of the base's, which no config entry wrote, at `rules`, worded the same way. An issue of
 * the list as a whole, or of the cap that a rule takes the total over (which names no field), keeps its words alone.
 */
function placedAt(issue: ConfigIssue, sources: readonly RuleSource[], at: (...segments: PropertyKey[]) => string): ConfigIssue {
  const { place, field } = rulePlace(issue)
  if (place === undefined) {
    return {
      path: at('rules'),
      message: issue.message,
    }
  }
  let first = 0
  for (const source of sources) {
    const local = place - first
    first += source.rules.length
    if (local >= source.rules.length) continue
    const words = field.length === 0
      ? issue.message
      : `${[local, ...field].join('.')} ${issue.message}`
    if (source.entry === undefined) {
      return {
        path: at('rules'),
        message: words,
      }
    }
    if (source.sha256 === undefined) {
      return {
        path: at('rules', source.entry, ...field),
        message: issue.message,
      }
    }
    return {
      path: at('rules', source.entry),
      message: words,
    }
  }
  return {
    path: at('rules'),
    message: issue.message,
  }
}

/**
 * The rules the entry lists, after `base`, the rules of the built-in profile it keeps: a rule written in the config as a document
 * of its own (no SHA-256), a rules file read by the loader (`{ text, format }`) as a document of its own, parsed, its texts cleaned
 * and its SHA-256 that of the text as read, and each `{ repository }` entry named, at its own path, for `readContext` to read; and
 * the issue of each that cannot be kept, at its entry. Every rule of the profile is checked together, the base's first
 * (`ruleIssues`): ids unique across them all, the texts, the patterns and the caps of all of them, so the entry that makes a
 * repeat or takes a cap over is the one that is told. A profile with an issue holds none of these documents, so the profile the
 * core checks next holds none it would refuse again.
 */
function rulesOf(id: string, entry: ProfileEntry, base: readonly ReviewRule[], at: (...segments: PropertyKey[]) => string): { readonly documents: ReviewDocument[], readonly repository: RepositoryEntry[], readonly issues: ConfigIssue[] } {
  const sources: RuleSource[] = [
    { rules: base },
  ]
  const repository: RepositoryEntry[] = []
  const issues: ConfigIssue[] = []
  for (const [index, entryItem] of (own(entry, 'rules') ?? []).entries()) {
    // The schema holds every entry to a rule, `{ text, format }` or `{ repository, optional }`, the fields read as own fields only.
    const item: RuleItem = entryItem
    const path = own(item, 'repository')
    if (path !== undefined) {
      const problem = repositoryPathProblem(path)
      if (problem === undefined) {
        repository.push({
          kind: 'rules',
          path,
          optional: own(item, 'optional') === true,
          at: at('rules', index, 'repository'),
          index,
        })
      } else {
        issues.push({
          path: at('rules', index, 'repository'),
          message: problem,
        })
      }
      continue
    }
    const format = own(item, 'format')
    if (format !== undefined) {
      const text = own(item, 'text') as string
      const parsed = parseRules(text, format)
      if ('problem' in parsed) {
        issues.push({
          path: at('rules', index),
          message: parsed.problem,
        })
      } else {
        sources.push({
          entry: index,
          rules: parsed.value,
          sha256: documentSha256(text),
        })
      }
      continue
    }
    const paths = own(item, 'paths')
    sources.push({
      entry: index,
      rules: [
        {
          id: own(item, 'id') as string,
          text: own(item, 'text') as string,
          ...paths === undefined
            ? {}
            : { paths },
        },
      ],
    })
  }
  const found = ruleIssues(sources.flatMap(source => source.rules), 'rules').map(issue => placedAt(issue, sources, at))
  issues.push(...found)
  const documents = found.length > 0
    ? []
    : sources.flatMap((source) => {
        if (source.entry === undefined) return []
        const cleaned = cleanedRules(source.rules)
        return [
          Object.freeze({
            profile: id,
            kind: 'rules' as const,
            origin: Object.freeze({
              kind: 'config' as const,
              ...source.sha256 === undefined
                ? {}
                : { sha256: source.sha256 },
            }),
            rules: cleaned.rules,
            removed: Object.freeze(cleaned.removed),
          }),
        ]
      })
  return { documents, repository, issues }
}

/**
 * Whether an entry is the shape a 0.14.0 config gave a profile of its own under the id of a built-in profile released since: its id is
 * a built-in profile's other than `security` (the one 0.14.0 shipped), it has no `extends`, and it brings both its own research
 * template and its own lenses. It would now start from the built-in and silently take what it sets none of (the finding cap,
 * `changedLinesOnly`, the do-not-report text, the rules and the `failOn`), so it is refused for the entry to say which it means.
 */
function namesBuiltInProfileOfItsOwn(id: string, entry: ProfileEntry, builtIn: ReadonlyMap<string, Profile>): boolean {
  return own(entry, 'extends') === undefined
    && builtIn.has(id)
    && id !== securityProfile.id
    && own(own(entry, 'prompts'), 'research') !== undefined
    && own(entry, 'lenses') !== undefined
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
  const entryIssues: ConfigIssue[] = [
    ...gating !== undefined && failOn !== undefined
      ? [
          {
            path: at('gating'),
            message: 'is deprecated and cannot be set with failOn: remove it',
          },
        ]
      : [],
    ...namesBuiltInProfileOfItsOwn(id, entry, builtIn)
      ? [
          {
            path: at(),
            message: `is named after the built-in ${id} profile and brings its own research template and lenses: set extends: ${id} to start from the built-in, or rename the profile to keep it your own`,
          },
        ]
      : [],
  ]
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
        ...entryIssues,
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
  const { documents: prose, repository: proseRepository, issues: documentIssues } = documentsOf(id, entry, {
    guidelines: 0,
    'do-not-report': ownText?.settled === true
      ? bytesOf(ownText.text)
      : 0,
  }, at)
  // The base's own rules come first, unless the entry drops them; then the entry's, each a document, ids unique across them all.
  const dropsRules = own(entry, 'builtInRules') === false
  const baseRules = dropsRules
    ? []
    : base?.rules ?? []
  const { documents: ruleDocuments, repository: ruleRepository, issues: ruleProblems } = rulesOf(id, entry, baseRules, at)
  const documents = [
    ...prose,
    ...ruleDocuments,
  ]
  const repository = [
    ...proseRepository,
    ...ruleRepository,
  ]
  const requireRule = own(entry, 'requireRule') ?? base?.requireRule

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
    ...baseRules.length === 0
      ? {}
      : { rules: baseRules },
    ...requireRule === true
      ? { requireRule }
      : {},
    ...base?.maxFindings === undefined
      ? {}
      : { maxFindings: base.maxFindings },
    ...base?.changedLinesOnly === true
      ? { changedLinesOnly: true }
      : {},
  })
  // `profileIssues` starts its paths at the id given as the fallback root, which is the profile's own id here.
  const issues = [
    ...entryIssues,
    ...documentIssues,
    ...ruleProblems,
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
      ...dropsRules
        ? { builtInRules: false as const }
        : {},
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
 * returned in `warnings` in the order the entries are written. An entry named after a built-in profile other than `security`
 * that has no `extends` and brings both its own research template and its own lenses is an issue at the entry: a 0.14.0 config's
 * profile of its own would now start from the built-in and silently take its cap, rules and level, so it says `extends` or is renamed.
 * `failOn`, the levels `parseFailOn` read from the
 * command line, then sets each selected profile's level over all of that: the level named for the profile, else
 * the level for every profile, as a new frozen profile and binding. A profile it names that is not selected is
 * an issue at its `path`: a typo must not leave a gate weaker or missing. A profile holds the documents its
 * entry lists as `documents`, `guidelines` then `doNotReport`, each cleaned, with what the cleaner removed and the
 * SHA-256 of the text as read; one the cleaner cannot settle, or over its cap once cleaned, or the first that takes
 * a kind over the cap of all of them, is an issue at its entry (`profiles.<id>.<field>.<n>`). A `{ repository }` entry is no
 * document yet: the profile lists it in `repository`, at `profiles.<id>.<field>.<n>.repository`, for `readContext` to read at
 * the commit a review's source names, and a path that is none is an issue there. Its `doNotReport` is
 * the base's own text, unless the entry sets `builtInDoNotReport: false`, and counts first toward that cap. A profile
 * with no document holds neither key. Its `rules` are the base's own, unless the entry sets `builtInRules: false` (the resolved
 * profile then says so in `builtInRules`), then the entry's `rules`, each rule written in the config and each rules file a
 * document of kind `rules`, checked together with the base's (`ruleIssues`) and told at the entry that repeats an id or takes a
 * cap over, as `rulesOf` words it; a `{ repository }` rules file joins `repository`, kind `rules`. Its `requireRule` is the
 * entry's, else the base's, and is set only when `true`. A profile takes its base's `maxFindings`, and its `changedLinesOnly` when
 * the base's is `true`. `inputs.builtIn` is the map of the profiles a config can run or extend, the registry's `BUILT_IN` by default
 * (`security`, `code-review`, `best-practices` and `performance`). `research` is bound to
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
