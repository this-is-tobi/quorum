/**
 * The block the live view redraws under the log: at most 8 lines of where a review stands, pure, from the view's
 * state, the time, the terminal's size and the glyphs, so the whole sweep of sizes is tested with no terminal.
 *
 * Every line is made in three steps, in this order and for this reason. A name from a config (a profile's id) is
 * first made inert, so a control, an escape or a bidi override in it is shown as `<U+XXXX>` and no terminal acts on
 * it. The line's plain text is then measured and cut to the columns less one, with the ellipsis: measuring before
 * the colour is added means an escape sequence is never counted as a column, and cutting before it means one is never
 * cut in half. Only then is colour put around quorum's own glyphs and a bar's finished cells, from the 16-colour
 * palette. So the sequences a terminal receives from the block are quorum's alone, whatever the names hold, and no
 * line is wider than the terminal less one column, which a terminal would wrap.
 *
 * The block narrows, then shortens, then goes with the terminal: 20-cell bars and the sparkline from 80 columns, 10
 * cells below, the one line alone below 40; at most 8 lines, the hint last, and at most two fewer than the rows, none under 4 rows.
 */

import { REVIEW_CEILING } from '../../core/lanes.ts'
import { inertLine } from '../../core/sanitize.ts'
import { tokenWords } from '../../report/lines.ts'
import type { ReportView } from '../../report/view.ts'
import { partsOf, rangeWords, researchRuns } from './eta.ts'
import type { TimeLeft } from './eta.ts'
import type { Glyphs } from './glyphs.ts'
import { elapsedWords, kindWords } from './lines.ts'
import { BUCKET_MS, BUCKETS } from './model.ts'
import type { CallState, LaneState, ProfileState, ViewState } from './model.ts'
import { cut, widthOf } from './width.ts'

export interface FrameOptions {
  readonly columns: number
  readonly rows: number
  readonly glyphs: Glyphs
  readonly color: boolean
  readonly view: ReportView
  readonly timeLeft: TimeLeft
}

/** The most lines the block takes, the hint of a stopping review included. */
const MAX_LINES = 8
/** The fewest rows a block is drawn in: its rule and a profile line, and two rows of the screen left to the log. */
const MIN_ROWS = 4
/** The rows of the terminal the block leaves to the log. */
const LOG_ROWS = 2
/** The columns from which the bars are wide and the tokens line has its sparkline, and below which the block is one line. */
const WIDE_COLUMNS = 80
/** The columns below which the calls line's head is its short form. */
const NARROW_COLUMNS = 60
const ONE_LINE_COLUMNS = 40
const WIDE_CELLS = 20
const NARROW_CELLS = 10
/** The width of the labels that start the lines, and of the profile's id in them: one column less, for the space after it. */
const LABEL = 10

const ESC = String.fromCharCode(0x1B)

/** The colours the block has, with the code of each: its bars' finished cells and its retry glyph. */
const TINTS = { cyan: 36, yellow: 33 } as const
type Tint = keyof typeof TINTS

/** A stretch of a line: its text, and the colour of its glyphs when it is one. */
interface Piece {
  readonly text: string
  readonly tint?: Tint
}

type Row = readonly Piece[]

const plain = (row: Row): string => row.map(piece => piece.text).join('')

/** `text` as a row of one uncoloured piece. */
function words(text: string): Row {
  return [
    { text },
  ]
}

/** `row` as a terminal line: its text cut to `columns - 1`, then its glyphs coloured when `color` is set. */
function finish(row: Row, options: FrameOptions): string {
  const { glyphs, color } = options
  const whole = plain(row)
  const cutText = cut(whole, options.columns - 1, glyphs.ellipsis)
  const kept = cutText === whole
    ? whole.length
    : cutText.endsWith(glyphs.ellipsis)
      ? cutText.length - glyphs.ellipsis.length
      : 0
  let left = kept
  let line = ''
  for (const { text, tint } of row) {
    const shown = text.slice(0, left)
    left -= shown.length
    line += shown !== '' && color && tint !== undefined
      ? `${ESC}[${TINTS[tint]}m${shown}${ESC}[0m`
      : shown
  }
  return cutText === whole
    ? line
    : `${line}${cutText.endsWith(glyphs.ellipsis)
      ? glyphs.ellipsis
      : ''}`
}

/** The rule, as wide as the line may be, ending with the time in. */
function ruleRow(elapsed: number, columns: number, glyphs: Glyphs): Row {
  const tail = ` ${elapsedWords(elapsed)} ${glyphs.rule}${glyphs.rule}`
  return words(`${glyphs.rule.repeat(Math.max(0, columns - 1 - tail.length))}${tail}`)
}

/** A bar of `cells` cells, `done` of `total` of them finished, whole only when `done` has reached `total`. */
function bar(done: number, total: number, cells: number, finished: boolean, glyphs: Glyphs): Row {
  const filled = total > 0
    ? Math.min(cells, Math.floor(done / total * cells))
    : finished
      ? cells
      : 0
  return [
    {
      text: glyphs.done.repeat(filled),
      tint: 'cyan',
    },
    {
      text: glyphs.todo.repeat(cells - filled),
    },
  ]
}

/** A profile's id for the label column: inert, then cut to the column less one and padded to it. */
function labelOf(id: string, glyphs: Glyphs): string {
  const name = cut(inertLine(id), LABEL - 1, glyphs.ellipsis)
  return `${name}${' '.repeat(LABEL - widthOf(name))}`
}

/** The research is over for a profile: its parts are all answered or ended. */
const researchOver = ({ parts, done }: ProfileState): boolean => parts !== undefined && done >= parts

/** Whether the review is in its panel: research is over everywhere and a panel has started. */
function inPanel(state: ViewState): boolean {
  return !researchRuns(state) && [
    ...state.profiles.values(),
  ].some(profile => profile.votes !== undefined)
}

function profileRow(id: string, profile: ProfileState, state: ViewState, cells: number, options: FrameOptions): Row {
  const { glyphs } = options
  const label = labelOf(id, glyphs)
  if (profile.votes !== undefined) {
    return [
      { text: `${label}panel    ` },
      ...bar(profile.cast, profile.votes, cells, profile.stage === 'done', glyphs),
      { text: `  ${profile.cast}/${profile.votes} votes ${glyphs.dot} ${profile.kept} kept` },
    ]
  }
  const parts = partsOf(state, id)
  // what a reply listed is left out of the public view, as the part's log line leaves it out
  const listed = options.view === 'public'
    ? ''
    : ` ${glyphs.dot} ${profile.listed} finding(s) listed`
  return [
    { text: `${label}research ` },
    ...bar(profile.done, parts, cells, researchOver(profile), glyphs),
    { text: `  ${profile.done}/${parts} parts${listed}` },
  ]
}

/** The profile lines: one each for at most two profiles, else the first and a line for the rest. */
function profileRows(state: ViewState, cells: number, options: FrameOptions): Row[] {
  const entries = [...state.profiles]
  if (entries.length <= 2) return entries.map(([id, profile]) => profileRow(id, profile, state, cells, options))
  const [[firstId, first], ...rest] = entries
  const sum = (pick: (id: string, profile: ProfileState) => number): number => rest.reduce((total, [id, profile]) => total + pick(id, profile), 0)
  return [
    profileRow(firstId, first, state, cells, options),
    words(`and ${rest.length} more profile(s): ${sum((_, profile) => profile.done)}/${sum(id => partsOf(state, id))} parts, ${sum((_, profile) => profile.cast)}/${sum((_, profile) => profile.votes ?? 0)} votes`),
  ]
}

/** The one line of a narrow terminal: where research or the panel stands, the calls in flight and the time in. */
function oneRow(state: ViewState, now: number, options: FrameOptions): Row {
  const profiles = [...state.profiles]
  const sum = (pick: (id: string, profile: ProfileState) => number): number => profiles.reduce((total, [id, profile]) => total + pick(id, profile), 0)
  const { dot } = options.glyphs
  const progress = inPanel(state)
    ? `panel ${sum((_, profile) => profile.cast)}/${sum((_, profile) => profile.votes ?? 0)}`
    : `research ${sum((_, profile) => profile.done)}/${sum(id => partsOf(state, id))}`
  return words(`${progress} ${dot} ${state.calls.size} calls ${dot} ${elapsedWords(now - (state.startedAt ?? now))}`)
}

/** The label of a call in the calls line: `p20`, `p8.2` for a piece of a part, `f12` for a vote of a finding. */
function callLabel(state: ViewState, call: CallState): string {
  if (call.part !== undefined) {
    return call.part.piece === undefined
      ? `p${call.part.index}`
      : `p${call.part.index}.${call.part.piece.index}`
  }
  return `f${state.findings.get(call.finding ?? '') ?? '?'}`
}

/**
 * One call in flight as an item of the calls line: its label and its time, or while it waits to retry, its failure and the
 * seconds left. A streamed call has a spinner before it, which turns only when its output grows, so a still one is a silent
 * call, and after its time the tokens it has shown (not under the public view) or that only keep-alives came, once it has progressed,
 * both left out when `detailed` is false.
 */
function callItem(state: ViewState, call: CallState, now: number, glyphs: Glyphs, view: ReportView, detailed: boolean): Row {
  const label = callLabel(state, call)
  if (call.waitingUntil !== undefined && call.waitingUntil > now && call.failure !== undefined) {
    return [
      { text: glyphs.retry, tint: 'yellow' },
      { text: ` ${label} ${kindWords(call.failure)}, ${Math.ceil((call.waitingUntil - now) / 1000)}s` },
    ]
  }
  const elapsed = elapsedWords(now - call.startedAt)
  if (!call.stream) return words(`${label} ${elapsed}`)
  const spin = glyphs.spinner[call.turns % glyphs.spinner.length]
  if (!detailed) return words(`${spin} ${label} ${elapsed}`)
  if (call.outputTokens > 0 && view !== 'public') return words(`${spin} ${label} ${elapsed} ~${tokenWords(call.outputTokens)}`)
  return words(call.outputTokens === 0 && call.keepAlive
    ? `${spin} ${label} ${elapsed} keep-alives only`
    : `${spin} ${label} ${elapsed}`)
}

/** The research parts not yet started, and the votes not yet started of the panels that began. */
function toGo(state: ViewState): number {
  const started = new Set([
    ...state.planned.keys(),
    ...state.partsEnded,
  ])
  let parts = 0
  let votes = 0
  for (const [id, profile] of state.profiles) {
    parts += partsOf(state, id)
    if (profile.votes !== undefined) votes += profile.votes - profile.cast
  }
  let flying = 0
  for (const call of state.calls.values()) {
    if (call.role === 'vote') flying += 1
  }
  return Math.max(0, parts - started.size) + Math.max(0, votes - flying)
}

/**
 * Rows of `header` and then the pieces, three spaces apart, a row after the first indented under the header's text; undefined when
 * they need more than `maxRows`. A `bare` header holds no text yet, so the first piece follows it with no gap.
 */
function place(pieces: readonly Row[], header: { readonly text: string, readonly bare: boolean }, width: number, maxRows: number): Row[] | undefined {
  const gap = '   '
  const rows: Piece[][] = [
    [
      { text: header.text },
    ],
  ]
  let used = widthOf(header.text)
  for (const piece of pieces) {
    const size = widthOf(plain(piece))
    const sep = rows.length === 1 && rows[0].length === 1 && header.bare
      ? ''
      : gap
    if (used + sep.length + size <= width) {
      rows.at(-1)!.push({ text: sep }, ...piece)
      used += sep.length + size
      continue
    }
    if (rows.length >= maxRows) return undefined
    rows.push([
      {
        text: ' '.repeat(LABEL),
      },
      ...piece,
    ])
    used = LABEL + size
  }
  return rows
}

/** One lane's entry in the calls line's head: its calls at once, and why: a wait it holds new calls to, else what changed its limit last. */
function laneEntry(id: string, lane: LaneState, now: number): string {
  const { limit, failure, pausedUntil, pacedUntil } = lane
  const seconds = (until: number): number => Math.ceil((until - now) / 1000)
  if (pausedUntil !== undefined && pausedUntil > now) {
    return `${id} paused ${seconds(pausedUntil)}s${failure === undefined
      ? ''
      : ` (${kindWords(failure)})`}`
  }
  if (pacedUntil !== undefined && pacedUntil > now) return `${id} paced ${seconds(pacedUntil)}s`
  switch (lane.last) {
    case 'cut':
      return failure === undefined
        ? `${id} ${limit} at once`
        : `${id} ${limit} at once after ${kindWords(failure)}`
    case 'grown':
    case 'regrown':
      return `${id} ${limit} at once, growing`
    case 'slots':
      return `${id} ${limit} at once (slots)`
    default:
      return `${id} ${limit} at once`
  }
}

/**
 * What the calls line says before its items: the calls at once of each lane, joined by `; `, or the setting's when `concurrency` is
 * set. When `narrow`, `<n> at once` alone: the setting's, else the lanes' limits summed, at most the review's ceiling, none with no lane.
 */
function laneHead(state: ViewState, now: number, narrow: boolean): string {
  const { concurrency } = state.facts
  if (narrow) {
    if (concurrency !== 'auto') return `${concurrency} at once`
    if (state.lanes.size === 0) return ''
    const sum = [
      ...state.lanes.values(),
    ].reduce((total, { limit }) => total + limit, 0)
    return `${Math.min(sum, REVIEW_CEILING)} at once`
  }
  if (concurrency !== 'auto') return `${concurrency} at once (concurrency)`
  return [...state.lanes].map(([id, lane]) => laneEntry(inertLine(id), lane, now)).join('; ')
}

/**
 * The calls lines, in at most `maxRows` rows: the calls in flight by start, as many as the rows hold, then `+<n> more`
 * for those no row held and `+<n> to go` for the parts or votes not yet started. Below 80 columns each number of calls, most
 * first, is tried with each call's details, then without, before one fewer: a call's count goes before a call does.
 */
function callRows(state: ViewState, now: number, options: FrameOptions, maxRows: number): Row[] {
  const calls = [
    ...state.calls.values(),
  ].sort((a, b) => a.startedAt - b.startedAt)
  const itemsOf = (detailed: boolean): Row[] => calls.map(call => callItem(state, call, now, options.glyphs, options.view, detailed))
  const items = itemsOf(true)
  const plainItems = options.columns < WIDE_COLUMNS
    ? itemsOf(false)
    : items
  const head = laneHead(state, now, options.columns < NARROW_COLUMNS)
  const header = { text: `calls     ${head}`, bare: head === '' }
  const left = toGo(state)
  const tailOf = (held: number): Row[] => [
    ...held < items.length
      ? [
          words(`+${items.length - held} more`),
        ]
      : [],
    ...left > 0
      ? [
          words(`+${left} to go`),
        ]
      : [],
  ]
  for (let held = items.length; held >= 0; held--) {
    for (const shown of plainItems === items
      ? [items]
      : [items, plainItems]) {
      const rows = place([
        ...shown.slice(0, held),
        ...tailOf(held),
      ], header, options.columns - 1, maxRows)
      if (rows !== undefined) return rows
    }
  }
  // not even the tail fits: one row, which the cut shortens
  return [
    [
      { text: header.text },
      ...tailOf(0).flatMap(piece => [
        { text: '   ' },
        ...piece,
      ]),
    ],
  ]
}

/** The window the rate reads, and the least time it is told over, so the first seconds of a review do not read high. */
const RATE_WINDOW_MS = 60_000
const RATE_COVERED_MS = 10_000

/**
 * The output tokens of the buckets, as the sparkline's cells and the rate over the last minute, as of `now`. The window is
 * the current cell and the one before it whole, and the oldest cell for the share of it still inside the minute, so the rate
 * has no step as a cell rolls over; it divides by the time the window covers, that of the review when that is shorter and at
 * least 10 s, so the first seconds do not read high. None while the window holds no tokens, since calls of minutes end
 * rarely and a rate of 0 would be said most of the time.
 */
function sparkline(state: ViewState, now: number, glyphs: Glyphs): { readonly spark: string, readonly rate?: number } {
  const { start, tokens } = state.buckets
  const last = Math.max(0, Math.floor((now - start) / BUCKET_MS))
  const cells = Array.from({ length: BUCKETS }, (_, at) => tokens[last - (BUCKETS - 1) + at] ?? 0)
  const peak = Math.max(...cells)
  const top = glyphs.spark.length - 1
  const spark = cells
    .map(cell => cell <= 0
      ? glyphs.spark[0]
      : glyphs.spark[Math.min(top, Math.max(1, Math.ceil(cell / peak * top)))])
    .join('')
  // the oldest cell's share still inside the window is what the current cell has left to run
  const share = 1 - Math.max(0, Math.min(1, (now - (start + last * BUCKET_MS)) / BUCKET_MS))
  const inWindow = cells[BUCKETS - 1] + cells[BUCKETS - 2] + cells[BUCKETS - 3] * share
  const coveredMs = Math.max(RATE_COVERED_MS, Math.min(RATE_WINDOW_MS, now - (state.startedAt ?? now)))
  return inWindow > 0
    ? {
        spark,
        rate: Math.round(inWindow / (coveredMs / 1000)),
      }
    : { spark }
}

function tokensRow(state: ViewState, now: number, wide: boolean, glyphs: Glyphs): Row {
  const { spark, rate } = sparkline(state, now, glyphs)
  const spent = `${tokenWords(state.spent)} of ${tokenWords(state.facts.cap.tokens)}`
  const speed = rate === undefined
    ? ''
    : `${rate} tok/s`
  return words((wide
    ? `tokens    ${spent}   ${spark}  ${speed}`
    : `tokens    ${spent}   ${speed}`).trimEnd())
}

function timeRow(state: ViewState, left: TimeLeft, glyphs: Glyphs): Row | undefined {
  if (left.kind === 'none') return undefined
  const votes = left.then === undefined || left.then <= 0
    ? ''
    : `, then up to ${left.then} votes`
  if (left.kind === 'estimating') {
    return words(inPanel(state)
      ? 'time      estimating the time left for votes'
      : `time      estimating the time left for research${votes}`)
  }
  const range = rangeWords(left.lowMs, left.highMs, glyphs.range)
  return words(left.stage === 'panel'
    ? `time      about ${range} left for votes`
    : `time      about ${range} left for research${votes}`)
}

/** What the block's last line says of the keys: how to stop the review. */
const HINT = 'Ctrl-C stops the review and keeps what it read'

/** The block's last line: the hint, or after an interrupt the calls still in flight and the seconds of the grace left, rounded up. */
function hintRow(state: ViewState, now: number): Row {
  const { stopping } = state
  if (stopping?.cause !== 'interrupt') return words(HINT)
  const seconds = Math.max(0, Math.ceil((stopping.at + (stopping.graceMs ?? 0) - now) / 1000))
  return words(`stopping: ${state.calls.size} call(s) end within ${elapsedWords(seconds * 1000)}; Ctrl-C again quits without the result`)
}

/**
 * The lines of the block for `state` as of `now`, none before `run:start` and after `run:end`, none under 4 rows.
 * In the order: the rule, the profile lines, the calls lines, the tokens line (the full view's), the time line, the hint
 * (or, once the review is interrupted, the stopping hint, which counts the grace down). When the rows are short, the hint
 * goes first, then the second calls line, then the profile lines past the first, the tokens line, the time line and the
 * calls line, so a terminal of 4 rows keeps the rule and the first profile alone.
 */
export function frameLines(state: ViewState, now: number, options: FrameOptions): string[] {
  const { columns, rows, glyphs } = options
  if (state.startedAt === undefined || state.ended || rows < MIN_ROWS) return []
  const limit = Math.min(MAX_LINES, rows - LOG_ROWS)
  if (columns < ONE_LINE_COLUMNS) {
    return [
      finish(oneRow(state, now, options), options),
    ]
  }
  const wide = columns >= WIDE_COLUMNS
  const profiles = profileRows(state, wide
    ? WIDE_CELLS
    : NARROW_CELLS, options)
  const [first = [], ...more] = profiles
  let free = limit - 1 - (profiles.length > 0
    ? 1
    : 0)
  const take = (count: number): boolean => {
    if (count > free) return false
    free -= count
    return true
  }
  const withCalls = take(1)
  const timeLine = timeRow(state, options.timeLeft, glyphs)
  const time = timeLine !== undefined && take(1)
    ? timeLine
    : undefined
  const withTokens = options.view === 'full' && take(1)
  const withMore = more.length > 0 && take(more.length)
  const calls = withCalls
    ? callRows(state, now, options, free > 0
        ? 2
        : 1)
    : []
  if (calls.length > 1) free -= calls.length - 1
  const hint = take(1)
    ? hintRow(state, now)
    : undefined
  const block: Row[] = [
    ruleRow(now - state.startedAt, columns, glyphs),
    ...profiles.length > 0
      ? [first]
      : [],
    ...withMore
      ? more
      : [],
    ...calls,
    ...withTokens
      ? [
          tokensRow(state, now, wide, glyphs),
        ]
      : [],
    ...time === undefined
      ? []
      : [time],
    ...hint === undefined
      ? []
      : [hint],
  ]
  return block.map(row => finish(row, options))
}
