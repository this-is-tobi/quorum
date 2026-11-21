import { getEventListeners } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import { fakeClock, settle } from '../../testing/clock.ts'
import type { FakeClock } from '../../testing/clock.ts'
import { createLimiter } from '../concurrency.ts'
import { createHealth } from '../down.ts'
import { ProviderError } from '../errors.ts'
import { createLedger, DEFAULT_REVIEW_TIMEOUT_MS, LimitError } from '../limits.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../ports.ts'
import type { QuorumEvent } from '../types.ts'
import { callProvider, reservationOf, roomOf, targetOf } from './context.ts'
import type { Requester, RunContext, Target } from './context.ts'

/**
 * A context of one review: its events as the sink would receive them. When
 * `limits.deadlineMs` is given, a timer on the fake clock aborts the review's deadline with its failure, as the
 * review arms it, and `stop` joins that to the review's signal.
 */
function context(clock: FakeClock, controller = new AbortController(), concurrency = 1, limits: { readonly cap?: number, readonly deadlineMs?: number } = {}): { ctx: RunContext, events: QuorumEvent[] } {
  const events: QuorumEvent[] = []
  const deadlineMs = limits.deadlineMs ?? DEFAULT_REVIEW_TIMEOUT_MS
  const deadline = new AbortController()
  if (limits.deadlineMs !== undefined) {
    clock.timer(deadlineMs, () => {
      deadline.abort(new LimitError('review-deadline', `the review reached its deadline of ${deadlineMs} ms`))
    })
  }
  const ctx: RunContext = {
    limit: createLimiter(concurrency),
    ledger: createLedger(limits.cap ?? 2_000_000),
    emit: (event) => {
      if (!controller.signal.aborted) events.push(event)
    },
    signal: controller.signal,
    stop: AbortSignal.any([controller.signal, deadline.signal]),
    deadline: { at: clock.now() + deadlineMs, ms: deadlineMs },
    health: createHealth(),
    lacked: new Set(),
    maxFindings: 50,
    budgets: {},
    concurrency,
    clock,
  }
  return { ctx, events }
}

/** A target whose provider's own id is not the id of its ref, which is the one an error and an event name. */
function target(complete: Provider['complete'], facts: Partial<Pick<Target, 'timeoutMs' | 'retries' | 'worstCase' | 'room' | 'window' | 'maxTokens' | 'thinking'>> = {}): Target {
  return {
    provider: { id: 'live-id', model: 'm', complete },
    ref: { id: 'p', model: 'm' },
    timeoutMs: 1000,
    retries: 0,
    worstCase: undefined,
    room: undefined,
    window: undefined,
    maxTokens: undefined,
    thinking: 'default',
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
    await expect(callProvider(ctx, requester, target(async () => ({ text: 'ok', model: 'm' })), () => request)).resolves.toBe('ok')
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
    await expect(callProvider(ctx, requester, target(plain), () => request)).resolves.toBe('plain')
    expect(clock.pending()).toBe(0)
  })

  it('gives a provider that states no deadline 600000 ms, and reads a stated one as an own data property, never running a getter', () => {
    const complete = async (): Promise<CompletionResponse> => ({ text: '', model: 'm' })
    const provider: Provider = { id: 'p', model: 'm', complete }
    expect(targetOf(provider)).toEqual({
      provider,
      ref: { id: 'p', model: 'm' },
      timeoutMs: 600_000,
      retries: 0,
      thinking: 'default',
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
    expect(targetOf(getter).timeoutMs).toBe(600_000)
    expect(read).toBe(false)

    const inherited: Provider = Object.assign(Object.create({ timeoutMs: 1000 }), provider)
    expect(targetOf(inherited).timeoutMs).toBe(600_000)

    expect(targetOf({ ...provider, timeoutMs: 5 }).timeoutMs).toBe(600_000)
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
    await expect(settle(clock, call)).resolves.toBe('second')
    expect(clock.armed.slice(0, 3)).toEqual([1000, 250, 1000])
    expect(events[0]).toEqual({
      type: 'call',
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
    await expect(settle(clock, queued)).resolves.toBe('queued')
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
    await expect(settle(clock, callProvider(ctx, requester, limited, () => request))).resolves.toBe('after the hint')
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
    const first = settle(clock, callProvider(ctx, researcher, down, () => request, (error, attempts) => {
      order.push(`failed ${attempts} ${error === thrown}`)
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
    await expect(callProvider(ctx, requester, metered, () => request)).resolves.toBe('ok')
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
    await expect(one).resolves.toBe('first')
    await expect(two).resolves.toBe('second')
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
    await expect(one).resolves.toBe('first')
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
