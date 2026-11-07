import type { ConfigIssue } from './errors.ts'
import { defaultPolicy, resolvePolicy } from './policy.ts'
import { PLACEHOLDER } from './prompts.ts'
import type { Profile, Thresholds } from './types.ts'

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/

const VOTE_VARIABLES: ReadonlySet<string> = new Set(['lens.id', 'lens.question', 'panel.size'])

/**
 * Every problem that keeps a profile from running, all at once: the id, the lenses, the policy for
 * the lens count and both templates. A library caller gets the checks a config file gets, and a
 * typo in a template is refused here instead of reaching a model as literal text. Paths start at
 * the profile id, or at `profile` when the id itself is invalid.
 */
export function profileIssues(profile: Profile): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const idIssue = idProblem(profile.id)
  if (idIssue) issues.push({ path: 'profile.id', message: idIssue })
  const root = idIssue ? 'profile' : profile.id

  const seen = new Set<string>()
  profile.lenses.forEach((lens, index) => {
    const path = `${root}.lenses.${index}`
    const lensIssue = idProblem(lens.id) ?? (seen.has(lens.id) ? `repeats the lens id ${JSON.stringify(lens.id)}` : undefined)
    if (lensIssue) issues.push({ path: `${path}.id`, message: lensIssue })
    seen.add(lens.id)
    if (lens.question.trim() === '') issues.push({ path: `${path}.question`, message: 'must not be empty' })
  })

  for (const issue of resolvePolicy(profile.policy ?? defaultPolicy, profile.lenses.length).issues) {
    issues.push({ path: `${root}.${issue.path}`, message: issue.message })
  }

  issues.push(...templateIssues(`${root}.prompts.research`, profile.prompts.research, researchVariableProblem))
  issues.push(...templateIssues(`${root}.prompts.vote`, profile.prompts.vote, voteVariableProblem))
  return issues
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

/** `unknown` on purpose: an untyped caller can hand over a missing id, and `RegExp.test` would read it as the text "undefined". */
function idProblem(id: unknown): string | undefined {
  return typeof id === 'string' && ID_PATTERN.test(id) ? undefined : `must match ${ID_PATTERN.source}, got ${JSON.stringify(id)}`
}

function researchVariableProblem(name: string): string {
  return name === 'diff'
    ? 'the diff is appended automatically as fenced data'
    : 'the research template takes no variables'
}

function voteVariableProblem(name: string): string | undefined {
  return VOTE_VARIABLES.has(name) ? undefined : 'the vote template takes {{lens.id}}, {{lens.question}} and {{panel.size}}'
}

/** A blank template is one issue; otherwise one issue per distinct refused variable, in order of first appearance. */
function templateIssues(path: string, template: string, problem: (name: string) => string | undefined): ConfigIssue[] {
  if (template.trim() === '') return [{ path, message: 'must not be empty' }]
  const issues: ConfigIssue[] = []
  const reported = new Set<string>()
  for (const match of template.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) {
    const name = match[1].trim()
    if (reported.has(name)) continue
    reported.add(name)
    const reason = problem(name)
    if (reason) issues.push({ path, message: `{{${name}}} is not allowed: ${reason}` })
  }
  return issues
}
