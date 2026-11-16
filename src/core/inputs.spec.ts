import { describe, expect, it } from 'vitest'
import { leftOutIssues, mergeLeftOut, sourceIssues, sourceOf } from './inputs.ts'
import type { ReviewSource } from './types.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const S = 'c'.repeat(64)

const ID = 'must be a full commit id of its object format: 40 lowercase hexadecimal characters for sha1, 64 for sha256'
const KIND = 'must be diff, range, local, staged or paths'
const REASON = 'must be excluded, binary or submodule'

/** The issues as `path: message` lines. */
const lines = (issues: readonly { path: string, message: string }[]): string[] => issues.map(issue => `${issue.path}: ${issue.message}`)

describe('sourceIssues', () => {
  it.each<[ReviewSource]>([
    [
      { kind: 'diff' },
    ],
    [
      {
        kind: 'range',
        base: A,
        mergeBase: B,
        head: A,
        objectFormat: 'sha1',
      },
    ],
    [
      {
        kind: 'range',
        base: S,
        mergeBase: S,
        head: S,
        objectFormat: 'sha256',
      },
    ],
    [
      { kind: 'local', head: null, objectFormat: 'sha1' },
    ],
    [
      { kind: 'staged', head: A, objectFormat: 'sha1' },
    ],
    [
      {
        kind: 'paths',
        commit: A,
        paths: ['.'],
        skips: true,
        objectFormat: 'sha1',
      },
    ],
  ])('takes the source %j', (source) => {
    expect(sourceIssues(source)).toEqual([])
  })

  it.each<[unknown, string[]]>([
    [
      null,
      ['source: must be an object'],
    ],
    [
      { kind: 'tree' },
      [`source.kind: ${KIND}`],
    ],
    [
      {
        kind: 'range',
        base: A,
        mergeBase: A,
        head: A,
        objectFormat: 'md5',
      },
      ['source.objectFormat: must be sha1 or sha256'],
    ],
    [
      {
        kind: 'range',
        base: A.toUpperCase(),
        mergeBase: A,
        head: A,
        objectFormat: 'sha1',
      },
      [`source.base: ${ID}`],
    ],
    [
      {
        kind: 'range',
        base: A,
        mergeBase: A,
        head: S,
        objectFormat: 'sha1',
      },
      [`source.head: ${ID}`],
    ],
    [
      { kind: 'local', head: '', objectFormat: 'sha1' },
      [`source.head: ${ID}, or null when nothing is committed`],
    ],
    [
      {
        kind: 'paths',
        commit: A,
        paths: [1],
        skips: true,
        objectFormat: 'sha1',
      },
      ['source.paths: must be an array of strings'],
    ],
    [
      {
        kind: 'paths',
        commit: A,
        paths: ['.'],
        skips: 'yes',
        objectFormat: 'sha1',
      },
      ['source.skips: must be a boolean'],
    ],
  ])('refuses the source %j with %s', (source, issues) => {
    expect(lines(sourceIssues(source))).toEqual(issues)
  })
})

describe('leftOutIssues', () => {
  it.each<[unknown, string[]]>([
    [
      {},
      ['leftOut: must be an array'],
    ],
    [
      [null],
      ['leftOut.0: must be an object with a file and a reason'],
    ],
    [
      [
        { file: 1, reason: 'excluded' },
      ],
      ['leftOut.0.file: must be a string'],
    ],
    [
      [
        { file: 'a', reason: 'gone' },
      ],
      [`leftOut.0.reason: ${REASON}`],
    ],
  ])('refuses the leftOut %j with %s', (leftOut, issues) => {
    expect(lines(leftOutIssues(leftOut))).toEqual(issues)
  })
})

describe('mergeLeftOut', () => {
  it('merges the source\'s files left out before the diff\'s, each file and reason once', () => {
    expect(mergeLeftOut([
      { file: 'a', reason: 'excluded' },
    ], [
      { file: 'b', reason: 'binary' },
      { file: 'a', reason: 'excluded' },
    ])).toEqual([
      { file: 'a', reason: 'excluded' },
      { file: 'b', reason: 'binary' },
    ])
  })
})

describe('sourceOf', () => {
  it('copies only the known fields of a source', () => {
    const given = {
      kind: 'range',
      base: A,
      mergeBase: A,
      head: A,
      objectFormat: 'sha1',
      extra: 1,
    } as unknown as ReviewSource
    const copy = sourceOf(given)
    expect(copy).toEqual({
      kind: 'range',
      base: A,
      mergeBase: A,
      head: A,
      objectFormat: 'sha1',
    })
    expect(copy).not.toHaveProperty('extra')
    expect(copy).not.toBe(given)
  })
})
