/**
 * The summary every view ends with: once the report and the `--output` files are written, the lines that say how
 * the review went (the time of each stage, the tokens against the cap, the calls, each gap with its fix, and where
 * the report went), a fold of the review's events (`model.ts`) and the facts of the run. It names formats, never
 * paths, shows counts, durations, provider ids and code words only, repeats nothing the report says, and passes
 * `inertLine` whole.
 */

import { CUT_ADVICE, failureFix, QUOTA_FIX } from '../../core/errors.ts'
import { inertLine } from '../../core/sanitize.ts'
import type { IncompleteReason, QuorumResult, StageName } from '../../core/types.ts'
import type { ReportView } from '../../report/view.ts'
import { rangeWords } from './eta.ts'
import { durationWords, elapsedWords } from './lines.ts'
import { stageStart, stageTime } from './model.ts'
import type { Cause, GapCount, ViewState } from './model.ts'
import type { SummaryFacts } from './writer.ts'

/** The fix of a gap with no better advice: the report holds its detail. */
const SEE_REPORT = 'see the gap in the report'

/** The fix of a gap a rerun can fill: the resume line says how. */
const SEE_RESUME = 'see resume'

/** The reasons of a gap that a rerun of the review could fill, which the resume line is written for. */
const RERUN_REASONS: ReadonlySet<IncompleteReason> = new Set<IncompleteReason>([
  'interrupted',
  'token-cap',
  'review-deadline',
  'provider-down',
  'research-failed',
  'vote-failed',
])

/** The fix of each reason that needs no cause. */
const FIXES: Readonly<Partial<Record<IncompleteReason, string>>> = {
  'token-cap': 'raise maxReviewTokens',
  'review-deadline': 'raise reviewTimeoutMs',
  'reply-cut-off': 'raise maxTokens, set thinking: low, or lower partTokens',
  'findings-capped': 'raise maxFindings',
  'request-too-large': 'raise contextTokens, or lower partTokens',
  'too-large': 'raise contextTokens, or lower partTokens',
  'research-unusable': SEE_REPORT,
  'finding-unreadable': SEE_REPORT,
  'vote-failed': SEE_RESUME,
  interrupted: SEE_RESUME,
}

/** A cause in words: its kind, then its status when it has one. */
function causeWords({ kind, status }: Cause): string {
  return status === undefined
    ? kind
    : `${kind} ${status}`
}

/**
 * What to do about a gap of `reason`, or undefined when there is nothing to say: a fixed phrase for most reasons,
 * and for `research-failed` and `provider-down` the fix of each cause the events gave, joined by `, or ` (a used-up
 * quota's is `QUOTA_FIX`, a call cut on the way's `CUT_ADVICE`), `research-failed` with no cause pointing to the report.
 */
export function gapFix(reason: IncompleteReason, causes: readonly Cause[]): string | undefined {
  if (reason !== 'research-failed' && reason !== 'provider-down') return FIXES[reason]
  const fixes = new Set(causes.map((cause) => {
    if (cause.exhausted === true) return QUOTA_FIX
    return cause.cutAfterMs === undefined
      ? failureFix(cause.kind, cause.status)
      : CUT_ADVICE
  }))
  if (fixes.size === 0) {
    return reason === 'research-failed'
      ? SEE_REPORT
      : undefined
  }
  return [...fixes].join(', or ')
}

/** `names` as `a`, `a and b` or `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** Whether the text report is above the summary: stdout and stderr are both terminals, and the format is `text`. */
function reportAbove({ stdout, stderr }: SummaryFacts): boolean {
  return stdout.terminal && stdout.format === 'text' && stderr.terminal
}

function timeLine(state: ViewState, facts: SummaryFacts, view: ReportView, dash: string): string | undefined {
  const spans: string[] = []
  const names: readonly StageName[] = ['research', 'dedup', 'panel']
  for (const name of names) {
    const time = stageTime(state, name)
    if (time !== undefined) spans.push(`${name} ${durationWords(time)}`)
  }
  if (spans.length === 0) return undefined
  let line = `time: ${spans.join(', ')}`
  const researchStart = stageStart(state, 'research')
  if (state.firstEstimate !== undefined && researchStart !== undefined) {
    const at = state.firstEstimate.at - researchStart
    line += `; the first estimate, ${elapsedWords(at)} in, put research at ${rangeWords(at + state.firstEstimate.lowMs, at + state.firstEstimate.highMs, dash)}`
  }
  if (reportAbove(facts)) return line
  const { durationMs, usage } = facts.result.meta
  line += `; done in ${elapsedWords(durationMs)}`
  if (view !== 'public' && usage !== undefined) line += `, ${usage.inputTokens} tokens in and ${usage.outputTokens} out`
  return line
}

function tokensLine(state: ViewState): string {
  const { tokens, origin } = state.facts.cap
  const percent = Math.floor(state.spent * 100 / tokens)
  let line = `tokens: ${percent} percent of the cap of ${tokens}, ${origin === 'config'
    ? 'maxReviewTokens'
    : 'the default'}`
  if (state.usage.size > 1) line += `; ${[...state.usage].map(([id, usage]) => `${id} ${usage.inputTokens} in and ${usage.outputTokens} out`).join(', ')}`
  return line
}

function callsLine(state: ViewState): string | undefined {
  const { made, retried, recovered } = state
  if (made.research + made.votes === 0) return undefined
  const parts: string[] = []
  if (made.research > 0) {
    const notes = [
      ...retried.research > 0
        ? [`${retried.research} retried`]
        : [],
      ...recovered.parts > 0
        ? [`${recovered.parts} recovered into ${recovered.pieces} pieces`]
        : [],
    ]
    parts.push(`${made.research} research${notes.length === 0
      ? ''
      : ` (${notes.join(', ')})`}`)
  }
  if (made.votes > 0) {
    parts.push(`${made.votes} vote(s)${retried.votes > 0
      ? ` (${retried.votes} retried)`
      : ''}`)
  }
  return `calls: ${parts.join(', ')}; ${state.facts.concurrency} at once`
}

/** What a reason's entries count, each unit named: `5 part(s)`, `3 vote(s)`, and `2 gap(s)` for entries that count neither. */
function quantityWords({ parts, votes, other }: GapCount): string {
  return [
    ...parts > 0
      ? [`${parts} part(s)`]
      : [],
    ...votes > 0
      ? [`${votes} vote(s)`]
      : [],
    ...other > 0
      ? [`${other} gap(s)`]
      : [],
  ].join(' and ')
}

function gapsLine(state: ViewState, view: ReportView): string | undefined {
  if (state.gaps.size === 0) return undefined
  const entries = [...state.gaps].map(([reason, count]) => {
    const known = reason === 'research-failed' || reason === 'provider-down'
      ? state.causes.get(reason) ?? []
      : []
    // A used-up quota is shown as its cause alone: its fix would tell a stranger the account is out of money.
    const quota = view === 'public' && known.some(cause => cause.exhausted === true)
    const fixed = quota
      ? known.filter(cause => cause.exhausted !== true)
      : known
    const fix = quota && fixed.length === 0
      ? undefined
      : gapFix(reason, fixed)
    return `${quantityWords(count)} ${reason}${known.length === 0
      ? ''
      : ` (${[
        ...new Set(known.map(causeWords)),
      ].join(', ')})`}${fix === undefined
      ? ''
      : `: ${fix}`}`
  })
  return `gaps: ${entries.join('; ')}`
}

/**
 * Whether a rerun of the review could fill what is missing from `result`: a gap of an interrupt, a limit, a provider that
 * was down, a failed research part or a failed vote, or a finding left unreviewed. The resume line is written when it holds.
 */
export function rerunCouldFill(result: Pick<QuorumResult, 'unreviewed' | 'meta'>): boolean {
  return result.unreviewed.length > 0 || result.meta.incomplete.some(entry => RERUN_REASONS.has(entry.reason))
}

/** The resume line: with `--state`, how a rerun reuses the calls this review kept, naming the flag and the count, which may be 0, and never the directory; without it, how to keep them. */
function resumeLine({ state, result }: SummaryFacts): string | undefined {
  if (!rerunCouldFill(result)) return undefined
  return state.kind === 'flag'
    ? `resume: rerun with the same --state: its ${state.kept} answered call(s) are reused`
    : 'resume: to keep the answered calls for a rerun, pass --state <dir>; this review kept none'
}

function resultLine(facts: SummaryFacts, view: ReportView): string {
  const { format } = facts.stdout
  const where = reportAbove(facts)
    ? 'the text report above'
    : `${format} on stdout`
  const files = facts.outputs.length === 0
    ? ''
    : `; --output ${listed(facts.outputs)} written`
  return `result: ${where}${view === 'public'
    ? ' (public view)'
    : ''}${files}`
}

/**
 * The summary's lines for a review whose events were folded into `state`, in this order, each left out when it has
 * nothing to say: the time, the tokens (not under the public view), the calls, the gaps with their fixes, where the
 * report went and, when a rerun could fill what is missing, how to resume it. A review whose stages never started has no summary. `dash` is the glyph set's.
 */
export function summaryLines(state: ViewState, facts: SummaryFacts, view: ReportView, dash: string): string[] {
  if (state.stages.size === 0) return []
  const lines = [
    timeLine(state, facts, view, dash),
    view === 'public'
      ? undefined
      : tokensLine(state),
    callsLine(state),
    gapsLine(state, view),
    resultLine(facts, view),
    resumeLine(facts),
  ]
  return lines.flatMap(line => line === undefined
    ? []
    : [
        inertLine(line),
      ])
}
