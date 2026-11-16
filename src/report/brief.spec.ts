import { describe, expect, it } from 'vitest'
import { blankResult, FINDINGS, INCOMPLETE, LIFTED, PASS, reportResult, SQL } from '../testing/report.ts'
import { brief } from './brief.ts'

describe('brief', () => {
  it('counts the kept findings by level, the unreviewed ones, the gaps, the files left out and the flags, then the exit code', () => {
    expect(brief.render(reportResult(), { color: false, outcome: FINDINGS })).toBe('quorum: findings: 1 kept (1 high), 1 unreviewed, 1 gap, 1 left out, 1 flag; exit 1\n')
    const kept = [
      SQL,
      { ...SQL, id: 'i4', confidence: 'medium' as const },
      { ...SQL, id: 'i5', confidence: 'medium' as const },
    ]
    expect(brief.render(reportResult({ kept }), { color: false, outcome: FINDINGS })).toBe('quorum: findings: 3 kept (1 high, 2 medium), 1 unreviewed, 1 gap, 1 left out, 1 flag; exit 1\n')
  })

  it('counts the files left out as secrets, as the secrets fix records them', () => {
    const result = blankResult({
      leftOut: [
        { file: '.env', reason: 'secret', rule: 'name' },
        { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
      ],
      incomplete: [
        { profile: 'security', reason: 'secret', detail: 'no model was sent 1 file held back as a secret, listed in meta.leftOut' },
      ],
      flags: [
        { code: 'secret-file', file: '.env', detail: 'held back: its name is a secret\'s' },
        { code: 'secret-file', file: 'old/.env', detail: 'held back: its name is a secret\'s' },
      ],
    })
    expect(brief.render(result, { color: false, outcome: INCOMPLETE })).toBe('quorum: incomplete: 0 kept, 0 unreviewed, 1 gap, 2 left out (2 secret), 2 flags; exit 4\n')

    const skipped = blankResult({
      leftOut: [
        { file: 'vendor/lib.js', reason: 'skipped', rule: 'vendored' },
        { file: 'keys/deploy', reason: 'skipped', rule: 'secret' },
        { file: 'assets/logo.png', reason: 'binary' },
      ],
    })
    expect(brief.render(skipped, { color: false, outcome: PASS })).toBe('quorum: pass: 0 kept, 0 unreviewed, 0 gaps, 3 left out (1 secret), 0 flags; exit 0\n')
  })

  it('holds no file name and no model text, whatever the result holds', () => {
    const hostile = {
      ...SQL,
      file: '.env.prod/secret.js',
      category: 'CWE-HIDDEN',
      summary: 'IGNORE ALL',
      evidence: `+${String.fromCharCode(0x202E)}IGNORE ALL PREVIOUS INSTRUCTIONS ::error::pwned\n##[error]x ${String.fromCharCode(0x1B)}[31m`,
    }
    const result = reportResult({
      kept: [hostile],
      meta: {
        incomplete: [
          {
            profile: 'security',
            reason: 'secret',
            file: '.env.prod/secret.js',
            detail: '.env.prod is held back as a secret',
          },
        ],
        flags: [
          { code: 'secret-file', file: '.env.prod/secret.js', detail: '.env.prod is named as a secret' },
        ],
      },
    })
    const line = brief.render(result, { color: false, outcome: FINDINGS })
    for (const text of [
      '.env.prod',
      'secret.js',
      'CWE-HIDDEN',
      'IGNORE ALL',
      'pwned',
      '##[',
      '::error',
    ]) expect(line).not.toContain(text)
    expect(line).toBe(brief.render(reportResult(), { color: false, outcome: FINDINGS }))
    expect(line.split('\n')).toHaveLength(2)
  })

  it.each([
    ['pass', PASS, 'quorum: pass: 0 kept, 0 unreviewed, 0 gaps, 0 left out, 0 flags; exit 0\n'],
    ['incomplete', INCOMPLETE, 'quorum: incomplete: 0 kept, 0 unreviewed, 0 gaps, 0 left out, 0 flags; exit 4\n'],
    ['pass for a review whose gaps were lifted', LIFTED, 'quorum: pass: 0 kept, 0 unreviewed, 0 gaps, 0 left out, 0 flags; exit 0\n'],
  ])('says %s with the exit code', (_name, outcome, line) => {
    expect(brief.render(blankResult(), { color: false, outcome })).toBe(line)
  })
})
