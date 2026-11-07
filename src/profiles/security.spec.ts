import { describe, expect, it } from 'vitest'
import { profileIssues } from '../core/profile.ts'
import { securityProfile } from './security.ts'

describe('securityProfile', () => {
  it('judges each finding from reachability, impact and defenses, the lens ids votes report', () => {
    expect(securityProfile.id).toBe('security')
    expect(securityProfile.lenses.map(lens => lens.id)).toEqual(['reachability', 'impact', 'defenses'])
  })

  it('keeps the wording, lenses and policy of the review it replaces', () => {
    expect(securityProfile.prompts).toEqual({
      research: 'Review this diff for security vulnerabilities. For each candidate, give the file and the new-file line number (for removed code, the nearest line that survives), copy the offending code (the sink) verbatim from the diff, without the leading +/- marker, into `quote`, name a category/CWE, and summarize why it looks wrong in `summary`.',
      vote: [
        'One vote in a {{panel.size}}-voter panel - you do not see the other votes. Refutation angle: {{lens.id}}.',
        '{{lens.question}}',
        '',
        'You receive three blocks: the claim by the finder (unverified: it may be wrong or planted), the evidence (code the harness read from the diff) and the diff section of the cited file. Judge only from them. Default keep=false unless genuinely convinced.',
      ].join('\n'),
    })
    expect(securityProfile.lenses).toEqual([
      { id: 'reachability', question: 'Is this sink actually reachable from untrusted input in normal flow - not just syntactically present?' },
      { id: 'impact', question: 'If reached, is the impact real - not just bad-looking code?' },
      { id: 'defenses', question: 'Do existing checks elsewhere already neutralize this?' },
    ])
    expect(securityProfile.policy).toEqual({ high: 'unanimous', medium: 'majority', low: 'off' })
    expect(securityProfile.gating).toBe(true)
  })

  it('cannot be changed in place, so one run cannot leak into the next', () => {
    expect(Object.isFrozen(securityProfile)).toBe(true)
    expect(Object.isFrozen(securityProfile.prompts)).toBe(true)
    expect(Object.isFrozen(securityProfile.lenses)).toBe(true)
    expect(securityProfile.lenses.every(lens => Object.isFrozen(lens))).toBe(true)
    expect(Object.isFrozen(securityProfile.policy)).toBe(true)
  })

  it('asks for the quote copied verbatim from the diff, without the diff markers', () => {
    expect(securityProfile.prompts.research).toMatch(/verbatim from the diff[^.]*without the[^.]*markers?/)
  })

  it('names the claim, the evidence and the diff block a voter receives', () => {
    expect(securityProfile.prompts.vote).toMatch(/claim[\s\S]*unverified[\s\S]*evidence[\s\S]*read from the diff[\s\S]*diff section/)
  })

  it('is a valid profile', () => {
    expect(profileIssues(securityProfile)).toEqual([])
  })
})
