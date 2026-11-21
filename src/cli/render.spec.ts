import { describe, expect, it } from 'vitest'
import type { Provider } from '../core/ports.ts'
import type { Estimate, LeftOutFile, QuorumEvent } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { bannerLines, estimateLines, profileProviders, progressSink, providerOrigin, renderEvent } from './render.ts'

/** A right-to-left override, which the sanitizer writes as text. */
const RLO = String.fromCharCode(0x202E)

describe('renderEvent', () => {
  it('turns the events a person follows into progress lines', () => {
    expect(renderEvent({
      type: 'stage:end',
      profile: 'security',
      stage: 'dedup',
      durationMs: 1,
      count: 2,
    })).toBe('2 candidate(s) after dedup')
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'missing.js:1 is not in the diff' })).toBe('invalid finding dropped: missing.js:1 is not in the diff')
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' },
    })).toBe('incomplete: research-unusable (1 finding(s) reported, none usable)')
    expect(renderEvent({
      type: 'run:end',
      kept: 1,
      discarded: 2,
      unreviewed: 3,
      incomplete: 0,
      durationMs: 5,
    })).toBe('1 kept, 2 discarded, 3 unreviewed by panel')
  })

  it('writes a provider-down event as the line that names its fix', () => {
    expect(renderEvent({
      type: 'provider-down',
      provider: 'finder',
      kind: 'http',
      status: 503,
      calls: 3,
    })).toBe('finder: 3 calls in a row failed (http 503): no more calls go to it in this review: lower concurrency or wait')
    expect(renderEvent({
      type: 'provider-down',
      provider: 'finder',
      kind: 'network',
      calls: 3,
    })).toBe('finder: 3 calls in a row failed (network): no more calls go to it in this review: check that the server at its origin is running')
    expect(renderEvent({
      type: 'provider-down',
      provider: `f${RLO}x`,
      kind: 'timeout',
      calls: 3,
    }, true, 'public')).toBe('f<U+202E>x: 3 calls in a row failed (timeout): no more calls go to it in this review: raise timeoutMs')
    expect(renderEvent({
      type: 'provider-down',
      provider: 'finder',
      kind: 'no-answer',
      calls: 3,
      noAnswer: 'thinking',
    })).toBe('finder: 3 calls in a row had no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt')
  })

  it.each<[string, QuorumEvent, string]>([
    [
      'the server\'s lower cap',
      {
        type: 'reply-lacked',
        provider: 'api',
        kind: 'truncated',
        noAnswer: 'reply',
        limit: 21_024,
        outputTokens: 8192,
        inputTokens: 9000,
      },
      'api: a reply was cut off at 8192 tokens, below the 21024 quorum asked for: the server caps replies near 8192: set maxTokens: 8192',
    ],
    [
      'a smaller window',
      {
        type: 'reply-lacked',
        provider: 'api',
        kind: 'truncated',
        noAnswer: 'window',
        inputTokens: 30_100,
        outputTokens: 2668,
        window: 200_000,
      },
      'api: a reply ended at the server\'s window after 30100 input and 2668 output tokens, below contextTokens 200000: set contextTokens to at most 32768',
    ],
    [
      'only reasoning',
      {
        type: 'reply-lacked',
        provider: 'api',
        kind: 'no-answer',
        noAnswer: 'thinking',
      },
      'api: reply has no answer, only reasoning: the server may put its answer in its reasoning field: set thinking: off, or structuredOutput: prompt',
    ],
    [
      'nothing',
      {
        type: 'reply-lacked',
        provider: 'api',
        kind: 'no-answer',
        noAnswer: 'empty',
      },
      'api: reply has no answer and no reasoning: the server may mishandle its structured output: set structuredOutput: prompt',
    ],
  ])('writes a reply-lacked event as %s', (_name, event, line) => {
    expect(renderEvent(event)).toBe(line)
    expect(renderEvent({ ...event, provider: `a${RLO}b` } as QuorumEvent, true, 'public')).toBe(line.replace('api:', 'a<U+202E>b:'))
  })

  it.each<[string, QuorumEvent, string]>([
    [
      'thinking lowered after a cut-off',
      {
        type: 'adapted',
        adaptation: {
          provider: 'api',
          setting: 'thinking',
          from: 'default',
          to: 'low',
          cause: 'cut-off-thinking',
        },
      },
      'api: thinking lowered to low for the rest of the review: a reply ran out of room while reasoning; set thinking to choose it yourself',
    ],
    [
      'thinking lowered after a reply with only reasoning',
      {
        type: 'adapted',
        adaptation: {
          provider: 'api',
          setting: 'thinking',
          from: 'default',
          to: 'off',
          cause: 'no-answer-thinking',
        },
      },
      'api: thinking lowered to off for the rest of the review: a reply held only reasoning; set thinking to choose it yourself',
    ],
    [
      'structured output moved to prompt after an empty reply',
      {
        type: 'adapted',
        adaptation: {
          provider: 'api',
          setting: 'structuredOutput',
          from: 'json',
          to: 'prompt',
          cause: 'empty-reply',
        },
      },
      'api: structuredOutput moved to prompt for the rest of the review: a reply in JSON mode was empty; set structuredOutput to choose it yourself',
    ],
    [
      'structured output moved to prompt after a refused field',
      {
        type: 'adapted',
        adaptation: {
          provider: 'api',
          setting: 'structuredOutput',
          from: 'json',
          to: 'prompt',
          cause: 'format-refused',
        },
      },
      'api: structuredOutput moved to prompt for the rest of the review: the server refused the request\'s JSON mode; set structuredOutput to choose it yourself',
    ],
    [
      'a lowering the server refused',
      {
        type: 'adapted',
        adaptation: {
          provider: 'api',
          setting: 'thinking',
          from: 'low',
          to: 'default',
          cause: 'lowering-refused',
        },
      },
      'api: the server refused thinking lowered to low: thinking stays as the server sets it for the rest of the review; set thinking to choose it yourself',
    ],
  ])('writes an adapted event as %s, one inert line whatever the view', (_name, event, line) => {
    expect(renderEvent(event)).toBe(line)
    expect(renderEvent(event, true, 'public')).toBe(line)
    const hostile = {
      ...event,
      adaptation: { ...(event as Extract<QuorumEvent, { type: 'adapted' }>).adaptation, provider: `a${RLO}b` },
    } as QuorumEvent
    expect(renderEvent(hostile, true, 'public')).toBe(line.replace('api:', 'a<U+202E>b:'))
  })

  const recoveredEvent = (fields: Partial<Extract<QuorumEvent, { type: 'recovered' }>>): QuorumEvent => ({
    type: 'recovered',
    profile: 'security',
    part: 7,
    parts: 44,
    noAnswer: 'reply',
    limit: 21_024,
    thinkingLowered: false,
    pieces: 4,
    read: 4,
    unreadHunks: 0,
    unreadFiles: 0,
    ...fields,
  })

  it.each<[string, QuorumEvent, string]>([
    [
      'a cut-off part whose pieces were all read',
      recoveredEvent({}),
      'part 7 of 44: reply cut off at its limit of 21024 tokens (reply): split into 4 pieces, all read',
    ],
    [
      'a cut-off part with no known limit, whose floor left hunks unread',
      recoveredEvent({
        noAnswer: 'thinking',
        limit: undefined,
        pieces: 8,
        read: 6,
        unreadHunks: 2,
        unreadFiles: 1,
      }),
      'part 7 of 44: reply cut off at its limit (thinking): split into 8 pieces; 2 hunk(s) of 1 file(s) left unread, cut off even alone: raise maxTokens, set thinking: low, or lower partTokens',
    ],
    [
      'a part cut off at the server\'s window, with a piece that failed',
      recoveredEvent({
        noAnswer: 'window',
        limit: undefined,
        pieces: 2,
        read: 1,
      }),
      'part 7 of 44: reply cut off at the server\'s window (window): split into 2 pieces; 1 not read, see the gaps',
    ],
    [
      'a saturated part',
      recoveredEvent({
        part: 9,
        noAnswer: 'saturated',
        limit: undefined,
        findings: 15,
        pieces: 2,
        read: 2,
      }),
      'part 9 of 44: its reply listed the 15 findings it was asked for at most: split into 2 pieces, all read',
    ],
  ])('writes a recovered event as %s, one inert line, prefixed with its profile when several run', (_name, event, line) => {
    expect(renderEvent(event)).toBe(line)
    expect(renderEvent(event, true)).toBe(`[security] ${line}`)
    expect(renderEvent(event, true, 'public')).toBe(`[security] ${line}`)
    expect(renderEvent({ ...event, profile: `a${RLO}b` } as QuorumEvent, true)).toBe(`[a<U+202E>b] ${line}`)
  })

  it('renders a flag with where it points', () => {
    expect(renderEvent({
      type: 'flag',
      flag: {
        code: 'hidden-characters',
        file: 'src/a.js',
        line: 3,
        detail: 'U+202E on 1 added line(s)',
      },
    })).toBe('flag: hidden-characters at "src/a.js":3 (U+202E on 1 added line(s))')
    expect(renderEvent({
      type: 'flag',
      flag: { code: 'hidden-characters', file: `src/${RLO}gnp.js`, detail: 'the file name holds U+202E' },
    })).toBe('flag: hidden-characters at "src/<U+202E>gnp.js" (the file name holds U+202E)')
    expect(renderEvent({
      type: 'flag',
      flag: { code: 'ai-addressed-text', line: 2, detail: 'a tool-call tag on 1 added line(s)' },
    })).toBe('flag: ai-addressed-text at line 2 (a tool-call tag on 1 added line(s))')
    expect(renderEvent({
      type: 'flag',
      flag: { code: 'hidden-characters', file: 'a\nb.js', detail: 'the file name holds U+000A' },
    })).toBe('flag: hidden-characters at "a\\nb.js" (the file name holds U+000A)')
  })

  it('renders the files left out in one line: five at most, each a JSON string with its reason, the empty name as <no path>, inert, never prefixed', () => {
    const file = (name: string, reason: 'excluded' | 'binary' | 'submodule' = 'binary'): LeftOutFile => ({ file: name, reason })
    expect(renderEvent({
      type: 'left-out',
      files: [
        file('a.png'),
        file(''),
        file('vendor/lib', 'submodule'),
      ],
    }))
      .toBe('left out: 3 file(s): "a.png" (binary), <no path> (binary), "vendor/lib" (submodule)')
    expect(renderEvent({
      type: 'left-out',
      files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => file(`${name}.png`)),
    }))
      .toBe('left out: 7 file(s): "a.png" (binary), "b.png" (binary), "c.png" (binary), "d.png" (binary), "e.png" (binary) and 2 more')
    expect(renderEvent({
      type: 'left-out',
      files: [
        file(`x${String.fromCharCode(0x202E)}\n.png`),
      ],
    }, true))
      .toBe('left out: 1 file(s): "x<U+202E>\\n.png" (binary)')
  })

  it('writes a skipped file with its rule on the left out line', () => {
    expect(renderEvent({
      type: 'left-out',
      files: [
        { file: 'go.sum', reason: 'skipped', rule: 'lockfile' },
        { file: 'img.png', reason: 'binary' },
      ],
    }))
      .toBe('left out: 2 file(s): "go.sum" (skipped: lockfile), "img.png" (binary)')
    expect(renderEvent({
      type: 'left-out',
      files: [
        { file: `.env${String.fromCharCode(0x202E)}\n`, reason: 'skipped', rule: 'secret' },
      ],
    }))
      .toBe('left out: 1 file(s): ".env<U+202E>\\n" (skipped: secret)')
  })

  it('writes a held file with its reason and rule on the left out line', () => {
    expect(renderEvent({
      type: 'left-out',
      files: [
        { file: '.env', reason: 'secret', rule: 'name' },
        { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
      ],
    }))
      .toBe('left out: 2 file(s): ".env" (secret: name), "old/.env" (deleted-secret: name)')
    expect(renderEvent({
      type: 'left-out',
      files: [
        { file: '', reason: 'secret', rule: 'aws-key' },
      ],
    }))
      .toBe('left out: 1 file(s): <no path> (secret: aws-key)')
  })

  it('renders the text a line carries inert', () => {
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'a\u001B[2J.js:1 is not in the diff' })).toBe('invalid finding dropped: a<U+001B>[2J.js:1 is not in the diff')
    expect(renderEvent({
      type: 'incomplete',
      entry: {
        profile: 'security',
        reason: 'vote-failed',
        file: `a${RLO}.js`,
        detail: `"a${RLO}.js":1 is kept at medium, but 1 failed vote(s) could have made it high`,
      },
    })).toBe('incomplete: vote-failed ("a<U+202E>.js":1 is kept at medium, but 1 failed vote(s) could have made it high)')
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'finding-unreadable', detail: 'findings[0]: x\n::error::y' },
    })).toBe('incomplete: finding-unreadable (findings[0]: x<U+000A>::error::y)')
  })

  it('writes a gap with no detail and a dropped finding with no reason in the public view, and every other line as the full view does', () => {
    const detail = 'DETAIL-CANARY'
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'binary', detail },
    }, false, 'public')).toBe('incomplete: binary')
    expect(renderEvent({
      type: 'incomplete',
      entry: {
        profile: 'security',
        reason: 'vote-failed',
        file: 'a.js',
        detail,
      },
    }, false, 'public')).toBe('incomplete: vote-failed at "a.js"')
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'REASON-CANARY.js:1 is not in the diff' }, false, 'public')).toBe('invalid finding dropped')
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'binary', detail },
    }, true, 'public')).toBe('[security] incomplete: binary')
    expect(renderEvent({ type: 'finding:invalid', profile: 'team', reason: 'x' }, true, 'public')).toBe('[team] invalid finding dropped')

    const same: QuorumEvent[] = [
      {
        type: 'left-out',
        files: [
          { file: '.env', reason: 'secret', rule: 'name' },
          { file: 'a.png', reason: 'binary' },
        ],
      },
      {
        type: 'flag',
        flag: {
          code: 'hidden-characters',
          file: 'src/a.js',
          line: 3,
          detail: 'U+202E on 1 added line(s)',
        },
      },
      {
        type: 'run:end',
        kept: 1,
        discarded: 2,
        unreviewed: 3,
        incomplete: 0,
        durationMs: 5,
      },
      {
        type: 'stage:end',
        profile: 'team',
        stage: 'dedup',
        durationMs: 1,
        count: 2,
      },
    ]
    for (const event of same) expect(renderEvent(event, true, 'public')).toBe(renderEvent(event, true, 'full'))

    const lines: string[] = []
    const sink = progressSink(line => lines.push(line), 'public')
    sink({
      type: 'run:start',
      profiles: ['security'],
      providers: {},
    })
    sink({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'binary', detail },
    })
    expect(lines).toEqual(['incomplete: binary'])
  })

  it('prints nothing for the other events', () => {
    expect(renderEvent({
      type: 'stage:end',
      profile: 'security',
      stage: 'research',
      durationMs: 1,
      count: 2,
    })).toBeUndefined()
    expect(renderEvent({ type: 'stage:start', profile: 'security', stage: 'panel' })).toBeUndefined()
    expect(renderEvent({
      type: 'vote',
      profile: 'security',
      findingId: 'f',
      lens: 'impact',
      keep: null,
      error: 'endpoint down',
    })).toBeUndefined()
    expect(renderEvent({
      type: 'verdict',
      profile: 'security',
      findingId: 'f',
      keptVotes: 3,
      totalVotes: 3,
      confidence: 'high',
      status: 'kept',
    })).toBeUndefined()
  })

  it('prefixes a profile\'s lines, and never the flag or totals lines', () => {
    expect(renderEvent({
      type: 'stage:end',
      profile: 'team',
      stage: 'dedup',
      durationMs: 1,
      count: 2,
    }, true)).toBe('[team] 2 candidate(s) after dedup')
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'missing.js:1 is not in the diff' }, true)).toBe('[security] invalid finding dropped: missing.js:1 is not in the diff')
    expect(renderEvent({
      type: 'incomplete',
      entry: { profile: 'security', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' },
    }, true)).toBe('[security] incomplete: research-unusable (1 finding(s) reported, none usable)')
    expect(renderEvent({
      type: 'flag',
      flag: {
        code: 'hidden-characters',
        file: 'src/a.js',
        line: 3,
        detail: 'U+202E on 1 added line(s)',
      },
    }, true)).toBe('flag: hidden-characters at "src/a.js":3 (U+202E on 1 added line(s))')
    expect(renderEvent({
      type: 'run:end',
      kept: 1,
      discarded: 2,
      unreviewed: 3,
      incomplete: 0,
      durationMs: 5,
    }, true)).toBe('1 kept, 2 discarded, 3 unreviewed by panel')
  })
})

describe('estimateLines', () => {
  const estimate: Estimate = {
    profiles: {
      security: {
        parts: [30_000, 20_000],
        votes: 150,
        vote: { reachability: 4000, impact: 4000, defenses: 4000 },
        expected: 16_667,
        worst: 1_850_000,
        findings: 50,
        provider: 'api',
      },
    },
    expected: 16_667,
    worst: 1_850_000,
    inFlight: 50_000,
    maxFindings: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
  }
  const total = 'estimate: research about 16667 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once; the review\'s token cap is 2000000 and its deadline 1800000 ms'

  it('writes the estimate\'s lines, a profile\'s prefixed when several run', () => {
    expect(estimateLines(estimate)).toEqual([
      'estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      total,
    ])
    const team = {
      parts: [8000],
      votes: 100,
      vote: { naming: 3000, layout: 3000 },
      expected: 2667,
      worst: 608_000,
      findings: 50,
      provider: 'api',
    }
    expect(estimateLines({
      ...estimate,
      profiles: { security: estimate.profiles.security, team },
    })).toEqual([
      '[security] estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      '[team] estimate: 1 research part(s), about 2667 tokens expected for them; then up to 100 vote(s), at most 608000 tokens in all',
      total,
    ])
    // A profile's id is a caller's text: it is shown inert.
    const [first] = estimateLines({
      ...estimate,
      profiles: { [`a${RLO}b`]: estimate.profiles.security, team },
    })
    expect(first).toBe('[a<U+202E>b] estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all')
  })

  it('writes the cap line when research expects over half the cap, with the cap the review needs', () => {
    // Expected 1000001 of a cap of 2000000 is over half; the review needs expected and inFlight, and every vote at a third of its bound: 150 votes of 4000 each, 200000, so 1250001 rounded up to 1300000.
    const heavy: Estimate = {
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
    }
    const lines = estimateLines(heavy)
    expect(lines).toEqual([
      'estimate: 2 research part(s), about 16667 tokens expected for them; then up to 150 vote(s), at most 1850000 tokens in all',
      'estimate: research about 1000001 tokens expected, at most 1850000 with every vote and every part recovered, 50000 of them reserved at once; the review\'s token cap is 2000000 and its deadline 1800000 ms',
      'estimate: research alone expects about 1000001 of the review\'s token cap of 2000000 (50%): a review of this size needs a cap of about 1300000: raise maxReviewTokens, or narrow the path',
    ])
    // Half the cap is not over half: no line. The need rounds up to the next 100000, and an exact multiple stays.
    expect(estimateLines({ ...estimate, expected: 1_000_000 })).toHaveLength(2)
    expect(estimateLines({ ...estimate, expected: 1_000_000 - 1 })).toHaveLength(2)
    const vote = {
      ...estimate.profiles.security,
      vote: { only: 3000 },
    }
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 49_999,
      profiles: { security: vote },
    })[2]).toContain('needs a cap of about 1100000')
    expect(estimateLines({
      ...estimate,
      expected: 1_000_001,
      inFlight: 50_000,
      profiles: { security: vote },
    })[2]).toContain('needs a cap of about 1200000')
    // Several profiles: every one's votes count, and the line is never prefixed.
    const two = estimateLines({
      ...heavy,
      profiles: {
        security: estimate.profiles.security,
        team: { ...estimate.profiles.security },
      },
    })
    expect(two.at(-1)).toBe('estimate: research alone expects about 1000001 of the review\'s token cap of 2000000 (50%): a review of this size needs a cap of about 1500000: raise maxReviewTokens, or narrow the path')
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
    }).slice(3)).toEqual([
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
    }).slice(4)).toEqual([
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
    }).slice(3)).toEqual([
      line('x<U+202E>y', 7),
    ])
  })
})

describe('progressSink', () => {
  const dedup: QuorumEvent = {
    type: 'stage:end',
    profile: 'team',
    stage: 'dedup',
    durationMs: 1,
    count: 2,
  }
  const started = (profiles: string[]): QuorumEvent => ({
    type: 'run:start',
    profiles,
    providers: Object.fromEntries(profiles.map(id => [
      id,
      {
        research: { id: 'default', model: 'm' },
        lenses: {},
      },
    ])),
  })

  it('learns from run:start whether to prefix, and writes only the lines it renders', () => {
    const lines: string[] = []
    const sink = progressSink(line => lines.push(line))
    sink(started(['security', 'team']))
    sink(dedup)
    sink({
      type: 'vote',
      profile: 'team',
      findingId: 'f',
      lens: 'impact',
      keep: null,
      error: 'endpoint down',
    })
    expect(lines).toEqual(['[team] 2 candidate(s) after dedup'])

    const single: string[] = []
    const alone = progressSink(line => single.push(line))
    alone(started(['team']))
    alone(dedup)
    expect(single).toEqual(['2 candidate(s) after dedup'])
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
      expect(providerOrigin(mistral)).toBe('https://api.mistral.ai')
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
