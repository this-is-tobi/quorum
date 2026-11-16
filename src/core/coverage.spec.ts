import { describe, expect, it } from 'vitest'
import { credentialPlaceholder, fakeCredential } from '../testing/credentials.ts'
import * as git from '../testing/fixtures/git.ts'
import { leftOutGaps, reviewScope } from './coverage.ts'
import { diffSections, splitDiff } from './diff.ts'
import { excludeMatcher } from './exclude.ts'
import { isWholeDeletion } from './secrets.ts'
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

  it('lists every file of the diff once, in its order: the empty name for a preamble, an unreadable header and a Submodule line, and none for a blank preamble', () => {
    const section = (file: string): string => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b`
    const diff = [
      'From 1234 Mon Sep 17 00:00:00 2001',
      section('a.js'),
      'diff --git unreadable',
      section('a.js'),
      `${section('a.js')}\nSubmodule lib 1234567..89abcde:`,
    ].join('\n')
    expect(reviewScope(diff).files).toEqual(['', 'a.js'])
    expect(reviewScope(`\n${section('b.js')}`).files).toEqual(['b.js'])
    expect(reviewScope(`\n \n${section('b.js')}`).files).toEqual(['b.js'])
    expect(reviewScope(`${section('b.js')}\nSubmodule lib 1234567..89abcde:`).files).toEqual(['b.js', ''])
    expect(reviewScope(`${section('a.js')}\n${section('b.js')}`, path => path === 'a.js').files).toEqual(['a.js', 'b.js'])
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

describe('reviewScope, with excludes', () => {
  const scope = (diff: string, ...patterns: string[]) => reviewScope(diff, excludeMatcher(patterns))

  it('lists an excluded binary file as excluded only, and leaves its section out of the diff', () => {
    const result = scope(git.BINARY, '*.png')
    expect(result.leftOut).toContainEqual({ file: 'img.png', reason: 'excluded' })
    expect(result.leftOut).not.toContainEqual({ file: 'img.png', reason: 'binary' })
    expect([
      ...splitDiff(result.diff).keys(),
    ]).toEqual([
      ...splitDiff(git.BINARY).keys(),
    ].filter(file => file !== 'img.png'))
    expect(result.diff).not.toContain('img.png')
  })

  it('excludes a submodule of the short format by its path', () => {
    const result = scope(git.SUBMODULE_BUMPED, 'vendor/**')
    expect(result.leftOut).toEqual([
      { file: 'vendor/lib', reason: 'excluded' },
    ])
    expect([
      ...splitDiff(result.diff).keys(),
    ]).toEqual(['app.js'])
  })

  it('keeps the submodule a Submodule line names when the section that holds the line is excluded', () => {
    const result = scope(git.SUBMODULE_LOG_BUMPED, 'app.js')
    expect(result.leftOut).toEqual([
      { file: 'app.js', reason: 'excluded' },
      { file: '', reason: 'submodule' },
    ])
    expect(result.diff).toBe('')
  })

  it('never excludes a part of the diff no header names', () => {
    expect(scope(git.PLAIN, '**').leftOut).toEqual([
      { file: '', reason: 'binary' },
    ])
    expect(scope(git.NO_PREFIX, '**').leftOut).toEqual([
      { file: 'img.png', reason: 'excluded' },
      { file: '', reason: 'binary' },
      { file: 'text.js', reason: 'excluded' },
    ])
  })

  it('keeps exactly the other sections, in order, when the first, the last or every file goes', () => {
    const three = 'diff --git a/a.js b/a.js\n+a\ndiff --git a/b.js b/b.js\n+b\ndiff --git a/c.js b/c.js\n+c\n'
    expect(scope(three, 'a.js', 'c.js').diff).toBe('diff --git a/b.js b/b.js\n+b')
    expect(scope(three, 'b.js').diff).toBe('diff --git a/a.js b/a.js\n+a\ndiff --git a/c.js b/c.js\n+c\n')
    expect(scope(`From x\n\n${three}`, 'a.js', 'b.js', 'c.js').diff).toBe('From x\n')
  })

  it('matches a quoted name by its decoded path', () => {
    expect(scope(git.BINARY, DONNEES, 'a"quote.bin').leftOut.slice(0, 2)).toEqual([
      { file: 'a"quote.bin', reason: 'excluded' },
      { file: DONNEES, reason: 'excluded' },
    ])
  })

  it('keeps a renamed section whose header reads as an excluded path its rename to line does not name', () => {
    for (const renamed of [git.RENAMED_INTO_DIST, git.RENAMED_OUT_OF_DIST]) {
      const result = scope(renamed, 'dist/**')
      expect(result.leftOut).toEqual([])
      expect(result.diff).toBe(renamed)
    }
  })

  it('excludes a rename or a copy its rename to or copy to line confirms, a quoted name decoded', () => {
    const moved = (verb: string): string => [
      'diff --git a/src/x.js b/dist/x.js',
      'similarity index 90%',
      `${verb} from src/x.js`,
      `${verb} to dist/x.js`,
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    const entry = [
      { file: 'dist/x.js', reason: 'excluded' },
    ]
    expect(scope(moved('rename'), 'dist/**').leftOut).toEqual(entry)
    expect(scope(moved('copy'), 'dist/**').leftOut).toEqual(entry)
    const quoted = [
      'diff --git "a/src/donn\\303\\251es.js" "b/dist/donn\\303\\251es.js"',
      'rename to "dist/donn\\303\\251es.js"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    expect(scope(quoted, 'dist/**').leftOut).toEqual([
      { file: `dist/donn${String.fromCharCode(0xE9)}es.js`, reason: 'excluded' },
    ])
  })

  it('keeps and lists as binary a renamed binary file whose header it misreads', () => {
    const binary = [
      'diff --git a/src/auth.js b/src/x b/dist/auth.js',
      'rename from src/auth.js',
      'rename to src/x b/dist/auth.js',
      'index 04ad716..a30ef13 100644',
      'Binary files a/src/auth.js and b/src/x b/dist/auth.js differ',
    ].join('\n')
    expect(scope(binary, 'dist/**').leftOut).toEqual([
      { file: 'dist/auth.js', reason: 'binary' },
    ])
  })
})

describe('reviewScope, holding secrets', () => {
  /** A section that modifies `file`, its added rows after one context row. */
  const edit = (file: string, ...added: string[]): string => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1 +1,${added.length + 1} @@`,
    ' context',
    ...added.map(row => `+${row}`),
  ].join('\n')
  /** The section of `file` in the diff of a deletion that git writes: a lookup that fails throws, so no test passes on an empty section. */
  const deletion = (file: string): string => {
    const section = diffSections(git.DELETED_SECRET).find(candidate => candidate.path === file)
    if (section === undefined) throw new Error(`the deletion fixture has no section of ${JSON.stringify(file)}`)
    return section.text
  }
  const mail = (message: string): string => [
    'From 1234 Mon Sep 17 00:00:00 2001',
    'Subject: [PATCH] a',
    '',
    message,
    '---',
    edit('a.js', 'x'),
  ].join('\n')

  it('holds a file named as a secret: its section leaves the diff, listed as secret with the rule name', () => {
    const scope = reviewScope([
      edit('.env', 'A=1'),
      edit('a.js', 'let a = 1'),
    ].join('\n'))
    expect(scope.diff).toBe(edit('a.js', 'let a = 1'))
    expect(scope.leftOut).toEqual([
      { file: '.env', reason: 'secret', rule: 'name' },
    ])
    expect(scope.files).toEqual(['.env', 'a.js'])
  })

  it('holds a file by a credential on any of its rows, listed with its kind', () => {
    const scope = reviewScope([
      edit('a.js', 'let a = 1'),
      edit('src/app.js', `const k = '${fakeCredential('stripe-key')}'`),
    ].join('\n'))
    expect(scope.diff).toBe(edit('a.js', 'let a = 1'))
    expect(scope.leftOut).toEqual([
      { file: 'src/app.js', reason: 'secret', rule: 'stripe-key' },
    ])
  })

  it('holds a file whose only hit is a removed line, a secret gap with the kind', () => {
    const removal = [
      'diff --git a/src/app.js b/src/app.js',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,2 +1 @@',
      `-const k = '${fakeCredential('aws-key')}'`,
      ' keep',
    ].join('\n')
    const scope = reviewScope(removal)
    expect(scope.diff).toBe('')
    expect(scope.leftOut).toEqual([
      { file: 'src/app.js', reason: 'secret', rule: 'aws-key' },
    ])
    expect(leftOutGaps('security', scope.leftOut)).toHaveLength(1)
  })

  it('lists a whole deletion as deleted-secret', () => {
    const scope = reviewScope(git.DELETED_SECRET)
    expect(scope.leftOut).toEqual([
      { file: '.env', reason: 'deleted-secret', rule: 'name' },
    ])
    expect([
      ...splitDiff(scope.diff).keys(),
    ]).toEqual(['a.js'])
    expect(scope.diff).not.toContain('A=1')
    expect(scope.files).toEqual(['.env', 'a.js'])
  })

  it('holds a whole deletion of a file held for a credential as a secret gap, since its removed code goes unread', () => {
    const removal = [
      'diff --git a/src/authz.ts b/src/authz.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/src/authz.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export const allowed = false',
      `-const k = '${fakeCredential('openai-key')}'`,
    ].join('\n')
    expect(isWholeDeletion(removal)).toBe(true)
    const scope = reviewScope(`${removal}\n${edit('a.js', 'x')}`)
    expect(scope.leftOut).toEqual([
      { file: 'src/authz.ts', reason: 'secret', rule: 'openai-key' },
    ])
    expect(scope.diff).toBe(edit('a.js', 'x'))
    expect(leftOutGaps('security', scope.leftOut)).toEqual([
      { profile: 'security', reason: 'secret', detail: 'no model was sent 1 file(s) held as secrets, listed in meta.leftOut' },
    ])
  })

  it('holds a forged header that spells a secret name, read word by word, as a gap', () => {
    const rows = ['@@ -0,0 +1 @@', '+A=1']
    const nameless = reviewScope([
      'diff --git a/.env',
      ...rows,
      edit('a.js', 'x'),
    ].join('\n'))
    expect(nameless.leftOut).toEqual([
      { file: '', reason: 'secret', rule: 'name' },
    ])
    expect(nameless.diff).toBe(edit('a.js', 'x'))
    const third = reviewScope([
      'diff --git a/.env b/.env c',
      ...rows,
      edit('a.js', 'x'),
    ].join('\n'))
    expect(third.leftOut).toEqual([
      { file: '.env c', reason: 'secret', rule: 'name' },
    ])
    expect(third.diff).toBe(edit('a.js', 'x'))
    expect(leftOutGaps('security', third.leftOut)).toHaveLength(1)
  })

  it('holds a forged deletion whose --- line names another file as a secret gap, never as deleted-secret', () => {
    const forged = git.DELETED_SECRET.replace('--- a/.env', '--- a/src/auth.ts')
    expect(forged).not.toBe(git.DELETED_SECRET)
    const scope = reviewScope(forged)
    expect(scope.leftOut).toEqual([
      { file: '.env', reason: 'secret', rule: 'name' },
    ])
    expect(leftOutGaps('security', scope.leftOut)).toHaveLength(1)
  })

  it('judges a format-patch series that edits then deletes .env as one secret file, a gap', () => {
    const scope = reviewScope([
      edit('.env', 'A=2'),
      deletion('.env'),
      edit('a.js', 'x'),
    ].join('\n'))
    expect(scope.leftOut).toEqual([
      { file: '.env', reason: 'secret', rule: 'name' },
    ])
    expect(scope.diff).toBe(edit('a.js', 'x'))
    expect(leftOutGaps('security', scope.leftOut)).toHaveLength(1)
  })

  it('holds every section of a held file, and a credential in one holds the others, the file listed once at its first section', () => {
    const image = 'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ'
    const scope = reviewScope([
      edit('a.js', 'let a = 1'),
      image,
      edit('b.js', 'let b = 1'),
      edit('a.js', `const k = '${fakeCredential('github-token')}'`),
    ].join('\n'))
    expect(scope.diff).toBe([
      image,
      edit('b.js', 'let b = 1'),
    ].join('\n'))
    expect(scope.leftOut).toEqual([
      { file: 'a.js', reason: 'secret', rule: 'github-token' },
      { file: 'img.png', reason: 'binary' },
    ])
  })

  it('holds the text no header names as the file of the empty name, a plain diff whole', () => {
    const key = fakeCredential('openai-key')
    const message = reviewScope(mail(`the key is ${key}`))
    expect(message.leftOut).toEqual([
      { file: '', reason: 'secret', rule: 'openai-key' },
    ])
    expect(message.diff).toBe(edit('a.js', 'x'))
    const plain = reviewScope([
      '--- a/.env\t2026-11-14 17:10:49',
      '+++ b/.env\t2026-11-14 17:10:49',
      '@@ -1 +1 @@',
      '-A=1',
      '+A=2',
      '',
    ].join('\n'))
    expect(plain.diff).toBe('')
    expect(plain.leftOut).toEqual([
      { file: '', reason: 'secret', rule: 'name' },
    ])
  })

  it('holds a renamed file by its old name under -M', () => {
    const scope = reviewScope(git.RENAMED_FROM_SECRET)
    expect(scope.leftOut).toEqual([
      { file: 'moved.txt', reason: 'secret', rule: 'name' },
    ])
    expect(scope.diff).toBe('')
  })

  it('excludes before it holds: an excluded secret is listed excluded only', () => {
    const diff = [
      edit('.env', 'A=1'),
      edit('a.js', `const k = '${fakeCredential('aws-key')}'`),
    ].join('\n')
    const scope = reviewScope(diff, path => path === '.env' || path === 'a.js')
    expect(scope.leftOut).toEqual([
      { file: '.env', reason: 'excluded' },
      { file: 'a.js', reason: 'excluded' },
    ])
    expect(scope.diff).toBe('')
  })

  it('sends a file the override names by the diff\'s own path, and never the empty name', () => {
    const diff = [
      edit('.env', 'A=1'),
      edit('a.js', 'let a = 1'),
    ].join('\n')
    const scope = reviewScope(diff, () => false, path => path === '.env')
    expect(scope.diff).toBe(diff)
    expect(scope.leftOut).toEqual([])
    expect(reviewScope(diff, () => false, path => path === './.env').leftOut).toEqual([
      { file: '.env', reason: 'secret', rule: 'name' },
    ])
    const message = mail(`the key is ${fakeCredential('openai-key')}`)
    const answers: Array<(path: string) => boolean> = [
      path => path === '',
      () => true,
    ]
    for (const sent of answers) {
      expect(reviewScope(message, () => false, sent).leftOut).toEqual([
        { file: '', reason: 'secret', rule: 'openai-key' },
      ])
    }
  })

  it('reads no marker of a held section: a held binary file is listed secret only', () => {
    const scope = reviewScope(['diff --git a/k.p12 b/k.p12', 'index 1a2b3c4..5d6e7f8 100644', 'Binary files a/k.p12 and b/k.p12 differ'].join('\n'))
    expect(scope.leftOut).toEqual([
      { file: 'k.p12', reason: 'secret', rule: 'name' },
    ])
    expect(scope.diff).toBe('')
  })

  it('returns the given string as its diff when nothing is held or excluded', () => {
    const placeholder = edit('a.js', `const k = '${credentialPlaceholder('aws-key')}'`)
    expect(reviewScope(placeholder).diff).toBe(placeholder)
    expect(reviewScope(git.DELETED_SECRET, () => false, path => path === '.env').diff).toBe(git.DELETED_SECRET)
    expect(reviewScope(edit('.env.example', 'A=')).diff).toBe(edit('.env.example', 'A='))
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

  it('gives no gap for an excluded file', () => {
    expect(leftOutGaps('security', [
      { file: 'lock.json', reason: 'excluded' },
    ])).toEqual([])
  })

  it('records one secret gap per profile counting the files held as secrets, and none for a deleted one', () => {
    expect(leftOutGaps('security', [
      { file: '.env', reason: 'secret', rule: 'name' },
      { file: 'a.png', reason: 'binary' },
      { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
      { file: 'src/app.js', reason: 'secret', rule: 'aws-key' },
      { file: 'vendor/lib', reason: 'submodule' },
    ])).toEqual([
      { profile: 'security', reason: 'binary', detail: 'the diff carries no content for 1 binary file(s), listed in meta.leftOut' },
      { profile: 'security', reason: 'submodule', detail: 'the diff carries no content for 1 submodule(s), listed in meta.leftOut' },
      { profile: 'security', reason: 'secret', detail: 'no model was sent 2 file(s) held as secrets, listed in meta.leftOut' },
    ])
    expect(leftOutGaps('security', [
      { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
    ])).toEqual([])
  })
})
