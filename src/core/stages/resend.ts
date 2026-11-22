import type { Fields, Probe, ProbeOutcome } from '../adapt.ts'
import { ProviderDownError } from '../errors.ts'
import type { ProviderErrorKind } from '../errors.ts'
import { failureFacts, isRefusal, isTooLarge, ownData, providerFailure } from '../facts.ts'
import { isLimit } from '../limits.ts'
import type { CompletionResponse } from '../ports.ts'
import { isTimeout } from '../retry.ts'
import type { Read, RunContext, Target } from './context.ts'

/** What a send of a call came to: the reply, the failure it ended with, or what the store answered with. */
export type Sent = { readonly reply: CompletionResponse } | { readonly failure: unknown } | Read

/**
 * The re-sends of a call whose send failed, as the adaptations answer it: while the result is a failure and the review is
 * not stopped, a failure a setting answers is sent again at that setting (`send`, with the settings to send with), as the
 * setting's probe when it is the provider's first such failure. The result is the call's last send. `settled` is the
 * settings the call's first send went with, and the loop keeps the ones it sent last.
 */
export async function sendAgain(ctx: RunContext, target: Target, first: Sent, settled: Fields, send: (fields: Fields) => Promise<Sent>): Promise<Sent> {
  let result = first
  let sentWith = settled
  while ('failure' in result && !ctx.stop.aborted) {
    const { failure } = result
    const plan = ctx.adapt.probe(target, failure)
    let again: Fields | undefined
    if (plan === undefined) {
      try {
        again = await ctx.adapt.after(target, sentWith, failure, ctx.stop)
      } catch (stopped) {
        result = { failure: stopped }
        break
      }
      if (again === undefined) break
    } else {
      again = {
        ...sentWith,
        ...plan.with,
      }
    }
    // A provider found down since is called no more, by the call's own re-send either.
    const refused = ctx.health.refused(target.provider)
    if (refused !== undefined) {
      if (plan !== undefined) ctx.adapt.settle(target, plan.setting, 'unsent')
      result = { failure: refused }
      break
    }
    sentWith = again
    if (plan === undefined) {
      result = await send(sentWith)
      continue
    }
    let outcome: ProbeOutcome = 'unsent'
    let first = false
    try {
      result = await send(sentWith)
      if ('failure' in result) {
        ({ outcome, first } = probeEnd(ctx, result.failure, plan))
      } else {
        outcome = 'answered'
      }
    } finally {
      const adaptation = ctx.adapt.settle(target, plan.setting, outcome)
      if (adaptation !== undefined) ctx.emit({ type: 'adapted', adaptation })
    }
    // A refused lowering, a prompt mode that did not answer and a lowering the server showed no sign of taking end the call with the failure that began the probe,
    // but a stream step the server refused as a stream goes on, with that failure, to the step of whole replies, which is probed once too.
    if ('failure' in result && first && !(plan.setting === 'stream' && isStreamRefusal(result.failure))) result = { failure }
  }
  return result
}

/**
 * How a probe's re-send ended, from the failure it ended with: a limit, the review's stop, a refusal as too large
 * or the down rule ended it before the server could answer (`unsent`, and the re-send's failure stands); a 400 or
 * 422 refused the value (`refused`), and the call ends with the failure that began the probe (`first`). Any other
 * failure is the server's or the network's. Prompt mode moves only on an answer, so its failed probe is `failed`
 * and ends with `first`. A thinking probe moves the level only on evidence (ruling R5): after a reply of only
 * reasoning, whose own level answered nothing, any failure is `failed`; after a cut-off, `failed` only when the
 * server showed it took the request, else `unsent` and `first`: tried, nothing moved and nothing recorded, so the
 * part splits.
 */
function probeEnd(ctx: RunContext, failure: unknown, plan: Probe): { readonly outcome: ProbeOutcome, readonly first: boolean } {
  if (ctx.stop.aborted || isLimit(failure) || isTooLarge(failure) || failure instanceof ProviderDownError) return { outcome: 'unsent', first: false }
  if (isRefusal(failure)) return { outcome: 'refused', first: true }
  if (plan.setting === 'structuredOutput' || plan.setting === 'stream') return { outcome: 'failed', first: true }
  if (plan.cause === 'cut-off-thinking' && !tookTheRequest(failure)) return { outcome: 'unsent', first: true }
  return { outcome: 'failed', first: false }
}

/** Whether `error` is a refusal that names streaming itself (`refused` is `stream`): the server takes no stream at all. */
function isStreamRefusal(error: unknown): boolean {
  return isRefusal(error) && ownData(error, 'refused') === 'stream'
}

/** The kinds of failure that show the server took the request and read it: its reply was cut off, empty, only reasoning, unreadable or refused by the model. */
const TOOK_THE_REQUEST: ReadonlySet<ProviderErrorKind> = new Set([
  'truncated',
  'no-answer',
  'invalid-response',
  'refusal',
])

/** Whether `failure` shows the server took the request: a reply of one of those kinds, or a timeout, a gateway's 504 and 524 included. */
function tookTheRequest(failure: unknown): boolean {
  const read = providerFailure(failure)
  return (read !== undefined && TOOK_THE_REQUEST.has(read.kind)) || isTimeout(failureFacts(failure))
}
