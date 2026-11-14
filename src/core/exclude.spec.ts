import { describe, expect, it } from 'vitest'
import { excludeIssues, excludeMatcher, matchName, patternProblem } from './exclude.ts'

describe('excludeMatcher', () => {
  it.each<[string, string, boolean]>([
    ['*.min.js', 'app.min.js', true],
    ['*.min.js', 'dist/js/app.min.js', true],
    ['*.min.js', 'app.min.jsx', false],
    ['package-lock.json', 'package-lock.json', true],
    ['package-lock.json', 'web/package-lock.json', true],
    ['/package-lock.json', 'package-lock.json', true],
    ['/package-lock.json', 'web/package-lock.json', false],
    ['vendor/**', 'vendor/a/b.go', true],
    ['vendor/**', 'vendor', false],
    ['vendor/**', 'src/vendor/a.go', false],
    ['**/vendor/**', 'src/vendor/a.go', true],
    ['**/vendor/**', 'vendor/a.go', true],
    ['src/*/gen.ts', 'src/a/gen.ts', true],
    ['src/*/gen.ts', 'src/a/b/gen.ts', false],
    ['src/**/gen.ts', 'src/gen.ts', true],
    ['src/**/gen.ts', 'src/a/b/gen.ts', true],
    ['?.txt', 'a.txt', true],
    ['?.txt', 'ab.txt', false],
    ['?.png', `${String.fromCodePoint(0x1F600)}.png`, true],
    ['pages/[id].js', 'pages/[id].js', true],
    ['pages/[id].js', 'pages/i.js', false],
    ['*.PNG', 'a.png', false],
    ['*', 'a/b/c', true],
    ['**', 'a/b/c', true],
    ['docs/*.md', 'x/docs/a.md', false],
  ])('%s against %s: %s', (pattern, path, matched) => {
    expect(excludeMatcher([pattern])(path)).toBe(matched)
  })

  it('matches nothing with no pattern', () => {
    expect(excludeMatcher([])('a')).toBe(false)
  })

  it('finishes at once on a long path and patterns a backtracking matcher takes forever on', () => {
    expect(excludeMatcher(['**/a/**/a/**/a/**/b'])(`${'a/'.repeat(200_000)}a`)).toBe(false)
    expect(excludeMatcher(['*a*a*a*a*a*b'])(`x/${'a'.repeat(400_000)}`)).toBe(false)
    expect(matchName(`*${'a'.repeat(50)}b`, 'a'.repeat(100_000))).toBe(false)
  })
})

describe('patternProblem', () => {
  const EMPTY_OR_DOT_NAME = 'holds an empty, . or .. name, which no path in a diff has: write the path from the root, as in dist/**'

  it.each<[string, string]>([
    ['', 'must not be empty'],
    [
      'a'.repeat(257),
      'must be at most 256 characters long',
    ],
    ['src\\gen\\*.ts', 'holds \\, which escapes nothing here: write / between directories, and every other character as it is'],
    ['!keep.lock', 'holds !, which negates nothing here: list only the paths to leave out'],
    ['*.{js,ts}', 'holds {, which lists no alternatives here: write one pattern for each'],
    ['vendor/', 'ends with /, so it matches no file: end it with /** to leave out what the directory holds'],
    ['**.js', 'holds ** inside a name: ** stands for whole directories, as in **/*.min.js, and * for any characters of a name'],
    ['a//b', EMPTY_OR_DOT_NAME],
    ['./dist/**', EMPTY_OR_DOT_NAME],
    ['src/../lib/*.js', EMPTY_OR_DOT_NAME],
    ['//dist/**', EMPTY_OR_DOT_NAME],
  ])('refuses %j', (pattern, problem) => {
    expect(patternProblem(pattern)).toBe(problem)
  })

  it.each([
    '*.min.js',
    '/package-lock.json',
    'vendor/**',
    '**',
    'pages/[id].js',
    'a'.repeat(256),
  ])('takes %j', (pattern) => {
    expect(patternProblem(pattern)).toBeUndefined()
  })
})

describe('excludeIssues', () => {
  it('names the list and each pattern by its index', () => {
    expect(excludeIssues('*.lock')).toEqual([
      { path: 'exclude', message: 'must be an array' },
    ])
    expect(excludeIssues(['*.lock', 3, 'vendor/'])).toEqual([
      { path: 'exclude.1', message: 'must be a string' },
      { path: 'exclude.2', message: 'ends with /, so it matches no file: end it with /** to leave out what the directory holds' },
    ])
    expect(excludeIssues(Array.from({ length: 101 }).fill('*.lock'))).toEqual([
      { path: 'exclude', message: 'must hold at most 100 patterns' },
    ])
    expect(excludeIssues(undefined)).toEqual([])
  })
})
