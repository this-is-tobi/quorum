/**
 * The words the view writes about a review: the log line of an event and the heartbeat. Every duration in them is
 * `durationText`'s, the one form every line a person reads writes. Every line holds numbers, ids and code words, and passes
 * `inertLine` whole.
 */

import { elapsedWords } from '../../core/duration.ts'
import { CUT_ADVICE, downWords, lackWords } from '../../core/errors.ts'
import type { PartOutcome } from '../../core/parts.ts'
import { MAX_TIMEOUT_MS } from '../../core/ports.ts'
import { inertLine } from '../../core/sanitize.ts'
import type { Adaptation, CallFailure, LeftOutFile, QuorumEvent, UnusableReply } from '../../core/types.ts'
import { documentLine, durationText, flagWhere, leftOutEntry, ruleCountWords, tokenWords } from '../../report/lines.ts'
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
 * dropped finding is `invalid finding dropped`, a refused rule citation `rule citation refused`, with no reason, since the
 * reason quotes the file name and the text of a finding the harness dropped, the oracle a discarded finding would be, and
 * an answered research part is `part <i> of <n>: answered in <time>`, with no tokens and no findings. A provider-down line of a used-up
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
      return of(event.profile, invalidWords(event, view))
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
    case 'cut':
      return cutWords(event, view)
    case 'concurrency':
      return laneWords(event)
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
 * What a `finding:invalid` event says: `invalid finding dropped` for a finding that cited code outside the diff, or `rule citation
 * refused` for one whose rule failed its check (the finding goes on with no rule, or is dropped with it in a profile that requires
 * one), each followed by `: <reason>` in the full view. The public view leaves the reason out: it names a file and a line of the diff.
 */
function invalidWords({ cause, reason }: Extract<QuorumEvent, { type: 'finding:invalid' }>, view: ReportView): string {
  const what = cause === 'rule'
    ? 'rule citation refused'
    : 'invalid finding dropped'
  return view === 'public'
    ? what
    : `${what}: ${reason}`
}

/** The line of each profile that lists a review rule or requires one: `context: <profile> rules: <sent> of <listed> sent`, then `, so its research asks nothing` when it requires a rule and sends none. */
function ruleLines(rules: Extract<QuorumEvent, { type: 'context' }>['rules']): string[] {
  return Object.entries(rules ?? {}).map(([profile, counts]) => `context: ${profile} rules: ${ruleCountWords(counts, counts.asksNothing === true)}`)
}

/**
 * The line of a research part recovery split: which part, what its reply lacked, how many pieces it was split into, and
 * whether every piece was read; else the hunks the floor left unread, cut off even alone, and what to change, or how many
 * pieces were not read, for the gaps to say why. It holds numbers and code words only.
 */
function recoveredWords(event: Extract<QuorumEvent, { type: 'recovered' }>): string {
  const { part, parts, noAnswer, limit, cutAfterMs, findings, pieces, read, unreadHunks, unreadFiles } = event
  const lacked = noAnswer === 'saturated'
    ? `its reply listed the ${findings} findings it was asked for at most`
    : noAnswer === 'window'
      ? 'reply cut off at the server\'s window (window)'
      : cutAfterMs !== undefined
        ? `reply cut on the way after about ${elapsedWords(cutAfterMs)} (${noAnswer})`
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
export function kindWords(failure: CallFailure | UnusableReply): string {
  return 'status' in failure && failure.status !== undefined
    ? `${failure.kind} ${failure.status}`
    : failure.kind
}

/**
 * The line of a research part that ended: answered with its time, tokens and findings listed (the time alone under the
 * public view), or reused from the saved state with its findings listed (nothing more under the public view), or why it was not read; a part recovery split says how many of its pieces were read, and which were not,
 * by outcome. It holds numbers and code words only.
 */
function partWords(event: Extract<QuorumEvent, { type: 'part' }>, view: ReportView): string {
  const { outcome, pieces, failure } = event
  const where = `part ${event.part.index} of ${event.part.count}`
  if (outcome === 'reviewed') {
    const split = pieces === undefined
      ? ''
      : `, in ${pieces.count} pieces`
    if (event.reused === true) {
      return view === 'public'
        ? `${where}: reused from the saved state${split}`
        : `${where}: reused from the saved state, ${event.listed ?? 0} finding(s) listed${split}`
    }
    return view === 'public'
      ? `${where}: answered in ${durationText(event.durationMs)}${split}`
      : `${where}: answered in ${durationText(event.durationMs)}, ${tokenWords(event.spent)} tokens, ${event.listed ?? 0} finding(s) listed${split}`
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

/**
 * The line of a provider's learned cut: its calls are cut after about that long on the way, and a call cut so is read as a reply
 * cut off at its limit. Then what is done about it: the replies are held to `holds` tokens for the rest of the review (a derived budget
 * lowered), or the value to lower `maxTokens` to (the owner's setting stands), or, when no rate was measured, `CUT_ADVICE`.
 * When every budget already fits the cut (`fits`) nothing moved and the line ends at the limit.
 * The public view leaves out the token counts, so its line ends at the limit.
 */
function cutWords({ provider, afterMs, holds, lowered, fits }: Extract<QuorumEvent, { type: 'cut' }>, view: ReportView): string {
  const line = `${provider}: its calls are cut after about ${elapsedWords(afterMs)} on the way: a call cut so is read as a reply cut off at its limit`
  if (view === 'public') return line
  if (holds === undefined) return `${line}; ${CUT_ADVICE}`
  if (lowered) return `${line}, and its replies are held to ${holds} tokens for the rest of the review`
  return fits === true
    ? line
    : `${line}; lower maxTokens to about ${holds} to keep each call under it`
}

/**
 * The line of a lane's cut, `<id>: <n> call(s) at once for now, cut from <from> after <failure>`, or of the slots its provider
 * states, which the lane holds to. A growth, a pause and a pacing wait have no line: the block shows them. It holds an id,
 * numbers and a failure's code words.
 */
function laneWords({ provider, limit, cause, from, failure }: Extract<QuorumEvent, { type: 'concurrency' }>): string | undefined {
  if (cause === 'slots') return `${provider.id}: the server serves ${limit} calls at once: its lane holds ${limit}`
  if (cause !== 'cut') return undefined
  return `${provider.id}: ${limit} call(s) at once for now${from === undefined
    ? ''
    : `, cut from ${from}`}${failure === undefined
    ? ''
    : ` after ${kindWords(failure)}`}`
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
    case 'cut':
    case 'concurrency':
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
 * A retry's failure as its line words it: `timeout after 10m00s`, whose length is the deadline's, `stalled, no progress
 * for 5m00s` for a stream that stalled, whose length is its window, `timeout after 2h55m12s` with the ceiling a
 * stream grew to when the failure names it, `its reply held only reasoning after 4m10s` for a reply of only reasoning (the
 * one `no-answer` a call sends once more), `its reply could not be read after 2m10s` for a reply the stage refused, else its kind
 * (`http 503`, `network`) and how long the attempt ran: `network after 10m00s`. Every length is written as every duration is.
 */
function retryFailure(failure: CallFailure | UnusableReply, timeoutMs: number, attemptMs: number): string {
  if (failure.kind === 'unusable-reply') return `its reply could not be read after ${durationText(attemptMs)}`
  const { kind, status, stalledMs, ceilingMs } = failure
  if (kind === 'timeout' && stalledMs !== undefined) return `stalled, no progress for ${durationText(stalledMs)}`
  if (kind === 'timeout') return `timeout after ${durationText(ceilingMs ?? timeoutMs)}`
  if (kind === 'no-answer') return `its reply held only reasoning after ${durationText(attemptMs)}`
  return `${kind === 'http' && status !== undefined
    ? `http ${status}`
    : kind} after ${durationText(attemptMs)}`
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

/** How far from a review's start its research ends, at the estimate's low bound, for the state notice: a review that keeps no answered call and runs this long costs a full rerun for one failed part. */
export const STATE_NOTICE_MS = 3_600_000

/**
 * What the first time estimate tells that the plan could not, as the text of up to two lines, the warning then the notice, and none
 * before the estimate is made: no rate is known before a part has answered. Research's end is put at the estimate's bounds from the review's
 * start, and named as the heartbeat names a time left. The warning comes when the low bound passes a deadline that has a fix to name,
 * the config's or a diff review's default, never the longest allowed: the review stops at the deadline, and `raise reviewTimeoutMs` says
 * what to do, for a path review (whose facts hold an estimate) with the longest allowed as the unset deadline. The notice comes when the low
 * bound is `STATE_NOTICE_MS` or more and the caller says the review keeps no answered call (`keeps` is false, not absent: a caller that offers no
 * `--state` says nothing), and names `--state`.
 */
export function estimateNotes(state: ViewState): string[] {
  const { firstEstimate: first, startedAt } = state
  if (first === undefined || startedAt === undefined) return []
  const { deadline, deadlineMs, keeps, estimate } = state.facts
  const waited = first.at - startedAt
  const lowMs = waited + first.lowMs
  const range = rangeWords(lowMs, waited + first.highMs, '-')
  const notes: string[] = []
  if (deadline !== 'longest' && deadlineMs < MAX_TIMEOUT_MS && lowMs > deadlineMs) {
    const named = deadline === 'config'
      ? `${durationText(deadlineMs)} (reviewTimeoutMs)`
      : `${durationText(deadlineMs)}, the default`
    const fix = estimate === undefined
      ? `raise reviewTimeoutMs, up to ${durationText(MAX_TIMEOUT_MS)}`
      : `raise reviewTimeoutMs, or unset it to let a path review run up to ${durationText(MAX_TIMEOUT_MS)}`
    notes.push(`warning: the deadline of ${named} comes before research ends, which this review's first estimate puts at ${range} from its start: the review stops at the deadline, and what is left is a review-deadline gap; ${fix}`)
  }
  if (keeps === false && lowMs >= STATE_NOTICE_MS) {
    notes.push(`notice: this review's first estimate puts research's end at ${range} from its start, and it keeps no answered call, so a part that fails costs a full rerun: pass --state <dir> to keep them`)
  }
  return notes
}

/** The notes of the first estimate, as lines, for the `part` event that made it, which `fold` keyed in `firstEstimate.by`: none for any other event. */
function estimateNoteLines(event: QuorumEvent, state: ViewState): Line[] {
  if (event.type !== 'part' || state.firstEstimate?.by !== `${event.profile}|${event.part.index}`) return []
  return estimateNotes(state).map(note => ({
    text: inertLine(note),
  }))
}

/**
 * The lines of `event`, read against the state that folded it: `renderEvent`'s line with its glyph, a research
 * retry's line, with its position from the call the state holds, the stopping line of the deadline or of the
 * interrupt, which has no glyph, and a line for each document of a `context` event, in its order, then one for each profile
 * that lists or requires a rule, the same under the public view and with no prefix, since each names its profile itself.
 * The `part` event that made the review's first time estimate is followed by its notes (`estimateNotes`), once, with no glyph and no prefix.
 * Each text is inert, and starts with `[<profile>] ` when several profiles run, but for those of a `context` event and the notes.
 */
export function logLines(event: QuorumEvent, state: ViewState, view: ReportView): Line[] {
  if (event.type === 'call:retry') return retryLines(event, state)
  if (event.type === 'run:stopping') {
    return [
      {
        text: inertLine(event.cause === 'interrupt'
          ? `stopping: no new calls; the ${event.inFlight} call(s) in flight have ${durationText(event.graceMs ?? 0)} to end; press Ctrl-C again to quit at once, without the result`
          : `stopping: the review reached its deadline of ${durationText(state.facts.deadlineMs)}: the calls in flight are stopped, and what is left is a review-deadline gap`),
      },
    ]
  }
  if (event.type === 'context') {
    return [
      ...event.context.documents.map(documentLine),
      ...ruleLines(event.rules),
    ].map(text => ({
      text: inertLine(text),
    }))
  }
  const text = renderEvent(event, state.prefixed, view)
  if (text === undefined) return []
  const glyph = glyphOf(event)
  return [
    glyph === undefined
      ? { text }
      : { glyph, text },
    ...estimateNoteLines(event, state),
  ]
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
    : `; ${tokenWords(state.spent)} of ${tokenWords(state.facts.cap.tokens)} tokens`
  const left = timeLeft(state, now)
  const words = left.kind === 'range'
    ? `about ${rangeWords(left.lowMs, left.highMs, '-')} left`
    : 'estimating the time left'
  return inertLine(`[${durationText(now - (state.startedAt ?? now))}] ${progress}, ${state.calls.size} call(s) in flight, ${retried} retried${spent}; ${words}`)
}
