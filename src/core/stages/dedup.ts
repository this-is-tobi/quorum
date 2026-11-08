import type { Finding } from '../types.ts'

/**
 * Drop candidates that independent lenses (once there is more than one) or repeated runs
 * rediscovered at the same location - plain code, not a model, same as the panel's quorum tally.
 *
 * @example
 * dedup([a, b, a]) // -> [a, b], keyed by file, line and category
 */
export function dedup(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    // A JSON array, not colons: a file name and a category can hold colons, which would make two findings collide.
    const key = JSON.stringify([finding.file, finding.line, finding.category])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
