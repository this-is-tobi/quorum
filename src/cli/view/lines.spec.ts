import { describe, expect, it } from 'vitest'
import { HIDDEN_CLASS, inertLine } from '../../core/sanitize.ts'
import type { ContextDocument, Estimate, LeftOutFile, Position, QuorumEvent } from '../../core/types.ts'
import { durationText } from '../../report/lines.ts'
import { resolvedConfig } from '../../testing/bench.ts'
import { longReview, replay, slowResearch } from '../../testing/events.ts'
import { contextDocument } from '../../testing/report.ts'
import { viewFacts } from '../render.ts'
import { elapsedWords, heartbeatLine, logLines, renderEvent, STATE_NOTICE_MS } from './lines.ts'
import { DEFAULT_FACTS, fold, startState } from './model.ts'
import type { ViewFacts, ViewState } from './model.ts'

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

  it('writes a provider-down event of calls cut on the way with the cut fix, and names its length', () => {
    expect(renderEvent({
      type: 'provider-down',
      provider: 'finder',
      kind: 'network',
      calls: 3,
      cutAfterMs: 600_000,
    })).toBe('finder: 3 calls in a row failed (network): no more calls go to it in this review: each call was cut after about 10m00s, likely by a proxy or load balancer on the way: make replies shorter, with a lower maxTokens or partTokens')
  })

  it('writes a provider-down event of calls that each stalled with the stall fix', () => {
    expect(renderEvent({
      type: 'provider-down',
      provider: 'finder',
      kind: 'timeout',
      calls: 3,
      stalledMs: 300_000,
    })).toBe('finder: 3 calls in a row failed (timeout): no more calls go to it in this review: raise stallTimeoutMs, or timeoutMs')
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
    [
      'a stream moved to a bare stream after the server refused its options',
      {
        type: 'adapted',
        adaptation: {
          provider: 'api',
          setting: 'stream',
          from: 'stream',
          to: 'bare',
          cause: 'stream-refused',
        },
      },
      'api: its calls stream without stream_options for the rest of the review: the server refused the field, so each call settles at its reservation',
    ],
    [
      'a stream moved to whole replies after the server refused streaming',
      {
        type: 'adapted',
        adaptation: {
          provider: 'api',
          setting: 'stream',
          from: 'bare',
          to: 'whole',
          cause: 'stream-refused',
        },
      },
      'api: its calls ask for whole replies for the rest of the review: the server refused streaming; set stream: false to choose it yourself',
    ],
    [
      'a stream moved to whole replies after the server answered a streamed call whole',
      {
        type: 'adapted',
        adaptation: {
          provider: 'api',
          setting: 'stream',
          from: 'stream',
          to: 'whole',
          cause: 'stream-answered-whole',
        },
      },
      'api: its calls ask for whole replies for the rest of the review: the server answered a streamed call whole; set stream: false to choose it yourself',
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

  it('writes a lane\'s cut as a line with the limit it came from and the throttle, and the slots it holds, whatever the view', () => {
    const cut: QuorumEvent = {
      type: 'concurrency',
      provider: { id: 'api', model: 'model' },
      limit: 2,
      cause: 'cut',
      from: 4,
      failure: { kind: 'http', status: 429 },
    }
    for (const view of ['full', 'public'] as const) {
      expect(renderEvent(cut, false, view)).toBe('api: 2 call(s) at once for now, cut from 4 after http 429')
      expect(renderEvent({
        ...cut,
        failure: { kind: 'timeout', stalledMs: 300_000 },
      }, false, view)).toBe('api: 2 call(s) at once for now, cut from 4 after timeout')
      expect(renderEvent({
        type: 'concurrency',
        provider: { id: 'api', model: 'model' },
        limit: 3,
        cause: 'slots',
      }, false, view)).toBe('api: the server serves 3 calls at once: its lane holds 3')
    }
    // a lane belongs to no profile, so no prefix; its id is made inert
    expect(renderEvent({
      ...cut,
      provider: { id: `a${RLO}b`, model: 'model' },
    }, true)).toBe('a<U+202E>b: 2 call(s) at once for now, cut from 4 after http 429')
    // the changes a block shows and no line tells
    for (const cause of ['grown', 'regrown', 'paused', 'paced'] as const) {
      expect(renderEvent({
        ...cut,
        cause,
        limit: 5,
        waitMs: 14_000,
      })).toBeUndefined()
    }
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

  it.each<[string, QuorumEvent, string, string]>([
    [
      'lowered: the replies are held to what the cut holds',
      {
        type: 'cut',
        provider: 'api',
        afterMs: 900_000,
        holds: 36_000,
        lowered: true,
      },
      'api: its calls are cut after about 15m00s on the way: a call cut so is read as a reply cut off at its limit, and its replies are held to 36000 tokens for the rest of the review',
      'api: its calls are cut after about 15m00s on the way: a call cut so is read as a reply cut off at its limit',
    ],
    [
      'with every budget already under the cut: nothing moved, no advice',
      {
        type: 'cut',
        provider: 'api',
        afterMs: 900_000,
        holds: 36_000,
        lowered: false,
        fits: true,
      },
      'api: its calls are cut after about 15m00s on the way: a call cut so is read as a reply cut off at its limit',
      'api: its calls are cut after about 15m00s on the way: a call cut so is read as a reply cut off at its limit',
    ],
    [
      'with maxTokens set: the value to lower it to',
      {
        type: 'cut',
        provider: 'api',
        afterMs: 900_000,
        holds: 36_000,
        lowered: false,
      },
      'api: its calls are cut after about 15m00s on the way: a call cut so is read as a reply cut off at its limit; lower maxTokens to about 36000 to keep each call under it',
      'api: its calls are cut after about 15m00s on the way: a call cut so is read as a reply cut off at its limit',
    ],
    [
      'with no rate measured: the advice',
      {
        type: 'cut',
        provider: 'api',
        afterMs: 600_150,
        lowered: false,
      },
      'api: its calls are cut after about 10m00s on the way: a call cut so is read as a reply cut off at its limit; make replies shorter, with a lower maxTokens or partTokens',
      'api: its calls are cut after about 10m00s on the way: a call cut so is read as a reply cut off at its limit',
    ],
  ])('writes a cut event %s, the public view leaving out the token counts', (_name, event, full, publicLine) => {
    expect(renderEvent(event)).toBe(full)
    expect(renderEvent(event, true)).toBe(full)
    expect(renderEvent(event, true, 'public')).toBe(publicLine)
    expect(renderEvent({ ...event, provider: `a${RLO}b` } as QuorumEvent, true, 'public')).toBe(publicLine.replace('api:', 'a<U+202E>b:'))
  })

  it('writes no line of its own for the reply budget a cut lowered: the cut\'s line says it', () => {
    expect(renderEvent({
      type: 'adapted',
      adaptation: {
        provider: 'api',
        setting: 'replyTokens',
        from: 'derived',
        to: '36000',
        cause: 'cut-on-the-way',
      },
    })).toBeUndefined()
  })

  it('writes a part split for a cut on the way with the length of the cut in place of a limit', () => {
    const event = recoveredEvent({
      part: 9,
      noAnswer: 'thinking',
      limit: undefined,
      cutAfterMs: 900_000,
      pieces: 2,
      read: 2,
    })
    expect(renderEvent(event)).toBe('part 9 of 44: reply cut on the way after about 15m00s (thinking): split into 2 pieces, all read')
    expect(renderEvent(recoveredEvent({
      part: 9,
      noAnswer: 'reply',
      limit: undefined,
      cutAfterMs: 600_000,
      pieces: 2,
      read: 1,
    }))).toBe('part 9 of 44: reply cut on the way after about 10m00s (reply): split into 2 pieces; 1 not read, see the gaps')
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

  it('names a flag\'s profile', () => {
    expect(renderEvent({
      type: 'flag',
      flag: {
        code: 'guideline-edited',
        profile: 'security',
        file: 'REVIEW.md',
        detail: 'the guidelines this review read for the profile from 1f3a9c2, not the change\'s version',
      },
    })).toBe('flag: guideline-edited at "REVIEW.md" for security (the guidelines this review read for the profile from 1f3a9c2, not the change\'s version)')
    expect(renderEvent({
      type: 'flag',
      flag: { code: 'guideline-edited', profile: 'naming', detail: 'the rules this review read' },
    })).toBe('flag: guideline-edited for naming (the rules this review read)')
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

  /** A citation of a rule that failed its check, as the core says it. */
  const refused = (reason: string, profile = 'naming'): QuorumEvent => ({
    type: 'finding:invalid',
    profile,
    reason,
    cause: 'rule',
  })

  it.each<[string, QuorumEvent, boolean, 'full' | 'public', string]>([
    [
      'refused citation of a rule the review did not send, with its reason',
      refused('"src/a.ts":40 cites no rule this review sent'),
      false,
      'full',
      'rule citation refused: "src/a.ts":40 cites no rule this review sent',
    ],
    [
      'refused citation, with no reason under the public view',
      refused('"src/a.ts":40 cites no rule this review sent'),
      false,
      'public',
      'rule citation refused',
    ],
    [
      'refused citation of a profile that requires a rule, with its reason',
      refused('"src/a.ts":40 cites no rule, which the profile requires'),
      false,
      'full',
      'rule citation refused: "src/a.ts":40 cites no rule, which the profile requires',
    ],
    [
      'refused citation of a profile that requires a rule, with no reason under the public view',
      refused('"src/a.ts":40 cites no rule, which the profile requires'),
      false,
      'public',
      'rule citation refused',
    ],
    [
      'refused citation under its profile\'s prefix when several profiles run',
      refused('"src/a.ts":40 cites no rule this review sent'),
      true,
      'full',
      '[naming] rule citation refused: "src/a.ts":40 cites no rule this review sent',
    ],
    [
      'refused citation under its profile\'s prefix, with no reason under the public view',
      refused('"src/a.ts":40 cites no rule this review sent'),
      true,
      'public',
      '[naming] rule citation refused',
    ],
    [
      'dropped finding, which is no refused citation, as it always was',
      {
        type: 'finding:invalid',
        profile: 'naming',
        reason: 'missing.js:1 is not in the diff',
      },
      false,
      'full',
      'invalid finding dropped: missing.js:1 is not in the diff',
    ],
    [
      'refused citation whose reason holds a hostile file name, inert',
      refused(`"a${RLO}.js":40 cites no rule this review sent`),
      false,
      'full',
      'rule citation refused: "a<U+202E>.js":40 cites no rule this review sent',
    ],
  ])('writes a %s', (_name, event, prefixed, view, line) => {
    expect(renderEvent(event, prefixed, view)).toBe(line)
  })

  /** A finding a changed-lines profile dropped for standing away from the change, as the core says it. */
  const away = (reason: string, profile = 'naming'): QuorumEvent => ({
    type: 'finding:invalid',
    profile,
    reason,
    cause: 'away',
  })
  const AWAY = '"a.js":1 is more than two lines from a line the change adds or removes'

  it.each<[string, 'full' | 'public', boolean, string]>([
    [
      `finding away from the change dropped: ${AWAY}`,
      'full',
      false,
      AWAY,
    ],
    [
      'finding away from the change dropped',
      'public',
      false,
      AWAY,
    ],
    [
      `[naming] finding away from the change dropped: ${AWAY}`,
      'full',
      true,
      AWAY,
    ],
    [
      '[naming] finding away from the change dropped',
      'public',
      true,
      AWAY,
    ],
    [
      'finding away from the change dropped: "a<U+202E>.js":1 is more than two lines from a line the change adds or removes',
      'full',
      false,
      `"a${RLO}.js":1 is more than two lines from a line the change adds or removes`,
    ],
  ])('writes a finding:invalid of the cause away as %j in the %s view', (line, view, prefixed, reason) => {
    expect(renderEvent(away(reason), prefixed, view)).toBe(line)
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
    attemptMs: 3000,
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
      'part 7 of 44: answered in 4.3s, 41.2k tokens, 2 finding(s) listed',
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
      'part 7 of 44: answered in 4.3s, 41.2k tokens, 2 finding(s) listed, in 2 pieces',
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

  it.each<[string, QuorumEvent, 'full' | 'public', string]>([
    [
      '',
      partEvent({
        part: { index: 2, count: 121 },
        durationMs: 0,
        spent: 0,
        listed: 3,
        reused: true,
      }),
      'full',
      'part 2 of 121: reused from the saved state, 3 finding(s) listed',
    ],
    [
      ', split',
      partEvent({
        part: { index: 2, count: 121 },
        durationMs: 0,
        spent: 0,
        listed: 3,
        reused: true,
        pieces: { count: 2, read: 2, unread: {} },
      }),
      'full',
      'part 2 of 121: reused from the saved state, 3 finding(s) listed, in 2 pieces',
    ],
    [
      'under the public view',
      partEvent({
        part: { index: 2, count: 121 },
        durationMs: 0,
        spent: 0,
        listed: 3,
        reused: true,
      }),
      'public',
      'part 2 of 121: reused from the saved state',
    ],
  ])('writes a part answered from the saved state %s', (_name, event, view, text) => {
    expect(textsOf(event, undefined, view)).toEqual([text])
  })

  it.each<[string, Partial<Extract<QuorumEvent, { type: 'call:retry' }>>, number | undefined, Position, string]>([
    [
      'http 503',
      {},
      undefined,
      { index: 7, count: 44 },
      'part 7 of 44: http 503 after 3.0s, retry 1 of 2 in 4s',
    ],
    [
      'network',
      {
        failure: { kind: 'network' },
        attempt: 2,
      },
      undefined,
      { index: 7, count: 44 },
      'part 7 of 44: network after 3.0s, retry 2 of 2 in 4s',
    ],
    [
      'a network failure after ten minutes',
      {
        failure: { kind: 'network' },
        attemptMs: 600_000,
        waitMs: 1500,
      },
      undefined,
      { index: 7, count: 51 },
      'part 7 of 51: network after 10m00s, retry 1 of 2 in 2s',
    ],
    [
      'a gateway timeout after ten minutes',
      {
        failure: { kind: 'http', status: 504 },
        attemptMs: 600_000,
        waitMs: 1500,
      },
      undefined,
      { index: 7, count: 51 },
      'part 7 of 51: http 504 after 10m00s, retry 1 of 2 in 2s',
    ],
    [
      'a 503 after a few seconds',
      {},
      undefined,
      { index: 7, count: 51 },
      'part 7 of 51: http 503 after 3.0s, retry 1 of 2 in 4s',
    ],
    [
      'a timeout',
      {
        failure: { kind: 'timeout' },
        attemptMs: 600_000,
        waitMs: 1000,
      },
      undefined,
      { index: 7, count: 44 },
      'part 7 of 44: timeout after 10m00s, retry 1 of 2 in 1s',
    ],
    [
      'a stall',
      {
        failure: { kind: 'timeout', stalledMs: 300_000 },
        attemptMs: 330_000,
        waitMs: 1500,
      },
      undefined,
      { index: 12, count: 44 },
      'part 12 of 44: stalled, no progress for 5m00s, retry 1 of 2 in 2s',
    ],
    [
      'a timeout at a ceiling that grew',
      {
        failure: { kind: 'timeout', ceilingMs: 10_512_000 },
        attemptMs: 10_512_000,
        waitMs: 1500,
      },
      undefined,
      { index: 12, count: 44 },
      'part 12 of 44: timeout after 2h55m12s, retry 1 of 2 in 2s',
    ],
    [
      'a reply of only reasoning',
      {
        failure: { kind: 'no-answer' },
        attemptMs: 250_000,
        waitMs: 250,
      },
      undefined,
      { index: 12, count: 44 },
      'part 12 of 44: its reply held only reasoning after 4m10s, retry 1 of 2 in 1s',
    ],
    [
      'an unreadable reply',
      {
        failure: { kind: 'unusable-reply' },
        attemptMs: 130_000,
        waitMs: 250,
      },
      undefined,
      { index: 117, count: 131 },
      'part 117 of 131: its reply could not be read after 2m10s, retry 1 of 2 in 1s',
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
      'part 7 of 44, piece 3 of 4: http 503 after 3.0s, retry 1 of 2 in 4s',
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
    expect(textsOf(event)).toEqual(['stopping: the review reached its deadline of 30m00s: the calls in flight are stopped, and what is left is a review-deadline gap'])
    const state = fold(startState({ ...DEFAULT_FACTS, deadlineMs: 90_000 }), started(['a', 'b']), 0)
    expect(logLines(event, fold(state, event, 5), 'full')).toEqual([
      { text: 'stopping: the review reached its deadline of 1m30s: the calls in flight are stopped, and what is left is a review-deadline gap' },
    ])
  })

  it('writes the interrupt\'s stopping line, and a part the interrupt stopped', () => {
    const event: QuorumEvent = {
      type: 'run:stopping',
      cause: 'interrupt',
      inFlight: 3,
      graceMs: 5000,
    }
    expect(textsOf(event)).toEqual(['stopping: no new calls; the 3 call(s) in flight have 5.0s to end; press Ctrl-C again to quit at once, without the result'])
    const state = fold(startState(DEFAULT_FACTS), started(['a', 'b']), 0)
    expect(logLines(event, fold(state, event, 5), 'full')).toEqual([
      { text: 'stopping: no new calls; the 3 call(s) in flight have 5.0s to end; press Ctrl-C again to quit at once, without the result' },
    ])
    expect(textsOf({ ...event, inFlight: 1, graceMs: 2500 })).toEqual(['stopping: no new calls; the 1 call(s) in flight have 2.5s to end; press Ctrl-C again to quit at once, without the result'])
    expect(textsOf(partEvent({ outcome: 'interrupted' }))).toEqual(['part 7 of 44: stopped by the interrupt'])
    expect(textsOf(partEvent({
      outcome: 'interrupted',
      pieces: {
        count: 4,
        read: 1,
        unread: { 'review-deadline': 1, interrupted: 2 },
      },
    }))).toEqual(['part 7 of 44: split into 4 pieces, 1 read, 1 stopped by the deadline, 2 stopped by the interrupt'])
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
      type: 'concurrency',
      provider: { id: 'api', model: 'model' },
      limit: 2,
      cause: 'cut',
      from: 4,
      failure: { kind: 'http', status: 429 },
    })).toBe('adapted')
    expect(glyphOf({
      type: 'concurrency',
      provider: { id: 'api', model: 'model' },
      limit: 3,
      cause: 'slots',
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
    expect(textsOf(partEvent({ profile: 'style' }), several)).toEqual(['[style] part 7 of 44: answered in 4.3s, 41.2k tokens, 2 finding(s) listed'])
    expect(textsOf(retryEvent(), several)).toEqual(['[style] part 7 of 44: http 503 after 3.0s, retry 1 of 2 in 4s'])
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

  it('writes one line per document of the context event, in the full and the public view', () => {
    const commit = '1f3a9c2'.padEnd(40, 'a')
    const event: QuorumEvent = {
      type: 'context',
      context: {
        documents: [
          contextDocument({
            origin: 'repository',
            path: 'docs/threat-model.md',
            commit,
            sha256: 'a'.repeat(64),
          }),
          contextDocument({
            profile: 'naming',
            origin: 'config',
            sha256: '3f2a9c1d0b7e'.padEnd(64, '0'),
            bytes: 4100,
            removed: { characters: 3, comments: 1, entities: 0 },
          }),
          contextDocument({
            profile: 'naming',
            kind: 'do-not-report',
            origin: 'repository',
            path: 'REVIEW-skip.md',
            commit,
            status: 'missing',
            bytes: 0,
          }),
        ],
      },
    }
    const lines = [
      'context: security guidelines "docs/threat-model.md" at 1f3a9c2, 1830 bytes',
      'context: naming guidelines from a file, sha256 3f2a9c1d0b7e, 4100 bytes; the cleaner removed 3 hidden character(s) and 1 comment(s)',
      'context: naming do-not-report text "REVIEW-skip.md" at 1f3a9c2: missing, and optional',
    ]
    for (const view of ['full', 'public'] as const) {
      expect(textsOf(event, undefined, view)).toEqual(lines)
    }
    // One line each, with no glyph, and no profile's prefix when several run: a line names its profile itself.
    const several: Array<[number, QuorumEvent]> = [
      [
        0,
        started(['security', 'naming']),
      ],
    ]
    expect(logLines(event, folded(...several, [1000, event]), 'full')).toEqual(lines.map(text => ({ text })))
    // Each line is inert: a path of a hostile name shows its hidden character.
    const hostile: QuorumEvent = {
      type: 'context',
      context: {
        documents: [
          contextDocument({
            origin: 'repository',
            path: `a${RLO}b.md`,
            commit,
          }),
        ],
      },
    }
    expect(textsOf(hostile)).toEqual(['context: security guidelines "a<U+202E>b.md" at 1f3a9c2, 1830 bytes'])
  })

  /** A `context` event holding the rules each profile lists and sends, and the documents given. */
  type ContextRules = Extract<QuorumEvent, { type: 'context' }>['rules']

  const rulesEvent = (rules: ContextRules, documents: ContextDocument[] = []): QuorumEvent => ({
    type: 'context',
    context: { documents },
    ...rules === undefined
      ? {}
      : { rules },
  })

  const NAMING_RULES = contextDocument({
    profile: 'naming',
    kind: 'rules',
    origin: 'config',
    bytes: 120,
    rules: 5,
  })

  it.each<[string, ContextRules, string[]]>([
    [
      'line for the rules a profile sent of those it lists',
      {
        naming: { listed: 5, sent: 3 },
      },
      ['context: naming rules: 3 of 5 sent'],
    ],
    [
      'line for a profile that sends none of its rules and still asks its research',
      {
        naming: { listed: 5, sent: 0 },
      },
      ['context: naming rules: 0 of 5 sent'],
    ],
    [
      'line for a profile that requires a rule and sends none, whose research asks nothing',
      {
        naming: { listed: 5, sent: 0, asksNothing: true },
      },
      ['context: naming rules: 0 of 5 sent, so its research asks nothing'],
    ],
    [
      'line for a profile that requires a rule and lists none, whose research asks nothing',
      {
        naming: { listed: 0, sent: 0, asksNothing: true },
      },
      ['context: naming rules: 0 of 0 sent, so its research asks nothing'],
    ],
    [
      'line for each profile that lists or requires a rule, in the order the event holds them, the one that asks nothing among them',
      {
        security: { listed: 2, sent: 2 },
        naming: { listed: 0, sent: 0, asksNothing: true },
      },
      [
        'context: security rules: 2 of 2 sent',
        'context: naming rules: 0 of 0 sent, so its research asks nothing',
      ],
    ],
  ])('writes a %s, after the documents of the event, in the full and the public view', (_name, rules, lines) => {
    const event = rulesEvent(rules, [NAMING_RULES])
    for (const view of ['full', 'public'] as const) {
      expect(textsOf(event, undefined, view)).toEqual([
        'context: naming rules written in the config, 5 rule(s)',
        ...lines,
      ])
    }
    // With no document, the rules' lines stand alone, and no profile's prefix starts one when several run: a line names its profile itself.
    const several: Array<[number, QuorumEvent]> = [
      [
        0,
        started(['security', 'naming']),
      ],
    ]
    expect(logLines(rulesEvent(rules), folded(...several, [
      1000,
      rulesEvent(rules),
    ]), 'full')).toEqual(lines.map(text => ({ text })))
  })

  it('writes no rules line for an event that holds no rules, and one for each document alone', () => {
    expect(textsOf(rulesEvent(undefined, [
      contextDocument(),
    ]))).toEqual(['context: security guidelines of the profile, 1830 bytes'])
    expect(textsOf(rulesEvent({}))).toEqual([])
  })
})

/** What `logLines` writes after each of the 30 `part` events' own line of `slowResearch(every)`, one call at once, under `facts`. The first estimate, at the third part, puts research's end at 30 times `every` from the start. */
function notesAtParts(facts: Partial<ViewFacts>, every = 300_000): string[][] {
  let state = startState({
    ...DEFAULT_FACTS,
    concurrency: 1,
    ...facts,
  })
  const notes: string[][] = []
  for (const { at, event } of slowResearch(every)) {
    state = fold(state, event, at)
    if (event.type === 'part') notes.push(logLines(event, state, 'full').slice(1).map(line => line.text))
  }
  return notes
}

describe('the notes of the first estimate', () => {
  const DEADLINE_WARNING = /^warning: the deadline of 30m00s \(reviewTimeoutMs\) comes before research ends, which this review's first estimate puts at \S+ from its start: the review stops at the deadline, and what is left is a review-deadline gap; raise reviewTimeoutMs, up to 24h00m00s$/
  const STATE_NOTICE = /^notice: this review's first estimate puts research's end at .+ from its start, and it keeps no answered call, so a part that fails costs a full rerun: pass --state <dir> to keep them$/
  // A path review's estimate: only its presence matters to the line.
  const ESTIMATE = {
    profiles: {},
    expected: 0,
    worst: 0,
    inFlight: 0,
    maxFindings: 50,
    findingsCap: 50,
    maxReviewTokens: 2_000_000,
    reviewTimeoutMs: 1_800_000,
    fits: true,
    held: 0,
  } satisfies Estimate

  it('warns once, at the first estimate, of a deadline the config sets before research ends', () => {
    const notes = notesAtParts({ deadlineMs: 1_800_000, deadline: 'config', keeps: true })
    expect(notes).toHaveLength(30)
    expect(notes.slice(0, 2)).toEqual([[], []])
    expect(notes[2]).toHaveLength(1)
    expect(notes[2][0]).toMatch(DEADLINE_WARNING)
    // Three parts of 5 minutes, then 27 more: research ends 150 minutes from the start.
    expect(notes[2][0]).toContain('first estimate puts at 150m from its start')
    expect(notes.slice(3).flat()).toEqual([])
  })

  it('names the default deadline of a diff review as the default', () => {
    const [warning] = notesAtParts({ deadlineMs: 1_800_000, deadline: 'default', keeps: true })[2]
    expect(warning).toMatch(/^warning: the deadline of 30m00s, the default comes before research ends, which this review's first estimate puts at 150m from its start: /)
    expect(warning).toMatch(/; raise reviewTimeoutMs, up to 24h00m00s$/)
  })

  it.each<[string, Partial<ViewFacts>, number | undefined]>([
    [
      'the deadline is the longest allowed',
      { deadlineMs: 1_800_000, deadline: 'longest' },
      undefined,
    ],
    [
      'research ends before it',
      { deadlineMs: 86_400_000, deadline: 'config' },
      undefined,
    ],
    [
      'research ends at it, not past it',
      { deadlineMs: 9_000_000, deadline: 'config' },
      undefined,
    ],
    [
      'the config sets the longest allowed, and research ends after it',
      { deadlineMs: 86_400_000, deadline: 'config' },
      3_600_000,
    ],
  ])('writes no deadline warning when %s', (_name, facts, every) => {
    expect(notesAtParts({ ...facts, keeps: true }, every).flat()).toEqual([])
  })

  it('names unsetting the deadline for a path review', () => {
    const [warning] = notesAtParts({
      deadlineMs: 1_800_000,
      deadline: 'config',
      keeps: true,
      estimate: ESTIMATE,
    })[2]
    expect(warning).toMatch(/^warning: the deadline of 30m00s \(reviewTimeoutMs\) comes before research ends, /)
    expect(warning).toMatch(/; raise reviewTimeoutMs, or unset it to let a path review run up to 24h00m00s$/)
  })

  it('notes once, at the first estimate, that a review past an hour keeps no answered call, and not when it keeps them', () => {
    const notes = notesAtParts({ deadlineMs: 86_400_000, deadline: 'config', keeps: false })
    expect(notes.slice(0, 2)).toEqual([[], []])
    expect(notes[2]).toHaveLength(1)
    expect(notes[2][0]).toMatch(STATE_NOTICE)
    expect(notes[2][0]).toContain('puts research\'s end at 150m from its start')
    expect(notes.slice(3).flat()).toEqual([])
    expect(notesAtParts({ deadlineMs: 86_400_000, deadline: 'config', keeps: true }).flat()).toEqual([])
  })

  it('notes a review that ends an hour from its start, and not one that ends sooner', () => {
    expect(STATE_NOTICE_MS).toBe(3_600_000)
    // 30 parts of 2 minutes end at the 60th minute, 30 of 1 minute at the 30th.
    expect(notesAtParts({ deadlineMs: 86_400_000, deadline: 'config', keeps: false }, 120_000)[2]).toEqual([
      expect.stringMatching(STATE_NOTICE),
    ])
    expect(notesAtParts({ deadlineMs: 86_400_000, deadline: 'config', keeps: false }, 119_000).flat()).toEqual([])
  })

  it('writes no notice where the caller offers no --state: the facts of viewFacts(config) say nothing of keeping calls', () => {
    const config = resolvedConfig({
      providers: {
        fake: {
          model: 'm',
          complete: async () => ({ text: '{}', model: 'm' }),
        },
      },
      concurrency: 1,
      reviewTimeoutMs: 86_400_000,
    })
    // The first estimate puts research's end 150 minutes from the start: only a caller that says the review keeps no call has the notice.
    expect(notesAtParts(viewFacts(config)).flat()).toEqual([])
    expect(notesAtParts(viewFacts(config, { keeps: false }))[2]).toEqual([
      expect.stringMatching(STATE_NOTICE),
    ])
    expect(notesAtParts(viewFacts(config, { keeps: true })).flat()).toEqual([])
  })

  it('writes the warning, then the notice, after the part\'s own line, each inert and with no profile prefix', () => {
    const state = (facts: Partial<ViewFacts>): ViewState => replay(slowResearch(300_000), 900_000, {
      ...DEFAULT_FACTS,
      concurrency: 1,
      ...facts,
    })
    const event = slowResearch(300_000).find(({ at, event: made }) => at === 900_000 && made.type === 'part')!.event
    const lines = logLines(event, state({ deadlineMs: 1_800_000, deadline: 'config', keeps: false }), 'full')
    expect(lines.map(line => line.text)).toEqual([
      expect.stringMatching(/^\[naming\] part 2 of 15: answered in 5m00s/),
      expect.stringMatching(/^warning: the deadline of 30m00s /),
      expect.stringMatching(/^notice: this review's first estimate /),
    ])
    expect(lines[0].glyph).toBe('answered')
    expect(lines.slice(1).map(line => line.glyph)).toEqual([undefined, undefined])
    for (const { text } of lines) expect(inertLine(text)).toBe(text)
  })

  it('writes nothing for a part event before the first estimate, or when no estimate was made', () => {
    // Under 3 answered parts there is no estimate; with the parts all pooled at one call at once, the third gives one.
    const before = replay(slowResearch(300_000), 600_000, {
      ...DEFAULT_FACTS,
      concurrency: 1,
      deadlineMs: 1_800_000,
      deadline: 'config',
    })
    expect(before.firstEstimate).toBeUndefined()
    const second = slowResearch(300_000).find(({ at, event }) => at === 600_000 && event.type === 'part')!.event
    expect(logLines(second, before, 'full')).toHaveLength(1)
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
    expect(heartbeatLine(state, 600_000, 'full')).toBe('[10m00s] research 19 of 44 part(s), 4 call(s) in flight, 1 retried; 812k of 2.00M tokens; about 12-16m left')
    expect(heartbeatLine(replay(longReview(), 120_000), 120_000, 'full')).toBe('[2m00s] research 0 of 44 part(s), 4 call(s) in flight, 0 retried; 0 of 2.00M tokens; estimating the time left')
    expect(heartbeatLine(state, 42_000, 'public')).toMatch(/^\[42s\] research 19 of 44 part\(s\), 4 call\(s\) in flight, 1 retried; about /)
    // The panel's own clock counts whole seconds throughout (`elapsedWords`); a duration a line writes keeps its decimal under 10 s (`durationText`).
    expect([
      elapsedWords(4300),
      elapsedWords(3_729_000),
      elapsedWords(59_600),
    ]).toEqual(['4s', '1h02m09s', '1m00s'])
    expect([
      durationText(4300),
      durationText(42_400),
      durationText(134_000),
      durationText(9960),
      durationText(-5),
    ]).toEqual(['4.3s', '42s', '2m14s', '10s', '0.0s'])
  })

  it('writes a part\'s tokens and the heartbeat\'s spend scaled', () => {
    const answered = partEvent({
      part: { index: 2, count: 121 },
      durationMs: 250_000,
      spent: 39_800,
      listed: 3,
    })
    expect(textsOf(answered)).toEqual(['part 2 of 121: answered in 4m10s, 39.8k tokens, 3 finding(s) listed'])
    expect(heartbeatLine(tenthMinute(), 600_000, 'full')).toContain('; 812k of 2.00M tokens; ')
  })

  it('writes the panel\'s heartbeat, and no tokens under the public view', () => {
    const list = longReview()
    const at = 1_811_600 + 200_000
    const state = replay(list, at)
    // 8 votes cast in 85 to 100 s, 10 left: the 25th and 75th percentile durations are 85 and 95 s, over 4 at once.
    const full = heartbeatLine(state, at, 'full')
    expect(full).toBe('[33m32s] panel 8 of 18 vote(s), 4 call(s) in flight, 0 retried; 1.43M of 2.00M tokens; about 4m left')
    const secret = heartbeatLine(state, at, 'public')
    expect(secret).toBe(full.replace(/; [\d.]+[kM]? of 2\.00M tokens/, ''))
    expect(secret).not.toContain('tokens')
  })
})
