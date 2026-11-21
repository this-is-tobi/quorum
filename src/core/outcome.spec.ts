import { describe, expect, it } from 'vitest'
import { publicView } from '../report/view.ts'
import { reportMeta, SQL } from '../testing/report.ts'
import { failsItsProfile, isIncomplete, outcome } from './outcome.ts'
import type { QuorumResult, Verdict } from './types.ts'

describe('outcome', () => {
  const kept = (profile: string, confidence: Verdict['confidence']): Verdict => ({ profile, confidence }) as Verdict
  const result = (verdicts: Verdict[], gating: Record<string, boolean>, gaps: ReadonlyArray<string | undefined> = [], unreviewed: Verdict[] = []): QuorumResult => ({
    kept: verdicts,
    discarded: [],
    unreviewed,
    meta: {
      profiles: Object.fromEntries(Object.entries(gating).map(([id, value]) => [
        id,
        { gating: value },
      ])),
      incomplete: gaps.map(profile => profile === undefined
        ? {}
        : { profile }),
    },
  }) as unknown as QuorumResult

  it('exits 1 only for a kept high finding of a gating profile', () => {
    expect(outcome(result([
      kept('style', 'high'),
    ], { style: false })).exitCode).toBe(0)
    expect(outcome(result([
      kept('style', 'high'),
    ], { style: false }, [undefined])).exitCode).toBe(4)
    expect(outcome(result([
      kept('style', 'high'),
      kept('security', 'medium'),
    ], { style: false, security: true })).exitCode).toBe(0)
    expect(outcome(result([
      kept('style', 'high'),
      kept('security', 'high'),
    ], { style: false, security: true }, [undefined])).exitCode).toBe(1)
  })

  it('counts a profile missing from meta as gating, so a gap in the result never hides a finding', () => {
    expect(outcome(result([
      kept('security', 'high'),
    ], {})).exitCode).toBe(1)
    expect(outcome({
      ...result([
        kept('security', 'high'),
      ], {}),
      meta: {
        profiles: { security: {} },
        incomplete: [],
      },
    } as unknown as QuorumResult).exitCode).toBe(1)
  })

  it('exits 4 for a gap of a gating profile, and 0 for one of an advisory profile', () => {
    const gating = { security: true, style: false }
    expect(outcome(result([], gating, ['security'])).exitCode).toBe(4)
    expect(outcome(result([], gating, ['style'])).exitCode).toBe(0)
    expect(outcome(result([], gating, [], [
      kept('style', undefined),
    ])).exitCode).toBe(0)
    expect(outcome(result([], gating, [], [
      kept('security', undefined),
    ])).exitCode).toBe(4)
    expect(outcome(result([], {}, ['team'])).exitCode).toBe(4)
  })

  const withGaps = (gating: Record<string, boolean>, gaps: object[], verdicts: Verdict[] = []): QuorumResult => {
    const base = result(verdicts, gating)
    return {
      ...base,
      meta: { ...base.meta, incomplete: gaps },
    } as unknown as QuorumResult
  }
  /**
   * `input` with every field a public view needs filled in from the report fixtures, so the view of a result this spec
   * writes sparse passes the view's schema: the verdicts', profiles' and gaps' own fields win, and what the outcome
   * reads is what the spec wrote.
   */
  const whole = (input: QuorumResult): QuorumResult => {
    const base = reportMeta()
    return {
      kept: input.kept.map(verdict => ({
        ...SQL,
        ...verdict,
      })),
      discarded: [],
      unreviewed: input.unreviewed.map(verdict => ({
        ...SQL,
        ...verdict,
      })),
      meta: {
        ...base,
        profiles: Object.fromEntries(Object.entries(input.meta.profiles).map(([id, entry]) => [
          id,
          {
            ...base.profiles.security,
            ...entry,
          },
        ])),
        incomplete: input.meta.incomplete.map(gap => ({ ...gap, detail: 'd' })),
      },
    }
  }
  /** A verdict of `profile` and `confidence` with three votes: one failed vote per `failures` entry, the rest kept; an `undefined` entry is a failed vote with no `failure` key. */
  const voted = (profile: string, confidence: Verdict['confidence'], failures: readonly unknown[]): Verdict => ({
    profile,
    confidence,
    votes: Array.from({ length: 3 }, (_, index) => index < failures.length
      ? {
          angle: `lens${index}`,
          vote: null,
          error: 'failed',
          ...(failures[index] === undefined
            ? {}
            : { failure: failures[index] }),
        }
      : {
          angle: `lens${index}`,
          vote: { keep: true, reasoning: 'r' },
          error: null,
          failure: null,
        }),
  }) as unknown as Verdict
  const voteFailedGap = { profile: 'security', reason: 'vote-failed' }
  const securityGates = { security: true }

  it('turns 4 into 0 with allowIncomplete, and never 1', () => {
    expect(outcome(withGaps(securityGates, [voteFailedGap], [
      voted('security', 'medium', [
        { kind: 'network' },
      ]),
    ]), { allowIncomplete: true }).exitCode).toBe(0)
    expect(outcome(result([
      kept('security', 'high'),
    ], securityGates, ['security']), { allowIncomplete: true }).exitCode).toBe(1)
  })

  it.each<[unknown]>([
    [
      { kind: 'network' },
    ],
    [
      { kind: 'timeout' },
    ],
    [
      { kind: 'http', status: 408 },
    ],
    [
      { kind: 'http', status: 409 },
    ],
    [
      { kind: 'http', status: 429 },
    ],
    [
      { kind: 'http', status: 500 },
    ],
    [
      { kind: 'http', status: 503 },
    ],
    [
      { kind: 'http', status: 599 },
    ],
  ])('lifts a gating profile\'s gap with allowIncomplete when its failed vote failed with %j', (failure) => {
    const verdicts = [
      voted('security', 'medium', [failure]),
    ]
    expect(outcome(withGaps(securityGates, [voteFailedGap], verdicts), { allowIncomplete: true }).exitCode).toBe(0)
    expect(outcome(withGaps(securityGates, [voteFailedGap], verdicts)).exitCode).toBe(4)
  })

  it.each<[unknown]>([
    [
      { kind: 'http', status: 400 },
    ],
    [
      { kind: 'http', status: 404 },
    ],
    [
      { kind: 'http', status: 499 },
    ],
    [
      { kind: 'http', status: 600 },
    ],
    [
      { kind: 'http' },
    ],
    [
      { kind: 'http', status: '503' },
    ],
    [
      { kind: 'refusal' },
    ],
    [
      { kind: 'truncated' },
    ],
    [
      { kind: 'invalid-response' },
    ],
    [
      { kind: 'unusable-reply' },
    ],
    [
      { kind: 'unknown' },
    ],
    [
      { kind: 'too-large' },
    ],
    [
      { kind: 'process' },
    ],
    [
      { kind: 'aborted' },
    ],
    [
      { kind: 'unsupported' },
    ],
    [
      { kind: 'provider-down' },
    ],
    [null],
    [undefined],
  ])('never lifts a gap whose failed vote failed with %j', (failure) => {
    expect(outcome(withGaps(securityGates, [voteFailedGap], [
      voted('security', 'medium', [failure]),
    ]), { allowIncomplete: true }).exitCode).toBe(4)
  })

  it.each([
    'research-unusable',
    'findings-capped',
    'finding-unreadable',
    'request-too-large',
    'binary',
    'submodule',
    'secret',
    'research-failed',
    'provider-down',
    'a-reason-no-quorum-writes',
  ])('never lifts a gating profile\'s %s gap', (reason) => {
    const gap = { profile: 'security', reason }
    const network = { kind: 'network' }
    expect(outcome(withGaps(securityGates, [voteFailedGap, gap], [
      voted('security', 'medium', [network]),
    ]), { allowIncomplete: true }).exitCode).toBe(4)
    expect(outcome({
      ...withGaps(securityGates, [gap]),
      unreviewed: [
        voted('security', undefined, [network]),
      ],
    }, { allowIncomplete: true }).exitCode).toBe(4)
    expect(outcome(withGaps({ security: true, style: false }, [
      { profile: 'style', reason },
    ]), { allowIncomplete: true }).exitCode).toBe(0)
  })

  it('exits 4 for a token-cap gap of a gating profile, even with --allow-incomplete', () => {
    const gap = { profile: 'security', reason: 'token-cap' }
    for (const options of [
      {},
      { allowIncomplete: true },
    ]) {
      expect(outcome(withGaps(securityGates, [gap]), options).exitCode).toBe(4)
      expect(outcome(withGaps(securityGates, [voteFailedGap, gap], [
        voted('security', 'medium', [
          { kind: 'network' },
        ]),
      ]), options).exitCode).toBe(4)
    }
    expect(outcome(withGaps(securityGates, [voteFailedGap], [
      voted('security', 'medium', [
        { kind: 'token-cap' },
      ]),
    ]), { allowIncomplete: true }).exitCode).toBe(4)
    expect(outcome(withGaps({ security: true, style: false }, [
      { profile: 'style', reason: 'token-cap' },
    ]), { allowIncomplete: true }).exitCode).toBe(0)
  })

  it('exits 4 for a review-deadline gap of a gating profile, even with --allow-incomplete', () => {
    const gap = { profile: 'security', reason: 'review-deadline' }
    for (const options of [
      {},
      { allowIncomplete: true },
    ]) {
      expect(outcome(withGaps(securityGates, [gap]), options).exitCode).toBe(4)
      expect(outcome(withGaps(securityGates, [voteFailedGap, gap], [
        voted('security', 'medium', [
          { kind: 'network' },
        ]),
      ]), options).exitCode).toBe(4)
    }
    expect(outcome(withGaps(securityGates, [voteFailedGap], [
      voted('security', 'medium', [
        { kind: 'review-deadline' },
      ]),
    ]), { allowIncomplete: true }).exitCode).toBe(4)
    expect(outcome(withGaps({ security: true, style: false }, [
      { profile: 'style', reason: 'review-deadline' },
    ]), { allowIncomplete: true }).exitCode).toBe(0)
  })

  it('exits 4 for a too-large gap of a gating profile, even with --allow-incomplete', () => {
    const gap = { profile: 'security', reason: 'too-large' }
    for (const options of [
      {},
      { allowIncomplete: true },
    ]) {
      expect(outcome(withGaps(securityGates, [gap]), options).exitCode).toBe(4)
      expect(outcome(withGaps(securityGates, [voteFailedGap, gap], [
        voted('security', 'medium', [
          { kind: 'network' },
        ]),
      ]), options).exitCode).toBe(4)
    }
    expect(outcome(withGaps({ security: true, style: false }, [
      { profile: 'style', reason: 'too-large' },
    ]), { allowIncomplete: true }).exitCode).toBe(0)
  })

  it('lifts an unreviewed finding whose failed votes all failed in passing, and not one beside a vote cut off', () => {
    const network = { kind: 'network' }
    expect(outcome(result([], securityGates, [], [
      voted('security', undefined, [network, network]),
    ]), { allowIncomplete: true }).exitCode).toBe(0)
    expect(outcome(result([], securityGates, [], [
      voted('security', undefined, [
        network,
        { kind: 'truncated' },
      ]),
    ]), { allowIncomplete: true }).exitCode).toBe(4)
  })

  it('lifts nothing, and throws nothing, for a verdict whose votes are not an array', () => {
    for (const votes of [
      undefined,
      null,
      'x',
      { length: 1 },
    ]) {
      const verdict = {
        ...kept('security', 'medium'),
        votes,
      } as unknown as Verdict
      expect(outcome(withGaps(securityGates, [voteFailedGap], [verdict]), { allowIncomplete: true }).exitCode).toBe(4)
    }
  })

  it('counts a vote that records a failure as failed, whatever its own vote says', () => {
    const cast = { keep: true, reasoning: 'r' }
    const verdict = {
      ...kept('security', 'medium'),
      votes: [
        {
          angle: 'a',
          vote: cast,
          error: null,
          failure: { kind: 'truncated' },
        },
        {
          angle: 'b',
          vote: null,
          error: 'failed',
          failure: { kind: 'network' },
        },
        {
          angle: 'c',
          vote: cast,
          error: null,
          failure: null,
        },
      ],
    } as unknown as Verdict
    expect(outcome(withGaps(securityGates, [voteFailedGap], [verdict]), { allowIncomplete: true }).exitCode).toBe(4)
  })

  it('lifts one gating profile\'s gap whatever the failed votes of a gating profile with no gap', () => {
    const verdicts = [
      voted('security', 'medium', [
        { kind: 'network' },
      ]),
      voted('team', 'medium', [
        { kind: 'truncated' },
      ]),
    ]
    const gates = { security: true, team: true }
    expect(outcome(withGaps(gates, [voteFailedGap], verdicts), { allowIncomplete: true }).exitCode).toBe(0)
    expect(outcome(withGaps(gates, [voteFailedGap], verdicts)).exitCode).toBe(4)
  })

  it('never lifts an unreviewed finding whose votes hold no failed vote', () => {
    expect(outcome(result([], securityGates, [], [
      voted('security', undefined, []),
    ]), { allowIncomplete: true }).exitCode).toBe(4)
  })

  it('never lifts a vote-failed gap whose profile\'s kept findings hold no failed vote', () => {
    expect(outcome(withGaps(securityGates, [voteFailedGap], [
      voted('security', 'medium', []),
    ]), { allowIncomplete: true }).exitCode).toBe(4)
  })

  const refused = (profile?: string): object => ({
    ...profile === undefined
      ? {}
      : { profile },
    reason: 'request-too-large',
  })

  it('exits 4 for a request-too-large gap of a gating profile, even with allowIncomplete, and 1 when a gating high finding was kept', () => {
    for (const allowIncomplete of [false, true]) {
      expect(outcome(withGaps({ security: true }, [
        refused('security'),
      ]), { allowIncomplete }).exitCode).toBe(4)
      expect(outcome(withGaps({}, [
        refused('team'),
      ]), { allowIncomplete }).exitCode).toBe(4)
      expect(outcome(withGaps({ style: false }, [
        refused(),
      ]), { allowIncomplete }).exitCode).toBe(4)
      expect(outcome(withGaps({ security: true }, [
        refused('security'),
      ], [
        kept('security', 'high'),
      ]), { allowIncomplete }).exitCode).toBe(1)
    }
  })

  it('exits 0 for a request-too-large gap of an advisory profile, with or without allowIncomplete', () => {
    for (const allowIncomplete of [false, true]) {
      expect(outcome(withGaps({ security: true, style: false }, [
        refused('style'),
      ]), { allowIncomplete }).exitCode).toBe(0)
    }
  })

  it('never lifts a research-failed gap of a gating profile, which no flag lifts', () => {
    expect(outcome(withGaps({ security: true }, [
      { profile: 'security', reason: 'research-failed' },
    ]), { allowIncomplete: true }).exitCode).toBe(4)
    expect(outcome(withGaps({ style: false }, [
      { profile: 'style', reason: 'research-failed' },
    ]), { allowIncomplete: true }).exitCode).toBe(0)
  })

  it('exits 4 for a binary or submodule gap of a gating profile, even with allowIncomplete, 0 for an advisory one, and 1 beside a gating high finding', () => {
    for (const allowIncomplete of [false, true]) {
      for (const reason of ['binary', 'submodule']) {
        expect(outcome(withGaps({ security: true }, [
          { profile: 'security', reason },
        ]), { allowIncomplete }).exitCode).toBe(4)
        expect(outcome(withGaps({ security: true, style: false }, [
          { profile: 'style', reason },
        ]), { allowIncomplete }).exitCode).toBe(0)
        expect(outcome(withGaps({ security: true }, [
          { profile: 'security', reason },
        ], [
          kept('security', 'high'),
        ]), { allowIncomplete }).exitCode).toBe(1)
      }
    }
  })

  /** A result whose `meta.profiles` holds `entries` as they are, so a spec writes the meta of any release. */
  const recorded = (entries: Record<string, unknown>, parts: { readonly kept?: Verdict[], readonly unreviewed?: Verdict[], readonly gaps?: object[] } = {}): QuorumResult => ({
    kept: parts.kept ?? [],
    discarded: [],
    unreviewed: parts.unreviewed ?? [],
    meta: {
      profiles: entries,
      incomplete: parts.gaps ?? [],
    },
  }) as unknown as QuorumResult

  it.each([
    ['high', 'high', 1],
    ['high', 'medium', 1],
    ['high', 'low', 1],
    ['high', 'none', 0],
    ['medium', 'high', 0],
    ['medium', 'medium', 1],
    ['medium', 'low', 1],
    ['medium', 'none', 0],
    ['low', 'high', 0],
    ['low', 'medium', 0],
    ['low', 'low', 1],
    ['low', 'none', 0],
  ] as const)('fails on a kept %s finding at fail-on %s: exit %i', (confidence, failOn, exitCode) => {
    expect(outcome(recorded({
      security: { failOn },
    }, {
      kept: [
        kept('security', confidence),
      ],
    })).exitCode).toBe(exitCode)
  })

  it.each([
    ['high', 'high', true],
    ['high', 'medium', true],
    ['high', 'low', true],
    ['high', 'none', false],
    ['medium', 'high', false],
    ['medium', 'medium', true],
    ['medium', 'low', true],
    ['medium', 'none', false],
    ['low', 'high', false],
    ['low', 'medium', false],
    ['low', 'low', true],
    ['low', 'none', false],
  ] as const)('says a kept %s finding fails its profile at fail-on %s: %s', (confidence, failOn, fails) => {
    const result = recorded({
      security: { failOn },
    }, {
      kept: [
        kept('security', confidence),
      ],
    })
    expect(failsItsProfile(result, result.kept[0])).toBe(fails)
    const view = publicView(whole(result))
    expect(failsItsProfile(view, view.kept[0])).toBe(fails)
  })

  it.each(['high', 'medium', 'low'])('exits 4 for a gap of a profile at fail-on %s, and 0 for one at none', (failOn) => {
    const gap = { profile: 'security', reason: 'binary' }
    const unreviewed = [
      kept('security', undefined),
    ]
    expect(outcome(recorded({
      security: { failOn },
    }, {
      gaps: [gap],
    })).exitCode).toBe(4)
    expect(outcome(recorded({
      security: { failOn },
    }, { unreviewed })).exitCode).toBe(4)
    expect(outcome(recorded({
      security: { failOn: 'none' },
    }, {
      gaps: [gap],
    })).exitCode).toBe(0)
    expect(outcome(recorded({
      security: { failOn: 'none' },
    }, { unreviewed })).exitCode).toBe(0)
    expect(outcome(recorded({
      security: { failOn: 'none' },
      style: { failOn },
    }, {
      gaps: [gap],
    })).exitCode).toBe(0)
  })

  it('reads a result recorded before failOn: gating true as high, false as none, and failOn over gating', () => {
    const medium = [
      kept('security', 'medium'),
    ]
    const high = [
      kept('security', 'high'),
    ]
    expect(outcome(recorded({
      security: { gating: true },
    }, { kept: medium })).exitCode).toBe(0)
    expect(outcome(recorded({
      security: { gating: true },
    }, { kept: high })).exitCode).toBe(1)
    expect(outcome(recorded({
      security: { gating: false },
    }, { kept: high })).exitCode).toBe(0)
    expect(outcome(recorded({
      security: { failOn: 'medium', gating: false },
    }, { kept: medium })).exitCode).toBe(1)
  })

  it('fails on high for a profile missing from meta, one whose failOn is no level, or an entry that is null or only inherits its failOn', () => {
    for (const entries of [
      {},
      {
        security: { failOn: 'critical' },
      },
      { security: null },
      {
        security: Object.create({ failOn: 'none', gating: false }),
      },
      {
        security: Object.create({ failOn: 'low' }),
      },
    ]) {
      expect(outcome(recorded(entries, {
        kept: [
          kept('security', 'high'),
        ],
      })).exitCode).toBe(1)
      expect(outcome(recorded(entries, {
        kept: [
          kept('security', 'medium'),
        ],
      })).exitCode).toBe(0)
    }
  })

  it('answers pass, findings or incomplete with the exit code that says it, and lifted only when allowIncomplete lifted it', () => {
    const security = {
      security: { failOn: 'high' },
    }
    expect(outcome(recorded(security))).toEqual({ status: 'pass', exitCode: 0, lifted: false })
    expect(outcome(recorded(security, {
      kept: [
        kept('security', 'high'),
      ],
    }))).toEqual({ status: 'findings', exitCode: 1, lifted: false })
    expect(outcome(recorded(security, {
      gaps: [
        { profile: 'security', reason: 'binary' },
      ],
    }))).toEqual({ status: 'incomplete', exitCode: 4, lifted: false })
    expect(outcome(withGaps({ security: true }, [voteFailedGap], [
      voted('security', 'medium', [
        { kind: 'network' },
      ]),
    ]), { allowIncomplete: true })).toEqual({ status: 'pass', exitCode: 0, lifted: true })
  })

  it('reads a public view as the result it came from, a lifted gap included', () => {
    const security = {
      security: { failOn: 'high' },
    }
    const results = [
      recorded(security),
      recorded(security, {
        kept: [
          kept('security', 'high'),
        ],
      }),
      recorded(security, {
        gaps: [
          { profile: 'security', reason: 'binary' },
        ],
      }),
      withGaps({ security: true }, [voteFailedGap], [
        voted('security', 'medium', [
          { kind: 'network' },
        ]),
      ]),
      withGaps({ security: true }, [voteFailedGap], [
        voted('security', 'medium', [
          { kind: 'refusal' },
        ]),
      ]),
    ]
    for (const input of results) {
      for (const allowIncomplete of [false, true]) {
        expect(outcome(publicView(whole(input)), { allowIncomplete })).toEqual(outcome(input, { allowIncomplete }))
      }
    }
    expect(outcome(publicView(whole(results[3])), { allowIncomplete: true })).toEqual({ status: 'pass', exitCode: 0, lifted: true })
    expect(outcome(publicView(whole(results[4])), { allowIncomplete: true })).toEqual({ status: 'incomplete', exitCode: 4, lifted: false })
  })

  it('says a review is incomplete when a gating profile has a gap or an unreviewed finding, whatever a kept finding or the lift says', () => {
    const security = {
      security: { failOn: 'high' },
      style: { failOn: 'none' },
    }
    const gap = { profile: 'security', reason: 'binary' }
    expect(isIncomplete(recorded(security))).toBe(false)
    expect(isIncomplete(recorded(security, {
      gaps: [gap],
    }))).toBe(true)
    expect(isIncomplete(recorded(security, {
      unreviewed: [
        kept('security', undefined),
      ],
    }))).toBe(true)
    expect(isIncomplete(recorded(security, {
      kept: [
        kept('security', 'high'),
      ],
      gaps: [gap],
    }))).toBe(true)
    expect(isIncomplete(withGaps({ security: true }, [voteFailedGap], [
      voted('security', 'medium', [
        { kind: 'network' },
      ]),
    ]))).toBe(true)
    expect(outcome(withGaps({ security: true }, [voteFailedGap], [
      voted('security', 'medium', [
        { kind: 'network' },
      ]),
    ]), { allowIncomplete: true }).lifted).toBe(true)
    expect(isIncomplete(recorded(security, {
      gaps: [
        { profile: 'style', reason: 'binary' },
      ],
    }))).toBe(false)
    expect(isIncomplete(recorded(security, {
      unreviewed: [
        kept('style', undefined),
      ],
    }))).toBe(false)
    expect(isIncomplete(publicView(whole(recorded(security, {
      gaps: [gap],
    }))))).toBe(true)
  })
})
