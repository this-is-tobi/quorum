import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import { hiddenLabels } from '../core/sanitize.ts'
import type { QuorumResult } from '../core/types.ts'
import { record, RESULT, RUN_SUITE } from '../testing/bench.ts'
import { parseRecord, parseRunFile, recordLine, reviewKey } from './records.ts'
import type { DeniedRecord, ResultRecord, resultSchema, RunFile } from './records.ts'

const RECORD = record()
/** `T` with no `readonly` at any depth, its optional fields still optional: the shape a JSON parse gives. */
type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T
const RUN: RunFile = {
  format: 2,
  quorum: '0.2.0',
  suite: RUN_SUITE,
  salt: 'a'.repeat(64),
  configurations: [
    {
      path: 'a.yaml',
      fingerprint: 'f'.repeat(64),
    },
    {
      path: null,
      fingerprint: 'e'.repeat(64),
    },
  ],
}

describe('recordLine', () => {
  it('writes one line of inert JSON that parses back to the record', () => {
    const line = recordLine(RECORD)
    expect(line.endsWith('\n')).toBe(true)
    expect(hiddenLabels(line.slice(0, -1))).toEqual([])
    expect(line).not.toContain('##[')
    expect(JSON.parse(line)).toEqual(RECORD)
  })
})

describe('parseRecord', () => {
  it('reads back what recordLine writes, every field of the result included', () => {
    expect(parseRecord(recordLine(RECORD).slice(0, -1))).toEqual(RECORD)
  })

  it.each<[string, string]>([
    ['text that is not JSON', '{'],
    ['an array', '[]'],
    [
      'an unknown field',
      JSON.stringify({ ...RECORD, extra: 1 }),
    ],
    [
      'an unknown field of a verdict',
      JSON.stringify({
        ...RECORD,
        result: {
          ...RESULT,
          kept: [
            { ...RESULT.kept[0], extra: 1 },
          ],
        },
      }),
    ],
    [
      'trial 0',
      JSON.stringify({ ...RECORD, trial: 0 }),
    ],
    [
      'trial 101',
      JSON.stringify({ ...RECORD, trial: 101 }),
    ],
    [
      'a short fingerprint',
      JSON.stringify({ ...RECORD, fingerprint: 'f' }),
    ],
    [
      'more failed calls than calls',
      JSON.stringify({ ...RECORD, failedCalls: 5 }),
    ],
    [
      'a case id outside the pattern',
      JSON.stringify({ ...RECORD, case: '../x' }),
    ],
    [
      'a negative latency',
      JSON.stringify({ ...RECORD, latencyMs: -1 }),
    ],
  ])('refuses %s', (_name, line) => {
    expect(parseRecord(line)).toBeUndefined()
  })
})

describe('a denied record', () => {
  const { result: _result, ...facts } = record()
  const DENIED: DeniedRecord = { ...facts, denied: 'unusable-reply' }

  it('reads back the record of a denied review, which holds no result', () => {
    expect(parseRecord(recordLine(DENIED).slice(0, -1))).toEqual(DENIED)
  })

  it.each<[string, object]>([
    [
      'a record with a result and a denial',
      {
        ...record(),
        denied: 'refusal',
      },
    ],
    [
      'a denial outside the three',
      { ...facts, denied: 'timeout' },
    ],
    ['a record with neither', facts],
  ])('refuses %s', (_name, value) => {
    expect(parseRecord(JSON.stringify(value))).toBeUndefined()
  })
})

describe('parseRecord, level by level', () => {
  const withResult = (result: object): string => JSON.stringify({ ...RECORD, result })
  const withMeta = (meta: object): string => withResult({
    ...RESULT,
    meta: {
      ...RESULT.meta,
      ...meta,
    },
  })

  it.each<[string, string]>([
    [
      'a confidence outside the three',
      withResult({
        ...RESULT,
        kept: [
          { ...RESULT.kept[0], confidence: 'certain' },
        ],
      }),
    ],
    [
      'a vote without its reasoning',
      withResult({
        ...RESULT,
        kept: [
          {
            ...RESULT.kept[0],
            votes: [
              {
                angle: 'impact',
                vote: { keep: true },
                error: null,
              },
            ],
          },
        ],
      }),
    ],
    [
      'a negative line',
      withResult({
        ...RESULT,
        kept: [
          { ...RESULT.kept[0], line: -1 },
        ],
      }),
    ],
    [
      'a result without its meta',
      withResult({ kept: [], discarded: [], unreviewed: [] }),
    ],
    [
      'an unknown field of the meta',
      withMeta({ extra: 1 }),
    ],
    [
      'a gap for a reason outside the five',
      withMeta({
        incomplete: [
          { profile: 'security', reason: 'other', detail: 'x' },
        ],
      }),
    ],
    [
      'a flag with a code outside the two',
      withMeta({
        flags: [
          { code: 'other', detail: 'x' },
        ],
      }),
    ],
    [
      'a threshold that is not a count',
      withMeta({
        profiles: {
          security: {
            ...RESULT.meta.profiles.security,
            policy: { high: 1.5, medium: null, low: null },
          },
        },
      }),
    ],
    [
      'a provider with an unknown field',
      withMeta({
        profiles: {
          security: {
            ...RESULT.meta.profiles.security,
            providers: {
              ...RESULT.meta.profiles.security.providers,
              research: { id: 'fake', model: 'm', key: 'k' },
            },
          },
        },
      }),
    ],
    [
      'a negative token count',
      JSON.stringify({
        ...RECORD,
        usage: { inputTokens: -1, outputTokens: 0 },
      }),
    ],
    [
      'usage with an unknown field',
      JSON.stringify({
        ...RECORD,
        usage: { inputTokens: 1, outputTokens: 0, extra: 1 },
      }),
    ],
    [
      'a fractional trial',
      JSON.stringify({ ...RECORD, trial: 1.5 }),
    ],
    [
      'a cost flag that is no boolean',
      JSON.stringify({ ...RECORD, costComplete: 'yes' }),
    ],
  ])('refuses %s', (_name, line) => {
    expect(parseRecord(line)).toBeUndefined()
  })

  it('reads a record without usage, and a result without verdicts', () => {
    const bare = record({
      usage: undefined,
      result: {
        ...RESULT,
        kept: [],
        discarded: [],
        unreviewed: [],
        meta: {
          ...RESULT.meta,
          usage: undefined,
          incomplete: [],
          flags: [],
        },
      },
    })
    expect(parseRecord(recordLine(bare).slice(0, -1))).toEqual(bare)
  })

  it('drops a __proto__ key of a record without letting it reach a prototype', () => {
    const line = recordLine(RECORD).replace('"profiles":{', '"profiles":{"__proto__":{"polluted":true},')
    const parsed = parseRecord(line.slice(0, -1)) as ResultRecord | undefined
    expect(parsed).toBeDefined()
    expect(Object.getPrototypeOf(parsed?.result.meta.profiles)).toBe(Object.prototype)
    expect(Object.hasOwn(parsed?.result.meta.profiles ?? {}, '__proto__')).toBe(false)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe('parseRunFile', () => {
  it('reads back a run file', () => {
    expect(parseRunFile(JSON.stringify(RUN))).toEqual(RUN)
  })

  it.each<[string, object]>([
    [
      'the format before this one',
      { ...RUN, format: 1 },
    ],
    [
      'a salt of 63 digits',
      {
        ...RUN,
        salt: 'a'.repeat(63),
      },
    ],
    [
      'no configuration',
      { ...RUN, configurations: [] },
    ],
    [
      'an unknown field',
      { ...RUN, extra: 1 },
    ],
    [
      'a review hash without its prefix',
      {
        ...RUN,
        suite: {
          ...RUN.suite,
          reviewHash: '1'.repeat(64),
        },
      },
    ],
    [
      'a run file of format 1, with its one content hash',
      {
        ...RUN,
        format: 1,
        suite: { name: 'demo', hash: `sha256:${'1'.repeat(64)}` },
      },
    ],
    [
      'a suite without the scoring hash the run began with',
      {
        ...RUN,
        suite: {
          name: RUN_SUITE.name,
          reviewHash: RUN_SUITE.reviewHash,
          scoringHash: RUN_SUITE.scoringHash,
        },
      },
    ],
    [
      'a first scoring hash without its prefix',
      {
        ...RUN,
        suite: {
          ...RUN.suite,
          firstScoringHash: '2'.repeat(64),
        },
      },
    ],
    [
      'a scoring hash in upper case',
      {
        ...RUN,
        suite: {
          ...RUN.suite,
          scoringHash: `sha256:${'A'.repeat(64)}`,
        },
      },
    ],
    [
      'a suite name with a separator',
      {
        ...RUN,
        suite: { ...RUN.suite, name: 'a/b' },
      },
    ],
    [
      'an empty quorum version',
      { ...RUN, quorum: '' },
    ],
    [
      'a quorum version of 65 characters',
      {
        ...RUN,
        quorum: '1'.repeat(65),
      },
    ],
    [
      '17 configurations',
      {
        ...RUN,
        configurations: Array.from({ length: 17 }).fill(RUN.configurations[0]),
      },
    ],
    [
      'a configuration path of 4097 characters',
      {
        ...RUN,
        configurations: [
          {
            path: 'a'.repeat(4097),
            fingerprint: 'f'.repeat(64),
          },
        ],
      },
    ],
    [
      'an empty configuration path',
      {
        ...RUN,
        configurations: [
          {
            path: '',
            fingerprint: 'f'.repeat(64),
          },
        ],
      },
    ],
    [
      'a fingerprint in upper case',
      {
        ...RUN,
        configurations: [
          {
            path: null,
            fingerprint: 'F'.repeat(64),
          },
        ],
      },
    ],
  ])('refuses %s', (_name, value) => {
    expect(parseRunFile(JSON.stringify(value))).toBeUndefined()
  })
})

describe('reviewKey', () => {
  it('is the fingerprint, the case and the trial as a JSON array', () => {
    expect(reviewKey('f', 'exec', 2)).toBe('["f","exec",2]')
  })
})

describe('resultSchema', () => {
  it('reads exactly the result the core returns, so a field the core adds or drops, optional or not, fails the typecheck', () => {
    expectTypeOf<z.output<typeof resultSchema>>().toEqualTypeOf<Mutable<QuorumResult>>()
  })

  it('drops a __proto__ key of the profiles or the lenses, value unread, and reads the rest of the record', () => {
    const line = recordLine(RECORD).slice(0, -1).replace('"profiles":{', '"profiles":{"__proto__":5,').replace('"lenses":{', '"lenses":{"__proto__":{"id":1},')
    const parsed = parseRecord(line) as ResultRecord | undefined
    expect(Object.keys(parsed?.result.meta.profiles ?? {})).toEqual(['security'])
    expect(Object.getPrototypeOf(parsed?.result.meta.profiles)).toBe(Object.prototype)
    expect(Object.keys(parsed?.result.meta.profiles.security.providers.lenses ?? {})).toEqual(['reachability', 'impact', 'defenses'])
  })
})
