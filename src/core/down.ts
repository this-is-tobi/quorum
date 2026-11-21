import { ProviderDownError } from './errors.ts'
import type { NoAnswer, ProviderErrorKind } from './errors.ts'
import type { Provider } from './ports.ts'
import { lackOf, providerFailure } from './stages/context.ts'

/**
 * Which provider is down, for one review: a provider is called no more once three of its calls in a row
 * ended with a failure of its own, across every profile and role that shares it. It is kept per provider
 * object, which a config builds once per name and shares, never per id, so two providers named alike are
 * counted apart.
 *
 * What counts is a call that ended, after its retries, with an own-data `kind` of `DOWN_KINDS`: the server is
 * unreachable, refuses the caller, answers in a way no content explains, or answers with no answer at all
 * (`no-answer`: only reasoning, or nothing, which a server that mishandles its structured output or puts its
 * answer in a reasoning field does every time). What resets the count is a call that returned a reply, whatever
 * its envelope: the server answered, and a reply that does not parse is the content's fault, not the
 * provider's, so it is never counted. Every other end is neutral and changes neither
 * the count nor the state: a limit, a refusal as too large, a reply cut off, a refusal, an abort, a kind no
 * provider error has, and a call the rule itself refused. A failure is read through `providerFailure`, its
 * `kind` and `status` (and, for `no-answer`, what it lacked) and nothing else, so a message a server wrote
 * decides nothing.
 *
 * A provider found down stays down for the review: calls in flight run to their end and an answer is read as
 * any is, but no later call is sent. The count is of the order calls end.
 */
export const DOWN_AFTER = 3

/** The kinds of failure that count toward a provider being down. */
export const DOWN_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'http',
  'network',
  'timeout',
  'process',
  'unsupported',
  'invalid-response',
  'no-answer',
])

/** What a review has seen of one provider's calls. */
interface Counts {
  /** Calls in a row that ended with a counted failure, since the last reply. */
  streak: number
  /** Calls that ended with a counted failure, in all. */
  failures: number
  /** Calls that ended in any way: a reply, a counted failure or a neutral one. */
  ended: number
  /** The last counted failure: its kind, status and thrown value. */
  last?: { readonly kind: ProviderErrorKind, readonly status?: number, readonly noAnswer?: NoAnswer, readonly error: unknown }
  /** The error of the provider once it is found down. */
  down?: ProviderDownError
}

/** What one review knows of its providers' health. */
export interface Health {
  /** The provider's error once it is found down, else `undefined`: a call checks it before it builds its request. */
  readonly refused: (provider: Provider) => ProviderDownError | undefined
  /** A call returned a reply: the count of calls in a row starts again. */
  readonly answered: (provider: Provider) => void
  /** A call ended with `error`: the provider's error the first time the failure finds it down, `undefined` otherwise. */
  readonly failed: (provider: Provider, id: string, error: unknown) => ProviderDownError | undefined
  /**
   * The end's rule: the provider's error when each of its calls failed for a reason of its own, and fewer than
   * three did, so it was never found down; else `undefined`, a provider that was never called included. The
   * error counts the calls and its `streak` is false.
   */
  readonly spent: (provider: Provider, id: string) => ProviderDownError | undefined
}

/** What a `no-answer` failure lacked, as a fact for the provider's error: nothing for any other kind. */
function lackFacts(kind: ProviderErrorKind, error: unknown): { readonly noAnswer?: NoAnswer } {
  const lack = kind === 'no-answer'
    ? lackOf(error)
    : undefined
  return lack === undefined
    ? {}
    : { noAnswer: lack.noAnswer }
}

/** A review's own record of its providers' health. */
export function createHealth(): Health {
  const records = new Map<Provider, Counts>()
  const recordOf = (provider: Provider): Counts => {
    const known = records.get(provider)
    if (known !== undefined) return known
    const fresh: Counts = { streak: 0, failures: 0, ended: 0 }
    records.set(provider, fresh)
    return fresh
  }
  return {
    refused: provider => records.get(provider)?.down,
    answered: (provider) => {
      const record = recordOf(provider)
      record.ended += 1
      record.streak = 0
    },
    failed: (provider, id, error) => {
      const record = recordOf(provider)
      record.ended += 1
      const failure = providerFailure(error)
      if (failure === undefined || !DOWN_KINDS.has(failure.kind)) return undefined
      record.streak += 1
      record.failures += 1
      const facts = {
        ...failure,
        ...lackFacts(failure.kind, error),
      }
      record.last = { ...facts, error }
      if (record.down !== undefined || record.streak < DOWN_AFTER) return undefined
      record.down = new ProviderDownError({
        providerId: id,
        ...facts,
        count: record.streak,
        streak: true,
        cause: error,
      })
      return record.down
    },
    spent: (provider, id) => {
      const record = records.get(provider)
      if (record?.last === undefined || record.failures !== record.ended || record.failures >= DOWN_AFTER) return undefined
      const { error, ...failure } = record.last
      return new ProviderDownError({
        providerId: id,
        ...failure,
        count: record.failures,
        streak: false,
        cause: error,
      })
    },
  }
}
