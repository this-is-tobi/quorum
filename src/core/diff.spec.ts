import { describe, expect, it } from 'vitest'
import { decodeDiff, diffSectionFor, firstLineOutside, locate, sectionFor, splitDiff } from './diff.ts'

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
    expect([
      ...sections.keys(),
    ]).toEqual(['src/a.js', 'lib/b.js'])
    expect(sections.get('src/a.js')).toContain('+exec(cmd)')
    expect(sections.get('src/a.js')).not.toContain('query(sql)')
  })

  it('keys paths containing spaces and git-quoted paths', () => {
    const diff = 'diff --git a/my file.js b/my file.js\n+x\ndiff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\n+y'
    expect([
      ...splitDiff(diff).keys(),
    ]).toEqual(['my file.js', 'caf\u00E9.js'])
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
    expect([
      ...sections.keys(),
    ]).toEqual(['src/a.js'])
    expect(sections.get('src/a.js')).toBe(series)
    expect(diffSectionFor(sections, 'src/a.js', series)).toContain('+exec(cmd)')
  })

  it('splits a CRLF diff the same way', () => {
    const crlf = 'diff --git a/src/a.js b/src/a.js\r\n+x\r\ndiff --git a/lib/b.js b/lib/b.js\r\n+y'
    expect([
      ...splitDiff(crlf).keys(),
    ]).toEqual(['src/a.js', 'lib/b.js'])
  })

  it('keys a renamed file by its new path', () => {
    expect([
      ...splitDiff('diff --git a/old name.js b/new name.js\nsimilarity index 90%').keys(),
    ]).toEqual(['new name.js'])
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
    expect([
      ...sections.keys(),
    ]).toEqual(['src/a.js', 'lib/b.js'])
    expect(locate(sections, 'lib/b.js', 2)).toEqual({ path: 'lib/b.js', evidence: ' keep\n-old b\n+new b' })
    expect(locate(sections, 'not/in/diff.js', 2)).toBeUndefined()
    expect(locate(sections, 'src/z.js', 2)).toBeUndefined()
  })

  it('keys mnemonic-prefix headers by the path', () => {
    const mnemonic = [
      'diff --git i/src/a.js w/src/a.js',
      '+x',
      'diff --git c/lib/b.js o/lib/b.js',
      '+y',
    ].join('\n')
    expect([
      ...splitDiff(mnemonic).keys(),
    ]).toEqual(['src/a.js', 'lib/b.js'])
  })

  it('keys a quoted path without its quotes, whatever its prefixes', () => {
    const quoted = [
      'diff --git "caf\\303\\251.js" "caf\\303\\251.js"',
      '+x',
      'diff --git "i/lib/\\303\\251.js" "w/lib/\\303\\251.js"',
      '+y',
    ].join('\n')
    expect([
      ...splitDiff(quoted).keys(),
    ]).toEqual(['caf\u00E9.js', 'lib/\u00E9.js'])
  })

  it('keys a rename to a quoted name by its new path', () => {
    expect([
      ...splitDiff('diff --git a/old.js "b/caf\\303\\251.js"\n+x').keys(),
    ]).toEqual(['caf\u00E9.js'])
  })

  it('keys a rename between two quoted names by the decoded new name', () => {
    const rename = 'diff --git "a/donn\\303\\251es.js" "b/donn\\303\\251es2.js"\nsimilarity index 71%'
    expect([
      ...splitDiff(rename).keys(),
    ]).toEqual(['données2.js'])
  })

  it('decodes the octal escapes git writes for a non-ASCII name', () => {
    const accented = [
      'diff --git "a/donn\\303\\251es.js" "b/donn\\303\\251es.js"',
      '@@ -1 +1 @@',
      '-old()',
      '+new()',
    ].join('\n')
    const sections = splitDiff(accented)
    expect([
      ...sections.keys(),
    ]).toEqual(['donn\u00E9es.js'])
    expect(locate(sections, 'donn\u00E9es.js', 1)).toEqual({ path: 'donn\u00E9es.js', evidence: '-old()\n+new()' })
  })

  it('decodes the escapes for a quote, a backslash and the control characters', () => {
    const quoted = [
      'diff --git "a/we\\"ird\\\\name.js" "b/we\\"ird\\\\name.js"',
      '+x',
      'diff --git "a/tab\\there.js" "b/tab\\there.js"',
      '+y',
      'diff --git a/old.js "b/line\\nbreak\\a\\b\\f\\r\\v.js"',
      '+z',
    ].join('\n')
    expect([
      ...splitDiff(quoted).keys(),
    ]).toEqual(['we"ird\\name.js', 'tab\there.js', 'line\nbreak\u0007\b\f\r\v.js'])
  })

  it('reads an invalid escape or UTF-8 sequence without throwing', () => {
    const invalid = [
      'diff --git "a/bad\\377\\303.js" "b/bad\\377\\303.js"',
      '+x',
      'diff --git "a/odd\\777\\q.js" "b/odd\\777\\q.js"',
      '+y',
      'diff --git "a/end\\" "b/end\\"',
      '+z',
    ].join('\n')
    expect([
      ...splitDiff(invalid).keys(),
    ]).toEqual(['bad\uDCFF\uDCC3.js', 'odd\\777\\q.js', 'end\\'])
  })

  it('keeps a byte-order mark in a decoded name, so it cannot pose as the file without it', () => {
    const decoy = [
      'diff --git a/src/auth.js b/src/auth.js',
      '+real',
      'diff --git "a/\\357\\273\\277src/auth.js" "b/\\357\\273\\277src/auth.js"',
      '+decoy',
    ].join('\n')
    const sections = splitDiff(decoy)
    expect([
      ...sections.keys(),
    ]).toEqual(['src/auth.js', '\uFEFFsrc/auth.js'])
    expect(sections.get('src/auth.js')).not.toContain('+decoy')
  })

  it('decodes only a quoted name', () => {
    const unquoted = [
      'diff --git a/x\\303.js b/x\\303.js',
      '+x',
      'diff --git a/old.js b/y\\303.js',
      '+y',
    ].join('\n')
    expect([
      ...splitDiff(unquoted).keys(),
    ]).toEqual(['x\\303.js', 'y\\303.js'])
  })

  it('decodes a long quoted name in linear time', () => {
    const name = '\\303\\251'.repeat(20_000)
    const started = performance.now()
    const sections = splitDiff(`diff --git "a/${name}" "b/${name}"\n+x`)
    expect(performance.now() - started).toBeLessThan(300)
    expect([
      ...sections.keys(),
    ].map(key => key === '\u00E9'.repeat(20_000))).toEqual([true])
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
    expect([
      ...sections.keys(),
    ]).toEqual(['foo b/src/auth.js', 'src/auth.js'])
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
    expect([
      ...sections.keys(),
    ]).toEqual(['src/a.js', 'lib/b.js'])
    expect(sections.get('src/a.js')).toBe('diff --git a/src/a.js b/src/a.js\n+x')
  })

  it('returns a plain unified diff as a single unkeyed section', () => {
    const plain = '--- a.js\n+++ a.js\n@@ -1 +1 @@\n+x'
    expect([
      ...splitDiff(plain).entries(),
    ]).toEqual([
      ['', plain],
    ])
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

  it('looks a path up as written before it strips an a/ or b/ prefix', () => {
    const lookalike = [
      'diff --git a/b/src/auth.js b/b/src/auth.js',
      '@@ -40 +40 @@',
      '-check(user)',
      '+skipCheck(user)',
      'diff --git a/src/auth.js b/src/auth.js',
      '@@ -40 +40 @@',
      '-check(user)',
      '+stillChecks(user)',
    ].join('\n')
    const both = splitDiff(lookalike)
    expect([
      ...both.keys(),
    ]).toEqual(['b/src/auth.js', 'src/auth.js'])
    expect(sectionFor(both, 'b/src/auth.js')?.path).toBe('b/src/auth.js')
    expect(sectionFor(both, 'src/auth.js')?.path).toBe('src/auth.js')
    expect(locate(both, ' b/src/auth.js ', 40)).toEqual({ path: 'b/src/auth.js', evidence: '-check(user)\n+skipCheck(user)' })
    expect(locate(both, 'src/auth.js', 40)).toEqual({ path: 'src/auth.js', evidence: '-check(user)\n+stillChecks(user)' })
    expect(locate(both, 'a/src/auth.js', 40)?.path).toBe('src/auth.js')
    expect(diffSectionFor(both, 'b/src/auth.js', lookalike)).toContain('+skipCheck(user)')
    expect(diffSectionFor(both, 'b/src/auth.js', lookalike)).not.toContain('+stillChecks(user)')
  })

  it('resolves a citation in git\'s escaped spelling to the decoded name', () => {
    const accented = splitDiff([
      'diff --git "a/donn\\303\\251es.js" "b/donn\\303\\251es.js"',
      '@@ -1 +1 @@',
      '-old()',
      '+new()',
    ].join('\n'))
    expect(sectionFor(accented, 'donn\\303\\251es.js')?.path).toBe('donn\u00E9es.js')
    expect(sectionFor(accented, 'b/donn\\303\\251es.js')?.path).toBe('donn\u00E9es.js')
    expect(sectionFor(accented, '"b/donn\\303\\251es.js"')?.path).toBe('donn\u00E9es.js')
    expect(locate(accented, 'donn\\303\\251es.js', 1)).toEqual({ path: 'donn\u00E9es.js', evidence: '-old()\n+new()' })
  })

  it('does not trim a decoded name, so a name that starts with a tab is still found', () => {
    const tabbed = splitDiff('diff --git "a/\\tx.js" "b/\\tx.js"\n+x')
    expect([
      ...tabbed.keys(),
    ]).toEqual(['\tx.js'])
    expect(sectionFor(tabbed, '\\tx.js')?.path).toBe('\tx.js')
  })

  it('looks a citation up as written before it decodes it', () => {
    const both = splitDiff([
      'diff --git "a/donn\\\\303\\\\251es.js" "b/donn\\\\303\\\\251es.js"',
      '+literal',
      'diff --git "a/donn\\303\\251es.js" "b/donn\\303\\251es.js"',
      '+accented',
    ].join('\n'))
    expect([
      ...both.keys(),
    ]).toEqual(['donn\\303\\251es.js', 'donn\u00E9es.js'])
    expect(sectionFor(both, 'donn\\303\\251es.js')?.text).toContain('+literal')
    expect(sectionFor(both, 'donn\u00E9es.js')?.text).toContain('+accented')
  })

  it('does not resolve a backslash path to the forward-slash file', () => {
    expect(sectionFor(sections, 'src\\a.js')).toBeUndefined()
  })

  it('resolves every key of a diff to itself, untrimmed', () => {
    const tricky = [
      'diff --git a/src/auth.js b/src/auth.js',
      '+real',
      'diff --git "a/\\357\\273\\277src/auth.js" "b/\\357\\273\\277src/auth.js"',
      '+bom',
      'diff --git "a/\\tx.js" "b/\\tx.js"',
      '+tab',
      'diff --git a/ y.js b/ y.js',
      '+space',
      'diff --git "a/we\\"ird.js" "b/we\\"ird.js"',
      '+quote',
    ].join('\n')
    const keyed = splitDiff(tricky)
    expect(keyed.size).toBe(5)
    for (const key of keyed.keys()) {
      expect(sectionFor(keyed, key)?.path, JSON.stringify(key)).toBe(key)
    }
  })

  it('gives a citation holding a real tab the tab-named file, not its trimmed look-alike', () => {
    const both = splitDiff([
      'diff --git "a/\\tx.js" "b/\\tx.js"',
      '+tabbed',
      'diff --git a/x.js b/x.js',
      '+plain',
    ].join('\n'))
    expect(sectionFor(both, '\tx.js')?.text).toContain('+tabbed')
    expect(sectionFor(both, 'x.js')?.text).toContain('+plain')
  })

  it('keeps the bytes of a name that is not valid UTF-8 as lone surrogates, so two such names stay apart', () => {
    const invalid = [
      'diff --git "a/x\\376.js" "b/x\\376.js"',
      '+decoy()',
      'diff --git "a/x\\377.js" "b/x\\377.js"',
      '+exec(cmd)',
    ].join('\n')
    const apart = splitDiff(invalid)
    expect([
      ...apart.keys(),
    ]).toEqual(['x\uDCFE.js', 'x\uDCFF.js'])
    expect(sectionFor(apart, 'x\\377.js')?.text).toContain('+exec(cmd)')
    expect(sectionFor(apart, 'x\\377.js')?.text).not.toContain('+decoy()')
  })

  it('keeps such a name apart from a file literally named after its escapes', () => {
    const pair = [
      'diff --git "a/x\\377.js" "b/x\\377.js"',
      '+decoy()',
      'diff --git "a/x\\\\377.js" "b/x\\\\377.js"',
      '+literal()',
    ].join('\n')
    const apart = splitDiff(pair)
    expect([
      ...apart.keys(),
    ]).toEqual(['x\uDCFF.js', 'x\\377.js'])
    expect(sectionFor(apart, 'x\\\\377.js')?.text).toContain('+literal()')
    expect(sectionFor(apart, 'x\\\\377.js')?.text).not.toContain('+decoy()')
  })

  it('matches a unique path suffix on the path without its a/ or b/ prefix', () => {
    expect(sectionFor(sections, 'b/b.js')?.path).toBe('lib/b.js')
    expect(sectionFor(sections, './b.js')?.path).toBe('lib/b.js')
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
    const custom = [
      'diff --git old/x new/x',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n')
    const unreadable = splitDiff(custom)
    expect(unreadable.size).toBe(0)
    expect(sectionFor(unreadable, 'x')).toBeUndefined()
    expect(locate(unreadable, 'x', 1)).toBeUndefined()
    expect(diffSectionFor(unreadable, 'x', custom)).toBe(custom)
  })

  it('does not let a preamble stand for a file when every header is unreadable', () => {
    const series = [
      'Subject: [PATCH] tweak',
      '',
      'diff --git old/x new/x',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n')
    const unreadable = splitDiff(series)
    expect(unreadable.size).toBe(0)
    expect(sectionFor(unreadable, 'x')).toBeUndefined()
    expect(diffSectionFor(unreadable, 'x', series)).toBe(series)
  })

  it('does not let a preamble stand for a file that is not in the diff', () => {
    const series = ['Subject: [PATCH] tweak', '', gitDiff].join('\n')
    const withPreamble = splitDiff(series)
    expect([
      ...withPreamble.keys(),
    ]).toEqual(['', 'src/a.js', 'lib/b.js'])
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
      evidence: [
        ' const a = 1',
        '-const b = read()',
        '+const b = readUnsafe(input)',
        '+log(b)',
        ' exec(b)',
      ].join('\n'),
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
      expect(locate(sections, 'src/a.js', line), `line ${line}`).toBeUndefined()
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
    const removed = [
      'diff --git a/a.js b/a.js',
      '@@ -5,4 +4,0 @@',
      '-one()',
      '-two()',
      '-three()',
      '-four()',
    ].join('\n')
    expect(locate(splitDiff(removed), 'a.js', 4)).toEqual({ path: 'a.js', evidence: '-one()\n-two()\n-three()' })
  })

  it('returns undefined for a deletion-only hunk cut off before its first row', () => {
    const cutOff = ['diff --git a/a.js b/a.js', '@@ -5,2 +4,0 @@'].join('\n')
    expect(locate(splitDiff(cutOff), 'a.js', 4)).toBeUndefined()
  })

  it('reads an empty line inside a hunk as a blank context row', () => {
    const blank = [
      'diff --git a/a.js b/a.js',
      '@@ -1,3 +1,3 @@',
      ' first()',
      '',
      ' third()',
    ].join('\n')
    expect(locate(splitDiff(blank), 'a.js', 3)?.evidence).toBe(' first()\n\n third()')
  })

  it('ignores the empty element after the final newline but not an empty line before it', () => {
    const cutOff = [
      'diff --git a/a.js b/a.js',
      '@@ -1,9 +1,9 @@',
      ' keep()',
      ' keep2()',
    ].join('\n')
    expect(locate(splitDiff(`${cutOff}\n`), 'a.js', 2)?.evidence).toBe(' keep()\n keep2()')
    expect(locate(splitDiff(`${cutOff}\n`), 'a.js', 3)).toBeUndefined()
    expect(locate(splitDiff(`${cutOff}\n\n`), 'a.js', 3)?.evidence).toBe(' keep()\n keep2()\n')
  })

  it('returns undefined for a file that is not in the diff', () => {
    expect(locate(sections, 'nope.js', 1)).toBeUndefined()
  })

  it('removes carriage returns from a CRLF diff', () => {
    const crlf = [
      'diff --git a/a.js b/a.js',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\r\n')
    expect(locate(splitDiff(crlf), 'a.js', 1)).toEqual({ path: 'a.js', evidence: '-x\n+y' })
  })

  it('reads a plain unified diff through its single unkeyed section', () => {
    const plain = '--- a.js\n+++ a.js\n@@ -1 +1 @@\n-x\n+y'
    expect(locate(splitDiff(plain), 'a.js', 1)).toEqual({ path: '', evidence: '-x\n+y' })
  })

  it('returns undefined for a line a cut-off hunk promised but never shows', () => {
    const cutOff = [
      'diff --git a/a.js b/a.js',
      '@@ -1,9 +1,9 @@',
      ' keep()',
      ' keep2()',
    ].join('\n')
    expect(locate(splitDiff(cutOff), 'a.js', 2)?.evidence).toBe(' keep()\n keep2()')
    expect(locate(splitDiff(cutOff), 'a.js', 8)).toBeUndefined()
  })

  it('does not read the next header block as hunk lines after a cut-off hunk', () => {
    const series = [
      'diff --git a/a.js b/a.js',
      '@@ -1,9 +1,9 @@',
      ' keep()',
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -20 +20 @@',
      '-old()',
      '+new()',
    ].join('\n')
    const repeated = splitDiff(series)
    expect(locate(repeated, 'a.js', 2)).toBeUndefined()
    expect(locate(repeated, 'a.js', 20)).toEqual({ path: 'a.js', evidence: '-old()\n+new()' })
  })

  it('does not absorb the next file header into a cut-off hunk', () => {
    const truncated = [
      'diff --git a/a.js b/a.js',
      '@@ -1,9 +1,9 @@',
      ' keep()',
      'diff --git a/b.js b/b.js',
      '+++ b/b.js',
    ].join('\n')
    expect(locate(splitDiff(truncated), 'a.js', 1)).toEqual({ path: 'a.js', evidence: ' keep()' })
  })

  it('locates a thousand findings in one large file in linear time', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => `+line ${index}`)
    const large = splitDiff(['diff --git a/large.js b/large.js', '@@ -0,0 +1,100000 @@', ...rows].join('\n'))
    let located = 0
    const started = performance.now()
    for (let finding = 0; finding < 1_000; finding++) {
      if (locate(large, 'large.js', 100_000 - finding) !== undefined) located++
    }
    expect(performance.now() - started).toBeLessThan(300)
    expect(located).toBe(1_000)
  })
})

describe('firstLineOutside', () => {
  /**
   * a.js holds lines 1 to 5 (two adjacent hunks), 9 to 11 (a hunk given out of order over another),
   * 13 (a deletion-only hunk), 20 and 21 (a hunk cut short of its count) and 25 (a hunk whose rows run
   * past its count); b.js holds line 2.
   */
  const sections = splitDiff([
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,2 +1,3 @@',
    ' a',
    '+b',
    ' c',
    '@@ -3,1 +4,2 @@',
    ' d',
    '+e',
    '@@ -8,2 +10,2 @@',
    ' f',
    ' g',
    '@@ -12,2 +13,0 @@',
    '-h',
    '-i',
    '@@ -7,3 +9,3 @@',
    ' j',
    ' k',
    ' l',
    '@@ -20,4 +20,4 @@',
    ' p',
    ' q',
    '@@ -30,3 +25,1 @@',
    ' r',
    ' s',
    ' t',
    'diff --git a/b.js b/b.js',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +2 @@',
    '-old',
    '+new',
    '',
  ].join('\n'))

  /** What checking each line of the range with `locate` finds: the first line it places in no hunk. */
  function byLocate(file: string, start: number, end: number): number | undefined {
    for (let line = start; line <= end; line++) {
      if (locate(sections, file, line) === undefined) return line
    }
    return undefined
  }

  it.each<[string, string, number, number, number | undefined]>([
    [
      'a range inside one hunk',
      'a.js',
      1,
      3,
      undefined,
    ],
    [
      'a range across two adjacent hunks',
      'a.js',
      2,
      5,
      undefined,
    ],
    [
      'a range that runs into the gap after them',
      'a.js',
      4,
      7,
      6,
    ],
    [
      'a range that starts in the gap',
      'a.js',
      6,
      9,
      6,
    ],
    [
      'a range across a hunk given out of order over another',
      'a.js',
      9,
      11,
      undefined,
    ],
    [
      'the line a deletion-only hunk holds',
      'a.js',
      13,
      13,
      undefined,
    ],
    [
      'a range past a deletion-only hunk',
      'a.js',
      13,
      14,
      14,
    ],
    [
      'a range across the line between two hunks',
      'a.js',
      11,
      13,
      12,
    ],
    [
      'a range past the rows a hunk cut short shows',
      'a.js',
      20,
      23,
      22,
    ],
    [
      'a range past the one line a hunk counts, though its rows run on',
      'a.js',
      25,
      26,
      26,
    ],
    [
      'a range past the last hunk',
      'a.js',
      30,
      31,
      30,
    ],
    [
      'a range of another file of the diff',
      'b.js',
      1,
      2,
      1,
    ],
    [
      'a range of a file the diff does not touch',
      'c.js',
      1,
      1,
      1,
    ],
  ])('finds, for %s, the first line locate places in no hunk', (_name, file, start, end, expected) => {
    expect(firstLineOutside(sections, file, start, end)).toBe(expected)
    expect(byLocate(file, start, end)).toBe(expected)
  })

  it('agrees with locate on every range of up to nine lines from line 0 to 30, in each file', () => {
    for (const file of ['a.js', 'b.js', 'c.js']) {
      for (let start = 0; start <= 30; start++) {
        for (let end = start; end <= start + 8; end++) expect(firstLineOutside(sections, file, start, end), `${file} ${start}-${end}`).toBe(byLocate(file, start, end))
      }
    }
  })

  it('refuses a range that is not two whole lines in order', () => {
    expect(() => firstLineOutside(sections, 'a.js', 3, 2)).toThrow(RangeError)
    expect(() => firstLineOutside(sections, 'a.js', 1.5, 2)).toThrow(RangeError)
  })
})

describe('decodeDiff', () => {
  const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

  it('reads chunks as UTF-8 text, a leading byte-order mark dropped and a character split between chunks kept whole', async () => {
    expect(await decodeDiff([
      bytes(0xEF, 0xBB, 0xBF, 0x61, 0xC3),
      bytes(0xA9, 0x62),
    ])).toBe(`a${String.fromCharCode(0xE9)}b`)
  })

  it('reads a byte that is not UTF-8 as the replacement character, as the review command always has', async () => {
    expect(await decodeDiff([
      bytes(0x61, 0xFF, 0x62),
    ])).toBe(`a${String.fromCharCode(0xFFFD)}b`)
  })

  it('stops at the chunk that takes the bytes past the cap', async () => {
    let pulled = 0
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulled += 1
        yield new Uint8Array(4)
      }
    }
    expect(await decodeDiff(chunks(), 10)).toBeUndefined()
    expect(pulled).toBe(3)
  })

  it('counts a string chunk by its UTF-8 bytes', async () => {
    expect(await decodeDiff(['ab', 'c'], 3)).toBe('abc')
    expect(await decodeDiff([
      String.fromCharCode(0xE9).repeat(2),
    ], 3)).toBeUndefined()
  })
})
