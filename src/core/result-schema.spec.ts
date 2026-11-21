import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import { publicView } from '../report/view.ts'
import { corpusResult } from '../testing/github-corpus.ts'
import { blankResult, cast, reportResult, SQL, TOKEN } from '../testing/report.ts'
import { publicViewSchema, resultSchema } from './result-schema.ts'
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
