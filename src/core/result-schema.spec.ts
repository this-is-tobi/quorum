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
