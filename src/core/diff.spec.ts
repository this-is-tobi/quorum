import { describe, expect, it } from 'vitest'
import { diffSectionFor, splitDiff } from './diff.ts'

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
