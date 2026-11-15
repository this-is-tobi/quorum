import { describe, expect, it, onTestFinished } from 'vitest'
import { fakeClock, settle } from '../../testing/clock.ts'
import type { FakeClock } from '../../testing/clock.ts'
import { createLimiter } from '../concurrency.ts'
import { ProviderError } from '../errors.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../ports.ts'
import type { QuorumEvent } from '../types.ts'
import { callProvider, reservationOf, targetOf } from './context.ts'
import type { Requester, RunContext, Target } from './context.ts'

/** A context of one review: its events as the sink would receive them, and what `fail` was given. */
function context(clock: FakeClock, controller = new AbortController(), concurrency = 1): { ctx: RunContext, events: QuorumEvent[], failures: unknown[] } {
  const events: QuorumEvent[] = []
  const failures: unknown[] = []
  const ctx: RunContext = {
    limit: createLimiter(concurrency),
    emit: (event) => {
      if (!controller.signal.aborted) events.push(event)
    },
    signal: controller.signal,
    fail: (error) => {
      failures.push(error)
    },
    maxFindings: 50,
    clock,
  }
  return { ctx, events, failures }
}

/** A target whose provider's own id is not the id of its ref, which is the one an error and an event name. */
function target(complete: Provider['complete'], facts: Partial<Pick<Target, 'timeoutMs' | 'retries'>> = {}): Target {
  return {
    provider: { id: 'live-id', model: 'm', complete },
    ref: { id: 'p', model: 'm' },
    timeoutMs: 1000,
    retries: 0,
    worstCase: undefined,
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
    })
    await expect(settle(clock, queued)).resolves.toBe('queued')
    expect(order).toEqual(['first', 'first', 'queued'])
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
    const { ctx, failures } = context(clock)
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
    expect(failures).toEqual([])
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
