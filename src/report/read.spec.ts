import { describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import { inertJson } from '../core/sanitize.ts'
import type { PublicView, QuorumResult } from '../core/types.ts'
import { VERSION } from '../core/version.ts'
import { reportResult } from '../testing/report.ts'
import { readResult, readResultWith } from './read.ts'
import { publicView } from './view.ts'

/** The main fixture, written by this release. */
function written(): QuorumResult {
  return reportResult({
    meta: { version: VERSION },
  })
}

/** The text of `value` as a saved result, its object forged by `forge` first. */
function saved(value: QuorumResult | PublicView, forge: (value: Record<string, any>) => void = () => undefined): string {
  const forged = JSON.parse(inertJson(value)) as Record<string, any>
  forge(forged)
  return JSON.stringify(forged)
}

const RELEASE = 'the result was written by another release of quorum: render it with the release that wrote it'

describe('readResult', () => {
  it('reads a result and a public view back as they were written', () => {
    const result = written()
    for (const input of [
      result,
      publicView(result),
    ]) {
      expect(readResult(inertJson(input))).toEqual(JSON.parse(inertJson(input)))
    }
  })

  it.each<[string, string, () => QuorumResult | PublicView]>([
    [
      'text that is cut off',
      'the result is not JSON',
      () => readResult('{'),
    ],
    [
      'no text',
      'the result is not JSON',
      () => readResult(''),
    ],
    [
      'a result of another release',
      RELEASE,
      () => readResult(saved(written(), (value) => {
        value.meta.version = '0.0.1'
      })),
    ],
    [
      'a profile key in capitals',
      'the result is not one quorum writes, at meta.profiles.Security',
      () => readResult(saved(written(), (value) => {
        value.meta.profiles.Security = value.meta.profiles.security
        delete value.meta.profiles.security
      })),
    ],
    [
      'a profile key that is no code word',
      'the result is not one quorum writes, at meta.profiles.*',
      () => readResult(saved(written(), (value) => {
        value.meta.profiles['x`y'] = value.meta.profiles.security
        delete value.meta.profiles.security
      })),
    ],
    [
      'a result over the cap',
      'the result is over 256 MiB, the most quorum reads',
      () => readResultWith('{}', 1),
    ],
  ])('refuses %s with %j', (_name, message, read) => {
    let caught: unknown
    try {
      read()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).issues).toEqual([
      { path: '', message },
    ])
  })

  it('names nothing of the input in a refusal', () => {
    const forgeries: Array<(value: Record<string, any>) => void> = [
      (value) => {
        value['KEY-CANARY-<b>'] = 1
      },
      (value) => {
        value.meta['KEY-CANARY-<b>'] = 'VALUE-CANARY'
      },
      (value) => {
        value.meta.profiles['KEY-CANARY-<b>'] = value.meta.profiles.security
      },
      (value) => {
        value.meta.durationMs = 'VALUE-CANARY'
      },
      (value) => {
        value.kept[0].profile = 'VALUE-CANARY'
      },
      (value) => {
        value.meta.version = 'VALUE-CANARY'
      },
    ]
    for (const forge of forgeries) {
      let message = ''
      try {
        readResult(saved(written(), forge))
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toMatch(/CANARY|<b>/)
    }
  })
})
