import type { DiffSection, Hunk } from './diff.ts'
import type { Packing, PartOutcome, PartResult, Slice } from './parts.ts'
import { describe, expect, it } from 'vitest'
import { reviewScope } from './coverage.ts'
import { diffSections, heldSpan, parseHunks } from './diff.ts'
import { excludeMatcher } from './exclude.ts'
import { coverageOf, cutSection, listedFiles, nearestHunks, packParts, partText, partTokensProblem, sliceText } from './parts.ts'
import { tokenBound } from './tokens.ts'

const t = tokenBound

/** The three lines before the first hunk of a file's section. */
const headerOf = (file: string): string => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`].join('\n')

/** A hunk of `rows` context lines, each `tag` and its index, so a hunk's length is its row count and its tag's length. */
function hunkOf(rows: number, tag: string, start = 1): string {
  return [
    `@@ -${start},${rows} +${start},${rows} @@`,
    ...Array.from({ length: rows }, (_, row) => ` ${tag}${row}`),
  ].join('\n')
}

/** The sections of a diff whose files each have a header and the given hunks. */
function sectionsOf(...files: Array<[file: string, hunks: string[]]>): DiffSection[] {
  return diffSections(files.map(([file, hunks]) => [
    headerOf(file),
    ...hunks,
  ].join('\n')).join('\n'))
}

/** The offset of each hunk's `@@` line in `text`. */
function startsOf(text: string, hunks: readonly Hunk[]): number[] {
  const lines = text.split('\n')
  return hunks.map(({ at }) => lines.slice(0, at).reduce((offset, line) => offset + line.length + 1, 0))
}

/** The fields of a hunk the section's own reading and a piece read alone must share: all but where its `@@` line is. */
const readOf = ({ start, count, rows, rowOfLine }: Hunk): unknown => ({ start, count, rows, rowOfLine })

/**
 * The hunks a slice of hunks reads as when its text is parsed. `parseHunks` reads a final line feed as
 * the end of the text, so a slice that ends on a literal empty row reads one row short parsed alone:
 * `withLineFeed` adds the line feed that followed the slice in its section, none for a slice that runs
 * to the section's end, which is the text as the section's own reading saw it.
 */
function readSlice(sections: readonly DiffSection[], packing: Packing, slice: Slice, withLineFeed: boolean): unknown[] {
  const text = sliceText(sections, packing, slice)
  const followed = withLineFeed && slice.to !== packing.cuts.get(slice.section)?.hunks.length
  return parseHunks(followed
    ? `${text}\n`
    : text).map(readOf)
}

/**
 * What is wrong with a packing of `sections`, in words, none when it is sound: each section whole in
 * exactly one part or set aside, or each of its hunks in exactly one slice or set aside, never a
 * slice that is not of a cut section; the header and the hunks rebuilding the section's text; each
 * slice's hunks, parsed with the line feed that followed it in its section, the section's own in
 * `cuts`; and each part's `tokens` the `tokenBound` of its text.
 */
function problems(sections: readonly DiffSection[], packing: Packing): string[] {
  const found: string[] = []
  const slices = packing.parts.flatMap(part => part.slices)
  sections.forEach(({ text }, section) => {
    const own = slices.filter(slice => slice.section === section)
    const aside = packing.tooLarge.filter(unplaced => unplaced.section === section)
    const cut = packing.cuts.get(section)
    if (cut === undefined) {
      if (own.length + aside.length !== 1) found.push(`section ${section} is held ${own.length + aside.length} times`)
      if (own.some(slice => slice.from !== undefined || slice.to !== undefined)) found.push(`section ${section} has a slice of hunks but no cut`)
      if (aside.some(unplaced => unplaced.hunk !== undefined)) found.push(`section ${section} has a hunk set aside but no cut`)
      return
    }
    const { hunks, starts } = cut
    const held = hunks.map(() => 0)
    for (const { from, to } of own) {
      if (from === undefined || to === undefined || from >= to || to > hunks.length) {
        found.push(`section ${section} has a slice that is no range of its hunks`)
        continue
      }
      for (let hunk = from; hunk < to; hunk++) held[hunk]++
    }
    for (const { hunk } of aside) {
      if (hunk === undefined) found.push(`section ${section} is cut and set aside whole`)
      else held[hunk]++
    }
    held.forEach((count, hunk) => {
      if (count !== 1) found.push(`hunk ${hunk} of section ${section} is held ${count} times`)
    })
    const header = starts[0] === 0
      ? []
      : [
          text.slice(0, starts[0] - 1),
        ]
    const rebuilt = [
      ...header,
      ...hunks.map((_, hunk) => text.slice(starts[hunk], hunk + 1 < starts.length
        ? starts[hunk + 1] - 1
        : undefined)),
    ].join('\n')
    if (rebuilt !== text) found.push(`the header and hunks of section ${section} do not rebuild its text`)
    for (const slice of own) {
      if (slice.from === undefined || slice.to === undefined) continue
      if (JSON.stringify(readSlice(sections, packing, slice, true)) !== JSON.stringify(hunks.slice(slice.from, slice.to).map(readOf))) {
        found.push(`hunks ${slice.from} to ${slice.to} of section ${section} read differently from the section's own`)
      }
    }
  })
  packing.parts.forEach((part, index) => {
    if (part.tokens !== t(partText(sections, packing, part))) found.push(`part ${index} does not count as tokenBound counts its text`)
  })
  return found
}

describe('partTokensProblem', () => {
  it('takes a whole number of tokens from 1024, and words the problem otherwise', () => {
    expect(partTokensProblem(1024)).toBeUndefined()
    expect(partTokensProblem(Number.MAX_SAFE_INTEGER)).toBeUndefined()
    for (const value of [
      1023,
      1.5,
      '32768',
      Number.MAX_SAFE_INTEGER + 2,
      undefined,
    ]) {
      expect(partTokensProblem(value)).toBe('must be a whole number of tokens from 1024 to 9007199254740991')
    }
  })
})

describe('packParts', () => {
  it('keeps a section whole in a part while its text fits beside the others, and opens a new part for one that does not', () => {
    const sections = sectionsOf([
      'a.js',
      [
        hunkOf(2, 'x'),
      ],
    ], [
      'b.js',
      [
        hunkOf(2, 'x'),
      ],
    ], [
      'c.js',
      [
        hunkOf(2, 'x'),
      ],
    ])
    const [a, b, c] = sections.map(section => t(section.text))
    expect(packParts(sections, { partTokens: a + 1 + b, room: 100_000 })).toEqual({
      parts: [
        {
          slices: [
            { section: 0 },
            { section: 1 },
          ],
          tokens: a + 1 + b,
        },
        {
          slices: [
            { section: 2 },
          ],
          tokens: c,
        },
      ],
      tooLarge: [],
      cuts: new Map(),
    })
  })

  it('splits a section too large for a part of its own between its hunks, each piece with the section\'s header', () => {
    const h = headerOf('f.js')
    const [u0, u1, u2, u3] = ['a', 'b', 'c', 'd'].map(tag => hunkOf(3, tag))
    const sections = diffSections([h, u0, u1, u2, u3].join('\n'))
    const packing = packParts(sections, { partTokens: t(h) + 1 + t(u0) + 1 + t(u1), room: 100_000 })
    expect(packing.parts.map(part => part.slices)).toEqual([
      [
        { section: 0, from: 0, to: 2 },
      ],
      [
        { section: 0, from: 2, to: 4 },
      ],
    ])
    expect(packing.parts.map(part => partText(sections, packing, part))).toEqual([
      `${h}\n${u0}\n${u1}`,
      `${h}\n${u2}\n${u3}`,
    ])
    expect(packing.tooLarge).toEqual([])
    expect(problems(sections, packing)).toEqual([])
  })

  it('puts a hunk over partTokens alone in a part when it fits the room, and sets aside one over the room and a section with no hunk over it', () => {
    const h = headerOf('f.js')
    const [u0, u1, u2] = [
      hunkOf(2, 'a'),
      hunkOf(4, 'a'),
      hunkOf(6, 'a'),
    ]
    const binary = [
      'diff --git a/img.png b/img.png',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 22',
      ...Array.from({ length: 20 }).fill('dcmWIWb7x>=V$MiSOi3+LNX|&iOHWPV0sug321x(_'),
    ].join('\n')
    const sections = diffSections([h, u0, u1, u2, binary].join('\n'))
    expect(t(binary)).toBeGreaterThan(t(u2))
    const packing = packParts(sections, { partTokens: t(h) + 1 + t(u0), room: t(h) + 1 + t(u1) })
    expect(packing.parts.map(part => part.slices)).toEqual([
      [
        { section: 0, from: 0, to: 1 },
      ],
      [
        { section: 0, from: 1, to: 2 },
      ],
    ])
    expect(packing.tooLarge).toEqual([
      { section: 0, hunk: 2 },
      { section: 1 },
    ])
    expect(problems(sections, packing)).toEqual([])
  })

  it('opens a new slice after a hunk set aside, so no slice joins hunks a gap separates', () => {
    const h = headerOf('f.js')
    const [u0, u1, u2] = [
      hunkOf(1, 'a'),
      hunkOf(30, 'long'),
      hunkOf(1, 'a'),
    ]
    const sections = diffSections([h, u0, u1, u2].join('\n'))
    const budget = 2 * t(h) + t(u0) + t(u2) + 3
    expect(t(h) + 1 + t(u1)).toBeGreaterThan(budget)
    const packing = packParts(sections, { partTokens: budget, room: budget })
    expect(packing.parts.map(part => part.slices)).toEqual([
      [
        { section: 0, from: 0, to: 1 },
        { section: 0, from: 2, to: 3 },
      ],
    ])
    expect(partText(sections, packing, packing.parts[0])).toBe(`${h}\n${u0}\n${h}\n${u2}`)
    expect(packing.tooLarge).toEqual([
      { section: 0, hunk: 1 },
    ])
    expect(problems(sections, packing)).toEqual([])
  })

  it('keeps the text of a header whose numbers are no safe integer with the hunk before it, so no range is anything but a line number', () => {
    for (const header of [
      `@@ -1 +${'9'.repeat(400)} @@`,
      `@@ -1 +${2 ** 53} @@`,
      `@@ -1,${'9'.repeat(400)} +1 @@`,
      `@@ -1 +${Number.MAX_SAFE_INTEGER},2 @@`,
    ]) {
      const diff = [
        headerOf('h.js'),
        '@@ -1 +1 @@',
        '-a',
        '+b',
        header,
        '-c',
        '+d',
        hunkOf(2, 'x', 10),
      ].join('\n')
      const sections = diffSections(diff)
      const packing = packParts(sections, { partTokens: 40, room: 100_000 })
      expect(packing.cuts.get(0)?.hunks.map(hunk => hunk.at)).toEqual([3, 9])
      expect(packing.parts).toHaveLength(2)
      expect(packing.tooLarge).toEqual([])
      expect(problems(sections, packing)).toEqual([])
      const ranges = packing.parts.flatMap((_, unread) => coverageOf(reviewScope(diff), sections, packing, packing.parts.map((__, part) => part === unread
        ? 'token-cap'
        : 'reviewed')).flatMap(entry => entry.status === 'partial'
        ? entry.left
        : []))
      expect(ranges).toEqual([
        { start: 1, end: 1, reason: 'token-cap' },
        { start: 10, end: 11, reason: 'token-cap' },
      ])
    }
  })

  it('counts each part as tokenBound counts its text, line feeds and every code point included', () => {
    const rows = [
      ` ${String.fromCharCode(0x0F81)} tibetan`,
      `+${String.fromCodePoint(0x1F600)} emoji`,
      `-lone ${String.fromCharCode(0xD800)} surrogate`,
      ' crlf row\r',
      '+another crlf row\r',
      ' plain',
    ]
    const hunks = Array.from({ length: 6 }, (_, index) => [
      `@@ -${index * 10 + 1},4 +${index * 10 + 1},4 @@`,
      ...rows.slice(index % 3, (index % 3) + 4),
    ].join('\n'))
    const sections = diffSections([
      headerOf('f.js'),
      ...hunks,
      headerOf('g.js'),
      hunks[0],
    ].join('\n'))
    const packing = packParts(sections, { partTokens: 200, room: 100_000 })
    expect(packing.parts.length).toBeGreaterThan(3)
    expect(packing.cuts.size).toBe(1)
    for (const part of packing.parts) expect(part.tokens).toBe(t(partText(sections, packing, part)))
    expect(problems(sections, packing)).toEqual([])
  })

  it('holds every line of 2000 varied diffs once, besides the header a piece repeats, at varied budgets', () => {
    let state = 42
    const next = (): number => {
      // The recurrence of the brief, computed exactly: a double cannot hold its product, and its sequence then cycles within a few thousand draws.
      state = ((Math.imul(state, 1103515245) + 12345) >>> 0) % 2147483648
      return state / 2147483648
    }
    const int = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1))
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]
    const rowTexts = [
      'ascii row',
      String.fromCodePoint(0x1F600),
      'crlf row\r',
      '',
      'x',
      String.fromCharCode(0x0F81),
    ]
    const trailing = [
      'Submodule lib 1234567..89abcde:',
      'GIT binary patch',
      'literal 22',
      'trailing text',
      'Binary files a/x and b/x differ',
    ]
    const headerOfFile = (file: string): string[] => {
      const shape = int(0, 2)
      if (shape === 0) return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`]
      if (shape === 1) return [`diff --git ${file} ${file}`, `--- ${file}`, `+++ ${file}`]
      return [`diff --git unreadable${file}`, '--- unreadable', '+++ unreadable']
    }
    const hunkLines = (): string[] => {
      // A literal empty line is a blank context row, a hunk's last included.
      const rows = Array.from({
        length: int(1, 8),
      }, () => {
        const marker = pick([' ', '-', '+'])
        return marker === ' ' && next() < 0.2
          ? ''
          : `${marker}${pick(rowTexts)}`
      })
      const oldCount = rows.filter(row => row === '' || !row.startsWith('+')).length
      const newCount = rows.filter(row => row === '' || !row.startsWith('-')).length
      const short = next() < 0.2
        ? int(1, 3)
        : 0
      const lines = [`@@ -${int(1, 50)},${oldCount + short} +${int(1, 50)},${newCount + short} @@`, ...rows]
      if (next() < 0.2) lines.push('\\ No newline at end of file')
      return lines
    }
    const diffOf = (): string => {
      const lines: string[] = next() < 0.2
        ? [
            'From 1234 Mon Sep 17 00:00:00 2001',
            'Subject: [PATCH] a change',
            '',
            '---',
            ' f0.js | 1 +',
            '',
          ]
        : []
      const files = int(1, 5)
      for (let file = 0; file < files; file++) {
        lines.push(...headerOfFile(`f${file}.js`))
        const hunks = int(0, 5)
        for (let hunk = 0; hunk < hunks; hunk++) lines.push(...hunkLines())
        if (next() < 0.2) lines.push(pick(trailing))
      }
      return lines.join('\n') + (next() < 0.5
        ? '\n'
        : '')
    }
    const failures: string[] = []
    let split = 0
    let setAside = 0
    let endedOnEmpty = 0
    let readShort = 0
    for (let index = 0; index < 2000; index++) {
      const sections = diffSections(diffOf())
      const partTokens = int(1, 200)
      const room = int(0, 300)
      const packing = packParts(sections, { partTokens, room })
      for (const problem of problems(sections, packing)) failures.push(`diff ${index} at ${partTokens} and ${room}: ${problem}`)
      for (const part of packing.parts) {
        if (part.tokens > Math.min(partTokens, room) && (part.slices.length !== 1 || part.tokens > room)) failures.push(`diff ${index} at ${partTokens} and ${room}: a part of ${part.tokens} tokens`)
      }
      split += packing.cuts.size
      setAside += packing.tooLarge.length
      // The case the check must meet: a slice that does not run to its section's end and ends on an empty row.
      for (const slice of packing.parts.flatMap(part => part.slices)) {
        if (slice.to === undefined || slice.to === packing.cuts.get(slice.section)?.hunks.length || !sliceText(sections, packing, slice).endsWith('\n')) continue
        endedOnEmpty++
        if (JSON.stringify(readSlice(sections, packing, slice, false)) !== JSON.stringify(readSlice(sections, packing, slice, true))) readShort++
      }
    }
    expect(failures).toEqual([])
    expect(split).toBeGreaterThan(500)
    expect(setAside).toBeGreaterThan(500)
    expect(endedOnEmpty).toBeGreaterThan(100)
    expect(readShort).toBe(endedOnEmpty)
  })

  const mailOf = (n: number, hunks: string[]): string[] => [
    `From ${String(n).repeat(40)} Mon Sep 17 00:00:00 2001`,
    'From: t <t@example.com>',
    `Subject: [PATCH ${n}/2] change ${n}`,
    '',
    `body of mail ${n}`,
    '---',
    ' a.js | 2 +-',
    '',
    'diff --git a/a.js b/a.js',
    'index 1111111..2222222 100644',
    '--- a/a.js',
    '+++ b/a.js',
    ...hunks,
    '-- ',
    '2.43.0',
    '',
  ]
  it.each<[string, string]>([
    [
      'a format-patch series of two mails on one file',
      [
        ...mailOf(1, [
          '@@ -1,3 +1,3 @@',
          ' one',
          '-two',
          '+TWO',
          ' three',
        ]),
        ...mailOf(2, [
          '@@ -1,3 +1,3 @@',
          ' one',
          '-TWO',
          '+two2',
          ' three',
          '@@ -10,2 +10,2 @@',
          ' ten',
          '-eleven',
          '+11',
        ]),
      ].join('\n'),
    ],
    [
      'a CRLF diff with a no-newline marker after a hunk\'s last row',
      [
        'diff --git a/c.txt b/c.txt\r',
        '--- a/c.txt\r',
        '+++ b/c.txt\r',
        '@@ -1,2 +1,2 @@\r',
        ' keep\r',
        '-old\r',
        '+new\r',
        '\\ No newline at end of file\r',
        '@@ -9 +9 @@\r',
        '-last\r',
        '+last2\r',
        '\\ No newline at end of file\r',
        '',
      ].join('\n'),
    ],
    [
      'a hunk cut short of its counts, junk, then a hunk',
      [
        'diff --git a/h.js b/h.js',
        '--- a/h.js',
        '+++ b/h.js',
        '@@ -1,5 +1,5 @@',
        ' one',
        '-two',
        'junk line that closes the hunk',
        'more junk',
        '@@ -20,2 +20,2 @@',
        ' x',
        '+y',
      ].join('\n'),
    ],
    [
      'a plain diff -u of two files with text before it',
      [
        'Only in a: left.txt',
        'diff -u a/one.txt b/one.txt',
        '--- a/one.txt\t2026-01-01',
        '+++ b/one.txt\t2026-01-02',
        '@@ -1,2 +1,2 @@',
        ' same',
        '-old',
        '+new',
        'diff -u a/two.txt b/two.txt',
        '--- a/two.txt',
        '+++ b/two.txt',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n'),
    ],
    [
      'an unreadable header and a Submodule line',
      [
        'diff --git weird-header',
        '--- weird',
        '+++ weird',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/lib b/lib',
        'index 1234567..89abcde 160000',
        '--- a/lib',
        '+++ b/lib',
        '@@ -1 +1 @@',
        '-Subproject commit 1234567',
        '+Subproject commit 89abcde',
        'Submodule other 1234567..89abcde:',
        '  > one commit',
        '',
      ].join('\n'),
    ],
    [
      'a GIT binary patch block',
      [
        'diff --git a/img.png b/img.png',
        'index 1111111..2222222 100644',
        'GIT binary patch',
        'literal 22',
        'dcmWIWb7x>=V$MiSOi3+LNX|&iOHWPV0sug321x(_',
        '',
        'literal 14',
        'VcmWIWb7x>=V$MiSOi3-`0st1Y1783D',
        '',
        'diff --git a/t.js b/t.js',
        '--- a/t.js',
        '+++ b/t.js',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n'),
    ],
  ])('holds every line once of %s, at every budget', (_name, diff) => {
    const sections = diffSections(diff)
    for (const [partTokens, room] of [
      [1, 1000],
      [5, 5],
      [20, 40],
      [1000, 1000],
      [3, 0],
    ]) {
      expect(problems(sections, packParts(sections, { partTokens, room }))).toEqual([])
    }
  })

  it('packs 16 MiB of one-line hunks in linear time', () => {
    const chunks = ['diff --git a/big.js b/big.js\n--- a/big.js\n+++ b/big.js\n']
    let size = chunks[0].length
    for (let n = 1; size < 16 * 1024 * 1024; n++) {
      const hunk = `@@ -${n} +${n} @@\n-a\n+b\n`
      chunks.push(hunk)
      size += hunk.length
    }
    const sections = diffSections(chunks.join(''))
    const started = performance.now()
    const packing = packParts(sections, { partTokens: 32_768, room: 100_000 })
    expect(performance.now() - started).toBeLessThan(5000)
    expect(packing.tooLarge).toEqual([])
    expect(packing.parts.length).toBeGreaterThan(500)
  })
})

describe('sliceText', () => {
  it('ends a slice on a literal empty row with a line feed, which parsed alone reads as the end of the text, so its hunks are read from the cuts', () => {
    const h = headerOf('f.js')
    const u0 = ['@@ -1,2 +1,2 @@', ' a', ''].join('\n')
    const u1 = ['@@ -9 +9 @@', '-b', '+c'].join('\n')
    const sections = diffSections([h, u0, u1].join('\n'))
    const packing = packParts(sections, { partTokens: t(h) + 1 + t(u0), room: 100_000 })
    expect(packing.parts.map(part => part.slices)).toEqual([
      [
        { section: 0, from: 0, to: 1 },
      ],
      [
        { section: 0, from: 1, to: 2 },
      ],
    ])
    const [first] = packing.parts[0].slices
    const text = sliceText(sections, packing, first)
    expect(text).toBe(`${h}\n${u0}`)
    expect(text.endsWith('\n')).toBe(true)
    const own = packing.cuts.get(0)?.hunks[0]
    expect(own?.rows).toEqual([' a', ''])
    // Alone, the slice reads one row fewer than the section's hunk; with the line feed that followed it, every row.
    const [alone] = parseHunks(text)
    expect(alone.rows).toEqual([' a'])
    expect(alone.rowOfLine).toEqual([0])
    expect(readSlice(sections, packing, first, false)).toEqual([
      readOf(alone),
    ])
    expect(readSlice(sections, packing, first, true)).toEqual([
      readOf(own!),
    ])
    expect(problems(sections, packing)).toEqual([])
  })
})

describe('listedFiles', () => {
  it('lists each named file once, in the diff\'s order, at most 100, and counts the rest', () => {
    const names = Array.from({ length: 150 }, (_, index) => `f${index}`)
    const diff = [
      'From 1234 Mon Sep 17 00:00:00 2001',
      'diff --git unreadable',
      ...names.map(name => `diff --git a/${name} b/${name}`),
      'diff --git a/f3 b/f3',
    ].join('\n')
    const { files, unlisted } = listedFiles(diffSections(diff), 1_000_000)
    expect(files).toEqual(names.slice(0, 100))
    expect(unlisted).toBe(50)
  })

  it('stops the list at the first name its budget does not hold, counting each name as shown with its line feed', () => {
    const hidden = `b${String.fromCharCode(0x202E)}.js`
    const sections = diffSections(['a.js', hidden, 'c.js'].map(name => `diff --git a/${name} b/${name}`).join('\n'))
    const budget = t('a.js') + 1 + t('b<U+202E>.js') + 1
    expect(listedFiles(sections, budget)).toEqual({
      files: ['a.js', hidden],
      unlisted: 1,
    })
    expect(listedFiles(sections, budget - 1)).toEqual({
      files: ['a.js'],
      unlisted: 2,
    })
    const long = diffSections([
      'x'.repeat(5000),
      'a.js',
      'c.js',
    ].map(name => `diff --git a/${name} b/${name}`).join('\n'))
    expect(listedFiles(long, budget)).toEqual({ files: [], unlisted: 3 })
  })
})

describe('coverageOf', () => {
  const FILE_A = `${headerOf('a.js')}\n@@ -1 +1 @@\n-a\n+b`
  const FILE_B = `${headerOf('b.js')}\n@@ -1 +1 @@\n-a\n+b`

  it('lists every file reviewed when the one part was read, and unreviewed with its reason when it was not, research-failed when it has no outcome', () => {
    const diff = `${FILE_A}\n${FILE_B}`
    const scope = reviewScope(diff)
    const sections = diffSections(diff)
    const reviewed = [
      { file: 'a.js', status: 'reviewed' },
      { file: 'b.js', status: 'reviewed' },
    ]
    expect(coverageOf(scope, sections, undefined, ['reviewed'])).toEqual(reviewed)
    // A part with no outcome is a failed read, never a reviewed one.
    expect(coverageOf(scope, sections, undefined, [])).toEqual([
      { file: 'a.js', status: 'unreviewed', reason: 'research-failed' },
      { file: 'b.js', status: 'unreviewed', reason: 'research-failed' },
    ])
    expect(coverageOf(scope, sections, undefined, ['token-cap'])).toEqual([
      { file: 'a.js', status: 'unreviewed', reason: 'token-cap' },
      { file: 'b.js', status: 'unreviewed', reason: 'token-cap' },
    ])
    // A file no section holds, that nothing excludes, is never reviewed.
    expect(coverageOf({
      files: ['gone.js'],
      leftOut: [],
    }, [], undefined, ['reviewed'])).toEqual([
      { file: 'gone.js', status: 'unreviewed', reason: 'research-failed' },
    ])
  })

  it('lists a split file partial, with the range and reason of each hunk left, in the diff\'s order', () => {
    const text = [
      headerOf('f.js'),
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '@@ -10,3 +10,3 @@',
      ' x',
      '-y',
      '+z',
      ' w',
      '@@ -20,2 +20,0 @@',
      '-d',
      '-e',
    ].join('\n')
    const sections = diffSections(text)
    const hunks = parseHunks(text)
    const packing: Packing = {
      parts: [
        {
          slices: [
            { section: 0, from: 0, to: 1 },
          ],
          tokens: 0,
        },
        {
          slices: [
            { section: 0, from: 1, to: 2 },
          ],
          tokens: 0,
        },
      ],
      tooLarge: [
        { section: 0, hunk: 2 },
      ],
      cuts: new Map([
        [
          0,
          {
            hunks,
            starts: startsOf(text, hunks),
          },
        ],
      ]),
    }
    expect(coverageOf(reviewScope(text), sections, packing, ['reviewed', 'token-cap'])).toEqual([
      {
        file: 'f.js',
        status: 'partial',
        left: [
          { start: 10, end: 12, reason: 'token-cap' },
          { start: 20, end: 20, reason: 'too-large' },
        ],
      },
    ])
    expect(coverageOf(reviewScope(text), sections, packing, ['token-cap', 'review-deadline'])).toEqual([
      { file: 'f.js', status: 'unreviewed', reason: 'token-cap' },
    ])
    // A hunk that no part holds and the packing does not set aside is not a hunk reviewed.
    expect(coverageOf(reviewScope(text), sections, { ...packing, tooLarge: [] }, ['reviewed', 'reviewed'])).toEqual([
      {
        file: 'f.js',
        status: 'partial',
        left: [
          { start: 20, end: 20, reason: 'research-failed' },
        ],
      },
    ])
  })

  it('lists an excluded file as excluded, and a binary or submodule file unreviewed with 3a\'s reason, whatever became of its part', () => {
    const diff = [
      FILE_A,
      'diff --git a/img.png b/img.png',
      'index 1111111..2222222 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/lib b/lib',
      'index 1234567..89abcde 160000',
      '--- a/lib',
      '+++ b/lib',
      '@@ -1 +1 @@',
      '-Subproject commit 1234567',
      '+Subproject commit 89abcde',
      `${headerOf('skip.js')}\n@@ -1 +1 @@\n-a\n+b`,
    ].join('\n')
    const scope = reviewScope(diff, excludeMatcher(['skip.js']))
    const sections = diffSections(scope.diff)
    expect(coverageOf(scope, sections, undefined, ['reviewed'])).toEqual([
      { file: 'a.js', status: 'reviewed' },
      { file: 'img.png', status: 'unreviewed', reason: 'binary' },
      { file: 'lib', status: 'unreviewed', reason: 'submodule' },
      { file: 'skip.js', status: 'excluded' },
    ])
    expect(coverageOf(scope, sections, undefined, ['review-deadline'])).toEqual([
      { file: 'a.js', status: 'unreviewed', reason: 'review-deadline' },
      { file: 'img.png', status: 'unreviewed', reason: 'binary' },
      { file: 'lib', status: 'unreviewed', reason: 'submodule' },
      { file: 'skip.js', status: 'excluded' },
    ])
  })

  it('judges a held file unreviewed with its reason, secret or deleted-secret, whatever became of its part', () => {
    const deleted = [
      'diff --git a/old/.env b/old/.env',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/old/.env',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-A=1',
    ].join('\n')
    const diff = [FILE_A, `${headerOf('.env')}\n@@ -1 +1 @@\n-a\n+b`, deleted].join('\n')
    const scope = reviewScope(diff)
    const sections = diffSections(scope.diff)
    expect(coverageOf(scope, sections, undefined, ['reviewed'])).toEqual([
      { file: 'a.js', status: 'reviewed' },
      { file: '.env', status: 'unreviewed', reason: 'secret' },
      { file: 'old/.env', status: 'unreviewed', reason: 'deleted-secret' },
    ])
    expect(coverageOf(scope, sections, undefined, ['review-deadline'])).toEqual([
      { file: 'a.js', status: 'unreviewed', reason: 'review-deadline' },
      { file: '.env', status: 'unreviewed', reason: 'secret' },
      { file: 'old/.env', status: 'unreviewed', reason: 'deleted-secret' },
    ])
    // A section the diff still holds of a file the input lists as held is unreviewed as well.
    expect(coverageOf({
      files: ['a.js'],
      leftOut: [
        { file: 'a.js', reason: 'secret', rule: 'aws-key' },
      ],
    }, diffSections(FILE_A), undefined, ['reviewed'])).toEqual([
      { file: 'a.js', status: 'unreviewed', reason: 'secret' },
    ])
  })

  it('lists a file of several sections once, partial when one was read and another was not, and the parts no header names under the empty name', () => {
    const diff = [
      'From 1111 Mon Sep 17 00:00:00 2001',
      'Subject: [PATCH 1/2] first',
      '',
      '---',
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '-- ',
      '',
      'From 2222 Mon Sep 17 00:00:00 2001',
      'Subject: [PATCH 2/2] second',
      '',
      '---',
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -5,2 +5,2 @@',
      ' x',
      '-y',
      '+z',
      'diff --git unreadable',
      '@@ -3 +3 @@',
      '-q',
      '+r',
    ].join('\n')
    const sections = diffSections(diff)
    expect(sections.map(section => section.path)).toEqual(['', 'a.js', 'a.js', undefined])
    const packing: Packing = {
      parts: [
        {
          slices: [
            { section: 0 },
            { section: 1 },
          ],
          tokens: 0,
        },
        {
          slices: [
            { section: 2 },
            { section: 3 },
          ],
          tokens: 0,
        },
      ],
      tooLarge: [],
      cuts: new Map(),
    }
    const outcomes: PartOutcome[] = ['reviewed', 'review-deadline']
    expect(coverageOf(reviewScope(diff), sections, packing, outcomes)).toEqual([
      {
        file: '',
        status: 'partial',
        left: [
          { start: 3, end: 3, reason: 'review-deadline' },
        ],
      },
      {
        file: 'a.js',
        status: 'partial',
        left: [
          { start: 5, end: 6, reason: 'review-deadline' },
        ],
      },
    ])
  })

  it('lists a file of one whole section and one split between hunks across parts once, partial, with the range and reason of each hunk left', () => {
    const h = headerOf('a.js')
    const small = hunkOf(1, 's')
    const [ua, ub, uc, uz] = [
      hunkOf(4, 'a', 10),
      hunkOf(4, 'b', 30),
      hunkOf(4, 'c', 50),
      hunkOf(40, 'z', 70),
    ]
    const diff = [h, small, h, ua, ub, uc, uz].join('\n')
    const sections = diffSections(diff)
    const budget = t(sections[0].text) + 1 + t(h) + 1 + t(ua)
    const packing = packParts(sections, { partTokens: budget, room: budget })
    // Part 1 holds the whole section and the first hunk of the split one, part 2 the next two; the last hunk is set aside.
    expect(packing.parts.map(part => part.slices)).toEqual([
      [
        { section: 0 },
        { section: 1, from: 0, to: 1 },
      ],
      [
        { section: 1, from: 1, to: 3 },
      ],
    ])
    expect(packing.tooLarge).toEqual([
      { section: 1, hunk: 3 },
    ])
    expect(problems(sections, packing)).toEqual([])
    const scope = reviewScope(diff)
    expect(scope.files).toEqual(['a.js'])
    expect(coverageOf(scope, sections, packing, ['reviewed', 'review-deadline'])).toEqual([
      {
        file: 'a.js',
        status: 'partial',
        left: [
          { start: 30, end: 33, reason: 'review-deadline' },
          { start: 50, end: 53, reason: 'review-deadline' },
          { start: 70, end: 109, reason: 'too-large' },
        ],
      },
    ])
  })

  it('gives a hunk that holds no line its start line alone, and a section with no hunk no range', () => {
    const diff = [
      headerOf('a.js'),
      '@@ -7,2 +7,2 @@',
      'diff --git a/a.js b/a.js',
      'GIT binary patch',
      'literal 1',
      'x',
    ].join('\n')
    const sections = diffSections(diff)
    const scope = {
      files: ['a.js'],
      leftOut: [],
    }
    const packing: Packing = {
      parts: [
        {
          slices: [
            { section: 0 },
          ],
          tokens: 0,
        },
        {
          slices: [
            { section: 1 },
          ],
          tokens: 0,
        },
      ],
      tooLarge: [],
      cuts: new Map(),
    }
    expect(coverageOf(scope, sections, packing, ['token-cap', 'reviewed'])).toEqual([
      {
        file: 'a.js',
        status: 'partial',
        left: [
          { start: 7, end: 7, reason: 'token-cap' },
        ],
      },
    ])
    expect(coverageOf(scope, sections, {
      ...packing,
      parts: packing.parts.slice(0, 1),
      tooLarge: [
        { section: 1 },
      ],
    }, ['reviewed'])).toEqual([
      { file: 'a.js', status: 'partial', left: [] },
    ])
  })

  describe('a part recovery split into pieces', () => {
    /** a.js holds four hunks of two rows each, b.js one: two parts, each file whole in its own. */
    const sections = sectionsOf(
      [
        'a.js',
        [
          hunkOf(2, 'a', 1),
          hunkOf(2, 'b', 11),
          hunkOf(2, 'c', 21),
          hunkOf(2, 'd', 31),
        ],
      ],
      [
        'b.js',
        [
          hunkOf(2, 'e', 1),
        ],
      ],
    )
    const whole: Packing = {
      parts: [
        {
          slices: [
            { section: 0 },
          ],
          tokens: 0,
        },
        {
          slices: [
            { section: 1 },
          ],
          tokens: 0,
        },
      ],
      tooLarge: [],
      cuts: new Map(),
    }
    /** What recovery makes of the packing when it cuts a.js between its hunks. */
    const cut: Packing = {
      ...whole,
      cuts: new Map([
        [
          0,
          cutSection(sections[0].text),
        ],
      ]),
    }
    const scope = reviewScope(sections.map(({ text }) => text).join('\n'))
    const pieces = (...outcomes: PartOutcome[]): PartResult => ({
      pieces: outcomes.map((outcome, index) => ({
        slices: [
          { section: 0, from: index, to: index + 1 },
        ],
        outcome,
      })),
    })

    it('covers a part split into pieces by each piece\'s outcome, a section recovery cut by hunk', () => {
      expect(coverageOf(scope, sections, cut, [
        pieces('reviewed', 'reviewed', 'token-cap', 'research-failed'),
        'reviewed',
      ])).toEqual([
        {
          file: 'a.js',
          status: 'partial',
          left: [
            { start: 21, end: 22, reason: 'token-cap' },
            { start: 31, end: 32, reason: 'research-failed' },
          ],
        },
        { file: 'b.js', status: 'reviewed' },
      ])
      // A part is read when every piece of it was, and not before: one piece not read leaves its file partial.
      expect(coverageOf(scope, sections, cut, [
        pieces('reviewed', 'reviewed', 'reviewed', 'reviewed'),
        'reviewed',
      ]).map(entry => entry.status)).toEqual(['reviewed', 'reviewed'])
      expect(coverageOf(scope, sections, cut, [
        pieces('provider-down', 'provider-down', 'provider-down', 'provider-down'),
        'reviewed',
      ])[0]).toEqual({ file: 'a.js', status: 'unreviewed', reason: 'provider-down' })
      // A piece that holds a slice of the other part's file leaves that part's outcome alone.
      expect(coverageOf(scope, sections, cut, [
        pieces('reviewed', 'reviewed', 'reviewed', 'reviewed'),
        'token-cap',
      ])[1]).toEqual({ file: 'b.js', status: 'unreviewed', reason: 'token-cap' })
    })

    it('lists the hunks of a piece at the floor as reply-cut-off ranges', () => {
      expect(coverageOf(scope, sections, cut, [
        pieces('reviewed', 'reply-cut-off', 'reviewed', 'reviewed'),
        'reply-cut-off',
      ])).toEqual([
        {
          file: 'a.js',
          status: 'partial',
          left: [
            { start: 11, end: 12, reason: 'reply-cut-off' },
          ],
        },
        { file: 'b.js', status: 'unreviewed', reason: 'reply-cut-off' },
      ])
      // A part held whole and cut off at the floor lists every hunk of its section.
      expect(coverageOf(scope, sections, whole, ['reply-cut-off', 'reviewed'])[0]).toEqual({ file: 'a.js', status: 'unreviewed', reason: 'reply-cut-off' })
      // A research of one request split into pieces has one part holding every section.
      const one: Packing = {
        parts: [
          {
            slices: [
              { section: 0 },
              { section: 1 },
            ],
            tokens: 0,
          },
        ],
        tooLarge: [],
        cuts: cut.cuts,
      }
      expect(coverageOf(scope, sections, one, [
        {
          pieces: [
            {
              slices: [
                { section: 0, from: 0, to: 4 },
              ],
              outcome: 'reviewed',
            },
            {
              slices: [
                { section: 1 },
              ],
              outcome: 'reply-cut-off',
            },
          ],
        },
      ])).toEqual([
        { file: 'a.js', status: 'reviewed' },
        { file: 'b.js', status: 'unreviewed', reason: 'reply-cut-off' },
      ])
    })
  })
})

describe('nearestHunks', () => {
  /** A hunk that adds one line at new line `start`, the line `pad` characters longer. */
  const addAt = (start: number, pad = 0): string => `@@ -${start},0 +${start},1 @@\n+l${start}${'y'.repeat(pad)}`
  const header = headerOf('a.js')
  /** The count of the header, a line feed after it included. */
  const head = t(header) + 1
  const sectionOf = (...hunks: string[]): { text: string, hunks: Hunk[] } => {
    const text = [header, ...hunks].join('\n')
    return {
      text,
      hunks: parseHunks(text),
    }
  }

  it('takes the cited hunk with the section\'s header, then the nearer neighbour in new-file lines, the earlier on a tie, in the section\'s order', () => {
    const hunks = [1, 10, 20, 30].map(start => addAt(start))
    const [first, second, third, fourth] = hunks
    const section = sectionOf(...hunks)
    const two = head + t(third) + 1 + t(second)
    expect(nearestHunks(section.text, section.hunks, 20, two)).toBe([header, second, third].join('\n'))
    expect(nearestHunks(section.text, section.hunks, 20, two + 1 + t(fourth))).toBe([header, second, third, fourth].join('\n'))
    expect(nearestHunks(section.text, section.hunks, 20, two - 1)).toBe([header, third].join('\n'))
    // The hunk at 1 is nearer to line 10 than the one at 20 is.
    expect(nearestHunks(section.text, section.hunks, 10, head + t(second) + 1 + t(first))).toBe([header, first, second].join('\n'))
    expect(nearestHunks(section.text, section.hunks, 10, two)).toBe([header, first, second].join('\n'))
  })

  it('closes a side at a hunk that does not fit, and goes on with the other', () => {
    const hunks = [
      addAt(1),
      addAt(10, 200),
      addAt(20),
      addAt(30),
    ]
    const section = sectionOf(...hunks)
    const two = head + t(hunks[2]) + 1 + t(hunks[3])
    expect(nearestHunks(section.text, section.hunks, 20, two)).toBe([header, hunks[2], hunks[3]].join('\n'))
    // The hunk at 1 would fit too, but it lies past the hunk at 10, which closed that side.
    expect(nearestHunks(section.text, section.hunks, 20, two + 1 + t(hunks[0]))).toBe([header, hunks[2], hunks[3]].join('\n'))
  })

  it('is undefined when no hunk holds the line, or when the cited hunk does not fit alone', () => {
    const hunks = [1, 10, 20, 30].map(start => addAt(start))
    const section = sectionOf(...hunks)
    expect(nearestHunks(section.text, section.hunks, 25, 100_000)).toBeUndefined()
    expect(nearestHunks(section.text, section.hunks, 20, head + t(hunks[2]))).toBe([header, hunks[2]].join('\n'))
    expect(nearestHunks(section.text, section.hunks, 20, head + t(hunks[2]) - 1)).toBeUndefined()
    expect(nearestHunks(section.text, section.hunks, 20, -1)).toBeUndefined()
  })

  it('measures a neighbour from the nearer end of the lines it holds, not from its start', () => {
    // The hunk before the cited line holds lines 10 to 17, so it is 3 lines away though it starts 10 lines away; the one after is 4 away.
    const [before, cited, after] = [
      hunkOf(8, 'c', 10),
      addAt(20),
      addAt(24),
    ]
    const section = sectionOf(before, cited, after)
    const withOne = head + t(cited) + 1 + t(before)
    expect(nearestHunks(section.text, section.hunks, 20, withOne)).toBe([header, before, cited].join('\n'))
    expect(nearestHunks(section.text, section.hunks, 20, withOne + 1 + t(after))).toBe([header, before, cited, after].join('\n'))
  })

  it('measures a deletion-only neighbour, and a hunk that holds no line, from its start line alone', () => {
    const deletion = '@@ -22,2 +22,0 @@\n-a\n-b'
    const [near, cited, far] = [
      addAt(17),
      addAt(20),
      deletion,
    ]
    const around = sectionOf(near, cited, far)
    // The deletion-only hunk after holds its start line, 2 lines away; the one-line hunk before is 3 away.
    expect(nearestHunks(around.text, around.hunks, 20, head + t(cited) + 1 + Math.max(t(near), t(far)))).toBe([header, cited, far].join('\n'))
    // A header that promises new lines the hunk never shows holds none: its start line, 2 away, still counts.
    const shown = '@@ -18,2 +18,2 @@\n-a\n-b'
    expect(heldSpan(parseHunks(shown)[0])).toBeUndefined()
    const [empty, center, last] = [
      shown,
      addAt(20),
      addAt(24),
    ]
    const none = sectionOf(empty, center, last)
    expect(nearestHunks(none.text, none.hunks, 20, head + t(center) + 1 + t(empty))).toBe([header, empty, center].join('\n'))
  })

  it('takes the hunk locate takes for a deletion-only hunk, and a section with no header lines', () => {
    const gone = '@@ -5,2 +5,0 @@\n-a\n-b'
    const section = sectionOf(addAt(1), gone, addAt(30))
    expect(nearestHunks(section.text, section.hunks, 5, head + t(gone))).toBe([header, gone].join('\n'))
    const plain = [
      addAt(1),
      addAt(10),
    ].join('\n')
    expect(nearestHunks(plain, parseHunks(plain), 10, t(addAt(10)))).toBe(addAt(10))
    expect(nearestHunks(plain, parseHunks(plain), 10, t(plain))).toBe(plain)
    expect(nearestHunks(plain, parseHunks(plain), 10, t(addAt(10)) - 1)).toBeUndefined()
  })
})
