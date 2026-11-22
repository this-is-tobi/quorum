import { holdsReasoning } from './output.ts'
import type { CompletionResponse } from './ports.ts'
import { isRefusal, lackOf, ownData } from './facts.ts'
import type { Target } from './stages/context.ts'
import type { Adaptation } from './types.ts'

/**
 * What quorum moves by itself for the rest of one review, and how it finds out that a move helps: the probe.
 *
 * Three settings move, each only for a provider that states it can (`Provider.adapts`, which an explicit option
 * or a control `extraBody` sets leaves unstated, so an explicit setting is never undone): `thinking`, lowered on
 * a reply that ran out of room while reasoning or held only reasoning, `structuredOutput`, moved from JSON
 * mode to prompt mode on an empty reply or a 400 or 422 that names the structured-output field, and `stream`, which
 * steps down twice: to a stream with no stream options (`bare`) on a 400 or 422 that names them, and to whole replies on
 * one that names streaming itself, each step with its own probe, and to whole replies at once, with no probe, when a
 * server answered a streamed call whole (`answeredWhole`). A provider's
 * state is kept per provider object, as its health is, and per setting it goes through these phases, once:
 *
 * - none: no call has needed the setting, and every call sends the provider's own;
 * - pending: the first call whose failure the setting answers is its probe (`probe` answers it and marks the
 *   setting pending at once, so no second call becomes one). The probe sends its request once more with the new
 *   setting, inside its own slot, while the calls already in flight still hold the old one. The provider's new
 *   calls wait for it (`ready`), inside their slots and before they build a request, so they go at the settled
 *   setting, and a call that was in flight and then fails the way the probe did waits for it too (`after`);
 * - settled: `settle` runs on every end of the probe's re-send, however it ended, so no wait outlives it. The
 *   thinking probe moves the level only on evidence the server took the request: it answered, or its reply was
 *   cut off, empty, only reasoning, unreadable or refused by the model, or it timed out (a gateway's 504 and 524
 *   included), and a reply that held only reasoning moves it on any failure but a 400 or 422, since the server's
 *   own level answered nothing. A 400 or 422 refuses it, which records `lowering-refused` and leaves the server's
 *   own level. Any other failure of a probe sent after a cut-off (`network`, a 429, a 401, 403 or 404, a 500, 502
 *   or 503) shows nothing of the server's level: it moves nothing and records nothing, and the call ends with its
 *   first failure, so the part splits. The prompt probe moves only when it answered, and a failed one leaves JSON
 *   mode and records nothing; a stream step's probe moves it on an answer alone, as the prompt probe does. A probe a limit or the stop ended never reached the server: it moves nothing and
 *   records nothing. Either way the setting counts as tried, so each setting is probed at most once per provider
 *   in a review.
 *
 * A call in flight at the old setting when the probe settles at a new one is sent once more at it (`after`), so
 * no vote fails and no research part splits for a setting the review has already moved. The bound is per
 * setting: the probe, and at most the calls already in flight, each sent once more.
 *
 * Every wait ends with the review's stop, its abort or its deadline. A wait holds a slot, and holds no ledger
 * reservation; the probe's re-send needs no slot but its own, so no wait is for a slot another call holds.
 *
 * A research reply that shows no reasoning (`reasoned`) teaches the provider's later requests to ask for more
 * findings (`findings`). Nothing here carries from one review to the next: the state is the review's alone.
 */

/** The request fields an adaptation sets. */
export interface Fields {
  readonly thinking?: 'low' | 'off'
  readonly structuredOutput?: 'prompt'
  readonly stream?: false | 'bare'
}

/** A setting that moves. */
export type Setting = 'thinking' | 'structuredOutput' | 'stream'

/** One step of a setting that has its own phase: the stream has two, a bare stream and whole replies. */
type Step = 'thinking' | 'structuredOutput' | 'streamBare' | 'streamWhole'

/** The steps of each setting. */
const STEPS: Readonly<Record<Setting, readonly Step[]>> = {
  thinking: ['thinking'],
  structuredOutput: ['structuredOutput'],
  stream: ['streamBare', 'streamWhole'],
}

/**
 * How a probe's re-send ended: `answered`, the server returned a reply; `refused`, a 400 or 422; `failed`, the
 * server took the request and failed (a thinking probe after a reply of only reasoning fails this way on any
 * failure that is no refusal); `unsent`, nothing shows the server took the request: a limit, the stop or the down
 * rule ended it, or a failure after a cut-off that is no sign of the server's level.
 */
export type ProbeOutcome = 'answered' | 'refused' | 'failed' | 'unsent'

/** What a call that became a probe sends, why, and how it is recorded. */
export interface Probe {
  readonly setting: Setting
  readonly cause: Adaptation['cause']
  readonly with: Fields
}

/** What one review's adaptations are asked and told. */
export interface Adaptations {
  /** The request fields the provider's settings have moved to so far: none until a probe moves one. */
  readonly sent: (target: Target) => Fields
  /** The probe `failure` makes of its call, or `undefined` when it answers none or its setting is pending or tried: the call becomes the setting's probe, which `settle` ends. */
  readonly probe: (target: Target, failure: unknown) => Probe | undefined
  /** The probe's re-send ended as `outcome`: the setting settles, waiters are released, and the record it makes, if it makes one. A setting settles once. */
  readonly settle: (target: Target, setting: Setting, outcome: ProbeOutcome) => Adaptation | undefined
  /** A research reply: one that shows no reasoning teaches the provider's later requests to ask for more findings. */
  readonly reasoned: (target: Target, response: CompletionResponse) => void
  /** The findings a research request asks for: `budget.findings`, or `budget.findingsWithoutThinking` once a reply showed no reasoning. */
  readonly findings: (target: Target, budget: { readonly findings: number, readonly findingsWithoutThinking: number }) => number
  /**
   * A streamed call came back as a whole reply: the provider moves to whole replies for the rest of the review, with no
   * probe, once, when it states that it may (`adapts.stream`) and has not moved there; the record it makes, else `undefined`.
   */
  readonly answeredWhole: (target: Target) => Adaptation | undefined
  /**
   * A move the review made with no probe, from a fact the call path read (a learned cut that lowers a derived reply
   * budget): it is recorded as it is, in the order it happened, and the caller sends its `adapted` event.
   */
  readonly recorded: (adaptation: Adaptation) => void
  /** What the review has moved, in the order it happened. */
  readonly record: () => readonly Adaptation[]
  /** Resolves once no probe of the provider is pending, so a call sends its request at the settled settings; `stop` ends the wait with its reason. */
  readonly ready: (target: Target, stop: AbortSignal) => Promise<void>
  /**
   * A call sent with `sent` failed with `failure`, which a probe's setting answers: once that probe settles, the
   * request fields the call is to be sent with once more, or `undefined` when the setting did not move away from
   * `sent` (it was refused, it failed, it was never probed, or the call was sent at the settled setting). `stop` ends the wait with its reason.
   */
  readonly after: (target: Target, sent: Fields, failure: unknown, stop: AbortSignal) => Promise<Fields | undefined>
}

/** How low each level is: the lowering of a level to a higher one is none. */
const LEVELS = { off: 0, low: 1, default: 2 } as const

/**
 * The level the review may lower `target`'s thinking to: the `adapts.thinking` the provider states when it is below its
 * own level, else none. A level the config sets (an option or a control in `extraBody`) states none, so the review never
 * lowers it.
 */
export function thinkingLowersTo(target: Pick<Target, 'thinking' | 'adapts'>): 'low' | 'off' | undefined {
  const level = target.adapts?.thinking
  return level !== undefined && LEVELS[level] < LEVELS[target.thinking]
    ? level
    : undefined
}

/** One step's probe, from the call that began it to its settlement. */
interface Pending {
  readonly phase: 'pending'
  readonly cause: Adaptation['cause']
  /** The level the thinking probe lowers to; absent for the other steps. */
  readonly level?: 'low' | 'off'
  readonly wait: Promise<void>
  readonly release: () => void
}

/** A step whose probe has ended: it is tried, and never probed again. */
interface Tried {
  readonly phase: 'tried'
}

/** What one review knows of one provider. */
interface State {
  thinking?: Pending | Tried
  structuredOutput?: Pending | Tried
  streamBare?: Pending | Tried
  streamWhole?: Pending | Tried
  /** What the settled probes moved. */
  moved: { thinking?: 'low' | 'off', structuredOutput?: 'prompt', stream?: false | 'bare' }
  /** A research reply showed no reasoning. */
  noReasoning: boolean
}

/** `wait`, ended at once with the stop's reason when `stop` aborts first; the listener goes with whichever ends first. */
function until(wait: Promise<void>, stop: AbortSignal): Promise<void> {
  if (stop.aborted) return Promise.reject(stop.reason)
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(stop.reason)
    stop.addEventListener('abort', onAbort, { once: true })
    void wait.then(() => {
      stop.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

/** A review's adaptations: every provider starts from its own settings, and nothing carries to another review. */
export function createAdaptations(): Adaptations {
  const states = new Map<object, State>()
  const records: Adaptation[] = []
  const stateOf = (target: Target): State => {
    const known = states.get(target.provider)
    if (known !== undefined) return known
    const fresh: State = { moved: {}, noReasoning: false }
    states.set(target.provider, fresh)
    return fresh
  }

  /** What `failure` asks of `target`, when the provider states it can, whatever the step's phase: the setting and its step, the cause, and the level a lowering goes to. */
  const answer = (target: Target, failure: unknown): { readonly setting: Setting, readonly step: Step, readonly cause: Adaptation['cause'], readonly level?: 'low' | 'off' } | undefined => {
    const lack = lackOf(failure)
    const level = thinkingLowersTo(target)
    if (lack?.noAnswer === 'thinking' && level !== undefined) {
      return {
        setting: 'thinking',
        step: 'thinking',
        cause: lack.kind === 'truncated'
          ? 'cut-off-thinking'
          : 'no-answer-thinking',
        level,
      }
    }
    const refused = isRefusal(failure)
      ? ownData(failure, 'refused')
      : undefined
    if (target.adapts?.stream === true && (refused === 'streamOptions' || refused === 'stream')) {
      return {
        setting: 'stream',
        step: refused === 'streamOptions'
          ? 'streamBare'
          : 'streamWhole',
        cause: 'stream-refused',
      }
    }
    if (target.adapts?.prompt !== true) return undefined
    if (lack?.kind === 'no-answer' && lack.noAnswer === 'empty') return { setting: 'structuredOutput', step: 'structuredOutput', cause: 'empty-reply' }
    return refused === 'structuredOutput'
      ? { setting: 'structuredOutput', step: 'structuredOutput', cause: 'format-refused' }
      : undefined
  }

  /** The fields a provider's settled probes have moved, as a copy. */
  const movedOf = (state: State): Fields => ({ ...state.moved })

  /** The probe pending on any step of `setting`, when there is one: the steps of a setting never probe at once. */
  const pendingIn = (state: State, setting: Setting): { readonly step: Step, readonly pending: Pending } | undefined => {
    for (const step of STEPS[setting]) {
      const phase = state[step]
      if (phase?.phase === 'pending') return { step, pending: phase }
    }
    return undefined
  }

  const pendingOf = (state: State): Pending | undefined => Object.values(STEPS).flat().map(step => state[step]).find((phase): phase is Pending => phase?.phase === 'pending')

  return {
    sent: target => movedOf(stateOf(target)),
    probe: (target, failure) => {
      const asked = answer(target, failure)
      if (asked === undefined) return undefined
      const state = stateOf(target)
      if (state[asked.step] !== undefined || pendingIn(state, asked.setting) !== undefined) return undefined
      let release = (): void => {}
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      state[asked.step] = {
        phase: 'pending',
        cause: asked.cause,
        ...asked.level === undefined
          ? {}
          : { level: asked.level },
        wait,
        release,
      }
      return {
        setting: asked.setting,
        cause: asked.cause,
        with: asked.setting === 'thinking'
          ? { thinking: asked.level }
          : asked.setting === 'stream'
            ? {
                stream: asked.step === 'streamBare'
                  ? 'bare'
                  : false,
              }
            : { structuredOutput: 'prompt' },
      }
    },
    settle: (target, setting, outcome) => {
      const state = stateOf(target)
      const found = pendingIn(state, setting)
      if (found === undefined) return undefined
      const { step, pending: probe } = found
      state[step] = { phase: 'tried' }
      let record: Adaptation | undefined
      if (setting === 'thinking' && probe.level !== undefined) {
        // The call path settles `failed` only when the server showed it took the request, so the level moves on an answer or a failure.
        if (outcome === 'answered' || outcome === 'failed') {
          state.moved.thinking = probe.level
          record = {
            provider: target.ref.id,
            setting,
            from: target.thinking,
            to: probe.level,
            cause: probe.cause,
          }
        } else if (outcome === 'refused') {
          record = {
            provider: target.ref.id,
            setting,
            from: probe.level,
            to: target.thinking,
            cause: 'lowering-refused',
          }
        }
      } else if (setting === 'structuredOutput' && outcome === 'answered') {
        state.moved.structuredOutput = 'prompt'
        record = {
          provider: target.ref.id,
          setting,
          from: 'json',
          to: 'prompt',
          cause: probe.cause,
        }
      } else if (setting === 'stream' && outcome === 'answered' && state.moved.stream !== false && !(step === 'streamBare' && state.moved.stream === 'bare')) {
        // A step moves on an answer alone, and never back up: a provider already moved to whole replies stays there.
        record = {
          provider: target.ref.id,
          setting,
          from: state.moved.stream === 'bare'
            ? 'bare'
            : 'stream',
          to: step === 'streamBare'
            ? 'bare'
            : 'whole',
          cause: probe.cause,
        }
        state.moved.stream = step === 'streamBare'
          ? 'bare'
          : false
      }
      if (record !== undefined) records.push(record)
      probe.release()
      return record === undefined
        ? undefined
        : { ...record }
    },
    answeredWhole: (target) => {
      if (target.adapts?.stream !== true) return undefined
      const state = stateOf(target)
      // Moved already, or a probe of whole replies is pending: it settles the move itself.
      if (state.moved.stream === false || state.streamWhole !== undefined) return undefined
      const record: Adaptation = {
        provider: target.ref.id,
        setting: 'stream',
        from: state.moved.stream === 'bare'
          ? 'bare'
          : 'stream',
        to: 'whole',
        cause: 'stream-answered-whole',
      }
      state.moved.stream = false
      state.streamWhole = { phase: 'tried' }
      records.push(record)
      return { ...record }
    },
    reasoned: (target, response) => {
      if (ownData(response, 'reasoning') === false && !holdsReasoning(response.text)) stateOf(target).noReasoning = true
    },
    findings: (target, budget) => stateOf(target).noReasoning
      ? budget.findingsWithoutThinking
      : budget.findings,
    recorded: (adaptation) => {
      records.push({ ...adaptation })
    },
    record: () => records.map(record => ({ ...record })),
    ready: async (target, stop) => {
      for (let pending = pendingOf(stateOf(target)); pending !== undefined; pending = pendingOf(stateOf(target))) await until(pending.wait, stop)
    },
    after: async (target, sent, failure, stop) => {
      const asked = answer(target, failure)
      if (asked === undefined) return undefined
      const state = stateOf(target)
      const found = pendingIn(state, asked.setting)
      if (found !== undefined) await until(found.pending.wait, stop)
      const now = movedOf(state)
      return now[asked.setting] !== undefined && now[asked.setting] !== sent[asked.setting]
        ? now
        : undefined
    },
  }
}
