import { attemptCeiling } from '../clocks.ts'
import { ProviderError } from '../errors.ts'
import type { LaneAttempt } from '../lanes.ts'
import type { CompletionRequest, CompletionResponse } from '../ports.ts'
import { DEFAULT_REPLY_TOKENS, replyLimit } from '../tokens.ts'
import { noteSignal, signalOf } from '../watch.ts'
import type { ProgressReports, Watch } from '../watch.ts'
import type { RunContext, Target } from './context.ts'

/** Whether an attempt of `request` is streamed: the target states that it streams and the request does not ask for a whole reply. */
export function streamsAttempt(target: Target, request: CompletionRequest): boolean {
  return target.streams && request.stream !== false
}

/** The ceiling of an attempt of `request`: the deadline the provider stated, else the one its reply budget sizes. */
export function ceilingOf(target: Target, request: CompletionRequest): number {
  return attemptCeiling(target.timeoutMs, replyLimit(request, target.maxTokens) ?? DEFAULT_REPLY_TOKENS)
}

/**
 * One attempt of a call, settled once, by the first of: the provider's reply or failure; its own
 * ceiling (`ceilingOf`), as a `timeout` error of the core's own with the attempt's signal aborted with it as the
 * reason; its stall, for a streamed attempt (`watch`), as a `timeout` error with `stalledMs`; the review's halt (its
 * abort, its deadline or the end of the interrupt's grace), with the halt's reason.
 * The attempt's timers and the join to the review's halt go when it settles, on every path. A provider that throws before
 * it returns a promise, or returns a plain object, is handled; whatever it does once the attempt
 * settled is caught and ignored, and it is never an unhandled rejection. The join is one listener,
 * not `AbortSignal.any`, so nothing builds up on a signal that outlives thousands of attempts.
 *
 * A streamed attempt is handed an `onProgress`, and stalls when no headers or data event has come for its window
 * (`Clocks.window`): one timer at a time, which when it fires stalls the attempt if its last progress is a whole window
 * old, and else is armed again for what is left, so a stream that keeps coming arms one timer however many events it
 * sends; the first data event arms it again only when the window shrinks to the learned one. Keep-alives are no progress.
 */
export function attempt(ctx: RunContext, target: Target, request: CompletionRequest, streamed?: { readonly watch: Watch, readonly progressed: ProgressReports['progressed'] }, lane?: LaneAttempt): Promise<CompletionResponse> {
  if (ctx.halt.aborted) return Promise.reject(ctx.halt.reason)
  const watch = streamed?.watch
  const controller = new AbortController()
  const ceiling = ceilingOf(target, request)
  return new Promise<CompletionResponse>((resolve, reject) => {
    let settled = false
    let cancel = (): void => {}
    let cancelStall = (): void => {}
    /** When the stall timer is due, on the review's clock, while one is armed. */
    let dueAt: number | undefined
    /** True the first time, when it clears the timers and the listener; false once the attempt has settled. */
    function done(): boolean {
      if (settled) return false
      settled = true
      cancel()
      cancelStall()
      ctx.halt.removeEventListener('abort', onAbort)
      return true
    }
    function onAbort(): void {
      if (!done()) return
      controller.abort(ctx.halt.reason)
      reject(ctx.halt.reason)
    }
    function arm(ms: number): void {
      cancelStall()
      dueAt = ctx.clock.now() + ms
      cancelStall = ctx.clock.timer(ms, onStall)
    }
    function onStall(): void {
      if (settled || watch === undefined) return
      const window = ctx.clocks.window(target, ceiling, watch.firstDataAt !== undefined)
      const quiet = ctx.clock.now() - watch.progressAt
      if (quiet < window) {
        arm(Math.max(1, Math.ceil(window - quiet)))
        return
      }
      if (!done()) return
      const error = new ProviderError({
        providerId: target.ref.id,
        kind: 'timeout',
        message: `no reply progress within ${window} ms`,
        stalledMs: window,
      })
      controller.abort(error)
      reject(error)
    }
    function onProgress(value: unknown): void {
      if (settled || streamed === undefined) return
      const { watch: seen } = streamed
      const signal = signalOf(value)
      if (signal === undefined) return
      try {
        const now = ctx.clock.now()
        const first = noteSignal(seen, signal, now)
        if (signal.kind === 'headers') {
          lane?.headers(signal.rateLimit)
          return
        }
        if (signal.kind === 'keep-alive') {
          streamed.progressed('keep-alive', seen.outputTokens)
          return
        }
        if (first) {
          const next = ctx.clocks.window(target, ceiling, true)
          if (now + next < seen.sentAt + ceiling && (dueAt === undefined || now + next < dueAt)) arm(next)
        }
        streamed.progressed('data', seen.outputTokens)
      } catch {
        // A sink that throws has ended the review already (`emit`), and a signal is only advice: it never fails the adapter that reads the stream.
      }
    }
    cancel = ctx.clock.timer(ceiling, () => {
      if (!done()) return
      const error = new ProviderError({ providerId: target.ref.id, kind: 'timeout', message: `no reply within ${ceiling} ms` })
      controller.abort(error)
      reject(error)
    })
    if (watch !== undefined) {
      const window = ctx.clocks.window(target, ceiling, false)
      if (window < ceiling) arm(window)
    }
    ctx.halt.addEventListener('abort', onAbort, { once: true })
    let call: Promise<CompletionResponse>
    try {
      call = Promise.resolve(target.provider.complete({
        ...request,
        signal: controller.signal,
        ...watch === undefined
          ? {}
          : { onProgress },
      }))
    } catch (error) {
      if (done()) reject(error)
      return
    }
    call.then((response) => {
      if (done()) resolve(response)
    }, (error: unknown) => {
      if (done()) reject(error)
    })
  })
}
