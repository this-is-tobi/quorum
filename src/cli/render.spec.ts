import { describe, expect, it } from 'vitest'
import type { ProfileBudgets } from '../core/budgets.ts'
import type { Provider } from '../core/ports.ts'
import type { Estimate } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { bannerLines, boundWarnings, estimateLines, EXACT_WORDS, findingsCapOf, PATH_FINDINGS_PER_PART, PERSON_WORDS, profileProviders, viewFacts } from './render.ts'
import type { Bounds } from './render.ts'

/** A right-to-left override, which the sanitizer writes as text. */
const RLO = String.fromCharCode(0x202E)

describe('estimateLines', () => {
  const estimate: Estimate = {
    profiles: {
      security: {
        parts: [30_000, 20_000],
        votes: 150,
        candidates: 0,
        vote: { reachability: 4000, impact: 4000, defenses: 4000 },
        expected: 16_667,
        worst: 1_850_000,
        findings: 50,
        maxFindings: 50,
        provider: 'api',
        documents: { research: 0, vote: 0 },
      },
    },
    expected: 16_667,
    worst: 1_850_000,
    inFlight: 50_000,
    maxFindings: 50,
    findingsCap: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
    held: 2,
  }
  const bounds: Bounds = { cap: 'config', deadline: 'config', findings: 'maxFindings' }
  const cost = 'estimate: research about 16.6k tokens expected, at most 1.85M with every vote and every part recovered, 50.0k of them reserved at once'
  const limits = 'bounds: the token cap 2.00M (maxReviewTokens); the deadline 30m00s (reviewTimeoutMs); the finding cap 50 (maxFindings)'
  /** The same two lines when two profiles run: the cost counts them both, and the finding cap holds for each. */
  const costOfTwo = cost.replace('estimate: ', 'estimate: for the 2 profiles in all, ')
  const limitsOfTwo = `${limits}, for each of the 2 profiles`

  it('writes the estimate\'s lines, a profile\'s prefixed when several run', () => {
    expect(estimateLines(estimate, bounds)).toEqual([
      'estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all',
      cost,
      limits,
    ])
    const team = {
      parts: [8000],
      votes: 100,
      candidates: 0,
      vote: { naming: 3000, layout: 3000 },
      expected: 2667,
      worst: 608_000,
      findings: 50,
      maxFindings: 50,
      provider: 'api',
      documents: { research: 0, vote: 0 },
    }
    expect(estimateLines({
      ...estimate,
      profiles: { security: estimate.profiles.security, team },
    }, bounds)).toEqual([
      '[security] estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all',
      '[team] estimate: 1 research part(s), about 2.66k tokens expected for them; then up to 100 vote(s), at most 608k tokens in all',
      costOfTwo,
      limitsOfTwo,
    ])
    // A profile's id is a caller's text: it is shown inert.
    const [first] = estimateLines({
      ...estimate,
      profiles: { [`a${RLO}b`]: estimate.profiles.security, team },
    }, bounds)
    expect(first).toBe('[a<U+202E>b] estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all')
  })

  it('says how many of a profile\'s votes fall on scanner issues', () => {
    // 3 lenses and 3 candidates: 9 of the 159 votes are the candidates' (150 for the finder's findings, so the cap is read as before).
    const scanning = (candidates: number, votes: number): Estimate => ({
      ...estimate,
      profiles: {
        security: { ...estimate.profiles.security, candidates, votes },
      },
    })
    expect(estimateLines(scanning(3, 159), bounds)[0]).toBe('estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 159 vote(s), 9 of them on 3 scanner issue(s), at most 1.85M tokens in all')
    // A program reads the same clause with exact counts, and a profile of two lenses counts its own.
    expect(estimateLines(scanning(3, 159), bounds, EXACT_WORDS)[0]).toBe('estimate: 2 research part(s), about 16667 tokens expected for them; then up to 159 vote(s), 9 of them on 3 scanner issue(s), at most 1850000 tokens in all')
    const two = {
      ...estimate.profiles.security,
      candidates: 4,
      votes: 108,
      vote: { naming: 3000, layout: 3000 },
    }
    expect(estimateLines({
      ...estimate,
      profiles: { security: estimate.profiles.security, team: two },
    }, bounds)[1]).toBe('[team] estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 108 vote(s), 8 of them on 4 scanner issue(s), at most 1.85M tokens in all')
    // The clause comes before the documents', which end the line, and a profile that judges none has none.
    expect(estimateLines({
      ...estimate,
      profiles: {
        security: {
          ...scanning(3, 159).profiles.security,
          documents: { research: 4402, vote: 4402 },
        },
      },
    }, bounds)[0]).toBe('estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 159 vote(s), 9 of them on 3 scanner issue(s), at most 1.85M tokens in all; its documents add 4.40k tokens to each research request and 4.40k to each vote')
    expect(estimateLines(scanning(0, 150), bounds)[0]).toBe('estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all')
  })

  it('ends a profile\'s estimate line with what its documents add, when they add anything', () => {
    const clause = (research: string, vote: string): string => `; its documents add ${research} tokens to each research request and ${vote} to each vote`
    const profile = (documents: { research: number, vote: number }): Estimate['profiles'][string] => ({ ...estimate.profiles.security, documents })
    const first = (profiles: Estimate['profiles'], words?: Parameters<typeof estimateLines>[2]): string => estimateLines({ ...estimate, profiles }, bounds, words)[0]
    const line = 'estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all'
    // A person reads the counts scaled, a program under --progress json reads the integers.
    expect(first({
      security: profile({ research: 4402, vote: 4402 }),
    })).toBe(`${line}${clause('4.40k', '4.40k')}`)
    expect(first({
      security: profile({ research: 4402, vote: 4402 }),
    }, EXACT_WORDS)).toBe(`estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all${clause('4402', '4402')}`)
    // Each count is its own: the do-not-report text reaches research alone, so a vote's is 0, and the clause is written while either is above 0.
    expect(first({
      security: profile({ research: 1500, vote: 0 }),
    })).toBe(`${line}${clause('1.50k', '0')}`)
    expect(first({
      security: profile({ research: 0, vote: 1500 }),
    })).toBe(`${line}${clause('0', '1.50k')}`)
    // No clause at 0, for either: the line is as it was.
    expect(first({
      security: profile({ research: 0, vote: 0 }),
    })).toBe(line)
    // Each profile's line holds its own, prefixed when several run, and the review's two lines hold none.
    const lines = estimateLines({
      ...estimate,
      profiles: {
        security: profile({ research: 0, vote: 0 }),
        naming: profile({ research: 4402, vote: 1500 }),
      },
    }, bounds)
    expect(lines[0]).toBe(`[security] ${line}`)
    expect(lines[1]).toBe(`[naming] ${line}${clause('4.40k', '1.50k')}`)
    expect(lines[2]).toBe(costOfTwo)
    expect(lines.filter(entry => entry.includes('its documents add'))).toHaveLength(1)
  })

  it('writes the cap line when research expects over half the cap, with the cap the review needs', () => {
    // Expected 1000001 of a cap of 2000000 is over half; the review needs expected and inFlight, and every vote at a third of its bound: 150 votes of 4000 each, 200000, so 1250001 rounded up to 1300000.
    const heavy: Estimate = {
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
    }
    const lines = estimateLines(heavy, bounds)
    expect(lines).toEqual([
      'estimate: 2 research part(s), about 16.6k tokens expected for them; then up to 150 vote(s), at most 1.85M tokens in all',
      'estimate: research about 1.00M tokens expected, at most 1.85M with every vote and every part recovered, 50.0k of them reserved at once',
      limits,
      'estimate: research alone expects about 1.00M of the review\'s token cap of 2.00M (50%): a review of this size needs a cap of about 1300000: raise maxReviewTokens, or narrow the path',
    ])
    // Half the cap is not over half: no line. The need rounds up to the next 100000, and an exact multiple stays.
    expect(estimateLines({ ...estimate, expected: 1_000_000 }, bounds)).toHaveLength(3)
    expect(estimateLines({ ...estimate, expected: 1_000_000 - 1 }, bounds)).toHaveLength(3)
    const vote = {
      ...estimate.profiles.security,
      vote: { only: 3000 },
    }
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 49_999,
      profiles: { security: vote },
    }, bounds)[3]).toContain('needs a cap of about 1100000')
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
      profiles: { security: vote },
    }, bounds)[3]).toContain('needs a cap of about 1200000')
    // Several profiles: every one's votes count, and the line is never prefixed.
    const two = estimateLines({
      ...heavy,
      profiles: {
        security: estimate.profiles.security,
        team: { ...estimate.profiles.security },
      },
    }, bounds)
    expect(two.at(-1)).toBe('estimate: research alone expects about 1.00M of the review\'s token cap of 2.00M (50%): a review of this size needs a cap of about 1500000: raise maxReviewTokens, or narrow the path')
  })

  it('writes the N line once per research provider below maxFindings', () => {
    const profile = (findings: number, provider: string, parts = [1000]): Estimate['profiles'][string] => ({
      ...estimate.profiles.security,
      parts,
      findings,
      provider,
    })
    const line = (provider: string, n: number): string => `estimate: on ${provider} a research reply asks for at most ${n} of maxFindings 50 findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N`
    // One line for a provider below maxFindings, none for one at it.
    expect(estimateLines({
      ...estimate,
      profiles: {
        a: profile(15, 'local'),
        b: profile(50, 'api'),
      },
    }, bounds).slice(4)).toEqual([
      line('local', 15),
    ])
    // A provider two profiles share is named once; each provider below maxFindings has its own line, in profile order.
    expect(estimateLines({
      ...estimate,
      profiles: {
        a: profile(15, 'local'),
        b: profile(15, 'local'),
        c: profile(7, 'small'),
      },
    }, bounds).slice(5)).toEqual([
      line('local', 15),
      line('small', 7),
    ])
    // A profile whose research makes no call asks nothing, and a provider's id is a caller's text, shown inert.
    expect(estimateLines({
      ...estimate,
      profiles: {
        a: profile(15, 'local', []),
        b: profile(7, `x${RLO}y`),
      },
    }, bounds).slice(4)).toEqual([
      line('x<U+202E>y', 7),
    ])
  })

  it('names a research provider whose reply holds fewer findings than its profile\'s own maxFindings, and none for one that asks its own in full', () => {
    const profile = (findings: number, maxFindings: number, provider: string): Estimate['profiles'][string] => ({
      ...estimate.profiles.security,
      parts: [1000],
      findings,
      maxFindings,
      provider,
    })
    // The run's maxFindings is 50: a profile that asks its own 20 in full is at its ceiling, and one whose budget holds 12 of its 20 is below it.
    expect(estimateLines({
      ...estimate,
      profiles: {
        a: profile(20, 20, 'local'),
        b: profile(12, 20, 'research'),
      },
    }, bounds).slice(4)).toEqual([
      'estimate: on research a research reply asks for at most 12 of maxFindings 20 findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N',
    ])
    // One provider under two ceilings has a line for each, in profile order.
    expect(estimateLines({
      ...estimate,
      profiles: {
        a: profile(12, 20, 'local'),
        b: profile(12, 50, 'local'),
        c: profile(12, 20, 'local'),
      },
    }, bounds).slice(5)).toEqual([
      'estimate: on local a research reply asks for at most 12 of maxFindings 20 findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N',
      'estimate: on local a research reply asks for at most 12 of maxFindings 50 findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N',
    ])
  })

  it.each([
    [
      'all three follow the estimate',
      { cap: 'estimate', deadline: 'longest', findings: 'floor' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 50, the default, which holds four per research part; the config sets none of them',
    ],
    [
      'the config sets the cap',
      { cap: 'config', deadline: 'longest', findings: 'floor' },
      'the token cap 2.00M (maxReviewTokens); the deadline 24h00m00s, the longest allowed; the finding cap 50, the default, which holds four per research part',
    ],
    [
      'the config sets the deadline',
      { cap: 'estimate', deadline: 'config', findings: 'floor' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 1h00m00s (reviewTimeoutMs); the finding cap 50, the default, which holds four per research part',
    ],
    [
      'the floor holds the worst case',
      { cap: 'floor', deadline: 'longest', findings: 'floor' },
      'the token cap 2.00M, the default, which holds this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 50, the default, which holds four per research part; the config sets none of them',
    ],
    [
      'the finding cap follows the parts',
      { cap: 'estimate', deadline: 'longest', findings: 'parts' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 484, four per research part; the config sets none of them',
    ],
    [
      'the config sets maxFindings alone',
      { cap: 'estimate', deadline: 'longest', findings: 'maxFindings' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 121 (maxFindings)',
    ],
    [
      'the config sets findingsCap alone',
      { cap: 'estimate', deadline: 'longest', findings: 'findingsCap' },
      'the token cap 9.86M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 121 (findingsCap)',
    ],
  ] as const)('ends the estimate with its bounds when %s', (_name, bounds, ending) => {
    const cap = bounds.cap === 'estimate'
      ? 9_864_619
      : 2_000_000
    const ms = bounds.deadline === 'longest'
      ? 86_400_000
      : 3_600_000
    const findingsCap = bounds.findings === 'floor'
      ? 50
      : bounds.findings === 'parts'
        ? 484
        : 121
    const [, , last] = estimateLines({
      ...estimate,
      maxReviewTokens: cap,
      reviewTimeoutMs: ms,
      findingsCap,
    }, bounds)
    expect(last).toBe(`bounds: ${ending}`)
  })

  it.each([
    ['findingsCap', 300, 'the finding cap 300 (findingsCap)'],
    ['maxFindings', 30, 'the finding cap 30 (maxFindings)'],
  ] as const)('names %s as the finding cap the config sets, and says nothing of a config that sets none', (findings, cap, words) => {
    const bounded = { ...estimate, reviewTimeoutMs: 86_400_000, findingsCap: cap }
    expect(estimateLines(bounded, { cap: 'estimate', deadline: 'longest', findings }).at(2)).toBe(`bounds: the token cap 2.00M, this estimate's worst case; the deadline 24h00m00s, the longest allowed; ${words}`)
  })

  it('writes the estimate in two lines, the cost then the bounds, each count scaled and the deadline in hours and minutes', () => {
    const lines = estimateLines({ ...estimate, reviewTimeoutMs: 86_400_000 }, { cap: 'floor', deadline: 'longest', findings: 'floor' })
    expect(lines.slice(1)).toEqual([
      'estimate: research about 16.6k tokens expected, at most 1.85M with every vote and every part recovered, 50.0k of them reserved at once',
      'bounds: the token cap 2.00M, the default, which holds this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 50, the default, which holds four per research part; the config sets none of them',
    ])
  })

  it.each<[number, string]>([
    [1500, '1.5s'],
    [42_000, '42s'],
    [59_400, '59s'],
    [90_000, '1m30s'],
  ])('writes a deadline of %i ms as every line writes a duration, %s, and never rounds one it states', (ms, words) => {
    const [, , last] = estimateLines({ ...estimate, reviewTimeoutMs: ms }, bounds)
    expect(last).toBe(`bounds: the token cap 2.00M (maxReviewTokens); the deadline ${words} (reviewTimeoutMs); the finding cap 50 (maxFindings)`)
  })

  it('writes every number of the estimate exact with EXACT_WORDS', () => {
    const lines = estimateLines({ ...estimate, reviewTimeoutMs: 86_400_000 }, { cap: 'floor', deadline: 'longest', findings: 'floor' }, EXACT_WORDS)
    expect(lines).toEqual([
      'estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      'estimate: research about 16667 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once',
      'bounds: the token cap 2000000, the default, which holds this estimate\'s worst case; the deadline 86400000 ms, the longest allowed; the finding cap 50, the default, which holds four per research part; the config sets none of them',
    ])
    const heavy: Estimate = { ...estimate, expected: 1_000_001 }
    expect(estimateLines(heavy, bounds, EXACT_WORDS)[3]).toBe('estimate: research alone expects about 1000001 of the review\'s token cap of 2000000 (50%): a review of this size needs a cap of about 1300000: raise maxReviewTokens, or narrow the path')
    const large: Estimate = { ...estimate, worst: 9_864_619, expected: 1_950_001 }
    expect(boundWarnings(large, { cap: 'estimate', deadline: 'longest', findings: 'floor' }, EXACT_WORDS)).toEqual([
      'warning: a large review: 2 research part(s) and up to 150 vote(s), about 1950001 tokens expected and at most 9864619: Ctrl-C stops it and keeps what it read',
    ])
  })

  it('counts the cap line\'s votes at the findingsCap, and compares N to maxFindings', () => {
    // 121 findings of 3 lenses at 4000 each, a third of it: 484000, so 1000001 + 50000 + 484000 rounds up to 1600000.
    const heavy: Estimate = { ...estimate, expected: 1_000_001, findingsCap: 121 }
    expect(estimateLines(heavy, { cap: 'config', deadline: 'config', findings: 'parts' })[3]).toContain('needs a cap of about 1600000')
    // N below maxFindings is still compared to maxFindings, whatever the finding cap.
    const narrow: Estimate = {
      ...estimate,
      findingsCap: 121,
      profiles: {
        security: { ...estimate.profiles.security, findings: 15, provider: 'local' },
      },
    }
    expect(estimateLines(narrow, { cap: 'config', deadline: 'config', findings: 'parts' }).at(-1)).toBe('estimate: on local a research reply asks for at most 15 of maxFindings 50 findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N')
  })

  it('writes the large review\'s warning, and the cap\'s when the estimate passes an explicit cap', () => {
    // A small review's worst case passes the default through recovery's bound alone, and says nothing.
    const small: Estimate = {
      ...estimate,
      worst: 9_864_619,
      maxReviewTokens: 9_864_619,
      reviewTimeoutMs: 86_400_000,
    }
    expect(boundWarnings(small, { cap: 'estimate', deadline: 'longest', findings: 'floor' })).toEqual([])
    // What 0.8.0 held: the expected spend and the calls in flight pass the default, 2000000.
    const large: Estimate = { ...small, expected: 1_950_001 }
    expect(boundWarnings(large, { cap: 'estimate', deadline: 'longest', findings: 'floor' })).toEqual([
      'warning: a large review: 2 research part(s) and up to 150 vote(s), about 1.95M tokens expected and at most 9.86M: Ctrl-C stops it and keeps what it read',
    ])
    expect(boundWarnings({ ...large, expected: 1_950_000 }, { cap: 'estimate', deadline: 'longest', findings: 'floor' })).toEqual([])
    // An explicit cap writes the cap's warning alone, never the large review's.
    const explicit: Estimate = {
      ...large,
      maxReviewTokens: 120_000,
      fits: false,
      held: 0,
    }
    expect(boundWarnings(explicit, { cap: 'config', deadline: 'longest', findings: 'floor' })).toHaveLength(1)
    expect(boundWarnings(explicit, { cap: 'config', deadline: 'longest', findings: 'floor' })[0]).toContain('the token cap of 120k (maxReviewTokens) holds about 0 of the 2')
    // The default floor holds the worst case, and a cap the estimate fits under is no warning.
    expect(boundWarnings(estimate, { cap: 'floor', deadline: 'longest', findings: 'floor' })).toEqual([])
    expect(boundWarnings(estimate, { cap: 'config', deadline: 'config', findings: 'maxFindings' })).toEqual([])
    const below: Estimate = {
      ...estimate,
      maxReviewTokens: 120_000,
      fits: false,
      held: 1,
    }
    expect(boundWarnings(below, { cap: 'config', deadline: 'longest', findings: 'floor' })).toEqual([
      'warning: the token cap of 120k (maxReviewTokens) holds about 1 of the 2 research parts this estimate expects: the review runs to the cap, and what it cannot pay for is a token-cap gap; unset maxReviewTokens to let a path review\'s cap follow its estimate',
    ])
  })

  describe('when several profiles run', () => {
    const profile = estimate.profiles.security
    const profiles: Estimate['profiles'] = {
      security: profile,
      'code-review': {
        ...profile,
        parts: [30_000],
        votes: 100,
        vote: { real: 4000, introduced: 4000 },
      },
      'best-practices': {
        ...profile,
        parts: [30_000, 20_000, 10_000],
        votes: 75,
        vote: { absent: 4000 },
      },
    }
    const three: Estimate = {
      ...estimate,
      profiles,
      expected: 40_000,
      worst: 5_550_000,
      inFlight: 50_000,
      findingsCap: 904,
      maxReviewTokens: 5_550_000,
      reviewTimeoutMs: 86_400_000,
    }

    it('says the whole review\'s estimate counts every profile, and the finding cap holds for each, when several run', () => {
      const bounds: Bounds = { cap: 'estimate', deadline: 'longest', findings: 'parts' }
      const whole = (words: Parameters<typeof estimateLines>[2]): string[] => estimateLines(three, bounds, words).slice(3)
      expect(whole(PERSON_WORDS)).toEqual([
        'estimate: for the 3 profiles in all, research about 40.0k tokens expected, at most 5.55M with every vote and every part recovered, 50.0k of them reserved at once',
        'bounds: the token cap 5.55M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 904, four per research part, for each of the 3 profiles; the config sets none of them',
      ])
      expect(whole(EXACT_WORDS)).toEqual([
        'estimate: for the 3 profiles in all, research about 40000 tokens expected, at most 5550000 with every vote and every part recovered, 50000 of them reserved at once',
        'bounds: the token cap 5550000, this estimate\'s worst case; the deadline 86400000 ms, the longest allowed; the finding cap 904, four per research part, for each of the 3 profiles; the config sets none of them',
      ])
      // Each profile's own line is as it was, and the count is the entries': two profiles say 2.
      expect(estimateLines(three, bounds)[1]).toBe('[code-review] estimate: 1 research part(s), about 16.6k tokens expected for them; then up to 100 vote(s), at most 1.85M tokens in all')
      expect(estimateLines({
        ...three,
        profiles: { security: profile, team: profile },
      }, bounds).slice(2)).toEqual([
        'estimate: for the 2 profiles in all, research about 40.0k tokens expected, at most 5.55M with every vote and every part recovered, 50.0k of them reserved at once',
        'bounds: the token cap 5.55M, this estimate\'s worst case; the deadline 24h00m00s, the longest allowed; the finding cap 904, four per research part, for each of the 2 profiles; the config sets none of them',
      ])
    })

    it.each([
      [
        'findingsCap',
        'the finding cap 904 (findingsCap), for each of the 3 profiles',
      ],
      [
        'maxFindings',
        'the finding cap 904 (maxFindings), for each of the 3 profiles',
      ],
      [
        'floor',
        'the finding cap 904, the default, which holds four per research part, for each of the 3 profiles; the config sets none of them',
      ],
    ] as const)('ends the finding cap with the count of profiles, whatever sets it: %s', (findings, words) => {
      const [bounds] = estimateLines(three, { cap: 'estimate', deadline: 'longest', findings }).slice(4)
      expect(bounds).toBe(`bounds: the token cap 5.55M, this estimate's worst case; the deadline 24h00m00s, the longest allowed; ${words}`)
    })

    it('counts every profile\'s parts and votes in a large review\'s warning, across them', () => {
      const large: Estimate = { ...three, expected: 1_950_001, worst: 9_864_619 }
      const bounds: Bounds = { cap: 'estimate', deadline: 'longest', findings: 'parts' }
      // 2 + 1 + 3 research parts, and 150 + 100 + 75 votes, over the 3 profiles.
      expect(boundWarnings(large, bounds)).toEqual([
        'warning: a large review: 6 research part(s) and up to 325 vote(s) across the 3 profiles, about 1.95M tokens expected and at most 9.86M: Ctrl-C stops it and keeps what it read',
      ])
      expect(boundWarnings(large, bounds, EXACT_WORDS)).toEqual([
        'warning: a large review: 6 research part(s) and up to 325 vote(s) across the 3 profiles, about 1950001 tokens expected and at most 9864619: Ctrl-C stops it and keeps what it read',
      ])
      // One profile says nothing of profiles, and a cap the config sets writes its own warning, which already counts every part.
      expect(boundWarnings({
        ...large,
        profiles: { security: profile },
      }, bounds)).toEqual([
        'warning: a large review: 2 research part(s) and up to 150 vote(s), about 1.95M tokens expected and at most 9.86M: Ctrl-C stops it and keeps what it read',
      ])
      expect(boundWarnings({
        ...large,
        maxReviewTokens: 120_000,
        fits: false,
        held: 2,
      }, { ...bounds, cap: 'config' })[0]).toContain('holds about 2 of the 6 research parts this estimate expects')
    })
  })
})

describe('findingsCapOf', () => {
  const profileOf = (parts: number): Estimate['profiles'][string] => ({
    parts: Array.from<number>({ length: parts }).fill(1000),
    votes: 0,
    candidates: 0,
    vote: {},
    expected: 0,
    worst: 0,
    findings: 50,
    maxFindings: 50,
    provider: 'api',
    documents: { research: 0, vote: 0 },
  })
  const estimateOf = (...parts: number[]): Estimate => ({
    profiles: Object.fromEntries(parts.map((count, index) => [
      `p${index}`,
      profileOf(count),
    ])),
    expected: 0,
    worst: 0,
    inFlight: 0,
    maxFindings: 50,
    findingsCap: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
    held: 0,
  })

  it.each([
    [
      [1],
      50,
    ],
    [
      [12],
      50,
    ],
    [
      [13],
      52,
    ],
    [
      [226],
      904,
    ],
    [
      [10, 30],
      120,
    ],
    [[], 50],
  ] as const)('derives a path review\'s finding cap of %j research parts as %i', (parts, cap) => {
    expect(findingsCapOf(estimateOf(...parts))).toBe(cap)
  })

  it('reads four findings for each research part', () => {
    expect(PATH_FINDINGS_PER_PART).toBe(4)
  })
})

describe('bannerLines', () => {
  const local = {
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3.6:27b',
    contextTokens: 131072,
  } as const
  const mistral = { preset: 'mistral', model: 'mistral-small-latest', contextTokens: 131072 } as const
  const lenses = securityProfile.lenses.map(lens => lens.id)
  const config = (providers: Record<string, ResolvedProvider>, bindings: Array<{ id?: string, research: string, voters: Record<string, string> }>): ResolvedConfig => ({
    providers,
    profiles: bindings.map(({ id = 'security', research, voters }) => ({
      profile: { ...securityProfile, id },
      research,
      voters,
      repository: [],
    })),
    warnings: [],
  }) satisfies ResolvedConfig
  const sharing = (name: string): Record<string, string> => Object.fromEntries(lenses.map(lens => [lens, name]))

  it('names the provider of the research and of the panel once, when every lens shares it', () => {
    expect(bannerLines(config({ local }, [
      {
        research: 'local',
        voters: sharing('local'),
      },
    ]))).toEqual([
      'Research (qwen3.6:27b @ http://localhost:11434)...',
      'Panel will use qwen3.6:27b @ http://localhost:11434',
    ])
  })

  it('names each lens\'s provider when they differ, one of them reached through its preset\'s base URL', () => {
    const voters = { reachability: 'local', impact: 'mistral', defenses: 'local' }
    expect(bannerLines(config({ local, mistral }, [
      { research: 'local', voters },
    ]))[1]).toBe('Panel will use reachability (qwen3.6:27b @ http://localhost:11434), impact (mistral-small-latest @ https://api.mistral.ai), defenses (qwen3.6:27b @ http://localhost:11434)')
  })

  it('names a claude-code provider by its model and its protocol', () => {
    const cc = {
      protocol: 'claude-code',
      command: '/c',
      model: 'sonnet',
      contextTokens: 1000000,
    } as const
    expect(bannerLines(config({ cc }, [
      {
        research: 'cc',
        voters: sharing('cc'),
      },
    ]))).toEqual(['Research (sonnet @ claude-code)...', 'Panel will use sonnet @ claude-code'])
  })

  it('names a claude-code provider among others, and never its command', () => {
    const cc = {
      protocol: 'claude-code',
      command: '/secret/claude',
      model: 'haiku',
      contextTokens: 1000000,
    } as const
    const voters = { reachability: 'cc', impact: 'local', defenses: 'cc' }
    const lines = bannerLines(config({ local, cc }, [
      { research: 'local', voters },
    ]))
    expect(lines[1]).toBe('Panel will use reachability (haiku @ claude-code), impact (qwen3.6:27b @ http://localhost:11434), defenses (haiku @ claude-code)')
    expect(lines.join('\n')).not.toContain('secret')
  })

  it('starts each line with the profile when several run', () => {
    const lines = bannerLines(config({ local }, [
      {
        research: 'local',
        voters: sharing('local'),
      },
      {
        id: 'team',
        research: 'local',
        voters: sharing('local'),
      },
    ]))
    expect(lines).toHaveLength(4)
    expect(lines.map(line => line.slice(0, line.indexOf(' ')))).toEqual([
      '[security]',
      '[security]',
      '[team]',
      '[team]',
    ])
    expect(lines[2]).toBe('[team] Research (qwen3.6:27b @ http://localhost:11434)...')
  })

  it('names a provider object by its config key, and writes every line inert', () => {
    const complete: Provider['complete'] = async () => ({ text: '', model: 'm' })
    const mine: Provider = { id: 'mine', model: `m${String.fromCharCode(0x202E)}`, complete }
    const lines = bannerLines(config({ mine }, [
      {
        research: 'mine',
        voters: sharing('mine'),
      },
    ]))
    expect(lines[0]).toBe('Research (m<U+202E> @ the provider object mine)...')
    expect(lines[1]).toBe('Panel will use m<U+202E> @ the provider object mine')
  })

  it('names each provider by its config key alone in the public banner', () => {
    const providers = { default: local, voter: mistral }
    const lines = bannerLines(config(providers, [
      {
        research: 'default',
        voters: sharing('voter'),
      },
    ]), 'public')
    expect(lines).toEqual(['Research (default)...', 'Panel will use voter'])
    const split = bannerLines(config(providers, [
      {
        research: 'default',
        voters: { grounded: 'default', significant: 'voter' },
      },
    ]), 'public')
    expect(split[1]).toBe('Panel will use grounded (default), significant (voter)')
    const several = bannerLines(config(providers, [
      {
        research: 'default',
        voters: sharing('default'),
      },
      {
        id: 'team',
        research: 'voter',
        voters: sharing('voter'),
      },
    ]), 'public')
    expect(several).toEqual([
      '[security] Research (default)...',
      '[security] Panel will use default',
      '[team] Research (voter)...',
      '[team] Panel will use voter',
    ])
    expect([
      ...lines,
      ...split,
      ...several,
    ].join('\n')).not.toMatch(/qwen|mistral-small|localhost|11434|https?:|@/)
  })

  it('reads a base URL as an own field, never the one a polluted prototype holds', () => {
    const proto = Object.prototype as Record<string, unknown>
    proto.baseUrl = 'https://attacker.example/v1'
    try {
      const lines = bannerLines(config({ mistral }, [
        {
          research: 'mistral',
          voters: sharing('mistral'),
        },
      ]))
      expect(lines[0]).toBe('Research (mistral-small-latest @ https://api.mistral.ai)...')
      expect(lines.join('')).not.toContain('attacker')
    } finally {
      delete proto.baseUrl
    }
  })
})

describe('profileProviders', () => {
  it('names who researches and who votes in each profile, as the banner names them', () => {
    const config = resolvedConfig({
      providers: {
        fake: {
          model: 'm',
          complete: async () => ({ text: '{}', model: 'm' }),
        },
      },
    })
    expect(profileProviders(config)).toEqual([
      { profile: 'security', research: 'm @ the provider object fake', panel: 'm @ the provider object fake' },
    ])
  })
})

describe('viewFacts', () => {
  const lone = (findings: number) => ({
    research: {
      provider: 'api',
      findings,
      maxFindings: 50,
      findingsWithoutThinking: findings,
    },
    lenses: {},
  }) satisfies ProfileBudgets
  const config = resolvedConfig({
    providers: {
      fake: {
        model: 'm',
        complete: async () => ({ text: '{}', model: 'm' }),
      },
    },
  })

  it('reads the view\'s facts from the config, with the defaults the review uses, and a path review\'s estimate', () => {
    // `concurrency` unset is `auto`: each provider's own lane
    expect(viewFacts(config)).toEqual({
      concurrency: 'auto',
      cap: { tokens: 2_000_000, origin: 'default' },
      deadlineMs: 1_800_000,
      deadline: 'default',
      maxFindings: 50,
      asks: { maxFindings: 50, findings: {}, own: {} },
    })
    const set = {
      ...config,
      concurrency: 2,
      maxFindings: 9,
      maxReviewTokens: 300_000,
      reviewTimeoutMs: 60_000,
    }
    const estimate = {
      profiles: {},
      expected: 0,
      worst: 0,
      inFlight: 0,
      maxFindings: 9,
      findingsCap: 9,
      maxReviewTokens: 300_000,
      reviewTimeoutMs: 60_000,
      fits: true,
      held: 0,
    } satisfies Estimate
    expect(viewFacts(set, { estimate })).toEqual({
      concurrency: 2,
      cap: { tokens: 300_000, origin: 'config' },
      deadlineMs: 60_000,
      deadline: 'config',
      maxFindings: 9,
      asks: { maxFindings: 9, findings: {}, own: {} },
      estimate,
    })
    // A path review's finding cap is the facts' maxFindings, which sizes the votes to come.
    expect(viewFacts(config, {
      estimate,
      bounds: {
        cap: { tokens: 300_000, origin: 'config' },
        deadlineMs: 60_000,
        findingsCap: 121,
      },
    }).maxFindings).toBe(121)
  })

  it('states the panel\'s cap as the config\'s findingsCap, else its maxFindings, else the default, a diff review\'s too, and asks by maxFindings', () => {
    const capped = viewFacts({ ...config, findingsCap: 30, maxFindings: 50 })
    expect(capped.maxFindings).toBe(30)
    expect(capped.asks.maxFindings).toBe(50)
    expect(viewFacts({ ...config, findingsCap: 30 })).toMatchObject({
      maxFindings: 30,
      asks: { maxFindings: 50 },
    })
    expect(viewFacts({ ...config, maxFindings: 20 })).toMatchObject({
      maxFindings: 20,
      asks: { maxFindings: 20 },
    })
    // A path review's bounds win over both.
    expect(viewFacts({ ...config, findingsCap: 30, maxFindings: 50 }, {
      bounds: {
        cap: { tokens: 300_000, origin: 'config' },
        deadlineMs: 60_000,
        findingsCap: 121,
      },
    })).toMatchObject({
      maxFindings: 121,
      asks: { maxFindings: 50 },
    })
  })

  it.each<[string, string, Partial<ResolvedConfig>, Parameters<typeof viewFacts>[1]]>([
    [
      'a config that sets reviewTimeoutMs',
      'config',
      { reviewTimeoutMs: 60_000 },
      undefined,
    ],
    [
      'a path review\'s unset one',
      'longest',
      {},
      {
        bounds: {
          cap: { tokens: 300_000, origin: 'estimate' },
          deadlineMs: 86_400_000,
          findingsCap: 50,
        },
      },
    ],
    [
      'a diff review\'s unset one',
      'default',
      {},
      undefined,
    ],
    [
      'a path review of a config that sets it',
      'config',
      { reviewTimeoutMs: 60_000 },
      {
        bounds: {
          cap: { tokens: 300_000, origin: 'estimate' },
          deadlineMs: 60_000,
          findingsCap: 50,
        },
      },
    ],
  ])('reads the deadline of %s as %s', (_name, origin, set, extra) => {
    expect(viewFacts({
      ...config,
      ...set,
    }, extra).deadline).toBe(origin)
  })

  it('reads whether the review keeps its answered calls from the caller, and states nothing when unsaid', () => {
    expect(viewFacts(config)).not.toHaveProperty('keeps')
    expect(viewFacts(config, { keeps: false }).keeps).toBe(false)
    expect(viewFacts(config, { keeps: true }).keeps).toBe(true)
  })

  it('reads the asks of each profile from the quorum\'s budgets', () => {
    const facts = viewFacts({ ...config, maxFindings: 50 }, {
      budgets: {
        security: lone(47),
        naming: lone(50),
      },
    })
    expect(facts.asks).toEqual({
      maxFindings: 50,
      findings: { security: 47, naming: 50 },
      own: {},
    })
  })

  it('gives the view the maxFindings each profile sets of its own', () => {
    const [security] = config.profiles
    const naming = {
      ...security,
      profile: { ...security.profile, id: 'naming', maxFindings: 20 },
    }
    expect(viewFacts({
      ...config,
      profiles: [security, naming],
    }).asks.own).toEqual({ naming: 20 })
    expect(viewFacts(config).asks.own).toEqual({})
  })
})
