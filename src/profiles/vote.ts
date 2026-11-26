/**
 * The vote template of every built-in profile: one refutation angle for each lens, cast by a voter who sees no other vote,
 * with `keep=false` as the default. It is the text the security profile has always held, byte for byte, so that profile's
 * requests, their digests and the keys its stored replies are found by do not move.
 */
export const REFUTATION_VOTE: string = [
  'One vote in a {{panel.size}}-voter panel - you do not see the other votes. Refutation angle: {{lens.id}}.',
  '{{lens.question}}',
  '',
  'Judge only from the blocks you receive. Default keep=false unless genuinely convinced.',
].join('\n')
