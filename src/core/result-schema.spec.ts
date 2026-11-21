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
