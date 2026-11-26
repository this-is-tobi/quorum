import { describe, expect, it } from 'vitest'
import { codeReviewProfile } from './code-review.ts'
import { REFUTATION_VOTE } from './vote.ts'

describe('codeReviewProfile', () => {
  it('holds the template, lenses, rules, do-not-report text and settings of the plan', () => {
    expect(codeReviewProfile).toEqual({
      id: 'code-review',
      prompts: {
        research: 'Review this diff for functional defects that the changed lines cause or expose: wrong logic or results, broken error and edge paths, concurrency bugs, data loss or corruption, and a misused API or a broken contract. A finding\'s quote is the code that misbehaves, and its category is one of `bug` (wrong logic, a wrong result, a broken error or edge path), `concurrency` (a race, a deadlock, shared state used without its guard), `data` (data lost, corrupted or left inconsistent) or `api` (an API used against its contract, or a contract the change breaks for its callers).',
        vote: REFUTATION_VOTE,
      },
      lenses: [
        { id: 'real', question: 'Does the quoted code, as written, misbehave: is there an input or a sequence of events, shown in the diff or plainly possible, that makes it fail, rather than code that only looks unusual?' },
        { id: 'introduced', question: 'Is the defect in what this change adds or alters, rather than in code it leaves as it was?' },
        { id: 'consequential', question: 'Would a maintainer fix it before merging: does it crash, lose or corrupt data, return a wrong result or break a caller, rather than being a matter of style or design?' },
      ],
      policy: { high: 'unanimous', medium: 'majority', low: 'off' },
      failOn: 'none',
      maxFindings: 20,
      changedLinesOnly: true,
      doNotReport: [
        '- style, formatting, naming and comments',
        '- design, architecture and refactoring preferences',
        '- what a linter, a formatter or a type checker reports',
        '- missing tests or documentation',
        '- slow code that behaves correctly',
        '- security vulnerabilities, which the security profile reviews',
        '- issues in code the change does not touch',
        '- speculation that rests on an input or a caller the diff does not show',
        '- code a suppression comment silences on purpose',
      ].join('\n'),
    })
  })

  it('says what its quote and its category hold, and leaves the fields to quorum\'s request', () => {
    expect(codeReviewProfile.prompts.research).toMatch(/the code that misbehaves/)
    expect(codeReviewProfile.prompts.research).not.toContain('`summary`')
    expect(codeReviewProfile.prompts.research).not.toContain('verbatim')
    expect(codeReviewProfile.prompts.research).not.toContain('{{')
  })
})
