import { describe, expect, it } from 'vitest'
import { HIDDEN_CLASS } from '../../core/sanitize.ts'
import type { LeftOutFile, Position, QuorumEvent } from '../../core/types.ts'
import { longReview, replay } from '../../testing/events.ts'
import { durationWords, elapsedWords, heartbeatLine, logLines, renderEvent } from './lines.ts'
import { DEFAULT_FACTS, fold, startState } from './model.ts'
import type { ViewState } from './model.ts'

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

  it('writes a used-up quota\'s provider-down as its line, and as the call failed under the public view', () => {
    const event: QuorumEvent = {
      type: 'provider-down',
      provider: 'api',
      kind: 'http',
      status: 429,
      calls: 1,
      exhausted: true,
    }
    expect(renderEvent(event)).toBe('api: the account\'s credit, quota or spend limit is used up (http 429): no more calls go to it in this review: add credit or raise the limit at the provider, or wait until it resets')
    expect(renderEvent(event, false, 'public')).toBe('api: the call failed (http 429)')
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

  it('writes a stored-refused event as one fixed line, whatever the view and the provider\'s name', () => {
    const line = '--state: a stored reply failed its check: the call is made again'
    for (const role of ['research', 'vote'] as const) {
      const event: QuorumEvent = { type: 'stored-refused', provider: `a${RLO}b`, role }
      expect(renderEvent(event)).toBe(line)
      expect(renderEvent(event, true, 'public')).toBe(line)
    }
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

const API = { id: 'api', model: 'model' }

function started(profiles: string[]): QuorumEvent {
  return {
    type: 'run:start',
    profiles,
    providers: Object.fromEntries(profiles.map(id => [
      id,
      {
        research: API,
        lenses: { impact: API },
      },
    ])),
  }
}

/** The state after `events`, each folded at the time given with it. */
function folded(...events: Array<[number, QuorumEvent]>): ViewState {
  return events.reduce((state, [at, event]) => fold(state, event, at), startState(DEFAULT_FACTS))
}

function partEvent(over: Partial<Extract<QuorumEvent, { type: 'part' }>> = {}): QuorumEvent {
  return {
    type: 'part',
    profile: 'security',
    part: { index: 7, count: 44 },
    outcome: 'reviewed',
    durationMs: 4300,
    spent: 41_200,
    listed: 2,
    ...over,
  }
}

function callStart(call: number, over: Partial<Extract<QuorumEvent, { type: 'call:start' }>> = {}): QuorumEvent {
  return {
    type: 'call:start',
    call,
    profile: 'security',
    role: 'research',
    provider: API,
    part: { index: 7, count: 44 },
    reserved: 60_000,
    timeoutMs: 600_000,
    ...over,
  }
}

function retryEvent(over: Partial<Extract<QuorumEvent, { type: 'call:retry' }>> = {}): QuorumEvent {
  return {
    type: 'call:retry',
    call: 1,
    attempt: 1,
    retries: 2,
    failure: { kind: 'http', status: 503 },
    waitMs: 3600,
    ...over,
  }
}

/** The text of each line `logLines` writes for `event`, folded last. */
function textsOf(event: QuorumEvent, before: Array<[number, QuorumEvent]> = [
  [
    0,
    started(['security']),
  ],
], view: 'full' | 'public' = 'full'): string[] {
  const state = folded(...before, [1000, event])
  return logLines(event, state, view).map(line => line.text)
}

describe('logLines', () => {
  it.each<[string, QuorumEvent, 'full' | 'public', string]>([
    [
      'answered',
      partEvent(),
      'full',
      'part 7 of 44: answered in 4.3s, 41200 tokens, 2 finding(s) listed',
    ],
    [
      'answered, under the public view',
      partEvent(),
      'public',
      'part 7 of 44: answered in 4.3s',
    ],
    [
      'failed (timeout)',
      partEvent({
        outcome: 'research-failed',
        failure: { kind: 'timeout' },
      }),
      'full',
      'part 7 of 44: failed (timeout): its files are a research-failed gap',
    ],
    [
      'failed (http 503)',
      partEvent({
        outcome: 'research-failed',
        failure: { kind: 'http', status: 503 },
      }),
      'full',
      'part 7 of 44: failed (http 503): its files are a research-failed gap',
    ],
    [
      'whose reply could not be read',
      partEvent({ outcome: 'research-failed' }),
      'full',
      'part 7 of 44: its reply could not be read: its files are a research-failed gap',
    ],
    [
      'stopped by the token cap',
      partEvent({ outcome: 'token-cap' }),
      'full',
      'part 7 of 44: stopped by the token cap',
    ],
    [
      'stopped by the deadline',
      partEvent({ outcome: 'review-deadline' }),
      'full',
      'part 7 of 44: stopped by the deadline',
    ],
    [
      'not sent: provider-down',
      partEvent({ outcome: 'provider-down' }),
      'full',
      'part 7 of 44: not sent: provider-down',
    ],
    [
      'not sent: too large for its model',
      partEvent({ outcome: 'request-too-large' }),
      'full',
      'part 7 of 44: not sent: too large for its model',
    ],
    [
      'cut off at its limit even alone',
      partEvent({ outcome: 'reply-cut-off' }),
      'full',
      'part 7 of 44: cut off at its limit even alone: its hunks are a reply-cut-off gap',
    ],
    [
      'answered in 2 pieces, all read',
      partEvent({
        pieces: { count: 2, read: 2, unread: {} },
      }),
      'full',
      'part 7 of 44: answered in 4.3s, 41200 tokens, 2 finding(s) listed, in 2 pieces',
    ],
    [
      'answered in 2 pieces, under the public view',
      partEvent({
        pieces: { count: 2, read: 2, unread: {} },
      }),
      'public',
      'part 7 of 44: answered in 4.3s, in 2 pieces',
    ],
    [
      'split into 4 pieces, 3 read, 1 cut off even alone',
      partEvent({
        outcome: 'reply-cut-off',
        pieces: {
          count: 4,
          read: 3,
          unread: { 'reply-cut-off': 1 },
        },
      }),
      'full',
      'part 7 of 44: split into 4 pieces, 3 read, 1 cut off even alone',
    ],
    [
      'split into 4 pieces, 2 read, 1 failed, 1 cut off even alone',
      partEvent({
        outcome: 'research-failed',
        pieces: {
          count: 4,
          read: 2,
          unread: { 'reply-cut-off': 1, 'research-failed': 1 },
        },
      }),
      'full',
      'part 7 of 44: split into 4 pieces, 2 read, 1 failed, 1 cut off even alone',
    ],
  ])('writes a part %s as its line', (_name, event, view, text) => {
    expect(textsOf(event, undefined, view)).toEqual([text])
  })

  it.each<[string, Partial<Extract<QuorumEvent, { type: 'call:retry' }>>, number | undefined, Position, string]>([
    [
      'http 503',
      {},
      undefined,
      { index: 7, count: 44 },
      'part 7 of 44: http 503, retry 1 of 2 in 4s',
    ],
    [
      'network',
      {
        failure: { kind: 'network' },
        attempt: 2,
      },
      undefined,
      { index: 7, count: 44 },
      'part 7 of 44: network, retry 2 of 2 in 4s',
    ],
    [
      'a timeout',
      {
        failure: { kind: 'timeout' },
        waitMs: 1000,
      },
      undefined,
      { index: 7, count: 44 },
      'part 7 of 44: timeout after 600000 ms, retry 1 of 2 in 1s',
    ],
    [
      'a piece',
      {},
      undefined,
      {
        index: 7,
        count: 44,
        piece: { index: 3, count: 4 },
      },
      'part 7 of 44, piece 3 of 4: http 503, retry 1 of 2 in 4s',
    ],
  ])('writes a research retry of %s', (_name, over, _unused, part, text) => {
    expect(textsOf(retryEvent(over), [
      [
        0,
        started(['security']),
      ],
      [
        10,
        callStart(1, { part }),
      ],
    ])).toEqual([text])
  })

  it('writes no line for a vote\'s retry', () => {
    const vote = callStart(1, {
      role: 'vote',
      lens: 'impact',
      finding: 'abc',
      part: undefined,
    })
    expect(textsOf(retryEvent(), [
      [
        0,
        started(['security']),
      ],
      [10, vote],
    ])).toEqual([])
    expect(textsOf(retryEvent({ call: 9 }), [
      [
        0,
        started(['security']),
      ],
      [10, vote],
    ])).toEqual([])
  })

  it('writes the deadline\'s stopping line with the review\'s deadline', () => {
    const event: QuorumEvent = { type: 'run:stopping', cause: 'review-deadline', inFlight: 3 }
    expect(textsOf(event)).toEqual(['stopping: the review reached its deadline of 1800000 ms: the calls in flight are stopped, and what is left is a review-deadline gap'])
    const state = fold(startState({ ...DEFAULT_FACTS, deadlineMs: 90_000 }), started(['a', 'b']), 0)
    expect(logLines(event, fold(state, event, 5), 'full')).toEqual([
      { text: 'stopping: the review reached its deadline of 90000 ms: the calls in flight are stopped, and what is left is a review-deadline gap' },
    ])
  })

  it('glyphs each line by what it says', () => {
    const glyphOf = (event: QuorumEvent, before?: Array<[number, QuorumEvent]>): string | undefined => {
      const state = folded(...before ?? [
        [
          0,
          started(['security']),
        ],
      ], [1000, event])
      const [line, ...rest] = logLines(event, state, 'full')
      expect(rest).toEqual([])
      expect(line).toBeDefined()
      return line.glyph
    }
    expect(glyphOf(partEvent())).toBe('answered')
    expect(glyphOf(partEvent({
      pieces: { count: 2, read: 2, unread: {} },
    }))).toBe('answered')
    expect(glyphOf(partEvent({ outcome: 'research-failed' }))).toBe('failed')
    expect(glyphOf(partEvent({ outcome: 'token-cap' }))).toBe('failed')
    expect(glyphOf({
      type: 'provider-down',
      provider: 'api',
      kind: 'http',
      status: 503,
      calls: 3,
    })).toBe('failed')
    expect(glyphOf({ type: 'stored-refused', provider: 'api', role: 'research' })).toBe('retry')
    expect(glyphOf(retryEvent(), [
      [
        0,
        started(['security']),
      ],
      [
        10,
        callStart(1),
      ],
    ])).toBe('retry')
    expect(glyphOf({
      type: 'adapted',
      adaptation: {
        provider: 'api',
        setting: 'thinking',
        from: 'high',
        to: 'low',
        cause: 'cut-off-thinking',
      },
    })).toBe('adapted')
    expect(glyphOf({
      type: 'reply-lacked',
      provider: 'api',
      kind: 'no-answer',
      noAnswer: 'thinking',
    })).toBe('adapted')
    expect(glyphOf({
      type: 'recovered',
      profile: 'security',
      part: 9,
      parts: 44,
      noAnswer: 'reply',
      thinkingLowered: false,
      pieces: 2,
      read: 2,
      unreadHunks: 0,
      unreadFiles: 0,
    })).toBe('adapted')
    expect(glyphOf({
      type: 'left-out',
      files: [
        { file: 'a.png', reason: 'binary' },
      ],
    })).toBeUndefined()
    expect(glyphOf({
      type: 'flag',
      flag: {
        code: 'hidden-characters',
        file: 'a.js',
        line: 1,
        detail: 'x',
      },
    })).toBeUndefined()
    expect(glyphOf({
      type: 'stage:end',
      profile: 'security',
      stage: 'dedup',
      durationMs: 1,
      count: 6,
    })).toBeUndefined()
    expect(glyphOf({
      type: 'run:end',
      kept: 1,
      discarded: 0,
      unreviewed: 0,
      incomplete: 0,
      durationMs: 5,
    })).toBeUndefined()
    expect(glyphOf({ type: 'run:stopping', cause: 'review-deadline', inFlight: 1 })).toBeUndefined()
  })

  it('prefixes a part\'s and a retry\'s line when several profiles run', () => {
    const several: Array<[number, QuorumEvent]> = [
      [
        0,
        started(['security', 'style']),
      ],
      [
        10,
        callStart(1, { profile: 'style' }),
      ],
    ]
    expect(textsOf(partEvent({ profile: 'style' }), several)).toEqual(['[style] part 7 of 44: answered in 4.3s, 41200 tokens, 2 finding(s) listed'])
    expect(textsOf(retryEvent(), several)).toEqual(['[style] part 7 of 44: http 503, retry 1 of 2 in 4s'])
    expect(textsOf({ type: 'run:stopping', cause: 'review-deadline', inFlight: 1 }, several)[0]).toMatch(/^stopping: /)
  })

  it('writes every field of a line inert, a hostile provider or profile id included', () => {
    const ESC = String.fromCharCode(0x1B)
    const hostile = `${ESC}x${ESC}[31m${ESC}]52;c;${String.fromCharCode(0x9B)}${String.fromCharCode(0x202E)}`
    const several: Array<[number, QuorumEvent]> = [
      [
        0,
        started([hostile, 'style']),
      ],
      [
        10,
        callStart(1, {
          profile: hostile,
          provider: { id: hostile, model: hostile },
        }),
      ],
    ]
    const lines = [
      ...textsOf(partEvent({ profile: hostile }), several),
      ...textsOf(partEvent({
        profile: hostile,
        outcome: 'research-failed',
        failure: { kind: 'http', status: 503 },
      }), several),
      ...textsOf(retryEvent(), several),
      ...textsOf({
        type: 'provider-down',
        provider: hostile,
        kind: 'http',
        status: 503,
        calls: 3,
      }, several),
      ...textsOf({
        type: 'provider-down',
        provider: hostile,
        kind: 'http',
        status: 429,
        calls: 1,
        exhausted: true,
      }, several, 'public'),
      ...textsOf({
        type: 'recovered',
        profile: hostile,
        part: 9,
        parts: 44,
        noAnswer: 'reply',
        thinkingLowered: false,
        pieces: 2,
        read: 2,
        unreadHunks: 0,
        unreadFiles: 0,
      }, several),
    ]
    expect(lines).toHaveLength(6)
    const hidden = new RegExp(`[${HIDDEN_CLASS}]`, 'u')
    for (const line of lines) {
      expect(line).toContain('<U+001B>')
      expect(line).toContain('<U+009B>')
      expect(line).toContain('<U+202E>')
      expect(line).not.toMatch(hidden)
    }
  })
})

describe('heartbeatLine', () => {
  /**
   * 19 of 44 parts answered, one retried, four in flight since 60 s, 812 000 tokens spent, at the tenth minute: parts
   * of 60 000 planned tokens answered in 120 to 170 s, so the 25th and 75th percentile rates are 2 and 2.6 ms a token
   * and the middle one 2.4, and 1 400 000 tokens are left over 4 calls at once.
   */
  function tenthMinute(): ViewState {
    const answered = [
      120,
      120,
      120,
      120,
      120,
      130,
      130,
      130,
      130,
      144,
      150,
      150,
      150,
      150,
      156,
      170,
      170,
      170,
      170,
    ]
    const events: Array<[number, QuorumEvent]> = [
      [
        0,
        started(['security']),
      ],
      [
        0,
        {
          type: 'stage:start',
          profile: 'security',
          stage: 'research',
          parts: 44,
        },
      ],
    ]
    answered.forEach((seconds, at) => {
      const index = at + 1
      const end = (170 + 22 * at) * 1000
      const spent = index === 19
        ? 43_400
        : 42_700
      events.push([
        end - seconds * 1000,
        callStart(index, {
          part: { index, count: 44 },
        }),
      ])
      if (index === 3) {
        events.push([
          end - 60_000,
          retryEvent({ call: index }),
        ])
      }
      events.push([
        end,
        {
          type: 'call',
          call: index,
          profile: 'security',
          role: 'research',
          provider: API,
          part: { index, count: 44 },
          durationMs: seconds * 1000,
          ok: true,
          usage: { inputTokens: spent - 100, outputTokens: 100 },
          spent,
          listed: 0,
        },
      ])
      events.push([
        end,
        partEvent({
          part: { index, count: 44 },
          durationMs: seconds * 1000,
          spent,
        }),
      ])
    })
    for (const index of [20, 21, 22, 23]) {
      events.push([
        540_000,
        callStart(index, {
          part: { index, count: 44 },
        }),
      ])
    }
    return folded(...events)
  }

  it('writes the heartbeat with the elapsed time, the parts, the calls in flight, the retried, the tokens and the time left', () => {
    const state = tenthMinute()
    expect(heartbeatLine(state, 600_000, 'full')).toBe('[10m00s] research 19 of 44 part(s), 4 call(s) in flight, 1 retried; 812000 of 2000000 tokens; about 12-16m left')
    expect(heartbeatLine(replay(longReview(), 120_000), 120_000, 'full')).toBe('[2m00s] research 0 of 44 part(s), 4 call(s) in flight, 0 retried; 0 of 2000000 tokens; estimating the time left')
    expect(heartbeatLine(state, 42_000, 'public')).toMatch(/^\[42s\] research 19 of 44 part\(s\), 4 call\(s\) in flight, 1 retried; about /)
    // The elapsed time counts whole seconds throughout, and a duration under 10 s keeps its decimal.
    expect([
      elapsedWords(4300),
      elapsedWords(3_729_000),
      elapsedWords(59_600),
    ]).toEqual(['4s', '1h02m09s', '1m00s'])
    expect([
      durationWords(4300),
      durationWords(42_400),
      durationWords(134_000),
      durationWords(9960),
      durationWords(-5),
    ]).toEqual(['4.3s', '42s', '2m14s', '10s', '0.0s'])
  })

  it('writes the panel\'s heartbeat, and no tokens under the public view', () => {
    const list = longReview()
    const at = 1_811_600 + 200_000
    const state = replay(list, at)
    // 8 votes cast in 85 to 100 s, 10 left: the 25th and 75th percentile durations are 85 and 95 s, over 4 at once.
    const full = heartbeatLine(state, at, 'full')
    expect(full).toBe('[33m32s] panel 8 of 18 vote(s), 4 call(s) in flight, 0 retried; 1439700 of 2000000 tokens; about 4m left')
    const secret = heartbeatLine(state, at, 'public')
    expect(secret).toBe(full.replace(/; \d+ of 2000000 tokens/, ''))
    expect(secret).not.toContain('tokens')
  })
})
