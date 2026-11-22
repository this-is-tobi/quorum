import { describe, expect, it } from 'vitest'
import { createAdaptations, thinkingLowersTo } from './adapt.ts'
import { ProviderError } from './errors.ts'
import type { Provider } from './ports.ts'
import { targetOf } from './stages/context.ts'

const budget = { findings: 3, findingsWithoutThinking: 7 }

/** A target of a provider named `id` that states `adapts`, and nothing else. */
function targetFor(id: string, adapts?: Provider['adapts']) {
  return targetOf({
    id,
    model: `${id}-model`,
    ...adapts === undefined
      ? {}
      : { adapts },
    complete: async () => ({ text: '{}', model: 'm' }),
  })
}

function noAnswer(noAnswerOf: 'thinking' | 'empty'): ProviderError {
  return new ProviderError({
    providerId: 'p',
    kind: 'no-answer',
    noAnswer: noAnswerOf,
    message: 'x',
  })
}
function cutOff(noAnswerOf: 'thinking' | 'reply'): ProviderError {
  return new ProviderError({
    providerId: 'p',
    kind: 'truncated',
    noAnswer: noAnswerOf,
    message: 'x',
  })
}
function refusedFormat(): ProviderError {
  return new ProviderError({
    providerId: 'p',
    kind: 'http',
    status: 400,
    refused: 'structuredOutput',
    message: 'x',
  })
}
function refusedStream(refused: 'streamOptions' | 'stream', status = 400): ProviderError {
  return new ProviderError({
    providerId: 'p',
    kind: 'http',
    status,
    refused,
    message: 'x',
  })
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const open = (): AbortSignal => new AbortController().signal

describe('adaptations', () => {
  it('probes thinking once per provider on a thinking cut-off, while the calls already in flight still hold the old level and new ones wait', async () => {
    const adapt = createAdaptations()
    const target = targetFor('finder', { thinking: 'low' })
    expect(adapt.sent(target)).toEqual({})
    expect(adapt.probe(target, cutOff('thinking'))).toEqual({
      setting: 'thinking',
      cause: 'cut-off-thinking',
      with: { thinking: 'low' },
    })
    // The probe is pending: no second call of the provider becomes one, and the old level is still the one sent.
    expect(adapt.probe(target, cutOff('thinking'))).toBeUndefined()
    expect(adapt.probe(target, noAnswer('thinking'))).toBeUndefined()
    expect(adapt.sent(target)).toEqual({})
    let released = false
    const waiting = adapt.ready(target, open()).then(() => {
      released = true
    })
    await turn()
    expect(released).toBe(false)
    expect(adapt.settle(target, 'thinking', 'answered')).toEqual({
      provider: 'finder',
      setting: 'thinking',
      from: 'default',
      to: 'low',
      cause: 'cut-off-thinking',
    })
    await waiting
    expect(adapt.sent(target)).toEqual({ thinking: 'low' })
    // Settled: the setting is tried, so no other failure probes it again.
    expect(adapt.probe(target, cutOff('thinking'))).toBeUndefined()
    // Another provider is another probe, and a reply that held only reasoning has its own cause.
    const other = targetFor('other', { thinking: 'off' })
    expect(adapt.probe(other, noAnswer('thinking'))).toEqual({
      setting: 'thinking',
      cause: 'no-answer-thinking',
      with: { thinking: 'off' },
    })
    expect(adapt.settle(other, 'thinking', 'answered')).toMatchObject({
      provider: 'other',
      from: 'default',
      to: 'off',
      cause: 'no-answer-thinking',
    })
  })

  it('sets the lowered level when its probe failed for the server, and goes back to the server\'s default when the server refused it', () => {
    const adapt = createAdaptations()
    const failed = targetFor('failed', { thinking: 'low' })
    adapt.probe(failed, cutOff('thinking'))
    expect(adapt.settle(failed, 'thinking', 'failed')).toMatchObject({
      provider: 'failed',
      setting: 'thinking',
      from: 'default',
      to: 'low',
      cause: 'cut-off-thinking',
    })
    expect(adapt.sent(failed)).toEqual({ thinking: 'low' })

    const refused = targetFor('refused', { thinking: 'low' })
    adapt.probe(refused, cutOff('thinking'))
    expect(adapt.settle(refused, 'thinking', 'refused')).toEqual({
      provider: 'refused',
      setting: 'thinking',
      from: 'low',
      to: 'default',
      cause: 'lowering-refused',
    })
    expect(adapt.sent(refused)).toEqual({})
    expect(adapt.probe(refused, cutOff('thinking'))).toBeUndefined()

    // A probe a limit or the stop ended moves nothing, records nothing and counts the setting as tried.
    const unsent = targetFor('unsent', { thinking: 'low' })
    adapt.probe(unsent, cutOff('thinking'))
    expect(adapt.settle(unsent, 'thinking', 'unsent')).toBeUndefined()
    expect(adapt.sent(unsent)).toEqual({})
    expect(adapt.probe(unsent, cutOff('thinking'))).toBeUndefined()
    expect(adapt.record().map(entry => entry.provider)).toEqual(['failed', 'refused'])
  })

  it('probes prompt mode once per provider on an empty reply, and keeps json when the probe fails', () => {
    const adapt = createAdaptations()
    const target = targetFor('voter', { prompt: true })
    expect(adapt.probe(target, noAnswer('empty'))).toEqual({
      setting: 'structuredOutput',
      cause: 'empty-reply',
      with: { structuredOutput: 'prompt' },
    })
    expect(adapt.probe(target, noAnswer('empty'))).toBeUndefined()
    expect(adapt.settle(target, 'structuredOutput', 'failed')).toBeUndefined()
    expect(adapt.sent(target)).toEqual({})
    expect(adapt.probe(target, noAnswer('empty'))).toBeUndefined()
    expect(adapt.record()).toEqual([])

    const moved = targetFor('moved', { prompt: true })
    expect(adapt.probe(moved, noAnswer('empty'))).toMatchObject({ cause: 'empty-reply' })
    expect(adapt.settle(moved, 'structuredOutput', 'answered')).toEqual({
      provider: 'moved',
      setting: 'structuredOutput',
      from: 'json',
      to: 'prompt',
      cause: 'empty-reply',
    })
    expect(adapt.sent(moved)).toEqual({ structuredOutput: 'prompt' })

    // A 400 that names the structured-output field is the other way in; a probe a server refused leaves json and records nothing.
    const refused = targetFor('refused', { prompt: true })
    expect(adapt.probe(refused, refusedFormat())).toEqual({
      setting: 'structuredOutput',
      cause: 'format-refused',
      with: { structuredOutput: 'prompt' },
    })
    expect(adapt.settle(refused, 'structuredOutput', 'refused')).toBeUndefined()
    expect(adapt.sent(refused)).toEqual({})
    const named = targetFor('named', { prompt: true })
    adapt.probe(named, refusedFormat())
    expect(adapt.settle(named, 'structuredOutput', 'answered')).toMatchObject({ from: 'json', to: 'prompt', cause: 'format-refused' })
  })

  it('never probes a provider that states no adapts', () => {
    const adapt = createAdaptations()
    const failures = [
      cutOff('thinking'),
      noAnswer('thinking'),
      noAnswer('empty'),
      refusedFormat(),
    ]
    for (const failure of failures) expect(adapt.probe(targetFor('plain'), failure)).toBeUndefined()
    // Each setting is probed only for what the provider states: thinking leaves prompt mode alone, and the other way round.
    expect(adapt.probe(targetFor('thinker', { thinking: 'low' }), noAnswer('empty'))).toBeUndefined()
    expect(adapt.probe(targetFor('thinker', { thinking: 'low' }), refusedFormat())).toBeUndefined()
    expect(adapt.probe(targetFor('prompter', { prompt: true }), cutOff('thinking'))).toBeUndefined()
    expect(adapt.probe(targetFor('prompter', { prompt: true }), noAnswer('thinking'))).toBeUndefined()
    // A failure no adaptation answers: a cut-off at its limit, a failure of any other kind, a 400 that names no field, a value that is no error.
    const both = targetFor('both', { thinking: 'low', prompt: true })
    expect(adapt.probe(both, cutOff('reply'))).toBeUndefined()
    expect(adapt.probe(both, new ProviderError({
      providerId: 'p',
      kind: 'http',
      status: 400,
      message: 'x',
    }))).toBeUndefined()
    expect(adapt.probe(both, new ProviderError({
      providerId: 'p',
      kind: 'http',
      status: 500,
      refused: 'structuredOutput',
      message: 'x',
    }))).toBeUndefined()
    expect(adapt.probe(both, new Error('x'))).toBeUndefined()
    expect(adapt.probe(both, undefined)).toBeUndefined()
    // A provider whose stated level is no higher than the lowered one has nothing to lower.
    expect(adapt.probe(targetOf({
      id: 'low',
      model: 'm',
      thinking: 'low',
      adapts: { thinking: 'low' },
      complete: async () => ({ text: '{}', model: 'm' }),
    }), cutOff('thinking'))).toBeUndefined()
    expect(adapt.record()).toEqual([])
  })

  it('asks for N\' once a research reply showed no reasoning, and for N while a reply showed some or could not tell', () => {
    const adapt = createAdaptations()
    const target = targetFor('finder')
    const reply = (text: string, reasoning?: boolean) => ({
      text,
      model: 'm',
      ...reasoning === undefined
        ? {}
        : { reasoning },
    })
    expect(adapt.findings(target, budget)).toBe(3)
    adapt.reasoned(target, reply('{}'))
    adapt.reasoned(target, reply('{}', true))
    adapt.reasoned(target, reply('<think>hm</think>{}', false))
    expect(adapt.findings(target, budget)).toBe(3)
    adapt.reasoned(target, reply('{}', false))
    expect(adapt.findings(target, budget)).toBe(7)
    expect(adapt.findings(targetFor('other'), budget)).toBe(3)
  })

  it('records each adaptation once, in order', () => {
    const adapt = createAdaptations()
    const first = targetFor('first', { thinking: 'low', prompt: true })
    const second = targetFor('second', { prompt: true })
    adapt.probe(first, noAnswer('empty'))
    adapt.probe(second, noAnswer('empty'))
    adapt.settle(second, 'structuredOutput', 'answered')
    adapt.settle(first, 'structuredOutput', 'answered')
    adapt.probe(first, cutOff('thinking'))
    adapt.settle(first, 'thinking', 'answered')
    // Settled once: a second settle of a setting records nothing more.
    expect(adapt.settle(first, 'thinking', 'answered')).toBeUndefined()
    expect(adapt.record().map(({ provider, setting, cause }) => [provider, setting, cause])).toEqual([
      ['second', 'structuredOutput', 'empty-reply'],
      ['first', 'structuredOutput', 'empty-reply'],
      ['first', 'thinking', 'cut-off-thinking'],
    ])
  })

  it('holds a provider\'s new calls while its probe is pending, and answers each call sent before it with the setting the probe settled', async () => {
    const adapt = createAdaptations()
    const target = targetFor('voter', { prompt: true })
    const sentBefore = adapt.sent(target)
    adapt.probe(target, noAnswer('empty'))
    const stopped = new AbortController()
    let ready = 'pending'
    const waiting = adapt.ready(target, open()).then(() => {
      ready = 'ready'
    })
    let answer: unknown = 'pending'
    const after = adapt.after(target, sentBefore, noAnswer('empty'), open()).then((fields) => {
      answer = fields
    })
    // A provider with no probe pending is never held.
    await adapt.ready(targetFor('quiet', { prompt: true }), open())
    await turn()
    expect([ready, answer]).toEqual(['pending', 'pending'])
    // The stop ends either wait with its reason, and leaves the probe pending for the others.
    const reason = new Error('stopped')
    stopped.abort(reason)
    await expect(adapt.ready(target, stopped.signal)).rejects.toBe(reason)
    await expect(adapt.after(target, sentBefore, noAnswer('empty'), stopped.signal)).rejects.toBe(reason)
    expect([ready, answer]).toEqual(['pending', 'pending'])

    adapt.settle(target, 'structuredOutput', 'answered')
    await Promise.all([waiting, after])
    expect([ready, answer]).toEqual([
      'ready',
      { structuredOutput: 'prompt' },
    ])
    // A call sent at the settled level meets no re-send for it: the setting did not move from what it sent.
    await expect(adapt.after(target, adapt.sent(target), noAnswer('empty'), open())).resolves.toBeUndefined()
    // A failure the probe's setting does not answer is none of its business.
    await expect(adapt.after(target, sentBefore, cutOff('thinking'), open())).resolves.toBeUndefined()

    const failed = targetFor('failed', { prompt: true })
    const sentFailed = adapt.sent(failed)
    adapt.probe(failed, noAnswer('empty'))
    const waitingFailed = adapt.after(failed, sentFailed, noAnswer('empty'), open())
    adapt.settle(failed, 'structuredOutput', 'failed')
    await expect(waitingFailed).resolves.toBeUndefined()
    // A probe ended by a limit releases its waiters too, which meet the limit themselves.
    const limited = targetFor('limited', { thinking: 'low' })
    adapt.probe(limited, cutOff('thinking'))
    const heldByLimit = adapt.ready(limited, open())
    adapt.settle(limited, 'thinking', 'unsent')
    await expect(heldByLimit).resolves.toBeUndefined()
  })

  it('moves a provider that refuses stream_options to a bare stream once, and keeps it streaming', async () => {
    const adapt = createAdaptations()
    const target = targetFor('api', { stream: true })
    const before = adapt.sent(target)
    expect(adapt.probe(target, refusedStream('streamOptions'))).toEqual({
      setting: 'stream',
      cause: 'stream-refused',
      with: { stream: 'bare' },
    })
    // The probe is pending: no second call becomes one, and the old setting is still the one sent.
    expect(adapt.probe(target, refusedStream('streamOptions'))).toBeUndefined()
    expect(adapt.probe(target, refusedStream('stream'))).toBeUndefined()
    expect(adapt.sent(target)).toEqual({})
    let released = false
    const waiting = adapt.ready(target, open()).then(() => {
      released = true
    })
    const after = adapt.after(target, before, refusedStream('streamOptions'), open())
    await turn()
    expect(released).toBe(false)
    expect(adapt.settle(target, 'stream', 'answered')).toEqual({
      provider: 'api',
      setting: 'stream',
      from: 'stream',
      to: 'bare',
      cause: 'stream-refused',
    })
    await waiting
    await expect(after).resolves.toEqual({ stream: 'bare' })
    expect(adapt.sent(target)).toEqual({ stream: 'bare' })
    // A second refusal of stream_options makes no probe: the step is tried, and a call sent at the bare stream meets no re-send.
    expect(adapt.probe(target, refusedStream('streamOptions'))).toBeUndefined()
    await expect(adapt.after(target, adapt.sent(target), refusedStream('streamOptions'), open())).resolves.toBeUndefined()
    // A 422 is a refusal too, and another status is none.
    const other = targetFor('other', { stream: true })
    expect(adapt.probe(other, refusedStream('streamOptions', 500))).toBeUndefined()
    expect(adapt.probe(other, refusedStream('streamOptions', 422))).toMatchObject({
      with: { stream: 'bare' },
    })
  })

  it('steps on to whole replies when the bare stream is refused too, each step probed once', () => {
    const adapt = createAdaptations()
    // The bare stream answers, then the server refuses streaming itself: the second step starts from the first.
    const stepped = targetFor('stepped', { stream: true })
    adapt.probe(stepped, refusedStream('streamOptions'))
    adapt.settle(stepped, 'stream', 'answered')
    expect(adapt.probe(stepped, refusedStream('stream'))).toEqual({
      setting: 'stream',
      cause: 'stream-refused',
      with: { stream: false },
    })
    expect(adapt.probe(stepped, refusedStream('stream'))).toBeUndefined()
    expect(adapt.settle(stepped, 'stream', 'answered')).toEqual({
      provider: 'stepped',
      setting: 'stream',
      from: 'bare',
      to: 'whole',
      cause: 'stream-refused',
    })
    expect(adapt.sent(stepped)).toEqual({ stream: false })
    expect(adapt.probe(stepped, refusedStream('stream'))).toBeUndefined()
    expect(adapt.probe(stepped, refusedStream('streamOptions'))).toBeUndefined()

    // The bare probe refused as a stream moves nothing, and its step is tried; whole replies are then probed, from the stream.
    const refused = targetFor('refused', { stream: true })
    adapt.probe(refused, refusedStream('streamOptions'))
    expect(adapt.settle(refused, 'stream', 'refused')).toBeUndefined()
    expect(adapt.sent(refused)).toEqual({})
    expect(adapt.probe(refused, refusedStream('streamOptions'))).toBeUndefined()
    expect(adapt.probe(refused, refusedStream('stream'))).toEqual({
      setting: 'stream',
      cause: 'stream-refused',
      with: { stream: false },
    })
    expect(adapt.settle(refused, 'stream', 'answered')).toMatchObject({ from: 'stream', to: 'whole' })
    expect(adapt.sent(refused)).toEqual({ stream: false })
    expect(adapt.record().map(({ provider, from, to }) => [provider, from, to])).toEqual([
      ['stepped', 'stream', 'bare'],
      ['stepped', 'bare', 'whole'],
      ['refused', 'stream', 'whole'],
    ])

    // A refusal of streaming goes straight to whole replies, with no bare step before it.
    const direct = targetFor('direct', { stream: true })
    expect(adapt.probe(direct, refusedStream('stream'))).toMatchObject({
      with: { stream: false },
    })
    expect(adapt.settle(direct, 'stream', 'answered')).toMatchObject({ from: 'stream', to: 'whole' })
  })

  it('moves nothing when a stream probe fails or is refused, and ends the call with its first failure', async () => {
    const adapt = createAdaptations()
    for (const outcome of ['failed', 'refused', 'unsent'] as const) {
      const target = targetFor(outcome, { stream: true })
      const sent = adapt.sent(target)
      const first = refusedStream('streamOptions')
      expect(adapt.probe(target, first)).toMatchObject({
        with: { stream: 'bare' },
      })
      const waiting = adapt.after(target, sent, first, open())
      expect(adapt.settle(target, 'stream', outcome), outcome).toBeUndefined()
      // The call that was in flight meets no re-send, so it ends with its own failure, and the step is tried.
      await expect(waiting, outcome).resolves.toBeUndefined()
      expect(adapt.sent(target), outcome).toEqual({})
      expect(adapt.probe(target, first), outcome).toBeUndefined()
      await expect(adapt.after(target, sent, first, open()), outcome).resolves.toBeUndefined()
    }
    expect(adapt.record()).toEqual([])
  })

  it('moves a provider that answered a streamed call whole to stream: false once, and records it', async () => {
    const adapt = createAdaptations()
    const target = targetFor('api', { stream: true })
    expect(adapt.answeredWhole(target)).toEqual({
      provider: 'api',
      setting: 'stream',
      from: 'stream',
      to: 'whole',
      cause: 'stream-answered-whole',
    })
    expect(adapt.sent(target)).toEqual({ stream: false })
    // Once: a second whole reply moves nothing, and no refusal probes a step that is behind it.
    expect(adapt.answeredWhole(target)).toBeUndefined()
    expect(adapt.probe(target, refusedStream('stream'))).toBeUndefined()
    expect(adapt.record().map(({ cause }) => cause)).toEqual(['stream-answered-whole'])
    // A call sent before it, at the stream, is sent again as a whole one.
    await expect(adapt.after(target, {}, refusedStream('stream'), open())).resolves.toEqual({ stream: false })

    // From the bare stream the record says where it moved from; a whole-reply probe pending settles the move itself.
    const bare = targetFor('bare', { stream: true })
    adapt.probe(bare, refusedStream('streamOptions'))
    adapt.settle(bare, 'stream', 'answered')
    expect(adapt.answeredWhole(bare)).toMatchObject({ from: 'bare', to: 'whole' })
    const probing = targetFor('probing', { stream: true })
    adapt.probe(probing, refusedStream('stream'))
    expect(adapt.answeredWhole(probing)).toBeUndefined()
    expect(adapt.settle(probing, 'stream', 'answered')).toMatchObject({ from: 'stream', to: 'whole', cause: 'stream-refused' })
    // A bare probe that ends after the provider moved to whole replies never moves it back up.
    const racing = targetFor('racing', { stream: true })
    adapt.probe(racing, refusedStream('streamOptions'))
    expect(adapt.answeredWhole(racing)).toMatchObject({ from: 'stream', to: 'whole' })
    expect(adapt.settle(racing, 'stream', 'answered')).toBeUndefined()
    expect(adapt.sent(racing)).toEqual({ stream: false })
  })

  it('records a move the call path made with no probe, in the order it happened, as a copy', () => {
    const adapt = createAdaptations()
    const lowered = {
      provider: 'api',
      setting: 'replyTokens',
      from: 'derived',
      to: '14400',
      cause: 'cut-on-the-way',
    } as const
    adapt.answeredWhole(targetFor('api', { stream: true }))
    adapt.recorded(lowered)
    expect(adapt.record().map(({ setting }) => setting)).toEqual(['stream', 'replyTokens'])
    expect(adapt.record()[1]).toEqual(lowered)
    expect(adapt.record()[1]).not.toBe(lowered)
  })

  it('never moves a provider whose stream is pinned', () => {
    const adapt = createAdaptations()
    // A pinned stream states no adapts.stream, whatever else the provider adapts.
    for (const target of [
      targetFor('plain'),
      targetFor('thinker', { thinking: 'low', prompt: true }),
    ]) {
      expect(adapt.probe(target, refusedStream('streamOptions'))).toBeUndefined()
      expect(adapt.probe(target, refusedStream('stream'))).toBeUndefined()
      expect(adapt.answeredWhole(target)).toBeUndefined()
      expect(adapt.sent(target)).toEqual({})
    }
    // A provider that does adapt its stream leaves the other settings alone, and answers no other failure.
    const target = targetFor('api', { stream: true })
    expect(adapt.probe(target, refusedFormat())).toBeUndefined()
    expect(adapt.probe(target, cutOff('thinking'))).toBeUndefined()
    expect(adapt.probe(target, noAnswer('empty'))).toBeUndefined()
    expect(adapt.record()).toEqual([])
  })
})

describe('thinkingLowersTo', () => {
  it('names the level the review may lower a provider\'s thinking to, its adapts.thinking below its own, and none for a level the config sets', () => {
    expect(thinkingLowersTo({
      thinking: 'default',
      adapts: { thinking: 'low' },
    })).toBe('low')
    expect(thinkingLowersTo({
      thinking: 'default',
      adapts: { thinking: 'off' },
    })).toBe('off')
    expect(thinkingLowersTo({
      thinking: 'low',
      adapts: { thinking: 'off' },
    })).toBe('off')
    expect(thinkingLowersTo({ thinking: 'low', adapts: undefined })).toBeUndefined()
    expect(thinkingLowersTo({
      thinking: 'default',
      adapts: { prompt: true },
    })).toBeUndefined()
    expect(thinkingLowersTo({
      thinking: 'low',
      adapts: { thinking: 'low' },
    })).toBeUndefined()
    expect(thinkingLowersTo({
      thinking: 'off',
      adapts: { thinking: 'low' },
    })).toBeUndefined()
  })
})
