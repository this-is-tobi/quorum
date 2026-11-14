import { describe, expect, it, onTestFinished } from 'vitest'
import { fakeClock, settle } from '../../testing/clock.ts'
import type { FakeClock } from '../../testing/clock.ts'
import { createLimiter } from '../concurrency.ts'
import { ProviderError } from '../errors.ts'
import type { CompletionRequest, CompletionResponse, Provider } from '../ports.ts'
import type { QuorumEvent } from '../types.ts'
import { callProvider, targetOf } from './context.ts'
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
function target(complete: Provider['complete'], facts: Partial<Pick<Target, 'timeoutMs'>> = {}): Target {
  return {
    provider: { id: 'live-id', model: 'm', complete },
    ref: { id: 'p', model: 'm' },
    timeoutMs: 1000,
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
