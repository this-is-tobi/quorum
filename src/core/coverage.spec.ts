import { describe, expect, it } from 'vitest'
import * as git from '../testing/fixtures/git.ts'
import { leftOutGaps, reviewScope } from './coverage.ts'
import type { LeftOutReason } from './types.ts'

const DONNEES = `donn${String.fromCharCode(0xE9)}es.bin`

describe('reviewScope, on what git prints', () => {
  it('lists every binary file of a modified, an added, a deleted and a renamed one and two quoted names, in the diff\'s order, by decoded path', () => {
    expect(reviewScope(git.BINARY).leftOut).toEqual([
      { file: 'a"quote.bin', reason: 'binary' },
      { file: DONNEES, reason: 'binary' },
      { file: 'img.png', reason: 'binary' },
      { file: 'moved.bin', reason: 'binary' },
      { file: 'new.bin', reason: 'binary' },
      { file: 'old.bin', reason: 'binary' },
    ])
  })

  it('lists every file a GIT binary patch holds', () => {
    expect(reviewScope(git.BINARY_PATCH).leftOut).toEqual([
      { file: DONNEES, reason: 'binary' },
      { file: 'img.png', reason: 'binary' },
      { file: 'old.bin', reason: 'binary' },
    ])
  })

  it('lists a binary file whose header names no path quorum reads under the empty name', () => {
    expect(reviewScope(git.NO_PREFIX).leftOut).toEqual([
      { file: 'img.png', reason: 'binary' },
      { file: '', reason: 'binary' },
    ])
  })

  it('reads no marker in a diffstat, and the binary patch of a format-patch mail', () => {
    expect(reviewScope(git.FORMAT_PATCH).leftOut).toEqual([
      { file: 'img.png', reason: 'binary' },
    ])
  })

  it('lists the text file a -diff attribute hides, and nothing once the base\'s attributes apply', () => {
    expect(reviewScope(git.ATTRIBUTE_IN_CHECKOUT).leftOut).toEqual([
      { file: 'src/a.js', reason: 'binary' },
    ])
    expect(reviewScope(git.ATTRIBUTE_FROM_BASE).leftOut).toEqual([])
  })

  it('lists a file once per reason, however many sections hold it', () => {
    expect(reviewScope(`${git.BINARY}${git.BINARY}`).leftOut).toEqual([
      { file: 'a"quote.bin', reason: 'binary' },
      { file: DONNEES, reason: 'binary' },
      { file: 'img.png', reason: 'binary' },
      { file: 'moved.bin', reason: 'binary' },
      { file: 'new.bin', reason: 'binary' },
      { file: 'old.bin', reason: 'binary' },
    ])
  })

  it('lists the binary file of a diff without git headers under the empty name', () => {
    expect(reviewScope(git.PLAIN).leftOut).toEqual([
      { file: '', reason: 'binary' },
    ])
  })

  it.each<[string, string]>([
    ['added', git.SUBMODULE_ADDED],
    ['bumped', git.SUBMODULE_BUMPED],
    ['removed', git.SUBMODULE_REMOVED],
  ])('lists a submodule %s in the short format by its path', (_name, diff) => {
    expect(reviewScope(diff).leftOut).toEqual([
      { file: 'vendor/lib', reason: 'submodule' },
    ])
  })

  it.each<[string, string]>([
    ['added, in the log format', git.SUBMODULE_LOG_ADDED],
    ['bumped, in the log format', git.SUBMODULE_LOG_BUMPED],
    ['removed, in the log format', git.SUBMODULE_LOG_REMOVED],
    ['bumped, in the diff format, its own diff following', git.SUBMODULE_DIFF_BUMPED],
    ['bumped, in the diff format, its commits not present', git.SUBMODULE_DIFF_NOT_PRESENT],
  ])('lists a submodule %s under the empty name', (_name, diff) => {
    expect(reviewScope(diff).leftOut).toEqual([
      { file: '', reason: 'submodule' },
    ])
  })

  it('hands back the diff itself when nothing is excluded', () => {
    expect(reviewScope(git.BINARY).diff).toBe(git.BINARY)
  })
})

describe('reviewScope, line by line', () => {
  const section = (line: string): string => `diff --git a/x b/x\n${line}\n`

  it.each<[string, LeftOutReason]>([
    ['Binary files a/x and b/x differ\r', 'binary'],
    ['GIT binary patch', 'binary'],
    ['+Subproject commit 63e7d795762c8a1f7e43531daf2590a3a30c122e', 'submodule'],
    ['-Subproject commit 63e7d795762c8a1f7e43531daf2590a3a30c122e', 'submodule'],
    [' Subproject commit 63e7d795762c8a1f7e43531daf2590a3a30c122e-dirty', 'submodule'],
    ['new file mode 160000', 'submodule'],
    ['deleted file mode 160000', 'submodule'],
    ['old mode 160000', 'submodule'],
    ['new mode 160000\r', 'submodule'],
    ['index 6444d28..63e7d79 160000', 'submodule'],
  ])('reads %j as a %s file', (line, reason) => {
    expect(reviewScope(section(line)).leftOut).toEqual([
      { file: 'x', reason },
    ])
  })

  it.each([
    '+Binary files a/x and b/x differ',
    ' Binary files a/x and b/x differ',
    'Binary files a/x and b/x differ now',
    ' x | Bin 14 -> 22 bytes',
    'index 6444d28..63e7d79 100644',
    'new file mode 100644',
    ' create mode 160000 vendor/lib',
    '+Submodule vendor/lib 6444d28..63e7d79:',
    '+git binary patch',
  ])('reads %j as no marker', (line) => {
    expect(reviewScope(section(line)).leftOut).toEqual([])
  })

  it('reads a commit message line that has the form of a marker as one, in the section before it', () => {
    const series = `${git.SUBMODULE_BUMPED}From 1 Mon Sep 17 00:00:00 2001\nSubject: [PATCH 2/2] docs\n\nBinary files a/doc.png and b/doc.png differ\n---\n${git.ATTRIBUTE_FROM_BASE}`
    expect(reviewScope(series).leftOut).toEqual([
      { file: 'vendor/lib', reason: 'binary' },
      { file: 'vendor/lib', reason: 'submodule' },
    ])
  })
})

describe('leftOutGaps', () => {
  it('gives one gap per reason, binary then submodule, counting the files, and none for a list without them', () => {
    expect(leftOutGaps('security', [
      { file: 'a.png', reason: 'binary' },
      { file: 'vendor/lib', reason: 'submodule' },
      { file: 'b.png', reason: 'binary' },
    ])).toEqual([
      { profile: 'security', reason: 'binary', detail: 'the diff carries no content for 2 binary file(s), listed in meta.leftOut' },
      { profile: 'security', reason: 'submodule', detail: 'the diff carries no content for 1 submodule(s), listed in meta.leftOut' },
    ])
    expect(leftOutGaps('security', [])).toEqual([])
  })
})
