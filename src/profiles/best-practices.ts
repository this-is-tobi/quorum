import type { Profile } from '../core/types.ts'
import { REFUTATION_VOTE } from './vote.ts'

/**
 * Code the change adds or alters that lacks what one of four review rules asks for, as an advisory review: it requires a rule
 * (`requireRule`), so a finding that cites none is dropped. Its finder cites the line where the missing piece belongs and quotes
 * the code beside it, within two lines, so the quote sits in the cited line's evidence. It fails nothing (`failOn: none`), asks
 * for 20 findings a request and keeps a finding only near a line the change adds or removes. It is data beside
 * `securityProfile`, deep-frozen as it is, and no labelled set measures it yet: it is design intent, not measured precision.
 */
export const bestPracticesProfile: Profile = Object.freeze({
  id: 'best-practices',
  prompts: Object.freeze({
    research: 'Review this diff against the review rules this request carries, and report only code the change adds or alters that lacks what one of them asks for. Cite the line where the missing piece belongs, and quote the code beside it that lacks it, the handler, function, call or block, within two lines of that line. A finding\'s category is `test_gap` for a missing test, `doc_defect` for missing documentation a rule asks for, else the kind of practice in a word or two, such as `error-handling`, `validation` or `cleanup`.',
    vote: REFUTATION_VOTE,
  }),
  lenses: Object.freeze([
    Object.freeze({
      id: 'asked',
      question: 'Does the cited rule\'s text really ask for what the finding says is missing, for this kind of code? Keep=false when the finding stretches the rule or the rule does not fit this code.',
    }),
    Object.freeze({
      id: 'absent',
      question: 'Is the required piece really missing? A handler, check, wrapper, cleanup or test that the diff or the other blocks show elsewhere refutes the claim, and so does a line the test-coverage block shows as covered.',
    }),
    Object.freeze({
      id: 'introduced',
      question: 'Is the gap in code this change adds or alters, rather than in code it leaves as it was?',
    }),
  ]),
  rules: Object.freeze([
    Object.freeze({
      id: 'io-errors',
      text: 'A call that crosses an I/O boundary (network, file system, database, subprocess) handles its failure on purpose: the error is caught and handled, returned or propagated, never dropped or ignored.',
    }),
    Object.freeze({
      id: 'input-validation',
      text: 'Data that crosses a trust boundary (a request, a message, a file, input from a user or a tenant) is validated where it enters: its type, shape, size or range is checked before use.',
    }),
    Object.freeze({
      id: 'tests-for-new-code',
      text: 'A new public function, route, endpoint or branch of behaviour comes with a test that runs it.',
    }),
    Object.freeze({
      id: 'resource-cleanup',
      text: 'A resource the code acquires (a file handle, a connection, a lock, a timer, a subscription, a temporary file) is released on every path, error paths included.',
    }),
  ]),
  requireRule: true,
  policy: Object.freeze({ high: 'unanimous', medium: 'majority', low: 'off' }),
  failOn: 'none',
  maxFindings: 20,
  changedLinesOnly: true,
  doNotReport: [
    '- anything no review rule asks for',
    '- style, naming and formatting',
    '- a choice between two correct ways of writing the same thing',
    '- a gap in code the change does not touch',
  ].join('\n'),
})
