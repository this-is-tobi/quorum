import type { Profile } from '../core/types.ts'
import { REFUTATION_VOTE } from './vote.ts'

/**
 * Functional defects that the changed lines cause or expose, as an advisory review: it fails nothing (`failOn: none`), asks for
 * 20 findings a request and keeps a finding only near a line the change adds or removes. It is data beside `securityProfile`,
 * read by the same registry and the same resolution, and deep-frozen as it is. It lists no review rule, so its research request
 * carries the five fields of `FINDING_FIELDS`, and its do-not-report list reaches the finder alone. No labelled set measures it
 * yet: it is design intent, not measured precision.
 */
export const codeReviewProfile: Profile = Object.freeze({
  id: 'code-review',
  prompts: Object.freeze({
    research: 'Review this diff for functional defects that the changed lines cause or expose: wrong logic or results, broken error and edge paths, concurrency bugs, data loss or corruption, and a misused API or a broken contract. A finding\'s quote is the code that misbehaves, and its category is one of `bug` (wrong logic, a wrong result, a broken error or edge path), `concurrency` (a race, a deadlock, shared state used without its guard), `data` (data lost, corrupted or left inconsistent) or `api` (an API used against its contract, or a contract the change breaks for its callers).',
    vote: REFUTATION_VOTE,
  }),
  lenses: Object.freeze([
    Object.freeze({
      id: 'real',
      question: 'Does the quoted code, as written, misbehave: is there an input or a sequence of events, shown in the diff or plainly possible, that makes it fail, rather than code that only looks unusual?',
    }),
    Object.freeze({
      id: 'introduced',
      question: 'Is the defect in what this change adds or alters, rather than in code it leaves as it was?',
    }),
    Object.freeze({
      id: 'consequential',
      question: 'Would a maintainer fix it before merging: does it crash, lose or corrupt data, return a wrong result or break a caller, rather than being a matter of style or design?',
    }),
  ]),
  policy: Object.freeze({ high: 'unanimous', medium: 'majority', low: 'off' }),
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
