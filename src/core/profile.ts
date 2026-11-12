import type { ConfigIssue } from './errors.ts'
import { isRecord } from './output.ts'
import { defaultPolicy, resolvePolicy } from './policy.ts'
import { PLACEHOLDER } from './prompts.ts'
import type { Profile, Thresholds } from './types.ts'

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/

const VOTE_VARIABLES: ReadonlySet<string> = new Set(['lens.id', 'lens.question', 'panel.size'])

/**
 * Every problem that keeps a profile from running, all at once. Each field is checked by shape
 * first, because an untyped caller can hand over anything and a `TypeError` is no report: the
 * profile itself, the id, the lenses (and each lens), the policy, both prompts, `gating` and
 * `guidelines`. The rules follow the shape: the policy for the lens count and both templates, so a
 * library caller gets the checks a config file gets, and a typo in a template is refused here
 * instead of reaching a model as literal text. Paths start at the profile id, or at `fallbackRoot`
 * (the profile's place in a larger input, `profile` by default) while the id is invalid.
 */
export function profileIssues(profile: Profile, fallbackRoot = 'profile'): ConfigIssue[] {
  if (!isRecord(profile)) {
    return [
      { path: fallbackRoot, message: 'must be an object' },
    ]
  }
  const issues: ConfigIssue[] = []
  const idIssue = idProblem(profile.id)
  if (idIssue) issues.push({ path: `${fallbackRoot}.id`, message: idIssue })
  const root = isValidId(profile.id)
    ? profile.id
    : fallbackRoot

  issues.push(...lensIssues(profile.lenses, root))
  issues.push(...policyIssues(profile, root))
  issues.push(...promptIssues(profile.prompts, root))
  if (profile.gating !== undefined && typeof profile.gating !== 'boolean') issues.push({ path: `${root}.gating`, message: 'must be true or false' })
  if (profile.guidelines !== undefined && typeof profile.guidelines !== 'string') issues.push({ path: `${root}.guidelines`, message: 'must be a string' })
  return issues
}

/**
 * What a profile `profileIssues` accepts still cannot take full effect: a policy level that never
 * applies with its lens count, and a vote template that gives every lens the same instructions.
 * The profile must be one `profileIssues` accepts: nothing is re-validated here. Each warning
 * starts at the profile id.
 */
export function profileWarnings(profile: Profile): string[] {
  const warnings = resolvePolicy(profile.policy ?? defaultPolicy, profile.lenses.length).warnings.map(warning => `${profile.id}.${warning}`)
  const usesLensVariable = placeholderNames(profile.prompts.vote).some(name => name === 'lens.id' || name === 'lens.question')
  if (profile.lenses.length > 1 && !usesLensVariable) {
    warnings.push(`${profile.id}.prompts.vote uses neither {{lens.id}} nor {{lens.question}}, so every lens gets the same instructions`)
  }
  return warnings
}

/**
 * The vote thresholds of a profile: its policy, or the default one, resolved for its lens count.
 * The profile must be one `profileIssues` accepts: the policy's own problems are not reported here.
 *
 * @example
 * thresholdsFor(securityProfile) // -> { high: 3, medium: 2, low: null }
 */
export function thresholdsFor(profile: Profile): Thresholds {
  return resolvePolicy(profile.policy ?? defaultPolicy, profile.lenses.length).thresholds
}

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

/** `unknown` on purpose: an untyped caller can hand over a missing id, and `RegExp.test` would read it as the text "undefined". */
function idProblem(id: unknown): string | undefined {
  return isValidId(id)
    ? undefined
    : `must match ${ID_PATTERN.source}, got ${JSON.stringify(id)}`
}

/** `Array.from` reads a hole in an untyped array as `undefined`, so it is reported like any other lens that is not an object. */
function lensIssues(lenses: unknown, root: string): ConfigIssue[] {
  if (!Array.isArray(lenses)) {
    return [
      { path: `${root}.lenses`, message: 'must be an array of lenses' },
    ]
  }
  const issues: ConfigIssue[] = []
  const seen = new Set<unknown>()
  Array.from<unknown>(lenses).forEach((lens, index) => {
    const path = `${root}.lenses.${index}`
    if (!isRecord(lens)) {
      issues.push({ path, message: 'must be an object with an id and a question' })
      return
    }
    const lensIssue = idProblem(lens.id) ?? (seen.has(lens.id)
      ? `repeats the lens id ${JSON.stringify(lens.id)}`
      : undefined)
    if (lensIssue) issues.push({ path: `${path}.id`, message: lensIssue })
    seen.add(lens.id)
    if (typeof lens.question !== 'string') issues.push({ path: `${path}.question`, message: 'must be a string' })
    else if (lens.question.trim() === '') issues.push({ path: `${path}.question`, message: 'must not be empty' })
  })
  return issues
}

/** The policy is resolved only when its shape is right and the lenses give it a count to resolve against. */
function policyIssues(profile: Profile, root: string): ConfigIssue[] {
  if (profile.policy !== undefined && !isRecord(profile.policy)) {
    return [
      { path: `${root}.policy`, message: 'must be an object with high, medium and low rules' },
    ]
  }
  if (!Array.isArray(profile.lenses)) return []
  return resolvePolicy(profile.policy ?? defaultPolicy, profile.lenses.length).issues.map(issue => ({ path: `${root}.${issue.path}`, message: issue.message }))
}

function promptIssues(prompts: unknown, root: string): ConfigIssue[] {
  if (!isRecord(prompts)) {
    return [
      { path: `${root}.prompts`, message: 'must be an object holding the research and vote templates' },
    ]
  }
  const templates = [
    { name: 'research', problem: researchVariableProblem },
    { name: 'vote', problem: voteVariableProblem },
  ]
  return templates.flatMap(({ name, problem }) => {
    const path = `${root}.prompts.${name}`
    const template = prompts[name]
    return typeof template === 'string'
      ? templateIssues(path, template, problem)
      : [
          { path, message: 'must be a string' },
        ]
  })
}

function researchVariableProblem(name: string): string {
  return name === 'diff'
    ? 'the diff is appended automatically as fenced data'
    : 'the research template takes no variables'
}

function voteVariableProblem(name: string): string | undefined {
  return VOTE_VARIABLES.has(name)
    ? undefined
    : 'the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}'
}

/** A blank template is one issue; otherwise one issue per distinct refused variable, in order of first appearance. */
function templateIssues(path: string, template: string, problem: (name: string) => string | undefined): ConfigIssue[] {
  if (template.trim() === '') {
    return [
      { path, message: 'must not be empty' },
    ]
  }
  const issues: ConfigIssue[] = []
  const reported = new Set<string>()
  for (const name of placeholderNames(template)) {
    if (reported.has(name)) continue
    reported.add(name)
    const reason = problem(name)
    if (reason) issues.push({ path, message: `{{${name}}} is not allowed: ${reason}` })
  }
  return issues
}

/** The trimmed name of every placeholder, in order, repeats included. Scans a copy of `PLACEHOLDER`, never its shared `lastIndex`. */
function placeholderNames(template: string): string[] {
  return Array.from(template.matchAll(new RegExp(PLACEHOLDER.source, 'g')), match => match[1].trim())
}
