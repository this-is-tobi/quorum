import { describe, expect, it } from 'vitest'
import { inertJson } from '../core/sanitize.ts'
import type { LensVote, PublicView, QuorumResult, Verdict } from '../core/types.ts'
import { blankResult, RANGE, reportMeta, reportResult, SQL, TOKEN, UPLOAD } from '../testing/report.ts'
import { discardedOf, isPublicView, publicView, voteFailed } from './view.ts'

const CANARIES = [
  'REASONING-CANARY',
  'ERROR-CANARY',
  'MODEL-CANARY',
  'DETAIL-CANARY',
]

function cast(keep: boolean): LensVote {
  return {
    angle: 'a',
    vote: { keep, reasoning: 'REASONING-CANARY' },
    error: null,
    failure: null,
  }
}
const failed: LensVote = {
  angle: 'b',
  vote: null,
  error: 'ERROR-CANARY',
  failure: { kind: 'network' },
}

/** `reportResult()` with every text the view withholds replaced by a canary. */
function canaried(): QuorumResult {
  const base = reportMeta()
  return reportResult({
    kept: [
      {
        ...SQL,
        votes: [
          cast(true),
          cast(true),
          cast(true),
        ],
      },
    ],
    unreviewed: [
      {
        ...TOKEN,
        votes: [
          cast(true),
          failed,
          cast(false),
        ],
      },
    ],
    meta: {
      profiles: {
        security: {
          ...base.profiles.security,
          providers: {
            research: { id: 'p', model: 'MODEL-CANARY' },
            lenses: {
              a: { id: 'p', model: 'MODEL-CANARY' },
            },
          },
        },
      },
      incomplete: [
        { profile: 'security', reason: 'binary', detail: 'DETAIL-CANARY' },
      ],
    },
  })
}

/** The votes a public verdict of `canaried()` holds. */
const PUBLIC_VOTES = {
  kept: [
    { angle: 'a', keep: true, failure: null },
    { angle: 'a', keep: true, failure: null },
    { angle: 'a', keep: true, failure: null },
  ],
  unreviewed: [
    { angle: 'a', keep: true, failure: null },
    {
      angle: 'b',
      keep: null,
      failure: { kind: 'network' },
    },
    { angle: 'a', keep: false, failure: null },
  ],
}

describe('publicView', () => {
  it('withholds every vote\'s reasoning and error, the discarded findings, the providers and models, the usage and each gap\'s detail', () => {
    const result = canaried()
    const view = publicView(result)
    const written = inertJson(view)
    for (const canary of CANARIES) expect(written).not.toContain(canary)
    expect(written).not.toContain(JSON.stringify(UPLOAD.id))
    expect(written).not.toContain('"usage"')
    expect(written).not.toContain('"providers"')

    const { providers: _providers, ...security } = reportMeta().profiles.security
    const expected = {
      kept: [
        { ...SQL, votes: PUBLIC_VOTES.kept },
      ],
      discarded: [],
      unreviewed: [
        { ...TOKEN, votes: PUBLIC_VOTES.unreviewed },
      ],
      meta: {
        version: '0.6.0',
        view: 'public',
        startedAt: '2026-11-16T00:00:00.000Z',
        durationMs: 41_000,
        source: RANGE,
        profiles: {
          security: {
            policy: security.policy,
            failOn: 'high',
            gating: true,
            discarded: 1,
            invalidFindings: 0,
            rules: { listed: 0, sent: 0 },
            invalidRules: 0,
            coverage: security.coverage,
          },
        },
        incomplete: [
          { profile: 'security', reason: 'binary' },
        ],
        leftOut: reportMeta().leftOut,
        flags: reportMeta().flags,
        context: { documents: [] },
        adaptations: [],
      },
    }
    expect(view).toStrictEqual(expected)
    expect(written).toBe(inertJson(expected))
    expect(Object.keys(view.meta)).toEqual([
      'version',
      'view',
      'startedAt',
      'durationMs',
      'source',
      'profiles',
      'incomplete',
      'leftOut',
      'flags',
      'context',
      'adaptations',
    ])
    expect(Object.keys(view.meta.profiles.security)).toEqual([
      'policy',
      'failOn',
      'gating',
      'discarded',
      'invalidFindings',
      'rules',
      'invalidRules',
      'coverage',
    ])
    expect(Object.keys(view.kept[0])).toEqual(Object.keys(SQL))
  })

  it('withholds each profile\'s research counts from the public view', () => {
    const base = reportMeta()
    const research = {
      parts: 226,
      listed: 429,
      panel: 226,
      capped: 203,
      saturated: 7,
    }
    const result = reportResult({
      meta: {
        ...base,
        profiles: {
          security: { ...base.profiles.security, research },
        },
      },
    })
    const view = publicView(result)
    expect(view.meta.profiles.security).not.toHaveProperty('research')
    expect(inertJson(view)).not.toContain('research')
    // The view is the one a result with other counts makes, and the result's own are left as they were.
    expect(view).toStrictEqual(publicView(reportResult()))
    expect(result.meta.profiles.security.research).toEqual(research)
    // A view that holds them is no view quorum writes.
    expect(() => publicView({
      ...view,
      meta: {
        ...view.meta,
        profiles: {
          security: { ...view.meta.profiles.security, research },
        },
      },
    } as unknown as PublicView)).toThrow('the public view is not one quorum writes, at meta.profiles.security')
  })

  it('withholds meta.calls from the public view', () => {
    const calls = {
      p: {
        model: 'm',
        served: [
          { model: 'SERVED-CANARY-A', calls: 3 },
          { model: 'SERVED-CANARY-B', calls: 2 },
        ],
        servedOthers: 1,
      },
    }
    const result = reportResult({
      meta: { calls },
    })
    const view = publicView(result)
    expect(view.meta).not.toHaveProperty('calls')
    expect(inertJson(view)).not.toContain('SERVED-CANARY')
    // The view is the one a result with other calls makes, and the result's own are left as they were.
    expect(view).toStrictEqual(publicView(reportResult()))
    expect(result.meta.calls).toEqual(calls)
    // A view that holds them is no view quorum writes.
    expect(() => publicView({
      ...view,
      meta: {
        ...view.meta,
        calls,
      },
    } as unknown as PublicView)).toThrow('the public view is not one quorum writes, at meta')
  })

  it('keeps meta.profiles.<id>.recovery in the public view, as a copy, and leaves it out of a profile that has none', () => {
    const recovery = {
      parts: 2,
      pieces: 5,
      saturated: 1,
      unreadHunks: 3,
    }
    const base = reportMeta()
    const result = reportResult({
      meta: {
        ...base,
        profiles: {
          security: { ...base.profiles.security, recovery },
        },
      },
    })
    const view = publicView(result)
    expect(view.meta.profiles.security.recovery).toEqual(recovery)
    expect(view.meta.profiles.security.recovery).not.toBe(recovery)
    expect(Object.keys(view.meta.profiles.security)).toEqual([
      'policy',
      'failOn',
      'gating',
      'discarded',
      'invalidFindings',
      'rules',
      'invalidRules',
      'coverage',
      'recovery',
    ])
    expect(publicView(reportResult()).meta.profiles.security).not.toHaveProperty('recovery')
  })

  it('keeps meta.profiles.<id>.asksNothing in the public view, and leaves it out of a profile that has none, so such a view is unchanged', () => {
    const base = reportMeta()
    const asked = reportResult({
      meta: {
        ...base,
        profiles: {
          security: {
            ...base.profiles.security,
            asksNothing: true,
          },
        },
      },
    })
    const view = publicView(asked)
    expect(view.meta.profiles.security.asksNothing).toBe(true)
    expect(Object.keys(view.meta.profiles.security)).toEqual([
      'policy',
      'failOn',
      'gating',
      'discarded',
      'invalidFindings',
      'rules',
      'invalidRules',
      'asksNothing',
      'coverage',
    ])
    expect(publicView(view)).toBe(view)
    expect(inertJson(view)).toContain('"asksNothing": true')
    expect(publicView(reportResult()).meta.profiles.security).not.toHaveProperty('asksNothing')
    expect(inertJson(publicView(reportResult()))).not.toContain('asksNothing')
    // A flag that is no `true` is no view quorum writes.
    expect(() => publicView({
      ...asked,
      meta: {
        ...asked.meta,
        profiles: {
          security: { ...asked.meta.profiles.security, asksNothing: false as never },
        },
      },
    })).toThrow('the public view is not one quorum writes, at meta.profiles.security.asksNothing')
  })

  it('keeps a finding\'s rule and a profile\'s rule counts in the public view', () => {
    const base = reportMeta()
    const cited: Verdict = {
      ...SQL,
      rule: 'no-any',
    }
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
    const view = publicView(result)
    expect(view.kept[0].rule).toBe('no-any')
    expect(view.kept[0]).toEqual({ ...cited, votes: PUBLIC_VOTES.kept })
    // A finding that cites none holds no rule, as the result's does.
    expect(view.unreviewed[0]).not.toHaveProperty('rule')
    expect(view.meta.profiles.security.rules).toEqual({ listed: 3, sent: 2 })
    expect(view.meta.profiles.security.invalidRules).toBe(1)
    // The counts are copies, and the result's own are left as they were.
    expect(view.meta.profiles.security.rules).not.toBe(result.meta.profiles.security.rules)
    expect(result.meta.profiles.security.rules).toEqual({ listed: 3, sent: 2 })
    // A view is the same whatever it is made of, and every one passes the strict schema.
    expect(publicView(view)).toBe(view)
    expect(inertJson(view)).toContain('"rule": "no-any"')
    // A rule that is no id is no view quorum writes: a reporter writes a rule's id bare.
    expect(() => publicView({
      ...result,
      kept: [
        { ...cited, rule: 'No Any: [x](y)' },
      ],
    })).toThrow('the public view is not one quorum writes, at kept.0.rule')
  })

  it('keeps meta.adaptations in the public view, as a copy', () => {
    const adaptations = [
      {
        provider: 'api',
        setting: 'thinking',
        from: 'default',
        to: 'low',
        cause: 'no-answer-thinking',
      },
      {
        provider: 'api',
        setting: 'structuredOutput',
        from: 'json',
        to: 'prompt',
        cause: 'empty-reply',
      },
    ] as const
    const result = reportResult({
      meta: {
        ...reportMeta(),
        adaptations: [...adaptations],
      },
    })
    const view = publicView(result)
    expect(view.meta.adaptations).toEqual(adaptations)
    expect(view.meta.adaptations).not.toBe(result.meta.adaptations)
    expect(view.meta.adaptations[0]).not.toBe(result.meta.adaptations[0])
  })

  it('keeps meta.context in the public view, as a copy', () => {
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
        origin: 'repository',
        path: 'REVIEW.md',
        commit: 'c'.repeat(40),
        sha256: 'a'.repeat(64),
        status: 'read',
        bytes: 40,
        removed: { characters: 0, comments: 1, entities: 2 },
      },
    ] as const
    const result = reportResult({
      meta: {
        ...reportMeta(),
        context: {
          documents: documents.map(document => ({
            ...document,
            removed: { ...document.removed },
          })),
        },
      },
    })
    const view = publicView(result)
    expect(view.meta.context).toEqual({ documents })
    expect(view.meta.context).not.toBe(result.meta.context)
    expect(view.meta.context.documents[1]).not.toBe(result.meta.context.documents[1])
    expect(view.meta.context.documents[1].removed).not.toBe(result.meta.context.documents[1].removed)
    // A record that is no record quorum writes is no view.
    expect(() => publicView(reportResult({
      meta: {
        ...reportMeta(),
        context: {
          documents: [
            { ...documents[0], kind: 'rules' } as never,
          ],
        },
      },
    }))).toThrow('the public view is not one quorum writes, at meta.context.documents.0')
  })

  it('keeps a moved finding\'s citedLine in the public view', () => {
    const moved = publicView(reportResult({
      kept: [
        { ...SQL, citedLine: 11 },
      ],
      unreviewed: [TOKEN],
    }))
    expect(moved.kept[0].citedLine).toBe(11)
    expect(Object.hasOwn(moved.unreviewed[0], 'citedLine')).toBe(false)
  })

  it('keeps a vote\'s lens, its keep, null when it failed, and its failure', () => {
    const votes: LensVote[] = [
      cast(true),
      cast(false),
      failed,
      {
        angle: 'c',
        vote: null,
        error: 'ERROR-CANARY',
        failure: { kind: 'http', status: 503 },
      },
    ]
    const view = publicView(reportResult({
      kept: [
        { ...SQL, votes },
      ],
    }))
    expect(view.kept[0].votes).toStrictEqual([
      { angle: 'a', keep: true, failure: null },
      { angle: 'a', keep: false, failure: null },
      {
        angle: 'b',
        keep: null,
        failure: { kind: 'network' },
      },
      {
        angle: 'c',
        keep: null,
        failure: { kind: 'http', status: 503 },
      },
    ])
    expect(votes.map(voteFailed)).toEqual([false, false, true, true])
    expect(view.kept[0].votes.map(voteFailed)).toEqual([false, false, true, true])
  })

  it('counts each profile\'s discarded findings in meta.profiles.<id>.discarded', () => {
    const { security } = reportMeta().profiles
    const result = reportResult({
      meta: {
        profiles: { security, style: security },
      },
    })
    const view = publicView(result)
    expect(view.discarded).toEqual([])
    expect(view.meta.profiles.security.discarded).toBe(1)
    expect(view.meta.profiles.style.discarded).toBe(0)
    expect(discardedOf(result, 'security')).toBe(1)
    expect(discardedOf(result, 'style')).toBe(0)
    expect(discardedOf(view, 'security')).toBe(1)
    expect(discardedOf(view, 'style')).toBe(0)
    expect(discardedOf(view, 'absent')).toBe(0)
    const two: Verdict[] = [
      UPLOAD,
      { ...UPLOAD, id: 'i4', profile: 'style' },
      { ...UPLOAD, id: 'i5', profile: 'style' },
    ]
    expect(publicView(reportResult({
      discarded: two,
      meta: {
        profiles: { security, style: security },
      },
    })).meta.profiles).toMatchObject({
      security: { discarded: 1 },
      style: { discarded: 2 },
    })
  })

  it('keeps the files left out, a held file\'s reason and rule, and the flags with their details', () => {
    const held = 'named as a secret, so no model was sent any of it: check that it belongs in the change'
    const result = blankResult({
      leftOut: [
        { file: '.env', reason: 'secret', rule: 'name' },
        { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
        { file: 'keys/deploy', reason: 'skipped', rule: 'secret' },
      ],
      incomplete: [
        {
          profile: 'security',
          reason: 'secret',
          file: '.env',
          detail: 'DETAIL-CANARY',
        },
        { profile: 'security', reason: 'vote-failed', detail: 'DETAIL-CANARY' },
      ],
      flags: [
        { code: 'secret-file', file: '.env', detail: held },
        {
          code: 'hidden-characters',
          file: 'a.js',
          line: 3,
          detail: 'U+202E on 1 added line(s)',
        },
      ],
    })
    const view = publicView(result)
    expect(view.meta.leftOut).toStrictEqual(result.meta.leftOut)
    expect(view.meta.flags).toStrictEqual(result.meta.flags)
    expect(view.meta.incomplete).toStrictEqual([
      { profile: 'security', reason: 'secret', file: '.env' },
      { profile: 'security', reason: 'vote-failed' },
    ])
    expect(Object.keys(view.meta.incomplete[0])).toEqual(['profile', 'reason', 'file'])
    expect(inertJson(view)).not.toContain('DETAIL-CANARY')
  })

  it('returns a public view as it is, and leaves the result it is given unchanged', () => {
    const result = canaried()
    const before = structuredClone(result)
    const view = publicView(result)
    expect(result).toStrictEqual(before)
    expect(publicView(view)).toBe(view)
    expect(isPublicView(view)).toBe(true)
    expect(isPublicView(result)).toBe(false)

    expect(view.kept[0]).not.toBe(result.kept[0])
    expect(view.kept[0].votes).not.toBe(result.kept[0].votes)
    expect(view.meta.source).not.toBe(result.meta.source)
    expect(view.meta.leftOut).not.toBe(result.meta.leftOut)
    expect(view.meta.flags).not.toBe(result.meta.flags)
    expect(view.meta.profiles.security.coverage).not.toBe(result.meta.profiles.security.coverage)
    expect(view.meta.profiles.security.policy).not.toBe(result.meta.profiles.security.policy)
    expect(view.meta.incomplete[0]).not.toBe(result.meta.incomplete[0])
    expect(view.unreviewed[0].votes[1].failure).not.toBe(failed.failure)
  })
})

describe('publicView of an object that is not one quorum writes', () => {
  const MARKDOWN = '@octocat [x](https://e.example) <img src=x>'

  /** A public view that passes the schema, as a mutable copy. */
  function view(): Record<string, any> {
    return structuredClone(publicView(canaried())) as unknown as Record<string, any>
  }

  /** The same fields forged in a full result, which `publicView` reduces before it checks. */
  function full(): Record<string, any> {
    return canaried() as unknown as Record<string, any>
  }

  it.each<[string, (view: Record<string, any>) => void, string]>([
    [
      'a vote that keeps its reasoning, under a forged meta.view',
      (input) => { input.kept[0].votes[0] = cast(true) },
      'kept.0.votes.0',
    ],
    [
      'a profile id that holds Markdown',
      (input) => { input.meta.profiles[MARKDOWN] = input.meta.profiles.security },
      'meta.profiles',
    ],
    [
      'a verdict\'s profile that holds Markdown',
      (input) => { input.kept[0].profile = MARKDOWN },
      'kept.0.profile',
    ],
    [
      'a fingerprint that holds a comment\'s end',
      (input) => { input.kept[0].fingerprint = '--> <img src=x> <!--' },
      'kept.0.fingerprint',
    ],
    [
      'a gap\'s reason outside the closed list',
      (input) => { input.meta.incomplete[0].reason = MARKDOWN },
      'meta.incomplete.0.reason',
    ],
    [
      'a gap\'s profile that holds Markdown',
      (input) => { input.meta.incomplete[0].profile = MARKDOWN },
      'meta.incomplete.0.profile',
    ],
    [
      'a left-out file\'s reason outside the closed list',
      (input) => { input.meta.leftOut[0].reason = MARKDOWN },
      'meta.leftOut.0',
    ],
    [
      'a left-out file\'s rule outside the closed list',
      (input) => {
        input.meta.leftOut = [
          { file: 'a', reason: 'skipped', rule: MARKDOWN },
        ]
      },
      'meta.leftOut.0.rule',
    ],
    [
      'a flag\'s code outside the closed list',
      (input) => { input.meta.flags[0].code = MARKDOWN },
      'meta.flags.0.code',
    ],
  ])('refuses %s, naming the path and no value', (_name, forge, path) => {
    const forged = view()
    forge(forged)
    expect(() => publicView(forged as unknown as PublicView)).toThrow(TypeError)
    expect(() => publicView(forged as unknown as PublicView)).toThrow(new RegExp(`^the public view is not one quorum writes, at ${path.replaceAll('.', '\\.')}`))
    for (const text of [
      MARKDOWN,
      '@octocat',
      'REASONING-CANARY',
      '-->',
    ]) {
      expect(() => publicView(forged as unknown as PublicView)).not.toThrow(new RegExp(text.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')))
    }
  })

  it.each([
    [
      'a profile id that holds Markdown',
      (input: Record<string, any>) => { input.meta.profiles[MARKDOWN] = input.meta.profiles.security },
    ],
    [
      'a fingerprint that holds a comment\'s end',
      (input: Record<string, any>) => { input.kept[0].fingerprint = '--> <img src=x> <!--' },
    ],
    [
      'a gap\'s reason outside the closed list',
      (input: Record<string, any>) => { input.meta.incomplete[0].reason = MARKDOWN },
    ],
    [
      'a left-out file\'s rule outside the closed list',
      (input: Record<string, any>) => {
        input.meta.leftOut = [
          { file: 'a', reason: 'skipped', rule: MARKDOWN },
        ]
      },
    ],
    [
      'a flag\'s code outside the closed list',
      (input: Record<string, any>) => { input.meta.flags[0].code = MARKDOWN },
    ],
  ])('refuses a full result with %s, which the view would otherwise carry', (_name, forge) => {
    const forged = full()
    forge(forged)
    expect(() => publicView(forged as unknown as QuorumResult)).toThrow(TypeError)
    expect(() => publicView(forged as unknown as QuorumResult)).not.toThrow(/octocat/)
  })

  it('passes every view quorum writes, and returns a view it was given', () => {
    for (const result of [
      reportResult(),
      canaried(),
      blankResult(),
    ]) {
      const made = publicView(result)
      expect(publicView(made)).toBe(made)
    }
  })
})
