import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import { publicView } from '../report/view.ts'
import { corpusResult } from '../testing/github-corpus.ts'
import { blankResult, cast, reportMeta, reportResult, SETTINGS, SQL, TOKEN } from '../testing/report.ts'
import { PROVIDER_ERROR_KINDS } from './errors.ts'
import { publicViewSchema, resultSchema, settingsSchema } from './result-schema.ts'
import type { PublicView, QuorumResult } from './types.ts'

/** `T` with no `readonly` at any depth, its optional fields still optional and its tuples tuples: the shape a JSON parse gives. */
type Mutable<T> = T extends readonly unknown[]
  ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T

/** What a JSON parse makes of `value`: the data a saved file holds, which an `undefined` field is not part of. */
function saved<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** A forged value the schemas read as untyped data. */
type Forged = Record<string, any>

describe('resultSchema', () => {
  it('reads exactly the result the core returns, so a field the core adds or drops, optional or not, fails the typecheck', () => {
    expectTypeOf<z.output<typeof resultSchema>>().toEqualTypeOf<Mutable<QuorumResult>>()
  })
})

describe('publicViewSchema', () => {
  it('reads exactly the public view the core returns, so a field the view adds or drops fails the typecheck', () => {
    expectTypeOf<z.output<typeof publicViewSchema>>().toEqualTypeOf<Mutable<PublicView>>()
  })
})

describe('the schemas of a result', () => {
  it('reads every result a review writes, and the public view of each', () => {
    for (const result of [
      reportResult(),
      blankResult(),
      corpusResult(),
    ]) {
      const full = saved(result)
      expect(resultSchema.parse(full)).toEqual(full)
      expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
      const view = saved(publicView(result))
      expect(publicViewSchema.parse(view)).toEqual(view)
      expect(JSON.stringify(publicViewSchema.parse(view))).toBe(JSON.stringify(view))
    }
  })

  it('reads a file skipped with the rule test in meta.leftOut, in the public view too', () => {
    const result = reportResult({
      meta: {
        leftOut: [
          { file: 'src/a.test.ts', reason: 'skipped', rule: 'test' },
        ],
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
  })

  it('reads a result holding provider-down as a gap, a coverage reason and a vote failure', () => {
    const down = {
      angle: 'b',
      vote: null,
      error: 'x',
      failure: { kind: 'provider-down' },
    } as const
    const result = reportResult({
      kept: [
        {
          ...SQL,
          keptVotes: 2,
          confidence: 'medium',
          votes: [
            cast(true),
            cast(true),
            down,
          ],
        },
      ],
      unreviewed: [
        {
          ...TOKEN,
          votes: [down, down, down],
        },
      ],
      meta: {
        ...reportResult().meta,
        incomplete: [
          { profile: 'security', reason: 'provider-down', detail: '1 of 6 research parts were not sent, since their provider was down' },
        ],
        profiles: {
          security: {
            ...reportResult().meta.profiles.security,
            coverage: [
              { file: 'src/auth/login.ts', status: 'reviewed' },
              {
                file: 'src/session.js',
                status: 'partial',
                left: [
                  { start: 30, end: 34, reason: 'provider-down' },
                ],
              },
              { file: 'src/upload.js', status: 'unreviewed', reason: 'provider-down' },
            ],
          },
        },
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(view.meta.incomplete).toEqual([
      { profile: 'security', reason: 'provider-down' },
    ])
  })

  it('reads a coverage range of reason findings-capped, in the public view too', () => {
    const result = reportResult({
      meta: {
        ...reportResult().meta,
        incomplete: [
          { profile: 'security', reason: 'findings-capped', detail: '2 of 5 reported findings were not reviewed, the last ones of the replies that listed the most (the cap is 3)' },
        ],
        profiles: {
          security: {
            ...reportResult().meta.profiles.security,
            coverage: [
              { file: 'src/auth/login.ts', status: 'reviewed' },
              {
                file: 'src/session.js',
                status: 'partial',
                left: [
                  { start: 30, end: 34, reason: 'findings-capped' },
                ],
              },
            ],
          },
        },
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
  })

  it('reads a result holding interrupted as a gap, a coverage reason and a vote failure', () => {
    const stopped = {
      angle: 'b',
      vote: null,
      error: 'the review was interrupted',
      failure: { kind: 'interrupted' },
    } as const
    const result = reportResult({
      unreviewed: [
        {
          ...TOKEN,
          votes: [stopped, stopped, stopped],
        },
      ],
      meta: {
        ...reportResult().meta,
        incomplete: [
          { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 2 of its 3 research parts and 3 vote(s)' },
        ],
        profiles: {
          security: {
            ...reportResult().meta.profiles.security,
            coverage: [
              { file: 'src/auth/login.ts', status: 'reviewed' },
              {
                file: 'src/session.js',
                status: 'partial',
                left: [
                  { start: 30, end: 34, reason: 'interrupted' },
                ],
              },
              { file: 'src/upload.js', status: 'unreviewed', reason: 'interrupted' },
            ],
          },
        },
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(view.meta.incomplete).toEqual([
      { profile: 'security', reason: 'interrupted' },
    ])
  })

  it('reads meta.adaptations strictly, refusing a cause no quorum writes', () => {
    const adapted = {
      provider: 'api',
      setting: 'thinking',
      from: 'default',
      to: 'low',
      cause: 'cut-off-thinking',
    } as const
    const result = reportResult({
      meta: {
        ...reportResult().meta,
        adaptations: [adapted],
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(view.meta.adaptations).toEqual([adapted])
    // The field is required, each entry is strict, and a setting or a cause outside the closed lists is refused.
    const { adaptations: _none, ...without } = full.meta
    expect(resultSchema.safeParse({ ...full, meta: without }).success).toBe(false)
    for (const forged of [
      { ...adapted, cause: 'because' },
      { ...adapted, setting: 'temperature' },
      { ...adapted, extra: 1 },
      {
        provider: 'api',
        setting: 'thinking',
        from: 'default',
        to: 'low',
      },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: {
          ...full.meta,
          adaptations: [forged],
        },
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: {
          ...view.meta,
          adaptations: [forged],
        },
      }).success, JSON.stringify(forged)).toBe(false)
    }
    for (const cause of [
      'cut-off-thinking',
      'no-answer-thinking',
      'empty-reply',
      'format-refused',
      'stream-refused',
      'stream-answered-whole',
      'byte-bound-refused',
      'loaded-window',
      'lowering-refused',
    ]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: {
          ...full.meta,
          adaptations: [
            { ...adapted, cause },
          ],
        },
      }).success, cause).toBe(true)
    }
    expect(resultSchema.safeParse({
      ...full,
      meta: {
        ...full.meta,
        adaptations: [
          {
            provider: 'api',
            setting: 'stream',
            from: 'stream',
            to: 'bare',
            cause: 'stream-refused',
          },
        ],
      },
    }).success).toBe(true)
  })

  it('reads a verdict\'s rule by the id\'s pattern, and a profile\'s rules and invalidRules as counts', () => {
    // A verdict that cites a rule holds it after its category, where the core writes it, so a result read back is written as it was.
    const cited = Object.fromEntries(Object.entries(SQL).flatMap(([key, value]) => key === 'category'
      ? [
          [key, value],
          ['rule', 'no-any'],
        ]
      : [
          [key, value],
        ])) as typeof SQL
    const base = reportResult().meta
    const result = reportResult({
      kept: [cited],
      meta: {
        ...base,
        profiles: {
          security: {
            ...base.profiles.security,
            rules: { listed: 3, sent: 2 },
            invalidRules: 1,
          },
        },
      },
    })
    expect(Object.keys(cited).slice(5, 8)).toEqual(['category', 'rule', 'summary'])
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(JSON.stringify(publicViewSchema.parse(view))).toBe(JSON.stringify(view))
    expect(view.kept[0].rule).toBe('no-any')
    expect(view.meta.profiles.security).toMatchObject({
      rules: { listed: 3, sent: 2 },
      invalidRules: 1,
    })
    // A rule is an id of the pattern, and a verdict that cites none holds none.
    for (const rule of [
      'No-Any',
      '1st',
      '',
      'x'.repeat(65),
      'no any',
      'no-any\n# heading',
      7,
      null,
    ]) {
      expect(resultSchema.safeParse({
        ...full,
        kept: [
          { ...full.kept[0], rule },
        ],
      }).success, String(rule)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        kept: [
          { ...view.kept[0], rule },
        ],
      }).success, String(rule)).toBe(false)
    }
    for (const rule of [
      'a',
      'no-any',
      'a.b_c-d',
      'x'.repeat(64),
    ]) {
      expect(resultSchema.safeParse({
        ...full,
        kept: [
          { ...full.kept[0], rule },
        ],
      }).success, rule).toBe(true)
    }
    expect(resultSchema.safeParse({
      ...full,
      unreviewed: [
        { ...full.unreviewed[0], rule: 'license' },
      ],
    }).success).toBe(true)
    // The counts are required in a profile's meta, the public view's too, whole numbers, and each holds no field but its own.
    const profile = (meta: { profiles: Record<string, Forged> }, changes: Forged): Forged => ({
      ...meta,
      profiles: {
        security: {
          ...meta.profiles.security,
          ...changes,
        },
      },
    })
    const { rules: _rules, invalidRules: _invalid, ...security } = full.meta.profiles.security
    const { rules: _publicRules, invalidRules: _publicInvalid, ...publicSecurity } = view.meta.profiles.security
    expect(resultSchema.safeParse({
      ...full,
      meta: {
        ...full.meta,
        profiles: { security },
      },
    }).success).toBe(false)
    expect(publicViewSchema.safeParse({
      ...view,
      meta: {
        ...view.meta,
        profiles: { security: publicSecurity },
      },
    }).success).toBe(false)
    expect(resultSchema.safeParse({
      ...full,
      meta: {
        ...full.meta,
        profiles: {
          security: {
            ...security,
            rules: { listed: 0, sent: 0 },
          },
        },
      },
    }).success).toBe(false)
    for (const forged of [
      {
        rules: { listed: -1, sent: 0 },
      },
      {
        rules: { listed: 1.5, sent: 0 },
      },
      {
        rules: { listed: 1 },
      },
      {
        rules: { listed: 1, sent: 1, extra: 1 },
      },
      {
        rules: [1, 1],
      },
      { rules: 3 },
      { invalidRules: -1 },
      { invalidRules: 0.5 },
      { invalidRules: '1' },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: profile(full.meta, forged),
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: profile(view.meta, forged),
      }).success, JSON.stringify(forged)).toBe(false)
    }
  })

  it('reads a profile\'s research counts, and refuses a result without them', () => {
    const result = reportResult()
    const full = saved(result)
    const view = saved(publicView(result))
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    // The counts sit after `invalidRules`, in the order the core writes them, so a result read back is written as it was.
    expect(Object.keys(full.meta.profiles.security).slice(6, 8)).toEqual(['invalidRules', 'research'])
    expect(Object.keys(full.meta.profiles.security.research)).toEqual([
      'parts',
      'listed',
      'panel',
      'capped',
      'saturated',
    ])
    const profile = (meta: { profiles: Record<string, Forged> }, changes: Forged): Forged => ({
      ...meta,
      profiles: {
        security: {
          ...meta.profiles.security,
          ...changes,
        },
      },
    })
    // A result of 0.13.0 has none, and a profile's meta without them is no result.
    const { research: _research, ...older } = full.meta.profiles.security
    expect(resultSchema.safeParse({
      ...full,
      meta: {
        ...full.meta,
        profiles: { security: older },
      },
    }).success).toBe(false)
    // Each count is a whole number, none is left out, and the record holds no field but its own.
    const counted = full.meta.profiles.security.research
    for (const forged of [
      { parts: -1 },
      { listed: 1.5 },
      { panel: '3' },
      { capped: null },
      { saturated: Number.NaN },
      { extra: 1 },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: profile(full.meta, {
          research: {
            ...counted,
            ...forged,
          },
        }),
      }).success, JSON.stringify(forged)).toBe(false)
    }
    for (const key of Object.keys(counted)) {
      const { [key]: _left, ...short } = counted as unknown as Record<string, number>
      expect(resultSchema.safeParse({
        ...full,
        meta: profile(full.meta, { research: short }),
      }).success, key).toBe(false)
    }
    expect(resultSchema.safeParse({
      ...full,
      meta: profile(full.meta, {
        research: [0, 0, 0, 0, 0],
      }),
    }).success).toBe(false)
    // The public view holds none: the view withholds them, and a view that holds them is no view quorum writes.
    expect(view.meta.profiles.security).not.toHaveProperty('research')
    expect(publicViewSchema.safeParse({
      ...view,
      meta: profile(view.meta, { research: counted }),
    }).success).toBe(false)
  })

  it('reads meta.calls, and refuses nine served models or a result without it', () => {
    const served = (count: number): Array<{ model: string, calls: number }> => Array.from({ length: count }, (_, index) => ({ model: `local-model-${index + 1}`, calls: 1 }))
    const calls = {
      p: {
        model: 'm',
        served: served(8),
        servedOthers: 2,
      },
      q: { model: 'n', served: [] },
    }
    const result = reportResult({
      meta: { calls },
    })
    const full = saved(result)
    const view = saved(publicView(result))
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    // The record sits after the usage and before the gaps, its keys in the order the core writes them.
    expect(Object.keys(full.meta).slice(5, 8)).toEqual(['profiles', 'usage', 'calls'])
    expect(Object.keys(full.meta.calls.p)).toEqual(['model', 'served', 'servedOthers'])
    expect(Object.keys(full.meta.calls.p.served[0])).toEqual(['model', 'calls'])
    const withCalls = (changes: unknown): Forged => ({
      ...full,
      meta: {
        ...full.meta,
        calls: changes,
      },
    })
    // A result of 0.13.0 has none, and a meta without it is no result.
    const { calls: _calls, ...older } = full.meta
    expect(resultSchema.safeParse({ ...full, meta: older }).success).toBe(false)
    expect(resultSchema.safeParse(withCalls({})).success).toBe(true)
    // Eight served models and a model of 100 characters are the most, and nine, or 101 characters, are refused.
    expect(resultSchema.safeParse(withCalls({
      p: {
        model: 'm',
        served: served(8),
      },
    })).success).toBe(true)
    expect(resultSchema.safeParse(withCalls({
      p: {
        model: 'm',
        served: served(9),
      },
    })).success).toBe(false)
    expect(resultSchema.safeParse(withCalls({
      p: {
        model: 'm',
        served: [
          {
            model: 'x'.repeat(100),
            calls: 1,
          },
        ],
      },
    })).success).toBe(true)
    expect(resultSchema.safeParse(withCalls({
      p: {
        model: 'm',
        served: [
          {
            model: 'x'.repeat(101),
            calls: 1,
          },
        ],
      },
    })).success).toBe(false)
    // Each count is a whole number, `servedOthers` is absent when there is none, and no record holds a field but its own.
    for (const forged of [
      {
        model: 'm',
        served: [
          { model: 'a', calls: -1 },
        ],
      },
      {
        model: 'm',
        served: [
          { model: 'a', calls: 1.5 },
        ],
      },
      {
        model: 'm',
        served: [
          { model: 'a', calls: '1' },
        ],
      },
      {
        model: 'm',
        served: [
          { model: 'a', calls: 1, extra: 1 },
        ],
      },
      {
        model: 'm',
        served: [
          { model: 3, calls: 1 },
        ],
      },
      { model: 'm', served: [], servedOthers: 0 },
      { model: 'm', served: [], servedOthers: 1.5 },
      { model: 'm', served: [], extra: 1 },
      { model: 'm' },
      { served: [] },
      {
        model: 'm',
        served: { a: 1 },
      },
    ]) {
      expect(resultSchema.safeParse(withCalls({ p: forged })).success, JSON.stringify(forged)).toBe(false)
    }
    expect(resultSchema.safeParse(withCalls([])).success).toBe(false)
    expect(resultSchema.safeParse(withCalls(null)).success).toBe(false)
    // The public view holds none: the view withholds it, and a view that holds it is no view quorum writes.
    expect(view.meta).not.toHaveProperty('calls')
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(publicViewSchema.safeParse({
      ...view,
      meta: {
        ...view.meta,
        calls,
      },
    }).success).toBe(false)
  })

  it('reads each provider\'s role calls and each profile\'s stages, and refuses a failed kind quorum does not write', () => {
    const role = {
      calls: 5,
      failed: { http: 1, network: 1, 'unusable-reply': 1 },
      stopped: 1,
      retried: 2,
      reused: 0,
      usage: { inputTokens: 5000, outputTokens: 500, costUsd: 0.25 },
      callMs: { total: 12_000, longest: 4000 },
    }
    const stages = { research: 250_000, dedup: 3000, panel: 1_805_000 }
    const base = reportMeta()
    const result = reportResult({
      meta: {
        calls: {
          p: {
            model: 'm',
            served: [],
            research: role,
            vote: { ...role, failed: {} },
          },
          q: { model: 'n', served: [], vote: role },
        },
        profiles: {
          security: { ...base.profiles.security, stages },
        },
      },
    })
    const full = saved(result)
    const view = saved(publicView(result))
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    // The roles sit after the served models and each count in the order the core writes it, so a result read back is written as it was.
    expect(Object.keys(full.meta.calls.p)).toEqual(['model', 'served', 'research', 'vote'])
    expect(Object.keys(full.meta.calls.p.research ?? {})).toEqual([
      'calls',
      'failed',
      'stopped',
      'retried',
      'reused',
      'usage',
      'callMs',
    ])
    expect(Object.keys(full.meta.calls.p.research?.callMs ?? {})).toEqual(['total', 'longest'])
    expect(Object.keys(full.meta.profiles.security.stages)).toEqual(['research', 'dedup', 'panel'])
    const withCalls = (changes: unknown): Forged => ({
      ...full,
      meta: {
        ...full.meta,
        calls: { p: changes },
      },
    })
    const withStages = (changes: unknown): Forged => ({
      ...full,
      meta: {
        ...full.meta,
        profiles: {
          security: {
            ...full.meta.profiles.security,
            stages: changes,
          },
        },
      },
    })
    // A provider that played one role has no record of the other, and a profile with no stage ended has none: `{}`.
    expect(resultSchema.safeParse(withCalls({ model: 'm', served: [], vote: role })).success).toBe(true)
    expect(resultSchema.safeParse(withCalls({ model: 'm', served: [], research: role })).success).toBe(true)
    expect(resultSchema.safeParse(withStages({})).success).toBe(true)
    expect(resultSchema.safeParse(withStages({ panel: 7 })).success).toBe(true)
    // A failed call is counted under a kind a provider's failure has, or `unusable-reply`, and under no other.
    for (const kind of [...PROVIDER_ERROR_KINDS, 'unusable-reply']) {
      expect(resultSchema.safeParse(withCalls({
        model: 'm',
        served: [],
        research: {
          ...role,
          failed: { [kind]: 1 },
        },
      })).success, kind).toBe(true)
    }
    for (const forged of [
      { 'token-cap': 1 },
      { 'provider-down': 1 },
      { 'review-deadline': 1 },
      { unknown: 1 },
      { http: -1 },
      { http: 1.5 },
      { http: '1' },
      { http: null },
    ] as Forged[]) {
      expect(resultSchema.safeParse(withCalls({
        model: 'm',
        served: [],
        research: { ...role, failed: forged },
      })).success, JSON.stringify(forged)).toBe(false)
    }
    // Each count is a whole number, none is left out, and no record holds a field but its own.
    for (const forged of [
      { calls: -1 },
      { calls: 1.5 },
      { stopped: '1' },
      { retried: null },
      { reused: Number.NaN },
      { failed: [] },
      {
        usage: { inputTokens: -1, outputTokens: 0 },
      },
      {
        usage: { inputTokens: 0 },
      },
      {
        callMs: { total: -1, longest: 0 },
      },
      {
        callMs: { total: 1.5, longest: 0 },
      },
      {
        callMs: { total: 1 },
      },
      {
        callMs: { total: 1, longest: 1, extra: 1 },
      },
      { extra: 1 },
    ] as Forged[]) {
      expect(resultSchema.safeParse(withCalls({
        model: 'm',
        served: [],
        research: {
          ...role,
          ...forged,
        },
      })).success, JSON.stringify(forged)).toBe(false)
    }
    for (const key of Object.keys(role)) {
      const { [key]: _left, ...short } = role as Record<string, unknown>
      expect(resultSchema.safeParse(withCalls({ model: 'm', served: [], research: short })).success, key).toBe(false)
    }
    // Each stage is one of the three, with a whole number of milliseconds.
    for (const forged of [
      { review: 1 },
      { research: -1 },
      { research: 1.5 },
      { research: '1' },
      { research: null },
      [250_000],
    ] as Forged[]) {
      expect(resultSchema.safeParse(withStages(forged)).success, JSON.stringify(forged)).toBe(false)
    }
    // A result of 0.13.0 has no stages, and a profile's meta without them is no result.
    const { stages: _stages, ...older } = full.meta.profiles.security
    expect(resultSchema.safeParse({
      ...full,
      meta: {
        ...full.meta,
        profiles: { security: older },
      },
    }).success).toBe(false)
    // The public view keeps the stages and withholds the roles with the rest of `meta.calls`.
    expect(view.meta.profiles.security.stages).toEqual(stages)
    expect(view.meta).not.toHaveProperty('calls')
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(JSON.stringify(publicViewSchema.parse(view))).toBe(JSON.stringify(view))
    const { stages: _kept, ...viewless } = view.meta.profiles.security
    expect(publicViewSchema.safeParse({
      ...view,
      meta: {
        ...view.meta,
        profiles: { security: viewless },
      },
    }).success).toBe(false)
    expect(publicViewSchema.safeParse({
      ...view,
      meta: {
        ...view.meta,
        profiles: {
          security: {
            ...view.meta.profiles.security,
            stages: { review: 1 },
          },
        },
      },
    }).success).toBe(false)
  })

  it('reads a profile\'s asksNothing as true alone, after its invalidRules, in the public view too, and does not require it', () => {
    const base = reportResult().meta
    // The profile as the core writes it: the flag after the counts of rules, before the coverage.
    const { coverage, ...counted } = base.profiles.security
    const asked = reportResult({
      meta: {
        ...base,
        profiles: {
          security: {
            ...counted,
            asksNothing: true,
            coverage,
          },
        },
      },
    })
    const full = saved(asked)
    const view = saved(publicView(asked))
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(JSON.stringify(publicViewSchema.parse(view))).toBe(JSON.stringify(view))
    // It sits after the counts of rules, where the core writes it, so a result read back is written as it was.
    expect(Object.keys(full.meta.profiles.security).slice(4, 10)).toEqual([
      'invalidFindings',
      'rules',
      'invalidRules',
      'research',
      'stages',
      'asksNothing',
    ])
    expect(Object.keys(view.meta.profiles.security).slice(4, 9)).toEqual([
      'invalidFindings',
      'rules',
      'invalidRules',
      'stages',
      'asksNothing',
    ])
    // A result that holds none is read as it always was, the field absent in what the schema returns.
    const plain = saved(reportResult())
    expect(resultSchema.parse(plain).meta.profiles.security).not.toHaveProperty('asksNothing')
    expect(publicViewSchema.parse(saved(publicView(reportResult()))).meta.profiles.security).not.toHaveProperty('asksNothing')
    // Only `true` is a value: it is a flag the core sets, absent otherwise, never `false` or another word.
    for (const forged of [
      { asksNothing: false },
      { asksNothing: 'true' },
      { asksNothing: 1 },
      { asksNothing: null },
      {
        asksNothing: { listed: 0 },
      },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: {
          ...full.meta,
          profiles: {
            security: {
              ...full.meta.profiles.security,
              ...forged,
            },
          },
        },
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: {
          ...view.meta,
          profiles: {
            security: {
              ...view.meta.profiles.security,
              ...forged,
            },
          },
        },
      }).success, JSON.stringify(forged)).toBe(false)
    }
  })

  it('reads awayFromChange as an optional count, and a result without it', () => {
    const base = reportMeta()
    const { providers, policy, failOn, gating, invalidFindings, rules, invalidRules, research, stages, coverage } = base.profiles.security
    // The profile as the core writes it: the count after the counts of rules, before the research record.
    const counted = reportResult({
      meta: {
        ...base,
        profiles: {
          security: {
            providers,
            policy,
            failOn,
            gating,
            invalidFindings,
            rules,
            invalidRules,
            awayFromChange: 2,
            research,
            stages,
            coverage,
          },
        },
      },
    })
    const full = saved(counted)
    const view = saved(publicView(counted))
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(JSON.stringify(publicViewSchema.parse(view))).toBe(JSON.stringify(view))
    expect(Object.keys(full.meta.profiles.security).slice(6, 9)).toEqual(['invalidRules', 'awayFromChange', 'research'])
    expect(Object.keys(view.meta.profiles.security).slice(4, 8)).toEqual([
      'invalidFindings',
      'rules',
      'invalidRules',
      'awayFromChange',
    ])
    expect(full.meta.profiles.security.awayFromChange).toBe(2)
    expect(view.meta.profiles.security.awayFromChange).toBe(2)
    // A result of an earlier release holds none, and the schema returns it as it always did.
    const plain = saved(reportResult())
    expect(resultSchema.parse(plain).meta.profiles.security).not.toHaveProperty('awayFromChange')
    expect(publicViewSchema.parse(saved(publicView(reportResult()))).meta.profiles.security).not.toHaveProperty('awayFromChange')
    // A count of 0 is a value: a profile that reviews changed lines only and dropped none says so.
    for (const value of [0, 7]) {
      const zero = {
        ...full,
        meta: {
          ...full.meta,
          profiles: {
            security: { ...full.meta.profiles.security, awayFromChange: value },
          },
        },
      }
      expect(resultSchema.parse(zero).meta.profiles.security.awayFromChange).toBe(value)
    }
    // It is a whole number from 0 on.
    const profile = (meta: { profiles: Record<string, Forged> }, changes: Forged): Forged => ({
      ...meta,
      profiles: {
        security: {
          ...meta.profiles.security,
          ...changes,
        },
      },
    })
    for (const forged of [
      { awayFromChange: -1 },
      { awayFromChange: 0.5 },
      { awayFromChange: '1' },
      { awayFromChange: null },
      { awayFromChange: true },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: profile(full.meta, forged),
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: profile(view.meta, forged),
      }).success, JSON.stringify(forged)).toBe(false)
    }
  })

  it('reads meta.reused strictly, in the public view too, and does not require it', () => {
    const result = reportResult({
      meta: {
        ...reportResult().meta,
        reused: { research: 2, votes: 5 },
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(view.meta.reused).toEqual({ research: 2, votes: 5 })
    // A review with no store has none, and a count is a whole number, no more fields than the two.
    const { reused: _none, ...without } = full.meta
    expect(resultSchema.safeParse({ ...full, meta: without }).success).toBe(true)
    for (const forged of [
      { research: -1, votes: 0 },
      { research: 1.5, votes: 0 },
      { research: 1 },
      { research: 1, votes: 0, extra: 1 },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: { ...full.meta, reused: forged },
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: { ...view.meta, reused: forged },
      }).success, JSON.stringify(forged)).toBe(false)
    }
  })

  it('reads meta.context, and refuses a record whose kind, origin, status or hash is none it knows', () => {
    const none = { characters: 0, comments: 0, entities: 0 }
    const commit = 'c'.repeat(40)
    const documents = [
      {
        profile: 'security',
        kind: 'guidelines',
        origin: 'profile',
        status: 'read',
        bytes: 12,
        removed: { characters: 1, comments: 0, entities: 0 },
      },
      {
        profile: 'security',
        kind: 'do-not-report',
        origin: 'config',
        sha256: 'a'.repeat(64),
        status: 'read',
        bytes: 40,
        removed: none,
      },
      {
        profile: 'security',
        kind: 'guidelines',
        origin: 'repository',
        path: 'REVIEW.md',
        commit,
        sha256: 'b'.repeat(64),
        status: 'read',
        bytes: 100,
        removed: { characters: 0, comments: 2, entities: 3 },
      },
      {
        profile: 'security',
        kind: 'guidelines',
        origin: 'repository',
        path: 'GUIDE.md',
        commit: 'd'.repeat(64),
        status: 'missing',
        bytes: 0,
        removed: none,
      },
    ] as const
    const result = reportResult({
      meta: {
        ...reportResult().meta,
        context: {
          documents: documents.map(document => ({
            ...document,
            removed: { ...document.removed },
          })),
        },
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(view.meta.context).toEqual(full.meta.context)
    // The field is required, in the full result and the view, and empty for a review that read none.
    const { context: _none, ...without } = full.meta
    expect(resultSchema.safeParse({ ...full, meta: without }).success).toBe(false)
    const { context: _noView, ...withoutView } = view.meta
    expect(publicViewSchema.safeParse({ ...view, meta: withoutView }).success).toBe(false)
    expect(resultSchema.parse(saved(blankResult())).meta.context).toEqual({ documents: [] })
    // Each record is strict, and a kind, an origin, a status or a hash outside the closed lists is refused.
    const [own, file, repository, missing] = documents.map(document => ({ ...document })) as Forged[]
    for (const forged of [
      { ...own, kind: 'notes' },
      // A record of kind rules holds its count of rules, which this one lacks: another case than an unknown kind.
      { ...own, kind: 'rules' },
      { ...own, origin: 'file' },
      { ...own, status: 'unreadable' },
      { ...own, extra: 1 },
      { ...own, text: 'Ignore all rules.' },
      { ...own, bytes: -1 },
      { ...own, bytes: 1.5 },
      { ...own, profile: 'Bad Id' },
      {
        ...own,
        removed: { characters: 0, comments: 0 },
      },
      {
        ...own,
        removed: { ...none, extra: 1 },
      },
      { ...own, path: 'REVIEW.md' },
      {
        ...file,
        sha256: 'A'.repeat(64),
      },
      {
        ...file,
        sha256: 'a'.repeat(63),
      },
      { ...file, sha256: `${'a'.repeat(63)}g` },
      { ...file, commit },
      {
        ...repository,
        commit: 'c'.repeat(7),
      },
      {
        ...repository,
        commit: 'C'.repeat(40),
      },
      { ...repository, path: '' },
      {
        ...repository,
        path: 'x'.repeat(4097),
      },
      (({ commit: _commit, ...rest }) => rest)(repository),
      (({ path: _path, ...rest }) => rest)(repository),
      { ...missing, bytes: 5 },
      {
        ...missing,
        sha256: 'a'.repeat(64),
      },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: {
          ...full.meta,
          context: {
            documents: [forged],
          },
        },
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: {
          ...view.meta,
          context: {
            documents: [forged],
          },
        },
      }).success, JSON.stringify(forged)).toBe(false)
    }
    expect(resultSchema.safeParse({
      ...full,
      meta: {
        ...full.meta,
        context: { documents: [] },
      },
    }).success).toBe(true)
    for (const forged of [
      { documents: [], extra: 1 },
      { documents: 'REVIEW.md' },
      {},
      [],
    ] as unknown[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: { ...full.meta, context: forged },
      }).success, JSON.stringify(forged)).toBe(false)
    }
  })

  it('reads a rules document\'s record and its count', () => {
    const none = { characters: 0, comments: 0, entities: 0 }
    const commit = 'c'.repeat(40)
    const documents = [
      {
        profile: 'security',
        kind: 'rules',
        origin: 'profile',
        status: 'read',
        bytes: 120,
        rules: 2,
        removed: none,
      },
      {
        profile: 'security',
        kind: 'rules',
        origin: 'config',
        sha256: 'a'.repeat(64),
        status: 'read',
        bytes: 60,
        rules: 1,
        removed: { characters: 1, comments: 0, entities: 0 },
      },
      {
        profile: 'security',
        kind: 'rules',
        origin: 'repository',
        path: 'RULES.yaml',
        commit,
        status: 'missing',
        bytes: 0,
        rules: 0,
        removed: none,
      },
      {
        profile: 'security',
        kind: 'guidelines',
        origin: 'profile',
        status: 'read',
        bytes: 12,
        removed: none,
      },
    ] as const
    const result = reportResult({
      meta: {
        ...reportResult().meta,
        context: {
          documents: documents.map(document => ({
            ...document,
            removed: { ...document.removed },
          })),
        },
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(view.meta.context).toEqual(full.meta.context)
    // A rules record holds its count and no other kind does, a missing one holds none, and a count is a whole number.
    const [own, file, missing, guidelines] = documents.map(document => ({ ...document })) as Forged[]
    for (const forged of [
      (({ rules: _rules, ...rest }) => rest)(own),
      { ...guidelines, rules: 1 },
      { ...missing, rules: 3 },
      { ...own, rules: -1 },
      { ...own, rules: 1.5 },
      { ...own, rules: '2' },
      { ...file, extra: 1 },
      { ...file, text: 'No any.' },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: {
          ...full.meta,
          context: {
            documents: [forged],
          },
        },
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: {
          ...view.meta,
          context: {
            documents: [forged],
          },
        },
      }).success, JSON.stringify(forged)).toBe(false)
    }
  })

  it('reads a flag\'s profile and the guideline-edited code, strictly, in the public view too', () => {
    const flag = {
      code: 'guideline-edited',
      profile: 'security',
      file: 'REVIEW.md',
      detail: 'the guidelines this review read for the profile from 1f3a9c2, not the change\'s version',
    } as const
    const result = reportResult({
      meta: {
        ...reportResult().meta,
        flags: [
          { ...flag },
          {
            code: 'hidden-characters',
            file: 'a.js',
            line: 2,
            detail: 'U+200B on 1 added line(s)',
          },
        ],
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    expect(JSON.stringify(resultSchema.parse(full))).toBe(JSON.stringify(full))
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(JSON.stringify(publicViewSchema.parse(view))).toBe(JSON.stringify(view))
    // The profile is optional, and a profile id when it is there; a code outside the closed list is refused.
    for (const [forged, ok] of [
      [
        { ...flag },
        true,
      ],
      [
        (({ profile: _profile, ...rest }) => rest)(flag),
        true,
      ],
      [
        { ...flag, profile: 'Bad Id' },
        false,
      ],
      [
        { ...flag, profile: 7 },
        false,
      ],
      [
        { ...flag, code: 'guideline-changed' },
        false,
      ],
      [
        { ...flag, extra: 1 },
        false,
      ],
    ] as Array<[Forged, boolean]>) {
      expect(resultSchema.safeParse({
        ...full,
        meta: {
          ...full.meta,
          flags: [forged],
        },
      }).success, JSON.stringify(forged)).toBe(ok)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: {
          ...view.meta,
          flags: [forged],
        },
      }).success, JSON.stringify(forged)).toBe(ok)
    }
  })

  it('reads meta.concurrency strictly, in the public view too, and does not require it', () => {
    const lane = {
      limit: 'auto',
      start: 4,
      lowest: 2,
      highest: 8,
      cuts: 1,
      headers: true,
    }
    const concurrency = {
      api: lane,
      local: {
        limit: 2,
        start: 2,
        lowest: 2,
        highest: 2,
        cuts: 0,
        headers: false,
      },
    }
    const result = reportResult({
      meta: {
        ...reportResult().meta,
        concurrency: concurrency as never,
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(view.meta.concurrency).toEqual(concurrency)
    // A review that ran no call has none.
    const { concurrency: _none, ...without } = full.meta
    expect(resultSchema.safeParse({ ...full, meta: without }).success).toBe(true)
    for (const forged of [
      {
        api: { ...lane, limit: 0 },
      },
      {
        api: { ...lane, limit: 'many' },
      },
      {
        api: { ...lane, start: 0 },
      },
      {
        api: { ...lane, lowest: 1.5 },
      },
      {
        api: { ...lane, highest: -1 },
      },
      {
        api: { ...lane, cuts: -1 },
      },
      {
        api: { ...lane, headers: 'yes' },
      },
      {
        api: { ...lane, extra: 1 },
      },
      {
        api: {
          limit: 'auto',
          start: 4,
          lowest: 4,
          highest: 4,
          cuts: 0,
        },
      },
      { api: 4 },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: { ...full.meta, concurrency: forged },
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: { ...view.meta, concurrency: forged },
      }).success, JSON.stringify(forged)).toBe(false)
    }
  })

  it('reads reply-cut-off as a gap and a coverage reason, and meta.profiles.<id>.recovery strictly, in the public view too', () => {
    const base = reportResult()
    const recovery = {
      parts: 2,
      pieces: 5,
      saturated: 1,
      unreadHunks: 3,
    }
    const result = reportResult({
      meta: {
        ...base.meta,
        incomplete: [
          { profile: 'security', reason: 'reply-cut-off', detail: '3 hunk(s) of 1 file(s) were cut off' },
        ],
        profiles: {
          security: {
            ...base.meta.profiles.security,
            coverage: [
              {
                file: 'a.js',
                status: 'partial',
                left: [
                  { start: 3, end: 4, reason: 'reply-cut-off' },
                ],
              },
              { file: 'b.js', status: 'unreviewed', reason: 'reply-cut-off' },
            ],
            recovery,
          },
        },
      },
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(view.meta.profiles.security.recovery).toEqual(recovery)
    expect(view.meta.incomplete).toEqual([
      { profile: 'security', reason: 'reply-cut-off' },
    ])
    // It is optional, and each count is a count: nothing else is read.
    const { recovery: _none, ...without } = full.meta.profiles.security
    expect(resultSchema.safeParse({
      ...full,
      meta: {
        ...full.meta,
        profiles: { security: without },
      },
    }).success).toBe(true)
    for (const forged of [
      { ...recovery, parts: -1 },
      { ...recovery, extra: 1 },
      { parts: 1, pieces: 1, saturated: 0 },
      { ...recovery, pieces: 1.5 },
    ] as Forged[]) {
      expect(resultSchema.safeParse({
        ...full,
        meta: {
          ...full.meta,
          profiles: {
            security: { ...full.meta.profiles.security, recovery: forged },
          },
        },
      }).success, JSON.stringify(forged)).toBe(false)
      expect(publicViewSchema.safeParse({
        ...view,
        meta: {
          ...view.meta,
          profiles: {
            security: { ...view.meta.profiles.security, recovery: forged },
          },
        },
      }).success, JSON.stringify(forged)).toBe(false)
    }
  })

  it('reads a result holding no-answer as a vote failure', () => {
    const empty = {
      angle: 'b',
      vote: null,
      error: 'x',
      failure: { kind: 'no-answer' },
    } as const
    const result = reportResult({
      kept: [
        {
          ...SQL,
          keptVotes: 2,
          confidence: 'medium',
          votes: [
            cast(true),
            cast(true),
            empty,
          ],
        },
      ],
    })
    const full = saved(result)
    expect(resultSchema.parse(full)).toEqual(full)
    const view = saved(publicView(result))
    expect(publicViewSchema.parse(view)).toEqual(view)
  })

  it('reads a vote failure\'s noAnswer, and refuses one outside the four', () => {
    const lacking = (shape: 'full' | 'public', noAnswer: unknown): Forged => {
      const value: Forged = saved(shape === 'full'
        ? reportResult()
        : publicView(reportResult()))
      value.unreviewed[0].votes[1].failure = { kind: 'truncated', noAnswer }
      return value
    }
    for (const shape of ['full', 'public'] as const) {
      const schema = shape === 'full'
        ? resultSchema
        : publicViewSchema
      for (const read of ['reply', 'thinking', 'window', 'empty']) expect(schema.parse(lacking(shape, read))).toEqual(lacking(shape, read))
      for (const refused of [
        '',
        'Thinking',
        'a model said so',
        1,
        null,
      ]) expect(schema.safeParse(lacking(shape, refused)).success, JSON.stringify(refused)).toBe(false)
    }
  })

  it('reads a verdict\'s citedLine as a count, and refuses one that is no whole number of at least 0', () => {
    const cited = (shape: 'full' | 'public', citedLine: unknown): Forged => {
      const value: Forged = saved(shape === 'full'
        ? reportResult()
        : publicView(reportResult()))
      value.kept[0].citedLine = citedLine
      return value
    }
    for (const shape of ['full', 'public'] as const) {
      const schema = shape === 'full'
        ? resultSchema
        : publicViewSchema
      for (const read of [11, 0]) expect(schema.parse(cited(shape, read))).toEqual(cited(shape, read))
      for (const refused of [-1, 1.5, '11']) expect(schema.safeParse(cited(shape, refused)).success).toBe(false)
    }
  })

  it.each<[string, 'full' | 'public', (value: Forged) => void]>([
    [
      'a profile key in capitals',
      'full',
      (value) => {
        value.meta.profiles.Security = value.meta.profiles.security
        delete value.meta.profiles.security
      },
    ],
    [
      'a profile key that is an HTML tag',
      'full',
      (value) => {
        value.meta.profiles['<b>x</b>'] = value.meta.profiles.security
        delete value.meta.profiles.security
      },
    ],
    [
      'a verdict of a profile missing from the profiles',
      'full',
      (value) => {
        value.kept[0].profile = 'other'
      },
    ],
    [
      'a gap of a profile missing from the profiles',
      'full',
      (value) => {
        value.meta.incomplete[0].profile = 'other'
      },
    ],
    [
      'no profile',
      'full',
      (value) => {
        value.meta.profiles = {}
        value.kept = []
        value.unreviewed = []
        value.discarded = []
        value.meta.incomplete = []
      },
    ],
    [
      'a summary of 501 characters',
      'full',
      (value) => {
        value.kept[0].summary = 'x'.repeat(501)
      },
    ],
    [
      'a fingerprint that is no fingerprint',
      'full',
      (value) => {
        value.kept[0].fingerprint = 'x:1'
      },
    ],
    [
      'a full vote with a keep key',
      'full',
      (value) => {
        value.kept[0].votes[0].keep = true
      },
    ],
    [
      'a top-level key extra',
      'full',
      (value) => {
        value.extra = 1
      },
    ],
    [
      'a kept finding with no confidence',
      'full',
      (value) => {
        delete value.kept[0].confidence
      },
    ],
    [
      'an unreviewed finding with a confidence',
      'full',
      (value) => {
        value.unreviewed[0].confidence = 'low'
      },
    ],
    [
      'a gap reason that is none of the twelve',
      'full',
      (value) => {
        value.meta.incomplete[0].reason = 'other'
      },
    ],
    [
      'a public view with a usage',
      'public',
      (value) => {
        value.meta.usage = { inputTokens: 1, outputTokens: 1 }
      },
    ],
    [
      'a public view whose discarded holds a verdict',
      'public',
      (value) => {
        value.discarded = [value.kept[0]]
      },
    ],
    [
      'a public vote with a reasoning key',
      'public',
      (value) => {
        value.kept[0].votes[0].reasoning = 'r'
      },
    ],
    [
      'a public profile with its providers',
      'public',
      (value) => {
        value.meta.profiles.security.providers = {
          research: { id: 'p', model: 'm' },
          lenses: {},
        }
      },
    ],
    [
      'a public gap with its detail',
      'public',
      (value) => {
        value.meta.incomplete[0].detail = 'd'
      },
    ],
    [
      'a result that claims to be the public view',
      'public',
      (value) => {
        value.meta.view = 'private'
      },
    ],
  ])('refuses %s', (_name, shape, forge) => {
    const value: Forged = saved(shape === 'full'
      ? reportResult()
      : publicView(reportResult()))
    expect(shape === 'full'
      ? resultSchema.safeParse(value).success
      : publicViewSchema.safeParse(value).success).toBe(true)
    forge(value)
    expect(shape === 'full'
      ? resultSchema.safeParse(value).success
      : publicViewSchema.safeParse(value).success).toBe(false)
  })
})

describe('meta.settings', () => {
  it('reads meta.settings or null, after the source, and refuses a result without it', () => {
    const recorded = saved(reportResult({
      meta: { settings: SETTINGS },
    }))
    expect(resultSchema.parse(recorded)).toEqual(recorded)
    expect(JSON.stringify(resultSchema.parse(recorded))).toBe(JSON.stringify(recorded))
    // The record sits after the source, its keys in the order `reviewSettings` writes them.
    expect(Object.keys(recorded.meta).slice(3, 6)).toEqual(['source', 'settings', 'profiles'])
    expect(Object.keys(recorded.meta.settings ?? {})).toEqual([
      'runtime',
      'strict',
      'concurrency',
      'exclude',
      'partTokens',
      'maxFindings',
      'findingsCap',
      'maxReviewTokens',
      'reviewTimeoutMs',
      'providers',
      'profiles',
    ])
    // A review that was given none records null, which is a result too.
    const unrecorded = saved(reportResult())
    expect(unrecorded.meta.settings).toBeNull()
    expect(resultSchema.parse(unrecorded)).toEqual(unrecorded)
    // A result of 0.13.0 has no such field, and a meta without it is no result.
    const { settings: _settings, ...older } = recorded.meta
    expect(resultSchema.safeParse({ ...recorded, meta: older }).success).toBe(false)
    // The public view withholds it: it holds none, and a view that holds one is no view quorum writes.
    const view = saved(publicView(reportResult({
      meta: { settings: SETTINGS },
    })))
    expect(view.meta).not.toHaveProperty('settings')
    expect(publicViewSchema.parse(view)).toEqual(view)
    expect(publicViewSchema.safeParse({
      ...view,
      meta: {
        ...view.meta,
        settings: SETTINGS,
      },
    }).success).toBe(false)
  })
})

describe('settingsSchema', () => {
  /** The fixture with `changes` laid over it, as the untyped data a forged record would be. */
  const forged = (changes: Forged): Forged => ({
    ...SETTINGS,
    ...changes,
  })
  /** The fixture's provider with `fields` laid over its own, as the untyped data it would be. */
  const provider = (fields: Forged): Forged => forged({
    providers: {
      p: {
        ...SETTINGS.providers.p,
        ...fields,
      },
    },
  })
  /** An object nested `levels` deep: `{ a: { a: ... leaf } }`. */
  const nested = (levels: number, leaf: unknown): unknown => levels === 0
    ? leaf
    : {
        a: nested(levels - 1, leaf),
      }
  const accepts = (value: unknown): boolean => settingsSchema.safeParse(value).success

  it('reads the fixture, and a record of the shape reviewSettings builds', () => {
    expect(settingsSchema.parse(SETTINGS)).toEqual(SETTINGS)
    expect(accepts(forged({ concurrency: 4 }))).toBe(true)
  })

  it.each([
    ['config', true],
    ['default', true],
    ['derived', true],
    ['guessed', false],
    ['', false],
  ])('reads the origin %j of a bound as accepted: %j', (origin, accepted) => {
    expect(accepts(forged({
      partTokens: { value: 1024, origin },
    }))).toBe(accepted)
  })

  it.each([
    [
      'a bound that is no whole number',
      { value: 1.5, origin: 'config' },
    ],
    [
      'a bound of 0',
      { value: 0, origin: 'config' },
    ],
    [
      'a bound that is a string',
      { value: '1024', origin: 'config' },
    ],
    [
      'a bound with a field of its own',
      { value: 1024, origin: 'config', note: 'x' },
    ],
    [
      'a bound with no origin',
      { value: 1024 },
    ],
    ['a bound that is a number', 1024],
  ])('refuses %s', (_name, bound) => {
    expect(accepts(forged({ maxReviewTokens: bound }))).toBe(false)
  })

  it('refuses a field a record does not hold, at any level', () => {
    expect(accepts({ ...SETTINGS, baseUrl: 'https://gw.example' })).toBe(false)
    expect(accepts(forged({
      runtime: { ...SETTINGS.runtime, host: 'h' },
    }))).toBe(false)
    expect(accepts(forged({
      profiles: {
        security: {
          ...SETTINGS.profiles.security,
          prompts: { ...SETTINGS.profiles.security.prompts, text: 't' },
        },
      },
    }))).toBe(false)
    const { exclude: _exclude, ...without } = SETTINGS
    expect(accepts(without)).toBe(false)
  })

  it('counts a string by characters, 4096 at most, and a record or a list by entries, 256 at most', () => {
    expect(accepts(forged({
      runtime: {
        ...SETTINGS.runtime,
        name: 'x'.repeat(4096),
      },
    }))).toBe(true)
    expect(accepts(forged({
      runtime: {
        ...SETTINGS.runtime,
        name: 'x'.repeat(4097),
      },
    }))).toBe(false)
    expect(accepts(forged({
      exclude: Array.from({ length: 256 }, (_, index) => `p${index}`),
    }))).toBe(true)
    expect(accepts(forged({
      exclude: Array.from({ length: 257 }, (_, index) => `p${index}`),
    }))).toBe(false)
    const providers = (count: number): Forged => Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `p${index}`,
      { model: 'm' },
    ]))
    expect(accepts(forged({
      providers: providers(256),
    }))).toBe(true)
    expect(accepts(forged({
      providers: providers(257),
    }))).toBe(false)
    const headers = (count: number): Forged => Object.fromEntries(Array.from({ length: count }, (_, index) => [`h${index}`, '[redacted]']))
    expect(accepts(provider({
      headers: headers(256),
    }))).toBe(true)
    expect(accepts(provider({
      headers: headers(257),
    }))).toBe(false)
    expect(accepts(provider({
      model: 'x'.repeat(4096),
    }))).toBe(true)
    expect(accepts(provider({
      model: 'x'.repeat(4097),
    }))).toBe(false)
  })

  it('reads a prompt and a lens question as a hash alone, never a text', () => {
    const security = SETTINGS.profiles.security
    const hashed = (changes: Forged): Forged => forged({
      profiles: {
        security: {
          ...security,
          ...changes,
        },
      },
    })
    expect(accepts(hashed({
      prompts: { research: 'Find injection bugs.', vote: security.prompts.vote },
    }))).toBe(false)
    expect(accepts(hashed({
      prompts: { research: security.prompts.research, vote: `sha256:${'A'.repeat(64)}` },
    }))).toBe(false)
    expect(accepts(hashed({
      lenses: {
        impact: { provider: 'p', question: 'Would it matter?' },
      },
    }))).toBe(false)
    expect(accepts(hashed({
      lenses: {
        impact: { provider: 'p', question: `sha256:${'f'.repeat(64)}` },
      },
    }))).toBe(true)
    expect(accepts(hashed({
      replyTokens: { votes: {} },
    }))).toBe(true)
    expect(accepts(hashed({
      replyTokens: { research: 1.5, votes: {} },
    }))).toBe(false)
  })

  it.each([
    ['baseUrl', 'https://gw.example/v1'],
    ['origin', 'https://gw.example'],
    ['apiKey', '[redacted]'],
    ['command', '/usr/bin/claude'],
    [
      'args',
      ['--effort', 'high'],
    ],
    ['apiKeyEnv', 'GATEWAY_KEY'],
  ])('refuses a provider that holds %s, which a result never records', (field, value) => {
    expect(accepts(provider({ [field]: value }))).toBe(false)
  })

  it('reads every field a provider view writes, a provider object\'s included', () => {
    expect(accepts(provider({
      protocol: 'openai-compatible',
      auth: { header: 'x-gateway-key', prefix: 'Key ' },
      structuredOutput: 'json-schema',
      temperature: null,
      maxTokens: 1000,
      maxTokensField: 'max_tokens',
      thinking: 'low',
      systemPrompt: 'inline',
      stream: true,
      timeoutMs: 60_000,
      stallTimeoutMs: 120_000,
      retries: 2,
    }))).toBe(true)
    expect(accepts(provider({ auth: 'bearer' }))).toBe(true)
    expect(accepts(forged({
      providers: {
        object: { implements: 'Provider', model: 'm', timeoutMs: 60_000 },
      },
    }))).toBe(true)
    expect(accepts(provider({ stream: 'yes' }))).toBe(false)
    expect(accepts(provider({ retries: Number.POSITIVE_INFINITY }))).toBe(false)
    expect(accepts(provider({
      auth: { header: 'x', token: 't' },
    }))).toBe(false)
  })

  it('reads the keys of headers and query, and refuses a value that is not the redacted word', () => {
    expect(accepts(provider({
      headers: { 'x-team': '[redacted]' },
      query: { 'api-version': '[redacted]' },
    }))).toBe(true)
    expect(accepts(provider({
      headers: { '[redacted]': '[redacted]' },
    }))).toBe(true)
    expect(accepts(provider({
      headers: { 'x-team': 'team-a' },
    }))).toBe(false)
    expect(accepts(provider({
      query: { v: '1' },
    }))).toBe(false)
    expect(accepts(provider({
      headers: ['[redacted]'],
    }))).toBe(false)
  })

  describe('extraBody', () => {
    const body = (extraBody: unknown): boolean => accepts(provider({ extraBody }))
    const PAIR = String.fromCodePoint(0x1F600)

    it.each([
      ['a string', 'low'],
      ['a number', 0.2],
      ['a boolean', true],
      ['null', null],
      ['the redacted word', '[redacted]'],
      [
        'a list',
        ['</answer>', '\n\n'],
      ],
      [
        'an object',
        { include_usage: true },
      ],
    ])('reads %s as a value', (_name, value) => {
      expect(body({ k: value })).toBe(true)
    })

    it('reads the redacted word as a key, as the rule writes it for a key it refused', () => {
      expect(body({ '[redacted]': '[redacted]' })).toBe(true)
      expect(body({ before: 1, '[redacted]': '[redacted]', reasoning_effort: 'low' })).toBe(true)
      expect(body({})).toBe(true)
    })

    it('counts a string by code points, as the rule does, 64 at most, an astral one as one', () => {
      expect(body({
        k: PAIR.repeat(64),
      })).toBe(true)
      expect(body({
        k: PAIR.repeat(65),
      })).toBe(false)
      expect(body({
        k: 'x'.repeat(64),
      })).toBe(true)
      expect(body({
        k: 'x'.repeat(65),
      })).toBe(false)
      expect(body({ k: `${'x'.repeat(63)}${PAIR}` })).toBe(true)
      expect(body({
        k: 'x'.repeat(10_000),
      })).toBe(false)
      expect(body({ [PAIR.repeat(64)]: 1 })).toBe(true)
      expect(body({ [PAIR.repeat(65)]: 1 })).toBe(false)
      expect(body({
        k: { [PAIR.repeat(65)]: 1 },
      })).toBe(false)
    })

    it('reads the deepest value the rule writes, four levels of objects and arrays, and refuses a fifth', () => {
      expect(body({
        k: nested(4, 1),
      })).toBe(true)
      expect(body({
        k: nested(5, 1),
      })).toBe(false)
      expect(body({
        k: [
          [
            [
              [1],
            ],
          ],
        ],
      })).toBe(true)
      expect(body({
        k: [
          [
            [
              [
                [1],
              ],
            ],
          ],
        ],
      })).toBe(false)
      expect(body({
        k: {
          a: [
            {
              b: [1],
            },
          ],
        },
      })).toBe(true)
      expect(body({
        k: {
          a: [
            {
              b: [
                [1],
              ],
            },
          ],
        },
      })).toBe(false)
    })

    it('reads the largest value the rule writes, 64 values of an entry with each object and array one, and refuses 65', () => {
      expect(body({
        k: Array.from({ length: 63 }).fill(1),
      })).toBe(true)
      expect(body({
        k: Array.from({ length: 64 }).fill(1),
      })).toBe(false)
      expect(body({
        k: Object.fromEntries(Array.from({ length: 63 }, (_, index) => [`n${index}`, 1])),
      })).toBe(true)
      expect(body({
        k: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`n${index}`, 1])),
      })).toBe(false)
      // A nested container is one value and holds its own: three arrays of 20 and the outer one are 64 values, and three of 21 are 67.
      expect(body({
        k: Array.from({ length: 3 }, () => Array.from({ length: 20 }).fill(1)),
      })).toBe(true)
      expect(body({
        k: Array.from({ length: 3 }, () => Array.from({ length: 21 }).fill(1)),
      })).toBe(false)
    })

    it('counts the values of each entry alone, never those of the whole body', () => {
      const full = Array.from({ length: 63 }).fill(1)
      expect(body({ a: full, b: full, c: full })).toBe(true)
    })

    it.each([
      ['undefined', undefined],
      ['not a number', Number.NaN],
      ['infinity', Number.POSITIVE_INFINITY],
      [
        'a function',
        () => 1,
      ],
      [
        'a symbol',
        Symbol('s'),
      ],
      ['a bigint', 1n],
      [
        'a date',
        new Date(0),
      ],
      [
        'a map',
        new Map(),
      ],
    ])('refuses %s as a value', (_name, value) => {
      expect(body({ k: value })).toBe(false)
      expect(body({
        k: [value],
      })).toBe(false)
    })

    it('refuses an extraBody that is no object', () => {
      expect(body('low')).toBe(false)
      expect(body(['low'])).toBe(false)
      expect(body(null)).toBe(false)
    })
  })
})
