import { getEventListeners } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import { fakeClock, settle } from '../../testing/clock.ts'
import type { FakeClock } from '../../testing/clock.ts'
import { streamingProvider } from '../../testing/streams.ts'
import type { StreamPlan } from '../../testing/streams.ts'
import type { ProfileBudgets } from '../budgets.ts'
import { createAdaptations } from '../adapt.ts'
import { createClocks } from '../clocks.ts'
import { createHealth } from '../down.ts'
import { ProviderDownError, ProviderError } from '../errors.ts'
import { createLanes } from '../lanes.ts'
import { createLedger, DEFAULT_REVIEW_TIMEOUT_MS, LimitError } from '../limits.ts'
import type { CompletionRequest, CompletionResponse, Provider, StoredCall, StreamSignal } from '../ports.ts'
import { researchRequest } from '../prompts.ts'
import type { QuorumEvent } from '../types.ts'
import { providerFailure } from '../facts.ts'
import { callProvider, reservationOf, roomOf, targetOf } from './context.ts'
import type { Requester, RunContext, Target } from './context.ts'

/**
 * A context of one review: its events as the sink would receive them, but for a call's start and retries, which it
 * returns apart, in `progress`, so the exact event lists of the other tests stand. When
 * `limits.deadlineMs` is given, a timer on the fake clock aborts the review's deadline with its failure, as the
 * review arms it, and `stop` joins that to the review's signal.
 */
function context(clock: FakeClock, controller = new AbortController(), concurrency = 1, limits: { readonly cap?: number, readonly deadlineMs?: number } = {}): { ctx: RunContext, events: QuorumEvent[], progress: QuorumEvent[] } {
  const events: QuorumEvent[] = []
  const progress: QuorumEvent[] = []
  const deadlineMs = limits.deadlineMs ?? DEFAULT_REVIEW_TIMEOUT_MS
  const deadline = new AbortController()
  if (limits.deadlineMs !== undefined) {
    clock.timer(deadlineMs, () => {
      deadline.abort(new LimitError('review-deadline', `the review reached its deadline of ${deadlineMs} ms`))
    })
  }
  const emit: RunContext['emit'] = (event) => {
    if (controller.signal.aborted) return
    if (event.type === 'call:start' || event.type === 'call:retry' || event.type === 'call:progress') progress.push(event)
    else events.push(event)
  }
  const ctx: RunContext = {
    lanes: createLanes({ concurrency, clock, emit }),
    ledger: createLedger(limits.cap ?? 2_000_000),
    emit,
    signal: controller.signal,
    stop: AbortSignal.any([controller.signal, deadline.signal]),
    halt: AbortSignal.any([controller.signal, deadline.signal]),
    deadline: { at: clock.now() + deadlineMs, ms: deadlineMs },
    health: createHealth(),
    lacked: new Set(),
    storedRefused: new Set(),
    adapt: createAdaptations(),
    maxFindings: 50,
    budgets: {},
    concurrency,
    clocks: createClocks(),
    clock,
    calls: { last: 0 },
    flying: { count: 0 },
  }
  return { ctx, events, progress }
}

/** A target whose provider's own id is not the id of its ref, which is the one an error and an event name. */
function target(complete: Provider['complete'], facts: Partial<Pick<Target, 'timeoutMs' | 'stallTimeoutMs' | 'retries' | 'worstCase' | 'room' | 'window' | 'maxTokens' | 'thinking' | 'adapts' | 'streams' | 'slots'>> = {}): Target {
  return {
    provider: { id: 'live-id', model: 'm', complete },
    ref: { id: 'p', model: 'm' },
    timeoutMs: 1000,
    stallTimeoutMs: undefined,
    retries: 0,
    worstCase: undefined,
    room: undefined,
    window: undefined,
    maxTokens: undefined,
    thinking: 'default',
    adapts: undefined,
    streams: false,
    slots: undefined,
    ...facts,
  }
}

const request: CompletionRequest = {
  system: 's',
  messages: [
    { role: 'user', content: 'd' },
  ],
  output: { name: 'panel_vote', schema: {} },
}

const requester: Requester = { profile: 'security', role: 'vote', lens: 'impact' }

/** The worst case a provider states: `tokens` for any request. */
function worst(tokens: number): Pick<Target, 'worstCase'> {
  return {
    worstCase: () => tokens,
  }
}

/** One turn of the event loop's macrotask queue: every microtask queued so far has run. */
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('the deadline of an attempt', () => {
  it('fails an attempt whose provider never settles at its deadline, as a timeout of the core\'s own, and aborts the signal it handed the provider', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    let kept: AbortSignal | undefined
    const never = target((given) => {
      kept = given.signal
      return new Promise(() => {})
    })
    const error = await settle(clock, callProvider(ctx, requester, never, () => request)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({
      kind: 'timeout',
      providerId: 'p',
      retryable: true,
      message: 'p: no reply within 1000 ms',
    })
    expect(kept?.aborted).toBe(true)
    expect(kept?.reason).toBe(error)
    expect(clock.pending()).toBe(0)
    expect(events).toEqual([
      {
        type: 'call',
        call: 1,
        profile: 'security',
        role: 'vote',
        lens: 'impact',
        provider: { id: 'p', model: 'm' },
        durationMs: 1000,
        ok: false,
        spent: 16_516,
      },
    ])
  })

  it('catches a rejection its provider makes after the deadline, so it never becomes an unhandled rejection', async () => {
    const rejections: unknown[] = []
    const record = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', record)
    onTestFinished(() => {
      process.off('unhandledRejection', record)
    })
    const clock = fakeClock()
    const { ctx } = context(clock)
    let reject: (error: unknown) => void = () => {}
    const late = target(() => new Promise<CompletionResponse>((_resolve, fail) => {
      reject = fail
    }))
    await expect(settle(clock, callProvider(ctx, requester, late, () => request))).rejects.toMatchObject({ kind: 'timeout' })
    reject(new Error('after the deadline'))
    await turn()
    await turn()
    expect(rejections).toEqual([])
  })

  it('settles an attempt at once on the review\'s abort, with the abort\'s reason, though its provider ignores the signal', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    const { ctx } = context(clock, controller)
    let kept: AbortSignal | undefined
    const deaf = target((given) => {
      kept = given.signal
      return new Promise(() => {})
    })
    const call = callProvider(ctx, requester, deaf, () => request)
    await turn()
    expect(clock.pending()).toBe(1)
    expect(kept?.aborted).toBe(false)
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(call).rejects.toBe(reason)
    expect(kept?.aborted).toBe(true)
    expect(kept?.reason).toBe(reason)
    expect(clock.pending()).toBe(0)
  })

  it('clears the deadline\'s timer when an attempt succeeds, fails, or throws before it returns a promise', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    await expect(callProvider(ctx, requester, target(async () => ({ text: 'ok', model: 'm' })), () => request)).resolves.toEqual({ text: 'ok' })
    expect(clock.pending()).toBe(0)
    const refusal = new ProviderError({ providerId: 'p', kind: 'refusal', message: 'no' })
    await expect(callProvider(ctx, requester, target(async () => {
      throw refusal
    }), () => request)).rejects.toBe(refusal)
    expect(clock.pending()).toBe(0)
    const thrown = new Error('before a promise')
    await expect(callProvider(ctx, requester, target(() => {
      throw thrown
    }), () => request)).rejects.toBe(thrown)
    expect(clock.pending()).toBe(0)
    expect(getEventListeners(ctx.stop, 'abort')).toHaveLength(0)
  })

  it('takes a reply its provider returns as a plain object, not a promise', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const plain = (() => ({ text: 'plain', model: 'm' })) as unknown as Provider['complete']
    await expect(callProvider(ctx, requester, target(plain), () => request)).resolves.toEqual({ text: 'plain' })
    expect(clock.pending()).toBe(0)
  })

  it('states no deadline for a provider that states none, and reads a stated one as an own data property, never running a getter', () => {
    const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
    const provider: Provider = { id: 'p', model: 'm', complete }
    expect(targetOf(provider)).toEqual({
      provider,
      ref: { id: 'p', model: 'm' },
      timeoutMs: undefined,
      stallTimeoutMs: undefined,
      retries: 0,
      thinking: 'default',
      streams: false,
    })
    expect(targetOf({ ...provider, timeoutMs: 1000 }).timeoutMs).toBe(1000)
    expect(targetOf({ ...provider, timeoutMs: 518_400_000 }).timeoutMs).toBe(518_400_000)

    let read = false
    const getter = { ...provider }
    Object.defineProperty(getter, 'timeoutMs', {
      enumerable: true,
      get() {
        read = true
        return 1000
      },
    })
    expect(targetOf(getter).timeoutMs).toBeUndefined()
    expect(read).toBe(false)

    const inherited: Provider = Object.assign(Object.create({ timeoutMs: 1000 }), provider)
    expect(targetOf(inherited).timeoutMs).toBeUndefined()

    expect(targetOf({ ...provider, timeoutMs: 5 }).timeoutMs).toBeUndefined()
  })

  it('reads a stated stallTimeoutMs from 1000 to 86400000 as own data, and states none otherwise', () => {
    const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
    const provider: Provider = { id: 'p', model: 'm', complete }
    expect(targetOf({ ...provider, stallTimeoutMs: 300_000 }).stallTimeoutMs).toBe(300_000)
    expect(targetOf({ ...provider, stallTimeoutMs: 1000 }).stallTimeoutMs).toBe(1000)
    expect(targetOf({ ...provider, stallTimeoutMs: 86_400_000 }).stallTimeoutMs).toBe(86_400_000)
    for (const bad of [
      999,
      86_400_001,
      1.5,
      Number.NaN,
      '300000',
    ]) {
      expect(targetOf({ ...provider, stallTimeoutMs: bad as number }).stallTimeoutMs).toBeUndefined()
    }
    let read = false
    const getter = { ...provider }
    Object.defineProperty(getter, 'stallTimeoutMs', {
      enumerable: true,
      get() {
        read = true
        return 300_000
      },
    })
    expect(targetOf(getter).stallTimeoutMs).toBeUndefined()
    expect(read).toBe(false)
    expect(targetOf(Object.assign(Object.create({ stallTimeoutMs: 300_000 }), provider)).stallTimeoutMs).toBeUndefined()
  })
})

/** A thrown value of the kind a retry may follow: its facts are own data, as an adapter's error holds them. */
const failure = (facts: Record<string, unknown>): Error => Object.assign(new Error('failed'), facts)

describe('the window, the maxTokens and the thinking a provider states', () => {
  const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
  const provider: Provider = { id: 'p', model: 'm', complete }

  it('reads each as an own data property that passes its check, and states none otherwise', () => {
    expect(targetOf({
      ...provider,
      window: 8192,
      maxTokens: 500,
      thinking: 'low',
    })).toMatchObject({ window: 8192, maxTokens: 500, thinking: 'low' })
    expect(targetOf({
      ...provider,
      window: 0,
      maxTokens: 1.5,
      thinking: 'high' as Provider['thinking'],
    })).toMatchObject({ window: undefined, maxTokens: undefined, thinking: 'default' })
    const getter = { ...provider }
    let read = false
    for (const field of ['window', 'maxTokens', 'thinking']) {
      Object.defineProperty(getter, field, {
        enumerable: true,
        get() {
          read = true
          return 'off'
        },
      })
    }
    expect(targetOf(getter)).toMatchObject({ window: undefined, maxTokens: undefined, thinking: 'default' })
    expect(read).toBe(false)
    const inherited: Provider = Object.assign(Object.create({ window: 8192 }), provider)
    expect(targetOf(inherited).window).toBeUndefined()
  })
})

describe('the limit and the window a reply-lacked event holds', () => {
  const lacking = (noAnswer: string, usage: { inputTokens: number, outputTokens: number }) => async (): Promise<CompletionResponse> => {
    throw new ProviderError({
      providerId: 'p',
      kind: 'truncated',
      noAnswer,
      message: 'cut off',
      usage,
    } as ConstructorParameters<typeof ProviderError>[0])
  }
  const lackedEvents = (events: QuorumEvent[]): QuorumEvent[] => events.filter(event => event.type === 'reply-lacked')

  it('says a server that caps replies below the limit the request was sent with, naming both numbers, and its window', async () => {
    const { ctx, events } = context(fakeClock())
    const sent = { ...request, replyTokens: 8000 }
    await expect(callProvider(ctx, requester, target(lacking('reply', { inputTokens: 100, outputTokens: 4096 }), { window: 16_384 }), () => sent)).rejects.toThrow('cut off')
    expect(lackedEvents(events)).toEqual([
      {
        type: 'reply-lacked',
        provider: 'p',
        kind: 'truncated',
        noAnswer: 'reply',
        limit: 8000,
        outputTokens: 4096,
        inputTokens: 100,
        window: 16_384,
      },
    ])
  })

  it('sends the lesser of the request\'s budget and the provider\'s maxTokens as the limit, and maxTokens alone for a request with no budget', async () => {
    for (const [replyTokens, limit] of [
      [8000, 5000],
      [3000, 3000],
      [undefined, 5000],
    ] as const) {
      const { ctx, events } = context(fakeClock())
      await expect(callProvider(ctx, requester, target(lacking('reply', { inputTokens: 100, outputTokens: 2000 }), { maxTokens: 5000 }), () => ({ ...request, replyTokens }))).rejects.toThrow('cut off')
      expect(lackedEvents(events)).toMatchObject([
        { limit, outputTokens: 2000 },
      ])
    }
  })

  it('says nothing of a cap for a request sent with no limit, and names the window of a reply the server\'s window ended', async () => {
    const none = context(fakeClock())
    await expect(callProvider(none.ctx, requester, target(lacking('reply', { inputTokens: 100, outputTokens: 2000 })), () => request)).rejects.toThrow('cut off')
    expect(lackedEvents(none.events)).toEqual([])
    const ended = context(fakeClock())
    await expect(callProvider(ended.ctx, requester, target(lacking('window', { inputTokens: 9000, outputTokens: 500 }), { window: 16_384 }), () => request)).rejects.toThrow('cut off')
    expect(lackedEvents(ended.events)).toEqual([
      {
        type: 'reply-lacked',
        provider: 'p',
        kind: 'truncated',
        noAnswer: 'window',
        outputTokens: 500,
        inputTokens: 9000,
        window: 16_384,
      },
    ])
  })
})

describe('the retries of a call', () => {
  it('retries what passes after its backoff, inside its slot, and sends one call event with the attempts, the summed usage and the wait in its duration', async () => {
    const clock = fakeClock(0.5)
    const { ctx, events } = context(clock)
    const order: string[] = []
    let ran = 0
    const flaky = target(async () => {
      order.push('first')
      ran += 1
      if (ran === 1) {
        throw failure({
          kind: 'http',
          status: 503,
          retryable: true,
          usage: { inputTokens: 1, outputTokens: 2 },
        })
      }
      return {
        text: 'second',
        model: 'm',
        usage: { inputTokens: 3, outputTokens: 4 },
      }
    }, { retries: 2 })
    const behind = target(async () => {
      order.push('queued')
      return { text: 'queued', model: 'm' }
    })
    const call = callProvider(ctx, requester, flaky, () => request)
    const queued = callProvider(ctx, { ...requester, lens: 'defenses' }, behind, () => request)
    await expect(settle(clock, call)).resolves.toEqual({ text: 'second' })
    expect(clock.armed.slice(0, 3)).toEqual([1000, 250, 1000])
    expect(events[0]).toEqual({
      type: 'call',
      call: 1,
      profile: 'security',
      role: 'vote',
      lens: 'impact',
      provider: { id: 'p', model: 'm' },
      durationMs: 250,
      ok: true,
      attempts: 2,
      usage: { inputTokens: 4, outputTokens: 6 },
      spent: 10,
    })
    await expect(settle(clock, queued)).resolves.toEqual({ text: 'queued' })
    expect(order).toEqual(['first', 'first', 'queued'])
    expect(getEventListeners(ctx.stop, 'abort')).toHaveLength(0)
  })

  it('waits a server\'s hint before the next attempt, and ends the call at once on a hint over 60000 ms', async () => {
    const clock = fakeClock(0.5)
    const { ctx } = context(clock)
    let ran = 0
    const limited = target(async () => {
      ran += 1
      if (ran === 1) {
        throw failure({
          kind: 'http',
          status: 429,
          retryable: true,
          retryAfterMs: 2000,
        })
      }
      return { text: 'after the hint', model: 'm' }
    }, { retries: 2 })
    await expect(settle(clock, callProvider(ctx, requester, limited, () => request))).resolves.toEqual({ text: 'after the hint' })
    expect(clock.armed).toEqual([1000, 2500, 1000])

    const longer = fakeClock(0.5)
    const hinted = failure({
      kind: 'http',
      status: 429,
      retryable: true,
      retryAfterMs: 60_001,
    })
    let attempts = 0
    const stubborn = target(async () => {
      attempts += 1
      throw hinted
    }, { retries: 2 })
    await expect(settle(longer, callProvider(context(longer).ctx, requester, stubborn, () => request))).rejects.toBe(hinted)
    expect(attempts).toBe(1)
    expect(longer.armed).toEqual([1000])
  })

  it('ends a wait at once on the review\'s abort, with the abort\'s reason, and starts no other attempt nor the call queued behind it', async () => {
    const clock = fakeClock(0.5)
    const controller = new AbortController()
    const { ctx, events } = context(clock, controller)
    let first = 0
    let queued = 0
    const down = target(async () => {
      first += 1
      throw failure({ kind: 'network', retryable: true })
    }, { retries: 2 })
    const behind = target(async () => {
      queued += 1
      return { text: 'queued', model: 'm' }
    })
    const call = callProvider(ctx, requester, down, () => request)
    const waiting = callProvider(ctx, { ...requester, lens: 'defenses' }, behind, () => request)
    await turn()
    expect(clock.armed).toEqual([1000, 250])
    expect(clock.pending()).toBe(1)
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(call).rejects.toBe(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(first).toBe(1)
    expect(queued).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(events).toEqual([])
  })

  it('retries no failure once the review is aborted', async () => {
    const clock = fakeClock(0.5)
    const controller = new AbortController()
    const { ctx } = context(clock, controller)
    const reason = new Error('stop')
    let ran = 0
    const aborting = target(async () => {
      ran += 1
      controller.abort(reason)
      throw failure({ kind: 'network', retryable: true })
    }, { retries: 2 })
    await expect(settle(clock, callProvider(ctx, requester, aborting, () => request))).rejects.toBe(reason)
    expect(ran).toBe(1)
  })

  it('times out the first attempt, retries it once, and ends the call at the second timeout', async () => {
    const clock = fakeClock(0.5)
    const { ctx, events } = context(clock)
    let ran = 0
    const never = target(() => {
      ran += 1
      return new Promise(() => {})
    }, { retries: 5 })
    await expect(settle(clock, callProvider(ctx, requester, never, () => request))).rejects.toMatchObject({ kind: 'timeout' })
    expect(ran).toBe(2)
    expect(clock.armed).toEqual([1000, 250, 1000])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ ok: false, attempts: 2, durationMs: 2250 })
  })

  it('reads a failure\'s kind, status, retryable and hint as own data, so a getter decides nothing and never runs', async () => {
    let read = false
    const getter = Object.assign(new Error('failed'), { kind: 'network' })
    Object.defineProperty(getter, 'retryable', {
      get() {
        read = true
        return true
      },
    })
    const inherited: unknown = Object.create({ kind: 'network', retryable: true })
    for (const thrown of [getter, inherited]) {
      const clock = fakeClock(0.5)
      let ran = 0
      const broken = target(async () => {
        ran += 1
        throw thrown
      }, { retries: 2 })
      await expect(settle(clock, callProvider(context(clock).ctx, requester, broken, () => request))).rejects.toBe(thrown)
      expect(ran).toBe(1)
    }
    expect(read).toBe(false)
  })

  it('never retries a provider object\'s own-data exhausted failure, and finds its provider down at once', async () => {
    const clock = fakeClock(0.5)
    const { ctx, events } = context(clock)
    const thrown = failure({
      kind: 'http',
      status: 429,
      retryable: true,
      exhausted: true,
    })
    let ran = 0
    const spent = target(async () => {
      ran += 1
      throw thrown
    }, { retries: 2 })
    await expect(settle(clock, callProvider(ctx, requester, spent, () => request))).rejects.toBe(thrown)
    expect(ran).toBe(1)
    // Only the attempt's own deadline was armed: no wait for a retry.
    expect(clock.armed).toEqual([1000])
    expect(events.filter(event => event.type === 'provider-down')).toEqual([
      {
        type: 'provider-down',
        provider: 'p',
        kind: 'http',
        status: 429,
        calls: 1,
        exhausted: true,
      },
    ])
    expect(ctx.health.refused(spent.provider)).toBeDefined()
    // The flag counts for an `http` failure alone: a `network` failure that says it is still retried.
    const other = fakeClock(0.5)
    let again = 0
    const flaky = target(async () => {
      again += 1
      throw failure({
        kind: 'network',
        retryable: true,
        exhausted: true,
      })
    }, { retries: 1 })
    await settle(other, callProvider(context(other).ctx, requester, flaky, () => request)).catch(() => {})
    expect(again).toBe(2)
  })

  it('calls onFailure once, inside the slot, with the last failure and the attempts, before a queued call starts', async () => {
    const clock = fakeClock(0)
    const { ctx } = context(clock)
    const order: string[] = []
    const thrown = new ProviderError({ providerId: 'p', kind: 'network', message: 'down' })
    const down = target(async () => {
      throw thrown
    }, { retries: 1 })
    const behind = target(async () => {
      order.push('queued started')
      return { text: 'queued', model: 'm' }
    })
    const researcher: Requester = { profile: 'security', role: 'research' }
    const first = settle(clock, callProvider(ctx, researcher, down, () => request, {
      onFailure: (error, attempts) => {
        order.push(`failed ${attempts} ${error === thrown}`)
      },
    })).catch(() => {
      order.push('first settled')
    })
    const queued = callProvider(ctx, requester, behind, () => request)
    await Promise.all([first, queued])
    expect(order).toEqual(['failed 2 true', 'queued started', 'first settled'])
  })

  it('gives a provider that states no retries none, and reads stated retries as own data', () => {
    const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
    const provider: Provider = { id: 'p', model: 'm', complete }
    expect(targetOf(provider).retries).toBe(0)
    expect(targetOf({ ...provider, retries: 3 }).retries).toBe(3)
    let read = false
    const getter = { ...provider }
    Object.defineProperty(getter, 'retries', {
      enumerable: true,
      get() {
        read = true
        return 3
      },
    })
    expect(targetOf(getter).retries).toBe(0)
    expect(read).toBe(false)
    expect(targetOf({ ...provider, retries: 6 }).retries).toBe(0)
  })
})

describe('the worst case of a call', () => {
  const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
  const provider: Provider = { id: 'p', model: 'm', complete }

  it('reads a stated worst case as own data: a getter never runs, an inherited one states nothing, a non-function is none', () => {
    const stated = (): number => 60
    expect(targetOf({ ...provider, worstCase: stated }).worstCase).toBe(stated)

    let read = false
    const getter = { ...provider }
    Object.defineProperty(getter, 'worstCase', {
      enumerable: true,
      get() {
        read = true
        return stated
      },
    })
    expect(targetOf(getter).worstCase).toBeUndefined()
    expect(read).toBe(false)

    const inherited: Provider = Object.assign(Object.create({ worstCase: stated }), provider)
    expect(targetOf(inherited).worstCase).toBeUndefined()

    expect(targetOf({ ...provider, worstCase: 5 } as unknown as Provider).worstCase).toBeUndefined()
  })

  it.each<[string, Target['worstCase']]>([
    ['is unset', undefined],
    [
      'returns 0',
      () => 0,
    ],
    [
      'returns 1.5',
      () => 1.5,
    ],
    [
      'returns Number.NaN',
      () => Number.NaN,
    ],
    [
      'returns a string',
      () => '16000',
    ],
    [
      'returns Number.MAX_SAFE_INTEGER + 2',
      () => Number.MAX_SAFE_INTEGER + 2,
    ],
    [
      'throws',
      () => {
        throw new Error('no count')
      },
    ],
    [
      'returns a rejected promise',
      () => Promise.reject(new Error('no count')),
    ],
    [
      'returns a promise that resolves to 60',
      () => Promise.resolve(60),
    ],
  ])('reserves the core\'s count with 512 and 16000 for a worst case that %s', (_name, worstCase) => {
    expect(reservationOf({
      ...target(complete),
      worstCase,
    }, request)).toBe(4 + 512 + 16_000)
  })

  it('takes a stated worst case that is a safe integer of at least 1, called with the request and the provider as this', () => {
    const calls: Array<{ self: unknown, args: unknown[] }> = []
    const stating: Target = {
      ...target(complete),
      worstCase(this: unknown, ...args: unknown[]) {
        calls.push({ self: this, args })
        return 60
      },
    }
    expect(reservationOf(stating, request)).toBe(60)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toHaveLength(1)
    expect(calls[0]?.args[0]).toBe(request)
    expect(calls[0]?.self).toBe(stating.provider)
    expect(reservationOf({
      ...stating,
      worstCase: () => 1,
    }, request)).toBe(1)
    expect(reservationOf({
      ...stating,
      worstCase: () => Number.MAX_SAFE_INTEGER,
    }, request)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('the room a provider states', () => {
  const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
  const provider: Provider = { id: 'p', model: 'm', complete }

  it('reads a stated room as own data: a getter never runs, an inherited one states nothing, a non-function is none', () => {
    const stated = (): number => 60
    expect(targetOf({ ...provider, room: stated }).room).toBe(stated)

    let read = false
    const getter = { ...provider }
    Object.defineProperty(getter, 'room', {
      enumerable: true,
      get() {
        read = true
        return stated
      },
    })
    expect(targetOf(getter).room).toBeUndefined()
    expect(read).toBe(false)

    const inherited: Provider = Object.assign(Object.create({ room: stated }), provider)
    expect(targetOf(inherited).room).toBeUndefined()

    expect(targetOf({ ...provider, room: 5 } as unknown as Provider).room).toBeUndefined()
  })

  it.each<[string, Target['room']]>([
    ['is unset', undefined],
    [
      'returns 1.5',
      () => 1.5,
    ],
    [
      'returns Number.NaN',
      () => Number.NaN,
    ],
    [
      'returns a string',
      () => '100',
    ],
    [
      'returns Number.MAX_SAFE_INTEGER + 2',
      () => Number.MAX_SAFE_INTEGER + 2,
    ],
    [
      'returns Number.POSITIVE_INFINITY',
      () => Number.POSITIVE_INFINITY,
    ],
    [
      'throws',
      () => {
        throw new Error('no room')
      },
    ],
    [
      'returns a rejected promise',
      () => Promise.reject(new Error('later')),
    ],
  ])('states no room when it %s', async (_name, room) => {
    const rejections: unknown[] = []
    const record = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', record)
    onTestFinished(() => {
      process.off('unhandledRejection', record)
    })
    expect(roomOf({
      ...target(complete),
      room,
    }, request)).toBeUndefined()
    await turn()
    await turn()
    expect(rejections).toEqual([])
  })

  it('takes a stated room that is a safe integer, 0 and a negative one included, called with the request and the provider as this', () => {
    const calls: Array<{ self: unknown, args: unknown[] }> = []
    const stating: Target = {
      ...target(complete),
      room(this: unknown, ...args: unknown[]) {
        calls.push({ self: this, args })
        return -5
      },
    }
    expect(roomOf(stating, request)).toBe(-5)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toHaveLength(1)
    expect(calls[0]?.args[0]).toBe(request)
    expect(calls[0]?.self).toBe(stating.provider)
    expect(roomOf({
      ...stating,
      room: () => 0,
    }, request)).toBe(0)
  })
})

describe('the review\'s token cap', () => {
  const NO_ROOM = 'the review\'s token cap of 100 tokens leaves no room for this call'
  const used = (inputTokens: number, outputTokens: number): Pick<CompletionResponse, 'usage'> => ({
    usage: { inputTokens, outputTokens },
  })
  /** What each `call` event counted, in the order sent. */
  const spentOf = (events: readonly QuorumEvent[]): Array<number | undefined> => events.map(event => event.type === 'call'
    ? event.spent
    : undefined)

  it('refuses an attempt that does not fit beside the settled total, before sending it, with no event', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock, new AbortController(), 1, { cap: 100 })
    let sent = 0
    const metered = target(async () => {
      sent += 1
      return {
        text: 'ok',
        model: 'm',
        ...used(50, 10),
      }
    }, worst(60))
    await expect(callProvider(ctx, requester, metered, () => request)).resolves.toEqual({ text: 'ok' })
    expect(spentOf(events)).toEqual([60])
    const error = await callProvider(ctx, requester, metered, () => request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LimitError)
    expect(error).toMatchObject({ limit: 'token-cap', message: NO_ROOM })
    expect(sent).toBe(1)
    expect(events).toHaveLength(1)
    expect(clock.pending()).toBe(0)
    let sentOver = 0
    const over = target(async () => {
      sentOver += 1
      return { text: 'ok', model: 'm' }
    }, worst(101))
    await expect(callProvider(context(clock, new AbortController(), 1, { cap: 100 }).ctx, requester, over, () => request)).rejects.toMatchObject({ limit: 'token-cap', message: NO_ROOM })
    expect(sentOver).toBe(0)
  })

  it('waits inside its slot while the reservations in flight leave no room, and goes once one settles lower', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock, new AbortController(), 2, { cap: 100 })
    const sent: string[] = []
    let release: (response: CompletionResponse) => void = () => {}
    const first = target(() => {
      sent.push('first')
      return new Promise<CompletionResponse>((resolve) => {
        release = resolve
      })
    }, {
      ...worst(60),
      timeoutMs: 100_000,
    })
    const second = target(async () => {
      sent.push('second')
      return {
        text: 'second',
        model: 'm',
        ...used(5, 5),
      }
    }, worst(60))
    const one = callProvider(ctx, requester, first, () => request)
    const two = callProvider(ctx, { ...requester, lens: 'defenses' }, second, () => request)
    await turn()
    expect(sent).toEqual(['first'])
    release({
      text: 'first',
      model: 'm',
      ...used(12, 8),
    })
    await expect(one).resolves.toEqual({ text: 'first' })
    await expect(two).resolves.toEqual({ text: 'second' })
    expect(sent).toEqual(['first', 'second'])
    expect(spentOf(events)).toEqual([20, 10])
    expect(clock.pending()).toBe(0)
    expect(getEventListeners(ctx.stop, 'abort')).toHaveLength(0)
  })

  it('refuses a waiter once the settlement it waited for leaves no room', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock, new AbortController(), 2, { cap: 100 })
    let release: (response: CompletionResponse) => void = () => {}
    const first = target(() => new Promise<CompletionResponse>((resolve) => {
      release = resolve
    }), {
      ...worst(60),
      timeoutMs: 100_000,
    })
    let sent = 0
    const second = target(async () => {
      sent += 1
      return { text: 'second', model: 'm' }
    }, worst(60))
    const one = callProvider(ctx, requester, first, () => request)
    const two = callProvider(ctx, { ...requester, lens: 'defenses' }, second, () => request).catch((caught: unknown) => caught)
    await turn()
    release({
      text: 'first',
      model: 'm',
      ...used(30, 20),
    })
    await expect(one).resolves.toEqual({ text: 'first' })
    const error = await two
    expect(error).toBeInstanceOf(LimitError)
    expect(error).toMatchObject({ limit: 'token-cap', message: NO_ROOM })
    expect(sent).toBe(0)
    expect(spentOf(events)).toEqual([50])
    expect(getEventListeners(ctx.stop, 'abort')).toHaveLength(0)
  })

  it('ends every wait for room on the review\'s abort, with its reason, and leaves no timer', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    const { ctx, events } = context(clock, controller, 2, { cap: 100 })
    let sent = 0
    const stuck = target(() => {
      sent += 1
      return new Promise<CompletionResponse>(() => {})
    }, {
      ...worst(60),
      timeoutMs: 100_000,
    })
    const one = callProvider(ctx, requester, stuck, () => request)
    const two = callProvider(ctx, { ...requester, lens: 'defenses' }, stuck, () => request)
    let built = 0
    const three = callProvider(ctx, { ...requester, lens: 'reachability' }, stuck, () => {
      built += 1
      return request
    })
    await turn()
    expect(sent).toBe(1)
    expect(clock.pending()).toBe(1)
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(one).rejects.toBe(reason)
    await expect(two).rejects.toBe(reason)
    await expect(three).rejects.toBe(reason)
    expect(sent).toBe(1)
    expect(built).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(getEventListeners(ctx.stop, 'abort')).toHaveLength(0)
    expect(events).toEqual([])
  })

  it('reserves again for a retry, and refuses a retry the cap no longer fits, ending the call with the cap\'s failure', async () => {
    const clock = fakeClock(0.5)
    const { ctx, events } = context(clock, new AbortController(), 1, { cap: 130 })
    let ran = 0
    const flaky = target(async () => {
      ran += 1
      if (ran === 1) {
        throw failure({
          kind: 'http',
          status: 503,
          retryable: true,
          usage: { inputTokens: 40, outputTokens: 40 },
        })
      }
      return { text: 'second', model: 'm' }
    }, {
      ...worst(60),
      retries: 2,
    })
    const error = await settle(clock, callProvider(ctx, requester, flaky, () => request)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LimitError)
    expect(error).toMatchObject({ limit: 'token-cap', message: 'the review\'s token cap of 130 tokens leaves no room for this call' })
    expect(ran).toBe(1)
    expect(events).toEqual([
      {
        type: 'call',
        call: 1,
        profile: 'security',
        role: 'vote',
        lens: 'impact',
        provider: { id: 'p', model: 'm' },
        durationMs: 250,
        ok: false,
        usage: { inputTokens: 40, outputTokens: 40 },
        spent: 80,
      },
    ])
    expect(events[0]).not.toHaveProperty('attempts')
    expect(clock.pending()).toBe(0)
  })

  it.each<[string, () => Promise<CompletionResponse>, number]>([
    [
      'a reply\'s usage',
      async () => ({
        text: 'ok',
        model: 'm',
        ...used(7, 3),
      }),
      10,
    ],
    [
      'a reply without usage',
      async () => ({ text: 'ok', model: 'm' }),
      60,
    ],
    [
      'an http 400 without usage',
      async () => {
        throw failure({ kind: 'http', status: 400 })
      },
      0,
    ],
    [
      'an http 408',
      async () => {
        throw failure({ kind: 'http', status: 408 })
      },
      60,
    ],
    [
      'a too-large refusal',
      async () => {
        throw new ProviderError({ providerId: 'p', kind: 'too-large', message: 'too big' })
      },
      0,
    ],
    [
      'a 503',
      async () => {
        throw failure({ kind: 'http', status: 503 })
      },
      60,
    ],
    [
      'a truncated failure with usage',
      async () => {
        throw failure({
          kind: 'truncated',
          usage: { inputTokens: 50, outputTokens: 40 },
        })
      },
      90,
    ],
  ])('settles %s through a call', async (_name, complete, spent) => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    await callProvider(ctx, requester, target(complete, worst(60)), () => request).catch(() => undefined)
    expect(spentOf(events)).toEqual([spent])
  })
})

describe('the review\'s deadline', () => {
  const REACHED = (ms: number): string => `the review reached its deadline of ${ms} ms`
  const never: Provider['complete'] = () => new Promise(() => {})

  it('settles an attempt in flight at the deadline with the deadline\'s failure, aborting the signal it handed the provider, and sends its failed event', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock, new AbortController(), 1, { deadlineMs: 5000 })
    let kept: AbortSignal | undefined
    const stuck = target((given) => {
      kept = given.signal
      return new Promise(() => {})
    }, { timeoutMs: 600_000 })
    const error = await settle(clock, callProvider(ctx, requester, stuck, () => request)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LimitError)
    expect(error).toMatchObject({
      limit: 'review-deadline',
      message: REACHED(5000),
    })
    expect(kept?.aborted).toBe(true)
    expect(kept?.reason).toBe(error)
    expect(events).toEqual([
      {
        type: 'call',
        call: 1,
        profile: 'security',
        role: 'vote',
        lens: 'impact',
        provider: { id: 'p', model: 'm' },
        durationMs: 5000,
        ok: false,
        spent: 16_516,
      },
    ])
    expect(clock.pending()).toBe(0)
    expect(getEventListeners(ctx.stop, 'abort')).toHaveLength(0)
  })

  it('ends a backoff at the deadline, and never builds the request of a call queued behind it', async () => {
    const clock = fakeClock(0.999)
    const { ctx, events } = context(clock, new AbortController(), 1, { deadlineMs: 2000 })
    const down = target(async () => {
      throw failure({ kind: 'network', retryable: true })
    }, { retries: 5, timeoutMs: 1000 })
    const behind = target(async () => ({ text: 'queued', model: 'm' }))
    let built = 0
    const call = callProvider(ctx, requester, down, () => request)
    const queued = callProvider(ctx, { ...requester, lens: 'defenses' }, behind, () => {
      built += 1
      return request
    })
    const outcomes = await settle(clock, Promise.allSettled([call, queued]))
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected')
      const reason: unknown = (outcome as PromiseRejectedResult).reason
      expect(reason).toBeInstanceOf(LimitError)
      expect(reason).toMatchObject({
        limit: 'review-deadline',
        message: REACHED(2000),
      })
    }
    expect(built).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ ok: false, attempts: 3, durationMs: 2000 })
    expect(clock.pending()).toBe(0)
    expect(getEventListeners(ctx.stop, 'abort')).toHaveLength(0)
  })

  it('ends a wait for room at the deadline, before its first attempt, with no event', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock, new AbortController(), 2, { cap: 100, deadlineMs: 3000 })
    const stuck = target(never, {
      ...worst(60),
      timeoutMs: 100_000,
    })
    const one = callProvider(ctx, requester, stuck, () => request)
    const two = callProvider(ctx, { ...requester, lens: 'defenses' }, stuck, () => request)
    const outcomes = await settle(clock, Promise.allSettled([one, two]))
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected')
      const reason: unknown = (outcome as PromiseRejectedResult).reason
      expect(reason).toBeInstanceOf(LimitError)
      expect(reason).toMatchObject({
        limit: 'review-deadline',
        message: REACHED(3000),
      })
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'call',
      lens: 'impact',
      ok: false,
      spent: 60,
    })
    expect(clock.pending()).toBe(0)
    expect(getEventListeners(ctx.stop, 'abort')).toHaveLength(0)
  })

  it('ends a call at once, with its last failure, when a server\'s hint is longer than the time the review has left', async () => {
    const clock = fakeClock(0.5)
    const { ctx } = context(clock, new AbortController(), 1, { deadlineMs: 10_000 })
    const hinted = failure({
      kind: 'http',
      status: 429,
      retryable: true,
      retryAfterMs: 30_000,
    })
    let attempts = 0
    const limited = target(async () => {
      attempts += 1
      throw hinted
    }, { retries: 2 })
    await expect(settle(clock, callProvider(ctx, requester, limited, () => request))).rejects.toBe(hinted)
    expect(attempts).toBe(1)
  })

  /**
   * A context whose deadline falls as a failed attempt settles in the ledger: after the attempt has failed, before
   * the retry policy decides. The attempt has settled by then, so the stop's abort reaches the call's catch, not the
   * attempt's own listener on the stop.
   */
  function fallingAtSettlement(clock: FakeClock, deadlineMs: number): { ctx: RunContext, events: QuorumEvent[] } {
    const { ctx, events } = context(clock, new AbortController(), 1, { deadlineMs })
    return {
      ctx: {
        ...ctx,
        ledger: {
          ...ctx.ledger,
          settle: (reserved, spent) => {
            ctx.ledger.settle(reserved, spent)
            clock.fireNext()
          },
        },
      },
      events,
    }
  }

  it('records the deadline, not the failure, when the deadline stops a retry the call had left', async () => {
    // The attempt's own timeout and the deadline fall in the same tick, the deadline's timer being the first armed.
    const tied = fakeClock()
    const { ctx, events } = context(tied, new AbortController(), 1, { deadlineMs: 1000 })
    const slow = target(never, { retries: 2, timeoutMs: 1000 })
    const cut = await settle(tied, callProvider(ctx, requester, slow, () => request)).catch((caught: unknown) => caught)
    expect(cut).toBeInstanceOf(LimitError)
    expect(cut).toMatchObject({
      limit: 'review-deadline',
      message: REACHED(1000),
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'call', ok: false, durationMs: 1000 })
    expect(events[0]).not.toHaveProperty('attempts')
    expect(tied.pending()).toBe(0)

    // The deadline falls once the attempt failed in passing, so the call reaches its retry decision with the stop aborted.
    for (const facts of [
      { kind: 'http', status: 503, retryable: true },
      { kind: 'network', retryable: true },
      {
        kind: 'http',
        status: 429,
        retryable: true,
        retryAfterMs: 5000,
      },
    ]) {
      const clock = fakeClock()
      const stopped = fallingAtSettlement(clock, 1000)
      let sent = 0
      const flaky = target(async () => {
        sent += 1
        throw failure(facts)
      }, { retries: 2 })
      const error = await callProvider(stopped.ctx, requester, flaky, () => request).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LimitError)
      expect(error).toMatchObject({
        limit: 'review-deadline',
        message: REACHED(1000),
      })
      expect(sent).toBe(1)
      expect(stopped.events).toHaveLength(1)
      expect(stopped.events[0]).toMatchObject({
        type: 'call',
        ok: false,
        durationMs: 1000,
      })
      expect(stopped.events[0]).not.toHaveProperty('attempts')
      expect(clock.pending()).toBe(0)
    }
  })

  it('keeps the failure a call ended with when no retry was left for the deadline to stop', async () => {
    const clock = fakeClock()
    const stopped = fallingAtSettlement(clock, 1000)
    const thrown = failure({ kind: 'http', status: 503, retryable: true })
    const spent = target(async () => {
      throw thrown
    }, { retries: 0 })
    await expect(callProvider(stopped.ctx, requester, spent, () => request)).rejects.toBe(thrown)
    expect(stopped.ctx.stop.aborted).toBe(true)
    expect(stopped.events).toHaveLength(1)

    const second = fakeClock()
    const refused = fallingAtSettlement(second, 1000)
    const refusal = new ProviderError({ providerId: 'p', kind: 'refusal', message: 'no' })
    await expect(callProvider(refused.ctx, requester, target(async () => {
      throw refusal
    }, { retries: 2 }), () => request)).rejects.toBe(refusal)
    expect(refused.ctx.stop.aborted).toBe(true)
  })

  it('tells the deadline apart from an attempt\'s own timeout', async () => {
    const clock = fakeClock()
    const own = await settle(clock, callProvider(context(clock).ctx, requester, target(never), () => request)).catch((caught: unknown) => caught)
    expect(own).toBeInstanceOf(ProviderError)
    expect(own).not.toBeInstanceOf(LimitError)
    expect(own).toMatchObject({ kind: 'timeout' })

    const other = fakeClock()
    const cut = await settle(other, callProvider(context(other, new AbortController(), 1, { deadlineMs: 500 }).ctx, requester, target(never), () => request)).catch((caught: unknown) => caught)
    expect(cut).toBeInstanceOf(LimitError)
    expect(cut).not.toBeInstanceOf(ProviderError)
    expect(cut).toMatchObject({
      limit: 'review-deadline',
      message: REACHED(500),
    })
  })
})

describe('the adaptations of a call', () => {
  const cutOff = (): ProviderError => new ProviderError({
    providerId: 'p',
    kind: 'truncated',
    noAnswer: 'thinking',
    message: 'cut off',
    usage: { inputTokens: 100, outputTokens: 300 },
  })
  const answered = (text = '{}'): CompletionResponse => ({ text, model: 'm' })
  const lowers = {
    adapts: { thinking: 'low' as const },
  }

  it('sends a call once more at the lowered thinking inside the same call: one call event with both attempts, then the adapted event', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const sent: Array<CompletionRequest['thinking']> = []
    const lowering = target(async (asked) => {
      sent.push(asked.thinking)
      if (asked.thinking === undefined) throw cutOff()
      return answered('done')
    }, lowers)
    await expect(settle(clock, callProvider(ctx, requester, lowering, () => request))).resolves.toEqual({ text: 'done' })
    expect(sent).toEqual([undefined, 'low'])
    expect(events.map(event => event.type)).toEqual(['adapted', 'call'])
    expect(events[0]).toEqual({
      type: 'adapted',
      adaptation: {
        provider: 'p',
        setting: 'thinking',
        from: 'default',
        to: 'low',
        cause: 'cut-off-thinking',
      },
    })
    expect(events[1]).toMatchObject({
      type: 'call',
      ok: true,
      attempts: 2,
      usage: { inputTokens: 100, outputTokens: 300 },
    })
    // The next call of the provider is built at the settled level, and meets no re-send.
    await settle(clock, callProvider(ctx, requester, lowering, () => request))
    expect(sent).toEqual([undefined, 'low', 'low'])
    expect(ctx.adapt.record()).toHaveLength(1)
  })

  /** A call whose first attempt fails with `first` and whose re-sends fail with `second`, at a provider that lowers thinking. */
  async function probed(first: unknown, second: unknown): Promise<{ readonly ctx: RunContext, readonly events: QuorumEvent[], readonly sent: Array<CompletionRequest['thinking']>, readonly error: unknown, readonly lowering: Target }> {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const sent: Array<CompletionRequest['thinking']> = []
    const lowering = target(async (asked) => {
      sent.push(asked.thinking)
      throw asked.thinking === undefined
        ? first
        : second
    }, lowers)
    const error = await settle(clock, callProvider(ctx, requester, lowering, () => request)).catch((caught: unknown) => caught)
    return { ctx, events, sent, error, lowering }
  }
  const http = (status: number): ProviderError => new ProviderError({
    providerId: 'p',
    kind: 'http',
    status,
    message: 'x',
  })
  const reasoningOnly = (): ProviderError => new ProviderError({
    providerId: 'p',
    kind: 'no-answer',
    noAnswer: 'thinking',
    message: 'only reasoning',
  })

  it('moves nothing when a cut-off probe fails with a 503: it ends with the cut-off, and the setting is tried', async () => {
    const first = cutOff()
    const { ctx, events, sent, error, lowering } = await probed(first, http(503))
    expect(error).toBe(first)
    expect(sent).toEqual([undefined, 'low'])
    expect(events.some(event => event.type === 'adapted')).toBe(false)
    expect(ctx.adapt.record()).toEqual([])
    expect(ctx.adapt.sent(lowering)).toEqual({})
    // Tried: nobody waits on it and no call probes it again.
    await ctx.adapt.ready(lowering, ctx.stop)
    expect(ctx.adapt.probe(lowering, cutOff())).toBeUndefined()
  })

  it.each([
    [
      'a network failure',
      new ProviderError({ providerId: 'p', kind: 'network', message: 'x' }),
    ],
    [
      'a 429',
      http(429),
    ],
    [
      'a 401',
      http(401),
    ],
    [
      'a 500',
      http(500),
    ],
    [
      'a 502',
      http(502),
    ],
  ])('moves nothing when a cut-off probe fails with %s, and ends with the cut-off', async (_, second) => {
    const first = cutOff()
    const { ctx, error } = await probed(first, second)
    expect(error).toBe(first)
    expect(ctx.adapt.record()).toEqual([])
  })

  it.each([
    [
      'a reply cut off again',
      new ProviderError({
        providerId: 'p',
        kind: 'truncated',
        noAnswer: 'reply',
        message: 'x',
      }),
    ],
    [
      'a reply of only reasoning',
      reasoningOnly(),
    ],
    [
      'an unreadable reply',
      new ProviderError({ providerId: 'p', kind: 'invalid-response', message: 'x' }),
    ],
    [
      'a refusal of the model',
      new ProviderError({ providerId: 'p', kind: 'refusal', message: 'x' }),
    ],
    [
      'the attempt\'s own deadline',
      new ProviderError({ providerId: 'p', kind: 'timeout', message: 'x' }),
    ],
  ])('lowers thinking when a cut-off probe ends with %s, since the server took the request', async (_, second) => {
    const { ctx, events, error, lowering } = await probed(cutOff(), second)
    expect(error).toBe(second)
    expect(events.filter(event => event.type === 'adapted')).toHaveLength(1)
    expect(ctx.adapt.sent(lowering)).toEqual({ thinking: 'low' })
  })

  it('lowers thinking when a reasoning-only probe fails with a 503, as its own level answers nothing', async () => {
    const second = http(503)
    const { ctx, events, sent, error, lowering } = await probed(reasoningOnly(), second)
    expect(error).toBe(second)
    expect(sent).toEqual([undefined, 'low'])
    expect(events.filter(event => event.type === 'adapted')).toEqual([
      {
        type: 'adapted',
        adaptation: {
          provider: 'p',
          setting: 'thinking',
          from: 'default',
          to: 'low',
          cause: 'no-answer-thinking',
        },
      },
    ])
    expect(ctx.adapt.sent(lowering)).toEqual({ thinking: 'low' })
  })

  it('lowers thinking when a cut-off probe times out at the gateway (504)', async () => {
    const second = http(504)
    const { ctx, events, error, lowering } = await probed(cutOff(), second)
    expect(error).toBe(second)
    expect(events.filter(event => event.type === 'adapted')).toHaveLength(1)
    expect(ctx.adapt.record()).toEqual([
      {
        provider: 'p',
        setting: 'thinking',
        from: 'default',
        to: 'low',
        cause: 'cut-off-thinking',
      },
    ])
    expect(ctx.adapt.sent(lowering)).toEqual({ thinking: 'low' })
  })

  it('sends a call that meets both settings\' probes at most three times, once more per setting', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const sent: Array<[CompletionRequest['thinking'], CompletionRequest['structuredOutput']]> = []
    const both = target(async (asked) => {
      sent.push([asked.thinking, asked.structuredOutput])
      if (asked.thinking === undefined) throw cutOff()
      if (asked.structuredOutput === undefined) {
        throw new ProviderError({
          providerId: 'p',
          kind: 'no-answer',
          noAnswer: 'empty',
          message: 'empty',
        })
      }
      // Both settings are moved and tried: this failure answers each, and no fourth send follows.
      throw cutOff()
    }, {
      adapts: { thinking: 'low', prompt: true },
    })
    const error = await settle(clock, callProvider(ctx, requester, both, () => request)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect(sent).toEqual([
      [undefined, undefined],
      ['low', undefined],
      ['low', 'prompt'],
    ])
    // The thinking probe's re-send was empty, a sign the server took it; the prompt probe's failed and moved nothing.
    expect(ctx.adapt.record().map(record => record.setting)).toEqual(['thinking'])
    expect(events.filter(event => event.type === 'adapted')).toHaveLength(1)
  })

  it('ends a call that waited in ready and then fails for the same setting with no second send', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock, new AbortController(), 2)
    const sent: Array<CompletionRequest['thinking']> = []
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let probing = false
    const lowering = target(async (asked) => {
      sent.push(asked.thinking)
      if (asked.thinking === undefined) throw cutOff()
      // The probe's re-send holds until the second call has started and waits.
      if (!probing) {
        probing = true
        await gate
        return answered()
      }
      throw cutOff()
    }, lowers)
    // No `settle` here: it fires timers while it waits, and the probe's attempt must hold its deadline.
    const first = callProvider(ctx, requester, lowering, () => request)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(sent).toEqual([undefined, 'low'])
    const second = callProvider(ctx, requester, lowering, () => request).catch((caught: unknown) => caught)
    await new Promise<void>(resolve => setImmediate(resolve))
    // The second call waits in ready for the probe: it has sent nothing.
    expect(sent).toEqual([undefined, 'low'])
    release()
    await expect(first).resolves.toEqual({ text: '{}' })
    // It then went at the settled level, failed for the setting the review has moved, and was sent no second time.
    expect(await second).toBeInstanceOf(ProviderError)
    expect(sent).toEqual([undefined, 'low', 'low'])
  })

  it('ends a re-send of a provider found down with its ProviderDownError, counted nowhere, and records nothing', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const failures: unknown[] = []
    const down = target(async () => {
      // The provider is found down by other calls while this one is in flight.
      for (let call = 0; call < 3; call++) {
        ctx.health.failed(down.provider, 'p', new ProviderError({
          providerId: 'p',
          kind: 'http',
          status: 503,
          message: 'down',
        }))
      }
      throw cutOff()
    }, lowers)
    const error = await settle(clock, callProvider(ctx, requester, down, () => request, {
      onFailure: (failure) => {
        failures.push(failure)
      },
    })).catch((caught: unknown) => caught)
    expect(error).toBe(ctx.health.refused(down.provider))
    expect(failures).toEqual([error])
    // One attempt was made, no re-send, and the call's end told the health nothing: its failed event is the only one.
    expect(events.map(event => event.type)).toEqual(['call'])
    expect(events[0]).toMatchObject({ ok: false })
    expect(events[0]).not.toHaveProperty('attempts')
    expect(ctx.adapt.record()).toEqual([])
    expect(ctx.health.spent(down.provider, 'p')).toBeUndefined()
    // The probe settled: the setting is tried and nobody waits on it.
    await ctx.adapt.ready(down, ctx.stop)
    expect(ctx.adapt.probe(down, cutOff())).toBeUndefined()
  })

  it('settles a probe the token cap refused, moves nothing, and lets the provider\'s calls meet the cap themselves', async () => {
    const clock = fakeClock()
    // The first attempt fits, and its failure settles it at its whole reservation: the re-send has no room left.
    const { ctx, events } = context(clock, new AbortController(), 1, { cap: 20_000 })
    const sent: Array<CompletionRequest['thinking']> = []
    const capped = target(async (asked) => {
      sent.push(asked.thinking)
      throw new ProviderError({
        providerId: 'p',
        kind: 'truncated',
        noAnswer: 'thinking',
        message: 'cut off',
      })
    }, lowers)
    const error = await settle(clock, callProvider(ctx, requester, capped, () => request)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LimitError)
    expect(error).toMatchObject({ limit: 'token-cap' })
    expect(sent).toEqual([undefined])
    expect(ctx.adapt.record()).toEqual([])
    expect(ctx.adapt.sent(capped)).toEqual({})
    expect(events.some(event => event.type === 'adapted')).toBe(false)
    await ctx.adapt.ready(capped, ctx.stop)
    expect(ctx.adapt.probe(capped, new ProviderError({
      providerId: 'p',
      kind: 'truncated',
      noAnswer: 'thinking',
      message: 'x',
    }))).toBeUndefined()
  })
})

describe('a stage\'s check of a reply', () => {
  const reply = (text: string, usage = { inputTokens: 10, outputTokens: 5 }): Provider['complete'] => async () => ({ text, model: 'm', usage })

  it('fails a call whose check throws with that error, and returns saturated when the check says so', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const unreadable = new Error('no envelope')
    const heard: Array<[unknown, number]> = []
    const error = await callProvider(ctx, requester, target(reply('x')), () => request, {
      check: () => {
        throw unreadable
      },
      onFailure: (failure, attempts) => {
        heard.push([failure, attempts])
      },
    }).catch((caught: unknown) => caught)
    expect(error).toBe(unreadable)
    expect(heard).toEqual([
      [unreadable, 1],
    ])
    // The call answered before its check ran: its one event says so, counts its usage, and no second event follows; the health was told it answered.
    expect(events).toEqual([
      expect.objectContaining({
        type: 'call',
        ok: true,
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    ])
    expect(ctx.health.refused(target(reply('x')).provider)).toBeUndefined()
    // A check that calls the reply saturated returns it with no text, and a check that calls it an answer returns the text.
    await expect(callProvider(ctx, requester, target(reply('{"findings":[]}')), () => request, {
      check: () => ({ saturated: true }),
    })).resolves.toEqual({ saturated: true })
    await expect(callProvider(ctx, requester, target(reply('{"findings":[]}')), () => request, {
      check: () => ({ saturated: false }),
    })).resolves.toEqual({ text: '{"findings":[]}' })
    expect(events.filter(event => event.type === 'call' && event.ok)).toHaveLength(3)
  })

  it('counts the replies a check refuses as answers to the provider-down rule, so three of them never mark the provider down', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const live = target(reply('not json'))
    for (let call = 0; call < 4; call++) {
      await callProvider(ctx, requester, live, () => request, {
        check: () => {
          throw new Error('unreadable')
        },
      }).catch(() => undefined)
    }
    expect(ctx.health.refused(live.provider)).toBeUndefined()
    expect(events.some(event => event.type === 'provider-down')).toBe(false)
  })
})

describe('the events of a call', () => {
  const answer: Provider['complete'] = async () => ({ text: '{}', model: 'm' })

  /** A store that keeps what it is given in memory, as the review's store keeps a reply under its key. */
  function memory(): NonNullable<RunContext['store']> {
    const kept = new Map<string, StoredCall>()
    return {
      get: async ({ key }) => kept.get(key),
      put: async ({ key }, call) => {
        kept.set(key, call)
      },
    }
  }

  /** A request a builder made, which the store keys: the call path never keys a request it was handed otherwise. */
  const keyed = (): CompletionRequest => researchRequest('look', 'a diff', undefined, undefined, { findings: 5 })
  const researching: Requester = { profile: 'security', role: 'research' }

  it('sends call:start once per call inside its slot, after its reservation and before its attempt, numbering the review\'s calls from 1', async () => {
    const clock = fakeClock()
    const { ctx, events, progress } = context(clock)
    /** What each provider call saw when it was made: the starts sent and the calls ended. */
    const seen: Array<{ readonly starts: number, readonly ended: number }> = []
    const stated = target(async () => {
      seen.push({ starts: progress.length, ended: events.length })
      return { text: '{}', model: 'm' }
    }, worst(500))
    const first = callProvider(ctx, requester, stated, () => request)
    const second = callProvider(ctx, requester, stated, () => request)
    await Promise.all([first, second])
    expect(progress).toEqual([
      {
        type: 'call:start',
        call: 1,
        profile: 'security',
        role: 'vote',
        lens: 'impact',
        provider: { id: 'p', model: 'm' },
        reserved: 500,
        timeoutMs: 1000,
      },
      {
        type: 'call:start',
        call: 2,
        profile: 'security',
        role: 'vote',
        lens: 'impact',
        provider: { id: 'p', model: 'm' },
        reserved: 500,
        timeoutMs: 1000,
      },
    ])
    // The first start came before the first provider call, and the second only after the first call's own event.
    expect(seen).toEqual([
      { starts: 1, ended: 0 },
      { starts: 2, ended: 1 },
    ])
    expect(ctx.calls.last).toBe(2)
    expect(ctx.flying.count).toBe(0)
  })

  it('sends no call:start for a call the store answered, the down rule refused, or a limit stopped before its first attempt', async () => {
    const clock = fakeClock()
    const { ctx, progress } = context(clock, new AbortController(), 1, { cap: 100 })
    const store = memory()
    const keeping: RunContext = {
      ...ctx,
      ledger: createLedger(2_000_000),
      store,
    }
    // A first call answers and is saved: it starts, and the same call again is answered by the store.
    await callProvider(keeping, researching, target(answer), keyed)
    expect(progress).toHaveLength(1)
    progress.length = 0
    await callProvider(keeping, researching, target(async () => {
      throw new Error('the store answers')
    }), keyed)
    // A provider found down is called no more.
    const down = target(answer)
    for (let call = 0; call < 3; call++) {
      ctx.health.failed(down.provider, 'p', new ProviderError({
        providerId: 'p',
        kind: 'http',
        status: 503,
        message: 'down',
      }))
    }
    await expect(callProvider(ctx, requester, down, () => request)).rejects.toBeInstanceOf(ProviderDownError)
    // A worst case over the cap is never reserved, so the attempt is never sent.
    await expect(callProvider(ctx, requester, target(answer, worst(5000)), () => request)).rejects.toBeInstanceOf(LimitError)
    expect(progress).toEqual([])
    expect(ctx.calls.last).toBe(1)
  })

  it('sends call:retry before each wait with the attempt of its send that failed, the retries, the failure and the wait', async () => {
    const clock = fakeClock(0.5)
    const { ctx, progress } = context(clock)
    let ran = 0
    const flaky = target(async () => {
      ran += 1
      if (ran < 3) throw failure({ kind: 'http', status: 503, retryable: true })
      return { text: '{}', model: 'm' }
    }, { retries: 2 })
    await settle(clock, callProvider(ctx, requester, flaky, () => request))
    expect(progress.filter(event => event.type === 'call:retry')).toEqual([
      {
        type: 'call:retry',
        call: 1,
        attempt: 1,
        retries: 2,
        failure: { kind: 'http', status: 503 },
        attemptMs: 0,
        waitMs: 250,
      },
      {
        type: 'call:retry',
        call: 1,
        attempt: 2,
        retries: 2,
        failure: { kind: 'http', status: 503 },
        attemptMs: 0,
        waitMs: 500,
      },
    ])
    expect(progress.filter(event => event.type === 'call:start')).toHaveLength(1)
  })

  it('says how long each failed attempt ran, from its send to its failure, the wait before it left out, and tells onFailure the last one', async () => {
    const clock = fakeClock(0.5)
    const { ctx, progress } = context(clock)
    const lasting = (ms: number): Promise<void> => new Promise((resolve) => {
      clock.timer(ms, resolve)
    })
    let ran = 0
    const slow = target(async () => {
      ran += 1
      await lasting(ran === 1
        ? 600
        : 70)
      throw failure({
        kind: ran === 1
          ? 'network'
          : 'http',
        status: ran === 1
          ? undefined
          : 503,
        retryable: true,
      })
    }, { retries: 1, timeoutMs: 10_000 })
    const ended: Array<[number, number | undefined]> = []
    await expect(settle(clock, callProvider(ctx, requester, slow, () => request, {
      onFailure: (_error, attempts, attemptMs) => ended.push([attempts, attemptMs]),
    }))).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(progress.filter(event => event.type === 'call:retry')).toEqual([
      {
        type: 'call:retry',
        call: 1,
        attempt: 1,
        retries: 1,
        failure: { kind: 'network' },
        attemptMs: 600,
        waitMs: 250,
      },
    ])
    expect(ended).toEqual([
      [2, 70],
    ])
  })

  it('sends no call:retry for a failure the stop ends instead of a retry', async () => {
    const clock = fakeClock(0.5)
    const controller = new AbortController()
    const { ctx, progress } = context(clock, controller)
    const reason = new Error('stop')
    const stopped = target(async () => {
      controller.abort(reason)
      throw failure({ kind: 'network', retryable: true })
    }, { retries: 2 })
    await expect(callProvider(ctx, requester, stopped, () => request)).rejects.toBe(reason)
    expect(progress.map(event => event.type)).toEqual(['call:start'])
  })

  it('names the call in its call event, and carries the requester\'s part or finding into each event of the call', async () => {
    const clock = fakeClock()
    const { ctx, events, progress } = context(clock)
    const part = {
      index: 3,
      count: 44,
      piece: { index: 2, count: 2 },
    }
    await callProvider(ctx, { ...researching, part }, target(answer), () => request)
    const refused = failure({ kind: 'refusal' })
    await expect(callProvider(ctx, { ...requester, finding: 'f1' }, target(async () => {
      throw refused
    }), () => request)).rejects.toBe(refused)
    expect(progress).toEqual([
      expect.objectContaining({
        type: 'call:start',
        call: 1,
        role: 'research',
        part,
      }),
      expect.objectContaining({
        type: 'call:start',
        call: 2,
        role: 'vote',
        lens: 'impact',
        finding: 'f1',
      }),
    ])
    expect(progress[0]).not.toHaveProperty('finding')
    expect(events).toEqual([
      expect.objectContaining({
        type: 'call',
        call: 1,
        role: 'research',
        part,
        ok: true,
      }),
      expect.objectContaining({
        type: 'call',
        call: 2,
        role: 'vote',
        finding: 'f1',
        ok: false,
      }),
    ])
    expect(events[1]).not.toHaveProperty('part')
  })

  it('carries what the check listed and whether the reply reasoned in the ok call event, sent once the check has read the reply', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    let seen: number | undefined
    await callProvider(ctx, requester, target(async () => ({ text: '{}', model: 'm', reasoning: true })), () => request, {
      check: () => {
        seen = events.length
        return { saturated: false, listed: 3 }
      },
    })
    // The check ran before the event was sent.
    expect(seen).toBe(0)
    expect(events).toEqual([
      expect.objectContaining({
        type: 'call',
        call: 1,
        ok: true,
        listed: 3,
        reasoning: true,
      }),
    ])

    // A reply that says it did not reason says so; one whose `reasoning` is no boolean says nothing.
    await callProvider(ctx, requester, target(async () => ({ text: '{}', model: 'm', reasoning: false })), () => request)
    await callProvider(ctx, requester, target(async () => ({ text: '{}', model: 'm', reasoning: 'yes' as unknown as boolean })), () => request)
    expect(events[1]).toMatchObject({ reasoning: false })
    expect(events[1]).not.toHaveProperty('listed')
    expect(events[2]).not.toHaveProperty('reasoning')

    // A check that throws still gets the call's one ok event, with no `listed`, then the call rejects with its error.
    const unreadable = new Error('no envelope')
    await expect(callProvider(ctx, requester, target(answer), () => request, {
      check: () => {
        throw unreadable
      },
    })).rejects.toBe(unreadable)
    expect(events).toHaveLength(4)
    expect(events[3]).toMatchObject({ type: 'call', ok: true })
    expect(events[3]).not.toHaveProperty('listed')

    // A call the store answered carries what its check listed, and no call number.
    const store = memory()
    const keeping: RunContext = { ...ctx, store }
    const counting = {
      check: (): { saturated: boolean, listed: number } => ({ saturated: false, listed: 2 }),
    }
    await callProvider(keeping, researching, target(answer), keyed, counting)
    await callProvider(keeping, researching, target(answer), keyed, counting)
    expect(events[5]).toMatchObject({
      type: 'call',
      ok: true,
      reused: true,
      listed: 2,
    })
    expect(events[5]).not.toHaveProperty('call')
  })

  it('tells onEnd the spend and the start of each call that built its request, whatever its end', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const ends: Array<{ readonly spent: number, readonly startedAt: number }> = []
    const onEnd = (end: { readonly spent: number, readonly startedAt: number }): void => {
      ends.push(end)
    }
    // Time moves to 5000 before the first call builds its request.
    clock.timer(5000, () => {})
    clock.fireNext()
    const usage = { inputTokens: 10, outputTokens: 5 }
    await callProvider(ctx, requester, target(async () => ({ text: '{}', model: 'm', usage })), () => request, { onEnd })
    expect(ends).toEqual([
      { spent: 15, startedAt: 5000 },
    ])

    // A failure ends once, with what its attempt settled at.
    await expect(callProvider(ctx, requester, target(async () => {
      throw failure({ kind: 'refusal', usage })
    }), () => request, { onEnd })).rejects.toThrow('failed')
    expect(ends).toHaveLength(2)
    expect(ends[1]).toEqual({ spent: 15, startedAt: 5000 })

    // A reply the store answered spent nothing; a check that throws still tells the call's end.
    const keeping: RunContext = {
      ...ctx,
      store: memory(),
    }
    await callProvider(keeping, researching, target(answer, worst(700)), keyed, { onEnd })
    await callProvider(keeping, researching, target(answer, worst(700)), keyed, { onEnd })
    expect(ends.slice(2).map(end => end.spent)).toEqual([700, 0])
    await expect(callProvider(ctx, requester, target(answer), () => request, {
      check: () => {
        throw new Error('no envelope')
      },
      onEnd,
    })).rejects.toThrow('no envelope')
    expect(ends).toHaveLength(5)

    // A call the down rule refused never built its request, so it never tells.
    const down = target(answer)
    for (let call = 0; call < 3; call++) {
      ctx.health.failed(down.provider, 'p', new ProviderError({
        providerId: 'p',
        kind: 'http',
        status: 503,
        message: 'down',
      }))
    }
    await expect(callProvider(ctx, requester, down, () => request, { onEnd })).rejects.toBeInstanceOf(ProviderDownError)
    expect(ends).toHaveLength(5)
  })
})

describe('the stream setting of a call', () => {
  const streaming = {
    streams: true,
    adapts: { stream: true as const },
  }
  const answered = (whole?: true): CompletionResponse => ({
    text: '{}',
    model: 'm',
    ...whole === undefined
      ? {}
      : { whole },
  })
  const refused = (refusedField: 'streamOptions' | 'stream', status = 400): ProviderError => new ProviderError({
    providerId: 'p',
    kind: 'http',
    status,
    refused: refusedField,
    message: 'x',
  })
  /** The `adapted` events a context has sent, as the adaptations they carry. */
  const adaptations = (events: readonly QuorumEvent[]): unknown[] => events.flatMap(event => event.type === 'adapted'
    ? [event.adaptation]
    : [])

  it('sends the stream setting the review settled on, and adapts once on a whole reply', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const sent: Array<CompletionRequest['stream']> = []
    const api = target(async (asked) => {
      sent.push(asked.stream)
      // A server that answers a streamed request whole, and answers the whole request it is then sent as it is asked.
      return asked.stream === false
        ? answered()
        : answered(true)
    }, streaming)
    await settle(clock, callProvider(ctx, requester, api, () => request))
    expect(events.map(event => event.type)).toEqual(['adapted', 'call'])
    expect(events[0]).toEqual({
      type: 'adapted',
      adaptation: {
        provider: 'p',
        setting: 'stream',
        from: 'stream',
        to: 'whole',
        cause: 'stream-answered-whole',
      },
    })
    // The next calls are built at the settled setting, and a whole reply to a whole request adapts nothing more.
    await settle(clock, callProvider(ctx, requester, api, () => request))
    await settle(clock, callProvider(ctx, requester, api, () => request))
    expect(sent).toEqual([undefined, false, false])
    expect(adaptations(events)).toHaveLength(1)
    expect(ctx.adapt.record()).toHaveLength(1)
    // A provider whose stream is pinned reads the whole reply and moves nothing.
    const pinned = target(async () => answered(true), { streams: true })
    await settle(clock, callProvider(ctx, requester, pinned, () => request))
    expect(adaptations(events)).toHaveLength(1)
  })

  it('moves a server that refuses stream_options to a bare stream, and one that refuses the bare stream as a stream to whole replies, each probed once', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const sent: Array<CompletionRequest['stream']> = []
    const api = target(async (asked) => {
      sent.push(asked.stream)
      if (asked.stream === undefined) throw refused('streamOptions')
      if (asked.stream === 'bare') throw refused('stream')
      return answered()
    }, streaming)
    await expect(settle(clock, callProvider(ctx, requester, api, () => request))).resolves.toEqual({ text: '{}' })
    // The bare probe was refused as a stream: its step is tried and nothing moved, then whole replies answered.
    expect(sent).toEqual([undefined, 'bare', false])
    expect(adaptations(events)).toEqual([
      {
        provider: 'p',
        setting: 'stream',
        from: 'stream',
        to: 'whole',
        cause: 'stream-refused',
      },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'call', ok: true, attempts: 3 })
    await settle(clock, callProvider(ctx, requester, api, () => request))
    expect(sent).toEqual([undefined, 'bare', false, false])

    // A server that takes the bare stream stays on it.
    const second = context(clock)
    const bareSent: Array<CompletionRequest['stream']> = []
    const bare = target(async (asked) => {
      bareSent.push(asked.stream)
      if (asked.stream === undefined) throw refused('streamOptions', 422)
      return answered()
    }, streaming)
    await settle(clock, callProvider(second.ctx, requester, bare, () => request))
    await settle(clock, callProvider(second.ctx, requester, bare, () => request))
    expect(bareSent).toEqual([undefined, 'bare', 'bare'])
    expect(adaptations(second.events)).toEqual([
      {
        provider: 'p',
        setting: 'stream',
        from: 'stream',
        to: 'bare',
        cause: 'stream-refused',
      },
    ])
  })

  it('ends a call whose stream probe failed with the failure that began it, and tells a pinned stream\'s refusal as a refused stream', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const first = refused('streamOptions')
    const failing = target(async (asked) => {
      throw asked.stream === undefined
        ? first
        : new ProviderError({
            providerId: 'p',
            kind: 'http',
            status: 400,
            message: 'something else',
          })
    }, streaming)
    await expect(settle(clock, callProvider(ctx, requester, failing, () => request))).rejects.toBe(first)
    expect(adaptations(events)).toEqual([])
    // A refused stream or stream option is a refused stream to the call path, of status 400 or 422 alone.
    expect(providerFailure(refused('streamOptions'))).toEqual({ kind: 'http', status: 400, refused: 'stream' })
    expect(providerFailure(refused('stream', 422))).toEqual({ kind: 'http', status: 422, refused: 'stream' })
    expect(providerFailure(refused('stream', 500))).toEqual({ kind: 'http', status: 500 })
    expect(providerFailure(new ProviderError({
      providerId: 'p',
      kind: 'http',
      status: 400,
      refused: 'structuredOutput',
      message: 'x',
    }))).toEqual({ kind: 'http', status: 400 })
  })

  it('states a provider\'s streams and its adapts.stream as own data, and no stream a getter or an inherited field states', () => {
    const base = {
      id: 'p',
      model: 'm',
      complete: async () => answered(),
    }
    const stated = (provider: Provider): Pick<Target, 'streams' | 'adapts'> => {
      const { streams, adapts } = targetOf(provider)
      return { streams, adapts }
    }
    expect(stated({
      ...base,
      streams: true,
      adapts: { stream: true },
    })).toEqual({
      streams: true,
      adapts: { stream: true },
    })
    expect(stated({ ...base, streams: true })).toEqual({ streams: true, adapts: undefined })
    expect(stated({ ...base, streams: 'yes' } as unknown as Provider)).toEqual({ streams: false, adapts: undefined })
    const getter = Object.defineProperty({ ...base }, 'streams', {
      get: () => true,
      enumerable: true,
    }) as Provider
    expect(stated(getter)).toEqual({ streams: false, adapts: undefined })
    expect(stated(Object.assign(Object.create({ streams: true }) as object, base) as Provider)).toEqual({ streams: false, adapts: undefined })
  })

  it('keys a stored call the same whatever its stream setting', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const kept = new Map<string, StoredCall>()
    const keys = new Set<string>()
    const store: NonNullable<RunContext['store']> = {
      get: async ({ key }) => {
        keys.add(key)
        return kept.get(key)
      },
      put: async ({ key }, call) => {
        kept.set(key, call)
      },
    }
    const sent: Array<CompletionRequest['stream']> = []
    const api = target(async (asked) => {
      sent.push(asked.stream)
      return answered(true)
    }, streaming)
    const request = researchRequest('look', 'a diff', undefined, undefined, { findings: 5 })
    const keeping: RunContext = { ...ctx, store }
    const researching: Requester = { profile: 'security', role: 'research' }
    // The first send is a stream, which the server answered whole; the provider then asks for whole replies.
    await settle(clock, callProvider(keeping, researching, api, () => request))
    expect(sent).toEqual([undefined])
    // The same call at `stream: false` finds what the first stored, under the one key, and sends nothing.
    await settle(clock, callProvider(keeping, researching, api, () => request))
    expect(sent).toEqual([undefined])
    expect(ctx.adapt.sent(api)).toEqual({ stream: false })
    expect(keys.size).toBe(1)
    expect(kept.size).toBe(1)
  })
})

describe('the ceiling and the stall window of an attempt', () => {
  const headers: StreamSignal = { kind: 'headers' }
  const keepAlive: StreamSignal = { kind: 'keep-alive' }
  const data = (outputTokens: number, shown: { answer?: boolean, reasoning?: boolean } = {}): StreamSignal => ({
    kind: 'data',
    outputTokens,
    answer: shown.answer ?? false,
    reasoning: shown.reasoning ?? true,
  })
  const answer: CompletionResponse = { text: 'ok', model: 'm' }
  const at = (afterMs: number, signal: StreamSignal): { afterMs: number, signal: StreamSignal } => ({ afterMs, signal })

  /** A target of a streaming provider whose requests follow `plan`, with a reply budget of 150000 tokens, so an attempt's ceiling is 4218750 ms. */
  function streamed(clock: FakeClock, plan: Parameters<typeof streamingProvider>[1], facts: Parameters<typeof target>[1] = {}): Target {
    return target(streamingProvider(clock, plan).complete, {
      streams: true,
      maxTokens: 150_000,
      timeoutMs: undefined,
      ...facts,
    })
  }

  it('fails an attempt at the ceiling its reply budget derives, as a timeout of the core\'s own', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const never = target(() => new Promise(() => {}), { timeoutMs: undefined, maxTokens: 150_000 })
    const error = await settle(clock, callProvider(ctx, requester, never, () => request)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: 'timeout', message: 'p: no reply within 4218750 ms', stalledMs: undefined })
    expect(clock.armed).toEqual([4_218_750])
    const unbudgeted = target(() => new Promise(() => {}), { timeoutMs: undefined })
    const second = await settle(clock, callProvider(ctx, requester, unbudgeted, () => request)).catch((caught: unknown) => caught)
    expect(second).toMatchObject({ kind: 'timeout', message: 'p: no reply within 600000 ms' })
  })

  it('carries the request\'s ceiling in call:start, and stream on a streamed attempt', async () => {
    const clock = fakeClock()
    const { ctx, progress } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
      ],
      end: answer,
    }))
    await settle(clock, callProvider(ctx, requester, t, () => request))
    expect(progress[0]).toMatchObject({ type: 'call:start', timeoutMs: 4_218_750, stream: true })

    const whole = target(async () => answer, { timeoutMs: undefined, maxTokens: 150_000 })
    await settle(clock, callProvider(ctx, requester, whole, () => request))
    const start = progress.filter(event => event.type === 'call:start').at(-1)
    expect(start).toMatchObject({ timeoutMs: 4_218_750 })
    expect(start).not.toHaveProperty('stream')
    const stated = target(async () => answer, { timeoutMs: 1000 })
    await settle(clock, callProvider(ctx, requester, stated, () => request))
    expect(progress.filter(event => event.type === 'call:start').at(-1)).toMatchObject({ timeoutMs: 1000 })
  })

  it('lets a stream whose signals keep coming run past its window, and reports its first token and longest silence', async () => {
    const clock = fakeClock()
    const { ctx, events, progress } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
        at(41_000, data(10)),
        at(441_000, data(400)),
        at(1_031_000, data(900, { answer: true })),
      ],
      end: answer,
    }))
    await expect(settle(clock, callProvider(ctx, requester, t, () => request))).resolves.toEqual({ text: 'ok' })
    expect(events).toMatchObject([
      {
        type: 'call',
        ok: true,
        durationMs: 1_031_000,
        firstTokenMs: 41_000,
        longestSilenceMs: 590_000,
      },
    ])
    expect(progress[0]).toMatchObject({ type: 'call:start', timeoutMs: 4_218_750, stream: true })
    // One stall timer ran past its window, armed again for what was left, and the attempt's end cleared it.
    expect(clock.armed.filter(ms => ms === 600_000)).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  it('stalls a stream silent for its window after its first token as a timeout with stalledMs, retries it once, and fails a second stall', async () => {
    const clock = fakeClock()
    const { ctx, events, progress } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
        at(30_000, data(10)),
        // The signal never comes: the core ends the attempt first.
        at(5_000_000, keepAlive),
      ],
      end: answer,
    }), { stallTimeoutMs: 300_000, retries: 1 })
    const error = await settle(clock, callProvider(ctx, requester, t, () => request)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({
      kind: 'timeout',
      retryable: true,
      stalledMs: 300_000,
      message: 'p: no reply progress within 300000 ms',
    })
    const retries = progress.filter(event => event.type === 'call:retry')
    expect(retries).toMatchObject([
      {
        call: 1,
        attempt: 1,
        retries: 1,
        failure: { kind: 'timeout', stalledMs: 300_000 },
        attemptMs: 330_000,
      },
    ])
    expect(events).toMatchObject([
      { type: 'call', ok: false, attempts: 2 },
    ])
    expect(events[0]).not.toHaveProperty('firstTokenMs')
    expect(clock.pending()).toBe(0)
  })

  it('stalls a stream of keep-alives alone, and reports keep-alive progress', async () => {
    const clock = fakeClock()
    const { ctx, progress } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
        ...Array.from({ length: 13 }, (_, index) => at(90_000 * (index + 1), keepAlive)),
      ],
      end: answer,
    }))
    const error = await settle(clock, callProvider(ctx, requester, t, () => request)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: 'timeout', stalledMs: 600_000 })
    const reported = progress.filter(event => event.type === 'call:progress')
    expect(reported).toHaveLength(6)
    expect(reported.every(event => event.type === 'call:progress' && event.call === 1 && event.outputTokens === 0 && event.signal === 'keep-alive')).toBe(true)
  })

  it('reads a count that is no whole number as progress, floored, so a stream reporting one never stalls', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    // A server that reports chars / 4 unrounded: 2.5 every 100000 ms, seven times, so the last comes at 700000 ms, past the 600000 ms window.
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
        ...Array.from({ length: 7 }, (_, index) => at(100_000 * (index + 1), data(2.5))),
      ],
      end: answer,
    }))
    await expect(settle(clock, callProvider(ctx, requester, t, () => request))).resolves.toEqual({ text: 'ok' })
    expect(events).toMatchObject([
      {
        type: 'call',
        ok: true,
        durationMs: 700_000,
        firstTokenMs: 100_000,
        longestSilenceMs: 100_000,
      },
    ])
  })

  it('reads a stream a gateway held until its end as slow, not broken, and learns its window from it', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
        at(540_000, data(100, { answer: true })),
        at(540_000, data(900, { answer: true })),
      ],
      end: answer,
    }))
    await expect(settle(clock, callProvider(ctx, requester, t, () => request))).resolves.toEqual({ text: 'ok' })
    expect(events).toMatchObject([
      {
        type: 'call',
        ok: true,
        firstTokenMs: 540_000,
        longestSilenceMs: 540_000,
      },
    ])
    expect(ctx.clocks.window(t, 4_218_750, true)).toBe(1_620_000)
    expect(ctx.clocks.window(t, 4_218_750, false)).toBe(1_620_000)
  })

  it('never stalls the wait for a first token before 600000 ms, though the learned window is shorter', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const scripts: Array<Array<{ afterMs: number, signal: StreamSignal }>> = [
      [
        at(0, headers),
        at(10_000, data(10)),
        at(10_000, data(20, { answer: true })),
      ],
      [
        at(0, headers),
        at(1000, data(10)),
        at(3_000_000, keepAlive),
      ],
      [
        at(0, headers),
        at(450_000, data(10)),
      ],
    ]
    let next = 0
    const t = streamed(clock, () => ({ script: scripts[next++]!, end: answer }), { timeoutMs: 2_000_000 })
    // An answered streamed attempt whose longest silence was 10000 ms teaches a window of 300000 ms.
    await expect(settle(clock, callProvider(ctx, requester, t, () => request))).resolves.toEqual({ text: 'ok' })
    expect(ctx.clocks.window(t, 2_000_000, true)).toBe(300_000)
    // Silent for 300000 ms after its first data event, an attempt stalls at that window.
    const error = await settle(clock, callProvider(ctx, requester, t, () => request)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: 'timeout', stalledMs: 300_000 })
    expect(events.at(-1)).toMatchObject({ type: 'call', ok: false, durationMs: 301_000 })
    // Its headers at 0 and its first data event at 450000 ms answer: the wait for a first token is never cut before 600000 ms.
    await expect(settle(clock, callProvider(ctx, requester, t, () => request))).resolves.toEqual({ text: 'ok' })
    expect(events.at(-1)).toMatchObject({
      type: 'call',
      ok: true,
      firstTokenMs: 450_000,
      longestSilenceMs: 450_000,
    })
  })

  it('arms no stall window on a request sent as a whole reply', async () => {
    const clock = fakeClock()
    const { ctx, events, progress } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(700_000, keepAlive),
      ],
      end: answer,
    }))
    await expect(settle(clock, callProvider(ctx, requester, t, () => ({ ...request, stream: false })))).resolves.toEqual({ text: 'ok' })
    // Only the ceiling and the provider's own wait were armed, and the call reports no timings and no stream.
    expect(clock.armed).toEqual([4_218_750, 700_000])
    expect(progress[0]).not.toHaveProperty('stream')
    expect(events[0]).not.toHaveProperty('firstTokenMs')
    expect(events[0]).not.toHaveProperty('longestSilenceMs')
  })

  it('arms no stall window on a provider that does not state that it streams', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const t = target(streamingProvider(clock, () => ({
      script: [
        at(700_000, keepAlive),
      ],
      end: answer,
    }), { streams: undefined }).complete, { timeoutMs: undefined, maxTokens: 150_000 })
    await expect(settle(clock, callProvider(ctx, requester, t, () => request))).resolves.toEqual({ text: 'ok' })
    expect(clock.armed).toEqual([4_218_750, 700_000])
  })

  it('sends call:progress at most once a second, tokens when the output grew and keep-alive when only keep-alives came', async () => {
    const clock = fakeClock()
    const { ctx, progress } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
        at(100, data(10)),
        at(600, data(20)),
        at(1100, data(30)),
        at(1200, data(30)),
        at(1300, keepAlive),
        at(2200, data(50)),
        at(2300, keepAlive),
        at(3500, keepAlive),
      ],
      end: answer,
    }))
    await settle(clock, callProvider(ctx, requester, t, () => request))
    expect(progress.filter(event => event.type === 'call:progress')).toEqual([
      {
        type: 'call:progress',
        call: 1,
        outputTokens: 10,
        signal: 'tokens',
      },
      {
        type: 'call:progress',
        call: 1,
        outputTokens: 30,
        signal: 'tokens',
      },
      {
        type: 'call:progress',
        call: 1,
        outputTokens: 50,
        signal: 'tokens',
      },
      {
        type: 'call:progress',
        call: 1,
        outputTokens: 50,
        signal: 'keep-alive',
      },
    ])
  })

  it('sends no call:progress for a call that does not stream, nor for headers alone', async () => {
    const clock = fakeClock()
    const { ctx, progress } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
        at(5000, headers),
      ],
      end: answer,
    }))
    await settle(clock, callProvider(ctx, requester, t, () => request))
    const whole = target(async (given) => {
      given.onProgress?.(data(100))
      return answer
    }, { timeoutMs: undefined })
    await settle(clock, callProvider(ctx, requester, whole, () => request))
    expect(progress.filter(event => event.type === 'call:progress')).toEqual([])
  })

  it('reads a progress signal as own data, and ignores one that is no StreamSignal', async () => {
    const clock = fakeClock()
    const { ctx, events, progress } = context(clock)
    const inherited = Object.create({
      kind: 'data',
      outputTokens: 5,
      answer: true,
      reasoning: false,
    }) as StreamSignal
    const getter = {}
    Object.defineProperty(getter, 'kind', {
      enumerable: true,
      get() {
        throw new Error('a getter ran')
      },
    })
    const t = target(async (given) => {
      for (const junk of [
        null,
        'data',
        42,
        {},
        { kind: 'other' },
        { kind: 'data' },
        {
          kind: 'data',
          outputTokens: '5',
          answer: true,
          reasoning: false,
        },
        {
          kind: 'data',
          outputTokens: -1,
          answer: true,
          reasoning: false,
        },
        {
          kind: 'data',
          outputTokens: Number.POSITIVE_INFINITY,
          answer: true,
          reasoning: false,
        },
        {
          kind: 'data',
          outputTokens: Number.NaN,
          answer: true,
          reasoning: false,
        },
        {
          kind: 'data',
          outputTokens: 5,
          answer: 'yes',
          reasoning: false,
        },
        inherited,
        getter,
      ]) {
        given.onProgress?.(junk as StreamSignal)
      }
      return answer
    }, { streams: true, timeoutMs: undefined })
    await settle(clock, callProvider(ctx, requester, t, () => request))
    expect(progress.filter(event => event.type === 'call:progress')).toEqual([])
    expect(events[0]).not.toHaveProperty('firstTokenMs')
  })

  it('ignores a signal a provider sends after its attempt settled', async () => {
    const clock = fakeClock()
    const { ctx, progress } = context(clock)
    let late: (() => void) | undefined
    const t = target(async (given) => {
      late = () => given.onProgress?.(data(500))
      return answer
    }, { streams: true, timeoutMs: undefined })
    await settle(clock, callProvider(ctx, requester, t, () => request))
    late?.()
    expect(progress.filter(event => event.type === 'call:progress')).toEqual([])
  })

  it('tells the health of a call whose every attempt stalled, once three calls in a row did', async () => {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const t = streamed(clock, () => ({
      script: [
        at(0, headers),
        at(9_000_000, keepAlive),
      ],
      end: answer,
    }), { stallTimeoutMs: 300_000 })
    for (let call = 0; call < 3; call++) {
      await settle(clock, callProvider(ctx, requester, t, () => request)).catch(() => {})
    }
    expect(events.filter(event => event.type === 'provider-down')).toEqual([
      {
        type: 'provider-down',
        provider: 'p',
        kind: 'timeout',
        calls: 3,
        stalledMs: 300_000,
      },
    ])
  })
})

describe('the reply budgets a learned cut holds', () => {
  /** What a path that ends any call at 900 s does to a stream of 45000 estimated tokens: the call fails as `network`, so a second such attempt teaches the cut, which holds 36000. */
  const cut = (): StreamPlan => ({
    script: [1, 2, 3, 4, 5].map(step => ({
      afterMs: 180_000 * step,
      signal: {
        kind: 'data',
        outputTokens: 9000 * step,
        answer: false,
        reasoning: true,
      },
    })),
    end: new ProviderError({ providerId: 'p', kind: 'network', message: 'the reply stream ended before its last event' }),
  })
  const served = (replyTokens: number | undefined): ProfileBudgets => ({
    research: {
      provider: 'p',
      replyTokens,
      findings: 50,
      findingsWithoutThinking: 50,
    },
    lenses: {
      impact: { provider: 'p', replyTokens: 9216 },
    },
  })

  /** Two attempts of one call cut at 900 s, under `budgets`: the events the cut and its lowering sent. */
  async function learn(budgets: Readonly<Record<string, ProfileBudgets>>, facts: Parameters<typeof target>[1] = {}): Promise<QuorumEvent[]> {
    const clock = fakeClock()
    const { ctx, events } = context(clock)
    const t = target(streamingProvider(clock, cut).complete, {
      streams: true,
      timeoutMs: 4_000_000,
      retries: 1,
      ...facts,
    })
    await settle(clock, callProvider({ ...ctx, budgets }, requester, t, () => request)).catch(() => {})
    return events.filter(event => event.type === 'cut' || event.type === 'adapted')
  }
  const lowered = {
    type: 'adapted',
    adaptation: {
      provider: 'p',
      setting: 'replyTokens',
      from: 'derived',
      to: '36000',
      cause: 'cut-on-the-way',
    },
  }

  it('lowers a derived budget the cut is below, and records it', async () => {
    expect(await learn({
      security: served(50_000),
    })).toEqual([
      {
        type: 'cut',
        provider: 'p',
        afterMs: 900_000,
        holds: 36_000,
        lowered: true,
      },
      lowered,
    ])
  })

  it('counts a provider whose budgets are not known yet, or whose budget is not derived, as lowered', async () => {
    expect(await learn({})).toMatchObject([
      { type: 'cut', lowered: true },
      lowered,
    ])
    expect(await learn({
      security: served(undefined),
    })).toMatchObject([
      { type: 'cut', lowered: true },
      lowered,
    ])
  })

  it('lowers nothing and records nothing when every budget the provider serves is already under what the cut holds', async () => {
    expect(await learn({
      security: served(21_024),
    })).toEqual([
      {
        type: 'cut',
        provider: 'p',
        afterMs: 900_000,
        holds: 36_000,
        lowered: false,
        fits: true,
      },
    ])
  })

  it('keeps a maxTokens it is given, with no `fits`: the line names the value to lower it to', async () => {
    expect(await learn({
      security: served(150_000),
    }, { maxTokens: 150_000 })).toEqual([
      {
        type: 'cut',
        provider: 'p',
        afterMs: 900_000,
        holds: 36_000,
        lowered: false,
      },
    ])
  })
})

describe('the lane of a call', () => {
  const answer: CompletionResponse = { text: 'ok', model: 'm' }
  const holding = { requests: 1000, tokens: 900_000, tokensLimit: 1_000_000 }

  /** A context whose lanes are the adaptive ones, no `concurrency` set, on the context's clock and sink. */
  function adaptive(clock: FakeClock): ReturnType<typeof context> {
    const made = context(clock)
    return {
      ...made,
      ctx: {
        ...made.ctx,
        lanes: createLanes({ clock, emit: made.ctx.emit }),
      },
    }
  }

  /** The lane a call ran in, as it told it: what each attempt was sent as, what its stream's headers said, and how it ended. */
  function spy(): { readonly lanes: RunContext['lanes'], readonly told: unknown[] } {
    const told: unknown[] = []
    return {
      told,
      lanes: {
        run: (_target, _stop, task) => task({
          sent: (count) => {
            told.push({ sent: count })
            return {
              headers: rateLimit => told.push({ headers: rateLimit }),
              ended: end => told.push({ ended: end }),
            }
          },
        }),
        record: () => ({}),
      },
    }
  }

  it('sends each attempt with its reservation, its expected use and its reply budget, tells the lane its stream\'s headers as they come and how the attempt ended', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const { lanes, told } = spy()
    const flaky = target(streamingProvider(clock, () => ({
      script: [
        {
          afterMs: 0,
          signal: {
            kind: 'headers',
            rateLimit: {
              requests: 7,
              tokens: 900,
              tokensLimit: 1000,
              requestsResetMs: 1500,
              tokensResetMs: 0,
            },
          },
        },
        {
          afterMs: 10,
          signal: { kind: 'keep-alive' },
        },
      ],
      end: new ProviderError({
        providerId: 'p',
        kind: 'http',
        status: 429,
        retryable: true,
        retryAfterMs: 1,
        rateLimit: { requests: 0 },
        message: 'slow down',
      }),
    })).complete, {
      streams: true,
      retries: 1,
      timeoutMs: undefined,
      ...worst(10_000),
    })
    await settle(clock, callProvider({ ...ctx, lanes }, requester, flaky, () => ({ ...request, replyTokens: 9000 }))).catch(() => {})
    // 10000 reserved, 9000 of it for the reply: a ninth of the input and the reply at 4096.
    const count = { reservation: 10_000, expected: Math.ceil(1000 / 3) + 4096, replyTokens: 9000 }
    const failure = {
      answered: false,
      failure: { kind: 'http', status: 429 },
      retryAfterMs: 1,
      rateLimit: { requests: 0 },
    }
    expect(told).toEqual([
      { sent: count },
      {
        headers: {
          requests: 7,
          tokens: 900,
          tokensLimit: 1000,
          requestsResetMs: 1500,
          tokensResetMs: 0,
        },
      },
      { ended: failure },
      { sent: count },
      {
        headers: {
          requests: 7,
          tokens: 900,
          tokensLimit: 1000,
          requestsResetMs: 1500,
          tokensResetMs: 0,
        },
      },
      { ended: failure },
    ])
  })

  it('tells the lane no reply budget for a request that carries none, and counts its expected use at the default reply', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const { lanes, told } = spy()
    await callProvider({ ...ctx, lanes }, requester, target(async () => answer, worst(10_000)), () => request)
    // 10000 reserved, the reply counted at the default of 16000 tokens, so all of it: a third of nothing and 4096 of the reply.
    expect(told[0]).toEqual({
      sent: { reservation: 10_000, expected: 4096 },
    })
    expect(told[0]).not.toHaveProperty('sent.replyTokens')
  })

  it('reads a reply\'s rate-limit headers as numbers only, from own data, and tells the lane an answered attempt', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const { lanes, told } = spy()
    const read = async (rateLimit: unknown): Promise<void> => {
      await callProvider({ ...ctx, lanes }, requester, target(async () => ({ ...answer, rateLimit }) as CompletionResponse), () => request)
    }
    await read({
      requests: 3,
      tokens: -1,
      tokensLimit: Number.NaN,
      requestsResetMs: '5',
      tokensResetMs: Number.POSITIVE_INFINITY,
      extra: 1,
    })
    await read('headers')
    const inherited = Object.create({ requests: 5 }) as object
    await read(inherited)
    let ran = false
    await read(Object.defineProperty({}, 'requests', {
      enumerable: true,
      get: () => {
        ran = true
        return 9
      },
    }))
    expect(told.filter(item => typeof item === 'object' && item !== null && 'ended' in item)).toEqual([
      {
        ended: {
          answered: true,
          rateLimit: { requests: 3 },
        },
      },
      {
        ended: { answered: true },
      },
      {
        ended: { answered: true },
      },
      {
        ended: { answered: true },
      },
    ])
    expect(ran).toBe(false)
  })

  it('tells the lane the failure its provider threw, and not the core\'s own reading of it', async () => {
    const clock = fakeClock()
    const { ctx } = context(clock)
    const { lanes, told } = spy()
    const refused = new ProviderError({
      providerId: 'p',
      kind: 'http',
      status: 400,
      message: 'no',
      refused: 'stream',
    })
    await callProvider({ ...ctx, lanes }, requester, target(async () => {
      throw refused
    }), () => request).catch(() => {})
    await callProvider({ ...ctx, lanes }, requester, target(async () => {
      throw new Error('boom')
    }), () => request).catch(() => {})
    const abort = new AbortController()
    abort.abort(new LimitError('review-deadline', 'late'))
    await callProvider({ ...ctx, halt: abort.signal, lanes }, requester, target(async () => answer), () => request).catch(() => {})
    expect(told.filter(item => typeof item === 'object' && item !== null && 'ended' in item)).toEqual([
      {
        ended: {
          answered: false,
          failure: { kind: 'http', status: 400, refused: 'stream' },
        },
      },
      {
        ended: { answered: false },
      },
      {
        ended: { answered: false },
      },
    ])
  })

  it('cuts a lane at a throttle and holds its new calls for the Retry-After, its next call waiting on the review\'s clock', async () => {
    const clock = fakeClock()
    const { ctx, events } = adaptive(clock)
    const limited = target(async () => {
      throw new ProviderError({
        providerId: 'p',
        kind: 'http',
        status: 429,
        retryable: true,
        retryAfterMs: 5000,
        message: 'slow down',
      })
    })
    await expect(settle(clock, callProvider(ctx, requester, limited, () => request))).rejects.toThrow('slow down')
    expect(events.filter(event => event.type === 'concurrency')).toEqual([
      {
        type: 'concurrency',
        provider: { id: 'p', model: 'm' },
        limit: 2,
        cause: 'cut',
        from: 4,
        failure: { kind: 'http', status: 429 },
      },
      {
        type: 'concurrency',
        provider: { id: 'p', model: 'm' },
        limit: 2,
        cause: 'paused',
        waitMs: 5000,
        failure: { kind: 'http', status: 429 },
      },
    ])
    expect(clock.now()).toBe(0)
    const ok = target(async () => answer)
    await expect(settle(clock, callProvider(ctx, requester, limited, () => request))).rejects.toThrow('slow down')
    expect(clock.now()).toBe(5000)
    // Another provider's lane is not held.
    await settle(clock, callProvider(ctx, requester, ok, () => request))
    expect(clock.now()).toBe(5000)
  })

  it('reads a stall as a throttle signal, with the headers its stream sent before it', async () => {
    const clock = fakeClock()
    const { ctx, events } = adaptive(clock)
    const stalling = target(streamingProvider(clock, () => ({
      script: [
        {
          afterMs: 0,
          signal: { kind: 'headers', rateLimit: holding },
        },
        {
          afterMs: 3_000_000,
          signal: { kind: 'keep-alive' },
        },
      ],
      end: answer,
    })).complete, {
      streams: true,
      stallTimeoutMs: 1000,
      timeoutMs: undefined,
      maxTokens: 150_000,
    })
    await expect(settle(clock, callProvider(ctx, requester, stalling, () => request))).rejects.toThrow('no reply progress within 1000 ms')
    expect(events.filter(event => event.type === 'concurrency')).toEqual([
      {
        type: 'concurrency',
        provider: { id: 'p', model: 'm' },
        limit: 2,
        cause: 'cut',
        from: 4,
        failure: { kind: 'timeout', stalledMs: 1000 },
      },
    ])
    expect(ctx.lanes.record()).toEqual({
      p: {
        limit: 'auto',
        start: 4,
        lowest: 2,
        highest: 4,
        cuts: 1,
        headers: true,
      },
    })
  })

  it('grows a lane on the replies\' headers, and keeps a pinned concurrency\'s one limit', async () => {
    const clock = fakeClock()
    const { ctx, events } = adaptive(clock)
    const ok = target(async () => ({ ...answer, rateLimit: holding }))
    for (let index = 0; index < 4; index++) await settle(clock, callProvider(ctx, requester, ok, () => request))
    expect(events.filter(event => event.type === 'concurrency')).toEqual([
      {
        type: 'concurrency',
        provider: { id: 'p', model: 'm' },
        limit: 5,
        cause: 'grown',
      },
    ])
    const pinned = context(clock, new AbortController(), 3)
    for (let index = 0; index < 8; index++) await settle(clock, callProvider(pinned.ctx, requester, ok, () => request))
    expect(pinned.events.filter(event => event.type === 'concurrency')).toEqual([])
    expect(pinned.ctx.lanes.record()).toEqual({
      p: {
        limit: 3,
        start: 3,
        lowest: 3,
        highest: 3,
        cuts: 0,
        headers: true,
      },
    })
  })

  it('settles an answered attempt once when the sink throws on the lane\'s growth, and goes on with the reply', async () => {
    const clock = fakeClock()
    const made = context(clock)
    const settled: number[] = []
    const sink: Error = new Error('sink')
    const emit: RunContext['emit'] = (event) => {
      made.ctx.emit(event)
      if (event.type === 'concurrency' && event.cause === 'grown') throw sink
    }
    const ctx: RunContext = {
      ...made.ctx,
      emit,
      lanes: createLanes({ clock, emit }),
      ledger: {
        ...made.ctx.ledger,
        settle: (reserved, spent) => {
          settled.push(reserved)
          made.ctx.ledger.settle(reserved, spent)
        },
      },
    }
    const ok = target(async () => ({ ...answer, rateLimit: holding }))
    for (let index = 0; index < 4; index++) await expect(settle(clock, callProvider(ctx, requester, ok, () => request))).resolves.toMatchObject({ text: 'ok' })
    // The fourth answer grew the lane and the sink threw on it: the attempt was settled once, with the others.
    expect(settled).toHaveLength(4)
    expect(ctx.flying.count).toBe(0)
  })

  it('reads the slots a provider states as own data, a whole number of at least 1', () => {
    const provider: Provider = {
      id: 'p',
      model: 'm',
      complete: async () => answer,
    }
    expect(targetOf({ ...provider, slots: 3 }).slots).toBe(3)
    for (const slots of [
      0,
      -1,
      1.5,
      '2',
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(targetOf({ ...provider, slots } as unknown as Provider).slots).toBeUndefined()
    }
    expect(targetOf(provider).slots).toBeUndefined()
    const getter = { ...provider }
    Object.defineProperty(getter, 'slots', {
      enumerable: true,
      get: () => 3,
    })
    expect(targetOf(getter).slots).toBeUndefined()
    expect(targetOf(Object.create({ slots: 3 }, {
      id: { value: 'p' },
      model: { value: 'm' },
      complete: { value: provider.complete },
    }) as Provider).slots).toBeUndefined()
  })
})
