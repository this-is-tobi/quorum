import { describe, expect, it } from 'vitest'
import { decodeDiff, diffSections, locate, parseHunks, splitDiff } from '../core/diff.ts'
import { packParts } from '../core/parts.ts'
import { utf8Length } from '../core/tokens.ts'
import { addedDiff, addedSection, BINARY_PROBE_BYTES, HUNK_BYTES, isBinary, pathName, quotedPath } from './added.ts'
import type { AddedFile, AddedMode } from './added.ts'

const enc = new TextEncoder()

function file(path: string | Uint8Array, content: string | Uint8Array, mode: AddedMode = '100644'): AddedFile {
  return {
    path: typeof path === 'string'
      ? enc.encode(path)
      : path,
    mode,
    content: typeof content === 'string'
      ? enc.encode(content)
      : content,
  }
}

/** The bytes of `hex`, written as pairs of hexadecimal digits apart by a space. */
const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.split(' ').map(pair => Number.parseInt(pair, 16)))

const hunkHeaders = (section: string): string[] => section.split('\n').filter(line => line.startsWith('@@'))

/** A line of 33 characters, so with its line feed 34 bytes. */
const wide = (index: number): string => `${String(index).padStart(5, '0')} ${'z'.repeat(27)}`

const SECTIONS = [
  'diff --git a/a.txt b/a.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/a.txt',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
]

describe('the all-added writer', () => {
  it('writes git\'s new-file form: the header, the mode, /dev/null, the new path and one hunk', () => {
    expect(addedSection(file('a.txt', 'one\ntwo\n'))).toBe(SECTIONS.join('\n'))

    const second = file('b.txt', 'x\n', '100755')
    expect(addedDiff([
      file('a.txt', 'one\ntwo\n'),
      second,
    ])).toBe(`${SECTIONS.join('\n')}\n${addedSection(second)}\n`)
    expect(addedSection(second)).toBe('diff --git a/b.txt b/b.txt\nnew file mode 100755\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+x')
    expect(addedDiff([])).toBe('')
  })

  it('writes a one-line hunk with no count, as git does', () => {
    expect(addedSection(file('a.txt', 'one\n'))).toContain('\n@@ -0,0 +1 @@\n+one')
    expect(addedSection(file('a.txt', 'one\ntwo\n'))).toContain('\n@@ -0,0 +1,2 @@\n')
  })

  it('marks a last line that has no line feed', () => {
    expect(addedSection(file('a.txt', 'x'))).toMatch(/\n\+x\n\\ No newline at end of file$/)
    expect(addedSection(file('a.txt', 'x\ny'))).toMatch(/\n\+x\n\+y\n\\ No newline at end of file$/)
    expect(addedSection(file('a.txt', 'x\n'))).not.toContain('No newline')

    // Once, after the last row of the last hunk, whatever the cut.
    const cut = addedSection(file('a.txt', `${'b'.repeat(5000)}\nshort`))
    expect(hunkHeaders(cut)).toHaveLength(2)
    expect(cut.match(/No newline/g)).toHaveLength(1)
    expect(cut.endsWith('\n+short\n\\ No newline at end of file')).toBe(true)
  })

  it('writes an empty file as its header and its mode alone', () => {
    expect(addedSection(file('e', ''))).toBe('diff --git a/e b/e\nnew file mode 100644')
    expect(addedSection(file('e', '', '100755'))).toBe('diff --git a/e b/e\nnew file mode 100755')
  })

  it('writes a NUL in the first 8000 bytes as git\'s binary line, and one past them as text', () => {
    expect(BINARY_PROBE_BYTES).toBe(8000)
    const text = new Uint8Array(8010).fill(0x61)

    const early = Uint8Array.from(text)
    early[BINARY_PROBE_BYTES - 1] = 0
    expect(isBinary(early)).toBe(true)
    expect(addedSection(file('n.bin', early))).toBe('diff --git a/n.bin b/n.bin\nnew file mode 100644\nBinary files /dev/null and b/n.bin differ')

    const late = Uint8Array.from(text)
    late[BINARY_PROBE_BYTES] = 0
    expect(isBinary(late)).toBe(false)
    const section = addedSection(file('n.bin', late))
    expect(section).not.toContain('Binary files')
    expect(section).toContain('\n@@ -0,0 +1 @@\n+aaaa')

    expect(isBinary(new Uint8Array())).toBe(false)
    expect(isBinary(enc.encode('plain\n'))).toBe(false)
    expect(addedSection(file(bytesOf('6e c3 a9 2e 62 69 6e'), Uint8Array.of(0)))).toBe('diff --git "a/n\\303\\251.bin" "b/n\\303\\251.bin"\nnew file mode 100644\nBinary files /dev/null and "b/n\\303\\251.bin" differ')
  })

  it('writes a link as mode 120000 and its target, and a gitlink as its header and mode alone', () => {
    expect(addedSection(file('l', 'target/path', '120000'))).toBe('diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+target/path\n\\ No newline at end of file')
    expect(addedSection(file('sub', '', '160000'))).toBe('diff --git a/sub b/sub\nnew file mode 160000')
  })

  it('keeps a carriage return, a byte-order mark and bytes that are not UTF-8, as decodeDiff reads git\'s output', async () => {
    const mark = String.fromCharCode(0xFEFF)
    const replacement = String.fromCharCode(0xFFFD)
    const cases: Array<[bytes: Uint8Array, row: string]> = [
      [
        enc.encode('a\r\n'),
        '+a\r',
      ],
      [
        Uint8Array.of(0xEF, 0xBB, 0xBF, 0x61, 0x0A),
        `+${mark}a`,
      ],
      [
        Uint8Array.of(0xC3, 0x0A),
        `+${replacement}`,
      ],
    ]
    for (const [content, row] of cases) {
      const section = addedSection(file('f', content))
      expect(section.endsWith(`\n@@ -0,0 +1 @@\n${row}`)).toBe(true)

      // What git prints for the same blob, read as quorum reads a diff: the same text.
      const git = Buffer.concat([
        enc.encode('diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+'),
        content,
      ])
      expect(await decodeDiff([git])).toBe(`${section}\n`)
    }
  })

  it('cuts a file into hunks of at most 4096 bytes at line ends, a longer line alone in its hunk', () => {
    expect(HUNK_BYTES).toBe(4096)
    const lines = Array.from({ length: 900 }, (_, index) => `line ${index} of a file cut into hunks`)
    const section = addedSection(file('f.txt', `${lines.join('\n')}\n`))

    expect(hunkHeaders(section)).toEqual([
      '@@ -0,0 +1,123 @@',
      '@@ -0,0 +124,120 @@',
      '@@ -0,0 +244,120 @@',
      '@@ -0,0 +364,120 @@',
      '@@ -0,0 +484,120 @@',
      '@@ -0,0 +604,120 @@',
      '@@ -0,0 +724,120 @@',
      '@@ -0,0 +844,57 @@',
    ])
    const hunks = parseHunks(section)
    expect(hunks.flatMap(hunk => hunk.rows)).toEqual(lines.map(line => `+${line}`))
    for (const hunk of hunks) {
      // A row's `+` stands for the line feed, so the rows' lengths are the lines' bytes, line feeds included.
      expect(hunk.rows.reduce((sum, row) => sum + utf8Length(row), 0)).toBeLessThanOrEqual(HUNK_BYTES)
    }

    const long = addedSection(file('f.txt', `${'b'.repeat(5000)}\nshort\n`))
    expect(hunkHeaders(long)).toEqual(['@@ -0,0 +1 @@', '@@ -0,0 +2 @@'])
    expect(long.endsWith('\n@@ -0,0 +2 @@\n+short')).toBe(true)
  })

  it('quotes each byte as git does under core.quotePath, and reads every byte class back to the same name', () => {
    const names: Uint8Array[] = []
    for (let byte = 1; byte <= 255; byte++) {
      if (byte !== 0x2F) names.push(Uint8Array.of(0x6E, byte, 0x78))
    }
    names.push(...[
      'c3 a9',
      'e2 82 ac',
      'f0 9f 98 80',
      '61 01 c3 a9',
      '01 ff',
      'c3 28',
      'e2 82',
      'c0 af',
      'ed a0 80',
      'ef bb bf 62',
      '61 20 62',
      '61 22 5c 62',
      '74 09 6e 0a 72 0d',
      '65 6e 64 20',
      '80 41 80',
    ].map(bytesOf))
    for (const raw of names) {
      const sections = diffSections(addedDiff([
        file(raw, 'x\n'),
      ]))
      expect(sections, `bytes ${[...raw].join(' ')}`).toHaveLength(1)
      expect(sections[0].path, `bytes ${[...raw].join(' ')}`).toBe(pathName(raw))
    }

    // git's table: a letter for eight bytes and the quote and backslash, three octal digits for the rest outside printable ASCII.
    const escapes: Array<[byte: number, escape: string | undefined]> = [
      [0x07, '\\a'],
      [0x08, '\\b'],
      [0x09, '\\t'],
      [0x0A, '\\n'],
      [0x0B, '\\v'],
      [0x0C, '\\f'],
      [0x0D, '\\r'],
      [0x22, '\\"'],
      [0x5C, '\\\\'],
      [0x01, '\\001'],
      [0x1F, '\\037'],
      [0x7F, '\\177'],
      [0x80, '\\200'],
      [0xFF, '\\377'],
      [0x20, undefined],
      [0x27, undefined],
      [0x7E, undefined],
    ]
    for (const [byte, escape] of escapes) {
      expect(quotedPath(Uint8Array.of(0x61, byte, 0x62))).toBe(escape === undefined
        ? undefined
        : `a${escape}b`)
    }
    expect(quotedPath(enc.encode('a.txt'))).toBeUndefined()
    expect(pathName(enc.encode('a b.txt'))).toBe('a b.txt')
    expect(quotedPath(enc.encode(`donn${String.fromCharCode(0xE9)}e`))).toBe('donn\\303\\251e')
  })

  it('ends a +++ line with a tab when its label holds a space, as git does', () => {
    expect(addedSection(file('a b.txt', 'x\n'))).toBe('diff --git a/a b.txt b/a b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a b.txt\t\n@@ -0,0 +1 @@\n+x')
    expect(addedSection(file(bytesOf('61 20 c3 a9'), 'x\n'))).toContain('\n+++ "b/a \\303\\251"\t\n')
    expect(addedSection(file('a.txt', 'x\n'))).toContain('\n+++ b/a.txt\n')
    expect(addedSection(file('a b.bin', Uint8Array.of(0)))).toBe('diff --git a/a b.bin b/a b.bin\nnew file mode 100644\nBinary files /dev/null and b/a b.bin differ')
  })

  it('lets locate find every line of every file it writes, and no line past the end', () => {
    const contents: Array<[name: string | Uint8Array, text: string]> = [
      ['one.txt', 'a\nb\nc\n'],
      ['lines.txt', `${Array.from({ length: 900 }, (_, index) => `line ${index} of a file cut into hunks`).join('\n')}\n`],
      ['crlf.txt', 'a\r\nb\r\n'],
      ['unfinished.txt', 'x\ny'],
      ['blank.txt', '\n'],
      [
        bytesOf('6e c3 a9 2e 74 78 74'),
        'quoted\nname\n',
      ],
      ['empty', ''],
    ]
    const sections = splitDiff(addedDiff(contents.map(([name, text]) => file(name, text))))

    for (const [name, text] of contents) {
      const rows = text === ''
        ? []
        : text.replace(/\n$/, '').split('\n')
      const path = typeof name === 'string'
        ? name
        : pathName(name)
      for (const [index, row] of rows.entries()) {
        const found = locate(sections, path, index + 1)
        expect(found?.path, `${path}:${index + 1}`).toBe(path)
        expect(found?.evidence, `${path}:${index + 1}`).toContain(`+${row.replace(/\r$/, '')}`)
      }
      expect(locate(sections, path, rows.length + 1), `${path} past its end`).toBeUndefined()
      expect(locate(sections, path, 0), `${path} before its start`).toBeUndefined()
    }
  })

  it('lets the packer spread a file larger than a part across parts, setting no hunk aside', () => {
    const text = `${Array.from({ length: 6000 }, (_, index) => wide(index)).join('\n')}\n`
    expect(utf8Length(text)).toBe(6000 * 34)
    const sections = diffSections(addedDiff([
      file('big.txt', text),
    ]))

    const packing = packParts(sections, { partTokens: 32_768, room: 14_759 })
    expect(packing.parts.length).toBeGreaterThan(1)
    expect(packing.tooLarge).toEqual([])
    const hunks = packing.cuts.get(0)?.hunks.length ?? 0
    expect(hunks).toBeGreaterThan(1)
    const seen = Array.from<number>({ length: hunks }).fill(0)
    for (const part of packing.parts) {
      for (const slice of part.slices) {
        expect(slice.section).toBe(0)
        for (let hunk = slice.from ?? 0; hunk < (slice.to ?? 0); hunk++) seen[hunk]++
      }
    }
    expect(seen.every(count => count === 1)).toBe(true)
  })
})
