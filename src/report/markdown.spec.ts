import { describe, expect, it } from 'vitest'
import type { Outcome } from '../core/outcome.ts'
import type { ContextReport, Flag, LeftOutFile, PublicView, QuorumResult, Verdict } from '../core/types.ts'
import { expectCodeWritten as expectWritten, HOSTILE, RLO } from '../testing/markdown.ts'
import { blankResult, cast, contextDocument, contextReport, dismissedAt, FINDINGS, foundByScanner, INCOMPLETE, INTERRUPTED, PASS, reportResult, SCANNED_CONTEXT, scannedResult, SCANNER_REPORTS, SERVED_AS_TWO, SQL, TOKEN, TRIVY, UPLOAD } from '../testing/report.ts'
import { LISTED, markdown, SUMMARY_BUDGET, summaryMarkdown } from './markdown.ts'
import { renderReport } from './registry.ts'
import { publicView } from './view.ts'

const MARKER = '<!-- quorum:summary:v1 -->'
const TABLE_HEAD = '| Profile | Fail-on | Kept | Unreviewed | Discarded | Outside the diff | Coverage |'
const TABLE_RULE = '| --- | --- | ---: | ---: | ---: | ---: | --- |'
const TRAILER = 'quorum 0.6.0 · range `1f3a9c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`...`7b2e4d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`'
const MORE = 'listed in the review\'s JSON result'

/** The head of the fixture's staged review, a commit whose id starts `7b2e4d0`. */
const HEAD = '7b2e4d0'.padEnd(40, 'a')

/** The summary of a result as its lines, the last one the empty text after the final line feed. */
function render(result: QuorumResult | PublicView, outcome: Outcome = FINDINGS): string[] {
  return markdown.render(result, { color: false, outcome }).split('\n')
}

const MAIN = [
  MARKER,
  '### quorum review',
  '',
  '**exit 1, findings:** a gating profile kept a finding at or above its fail-on level',
  '',
  TABLE_HEAD,
  TABLE_RULE,
  '| security | high | 1 | 1 | 1 | 0 | 1 of 3 files reviewed, 1 in part, 1 not |',
  '',
  '#### Findings',
  '',
  '- **HIGH** security · `src/auth/login.ts` line 42 · `CWE-89` · kept by 3 of 3 lenses',
  '',
  '  `SQL built from the request\'s id parameter reaches db.query`',
  '',
  '  ```text',
  '        41   const sql = \'SELECT * FROM users WHERE id = \' + id',
  '     >  42 + db.query(sql)',
  '        43   return rows',
  '  ```',
  '',
  '- **UNREVIEWED** security · `src/session.js` line 20 · `CWE-338` · kept by 1 of 3 lenses, 1 vote failed: a network error',
  '',
  '  `Session tokens come from Math.random, which is not a cryptographic generator.`',
  '',
  '  ```text',
  '           -   return crypto.randomBytes(32).toString(\'hex\')',
  '     >  20 +   return Math.random().toString(36).slice(2)',
  '        21   }',
  '  ```',
  '',
  '#### Gaps',
  '',
  '- security, binary: the diff carries no content for a binary file',
  '',
  '#### Files left out',
  '',
  '- `assets/logo.png` (binary)',
  '',
  '#### Flags',
  '',
  '- hidden-characters at `src/session.js` line 20: `U+202E on 1 added line(s)`',
  '',
  '---',
  '',
  TRAILER,
  '',
]

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
      { code: 'secret-file', file: '.env', detail: 'named as a secret, so no model was sent any of it: check that it belongs in the change' },
      { code: 'secret-file', file: 'old/.env', detail: 'deletes a file named as a secret, so no model was sent any of it: the history still holds the file, so rotate what it held' },
    ],
  })
}

/** The check of a summary: the marker first, then only what quorum wrote. */
const expectCodeWritten = (summary: string): void => expectWritten(summary, MARKER)

/** The line of each finding's head, as `<level> <profile> <file>:<line>`, in the order the summary lists them. */
function heads(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const head = /^- \*\*(\w+)\*\* (\S+) · `([^`]+)` line (\d+)/.exec(line)
    return head === null
      ? []
      : [`${head[1]} ${head[2]} ${head[3]}:${head[4]}`]
  })
}

/** The lines of the list under `heading`: those between it and the blank line that ends the list. */
function listUnder(lines: readonly string[], heading: string): string[] {
  const start = lines.indexOf(heading) + 2
  return lines.slice(start, lines.indexOf('', start))
}

describe('markdown', () => {
  it('renders a review for a pull request: the verdict, the profiles, each finding with its evidence, the gaps, what was left out, the flags and the source', () => {
    expect(render(reportResult())).toEqual(MAIN)
  })

  it('writes no served model and nothing of meta.calls, from a result whose provider answered as two models', () => {
    // The summary is made to be posted, so the models only the operator reads stay out of it, as of the public view it is written from.
    const answered = reportResult({
      meta: { calls: SERVED_AS_TWO },
    })
    const lines = render(answered)
    expect(lines).toEqual(MAIN)
    expect(lines.join('\n')).not.toContain('local-model-2026')
    expect(lines.join('\n')).not.toContain('local-model-2027')
    expect(lines.join('\n')).not.toContain('answered as')
    expect(render(publicView(answered))).toEqual(MAIN)
  })

  it('writes a finding\'s rule in a code span in the summary, after its category, and none for a finding that cites none', () => {
    const result = reportResult({
      kept: [
        { ...SQL, rule: 'tests-for-new-code' },
      ],
      unreviewed: [
        { ...TOKEN, rule: 'no-any' },
      ],
    })
    const lines = render(result)
    expect(lines).toContain('- **HIGH** security · `src/auth/login.ts` line 42 · `CWE-89` · rule `tests-for-new-code` · kept by 3 of 3 lenses')
    expect(lines).toContain('- **UNREVIEWED** security · `src/session.js` line 20 · `CWE-338` · rule `no-any` · kept by 1 of 3 lenses, 1 vote failed: a network error')
    expectCodeWritten(lines.join('\n'))
    // The rest of the summary is the one a review with no rule reads: the table holds no rule words, and neither does a finding with none.
    expect(lines.filter(line => !line.startsWith('- **'))).toEqual(MAIN.filter(line => !line.startsWith('- **')))
    expect(render(reportResult())).toEqual(MAIN)
    expect(render(reportResult()).join('\n')).not.toContain('rule `')
    // The public view the summary is written from keeps the id, and a result given as that view reads the same.
    expect(render(publicView(result))).toEqual(lines)
  })

  it('ends the coverage cell of a profile that asked nothing with the rules it was sent and that its research asks nothing, and no other profile\'s', () => {
    const { security } = reportResult().meta.profiles
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
    expect(render(asked({ listed: 0, sent: 0 }), PASS).slice(5, 8)).toEqual([
      TABLE_HEAD,
      TABLE_RULE,
      '| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed; rules 0 of 0 sent, so its research asks nothing |',
    ])
    expect(render(asked({ listed: 5, sent: 0 }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed; rules 0 of 5 sent, so its research asks nothing |')
    // The view the summary is written from keeps the flag, so a result given as that view reads the same, and the cell holds no `|` and nothing a model wrote.
    expect(render(publicView(asked({ listed: 5, sent: 0 })), PASS)).toEqual(render(asked({ listed: 5, sent: 0 }), PASS))
    expectCodeWritten(render(asked({ listed: 0, sent: 0 }), PASS).join('\n'))
    // A profile that lists no rule and requires none has the row it always had, and so has one that was sent some of its rules.
    expect(render(reportResult())).toEqual(MAIN)
    expect(render(blankResult({
      profiles: {
        security: {
          ...security,
          rules: { listed: 5, sent: 3 },
          coverage: [],
        },
      },
    }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | the diff holds no file |')
  })

  it('adds the findings away from the changed lines to a profile\'s coverage cell, after the coverage words and before what a profile that asked nothing adds', () => {
    const { security } = reportResult().meta.profiles
    const watching = (changes: Partial<typeof security>): QuorumResult => blankResult({
      profiles: {
        security: {
          ...security,
          ...changes,
          coverage: [
            { file: 'a.js', status: 'reviewed' },
          ],
        },
      },
    })
    expect(render(watching({ awayFromChange: 1 }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed; 1 finding(s) away from the changed lines |')
    expect(render(watching({ awayFromChange: 12 }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed; 12 finding(s) away from the changed lines |')
    expect(render(watching({
      awayFromChange: 2,
      rules: { listed: 1, sent: 0 },
      asksNothing: true,
    }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed; 2 finding(s) away from the changed lines; rules 0 of 1 sent, so its research asks nothing |')
    // The column of the findings outside the diff keeps its own count.
    expect(render(watching({ awayFromChange: 3, invalidFindings: 2 }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 2 | 1 of 1 file reviewed; 3 finding(s) away from the changed lines |')
    // The view the summary is written from keeps the count, so a result given as that view reads the same, and the cell holds no `|` and nothing a model wrote.
    expect(render(publicView(watching({ awayFromChange: 1 })), PASS)).toEqual(render(watching({ awayFromChange: 1 }), PASS))
    expectCodeWritten(render(watching({ awayFromChange: 1 }), PASS).join('\n'))
    // A count of 0, and a profile with none, leave the cell as it always was.
    expect(render(watching({ awayFromChange: 0 }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed |')
    expect(render(watching({}), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed |')
    expect(render(reportResult())).toEqual(MAIN)
  })

  it('names a scanner\'s finding\'s scanner and file-level in its head, after the rule, and leaves a model\'s head as it was', () => {
    const result = reportResult({
      kept: [
        TRIVY,
        foundByScanner({
          ...SQL,
          file: 'src/a.js',
          line: 2,
          rule: 'tests-for-new-code',
        }, { scanner: 'Semgrep OSS', ruleId: 'r1' }),
      ],
      meta: { context: SCANNED_CONTEXT },
    })
    const lines = render(result)
    expect(heads(lines)).toEqual([
      'HIGH security package-lock.json:300',
      'HIGH security src/a.js:2',
      'UNREVIEWED security src/session.js:20',
    ])
    expect(lines).toContain('- **HIGH** security · `package-lock.json` line 300 · `CVE-0000-0001` · `Trivy` · file-level · kept by 3 of 3 lenses')
    expect(lines).toContain('- **HIGH** security · `src/a.js` line 2 · `CWE-89` · rule `tests-for-new-code` · `Semgrep OSS` · kept by 3 of 3 lenses')
    // The unreviewed model finding keeps the head it had, and a review with no report writes the summary it always wrote.
    expect(lines).toContain('- **UNREVIEWED** security · `src/session.js` line 20 · `CWE-338` · kept by 1 of 3 lenses, 1 vote failed: a network error')
    expect(render(reportResult())).toEqual(MAIN)
    expect(render(publicView(result))).toEqual(lines)
    expectCodeWritten(lines.join('\n'))
  })

  it('says a scanner\'s finding is marked suppressed in its head, after file-level, and says it of no other finding', () => {
    const suppressed = (changes: Partial<Verdict>, found: Parameters<typeof foundByScanner>[1] = {}): Verdict => foundByScanner({
      ...SQL,
      ...changes,
    }, { scanner: 'Semgrep OSS', suppressed: true, ...found })
    const result = reportResult({
      kept: [
        suppressed({ file: 'src/a.js', line: 2 }),
        suppressed({ file: 'src/b.js', line: 3, rule: 'no-any' }, { fileLevel: true }),
        foundByScanner({ ...SQL, file: 'src/c.js', line: 4 }, { scanner: 'Semgrep OSS' }),
        { ...SQL, file: 'src/d.js', line: 5 },
      ],
      meta: { context: SCANNED_CONTEXT },
    })
    const lines = render(result)
    expect(lines).toContain('- **HIGH** security · `src/a.js` line 2 · `CWE-89` · `Semgrep OSS` · marked suppressed · kept by 3 of 3 lenses')
    expect(lines).toContain('- **HIGH** security · `src/b.js` line 3 · `CWE-89` · rule `no-any` · `Semgrep OSS` · file-level · marked suppressed · kept by 3 of 3 lenses')
    // A scanner's finding its report did not mark, and a model's, say neither.
    expect(lines).toContain('- **HIGH** security · `src/c.js` line 4 · `CWE-89` · `Semgrep OSS` · kept by 3 of 3 lenses')
    expect(lines).toContain('- **HIGH** security · `src/d.js` line 5 · `CWE-89` · kept by 3 of 3 lenses')
    expect(lines.filter(line => line.includes('marked suppressed'))).toHaveLength(2)
    expectCodeWritten(lines.join('\n'))
    expect(render(publicView(result))).toEqual(lines)
    // A review that read no report writes what it always wrote.
    expect(render(reportResult()).join('\n')).not.toContain('suppressed')
    expect(render(reportResult())).toEqual(MAIN)
  })

  it('puts a scanner\'s name in a code span, whatever it holds', () => {
    const lines = render(reportResult({
      kept: [
        foundByScanner(SQL, { scanner: '@octocat `x` #1 :smile: |' }),
      ],
      meta: { context: SCANNED_CONTEXT },
    }))
    expect(lines).toContain('- **HIGH** security · `src/auth/login.ts` line 42 · `CWE-89` · ``@octocat `x` #1 :smile: |`` · kept by 3 of 3 lenses')
    expectCodeWritten(lines.join('\n'))
  })

  it('lists the dismissed scanner issues, first 20 then a count, and drops them first under the budget', () => {
    const heading = '#### Dismissed scanner issues'
    const issues = (count: number): Verdict[] => Array.from({ length: count }, (_, index) => dismissedAt(`src/f${index}.js`, index + 1, {}, 'r1'))
    const result = reportResult({
      discarded: [
        UPLOAD,
        ...issues(21),
      ],
      meta: { context: SCANNED_CONTEXT },
    })
    const lines = render(result)
    expect(listUnder(lines, heading)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `- \`src/f${index}.js\` line ${index + 1} · \`r1\` · \`Semgrep OSS\` · kept by 0 of 3 lenses`),
      `- and 1 more, ${MORE}`,
    ])
    // They come after the findings and before the gaps; the finder's discarded finding is counted, in the table, and never listed.
    expect(lines.indexOf('#### Findings')).toBeLessThan(lines.indexOf(heading))
    expect(lines.indexOf(heading)).toBeLessThan(lines.indexOf('#### Gaps'))
    expect(lines.join('\n')).not.toContain(UPLOAD.file)
    expect(lines).toContain('| security | high | 1 | 1 | 22 | 0 | 1 of 3 files reviewed, 1 in part, 1 not |')
    expectCodeWritten(lines.join('\n'))
    expect(render(publicView(result))).toEqual(lines)

    // Every evidence block stays while the dismissed issues can still give room: one code unit short, they lose their last entry alone.
    const view = publicView(result)
    const full = summaryMarkdown(view, FINDINGS)
    const fences = (summary: string): number => summary.split('\n').filter(line => line === '  ```text').length
    expect(fences(full)).toBe(2)
    const short = summaryMarkdown(view, FINDINGS, full.length - 1)
    expect(listUnder(short.split('\n'), heading).at(-1)).toBe(`- and 2 more, ${MORE}`)
    expect(fences(short)).toBe(2)
    expect(short).not.toContain('is left out, to stay within')
    // A budget that fits all but the dismissed issues keeps every evidence block and counts all 21; one less costs the last finding its evidence.
    const base = summaryMarkdown(publicView(reportResult({
      discarded: Array.from<Verdict>({ length: 22 }).fill(UPLOAD),
      meta: { context: SCANNED_CONTEXT },
    })), FINDINGS)
    const fits = base.length + 2 + [heading, '', `- and 21 more, ${MORE}`].join('\n').length
    const dismissed = summaryMarkdown(view, FINDINGS, fits)
    expect(listUnder(dismissed.split('\n'), heading)).toEqual([`- and 21 more, ${MORE}`])
    expect(fences(dismissed)).toBe(2)
    expect(dismissed).not.toContain('is left out, to stay within')
    const tight = summaryMarkdown(view, FINDINGS, fits - 1)
    expect(fences(tight)).toBe(1)
    expect(tight).toContain('The evidence of 1 finding is left out')
    expect(tight.length).toBeLessThanOrEqual(fits - 1)
  })

  it('lists no dismissed section for a review whose panel dismissed only the finder\'s findings', () => {
    const lines = render(reportResult({
      discarded: [UPLOAD, UPLOAD],
    }))
    expect(lines.join('\n')).not.toContain('Dismissed scanner issues')
    expect(lines.join('\n')).not.toContain('Scanner and coverage reports')
  })

  it('lists the reports read before the documents, each scanner in a code span', () => {
    const unreadable: ContextReport = {
      format: 'sonarqube',
      status: 'unreadable',
      problems: ['missing'],
    }
    const hostile = contextReport({
      scanner: '@octocat `x` #1 |',
      issues: {
        listed: 1,
        used: 1,
        fileLevel: 0,
        held: 0,
        unmapped: 0,
        notInChange: 0,
        leftOut: 0,
        unchanged: 0,
        capped: 0,
        skipped: 0,
        unreadable: 0,
      },
    })
    const result = reportResult({
      meta: {
        context: {
          documents: [
            contextDocument(),
          ],
          reports: [...SCANNER_REPORTS, unreadable, hostile],
        },
      },
    })
    const lines = render(result)
    expect(lines.slice(lines.indexOf('#### Flags'))).toEqual([
      '#### Flags',
      '',
      '- hidden-characters at `src/session.js` line 20: `U+202E on 1 added line(s)`',
      '',
      '#### Scanner and coverage reports',
      '',
      '- 1 sarif `Trivy` for security: 1 of 14 issues used (1 file-level); 13 not in the change',
      '- 2 sarif `Semgrep OSS` for security: 1 of 3 issues used; 2 unmapped; read in part',
      '- 3 sonarqube: could not be read',
      '- 4 sarif ``@octocat `x` #1 |`` for security: 1 of 1 issues used',
      '',
      '#### Documents read',
      '',
      '- security guidelines of the profile, 1830 bytes',
      '',
      '---',
      '',
      TRAILER,
      '',
    ])
    expectCodeWritten(lines.join('\n'))
    expect(render(publicView(result))).toEqual(lines)
  })

  it('drops the reports after the documents and before the flags when the budget is short', () => {
    // No finding holds evidence here, which the budget drops before the documents.
    const view = publicView(reportResult({
      kept: [],
      unreviewed: [],
      meta: {
        context: {
          documents: [
            contextDocument(),
            contextDocument({ kind: 'do-not-report' }),
            contextDocument({ profile: 'naming' }),
          ],
          reports: SCANNER_REPORTS,
        },
      },
    }))
    const full = summaryMarkdown(view, FINDINGS)
    const shown = (summary: string, heading: string): number => listUnder(summary.split('\n'), heading).filter(line => !line.startsWith('- and ')).length
    const states = new Set<string>()
    for (let budget = full.length; budget >= 0; budget -= 1) {
      const summary = summaryMarkdown(view, FINDINGS, budget)
      const documents = shown(summary, '#### Documents read')
      const reports = shown(summary, '#### Scanner and coverage reports')
      const flags = shown(summary, '#### Flags')
      // A report is cut only once every document is, and a flag only once every report is.
      if (reports < 2) expect(documents).toBe(0)
      if (flags < 1) expect(reports).toBe(0)
      states.add(`${documents} ${reports} ${flags}`)
    }
    expect(states).toContain('3 2 1')
    expect(states).toContain('0 2 1')
    expect(states).toContain('0 1 1')
    expect(states).toContain('0 0 1')
    expect(states).toContain('0 0 0')
    // With no room at all the section keeps its heading and its count.
    expect(listUnder(summaryMarkdown(view, FINDINGS, 0).split('\n'), '#### Scanner and coverage reports')).toEqual([`- and 2 more, ${MORE}`])
  })

  it('writes a scanned review whole: the finding, the dismissed issue and the reports', () => {
    const lines = render(scannedResult())
    expect(lines.slice(lines.indexOf('#### Findings'))).toEqual([
      '#### Findings',
      '',
      '- **HIGH** security · `package-lock.json` line 300 · `CVE-0000-0001` · `Trivy` · file-level · kept by 3 of 3 lenses',
      '',
      '  `The locked version of a library is affected by CVE-0000-0001.`',
      '',
      '  ```text',
      '        299   a',
      '     >  300 + b',
      '        301   c',
      '  ```',
      '',
      '#### Dismissed scanner issues',
      '',
      '- `src/db.js` line 12 · `javascript.lang.security.audit.sqli.node-postgres-sqli` · `Semgrep OSS` · kept by 0 of 3 lenses',
      '',
      '#### Gaps',
      '',
      '- security, binary: the diff carries no content for a binary file',
      '',
      '#### Files left out',
      '',
      '- `assets/logo.png` (binary)',
      '',
      '#### Flags',
      '',
      '- hidden-characters at `src/session.js` line 20: `U+202E on 1 added line(s)`',
      '',
      '#### Scanner and coverage reports',
      '',
      '- 1 sarif `Trivy` for security: 1 of 14 issues used (1 file-level); 13 not in the change',
      '- 2 sarif `Semgrep OSS` for security: 1 of 3 issues used; 2 unmapped; read in part',
      '',
      '---',
      '',
      TRAILER,
      '',
    ])
  })

  it('writes the verdict of an interrupted review', () => {
    const lines = render(blankResult({
      incomplete: [
        { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 2 of its 3 research parts' },
      ],
    }), INTERRUPTED)
    expect(lines.slice(0, 4)).toEqual([
      MARKER,
      '### quorum review',
      '',
      '**exit 130, interrupted:** the review was stopped before its end; what it read is above',
    ])
    expect(listUnder(lines, '#### Gaps')).toEqual(['- security, interrupted: the review was stopped before its end, so part of the work was never read'])
  })

  it('renders the review of a blank diff', () => {
    expect(render(blankResult(), PASS)).toEqual([
      MARKER,
      '### quorum review',
      '',
      '**exit 0, pass:** no gating profile kept a finding to fail on, and none has a gap',
      '',
      TABLE_HEAD,
      TABLE_RULE,
      '| security | high | 0 | 0 | 0 | 0 | the diff holds no file |',
      '',
      '---',
      '',
      'quorum 0.6.0 · diff',
      '',
    ])
  })

  it('renders the files held as secrets, their secret gap and their secret-file flags', () => {
    expect(render(secrets(), INCOMPLETE)).toEqual([
      MARKER,
      '### quorum review',
      '',
      '**exit 4, incomplete:** a gating profile has a gap or an unreviewed finding',
      '',
      TABLE_HEAD,
      TABLE_RULE,
      '| security | high | 0 | 0 | 0 | 0 | 1 of 3 files reviewed, 2 not |',
      '',
      '#### Gaps',
      '',
      '- security, secret: a file held back as a secret was sent to no model',
      '',
      '#### Files left out',
      '',
      '- `.env` (secret: name)',
      '- `old/.env` (deleted-secret: name)',
      '',
      '#### Flags',
      '',
      '- secret-file at `.env`: `named as a secret, so no model was sent any of it: check that it belongs in the change`',
      '- secret-file at `old/.env`: `deletes a file named as a secret, so no model was sent any of it: the history still holds the file, so rotate what it held`',
      '',
      '---',
      '',
      `quorum 0.6.0 · staged on \`${HEAD}\``,
      '',
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
      { code: 'guideline-edited', profile: 'naming', detail: 'the do-not-report text this review read' },
    ]
    expect(render(blankResult({ flags }), PASS).filter(line => line.startsWith('- guideline-edited'))).toEqual([
      '- guideline-edited at `REVIEW.md` (security): `the guidelines this review read for the profile from 1f3a9c2, not the change\'s version`',
      '- guideline-edited (naming): `the do-not-report text this review read`',
    ])
  })

  it('lists the documents read, each path, commit and hash in a code span', () => {
    const commit = '1f3a9c2'.padEnd(40, 'a')
    const documents = [
      contextDocument(),
      contextDocument({
        origin: 'repository',
        path: 'docs/threat-model.md',
        commit,
        sha256: 'a'.repeat(64),
        bytes: 2000,
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
        commit,
        status: 'missing',
        bytes: 0,
      }),
    ]
    const lines = render(reportResult({
      meta: {
        context: { documents, reports: [] },
      },
    }))
    // The section follows the flags, and each record is an item in the words of its line, its path, commit and hash in spans.
    expect(lines.slice(lines.indexOf('#### Flags'))).toEqual([
      '#### Flags',
      '',
      '- hidden-characters at `src/session.js` line 20: `U+202E on 1 added line(s)`',
      '',
      '#### Documents read',
      '',
      '- security guidelines of the profile, 1830 bytes',
      '- security guidelines `docs/threat-model.md` at `1f3a9c2`, 2000 bytes',
      '- naming guidelines from a file, sha256 `3f2a9c1d0b7e`, 4100 bytes; the cleaner removed 3 hidden character(s) and 1 comment(s)',
      '- naming do-not-report text `REVIEW-skip.md` at `1f3a9c2`: missing, and optional',
      '',
      '---',
      '',
      TRAILER,
      '',
    ])
    // A review with no document has no section, and a path that holds Markdown stays in its span.
    expect(render(reportResult())).toEqual(MAIN)
    const hostile = render(reportResult({
      meta: {
        context: {
          documents: [
            contextDocument({
              origin: 'repository',
              path: '`@octocat` #1 |![x](https://e.example/x.png)',
              commit,
            }),
          ],
          reports: [],
        },
      },
    }))
    expect(hostile).toContain('- security guidelines `` `@octocat` #1 |![x](https://e.example/x.png) `` at `1f3a9c2`, 1830 bytes')
    expectCodeWritten(hostile.join('\n'))
  })

  it('lists twenty documents then how many more, and cuts them before the flags when the budget is short', () => {
    const documents = Array.from({ length: 25 }, (_, index) => contextDocument({
      origin: 'repository',
      path: `docs/${index}.md`,
      commit: '1f3a9c2'.padEnd(40, 'a'),
    }))
    const result = blankResult({
      context: { documents, reports: [] },
      flags: [
        {
          code: 'hidden-characters',
          file: 'a.js',
          line: 1,
          detail: 'U+202E on 1 added line(s)',
        },
      ],
    })
    const view = publicView(result)
    const full = summaryMarkdown(view, PASS)
    expect(listUnder(full.split('\n'), '#### Documents read')).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `- security guidelines \`docs/${index}.md\` at \`1f3a9c2\`, 1830 bytes`),
      `- and 5 more, ${MORE}`,
    ])
    // One code unit short of the whole, the documents lose their last entry, and the flag stays.
    const short = summaryMarkdown(view, PASS, full.length - 1).split('\n')
    expect(listUnder(short, '#### Documents read').at(-1)).toBe(`- and 6 more, ${MORE}`)
    expect(listUnder(short, '#### Flags')).toEqual(['- hidden-characters at `a.js` line 1: `U+202E on 1 added line(s)`'])
    // With no room at all, each section keeps its heading and a count of what it cut.
    const none = summaryMarkdown(view, PASS, 0).split('\n')
    expect(listUnder(none, '#### Documents read')).toEqual([`- and 25 more, ${MORE}`])
    expect(listUnder(none, '#### Flags')).toEqual([`- and 1 more, ${MORE}`])
  })

  it('lists the findings that fail their profile first, then high, medium, unreviewed and low, each by file and line', () => {
    const base = reportResult().meta.profiles.security
    const finding = (profile: string, file: string, line: number, confidence: Verdict['confidence']): Verdict => ({
      ...SQL,
      profile,
      file,
      line,
      confidence,
    })
    const result = reportResult({
      kept: [
        finding('security', 'd.js', 1, 'low'),
        finding('team', 'b.js', 1, 'medium'),
        finding('team', 'a.js', 9, 'high'),
        finding('security', 'z.js', 1, 'high'),
        finding('team', 'a.js', 2, 'high'),
        finding('security', 'y.js', 1, 'medium'),
      ],
      unreviewed: [
        {
          ...TOKEN,
          profile: 'security',
          file: 'c.js',
          line: 1,
        },
      ],
      meta: {
        profiles: {
          security: { ...base, failOn: 'medium' },
          team: { ...base, failOn: 'none', gating: false },
        },
      },
    })
    expect(heads(render(result))).toEqual([
      'MEDIUM security y.js:1',
      'HIGH security z.js:1',
      'HIGH team a.js:2',
      'HIGH team a.js:9',
      'MEDIUM team b.js:1',
      'UNREVIEWED security c.js:1',
      'LOW security d.js:1',
    ])
  })

  it('puts every text a model or the diff wrote in a code span or a fenced block, and gives every line the command rules', () => {
    const leftOut: LeftOutFile[] = [
      { file: 'a | `b`', reason: 'binary' },
    ]
    const flags: Flag[] = [
      {
        code: 'hidden-characters',
        file: '::x',
        line: 3,
        detail: '[link](https://e.example)',
      },
    ]
    const summary = markdown.render(reportResult({
      kept: [HOSTILE],
      unreviewed: [],
      meta: { leftOut, flags },
    }), { color: false, outcome: FINDINGS })
    expectCodeWritten(summary)
    expect(summary.split('\n')).toContain('- `` a | `b` `` (binary)')
    expect(summary).toContain('`[link](https://e.example)`')
    expect(summary).not.toContain('##[')
    expect(summary).not.toContain(RLO)
    expect(summary.split('\n').filter(line => /^\s*::/.test(line))).toEqual([])
  })

  it('renders a claim that quotes code in backticks as one code span', () => {
    const claim = 'Passes `req.query.id` to `db.query`'
    const lines = render(reportResult({
      kept: [
        { ...SQL, summary: claim },
      ],
      unreviewed: [],
    }))
    expect(lines).toContain('  `` Passes `req.query.id` to `db.query` ``')
    expectCodeWritten(lines.join('\n'))
  })

  it('writes the empty name as (no path), and lists twenty files left out and twenty flags, then how many more', () => {
    const leftOut: LeftOutFile[] = Array.from({ length: 25 }, (_, index) => ({
      file: index === 0
        ? ''
        : `f${index}.png`,
      reason: 'binary',
    }))
    const flags: Flag[] = Array.from({ length: 25 }, (_, index) => ({
      code: 'hidden-characters',
      file: `f${index}.js`,
      line: index + 1,
      detail: 'U+202E on 1 added line(s)',
    }))
    const lines = render(blankResult({ leftOut, flags }), PASS)
    expect(LISTED).toBe(20)
    expect(listUnder(lines, '#### Files left out')).toEqual([
      '- (no path) (binary)',
      ...Array.from({ length: 19 }, (_, index) => `- \`f${index + 1}.png\` (binary)`),
      `- and 5 more, ${MORE}`,
    ])
    expect(listUnder(lines, '#### Flags')).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `- hidden-characters at \`f${index}.js\` line ${index + 1}: \`U+202E on 1 added line(s)\``),
      `- and 5 more, ${MORE}`,
    ])
  })

  it('drops the evidence first, from the last finding up, and says how many', () => {
    const view = publicView(reportResult())
    const full = summaryMarkdown(view, FINDINGS)
    const lines = summaryMarkdown(view, FINDINGS, full.length - 1).split('\n')
    const fences = lines.flatMap((line, index) => line === '  ```text'
      ? [index]
      : [])
    expect(fences).toHaveLength(1)
    expect(fences[0]).toBeGreaterThan(lines.findIndex(line => line.startsWith('- **HIGH**')))
    expect(fences[0]).toBeLessThan(lines.findIndex(line => line.startsWith('- **UNREVIEWED**')))
    expect(lines.filter(line => line.startsWith('- **'))).toHaveLength(2)
    expect(lines.at(-5)).toBe('The evidence of 1 finding is left out, to stay within GitHub\'s limit: the review\'s JSON result holds it.')
    expect(lines.at(-3)).toBe('---')
    expect(lines.join('\n').length).toBeLessThanOrEqual(full.length - 1)
  })

  it('keeps the head, the verdict, the headings, the count lines and the trailer whatever the budget', () => {
    expect(summaryMarkdown(publicView(reportResult()), FINDINGS, 0).split('\n')).toEqual([
      MARKER,
      '### quorum review',
      '',
      '**exit 1, findings:** a gating profile kept a finding at or above its fail-on level',
      '',
      TABLE_HEAD,
      TABLE_RULE,
      '',
      `- and 1 more, ${MORE}`,
      '',
      '#### Findings',
      '',
      `- and 2 more findings (1 high, 1 unreviewed), ${MORE}`,
      '',
      '#### Gaps',
      '',
      `- and 1 more, ${MORE}`,
      '',
      '#### Files left out',
      '',
      `- and 1 more, ${MORE}`,
      '',
      '#### Flags',
      '',
      `- and 1 more, ${MORE}`,
      '',
      '---',
      '',
      TRAILER,
    ])
  })

  it('keeps 100 findings with full evidence, 5000 files left out and 5000 flags within 60 000 characters, the evidence going first and the findings that fail their profile last, each cut counted', () => {
    const base = reportResult().meta.profiles.security
    const evidence = Array.from({ length: 5 }, (_, row) => `+${String(row).repeat(389)}`).join('\n')
    const finding = (profile: string, index: number, confidence: Verdict['confidence']): Verdict => ({
      ...SQL,
      profile,
      file: `src/${profile}/file-${index}.ts`,
      line: index + 1,
      summary: `Claim ${index}: `.padEnd(500, 'w'),
      evidence,
      evidenceRow: 2,
      confidence,
    })
    const result = reportResult({
      kept: [
        ...Array.from({ length: 50 }, (_, index) => finding('team', index, 'medium')),
        ...Array.from({ length: 50 }, (_, index) => finding('security', index, 'high')),
      ],
      unreviewed: [],
      meta: {
        profiles: {
          security: base,
          team: { ...base, failOn: 'none', gating: false },
        },
        leftOut: Array.from({ length: 5000 }, (_, index) => ({ file: `big/${index}.bin`, reason: 'binary' })),
        flags: Array.from({ length: 5000 }, (_, index) => ({
          code: 'hidden-characters',
          file: `big/${index}.js`,
          line: 1,
          detail: 'U+202E on 1 added line(s)',
        })),
      },
    })
    const summary = markdown.render(result, { color: false, outcome: FINDINGS })
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_BUDGET)
    expect(SUMMARY_BUDGET).toBe(60_000)
    const lines = summary.split('\n')
    const listed = heads(lines)
    const profiles = listed.map(head => head.split(' ')[1])
    expect(profiles).toEqual([...profiles].sort())
    const cut = /^- and (\d+) more findings? \((.*)\), listed in the review's JSON result$/.exec(lines.find(line => line.startsWith('- and ') && line.includes('more finding')) ?? '')
    expect(cut).not.toBeNull()
    expect(listed.length + Number(cut![1])).toBe(100)
    expect(profiles.filter(profile => profile === 'security')).toHaveLength(50)
    if (/\bhigh\b/.test(cut![2])) expect(profiles).not.toContain('team')
    expect(lines.filter(line => line === `- and 5000 more, ${MORE}`)).toHaveLength(2)
    expect(lines.filter(line => line.startsWith('The evidence of '))).toEqual([`The evidence of ${listed.length} findings is left out, to stay within GitHub's limit: the review's JSON result holds it.`])
    expect(lines).not.toContain('  ```text')
    expectCodeWritten(summary)
  })

  it('renders the public view of a full result: no reasoning, and the discarded findings counted only', () => {
    const result = reportResult({
      kept: [
        {
          ...SQL,
          votes: [
            {
              ...cast(true),
              vote: { keep: true, reasoning: 'REASONING-CANARY' },
            },
          ],
        },
      ],
    })
    const rendered = renderReport(result, { format: 'markdown', outcome: FINDINGS })
    expect(rendered).toBe(`${summaryMarkdown(publicView(result), FINDINGS)}\n`)
    expect(rendered).toBe(markdown.render(publicView(result), { color: false, outcome: FINDINGS }))
    expect(rendered).not.toContain('REASONING-CANARY')
    expect(rendered).not.toContain(UPLOAD.file)
    expect(rendered.split('\n').find(line => line.startsWith('| security |'))).toBe('| security | high | 1 | 1 | 1 | 0 | 1 of 3 files reviewed, 1 in part, 1 not |')
  })
})
