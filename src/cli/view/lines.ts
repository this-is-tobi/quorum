/**
 * The words the view writes about a review: the log line of an event, the heartbeat, and the durations and the
 * time left in words. Every line holds numbers, ids and code words, and passes `inertLine` whole.
 */

import { elapsedWords } from '../../core/duration.ts'
import { downWords, lackWords } from '../../core/errors.ts'
import type { PartOutcome } from '../../core/parts.ts'
import { inertLine } from '../../core/sanitize.ts'
import type { Adaptation, CallFailure, LeftOutFile, QuorumEvent } from '../../core/types.ts'
import { flagWhere, leftOutEntry } from '../../report/lines.ts'
import type { ReportView } from '../../report/view.ts'
import { rangeWords, researchRuns, timeLeft } from './eta.ts'
import type { ViewState } from './model.ts'

export { elapsedWords }

/** The start of a profile's line, when several profiles run. */
export const profilePrefix = (profile: string): string => `[${profile}] `

/**
 * The progress line of an event, or undefined for the events the CLI keeps quiet about. These lines
 * are the CLI's progress output on stderr, so a person follows a run without the full event stream.
 * Each line passes through `inertLine` whole: the reasons, details and file names it carries come
 * from the finder or the diff, and nothing in them can act on a terminal or a CI log. When `prefixed`,
 * a line of an event that names a profile starts with `[<profile>] `: the `left out:`, `flag:` and totals
 * lines belong to the whole review and never do.
 *
 * Under the public view, whose log a stranger may read, three lines leave out what a person alone needs: a
 * gap is `incomplete: <reason>`, then ` at <file as a JSON string>` when it has a file, with no detail, and a
 * dropped finding is `invalid finding dropped`, with no reason, since the reason quotes the file name and the text
 * of a finding the harness dropped, the oracle a discarded finding would be, and an answered research part is
 * `part <i> of <n>: answered in <time>`, with no tokens and no findings. A provider-down line of a used-up
 * quota is `<id>: the call failed (<kind>[ <status>])`, since it tells a stranger the account is out of money.
 * Every other line is the full view's.
 */
export function renderEvent(event: QuorumEvent, prefixed = false, view: ReportView = 'full'): string | undefined {
  const line = progressLine(event, prefixed, view)
  return line === undefined
    ? undefined
    : inertLine(line)
}

/** How many of the files left out the progress line names; the JSON result lists every one. */
const LISTED_FILES = 5

function progressLine(event: QuorumEvent, prefixed: boolean, view: ReportView): string | undefined {
  const of = (profile: string, line: string): string => prefixed
    ? `${profilePrefix(profile)}${line}`
    : line
  switch (event.type) {
    case 'stage:end':
      return event.stage === 'dedup'
        ? of(event.profile, `${event.count} candidate(s) after dedup`)
        : undefined
    case 'finding:invalid':
      return of(event.profile, view === 'public'
        ? 'invalid finding dropped'
        : `invalid finding dropped: ${event.reason}`)
    case 'incomplete':
      return of(event.entry.profile, view === 'public'
        ? `incomplete: ${event.entry.reason}${event.entry.file === undefined
          ? ''
          : ` at ${JSON.stringify(event.entry.file)}`}`
        : `incomplete: ${event.entry.reason} (${event.entry.detail})`)
    case 'provider-down':
      if (event.exhausted === true && view === 'public') {
        return `${event.provider}: the call failed (${event.kind}${event.status === undefined
          ? ''
          : ` ${event.status}`})`
      }
      return downWords({
        providerId: event.provider,
        kind: event.kind,
        status: event.status,
        count: event.calls,
        streak: true,
        noAnswer: event.noAnswer,
        ...(event.exhausted === true
          ? { exhausted: true as const }
          : {}),
        ...(event.cutAfterMs === undefined
          ? {}
          : { cutAfterMs: event.cutAfterMs }),
        ...(event.stalledMs === undefined
          ? {}
          : { stalledMs: event.stalledMs }),
        ...(event.refused === undefined
          ? {}
          : { refused: event.refused }),
      })
    case 'reply-lacked':
      return `${event.provider}: ${lackWords(event.kind, event)}`
    case 'adapted':
      return adaptedWords(event.adaptation)
    case 'stored-refused':
      return '--state: a stored reply failed its check: the call is made again'
    case 'recovered':
      return of(event.profile, recoveredWords(event))
    case 'part':
      return of(event.profile, partWords(event, view))
    case 'left-out':
      return leftOutLine(event.files)
    case 'flag':
      return `flag: ${event.flag.code}${flagWhere(event.flag)} (${event.flag.detail})`
    case 'run:end':
      return `${event.kept} kept, ${event.discarded} discarded, ${event.unreviewed} unreviewed by panel`
    default:
      return undefined
  }
}

/**
 * The line of a research part recovery split: which part, what its reply lacked, how many pieces it was split into, and
 * whether every piece was read; else the hunks the floor left unread, cut off even alone, and what to change, or how many
 * pieces were not read, for the gaps to say why. It holds numbers and code words only.
 */
function recoveredWords(event: Extract<QuorumEvent, { type: 'recovered' }>): string {
  const { part, parts, noAnswer, limit, findings, pieces, read, unreadHunks, unreadFiles } = event
  const lacked = noAnswer === 'saturated'
    ? `its reply listed the ${findings} findings it was asked for at most`
    : noAnswer === 'window'
      ? 'reply cut off at the server\'s window (window)'
      : limit === undefined
        ? `reply cut off at its limit (${noAnswer})`
        : `reply cut off at its limit of ${limit} tokens (${noAnswer})`
  const end = read === pieces
    ? ', all read'
    : unreadHunks > 0
      ? `; ${unreadHunks} hunk(s) of ${unreadFiles} file(s) left unread, cut off even alone: raise maxTokens, set thinking: low, or lower partTokens`
      : `; ${pieces - read} not read, see the gaps`
  return `part ${part} of ${parts}: ${lacked}: split into ${pieces} pieces${end}`
}

type Unread = Exclude<PartOutcome, 'reviewed'>

/** What each outcome of a part that was not read says, in the part's line. */
const OUTCOME_WORDS: Readonly<Record<Exclude<Unread, 'research-failed'>, string>> = {
  'token-cap': 'stopped by the token cap',
  'review-deadline': 'stopped by the deadline',
  interrupted: 'stopped by the interrupt',
  'provider-down': 'not sent: provider-down',
  'request-too-large': 'not sent: too large for its model',
  'reply-cut-off': 'cut off at its limit even alone: its hunks are a reply-cut-off gap',
}

/** What each outcome of a piece that was not read says, in a split part's line, in the order `PartOutcome` lists them. */
const PIECE_WORDS: ReadonlyArray<readonly [Unread, string]> = [
  ['request-too-large', 'too large for its model'],
  ['token-cap', 'stopped by the token cap'],
  ['review-deadline', 'stopped by the deadline'],
  ['interrupted', 'stopped by the interrupt'],
  ['research-failed', 'failed'],
  ['provider-down', 'not sent, its provider down'],
  ['reply-cut-off', 'cut off even alone'],
]

/** A failure as the part's line words it: its kind, then its status when it has one. */
export function kindWords({ kind, status }: CallFailure): string {
  return status === undefined
    ? kind
    : `${kind} ${status}`
}

/**
 * The line of a research part that ended: answered with its time, tokens and findings listed (the time alone under the
 * public view), or why it was not read; a part recovery split says how many of its pieces were read, and which were not,
 * by outcome. It holds numbers and code words only.
 */
function partWords(event: Extract<QuorumEvent, { type: 'part' }>, view: ReportView): string {
  const { outcome, pieces, failure } = event
  const where = `part ${event.part.index} of ${event.part.count}`
  if (outcome === 'reviewed') {
    const split = pieces === undefined
      ? ''
      : `, in ${pieces.count} pieces`
    return view === 'public'
      ? `${where}: answered in ${durationWords(event.durationMs)}${split}`
      : `${where}: answered in ${durationWords(event.durationMs)}, ${event.spent} tokens, ${event.listed ?? 0} finding(s) listed${split}`
  }
  if (pieces !== undefined) {
    const unread = PIECE_WORDS.flatMap(([name, words]) => pieces.unread[name] === undefined
      ? []
      : [`${pieces.unread[name]} ${words}`])
    return `${where}: split into ${pieces.count} pieces, ${pieces.read} read, ${unread.join(', ')}`
  }
  if (outcome === 'research-failed') {
    return failure === undefined
      ? `${where}: its reply could not be read: its files are a research-failed gap`
      : `${where}: failed (${kindWords(failure)}): its files are a research-failed gap`
  }
  return `${where}: ${OUTCOME_WORDS[outcome]}`
}

/** What each cause of a setting moved says, in words the code writes: the reason the review gives for it. */
const ADAPTED_BECAUSE: Readonly<Partial<Record<Adaptation['cause'], string>>> = {
  'cut-off-thinking': 'a reply ran out of room while reasoning',
  'no-answer-thinking': 'a reply held only reasoning',
  'empty-reply': 'a reply in JSON mode was empty',
  'format-refused': 'the server refused the request\'s JSON mode',
}

/** The line of a stream that stepped down: to a stream with no options, or to whole replies, by a refusal or by an answer. */
function streamWords(provider: string, to: string, cause: Adaptation['cause']): string | undefined {
  if (to === 'bare') return `${provider}: its calls stream without stream_options for the rest of the review: the server refused the field, so each call settles at its reservation`
  if (to !== 'whole') return undefined
  if (cause === 'stream-refused') return `${provider}: its calls ask for whole replies for the rest of the review: the server refused streaming; set stream: false to choose it yourself`
  return cause === 'stream-answered-whole'
    ? `${provider}: its calls ask for whole replies for the rest of the review: the server answered a streamed call whole; set stream: false to choose it yourself`
    : undefined
}

/**
 * The line of a setting quorum moved by itself, which names the provider, the new setting, that it holds for the
 * rest of the review and how to choose it instead, or, for a lowering the server refused, that thinking stays as
 * the server sets it. It holds a provider's id and code words only. A move no release of the 3e kind writes (the server's
 * count, a loaded window) has no line yet.
 */
function adaptedWords({ provider, setting, from, to, cause }: Adaptation): string | undefined {
  if (setting === 'stream') return streamWords(provider, to, cause)
  if (cause === 'lowering-refused') return `${provider}: the server refused thinking lowered to ${from}: thinking stays as the server sets it for the rest of the review; set thinking to choose it yourself`
  const because = ADAPTED_BECAUSE[cause]
  if (because === undefined) return undefined
  return setting === 'thinking'
    ? `${provider}: thinking lowered to ${to} for the rest of the review: ${because}; set thinking to choose it yourself`
    : `${provider}: structuredOutput moved to ${to} for the rest of the review: ${because}; set structuredOutput to choose it yourself`
}

/**
 * The line that names the files a review left out: their count, then the first `LISTED_FILES` of them as
 * `leftOutEntry` writes them, then how many more.
 */
function leftOutLine(files: readonly LeftOutFile[]): string {
  const entries = files.slice(0, LISTED_FILES).map(leftOutEntry)
  const more = files.length > LISTED_FILES
    ? ` and ${files.length - LISTED_FILES} more`
    : ''
  return `left out: ${files.length} file(s): ${entries.join(', ')}${more}`
}

/** The marks a terminal view draws before a log line; plain mode writes none. */
export type GlyphName = 'answered' | 'retry' | 'adapted' | 'failed'

/** One log line: its text, inert, and the glyph a terminal writes before it. */
export interface Line {
  readonly glyph?: GlyphName
  readonly text: string
}

/** What an event's line is glyphed as, by what it says. */
function glyphOf(event: QuorumEvent): GlyphName | undefined {
  switch (event.type) {
    case 'part':
      return event.outcome === 'reviewed'
        ? 'answered'
        : 'failed'
    case 'stored-refused':
      return 'retry'
    case 'adapted':
    case 'recovered':
    case 'reply-lacked':
      return 'adapted'
    case 'provider-down':
      return 'failed'
    default:
      return undefined
  }
}

/**
 * A retry's failure as its line words it: `timeout after 600000 ms`, whose length is the deadline's, `stalled, no progress
 * for 300000 ms` for a stream that stalled, whose length is its window, else its kind (`http 503`, `network`) and how long
 * the attempt ran: `network after 10m00s`.
 */
function retryFailure({ kind, status, stalledMs }: CallFailure, timeoutMs: number, attemptMs: number): string {
  if (kind === 'timeout' && stalledMs !== undefined) return `stalled, no progress for ${stalledMs} ms`
  if (kind === 'timeout') return `timeout after ${timeoutMs} ms`
  return `${kind === 'http' && status !== undefined
    ? `http ${status}`
    : kind} after ${elapsedWords(attemptMs)}`
}

/** The line of a research call's retry, read against the call in the state; a vote's retry, and a call the state does not hold, write none. */
function retryLines(event: Extract<QuorumEvent, { type: 'call:retry' }>, state: ViewState): Line[] {
  const call = state.calls.get(event.call)
  if (call === undefined || call.role !== 'research' || call.part === undefined) return []
  const { part } = call
  const where = part.piece === undefined
    ? `part ${part.index} of ${part.count}`
    : `part ${part.index} of ${part.count}, piece ${part.piece.index} of ${part.piece.count}`
  const text = `${where}: ${retryFailure(event.failure, call.timeoutMs, event.attemptMs)}, retry ${event.attempt} of ${event.retries} in ${Math.ceil(event.waitMs / 1000)}s`
  return [
    {
      glyph: 'retry',
      text: inertLine(state.prefixed
        ? `${profilePrefix(call.profile)}${text}`
        : text),
    },
  ]
}

/**
 * The lines of `event`, read against the state that folded it: `renderEvent`'s line with its glyph, a research
 * retry's line, with its position from the call the state holds, and the stopping line of the deadline or of the
 * interrupt, which has no glyph. Each text is inert, and starts with `[<profile>] ` when several profiles run.
 */
export function logLines(event: QuorumEvent, state: ViewState, view: ReportView): Line[] {
  if (event.type === 'call:retry') return retryLines(event, state)
  if (event.type === 'run:stopping') {
    return [
      {
        text: inertLine(event.cause === 'interrupt'
          ? `stopping: no new calls; the ${event.inFlight} call(s) in flight have ${(event.graceMs ?? 0) / 1000} s to end; press Ctrl-C again to quit at once, without the result`
          : `stopping: the review reached its deadline of ${state.facts.deadlineMs} ms: the calls in flight are stopped, and what is left is a review-deadline gap`),
      },
    ]
  }
  const text = renderEvent(event, state.prefixed, view)
  if (text === undefined) return []
  const glyph = glyphOf(event)
  return glyph === undefined
    ? [
        { text },
      ]
    : [
        { glyph, text },
      ]
}

/** A duration in words: one decimal under 10 s (`4.3s`), whole seconds under a minute (`42s`), then `2m14s`, then `1h02m09s`. */
export function durationWords(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100))
  return tenths < 100
    ? `${(tenths / 10).toFixed(1)}s`
    : elapsedWords(ms)
}

/**
 * The line written in a quiet minute: the time in, where research or the panel stands, the calls in flight and
 * retried, the tokens spent against the cap (not under the public view), and the time left. Numbers only.
 */
export function heartbeatLine(state: ViewState, now: number, view: ReportView): string {
  const profiles = [
    ...state.profiles.values(),
  ]
  const researching = researchRuns(state)
  const sum = (pick: (profile: (typeof profiles)[number]) => number): number => profiles.reduce((total, profile) => total + pick(profile), 0)
  const progress = researching
    ? `research ${sum(profile => profile.done)} of ${sum(profile => profile.parts ?? 0)} part(s)`
    : `panel ${sum(profile => profile.cast)} of ${sum(profile => profile.votes ?? 0)} vote(s)`
  const retried = researching
    ? state.retried.research
    : state.retried.votes
  const spent = view === 'public'
    ? ''
    : `; ${state.spent} of ${state.facts.cap.tokens} tokens`
  const left = timeLeft(state, now)
  const words = left.kind === 'range'
    ? `about ${rangeWords(left.lowMs, left.highMs, '-')} left`
    : 'estimating the time left'
  return inertLine(`[${elapsedWords(now - (state.startedAt ?? now))}] ${progress}, ${state.calls.size} call(s) in flight, ${retried} retried${spent}; ${words}`)
}
