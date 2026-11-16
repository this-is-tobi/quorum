import { describe, expect, it } from 'vitest'
import { harness } from '../testing/cli.ts'
import { colorFor, reportPlan } from './outputs.ts'
import type { ColorWhen } from './outputs.ts'

describe('reportPlan', () => {
  const { io } = harness()

  it('writes json on stdout by default, and the format --format names', () => {
    expect(reportPlan({}, io)).toEqual({ format: 'json', color: false })
    expect(reportPlan({
      format: ['json'],
    }, io)).toEqual({ format: 'json', color: false })
    expect(reportPlan({
      format: ['brief'],
    }, io)).toEqual({ format: 'brief', color: false })
  })

  it('chooses text on a terminal and json elsewhere, unless --format names one, and colors only text', () => {
    const terminal = harness({ stdoutIsTTY: true }).io
    const pipe = harness({ stdoutIsTTY: false }).io
    expect(reportPlan({}, terminal)).toEqual({ format: 'text', color: true })
    expect(reportPlan({}, pipe)).toEqual({ format: 'json', color: false })
    expect(reportPlan({
      format: ['json'],
    }, terminal)).toEqual({ format: 'json', color: false })
    expect(reportPlan({
      format: ['brief'],
      color: ['always'],
    }, terminal)).toEqual({ format: 'brief', color: false })
    expect(reportPlan({
      format: ['json'],
      color: ['always'],
    }, terminal)).toEqual({ format: 'json', color: false })
    expect(reportPlan({
      format: ['text'],
    }, pipe)).toEqual({ format: 'text', color: false })
    expect(reportPlan({
      format: ['text'],
      color: ['always'],
    }, pipe)).toEqual({ format: 'text', color: true })
    expect(reportPlan({
      color: ['never'],
    }, terminal)).toEqual({ format: 'text', color: false })
    expect(reportPlan({
      color: ['auto'],
    }, harness({
      stdoutIsTTY: true,
      env: { NO_COLOR: '1' },
    }).io)).toEqual({ format: 'text', color: false })
  })

  it.each<[{ format?: string[], color?: string[], 'print-config'?: boolean }, string]>([
    [
      {
        format: ['xml'],
      },
      '--format: must be text, json or brief',
    ],
    [
      {
        format: ['toString'],
      },
      '--format: must be text, json or brief',
    ],
    [
      {
        format: ['json', 'brief'],
      },
      '--format: takes one format',
    ],
    [
      {
        format: ['json'],
        'print-config': true,
      },
      '--print-config: prints the config as YAML, so it takes no --format',
    ],
    [
      {
        color: ['sometimes'],
      },
      '--color: must be auto, always or never',
    ],
    [
      {
        color: ['always', 'never'],
      },
      '--color: takes one value',
    ],
  ])('refuses %j', (values, message) => {
    expect(() => reportPlan(values, io)).toThrow(expect.objectContaining({ name: 'ConfigError', message }))
  })
})

describe('colorFor', () => {
  const FORCED = harness({
    stdoutIsTTY: false,
    env: { FORCE_COLOR: '1' },
  }).io
  const CLICOLOR_FORCED = harness({
    stdoutIsTTY: false,
    env: { CLICOLOR_FORCE: '1' },
  }).io

  it.each<[ColorWhen, string, () => boolean, boolean]>([
    [
      'auto',
      'a terminal, NO_COLOR unset',
      () => colorFor('auto', true, undefined),
      true,
    ],
    [
      'auto',
      'a terminal, NO_COLOR empty',
      () => colorFor('auto', true, ''),
      true,
    ],
    [
      'auto',
      'a terminal, NO_COLOR 1',
      () => colorFor('auto', true, '1'),
      false,
    ],
    [
      'auto',
      'a terminal, NO_COLOR 0',
      () => colorFor('auto', true, '0'),
      false,
    ],
    [
      'auto',
      'a pipe',
      () => colorFor('auto', undefined, undefined),
      false,
    ],
    [
      'always',
      'a pipe, NO_COLOR 1',
      () => colorFor('always', undefined, '1'),
      true,
    ],
    [
      'never',
      'a terminal',
      () => colorFor('never', true, undefined),
      false,
    ],
    [
      'auto',
      'a pipe, FORCE_COLOR=1, which no run reads',
      () => reportPlan({
        format: ['text'],
      }, FORCED).color,
      false,
    ],
    [
      'auto',
      'a pipe, CLICOLOR_FORCE=1, which no run reads',
      () => reportPlan({
        format: ['text'],
      }, CLICOLOR_FORCED).color,
      false,
    ],
  ])('colors %s: %s', (_when, _situation, colored, expected) => {
    expect(colored()).toBe(expected)
  })
})
