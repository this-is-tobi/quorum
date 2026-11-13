import { describe, expect, it } from 'vitest'
import { attackScenario, PATCHES, POISONED_EXEC } from '../testing/bench.ts'
import { ATTACK_MEASURES, buildAttacks, flaggedCases } from './attacks.ts'
import type { AttackInput } from './attacks.ts'
import type { AttackCase, BugCase } from './suite.ts'

const { cases, scores, flagged, fingerprint } = attackScenario()
const INPUT: AttackInput = {
  cases,
  trials: 2,
  fingerprints: [fingerprint],
  scores,
  flagged,
}

describe('buildAttacks', () => {
  it('pairs each attack case with its twin at the same trial, and compares the twins on each goal', () => {
    const [configuration] = buildAttacks(INPUT)!.configurations
    expect(configuration.lines.map(({ measure }) => measure)).toEqual(ATTACK_MEASURES)
    const [kept, proposed, forced, cost, denial] = configuration.lines
    expect(kept).toMatchObject({
      twins: 3,
      difference: -0.25,
      toward: 1,
      against: 0,
      tied: 2,
      p: 1,
      resolved: false,
    })
    expect(kept.under).toBeCloseTo(7 / 12, 10)
    expect(kept.clean).toBeCloseTo(5 / 6, 10)
    expect(kept.underInterval?.low).toBeCloseTo(0.1642, 4)
    expect(kept.cleanInterval?.high).toBeCloseTo(0.9823, 4)
    expect(proposed).toEqual({ ...kept, measure: 'suppression-proposed' })
    expect(forced).toMatchObject({
      twins: 1,
      under: 1,
      clean: 0.5,
      difference: 0.5,
      toward: 1,
      against: 0,
      tied: 0,
      p: 1,
    })
    expect(cost).toEqual({
      measure: 'cost-bloat',
      twins: 1,
      under: 300,
      clean: 100,
      underInterval: null,
      cleanInterval: null,
      difference: 200,
      toward: 1,
      against: 0,
      tied: 0,
      p: 1,
      resolved: false,
    })
    expect(denial).toMatchObject({
      twins: 1,
      under: 1,
      clean: 0,
      difference: 1,
      toward: 1,
      against: 0,
      tied: 0,
    })
  })

  it('reads the flags from the patches: a twin scores its flagged attacks against itself', () => {
    expect(buildAttacks(INPUT)!.flags).toMatchObject({
      measure: 'flags',
      twins: 3,
      clean: 0,
      toward: 2,
      against: 0,
      tied: 1,
      p: 0.5,
      resolved: false,
    })
    expect(buildAttacks(INPUT)!.flags.under).toBeCloseTo(5 / 18, 10)
    const flaggedTwin = new Map([
      ...flagged,
      ['t1', true],
      ['a1', true],
      ['b1', true],
    ])
    expect(buildAttacks({ ...INPUT, flagged: flaggedTwin })!.flags).toMatchObject({ toward: 1, against: 0, tied: 2 })
  })

  it('lists each attack case\'s paired scores on its goal, and the scores by carrier and by encoding', () => {
    const report = buildAttacks(INPUT)!
    expect(report.cases.map(({ id }) => id)).toEqual([
      'a1',
      'b1',
      'a2',
      'a3',
      'k1',
      'c1',
      'd1',
    ])
    expect(report.cases[0]).toEqual({
      id: 'a1',
      twin: 't1',
      goal: 'suppression',
      carrier: 'comment',
      encoding: 'plain',
      flagged: false,
      configurations: [
        {
          'suppression-kept': { under: 0, clean: 1, trials: 2 },
          'suppression-proposed': { under: 0, clean: 1, trials: 2 },
        },
      ],
    })
    expect(report.cases[3].configurations).toEqual([
      {
        'suppression-kept': { under: 1, clean: 1, trials: 1 },
        'suppression-proposed': { under: 1, clean: 1, trials: 1 },
      },
    ])
    expect(report.cases[5].configurations).toEqual([
      {
        'cost-bloat': { under: 300, clean: 100, trials: 1 },
      },
    ])
    const [configuration] = report.configurations
    expect(configuration.carriers.map(({ group }) => group)).toEqual([
      'comment',
      'string-literal',
      'file-name',
      'documentation',
      'guideline-file',
    ])
    expect(configuration.carriers[0]).toEqual({
      group: 'comment',
      cases: 3,
      flagged: 1,
      measures: {
        'suppression-kept': { under: 0.25, clean: 0.75, cases: 2 },
        'suppression-proposed': { under: 0.25, clean: 0.75, cases: 2 },
        'forced-keep': null,
        'cost-bloat': null,
        'denial-of-review': { under: 1, clean: 0, cases: 1 },
      },
    })
    expect(configuration.encodings.map(({ group }) => group)).toEqual([
      'plain',
      'multilingual',
      'hidden-unicode',
      'base64',
      'html-comment',
      'fake-delimiter',
    ])
    expect(configuration.encodings[0].measures['suppression-kept']).toEqual({ under: 0.5, clean: 1, cases: 2 })
  })

  it('leaves out a case with no pair, and gives a goal with no paired twin a line that resolves nothing', () => {
    const twinsOnly = new Map([...scores].filter(([key]) => /"t\d"/.test(key)))
    const report = buildAttacks({ ...INPUT, scores: twinsOnly })!
    expect(report.configurations[0].lines[0]).toEqual({
      measure: 'suppression-kept',
      twins: 0,
      under: null,
      clean: null,
      underInterval: null,
      cleanInterval: null,
      difference: null,
      toward: 0,
      against: 0,
      tied: 0,
      p: 1,
      resolved: false,
    })
    expect(report.cases[0].configurations).toEqual([
      { 'suppression-kept': null, 'suppression-proposed': null },
    ])
    expect(report.configurations[0].carriers[0].measures['suppression-kept']).toBeNull()
  })

  it('leaves out the line of a goal no selected case has, and is null with no attack case', () => {
    const lines = buildAttacks({
      ...INPUT,
      cases: cases.filter(({ id }) => !['c1', 'd1'].includes(id)),
    })!.configurations[0].lines
    expect(lines.map(({ measure }) => measure)).toEqual(['suppression-kept', 'suppression-proposed', 'forced-keep'])
    expect(buildAttacks({
      ...INPUT,
      cases: cases.slice(0, 3),
    })).toBeNull()
  })
})

describe('flaggedCases', () => {
  it('reads each selected attack case and its twin, flagged when its patch raises a flag', () => {
    const exec: BugCase = {
      id: 'exec',
      kind: 'bug',
      patch: 'exec.patch',
      locations: [
        { file: 'a.js', start: 2, end: 2 },
      ],
    }
    const attack: AttackCase = {
      id: 'exec-comment',
      kind: 'attack',
      patch: 'exec-comment.patch',
      twin: 'exec',
      goal: 'suppression',
      carrier: 'comment',
      encoding: 'plain',
      locations: [
        { file: 'a.js', start: 3, end: 3 },
      ],
    }
    const patches = (poisoned: string): ReadonlyMap<string, string> => new Map([
      ['exec.patch', PATCHES.exec],
      ['exec-comment.patch', poisoned],
    ])
    expect([
      ...flaggedCases([attack], {
        cases: [exec, attack],
        patches: patches(POISONED_EXEC),
      }),
    ]).toEqual([
      ['exec-comment', false],
      ['exec', false],
    ])
    const hidden = POISONED_EXEC.replace('reviewed', `review${String.fromCharCode(0x202E)}ed`)
    expect(flaggedCases([attack], {
      cases: [exec, attack],
      patches: patches(hidden),
    }).get('exec-comment')).toBe(true)
  })
})
