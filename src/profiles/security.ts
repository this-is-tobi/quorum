import type { Profile } from '../core/types.ts'

/**
 * The default profile: the security review quorum has always run. Its policy is spelled out here
 * rather than read from `defaultPolicy`, so a later change to that default cannot re-tune this
 * review silently. It is deep-frozen (the object, its prompts, its lens array, each lens and its
 * policy), so a caller that sets `guidelines` on it cannot leak them into later runs of the same
 * process: callers spread it into a new object instead.
 *
 * Three lenses, not an arbitrary round number: self-consistency research shows most of the
 * achievable gain from repeated sampling arrives by roughly five to ten samples on a capable
 * model, and running votes in parallel has a real latency cost - three independent, non-debating,
 * differently-angled votes is close to the cost-effective floor, not a placeholder for "more
 * agents later".
 */
export const securityProfile: Profile = Object.freeze({
  id: 'security',
  prompts: Object.freeze({
    research: 'Review this diff for security vulnerabilities. For each candidate, give the file and the new-file line number (for removed code, the nearest line that survives), copy the offending code (the sink) verbatim from the diff, without the leading +/- marker, into `quote`, name a category/CWE, and summarize why it looks wrong in `summary`.',
    vote: [
      'One vote in a {{panel.size}}-voter panel - you do not see the other votes. Refutation angle: {{lens.id}}.',
      '{{lens.question}}',
      '',
      'Judge only from the blocks you receive. Default keep=false unless genuinely convinced.',
    ].join('\n'),
  }),
  lenses: Object.freeze([
    Object.freeze({
      id: 'reachability',
      question: 'Is this sink actually reachable from untrusted input in normal flow - not just syntactically present?',
    }),
    Object.freeze({
      id: 'impact',
      question: 'If reached, is the impact real - not just bad-looking code?',
    }),
    Object.freeze({
      id: 'defenses',
      question: 'Do existing checks elsewhere already neutralize this?',
    }),
  ]),
  policy: Object.freeze({ high: 'unanimous', medium: 'majority', low: 'off' }),
  gating: true,
})
