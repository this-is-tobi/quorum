import { describe, expect, it } from 'vitest'
import { diffSectionFor, locate, sectionFor, splitDiff } from './diff.ts'

const gitDiff = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1 +1 @@',
  '-safe()',
  '+exec(cmd)',
  'diff --git a/lib/b.js b/lib/b.js',
  '--- a/lib/b.js',
  '+++ b/lib/b.js',
  '@@ -1 +1 @@',
  '+query(sql)',
].join('\n')

describe('splitDiff', () => {
  it('splits a git diff into one section per file', () => {
    const sections = splitDiff(gitDiff)
    expect([...sections.keys()]).toEqual(['src/a.js', 'lib/b.js'])
    expect(sections.get('src/a.js')).toContain('+exec(cmd)')
    expect(sections.get('src/a.js')).not.toContain('query(sql)')
  })

  it('keys paths containing spaces and git-quoted paths', () => {
    const diff = 'diff --git a/my file.js b/my file.js\n+x\ndiff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\n+y'
    expect([...splitDiff(diff).keys()]).toEqual(['my file.js', 'caf\\303\\251.js'])
  })

  it('keeps every hunk when a path appears more than once', () => {
    const series = [
      'diff --git a/src/a.js b/src/a.js',
      '@@ -1 +1 @@',
      '+exec(cmd)',
      'diff --git a/src/a.js b/src/a.js',
      '@@ -1 +1 @@',
      '+harmless()',
    ].join('\n')
    const sections = splitDiff(series)
    expect([...sections.keys()]).toEqual(['src/a.js'])
    expect(sections.get('src/a.js')).toBe(series)
    expect(diffSectionFor(sections, 'src/a.js', series)).toContain('+exec(cmd)')
  })

  it('splits a CRLF diff the same way', () => {
    const crlf = 'diff --git a/src/a.js b/src/a.js\r\n+x\r\ndiff --git a/lib/b.js b/lib/b.js\r\n+y'
    expect([...splitDiff(crlf).keys()]).toEqual(['src/a.js', 'lib/b.js'])
  })

  it('keys a renamed file by its new path', () => {
    expect([...splitDiff('diff --git a/old name.js b/new name.js\nsimilarity index 90%').keys()]).toEqual(['new name.js'])
  })

  it('reads a header with many " b/" segments in linear time', () => {
    const header = `diff --git a/x${' b/x'.repeat(20_000)}\r`
    const started = performance.now()
    const sections = splitDiff(header)
    expect(performance.now() - started).toBeLessThan(300)
    expect(sections.size).toBe(1)
  })

  it('keys a --no-prefix diff by the path on both sides', () => {
    const noPrefix = [
      'diff --git src/a.js src/a.js',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old a',
      '+new a',
      'diff --git lib/b.js lib/b.js',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old b',
      '+new b',
    ].join('\n')
    const sections = splitDiff(noPrefix)
    expect([...sections.keys()]).toEqual(['src/a.js', 'lib/b.js'])
    expect(locate(sections, 'lib/b.js', 2)).toEqual({ path: 'lib/b.js', evidence: ' keep\n-old b\n+new b' })
    expect(locate(sections, 'not/in/diff.js', 2)).toBeUndefined()
    expect(locate(sections, 'src/z.js', 2)).toBeUndefined()
  })

  it('keys mnemonic-prefix headers by the path', () => {
    const mnemonic = ['diff --git i/src/a.js w/src/a.js', '+x', 'diff --git c/lib/b.js o/lib/b.js', '+y'].join('\n')
    expect([...splitDiff(mnemonic).keys()]).toEqual(['src/a.js', 'lib/b.js'])
  })

  it('keys a quoted path without its quotes, whatever its prefixes', () => {
    const quoted = ['diff --git "caf\\303\\251.js" "caf\\303\\251.js"', '+x', 'diff --git "i/lib/\\303\\251.js" "w/lib/\\303\\251.js"', '+y'].join('\n')
    expect([...splitDiff(quoted).keys()]).toEqual(['caf\\303\\251.js', 'lib/\\303\\251.js'])
  })

  it('keys a rename to a quoted name by its new path', () => {
    expect([...splitDiff('diff --git a/old.js "b/caf\\303\\251.js"\n+x').keys()]).toEqual(['caf\\303\\251.js'])
  })

  it('keeps a file whose name contains " b/" apart from the file it imitates', () => {
    const decoy = [
      'diff --git a/foo b/src/auth.js b/foo b/src/auth.js',
      '@@ -40 +40 @@',
      '-harmless()',
      '+benign()',
      'diff --git a/src/auth.js b/src/auth.js',
      '@@ -40 +40 @@',
      '-check(user)',
      '+skipCheck(user)',
    ].join('\n')
    const sections = splitDiff(decoy)
    expect([...sections.keys()]).toEqual(['foo b/src/auth.js', 'src/auth.js'])
    expect(locate(sections, 'src/auth.js', 40)).toEqual({ path: 'src/auth.js', evidence: '-check(user)\n+skipCheck(user)' })
    expect(sectionFor(sections, 'auth.js')).toBeUndefined()
  })

  it('leaves a section whose header names no readable path out of the map', () => {
    const unreadable = [
      'diff --git a/src/a.js b/src/a.js',
      '+x',
      'diff --git old/x new/x',
      '+p',
      'diff --git a/ b/',
      '+q',
      'diff --git a/z_b/z',
      '+r',
      'diff --git a/lib/b.js b/lib/b.js',
      '+y',
    ].join('\n')
    const sections = splitDiff(unreadable)
    expect([...sections.keys()]).toEqual(['src/a.js', 'lib/b.js'])
    expect(sections.get('src/a.js')).toBe('diff --git a/src/a.js b/src/a.js\n+x')
  })

  it('returns a plain unified diff as a single unkeyed section', () => {
    const plain = '--- a.js\n+++ a.js\n@@ -1 +1 @@\n+x'
    expect([...splitDiff(plain).entries()]).toEqual([['', plain]])
  })
})

describe('diffSectionFor', () => {
  const sections = splitDiff(gitDiff)

  it('matches the exact path, with or without a b/ prefix', () => {
    expect(diffSectionFor(sections, 'src/a.js', gitDiff)).toContain('+exec(cmd)')
    expect(diffSectionFor(sections, 'b/src/a.js', gitDiff)).toContain('+exec(cmd)')
  })

  it('matches a unique path suffix', () => {
    expect(diffSectionFor(sections, 'b.js', gitDiff)).toContain('+query(sql)')
  })

  it('falls back to the whole diff when nothing, or more than one section, matches', () => {
    expect(diffSectionFor(sections, 'missing.js', gitDiff)).toBe(gitDiff)
    const twoIndexes = splitDiff('diff --git a/x/index.js b/x/index.js\n+1\ndiff --git a/y/index.js b/y/index.js\n+2')
    expect(diffSectionFor(twoIndexes, 'index.js', 'whole')).toBe('whole')
  })
})

describe('sectionFor', () => {
  const sections = splitDiff(gitDiff)

  it('returns the diff\'s own path for an exact or prefixed path', () => {
    expect(sectionFor(sections, 'src/a.js')?.path).toBe('src/a.js')
    expect(sectionFor(sections, 'b/src/a.js')?.path).toBe('src/a.js')
  })

  it('resolves a unique path suffix to the diff\'s own path', () => {
    expect(sectionFor(sections, 'b.js')?.path).toBe('lib/b.js')
  })

  it('returns undefined when the file is not in the diff or the suffix is ambiguous', () => {
    expect(sectionFor(sections, 'missing.js')).toBeUndefined()
    const twoIndexes = splitDiff('diff --git a/x/index.js b/x/index.js\n+1\ndiff --git a/y/index.js b/y/index.js\n+2')
    expect(sectionFor(twoIndexes, 'index.js')).toBeUndefined()
  })

  it('lets a diff without per-file headers stand for any file', () => {
    const plain = splitDiff('--- a.js\n+++ a.js\n@@ -1 +1 @@\n+x')
    expect(sectionFor(plain, 'anything.js')?.path).toBe('')
  })

  it('returns undefined, and the whole diff stays the fallback, when no header names a readable path', () => {
    const custom = ['diff --git old/x new/x', '@@ -1 +1 @@', '-p', '+q'].join('\n')
    const unreadable = splitDiff(custom)
    expect(unreadable.size).toBe(0)
    expect(sectionFor(unreadable, 'x')).toBeUndefined()
    expect(locate(unreadable, 'x', 1)).toBeUndefined()
    expect(diffSectionFor(unreadable, 'x', custom)).toBe(custom)
  })

  it('does not let a preamble stand for a file when every header is unreadable', () => {
    const series = ['Subject: [PATCH] tweak', '', 'diff --git old/x new/x', '@@ -1 +1 @@', '-p', '+q'].join('\n')
    const unreadable = splitDiff(series)
    expect(unreadable.size).toBe(0)
    expect(sectionFor(unreadable, 'x')).toBeUndefined()
    expect(diffSectionFor(unreadable, 'x', series)).toBe(series)
  })

  it('does not let a preamble stand for a file that is not in the diff', () => {
    const series = ['Subject: [PATCH] tweak', '', gitDiff].join('\n')
    const withPreamble = splitDiff(series)
    expect([...withPreamble.keys()]).toEqual(['', 'src/a.js', 'lib/b.js'])
    expect(sectionFor(withPreamble, 'missing.js')).toBeUndefined()
    expect(diffSectionFor(withPreamble, 'missing.js', series)).toBe(series)
  })

  it('does not match an empty or directory name to the preamble', () => {
    const withPreamble = splitDiff(['Subject: [PATCH] tweak', '', gitDiff].join('\n'))
    expect(sectionFor(withPreamble, '')).toBeUndefined()
    expect(sectionFor(withPreamble, 'a/')).toBeUndefined()
    expect(sectionFor(withPreamble, 'src/')).toBeUndefined()
  })
})

describe('locate', () => {
  const hunks = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -10,4 +10,5 @@ function run() {',
    ' const a = 1',
    '-const b = read()',
    '+const b = readUnsafe(input)',
    '+log(b)',
    ' exec(b)',
    ' done()',
    '@@ -40 +41 @@',
    '-old()',
    '\\ No newline at end of file',
    '+fresh()',
    'diff --git a/lib/b.js b/lib/b.js',
    '--- a/lib/b.js',
    '+++ b/lib/b.js',
    '@@ -5,2 +4,0 @@',
    '-gone()',
    '-alsoGone()',
  ].join('\n')
  const sections = splitDiff(hunks)

  it('reads the evidence from the hunk that holds the line, two lines either side', () => {
    expect(locate(sections, 'src/a.js', 11)).toEqual({
      path: 'src/a.js',
      evidence: [' const a = 1', '-const b = read()', '+const b = readUnsafe(input)', '+log(b)', ' exec(b)'].join('\n'),
    })
  })

  it('finds the line in a later hunk and skips the no-newline marker', () => {
    expect(locate(sections, 'src/a.js', 41)).toEqual({ path: 'src/a.js', evidence: '-old()\n+fresh()' })
  })

  it('accepts a context line', () => {
    expect(locate(sections, 'src/a.js', 13)?.evidence).toContain(' exec(b)')
  })

  it('resolves a shortened path and reads a deletion-only hunk at the surviving line', () => {
    expect(locate(sections, 'b.js', 4)).toEqual({ path: 'lib/b.js', evidence: '-gone()\n-alsoGone()' })
  })

  it('returns undefined for a line outside every hunk', () => {
    for (const line of [0, 9, 15, 40, 99]) {
      expect(locate(sections, 'src/a.js', line)).toBeUndefined()
    }
  })

  it('returns undefined for a line that is not an integer', () => {
    expect(locate(sections, 'b.js', Number.NaN)).toBeUndefined()
    expect(locate(sections, 'b.js', 4.5)).toBeUndefined()
    expect(locate(sections, 'b.js', Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('holds only the surviving line of a deletion-only hunk', () => {
    expect(locate(sections, 'b.js', 3)).toBeUndefined()
    expect(locate(sections, 'b.js', 5)).toBeUndefined()
  })

  it('reads the first three rows of a longer deletion-only hunk', () => {
    const removed = ['diff --git a/a.js b/a.js', '@@ -5,4 +4,0 @@', '-one()', '-two()', '-three()', '-four()'].join('\n')
    expect(locate(splitDiff(removed), 'a.js', 4)).toEqual({ path: 'a.js', evidence: '-one()\n-two()\n-three()' })
  })

  it('returns undefined for a deletion-only hunk cut off before its first row', () => {
    const cutOff = ['diff --git a/a.js b/a.js', '@@ -5,2 +4,0 @@'].join('\n')
    expect(locate(splitDiff(cutOff), 'a.js', 4)).toBeUndefined()
  })

  it('reads an empty line inside a hunk as a blank context row', () => {
    const blank = ['diff --git a/a.js b/a.js', '@@ -1,3 +1,3 @@', ' first()', '', ' third()'].join('\n')
    expect(locate(splitDiff(blank), 'a.js', 3)?.evidence).toBe(' first()\n\n third()')
  })

  it('ignores the empty element after the final newline but not an empty line before it', () => {
    const cutOff = ['diff --git a/a.js b/a.js', '@@ -1,9 +1,9 @@', ' keep()', ' keep2()'].join('\n')
    expect(locate(splitDiff(`${cutOff}\n`), 'a.js', 2)?.evidence).toBe(' keep()\n keep2()')
    expect(locate(splitDiff(`${cutOff}\n`), 'a.js', 3)).toBeUndefined()
    expect(locate(splitDiff(`${cutOff}\n\n`), 'a.js', 3)?.evidence).toBe(' keep()\n keep2()\n')
  })

  it('returns undefined for a file that is not in the diff', () => {
    expect(locate(sections, 'nope.js', 1)).toBeUndefined()
  })

  it('removes carriage returns from a CRLF diff', () => {
    const crlf = ['diff --git a/a.js b/a.js', '@@ -1 +1 @@', '-x', '+y'].join('\r\n')
    expect(locate(splitDiff(crlf), 'a.js', 1)).toEqual({ path: 'a.js', evidence: '-x\n+y' })
  })

  it('reads a plain unified diff through its single unkeyed section', () => {
    const plain = '--- a.js\n+++ a.js\n@@ -1 +1 @@\n-x\n+y'
    expect(locate(splitDiff(plain), 'a.js', 1)).toEqual({ path: '', evidence: '-x\n+y' })
  })

  it('returns undefined for a line a cut-off hunk promised but never shows', () => {
    const cutOff = ['diff --git a/a.js b/a.js', '@@ -1,9 +1,9 @@', ' keep()', ' keep2()'].join('\n')
    expect(locate(splitDiff(cutOff), 'a.js', 2)?.evidence).toBe(' keep()\n keep2()')
    expect(locate(splitDiff(cutOff), 'a.js', 8)).toBeUndefined()
  })

  it('does not read the next header block as hunk lines after a cut-off hunk', () => {
    const series = ['diff --git a/a.js b/a.js', '@@ -1,9 +1,9 @@', ' keep()', 'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -20 +20 @@', '-old()', '+new()'].join('\n')
    const sections = splitDiff(series)
    expect(locate(sections, 'a.js', 2)).toBeUndefined()
    expect(locate(sections, 'a.js', 20)).toEqual({ path: 'a.js', evidence: '-old()\n+new()' })
  })

  it('does not absorb the next file header into a cut-off hunk', () => {
    const truncated = ['diff --git a/a.js b/a.js', '@@ -1,9 +1,9 @@', ' keep()', 'diff --git a/b.js b/b.js', '+++ b/b.js'].join('\n')
    expect(locate(splitDiff(truncated), 'a.js', 1)).toEqual({ path: 'a.js', evidence: ' keep()' })
  })
})
