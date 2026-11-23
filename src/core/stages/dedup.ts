import type { Finding } from '../types.ts'

/** What makes two findings one for `dedup`: their file, line and category. */
export function dedupKey(finding: Pick<Finding, 'file' | 'line' | 'category'>): string {
  // A JSON array, not colons: a file name and a category can hold colons, which would make two findings collide.
  return JSON.stringify([finding.file, finding.line, finding.category])
}

/**
 * Drop candidates that independent lenses (once there is more than one) or repeated runs
 * rediscovered at the same location - plain code, not a model, same as the panel's quorum tally.
 * For one key the finding kept is the first one the finder anchored itself, without a `citedLine`,
 * else the first: a finding the harness moved to its quote never displaces a well-anchored one, so
 * planted text that copies a quote cannot steer a decoy's summary over a real finding. The kept
 * finding stands where its key first appeared.
 *
 * @example
 * dedup([a, b, a]) // -> [a, b], keyed by file, line and category
 */
export function dedup(findings: readonly Finding[]): Finding[] {
  const kept = new Map<string, Finding>()
  for (const finding of findings) {
    const key = dedupKey(finding)
    const held = kept.get(key)
    if (held === undefined || (held.citedLine !== undefined && finding.citedLine === undefined)) kept.set(key, finding)
  }
  return [
    ...kept.values(),
  ]
}
