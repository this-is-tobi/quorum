/**
 * How a research part is split when its reply was cut off at its limit, or listed as many findings as it was
 * asked for at most: plain functions over the diff's sections, with no provider, no state and no call, so the
 * research stage decides what to send and what became of it (see `stages/research.ts` for the loop).
 *
 * A piece is a part's slices, the depth it lies at (0 is the part) and its index among the `2^depth` pieces of
 * that depth, from 1 in the diff's order, so the halves of piece `i` are `2i - 1` and `2i`. A piece is split
 * between its slices when it holds several, else between the hunks of its one slice, a whole section being cut
 * there with the packer's own reading (`cutSection`), each half of a section keeping the section's header. The
 * boundary is the one that leaves the two halves' `tokenBound` counts nearest, the first on a tie: a slice or a
 * hunk is counted with the line feed that joins it, so the halves' texts differ by exactly the difference of the
 * two sums. A hunk is never cut, and a piece that holds one unit, a hunk or a section with fewer than two hunks,
 * or that lies three splits deep, is the floor: it is not split again.
 *
 * Why the floor is a depth as well as a hunk (Windows 18): reviewed content can force a cut-off, and an
 * output-length attack can cut every piece at every depth. Three splits make a part's calls at most
 * 1 + 2 + 4 + 8 = 15 whatever the content, and its tokens a constant multiple of the part, which the estimate
 * states; pieces of an eighth of a part hold an honest reply on any window quorum accepts.
 *
 * @see ../../docs/20-using/20-configuration.md for what a user reads of it.
 */

import type { DiffSection } from './diff.ts'
import { cutSection, hunksText, sliceText } from './parts.ts'
import type { Cut, Slice, Unplaced } from './parts.ts'
import { tokenBound } from './tokens.ts'

/** The most splits deep a piece lies: a part makes at most 1 + 2 + 4 + 8 research calls. */
export const MAX_DEPTH = 3

/** A part, or half of one, as recovery asks it: the slices it holds, how many splits deep it lies and its index among the `2^depth` pieces of its depth, from 1 in the diff's order. */
export interface Piece {
  readonly slices: readonly Slice[]
  readonly depth: number
  readonly index: number
}

/** The index, from 0, of the first weight of the second half: the boundary that leaves the two sums nearest, the first on a tie. At least two weights. */
function boundaryOf(weights: readonly number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let before = 0
  let best = 1
  let gap = Number.POSITIVE_INFINITY
  for (let boundary = 1; boundary < weights.length; boundary++) {
    before += weights[boundary - 1]
    const apart = Math.abs(total - 2 * before)
    if (apart < gap) {
      gap = apart
      best = boundary
    }
  }
  return best
}

/**
 * The two halves of `piece`, or `undefined` at the floor: three splits deep, or one unit. `cuts` are the cuts of the
 * sections already split between hunks, the packer's and recovery's; a section held whole that this split cuts
 * between its hunks comes back as `cut`, for the caller to add to them, since a slice of its hunks is read from it.
 */
export function halves(sections: readonly DiffSection[], cuts: ReadonlyMap<number, Cut>, piece: Piece): { readonly pieces: readonly [Piece, Piece], readonly cut?: readonly [section: number, cut: Cut] } | undefined {
  if (piece.depth >= MAX_DEPTH) return undefined
  const half = (slices: readonly Slice[], index: number): Piece => ({ slices, depth: piece.depth + 1, index })
  const first = 2 * piece.index - 1
  const { slices } = piece
  if (slices.length > 1) {
    const at = boundaryOf(slices.map(slice => tokenBound(sliceText(sections, { cuts }, slice)) + 1))
    return {
      pieces: [
        half(slices.slice(0, at), first),
        half(slices.slice(at), first + 1),
      ],
    }
  }
  const [slice] = slices
  const known = cuts.get(slice.section)
  const cut = known ?? cutSection(sections[slice.section].text)
  const from = slice.from ?? 0
  const to = slice.to ?? cut.hunks.length
  if (to - from < 2) return undefined
  const { text } = sections[slice.section]
  const at = from + boundaryOf(Array.from({ length: to - from }, (_, hunk) => tokenBound(hunksText(text, cut.starts, from + hunk, from + hunk + 1)) + 1))
  const { section } = slice
  return {
    pieces: [
      half([
        { section, from, to: at },
      ], first),
      half([
        { section, from: at, to },
      ], first + 1),
    ],
    ...known === undefined
      ? {
          cut: [section, cut] as const,
        }
      : {},
  }
}

/** The units a piece holds, in the diff's order: each hunk of a slice of hunks, each hunk of a whole section `cuts` has cut, else the whole section as one unit. */
export function unitsOf(cuts: ReadonlyMap<number, Cut>, piece: Pick<Piece, 'slices'>): Unplaced[] {
  return piece.slices.flatMap(({ section, from, to }): Unplaced[] => {
    const hunks = cuts.get(section)?.hunks.length ?? 0
    if (from !== undefined && to !== undefined) return Array.from({ length: to - from }, (_, hunk) => ({ section, hunk: from + hunk }))
    return hunks === 0
      ? [
          { section },
        ]
      : Array.from({ length: hunks }, (_, hunk) => ({ section, hunk }))
  })
}
