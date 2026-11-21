import { describe, expect, it } from 'vitest'
import { diffSections, parseHunks } from './diff.ts'
import type { DiffSection } from './diff.ts'
import { coverageOf, cutSection, packParts, partText, sliceText } from './parts.ts'
import type { Cut, PartOutcome, Slice, Unplaced } from './parts.ts'
import { halves, MAX_DEPTH, unitsOf } from './recovery.ts'
import type { Piece } from './recovery.ts'
import { tokenBound } from './tokens.ts'

/** A hunk of `rows` context lines, `pad` characters wide each, opening at line `start`. */
function hunk(start: number, rows: number, pad = 1): string {
  return [
    `@@ -${start},${rows} +${start},${rows} @@`,
    ...Array.from({ length: rows }, (_, row) => ` ${'c'.repeat(pad)}${row}`),
  ].join('\n')
}

/** A section of `file` with the given hunks, each one `[rows, pad]`. */
function sectionOf(file: string, hunks: ReadonlyArray<readonly [number, number]> = []): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    ...hunks.map(([rows, pad], index) => hunk(index * 100 + 1, rows, pad)),
  ].join('\n')
}

const sectionsOf = (...texts: string[]): DiffSection[] => diffSections(texts.join('\n'))

const none: ReadonlyMap<number, Cut> = new Map()
const root = (slices: readonly Slice[], depth = 0, index = 1): Piece => ({ slices, depth, index })

describe('halves', () => {
  it('splits a part between its slices at the boundary that leaves the halves nearest, the first on a tie', () => {
    // Four sections of nearly 60, 20, 20 and 60 tokens: the boundary after the second leaves 80 and 80.
    const sections = sectionsOf(
      sectionOf('a.js', [
        [3, 1],
      ]),
      sectionOf('b.js'),
      sectionOf('c.js'),
      sectionOf('d.js', [
        [3, 1],
      ]),
    )
    const slices = sections.map((_, section) => ({ section }))
    const weights = slices.map(slice => tokenBound(sliceText(sections, { cuts: none }, slice)) + 1)
    const found = halves(sections, none, root(slices))!
    const sums = [1, 2, 3].map(at => Math.abs(weights.slice(0, at).reduce((a, b) => a + b, 0) - weights.slice(at).reduce((a, b) => a + b, 0)))
    const at = found.pieces[0].slices.length
    expect(sums[at - 1]).toBe(Math.min(...sums))
    expect(found.pieces[0].slices).toEqual(slices.slice(0, at))
    expect(found.pieces[1].slices).toEqual(slices.slice(at))
    expect(found.cut).toBeUndefined()
    // Two equal sections tie: the only boundary is the first.
    const pair = sectionsOf(sectionOf('a.js'), sectionOf('b.js'))
    expect(halves(pair, none, root([
      { section: 0 },
      { section: 1 },
    ]))!.pieces.map(piece => piece.slices)).toEqual([
      [
        { section: 0 },
      ],
      [
        { section: 1 },
      ],
    ])
    // Three equal sections: the boundaries after one and after two are equally far, and the first is taken.
    const trio = sectionsOf(sectionOf('a.js'), sectionOf('b.js'), sectionOf('c.js'))
    expect(halves(trio, none, root(trio.map((_, section) => ({ section }))))!.pieces[0].slices).toEqual([
      { section: 0 },
    ])
  })

  it('splits a whole section between its hunks, each half keeping its header, and returns the cut it made', () => {
    const sections = sectionsOf(sectionOf('a.js', [
      [2, 1],
      [2, 1],
      [2, 1],
      [2, 1],
    ]))
    const found = halves(sections, none, root([
      { section: 0 },
    ]))!
    expect(found.pieces.map(piece => piece.slices)).toEqual([
      [
        { section: 0, from: 0, to: 2 },
      ],
      [
        { section: 0, from: 2, to: 4 },
      ],
    ])
    expect(found.cut).toEqual([
      0,
      cutSection(sections[0].text),
    ])
    const cuts = new Map([found.cut!])
    const [low, high] = found.pieces.map(piece => partText(sections, { cuts }, piece))
    const header = sections[0].text.split('\n').slice(0, 3).join('\n')
    expect(low.startsWith(`${header}\n@@ -1,2`)).toBe(true)
    expect(high.startsWith(`${header}\n@@ -201,2`)).toBe(true)
    expect(`${low}\n${high.slice(header.length + 1)}`).toBe(sections[0].text)
    // A section the packer cut is split between the hunks of its slice, and returns no cut: it is known.
    const known = new Map([
      [
        0,
        cutSection(sections[0].text),
      ],
    ])
    const again = halves(sections, known, root([
      { section: 0, from: 1, to: 4 },
    ]))!
    expect(again.cut).toBeUndefined()
    expect(again.pieces.map(piece => piece.slices)).toEqual([
      [
        { section: 0, from: 1, to: 2 },
      ],
      [
        { section: 0, from: 2, to: 4 },
      ],
    ])
  })

  it('numbers the halves 2i - 1 and 2i among the pieces of their depth', () => {
    const sections = sectionsOf(...Array.from({ length: 8 }, (_, index) => sectionOf(`f${index}.js`)))
    let piece = root(sections.map((_, section) => ({ section })))
    const lines: Array<[number, number, number]> = []
    for (const index of [1, 2, 3]) {
      const found = halves(sections, none, piece)!
      lines.push([found.pieces[0].depth, found.pieces[0].index, found.pieces[1].index])
      // Follow the second half, whose index is the even one.
      piece = index === 1
        ? found.pieces[1]
        : found.pieces[0]
    }
    expect(lines).toEqual([
      [1, 1, 2],
      [2, 3, 4],
      [3, 5, 6],
    ])
    const second = halves(sections, none, root(sections.map((_, section) => ({ section })), 2, 3))!
    expect(second.pieces.map(half => [half.depth, half.index])).toEqual([
      [3, 5],
      [3, 6],
    ])
  })

  it.each([
    [
      'three splits deep',
      sectionsOf(sectionOf('a.js'), sectionOf('b.js')),
      [
        { section: 0 },
        { section: 1 },
      ],
      MAX_DEPTH,
    ],
    [
      'one hunk',
      sectionsOf(sectionOf('a.js', [
        [2, 1],
      ])),
      [
        { section: 0 },
      ],
      0,
    ],
    [
      'a section with no hunk',
      sectionsOf(sectionOf('a.js')),
      [
        { section: 0 },
      ],
      0,
    ],
  ] as const)('stops at the floor: %s', (_, sections, slices, depth) => {
    expect(halves(sections, none, root(slices, depth))).toBeUndefined()
    expect(MAX_DEPTH).toBe(3)
  })

  it('holds every unit of 3000 varied diffs once at any depth, each split the nearest, each piece read as the section\'s own hunks', () => {
    let seed = 20_251_121
    const random = (below: number): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed % below
    }
    let deepest = 0
    let splits = 0
    for (let round = 0; round < 3000; round++) {
      const texts = Array.from({ length: 1 + random(6) }, (_, index) => {
        const hunks = Array.from({
          length: random(15),
        }, () => [1 + random(6), 1 + random(30)] as const)
        const own = sectionOf(`f${random(4)}-${index}.js`, hunks)
        // Text outside any hunk, which travels with the hunk before it.
        return random(3) === 0
          ? `${own}\n\\ No newline at end of file`
          : own
      })
      const sections = sectionsOf(...texts)
      const cap = 40 + random(400)
      const packing = packParts(sections, { partTokens: cap, room: cap + random(200) })
      const cuts = new Map(packing.cuts)
      const leaves: Array<{ piece: Piece, outcome: PartOutcome }> = []
      const split = (piece: Piece): void => {
        const found = random(5) === 0
          ? undefined
          : halves(sections, cuts, piece)
        if (found === undefined) {
          leaves.push({
            piece,
            outcome: random(3) === 0
              ? 'reply-cut-off'
              : 'reviewed',
          })
          return
        }
        splits++
        deepest = Math.max(deepest, found.pieces[0].depth)
        if (found.cut !== undefined) cuts.set(...found.cut)
        expect(found.pieces.map(half => half.depth)).toEqual([piece.depth + 1, piece.depth + 1])
        expect(found.pieces.map(half => half.index)).toEqual([2 * piece.index - 1, 2 * piece.index])
        expect(nearest(sections, cuts, piece, found.pieces[0])).toBe(true)
        for (const half of found.pieces) split(half)
      }
      const results = packing.parts.map((part) => {
        leaves.length = 0
        split(root(part.slices))
        return {
          pieces: leaves.map(({ piece, outcome }) => ({ slices: piece.slices, outcome })),
        }
      })
      // Every unit of the diff is held by exactly one leaf of one part, or set aside.
      const held = new Map<string, number>()
      const count = (unit: Unplaced): void => {
        const key = `${unit.section}:${unit.hunk ?? '-'}`
        held.set(key, (held.get(key) ?? 0) + 1)
      }
      for (const { pieces } of results) {
        for (const leaf of pieces) {
          for (const unit of expand(sections, unitsOf(cuts, leaf))) count(unit)
        }
      }
      for (const unit of expand(sections, packing.tooLarge)) count(unit)
      const expected = sections.flatMap((_, section) => expand(sections, [
        { section },
      ]))
      expect([
        ...held.keys(),
      ].toSorted()).toEqual(expected.map(unit => `${unit.section}:${unit.hunk ?? '-'}`).toSorted())
      expect([
        ...held.values(),
      ].every(times => times === 1)).toBe(true)
      // Each slice of a hunk range reads as the section's own hunks: its header, then the lines from its first hunk to its last.
      for (const { pieces } of results) {
        for (const { slices } of pieces) {
          for (const slice of slices) expect(sliceText(sections, { cuts }, slice)).toBe(ownText(sections[slice.section].text, slice))
        }
      }
      for (const [section, cut] of cuts) expect(cut).toEqual(cutSection(sections[section].text))
      // A file is reviewed exactly when every unit of it was read.
      const coverage = coverageOf({
        files: [
          ...new Set(sections.map(({ path }) => path ?? '')),
        ],
        leftOut: [],
      }, sections, { ...packing, cuts }, results)
      const unread = new Set<string>()
      packing.tooLarge.forEach(unit => unread.add(sections[unit.section].path ?? ''))
      results.forEach(({ pieces }) => pieces.forEach(({ slices, outcome }) => {
        if (outcome !== 'reviewed') slices.forEach(slice => unread.add(sections[slice.section].path ?? ''))
      }))
      for (const entry of coverage) expect(entry.status === 'reviewed').toBe(!unread.has(entry.file))
    }
    expect(deepest).toBe(MAX_DEPTH)
    expect(splits).toBeGreaterThan(3000)
  })
})

/** Whether the first half is the boundary that leaves the two halves' texts nearest, found by trying every boundary of `piece`. */
function nearest(sections: readonly DiffSection[], cuts: ReadonlyMap<number, Cut>, piece: Piece, first: Piece): boolean {
  const { slices } = piece
  const texts = (low: readonly Slice[], high: readonly Slice[]): number => Math.abs(tokenBound(partText(sections, { cuts }, { slices: low })) - tokenBound(partText(sections, { cuts }, { slices: high })))
  // The candidates are the boundaries between the slices, else between the hunks of the one slice.
  const candidates: Array<{ low: Slice[], high: Slice[] }> = []
  if (slices.length > 1) {
    for (let at = 1; at < slices.length; at++) {
      candidates.push({
        low: slices.slice(0, at),
        high: slices.slice(at),
      })
    }
  } else {
    const [{ section, from = 0, to = cuts.get(slices[0].section)!.hunks.length }] = slices
    for (let at = from + 1; at < to; at++) {
      candidates.push({
        low: [
          { section, from, to: at },
        ],
        high: [
          { section, from: at, to },
        ],
      })
    }
  }
  const gaps = candidates.map(({ low, high }) => texts(low, high))
  const best = gaps.indexOf(Math.min(...gaps))
  return JSON.stringify(first.slices) === JSON.stringify(candidates[best].low)
}

/** The units of `units` as hunks: a whole section as each of its hunks, or as itself when it has none. */
function expand(sections: readonly DiffSection[], units: readonly Unplaced[]): Unplaced[] {
  return units.flatMap(({ section, hunk }) => {
    if (hunk !== undefined) {
      return [
        { section, hunk },
      ]
    }
    const count = parseHunks(sections[section].text).length
    return count === 0
      ? [
          { section },
        ]
      : Array.from({ length: count }, (_, at) => ({ section, hunk: at }))
  })
}

/** What a slice reads as when read from the section's own parse: a whole section, else its header and the lines from its first hunk to its last. */
function ownText(text: string, { from, to }: Slice): string {
  if (from === undefined || to === undefined) return text
  const hunks = parseHunks(text)
  const lines = text.split('\n')
  const end = to < hunks.length
    ? hunks[to].at
    : lines.length
  return [
    ...lines.slice(0, hunks[0].at),
    ...lines.slice(hunks[from].at, end),
  ].join('\n')
}
