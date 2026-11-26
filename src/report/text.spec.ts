import { describe, expect, it } from 'vitest'
import type { Outcome } from '../core/outcome.ts'
import type { Flag, IncompleteEntry, LeftOutFile, PublicView, QuorumResult, ResearchRecord, ReviewSource, RoleCalls, Verdict } from '../core/types.ts'
import { blankResult, contextDocument, FINDINGS, INCOMPLETE, INTERRUPTED, LIFTED, PASS, reportMeta, reportResult, SERVED_AS_TWO, SQL, TOKEN } from '../testing/report.ts'
import { documentLine } from './lines.ts'
import { text } from './text.ts'
import { publicView } from './view.ts'

const ESC = String.fromCharCode(0x1B)
const RLO = String.fromCharCode(0x202E)
const BEL = String.fromCharCode(7)

/** The head of the fixture's range, a commit whose id starts `7b2e4d0`. */
const HEAD = '7b2e4d0'.padEnd(40, 'a')

/** The sequences quorum writes: ESC `[`, one of the codes of the SGR table, `m`, and the reset. */
const QUORUM_SEQUENCE = new RegExp(`${ESC}\\[(?:1;31|33|36|35|1|32|31|0)m`, 'g')

/** The text report of a result as its lines, the last one the empty text after the final line feed. */
function render(result: QuorumResult | PublicView, outcome: Outcome = FINDINGS, color = false): string[] {
  return text.render(result, { color, outcome }).split('\n')
}

/** The result of one kept finding, `SQL` with `changes`, and nothing else to find. */
function keeping(changes: Partial<Verdict>): QuorumResult {
  return reportResult({
    kept: [
      {
        ...SQL,
        ...changes,
      },
    ],
    unreviewed: [],
  })
}

/** The result of one kept finding like `keeping`'s, but with no `evidenceRow` at all, as a result recorded before it has none. */
function keepingWithoutRow(changes: Partial<Verdict>): QuorumResult {
  const { evidenceRow: _fixture, ...withoutRow } = SQL
  return reportResult({
    kept: [
      {
        ...withoutRow,
        ...changes,
      },
    ],
    unreviewed: [],
  })
}

/** The lines of the evidence a kept finding shows: those between its claim, one line, and its votes. */
function rowsShown(evidence: string, evidenceRow: number | undefined, line: number): string[] {
  const lines = render(evidenceRow === undefined
    ? keepingWithoutRow({ evidence, line })
    : keeping({ evidence, line, evidenceRow }))
  return lines.slice(4, lines.indexOf('  kept by 3 of 3 lenses'))
}

const MAIN = [
  'quorum 0.6.0 · range 1f3a9c2...7b2e4d0 · security · 3 files',
  '',
  'HIGH  security  src/auth/login.ts:42  CWE-89',
  '  SQL built from the request\'s id parameter reaches db.query',
  '      41   const sql = \'SELECT * FROM users WHERE id = \' + id',
  '   >  42 + db.query(sql)',
  '      43   return rows',
  '  kept by 3 of 3 lenses',
  '',
  'UNREVIEWED  security  src/session.js:20  CWE-338',
  '  Session tokens come from Math.random, which is not a cryptographic generator.',
  '         -   return crypto.randomBytes(32).toString(\'hex\')',
  '   >  20 +   return Math.random().toString(36).slice(2)',
  '      21   }',
  '  kept by 1 of 3 lenses, 1 vote failed: a network error',
  '',
  'security (fail-on high): 1 kept, 1 unreviewed, 1 discarded',
  '  1 of 3 files reviewed, 1 in part, 1 not',
  '  research: 1 part(s), 3 finding(s) listed, 3 to the panel',
  'left out: 1 file',
  '  "assets/logo.png" (binary)',
  'gap: security binary, the diff carries no content for 1 binary file(s), listed',
  '  in meta.leftOut',
  'flag: hidden-characters at "src/session.js":20, U+202E on 1 added line(s)',
  'took 41s, 48.1k tokens in and 4.19k out',
  'exit 1, findings: a gating profile kept a finding at or above its fail-on level',
  '',
]

/** The hostile finding: a bidirectional override and an escape sequence in the name and the category, workflow commands in the claim and the row. */
function hostile(): QuorumResult {
  return keeping({
    file: `src/${RLO}x.js`,
    category: `CWE-${ESC}[2J`,
    summary: '::error::forged ##[add-mask]e and more',
    evidence: ` a()\n+run(${ESC}]8;;x${BEL})\n ::warning::x`,
  })
}

const HELD = 'named as a secret, so no model was sent any of it: check that it belongs in the change'
const DELETED = 'deletes a file named as a secret, so no model was sent any of it: the history still holds the file, so rotate what it held'

/** What the secrets fix records for a held file, a reviewed one and a deleted secret, on the staged changes. */
function secrets(): QuorumResult {
  return blankResult({
    durationMs: 1234,
    source: { kind: 'staged', head: HEAD, objectFormat: 'sha1' },
    profiles: {
      security: {
        ...reportResult().meta.profiles.security,
        coverage: [
          { file: '.env', status: 'unreviewed', reason: 'secret' },
          { file: 'a.js', status: 'reviewed' },
          { file: 'old/.env', status: 'unreviewed', reason: 'deleted-secret' },
        ],
      },
    },
    incomplete: [
      { profile: 'security', reason: 'secret', detail: 'no model was sent 1 file(s) held as secrets, listed in meta.leftOut' },
    ],
    leftOut: [
      { file: '.env', reason: 'secret', rule: 'name' },
      { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
    ],
    flags: [
      { code: 'secret-file', file: '.env', detail: HELD },
      { code: 'secret-file', file: 'old/.env', detail: DELETED },
    ],
  })
}

/** The documents of two profiles: one over 80 columns with a cleaner clause, which wraps, one missing and one that fits. */
const DOCUMENTS = [
  contextDocument({
    origin: 'repository',
    path: 'docs/threat-model.md',
    commit: '1f3a9c2'.padEnd(40, 'a'),
    sha256: 'a'.repeat(64),
  }),
  contextDocument({
    profile: 'naming',
    origin: 'config',
    sha256: '3f2a9c1d0b7e'.padEnd(64, '0'),
    bytes: 4100,
    removed: { characters: 3, comments: 1, entities: 0 },
  }),
  contextDocument({
    profile: 'naming',
    kind: 'do-not-report',
    origin: 'repository',
    path: 'REVIEW-skip.md',
    commit: '1f3a9c2'.padEnd(40, 'a'),
    status: 'missing',
    bytes: 0,
  }),
]

describe('text', () => {
  it('renders a review for a person: the header, each finding with its numbered evidence, the profiles, what was left out, the gaps, the flags, the time and the outcome', () => {
    expect(render(reportResult())).toEqual(MAIN)
  })

  it('renders a public view as the result, but each gap in fixed words and the time with no token count', () => {
    const lines = render(publicView(reportResult()))
    expect(lines).toEqual(MAIN.filter(line => line !== '  in meta.leftOut' && !line.startsWith('  research: ')).map(line => line.startsWith('gap: ')
      ? 'gap: security binary, the diff carries no content for a binary file'
      : line.startsWith('took ')
        ? 'took 41s'
        : line))

    const held = blankResult({
      incomplete: [
        {
          profile: 'security',
          reason: 'vote-failed',
          file: 'a b.js',
          detail: 'DETAIL-CANARY',
        },
      ],
    })
    expect(render(publicView(held)).filter(line => line.startsWith('gap: ') || line.startsWith('  finding'))).toEqual([
      'gap: security vote-failed at "a b.js", a failed vote could have raised a kept',
      '  finding\'s level',
    ])
  })

  it('writes the models lines after the by-role line, which follows the time line, of a full result, wrapped at 80 columns, and none for the public view', () => {
    const base = reportMeta()
    const result = reportResult({
      meta: {
        calls: {
          ...SERVED_AS_TWO,
          q: {
            model: 'local-model',
            served: [
              { model: 'local-model-2026', calls: 4 },
            ],
          },
        },
        profiles: {
          security: {
            ...base.profiles.security,
            stages: { research: 250_000, dedup: 3000, panel: 1_805_000 },
          },
        },
      },
    })
    const lines = render(result)
    const took = lines.findIndex(line => line.startsWith('took '))
    expect(lines.slice(took, took + 7)).toEqual([
      'took 41s, 48.1k tokens in and 4.19k out',
      'by role: research 4m10s, 3 call(s), 40.0k tokens in and 3.00k out; panel 30m05s,',
      '  2 vote(s), 8.12k in and 1.19k out',
      'models: q answered as local-model-2026, its config names local-model',
      'warning: p answered as 2 models in this review: local-model-2026 in 3 call(s),',
      '  local-model-2027 in 2',
      'exit 1, findings: a gating profile kept a finding at or above its fail-on level',
    ])
    // The rest of the report is the one a result with no record writes.
    expect(lines.filter((line, index) => index < took + 1 || index > took + 5)).toEqual(MAIN)
    // The public view names no model, so it writes none of these lines.
    const view = render(publicView(result))
    expect(view.some(line => line.startsWith('models:') || line.startsWith('warning:'))).toBe(false)
    expect(view.join('\n')).not.toContain('local-model')
    // A result whose providers answered as their own models writes none.
    expect(render(reportResult({
      meta: {
        calls: {
          p: {
            model: 'm',
            served: [
              { model: 'm', calls: 5 },
            ],
          },
        },
      },
    }))).toEqual(MAIN)
  })

  it('writes the by-role line after the time line, in the full and the public view', () => {
    const base = reportMeta()
    const result = reportResult({
      meta: {
        calls: {
          p: {
            ...SERVED_AS_TWO.p,
            served: [
              { model: 'm', calls: 5 },
            ],
          },
        },
        profiles: {
          security: {
            ...base.profiles.security,
            stages: { research: 250_000, dedup: 3000, panel: 1_805_000 },
          },
        },
      },
    })
    const lines = render(result)
    const took = lines.findIndex(line => line.startsWith('took '))
    // The full result gives each role's calls and tokens, wrapped at 80 columns; the report is otherwise the one a result with no stage time writes.
    expect(lines.slice(took, took + 4)).toEqual([
      'took 41s, 48.1k tokens in and 4.19k out',
      'by role: research 4m10s, 3 call(s), 40.0k tokens in and 3.00k out; panel 30m05s,',
      '  2 vote(s), 8.12k in and 1.19k out',
      'exit 1, findings: a gating profile kept a finding at or above its fail-on level',
    ])
    expect(lines.filter((line, index) => index < took + 1 || index > took + 2)).toEqual(MAIN)
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(80)
    // The public view has the times alone: the view withholds the calls and the tokens.
    const view = render(publicView(result))
    const viewTook = view.findIndex(line => line.startsWith('took '))
    expect(view.slice(viewTook, viewTook + 3)).toEqual([
      'took 41s',
      'by role: research 4m10s; panel 30m05s',
      'exit 1, findings: a gating profile kept a finding at or above its fail-on level',
    ])
    expect(view.join('\n')).not.toContain('call(s)')
    expect(view.join('\n')).not.toContain('tokens in')
    // A role whose calls reported no usage has its time and its calls, and no tokens, which would read as a spend of zero.
    const unreported = (role: 'research' | 'vote'): RoleCalls => ({
      ...SERVED_AS_TWO.p[role]!,
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    const silent = render(reportResult({
      meta: {
        calls: {
          p: {
            ...SERVED_AS_TWO.p,
            served: [
              { model: 'm', calls: 5 },
            ],
            research: unreported('research'),
            vote: unreported('vote'),
          },
        },
        profiles: {
          security: {
            ...base.profiles.security,
            stages: { research: 250_000, dedup: 3000, panel: 1_805_000 },
          },
        },
      },
    }))
    expect(silent.filter(line => line.startsWith('by role:'))).toEqual(['by role: research 4m10s, 3 call(s); panel 30m05s, 2 vote(s)'])
    // A result with no stage time, as a blank diff's, writes none.
    expect(render(blankResult()).some(line => line.startsWith('by role:'))).toBe(false)
    expect(render(publicView(blankResult())).some(line => line.startsWith('by role:'))).toBe(false)
  })

  it('writes a served model as inert text, whatever a result read from a file holds', () => {
    const hostile = `a${RLO}b ${ESC}[2J ##[add-mask]x`
    const lines = render(reportResult({
      meta: {
        calls: {
          p: {
            model: 'm',
            served: [
              { model: hostile, calls: 5 },
            ],
          },
        },
      },
    }), FINDINGS, true)
    const written = lines.filter(line => line.startsWith('models:'))
    expect(written).toHaveLength(1)
    expect(written[0]).not.toContain(RLO)
    expect(written[0]).not.toContain(ESC)
    expect(written[0]).not.toContain('##[')
  })

  it('says where the finder cited a moved finding, right under its head', () => {
    const moved = keeping({ line: 30, citedLine: 11 })
    expect(render(moved).slice(2, 5)).toEqual([
      'HIGH  security  src/auth/login.ts:30  CWE-89',
      '  cited at line 11; its quote is at 30',
      '  SQL built from the request\'s id parameter reaches db.query',
    ])
    expect(render(publicView(moved)).slice(3, 4)).toEqual(['  cited at line 11; its quote is at 30'])
    expect(render(keeping({ line: 30 }))).not.toContain('  cited at line 11; its quote is at 30')
    expect(render(reportResult()).some(line => line.includes('cited at line'))).toBe(false)
  })

  it('marks the cited row and numbers the + and context rows from the cited line, never a - row', () => {
    expect(rowsShown('+a()\n+b()\n c()', 0, 9)).toEqual([
      '   >   9 + a()',
      '      10 + b()',
      '      11   c()',
    ])
    expect(rowsShown(' a\n-b\n b2\n c\n+d', 4, 100)).toEqual([
      '       97   a',
      '          - b',
      '       98   b2',
      '       99   c',
      '   >  100 + d',
    ])
  })

  it('shows the rows unmarked and unnumbered when evidenceRow is absent, out of range, or names a - row', () => {
    const unmarked = [
      '       - gone()',
      '       - alsoGone()',
    ]
    expect(rowsShown('-gone()\n-alsoGone()', undefined, 5)).toEqual(unmarked)
    expect(rowsShown('-gone()\n-alsoGone()', 7, 5)).toEqual(unmarked)
    expect(rowsShown('-gone()\n-alsoGone()', 0, 5)).toEqual(unmarked)
  })

  it('breaks a leading :: of a context row when no evidenceRow numbers the rows, and prints it uncolored', () => {
    const broken = [
      '         <U+003A>:warning::x',
    ]
    expect(rowsShown(' ::warning::x', undefined, 5)).toEqual(broken)
    const colored = render(keepingWithoutRow({ evidence: ' ::warning::x', line: 5 }), FINDINGS, true).slice(4, 5)
    expect(colored).toEqual(broken)
    expect(colored.join('')).not.toContain(ESC)
  })

  it('shows a tab in a row of code as four spaces', () => {
    expect(rowsShown('+\tif (x) {\n+\t\treturn y', 1, 7)).toEqual([
      '      6 +     if (x) {',
      '   >  7 +         return y',
    ])
  })

  it('groups the findings by file, then by line, kept and unreviewed together', () => {
    const result = reportResult({
      kept: [
        { ...SQL, file: 'b.js', line: 9 },
        { ...SQL, file: 'a.js', line: 5 },
      ],
      unreviewed: [
        { ...TOKEN, file: 'a.js', line: 2 },
      ],
    })
    expect(render(result).filter(line => line.includes('  security  '))).toEqual([
      'UNREVIEWED  security  a.js:2  CWE-338',
      'HIGH  security  a.js:5  CWE-89',
      'HIGH  security  b.js:9  CWE-89',
    ])
  })

  it('quotes a path that holds a space or a colon, so it cannot pass for the columns after it', () => {
    const headOf = (file: string): string => render(keeping({ file }))[2]
    expect(headOf('src/my file.ts')).toBe('HIGH  security  "src/my file.ts":42  CWE-89')
    expect(headOf('a.js:1  LOW  x')).toBe('HIGH  security  "a.js:1  LOW  x":42  CWE-89')
    expect(headOf('lib/x-y_z@2.js')).toBe('HIGH  security  lib/x-y_z@2.js:42  CWE-89')
  })

  it('wraps a claim at 80 columns, never cutting a word, a path or a row', () => {
    const url = 'https://example.com/a/very/long/path/that/never/fits/within/eighty/columns/at/all/so/it/stays/whole'
    const summary = `This claim is long enough that it must wrap at eighty columns, and it holds a word longer than any line: ${url} and then it goes on.`
    const lines = render(keeping({ summary }))
    expect(lines.slice(3, 7)).toEqual([
      '  This claim is long enough that it must wrap at eighty columns, and it holds a',
      '  word longer than any line:',
      `  ${url}`,
      '  and then it goes on.',
    ])
    expect(lines[7]).toBe('      41   const sql = \'SELECT * FROM users WHERE id = \' + id')
  })

  it('renders a hostile file name, category, claim and row inert: hidden characters, escape sequences, :: and ##[', () => {
    const lines = render(hostile())
    expect(lines.slice(2, 8)).toEqual([
      'HIGH  security  "src/<U+202E>x.js":42  CWE-<U+001B>[2J',
      '  <U+003A>:error::forged ##<U+005B>add-mask]e and more',
      '      41   a()',
      '   >  42 + run(<U+001B>]8;;x<U+0007>)',
      '      43   ::warning::x',
      '  kept by 3 of 3 lenses',
    ])
    for (const character of [ESC, BEL, RLO]) expect(lines.join('\n')).not.toContain(character)
  })

  it('colors the level, the location, the cited row\'s marker, a row\'s + or -, and the status word, and nothing else', () => {
    const plain = render(reportResult())
    expect(render(reportResult(), FINDINGS, true)).toEqual(plain.map((line, index) => ({
      2: `${ESC}[1;31mHIGH${ESC}[0m  security  ${ESC}[1msrc/auth/login.ts:42${ESC}[0m  CWE-89`,
      5: `   ${ESC}[1m>${ESC}[0m  42 ${ESC}[32m+${ESC}[0m db.query(sql)`,
      9: `${ESC}[35mUNREVIEWED${ESC}[0m  security  ${ESC}[1msrc/session.js:20${ESC}[0m  CWE-338`,
      11: `         ${ESC}[31m-${ESC}[0m   return crypto.randomBytes(32).toString('hex')`,
      12: `   ${ESC}[1m>${ESC}[0m  20 ${ESC}[32m+${ESC}[0m   return Math.random().toString(36).slice(2)`,
      25: `exit 1, ${ESC}[31mfindings${ESC}[0m: a gating profile kept a finding at or above its fail-on level`,
    })[index] ?? line))
  })

  it('colors the level word of each confidence, and the status word of each outcome', () => {
    const medium = render(keeping({ confidence: 'medium' }), FINDINGS, true)
    const low = render(keeping({ confidence: 'low' }), FINDINGS, true)
    expect(medium[2]).toBe(`${ESC}[33mMEDIUM${ESC}[0m  security  ${ESC}[1msrc/auth/login.ts:42${ESC}[0m  CWE-89`)
    expect(low[2]).toBe(`${ESC}[36mLOW${ESC}[0m  security  ${ESC}[1msrc/auth/login.ts:42${ESC}[0m  CWE-89`)
    expect(render(blankResult(), INCOMPLETE, true).at(-2)).toBe(`exit 4, ${ESC}[33mincomplete${ESC}[0m: a gating profile has a gap or an unreviewed finding`)
    expect(render(blankResult(), PASS, true).at(-2)).toBe(`exit 0, ${ESC}[32mpass${ESC}[0m: no gating profile kept a finding to fail on, and none has a gap`)
  })

  it('prints a line uncolored when the workflow-command rules change it, and no escape sequence but its own', () => {
    const row = render(keeping({ evidence: '+x ##[group]', evidenceRow: 0 }), FINDINGS, true)
    expect(row[4]).toBe('   >  42 + x ##<U+005B>group]')

    const colored = render(hostile(), FINDINGS, true).join('\n')
    expect(colored).toContain(`${ESC}[1;31mHIGH${ESC}[0m`)
    expect(colored.replace(QUORUM_SEQUENCE, '')).not.toContain(ESC)
  })

  it('lists a file held as a secret, its secret gap and its secret-file flags, as the secrets fix records them', () => {
    expect(render(secrets(), INCOMPLETE)).toEqual([
      'quorum 0.6.0 · staged on 7b2e4d0 · security · 3 files',
      '',
      'security (fail-on high): 0 kept, 0 unreviewed, 0 discarded',
      '  1 of 3 files reviewed, 2 not',
      '  research: 1 part(s), 3 finding(s) listed, 3 to the panel',
      'left out: 2 files',
      '  ".env" (secret: name)',
      '  "old/.env" (deleted-secret: name)',
      'gap: security secret, no model was sent 1 file(s) held as secrets, listed in',
      '  meta.leftOut',
      'flag: secret-file at ".env", named as a secret, so no model was sent any of it:',
      '  check that it belongs in the change',
      'flag: secret-file at "old/.env", deletes a file named as a secret, so no model',
      '  was sent any of it: the history still holds the file, so rotate what it held',
      'took 1.2s, no token count reported',
      'exit 4, incomplete: a gating profile has a gap or an unreviewed finding',
      '',
    ])
  })

  it('lists five files left out, then how many more', () => {
    const leftOut: LeftOutFile[] = Array.from({ length: 7 }, (_, index) => ({ file: `f${index}.bin`, reason: 'binary' }))
    expect(render(blankResult({ leftOut }), PASS).slice(5, 12)).toEqual([
      'left out: 7 files',
      '  "f0.bin" (binary)',
      '  "f1.bin" (binary)',
      '  "f2.bin" (binary)',
      '  "f3.bin" (binary)',
      '  "f4.bin" (binary)',
      '  and 2 more',
    ])
  })

  it('prints each profile\'s level, counts and coverage, in run order, with the findings outside the diff', () => {
    const { security } = reportResult().meta.profiles
    const result = reportResult({
      meta: {
        profiles: {
          security,
          team: {
            ...security,
            failOn: 'none',
            gating: false,
            invalidFindings: 2,
            coverage: [
              { file: 'a.js', status: 'reviewed' },
              { file: 'b.js', status: 'reviewed' },
              { file: 'c.js', status: 'excluded' },
            ],
          },
        },
      },
    })
    const lines = render(result)
    expect(lines[0]).toBe('quorum 0.6.0 · range 1f3a9c2...7b2e4d0 · security, team · 3 files')
    expect(lines.slice(16, 22)).toEqual([
      'security (fail-on high): 1 kept, 1 unreviewed, 1 discarded',
      '  1 of 3 files reviewed, 1 in part, 1 not',
      '  research: 1 part(s), 3 finding(s) listed, 3 to the panel',
      'team (fail-on none): 0 kept, 0 unreviewed, 0 discarded, 2 outside the diff',
      '  2 of 3 files reviewed, 1 excluded',
      '  research: 1 part(s), 3 finding(s) listed, 3 to the panel',
    ])
  })

  it('writes each profile\'s research counts under its coverage, the cap\'s and the saturated replies\' only when above 0', () => {
    const { security } = reportResult().meta.profiles
    const counted = (research: ResearchRecord): QuorumResult => reportResult({
      meta: {
        profiles: {
          security: { ...security, research },
        },
      },
    })
    /** The lines between the coverage of `security` and what follows its profiles. */
    const researchOf = (result: QuorumResult | PublicView): string[] => {
      const lines = render(result)
      return lines.slice(18, lines.indexOf('left out: 1 file'))
    }
    expect(render(counted({
      parts: 3,
      listed: 5,
      panel: 3,
      capped: 2,
      saturated: 0,
    })).slice(16, 19)).toEqual([
      'security (fail-on high): 1 kept, 1 unreviewed, 1 discarded',
      '  1 of 3 files reviewed, 1 in part, 1 not',
      '  research: 3 part(s), 5 finding(s) listed, 3 to the panel, 2 past the cap',
    ])
    expect(researchOf(counted({
      parts: 3,
      listed: 5,
      panel: 5,
      capped: 0,
      saturated: 1,
    }))).toEqual([
      '  research: 3 part(s), 5 finding(s) listed, 5 to the panel, 1 reply(ies) listed',
      '  all they were asked for',
    ])
    expect(researchOf(counted({
      parts: 3,
      listed: 5,
      panel: 3,
      capped: 2,
      saturated: 1,
    }))).toEqual([
      '  research: 3 part(s), 5 finding(s) listed, 3 to the panel, 2 past the cap, 1',
      '  reply(ies) listed all they were asked for',
    ])
    // The line wraps at 80 columns at spaces, a continuation indented by two spaces, and joined back it is the line `researchWords` writes.
    const wrapped = researchOf(counted({
      parts: 3,
      listed: 5,
      panel: 3,
      capped: 2,
      saturated: 1,
    }))
    for (const line of wrapped) expect([...line].length).toBeLessThanOrEqual(80)
    expect(wrapped.length).toBeGreaterThan(1)
    expect(wrapped.map((line, index) => index === 0
      ? line
      : line.trim()).join(' ')).toBe('  research: 3 part(s), 5 finding(s) listed, 3 to the panel, 2 past the cap, 1 reply(ies) listed all they were asked for')
    expect(researchOf(counted({
      parts: 0,
      listed: 0,
      panel: 0,
      capped: 0,
      saturated: 0,
    }))).toEqual([
      '  research: 0 part(s), 0 finding(s) listed, 0 to the panel',
    ])
    // Each profile has its own, under its own coverage.
    const two = reportResult({
      meta: {
        profiles: {
          security,
          team: {
            ...security,
            research: {
              parts: 4,
              listed: 9,
              panel: 6,
              capped: 3,
              saturated: 0,
            },
          },
        },
      },
    })
    expect(render(two).slice(16, 22)).toEqual([
      'security (fail-on high): 1 kept, 1 unreviewed, 1 discarded',
      '  1 of 3 files reviewed, 1 in part, 1 not',
      '  research: 1 part(s), 3 finding(s) listed, 3 to the panel',
      'team (fail-on high): 0 kept, 0 unreviewed, 0 discarded',
      '  1 of 3 files reviewed, 1 in part, 1 not',
      '  research: 4 part(s), 9 finding(s) listed, 6 to the panel, 3 past the cap',
    ])
    // A public view holds none, so its report has no such line.
    expect(researchOf(publicView(counted({
      parts: 3,
      listed: 5,
      panel: 3,
      capped: 2,
      saturated: 1,
    })))).toEqual([])
    expect(render(publicView(two)).filter(line => line.includes('research'))).toEqual([])
  })

  it('ends a finding\'s head with its rule, and a profile\'s line with its rules and refused citations', () => {
    const { security } = reportResult().meta.profiles
    const ruled = (rules: { listed: number, sent: number }, invalidRules: number): QuorumResult => reportResult({
      kept: [
        { ...SQL, rule: 'tests-for-new-code' },
      ],
      meta: {
        profiles: {
          security: { ...security, rules, invalidRules },
        },
      },
    })
    const lines = render(ruled({ listed: 5, sent: 3 }, 1))
    expect(lines[2]).toBe('HIGH  security  src/auth/login.ts:42  CWE-89  rule tests-for-new-code')
    expect(lines.slice(16, 19)).toEqual([
      'security (fail-on high): 1 kept, 1 unreviewed, 1 discarded; rules: 3 of 5 sent,',
      '  1 citation(s) refused',
      '  1 of 3 files reviewed, 1 in part, 1 not',
    ])
    // Joined back at its wrap, the line is the one `; rules: <sent> of <listed> sent, <k> citation(s) refused` ends.
    expect(`${lines[16]} ${lines[17].trim()}`).toBe('security (fail-on high): 1 kept, 1 unreviewed, 1 discarded; rules: 3 of 5 sent, 1 citation(s) refused')
    // The citations refused come last, only when there are some; the line of a profile that has none refused ends at its rules.
    expect(render(ruled({ listed: 5, sent: 3 }, 0))[16]).toBe('security (fail-on high): 1 kept, 1 unreviewed, 1 discarded; rules: 3 of 5 sent')
    expect(render(ruled({ listed: 2, sent: 0 }, 2)).slice(16, 18)).toEqual([
      'security (fail-on high): 1 kept, 1 unreviewed, 1 discarded; rules: 0 of 2 sent,',
      '  2 citation(s) refused',
    ])
    // The outside-the-diff count stays where it was, before the rules: the two never merge.
    const both = reportResult({
      meta: {
        profiles: {
          team: {
            ...security,
            failOn: 'none',
            gating: false,
            invalidFindings: 2,
            rules: { listed: 1, sent: 1 },
            invalidRules: 1,
          },
        },
      },
    })
    expect(render(both).filter(line => line.startsWith('team ') || line.startsWith('  rules:'))).toEqual([
      'team (fail-on none): 0 kept, 0 unreviewed, 0 discarded, 2 outside the diff;',
      '  rules: 1 of 1 sent, 1 citation(s) refused',
    ])
    // The public view says the same, its counts being its own.
    expect(render(publicView(ruled({ listed: 5, sent: 3 }, 1))).slice(2, 3)).toEqual(['HIGH  security  src/auth/login.ts:42  CWE-89  rule tests-for-new-code'])
    expect(render(publicView(ruled({ listed: 5, sent: 3 }, 1))).slice(16, 18)).toEqual(lines.slice(16, 18))
    // Every line of it stays within 80 columns: a path and a category never cut are the only ones that pass it.
    for (const line of lines.filter(entry => !entry.startsWith('HIGH'))) expect([...line].length).toBeLessThanOrEqual(80)
    // A colored head keeps the rule uncolored, after the category.
    const colored = render(ruled({ listed: 5, sent: 3 }, 1), FINDINGS, true)[2]
    expect(colored.replaceAll(QUORUM_SEQUENCE, '')).toBe(lines[2])
    expect(colored.endsWith('  CWE-89  rule tests-for-new-code')).toBe(true)
  })

  it('says a changed-lines profile\'s findings away from the change on its line, after those outside the diff', () => {
    const { security } = reportResult().meta.profiles
    const watching = (changes: Partial<typeof security>): QuorumResult => reportResult({
      meta: {
        profiles: {
          security,
          naming: {
            ...security,
            failOn: 'none',
            gating: false,
            ...changes,
          },
        },
      },
    })
    /** The line of the profile `naming`, wrapped at 80 columns, joined back: its head up to the coverage line. */
    const lineOf = (result: QuorumResult | PublicView): string => {
      const lines = render(result)
      const at = lines.findIndex(line => line.startsWith('naming ('))
      const end = lines.findIndex((line, index) => index > at && line.startsWith('  1 of 3 files'))
      return lines.slice(at, end).map((line, index) => index === 0
        ? line
        : line.trim()).join(' ')
    }
    const both = watching({ invalidFindings: 1, awayFromChange: 2 })
    expect(lineOf(both)).toBe('naming (fail-on none): 0 kept, 0 unreviewed, 0 discarded, 1 outside the diff, 2 away from the changed lines')
    // The count of its own, with none outside the diff, and the line the public view writes of it.
    expect(lineOf(watching({ awayFromChange: 1 }))).toBe('naming (fail-on none): 0 kept, 0 unreviewed, 0 discarded, 1 away from the changed lines')
    expect(lineOf(publicView(both))).toBe(lineOf(both))
    // It comes before the rules clause, and the two never merge.
    expect(lineOf(watching({
      awayFromChange: 2,
      rules: { listed: 1, sent: 1 },
      invalidRules: 1,
    }))).toBe('naming (fail-on none): 0 kept, 0 unreviewed, 0 discarded, 2 away from the changed lines; rules: 1 of 1 sent, 1 citation(s) refused')
    // A count of 0, and a profile with none, add nothing to the line, so a report of a profile that does not review changed lines only is unchanged.
    expect(lineOf(watching({ awayFromChange: 0 }))).toBe('naming (fail-on none): 0 kept, 0 unreviewed, 0 discarded')
    expect(lineOf(watching({}))).toBe('naming (fail-on none): 0 kept, 0 unreviewed, 0 discarded')
    expect(render(reportResult()).join('\n')).not.toContain('away from')
    // Every line stays within 80 columns.
    for (const line of render(both)) expect([...line].length).toBeLessThanOrEqual(80)
  })

  it('says on the line of a profile that asked nothing that its research asks nothing, whether it lists rules or none, and on no other profile\'s', () => {
    const { security } = reportResult().meta.profiles
    /** A review of one file whose profile `asksNothing`: it requires a rule and was sent none, so nothing was found and every file reads as reviewed. */
    const asked = (rules: { listed: number, sent: number }): QuorumResult => blankResult({
      profiles: {
        security: {
          ...security,
          rules,
          asksNothing: true,
          coverage: [
            { file: 'a.js', status: 'reviewed' },
          ],
        },
      },
    })
    // It requires a rule and lists none.
    expect(render(asked({ listed: 0, sent: 0 }), PASS).slice(2, 5)).toEqual([
      'security (fail-on high): 0 kept, 0 unreviewed, 0 discarded; rules: 0 of 0 sent,',
      '  so its research asks nothing',
      '  1 of 1 file reviewed',
    ])
    // It lists rules and none applies to the change.
    expect(render(asked({ listed: 5, sent: 0 }), PASS).slice(2, 5)).toEqual([
      'security (fail-on high): 0 kept, 0 unreviewed, 0 discarded; rules: 0 of 5 sent,',
      '  so its research asks nothing',
      '  1 of 1 file reviewed',
    ])
    // The public view, which `quorum report` writes a saved result by, says the same, and every line stays within 80 columns.
    expect(render(publicView(asked({ listed: 0, sent: 0 })), PASS).slice(0, 5)).toEqual(render(asked({ listed: 0, sent: 0 }), PASS).slice(0, 5))
    for (const line of render(asked({ listed: 5, sent: 0 }), PASS)) expect([...line].length).toBeLessThanOrEqual(80)
    // A profile that lists no rule and requires none says nothing of rules, and one that lists rules and was sent some says no more than it did.
    expect(render(blankResult(), PASS)[2]).toBe('security (fail-on high): 0 kept, 0 unreviewed, 0 discarded')
    expect(render(blankResult({
      profiles: {
        security: {
          ...security,
          rules: { listed: 5, sent: 3 },
          coverage: [],
        },
      },
    }), PASS)[2]).toBe('security (fail-on high): 0 kept, 0 unreviewed, 0 discarded; rules: 3 of 5 sent')
    expect(render(reportResult())).toEqual(MAIN)
  })

  it('writes no rules words for a profile that lists no rule, nor for a finding that cites none', () => {
    const lines = render(reportResult())
    expect(lines).toEqual(MAIN)
    expect(lines.join('\n')).not.toContain('rule')
    // A profile that lists none, kept finding or not, has its line as before.
    expect(render(blankResult(), PASS)[2]).toBe('security (fail-on high): 0 kept, 0 unreviewed, 0 discarded')
    expect(render(keeping({ rule: undefined }))[2]).toBe('HIGH  security  src/auth/login.ts:42  CWE-89')
  })

  it('makes the rule id inert as every part of a line is', () => {
    // The id is the configuration's, and the result schema holds it to a rule id's pattern: a hand-built result is made inert all the same.
    const lines = render(keeping({ rule: `a${RLO}b` }))
    expect(lines[2]).toBe('HIGH  security  src/auth/login.ts:42  CWE-89  rule a<U+202E>b')
  })

  it.each<[string, ReviewSource, string]>([
    [
      'diff',
      { kind: 'diff' },
      'diff',
    ],
    [
      'local with no commit yet',
      { kind: 'local', head: null, objectFormat: 'sha1' },
      'local, no commit yet',
    ],
    [
      'local on a commit',
      { kind: 'local', head: HEAD, objectFormat: 'sha1' },
      'local on 7b2e4d0',
    ],
    [
      'staged on a sha256 commit',
      {
        kind: 'staged',
        head: '7b2e4d0'.padEnd(64, 'a'),
        objectFormat: 'sha256',
      },
      'staged on 7b2e4d0',
    ],
    [
      'paths at a commit',
      {
        kind: 'paths',
        commit: HEAD,
        paths: ['src'],
        skips: true,
        objectFormat: 'sha1',
      },
      'paths at 7b2e4d0',
    ],
  ])('names the source %s in the header', (_name, source, named) => {
    expect(render(blankResult({ source }), PASS)[0]).toBe(`quorum 0.6.0 · ${named} · security · 0 files`)
  })

  it('names a source it does not know without repeating it', () => {
    const source = { kind: 'tarball' } as unknown as ReviewSource
    expect(render(blankResult({ source }), PASS)[0]).toBe('quorum 0.6.0 · source unknown · security · 0 files')
  })

  it('ends an interrupted review with its verdict, coloured as an incomplete one', () => {
    const gap = { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 2 of its 3 research parts' } as const
    const stopped = reportResult({
      meta: {
        incomplete: [gap],
      },
    })
    expect(render(stopped, INTERRUPTED).at(-2)).toBe('exit 130, interrupted: the review was stopped before its end; what it read is above')
    expect(render(stopped, INTERRUPTED, true).at(-2)).toBe(`exit 130, ${ESC}[33minterrupted${ESC}[0m: the review was stopped before its end; what it read is above`)
    expect(render(stopped, INTERRUPTED)).toContain('gap: security interrupted, the interrupt stopped 2 of its 3 research parts')
    // the public view says the gap in fixed words
    expect(render(publicView(stopped), INTERRUPTED).join(' ').replaceAll(/ +/g, ' ')).toContain('gap: security interrupted, the review was stopped before its end, so part of the work was never read')
  })

  it.each<[string, Outcome, string]>([
    ['FINDINGS', FINDINGS, 'exit 1, findings: a gating profile kept a finding at or above its fail-on level'],
    ['INCOMPLETE', INCOMPLETE, 'exit 4, incomplete: a gating profile has a gap or an unreviewed finding'],
    ['PASS', PASS, 'exit 0, pass: no gating profile kept a finding to fail on, and none has a gap'],
    ['LIFTED', LIFTED, 'exit 0, pass: incomplete, but --allow-incomplete lifted every gap'],
  ])('ends with the verdict of %s', (_name, outcome, verdict) => {
    expect(render(blankResult(), outcome).at(-2)).toBe(verdict)
  })

  it('writes the time and the tokens, a cost when the usage holds one, and says when none was reported', () => {
    expect(render(blankResult(), PASS).at(-3)).toBe('took 0.0s, no token count reported')
    expect(render(blankResult({ durationMs: 1234 }), PASS).at(-3)).toBe('took 1.2s, no token count reported')
    const costly = reportResult({
      meta: {
        usage: { inputTokens: 48_120, outputTokens: 4190, costUsd: 0.0423 },
      },
    })
    expect(render(costly).at(-3)).toBe('took 41s, 48.1k tokens in and 4.19k out, $0.0423')
  })

  it('writes the review\'s time past a minute in minutes, and its tokens scaled', () => {
    const long = reportResult({
      meta: {
        durationMs: 468_000,
        usage: { inputTokens: 3_208_096, outputTokens: 541_818 },
      },
    })
    expect(render(long).at(-3)).toBe('took 7m48s, 3.20M tokens in and 541k out')
  })

  it.each<[number, string]>([
    [999, '1.0s'],
    [1000, '1.0s'],
    [9949, '9.9s'],
    [9950, '10s'],
    [59_400, '59s'],
    [59_600, '1m00s'],
  ])('writes %i ms as %s', (durationMs, duration) => {
    expect(render(blankResult({ durationMs }), PASS).at(-3)).toBe(`took ${duration}, no token count reported`)
  })

  it('renders the result of a blank diff', () => {
    expect(render(blankResult(), PASS)).toEqual([
      'quorum 0.6.0 · diff · security · 0 files',
      '',
      'security (fail-on high): 0 kept, 0 unreviewed, 0 discarded',
      '  the diff holds no file',
      '  research: 0 part(s), 0 finding(s) listed, 0 to the panel',
      'took 0.0s, no token count reported',
      'exit 0, pass: no gating profile kept a finding to fail on, and none has a gap',
      '',
    ])
  })

  it('keeps every line within 80 columns but for a path, a category or a row of code longer than that', () => {
    const documents = render(reportResult({
      meta: {
        context: { documents: DOCUMENTS },
      },
    }))
    // A fixture the test can fail on: one document's line, written whole, passes 80 columns with its cleaner clause.
    expect([
      ...documentLine(DOCUMENTS[1]),
    ].length).toBeGreaterThan(80)
    expect(documents.filter(line => line.startsWith('context:'))).toHaveLength(3)
    for (const lines of [
      render(reportResult()),
      render(secrets(), INCOMPLETE),
      documents,
    ]) {
      for (const line of lines) expect([...line].length).toBeLessThanOrEqual(80)
    }
  })

  it('reads a flag with no file or no line as the progress lines do', () => {
    const flags: Flag[] = [
      { code: 'ai-addressed-text', line: 3, detail: 'a pattern' },
      { code: 'secret-file', detail: 'a file' },
    ]
    expect(render(blankResult({ flags }), PASS).slice(-5, -3)).toEqual([
      'flag: ai-addressed-text at line 3, a pattern',
      'flag: secret-file, a file',
    ])
  })

  it('names a flag\'s profile', () => {
    const flags: Flag[] = [
      {
        code: 'guideline-edited',
        profile: 'security',
        file: 'REVIEW.md',
        detail: 'the guidelines this review read for the profile from 1f3a9c2, not the change\'s version',
      },
      { code: 'guideline-edited', profile: 'naming', detail: 'the rules this review read' },
    ]
    expect(render(blankResult({ flags }), PASS).slice(-6, -3)).toEqual([
      'flag: guideline-edited at "REVIEW.md" for security, the guidelines this review',
      '  read for the profile from 1f3a9c2, not the change\'s version',
      'flag: guideline-edited for naming, the rules this review read',
    ])
  })

  it('writes each document\'s line after the profiles, from meta.context', () => {
    const documentLines = [
      'context: security guidelines "docs/threat-model.md" at 1f3a9c2, 1830 bytes',
      'context: naming guidelines from a file, sha256 3f2a9c1d0b7e, 4100 bytes; the',
      '  cleaner removed 3 hidden character(s) and 1 comment(s)',
      'context: naming do-not-report text "REVIEW-skip.md" at 1f3a9c2: missing, and',
      '  optional',
    ]
    const result = reportResult({
      meta: {
        context: { documents: DOCUMENTS },
      },
    })
    // The lines are the records' own, in order, after the last profile's coverage and before the files left out, a long one wrapped at spaces as a flag's detail is.
    expect(render(result)).toEqual([
      ...MAIN.slice(0, MAIN.indexOf('left out: 1 file')),
      ...documentLines,
      ...MAIN.slice(MAIN.indexOf('left out: 1 file')),
    ])
    // Joined back, the lines read as each record's line in the log does.
    expect(documentLines.join('\n').replaceAll('\n  ', ' ').split('\n')).toEqual(DOCUMENTS.map(documentLine))
    // A public view keeps them, and a review with no document writes none.
    expect(render(publicView(result))).toContain(documentLines[1])
    expect(render(reportResult()).filter(line => line.startsWith('context:'))).toEqual([])
    // Each line is inert: a path of a hostile name shows its hidden character.
    const hostilePath = reportResult({
      meta: {
        context: {
          documents: [
            contextDocument({
              origin: 'repository',
              path: `docs/${RLO}x.md`,
              commit: '1f3a9c2'.padEnd(40, 'a'),
            }),
          ],
        },
      },
    })
    expect(render(hostilePath)).toContain('context: security guidelines "docs/<U+202E>x.md" at 1f3a9c2, 1830 bytes')
  })

  it('keeps a document\'s long path whole on the line that holds it, and wraps what follows', () => {
    // The path is cut at 100 code points by the line's own rule: its head is far over 80 columns, and stays one line.
    const path = `${'d/'.repeat(60)}x.md`
    const head = `context: security guidelines "${'d/'.repeat(50)}…" at 1f3a9c2,`
    const lines = render(reportResult({
      meta: {
        context: {
          documents: [
            contextDocument({
              origin: 'repository',
              path,
              commit: '1f3a9c2'.padEnd(40, 'a'),
              removed: { characters: 3, comments: 1, entities: 0 },
            }),
          ],
        },
      },
    }))
    const at = lines.indexOf(head)
    expect(at).toBeGreaterThan(0)
    expect([...head].length).toBeGreaterThan(80)
    expect(lines.slice(at, at + 3)).toEqual([
      head,
      '  1830 bytes; the cleaner removed 3 hidden character(s) and 1 comment(s)',
      'left out: 1 file',
    ])
  })

  it('writes a gap with an empty detail, or one of white space, with no comma after its reason', () => {
    const incomplete: IncompleteEntry[] = [
      { profile: 'security', reason: 'binary', detail: '' },
      { profile: 'security', reason: 'secret', detail: ' \t ' },
      { profile: 'team', reason: 'token-cap', detail: 'the token cap stopped it' },
    ]
    expect(render(blankResult({ incomplete }), INCOMPLETE).filter(line => line.startsWith('gap:'))).toEqual([
      'gap: security binary',
      'gap: security secret',
      'gap: team token-cap, the token cap stopped it',
    ])
  })

  it('names a leftOut file with no path and a rule, as the progress lines do', () => {
    const leftOut: LeftOutFile[] = [
      { file: '', reason: 'binary' },
      { file: 'vendor/x.js', reason: 'skipped', rule: 'vendored' },
    ]
    expect(render(blankResult({ leftOut }), PASS).slice(5, 8)).toEqual([
      'left out: 2 files',
      '  <no path> (binary)',
      '  "vendor/x.js" (skipped: vendored)',
    ])
  })
})
