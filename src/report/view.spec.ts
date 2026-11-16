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
            coverage: security.coverage,
          },
        },
        incomplete: [
          { profile: 'security', reason: 'binary' },
        ],
        leftOut: reportMeta().leftOut,
        flags: reportMeta().flags,
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
    ])
    expect(Object.keys(view.meta.profiles.security)).toEqual([
      'policy',
      'failOn',
      'gating',
      'discarded',
      'invalidFindings',
      'coverage',
    ])
    expect(Object.keys(view.kept[0])).toEqual(Object.keys(SQL))
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
