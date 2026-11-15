/**
 * A large change in parts. A part is the share of a diff one research request holds: the diff's
 * sections packed in order within a budget of tokens, a section too large for a part split between
 * its hunks, each piece with the section's header, and a hunk never cut. These are plain functions
 * over the diff's sections: they read no provider and no profile, call nothing and keep no state, so
 * the research stage decides what a part is sent as and what became of it.
 *
 * @see ../../docs/95-reference/40-architecture.md for the module overview.
 */

import type { ReviewScope } from './coverage.ts'
import type { DiffSection, Hunk } from './diff.ts'
import type { CoverageEntry, CoverageReason, LeftOutReason, LeftRange } from './types.ts'
import { heldSpan, parseHunks } from './diff.ts'
import { showHidden } from './sanitize.ts'
import { tokenBound } from './tokens.ts'

/** The most tokens of diff text one research request of a large change holds, when `partTokens` is not set. */
export const DEFAULT_PART_TOKENS = 32_768

/** The least `partTokens` a configuration may state. */
export const MIN_PART_TOKENS = 1024

/** The most file names a part's request lists. */
export const LISTED_FILES = 100

/** The problem with a `partTokens`, in words that say what to write, or undefined for a safe integer of at least 1024. */
export function partTokensProblem(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_PART_TOKENS
    ? undefined
    : `must be a whole number of tokens from ${MIN_PART_TOKENS} to ${Number.MAX_SAFE_INTEGER}`
}

/** A section of the diff, or its header and the hunks `from` to `to` of it, `to` excluded. */
export interface Slice {
  /** The index of the section among the diff's sections. */
  readonly section: number
  /** The index of the first hunk of the slice; absent for the whole section. */
  readonly from?: number
  /** The index after the last hunk of the slice; absent for the whole section. */
  readonly to?: number
}

/** The slices one research request holds, in the diff's order. */
export interface Part {
  readonly slices: readonly Slice[]
  /** The `tokenBound` of the part's text, the slices joined by line feeds. */
  readonly tokens: number
}

/** A unit of the diff no part holds: one hunk of a section, or a section that has no hunk. */
export interface Unplaced {
  readonly section: number
  /** The index of the hunk; absent for a section with no hunk. */
  readonly hunk?: number
}

/** The hunks of a section split between parts, as `parseHunks` reads them, and where each one's `@@` line starts in the section's text. */
export interface Cut {
  readonly hunks: readonly Hunk[]
  /** The offset of each hunk's `@@` line in the section's text. */
  readonly starts: readonly number[]
}

/** How a diff's sections are packed into parts. */
export interface Packing {
  readonly parts: readonly Part[]
  /** The units that fit in no part, in the diff's order. */
  readonly tooLarge: readonly Unplaced[]
  /** The sections split between parts, by section index. */
  readonly cuts: ReadonlyMap<number, Cut>
}

/** A slice of the part being filled, whose end moves while the next hunk of its section fits. */
interface OpenSlice {
  section: number
  from?: number
  to?: number
}

/** The offset of each hunk's `@@` line in `text`, found in one pass over the text. */
function lineStarts(text: string, hunks: readonly Hunk[]): number[] {
  const starts: number[] = []
  let line = 0
  let offset = 0
  for (const { at } of hunks) {
    while (line < at) {
      offset = text.indexOf('\n', offset) + 1
      line++
    }
    starts.push(offset)
  }
  return starts
}

/** The text of the hunks `from` to `to` of a cut section, to the section's end when `to` is past the last hunk. */
function hunksText(text: string, starts: readonly number[], from: number, to: number): string {
  return text.slice(starts[from], to < starts.length
    ? starts[to] - 1
    : undefined)
}

/**
 * Pack the sections of a diff into parts, in the diff's order, by arithmetic over `tokenBound`. A
 * part holds at most `cap`, the lesser of `partTokens` and `room`, the tokens a request leaves for
 * the diff; the line feed that joins two slices counts. A section whose text fits goes whole into
 * the open part when it fits beside what is there, else into a new one. A larger section is split
 * between its hunks, each one counted with the section's header: a hunk extends the open slice of
 * its section while the part stays within `cap`, else opens a slice, in the open part when it fits,
 * else in a new part, and never joins the slice before a hunk that was set aside. A unit over `cap`,
 * a hunk or a section with no hunk, goes alone into a part of its own when it is within `room`,
 * else it is set aside. A hunk is never cut: a section is cut only at the lines `parseHunks` opens
 * a hunk at, so the text outside any hunk travels with the hunk before it, or with the header when
 * none precedes it, and every line of every section is in exactly one part, besides the header a
 * piece repeats, or in a unit set aside. The work is linear in the size of the diff.
 */
export function packParts(sections: readonly DiffSection[], budget: { readonly partTokens: number, readonly room: number }): Packing {
  const cap = Math.min(budget.partTokens, budget.room)
  const parts: Part[] = []
  const tooLarge: Unplaced[] = []
  const cuts = new Map<number, Cut>()
  let open: OpenSlice[] = []
  let used = 0
  const close = (): void => {
    if (open.length > 0) parts.push({ slices: open, tokens: used })
    open = []
    used = 0
  }
  // A slice within `cap`: in the open part when it fits beside it, the line feed counted, else in a new one.
  const place = (slice: OpenSlice, tokens: number): void => {
    if (open.length > 0 && used + 1 + tokens > cap) close()
    used = open.length === 0
      ? tokens
      : used + 1 + tokens
    open.push(slice)
  }
  // One unit over `cap`: a part of its own when it is within the room, else set aside.
  const alone = (slice: OpenSlice, tokens: number, unplaced: Unplaced): void => {
    if (tokens > budget.room) {
      tooLarge.push(unplaced)
      return
    }
    close()
    parts.push({
      slices: [slice],
      tokens,
    })
  }
  for (const [section, { text }] of sections.entries()) {
    const whole = tokenBound(text)
    if (whole <= cap) {
      place({ section }, whole)
      continue
    }
    const hunks = parseHunks(text)
    if (hunks.length === 0) {
      alone({ section }, whole, { section })
      continue
    }
    const starts = lineStarts(text, hunks)
    cuts.set(section, { hunks, starts })
    const header = starts[0] === 0
      ? 0
      : tokenBound(text.slice(0, starts[0] - 1)) + 1
    for (let hunk = 0; hunk < hunks.length; hunk++) {
      // A hunk's lines run to the next `@@` line, or to the section's end: text outside a hunk goes with it.
      const units = tokenBound(hunksText(text, starts, hunk, hunk + 1))
      const last = open.at(-1)
      if (last?.section === section && last.to === hunk && used + 1 + units <= cap) {
        last.to = hunk + 1
        used += 1 + units
        continue
      }
      const tokens = header + units
      const slice = { section, from: hunk, to: hunk + 1 }
      if (tokens <= cap) place(slice, tokens)
      else alone(slice, tokens, { section, hunk })
    }
  }
  close()
  return { parts, tooLarge, cuts }
}

/**
 * The text of a slice: the section's text for a whole slice, else the section's header (the lines
 * before its first hunk, absent when that hunk opens the section), a line feed, and the text of its
 * hunks, which ends at the section's end when the slice holds the last hunk. A slice's hunks are read
 * from `Packing.cuts`, the section's own reading, never by parsing a slice alone: `parseHunks` reads
 * a final line feed as the end of the text, so a slice that ends on an empty row, which is a blank
 * context row, parses one row short.
 */
export function sliceText(sections: readonly DiffSection[], packing: Packing, slice: Slice): string {
  const { text } = sections[slice.section]
  if (slice.from === undefined || slice.to === undefined) return text
  // A slice of a hunk range is always of a section the packing cut.
  const { starts } = packing.cuts.get(slice.section)!
  const hunks = hunksText(text, starts, slice.from, slice.to)
  return starts[0] === 0
    ? hunks
    : `${text.slice(0, starts[0] - 1)}\n${hunks}`
}

/** The text of a part: its slices joined by line feeds. */
export function partText(sections: readonly DiffSection[], packing: Packing, part: Part): string {
  return part.slices.map(slice => sliceText(sections, packing, slice)).join('\n')
}

/**
 * The files a part's request names: the distinct named files of the diff, in its order, the empty
 * name (the text no header names) left out. The list is the longest prefix of at most `LISTED_FILES`
 * names that fits `maxTokens`, each name counted as the request shows it, through `showHidden`,
 * with its line feed, and it stops at the first name that does not fit, so a name's length, which
 * the author chooses, cannot take more of the window than that. `unlisted` counts the names left
 * out. The names come back as the diff writes them: the caller shows each through `showHidden`.
 */
export function listedFiles(sections: readonly DiffSection[], maxTokens: number): { readonly files: string[], readonly unlisted: number } {
  const names = new Set<string>()
  for (const { path } of sections) {
    if (path !== undefined && path !== '') names.add(path)
  }
  const files: string[] = []
  let used = 0
  for (const name of names) {
    used += tokenBound(showHidden(name)) + 1
    if (files.length === LISTED_FILES || used > maxTokens) break
    files.push(name)
  }
  return { files, unlisted: names.size - files.length }
}

/** What became of the research part that held a unit: it was read, or the reason it was not. */
export type PartOutcome = 'reviewed' | 'request-too-large' | 'token-cap' | 'review-deadline' | 'research-failed'

/** What became of a unit of the diff: its part's outcome, or `too-large` when no part holds it. */
type Outcome = PartOutcome | 'too-large'

/** The share of a file the coverage judges alone: a section held whole, or one hunk of a section split between parts. */
interface Piece {
  readonly outcome: Outcome
  readonly section: number
  /** The index of the hunk; absent for a whole section. */
  readonly hunk?: number
}

/** A piece that was not read, whose outcome is the reason. */
type UnreadPiece = Piece & { readonly outcome: Exclude<Outcome, 'reviewed'> }

const isUnread = (piece: Piece): piece is UnreadPiece => piece.outcome !== 'reviewed'

/**
 * The outcome of each unit, as a lookup: one per section held whole or set aside whole, else one per
 * hunk of a split section. A part with no outcome, and a unit that no part holds and the packing
 * does not set aside, count as a failed read, never as a reviewed one.
 */
function outcomesOfUnits(sectionCount: number, packing: Packing | undefined, outcomes: readonly PartOutcome[]): (section: number, hunk?: number) => Outcome {
  const whole = new Map<number, Outcome>()
  const byHunk = new Map<number, Outcome[]>()
  const record = (section: number, from: number | undefined, to: number | undefined, outcome: Outcome): void => {
    if (from === undefined || to === undefined) {
      whole.set(section, outcome)
      return
    }
    const hunks = byHunk.get(section) ?? []
    byHunk.set(section, hunks)
    for (let hunk = from; hunk < to; hunk++) hunks[hunk] = outcome
  }
  if (packing === undefined) {
    for (let section = 0; section < sectionCount; section++) record(section, undefined, undefined, outcomes[0] ?? 'research-failed')
  } else {
    for (const [index, part] of packing.parts.entries()) {
      for (const { section, from, to } of part.slices) record(section, from, to, outcomes[index] ?? 'research-failed')
    }
    for (const { section, hunk } of packing.tooLarge) {
      record(section, hunk, hunk === undefined
        ? undefined
        : hunk + 1, 'too-large')
    }
  }
  return (section, hunk) => (hunk === undefined
    ? whole.get(section)
    : byHunk.get(section)?.[hunk]) ?? 'research-failed'
}

/** The ranges a piece left unread: the lines of each hunk it holds, a hunk that holds no line at its start line alone, none for a section with no hunk. */
function leftRanges(piece: UnreadPiece, sections: readonly DiffSection[], packing: Packing | undefined): LeftRange[] {
  const hunks = packing?.cuts.get(piece.section)?.hunks ?? parseHunks(sections[piece.section].text)
  const left = piece.hunk === undefined
    ? hunks
    : [hunks[piece.hunk]]
  return left.map(hunk => ({
    ...(heldSpan(hunk) ?? { start: hunk.start, end: hunk.start }),
    reason: piece.outcome,
  }))
}

/**
 * How much of each file of the diff a profile's research reviewed, in the diff's order, once per
 * file. `packing` is how `sections`, the ones the research read, were packed into the parts `outcomes`
 * tells the fate of, one outcome per part; undefined is one part that holds every section whole, whose outcome is
 * `outcomes[0]`, `'research-failed'` when there is none. In this order:
 * 1. Each section's outcome: one when it is whole in a part, set aside whole, or in a one-part plan;
 *    else one per hunk, `too-large` for the units the packing set aside.
 * 2. Each file's pieces, in the diff's order: a section held whole is one piece, whose ranges are
 *    all its hunks' (parsed only when a range is asked for, which a file of one section never needs),
 *    a split one a piece per hunk. A file of several sections, as a `format-patch` series has, is one
 *    file, and the sections no header names, the text before the first header and a header that
 *    names no path, are the file of the empty name.
 * 3. Each file of `scope.files`, in its order: `excluded` with no piece when `leftOut` excludes it;
 *    `unreviewed` for `binary`, else `submodule`, when `leftOut` lists it so, whatever became of its
 *    part; `reviewed` when every piece was read; `unreviewed` with its first piece's reason when none
 *    was; else `partial`, with the range of each hunk of each piece left, each with its reason, and
 *    none for a section with no hunk.
 * A file with no piece that nothing excludes is unreviewed, never reviewed.
 */
export function coverageOf(scope: Pick<ReviewScope, 'files' | 'leftOut'>, sections: readonly DiffSection[], packing: Packing | undefined, outcomes: readonly PartOutcome[]): CoverageEntry[] {
  const outcomeOf = outcomesOfUnits(sections.length, packing, outcomes)
  const pieces = new Map<string, Piece[]>()
  for (const [section, { path }] of sections.entries()) {
    const own = pieces.get(path ?? '') ?? []
    pieces.set(path ?? '', own)
    const cut = packing?.cuts.get(section)
    if (cut === undefined) {
      own.push({
        outcome: outcomeOf(section),
        section,
      })
    } else {
      cut.hunks.forEach((_, hunk) => own.push({
        outcome: outcomeOf(section, hunk),
        section,
        hunk,
      }))
    }
  }
  const listed = (reason: LeftOutReason): Set<string> => new Set(scope.leftOut.filter(entry => entry.reason === reason).map(entry => entry.file))
  const excluded = listed('excluded')
  const binary = listed('binary')
  const submodule = listed('submodule')
  return scope.files.map((file): CoverageEntry => {
    const own = pieces.get(file) ?? []
    if (own.length === 0 && excluded.has(file)) return { file, status: 'excluded' }
    if (binary.has(file) || submodule.has(file)) {
      return {
        file,
        status: 'unreviewed',
        reason: binary.has(file)
          ? 'binary'
          : 'submodule',
      }
    }
    const unread = own.filter(isUnread)
    if (own.length > 0 && unread.length === 0) return { file, status: 'reviewed' }
    if (unread.length === own.length) {
      const reason: CoverageReason = unread[0]?.outcome ?? 'research-failed'
      return { file, status: 'unreviewed', reason }
    }
    return {
      file,
      status: 'partial',
      left: unread.flatMap(piece => leftRanges(piece, sections, packing)),
    }
  })
}
