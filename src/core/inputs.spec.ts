import { describe, expect, it } from 'vitest'
import { leftOutIssues, mergeLeftOut, sendIssues, sourceIssues, sourceOf } from './inputs.ts'
import type { LeftOutFile, ReviewSource } from './types.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const S = 'c'.repeat(64)

const ID = 'must be a full commit id of its object format: 40 lowercase hexadecimal characters for sha1, 64 for sha256'
const KIND = 'must be diff, range, local, staged or paths'
const REASON = 'must be excluded, binary, submodule, skipped, secret or deleted-secret'
const RULE = 'must be vendored, lockfile, minified, test, secret, binary, submodule or lfs'
const SECRET_RULE = 'must be name, private-key, aws-key, github-token, slack-token, google-key, stripe-key, anthropic-key or openai-key'
const RULE_ALONE = 'belongs to a skipped, secret or deleted-secret file only'

/** An array of `length` entries with a hole where `at` is not set: `[, 'b']` is one of 2 whose first is a hole. */
function withHoles<T>(length: number, entries: Readonly<Record<number, T>>): T[] {
  const holey: T[] = []
  holey.length = length
  for (const [at, entry] of Object.entries(entries)) holey[Number(at)] = entry
  return holey
}

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
    [
      {
        kind: 'paths',
        commit: A,
        paths: withHoles(3, { 0: 'a', 2: 'b' }),
        skips: true,
        objectFormat: 'sha1',
      },
      ['source.paths: must be an array of strings'],
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
    [
      withHoles(2, {
        1: { file: 'a', reason: 'excluded' },
      }),
      ['leftOut.0: must be an object with a file and a reason'],
    ],
    [
      [
        { file: 'a', reason: 'skipped', rule: 'huge' },
      ],
      [`leftOut.0.rule: ${RULE}`],
    ],
    [
      [
        { file: 'a', reason: 'skipped' },
      ],
      [`leftOut.0.rule: ${RULE}`],
    ],
    [
      [
        { file: 'a', reason: 'excluded', rule: 'secret' },
      ],
      [`leftOut.0.rule: ${RULE_ALONE}`],
    ],
  ])('refuses the leftOut %j with %s', (leftOut, issues) => {
    expect(lines(leftOutIssues(leftOut))).toEqual(issues)
  })

  it.each<[string, unknown, string[]]>([
    [
      'a secret held by its name',
      { file: '.env', reason: 'secret', rule: 'name' },
      [],
    ],
    [
      'a secret held by a kind of credential',
      { file: 'src/a.js', reason: 'secret', rule: 'aws-key' },
      [],
    ],
    [
      'a deleted secret held by its name',
      { file: '.env', reason: 'deleted-secret', rule: 'name' },
      [],
    ],
    [
      'a secret with no rule',
      { file: '.env', reason: 'secret' },
      [`leftOut.0.rule: ${SECRET_RULE}`],
    ],
    [
      'a secret with the rule of a skip',
      { file: '.env', reason: 'secret', rule: 'lockfile' },
      [`leftOut.0.rule: ${SECRET_RULE}`],
    ],
    [
      'a skipped file with the rule of a credential',
      { file: 'a', reason: 'skipped', rule: 'aws-key' },
      [`leftOut.0.rule: ${RULE}`],
    ],
    [
      'an excluded file with a rule of a hold',
      { file: 'a', reason: 'excluded', rule: 'name' },
      [`leftOut.0.rule: ${RULE_ALONE}`],
    ],
  ])('judges %s', (_name, entry, issues) => {
    expect(lines(leftOutIssues([entry]))).toEqual(issues)
  })

  it('takes a skipped file of each of the eight rules, and every other reason with no rule', () => {
    const rules = [
      'vendored',
      'lockfile',
      'minified',
      'test',
      'secret',
      'binary',
      'submodule',
      'lfs',
    ]
    expect(leftOutIssues([
      ...rules.map(rule => ({ file: `${rule}.x`, reason: 'skipped', rule })),
      { file: 'a', reason: 'excluded' },
      { file: 'b', reason: 'binary' },
      { file: 'c', reason: 'submodule', rule: undefined },
    ])).toEqual([])
  })
})

describe('sendIssues', () => {
  it.each<[unknown, string[]]>([
    [
      undefined,
      [],
    ],
    [
      '.env',
      ['send: must be an array'],
    ],
    [
      [''],
      ['send.0: must name a file'],
    ],
    [
      [1],
      ['send.0: must name a file'],
    ],
    [
      withHoles(2, { 1: '.env' }),
      ['send.0: must name a file'],
    ],
  ])('judges the send %j', (send, issues) => {
    expect(lines(sendIssues(send))).toEqual(issues)
  })
})

describe('mergeLeftOut', () => {
  it('keeps the rule of a skipped file in its copy, and takes two rules of one file for two entries', () => {
    const given: LeftOutFile[] = [
      { file: 'a', reason: 'skipped', rule: 'secret' },
      { file: 'a', reason: 'skipped', rule: 'vendored' },
      { file: 'a', reason: 'skipped', rule: 'secret' },
      { file: 'a', reason: 'excluded' },
    ]
    const merged = mergeLeftOut(given, [
      { file: 'a', reason: 'binary' },
    ])
    expect(merged).toEqual([
      { file: 'a', reason: 'skipped', rule: 'secret' },
      { file: 'a', reason: 'skipped', rule: 'vendored' },
      { file: 'a', reason: 'excluded' },
      { file: 'a', reason: 'binary' },
    ])
    expect(merged[0]).not.toBe(given[0])
    expect(merged[3]).not.toHaveProperty('rule')
  })

  it('keeps a held entry\'s rule, and lists a file once per reason and rule', () => {
    const given: LeftOutFile[] = [
      { file: '.env', reason: 'secret', rule: 'name' },
      { file: '.env', reason: 'secret', rule: 'name' },
      { file: '.env', reason: 'secret', rule: 'aws-key' },
      { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
    ]
    const merged = mergeLeftOut(given, [
      { file: '.env', reason: 'secret', rule: 'name' },
      { file: '.env', reason: 'deleted-secret', rule: 'name' },
    ])
    expect(merged).toEqual([
      { file: '.env', reason: 'secret', rule: 'name' },
      { file: '.env', reason: 'secret', rule: 'aws-key' },
      { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
      { file: '.env', reason: 'deleted-secret', rule: 'name' },
    ])
    expect(merged[0]).not.toBe(given[0])
  })

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
