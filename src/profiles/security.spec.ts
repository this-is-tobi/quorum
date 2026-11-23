import { describe, expect, it } from 'vitest'
import { profileIssues } from '../core/profile.ts'
import { FINDING_FIELDS } from '../core/prompts.ts'
import { securityProfile } from './security.ts'

describe('securityProfile', () => {
  it('judges each finding from reachability, impact and defenses, the lens ids votes report', () => {
    expect(securityProfile.id).toBe('security')
    expect(securityProfile.lenses.map(lens => lens.id)).toEqual(['reachability', 'impact', 'defenses'])
  })

  it('keeps the wording, lenses and policy of the review it replaces', () => {
    expect(securityProfile.prompts).toEqual({
      research: 'Review this diff for security vulnerabilities. A finding\'s quote is the offending code (the sink), and its category is its CWE id, such as CWE-89.',
      vote: [
        'One vote in a {{panel.size}}-voter panel - you do not see the other votes. Refutation angle: {{lens.id}}.',
        '{{lens.question}}',
        '',
        'Judge only from the blocks you receive. Default keep=false unless genuinely convinced.',
      ].join('\n'),
    })
    expect(securityProfile.lenses).toEqual([
      { id: 'reachability', question: 'Is this sink actually reachable from untrusted input in normal flow - not just syntactically present?' },
      { id: 'impact', question: 'If reached, is the impact real - not just bad-looking code?' },
      { id: 'defenses', question: 'Do existing checks elsewhere already neutralize this?' },
    ])
    expect(securityProfile.policy).toEqual({ high: 'unanimous', medium: 'majority', low: 'off' })
  })

  it('states neither failOn nor gating, so it fails on high by default', () => {
    expect(Object.hasOwn(securityProfile, 'failOn')).toBe(false)
    expect(Object.hasOwn(securityProfile, 'gating')).toBe(false)
  })

  it('cannot be changed in place, so one run cannot leak into the next', () => {
    expect(Object.isFrozen(securityProfile)).toBe(true)
    expect(Object.isFrozen(securityProfile.prompts)).toBe(true)
    expect(Object.isFrozen(securityProfile.lenses)).toBe(true)
    expect(securityProfile.lenses.every(lens => Object.isFrozen(lens))).toBe(true)
    expect(Object.isFrozen(securityProfile.policy)).toBe(true)
  })

  it('says what its quote and its category hold, and leaves the fields to quorum\'s request', () => {
    expect(securityProfile.prompts.research).toMatch(/the sink/)
    expect(securityProfile.prompts.research).toMatch(/CWE-89/)
    expect(securityProfile.prompts.research).not.toContain('`summary`')
    expect(securityProfile.prompts.research).not.toContain('verbatim')
    expect(FINDING_FIELDS).toMatch(/verbatim without the leading \+, - or space/)
  })

  it('is a valid profile', () => {
    expect(profileIssues(securityProfile)).toEqual([])
  })
})
